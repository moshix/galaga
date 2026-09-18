// Copyright 2026 by Moshix
/**
 * The AI's predictors, on synthetic states: bombs (f_1EA4), the fighter's
 * step logic and input latency (f_1F85), the controller policy, rockets,
 * and the motion-runner transcription's arithmetic.
 *
 * The oracle checks of the same functions -- predictions against the real
 * ROM, frame by frame -- are in ai-oracle.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTrack, predictBomb, predictDrift, inFighterBand, stepShip, policy, planShip,
  rocketHits,
} from '../../src/ai/paths.js';
import { divide, makeFlight, makeFlightEnv, stepFlight } from '../../src/ai/flight.js';
import { FIGHTER_Y, X_MIN, X_MAX, RIGHT_LIMIT_DUAL } from '../../src/ai/constants.js';

test('bomb: straight down, 2 and 3 pixels on alternate frames', () => {
  const t = makeTrack(64);
  // Rate 0: no drift. Counter even: the next frame falls 2, then 3, ...
  predictBomb(100, 200, 0x00, 0, 0x10, 20, t);
  assert.equal(t.x[5], 100);
  assert.deepEqual(Array.from(t.y.slice(0, 5)), [200, 202, 205, 207, 210]);
  predictBomb(100, 200, 0x00, 0, 0x11, 4, t);
  assert.deepEqual(Array.from(t.y.slice(0, 5)), [200, 203, 205, 208, 210]);
});

test('bomb: sideways drift carries the remainder, bit 7 is the direction', () => {
  const t = makeTrack(64);
  // (rate & $7E) = $30: 48/32 = 1.5 px a frame, exactly, via the remainder.
  predictBomb(100, 100, 0x30, 0, 0, 8, t);
  assert.deepEqual(Array.from(t.x.slice(0, 9)), [100, 101, 103, 104, 106, 107, 109, 110, 112]);
  predictBomb(100, 100, 0xb0, 0, 0, 4, t);
  assert.deepEqual(Array.from(t.x.slice(0, 5)), [100, 99, 97, 96, 94]);
  // Bit 0 of the rate is masked off by the ROM (and $7E): $31 is $30.
  const u = makeTrack(64);
  predictBomb(100, 100, 0x31, 0, 0, 8, u);
  assert.deepEqual(Array.from(u.x.slice(0, 9)), [100, 101, 103, 104, 106, 107, 109, 110, 112]);
});

test('bomb: the track ends once it is well past the fighter', () => {
  const t = makeTrack(64);
  predictBomb(100, 280, 0, 0, 0, 64, t);
  assert.ok(t.last < 64);
  assert.ok(t.y[t.last] <= FIGHTER_Y + 0x20);
});

test('fighter band: y<8:1> within 3 of the fighter\'s', () => {
  assert.equal(inFighterBand(FIGHTER_Y), true);
  assert.equal(inFighterBand(290), true);   // yh 145 = 148 - 3
  assert.equal(inFighterBand(289), false);  // yh 144
  assert.equal(inFighterBand(303), true);   // yh 151
  assert.equal(inFighterBand(304), false);  // yh 152
});

test('ship: steps alternate 1, 2 while held; centring resets', () => {
  const s = { x: 100, flag: 0 };
  const xs = [];
  for (let i = 0; i < 4; i += 1) { stepShip(s, 1, false); xs.push(s.x); }
  assert.deepEqual(xs, [101, 103, 104, 106]);
  stepShip(s, 0, false);
  assert.equal(s.flag, 0);
  stepShip(s, -1, false);
  assert.equal(s.x, 105);
  // Reversing without centring keeps the phase going.
  stepShip(s, 1, false);
  assert.equal(s.x, 107);
});

test('ship: wall limits test the position before the step', () => {
  const s = { x: 0xe0, flag: 1 };
  stepShip(s, 1, false);          // allowed from $E0, step 2 -> $E2
  assert.equal(s.x, 0xe2);
  stepShip(s, 1, false);          // $E2 >= $E1: refused
  assert.equal(s.x, 0xe2);
  const d = { x: RIGHT_LIMIT_DUAL, flag: 0 };
  stepShip(d, 1, true);           // dual fighter stops at $D1
  assert.equal(d.x, RIGHT_LIMIT_DUAL);
  const l = { x: 0x12, flag: 1 };
  stepShip(l, -1, false);
  assert.equal(l.x, 0x10);
  stepShip(l, -1, false);
  assert.equal(l.x, 0x10);
});

test('policy: pauses a frame rather than overshoot by one', () => {
  // flag 1: the next step would be 2, one pixel to go -> let go.
  assert.equal(policy(100, 1, 101, false), 0);
  assert.equal(policy(100, 0, 101, false), 1);
  assert.equal(policy(100, 1, 102, false), 1);
  assert.equal(policy(100, 0, 100, false), 0);
  assert.equal(policy(100, 0, 90, false), -1);
});

test('plan: queued inputs run first, then the policy lands exactly', () => {
  const out = new Int16Array(160);
  // Two frames of "left" already sent; the target is to the right.
  const dir = planShip(100, 0, [-1, -1], 110, false, 30, out);
  assert.equal(out[1], 99);
  assert.equal(out[2], 97);
  assert.equal(dir, 1);
  assert.equal(out[30], 110);
  // Every target in range is reached exactly and held.
  for (let target = X_MIN + 2; target <= X_MAX - 2; target += 7) {
    planShip(120, 1, [0, 0], target, false, 150, out);
    assert.equal(out[150], target, `target ${target}`);
  }
});

test('rockets: a hit only counts if it holds for both first-frame phases', () => {
  const t = makeTrack(64);
  // A formation alien straight above at y 100: in range, hit.
  predictDrift(120, 100, 0, 64, t);
  assert.ok(rocketHits(120, 4, t, 3) > 4);
  assert.ok(rocketHits(123, 4, t, 3) > 4);
  assert.equal(rocketHits(124, 4, t, 3), -1);
  // Drifting at 1 px a frame: aimed where it will be, not where it is.
  predictDrift(100, 100, 1, 64, t);
  const flight = Math.round((FIGHTER_Y - 100) / 6) + 4;
  assert.ok(rocketHits(100 + flight, 4, t, 3) > 0);
  assert.equal(rocketHits(100, 4, t, 3), -1);
});

test('divide: c_0EAA is plain integer division', () => {
  for (const [a, hl] of [[6, 0x2f00], [0x1e, 0xff00], [7, 12345], [0x80, 0x7fff], [3, 0]]) {
    assert.equal(divide(a, hl), Math.floor(hl / a), `${hl} / ${a}`);
  }
});

test('flight: a straight segment moves along its axis at its speed', () => {
  const f = makeFlight();
  const env = makeFlightEnv();
  // Heading 0 (quadrant 0, fraction 0), speed 2 on both parities, no turn,
  // 10 frames left; active slot for object $10.
  f.s.set([0x00, 0x40, 0x00, 0x40, 0x00, 0x00, 0, 0, 0, 0, 2, 2, 0, 10, 0x50, 0, 0x10, 0, 0, 0x01]);
  f.status = 9;
  f.alive = true;
  const ys = [];
  const xs = [];
  for (let k = 0; k < 4; k += 1) {
    assert.equal(stepFlight(f, env, k & 1), true);
    ys.push(f.y);
    xs.push(f.x);
  }
  // Heading 0 moves x (+02/+03) by the speed in 9.7 units: one pixel of
  // x<8:1> a frame, i.e. the sprite x moves by two.
  assert.deepEqual(xs, [0x82, 0x84, 0x86, 0x88]);
  assert.equal(new Set(ys).size, 1);
  assert.equal(f.s[0x0d], 6);
});

test('flight: an alien not flying (status 1) is not predicted', () => {
  const f = makeFlight();
  f.s[0x13] = 1;
  f.status = 1;
  f.alive = true;
  assert.equal(stepFlight(f, makeFlightEnv(), 0), false);
});
