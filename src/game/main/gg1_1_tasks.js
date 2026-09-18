// Copyright 2026 by Moshix
/**
 * Main CPU periodic tasks that live in $0000-$0FFF (game_ctrl.s), run by
 * the task manager from the vblank IRQ (see jp_Task_man, gg1_1_irq.js):
 *
 *   task $00,$06,$07,$13,$16,$1A,$1B,$1E  f_0827  empty task
 *   task $01                               f_0828  sprite buffer -> sprite RAM
 *   task $05                               f_0857  bomber timers / bomb enables
 *   task $0F                               f_0935  blink 1UP / 2UP
 *   task $1F                               f_0977  coins, credits, game state
 *
 * Tasks are plain functions: they run to completion inside the handler.
 *
 * @see reference/galaga-main.asm $0827-$0A26
 */

import { MAIN } from './routines.js';
import { add8, sub8, daa, bcdAdd, rlca } from '../z80ops.js';
import { rst_18, rst_08, rst_HLplusA } from './gg1_1_rst.js';
import { requestRamTest } from './gg1_1_state.js';

/**
 * @typedef {import('../../machine/machine.js').Machine} Machine
 */

/**
 * $0827 f_0827: the empty task (`ret`). Most unused task slots point here.
 * @see galaga-main.asm $0827
 * @param {Machine} _m
 */
export function f_0827(_m) {}

/**
 * $0828 f_0828: copy the upper halves ($40 bytes each) of the sprite code,
 * position and control buffers to the hardware sprite registers, flagging
 * b_CPU1_in_progress ($92D6) around the copy. The sub CPU copies the lower
 * halves (its f_05BF) and the two wait for each other.
 *
 * $0850 then spins while b_CPU2_in_progress ($92D7) == 1. In the port the
 * sub CPU's vblank handler always runs to completion before or after this
 * one (see scheduler.js), never concurrently, so the flag is never 1 here
 * and the wait is a no-op. (Spinning inside a port interrupt handler could
 * never end, since nothing else runs meanwhile.)
 * @see galaga-main.asm $0828
 * @param {Machine} m
 */
export function f_0828(m) {
  m.poke(0x92d6, 1);
  m.ldir(0x8bc0, 0x8b40, 0x40);
  m.ldir(0x93c0, 0x9340, 0x40);
  m.ldir(0x9bc0, 0x9b40, 0x40);
  m.poke(0x92d6, 0);
  // $0850: ld a,($92D7) / dec a / jr z,$0850 -- see above; nothing to wait for.
}

/**
 * $0857 f_0857: derive this frame's bomb-drop enables and the default
 * bomber launch timers from the stage parameters ($99C0-$99C5), the number
 * of enemies left ($92A7) and game timer 2 ($92AE).
 * @see galaga-main.asm $0857
 * @param {Machine} m
 * @param {{ e?: number }} [regs] E as the task manager leaves it (the low
 *   byte of the task-table pointer, $A1 for slot 5); it only reaches the
 *   low byte of c_08BE's dividend, which cannot change the quotient's
 *   high byte, so it never matters.
 */
export function f_0857(m, regs = {}) {
  const b = m.peek(0x92ae);
  // $085B: cp $3C / jr nc -- below 60 the stage's second max-bombers value applies.
  if (b < 0x3c) m.poke(0x99c4, m.peek(0x99c5));
  const c = m.peek(0x92a7);
  let r = c_08BE(m, { a: m.peek(0x99c0), c, hl: 0x0909, e: regs.e ?? 0xa1 });
  m.poke(0x92c8, r.a);
  if (m.peek(0x92aa) !== 0) {
    // $087B: continuous bombing: all three launch timers to 2, pulsing sound off.
    rst_18(m, { a: 2, b: 3, hl: 0x92c4 });
    m.poke(0x9aa0, 0);
    return;
  }
  r = c_08BE(m, { a: m.peek(0x99c1), c, hl: 0x0929, e: r.de & 0xff });
  m.poke(0x92c4, r.a);
  m.poke(0x92c5, c_08AD(m, { a: m.peek(0x99c2), b, hl: 0x08cd }).a);
  m.poke(0x92c6, c_08AD(m, { a: m.peek(0x99c3), b, hl: 0x08eb }).a);
}

/**
 * $08AD c_08AD: pick one of a group of 3 table bytes. Group A (of 3 bytes)
 * at HL; within it, byte 0 if B >= $28, byte 1 if 0 < B < $28, byte 2 if
 * B == 0.
 * @see galaga-main.asm $08AD
 * @param {Machine} m
 * @param {{ a: number, b: number, hl: number }} regs A = stage parameter,
 *   B = game timer 2, HL = d_08CD or d_08EB
 * @returns {{ a: number, e: number, hl: number }}
 */
export function c_08AD(m, { a, b, hl }) {
  const e = a & 0xff;
  // sla a / add a,e -- 8-bit, so 3A wraps for silly parameters.
  let { hl: p } = rst_HLplusA(m, { a: (((a << 1) & 0xff) + e) & 0xff, hl });
  if (b < 0x28) p = (p + 1) & 0xffff;
  if (b === 0) p = (p + 1) & 0xffff;
  return { a: tableByte(m, p), e, hl: p };
}

/**
 * $08BE c_08BE: pick one of a group of 4 table bytes: group A (4 bytes) at
 * HL, element (C * 256 + E) / 10 >> 8, i.e. C / 10 -- one step per ten
 * enemies left. The division is done by c_divmod ($1061).
 * @see galaga-main.asm $08BE
 * @param {Machine} m
 * @param {{ a: number, c: number, hl: number, e?: number }} regs
 *   A = stage parameter, C = enemies left, HL = d_0909 or d_0929
 * @returns {{ a: number, de: number, hl: number }}
 */
export function c_08BE(m, { a, c, hl, e = 0 }) {
  // sla a / rst $08: HL += 4A (the sla's carry is lost, as on the Z80).
  const p = rst_08(m, { a: (a << 1) & 0xff, hl }).hl;
  // ex de,hl / ld h,c: the dividend's low byte is whatever E held.
  const q = MAIN.c_divmod(m, { a: 0x0a, hl: ((c & 0xff) << 8) | (e & 0xff) });
  // ex de,hl / ld a,d / rst $10 / ld a,(hl)
  const r = rst_HLplusA(m, { a: (q.hl >> 8) & 0xff, hl: p });
  return { a: tableByte(m, r.hl), de: q.hl & 0xffff, hl: r.hl };
}

/**
 * A byte of the c_08AD / c_08BE tables -- or of whatever they overrun into.
 * The tables have no bounds check and walk into code at $0935-$0B0E, so
 * romdata.js exports that range as data. @see tools/gen-listing.mjs
 * @param {Machine} m @param {number} addr @returns {number}
 */
function tableByte(m, addr) {
  return m.read('main', addr & 0xffff);
}

/**
 * $0935 f_0935: blink "1UP"/"2UP": the frame counter's bit 4 (rotated to
 * bit 0 by four rlca) chooses text or blanks.
 * @see galaga-main.asm $0935
 * @param {Machine} m
 */
export function f_0935(m) {
  let a = m.peek(0x92a0);
  for (let i = 0; i < 4; i += 1) a = rlca(a).a;
  c_093C(m, { a });
}

/**
 * $093C c_093C (gctl_1up2up_displ): in game mode only, draw or wipe
 * "1UP" (and "2UP" in a two-player game). Bit 0 of A set wipes the
 * *active* player's text. Also called from g_halt with A = 0.
 * @see galaga-main.asm $093C
 * @param {Machine} m
 * @param {{ a: number }} regs
 */
export function c_093C(m, { a }) {
  const c = a & 0xff;
  if (m.peek(0x9201) !== 3) return;
  const b = m.peek(0x9840);
  // cpl / and c: player 1's text blinks only when player 1 is up.
  c_095F(m, { a: (~b) & c & 0xff, hl: 0x096e, de: 0x83d9 });
  if (m.peek(0x99b3) === 0) return;
  c_095F(m, { a: b & c, hl: 0x0971, de: 0x83c4 });
}

/**
 * $095F c_095F: copy 3 characters from HL to DE, or 3 spaces ($0974) if
 * bit 0 of A is set.
 * @see galaga-main.asm $095F
 * @param {Machine} m
 * @param {{ a: number, hl: number, de: number }} regs
 * @returns {{ hl: number, de: number }}
 */
export function c_095F(m, { a, hl, de }) {
  const src = (a & 1) ? 0x0974 : hl;
  m.ldir(de, src, 3);
  return { hl: (src + 3) & 0xffff, de: (de + 3) & 0xffff };
}

/**
 * $0977 f_0977: the coin/credit/game-state task.
 *
 *  - $BB from the 51XX (service switch in credit mode) restarts the machine
 *    at the RAM test ($336C) -- straight out of the interrupt handler.
 *  - In game mode, advance the BCD play-time counter $99E6-$99E9
 *    (sixtieths in $99E9).
 *  - Otherwise print "CREDIT nn" or "FREE PLAY" on the bottom row.
 *  - Attract mode + credits: go to READY_TO_PLAY and silence sounds.
 *  - A drop in the 51XX credit count means a game was started: 1 or 2
 *    credits used gives a 1- or 2-player game, state IN_GAME.
 *  - A rise means coins: tell the sound manager ($9A79).
 * @see galaga-main.asm $0977
 * @param {Machine} m
 * @returns {{ ramTest: boolean }|undefined} `ramTest` when the task jumped
 *   to the RAM test; the task manager must then stop, as the Z80 never
 *   returns to it.
 */
export function f_0977(m) {
  if (m.peek(0x99b5) === 0xbb) {
    // $097C: jp z,$336C -- abandons the interrupt handler (see gg1_1_state.js).
    requestRamTest(m);
    return { ramTest: true };
  }
  if (m.peek(0x9201) === 3) {
    playTimeTick(m);
  } else if (m.peek(0x99b8) === 0xa0) {
    // $09D9: lddr "FREE PLAY" from $09D8 down to $803C..$8034.
    lddr(m, 0x803c, 0x09d8, 9);
  } else {
    const credits = m.peek(0x99b5);
    // $09AC: lddr "CREDIT" to $803C..$8037, DE ends $8036; dec e skips a space.
    lddr(m, 0x803c, 0x09cf, 6);
    let de = 0x8035;
    const tens = (credits >> 4) & 0x0f; // four rlca then and $0F
    if (tens !== 0) {
      m.poke(de, tens);
      de -= 1;
    }
    m.poke(de, credits & 0x0f);
    m.poke(de - 1, 0x24);
  }
  // $09E1: l_09E1_update_game_state
  const state = m.peek(0x9201);
  if (state === 0) return undefined;
  if (state === 1 && m.peek(0x99b5) !== 0) {
    m.poke(0x9201, 2);
    // memset($9AA0,0,8), then skip $9AA8 (coin-in sound) and clear 15 more.
    const r = rst_18(m, { a: 0, b: 8, hl: 0x9aa0 });
    rst_18(m, { a: 0, b: 0x0f, hl: (r.hl & 0xff00) | ((r.hl + 1) & 0xff) });
  }
  // $09FF: credits used = old count - 51XX count (both BCD).
  const c = m.peek(0x99b5);
  const b = m.peek(0x99b8);
  const d = sub8(b, c);
  if (d.zf) return undefined;
  if (!d.cf) {
    // $0A0B: daa / dec a -> 0 for a 1-player game, 1 for 2 players.
    const used = daa(d.a, d.f).a;
    m.poke(0x99b3, (used - 1) & 0xff);
    m.poke(0x99b8, c);
    m.poke(0x9201, 3);
    return undefined;
  }
  // $0A1A: credits went up.
  m.poke(0x99b8, c);
  if (c === 0xa0) return undefined;
  const s = sub8(c, b);
  m.poke(0x9a79, daa(s.a, s.f).a);
  return undefined;
}

/**
 * $0986-$099D: add one sixtieth to the BCD play-time counter. The lowest
 * byte wraps at $60 and carries; the next three are plain BCD bytes. The
 * loop reads $99E5 on its last pass but never stores it.
 * @param {Machine} m
 */
function playTimeTick(m) {
  let hl = 0x99e9;
  const r = bcdAdd(m.peek(hl), 1);
  let a = r.a;
  // cp $60: carry = (a < $60); at $60, xor a leaves carry clear. ccf flips it.
  let cf;
  if (a === 0x60) {
    a = 0;
    cf = true;
  } else {
    cf = !(a < 0x60);
  }
  for (let b = 4; b > 0; b -= 1) {
    m.poke(hl, a);
    hl -= 1;
    const s = add8(m.peek(hl), 0, cf ? 1 : 0);
    const d = daa(s.a, s.f);
    a = d.a;
    cf = d.cf;
  }
}

/**
 * `lddr` from main ROM/RAM: copy `count` bytes downwards.
 * @param {Machine} m @param {number} de @param {number} hl @param {number} count
 */
function lddr(m, de, hl, count) {
  for (let i = 0; i < count; i += 1) m.poke(de - i, m.read('main', hl - i));
}
