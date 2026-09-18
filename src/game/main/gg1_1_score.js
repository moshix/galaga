// Copyright 2026 by Moshix
/**
 * Main CPU score and number-printing routines of game_ctrl.s:
 *
 *   $0728 gctl_supv_score          turn hit counts into score, high score, bonus ships
 *   $07D8 c_scoreman_incr_add      add a digit into the on-screen score
 *   $080B gctl_supv_stage          end-of-stage / restart-stage check
 *   $0A27 c_mach_info_add_score    add a final score to the machine's total
 *   $0A53 c_text_out_i_to_d        print a 16-bit number in decimal
 *   $0A6E c_0A6E                   putc + one cell right
 *   $0A72 c_0A72_puts_hitmiss_ratio  compute and print the hit-miss ratio
 *   $0B06 c_0B06                   HL * 10, split into high byte / low byte
 *
 * Galaga keeps the players' scores only as characters in tile RAM
 * ($83xx, digits 0-9, $24 = blank); the arithmetic here works on those
 * characters directly.
 *
 * @see reference/galaga-main.asm $0728-$0B0E
 */

import { MAIN } from './routines.js';
import { add8, daa, bcdAdd } from '../z80ops.js';
import { rst_DEminus20, rst_HLplusA } from './gg1_1_rst.js';

/**
 * @typedef {import('../../machine/machine.js').Machine} Machine
 */

/**
 * $0728 gctl_supv_score: the score manager, called from the game-runner
 * loop.
 *
 *  1. For each of the 16 hit counters at $9290-$929F: while non-zero,
 *     decrement it and add its BCD points value (d_scoreman_inc_lut,
 *     indexed backwards: counter i uses $080A - i) to the active player's
 *     score -- low digit into the tens, high digit into the hundreds.
 *  2. If the player's score (6 characters) beats the high score at
 *     $83ED-$83F2, copy it over, from the first differing digit down.
 *  3. Compare the score's 100 000s/10 000s (as a number 0-99) with the next
 *     bonus threshold ($983E); on a match award a ship, advance the
 *     threshold by the "every" value ($9981) and count the bonus in BCD
 *     at $99EA.
 * @see galaga-main.asm $0728
 * @param {Machine} m
 */
export function gctl_supv_score(m) {
  // $072C: tens digit of the score, player 1 at $83F9, player 2 at $83E4.
  const ixl = m.peek(0x9840) === 0 ? 0xf9 : 0xe4;
  let ptr = 0x9290;
  for (let b = 0x10; b > 0; b -= 1) {
    const inc = m.read('main', 0x07fa + b);
    // $0740: while (hit_count) { hit_count--; add points }
    while (m.peek(ptr) !== 0) {
      m.poke(ptr, (m.peek(ptr) - 1) & 0xff);
      c_scoreman_incr_add(m, { a: inc & 0x0f, hl: 0x8300 | ixl });
      c_scoreman_incr_add(m, { a: (inc >> 4) & 0x0f, hl: 0x8300 | ((ixl + 1) & 0xff) });
    }
    // $0762: inc l -- 8-bit, but $9290-$929F never crosses a page.
    ptr = (ptr & 0xff00) | ((ptr + 1) & 0xff);
  }

  // $0765: compare with the high score, most significant digit first.
  let e = (ixl + 4) & 0xff;
  let l = 0xf2;
  let b = 6;
  let copy = false;
  while (b > 0) {
    let a = (m.peek(0x8300 | e) - m.peek(0x8300 | l)) & 0xff;
    a = (a + 9) & 0xff;
    // $0775: cp $E5 / jr nc: player digit vs. a blank high-score digit.
    if (a >= 0xe5) { copy = true; break; }
    a = (a - 0x0a) & 0xff;
    // $077B: cp $09 / jr c: player digit greater.
    if (a < 0x09) { copy = true; break; }
    // $077F: inc a / jr nz: player digit smaller -- no new high score.
    if (((a + 1) & 0xff) !== 0) break;
    l = (l - 1) & 0xff;
    e = (e - 1) & 0xff;
    b -= 1;
  }
  if (copy) {
    // $0788: copy the remaining B digits.
    for (; b > 0; b -= 1) {
      m.poke(0x8300 | l, m.peek(0x8300 | e));
      l = (l - 1) & 0xff;
      e = (e - 1) & 0xff;
    }
  }

  // $078E: score / 10000 as a number: (100 000s digit) * 10 + 10 000s digit.
  let hl = 0x8300 | ((ixl + 4) & 0xff);
  let a = m.peek(hl);
  if (a === 0x24) a = 0;
  a &= 0x3f;
  // rlca / ld c,a / rlca / rlca / add a,c -- A*2 + A*8, all 8-bit rotates.
  let c = ((a << 1) | (a >> 7)) & 0xff;
  a = ((c << 2) | (c >> 6)) & 0xff;
  a = (a + c) & 0xff;
  c = a;
  hl -= 1;
  a = m.peek(hl);
  if (a === 0x24) a = 0;
  a = (a + c) & 0xff;
  if (a !== m.peek(0x983e)) return;

  // $07AE: a bonus ship is due.
  const bonus = m.peek(0x9981);
  const every = bonus & 0x7f;
  a = m.peek(0x983e);
  // $07B6: cp c / jr nc: below the "every" value, jump to it; else add it
  // (bit 7 of the raw value is added too, as the bytes do).
  a = a < every ? every : (a + bonus) & 0xff;
  m.poke(0x983e, a);
  m.poke(0x9aaa, a);
  m.poke(0x9820, (m.peek(0x9820) + 1) & 0xff);
  MAIN.draw_resv_ships(m);
  // $07C8: bonus-ship count, BCD, 2 bytes big-endian at $99EA.
  const lo = bcdAdd(m.peek(0x99eb), 1);
  m.poke(0x99eb, lo.a);
  if (!lo.cf) return;
  m.poke(0x99ea, bcdAdd(m.peek(0x99ea), 1).a);
}

/**
 * $07D8 c_scoreman_incr_add: add A (0-9) to the score digit character at
 * HL, rippling a carry leftwards through the digits (L+1, L+2 ...; the
 * score row runs right to left). A blank counts as 0.
 * @see galaga-main.asm $07D8
 * @param {Machine} m
 * @param {{ a: number, hl: number }} regs
 * @returns {{ hl: number }} HL advanced past any carried digits
 */
export function c_scoreman_incr_add(m, { a, hl }) {
  if ((a & 0xff) === 0) return { hl };
  let v = (a + m.peek(hl)) & 0xff;
  // $07DB: cp $24 / jr c -- a blank ($24) plus the digit: remove the $24.
  if (v >= 0x24) v = (v - 0x24) & 0xff;
  if (v < 0x0a) {
    m.poke(hl, v);
    return { hl };
  }
  v = (v - 0x0a) & 0xff;
  let p = hl;
  for (;;) {
    // $07E9: store, move one digit left (inc l: 8-bit), and carry into it.
    m.poke(p, v);
    p = (p & 0xff00) | ((p + 1) & 0xff);
    let d = m.peek(p);
    if (d === 0x24) d = 0;
    if (d !== 0x09) {
      m.poke(p, (d + 1) & 0xff);
      return { hl: p };
    }
    v = 0; // 9 + 1: write 0 and carry on
  }
}

/**
 * $080B gctl_supv_stage: decide whether the stage is over or must restart.
 *
 *  - No enemies left and f_2916 (attack waves) inactive: silence the
 *    pulsing sound and go to gctl_stg_restart_hdlr.
 *  - Else, if the restart-stage flag ($9213) is set: disable attack waves
 *    and go to gctl_stg_restart_hdlr.
 *  - Else return to the game-runner loop.
 *
 * On the Z80 the "go to" is `jp $049E` after the handler pops the return
 * address; the port returns `{ restart: true }` and the game-flow driver
 * does the jump.
 * @see galaga-main.asm $080B
 * @param {Machine} m
 * @returns {{ restart: boolean }}
 */
export function gctl_supv_stage(m) {
  const a = m.peek(0x9008) | m.peek(0x92a7);
  if (a === 0) {
    m.poke(0x9aa0, 0);
    return { restart: true };
  }
  if (m.peek(0x9213) === 0) return { restart: false };
  m.poke(0x9842, 0);
  return { restart: true };
}

/**
 * $0A27 c_mach_info_add_score: add a player's final score (the 5
 * characters from the tens digit at DE leftwards; the ones digit is always
 * 0) to the machine's total-score counter, 4 BCD bytes at $99E2-$99E5.
 *
 * The characters are packed into BCD in the scratch bytes $9100-$9103 with
 * `rrd`, two digits per byte, then added with `adc`/`daa`.
 * @see galaga-main.asm $0A27
 * @param {Machine} m
 * @param {{ de: number }} regs DE = tens digit of the score in tile RAM
 */
export function c_mach_info_add_score(m, { de }) {
  let hl = 0x9103;
  let e = de & 0xff;
  const d = de & 0xff00;
  let a = 0;
  for (let b = 5; b > 0; b -= 1) {
    a = m.peek(d | e);
    e = (e + 1) & 0xff; // inc e
    if (a === 0x24) a = 0;
    a = rrd(m, hl, a);
    // $0A35: bit 0,b / jr nz -- move to the next byte after every 2nd digit.
    if ((b & 1) === 0) hl = (hl & 0xff00) | ((hl - 1) & 0xff);
  }
  rrd(m, hl, 0); // one more rrd to fix the last digit
  hl = (hl & 0xff00) | ((hl - 1) & 0xff);
  m.poke(hl, 0);
  hl = (hl & 0xff00) | 0x03;
  let dst = 0x99e5;
  let cf = 0; // and a
  for (let b = 4; b > 0; b -= 1) {
    const s = add8(m.peek(dst), m.peek(hl), cf);
    const r = daa(s.a, s.f);
    m.poke(dst, r.a);
    cf = r.cf ? 1 : 0;
    dst = (dst & 0xff00) | ((dst - 1) & 0xff);
    hl = (hl & 0xff00) | ((hl - 1) & 0xff);
  }
}

/**
 * `rrd`: (HL) low nibble -> A low nibble, A low nibble -> (HL) high nibble,
 * (HL) high nibble -> (HL) low nibble.
 * @param {Machine} m @param {number} hl @param {number} a
 * @returns {number} the new A
 */
function rrd(m, hl, a) {
  const t = m.peek(hl);
  m.poke(hl, ((a << 4) | (t >> 4)) & 0xff);
  return (a & 0xf0) | (t & 0x0f);
}

/**
 * `rld`: (HL) high nibble -> A low nibble, A low nibble -> (HL) low nibble,
 * (HL) low nibble -> (HL) high nibble.
 * @param {Machine} m @param {number} hl @param {number} a
 * @returns {number} the new A
 */
function rld(m, hl, a) {
  const t = m.peek(hl);
  m.poke(hl, ((t << 4) | (a & 0x0f)) & 0xff);
  return (a & 0xf0) | (t >> 4);
}

/**
 * $0A53 c_text_out_i_to_d: print HL in decimal, most significant digit
 * first, at DE and to the right (DE -= $20 per character). Digits come from
 * repeated c_divmod ($1061) by 10.
 * @see galaga-main.asm $0A53
 * @param {Machine} m
 * @param {{ hl: number, de: number }} regs
 * @returns {{ a: number, de: number, hl: number, b: number }} DE after the
 *   last digit; A == E; HL = the leading digit
 */
export function c_text_out_i_to_d(m, { hl, de }) {
  /** @type {number[]} */
  const stack = [];
  let v = hl & 0xffff;
  // $0A55: while (H != 0 || L >= 10) push(HL % 10), HL /= 10
  while ((v >> 8) !== 0 || (v & 0xff) >= 0x0a) {
    const r = MAIN.c_divmod(m, { a: 0x0a, hl: v });
    stack.push(r.a & 0xff);
    v = r.hl & 0xffff;
  }
  // $0A68: the first digit is L itself, then the pushed ones.
  let out = c_0A6E(m, { a: v & 0xff, de });
  while (stack.length > 0) out = c_0A6E(m, { a: /** @type {number} */ (stack.pop()), de: out.de });
  return { a: out.a, de: out.de, hl: v, b: 0 };
}

/**
 * $0A6E c_0A6E: `ld (de),a` then `jp rst_DEminus20`.
 * @see galaga-main.asm $0A6E
 * @param {Machine} m
 * @param {{ a: number, de: number }} regs
 * @returns {{ a: number, de: number }}
 */
export function c_0A6E(m, { a, de }) {
  m.poke(de, a);
  return rst_DEminus20(m, { de });
}

/**
 * $0A72 c_0A72_puts_hitmiss_ratio: hits ($9844) / shots ($9846) as a
 * percentage with one decimal (XXX.X), BCD in $99B0-$99B1, printed at
 * $8138 with leading zeros suppressed.
 *
 * Method: shift both left until one has bit 15 set, divide the hits by the
 * shots' high byte (c_divmod) twice to get a 16.16-ish quotient, then four
 * times multiply the fraction by 10 (c_0B06) and pull the digit out of the
 * high byte, `rld`-ing each into $99B0/$99B1. A fifth digit >= 5 rounds
 * the BCD up. The display loop `rld`s the digits back out, which leaves
 * $99B0/$99B1 rotated -- that too is reproduced.
 * @see galaga-main.asm $0A72
 * @param {Machine} m
 * @returns {{ de: number, hl: number }} DE = screen position after the text
 */
export function c_0A72_puts_hitmiss_ratio(m) {
  let hl = m.peek16(0x9844);
  let de = m.peek16(0x9846);
  let skipStore = false;
  if (de === 0) {
    // $0A7D: ratio 0.
  } else {
    // $0A82: scale up while neither has bit 15.
    while (!(de & 0x8000) && !(hl & 0x8000)) {
      hl = (hl << 1) & 0xffff;
      de = (de << 1) & 0xffff;
    }
    const dh = (de >> 8) & 0xff;
    let r = MAIN.c_divmod(m, { a: dh, hl });
    let sp = r.hl & 0xffff; // push hl (1st quotient)
    r = MAIN.c_divmod(m, { a: dh, hl: (r.a & 0xff) << 8 });
    // ex (sp),hl: HL = 1st quotient, stack = 2nd quotient
    hl = sp;
    sp = r.hl & 0xffff;
    let ptr = 0x99b0;
    let a = (hl >> 8) & 0xff;
    hl &= 0x00ff;
    let a2 = 0; // A' -- only ever written before it is read
    for (let b = 4; b > 0; b -= 1) {
      a = rld(m, ptr, a);
      if (b & 1) ptr = (ptr & 0xff00) | ((ptr + 1) & 0xff);
      // $0AAE: 1st product = HL * 10
      let p = c_0B06(m, { hl });
      hl = p.hl;
      a = p.a;
      [a, a2] = [a2, a]; // ex af,af' -- stash the 1st product's high byte
      [hl, sp] = [sp, hl]; // ex (sp),hl
      p = c_0B06(m, { hl });
      hl = p.hl;
      a = p.a;
      [hl, sp] = [sp, hl]; // ex (sp),hl
      // rst $10: HL += A (the 2nd product's high byte carries into H)
      const s = rst_HLplusA(m, { a, hl });
      hl = s.hl;
      a = s.a;
      [a, a2] = [a2, a]; // ex af,af'
      a = (a + (hl >> 8)) & 0xff; // add a,h -- the digit
      hl &= 0x00ff;
    }
    // $0ABE: pop de (discarded). cp $05 / jr c -- round up on >= 5.
    if (a < 5) {
      skipStore = true;
    } else {
      de = m.peek16(0x99b0);
      let d = bcdAdd((de >> 8) & 0xff, 1);
      let ee = de & 0xff;
      if (d.cf) ee = bcdAdd(ee, 1).a;
      de = (d.a << 8) | ee;
    }
  }
  if (!skipStore) m.poke16(0x99b0, de); // $0AD3: ld ($99B0),de

  // $0AD7: print 4 digits "XXX.X" from $99B0.
  let c = 0;
  let src = 0x99b0;
  let dst = 0x8138;
  for (let b = 4; b > 0; b -= 1) {
    if (b === 1) {
      m.poke(dst, 0x2a); // '.'
      dst = (dst - 0x20) & 0xffff;
    }
    const a = rld(m, src, 0);
    if (b & 1) src = (src & 0xff00) | ((src + 1) & 0xff);
    if (a !== 0 || (c & 1)) {
      c |= 1;
      m.poke(dst, a);
      dst = (dst - 0x20) & 0xffff;
    }
    // $0AFC: the tens digit (b == 3) always starts the number.
    if (b === 3) c |= 1;
  }
  return { de: dst, hl: src };
}

/**
 * $0B06 c_0B06: HL * 10 via c_104E_mul_16_8 ($104E); A = the product's
 * high byte, HL = its low byte.
 * @see galaga-main.asm $0B06
 * @param {Machine} m
 * @param {{ hl: number }} regs
 * @returns {{ a: number, hl: number }}
 */
export function c_0B06(m, { hl }) {
  const r = MAIN.c_104E_mul_16_8(m, { a: 0x0a, hl });
  return { a: (r.hl >> 8) & 0xff, hl: r.hl & 0x00ff };
}
