// Copyright 2026 by Moshix
/**
 * Drives a low-level 54XX (an MB8844 emulation such as test/mcu/namco54.mjs)
 * frame by frame, and turns its output writes into timed changes for the
 * mixer (src/audio/mixer.js).
 *
 * The port's IoBus hands over a whole 06XX transfer at once
 * (src/game/io.js), but the MB8844 reads the latched byte only when its
 * /IRQ (the 06XX chip select) is pulsed, one byte per pulse. So bytes are
 * queued here and replayed with the 06XX's timing for the command the game
 * uses ($A8: clock divider 32 -> one byte every 2048 Z80 cycles, chip
 * select high for the first half of each period; namco06.cpp).
 *
 * The chip runs in steps of one 192 kHz stream sample (16 Z80 cycles), so
 * every output change is placed on the stream sample it happened in.
 */

import { SAMPLES_PER_FRAME } from './wsg.js';
import { packN54 } from './mixer.js';

/** Z80 cycles per stream sample (3.072 MHz / 192 kHz). */
export const Z80_PER_SAMPLE = 16;
/** 06XX byte period and chip-select width for control $A8, in samples. */
export const N54_BYTE_SAMPLES = 2048 / Z80_PER_SAMPLE;
export const N54_SELECT_SAMPLES = N54_BYTE_SAMPLES / 2;

/**
 * What a 54XX implementation must provide (test/mcu/namco54.mjs does).
 * @typedef {object} N54Chip
 * @property {(byte: number) => void} write          latch a command byte
 * @property {(state: number) => void} chipSelect    06XX chip select -> /IRQ
 * @property {(z80Cycles: number) => unknown} run    advance the MCU
 * @property {((state: number) => void)=} reset      /RESET (1 = run)
 * @property {(channel: number, value: number, time: number) => void} onOutput
 *   assigned by N54Voice; the chip calls it on every output write
 */

export class N54Voice {
  /** @param {N54Chip} chip */
  constructor(chip) {
    this.chip = chip;
    /** @type {number[]} bytes waiting for their 06XX slot */
    this.pending = [];
    /** Samples until the current byte's select ends / its slot ends. */
    this.selectLeft = 0;
    this.slotLeft = 0;
    /** Last value of each output, to report changes only. */
    this.level = [0, 0, 0];
    /** Stream sample being run, for timestamps. */
    this.index = 0;
    /** @type {number[]} changes this frame */
    this.events = [];
    this.running = -1;
    chip.onOutput = (channel, value) => {
      if (this.level[channel] === value) return;
      this.level[channel] = value;
      this.events.push(packN54(this.index, channel, value));
    };
  }

  /** @param {number} byte from the 06XX (IoBus n54.write) */
  write(byte) {
    this.pending.push(byte & 0xff);
  }

  /**
   * Latch Q3 ($6823): the 54XX is held in reset with the sub CPUs.
   * @param {number} bit
   */
  setRunning(bit) {
    if (bit === this.running) return;
    this.running = bit;
    this.chip.reset?.(bit);
    if (!bit) { this.pending.length = 0; this.selectLeft = 0; this.slotLeft = 0; }
  }

  /**
   * Run one video frame and return its output changes.
   * @returns {Uint32Array} packed (index, channel, value), in time order
   */
  runFrame() {
    this.events = [];
    for (let i = 0; i < SAMPLES_PER_FRAME; i += 1) {
      this.index = i;
      if (this.slotLeft === 0 && this.pending.length > 0) {
        // namco06 write: latch the byte, then chip select on the timer's
        // high half-period.
        this.chip.write(/** @type {number} */ (this.pending.shift()));
        this.chip.chipSelect(1);
        this.selectLeft = N54_SELECT_SAMPLES;
        this.slotLeft = N54_BYTE_SAMPLES;
      }
      this.chip.run(Z80_PER_SAMPLE);
      if (this.selectLeft > 0 && --this.selectLeft === 0) this.chip.chipSelect(0);
      if (this.slotLeft > 0) this.slotLeft -= 1;
    }
    return Uint32Array.from(this.events);
  }
}
