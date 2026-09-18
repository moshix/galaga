// Copyright 2026 by Moshix
/**
 * Sub CPU (gg1_5b.3f) -- collision detection, $05EE-$08D2: cpu1 task [4]
 * f_06F5 moves the two rockets and tests them against every alien; task
 * [5] f_05EE tests the fighter(s) against aliens and bombs. Both end in the
 * common dispatcher hitd_dspchr, which scores the hit and notifies the main
 * CPU through b_9200_obj_collsn_notif ($9200 + object) and the sound
 * triggers at $9AA0.
 *
 * Objects are indexed by an even byte offset L shared by all the per-object
 * tables: status $8800+L (and slot offset at $8801+L), sprite code/colour
 * $8B00+L/$8B01+L, x $9300+L, y<7:0> $9301+L, y<8> in bit 0 of $9B01+L.
 *
 * Z80 quirks the port keeps:
 * - A hit found by the fighter test (hitd_det_fghtr) is dispatched and then
 *   the scan continues inside the rocket test's loop (hitd_dspchr returns to
 *   l_07B4), with the rocket's narrower window and hit counting.
 * - The "was it a formation alien" flag travels in AF' across the dispatch.
 */

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/** y<8:1> of object `l` from $9301+L and bit 0 of $9B01+L. @param {Machine} m @param {number} l */
function yHalf(m, l) {
  const l1 = (l + 1) & 0xff;
  return (m.peek(0x9300 + l1) >> 1) | ((m.peek(0x9b00 + l1) & 1) << 7);
}

/**
 * Candidate filter shared by both scans: skip objects already hit ($9200
 * bit 7) or inactive ($8800 bit 7), and explosions / score bitmaps
 * (status 4 and 5).
 * @param {Machine} m @param {number} l @returns {boolean}
 */
function candidate(m, l) {
  if ((m.peek(0x9200 + l) | m.peek(0x8800 + l)) & 0x80) return false;
  return (m.peek(0x8800 + l) & 0xfe) !== 4;
}

/**
 * The rocket scan from l_076A: B objects from L, window y +-3 (half
 * pixels), x -6..+4 (or the two-ship window). Returns when B runs out or
 * when a bomb was hit (hitd_dspchr's `ret`).
 * @param {Machine} m @param {number} l @param {number} b
 * @param {number} e rocket (or fighter) sprite offset
 * @param {number} ixl x @param {number} ixh y<8:1>
 */
function detRcktLoop(m, l, b, e, ixl, ixh) {
  for (;;) {
    if (candidate(m, l)) {
      const c = m.peek(0x8800 + l);
      // `sub ixh / sub 3 / add 6` carries iff -3 <= dy <= 2.
      if (((yHalf(m, l) - ixh - 3) & 0xff) + 6 > 0xff) {
        // 078E: (status - 1) & $FE is zero for status 1 and 2 (in
        // formation): stashed with its Z flag in AF'.
        const z = ((c - 1) & 0xfe) === 0;
        const x = m.peek(0x9300 + l);
        let hit;
        if (m.peek(0x9827) === 0) {
          hit = ((x - ixl - 6) & 0xff) + 0x0b > 0xff;
        } else {
          // Two ships side by side: two windows 16 pixels apart.
          const t = ((x - ixl - 0x14) & 0xff) + 0x0b;
          if (t > 0xff) hit = true;
          else if (t + 4 > 0xff) hit = false;
          else hit = t + 4 + 0x0b > 0xff;
        }
        if (hit) {
          // hitd_dspchr_rckt: count the hit (w_hit_ct).
          m.poke16(0x9844, m.peek16(0x9844) + 1);
          if (hitd_dspchr(m, { l, e, z })) return;
        }
      }
    }
    // l_07B4_next_object
    l = (l + 2) & 0xff;
    b = (b - 1) & 0xff;
    if (b === 0) return;
  }
}

/**
 * Rocket hit detection: test B objects from L against the rocket.
 * @see galaga-sub.asm $076A
 * @param {Machine} m
 * @param {{ l: number, b: number, e: number, ixl: number, ixh: number }} regs
 *   L first object, B count, E rocket y offset (odd), IXL x, IXH y<8:1>
 */
export function hitd_det_rckt(m, { l, b, e, ixl, ixh }) {
  detRcktLoop(m, l & 0xff, b & 0xff, e & 0xff, ixl, ixh);
}

/**
 * Collision dispatcher: clear the rocket (or fighter) sprite at E, then act
 * on the object hit at L by its colour: green boss (colour 0) turns blue,
 * a bomb (colour $B) is removed and ends the scan, anything else is
 * destroyed and scored.
 * @see galaga-sub.asm $07C2
 * @param {Machine} m
 * @param {{ l: number, e: number, z: boolean }} regs
 *   L object, E rocket/fighter offset, z: Z flag of AF' (formation alien)
 * @returns {boolean} true when it returned to the scan's caller (bomb)
 */
export function hitd_dspchr(m, { l, e, z }) {
  m.poke(0x9300 + e, 0);
  m.poke(0x9b00 + e, 0);
  const l1 = (l + 1) & 0xff;
  const c = m.peek(0x8b00 + l1);
  if (c === 0) {
    // l_08CA_hit_green_boss: colour 1, sound, keep scanning.
    m.poke(0x8b00 + l1, 1);
    m.poke(0x9aa4, 1);
    return false;
  }
  if (c === 0x0b) {
    // l_0815_bomb_hit
    m.poke(0x9300 + l, 0);
    m.poke(0x8800 + l, 0x80);
    return true;
  }
  if (!z) flyingBug(m, l, c);
  else m.poke(0x9200 + l, 0x81); // l_07DB: plain kill notification
  l_07DF(m, l, c, z);
  return false;
}

/**
 * l_081E_hdl_flyng_bug: free the motion slot, count the hit; then the
 * special cases decide the notification code in $9200+L: a completed
 * challenge-stage formation, the captured ship (B8), a bonus bee or clone,
 * a boss with an escort bonus, or the plain $81.
 * @param {Machine} m @param {number} l @param {number} c colour
 */
function flyingBug(m, l, c) {
  const l1 = (l + 1) & 0xff;
  m.poke(0x9100 + ((m.peek(0x8800 + l1) + 0x13) & 0xff), 0);
  m.poke(0x9288, m.peek(0x9288) + 1);
  const left = (m.peek(0x92a8) - 1) & 0xff;
  m.poke(0x92a8, left);
  if (left === 0) {
    // 0836: all 8 of a challenge-stage wave: bonus.
    m.poke(0x9200 + l, m.peek(0x9285));
    m.poke(0x929f, m.peek(0x929f) + m.peek(0x9284));
    return;
  }
  if (c === 7) { m.poke(0x9200 + l, 0xb8); return; } // captured ship
  if (m.peek(0x982d) === l || (l & 0x38) === 0x38) {
    // l_08B6: bonus bee or one of its clones; all three -> bonus.
    const n = (m.peek(0x99b0) - 1) & 0xff;
    m.poke(0x99b0, n);
    if (n !== 0) { m.poke(0x9200 + l, 0x81); return; }
    const d = m.peek(0x99b2);
    m.poke(0x929f, m.peek(0x99b1) + m.peek(0x929f));
    m.poke(0x9200 + l, d);
    return;
  }
  if (c !== 1) { m.poke(0x9200 + l, 0x81); return; }
  // Blue boss: if its captured fighter (object L & 7) is diving along,
  // free it: the rescue begins.
  const e2 = l & 7;
  if (m.peek(0x8800 + e2) === 0x09) {
    m.poke(0x9100 + ((m.peek(0x8800 + e2 + 1) + 0x13) & 0xff), 0);
    m.poke(0x8b00 + e2 + 1, 0x09);
    m.poke(0x9828, e2);
    m.poke(0x8800 + e2, 0);
    m.poke(0x928b, 0);
    m.poke(0x901d, 1);
    m.poke(0x928d, 1);
    m.poke(0x9ab1, 1);
  }
  // l_0899: escort bonus from the per-boss table at $9830.
  m.poke(0x92ad, 0x06);
  const a = m.peek(0x9830 + e2);
  const d = m.peek(0x9831 + e2);
  m.poke(0x929f, a + m.peek(0x929f));
  m.poke(0x9200 + l, d);
}

/**
 * l_07DF: capture-boss bookkeeping, hit sound by colour, and the per-colour
 * hit count at $9290 (counted twice for a flying alien).
 * @param {Machine} m @param {number} l @param {number} c @param {boolean} z
 */
function l_07DF(m, l, c, z) {
  if (m.peek(0x9828) === l) {
    m.poke(0x982b, 0);
    m.poke(0x9828, 1);
  }
  m.poke(0x9aa1 + (c === 7 ? 6 : ((c - 1) & 3)), 1);
  if (c === 7) m.poke(0x982b, 0);
  const p = 0x9290 + c;
  m.poke(p, m.peek(p) + 1);
  if (!z) m.poke(p, m.peek(p) + 1);
}

/**
 * Fighter collision scan: B objects from L against the fighter at
 * IXL/IXH, window x -7..+5, y -4..+2 (half pixels). A hit is dispatched,
 * then the scan continues in the rocket loop.
 * @see galaga-sub.asm $06B7
 * @param {Machine} m
 * @param {{ l: number, b: number, e: number, ixl: number, ixh: number }} regs
 */
export function hitd_det_fghtr(m, { l, b, e, ixl, ixh }) {
  l &= 0xff;
  for (;;) {
    if (candidate(m, l)) {
      const x = m.peek(0x9300 + l);
      if (x !== 0 && ((x - ixl - 7) & 0xff) + 0x0d > 0xff
          && ((yHalf(m, l) - ixh - 4) & 0xff) + 7 > 0xff) {
        m.poke(0x99bf, 1);
        // `or a` / `ex af,af'`: NZ -> treated as a flying alien.
        if (hitd_dspchr(m, { l, e, z: false })) return;
        l = (l + 2) & 0xff;
        b = (b - 1) & 0xff;
        if (b !== 0) detRcktLoop(m, l, b, e, ixl, ixh);
        return;
      }
    }
    l = (l + 2) & 0xff;
    b = (b - 1) & 0xff;
    if (b === 0) return;
  }
}

/**
 * Test fighter L ($60 or $62) against aliens (only the transients $38-$3E
 * while an attack wave is being launched, cpu0 task $9008) and bombs.
 * Clears $99BF first; the scans set it on a hit. A fighter already
 * exploding (status 8) is skipped.
 * @see galaga-sub.asm $0681
 * @param {Machine} m @param {{ l: number }} regs
 * @returns {{ e: number }} E = L (only meaningful after a hit)
 */
export function hitd_fghtr_notif(m, { l }) {
  m.poke(0x99bf, 0);
  if (m.peek(0x8800 + l) === 0x08) return { e: l };
  const ixl = m.peek(0x9300 + l);
  const ixh = yHalf(m, l);
  const e = l;
  if (m.peek(0x9008) !== 0) hitd_det_fghtr(m, { l: 0x38, b: 0x04, e, ixl, ixh });
  else hitd_det_fghtr(m, { l: 0x00, b: 0x30, e, ixl, ixh });
  hitd_det_fghtr(m, { l: 0x68, b: 0x08, e, ixl, ixh });
  return { e };
}

/**
 * l_064F: turn fighter sprite L into an explosion 8 pixels up-left of x =
 * A, sound the bang, and (unless another ship is docked, $9217) flag the
 * stage restart.
 * @param {Machine} m @param {number} a x @param {number} l fighter | $80
 */
function l_064F(m, a, l) {
  l &= 0x7f;
  m.poke(0x9300 + l, a - 8);
  const l1 = l + 1;
  m.poke(0x9300 + l1, m.peek(0x9300 + l1) - 8);
  m.poke(0x8b00 + l1, 0x0b);
  m.poke(0x8b00 + l, 0x20);
  m.poke(0x8800 + l, 0x08);
  m.poke(0x8800 + l1, 0x0f);
  m.poke(0x9b00 + l, 0x0c);
  m.poke(0x9827, 0);
  m.poke(0x9ab9, m.peek(0x9201) - 1);
  if (m.peek(0x9217) !== 0) return;
  m.poke(0x9213, 1);
}

/**
 * The fighter at E was hit: explode it, taking x from the hardware sprite
 * register ($9380+E) since hitd_dspchr already zeroed the buffer copy.
 * @see galaga-sub.asm $0649
 * @param {Machine} m @param {{ e: number }} regs
 */
export function hitd_fghtr_hit(m, { e }) {
  const l = (e | 0x80) & 0xff;
  l_064F(m, m.peek(0x9300 + l), l);
}

/**
 * cpu1 task [5]: fighter collisions, while cpu0 task f_1F85 ($9014) runs.
 * Two-ship: a hit on the left ship loses it; a hit on the right ship moves
 * the left ship's x into the right one's place, and that one explodes.
 * @see galaga-sub.asm $05EE
 * @param {Machine} m
 */
export function f_05EE(m) {
  const a = m.peek(0x9014);
  if (a === 0) return;
  m.poke(0x9217, a);
  if (m.peek(0x9827) !== 0 && m.peek(0x9360) !== 0) {
    const { e } = hitd_fghtr_notif(m, { l: 0x60 });
    if (m.peek(0x99bf) !== 0) {
      hitd_fghtr_hit(m, { e });
      m.poke(0x982b, 0);
    }
  }
  if (m.peek(0x9362) === 0) return;
  const { e } = hitd_fghtr_notif(m, { l: 0x62 });
  if (m.peek(0x99bf) === 0) return;
  if (m.peek(0x9827) !== 0) {
    m.poke(0x982b, 0);
    m.poke(0x9362, m.peek(0x9360));
    l_064F(m, m.peek(0x93e2), 0xe0);
    return;
  }
  // l_0639_not_two_ship: the last fighter is lost.
  m.poke(0x9014, 0);
  m.poke(0x9015, 0);
  m.poke(0x9025, 0);
  m.poke(0x99b9, 0);
  m.poke(0x9217, 0);
  hitd_fghtr_hit(m, { e });
}

/**
 * Move one rocket and test it. The attribute byte at DE (set when fired):
 * bit 7 vertical ship, bit 6 / bit 5 negate dx / dy, bits 2:0 the minor
 * displacement; the major one is 6. Off-screen rockets are removed
 * (x >= $F0, y<8:1> < $14 or >= $9C).
 * @see galaga-sub.asm $0704
 * @param {Machine} m @param {{ de: number, hl: number }} regs
 */
export function rckt_man(m, { de, hl }) {
  let l = hl & 0xff;
  if (m.peek(0x9300 + l) === 0) return;
  const b = m.peek(de);
  let dx = 6;
  let dy = b & 7;
  if (b & 0x80) { dx = b & 7; dy = 6; } // ex af,af' swaps the two
  if (b & 0x40) dx = (-dx) & 0xff;
  const x = (dx + m.peek(0x9300 + l)) & 0xff;
  m.poke(0x9300 + l, x);
  if (x >= 0xf0) { disableRocket(m, l); return; }
  l = (l + 1) & 0xff;
  if (b & 0x20) dy = (-dy) & 0xff;
  const s = dy + m.peek(0x9300 + l);
  m.poke(0x9300 + l, s);
  // 072C: toggle y<8> when the carry disagrees with the sign of dy.
  if (((s >> 8) ^ (dy >> 7)) & 1) m.poke(0x9b00 + l, m.peek(0x9b00 + l) ^ 1);
  const ixh = ((s & 0xff) >> 1) | ((m.peek(0x9b00 + l) & 1) << 7);
  if (ixh < 0x14 || ixh >= 0x9c) { disableRocket(m, (l - 1) & 0xff); return; }
  // While the rescued ship spins (cpu0 f_2000), skip objects 0-3.
  if (m.peek(0x901d) !== 0) detRcktLoop(m, 0x08, 0x2c, l, x, ixh);
  else detRcktLoop(m, 0x00, 0x30, l, x, ixh);
}

/** l_0763: x and attributes of rocket sprite L = 0. @param {Machine} m @param {number} l */
function disableRocket(m, l) {
  m.poke(0x9300 + l, 0);
  m.poke(0x9b00 + l, 0);
}

/**
 * cpu1 task [4]: both rockets ($9364, $9366; attributes $92A4, $92A5).
 * @see galaga-sub.asm $06F5
 * @param {Machine} m
 */
export function f_06F5(m) {
  rckt_man(m, { de: 0x92a4, hl: 0x9364 });
  rckt_man(m, { de: 0x92a5, hl: 0x9366 });
}
