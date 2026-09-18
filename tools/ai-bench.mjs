// Copyright 2026 by Moshix
/**
 * Measure how well the self-playing AI actually plays.
 *
 * The AI inserts a coin and presses start whenever no game is running, so a
 * benchmark is just a machine, the AI and a frame loop -- no browser. By
 * default the machine is the ORACLE: the original ROM on the emulated
 * three-Z80 board (test/z80/machine.mjs), so the numbers are the real game's,
 * not a port's. `--target=port` runs the JavaScript port instead, assembled
 * the way src/main.js assembles it; if the port cannot run a game yet, that
 * is reported instead of a number.
 *
 * WHERE THE VARIETY COMES FROM. The board is deterministic: the same inputs
 * from power-on replay the same game. Galaga's random numbers mix in the
 * Z80's refresh register, which counts instructions, so letting attract mode
 * run a different number of frames before the coin goes in changes every
 * random draw of the game that follows. Run n always waits the same number
 * of frames, so run n is always the same game: reproducible, and a real
 * difference in starting conditions rather than a fake one.
 *
 * Usage:
 *   node tools/ai-bench.mjs                    10 games on the oracle
 *   node tools/ai-bench.mjs --runs=20 --verbose
 *   node tools/ai-bench.mjs --cap=200000       frame cap per game
 *   node tools/ai-bench.mjs --target=port
 *   node tools/ai-bench.mjs --json
 *   node tools/ai-bench.mjs --fixed-delay=2     don't measure the input latency
 */

import { AutoPlayer } from '../src/ai/autoplay.js';

/** Frames per second of the real board: 18.432 MHz / 3 / (384 * 264). */
const FPS = 18432000 / 3 / (384 * 264);
/** Give up on a game after this many frames; ~27 minutes. */
const DEFAULT_FRAME_CAP = 100000;
/** Attract mode before the first coin; the ROM boots into it by ~1100. */
const PRE_ROLL_BASE = 1200;
/** Extra attract frames per run; coprime with the obvious periods. */
const PRE_ROLL_STEP = 37;

/**
 * @typedef {object} Target
 * @property {(addr: number) => number} peek
 * @property {(name: string, down: boolean) => void} setInput
 * @property {() => void} runFrame
 */

/**
 * The original ROM on the emulated board.
 * @returns {Promise<Target>}
 */
async function makeOracleTarget() {
  const { makeOracle, loadChips } = await import('../test/helpers/oracle.mjs');
  const board = makeOracle(await loadChips());
  return {
    peek: (a) => board.peek(a),
    setInput: (n, d) => board.setInput(/** @type {never} */ (n), d),
    runFrame: () => { board.runFrame(); },
  };
}

/**
 * The JavaScript port, assembled as src/main.js does (minus video/sound).
 * @returns {Promise<Target>}
 */
async function makePortTarget() {
  const { Machine } = await import('../src/machine/machine.js');
  const { Scheduler } = await import('../src/game/scheduler.js');
  const { IoBus } = await import('../src/game/io.js');
  const { mainCpu } = await import('../src/game/main/index.js');
  const { subCpu } = await import('../src/game/sub/index.js');
  const { soundCpu } = await import('../src/game/sound/index.js');
  const { Namco51 } = await import('../src/machine/namco51.js');
  const m = new Machine();
  const n51 = new Namco51();
  m.io = new IoBus(m, { n51, n54: { write() {} } });
  const sched = new Scheduler(m, { main: mainCpu, sub: subCpu, sound: soundCpu }, {
    onVblank: () => { n51.setInputs(m.in0, m.in1); n51.vblank(); },
  });
  sched.powerOn();
  return {
    peek: (a) => m.peek(a),
    setInput: (n, d) => m.setInput(/** @type {never} */ (n), d),
    runFrame: () => { sched.stepFrame(); },
  };
}

/**
 * Player 1's score, from the digits on screen: the game keeps no binary
 * copy. Tile RAM $83F8 is the ones digit (always 0) up to $83FE; a blank
 * ($24) counts as 0 (galaga-main.asm gctl_supv_score).
 * @param {(addr: number) => number} peek @returns {number}
 */
export function readScore(peek) {
  let score = 0;
  for (let i = 6; i >= 0; i -= 1) {
    const d = peek(0x83f8 + i);
    score = score * 10 + (d < 10 ? d : 0);
  }
  return score;
}

/**
 * @typedef {object} GameResult
 * @property {number} frames   frames from the first playable fighter to the end
 * @property {number} stage    highest stage reached
 * @property {number} score
 * @property {number} deaths   fighters lost (including captures)
 * @property {number} captures fighters taken by the tractor beam
 * @property {number[]} deathFrames
 * @property {boolean} capped  stopped by the frame cap, not by game over
 * @property {number} aiMs     mean AI time per frame, milliseconds
 * @property {number} moveFrames frames the fighter was under control
 * @property {number} reversals  times the fighter's movement changed from
 *                               left to right or back
 * @property {number} jitters    reversals within JITTER_FRAMES of the
 *                               previous one: the back-and-forth shake
 */

/**
 * A reversal this soon after the previous one is a shake, not a decision:
 * a human sees the fighter twitch.
 */
const JITTER_FRAMES = 6;

/**
 * Play one game to its end.
 * @param {Target} t
 * @param {number} preRoll attract frames before the AI takes over
 * @param {number} frameCap
 * @param {(t: Target, frame: number, event: string) => void} [onEvent]
 * @param {{delay?: number}} [aiOptions] passed to the AutoPlayer
 * @returns {GameResult}
 */
export function playOneGame(t, preRoll, frameCap, onEvent, aiOptions = {}) {
  for (let i = 0; i < preRoll; i += 1) t.runFrame();
  const ai = new AutoPlayer(t, aiOptions);
  let frames = 0;
  let started = false;
  let stage = 0;
  let ships = -1;
  let deaths = 0;
  let captures = 0;
  let wasCapturing = false;
  let wasLive = false;
  const deathFrames = [];
  let capped = true;
  let aiTime = 0;
  let aiFrames = 0;
  // Movement bookkeeping for the jitter metric.
  let lastX = -1;
  let lastDir = 0;
  let lastReversal = -Infinity;
  let moveFrames = 0;
  let reversals = 0;
  let jitters = 0;

  // Generous bound on the time to coin up and start.
  for (let i = 0; i < frameCap + 2000; i += 1) {
    const t0 = performance.now();
    ai.step();
    aiTime += performance.now() - t0;
    aiFrames += 1;
    t.runFrame();

    const state = t.peek(0x9201);
    if (state === 3) started = true;
    else if (started) { capped = false; break; }
    if (!started) continue;
    frames += 1;
    if (frames > frameCap) break;

    // $9821 holds junk until the game initialises it; trust it once a
    // fighter is in play.
    if (t.peek(0x9014) !== 0) stage = Math.max(stage, t.peek(0x9821));
    // Reserve ships only fall on a loss (the last one wraps to $FF); a
    // bonus ship raises them, which is not a negative death.
    const s = t.peek(0x9820);
    if (ships >= 0 && s === ((ships - 1) & 0xff)) {
      deaths += 1;
      deathFrames.push(frames);
    }
    ships = s;
    // A capture: task f_20F2 ($901C) pulls the fighter up to the boss.
    const capturing = t.peek(0x901c) !== 0;
    if (capturing && !wasCapturing) {
      captures += 1;
      onEvent?.(t, frames, 'capture');
    }
    wasCapturing = capturing;
    // The fighter's collision task stops the frame it is hit.
    const live = t.peek(0x9014) !== 0;
    // Jitter: count changes of the fighter's direction of travel. Frames
    // standing still in between do not reset the direction, so left, stop,
    // right is a reversal too.
    if (live) {
      const x = t.peek(0x9362);
      moveFrames += 1;
      if (lastX >= 0 && x !== lastX) {
        const dir = Math.sign(x - lastX);
        if (lastDir !== 0 && dir !== lastDir) {
          reversals += 1;
          if (frames - lastReversal < JITTER_FRAMES) jitters += 1;
          lastReversal = frames;
        }
        lastDir = dir;
      }
      lastX = x;
    } else {
      lastX = -1;
      lastDir = 0;
    }
    if (wasLive && !live && !capturing) onEvent?.(t, frames, 'hit');
    wasLive = live;
  }
  return {
    frames, stage, score: readScore(t.peek), deaths, captures, deathFrames, capped,
    aiMs: aiTime / Math.max(1, aiFrames), moveFrames, reversals, jitters,
  };
}

/** @param {number[]} v @returns {number} */
function median(v) {
  const s = [...v].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** @param {number[]} v @returns {number} */
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;

/** @param {string[]} argv @param {string} name @param {string} fallback */
function option(argv, name, fallback) {
  for (const a of argv) {
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
}

async function main() {
  const argv = process.argv.slice(2);
  const runs = Number.parseInt(option(argv, 'runs', '10'), 10);
  const frameCap = Number.parseInt(option(argv, 'cap', String(DEFAULT_FRAME_CAP)), 10);
  const first = Number.parseInt(option(argv, 'first', '0'), 10);
  const target = option(argv, 'target', 'oracle');
  const verbose = argv.includes('--verbose');
  // Debugging aid: fix the AI's input latency instead of letting it measure.
  const fixedDelay = option(argv, 'fixed-delay', '');
  const aiOptions = fixedDelay === '' ? {} : { delay: Number.parseInt(fixedDelay, 10) };
  const asJson = argv.includes('--json');
  if (!Number.isFinite(runs) || runs < 1) {
    console.error('--runs needs a positive integer');
    process.exitCode = 1;
    return;
  }
  if (target !== 'oracle' && target !== 'port') {
    console.error('--target is oracle or port');
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (let i = first; i < first + runs; i += 1) {
    const preRoll = PRE_ROLL_BASE + i * PRE_ROLL_STEP;
    const started = Date.now();
    let result;
    try {
      const t = target === 'oracle' ? await makeOracleTarget() : await makePortTarget();
      result = playOneGame(t, preRoll, frameCap, undefined, aiOptions);
    } catch (err) {
      console.error(`run ${i}: the ${target} failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    results.push({ run: i, preRoll, ms: Date.now() - started, ...result });
    if (verbose && !asJson) {
      const r = results[results.length - 1];
      console.log(`  run ${String(r.run).padStart(3)}  frames ${String(r.frames).padStart(7)}`
        + `  stage ${String(r.stage).padStart(3)}  score ${String(r.score).padStart(7)}`
        + `  deaths ${r.deaths} (capt ${r.captures})  at ${r.deathFrames.join(',')}`
        + `  rev/1k ${(1000 * r.reversals / Math.max(1, r.moveFrames)).toFixed(1)}`
        + ` (jitter ${(1000 * r.jitters / Math.max(1, r.moveFrames)).toFixed(1)})`
        + `${r.capped ? '  [cap]' : ''}  ${(r.ms / 1000).toFixed(0)}s  ai ${r.aiMs.toFixed(3)}ms`);
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ target, runs, frameCap, results }, null, 2));
    return;
  }
  const frames = results.map((r) => r.frames);
  const fmt = (n) => (Math.round(n * 10) / 10).toString();
  console.log(`AI benchmark: ${runs} games on the ${target}, cap ${frameCap} frames`);
  console.log(`  frames survived  median ${fmt(median(frames))}  mean ${fmt(mean(frames))}`
    + `  worst ${Math.min(...frames)}  best ${Math.max(...frames)}`);
  console.log(`  time alive       median ${fmt(median(frames) / FPS)} s`);
  console.log(`  stage reached    median ${fmt(median(results.map((r) => r.stage)))}`
    + `  best ${Math.max(...results.map((r) => r.stage))}`);
  console.log(`  score            median ${fmt(median(results.map((r) => r.score)))}`
    + `  best ${Math.max(...results.map((r) => r.score))}`);
  console.log(`  deaths per game  mean ${fmt(mean(results.map((r) => r.deaths)))}`
    + `  (captures ${fmt(mean(results.map((r) => r.captures)))})`);
  const moved = results.reduce((a, r) => a + r.moveFrames, 0);
  const perK = (n) => (1000 * n / Math.max(1, moved)).toFixed(1);
  console.log(`  reversals        ${perK(results.reduce((a, r) => a + r.reversals, 0))} per 1000 frames`
    + `, ${perK(results.reduce((a, r) => a + r.jitters, 0))} within ${JITTER_FRAMES} frames of the last`);
  console.log(`  AI cost          ${mean(results.map((r) => r.aiMs)).toFixed(3)} ms/frame`);
  const capped = results.filter((r) => r.capped).length;
  if (capped > 0) console.log(`  ${capped} game(s) hit the frame cap`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
