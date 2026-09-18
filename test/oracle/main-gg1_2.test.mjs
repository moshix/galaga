// Copyright 2026 by Moshix
/**
 * Differential tests for main CPU $1000-$1FFF (src/game/main/gg1_2*.js):
 * each ROM routine runs on the oracle board and its port on a Machine from
 * the same seeded-random RAM; the RAM afterwards must be identical and the
 * returned registers must match.
 *
 * Foreground routines that wait (frame counter, game timer, flying aliens)
 * are run with a "tick": each time the Z80 takes the backward jump of its
 * poll loop, and each time the port's generator yields, the same stand-in
 * for the interrupt handler's work is applied to that side's RAM. The tick
 * counts must match too.
 *
 * Routines of other ROM ranges that these call (c_23E0, stg_init_env,
 * c_sctrl_playfld_clr, c_sctrl_sprite_ram_clr, c_mach_hiscore_show) are
 * replaced during the test by stubs that run the real ROM routine on a
 * scratch board, so this suite does not depend on the other modules.
 */
import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeOracle, callRoutine, loadState, diffRam, RAM_REGIONS } from '../helpers/oracle.mjs';
import { Machine } from '../../src/machine/machine.js';
import '../../src/game/main/index.js';
import { MAIN, MAIN_AT } from '../../src/game/main/routines.js';
import { GG1_2_ROUTINES } from '../../src/game/main/gg1_2.js';
import { romWord, mainRom } from '../../src/game/romdata.js';

const board = makeOracle();
const scratch = makeOracle();

/**
 * Opt-in coverage: GG1_2_COVERAGE=1 lists the instructions of $1000-$1FFF
 * (from the listing) that no scenario made the oracle execute.
 */
const COVER = process.env.GG1_2_COVERAGE === '1';
const executed = new Set();
if (COVER) {
  after(() => {
    const listing = readFileSync(new URL('../../reference/galaga-main.asm', import.meta.url), 'utf8');
    const missed = [];
    for (const line of listing.split('\n')) {
      const mt = /^(1[0-9A-F]{3}): [0-9A-F ]+ {2,}(\S+)/.exec(line);
      if (!mt || mt[2] === '.db') continue;
      const a = parseInt(mt[1], 16);
      if (!executed.has(a)) missed.push(mt[1]);
    }
    // print within 79 columns
    console.log(`not executed (${missed.length}):`);
    for (let i = 0; i < missed.length; i += 12) console.log(`  ${missed.slice(i, i + 12).join(' ')}`);
  });
}

// ------------------------------------------------------------ utilities

/** xorshift32 byte source. @param {number} seed */
function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s & 0xff;
  };
}

/**
 * A port machine with random RAM (seeded), customised by `setup`, and the
 * oracle loaded with the same RAM.
 * @param {number} seed
 * @param {(m: Machine, r: () => number) => void} [setup]
 */
function state(seed, setup) {
  const m = new Machine();
  const r = rng(seed);
  for (const reg of RAM_REGIONS) for (let i = 0; i < m[reg.key].length; i += 1) m[reg.key][i] = r();
  if (setup) setup(m, r);
  loadState(board, m);
  board.dswA = m.dswA;
  board.dswB = m.dswB;
  return m;
}

/**
 * Run a ROM routine on the oracle, stepping it ourselves so that poll loops
 * can be "ticked" and instructions observed.
 * @param {number} addr
 * @param {object} [regs]
 * @param {{ loops?: number[][], tick?: (o: object) => void,
 *           before?: Record<number, (z: object) => void>,
 *           after?: Record<number, (z: object) => void> }} [opt]
 */
function runOracle(addr, regs = {}, opt = {}) {
  const { loops = [], tick, before = {}, after = {} } = opt;
  const z = board.cpus[0];
  z.setRegisters({ ...regs, pc: addr, sp: 0x90a0, iff1: 0, iff2: 0 });
  z.push16(0x3fff);
  const startSp = z.sp + 2;
  let prev = -1;
  let cycles = 0;
  let ticks = 0;
  while (!(z.pc === 0x3fff && z.sp === startSp)) {
    const pc = z.pc;
    if (tick && loops.some(([top, jr]) => pc === top && prev === jr)) { tick(board); ticks += 1; }
    before[pc]?.(z);
    if (COVER) executed.add(pc);
    cycles += z.step();
    after[pc]?.(z);
    prev = pc;
    if (cycles > 30_000_000) throw new Error(`$${addr.toString(16)} did not return (pc=$${z.pc.toString(16)})`);
  }
  return { ...z.getRegisters(), ticks };
}

/**
 * Run a port routine, driving it to completion if it is a generator.
 * @param {Function} fn @param {Machine} m @param {object} regs
 * @param {(o: object) => void} [tick]
 */
function runPort(fn, m, regs, tick) {
  const r = fn(m, regs);
  if (!(r && typeof r.next === 'function')) return { out: r, ticks: 0 };
  let ticks = 0;
  for (;;) {
    const s = r.next();
    if (s.done) return { out: s.value, ticks };
    if (!tick) throw new Error('port waited without a tick');
    tick(m);
    ticks += 1;
    if (ticks > 100000) throw new Error('port never finished');
  }
}

/** Assert identical RAM. @param {Machine} m @param {string} what */
function same(m, what) {
  assert.deepEqual(diffRam(board, m), [], what);
}

/**
 * A stand-in for a routine of another ROM range: run it on the scratch
 * board over the port's RAM.
 * @param {number} addr @param {() => number} [rAt] R register to start with
 */
function oracleStub(addr, rAt) {
  return (m, regs = {}) => {
    loadState(scratch, m);
    scratch.dswA = m.dswA;
    scratch.dswB = m.dswB;
    /** @type {Record<string, number>} */
    const z = {};
    if (regs.a !== undefined) z.af = (regs.a & 0xff) << 8;
    for (const k of ['bc', 'de', 'hl']) if (regs[k] !== undefined) z[k] = regs[k];
    if (rAt) z.r = rAt();
    const o = callRoutine(scratch, 0, addr, z);
    loadState(m, scratch);
    return { a: o.af >> 8, bc: o.bc, de: o.de, hl: o.hl };
  };
}

/** R register of the oracle when it reached stg_init_env, for its stub. */
let rAtStgInit = 0;

const STUBS = {
  c_23E0: oracleStub(0x23e0),
  stg_init_env: oracleStub(0x01c5, () => rAtStgInit),
  c_sctrl_playfld_clr: oracleStub(0x0160),
  c_sctrl_sprite_ram_clr: oracleStub(0x003c),
  c_mach_hiscore_show: oracleStub(0x3214),
};
const ORACLE_HOOKS = { before: { 0x01c5: (z) => { rAtStgInit = z.getRegisters().r; } } };

/** Run fn with the other ranges' routines replaced by oracle stubs. @param {() => void} fn */
function withStubs(fn) {
  const saved = {};
  for (const k of Object.keys(STUBS)) { saved[k] = MAIN[k]; MAIN[k] = STUBS[k]; }
  try { fn(); } finally {
    for (const k of Object.keys(STUBS)) { if (saved[k] === undefined) delete MAIN[k]; else MAIN[k] = saved[k]; }
  }
}

const A = (regs) => regs.af >> 8;
const CY = (regs) => regs.af & 1;

/** Tick stand-ins for what the vblank interrupt would change. */
const TICK_FRAME = (o) => { o.ram2[0x2a0] = (o.ram2[0x2a0] + 1) & 0xff; };
const TICK_TMR3 = (o) => { if (o.ram2[0x2af]) o.ram2[0x2af] -= 1; };
const TICK_FLYING = (o) => { if (o.ram2[0x287]) o.ram2[0x287] -= 1; };

/**
 * The common case: plain routine, same inputs, compare RAM (and let the
 * caller compare registers).
 * @param {string} name @param {number} addr @param {Machine} m
 * @param {object} zregs oracle registers @param {object} jregs port registers
 */
function cmp(name, addr, m, zregs = {}, jregs = {}, opt = {}) {
  const o = runOracle(addr, zregs, opt);
  const { out, ticks } = runPort(MAIN[name], m, jregs, opt.tick);
  same(m, `${name} ${JSON.stringify(jregs)}`);
  assert.equal(ticks, o.ticks, `${name}: frames waited`);
  return { o, out };
}

// ---------------------------------------------------------------- tests

test('registration: every routine in MAIN and MAIN_AT, task table targets present', () => {
  for (const { addr, name } of GG1_2_ROUTINES) {
    assert.equal(typeof MAIN[name], 'function', name);
    assert.equal(MAIN_AT[addr], MAIN[name], name);
  }
  // task table entries at $0096 that point into $1000-$1FFF
  for (let p = 0x96; p < 0xd6; p += 2) {
    const t = romWord('main', p);
    if (t >= 0x1000 && t < 0x2000) assert.equal(typeof MAIN_AT[t], 'function', `task $${t.toString(16)}`);
  }
  // jump tables
  for (const [base, n] of [[0x1713, 6], [0x1786, 7], [0x17c3, 15], [0x1bd7, 3]]) {
    for (let i = 0; i < n; i += 1) {
      const t = romWord('main', base + 2 * i);
      assert.equal(typeof MAIN_AT[t], 'function', `jump table $${base.toString(16)}[${i}]`);
    }
  }
  assert.equal(typeof MAIN.c_133A, 'function');
  assert.equal(typeof MAIN.l_133A, 'function');
});

test('c_1000 randomizer ($1000) with the oracle R values', () => {
  for (let s = 0; s < 64; s += 1) {
    const m = state(s);
    const r = rng(1000 + s);
    const rIn = r();
    const hl = (r() << 8) | r();
    /** @type {number[]} */
    const seen = [];
    const rec = (z) => seen.push(z.getRegisters().af >> 8);
    const o = runOracle(0x1000, { r: rIn, hl }, { after: { 0x1001: rec, 0x100d: rec } });
    let i = 0;
    m.readR = () => seen[i++];
    const out = MAIN.c_1000(m, { hl });
    same(m, 'c_1000');
    assert.equal(out.a, A(o), `c_1000 seed ${s}`);
    assert.equal(out.hl, o.hl);
    assert.equal(i, 2, 'two ld a,r');
  }
});

test('sub_1012 dead code ($1012)', () => {
  const r = rng(12);
  for (let s = 0; s < 300; s += 1) {
    const hl = (r() << 8) | r();
    const de = s === 0 ? hl : (r() << 8) | r();
    const m = state(s);
    const { o, out } = cmp('sub_1012', 0x1012, m, { hl, de }, { hl, de });
    assert.equal(out.hl, o.hl, `sub_1012 hl=${hl} de=${de}`);
    assert.equal(out.a, A(o));
    assert.equal(o.de, de);
  }
});

test('c_104E_mul_16_8 ($104E) and c_divmod ($1061)', () => {
  const r = rng(4);
  const m = state(1);
  for (let s = 0; s < 400; s += 1) {
    const hl = (r() << 8) | r();
    const a = s < 3 ? [0, 1, 255][s] : r();
    let o = runOracle(0x104e, { hl, af: a << 8, de: 0x1234 });
    let out = MAIN.c_104E_mul_16_8(m, { hl, a });
    assert.equal(out.hl, o.hl, `mul ${hl}*${a}`);
    assert.equal(out.a, A(o));
    o = runOracle(0x1061, { hl, af: a << 8 });
    out = MAIN.c_divmod(m, { hl, a });
    assert.equal(out.hl, o.hl, `div ${hl}/${a}`);
    assert.equal(out.a, A(o), `mod ${hl}%${a}`);
  }
});

test('c_1079 / c_1083 / j_108A: diving attack setup', () => {
  for (let s = 0; s < 120; s += 1) {
    const m = state(s, (mm, r) => {
      mm.poke(0x9215, s & 1);
      mm.poke(0x920b, s & 2 ? r() : 0);
      if (s % 10 === 9) for (let k = 0; k < 12; k += 1) mm.poke(0x9113 + 0x14 * k, mm.peek(0x9113 + 0x14 * k) | 1);
    });
    const r = rng(s + 77);
    const l = (r() % 0x30) * 2;
    const de = (r() << 8) | r();
    if (s & 4) {
      const hl = 0x8800 | l | (r() & 0x80);
      cmp('c_1079', 0x1079, m, { hl, de }, { hl, de });
    } else {
      const hl = 0x8800 | l;
      cmp('c_1083', 0x1083, m, { hl, de }, { hl, de });
    }
  }
});

test('c_player_active_switch ($110C)', () => {
  for (let s = 0; s < 20; s += 1) {
    const m = state(s, (mm, r) => {
      for (let l = 0; l < 0x60; l += 2) if (r() & 1) mm.poke(0x8800 + l, 1);
    });
    cmp('c_player_active_switch', 0x110c, m);
  }
});

test('c_new_level_tokens ($117F): stages, clicks and pacing', () => {
  const stages = [0, 1, 4, 5, 9, 10, 14, 15, 19, 20, 29, 30, 38, 40, 44, 45, 49, 50, 51, 99, 100, 149,
    150, 199, 200, 238, 255];
  let n = 0;
  for (const stage of stages) {
    for (const cyAlt of [0, 1]) {
      const m = state(n, (mm, r) => {
        mm.poke(0x9821, stage);
        mm.poke(0x9820, r() % 10);
        for (let i = 0; i < 0x40; i += 1) if (r() & 1) mm.poke(0x8000 + i, 0x30 + (r() & 0x1f));
      });
      n += 1;
      const af_ = (n * 37 & 0xff) << 8 | cyAlt;
      cmp('c_new_level_tokens', 0x117f, m, { af_ }, { af_ }, { loops: [[0x121d, 0x1221]], tick: TICK_FRAME });
    }
  }
});

test('stage token helpers ($11F5, $11FB, $1213, $1228)', () => {
  for (let s = 0; s < 40; s += 1) {
    const r = rng(s + 5);
    const hl = 0x8000 | (r() & 0x1f) | 0x0000;
    const cyAlt = s & 1;
    const af_ = (r() << 8) | cyAlt;
    const opt = { loops: [[0x121d, 0x1221]], tick: TICK_FRAME };
    let m = state(s);
    const a = s % 5;
    let { o, out } = cmp('c_11E3_show_tokens_1', 0x11f5, m, { hl, af: a << 8, af_ }, { hl, a, af_ }, opt);
    assert.equal(out.hl, o.hl);
    m = state(s + 100);
    const a2 = 1 + (s % 4);
    ({ o, out } = cmp('c_11E9', 0x11fb, m, { hl, af: a2 << 8, af_ }, { hl, a: a2, af_ }, opt));
    assert.equal(out.hl, o.hl);
    m = state(s + 200);
    const d = 0x36 + (r() % 0x14);
    ({ o, out } = cmp('c_build_token_1', 0x1213, m, { hl, de: d << 8, af_ }, { hl, d, af_ }, opt));
    assert.equal(out.hl, o.hl);
    assert.equal(out.d, o.de >> 8);
    m = state(s + 300);
    ({ o, out } = cmp('c_build_token_2', 0x1228, m, { hl, de: d << 8 }, { hl, d }));
    assert.equal(out.hl, o.hl);
    assert.equal(out.d, o.de >> 8);
    assert.equal(out.a, A(o));
  }
});

test('c_1230_init_taskman_structs ($1242), c_game_or_demo_init ($127B)', () => {
  for (let s = 0; s < 5; s += 1) {
    cmp('c_1230_init_taskman_structs', 0x1242, state(s));
    cmp('c_game_or_demo_init', 0x127b, state(s + 10));
  }
});

test('c_sprite_tiles_displ ($129E) over the whole attract table', () => {
  for (let k = 0; k < 10; k += 1) {
    const m = state(k, (mm) => mm.poke16(0x9280, 0x195c + 4 * k));
    cmp('c_sprite_tiles_displ', 0x129e, m);
  }
  // records in RAM, so code/colour bit 7 (colour bit 3) is covered too
  for (let k = 0; k < 10; k += 1) {
    const m = state(k + 20, (mm) => {
      mm.poke16(0x9280, 0x8a00 + 4 * k);
      mm.poke(0x8a00 + 4 * k, 2 * (mm.peek(0x8a00 + 4 * k) % 0x40));
    });
    cmp('c_sprite_tiles_displ', 0x129e, m);
  }
});

test('c_12C3 formation home positions ($12D5), flip on/off', () => {
  for (const a of [0, 0x3f, 0x80, 0xc5]) {
    for (const flip of [0, 1]) {
      const m = state(a + flip, (mm) => mm.poke(0x9215, flip));
      cmp('c_12C3', 0x12d5, m, { af: a << 8 }, { a });
    }
  }
});

test('c_tdelay_3 ($1331) waits three timer ticks', () => {
  const m = state(3);
  cmp('c_tdelay_3', 0x1331, m, {}, {}, { loops: [[0x1337, 0x1339]], tick: TICK_TMR3 });
});

test('c_player_respawn ($133D) and c_133A / l_133A ($134C)', () => {
  let n = 0;
  for (const tile of [0x24, 0x1c]) {
    for (const flying of [0, 3]) {
      for (const flip of [0, 1]) {
        const setup = (mm, r) => {
          mm.poke(0x8270, tile);
          mm.poke(0x9287, flying);
          mm.poke(0x9215, flip | (r() & 0xfe));
          mm.poke(0x9820, r() % 9);
        };
        const opt = { loops: [[0x134c, 0x1350]], tick: TICK_FLYING };
        cmp('c_player_respawn', 0x133d, state(n++, setup), {}, {}, opt);
        cmp('c_133A', 0x134c, state(n++, setup), {}, {}, opt);
        if (flying === 0) cmp('l_133A', 0x134c, state(n++, setup));
      }
    }
  }
});

test('draw_resv_ships ($137E) and draw_resv_ship_tile ($1398)', () => {
  for (let ships = 0; ships < 12; ships += 1) {
    const m = state(ships, (mm, r) => {
      mm.poke(0x9820, ships === 11 ? 0xff : ships);
      for (let i = 0; i < 0x40; i += 1) if (r() & 1) mm.poke(0x8000 + i, 0x30 + (r() & 0x1f));
    });
    const { o, out } = cmp('draw_resv_ships', 0x137e, m);
    assert.equal(out.hl, o.hl);
    assert.equal(out.de, o.de);
  }
  for (let s = 0; s < 20; s += 1) {
    const r = rng(s);
    const hl = 0x8000 | (0x10 + (r() & 0x2f));
    const de = (r() << 8) | (r() % 10);
    const { o, out } = cmp('draw_resv_ship_tile', 0x1398, state(s), { hl, de }, { hl, de });
    assert.equal(out.d, o.de >> 8);
    assert.equal(out.hl, o.hl);
  }
});

test('c_string_out ($13B3) and j_string_out_pe ($13B5): every string', () => {
  for (let c = 1; c <= 30; c += 1) {
    const r = rng(c);
    const hl = 0x8040 + (r() | ((r() & 3) << 8)) % 0x380;
    const de = (r() << 8) | r();
    let m = state(c);
    let { o, out } = cmp('c_string_out', 0x13b3, m, { hl, de, bc: c }, { hl, de, c });
    assert.equal(out.hl, o.hl, `string ${c}`);
    assert.equal(out.de, o.de);
    assert.equal(out.a, A(o));
    m = state(c + 50);
    ({ o, out } = cmp('j_string_out_pe', 0x13b5, m, { hl, de, bc: c, af_: 0x0001 }, { hl, de, c }));
    assert.equal(out.hl, o.hl, `pe string ${c}`);
    assert.equal(out.de, o.de);
    assert.equal(out.a, A(o));
  }
});

test('f_1700 demo fighter control over all three vector tables', () => {
  let n = 0;
  for (const [base, len] of [[0x181f, 0x21], [0x1887, 0x25], [0x1928, 0x18]]) {
    for (let p = base; p < base + len; p += 1) {
      const tok = mainRom(p);
      if ((tok >> 5) > 5) continue;
      for (const [frame, tmr] of [[0, 1], [0x10, 2], [4, 1], [1, 1], [0x20, 1]]) {
        const m = state(n++, (mm, r) => {
          mm.poke16(0x9282, p);
          mm.poke(0x92a0, frame);
          mm.poke(0x9207, tmr);
          mm.poke(0x9209, r() & 0x7e);
          mm.poke(0x9215, r() & 1);
          if (r() & 1) mm.poke(0x9364, 0);
          if (r() & 1) mm.poke(0x9362, mm.peek(0x9300 | mm.peek(0x9209)));
        });
        cmp('f_1700', 0x1700, m);
      }
    }
  }
  // a token stream in RAM: $4x (count down) then $6x (print string x),
  // which none of the ROM vector tables contains
  for (let c = 1; c <= 30; c += 1) {
    const m = state(c, (mm) => {
      mm.poke16(0x9282, 0x8a10);
      mm.poke(0x8a10, 0x40 | c);
      mm.poke(0x8a11, 0x60 | c);
      mm.poke(0x92a0, 0x10);
      mm.poke(0x9207, 1);
    });
    cmp('f_1700', 0x1700, m);
  }
});

test('f_17B2 attract sequencer: every state', () => {
  withStubs(() => {
    let n = 0;
    for (let st = 0; st < 15; st += 1) {
      for (let v = 0; v < 8; v += 1) {
        const m = state(n++, (mm, r) => {
          mm.poke(0x9201, v === 7 ? 2 : 1);
          mm.poke(0x9203, st);
          mm.poke(0x92af, [0, 1, 5, 0, 1, 2, 0, 0][v]);
          mm.poke(0x92ae, [0, 1, 6, 3, 0, 1, 6, 2][v]);
          mm.poke(0x92a0, v & 1 ? 0x1f : r());
          mm.poke(0x9003, v & 2 ? 0 : 1);
          mm.poke(0x9205, v % 6);
          mm.poke16(0x9280, 0x195c + 4 * (v % 3));
          mm.poke(0x9287, 0);
          mm.poke(0x9215, v & 1);
          mm.poke(0x9984, r() & 3); // machine rank: stg_init_env indexes by it
          if (v & 4) mm.dswA ^= 0x08;
        });
        cmp('f_17B2', 0x17b2, m, {}, {}, ORACLE_HOOKS);
      }
    }
  });
});

test('f_19B2 fighter capture sequence', () => {
  let n = 0;
  for (let v = 0; v < 160; v += 1) {
    const m = state(n++, (mm, r) => {
      const k = v % 8;
      mm.poke(0x928e, k === 0 ? 1 + (r() & 3) : 0);
      mm.poke(0x92ad, [0, 4, 3, 0, 0, 0, 0, 6][k]);
      mm.poke(0x82d1, (v >> 3) & 1 ? 0x24 : r());
      const boss = 0x30 + 2 * (r() & 3);
      mm.poke(0x9828, boss);
      mm.poke(0x8800 | boss, (v >> 4) & 1 ? 9 : 2);
      mm.poke(0x928b, [0, 5, 0x24, 0x23, 1][(v >> 5) % 5]);
      mm.poke(0x9215, (v >> 2) & 1);
      // ship Y at the edge where bit 8 flips
      if (v & 2) mm.poke(0x9301 + (boss & 7), (v >> 2) & 1 ? 0xff : 0x00);
      mm.poke(0x9829, r() & 0xf0);
    });
    cmp('f_19B2', 0x19b2, m);
  }
});

test('f_1A80 bonus bee manager', () => {
  let n = 0;
  for (let v = 0; v < 240; v += 1) {
    const m = state(n++, (mm, r) => {
      mm.poke(0x99ca, 0x20);
      mm.poke(0x92a7, v % 16 === 15 ? 0x30 : r() & 0x1f);
      const k = v % 5;
      if (k === 0) {
        mm.poke(0x9841, 0);
        for (let l = 0; l < 0x60; l += 2) mm.poke(0x8800 + l, r() % 6 === 0 ? 1 : 0x80);
        if (v % 3 === 0) for (let l = 0; l < 0x60; l += 2) mm.poke(0x8800 + l, 0x80);
      } else if (k < 3) {
        mm.poke(0x9841, 0xc0 + (r() & 0x3e));
      } else {
        mm.poke(0x9841, 0xff);
        mm.poke(0x9015, r() & 1);
      }
      const obj = 0x08 + 2 * (r() % 0x2c);
      mm.poke(0x982d, obj);
      mm.poke(0x8800 | obj, r() & 3 ? 1 : 4);
      mm.poke(0x9200 | obj, r() & 0x81);
      mm.poke(0x982f, 4 + (r() % 3));
    });
    cmp('f_1A80', 0x1a86, m);
  }
});

/** Random launcher state for f_1B65 and friends. @param {Machine} mm @param {() => number} r */
function bomberSetup(mm, r) {
  mm.poke(0x920b, r() & 1 ? r() : 0);
  mm.poke(0x9015, r() & 3 ? 1 : 0);
  mm.poke(0x901d, r() & 3 ? 0 : 1);
  for (let k = 0; k < 4; k += 1) {
    mm.poke(0x92ca + 3 * k, r() % 5 === 0 ? (r() & 0x80) | (2 * (r() % 0x30)) : 0xff);
  }
  mm.poke(0x92a0, r() & 1 ? 0 : r());
  for (let k = 0; k < 3; k += 1) mm.poke(0x92c0 + k, r() & 1 ? 1 : r());
  mm.poke(0x9287, r() & 3);
  mm.poke(0x99c4, r() & 3);
  mm.poke(0x982b, r() & 1);
  mm.poke(0x982c, r());
  for (let l = 0; l < 0x60; l += 2) mm.poke(0x8800 + l, r() & 1 ? 1 : [0, 2, 9, 0x80][r() & 3]);
  mm.poke(0x982d, [0x4a, 0x52, 0x5a, 0x58, 0x50, 0x48, 0x10, 0x44][r() & 7]);
  mm.poke(0x92d6, 0xff); // a free pool slot for the rogue-fighter search
}

test('f_1B65 bomber launcher', () => {
  for (let s = 0; s < 800; s += 1) cmp('f_1B65', 0x1b6b, state(s, bomberSetup));
  // nothing resting anywhere: every launcher search falls through
  for (let s = 0; s < 40; s += 1) {
    const m = state(s + 900, (mm, r) => {
      bomberSetup(mm, r);
      for (let l = 0; l < 0x60; l += 2) mm.poke(0x8800 + l, [0, 2, 9, 0x80][r() & 3]);
    });
    cmp('f_1B65', 0x1b6b, m);
    cmp('case_bmbr_boss', 0x1c07, state(s + 900, (mm, r) => {
      bomberSetup(mm, r);
      for (let l = 0; l < 0x60; l += 2) mm.poke(0x8800 + l, [0, 2, 9, 0x80][r() & 3]);
    }));
  }
});

test('bomber launch cases ($1BDD, $1BFD, $1C07) and j_1CAE / c_1D03 / l_1D16', () => {
  for (let s = 0; s < 300; s += 1) {
    cmp('case_bmbr_yellow', 0x1bdd, state(s, bomberSetup));
    cmp('case_bmbr_red', 0x1bfd, state(s + 1000, bomberSetup));
    cmp('case_bmbr_boss', 0x1c07, state(s + 2000, bomberSetup));
  }
  for (let s = 0; s < 200; s += 1) {
    const r = rng(s);
    const ixl = s % 3;
    const b = 1 + (r() & 3);
    let c = r();
    if (ixl === 0) c = (c & 0xf8) | [3, 5, 6][r() % 3];
    if (ixl === 1) c = (c & 0xf8) | (1 + (r() % 7));
    const e = 0x30 + 2 * (r() & 3);
    const iy = (r() << 8) | r();
    cmp('j_1CAE', 0x1cb4, state(s, bomberSetup), { de: e, bc: (b << 8) | c, ix: ixl, iy },
      { e, b, c, ixl, iy });
    const cf = r() & 1;
    const hl = 0x92cd + 3 * (r() & 1);
    const a = r();
    const { o, out } = cmp('l_1D16', 0x1d1c, state(s + 500), { hl, af: (a << 8) | cf, iy },
      { hl, a, iy, cf });
    assert.equal(out.de, o.de);
    // c_1D03 needs a set bit within the two it looks at, or B >= 2
    const b2 = 2 + (r() % 4);
    const c2 = r();
    const r2 = cmp('c_1D03', 0x1d09, state(s + 700), { bc: (b2 << 8) | c2, de: 0x92cd, iy, af_: cf },
      { b: b2, c: c2, de: 0x92cd, iy, cf_: cf });
    assert.equal(r2.out.b, r2.o.bc >> 8);
    assert.equal(r2.out.c, r2.o.bc & 0xff);
    assert.equal(r2.out.de, r2.o.de);
  }
  // c_1C8D when the candidate is not resting (it returns normally)
  for (let s = 0; s < 40; s += 1) {
    const r = rng(s);
    const b = 1 + (r() & 3);
    const m = state(s, (mm) => { for (let e = 0x30; e < 0x38; e += 2) mm.poke(0x8800 + e, s & 1 ? 0 : 2); });
    const o = runOracle(0x1c93, { bc: b << 8, de: 0x8800 });
    const out = MAIN.c_1C8D(m, { b, c: 0, ixl: 0 });
    same(m, 'c_1C8D');
    assert.equal(out.done, false);
    assert.equal(out.cf ? 1 : 0, CY(o));
  }
});

test('f_1D32 nest on/off screen', () => {
  withStubs(() => {
    for (let s = 0; s < 40; s += 1) {
      const m = state(s, (mm, r) => {
        mm.poke(0x99b4, [0x7e, 0xfe, 0x00, 0x80, r(), r(), 0x7d, 0xfd][s % 8]);
        mm.poke(0x9215, (s >> 3) & 1);
        for (let i = 0; i < 12; i += 2) mm.poke(0x9814 + i, [0x00, 0xff, 0x80, r()][r() & 3]);
        // c_23E0 dispatches on every object's state: keep them valid
        // (inactive $80 or resting 1)
        for (let l = 0; l < 0x80; l += 2) mm.poke(0x8800 + l, r() & 1 ? 0x80 : 0x01);
      });
      cmp('f_1D32', 0x1d38, m);
    }
  });
});

test('f_1D76 star control', () => {
  for (let s = 0; s < 64; s += 1) {
    const m = state(s, (mm, r) => {
      mm.poke(0x99b9, s & 1 ? r() | 1 : 0);
      mm.poke(0x99ba, s & 2 ? r() | 1 : 0);
      mm.poke(0x99bb, r() & 7);
      mm.poke(0x99bc, s & 4 ? mm.peek(0x99bb) : r() & 7);
      mm.poke(0x9215, (s >> 3) & 1);
    });
    cmp('f_1D76', 0x1d7c, m);
  }
});

test('f_1DB3 enemy hit notifications, f_1DD2 game timers', () => {
  for (let s = 0; s < 16; s += 1) {
    cmp('f_1DB3', 0x1db9, state(s));
    const m = state(s + 20, (mm, r) => {
      mm.poke(0x92a2, s & 1 ? r() | 1 : r() & 0xfe);
      for (let i = 0; i < 4; i += 1) mm.poke(0x92ac + i, r() & 1 ? 0 : r());
    });
    cmp('f_1DD2', 0x1dd8, m);
  }
});

test('f_1DE6 formation breathing and c_1E43', () => {
  const counters = [0x00, 0x01, 0x08, 0x10, 0x18, 0x1f, 0xa0, 0x98, 0x90, 0x88, 0x81, 0x85];
  let n = 0;
  for (const cnt of counters) {
    for (const flip of [0, 1]) {
      for (const frame of [0, 4, 1]) {
        const m = state(n++, (mm) => {
          mm.poke(0x920f, cnt);
          mm.poke(0x9215, flip);
          mm.poke(0x92a0, frame);
        });
        cmp('f_1DE6', 0x1dec, m);
      }
    }
  }
  for (let s = 0; s < 20; s += 1) {
    const b = s & 1 ? 1 : 0xff;
    const ix = s & 2 ? 5 : 0x0b;
    const { o, out } = cmp('c_1E43', 0x1e49, state(s), { hl: 0x9920, de: 0x9900, bc: b << 8, ix },
      { hl: 0x9920, de: 0x9900, b, ix });
    assert.equal(out.hl, o.hl);
    assert.equal(out.de, o.de);
  }
});

test('f_1EA4 bomb motion', () => {
  for (let s = 0; s < 60; s += 1) {
    const m = state(s, (mm, r) => {
      for (let l = 0x68; l < 0x78; l += 2) if (r() & 3) mm.poke(0x8b00 + l, 0x30);
      mm.poke(0x9215, s & 1 ? r() | 1 : 0);
      mm.poke(0x92a0, r());
    });
    cmp('f_1EA4', 0x1eaa, m);
  }
});

test('f_1F04 fire button and c_1F0F rocket launch', () => {
  for (let s = 0; s < 128; s += 1) {
    const setup = (mm, r) => {
      mm.poke(0x9215, s & 1);
      mm.poke(0x99b6, r());
      mm.poke(0x99b7, r());
      mm.poke(0x9364, s & 2 ? 0 : r());
      mm.poke(0x9366, s & 4 ? 0 : r());
      mm.poke(0x9b63, s & 8 ? r() | 4 : r() & 0xfb);
      mm.poke(0x8b62, (r() & 0xf8) | (s >> 4));
    };
    cmp('f_1F04', 0x1f0e, state(s, setup));
    cmp('c_1F0F', 0x1f19, state(s + 500, setup));
  }
});

test('f_1F85 control stick and c_1F92', () => {
  const xs = [0, 0x11, 0x12, 0x13, 0x80, 0xd0, 0xd1, 0xd2, 0xe0, 0xe1, 0xe2];
  let n = 0;
  for (const x of xs) {
    for (let v = 0; v < 32; v += 1) {
      const setup = (mm, r) => {
        mm.poke(0x9362, x);
        mm.poke(0x9215, v & 1);
        mm.poke(0x9827, (v >> 1) & 1);
        mm.poke(0x92a3, (v >> 2) & 1);
        const bits = [0x0a, 0x08, 0x02, 0x00][v >> 3];
        mm.poke(0x99b6, (r() & 0xf5) | bits);
        mm.poke(0x99b7, (r() & 0xf5) | bits);
      };
      cmp('f_1F85', 0x1f8f, state(n++, setup));
      const m = state(n++, setup);
      const a = m.peek(0x99b6);
      const e = m.peek(0x9827);
      cmp('c_1F92', 0x1f9c, m, { af: a << 8, de: e }, { a, e });
    }
  }
});
