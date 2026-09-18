// Copyright 2026 by Moshix
/**
 * Where things will be, frame by frame: bombs, flying aliens, the fighter
 * itself and its rockets. Pure functions on plain numbers; nothing here reads
 * the machine (threats.js does that), which is what lets every predictor be
 * tested against synthetic states and against the game's own code.
 *
 * THE FRAME INDEX. Everything is written in one index k counted from "now",
 * the moment the AI samples RAM between two frames: k = 1 is the state after
 * the next frame has run, k = 2 the one after that, and so on. Frame parity
 * matters to almost everything in Galaga (aliens move at one speed on odd
 * frames and another on even ones, bombs fall 2 or 3 pixels), and it comes
 * from the frame counter $92A0 as read now.
 */

import { stepFlight } from './flight.js';
import {
  FIGHTER_YH, X_MIN, X_MAX, X_MAX_DUAL, RIGHT_LIMIT, RIGHT_LIMIT_DUAL, LEFT_LIMIT,
  ROCKET_SPEED, ROCKET_HIT_DYH_LO, ROCKET_HIT_DYH_HI, FIGHTER_Y,
} from './constants.js';

/**
 * A predicted trajectory: x and y for k = 0..horizon, and the last valid k.
 * @typedef {object} Track
 * @property {Int16Array} x
 * @property {Int16Array} y
 * @property {number} last  last frame index with a valid position (-1: none)
 * @property {number} kind  0 bomb, 1 flying alien, 2 formation alien
 * @property {number} obj   object offset L
 */

/** @param {number} horizon @returns {Track} */
export function makeTrack(horizon) {
  return {
    x: new Int16Array(horizon + 2), y: new Int16Array(horizon + 2), last: -1, kind: 0, obj: 0,
  };
}

// ------------------------------------------------------------------ bombs

/**
 * One bomb, exactly as f_1EA4 moves it (galaga-main.asm $1EA4).
 *
 * Sideways: every frame `c = (rate & $7E) + remainder`, the remainder keeps
 * c mod 32 and the bomb moves c / 32 pixels, left when bit 7 of the rate is
 * set. Downwards: 2 pixels plus bit 0 of the frame counter as the main CPU
 * sees it, which works out (measured) to 2 on the frame after the AI reads
 * an even $92A0 and 3 after an odd one.
 *
 * @param {number} x @param {number} y 9-bit
 * @param {number} rate $92B0+2n @param {number} rem $92B1+2n
 * @param {number} counter $92A0 as read now
 * @param {number} horizon
 * @param {Track} out
 */
export function predictBomb(x, y, rate, rem, counter, horizon, out) {
  out.kind = 0;
  out.x[0] = x;
  out.y[0] = y;
  let acc = rem;
  const mag = rate & 0x7e;
  const left = (rate & 0x80) !== 0;
  let k = 1;
  for (; k <= horizon; k += 1) {
    const c = mag + acc;
    acc = c & 0x1f;
    const dx = c >> 5;
    x = left ? x - dx : x + dx;
    y += 2 + ((counter + k + 1) & 1);
    // Off either side, or far below the fighter: it cannot matter any more.
    if (x < 0 || x > 0xff || y > FIGHTER_Y + 0x20) break;
    out.x[k] = x;
    out.y[k] = y;
  }
  out.last = k - 1;
}

// ---------------------------------------------------------- flying aliens

/**
 * A flying alien, by replaying its motion-queue slot (flight.js).
 *
 * Which frame parity the next step uses depends on whether the sub CPU has
 * already processed this slot in the IRQ that straddles the frame boundary:
 * its loop counter $9289 says how many slots it still has to go.
 *
 * @param {import('./flight.js').Flight} f loaded flight (advanced in place)
 * @param {import('./flight.js').FlightEnv} env
 * @param {number} parity0 frame-counter bit for the first step
 * @param {number} horizon
 * @param {Track} out
 * @param {Uint8Array} [drops] set to 1 on frames where it drops a bomb
 */
export function predictFlyer(f, env, parity0, horizon, out, drops) {
  out.kind = 1;
  out.x[0] = f.x;
  out.y[0] = f.y;
  if (drops !== undefined) drops.fill(0);
  let k = 1;
  for (; k <= horizon; k += 1) {
    if (!stepFlight(f, env, (parity0 + k - 1) & 1)) break;
    out.x[k] = f.x;
    out.y[k] = f.y;
    if (drops !== undefined && f.dropped) drops[k] = 1;
  }
  out.last = k - 1;
}

/**
 * A formation alien: it only drifts with the formation, so its velocity
 * (measured over the last few frames) is a good enough guide for the
 * second or so a rocket takes to reach it.
 * @param {number} x @param {number} y @param {number} vx pixels per frame
 * @param {number} horizon @param {Track} out
 */
export function predictDrift(x, y, vx, horizon, out) {
  out.kind = 2;
  for (let k = 0; k <= horizon; k += 1) {
    out.x[k] = Math.round(x + vx * k);
    out.y[k] = y;
  }
  out.last = horizon;
}

/**
 * Is the object at 9-bit y in the fighter's collision band?
 * @param {number} y @returns {boolean}
 */
export function inFighterBand(y) {
  const d = (y >> 1) - FIGHTER_YH;
  return d >= -3 && d <= 3;
}

// ------------------------------------------------------------ the fighter

/**
 * The fighter's step logic from f_1F85 (galaga-main.asm $1F92-$1FD8).
 *
 * While the stick is held the step alternates 1, 2, 1, 2 -- the flag at
 * $92A3 is toggled and the step is 2 when it comes out 0 -- and centring
 * the stick clears the flag. Changing direction without centring does not.
 * The limit tests look at the position before the step, so the last step
 * can overshoot them by one.
 *
 * @param {{x: number, flag: number}} s state, updated in place
 * @param {number} dir -1 left, 0 none, +1 right
 * @param {boolean} dual two-ship fighter (tighter right limit)
 */
export function stepShip(s, dir, dual) {
  if (dir === 0) { s.flag = 0; return; }
  s.flag ^= 1;
  const dx = s.flag ? 1 : 2;
  if (dir > 0) {
    if (dual && s.x >= RIGHT_LIMIT_DUAL) return;
    if (s.x >= RIGHT_LIMIT) return;
    s.x += dx;
  } else {
    if (s.x < LEFT_LIMIT) return;
    s.x -= dx;
  }
}

/**
 * The controller's policy for reaching `target`: move towards it, but when
 * one pixel remains and the next step would be two, let go for a frame --
 * that clears the step flag, so the next step is one and lands exactly.
 * Walking past the target and back would cost more than the pause.
 *
 * @param {number} x @param {number} flag @param {number} target
 * @param {boolean} dual
 * @returns {number} -1, 0 or +1
 */
export function policy(x, flag, target, dual) {
  const d = target - x;
  if (d === 0) return 0;
  const next = flag ? 2 : 1;
  if (Math.abs(d) < next) return 0;
  if (d > 0) {
    if ((dual && x >= RIGHT_LIMIT_DUAL) || x >= RIGHT_LIMIT) return 0;
    return 1;
  }
  if (x < LEFT_LIMIT) return 0;
  return -1;
}

/** Scratch ship state, so planning allocates nothing. */
const ship = { x: 0, flag: 0 };

/**
 * Where the fighter will be on frames 1..horizon if the controller commits
 * to `target` now.
 *
 * The first MOVE_DELAY frames are already decided by switches closed
 * earlier (`queued`, oldest first); the policy only takes over after them,
 * and it is evaluated on the state it will actually see, not on today's.
 *
 * @param {number} x0 fighter x now @param {number} flag0 $92A3 now
 * @param {ArrayLike<number>} queued directions already sent, oldest first
 * @param {number} target
 * @param {boolean} dual
 * @param {number} horizon
 * @param {Int16Array} out out[k] = x after frame k
 * @returns {number} the direction to send now
 */
export function planShip(x0, flag0, queued, target, dual, horizon, out) {
  ship.x = x0;
  ship.flag = flag0;
  out[0] = x0;
  let first = 0;
  for (let k = 1; k <= horizon; k += 1) {
    let dir;
    if (k <= queued.length) dir = queued[k - 1];
    else {
      dir = policy(ship.x, ship.flag, target, dual);
      if (k === queued.length + 1) first = dir;
    }
    stepShip(ship, dir, dual);
    out[k] = ship.x;
  }
  return first;
}

/** Reachable x range for the fighter. @param {boolean} dual @returns {[number, number]} */
export function xRange(dual) {
  return [X_MIN, dual ? X_MAX_DUAL : X_MAX];
}

// ------------------------------------------------------------- the rockets

/**
 * Would a rocket at x, first seen at 9-bit y `y0` on frame `k0` and climbing
 * six pixels a frame, hit a target following `t`?
 *
 * The rocket's first position is only known to within one step (it is seen
 * at $123 or $129 depending on which CPU got there first), so the hit is
 * only claimed if it holds under both phases: a miss costs a rocket slot
 * for a second or more, and caution costs nothing.
 *
 * @param {number} rx @param {number} k0 @param {Track} t
 * @param {number} tolerance pixels the aim may be off by (<= ROCKET_HIT_DX)
 * @returns {number} frame of impact, or -1
 */
export function rocketHits(rx, k0, t, tolerance) {
  let impact = -1;
  for (let phase = 0; phase <= 1; phase += 1) {
    let hit = -1;
    for (let k = k0; k <= t.last; k += 1) {
      const ry = FIGHTER_Y - ROCKET_SPEED * (k - k0 + phase);
      if (ry < 0x28) break;
      const dyh = (t.y[k] >> 1) - (ry >> 1);
      // The rocket climbs, so alien-minus-rocket grows from very negative
      // (still below it) through the hit window to positive (gone past).
      if (dyh > ROCKET_HIT_DYH_HI) break;
      if (dyh < ROCKET_HIT_DYH_LO) continue;
      if (Math.abs(t.x[k] - rx) <= tolerance) { hit = k; break; }
    }
    if (hit < 0) return -1;
    impact = Math.max(impact, hit);
  }
  return impact;
}
