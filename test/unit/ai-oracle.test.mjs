// Copyright 2026 by Moshix
/**
 * The AI against the ORIGINAL ROM, on the emulated three-Z80 board.
 *
 *  - Its models of the game are checked against the game: the fighter's
 *    step logic and input latency, the bomb predictor and the flight-path
 *    transcription, each compared with what the real code then does.
 *  - It plays: from coin-up, through the first stages, without losing a
 *    fighter. The frame count was picked after measuring: the benchmark's
 *    first losses come after 40,000 frames or more, so 10,000 frames is a
 *    firm floor rather than a lucky one, and it covers the first
 *    challenging stage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOracle, loadChips } from '../helpers/oracle.mjs';
import { AutoPlayer } from '../../src/ai/autoplay.js';
import { makeFlight, loadFlight, stepFlight } from '../../src/ai/flight.js';
import { makeTrack, predictBomb, stepShip } from '../../src/ai/paths.js';
import { ThreatReader } from '../../src/ai/threats.js';
import { MOVE_DELAY } from '../../src/ai/constants.js';

/** Boot, coin up, start; returns the board once the fighter can move. */
async function newGame() {
  const board = makeOracle(await loadChips());
  for (let f = 0; f < 1200; f += 1) {
    if (f === 1100) board.setInput('coin1', true);
    if (f === 1104) board.setInput('coin1', false);
    if (f === 1160) board.setInput('start1', true);
    if (f === 1164) board.setInput('start1', false);
    board.runFrame();
  }
  while (board.peek(0x9014) === 0) board.runFrame();
  return board;
}

test('oracle: the fighter model (1-2 step, latency) predicts every move', async () => {
  const board = await newGame();
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const inputs = [];
  let cur = 0;
  let hold = 0;
  let ok = 0;
  let bad = 0;
  const s = { x: board.peek(0x9362), flag: board.peek(0x92a3) & 1 };
  for (let f = 0; f < 600 && board.peek(0x9014) !== 0; f += 1) {
    if (hold <= 0) { cur = [0, -1, 1][Math.floor(rnd() * 3)]; hold = 1 + Math.floor(rnd() * 8); }
    hold -= 1;
    const x = board.peek(0x9362);
    if (x < 0x30 && cur < 0) cur = 1;
    if (x > 0xc0 && cur > 0) cur = -1;
    board.setInput('left', cur < 0);
    board.setInput('right', cur > 0);
    inputs.push(cur);
    board.runFrame();
    // The input sent MOVE_DELAY frames ago is the one that moved it now.
    if (inputs.length > MOVE_DELAY) {
      stepShip(s, inputs[inputs.length - 1 - MOVE_DELAY], false);
      if (s.x === board.peek(0x9362)) ok += 1; else bad += 1;
    }
    s.x = board.peek(0x9362);
    s.flag = board.peek(0x92a3) & 1;
  }
  assert.ok(ok > 300, `only ${ok} moves observed`);
  assert.equal(bad, 0);
});

test('oracle: the AI plays the first stages without losing a fighter', async () => {
  const board = await newGame();
  const ai = new AutoPlayer(board);
  const reader = new ThreatReader();
  const flight = makeFlight();
  const track = makeTrack(8);
  const peek = (a) => board.peek(a);
  /** @type {{due: number, l: number, x: number, y: number}[]} */
  const bombChecks = [];
  /** @type {{due: number, slot: number, obj: number, bytes: number[]}[]} */
  const flightChecks = [];
  let bombOk = 0;
  let bombBad = 0;
  let flightOk = 0;
  let flightBad = 0;
  let ships = board.peek(0x9820);
  let stage = 0;

  for (let f = 0; f < 10000; f += 1) {
    ai.step();
    // Predictions made from this frame's state, checked when they come due.
    const w = reader.readWorld(board);
    for (let i = 0; i < 8; i += 1) {
      const l = 0x68 + 2 * i;
      if (board.peek(0x8800 + l) !== 6 || board.peek(0x8b00 + l) !== 0x30) continue;
      const x = board.peek(0x9300 + l);
      const y = board.peek(0x9301 + l) | ((board.peek(0x9b01 + l) & 1) << 8);
      predictBomb(x, y, board.peek(0x92b0 + 2 * i), board.peek(0x92b1 + 2 * i), w.counter, 8, track);
      if (track.last >= 4) bombChecks.push({ due: f + 4, l, x: track.x[4], y: track.y[4] });
    }
    const current = 12 - w.runnerLeft;
    for (let s = 0; s < 12; s += 1) {
      const addr = 0x9100 + s * 0x14;
      if (s === current || (board.peek(addr + 0x13) & 1) === 0) continue;
      const obj = board.peek(addr + 0x10);
      loadFlight(flight, peek, addr, board.peek(0x8800 + obj));
      if (!stepFlight(flight, reader.env, (s < current ? w.counter + 1 : w.counter) & 1)) continue;
      flightChecks.push({ due: f + 1, slot: s, obj, bytes: Array.from(flight.s.subarray(0, 6)) });
    }

    board.runFrame();
    if (board.peek(0x9014) !== 0) stage = Math.max(stage, board.peek(0x9821));

    const nowCurrent = 12 - board.peek(0x9289);
    for (const c of flightChecks) {
      if (c.due !== f + 1) continue;
      const addr = 0x9100 + c.slot * 0x14;
      // Skip the slot the runner is in the middle of, and slots the main
      // CPU has since reassigned.
      if (c.slot === nowCurrent || board.peek(addr + 0x10) !== c.obj) continue;
      if ((board.peek(addr + 0x13) & 1) === 0) continue;
      const same = c.bytes.every((b, i) => board.peek(addr + i) === b);
      if (same) flightOk += 1; else flightBad += 1;
    }
    for (const c of bombChecks) {
      if (c.due !== f + 1) continue;
      if (board.peek(0x8800 + c.l) !== 6) continue;
      const y = board.peek(0x9301 + c.l) | ((board.peek(0x9b01 + c.l) & 1) << 8);
      if (board.peek(0x9300 + c.l) === c.x && y === c.y) bombOk += 1; else bombBad += 1;
    }
    while (flightChecks.length > 0 && flightChecks[0].due <= f + 1) flightChecks.shift();
    while (bombChecks.length > 0 && bombChecks[0].due <= f + 1) bombChecks.shift();

    // Reserve ships only ever fall on a loss; a bonus ship raises them.
    const now = board.peek(0x9820);
    assert.ok(now >= ships, `fighter lost at frame ${f}, stage ${stage}`);
    ships = now;
    assert.equal(board.peek(0x9201), 3, 'game over');
  }
  assert.ok(stage >= 3, `only reached stage ${stage}`);
  // The predictors: bombs are exact; the flight transcription is exact bar
  // the rare frame on which the main CPU itself rewrites a slot.
  assert.ok(bombOk > 200, `bombs checked: ${bombOk}`);
  assert.ok(bombBad <= bombOk / 100, `bombs: ${bombBad} wrong of ${bombOk + bombBad}`);
  assert.ok(flightOk > 2000, `flight steps checked: ${flightOk}`);
  assert.ok(flightBad <= flightOk / 100, `flights: ${flightBad} wrong of ${flightOk + flightBad}`);
});
