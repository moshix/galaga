// Copyright 2026 by Moshix
/**
 * Offence: where to stand to have something to shoot at, and whether a
 * rocket fired now would hit anything.
 *
 * Survival is decided in evade.js; this file only supplies the tie-break it
 * uses among equally safe spots (the aim map) and the fire decision. Both
 * are built from the same tracks as the threats, so an alien is aimed at
 * where it *will* be when the rocket gets there, not where it is.
 *
 * A rocket climbs six pixels a frame from the fighter's row, so it takes
 * about 40 frames to reach the formation's top row: the formation drifts
 * several pixels in that time, and a diving alien can cross the screen.
 */

import { rocketHits } from './paths.js';
import { FIGHTER_Y, ROCKET_SPEED, FIRE_DELAY, MOVE_DELAY } from './constants.js';

/** The fighter's average speed while the stick is held: steps of 1 and 2. */
const SHIP_SPEED = 1.5;

/**
 * How much one kill is worth to the AI, not in points but in how much the
 * board is improved by it. Divers are threats; the formation is where the
 * divers come from, and the stage only ends when it is empty.
 */
const VALUE_FLYER = 1.0;
const VALUE_FORMATION = 0.6;

/** Half-width of a spot's credit in the aim map, pixels. */
const AIM_SPREAD = 3;

/**
 * Build the aim map: for each x, the value of standing there to shoot.
 *
 * For each target, find the column x* from which a rocket, fired once the
 * fighter has walked there, meets it: walk time from here, fire latency,
 * flight time to the target's height, and the target's x at that moment.
 * That is a fixed point of a smooth map, and two or three iterations of it
 * settle to the pixel.
 *
 * @param {Float32Array} aim out, indexed by x; values only ever raised, so
 *   several track lists can be folded into one map
 * @param {number} shipX
 * @param {import('./paths.js').Track[]} tracks
 * @param {number} count bombs (kind 0) in the list are ignored
 */
export function buildAimMap(aim, shipX, tracks, count) {
  for (let i = 0; i < count; i += 1) {
    const t = tracks[i];
    if (t.kind === 0 || t.last < 1) continue;
    let x = t.x[0];
    let k = 0;
    for (let iter = 0; iter < 3; iter += 1) {
      const walk = Math.abs(x - shipX) / SHIP_SPEED + MOVE_DELAY;
      const rise = Math.max(0, (FIGHTER_Y - t.y[Math.min(k, t.last)]) / ROCKET_SPEED);
      // Beyond the prediction the last known position is the best guess:
      // a far target should still pull the fighter its way, if weakly.
      k = Math.min(t.last, Math.round(walk + FIRE_DELAY + rise));
      x = t.x[k];
    }
    // Below the fighter, or level with it: nothing a rocket can reach.
    if (t.y[k] >= FIGHTER_Y - 8) continue;
    const base = t.kind === 2 ? VALUE_FORMATION : VALUE_FLYER;
    // Sooner is better: a far-future shot is a weak promise.
    const value = base * (1 - Math.min(0.5, k / 160));
    for (let d = -AIM_SPREAD; d <= AIM_SPREAD; d += 1) {
      const c = x + d;
      if (c < 0 || c > 255) continue;
      const v = value * (1 - Math.abs(d) / (AIM_SPREAD + 1));
      if (v > aim[c]) aim[c] = v;
    }
  }
}

/**
 * Would a rocket fired now hit something?
 *
 * @param {number} rocketX the fighter's x on the frame the rocket appears
 * @param {import('./paths.js').Track[]} tracks
 * @param {number} count bombs (kind 0) cannot be shot and are ignored
 * @param {number} tolerance aim error allowed, pixels
 * @returns {number} index of the track hit soonest, or -1
 */
export function chooseShot(rocketX, tracks, count, tolerance) {
  let best = -1;
  let bestFrame = Infinity;
  for (let i = 0; i < count; i += 1) {
    if (tracks[i].kind === 0) continue;
    const k = rocketHits(rocketX, FIRE_DELAY, tracks[i], tolerance);
    if (k >= 0 && k < bestFrame) { bestFrame = k; best = i; }
  }
  return best;
}
