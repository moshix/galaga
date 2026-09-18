// Copyright 2026 by Moshix
/**
 * Sub CPU (gg1_5b.3f) -- the bug motion runner f_08D3 ($08D3-$0E5E) and the
 * math helpers it calls ($0E5F-$0EC5): every flying enemy on the screen is
 * moved here, once per frame, by the sub CPU's vblank IRQ task [2].
 *
 * THE MOTION QUEUE. ds_bug_motion_que at $9100 holds 12 slots of $14 bytes
 * (the main CPU fills a slot when it launches an alien, see main $108A and
 * $2960). Slot layout, IX-relative:
 *
 *   +00 +01   y, 9.7 fixed point: +01 is y<8:1>, +00 bit 7 is y<0>
 *   +02 +03   x, 9.7 fixed point, same layout
 *   +04 +05   heading, a 10-bit angle (+05 bits 1:0 = quadrant, +04 the
 *             fraction); 0 = +y ... $100 = 90 degrees, $400 = full turn
 *   +06 +07   target y<8:1> / x<8:1>: home spot when homing (bit 6 of +13),
 *             or the y at which a dive ends (bit 5 of +13)
 *   +08 +09   pointer to the flight-path data (sub CPU address space)
 *   +0A +0B   speed nibbles; even frames move by +0B, odd frames by +0A
 *   +0C       signed turn rate added to the heading each frame
 *   +0D       frames left in the current path segment
 *   +0E       bomb countdown; +0F bomb-enable bits, one shifted out per drop
 *   +10       object index (into $8800 status, $8B00/$9300/$9B00 sprites)
 *   +11 +12   home-spot x / y offset added to the sprite (formation sway)
 *   +13       flags: bit 0 slot active, bit 5 dive in progress, bit 6
 *             homing, bit 7 mirrored path (turns and table picks negated)
 *
 * FLIGHT-PATH DATA. A path is a byte string in the sub ROM (or anywhere the
 * pointer leads). When +0D runs out, the next entry is read:
 *
 *   token < $EF   a 3-byte segment: token = speed nibbles (low -> +0A,
 *                 high -> +0B), then the turn rate (negated when mirrored)
 *                 -> +0C, then the duration -> +0D
 *   token >= $EF  a command: ~token (0..16) indexes the jump table at $0920
 *                 (d_0920_jp_tbl). Commands take inline operands, and either
 *                 read the next entry at once, or end this frame's work.
 *
 * Each frame the heading turns by +0C, the sprite code and flip bits are
 * derived from the heading (24 rotation steps of 15 degrees), and the
 * position advances along the heading by the speed: the component nearer
 * the heading's axis gets the full speed, the other speed * sin/cos
 * approximated linearly by the fraction of the quadrant (c_0E97).
 */

import { SUB_AT, subAt } from './routines.js';
import { subRom, romWord } from '../romdata.js';

/**
 * @typedef {import('../../machine/machine.js').Machine} Machine
 * @typedef {{ ix: number, hl: number }} MotionRegs
 *   IX: the slot being processed; HL: the flight-path data pointer
 */

// Where a jump-table command continues ($090E, $0BFF, $0B8B, $0B8C, $0DFF).
/** j_090E_flite_path_init: read the next token at HL. */
export const K_TOKEN = 0;
/** l_0BFF_flite_pth_skip_load: store HL in +08/+09, then move this frame. */
export const K_SKIPLOAD = 1;
/** l_0B8B: HL += 1, store it, +0D += 1, done with this slot for the frame. */
export const K_FINAL = 2;
/** l_0B8C: store HL, +0D += 1, done with this slot for the frame. */
export const K_FINAL_NOINC = 3;
/** next__pool_idx: done with this slot for the frame. */
export const K_NEXT = 4;

/** One context object for the whole runner: no allocation per slot. */
const ctx = { ix: 0, hl: 0 };

/** @param {number} v 8-bit rotate right @returns {number} */
const rotr8 = (v) => ((v >> 1) | (v << 7)) & 0xff;

// ---------------------------------------------------------------- math

/**
 * HL = HL / A: 17 rounds of restoring division, bit for bit as the Z80
 * does them (the quotient is 16 bits, the remainder is left in A).
 * @see galaga-sub.asm $0EAE (c_0EAA)
 * @param {Machine} _m
 * @param {{ a: number, hl: number }} regs
 * @returns {{ hl: number, a: number }} quotient and remainder
 */
export function c_0EAA(_m, { a, hl }) {
  const c = a & 0xff;
  let acc = 0; // A, cleared with the carry by `xor a`
  let cf = 0;
  let q = hl & 0xffff;
  for (let b = 0x11; b > 0; b -= 1) {
    const t = (acc << 1) | cf; // 0EB3: adc a,a
    if (t > 0xff) {
      acc = (t - c) & 0xff; // 0EC1: sub c / scf
      cf = 1;
    } else if (t < c) {
      acc = t; // cp c / jr c -> ccf turns the borrow into a 0 bit
      cf = 0;
    } else {
      acc = t - c; // sub c, no borrow -> ccf makes it a 1 bit
      cf = 1;
    }
    const r = (q << 1) | cf; // 0EBB: adc hl,hl -- carry out feeds adc a,a
    q = r & 0xffff;
    cf = r >> 16;
  }
  return { hl: q, a: acc };
}

/**
 * HL = HL * A (shift-and-add; only L is non-zero at the one call site).
 * @see galaga-sub.asm $0E9B (c_0E97)
 * @param {Machine} _m
 * @param {{ a: number, hl: number }} regs
 * @returns {{ hl: number }}
 */
export function c_0E97(_m, { a, hl }) {
  return { hl: (hl * (a & 0xff)) & 0xffff };
}

/**
 * Heading from a point to a target: H = y, L = x of the object, D = y,
 * E = x of the target (all <8:1> integer parts). Returns HL = octant in
 * bits 10:8 and the position within the octant in bits 7:0, which the
 * callers shift right once into the 10-bit angle of +04/+05.
 *
 * The octant comes from the signs of dx, dy and which of |dx|, |dy| is
 * larger; the fraction is min/max * 256 (an arctangent approximated as a
 * straight line), mirrored in odd octants so the angle grows steadily.
 * @see galaga-sub.asm $0E5F (c_0E5B)
 * @param {Machine} m
 * @param {{ de: number, hl: number }} regs
 * @returns {{ hl: number }}
 */
export function c_0E5B(m, { de, hl }) {
  const d = (de >> 8) & 0xff;
  const e = de & 0xff;
  const h = (hl >> 8) & 0xff;
  const l = hl & 0xff;
  // dx = E - L; B<0> set (and dx negated) when it borrows.
  let b = 0;
  let c = (e - l) & 0xff;
  if (e < l) { b = 1; c = (l - e) & 0xff; }
  // dy = D - H; when it borrows B becomes (B ^ 1) | 2 and dy is negated.
  let a = (d - h) & 0xff;
  if (d < h) { b = (b ^ 1) | 2; a = (h - d) & 0xff; }
  // 0E7A: cp c / rla / xor b / rra / ccf / rl b -- shift into B a bit that
  // is 1 when (|dy| < |dx|) equals B<0>, i.e. the third octant bit.
  const lt = a < c ? 1 : 0;
  b = ((b << 1) | ((lt ^ (b & 1)) ^ 1)) & 0xff;
  // Put the smaller of |dx|, |dy| in C and the larger in A.
  if (lt) { const t = c; c = a; a = t; }
  const q = c_0EAA(m, { a, hl: c << 8 }).hl;
  let lo = q & 0xff;
  if ((((q >> 8) ^ b) & 1) !== 0) lo = ~lo & 0xff;
  return { hl: (b << 8) | lo };
}

// ------------------------------------------------------ jump-table cases

/**
 * Slot byte helpers: IX-relative read and write.
 * @param {Machine} m @param {number} ix @param {number} o
 */
const rd = (m, ix, o) => m.peek(ix + o);
/** @param {Machine} m @param {number} ix @param {number} o @param {number} v */
const wr = (m, ix, o, v) => m.poke(ix + o, v);

/**
 * Token $F5: set the object's status to 3 (flying in a convoy) and read the
 * next token.
 * @see galaga-sub.asm $0942
 * @param {Machine} m @param {MotionRegs} r @returns {number} continuation
 */
export function case_0942(m, r) {
  m.poke(0x8800 + rd(m, r.ix, 0x10), 0x03);
  r.hl = (r.hl + 1) & 0xffff;
  return K_TOKEN;
}

/**
 * Tokens $EF / $F0 with a pointer operand: when the stage parameter
 * ($99C9 for $EF "continuous bombing", $99C8 for $F0) is set, jump to the
 * pointer; else skip it. Either way the slot waits a frame.
 * @param {Machine} m @param {MotionRegs} r @param {number} flag
 * @returns {number}
 */
function condJump(m, r, flag) {
  if (m.peek(flag) !== 0) {
    r.hl = m.read16('sub', (r.hl + 1) & 0xffff); // 095B
    return K_FINAL_NOINC; // jp l_0B8C
  }
  r.hl = (r.hl + 2) & 0xffff; // 0963
  return K_FINAL;
}

/**
 * Token $EF: conditional jump on ds_new_stage_parms[9] ($99C9).
 * @see galaga-sub.asm $094E
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_094E(m, r) { return condJump(m, r, 0x99c9); }

/**
 * Token $F0: conditional jump on ds_new_stage_parms[8] ($99C8).
 * @see galaga-sub.asm $0955
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_0955(m, r) { return condJump(m, r, 0x99c8); }

/**
 * Token $F1: diving attacks stop; set y to the home row's origin + $20.
 * @see galaga-sub.asm $0968
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_0968(m, r) {
  const row = subRom(0x0100 + rd(m, r.ix, 0x10)); // sprt_fmtn_hpos row index
  wr(m, r.ix, 0x01, m.peek(0x9900 + ((row + 1) & 0xff)) + 0x20);
  return K_FINAL;
}

/**
 * Token $F2 + pointer: the yellow "special attack" leader splits off a
 * bonus bee. Needs an inactive object among $38-$3E and a free slot; the
 * new slot copies position and heading, flies the operand path and gets
 * the new object in status 9. The leader then continues after the operand.
 * @see galaga-sub.asm $097B
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_097B(m, r) {
  const ix = r.ix;
  const hl0 = r.hl;
  const e = rd(m, ix, 0x10); // the leader
  // Find an inactive transient object ($80 in its status).
  let obj = -1;
  for (let l = 0x38, b = 4; b > 0; b -= 1, l += 2) {
    if (m.peek(0x8800 + l) & 0x80) { obj = l; break; }
  }
  if (obj >= 0) {
    // 098F: the clone gets the leader's sprite code and colour.
    m.poke(0x8b00 + obj, m.peek(0x8b00 + e));
    m.poke(0x8b00 + obj + 1, m.peek(0x8b00 + ((e + 1) & 0xff)));
    // 099B: find a free slot, searching from the last one down.
    let slot = -1;
    for (let p = 0x91ef, b = 0x0c; b > 0; b -= 1, p -= 0x14) {
      if ((m.peek(p) & 1) === 0) { slot = p - 0x13; break; }
    }
    if (slot >= 0) {
      const iy = slot;
      // 09BC: ldir 6 bytes: position and heading.
      for (let i = 0; i < 6; i += 1) m.poke(iy + i, m.peek(ix + i));
      // 09C1-09C9: meant to copy +0C..+0F as well, but `add hl,de` (not
      // `add hl,bc`) leaves DE = IX + IY + $12, an address in the sub ROM
      // ($2218 and up), so the second ldir writes nowhere. Not ported.
      wr(m, iy, 0x13, rd(m, ix, 0x13));
      wr(m, iy, 0x08, m.read('sub', (hl0 + 1) & 0xffff));
      wr(m, iy, 0x09, m.read('sub', (hl0 + 2) & 0xffff));
      wr(m, iy, 0x0a, 0x01);
      wr(m, iy, 0x0b, 0x02);
      wr(m, iy, 0x0d, 0x01);
      wr(m, iy, 0x10, obj);
      m.poke(0x8800 + obj, 0x09);
      m.poke(0x8800 + obj + 1, iy & 0xff);
    }
  }
  // Success (09F6) and failure (09FA) both skip token and pointer.
  r.hl = (hl0 + 3) & 0xffff;
  return K_TOKEN;
}

/**
 * Token $F3 + 8-byte table: a red alien picks how long to keep its current
 * course from the horizontal distance to the fighter: index =
 * clamp(((fighterX/2 - x) / 2, negated if mirrored) + $18, 0, $2F) / 6,
 * and +0D = table[index]. The path resumes after the table.
 * @see galaga-sub.asm $0A01
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_0A01(m, r) {
  const ix = r.ix;
  const flip = m.peek(0x9215);
  let a = m.peek(0x9362); // fighter x, clamped to [$1E, $D1]
  if (a < 0x1e) a = 0x1e;
  if (a >= 0xd1) a = 0xd1;
  if (flip & 1) a = (-(a + 0x0e)) & 0xff;
  // 0A1E: srl a / sub (ix+3) / rra -- a 9-bit signed difference halved.
  a >>= 1;
  const x = rd(m, ix, 0x03);
  const cf = a < x ? 0x80 : 0;
  a = (((a - x) & 0xff) >> 1) | cf;
  if (rd(m, ix, 0x13) & 0x80) a = (-a) & 0xff;
  a = (a + 0x18) & 0xff;
  if (a & 0x80) a = 0; // jp p: still negative -> 0
  if (a >= 0x30) a = 0x2f;
  // 0A38: HL = A:E / 6. E is whatever DE held, but it cannot change H
  // (both 256*A and 1536*n are multiples of 256), and only H is used.
  const idx = c_0EAA(m, { a: 6, hl: a << 8 }).hl >> 8;
  wr(m, ix, 0x0d, m.read('sub', (r.hl + idx + 1) & 0xffff));
  r.hl = (r.hl + 9) & 0xffff;
  // 0A4A: stores the pointer here and again at l_0BFF.
  wr(m, ix, 0x08, r.hl & 0xff);
  wr(m, ix, 0x09, r.hl >> 8);
  return K_SKIPLOAD;
}

/**
 * Token $F4: the capturing boss starts its dive. Aim at the fighter's
 * column (rounded to 8, clamped to [$29, $C9], saved in $928A) at y $48,
 * start cpu0 task f_21CB and record the slot in $9829.
 * @see galaga-sub.asm $0A53
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_0A53(m, r) {
  const ix = r.ix;
  const flip = m.peek(0x9215);
  let a = (((m.peek(0x9362) + 3) & 0xf8) + 1) & 0xff;
  if (a < 0x29) a = 0x29;
  if (a >= 0xca) a = 0xc9;
  if (flip & 1) a = ~(a + 0x0d) & 0xff;
  m.poke(0x928a, a);
  const hl = c_0E5B(m, { de: 0x4800 | (a >> 1), hl: (rd(m, ix, 0x01) << 8) | rd(m, ix, 0x03) }).hl;
  wr(m, ix, 0x04, (hl >> 1) & 0xff); // srl h / rr l
  wr(m, ix, 0x05, hl >> 9);
  m.poke(0x928b, 0);
  m.poke(0x9019, 1);
  m.poke(0x9829, ix & 0xff);
  r.hl = (r.hl + 1) & 0xffff;
  return K_TOKEN;
}

/**
 * Token $FB: head for home. Status 9; fetch the home spot's origin and
 * current offset from the formation tables at $9900 (indexed by the ROM
 * row/column table at $0100), move the fixed-point position by the
 * negated offset (sprite = position + offset, see l_0D03), aim the
 * heading at the origin, store it in +06/+07 and set the homing flag.
 * @see galaga-sub.asm $0AA0
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_0AA0(m, r) {
  const ix = r.ix;
  const obj = rd(m, ix, 0x10);
  m.poke(0x8800 + obj, 0x09);
  const rowIdx = subRom(0x0100 + obj);
  const colIdx = subRom(0x0100 + ((obj + 1) & 0xff));
  let b = m.peek(0x9900 + colIdx); // x offset
  let e = m.peek(0x9900 + ((colIdx + 1) & 0xff)); // x origin
  let c = m.peek(0x9900 + rowIdx); // y offset
  const d = m.peek(0x9900 + ((rowIdx + 1) & 0xff)); // y origin
  e >>= 1;
  const tgt = (d << 8) | e; // pushed: y origin, x origin >> 1
  wr(m, ix, 0x11, b);
  wr(m, ix, 0x12, c);
  if (m.peek(0x9215) !== 0) { b = (-b) & 0xff; c = (-c) & 0xff; }
  // 0ACD: y += sext(C) << 7, i.e. C is added as a 9.7 value.
  let hl = (rd(m, ix, 0x00) | (rd(m, ix, 0x01) << 8)) + (((c << 24) >> 24) * 128);
  hl &= 0xffff;
  wr(m, ix, 0x00, hl & 0xff);
  wr(m, ix, 0x01, hl >> 8);
  const y = hl >> 8;
  // 0AE2: x -= sext(B) << 7 (sbc with the carry left clear by rr c).
  hl = (rd(m, ix, 0x02) | (rd(m, ix, 0x03) << 8)) - (((b << 24) >> 24) * 128);
  hl &= 0xffff;
  wr(m, ix, 0x02, hl & 0xff);
  wr(m, ix, 0x03, hl >> 8);
  const ang = c_0E5B(m, { de: tgt, hl: (y << 8) | (hl >> 8) }).hl;
  wr(m, ix, 0x04, (ang >> 1) & 0xff);
  wr(m, ix, 0x05, ang >> 9);
  wr(m, ix, 0x06, tgt >> 8);
  wr(m, ix, 0x07, tgt & 0xff);
  wr(m, ix, 0x13, rd(m, ix, 0x13) | 0x40);
  r.hl = (r.hl + 1) & 0xffff;
  return K_TOKEN;
}

/**
 * Token $FE + 8-byte table: like $F3 but indexed by the fighter's x in the
 * hardware sprite registers ($93E2; 0 counts as $80), mirrored by flip
 * screen xor the slot's mirror bit, divided by 30. Index 0 reads the token
 * byte itself.
 * @see galaga-sub.asm $0B16
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_0B16(m, r) {
  const ix = r.ix;
  // 0B18: rrca / xor b / rlca -> carry = flip<0> ^ slot<7>.
  const cf = ((m.peek(0x9215) & 1) ^ (rd(m, ix, 0x13) >> 7)) !== 0;
  let a = m.peek(0x93e2);
  if (a === 0) a = 0x80;
  if (!cf) a = ((-a) + 0xf2) & 0xff;
  a = (a + 0x0e) & 0xff;
  // HL = A:E / 30 -> H = floor(A / 30), whatever E is (see case_0A01).
  const idx = c_0EAA(m, { a: 0x1e, hl: a << 8 }).hl >> 8;
  wr(m, ix, 0x0d, m.read('sub', (r.hl + idx) & 0xffff));
  r.hl = (r.hl + 9) & 0xffff;
  return K_SKIPLOAD;
}

/**
 * Token $FD + pointer: unconditional jump in the path data.
 * @see galaga-sub.asm $0B46
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_0B46(m, r) {
  r.hl = m.read16('sub', (r.hl + 1) & 0xffff);
  return K_TOKEN;
}

/**
 * Token $FC + y: a dive that ends at y<8:1> = operand (+06, with +07 = 0):
 * set bit 5, keep the current segment (+0D reaches 0 and wraps, so the
 * segment lasts until the y test at l_0C2D ends it).
 * @see galaga-sub.asm $0B4E
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_0B4E(m, r) {
  const ix = r.ix;
  wr(m, ix, 0x06, m.read('sub', (r.hl + 1) & 0xffff));
  r.hl = (r.hl + 2) & 0xffff;
  wr(m, ix, 0x07, 0x00);
  wr(m, ix, 0x13, rd(m, ix, 0x13) | 0x20);
  return K_SKIPLOAD;
}

/**
 * Token $F9: an alien that looped off the bottom re-enters at the top above
 * its home column: x = home column x ($9800 table) / 2; triggers the dive
 * sound when continuous bombing is on.
 * @see galaga-sub.asm $0B5F
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_0B5F(m, r) {
  const ix = r.ix;
  const flip = m.peek(0x9215);
  const col = subRom(0x0100 + ((rd(m, ix, 0x10) + 1) & 0xff));
  let a = m.peek(0x9800 + col);
  if (flip & 1) a = (-(a + 0x0e)) & 0xff;
  wr(m, ix, 0x03, a >> 1);
  const cb = m.peek(0x92aa);
  if (cb !== 0) m.poke(0x9ab3, cb);
  return K_FINAL;
}

/**
 * Token $F8: move to the top of the screen, y<8:1> = $9C.
 * @see galaga-sub.asm $0B87
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_0B87(m, r) {
  wr(m, r.ix, 0x01, 0x9c);
  return K_FINAL;
}

/**
 * Token $F7 + pointer: transients ($38-$3E) take the jump, others skip it.
 * @see galaga-sub.asm $0B98
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_0B98(m, r) {
  if ((rd(m, r.ix, 0x10) & 0x38) === 0x38) return case_0B46(m, r);
  r.hl = (r.hl + 3) & 0xffff;
  return K_TOKEN;
}

/**
 * Token $F6 + heading: set the heading to operand * 4 (mirrored:
 * -(operand + $80) * 4), restart the bomb countdown at $1E and reload the
 * bomb-enable bits from $92C8.
 * @see galaga-sub.asm $0BA8
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_0BA8(m, r) {
  const ix = r.ix;
  r.hl = (r.hl + 1) & 0xffff;
  let a = m.read('sub', r.hl);
  if (rd(m, ix, 0x13) & 0x80) a = (-(a + 0x80)) & 0xff;
  wr(m, ix, 0x04, (a << 2) & 0xff);
  wr(m, ix, 0x05, a >> 6);
  wr(m, ix, 0x0e, 0x1e);
  wr(m, ix, 0x0f, m.peek(0x92c8));
  return K_FINAL;
}

/**
 * Token $FA + pointer: jump unless continuous bombing ($92AA) is on while
 * cpu0 task f_2000 ($901D) is off -- then skip the pointer.
 * @see galaga-sub.asm $0BD1
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_0BD1(m, r) {
  // 0BD5: ld a,($901D) / dec a / and c -> Z decides.
  if ((((m.peek(0x901d) - 1) & 0xff) & m.peek(0x92aa)) === 0) return case_0B46(m, r);
  r.hl = (r.hl + 3) & 0xffff;
  return K_TOKEN;
}

/**
 * Token $FF (end of path), and objects in an unexpected status: the object
 * becomes inactive ($80), its sprite x 0, and the slot is freed.
 * @see galaga-sub.asm $0E4D (case_0E49_make_object_inactive)
 * @param {Machine} m @param {MotionRegs} r @returns {number}
 */
export function case_0E49_make_object_inactive(m, r) {
  const obj = rd(m, r.ix, 0x10);
  m.poke(0x8800 + obj, 0x80);
  m.poke(0x9300 + obj, 0x00);
  wr(m, r.ix, 0x13, 0x00);
  return K_NEXT;
}

// ------------------------------------------------------------- runner

/**
 * The bug motion runner: cpu1 task [2]. Counts the active slots into
 * $9286 (last frame's count moves to $9287) and advances each one.
 * @see galaga-sub.asm $08D3
 * @param {Machine} m
 */
export function f_08D3(m) {
  m.poke(0x9289, 0x0c);
  const n = m.peek(0x9286);
  m.poke(0x9286, 0);
  m.poke(0x9287, n);
  let ix = 0x9100;
  for (;;) {
    if (m.peek(ix + 0x13) & 1) runSlot(m, ix);
    // next__pool_idx ($0DFF): the loop counter lives in RAM.
    const left = (m.peek(0x9289) - 1) & 0xff;
    m.poke(0x9289, left);
    if (left === 0) return;
    ix = (ix + 0x14) & 0xffff;
  }
}

/**
 * One active slot, $08EB-$0DFE.
 * @param {Machine} m @param {number} ix
 */
function runSlot(m, ix) {
  m.poke(0x9286, m.peek(0x9286) + 1);
  const st = m.peek(0x8800 + rd(m, ix, 0x10));
  if (st !== 0x03 && st !== 0x09 && st !== 0x07) {
    ctx.ix = ix;
    case_0E49_make_object_inactive(m, ctx);
    return;
  }
  // mctl_fltpn_dspchr: count down the segment; at 0 read path data.
  const cnt = (rd(m, ix, 0x0d) - 1) & 0xff;
  wr(m, ix, 0x0d, cnt);
  if (cnt === 0 && !readPath(m, ix)) return;
  flitePathCont(m, ix);
}

/**
 * j_090E_flite_path_init: interpret path data until a segment is loaded
 * (returns true: move this frame) or a command ends the frame (false).
 * @param {Machine} m @param {number} ix @returns {boolean}
 */
function readPath(m, ix) {
  ctx.ix = ix;
  ctx.hl = rd(m, ix, 0x08) | (rd(m, ix, 0x09) << 8);
  for (;;) {
    const t = m.read('sub', ctx.hl);
    if (t < 0xef) {
      // l_0BDC_flite_pth_load: speed nibbles, turn rate, duration.
      wr(m, ix, 0x0a, t & 0x0f);
      wr(m, ix, 0x0b, t >> 4);
      let a = m.read('sub', (ctx.hl + 1) & 0xffff);
      if (rd(m, ix, 0x13) & 0x80) a = (-a) & 0xff;
      wr(m, ix, 0x0c, a);
      wr(m, ix, 0x0d, m.read('sub', (ctx.hl + 2) & 0xffff));
      ctx.hl = (ctx.hl + 3) & 0xffff;
      storePtr(m, ix, ctx.hl);
      return true;
    }
    // 0914: cpl / rst $08 into d_0920_jp_tbl, then `ex (sp),hl / ret`.
    const k = subAt(romWord('sub', 0x0920 + (((~t) & 0xff) << 1)))(m, ctx);
    switch (k) {
      case K_TOKEN: break;
      case K_SKIPLOAD: storePtr(m, ix, ctx.hl); return true;
      case K_FINAL:
        ctx.hl = (ctx.hl + 1) & 0xffff;
      // falls through: l_0B8B is inc hl then l_0B8C
      case K_FINAL_NOINC:
        storePtr(m, ix, ctx.hl);
        wr(m, ix, 0x0d, rd(m, ix, 0x0d) + 1);
        return false;
      default: return false; // K_NEXT
    }
  }
}

/** l_0BFF: +08/+09 = HL. @param {Machine} m @param {number} ix @param {number} hl */
function storePtr(m, ix, hl) {
  wr(m, ix, 0x08, hl & 0xff);
  wr(m, ix, 0x09, hl >> 8);
}

/**
 * l_0C05_flite_pth_cont: home test, dive-end test, turn, sprite code and
 * flip, one step of movement, then l_0D03 (sprite position, bombs).
 * @param {Machine} m @param {number} ix
 */
function flitePathCont(m, ix) {
  // Homing: home when y and x are both within one of the target.
  // `jp p` / `neg` take the absolute value of the 8-bit difference.
  if (rd(m, ix, 0x13) & 0x40) {
    const dy = (rd(m, ix, 0x01) - rd(m, ix, 0x06)) & 0xff;
    if (dy === 0 || dy === 1 || dy === 0xff) {
      const dx = (rd(m, ix, 0x03) - rd(m, ix, 0x07)) & 0xff;
      if (dx === 0 || dx === 1 || dx === 0xff) { imHome(m, ix); return; }
    }
  }
  // Dive in progress: when y reaches +06 (or +06 - 1), expire next frame.
  const f13 = rd(m, ix, 0x13);
  if (f13 & 0x20) {
    const dy = (rd(m, ix, 0x01) - rd(m, ix, 0x06)) & 0xff;
    if (dy === 0 || dy === 0xff) {
      wr(m, ix, 0x0d, 0x01);
      wr(m, ix, 0x13, rd(m, ix, 0x13) & ~0x20);
    }
  }

  // 0C46: heading += turn rate as a 16-bit signed add on +04/+05. The
  // high byte moves by +-1 when the carry out of the low byte disagrees
  // with the sign of the rate (`rra / xor b` puts carry ^ sign in S).
  const rate = rd(m, ix, 0x0c);
  const e = rd(m, ix, 0x04); // heading before the turn: used below
  const sum = e + rate;
  wr(m, ix, 0x04, sum & 0xff);
  const d = rd(m, ix, 0x05);
  let hi = d;
  if (((sum >> 8) ^ (rate >> 7)) & 1) hi = (d + ((rate & 0x80) ? 0xff : 0x01)) & 0xff;
  wr(m, ix, 0x05, hi);

  // Sprite code from the old heading: within a quadrant, fold odd
  // quadrants, then 24 steps per turn -> ~42 angle units a step:
  // code = ((a + $15) * 3/4) >> 5; wrapping past $FF means "vertical", 6.
  const obj = rd(m, ix, 0x10);
  let a = (d & 1) ? (~e & 0xff) : e;
  a += 0x15;
  let code;
  if (a > 0xff) code = 6;
  else {
    a >>= 1;
    code = ((a + (a >> 1)) >> 5) & 7; // srl / add / rlca x3 / and 7
  }
  m.poke(0x8b00 + obj, (m.peek(0x8b00 + obj) & 0xf8) | code);
  // Flip bits from the quadrant (0C8B): bit 0 = q0 ^ q1 ^ 1 carry trick,
  // computed literally: a = (c ^ rrc c) + 1, rla with q1.
  const c1 = rotr8(d);
  m.poke(0x9b00 + obj, ((((d ^ c1) + 1) << 1) | (c1 & 1)) & 0x03);

  // 0C98: even frames use speed +0B, odd frames +0A. 0 = no movement.
  const speed = (m.peek(0x92a0) & 1) ? rd(m, ix, 0x0a) : rd(m, ix, 0x0b);
  if (speed !== 0) move(m, ix, speed, d, e);
  posnSet(m, ix, obj);
}

/**
 * $0CAB-$0D02: one step along the old heading (quadrant bits D<1:0>,
 * fraction E). The octant (quadrant * 2 + E<7>) picks the "primary" axis
 * (the one the heading is closer to): it moves by +-speed; the other axis
 * by +-speed * f / 128 where f is the distance of the heading from that
 * axis within the octant (L = E<6:0>, mirrored when E<7> is set).
 * Coordinates are 9.7 fixed point, so a pixel step is 128.
 * @param {Machine} m @param {number} ix @param {number} speed
 * @param {number} d old +05 @param {number} e old +04
 */
function move(m, ix, speed, d, e) {
  const d3 = d & 3;
  const oct = (d3 << 1) | (e >> 7); // rlc e / rl d
  // xor d / rrca: an odd (quadrant<0> ^ E<7>) keeps y (+00), else x (+02).
  let p = ix;
  if (((d3 ^ oct) & 1) === 0) p = (p & 0xff00) | ((p + 2) & 0xff);
  // 0CBF: primary component negated for octants 3..6 (135-315 degrees).
  let a = speed;
  if (((oct + 1) & 4) !== 0) a = (-a) & 0xff;
  // 0CC7: word += sext(A) << 7, as sra c / add $80 / adc.
  let cf = 0;
  if (a & 1) {
    const lo = m.peek(p) + 0x80;
    m.poke(p, lo);
    cf = lo >> 8;
  }
  const p1 = (p & 0xff00) | ((p + 1) & 0xff);
  m.poke(p1, m.peek(p1) + ((a >> 1) | (a & 0x80)) + cf);
  // Secondary component on the other axis (E ^ 2).
  const q = (p & 0xff00) | ((p & 0xff) ^ 0x02);
  let l = e & 0x7f;
  if (e & 0x80) l ^= 0x7f;
  let prod = c_0E97(m, { a: speed, hl: l }).hl;
  // 0CEA: negated for octants whose (oct ^ 2) - 1 has bit 2 set.
  if ((((oct ^ 2) - 1) & 4) !== 0) prod = (-prod) & 0xffff;
  const lo = m.peek(q) + (prod & 0xff);
  m.poke(q, lo);
  const q1 = (q & 0xff00) | ((q + 1) & 0xff);
  m.poke(q1, m.peek(q1) + (prod >> 8) + (lo >> 8));
}

/**
 * l_0D03_flite_pth_posn_set: sprite x/y from the fixed-point position
 * (plus the formation offset when homing, and screen flip), then the bomb
 * logic.
 *
 * x = x<8:0> (the 9-bit integer part, bit 8 dropped), flipped: ~(x + $0D).
 * y is 9 bits: sprite y<7:0> in $9301+obj, y<8> in bit 0 of $9B01+obj.
 * Unflipped y = ~((y<8:1> + $4F) : ~y<0>) -- the screen counts up.
 * @param {Machine} m @param {number} ix @param {number} obj
 */
function posnSet(m, ix, obj) {
  const flip = m.peek(0x9215) & 1;
  const homing = rd(m, ix, 0x13) & 0x40;
  // x: `cp (ix+2)` against $7F copies +02<7> into carry, `rla` shifts it in.
  let a = ((rd(m, ix, 0x03) << 1) | (rd(m, ix, 0x02) >> 7)) & 0xff;
  if (flip) a = ~(a + 0x0d) & 0xff;
  if (homing) a = (a + rd(m, ix, 0x11)) & 0xff;
  m.poke(0x9300 + obj, a);

  // y: E<0> carries y<0>, A holds y<8:1>, until rla assembles y<7:0>.
  const l1 = (obj + 1) & 0xff;
  let e0 = rd(m, ix, 0x00) >> 7;
  a = rd(m, ix, 0x01);
  if (!flip) { a = ~(a + 0x4f) & 0xff; e0 ^= 1; } // cpl / dec e
  let y8 = a >> 7; // rr e / rla / rl e: bit 8 into E<0>
  a = ((a << 1) | e0) & 0xff;
  if (homing) {
    // 0D43: 9-bit add of the signed offset; bit 8 toggles when the
    // carry disagrees with the offset's sign.
    const off = rd(m, ix, 0x12);
    const s = a + off;
    if (((s >> 8) ^ (off >> 7)) & 1) y8 ^= 1;
    a = s & 0xff;
  }
  m.poke(0x9300 + l1, a);
  // rrc (hl) / rrc e / rl (hl): replace bit 0 of the control byte.
  m.poke(0x9b00 + l1, (m.peek(0x9b00 + l1) & 0xfe) | y8);

  bombs(m, ix, obj);
}

/**
 * $0D59-$0DFE: bomb drop. When the countdown +0E runs out, the next enable
 * bit is shifted out of +0F; a bomb drops if it was set, the alien is low
 * enough (y<8:1> >= $4C), the fighter is in play ($9015) and the capture
 * timer $92AD is idle, and a bomb object ($68-$76) is free. The bomb starts
 * at the alien with a horizontal rate in $92B0 aimed at the fighter.
 * Either way the countdown restarts from $92E2.
 * @param {Machine} m @param {number} ix @param {number} obj
 */
function bombs(m, ix, obj) {
  const cnt = (rd(m, ix, 0x0e) - 1) & 0xff;
  wr(m, ix, 0x0e, cnt);
  if (cnt !== 0) return;
  const f = rd(m, ix, 0x0f);
  wr(m, ix, 0x0f, f >> 1);
  if ((f & 1) && rd(m, ix, 0x01) >= 0x4c && m.peek(0x9015) !== 0 && m.peek(0x92ad) === 0) {
    let l = 0x68;
    let b = 8;
    for (; b > 0; b -= 1, l += 2) if (m.peek(0x8800 + l) === 0x80) break;
    if (b > 0) dropBomb(m, obj, l);
  }
  wr(m, ix, 0x0e, m.peek(0x92e2));
}

/**
 * $0D8D: launch bomb object `l` from alien `obj`.
 * @param {Machine} m @param {number} obj @param {number} l
 */
function dropBomb(m, obj, l) {
  m.poke(0x8800 + l, 0x06);
  m.poke(0x9b00 + l, 0x01);
  const o1 = (obj + 1) & 0xff;
  const l1 = (l + 1) & 0xff;
  const bx = m.peek(0x9300 + obj);
  m.poke(0x9300 + l, bx);
  const by = m.peek(0x9300 + o1);
  m.poke(0x9300 + l1, by);
  const y8 = m.peek(0x9b00 + o1) & 1;
  m.poke(0x9b00 + l1, (m.peek(0x9b00 + l1) & 0xfe) | y8);
  const yh = (by >> 1) | (y8 << 7); // y<8:1>
  // |dx| to the fighter; the borrow says which side it is on.
  const fx = m.peek(0x9362);
  const left = fx < bx ? 1 : 0;
  const dx = left ? (bx - fx) & 0xff : (fx - bx) & 0xff;
  // |dy| to the fighter's row ($95, or $1C flipped).
  const ry = m.peek(0x9215) !== 0 ? 0x1c : 0x95;
  const dy = ry < yh ? (yh - ry) & 0xff : (ry - yh) & 0xff;
  // HL = dx:L / dy, L being the low byte of &bomb.ctrl.b1 left in HL.
  const q = c_0EAA(m, { a: dy, hl: (dx << 8) | l1 }).hl;
  // rate = (q/4 + q) / 4 = q * 5/16, capped at $60.
  const t = ((((q >> 2) + q) & 0xffff) >> 2);
  let rate = t >> 8 ? 0x60 : t & 0xff;
  if (rate >= 0x60) rate = 0x60;
  // rr b: halve, the side (carry of fighter.x - bomber.x) into bit 7.
  rate = (rate >> 1) | (left << 7);
  const p = 0x92b0 + ((l + 8) & 0x0f);
  m.poke(p, rate);
  m.poke(p + 1, 0x00);
}

/**
 * l_0E08_imhome ($0E0C): the alien reached its home spot. Free the slot,
 * status 2 (rotating into formation), restore a bonus-bee colour, snap to
 * the target, and finish the frame at l_0D03.
 * @param {Machine} m @param {number} ix
 */
function imHome(m, ix) {
  wr(m, ix, 0x13, rd(m, ix, 0x13) & 0xfe);
  wr(m, ix, 0x00, 0);
  wr(m, ix, 0x02, 0);
  const obj = rd(m, ix, 0x10);
  m.poke(0x8800 + obj, 0x02);
  const o1 = (obj + 1) & 0xff;
  // Colours 4..6 ((colour + 1) & 7 >= 5): a bonus bee coming home takes
  // the colour saved in $982E.
  if (((m.peek(0x8b00 + o1) + 1) & 7) >= 5) {
    const c = m.peek(0x982e);
    m.poke(0x8b00 + obj, (c & 0xf8) + 6);
    m.poke(0x8b00 + o1, c & 7);
    m.poke(0x982d, 1);
  }
  wr(m, ix, 0x01, rd(m, ix, 0x06));
  wr(m, ix, 0x03, rd(m, ix, 0x07));
  posnSet(m, ix, obj);
}

/** d_0920_jp_tbl targets, token $FF first. */
export const MOTION_CASES = Object.freeze({
  0x0e4d: case_0E49_make_object_inactive,
  0x0b16: case_0B16,
  0x0b46: case_0B46,
  0x0b4e: case_0B4E,
  0x0aa0: case_0AA0,
  0x0bd1: case_0BD1,
  0x0b5f: case_0B5F,
  0x0b87: case_0B87,
  0x0b98: case_0B98,
  0x0ba8: case_0BA8,
  0x0942: case_0942,
  0x0a53: case_0A53,
  0x0a01: case_0A01,
  0x097b: case_097B,
  0x0968: case_0968,
  0x0955: case_0955,
  0x094e: case_094E,
});

Object.assign(SUB_AT, MOTION_CASES);
