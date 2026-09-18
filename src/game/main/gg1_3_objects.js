// Copyright 2026 by Moshix
/**
 * gg1-3 $23DD-$25A1: the object-status manager.
 *
 * b_8800[0..$7F] holds one 2-byte record per object (even byte = state,
 * odd byte = motion-queue slot offset or a counter); the sprite code, posn
 * and ctrl tables at $8B00, $9300 and $9B00 use the same offsets. c_23E0
 * walks half of the objects on each odd frame (offsets 0,4,8.. on frame%4 == 1
 * and 2,6,10.. on frame%4 == 3), runs a handler per state through the jump
 * table d_23FF_jp_tbl, and counts active objects; on frame%4 == 2 the count
 * is published to b_bugs_actv_nbr ($92A7).
 *
 * @see reference/galaga-main.asm $23DD-$25A1
 * @see reference/neiderm/galag/galagao_ASxxx/rom0/gg1-3.s
 */

import { romByte, romWord } from '../romdata.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/** Rev. B address of the state handler jump table. */
const D_23FF_JP_TBL = 0x23ff;

/**
 * Where a handler continues: the three exits of the handlers.
 *   L2413  dec e, then as L2414 (handlers that advanced E to the odd byte)
 *   L2414  count the object as active, then as L2416
 *   L2416  next object (E += 4)
 */
const L2413 = 0x2413;
const L2414 = 0x2414;
const L2416 = 0x2416;

/**
 * Periodic task (never disabled): c_23E0 with the frame counter.
 * @see galaga-main.asm $23DD
 * @param {Machine} m
 */
export function f_23DD(m) {
  c_23E0(m, { a: m.peek(0x92a0) });
}

/**
 * Update half of the objects (odd A) or publish the active-object count
 * (A % 4 == 2). Called with a forced A by f_1D32 at player changeover.
 * @see galaga-main.asm $23E0
 * @param {Machine} m
 * @param {{ a: number }} regs  A = frame counter (only bits 0-1 matter)
 */
export function c_23E0(m, regs) {
  const a = regs.a & 0xff;
  if ((a & 0x01) === 0) {
    // l_2596_even_frame: on frame%4 == 2 move the count to b_bugs_actv_nbr
    if ((a & 0x02) === 0) return;
    const n = m.peek(0x92a6);
    m.poke(0x92a6, 0);
    m.poke(0x92a7, n);
    return;
  }

  let e = a & 0x02;
  let count = m.peek(0x92a6); // IXL: running count of active objects
  for (let b = 0x20; b > 0; b -= 1) {
    const state = m.peek(0x8800 | e);
    let next = L2416;
    // 0x23F2: sla a / jr c -- bit 7 set means inactive
    if ((state & 0x80) === 0) {
      // 0x23F6: dispatch through the ROM jump table, index 2*state
      const target = romWord('main', D_23FF_JP_TBL + ((state << 1) & 0xff));
      next = HANDLERS[target](m, e);
    }
    // The handlers leave E pointing at the even byte except via L2413,
    // whose "dec e" undoes their "inc e"; the port never moved E there.
    if (next !== L2416) count = (count + 1) & 0xff;
    e = (e + 4) & 0xff;
  }
  m.poke(0x92a6, count);
}

/**
 * Handlers by their rev. B address (the jump table's targets). Each gets
 * E (the object's even offset) and returns where the Z80 continues.
 * @type {Record<number, (m: Machine, e: number) => number>}
 */
const HANDLERS = {
  // 0 (placeholder entry): nothing to do, not counted
  [L2416]: () => L2416,
  0x2422: case_2422,
  0x243c: case_243C,
  0x245f: case_245F,
  0x2488: case_2488,
  0x24b2: case_24B2,
  0x2535: case_2535,
  0x254d: case_254D,
  0x2590: case_2590,
};

/**
 * 09: diving. Copy the formation's current X/Y offsets for this object's
 * home position (db_obj_home_posn_rc at ROM $0100 gives row and column
 * indices into ds_hpos_loc_offs $9900) into its motion queue slot (+$11/$12).
 * @see galaga-main.asm $2422
 * @param {Machine} m @param {number} e @returns {number}
 */
function case_2422(m, e) {
  const row = romByte('main', 0x0100 | e);
  const col = romByte('main', 0x0100 | ((e + 1) & 0xff));
  const x = m.peek(0x9900 | col);
  const y = m.peek(0x9900 | row);
  const slot = m.peek(0x8800 | ((e + 1) & 0xff));
  const l = (slot + 0x11) & 0xff;
  m.poke(0x9100 | l, x);
  m.poke(0x9100 | ((l + 1) & 0xff), y);
  return L2413;
}

/**
 * 08: the player's fighter exploding. The odd byte counts down from $0F;
 * every 4 counts the sprite code advances by 4; at 0 the sprite is removed.
 * @see galaga-main.asm $243C
 * @param {Machine} m @param {number} e @returns {number}
 */
function case_243C(m, e) {
  const odd = 0x8800 | ((e + 1) & 0xff);
  const a = (m.peek(odd) - 1) & 0xff;
  if (a === 0) {
    // l_2451
    m.poke(0x9300 | e, 0);
    m.poke(0x9b00 | e, 0);
    m.poke(0x8800 | e, 0x80);
    return L2416;
  }
  m.poke(odd, a);
  if ((a & 0x03) === 0) m.poke(0x8b00 | e, m.peek(0x8b00 | e) + 4);
  return L2416;
}

/**
 * 02: arrived home, rotating to upright: sprite code low bits step toward
 * 6 (or toward 0 when X-flipped, then the flip is cleared); at 6 the state
 * becomes 01. Then the sprite is placed at its home position.
 * @see galaga-main.asm $245F
 * @param {Machine} m @param {number} e @returns {number}
 */
function case_245F(m, e) {
  const code = 0x8b00 | e;
  if ((m.peek(0x9b00 | e) & 0x01) === 0) {
    if ((m.peek(code) & 0x07) === 6) m.poke(0x8800 | e, 0x01); // l_2483
    else m.poke(code, m.peek(code) + 1);
  } else if ((m.peek(code) & 0x07) === 0) {
    m.poke(0x9b00 | e, m.peek(0x9b00 | e) & 0xfe); // res 0,(hl)
  } else {
    m.poke(code, m.peek(code) - 1); // l_2480
  }
  return l_249B(m, e);
}

/**
 * 01: resting in the formation. Flap: bit 0 of the sprite code follows bit 1
 * of the 4 Hz timer ($92A2); then, if the enemy-update flag $920B is set,
 * track the (moving) home position.
 * @see galaga-main.asm $2488
 * @param {Machine} m @param {number} e @returns {number}
 */
function case_2488(m, e) {
  const code = 0x8b00 | e;
  const t = m.peek(0x92a2);
  // 0x248E: rrc (hl) -- written back, then rl (hl) with the carry that
  // rrca / rrca leaves (bit 1 of the timer) goes into bit 0.
  const v = m.peek(code);
  const r = ((v >> 1) | (v << 7)) & 0xff;
  m.poke(code, r);
  const cy = (t >> 1) & 0x01;
  m.poke(code, ((r << 1) | cy) & 0xff);
  if (m.peek(0x920b) === 0) return L2414;
  return l_249B(m, e);
}

/**
 * $249B: sprite position from the home position tables: X from
 * ds_hpos_spcoords[col], Y from ds_hpos_spcoords[row], Y bit 8 from
 * ds_hpos_spcoords[row + 1] ($9800).
 * @param {Machine} m @param {number} e @returns {number}
 */
function l_249B(m, e) {
  const row = romByte('main', 0x0100 | e);
  const col = romByte('main', 0x0100 | ((e + 1) & 0xff));
  const e1 = (e + 1) & 0xff;
  m.poke(0x9300 | e, m.peek(0x9800 | col));
  m.poke(0x9300 | e1, m.peek(0x9800 | row));
  m.poke(0x9b00 | e1, m.peek(0x9800 | ((row + 1) & 0xff)));
  return L2413;
}

/**
 * 04: shot, exploding. The odd byte steps $40..$45 and is also the sprite
 * code (the last one shown as $48); at $44 the 32x32 explosion sprite is
 * re-centred (posn - 8, double size ctrl $0C). At $45 the object ends, or
 * shows a bonus score sprite if b_9200_obj_collsn_notif[] holds one.
 * @see galaga-main.asm $24B2
 * @param {Machine} m @param {number} e @returns {number}
 */
function case_24B2(m, e) {
  let l = e;
  const odd = 0x8800 | ((e + 1) & 0xff);
  let a = m.peek(odd);
  if (a === 0x45) return l_24E6(m, e);
  a = (a + 1) & 0xff;
  m.poke(odd, a);
  if (a === 0x45) a = 0x48;
  if (a === 0x44) {
    const px = 0x9300 | l;
    m.poke(px, m.peek(px) - 8);
    l = (l + 1) & 0xff;
    const y = m.peek(0x9300 | l);
    m.poke(0x9300 | l, y - 8);
    // 0x24D2: jr nc -- a borrow out of the low 8 bits flips bit 8
    if (y < 8) m.poke(0x9b00 | l, m.peek(0x9b00 | l) ^ 0x01);
    l = (l - 1) & 0xff;
    m.poke(0x9b00 | l, 0x0c);
  }
  m.poke(0x8b00 | l, a);
  return L2416;
}

/**
 * $24E6: explosion finished.
 * @param {Machine} m @param {number} e @returns {number}
 */
function l_24E6(m, e) {
  let l = e;
  const a = m.peek(0x9200 | l);
  if (a === 0x01) {
    m.poke(0x9300 | l, 0);
    m.poke(0x9b00 | l, 0);
    m.poke(0x8800 | l, 0x80);
    return L2416;
  }
  // l_24FD: A is the score sprite code ($35-$3D): colour $0D for >= $37,
  // $0E for >= $3A; codes < $3B are 16x16 and get re-centred by 8 in X.
  m.poke(0x8b00 | l, a);
  if (a >= 0x37) {
    const c = a < 0x3a ? 0x0d : 0x0e;
    m.poke(0x8b00 | ((l + 1) & 0xff), c);
  }
  let c = 0x08;
  if (a < 0x3b) {
    c = 0x00;
    m.poke(0x9300 | l, m.peek(0x9300 | l) + 8);
  }
  l = (l + 1) & 0xff;
  const y = m.peek(0x9300 | l);
  m.poke(0x9300 | l, y + 8);
  // 0x2523: jr nc -- carry out of the Y add flips bit 8
  if (y + 8 > 0xff) m.poke(0x9b00 | l, m.peek(0x9b00 | l) ^ 0x01);
  l = (l - 1) & 0xff;
  m.poke(0x9b00 | l, c);
  m.poke(0x8800 | l, 0x05);
  m.poke(0x8800 | ((l + 1) & 0xff), 0x13); // score display time
  return L2416;
}

/**
 * 05: showing a score sprite; count down and remove.
 * @see galaga-main.asm $2535
 * @param {Machine} m @param {number} e @returns {number}
 */
function case_2535(m, e) {
  const odd = 0x8800 | ((e + 1) & 0xff);
  const v = (m.peek(odd) - 1) & 0xff;
  m.poke(odd, v);
  if (v !== 0) return L2416;
  m.poke(0x8800 | e, 0x80);
  m.poke(0x9300 | e, 0);
  m.poke(0x9b00 | e, 0);
  m.poke(0x8800 | e, 0x80); // 0x2547: written again
  return L2416;
}

/**
 * 03 (flying bug) or 06 (bomb): retire it once off screen, reading the
 * hardware position registers at $9380+ ($9300 + E + $80).
 * Bugs still on screen are counted active; bombs are not.
 * @see galaga-main.asm $254D
 * @param {Machine} m @param {number} e @returns {number}
 */
function case_254D(m, e) {
  const l = e | 0x80;
  let off = m.peek(0x9300 | l) >= 0xf4;
  if (!off) {
    const l1 = (l + 1) & 0xff;
    // 0x255D: rrca / rra -- 9-bit Y (bit 8 in ctrl) halved
    const y = ((m.peek(0x9300 | l1) >> 1) | ((m.peek(0x9b00 | l1) & 0x01) << 7)) & 0xff;
    off = y < 0x0b || y >= 0xa5;
  }
  if (!off) return m.peek(0x8800 | e) !== 0x06 ? L2414 : L2416;
  // l_2571: res 7,l -- back to the RAM buffer
  if (m.peek(0x8800 | e) === 0x03) {
    // l_2582_kill_bug_q_slot: free its motion queue slot
    const slot = m.peek(0x8800 | ((e + 1) & 0xff));
    m.poke(0x9100 | ((slot + 0x13) & 0xff), 0);
  }
  // l_2578_mk_obj_inactive
  m.poke(0x8800 | e, 0x80);
  m.poke(0x9300 | e, 0);
  return L2416;
}

/**
 * 07: spawning (new stage) -> 03, and counted.
 * @see galaga-main.asm $2590
 * @param {Machine} m @param {number} e @returns {number}
 */
function case_2590(m, e) {
  m.poke(0x8800 | e, 0x03);
  return L2414;
}
