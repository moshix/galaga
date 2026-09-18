// Copyright 2026 by Moshix
/**
 * The sound CPU port against real request traffic: the full oracle board
 * (three Z80s, 51XX, 54XX) boots the ROM, runs attract mode, takes a coin
 * and plays a game with nobody at the controls. At the instant of every
 * sound NMI the whole shared RAM is snapshotted; that state is then run
 * through the ROM's NMI handler on a separate sound-only oracle and through
 * the port, and the results must be identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeOracle, loadChips, callRoutine, diffRam, loadState,
} from '../helpers/oracle.mjs';
import { CYCLES_PER_LINE } from '../z80/machine.mjs';
import { Machine } from '../../src/machine/machine.js';
import '../../src/game/sound/index.js';
import { SOUND } from '../../src/game/sound/routines.js';

const FRAMES = 5000;
const NMI_CYCLES = [64 * CYCLES_PER_LINE, 192 * CYCLES_PER_LINE];

test(`every sound NMI of ${FRAMES} frames of real play matches the ROM`, async () => {
  const board = makeOracle(await loadChips());
  const solo = makeOracle();
  const m = new Machine();
  let nmis = 0;
  let voiced = 0;
  /** @type {Set<number>} */
  const slots = new Set();

  /**
   * Called by runFrame between slices. The slice that ends on a sound NMI
   * line returns to runFrame, which then raises the NMI: snapshot here.
   * @param {ReturnType<typeof makeOracle>} b
   */
  const observe = (b) => {
    const t = b.now - b.frameStart;
    if (!NMI_CYCLES.includes(t) || !b.soundNmiMask || b.inReset[2]) return false;
    loadState(solo, b);
    loadState(m, b);
    solo.wsg.set(b.wsg);
    m.wsg.set(b.wsg);
    for (let a = 0x9aa0; a <= 0x9ab6; a += 1) if (b.peek(a)) slots.add(a);
    callRoutine(solo, 2, 0x0066);
    SOUND.sound_nmi(m);
    nmis += 1;
    assert.deepEqual(diffRam(solo, m), [], `frame ${b.frames} line ${t / CYCLES_PER_LINE}`);
    assert.deepEqual([...m.wsg], [...solo.wsg], `frame ${b.frames}: WSG`);
    if (m.wsg[0x15] || m.wsg[0x1a] || m.wsg[0x1f]) voiced += 1;
    return false;
  };

  for (let f = 0; f < FRAMES; f += 1) {
    // Coin, then start, once attract mode is running.
    if (f === 1500) board.setInput('coin1', true);
    if (f === 1510) board.setInput('coin1', false);
    if (f === 1700) board.setInput('start1', true);
    if (f === 1710) board.setInput('start1', false);
    board.runFrame(observe);
  }
  // The run must actually have exercised the sound code.
  assert.ok(nmis > FRAMES, `${nmis} NMIs`);
  assert.ok(voiced > 500, `${voiced} NMIs with a voice on`);
  assert.ok(slots.size >= 6, `slots requested: ${[...slots].map((a) => a.toString(16))}`);
});
