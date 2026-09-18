// Copyright 2026 by Moshix
/**
 * Fujitsu MB88xx 4-bit MCU core -- the engine inside the Namco 51XX (MB8843)
 * and 54XX (MB8844) custom chips of the Galaga CPU board.
 *
 * This is a line-by-line port of MAME's src/devices/cpu/mb88xx/mb88xx.cpp
 * (copy in reference/mame/mb88xx.cpp). Nothing here is "improved" over MAME:
 * the oracle's job is to behave like the reference emulator, so where MAME
 * guesses (TIMER_PRESCALE, SERIAL_PRESCALE, the interrupt vectors) we inherit
 * the same guess, and where MAME's u8 arithmetic has a visible side effect
 * (e.g. `daa` losing the carry of a sum >= 16) we reproduce it.
 *
 * Machine model, as MAME sees it:
 *  - Program counter = 6-bit PC + page register PA; linear address
 *    (PA << 6) + PC, masked to the program width (10 bits on MB8843/44).
 *  - A, X, Y are 4-bit; data RAM is 2^dataWidth nibbles (64 on MB8843/44)
 *    addressed by (X << 4) + Y, so X = 4..15 mirrors X = 0..3.
 *  - Flags: ST (the "status" bit every conditional branch tests -- branches
 *    are taken when ST = 1), ZF, CF, VF (timer overflow), SF (serial full),
 *    IF (level of the /IRQ pin, logical sense).
 *  - A 4-deep circular stack of 16-bit words; interrupts stash CF/ZF/ST in
 *    bits 15/14/13 of the pushed word so `rti` can restore them.
 *  - One machine cycle = 6 input clocks (execute_clocks_to_cycles). Every
 *    instruction costs 1 cycle, 2 with an operand byte; taking an
 *    interrupt costs 3 more (burn_cycles(3)).
 *
 * Deliberate simplification (documented, unobservable for 51XX/54XX):
 *  MAME drives the serial shift register from an emu_timer firing at
 *  clock()/SERIAL_PRESCALE = once per machine cycle. MAME timers only fire
 *  between scheduler timeslices, so the exact interleave with instructions
 *  is scheduler dependent and cannot be reproduced; here the timer ticks once
 *  per burned machine cycle, before the interrupt check. The 51XX program
 *  enables serial mode (en $64) but never reads SB or SF (no tsa/sts/tsts),
 *  and the 54XX never enables it, so neither program can see the difference.
 */

/** Serial shift clock divider, in input clocks per bit. @see mb88xx.cpp SERIAL_PRESCALE ("guess") */
export const SERIAL_PRESCALE = 6;
/** Internal timer prescaler, in machine cycles. @see mb88xx.cpp TIMER_PRESCALE ("guess") */
export const TIMER_PRESCALE = 32;
/** After this many unserviced serial ticks MAME stops the serial timer. */
export const SERIAL_DISABLE_THRESH = 1000;

/** Pending-interrupt cause bits; they line up with the PIO enable bits. */
export const INT_CAUSE_SERIAL = 0x01;
export const INT_CAUSE_TIMER = 0x02;
export const INT_CAUSE_EXTERNAL = 0x04;

/**
 * Address widths per part, from the device constructors in mb88xx.cpp
 * (mb88_cpu_device(..., program_width, data_width)).
 * @type {Record<string, {program: number, data: number}>}
 */
export const VARIANTS = {
  mb88201: { program: 9, data: 4 },
  mb88202: { program: 10, data: 5 },
  mb8841: { program: 11, data: 7 },
  mb8842: { program: 11, data: 7 },
  mb8843: { program: 10, data: 6 },
  mb8844: { program: 10, data: 6 },
};

/**
 * @typedef {object} Mb88Options
 * @property {Uint8Array} rom                     program image
 * @property {keyof VARIANTS} [variant]           default 'mb8843'
 * @property {() => number} [readK]               K3-K0 input port (default 0)
 * @property {(port: number) => number} [readR]   R port n (0..3) input, nibble (default 0)
 * @property {(port: number, value: number) => void} [writeR]  R port n output
 * @property {(value: number, mask: number) => void} [writeO]
 *   O port output through the PLA. `value` is the whole 8-bit O latch and
 *   `mask` says which nibble changed (0x0F or 0xF0) in the default 8-bit PLA
 *   mode -- MAME's write_o(0, m_o_output, mask); the 54XX uses the mask to
 *   tell its two sound channels apart.
 * @property {(value: number) => void} [writeP]  P port output, nibble
 * @property {() => number} [readSI]              serial input bit (default 0)
 * @property {Uint8Array} [plaData]               32-entry PLA table (4-bit PLA mode only)
 * @property {4|8} [plaBits]                      PLA mode, default 8 (MAME default)
 */

const noop = () => {};
const zero = () => 0;

/**
 * One MB88xx CPU.
 *
 * Time is counted in machine cycles. `run(n)` behaves like MAME's
 * execute_run with an icount of n: it executes whole instructions while the
 * budget is positive and carries the (negative) overrun into the next call,
 * so long runs never drift.
 */
export class MB88 {
  /** @param {Mb88Options} options */
  constructor(options) {
    const variant = VARIANTS[options.variant ?? 'mb8843'];
    if (!variant) throw new Error(`unknown MB88 variant ${options.variant}`);
    /** Program image; reads are masked to the program width. */
    this.rom = options.rom;
    this.programMask = (1 << variant.program) - 1;
    this.dataMask = (1 << variant.data) - 1;
    /** Data RAM, one nibble per byte. MAME does not clear it on reset. */
    this.ram = new Uint8Array(1 << variant.data);

    this.readK = options.readK ?? zero;
    this.readR = options.readR ?? zero;
    this.writeR = options.writeR ?? noop;
    this.writeO = options.writeO ?? noop;
    this.writeP = options.writeP ?? noop;
    this.readSI = options.readSI ?? zero;
    this.plaData = options.plaData ?? null;
    this.plaBits = options.plaBits ?? 8;

    /** Stack: 4 x 16-bit words (10-11 address bits + saved flags on top). */
    this.sp = new Uint16Array(4);

    /**
     * Machine cycles elapsed on this CPU's local clock, including time spent
     * held in reset. Useful as a timestamp for port writes.
     */
    this.cycles = 0;
    /** run() budget: positive = cycles still owed, negative = overrun carried. */
    this.icount = 0;
    /** True while the /RESET input is asserted: the CPU is suspended. */
    this.resetHeld = false;

    // device_start(): these three are NOT touched by device_reset().
    this.ifFlag = 0; // m_if: logical level of the /IRQ pin
    this.ctr = 0; // m_ctr: last level seen on the /TC pin
    this.oOutput = 0; // m_o_output: the O latch
    this.serialActive = false; // is MAME's m_serial timer running?
    this.reset();
  }

  /**
   * Power-on / reset-release state. Port of mb88_cpu_device::device_reset().
   * RAM, the IRQ/TC line levels and the O latch survive, as in MAME.
   * @returns {void}
   */
  reset() {
    this.pc = 0; this.pa = 0;
    this.sp.fill(0); this.si = 0;
    this.a = 0; this.x = 0; this.y = 0;
    this.st = 1; // "start off with st=1"
    this.zf = 0; this.cf = 0; this.vf = 0; this.sf = 0;
    // device_reset sets m_pio = 0 directly (not via pio_enable), so a running
    // serial timer is left alone -- we mirror that by not touching it.
    this.pio = 0;
    this.th = 0; this.tl = 0; this.tp = 0;
    this.sb = 0; this.sbCount = 0;
    this.pendingIrq = 0;
    this.inIrq = false;
  }

  /**
   * Drive the /RESET input (logical: true = asserted). While asserted the CPU
   * is suspended; on release it is reset and resumes from $000. This is how
   * MAME's diexec handles INPUT_LINE_RESET (suspend on assert,
   * device().reset() + resume on clear).
   * @param {boolean|number} asserted
   * @returns {void}
   */
  setResetLine(asserted) {
    if (asserted) {
      this.resetHeld = true;
      this.icount = 0;
    } else if (this.resetHeld) {
      this.reset();
      this.resetHeld = false;
      this.icount = 0;
    }
  }

  /**
   * Drive the /IRQ input (logical level, 1 = asserted). An external interrupt
   * is latched on the rising edge, but only if PIO bit 2 enables it at that
   * moment -- edges while disabled are lost; programs can still poll the level
   * with `tsti`. @see mb88xx.cpp execute_set_input, MB88XX_IRQ_LINE
   * @param {boolean|number} asserted
   * @returns {void}
   */
  setIrqLine(asserted) {
    const state = asserted ? 1 : 0;
    if (!this.ifFlag && state && (this.pio & INT_CAUSE_EXTERNAL)) {
      this.pendingIrq |= INT_CAUSE_EXTERNAL;
    }
    this.ifFlag = state;
  }

  /**
   * Drive the /TC timer/counter input. The timer counts on the falling edge
   * (1 -> 0) when PIO bit 6 (external clock) is set.
   * @see mb88xx.cpp execute_set_input, MB88XX_TC_LINE
   * @param {boolean|number} asserted
   * @returns {void}
   */
  setTcLine(asserted) {
    const state = asserted ? 1 : 0;
    if (this.ctr && !state && (this.pio & 0x40)) this.incrementTimer();
    this.ctr = state;
  }

  /**
   * Execute for `mcuCycles` machine cycles (plus whatever the last
   * instruction overruns; the overrun is deducted from the next call).
   * @param {number} mcuCycles
   * @returns {number} machine cycles actually consumed by this call
   */
  run(mcuCycles) {
    if (this.resetHeld) {
      // Suspended: time passes, nothing executes, no debt accumulates.
      this.cycles += mcuCycles;
      return mcuCycles;
    }
    this.icount += mcuCycles;
    const start = this.icount;
    while (this.icount > 0) this.icount -= this.step();
    return start - this.icount;
  }

  /** Linear program address of the next fetch. @returns {number} */
  getPc() {
    return (this.pa << 6) + this.pc;
  }

  /** @returns {number} program byte at the current PC (READOP(GETPC())) */
  fetch() {
    return this.rom[this.getPc() & this.programMask];
  }

  /** INCPC: 6-bit PC, carry into the page register. @returns {void} */
  incPc() {
    this.pc += 1;
    if (this.pc >= 0x40) {
      this.pc = 0;
      this.pa = (this.pa + 1) & 0xff;
    }
  }

  /** @param {number} addr @returns {number} RDMEM */
  rd(addr) {
    return this.ram[addr & this.dataMask] & 0x0f;
  }

  /** @param {number} addr @param {number} v WRMEM @returns {void} */
  wr(addr, v) {
    this.ram[addr & this.dataMask] = v & 0x0f;
  }

  /** GETEA: the RAM nibble selected by X:Y. @returns {number} */
  ea() {
    return (this.x << 4) + this.y;
  }

  /**
   * O port output through the PLA. In the default 8-bit mode the 5-bit
   * index (CF:A) selects a nibble: CF=0 writes O3-O0, CF=1 writes O7-O4.
   * @see mb88xx.cpp write_pla
   * @param {number} index
   * @returns {void}
   */
  writePla(index) {
    let mask = 0xff;
    if (this.plaBits === 8) {
      const shift = (index & 0x10) ? 4 : 0;
      mask = 0x0f << shift;
      this.oOutput = (this.oOutput & ~mask & 0xff) | ((index << shift) & mask);
    } else {
      this.oOutput = this.plaData ? this.plaData[index] : index;
    }
    this.writeO(this.oOutput, mask);
  }

  /**
   * Change the peripheral enable register, (re)starting the serial timer
   * when bits 5-4 change. MAME only supports modes 00 (off) and 10
   * (internal shift clock); anything else is a fatalerror there too.
   * @see mb88xx.cpp pio_enable
   * @param {number} newpio
   * @returns {void}
   */
  pioEnable(newpio) {
    if ((this.pio ^ newpio) & 0x30) {
      if ((newpio & 0x30) === 0) this.serialActive = false;
      else if ((newpio & 0x30) === 0x20) this.serialActive = true;
      else throw new Error(`mb88xx: pio_enable set serial enable to unsupported value ${(newpio & 0x30).toString(16)}`);
    }
    this.pio = newpio & 0xff;
  }

  /** One serial clock. @see mb88xx.cpp serial_timer @returns {void} */
  serialTick() {
    this.sbCount += 1;
    if (this.sbCount >= SERIAL_DISABLE_THRESH) this.serialActive = false;
    // Only shift while not full (the 52XX relies on this, per MAME).
    if (!this.sf) {
      this.sb = (this.sb >> 1) | (this.readSI() ? 8 : 0);
      if (this.sbCount >= 4) {
        this.sf = 1;
        this.pendingIrq |= INT_CAUSE_SERIAL;
      }
    }
  }

  /**
   * TL/TH form an 8-bit counter; wrapping TH sets VF and latches a timer
   * interrupt request (serviced only if PIO bit 1 enables it).
   * @see mb88xx.cpp increment_timer
   * @returns {void}
   */
  incrementTimer() {
    this.tl = (this.tl + 1) & 0x0f;
    if (this.tl === 0) {
      this.th = (this.th + 1) & 0x0f;
      if (this.th === 0) {
        this.vf = 1;
        this.pendingIrq |= INT_CAUSE_TIMER;
      }
    }
  }

  /**
   * Account for executed cycles, clock the internal timer and serial port,
   * then take a pending, enabled interrupt if not already in one. Called
   * after every instruction, so an interrupt is recognised at the next
   * instruction boundary. @see mb88xx.cpp burn_cycles
   * @param {number} n
   * @returns {void}
   */
  burnCycles(n) {
    // (MAME also subtracts n from m_icount here; run() does that with
    // step()'s return value so that step() can be used on its own.)
    this.cycles += n;

    if (this.pio & 0x80) { // internal clock enable
      this.tp += n;
      while (this.tp >= TIMER_PRESCALE) {
        this.tp -= TIMER_PRESCALE;
        this.incrementTimer();
      }
    }

    // See file header: the serial timer is approximated as one tick per cycle.
    for (let i = 0; i < n && this.serialActive; i += 1) this.serialTick();

    if (!this.inIrq && (this.pendingIrq & this.pio)) {
      this.inIrq = true;
      const intpc = this.getPc();
      // Push the return address with CF/ZF/ST in bits 15/14/13.
      this.sp[this.si] = intpc | (this.cf << 15) | (this.zf << 14) | (this.st << 13);
      this.si = (this.si + 1) & 3;

      // Vectors: external $02, timer $04, serial $06 (page 0). The datasheet
      // is silent; MAME took them from the Arabian MCU program.
      const cause = this.pendingIrq & this.pio;
      if (cause & INT_CAUSE_EXTERNAL) this.pc = 0x02;
      else if (cause & INT_CAUSE_TIMER) this.pc = 0x04;
      else if (cause & INT_CAUSE_SERIAL) this.pc = 0x06;

      this.pa = 0;
      this.st = 1;
      // All pending causes are dropped, even ones not serviced (MAME).
      this.pendingIrq = 0;
      this.burnCycles(3);
    }
  }

  /**
   * Execute one instruction (and a possible interrupt entry after it).
   * Each case is a transliteration of the matching case in MAME's
   * execute_run(); the "ZCS:" notes are MAME's (which flags an opcode
   * touches). Helpers mirror MAME's macros:
   *   UPDATE_ST_C(v): st = bit4(v) ? 0 : 1   (ST = "no carry/borrow")
   *   UPDATE_ST_Z(v): st = v == 0 ? 0 : 1
   *   UPDATE_CF(v):   cf = bit4(v)
   *   UPDATE_ZF(v):   zf = v == 0 ? 1 : 0
   * MAME keeps registers in u8, so an intermediate like `Y - 1` with Y = 0
   * is 0xFF, whose bit 4 is set; `& 0xff` below reproduces that.
   * @returns {number} machine cycles consumed (including interrupt entry)
   */
  step() {
    const before = this.cycles;
    const opcode = this.fetch();
    this.incPc();
    let oc = 1; // every instruction costs at least one cycle
    let arg;

    switch (opcode) {
      case 0x00: // nop
        this.st = 1;
        break;
      case 0x01: // outO: O nibble selected by CF gets A
        this.writePla((this.cf << 4) | this.a);
        this.st = 1;
        break;
      case 0x02: // outP
        this.writeP(this.a);
        this.st = 1;
        break;
      case 0x03: // outR: R port (Y & 3) gets A
        this.writeR(this.y & 3, this.a);
        this.st = 1;
        break;
      case 0x04: // tay
        this.y = this.a;
        this.st = 1;
        break;
      case 0x05: // tath
        this.th = this.a;
        this.st = 1;
        break;
      case 0x06: // tatl
        this.tl = this.a;
        this.st = 1;
        break;
      case 0x07: // tas
        this.sb = this.a;
        this.st = 1;
        break;
      case 0x08: // icy ZCS:x.x
        this.y += 1;
        this.st = (this.y & 0x10) ? 0 : 1;
        this.y &= 0x0f;
        this.zf = this.y === 0 ? 1 : 0;
        break;
      case 0x09: // icm ZCS:x.x
        arg = this.rd(this.ea()) + 1;
        this.st = (arg & 0x10) ? 0 : 1;
        arg &= 0x0f;
        this.zf = arg === 0 ? 1 : 0;
        this.wr(this.ea(), arg);
        break;
      case 0x0a: // stic ZCS:x.x  store A, then Y++
        this.wr(this.ea(), this.a);
        this.y += 1;
        this.st = (this.y & 0x10) ? 0 : 1;
        this.y &= 0x0f;
        this.zf = this.y === 0 ? 1 : 0;
        break;
      case 0x0b: // x ZCS:x..  exchange A with M[X:Y]
        arg = this.rd(this.ea());
        this.wr(this.ea(), this.a);
        this.a = arg;
        this.zf = this.a === 0 ? 1 : 0;
        this.st = 1;
        break;
      case 0x0c: // rol ZCS:xxx  rotate left through carry
        this.a = ((this.a << 1) | this.cf) & 0xff;
        this.st = (this.a & 0x10) ? 0 : 1;
        this.cf = this.st ^ 1;
        this.a &= 0x0f;
        this.zf = this.a === 0 ? 1 : 0;
        break;
      case 0x0d: // l ZCS:x..  load A from M[X:Y]
        this.a = this.rd(this.ea());
        this.zf = this.a === 0 ? 1 : 0;
        this.st = 1;
        break;
      case 0x0e: // adc ZCS:xxx
        arg = this.rd(this.ea()) + this.a + this.cf;
        this.st = (arg & 0x10) ? 0 : 1;
        this.cf = this.st ^ 1;
        this.a = arg & 0x0f;
        this.zf = this.a === 0 ? 1 : 0;
        break;
      case 0x0f: // and ZCS:x.x
        this.a &= this.rd(this.ea());
        this.zf = this.a === 0 ? 1 : 0;
        this.st = this.zf ^ 1;
        break;
      case 0x10: // daa ZCS:.xx
        // Note the carry out is that of A+6 alone: a binary sum >= 16 that
        // arrived here with CF=1 and a small A (e.g. 9+7 -> A=0, CF=1)
        // leaves with CF=0. That is MAME's behaviour, kept on purpose.
        if (this.cf || this.a > 9) this.a += 6;
        this.st = (this.a & 0x10) ? 0 : 1;
        this.cf = this.st ^ 1;
        this.a &= 0x0f;
        break;
      case 0x11: // das ZCS:.xx
        if (this.cf || this.a > 9) this.a += 10;
        this.st = (this.a & 0x10) ? 0 : 1;
        this.cf = this.st ^ 1;
        this.a &= 0x0f;
        break;
      case 0x12: // inK ZCS:x..
        this.a = this.readK() & 0x0f;
        this.zf = this.a === 0 ? 1 : 0;
        this.st = 1;
        break;
      case 0x13: // inR ZCS:x..  A = R port (Y & 3)
        this.a = this.readR(this.y & 3) & 0x0f;
        this.zf = this.a === 0 ? 1 : 0;
        this.st = 1;
        break;
      case 0x14: // tya
        this.a = this.y;
        this.zf = this.a === 0 ? 1 : 0;
        this.st = 1;
        break;
      case 0x15: // ttha
        this.a = this.th;
        this.zf = this.a === 0 ? 1 : 0;
        this.st = 1;
        break;
      case 0x16: // ttla
        this.a = this.tl;
        this.zf = this.a === 0 ? 1 : 0;
        this.st = 1;
        break;
      case 0x17: // tsa
        this.a = this.sb;
        this.zf = this.a === 0 ? 1 : 0;
        this.st = 1;
        break;
      case 0x18: // dcy ZCS:..x  (ZF untouched, unlike icy)
        this.y = (this.y - 1) & 0xff;
        this.st = (this.y & 0x10) ? 0 : 1;
        this.y &= 0x0f;
        break;
      case 0x19: // dcm ZCS:x.x
        arg = (this.rd(this.ea()) - 1) & 0xff;
        this.st = (arg & 0x10) ? 0 : 1;
        arg &= 0x0f;
        this.zf = arg === 0 ? 1 : 0;
        this.wr(this.ea(), arg);
        break;
      case 0x1a: // stdc ZCS:x.x  store A, then Y--
        this.wr(this.ea(), this.a);
        this.y = (this.y - 1) & 0xff;
        this.st = (this.y & 0x10) ? 0 : 1;
        this.y &= 0x0f;
        this.zf = this.y === 0 ? 1 : 0;
        break;
      case 0x1b: // xx ZCS:x..  exchange A and X
        arg = this.x;
        this.x = this.a;
        this.a = arg;
        this.zf = this.a === 0 ? 1 : 0;
        this.st = 1;
        break;
      case 0x1c: // ror ZCS:xxx  rotate right through carry
        this.a |= this.cf << 4;
        // UPDATE_ST_C(A << 4): bit 4 of A<<4 is bit 0 of A, the bit
        // about to fall out into the carry.
        this.st = ((this.a << 4) & 0x10) ? 0 : 1;
        this.cf = this.st ^ 1;
        this.a = (this.a >> 1) & 0x0f;
        this.zf = this.a === 0 ? 1 : 0;
        break;
      case 0x1d: // st  M[X:Y] = A
        this.wr(this.ea(), this.a);
        this.st = 1;
        break;
      case 0x1e: // sbc ZCS:xxx  A = M - A - CF
        arg = (this.rd(this.ea()) - this.a - this.cf) & 0xff;
        this.st = (arg & 0x10) ? 0 : 1;
        this.cf = this.st ^ 1;
        this.a = arg & 0x0f;
        this.zf = this.a === 0 ? 1 : 0;
        break;
      case 0x1f: // or ZCS:x.x
        this.a |= this.rd(this.ea());
        this.zf = this.a === 0 ? 1 : 0;
        this.st = this.zf ^ 1;
        break;
      case 0x20: { // setR: set bit (Y & 3) of R port (Y >> 2), read-modify-write via the input side
        const port = this.y >> 2;
        arg = this.readR(port) & 0x0f;
        this.writeR(port, arg | (1 << (this.y & 3)));
        this.st = 1;
        break;
      }
      case 0x21: // setc
        this.cf = 1;
        this.st = 1;
        break;
      case 0x22: { // rstR
        const port = this.y >> 2;
        arg = this.readR(port) & 0x0f;
        this.writeR(port, arg & ~(1 << (this.y & 3)) & 0x0f);
        this.st = 1;
        break;
      }
      case 0x23: // rstc
        this.cf = 0;
        this.st = 1;
        break;
      case 0x24: // tstr ZCS:..x  ST = !bit
        arg = this.readR(this.y >> 2) & 0x0f;
        this.st = (arg & (1 << (this.y & 3))) ? 0 : 1;
        break;
      case 0x25: // tsti ZCS:..x  ST = !IRQ level
        this.st = this.ifFlag ^ 1;
        break;
      case 0x26: // tstv ZCS:..x  test-and-clear timer overflow
        this.st = this.vf ^ 1;
        this.vf = 0;
        break;
      case 0x27: // tsts ZCS:..x  test-and-clear serial full
        this.st = this.sf ^ 1;
        if (this.sf) {
          // re-enable the serial timer if it gave up (MAME)
          if (this.sbCount >= SERIAL_DISABLE_THRESH) this.serialActive = true;
          this.sbCount = 0;
        }
        this.sf = 0;
        break;
      case 0x28: // tstc
        this.st = this.cf ^ 1;
        break;
      case 0x29: // tstz
        this.st = this.zf ^ 1;
        break;
      case 0x2a: // sts ZCS:x..
        this.wr(this.ea(), this.sb);
        this.zf = this.sb === 0 ? 1 : 0;
        this.st = 1;
        break;
      case 0x2b: // ls ZCS:x..
        this.sb = this.rd(this.ea());
        this.zf = this.sb === 0 ? 1 : 0;
        this.st = 1;
        break;
      case 0x2c: // rts
        this.si = (this.si - 1) & 3;
        this.pc = this.sp[this.si] & 0x3f;
        this.pa = (this.sp[this.si] >> 6) & 0x1f;
        this.st = 1;
        break;
      case 0x2d: // neg ZCS:..x  two's complement; ST = (result != 0)
        this.a = (~this.a + 1) & 0x0f;
        this.st = this.a === 0 ? 0 : 1;
        break;
      case 0x2e: // c ZCS:xxx  compare M - A; ST = not equal, CF = borrow
        arg = (this.rd(this.ea()) - this.a) & 0xff;
        this.cf = (arg & 0x10) ? 1 : 0;
        arg &= 0x0f;
        this.st = arg === 0 ? 0 : 1;
        this.zf = this.st ^ 1;
        break;
      case 0x2f: // eor ZCS:x.x
        this.a ^= this.rd(this.ea());
        this.st = this.a === 0 ? 0 : 1;
        this.zf = this.st ^ 1;
        break;
      case 0x30: case 0x31: case 0x32: case 0x33: // sbit n
        arg = this.rd(this.ea());
        this.wr(this.ea(), arg | (1 << (opcode & 3)));
        this.st = 1;
        break;
      case 0x34: case 0x35: case 0x36: case 0x37: // rbit n
        arg = this.rd(this.ea());
        this.wr(this.ea(), arg & ~(1 << (opcode & 3)));
        this.st = 1;
        break;
      case 0x38: case 0x39: case 0x3a: case 0x3b: // tbit n: ST = !bit
        arg = this.rd(this.ea());
        this.st = (arg & (1 << (opcode & 3))) ? 0 : 1;
        break;
      case 0x3c: { // rti: pop address and the flags saved at interrupt entry
        this.inIrq = false;
        this.si = (this.si - 1) & 3;
        const w = this.sp[this.si];
        this.pc = w & 0x3f;
        this.pa = (w >> 6) & 0x1f;
        this.st = (w >> 13) & 1;
        this.zf = (w >> 14) & 1;
        this.cf = (w >> 15) & 1;
        break;
      }
      case 0x3d: // jpa imm: PA = imm, PC = A * 4 (a 16-way jump table)
        // The operand is read but PC is not incremented past it -- it is
        // overwritten anyway.
        this.pa = this.fetch() & 0x1f;
        this.pc = this.a * 4;
        oc += 1;
        this.st = 1;
        break;
      case 0x3e: // en imm: PIO |= imm
        this.pioEnable(this.pio | this.fetch());
        this.incPc();
        oc += 1;
        this.st = 1;
        break;
      case 0x3f: // dis imm: PIO &= ~imm
        this.pioEnable(this.pio & ~this.fetch());
        this.incPc();
        oc += 1;
        this.st = 1;
        break;
      case 0x40: case 0x41: case 0x42: case 0x43: // setD n: R0 bit n = 1
        arg = (this.readR(0) & 0x0f) | (1 << (opcode & 3));
        this.writeR(0, arg);
        this.st = 1;
        break;
      case 0x44: case 0x45: case 0x46: case 0x47: // rstD n: R0 bit n = 0
        arg = (this.readR(0) & 0x0f) & ~(1 << (opcode & 3));
        this.writeR(0, arg);
        this.st = 1;
        break;
      case 0x48: case 0x49: case 0x4a: case 0x4b: // tstD n: tests R2 (sic, MAME)
        arg = this.readR(2) & 0x0f;
        this.st = (arg & (1 << (opcode & 3))) ? 0 : 1;
        break;
      case 0x4c: case 0x4d: case 0x4e: case 0x4f: // tba n: ST = !A.bit n
        this.st = (this.a & (1 << (opcode & 3))) ? 0 : 1;
        break;
      case 0x50: case 0x51: case 0x52: case 0x53: // xd n: A <-> M[n] (row 0, absolute)
        arg = this.rd(opcode & 3);
        this.wr(opcode & 3, this.a);
        this.a = arg;
        this.zf = this.a === 0 ? 1 : 0;
        this.st = 1;
        break;
      case 0x54: case 0x55: case 0x56: case 0x57: // xyd n: Y <-> M[4 + n] (row 0, absolute)
        arg = this.rd((opcode & 3) + 4);
        this.wr((opcode & 3) + 4, this.y);
        this.y = arg;
        this.zf = this.y === 0 ? 1 : 0;
        this.st = 1;
        break;
      case 0x58: case 0x59: case 0x5a: case 0x5b:
      case 0x5c: case 0x5d: case 0x5e: case 0x5f: // lxi n (3-bit immediate)
        this.x = opcode & 7;
        this.zf = this.x === 0 ? 1 : 0;
        this.st = 1;
        break;
      case 0x60: case 0x61: case 0x62: case 0x63:
      case 0x64: case 0x65: case 0x66: case 0x67: // call imm, taken if ST
        arg = this.fetch();
        this.incPc();
        oc += 1;
        if (this.st) {
          this.sp[this.si] = this.getPc();
          this.si = (this.si + 1) & 3;
          this.pc = arg & 0x3f;
          this.pa = ((opcode & 7) << 2) | (arg >> 6);
        }
        this.st = 1;
        break;
      case 0x68: case 0x69: case 0x6a: case 0x6b:
      case 0x6c: case 0x6d: case 0x6e: case 0x6f: // jpl imm, taken if ST
        arg = this.fetch();
        this.incPc();
        oc += 1;
        if (this.st) {
          this.pc = arg & 0x3f;
          this.pa = ((opcode & 7) << 2) | (arg >> 6);
        }
        this.st = 1;
        break;
      default:
        if (opcode < 0x80) { // 0x70-0x7F ai imm ZCS:xxx
          arg = (opcode & 0x0f) + this.a;
          this.st = (arg & 0x10) ? 0 : 1;
          this.cf = this.st ^ 1;
          this.a = arg & 0x0f;
          this.zf = this.a === 0 ? 1 : 0;
        } else if (opcode < 0x90) { // 0x80-0x8F lyi imm (MAME's comment says "lxi")
          this.y = opcode & 0x0f;
          this.zf = this.y === 0 ? 1 : 0;
          this.st = 1;
        } else if (opcode < 0xa0) { // 0x90-0x9F li imm
          this.a = opcode & 0x0f;
          this.zf = this.a === 0 ? 1 : 0;
          this.st = 1;
        } else if (opcode < 0xb0) { // 0xA0-0xAF cyi imm: compare imm - Y
          arg = ((opcode & 0x0f) - this.y) & 0xff;
          this.cf = (arg & 0x10) ? 1 : 0;
          arg &= 0x0f;
          this.st = arg === 0 ? 0 : 1;
          this.zf = this.st ^ 1;
        } else if (opcode < 0xc0) { // 0xB0-0xBF ci imm: compare imm - A
          arg = ((opcode & 0x0f) - this.a) & 0xff;
          this.cf = (arg & 0x10) ? 1 : 0;
          arg &= 0x0f;
          this.st = arg === 0 ? 0 : 1;
          this.zf = this.st ^ 1;
        } else { // 0xC0-0xFF jmp: in-page jump (PA as left by INCPC), taken if ST
          if (this.st) this.pc = opcode & 0x3f;
          this.st = 1;
        }
        break;
    }

    // update cycle count, also update interrupts, serial and timer flags
    this.burnCycles(oc);
    return this.cycles - before;
  }
}
