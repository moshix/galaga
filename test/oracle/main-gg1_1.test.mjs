// Copyright 2026 by Moshix
/**
 * Oracle tests for main CPU $0000-$0FFF (src/game/main/gg1_1*.js).
 *
 * Every routine runs twice from identical, seeded-random RAM: the real ROM
 * code on the emulated board, and the port on a Machine. RAM (stacks
 * excluded), the video/IRQ latches and the returned registers must match.
 *
 * ISOLATION. Routines of the other ranges are replaced in this process by
 * ROM-backed stubs (unless GG1_1_INTEGRATION=1 is set, see below): the stub copies the port's RAM into a scratch board,
 * runs the ORIGINAL routine there, and copies the RAM back. So these tests
 * check this range alone, whatever state the other ports are in, and the
 * stubs are exact by construction. Routines that wait (c_tdelay_3,
 * c_new_level_tokens, c_player_respawn) get a generator stub that yields
 * at the ROM's own wait loops.
 *
 * FOREGROUND. The game-flow blocks are run in lock-step with the oracle
 * CPU: the oracle steps until it reaches a known wait loop whose condition
 * holds (or a block exit), the port generator is resumed until it yields
 * (or returns); RAM is compared; then the same "frame" (a test-defined
 * change to the waited-on variables, standing in for the vblank tasks) is
 * applied to both, and so on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOracle, loadChips, loadState, diffRam } from '../helpers/oracle.mjs';
import { Machine } from '../../src/machine/machine.js';
import '../../src/game/main/gg1_1.js';
import { MAIN, MAIN_AT } from '../../src/game/main/routines.js';
import { FLOW } from '../../src/game/main/gg1_1_flow.js';
import { mainState } from '../../src/game/main/gg1_1_state.js';
import { mainRom } from '../../src/game/romdata.js';

// ------------------------------------------------------------ utilities

/** Seeded PRNG (mulberry32). @param {number} seed @returns {() => number} 0..1 */
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

/** @param {() => number} r @param {number} n @returns {number} 0..n-1 */
const ri = (r, n) => Math.floor(r() * n);

const ORACLE = makeOracle();
/** Scratch boards for the ROM-backed stubs (one per nesting depth). */
const SCRATCH = [];

/**
 * A fresh pair (oracle board, port Machine) with the same random RAM.
 * @param {number} seed
 * @param {{ dswA?: number, dswB?: number }} [dsw]
 */
function pair(seed, dsw = {}) {
  const board = ORACLE;
  const r = rng(seed);
  for (const k of ['video', 'ram1', 'ram2', 'ram3']) {
    for (let i = 0; i < board[k].length; i += 1) board[k][i] = ri(r, 256);
  }
  board.misc.fill(0);
  board.videoLatch.fill(0);
  board.dswA = dsw.dswA ?? 0xf7;
  board.dswB = dsw.dswB ?? 0x97;
  R_VALUES.length = 0;
  const m = new Machine();
  replayR(m);
  loadState(m, board);
  m.dswA = board.dswA;
  m.dswB = board.dswB;
  return { board, m, r };
}

/**
 * The port's c_1000 reads R through m.readR(): feed it the oracle's values
 * (integration mode; the stubs replay them on their own).
 * @param {Machine} m
 */
function replayR(m) {
  m.readR = () => (R_VALUES.length > 0 ? /** @type {number} */ (R_VALUES.shift()) : 0);
}

/** Poke the same byte into both. */
function both(board, m, addr, v) {
  board.poke(addr, v);
  m.poke(addr, v);
}

/** @param {object} board @param {Machine} m @param {string} what */
function same(board, m, what) {
  assert.deepEqual(diffRam(board, m), [], `${what}: RAM differs`);
}

/** @param {object} board @param {Machine} m @param {string} what */
function sameLatches(board, m, what) {
  assert.deepEqual([...m.videoLatch], [...board.videoLatch], `${what}: $A000 latch`);
  assert.deepEqual([...m.misc], [...board.misc], `${what}: $6820 latch`);
}

/** Z80 register set from the port's register-object convention. */
function toZ80(regs = {}) {
  const out = {};
  const pairs = { bc: ['b', 'c'], de: ['d', 'e'], hl: ['h', 'l'] };
  for (const [p, [hi, lo]] of Object.entries(pairs)) {
    let v = regs[p] ?? 0;
    if (regs[hi] !== undefined) v = (v & 0x00ff) | ((regs[hi] & 0xff) << 8);
    if (regs[lo] !== undefined) v = (v & 0xff00) | (regs[lo] & 0xff);
    out[p] = v;
  }
  out.af = ((regs.a ?? 0) << 8) | (regs.cf ? 1 : 0);
  if (regs.ix !== undefined) out.ix = regs.ix;
  if (regs.iy !== undefined) out.iy = regs.iy;
  return out;
}

/** The port convention's view of a Z80 register set. */
function fromZ80(z) {
  const a = z.af >> 8;
  return {
    a, f: z.af & 0xff, cf: (z.af & 1) !== 0, zf: (z.af & 0x40) !== 0,
    bc: z.bc, de: z.de, hl: z.hl, b: z.bc >> 8, c: z.bc & 0xff,
    d: z.de >> 8, e: z.de & 0xff, h: z.hl >> 8, l: z.hl & 0xff, ix: z.ix, iy: z.iy,
  };
}

/**
 * The RNG at $1000 reads the Z80 R register (`ld a,r` at $1001 and $100D),
 * which differs between the oracle and a scratch board. The oracle records
 * the values it reads; scratch boards replay them in the same order.
 * @type {number[]}
 */
const R_VALUES = [];
const R_READS = [0x1001, 0x100d];

/**
 * Execute one instruction, recording (oracle) or replaying (scratch) the
 * values `ld a,r` loads.
 * @param {object} board @param {boolean} replay
 */
function step1(board, replay) {
  const z = board.cpus[0];
  const pc = z.pc;
  z.step();
  if (!R_READS.includes(pc) || z.pc === pc) return;
  if (!replay) R_VALUES.push(z.a);
  else if (R_VALUES.length > 0) z.a = /** @type {number} */ (R_VALUES.shift());
}

/**
 * callRoutine with R recording/replay.
 * @param {object} board @param {number} addr @param {object} regs @param {boolean} replay
 */
function z80Call(board, addr, regs, replay) {
  const z = board.cpus[0];
  z.setRegisters({ ...regs, pc: addr, sp: 0x90a0, iff1: 0, iff2: 0, halted: false });
  z.push16(0x3fff);
  for (let n = 0; !(z.pc === 0x3fff && z.sp === 0x90a0); n += 1) {
    if (n > 5_000_000) throw new Error(`$${addr.toString(16)} did not return (pc $${z.pc.toString(16)})`);
    step1(board, replay);
  }
  return z.getRegisters();
}

let depth = 0;
/** @param {Machine} m */
function scratchFor(m) {
  if (!SCRATCH[depth]) SCRATCH[depth] = makeOracle();
  const sb = SCRATCH[depth];
  loadState(sb, m);
  sb.dswA = m.dswA;
  sb.dswB = m.dswB;
  return sb;
}

/**
 * Plain stub: run ROM routine `addr` on a scratch board with the port's RAM.
 * @param {number} addr @param {(regs: object) => object} [mapRegs]
 */
function romStub(addr, mapRegs = toZ80) {
  return (m, regs = {}) => {
    const sb = scratchFor(m);
    depth += 1;
    try {
      const out = z80Call(sb, addr, mapRegs(regs), true);
      loadState(m, sb);
      return fromZ80(out);
    } finally {
      depth -= 1;
    }
  };
}

/**
 * Wait loops of the ROM, as (pc, still-waiting?) pairs. The oracle and the
 * waiting stubs yield when they reach one whose condition holds.
 * @typedef {{ pc: number, cond: (b: object) => boolean, halt?: boolean }} Wait
 */
/** @type {Wait[]} */
const EXT_WAITS = [
  { pc: 0x1337, cond: (b) => b.peek(0x92af) !== 0 }, // c_tdelay_3
  { pc: 0x121d, cond: (b) => b.peek(0x92a0) !== b.cpus[0].e }, // c_build_token_1
  { pc: 0x134c, cond: (b) => b.peek(0x9287) !== 0 }, // c_player_respawn
];

/**
 * Step the oracle CPU (interrupts never taken) until it returns to the
 * sentinel, reaches an exit pc, or blocks in a wait loop.
 * @returns {Generator<number, {pc: number, regs: object}, void>}
 */
function* stepZ80(board, waits, exits = [], untilReturnSp = null, replay = false) {
  const z = board.cpus[0];
  let first = true;
  for (let n = 0; ; n += 1) {
    if (n > 20_000_000) throw new Error(`oracle ran away at $${z.pc.toString(16)}`);
    if (untilReturnSp !== null && z.pc === 0x3fff && z.sp === untilReturnSp) {
      return { pc: z.pc, regs: z.getRegisters() };
    }
    if (!first && exits.includes(z.pc)) return { pc: z.pc, regs: z.getRegisters() };
    if (z.halted) {
      const w = waits.find((x) => x.halt && x.pc === z.pc);
      if (w === undefined) {
        // halt with no frame to wait for (woken by an NMI): just go on.
        z.halted = false;
      } else {
        yield z.pc;
        z.halted = false;
      }
      continue;
    }
    if (!first) {
      const w = waits.find((x) => !x.halt && x.pc === z.pc && x.cond(board));
      if (w !== undefined) yield z.pc;
    }
    first = false;
    step1(board, replay);
  }
}

/**
 * Waiting stub: runs ROM routine `addr` on a scratch board, yielding at the
 * ROM's wait loops with the port's RAM kept in sync around each yield.
 */
function romGenStub(addr, mapRegs = toZ80) {
  return function* stub(m, regs = {}) {
    const sb = makeOracle();
    loadState(sb, m);
    sb.dswA = m.dswA;
    sb.dswB = m.dswB;
    const z = sb.cpus[0];
    z.setRegisters({ ...mapRegs(regs), pc: addr, sp: 0x90a0, iff1: 0, iff2: 0 });
    z.push16(0x3fff);
    const it = stepZ80(sb, EXT_WAITS, [], 0x90a0, true);
    for (;;) {
      const r = it.next();
      loadState(m, sb);
      if (r.done) return fromZ80(r.value.regs);
      yield;
      loadState(sb, m);
    }
  };
}

// The two routines that take A' and Cy' through AF' get it as `af_`.
const altRegs = (regs) => ({ ...toZ80(regs), af: 0, af_: regs.af_ ?? 0 });

/**
 * GG1_1_INTEGRATION=1 runs the same tests against the other ranges' real
 * ports (src/game/main/index.js) instead of the ROM-backed stubs.
 */
const INTEGRATION = Boolean(process.env.GG1_1_INTEGRATION);
if (INTEGRATION) await import('../../src/game/main/index.js');

// Everything this range calls in other ranges (name, address).
if (!INTEGRATION) Object.assign(MAIN, {
  c_divmod: romStub(0x1061),
  c_104E_mul_16_8: romStub(0x104e),
  draw_resv_ships: romStub(0x137e),
  c_string_out: romStub(0x13b3),
  j_string_out_pe: romStub(0x13b5, altRegs),
  c_sprite_tiles_displ: romStub(0x129e),
  c_1230_init_taskman_structs: romStub(0x1242),
  c_game_or_demo_init: romStub(0x127b),
  c_player_active_switch: romStub(0x110c),
  c_12C3: romStub(0x12d5),
  c_2896: romStub(0x2896),
  c_25A2: romStub(0x25a2),
  c_2C00: romStub(0x2c00),
  c_top5_dlg_proc: romStub(0x3000),
  c_tdelay_3: romGenStub(0x1331),
  c_new_level_tokens: romGenStub(0x117f, altRegs),
  c_player_respawn: romGenStub(0x133d),
});

/**
 * Run a ROM routine and the port routine from the current (equal) state.
 * @returns {{ z: object, p: object }} oracle registers (port view), port result
 */
function runBoth(board, m, addr, regs = {}) {
  const z = fromZ80(z80Call(board, addr, toZ80(regs), false));
  const p = MAIN_AT[addr] ? MAIN_AT[addr](m, regs) : undefined;
  return { z, p };
}

// ------------------------------------------------------- RST helpers

test('rst $08/$10/$18/$20/$28', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const { board, m, r } = pair(seed);
    const a = ri(r, 256);
    const hl = ri(r, 0x10000);
    let { z, p } = runBoth(board, m, 0x0008, { a, hl });
    assert.equal(p.hl, z.hl, 'rst08 hl'); assert.equal(p.a, z.a, 'rst08 a');
    ({ z, p } = runBoth(board, m, 0x0010, { a, hl }));
    assert.equal(p.hl, z.hl, 'rst10 hl'); assert.equal(p.a, z.a, 'rst10 a');
    assert.equal(p.cf, z.cf, 'rst10 cf');
    const de = ri(r, 0x10000);
    ({ z, p } = runBoth(board, m, 0x0020, { de }));
    assert.equal(p.de, z.de); assert.equal(p.a, z.a);
    const dst = 0x8000 + ri(r, 0x300);
    const b = ri(r, 256);
    ({ z, p } = runBoth(board, m, 0x0018, { a, b, hl: dst }));
    assert.equal(p.hl, z.hl); assert.equal(p.b, z.b);
    same(board, m, 'rst18');
    runBoth(board, m, 0x0028);
    same(board, m, 'rst28');
  }
});

test('c_sctrl_sprite_ram_clr, c_sctrl_playfld_clr, c_textout_1uphighscore_onetime', () => {
  for (const addr of [0x003c, 0x0160, 0x00d6]) {
    const { board, m } = pair(addr);
    const { z, p } = runBoth(board, m, addr);
    same(board, m, `$${addr.toString(16)}`);
    assert.equal(p.hl, z.hl, 'hl');
  }
});

// ------------------------------------------------------- score manager

/** Random score characters: digits, some leading blanks. */
function randomScore(r, board, m, hiAddr, n = 6) {
  const lead = ri(r, n);
  for (let i = 0; i < n; i += 1) {
    // hiAddr is the most significant (leftmost) character; digits run to lower addresses.
    const v = i < lead && ri(r, 3) ? 0x24 : ri(r, 10);
    both(board, m, hiAddr - i, v);
  }
}

test('c_scoreman_incr_add', () => {
  for (let seed = 100; seed < 260; seed += 1) {
    const { board, m, r } = pair(seed);
    const base = 0x83f9;
    for (let i = 0; i < 6; i += 1) both(board, m, base + i, ri(r, 5) ? ri(r, 10) : (ri(r, 2) ? 9 : 0x24));
    const a = ri(r, 12);
    const { z, p } = runBoth(board, m, 0x07d8, { a, hl: base + ri(r, 2) });
    same(board, m, `seed ${seed}`);
    assert.equal(p.hl, z.hl, 'hl');
  }
});

test('gctl_supv_score: points, high score, bonus ships', () => {
  for (let seed = 300; seed < 500; seed += 1) {
    const { board, m, r } = pair(seed);
    both(board, m, 0x9840, ri(r, 2));
    randomScore(r, board, m, 0x83fd); // player 1: $83F8-$83FD
    randomScore(r, board, m, 0x83e8); // player 2: $83E3-$83E8
    randomScore(r, board, m, 0x83f2); // high score: $83ED-$83F2
    if (ri(r, 3) === 0) {
      // Equal to the high score in the leading digits.
      const src = m.peek(0x9840) ? 0x83e8 : 0x83fd;
      const k = ri(r, 6);
      for (let i = 0; i < k; i += 1) both(board, m, 0x83f2 - i, m.peek(src - i));
    }
    for (let i = 0; i < 16; i += 1) both(board, m, 0x9290 + i, ri(r, 3) ? 0 : ri(r, 4));
    // Bonus threshold = the current score / 10000 sometimes, so a ship is due.
    const src = m.peek(0x9840) ? 0x83e8 : 0x83fd;
    const d = (v) => (v === 0x24 ? 0 : v);
    if (ri(r, 2)) both(board, m, 0x983e, (d(m.peek(src)) * 10 + d(m.peek(src - 1))) & 0xff);
    if (ri(r, 2)) both(board, m, 0x9981, ri(r, 2) ? ri(r, 0x80) : ri(r, 256));
    both(board, m, 0x9820, ri(r, 5));
    if (ri(r, 2)) both(board, m, 0x99eb, 0x99);
    runBoth(board, m, 0x0728);
    same(board, m, `seed ${seed}`);
  }
});

test('gctl_supv_stage', () => {
  for (let seed = 500; seed < 540; seed += 1) {
    const { board, m, r } = pair(seed);
    both(board, m, 0x9008, ri(r, 2) ? 0 : 1);
    both(board, m, 0x92a7, ri(r, 2) ? 0 : ri(r, 40));
    both(board, m, 0x9213, ri(r, 2) ? 0 : 1);
    // The ROM pops the return address and jumps to $049E on restart; run it
    // until either it returns or reaches $049E.
    const z = board.cpus[0];
    z.setRegisters({ pc: 0x080b, sp: 0x90a0, iff1: 0, iff2: 0 });
    z.push16(0x3fff);
    while (z.pc !== 0x3fff && z.pc !== 0x049e) z.step();
    const p = MAIN.gctl_supv_stage(m);
    assert.equal(p.restart, z.pc === 0x049e, 'restart');
    same(board, m, `seed ${seed}`);
  }
});

test('c_mach_info_add_score', () => {
  for (let seed = 600; seed < 700; seed += 1) {
    const { board, m, r } = pair(seed);
    const de = ri(r, 2) ? 0x83f9 : 0x83e4;
    for (let i = 0; i < 5; i += 1) both(board, m, de + i, ri(r, 4) ? ri(r, 10) : 0x24);
    for (let i = 0; i < 4; i += 1) both(board, m, 0x99e2 + i, ri(r, 10) * 16 + ri(r, 10));
    runBoth(board, m, 0x0a27, { de });
    same(board, m, `seed ${seed}`);
  }
});

test('c_text_out_i_to_d', () => {
  for (let seed = 700; seed < 800; seed += 1) {
    const { board, m, r } = pair(seed);
    const hl = [ri(r, 10), ri(r, 100), ri(r, 1000), ri(r, 0x10000)][seed % 4];
    const de = 0x8100 + ri(r, 0x80);
    const { z, p } = runBoth(board, m, 0x0a53, { hl, de });
    same(board, m, `seed ${seed}`);
    assert.equal(p.de, z.de, 'de');
    assert.equal(p.a, z.a, 'a');
    assert.equal(p.hl, z.hl, 'hl');
  }
});

test('c_0A72_puts_hitmiss_ratio', () => {
  for (let seed = 800; seed < 1000; seed += 1) {
    const { board, m, r } = pair(seed);
    const shots = [0, ri(r, 10), ri(r, 500), ri(r, 0x10000)][seed % 4];
    let hits = shots === 0 ? ri(r, 50) : ri(r, shots + 1);
    if (seed % 9 === 0) hits = ri(r, 0x10000); // more hits than shots
    both(board, m, 0x9844, hits & 0xff); both(board, m, 0x9845, hits >> 8);
    both(board, m, 0x9846, shots & 0xff); both(board, m, 0x9847, shots >> 8);
    const { z, p } = runBoth(board, m, 0x0a72);
    same(board, m, `seed ${seed} hits ${hits} shots ${shots}`);
    assert.equal(p.de, z.de, 'de');
  }
});

test('c_0B06', () => {
  for (let seed = 1000; seed < 1020; seed += 1) {
    const { board, m, r } = pair(seed);
    const hl = ri(r, 0x10000);
    const { z, p } = runBoth(board, m, 0x0b06, { hl });
    assert.equal(p.a, z.a); assert.equal(p.hl, z.hl);
  }
});

// ------------------------------------------------------------- tasks

test('f_0828', () => {
  const { board, m } = pair(1100);
  both(board, m, 0x92d7, 0);
  runBoth(board, m, 0x0828);
  same(board, m, 'f_0828');
});

test('f_0857, c_08AD, c_08BE', () => {
  for (let seed = 1200; seed < 1400; seed += 1) {
    const { board, m, r } = pair(seed);
    both(board, m, 0x92ae, [0, ri(r, 0x28), ri(r, 0x3c), ri(r, 256)][seed % 4]);
    both(board, m, 0x92a7, seed % 5 ? ri(r, 41) : 40);
    // Stage parameters in the ranges the stage tables produce.
    both(board, m, 0x99c0, ri(r, 8));
    both(board, m, 0x99c1, ri(r, 3));
    for (let i = 2; i < 4; i += 1) both(board, m, 0x99c0 + i, ri(r, 10));
    both(board, m, 0x92aa, ri(r, 2) ? 0 : 1);
    // The task manager leaves DE = $00A1 when it calls slot 5.
    z80Call(board, 0x0857, { de: 0x00a1 }, false);
    MAIN.f_0857(m, { e: 0xa1 });
    same(board, m, `seed ${seed}`);
    const a = ri(r, 10);
    const b = [0, ri(r, 0x28), ri(r, 256)][seed % 3];
    let { z, p } = runBoth(board, m, 0x08ad, { a, b, hl: 0x08cd });
    assert.equal(p.a, z.a); assert.equal(p.hl, z.hl);
    const c = ri(r, 41);
    const e = ri(r, 256);
    ({ z, p } = runBoth(board, m, 0x08be, { a: ri(r, 8), c, e, hl: 0x0909 }));
    assert.equal(p.a, z.a); assert.equal(p.hl, z.hl); assert.equal(p.de, z.de);
    // Parameter 1 = 2 with 40 enemies reads the code byte at $0935.
    ({ z, p } = runBoth(board, m, 0x08be, { a: 2, c: 40 + ri(r, 40), e, hl: 0x0929 }));
    assert.equal(p.a, z.a); assert.equal(p.hl, z.hl);
  }
});

test('f_0935, c_093C, c_095F', () => {
  for (let seed = 1400; seed < 1480; seed += 1) {
    const { board, m, r } = pair(seed);
    both(board, m, 0x9201, ri(r, 3) ? 3 : ri(r, 4));
    both(board, m, 0x9840, ri(r, 2));
    both(board, m, 0x99b3, ri(r, 2));
    runBoth(board, m, 0x0935);
    same(board, m, `f_0935 seed ${seed}`);
    runBoth(board, m, 0x093c, { a: ri(r, 256) });
    same(board, m, `c_093C seed ${seed}`);
  }
});

test('f_0977: play time, credits, free play, game start, coins', () => {
  for (let seed = 1500; seed < 1900; seed += 1) {
    const { board, m, r } = pair(seed);
    const bcd = () => ri(r, 10) * 16 + ri(r, 10);
    both(board, m, 0x9201, ri(r, 4));
    const sw = [0, bcd(), 0xa0, 0x01, 0x02][ri(r, 5)];
    both(board, m, 0x99b5, sw);
    const old = [sw, bcd(), 0xa0, (sw + 1) & 0xff, (sw + 2) & 0xff, 0][ri(r, 6)];
    both(board, m, 0x99b8, old);
    for (let i = 0; i < 4; i += 1) both(board, m, 0x99e6 + i, bcd());
    if (ri(r, 3) === 0) both(board, m, 0x99e9, 0x59);
    if (ri(r, 5) === 0) both(board, m, 0x99e9, 0x60 + ri(r, 0x40));
    runBoth(board, m, 0x0977);
    same(board, m, `seed ${seed}`);
  }
});

test('f_0977 with $BB requests the RAM test and stops the task manager', () => {
  const { m } = pair(1990);
  m.poke(0x99b5, 0xbb);
  m.poke(0x6820, 1);
  for (let i = 0; i < 0x20; i += 1) m.poke(0x9000 + i, 0);
  m.poke(0x901f, 1); // only f_0977
  const writes = m.writes;
  MAIN.main_irq(m);
  assert.equal(mainState(m).ramTest, true);
  assert.equal(m.misc[0], 0, 'IRQ1 left disabled, as the Z80 never re-enables it');
  assert.ok(m.writes > writes);
});

// ------------------------------------------------------------ the IRQ

/** Task slots whose table entry points into this range. */
const MY_SLOTS = [];
for (let i = 0; i < 32; i += 1) {
  const a = MAIN_AT[ORACLE.read(0, 0x96 + 2 * i) | (ORACLE.read(0, 0x97 + 2 * i) << 8)];
  if (a && ORACLE.read(0, 0x97 + 2 * i) < 0x10) MY_SLOTS.push(i);
}

test('main_irq: starfield, watchdog, task manager, 51XX read', () => {
  assert.deepEqual(MY_SLOTS, [0, 1, 5, 6, 7, 15, 19, 22, 26, 27, 30, 31]);
  for (let seed = 2000; seed < 2200; seed += 1) {
    const frozen = seed % 7 === 0;
    const { board, m, r } = pair(seed, { dswA: frozen ? 0xe7 : 0xf7 });
    // Only tasks of this range are enabled; slot $1F ends the loop.
    for (let i = 0; i < 0x20; i += 1) both(board, m, 0x9000 + i, 0);
    for (const s of MY_SLOTS) if (ri(r, 2)) both(board, m, 0x9000 + s, 1);
    if (ri(r, 3) === 0) both(board, m, 0x9000 + MY_SLOTS[ri(r, 8)], 0x20);
    both(board, m, 0x901f, 1);
    both(board, m, 0x92d7, 0);
    if (m.peek(0x99b5) === 0xbb) both(board, m, 0x99b5, 0);
    sane(board, m, r);
    const kicks = m.watchdogKicks;
    z80Call(board, 0x0237, {}, false);
    MAIN.main_irq(m);
    same(board, m, `seed ${seed}`);
    sameLatches(board, m, `seed ${seed}`);
    assert.equal(m.watchdogKicks, kicks + 1);
    assert.equal(m.ioControl, frozen ? 0 : 0x10, '51XX read issued and completed');
  }
});

test('main_irq uses the 06XX bus when installed', () => {
  const { m } = pair(2300);
  for (let i = 0; i < 0x20; i += 1) m.poke(0x9000 + i, 0);
  m.poke(0x901f, 0x01);
  m.poke(0x99b5, 0);
  /** @type {number[]} */
  const calls = [];
  m.io = /** @type {never} */ ({ transfer: (c, a, n) => calls.push(c, a, n) });
  MAIN.main_irq(m);
  assert.deepEqual(calls, [0x71, 0x99b5, 3]);
});

// ------------------------------------------------------ plain setup code

test('gctl_game_init, c_game_bonus_info_show_line', () => {
  for (let seed = 2400; seed < 2440; seed += 1) {
    const { board, m, r } = pair(seed);
    both(board, m, 0x99b3, ri(r, 2));
    z80Call(board, 0x0466, { bc: 0 }, false);
    MAIN.gctl_game_init(m, { b: 0 });
    same(board, m, `game_init seed ${seed}`);
    both(board, m, 0x9280, 0x52); both(board, m, 0x9281, 0x04);
    const c = 0x1b + ri(r, 3);
    const e = ri(r, 10);
    z80Call(board, 0x043d, { bc: c, de: 0x8300 | e }, false);
    MAIN.c_game_bonus_info_show_line(m, { c, e });
    same(board, m, `bonus line seed ${seed}`);
  }
});

test('stg_init_env (plain, rack advance off / on)', () => {
  for (let seed = 2500; seed < 2520; seed += 1) {
    const rack = seed % 2 === 0;
    const { board, m, r } = pair(seed, { dswA: rack ? 0xd7 : 0xf7 });
    sane(board, m, r);
    if (!rack) {
      runBoth(board, m, 0x01c5);
      same(board, m, `seed ${seed}`);
    } else {
      // Up to the jump back to $0185 the port does exactly what the ROM does.
      const z = board.cpus[0];
      z.setRegisters({ pc: 0x01c5, sp: 0x90a0, iff1: 0, iff2: 0 });
      z.push16(0x3fff);
      while (z.pc !== 0x0185) step1(board, false);
      assert.throws(() => MAIN.stg_init_env(m), /rack advance/);
      same(board, m, `rack seed ${seed}`);
    }
  }
});

// ------------------------------------------------- game-flow lock-step

/** Waits inside this range's foreground code. */
const MY_WAITS = [
  { pc: 0x01bf, cond: (b) => b.peek(0x92ae) !== 0 },
  { pc: 0x038d, cond: (b) => b.peek(0x9201) === 1 },
  { pc: 0x03d8, cond: (b) => b.peek(0x9201) === 2 },
  { pc: 0x0414, cond: (b) => b.peek(0x92af) !== 0 },
  { pc: 0x04a4, cond: (b) => b.peek(0x901d) === 0 && b.peek(0x92af) !== 0 },
  { pc: 0x04b9, cond: (b) => b.peek(0x901d) !== 0 },
  { pc: 0x0509, cond: (b) => b.peek(0x9018) !== 0 },
  { pc: 0x0540, cond: (b) => b.peek(0x92ae) !== 0 },
  { pc: 0x0560, halt: true, cond: () => true },
  { pc: 0x0594, cond: (b) => b.peek(0x9287) !== 0 },
  { pc: 0x05a3, cond: (b) => b.peek(0x900e) !== 0 },
  { pc: 0x05fd, cond: (b) => b.peek(0x900e) !== 0 },
  { pc: 0x069b, cond: (b) => (b.peek(0x92a0) & 0x0f) !== 0 },
  { pc: 0x06ac, cond: (b) => (b.peek(0x92a0) & 0x0f) === 0 },
  { pc: 0x06df, halt: true, cond: () => true },
  { pc: 0x06e0, cond: (b) => b.peek(0x7100) !== 0x10 },
];

/** Coverage: wait loops the flow tests blocked in, and jumps they took. */
const HIT_WAITS = new Set();
const HIT_JUMPS = new Set();

/**
 * Run flow block `start` on both sides in lock-step.
 * @param {object} board @param {Machine} m @param {number} start
 * @param {{ tick?: (poke: (a: number, v: number) => void, peek: (a: number) => number, n: number) => void,
 *           waits?: Wait[], exits?: number[], maxFrames?: number, stopAfter?: number }} [opt]
 * @returns {{ next: number|null, frames: number }}
 */
function lockstep(board, m, start, opt = {}) {
  const waits = [...MY_WAITS, ...EXT_WAITS, ...(opt.waits ?? [])];
  const exits = opt.exits ?? Object.keys(FLOW).map(Number);
  const z = board.cpus[0];
  z.setRegisters({ pc: start, sp: 0x90a0, iff1: 0, iff2: 0, halted: false });
  const o = stepZ80(board, waits, exits);
  const p = FLOW[start](m);
  const tick = opt.tick ?? defaultTick;
  for (let n = 0; ; n += 1) {
    const ro = o.next();
    const rp = p.next();
    same(board, m, `block $${start.toString(16)} step ${n} (oracle pc $${(ro.done ? ro.value.pc : ro.value).toString(16)})`);
    assert.equal(rp.done, ro.done, `block $${start.toString(16)} step ${n}: port ${rp.done ? 'returned' : 'waits'}, oracle at $${(ro.done ? ro.value.pc : ro.value).toString(16)}`);
    if (ro.done) {
      assert.equal(rp.value, ro.value.pc, 'jump target');
      HIT_JUMPS.add(`${start.toString(16)}>${ro.value.pc.toString(16)}`);
      return { next: ro.value.pc, frames: n };
    }
    if (opt.stopAfter !== undefined && n >= opt.stopAfter) return { next: null, frames: n };
    if (n > (opt.maxFrames ?? 5000)) throw new Error(`block $${start.toString(16)} still waiting at $${ro.value.toString(16)}`);
    HIT_WAITS.add(ro.value);
    const pk = (a, v) => both(board, m, a, v);
    tick(pk, (a) => m.peek(a), n, ro.value);
  }
}

/**
 * One vblank's worth of what the tasks do to the waited-on variables: the
 * sub CPU counts frames at $92A0, f_1DD2 counts the game timers down at a
 * few Hz (here every 16th frame).
 */
function defaultTick(poke, peek) {
  const f = (peek(0x92a0) + 1) & 0xff;
  poke(0x92a0, f);
  if ((f & 0x0f) !== 0) return;
  for (let a = 0x92ac; a <= 0x92af; a += 1) if (peek(a) !== 0) poke(a, peek(a) - 1);
}

/**
 * Plausible machine configuration and stage parameters: the stage-setup
 * routines of the other ranges index tables with these and would run off
 * into code (or loop forever) on random bytes.
 */
function sane(board, m, r) {
  both(board, m, 0x9980, [2, 3, 0xff][ri(r, 3)]);
  both(board, m, 0x9981, [7, 0x86, 0xff][ri(r, 3)]);
  both(board, m, 0x9982, 2 + ri(r, 3));
  both(board, m, 0x9983, ri(r, 2));
  both(board, m, 0x9984, ri(r, 4));
  both(board, m, 0x9821, ri(r, 30));
  both(board, m, 0x9861, ri(r, 30));
  both(board, m, 0x92a7, ri(r, 41));
  both(board, m, 0x9215, ri(r, 2));
  both(board, m, 0x99c0, ri(r, 8)); both(board, m, 0x99c1, ri(r, 3));
  both(board, m, 0x99c2, ri(r, 10)); both(board, m, 0x99c3, ri(r, 10));
}

/** Player scores as proper digit strings (the top-5 check reads them). */
function saneScores(board, m, r) {
  for (let i = 0; i < 6; i += 1) {
    both(board, m, 0x83f8 + i, ri(r, 10));
    both(board, m, 0x83e3 + i, ri(r, 10));
  }
}

/** The sub/sound CPU's flags that f_0828 and $06E0 look at. */
function quiet(board, m) {
  both(board, m, 0x92d7, 0);
  board.write(0, 0x7100, 0x10);
  m.poke(0x7100, 0x10);
}

/** Set the top-5 table so a finished game never ranks (no name entry). */
function bestScoresHigh(board, m) {
  for (let i = 0; i < 30; i += 1) both(board, m, 0x8a20 + i, 9);
}

test('flow: j_Game_init + g_main attract -> ready -> game start', () => {
  for (let seed = 3000; seed < 3012; seed += 1) {
    const { board, m, r } = pair(seed);
    quiet(board, m);
    sane(board, m, r);
    both(board, m, 0x99b5, seed % 3 === 0 ? 0 : ri(r, 3));
    let res = lockstep(board, m, 0x02d3);
    assert.equal(res.next, 0x035a);
    both(board, m, 0x9980, [0xff, 2, 3][seed % 3]);
    both(board, m, 0x9981, [0xff, 7, 0x86][ri(r, 3)]);
    both(board, m, 0x99b3, ri(r, 2));
    both(board, m, 0x9982, 3);
    // Attract mode ends when credits arrive, then START is pressed.
    res = lockstep(board, m, 0x035a, {
      tick: (poke, peek, n, pc) => {
        defaultTick(poke, peek);
        if (pc === 0x038d && n > 5) poke(0x9201, 2);
        if (pc === 0x03d8 && n > 12) poke(0x9201, 3);
      },
    });
    assert.equal(res.next, 0x060f);
    sameLatches(board, m, `seed ${seed}`);
  }
});

test('flow: stg_init_splash via plyr_respawn_splsh (normal, challenge, rack advance)', () => {
  for (let seed = 3100; seed < 3112; seed += 1) {
    const rack = seed % 4 === 3;
    const { board, m, r } = pair(seed, { dswA: rack ? 0xd7 : 0xf7 });
    quiet(board, m);
    sane(board, m, r);
    both(board, m, 0x9821, seed % 2 ? 2 : ri(r, 60)); // 2 -> stage 3, a challenge
    both(board, m, 0x9215, ri(r, 2));
    both(board, m, 0x92a0, ri(r, 256));
    const res = lockstep(board, m, 0x060f, rack ? { stopAfter: 400 } : {});
    if (!rack) assert.equal(res.next, 0x0612);
  }
});

test('flow: respawn chain $0612 -> $061E -> $0632 -> game runner', () => {
  for (let seed = 3200; seed < 3210; seed += 1) {
    const { board, m, r } = pair(seed);
    quiet(board, m);
    sane(board, m, r);
    both(board, m, 0x9840, ri(r, 2));
    both(board, m, 0x9287, ri(r, 2) ? 0 : 2);
    both(board, m, 0x92ae, ri(r, 256));
    both(board, m, 0x8270, ri(r, 2) ? 0x24 : 0x1c);
    const tick = (poke, peek, n) => {
      defaultTick(poke, peek);
      if (n === 3) poke(0x9287, 0);
    };
    assert.equal(lockstep(board, m, 0x0612, { tick }).next, 0x061e);
    assert.equal(lockstep(board, m, 0x061e, { tick }).next, 0x0632);
    assert.equal(lockstep(board, m, 0x0632, { tick }).next, 0x045e);
  }
});

test('flow: game runner -> restart handler branches', () => {
  for (let seed = 3300; seed < 3340; seed += 1) {
    const { board, m, r } = pair(seed);
    quiet(board, m);
    sane(board, m, r);
    both(board, m, 0x9840, ri(r, 2));
    for (let i = 0; i < 16; i += 1) both(board, m, 0x9290 + i, 0);
    both(board, m, 0x9008, 1);
    both(board, m, 0x92a7, 5);
    both(board, m, 0x9213, 0);
    const endFrame = 2 + ri(r, 5);
    const how = seed % 4;
    const runnerWait = [{ pc: 0x045e, cond: () => true }];
    // Runner: loops until the stage ends (no enemies) or restarts.
    const board2 = board; // (readability)
    const res = lockstep(board2, m, 0x045e, {
      waits: runnerWait,
      exits: [0x049e],
      tick: (poke, peek, n) => {
        defaultTick(poke, peek);
        if (n === 1) poke(0x9291, 2); // some points
        if (n === endFrame) {
          if (how === 0) { poke(0x9008, 0); poke(0x92a7, 0); } else poke(0x9213, 1);
        }
      },
    });
    assert.equal(res.next, 0x049e);
    // Restart handler.
    both(board, m, 0x901d, how === 2 ? 1 : 0);
    if (how === 2) both(board, m, 0x92a7, ri(r, 2) ? 3 : 0);
    both(board, m, 0x9825, ri(r, 2));
    const next = lockstep(board, m, 0x049e, {
      tick: (poke, peek, n) => {
        defaultTick(poke, peek);
        if (n === 4) poke(0x901d, 0);
      },
    }).next;
    assert.ok([0x045e, 0x04dc, 0x04e2, 0x0650].includes(next));
  }
});

test('flow: gctl_plyr_terminate -> game over -> results -> g_halt -> g_main', () => {
  for (let seed = 3400; seed < 3430; seed += 1) {
    const { board, m, r } = pair(seed);
    quiet(board, m);
    sane(board, m, r);
    saneScores(board, m, r);
    bestScoresHigh(board, m);
    both(board, m, 0x9840, ri(r, 2));
    both(board, m, 0x99b3, ri(r, 2));
    both(board, m, 0x9820, seed % 3 === 0 ? 2 : 0);
    both(board, m, 0x9860, ri(r, 2) ? 0xff : 1);
    both(board, m, 0x9213, ri(r, 2));
    both(board, m, 0x92a7, ri(r, 2) ? 0 : 4);
    both(board, m, 0x9287, 1);
    both(board, m, 0x9018, 1);
    both(board, m, 0x9aac, ri(r, 2) ? 5 : 0);
    both(board, m, 0x9ab6, 1);
    const shots = ri(r, 3000);
    both(board, m, 0x9846, shots & 0xff); both(board, m, 0x9847, shots >> 8);
    const hits = ri(r, shots + 1);
    both(board, m, 0x9844, hits & 0xff); both(board, m, 0x9845, hits >> 8);
    if (seed % 2) { board.write(0, 0x7100, 0x71); m.poke(0x7100, 0x71); }
    const tick = (poke, peek, n, pc) => {
      defaultTick(poke, peek);
      if (pc === 0x0509 && n % 4 === 3) poke(0x9018, 0);
      if (pc === 0x0560 && n % 4 === 1) poke(0x9ab6, 0);
      if (pc === 0x0560 && n % 4 === 3) poke(0x9aac, 0);
      if (pc === 0x06e0 && n % 3 === 0) poke(0x7100, 0x10);
      if (n === 25) poke(0x9287, 0);
      if (n % 30 === 29) poke(0x900e, 0);
    };
    let pc = 0x04e2;
    const seen = [];
    const stops = [0x035a, 0x0612, 0x060f, 0x045e, 0x0632];
    for (let k = 0; k < 6 && !stops.includes(pc); k += 1) {
      seen.push(pc);
      if (pc === 0x058e) both(board, m, 0x900e, 1);
      pc = lockstep(board, m, pc, { tick }).next;
    }
    sameLatches(board, m, `seed ${seed} path ${seen.map((x) => x.toString(16))}`);
  }
});

test('flow: player change $058E with enemies left', () => {
  for (let seed = 3500; seed < 3510; seed += 1) {
    const { board, m, r } = pair(seed);
    quiet(board, m);
    sane(board, m, r);
    both(board, m, 0x92a7, ri(r, 2) ? 0 : 5);
    both(board, m, 0x9287, 1);
    both(board, m, 0x9843, ri(r, 2) ? 0 : 7);
    both(board, m, 0x9883, m.peek(0x9843)); // becomes the active $9843 after the swap
    both(board, m, 0x9983, ri(r, 2));
    both(board, m, 0x9821, ri(r, 30)); both(board, m, 0x9861, ri(r, 30));
    const tick = (poke, peek, n) => {
      defaultTick(poke, peek);
      if (n === 2) poke(0x9287, 0);
      if (n === 5 || n === 40) poke(0x900e, 0);
    };
    const next = lockstep(board, m, 0x058e, { tick }).next;
    assert.ok(next === 0x060f || next === 0x0612);
    sameLatches(board, m, `seed ${seed}`);
  }
});

test('flow: gctl_chllng_stg_end (bonus and PERFECT)', () => {
  for (let seed = 3600; seed < 3616; seed += 1) {
    const { board, m, r } = pair(seed);
    quiet(board, m);
    sane(board, m, r);
    both(board, m, 0x9840, ri(r, 2));
    both(board, m, 0x9288, [0x28, 0, ri(r, 40), 0x28][seed % 4]);
    for (let i = 0; i < 16; i += 1) both(board, m, 0x9290 + i, 0);
    both(board, m, 0x92a0, ri(r, 256));
    assert.equal(lockstep(board, m, 0x0650).next, 0x04dc);
  }
});

test('flow: $04DC and $0604 new stage from the terminate paths', () => {
  for (let seed = 3700; seed < 3706; seed += 1) {
    const { board, m, r } = pair(seed);
    quiet(board, m);
    sane(board, m, r);
    both(board, m, 0x9821, ri(r, 30));
    both(board, m, 0x9843, seed % 2 ? 0 : 3);
    const start = seed % 3 ? 0x0604 : 0x04dc;
    const next = lockstep(board, m, start).next;
    assert.equal(next, start === 0x0604 ? 0x061e : 0x0632);
  }
});

test('flow coverage: every wait loop and every jump was exercised', () => {
  const missing = MY_WAITS.map((w) => w.pc).filter((pc) => !HIT_WAITS.has(pc));
  assert.deepEqual(missing.map((x) => x.toString(16)), [], 'wait loops never reached');
  const jumps = [
    '2d3>35a', '35a>60f', '60f>612', '612>61e', '61e>632', '632>45e', '45e>49e',
    '49e>45e', '49e>4dc', '49e>4e2', '49e>650', '4dc>632', '4e2>579', '4e2>6de',
    '4e2>58e', '579>604', '579>612', '579>58e', '58e>60f', '58e>612', '604>61e',
    '650>4dc', '6de>35a',
  ];
  assert.deepEqual(jumps.filter((j) => !HIT_JUMPS.has(j)), [], 'jumps never taken');
  for (const w of [0x1337, 0x121d, 0x134c]) assert.ok(HIT_WAITS.has(w), `external wait $${w.toString(16)}`);
});

// -------------------------------------------------- reset / restart

test('main_reset: $0000 and CPU0_RESET, then jp_RAM_test; $BB restarts it', () => {
  const m = new Machine();
  m.mem.fill(0x55, 0x9800, 0x9c00);
  let runs = 0;
  const saved = MAIN.jp_RAM_test;
  MAIN.jp_RAM_test = function* ramTest() {
    runs += 1;
    for (;;) yield;
  };
  try {
    const t = MAIN.main_reset(m);
    t.next();
    assert.equal(m.ioControl, 0x10);
    for (let i = 0; i < 0x10; i += 1) assert.equal(m.peek(0x99e0 + i), 0);
    assert.equal(m.peek(0x99f0), 0x55);
    assert.equal(runs, 1);
    t.next();
    assert.equal(runs, 1);
    // The service switch, seen by f_0977 inside the IRQ.
    for (let i = 0; i < 0x20; i += 1) m.poke(0x9000 + i, 0);
    m.poke(0x901f, 1);
    m.poke(0x99b5, 0xbb);
    MAIN.main_irq(m);
    t.next();
    assert.equal(runs, 2, 'jp_RAM_test restarted');
    assert.equal(mainState(m).ramTest, false);
  } finally {
    MAIN.jp_RAM_test = saved;
  }
});

// ------------------------------------------- states from a real boot

/**
 * Boot the real ROM (with the 51XX/54XX when test/mcu provides them) into
 * attract mode and the demo, and snapshot the shared RAM right before
 * j_Game_init and at several vblank handler entries.
 */
const BOOT = await (async () => {
  const b = makeOracle(await loadChips());
  const copy = () => ({
    video: b.video.slice(), ram1: b.ram1.slice(), ram2: b.ram2.slice(), ram3: b.ram3.slice(),
    dswA: b.dswA, dswB: b.dswB, frame: b.frames,
  });
  const out = { gameInit: null, irq: [] };
  b.onExec = (n, _pc, z) => {
    if (n !== 0) return;
    if (z.pc === 0x02d3 && out.gameInit === null) out.gameInit = copy();
    if (z.pc === 0x0237 && b.frames >= 870 && b.frames % 37 === 0
      && out.irq.every((x) => x.frame !== b.frames)) out.irq.push(copy());
  };
  // ~frame 860 j_Game_init, then attract mode; the demo game from ~2350.
  for (let f = 0; f < 3200; f += 1) b.runFrame();
  return out;
})();

/** Load a boot snapshot into the oracle and a new port Machine. */
function fromSnapshot(snap) {
  const board = ORACLE;
  loadState(board, snap);
  board.dswA = snap.dswA;
  board.dswB = snap.dswB;
  board.misc.fill(0);
  board.videoLatch.fill(0);
  R_VALUES.length = 0;
  const m = new Machine();
  replayR(m);
  loadState(m, board);
  m.dswA = board.dswA;
  m.dswB = board.dswB;
  return { board, m };
}

test('real boot: j_Game_init and g_main attract mode from the post-RAM-test state', () => {
  assert.ok(BOOT.gameInit, 'the boot reached j_Game_init');
  const { board, m } = fromSnapshot(BOOT.gameInit);
  quiet(board, m);
  assert.equal(lockstep(board, m, 0x02d3).next, 0x035a);
  sameLatches(board, m, 'j_Game_init');
  const res = lockstep(board, m, 0x035a, {
    tick: (poke, peek, n, pc) => {
      defaultTick(poke, peek);
      if (pc === 0x038d && n === 30) poke(0x9201, 2);
      if (pc === 0x03d8 && n === 60) poke(0x9201, 3);
    },
  });
  assert.equal(res.next, 0x060f);
});

test('real boot: tasks of this range and the whole task manager in attract/demo', () => {
  assert.ok(BOOT.irq.length >= 50, `snapshots: ${BOOT.irq.length}`);
  assert.ok(BOOT.irq.some((x) => x.ram2[0x005] !== 0), 'some snapshot has f_0857 enabled (demo)');
  // Tasks of the other ranges run as ROM-backed stubs (this process only).
  for (let i = 0; i < 32; i += 1) {
    const addr = ORACLE.read(0, 0x96 + 2 * i) | (ORACLE.read(0, 0x97 + 2 * i) << 8);
    if (addr >= 0x1000 && MAIN_AT[addr] === undefined) MAIN_AT[addr] = romStub(addr);
  }
  for (const snap of BOOT.irq) {
    let { board, m } = fromSnapshot(snap);
    both(board, m, 0x92d7, 0);
    // Each task of this range that the snapshot has enabled.
    for (const [slot, addr] of [[1, 0x0828], [5, 0x0857], [15, 0x0935], [31, 0x0977]]) {
      if (m.peek(0x9000 + slot) === 0) continue;
      if (addr === 0x0857) z80Call(board, addr, { de: 0x00a1 }, false);
      else z80Call(board, addr, {}, false);
      MAIN_AT[addr](m, addr === 0x0857 ? { e: 0xa1 } : {});
      same(board, m, `frame ${snap.frame} task $${addr.toString(16)}`);
    }
    ({ board, m } = fromSnapshot(snap));
    both(board, m, 0x92d7, 0);
    z80Call(board, 0x0237, {}, false);
    MAIN.main_irq(m);
    same(board, m, `frame ${snap.frame} main_irq`);
    sameLatches(board, m, `frame ${snap.frame} main_irq`);
  }
});

test('romdata exports the ROM at $0935-$0B0E (read as a table)', () => {
  for (let a = 0x0935; a < 0x0b0f; a += 1) assert.equal(mainRom(a), ORACLE.read(0, a));
});

test('f_0857 on power-on leftovers reads code bytes as the ROM does', () => {
  for (let seed = 5000; seed < 5300; seed += 1) {
    const { board, m, r } = pair(seed);
    for (let i = 0; i < 4; i += 1) both(board, m, 0x99c0 + i, ri(r, 256));
    both(board, m, 0x92a7, ri(r, 256));
    both(board, m, 0x92aa, ri(r, 4) ? 0 : 1);
    z80Call(board, 0x0857, { de: 0x00a1 }, false);
    MAIN.f_0857(m, { e: 0xa1 });
    same(board, m, `seed ${seed}`);
  }
});

test('every task-table entry in $0000-$0FFF is registered', () => {
  for (let i = 0; i < 32; i += 1) {
    const addr = ORACLE.read(0, 0x96 + 2 * i) | (ORACLE.read(0, 0x97 + 2 * i) << 8);
    if (addr < 0x1000) assert.equal(typeof MAIN_AT[addr], 'function', `task ${i} $${addr.toString(16)}`);
  }
});
