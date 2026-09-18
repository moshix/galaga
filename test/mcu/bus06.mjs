// Copyright 2026 by Moshix
/**
 * A cycle-timed stand-in for the Namco 06XX bus interface plus the part of
 * the Galaga main CPU that talks to it, for driving the 51XX/54XX LLE in
 * tests without a Z80.
 *
 * The 06XX side is a transliteration of reference/mame/namco06.cpp:
 *  - The 06XX is clocked at MASTER_CLOCK/6/64 = 48 kHz, i.e. one tick every
 *    64 Z80 cycles. Control bits 7-5 select a divider 2^n; the internal
 *    timer fires at twice the divided clock (every 32 * 2^n Z80 cycles) and
 *    toggles `timerState`. timerState = true is the "falling edge": R/W is
 *    driven, chip selects are asserted and the Z80 NMI fires.
 *  - Writing the control register with a divider starts the timer at the
 *    next 48 kHz tick (ctrl_w_sync: from_ticks(total_ticks + 1)).
 *  - In read mode the first NMI is suppressed (m_read_stretch) to give the
 *    chip one strobe to put the first byte on the bus.
 *  - Writing a control value with divider 0 (Galaga uses $10) stops the
 *    timer and drops all chip selects.
 *
 * The Z80 side models Galaga's NMI handler at $0066 (exx; ldi; jp pe; ...;
 * ld (hl),$10): each NMI moves exactly one byte, `nmiLatency` Z80 cycles
 * after the NMI edge (NMI acknowledge 11T + exx 4T + the ldi bus cycle,
 * plus up to one instruction of latency), and after the last byte the
 * handler writes $10 to the control register `doneLatency` cycles after
 * the edge.
 *
 * All times are in Z80 cycles (3.072 MHz). The board is advanced with
 * `advanceTo()`, which runs each attached device up to that time.
 */

/** Z80 cycles per 06XX input clock tick (3.072 MHz / 48 kHz). */
export const Z80_PER_06XX_TICK = 64;
/** Galaga frame: 384 x 264 pixel clocks at 6.144 MHz = 50688 Z80 cycles. */
export const FRAME_Z80 = 50688;
/** Vblank lasts lines 224..263 = 40 lines x 192 Z80 cycles. */
export const VBLANK_Z80 = 40 * 192;

/**
 * @typedef {object} Chip
 * @property {(z80Cycles: number) => number} run
 * @property {(state: number) => void} chipSelect
 * @property {(data: number) => void} write
 * @property {((state: number) => void)=} rw
 * @property {(() => number)=} read
 * @property {((state: number) => void)=} vblank
 * @property {(() => void)=} endTransfer  told when the main CPU writes $10
 */

/** 06XX + Galaga-NMI-handler model. */
export class Bus06 {
  /**
   * @param {object} options
   * @param {Array<Chip|null>} options.chips
   *   chips[0..3] are the four chip-select slots (Galaga: 0 = 51XX, 3 = 54XX).
   * @param {number} [options.nmiLatency]  Z80 cycles from NMI edge to the byte move
   * @param {number} [options.doneLatency] Z80 cycles from NMI edge to the $10 write
   * @param {number|null} [options.frameOrigin]
   *   If set, the screen is simulated: vblank starts at frameOrigin + k *
   *   FRAME_Z80 and ends VBLANK_Z80 later, whatever the bus is doing.
   * @param {(state: number, time: number) => void} [options.onVblank]
   *   Called at each vblank edge (1 = start), BEFORE the chips see it, so a
   *   test can change the inputs for the frame there.
   */
  constructor(options) {
    this.chips = options.chips;
    this.frameOrigin = options.frameOrigin ?? null;
    this.onVblank = options.onVblank ?? (() => {});
    /** Vblank edges already delivered (even = starts, odd = ends). */
    this.edgeIndex = 0;
    this.nmiLatency = options.nmiLatency ?? 30;
    this.doneLatency = options.doneLatency ?? 70;
    /** Current board time in Z80 cycles. */
    this.now = 0;
    this.control = 0;
    /** Every chip-select strobe: {time, control}. For tests to inspect. */
    this.strobes = [];
  }

  /**
   * Run every attached chip up to Z80 time `t`.
   * @param {number} t
   * @returns {void}
   */
  advanceTo(t) {
    // Deliver every vblank edge that falls inside (now, t] at its own time.
    for (let e = this.nextEdge(); e !== null && e <= t; e = this.nextEdge()) {
      this.runChips(e);
      const state = this.edgeIndex % 2 === 0 ? 1 : 0;
      this.edgeIndex += 1;
      this.onVblank(state, e);
      for (const chip of this.chips) if (chip && chip.vblank) chip.vblank(state);
    }
    this.runChips(t);
  }

  /** @returns {number|null} time of the next vblank edge, if simulated */
  nextEdge() {
    if (this.frameOrigin === null) return null;
    const frame = Math.floor(this.edgeIndex / 2);
    return this.frameOrigin + frame * FRAME_Z80 + (this.edgeIndex % 2 ? VBLANK_Z80 : 0);
  }

  /** Start time of the frame whose vblank most recently began. @returns {number} */
  get frameStart() {
    if (this.frameOrigin === null) throw new Error('no frame simulation');
    return this.frameOrigin + Math.floor((this.edgeIndex - 1) / 2) * FRAME_Z80;
  }

  /**
   * @param {number} t
   * @returns {void}
   */
  runChips(t) {
    if (t <= this.now) return;
    const delta = t - this.now;
    for (const chip of this.chips) if (chip) chip.run(delta);
    this.now = t;
  }

  /**
   * Drive all chip selects from the control register and timer state.
   * @param {boolean} timerState
   * @returns {void}
   */
  driveSelects(timerState) {
    for (let n = 0; n < 4; n += 1) {
      const chip = this.chips[n];
      if (chip) chip.chipSelect(((this.control >> n) & 1) && timerState ? 1 : 0);
    }
  }

  /**
   * Perform one complete Galaga-style transfer starting now: write the
   * control register, then let each NMI move one byte until `count` bytes
   * have moved, then write $10.
   * @param {number} control  e.g. 0x71 (read 51XX), 0xA1 (write 51XX), 0xA8 (write 54XX)
   * @param {number[]|number} dataOrCount  bytes to write, or number of bytes to read
   * @returns {number[]} bytes read (empty for writes)
   */
  transfer(control, dataOrCount) {
    const reading = ((control >> 4) & 1) === 1;
    const count = reading ? /** @type {number} */ (dataOrCount) : /** @type {number[]} */ (dataOrCount).length;
    const data = reading ? [] : /** @type {number[]} */ (dataOrCount);
    const divisor = 1 << (control >> 5);
    if (divisor === 1 && (control & 0xe0) === 0) throw new Error('transfer needs a clock divider');
    const half = (Z80_PER_06XX_TICK * divisor) / 2;

    this.control = control;
    let stretch = reading; // first NMI suppressed on reads
    let timerState = false;
    // First timer event at the next 48 kHz tick strictly after now.
    let t = (Math.floor(this.now / Z80_PER_06XX_TICK) + 1) * Z80_PER_06XX_TICK;
    const out = [];
    let moved = 0;

    for (;;) {
      this.advanceTo(t);
      timerState = !timerState;
      // nmi_generate order: rw, then NMI, then chip selects.
      if (timerState) {
        for (const chip of this.chips) if (chip && chip.rw) chip.rw(reading ? 1 : 0);
      }
      const nmi = timerState && !stretch;
      stretch = false;
      this.driveSelects(timerState);
      if (timerState) this.strobes.push({ time: t, control });

      if (nmi) {
        // Galaga's NMI handler moves one byte with `ldi`.
        this.advanceTo(t + this.nmiLatency);
        if (reading) {
          let v = 0xff; // data_r ANDs every selected chip; unmapped reads 0xff
          for (let n = 0; n < 4; n += 1) {
            const chip = this.chips[n];
            if (((control >> n) & 1) && chip && chip.read) v &= chip.read();
          }
          out.push(v);
        } else {
          for (let n = 0; n < 4; n += 1) {
            const chip = this.chips[n];
            if (((control >> n) & 1) && chip) chip.write(data[moved]);
          }
        }
        moved += 1;
        if (moved === count) {
          // ...then `ld (hl),$10`: divider 0 stops the timer, selects drop.
          this.advanceTo(t + this.doneLatency);
          this.control = 0x10;
          this.driveSelects(false);
          for (const chip of this.chips) if (chip && chip.endTransfer) chip.endTransfer();
          return out;
        }
      }
      t += half;
    }
  }
}
