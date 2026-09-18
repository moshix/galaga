// Copyright 2026 by Moshix
/**
 * gg1_4b.2l ($3000-$3FFF), part 2 of 4: the high-score "ENTER YOUR
 * INITIALS !" dialog (c_top5_dlg_proc), called from the game-over sequence
 * at $0547.
 *
 * RAM it uses (all in RAM 1):
 *   $8A00-01  pointer to the active player's on-screen score (100000's digit)
 *   $8A02     previous stick state (L=$02, R=$08, as bits of the input byte)
 *   $8A03     auto-repeat counter for the stick (a step every 16 frames)
 *   $8A04-05  pointer to the name slot being filled, minus one
 *   $8A10     low byte of the tile address of the initial being edited
 *             ($49, $29, $09: three cells, rightwards = -$20)
 *   $8A11     rank achieved, 1-5
 *   $8A20-3D  five 6-digit scores, lowest digit first; $8A3E-4C initials
 *
 * Character codes: $00-$09 digits, $0A-$23 'A'-'Z', $24 space, $2A '.'.
 *
 * @see reference/galaga-main.asm $3000-$3213, $32ED-$331A
 */

import { mainAt } from './routines.js';
import { romWord } from '../romdata.js';
import {
  c_text_out, c_text_out_ce, c_3275, c_puts_top5scores,
} from './gg1_4_text.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/** `ld bc,n / lddr`: byte-wise copy downwards, as the Z80 does it. */
function lddr(m, hl, de, count) {
  for (let i = 0; i < count; i += 1) {
    m.poke(de, m.peek(hl));
    hl = (hl - 1) & 0xffff;
    de = (de - 1) & 0xffff;
  }
  return { hl, de };
}

/**
 * c_31F7_chk_score_rank ($31F7): compare the player's on-screen score
 * (pointer at $8A00) with one table entry, most significant digit first.
 * Leading blanks ($24) are how short numbers are written: a blank in the
 * table digit vs a digit on screen means the player is ahead; a blank in
 * the player's digit (with a table digit present) means "not ahead".
 * Only L and E are decremented (8-bit), as in the ROM.
 * @see galaga-main.asm $31F7
 * @param {Machine} m
 * @param {{ de: number }} regs  DE = 100000's digit of the table entry
 * @returns {{ a: number, cf: boolean, zf: boolean }} Cy = player's score is higher
 */
export function c_31F7_chk_score_rank(m, { de }) {
  let hl = m.peek16(0x8a00);
  for (let b = 6; b > 0; b -= 1) {
    let a = m.peek(de);
    if (a === 0x24) {
      // l_320E: table digit is a blank.
      if (m.peek(hl) !== 0x24) {
        // 0x3211: xor a, then "cp (hl)" at l_3206 with A = 0.
        a = 0;
        const s = m.peek(hl);
        if (s !== 0) return { a, cf: a < s, zf: false };
      }
    } else {
      const s = m.peek(hl);
      // 0x3202: cp $24 / ret z -- Z set, carry clear (A == $24).
      if (s === 0x24) return { a: s, cf: false, zf: true };
      // l_3206: cp (hl) / ret nz -- Cy when table digit < score digit.
      if (a !== s) return { a, cf: a < s, zf: false };
    }
    // l_3208: dec l / dec e -- 8-bit only.
    hl = (hl & 0xff00) | ((hl - 1) & 0xff);
    de = (de & 0xff00) | ((de - 1) & 0xff);
  }
  return { a: 0, cf: false, zf: true }; // 0x320C: xor a
}

/**
 * The lddr of 6 bytes at 0x31CE / the first half of l_31BA: move the 4th
 * place score down to 5th place.
 * @param {Machine} m
 */
function shiftScore4To5(m) {
  lddr(m, 0x8a37, 0x8a3d, 6);
}

/**
 * case_31D9 ($31D9): copy the player's score into the table slot of rank
 * ($8A11), from the pointer table at $31ED.
 * @see galaga-main.asm $31D9
 * @param {Machine} m
 */
export function case_31D9(m) {
  const a = (m.peek(0x8a11) - 1) & 0xff;
  const de = romWord('main', (0x31ed + 2 * a) & 0xffff);
  lddr(m, m.peek16(0x8a00), de, 6);
}

/**
 * l_31BA: shift the 4th score into 5th place, then A more bytes down by
 * 6 (making room at the new rank), then store the new score.
 * @param {Machine} m @param {number} a byte count of the second lddr
 */
function l_31BA(m, a) {
  shiftScore4To5(m);
  // After the first lddr HL = $8A31; DE is reloaded with $8A37 (0x31C5).
  lddr(m, 0x8a31, 0x8a37, a);
  case_31D9(m);
}

/**
 * case_31B0 ($31B0): new 1st place -- shift 1st-4th down.
 * @see galaga-main.asm $31B0 @param {Machine} m
 */
export function case_31B0(m) { l_31BA(m, 0x12); }
/**
 * case_31B4 ($31B4): new 2nd place -- shift 2nd-4th down.
 * @see galaga-main.asm $31B4 @param {Machine} m
 */
export function case_31B4(m) { l_31BA(m, 0x0c); }
/**
 * case_31B8 ($31B8): new 3rd place -- shift 3rd-4th down.
 * @see galaga-main.asm $31B8 @param {Machine} m
 */
export function case_31B8(m) { l_31BA(m, 0x06); }
/**
 * case_31CE ($31CE): new 4th place -- shift 4th down.
 * @see galaga-main.asm $31CE @param {Machine} m
 */
export function case_31CE(m) {
  shiftScore4To5(m);
  case_31D9(m);
}

/**
 * c_3118_insert_top5_score ($3118): `ld a,(hl) / inc hl / ld h,(hl) /
 * ld l,a / jp (hl)` through the jump table d_31A6 (one entry per rank).
 * @see galaga-main.asm $3118
 * @param {Machine} m
 * @param {{ hl: number }} regs  HL = entry in d_31A6
 */
export function c_3118_insert_top5_score(m, { hl }) {
  mainAt(romWord('main', hl))(m, {});
}

/**
 * c_3138_lda2A ($3138): A = $2A ('.').
 * @see galaga-main.asm $3138 @returns {{ a: number }}
 */
export const c_3138_lda2A = () => ({ a: 0x2a });
/**
 * c_313B_lda24 ($313B): A = $24 (space).
 * @see galaga-main.asm $313B @returns {{ a: number }}
 */
export const c_313B_lda24 = () => ({ a: 0x24 });
/**
 * c_313E_lda0A ($313E): A = $0A ('A').
 * @see galaga-main.asm $313E @returns {{ a: number }}
 */
export const c_313E_lda0A = () => ({ a: 0x0a });

/**
 * c_3141_xor_char_color ($3141): blink the initial being edited by
 * toggling its colour between 0 (cyan) and 5 (yellow).
 * @see galaga-main.asm $3141
 * @param {Machine} m
 */
export function c_3141_xor_char_color(m) {
  const hl = 0x8500 | m.peek(0x8a10);
  m.poke(hl, m.peek(hl) ^ 0x05);
}

/**
 * c_plyr_initials_entry_hilite_line ($3180): paint the player's line of
 * the TOP 5 table yellow (22 colour cells from d_3197_hiscore_line_ptrs).
 * @see galaga-main.asm $3180
 * @param {Machine} m
 */
export function c_plyr_initials_entry_hilite_line(m) {
  const a = (m.peek(0x8a11) - 1) & 0xff;
  let hl = romWord('main', (0x3197 + 2 * a) & 0xffff);
  for (let b = 0x16; b > 0; b -= 1) {
    m.poke(hl, 0x05);
    hl = (hl + 0xffe0) & 0xffff; // add hl,de with DE = -$20
  }
}

/**
 * c_32ED_top5_dlg_endproc ($32ED): polled once per loop iteration. Ends
 * the dialog when a coin went in (the 51XX credit count at $99B5 exceeds
 * the game's own count at $99B8, unless free play reads $A0) or when the
 * 20-second timer $92AE ran out. Ending copies whatever initials the
 * player had not confirmed yet from the screen into the name slot.
 *
 * In the ROM the "end" path does `pop hl` to drop its own return address
 * and so returns straight to the caller of c_top5_dlg_proc; the port
 * returns true instead and c_top5_dlg_proc returns.
 * @see galaga-main.asm $32ED
 * @param {Machine} m
 * @returns {boolean} true when the dialog is over
 */
export function c_32ED_top5_dlg_endproc(m) {
  const a = m.peek(0x99b5);
  // 0x32F0: cp $A0 -- free play: only the timer can end the dialog.
  const coinIn = a !== 0xa0 && m.peek(0x99b8) < a;
  if (!coinIn && m.peek(0x92ae) !== 0) return false;
  // l_3300_finish.
  let hl = 0x8100 | m.peek(0x8a10);
  let de = (m.peek16(0x8a04) + 1) & 0xffff;
  // l_330C: ldi, then HL -= $21 done as "dec h / add a,l with A=$DF /
  // inc h on carry". The loop ends when there was no carry: then H stays
  // $80 and bit 0 of H is clear. L is $49/$29/$09 for the three initials,
  // so this copies the remaining 3, 2 or 1 characters.
  for (;;) {
    m.poke(de, m.peek(hl)); // ldi
    de = (de + 1) & 0xffff;
    hl = (hl + 1) & 0xffff;
    let h = (hl >> 8) - 1;
    const sum = 0xdf + (hl & 0xff);
    if (sum > 0xff) h += 1;
    hl = ((h & 0xff) << 8) | (sum & 0xff);
    if (!(h & 1)) break;
  }
  return true;
}

/**
 * The part of j_314C_select_char ($314C) up to the carry test: accept the
 * character under the cursor into the name slot, move the cursor right.
 * @param {Machine} m
 * @returns {boolean} true when that was the 3rd initial (`sub $20` borrowed)
 */
function selectChar(m) {
  const l = m.peek(0x8a10);
  m.poke(0x8500 | l, 0x00); // colour back to cyan
  const c = m.peek(0x8100 | l);
  m.poke(0x92ae, 0x28); // 20 seconds
  const hl = (m.peek16(0x8a04) + 1) & 0xffff;
  m.poke(hl, c);
  m.poke16(0x8a04, hl);
  m.poke(0x8a10, (l - 0x20) & 0xff);
  return l < 0x20;
}

/**
 * Stick right ($311D) / left ($30FD): step the character under the cursor
 * through 'A'..'Z', ' ', '.' (wrapping) and restart the 20 s timer.
 * @param {Machine} m @param {boolean} right
 */
function stepChar(m, right) {
  const hl = 0x8100 | m.peek(0x8a10);
  m.poke(0x92ae, 0x28);
  let a;
  if (right) {
    a = (m.peek(hl) + 1) & 0xff;
    if (a === 0x2b) a = 0x0a; // past '.' -> 'A'
    if (a === 0x25) a = 0x2a; // past ' ' -> '.'
  } else {
    a = (m.peek(hl) - 1) & 0xff;
    if (a === 0x09) a = 0x2a; // before 'A' -> '.'
    if (a === 0x29) a = 0x24; // before '.' -> ' '
  }
  m.poke(hl, a);
}

/**
 * c_top5_dlg_proc ($3000): at game over, check whether the active player's
 * score made the TOP 5; if so insert it, run the "ENTER YOUR INITIALS !"
 * dialog and return when the three initials are in (plus a 3-second wait
 * for the music), the 20-second timer expires, or a coin is inserted.
 *
 * A GENERATOR: it waits on the frame counter $92A0 and the game timer
 * $92AE, both advanced by interrupt handlers, yielding once per frame.
 * @see galaga-main.asm $3000
 * @param {Machine} m
 * @returns {Generator<undefined, void, void>}
 */
export function* c_top5_dlg_proc(m) {
  m.poke16(0x8a00, m.peek(0x9840) === 0 ? 0x83fd : 0x83e8);
  if (!c_31F7_chk_score_rank(m, { de: 0x8a3d }).cf) return;
  // Walk up the table; the first entry the score does not beat fixes the
  // rank (tune $9AB0 = rank), beating 1st place selects tune $9AAC.
  let rank = 1;
  for (const [de, r] of [[0x8a37, 5], [0x8a31, 4], [0x8a2b, 3], [0x8a25, 2]]) {
    if (!c_31F7_chk_score_rank(m, { de }).cf) { rank = r; break; }
  }
  if (rank === 1) m.poke(0x9aac, 0xff);
  else m.poke(0x9ab0, rank);
  m.poke(0x8a11, rank);
  c_3118_insert_top5_score(m, { hl: 0x31a6 + 2 * (rank - 1) });

  // 0x3055: shift the names below the new rank down (d_31A1 byte counts).
  const n = m.read('main', 0x31a1 + rank - 1);
  let hl = 0x8a49;
  if (n !== 0) ({ hl } = lddr(m, 0x8a49, 0x8a4c, n));
  // l_306C: blank the new name; $8A04 = &name[0] - 1. `inc l` is 8-bit.
  m.poke16(0x8a04, hl);
  for (let b = 0; b < 3; b += 1) {
    hl = (hl & 0xff00) | ((hl + 1) & 0xff);
    m.poke(hl, 0x24);
  }
  m.poke(0x8a10, 0x49);
  let s = c_text_out_ce(m, { hl: 0x327f }).hl; // "ENTER YOUR INITIALS !"
  s = c_text_out(m, { hl: s }).hl; // "SCORE       NAME"
  c_text_out_ce(m, { hl: s }); // "TOP 5"
  c_3275(m, { hl: m.peek16(0x8a00), de: 0x8309 });
  // "AAA" under NAME.
  m.poke(0x8149, 0x0a);
  m.poke(0x8129, 0x0a);
  m.poke(0x8109, 0x0a);
  c_puts_top5scores(m);
  c_plyr_initials_entry_hilite_line(m);

  // 0x30A5: wait for timer 2 ($92AE, counts down every half second).
  m.poke(0x92ae, 0x04);
  while (m.peek(0x92ae) !== 0) yield;
  m.poke(0x92ae, 0x28);

  for (;;) {
    // l_30B5_next_char_selectn
    c_puts_top5scores(m);
    c_plyr_initials_entry_hilite_line(m);
    let c = m.peek(0x92a0);
    let nextChar = false;
    // The switch bytes as they were before this frame's vblank. On the board
    // the handler starts the 51XX read ($71 at $02A3) as its last act and the
    // bytes arrive by NMI about a thousand cycles later -- after this loop has
    // already woken on the $92A0 tick and read $99B6. So the ROM always acts
    // on the previous frame's switches; the port's read lands inside the
    // handler, so it keeps its own copy from before the tick.
    let stale = [m.peek(0x99b6), m.peek(0x99b7)];
    while (!nextChar) {
      // l_30BF_dlg_proc: poll the exit conditions, then wait for a frame.
      if (c_32ED_top5_dlg_endproc(m)) return;
      const a = m.peek(0x92a0);
      if (a === c) {
        stale = [m.peek(0x99b6), m.peek(0x99b7)];
        yield;
        continue;
      }
      c = a;
      if ((a & 0x0f) === 0) c_3141_xor_char_color(m); // blink 4x a second
      // Player 1's panel ($99B6), or player 2's ($99B7) when the cocktail
      // screen is flipped for player 2.
      const input = stale[m.peek(0x9215) === 0 ? 0 : 1];
      if (!(input & 0x10)) {
        // j_314C_select_char: fire button (active low).
        if (!selectChar(m)) { nextChar = true; continue; }
        // Third initial accepted: show it, wait for the tune (the frame
        // counter runs from $4C up to $00 = 180 frames), return.
        c_puts_top5scores(m);
        c_plyr_initials_entry_hilite_line(m);
        m.poke(0x92a0, 0x4c);
        while (m.peek(0x92a0) !== 0) yield;
        return;
      }
      // 0x30DD: stick auto-repeat. A change of state restarts the counter
      // at $FD so the first step happens on the next frame ($FD+3 = $00).
      const stick = input & 0x0a;
      if (stick !== m.peek(0x8a02)) {
        m.poke(0x8a02, stick);
        m.poke(0x8a03, 0xfd);
      }
      const cnt = (m.peek(0x8a03) + 1) & 0xff;
      m.poke(0x8a03, cnt);
      if (cnt & 0x0f) continue;
      const st = m.peek(0x8a02);
      if (st === 0x08) stepChar(m, true); // L=$02 R=$08 (active low bits)
      else if (st === 0x02) stepChar(m, false);
    }
  }
}
