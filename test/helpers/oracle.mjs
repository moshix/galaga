// Copyright 2026 by Moshix
/**
 * Helpers for testing the port against the original ROM running on the
 * emulated board (test/z80/machine.mjs).
 *
 *   makeOracle()                 a GalagaBoard loaded with the real ROMs
 *   callRoutine(board, cpu, ...) run ONE ROM subroutine in isolation
 *   loadState(dst, src)          copy all shared RAM from one board to another
 *   diffRam(a, b)                byte differences, named from the disassembly
 *
 * The typical routine test: build an oracle and a port Machine, put the same
 * RAM contents in both (loadState), call the ROM routine on the oracle and the
 * JS function on the port with the same inputs, and assert diffRam() is empty.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { GalagaBoard } from '../z80/machine.mjs';
import { loadGalaga, ROOT } from '../../tools/romset.mjs';

/** Loaded once: the ROMs never change during a test run. */
let ROMS = null;
const roms = () => (ROMS ??= loadGalaga());

/**
 * The MB88-based 51XX/54XX, when test/mcu/ provides them; the board runs
 * without (a dead bus) otherwise, which is enough for routine-level tests.
 * @returns {Promise<{ mcu51?: object, mcu54?: object }>}
 */
export async function loadChips() {
  const r = roms();
  /** The board the input callbacks read; bound by makeOracle. */
  let board = null;
  const in0 = () => (board ? board.in0 : 0xff);
  const in1 = () => (board ? board.in1 : 0xff);
  const chips = { bind(b) { board = b; } };
  if (existsSync(join(ROOT, 'test/mcu/namco51.mjs'))) {
    const { Namco51 } = await import('../mcu/namco51.mjs');
    // MAME wiring: R0 = IN0 low nibble, R1 = IN0 high, R2 = IN1 low, R3 = IN1 high.
    chips.mcu51 = new Namco51({
      rom: r.mcu51,
      in: [() => in0() & 0x0f, () => in0() >> 4, () => in1() & 0x0f, () => in1() >> 4],
    });
  }
  if (existsSync(join(ROOT, 'test/mcu/namco54.mjs'))) {
    const { Namco54 } = await import('../mcu/namco54.mjs');
    chips.mcu54 = new Namco54({ rom: r.mcu54 });
  }
  return chips;
}

/**
 * A board with the real ROMs.
 * @param {{ mcu51?: object, mcu54?: object }} [chips]
 * @returns {GalagaBoard}
 */
export function makeOracle(chips = {}) {
  const board = new GalagaBoard(roms(), /** @type {never} */ (chips));
  /** @type {{ bind?: (b: GalagaBoard) => void }} */ (chips).bind?.(board);
  return board;
}

/** Where callRoutine parks the return address; never a real routine. */
const SENTINEL = 0x3fff;
/** A stack inside the main CPU's own stack area, excluded from diffs. */
const TEST_STACK = 0x90a0;

/**
 * Call one subroutine of the original ROM on one CPU, with interrupts off and
 * the other CPUs frozen, and run it until it returns.
 *
 * @param {GalagaBoard} board
 * @param {0|1|2} cpu            0 main, 1 sub, 2 sound
 * @param {number} addr          routine entry point (rev. B address)
 * @param {Partial<import('../z80/z80.mjs').RegisterSet>} [regs]  input registers
 * @param {{ maxCycles?: number, stack?: number }} [options]
 * @returns {import('../z80/z80.mjs').RegisterSet & { cycles: number }} registers at return
 */
export function callRoutine(board, cpu, addr, regs = {}, options = {}) {
  const z = board.cpus[cpu];
  const maxCycles = options.maxCycles ?? 5_000_000;
  z.setRegisters({ ...regs, pc: addr, sp: options.stack ?? TEST_STACK, iff1: 0, iff2: 0 });
  z.push16(SENTINEL);
  const startSp = z.sp + 2;
  let cycles = 0;
  while (!(z.pc === SENTINEL && z.sp === startSp)) {
    cycles += z.step();
    if (cycles > maxCycles) throw new Error(`routine $${addr.toString(16)} did not return within ${maxCycles} cycles (pc=$${z.pc.toString(16)})`);
  }
  return { ...z.getRegisters(), cycles };
}

/** Shared RAM regions compared between oracle and port. */
export const RAM_REGIONS = Object.freeze([
  { name: 'video', base: 0x8000, key: 'video' },
  { name: 'ram1', base: 0x8800, key: 'ram1' },
  { name: 'ram2', base: 0x9000, key: 'ram2' },
  { name: 'ram3', base: 0x9800, key: 'ram3' },
]);

/**
 * Z80 stacks live in shared RAM: meaningless for the port, which has none.
 * $9030-$90FF: main ($90A0 down) and sub ($9100 down); $9AE0-$9AFF: sound.
 */
export const STACK_RANGES = Object.freeze([[0x9030, 0x9100], [0x9ae0, 0x9b00]]);

/**
 * @typedef {{ video: Uint8Array, ram1: Uint8Array, ram2: Uint8Array, ram3: Uint8Array }} RamOwner
 */

/**
 * Copy all shared RAM from `src` into `dst` (either may be board or port).
 * @param {RamOwner} dst @param {RamOwner} src
 */
export function loadState(dst, src) {
  for (const r of RAM_REGIONS) dst[r.key].set(src[r.key]);
}

let NAMES = null;
/** Sorted [addr, name] for RAM labels from reference/symbols.json. */
function names() {
  if (NAMES) return NAMES;
  const sym = JSON.parse(readFileSync(join(ROOT, 'reference/symbols.json'), 'utf8'));
  NAMES = Object.entries(sym.ram).map(([n, v]) => [v.addr, n]).sort((a, b) => a[0] - b[0]);
  return NAMES;
}

/**
 * Nearest label at or below an address, e.g. "ds_plyr_actv+$05".
 * @param {number} addr @returns {string}
 */
export function nameOf(addr) {
  const list = names();
  let best = null;
  for (const [a, n] of list) { if (a <= addr) best = [a, n]; else break; }
  if (best === null || addr - best[0] > 0xff) return `$${addr.toString(16).toUpperCase()}`;
  const off = addr - best[0];
  return off ? `${best[1]}+$${off.toString(16).toUpperCase()}` : best[1];
}

/**
 * Byte-level differences between two RAM owners, stacks excluded.
 * @param {RamOwner} expected usually the oracle
 * @param {RamOwner} actual   usually the port
 * @param {{ limit?: number, ignore?: [number, number][] }} [options]
 * @returns {string[]} one line per differing byte, e.g.
 *   "$9201 b8_9201_game_state oracle=$01 port=$03"
 */
export function diffRam(expected, actual, options = {}) {
  const limit = options.limit ?? 40;
  const ignore = [...STACK_RANGES, ...(options.ignore ?? [])];
  const out = [];
  for (const r of RAM_REGIONS) {
    const e = expected[r.key];
    const a = actual[r.key];
    for (let i = 0; i < e.length; i += 1) {
      const addr = r.base + i;
      if (e[i] === a[i]) continue;
      if (ignore.some(([lo, hi]) => addr >= lo && addr < hi)) continue;
      out.push(`$${addr.toString(16).toUpperCase()} ${nameOf(addr)} oracle=$${hex(e[i])} port=$${hex(a[i])}`);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** @param {number} v */
const hex = (v) => v.toString(16).toUpperCase().padStart(2, '0');
