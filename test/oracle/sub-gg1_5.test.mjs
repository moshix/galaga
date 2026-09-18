// Copyright 2026 by Moshix
/**
 * Differential tests of the sub CPU port (src/game/sub/gg1_5*.js) against
 * the real gg1_5b.3f code running on the oracle's sub CPU.
 *
 * Every test builds the same RAM in the oracle and a port Machine, runs the
 * ROM routine (callRoutine) and the JS routine, and demands identical RAM
 * (stacks excepted) and identical returned registers. The motion runner and
 * the IRQ handler are also run for hundreds of consecutive frames from
 * seeded random states and from states captured in the attract-mode demo,
 * comparing after every frame.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeOracle, loadChips, callRoutine, loadState, diffRam } from '../helpers/oracle.mjs';
import { loadGalaga, ROOT } from '../../tools/romset.mjs';
import { Machine } from '../../src/machine/machine.js';
import { SPIN } from '../../src/game/scheduler.js';
import '../../src/game/sub/index.js';
import { SUB, SUB_AT } from '../../src/game/sub/routines.js';
import { SUB_ROM_CHECKSUM, RESTART } from '../../src/game/sub/gg1_5.js';
import { MOTION_CASES } from '../../src/game/sub/gg1_5_motion.js';
import { romByte } from '../../src/game/romdata.js';

const SUB_CPU = 1;

// ------------------------------------------------------------ helpers

/** Seeded PRNG (mulberry32). @param {number} seed */
function rng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** @param {number} n */ int: (n) => Math.floor(next() * n),
    byte: () => Math.floor(next() * 256),
    /** @template T @param {T[]} a @returns {T} */ pick: (a) => a[Math.floor(next() * a.length)],
    /** @param {number} p */ chance: (p) => next() < p,
  };
}

/** A pair of machines kept in lock step. */
function pair() {
  const board = makeOracle();
  const m = new Machine();
  /** Write a byte into both. @param {number} a @param {number} v */
  const poke = (a, v) => { board.poke(a, v & 0xff); m.poke(a, v & 0xff); };
  return { board, m, poke };
}

/** Fill all shared RAM with random bytes, identically. */
function randomRam(board, m, r) {
  for (const k of ['video', 'ram1', 'ram2', 'ram3']) {
    for (let i = 0; i < board[k].length; i += 1) board[k][i] = r.byte();
  }
  loadState(m, board);
}

/** Assert RAM identical, with context. */
function same(board, m, what) {
  const d = diffRam(board, m);
  assert.deepEqual(d, [], `${what}: RAM differs\n${d.join('\n')}`);
}

/** Sub CPU flight-path entry points: every path label in the listing. */
const PATHS = (() => {
  const sym = JSON.parse(readFileSync(join(ROOT, 'reference/symbols.json'), 'utf8')).sub;
  const out = new Set();
  for (const [name, v] of Object.entries(sym)) {
    if (/^(db_flv|p_flv|db_fltv|db_0)/.test(name)) out.add(v.rev_b);
  }
  // Mid-path targets reached by $F3 / $FD, and the unnamed tails.
  for (const a of [0x03bb, 0x03f6, 0x03fe, 0x0485, 0x0460]) out.add(a);
  return [...out].sort((a, b) => a - b);
})();

// ------------------------------------------------------------ constants

test('ROM checksum constant matches gg1_5b.3f', () => {
  const rom = loadGalaga().sub;
  let s = 0;
  for (let i = 0; i < 0x1000; i += 1) s = (s + rom[i]) & 0xff;
  assert.equal(s, SUB_ROM_CHECKSUM);
});

test('every d_0920_jp_tbl entry and task-table entry is registered', () => {
  const rom = loadGalaga().sub;
  for (let i = 0; i < 17; i += 1) {
    const a = rom[0x920 + 2 * i] | (rom[0x921 + 2 * i] << 8);
    assert.equal(typeof SUB_AT[a], 'function', `jump table ${i}: $${a.toString(16)}`);
  }
  for (let i = 0; i < 8; i += 1) {
    const a = rom[0x3b + 2 * i] | (rom[0x3c + 2 * i] << 8);
    assert.equal(typeof SUB_AT[a], 'function', `task ${i}: $${a.toString(16)}`);
  }
});

// ------------------------------------------------------------ math

test('c_0EAA (HL / A) matches, remainder included', () => {
  const { board, m } = pair();
  const r = rng(1);
  const cases = [[0, 0], [0, 0x1234], [1, 0xffff], [0xff, 0xffff], [6, 0x2f00], [0x1e, 0x8000]];
  for (let i = 0; i < 3000; i += 1) cases.push([r.pick([r.byte(), r.int(16), 0]), r.int(0x10000)]);
  for (const [a, hl] of cases) {
    const z = callRoutine(board, SUB_CPU, 0x0eae, { af: a << 8, hl, bc: 0x5a5a });
    const out = SUB.c_0EAA(m, { a, hl });
    assert.equal(out.hl, z.hl, `hl for ${hl}/${a}`);
    assert.equal(out.a, z.af >> 8, `remainder for ${hl}/${a}`);
    assert.equal(z.bc, 0x5a5a);
  }
});

test('c_0E97 (HL * A) matches', () => {
  const { board, m } = pair();
  const r = rng(2);
  for (let i = 0; i < 2000; i += 1) {
    const a = r.byte();
    const hl = r.chance(0.5) ? r.byte() : r.int(0x10000);
    const z = callRoutine(board, SUB_CPU, 0x0e9b, { af: a << 8, hl, de: 0x1357 });
    assert.equal(SUB.c_0E97(m, { a, hl }).hl, z.hl);
    assert.equal(z.de, 0x1357);
  }
});

test('c_0E5B (heading to a point) matches for all octants', () => {
  const { board, m } = pair();
  const r = rng(3);
  const cases = [[0, 0], [0x4800, 0x4800], [0x0000, 0xffff], [0xffff, 0]];
  for (let i = 0; i < 4000; i += 1) {
    const de = r.int(0x10000);
    // Mostly nearby points, where |dx| and |dy| are close.
    const hl = r.chance(0.5) ? r.int(0x10000)
      : (((de >> 8) + r.int(9) - 4) & 0xff) << 8 | (((de & 0xff) + r.int(9) - 4) & 0xff);
    cases.push([de, hl]);
  }
  for (const [de, hl] of cases) {
    const z = callRoutine(board, SUB_CPU, 0x0e5f, { de, hl, bc: 0x2468 });
    assert.equal(SUB.c_0E5B(m, { de, hl }).hl, z.hl, `de=${de.toString(16)} hl=${hl.toString(16)}`);
    assert.equal(z.de, de);
    assert.equal(z.bc, 0x2468);
  }
});

// ------------------------------------------------------------ sprite copy

test('f_05BF copies the sprite buffers', () => {
  const { board, m, poke } = pair();
  const r = rng(4);
  for (let i = 0; i < 20; i += 1) {
    randomRam(board, m, r);
    poke(0x92d6, 0); // main CPU not inside f_0828
    callRoutine(board, SUB_CPU, 0x05bf);
    SUB.f_05BF(m);
    same(board, m, `f_05BF #${i}`);
  }
});

// ------------------------------------------------------ collision state

const STATUSES = [0x80, 0x80, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x09, 0x09];
const COLOURS = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x09, 0x0b];

/**
 * A battlefield: objects scattered close to (x, y) so windows hit and
 * miss by a pixel, plus everything the hit dispatcher reads.
 */
function battlefield(r, poke, x, y) {
  for (let l = 0; l < 0x80; l += 2) {
    poke(0x8800 + l, r.pick(STATUSES));
    poke(0x8801 + l, r.int(12) * 0x14);
    poke(0x9200 + l, r.chance(0.85) ? 0 : r.pick([0x81, 0x01, 0xb8]));
    poke(0x8b01 + l, r.pick(COLOURS));
    const near = r.chance(0.6);
    poke(0x9300 + l, near ? x + r.int(25) - 12 : r.byte());
    const yy = near ? y + r.int(25) - 12 : r.int(0x200);
    poke(0x9301 + l, yy);
    poke(0x9b01 + l, (r.byte() & 0xfe) | ((yy >> 8) & 1));
  }
  poke(0x9827, r.chance(0.3) ? 1 : 0);
  poke(0x901d, r.chance(0.3) ? 1 : 0);
  poke(0x9008, r.chance(0.5) ? 1 : 0);
  poke(0x9828, r.chance(0.3) ? r.int(0x40) & 0xfe : 1);
  poke(0x982d, r.chance(0.3) ? r.int(0x40) & 0xfe : 1);
  poke(0x99b0, r.int(4));
  poke(0x92a8, 1 + r.int(3));
}

test('f_06F5 rockets and rocket hit detection', () => {
  const { board, m, poke } = pair();
  const r = rng(5);
  let hits = 0;
  for (let i = 0; i < 1500; i += 1) {
    randomRam(board, m, r);
    const x = 0x10 + r.int(0xe8);
    const y = 0x20 + r.int(0x120);
    battlefield(r, poke, x, y);
    for (const k of [0, 1]) {
      poke(0x9364 + 2 * k, r.chance(0.1) ? 0 : x + r.int(9) - 4);
      const ry = r.chance(0.05) ? r.int(0x200) : y + r.int(9) - 4;
      poke(0x9365 + 2 * k, ry);
      poke(0x9b65 + 2 * k, (r.byte() & 0xfe) | ((ry >> 8) & 1));
      poke(0x92a4 + k, r.pick([0xe0, 0x60, 0xa0, r.byte()]));
    }
    const before = m.peek16(0x9844);
    callRoutine(board, SUB_CPU, 0x06f5);
    SUB.f_06F5(m);
    same(board, m, `f_06F5 #${i}`);
    if (m.peek16(0x9844) !== before) hits += 1;
  }
  assert.ok(hits > 100, `only ${hits} hits`);
});

test('f_05EE fighter collision detection', () => {
  const { board, m, poke } = pair();
  const r = rng(6);
  let hits = 0;
  for (let i = 0; i < 1500; i += 1) {
    randomRam(board, m, r);
    const x = 0x10 + r.int(0xe0);
    const y = 0x20 + r.int(0x40);
    battlefield(r, poke, x, y);
    poke(0x9014, r.chance(0.9) ? r.pick([1, 2, 0x20]) : 0);
    for (const f of [0x60, 0x62]) {
      poke(0x8800 + f, r.chance(0.1) ? 8 : r.pick([0x80, 1, 9]));
      poke(0x9300 + f, r.chance(0.1) ? 0 : x + (f === 0x60 ? -16 : 0) + r.int(5) - 2);
      poke(0x9301 + f, y);
      poke(0x9b01 + f, r.byte() & 0xfe);
      poke(0x9380 + f, r.byte());
    }
    poke(0x9217, r.chance(0.5) ? 1 : 0);
    callRoutine(board, SUB_CPU, 0x05ee);
    SUB.f_05EE(m);
    same(board, m, `f_05EE #${i}`);
    if (m.peek(0x99bf)) hits += 1;
  }
  assert.ok(hits > 100, `only ${hits} fighter hits`);
});

test('hitd_det_rckt / hitd_det_fghtr entry points with registers', () => {
  const { board, m, poke } = pair();
  const r = rng(7);
  for (let i = 0; i < 600; i += 1) {
    randomRam(board, m, r);
    const x = r.byte();
    const y = 0x20 + r.int(0x120);
    battlefield(r, poke, x, y);
    const ixl = x;
    const ixh = (y >> 1) & 0xff;
    const e = r.pick([0x65, 0x67, 0x60, 0x62]);
    const l = r.int(0x30) * 2;
    const b = 1 + r.int(0x30);
    const fn = r.chance(0.5) ? ['hitd_det_rckt', 0x076a] : ['hitd_det_fghtr', 0x06b7];
    callRoutine(board, SUB_CPU, fn[1], { hl: 0x9300 | l, bc: b << 8, de: e, ix: (ixh << 8) | ixl });
    SUB[fn[0]](m, { l, b, e, ixl, ixh });
    same(board, m, `${fn[0]} #${i}`);
  }
});

// ------------------------------------------------------------ motion

/** Put a freshly launched alien into slot `k` on both machines. */
function launch(r, poke, k, obj, paths) {
  const ix = 0x9100 + 0x14 * k;
  for (let o = 0; o < 0x14; o += 1) poke(ix + o, r.byte());
  const p = r.pick(paths);
  poke(ix + 0x08, p & 0xff);
  poke(ix + 0x09, p >> 8);
  poke(ix + 0x0d, r.chance(0.7) ? 1 : 1 + r.int(8));
  poke(ix + 0x0a, r.int(16));
  poke(ix + 0x0b, r.int(16));
  poke(ix + 0x0e, 1 + r.int(40));
  poke(ix + 0x10, obj);
  let f = 1 | (r.chance(0.5) ? 0x80 : 0);
  if (r.chance(0.1)) f |= 0x40;
  if (r.chance(0.1)) f |= 0x20;
  poke(ix + 0x13, f);
  poke(0x8800 + obj, r.pick([9, 9, 9, 9, 7, 3, 3, r.chance(0.2) ? 0x80 : 9]));
  poke(0x8801 + obj, 0x14 * k);
}

/** Environment the motion runner reads. */
function motionWorld(r, poke) {
  for (let l = 0; l < 0x80; l += 2) poke(0x8800 + l, r.pick([0x80, 0x80, 1, 2, 9]));
  for (let l = 0x68; l < 0x78; l += 2) poke(0x8800 + l, r.chance(0.7) ? 0x80 : 6);
  for (let i = 0; i < 12; i += 1) poke(0x9113 + 0x14 * i, 0);
  const flip = r.chance(0.25) ? 1 : 0;
  poke(0x9215, flip);
  poke(0x9362, r.byte());
  poke(0x93e2, r.chance(0.1) ? 0 : r.byte());
  poke(0x92aa, r.int(2));
  poke(0x901d, r.chance(0.3) ? 1 : 0);
  poke(0x99c8, r.int(2));
  poke(0x99c9, r.int(2));
  poke(0x9015, r.chance(0.8) ? 1 : 0);
  poke(0x92ad, r.chance(0.8) ? 0 : 3);
  poke(0x92e2, 1 + r.int(30));
}

test('f_08D3 bug motion runner, many frames from random launches', () => {
  // Count every jump-table command on the way through.
  const hits = new Map();
  const saved = {};
  for (const [a, fn] of Object.entries(MOTION_CASES)) {
    saved[a] = SUB_AT[a];
    hits.set(fn.name, 0);
    SUB_AT[a] = (mm, regs) => { hits.set(fn.name, hits.get(fn.name) + 1); return fn(mm, regs); };
  }
  let homed = 0;
  let bombsDropped = 0;
  let frames = 0;
  try {
    for (let seed = 100; seed < 140; seed += 1) {
      const { board, m, poke } = pair();
      const r = rng(seed);
      randomRam(board, m, r);
      motionWorld(r, poke);
      const objs = [];
      for (let l = 0; l < 0x60; l += 2) objs.push(l);
      const freeObj = () => {
        for (let t = 0; t < 40; t += 1) {
          const o = r.pick(objs);
          if (m.peek(0x8800 + o) === 0x80 || m.peek(0x8800 + o) === 2) return o;
        }
        return r.pick(objs);
      };
      for (let k = 0; k < 12; k += 1) if (r.chance(0.7)) launch(r, poke, k, freeObj(), PATHS);
      for (let f = 0; f < 300; f += 1) {
        poke(0x92a0, (m.peek(0x92a0) + 1) & 0xff);
        if (r.chance(0.02)) poke(0x9362, r.byte());
        if (r.chance(0.02)) poke(0x92aa, r.int(2));
        if (r.chance(0.01)) poke(0x9215, r.int(2));
        if (r.chance(0.05)) {
          const k = r.int(12);
          if ((m.peek(0x9113 + 0x14 * k) & 1) === 0) launch(r, poke, k, freeObj(), PATHS);
        }
        const bombBefore = [];
        for (let l = 0x68; l < 0x78; l += 2) bombBefore.push(m.peek(0x8800 + l));
        const active = [];
        for (let k = 0; k < 12; k += 1) active.push(m.peek(0x9113 + 0x14 * k) & 1);
        callRoutine(board, SUB_CPU, 0x08d3);
        SUB.f_08D3(m);
        frames += 1;
        same(board, m, `seed ${seed} frame ${f}`);
        for (let l = 0x68, i = 0; l < 0x78; l += 2, i += 1) {
          if (bombBefore[i] === 0x80 && m.peek(0x8800 + l) === 6) bombsDropped += 1;
        }
        for (let k = 0; k < 12; k += 1) {
          const ix = 0x9100 + 0x14 * k;
          if (active[k] && !(m.peek(ix + 0x13) & 1) && m.peek(0x8800 + m.peek(ix + 0x10)) === 2) homed += 1;
        }
      }
    }
  } finally {
    Object.assign(SUB_AT, saved);
  }
  const missing = [...hits].filter(([, n]) => n === 0).map(([k]) => k);
  assert.deepEqual(missing, [], `commands never exercised: ${missing.join(', ')}`);
  assert.ok(homed > 5, `only ${homed} aliens got home`);
  assert.ok(bombsDropped > 20, `only ${bombsDropped} bombs dropped`);
  assert.ok(frames >= 12000);
});

test('f_08D3 bomb drop at the edges: height, enables, free bombs, aim', () => {
  const r = rng(300);
  let dropped = 0;
  for (let i = 0; i < 3000; i += 1) {
    const { board, m, poke } = pair();
    randomRam(board, m, r);
    motionWorld(r, poke);
    const k = r.int(12);
    const ix = 0x9100 + 0x14 * k;
    launch(r, poke, k, r.int(0x30) * 2, PATHS);
    poke(ix + 0x0d, 0x40); // mid-segment: no path data read
    if (r.chance(0.5)) { poke(ix + 0x0a, 0); poke(ix + 0x0b, 0); }
    poke(ix + 0x01, 0x4a + r.int(5)); // around the $4C threshold
    poke(ix + 0x0e, 1);
    poke(ix + 0x0f, r.byte());
    poke(0x8800 + m.peek(ix + 0x10), 9);
    for (let l = 0x68; l < 0x78; l += 2) poke(0x8800 + l, r.chance(0.2) ? 0x80 : 6);
    const before = m.peek(0x8868) + m.peek(0x886a);
    callRoutine(board, SUB_CPU, 0x08d3);
    SUB.f_08D3(m);
    same(board, m, `bomb edge #${i}`);
    if (m.peek(0x8868) + m.peek(0x886a) !== before) dropped += 1;
  }
  assert.ok(dropped > 50, `only ${dropped} drops`);
});

// ------------------------------------------------------------ the IRQ

/** Run the IRQ handler on both; the oracle's f_05BF must not wait. */
function irqBoth(board, m) {
  board.poke(0x92d6, 0);
  m.poke(0x92d6, 0);
  callRoutine(board, SUB_CPU, 0x0513);
  SUB.sub_irq(m);
  assert.equal(m.misc[1], board.misc[1], 'IRQ enable latch');
}

test('sub_irq: tasks, frame counters, continuous-bombing flag, freeze', () => {
  for (let seed = 200; seed < 216; seed += 1) {
    const { board, m, poke } = pair();
    const r = rng(seed);
    randomRam(board, m, r);
    motionWorld(r, poke);
    battlefield(r, poke, 0x80, 0x60);
    for (let k = 0; k < 12; k += 1) if (r.chance(0.6)) launch(r, poke, k, (r.int(0x30)) * 2, PATHS);
    // Default task enables, or a random mix (the enable byte is also the
    // skip count, so keep [7] non-zero or the scan runs off the table).
    const tasks = r.chance(0.5) ? [0, 1, 1, 0, 1, 1, 0, 10]
      : [r.int(2), r.int(2), r.int(2), 0, r.int(2), r.int(2), 0, r.pick([1, 10])];
    tasks.forEach((v, i) => poke(0x9020 + i, v));
    poke(0x9014, r.int(2));
    poke(0x92a7, r.int(40));
    poke(0x99c7, r.int(40));
    const freeze = seed % 8 === 7;
    board.dswA = m.dswA = freeze ? 0xe7 : 0xf7;
    for (let f = 0; f < 150; f += 1) {
      poke(0x92a0, f === 0 ? 0x1e : m.peek(0x92a0)); // cross the $1F/$00 edges
      irqBoth(board, m);
      same(board, m, `seed ${seed} frame ${f}`);
    }
  }
});

test('sub_irq replayed on states captured from the attract-mode demo', async () => {
  // Boot the whole board, and capture the RAM every time the sub CPU takes
  // its vblank IRQ while aliens fly in the demo.
  const live = makeOracle(await loadChips());
  /** @type {{video: Uint8Array, ram1: Uint8Array, ram2: Uint8Array, ram3: Uint8Array}[]} */
  const snaps = [];
  let want = false;
  live.onExec = (n, pc) => {
    if (n === SUB_CPU && pc === 0x0038 && want) {
      snaps.push({ video: live.video.slice(), ram1: live.ram1.slice(), ram2: live.ram2.slice(), ram3: live.ram3.slice() });
    }
  };
  for (let f = 0; f < 4000; f += 1) {
    want = f >= 1200 && f % 2 === 0;
    live.runFrame();
  }
  live.onExec = null;
  assert.ok(snaps.length > 1000);
  let flying = 0;
  const { board, m } = pair();
  for (let i = 0; i < snaps.length; i += 1) {
    loadState(board, snaps[i]);
    loadState(m, snaps[i]);
    for (let k = 0; k < 12; k += 1) flying += m.peek(0x9113 + 0x14 * k) & 1;
    irqBoth(board, m);
    same(board, m, `demo snapshot ${i}`);
  }
  assert.ok(flying > 2000, `demo had only ${flying} slot-frames of flying aliens`);
  // And carry one demo state forward on its own for many frames.
  loadState(board, snaps[snaps.length >> 1]);
  loadState(m, board);
  for (let f = 0; f < 600; f += 1) {
    irqBoth(board, m);
    same(board, m, `demo run frame ${f}`);
  }
});

// ------------------------------------------------------------ reset path

/** Step the oracle's sub CPU alone until pred() or the cycle budget. */
function stepSub(board, pred, max = 2_000_000) {
  const z = board.cpus[SUB_CPU];
  let cycles = 0;
  while (!pred(z)) {
    cycles += z.step();
    if (cycles > max) throw new Error(`sub CPU stuck at $${z.pc.toString(16)}`);
  }
  return cycles;
}

test('sub_reset: ROM-check handshake and initialisation', () => {
  const { board, m, poke } = pair();
  const r = rng(8);
  randomRam(board, m, r);
  poke(0x9100, 0x5a); // main CPU still testing RAM
  const z = board.cpus[SUB_CPU];
  z.reset();
  let spins = 0;
  stepSub(board, () => (spins += 1) > 2000); // parked in the first wait
  assert.ok(z.pc >= 0x057f && z.pc <= 0x0581);
  const gen = SUB.sub_reset(m);
  assert.equal(gen.next().value, SPIN);
  assert.equal(gen.next().value, SPIN);
  // Release: the oracle takes about two frames of checksum.
  poke(0x9100, 0);
  const cycles = stepSub(board, () => board.peek(0x9100) !== 0);
  assert.ok(cycles > 2 * 50688 && cycles < 3 * 50688, `checksum took ${cycles} cycles`);
  assert.equal(gen.next().value, undefined);
  assert.equal(m.peek(0x9100), 0);
  assert.equal(gen.next().value, undefined);
  assert.equal(m.peek(0x9100), 0);
  assert.equal(gen.next().value, SPIN); // result posted, waiting for the ack
  same(board, m, 'checksum posted');
  assert.equal(m.peek(0x9100), 0xff);
  poke(0x9100, 0);
  stepSub(board, (c) => c.pc === 0x05b1);
  assert.equal(gen.next().value, undefined); // idle
  same(board, m, 'initialised');
  assert.equal(m.misc[1], board.misc[1]);
  assert.equal(m.iff[SUB_CPU], true);
  assert.equal(z.iff1, 1);
  assert.equal(gen.next().value, undefined); // still idle
});

test('f_0ECA: off by default; with SW1:3 on it restarts the sub CPU', () => {
  const setup = (seed) => {
    const { board, m, poke } = pair();
    randomRam(board, m, rng(seed));
    poke(0x92d6, 0);
    [0, 1, 1, 0, 1, 1, 0, 10].forEach((v, i) => poke(0x9020 + i, v));
    for (let k = 0; k < 12; k += 1) poke(0x9113 + 0x14 * k, 0);
    return { board, m, poke };
  };
  // Default switches: nothing happens.
  {
    const { board, m } = setup(9);
    callRoutine(board, SUB_CPU, 0x0eca);
    assert.equal(SUB.f_0ECA(m), undefined);
    same(board, m, 'f_0ECA off');
  }
  // SW1:3 on: the IRQ ends in rst $00 and CPU1_RESET's first wait.
  const { board, m, poke } = setup(9);
  board.dswA = m.dswA = 0xf3;
  poke(0x9100, 0x77);
  // Bring the port's foreground to its idle loop, then restore the RAM.
  const gen = SUB.sub_reset(m);
  m.poke(0x9100, 0); gen.next(); gen.next(); gen.next();
  m.poke(0x9100, 0); gen.next();
  assert.equal(m.iff[SUB_CPU], true);
  loadState(m, board);
  const z = board.cpus[SUB_CPU];
  z.setRegisters({ pc: 0x0513, sp: 0x9100, iff1: 0, iff2: 0 });
  stepSub(board, (c) => c.pc === 0x057f);
  SUB.sub_irq(m);
  same(board, m, 'IRQ up to rst $00');
  assert.equal(m.misc[1], 0, 'IRQ left disabled');
  assert.equal(board.misc[1], 0);
  assert.equal(SUB.f_0ECA(m), RESTART);
  // The foreground starts over: interrupts off, waiting for $9100 = 0.
  assert.equal(gen.next().value, SPIN);
  assert.equal(m.iff[SUB_CPU], false);
});

test('l_0EDE: the keypad monitor behind f_0ECA', () => {
  const { board, m, poke } = pair();
  const r = rng(10);
  let skipped = 0;
  for (let i = 0; i < 3000; i += 1) {
    randomRam(board, m, r);
    // Key history: mostly quiet, sometimes one fresh key in one row.
    for (let a = 0x89e4; a < 0x89f8; a += 1) poke(a, r.chance(0.7) ? 0 : r.byte());
    if (r.chance(0.6)) {
      const row = r.int(5);
      const bit = 1 << r.int(4);
      poke(0x89e4 + 4 * row, 0); poke(0x89e5 + 4 * row, 0);
      poke(0x89e6 + 4 * row, bit | (r.byte() & 0xf0)); poke(0x89e7 + 4 * row, bit);
    }
    poke(0x89e0, r.pick([0, 1, 2, 3, 4, 5, 6, r.byte()]));
    // Point the edited address at RAM or at sub ROM data (not next to a
    // code byte: the port has only ROM data, see memRead in gg1_5.js).
    poke16(poke, 0x89e2, r.pick([0x8800 + r.int(0x400), 0x9800 + r.int(0x400), r.pick(DATA_PTRS), 0x8000 + r.int(0x800)]));
    callRoutine(board, SUB_CPU, 0x0ede);
    SUB.l_0EDE(m);
    // A digit key can edit the address itself into sub ROM code, which
    // the port cannot read (it has the ROM's data bytes only).
    const p = board.peek(0x89e2) | (board.peek(0x89e3) << 8);
    if (p < 0x4000 && !isData(p)) { skipped += 1; continue; }
    same(board, m, `l_0EDE #${i}`);
  }
  assert.ok(skipped < 300, `${skipped} cases skipped`);
});

/** ROM addresses whose neighbours are data bytes too. */
const DATA_PTRS = PATHS.filter((p) => isData(p - 1) && isData(p) && isData(p + 1));

/** @param {number} a @returns {boolean} a data byte of the sub ROM */
function isData(a) {
  try { romByte('sub', a); return true; } catch { return false; }
}

/** @param {(a: number, v: number) => void} poke @param {number} a @param {number} v */
function poke16(poke, a, v) { poke(a, v & 0xff); poke(a + 1, v >> 8); }
