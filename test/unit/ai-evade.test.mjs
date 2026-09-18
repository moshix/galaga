// Copyright 2026 by Moshix
/**
 * The escape search on synthetic danger: hand-built threat tracks painted
 * into a map, and the planner asked where to go.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeDangerMap, clearMap, paintTrack, paintBeam, chooseMove, evaluate, evaluateWithKills,
  BEAM_BIT,
} from '../../src/ai/evade.js';
import { makeTrack, planShip } from '../../src/ai/paths.js';
import { beamOnset } from '../../src/ai/threats.js';
import { FIGHTER_Y, HIT_HALF_X, MARGIN_X, DUAL_OFFSET, BEAM_LEFT, BEAM_RIGHT } from '../../src/ai/constants.js';

const H = 64;

/**
 * A straight vertical faller at x, reaching the fighter's row on frame
 * `arrive`, falling `speed` px a frame.
 */
function faller(x, arrive, speed = 2.5) {
  const t = makeTrack(H);
  t.kind = 0;
  for (let k = 0; k <= H; k += 1) {
    t.x[k] = x;
    t.y[k] = Math.round(FIGHTER_Y - (arrive - k) * speed);
  }
  t.last = H;
  return t;
}

const idle = (x) => ({ x, flag: 0, queued: [0, 0], dual: false });

test('paint: lethal exactly over the hit box, a frame either side', () => {
  const map = makeDangerMap(H);
  paintTrack(map, faller(100, 20), false, 0);
  const half = HIT_HALF_X + MARGIN_X;
  // In band around frame 20; well before it, nothing.
  assert.equal(map.lethal[10 * 256 + 100], 0);
  assert.equal(map.lethal[20 * 256 + 100], 1);
  assert.equal(map.lethal[20 * 256 + 100 + half], 1);
  assert.equal(map.lethal[20 * 256 + 100 + half + 1], 0);
  assert.equal(map.lethal[20 * 256 + 100 - half], 1);
  assert.equal(map.lethal[20 * 256 + 100 - half - 1], 0);
  // The soft margin is wider.
  assert.equal(map.near[20 * 256 + 100 + half + 3], 1);
});

test('paint: the dual fighter is hit further left (its second ship)', () => {
  const map = makeDangerMap(H);
  paintTrack(map, faller(100, 20), true, 3);
  const half = HIT_HALF_X + MARGIN_X;
  assert.equal(map.lethal[20 * 256 + 100 - half - DUAL_OFFSET], 1 << 3);
  assert.equal(map.lethal[20 * 256 + 100 - half - DUAL_OFFSET - 1], 0);
  assert.equal(map.lethal[20 * 256 + 100 + half + 1], 0);
});

test('choose: a bomb falling on the fighter is dodged in time', () => {
  const map = makeDangerMap(H);
  paintTrack(map, faller(120, 12), false, 0);
  const move = chooseMove(idle(120), map, null, -1);
  assert.equal(move.tDeath, H + 1);
  assert.ok(Math.abs(move.target - 120) > HIT_HALF_X + MARGIN_X);
  assert.notEqual(move.dir, 0);
});

test('choose: with nothing around, stays put (no fidgeting)', () => {
  const map = makeDangerMap(H);
  const move = chooseMove(idle(120), map, null, 120);
  assert.equal(move.target, 120);
  assert.equal(move.dir, 0);
});

test('choose: the two frames already sent are part of every plan', () => {
  // A bomb lands just left of the fighter on frame 3. Staying is fine; but
  // the fighter has already been told to go left twice, which walks it
  // into the bomb before anything sent now can take effect. The planner
  // must see that every plan dies (it cannot undo the past), not pretend.
  const map = makeDangerMap(H);
  paintTrack(map, faller(110, 3), false, 0);
  const move = chooseMove({ x: 120, flag: 0, queued: [-1, -1], dual: false }, map, null, -1);
  assert.ok(move.tDeath <= 4);
  // Without the queued moves the same bomb is harmless.
  const safe = chooseMove(idle(120), map, null, -1);
  assert.equal(safe.tDeath, H + 1);
});

test('choose: cornered, it takes the plan that lives longest', () => {
  const map = makeDangerMap(H);
  // Bombs landing all across the screen at frame 30, and one on the
  // fighter at frame 16. Nothing survives 30; the best plan still gets out
  // from under the first bomb, rather than giving up.
  for (let x = 20; x <= 230; x += 12) paintTrack(map, faller(x, 30), false, 1);
  paintTrack(map, faller(120, 16), false, 2);
  const move = chooseMove(idle(120), map, null, -1);
  assert.ok(move.tDeath > 20, `tDeath ${move.tDeath}`);
  assert.ok(move.tDeath <= 30);
});

test('choose: the aim map breaks ties between safe spots', () => {
  const map = makeDangerMap(H);
  const aim = new Float32Array(256);
  aim[150] = 1;
  const move = chooseMove(idle(120), map, aim, -1);
  assert.equal(move.target, 150);
  assert.equal(move.dir, 1);
});

test('beam: onset timing from the capture state', () => {
  assert.equal(beamOnset(false, 0x40, 5, 12), 1);
  assert.ok(beamOnset(true, 0, 1, 12) >= 20);
  // Six rows drawn, 3 frames to the next, 12 per row: four rows to go.
  assert.equal(beamOnset(false, 0x06, 3, 12), 4 * 12 + 3);
});

test('beam: a fighter under the spot walks out before it is lethal', () => {
  const map = makeDangerMap(H);
  paintBeam(map, 120, 30);
  // Every frame from 30 on is lethal across the whole beam.
  assert.equal(map.lethal[30 * 256 + 120 - BEAM_LEFT], (1 << BEAM_BIT) >>> 0);
  assert.equal(map.lethal[29 * 256 + 120], 0);
  const move = chooseMove(idle(120), map, null, -1);
  assert.equal(move.tDeath, H + 1);
  assert.ok(move.target < 120 - BEAM_LEFT || move.target > 120 + BEAM_RIGHT);
});

test('kills: a plan that can shoot its killer in time survives it', () => {
  const map = makeDangerMap(H);
  const diver = faller(120, 30, 3);
  diver.kind = 1;
  paintTrack(map, diver, false, 5);
  const plan = new Int16Array(H + 1);
  planShip(120, 0, [0, 0], 120, false, H, plan);
  const before = evaluate(map, plan).tDeath;
  assert.ok(before > 20 && before < 30);
  // A kill test that says "dead from frame 20" clears the threat.
  const kills = evaluateWithKills(map, plan, (_p, id) => (id === 5 ? 20 : -1));
  assert.equal(kills.tDeath, H + 1);
  assert.equal(kills.kills, 1 << 5);
  // The beam cannot be shot.
  clearMap(map);
  paintBeam(map, 120, 10);
  const beamed = evaluateWithKills(map, plan, () => 5);
  assert.equal(beamed.tDeath, 10);
});
