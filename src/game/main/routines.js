// Copyright 2026 by Moshix
/**
 * The main CPU's routine tables. A leaf module with no imports, so every
 * module of this CPU can register into it and call through it no matter
 * which order the modules load in. @see docs/porting-guide.md section 3
 */

/**
 * Routine name (the label in reference/galaga-main.asm) -> function.
 * @type {Record<string, Function>}
 */
export const MAIN = {};

/**
 * Rev. B address -> function, for everything reached indirectly: task
 * tables, `jp (hl)` jump tables, pointers held in RAM or ROM data.
 * @type {Record<number, Function>}
 */
export const MAIN_AT = {};

/**
 * Look up a routine by address, failing loudly when the port lacks it.
 * @param {number} addr
 * @returns {Function}
 */
export function mainAt(addr) {
  const fn = MAIN_AT[addr];
  if (fn === undefined) throw new Error(`main CPU: no routine registered at $${addr.toString(16).toUpperCase()}`);
  return fn;
}
