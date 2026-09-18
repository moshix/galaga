// Copyright 2026 by Moshix
/**
 * Namco 51XX custom I/O chip: an MB8843 running the real 51xx.bin, wired the
 * way MAME's namco_51xx_device wires it (reference/mame/namco51.cpp).
 *
 * Pins, as seen from the MCU:
 *   K3     = R/W line from the 06XX (1 = the host is reading)
 *   K2-K0  = low 3 bits of the data latch (so commands/arguments are 3-bit)
 *   R0-R3  = the four input nibbles (on Galaga: IN0 lo/hi, IN1 lo/hi;
 *            all active low)
 *   O7-O0  = data latch the host reads back (the same latch the host writes)
 *   P3-P0  = lamps and coin counters (Galaga: galaga_state::out)
 *   /IRQ   = 06XX chip select for this chip
 *   /TC    = vblank (the program counts frames on the timer)
 *
 * MAME defers rw(), write() and O_w() with scheduler().synchronize(). Our
 * board interleaves the CPUs in small slices and calls these at the right
 * moment itself, so they are applied immediately.
 *
 * Clocking: the chip is fed MASTER_CLOCK/6/2 = 1.536 MHz and the MB88 divides
 * by 6 internally, i.e. 256,000 machine cycles per second. The Z80s run at
 * 3.072 MHz, so one MB88 machine cycle is exactly 12 Z80 cycles.
 */
import { MB88 } from '../../src/machine/mb88.js';

/** Z80 cycles per MB88 machine cycle (3.072 MHz / (1.536 MHz / 6)). */
export const Z80_CYCLES_PER_MCU_CYCLE = 12;

/**
 * @typedef {object} Namco51Options
 * @property {Uint8Array} rom   51xx.bin (1 KB)
 * @property {Array<() => number>} [in]
 *   Four input callbacks returning nibbles, MAME's input_callback<0..3>.
 *   For Galaga: in0 = IN0 & 0x0F, in1 = IN0 >> 4, in2 = IN1 & 0x0F,
 *   in3 = IN1 >> 4 (active low: 1 = released).
 * @property {(data: number) => void} [onOutput]  P port writes (output_callback)
 * @property {(state: number) => void} [onLockout]
 *   lockout_callback. MAME binds it but the 51xx device never calls it
 *   (the MB88 core has no serial output), so neither do we. Kept for API
 *   parity.
 */

/** The 51XX device. */
export class Namco51 {
  /** @param {Namco51Options} options */
  constructor(options) {
    const inputs = options.in ?? [];
    /** @type {Array<() => number>} */
    this.in = [0, 1, 2, 3].map((n) => inputs[n] ?? (() => 0x0f));
    this.onOutput = options.onOutput ?? (() => {});
    this.onLockout = options.onLockout ?? (() => {});
    /** m_portO: the data latch shared by host writes and MCU O-port writes. */
    this.portO = 0;
    /** m_rw: last R/W level driven by the 06XX (1 = read). */
    this.rwState = 0;
    /** Z80 cycles owed to the MCU that did not add up to a whole MB88 cycle. */
    this.z80Remainder = 0;

    this.mcu = new MB88({
      rom: options.rom,
      variant: 'mb8843',
      // K_r: (m_rw << 3) | (m_portO & 0x07)
      readK: () => (this.rwState << 3) | (this.portO & 0x07),
      // R_r<N>: m_in[N]()
      readR: (n) => this.in[n]() & 0x0f,
      // O_w: the whole O latch lands in m_portO
      writeO: (value) => { this.portO = value & 0xff; },
      // P_w: m_out(data)
      writeP: (value) => this.onOutput(value & 0x0f),
    });
  }

  /**
   * /RESET input, active low as in MAME: reset(0) holds the MCU in reset,
   * reset(1) releases it (and the MCU restarts from $000).
   * @param {number|boolean} state
   * @returns {void}
   */
  reset(state) {
    this.mcu.setResetLine(!state);
  }

  /**
   * Vblank level from the screen (1 = in vblank). The MCU timer counts on
   * falling edges of /TC, which is vblank inverted -- so TL ticks at the
   * START of vblank.
   * @param {number|boolean} state
   * @returns {void}
   */
  vblank(state) {
    this.mcu.setTcLine(!state);
  }

  /**
   * R/W line from the 06XX (1 = host reads).
   * @param {number|boolean} state
   * @returns {void}
   */
  rw(state) {
    this.rwState = state ? 1 : 0;
  }

  /**
   * Chip select from the 06XX; drives the MCU's /IRQ (logical 1 = asserted).
   * @param {number|boolean} state
   * @returns {void}
   */
  chipSelect(state) {
    this.mcu.setIrqLine(state ? 1 : 0);
  }

  /** Host read of the data latch. @returns {number} */
  read() {
    return this.portO;
  }

  /**
   * Host write of the data latch.
   * @param {number} data
   * @returns {void}
   */
  write(data) {
    this.portO = data & 0xff;
  }

  /**
   * Advance the MCU by `z80Cycles` of Z80 time (12 Z80 cycles per MB88
   * cycle). Fractions of an MB88 cycle are carried to the next call, and so
   * is the MB88's own instruction overrun (see MB88.run).
   * @param {number} z80Cycles
   * @returns {number} MB88 machine cycles consumed
   */
  run(z80Cycles) {
    const total = this.z80Remainder + z80Cycles;
    const mcuCycles = Math.floor(total / Z80_CYCLES_PER_MCU_CYCLE);
    this.z80Remainder = total - mcuCycles * Z80_CYCLES_PER_MCU_CYCLE;
    return this.mcu.run(mcuCycles);
  }

  /** The MCU's local time, in Z80 cycles. @returns {number} */
  get timeZ80() {
    return this.mcu.cycles * Z80_CYCLES_PER_MCU_CYCLE;
  }
}
