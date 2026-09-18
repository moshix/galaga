// Copyright 2026 by Moshix
/**
 * Exact Z80 arithmetic for the port, for the places where the original
 * leans on a flag or on BCD: score addition (`add a,(hl)` / `daa`), carries
 * threaded from one instruction into the next (`rla`, `adc`), signed
 * displacements. Each function is pure and returns the new value together
 * with the flags the next instruction could observe.
 *
 * Flags are returned as a Z80 F byte (`f`) plus convenience booleans `cf`
 * (carry) and `zf` (zero). They match test/z80/z80.mjs bit for bit, which
 * test/unit/z80ops.test.mjs checks exhaustively.
 */

export const FC = 0x01;
export const FN = 0x02;
export const FPV = 0x04;
export const FX = 0x08;
export const FH = 0x10;
export const FY = 0x20;
export const FZ = 0x40;
export const FS = 0x80;

/** S, Z, X, Y and parity for each byte value. */
const SZXYP = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) {
  let bits = 0;
  for (let b = 0; b < 8; b += 1) bits += (i >> b) & 1;
  SZXYP[i] = (i & (FS | FX | FY)) | (i === 0 ? FZ : 0) | (bits % 2 === 0 ? FPV : 0);
}

/**
 * @typedef {{ a: number, f: number, cf: boolean, zf: boolean }} AluResult
 */

/** @param {number} a @param {number} f @returns {AluResult} */
const out = (a, f) => ({ a, f, cf: (f & FC) !== 0, zf: (f & FZ) !== 0 });

/** Signed value of a displacement byte. @param {number} v */
export const sext8 = (v) => ((v & 0xff) ^ 0x80) - 0x80;

/**
 * `add a,v` / `adc a,v`.
 * @param {number} a @param {number} v @param {number} [carryIn] 0 or 1
 * @returns {AluResult}
 */
export function add8(a, v, carryIn = 0) {
  const r = a + v + carryIn;
  const res = r & 0xff;
  const f = (res & (FS | FX | FY)) | (res === 0 ? FZ : 0)
    | ((a ^ v ^ res) & FH)
    | (((a ^ res) & (v ^ res) & 0x80) >> 5)
    | (r > 0xff ? FC : 0);
  return out(res, f);
}

/**
 * `sub v` / `sbc a,v`. For `cp v`, use this and discard `a`, but note CP's
 * X/Y flags come from the operand (see test/z80/z80.mjs cp8).
 * @param {number} a @param {number} v @param {number} [borrowIn] 0 or 1
 * @returns {AluResult}
 */
export function sub8(a, v, borrowIn = 0) {
  const r = a - v - borrowIn;
  const res = r & 0xff;
  const f = (res & (FS | FX | FY)) | (res === 0 ? FZ : 0)
    | ((a ^ v ^ res) & FH)
    | (((a ^ v) & (a ^ res) & 0x80) >> 5)
    | (r < 0 ? FC : 0) | FN;
  return out(res, f);
}

/**
 * `daa` after an add or subtract. Depends on the F byte the arithmetic left
 * (N, H and C), exactly like the chip -- so pass the `f` from add8/sub8.
 * @param {number} a @param {number} f @returns {AluResult}
 */
export function daa(a, f) {
  let diff = 0;
  let carry = f & FC;
  if ((f & FH) !== 0 || (a & 0x0f) > 9) diff |= 0x06;
  if (carry !== 0 || a > 0x99) { diff |= 0x60; carry = FC; }
  let res;
  let half;
  if ((f & FN) !== 0) {
    res = (a - diff) & 0xff;
    half = ((f & FH) !== 0 && (a & 0x0f) < 6) ? FH : 0;
  } else {
    res = (a + diff) & 0xff;
    half = (a & 0x0f) > 9 ? FH : 0;
  }
  return out(res, SZXYP[res] | half | (f & FN) | carry);
}

/**
 * BCD add of two packed-BCD bytes plus carry: `add a,v` / `adc a,v` then
 * `daa`, the way the score routines do it.
 * @param {number} a @param {number} v @param {number} [carryIn]
 * @returns {AluResult}
 */
export function bcdAdd(a, v, carryIn = 0) {
  const s = add8(a, v, carryIn);
  return daa(s.a, s.f);
}

/** `rlca`: bit 7 to carry and bit 0. @param {number} a */
export const rlca = (a) => ({ a: ((a << 1) | (a >> 7)) & 0xff, cf: (a & 0x80) !== 0 });
/** `rrca`: bit 0 to carry and bit 7. @param {number} a */
export const rrca = (a) => ({ a: ((a >> 1) | (a << 7)) & 0xff, cf: (a & 1) !== 0 });
/** `rla`: through carry. @param {number} a @param {boolean} cf */
export const rla = (a, cf) => ({ a: ((a << 1) | (cf ? 1 : 0)) & 0xff, cf: (a & 0x80) !== 0 });
/** `rra`: through carry. @param {number} a @param {boolean} cf */
export const rra = (a, cf) => ({ a: ((a >> 1) | (cf ? 0x80 : 0)) & 0xff, cf: (a & 1) !== 0 });
/** `sra`: arithmetic shift right. @param {number} v */
export const sra = (v) => ({ a: ((v >> 1) | (v & 0x80)) & 0xff, cf: (v & 1) !== 0 });
/** `srl`. @param {number} v */
export const srl = (v) => ({ a: (v >> 1) & 0xff, cf: (v & 1) !== 0 });
/** `sla`. @param {number} v */
export const sla = (v) => ({ a: (v << 1) & 0xff, cf: (v & 0x80) !== 0 });

/** Parity-even flag of a byte, for the rare `jp pe` after logic ops. @param {number} v */
export const parityEven = (v) => (SZXYP[v & 0xff] & FPV) !== 0;
