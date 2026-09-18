// Copyright 2026 by Moshix
/**
 * Tests for the MB88xx core (test/mcu/mb88.mjs) and the 51XX/54XX devices
 * built on it.
 *
 * Part 1 pins down, opcode by opcode, the places where MAME's mb88xx.cpp
 * does something a from-the-datasheet core would plausibly do differently:
 * ST as the "branch" flag with inverted sense on tests, u8 wrap-around in
 * dcy/sbc/c producing the carry, `daa` keeping only the carry of its own +6,
 * `dcy` not touching ZF, `xd`/`xyd` addressing row 0 absolutely, `tstD`
 * reading R2, `setR` doing read-modify-write through the INPUT callback,
 * in-page jumps using the page after INCPC, the 4-deep circular stack,
 * edge-triggered interrupts that are lost while disabled, flags stacked by
 * the interrupt and restored by rti, timer/counter edges and cycle counts.
 *
 * Part 2 boots the real 51xx.bin and talks to it through a model of the
 * 06XX exactly as the Galaga main CPU does, and checks the byte protocol:
 * credits, coins, start buttons, joystick/fire bytes, service/test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MB88 } from '../mcu/mb88.mjs';
import { Namco54 } from '../mcu/namco54.mjs';
import { Session51 } from '../mcu/session51.mjs';
import { Bus06, FRAME_Z80 } from '../mcu/bus06.mjs';
import { loadGalaga } from '../../tools/romset.mjs';

/**
 * A CPU with `program` at $000 of a 1 KB ROM and recording callbacks.
 * @param {number[]} program
 * @param {object} [opts]  extra MB88 options (readK, readR, ...)
 */
function makeCpu(program, opts = {}) {
  const rom = new Uint8Array(1024);
  rom.set(program);
  const log = { o: [], p: [], r: [] };
  const cpu = new MB88({
    rom,
    variant: 'mb8843',
    writeO: (v, mask) => log.o.push([v, mask]),
    writeP: (v) => log.p.push(v),
    writeR: (n, v) => log.r.push([n, v]),
    ...opts,
  });
  return { cpu, rom, log };
}

// ---------------------------------------------------------------------------
// Part 1: the core

test('reset state: PC 0, ST 1, everything else clear', () => {
  const { cpu } = makeCpu([]);
  assert.equal(cpu.getPc(), 0);
  assert.equal(cpu.st, 1);
  assert.deepEqual([cpu.a, cpu.x, cpu.y, cpu.zf, cpu.cf, cpu.vf, cpu.sf, cpu.pio], [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('cycle counts: 1 per instruction, 2 with an operand byte', () => {
  // nop; en $00; jpl $010 -> @010: jmp $012 -> @012: tba 0; call $020
  const { cpu, rom } = makeCpu([0x00, 0x3e, 0x00, 0x68, 0x10]);
  rom.set([0xd2, 0x00, 0x4c, 0x60, 0x20], 0x10);
  assert.equal(cpu.step(), 1); // nop
  assert.equal(cpu.step(), 2); // en
  assert.equal(cpu.step(), 2); // jpl
  assert.equal(cpu.getPc(), 0x010);
  assert.equal(cpu.step(), 1); // jmp $012
  assert.equal(cpu.getPc(), 0x012);
  assert.equal(cpu.step(), 1); // tba 0: A=0 so bit clear -> ST=1
  assert.equal(cpu.st, 1);
  assert.equal(cpu.step(), 2); // call, taken
  assert.equal(cpu.getPc(), 0x020);
});

test('conditional branches are taken on ST=1 and always leave ST=1', () => {
  // li 1; tba 0 (bit set -> ST=0); jmp $010 (not taken); ...
  const { cpu } = makeCpu([0x91, 0x4c, 0xd0, 0x00]);
  cpu.step(); cpu.step();
  assert.equal(cpu.st, 0);
  cpu.step();
  assert.equal(cpu.getPc(), 3, 'jmp not taken with ST=0');
  assert.equal(cpu.st, 1, 'ST forced back to 1');
});

test('jmp in the last byte of a page lands in the NEXT page (PA after INCPC)', () => {
  const { cpu, rom } = makeCpu([0x68, 0x3f]); // jpl $03F
  rom[0x3f] = 0xc5; // jmp $x05
  cpu.step();
  cpu.step();
  assert.equal(cpu.getPc(), 0x45);
});

test('icy/dcy: carry out via u8 wrap; dcy leaves ZF alone', () => {
  const { cpu } = makeCpu([0x08, 0x18, 0x18]);
  cpu.y = 0xf;
  cpu.step(); // icy: F -> 0
  assert.deepEqual([cpu.y, cpu.st, cpu.zf], [0, 0, 1]);
  cpu.zf = 0;
  cpu.step(); // dcy: 0 -> F, borrow
  assert.deepEqual([cpu.y, cpu.st, cpu.zf], [0xf, 0, 0], 'ZF untouched by dcy');
  cpu.zf = 1;
  cpu.step(); // dcy: F -> E, no borrow
  assert.deepEqual([cpu.y, cpu.st, cpu.zf], [0xe, 1, 1]);
});

test('adc / sbc: CF is the carry/borrow, ST its inverse', () => {
  const { cpu } = makeCpu([0x0e, 0x1e, 0x1e]);
  cpu.ram[0] = 9; cpu.a = 8; cpu.cf = 1;
  cpu.step(); // 9 + 8 + 1 = 18
  assert.deepEqual([cpu.a, cpu.cf, cpu.st, cpu.zf], [2, 1, 0, 0]);
  cpu.ram[0] = 3; cpu.a = 5; cpu.cf = 0;
  cpu.step(); // sbc: M - A - CF = -2
  assert.deepEqual([cpu.a, cpu.cf, cpu.st], [0xe, 1, 0]);
  cpu.ram[0] = 7; cpu.a = 2; cpu.cf = 1;
  cpu.step(); // 7 - 2 - 1 = 4
  assert.deepEqual([cpu.a, cpu.cf, cpu.st], [4, 0, 1]);
});

test('daa keeps only the carry of its own +6 (MAME), das adds 10', () => {
  const { cpu } = makeCpu([0x10, 0x10, 0x10, 0x11]);
  cpu.a = 0; cpu.cf = 1; // e.g. 9 + 7 = 16 arrives as A=0, CF=1
  cpu.step();
  assert.deepEqual([cpu.a, cpu.cf, cpu.st], [6, 0, 1], 'carry is lost');
  cpu.a = 0xb; cpu.cf = 0;
  cpu.step();
  assert.deepEqual([cpu.a, cpu.cf, cpu.st], [1, 1, 0]);
  cpu.a = 5; cpu.cf = 0;
  cpu.step();
  assert.deepEqual([cpu.a, cpu.cf, cpu.st], [5, 0, 1], 'no adjust');
  cpu.a = 0xf; cpu.cf = 1; // 0 - 1 borrow
  cpu.step(); // das: F + 10 = 25 -> 9, borrow propagates
  assert.deepEqual([cpu.a, cpu.cf], [9, 1]);
});

test('rol / ror rotate through carry', () => {
  const { cpu } = makeCpu([0x0c, 0x1c, 0x1c]);
  cpu.a = 8; cpu.cf = 1;
  cpu.step(); // rol: 1_0001
  assert.deepEqual([cpu.a, cpu.cf, cpu.st], [1, 1, 0]);
  cpu.a = 1; cpu.cf = 1;
  cpu.step(); // ror: CF -> bit3, bit0 -> CF
  assert.deepEqual([cpu.a, cpu.cf, cpu.st, cpu.zf], [8, 1, 0, 0]);
  cpu.a = 0; cpu.cf = 0;
  cpu.step();
  assert.deepEqual([cpu.a, cpu.cf, cpu.st, cpu.zf], [0, 0, 1, 1]);
});

test('c / ci / cyi: ST = "not equal", ZF = equal, CF = borrow', () => {
  const { cpu } = makeCpu([0x2e, 0x2e, 0xb5, 0xa2]);
  cpu.ram[0] = 5; cpu.a = 5;
  cpu.step();
  assert.deepEqual([cpu.st, cpu.zf, cpu.cf], [0, 1, 0]);
  cpu.ram[0] = 4;
  cpu.step(); // 4 - 5
  assert.deepEqual([cpu.st, cpu.zf, cpu.cf], [1, 0, 1]);
  cpu.a = 3;
  cpu.step(); // ci 5: 5 - 3
  assert.deepEqual([cpu.st, cpu.zf, cpu.cf, cpu.a], [1, 0, 0, 3], 'A unchanged');
  cpu.y = 2;
  cpu.step(); // cyi 2
  assert.deepEqual([cpu.st, cpu.zf, cpu.cf], [0, 1, 0]);
});

test('neg, and, or, eor flag conventions', () => {
  const { cpu } = makeCpu([0x2d, 0x2d, 0x0f, 0x1f, 0x2f]);
  cpu.a = 0;
  cpu.step();
  assert.deepEqual([cpu.a, cpu.st], [0, 0]);
  cpu.a = 1;
  cpu.step();
  assert.deepEqual([cpu.a, cpu.st], [0xf, 1]);
  cpu.ram[0] = 0; // and -> 0
  cpu.step();
  assert.deepEqual([cpu.a, cpu.zf, cpu.st], [0, 1, 0]);
  cpu.ram[0] = 6; // or
  cpu.step();
  assert.deepEqual([cpu.a, cpu.zf, cpu.st], [6, 0, 1]);
  cpu.step(); // eor with itself
  assert.deepEqual([cpu.a, cpu.zf, cpu.st], [0, 1, 0]);
});

test('tbit / tba / tstc set ST to the INVERSE of the bit', () => {
  const { cpu } = makeCpu([0x39, 0x39, 0x4e, 0x28]);
  cpu.ram[0] = 2;
  cpu.step();
  assert.equal(cpu.st, 0, 'bit 1 set -> ST=0');
  cpu.ram[0] = 0;
  cpu.step();
  assert.equal(cpu.st, 1);
  cpu.a = 4;
  cpu.step();
  assert.equal(cpu.st, 0);
  cpu.cf = 0;
  cpu.step();
  assert.equal(cpu.st, 1);
});

test('xd / xyd address row 0 absolutely, whatever X is', () => {
  const { cpu } = makeCpu([0x51, 0x56]);
  cpu.x = 2;
  cpu.ram[0x01] = 7; cpu.ram[0x21] = 9; cpu.a = 3;
  cpu.step();
  assert.deepEqual([cpu.a, cpu.ram[0x01], cpu.ram[0x21]], [7, 3, 9]);
  cpu.ram[0x06] = 0xc; cpu.y = 4;
  cpu.step();
  assert.deepEqual([cpu.y, cpu.ram[0x06]], [0xc, 4]);
});

test('data RAM is 64 nibbles on MB8843: X=4..7 mirror X=0..3', () => {
  const { cpu } = makeCpu([0x5d, 0x83, 0x9a, 0x1d]); // lxi 5; lyi 3; li A; st
  for (let i = 0; i < 4; i += 1) cpu.step();
  assert.equal(cpu.ram[0x13], 0xa);
});

test('call / rts use a 4-deep circular stack', () => {
  // Five nested calls: $000 -> $010 -> $020 -> $030 -> $040 -> $050.
  const { cpu, rom } = makeCpu([0x60, 0x10]);
  rom.set([0x60, 0x20], 0x10);
  rom.set([0x60, 0x30], 0x20);
  rom.set([0x60, 0x40], 0x30);
  rom.set([0x60, 0x50], 0x40);
  rom.set([0x2c], 0x50);
  for (let i = 0; i < 5; i += 1) cpu.step();
  assert.equal(cpu.getPc(), 0x50);
  cpu.step(); // rts -> return into $040+2
  assert.equal(cpu.getPc(), 0x42);
  // The 5th push overwrote the 1st: after that pop, the next four slots
  // hold $032, $022, $012 and $042 again (never $002).
  const pops = [];
  for (let i = 0; i < 4; i += 1) {
    cpu.si = (cpu.si - 1) & 3;
    pops.push(cpu.sp[cpu.si] & 0x7ff);
  }
  assert.deepEqual(pops, [0x32, 0x22, 0x12, 0x42]);
});

test('call/jpl reach 11-bit targets; jpa jumps to page imm, PC = A*4', () => {
  const { cpu } = makeCpu([0x69, 0x7e]); // jpl $17E
  cpu.step();
  assert.equal(cpu.getPc(), 0x17e);
  const t = makeCpu([0x93, 0x3d, 0x05]); // li 3; jpa $05
  t.cpu.step(); t.cpu.step();
  assert.equal(t.cpu.getPc(), 0x5 * 64 + 12);
});

test('outO writes the nibble chosen by CF through the 8-bit PLA', () => {
  const { cpu, log } = makeCpu([0x95, 0x01, 0x21, 0x9a, 0x01]); // li 5; outO; setc; li A; outO
  for (let i = 0; i < 5; i += 1) cpu.step();
  assert.deepEqual(log.o, [[0x05, 0x0f], [0xa5, 0xf0]]);
});

test('setR / rstR read-modify-write through the INPUT callback; tstD reads R2', () => {
  const { cpu, log } = makeCpu([0x85, 0x20, 0x22, 0x49], {
    readR: (n) => (n === 1 ? 0x8 : n === 2 ? 0x2 : 0),
  });
  cpu.step(); // lyi 5 -> port 1, bit 1
  cpu.step(); // setR
  cpu.step(); // rstR
  assert.deepEqual(log.r, [[1, 0xa], [1, 0x8]]);
  cpu.step(); // tstD 1 -> R2 bit 1 is set -> ST=0
  assert.equal(cpu.st, 0);
});

test('external interrupt: rising edge while enabled, vector $002, +3 cycles, flags stacked', () => {
  // en $04; nop...; @002: rti
  const { cpu, rom } = makeCpu([0x3e, 0x04, 0x00, 0x00, 0x00, 0x00]);
  rom[0x02] = 0x3c;
  cpu.step(); // en: PC now 2 (the 2-byte en ends exactly on the vector)
  // Move somewhere else to see the vector clearly.
  cpu.pc = 0x30; cpu.cf = 1; cpu.zf = 1; cpu.st = 1;
  rom[0x30] = 0x23; // rstc (so the restored CF is visibly the stacked one)
  cpu.setIrqLine(1);
  assert.equal(cpu.step(), 1 + 3, 'rstc + interrupt entry');
  assert.equal(cpu.getPc(), 0x02);
  assert.equal(cpu.inIrq, true);
  cpu.step(); // rti
  assert.equal(cpu.getPc(), 0x31);
  assert.deepEqual([cpu.cf, cpu.zf, cpu.st], [0, 1, 1], 'flags as they were after rstc');
  assert.equal(cpu.inIrq, false);
});

test('external interrupt edges are lost while disabled; tsti still sees the level', () => {
  const { cpu } = makeCpu([0x3e, 0x04, 0x3f, 0x04, 0x25, 0x00, 0x00]);
  cpu.step(); // en 04
  cpu.step(); // dis 04
  cpu.setIrqLine(1); // edge while disabled
  cpu.step(); // tsti
  assert.equal(cpu.st, 0, 'level is visible');
  assert.equal(cpu.pendingIrq, 0, 'edge not latched');
  cpu.step();
  assert.equal(cpu.inIrq, false);
});

test('/TC counts falling edges when PIO bit 6 is set; overflow sets VF', () => {
  const { cpu } = makeCpu([0x3e, 0x40, 0x26, 0x26]);
  cpu.setTcLine(1); cpu.setTcLine(0);
  assert.equal(cpu.tl, 0, 'not counted before en $40');
  cpu.step();
  for (let i = 0; i < 256; i += 1) { cpu.setTcLine(1); cpu.setTcLine(0); }
  assert.deepEqual([cpu.th, cpu.tl, cpu.vf], [0, 0, 1]);
  assert.equal(cpu.pendingIrq & 2, 2, 'timer request latched even though not enabled');
  cpu.step(); // tstv: test and clear
  assert.deepEqual([cpu.st, cpu.vf], [0, 0]);
  cpu.step();
  assert.equal(cpu.st, 1);
});

test('internal timer: one TL tick per 32 machine cycles with PIO bit 7', () => {
  const { cpu } = makeCpu([0x3e, 0x80]);
  cpu.step(); // 2 cycles
  cpu.run(30);
  assert.equal(cpu.tl, 1);
});

test('serial mode shifts SI into SB once per cycle; tsts tests and clears SF', () => {
  const { cpu } = makeCpu([0x3e, 0x20, 0x00, 0x00, 0x27, 0x27], { readSI: () => 1 });
  cpu.step(); // en $20 (2 cycles = 2 bits)
  assert.equal(cpu.sb, 0xc);
  cpu.step(); cpu.step();
  assert.deepEqual([cpu.sb, cpu.sf], [0xf, 1]);
  cpu.step(); // tsts: clears SF and the bit count; the same cycle shifts again
  assert.deepEqual([cpu.st, cpu.sf, cpu.sbCount], [0, 0, 1]);
});

test('run() carries the instruction overrun into the next call', () => {
  const chain = [];
  for (let k = 0; k < 16; k += 1) chain.push(0x68, 2 * k + 2); // jpl to the next jpl
  const { cpu } = makeCpu(chain);
  assert.equal(cpu.run(3), 4, 'two 2-cycle instructions for a budget of 3');
  assert.equal(cpu.run(3), 2, 'one more: budget 3 - 1 overrun');
  assert.equal(cpu.cycles, 6);
});

test('reset line: suspended while asserted, restarts at $000 on release', () => {
  const { cpu } = makeCpu([0x9f, 0x00, 0x00]);
  cpu.run(2);
  assert.notEqual(cpu.getPc(), 0);
  cpu.setResetLine(true);
  const pc = cpu.getPc();
  assert.equal(cpu.run(10), 10);
  assert.equal(cpu.getPc(), pc, 'nothing executes');
  cpu.setResetLine(false);
  assert.equal(cpu.getPc(), 0);
  assert.equal(cpu.a, 0);
});

// ---------------------------------------------------------------------------
// Part 2: the real 51xx.bin on a Galaga bus

const roms = loadGalaga();

/** Galaga input bits (active low). */
const IN0 = { R1: 0x02, L1: 0x08, R2: 0x20, L2: 0x80 };
const IN1 = { FIRE1: 0x01, FIRE2: 0x02, START1: 0x04, START2: 0x08, COIN1: 0x10, COIN2: 0x20, SERVICE: 0x40, TEST: 0x80 };

/**
 * A booted session after Galaga's start-up conversation.
 * @param {number[]} [coinage]
 */
function galaga(coinage) {
  const s = new Session51({ rom: roms.mcu51 });
  s.boot();
  const b1 = s.galagaStartup(coinage).lle;
  return { s, b1 };
}

/**
 * Run `n` frames with the given inputs, reading 3 bytes each frame 6000
 * Z80 cycles after vblank start (as Galaga does from its vblank handler).
 * @param {Session51} s
 * @param {number} n
 * @param {number} [in0]
 * @param {number} [in1]
 * @returns {number[][]} bytes read per frame
 */
function frames(s, n, in0 = 0xff, in1 = 0xff) {
  const out = [];
  s.in0 = in0;
  s.in1 = in1;
  for (let i = 0; i < n; i += 1) {
    s.waitFrameOffset(6000);
    out.push(s.read3().lle);
  }
  return out;
}

test('51xx boots into switch mode: byte0 = IN1, byte1 = IN0, byte2 = $FF', () => {
  const s = new Session51({ rom: roms.mcu51 });
  s.boot();
  assert.equal(s.lle.mcu.pio, 0x64, 'en $64: external clock timer, serial, IRQ');
  s.waitFrameOffset(9000);
  s.write(0xa1, [5, 5, 5, 5]);
  const [bytes] = frames(s, 1, 0xa5, 0x7e);
  assert.deepEqual(bytes, [0x7e, 0xa5, 0xff]);
});

test('Galaga start-up: B1 read returns 0 credits; credit mode reads 00 FF FF', () => {
  const { s, b1 } = galaga([1, 1, 1, 1]);
  assert.equal(b1[0], 0x00);
  assert.equal(s.lle.mcu.ram[3], 0, 'credit mode');
  assert.equal(s.lle.mcu.ram[2], 1, 'remap disabled');
  assert.deepEqual(s.lle.mcu.ram.slice(0x10, 0x14), Uint8Array.from([1, 1, 1, 1]));
  assert.deepEqual(frames(s, 2), [[0x00, 0xff, 0xff], [0x00, 0xff, 0xff]]);
});

test('a coin is counted on the 2nd frame of the switch closing and credits are BCD', () => {
  const { s } = galaga([1, 1, 1, 1]);
  frames(s, 3);
  const coin = frames(s, 3, 0xff, 0xff & ~IN1.COIN1).map((b) => b[0]);
  assert.deepEqual(coin, [0x00, 0x01, 0x01], 'debounced falling edge');
  // Nine more coins: 10 credits is $10 in BCD.
  for (let i = 0; i < 9; i += 1) {
    frames(s, 2);
    frames(s, 2, 0xff, 0xff & ~IN1.COIN1);
  }
  assert.equal(frames(s, 1)[0][0], 0x10);
});

test('2 coins / 1 credit and 1 coin / 2 credits coinage; slot 2 uses args 3-4', () => {
  const { s } = galaga([2, 1, 1, 2]);
  const insert = (bit) => { frames(s, 2); frames(s, 2, 0xff, 0xff & ~bit); return frames(s, 1)[0][0]; };
  assert.equal(insert(IN1.COIN1), 0x00);
  assert.equal(insert(IN1.COIN1), 0x01);
  assert.equal(insert(IN1.COIN2), 0x03);
});

test('free play (all coinage args 0) shows $A0', () => {
  const { s } = galaga([0, 0, 0, 0]);
  assert.equal(frames(s, 1)[0][0], 0xa0);
});

test('SERVICE adds a credit; TEST shows $BB and drops to switch mode', () => {
  const { s } = galaga([1, 1, 1, 1]);
  frames(s, 2);
  frames(s, 2, 0xff, 0xff & ~IN1.SERVICE);
  assert.equal(frames(s, 1)[0][0], 0x01);
  const t = frames(s, 2, 0xff, 0xff & ~IN1.TEST);
  assert.deepEqual(t[0], [0xbb, 0xff, 0xff]);
  assert.deepEqual(t[1], [0x7f, 0xff, 0xff], 'now in switch mode');
});

test('START1 with credits: subtracts one, then the joystick bytes go live', () => {
  const { s } = galaga([1, 1, 1, 1]);
  frames(s, 2);
  frames(s, 2, 0xff, 0xff & ~IN1.COIN1);
  frames(s, 2);
  frames(s, 2, 0xff, 0xff & ~IN1.COIN1);
  assert.equal(frames(s, 1)[0][0], 0x02);
  const st = frames(s, 3, 0xff, 0xff & ~IN1.START1);
  assert.deepEqual(st.map((b) => b[0]), [0x02, 0x01, 0x01]);
  assert.deepEqual(st[1].slice(1), [0xff, 0xff], 'credit-mode frame: bytes 1-2 stale');
  assert.deepEqual(st[2].slice(1), [0x3f, 0x3f], 'game mode: bits 4-5 = fire idle');
  assert.equal(s.lle.mcu.ram[3], 2, 'game mode');
});

test('START2 needs two credits', () => {
  const { s } = galaga([1, 1, 1, 1]);
  frames(s, 2);
  frames(s, 2, 0xff, 0xff & ~IN1.COIN1);
  assert.equal(frames(s, 3, 0xff, 0xff & ~IN1.START2).at(-1)[0], 0x01, 'ignored with 1 credit');
  frames(s, 2);
  frames(s, 2, 0xff, 0xff & ~IN1.COIN1);
  frames(s, 2);
  assert.equal(frames(s, 3, 0xff, 0xff & ~IN1.START2).at(-1)[0], 0x00);
});

test('game mode bytes: raw stick nibble, fire level bit5, one-frame fire edge bit4', () => {
  const { s } = galaga([1, 1, 1, 1]);
  frames(s, 2);
  frames(s, 2, 0xff, 0xff & ~IN1.COIN1);
  frames(s, 2);
  frames(s, 3, 0xff, 0xff & ~IN1.START1);
  frames(s, 3);
  assert.equal(frames(s, 1, 0xff & ~IN0.L1)[0][1], 0x37, 'P1 left = bit3 low');
  assert.equal(frames(s, 1, 0xff & ~IN0.R1)[0][1], 0x3d, 'P1 right = bit1 low');
  assert.equal(frames(s, 1, 0xff & ~IN0.L2)[0][2], 0x37, 'P2 left = bit3 low');
  assert.equal(frames(s, 1, 0xff & ~IN0.R2)[0][2], 0x3d, 'P2 right = bit1 low');
  frames(s, 3);
  const fire = frames(s, 4, 0xff, 0xff & ~IN1.FIRE1).map((b) => b[1]);
  assert.deepEqual(fire, [0x1f, 0x0f, 0x1f, 0x1f], 'level at once, edge on the 2nd frame only');
  frames(s, 3);
  const fire2 = frames(s, 3, 0xff, 0xff & ~IN1.FIRE2).map((b) => b[2]);
  assert.deepEqual(fire2, [0x1f, 0x0f, 0x1f]);
  // Game over: Galaga writes 02 02 02 with control $61 -> back to credit mode.
  s.waitFrameOffset(15000);
  s.write(0x61, [2, 2, 2]);
  frames(s, 1);
  assert.equal(s.lle.mcu.ram[3], 0);
});

test('coin counter: P bit 3 pulses low for TL 0..3 per coin; lamps blink on P bits 0-1', () => {
  const { s } = galaga([1, 1, 1, 1]);
  frames(s, 2);
  s.lleP.length = 0;
  frames(s, 2, 0xff, 0xff & ~IN1.COIN1);
  frames(s, 40);
  const low = s.lleP.filter((p) => !(p & 8)).length;
  assert.equal(low, 4, 'one 4-frame pulse');
  // With 1 credit only bit 1 (galaga LED 0) blinks, 16 frames on / 16 off.
  const lamps = new Set(s.lleP.map((p) => p & 3));
  assert.deepEqual([...lamps].sort(), [0, 2]);
});

test('timing: the frame work finishes well within 3000 Z80 cycles of vblank', () => {
  const s = new Session51({ rom: roms.mcu51 });
  const mcu = s.lle.mcu;
  let startedAt = null;
  let worst = 0;
  const step = mcu.step.bind(mcu);
  mcu.step = () => {
    if (mcu.getPc() === 0x17e && startedAt !== null) {
      worst = Math.max(worst, mcu.cycles - startedAt);
      startedAt = null;
    }
    return step();
  };
  s.onFrame = () => { startedAt = mcu.cycles; };
  s.boot();
  s.galagaStartup([1, 1, 1, 1]);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff);
  for (let i = 0; i < 200; i += 1) frames(s, 1, rnd(), rnd() | 0x80);
  assert.ok(worst > 0 && worst * 12 < 3000, `worst ${worst} MB88 cycles`);
});

test('a strobe during the chip\'s read handler is lost (E1 right after a read)', () => {
  const s = new Session51({ rom: roms.mcu51 });
  s.boot();
  s.galagaStartup([1, 1, 1, 1]);
  s.waitFrameOffset(6000);
  s.read3();
  // Start a coinage transfer only ~200 Z80 cycles after the last read
  // strobe: its first strobe (the 01 command) hits the read handler.
  s.bus.advanceTo(s.bus.now + 130);
  s.write(0xe1, [1, 2, 2, 2, 2, 2, 3, 0]);
  const ram = s.lle.mcu.ram;
  // The chip never saw the 01; the following 2s were taken as commands, so
  // the coinage stayed 1/1/1/1 instead of becoming 2/2/2/2.
  assert.deepEqual(Array.from(ram.slice(0x10, 0x14)), [1, 1, 1, 1]);
});

// ---------------------------------------------------------------------------
// 54XX smoke test

test('54xx boots, takes Galaga\'s sound-test parameters and makes noise', () => {
  const events = [];
  const n54 = new Namco54({ rom: roms.mcu54, onOutput: (ch, v, t) => events.push([ch, v, t]) });
  const bus = new Bus06({ chips: [null, null, null, n54] });
  n54.reset(0);
  bus.advanceTo(1000);
  n54.reset(1);
  bus.advanceTo(20000);
  // Main ROM $35FA: 12 parameter bytes with control $A8, then the NMI's
  // "bang" trigger $0092: 10 10 20 20.
  bus.transfer(0xa8, [0x30, 0x40, 0x00, 0x02, 0xdf, 0x40, 0x30, 0x30, 0x03, 0xdf, 0x10, 0x20]);
  bus.advanceTo(bus.now + FRAME_Z80);
  const before = events.length;
  bus.transfer(0xa8, [0x10, 0x10, 0x20, 0x20]);
  bus.advanceTo(bus.now + 10 * FRAME_Z80);
  const after = events.slice(before);
  assert.ok(after.length > 100, `54xx produced ${after.length} output writes`);
  assert.ok(after.some(([, v]) => v !== 0), 'non-zero output');
  const channels = new Set(after.map(([ch]) => ch));
  assert.ok(channels.size >= 2, `channels used: ${[...channels]}`);
  // Timestamps are monotonic Z80 times.
  for (let i = 1; i < after.length; i += 1) assert.ok(after[i][2] >= after[i - 1][2]);
});
