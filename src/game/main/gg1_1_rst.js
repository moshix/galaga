// Copyright 2026 by Moshix
/**
 * Main CPU $0000-$003F: the RST vectors and the two tiny routines that
 * share their page (int.s).
 *
 * The RST helpers are a handful of bytes each. Code in every range of the
 * main ROM uses them, so they are registered in MAIN under their listing
 * labels (and a plain `rst_XX` alias for the ones whose label is odd).
 *
 * @see reference/galaga-main.asm $0000-$0051
 */

import { MAIN, mainAt } from './routines.js';

/**
 * @typedef {import('../../machine/machine.js').Machine} Machine
 */

/**
 * `rst $08`: HL += 2A.
 *
 *   $0008: add a,a / jr nc,$0010 / inc h / jp $0010
 *
 * The doubling's carry goes into H, then rst $10 adds the doubled A.
 * @see galaga-main.asm $0008
 * @param {Machine} _m unused
 * @param {{ a: number, hl: number }} regs
 * @returns {{ a: number, hl: number, cf: boolean }} A = L + 2A (low byte)
 */
export function rst_08(_m, { a, hl }) {
  const a2 = (a << 1) & 0x1ff;
  let h = (hl >> 8) & 0xff;
  if (a2 > 0xff) h = (h + 1) & 0xff;
  return rst_HLplusA(_m, { a: a2 & 0xff, hl: (h << 8) | (hl & 0xff) });
}

/**
 * `rst $10`: HL += A.
 *
 *   $0010: add a,l / ld l,a / ret nc / inc h / ret
 *
 * A is left holding the new L; the carry flag is the carry out of L (the
 * `inc h` does not touch it).
 * @see galaga-main.asm $0010
 * @param {Machine} _m unused
 * @param {{ a: number, hl: number }} regs
 * @returns {{ a: number, hl: number, cf: boolean }}
 */
export function rst_HLplusA(_m, { a, hl }) {
  const sum = (a & 0xff) + (hl & 0xff);
  const l = sum & 0xff;
  let h = (hl >> 8) & 0xff;
  const cf = sum > 0xff;
  if (cf) h = (h + 1) & 0xff;
  return { a: l, hl: (h << 8) | l, cf };
}

/**
 * `rst $18`: memset((HL), A, B). B == 0 means 256 (djnz).
 *
 *   $0018: ld (hl),a / inc hl / djnz $0018 / ret
 *
 * @see galaga-main.asm $0018
 * @param {Machine} m
 * @param {{ a: number, b: number, hl: number }} regs
 * @returns {{ a: number, b: number, hl: number }} HL past the last byte, B = 0
 */
export function rst_18(m, { a, b, hl }) {
  const count = b === 0 ? 256 : b;
  for (let i = 0; i < count; i += 1) m.poke((hl + i) & 0xffff, a);
  return { a: a & 0xff, b: 0, hl: (hl + count) & 0xffff };
}

/**
 * `rst $20`: DE -= $20 (one character cell to the right on screen).
 *
 *   $0020: ld a,e / sub $20 / ld e,a / ret nc / dec d / ret
 *
 * Also reached by `jp $0020` from c_0A6E.
 * @see galaga-main.asm $0020
 * @param {Machine} _m unused
 * @param {{ de: number }} regs
 * @returns {{ a: number, de: number }} A == the new E
 */
export function rst_DEminus20(_m, { de }) {
  const de2 = (de - 0x20) & 0xffff;
  return { a: de2 & 0xff, de: de2 };
}

/**
 * `rst $28`: memset($9100, 0, $F0) -- the object motion pool.
 *
 *   $0028: ld hl,$9100 / ld b,$F0 / xor a / rst $18 / ret
 *
 * @see galaga-main.asm $0028
 * @param {Machine} m
 * @returns {{ a: number, b: number, hl: number }}
 */
export function rst_28(m) {
  return rst_18(m, { a: 0, b: 0xf0, hl: 0x9100 });
}

/**
 * `rst $30`: print string number C at its own (encoded) position.
 *
 *   $0030: scf / ex af,af' / jp $13B5
 *
 * The carry is passed through AF' to tell j_string_out_pe ($13B5, in the
 * $1000 range) to take the screen position from the string table. It is
 * passed as `af_` (AF' as a register pair; bit 0 = Cy'). Only the flag
 * matters: j_string_out_pe never looks at A'.
 * @see galaga-main.asm $0030
 * @param {Machine} m
 * @param {{ c: number, de?: number }} regs C = string index; DE is preserved
 * @returns {{ hl: number }} HL = screen position after the last character
 */
export function rst_30(m, { c, de }) {
  return MAIN.j_string_out_pe(m, { c, de, af_: 0x0001 });
}

/**
 * $003B c_task_switcher: `jp (hl)`. The task manager "calls" it so the
 * task's `ret` comes back to the scheduler loop.
 * @see galaga-main.asm $003B
 * @param {Machine} m
 * @param {{ hl: number }} regs task address
 * @returns {unknown} whatever the task returns
 */
export function c_task_switcher(m, { hl }) {
  return mainAt(hl)(m);
}

/**
 * $003C c_sctrl_sprite_ram_clr: clear the sprite position and control
 * buffers, and fill the sprite object status buffer at $8800 with $80.
 * @see galaga-main.asm $003C
 * @param {Machine} m
 * @returns {{ a: number, b: number, hl: number }}
 */
export function c_sctrl_sprite_ram_clr(m) {
  rst_18(m, { a: 0, b: 0x80, hl: 0x9300 });
  rst_18(m, { a: 0, b: 0x80, hl: 0x9b00 });
  return rst_18(m, { a: 0x80, b: 0x80, hl: 0x8800 });
}
