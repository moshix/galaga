// Copyright 2026 by Moshix
/**
 * Main CPU $1000-$1FFF (chip gg1_2b.3m, rev. B): registers every routine of
 * this ROM range in MAIN (by label) and in MAIN_AT (by rev. B address).
 *
 *   gg1_2_util.js      $1000-$16FF  math, randomizer, attack-slot setup,
 *                                   player changeover, stage tokens, reserve
 *                                   ships, task defaults, string printer
 *   gg1_2_fx.js        $1700-$1FFF  periodic tasks: demo fighter, attract
 *                                   sequencer, capture, bonus bee, bomber
 *                                   launcher, nest, stars, hits, timers,
 *                                   formation breathing, bombs, fire, stick
 *
 * Generators (foreground only, they wait for vblank): c_new_level_tokens,
 * c_11E3_show_tokens_1, c_11E9, c_build_token_1, c_tdelay_3,
 * c_player_respawn, c_133A. Everything else is a plain function.
 *
 * Reached indirectly, hence in MAIN_AT:
 *   task table $0096: $1700 $17B2 $1A86 $1B6B $19B2 $1D38 $1D7C $1DB9 $1DD8
 *                     $1DEC $1EAA $1F0E $1F8F
 *   d_1713 / d_1786 (f_1700 tokens), d_17C3_jptbl (f_17B2 states),
 *   d_1BD1 (bomber types).
 * @see docs/porting-guide.md section 3
 */
import { MAIN, MAIN_AT } from './routines.js';
import * as U from './gg1_2_util.js';
import * as F from './gg1_2_fx.js';

/** @type {Array<[number, string, Function]>} rev. B address, label, routine */
const ROUTINES = [
  [0x1000, 'c_1000', U.c_1000],
  [0x1012, 'sub_1012', U.sub_1012],
  [0x104e, 'c_104E_mul_16_8', U.c_104E_mul_16_8],
  [0x1061, 'c_divmod', U.c_divmod],
  [0x1079, 'c_1079', U.c_1079],
  [0x1083, 'c_1083', U.c_1083],
  [0x108a, 'j_108A', U.j_108A],
  [0x110c, 'c_player_active_switch', U.c_player_active_switch],
  [0x117f, 'c_new_level_tokens', U.c_new_level_tokens],
  [0x11f5, 'c_11E3_show_tokens_1', U.c_11E3_show_tokens_1],
  [0x11fb, 'c_11E9', U.c_11E9],
  [0x1213, 'c_build_token_1', U.c_build_token_1],
  [0x1228, 'c_build_token_2', U.c_build_token_2],
  [0x1242, 'c_1230_init_taskman_structs', U.c_1230_init_taskman_structs],
  [0x127b, 'c_game_or_demo_init', U.c_game_or_demo_init],
  [0x129e, 'c_sprite_tiles_displ', U.c_sprite_tiles_displ],
  [0x12d5, 'c_12C3', U.c_12C3],
  [0x1331, 'c_tdelay_3', U.c_tdelay_3],
  [0x133d, 'c_player_respawn', U.c_player_respawn],
  [0x137e, 'draw_resv_ships', U.draw_resv_ships],
  [0x1398, 'draw_resv_ship_tile', U.draw_resv_ship_tile],
  [0x13b3, 'c_string_out', U.c_string_out],
  [0x13b5, 'j_string_out_pe', U.j_string_out_pe],
  [0x1700, 'f_1700', F.f_1700],
  [0x171f, 'case_171F', F.case_171F],
  [0x172d, 'case_172D', F.case_172D],
  [0x1734, 'case_1734', F.case_1734],
  [0x1766, 'case_1766', F.case_1766],
  [0x1794, 'case_1794', F.case_1794],
  [0x179c, 'case_179C', F.case_179C],
  [0x17a1, 'case_17A1', F.case_17A1],
  [0x17a8, 'case_17A8', F.case_17A8],
  [0x17ae, 'case_17AE', F.case_17AE],
  [0x17b2, 'f_17B2', F.f_17B2],
  [0x17e1, 'case_17E1', F.case_17E1],
  [0x17f5, 'case_17F5', F.case_17F5],
  [0x1808, 'case_1808', F.case_1808],
  [0x1840, 'case_1840', F.case_1840],
  [0x1852, 'case_1852', F.case_1852],
  [0x18ac, 'case_18AC', F.case_18AC],
  [0x18d1, 'case_18D1', F.case_18D1],
  [0x18d9, 'case_18D9', F.case_18D9],
  [0x1940, 'case_1940', F.case_1940],
  [0x1948, 'case_1948', F.case_1948],
  [0x1984, 'case_1984', F.case_1984],
  [0x19a7, 'l_attmode_state_step', F.l_attmode_state_step],
  [0x19b2, 'f_19B2', F.f_19B2],
  [0x1a86, 'f_1A80', F.f_1A80],
  [0x1b6b, 'f_1B65', F.f_1B65],
  [0x1bdd, 'case_bmbr_yellow', F.case_bmbr_yellow],
  [0x1bfd, 'case_bmbr_red', F.case_bmbr_red],
  [0x1c07, 'case_bmbr_boss', F.case_bmbr_boss],
  [0x1c93, 'c_1C8D', F.c_1C8D],
  [0x1ca6, 'j_1CA0', F.j_1CA0],
  [0x1cb4, 'j_1CAE', F.j_1CAE],
  [0x1d09, 'c_1D03', F.c_1D03],
  [0x1d1c, 'l_1D16', F.l_1D16],
  [0x1d38, 'f_1D32', F.f_1D32],
  [0x1d7c, 'f_1D76', F.f_1D76],
  [0x1db9, 'f_1DB3', F.f_1DB3],
  [0x1dd8, 'f_1DD2', F.f_1DD2],
  [0x1dec, 'f_1DE6', F.f_1DE6],
  [0x1e49, 'c_1E43', F.c_1E43],
  [0x1eaa, 'f_1EA4', F.f_1EA4],
  [0x1f0e, 'f_1F04', F.f_1F04],
  [0x1f19, 'c_1F0F', F.c_1F0F],
  [0x1f8f, 'f_1F85', F.f_1F85],
  [0x1f9c, 'c_1F92', F.c_1F92],
];

for (const [addr, name, fn] of ROUTINES) {
  MAIN[name] = fn;
  MAIN_AT[addr] = fn;
}

// $134C carries two labels. c_133A is the foreground entry (a generator that
// waits for $9287 == 0); l_133A is the same code as the attract-mode task
// reaches it from inside the interrupt, where the port cannot wait.
MAIN.c_133A = U.c_133A;
MAIN.l_133A = U.l_133A;
MAIN_AT[0x134c] = U.c_133A;

/** Labels this module registers, for tests and diagnostics. */
export const GG1_2_ROUTINES = Object.freeze(ROUTINES.map(([addr, name]) => ({ addr, name })));
