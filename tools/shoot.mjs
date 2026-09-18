// Copyright 2026 by Moshix
/**
 * Screenshot the ORIGINAL ROM, running on the emulated board, through the
 * port's own renderer.
 *
 *   node tools/shoot.mjs out.png FRAMES [coin@F] [start@F] [scale=2]
 *
 * e.g. `node tools/shoot.mjs /tmp/a.png 1500 coin@1200 start@1300` boots the
 * real machine code, inserts a coin at frame 1200, presses start at 1300 and
 * saves frame 1500. The renderer only reads video memory, so if these
 * screenshots look like Galaga the renderer is right; and if the port's
 * (tools/shoot-port.mjs) differ from them, the port is wrong.
 */
import { writeFileSync } from 'node:fs';
import { makeOracle, loadChips } from '../test/helpers/oracle.mjs';
import { Renderer, SCREEN_WIDTH, SCREEN_HEIGHT } from '../src/video/renderer.js';
import { encodePng } from './png.mjs';

const [out = 'shot.png', framesArg = '1200', ...rest] = process.argv.slice(2);
const frames = Number(framesArg);
/** @type {Map<number, string[]>} input events by frame */
const events = new Map();
let scale = 2;
for (const arg of rest) {
  const m = arg.match(/^(\w+)@(\d+)$/);
  if (m) {
    const at = Number(m[2]);
    (events.get(at) ?? events.set(at, []).get(at)).push(m[1]);
  } else if (arg.startsWith('scale=')) scale = Number(arg.slice(6));
}

const board = makeOracle(await loadChips());
const renderer = new Renderer();
/** Frames each tapped input is held down. */
const HOLD = 4;
const releases = new Map();
for (let f = 0; f < frames; f += 1) {
  for (const name of events.get(f) ?? []) {
    const input = name === 'coin' ? 'coin1' : name === 'start' ? 'start1' : name;
    board.setInput(input, true);
    releases.set(f + HOLD, [...(releases.get(f + HOLD) ?? []), input]);
  }
  for (const name of releases.get(f) ?? []) board.setInput(name, false);
  board.runFrame();
  // Render every frame so the starfield generator advances as on the board.
  renderer.render(board.video, board.ram1, board.ram2, board.ram3, board.videoLatch);
}
writeFileSync(out, encodePng(renderer.pixels, SCREEN_WIDTH, SCREEN_HEIGHT, scale));
console.log(`${out}: frame ${frames}, main pc=$${board.cpus[0].pc.toString(16)}`);
