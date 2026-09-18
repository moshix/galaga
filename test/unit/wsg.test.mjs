// Copyright 2026 by Moshix
/**
 * The WSG model (src/audio/wsg.js) against a line-by-line transcription of
 * MAME's namco_wsg_device (reference/mame/namco.cpp): pacman_sound_w,
 * device_clock_changed, namco_update_one and sound_stream_update.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeWsg, wsgSample, wsgTick, createWsgState, renderWsg,
  WSG_RATE, WSG_FRACBITS, WSG_GAIN, MIX_RES, SAMPLES_PER_FRAME,
} from '../../src/audio/wsg.js';
import { WAVEFORMS } from '../../src/audio/waveforms.js';
import { BoxResampler } from '../../src/audio/resample.js';
import { loadGalaga, ROOT } from '../../tools/romset.mjs';
import { renderWaveforms } from '../../tools/gen-sound.mjs';

const PROM = loadGalaga().wave;

/** MAME's namco_wsg_device for Galaga, transcribed. */
class MameWsg {
  constructor(clock) {
    const INTERNAL_RATE = 192000;
    // device_clock_changed
    let namcoClock = clock;
    let clockMultiple = 0;
    for (; namcoClock < INTERNAL_RATE; clockMultiple += 1) namcoClock *= 2;
    this.fracbits = clockMultiple + 15;
    this.sampleRate = namcoClock;
    this.soundregs = new Uint8Array(0x20);
    this.voices = [0, 1, 2].map(() => ({ frequency: 0, counter: 0, volume: 0, waveform_select: 0 }));
  }

  /** namco_wsg_device::pacman_sound_w */
  write(offset, data) {
    data &= 0x0f;
    if (this.soundregs[offset] === data) return;
    this.soundregs[offset] = data;
    let ch;
    // C++ integer division truncates toward zero.
    if (offset < 0x10) ch = Math.trunc((offset - 5) / 5);
    else if (offset === 0x10) ch = 0;
    else ch = Math.trunc((offset - 0x11) / 5);
    // `ch >= MAX_VOICES` with MAX_VOICES unsigned: -1 converts to huge.
    if ((ch >>> 0) >= 3) return;
    const voice = this.voices[ch];
    switch (offset - ch * 5) {
      case 0x05: voice.waveform_select = data & 7; break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14:
        voice.frequency = ch === 0 ? this.soundregs[0x10] : 0;
        voice.frequency += this.soundregs[ch * 5 + 0x11] << 4;
        voice.frequency += this.soundregs[ch * 5 + 0x12] << 8;
        voice.frequency += this.soundregs[ch * 5 + 0x13] << 12;
        voice.frequency += this.soundregs[ch * 5 + 0x14] << 16;
        break;
      case 0x15: voice.volume = data; break;
      default: break;
    }
  }

  /** sound_stream_update + namco_update_one over n samples. */
  update(n) {
    const buf = new Float64Array(n);
    for (const voice of this.voices) {
      const v = voice.volume;
      if (!v) continue;
      const select = voice.waveform_select << 5;
      let counter = voice.counter;
      for (let i = 0; i < n; i += 1) {
        const pos = (counter >> this.fracbits) & 0x1f;
        const waveform = (PROM[(select + pos) & 0xff] & 0x0f) - 8;
        buf[i] += (waveform * v) / MIX_RES;
        counter = (counter + voice.frequency) >>> 0; // uint32_t
      }
      voice.counter = counter;
    }
    return buf;
  }
}

/** Seeded PRNG. @param {number} seed */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('waveforms.js is generated from prom-1.1d and up to date', () => {
  assert.equal(WAVEFORMS.length, 256);
  for (let i = 0; i < 256; i += 1) assert.equal(WAVEFORMS[i], PROM[i] & 0x0f);
  const file = readFileSync(join(ROOT, 'src/audio/waveforms.js'), 'utf8');
  assert.equal(file, renderWaveforms(PROM));
});

test('clock: 96 kHz doubled to 192 kHz, 16 fraction bits; 3168 per frame', () => {
  const mame = new MameWsg(18432000 / 6 / 32);
  assert.equal(WSG_RATE, mame.sampleRate);
  assert.equal(WSG_RATE, 192000);
  assert.equal(WSG_FRACBITS, mame.fracbits);
  // 384 x 264 pixels at 6.144 MHz per frame.
  assert.equal(SAMPLES_PER_FRAME, (384 * 264 / (18432000 / 3)) * WSG_RATE);
});

test('register decoding matches pacman_sound_w for random write streams', () => {
  const r = rng(1);
  const mame = new MameWsg(96000);
  const regs = new Uint8Array(32);
  for (let i = 0; i < 20000; i += 1) {
    const off = Math.floor(r() * 32);
    const val = Math.floor(r() * 256);
    mame.write(off, val);
    regs[off] = val & 0x0f;
    const v = decodeWsg(regs);
    for (let ch = 0; ch < 3; ch += 1) {
      assert.equal(v.frequency[ch], mame.voices[ch].frequency);
      assert.equal(v.volume[ch], mame.voices[ch].volume);
      assert.equal(v.waveform[ch], mame.voices[ch].waveform_select);
    }
  }
});

test('stream samples match MAME exactly at 192 kHz, state carried', () => {
  const r = rng(2);
  const mame = new MameWsg(96000);
  const state = createWsgState();
  const regs = new Uint8Array(32);
  for (let round = 0; round < 300; round += 1) {
    // A few register writes, as the sound CPU would make.
    for (let k = 0; k < 6; k += 1) {
      const off = 0x05 + Math.floor(r() * 27);
      const val = Math.floor(r() * 16);
      mame.write(off, val);
      regs[off] = val;
    }
    // Sometimes silence a voice (its counter must freeze).
    if (r() < 0.2) { const off = [0x15, 0x1a, 0x1f][Math.floor(r() * 3)]; mame.write(off, 0); regs[off] = 0; }
    const n = 1 + Math.floor(r() * 700);
    const want = mame.update(n);
    const got = new Float32Array(n);
    renderWsg(state, regs, got, 0, n, WSG_RATE, 1);
    for (let i = 0; i < n; i += 1) assert.ok(Math.abs(got[i] - want[i]) < 1e-6, `round ${round} sample ${i}`);
    for (let ch = 0; ch < 3; ch += 1) assert.equal(state.counter[ch], mame.voices[ch].counter);
  }
});

test('at 48 kHz each output is the mean of 4 MAME samples, times the route gain', () => {
  const mame = new MameWsg(96000);
  const state = createWsgState();
  const regs = new Uint8Array(32);
  const set = (o, v) => { mame.write(o, v); regs[o] = v; };
  set(0x05, 3); set(0x12, 0x9); set(0x13, 0x2); set(0x15, 0xc); // voice 0
  set(0x0a, 5); set(0x17, 0x4); set(0x18, 0x1); set(0x1a, 0x7); // voice 1
  const want = mame.update(4000 * 4);
  const got = new Float32Array(4000);
  renderWsg(state, regs, got, 0, 4000, 48000);
  for (let i = 0; i < 4000; i += 1) {
    const mean = (want[4 * i] + want[4 * i + 1] + want[4 * i + 2] + want[4 * i + 3]) / 4;
    assert.ok(Math.abs(got[i] - mean * WSG_GAIN) < 1e-6, `sample ${i}`);
  }
  assert.ok(got.some((x) => x !== 0));
});

test('rendering in chunks equals rendering at once (44.1 kHz)', () => {
  const regs = new Uint8Array(32);
  regs[0x05] = 1; regs[0x11] = 7; regs[0x12] = 3; regs[0x13] = 1; regs[0x15] = 15;
  const whole = new Float32Array(5000);
  renderWsg(createWsgState(), regs, whole, 0, 5000, 44100);
  const parts = new Float32Array(5000);
  const st = createWsgState();
  const r = rng(3);
  for (let off = 0; off < 5000;) {
    const n = Math.min(5000 - off, 1 + Math.floor(r() * 300));
    renderWsg(st, regs, parts, off, n, 44100);
    off += n;
  }
  assert.deepEqual(parts, whole);
});

test('a voice at volume 0 is silent and its phase holds', () => {
  const regs = new Uint8Array(32);
  regs[0x16] = 5; regs[0x17] = 5; // voice 1 frequency, volume 0
  const v = decodeWsg(regs);
  const c = new Uint32Array(3);
  for (let i = 0; i < 100; i += 1) { assert.equal(wsgSample(v, c), 0); wsgTick(v, c); }
  assert.deepEqual([...c], [0, 0, 0]);
});

test('box resampler conserves the mean and handles non-integer ratios', () => {
  const rs = new BoxResampler(192000, 44100);
  let inSum = 0;
  let outSum = 0;
  let outs = 0;
  const r = rng(4);
  for (let i = 0; i < 192000; i += 1) {
    const x = r() * 2 - 1;
    inSum += x;
    rs.push(x);
    while (rs.available > 0) { outSum += rs.take(); outs += 1; }
  }
  // One second in, one second out (the last slice may still be open by a
  // rounding hair).
  assert.ok(Math.abs(outs - 44100) <= 1, `${outs} outputs`);
  // Each output is an average over `step` inputs, so sum(out) * step plus
  // the open slice's partial sum equals sum(in).
  assert.ok(Math.abs(outSum * (192000 / 44100) + rs.acc - inSum) < 1e-6);
});
