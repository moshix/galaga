// Copyright 2026 by Moshix
/**
 * Differential tests for main CPU $2000-$2FFF (src/game/main/gg1_3*.js):
 * every routine runs on the Z80 oracle and in the port from the same RAM,
 * and all RAM (stacks excepted) plus the returned registers must match.
 *
 * Routines of other ranges that this range calls are replaced, for the
 * duration of these tests, by shims so the tests do not depend on the other
 * modules' progress:
 *   c_104E_mul_16_8 ($104E), c_divmod ($1061)  run on a scratch Z80 board
 *   c_1000 ($1000)  the randomizer reads the Z80's R register, which the
 *                   port cannot reproduce; the shim replays the values the
 *                   oracle's c_1000 returned during the same call.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeOracle, callRoutine, loadState, diffRam } from '../helpers/oracle.mjs';
import { Machine } from '../../src/machine/machine.js';
import '../../src/game/main/index.js';
import { MAIN } from '../../src/game/main/routines.js';

const board = makeOracle();
const scratch = makeOracle();

/** Values the oracle's c_1000 produced, consumed in order by the shim. */
let randQueue = [];

/** Registers from a Z80 snapshot, in the port's naming. @param {Record<string, number>} r */
function portRegs(r) {
  return {
    a: r.af >> 8, b: r.bc >> 8, c: r.bc & 0xff, d: r.de >> 8, e: r.de & 0xff,
    h: r.hl >> 8, l: r.hl & 0xff, bc: r.bc, de: r.de, hl: r.hl, ix: r.ix, iy: r.iy,
    cf: (r.af & 0x01) !== 0, zf: (r.af & 0x40) !== 0,
  };
}

/**
 * A register-only ROM routine run on the scratch board.
 * @param {number} addr @returns {Function}
 */
function romShim(addr) {
  return (_m, regs = {}) => {
    const z = {};
    if (regs.a !== undefined) z.af = (regs.a & 0xff) << 8;
    for (const k of ['bc', 'de', 'hl', 'ix', 'iy']) if (regs[k] !== undefined) z[k] = regs[k];
    return portRegs(callRoutine(scratch, 0, addr, z));
  };
}

const SHIMS = {
  c_104E_mul_16_8: romShim(0x104e),
  c_divmod: romShim(0x1061),
  c_1000: () => {
    assert.ok(randQueue.length > 0, 'port called c_1000 more often than the ROM');
    return { a: randQueue.shift() };
  },
};
/** @type {Record<string, Function|undefined>} */
const saved = {};
before(() => { for (const k of Object.keys(SHIMS)) { saved[k] = MAIN[k]; MAIN[k] = SHIMS[k]; } });
after(() => { for (const k of Object.keys(SHIMS)) { if (saved[k]) MAIN[k] = saved[k]; else delete MAIN[k]; } });

// ------------------------------------------------------------ utilities

/** mulberry32. @param {number} seed */
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
    byte: () => Math.floor(next() * 256),
    int: (n) => Math.floor(next() * n),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}

/** Fill all shared RAM of the oracle with seeded noise. @param {ReturnType<typeof rng>} r */
function randomRam(r) {
  for (const k of ['video', 'ram1', 'ram2', 'ram3']) {
    const a = board[k];
    for (let i = 0; i < a.length; i += 1) a[i] = r.byte();
  }
}

/** Write a byte into the oracle's RAM. @param {number} addr @param {number} v */
function put(addr, v) {
  const a = addr & 0xffff;
  const val = v & 0xff;
  if (a >= 0x8000 && a < 0x8800) board.video[a - 0x8000] = val;
  else if (a >= 0x8800 && a < 0x8c00) board.ram1[a - 0x8800] = val;
  else if (a >= 0x9000 && a < 0x9400) board.ram2[a - 0x9000] = val;
  else if (a >= 0x9800 && a < 0x9c00) board.ram3[a - 0x9800] = val;
  else throw new Error(`put: $${a.toString(16)} is not RAM`);
}

/**
 * Run the ROM routine on the oracle (recording c_1000's results) and the
 * port routine on a Machine loaded with the same RAM; compare.
 * @param {string} name @param {number} addr
 * @param {Record<string, number>} z80Regs  oracle input registers
 * @param {Record<string, number>} jsRegs   port input registers
 * @param {string} label
 * @returns {{ oracle: ReturnType<typeof portRegs>, port: Record<string, number> | undefined }}
 */
function compare(name, addr, z80Regs, jsRegs, label) {
  const m = new Machine();
  loadState(m, board);
  const z = board.cpus[0];
  const step = z.step;
  const rec = [];
  // c_1000 returns at $1011 (ret) with the random value in A.
  z.step = function stepRecording() {
    const c = step.call(z);
    if (z.pc === 0x1011) rec.push(z.a);
    return c;
  };
  let regs;
  try {
    regs = callRoutine(board, 0, addr, z80Regs);
  } finally {
    z.step = step;
  }
  randQueue = rec;
  const out = MAIN[name](m, jsRegs);
  assert.equal(randQueue.length, 0, `${label}: port used fewer random numbers than the ROM`);
  assert.deepEqual(diffRam(board, m), [], `${label}: RAM differs`);
  return { oracle: portRegs(regs), port: out };
}

// Values from reference/galaga-main.asm and the RAM map.
const WAVE_IDS = [0x58, 0x5a, 0x5c, 0x5e, 0x28, 0x2a, 0x2c, 0x2e, 0x30, 0x34, 0x36, 0x32,
  0x50, 0x52, 0x54, 0x56, 0x42, 0x46, 0x40, 0x44, 0x4a, 0x4e, 0x48, 0x4c, 0x1a, 0x1e,
  0x20, 0x24, 0x22, 0x26, 0x18, 0x1c, 0x08, 0x0c, 0x12, 0x16, 0x10, 0x14, 0x0a, 0x0e];
const BOSS_OBJS = [0x30, 0x32, 0x34, 0x36];

// ------------------------------------------------------------ capture

test('c_2188_ship_spin ($2188)', () => {
  const r = rng(0x2188);
  for (let i = 0; i < 400; i += 1) {
    randomRam(r);
    const l = r.pick([0x62, 0x60, 0x30, 0x34, r.byte()]);
    const base = r.pick([0x9b, 0x93]);
    put(0x8b00 | l, (r.byte() & 0xf8) | r.int(7));
    if (r.chance(0.3)) put((base << 8) | l, r.pick([0, 1]));
    if (r.chance(0.5)) put(0x928d, 0);
    const hl = (base << 8) | l;
    const { oracle, port } = compare('c_2188_ship_spin', 0x2188, { hl }, { hl }, `#${i}`);
    assert.equal(port.b, oracle.b, `#${i} B`);
    if (oracle.b === 1) assert.equal(port.a, oracle.a, `#${i} A`);
  }
});

test('f_2000 rescued fighter rejoins ($2000)', () => {
  const r = rng(0x2000);
  for (let i = 0; i < 800; i += 1) {
    randomRam(r);
    const obj = r.pick(BOSS_OBJS);
    put(0x9828, obj);
    put(0x8800 | obj, r.chance(0.9) ? 0 : r.byte());
    put(0x928b, r.pick([0, 1, 2, 3, 2, 3]));
    put(0x9215, r.pick([0, 1]));
    put(0x9300 | obj, r.pick([0x80, 0x80, 0x7f, 0x81, 0x00, 0xff, r.byte()]));
    put(0x9301 | obj, r.pick([0x29, 0x37, 0xff, 0x00, r.byte()]));
    put(0x9b01 | obj, r.pick([0, 1, r.byte()]));
    put(0x8b62, r.pick([6, 7, r.byte()]));
    put(0x9362, r.pick([0x71, 0x70, 0x72, 0x00, 0xf0, r.byte()]));
    if (r.chance(0.5)) { put(0x9287, 0); put(0x92ad, 0); }
    put(0x9b00 | obj, r.byte());
    if (r.chance(0.3)) { put(0x9b00 | obj, 0); put(0x8b00 | obj, 6); put(0x928d, 0); }
    compare('f_2000', 0x2000, {}, {}, `#${i}`);
  }
});

test('f_20F2 beam pulls the fighter up ($20F2)', () => {
  const r = rng(0x20f2);
  for (let i = 0; i < 800; i += 1) {
    randomRam(r);
    const obj = r.pick(BOSS_OBJS);
    put(0x9828, obj);
    put(0x9b62, r.pick([0, 1, 2, 3, r.byte()]));
    put(0x8b62, r.pick([6, 0, 3, r.byte()]));
    put(0x928d, r.pick([0, 1]));
    put(0x928b, r.pick([0, 0x80, 0x40, r.byte()]));
    put(0x9015, r.pick([0, 1]));
    put(0x9215, r.pick([0, 1]));
    put(0x9362, r.byte());
    put(0x9300 | obj, r.chance(0.3) ? board.ram2[0x362] : r.byte());
    put(0x9363, r.pick([0x7a, 0x79, 0x80, 0x7f, 0xe6, 0xe7, 0xe0, 0xe1, 0x00, 0x37, 0x29, 0xff, r.byte()]));
    compare('f_20F2', 0x20f2, {}, {}, `#${i}`);
  }
});

test('f_21CB capture boss dives into position ($21CB)', () => {
  const r = rng(0x21cb);
  for (let i = 0; i < 600; i += 1) {
    randomRam(r);
    const obj = r.pick(BOSS_OBJS);
    put(0x9828, obj);
    put(0x8800 | obj, r.chance(0.8) ? 9 : r.byte());
    const slot = r.pick([0x00, 0x14, 0x28, 0x3c, 0x50, 0xdc, 0xf0, r.byte()]);
    put(0x9829, slot);
    const ix = 0x9100 + slot;
    if (r.chance(0.7)) put(ix + 0x0a, 0);
    put(ix + 0x04, r.byte());
    put(ix + 0x05, r.byte());
    if (r.chance(0.4)) { put(ix + 0x04, 0xf0 + r.int(0x20)); put(ix + 0x05, r.int(2)); }
    compare('f_21CB', 0x21cb, {}, {}, `#${i}`);
  }
});

test('f_2222 tractor beam ($2222)', () => {
  const r = rng(0x2222);
  for (let i = 0; i < 1500; i += 1) {
    randomRam(r);
    const obj = r.pick(BOSS_OBJS);
    put(0x9828, obj);
    put(0x8800 | obj, r.chance(0.8) ? 9 : r.byte());
    put(0x9829, r.pick([0x00, 0x14, 0x28, 0x3c, 0x50, 0xdc]));
    // Beam states that stay inside d_23A1 (row 1-10), as in the game.
    put(0x928b, r.pick([0x00, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xe0]) | r.int(11));
    if (r.chance(0.2)) put(0x928b, 0x40);
    put(0x928c, r.pick([1, 1, 2, r.byte()]));
    put(0x982a, r.pick([1, 3, 5, 0x0a]));
    put(0x928a, r.byte());
    put(0x920d, r.pick([0, 1]));
    put(0x9215, r.pick([0, 1, r.byte()]));
    put(0x9201, r.pick([1, 3, r.byte()]));
    put(0x9014, r.pick([0, 1]));
    put(0x9213, r.pick([0, 1]));
    if (r.chance(0.5)) put(0x9362, (board.ram2[0x28a] + r.int(0x40) - 0x20) & 0xff);
    put(0x92a0, r.byte());
    compare('f_2222', 0x2222, {}, {}, `#${i}`);
  }
});

test('c_238A beam row address ($238A)', () => {
  const r = rng(0x238a);
  for (let i = 0; i < 300; i += 1) {
    randomRam(r);
    const a = r.byte();
    const { oracle, port } = compare('c_238A', 0x238a, { af: a << 8 }, { a }, `#${i}`);
    assert.equal(port.de, oracle.de, `#${i} DE`);
  }
});

// ------------------------------------------------------------ objects

/** A plausible object table at $8800 with matching side tables. @param {ReturnType<typeof rng>} r */
function objectStates(r) {
  for (let e = 0; e < 0x80; e += 2) {
    // Only objects $00-$5F have a home position (db_obj_home_posn_rc at
    // $0100-$015F), so only they can rest (1), rotate home (2) or dive (9).
    const s = e < 0x60
      ? r.pick([0x80, 0x80, 0x81, 0xff, 0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9])
      : r.pick([0x80, 0x80, 0xff, 0, 3, 4, 5, 6, 7, 8]);
    put(0x8800 + e, s);
    let odd = r.byte();
    if (s === 4) odd = 0x40 + r.int(6);
    if (s === 9 || s === 3) odd = r.pick([0x00, 0x14, 0x28, 0x3c, 0xdc, r.byte()]);
    if (s === 8 || s === 5) odd = r.pick([1, 2, 4, 5, 0x0f, 0x13, 0, r.byte()]);
    put(0x8801 + e, odd);
    put(0x9200 + e, r.pick([1, 1, 0x35, 0x37, 0x38, 0x3a, 0x3b, 0x3d, r.byte()]));
    if (r.chance(0.3)) put(0x9380 + e, r.pick([0xf4, 0xf3, 0x10]));
    if (r.chance(0.3)) put(0x9381 + e, r.pick([0x16, 0x14, 0x4a, 0x4b, 0x49]));
  }
  put(0x920b, r.pick([0, 1]));
}

test('c_23E0 object state machine ($23E0)', () => {
  const r = rng(0x23e0);
  for (let i = 0; i < 600; i += 1) {
    randomRam(r);
    objectStates(r);
    const a = r.byte();
    compare('c_23E0', 0x23e0, { af: a << 8 }, { a }, `#${i} A=${a}`);
  }
});

test('f_23DD object task ($23DD)', () => {
  const r = rng(0x23dd);
  for (let i = 0; i < 200; i += 1) {
    randomRam(r);
    objectStates(r);
    compare('f_23DD', 0x23dd, {}, {}, `#${i}`);
  }
});

// ------------------------------------------------------------ waves

test('c_2C00 new stage parameters ($2C00)', () => {
  const r = rng(0x2c00);
  for (let stage = 0; stage < 64; stage += 1) {
    for (let rank = 0; rank < 4; rank += 1) {
      randomRam(r);
      put(0x9821, stage);
      put(0x9984, rank);
      compare('c_2C00', 0x2c00, {}, {}, `stage ${stage} rank ${rank}`);
    }
  }
  for (let i = 0; i < 20; i += 1) {
    randomRam(r);
    put(0x9984, r.int(4));
    compare('c_2C00', 0x2c00, {}, {}, `random #${i}`);
  }
});

test('c_2896 creature codes / stage init ($2896)', () => {
  const r = rng(0x2896);
  for (let stage = 0; stage < 80; stage += 1) {
    randomRam(r);
    put(0x9821, stage);
    put(0x9825, r.chance(0.5) ? 0 : (stage + 1) & 3);
    compare('c_2896', 0x2896, {}, {}, `stage ${stage}`);
  }
});

test('c_28E9 one creature class ($28E9)', () => {
  const r = rng(0x28e9);
  for (let i = 0; i < 100; i += 1) {
    randomRam(r);
    const b = 1 + r.int(0x14);
    const c = r.byte();
    const hl = 0x8b00 | (r.int(0x40) * 2);
    const ix = (r.byte() << 8) | (1 + r.int(8));
    const iy = 0x2908 + r.int(3);
    const regs = { b, c, hl, ix, iy };
    const { oracle, port } = compare('c_28E9', 0x28e9,
      { bc: (b << 8) | c, hl, ix, iy }, regs, `#${i}`);
    for (const k of ['c', 'hl', 'ix', 'iy']) assert.equal(port[k], oracle[k], `#${i} ${k}`);
  }
});

test('c_25A2 attack wave table ($25A2)', () => {
  const r = rng(0x25a2);
  for (let i = 0; i < 300; i += 1) {
    randomRam(r);
    // The stage counter starts at 1; stage 0 would index before the tables.
    const stage = i < 120 ? 1 + (i % 40) : 1 + r.int(80);
    put(0x9821, stage);
    put(0x9825, (stage + 1) & 3);
    put(0x9984, r.int(4));
    put(0x982b, r.pick([0, 1]));
    put(0x9827, r.pick([0, 1]));
    // R feeds the randomizer; vary it.
    compare('c_25A2', 0x25a2, { r: r.byte() }, {}, `#${i} stage ${stage}`);
  }
});

test('f_2916 launch attack waves ($2916)', () => {
  const r = rng(0x2916);
  for (let i = 0; i < 1500; i += 1) {
    randomRam(r);
    const p = 0x8920 + r.int(0x50);
    put(0x9822, p & 0xff);
    put(0x9823, p >> 8);
    const kind = r.int(4);
    if (kind === 0) put(p, 0x7f);
    else if (kind === 1) put(p, 0x7e);
    else {
      // A (flight-control, object ID) pair as c_25A2 builds them.
      put(p, (r.byte() & 0xc0) | r.int(0x18));
      const id = r.pick([...WAVE_IDS, 0x04, 0x38 | r.int(8), 0x78 | r.int(8)]);
      put(p + 1, id);
    }
    put(0x9842, r.pick([0, 1, 1]));
    put(0x9287, r.pick([0, 0, 3]));
    put(0x9825, r.pick([0, 1, 2]));
    put(0x92ac, r.pick([0, 1, 2]));
    put(0x9826, r.pick([1, 2, 3]));
    for (let s = 0; s < 12; s += 1) {
      put(0x9113 + 0x14 * s, r.chance(0.6) ? (r.byte() | 1) : (r.byte() & 0xfe));
    }
    if (r.chance(0.1)) for (let s = 0; s < 12; s += 1) put(0x9113 + 0x14 * s, 1);
    compare('f_2916', 0x2916, {}, {}, `#${i}`);
  }
});

test('f_2A90 formation sway ($2A90)', () => {
  const r = rng(0x2a90);
  for (let i = 0; i < 600; i += 1) {
    randomRam(r);
    put(0x92a0, r.byte());
    put(0x92a7, r.pick([0, 5]));
    put(0x9008, r.pick([0, 1]));
    put(0x920f, r.pick([0, 1, r.byte()]));
    put(0x9824, r.pick([0, 1]));
    put(0x9900, r.pick([0x1f, 0x20, 0x21, 0xdf, 0xe0, 0xe1, 0xff, 0x00, 0x01, r.byte()]));
    compare('f_2A90', 0x2a90, {}, {}, `#${i}`);
  }
});

// ------------------------------------------------------------ lock-step

test('stage start in lock step: c_2C00, c_2896, c_25A2, then 400 frames of '
  + 'f_2916 / f_23DD / f_2A90', () => {
  const r = rng(0x5eed);
  for (let run = 0; run < 12; run += 1) {
    randomRam(r);
    const stage = 1 + r.int(30);
    put(0x9821, stage);
    put(0x9825, (stage + 1) & 3);
    put(0x9984, r.int(4));
    put(0x982b, 0);
    put(0x9827, 0);
    put(0x9842, 1);
    put(0x9287, 0);
    put(0x92ac, 0);
    put(0x9826, 0);
    put(0x920f, 0);
    put(0x9824, 0);
    put(0x9008, 1);
    for (let s = 0; s < 12; s += 1) put(0x9113 + 0x14 * s, 0);
    for (let e = 0; e < 0x80; e += 2) put(0x8800 + e, 0x80);
    compare('c_2C00', 0x2c00, {}, {}, `run ${run} c_2C00`);
    compare('c_2896', 0x2896, {}, {}, `run ${run} c_2896`);
    compare('c_25A2', 0x25a2, { r: r.byte() }, {}, `run ${run} c_25A2`);
    for (let f = 0; f < 400; f += 1) {
      put(0x92a0, (board.ram2[0x2a0] + 1) & 0xff);
      // Free a motion queue slot now and then, as the sub CPU would.
      if (r.chance(0.2)) put(0x9113 + 0x14 * r.int(12), 0);
      compare('f_2916', 0x2916, {}, {}, `run ${run} frame ${f} f_2916`);
      compare('f_23DD', 0x23dd, {}, {}, `run ${run} frame ${f} f_23DD`);
      compare('f_2A90', 0x2a90, {}, {}, `run ${run} frame ${f} f_2A90`);
    }
  }
});
