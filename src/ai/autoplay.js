// Copyright 2026 by Moshix
/**
 * The self-playing AI.
 *
 * It is a *controller*, not a cheat: it reads the game's state from RAM, but
 * its only outputs are the switches a human has -- left, right, fire, plus
 * coin and start to begin a game. It cannot move the fighter faster than the
 * game moves it (1 and 2 pixels on alternate frames), cannot fire more often
 * than the 51XX reports presses or while two rockets are in flight, and dies
 * to exactly the same hit boxes.
 *
 * WHAT IT IS TRYING TO DO: stay alive first, score second.
 *
 * This file is arbitration. The ideas are underneath it:
 *
 *  - An alien's flight is computable: the sub CPU flies it along a path in
 *    ROM, so replaying the path tells where it will be for the next second,
 *    to the pixel. @see ./flight.js
 *  - Danger is a span of frames, and the fighter is slow and a frame or
 *    two late: plans are judged by how long they survive, simulated with the
 *    exact step logic and latency. @see ./evade.js
 *  - A rocket is aimed at where its target will be, and only fired when it
 *    will hit. @see ./aim.js
 *
 *  - The fighter must not shake: targets are held until clearly beaten,
 *    and the stick does not reverse twice in quick succession unless
 *    something is about to hit. @see steady(), evade.js chooseMove
 *  - The input latency is measured, not assumed: it depends on where the
 *    host samples the game (two frames on the emulated board, one on the
 *    port). @see calibrate()
 *
 * THE DUAL FIGHTER, as a good player gets it: with a reserve fighter to
 * spare, walk under a boss's tractor beam and let it take the fighter; then
 * shoot that boss while it dives with the captive -- never at home, never
 * the captive itself -- and the freed fighter docks beside the new one. As
 * a dual fighter, or with no reserve, every beam is avoided. docs/ai.md has
 * the numbers for both policies.
 */

import { ThreatReader } from './threats.js';
import { makeDangerMap, clearMap, paintTrack, paintBeam, chooseMove } from './evade.js';
import { buildAimMap, chooseShot } from './aim.js';
import { planShip, rocketHits, stepShip } from './paths.js';
import {
  HORIZON, FIRE_HOLD, FIRE_RELEASE, FIRE_DELAY, MOVE_DELAY, ROCKET_SLOTS, ROCKET_SPEED,
} from './constants.js';

/** Input latencies the calibration considers, frames. */
const MIN_DELAY = 1;
const MAX_DELAY = 3;
/** Directions remembered; must exceed MAX_DELAY. */
const HISTORY = 8;
/**
 * Frames that must pass after pushing one way before pushing the other,
 * unless dodging (see steady()).
 */
const TURN_GAP = 3;
/**
 * And after turning round, this long before turning round again: two
 * reversals in quick succession are the "nervous" look, and unless
 * something is about to hit, the second one is never worth it.
 */
const REVERSAL_COOLDOWN = 16;

/** Aim error a shot may have and still be taken: the hit box is +-5. */
const SHOT_TOLERANCE = 3;
/**
 * A plan may count on shooting a diver only if the rocket arrives this many
 * frames before the diver does: a margin for the diver's path being a frame
 * out, and for the rocket being spent on something else first.
 */
const KILL_MARGIN = 3;
/** How many press frames a kill test tries, from the first one possible. */
const KILL_WINDOW = 16;
/** A rocket leaves the screen once y<8:1> < $14 (rckt_man). */
const ROCKET_EXIT_Y = 0x28;
/**
 * The dual fighter. Standing under a capture boss's spot is worth this
 * much in the aim map (a formation shot is at most 0.6), over this many
 * pixels either side of the beam's centre; the boss holding our captured
 * fighter, when it dives, is worth RESCUE_WEIGHT times a normal target;
 * and a rocket is not fired if it would pass within CAPTIVE_GUARD pixels of
 * the captive.
 */
const CAPTURE_VALUE = 3;
const CAPTURE_SPREAD = 4;
const RESCUE_WEIGHT = 3;
const CAPTIVE_GUARD = 8;
/** Coin/start pulse: held this many frames out of every COIN_CYCLE. */
const COIN_HOLD = 4;
const COIN_CYCLE = 20;

/** @typedef {'left'|'right'|'fire'|'coin1'|'start1'} SwitchName */

/**
 * What the AI needs from a machine: RAM reads and the player's switches.
 * @typedef {object} Controllable
 * @property {(addr: number) => number} peek
 * @property {(name: SwitchName, down: boolean) => void} setInput
 */

export class AutoPlayer {
  /**
   * @param {Controllable} machine
   * @param {{autoStart?: boolean, delay?: number, dualFighter?: boolean}} [options]
   *   autoStart (default true): insert a coin and press start whenever no
   *   game is in progress, as the Galaxian AI does; false leaves starting
   *   games to the player. delay: fix the input latency in frames instead
   *   of measuring it (see calibrate()). dualFighter (default true): let a
   *   boss capture the fighter when a reserve can take over, then shoot
   *   the boss to win the dual fighter; false avoids every beam.
   */
  constructor(machine, options = {}) {
    this.m = machine;
    this.autoStart = options.autoStart ?? true;
    this.reader = new ThreatReader(HORIZON);
    this.map = makeDangerMap(HORIZON);
    this.aim = new Float32Array(256);
    this.plan = new Int16Array(HORIZON + 1);
    /**
     * Directions sent, most recent first: sent[0] went out on the last
     * step(). The ones not yet acted on are the plan's first frames.
     */
    this.sent = new Int8Array(HISTORY);
    /** Input latency in frames, as measured on this machine; see calibrate(). */
    this.delay = options.delay ?? MOVE_DELAY;
    /** Measure the latency unless the host fixed it. */
    this.calibrating = options.delay === undefined;
    this.dualFighter = options.dualFighter ?? true;
    /**
     * Per object: 0 never shoot, 1 normal, more to prefer. Rebuilt every
     * frame by targetWeights(); it is how the captured fighter is spared.
     */
    this.weights = new Float32Array(0x80);
    /** Evidence for each latency: moves it explained that the others did not. */
    this.delayVotes = new Int32Array(MAX_DELAY + 1);
    /** Last non-zero direction sent, and frames since it was sent. */
    this.lastDir = 0;
    this.sinceLastDir = 0;
    /** Frames since the last reversal of direction. */
    this.sinceReversal = REVERSAL_COOLDOWN;
    /** The fighter as last seen, for the calibration. -1: not in play. */
    this.lastX = -1;
    this.lastFlag = 0;
    /** Scratch views of the queued directions, oldest first, one per latency. */
    this.queuedViews = [];
    for (let d = 0; d <= MAX_DELAY; d += 1) this.queuedViews.push(new Int8Array(d));
    this.queued = this.queuedViews[this.delay];
    /** Target being walked towards, for hysteresis. -1: none. */
    this.held = -1;
    /** Frames into the current fire press (0: idle). */
    this.fireStep = 0;
    this.coinPhase = 0;
    /** Earliest press frame for a new rocket, set each frame. */
    this.fireReady = 1;
    /** Memo for kill tests this frame: key -> impact frame or -1. */
    this.killMemo = new Map();
    /** The kill test handed to the planner, bound once. */
    this.canKill = (plan, id, arrives) => this.killTest(plan, id, arrives);
    /** Diagnostics, readable from the console. */
    this.telemetry = {
      mode: 'idle', threats: 0, target: -1, tDeath: 0, shots: 0,
    };
  }

  /**
   * Open every switch. Called at the top of every frame, so no input can
   * stick on any early-return path, and by the host when it takes back
   * control.
   * @returns {void}
   */
  release() {
    for (const name of /** @type {SwitchName[]} */ (['left', 'right', 'fire', 'coin1', 'start1'])) {
      this.m.setInput(name, false);
    }
  }

  /** Forget everything tied to the current fighter. */
  reset() {
    this.sent.fill(0);
    this.lastDir = 0;
    this.sinceLastDir = 0;
    this.sinceReversal = REVERSAL_COOLDOWN;
    this.lastX = -1;
    this.held = -1;
    this.fireStep = 0;
  }

  /** One frame of play, before the machine runs it. @returns {void} */
  step() {
    const m = this.m;
    this.release();
    const world = this.reader.readWorld(m);

    if (world.gameState !== 3) {
      this.reset();
      this.telemetry.mode = 'idle';
      if (this.autoStart) this.insertCoinAndStart(world.credits);
      return;
    }
    this.coinPhase = 0;
    if (!world.canMove) {
      // Exploding, captured, or waiting for "READY": nothing to steer, and
      // the respawn puts the fighter back in the middle by itself.
      this.reset();
      this.telemetry.mode = 'wait';
      return;
    }

    this.calibrate(world);
    const count = this.reader.collect(m);
    const r = this.reader;

    // Danger map: every threat, and the beam while a capture is on.
    const map = this.map;
    clearMap(map);
    for (let i = 0; i < count; i += 1) {
      paintTrack(map, r.threats[i], world.dual, r.lethal[i] !== 0 ? i : -1);
    }
    // The beam: avoided, or -- when a capture is what we want -- walked
    // into (the aim map below does the pulling).
    const wantCapture = this.wantsCapture(world);
    if (world.beam && !wantCapture) paintBeam(map, world.beamX, world.beamFrom);
    this.targetWeights(world, wantCapture);

    // Aim map from everything shootable.
    this.aim.fill(0);
    buildAimMap(this.aim, world.x, r.threats, count, this.weights);
    buildAimMap(this.aim, world.x, r.targets, r.targetCount, this.weights);
    if (world.beam && wantCapture) {
      // Stand under the boss's spot. Worth more than any shot: this is how
      // the dual fighter is won. The diving boss itself is still a threat
      // track, so the approach does not collide with it on the way.
      for (let d = -CAPTURE_SPREAD; d <= CAPTURE_SPREAD; d += 1) {
        const c = world.beamX + d;
        if (c >= 0 && c < 256) this.aim[c] = Math.max(this.aim[c], CAPTURE_VALUE);
      }
    }

    const state = {
      x: world.x,
      flag: world.flag,
      queued: this.queued,
      dual: world.dual,
      lastDir: this.lastDir,
    };
    this.fireReady = this.firstPress(m, world);
    this.killMemo.clear();
    const move = chooseMove(state, map, this.aim, this.held, world.canFire ? this.canKill : null);
    this.held = move.target;
    this.send(this.steady(move.dir, move.urgent));

    if (move.tDeath <= HORIZON) this.telemetry.mode = 'dodge';
    else if (world.beam && wantCapture) this.telemetry.mode = 'capture';
    else if (world.holder >= 0 && this.weights[world.holder] > 1) this.telemetry.mode = 'rescue';
    else this.telemetry.mode = 'play';
    this.telemetry.threats = count;
    this.telemetry.target = move.target;
    this.telemetry.tDeath = move.tDeath;

    // Where the rocket would start is where the chosen plan puts the
    // fighter on the frame the rocket appears.
    planShip(world.x, world.flag, this.queued, move.target, world.dual, HORIZON, this.plan);
    this.fire(world, this.plan[this.fireDelay]);
  }

  /**
   * The first frame (k >= 1) a fire press could start and still find a
   * rocket slot free when its rocket appears.
   * @param {Controllable} m
   * @param {import('./threats.js').World} world
   * @returns {number}
   */
  firstPress(m, world) {
    // The press cycle: a press is followed by FIRE_HOLD + FIRE_RELEASE
    // frames in which no new one can begin.
    let k = this.fireStep > 0 ? FIRE_HOLD + FIRE_RELEASE + 1 - this.fireStep : 1;
    const pending = this.fireStep > 0 ? 1 : 0;
    if (world.rocketsFree - pending > 0) return k;
    // Both slots taken: wait for the higher rocket to leave the screen.
    let exit = Infinity;
    for (const l of ROCKET_SLOTS) {
      if (m.peek(0x9300 + l) === 0) continue;
      const y = m.peek(0x9301 + l) | ((m.peek(0x9b01 + l) & 1) << 8);
      exit = Math.min(exit, Math.ceil((y - ROCKET_EXIT_Y) / ROCKET_SPEED) + 1);
    }
    if (exit === Infinity) exit = FIRE_HOLD + FIRE_RELEASE;
    return Math.max(k, exit - this.fireDelay + 1);
  }

  /**
   * Could the plan shoot threat `id` before it reaches the fighter? Tries
   * every press frame from the first possible one: the rocket leaves at the
   * plan's x `fireDelay` frames after the press.
   * @param {Int16Array} plan @param {number} id @param {number} arrives
   * @returns {number} frame from which the threat is gone, or -1
   */
  killTest(plan, id, arrives) {
    const t = this.reader.threats[id];
    if (t.kind === 0) return -1;              // bombs cannot be shot
    if (this.weights[t.obj] === 0) return -1; // must not be shot
    const lastPress = Math.min(arrives - KILL_MARGIN - this.fireDelay, this.fireReady + KILL_WINDOW);
    for (let kp = this.fireReady; kp <= lastPress; kp += 1) {
      const k0 = kp + this.fireDelay;
      const rx = plan[k0];
      const key = (id << 16) | (k0 << 8) | rx;
      let impact = this.killMemo.get(key);
      if (impact === undefined) {
        impact = rocketHits(rx, k0, t, SHOT_TOLERANCE);
        this.killMemo.set(key, impact);
      }
      if (impact >= 0 && impact <= arrives - KILL_MARGIN) return impact + 1;
    }
    return -1;
  }

  /**
   * Frame of the press (k = 1) on which its rocket is first seen: the
   * press travels the same path as the stick, and the fire and rocket tasks
   * take two frames more (FIRE_DELAY - MOVE_DELAY, measured on the oracle).
   * @returns {number}
   */
  get fireDelay() {
    return this.delay + FIRE_DELAY - MOVE_DELAY;
  }

  /**
   * Measure the input latency instead of assuming it.
   *
   * It is not a property of the game but of where the host samples it: on
   * the emulated board, stepped a whole video frame at a time, the stick
   * moves the fighter two frames after it is closed; on the port, whose
   * frame ends with every interrupt handler finished, one frame after. A
   * controller that is out by one frame steers every plan a frame late,
   * which is invisible most of the time and fatal at the edges.
   *
   * So every frame the fighter's last step is checked against each
   * candidate latency -- which of the directions sent 1, 2 or 3 frames ago,
   * pushed through the real step logic, lands where it is now -- and a
   * vote goes to the ones that explain it when not all of them do.
   * @param {import('./threats.js').World} world
   */
  calibrate(world) {
    if (this.calibrating && this.lastX >= 0) {
      let agree = 0;
      const hit = [false, false, false, false];
      const s = { x: 0, flag: 0 };
      for (let d = MIN_DELAY; d <= MAX_DELAY; d += 1) {
        s.x = this.lastX;
        s.flag = this.lastFlag;
        stepShip(s, this.sent[d], world.dual);
        hit[d] = s.x === world.x;
        if (hit[d]) agree += 1;
      }
      if (agree > 0 && agree < MAX_DELAY - MIN_DELAY + 1) {
        for (let d = MIN_DELAY; d <= MAX_DELAY; d += 1) if (hit[d]) this.delayVotes[d] += 1;
      }
      let best = this.delay;
      for (let d = MIN_DELAY; d <= MAX_DELAY; d += 1) {
        if (this.delayVotes[d] > this.delayVotes[best]) best = d;
      }
      this.delay = best;
    }
    this.lastX = world.x;
    this.lastFlag = world.flag;
    // The directions sent but not yet acted on, oldest first.
    const q = this.queuedViews[this.delay];
    for (let i = 0; i < this.delay; i += 1) q[i] = this.sent[this.delay - 1 - i];
    this.queued = q;
  }

  /**
   * No shaking. A reversal within TURN_GAP frames of the last push the other
   * way is held back for a frame -- the planner re-plans next frame from
   * where the fighter really is -- unless the current course runs into
   * something within URGENT_FRAMES, when the fighter may turn as sharply
   * as the stick allows.
   * @param {number} dir wanted direction @param {boolean} urgent
   * @returns {number} direction to send
   */
  steady(dir, urgent) {
    const reversal = dir !== 0 && this.lastDir !== 0 && dir !== this.lastDir;
    if (reversal && !urgent
        && (this.sinceLastDir < TURN_GAP || this.sinceReversal < REVERSAL_COOLDOWN)) {
      return 0;
    }
    return dir;
  }

  /**
   * Close the direction switch and remember it: it takes effect `delay`
   * frames from now, and the planner has to know what is already on its
   * way.
   * @param {number} dir -1, 0, +1
   */
  send(dir) {
    if (dir < 0) this.m.setInput('left', true);
    else if (dir > 0) this.m.setInput('right', true);
    this.sent.copyWithin(1, 0, HISTORY - 1);
    this.sent[0] = dir;
    this.sinceReversal += 1;
    if (dir !== 0) {
      if (this.lastDir !== 0 && dir !== this.lastDir) this.sinceReversal = 0;
      this.lastDir = dir;
      this.sinceLastDir = 0;
    } else this.sinceLastDir += 1;
  }

  /**
   * Press fire, but only at something.
   *
   * A press is two frames held and two released (shorter ones are not
   * reported); the rocket appears on frame `fireDelay` of the press.
   * So a press in progress is a rocket slot already spoken for.
   *
   * @param {import('./threats.js').World} world
   * @param {number} rocketX
   */
  fire(world, rocketX) {
    if (this.fireStep > 0) {
      this.fireStep += 1;
      if (this.fireStep <= FIRE_HOLD) this.m.setInput('fire', true);
      if (this.fireStep >= FIRE_HOLD + FIRE_RELEASE) this.fireStep = 0;
      return;
    }
    if (!world.canFire || world.rocketsFree === 0) return;
    const r = this.reader;
    const k0 = this.fireDelay;
    let shot = chooseShot(rocketX, k0, r.threats, r.threatCount, SHOT_TOLERANCE, this.weights);
    if (shot.index < 0) {
      shot = chooseShot(rocketX, k0, r.targets, r.targetCount, SHOT_TOLERANCE, this.weights);
    }
    if (shot.index < 0) return;
    // Never risk the captured fighter: if the rocket could reach it, the
    // intended target has to be hit clearly first (a rocket stops at its
    // first hit), and even then a near miss must not carry on into it.
    if (world.captive >= 0 && this.endangersCaptive(world, rocketX, k0, shot.frame)) return;
    this.fireStep = 1;
    this.telemetry.shots += 1;
    this.m.setInput('fire', true);
  }

  /**
   * Is a capture wanted? Only as a single fighter with a reserve to take
   * over (the capture costs a fighter: with no reserve it ends the game),
   * with no fighter already held by the enemy or on its way back, and not
   * in a challenging stage (whose aliens never beam).
   * @param {import('./threats.js').World} world
   * @returns {boolean}
   */
  wantsCapture(world) {
    return this.dualFighter && !world.dual && world.ships >= 1 && world.ships < 0x80
      && world.captive < 0 && !world.rescuing && !world.challenge;
  }

  /**
   * Who may be shot. Everything, except:
   *  - our captured fighter, ever (hitting it destroys it for good);
   *  - the boss holding it, unless both are diving: only a hit on a diving
   *    boss whose captive dives along frees the fighter (l_081E, the
   *    status-9 test on object L & 7); shot at home, the boss dies and the
   *    captive turns hostile. When they dive, that boss is the most
   *    valuable target on the screen;
   *  - the capture boss while we want to be captured.
   * @param {import('./threats.js').World} world @param {boolean} wantCapture
   */
  targetWeights(world, wantCapture) {
    const w = this.weights;
    w.fill(1);
    if (wantCapture && world.captureBoss >= 0) w[world.captureBoss & 0x7f] = 0;
    if (world.captive >= 0) {
      w[world.captive] = 0;
      const m = this.m;
      const diving = m.peek(0x8800 + world.holder) === 0x09 && m.peek(0x8800 + world.captive) === 0x09;
      w[world.holder] = diving ? RESCUE_WEIGHT : 0;
    }
  }

  /**
   * Could a rocket fired now reach the captured fighter, other than safely
   * behind the intended target?
   * @param {import('./threats.js').World} world @param {number} rx
   * @param {number} k0 @param {number} targetFrame
   * @returns {boolean}
   */
  endangersCaptive(world, rx, k0, targetFrame) {
    const r = this.reader;
    const lists = [[r.threats, r.threatCount], [r.targets, r.targetCount]];
    for (const [tracks, n] of lists) {
      for (let i = 0; i < n; i += 1) {
        if (tracks[i].obj !== world.captive) continue;
        // A generous window: the captive is lost to a stray rocket.
        const k = rocketHits(rx, k0, tracks[i], CAPTIVE_GUARD);
        if (k >= 0 && k <= targetFrame + 2) return true;
      }
    }
    return false;
  }

  /**
   * Coin up and start. Coin while there is no credit; press start once
   * there is. Pulses, because the 51XX counts presses, not levels.
   * @param {number} credits
   */
  insertCoinAndStart(credits) {
    this.coinPhase = (this.coinPhase + 1) % COIN_CYCLE;
    if (this.coinPhase >= COIN_HOLD) return;
    this.m.setInput(credits === 0 ? 'coin1' : 'start1', true);
  }
}

export default AutoPlayer;
