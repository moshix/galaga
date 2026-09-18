// Copyright 2026 by Moshix
/**
 * The headline test: the original ROM on the emulated board and the port,
 * stepped together from power-on with identical inputs, compared byte for
 * byte after every frame (test/helpers/lockstep.mjs).
 *
 * WHAT "EXACT" CAN MEAN ON THIS BOARD. Galaga's three Z80s run in parallel on
 * shared RAM, and in places the result depends on which CPU gets somewhere
 * first by a few dozen cycles -- whether an enemy launched this frame is moved
 * this frame, whether a new shot moves before the sub CPU's shot task runs.
 * A routine-by-routine port has no cycle clock, so it models the order
 * (src/game/scheduler.js) and, where the race is close, is sometimes a frame
 * early or late. Two kinds of test follow from that:
 *
 *  - STRICT: from power-on through the self test and well into attract mode,
 *    every frame must match, apart from a handful of frames where the board
 *    is sampled while a handler is still running.
 *  - RESYNC: over long runs (attract mode, and a played game with a seeded
 *    random joystick), any difference that lasts 3 frames is followed by a
 *    copy of the ROM's RAM into the port. A race then costs a short blip; a
 *    logic bug keeps re-diverging right after every resync and shows up as a
 *    long run, which is what these tests forbid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePair } from '../helpers/lockstep.mjs';

/**
 * Run `frames` frames and describe the differences.
 * @param {{ frames: number, resync?: boolean, play?: number }} options
 */
async function run({ frames, resync = false, play = 0 }) {
  const pair = await makePair();
  let seed = play;
  const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 16) / 65536; };
  let stick = 0;
  let current = 0;
  const runs = [];
  const bad = [];
  for (let f = 0; f < frames; f += 1) {
    if (play) {
      if (f === 1500) pair.press('coin1', true);
      if (f === 1504) pair.press('coin1', false);
      if (f === 1600) pair.press('start1', true);
      if (f === 1604) pair.press('start1', false);
      if (f > 1700) {
        if (f % 12 === 0) {
          const r = rand();
          const next = r < 0.35 ? -1 : r < 0.7 ? 1 : 0;
          if (next !== stick) { pair.press('left', next === -1); pair.press('right', next === 1); stick = next; }
        }
        pair.press('fire', (f % 16) < 3 && rand() < 0.8);
      }
    }
    const diff = pair.step();
    if (diff.length) {
      bad.push(f);
      current += 1;
      if (resync && current >= 3) pair.resync();
    } else if (current) { runs.push(current); current = 0; }
  }
  if (current) runs.push(current);
  return { bad, longest: Math.max(0, ...runs) };
}

test('strict: power-on, self test and 2300 frames of attract mode match', async () => {
  const { bad, longest } = await run({ frames: 2300 });
  // The few frames that differ are the board sampled mid-handler (a
  // playfield clear in progress), each healing within five frames.
  assert.ok(bad.length <= 10, `${bad.length} differing frames: ${bad.join(' ')}`);
  assert.ok(longest <= 5, `a difference lasted ${longest} frames`);
});

test('resync: 8000 frames of attract mode and the demo game', async () => {
  const { bad, longest } = await run({ frames: 8000, resync: true });
  assert.ok(longest <= 5, `a difference lasted ${longest} frames: logic, not a race`);
  assert.ok(bad.length < 8000 * 0.05, `${bad.length} differing frames`);
});

test('resync: a played game, seeded random joystick and fire', async () => {
  const { bad, longest } = await run({ frames: 12000, resync: true, play: 7 });
  assert.ok(longest <= 5, `a difference lasted ${longest} frames: logic, not a race`);
  assert.ok(bad.length < 12000 * 0.05, `${bad.length} differing frames`);
});
