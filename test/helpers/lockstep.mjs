// Copyright 2026 by Moshix
/**
 * Lock-step: the original ROM on the emulated board and the JavaScript port,
 * stepped frame by frame with identical inputs, compared byte for byte.
 *
 * SAMPLING POINT. The oracle's CPUs run continuously; the port runs a frame
 * as [sound NMI (line 192), vblank IRQs, foreground until it waits, sound
 * NMI (line 64)]. The oracle is in the equivalent state once its vblank
 * handlers have finished -- the sub CPU's can run to about line 103 of the
 * next frame -- and before the next sound NMI at line 192. So oracle frame k
 * is sampled at line FRAME_LINE (160) of frame k+1, and compared with the
 * port after its k-th stepFrame().
 */
import { makeOracle, loadChips, diffRam, loadState } from './oracle.mjs';
import { CYCLES_PER_LINE, CYCLES_PER_FRAME } from '../z80/machine.mjs';
import { Machine } from '../../src/machine/machine.js';
import { Scheduler, FRAME_LINE } from '../../src/game/scheduler.js';
import { IoBus } from '../../src/game/io.js';
import { mainCpu } from '../../src/game/main/index.js';
import { subCpu } from '../../src/game/sub/index.js';
import { soundCpu } from '../../src/game/sound/index.js';
import { Namco51 } from '../../src/machine/namco51.js';

/** Line of the next frame at which the oracle is sampled. */
export const SAMPLE_LINE = FRAME_LINE;

/**
 * @typedef {object} Pair
 * @property {import('../z80/machine.mjs').GalagaBoard} board
 * @property {Machine} m
 * @property {Scheduler} sched
 * @property {Namco51} n51
 * @property {(name: string, down: boolean) => void} press  same switch on both
 * @property {() => string[]} step   one frame on each side; returns the diff
 */

/**
 * Build an oracle and a port, both at power-on.
 * @param {{ irqOrder?: number[], mainSplit?: number, mainLate?: number }} [options]
 * @returns {Promise<Pair>}
 */
export async function makePair(options = {}) {
  const board = makeOracle(await loadChips());
  const m = new Machine();
  const n51 = new Namco51();
  m.io = new IoBus(m, { n51, n54: { write() {} } });
  const sched = new Scheduler(m, { main: mainCpu, sub: subCpu, sound: soundCpu }, {
    irqOrder: options.irqOrder,
    mainSplit: options.mainSplit,
    mainLate: options.mainLate,
    onVblank: () => { n51.setInputs(m.in0, m.in1); n51.vblank(); },
  });
  sched.powerOn();
  // The random number generator ($1000) reads the refresh register R at
  // $1001 and $100D. The port cannot know R, so it replays what the real ROM
  // read, in order. @see Machine.readR
  /** @type {number[]} */
  const rValues = [];
  board.onExec = (n, pc, cpu) => {
    if (n === 0 && (pc === 0x1001 || pc === 0x100d)) rValues.push(cpu.a);
  };
  let rMisses = 0;
  m.readR = () => {
    // After a resync the two sides may disagree about how many times the
    // RNG ran; fall back to the browser's source and count it.
    if (rValues.length === 0) { rMisses += 1; return m.nextR(); }
    return /** @type {number} */ (rValues.shift());
  };
  // The oracle is sampled at line SAMPLE_LINE of the frame after the one
  // being compared; its first sample is therefore one frame plus that in.
  let target = SAMPLE_LINE * CYCLES_PER_LINE;
  board.advanceTo(target);
  const pair = {
    board, m, sched, n51,
    press(name, down) {
      board.setInput(/** @type {never} */ (name), down);
      m.setInput(/** @type {never} */ (name), down);
    },
    step() {
      // Oracle: finish this frame and run into the next up to the sample line.
      target += CYCLES_PER_FRAME;
      board.advanceTo(target);
      sched.stepFrame();
      return diffRam(board, m);
    },
    /**
     * Copy the oracle's RAM into the port and forget queued R
     * values: used after a difference caused by the CPUs racing, so that a
     * long run keeps testing logic rather than compounding one early race.
     */
    resync() {
      // RAM only. The latches follow from the code; copying them could catch
      // the oracle mid-handler with its IRQ enable temporarily clear, and
      // the port would then skip an interrupt it should take.
      loadState(m, board);
      rValues.length = 0;
    },
    get rMisses() { return rMisses; },
  };
  return pair;
}
