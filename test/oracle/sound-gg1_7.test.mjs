// Copyright 2026 by Moshix
/**
 * Differential tests of the sound CPU port (src/game/sound/gg1_7.js)
 * against the real gg1_7b.2c code running on the oracle board.
 *
 * Each test puts identical RAM in the oracle and in a port Machine, makes
 * sound requests the way the main CPU does (writes to $9AA0-$9AB7, $9A79,
 * $9211), then runs the NMI handler ($0066) on both sides hundreds of times,
 * demanding after every NMI that RAM, the WSG registers and the NMI mask
 * latch are identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOracle, callRoutine, diffRam } from '../helpers/oracle.mjs';
import { Machine } from '../../src/machine/machine.js';
import '../../src/game/sound/index.js';
import { SOUND } from '../../src/game/sound/routines.js';
import { loadGalaga } from '../../tools/romset.mjs';

/** Seeded PRNG (mulberry32), so failures reproduce. @param {number} seed */
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

/** A fresh oracle and port with all RAM zero (the state after RESET). */
function pair() {
  return { board: makeOracle(), m: new Machine() };
}

/**
 * Write a byte into both machines.
 * @param {{board: ReturnType<typeof makeOracle>, m: Machine}} p
 * @param {number} addr @param {number} v
 */
function poke(p, addr, v) {
  p.board.poke(addr, v);
  p.m.poke(addr, v);
}

/**
 * Run one NMI on both sides and compare everything observable.
 * @param {{board: ReturnType<typeof makeOracle>, m: Machine}} p
 * @param {string} what label for failure messages
 */
function nmi(p, what) {
  callRoutine(p.board, 2, 0x0066);
  SOUND.sound_nmi(p.m);
  const d = diffRam(p.board, p.m);
  assert.deepEqual(d, [], `${what}: RAM differs`);
  assert.deepEqual([...p.m.wsg], [...p.board.wsg], `${what}: WSG differs`);
  assert.equal(p.m.misc[2], p.board.misc[2], `${what}: $6822 differs`);
}

/** True while any request slot or active flag is up. @param {Machine} m */
function busy(m) {
  for (let a = 0x9aa0; a <= 0x9ab6; a += 1) if (m.peek(a) !== 0) return true;
  for (let a = 0x9ac0; a <= 0x9ad6; a += 1) if (m.peek(a) !== 0) return true;
  return false;
}

test('ROM checksum constant matches gg1_7b.2c', () => {
  const rom = loadGalaga().sound;
  let sum = 0;
  for (let i = 0; i < 0x1000; i += 1) sum = (sum + rom[i]) & 0xff;
  assert.equal(sum, 0xff);
});

test('RESET: self-test handshake and RAM clear match the ROM', () => {
  const p = pair();
  const r = rng(7);
  // Junk in the sound CPU's RAM page, to see it cleared.
  for (let a = 0x9a00; a < 0x9b00; a += 1) poke(p, a, Math.floor(r() * 256));
  poke(p, 0x9101, 0);
  const z = p.board.cpus[2];
  z.setRegisters({ pc: 0x0000, iff1: 0, iff2: 0 });
  let cycles = 0;
  // Until the checksum result lands in $9101.
  while (p.board.peek(0x9101) === 0) {
    cycles += z.step();
    assert.ok(cycles < 1_000_000, 'oracle never posted its checksum');
  }
  const gen = SOUND.sound_reset(p.m);
  let yields = 0;
  while (p.m.peek(0x9101) === 0) { gen.next(); yields += 1; assert.ok(yields < 10); }
  assert.equal(p.m.peek(0x9101), 0xff);
  assert.deepEqual(diffRam(p.board, p.m), []);
  assert.equal(p.m.misc[2], 1, 'NMI masked during the self-test');
  assert.equal(p.m.misc[2], p.board.misc[2]);
  // Both wait while $9101 is non-zero.
  for (let i = 0; i < 3; i += 1) gen.next();
  for (let i = 0; i < 1000; i += 1) z.step();
  assert.equal(z.pc >= 0x00a4 && z.pc <= 0x00a6, true);
  // The main CPU acknowledges.
  poke(p, 0x9101, 0);
  while (z.pc !== 0x00b9) {
    z.step();
  }
  gen.next();
  assert.deepEqual(diffRam(p.board, p.m), []);
  assert.equal(p.m.misc[2], 0);
  assert.equal(p.m.misc[2], p.board.misc[2]);
  // Idle forever.
  assert.equal(gen.next().done, false);
});

/**
 * Request slots as the main CPU uses them: [name, address, value, kind].
 * "once" requests are tunes/effects the sound CPU consumes itself;
 * "hold" requests stay set while the sound should keep playing.
 * @type {[string, number, number, 'once'|'hold'][]}
 */
const REQUESTS = [
  ['pulsing formation', 0x9aa0, 1, 'hold'],
  ['blue boss hit', 0x9aa1, 1, 'once'],
  ['red alien hit', 0x9aa2, 1, 'once'],
  ['yellow alien hit', 0x9aa3, 1, 'once'],
  ['green boss hit', 0x9aa4, 1, 'once'],
  ['capture beam 1', 0x9aa5, 1, 'hold'],
  ['capture beam 2', 0x9aa6, 1, 'hold'],
  ['fighter shot down', 0x9aa7, 1, 'once'],
  ['coin x2', 0x9aa8, 2, 'once'],
  ['slot 9', 0x9aa9, 1, 'hold'],
  ['extra fighter', 0x9aaa, 1, 'once'],
  ['start theme', 0x9aab, 1, 'once'],
  ['high score 1st', 0x9aac, 3, 'once'],
  ['challenge intro', 0x9aad, 1, 'once'],
  ['challenge melody', 0x9aae, 1, 'once'],
  ['shot', 0x9aaf, 1, 'once'],
  ['high score tune', 0x9ab0, 1, 'hold'],
  ['rescued ship', 0x9ab1, 1, 'hold'],
  ['bonus bee', 0x9ab2, 1, 'once'],
  ['dive attack', 0x9ab3, 1, 'once'],
  ['perfect', 0x9ab4, 1, 'once'],
  ['stage tokens', 0x9ab5, 2, 'once'],
  ['high score (2)', 0x9ab6, 1, 'once'],
];

for (const [name, addr, value, kind] of REQUESTS) {
  test(`request ${name} ($${addr.toString(16).toUpperCase()}=${value})`, () => {
    const p = pair();
    poke(p, addr, value);
    let n = 0;
    if (kind === 'hold') {
      for (; n < 700; n += 1) {
        // The formation breathes: flip its direction now and then.
        // f_1DE6 ($1E13) writes $9211 = $01 (expanding) or $FF
        // (contracting) in the same frame it enables the pulse.
        if (addr === 0x9aa0 && n % 150 === 0) poke(p, 0x9211, (n / 150) % 2 ? 0xff : 0x01);
        nmi(p, `${name} #${n}`);
      }
      poke(p, addr, 0);
      for (let i = 0; i < 40; i += 1, n += 1) nmi(p, `${name} release #${n}`);
    } else {
      // Until the sound has run its course (and a little more), capped.
      let quiet = 0;
      for (; n < 6000 && quiet < 30; n += 1) {
        nmi(p, `${name} #${n}`);
        quiet = busy(p.m) ? 0 : quiet + 1;
      }
    }
    assert.ok(n > 20);
  });
}

test('coin-in counter $9A79 feeds the coin slot', () => {
  const p = pair();
  poke(p, 0x9a79, 3);
  for (let n = 0; n < 900; n += 1) {
    if (n === 100) poke(p, 0x9a79, 1);
    nmi(p, `coin #${n}`);
  }
});

test('sound_mgr_reset ($9AB7) silences everything', () => {
  const p = pair();
  poke(p, 0x9aab, 1);
  poke(p, 0x9aa5, 1);
  for (let n = 0; n < 60; n += 1) nmi(p, `play #${n}`);
  poke(p, 0x9ab7, 1);
  for (let n = 0; n < 10; n += 1) nmi(p, `reset #${n}`);
  poke(p, 0x9ab7, 0);
  for (let n = 0; n < 10; n += 1) nmi(p, `after #${n}`);
});

test('re-entry guard $9A8C: the NMI returns at once', () => {
  const p = pair();
  poke(p, 0x9aab, 1);
  poke(p, 0x9a8c, 1);
  for (let n = 0; n < 5; n += 1) nmi(p, `guarded #${n}`);
  assert.equal(p.m.peek(0x9aab), 1, 'nothing ran');
});

test('$9AB8 clears the sound page (then RETs through $9B00)', () => {
  const p = pair();
  const r = rng(99);
  for (let a = 0x9a00; a < 0x9ab8; a += 1) poke(p, a, Math.floor(r() * 256));
  poke(p, 0x9a8c, 0);
  poke(p, 0x9ab8, 1);
  // The ROM returns to the word at $9B00; aim it at a parking address.
  poke(p, 0x9b00, 0xff);
  poke(p, 0x9b01, 0x3f);
  const z = p.board.cpus[2];
  z.setRegisters({ pc: 0x0066, sp: 0x90a0, iff1: 0, iff2: 0 });
  let cycles = 0;
  while (z.pc !== 0x3fff) { cycles += z.step(); assert.ok(cycles < 100_000); }
  SOUND.sound_nmi(p.m);
  assert.deepEqual(diffRam(p.board, p.m), []);
});

test('random request traffic, 6000 NMIs', () => {
  const p = pair();
  const r = rng(12345);
  poke(p, 0x9211, 0x01);
  const hold = REQUESTS.filter((q) => q[3] === 'hold');
  const once = REQUESTS.filter((q) => q[3] === 'once');
  for (let n = 0; n < 6000; n += 1) {
    const x = r();
    if (x < 0.02) {
      const [, addr, value] = once[Math.floor(r() * once.length)];
      poke(p, addr, value);
    } else if (x < 0.03) {
      const [, addr] = hold[Math.floor(r() * hold.length)];
      poke(p, addr, p.m.peek(addr) ? 0 : 1);
    } else if (x < 0.035) {
      poke(p, 0x9211, r() < 0.5 ? 0xff : 0x01);
    } else if (x < 0.037) {
      poke(p, 0x9a79, 1 + Math.floor(r() * 3));
    } else if (x < 0.0375) {
      poke(p, 0x9ab7, 1);
    } else if (p.m.peek(0x9ab7) && x < 0.2) {
      poke(p, 0x9ab7, 0);
    }
    nmi(p, `random #${n}`);
  }
});
