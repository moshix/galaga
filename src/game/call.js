// Copyright 2026 by Moshix
/**
 * Call a routine from generator (foreground) code without knowing whether
 * it is itself a generator. Routines that can wait are generators and must
 * be delegated to with `yield*`; the rest are plain functions. Code written
 * in parallel by different people cannot always know which one a routine
 * in another module is, so foreground code calls across modules as
 *
 *     const out = yield* call(MAIN.c_1234, m, { hl });
 *
 * @see docs/porting-guide.md section 6
 * @param {Function} fn
 * @param {...unknown} args
 * @returns {Generator<symbol|undefined, unknown, void>}
 */
export function* call(fn, ...args) {
  const r = fn(...args);
  if (r !== null && typeof r === 'object' && typeof r.next === 'function'
      && typeof r[Symbol.iterator] === 'function') {
    return yield* r;
  }
  return r;
}
