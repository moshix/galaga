// Copyright 2026 by Moshix
/**
 * MAME's resistor-network DAC model, ported so the palette can be computed
 * from the colour PROM with exactly the numbers MAME produces.
 *
 * The board turns each PROM bit into a voltage through a resistor; the
 * resistors of one colour gun are tied together at the monitor input (which,
 * optionally, also has a pull-down to ground and/or a pull-up to Vcc). Each
 * bit's contribution is the voltage divider formed by its own resistor to Vcc
 * against every other resistor of the net (plus the pull-down) to ground.
 *
 * Ported from reference/mame/resnet.cpp compute_resistor_weights() (lines
 * 55-197) and resnet.h combine_weights() (lines 167-184). Used by
 * tools/gen-graphics.mjs at build time and by the unit tests; the running
 * game only sees the resulting RGB values in palette.js.
 */

/**
 * One resistor net: the resistances driven by bits 0..n-1, plus the optional
 * pull-down / pull-up to the output node (0 = not fitted).
 * @typedef {{resistances: readonly number[], pulldown?: number, pullup?: number}} ResNet
 */

/**
 * Port of compute_resistor_weights(). Returns one weight array per net.
 *
 * With `scaler < 0` (MAME's "autoscale"), all nets share ONE scale factor,
 * chosen so the net with the greatest full-on output reaches `maxval`. That is
 * why Galaga's blue gun (two resistors) tops out at 0xDE and not 0xFF: it is
 * scaled together with the three-resistor red and green guns.
 *
 * @param {number} minval
 * @param {number} maxval
 * @param {number} scaler negative for autoscale
 * @param {readonly ResNet[]} nets 1 to 3 nets
 * @returns {number[][]} weights[net][bit]
 */
export function computeResistorWeights(minval, maxval, scaler, nets) {
  /** @type {number[][]} unscaled weights */
  const w = nets.map((net) => {
    const r = net.resistances;
    const pd = net.pulldown ?? 0;
    const pu = net.pullup ?? 0;
    return r.map((_, n) => {
      // Conductances to ground (R0) and to Vcc (R1). A missing pull resistor
      // is modelled as 1e12 ohm, i.e. a conductance of 1e-12, like MAME.
      let r0 = pd === 0 ? 1.0 / 1e12 : 1.0 / pd;
      let r1 = pu === 0 ? 1.0 / 1e12 : 1.0 / pu;
      for (let j = 0; j < r.length; j += 1) {
        if (r[j] === 0) continue;
        // Only resistor n is driven high; all the others sink to ground.
        if (j === n) r1 += 1.0 / r[j];
        else r0 += 1.0 / r[j];
      }
      r0 = 1.0 / r0;
      r1 = 1.0 / r1;
      const vout = (maxval - minval) * r0 / (r1 + r0) + minval;
      return Math.min(Math.max(vout, minval), maxval);
    });
  });

  // Autoscale picks the net with the largest total (first one on ties, as the
  // strict '<' in MAME's loop does).
  let max = 0;
  let best = 0;
  w.forEach((net, i) => {
    const sum = net.reduce((a, b) => a + b, 0);
    if (max < sum) { max = sum; best = i; }
  });
  const bestSum = w[best].reduce((a, b) => a + b, 0);
  const scale = scaler < 0 ? maxval / bestSum : scaler;
  return w.map((net) => net.map((v) => v * scale));
}

/**
 * Port of combine_weights(): sum the weights of the set bits and round to the
 * nearest integer (MAME adds 0.5 and truncates; all values are positive).
 * @param {readonly number[]} weights
 * @param {...number} bits 0 or 1, bit 0 first
 * @returns {number}
 */
export function combineWeights(weights, ...bits) {
  let sum = 0;
  for (let i = 0; i < bits.length; i += 1) sum += weights[i] * bits[i];
  return Math.trunc(sum + 0.5);
}

/** Resistances as listed in galaga_palette(): bit 0 -> 1k, bit 1 -> 470, bit 2 -> 220. */
const RESISTANCES = [1000, 470, 220];

/**
 * The 32 core colours from the 32-byte palette PROM (prom-5.5n), exactly as
 * galaga_state::galaga_palette() computes them (galaga_v.cpp lines 43-82):
 * bits 0-2 red (1k/470/220), 3-5 green (1k/470/220), 6-7 blue (470/220).
 * @param {Uint8Array} prom 32 bytes
 * @returns {Array<[number, number, number]>}
 */
export function galagaCorePalette(prom) {
  const [rw, gw, bw] = computeResistorWeights(0, 255, -1.0, [
    { resistances: RESISTANCES },
    { resistances: RESISTANCES },
    { resistances: RESISTANCES.slice(1) },
  ]);
  /** @type {Array<[number, number, number]>} */
  const out = [];
  for (let i = 0; i < 32; i += 1) {
    const v = prom[i];
    const bit = (/** @type {number} */ n) => (v >> n) & 1;
    out.push([
      combineWeights(rw, bit(0), bit(1), bit(2)),
      combineWeights(gw, bit(3), bit(4), bit(5)),
      combineWeights(bw, bit(6), bit(7)),
    ]);
  }
  return out;
}

/**
 * The 64 star colours (galaga_v.cpp lines 84-97). The 05xx drives two bits
 * per gun into the same 470/220 resistors; on red and green the third (1k)
 * resistor is left unconnected by the 05xx and so acts as a pull-down, which
 * MAME models by passing 1000 as the pull-down.
 * Star colour bits: 0-1 red, 2-3 green, 4-5 blue.
 * @returns {Array<[number, number, number]>}
 */
export function galagaStarPalette() {
  const [rs, gs, bs] = computeResistorWeights(0, 255, -1.0, [
    { resistances: RESISTANCES.slice(1), pulldown: RESISTANCES[0] },
    { resistances: RESISTANCES.slice(1), pulldown: RESISTANCES[0] },
    { resistances: RESISTANCES.slice(1) },
  ]);
  /** @type {Array<[number, number, number]>} */
  const out = [];
  for (let i = 0; i < 64; i += 1) {
    const bit = (/** @type {number} */ n) => (i >> n) & 1;
    out.push([
      combineWeights(rs, bit(0), bit(1)),
      combineWeights(gs, bit(2), bit(3)),
      combineWeights(bs, bit(4), bit(5)),
    ]);
  }
  return out;
}
