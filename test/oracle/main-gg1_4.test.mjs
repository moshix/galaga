// Copyright 2026 by Moshix
/**
 * Differential tests for main CPU $3000-$3FFF (src/game/main/gg1_4*.js):
 * every routine that runs in isolation is run on the oracle (the real ROM on
 * the emulated board) and in the port from identical seeded-random RAM, and
 * the RAM and returned registers must match.
 *
 * The power-on self test (jp_RAM_test) is checked end to end in a "hybrid":
 * the oracle boots the whole board (with the 51XX/54XX MCUs); every RAM write
 * made by anything other than the main CPU's foreground (sub and sound CPUs,
 * the main CPU's IRQ and NMI handlers) is recorded with its cycle and
 * replayed into the port at the start of the port frame it belongs to. The
 * port runs only the jp_RAM_test generator; after every frame its RAM must
 * equal the oracle's at the lock-step sampling point (line 63 of the next
 * frame, test/helpers/lockstep.mjs), and it must reach j_Game_init in the
 * same frame with the same RAM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeOracle, loadChips, callRoutine, diffRam, loadState,
} from '../helpers/oracle.mjs';
import { CYCLES_PER_FRAME, CYCLES_PER_LINE } from '../z80/machine.mjs';
import { Machine } from '../../src/machine/machine.js';
import { IoBus } from '../../src/game/io.js';
import { SPIN } from '../../src/game/scheduler.js';
import { Namco51 } from '../../src/machine/namco51.js';
import '../../src/game/main/index.js';
import { MAIN } from '../../src/game/main/routines.js';
import {
  CYCLES, FRAME_ORIGIN, BOOT_ENTRY_CYCLE, SERVICE_ENTRY, ramTestNext,
} from '../../src/game/main/gg1_4_post.js';

// ------------------------------------------------------------------ setup

/** Deterministic PRNG (mulberry32). @param {number} seed */
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

/** One board, reused: routine tests overwrite all its RAM each time. */
const board = makeOracle();

/**
 * Fresh identical seeded-random RAM in the oracle and a new port Machine.
 * @param {number} seed
 * @returns {{ m: Machine, r: () => number, byte: () => number }}
 */
function fresh(seed) {
  const r = rng(seed);
  const m = new Machine();
  for (const key of ['video', 'ram1', 'ram2', 'ram3']) {
    const a = m[key];
    for (let i = 0; i < a.length; i += 1) a[i] = Math.floor(r() * 256);
  }
  loadState(board, m);
  board.dswA = m.dswA;
  board.dswB = m.dswB;
  board.videoLatch.fill(0);
  m.videoLatch.fill(0);
  return { m, r, byte: () => Math.floor(r() * 256) };
}

/** Poke the same byte into both. @param {Machine} m */
function poke2(m, addr, v) {
  m.poke(addr, v);
  board.poke(addr, v);
}

/** @param {Machine} m @param {string} what */
function same(m, what) {
  assert.deepEqual(diffRam(board, m), [], what);
}

const A = (regs) => regs.af >> 8;
const CF = (regs) => (regs.af & 0x01) !== 0;
const ZF = (regs) => (regs.af & 0x40) !== 0;

/**
 * Run the oracle's main CPU from `pc` until it reaches one of `stops`
 * (for routines that never return, or leave through a popped frame).
 * @returns {number} the stop PC reached
 */
function runUntil(regs, stops, maxCycles = 5_000_000) {
  const z = board.cpus[0];
  z.setRegisters({ sp: 0x90a0, iff1: 0, iff2: 0, ...regs });
  let cycles = 0;
  while (!stops.includes(z.pc)) {
    cycles += z.step();
    if (cycles > maxCycles) throw new Error(`no stop reached (pc=$${z.pc.toString(16)})`);
  }
  return z.pc;
}

// ------------------------------------------------------------ text output

const TEXT_STRINGS = [
  0x3298, 0x32b4, 0x3a51, 0x3ada, 0x3ae4, 0x3aee, 0x3af5, 0x3b00, 0x3b08,
  0x3b11, 0x3b2b, 0x3b38, 0x3b43, 0x3b4f, 0x3b5a, 0x3b66, 0x3b71, 0x3b8b,
  0x3b95,
];
const TEXT_CE_STRINGS = [0x327f, 0x32ab, 0x3345, 0x335c];

test('c_text_out ($331B) writes every string of the range', () => {
  for (const hl of TEXT_STRINGS) {
    const { m } = fresh(hl);
    const regs = callRoutine(board, 0, 0x331b, { hl });
    const out = MAIN.c_text_out(m, { hl });
    same(m, `string $${hl.toString(16)}`);
    assert.equal(out.hl, regs.hl);
    assert.equal(out.de, regs.de);
  }
});

test('c_text_out_ce ($3328) writes text and colour', () => {
  for (const hl of TEXT_CE_STRINGS) {
    const { m } = fresh(hl);
    const regs = callRoutine(board, 0, 0x3328, { hl });
    const out = MAIN.c_text_out_ce(m, { hl });
    same(m, `string $${hl.toString(16)}`);
    assert.equal(out.hl, regs.hl);
    assert.equal(out.de, regs.de);
  }
});

test('c_3270, c_3273, c_3275 ($3270-$327E)', () => {
  for (let i = 0; i < 20; i += 1) {
    const { m, r } = fresh(100 + i);
    const hl = 0x8800 + Math.floor(r() * 0x300);
    const de = 0x8040 + Math.floor(r() * 0x380);
    let regs = callRoutine(board, 0, 0x3275, { hl, de });
    let out = MAIN.c_3275(m, { hl, de });
    same(m, 'c_3275');
    assert.equal(out.hl, regs.hl);
    assert.equal(out.de, regs.de);
    regs = callRoutine(board, 0, 0x3270, { hl, de });
    out = MAIN.c_3270(m, { hl, de });
    same(m, 'c_3270');
    assert.equal(out.hl, regs.hl);
    assert.equal(out.de, regs.de);
    regs = callRoutine(board, 0, 0x3273, { de });
    assert.equal(MAIN.c_3273(m, { de }).de, regs.de);
  }
});

/** A plausible TOP 5 table: scores (digit codes, blanks), initials. */
function seedTop5(m, r) {
  for (let k = 0; k < 5; k += 1) {
    const len = 4 + Math.floor(r() * 3);
    for (let d = 0; d < 6; d += 1) {
      poke2(m, 0x8a20 + k * 6 + d, d < len ? Math.floor(r() * 10) : 0x24);
    }
  }
  for (let i = 0; i < 15; i += 1) poke2(m, 0x8a3e + i, 0x0a + Math.floor(r() * 26));
}

test('c_puts_top5scores ($321D), c_3231 and c_mach_hiscore_show ($3214)', () => {
  for (let i = 0; i < 6; i += 1) {
    const { m, r } = fresh(200 + i);
    seedTop5(m, r);
    callRoutine(board, 0, i & 1 ? 0x3214 : 0x321d);
    if (i & 1) MAIN.c_mach_hiscore_show(m);
    else MAIN.c_puts_top5scores(m);
    same(m, 'table');
    for (let b = 1; b <= 5; b += 1) {
      const regs = callRoutine(board, 0, 0x3231, { bc: b << 8 });
      const out = MAIN.c_3231(m, { b });
      same(m, `c_3231 b=${b}`);
      assert.equal(out.b, regs.bc >> 8);
      assert.equal(out.de, regs.de);
    }
  }
});

// ------------------------------------------------------ high-score dialog

/**
 * Write a 6-digit score (value, possibly with leading blanks) so that `top`
 * is its 100000's digit. @param {Machine} m
 */
function writeScore(m, top, digits) {
  for (let d = 0; d < 6; d += 1) poke2(m, top - d, digits[d]);
}

/** Random score digits, most significant first, with leading blanks. */
function randomDigits(r) {
  const len = 1 + Math.floor(r() * 6);
  const out = [];
  for (let d = 0; d < 6; d += 1) {
    if (d < 6 - len) out.push(0x24);
    else out.push(Math.floor(r() * (r() < 0.3 ? 2 : 10)));
  }
  return out;
}

test('c_31F7_chk_score_rank ($31F7) on random, equal and blank scores', () => {
  for (let i = 0; i < 400; i += 1) {
    const { m, r } = fresh(300 + i);
    const pl = r() < 0.5 ? 0x83fd : 0x83e8;
    poke2(m, 0x8a00, pl & 0xff);
    poke2(m, 0x8a01, pl >> 8);
    const de = [0x8a25, 0x8a2b, 0x8a31, 0x8a37, 0x8a3d][i % 5];
    const a = randomDigits(r);
    writeScore(m, pl, a);
    writeScore(m, de, i % 7 === 0 ? a : randomDigits(r));
    const regs = callRoutine(board, 0, 0x31f7, { de });
    const out = MAIN.c_31F7_chk_score_rank(m, { de });
    assert.equal(out.cf, CF(regs), `case ${i}`);
    assert.equal(out.zf, ZF(regs), `case ${i}`);
    assert.equal(out.a, A(regs), `case ${i}`);
    same(m, `case ${i}`);
  }
});

test('c_3118_insert_top5_score ($3118) and its jump table, ranks 1-5', () => {
  for (let i = 0; i < 25; i += 1) {
    const { m, r } = fresh(400 + i);
    const rank = (i % 5) + 1;
    poke2(m, 0x8a11, rank);
    const pl = r() < 0.5 ? 0x83fd : 0x83e8;
    poke2(m, 0x8a00, pl & 0xff);
    poke2(m, 0x8a01, pl >> 8);
    const hl = 0x31a6 + 2 * (rank - 1);
    callRoutine(board, 0, 0x3118, { hl });
    MAIN.c_3118_insert_top5_score(m, { hl });
    same(m, `rank ${rank}`);
  }
});

test('hilite line ($3180), char colour ($3141), letter loads ($3138-$313E)', () => {
  for (let rank = 1; rank <= 5; rank += 1) {
    const { m } = fresh(500 + rank);
    poke2(m, 0x8a11, rank);
    callRoutine(board, 0, 0x3180);
    MAIN.c_plyr_initials_entry_hilite_line(m);
    same(m, `rank ${rank}`);
    for (const l of [0x49, 0x29, 0x09]) {
      poke2(m, 0x8a10, l);
      callRoutine(board, 0, 0x3141);
      MAIN.c_3141_xor_char_color(m);
      same(m, 'xor');
    }
  }
  for (const [addr, fn] of [[0x3138, 'c_3138_lda2A'], [0x313b, 'c_313B_lda24'], [0x313e, 'c_313E_lda0A']]) {
    assert.equal(MAIN[fn]().a, A(callRoutine(board, 0, addr)));
  }
});

test('c_32ED_top5_dlg_endproc ($32ED): coin, free play, timer, finish', () => {
  // The finishing path pops its own return address: run it with two
  // sentinel return addresses and see which one the ROM returns to.
  for (let i = 0; i < 60; i += 1) {
    const { m, r } = fresh(600 + i);
    const credits = [0xa0, 0x03, 0x05, 0x00][i % 4];
    poke2(m, 0x99b5, credits);
    poke2(m, 0x99b8, [0x03, 0x02, 0x05, 0x00, 0x09][i % 5]);
    poke2(m, 0x92ae, i % 3 === 0 ? 0 : 1 + Math.floor(r() * 0x28));
    poke2(m, 0x8a10, [0x49, 0x29, 0x09][i % 3]);
    const slot = 0x8a3d + Math.floor(r() * 12);
    poke2(m, 0x8a04, slot & 0xff);
    poke2(m, 0x8a05, slot >> 8);
    const z = board.cpus[0];
    z.setRegisters({ sp: 0x90a0 });
    z.push16(0x3fff); // the caller of c_top5_dlg_proc
    z.push16(0x3ffe); // c_top5_dlg_proc itself
    const stop = runUntil({ pc: 0x32ed, sp: z.sp }, [0x3ffe, 0x3fff]);
    const done = MAIN.c_32ED_top5_dlg_endproc(m);
    assert.equal(done, stop === 0x3fff, `case ${i}`);
    same(m, `case ${i}`);
  }
});

/**
 * The oracle side of a frame-driven test: run the main CPU alone from `pc`
 * and play the part of the interrupt handlers with `vblank()` each time the
 * code goes round one of its wait loops (`edges`: [branch pc, target pc]),
 * which is exactly where the port yields.
 */
function runFramed(pc, edges, stops, vblank, maxFrames) {
  const z = board.cpus[0];
  z.setRegisters({ pc, sp: 0x90a0, iff1: 0, iff2: 0 });
  z.push16(0x3fff);
  let frames = 0;
  let prev = -1;
  for (;;) {
    if (stops.includes(z.pc)) return frames;
    if (edges.some(([from, to]) => prev === from && z.pc === to)) {
      frames += 1;
      if (frames > maxFrames) throw new Error('too many frames');
      vblank(board);
    }
    prev = z.pc;
    z.step();
  }
}

test('c_top5_dlg_proc ($3000): initials entry, timeouts, coin-in', () => {
  // Wait loops of the dialog, as (jr pc, target pc): $30AE, $30C6, $317D.
  const edges = [[0x30ae, 0x30aa], [0x30c6, 0x30bf], [0x317d, 0x3179]];
  for (let i = 0; i < 12; i += 1) {
    const { m, r } = fresh(700 + i);
    seedTop5(m, r);
    const player = i & 1;
    poke2(m, 0x9840, player);
    poke2(m, 0x9215, (i >> 1) & 1);
    // The player's score on screen: beats a random number of entries.
    const pl = player ? 0x83e8 : 0x83fd;
    writeScore(m, pl, i === 11 ? [0x24, 0x24, 0x24, 0x24, 0, 0] : [0x24, 9, 9, 9, 9, 0]);
    // Entries above the player's rank (i % 5) + 1 hold 100000, the rest
    // 20000; scenario 11's score (0) makes no rank at all.
    for (let k = 0; k < 5; k += 1) {
      writeScore(m, 0x8a25 + 6 * k, k < i % 5 ? [1, 0, 0, 0, 0, 0] : [0x24, 2, 0, 0, 0, 0]);
    }
    poke2(m, 0x99b5, i === 7 ? 0xa0 : 0x02);
    poke2(m, 0x99b8, 0x02);
    poke2(m, 0x92a0, 0);
    // A scripted player: the stick and fire bits of $99B6/$99B7 per frame,
    // and coin-in on one scenario, applied identically on both sides.
    let script = rng(900 + i);
    let frame = 0;
    const vblank = (dev) => {
      frame += 1;
      dev.poke(0x92a0, (dev.peek(0x92a0) + 1) & 0xff);
      if (frame % 30 === 0 && dev.peek(0x92ae) !== 0) dev.poke(0x92ae, dev.peek(0x92ae) - 1);
      const inp = dev.peek(0x9215) ? 0x99b7 : 0x99b6;
      let v = 0x3f;
      const phase = Math.floor(frame / 20) % 4;
      if (i < 9) {
        if (phase === 1) v &= ~0x08; // left (active low bit 3)
        if (phase === 2) v &= ~0x02; // right
        if (phase === 3 && script() < 0.3 && frame > 200) v &= ~0x10; // fire
      }
      dev.poke(inp, v);
      if (i === 5 && frame === 400) dev.poke(0x99b5, 0x03); // coin in
    };
    const frames = runFramed(0x3000, edges, [0x3fff], vblank, 5000);
    const oracleRam = { video: board.video.slice(), ram1: board.ram1.slice(), ram2: board.ram2.slice(), ram3: board.ram3.slice() };
    frame = 0;
    script = rng(900 + i);
    let n = 0;
    for (const _ of MAIN.c_top5_dlg_proc(m)) { n += 1; vblank(m); }
    assert.equal(n, frames, `scenario ${i} frames`);
    assert.deepEqual(diffRam(oracleRam, m), [], `scenario ${i}`);
  }
});

// ----------------------------------------------------------- service mode

test('c_svc_updt_dsply ($37FE) for random dip switches', () => {
  for (let i = 0; i < 300; i += 1) {
    const { m, r, byte } = fresh(1000 + i);
    m.dswA = byte();
    m.dswB = byte();
    board.dswA = m.dswA;
    board.dswB = m.dswB;
    poke2(m, 0x99b5, byte());
    callRoutine(board, 0, 0x37fe);
    MAIN.c_svc_updt_dsply(m);
    same(m, `dsw ${m.dswA.toString(16)} ${m.dswB.toString(16)}`);
    assert.equal(m.videoLatch[7], board.videoLatch[7], 'flip');
    void r;
  }
});

test('c_38DA ($38E4) and c_391E ($3928) called directly', () => {
  for (let e = 0x3aae; e < 0x3ace; e += 1) {
    for (const c of [0, 1]) {
      const { m } = fresh(e * 2 + c);
      const regs = callRoutine(board, 0, 0x38e4, { hl: e, bc: c });
      const out = MAIN.c_38DA(m, { hl: e, c });
      same(m, `entry $${e.toString(16)} c=${c}`);
      assert.equal(out.hl, regs.hl);
    }
  }
  for (let a = 0; a < 20; a += 1) {
    const { m } = fresh(1400 + a);
    const regs = callRoutine(board, 0, 0x3928, { af: a << 8, hl: 0x81f0 });
    assert.equal(MAIN.c_391E(m, { a, hl: 0x81f0 }).hl, regs.hl);
    same(m, `a=${a}`);
  }
});

test('c_svc_test_input_hdlr ($39E0) for every input bit, sound select', () => {
  for (let i = 0; i < 16 * 6; i += 1) {
    const { m, byte } = fresh(1500 + i);
    const b = (i % 16) + 1;
    poke2(m, 0x9270, [0, 1, 0x10, 0x11, 0x12, byte()][Math.floor(i / 16)]);
    const hl = byte() | (byte() << 8);
    const regs = callRoutine(board, 0, 0x39e0, { bc: (b << 8) | 0x55, hl });
    MAIN.c_svc_test_input_hdlr(m, { b });
    same(m, `b=${b}`);
    assert.equal(regs.hl, hl, 'HL preserved');
    assert.equal(regs.bc >> 8, b, 'B preserved');
  }
  for (const v of [0, 5, 0x11, 0x12, 0xff]) {
    const { m } = fresh(1700 + v);
    poke2(m, 0x9270, v);
    callRoutine(board, 0, 0x39fc);
    MAIN.c_svc_test_sound_sel(m);
    same(m, `sel ${v}`);
  }
});

test('machine totals ($3987, $39C5) and the digit writers', () => {
  for (let i = 0; i < 20; i += 1) {
    const { m } = fresh(1800 + i);
    callRoutine(board, 0, 0x3987);
    MAIN.c_svc_machine_totals(m);
    same(m, 'totals');
    callRoutine(board, 0, 0x39c5);
    MAIN.c_svc_machine_ttls_erase(m);
    same(m, 'erase');
  }
});

test('screen, sprite and sound clears ($3962, $397C, $3A46), cab type ($3A6B)', () => {
  for (const [addr, fn] of [[0x3962, 'c_tileram_regs_clr'], [0x397c, 'c_spriteposn_regs_init'], [0x3a46, 'c_svc_clr_snd_regs']]) {
    const { m } = fresh(addr);
    callRoutine(board, 0, addr);
    MAIN[fn](m);
    same(m, fn);
  }
  for (const hl of [0x3ad6, 0x3ad8]) {
    const { m } = fresh(hl);
    const regs = callRoutine(board, 0, 0x3a6b, { hl });
    const out = MAIN.c_svc_cab_type(m, { hl });
    same(m, 'cab');
    assert.equal(out.hl, regs.hl);
    assert.equal(out.de, regs.de);
  }
  board.poke(0x7100, 0x10); // 06XX idle
  const regs = callRoutine(board, 0, 0x37f6);
  assert.equal(MAIN.c_io_cmd_wait().a, A(regs));
});

test('easter egg column writer ($3770, $377E)', () => {
  const { m } = fresh(1900);
  callRoutine(board, 0, 0x3962);
  MAIN.c_tileram_regs_clr(m);
  let de = 0x37a2;
  let hl = 0x8042;
  for (let b = 0; b < 0x1c; b += 1) {
    const regs = callRoutine(board, 0, 0x3770, { de, hl });
    ({ de, hl } = MAIN.c_svc_easteregg_hdlr(m, { de, hl }));
    assert.equal(de, regs.de);
    assert.equal(hl, regs.hl);
  }
  same(m, 'easter egg');
});

// ------------------------------------------------------------ self tests

test('ROM checksums sum to 0 and take CYCLES.CSUM_CALL', () => {
  for (const de of [0x0000, 0x1000, 0x2000, 0x3000]) {
    const regs = callRoutine(board, 0, 0x352b, { de, bc: 0, hl: 0x9102 });
    assert.equal(A(regs), 0, `ROM $${de.toString(16)}`);
    // callRoutine counts from the first instruction: + 17 for the call.
    assert.equal(regs.cycles + 17, CYCLES.CSUM_CALL);
    const out = MAIN.c_rom_test_csum_calc(new Machine(), { de, c: 0 });
    assert.equal(out.de, regs.de);
    assert.equal(out.zf, true);
  }
});

test('ramTestNext is the ROM sequence ($338E)', () => {
  // Compare with the ROM on one block: c_ram_test_single from HL = seed.
  const { m } = fresh(2000);
  const regs = callRoutine(board, 0, 0x3496, { de: 0x8800, hl: 0x1234 });
  let hl = 0x1234;
  for (let i = 0; i < 0x400; i += 1) hl = ramTestNext(hl);
  let h2 = 0x1234;
  for (let i = 0; i < 0x400; i += 1) { h2 = ramTestNext(h2); m.poke(0x8800 + i, h2 & 0xff); }
  assert.equal(regs.hl, hl);
  assert.deepEqual(diffRam(board, m, { ignore: [[0x9000, 0x90a0]] }), []);
});

test('j_ramtest_ng ($34CA) and j_romtest_ng ($353F) error screens', () => {
  for (let i = 0; i < 20; i += 1) {
    const { m, r } = fresh(2100 + i);
    const de = [0x8000, 0x8400, 0x8800, 0x9000, 0x9800][i % 5] + Math.floor(r() * 0x400);
    const a = [0x01, 0x10, 0x81, 0xff][i % 4];
    runUntil({ pc: 0x34ca, af: a << 8, de }, [0x3525]);
    MAIN.j_ramtest_ng(m, { a, de }).next();
    same(m, `ram ng ${de.toString(16)} ${a}`);
  }
  for (let i = 0; i < 10; i += 1) {
    const { m, byte } = fresh(2200 + i);
    poke2(m, 0x9102, byte());
    runUntil({ pc: 0x353f }, [0x3554]);
    MAIN.j_romtest_ng(m).next();
    same(m, 'rom ng');
  }
});

// ------------------------------------------------------------- the boot

/** The lock-step sample point: line 63 of frame k. */
const B = (k) => k * CYCLES_PER_FRAME + FRAME_ORIGIN;
/** Vblank k (line 224 of frame k). */
const V = (k) => k * CYCLES_PER_FRAME + 224 * CYCLES_PER_LINE;

/**
 * Addresses the Z80's foreground stack writes to during the boot (SP at
 * $8400 during the RAM tests, then $8B00). They are not used as merge
 * points below; whether the port models them is checked by the snapshots.
 */
const STACKISH = (a) => (a >= 0x83f0 && a < 0x8400) || (a >= 0x8ae0 && a < 0x8b00);

/**
 * Boot the oracle from power-on to j_Game_init, recording every RAM write
 * with its cycle, split into the main CPU's foreground writes and all the
 * others (sub and sound CPUs, main CPU interrupt handlers), plus the RAM at
 * every line 63 and vblank, and at $02D3.
 * @param {(board: object, frame: number) => void} [inputs] per-frame input
 *   script (called at each frame start)
 * @param {[number, number] | null} [dsw] DSWA, DSWB
 */
async function recordBoot(inputs = () => {}, dsw = null, entry = 1) {
  const b = makeOracle(await loadChips());
  if (dsw !== null) [b.dswA, b.dswB] = dsw;
  /** Where the port starts: the frame and RAM at the entry-th $336C. */
  let startFrame = -1;
  let startRam = null;
  let startIn = null;
  let entries = 0;
  /** Main CPU interrupt nesting: SP at each handler entry. */
  const handlerSp = [];
  /** @type {Array<[number, number, number]>} [cycle, addr, value] */
  const ext = [];
  /** @type {Array<[number, number, number]>} */
  const own = [];
  let game = -1;
  b.onWrite = (cpu, addr, v) => {
    if (addr < 0x8000 || game >= 0 || startFrame < 0) return;
    if (cpu !== 0 || handlerSp.length > 0) ext.push([b.cpuTime[cpu], addr, v]);
    else if (!STACKISH(addr)) own.push([b.cpuTime[0], addr, v]);
  };
  let gameRam = null;
  const snap = () => ({
    video: b.video.slice(), ram1: b.ram1.slice(), ram2: b.ram2.slice(), ram3: b.ram3.slice(),
  });
  b.onExec = (n, pc, cpu) => {
    if (n !== 0) return;
    if (cpu.pc === 0x336c && (entries += 1) === entry) {
      // The port frame this lands in (line-63 windows), and the RAM then.
      startFrame = Math.floor((b.cpuTime[0] - FRAME_ORIGIN) / CYCLES_PER_FRAME);
      if (b.cpuTime[0] < B(1)) startFrame = 0;
      startRam = snap();
      startIn = [b.in0, b.in1];
      handlerSp.length = 0; // the restart abandons the IRQ handler
    }
    // An interrupt was just taken (nothing in the foreground jumps there).
    if ((cpu.pc === 0x0038 || cpu.pc === 0x0066) && pc !== 0x0038 && pc !== 0x0066) handlerSp.push(cpu.sp);
    while (handlerSp.length > 0 && cpu.sp > handlerSp[handlerSp.length - 1]) handlerSp.pop();
    if (cpu.pc === 0x02d3 && game < 0 && startFrame >= 0) { game = b.cpuTime[0]; gameRam = snap(); }
  };
  /** RAM at B(k) and V(k), index k - 1. */
  const atB = [];
  const atV = [];
  const in01 = [];
  for (let k = 1; game < 0; k += 1) {
    inputs(b, k - 1);
    in01.push([b.in0, b.in1]);
    b.advanceTo(B(k));
    atB.push(snap());
    b.advanceTo(V(k));
    atV.push(snap());
    if (k > 4000) throw new Error('boot did not finish');
  }
  return { ext, own, atB, atV, game, gameRam, in01, startFrame, startRam, startIn };
}

/**
 * Run the port's jp_RAM_test against a recorded boot. The other CPUs'
 * writes are merged in by cycle: every port write (outside 06XX transfers,
 * whose RAM side is the oracle's NMI handler) must be the oracle's next
 * main-foreground write, and all other writes older than it are applied
 * first. After each frame the port RAM must equal the oracle's at the end
 * of the frame's window (line 63 while the main CPU is alone, vblank once
 * the sub CPUs run -- see Clock in gg1_4_post.js), and the port must have
 * made exactly the writes the Z80 made in that window.
 * @returns {{ frames: number, diffs: string[] }}
 */
function replayBoot(rec, { dsw = null, regs = {} } = {}) {
  const m = new Machine();
  if (dsw !== null) [m.dswA, m.dswB] = dsw;
  loadState(m, rec.startRam);
  const n51 = new Namco51();
  const bus = new IoBus(m, { n51, n54: { write() {} } });
  let inTransfer = false;
  m.io = /** @type {IoBus} */ ({
    transfer(control, addr, count) {
      inTransfer = true;
      try { bus.transfer(control, addr, count); } finally { inTransfer = false; }
    },
  });
  let e = 0;
  let j = 0;
  const diffs = [];
  /** Apply the other CPUs' writes older than `limit`. */
  const replay = (limit) => {
    while (e < rec.ext.length && rec.ext[e][0] < Math.min(limit, rec.game)) {
      const [, addr, v] = rec.ext[e];
      Machine.prototype.poke.call(m, addr, v);
      e += 1;
    }
  };
  m.poke = (addr, v) => {
    if (addr >= 0x8000 && !inTransfer && !STACKISH(addr)) {
      const want = rec.own[j];
      if (want === undefined || want[1] !== addr || want[2] !== (v & 0xff)) {
        const w = want ? `$${want[1].toString(16)}=$${want[2].toString(16)}` : 'none';
        diffs.push(`write #${j}: port $${addr.toString(16)}=$${(v & 0xff).toString(16)}, oracle ${w}`);
        throw new Error('write sequence diverged');
      }
      replay(want[0]);
      j += 1;
    }
    Machine.prototype.poke.call(m, addr, v);
  };
  let reached = false;
  const saved = MAIN.j_Game_init;
  MAIN.j_Game_init = function* stub() { reached = true; for (;;) yield; };
  const clock = { t: 0, realign: false, vblankAligned: false };
  try {
    const gen = MAIN.jp_RAM_test(m, { ...regs, clock });
    for (let y = rec.startFrame; y < rec.atB.length; y += 1) {
      [m.in0, m.in1] = rec.in01[y];
      n51.setInputs(m.in0, m.in1);
      n51.vblank();
      // Before the frame runs: everything up to the Z80's next own write,
      // or the whole window if it makes none (it only polls).
      const next = rec.own[j] ? rec.own[j][0] : Infinity;
      replay(Math.min(next, clock.vblankAligned ? V(y + 1) : B(y + 1)));
      // One port frame. A SPIN means the other CPUs have nothing more for
      // it this frame: all their writes of the window are in already.
      const r = gen.next();
      assert.ok(!r.done);
      void SPIN;
      if (reached) {
        replay(rec.game);
        const d = diffRam(rec.gameRam, m, { ignore: [[0x8ae0, 0x8b00]] });
        return { frames: y, diffs: diffs.concat(d.map((x) => `at j_Game_init: ${x}`)) };
      }
      const end = clock.vblankAligned ? V(y + 1) : B(y + 1);
      replay(end);
      const late = rec.own[j] && rec.own[j][0] < end;
      if (late) diffs.push(`frame ${y}: port did not make oracle write #${j} in time`);
      const early = j > 0 && rec.own[j - 1][0] >= end;
      if (early) diffs.push(`frame ${y}: port made oracle write #${j - 1} a frame early`);
      // After j_romtest_mgr the Z80's calls push onto a stack at $8B00 that
      // the port does not model (as with the $9030-$90FF stacks).
      const ignore = y >= rec.startFrame + 700 ? [[0x8ae0, 0x8b00]] : [];
      const want = clock.vblankAligned ? rec.atV[y] : rec.atB[y];
      const d = diffRam(want, m, { ignore, limit: 8 });
      if (d.length > 0 || late || early) return { frames: y, diffs: diffs.concat(d.map((x) => `frame ${y}: ${x}`)) };
    }
    return { frames: -1, diffs };
  } catch (err) {
    if (diffs.length === 0) throw err;
    return { frames: -1, diffs };
  } finally {
    MAIN.j_Game_init = saved;
  }
}

test('boot: every frame of the self test matches the oracle, default switches', async () => {
  const rec = await recordBoot();
  // Port frame of $02D3: vblank-aligned by then.
  const expected = Math.floor((rec.game - V(0)) / CYCLES_PER_FRAME);
  const { frames, diffs } = replayBoot(rec);
  assert.deepEqual(diffs, []);
  assert.equal(frames, expected, 'frame of the jump to j_Game_init');
  assert.equal(BOOT_ENTRY_CYCLE, 480 - 63 * CYCLES_PER_LINE);
});

/**
 * A scripted switch: held during [from, to) frames.
 * @returns {(b: object, f: number) => void}
 */
function script(presses) {
  return (b, f) => {
    const held = new Set();
    for (const [name, from, to] of presses) if (f >= from && f < to) held.add(name);
    for (const name of ['left', 'right', 'fire', 'service', 'test', 'start1', 'start2', 'coin1']) {
      b.setInput(name, held.has(name));
    }
  };
}

test('boot: service mode -- sound test, machine totals, easter egg', async () => {
  const presses = [['test', 0, 1060]];
  // Sound selection: right, right, left; play it with fire; a coin plays
  // one too; the service switch shows the machine totals.
  for (const [name, f] of [['right', 740], ['right', 752], ['left', 764], ['fire', 776], ['coin1', 788], ['service', 800]]) {
    presses.push([name, f, f + 4]);
  }
  // Fire held, then 5 R, 6 L, 3 R, 7 L: the easter egg.
  presses.push(['fire', 820, 1010]);
  let f = 830;
  for (const [name, n] of [['right', 5], ['left', 6], ['right', 3], ['left', 7]]) {
    for (let i = 0; i < n; i += 1) { presses.push([name, f, f + 4]); f += 8; }
  }
  const rec = await recordBoot(script(presses));
  const { frames, diffs } = replayBoot(rec);
  assert.deepEqual(diffs, []);
  assert.equal(frames, Math.floor((rec.game - V(0)) / CYCLES_PER_FRAME));
  // The easter egg really was drawn: "(c)" is a block of $25 tiles.
  assert.ok(rec.atV[1000].video.subarray(0x40, 0x400).filter((v) => v === 0x25).length > 100);
});

test('boot: free play, table, 5 fighters, no bonus; test switch in the pause and the cross hatch', async () => {
  // DSWA $7F: table (bit 7 clear). DSWB $C0: 5 fighters, bonus none, free play.
  for (const dsw of [[0x7f, 0xc0], [0xf5, 0x3a], [0xf7, 0xa8]]) {
    const rec = await recordBoot(script([['test', 800, 900], ['test', 740, 741], ['test', 726, 733]]), dsw);
    const { frames, diffs } = replayBoot(rec, { dsw });
    assert.deepEqual(diffs, [], `dsw ${dsw}`);
    assert.equal(frames, Math.floor((rec.game - V(0)) / CYCLES_PER_FRAME));
  }
});

test('restart from the service switch in attract mode ($097C -> $336C)', async () => {
  // Test switch on at frame 1300: the 51XX reports $BB, f_0977 jumps to
  // the RAM test from the IRQ handler; the switch stays on through the
  // self test (service mode) and goes off at frame 2200.
  const rec = await recordBoot(script([['test', 1300, 2200], ['right', 2100, 2104]]), null, 2);
  const { frames, diffs } = replayBoot(rec, { regs: SERVICE_ENTRY });
  assert.deepEqual(diffs, []);
  assert.equal(frames, Math.floor((rec.game - V(0)) / CYCLES_PER_FRAME));
});
