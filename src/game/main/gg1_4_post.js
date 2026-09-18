// Copyright 2026 by Moshix
/**
 * gg1_4b.2l ($3000-$3FFF), part 4 of 4: the power-on self test and the
 * service mode loop -- everything from jp_RAM_test ($336C) until the jump
 * to j_Game_init ($02D3).
 *
 * WHAT THE PLAYER SEES at power-on (default dip switches, test switch off).
 * Frame numbers are port frames = lock-step frames (test/helpers/
 * lockstep.mjs); all measured on the oracle, the port matches every one:
 *
 *     0-698  garbage: the RAM test writes pseudo-random patterns over every
 *            chip, sound NMI off, sub CPUs held in reset. Tile RAM: 10
 *            passes x 3 patterns (5,899,960 cycles = 116.4 frames), then
 *            30 rounds on each of colour RAM, RAM 1, RAM 2, RAM 3 and tile
 *            RAM again (5,902,282 cycles = 116.4 frames each).
 *    698-699 screen cleared (the clear straddles the vblank); then in 699
 *            "RAM  OK", sprites parked, sub CPUs released.
 *    699-711 ROM checksums of the four main ROMs (159,991 cycles = 3.2
 *            frames each) while the sub and sound CPUs check theirs.
 *        711 "ROM  OK" and the dip switch report (UPRIGHT, RANK x,
 *            x FIGHTERS, coinage, bonus lines), flipped by the RAM-test
 *            garbage in $99B5; 51XX to switch mode.
 *        713 54XX initialised, main IRQs on, "SOUND 00".
 *    721-722 one pass of the service loop (flip cleared); test switch off:
 *    722-730 8-frame pause.
 *    730-858 the cross hatch test pattern (128 frames, ~2.1 s).
 *    858-861 IRQs off, 2 frames, 51XX to credit mode ($E1: 57,546 cycles,
 *            then the $B1 read-back), IRQs on, jp j_Game_init in frame 861
 *            (oracle $02D3 at frame 862 line 30).
 *
 * With the test switch on, 721 onwards is the service loop instead: stick
 * left/right select a sound (SOUND nn), any button or coin plays it, the
 * service switch shows the machine totals for 15 s, and fire + 5R 6L 3R 7L
 * draws the "(c) 1981 NAMCO LTD." easter egg. Switching it off leads to the
 * pause and the cross hatch; switching it on during the cross hatch holds
 * the pattern.
 *
 * STACK. The Z80 runs the self test on temporary stacks in RAM that is
 * compared: SP = $8400 (tile RAM $83F6-$83FF) and $8B00 ($8AEC-$8AFF, RAM
 * the game never uses). The port writes the pushes of the RAM and ROM
 * tests; from j_Test_menu_init on, like everywhere else in the port, it
 * does not (the IRQ handler's pushes land there too), so $8AE0-$8AFF is
 * stack for comparison purposes from frame 711.
 *
 * TIMING. The RAM and ROM tests run with interrupts off and burn real
 * time; the port must spend the same number of frames in them. The
 * generator keeps a Z80 cycle clock `t` (cycles since the port's frame
 * began: line 63 of the oracle's frame while the main CPU is alone, vblank
 * once the sub CPUs run -- see Clock) and
 * yields each time `t` passes a frame (FRAME_CYCLES), always BEFORE the
 * next write or shared-RAM read, so every write lands in the same frame as
 * on the board. Loop costs are the Z80 T-states of the instructions,
 * quoted in the comments; the totals are checked against the oracle in
 * test/oracle/main-gg1_4.test.mjs (tile RAM test 5,899,960 cycles,
 * each block test 5,902,282, each ROM checksum 159,991).
 *
 * @see reference/galaga-main.asm $336C-$376F
 */

import { MAIN } from './routines.js';
import { call } from '../call.js';
import { SPIN } from '../scheduler.js';
import { c_text_out } from './gg1_4_text.js';
import {
  c_svc_updt_dsply, c_svc_clr_snd_regs, c_spriteposn_regs_init,
  c_svc_test_input_hdlr, c_svc_test_sound_sel,
  c_svc_machine_ttls_erase,
} from './gg1_4_svc.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/** Z80 cycles per video frame: 384 x 264 pixel clocks / 2. */
export const FRAME_CYCLES = 50688;

/**
 * Where the port's frames begin, in Z80 cycles after the start of an
 * oracle frame: line 63. test/helpers/lockstep.mjs compares the port after
 * its k-th frame with the oracle at line 63 of frame k+1 (after vblank k's
 * handlers, before the next sound NMI), so a busy loop must yield exactly
 * when the Z80 passes line 63 for the two to hold the same RAM.
 */
export const FRAME_ORIGIN = 63 * 192;

/**
 * The port clock's value at vblank (line 224): cycles since line 63.
 */
export const VBLANK_T = (224 - 63) * 192;

/**
 * Clock value at which the power-on path reaches jp_RAM_test: the oracle's
 * main CPU starts at cycle 0 of frame 0 and executes $0000-$02D0 in 480
 * cycles, which is 11,616 cycles BEFORE the first line 63. The port's first
 * frame covers the oracle up to line 63 of frame 1 (lockstep.mjs), so the
 * first yield must come a whole frame after that line: t starts negative.
 */
export const BOOT_ENTRY_CYCLE = 480 - FRAME_ORIGIN;

/**
 * Entry registers for the other way in: the service switch seen in credit
 * mode makes the vblank task f_0977 jump from inside the IRQ handler to
 * $336C ($097C). Measured on the oracle in attract mode: $336C is reached
 * 14,554 cycles after vblank (the handler's task time, which varies a
 * little with the game state) with C = $1F. The caller that restarts the
 * RAM test from the IRQ path should pass these to jp_RAM_test.
 */
export const SERVICE_ENTRY = Object.freeze({ t: VBLANK_T + 14554, c: 0x1f });

/**
 * Measured costs (oracle, cycles between instruction starts) of the
 * stretches the port performs at once. Each is quoted with the two rev. B
 * addresses it spans. The 06XX waits depend on the 06XX clock (control
 * bits 7-5 select a divider: $A1/$A8/$B1 one NMI per 2048 cycles, $E1 one
 * per 8192), so they are measured, not counted.
 */
export const CYCLES = Object.freeze({
  /** $336C-$3384: latches, 06XX reset, di, watchdog, ld b,$0A. */
  PROLOGUE: 98,
  /** $3472-$355A: "RAM  OK", sound regs, $9020, sprite regs, jp. */
  RAM_OK_TO_ROMTEST: 6250,
  /** One call of c_rom_test_csum_calc: call 17 + body 159,974. */
  CSUM_CALL: 159991,
  /** $35BF-$35E3: "ROM  OK", switch report, $9100 clear, $9000. */
  TEST_MENU_INIT: 9295,
  /** $35E3-$35EC: $A1 to $7100 .. c_io_cmd_wait returns (4 bytes). */
  IO_A1: 6337,
  /** $3606-$360F: $A8 to $7100 .. c_io_cmd_wait returns (12 bytes). */
  IO_A8: 22756,
  /** $361C-$361F: call c_svc_test_sound_sel. */
  SOUND_SEL_CALL: 604,
  /** call c_spriteposn_regs_init: 17 + 10 + 7 + 128 x 29 - 5 + 10. */
  SPRITE_INIT_CALL: 3751,
  /**
   * Clock (cycles after vblank) at $36AB, where the service-loop pass that
   * completes the easter-egg sequence starts drawing it: the main IRQ
   * handler plus that pass (mostly the switch report). Measured with the
   * default switches; the handler's length varies by a few cycles from
   * frame to frame, so a write within that distance of the next vblank
   * could land one frame off.
   */
  EASTER_EGG_AT: 11479,
  /** $36D6-$36D9: the same call, with the IRQ's 06XX NMIs in it. */
  SPRITE_INIT_36D6: 3998,
  /** $36D9-$3715: drawing the cross hatch. */
  CROSSHATCH: 21748,
  /** $3726-$3729: c_io_cmd_wait for the IRQ's pending $71 read. */
  IO_WAIT_3726: 1590,
  /** $3743-$3749: $E1 to $7100 .. c_io_cmd_wait returns (8 bytes). */
  IO_E1: 57546,
  /** $3755-$375B: $B1 to $7100 .. c_io_cmd_wait returns (3 bytes). */
  IO_B1: 6339,
});

/**
 * Where in the frame (cycles after vblank; the clock is vblank-aligned by
 * then) the oracle's main CPU leaves each frame-counter poll loop: the time
 * the sub CPU's IRQ (or, once enabled, the main IRQ handler) takes before
 * the poll sees the change. Used to re-synchronise the clock after a wait.
 */
export const RESUME = Object.freeze({
  /** $35F3 loop (main IRQs off, the sub CPU counts) -> $35FA. */
  AFTER_35F3: 165,
  /** $3623 loop (main IRQ handler running) -> $362A. */
  AFTER_3623: 810,
  /** $362E loop -> $3634. */
  AFTER_362E: 800,
  /** $36C8 loop -> $36CF. */
  AFTER_36C8: 815,
  /** $3719 loop -> $371F. */
  AFTER_3719: 801,
  /** $36BE loop (test switch released after the easter egg) -> $36C4. */
  AFTER_36BE: 1325,
  /** $372E loop (main IRQs off again) -> $3734. */
  AFTER_372E: 180,
});

/**
 * The cycle clock of the boot generator.
 *
 * TWO ALIGNMENTS. While the main CPU is alone (RAM tests), a port frame
 * spans line 63 to line 63, so every frame matches the lock-step sample
 * exactly. Once the sub and sound CPUs run, what matters is the order of
 * the main CPU's writes against the vblank IRQs of the other CPUs: main
 * code the Z80 runs before vblank k must run in the port BEFORE frame k's
 * interrupt handlers, i.e. in port frame k-1 -- so from then on a port
 * frame spans vblank to vblank. (Otherwise, e.g., $35F0's clear of the
 * frame counter would land after the sub CPU's increment and the port
 * would leave the $35F3 wait a frame late.) The switch is made at the
 * first synchronisation point after the release at which the Z80 is past
 * vblank but not yet at the next line 63, so no frame is skipped or
 * repeated: t just becomes t - VBLANK_T.
 *
 * @typedef {object} Clock
 * @property {number} t          cycles since the port frame began
 * @property {boolean} realign   switch to vblank alignment when possible
 * @property {boolean} vblankAligned  frames now run vblank to vblank
 */

/**
 * Yield once for every frame boundary the clock has passed. Called before
 * every observable action (RAM write, shared-RAM poll, latch write).
 * @param {Clock} clk
 * @returns {Generator<undefined, void, void>}
 */
function* sync(clk) {
  while (clk.t >= FRAME_CYCLES) {
    clk.t -= FRAME_CYCLES;
    yield;
  }
  if (clk.realign && clk.t >= VBLANK_T) {
    clk.t -= VBLANK_T;
    clk.realign = false;
    clk.vblankAligned = true;
  }
}

/**
 * Wait for a condition set by an interrupt handler (the frame counter
 * $92A0 or an input): one yield per frame, then re-synchronise the clock
 * to where the oracle leaves the loop.
 * @param {Clock} clk
 * @param {() => boolean} done
 * @param {number} resumeAt cycles after vblank (RESUME)
 * @returns {Generator<undefined, void, void>}
 */
function* waitFrames(clk, done, resumeAt) {
  yield* sync(clk);
  if (done()) return;
  do yield; while (!done());
  clk.t = resumeAt;
  // resumeAt is vblank-relative; the switch has always happened by now.
  clk.realign = false;
  clk.vblankAligned = true;
}

/**
 * `push rr` onto the temporary stack: high byte at SP-1, low at SP-2.
 * @param {Machine} m @param {number} sp @param {number} v
 */
function push(m, sp, v) {
  m.poke(sp - 1, (v >> 8) & 0xff);
  m.poke(sp - 2, v & 0xff);
}

/**
 * One step of the RAM test's pseudo-random sequence: `ld a,l / xor h /
 * cpl / add a,a / add a,a / adc hl,hl` -- HL shifts left, taking in the
 * complement of bit 6 of (L xor H) as the new bit 0 (the carry of the
 * second `add a,a`).
 * @param {number} hl @returns {number}
 */
export function ramTestNext(hl) {
  const bit = ((~((hl & 0xff) ^ (hl >> 8))) >> 6) & 1;
  return ((hl << 1) | bit) & 0xffff;
}

/**
 * The inner write loop ($338E / $349B): 1024 bytes of the sequence from
 * HL to DE. 91 cycles per byte (86 for the last); the `ld (de),a` starts
 * 52 cycles into the iteration.
 * @param {Machine} m @param {Clock} clk @param {number} de @param {number} hl
 * @returns {Generator<undefined, number, void>} the final HL
 */
function* writePattern(m, clk, de, hl) {
  for (let i = 0; i < 0x400; i += 1) {
    hl = ramTestNext(hl);
    clk.t += 52;
    if (clk.t >= FRAME_CYCLES) yield* sync(clk);
    m.poke(de + i, hl & 0xff);
    clk.t += i === 0x3ff ? 34 : 39;
  }
  return hl;
}

/**
 * The inner read loop ($33A9 / $34B3): regenerate the sequence and compare.
 * 101 cycles per byte (96 for the last). A mismatch jumps to j_ramtest_ng
 * (it cannot happen in the port, whose RAM always reads back).
 * @param {Machine} m @param {Clock} clk @param {number} de @param {number} hl
 * @returns {Generator<symbol|undefined, number, void>} the final HL
 */
function* checkPattern(m, clk, de, hl) {
  for (let i = 0; i < 0x400; i += 1) {
    hl = ramTestNext(hl);
    const x = m.peek(de + i) ^ (hl & 0xff);
    if (x !== 0) yield* j_ramtest_ng(m, { a: x, de: de + i });
    clk.t += i === 0x3ff ? 96 : 101;
  }
  return hl;
}

/**
 * The tile RAM test ($3382-$3434): ten passes of write/verify with the
 * sequence seeded $0000, $5555 and $AAAA, over $8000-$83FF. Per pass
 * 589,996 cycles: exx 4, three times (3 x ld rr,nn = 30, write loop
 * 93,179, 30, read loop 103,419), exx 4, dec b 4, jp nz 10.
 * @param {Machine} m @param {Clock} clk
 * @returns {Generator<symbol|undefined, void, void>}
 */
function* tileRamTest(m, clk) {
  for (let pass = 0; pass < 10; pass += 1) {
    clk.t += 4;
    for (const seed of [0x0000, 0x5555, 0xaaaa]) {
      clk.t += 30;
      yield* writePattern(m, clk, 0x8000, seed);
      clk.t += 30;
      yield* checkPattern(m, clk, 0x8000, seed);
    }
    clk.t += 18;
  }
}

/**
 * c_ram_test_block ($3489) as the boot runs it: 30 rounds of
 * c_ram_test_single ($3496) over one 1 KB chip, the sequence continuing
 * from round to round. Includes the `call` (return address `ret`) and
 * every push onto the temporary stack at `sp`, since that stack lives in
 * RAM that is compared (tile RAM for SP=$8400, RAM 1 for SP=$8B00).
 * 5,902,282 cycles including the call.
 * @param {Machine} m @param {Clock} clk
 * @param {number} de chip base @param {number} sp @param {number} ret
 * @param {number} c the caller's C register (pushed with B)
 * @returns {Generator<symbol|undefined, void, void>}
 */
function* ramTestBlock(m, clk, de, sp, ret, c) {
  yield* sync(clk);
  push(m, sp, ret); // call 17
  clk.t += 17 + 7 + 10; // ld b,$1E / ld hl,$0000
  let hl = 0;
  const s = sp - 2;
  for (let b = 0x1e; b > 0; b -= 1) {
    yield* sync(clk);
    push(m, s, (b << 8) | c); // push bc 11
    clk.t += 11;
    yield* sync(clk);
    push(m, s - 2, 0x3492); // call $3496 17
    clk.t += 17;
    // c_ram_test_single
    yield* sync(clk);
    push(m, s - 4, de); // push de 11
    clk.t += 11;
    yield* sync(clk);
    push(m, s - 6, hl); // push hl 11
    clk.t += 11 + 10; // ld bc,$0400
    yield* writePattern(m, clk, de, hl);
    clk.t += 10 + 10; // pop hl / pop de: HL back to the round's seed
    yield* sync(clk);
    push(m, s - 4, de); // push de 11
    clk.t += 11 + 10; // ld bc,$0400
    hl = yield* checkPattern(m, clk, de, hl);
    clk.t += 10 + 10; // pop de / ret
    clk.t += 10 + (b > 1 ? 13 : 8); // pop bc / djnz
  }
  clk.t += 10; // ret
}

/**
 * `ldir` of the $20 bookkeeping bytes ($99E0 <-> $9000) around the RAM 3
 * test: ld hl/de/bc 30, then 21 cycles per byte (16 for the last).
 * @param {Machine} m @param {Clock} clk @param {number} dst @param {number} src
 * @param {number} n
 * @returns {Generator<undefined, void, void>}
 */
function* ldirTimed(m, clk, dst, src, n) {
  clk.t += 30;
  for (let i = 0; i < n; i += 1) {
    yield* sync(clk);
    m.poke(dst + i, m.peek(src + i));
    clk.t += i === n - 1 ? 16 : 21;
  }
}

/**
 * c_tileram_regs_clr as called at $346F and $36AB, byte by byte (the two
 * `ldir`s take 43,084 cycles with the call, and straddle a vblank). Same
 * writes as the plain c_tileram_regs_clr, plus, at $346F, the return
 * address pushed at SP=$8B00 (the port stops modelling that stack after
 * the RAM tests).
 * @param {Machine} m @param {Clock} clk @param {number | null} ret
 * @returns {Generator<undefined, void, void>}
 */
function* tileramClrTimed(m, clk, ret) {
  yield* sync(clk);
  if (ret !== null) push(m, 0x8b00, ret);
  clk.t += 17 + 30; // call, ld hl / ld de / ld bc
  yield* sync(clk);
  m.poke(0x8000, 0x24);
  clk.t += 10;
  for (let i = 0; i < 0x400; i += 1) {
    yield* sync(clk);
    m.poke(0x8001 + i, m.peek(0x8000 + i));
    clk.t += i === 0x3ff ? 16 : 21;
  }
  yield* sync(clk);
  m.poke(0x8400, 0x03);
  clk.t += 10 + 10;
  for (let i = 0; i < 0x3ff; i += 1) {
    yield* sync(clk);
    m.poke(0x8401 + i, m.peek(0x8400 + i));
    clk.t += i === 0x3fe ? 16 : 21;
  }
  clk.t += 7;
  yield* sync(clk);
  m.poke(0x99be, 0x07);
  clk.t += 13 + 10;
}

/**
 * The easter egg as drawn at $36B1: 28 calls of c_svc_easteregg_hdlr,
 * byte by byte with the Z80's data-dependent timing (the drawing straddles
 * a vblank). Per bitmap bit: `add a,a` 4, `jr nc` 12 (7 when set, then
 * `inc (hl)` 11), `inc hl` 6, `dec c` 4, `jr nz` 12 (7 after the 8th).
 * @param {Machine} m @param {Clock} clk
 * @returns {Generator<undefined, void, void>}
 */
function* easterEggTimed(m, clk) {
  let de = 0x37a2;
  let hl = 0x8042;
  clk.t += 27; // ld de / ld hl / ld b
  for (let b = 0x1c; b > 0; b -= 1) {
    clk.t += 17; // call $3770
    for (let k = 0; k < 3; k += 1) {
      clk.t += 17 + 7 + 7; // call $377E, ld a,(de), ld c,8
      let a = m.read('main', de);
      for (let c = 8; c > 0; c -= 1) {
        clk.t += 4;
        const carry = a & 0x80;
        a = (a << 1) & 0xff;
        if (carry) {
          clk.t += 7;
          yield* sync(clk);
          m.poke(hl, (m.peek(hl) + 1) & 0xff);
          clk.t += 11;
        } else clk.t += 12;
        hl = (hl + 1) & 0xffff;
        clk.t += 6 + 4 + (c > 1 ? 12 : 7);
      }
      de = (de + 1) & 0xffff;
      hl = (hl + 1) & 0xffff;
      clk.t += 6 + 6 + 10; // inc de, inc hl, ret
    }
    // ld a,5 / jp $0010: add a,l / ld l,a / ret nc (or inc h / ret).
    const carry = (hl & 0xff) + 5 > 0xff;
    hl = (hl + 5) & 0xffff;
    clk.t += 7 + 10 + 4 + 4 + (carry ? 5 + 4 + 10 : 11);
    clk.t += b > 1 ? 13 : 8; // djnz
  }
}

/**
 * Perform a 06XX transfer through the host's bus model.
 * @param {Machine} m @param {number} control @param {number} addr @param {number} count
 */
function ioTransfer(m, control, addr, count) {
  if (m.io === null) throw new Error('main CPU: the 06XX bus (m.io) is not installed');
  m.io.transfer(control, addr, count);
}

/**
 * j_ramtest_ng ($34CA): a RAM chip failed. Clear the screen, show "RAM"
 * followed by the chip (E: 0 tile, 1 colour, 2 RAM 1, 3 RAM 2, 4 RAM 3;
 * from bits 2-4 of the failing address's high byte) and "H" ($11) if the
 * bad bits are in the high nibble else "L" ($15), then hang kicking the
 * watchdog. A GENERATOR that never returns.
 * @see galaga-main.asm $34CA
 * @param {Machine} m
 * @param {{ a: number, de: number }} regs  A = bad bits, DE = address
 * @returns {Generator<undefined, void, void>}
 */
export function* j_ramtest_ng(m, { a, de }) {
  // 0x34CB: rra / rra with carry clear (from the `xor l`), and 7.
  let e = (de >> 10) & 0x07;
  if (e >= 4) e -= 1;
  if (e >= 5) e -= 1;
  const d = (a & 0x0f) === 0 ? 0x11 : 0x15;
  // The fill of $8000-$83FF also writes $8400 (the ldir runs one past).
  m.poke(0x8000, 0x24);
  m.ldir(0x8001, 0x8000, 0x400);
  m.poke(0x8400, 0x00);
  m.ldir(0x8401, 0x8400, 0x3ff);
  // "RAM" then the codes; each step is HL -= $20 (-$60 before E).
  m.poke(0x82e2, 0x1b);
  m.poke(0x82c2, 0x0a);
  m.poke(0x82a2, 0x16);
  m.poke(0x8242, e);
  m.poke(0x8222, d);
  c_spriteposn_regs_init(m);
  for (;;) yield; // l_ramtest_ng_4ever
}

/**
 * c_rom_test_csum_calc ($352B): sum the 4 KB of ROM at DE; the sum must
 * equal C (0: each ROM's last byte is chosen to make it so). The port
 * cannot read its own code bytes and its "ROM" cannot be corrupt, so it
 * returns the good result; test/oracle/main-gg1_4.test.mjs checks that
 * every main ROM does sum to 0. Takes 159,974 cycles on the board.
 * @see galaga-main.asm $352B
 * @param {Machine} m
 * @param {{ de: number, c?: number }} regs
 * @returns {{ de: number, a: number, zf: boolean }} DE advanced by $1000
 */
export function c_rom_test_csum_calc(m, { de }) {
  return { de: (de + 0x1000) & 0xffff, a: 0x00, zf: true };
}

/**
 * j_romtest_ng ($353F): a ROM failed (code in $9102: 1-4 main ROM, or the
 * sub CPUs' error code). Prints "ROM  OK" (sic) and the code's two hex
 * digits over it with `rld`, which leaves $9102 = 0, then hangs.
 * A GENERATOR that never returns.
 * @see galaga-main.asm $353F
 * @param {Machine} m
 * @returns {Generator<undefined, void, void>}
 */
export function* j_romtest_ng(m) {
  c_text_out(m, { hl: 0x3b95 });
  const x = m.peek(0x9102);
  // rld with A = 0: A <- high nibble, (HL) <- low nibble << 4.
  m.poke(0x9102, (x << 4) & 0xf0);
  m.poke(0x8244, x >> 4);
  m.poke(0x9102, 0x00);
  m.poke(0x8224, x & 0x0f);
  for (;;) yield; // l_romtest_ng_4ever
}

/**
 * j_romtest_mgr ($355A) to the end of the ROM tests: flag the sub CPUs,
 * release them, checksum the four main ROMs (stepping $9102 = 1..4, then
 * $FF), then wait for the sub CPU ($9100) and sound CPU ($9101) results,
 * $FF = good. The waits are cross-CPU handshakes: `yield SPIN`.
 * @param {Machine} m @param {Clock} clk
 * @returns {Generator<symbol|undefined, void, void>}
 */
function* romTests(m, clk) {
  clk.t += 10;
  yield* sync(clk);
  m.poke(0x9100, 0x00);
  clk.t += 16;
  m.poke(0x9101, 0x00);
  clk.t += 16;
  m.poke(0x9102, 0x01);
  clk.t += 10 + 4;
  m.poke(0x9270, 0x00); // sound-test selection
  clk.t += 13 + 4;
  yield* sync(clk);
  m.poke(0x6823, 0x01); // release the sub and sound CPUs
  clk.realign = true;
  clk.t += 13 + 10 + 7; // ld de,$0000 / ld c,$00
  const rets = [0x3575, 0x357b, 0x3581, 0x3587];
  let de = 0x0000;
  for (let i = 0; i < 4; i += 1) {
    yield* sync(clk);
    push(m, 0x8b00, rets[i]); // call $352B
    clk.t += 17;
    yield* sync(clk);
    push(m, 0x8afe, 0x9102); // push hl
    ({ de } = c_rom_test_csum_calc(m, { de, c: 0 }));
    clk.t += CYCLES.CSUM_CALL - 17;
    if (i < 3) {
      yield* sync(clk);
      m.poke(0x9102, (m.peek(0x9102) + 1) & 0xff); // inc (hl)
      clk.t += 11 + 7; // inc (hl) / ld c,$00
    }
  }
  yield* sync(clk);
  m.poke(0x9102, 0xff);
  clk.t += 10;
  for (const flag of [0x9100, 0x9101]) {
    // l_CPU1_rom_test / l_CPU2_rom_test. The ROM kicks the watchdog in
    // the loop; the port does not, so a spinning main CPU does not look
    // like progress to the scheduler.
    yield* sync(clk);
    while (m.peek(flag) === 0) yield SPIN;
    const a = m.peek(flag);
    clk.t += 53;
    if (a !== 0xff) {
      m.poke(0x9102, a);
      yield* j_romtest_ng(m);
    }
  }
}

/**
 * j_Test_menu_init ($35BF): "ROM  OK", the switch report, 51XX to switch
 * mode, wait for the sub CPU to count two frames, initialise the 54XX,
 * enable the main CPU's IRQ, show the sound selection, wait 8 frames.
 * @param {Machine} m @param {Clock} clk
 * @returns {Generator<symbol|undefined, void, void>}
 */
function* testMenuInit(m, clk) {
  yield* sync(clk);
  c_text_out(m, { hl: 0x3b95 }); // "ROM  OK"
  c_svc_updt_dsply(m);
  m.fill(0x9100, 0x00, 3); // lets the sub CPUs carry on
  m.poke(0x9000, 0x20); // task table: only the empty task until game init
  clk.t += CYCLES.TEST_MENU_INIT;
  yield* sync(clk);
  ioTransfer(m, 0xa1, 0x35af, 4); // d_params_switch_mode: 05 05 05 05
  clk.t += CYCLES.IO_A1 + 17; // + xor a / ld ($6830),a
  yield* sync(clk);
  m.poke(0x92a0, 0x00);
  clk.t += 13;
  yield* waitFrames(clk, () => m.peek(0x92a0) === 0x02, RESUME.AFTER_35F3);
  clk.t += 41;
  yield* sync(clk);
  ioTransfer(m, 0xa8, 0x35b3, 12); // d_params_snd_test to the 54XX
  clk.t += CYCLES.IO_A8 + 13 + 2 + 10; // watchdog / im 1 / ld hl
  yield* sync(clk);
  m.poke(0x6820, 0x00); // acknowledge, then enable the main IRQ
  m.poke(0x6820, 0x01);
  clk.t += 20;
  m.ei();
  clk.t += 4;
  c_svc_test_sound_sel(m);
  clk.t += CYCLES.SOUND_SEL_CALL + 4;
  yield* sync(clk);
  m.poke(0x92a0, 0x00);
  clk.t += 13;
  yield* waitFrames(clk, () => (m.peek(0x92a0) & 0x08) !== 0, RESUME.AFTER_3623);
}

/**
 * One pass of j_Test_menu_proc ($362A) after its frame wait: debounce the
 * inputs, run the input handler for each new press, refresh the switch
 * report, the machine-totals timer, and the easter-egg sequence.
 * @param {Machine} m
 * @returns {'exit'|'again'|'easteregg'} exit = test switch off
 */
function testMenuStep(m) {
  // $9110-$9117: the last few input states. lddr shifts them up by one.
  for (let i = 6; i >= 0; i -= 1) m.poke(0x9111 + i, m.peek(0x9110 + i));
  let a = m.peek(0x99b5);
  if (a & 0x80) return 'exit'; // test switch off: j_36BA_Machine_init
  // New presses: active (low) now or last frame, but not two frames ago,
  // and not already reported (the stored result).
  m.poke(0x9110, a);
  a = ~(a | m.peek(0x9111)) & m.peek(0x9112) & m.peek(0x9113) & 0xff;
  m.poke(0x9113, a);
  const buttons = a;
  a = m.peek(0x99b6);
  m.poke(0x9114, a);
  a = ~(a | m.peek(0x9115)) & m.peek(0x9116) & m.peek(0x9117) & 0xff;
  m.poke(0x9117, a);
  // 0x3661: shift HL = buttons:stick left 16 times; each carry is a press,
  // handled with B = its position counter (16..1).
  let hl = (buttons << 8) | a;
  for (let b = 0x10; b > 0; b -= 1) {
    const carry = hl & 0x8000;
    hl = (hl << 1) & 0xffff;
    if (carry) c_svc_test_input_hdlr(m, { b });
  }
  c_svc_updt_dsply(m);
  // The machine totals disappear when the 15 s timer runs out. It is not
  // initialised, so the first countdown starts from RAM-test garbage.
  let tmr = m.peek16(0x9272);
  if (tmr !== 0) {
    tmr -= 1;
    m.poke16(0x9272, tmr);
    if (tmr === 0) c_svc_machine_ttls_erase(m);
  }
  if (m.peek(0x9110) & 0x01) {
    // Fire not held: the easter-egg sequence restarts.
    m.poke(0x9271, 0x00);
    return 'again';
  }
  const stick = m.peek(0x9117) & 0x0f;
  if (stick === 0) return 'again';
  // With fire held, the stick must follow d_easteregg_trigger ($378C):
  // 5 R, 6 L, 3 R, 7 L (codes 02/08), ended by $FF.
  const cnt = m.peek(0x9271);
  if (m.read('main', 0x378c + cnt) !== stick) {
    m.poke(0x9271, 0x00);
    return 'again';
  }
  m.poke(0x9271, (cnt + 1) & 0xff);
  if (m.read('main', 0x378c + cnt + 1) !== 0xff) return 'again';
  return 'easteregg';
}

/**
 * The service loop and machine init: j_Test_menu_proc ($362A) and
 * j_36BA_Machine_init ($36C4), which jump to each other, then the 51XX
 * credit-mode handshake and the jump to j_Game_init ($02D3).
 * @param {Machine} m @param {Clock} clk
 * @returns {Generator<symbol|undefined, void, void>}
 */
function* testMenuAndMachineInit(m, clk) {
  for (;;) {
    // j_Test_menu_proc: once per frame while the test switch is on.
    for (;;) {
      yield* sync(clk);
      const c = m.peek(0x92a0);
      yield* waitFrames(clk, () => m.peek(0x92a0) !== c, RESUME.AFTER_362E);
      const r = testMenuStep(m);
      if (r === 'exit') break;
      if (r === 'easteregg') {
        // "(c) 1981 NAMCO LTD." in big blocks until the switch goes off.
        // The drawing crosses a vblank, so it is timed; where it starts in
        // the frame depends on the work of testMenuStep, measured once.
        clk.t = CYCLES.EASTER_EGG_AT;
        yield* tileramClrTimed(m, clk, null);
        yield* sync(clk);
        c_spriteposn_regs_init(m);
        clk.t += CYCLES.SPRITE_INIT_CALL;
        yield* easterEggTimed(m, clk);
        yield* waitFrames(clk, () => (m.peek(0x99b5) & 0x80) !== 0, RESUME.AFTER_36BE);
        break;
      }
    }
    // j_36BA_Machine_init: 8 frames, then the switch is checked again.
    yield* sync(clk);
    m.poke(0x92a0, 0x00);
    clk.t += 13;
    yield* waitFrames(clk, () => m.peek(0x92a0) >= 0x08, RESUME.AFTER_36C8);
    if (m.peek(0x99b5) & 0x80) break;
  }
  clk.t += 27;
  yield* sync(clk);
  c_spriteposn_regs_init(m);
  clk.t += CYCLES.SPRITE_INIT_36D6;
  // The cross hatch: two grid rows written by hand, the rest smeared over
  // tile RAM with overlapping ldirs.
  yield* sync(clk);
  let hl = 0x8000;
  for (const [x, y] of [[0x28, 0x27], [0x2d, 0x2b], [0x28, 0x2d], [0x27, 0x2b]]) {
    for (let b = 0; b < 0x10; b += 1) {
      m.poke(hl, x);
      m.poke(hl + 1, y);
      hl += 2;
    }
  }
  m.ldir(0x8080, 0x8040, 0x340);
  m.ldir(0x83c0, 0x8000, 0x40);
  clk.t += CYCLES.CROSSHATCH + 4;
  yield* sync(clk);
  m.poke(0x92a0, 0x00);
  clk.t += 13;
  // About 2 seconds (until bit 7 of the frame counter), then hold the
  // pattern for as long as the test switch is on again.
  yield* waitFrames(clk, () => (m.peek(0x92a0) & 0x80) !== 0, RESUME.AFTER_3719);
  yield* waitFrames(clk, () => (m.peek(0x99b5) & 0x80) !== 0, RESUME.AFTER_3719);
  clk.t += 24;
  m.di();
  clk.t += 4;
  clk.t += CYCLES.IO_WAIT_3726 + 7; // c_io_cmd_wait: nothing to wait for
  yield* sync(clk);
  m.poke(0x92a0, 0xfe);
  clk.t += 13;
  yield* waitFrames(clk, () => m.peek(0x92a0) === 0x00, RESUME.AFTER_372E);
  clk.t += 13; // watchdog
  // l_372D: the credit-mode command to the 51XX, and read back its three
  // bytes until the credit count is valid BCD <= $A0.
  for (;;) {
    clk.t += 41;
    yield* sync(clk);
    ioTransfer(m, 0xe1, 0x9280, 8);
    clk.t += CYCLES.IO_E1 + 41;
    yield* sync(clk);
    ioTransfer(m, 0xb1, 0x9288, 3);
    clk.t += CYCLES.IO_B1;
    yield* sync(clk);
    const a = m.peek(0x9288);
    if (a >= 0xa1) { clk.t += 32; continue; }
    if ((a & 0x0f) >= 0x0a) { clk.t += 53; continue; }
    clk.t += 48;
    break;
  }
  m.ei();
  m.poke(0x8210, 0x00);
}

/**
 * jp_RAM_test ($336C): the power-on self test, entered from the reset
 * path ($02D0) and when the service switch is seen in credit mode
 * ($097C). Holds the sub/sound CPUs in reset, tests every RAM chip (the
 * pattern it leaves is reproduced byte for byte, frame by frame), checks
 * the ROMs with the sub CPUs, runs the service mode while the test switch
 * is on, shows the cross hatch, puts the 51XX in credit mode and jumps to
 * j_Game_init. A GENERATOR that never returns.
 *
 * Frames spent (oracle, default switches, test switch off; see the module
 * comment): 699 in the RAM tests, 13 in the ROM checksums, 150 more to
 * j_Game_init at the 862nd vblank.
 * @see galaga-main.asm $336C
 * @param {Machine} m
 * @param {{ c?: number, t?: number, clock?: Clock }} [regs]  C = the
 *   Z80's C at entry (it is pushed onto the test stack; 0 after reset);
 *   t = the clock at entry (cycles since line 63; defaults to the power-on
 *   value); clock = an object to use as the clock, so a test can watch it
 * @returns {Generator<symbol|undefined, void, void>}
 */
export function* jp_RAM_test(m, { c = 0, t = BOOT_ENTRY_CYCLE, clock } = {}) {
  /** @type {Clock} */
  const clk = clock ?? { t, realign: false, vblankAligned: false };
  Object.assign(clk, { t, realign: false, vblankAligned: false });
  m.poke(0x6823, 0x00); // hold sub CPU, sound CPU, 51XX, 54XX in reset
  m.poke(0x6822, 0x01); // sound CPU NMI off
  m.poke(0x7100, 0x10); // [rev B] 06XX idle
  // [rev B] `ld ($7000),a` with A = $FF: with control $10 (read, no chip
  // selected) the 06XX ignores data writes, so there is nothing to model.
  m.di();
  m.poke(0x6830, 0xff); // watchdog; the loops keep kicking it
  clk.t += CYCLES.PROLOGUE;
  yield* tileRamTest(m, clk);
  clk.t += 20; // ld sp,$8400 / ld de,$8400
  yield* ramTestBlock(m, clk, 0x8400, 0x8400, 0x343e, c); // colour RAM
  clk.t += 10;
  yield* ramTestBlock(m, clk, 0x8800, 0x8400, 0x3444, c); // RAM 1
  clk.t += 10;
  yield* ramTestBlock(m, clk, 0x9000, 0x8400, 0x344a, c); // RAM 2
  // Park the bookkeeping at $99E0 in $9000 while RAM 3 is tested (the
  // ldir leaves BC = 0, so C = 0 from here on).
  yield* ldirTimed(m, clk, 0x9000, 0x99e0, 0x20);
  clk.t += 10;
  yield* ramTestBlock(m, clk, 0x9800, 0x8400, 0x345b, 0); // RAM 3
  yield* ldirTimed(m, clk, 0x99e0, 0x9000, 0x20);
  clk.t += 20; // ld sp,$8B00 / ld de,$8000
  yield* ramTestBlock(m, clk, 0x8000, 0x8b00, 0x346f, 0); // tile RAM
  yield* tileramClrTimed(m, clk, 0x3472);
  // $3472-$3489: "RAM  OK" etc., all inside one frame.
  yield* sync(clk);
  push(m, 0x8b00, 0x3478);
  c_text_out(m, { hl: 0x3b8b }); // "RAM  OK"
  m.poke(0x6830, 0x00);
  push(m, 0x8b00, 0x347e);
  c_svc_clr_snd_regs(m);
  m.poke(0x9020, 0x07); // sub CPU task table: only its empty task
  push(m, 0x8b00, 0x3486);
  c_spriteposn_regs_init(m);
  clk.t += CYCLES.RAM_OK_TO_ROMTEST;
  yield* romTests(m, clk);
  yield* testMenuInit(m, clk);
  yield* testMenuAndMachineInit(m, clk);
  yield* call(MAIN.j_Game_init, m);
}
