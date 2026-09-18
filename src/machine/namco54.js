// Copyright 2026 by Moshix
/**
 * Namco 54XX explosion/noise generator: an MB8844 running the real
 * 54xx.bin, wired as MAME's namco_54xx_device (reference/mame/namco54.cpp).
 *
 * Pins, as seen from the MCU:
 *   K3-K0 = command high nibble,  R0 = command low nibble  (latched byte)
 *   O3-O0 = sound channel 0,  O7-O4 = sound channel 1,  R1 = sound channel 2
 *   /IRQ  = 06XX chip select
 *
 * MAME sends the three 4-bit channels to the discrete sound network
 * (NAMCO_54XX_0/1/2_DATA). Here every write is reported through
 * `onOutput(channel, value, timeZ80)` so the audio layer can synthesize the
 * noise later; timeZ80 is the MCU's local clock converted to Z80 cycles
 * (MB88 cycles x 12), counted from construction, taken at the start of the
 * instruction that wrote.
 *
 * MAME defers write() with scheduler().synchronize(); our board interleaves
 * CPUs in small slices, so it is applied immediately.
 *
 * Clock: 1.536 MHz / 6 = 256,000 MB88 cycles per second = 12 Z80 cycles each.
 */
import { MB88 } from './mb88.js';
/** One MB88 machine cycle is 12 Z80 cycles (1.536 MHz / 6 vs 3.072 MHz). */
const Z80_CYCLES_PER_MCU_CYCLE = 12;

/**
 * @typedef {object} Namco54Options
 * @property {Uint8Array} rom  54xx.bin (1 KB)
 * @property {(channel: number, value: number, timeZ80: number) => void} [onOutput]
 *   channel 0 = O low nibble, 1 = O high nibble, 2 = R1
 */

/** The 54XX device. */
export class Namco54 {
  /** @param {Namco54Options} options */
  constructor(options) {
    this.onOutput = options.onOutput ?? (() => {});
    /** m_latched_cmd: last byte written by the host. */
    this.latchedCmd = 0;
    this.z80Remainder = 0;
    /** Last value of each channel, for inspection. */
    this.channels = [0, 0, 0];

    this.mcu = new MB88({
      rom: options.rom,
      variant: 'mb8844',
      readK: () => this.latchedCmd >> 4, // K_r
      readR: (n) => (n === 0 ? this.latchedCmd & 0x0f : 0), // R0_r; others unmapped
      writeO: (value, mask) => {
        // O_w: the PLA mask tells which nibble the program just wrote.
        if (mask === 0x0f) this.emit(0, value & 0x0f);
        else this.emit(1, value >> 4);
      },
      writeR: (n, value) => {
        if (n === 1) this.emit(2, value & 0x0f); // R1_w; other R ports unconnected
      },
    });
  }

  /**
   * @param {number} channel @param {number} value
   * @returns {void}
   */
  emit(channel, value) {
    this.channels[channel] = value;
    this.onOutput(channel, value, this.mcu.cycles * Z80_CYCLES_PER_MCU_CYCLE);
  }

  /**
   * /RESET input, active low (reset(0) holds the MCU, reset(1) releases it).
   * @param {number|boolean} state
   * @returns {void}
   */
  reset(state) {
    this.mcu.setResetLine(!state);
  }

  /**
   * Chip select from the 06XX -> MCU /IRQ.
   * @param {number|boolean} state
   * @returns {void}
   */
  chipSelect(state) {
    this.mcu.setIrqLine(state ? 1 : 0);
  }

  /**
   * Host write: latch the command/parameter byte.
   * @param {number} data
   * @returns {void}
   */
  write(data) {
    this.latchedCmd = data & 0xff;
  }

  /**
   * Advance by `z80Cycles` of Z80 time; fractions and overrun are carried.
   * @param {number} z80Cycles
   * @returns {number} MB88 machine cycles consumed
   */
  run(z80Cycles) {
    const total = this.z80Remainder + z80Cycles;
    const mcuCycles = Math.floor(total / Z80_CYCLES_PER_MCU_CYCLE);
    this.z80Remainder = total - mcuCycles * Z80_CYCLES_PER_MCU_CYCLE;
    return this.mcu.run(mcuCycles);
  }
}
