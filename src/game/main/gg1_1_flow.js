// Copyright 2026 by Moshix
/**
 * The main CPU's high-level game flow (game_ctrl.s, $0185-$0725): power-on
 * inits, attract / ready-to-play, game start, stage setup, the game-runner
 * loop, fighter loss, player change, challenge-stage results, game over.
 *
 * FOREGROUND CODE. Everything here runs outside the interrupt handler and
 * waits on variables that vblank tasks change (game timers $92AC-$92AF,
 * the frame counter $92A0, task-enable flags, the game state $9201). Each
 * Z80 wait loop becomes `while (cond) yield;` -- one frame per iteration.
 *
 * JUMPS. The Z80 code is a web of `jp`s between labelled blocks that never
 * return (game runner -> restart handler -> terminate -> g_halt -> g_main
 * ...). The port keeps that shape: FLOW maps each jump target to a
 * generator that runs the block and returns the address it jumps to, and
 * runFlow() follows the chain forever. That keeps JS recursion flat no
 * matter how many games are played. Every labelled entry point is exported
 * as a generator that starts the chain there.
 *
 * The stack is never modelled: `pop hl` at gctl_stg_restart_hdlr (dropping
 * the game runner's return address) and `ld sp,$90A0` at j_Game_init only
 * touch the exempt stack area.
 *
 * @see reference/galaga-main.asm $0160-$0725
 */

import { MAIN } from './routines.js';
import { call } from '../call.js';
import { bcdAdd } from '../z80ops.js';
import { rst_18, rst_28, rst_30, c_sctrl_sprite_ram_clr } from './gg1_1_rst.js';
import { c_093C } from './gg1_1_tasks.js';
import {
  gctl_supv_score, gctl_supv_stage, c_mach_info_add_score,
  c_text_out_i_to_d, c_0A72_puts_hitmiss_ratio,
} from './gg1_1_score.js';

/**
 * @typedef {import('../../machine/machine.js').Machine} Machine
 * @typedef {Generator<symbol|undefined, number, void>} Block
 * @typedef {Generator<symbol|undefined, never, void>} Endless
 */

// ----------------------------------------------------------- plain helpers

/**
 * $00D6 c_textout_1uphighscore_onetime: "20000" as the high score and
 * "1UP    HIGH SCORE" on the top row (strings stored reversed in ROM).
 * @see galaga-main.asm $00D6
 * @param {Machine} m
 * @returns {{ de: number, hl: number }}
 */
export function c_textout_1uphighscore_onetime(m) {
  m.ldir(0x83ed, 0x02b9, 5);
  // ld e,$CB: DE was $83F2 after the first ldir.
  m.ldir(0x83cb, 0x00eb, 0x11);
  return { de: 0x83dc, hl: 0x00fc };
}

/**
 * $0160 c_sctrl_playfld_clr: blank the playfield tiles ($8040-$83BF = $24)
 * and colours ($8440-$87BF = 0), then colour the two top rows: HL is left
 * at $87BF by the ldir, so the two memsets that follow write $87BF-$87DE
 * (= 4, red) and $87DF-$87FE (= $4E, white).
 * @see galaga-main.asm $0160
 * @param {Machine} m
 * @returns {{ a: number, b: number, hl: number }}
 */
export function c_sctrl_playfld_clr(m) {
  // ld (hl),$24 / ldir: a smearing copy, i.e. a fill in ascending order.
  for (let i = 0; i <= 0x37f; i += 1) m.poke(0x8040 + i, 0x24);
  for (let i = 0; i <= 0x37f; i += 1) m.poke(0x8440 + i, 0x00);
  const r = rst_18(m, { a: 0x04, b: 0x20, hl: 0x87bf });
  return rst_18(m, { a: 0x4e, b: 0x20, hl: r.hl });
}

/**
 * $043D c_game_bonus_info_show_line: one line of the bonus info on the
 * "PUSH START BUTTON" screen: string C at its own position, then the value
 * E ("X0000 PTS": E printed 2 cells right of where the string ended, then
 * string $1E), then one fighter sprite (c_sprite_tiles_displ, $129E).
 * @see galaga-main.asm $043D
 * @param {Machine} m
 * @param {{ c: number, e: number }} regs
 */
export function c_game_bonus_info_show_line(m, { c, e }) {
  const pos = rst_30(m, { c }).hl;
  // ex de,hl / ld a,e / add a,$40 / ld e,a -- 8-bit add, no carry into D.
  const de = (pos & 0xff00) | ((pos + 0x40) & 0xff);
  // ld h,$00: L still holds the digit that came in in E.
  const r = c_text_out_i_to_d(m, { hl: e & 0xff, de });
  MAIN.c_string_out(m, { hl: r.de, c: 0x1e });
  MAIN.c_sprite_tiles_displ(m);
}

/**
 * $0466 gctl_game_init: fighters for both players from the machine
 * config, "00" as player 1's score, "00" or blanks for player 2, and blank
 * the "2UP" text for now.
 * @see galaga-main.asm $0466
 * @param {Machine} m
 * @param {{ b?: number }} [regs] B is never set by the code (the listing's
 *   own comment); it is 0 at the only call site, making the ldir count 7.
 */
export function gctl_game_init(m, regs = {}) {
  const n = m.peek(0x9982);
  m.poke(0x9820, n);
  m.poke(0x9860, n);
  const b = regs.b ?? 0;
  gctl_init_puts(m, { b, de: 0x83f8, hl: 0x0495 });
  gctl_init_puts(m, { b: 0, de: 0x83e3, hl: m.peek(0x99b3) !== 0 ? 0x0495 : 0x0497 });
}

/**
 * $0486 gctl_init_puts: copy 7 characters from HL (ROM) to DE, then blank
 * the 4 cells from $83C3 ("2UP").
 * @see galaga-main.asm $0486
 * @param {Machine} m
 * @param {{ b?: number, de: number, hl: number }} regs `ld c,7` leaves B
 *   alone, so the count is really B * 256 + 7.
 */
export function gctl_init_puts(m, { b = 0, de, hl }) {
  m.ldir(de, hl, ((b & 0xff) << 8) | 7);
  m.ldir(0x83c3, 0x0497, 4);
}

// ------------------------------------------------------ stage set-up

/**
 * Body of $01C5 stg_init_env up to the rack-advance test. Returns true when
 * the rack-advance dip switch is on, after erasing "STAGE X" -- the caller
 * must then start over at stg_init_splash.
 * @param {Machine} m
 * @returns {boolean}
 */
function stgInitEnvBody(m) {
  m.poke(0x92ae, 0x78);
  MAIN.c_2896(m);
  MAIN.c_25A2(m);
  m.poke(0x92ac, 0x02);
  MAIN.c_12C3(m, { a: 0 });
  // $01D9: clear the even bytes of $9200-$925F (object collision notices).
  for (let i = 0; i < 0x30; i += 1) m.poke(0x9200 + i * 2, 0);
  for (const addr of [0x9009, 0x9010, 0x9004, 0x9288, 0x982c, 0x9841, 0x9842,
    0x9826, 0x99b0, 0x9824]) m.poke(addr, 0);
  for (const addr of [0x982d, 0x986d, 0x9828, 0x900b, 0x9008, 0x900a]) m.poke(addr, 1);
  MAIN.c_2C00(m);
  // $0218: boss sprite codes "01 B5" x 4 at $9830.
  for (let i = 0; i < 4; i += 1) {
    m.poke(0x9830 + i * 2, 0x01);
    m.poke(0x9831 + i * 2, 0xb5);
  }
  // $0226: DSWA rack advance, active low.
  if (m.peek(0x6805) & 0x02) return false;
  MAIN.c_string_out(m, { hl: 0x83b0, c: 0x0b });
  return true;
}

/**
 * $01C5 stg_init_env: set up the stage environment (formation, attack
 * waves, enemy-status tasks).
 *
 * A PLAIN function, because the attract-mode task f_17B2 ($186C) calls it
 * from the vblank handler. With the rack-advance switch on, the ROM then
 * jumps to stg_init_splash and waits for game timer 2 -- which only the
 * main CPU's own task f_1DD2 counts down, so from inside the handler the
 * Z80 hangs until the watchdog resets the board. The port reports that
 * with an exception. The game-flow code uses stg_init_splash, which does
 * handle rack advance (it loops, as the Z80 does).
 * @see galaga-main.asm $01C5
 * @param {Machine} m
 */
export function stg_init_env(m) {
  if (stgInitEnvBody(m)) {
    throw new Error('stg_init_env: rack advance from interrupt context -- '
      + 'the Z80 hangs here until the watchdog resets it');
  }
}

/**
 * $0185 stg_init_splash: next stage. Increment the stage counter, show
 * "STAGE X" (or "CHALLENGING STAGE" with its sound), set the challenge
 * hit counter, draw the stage badges (c_new_level_tokens, $117F, which
 * waits a few frames per badge), wait for game timer 2, then fall into
 * stg_init_env. With rack advance on, repeat for the next stage.
 * @see galaga-main.asm $0185
 * @param {Machine} m
 * @returns {Generator<symbol|undefined, void, void>}
 */
export function* stg_init_splash(m) {
  for (;;) {
    m.poke(0x9821, (m.peek(0x9821) + 1) & 0xff);
    // (stage + 1) & 3 == 0 on challenging stages (3, 7, 11 ...).
    const ncs = (m.peek(0x9821) + 1) & 0x03;
    m.poke(0x9825, ncs);
    let a;
    if (ncs !== 0) {
      const pos = rst_30(m, { c: 0x06 }).hl; // "STAGE "
      c_text_out_i_to_d(m, { hl: m.peek(0x9821), de: pos });
      a = 0;
    } else {
      rst_30(m, { c: 0x07 }); // "CHALLENGING STAGE"
      m.poke(0x9aad, 1);
      a = 8;
    }
    m.poke(0x92a8, a);
    m.poke(0x92ae, 3);
    m.poke(0x920b, 3);
    // $01B7: ld a,($9825) / and a / ex af,af' -- A' = not-challenge flag
    // (the click-sound value), Cy' = 0: badge clicks on. AF' goes as `af_`.
    yield* call(MAIN.c_new_level_tokens, m, { af_: m.peek(0x9825) << 8 });
    // $01BF: while (game_tmrs[2]) {}
    while (m.peek(0x92ae) !== 0) yield;
    if (!stgInitEnvBody(m)) return;
    // $0234: jp stg_init_splash (rack advance)
  }
}

// ------------------------------------------------------ the jump web

/**
 * $02D3 j_Game_init block: one-time inits after the RAM/ROM tests, then
 * falls into g_main.
 * @param {Machine} m
 * @returns {Block}
 */
function* blk_02D3(m) {
  // ld sp,$90A0 -- stack only.
  let r = rst_18(m, { a: 0, b: 4, hl: 0x92ac }); // game timers
  r = rst_18(m, { a: 0, b: 0x20, hl: 0x9aa0 }); // sound effects
  m.poke(0xa007, 0);
  m.poke(0x9215, 0);
  m.poke(0x99b9, 0);
  rst_18(m, { a: 0xff, b: 0x10, hl: 0x92ca }); // bmbr_boss_pool + CPU flags
  m.poke(0x6820, 1);
  // $02F8: erase the test grid: top rows, bottom rows, their colours.
  r = rst_18(m, { a: 0x24, b: 0x40, hl: 0x83c0 });
  rst_18(m, { a: 0x24, b: 0x40, hl: 0x8000 | (r.hl & 0xff) });
  rst_18(m, { a: 0x03, b: 0x40, hl: 0x8400 });
  c_sctrl_playfld_clr(m);
  // $0310: the "heroes" table: five times "00002 " (20000 reversed).
  let de = 0x8a20;
  for (let i = 0; i < 5; i += 1) {
    m.ldir(de, 0x02b9, 6);
    de += 6;
  }
  // $0321: DE = $8A3E. Each of 5 passes: ldi / dec hl / ld (de),'.' /
  // inc e / ldi -- i.e. "X.X" per letter of "SCORE" (reversed) -- the
  // bytes really do write each letter twice around a dot.
  let hl = 0x02bf;
  for (let b = 5; b > 0; b -= 1) {
    m.poke(de, m.read('main', hl));
    de = (de + 1) & 0xffff;
    m.poke(de, 0x2a);
    de = (de & 0xff00) | ((de + 1) & 0xff); // inc e
    m.poke(de, m.read('main', hl));
    de = (de + 1) & 0xffff;
    hl += 1;
  }
  m.poke(0x9201, 1); // ATTRACT_MODE
  m.poke(0xa005, 0);
  m.poke(0xa005, 1);
  c_sctrl_sprite_ram_clr(m);
  c_textout_1uphighscore_onetime(m);
  yield* call(MAIN.c_1230_init_taskman_structs, m);
  rst_28(m);
  m.poke(0x901e, 0x20);
  m.poke(0x99b8, m.peek(0x99b5)); // credit count from the 51XX
  m.poke(0x901e, 0);
  m.poke(0x9020, 0);
  return 0x035a;
}

/**
 * $035A g_main block: attract mode, then the "PUSH START" screen, then a
 * new game up to plyr_respawn_splsh.
 * @param {Machine} m
 * @returns {Block}
 */
function* blk_035A(m) {
  m.poke(0xa007, 0);
  m.poke(0x9215, 0);
  m.poke(0x9012, 0);
  rst_18(m, { a: 0, b: 0x80, hl: 0x9200 });
  m.poke(0x99be, 6);
  rst_28(m);
  c_sctrl_sprite_ram_clr(m);
  yield* call(MAIN.c_1230_init_taskman_structs, m);
  const credits = m.peek(0x99b8) !== 0;
  m.poke(0x9201, credits ? 2 : 1);
  if (!credits) {
    m.poke(0x9203, 0); // demo index
    m.poke(0x9002, 1); // f_17B2 attract-mode control
    // $038D: while (game_state == ATTRACT_MODE) {}
    while (m.peek(0x9201) === 1) yield;
    yield* call(MAIN.c_1230_init_taskman_structs, m);
    c_sctrl_playfld_clr(m);
    rst_28(m);
    c_sctrl_sprite_ram_clr(m);
  }
  // $039D: l_game_state_ready
  m.poke(0x920b, 0);
  rst_30(m, { c: 0x13 }); // "(c) 1981 NAMCO LTD"
  rst_30(m, { c: 0x01 }); // "PUSH START BUTTON"
  m.poke16(0x9280, 0x0452); // p_attrmode_sptiles = d_attrmode_sptiles_ships
  let a = m.peek(0x9980);
  if (a !== 0xff) {
    c_game_bonus_info_show_line(m, { c: 0x1b, e: a });
    a = m.peek(0x9981);
    if (a !== 0xff) {
      c_game_bonus_info_show_line(m, { c: 0x1c, e: a & 0x7f });
      a = m.peek(0x9981);
      // bit 7 set: no "AND FOR EVERY" line.
      if (!(a & 0x80)) c_game_bonus_info_show_line(m, { c: 0x1d, e: a & 0x7f });
    }
  }
  // $03D8: while (game_state == READY_TO_PLAY_MODE) {}
  while (m.peek(0x9201) === 2) yield;
  // $03DF: start was pressed.
  m.poke(0x9ab7, m.peek(0x9201)); // non-zero: sound manager reset
  c_sctrl_playfld_clr(m);
  c_sctrl_sprite_ram_clr(m);
  m.poke(0xa005, 0);
  m.poke(0xa005, 1);
  rst_18(m, { a: 0, b: 0xa0, hl: 0x9820 }); // both players' data
  m.poke(0x9ab7, 0);
  m.poke(0x99b9, 0);
  m.poke(0x9aab, 1); // start-of-game theme
  m.poke(0x9012, 1); // f_1D76 star control
  m.poke(0x98f2, 1);
  gctl_game_init(m, { b: 0 });
  yield* call(MAIN.c_game_or_demo_init, m);
  rst_30(m, { c: 0x04 }); // "PLAYER 1"
  // $040F: game_tmrs[3] = 8; while (game_tmrs[3]) {}
  m.poke(0x92af, 8);
  while (m.peek(0x92af) !== 0) yield;
  rst_18(m, { a: 0, b: 0x10, hl: 0x9290 }); // hit counters
  rst_18(m, { a: 0, b: 0x30, hl: 0x98b0 }); // suspended player's objects
  MAIN.c_string_out(m, { hl: 0x83b0, c: 0x0b }); // erase "PLAYER 1"
  m.poke(0x9880, 1); // suspended player is player 2
  a = m.peek(0x9980);
  m.poke(0x983e, a);
  m.poke(0x987e, a);
  return 0x060f;
}

/**
 * $045E gctl_game_runner block: score and stage supervision, forever.
 * The Z80 spins through the two calls continuously; nothing they look at
 * changes except in interrupt handlers, so the port runs them once per
 * frame.
 * @param {Machine} m
 * @returns {Block}
 */
function* blk_045E(m) {
  for (;;) {
    gctl_supv_score(m);
    if (gctl_supv_stage(m).restart) return 0x049e;
    yield;
  }
}

/**
 * $049E gctl_stg_restart_hdlr block: the stage ended or the fighter was
 * lost. Wait for the explosion (game timer 3 = 4) or for a rescued
 * fighter to land (task $1D, f_2000), then decide what happens next.
 * @param {Machine} m
 * @returns {Block}
 */
function* blk_049E(m) {
  m.poke(0x92af, 4);
  for (;;) {
    if (m.peek(0x901d) !== 0) {
      // $04AA: fighter lost but a rescued one is landing.
      m.poke(0x9213, 0);
      m.poke(0x9025, 1);
      if (m.peek(0x92a7) !== 0) return 0x045e;
      // $04B9: last enemy gone: wait for the landing, then a new stage.
      while (m.peek(0x901d) !== 0) yield;
      return 0x04dc;
    }
    if (m.peek(0x92af) === 0) break;
    yield;
  }
  gctl_supv_score(m);
  const c = m.peek(0x92a7);
  m.poke(0x9843, c);
  if ((m.peek(0x9213) | c) !== 0) return 0x04e2;
  if (m.peek(0x9825) === 0) return 0x0650;
  return 0x04dc;
}

/**
 * $04DC l_04DC_break block: normal end of stage.
 * @param {Machine} m
 * @returns {Block}
 */
function* blk_04DC(m) {
  yield* stg_init_splash(m);
  return 0x0632;
}

/**
 * $04E2 gctl_plyr_terminate block: take a fighter; on game over show
 * "GAME OVER", the results, the high-score entry, then go on with the
 * other player or halt.
 * @param {Machine} m
 * @returns {Block}
 */
function* blk_04E2(m) {
  const ships = m.peek(0x9820);
  m.poke(0x9820, (ships - 1) & 0xff);
  if (ships !== 0) return 0x0579;
  if (m.peek(0x99b3) !== 0) {
    MAIN.c_string_out(m, { hl: 0x824e, c: (m.peek(0x9840) + 4) & 0xff }); // "PLAYER X"
  }
  rst_30(m, { c: 0x02 }); // "GAME OVER"
  yield* call(MAIN.c_tdelay_3, m);
  yield* call(MAIN.c_tdelay_3, m);
  // $0506: wait for the tractor-beam task f_2222 to finish.
  while (m.peek(0x9018) !== 0) yield;
  rst_28(m);
  c_sctrl_sprite_ram_clr(m);
  c_sctrl_playfld_clr(m);
  rst_30(m, { c: 0x15 }); // "-RESULTS-"
  rst_30(m, { c: 0x16 }); // "SHOTS FIRED"
  c_text_out_i_to_d(m, { hl: m.peek16(0x9846), de: 0x8132 });
  rst_30(m, { c: 0x18 }); // "NUMBER OF HITS"
  c_text_out_i_to_d(m, { hl: m.peek16(0x9844), de: 0x8135 });
  rst_30(m, { c: 0x19 }); // "HIT-MISS RATIO"
  const r = c_0A72_puts_hitmiss_ratio(m);
  MAIN.c_string_out(m, { hl: r.de, c: 0x1a }); // "%"
  // $053B: game_tmrs[2] = $0E; wait
  m.poke(0x92ae, 0x0e);
  while (m.peek(0x92ae) !== 0) yield;
  c_sctrl_playfld_clr(m);
  yield* call(MAIN.c_top5_dlg_proc, m);
  m.poke(0x9ab0, 0);
  // $0554: wait for the name-entry music ($9AAC) and its tail ($9AB6);
  // while $9AAC runs it is forced to 1. `halt` = one frame.
  for (;;) {
    const fx0c = m.peek(0x9aac);
    if ((m.peek(0x9ab6) | fx0c) === 0) break;
    if (fx0c !== 0) m.poke(0x9aac, 1);
    yield;
  }
  c_sctrl_playfld_clr(m);
  if (m.peek(0x99b3) === 0) return 0x06de;
  if (m.peek(0x9860) === 0xff) return 0x06de;
  if (m.peek(0x9213) !== 1) return 0x058e;
  return 0x0579;
}

/**
 * $0579 j_0579_terminate block: fighter lost, game not over.
 * @param {Machine} m
 * @returns {Block}
 */
// eslint-disable-next-line require-yield
function* blk_0579(m) {
  if (m.peek(0x99b3) === 0) return 0x0604;
  if (m.peek(0x9860) === 0xff) return 0x0612;
  if (m.peek(0x9213) !== 1) return 0x0612;
  return 0x058e;
}

/**
 * $058E j_058E_plyr_chg block: hand over to the other player: wait for
 * the flying enemies, retreat the formation (f_1D32), swap the player
 * data, rebuild the screen for the new player and bring their formation
 * back.
 * @param {Machine} m
 * @returns {Block}
 */
function* blk_058E(m) {
  if (m.peek(0x92a7) !== 0) {
    while (m.peek(0x9287) !== 0) yield;
  }
  // $059A
  m.poke(0x99b4, 0);
  m.poke(0x900e, 1);
  while (m.peek(0x900e) !== 0) yield;
  m.poke(0x9848, m.peek(0x9aa0));
  m.poke(0x983f, m.peek(0x92ae));
  yield* call(MAIN.c_player_active_switch, m);
  yield* call(MAIN.c_2C00, m);
  m.poke(0x92ae, m.peek(0x983f));
  m.poke(0x9aa0, m.peek(0x9848));
  MAIN.draw_resv_ships(m);
  if (m.peek(0x9843) !== 0) yield* call(MAIN.c_25A2, m);
  // $05D1: flip the screen for player 2 on a cocktail cabinet.
  const flip = m.peek(0x9840) & m.peek(0x9983);
  m.poke(0xa007, flip);
  m.poke(0x9215, flip);
  yield* call(MAIN.c_12C3, m, { a: 0x3f });
  // $05E4: scf / ex af,af' -- Cy' set: no badge clicks. A' is what c_12C3
  // left in A, which is its last load: ld a,($9215). (Only bit 0 of F'
  // is ever looked at, so the other flag bits are left 0.)
  yield* call(MAIN.c_new_level_tokens, m, { af_: (m.peek(0x9215) << 8) | 0x01 });
  if (m.peek(0x9843) === 0) return 0x060f;
  rst_30(m, { c: 0x03 }); // "READY"
  m.poke(0x99b4, 0x80);
  m.poke(0x900e, 1);
  while (m.peek(0x900e) !== 0) yield;
  return 0x0612;
}

/**
 * $0604 plyr_respawn_1up block: one-player respawn; a new stage first if
 * the fighter took the last enemy with it.
 * @param {Machine} m
 * @returns {Block}
 */
function* blk_0604(m) {
  if (m.peek(0x9843) === 0) yield* stg_init_splash(m);
  return 0x061e;
}

/**
 * $060F plyr_respawn_splsh block: new stage, then plyr_respawn_plyrup.
 * @param {Machine} m
 * @returns {Block}
 */
function* blk_060F(m) {
  yield* stg_init_splash(m);
  return 0x0612;
}

/**
 * $0612 plyr_respawn_plyrup block: "PLAYER X" above the stage text.
 * @param {Machine} m
 * @returns {Block}
 */
// eslint-disable-next-line require-yield
function* blk_0612(m) {
  MAIN.c_string_out(m, { hl: 0x826e, c: (m.peek(0x9840) + 4) & 0xff });
  return 0x061e;
}

/**
 * $061E gctl_plyr_respawn_wait block: put the fighter on screen
 * (c_player_respawn, which waits for the flying enemies), top game timer 2
 * up by 30 (capped at $78, 8-bit wrap included), then c_tdelay_3.
 * @param {Machine} m
 * @returns {Block}
 */
function* blk_061E(m) {
  yield* call(MAIN.c_player_respawn, m);
  let a = (m.peek(0x92ae) + 0x1e) & 0xff;
  if (a >= 0x78) a = 0x78;
  m.poke(0x92ae, a);
  yield* call(MAIN.c_tdelay_3, m);
  return 0x0632;
}

/**
 * $0632 plyr_respawn_rdy block: enable fire and hit detection and attack
 * waves, erase the texts, back to the game runner.
 * @param {Machine} m
 * @returns {Block}
 */
// eslint-disable-next-line require-yield
function* blk_0632(m) {
  m.poke(0x9015, 1);
  m.poke(0x9025, 1);
  m.poke(0x9842, 1);
  MAIN.c_string_out(m, { hl: 0x83b0, c: 0x0b });
  MAIN.c_string_out(m, { hl: 0x83ae, c: 0x0b });
  return 0x045e;
}

/**
 * $0650 gctl_chllng_stg_end block: challenging-stage results: "NUMBER OF
 * HITS nn", then "BONUS nnnn" or, for all 40, a blinking "PERFECT !" and
 * "SPECIAL BONUS 10000 PTS". The bonus is scored through the challenge
 * multiplier counter $929F.
 * @param {Machine} m
 * @returns {Block}
 */
function* blk_0650(m) {
  const e = m.peek(0x9288);
  m.poke(e === 0x28 ? 0x9ab4 : 0x9aae, 1); // "perfect" or normal melody
  yield* call(MAIN.c_tdelay_3, m);
  rst_30(m, { c: 0x08 }); // "NUMBER OF HITS"
  yield* call(MAIN.c_tdelay_3, m);
  c_text_out_i_to_d(m, { hl: e, de: 0x8110 });
  yield* call(MAIN.c_tdelay_3, m);
  let a;
  if (m.peek(0x9288) !== 0x28) {
    const pos = rst_30(m, { c: 0x09 }).hl; // "BONUS"
    yield* call(MAIN.c_tdelay_3, m); // preserves HL
    let de = pos; // ex de,hl
    a = m.peek(0x9288);
    if (a !== 0) {
      de = c_text_out_i_to_d(m, { hl: a, de }).de; // hits (x100)
      m.poke(de, 0); // tens
      de = (de - 0x20) & 0xffff;
      a = 0;
    }
    m.poke(de, a); // ones
    a = m.peek(0x9288);
  } else {
    // $0699: blink "PERFECT !" 7 times, on frame-counter multiples of 16.
    for (let b = 7; b > 0; b -= 1) {
      while ((m.peek(0x92a0) & 0x0f) !== 0) yield;
      rst_30(m, { c: (b & 1) ? 0x0c : 0x0b });
      while ((m.peek(0x92a0) & 0x0f) === 0) yield;
    }
    rst_30(m, { c: 0x0d }); // "SPECIAL BONUS 10000 PTS"
    a = 0x64;
  }
  // $06BA: add to the challenge bonus counter and score it.
  m.poke(0x929f, (a + m.peek(0x929f)) & 0xff);
  gctl_supv_score(m);
  yield* call(MAIN.c_tdelay_3, m);
  yield* call(MAIN.c_tdelay_3, m);
  MAIN.c_string_out(m, { hl: 0x83b0, c: 0x0b });
  MAIN.c_string_out(m, { hl: 0x83b3, c: 0x0b });
  rst_30(m, { c: 0x0b });
  return 0x04dc;
}

/**
 * $06DE g_halt block: end of game. Wait a frame (`halt`), send $02 x3 to
 * the 51XX (command $61), clear the sounds, add the scores to the
 * machine's totals, count the play in BCD at $99E0, back to g_main.
 * @param {Machine} m
 * @returns {Block}
 */
function* blk_06DE(m) {
  yield; // $06DE: halt -- until the next vblank IRQ
  m.di();
  // $06E0: wait for the 06XX to be idle (always so in the port, where a
  // transfer completes as soon as it is issued).
  while (m.peek(0x7100) !== 0x10) yield;
  // $06E7: HL'=$0725 DE'=$7000 BC'=3, command $61: write 3 bytes to the 51XX.
  if (m.io) {
    m.io.transfer(0x61, 0x0725, 3);
  } else {
    m.poke(0x7100, 0x61);
    m.poke(0x7100, 0x10);
  }
  // $06F6: halt with interrupts off: woken within microseconds by the
  // transfer's first NMI, so no frame passes.
  c_093C(m, { a: 0 });
  m.ei();
  rst_18(m, { a: 0, b: 0x20, hl: 0x9aa0 });
  c_mach_info_add_score(m, { de: 0x83f9 });
  c_mach_info_add_score(m, { de: 0x83e4 });
  // $070F: total plays += 1 (1P) or 2 (2P), 4-digit BCD at $99E0.
  const lo = bcdAdd((m.peek(0x99b3) + 1) & 0xff, m.peek(0x99e1));
  m.poke(0x99e1, lo.a);
  if (lo.cf) m.poke(0x99e0, bcdAdd(m.peek(0x99e0), 1).a);
  return 0x035a;
}

/** Jump target -> block. @type {Readonly<Record<number, (m: Machine) => Block>>} */
export const FLOW = Object.freeze({
  0x02d3: blk_02D3,
  0x035a: blk_035A,
  0x045e: blk_045E,
  0x049e: blk_049E,
  0x04dc: blk_04DC,
  0x04e2: blk_04E2,
  0x0579: blk_0579,
  0x058e: blk_058E,
  0x0604: blk_0604,
  0x060f: blk_060F,
  0x0612: blk_0612,
  0x061e: blk_061E,
  0x0632: blk_0632,
  0x0650: blk_0650,
  0x06de: blk_06DE,
});

/**
 * Follow the game's jumps forever, starting at `pc`.
 * @param {Machine} m
 * @param {number} pc
 * @returns {Endless}
 */
export function* runFlow(m, pc) {
  for (;;) {
    const blk = FLOW[pc];
    if (blk === undefined) throw new Error(`game flow: no block at $${pc.toString(16)}`);
    pc = yield* blk(m);
  }
}

/** @param {number} pc @returns {(m: Machine) => Endless} */
const entry = (pc) => (m) => runFlow(m, pc);

/**
 * $02D3 j_Game_init: the one-time power-on inits, entered by `jp` from the
 * end of the RAM/ROM tests ($376D); continues into g_main and never
 * returns. GENERATOR.
 * @see galaga-main.asm $02D3
 */
export const j_Game_init = entry(0x02d3);
/** $035A g_main: attract mode -> ready -> game. GENERATOR, never returns. @see galaga-main.asm $035A */
export const g_main = entry(0x035a);
/** $045E gctl_game_runner. GENERATOR, never returns. @see galaga-main.asm $045E */
export const gctl_game_runner = entry(0x045e);
/** $049E gctl_stg_restart_hdlr. GENERATOR, never returns. @see galaga-main.asm $049E */
export const gctl_stg_restart_hdlr = entry(0x049e);
/** $04DC l_04DC_break. GENERATOR, never returns. @see galaga-main.asm $04DC */
export const l_04DC_break = entry(0x04dc);
/** $04E2 gctl_plyr_terminate. GENERATOR, never returns. @see galaga-main.asm $04E2 */
export const gctl_plyr_terminate = entry(0x04e2);
/** $0579 j_0579_terminate. GENERATOR, never returns. @see galaga-main.asm $0579 */
export const j_0579_terminate = entry(0x0579);
/** $058E j_058E_plyr_chg. GENERATOR, never returns. @see galaga-main.asm $058E */
export const j_058E_plyr_chg = entry(0x058e);
/** $0604 plyr_respawn_1up. GENERATOR, never returns. @see galaga-main.asm $0604 */
export const plyr_respawn_1up = entry(0x0604);
/** $060F plyr_respawn_splsh. GENERATOR, never returns. @see galaga-main.asm $060F */
export const plyr_respawn_splsh = entry(0x060f);
/** $0612 plyr_respawn_plyrup. GENERATOR, never returns. @see galaga-main.asm $0612 */
export const plyr_respawn_plyrup = entry(0x0612);
/** $061E gctl_plyr_respawn_wait. GENERATOR, never returns. @see galaga-main.asm $061E */
export const gctl_plyr_respawn_wait = entry(0x061e);
/** $0632 plyr_respawn_rdy. GENERATOR, never returns. @see galaga-main.asm $0632 */
export const plyr_respawn_rdy = entry(0x0632);
/** $0650 gctl_chllng_stg_end. GENERATOR, never returns. @see galaga-main.asm $0650 */
export const gctl_chllng_stg_end = entry(0x0650);
/** $06DE g_halt. GENERATOR, never returns. @see galaga-main.asm $06DE */
export const g_halt = entry(0x06de);
