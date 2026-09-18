// Copyright 2026 by Moshix
/**
 * Main CPU $3000-$3FFF (chip gg1_4b.2l): the high-score initials dialog,
 * the TOP 5 / "GALACTIC HEROES" table, the power-on self test and the
 * service (self-test) mode. Importing this module registers every routine
 * of the range in MAIN, and in MAIN_AT the ones reached by address (the
 * entry points other ranges jump to, and the d_31A6 jump table).
 *
 *   gg1_4_text.js   text writers, TOP 5 table          $3214-$3344
 *   gg1_4_top5.js   "ENTER YOUR INITIALS !" dialog     $3000-$3213, $32ED
 *   gg1_4_svc.js    service-mode helpers, dip report   $3770-$3A6F
 *   gg1_4_post.js   RAM/ROM tests, service loop, boot  $336C-$376F
 *
 * $3B9F-$3FFF is unused ($FF) apart from the ROM's checksum bytes.
 * @see docs/porting-guide.md, reference/galaga-main.asm $3000-$3FFF
 */

import { MAIN, MAIN_AT } from './routines.js';
import {
  c_text_out, c_text_out_ce, c_3270, c_3273, c_3275, c_3231,
  c_puts_top5scores, c_mach_hiscore_show,
} from './gg1_4_text.js';
import {
  c_top5_dlg_proc, c_31F7_chk_score_rank, c_3118_insert_top5_score,
  case_31B0, case_31B4, case_31B8, case_31CE, case_31D9,
  c_3138_lda2A, c_313B_lda24, c_313E_lda0A, c_3141_xor_char_color,
  c_plyr_initials_entry_hilite_line, c_32ED_top5_dlg_endproc,
} from './gg1_4_top5.js';
import {
  c_io_cmd_wait, c_tileram_regs_clr, c_spriteposn_regs_init,
  c_svc_clr_snd_regs, c_39AE, c_39AA, c_39A0, c_3997,
  c_svc_machine_totals, c_svc_machine_ttls_erase, c_svc_test_sound_sel,
  c_svc_test_input_hdlr, c_svc_cab_type, c_391E, c_38DA, c_svc_updt_dsply,
  c_3774, c_svc_easteregg_hdlr,
} from './gg1_4_svc.js';
import {
  jp_RAM_test, j_ramtest_ng, c_rom_test_csum_calc, j_romtest_ng,
} from './gg1_4_post.js';

Object.assign(MAIN, {
  // high-score dialog and table
  c_top5_dlg_proc, c_31F7_chk_score_rank, c_3118_insert_top5_score,
  case_31B0, case_31B4, case_31B8, case_31CE, case_31D9,
  c_3138_lda2A, c_313B_lda24, c_313E_lda0A, c_3141_xor_char_color,
  c_plyr_initials_entry_hilite_line, c_32ED_top5_dlg_endproc,
  c_mach_hiscore_show, c_puts_top5scores, c_3231, c_3270, c_3273, c_3275,
  c_text_out, c_text_out_ce,
  // power-on self test
  jp_RAM_test, j_ramtest_ng, c_rom_test_csum_calc, j_romtest_ng,
  // service mode
  c_io_cmd_wait, _l_37F4: c_svc_updt_dsply, c_svc_updt_dsply, c_38DA, c_391E,
  c_tileram_regs_clr, c_spriteposn_regs_init, c_svc_machine_totals,
  c_3997, c_39A0, c_39AA, c_39AE, c_svc_machine_ttls_erase,
  c_svc_test_input_hdlr, c_svc_test_sound_sel, c_svc_clr_snd_regs,
  c_svc_cab_type, c_svc_easteregg_hdlr, c_3774,
});

Object.assign(MAIN_AT, {
  0x3000: c_top5_dlg_proc, // call from $0547
  0x3118: c_3118_insert_top5_score,
  // d_31A6: the `jp (hl)` table of c_3118_insert_top5_score
  0x31b0: case_31B0, 0x31b4: case_31B4, 0x31b8: case_31B8,
  0x31ce: case_31CE, 0x31d9: case_31D9,
  0x31f7: c_31F7_chk_score_rank,
  0x3214: c_mach_hiscore_show, // call from $17EC
  0x321d: c_puts_top5scores,
  0x331b: c_text_out, 0x3328: c_text_out_ce,
  0x336c: jp_RAM_test, // jp from $02D0 and $097C
  0x34ca: j_ramtest_ng, 0x352b: c_rom_test_csum_calc, 0x353f: j_romtest_ng,
  0x37f6: c_io_cmd_wait, 0x37fe: c_svc_updt_dsply,
  0x3962: c_tileram_regs_clr, 0x397c: c_spriteposn_regs_init,
  0x3987: c_svc_machine_totals, 0x39c5: c_svc_machine_ttls_erase,
  0x39e0: c_svc_test_input_hdlr, 0x39fc: c_svc_test_sound_sel,
  0x3a46: c_svc_clr_snd_regs, 0x3a6b: c_svc_cab_type,
  0x3770: c_svc_easteregg_hdlr,
});
