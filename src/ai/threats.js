// Copyright 2026 by Moshix
/**
 * Reading the board.
 *
 * The only file in `src/ai/` that touches a machine. It samples the RAM the
 * decision code needs into plain numbers and typed arrays -- a world model --
 * and everything downstream (flight.js, paths.js, evade.js) works on those,
 * which is what lets it all be tested in Node with synthetic states.
 *
 * The adapter it needs is tiny, and both the port's Machine and the oracle
 * board satisfy it: `peek(addr)` for $8000-$9BFF. Nothing here writes.
 *
 * Nothing here allocates either: the tracks and flight records are made once
 * and refilled every frame, because this runs sixty times a second next to a
 * three-CPU board emulation and a full repaint.
 */

import { makeFlight, makeFlightEnv, loadFlight } from './flight.js';
import { makeTrack, predictBomb, predictFlyer, predictDrift } from './paths.js';
import {
  HORIZON, MOTION_SLOTS, MOTION_QUEUE, MOTION_SLOT_SIZE,
  BOMB_FIRST, BOMB_COUNT, BOMB_RATES, BOMB_CODE, ROCKET_SLOTS,
} from './constants.js';

/**
 * @typedef {object} Peekable
 * @property {(addr: number) => number} peek
 */

/**
 * The scalars the decision code reads.
 * @typedef {object} World
 * @property {number} gameState  $9201: 1 attract, 2 credit in, 3 playing
 * @property {number} credits    $99B8
 * @property {boolean} canMove   $9014: the joystick task runs (and the
 *                               collision task with it: the fighter is live)
 * @property {boolean} canFire   $9015: the fire task runs
 * @property {number} x          $9362 fighter x
 * @property {number} flag       $92A3 step flag
 * @property {boolean} dual      $9827 two-ship fighter
 * @property {number} counter    $92A0 frame counter
 * @property {number} runnerLeft $9289 slots the motion runner has to go
 * @property {boolean} challenge $9825 = 0: a challenging stage
 * @property {boolean} launching $9008: an attack wave is being launched,
 *                               during which only the transients $38-$3E
 *                               are tested against the fighter
 * @property {number} stage      $9821
 * @property {number} ships      $9820 reserve ships
 * @property {boolean} beam      a capture boss is diving to beam, or beaming
 * @property {number} beamX      $928A the beam's column
 * @property {number} beamFrom   first frame index on which the beam could
 *                               catch the fighter
 * @property {number} rocketsFree rocket slots with x = 0
 */

/**
 * Frames until the tractor beam can catch anything (l_233D tests only while
 * $928B is exactly $40, "fully out").
 *
 * While the boss is still diving to its spot (task f_21CB) the beam has not
 * begun: the dive and then eleven rows of beam, each $982A frames apart, lie
 * ahead -- well over a second -- so BEAM_DIVE_FRAMES is a safe lower bound.
 * Once the beam task runs, $928B counts the rows drawn and $928C the frames
 * to the next one.
 *
 * @param {boolean} diving @param {number} state $928B @param {number} timer $928C
 * @param {number} period $982A
 * @returns {number}
 */
export function beamOnset(diving, state, timer, period) {
  if (diving) return BEAM_DIVE_FRAMES;
  if (state === 0x40) return 1;
  const rows = state & 0x0f;
  return Math.max(1, (0x0a - rows) * period + timer);
}

/** Lower bound on a capture boss's dive plus the beam's growth, frames. */
const BEAM_DIVE_FRAMES = 30;

/** Slots are $14 bytes apart from $9100. */
const slotAddr = (n) => MOTION_QUEUE + n * MOTION_SLOT_SIZE;

/** Frames of formation history kept for the drift estimate. */
const DRIFT_FRAMES = 8;

export class ThreatReader {
  /** @param {number} [horizon] */
  constructor(horizon = HORIZON) {
    this.horizon = horizon;
    /** @type {World} */
    this.world = {
      gameState: 0, credits: 0, canMove: false, canFire: false, x: 0, flag: 0, dual: false,
      counter: 0, runnerLeft: 0, challenge: false, launching: false, stage: 0, ships: 0,
      beam: false, beamX: 0, beamFrom: 1, rocketsFree: 0,
    };
    this.env = makeFlightEnv();
    this.flight = makeFlight();
    /** Bombs and flying aliens: the things that kill. */
    this.threats = [];
    for (let i = 0; i < BOMB_COUNT + MOTION_SLOTS; i += 1) this.threats.push(makeTrack(horizon));
    this.threatCount = 0;
    /**
     * Whether each threat can kill (a flyer during a wave launch cannot,
     * unless it is a transient); 0 still gets a soft margin.
     */
    this.lethal = new Uint8Array(BOMB_COUNT + MOTION_SLOTS);
    /** Formation aliens, as drift tracks: only targets. */
    this.targets = [];
    for (let i = 0; i < 48; i += 1) this.targets.push(makeTrack(horizon));
    this.targetCount = 0;
    /** Formation x history, one ring per object, for the drift estimate. */
    this.history = new Int16Array(48 * DRIFT_FRAMES).fill(-1);
    this.historyAt = 0;
    /** Scratch for bomb-drop frames, unused by default. */
    this.drops = new Uint8Array(horizon + 2);
  }

  /**
   * Sample the scalars.
   * @param {Peekable} m @returns {World}
   */
  readWorld(m) {
    const w = this.world;
    w.gameState = m.peek(0x9201);
    w.credits = m.peek(0x99b8);
    w.canMove = m.peek(0x9014) !== 0;
    w.canFire = m.peek(0x9015) !== 0;
    w.x = m.peek(0x9362);
    w.flag = m.peek(0x92a3) & 1;
    w.dual = (m.peek(0x9827) & 1) !== 0;
    w.counter = m.peek(0x92a0);
    w.runnerLeft = m.peek(0x9289);
    w.challenge = m.peek(0x9825) === 0;
    w.launching = m.peek(0x9008) !== 0;
    w.stage = m.peek(0x9821);
    w.ships = m.peek(0x9820);
    // The capture boss: task f_21CB ($9019) flies it to its spot, task f_2222
    // ($9018) runs the beam. Bit 7 of $928B means the boss was shot; values
    // above $40 mean the beam is retracting after a miss. Either way it is
    // over.
    const beamState = m.peek(0x928b);
    w.beam = m.peek(0x9019) !== 0
      || (m.peek(0x9018) !== 0 && (beamState & 0x80) === 0 && beamState <= 0x40);
    w.beamX = m.peek(0x928a);
    w.beamFrom = beamOnset(m.peek(0x9019) !== 0, beamState, m.peek(0x928c), m.peek(0x982a));
    let free = 0;
    for (const l of ROCKET_SLOTS) if (m.peek(0x9300 + l) === 0) free += 1;
    w.rocketsFree = free;

    const e = this.env;
    e.fighterX = w.x;
    e.fighterXHw = m.peek(0x93e2);
    e.parm8 = m.peek(0x99c8);
    e.parm9 = m.peek(0x99c9);
    e.cbomb = m.peek(0x92aa);
    e.task1D = m.peek(0x901d);
    e.bombBits = m.peek(0x92c8);
    e.bombReload = m.peek(0x92e2);
    e.fighterLive = m.peek(0x9015);
    e.captureTmr = m.peek(0x92ad);
    for (let i = 0; i < 0x20; i += 1) {
      e.fmtn[i] = m.peek(0x9800 + i);
      e.fmtn[0x20 + i] = m.peek(0x9900 + i);
    }
    return w;
  }

  /**
   * Build this frame's threat and target tracks.
   * @param {Peekable} m
   * @returns {number} threats in `this.threats[0..n)`
   */
  collect(m) {
    const w = this.readWorld(m);
    const h = this.horizon;
    let n = 0;

    // Bombs: object status 6, sprite code $30, x not 0 (f_1EA4's own tests).
    for (let i = 0; i < BOMB_COUNT; i += 1) {
      const l = BOMB_FIRST + 2 * i;
      if (m.peek(0x8800 + l) !== 0x06) continue;
      if (m.peek(0x8b00 + l) !== BOMB_CODE) continue;
      const x = m.peek(0x9300 + l);
      if (x === 0) continue;
      const y = m.peek(0x9301 + l) | ((m.peek(0x9b01 + l) & 1) << 8);
      const t = this.threats[n];
      t.obj = l;
      predictBomb(x, y, m.peek(BOMB_RATES + 2 * i), m.peek(BOMB_RATES + 2 * i + 1),
        w.counter, h, t);
      this.lethal[n] = 1;
      n += 1;
    }

    // Flying aliens: every active motion-queue slot. The slot the runner is
    // in the middle of (12 - $9289) has already had this IRQ's step if it
    // comes before that point, so its next step is a frame later.
    const current = MOTION_SLOTS - w.runnerLeft;
    const peek = (a) => m.peek(a);
    for (let s = 0; s < MOTION_SLOTS; s += 1) {
      const addr = slotAddr(s);
      if ((m.peek(addr + 0x13) & 1) === 0) continue;
      const obj = m.peek(addr + 0x10);
      if (obj >= 0x60) continue;
      const status = m.peek(0x8800 + obj);
      if (status !== 3 && status !== 7 && status !== 9) continue;
      // Already hit, waiting for the main CPU to explode it.
      if ((m.peek(0x9200 + obj) & 0x80) !== 0) continue;
      const f = this.flight;
      loadFlight(f, peek, addr, status);
      const t = this.threats[n];
      t.obj = obj;
      const parity0 = (s < current ? w.counter + 1 : w.counter) & 1;
      predictFlyer(f, this.env, parity0, h, t);
      // During a wave launch the collision test only covers the transients.
      this.lethal[n] = (!w.launching || (obj >= 0x38 && obj <= 0x3e)) ? 1 : 0;
      n += 1;
    }
    this.threatCount = n;

    this.collectTargets(m);
    return n;
  }

  /**
   * Formation aliens (status 1, and 2 while settling), as drift tracks.
   * @param {Peekable} m
   */
  collectTargets(m) {
    const h = this.horizon;
    const at = this.historyAt;
    const back = (at + 1) % DRIFT_FRAMES;
    let n = 0;
    for (let i = 0; i < 48; i += 1) {
      const l = 2 * i;
      const status = m.peek(0x8800 + l);
      const x = m.peek(0x9300 + l);
      const ring = i * DRIFT_FRAMES;
      if ((status !== 1 && status !== 2) || x === 0 || (m.peek(0x9200 + l) & 0x80) !== 0) {
        this.history[ring + at] = -1;
        continue;
      }
      this.history[ring + at] = x;
      // Velocity over the ring, if the whole ring is this alien in place.
      const old = this.history[ring + back];
      const vx = old >= 0 ? (x - old) / (DRIFT_FRAMES - 1) : 0;
      const y = m.peek(0x9301 + l) | ((m.peek(0x9b01 + l) & 1) << 8);
      const t = this.targets[n];
      t.obj = l;
      predictDrift(x, y, vx, h, t);
      n += 1;
    }
    this.historyAt = back;
    this.targetCount = n;
  }
}
