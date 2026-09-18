// Copyright 2026 by Moshix
/**
 * gg1-3 $2C00 (new_stage.s): per-stage bomber parameters.
 *
 * @see reference/galaga-main.asm $2C00-$2E74
 * @see reference/neiderm/galag/galagao_ASxxx/rom0/new_stage.s
 */

import { romByte, romWord } from '../romdata.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/** `rlca`. @param {number} a */
const rlca8 = (a) => ((a << 1) | (a >> 7)) & 0xff;

/**
 * stg_bombr_setparms: unpack the stage's 5 bytes of bmbr_stg_cfg_dat (table
 * picked by the rank dip switches via bmbr_stg_cfg_lut, row by stage, the
 * last 8 stages repeating past $1A) into 10 nibbles at ds_new_stage_parms
 * ($99C0-$99C9); set $99CA (aliens left for continuous bombing: 0 before
 * stage 3 and on challenge stages, else $0A); reset the bomber ready
 * timers $92C0-$92C2; set the star speed $99BB from the stage number.
 * @see galaga-main.asm $2C00
 * @param {Machine} m
 */
export function c_2C00(m) {
  let a = m.peek(0x9821);
  while (a >= 0x1b) a -= 4;
  // 0x2C0B: E = (stage - 1) * 5, 8-bit ("dec a / ld l,a / rlca / rlca / add a,l")
  a = (a - 1) & 0xff;
  const e = (rlca8(rlca8(a)) + a) & 0xff;
  let hl = romWord('main', 0x2c65 + 2 * m.peek(0x9984)); // rst $08
  hl = (hl + e) & 0xffff; // rst $10
  let de = 0x99c0;
  for (let b = 0; b < 5; b += 1) {
    const v = romByte('main', hl);
    m.poke(de, v >> 4);
    de = (de & 0xff00) | ((de + 1) & 0xff); // inc e
    m.poke(de, v & 0x0f);
    de = (de & 0xff00) | ((de + 1) & 0xff);
    hl = (hl + 1) & 0xffff;
  }
  a = m.peek(0x9821);
  if (a < 0x03) a = 0;
  else {
    // 0x2C3F: or $FC / inc a -- zero exactly on challenge stages (%4 == 3)
    a = ((a | 0xfc) + 1) & 0xff;
    if (a !== 0) a = 0x0a;
  }
  m.poke(de, a);
  // 0x2C47: ld bc,$0216 / ld ($92C1),bc / ld ($92C0),bc
  m.poke16(0x92c1, 0x0216);
  m.poke16(0x92c0, 0x0216);
  a = m.peek(0x9821);
  if (a >= 0x10) a = 0x10;
  a = ((rlca8(rlca8(a)) & 0x70) + 0x40) & 0xff;
  m.poke(0x99bb, a);
}
