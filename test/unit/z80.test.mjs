// Copyright 2026 by Moshix
/**
 * Targeted tests for the Z80 core. The boot test (boot.test.mjs) proves the
 * core can run ten kilobytes of real 1979 code; these tests pin down the
 * details that a "it boots, ship it" core typically gets subtly wrong and
 * that would then show up as a mystery diff months later:
 *
 *  - the undocumented X (bit 3) and Y (bit 5) flags, including the two places
 *    they do NOT come from the result (CP takes them from the operand,
 *    BIT n,(HL) takes them from the internal WZ register),
 *  - DAA in all 2048 (A, NHC) combinations,
 *  - block moves being interruptible rather than atomic,
 *  - T-state counts, since the harness schedules the vblank NMI by cycle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Z80, FLAG_C, FLAG_N, FLAG_P, FLAG_X, FLAG_H, FLAG_Y, FLAG_Z, FLAG_S } from '../z80/z80.mjs';

/**
 * Build a CPU over a flat 64 KB RAM with `program` loaded at `org`.
 * @param {number[]} program
 * @param {{org?: number, regs?: object}} [options]
 */
function makeCpu(program, options = {}) {
  const org = options.org ?? 0;
  const mem = new Uint8Array(0x10000);
  mem.set(Uint8Array.from(program), org);
  const cpu = new Z80({
    read: (a) => mem[a],
    write: (a, v) => { mem[a] = v; },
    // No device is modelled: IN returns the high half of the port address,
    // which is what an unterminated bus tends to look like on this board.
    readIo: (p) => p >> 8,
    writeIo: () => {},
  });
  cpu.reset();
  cpu.pc = org;
  cpu.a = 0; cpu.f = 0;
  cpu.sp = 0xf000;
  if (options.regs) cpu.setRegisters(options.regs);
  return { cpu, mem };
}

/**
 * @param {Z80} cpu
 * @param {number} [count]
 * @returns {number} total T-states
 */
function run(cpu, count = 1) {
  let t = 0;
  for (let i = 0; i < count; i += 1) t += cpu.step();
  return t;
}

/** Render a flag byte as a string, so failures are readable. */
function flagsOf(f) {
  return ['S', 'Z', 'Y', 'H', 'X', 'P', 'N', 'C']
    .map((n, i) => ((f << i) & 0x80 ? n : '.')).join('');
}

// --------------------------------------------------------------------- 8-bit

test('ADD A,r sets S/Z/H/V/N/C and the undocumented X/Y from the result', () => {
  // $28 + $28 = $50: half carry out of bit 3, no overflow. $50 has bit 3 set
  // (X) and bit 5 clear (Y).
  const { cpu } = makeCpu([0x80], { regs: { af: 0x2800, bc: 0x2800 } });
  cpu.b = 0x28;
  run(cpu);
  assert.equal(cpu.a, 0x50);
  assert.equal(flagsOf(cpu.f), '...H....');

  // $7F + $01 = $80: signed overflow, half carry, sign set, Y set (bit 5).
  const two = makeCpu([0x80]);
  two.cpu.a = 0x7f; two.cpu.b = 0x01;
  run(two.cpu);
  assert.equal(two.cpu.a, 0x80);
  assert.equal(flagsOf(two.cpu.f), 'S..H.P..');

  // $80 + $80 = $00: carry, overflow, zero.
  const three = makeCpu([0x80]);
  three.cpu.a = 0x80; three.cpu.b = 0x80;
  run(three.cpu);
  assert.equal(three.cpu.a, 0x00);
  assert.equal(flagsOf(three.cpu.f), '.Z...P.C');
});

test('ADC A,n honours the incoming carry', () => {
  const { cpu } = makeCpu([0xce, 0x0f]);           // adc a,$0f
  cpu.a = 0xf0; cpu.f = FLAG_C;
  run(cpu);
  assert.equal(cpu.a, 0x00);
  assert.equal(cpu.f & FLAG_C, FLAG_C);
  assert.equal(cpu.f & FLAG_Z, FLAG_Z);
  assert.equal(cpu.f & FLAG_H, FLAG_H);
});

test('SUB sets N and borrow; SBC subtracts the carry too', () => {
  const a = makeCpu([0x90]);                        // sub b
  a.cpu.a = 0x00; a.cpu.b = 0x01;
  run(a.cpu);
  assert.equal(a.cpu.a, 0xff);
  assert.equal(flagsOf(a.cpu.f), 'S.YHX.NC');

  const b = makeCpu([0x98]);                        // sbc a,b
  b.cpu.a = 0x10; b.cpu.b = 0x0f; b.cpu.f = FLAG_C;
  run(b.cpu);
  assert.equal(b.cpu.a, 0x00);
  assert.equal(b.cpu.f & (FLAG_Z | FLAG_N | FLAG_H), FLAG_Z | FLAG_N | FLAG_H);
  assert.equal(b.cpu.f & FLAG_C, 0);
});

test('CP takes X and Y from the operand, not from the result', () => {
  // A=$00, operand=$08 (bit 3 set, bit 5 clear). The result $F8 has both set,
  // so a core that copied X/Y from the result would disagree here.
  const { cpu } = makeCpu([0xfe, 0x08]);            // cp $08
  cpu.a = 0x00;
  run(cpu);
  assert.equal(cpu.a, 0x00, 'CP must not modify A');
  assert.equal(cpu.f & FLAG_X, FLAG_X);
  assert.equal(cpu.f & FLAG_Y, 0);
  assert.equal(cpu.f & (FLAG_N | FLAG_C), FLAG_N | FLAG_C);
});

test('INC/DEC leave carry alone and flag the nibble/overflow cases', () => {
  const inc = makeCpu([0x3c]);                      // inc a
  inc.cpu.a = 0x0f; inc.cpu.f = FLAG_C;
  run(inc.cpu);
  assert.equal(inc.cpu.a, 0x10);
  assert.equal(inc.cpu.f & FLAG_H, FLAG_H);
  assert.equal(inc.cpu.f & FLAG_C, FLAG_C, 'INC must preserve carry');
  assert.equal(inc.cpu.f & FLAG_N, 0);

  const ovf = makeCpu([0x3c]);
  ovf.cpu.a = 0x7f;
  run(ovf.cpu);
  assert.equal(ovf.cpu.f & FLAG_P, FLAG_P, '$7F+1 overflows');

  const dec = makeCpu([0x3d]);                      // dec a
  dec.cpu.a = 0x00; dec.cpu.f = FLAG_C;
  run(dec.cpu);
  assert.equal(dec.cpu.a, 0xff);
  assert.equal(dec.cpu.f & (FLAG_H | FLAG_N | FLAG_C), FLAG_H | FLAG_N | FLAG_C);

  const under = makeCpu([0x3d]);
  under.cpu.a = 0x80;
  run(under.cpu);
  assert.equal(under.cpu.f & FLAG_P, FLAG_P, '$80-1 overflows');
});

test('AND sets H, OR/XOR clear it, and all three report parity', () => {
  const and = makeCpu([0xe6, 0x0f]);                // and $0f
  and.cpu.a = 0x3c;
  run(and.cpu);
  assert.equal(and.cpu.a, 0x0c);
  assert.equal(and.cpu.f & FLAG_H, FLAG_H);
  assert.equal(and.cpu.f & FLAG_P, FLAG_P, '$0C has two bits set: even parity');
  assert.equal(and.cpu.f & FLAG_C, 0);

  const or = makeCpu([0xf6, 0x01]);                 // or $01
  or.cpu.a = 0x00; or.cpu.f = 0xff;
  run(or.cpu);
  assert.equal(or.cpu.a, 0x01);
  assert.equal(or.cpu.f & (FLAG_H | FLAG_N | FLAG_C), 0);
  assert.equal(or.cpu.f & FLAG_P, 0, 'one bit set: odd parity');

  const xor = makeCpu([0xaf]);                      // xor a
  xor.cpu.a = 0x5a;
  run(xor.cpu);
  assert.equal(xor.cpu.a, 0);
  assert.equal(flagsOf(xor.cpu.f), '.Z...P..');
});

// -------------------------------------------------------------------- 16-bit

test('ADD HL,rr keeps S/Z/V, sets H from bit 11 and X/Y from the high byte', () => {
  const { cpu } = makeCpu([0x09]);                  // add hl,bc
  cpu.hl = 0x0fff; cpu.bc = 0x0001;
  cpu.f = FLAG_S | FLAG_Z | FLAG_P;
  run(cpu);
  assert.equal(cpu.hl, 0x1000);
  assert.equal(cpu.f & (FLAG_S | FLAG_Z | FLAG_P), FLAG_S | FLAG_Z | FLAG_P);
  assert.equal(cpu.f & FLAG_H, FLAG_H);
  assert.equal(cpu.f & FLAG_C, 0);
  assert.equal(cpu.f & (FLAG_X | FLAG_Y), 0x10 & (FLAG_X | FLAG_Y));
});

test('ADC HL,rr and SBC HL,rr set the full flag set from the 16-bit result', () => {
  const adc = makeCpu([0xed, 0x4a]);                // adc hl,bc
  adc.cpu.hl = 0x7fff; adc.cpu.bc = 0x0000; adc.cpu.f = FLAG_C;
  run(adc.cpu);
  assert.equal(adc.cpu.hl, 0x8000);
  assert.equal(adc.cpu.f & FLAG_P, FLAG_P, 'signed overflow into $8000');
  assert.equal(adc.cpu.f & FLAG_S, FLAG_S);
  assert.equal(adc.cpu.f & FLAG_H, FLAG_H);

  const sbc = makeCpu([0xed, 0x42]);                // sbc hl,bc
  sbc.cpu.hl = 0x0000; sbc.cpu.bc = 0x0000; sbc.cpu.f = 0;
  run(sbc.cpu);
  assert.equal(sbc.cpu.hl, 0x0000);
  assert.equal(sbc.cpu.f & (FLAG_Z | FLAG_N), FLAG_Z | FLAG_N);
  assert.equal(sbc.cpu.f & FLAG_C, 0);
});

// ------------------------------------------------------------------- rotates

test('RRCA keeps S/Z/P, sets carry from bit 0 and X/Y from the new A', () => {
  // The ROM leans on exactly this: e.g. ASSERT_NOT_GAME_OVER (.asm:636-640)
  // does `ld a,(flag)` / `rrca` / `ret nc`.
  const { cpu } = makeCpu([0x0f]);
  cpu.a = 0x01;
  cpu.f = FLAG_S | FLAG_Z | FLAG_P | FLAG_H | FLAG_N;
  run(cpu);
  assert.equal(cpu.a, 0x80);
  assert.equal(cpu.f & FLAG_C, FLAG_C);
  assert.equal(cpu.f & (FLAG_S | FLAG_Z | FLAG_P), FLAG_S | FLAG_Z | FLAG_P);
  assert.equal(cpu.f & (FLAG_H | FLAG_N), 0);
  assert.equal(cpu.f & (FLAG_X | FLAG_Y), 0x80 & (FLAG_X | FLAG_Y));
});

test('RLA rotates through carry; RLCA does not', () => {
  const rla = makeCpu([0x17]);
  rla.cpu.a = 0x80; rla.cpu.f = FLAG_C;
  run(rla.cpu);
  assert.equal(rla.cpu.a, 0x01);
  assert.equal(rla.cpu.f & FLAG_C, FLAG_C);

  const rlca = makeCpu([0x07]);
  rlca.cpu.a = 0x80; rlca.cpu.f = 0;
  run(rlca.cpu);
  assert.equal(rlca.cpu.a, 0x01);
  assert.equal(rlca.cpu.f & FLAG_C, FLAG_C);
});

test('CB rotates and shifts set S/Z/P from the result', () => {
  const cases = [
    { op: 0x00, in: 0x85, out: 0x0b, carry: 1 },   // rlc b
    { op: 0x08, in: 0x01, out: 0x80, carry: 1 },   // rrc b
    { op: 0x20, in: 0x80, out: 0x00, carry: 1 },   // sla b
    { op: 0x28, in: 0x85, out: 0xc2, carry: 1 },   // sra b -- keeps bit 7
    { op: 0x30, in: 0x00, out: 0x01, carry: 0 },   // sll b (undocumented)
    { op: 0x38, in: 0x81, out: 0x40, carry: 1 },   // srl b
  ];
  for (const c of cases) {
    const { cpu } = makeCpu([0xcb, c.op]);
    cpu.b = c.in;
    run(cpu);
    assert.equal(cpu.b, c.out, `op $${c.op.toString(16)}`);
    assert.equal(cpu.f & FLAG_C, c.carry ? FLAG_C : 0, `carry of $${c.op.toString(16)}`);
    assert.equal(cpu.f & (FLAG_H | FLAG_N), 0);
    const expectZ = c.out === 0 ? FLAG_Z : 0;
    assert.equal(cpu.f & FLAG_Z, expectZ);
  }
});

// ---------------------------------------------------------------- bit / set

test('BIT n,r sets Z and P together, always sets H, and copies X/Y from the operand', () => {
  const { cpu } = makeCpu([0xcb, 0x50]);            // bit 2,b
  cpu.b = 0x28;                                     // bit 2 clear, bits 3 and 5 set
  cpu.f = FLAG_C;
  run(cpu);
  assert.equal(cpu.f & FLAG_Z, FLAG_Z);
  assert.equal(cpu.f & FLAG_P, FLAG_P);
  assert.equal(cpu.f & FLAG_H, FLAG_H);
  assert.equal(cpu.f & FLAG_N, 0);
  assert.equal(cpu.f & FLAG_C, FLAG_C, 'BIT must preserve carry');
  assert.equal(cpu.f & (FLAG_X | FLAG_Y), FLAG_X | FLAG_Y);
});

test('BIT 7,r sets S when the tested bit is set', () => {
  const { cpu } = makeCpu([0xcb, 0x78]);            // bit 7,b
  cpu.b = 0x80;
  run(cpu);
  assert.equal(cpu.f & FLAG_S, FLAG_S);
  assert.equal(cpu.f & (FLAG_Z | FLAG_P), 0);
});

test('BIT n,(HL) takes X/Y from WZ, not from the byte in memory', () => {
  // ld a,($0820) leaves WZ = $0821, so X/Y come from $08: X set, Y clear.
  // The byte at that address is $ff, which would set both.
  const { cpu, mem } = makeCpu([0x3a, 0x20, 0x08, 0xcb, 0x46]);
  mem[0x0820] = 0xff;
  cpu.hl = 0x0820;
  run(cpu, 2);
  assert.equal(cpu.f & FLAG_X, FLAG_X);
  assert.equal(cpu.f & FLAG_Y, 0);
});

test('SET and RES touch only the addressed bit', () => {
  const { cpu, mem } = makeCpu([0xcb, 0xc6, 0xcb, 0x8e]);  // set 0,(hl) / res 1,(hl)
  cpu.hl = 0x4000; mem[0x4000] = 0x02;
  run(cpu, 2);
  assert.equal(mem[0x4000], 0x01);
});

// ----------------------------------------------------------------- block ops

test('LDIR copies, is interruptible, and costs 21/16 T-states', () => {
  // This is the sprite blit at .asm:799-802: ld hl,$4020 / ld de,$5800 /
  // ld bc,$0080 / ldir.
  const { cpu, mem } = makeCpu([0xed, 0xb0]);
  for (let i = 0; i < 8; i += 1) mem[0x4020 + i] = 0x10 + i;
  cpu.hl = 0x4020; cpu.de = 0x5800; cpu.bc = 8;

  const first = cpu.step();
  assert.equal(first, 21, 'a repeating iteration costs 21');
  assert.equal(cpu.pc, 0, 'PC rewinds so an NMI can land between iterations');
  assert.equal(cpu.bc, 7);

  // Interrupt it half way and make sure it resumes correctly afterwards.
  run(cpu, 3);
  assert.equal(cpu.bc, 4);
  cpu.nmi();
  assert.equal(cpu.step(), 11, 'NMI acknowledge is 11 T-states');
  assert.equal(cpu.pc, 0x0066);
  cpu.pc = cpu.pop16();                              // simulate an immediate RETN

  let last = 0;
  while (cpu.bc !== 0) last = cpu.step();
  assert.equal(last, 16, 'the final iteration costs 16');
  assert.equal(cpu.pc, 2, 'and PC finally moves past the instruction');
  assert.deepEqual([...mem.subarray(0x5800, 0x5808)],
    [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17]);
});

test('LDI clears N and H, sets P from BC, and derives X/Y from A + byte', () => {
  const { cpu, mem } = makeCpu([0xed, 0xa0]);
  mem[0x4000] = 0x02;
  cpu.hl = 0x4000; cpu.de = 0x5000; cpu.bc = 2; cpu.a = 0x01;
  cpu.f = FLAG_S | FLAG_Z | FLAG_C | FLAG_N | FLAG_H;
  run(cpu);
  assert.equal(mem[0x5000], 0x02);
  assert.equal(cpu.bc, 1);
  assert.equal(cpu.f & FLAG_P, FLAG_P, 'BC != 0 leaves P set');
  assert.equal(cpu.f & (FLAG_N | FLAG_H), 0);
  assert.equal(cpu.f & (FLAG_S | FLAG_Z | FLAG_C), FLAG_S | FLAG_Z | FLAG_C);
  // n = A + byte = 3: bit 1 set -> Y, bit 3 clear -> X clear.
  assert.equal(cpu.f & FLAG_Y, FLAG_Y);
  assert.equal(cpu.f & FLAG_X, 0);
});

test('CPIR stops on a match and reports it with Z', () => {
  const { cpu, mem } = makeCpu([0xed, 0xb1]);
  mem.set([1, 2, 3, 4], 0x4000);
  cpu.hl = 0x4000; cpu.bc = 4; cpu.a = 3;
  while (cpu.pc === 0) cpu.step();
  assert.equal(cpu.f & FLAG_Z, FLAG_Z);
  assert.equal(cpu.hl, 0x4003, 'HL points past the matching byte');
  assert.equal(cpu.bc, 1);
  assert.equal(cpu.f & FLAG_N, FLAG_N);
});

// ---------------------------------------------------------------------- DAA

/**
 * The DAA correction table exactly as printed in the Zilog Z80 CPU User
 * Manual. Columns: N, carry in, high nibble range, H, low nibble range,
 * the value added to A, and the carry left behind.
 *
 * This is deliberately transcribed from the manual rather than derived from
 * the core's implementation -- comparing an implementation against itself
 * proves nothing.
 */
const DAA_TABLE = [
  // N, Cin, hiLo, hiHi, H, loLo, loHi, add,  Cout
  [0, 0, 0x0, 0x9, 0, 0x0, 0x9, 0x00, 0],
  [0, 0, 0x0, 0x8, 0, 0xa, 0xf, 0x06, 0],
  [0, 0, 0x0, 0x9, 1, 0x0, 0x3, 0x06, 0],
  [0, 0, 0xa, 0xf, 0, 0x0, 0x9, 0x60, 1],
  [0, 0, 0x9, 0xf, 0, 0xa, 0xf, 0x66, 1],
  [0, 0, 0xa, 0xf, 1, 0x0, 0x3, 0x66, 1],
  [0, 1, 0x0, 0x2, 0, 0x0, 0x9, 0x60, 1],
  [0, 1, 0x0, 0x2, 0, 0xa, 0xf, 0x66, 1],
  [0, 1, 0x0, 0x3, 1, 0x0, 0x3, 0x66, 1],
  [1, 0, 0x0, 0x9, 0, 0x0, 0x9, 0x00, 0],
  [1, 0, 0x0, 0x8, 1, 0x6, 0xf, 0xfa, 0],
  [1, 1, 0x7, 0xf, 0, 0x0, 0x9, 0xa0, 1],
  [1, 1, 0x6, 0xf, 1, 0x6, 0xf, 0x9a, 1],
];

/**
 * Look the (A, flags) pair up in the manual's table.
 * @returns {{add: number, carry: number}|null} null when the manual calls the
 *   combination impossible (it can only be reached by executing DAA with
 *   hand-set flags, which no real BCD sequence does).
 */
function daaTableLookup(a, n, cIn, hIn) {
  const hi = a >> 4;
  const lo = a & 0x0f;
  for (const [rn, rc, hiLo, hiHi, rh, loLo, loHi, add, cOut] of DAA_TABLE) {
    if (rn === n && rc === cIn && rh === hIn
      && hi >= hiLo && hi <= hiHi && lo >= loLo && lo <= loHi) {
      return { add, carry: cOut };
    }
  }
  return null;
}

/**
 * Reference DAA, written from the manual's table with one documented
 * generalisation for the rows the table omits: the correction is +$06 when
 * H is set or the low nibble exceeds 9, and +$60 when C is set or A exceeds
 * $99; N chooses whether that correction is added or subtracted. Every row of
 * the table above is a special case of those two rules, which is how we know
 * the generalisation is the right one.
 * @param {number} a @param {number} f
 * @returns {{a: number, f: number, fromTable: boolean}}
 */
function daaReference(a, f) {
  const n = (f & FLAG_N) ? 1 : 0;
  const cIn = (f & FLAG_C) ? 1 : 0;
  const hIn = (f & FLAG_H) ? 1 : 0;

  const row = daaTableLookup(a, n, cIn, hIn);
  let add;
  let carry;
  if (row) {
    ({ add, carry } = row);
  } else {
    let diff = 0;
    if (hIn || (a & 0x0f) > 9) diff |= 0x06;
    carry = cIn;
    if (cIn || a > 0x99) { diff |= 0x60; carry = 1; }
    add = n ? ((0x100 - diff) & 0xff) : diff;
  }

  const result = (a + add) & 0xff;
  // H is the carry (N=0) or borrow (N=1) out of bit 3 of that same addition.
  const loSum = (a & 0x0f) + (add & 0x0f);
  const half = n ? ((a & 0x0f) < ((0x100 - add) & 0x0f) ? FLAG_H : 0)
    : (loSum > 0x0f ? FLAG_H : 0);

  let bits = 0;
  for (let i = 0; i < 8; i += 1) bits += (result >> i) & 1;
  const flags = (result & (FLAG_S | FLAG_X | FLAG_Y))
    | (result === 0 ? FLAG_Z : 0)
    | (bits % 2 === 0 ? FLAG_P : 0)
    | half
    | (n ? FLAG_N : 0)
    | (carry ? FLAG_C : 0);
  return { a: result, f: flags, fromTable: row !== null };
}

test('DAA matches the manual for all 2048 (A, N/H/C) combinations', () => {
  let covered = 0;
  for (let a = 0; a < 256; a += 1) {
    for (let bits = 0; bits < 8; bits += 1) {
      const f = ((bits & 1) ? FLAG_N : 0) | ((bits & 2) ? FLAG_H : 0) | ((bits & 4) ? FLAG_C : 0);
      const { cpu } = makeCpu([0x27]);              // daa
      cpu.a = a; cpu.f = f;
      run(cpu);
      const want = daaReference(a, f);
      if (want.fromTable) covered += 1;
      assert.equal(cpu.a, want.a,
        `DAA A=$${a.toString(16).padStart(2, '0')} F=${flagsOf(f)}: A`);
      assert.equal(flagsOf(cpu.f), flagsOf(want.f),
        `DAA A=$${a.toString(16).padStart(2, '0')} F=${flagsOf(f)}: flags`);
    }
  }
  // Sanity check on the reference itself. 764 of the 2048 combinations are
  // rows the manual actually prints; the remaining 1284 are flag states no
  // real add/sub can leave behind (H set with a low nibble of 4-9 after an
  // addition, say) and are only reachable by loading F by hand. Pinning the
  // number down means a future edit to DAA_TABLE cannot quietly shrink the
  // independently-specified part of this test.
  assert.equal(covered, 764, 'documented rows covered');
});

test('DAA fixes up the BCD score arithmetic the ROM actually performs', () => {
  // UPDATE_PLAYER_SCORE_COMMAND (.asm:7563) adds packed BCD pairs.
  const { cpu, mem } = makeCpu([0x86, 0x27]);       // add a,(hl) / daa
  mem[0x4000] = 0x13;
  cpu.a = 0x49; cpu.hl = 0x4000;
  run(cpu, 2);
  assert.equal(cpu.a, 0x62, '49 + 13 = 62 in BCD');
  assert.equal(cpu.f & FLAG_C, 0);

  // And the carry-out case, which is what propagates into the next digit pair.
  const b = makeCpu([0xc6, 0x10, 0x27]);            // add a,$10 / daa
  b.cpu.a = 0x95;
  run(b.cpu, 2);
  assert.equal(b.cpu.a, 0x05);
  assert.equal(b.cpu.f & FLAG_C, FLAG_C, '95 + 10 = 105: carry out');
});

test('DAA after a subtraction borrows correctly', () => {
  const { cpu } = makeCpu([0xd6, 0x08, 0x27]);      // sub $08 / daa
  cpu.a = 0x12;
  run(cpu, 2);
  assert.equal(cpu.a, 0x04, '12 - 08 = 04 in BCD');
  assert.equal(cpu.f & FLAG_N, FLAG_N);
  assert.equal(cpu.f & FLAG_C, 0);
});

// ------------------------------------------------------- control flow / misc

test('RST pushes the return address and vectors to n*8', () => {
  // The ROM uses RST as a call-with-one-byte: RST $10 fills memory
  // (.asm:657), RST $20 does a table lookup (.asm:688), RST $28 dispatches
  // through a jump table (.asm:707).
  const { cpu, mem } = makeCpu([0xd7]);             // rst $10
  cpu.sp = 0xf000;
  const t = run(cpu);
  assert.equal(t, 11);
  assert.equal(cpu.pc, 0x0010);
  assert.equal(cpu.sp, 0xeffe);
  assert.equal(mem[0xeffe] | (mem[0xefff] << 8), 0x0001);
});

test('NMI saves IFF1 in IFF2, clears IFF1, and RETN puts it back', () => {
  const { cpu, mem } = makeCpu([0x00]);
  mem[0x0066] = 0xed; mem[0x0067] = 0x45;           // retn
  cpu.iff1 = 1; cpu.iff2 = 1;
  cpu.pc = 0x8000;
  cpu.nmi();
  cpu.step();
  assert.equal(cpu.pc, 0x0066);
  assert.equal(cpu.iff1, 0, 'IFF1 cleared so the handler is not re-entered');
  assert.equal(cpu.iff2, 1, 'IFF2 keeps the old state for RETN');
  const t = cpu.step();
  assert.equal(t, 14);
  assert.equal(cpu.pc, 0x8000);
  assert.equal(cpu.iff1, 1, 'RETN restores IFF1 from IFF2');
});

test('an NMI is taken even while halted', () => {
  const { cpu } = makeCpu([0x76]);                  // halt
  run(cpu);
  assert.equal(cpu.getRegisters().halted, true);
  run(cpu);                                         // spins, PC does not move
  assert.equal(cpu.pc, 1);
  cpu.nmi();
  cpu.step();
  assert.equal(cpu.pc, 0x0066);
  assert.equal(cpu.getRegisters().halted, false);
});

test('the shadow register sets swap independently', () => {
  const { cpu } = makeCpu([0x08, 0xd9]);            // ex af,af' / exx
  cpu.af = 0x1234; cpu.bc = 0x1111; cpu.de = 0x2222; cpu.hl = 0x3333;
  cpu.setRegisters({ af_: 0x5678, bc_: 0xaaaa, de_: 0xbbbb, hl_: 0xcccc });
  run(cpu, 2);
  const r = cpu.getRegisters();
  assert.equal(r.af, 0x5678);
  assert.equal(r.af_, 0x1234);
  assert.deepEqual([r.bc, r.de, r.hl], [0xaaaa, 0xbbbb, 0xcccc]);
  assert.deepEqual([r.bc_, r.de_, r.hl_], [0x1111, 0x2222, 0x3333]);
});

test('indexed addressing signs the displacement and costs the documented cycles', () => {
  const { cpu, mem } = makeCpu([0xdd, 0x7e, 0xfe]); // ld a,(ix-2)
  cpu.ix = 0x4010; mem[0x400e] = 0x5a;
  const t = run(cpu);
  assert.equal(cpu.a, 0x5a);
  assert.equal(t, 19);

  const inc = makeCpu([0xdd, 0x34, 0x01]);          // inc (ix+1)
  inc.cpu.ix = 0x4000; inc.mem[0x4001] = 0x7f;
  assert.equal(run(inc.cpu), 23);
  assert.equal(inc.mem[0x4001], 0x80);
  assert.equal(inc.cpu.f & FLAG_P, FLAG_P);

  const ldn = makeCpu([0xfd, 0x36, 0x02, 0x99]);    // ld (iy+2),$99
  ldn.cpu.iy = 0x4000;
  assert.equal(run(ldn.cpu), 19);
  assert.equal(ldn.mem[0x4002], 0x99);
});

test('DD/FD reach the index register halves, and LD H,(IX+d) uses the real H', () => {
  const half = makeCpu([0xdd, 0x26, 0x12, 0xdd, 0x2e, 0x34]); // ld ixh,$12 / ld ixl,$34
  run(half.cpu, 2);
  assert.equal(half.cpu.ix, 0x1234);

  const mixed = makeCpu([0xdd, 0x66, 0x00]);        // ld h,(ix+0)
  mixed.cpu.ix = 0x4000; mixed.mem[0x4000] = 0x77; mixed.cpu.h = 0x11;
  run(mixed.cpu);
  assert.equal(mixed.cpu.h, 0x77, 'destination is H, not IXh');
  assert.equal(mixed.cpu.ix, 0x4000, 'IX is untouched');
});

test('DDCB writes the result back to memory and to the named register', () => {
  const { cpu, mem } = makeCpu([0xdd, 0xcb, 0x01, 0x06, 0xdd, 0xcb, 0x01, 0x00]);
  cpu.ix = 0x4000; mem[0x4001] = 0x81;
  assert.equal(run(cpu), 23, 'rlc (ix+1) is 23 T-states');
  assert.equal(mem[0x4001], 0x03);
  assert.equal(cpu.f & FLAG_C, FLAG_C);
  run(cpu);                                          // rlc (ix+1),b -- undocumented
  assert.equal(mem[0x4001], 0x06);
  assert.equal(cpu.b, 0x06, 'the low 3 bits name a register that also receives it');
});

test('T-state counts match the Zilog tables for a representative sample', () => {
  /** @type {Array<[string, number[], number, object]>} */
  const cases = [
    ['nop', [0x00], 4, {}],
    ['ld b,c', [0x41], 4, {}],
    ['ld a,(hl)', [0x7e], 7, {}],
    ['ld (hl),n', [0x36, 0x00], 10, {}],
    ['ld bc,nn', [0x01, 0, 0], 10, {}],
    ['inc (hl)', [0x34], 11, {}],
    ['add hl,bc', [0x09], 11, {}],
    ['ld (nn),hl', [0x22, 0, 0x40], 16, {}],
    ['jp nn', [0xc3, 0, 0], 10, {}],
    ['jr d', [0x18, 0x00], 12, {}],
    ['jr nz,d taken', [0x20, 0x00], 12, {}],
    ['jr nz,d not taken', [0x20, 0x00], 7, { af: 0x0040 }],
    ['djnz taken', [0x10, 0x00], 13, { bc: 0x0500 }],
    ['djnz done', [0x10, 0x00], 8, { bc: 0x0100 }],
    ['call nn', [0xcd, 0, 0], 17, {}],
    ['call nz,nn taken', [0xc4, 0, 0], 17, {}],
    ['call nz,nn not taken', [0xc4, 0, 0], 10, { af: 0x0040 }],
    ['ret', [0xc9], 10, {}],
    ['ret nz taken', [0xc0], 11, {}],
    ['ret nz not taken', [0xc0], 5, { af: 0x0040 }],
    ['push bc', [0xc5], 11, {}],
    ['pop bc', [0xc1], 10, {}],
    ['ex (sp),hl', [0xe3], 19, {}],
    ['rst 38', [0xff], 11, {}],
    ['bit 0,b', [0xcb, 0x40], 8, {}],
    ['bit 0,(hl)', [0xcb, 0x46], 12, {}],
    ['set 0,(hl)', [0xcb, 0xc6], 15, {}],
    ['ldi', [0xed, 0xa0], 16, { bc: 0x0001 }],
    ['sbc hl,bc', [0xed, 0x42], 15, {}],
    ['ld (nn),bc', [0xed, 0x43, 0, 0x40], 20, {}],
    ['neg', [0xed, 0x44], 8, {}],
    ['im 1', [0xed, 0x56], 8, {}],
    ['rrd', [0xed, 0x67], 18, {}],
    ['ld ix,nn', [0xdd, 0x21, 0, 0], 14, {}],
    ['add ix,bc', [0xdd, 0x09], 15, {}],
    ['inc ix', [0xdd, 0x23], 10, {}],
    ['push ix', [0xdd, 0xe5], 15, {}],
    ['jp (ix)', [0xdd, 0xe9], 8, {}],
    ['ex (sp),ix', [0xdd, 0xe3], 23, {}],
    ['ld a,ixh', [0xdd, 0x7c], 8, {}],
    ['bit 0,(ix+0)', [0xdd, 0xcb, 0x00, 0x46], 20, {}],
  ];
  for (const [name, program, expected, regs] of cases) {
    const { cpu } = makeCpu(program, { regs, org: 0x1000 });
    assert.equal(cpu.step(), expected, name);
  }
});

test('R increments once per M1 fetch and bit 7 is preserved', () => {
  const { cpu } = makeCpu([0x00, 0xcb, 0x00, 0xdd, 0xcb, 0x00, 0x06]);
  cpu.setRegisters({ r: 0x80 });
  run(cpu);                                          // nop: +1
  assert.equal(cpu.getRegisters().r, 0x81);
  run(cpu);                                          // cb 00: +2
  assert.equal(cpu.getRegisters().r, 0x83);
  run(cpu);                                          // dd cb d op: +2 (DD and CB only)
  assert.equal(cpu.getRegisters().r, 0x85);

  const wrap = makeCpu([0x00]);
  wrap.cpu.setRegisters({ r: 0xff });
  run(wrap.cpu);
  assert.equal(wrap.cpu.getRegisters().r, 0x80, 'only the low 7 bits count up');
});

test('LD A,I copies IFF2 into the parity flag', () => {
  const { cpu } = makeCpu([0xed, 0x57]);
  cpu.i = 0x80; cpu.iff2 = 1; cpu.f = FLAG_C;
  run(cpu);
  assert.equal(cpu.a, 0x80);
  assert.equal(cpu.f & FLAG_P, FLAG_P);
  assert.equal(cpu.f & FLAG_S, FLAG_S);
  assert.equal(cpu.f & FLAG_C, FLAG_C);
  assert.equal(cpu.f & (FLAG_H | FLAG_N), 0);
});

test('the RST helpers in the ROM behave as the disassembly describes', () => {
  // RST $10: fill B bytes from HL with A (.asm:657-660).
  const fill = makeCpu([0xd7]);
  fill.mem.set([0x77, 0x23, 0x10, 0xfc, 0xc9], 0x0010);
  fill.cpu.a = 0x10; fill.cpu.b = 4; fill.cpu.hl = 0x5000;
  while (fill.cpu.pc !== 1) fill.cpu.step();
  assert.deepEqual([...fill.mem.subarray(0x5000, 0x5004)], [0x10, 0x10, 0x10, 0x10]);
  assert.equal(fill.cpu.hl, 0x5004);
  assert.equal(fill.cpu.b, 0);

  // RST $20: A = (HL + A) (.asm:688-694).
  const lookup = makeCpu([0xe7]);
  lookup.mem.set([0x85, 0x6f, 0x3e, 0x00, 0x8c, 0x67, 0x7e, 0xc9], 0x0020);
  lookup.mem.set([0x07, 0x10, 0x12, 0x20], 0x0152);
  lookup.cpu.a = 2; lookup.cpu.hl = 0x0152;
  while (lookup.cpu.pc !== 1) lookup.cpu.step();
  assert.equal(lookup.cpu.a, 0x12, 'bonus galixip table entry 2 is 12000');

  // RST $28: jump through the table that follows the call (.asm:707-716).
  const dispatch = makeCpu([0xef, 0x34, 0x12, 0x78, 0x56], { org: 0x0100 });
  dispatch.mem.set([0x87, 0xe1, 0x5f, 0x16, 0x00, 0x19, 0x5e, 0x23, 0x56, 0xeb, 0xe9], 0x0028);
  dispatch.cpu.a = 1;
  for (let i = 0; i < 11; i += 1) dispatch.cpu.step();
  assert.equal(dispatch.cpu.pc, 0x5678, 'index 1 selects the second table entry');
});
