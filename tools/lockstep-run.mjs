// Copyright 2026 by Moshix
/**
 * Run the real ROM and the port side by side from power-on and report where
 * they first disagree -- the diagnosis tool behind test/oracle/lockstep.
 *
 *   node tools/lockstep-run.mjs FRAMES [coin@F] [start@F] [left@F-G] ...
 *                               [--order=sub,main] [--show=N] [--resync]
 *                               [--play=SEED]
 *
 * --play inserts a coin at frame 1500, starts at 1600, then plays with a
 * seeded pseudo-random joystick and fire button (same inputs on both sides).
 *
 * --resync copies the ROM's RAM into the port after every differing frame
 * and reports how long each difference lasted: races between the CPUs show
 * up as isolated one-frame blips, logic bugs as differences that come back
 * immediately after every resync.
 */
import { makePair } from '../test/helpers/lockstep.mjs';

const args = process.argv.slice(2);
const frames = Number(args[0] ?? 2000);
const order = (args.find((a) => a.startsWith('--order=')) ?? '--order=sub,main')
  .slice(8).split(',').map((n) => (n === 'main' ? 0 : 1));
const show = Number((args.find((a) => a.startsWith('--show=')) ?? '--show=12').slice(7));
/** name -> list of [from, to] frame ranges held down */
const holds = [];
for (const a of args) {
  const m = a.match(/^(\w+)@(\d+)(?:-(\d+))?$/);
  if (!m) continue;
  const name = m[1] === 'coin' ? 'coin1' : m[1] === 'start' ? 'start1' : m[1];
  const from = Number(m[2]);
  holds.push([name, from, m[3] ? Number(m[3]) : from + 4]);
}

const splitArg = args.find((a) => a.startsWith('--split='));
const lateArg = args.find((a) => a.startsWith('--late='));
const resync = args.includes('--resync');
let run = 0;
/** lengths of consecutive differing runs */
const runs = [];
const playArg = args.find((a) => a.startsWith('--play'));
let seed = playArg ? Number(playArg.split('=')[1] ?? 1) || 1 : 0;
/** Small LCG so a run is reproducible from its seed. */
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 16) / 65536; };
if (playArg) holds.push(['coin1', 1500, 1504], ['start1', 1600, 1604]);
let stick = 0;
const pair = await makePair({ irqOrder: order, mainSplit: splitArg ? Number(splitArg.slice(8)) : undefined,
  mainLate: lateArg ? Number(lateArg.slice(7)) : undefined });
let bad = 0;
for (let f = 0; f < frames; f += 1) {
  for (const [name, from, to] of holds) {
    if (f === from) pair.press(name, true);
    if (f === to) pair.press(name, false);
  }
  if (playArg && f > 1700) {
    // Change direction now and then; tap fire often, as a player would.
    if (f % 12 === 0) {
      const r = rand();
      const next = r < 0.35 ? -1 : r < 0.7 ? 1 : 0;
      if (next !== stick) {
        pair.press('left', next === -1);
        pair.press('right', next === 1);
        stick = next;
      }
    }
    pair.press('fire', (f % 16) < 3 && rand() < 0.8);
  }
  let diff;
  try { diff = pair.step(); } catch (e) {
    console.log(`frame ${f}: port threw: ${e.stack.split('\n').slice(0, 4).join(' | ')}`);
    process.exit(1);
  }
  if (diff.length) {
    bad += 1;
    run += 1;
    if (bad <= show) console.log(`frame ${f}: ${diff.length} diffs\n  ${diff.slice(0, 8).join('\n  ')}`);
    // Resync only on a difference that persists: a one- or two-frame blip
    // is usually the oracle sampled mid-handler, and copying half-finished
    // RAM into the port would do harm, not good.
    if (resync && run >= 3) pair.resync();
  } else if (run > 0) { runs.push(run); run = 0; }
}
if (resync) {
  const long = runs.filter((r) => r > 1).length;
  console.log(`differing runs: ${runs.length}, longer than 1 frame: ${long}, max ${Math.max(0, ...runs)}; R fallbacks ${pair.rMisses}`);
}
console.log(`${frames} frames, ${bad} with differences`);
