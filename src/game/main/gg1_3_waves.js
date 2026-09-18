// Copyright 2026 by Moshix
/**
 * gg1-3 $25A2-$2AEC: the attack waves that fly in at the start of a stage.
 *
 *   c_25A2   build the wave table at ds_8920 from the stage data
 *   c_2896   stage init: creature sprite codes/colours + bomb flags,
 *            challenge-stage bonus attributes
 *   c_28E9   helper of c_2896: one class of creatures
 *   f_2916   task $08: launch the next creature of the wave table
 *   f_2A90   task $0A: the formation's left/right sway while waves arrive
 *
 * The wave table (ds_8920) is 5 groups, each "$7E, then pairs of
 * (flight-control byte, object ID)", ended by $7F. The flight-control byte's
 * bit 7 clear delays the launch to a multiple of 8 frames (trailing
 * formation), bit 6 selects the mirrored start parameters, bits 0-5 select a
 * flight path (db_2A3C). @see gctl_stg_new_atk_wavs_init in gg1-3.s
 *
 * @see reference/galaga-main.asm $25A2-$2AEC
 * @see reference/neiderm/galag/galagao_ASxxx/rom0/gg1-3.s
 */

import { CpuHang } from '../scheduler.js';
import { romByte } from '../romdata.js';
import { MAIN } from './routines.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/** `rlca`. @param {number} a */
const rlca8 = (a) => ((a << 1) | (a >> 7)) & 0xff;
/** `rrca`. @param {number} a */
const rrca8 = (a) => ((a >> 1) | (a << 7)) & 0xff;

/**
 * Build the attack wave table ds_8920 for the current stage
 * (gctl_stg_new_atk_wavs_init). Also loads the stage's two header bytes
 * (bomb control) to $92E2/$92E3. On stages with "transients" (creatures
 * that fly through without joining the formation), their IDs ($38-$3F with
 * control bits) are scattered at random into the 16-byte scratch buffer
 * $9100 before the 8 regular IDs of each wave fill the remaining holes.
 * Calls c_1000 (randomizer), c_104E_mul_16_8 and c_divmod ($1000-range).
 * @see galaga-main.asm $25A2
 * @param {Machine} m
 */
export function c_25A2(m) {
  m.poke16(0x92e0, 0x286e); // pb_attk_wav_IDs = db_attk_wav_IDs
  const stage = m.peek(0x9821);
  let a = stage;
  // l_25AC_while: past stage $17 the last 4 levels repeat
  while (a >= 0x17) a -= 4;
  let hl;
  let de;
  if (((a + 1) & 0x03) !== 0) {
    // Combat stage: row of d_combat_stg_dat_idx by rank (17 bytes each).
    // H is still $28 from "ld hl,$286E"; only L of the product is used.
    const prod = MAIN.c_104E_mul_16_8(m, { hl: 0x2811, a: m.peek(0x9984) });
    hl = (0x26a8 + (prod.hl & 0xff)) & 0xffff;
    de = 0x26f4;
    // 0x25CA: index = level - level / 4 - 1 (skipping challenge stages)
    a = (a - (a >> 2) - 1) & 0xff;
  } else {
    // l_25D3_is_challg_stg: one of 8 challenge stages
    hl = 0x26ec;
    a = (stage >> 2) & 0x07;
    de = 0x27de;
  }
  // l_25E0_set_data_ptr
  hl = (hl + a) & 0xffff;
  hl = (de + romByte('main', hl)) & 0xffff;
  m.poke(0x92e2, romByte('main', hl));
  hl += 1;
  m.poke(0x92e3, romByte('main', hl));
  hl += 1;

  // DE walks ds_8920 with 8-bit "inc e".
  let d = 0x89;
  let e = 0x20;
  m.poke(0x8920, 0x7e);
  e = (e + 1) & 0xff;

  // l_25F5_while_not_end_stg_dat: one 3-byte triplet per wave
  for (;;) {
    let c = romByte('main', hl);
    hl += 1;
    if (c === 0xff) break;
    const savedHl = hl;

    m.fill(0x9100, 0xff, 0x10);
    let b = c & 0x0f;
    if (b !== 0) {
      // Transients: B of them, placed at random in slots 0..E-1 (+8 when B
      // is odd), E = B/2 + 4. Each gets ID $38 | B<<1, plus $40 when the
      // next bit rotated out of C is set.
      const div = ((b >> 1) + 4) & 0xff;
      for (;;) {
        let r;
        let slot;
        do {
          // l_2612: A = random % E, retried until the slot is free
          r = MAIN.c_1000(m, {}).a & 0xff;
          slot = MAIN.c_divmod(m, { hl: r, a: div }).a & 0xff;
          if ((b & 0x01) !== 0) slot |= 0x08;
        } while (m.peek(0x9100 | slot) !== 0xff);
        let id = rlca8(b);
        // 0x262B: rlc c -- bit 7 of C to carry
        const cy = (c & 0x80) !== 0;
        c = rlca8(c);
        if (cy) id |= 0x40;
        id |= 0x38;
        m.poke(0x9100 | slot, id);
        b = (b - 1) & 0xff;
        if (b === 0) break;
      }
    }

    // l_2636: the wave's 8 regular IDs go into the free slots, 4 in slots
    // 0-7 and 4 from slot 8 on ("ld l,$08" after the 4th).
    let p = 0x9100;
    let ids = m.peek16(0x92e0);
    for (b = 8; b > 0; b -= 1) {
      while (m.peek(p) !== 0xff) p = (p + 1) & 0xffff;
      m.poke(p, m.read('main', ids));
      ids = (ids + 1) & 0xffff;
      p = (p + 1) & 0xffff;
      if (b === 5) p = (p & 0xff00) | 0x08;
    }
    m.poke16(0x92e0, ids);

    // Flight-control bytes of the triplet: B for the lefty, C for the righty.
    hl = savedHl;
    const bb = romByte('main', hl);
    hl += 1;
    const cc = romByte('main', hl);
    hl += 1;

    // l_2662_form_pair: "bb uu cc vv" for each U in slots 0-7 with its V
    // partner 8 slots on, until the first $FF.
    p = 0x9100;
    for (let pass = 0; ; pass += 1) {
      // With no $FF among slots 0-7 the Z80 never leaves this loop: `set 3,l`
      // / `res 3,l` / `inc hl` takes HL from $9107 to $9108 and then, since
      // bit 3 is cleared again, back to $9101. It keeps rewriting the same
      // 4-byte pattern around page $89 while interrupts carry on. Reachable
      // only on the wrapped stage 0 at some ranks. After 256 passes the page
      // holds that steady pattern; then the foreground is declared hung.
      if (pass >= 256 && (p & 0xff) <= 0x08) throw new CpuHang('$2662 (l_2662_form_pair, stage 0)');
      m.poke((d << 8) | e, bb);
      const u = m.peek(p);
      if (u === 0xff) break;
      e = (e + 1) & 0xff;
      m.poke((d << 8) | e, u);
      e = (e + 1) & 0xff;
      m.poke((d << 8) | e, cc);
      e = (e + 1) & 0xff;
      p |= 0x08; // set 3,l
      m.poke((d << 8) | e, m.peek(p));
      e = (e + 1) & 0xff;
      p &= ~0x08 & 0xffff; // res 3,l
      p = (p + 1) & 0xffff; // inc hl
    }
    // l_2679_next_wave: overwrite the pair's B with the next group's $7E
    m.poke((d << 8) | e, 0x7e);
    e = (e + 1) & 0xff;
  }

  // l_2681_end_of_table: back onto the last $7E
  e = (e - 1) & 0xff;
  const b = m.peek(0x982b);
  if ((((m.peek(0x9827) - 1) & 0xff) & b) !== 0 && m.peek(0x9825) !== 0) {
    // The boss holds a captured fighter (capture mode set, not two-ship) on
    // a combat stage: append the captured fighter ($04) with the
    // flight-control byte of the 4-back entry, and set its sprite code.
    const ctl = m.peek((d << 8) | ((e - 4) & 0xff));
    m.poke((d << 8) | e, ctl);
    e = (e + 1) & 0xff;
    m.poke((d << 8) | e, 0x04);
    e = (e + 1) & 0xff;
    m.poke(0x8b04, 0x87);
  }
  // l_26A4_done
  m.poke((d << 8) | e, 0x7f);
}

/**
 * Stage init (stg_init_env part): point the wave-table cursor at ds_8920 and
 * load each creature's sprite code/colour byte at $8B08-$8B5E: the class
 * code shifted left, with bit 7 taken from the bit stream d_2908 (bomb
 * drop enable). Challenge stages take their codes from d_290E and set the
 * bonus attributes $9284/$9285 from d_stage_chllg_rnd_attrib.
 * @see galaga-main.asm $2896
 * @param {Machine} m
 */
export function c_2896(m) {
  m.poke16(0x9822, 0x8920);
  const iy = 0x2908;
  let d;
  let e;
  if (m.peek(0x9825) === 0) {
    // Challenge stage. C = stage >> 2 (rotated); every 8 challenge stages
    // the attribute index steps (index 3 from stage 32 on).
    const r2 = rrca8(rrca8(m.peek(0x9821)));
    const c = r2;
    const r3 = rrca8(r2);
    let a = (r3 & 0x1c) === 0 ? r3 : 0x03;
    a &= 0x03;
    const src = 0x2900 + 2 * a; // rst $08
    m.poke(0x9284, romByte('main', src)); // ldi
    m.poke(0x9285, romByte('main', src + 1)); // ldi
    d = romByte('main', 0x290e + (c & 0x07));
    e = d;
  } else {
    // l_28CD_not_challenge_stage
    d = 0x36;
    e = 0x24;
  }
  // l_28D0: 20 bees ($08-$2E), 8 bosses ($30-$3E), 16 butterflies ($40-$5E)
  let st = { b: 0x14, c: 0, hl: 0x8b08, ix: (d << 8) | 0x01, iy };
  st = c_28E9(m, st);
  st = c_28E9(m, { ...st, b: 0x08, ix: 0x1000 | (st.ix & 0xff) });
  c_28E9(m, { ...st, b: 0x10, ix: (e << 8) | (st.ix & 0xff) });
}

/**
 * Initialise one class of creatures: for B sprites from HL (every 2nd
 * byte), code = IXH >> 1 with bit 7 = next bit of the stream at IY (MSB
 * first; IXL counts the bits left in C, reloaded from (IY) when it hits 0).
 * @see galaga-main.asm $28E9
 * @param {Machine} m
 * @param {{ b: number, c: number, hl: number, ix: number, iy: number }} regs
 * @returns {{ b: number, c: number, hl: number, ix: number, iy: number }}
 */
export function c_28E9(m, regs) {
  let { b, c, hl, iy } = regs;
  const ixh = (regs.ix >> 8) & 0xff;
  let ixl = regs.ix & 0xff;
  do {
    ixl = (ixl - 1) & 0xff;
    if (ixl === 0) {
      c = romByte('main', iy);
      iy = (iy + 1) & 0xffff;
      ixl = 0x08;
    }
    // 0x28F5: rlc c / rra -- the bit rotated out of C becomes bit 7
    const cy = c >> 7;
    c = rlca8(c);
    m.poke(hl, ((ixh >> 1) | (cy << 7)) & 0xff);
    hl = (hl & 0xff00) | ((hl + 2) & 0xff); // inc l / inc l
    b = (b - 1) & 0xff;
  } while (b !== 0);
  return { b, c, hl, ix: (ixh << 8) | ixl, iy };
}

/**
 * Task $08: launch the wave table's next creature into a free
 * bug_motion_que slot ($9100, 12 slots of $14 bytes), or wait for the
 * next wave's start conditions at a $7E, or finish at $7F.
 * @see galaga-main.asm $2916
 * @param {Machine} m
 */
export function f_2916(m) {
  let hl = m.peek16(0x9822);
  const tok = m.read('main', hl);
  if (tok === 0x7f) {
    // l_2A29_attack_waves_complete: once every bug has reached home
    if (m.peek(0x9287) !== 0) return;
    m.poke(0x9008, 0);
    m.poke(0x9004, 1);
    m.poke(0x9010, 1);
    m.poke(0x9824, 1);
    return;
  }
  if (tok === 0x7e) {
    if (m.peek(0x9842) === 0) return; // stage restarting
    if (m.peek(0x9287) !== 0) {
      m.poke(0x92ac, 2); // l_294D_set_tmr0: previous wave still flying
      return;
    }
    if (m.peek(0x9825) === 0) {
      // Challenge stage: wait for game timer 0; at 1 reset the hit count.
      const t = m.peek(0x92ac);
      if (t === 1) { m.poke(0x92a8, 0x08); return; }
      if (t !== 0) return;
    }
    // l_2944_attack_wave_start
    m.poke16(0x9822, (hl + 1) & 0xffff);
    m.poke(0x9826, m.peek(0x9826) + 1);
    return;
  }

  // l_2953_next_pair: trailing formations launch on multiples of 8 frames
  if ((tok & 0x80) === 0 && (m.peek(0x92a0) & 0x07) !== 0) return;
  let c = (tok << 1) & 0xff; // sla c

  // Find a free motion queue slot (bit 0 of .b13 clear).
  let ix = 0x9100;
  let found = false;
  for (let b = 0x0c; b > 0; b -= 1) {
    if ((m.peek(ix + 0x13) & 0x01) === 0) { found = true; break; }
    ix = (ix + 0x14) & 0xffff;
  }
  if (!found) return;

  hl = (hl + 1) & 0xffff;
  const id = m.read('main', hl);
  let a = id;
  if ((a & 0x78) === 0x78) a &= ~0x40 & 0xff;
  m.poke(ix + 0x10, a);
  hl = (hl + 1) & 0xffff;
  m.poke16(0x9822, hl);
  m.poke(0x8800 | a, 0x07); // state 07: spawning
  let l = (a + 1) & 0xff;
  m.poke(0x8800 | l, ix & 0xff); // slot offset
  if ((a & 0x38) !== 0x38) {
    // Split the code/colour byte c_2896 prepared: code & $78 in .b0,
    // colour in .b1, bit 7 enables bombing with this stage's flags.
    l = (l - 1) & 0xff;
    const v = m.peek(0x8b00 | l);
    m.poke(0x8b00 | l, v & 0x78);
    l = (l + 1) & 0xff;
    m.poke(0x8b00 | l, v & 0x07);
    m.poke(ix + 0x0f, (v & 0x80) !== 0 ? m.peek(0x92e3) : 0x00);
  } else {
    // l_29B3_setup_transients: $40 set -> red butterfly, else yellow bee,
    // or a boss on the 2nd wave
    let de = 0x0210;
    if ((id & 0x40) === 0) {
      de = 0x0318;
      if (m.peek(0x9826) === 0x02) de = 0x0008;
    }
    m.poke(0x8b00 | l, de >> 8);
    l = (l - 1) & 0xff;
    m.poke(0x8b00 | l, de & 0xff);
    m.poke(ix + 0x0f, 0x00);
  }

  // l_29D1_finalize_object_setup
  const d = c;
  c &= 0x7f;
  m.poke(ix + 0x0e, (c & 0x02) !== 0 ? 0x44 : 0x08);
  let p = 0x2a3c + c;
  m.poke(ix + 0x08, romByte('main', p));
  p += 1;
  // 0x29EA: xor a / rld -- A = high nibble of the ROM byte; rld also writes
  // (hl) back rotated, a write into ROM that the bus ignores.
  const hi = romByte('main', p);
  a = hi >> 4;
  m.poke(p, ((hi << 4) & 0xf0));
  const bn = a;
  m.poke(ix + 0x09, romByte('main', p) & 0x1f);
  a = bn & 0x0e;
  let q = 0x2a6c + a * 3; // rlca / add a,b
  if ((d & 0x80) !== 0) q += 3;
  m.poke(ix + 0x01, romByte('main', q));
  m.poke(ix + 0x03, romByte('main', q + 1));
  m.poke(ix + 0x05, romByte('main', q + 2));
  m.poke(ix + 0x00, 0);
  m.poke(ix + 0x02, 0);
  m.poke(ix + 0x04, 0);
  m.poke(ix + 0x0d, 1); // expiration counter
  m.poke(ix + 0x13, (0x01 | d) & 0x81); // active; bit 7 mirrors rotation
}

/**
 * Task $0A: every 4th frame move the formation's column offsets and home
 * X coordinates by one pixel, reversing at +/-$20; ends once the waves are
 * complete and the formation is back in the centre, then starts the
 * breathing formation (f_1DE6) and its pulsing sound.
 * @see galaga-main.asm $2A90
 * @param {Machine} m
 */
export function f_2A90(m) {
  if (((m.peek(0x92a0) - 1) & 0x03) !== 0) return;
  if ((m.peek(0x9008) | m.peek(0x92a7)) === 0) {
    m.poke(0x900a, 0); // l_2AE9_done
    return;
  }
  const c = m.peek(0x920f) === 0 ? 0x01 : 0xff;
  for (let l = 0; l < 0x14; l += 2) {
    m.poke(0x9900 | l, m.peek(0x9900 | l) + c);
    m.poke(0x9800 | l, m.peek(0x9800 | l) + c);
  }
  const a = m.peek(0x9900);
  if (m.peek(0x9824) !== 0 && a === 0) {
    // l_2ADA_done: formation complete and centred
    m.poke(0x920f, 0);
    m.poke(0x900a, 0);
    m.poke(0x9aa0, 1);
    m.poke(0x9009, 1);
    return;
  }
  // l_2AC9: reverse at the limits
  if (a === 0x20) { m.poke(0x920f, 1); return; }
  if (a === 0xe0) m.poke(0x920f, 0);
}

