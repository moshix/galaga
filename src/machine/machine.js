// Copyright 2026 by Moshix
/**
 * The Galaga board, as far as the ported game code can observe it.
 *
 * The JavaScript port keeps the original's memory layout rather than inventing
 * an object model: game state lives at the addresses the 1981 code used. That
 * is what makes the differential test against the Z80 oracle a byte-for-byte
 * comparison instead of a judgement call, and it means any line of
 * reference/galaga-main.asm, galaga-sub.asm or galaga-sound.asm can be read
 * straight against the port.
 *
 * Address map shared by all three CPUs (MAME galaga.cpp `galaga_map`):
 *
 *   $6800-$6807 R   dip switches, 2 bits per address   -> readDsw()
 *   $6800-$681F W   WSG sound registers (low nibble)   -> wsg[]
 *   $6820-$6827 W   LS259 latch: IRQ enables, run/reset -> misc[]
 *   $6830       W   watchdog
 *   $7000-$70FF RW  06XX data                           -> see src/game/io.js
 *   $7100       RW  06XX control
 *   $8000-$87FF RW  tile codes / tile colours
 *   $8800-$8BFF RW  RAM 1 (sprite codes at $8B80)
 *   $9000-$93FF RW  RAM 2 (sprite positions at $9380)
 *   $9800-$9BFF RW  RAM 3 (sprite flags at $9B80)
 *   $A000-$A007 W   video latch: starfield control, flip screen
 *
 * Everything is kept in one flat 64 KB array so an address in the listing is
 * an index here. Reads of undecoded addresses return 0, as MAME's do.
 */

import { romByte } from '../game/romdata.js';

/** @typedef {import('../game/romdata.js').Cpu} Cpu */

/** 18.432 MHz / 3 / (384 * 264). */
export const FRAME_RATE = 18432000 / 3 / (384 * 264);

/**
 * Default dip switches, as MAME ships them for `galaga`.
 * DSWA $F7: difficulty easy, demo sound on, freeze off, rack test off, upright.
 * DSWB $97: 1 coin 1 credit, bonus 20K/70K/every 70K, 3 fighters.
 */
export const DEFAULT_DSWA = 0xf7;
export const DEFAULT_DSWB = 0x97;

/** Input switch bits; both ports are ACTIVE LOW. @see galaga.cpp INPUT_PORTS */
export const IN0 = Object.freeze({ RIGHT: 0x02, LEFT: 0x08, P2_RIGHT: 0x20, P2_LEFT: 0x80 });
export const IN1 = Object.freeze({
  FIRE: 0x01, P2_FIRE: 0x02, START1: 0x04, START2: 0x08,
  COIN1: 0x10, COIN2: 0x20, SERVICE: 0x40, TEST: 0x80,
});

/** @typedef {'left'|'right'|'p2left'|'p2right'|'fire'|'p2fire'|'start1'|'start2'|'coin1'|'coin2'|'service'|'test'} InputName */

/** @type {Readonly<Record<InputName, ['in0'|'in1', number]>>} */
const INPUTS = Object.freeze({
  left: ['in0', IN0.LEFT], right: ['in0', IN0.RIGHT],
  p2left: ['in0', IN0.P2_LEFT], p2right: ['in0', IN0.P2_RIGHT],
  fire: ['in1', IN1.FIRE], p2fire: ['in1', IN1.P2_FIRE],
  start1: ['in1', IN1.START1], start2: ['in1', IN1.START2],
  coin1: ['in1', IN1.COIN1], coin2: ['in1', IN1.COIN2],
  service: ['in1', IN1.SERVICE], test: ['in1', IN1.TEST],
});

/** CPU numbers, as the board wires them. */
export const CPU = Object.freeze({ MAIN: 0, SUB: 1, SOUND: 2 });

export class Machine {
  /** The whole 64 KB address space. ROM space stays zero; see romdata.js. */
  mem = new Uint8Array(0x10000);
  /** Views the renderer reads. */
  video = this.mem.subarray(0x8000, 0x8800);
  ram1 = this.mem.subarray(0x8800, 0x8c00);
  ram2 = this.mem.subarray(0x9000, 0x9400);
  ram3 = this.mem.subarray(0x9800, 0x9c00);

  /** WSG registers $6800-$681F, low nibble only. */
  wsg = new Uint8Array(0x20);
  /** LS259 3C, $6820-$6827: Q0 main IRQ enable, Q1 sub IRQ enable,
   * Q2 sound NMI disable, Q3 sub/sound/51XX/54XX run. */
  misc = new Uint8Array(8);
  /** LS259 5K, $A000-$A007: starfield control and flip. */
  videoLatch = new Uint8Array(8);

  dswA = DEFAULT_DSWA;
  dswB = DEFAULT_DSWB;
  /** Active low: $FF means nothing pressed. */
  in0 = 0xff;
  in1 = 0xff;

  /** 06XX control register as last written ($10 = idle). */
  ioControl = 0;
  /**
   * The 06XX bus with its 51XX and 54XX, installed by the host.
   * @type {import('../game/io.js').IoBus | null}
   */
  io = null;

  /**
   * Interrupt flip-flop of each CPU (IFF1). A vblank that lands while a CPU
   * has interrupts off is held until `ei()`, because the IRQ line is level
   * triggered and stays up until the handler acknowledges it through the
   * latch. Index by {@link CPU}.
   */
  iff = [false, false, false];
  /** IRQ lines of the main and sub CPUs (asserted at vblank if enabled). */
  irqLine = [false, false];

  /**
   * The Z80 refresh register R, as `ld a,r` reads it. The random number
   * generator at main $1000 mixes it in twice. On the chip it counts opcode
   * fetches, so its value depends on exactly how many instructions ran --
   * which a routine-level port cannot know. The browser uses {@link nextR}; the
   * lock-step tests replace this with the values the real ROM read, which
   * keeps the comparison byte-exact. Bit 7 is only changed by `ld r,a`, which
   * Galaga never executes, so R is always 0-127.
   * @type {() => number}
   */
  readR = () => this.nextR();

  /** Internal state of the default R source. */
  rState = 0x2f;

  /**
   * Default R source: a 7-bit counter stepped by an odd, irregular amount,
   * standing in for "however many instructions ran since last time".
   * @returns {number}
   */
  nextR() {
    // xorshift on 16 bits, folded to 7: cheap, full-period, not periodic in
    // any way a player could notice.
    let x = this.rState;
    x ^= (x << 7) & 0xffff;
    x ^= x >> 9;
    x ^= (x << 8) & 0xffff;
    this.rState = x;
    return (x ^ (x >> 7)) & 0x7f;
  }

  /** Writes performed, for the scheduler's "did anything happen" test. */
  writes = 0;
  watchdogKicks = 0;

  /**
   * Hooks the scheduler installs. Kept as plain properties so the machine
   * has no import-time dependency on the game code.
   * @type {{ onRunLatch?: (running: boolean) => void, onIrqEnable?: (cpu: number) => void,
   *          onWsgWrite?: (reg: number, value: number) => void,
   *          onIoControl?: (value: number) => void, onIoData?: (value: number) => void,
   *          ioRead?: () => number }}
   */
  hooks = {};

  // ------------------------------------------------------------- memory

  /**
   * Read a byte the way the CPU would.
   * @param {number} addr @returns {number}
   */
  peek(addr) {
    const a = addr & 0xffff;
    if (a >= 0x8000) return this.mem[a];
    if (a >= 0x6800 && a < 0x6808) return this.readDsw(a & 7);
    if (a === 0x7100) return this.ioControl;
    if (a >= 0x7000 && a < 0x7100) return this.hooks.ioRead ? this.hooks.ioRead() : 0xff;
    return 0;
  }

  /**
   * Write a byte the way the CPU would, including I/O side effects.
   * @param {number} addr @param {number} value
   */
  poke(addr, value) {
    const a = addr & 0xffff;
    const v = value & 0xff;
    this.writes += 1;
    if (a >= 0x8000) {
      // Only the four RAM chips and the video latch are decoded up here.
      if (a < 0x8c00 || (a >= 0x9000 && a < 0x9400) || (a >= 0x9800 && a < 0x9c00)) this.mem[a] = v;
      else if (a >= 0xa000 && a < 0xa008) this.videoLatch[a & 7] = v & 1;
      return;
    }
    if (a < 0x6800) return;
    if (a < 0x6820) { this.wsg[a - 0x6800] = v & 0x0f; this.hooks.onWsgWrite?.(a - 0x6800, v & 0x0f); return; }
    if (a < 0x6828) { this.writeMisc(a & 7, v & 1); return; }
    if (a === 0x6830) { this.watchdogKicks += 1; return; }
    if (a === 0x7100) { this.ioControl = v; this.hooks.onIoControl?.(v); return; }
    if (a >= 0x7000 && a < 0x7100) { this.hooks.onIoData?.(v); }
  }

  /**
   * Read through a pointer that may point into ROM or RAM -- e.g. HL walking
   * a flight-path table whose address was stored in RAM. Each CPU has its own
   * ROM at $0000-$3FFF, hence the CPU argument.
   * @param {Cpu} cpu @param {number} addr @returns {number}
   */
  read(cpu, addr) {
    const a = addr & 0xffff;
    return a < 0x4000 ? romByte(cpu, a) : this.peek(a);
  }

  /** Little-endian word through a ROM-or-RAM pointer. @param {Cpu} cpu @param {number} addr */
  read16(cpu, addr) { return this.read(cpu, addr) | (this.read(cpu, addr + 1) << 8); }

  /** Little-endian word, as `ld hl,(nn)` reads it. @param {number} addr */
  peek16(addr) { return this.peek(addr) | (this.peek(addr + 1) << 8); }

  /** @param {number} addr @param {number} v */
  poke16(addr, v) { this.poke(addr, v & 0xff); this.poke(addr + 1, (v >> 8) & 0xff); }

  /**
   * `ldir`: copy `count` bytes upwards. Byte by byte, like the Z80, so an
   * overlapping copy smears exactly the way the original does. A source in
   * $0000-$3FFF is that CPU's ROM.
   * @param {number} dst @param {number} src @param {number} count
   * @param {Cpu} [cpu] whose ROM a low source address refers to
   */
  ldir(dst, src, count, cpu = 'main') {
    for (let i = 0; i < count; i += 1) this.poke(dst + i, this.read(cpu, src + i));
  }

  /** `rst $18`: memset. @param {number} addr @param {number} value @param {number} count */
  fill(addr, value, count) {
    for (let i = 0; i < count; i += 1) this.poke(addr + i, value);
  }

  /**
   * Dip switches as read at $6800+n: bit 0 is DSWB bit n, bit 1 DSWA bit n.
   * @see galaga.cpp bosco_dsw_r
   * @param {number} n 0-7 @returns {number}
   */
  readDsw(n) {
    return ((this.dswB >> n) & 1) | (((this.dswA >> n) & 1) << 1);
  }

  // ------------------------------------------------------- latches, IRQs

  /** @param {number} q @param {number} bit */
  writeMisc(q, bit) {
    const was = this.misc[q];
    this.misc[q] = bit;
    if (q === 0 || q === 1) {
      // Clearing an enable also drops that CPU's IRQ line (irq1_clear_w,
      // irq2_clear_w).
      if (!bit) this.irqLine[q] = false;
      else if (!was) this.hooks.onIrqEnable?.(q);
    }
    if (q === 3 && bit !== was) this.hooks.onRunLatch?.(bit === 1);
  }

  /** `di`. @param {number} [cpu] */
  di(cpu = CPU.MAIN) { this.iff[cpu] = false; }

  /**
   * `ei`. If vblank asserted the IRQ line while interrupts were off, the
   * scheduler runs the handler right here, as the Z80 would take it after
   * the instruction following EI.
   * @param {number} [cpu]
   */
  ei(cpu = CPU.MAIN) {
    this.iff[cpu] = true;
    this.hooks.onIrqEnable?.(cpu);
  }

  // -------------------------------------------------------------- inputs

  /**
   * Press or release a switch.
   * @param {InputName} name @param {boolean} down
   */
  setInput(name, down) {
    const [port, bit] = INPUTS[name];
    this[port] = down ? (this[port] & ~bit) & 0xff : (this[port] | bit);
  }

  /** Power-on: every RAM chip and latch cleared. */
  reset() {
    this.mem.fill(0);
    this.wsg.fill(0);
    this.misc.fill(0);
    this.videoLatch.fill(0);
    this.ioControl = 0;
    this.iff = [false, false, false];
    this.irqLine = [false, false];
    this.writes = 0;
  }
}
