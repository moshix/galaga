// Copyright 2026 by Moshix
/**
 * The Galaga CPU and video boards, emulated closely enough to run the real
 * 1981 program ROMs unmodified. This is the *oracle*: tests run the original
 * machine code here and compare what it does against the JavaScript port.
 * Nothing in src/ imports this file, and no Z80 executes when the game is
 * played in the browser.
 *
 * What is on the board (MAME galaga.cpp, `galaga_state::galaga`):
 *
 *   three Z80s at 3.072 MHz        main ($0000-$3FFF), sub and sound ($0000-$0FFF)
 *   shared RAM                     $8000-$87FF video, $8800/$9000/$9800 1 KB each
 *   LS259 "misclatch" $6820-$6827  Q0 main IRQ enable, Q1 sub IRQ enable,
 *                                  Q2 sound NMI enable (inverted), Q3 run/reset
 *                                  of sub, sound, 51XX and 54XX
 *   DIP switches      $6800-$6807  two bits per address (DSWB bit n, DSWA bit n)
 *   WSG sound         $6800-$681F  write only, low nibble
 *   watchdog          $6830
 *   06XX              $7000-$70FF data, $7100 control -> 51XX (I/O), 54XX (noise)
 *   video latch       $A000-$A007  starfield control, flip screen
 *
 * Timing (MAME `m_screen->set_raw(MASTER_CLOCK/3, 384, 0, 288, 264, 0, 224)`):
 * 384 pixel clocks at 6.144 MHz per line = 192 CPU cycles; 264 lines per frame
 * = 50688 CPU cycles = 60.606 Hz. Vblank starts at line 224 (cycle 43008): the
 * main and sub CPUs take a level-triggered IRQ there if enabled. The sound CPU
 * gets an NMI at lines 64 and 192.
 *
 * The CPUs genuinely run in parallel on the real board. Here they are
 * interleaved in short slices (QUANTUM cycles), main first, then sub, then
 * sound -- the same order MAME uses within a timeslice.
 */

import { Z80 } from './z80.mjs';

export const CYCLES_PER_LINE = 192;
export const LINES_PER_FRAME = 264;
export const CYCLES_PER_FRAME = CYCLES_PER_LINE * LINES_PER_FRAME; // 50688
export const VBLANK_LINE = 224;
export const VBLANK_CYCLE = VBLANK_LINE * CYCLES_PER_LINE; // 43008
/** Sound CPU NMI lines. @see galaga.cpp cpu3_interrupt_callback */
export const SOUND_NMI_LINES = Object.freeze([64, 192]);

/** Interleave slice, in CPU cycles. MAME's maximum quantum is 1/6000 s = 512. */
export const QUANTUM = 128;

/** 06XX base clock = 3.072 MHz / 64 = 48 kHz: one tick every 64 CPU cycles. */
const N06XX_TICK = 64;

/**
 * Default dip switches, as MAME ships them for `galaga` (INPUT_PORTS_START).
 * DSWA: difficulty easy, demo sound on, freeze off, rack test off, upright.
 * DSWB: 1 coin 1 credit, bonus 20K/70K/every 70K, 3 fighters.
 */
export const DEFAULT_DSWA = 0xf7;
export const DEFAULT_DSWB = 0x97;

/**
 * Input switch bits. Both ports are ACTIVE LOW and reach the CPU only through
 * the 51XX. @see galaga.cpp INPUT_PORTS_START( galaga )
 */
export const IN0 = Object.freeze({ RIGHT: 0x02, LEFT: 0x08, P2_RIGHT: 0x20, P2_LEFT: 0x80 });
export const IN1 = Object.freeze({
  FIRE: 0x01, P2_FIRE: 0x02, START1: 0x04, START2: 0x08,
  COIN1: 0x10, COIN2: 0x20, SERVICE: 0x40, TEST: 0x80,
});

/** Named inputs -> [port, bit]. */
const INPUTS = Object.freeze({
  left: ['in0', IN0.LEFT], right: ['in0', IN0.RIGHT],
  p2left: ['in0', IN0.P2_LEFT], p2right: ['in0', IN0.P2_RIGHT],
  fire: ['in1', IN1.FIRE], p2fire: ['in1', IN1.P2_FIRE],
  start1: ['in1', IN1.START1], start2: ['in1', IN1.START2],
  coin1: ['in1', IN1.COIN1], coin2: ['in1', IN1.COIN2],
  service: ['in1', IN1.SERVICE], test: ['in1', IN1.TEST],
});

/**
 * A custom chip on the 06XX bus (51XX or 54XX). The low-level MB88
 * implementations in test/mcu/ satisfy this; {@link NullChip} is the stand-in
 * for a slot with nothing plugged in.
 * @typedef {object} BusChip
 * @property {(state: number) => void} reset       active-low reset input
 * @property {(state: number) => void} [vblank]     51XX timer input
 * @property {(state: number) => void} [rw]         1 = read cycle
 * @property {(state: number) => void} chipSelect
 * @property {() => number} [read]
 * @property {(data: number) => void} write
 * @property {(z80Cycles: number) => void} run
 */

/** @implements {BusChip} */
export class NullChip {
  reset() {}
  vblank() {}
  rw() {}
  chipSelect() {}
  read() { return 0xff; }
  write() {}
  run() {}
}

/**
 * The Namco 06XX bus interface. Exact port of MAME namco06.cpp.
 *
 * The control register's low four bits select chips, bit 4 is read/!write and
 * bits 5-7 a clock divider. While the divider is non-zero a timer toggles at
 * twice the divided 48 kHz clock; on each "falling edge" half it pulses the
 * selected chips' select lines and (except for the very first pulse of a
 * read) the main CPU's NMI -- whose handler then moves exactly one byte.
 */
export class Namco06 {
  /**
   * @param {{ nmi: (asserted: boolean) => void, chips: BusChip[] }} wiring
   */
  constructor(wiring) {
    this.wiring = wiring;
    this.control = 0;
    this.timerState = false;
    this.readStretch = false;
    /** Absolute cycle of the next timer event, or Infinity when stopped. */
    this.nextEvent = Infinity;
    /** Timer period in CPU cycles (half the divided clock). */
    this.period = 0;
    this.nmiLine = false;
  }

  /** @param {boolean} state */
  setNmi(state) {
    if (state && !this.nmiLine) this.wiring.nmi(true);
    if (!state && this.nmiLine) this.wiring.nmi(false);
    this.nmiLine = state;
  }

  /** Timer expiry: namco_06xx_device::nmi_generate. */
  fire() {
    this.timerState = !this.timerState;
    const readMode = (this.control >> 4) & 1;
    if (this.timerState) for (const c of this.wiring.chips) c.rw?.(readMode);
    // During reads, the first NMI pulse is suppressed to give the chip a
    // cycle to write.
    this.setNmi(this.timerState && !this.readStretch);
    this.readStretch = false;
    this.wiring.chips.forEach((c, i) => c.chipSelect(((this.control >> i) & 1) && this.timerState ? 1 : 0));
    this.nextEvent += this.period;
  }

  /** @returns {number} */
  dataRead() {
    if (!(this.control & 0x10)) return 0;
    let result = 0xff;
    this.wiring.chips.forEach((c, i) => { if ((this.control >> i) & 1) result &= c.read ? c.read() : 0xff; });
    return result;
  }

  /** @param {number} data */
  dataWrite(data) {
    if (this.control & 0x10) return;
    this.wiring.chips.forEach((c, i) => { if ((this.control >> i) & 1) c.write(data); });
  }

  /** @param {number} data @param {number} now absolute CPU cycle */
  controlWrite(data, now) {
    this.control = data & 0xff;
    if ((this.control & 0xe0) === 0) {
      this.nextEvent = Infinity;
      this.timerState = false;
      this.setNmi(false);
      for (const c of this.wiring.chips) c.chipSelect(0);
      return;
    }
    if (this.control & 0x10) { this.setNmi(false); this.readStretch = true; } else this.readStretch = false;
    const divisor = 1 << ((this.control & 0xe0) >> 5);
    this.period = (divisor * N06XX_TICK) / 2;
    // Delay to the next edge of the 48 kHz clock.
    this.nextEvent = (Math.floor(now / N06XX_TICK) + 1) * N06XX_TICK;
  }
}

export class GalagaBoard {
  /**
   * @param {{ main: Uint8Array, sub: Uint8Array, sound: Uint8Array }} roms
   * @param {{ mcu51?: BusChip, mcu54?: BusChip }} [chips]
   */
  constructor(roms, chips = {}) {
    /** Each CPU sees its own ROM in $0000-$3FFF; unloaded space reads 0. */
    this.roms = [pad(roms.main), pad(roms.sub), pad(roms.sound)];
    /** $8000-$87FF: tile codes then tile colours. */
    this.video = new Uint8Array(0x800);
    /** $8800-$8BFF, $9000-$93FF, $9800-$9BFF. */
    this.ram1 = new Uint8Array(0x400);
    this.ram2 = new Uint8Array(0x400);
    this.ram3 = new Uint8Array(0x400);

    /** WSG registers $6800-$681F, low nibble only. */
    this.wsg = new Uint8Array(0x20);
    /** LS259 at 3C: $6820-$6827. */
    this.misc = new Uint8Array(8);
    /** LS259 at 5K on the video board: $A000-$A007. */
    this.videoLatch = new Uint8Array(8);

    this.dswA = DEFAULT_DSWA;
    this.dswB = DEFAULT_DSWB;
    /** Active-low input ports; 0xFF = nothing pressed. */
    this.in0 = 0xff;
    this.in1 = 0xff;

    this.mcu51 = chips.mcu51 ?? new NullChip();
    this.mcu54 = chips.mcu54 ?? new NullChip();

    this.cpus = [0, 1, 2].map((n) => new Z80({
      read: (a) => this.read(n, a),
      write: (a, v) => this.write(n, a, v),
      readIo: () => 0xff,
      writeIo: () => {},
    }));
    /** Sub and sound CPUs start held in reset (latch Q3 powers up low). */
    this.inReset = [false, true, true];
    /** Cycle each CPU has executed up to (absolute). */
    this.cpuTime = [0, 0, 0];

    this.n06 = new Namco06({
      nmi: (on) => { if (on) this.cpus[0].nmi(); },
      chips: [this.mcu51, new NullChip(), new NullChip(), this.mcu54],
    });

    /** Absolute cycle count at the start of the current frame. */
    this.frameStart = 0;
    /** Next entry of frameEvents() to fire in the current frame. */
    this.eventIndex = 0;
    this.frames = 0;
    /** Absolute cycle the slice currently executing began at (for 06XX writes). */
    this.now = 0;
    this.watchdogCounter = 0;
    this.watchdogResets = 0;
    /** Optional observers. @type {null | ((addr: number, value: number) => void)} */
    this.onWsgWrite = null;
    /** Called with (cpu, addr, value) on every write, when set. */
    this.onWrite = null;
    /**
     * Called after every instruction with (cpu number, pc it started at, the
     * Z80), when set. Slow; for tests that need to watch specific code.
     * @type {null | ((n: number, pc: number, cpu: Z80) => void)}
     */
    this.onExec = null;

    this.applyMiscLatch();
  }

  // ------------------------------------------------------------ memory map

  /** @param {number} cpu 0 main, 1 sub, 2 sound @param {number} addr */
  read(cpu, addr) {
    const a = addr & 0xffff;
    if (a < 0x4000) return this.roms[cpu][a];
    if (a < 0x6800) return 0;
    if (a < 0x6808) {
      // bosco_dsw_r: bit 0 from DSWB, bit 1 from DSWA, one switch per address.
      const o = a & 7;
      return ((this.dswB >> o) & 1) | (((this.dswA >> o) & 1) << 1);
    }
    if (a >= 0x7000 && a < 0x7100) return this.n06.dataRead();
    if (a === 0x7100) return this.n06.control;
    if (a >= 0x8000 && a < 0x8800) return this.video[a - 0x8000];
    if (a >= 0x8800 && a < 0x8c00) return this.ram1[a - 0x8800];
    if (a >= 0x9000 && a < 0x9400) return this.ram2[a - 0x9000];
    if (a >= 0x9800 && a < 0x9c00) return this.ram3[a - 0x9800];
    return 0;
  }

  /** @param {number} cpu @param {number} addr @param {number} value */
  write(cpu, addr, value) {
    const a = addr & 0xffff;
    const v = value & 0xff;
    if (this.onWrite !== null) this.onWrite(cpu, a, v);
    if (a < 0x6800) return;
    if (a < 0x6820) {
      this.wsg[a - 0x6800] = v & 0x0f;
      if (this.onWsgWrite !== null) this.onWsgWrite(a - 0x6800, v & 0x0f);
      return;
    }
    if (a < 0x6828) { this.misc[a & 7] = v & 1; this.applyMiscLatch(); return; }
    if (a === 0x6830) { this.watchdogCounter = 0; return; }
    if (a >= 0x7000 && a < 0x7100) { this.n06.dataWrite(v); return; }
    if (a === 0x7100) { this.n06.controlWrite(v, this.now + this.cpus[cpu].t); return; }
    if (a >= 0x8000 && a < 0x8800) { this.video[a - 0x8000] = v; return; }
    if (a >= 0x8800 && a < 0x8c00) { this.ram1[a - 0x8800] = v; return; }
    if (a >= 0x9000 && a < 0x9400) { this.ram2[a - 0x9000] = v; return; }
    if (a >= 0x9800 && a < 0x9c00) { this.ram3[a - 0x9800] = v; return; }
    if (a >= 0xa000 && a < 0xa008) { this.videoLatch[a & 7] = v & 1; }
  }

  /** Side-effect-free read of the shared address space, for tests. */
  peek(addr) { return this.read(0, addr); }

  /** @param {number} addr @param {number} value */
  poke(addr, value) {
    const saved = this.onWrite;
    this.onWrite = null;
    this.write(0, addr, value);
    this.onWrite = saved;
  }

  /** Apply LS259 3C outputs. @see galaga.cpp misclatch wiring */
  applyMiscLatch() {
    const [irq1, irq2, nmion, run] = this.misc;
    this.mainIrqMask = irq1;
    if (!irq1) this.cpus[0].clearIrq();
    this.subIrqMask = irq2;
    if (!irq2) this.cpus[1].clearIrq();
    this.soundNmiMask = nmion ? 0 : 1;
    // Q3 low holds sub, sound, 51XX and 54XX in reset.
    const held = !run;
    for (const n of [1, 2]) {
      if (held && !this.inReset[n]) this.inReset[n] = true;
      if (!held && this.inReset[n]) { this.inReset[n] = false; this.cpus[n].reset(); }
    }
    this.mcu51.reset(run);
    this.mcu54.reset(run);
  }

  // -------------------------------------------------------------- inputs

  /**
   * Press or release a switch.
   * @param {keyof typeof INPUTS} name @param {boolean} down
   */
  setInput(name, down) {
    const [port, bit] = INPUTS[name];
    // Active low: pressed clears the bit.
    this[port] = down ? (this[port] & ~bit) & 0xff : (this[port] | bit);
  }

  // ---------------------------------------------------------- scheduling

  /**
   * Run all three CPUs and the bus chips up to absolute cycle `until`.
   * @param {number} until
   * @param {null | ((board: GalagaBoard) => boolean)} [observe] checked between slices
   * @returns {boolean} true if `observe` stopped the run early
   */
  runTo(until, observe = null) {
    while (this.now < until) {
      const begin = this.now;
      let end = Math.min(until, this.now + QUANTUM);
      if (this.n06.nextEvent < end) end = Math.max(this.now + 1, this.n06.nextEvent);
      for (let n = 0; n < 3; n += 1) {
        const cpu = this.cpus[n];
        if (this.inReset[n]) { this.cpuTime[n] = end; continue; }
        while (this.cpuTime[n] < end) {
          // `now` tracks the CPU being run so 06XX control writes are timed
          // from where that CPU actually is.
          this.now = this.cpuTime[n];
          cpu.t = 0;
          if (this.onExec === null) this.cpuTime[n] += cpu.step();
          else {
            const pc = cpu.pc;
            this.cpuTime[n] += cpu.step();
            this.onExec(n, pc, cpu);
          }
        }
      }
      this.now = end;
      this.mcu51.run(end - begin);
      this.mcu54.run(end - begin);
      while (this.n06.nextEvent <= end) this.n06.fire();
      if (observe !== null && observe(this)) return true;
    }
    return false;
  }

  /**
   * The frame's timeline, as (line, action) pairs in order. Line 0 is the end
   * of vblank; the sound CPU is interrupted at lines 64 and 192; vblank starts
   * at line 224 (galaga_state::vblank_irq, cpu3_interrupt_callback).
   * @returns {Array<[number, () => void]>}
   */
  frameEvents() {
    return [
      // Vblank ends: the 51XX's timer input falls here.
      [0, () => this.mcu51.vblank?.(0)],
      [SOUND_NMI_LINES[0], () => this.soundNmi()],
      [SOUND_NMI_LINES[1], () => this.soundNmi()],
      [VBLANK_LINE, () => this.vblankStart()],
    ];
  }

  soundNmi() {
    if (this.soundNmiMask && !this.inReset[2]) this.cpus[2].nmi();
  }

  vblankStart() {
    if (this.mainIrqMask) this.cpus[0].irq(0xff);
    if (this.subIrqMask && !this.inReset[1]) this.cpus[1].irq(0xff);
    this.mcu51.vblank?.(1);
    this.watchdogCounter += 1;
    if (this.watchdogCounter >= 8) {
      // The real board resets everything; tests would rather know.
      this.watchdogResets += 1;
      this.watchdogCounter = 0;
    }
  }

  /**
   * Run to an absolute cycle, firing the frame events on the way. Can stop
   * and resume anywhere, mid-frame included.
   * @param {number} target absolute CPU cycle
   * @param {null | ((board: GalagaBoard) => boolean)} [observe]
   * @returns {boolean} true if stopped early by `observe`
   */
  advanceTo(target, observe = null) {
    const events = this.frameEvents();
    while (this.now < target) {
      if (this.eventIndex >= events.length) {
        // Frame over: the next one starts where this one ended.
        const end = this.frameStart + CYCLES_PER_FRAME;
        if (this.runTo(Math.min(end, target), observe)) return true;
        if (this.now < end) return false;
        this.frameStart = end;
        this.frames += 1;
        this.eventIndex = 0;
        continue;
      }
      const [line, action] = events[this.eventIndex];
      const at = this.frameStart + line * CYCLES_PER_LINE;
      if (this.runTo(Math.min(at, target), observe)) return true;
      if (this.now < at) return false;
      action();
      this.eventIndex += 1;
    }
    return false;
  }

  /**
   * Run to the end of the current video frame.
   * @param {null | ((board: GalagaBoard) => boolean)} [observe]
   * @returns {boolean} true if stopped early by `observe`
   */
  runFrame(observe = null) {
    return this.advanceTo(this.frameStart + CYCLES_PER_FRAME, observe);
  }

  /**
   * Run until `pred` holds at a frame boundary.
   * @param {(board: GalagaBoard) => boolean} pred @param {number} maxFrames
   * @returns {number} frames run
   */
  runUntil(pred, maxFrames) {
    for (let i = 0; i < maxFrames; i += 1) {
      if (pred(this)) return i;
      this.runFrame();
    }
    throw new Error(`condition not reached in ${maxFrames} frames`);
  }
}

/** @param {Uint8Array} rom */
function pad(rom) {
  const out = new Uint8Array(0x4000);
  out.set(rom.subarray(0, 0x4000));
  return out;
}
