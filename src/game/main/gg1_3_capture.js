// Copyright 2026 by Moshix
/**
 * gg1-3 ($2000-$23A0): the boss's tractor beam and the captured / rescued
 * fighter.
 *
 *   f_2000             task $1D: rescued fighter spins, lands and rejoins
 *   f_20F2             task $1C: the beam pulls the fighter up to the boss
 *   c_2188_ship_spin   rotate a fighter sprite one step (either direction)
 *   f_21CB             task $19: capture boss dives to its beaming spot
 *   f_2222             task $18: the tractor beam itself (tiles + timing)
 *   c_238A             tile-RAM address of the beam's bottom row
 *
 * RAM used throughout (names from reference/symbols.json):
 *   $9828 plyr_actv.bmbr_boss_cobj  object offset of the capturing boss
 *   $9829 plyr_actv.cboss_slot      its bug_motion_que slot offset
 *   $982A plyr_actv.captr_flag, $982B plyr_actv.bmbr_boss_cflag
 *   $928A-$928E ds5_928A_captr_status
 *   $8800/$8B00/$9300/$9B00 object status / sprite code / posn / ctrl
 *
 * @see reference/galaga-main.asm $2000-$23A0
 * @see reference/neiderm/galag/galagao_ASxxx/rom0/gg1-3.s
 */

import { romByte } from '../romdata.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/** `neg`. @param {number} a */
const neg = (a) => (-a) & 0xff;

/**
 * Sign flag of `cp v` with accumulator a: `jp p` is taken when it is clear.
 * @param {number} a @param {number} v @returns {boolean}
 */
const cpPositive = (a, v) => (((a - v) & 0x80) === 0);

/** Toggle bit 0 of a byte in RAM (`ld a,(hl) / xor $01 / ld (hl),a`). @param {Machine} m @param {number} addr */
const toggle0 = (m, addr) => m.poke(addr, m.peek(addr) ^ 0x01);

/**
 * Task $1D: the fighter freed from a shot capture boss spins, then drifts
 * horizontally and vertically to dock beside the player's fighter, which
 * becomes a two-ship. ds5_928A_captr_status+1 ($928B) is the state:
 * 0 = start, 1 = spinning, 2 = landing, 3 = joined.
 * @see galaga-main.asm $2000
 * @param {Machine} m
 */
export function f_2000(m) {
  // 0x2000: the captured ship's object offset (same as the boss that held it)
  let l = m.peek(0x9828);
  if (m.peek(0x8800 | l) !== 0) { l_20BF(m); return; }

  let a = m.peek(0x928b);
  if (a === 0) {
    // 0x20C7: inc a -- a was 0
    m.poke(0x928b, 1);
    m.poke(0x92ad, 2);
    return;
  }
  if (a === 1) {
    // l_20D1_update_ship_spin: HL = $9B00+L is c_2188's base address.
    const e = m.peek(0x92ad);
    m.poke(0x928d, m.peek(0x9287) | e);
    const out = c_2188_ship_spin(m, { hl: 0x9b00 | l });
    // 0x20E1: dec b / ret nz -- B is 1 only when the spin is complete, and
    // on that path c_2188 returns with A == 0, which is what is stored.
    if (((out.b - 1) & 0xff) !== 0) return;
    m.poke(0x9014, out.a);
    m.poke(0x9015, out.a);
    m.poke(0x9025, out.a);
    m.poke(0x928b, 2);
    return;
  }

  // Status 2+: move the rescued ship ($9300+L = X) toward column $80 ...
  const px = 0x9300 | l;
  a = m.peek(px);
  if (a !== 0x80) {
    // 0x201D: jp p after cp $80 -> dec, else inc
    if (cpPositive(a, 0x80)) m.poke(px, m.peek(px) - 1);
    else m.poke(px, m.peek(px) + 1);
  } else {
    // l_2026: ... then vertically, Y at $9300+L+1, bit 8 in $9B00+L+1.
    l = (l + 1) & 0xff;
    const py = 0x9300 | l;
    const cy = 0x9b00 | l;
    if (m.peek(0x9215) === 0) {
      // Upright screen: climb down until Y == $29 with bit 8 set.
      let join = false;
      if (m.peek(py) === 0x29) join = m.peek(cy) === 1;
      if (join) m.poke(0x928b, 3);
      else {
        // l_2041: inc (hl) / jr nz -- wrapping to 0 flips bit 8
        const v = (m.peek(py) + 1) & 0xff;
        m.poke(py, v);
        if (v === 0) toggle0(m, cy);
      }
    } else {
      // l_204C: flipped screen, move the other way until Y == $37, bit 8 clear
      let join = false;
      if (m.peek(py) === 0x37) join = m.peek(cy) === 0;
      if (join) m.poke(0x928b, 3);
      else {
        // l_2059: dec (hl) / inc a / jr z -- wrapping to $FF flips bit 8
        const v = (m.peek(py) - 1) & 0xff;
        m.poke(py, v);
        if (v === 0xff) toggle0(m, cy);
      }
    }
  }

  // l_205E: sprite code of fighter 1 is 6 (single) or 7 (captured look)
  a = (m.peek(0x8b62) - 6) & 0xff;
  const c = a;
  if (a === 0) {
    // Centre the player's fighter ($9362) on $71 first.
    const x = m.peek(0x9362);
    if (x !== 0x71) {
      if (cpPositive(x, 0x71)) m.poke(0x9362, x - 1);
      else m.poke(0x9362, x + 1);
      return;
    }
  }

  // l_2075: done once both ships are aligned and docked
  if (m.peek(0x928b) !== 3) return;
  l = m.peek(0x9828);
  m.poke(0x9300 | l, 0); // clear X of the captured ship object
  l = (l + 1) & 0xff;
  let de;
  if (c !== 0) {
    de = 0x9363;
    m.poke(0x982b, 0);
  } else {
    // l_208F: normal fighter -- now a two-ship
    m.poke(0x9827, 1);
    de = 0x9361;
  }
  // l_2097: copy Y and its ctrl byte to the second fighter slot
  m.poke(de, m.peek(0x9300 | l));
  const e = de & 0xff;
  m.poke(0x9b00 | e, m.peek(0x9b00 | l));
  l = (l - 1) & 0xff;
  m.poke(0x8800 | l, 0x80); // captured-ship object now inactive
  let sl = (e - 1) & 0xff;
  m.poke(0x8b00 | sl, 0x06); // sprite code 6
  sl = (sl + 1) & 0xff;
  m.poke(0x8b00 | sl, 0x09); // colour 9, white fighter
  sl = (sl - 1) & 0xff;
  m.poke(0x9300 | sl, 0x80);
  m.poke(0x9014, 1);
  m.poke(0x9015, 1);
  m.poke(0x9025, 1);
  m.poke(0x99b9, 1);
  l_20BF(m);
}

/** $20BF: stop this task and the "rescued ship" tune. @param {Machine} m */
function l_20BF(m) {
  m.poke(0x901d, 0);
  m.poke(0x9ab1, 0);
}

/**
 * Task $1C: the beam draws the fighter up to the capturing boss (or lets it
 * fall back if the boss is shot meanwhile).
 * @see galaga-main.asm $20F2
 * @param {Machine} m
 */
export function f_20F2(m) {
  const { b } = c_2188_ship_spin(m, { hl: 0x9b62 });
  if ((b & 1) !== 0) {
    // l_2151: the spin is complete
    if (m.peek(0x9015) === 0) {
      m.poke(0x920d, 1);
      l_217F(m);
      return;
    }
    l_215D(m, b);
    return;
  }
  if ((m.peek(0x928b) & 0x80) !== 0) { l_215D(m, b); return; }
  if (m.peek(0x928d) === 0) return;

  // Move the fighter's X one step toward the boss's X.
  const bossX = m.peek(0x9300 | m.peek(0x9828));
  const x = m.peek(0x9362);
  if (bossX !== x) {
    // 0x2113: jp p after cp (hl)
    if (cpPositive(bossX, x)) m.poke(0x9362, x + 1);
    else m.poke(0x9362, x - 1);
  }

  // l_211A_move_ship_row: Y ($9363) climbs toward the boss.
  if (m.peek(0x9215) !== 0) {
    const a = (m.peek(0x9363) + 1) & 0xff;
    m.poke(0x9363, a);
    if (a === 0x7a) { m.poke(0x9015, 0); return; }
    if (a === 0x80) l_2141(m);
    return;
  }
  const v = (m.peek(0x9363) - 1) & 0xff;
  m.poke(0x9363, v);
  // 0x212E: inc a / jr nz -- borrow out of the low byte flips bit 8
  if (v === 0xff) toggle0(m, 0x9b63);
  const a = m.peek(0x9363);
  if (a === 0xe6) { m.poke(0x9015, 0); return; } // l_214C_disable_firepower
  if (a !== 0xe0) return;
  l_2141(m);
}

/** $2141: fighter reached the boss: it turns red. @param {Machine} m */
function l_2141(m) {
  m.poke(0x928d, 0);
  m.poke(0x8b63, 0x07);
}

/**
 * $215D: the boss was shot while beaming -- the fighter drops back down.
 * @param {Machine} m @param {number} b B as c_2188 returned it
 */
function l_215D(m, b) {
  if (m.peek(0x9215) !== 0) {
    if (m.peek(0x9363) === 0x37) { l_217D(m, b); return; }
    m.poke(0x9363, m.peek(0x9363) - 1);
    return;
  }
  if (m.peek(0x9363) === 0x29) { l_217D(m, b); return; }
  const v = (m.peek(0x9363) + 1) & 0xff;
  m.poke(0x9363, v);
  if (v !== 0) return;
  toggle0(m, 0x9b63);
}

/** $217D: dec b / ret nz. @param {Machine} m @param {number} b */
function l_217D(m, b) {
  if (((b - 1) & 0xff) !== 0) return;
  l_217F(m);
}

/** $217F: end of this task; ship collision detection back on. @param {Machine} m */
function l_217F(m) {
  m.poke(0x901c, 0);
  m.poke(0x9025, 1);
}

/**
 * Turn a fighter sprite one step of its spin. The spin direction and the
 * horizontal/vertical flip come from bits 0 and 1 of C = Y ^ (Y >> 1),
 * computed from the ctrl byte at HL (so the spin is paced by the ship's
 * vertical movement). The sprite code's low 3 bits step between 0 and 6.
 * @see galaga-main.asm $2188
 * @param {Machine} m
 * @param {{ hl: number }} regs  HL = &sprite_ctrl[n] (or &sprite_posn[n]),
 *   only L selects the sprite
 * @returns {{ a: number, b: number }} B = 1 when the ship has completed its
 *   spin upright and no capture is in progress ($928D == 0); A as left
 */
export function c_2188_ship_spin(m, regs) {
  const l = regs.hl & 0xff;
  let a = m.peek(regs.hl);
  let c = ((a >> 1) ^ a) & 0xff; // 0x2189: ld c,a / srl a / xor c
  const code = 0x8b00 | l;
  a = m.peek(code) & 0x07;
  if (a === 6 && c === 0) {
    // 0x219D: ex af,af' (keeps A = 6) and test the capture status.
    if (m.peek(0x928d) === 0) return { a: 0, b: 1 };
  }
  // l_21A7: step the code toward 6 (C bit 0 clear) or toward 0 (set); at
  // the end stop, count C down (wrapping $FF -> 3) and look again.
  for (;;) {
    if ((c & 1) !== 0) {
      if (a !== 0) { m.poke(code, m.peek(code) - 1); break; }
    } else if (a !== 6) { m.poke(code, m.peek(code) + 1); break; }
    // l_21B8: dec c / jp p
    c = (c - 1) & 0xff;
    if ((c & 0x80) !== 0) c = 0x03;
  }
  // l_21C0: flip bits from C; bit 1 inverts the X flip
  a = c;
  if ((a & 0x02) !== 0) a ^= 0x01;
  m.poke(0x9b00 | l, a);
  return { a, b: 0 };
}

/**
 * Task $19: the capture boss dives until it is level with its beaming spot,
 * then hands over to f_2222.
 * @see galaga-main.asm $21CB
 * @param {Machine} m
 */
export function f_21CB(m) {
  const e = m.peek(0x9828);
  if (m.peek(0x8800 | e) !== 0x09) {
    // l_221A: boss no longer diving
    m.poke(0x9019, 0);
    m.poke(0x982b, 0);
    return;
  }
  // IX = bug_motion_que slot of the boss (IXH = $91, IXL = cboss_slot).
  const ix = 0x9100 | m.peek(0x9829);
  const at = (d) => (ix + d) & 0xffff;
  if (m.peek(at(0x0a)) !== 0) return; // still diving
  let a = 0x0c;
  if ((m.peek(at(0x05)) & 0x01) !== 0) a = neg(a);
  m.poke(at(0x0c), a);
  // 0x21EF: rrca / rra -- (ix+5) bit 0 is bit 8 of the 9-bit Y in (ix+4)
  const carry = m.peek(at(0x05)) & 0x01;
  a = ((m.peek(at(0x04)) >> 1) | (carry << 7)) & 0xff;
  a = (a - 0x78) & 0xff;
  if (a >= 0x10) return;

  // In position: start the beam.
  m.poke(0x982a, m.peek(0x99c6));
  m.poke(at(0x0c), 0);
  m.poke(0x9019, 0);
  m.poke(0x928b, 0);
  m.poke(0x920d, 0);
  m.poke(0x9018, 1);
  m.poke(0x928c, 1);
  m.poke(0x928d, 1);
}

/**
 * Task $18: the tractor beam. Every 4th frame it recolours the beam tiles
 * (a 10 x 6 block of tile colour RAM); every ($982A)-th call it grows or
 * shrinks the beam by one row and handles the end of the capture: the
 * fighter grabbed, or the boss shot while beaming.
 * @see galaga-main.asm $2222
 * @param {Machine} m
 */
export function f_2222(m) {
  const frame = m.peek(0x92a0);
  if ((frame & 0x03) === 0) {
    // Tile colour RAM address from the beam's X ($928A): the two top bits
    // of (-x - $18) are rotated into H = $21, giving $84-$87xx.
    let a = (neg(m.peek(0x928a)) - 0x18) & 0xff;
    let h = 0x21;
    h = ((h << 1) | (a >> 7)) & 0xff; // rlca / rl h
    a = ((a << 1) | (a >> 7)) & 0xff;
    h = ((h << 1) | (a >> 7)) & 0xff; // rlca / rl h
    a = ((a << 1) | (a >> 7)) & 0xff;
    let l = ((a & 0xe0) + 0x15) & 0xff;
    // Colour cycles with frame bits 2-3 (0 counts as 1): $18-$1A.
    a = (frame >> 2) & 0x03;
    if (a === 0) a = 1;
    a = (a + 0x17) & 0xff;
    let hl = (h << 8) | l;
    for (let row = 0; row < 6; row += 1) {
      // 0x224F: ld (hl),a / inc l -- only L advances within a row
      for (let i = 0; i < 10; i += 1) {
        m.poke(hl, a);
        hl = (hl & 0xff00) | ((hl + 1) & 0xff);
      }
      hl = (hl + 0x16) & 0xffff;
    }
  }

  // l_2257
  if ((m.peek(0x928b) & 0x80) === 0) {
    if (m.peek(0x8800 | m.peek(0x9828)) !== 0x09) {
      // l_2327_shot_boss_while_capturing
      m.poke(0x982a, 0x03);
      m.poke(0x928b, 0x80);
      m.poke(0x928d, 0);
      m.poke(0x99ba, 0);
      m.poke(0x928c, 1);
      m.poke(0x9014, 1);
      return;
    }
  }

  // l_226A: beam step timer
  const t = (m.peek(0x928c) - 1) & 0xff;
  m.poke(0x928c, t);
  if (t !== 0) { l_233D(m); return; }
  let a = m.peek(0x982a);
  m.poke(0x928c, a);

  if ((m.peek(0x928b) & 0x80) !== 0) {
    // l_22AB: the boss was shot -- retract the beam row by row
    const s = (m.peek(0x928b) + 1) & 0xff;
    m.poke(0x928b, s);
    a = s & 0x0f;
    if (a !== 0x0b) { beamErase(m, a); return; }
    m.poke(0x9018, 0);
    m.poke(0x9aa5, 0);
    m.poke(0x9aa6, 0);
    m.poke(0x982b, 0);
    return;
  }

  m.poke(0x9aa5, a); // beam sound on (A = captr_flag, non-zero)
  // bug_motion_que[cboss_slot].b0D = $FF: the boss hovers
  m.poke(0x9100 | ((m.peek(0x9829) + 0x0d) & 0xff), 0xff);
  const s = (m.peek(0x928b) + 1) & 0xff;
  m.poke(0x928b, s);
  a = s & 0x0f;
  if (a === 0x0b) { l_22D2(m); return; }
  if ((s & 0x40) !== 0) {
    // l_22C1: beam shrinking back after the fighter was missed
    beamErase(m, (neg(a) + 0x0b) & 0xff);
    return;
  }
  // Draw beam row A: 6 tile codes from d_23A1 (6 bytes per row; the table
  // is addressed from $239B, i.e. row 1 is its first entry).
  let src = 0x239b + 6 * a; // 0x2298: rlca / add a,c / rst $08 = HL += 6A
  let de = c_238A(m, { a }).de;
  for (let i = 0; i < 6; i += 1) {
    m.poke(de, romByte('main', src));
    src += 1;
    de = (de - 0x20) & 0xffff; // rst $20
  }
}

/**
 * $22C5: blank beam row A (6 tiles of code $24 going up the column).
 * @param {Machine} m @param {number} a
 */
function beamErase(m, a) {
  let de = c_238A(m, { a }).de;
  for (let i = 0; i < 6; i += 1) {
    m.poke(de, 0x24);
    de = (de - 0x20) & 0xffff;
  }
}

/** $22D2: beam fully out (row $0B). @param {Machine} m */
function l_22D2(m) {
  const s = m.peek(0x928b);
  if ((s & 0x40) === 0) {
    // l_231C: the beam missed or is at its full length -- start retracting
    m.poke(0x928c, 0x40);
    m.poke(0x928b, 0x40);
    return;
  }
  if (m.peek(0x920d) !== 0 && (s & 0x20) === 0) {
    m.poke(0x928b, 0x68);
    return;
  }
  // l_22E3: capture beam finished
  m.poke(0x9018, 0);
  m.poke(0x9aa5, 0);
  m.poke(0x9aa6, 0);
  const slot = m.peek(0x9829);
  if (m.peek(0x920d) === 0) {
    // No fighter captured: expire the boss's hover token.
    m.poke(0x982b, 0);
    m.poke(0x9828, 1);
    m.poke(0x9100 | ((slot + 0x0d) & 0xff), 1);
    return;
  }
  // l_2305: fighter captured: boss flies home via db_flv_cboss ($046B)
  const p = 0x9100 | ((slot + 0x08) & 0xff);
  m.poke(p, 0x6b);
  m.poke(0x9100 | ((p + 1) & 0xff), 0x04);
  m.poke(0x99ba, 0);
  m.poke(0x9011, 1);
  m.poke(0x928e, 1);
}

/**
 * $233D: while the beam is fully out ($928B == $40), grab the fighter if it
 * is within the beam's width.
 * @param {Machine} m
 */
function l_233D(m) {
  if (m.peek(0x928b) !== 0x40) return;
  let a = m.peek(0x9362);
  if ((m.peek(0x9215) & 0x01) !== 0) a = neg((a + 0x0e) & 0xff);
  a = (((m.peek(0x928a) - a) & 0xff) + 0x1b) & 0xff;
  if (a >= 0x36) return;
  // In a game (not attract mode) only while the stick task runs and the
  // stage is not restarting.
  if (m.peek(0x9201) !== 1) {
    if (((m.peek(0x9213) ^ 0x01) & m.peek(0x9014)) === 0) return;
  }
  // l_236D: captured
  m.poke(0x9014, 0);
  m.poke(0x9aa5, 0);
  m.poke(0x9025, 0);
  m.poke(0x9213, 0);
  m.poke(0x901c, 1);
  m.poke(0x9aa6, 1);
  m.poke(0x99ba, 1);
  m.poke(0x982a, 0x0a);
}

/**
 * Tile RAM address of beam row A: column from the beam X ($928A), with the
 * row added to the low byte only (no carry into D).
 * @see galaga-main.asm $238A
 * @param {Machine} m
 * @param {{ a: number }} regs  A = beam row
 * @returns {{ de: number, a: number, c: number }}
 */
export function c_238A(m, regs) {
  const c = regs.a & 0xff;
  let a = (neg(m.peek(0x928a)) + 0x10) & 0xff;
  let d = 0x20;
  d = ((d << 1) | (a >> 7)) & 0xff; // rlca / rl d
  a = ((a << 1) | (a >> 7)) & 0xff;
  d = ((d << 1) | (a >> 7)) & 0xff;
  a = ((a << 1) | (a >> 7)) & 0xff;
  a = (((a & 0xe0) + 0x14) & 0xff);
  const e = (a + c) & 0xff;
  return { de: (d << 8) | e, a: e, c };
}
