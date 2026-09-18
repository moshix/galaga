// Copyright 2026 by Moshix
/**
 * Per-machine bookkeeping the port needs where the Z80 used its program
 * counter and stack instead of RAM.
 *
 * The one case in $0000-$0FFF: f_0977 ($097C) jumps from inside the vblank
 * interrupt handler straight to the power-on RAM test ($336C) when the 51XX
 * reports the service switch ($BB). On the Z80 the interrupted foreground
 * and the handler's own stack frame are simply abandoned. The port cannot
 * jump out of a JS call chain, so the task records the request here, the
 * task manager returns early (skipping everything the Z80 skipped), and the
 * foreground driver in main_reset discards the running game-flow generator
 * and starts jp_RAM_test in its place.
 *
 * Kept in a WeakMap rather than on the Machine so no framework file changes.
 */

/**
 * @typedef {import('../../machine/machine.js').Machine} Machine
 * @typedef {{ ramTest: boolean }} MainState
 */

/** @type {WeakMap<Machine, MainState>} */
const STATE = new WeakMap();

/**
 * @param {Machine} m
 * @returns {MainState}
 */
export function mainState(m) {
  let s = STATE.get(m);
  if (s === undefined) {
    s = { ramTest: false };
    STATE.set(m, s);
  }
  return s;
}

/**
 * Ask the foreground driver to restart at jp_RAM_test ($336C).
 * @param {Machine} m
 */
export function requestRamTest(m) {
  mainState(m).ramTest = true;
}
