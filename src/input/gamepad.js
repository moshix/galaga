// Copyright 2026 by Moshix
/**
 * Reading a USB joystick, once per animation frame.
 *
 * The Gamepad API has no events for the thing you actually want. `gamepad-
 * connected` fires once and `gamepaddisconnected` once, and in between there is
 * nothing at all -- no buttondown, no axischange. You call
 * `navigator.getGamepads()` and it hands back a fresh snapshot of every device.
 * So this is polled, and the poll lives in the animation callback rather than
 * in `stepFrame`: a pad is a *display*-rate device, and reading it inside the
 * simulation would stop reading it whenever the simulation stops -- which is
 * exactly what pause does, and would leave the button that paused the game
 * unable to unpause it. One sample serves however many game frames that tick
 * turns out to owe. @see src/main.js
 *
 * Three consequences of polling, all handled elsewhere but worth stating here:
 *
 *  - The poll asserts the stick's *whole* state every frame, including all the
 *    controls that are not being used. It therefore cannot write `setInput`
 *    directly without stamping on the keyboard, and goes through the mux.
 *    @see src/input/mux.js
 *  - What comes back are *actions*, not switch names. Most of them close a
 *    switch on the board, but `pause` has no board behind it, so the caller
 *    translates before going near the mux. @see MACHINE_INPUT in bindings.js
 *  - Nothing is reported until the player touches the device. Chrome will not
 *    even admit a pad exists until a button is pressed on it, which is a
 *    privacy measure against fingerprinting, so "no gamepad detected" is the
 *    honest state right up until the first press.
 *
 * WHAT THIS CANNOT DO: unlock the sound. Browsers require a "user activation"
 * gesture before a page may make noise, and gamepad input does not count -- only
 * keys, clicks and touches do. Calling `sound.start()` from here would produce a
 * rejected promise sixty times a second and no audio, so it is not called. The
 * keyboard covers it: coin and start are on 5 and 1 by design, and opening the
 * remapping screen is a keypress too.
 *
 * `navigator` is injected rather than reached for, so the whole class can be
 * driven from a test with no browser anywhere in sight.
 */

import {
  DEFAULT_BINDINGS, activeActions, calibrateRest, neutralRest, normalizeBindings,
  profileKey, snapshotOf, safeStorage, loadBindings, saveBindings,
} from './bindings.js';
import { BindingCapture } from './capture.js';

/** @typedef {import('./bindings.js').Bindings} Bindings */
/** @typedef {import('./bindings.js').Binding} Binding */
/** @typedef {import('./bindings.js').PadSnapshot} PadSnapshot */

export class GamepadInput {
  /**
   * @param {object} [options]
   * @param {{getGamepads?: () => ArrayLike<any>}} [options.nav] defaults to `navigator`
   * @param {Storage | null} [options.storage] defaults to `localStorage` if usable
   */
  constructor(options = {}) {
    this.nav = options.nav ?? globalThis.navigator;
    /** Null when preferences cannot be persisted; not an error, just a fact. */
    this.storage = options.storage === undefined ? safeStorage() : options.storage;

    /** Profile key of the device currently being read. @type {string|null} */
    this.profile = null;
    /** @type {Bindings} */
    this.bindings = normalizeBindings(undefined);
    /** Where the stick sits when nobody is touching it. @type {PadSnapshot} */
    this.rest = neutralRest();
    /** Last frame's actions, so the deadzone can have hysteresis. @type {Set<string>} */
    this.previous = new Set();
    /** Slot of the pad being read; the lowest connected one unless one moves. */
    this.slot = -1;
    /** Suppressed while the page is not focused. */
    this.enabled = true;

    this.capture = new BindingCapture();
    /** @type {null | ((action: string, binding: Binding) => void)} */
    this.onCaptured = null;
    /** @type {null | (() => void)} */
    this.onChange = null;
  }

  /** True once a device has actually reported itself. @returns {boolean} */
  get connected() {
    return this.profile !== null;
  }

  /** Can preferences be remembered between visits? @returns {boolean} */
  get persistent() {
    return this.storage !== null && this.storage !== undefined;
  }

  /**
   * Every pad the browser is willing to tell us about, live.
   * @returns {any[]}
   */
  pads() {
    if (typeof this.nav?.getGamepads !== 'function') return [];
    // Allocates an array per call. That is once a frame and immeasurable next
    // to rendering; do not "optimise" it into a cached array, because the
    // objects are snapshots and a stale one never changes value.
    return Array.from(this.nav.getGamepads() ?? []).filter((p) => p !== null && p !== undefined);
  }

  /**
   * Choose which pad to read. The lowest-numbered connected one, except that a
   * pad which has just been moved takes over -- so plugging in a second
   * controller and using it does the obvious thing.
   * @param {any[]} pads
   * @returns {any}
   */
  pick(pads) {
    if (pads.length === 0) return undefined;
    const current = pads.find((p) => p.index === this.slot);
    if (current !== undefined) return current;
    return pads[0];
  }

  /**
   * Point at a device, loading its saved bindings and taking a rest reading.
   * @param {any} pad
   * @returns {void}
   */
  adopt(pad) {
    const key = profileKey(pad);
    this.slot = pad.index ?? 0;
    if (key !== this.profile) {
      this.profile = key;
      this.bindings = loadBindings(this.storage, key);
    }
    this.rest = calibrateRest(snapshotOf(pad));
    this.onChange?.();
  }

  /**
   * Re-read where the stick sits at rest.
   *
   * Offered as a button on the remapping screen and done automatically when the
   * page regains focus, because a pad can be knocked or unplugged while the tab
   * is in the background and would otherwise come back stuck hard over.
   * @returns {void}
   */
  recalibrate() {
    const pad = this.pick(this.pads());
    if (pad === undefined) return;
    this.rest = calibrateRest(snapshotOf(pad));
  }

  /**
   * One frame. Returns the actions the stick is asking for.
   *
   * Returns nothing at all while a binding capture is in flight, so the press
   * that binds FIRE does not also shoot.
   *
   * @returns {Set<string>} a subset of {@link import('./bindings.js').ACTIONS}
   */
  poll() {
    if (!this.enabled) { this.previous = new Set(); return this.previous; }

    const pad = this.pick(this.pads());
    if (pad === undefined) {
      // Covers a disconnect whose event we never saw: no pad, no input, and the
      // mux opens whatever switches the keyboard is not holding.
      if (this.profile !== null) { this.profile = null; this.slot = -1; this.onChange?.(); }
      this.previous = new Set();
      return this.previous;
    }

    if (profileKey(pad) !== this.profile || pad.index !== this.slot) this.adopt(pad);

    const now = snapshotOf(pad);

    if (this.capture.active) {
      const result = this.capture.step(now);
      if (result.status === 'captured') {
        this.onCaptured?.(result.action, result.binding);
      }
      this.previous = new Set();
      return this.previous;
    }

    this.previous = activeActions(this.bindings, now, this.rest, this.previous);
    return this.previous;
  }

  /**
   * Arm a capture for one action. Rest is re-sampled here, which is what makes
   * a button still held from the previous row ineligible.
   * @param {typeof import('./bindings.js').ACTIONS[number]} action
   * @returns {boolean} false when there is no device to bind from
   */
  beginCapture(action) {
    const pad = this.pick(this.pads());
    if (pad === undefined) return false;
    this.capture.begin(action, snapshotOf(pad));
    return true;
  }

  /** @returns {void} */
  cancelCapture() {
    this.capture.cancel();
  }

  /**
   * Replace the bindings and remember them for this device.
   * @param {Bindings} bindings
   * @returns {boolean} false when they could not be persisted
   */
  setBindings(bindings) {
    this.bindings = normalizeBindings(bindings);
    this.onChange?.();
    if (this.profile === null) return false;
    return saveBindings(this.storage, this.profile, this.bindings);
  }

  /** Back to the shipped defaults for this device. @returns {boolean} */
  resetBindings() {
    return this.setBindings(DEFAULT_BINDINGS);
  }

  /** Wired to `gamepaddisconnected`. @returns {void} */
  handleDisconnect() {
    this.profile = null;
    this.slot = -1;
    this.previous = new Set();
    this.capture.cancel();
    this.onChange?.();
  }
}

export default GamepadInput;
