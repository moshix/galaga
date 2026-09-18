// Copyright 2026 by Moshix
/**
 * Choosing where to be.
 *
 * The fighter moves 1.5 pixels a frame, reacts two frames after the stick
 * does, and everything that kills it -- bombs, divers, the beam -- is
 * dangerous over a span of frames, not at an instant. So the question is
 * never "is that spot clear" but "if I head for that spot now, am I ever
 * where something lethal is, on the frame it is there". That is the whole
 * algorithm:
 *
 *  1. Paint a danger map: for every frame k of the horizon, which fighter
 *     x positions are lethal, and to which threat (one bit per threat), and
 *     which are merely close.
 *  2. For every reachable target x, simulate the controller walking there --
 *     exactly the policy autoplay.js will execute, including the two frames
 *     of inputs already on their way -- and find the first frame on which
 *     it stands on a lethal cell.
 *  3. Keep the plan that survives longest; among plans that survive the
 *     whole horizon, the one nearest something worth shooting.
 *
 * Scoring plans by how long they survive, rather than filtering the safe
 * ones, makes being cornered a smooth degradation -- the least-bad spot --
 * instead of a special case.
 *
 * SHOOTING YOUR WAY OUT. A diver bearing down on the fighter is also the
 * easiest thing on the screen to hit, and in Galaga the last aliens of a
 * stage never stop diving: an AI that only dodges them can dodge forever
 * and never finish the stage. So a plan that runs into a diver gets a
 * second look -- could a rocket fired from that plan kill the diver before
 * it arrives? If so, that diver's cells after the impact do not count. The
 * per-threat bits are what make that question cheap to ask.
 *
 * The map is indexed by the fighter's x (the left ship of a dual fighter),
 * so the dual fighter's width is folded into the painting, not the search.
 */

import { planShip, inFighterBand, xRange } from './paths.js';
import {
  HIT_HALF_X, MARGIN_X, DUAL_OFFSET, NEAR_MARGIN, BEAM_LEFT, BEAM_RIGHT, BEAM_MARGIN,
  W_SURVIVAL, W_HITS, W_NEAR, W_COST, W_ROOM, ROOM_CAP, W_AIM, W_HOLD, HOLD_MARGIN,
  REVERSE_MARGIN, SAFETY_GAIN, URGENT_FRAMES, DEAD_BAND,
} from './constants.js';

/** Threat bits 0..29 are tracks; this one is the tractor beam. */
export const BEAM_BIT = 30;
/** Most threats one map can tell apart. */
export const MAX_THREAT_BITS = 30;

/**
 * A danger map for frames 0..horizon, indexed `k * 256 + x`.
 * @typedef {object} DangerMap
 * @property {number} horizon
 * @property {Uint32Array} lethal  bit i: threat i kills a fighter at x on frame k
 * @property {Uint8Array} near     1: within the soft margin of something
 */

/** @param {number} horizon @returns {DangerMap} */
export function makeDangerMap(horizon) {
  return {
    horizon,
    lethal: new Uint32Array((horizon + 1) * 256),
    near: new Uint8Array((horizon + 1) * 256),
  };
}

/** @param {DangerMap} map */
export function clearMap(map) {
  map.lethal.fill(0);
  map.near.fill(0);
}

/**
 * Mark fighter positions lo..hi on frame k.
 * @param {DangerMap} map @param {number} k @param {number} lo @param {number} hi
 * @param {number} bits lethal bits to set, or 0 for the soft margin
 */
export function paint(map, k, lo, hi, bits) {
  const base = k * 256;
  const a = Math.max(0, lo);
  const b = Math.min(255, hi);
  if (bits === 0) {
    for (let x = a; x <= b; x += 1) map.near[base + x] = 1;
  } else {
    for (let x = a; x <= b; x += 1) map.lethal[base + x] |= bits;
  }
}

/**
 * Paint one threat track.
 *
 * A threat is lethal on frame k if it is in the fighter's collision band on
 * frame k-1, k or k+1 -- the sampled state can be a frame either side of the
 * one the collision test sees (see constants.js, MARGIN) -- at any of the
 * x positions it has on those frames.
 *
 * @param {DangerMap} map
 * @param {import('./paths.js').Track} t
 * @param {boolean} dual
 * @param {number} id threat bit 0..29, or -1: only paint the soft margin
 */
export function paintTrack(map, t, dual, id) {
  const half = HIT_HALF_X + MARGIN_X;
  // The fighter at x is hit by an object at ox when ox - x is in
  // -half..+half, and for a dual fighter also when it is within half of
  // x + DUAL_OFFSET: so x in ox - half - offset .. ox + half.
  const extra = dual ? DUAL_OFFSET : 0;
  const bits = id >= 0 ? (1 << id) >>> 0 : 0;
  const last = Math.min(t.last, map.horizon + 1);
  for (let j = 0; j <= last; j += 1) {
    if (!inFighterBand(t.y[j])) continue;
    const ox = t.x[j];
    for (let k = Math.max(1, j - 1); k <= Math.min(map.horizon, j + 1); k += 1) {
      if (bits !== 0) paint(map, k, ox - half - extra, ox + half, bits);
      paint(map, k, ox - half - extra - NEAR_MARGIN, ox + half + NEAR_MARGIN, 0);
    }
  }
}

/**
 * Paint the tractor beam: close on every frame (the boss announces its spot
 * long before the beam is out, so there is no reason to linger), lethal
 * from the first frame it could catch the fighter. Painting it lethal from
 * frame 1 would be wrong in an instructive way: a fighter standing under
 * the spot could not leave the zone in one frame, every plan would "die"
 * on frame 1, and the search would have no gradient left to walk it out.
 * @param {DangerMap} map @param {number} beamX @param {number} from
 */
export function paintBeam(map, beamX, from) {
  const bit = (1 << BEAM_BIT) >>> 0;
  for (let k = 1; k <= map.horizon; k += 1) {
    if (k >= from) paint(map, k, beamX - BEAM_LEFT, beamX + BEAM_RIGHT, bit);
    paint(map, k, beamX - BEAM_LEFT - BEAM_MARGIN, beamX + BEAM_RIGHT + BEAM_MARGIN, 0);
  }
}

/**
 * What evaluating one plan found; module scratch, overwritten per call.
 * `hits` counts every lethal frame, not just the first: when every plan is
 * doomed at the same frame it is still better to be in fewer of them, and
 * that is the gradient that walks the fighter out of a hopeless spot.
 * `killer` is the bit set of whatever is lethal on the first lethal frame.
 */
const verdict = { tDeath: 0, near: 0, hits: 0, killer: 0 };

/**
 * Evaluate committing to one plan.
 * @param {DangerMap} map @param {Int16Array} plan
 * @param {number} [ignore] threat bits to disregard from frame `from` on
 * @param {number} [from]
 * @returns {{tDeath: number, near: number, hits: number, killer: number}}
 */
export function evaluate(map, plan, ignore = 0, from = 0) {
  const h = map.horizon;
  let near = 0;
  let hits = 0;
  let tDeath = h + 1;
  let killer = 0;
  const keep = ~ignore;
  for (let k = 1; k <= h; k += 1) {
    const cell = k * 256 + plan[k];
    const c = k >= from ? (map.lethal[cell] & keep) : map.lethal[cell];
    if (c !== 0) {
      if (tDeath > h) { tDeath = k; killer = c; }
      hits += 1;
    } else if (map.near[cell] !== 0) near += 1;
  }
  verdict.tDeath = tDeath;
  verdict.near = near;
  verdict.hits = hits;
  verdict.killer = killer >>> 0;
  return verdict;
}

/**
 * Can this plan shoot threat `id` before it arrives? Supplied by the caller
 * (autoplay.js), which knows the rockets.
 * @callback KillTest
 * @param {Int16Array} plan
 * @param {number} id threat bit
 * @param {number} arrives the first frame the threat is lethal to the plan
 * @returns {number} the frame from which it is dead, or -1
 */

/**
 * @typedef {object} Move
 * @property {number} target   x the controller is heading for
 * @property {number} dir      direction to send this frame
 * @property {number} tDeath   first lethal frame of the plan (horizon+1: none)
 * @property {number} score
 * @property {number} kills    threat bits the plan counts on shooting
 * @property {boolean} urgent  the fighter's current course dies within
 *                             URGENT_FRAMES: a sharp turn is allowed
 */

/** Result scratch for evaluateWithKills. */
const withKills = { tDeath: 0, near: 0, hits: 0, kills: 0 };

/**
 * Evaluate a plan, letting it shoot its way out: while the first thing that
 * kills it is a track the plan could shoot in time, discount that track
 * from the impact on and look again. The beam cannot be shot.
 * @param {DangerMap} map @param {Int16Array} plan @param {KillTest | null} canKill
 * @returns {{tDeath: number, near: number, hits: number, kills: number}}
 */
export function evaluateWithKills(map, plan, canKill) {
  let ignore = 0;
  let from = 0;
  let v = evaluate(map, plan);
  // Two rockets: at most two kills per plan are worth believing in.
  for (let round = 0; round < 2 && canKill !== null && v.tDeath <= map.horizon; round += 1) {
    const killer = (v.killer & ~((1 << BEAM_BIT) >>> 0)) >>> 0;
    // One culprit at a time; several at once is not a shootable situation.
    if (killer === 0 || (killer & (killer - 1)) !== 0) break;
    const id = 31 - Math.clz32(killer);
    const dead = canKill(plan, id, v.tDeath);
    if (dead < 0) break;
    ignore = (ignore | killer) >>> 0;
    // Every ignored threat is ignored from the latest of the impacts: a
    // conservative merge that keeps the bookkeeping to two numbers.
    from = Math.max(from, dead);
    v = evaluate(map, plan, ignore, from);
  }
  withKills.tDeath = v.tDeath;
  withKills.near = v.near;
  withKills.hits = v.hits;
  withKills.kills = ignore;
  return withKills;
}

/** Scratch plan, so the search allocates nothing. */
let planScratch = new Int16Array(0);

/**
 * Pick where to go.
 *
 * The search scores every target; the rest of this function is about NOT
 * changing its mind. Scores move every frame -- the formation drifts, a
 * rocket lands, a bomb's predicted track shifts by a pixel -- and a
 * controller that follows the argmax slavishly makes the fighter shake:
 * two near-equal targets on either side trade places and it reverses
 * every few frames, which looks nervous and gains nothing. So:
 *
 *  - The held target is kept until it is reached, unless another is
 *    clearly better (HOLD_MARGIN), and much more clearly if going there
 *    means turning round (REVERSE_MARGIN).
 *  - Survival still wins, but with a noise margin: a plan that lives a
 *    frame or two longer is not a reason to turn round, one that lives
 *    SAFETY_GAIN frames longer (or right through the horizon), or any
 *    change when the held plan dies within URGENT_FRAMES, is.
 *  - A new target within DEAD_BAND pixels of where the fighter stands is
 *    not worth a move: stay, unless staying is less safe.
 *  - Straight after turning round (state.noTurn), targets that would need
 *    another turn are out of bounds unless the course the fighter is on
 *    dies within 2 * URGENT_FRAMES and the turn would not. This lives here
 *    rather than as a veto on the stick, so the plan and the stick agree:
 *    a veto after the fact leaves the fighter standing still between two
 *    targets it keeps being told to go to.
 *
 * @param {object} state
 * @param {number} state.x      fighter x now
 * @param {number} state.flag   step flag now
 * @param {ArrayLike<number>} state.queued directions already sent
 * @param {boolean} state.dual
 * @param {number} [state.lastDir] last direction the fighter was sent, -1/0/+1
 * @param {boolean} [state.noTurn] the fighter turned round, or pushed the
 *   other way, too recently to turn again without a reason
 * @param {DangerMap} map
 * @param {Float32Array | null} aim value of standing at each x, 0..1
 * @param {number} held last frame's target, or -1
 * @param {KillTest | null} [canKill]
 * @returns {Move}
 */
export function chooseMove(state, map, aim, held, canKill = null) {
  const h = map.horizon;
  if (planScratch.length < h + 1) planScratch = new Int16Array(h + 1);
  const plan = planScratch;
  const [lo, hi] = xRange(state.dual);
  const lastDir = state.lastDir ?? 0;
  const noTurn = state.noTurn === true && lastDir !== 0;
  /** Would heading for x mean turning round? @param {number} x */
  const turns = (x) => {
    const d = Math.sign(x - state.x);
    return d !== 0 && lastDir !== 0 && d !== lastDir;
  };

  let best = null;
  let bestKeep = null;
  let heldMove = null;
  let stay = null;
  for (let c = lo; c <= hi; c += 1) {
    const dir = planShip(state.x, state.flag, state.queued, c, state.dual, h, plan);
    const { tDeath, near, hits, kills } = evaluateWithKills(map, plan, canKill);
    const room = Math.min(c - lo, hi - c, ROOM_CAP);
    let score = W_SURVIVAL * tDeath - W_HITS * hits - W_NEAR * near
      - W_COST * Math.abs(c - state.x) + W_ROOM * room;
    if (aim !== null) score += W_AIM * aim[c];
    if (c === held) score += W_HOLD;
    const keeps = !turns(c);
    if (c === held || c === state.x || best === null || score > best.score
        || (keeps && (bestKeep === null || score > bestKeep.score))) {
      const move = { target: c, dir, tDeath, score, kills, urgent: false };
      if (c === held) heldMove = move;
      if (c === state.x) stay = move;
      if (best === null || score > best.score) best = move;
      if (keeps && (bestKeep === null || score > bestKeep.score)) bestKeep = move;
    }
  }
  if (best === null) return { target: state.x, dir: 0, tDeath: 0, score: 0, kills: 0, urgent: true };

  // Just turned round, or still pushing the other way: stay on course
  // unless the course itself is about to die and turning would not.
  let forced = false;
  if (noTurn && bestKeep !== null && turns(best.target)) {
    if (best.tDeath > bestKeep.tDeath && bestKeep.tDeath <= 2 * URGENT_FRAMES) forced = true;
    else best = bestKeep;
  }
  if (heldMove !== null && noTurn && turns(heldMove.target)) heldMove = null;

  let choice = best;
  if (!forced && heldMove !== null && best !== heldMove) {
    if (best.tDeath > heldMove.tDeath) {
      // Safer. Take it if the difference is real, or the held plan is
      // about to die anyway.
      const real = best.tDeath > h || best.tDeath - heldMove.tDeath >= SAFETY_GAIN
        || heldMove.tDeath <= URGENT_FRAMES;
      if (!real) choice = heldMove;
    } else if (best.tDeath === heldMove.tDeath) {
      const needed = HOLD_MARGIN + (turns(best.target) ? REVERSE_MARGIN : 0);
      if (best.score < heldMove.score + needed) choice = heldMove;
    } else {
      choice = heldMove;
    }
  }
  // Dead band: a small step for a small gain is just a twitch.
  if (!forced && stay !== null && choice !== stay
      && Math.abs(choice.target - state.x) <= DEAD_BAND && stay.tDeath >= choice.tDeath) {
    choice = stay;
  }
  // Urgent: the course the fighter is on would die soon; a sharp turn is
  // then allowed even straight after another.
  choice.urgent = forced || (heldMove !== null ? heldMove.tDeath : choice.tDeath) <= URGENT_FRAMES
    || choice.tDeath <= URGENT_FRAMES;
  return choice;
}
