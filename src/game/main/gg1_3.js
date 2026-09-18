// Copyright 2026 by Moshix
/**
 * Main CPU $2000-$2FFF (gg1_3.2m): formation, capture beam, attack waves,
 * object states, new-stage parameters. This file registers every routine of
 * the range; the code lives in the gg1_3_*.js helper files.
 *
 *   gg1_3_capture.js  $2000-$23DC  tractor beam, captured/rescued fighter
 *   gg1_3_objects.js  $23DD-$25A1  object state machine (f_23DD / c_23E0)
 *   gg1_3_waves.js    $25A2-$2AEC  attack wave table, launch, sway
 *   gg1_3_stage.js    $2C00-$2E74  per-stage bomber parameters
 *
 * None of these routines waits, so none is a generator.
 * @see docs/porting-guide.md
 */

import { MAIN, MAIN_AT } from './routines.js';
import { f_2000, f_20F2, c_2188_ship_spin, f_21CB, f_2222, c_238A } from './gg1_3_capture.js';
import { f_23DD, c_23E0 } from './gg1_3_objects.js';
import { c_25A2, c_2896, c_28E9, f_2916, f_2A90 } from './gg1_3_waves.js';
import { c_2C00 } from './gg1_3_stage.js';

Object.assign(MAIN, {
  f_2000, f_20F2, c_2188_ship_spin, f_21CB, f_2222, c_238A,
  f_23DD, c_23E0,
  c_25A2, c_2896, c_28E9, f_2916, f_2A90,
  c_2C00,
});

// Task table entries at ROM $0096 that point into this range ($1D, $1C,
// $19, $18, $0C, $08, $0A), plus the directly called routines.
Object.assign(MAIN_AT, {
  0x2000: f_2000,
  0x20f2: f_20F2,
  0x21cb: f_21CB,
  0x2222: f_2222,
  0x23dd: f_23DD,
  0x2916: f_2916,
  0x2a90: f_2A90,
  0x2188: c_2188_ship_spin,
  0x238a: c_238A,
  0x23e0: c_23E0,
  0x25a2: c_25A2,
  0x2896: c_2896,
  0x28e9: c_28E9,
  0x2c00: c_2C00,
});

export {
  f_2000, f_20F2, c_2188_ship_spin, f_21CB, f_2222, c_238A,
  f_23DD, c_23E0,
  c_25A2, c_2896, c_28E9, f_2916, f_2A90,
  c_2C00,
};
