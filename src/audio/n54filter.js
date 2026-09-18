// Copyright 2026 by Moshix
/**
 * The analogue network behind the Namco 54XX explosion chip, after MAME's
 * `galaga_discrete` netlist (reference/mame/galaga_a.cpp), as IIR filters.
 *
 * WHAT THE BOARD DOES. The 54XX (an MB8844) outputs three 4-bit channels.
 * Each drives a resistor-ladder DAC (47k/22k/10k/4.7k to a 4 V logic high:
 * DISCRETE_DAC_R1), whose output feeds a one-op-amp multiple-feedback
 * band-pass filter (DISCRETE_OP_AMP_FILTER, BAND_PASS_1M) biased at
 * vRef = 5 * 2.2k / 5.5k = 2 V. An inverting op-amp summer (33k, 33k, 10k
 * into 3.3k feedback) mixes the three, an output coupling capacitor
 * (0.1 uF) removes DC, and MAME scales the volts by 40800 (/32768 to stream
 * units) and routes them at 0.90.
 *
 *   54XX_2 (R1 port)  -> CHANL1: R1 = Rdac+100k, R2 = 22k, Rf = 220k, C = 1 nF
 *   54XX_1 (O7-O4)    -> CHANL2: R1 = Rdac+47k,  R2 = 10k, Rf = 150k, C = 10 nF
 *   54XX_0 (O3-O0)    -> CHANL3: R1 = Rdac+150k, R2 = 22k, Rf = 470k, C = 10 nF
 *
 * THE APPROXIMATION (MAME solves the same circuits with its own discrete
 * step code; this module uses textbook equivalents):
 *  - DAC: ideal Thevenin source, V = 4 * (sum of G of the set bits) / (sum
 *    of all G), output resistance Rdac = 47k||22k||10k||4.7k (~2.6k), which
 *    MAME also folds into the filter's input resistor.
 *  - Band-pass: the standard MFB transfer function
 *        H(s) = -(s / (R1 C1)) /
 *               (s^2 + s (C1 + C2) / (Rf C1 C2) + (1/R1 + 1/R2) / (Rf C1 C2))
 *    (centres 2.5 kHz Q 1.7, 450 Hz Q 2.1, 167 Hz Q 2.5; peak gains 1.07,
 *    1.51, 1.54), discretised by the bilinear transform pre-warped at the
 *    centre frequency, at the 192 kHz stream rate.
 *  - Op-amp swing: each filter's output (vRef + y) is clipped to the rails
 *    MAME's filter assumes, 0 V .. 5 V - 1.5 V; the filter state itself
 *    stays linear.
 *  - Output capacitor: a one-pole high-pass with RC = 10k * 0.1 uF (MAME's
 *    mixer models cAmp against a nominal load; 10k is our assumption,
 *    fc ~ 159 Hz).
 * Levels are therefore within a few dB of MAME and the spectra have the same
 * shape; sample-exact agreement with MAME's discrete engine is not a goal.
 */

import { WSG_RATE } from './wsg.js';

/** DISCRETE_DAC_R1 ladder, bit 0 first. */
const DAC_R = [47e3, 22e3, 10e3, 4.7e3];
const DAC_G_TOTAL = DAC_R.reduce((s, r) => s + 1 / r, 0);
/** Output resistance of the ladder (GALAGA_54XX_DAC_R). */
export const N54_DAC_R = 1 / DAC_G_TOTAL;
/** Logic-high voltage of the 54XX outputs ("4V - unmeasured"). */
const V_HIGH = 4;
/** GALAGA_VREF. */
export const N54_VREF = 5.0 * (2.2e3 / (3.3e3 + 2.2e3));
/** Op-amp output limits, as volts around vRef. */
const Y_MIN = 0 - N54_VREF;
const Y_MAX = 5 - 1.5 - N54_VREF;

/**
 * galaga_chanl1..3_filt, indexed by 54XX output channel (0 = O3-O0).
 * @type {ReadonlyArray<{r1: number, r2: number, rf: number, c1: number, c2: number, mix: number}>}
 */
export const N54_CHANNELS = Object.freeze([
  // 54XX_0 -> CHANL3 (mixer input 10k)
  { r1: N54_DAC_R + 150e3, r2: 22e3, rf: 470e3, c1: 0.01e-6, c2: 0.01e-6, mix: 10e3 },
  // 54XX_1 -> CHANL2 (mixer input 33k)
  { r1: N54_DAC_R + 47e3, r2: 10e3, rf: 150e3, c1: 0.01e-6, c2: 0.01e-6, mix: 33e3 },
  // 54XX_2 -> CHANL1 (mixer input 33k)
  { r1: N54_DAC_R + 100e3, r2: 22e3, rf: 220e3, c1: 0.001e-6, c2: 0.001e-6, mix: 33e3 },
]);

/** galaga_final_mixer: feedback resistor, output cap, gain. */
const MIX_RF = 3.3e3;
const C_AMP = 0.1e-6;
const R_LOAD = 10e3;
const MIX_GAIN = 40800;
/** Discrete stream scaling and the route gain in galaga.cpp. */
const OUT_SCALE = 1 / 32768;
const ROUTE_GAIN = 0.90;

/**
 * Voltage of the 4-bit ladder DAC for a channel value.
 * @param {number} value 0-15
 * @returns {number} volts
 */
export function n54Dac(value) {
  let g = 0;
  for (let b = 0; b < 4; b += 1) if ((value >> b) & 1) g += 1 / DAC_R[b];
  return (V_HIGH * g) / DAC_G_TOTAL;
}

/**
 * Bilinear-transform coefficients of the MFB band-pass.
 * @param {{r1: number, r2: number, rf: number, c1: number, c2: number}} p
 * @param {number} rate sample rate
 * @returns {{ b0: number, b2: number, a1: number, a2: number, f0: number, q: number, gain: number }}
 *   y[n] = b0 x[n] + b2 x[n-2] - a1 y[n-1] - a2 y[n-2]  (b1 = 0)
 */
export function mfbBandPass(p, rate) {
  const bs = 1 / (p.r1 * p.c1);                          // numerator s coefficient
  const a1s = (p.c1 + p.c2) / (p.rf * p.c1 * p.c2);      // s^1 term
  const a0s = (1 / p.r1 + 1 / p.r2) / (p.rf * p.c1 * p.c2); // s^0 term = w0^2
  const w0 = Math.sqrt(a0s);
  // Pre-warp so the digital centre frequency equals the analogue one.
  const k = w0 / Math.tan(w0 / (2 * rate));
  const d = k * k + a1s * k + a0s;
  return {
    // Inverting: H(s) has a minus sign.
    b0: (-bs * k) / d,
    b2: (bs * k) / d,
    a1: (2 * a0s - 2 * k * k) / d,
    a2: (k * k - a1s * k + a0s) / d,
    f0: w0 / (2 * Math.PI),
    q: w0 / a1s,
    gain: bs / a1s,
  };
}

/**
 * Three 54XX channels in, one speaker-level sample out, per stream sample.
 */
export class N54Filter {
  /** @param {number} [rate] samples per second (the 192 kHz stream) */
  constructor(rate = WSG_RATE) {
    this.rate = rate;
    this.coef = N54_CHANNELS.map((p) => mfbBandPass(p, rate));
    /** Mixer weight of each filter output: -Rf / Rin (inverting summer). */
    this.weight = N54_CHANNELS.map((p) => -MIX_RF / p.mix);
    /** One-pole high-pass for the output capacitor. */
    this.hpA = Math.exp(-1 / (rate * R_LOAD * C_AMP));
    this.reset();
  }

  /** Back to rest: all channels 0, filters settled. */
  reset() {
    /** Current DAC voltage of each channel. */
    this.v = [n54Dac(0), n54Dac(0), n54Dac(0)];
    /** Filter state: x[n-1], x[n-2], y[n-1], y[n-2] per channel. */
    this.s = [0, 1, 2].map(() => new Float64Array(4));
    // Start with the delay line full of the resting input, so no step.
    for (let ch = 0; ch < 3; ch += 1) { this.s[ch][0] = this.v[ch]; this.s[ch][1] = this.v[ch]; }
    this.hpX = 0;
    this.hpY = 0;
  }

  /**
   * A 54XX output write.
   * @param {number} channel 0 = O3-O0, 1 = O7-O4, 2 = R1
   * @param {number} value 0-15
   */
  set(channel, value) {
    this.v[channel] = n54Dac(value & 0x0f);
  }

  /** @returns {number} the next output sample, in speaker units */
  sample() {
    let mix = 0;
    for (let ch = 0; ch < 3; ch += 1) {
      const c = this.coef[ch];
      const s = this.s[ch];
      const x = this.v[ch];
      const y = c.b0 * x + c.b2 * s[1] - c.a1 * s[2] - c.a2 * s[3];
      s[1] = s[0]; s[0] = x;
      s[3] = s[2]; s[2] = y;
      // Op-amp output swing around vRef.
      const yc = y < Y_MIN ? Y_MIN : y > Y_MAX ? Y_MAX : y;
      mix += this.weight[ch] * yc;
    }
    // Output coupling cap: y[n] = a (y[n-1] + x[n] - x[n-1]).
    const hp = this.hpA * (this.hpY + mix - this.hpX);
    this.hpX = mix;
    this.hpY = hp;
    return hp * MIX_GAIN * OUT_SCALE * ROUTE_GAIN;
  }
}
