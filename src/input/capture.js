// Copyright 2026 by Moshix
/**
 * Working out which control the player just moved.
 *
 * The remapping screen says "press the control for LEFT" and then has to answer
 * a surprisingly awkward question: out of maybe six axes and sixteen buttons,
 * all reporting numbers continuously, which one did the player mean?
 *
 * Reading the largest value does not work. A no-name stick's unused second axis
 * may sit at 0.4 forever, and an analogue trigger nobody is touching reports
 * -1.0 -- the largest magnitude on the device. Either would win every time and
 * the player could never bind anything else.
 *
 * So capture works the same way play does: rest is sampled the instant the
 * prompt appears, and controls are ranked by how far they have moved *since
 * then*. Two things fall out of that for free:
 *
 *  - An axis that idles off-centre contributes zero, however extreme it reads.
 *  - A button still held down from binding the previous row is part of rest, so
 *    it cannot be captured again. There is no "wait for release" state to get
 *    wrong, and no timer.
 *
 * Two guards on top. The capture threshold is higher than the play deadzone, so
 * a drifting axis cannot be bound by accident while a button is being pressed;
 * and a candidate has to win several frames running, because cheap analogue
 * hardware spikes for a frame at a time.
 */

import { bindingsEqual } from './bindings.js';

/**
 * Deviation from rest needed to be a candidate.
 *
 * Deliberately above `DEADZONE_ON` (0.5): binding is a deliberate act, and the
 * cost of being strict is that somebody nudges the stick harder, while the cost
 * of being loose is a mis-bound control they have to notice and redo.
 */
export const CAPTURE_THRESHOLD = 0.6;

/** Consecutive frames a candidate must win. At 60 Hz this is imperceptible. */
export const HOLD_FRAMES = 3;

/**
 * @typedef {import('./bindings.js').Binding} Binding
 * @typedef {import('./bindings.js').PadSnapshot} PadSnapshot
 */

/**
 * The control that has moved furthest from rest, if any has moved enough.
 *
 * Axis scores are clamped to 1 so a trigger swinging the full -1..+1 (a travel
 * of 2.0) cannot automatically outrank a button press, and buttons win ties
 * because a press is nearly always what somebody meant when both register.
 *
 * @param {PadSnapshot} rest
 * @param {PadSnapshot} now
 * @param {{threshold?: number}} [options]
 * @returns {Binding | null}
 */
export function detectBinding(rest, now, options = {}) {
  const threshold = options.threshold ?? CAPTURE_THRESHOLD;
  /** @type {Binding | null} */
  let best = null;
  let bestScore = 0;

  for (let i = 0; i < now.buttons.length; i += 1) {
    const deviation = now.buttons[i] - (rest.buttons[i] ?? 0);
    if (deviation < threshold) continue;
    const score = Math.min(1, deviation);
    if (score > bestScore) {
      best = { type: 'button', index: i };
      bestScore = score;
    }
  }

  for (let i = 0; i < now.axes.length; i += 1) {
    const deviation = now.axes[i] - (rest.axes[i] ?? 0);
    const travel = Math.abs(deviation);
    if (travel < threshold) continue;
    const score = Math.min(1, travel);
    // Strictly greater, so an equal-scoring button already found keeps the slot.
    if (score > bestScore) {
      best = { type: 'axis', index: i, dir: deviation < 0 ? -1 : 1 };
      bestScore = score;
    }
  }

  return best;
}

/**
 * One "press the control you want" interaction.
 *
 * Fed a snapshot per frame while a capture is in flight; reports `captured`
 * once a single control has won {@link HOLD_FRAMES} frames in a row.
 */
export class BindingCapture {
  constructor() {
    /** @type {'left'|'right'|'fire'|null} */
    this.action = null;
    /** @type {PadSnapshot} */
    this.rest = { axes: [], buttons: [] };
    /** @type {Binding | null} */
    this.candidate = null;
    /** Consecutive frames {@link candidate} has won. */
    this.streak = 0;
  }

  /** @returns {boolean} */
  get active() {
    return this.action !== null;
  }

  /**
   * Arm a capture, freezing the device's current position as rest.
   * @param {'left'|'right'|'fire'} action
   * @param {PadSnapshot} rest snapshot taken right now, buttons included
   * @returns {void}
   */
  begin(action, rest) {
    this.action = action;
    this.rest = { axes: [...rest.axes], buttons: [...rest.buttons] };
    this.candidate = null;
    this.streak = 0;
  }

  /** Abandon without binding anything. @returns {void} */
  cancel() {
    this.action = null;
    this.candidate = null;
    this.streak = 0;
  }

  /**
   * Offer one frame of device state.
   * @param {PadSnapshot} now
   * @returns {{status: 'idle'}
   *          |{status: 'pending', candidate: Binding | null}
   *          |{status: 'captured', action: 'left'|'right'|'fire', binding: Binding}}
   */
  step(now) {
    if (this.action === null) return { status: 'idle' };

    const found = detectBinding(this.rest, now);
    if (found === null) {
      this.candidate = null;
      this.streak = 0;
      return { status: 'pending', candidate: null };
    }

    if (this.candidate !== null && bindingsEqual(this.candidate, found)) {
      this.streak += 1;
    } else {
      this.candidate = found;
      this.streak = 1;
    }

    if (this.streak >= HOLD_FRAMES) {
      const action = this.action;
      this.cancel();
      return { status: 'captured', action, binding: found };
    }
    return { status: 'pending', candidate: found };
  }
}

export default BindingCapture;
