// Copyright 2026 by Moshix
/**
 * AudioWorklet processor for the Galaga sound board. Loaded by
 * src/audio/sound.js with audioWorklet.addModule(); runs GalagaMixer on the
 * audio thread and takes its input as messages from the page:
 *
 *   { type: 'frame', a, b, n54 }   one video frame (see mixer.js SoundFrame)
 *   { type: 'pause', on }          stop / resume (resume re-primes the queue)
 *
 * Output is mono; any further output channels get the same signal.
 */

import { GalagaMixer } from './mixer.js';

/* global AudioWorkletProcessor, registerProcessor, sampleRate */

class GalagaSoundProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mixer = new GalagaMixer(sampleRate);
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'frame') this.mixer.push(msg);
      else if (msg.type === 'pause') this.mixer.setPaused(Boolean(msg.on));
    };
  }

  /**
   * @param {Float32Array[][]} _inputs
   * @param {Float32Array[][]} outputs
   * @returns {boolean}
   */
  process(_inputs, outputs) {
    const out = outputs[0];
    if (out === undefined || out.length === 0) return true;
    const first = out[0];
    this.mixer.render(first, 0, first.length);
    for (let c = 1; c < out.length; c += 1) out[c].set(first);
    return true;
  }
}

registerProcessor('galaga-sound', GalagaSoundProcessor);
