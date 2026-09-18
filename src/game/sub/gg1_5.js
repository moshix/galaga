// Copyright 2026 by Moshix
/**
 * Sub CPU, ROM gg1_5b.3f ($0000-$0FFF): the "motion processor".
 *
 * After its reset handshake with the main CPU the sub CPU idles forever;
 * all its work happens in the vblank IRQ ($0038 -> jp_0513_rst38), which
 * keeps the frame counters, then runs the tasks enabled in
 * ds_cpu1_task_actv ($9020-$9027) from the table at $003B:
 *
 *   [0] f_05BE  null task
 *   [1] f_05BF  copy the sprite buffers to the sprite registers
 *   [2] f_08D3  bug motion runner                    (gg1_5_motion.js)
 *   [4] f_06F5  rockets and rocket hit detection     (gg1_5_hitd.js)
 *   [5] f_05EE  fighter collision detection          (gg1_5_hitd.js)
 *   [7] f_0ECA  factory test hook (off unless DSWA SW1:3 is on)
 *
 * This file registers everything the sub CPU defines into SUB / SUB_AT.
 */

import { SUB, SUB_AT, subAt } from './routines.js';
import { romWord, subRom } from '../romdata.js';
import { SPIN } from '../scheduler.js';
import * as motion from './gg1_5_motion.js';
import * as hitd from './gg1_5_hitd.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

const SUB_CPU = 1;

/**
 * Sum of the 4096 bytes of gg1_5b.3f mod 256, which CPU1_RESET computes at
 * $0583. The port cannot read code bytes (romdata.js holds data only), so
 * the sum is a constant; test/oracle/sub-gg1_5.test.mjs checks it against
 * the ROM. $FF is the "ROM OK" value.
 */
export const SUB_ROM_CHECKSUM = 0xff;

/**
 * Machines whose sub CPU executed `rst $00` inside the IRQ handler (f_0ECA)
 * and must restart from the reset vector when the foreground resumes.
 * @type {WeakSet<Machine>}
 */
const restartPending = new WeakSet();

/** Returned by f_0ECA when it executes `rst $00`. */
export const RESTART = Symbol('sub rst $00');

// --------------------------------------------------------------- reset

/**
 * CPU1_RESET ($057C): handshake with the main CPU through $9100
 * (ds_rom_test_status): wait for 0, post the ROM checksum result ($FF, or
 * $11 on error), wait for the main CPU to clear it again, then set the
 * task-enable defaults from $05B7 and enable the vblank IRQ.
 * @see galaga-sub.asm $057C
 * @param {Machine} m
 * @returns {Generator<symbol|undefined, void, void>}
 */
export function* CPU1_RESET(m) {
  // 057F: the main CPU clears $9100 when its RAM test is done.
  while (m.peek(0x9100) !== 0) yield SPIN;
  // 0583: checksum loop, 4096 x 26 cycles ~ 2.1 frames of real time. The
  // oracle posts the result 2 frames after the release (frame 699 -> 701
  // in a power-on run), so the port lets two frames pass.
  yield;
  yield;
  m.poke(0x9100, SUB_ROM_CHECKSUM === 0xff ? 0xff : 0x11);
  // 0596: wait for the main CPU to acknowledge (it clears $9100-$9102).
  while (m.peek(0x9100) !== 0) yield SPIN;
  m.poke(0x89e0, 0); // f_0ECA's state
  m.ldir(0x9021, 0x05b7, 7, 'sub'); // d_05B7 -> ds_cpu1_task_actv[1..7]
  m.poke(0x6821, 1);
  m.ei(SUB_CPU);
}

/**
 * Reset vector ($0000): `ld sp,$9100 / jp CPU1_RESET`, then the idle loop
 * at $05B1 (`ld sp,$9100 / jp $05B1`) for good. If the IRQ handler hit
 * f_0ECA's `rst $00`, the CPU starts over at the reset vector.
 * @see galaga-sub.asm $0000
 * @param {Machine} m
 * @returns {Generator<symbol|undefined, void, void>}
 */
export function* sub_reset(m) {
  for (;;) {
    yield* CPU1_RESET(m);
    while (!restartPending.has(m)) yield;
    restartPending.delete(m);
    // rst $00 ran inside the handler: interrupts stay off until the
    // reinitialisation's `ei`, and $6821 was left at 0.
    m.di(SUB_CPU);
  }
}

// ----------------------------------------------------------------- IRQ

/**
 * The vblank IRQ handler. Acknowledge; unless the freeze switch (DSWA
 * SW1:5 via $6804 bit 1, active low) is on: advance the frame counters
 * ($92A0 every frame; $92A2 when $92A0 & $1F is 1 or 0, and then also
 * $92A1, with $92A2 forced odd first), set the continuous-bombing flag
 * $92AA, and run the enabled tasks. A task's enable byte is also the
 * number of table entries to skip after it, so $0A at [7] ends the scan.
 * @see galaga-sub.asm $0513 (jp_0513_rst38)
 * @param {Machine} m
 */
export function sub_irq(m) {
  m.poke(0x6821, 0);
  if ((m.peek(0x6804) & 0x02) !== 0) {
    const fc = (m.peek(0x92a0) + 1) & 0xff;
    m.poke(0x92a0, fc);
    let l = m.peek(0x92a1);
    let h = m.peek(0x92a2);
    const r = fc & 0x1f;
    if (r === 1) h = (h + 1) & 0xff;
    else if (r === 0) {
      h |= 1;
      l = (l + 1) & 0xff;
      h = (h + 1) & 0xff;
    }
    m.poke(0x92a1, l);
    m.poke(0x92a2, h);
    // 053A: bugs left < parameter -> carry, rotated into B<0> and ANDed
    // with the fire-input task's enable.
    const cf = m.peek(0x92a7) < m.peek(0x99c7) ? 1 : 0;
    m.poke(0x92aa, m.peek(0x9015) & cf);

    let c = 0;
    do {
      let st;
      // 054F: scan $9020+C (L wraps inside page $90) for a set byte.
      for (let n = 0; ; n += 1) {
        st = m.peek(0x9000 | ((0x20 + c) & 0xff));
        if (st !== 0) break;
        c = (c + 1) & 0xff;
        if (n > 0x100) throw new Error('sub CPU: task table empty, IRQ hangs');
      }
      const task = subAt(romWord('sub', (0x3b + ((c << 1) & 0xff)) & 0xff));
      const res = task(m);
      if (res === RESTART) {
        // rst $00: the handler never returns; see sub_reset.
        restartPending.add(m);
        return;
      }
      c = (c + st) & 0xff;
    } while ((c & 0xf8) === 0);
  }
  m.poke(0x6821, 1);
}

// --------------------------------------------------------------- tasks

/**
 * cpu1 task [0], [3], [6]: nothing.
 * @see galaga-sub.asm $05BE
 */
export function f_05BE() {}

/**
 * cpu1 task [1]: copy the sprite code, position and control buffers
 * ($8B00, $9300, $9B00, $40 bytes each) to the registers at +$80, raising
 * b_CPU2_in_progress ($92D7) meanwhile. The Z80 then spins while the main
 * CPU's f_0828 holds b_CPU1_in_progress ($92D6) at 1; with the handlers
 * run one after the other that wait can never end differently, and it
 * writes nothing, so the port does not wait.
 * @see galaga-sub.asm $05BF
 * @param {Machine} m
 */
export function f_05BF(m) {
  m.poke(0x92d7, 1);
  m.ldir(0x8b80, 0x8b00, 0x40, 'sub');
  m.ldir(0x9380, 0x9300, 0x40, 'sub');
  m.ldir(0x9b80, 0x9b00, 0x40, 'sub');
  m.poke(0x92d7, 0);
}

/**
 * cpu1 task [7]: a factory test hook. With DSWA SW1:3 off ($6802 bit 1
 * set, the default) it returns at once. With it on, it probes a device
 * decoded at $1000-$10FF; on this board nothing is there, so both reads of
 * $10DF agree and it executes `rst $00` -- a sub CPU restart.
 * @see galaga-sub.asm $0ECA
 * @param {Machine} m
 * @returns {symbol|undefined} RESTART when it executed `rst $00`
 */
export function f_0ECA(m) {
  if ((m.peek(0x6802) & 0x02) !== 0) return undefined;
  const c = m.read('sub', 0x10df);
  const a = m.read('sub', 0x10df);
  if (((a ^ c) & 0x10) === 0) return RESTART;
  l_0EDE(m);
  return undefined;
}

/**
 * The rest of f_0ECA, reached only with a device at $1000: a hex keypad
 * monitor. Shifts a 20-byte history at $89E4-$89F7, samples five key rows
 * ($10FD, $10FB, $10F7, $10EF, $10FE -- the low address byte selects the
 * row) into $89E4+4n, decodes a new key press, edits the byte at
 * ($89E2) through $89E1 (nibble cursor in $89E0), and shows address and
 * data as hex digits at $83CA and a cursor in the colour RAM at $87CA.
 * @see galaga-sub.asm $0EDE
 * @param {Machine} m
 */
export function l_0EDE(m) {
  // lddr: $89F6..$89E4 -> $89F7..$89E5, top down.
  for (let i = 0; i < 0x13; i += 1) m.poke(0x89f7 - i, m.peek(0x89f6 - i));
  let e = 0xe0;
  for (let i = 0; i < 5; i += 1) {
    const row = subRom(0x0fd5 + i);
    e = (e + 4) & 0xff;
    m.poke(0x8900 | e, m.read('sub', 0x1000 | row));
  }
  // 0F07: a key is new if pressed (bit set) in the last two samples and
  // released in the two before: ~(s0 | s1) & s2 & s3.
  let b = 5;
  let a = 0;
  let hl = 0x89e4;
  for (; b > 0; b -= 1) {
    a = ~(m.peek(hl) | m.peek(hl + 1)) & m.peek(hl + 2) & m.peek(hl + 3) & 0x0f;
    hl += 4;
    if (a !== 0) break;
  }
  if (b === 1) keyCommand(m, a); // row 4: control keys
  else if (b > 1) keyDigit(m, a, b);
  else memRead(m);
  showMonitor(m);
}

/**
 * 0F18: hex digit (b - 2) * 4 + lowest set bit of a, entered into the
 * nibble of $89E1+ selected by $89E0.
 * @param {Machine} m @param {number} a @param {number} b
 */
function keyDigit(m, a, b) {
  let digit = ((b - 2) << 2) & 0xff;
  while ((a & 1) === 0) { a >>= 1; digit += 1; }
  const cur = m.peek(0x89e0);
  const lowNib = cur & 1; // srl a -> carry -> rl c
  const e = cur >> 1;
  const p = 0x8900 | ((e + 0xe1) & 0xff);
  let v = m.peek(p);
  if (lowNib) v = ((v << 4) | (v >> 4)) & 0xff; // rlca x4: swap nibbles
  v = (v & 0xf0) | digit;
  if (lowNib) v = ((v << 4) | (v >> 4)) & 0xff;
  m.poke(p, v);
  let n = m.peek(0x89e0);
  if (n === 0) n = 2;
  m.poke(0x89e0, n - 1);
  if (e !== 0) memRead(m); // 0F54: ld a,e / and a / jr z,$0F61
  else memWrite(m);
}

/**
 * 0F6A: control keys: bit 0 cursor home ($89E0 = 5), bit 3 / others move
 * the cursor or, from the data field, step the address.
 * @param {Machine} m @param {number} c
 */
function keyCommand(m, c) {
  if (c & 1) { m.poke(0x89e0, 5); memRead(m); return; }
  const cur = m.peek(0x89e0);
  if ((cur >> 1) !== 0) {
    if (c & 8) m.poke(0x89e0, cur - 1);
    else m.poke(0x89e0, cur >= 5 ? 5 : cur + 1);
    memRead(m);
    return;
  }
  // 0F8A: step the address.
  let hl = m.peek16(0x89e2);
  hl = (c & 8) ? hl + 1 : hl - 1;
  m.poke16(0x89e2, hl & 0xffff);
  m.poke(0x89e0, 1);
  memRead(m);
}

/**
 * 0F58: $89E1 = byte at ($89E2). The sub CPU sees its own ROM there; the
 * port has only the ROM's data bytes, so a code byte reads as 0.
 * @param {Machine} m
 */
function memRead(m) {
  const p = m.peek16(0x89e2);
  let v;
  try { v = m.read('sub', p); } catch { v = 0; }
  m.poke(0x89e1, v);
}

/** 0F61: byte at ($89E2) = $89E1. @param {Machine} m */
function memWrite(m) {
  m.poke(m.peek16(0x89e2), m.peek(0x89e1));
}

/**
 * 0FA3: $89E1-$89E3 as six hex digits at $83CA, then colour 1 for the
 * first $89E0 of six cells at $87CA (0 for the rest).
 * @param {Machine} m
 */
function showMonitor(m) {
  let hl = 0x83ca;
  for (let i = 0; i < 3; i += 1) hl = c_0FC6(m, { a: m.peek(0x89e1 + i), hl }).hl;
  let a = m.peek(0x89e0);
  for (let i = 0; i < 6; i += 1) {
    m.poke(0x87ca + i, a !== 0 ? 1 : 0);
    a = (a - 1) & 0xff;
  }
}

/**
 * Two hex digits of A at HL, low nibble first; returns HL + 2.
 * @see galaga-sub.asm $0FC6
 * @param {Machine} m @param {{ a: number, hl: number }} regs
 * @returns {{ hl: number }}
 */
export function c_0FC6(m, { a, hl }) {
  m.poke(hl, a & 0x0f);
  const l1 = (hl & 0xff00) | ((hl + 1) & 0xff);
  m.poke(l1, (a >> 4) & 0x0f);
  return { hl: (hl & 0xff00) | ((hl + 2) & 0xff) };
}

// ------------------------------------------------------- registration

Object.assign(SUB, {
  sub_reset,
  sub_irq,
  jp_0513_rst38: sub_irq,
  CPU1_RESET,
  f_05BE,
  f_05BF,
  f_05EE: hitd.f_05EE,
  hitd_fghtr_hit: hitd.hitd_fghtr_hit,
  hitd_fghtr_notif: hitd.hitd_fghtr_notif,
  hitd_det_fghtr: hitd.hitd_det_fghtr,
  f_06F5: hitd.f_06F5,
  rckt_man: hitd.rckt_man,
  hitd_det_rckt: hitd.hitd_det_rckt,
  hitd_dspchr: hitd.hitd_dspchr,
  f_08D3: motion.f_08D3,
  case_0942: motion.case_0942,
  case_094E: motion.case_094E,
  case_0955: motion.case_0955,
  case_0968: motion.case_0968,
  case_097B: motion.case_097B,
  case_0A01: motion.case_0A01,
  case_0A53: motion.case_0A53,
  case_0AA0: motion.case_0AA0,
  case_0B16: motion.case_0B16,
  case_0B46: motion.case_0B46,
  case_0B4E: motion.case_0B4E,
  case_0B5F: motion.case_0B5F,
  case_0B87: motion.case_0B87,
  case_0B98: motion.case_0B98,
  case_0BA8: motion.case_0BA8,
  case_0BD1: motion.case_0BD1,
  case_0E49_make_object_inactive: motion.case_0E49_make_object_inactive,
  c_0E5B: motion.c_0E5B,
  c_0E97: motion.c_0E97,
  c_0EAA: motion.c_0EAA,
  f_0ECA,
  l_0EDE,
  c_0FC6,
});

// Task table $003B, plus everything else with an address. The flight-path
// command handlers (d_0920_jp_tbl) are registered by gg1_5_motion.js.
Object.assign(SUB_AT, {
  0x0000: sub_reset,
  0x0038: sub_irq,
  0x0513: sub_irq,
  0x057c: CPU1_RESET,
  0x05be: f_05BE,
  0x05bf: f_05BF,
  0x05ee: hitd.f_05EE,
  0x0649: hitd.hitd_fghtr_hit,
  0x0681: hitd.hitd_fghtr_notif,
  0x06b7: hitd.hitd_det_fghtr,
  0x06f5: hitd.f_06F5,
  0x0704: hitd.rckt_man,
  0x076a: hitd.hitd_det_rckt,
  0x07c2: hitd.hitd_dspchr,
  0x08d3: motion.f_08D3,
  0x0e5f: motion.c_0E5B,
  0x0e9b: motion.c_0E97,
  0x0eae: motion.c_0EAA,
  0x0eca: f_0ECA,
  0x0ede: l_0EDE,
  0x0fc6: c_0FC6,
});
