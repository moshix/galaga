// Copyright 2026 by Moshix
/**
 * The 54XX discrete-network approximation (src/audio/n54filter.js) and the
 * 54XX frame driver (src/audio/n54voice.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  N54Filter, N54_CHANNELS, N54_DAC_R, N54_VREF, mfbBandPass, n54Dac,
} from '../../src/audio/n54filter.js';
import { N54Voice, N54_BYTE_SAMPLES, N54_SELECT_SAMPLES } from '../../src/audio/n54voice.js';
import { WSG_RATE, SAMPLES_PER_FRAME } from '../../src/audio/wsg.js';
import { loadGalaga } from '../../tools/romset.mjs';
import { Namco54 } from '../../src/machine/namco54.js';
import { MCU54_ROM } from '../../src/audio/mcu54rom.js';

/** RMS of an array. @param {ArrayLike<number>} a */
const rms = (a) => Math.sqrt(Array.from(a).reduce((s, x) => s + x * x, 0) / a.length);

test('constants follow galaga_a.cpp', () => {
  assert.ok(Math.abs(N54_DAC_R - 1 / (1 / 47e3 + 1 / 22e3 + 1 / 10e3 + 1 / 4.7e3)) < 1e-9);
  assert.ok(Math.abs(N54_VREF - 2) < 1e-12);
  assert.equal(n54Dac(0), 0);
  assert.ok(Math.abs(n54Dac(15) - 4) < 1e-12);
  // The ladder is monotonic in the 4-bit value.
  for (let v = 1; v < 16; v += 1) assert.ok(n54Dac(v) > n54Dac(v - 1));
});

test('band-pass centres, Q and gain match the MFB formulas', () => {
  // Hand-computed from the component values (see n54filter.js header).
  const want = [[167, 2.47, 1.54], [450, 2.12, 1.51], [2521, 1.74, 1.07]];
  N54_CHANNELS.forEach((p, i) => {
    const c = mfbBandPass(p, WSG_RATE);
    assert.ok(Math.abs(c.f0 / want[i][0] - 1) < 0.01, `f0 ${c.f0}`);
    assert.ok(Math.abs(c.q / want[i][1] - 1) < 0.01, `q ${c.q}`);
    assert.ok(Math.abs(c.gain / want[i][2] - 1) < 0.01, `gain ${c.gain}`);
    // Poles inside the unit circle: |a2| < 1 and |a1| < 1 + a2.
    assert.ok(Math.abs(c.a2) < 1 && Math.abs(c.a1) < 1 + c.a2);
  });
});

test('digital response peaks at the analogue centre frequency', () => {
  for (const p of N54_CHANNELS) {
    const c = mfbBandPass(p, WSG_RATE);
    const mag = (f) => {
      const w = (2 * Math.PI * f) / WSG_RATE;
      // |b0 + b2 e^-2jw| / |1 + a1 e^-jw + a2 e^-2jw|
      const nr = c.b0 + c.b2 * Math.cos(2 * w);
      const ni = -c.b2 * Math.sin(2 * w);
      const dr = 1 + c.a1 * Math.cos(w) + c.a2 * Math.cos(2 * w);
      const di = -c.a1 * Math.sin(w) - c.a2 * Math.sin(2 * w);
      return Math.hypot(nr, ni) / Math.hypot(dr, di);
    };
    assert.ok(Math.abs(mag(c.f0) - c.gain) < 1e-6 * c.gain);
    assert.ok(mag(c.f0 / 4) < c.gain / 2 && mag(c.f0 * 4) < c.gain / 2);
  }
});

test('toggling each channel produces sound; holding it still decays to silence', () => {
  for (let ch = 0; ch < 3; ch += 1) {
    const f = new N54Filter();
    const f0 = mfbBandPass(N54_CHANNELS[ch], WSG_RATE).f0;
    // Square wave near the channel's centre, full scale.
    const half = Math.round(WSG_RATE / f0 / 2);
    const out = new Float64Array(WSG_RATE / 4);
    for (let i = 0; i < out.length; i += 1) {
      f.set(ch, Math.floor(i / half) % 2 ? 15 : 0);
      out[i] = f.sample();
    }
    const loud = rms(out.subarray(out.length / 2));
    assert.ok(loud > 0.02, `channel ${ch} rms ${loud}`);
    assert.ok(loud < 2, `channel ${ch} rms ${loud}`);
    // Then hold a constant level: DC is blocked, the output dies away.
    f.set(ch, 9);
    const tail = new Float64Array(WSG_RATE);
    for (let i = 0; i < tail.length; i += 1) tail[i] = f.sample();
    assert.ok(rms(tail.subarray(tail.length - 1000)) < 1e-4, `channel ${ch} tail`);
  }
});

test('stable under random input: bounded, finite, and settles', () => {
  const f = new N54Filter();
  let s = 1;
  let peak = 0;
  for (let i = 0; i < WSG_RATE * 2; i += 1) {
    if (i % 7 === 0) {
      s = (s * 1103515245 + 12345) >>> 0;
      f.set((s >>> 8) % 3, (s >>> 16) & 15);
    }
    const y = f.sample();
    assert.ok(Number.isFinite(y));
    peak = Math.max(peak, Math.abs(y));
  }
  assert.ok(peak < 3, `peak ${peak}`);
  for (let ch = 0; ch < 3; ch += 1) f.set(ch, 0);
  let last = 0;
  for (let i = 0; i < WSG_RATE; i += 1) last = f.sample();
  assert.ok(Math.abs(last) < 1e-4);
});

/** A stand-in 54XX that records the bus protocol and echoes its command. */
class FakeChip {
  constructor() { this.log = []; this.t = 0; this.latched = 0; this.onOutput = () => {}; }
  write(b) { this.latched = b; this.log.push(['w', this.t, b]); }
  chipSelect(s) {
    this.log.push(['cs', this.t, s]);
    // Echo the byte on an output so the timestamping can be checked.
    if (s) this.onOutput(this.latched % 3, this.latched & 15, 0);
  }
  run(c) { this.t += c; }
  reset(s) { this.log.push(['reset', this.t, s]); }
}

test('N54Voice replays bytes at the 06XX $A8 rate with select pulses', () => {
  const chip = new FakeChip();
  const v = new N54Voice(chip);
  v.setRunning(1);
  for (const b of [0x31, 0x42, 0x53]) v.write(b);
  const ev = v.runFrame();
  const writes = chip.log.filter((e) => e[0] === 'w');
  assert.deepEqual(writes.map((e) => e[2]), [0x31, 0x42, 0x53]);
  // 2048 Z80 cycles apart; select high for the first 1024.
  assert.deepEqual(writes.map((e) => e[1]), [0, 2048, 4096]);
  const cs = chip.log.filter((e) => e[0] === 'cs');
  assert.deepEqual(cs.map((e) => [e[1], e[2]]), [[0, 1], [1024, 0], [2048, 1], [3072, 0], [4096, 1], [5120, 0]]);
  assert.equal(N54_BYTE_SAMPLES, 128);
  assert.equal(N54_SELECT_SAMPLES, 64);
  // Output changes are stamped with their stream sample.
  assert.deepEqual([...ev].map((e) => e >>> 8), [0, 128, 256]);
  assert.equal(v.runFrame().length, 0);
});

test('mcu54rom.js is 54xx.bin', () => {
  assert.deepEqual([...MCU54_ROM], [...loadGalaga().mcu54]);
});

// The real MB8844 54XX (src/machine/namco54.js): after the parameter block
// the main CPU sends at boot ($35B3, 12 bytes), the fighter-hit command its
// NMI sends ($0092, src/game/io.js) must make noise through the filter.
test('real 54XX: boot parameters + explosion command make filtered noise', () => {
  const roms = loadGalaga();
  const chip = new Namco54({ rom: MCU54_ROM });
  const voice = new N54Voice(chip);
  voice.setRunning(0);
  voice.setRunning(1);
  // Let the MCU boot, then configure it as the main CPU does ($3604).
  for (let i = 0; i < 4; i += 1) voice.runFrame();
  for (let i = 0; i < 12; i += 1) voice.write(roms.main[0x35b3 + i]);
  for (let i = 0; i < 20; i += 1) voice.runFrame();
  for (let i = 0; i < 4; i += 1) voice.write(roms.main[0x0092 + i]);
  const filter = new N54Filter();
  const out = [];
  let changes = 0;
  for (let frame = 0; frame < 60; frame += 1) {
    const ev = voice.runFrame();
    changes += ev.length;
    let k = 0;
    for (let i = 0; i < SAMPLES_PER_FRAME; i += 1) {
      while (k < ev.length && (ev[k] >>> 8) <= i) { filter.set((ev[k] >> 4) & 15, ev[k] & 15); k += 1; }
      out.push(filter.sample());
    }
  }
  assert.ok(changes > 50, `only ${changes} output changes`);
  assert.ok(rms(out) > 0.005, `rms ${rms(out)}`);
});
