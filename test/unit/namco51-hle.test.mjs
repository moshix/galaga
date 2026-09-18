// Copyright 2026 by Moshix
/**
 * Differential test: the 51XX HLE (src/machine/namco51.js) against the LLE
 * (the real 51xx.bin on the MB88 core, test/mcu/).
 *
 * Both are wired to the same pins by test/mcu/session51.mjs: the LLE sees
 * the 06XX strobes and vblank edges with real Galaga timing, the HLE gets
 * the same events, in the same order, through its documented call protocol.
 * A pseudo-random but seeded player then plays for hundreds of frames --
 * coins (including 1-frame blips too short to count), service, starts,
 * joysticks, fire, the test switch -- while the "main CPU" reads 3 bytes
 * every frame and now and then sends Galaga's other commands: game over
 * ($61: 02 02 02), a coinage/credit-mode re-send ($E1 + $B1, timed both so
 * a vblank falls between the bytes and so it falls INSIDE the coinage
 * argument loop), and switch mode ($A1: 05 05 05 05).
 *
 * Checked every frame: the 3 bytes read, every P port write (lamps, coin
 * counters), the timer, and the chip's whole RAM except the interrupt
 * handler's register-save scratch nibbles ($00, $01, $04).
 *
 * Timing cases where the HLE cannot be exact are listed in the header of
 * src/machine/namco51.js (strobes inside the chip's ~2900 Z80-cycle frame
 * window or closer than its handler time). The schedule below respects
 * Galaga's own timing, so none of them occurs here; the LLE tests in
 * mb88.test.mjs demonstrate the lost-strobe case separately.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session51 } from '../mcu/session51.mjs';
import { Namco51, RAM } from '../../src/machine/namco51.js';
import { loadGalaga } from '../../tools/romset.mjs';

const roms = loadGalaga();

/** RAM nibbles that only hold the interrupt handler's saved registers. */
const SCRATCH = new Set([0x00, 0x01, 0x04]);

/**
 * Small deterministic PRNG (mulberry32).
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Galaga's coinage argument table (main ROM $3A76) plus free play. */
const COINAGES = [
  [4, 1, 4, 1], [3, 1, 3, 1], [2, 1, 2, 1], [2, 3, 2, 3],
  [1, 3, 1, 3], [1, 2, 1, 2], [1, 1, 1, 1], [0, 0, 0, 0],
];

/**
 * A button that, once pressed, stays down for a random number of frames.
 */
class Held {
  /**
   * @param {() => number} rnd
   * @param {number} chance  per-frame probability of a press
   * @param {number} maxLen  longest hold in frames
   */
  constructor(rnd, chance, maxLen) {
    this.rnd = rnd;
    this.chance = chance;
    this.maxLen = maxLen;
    this.left = 0;
  }

  /** @returns {boolean} pressed this frame */
  tick() {
    if (this.left > 0) this.left -= 1;
    else if (this.rnd() < this.chance) this.left = 1 + Math.floor(this.rnd() * this.maxLen);
    return this.left > 0;
  }
}

/**
 * Play `frameCount` frames with seed `seed` and compare HLE to LLE.
 * @param {number} seed
 * @param {number} frameCount
 * @returns {{reads: number, commands: string[], credits: Set<number>, modes: Set<number>}}
 */
function play(seed, frameCount) {
  const rnd = prng(seed);
  const hle = new Namco51({ onOutput: (p) => session.hleP.push(p) });
  const session = new Session51({ rom: roms.mcu51, hle });
  const lle = session.lle.mcu;
  const commands = [];
  const credits = new Set();
  const modes = new Set();
  let reads = 0;

  /** @param {string} where */
  const compareState = (where) => {
    for (let a = 0; a < 64; a += 1) {
      if (SCRATCH.has(a)) continue;
      assert.equal(hle.ram[a], lle.ram[a], `${where}: RAM $${a.toString(16)}`);
    }
    assert.equal(hle.tl, lle.tl, `${where}: TL`);
    assert.equal(hle.th, lle.th, `${where}: TH`);
    assert.deepEqual(session.hleP, session.lleP, `${where}: P port writes`);
  };

  session.boot(); // (boot() already lets the init code run to completion)
  compareState('after reset');
  const b1 = session.galagaStartup(COINAGES[Math.floor(rnd() * COINAGES.length)]);
  assert.deepEqual(b1.hle, b1.lle, 'startup B1 read');

  const coin1 = new Held(rnd, 0.03, 5);
  const coin2 = new Held(rnd, 0.015, 5);
  const service = new Held(rnd, 0.006, 4);
  const start1 = new Held(rnd, 0.03, 6);
  const start2 = new Held(rnd, 0.02, 6);
  const test = new Held(rnd, 0.002, 20);
  let fire1 = false;
  let fire2 = false;
  let stick1 = 0;
  let stick2 = 0;
  let junk = 0;

  for (let f = 0; f < frameCount; f += 1) {
    // Inputs for the coming frame (active low).
    if (rnd() < 0.2) fire1 = !fire1;
    if (rnd() < 0.2) fire2 = !fire2;
    if (rnd() < 0.1) stick1 = [0, 0x02, 0x08, 0x0a][Math.floor(rnd() * 4)];
    if (rnd() < 0.1) stick2 = [0, 0x20, 0x80, 0xa0][Math.floor(rnd() * 4)];
    if (rnd() < 0.05) junk = Math.floor(rnd() * 256) & 0x55; // unused IN0 bits
    let in1 = 0;
    if (fire1) in1 |= 0x01;
    if (fire2) in1 |= 0x02;
    if (start1.tick()) in1 |= 0x04;
    if (start2.tick()) in1 |= 0x08;
    if (coin1.tick()) in1 |= 0x10;
    if (coin2.tick()) in1 |= 0x20;
    if (service.tick()) in1 |= 0x40;
    if (test.tick()) in1 |= 0x80;
    session.in0 = ~(stick1 | stick2 | junk) & 0xff;
    session.in1 = ~in1 & 0xff;

    // The per-frame read from Galaga's vblank handler.
    session.waitFrameOffset(6000);
    const r = session.read3();
    assert.deepEqual(r.hle, r.lle, `seed ${seed} frame ${f}: bytes read`);
    reads += 1;
    credits.add(r.lle[0]);
    modes.add(lle.ram[RAM.MODE]);
    // Let the chip finish handling the transfer's last strobe (~400 Z80
    // cycles); the HLE did it instantly.
    session.bus.advanceTo(session.bus.now + 1000);
    compareState(`seed ${seed} frame ${f}`);

    // Occasionally, one of Galaga's other conversations.
    const roll = rnd();
    if (roll < 0.012) {
      commands.push('61');
      session.waitFrameOffset(15000);
      session.write(0x61, [2, 2, 2]);
    } else if (roll < 0.018) {
      // Coinage re-send. At offset 9000 a vblank falls between the 02 and
      // 03 bytes; at 30000 it falls inside the coinage argument loop and
      // the chip's frame work is deferred until the 4th argument.
      const offset = rnd() < 0.5 ? 9000 : 30000;
      const coinage = COINAGES[Math.floor(rnd() * COINAGES.length)];
      const remap = rnd() < 0.3 ? 4 : 3;
      commands.push(`E1@${offset}`);
      session.waitFrameOffset(offset);
      session.write(0xe1, [1, ...coinage, 2, remap, 0]);
      session.bus.advanceTo(session.bus.now + 144);
      const b = session.read3(0xb1);
      assert.deepEqual(b.hle, b.lle, `seed ${seed} frame ${f}: B1 read`);
    } else if (roll < 0.021) {
      commands.push('A1');
      session.waitFrameOffset(15000);
      session.write(0xa1, [5, 5, 5, 5]);
    }
  }
  return { reads, commands, credits, modes };
}

test('HLE matches LLE byte for byte over randomized Galaga sessions', () => {
  for (const seed of [1, 2, 3, 7, 42, 1981]) {
    const { reads, commands, credits, modes } = play(seed, 1000);
    assert.equal(reads, 1000);
    // Make sure the run actually exercised the interesting paths.
    assert.ok(commands.length > 0, `seed ${seed}: some commands were sent`);
    assert.ok(credits.size > 3, `seed ${seed}: credits varied (${[...credits].map((c) => c.toString(16))})`);
    assert.ok(modes.has(0) && modes.has(2), `seed ${seed}: saw credit and game mode`);
  }
});

test('HLE alone: the documented call protocol', () => {
  const hle = new Namco51();
  hle.reset();
  // Galaga start-up: switch mode, then coinage 1/1 1/1, credit mode, no remap.
  for (const b of [5, 5, 5, 5]) hle.write(b);
  for (const b of [1, 1, 1, 1, 1, 2, 3, 0]) hle.write(b);
  hle.setInputs(0xff, 0xff);
  hle.vblank();
  const readFrame = () => { hle.beginRead(); return [hle.read(), hle.read(), hle.read()]; };
  assert.deepEqual(readFrame(), [0x00, 0xff, 0xff]);
  // Coin: needs 2 frames high then 2 low.
  hle.vblank();
  hle.setInputs(0xff, 0xef);
  hle.vblank();
  hle.vblank();
  assert.deepEqual(readFrame(), [0x01, 0xff, 0xff]);
  // Reads can repeat any number of times: each 3-byte read is 4 strobes.
  assert.deepEqual(readFrame(), [0x01, 0xff, 0xff]);
});

test('HLE: vblank during the coinage argument loop defers the frame work', () => {
  const hle = new Namco51();
  hle.reset();
  for (const b of [1, 1, 1, 1, 1, 2]) hle.write(b); // coinage 1/1, credit mode
  hle.setInputs(0xff, 0xff);
  hle.vblank();
  hle.vblank();
  hle.setInputs(0xff, 0xef); // coin held
  hle.vblank();
  hle.write(1);
  hle.write(1);
  hle.write(1);
  hle.vblank(); // arrives mid-command: nothing happens yet
  hle.vblank();
  assert.equal(hle.ram[RAM.CRED_LO], 0);
  hle.write(1);
  hle.write(1); // 4th argument: the deferred frame runs once, coin counted
  assert.equal(hle.ram[RAM.CRED_LO], 1);
  assert.equal(hle.tl, 5);
  assert.equal(hle.ram[RAM.TL_SEEN], 5);
});
