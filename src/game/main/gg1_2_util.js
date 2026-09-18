// Copyright 2026 by Moshix
/**
 * Main CPU $1000-$16FF (first half of gg1_2b.3m): arithmetic helpers, the
 * randomizer, attack-slot setup, player changeover, stage tokens, reserve
 * ships, task table defaults and the string printer behind `rst $30`.
 *
 * Every function is a line-by-line port of reference/galaga-main.asm; the
 * `@see` tag on each gives the rev. B address. Neidermeier's galagao source
 * (reference/neiderm/galag/galagao_ASxxx/rom0/gg1-2.s) explains the intent;
 * where rev. B differs (marked [rev B] in the listing) the rev. B bytes are
 * what is ported.
 *
 * Tile RAM reminder (player's view, 28 columns x 36 rows): the playfield is
 * $8040-$83BF, one column right = -$20, one row down = +1; colour RAM is the
 * tile address + $400 (`set 2,h`).
 *
 * Routines that wait for the vblank interrupt (the frame counter or a game
 * timer changing) are generators and must be run with `yield*` / call():
 * c_new_level_tokens, c_11E3_show_tokens_1, c_11E9, c_build_token_1,
 * c_tdelay_3, c_player_respawn and c_133A.
 */

import { mainRom } from '../romdata.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {Generator<symbol|undefined, void, void>} Wait */

// ------------------------------------------------------------------ helpers

/** HL with a new low byte, as `inc l` / `dec l` / `set 5,l` leave it.
 *  @param {number} hl @param {number} l @returns {number} */
const withL = (hl, l) => (hl & 0xff00) | (l & 0xff);

/** `rlca`, value only. @param {number} a @returns {number} */
const rlc = (a) => ((a << 1) | (a >> 7)) & 0xff;

// ------------------------------------------------------------- arithmetic

/**
 * The randomizer. Mixes the Z80 refresh register R (read twice) with the
 * frame counter through a byte of ROM page $01 (code and data alike):
 *
 *   ld a,r / add a,(frame_cts) / ld l,a / ld h,$01 / ld h,(hl) / ld a,r / add a,h
 *
 * The port has no instruction clock, so each `ld a,r` is m.readR() (the
 * machine supplies R: the oracle's values in lock-step tests, a
 * pseudo-random source in the browser). HL is preserved.
 *
 * @see galaga-main.asm $1000
 * @param {Machine} m
 * @param {{ hl?: number }} [regs]
 * @returns {{ a: number, hl: number }} a = random byte
 */
export function c_1000(m, { hl = 0 } = {}) {
  const r1 = m.readR(); // $1001: ld a,r
  const l = (m.peek(0x92a0) + r1) & 0xff;
  const h = mainRom(0x0100 | l);
  const r2 = m.readR(); // $100D: ld a,r
  return { a: (r2 + h) & 0xff, hl };
}

/**
 * Unreferenced code at $1012 (no call, jump or pointer reaches it in rev. B):
 * an octant/slope calculation from two points. With dx = E-L and dy = D-H it
 * divides the smaller magnitude by the larger (as 8.8 by c_divmod) and
 * encodes the octant in H. Ported for completeness.
 *
 * @see galaga-main.asm $1012
 * @param {Machine} m
 * @param {{ hl: number, de: number }} regs
 * @returns {{ hl: number, a: number }}
 */
export function sub_1012(m, { hl, de }) {
  const h0 = hl >> 8;
  const l0 = hl & 0xff;
  let d = de >> 8;
  const e = de & 0xff;
  // 1014: ld a,e / sub l -- negative x delta sets B bit 0 and is negated.
  let a = e - l0;
  let b = 0;
  if (a < 0) { b |= 1; a = -a; }
  a &= 0xff;
  let c = a;
  // 101F: ld a,d / sub h
  a = d - h0;
  if (a < 0) {
    d = a & 0xff;
    b = (b ^ 1) | 2;
    a = (-d) & 0xff;
  }
  a &= 0xff;
  // 102D: cp c -- keep the flags (push af) for the swap below.
  const lt = a < c;
  // 102F: rla / xor b / rra / ccf / rl b -- shifts (cp carry XOR B.0), inverted,
  // into B. rla puts the cp carry in bit 0, xor b flips it by B.0, rra takes
  // that bit back out into Cy (xor cleared the carry that rra rotates in).
  const bit = ((lt ? 1 : 0) ^ (b & 1)) ^ 1;
  b = ((b << 1) | bit) & 0xff;
  // 1035: pop af / jr nc -- if |dy| < |dx| swap so C is the larger.
  if (lt) { d = c; c = a; a = d; }
  // 103B: HL = C * 256 / A
  const q = c_divmod(m, { hl: c << 8, a });
  // 1041: ld a,h / xor b / and 1 / (nz: ld a,l / cpl / ld l,a)
  let l = q.hl & 0xff;
  let aOut = ((q.hl >> 8) ^ b) & 1;
  if (aOut) {
    l = (~l) & 0xff;
    aOut = l;
  }
  return { hl: (b << 8) | l, a: aOut };
}

/**
 * HL = HL * A by shift and add (16-bit wrap). DE is preserved.
 * @see galaga-main.asm $104E
 * @param {Machine} m
 * @param {{ hl: number, a: number }} regs
 * @returns {{ hl: number, a: number }} a is always 0 on return
 */
export function c_104E_mul_16_8(m, { hl, a }) {
  let de = hl & 0xffff;
  let acc = 0;
  let n = a & 0xff;
  // do { srl a; if (Cy) HL += DE; DE <<= 1 } while (A)
  do {
    const bit = n & 1;
    n >>= 1;
    if (bit) acc = (acc + de) & 0xffff;
    de = (de << 1) & 0xffff;
  } while (n !== 0);
  return { hl: acc, a: 0 };
}

/**
 * HL = HL / A, A = HL % A: a 17-step restoring division where `adc a,a`
 * shifts the dividend's top bit into the remainder and `adc hl,hl` shifts
 * the quotient bit (the complemented borrow) into HL. BC and DE preserved.
 * Division by zero is reproduced as the Z80 computes it.
 *
 * @see galaga-main.asm $1061
 * @param {Machine} m
 * @param {{ hl: number, a: number }} regs
 * @returns {{ hl: number, a: number }}
 */
export function c_divmod(m, { hl, a }) {
  const c = a & 0xff;
  let rem = 0; // xor a -- also clears Cy
  let cf = 0;
  let q = hl & 0xffff;
  for (let b = 0x11; b > 0; b -= 1) {
    // 1066: adc a,a
    const t = rem + rem + cf;
    rem = t & 0xff;
    if (t > 0xff) {
      // 1074: remainder overflowed 8 bits: sub c / scf
      rem = (rem - c) & 0xff;
      cf = 1;
    } else if (rem < c) {
      cf = 0; // cp c set Cy, ccf clears it
    } else {
      rem = (rem - c) & 0xff; // sub c clears Cy, ccf sets it
      cf = 1;
    }
    // 106E: adc hl,hl
    const u = q + q + cf;
    q = u & 0xffff;
    cf = u > 0xffff ? 1 : 0;
  }
  return { hl: q, a: rem };
}

// ------------------------------------------------- diving attack setup

/**
 * Boss / wingman launch: bit 7 of L flags a creature from the right side
 * (negated rotation). Enters j_108A with A' = flag | 1.
 * @see galaga-main.asm $1079
 * @param {Machine} m
 * @param {{ hl: number, de: number }} regs HL = &b_8800[n] (bit 7 of L = flag), DE = flight data
 */
export function c_1079(m, { hl, de }) {
  const l = hl & 0xff;
  j_108A(m, { hl: withL(hl, l & 0x7f), de, a_: (l & 0x80) + 1 });
}

/**
 * Diving attacker (red, yellow, bonus bee, rogue fighter): the right-side
 * flag is bit 1 of the object index (rrca twice moves it to bit 7).
 * @see galaga-main.asm $1083
 * @param {Machine} m
 * @param {{ hl: number, de: number }} regs HL = &b_8800[n], DE = flight data
 */
export function c_1083(m, { hl, de }) {
  const l = hl & 0xff;
  j_108A(m, { hl, de, a_: ((l << 6) & 0x80) + 1 });
}

/**
 * Take a free slot of the 12 flying-object queue entries ($9100, $14 bytes
 * each, free when bit 0 of +$13 is clear) and set it up for a diving
 * attacker: flight pointer, object index, and the sprite position converted
 * to 9.7 fixed point (flip-screen adjusted). The object state becomes 9
 * (diving) and its queue index is stored beside it. Nothing happens if the
 * queue is full.
 *
 * @see galaga-main.asm $108A
 * @param {Machine} m
 * @param {{ hl: number, de: number, a_: number }} regs
 *   HL = &b_8800[n], DE = flight data pointer, a_ = A' (bit 0 active, bit 7 negated rotation)
 */
export function j_108A(m, { hl, de, a_ }) {
  let ix = 0x9100;
  let b = 0x0c;
  for (; b > 0; b -= 1) {
    if ((m.peek(ix + 0x13) & 1) === 0) break;
    ix += 0x14;
  }
  if (b === 0) return;
  m.poke(ix + 0x08, de & 0xff);
  m.poke(ix + 0x09, de >> 8);
  m.poke(ix + 0x0d, 0x01); // expiration counter
  m.poke(ix + 0x04, 0x00); // heading $0100 (90 degrees)
  m.poke(ix + 0x05, 0x01);
  const c = hl & 0xff;
  m.poke(ix + 0x10, c);
  const d = a_ & 0xff;
  m.poke(hl, 0x09); // obj_status[n].state = diving attack
  m.poke(withL(hl, c + 1), ix & 0xff); // obj_status[n].idx = queue slot
  const flip = m.peek(0x9215) & 1;

  // Sprite Y is 9 bits: sY<7:0> in $93xx+1, sY<8> in bit 0 of $9Bxx+1.
  // rrca / rr b rebuilds sY<8:1> in B with sY<0> left in Cy.
  const sx = m.peek(0x9300 | c);
  const y8 = m.peek(0x9b00 | ((c + 1) & 0xff)) & 1;
  const ylo = m.peek(0x9300 | ((c + 1) & 0xff));
  let by = (ylo >> 1) | (y8 << 7);
  let cy = ylo & 1;
  if (!flip) {
    // 10D3: B = -(B + $50), then ccf: the unflipped screen counts Y the
    // other way round (the complement of sY<0> goes with the negation).
    by = (-(by + 0x50)) & 0xff;
    cy ^= 1;
  }
  m.poke(ix + 0x01, by); // sY<8:1>
  m.poke(ix + 0x00, cy ? 0x80 : 0x00); // sY<0> as the 9.7 fraction
  let x = sx;
  if (flip) x = (~(x + 0x0d)) & 0xff;
  m.poke(ix + 0x03, x >> 1); // sX<8:1>
  m.poke(ix + 0x02, (x & 1) ? 0x80 : 0x00);
  m.poke(ix + 0x13, d);
  m.poke(ix + 0x0e, 0x1e); // bomb drop counter
  // bomb-drop enable flags only while enemies are enabled
  const en = m.peek(0x920b);
  m.poke(ix + 0x0f, en !== 0 ? m.peek(0x92c8) : en);
}

// --------------------------------------------------- player changeover

/**
 * End one player's turn and prepare the other's: swap the $40-byte active
 * and suspended player blocks, swap the $30 object states with their stash
 * at $98B0 (re-encoding sprite code/colour), and swap the task enable
 * tables. Task 0 is left disabled.
 *
 * @see galaga-main.asm $110C
 * @param {Machine} m
 */
export function c_player_active_switch(m) {
  m.poke(0x9000, 0x1f);
  m.poke(0x98e0, 0x1f);
  for (let i = 0; i < 0x40; i += 1) {
    const c = m.peek(0x9820 + i);
    m.poke(0x9820 + i, m.peek(0x9860 + i));
    m.poke(0x9860 + i, c);
  }
  // Objects: an object at rest (state 1) is stashed as $80 | code<6:3> |
  // colour<2:0>; anything else stashes its bare sprite code. Coming back, a
  // stashed byte with bit 7 is a resting object again (code+6, colour),
  // otherwise the object is removed (state $80, X = 0).
  let de = 0x98b0;
  for (let l = 0; l < 0x60; l += 2) {
    const st = m.peek(0x8800 | l);
    let a = m.peek(0x8b00 | l) & 0x7f;
    if (st === 1) {
      a = (a & 0x78) | (m.peek(0x8b00 | (l + 1)) & 0x07) | 0x80;
    }
    const c = m.peek(de);
    m.poke(de, a);
    let state;
    if (c & 0x80) {
      m.poke(0x8b00 | l, (c & 0x78) + 6);
      m.poke(0x8b00 | (l + 1), c & 0x07);
      state = 0x01;
    } else {
      m.poke(0x8b00 | l, c);
      m.poke(0x9300 | l, 0x00);
      state = 0x80;
    }
    m.poke(0x8800 | l, state);
    de += 1;
  }
  for (let i = 0; i < 0x20; i += 1) {
    const c = m.peek(0x9000 + i);
    m.poke(0x9000 + i, m.peek(0x98e0 + i));
    m.poke(0x98e0 + i, c);
  }
  m.poke(0x9000, 0x00);
}

// ------------------------------------------------------- stage tokens

/**
 * Draw the stage badges ("tokens") at the bottom right: 50s, then 10/20/30/
 * 40, a 5 and 1s, each column with a click and an 8-frame pause unless Cy'
 * is set, then redraw the reserve ships. Rev. B first blanks the two token
 * rows ($8002-$8013, $8022-$8033), sparing tiles >= $4A (reserve ships).
 *
 * @see galaga-main.asm $117F
 * @param {Machine} m
 * @param {{ af_?: number }} [regs] af_ = AF': A' is written to the click
 *   sound register $9AB5, Cy' (bit 0) set means no clicks and no delay
 * @returns {Generator<symbol|undefined, { hl: number, de: number }, void>}
 */
export function* c_new_level_tokens(m, { af_ = 0 } = {}) {
  for (const base of [0x8002, 0x8022]) {
    for (let i = 0; i < 0x12; i += 1) {
      if (m.peek(base + i) < 0x4a) m.poke(base + i, 0x24);
    }
  }
  let a = m.peek(0x9821); // stage counter
  let b = 0;
  let hl = 0x8001;
  // count the 50s; each 50 badge is two columns wide (L += 2)
  while (a >= 0x32) {
    a -= 0x32;
    b += 1;
    hl = withL(hl, hl + 2);
  }
  const div = c_divmod(m, { hl: a, a: 0x0a });
  const tens = div.hl & 0xff; // (stage % 50) / 10
  const ones = div.a; // stage % 10
  // Move HL left past the columns the 10s-40 badge, the 5 and the 1s will
  // take (they are drawn right to left): 5+n needs n+1 columns, an odd tens
  // digit 2 columns, 20 and 40 their own value.
  let cols = ones >= 5 ? ones - 4 : ones;
  cols += (tens & 1) ? 2 : tens;
  hl = (hl + (cols & 0xff)) & 0xffff;
  for (let n = b; n > 0; n -= 1) ({ hl } = yield* c_11E9(m, { hl, a: 4, af_ })); // 50s
  ({ hl } = yield* c_11E3_show_tokens_1(m, { hl, a: tens, af_ }));
  let n1 = ones;
  if (ones >= 5) {
    ({ hl } = yield* c_build_token_1(m, { hl, d: 0x38, af_ })); // the 5 badge
    n1 = ones - 5;
  }
  for (; n1 > 0; n1 -= 1) ({ hl } = yield* c_build_token_1(m, { hl, d: 0x36, af_ })); // 1s
  // 11E4: jp draw_resv_ships [rev B]
  return draw_resv_ships(m);
}

/**
 * The 10/20/30/40 badge for A = tens (0 draws nothing; 40 is a 30 plus a
 * 10 badge).
 * @see galaga-main.asm $11F5
 * @param {Machine} m
 * @param {{ hl: number, a: number, af_: number }} regs HL tile address, A tens, AF' as for c_build_token_1
 * @returns {Generator<symbol|undefined, { hl: number }, void>}
 */
export function* c_11E3_show_tokens_1(m, { hl, a, af_ }) {
  if (a === 0) return { hl };
  if (a !== 4) return yield* c_11E9(m, { hl, a, af_ });
  let d;
  ({ hl, d } = yield* c_build_token_1(m, { hl, d: 0x42, af_ })); // 30s tiles
  ({ hl } = c_build_token_2(m, { hl, d }));
  ({ hl, d } = yield* c_build_token_1(m, { hl, d: 0x3a, af_ })); // 10s tiles
  return c_build_token_2(m, { hl, d });
}

/**
 * A four-tile badge whose tiles start at $36 + 4*A (A = 1 10, 2 20, 3 30,
 * 4 50).
 * @see galaga-main.asm $11FB
 * @param {Machine} m
 * @param {{ hl: number, a: number, af_: number }} regs
 * @returns {Generator<symbol|undefined, { hl: number, d: number, a: number }, void>}
 */
export function* c_11E9(m, { hl, a, af_ }) {
  let d = (rlc(rlc(a)) + 0x36) & 0xff;
  ({ hl, d } = yield* c_build_token_1(m, { hl, d, af_ }));
  return c_build_token_2(m, { hl, d });
}

/**
 * One two-tile column of a badge, preceded (unless Cy' is set) by an
 * 8-frame pause and the click sound: $9AB5 = A'.
 * @see galaga-main.asm $1213
 * @param {Machine} m
 * @param {{ hl: number, d: number, af_: number }} regs D first tile, af_ = AF'
 * @returns {Generator<symbol|undefined, { hl: number, d: number, a: number }, void>}
 */
export function* c_build_token_1(m, { hl, d, af_ }) {
  if ((af_ & 1) === 0) {
    // 1217: wait until the frame counter has advanced by 8
    const e = (m.peek(0x92a0) + 8) & 0xff;
    while (m.peek(0x92a0) !== e) yield;
    m.poke(0x9ab5, af_ >> 8);
  }
  return c_build_token_2(m, { hl, d });
}

/**
 * Put tiles D (top) and D+1 (bottom) at HL and HL+$20, colour 1 when
 * (D+2) & $0C == 8 (1s, 5s, 50s) and 2 otherwise, then move HL one column
 * right (`dec l`, no borrow into H).
 * @see galaga-main.asm $1228
 * @param {Machine} m
 * @param {{ hl: number, d: number }} regs
 * @returns {{ hl: number, d: number, a: number }} D += 2, A = colour
 */
export function c_build_token_2(m, { hl, d }) {
  m.poke(hl, d);
  hl |= 0x20; // set 5,l: one row down
  m.poke(hl, d + 1);
  const d2 = (d + 2) & 0xff;
  hl |= 0x400; // set 2,h: colour RAM
  const colour = (d2 & 0x0c) === 0x08 ? 1 : 2;
  m.poke(hl, colour);
  hl &= ~0x20;
  m.poke(hl, colour);
  hl &= ~0x400;
  return { hl: withL(hl, hl - 1), d: d2, a: colour };
}

// ------------------------------------------------------- task tables

/**
 * Load both task enable tables ($9000 active, $98E0 reserve) from the ROM
 * defaults at $125B and disable task 0.
 * @see galaga-main.asm $1242
 * @param {Machine} m
 */
export function c_1230_init_taskman_structs(m) {
  m.ldir(0x9000, 0x125b, 0x20);
  m.ldir(0x98e0, 0x125b, 0x20);
  m.poke(0x9000, 0x00);
}

/**
 * Initialise the 10 missile sprites $64-$7A: two rockets (code $30,
 * colour 9) and eight bombs (code $30, colour $0B, sY<8> set), all parked
 * at X = 0.
 * @see galaga-main.asm $127B
 * @param {Machine} m
 */
export function c_game_or_demo_init(m) {
  let l = 0x64;
  let c = 0x00;
  let d = 0x09;
  for (let b = 0x0a; b > 0; b -= 1) {
    m.poke(0x8b00 | l, 0x30);
    m.poke(0x9300 | l, 0x00);
    m.poke(0x9b00 | l, c);
    l += 1;
    m.poke(0x8b00 | l, d);
    l += 1;
    if (b === 9) { c = 0x01; d = 0x0b; }
  }
}

/**
 * Show one sprite of the attract-mode tables: the 4-byte record at
 * p_attrmode_sptiles ($9280) gives object index, code/colour, X, and Y<8:1>;
 * the object is made active and the pointer advanced.
 * @see galaga-main.asm $129E
 * @param {Machine} m
 */
export function c_sprite_tiles_displ(m) {
  const de = m.peek16(0x9280);
  const l = m.read('main', de);
  const c = m.read('main', de + 1);
  m.poke(0x8b00 | l, (c & 0x78) + 6); // upright frame of the set
  const l1 = (l + 1) & 0xff;
  // colour bits 2:0, and code bit 7 supplies colour bit 3
  m.poke(0x8b00 | l1, (c & 0x07) | ((c & 0x80) ? 0x08 : 0));
  m.poke(0x8800 | l, 0x01);
  m.poke(0x9300 | l, m.read('main', de + 2));
  const y = m.read('main', de + 3);
  m.poke(0x9300 | l1, (y << 1) & 0xff);
  m.poke(0x9b00 | l1, y >> 7); // sY<8> from the sla carry
  m.poke16(0x9280, (de + 4) & 0xffff);
}

/**
 * Formation home positions: $9900 pairs get offset 0 and the origin byte
 * from db_fmtn_hpos_orig ($1321); $9800 gets the 10 column X coordinates
 * and the 6 row Y coordinates (plus A, 9 bits), flip-screen adjusted; the
 * nest direction $920F starts equal to the flip flag.
 * @see galaga-main.asm $12D5
 * @param {Machine} m
 * @param {{ a: number }} regs A = row offset: 0 new stage, $3F changeover
 */
export function c_12C3(m, { a }) {
  const ixl = a & 0xff;
  const flip = m.peek(0x9215) & 1;
  for (let i = 0; i < 0x10; i += 1) {
    m.poke(0x9900 + 2 * i, 0x00);
    m.poke(0x9901 + 2 * i, mainRom(0x1321 + i));
  }
  for (let i = 0; i < 10; i += 1) {
    let x = mainRom(0x1321 + i);
    if (flip) x = (~(x + 0x0d)) & 0xff;
    m.poke(0x9800 + 2 * i, x);
  }
  for (let i = 0; i < 6; i += 1) {
    let y = (mainRom(0x132b + i) + ixl) & 0xff;
    // not flipped: $0160 - 2y as a 9-bit value, via cpl(y + $4F) then sla
    if (!flip) y = (~(y + 0x4f)) & 0xff;
    m.poke(0x9814 + 2 * i, (y << 1) & 0xff);
    m.poke(0x9815 + 2 * i, y >> 7);
  }
  m.poke(0x920f, m.peek(0x9215));
}

/**
 * Wait 3 ticks of the half-second game timer 3 ($92AF). HL preserved.
 * @see galaga-main.asm $1331
 * @param {Machine} m
 * @returns {Wait}
 */
export function* c_tdelay_3(m) {
  m.poke(0x92af, 0x03);
  while (m.peek(0x92af) !== 0) yield;
}

// ------------------------------------------------------ fighter spawn

/**
 * Get ready to play a new fighter: enable the stick task, print "READY"
 * unless "STAGE X" occupies its place, wait for all flying aliens to go
 * home, then place the fighter (c_133A).
 * @see galaga-main.asm $133D
 * @param {Machine} m
 * @returns {Wait}
 */
export function* c_player_respawn(m) {
  m.poke(0x9014, 0x01);
  if (m.peek(0x8270) === 0x24) j_string_out_pe(m, { c: 0x03 });
  yield* c_133A(m);
}

/**
 * Wait until no alien is flying ($9287 = 0), then put the fighter on
 * screen (see l_133A). Foreground entry.
 * @see galaga-main.asm $134C
 * @param {Machine} m
 * @returns {Wait}
 */
export function* c_133A(m) {
  while (m.peek(0x9287) !== 0) yield;
  l_133A(m);
}

/**
 * $134C reached from the attract-mode task f_17B2, i.e. inside the vblank
 * interrupt. The Z80 would spin there until the sub CPU clears $9287; an
 * interrupt handler cannot wait in the port, so this entry skips the wait
 * (the demo only gets here with no alien flying). Draws the reserve ships,
 * places fighter 1 (code 6, colour 9) at X $7A, Y $129 (or $37 flipped),
 * clears the stage-restart flag $9213 and sets star control $99B9 = 1.
 * @see galaga-main.asm $134C
 * @param {Machine} m
 */
export function l_133A(m) {
  draw_resv_ships(m);
  m.poke(0x8b62, 0x06);
  m.poke(0x8b63, 0x09);
  const flip = m.peek(0x9215) & 1;
  m.poke(0x9362, 0x7a);
  m.poke(0x9363, flip ? 0x37 : 0x29);
  m.poke(0x9b63, flip ? 0x00 : 0x01);
  m.poke(0x9b62, 0x00);
  m.poke(0x9213, 0x00);
  m.poke(0x99b9, 0x01);
}

/**
 * Draw the reserve fighters in the bottom-left corner: 2x2 tiles $4A-$4D
 * per ship, up to 8 positions, blanks after the last ship.
 * @see galaga-main.asm $137E
 * @param {Machine} m
 * @returns {{ hl: number, de: number }}
 */
export function draw_resv_ships(m) {
  // E = 8 - ships (cpl / add a,9 [rev B]): the slot where blanks begin
  const e = ((~m.peek(0x9820)) + 9) & 0xff;
  let hl = 0x801d;
  let d = draw_resv_ship_tile(m, { hl, de: 0x4900 | e }).d;
  hl = withL(hl, hl - 1);
  d = draw_resv_ship_tile(m, { hl, de: (d << 8) | e }).d;
  hl = withL(hl, (hl | 0x20) + 1);
  d = draw_resv_ship_tile(m, { hl, de: (d << 8) | e }).d;
  hl = withL(hl, hl - 1);
  d = draw_resv_ship_tile(m, { hl, de: (d << 8) | e }).d;
  return { hl, de: (d << 8) | e };
}

/**
 * One tile (D+1) of each of the 8 reserve-ship positions, two columns
 * apart, starting at HL and going right; from position E on the tile is a
 * blank. Rev. B leaves stage badge tiles ($36-$49) alone.
 * @see galaga-main.asm $1398
 * @param {Machine} m
 * @param {{ hl: number, de: number }} regs D = tile - 1, E = blank position
 * @returns {{ d: number, hl: number }} D incremented, HL preserved
 */
export function draw_resv_ship_tile(m, { hl, de }) {
  const d = ((de >> 8) + 1) & 0xff;
  const e = de & 0xff;
  let c = d;
  let l = hl & 0xff;
  for (let b = 8; b > 0; b -= 1) {
    if (b === e) c = 0x24;
    const t = m.peek(withL(hl, l));
    if (t < 0x36 || t >= 0x4a) m.poke(withL(hl, l), c);
    l = (l - 2) & 0xff;
  }
  return { d, hl };
}

// ---------------------------------------------------------------- text

/**
 * Print string C of d_cstring_tbl ($13F1, 1-based) at tile address HL.
 * @see galaga-main.asm $13B3
 * @param {Machine} m
 * @param {{ c: number, hl: number, de?: number }} regs
 * @returns {{ hl: number, de: number, a: number }} HL = address after the last character
 */
export function c_string_out(m, { c, hl, de = 0 }) {
  return j_string_out_pe(m, { c, hl, de, af_: 0 });
}

/**
 * The string printer. `rst $30` enters here with Cy' set: the string's
 * position is then the word stored just before it ("position encoded");
 * c_string_out enters with Cy' clear and the position in HL. A string is a
 * colour byte, then ASCII up to "/": digits map to tiles 0-9, "A".. to
 * $0A.., anything below "0" to a blank ($24). Each character moves one
 * column right (HL -= $20).
 *
 * @see galaga-main.asm $13B5
 * @param {Machine} m
 * @param {{ c: number, hl?: number, de?: number, af_?: number }} regs
 *   C = string index; af_ bit 0 = Cy' (default set, as rst $30 leaves it)
 * @returns {{ hl: number, de: number, a: number }} DE preserved, A = $2F
 */
export function j_string_out_pe(m, { c, hl = 0, de = 0, af_ = 1 }) {
  let pos = hl & 0xffff;
  // ld hl,d_cstring_tbl-2 / rst $08: the table is indexed from 1
  let src = m.read16('main', (0x13ef + 2 * (c & 0xff)) & 0xffff);
  if (af_ & 1) pos = m.read16('main', (src - 2) & 0xffff);
  const colour = m.read('main', src);
  src = (src + 1) & 0xffff;
  for (;;) {
    const ch = m.read('main', src);
    if (ch === 0x2f) break;
    let t = ch - 0x30;
    if (t < 0) t = 0x24; // space
    else if (t >= 0x11) t -= 7; // letters
    m.poke(pos, t);
    pos |= 0x400; // set 2,h
    m.poke(pos, colour);
    pos &= ~0x400; // res 2,h
    src = (src + 1) & 0xffff;
    pos = (pos - 0x20) & 0xffff;
  }
  return { hl: pos, de, a: 0x2f };
}
