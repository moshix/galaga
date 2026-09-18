// Copyright 2026 by Moshix
/**
 * GENERATED FILE -- do not edit by hand.
 * Run `node tools/gen-sound.mjs` to regenerate.
 *
 * The Namco WSG's eight waveforms, from the Galaga sound PROM prom-1.1d:
 * 32 steps each, 4-bit unsigned (0-15; the chip plays them as value - 8).
 * Waveform n occupies entries n*32 .. n*32+31, the same addressing MAME
 * uses ((select << 5) + position).
 */

/** Number of waveforms and steps per waveform. */
export const WAVE_COUNT = 8;
export const WAVE_STEPS = 32;

/** @type {Uint8Array} 256 entries, low nibble of each PROM byte. */
export const WAVEFORMS = Uint8Array.from([
  // waveform 0
   7, 9,10,11,12,13,13,14,14,14,13,13,12,11,10, 9,
   7, 5, 4, 3, 2, 1, 1, 0, 0, 0, 1, 1, 2, 3, 4, 5,
  // waveform 1
   7, 9,10,11, 7,13,13, 7,14, 7,13,13, 7,11,10, 9,
   7, 5, 7, 3, 7, 1, 7, 0, 7, 0, 7, 1, 7, 3, 7, 5,
  // waveform 2
  14,14,14,14,14,14,14,14,14,14,14,14,14,14,14,14,
   0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  // waveform 3
  11,13,14,13,12,10, 8, 8, 8,10,12,13,14,13,11, 8,
   4, 2, 1, 2, 3, 5, 7, 7, 7, 5, 3, 2, 1, 2, 4, 7,
  // waveform 4
   7,10,12,13,14,13,12,10, 7, 4, 2, 1, 0, 1, 2, 4,
   7,11,13,14,13,11, 7, 3, 1, 0, 1, 3, 7,14, 7, 0,
  // waveform 5
   7,14,12, 9,12,14,10, 7,12,15,13, 8,10,11, 7, 2,
   8,13, 9, 4, 5, 7, 2, 0, 3, 8, 5, 1, 3, 6, 3, 1,
  // waveform 6
   7, 8,10,12,14,13,12,12,11,10, 8, 7, 5, 6, 7, 8,
   8, 9,10,11, 9, 8, 6, 5, 4, 4, 3, 2, 4, 6, 8, 9,
  // waveform 7
  10,12,12,10, 7, 7, 8,11,13,14,13,10, 6, 5, 5, 7,
   9, 9, 8, 4, 1, 0, 1, 3, 6, 7, 7, 4, 2, 2, 4, 7,
]);
