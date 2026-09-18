// Copyright 2026 by Moshix
/**
 * gg1_4b.2l ($3000-$3FFF), part 1 of 4: the length-encoded text writers and
 * the "TOP 5" score table that both the initials-entry dialog and the
 * "GALACTIC HEROES" attract screen draw.
 *
 * Tile RAM is organised in columns: moving one character cell to the RIGHT
 * on the (upright) screen is DE -= $20, moving one row DOWN is +1. That is
 * why every "putc" loop here subtracts $20 (the ROM's rst $20).
 *
 * @see reference/galaga-main.asm $3214-$3344
 * @see reference/neiderm/galag/galagao_ASxxx/rom0/gg1-4.s
 */

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/**
 * `rst $20` ($0020): DE -= $20, one character cell to the right.
 * @param {number} de @returns {number}
 */
export const deMinus20 = (de) => (de - 0x20) & 0xffff;

/**
 * `rst $10` ($0010): HL += A (8-bit add into L, carry into H).
 * @param {number} hl @param {number} a @returns {number}
 */
export const hlPlusA = (hl, a) => (hl + (a & 0xff)) & 0xffff;

/**
 * The ROM's "HL -= $20" idiom: `ld a,$E0 / dec h / add a,l / jr nc,+1 /
 * inc h / ld l,a` (or `dec h / rst $10` with A=$E0) -- subtract $100, add
 * $E0 with the carry going back into H. Net effect HL -= $20.
 * @param {number} hl @returns {number}
 */
export const hlMinus20 = (hl) => (hl - 0x20) & 0xffff;

/**
 * c_text_out ($331B): copy a length-encoded string to tile RAM, colour
 * untouched. String layout: dest LSB, dest MSB, count, then the characters.
 * @see galaga-main.asm $331B
 * @param {Machine} m
 * @param {{ hl: number }} regs  HL = address of the string (ROM)
 * @returns {{ hl: number, de: number }} HL = next string, DE = next cell
 */
export function c_text_out(m, { hl }) {
  let de = m.read('main', hl) | (m.read('main', hl + 1) << 8);
  let b = m.read('main', hl + 2);
  hl = (hl + 3) & 0xffff;
  // djnz: a count of 0 would mean 256 (never happens in the ROM's strings).
  do {
    m.poke(de, m.read('main', hl));
    hl = (hl + 1) & 0xffff;
    de = deMinus20(de);
    b = (b - 1) & 0xff;
  } while (b !== 0);
  return { hl, de };
}

/**
 * c_text_out_ce ($3328): like c_text_out, but the string also carries a
 * colour byte that is written to colour RAM (tile address + $400, `set 2,h`)
 * for every character. Layout: dest LSB, dest MSB, count, colour, text.
 * @see galaga-main.asm $3328
 * @param {Machine} m
 * @param {{ hl: number }} regs  HL = address of the string (ROM)
 * @returns {{ hl: number, de: number }} HL = next string, DE = next cell
 */
export function c_text_out_ce(m, { hl }) {
  let dst = m.read('main', hl) | (m.read('main', hl + 1) << 8);
  let b = m.read('main', hl + 2);
  const c = m.read('main', hl + 3);
  let src = (hl + 4) & 0xffff;
  // 0x3330: ex de,hl -- HL walks the screen, DE the string.
  do {
    m.poke(dst, m.read('main', src));
    m.poke(dst | 0x0400, c); // set 2,h: colour RAM; res 2,h undoes it
    src = (src + 1) & 0xffff;
    dst = hlMinus20(dst);
    b = (b - 1) & 0xff;
  } while (b !== 0);
  // 0x3343: ex de,hl again.
  return { hl: src, de: dst };
}

/**
 * c_3270 ($3270): putc (HL) at DE, HL++, then falls into c_3273 (DE -= $20).
 * @see galaga-main.asm $3270
 * @param {Machine} m
 * @param {{ hl: number, de: number }} regs
 * @returns {{ hl: number, de: number }}
 */
export function c_3270(m, { hl, de }) {
  m.poke(de, m.read('main', hl));
  return { hl: (hl + 1) & 0xffff, de: deMinus20(de) };
}

/**
 * c_3273 ($3273): DE -= $20 (one cell to the right), via rst $20.
 * @see galaga-main.asm $3273
 * @param {Machine} m
 * @param {{ de: number }} regs
 * @returns {{ de: number }}
 */
export function c_3273(m, { de }) {
  return { de: deMinus20(de) };
}

/**
 * c_3275 ($3275): copy a 6-digit score string, reading HL downwards (the
 * scores are stored lowest digit first, HL points at the 100000's digit)
 * and writing DE rightwards.
 * @see galaga-main.asm $3275
 * @param {Machine} m
 * @param {{ hl: number, de: number }} regs
 * @returns {{ hl: number, de: number }}
 */
export function c_3275(m, { hl, de }) {
  for (let c = 6; c > 0; c -= 1) {
    m.poke(de, m.read('main', hl));
    hl = (hl - 1) & 0xffff;
    de = deMinus20(de);
  }
  return { hl, de };
}

/**
 * c_3231 ($3231): draw one line of the TOP 5 table: rank digit, "ST"/"ND"/
 * "RD"/"TH", the score and the initials. Driven by the 8-byte records at
 * s_32C5: screen address, two suffix characters, pointer to the score's
 * 100000's digit, pointer to the initials.
 * @see galaga-main.asm $3231
 * @param {Machine} m
 * @param {{ b: number }} regs  B = rank 1-5
 * @returns {{ b: number, de: number }} B = rank + 1
 */
export function c_3231(m, { b }) {
  // (B-1)*8 in 8 bits, then rst $10.
  let hl = hlPlusA(0x32c5, (((b - 1) & 0xff) << 3) & 0xff);
  let de = m.read('main', hl) | (m.read('main', hl + 1) << 8);
  hl += 2;
  m.poke(de, b); // the rank digit (character codes 0-9 are the digits)
  de = deMinus20(de);
  ({ hl, de } = c_3270(m, { hl, de })); // 'S' of "ST"
  ({ hl, de } = c_3270(m, { hl, de })); // 'T'
  de = deMinus20(deMinus20(de)); // two blank cells
  const score = m.read('main', hl) | (m.read('main', hl + 1) << 8);
  const namePtr = hl + 2; // 0x3253: push hl
  ({ de } = c_3275(m, { hl: score, de }));
  // 0x3259: ld a,e / sub $C0 / ld e,a / jr nc / dec d -- DE -= $C0.
  de = (de - 0xc0) & 0xffff;
  hl = m.read('main', namePtr) | (m.read('main', namePtr + 1) << 8);
  for (let i = 0; i < 3; i += 1) ({ hl, de } = c_3270(m, { hl, de }));
  return { b: (b + 1) & 0xff, de };
}

/**
 * c_puts_top5scores ($321D): "SCORE     NAME" and the five table lines.
 * Lines 1-4 are calls to c_3231, line 5 is the fall-through into it.
 * @see galaga-main.asm $321D
 * @param {Machine} m
 */
export function c_puts_top5scores(m) {
  c_text_out(m, { hl: 0x32b4 });
  let b = 1;
  for (let i = 0; i < 5; i += 1) ({ b } = c_3231(m, { b }));
}

/**
 * c_mach_hiscore_show ($3214): the attract-mode "THE GALACTIC HEROES /
 * -- BEST 5 --" screen, then the table (falls into c_puts_top5scores).
 * Called from the attract-mode state machine at $17EC.
 * @see galaga-main.asm $3214
 * @param {Machine} m
 */
export function c_mach_hiscore_show(m) {
  const { hl } = c_text_out_ce(m, { hl: 0x3345 }); // "THE GALACTIC HEROES"
  c_text_out_ce(m, { hl }); // "-- BEST 5 --" at $335C
  c_puts_top5scores(m);
}
