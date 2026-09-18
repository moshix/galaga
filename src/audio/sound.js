// Copyright 2026 by Moshix
/**
 * WebAudio output of the Galaga sound board.
 *
 * Unlike Galaxian, Galaga's sound is programmed: the ported sound CPU
 * (src/game/sound/gg1_7.js) writes the Namco WSG registers exactly as the
 * ROM does, twice a frame, and the 54XX explosion chip gets command bytes
 * from the main CPU. This module only has to turn those into samples:
 *
 *   - It captures the WSG register image after each of the frame's two
 *     sound NMIs (see capture()), and sends both images per frame to an
 *     AudioWorklet (src/audio/wsg-worklet.js) running GalagaMixer
 *     (src/audio/mixer.js), which applies them at their true times (lines
 *     64 and 192) on the WSG's 192 kHz clock and resamples to the device.
 *   - The 54XX explosion chip -- the real 54xx.bin on the MB88 emulation
 *     (src/machine/namco54.js, ROM from src/audio/mcu54rom.js) -- runs
 *     frame by frame on the main thread, fed the bytes the main CPU sends
 *     it (write54xx) with the 06XX's timing (src/audio/n54voice.js). Its
 *     output changes travel with the frame to the same mixer, which filters
 *     them like the board's discrete network (src/audio/n54filter.js).
 *
 * HOST CONTRACT, once per emulated frame, after Scheduler.stepFrame():
 *
 *     engine.update(machine);
 *
 * plus start() from a user gesture, setPaused() when the simulation
 * freezes, toggle() for mute, and the 06XX wiring
 * `new IoBus(m, { n51, n54: { write: (b) => engine.write54xx(b) } })`.
 *
 * Without AudioWorklet support the same mixer runs on the main thread and
 * each frame's audio is scheduled as an AudioBufferSourceNode (higher
 * latency, can gap if a frame is very late).
 */

import { GalagaMixer } from './mixer.js';
import { N54Voice } from './n54voice.js';
import { FRAME_RATE } from '../machine/machine.js';
import { Namco54 } from '../machine/namco54.js';
import { MCU54_ROM } from './mcu54rom.js';

/** Overall output level. The mixer already applies MAME's route gains. */
const MASTER_LEVEL = 1.0;
/** Mute/pause ramp time constant, seconds (long enough not to click). */
const RAMP = 0.01;
/** WSG register the sound CPU writes last in every update ($0380). */
const LAST_WSG_REG = 0x0f;
/** Snapshots kept if update() stops being called. */
const MAX_SNAPS = 8;

/** @typedef {import('../machine/machine.js').Machine} Machine */
/** @typedef {import('./n54voice.js').N54Chip} N54Chip */

export class SoundEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {GainNode|null} */
    this.master = null;
    /** @type {AudioWorkletNode|null} */
    this.node = null;
    /** Main-thread mixer when there is no AudioWorklet. @type {GalagaMixer|null} */
    this.fallback = null;
    this.nextTime = 0;
    this.carry = 0;
    /** @type {Promise<void>|null} */
    this.starting = null;
    this.ready = false;
    /** Player's sound on/off. */
    this.enabled = true;
    /** Simulation frozen. */
    this.paused = false;
    /** @type {Uint8Array[]} WSG images captured since the last update */
    this.snaps = [];
    /** @type {Machine|null} the machine whose WSG writes are hooked */
    this.machine = null;
    /** The 54XX, reset-held until the game releases latch Q3. @type {N54Voice|null} */
    this.n54 = new N54Voice(new Namco54({ rom: MCU54_ROM }));
  }

  /**
   * Build the audio graph. Call from a user gesture (browsers refuse to
   * start audio otherwise); later calls just resume a suspended context.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.starting === null) this.starting = this.init();
    await this.starting;
    if (this.ctx !== null && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** @returns {Promise<void>} */
  async init() {
    const Ctor = globalThis.AudioContext ?? /** @type {typeof AudioContext|undefined} */ (
      /** @type {Record<string, unknown>} */ (globalThis).webkitAudioContext);
    if (Ctor === undefined) return;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;
    // Resume inside the gesture, before the first await, for Safari.
    void ctx.resume();
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    if (ctx.audioWorklet !== undefined && globalThis.AudioWorkletNode !== undefined) {
      try {
        await ctx.audioWorklet.addModule(new URL('./wsg-worklet.js', import.meta.url));
        this.node = new AudioWorkletNode(ctx, 'galaga-sound', {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        });
        this.node.connect(this.master);
      } catch {
        this.node = null;
      }
    }
    if (this.node === null) {
      this.fallback = new GalagaMixer(ctx.sampleRate);
      this.nextTime = 0;
    }
    this.ready = true;
    this.sendPause();
    this.applyGain();
  }

  /**
   * Freeze or resume with the simulation. Paused, the mixer drops its
   * queue and outputs silence; resuming re-primes it.
   * @param {boolean} on
   */
  setPaused(on) {
    this.paused = on;
    this.sendPause();
    this.applyGain();
  }

  /** Mute / unmute. @returns {boolean} true if sound is now on */
  toggle() {
    this.enabled = !this.enabled;
    this.applyGain();
    return this.enabled;
  }

  /** @returns {boolean} true while the player has sound switched off */
  get muted() { return !this.enabled; }

  /**
   * Replace the 54XX (the default is src/machine/namco54.js running
   * 54xx.bin). Pass null to run without explosion noise.
   * @param {N54Chip|null} chip
   */
  attach54xx(chip) {
    this.n54 = chip === null ? null : new N54Voice(chip);
  }

  /**
   * A byte the main CPU sends the 54XX through the 06XX (wire IoBus's n54
   * to this): the 12-byte parameter block at boot ($35B3) and the 4-byte
   * fighter-hit trigger ($0092). Ignored when no 54XX is attached.
   * @param {number} byte
   */
  write54xx(byte) {
    if (this.n54 !== null) this.n54.write(byte);
  }

  /**
   * Once per emulated frame, after the frame ran: hand the frame's WSG
   * images and 54XX activity to the mixer.
   * @param {Machine} m
   */
  update(m) {
    this.capture(m);
    const snaps = this.snaps;
    this.snaps = [];
    // The two NMIs' images; if the NMI was masked (or skipped) the chip
    // simply kept its registers.
    const b = snaps.length > 0 ? snaps[snaps.length - 1] : m.wsg.slice();
    const a = snaps.length > 1 ? snaps[snaps.length - 2] : b.slice();
    // The 54XX runs whether or not audio is up, so its state follows the game.
    let n54 = null;
    if (this.n54 !== null) {
      this.n54.setRunning(m.misc[3]);
      const ev = this.n54.runFrame();
      if (ev.length > 0) n54 = ev;
    }
    if (!this.ready || this.paused) return;
    if (this.node !== null) {
      /** @type {ArrayBuffer[]} */
      const transfer = [a.buffer, b.buffer];
      if (n54 !== null) transfer.push(n54.buffer);
      this.node.port.postMessage({ type: 'frame', a, b, n54 }, transfer);
    } else if (this.fallback !== null) {
      this.fallback.push({ a, b, n54 });
      this.playFallback();
    }
  }

  /**
   * Hook the machine's WSG writes. The sound CPU's update always ends by
   * writing register $0F (j_0357_set_SFRs, $0380), so that write marks a
   * finished image: one per sound NMI, two per frame. The hook chains to
   * any hook already installed.
   * @param {Machine} m
   */
  capture(m) {
    if (this.machine === m) return;
    this.machine = m;
    const prev = m.hooks.onWsgWrite;
    m.hooks.onWsgWrite = (reg, value) => {
      if (prev !== undefined) prev(reg, value);
      if (reg !== LAST_WSG_REG) return;
      if (this.snaps.length >= MAX_SNAPS) this.snaps.shift();
      this.snaps.push(m.wsg.slice());
    };
  }

  /** Render one frame on the main thread and queue it (no AudioWorklet). */
  playFallback() {
    const ctx = /** @type {AudioContext} */ (this.ctx);
    const mixer = /** @type {GalagaMixer} */ (this.fallback);
    const exact = ctx.sampleRate / FRAME_RATE + this.carry;
    const count = Math.floor(exact);
    this.carry = exact - count;
    const buf = ctx.createBuffer(1, count, ctx.sampleRate);
    mixer.render(buf.getChannelData(0), 0, count);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(/** @type {GainNode} */ (this.master));
    // Keep ~50 ms ahead; if we fell behind, restart the schedule there.
    const now = ctx.currentTime;
    if (this.nextTime < now + 0.01 || this.nextTime > now + 0.2) this.nextTime = now + 0.05;
    src.start(this.nextTime);
    this.nextTime += count / ctx.sampleRate;
  }

  /** Tell the mixer about pause. */
  sendPause() {
    if (this.node !== null) this.node.port.postMessage({ type: 'pause', on: this.paused });
    if (this.fallback !== null) this.fallback.setPaused(this.paused);
  }

  /** Master gain from the mute and pause states, ramped. */
  applyGain() {
    if (this.master === null || this.ctx === null) return;
    const target = this.enabled && !this.paused ? MASTER_LEVEL : 0;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, RAMP);
  }
}
