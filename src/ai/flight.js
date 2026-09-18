// Copyright 2026 by Moshix
/**
 * Where a flying alien will be, frame by frame: the sub CPU's bug motion
 * runner (f_08D3, galaga-sub.asm $08D3-$0E5E) replayed on a private copy of
 * one motion-queue slot.
 *
 * WHY A TRANSCRIPTION AND NOT A GUESS. A Galaga diver does not fall in a
 * straight line: it follows a flight path, a byte string in the sub ROM of
 * (speed, turn rate, duration) segments and commands, and turns by up to
 * 20 degrees a frame. Extrapolating its current velocity is wrong within a
 * handful of frames, and "wrong by twelve pixels" is the difference between
 * a miss and a collision. The path is deterministic, though -- the slot
 * holds the position, heading, speed and a pointer into the path -- so the
 * honest way to know where it will be is to run the same interpreter. Every
 * input it needs is in RAM except the path bytes themselves, which are
 * constant ROM data (the same knowledge a human player acquires by watching
 * the attack patterns); they come from the generated romdata.js.
 *
 * Nothing here writes to the machine. A slot is copied into a 20-byte
 * scratch array and stepped there; the few RAM values the commands consult
 * are sampled once per frame into a {@link FlightEnv}.
 *
 * SLOT LAYOUT (IX-relative, see src/game/sub/gg1_5_motion.js):
 *   +00/+01 y, 9.7 fixed point     +02/+03 x, 9.7 fixed point
 *   +04/+05 heading (10 bits)      +06/+07 homing / dive-end target
 *   +08/+09 path pointer           +0A/+0B speed, odd / even frames
 *   +0C turn rate   +0D frames left in segment   +0E/+0F bomb timer / bits
 *   +10 object      +11/+12 formation offset     +13 flags
 *
 * Screen flip (cocktail player 2) is not modelled: the AI plays player 1 on
 * an upright cabinet, where $9215 is always 0.
 */

import { subRom } from '../game/romdata.js';

/**
 * RAM values the path commands read, sampled once per frame.
 * @typedef {object} FlightEnv
 * @property {number} fighterX   $9362, the fighter's x (buffer)
 * @property {number} fighterXHw $93E2, the fighter's x (hardware copy)
 * @property {number} parm8      $99C8, stage parameter for token $F0
 * @property {number} parm9      $99C9, stage parameter for token $EF
 * @property {number} cbomb      $92AA, continuous bombing
 * @property {number} task1D     $901D, rescued-fighter task running
 * @property {number} bombBits   $92C8, bomb-enable reload value
 * @property {number} bombReload $92E2, bomb countdown reload value
 * @property {number} fighterLive $9015, bombs are only dropped while set
 * @property {number} captureTmr $92AD, bombs are held while non-zero
 * @property {Uint8Array} fmtn   $9800-$981F then $9900-$991F (formation)
 */

/** @returns {FlightEnv} */
export function makeFlightEnv() {
  return {
    fighterX: 0x7a, fighterXHw: 0x7a, parm8: 0, parm9: 0, cbomb: 0, task1D: 0,
    bombBits: 0, bombReload: 0, fighterLive: 1, captureTmr: 0,
    fmtn: new Uint8Array(0x40),
  };
}

/**
 * One alien in flight, as the predictor carries it forward.
 * @typedef {object} Flight
 * @property {Uint8Array} s     the 20-byte slot copy
 * @property {number} status    object status ($8800+obj): 3, 7 or 9 fly
 * @property {boolean} alive    false once the path ends or the alien homes
 * @property {number} x         sprite x after the last step
 * @property {number} y         sprite y (9 bits) after the last step
 * @property {boolean} dropped  a bomb left this alien on the last step
 */

/** @returns {Flight} */
export function makeFlight() {
  return { s: new Uint8Array(0x14), status: 0, alive: false, x: 0, y: 0, dropped: false };
}

/**
 * Load a flight from RAM.
 * @param {Flight} f
 * @param {(addr: number) => number} peek
 * @param {number} slot address of the motion-queue slot ($9100 + n*$14)
 * @param {number} status object status
 */
export function loadFlight(f, peek, slot, status) {
  for (let i = 0; i < 0x14; i += 1) f.s[i] = peek(slot + i);
  f.status = status;
  f.alive = (f.s[0x13] & 1) !== 0;
  f.dropped = false;
  // Until the first step moves it, the alien is where its sprite is.
  const obj = f.s[0x10];
  f.x = peek(0x9300 + obj);
  f.y = peek(0x9301 + obj) | ((peek(0x9b01 + obj) & 1) << 8);
}

/**
 * A byte of the sub CPU's address space. Path data lives in ROM; a pointer
 * outside it (never seen in play) reads as the end-of-path token.
 * @param {number} addr @returns {number}
 */
function subByte(addr) {
  const a = addr & 0xffff;
  if (a >= 0x4000) return 0xff;
  try {
    return subRom(a);
  } catch {
    return 0xff;
  }
}

/** @param {number} addr @returns {number} */
const subWord = (addr) => subByte(addr) | (subByte(addr + 1) << 8);

/** A formation table byte: $98xx for idx < $20, $99xx otherwise. */
function fmtnByte(env, base, idx) {
  return env.fmtn[(base === 0x9800 ? 0 : 0x20) + (idx & 0x1f)];
}

/**
 * c_0EAA: HL / A by 17 rounds of restoring division, bit for bit.
 * @param {number} a divisor @param {number} hl dividend
 * @returns {number} the 16-bit quotient
 */
export function divide(a, hl) {
  const c = a & 0xff;
  let acc = 0;
  let cf = 0;
  let q = hl & 0xffff;
  for (let b = 0x11; b > 0; b -= 1) {
    const t = (acc << 1) | cf;
    // One restoring step: subtract when it fits (or the shifted-out bit
    // says it must), and the carry becomes the next quotient bit.
    if (t > 0xff) {
      acc = (t - c) & 0xff;
      cf = 1;
    } else if (t < c) {
      acc = t;
      cf = 0;
    } else {
      acc = t - c;
      cf = 1;
    }
    const r = (q << 1) | cf;
    q = r & 0xffff;
    cf = r >> 16;
  }
  return q;
}

/**
 * c_0E5B: heading from (h, l) = (y, x) to (d, e), all <8:1> integer parts.
 * @param {number} de @param {number} hl @returns {number} octant:fraction
 */
function headingTo(de, hl) {
  const d = (de >> 8) & 0xff;
  const e = de & 0xff;
  const h = (hl >> 8) & 0xff;
  const l = hl & 0xff;
  let b = 0;
  let c = (e - l) & 0xff;
  if (e < l) { b = 1; c = (l - e) & 0xff; }
  let a = (d - h) & 0xff;
  if (d < h) { b = (b ^ 1) | 2; a = (h - d) & 0xff; }
  const lt = a < c ? 1 : 0;
  b = ((b << 1) | ((lt ^ (b & 1)) ^ 1)) & 0xff;
  if (lt) { const t = c; c = a; a = t; }
  const q = divide(a, c << 8);
  let lo = q & 0xff;
  if ((((q >> 8) ^ b) & 1) !== 0) lo = ~lo & 0xff;
  return (b << 8) | lo;
}

// Continuations of a path command, as in the motion runner.
const K_TOKEN = 0;
const K_SKIPLOAD = 1;
const K_FINAL = 2;
const K_FINAL_NOINC = 3;
const K_NEXT = 4;

/**
 * Run one path command (token >= $EF) on the slot copy.
 * @param {Flight} f @param {FlightEnv} env @param {number} token
 * @param {{hl: number}} r path pointer, updated in place
 * @returns {number} continuation
 */
function command(f, env, token, r) {
  const s = f.s;
  switch (token) {
    case 0xef: case 0xf0: {
      // Conditional jump on a stage parameter; either way wait a frame.
      if ((token === 0xef ? env.parm9 : env.parm8) !== 0) {
        r.hl = subWord(r.hl + 1);
        return K_FINAL_NOINC;
      }
      r.hl = (r.hl + 2) & 0xffff;
      return K_FINAL;
    }
    case 0xf1: {
      // Dives stop: y to the home row's origin + $20.
      const row = subByte(0x0100 + s[0x10]);
      s[0x01] = (fmtnByte(env, 0x9900, row + 1) + 0x20) & 0xff;
      return K_FINAL;
    }
    case 0xf2:
      // Bonus-bee split: the clone is a new object we will see next frame.
      r.hl = (r.hl + 3) & 0xffff;
      return K_TOKEN;
    case 0xf3: {
      // Red alien: hold the course for a time picked by the fighter's x.
      let a = env.fighterX;
      if (a < 0x1e) a = 0x1e;
      if (a >= 0xd1) a = 0xd1;
      a >>= 1;
      const x = s[0x03];
      const cf = a < x ? 0x80 : 0;
      a = (((a - x) & 0xff) >> 1) | cf;
      if (s[0x13] & 0x80) a = (-a) & 0xff;
      a = (a + 0x18) & 0xff;
      if (a & 0x80) a = 0;
      if (a >= 0x30) a = 0x2f;
      const idx = divide(6, a << 8) >> 8;
      s[0x0d] = subByte(r.hl + idx + 1);
      r.hl = (r.hl + 9) & 0xffff;
      return K_SKIPLOAD;
    }
    case 0xf4: {
      // The capture boss aims at the fighter's column.
      let a = (((env.fighterX + 3) & 0xf8) + 1) & 0xff;
      if (a < 0x29) a = 0x29;
      if (a >= 0xca) a = 0xc9;
      const hl = headingTo(0x4800 | (a >> 1), (s[0x01] << 8) | s[0x03]);
      s[0x04] = (hl >> 1) & 0xff;
      s[0x05] = hl >> 9;
      r.hl = (r.hl + 1) & 0xffff;
      return K_TOKEN;
    }
    case 0xf5:
      f.status = 3;
      r.hl = (r.hl + 1) & 0xffff;
      return K_TOKEN;
    case 0xf6: {
      // Set the heading; restart the bomb timer.
      r.hl = (r.hl + 1) & 0xffff;
      let a = subByte(r.hl);
      if (s[0x13] & 0x80) a = (-(a + 0x80)) & 0xff;
      s[0x04] = (a << 2) & 0xff;
      s[0x05] = a >> 6;
      s[0x0e] = 0x1e;
      s[0x0f] = env.bombBits;
      return K_FINAL;
    }
    case 0xf7:
      if ((s[0x10] & 0x38) === 0x38) { r.hl = subWord(r.hl + 1); return K_TOKEN; }
      r.hl = (r.hl + 3) & 0xffff;
      return K_TOKEN;
    case 0xf8:
      s[0x01] = 0x9c;
      return K_FINAL;
    case 0xf9: {
      // Re-enter at the top above the home column.
      const col = subByte(0x0100 + ((s[0x10] + 1) & 0xff));
      s[0x03] = fmtnByte(env, 0x9800, col) >> 1;
      return K_FINAL;
    }
    case 0xfa:
      if ((((env.task1D - 1) & 0xff) & env.cbomb) === 0) { r.hl = subWord(r.hl + 1); return K_TOKEN; }
      r.hl = (r.hl + 3) & 0xffff;
      return K_TOKEN;
    case 0xfb: {
      // Head for home: from here on the alien climbs back to the formation.
      f.status = 9;
      const obj = s[0x10];
      const rowIdx = subByte(0x0100 + obj);
      const colIdx = subByte(0x0100 + ((obj + 1) & 0xff));
      const b = fmtnByte(env, 0x9900, colIdx);
      const e = fmtnByte(env, 0x9900, colIdx + 1) >> 1;
      const c = fmtnByte(env, 0x9900, rowIdx);
      const d = fmtnByte(env, 0x9900, rowIdx + 1);
      const tgt = (d << 8) | e;
      s[0x11] = b;
      s[0x12] = c;
      let hl = ((s[0x00] | (s[0x01] << 8)) + (((c << 24) >> 24) * 128)) & 0xffff;
      s[0x00] = hl & 0xff;
      s[0x01] = hl >> 8;
      const y = hl >> 8;
      hl = ((s[0x02] | (s[0x03] << 8)) - (((b << 24) >> 24) * 128)) & 0xffff;
      s[0x02] = hl & 0xff;
      s[0x03] = hl >> 8;
      const ang = headingTo(tgt, (y << 8) | (hl >> 8));
      s[0x04] = (ang >> 1) & 0xff;
      s[0x05] = ang >> 9;
      s[0x06] = tgt >> 8;
      s[0x07] = tgt & 0xff;
      s[0x13] |= 0x40;
      r.hl = (r.hl + 1) & 0xffff;
      return K_TOKEN;
    }
    case 0xfc:
      // A dive that ends at a given y.
      s[0x06] = subByte(r.hl + 1);
      r.hl = (r.hl + 2) & 0xffff;
      s[0x07] = 0;
      s[0x13] |= 0x20;
      return K_SKIPLOAD;
    case 0xfd:
      r.hl = subWord(r.hl + 1);
      return K_TOKEN;
    case 0xfe: {
      let a = env.fighterXHw;
      if (a === 0) a = 0x80;
      if (!(s[0x13] >> 7)) a = ((-a) + 0xf2) & 0xff;
      a = (a + 0x0e) & 0xff;
      const idx = divide(0x1e, a << 8) >> 8;
      s[0x0d] = subByte(r.hl + idx);
      r.hl = (r.hl + 9) & 0xffff;
      return K_SKIPLOAD;
    }
    default:
      // $FF: end of path, the object disappears.
      f.alive = false;
      return K_NEXT;
  }
}

/** Scratch for the path pointer, so stepping allocates nothing. */
const reg = { hl: 0 };

/**
 * Read path data until a segment is loaded (true: move this frame) or a
 * command ends the frame (false).
 * @param {Flight} f @param {FlightEnv} env @returns {boolean}
 */
function readPath(f, env) {
  const s = f.s;
  reg.hl = s[0x08] | (s[0x09] << 8);
  // A path never needs more than a few commands in a row; the bound only
  // protects the AI from a corrupted pointer.
  for (let guard = 0; guard < 32; guard += 1) {
    const t = subByte(reg.hl);
    if (t < 0xef) {
      s[0x0a] = t & 0x0f;
      s[0x0b] = t >> 4;
      let a = subByte(reg.hl + 1);
      if (s[0x13] & 0x80) a = (-a) & 0xff;
      s[0x0c] = a;
      s[0x0d] = subByte(reg.hl + 2);
      reg.hl = (reg.hl + 3) & 0xffff;
      s[0x08] = reg.hl & 0xff;
      s[0x09] = reg.hl >> 8;
      return true;
    }
    const k = command(f, env, t, reg);
    if (k === K_TOKEN) continue;
    if (k === K_SKIPLOAD) { s[0x08] = reg.hl & 0xff; s[0x09] = reg.hl >> 8; return true; }
    if (k === K_FINAL || k === K_FINAL_NOINC) {
      if (k === K_FINAL) reg.hl = (reg.hl + 1) & 0xffff;
      s[0x08] = reg.hl & 0xff;
      s[0x09] = reg.hl >> 8;
      s[0x0d] = (s[0x0d] + 1) & 0xff;
      return false;
    }
    return false;
  }
  f.alive = false;
  return false;
}

/**
 * One step along the old heading: the axis the heading is nearer moves by
 * the full speed, the other by speed * (fraction / 128) -- a linear
 * stand-in for sine and cosine. 9.7 fixed point, so 128 is one pixel.
 * @param {Uint8Array} s @param {number} speed @param {number} d @param {number} e
 */
function move(s, speed, d, e) {
  const d3 = d & 3;
  const oct = (d3 << 1) | (e >> 7);
  let p = 0;
  if (((d3 ^ oct) & 1) === 0) p = 2;
  let a = speed;
  if (((oct + 1) & 4) !== 0) a = (-a) & 0xff;
  let cf = 0;
  if (a & 1) {
    const lo = s[p] + 0x80;
    s[p] = lo & 0xff;
    cf = lo >> 8;
  }
  s[p + 1] = (s[p + 1] + ((a >> 1) | (a & 0x80)) + cf) & 0xff;
  const q = p ^ 2;
  let l = e & 0x7f;
  if (e & 0x80) l ^= 0x7f;
  let prod = (l * speed) & 0xffff;
  if ((((oct ^ 2) - 1) & 4) !== 0) prod = (-prod) & 0xffff;
  const lo = s[q] + (prod & 0xff);
  s[q] = lo & 0xff;
  s[q + 1] = (s[q + 1] + (prod >> 8) + (lo >> 8)) & 0xff;
}

/**
 * Sprite position from the slot (l_0D03, unflipped screen).
 * @param {Flight} f
 */
function spritePosition(f) {
  const s = f.s;
  const homing = s[0x13] & 0x40;
  let x = ((s[0x03] << 1) | (s[0x02] >> 7)) & 0xff;
  if (homing) x = (x + s[0x11]) & 0xff;
  let e0 = s[0x00] >> 7;
  let a = ~(s[0x01] + 0x4f) & 0xff;
  e0 ^= 1;
  let y8 = a >> 7;
  a = ((a << 1) | e0) & 0xff;
  if (homing) {
    const off = s[0x12];
    const sum = a + off;
    if (((sum >> 8) ^ (off >> 7)) & 1) y8 ^= 1;
    a = sum & 0xff;
  }
  f.x = x;
  f.y = (y8 << 8) | a;
}

/**
 * The bomb timer of l_0D59, so a prediction can say "this alien drops a
 * bomb on frame k". Whether a free bomb object exists is not modelled.
 * @param {Flight} f @param {FlightEnv} env
 */
function bombTimer(f, env) {
  const s = f.s;
  f.dropped = false;
  s[0x0e] = (s[0x0e] - 1) & 0xff;
  if (s[0x0e] !== 0) return;
  const bits = s[0x0f];
  s[0x0f] = bits >> 1;
  if ((bits & 1) && s[0x01] >= 0x4c && env.fighterLive !== 0 && env.captureTmr === 0) f.dropped = true;
  s[0x0e] = env.bombReload;
}

/**
 * Advance one frame, exactly as the motion runner would.
 *
 * @param {Flight} f
 * @param {FlightEnv} env
 * @param {number} parity bit 0 of the frame counter $92A0 as the runner
 *   will see it on this frame (odd frames use speed +0A, even +0B)
 * @returns {boolean} false once the alien stops being a flying object
 */
export function stepFlight(f, env, parity) {
  if (!f.alive) return false;
  const s = f.s;
  if (f.status !== 3 && f.status !== 9 && f.status !== 7) { f.alive = false; return false; }
  s[0x0d] = (s[0x0d] - 1) & 0xff;
  if (s[0x0d] === 0 && !readPath(f, env)) {
    // A command ended the frame: the sprite does not move.
    return f.alive;
  }
  if (s[0x13] & 0x40) {
    const dy = (s[0x01] - s[0x06]) & 0xff;
    if (dy === 0 || dy === 1 || dy === 0xff) {
      const dx = (s[0x03] - s[0x07]) & 0xff;
      if (dx === 0 || dx === 1 || dx === 0xff) {
        // Home: it rotates into the formation and stops being a flyer.
        f.alive = false;
        return false;
      }
    }
  }
  if (s[0x13] & 0x20) {
    const dy = (s[0x01] - s[0x06]) & 0xff;
    if (dy === 0 || dy === 0xff) {
      s[0x0d] = 0x01;
      s[0x13] &= ~0x20;
    }
  }
  const rate = s[0x0c];
  const e = s[0x04];
  const d = s[0x05];
  const sum = e + rate;
  s[0x04] = sum & 0xff;
  if (((sum >> 8) ^ (rate >> 7)) & 1) s[0x05] = (d + ((rate & 0x80) ? 0xff : 0x01)) & 0xff;
  const speed = parity ? s[0x0a] : s[0x0b];
  if (speed !== 0) move(s, speed, d, e);
  spritePosition(f);
  bombTimer(f, env);
  return true;
}
