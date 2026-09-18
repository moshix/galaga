// Copyright 2026 by Moshix
/**
 * The Namco WSG (waveform sound generator) as MAME's namco_wsg_device runs
 * it for Galaga (reference/mame/namco.cpp, namco.h).
 *
 * THE CHIP. Three voices, each a 20-bit phase accumulator stepping through
 * one of eight 32-sample 4-bit waveforms (src/audio/waveforms.js), with a
 * 4-bit volume. The CPU writes the low nibble of 32 registers at
 * $6800-$681F (pacman_sound_w's register map):
 *
 *   $05 / $0A / $0F        waveform select of voice 0 / 1 / 2 (3 bits)
 *   $10                    voice 0 only: lowest frequency nibble
 *   $11-$14, $16-$19, $1B-$1E   frequency nibbles 1-4 of voice 0 / 1 / 2
 *   $15 / $1A / $1F        volume of voice 0 / 1 / 2
 *
 * CLOCK. Galaga clocks the WSG at MASTER/6/32 = 96 kHz. MAME's
 * device_clock_changed doubles the clock until it reaches INTERNAL_RATE
 * (192 kHz in this MAME version), adding one fractional bit per doubling:
 * the stream runs at 192,000 samples/s with f_fracbits = 15 + 1 = 16, so
 * the waveform position is (counter >> 16) & 31 and every sample adds the
 * 20-bit frequency to the counter. (At 96 kHz with 15 fraction bits the
 * pitch is identical; MAME's 2x oversampling only refines the steps.)
 *
 * OUTPUT. Each sample is the sum over voices with non-zero volume of
 * (wave - 8) * volume / MIX_RES, MIX_RES = 128 * 3; a voice at volume 0
 * is skipped entirely and its counter does NOT advance. Galaga routes the
 * WSG to the speaker at 0.90 * 10/16 (the resistor path of the WSG is 16k
 * against 10k for the 54XX, galaga.cpp).
 *
 * The frame is exactly 3168 internal samples (304,128 master clocks / 96),
 * 12 per scan line, 16 Z80 cycles each -- so the sound CPU's two register
 * updates per frame (lines 64 and 192) land on exact sample boundaries.
 */

import { WAVEFORMS } from './waveforms.js';
import { BoxResampler } from './resample.js';

/** Galaga's WSG clock: 18.432 MHz / 6 / 32. */
export const WSG_CLOCK = 18432000 / 6 / 32;
/** namco.cpp INTERNAL_RATE: the clock is doubled until it reaches this. */
export const MAME_INTERNAL_RATE = 192000;
/** Stream rate and fraction bits after device_clock_changed. */
export const WSG_RATE = wsgRate().rate;
export const WSG_FRACBITS = wsgRate().fracbits;
/** namco.h MIX_RES = 128 * MAX_VOICES. */
export const MIX_RES = 128 * 3;
/** galaga.cpp: m_namco_sound->add_route(ALL_OUTPUTS, "mono", 0.90 * 10.0 / 16.0). */
export const WSG_GAIN = 0.90 * 10.0 / 16.0;
/** Internal samples per scan line and per frame (264 lines). */
export const SAMPLES_PER_LINE = 12;
export const SAMPLES_PER_FRAME = SAMPLES_PER_LINE * 264;

/**
 * namco_audio_device::device_clock_changed for this clock.
 * @returns {{ rate: number, fracbits: number }}
 */
function wsgRate() {
  let clock = WSG_CLOCK;
  let multiple = 0;
  while (clock < MAME_INTERNAL_RATE) { clock *= 2; multiple += 1; }
  return { rate: clock, fracbits: multiple + 15 };
}

/**
 * The decoded state of the three voices.
 * @typedef {object} WsgVoices
 * @property {Uint32Array} frequency 20-bit phase increments
 * @property {Uint8Array} volume     0-15
 * @property {Uint8Array} waveform   0-7
 */

/**
 * Decode a register snapshot the way pacman_sound_w leaves the voices after
 * those registers were written. (pacman_sound_w recomputes a voice's whole
 * frequency from all its registers on any frequency write, so the result
 * depends only on the final register values.)
 * @param {ArrayLike<number>} regs 32 registers, low nibble used
 * @param {WsgVoices} [out] reused if given
 * @returns {WsgVoices}
 */
export function decodeWsg(regs, out) {
  const v = out ?? {
    frequency: new Uint32Array(3), volume: new Uint8Array(3), waveform: new Uint8Array(3),
  };
  for (let ch = 0; ch < 3; ch += 1) {
    const r = (i) => regs[i] & 0x0f;
    const b = ch * 5;
    v.waveform[ch] = r(0x05 + b) & 7;
    v.frequency[ch] = (ch === 0 ? r(0x10) : 0)
      + (r(0x11 + b) << 4) + (r(0x12 + b) << 8) + (r(0x13 + b) << 12) + (r(0x14 + b) << 16);
    v.volume[ch] = r(0x15 + b);
  }
  return v;
}

/**
 * One stream sample, before the route gain: MAME's namco_update_one summed
 * over the voices, at the current counters.
 * @param {WsgVoices} voices @param {Uint32Array} counter
 * @param {Uint8Array} [wave] waveform PROM (defaults to Galaga's)
 * @returns {number} in [-1, 1)
 */
export function wsgSample(voices, counter, wave = WAVEFORMS) {
  let sum = 0;
  for (let ch = 0; ch < 3; ch += 1) {
    const vol = voices.volume[ch];
    if (vol === 0) continue;
    // waveform_r(select + waveform_position(counter)): low nibble - 8.
    const pos = (voices.waveform[ch] << 5) + ((counter[ch] >>> WSG_FRACBITS) & 0x1f);
    sum += ((wave[pos & 0xff] & 0x0f) - 8) * vol / MIX_RES;
  }
  return sum;
}

/**
 * Advance the counters by one stream sample (voices at volume 0 hold).
 * @param {WsgVoices} voices @param {Uint32Array} counter
 */
export function wsgTick(voices, counter) {
  for (let ch = 0; ch < 3; ch += 1) {
    if (voices.volume[ch] !== 0) counter[ch] = (counter[ch] + voices.frequency[ch]) >>> 0;
  }
}

/**
 * State carried between render calls.
 * @typedef {object} WsgState
 * @property {Uint32Array} counter   the three phase accumulators
 * @property {BoxResampler|null} resampler  stream -> output rate
 * @property {WsgVoices} voices      scratch decode
 */

/** @returns {WsgState} a WSG at power-on (all counters zero) */
export function createWsgState() {
  return {
    counter: new Uint32Array(3),
    resampler: null,
    voices: decodeWsg(new Uint8Array(32)),
  };
}

/**
 * Render `count` samples at `outRate` from one register snapshot, carrying
 * phase and resampler state in `state`. Output = stream samples box-filtered
 * down to the output rate (each output sample is the mean of the 192 kHz
 * samples its interval covers, partial samples weighted), times `gain`.
 * @param {WsgState} state
 * @param {ArrayLike<number>} regs 32 WSG registers
 * @param {Float32Array|number[]} out
 * @param {number} offset @param {number} count
 * @param {number} outRate output sample rate, at most WSG_RATE
 * @param {number} [gain] default WSG_GAIN
 * @returns {void}
 */
export function renderWsg(state, regs, out, offset, count, outRate, gain = WSG_GAIN) {
  if (state.resampler === null || state.resampler.outRate !== outRate) {
    state.resampler = new BoxResampler(WSG_RATE, outRate);
  }
  const rs = state.resampler;
  const v = decodeWsg(regs, state.voices);
  let n = 0;
  while (n < count) {
    if (rs.available > 0) { out[offset + n] = rs.take() * gain; n += 1; continue; }
    rs.push(wsgSample(v, state.counter));
    wsgTick(v, state.counter);
  }
}
