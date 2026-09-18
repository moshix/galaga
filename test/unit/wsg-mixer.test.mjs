// Copyright 2026 by Moshix
/**
 * The frame mixer (src/audio/mixer.js) and the SoundEngine's register
 * capture (src/audio/sound.js), without WebAudio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GalagaMixer, SEGMENT_A, packN54 } from '../../src/audio/mixer.js';
import { createWsgState, renderWsg, SAMPLES_PER_FRAME } from '../../src/audio/wsg.js';
import { SoundEngine } from '../../src/audio/sound.js';
import { Machine } from '../../src/machine/machine.js';
import '../../src/game/sound/index.js';
import { SOUND } from '../../src/game/sound/routines.js';

/** Output samples per frame at 48 kHz (3168 / 4). */
const OUT = SAMPLES_PER_FRAME / 4;

/** A register image with voice 0 playing. @param {number} vol */
function tone(vol) {
  const r = new Uint8Array(32);
  r[0x05] = 2; r[0x12] = 0x8; r[0x13] = 0x1; r[0x15] = vol;
  return r;
}

test('image A plays from line 64, image B from line 192', () => {
  const mx = new GalagaMixer(48000, { targetFrames: 1 });
  const a = tone(15);
  const b = new Uint8Array(32);
  mx.push({ a, b, n54: null });
  const out = new Float32Array(OUT);
  mx.render(out, 0, OUT);
  // Reference: the WSG model fed A for 1536 stream samples, then B.
  const st = createWsgState();
  const ref = new Float32Array(OUT);
  renderWsg(st, a, ref, 0, SEGMENT_A / 4, 48000);
  renderWsg(st, b, ref, SEGMENT_A / 4, OUT - SEGMENT_A / 4, 48000);
  for (let i = 0; i < OUT; i += 1) assert.ok(Math.abs(out[i] - ref[i]) < 1e-6, `sample ${i}`);
  assert.ok(out.subarray(0, SEGMENT_A / 4).some((x) => x !== 0));
  assert.ok(out.subarray(SEGMENT_A / 4).every((x) => x === 0));
});

test('a late frame holds the last registers seamlessly', () => {
  const mx = new GalagaMixer(48000, { targetFrames: 1 });
  const a = tone(9);
  mx.push({ a, b: a, n54: null });
  // Three frames of output from one frame of input.
  const out = new Float32Array(3 * OUT);
  mx.render(out, 0, 3 * OUT);
  const ref = new Float32Array(3 * OUT);
  renderWsg(createWsgState(), a, ref, 0, 3 * OUT, 48000);
  for (let i = 0; i < ref.length; i += 1) assert.ok(Math.abs(out[i] - ref[i]) < 1e-6, `sample ${i}`);
  assert.ok(mx.stats.held >= 1);
});

test('priming, queue trimming, and pause', () => {
  const mx = new GalagaMixer(48000, { targetFrames: 2, maxFrames: 6 });
  const out = new Float32Array(OUT);
  mx.push({ a: tone(15), b: tone(15), n54: null });
  // One frame queued, target 2: still priming -> silence (registers at 0).
  mx.render(out, 0, OUT);
  assert.ok(out.every((x) => x === 0));
  for (let i = 0; i < 10; i += 1) mx.push({ a: tone(15), b: tone(15), n54: null });
  assert.ok(mx.queue.length <= 6);
  assert.ok(mx.stats.dropped > 0);
  mx.setPaused(true);
  mx.push({ a: tone(15), b: tone(15), n54: null });
  out.fill(1);
  mx.render(out, 0, OUT);
  assert.ok(out.every((x) => x === 0));
  assert.equal(mx.queue.length, 0);
  mx.setPaused(false);
  assert.equal(mx.priming, true);
});

test('54XX changes are applied at their stream sample and heard', () => {
  const mx = new GalagaMixer(48000, { targetFrames: 1 });
  const z = new Uint8Array(32);
  const ev = [];
  // Toggle 54XX channel 2 (CHANL1, 2.5 kHz band) every 38 stream samples.
  for (let i = 0; i < SAMPLES_PER_FRAME; i += 38) ev.push(packN54(i, 2, (i / 38) % 2 ? 0 : 15));
  mx.push({ a: z, b: z, n54: Uint32Array.from(ev) });
  const out = new Float32Array(OUT);
  mx.render(out, 0, OUT);
  const rms = Math.sqrt(out.reduce((s, x) => s + x * x, 0) / OUT);
  assert.ok(rms > 0.01, `rms ${rms}`);
});

test('SoundEngine captures both NMI images per frame and posts them', () => {
  const engine = new SoundEngine();
  engine.attach54xx(null);
  const m = new Machine();
  /** @type {unknown[]} */
  const posted = [];
  // Stand-in for the AudioWorkletNode; the engine only uses port.postMessage.
  engine.node = /** @type {AudioWorkletNode} */ (/** @type {unknown} */ ({
    port: { postMessage: (msg) => posted.push(msg) },
  }));
  engine.ready = true;
  engine.update(m); // installs the hook (no NMI yet: registers held)
  m.poke(0x9aab, 1); // start-of-game theme
  for (let f = 0; f < 30; f += 1) {
    SOUND.sound_nmi(m);
    const a = m.wsg.slice();
    SOUND.sound_nmi(m);
    const b = m.wsg.slice();
    engine.update(m);
    const msg = /** @type {{type: string, a: Uint8Array, b: Uint8Array}} */ (posted[posted.length - 1]);
    assert.equal(msg.type, 'frame');
    assert.deepEqual([...msg.a], [...a]);
    assert.deepEqual([...msg.b], [...b]);
  }
  assert.equal(posted.length, 31);
  // Paused: nothing is posted.
  engine.setPaused(true);
  SOUND.sound_nmi(m);
  engine.update(m);
  // One 'pause' message to the worklet, and no frame.
  assert.equal(posted.length, 32);
  assert.equal(/** @type {{type: string}} */ (posted[31]).type, 'pause');
});

test('wsg-worklet.js registers a processor that renders frames', async () => {
  /** @type {Record<string, unknown>} */
  const g = globalThis;
  let Proc = null;
  // The AudioWorkletGlobalScope names the module relies on.
  g.sampleRate = 48000;
  g.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null }; } };
  g.registerProcessor = (name, ctor) => { assert.equal(name, 'galaga-sound'); Proc = ctor; };
  try {
    await import('../../src/audio/wsg-worklet.js');
    assert.ok(Proc !== null);
    const p = new Proc();
    const a = tone(12);
    for (let i = 0; i < 3; i += 1) p.port.onmessage({ data: { type: 'frame', a, b: a, n54: null } });
    const outputs = [[new Float32Array(128), new Float32Array(128)]];
    let heard = false;
    for (let i = 0; i < 20; i += 1) {
      assert.equal(p.process([], outputs), true);
      assert.deepEqual(outputs[0][1], outputs[0][0]);
      heard ||= outputs[0][0].some((x) => x !== 0);
    }
    assert.ok(heard);
  } finally {
    delete g.sampleRate;
    delete g.AudioWorkletProcessor;
    delete g.registerProcessor;
  }
});
