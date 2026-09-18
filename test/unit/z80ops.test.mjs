// Copyright 2026 by Moshix
/**
 * src/game/z80ops.js must agree with the oracle's Z80 core for every input,
 * since the port leans on it wherever the ROM leans on a flag or on BCD.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Z80 } from '../z80/z80.mjs';
import { add8, sub8, daa, bcdAdd, rlca, rrca, rla, rra } from '../../src/game/z80ops.js';

/** A CPU with A and F preset, running one opcode sequence from address 0. */
function run(bytes, a, f, n = 1) {
  const mem = new Uint8Array(0x100);
  mem.set(bytes);
  const cpu = new Z80({ read: (x) => mem[x & 0xff], write: () => {} });
  cpu.a = a; cpu.f = f;
  for (let i = 0; i < n; i += 1) cpu.step();
  return cpu;
}

test('add8/adc8 match the core for all A, V and carry-in', () => {
  for (let a = 0; a < 256; a += 1) {
    for (let v = 0; v < 256; v += 7) {
      for (const c of [0, 1]) {
        const cpu = run([0xce, v], a, c); // adc a,n
        const r = add8(a, v, c);
        assert.equal(r.a, cpu.a); assert.equal(r.f, cpu.f);
      }
    }
  }
});

test('sub8/sbc8 match the core', () => {
  for (let a = 0; a < 256; a += 1) {
    for (let v = 0; v < 256; v += 5) {
      for (const c of [0, 1]) {
        const cpu = run([0xde, v], a, c); // sbc a,n
        const r = sub8(a, v, c);
        assert.equal(r.a, cpu.a); assert.equal(r.f, cpu.f);
      }
    }
  }
});

test('daa matches the core for every A and every N/H/C combination', () => {
  for (let a = 0; a < 256; a += 1) {
    for (const f of [0, 1, 2, 3, 0x10, 0x11, 0x12, 0x13]) {
      const cpu = run([0x27], a, f);
      const r = daa(a, f);
      assert.equal(r.a, cpu.a, `a=${a} f=${f}`); assert.equal(r.f, cpu.f, `a=${a} f=${f}`);
    }
  }
});

test('bcdAdd is add + daa', () => {
  const cpu = run([0xc6, 0x58, 0x27], 0x47, 0, 2);
  assert.equal(bcdAdd(0x47, 0x58).a, cpu.a);
  assert.equal(bcdAdd(0x47, 0x58).a, 0x05);
  assert.equal(bcdAdd(0x47, 0x58).cf, true);
});

test('rotates match the core', () => {
  for (let a = 0; a < 256; a += 1) {
    for (const c of [0, 1]) {
      let cpu = run([0x07], a, c); assert.deepEqual(rlca(a), { a: cpu.a, cf: (cpu.f & 1) === 1 });
      cpu = run([0x0f], a, c); assert.deepEqual(rrca(a), { a: cpu.a, cf: (cpu.f & 1) === 1 });
      cpu = run([0x17], a, c); assert.deepEqual(rla(a, c === 1), { a: cpu.a, cf: (cpu.f & 1) === 1 });
      cpu = run([0x1f], a, c); assert.deepEqual(rra(a, c === 1), { a: cpu.a, cf: (cpu.f & 1) === 1 });
    }
  }
});
