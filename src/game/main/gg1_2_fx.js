// Copyright 2026 by Moshix
/**
 * Main CPU $1700-$1FFF (second half of gg1_2b.3m, Neidermeier's gg1-2_fx.s):
 * the periodic tasks of the main CPU task table ($0096) that live here and
 * their helpers -- demo fighter control, the attract-mode sequencer, the
 * fighter-capture sequence, the bonus-bee ("clone attack") manager, the
 * bomber launcher, nest movement, star control, enemy hit handling, the
 * game timers, the formation's breathing, bomb motion, the fire button and
 * the control stick.
 *
 * All of these run inside the vblank interrupt (task manager), so none of
 * them waits: they are plain functions.
 *
 * Jump tables (`rst $08` / `jp (hl)`) dispatch through MAIN_AT exactly as
 * the Z80 dispatches through the ROM table, so the table's words are read
 * from ROM and every target is registered by address in gg1_2.js.
 */

import { mainRom, romWord } from '../romdata.js';
import { MAIN, mainAt } from './routines.js';
import {
  c_1079, c_1083, c_divmod, c_1230_init_taskman_structs, c_game_or_demo_init,
  c_sprite_tiles_displ, l_133A, c_string_out, j_string_out_pe,
} from './gg1_2_util.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/** `rlca`, value only. @param {number} a @returns {number} */
const rlc = (a) => ((a << 1) | (a >> 7)) & 0xff;
/** `rrca`, value only. @param {number} a @returns {number} */
const rrc = (a) => ((a >> 1) | (a << 7)) & 0xff;

/**
 * Add a signed step to the low byte of a 9-bit sprite coordinate and tell
 * whether bit 8 must flip. The ROM idiom is
 *     add a,step / ld (hl),a / rra / xor step / rlca / (Cy -> flip bit 8)
 * rra moves the add's carry into bit 7, xor with the step's sign bit leaves
 * "carry XOR negative step" there, rlca brings it into Cy: a positive step
 * that carried or a negative step that did not borrow crosses 256.
 * @param {number} v low byte @param {number} step 8-bit two's complement
 * @returns {{ v: number, flip: boolean }}
 */
function add9(v, step) {
  const s = v + step;
  const carry = s > 0xff ? 1 : 0;
  return { v: s & 0xff, flip: (carry ^ (step >> 7)) === 1 };
}

// ============================================== f_1700: demo fighter

/**
 * Task 3: drive the fighter in training and demo mode from the command
 * bytes at pdb_demo_fghtrvctrs ($9282). Bits 7:5 of the current byte select
 * the handler from d_1713.
 * @see galaga-main.asm $1700
 * @param {Machine} m
 */
export function f_1700(m) {
  const de = m.peek16(0x9282);
  const idx = (m.read('main', de) >> 5) & 0x07;
  mainAt(romWord('main', 0x1713 + 2 * idx))(m, { de });
}

/**
 * $4x token: count down the demo timer $9207 every 16 frames, then take the
 * next token.
 * @see galaga-main.asm $171F
 * @param {Machine} m
 */
export function case_171F(m) {
  if (m.peek(0x92a0) & 0x0f) return;
  const t = (m.peek(0x9207) - 1) & 0xff;
  m.poke(0x9207, t);
  if (t !== 0) return;
  case_1766(m);
}

/**
 * $Ax token: fire a shot, then steer like case_1734.
 * @see galaga-main.asm $172D
 * @param {Machine} m
 */
export function case_172D(m) {
  c_1F0F(m);
  case_1734(m, { de: m.peek16(0x9282) });
}

/**
 * $0x/$2x/$8x token: move the fighter -- toward the target alien ($9209)
 * when bit 0 is set, else by the token's own L/R bits -- and every 4 frames
 * count down $9207; at 0 fire and take the next token.
 * @see galaga-main.asm $1734
 * @param {Machine} m
 * @param {{ de: number }} regs DE = pdb_demo_fghtrvctrs
 */
export function case_1734(m, { de }) {
  let a = m.read('main', de);
  const e = m.peek(0x9827);
  if ((a & 1) === 0) {
    a &= 0x0a;
  } else {
    // simulated stick: $0A neutral, $08 right, $02 left (active low)
    const target = m.peek(0x9300 | m.peek(0x9209));
    const ship = m.peek(0x9362);
    if (ship === target) a = 0x0a;
    else a = ship < target ? 0x08 : 0x02;
  }
  c_1F92(m, { a, e });
  if (m.peek(0x92a0) & 0x03) return;
  const t = (m.peek(0x9207) - 1) & 0xff;
  m.poke(0x9207, t);
  if (t !== 0) return;
  c_1F0F(m);
  case_1766(m);
}

/**
 * Advance to the next demo token (two bytes for $8x) and run its one-shot
 * handler from d_1786.
 * @see galaga-main.asm $1766
 * @param {Machine} m
 */
export function case_1766(m) {
  let de = m.peek16(0x9282);
  if ((m.read('main', de) & 0xc0) === 0x80) de = (de + 1) & 0xffff;
  de = (de + 1) & 0xffff;
  const a = m.read('main', de);
  m.poke16(0x9282, de);
  mainAt(romWord('main', 0x1786 + 2 * ((a >> 5) & 0x07)))(m, { de });
}

/**
 * $0x/$2x: select the target alien, $9209 = token<5:0> * 2.
 * @see galaga-main.asm $1794
 * @param {Machine} m @param {{ de: number }} regs
 */
export function case_1794(m, { de }) {
  m.poke(0x9209, rlc(m.read('main', de)) & 0x7e);
}

/**
 * $Cx: end of sequence, disable this task.
 * @see galaga-main.asm $179C
 * @param {Machine} m
 */
export function case_179C(m) {
  m.poke(0x9003, 0x00);
}

/**
 * $4x: demo timer $9207 = token & $1F.
 * @see galaga-main.asm $17A1
 * @param {Machine} m @param {{ de: number }} regs
 */
export function case_17A1(m, { de }) {
  m.poke(0x9207, m.read('main', de) & 0x1f);
}

/**
 * $6x: print string (token & $1F).
 * @see galaga-main.asm $17A8
 * @param {Machine} m @param {{ de: number }} regs
 */
export function case_17A8(m, { de }) {
  j_string_out_pe(m, { c: m.read('main', de) & 0x1f, de });
}

/**
 * $8x/$Ax: demo timer $9207 = the following byte (the pointer itself is
 * not advanced past it here; case_1766 skips it later).
 * @see galaga-main.asm $17AE
 * @param {Machine} m @param {{ de: number }} regs
 */
export function case_17AE(m, { de }) {
  m.poke(0x9207, m.read('main', (de + 1) & 0xffff));
}

// ====================================== f_17B2: attract-mode sequencer

/**
 * Task 2: while in attract mode ($9201 == 1) run state $9203 of the
 * attract sequence through d_17C3_jptbl.
 * @see galaga-main.asm $17B2
 * @param {Machine} m
 */
export function f_17B2(m) {
  if (m.peek(0x9201) !== 1) return;
  const idx = m.peek(0x9203);
  mainAt(romWord('main', (0x17c3 + 2 * idx) & 0xffff))(m);
}

/**
 * State $0E: after the demo, show the high score table, then wait for
 * timer 3 to reach 1 and move on.
 * @see galaga-main.asm $17E1
 * @param {Machine} m
 */
export function case_17E1(m) {
  const t = m.peek(0x92af);
  if (t === 0) {
    MAIN.c_mach_hiscore_show(m);
    m.poke(0x92af, 0x0a);
    return;
  }
  if (t === 1) l_attmode_state_step(m);
}

/**
 * State $07: at frame count %32 == 31 enable f_0857 and print "GAME OVER".
 * @see galaga-main.asm $17F5
 * @param {Machine} m
 */
export function case_17F5(m) {
  if ((m.peek(0x92a0) & 0x1f) !== 0x1f) return;
  m.poke(0x9005, 0x01);
  j_string_out_pe(m, { c: 0x02 });
  l_attmode_state_step(m);
}

/**
 * State $0A: fighter back on screen after the capture, demo vectors d_181F,
 * enable fighter control, fire button and the sub CPU's fighter collisions.
 * @see galaga-main.asm $1808
 * @param {Machine} m
 */
export function case_1808(m) {
  l_133A(m);
  m.poke16(0x9282, 0x181f);
  m.poke(0x9003, 0x01);
  m.poke(0x9015, 0x01);
  m.poke(0x9025, 0x01);
  l_attmode_state_step(m);
}

/**
 * State $0C: end of demo -- clear the flying queue, reload the task tables,
 * disable the bomber manager and enemies, keep this task enabled.
 * @see galaga-main.asm $1840
 * @param {Machine} m
 */
export function case_1840(m) {
  m.fill(0x9100, 0x00, 0xf0); // rst $28
  c_1230_init_taskman_structs(m);
  m.poke(0x9010, 0x00);
  m.poke(0x920b, 0x00);
  m.poke(0x9002, 0x01);
  l_attmode_state_step(m);
}

/**
 * State $08: set up the demo game (stage 1, demo vectors d_1887, two
 * bombers max, wingman-mode boss) and its stage environment.
 * @see galaga-main.asm $1852
 * @param {Machine} m
 */
export function case_1852(m) {
  m.poke(0x982b, 0x00);
  m.poke(0x9ab7, 0x01);
  m.poke(0x9821, 0x01);
  m.poke(0x9003, 0x01);
  m.poke(0x9015, 0x01);
  m.poke(0x9825, 0x01);
  m.poke16(0x9282, 0x1887);
  MAIN.stg_init_env(m);
  l_133A(m);
  m.poke(0x920b, 0x01);
  m.poke(0x9842, 0x01);
  m.poke(0x982c, 0x01);
  m.poke(0x99c4, 0x02);
  m.poke(0x99c5, 0x02);
  l_attmode_state_step(m);
}

/**
 * State $05: time the copyright text to the last boss's explosion: arm
 * the explosion/score and timer 2 = 9; at 6 print the copyright; at 1 go on.
 * @see galaga-main.asm $18AC
 * @param {Machine} m
 */
export function case_18AC(m) {
  const t = m.peek(0x92ae);
  if (t === 0) {
    m.poke(0x9234, 0x34);
    m.poke(0x92ae, 0x09);
    return;
  }
  if (t === 1) { l_attmode_state_step(m); return; }
  if (t !== 6) return;
  m.poke(0x9362, 0x00);
  j_string_out_pe(m, { c: 0x13 });
  j_string_out_pe(m, { c: 0x14 });
}

/**
 * States $04, $09, $0B: wait for f_1700 to disable itself.
 * @see galaga-main.asm $18D1
 * @param {Machine} m
 */
export function case_18D1(m) {
  if (m.peek(0x9003) === 0) l_attmode_state_step(m);
}

/**
 * State $03: training mode -- show the remaining 7 attract sprites, no
 * reserve ships, fighter on screen, bomber timers $FF/$0D, training
 * vectors d_1928, capture boss forced off, bomber and hit tasks on, demo
 * sound from DSWA, missiles initialised.
 * @see galaga-main.asm $18D9
 * @param {Machine} m
 */
export function case_18D9(m) {
  for (let b = 7; b > 0; b -= 1) c_sprite_tiles_displ(m);
  m.poke(0x9820, 0x00);
  m.poke(0x9005, 0x00);
  l_133A(m);
  // four overlapping 16-bit stores of $FF0D
  m.poke16(0x92c5, 0xff0d);
  m.poke16(0x92c4, 0xff0d);
  m.poke16(0x92c1, 0xff0d);
  m.poke16(0x92c0, 0xff0d);
  m.poke16(0x9282, 0x1928);
  m.fill(0x92ca, 0x00, 0x10); // rst $18
  m.poke(0x9827, 0x00);
  m.poke(0x920b, 0x00);
  m.poke(0x982b, 0x01);
  m.poke(0x9010, 0x01);
  m.poke(0x900b, 0x01);
  m.poke(0x9003, 0x01);
  // DSWA "sound in attract mode" is bit 1 of $6803
  m.poke(0x9ab7, rrc(m.peek(0x6803)) & 0x01);
  c_game_or_demo_init(m);
  l_attmode_state_step(m);
}

/**
 * States $00, $06, $0D: clear the playfield and the sprites.
 * @see galaga-main.asm $1940
 * @param {Machine} m
 */
export function case_1940(m) {
  MAIN.c_sctrl_playfld_clr(m);
  MAIN.c_sctrl_sprite_ram_clr(m);
  l_attmode_state_step(m);
}

/**
 * State $01: set up the info screen: sprite table d_attrmode_sptiles,
 * text index 0, hit count 0, timer 2 = 2.
 * @see galaga-main.asm $1948
 * @param {Machine} m
 */
export function case_1948(m) {
  m.poke16(0x9280, 0x195c);
  m.poke(0x9205, 0x00);
  m.poke(0x92a8, 0x00);
  m.poke(0x92ae, 0x02);
  l_attmode_state_step(m);
}

/**
 * State $02: every second show the next info text (strings $0E-$12) and
 * from the third on its sprite; after the fifth move on.
 * @see galaga-main.asm $1984
 * @param {Machine} m
 */
export function case_1984(m) {
  if (m.peek(0x92ae) !== 0) return;
  m.poke(0x92ae, 0x02);
  let a = m.peek(0x9205);
  if (a === 5) { l_attmode_state_step(m); return; }
  a = (a + 1) & 0xff;
  m.poke(0x9205, a);
  j_string_out_pe(m, { c: (a + 0x0d) & 0xff });
  if (m.peek(0x9205) < 3) return;
  c_sprite_tiles_displ(m);
}

/**
 * Next attract state, wrapping $0F to 0.
 * @see galaga-main.asm $19A7
 * @param {Machine} m
 */
export function l_attmode_state_step(m) {
  const s = (m.peek(0x9203) + 1) & 0xff;
  m.poke(0x9203, s);
  if (s === 0x0f) m.poke(0x9203, 0x00);
}

// =============================================== f_19B2: fighter capture

/**
 * Task $11: the captured fighter. First call prints "FIGHTER CAPTURED";
 * while the text shows, the capturing boss's flight is held; then (rev. B)
 * the fighter sprite is moved into the captured-ship object, the text
 * erased, and the ship follows the boss home and rises $24 steps above it.
 * @see galaga-main.asm $19B2
 * @param {Machine} m
 */
export function f_19B2(m) {
  if (m.peek(0x928e) !== 0) {
    // l_19D2_fighter_captured
    j_string_out_pe(m, { c: 0x0a });
    m.poke(0x92ad, 0x06);
    m.poke(0x8b63, 0x07); // [rev B]
    m.poke(0x928b, 0x00);
    m.poke(0x928e, 0x00);
    return;
  }
  const t = m.peek(0x92ad);
  if (t !== 0) {
    if (t === 4) {
      m.poke(0x92ad, 0x03);
      m.poke(0x9aa9, 0x03);
    }
    // l_19C7: bug_motion_que[cboss_slot].b0D = 4
    m.poke(0x9100 | ((m.peek(0x9829) + 0x0d) & 0xff), 0x04);
    return;
  }
  // $19E6 [rev B]: once, while the text is still up
  if (m.peek(0x82d1) !== 0x24) {
    const e = m.peek(0x9828) & 0x07; // captured ship objects $00-$07
    // move the fighter's position into the captured ship's sprite
    m.poke(0x9300 | e, m.peek(0x9362));
    m.poke(0x9362, 0x00);
    m.poke(0x9300 | (e + 1), m.peek(0x9363));
    // ldd / ldi: $9B[e+1] = $9B63, $9B[e] = $9B62
    m.poke(0x9b00 | (e + 1), m.peek(0x9b63));
    m.poke(0x9b00 | e, m.peek(0x9b62));
    m.poke(0x8b00 | (e + 1), 0x07);
    m.poke(0x8b00 | e, 0x07);
    c_string_out(m, { c: 0x0b, hl: 0x83b1 });
  }
  // l_1A10
  const l = m.peek(0x9828);
  const e = l & 0x07;
  const flip = m.peek(0x9215) & 1;
  if (m.peek(0x8800 | l) === 0x09) {
    // boss still flying: ship tracks it, $10 below (or above if flipped)
    m.poke(0x9300 | e, m.peek(0x9300 | l));
    const l1 = (l + 1) & 0xff;
    const e1 = e + 1;
    const off = flip ? 0xf0 : 0x10;
    const y = add9(m.peek(0x9300 | l1), off);
    m.poke(0x9300 | e1, y.v);
    m.poke(0x9b00 | e1, (y.flip ? 1 : 0) ^ m.peek(0x9b00 | l1));
    return;
  }
  // l_1A3F_join_ship_to_group: boss home, raise the ship $24 steps
  const cnt = m.peek(0x928b);
  if (cnt === 0) m.poke(0x8b00 | e, 0x06);
  m.poke(0x928b, (cnt + 1) & 0xff);
  if (cnt === 0x24) {
    // l_1A6A_ship_in_position
    m.poke(0x9011, 0x00);
    m.poke(0x9aa9, 0x00);
    m.poke(0x8800 | e, 0x01);
    m.poke(0x9828, 0x01);
    m.poke(0x99b9, 0x01);
    m.poke(0x9213, 0x02);
    return;
  }
  const e1 = e + 1;
  const y = add9(m.peek(0x9300 | e1), flip ? 0x01 : 0xff);
  m.poke(0x9300 | e1, y.v);
  if (y.flip) m.poke(0x9b00 | e1, m.peek(0x9b00 | e1) ^ 0x01);
}

// ============================================ f_1A80: bonus bee manager

/**
 * Task 4: the bonus bee ("clone attack"). When few enough aliens remain
 * ($99CA), pick a resting bee or moth, flash it for a while in the two
 * colours, then launch it with the escort configuration for its colour.
 * @see galaga-main.asm $1A86
 * @param {Machine} m
 */
export function f_1A80(m) {
  if (m.peek(0x92a7) >= m.peek(0x99ca)) return;
  const tmr = m.peek(0x9841);
  if (tmr === 0) {
    // find a resting (state 1) bee $08-$2E, else moth $40-$5E
    let found = -1;
    for (let l = 0x08; l < 0x30 && found < 0; l += 2) if (m.peek(0x8800 | l) === 1) found = l;
    for (let l = 0x40; l < 0x60 && found < 0; l += 2) if (m.peek(0x8800 | l) === 1) found = l;
    if (found < 0) return;
    m.poke(0x9841, 0xc0);
    const c = m.peek(0x8b00 | (found + 1));
    // colour B = (stage / 4) % 3 + 4
    const a = (c_divmod(m, { hl: m.peek(0x9821) >> 2, a: 0x03 }).a + 4) & 0xff;
    m.poke(0x982d, found);
    m.poke(0x982e, c);
    m.poke(0x982f, a);
    m.poke(0x9ab2, a);
    return;
  }
  const t = (tmr + 1) & 0xff;
  if (t !== 0) {
    m.poke(0x9841, t);
    const e = m.peek(0x982d);
    if (m.peek(0x8800 | e) !== 1) { m.poke(0x9004, 0x00); return; }
    // alternate colour A / colour B every 16 frames
    const colour = m.peek((t & 0x10) ? 0x982f : 0x982e);
    m.poke(0x8b00 | ((e + 1) & 0xff), colour);
    return;
  }
  // l_1AF4_ready_go
  if (m.peek(0x9015) === 0) {
    m.poke(0x9841, 0xe0);
    return;
  }
  const l = m.peek(0x982d);
  if (m.peek(0x8800 | l) !== 1 || (m.peek(0x9200 | l) & 0x80)) {
    m.poke(0x9004, 0x00);
    return;
  }
  const k = (m.peek(0x982f) - 4) & 0xff;
  // X3 attack config: 3, then the word d_1B59[k]
  let src = (0x1b5f + 2 * k) & 0xffff;
  m.poke(0x99b0, 0x03);
  m.poke(0x99b1, m.read('main', src));
  src = (src + 1) & 0xffff;
  m.poke(0x99b2, m.read('main', src));
  const c = k & 0x0f;
  const de = m.read16('main', (0x1b65 + 2 * c) & 0xffff);
  const old = m.peek(0x8b00 | l);
  m.poke(0x8b00 | l, (rlc(rlc(rlc(c))) + 0x56) & 0xff);
  m.poke(0x982e, (m.peek(0x982e) & 0x07) | (old & 0xf8));
  c_1083(m, { hl: 0x8800 | l, de });
  m.poke(0x9004, 0x00);
}

// ============================================ f_1B65: bomber launcher

/**
 * Task $10: launch diving attacks. Pending boss/wingman slots in
 * bmbr_boss_pool ($92CA, 4 x 3 bytes) go first; otherwise every 16 frames
 * the three launch timers $92C0-$92C2 count down and an expired one
 * launches a boss, red or yellow alien through d_1BD1.
 * @see galaga-main.asm $1B6B
 * @param {Machine} m
 */
export function f_1B65(m) {
  if (m.peek(0x920b) !== 0) {
    // only while firing is enabled and the capture-boss task is idle
    if (((~m.peek(0x901d)) & m.peek(0x9015) & 0xff) === 0) return;
  }
  let hl = 0x92ca;
  for (let b = 4; b > 0; b -= 1) {
    const a = m.peek(hl);
    if (a !== 0xff) {
      // l_1B8B: launch this queued element
      m.poke(hl, 0xff);
      if (m.peek(0x8800 | (a & 0x7f)) !== 1) return;
      const de = m.peek(hl + 1) | (m.peek(hl + 2) << 8);
      c_1079(m, { hl: 0x8800 | a, de });
      m.poke(0x9ab3, 0x01);
      return;
    }
    hl += 3;
  }
  if (m.peek(0x92a0) & 0x0f) return;
  // l_1BA8
  for (let b = 3; b > 0; b -= 1) {
    const p = 0x92c3 - b;
    const t = (m.peek(p) - 1) & 0xff;
    m.poke(p, t);
    if (t !== 0) continue;
    if (m.peek(0x9287) >= m.peek(0x99c4)) {
      m.poke(p, (t + 1) & 0xff); // too many flying, retry next time
      return;
    }
    m.poke(p, m.peek(p + 4)); // reload the timer
    mainAt(romWord('main', 0x1bd7 + 2 * (b - 1)))(m);
    return;
  }
}

/**
 * Launch the first resting yellow alien ($08-$2E) that is not the bonus bee.
 * @see galaga-main.asm $1BDD
 * @param {Machine} m
 */
export function case_bmbr_yellow(m) {
  l_1BDF(m, 0x14, 0x08, 0x034f);
}

/**
 * Launch the first resting red alien ($40-$5E) that is not the bonus bee.
 * @see galaga-main.asm $1BFD
 * @param {Machine} m
 */
export function case_bmbr_red(m) {
  l_1BDF(m, 0x10, 0x40, 0x03a9);
}

/**
 * Common body of the yellow / red launchers.
 * @see galaga-main.asm $1BE5
 * @param {Machine} m @param {number} b count @param {number} l first object
 * @param {number} de flight data
 */
function l_1BDF(m, b, l, de) {
  const c = m.peek(0x982d); // the bonus bee is never launched here
  for (; b > 0; b -= 1, l += 2) {
    if (m.peek(0x8800 | l) === 1 && c !== l) {
      m.poke(0x9ab3, c);
      c_1083(m, { hl: 0x8800 | l, de });
      return;
    }
  }
}

/**
 * Launch a boss. Every other time (when not already capturing) the first
 * resting boss becomes the capture boss; otherwise a boss is chosen with
 * two wingmen, then one, then alone, else a captured rogue fighter dives.
 * @see galaga-main.asm $1C07
 * @param {Machine} m
 */
export function case_bmbr_boss(m) {
  let capture = m.peek(0x982b) === 0;
  if (capture) {
    const w = (m.peek(0x982c) + 1) & 0xff;
    m.poke(0x982c, w);
    capture = (w & 1) === 0;
  }
  if (capture) {
    for (let b = 4, e = 0x30; b > 0; b -= 1, e += 2) {
      if (m.peek(0x8800 | e) === 1) {
        m.poke(0x982b, 0x01);
        m.poke(0x9828, e);
        j_1CAE(m, { e, b, c: 0, ixl: 2, iy: 0x0454 });
        return;
      }
    }
    return;
  }
  // l_1C30: bit mask of the 6 wingmen (d_1D2C_wingmen, right to left) that
  // are resting; the bonus bee counts as unavailable. The `dec a / sub 1`
  // pair sets Cy exactly when the state was 1.
  let c = 0;
  const bbee = m.peek(0x982d);
  for (let i = 0; i < 6; i += 1) {
    const e = mainRom(0x1d32 + i);
    const cy = bbee !== e && m.peek(0x8800 | e) === 1 ? 1 : 0;
    c = ((c << 1) | cy) & 0xff;
  }
  const ixh = c;
  // First pass: a boss with two adjacent free wingmen (bits 3, 5 or 6 of
  // the three under it). `rr c` rotates the last carry into bit 7: from
  // `cp $03` / `cp $04` when c_1C8D was not called, or from c_1C8D's
  // `cp $01` (Cy = boss state 0) when it was.
  for (let b = 4; b > 0; b -= 1) {
    const a = c & 0x07;
    let cy;
    if (a === 4) cy = 0;
    else if (a < 3) cy = 1;
    else {
      const r = c_1C8D(m, { b, c, ixl: 0 });
      if (r.done) return;
      cy = r.cf ? 1 : 0;
    }
    c = (c >> 1) | (cy << 7);
  }
  // second pass: one free wingman
  c = ixh;
  for (let b = 4; b > 0; b -= 1) {
    let cy = 0; // `and $07` clears Cy
    if ((c & 0x07) !== 0) {
      const r = c_1C8D(m, { b, c, ixl: 1 });
      if (r.done) return;
      cy = r.cf ? 1 : 0;
    }
    c = (c >> 1) | (cy << 7);
  }
  // third pass: any resting boss, alone
  for (let b = 4, e = 0x30; b > 0; b -= 1, e += 2) {
    if (m.peek(0x8800 | e) === 1) {
      j_1CA0(m, { e, b, c, ixl: 2 });
      return;
    }
  }
  // last: a resting captured fighter ($00-$06) dives as a rogue
  for (let l = 0; l < 8; l += 2) {
    if (m.peek(0x8800 | l) === 1) {
      c_1083(m, { hl: 0x8800 | l, de: 0x0444 }); // l_1D25
      return;
    }
  }
}

/**
 * Candidate boss for pass B (4,3,2,1 -> objects $30,$34,$36,$32). If it is
 * resting the Z80 pops its return address and launches it (j_1CA0) --
 * returning straight to the task manager; the port reports that as
 * `done: true`. Otherwise returns with Cy = (state < 1).
 * @see galaga-main.asm $1C93
 * @param {Machine} m
 * @param {{ b: number, c: number, ixl: number }} regs
 * @returns {{ done: boolean, cf: boolean }}
 */
export function c_1C8D(m, { b, c, ixl }) {
  let a = b;
  if (a & 2) a ^= 1;
  const e = (((a & 3) << 1) + 0x30) & 0xff;
  const st = m.peek(0x8800 | e);
  if (st !== 1) return { done: false, cf: st < 1 };
  j_1CA0(m, { e, b, c, ixl });
  return { done: true, cf: false };
}

/**
 * Choose the boss flight: $0411 in play, $00F1 (training) while enemies
 * are disabled; then j_1CAE.
 * @see galaga-main.asm $1CA6
 * @param {Machine} m
 * @param {{ e: number, b: number, c: number, ixl: number }} regs
 */
export function j_1CA0(m, { e, b, c, ixl }) {
  const iy = m.peek(0x920b) !== 0 ? 0x0411 : 0x00f1;
  j_1CAE(m, { e, b, c, ixl, iy });
}

/**
 * Queue a boss sortie in bmbr_boss_pool: slot 0 = boss (bit 7 = right side
 * i.e. bit 1 of the index), its bonus score code for IXL (1600/800/400),
 * up to two wingmen (IXL 0: two, 1: one, 2: none), and the boss's captured
 * fighter if it has one resting.
 * @see galaga-main.asm $1CB4
 * @param {Machine} m
 * @param {{ e: number, b: number, c: number, ixl: number, iy: number }} regs
 *   E boss object, B/C wingman selector and availability bits, IY flight data
 */
export function j_1CAE(m, { e, b, c, ixl, iy }) {
  const rot = (e >> 1) & 1; // Cy' for the whole sortie
  m.poke(0x92ca, (e & 0x7f) | (rot << 7));
  m.poke16(0x92cb, iy);
  const regs = { b: (b + 1) & 0xff, c, de: 0x92cd, iy, cf_: rot };
  // score code pair from d_1CFD[ixl] into plyr_actv.bmbr_boss_scode[e & 7]
  const dst = 0x9830 + (e & 0x07);
  const src = (0x1d03 + 2 * ixl) & 0xffff;
  m.poke(dst, mainRom(src));
  m.poke((dst & 0xff00) | ((dst + 1) & 0xff), mainRom(src + 1));
  if (ixl !== 2) {
    if (ixl === 0) Object.assign(regs, c_1D03(m, regs));
    Object.assign(regs, c_1D03(m, regs));
  }
  // l_1CE3: the boss's captured fighter joins if resting
  const l = m.peek(0x92ca) & 0x07;
  if (m.peek(0x8800 | l) !== 1) return;
  // find a free pool slot after slot 0 (the Z80 loops until it finds $FF)
  let p = 0xca;
  for (let n = 0; ; n += 1) {
    p = (p + 3) & 0xff;
    if (m.peek(0x9200 | p) === 0xff) break;
    if (n > 256) throw new Error('j_1CAE: no free bmbr_boss_pool slot (Z80 would hang)');
  }
  l_1D16(m, { hl: 0x9200 | p, a: l, iy, cf: rot });
}

/**
 * Pick the next free wingman: rotate C right up to twice looking for a set
 * bit (B counts down with it), then take d_1D2C_wingmen[B] and store it in
 * the pool slot at DE.
 * @see galaga-main.asm $1D09
 * @param {Machine} m
 * @param {{ b: number, c: number, de: number, iy: number, cf_: number }} regs cf_ = Cy' (rotation flag)
 * @returns {{ b: number, c: number, de: number }}
 */
export function c_1D03(m, { b, c, de, iy, cf_ }) {
  let cy = c & 1;
  c = rrc(c);
  if (!cy) {
    b = (b - 1) & 0xff;
    cy = c & 1;
    c = rrc(c);
    if (!cy) b = (b - 1) & 0xff;
  }
  const a = b;
  b = (b - 1) & 0xff;
  const obj = mainRom(0x1d32 + a);
  const out = l_1D16(m, { hl: de, a: obj, iy, cf: cf_ });
  return { b, c, de: out.de };
}

/**
 * Store one pool slot at HL: object A with the rotation flag Cy' in bit 7,
 * then the flight pointer IY. Returns DE = HL + 3.
 * @see galaga-main.asm $1D1C
 * @param {Machine} m
 * @param {{ hl: number, a: number, iy: number, cf: number }} regs cf = Cy (1/0)
 * @returns {{ de: number }}
 */
export function l_1D16(m, { hl, a, iy, cf }) {
  // rla / rrca: bit 7 of A replaced by Cy
  m.poke(hl, (a & 0x7f) | ((cf & 1) << 7));
  const h = hl & 0xff00;
  let l = hl & 0xff;
  l = (l + 1) & 0xff;
  m.poke(h | l, iy & 0xff);
  l = (l + 1) & 0xff;
  m.poke(h | l, iy >> 8);
  l = (l + 1) & 0xff;
  return { de: h | l };
}

// ================================================ small periodic tasks

/**
 * Task $0E: move the nest off/on screen at player changeover: the 6 row
 * coordinates step by one per frame (direction from timer bit 7 and flip),
 * and all objects are repositioned; stops itself at count $7E.
 * @see galaga-main.asm $1D38
 * @param {Machine} m
 */
export function f_1D32(m) {
  const tmr = m.peek(0x99b4);
  if ((tmr & 0x7f) === 0x7e) {
    m.poke(0x900e, 0x00);
    return;
  }
  m.poke(0x99b4, (tmr + 1) & 0xff);
  // rlc c / xor c / rrca: Cy = flip.0 XOR timer.7
  const up = ((m.peek(0x9215) ^ (tmr >> 7)) & 1) === 1;
  const step = up ? 0x01 : 0xff;
  for (let i = 0; i < 6; i += 1) {
    const p = 0x9814 + 2 * i;
    const y = add9(m.peek(p), step);
    m.poke(p, y.v);
    if (y.flip) m.poke(p + 1, m.peek(p + 1) ^ 0x01);
  }
  // both halves of the object update (frame count forced to %4 == 1, 3)
  const a = ((m.peek(0x92a0) & 0xfc) + 1) & 0xff;
  MAIN.c_23E0(m, { a });
  MAIN.c_23E0(m, { a: (a + 2) & 0xff });
}

/**
 * Task $12: star scrolling control $99BE from the fighter-on-screen flag
 * $99B9 and the speed ramp $99BA-$99BD (7 stops the stars).
 * @see galaga-main.asm $1D7C
 * @param {Machine} m
 */
export function f_1D76(m) {
  const flip = m.peek(0x9215) & 1;
  if (m.peek(0x99b9) === 0) {
    m.poke(0x99ba, 0x00);
    m.poke(0x99bc, 0x00);
    m.poke(0x99bd, 0x00);
    m.poke(0x99be, 0x07);
    return;
  }
  let a;
  if (m.peek(0x99ba) !== 0) {
    a = 0xfd;
  } else {
    // ramp $99BC towards $99BB, accumulate into the 6-bit phase $99BD;
    // the two carry bits out of it are the speed
    if (m.peek(0x99bb) !== m.peek(0x99bc)) m.poke(0x99bc, (m.peek(0x99bc) + 1) & 0xff);
    const c = (m.peek(0x99bc) + m.peek(0x99bd)) & 0xff;
    m.poke(0x99bd, c & 0x3f);
    a = (c >> 6) & 0x03;
  }
  if (!flip) a = (-a) & 0xff;
  m.poke(0x99be, (a - 1) & 0x07);
}

/**
 * Task $0B: objects hit by a rocket (bit 7 of b_9200_obj_collsn_notif set
 * by the sub CPU) start exploding: state 4, explosion counter $40, colour
 * $0A; the notification keeps its low bits.
 * @see galaga-main.asm $1DB9
 * @param {Machine} m
 */
export function f_1DB3(m) {
  for (let l = 0; l < 0x60; l += 2) {
    const v = m.peek(0x9200 | l);
    if ((v & 0x80) === 0) continue;
    m.poke(0x9200 | l, v & 0x7f);
    m.poke(0x8800 | l, 0x04);
    m.poke(0x8800 | (l + 1), 0x40);
    m.poke(0x8b00 | (l + 1), 0x0a);
  }
}

/**
 * Task $17: count the four game timers $92AC-$92AF down to 0 at 2 Hz.
 * @see galaga-main.asm $1DD8
 * @param {Machine} m
 */
export function f_1DD2(m) {
  if (m.peek(0x92a2) & 0x01) return;
  for (let p = 0x92ac; p < 0x92b0; p += 1) {
    const v = m.peek(p);
    if (v !== 0) m.poke(p, v - 1);
  }
}

/**
 * Task 9: the formation's breathing. Every 4 frames the counter $920F runs
 * $00->$1F (expanding) then $A0->$81 (contracting); every 8 steps a new
 * bitmap row is copied to $9920, and the columns/rows whose bit comes up
 * move one pixel.
 * @see galaga-main.asm $1DEC
 * @param {Machine} m
 */
export function f_1DE6(m) {
  if (m.peek(0x92a0) & 0x03) return;
  const e = m.peek(0x920f); // previous counter
  let d;
  if ((e & 0x80) === 0) {
    d = 0x01;
    m.poke(0x920f, (e + 1) & 0xff);
  } else {
    d = 0xff;
    m.poke(0x920f, (e - 1) & 0xff);
  }
  if (e === 0x1f) m.poke(0x920f, m.peek(0x920f) | 0x80);
  if (e === 0x81) m.poke(0x920f, m.peek(0x920f) & 0x7f);
  const c = m.peek(0x920f);
  m.poke(0x9211, d);
  if ((e & 0x07) === 0) {
    // counter & $18 selects one of the four 16-byte bitmap rows
    m.ldir(0x9920, (0x1e6a + 2 * (c & 0x18)) & 0xffff, 0x10);
  }
  // Cy = bit 7 of the previous counter XOR flip: which half moves which way
  const cy = ((e >> 7) ^ (m.peek(0x9215) & 1)) & 1;
  const b1 = cy ? 0x01 : 0xff;
  const b2 = cy ? 0xff : 0x01;
  const r = c_1E43(m, { hl: 0x9920, de: 0x9900, b: b1, ix: 0x05 });
  c_1E43(m, { hl: r.hl, de: r.de, b: b2, ix: 0x0b });
}

/**
 * Move IXL coordinates by B where the working bitmap at HL says so: `rrc
 * (hl)` both tests and rotates the bitmap byte in RAM. A moving coordinate
 * updates its offset ($99xx even) and its 9-bit position ($98xx pair).
 * @see galaga-main.asm $1E49
 * @param {Machine} m
 * @param {{ hl: number, de: number, b: number, ix: number }} regs IXL = count (low byte of ix)
 * @returns {{ hl: number, de: number }}
 */
export function c_1E43(m, { hl, de, b, ix }) {
  let n = ix & 0xff;
  let l = hl & 0xff;
  let e = de & 0xff;
  const hh = hl & 0xff00;
  do {
    const v = m.peek(hh | l);
    m.poke(hh | l, rrc(v));
    if (v & 1) {
      m.poke(0x9900 | e, (m.peek(0x9900 | e) + b) & 0xff);
      const y = add9(m.peek(0x9800 | e), b);
      m.poke(0x9800 | e, y.v);
      if (y.flip) {
        const e1 = (e + 1) & 0xff;
        m.poke(0x9800 | e1, m.peek(0x9800 | e1) ^ 0x01);
      }
    }
    e = (e + 2) & 0xff;
    l = (l + 1) & 0xff;
    n = (n - 1) & 0xff;
  } while (n !== 0);
  return { hl: hh | l, de: 0x9900 | e };
}

/**
 * Task $0D: move the 8 bombs (sprites $68-$76): Y by 2 or 3 pixels on
 * alternate frames (negated when flipped), X by a 5-bit fixed-point rate
 * with remainder in $92B0 pairs. Rev. B marks every bomb slot that is not
 * a live bomb as a free object ($88xx = $80).
 * @see galaga-main.asm $1EAA
 * @param {Machine} m
 */
export function f_1EA4(m) {
  const b0 = (m.peek(0x92a0) & 0x01) + 2;
  const ixh = m.peek(0x9215) !== 0 ? (-b0) & 0xff : b0;
  let l = 0x68;
  let e = 0xb0;
  for (let n = 8; n > 0; n -= 1) {
    if (m.peek(0x8b00 | l) !== 0x30 || m.peek(0x9300 | l) === 0) {
      m.poke(0x8800 | l, 0x80); // [rev B]
      l = (l + 2) & 0xff;
      e = (e + 2) & 0xff;
      continue;
    }
    const rate = m.peek(0x9200 | e);
    const e1 = (e + 1) & 0xff;
    const c = ((rate & 0x7e) + m.peek(0x9200 | e1)) & 0xff;
    m.poke(0x9200 | e1, c & 0x1f); // keep the remainder mod 32
    e = (e + 2) & 0xff;
    let dx = (c >> 5) & 0x07;
    if (rate & 0x80) dx = (-dx) & 0xff;
    m.poke(0x9300 | l, (m.peek(0x9300 | l) + dx) & 0xff);
    l = (l + 1) & 0xff;
    const y = add9(m.peek(0x9300 | l), ixh);
    m.poke(0x9300 | l, y.v);
    if (y.flip) {
      // rrc (hl) / ccf / rl (hl): toggles bit 0 (sY<8>)
      const v = m.peek(0x9b00 | l);
      const r = rrc(v);
      const cy = (v & 1) ^ 1;
      m.poke(0x9b00 | l, r);
      m.poke(0x9b00 | l, ((r << 1) | cy) & 0xff);
    }
    l = (l + 1) & 0xff;
  }
}

/**
 * Task $15: fire button (bit 4 of io_input[1], or [2] when flipped; active
 * low) launches a rocket.
 * @see galaga-main.asm $1F0E
 * @param {Machine} m
 */
export function f_1F04(m) {
  const l = (m.peek(0x9215) + 0xb6) & 0xff;
  if (m.peek(0x9900 | l) & 0x10) return;
  c_1F0F(m);
}

/**
 * Launch a rocket if one of the two ($64, $66) is free and the fighter is
 * not in a state that forbids it (sprite ctrl bit 2): copy the fighter's
 * position and attributes, choose the rocket sprite and its travel
 * attribute ($92A4/5: orientation, flips, sideways step) from the fighter's
 * rotation, play the shot sound and count the shot.
 * @see galaga-main.asm $1F19
 * @param {Machine} m
 */
export function c_1F0F(m) {
  let rk = 0x64;
  let attr = 0x92a4;
  if (m.peek(0x9364) !== 0) {
    rk = 0x66;
    attr = 0x92a5;
    if (m.peek(0x9366) !== 0) return;
  }
  if (m.peek(0x9b63) & 0x04) return;
  m.poke(0x9b00 | (rk + 1), m.peek(0x9b63)); // ldd: sY<8>
  m.poke(0x9300 | rk, m.peek(0x9362)); // ldi: sX
  m.poke(0x9300 | (rk + 1), m.peek(0x9363)); // ldd: sY<7:0>
  const b = m.peek(0x9b62);
  // doubled width for the two-ship fighter, plus the fighter's flip bits
  m.poke(0x9b00 | rk, (((m.peek(0x9827) & 0x01) << 3) | b) & 0xff);
  let a = m.peek(0x8b62) & 0x07;
  let code = 0x30;
  if (a < 5) {
    code = 0x31;
    if (a < 2) code = 0x33;
  }
  m.poke(0x8b00 | rk, code);
  // codes 4-6: Y is the main axis (bit 6 -> bit 7 after sla), step 7-(a+1)
  if (a >= 4) a = ((~a) + 0x47) & 0xff;
  const c = (a << 1) & 0xff;
  let f = rrc(rrc(rrc(b))) & 0x60;
  if (m.peek(0x9215) === 0) f ^= 0x60;
  m.poke(attr, f | c);
  m.poke(0x8800 | rk, 0x06); // active rocket
  m.poke(0x9aaf, 0x01); // shot sound
  m.poke16(0x9846, (m.peek16(0x9846) + 1) & 0xffff);
}

/**
 * Task $14: move the fighter from the control stick (io_input[1], or [2]
 * when flipped).
 * @see galaga-main.asm $1F8F
 * @param {Machine} m
 */
export function f_1F85(m) {
  const e = m.peek(0x9827);
  const l = (m.peek(0x9215) + 0xb6) & 0xff;
  c_1F92(m, { a: m.peek(0x9900 | l), e });
}

/**
 * Move the fighter by the input bits in A ($02 right, $08 left, active
 * low; swapped when flipped). Holding a direction alternates steps of 1
 * and 2 pixels via the flag $92A3; limits $12 and $E1 ($D1 for the double
 * fighter, whose second ship at $9360 follows 15 pixels to the right).
 * @see galaga-main.asm $1F9C
 * @param {Machine} m
 * @param {{ a: number, e: number }} regs E bit 0 = double fighter
 */
export function c_1F92(m, { a, e }) {
  let bits = a & 0x0a;
  if (bits === 0x0a) {
    m.poke(0x92a3, 0x00);
    return;
  }
  if (m.peek(0x9215) & 0x01) bits ^= 0x0a;
  const flag = m.peek(0x92a3) ^ 0x01;
  m.poke(0x92a3, flag);
  const dx = flag === 0 ? 2 : 1;
  let x = m.peek(0x9362);
  if (x === 0) return;
  if ((bits & 0x02) === 0) {
    // right
    if (x >= 0xd1 && (e & 1)) return;
    if (x >= 0xe1) return;
    x = (x + dx) & 0xff;
  } else {
    if (x < 0x12) return;
    x = (x - dx) & 0xff;
  }
  m.poke(0x9362, x);
  if ((e & 1) === 0) return;
  m.poke(0x9360, (x + 0x0f) & 0xff);
}
