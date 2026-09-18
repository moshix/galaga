// Copyright 2026 by Moshix
/**
 * Main CPU ROM gg1_1b.3p, $0000-$0FFF: interrupt vectors (int.s), the task
 * manager (task_man.s) and the high-level game control (game_ctrl.s).
 * Importing this module registers every routine of the range in MAIN and,
 * for everything reachable indirectly, in MAIN_AT.
 *
 *   gg1_1_rst.js    $0000-$0051  RST helpers, c_task_switcher, sprite RAM clear
 *   gg1_1_irq.js    $0000,$0237,$02C4  reset path, vblank handler / task manager
 *   gg1_1_state.js               the RAM-test restart request (f_0977)
 *   gg1_1_flow.js   $00D6-$0725  power-on inits, attract, game flow (generators)
 *   gg1_1_score.js  $0728-$0B0E  score manager, number printing, hit ratio
 *   gg1_1_tasks.js  $0827-$0A26  the periodic tasks in this range
 *
 * @see docs/porting-guide.md
 * @see reference/galaga-main.asm $0000-$0FFF
 */

import { MAIN, MAIN_AT } from './routines.js';
import {
  rst_08, rst_HLplusA, rst_18, rst_DEminus20, rst_28, rst_30,
  c_task_switcher, c_sctrl_sprite_ram_clr,
} from './gg1_1_rst.js';
import { main_reset, main_irq, main_irq_steps, CPU0_RESET } from './gg1_1_irq.js';
import {
  f_0827, f_0828, f_0857, c_08AD, c_08BE, f_0935, c_093C, c_095F, f_0977,
} from './gg1_1_tasks.js';
import {
  gctl_supv_score, c_scoreman_incr_add, gctl_supv_stage, c_mach_info_add_score,
  c_text_out_i_to_d, c_0A6E, c_0A72_puts_hitmiss_ratio, c_0B06,
} from './gg1_1_score.js';
import {
  c_textout_1uphighscore_onetime, c_sctrl_playfld_clr, c_game_bonus_info_show_line,
  gctl_game_init, gctl_init_puts, stg_init_env, stg_init_splash,
  j_Game_init, g_main, gctl_game_runner, gctl_stg_restart_hdlr, l_04DC_break,
  gctl_plyr_terminate, j_0579_terminate, j_058E_plyr_chg, plyr_respawn_1up,
  plyr_respawn_splsh, plyr_respawn_plyrup, gctl_plyr_respawn_wait, plyr_respawn_rdy,
  gctl_chllng_stg_end, g_halt,
} from './gg1_1_flow.js';

Object.assign(MAIN, {
  // Entry points the CPU ports use (see index.js).
  main_reset, main_irq, main_irq_steps,
  // RST helpers under their listing labels, plus plain aliases.
  rst_08, rst_HLplusA, rst_10: rst_HLplusA, l_0018: rst_18, rst_18,
  rst_DEminus20, rst_20: rst_DEminus20, rst_28, rst_30,
  c_task_switcher, c_sctrl_sprite_ram_clr,
  // $0237 is main_irq; the listing calls it jp_Task_man.
  jp_Task_man: main_irq, CPU0_RESET,
  c_textout_1uphighscore_onetime, c_sctrl_playfld_clr, stg_init_splash, stg_init_env,
  j_Game_init, g_main, c_game_bonus_info_show_line, gctl_game_runner, gctl_game_init,
  gctl_init_puts, gctl_stg_restart_hdlr, l_04DC_break, gctl_plyr_terminate,
  j_0579_terminate, j_058E_plyr_chg, plyr_respawn_1up, plyr_respawn_splsh,
  plyr_respawn_plyrup, gctl_plyr_respawn_wait, plyr_respawn_rdy, gctl_chllng_stg_end,
  g_halt,
  gctl_supv_score, c_scoreman_incr_add, gctl_supv_stage,
  f_0827, f_0828, f_0857, c_08AD, c_08BE, f_0935, c_093C, c_095F, f_0977,
  c_mach_info_add_score, c_text_out_i_to_d, c_0A6E, c_0A72_puts_hitmiss_ratio, c_0B06,
});

Object.assign(MAIN_AT, {
  // Task table d_cpu0_task_table ($0096): every entry in this range.
  0x0827: f_0827, 0x0828: f_0828, 0x0857: f_0857, 0x0935: f_0935, 0x0977: f_0977,
  // Vectors and jump targets (also reached by jp from other ranges:
  // $376D jp j_Game_init, $377B jp rst_HLplusA).
  0x0000: main_reset, 0x0008: rst_08, 0x0010: rst_HLplusA, 0x0018: rst_18,
  0x0020: rst_DEminus20, 0x0028: rst_28, 0x0030: rst_30, 0x0038: main_irq,
  0x003b: c_task_switcher, 0x003c: c_sctrl_sprite_ram_clr,
  0x00d6: c_textout_1uphighscore_onetime, 0x0160: c_sctrl_playfld_clr,
  0x0185: stg_init_splash, 0x01c5: stg_init_env, 0x0237: main_irq, 0x02c4: CPU0_RESET,
  0x02d3: j_Game_init, 0x035a: g_main, 0x043d: c_game_bonus_info_show_line,
  0x045e: gctl_game_runner, 0x0466: gctl_game_init, 0x0486: gctl_init_puts,
  0x049e: gctl_stg_restart_hdlr, 0x04dc: l_04DC_break, 0x04e2: gctl_plyr_terminate,
  0x0579: j_0579_terminate, 0x058e: j_058E_plyr_chg, 0x0604: plyr_respawn_1up,
  0x060f: plyr_respawn_splsh, 0x0612: plyr_respawn_plyrup, 0x061e: gctl_plyr_respawn_wait,
  0x0632: plyr_respawn_rdy, 0x0650: gctl_chllng_stg_end, 0x06de: g_halt,
  0x0728: gctl_supv_score, 0x07d8: c_scoreman_incr_add, 0x080b: gctl_supv_stage,
  0x08ad: c_08AD, 0x08be: c_08BE, 0x093c: c_093C, 0x095f: c_095F,
  0x0a27: c_mach_info_add_score, 0x0a53: c_text_out_i_to_d, 0x0a6e: c_0A6E,
  0x0a72: c_0A72_puts_hitmiss_ratio, 0x0b06: c_0B06,
});
