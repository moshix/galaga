// Copyright 2026 by Moshix
/**
 * The Galaga sound board as one sample stream: WSG plus 54XX network,
 * driven by per-frame register snapshots, rendered at the device rate.
 * Pure JavaScript with no WebAudio dependency, so it runs inside the
 * AudioWorklet (src/audio/wsg-worklet.js), in the main-thread fallback, and
 * in node tests alike.
 *
 * TIMELINE. Everything runs on the WSG's 192 kHz stream clock, 3168 samples
 * per video frame. A frame message carries the two register images the
 * sound CPU wrote that frame, applied the way the hardware applies them:
 *
 *   samples    0 .. 1535   image A (written by the NMI at line 64)
 *   samples 1536 .. 3167   image B (written at line 192, held until the
 *                          next frame's line 64)
 *
 * and the 54XX output changes as (sample index, channel, value) triples.
 *
 * JITTER. Frames arrive from the game loop, whose timing wobbles against
 * the audio clock. The mixer keeps a short queue: it starts playing once
 * `targetFrames` are queued; if a frame is late it keeps playing the last
 * registers (the chip really would hold them, so tones continue with no
 * click); if the queue grows past `maxFrames` it drops the oldest frames'
 * time (register state is carried, phases stay continuous) until it is back
 * at the target.
 */

import {
  decodeWsg, wsgSample, wsgTick, WSG_RATE, WSG_GAIN, SAMPLES_PER_FRAME, SAMPLES_PER_LINE,
} from './wsg.js';
import { BoxResampler } from './resample.js';
import { N54Filter } from './n54filter.js';

/** Stream samples covered by the line-64 image. */
export const SEGMENT_A = (192 - 64) * SAMPLES_PER_LINE;

/**
 * One frame of sound-board input.
 * @typedef {object} SoundFrame
 * @property {Uint8Array} a   WSG registers after the line-64 NMI
 * @property {Uint8Array} b   WSG registers after the line-192 NMI
 * @property {Uint32Array|null} [n54]  54XX changes, (index << 8) | (channel << 4) | value
 */

/** Pack one 54XX change. @param {number} index @param {number} ch @param {number} v */
export const packN54 = (index, ch, v) => ((index << 8) | (ch << 4) | (v & 0x0f)) >>> 0;

export class GalagaMixer {
  /**
   * @param {number} outRate device sample rate
   * @param {{ targetFrames?: number, maxFrames?: number, gain?: number }} [options]
   */
  constructor(outRate, options = {}) {
    this.outRate = outRate;
    this.targetFrames = options.targetFrames ?? 2;
    this.maxFrames = options.maxFrames ?? 6;
    this.gain = options.gain ?? 1;
    this.resampler = new BoxResampler(WSG_RATE, outRate);
    this.counter = new Uint32Array(3);
    this.voices = decodeWsg(new Uint8Array(32));
    this.n54 = new N54Filter(WSG_RATE);
    /** True once any 54XX change arrived; until then the network is idle. */
    this.n54Live = false;
    /** @type {SoundFrame[]} */
    this.queue = [];
    /** @type {SoundFrame|null} the frame being played */
    this.frame = null;
    /** Stream position inside it, and next 54XX event to apply. */
    this.pos = 0;
    this.ev = 0;
    /** Latest register image, held through late frames. */
    this.lastRegs = new Uint8Array(32);
    this.priming = true;
    this.paused = false;
    this.stats = { frames: 0, held: 0, dropped: 0 };
  }

  /** @param {SoundFrame} frame */
  push(frame) {
    if (this.paused) return;
    this.queue.push(frame);
    if (this.queue.length > this.maxFrames) {
      // Running behind: skip audio time, keeping the state the skipped
      // frames would have left (last registers, 54XX levels).
      while (this.queue.length > this.targetFrames) {
        const f = /** @type {SoundFrame} */ (this.queue.shift());
        this.lastRegs = f.b;
        if (f.n54) for (const e of f.n54) this.applyN54(e);
        this.stats.dropped += 1;
      }
    }
    if (this.priming && this.queue.length >= this.targetFrames) this.priming = false;
  }

  /**
   * Silence and forget queued input (the game is paused); on resume the
   * queue refills to the target before sound starts again.
   * @param {boolean} on
   */
  setPaused(on) {
    this.paused = on;
    if (on) {
      this.queue.length = 0;
      this.frame = null;
      this.priming = true;
    }
  }

  /** @param {number} e packed change */
  applyN54(e) {
    this.n54.set((e >> 4) & 0x0f, e & 0x0f);
    this.n54Live = true;
  }

  /** Start the next frame, or hold the current registers if none is due. */
  nextFrame() {
    const f = this.priming ? undefined : this.queue.shift();
    if (f === undefined) {
      // Late (or still priming): hold. A frame's worth of the last image.
      if (!this.priming) this.stats.held += 1;
      this.frame = { a: this.lastRegs, b: this.lastRegs, n54: null };
      if (!this.priming && this.queue.length === 0) this.priming = true;
    } else {
      this.frame = f;
      this.stats.frames += 1;
    }
    this.pos = 0;
    this.ev = 0;
    decodeWsg(this.frame.a, this.voices);
    this.lastRegs = this.frame.b;
  }

  /**
   * Fill `count` device samples.
   * @param {Float32Array} out @param {number} offset @param {number} count
   */
  render(out, offset, count) {
    if (this.paused) { out.fill(0, offset, offset + count); return; }
    const rs = this.resampler;
    let n = 0;
    while (n < count) {
      if (rs.available > 0) { out[offset + n] = rs.take() * this.gain; n += 1; continue; }
      if (this.frame === null || this.pos >= SAMPLES_PER_FRAME) this.nextFrame();
      const f = /** @type {SoundFrame} */ (this.frame);
      if (this.pos === SEGMENT_A) decodeWsg(f.b, this.voices);
      // 54XX writes that land on this stream sample.
      const ev = f.n54;
      if (ev) {
        while (this.ev < ev.length && (ev[this.ev] >>> 8) <= this.pos) {
          this.applyN54(ev[this.ev]);
          this.ev += 1;
        }
      }
      let x = wsgSample(this.voices, this.counter) * WSG_GAIN;
      wsgTick(this.voices, this.counter);
      if (this.n54Live) x += this.n54.sample();
      rs.push(x);
      this.pos += 1;
    }
  }
}
