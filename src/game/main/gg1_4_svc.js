// Copyright 2026 by Moshix
/**
 * gg1_4b.2l ($3000-$3FFF), part 3 of 4: the plain (non-waiting) helpers of
 * the power-on test and the service ("self-test") mode: the dip switch
 * report, the sound test, the machine totals, the easter egg, screen and
 * sprite clearing.
 *
 * Dip switches read as $6800+n: bit 0 = DSWB bit n, bit 1 = DSWA bit n
 * (Machine.readDsw). The switch report writes the machine configuration the
 * game then uses: $9980-81 bonus levels, $9982 fighters - 1, $9983 cabinet
 * (0 upright, 1 table), $9984 rank, and $9280-87 the 51XX credit-mode
 * command bytes.
 *
 * @see reference/galaga-main.asm $3770-$3B9E
 */

import { romWord } from '../romdata.js';
import { c_text_out, deMinus20, hlPlusA, hlMinus20 } from './gg1_4_text.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/**
 * c_io_cmd_wait ($37F6): spin until the 06XX control register reads $10
 * (transfer complete). The port performs every 06XX transfer at once in
 * m.io.transfer(), so there is never anything to wait for.
 * @see galaga-main.asm $37F6, docs/porting-guide.md section 7
 * @returns {{ a: number, zf: boolean }} A = $10, Z set, as on return
 */
export function c_io_cmd_wait() {
  return { a: 0x10, zf: true };
}

/**
 * c_tileram_regs_clr ($3962): fill tile RAM with spaces ($24) and colour
 * RAM with colour 3. The first `ldir` copies $400 bytes starting from
 * $8000 to $8001, so its last byte lands on $8400, which the second fill
 * then overwrites -- both writes are reproduced. Sets the starfield
 * control byte $99BE to 7.
 * @see galaga-main.asm $3962
 * @param {Machine} m
 */
export function c_tileram_regs_clr(m) {
  m.poke(0x8000, 0x24);
  m.ldir(0x8001, 0x8000, 0x400);
  m.poke(0x8400, 0x03);
  m.ldir(0x8401, 0x8400, 0x3ff);
  m.poke(0x99be, 0x07);
}

/**
 * c_spriteposn_regs_init ($397C): park all 64 sprites off screen ($F1 in
 * every byte of the position registers $9380-$93FF).
 * @see galaga-main.asm $397C
 * @param {Machine} m
 */
export function c_spriteposn_regs_init(m) {
  m.fill(0x9380, 0xf1, 0x80);
}

/**
 * c_svc_clr_snd_regs ($3A46): zero the $40 bytes of sound-effect triggers
 * and state at $9AA0.
 * @see galaga-main.asm $3A46
 * @param {Machine} m
 */
export function c_svc_clr_snd_regs(m) {
  m.fill(0x9aa0, 0x00, 0x40);
}

/**
 * State threaded through the machine-totals digit writers: the Z80 keeps
 * it in HL (source), DE (screen) and C (digits until the next '.').
 * @typedef {{ hl: number, de: number, c: number }} DigitCursor
 */

/**
 * c_39AE ($39AE): put the low nibble of A at DE, step right; every C
 * digits also put a '.' ($2A) and reload C with 4.
 * @see galaga-main.asm $39B8
 * @param {Machine} m
 * @param {{ a: number, de: number, c: number, hl?: number }} regs
 * @returns {DigitCursor}
 */
export function c_39AE(m, { a, de, c, hl = 0 }) {
  m.poke(de, a & 0x0f);
  de = deMinus20(de);
  c = (c - 1) & 0xff;
  if (c === 0) {
    c = 0x04;
    m.poke(de, 0x2a);
    de = deMinus20(de);
  }
  return { hl, de, c };
}

/**
 * c_39AA ($39AA): one digit, the low nibble of $99 - (HL) (the totals are
 * shown as "remaining" = 99..9 minus the count), then HL++.
 * @see galaga-main.asm $39B4
 * @param {Machine} m
 * @param {DigitCursor} regs
 * @returns {DigitCursor}
 */
export function c_39AA(m, { hl, de, c }) {
  const a = (0x99 - m.peek(hl)) & 0xff;
  return c_39AE(m, { a, de, c, hl: (hl + 1) & 0xffff });
}

/**
 * c_39A0 ($39A0): two digits of $99 - (HL): the high nibble (four `rra`
 * through carry; the carry bits land in bits 4-7, which `and $0F` in
 * c_39AE discards), then falls into c_39AA for the low nibble and HL++.
 * @see galaga-main.asm $39AA
 * @param {Machine} m
 * @param {DigitCursor} regs
 * @returns {DigitCursor}
 */
export function c_39A0(m, { hl, de, c }) {
  const a = (0x99 - m.peek(hl)) & 0xff;
  ({ de, c } = c_39AE(m, { a: a >> 4, de, c, hl }));
  return c_39AA(m, { hl, de, c });
}

/**
 * c_3997 ($3997): one digit via c_39AA, then B pairs via c_39A0.
 * @see galaga-main.asm $39A1
 * @param {Machine} m
 * @param {DigitCursor & { b: number }} regs
 * @returns {DigitCursor}
 */
export function c_3997(m, { hl, de, c, b }) {
  let cur = c_39AA(m, { hl, de, c });
  for (let n = b; n > 0; n -= 1) cur = c_39A0(m, cur);
  return cur;
}

/**
 * c_svc_machine_totals ($3987): the bookkeeping line "XX.XYYY.YYYY.ZZZZ.
 * ZAAA." at the bottom of the service screen, from the BCD counters at
 * $99E0 (plays), $99E2 (score sum), $99E6 (play time, its 1/60 s byte is
 * skipped) and $99EB (bonus count), each shown as 9..9 minus the count.
 * @see galaga-main.asm $3987
 * @param {Machine} m
 */
export function c_svc_machine_totals(m) {
  let cur = { hl: 0x99e0, de: 0x835e, c: 0x02 };
  cur = c_3997(m, { ...cur, b: 1 });
  cur = c_3997(m, { ...cur, b: 3 });
  cur = c_3997(m, { ...cur, b: 2 });
  cur.hl = (cur.hl + 1) & 0xffff; // 0x399E: inc hl, skip the 1/60ths
  c_3997(m, { ...cur, b: 1 }); // the fall-through into c_3997
}

/**
 * c_svc_machine_ttls_erase ($39C5): blank the 23 cells of the totals line.
 * @see galaga-main.asm $39C5
 * @param {Machine} m
 */
export function c_svc_machine_ttls_erase(m) {
  let hl = 0x835e;
  for (let b = 0x17; b > 0; b -= 1) {
    m.poke(hl, 0x24);
    hl = (hl + 0xffe0) & 0xffff;
  }
}

/**
 * j_39FC ($3A06): clamp the sound-test selection $9270 to 0-$11 and show
 * it as "SOUND nn".
 * @param {Machine} m
 */
function showSoundSelection(m) {
  let a = m.peek(0x9270);
  if (a >= 0x12) a = 0;
  m.poke(0x9270, a);
  let c = 0x00;
  if (a >= 0x0a) { c = 0x01; a -= 0x0a; }
  m.poke(0x822e, c);
  m.poke(0x820e, a); // 0x3A1F: ld l,$0E
  c_text_out(m, { hl: 0x3a51 }); // "SOUND"
}

/**
 * c_svc_test_sound_sel ($39FC): show the current sound-test selection.
 * @see galaga-main.asm $39FC
 * @param {Machine} m
 */
export function c_svc_test_sound_sel(m) {
  showSoundSelection(m);
}

/**
 * c_svc_test_input_hdlr ($39E0): handle one newly-pressed input in the
 * service mode. B is the bit position counter of the caller's 16-bit
 * input word (16 = bit 15 of H ... 1 = bit 0 of L):
 *   B = $0F  service switch: show the machine totals, and restart the
 *            15-second timer $9272 that erases them again
 *   B = $02  stick right: next sound;  B = $04  stick left: previous sound
 *   other    play the selected sound: clear all sound triggers, then set
 *            the trigger byte $9Axx named by the table d_3A4F
 * B and HL are preserved (the caller keeps shifting HL).
 * @see galaga-main.asm $39E0
 * @param {Machine} m
 * @param {{ b: number }} regs
 */
export function c_svc_test_input_hdlr(m, { b }) {
  if (b === 0x0f) {
    // l_39C9_call397D
    c_svc_machine_totals(m);
    m.poke16(0x9272, 0x0384); // 15 s x 60
    return;
  }
  if (b === 0x02) {
    // l_39F5: no clamp before the increment; showSoundSelection wraps it.
    m.poke(0x9270, (m.peek(0x9270) + 1) & 0xff);
    showSoundSelection(m);
    return;
  }
  if (b === 0x04) {
    // 0x39EE: sub $01 / jr nc -- a borrow wraps to the last sound, $11.
    const v = m.peek(0x9270);
    m.poke(0x9270, v === 0 ? 0x11 : v - 1);
    showSoundSelection(m);
    return;
  }
  // l_3A21
  let a = m.peek(0x9270);
  if (a >= 0x12) a = 0;
  m.poke(0x9270, a);
  c_svc_clr_snd_regs(m);
  const l = m.read('main', hlPlusA(0x3a59, a));
  m.poke(0x9a00 | l, 0x01);
}

/**
 * c_svc_cab_type ($3A6B): c_text_out through a pointer: HL points at a
 * word holding the string address (the "UPRIGHT"/"TABLE" table at $3AD6).
 * @see galaga-main.asm $3A6B
 * @param {Machine} m
 * @param {{ hl: number }} regs
 * @returns {{ hl: number, de: number }}
 */
export function c_svc_cab_type(m, { hl }) {
  return c_text_out(m, { hl: romWord('main', hl) });
}

/**
 * Three dip switches read MSB first: for each of $6800+n..n+2, `rr c`
 * moves the DSWB bit into carry and `adc a,a` shifts it in.
 * @param {Machine} m @param {number} addr @returns {number} 0-7
 */
function dsw3(m, addr) {
  let a = 0;
  for (let i = 0; i < 3; i += 1) a = ((a << 1) | (m.peek(addr + i) & 1)) & 0xff;
  return a & 0x07;
}

/**
 * c_391E ($3928): write a bonus level 0-19 (in 10000s) as two cells at HL
 * (tens: '1' or blank), the units one cell right (`res 5,l`).
 * @see galaga-main.asm $3928
 * @param {Machine} m
 * @param {{ a: number, hl: number }} regs
 * @returns {{ hl: number }}
 */
export function c_391E(m, { a, hl }) {
  let b = 0x24;
  if (a >= 0x0a) { b = 0x01; a = (a - 0x0a) & 0xff; }
  m.poke(hl, b);
  hl &= ~0x20;
  m.poke(hl, a);
  return { hl };
}

/**
 * l_393B ($3945): blank the "2ND BONUS" line and fall into l_3949.
 * @param {Machine} m
 */
function blank2ndBonusLine(m) {
  let hl = 0x8332;
  for (let b = 0x16; b > 0; b -= 1) {
    m.poke(hl, 0x24);
    hl = hlMinus20(hl);
  }
  blankAndEveryLine(m);
}

/**
 * l_3949 ($3953): blank the "AND EVERY" line.
 * @param {Machine} m
 */
function blankAndEveryLine(m) {
  let hl = 0x8334;
  for (let b = 0x16; b > 0; b -= 1) {
    m.poke(hl, 0x24);
    hl = hlMinus20(hl);
  }
}

/**
 * c_38DA ($38E4): show one line of the bonus report from one byte of a
 * bonus table entry (the value in 10000s; bit 7 = no "and every").
 * Called with C = 1 and HL at the entry's 2nd byte for "2ND BONUS" (and,
 * unless bit 7, "AND EVERY"), then entered again with C = 0 and HL at the
 * 1st byte for "1ST BONUS". A byte of $FF blanks both of the lower lines.
 * @see galaga-main.asm $38E4
 * @param {Machine} m
 * @param {{ hl: number, c: number }} regs
 * @returns {{ hl: number }} HL = the table byte address it was given
 */
export function c_38DA(m, { hl, c }) {
  if (m.read('main', hl) === 0xff) {
    blank2ndBonusLine(m); // jp l_393B; its ex de,hl pair keeps HL
    return { hl };
  }
  // 0x38E9: C*2 indexes the string pointers at $3B27.
  const str = romWord('main', hlPlusA(0x3b27, (c << 1) & 0xff));
  const next = c_text_out(m, { hl: str }).hl; // "1ST BONUS "/"2ND BONUS"
  c_text_out(m, { hl: next }); // "0000 PTS"
  const a = m.read('main', hl) & 0x7f;
  // 0x3904: ld b,c / djnz -- for C = 1 fall through to two `inc hl`.
  const pos = c === 1 ? 0x81f2 : 0x81f0;
  c_391E(m, { a, hl: pos });
  // 0x390D: dec c / ret nz -- the C = 0 pass returns here.
  if (((c - 1) & 0xff) !== 0) return { hl };
  const v = m.read('main', hl);
  if (v & 0x80) {
    blankAndEveryLine(m); // jp l_3949
    return { hl };
  }
  c_391E(m, { a: v, hl: 0x81f4 });
  const n = c_text_out(m, { hl: 0x3b5a }).hl; // "AND EVERY"
  c_text_out(m, { hl: n }); // "0000 PTS"
  return { hl };
}

/**
 * c_svc_updt_dsply ($37FE): the dip switch report of the service screen,
 * and the machine configuration derived from the switches. Also sets the
 * flip-screen latch: flipped unless START 1 or START 2 reads active in
 * $99B5 (so the screen stays inverted while both are held -- or while the
 * byte is still RAM-test garbage).
 * @see galaga-main.asm $37FE
 * @param {Machine} m
 */
export function c_svc_updt_dsply(m) {
  // Cabinet: DSWA bit 7 (rra / inc a / and 1 inverts it).
  const cab = ((m.peek(0x6807) >> 1) & 1) ^ 1;
  m.poke(0x9983, cab);
  c_svc_cab_type(m, { hl: 0x3ad6 + 2 * cab }); // "UPRIGHT" / "TABLE  "

  m.poke(0xa007, (m.peek(0x99b5) & 0x0c) === 0 ? 1 : 0);

  // Rank: DSWA bits 0 (-> bit 0) and 1 (-> bit 1).
  const rank = ((m.peek(0x6800) >> 1) & 1) | (m.peek(0x6801) & 0x02);
  m.poke(0x9984, rank);
  m.poke(0x822c, m.read('main', hlPlusA(0x3a72, rank))); // ldi
  c_text_out(m, { hl: 0x3aee }); // "RANK"

  // Fighters: DSWB bit 6 is the high bit, bit 7 the low one (`rr c` /
  // `adc a,a`), + 1 gives fighters - 1.
  const ships = ((((m.peek(0x6806) << 1) | (m.peek(0x6807) & 1)) & 0x03) + 1) & 0xff;
  m.poke(0x9982, ships);
  m.poke(0x82ea, ships + 1);
  c_text_out(m, { hl: 0x3af5 }); // "FIGHTERS" [rev B string]

  // Default 51XX credit-mode command: 01 (coinage) + 4 args, 02, 03, 00.
  m.ldir(0x9280, 0x3ace, 8);

  // Coinage: DSWB bits 0-2, MSB first.
  const coin = dsw3(m, 0x6800);
  if (coin === 0) {
    // l_389B: free play -- coinage arguments all zero.
    m.fill(0x9281, 0x00, 4);
    c_text_out(m, { hl: 0x3b11 }); // "FREE PLAY"
  } else {
    // 8 bytes per setting at $3A76: 4 coinage arguments, 4 characters.
    const src = hlPlusA(0x3a76, ((coin - 1) << 3) & 0xff);
    m.ldir(0x9281, src, 4);
    m.poke(0x82e8, m.read('main', src + 4)); // coins
    m.poke(0x8228, m.read('main', src + 5)); // "S" or blank
    m.poke(0x81e8, m.read('main', src + 6)); // credits
    m.poke(0x80e8, m.read('main', src + 7)); // "S" or blank
    m.poke(0x8208, 0x24);
    const n = c_text_out(m, { hl: 0x3b00 }).hl; // " COIN"
    c_text_out(m, { hl: n }); // "CREDIT"
  }

  // l_38AB: bonus setting, DSWB bits 3-5, MSB first.
  const bonus = dsw3(m, 0x6803);
  if (bonus === 0) {
    // l_392D: "BONUS NOTHING", no bonus levels.
    c_text_out(m, { hl: 0x3b71 });
    m.poke(0x9980, 0xff);
    m.poke(0x9981, 0xff);
    blank2ndBonusLine(m);
    return;
  }
  // Entry = ((fighters-1 & 4) * 2 + setting) * 2: the 5-fighter settings
  // use the second table at $3ABE.
  const idx = (((m.peek(0x9982) & 0x04) << 1) + bonus) << 1;
  const entry = hlPlusA(0x3aae, idx & 0xff);
  m.poke(0x9980, m.read('main', entry));
  m.poke(0x9981, m.read('main', entry + 1));
  c_38DA(m, { hl: entry + 1, c: 1 });
  c_38DA(m, { hl: entry, c: 0 }); // 0x38E1: dec hl / ld c,0 / fall in
}

/**
 * c_3774 ($377E): one byte of the easter-egg bitmap: for each set bit,
 * MSB first, increment the tile below (turning a space $24 into $25, a
 * solid block); then skip one more tile.
 * @see galaga-main.asm $377E
 * @param {Machine} m
 * @param {{ de: number, hl: number }} regs
 * @returns {{ de: number, hl: number }}
 */
export function c_3774(m, { de, hl }) {
  let a = m.read('main', de);
  for (let c = 8; c > 0; c -= 1) {
    const carry = a & 0x80;
    a = (a << 1) & 0xff;
    if (carry) m.poke(hl, (m.peek(hl) + 1) & 0xff);
    hl = (hl + 1) & 0xffff;
  }
  return { de: (de + 1) & 0xffff, hl: (hl + 1) & 0xffff };
}

/**
 * c_svc_easteregg_hdlr ($3770): one 32-tile column of the "(c) 1981 NAMCO
 * LTD." easter egg: three bitmap bytes (27 tiles), then HL += 5 by jumping
 * into rst_HLplusA with A = 5.
 * @see galaga-main.asm $3770
 * @param {Machine} m
 * @param {{ de: number, hl: number }} regs
 * @returns {{ de: number, hl: number }}
 */
export function c_svc_easteregg_hdlr(m, { de, hl }) {
  for (let i = 0; i < 3; i += 1) ({ de, hl } = c_3774(m, { de, hl }));
  return { de, hl: hlPlusA(hl, 0x05) };
}
