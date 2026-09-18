// Copyright 2026 by Moshix
/**
 * Box-filter (area-averaging) resampler from the 192 kHz sound stream down
 * to the audio device rate.
 *
 * Each output sample is the average of the input over its own time slice
 * [k*step, (k+1)*step) (step = inRate / outRate input samples), with input
 * samples that straddle a slice boundary split between the two by weight.
 * Treating the input as piecewise constant, as the WSG and the 54XX DACs
 * really are, this is exact integration: at 48 kHz every output is the mean
 * of exactly 4 stream samples. It is a first-order anti-alias filter --
 * much less refined than MAME's resampler, but free of phase error and of
 * any state beyond the partial sum.
 */

/** Room for pending outputs; only an output rate above the input needs >1. */
const RING = 64;

export class BoxResampler {
  /**
   * @param {number} inRate  input samples per second
   * @param {number} outRate output samples per second, > inRate / RING
   */
  constructor(inRate, outRate) {
    if (!(outRate > inRate / (RING - 2))) throw new RangeError(`output rate ${outRate} too low`);
    this.inRate = inRate;
    this.outRate = outRate;
    /** Input samples per output sample. */
    this.step = inRate / outRate;
    /** Weighted input sum and input time accumulated for the current output. */
    this.acc = 0;
    this.t = 0;
    /** Finished outputs not yet taken. */
    this.ring = new Float64Array(RING);
    this.head = 0;
    this.available = 0;
  }

  /**
   * Feed one input sample (it lasts one input period).
   * @param {number} x
   */
  push(x) {
    let w = 1;
    while (w > 0) {
      const space = this.step - this.t;
      if (w < space) {
        this.acc += x * w;
        this.t += w;
        return;
      }
      // This sample completes the current output slice.
      this.acc += x * space;
      w -= space;
      this.ring[(this.head + this.available) % RING] = this.acc / this.step;
      this.available += 1;
      this.acc = 0;
      this.t = 0;
    }
  }

  /** @returns {number} the oldest finished output (check `available`) */
  take() {
    const v = this.ring[this.head];
    this.head = (this.head + 1) % RING;
    this.available -= 1;
    return v;
  }
}
