// Copyright 2026 by Moshix
/**
 * The sub CPU's routine tables. A leaf module with no imports, so every
 * module of this CPU can register into it and call through it no matter
 * which order the modules load in. @see docs/porting-guide.md section 3
 */

/**
 * Routine name (the label in reference/galaga-sub.asm) -> function.
 * @type {Record<string, Function>}
 */
export const SUB = {};

/**
 * Rev. B address -> function, for everything reached indirectly: task
 * tables, `jp (hl)` jump tables, pointers held in RAM or ROM data.
 * @type {Record<number, Function>}
 */
export const SUB_AT = {};

/**
 * Look up a routine by address, failing loudly when the port lacks it.
 * @param {number} addr
 * @returns {Function}
 */
export function subAt(addr) {
  const fn = SUB_AT[addr];
  if (fn === undefined) throw new Error(`sub CPU: no routine registered at $${addr.toString(16).toUpperCase()}`);
  return fn;
}
