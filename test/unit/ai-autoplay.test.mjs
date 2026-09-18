// Copyright 2026 by Moshix
/**
 * The AutoPlayer's arbitration on a fake machine: plain RAM behind peek()
 * and a record of the switches. Checks that it only ever uses the player's
 * switches, the coin/start behaviour, the respawn idle, the fire press shape
 * and the 2-rocket limit, and that it dodges a bomb set up in RAM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoPlayer } from '../../src/ai/autoplay.js';
import { stepShip } from '../../src/ai/paths.js';

/** A machine that is only RAM and switches. */
class FakeMachine {
  constructor() {
    this.ram = new Uint8Array(0x10000);
    /** @type {Map<string, boolean>} */
    this.switches = new Map();
    /** Every switch name ever touched. */
    this.touched = new Set();
  }

  /** @param {number} a */
  peek(a) { return this.ram[a & 0xffff]; }

  /** @param {string} name @param {boolean} down */
  setInput(name, down) {
    this.switches.set(name, down);
    this.touched.add(name);
  }

  /** @param {string} name */
  down(name) { return this.switches.get(name) === true; }

  /** A game in progress with a live fighter at x, nothing else on screen. */
  playing(x = 0x7a) {
    this.ram.fill(0);
    // Every object inactive.
    for (let l = 0; l < 0x80; l += 2) this.ram[0x8800 + l] = 0x80;
    this.ram[0x9201] = 3;
    this.ram[0x9014] = 1;
    this.ram[0x9015] = 1;
    this.ram[0x9362] = x;
    this.ram[0x9825] = 2;       // not a challenging stage
    this.ram[0x9289] = 0;       // motion runner finished
    return this;
  }
}

test('only the player\'s switches are ever touched', () => {
  const m = new FakeMachine().playing();
  const ai = new AutoPlayer(m);
  for (let i = 0; i < 50; i += 1) ai.step();
  m.ram[0x9201] = 1;
  for (let i = 0; i < 50; i += 1) ai.step();
  for (const name of m.touched) {
    assert.ok(['left', 'right', 'fire', 'coin1', 'start1'].includes(name), name);
  }
  ai.release();
  for (const name of m.touched) assert.equal(m.down(name), false);
});

test('idle: coins up, then presses start, in pulses', () => {
  const m = new FakeMachine();
  m.ram[0x9201] = 1;
  const ai = new AutoPlayer(m);
  let coins = 0;
  let prev = false;
  for (let i = 0; i < 100; i += 1) {
    ai.step();
    const d = m.down('coin1');
    if (d && !prev) coins += 1;
    prev = d;
    assert.equal(m.down('start1'), false);
  }
  assert.ok(coins >= 4);
  m.ram[0x99b8] = 1;
  let starts = 0;
  for (let i = 0; i < 40; i += 1) { ai.step(); if (m.down('start1')) starts += 1; }
  assert.ok(starts > 0);
  assert.equal(m.down('coin1'), false);
});

test('idle: autoStart false leaves the machine alone', () => {
  const m = new FakeMachine();
  m.ram[0x9201] = 1;
  const ai = new AutoPlayer(m, { autoStart: false });
  for (let i = 0; i < 100; i += 1) {
    ai.step();
    assert.equal(m.down('coin1') || m.down('start1'), false);
  }
});

test('respawn: nothing is pressed while the fighter is not in play', () => {
  const m = new FakeMachine().playing();
  m.ram[0x9014] = 0;
  const ai = new AutoPlayer(m);
  for (let i = 0; i < 20; i += 1) {
    ai.step();
    for (const n of ['left', 'right', 'fire']) assert.equal(m.down(n), false);
  }
  assert.equal(ai.telemetry.mode, 'wait');
});

test('fire: a press is two frames down, two up, and needs a free rocket', () => {
  const m = new FakeMachine().playing(0x7a);
  // A formation alien straight above the fighter.
  m.ram[0x8800] = 0x01;
  m.ram[0x9300] = 0x7a;
  m.ram[0x9301] = 100;
  const ai = new AutoPlayer(m);
  const pattern = [];
  for (let i = 0; i < 16; i += 1) { ai.step(); pattern.push(m.down('fire') ? 1 : 0); }
  // The formation drift estimate needs a few frames of history first; once
  // it fires, the shape is exact.
  const first = pattern.indexOf(1);
  assert.ok(first >= 0, pattern.join(''));
  assert.deepEqual(pattern.slice(first, first + 4), [1, 1, 0, 0]);
  // Both rockets in flight: no press at all.
  const n = new FakeMachine().playing(0x7a);
  n.ram[0x8800] = 0x01;
  n.ram[0x9300] = 0x7a;
  n.ram[0x9301] = 100;
  n.ram[0x9364] = 0x50;
  n.ram[0x9366] = 0x60;
  const busy = new AutoPlayer(n);
  for (let i = 0; i < 16; i += 1) { busy.step(); assert.equal(n.down('fire'), false); }
});

test('dodge: a bomb dropping on the fighter moves it', () => {
  const m = new FakeMachine().playing(0x7a);
  // Bomb object $68: status 6, code $30, straight down, 50 px (about 20
  // frames) above the fighter's row $129: y = 247, so bit 8 is clear.
  m.ram[0x8868] = 0x06;
  m.ram[0x8b68] = 0x30;
  m.ram[0x9368] = 0x7a;
  m.ram[0x9369] = 247;
  m.ram[0x9b69] = 0;
  m.ram[0x92b0] = 0;
  const ai = new AutoPlayer(m);
  ai.step();
  assert.ok(m.down('left') || m.down('right'));
  assert.ok(ai.telemetry.target !== 0x7a);
});

/**
 * Run the fake machine as a game would move the fighter: the direction
 * switches go through the real step logic, `delay` frames late.
 * @param {FakeMachine} m @param {AutoPlayer} ai @param {number} frames
 * @param {number} delay
 * @returns {{reversals: number, rapid: number, xs: number[]}}
 */
function drive(m, ai, frames, delay) {
  const pending = [];
  const s = { x: m.ram[0x9362], flag: 0 };
  let lastDir = 0;
  let lastReversal = -100;
  let reversals = 0;
  let rapid = 0;
  const xs = [];
  for (let f = 0; f < frames; f += 1) {
    ai.step();
    pending.push(m.down('left') ? -1 : m.down('right') ? 1 : 0);
    if (pending.length > delay) {
      const before = s.x;
      stepShip(s, /** @type {number} */ (pending.shift()), false);
      const dir = Math.sign(s.x - before);
      if (dir !== 0) {
        if (lastDir !== 0 && dir !== lastDir) {
          reversals += 1;
          if (f - lastReversal < 6) rapid += 1;
          lastReversal = f;
        }
        lastDir = dir;
      }
    }
    m.ram[0x9362] = s.x;
    m.ram[0x92a3] = s.flag;
    xs.push(s.x);
  }
  return { reversals, rapid, xs };
}

test('no jitter: a threat-free world does not make the fighter shake', () => {
  for (const delay of [1, 2]) {
    // Empty screen: it may settle somewhere, but must not oscillate.
    const m = new FakeMachine().playing(0x40);
    const ai = new AutoPlayer(m);
    const run = drive(m, ai, 600, delay);
    assert.ok(run.reversals <= 1, `delay ${delay}: ${run.reversals} reversals`);
    assert.equal(run.rapid, 0);
    // Settled: the last 200 frames stand still.
    assert.equal(new Set(run.xs.slice(-200)).size, 1, `delay ${delay}: still moving`);
  }
});

test('no jitter: a still target is walked to and held, not circled', () => {
  for (const delay of [1, 2]) {
    const m = new FakeMachine().playing(0x40);
    // One formation alien, not moving, well to the right.
    m.ram[0x8800] = 0x01;
    m.ram[0x9300] = 0xa0;
    m.ram[0x9301] = 100;
    const ai = new AutoPlayer(m, { autoStart: false });
    const run = drive(m, ai, 600, delay);
    assert.equal(run.rapid, 0, `delay ${delay}`);
    assert.ok(run.reversals <= 1, `delay ${delay}: ${run.reversals} reversals`);
    const end = run.xs[run.xs.length - 1];
    assert.ok(Math.abs(end - 0xa0) <= 3, `delay ${delay}: ended at ${end}`);
  }
});

test('latency: the AI measures the host\'s input delay', () => {
  for (const delay of [1, 2, 3]) {
    const m = new FakeMachine().playing(0x40);
    m.ram[0x8800] = 0x01;
    m.ram[0x9300] = 0xa0;
    m.ram[0x9301] = 100;
    const ai = new AutoPlayer(m);
    drive(m, ai, 200, delay);
    assert.equal(ai.delay, delay);
  }
});
