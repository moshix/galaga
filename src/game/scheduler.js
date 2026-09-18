// Copyright 2026 by Moshix
/**
 * Runs the three ported CPUs frame by frame.
 *
 * On the real board three Z80s run truly in parallel on shared RAM. The port
 * replaces that with one fixed order per 1/60.606 s frame, chosen to follow
 * the hardware's own timeline:
 *
 *   line  64   sound CPU NMI          (galaga.cpp cpu3_interrupt_callback)
 *   line 192   sound CPU NMI
 *   line 224   vblank: main and sub CPU IRQs (galaga_state::vblank_irq)
 *              -> the IRQ handlers run to completion (they never wait,
 *                 except at the sprite-copy rendezvous, which cannot block
 *                 in a sequential order -- see f_0828 / f_05BF)
 *   then       each CPU's foreground code runs until it waits again
 *
 * FOREGROUND CODE AS GENERATORS. Each CPU's non-interrupt code (power-on
 * tests, the main CPU's game flow in g_main, the idle loops) is a JavaScript
 * generator. Where the Z80 spins in a loop waiting for an interrupt handler
 * or another CPU to change a variable, the port `yield`s:
 *
 *   yield            wait for the next frame (the condition can only change
 *                    in an interrupt handler, or the loop burns real time)
 *   yield SPIN       a busy-wait on something *another CPU's foreground* may
 *                    change in this same frame (cross-CPU handshakes at boot);
 *                    the scheduler re-runs spinning threads while any thread
 *                    is still making progress
 *
 * Every Galaga IRQ handler ends `ei` / `ret`, so the scheduler clears the
 * interrupt flip-flop on entry and sets it on return, exactly as IM 1 does.
 */

import { CPU } from '../machine/machine.js';

/** Value a foreground generator yields to be re-polled within the frame. */
export const SPIN = Symbol('spin');

/** Sound CPU NMI scan lines. */
export const SOUND_NMI_LINES = Object.freeze([64, 192]);

/**
 * @typedef {import('../machine/machine.js').Machine} Machine
 * @typedef {Generator<symbol|undefined, void, void>} Thread
 * @typedef {object} CpuPorts entry points each ported CPU provides
 * @property {(m: Machine) => Thread} reset  foreground from the reset vector
 * @property {((m: Machine) => void)=} irq    IRQ (rst $38) handler
 * @property {((m: Machine) => void)=} nmi    NMI handler
 */

export class Scheduler {
  /**
   * @param {Machine} m
   * @param {{ main: CpuPorts, sub: CpuPorts, sound: CpuPorts }} cpus
   * @param {{ irqOrder?: number[], onVblank?: () => void }} [options]
   */
  constructor(m, cpus, options = {}) {
    this.m = m;
    this.cpus = [cpus.main, cpus.sub, cpus.sound];
    /**
     * Which vblank IRQ handler runs first. The real CPUs race; the sub CPU's
     * handler is the one that moves the aliens, and the main CPU's tasks
     * consume the result, so sub-first is the default. Configurable so the
     * lock-step tests can tell which order the ROM's behaviour matches.
     */
    this.irqOrder = options.irqOrder ?? [CPU.SUB, CPU.MAIN];
    this.onVblank = options.onVblank ?? null;
    /** @type {(Thread|null)[]} */
    this.threads = [null, null, null];
    /** True while a CPU is inside its interrupt handler. */
    this.inHandler = [false, false, false];
    this.frame = 0;

    m.hooks.onRunLatch = (running) => this.setSubsRunning(running);
    m.hooks.onIrqEnable = (cpu) => this.tryIrq(cpu);
  }

  /** Power on: only the main CPU runs; the latch holds the others in reset. */
  powerOn() {
    this.m.reset();
    this.threads = [this.cpus[CPU.MAIN].reset(this.m), null, null];
  }

  /**
   * Latch Q3 ($6823): releasing it starts the sub and sound CPUs from their
   * reset vectors; asserting it stops them where they are.
   * @param {boolean} running
   */
  setSubsRunning(running) {
    for (const n of [CPU.SUB, CPU.SOUND]) {
      this.threads[n] = running ? this.cpus[n].reset(this.m) : null;
      this.m.iff[n] = false;
      this.inHandler[n] = false;
    }
    if (!running) this.m.irqLine[CPU.SUB] = false;
  }

  /** @param {number} cpu */
  running(cpu) { return this.threads[cpu] !== null; }

  /**
   * Take a pending IRQ if the CPU can accept it.
   * @param {number} cpu
   */
  tryIrq(cpu) {
    const m = this.m;
    if (cpu > CPU.SUB || !m.irqLine[cpu] || !m.iff[cpu] || this.inHandler[cpu]) return;
    const handler = this.cpus[cpu].irq;
    if (handler === undefined || !this.running(cpu)) return;
    m.iff[cpu] = false;
    this.inHandler[cpu] = true;
    handler(m);
    this.inHandler[cpu] = false;
    // Every handler in these ROMs returns through `ei` / `ret`.
    m.iff[cpu] = true;
  }

  /** Advance the whole board by one video frame. */
  stepFrame() {
    const m = this.m;
    for (let i = 0; i < SOUND_NMI_LINES.length; i += 1) {
      if (this.running(CPU.SOUND) && !m.misc[2] && this.cpus[CPU.SOUND].nmi) this.cpus[CPU.SOUND].nmi(m);
    }
    // Vblank asserts the IRQ lines of the CPUs whose enable latch is set.
    if (m.misc[0]) m.irqLine[CPU.MAIN] = true;
    if (m.misc[1] && this.running(CPU.SUB)) m.irqLine[CPU.SUB] = true;
    if (this.onVblank !== null) this.onVblank();
    for (const cpu of this.irqOrder) this.tryIrq(cpu);
    this.runForeground();
    this.frame += 1;
  }

  /**
   * Resume every CPU's foreground once, then keep re-polling the threads
   * that yielded SPIN for as long as some thread is still writing memory.
   */
  runForeground() {
    const m = this.m;
    /** @type {boolean[]} */
    const spinning = [false, false, false];
    for (let n = 0; n < 3; n += 1) spinning[n] = this.resume(n);
    for (let round = 0; round < 64 && spinning.some(Boolean); round += 1) {
      const before = m.writes;
      for (let n = 0; n < 3; n += 1) if (spinning[n]) spinning[n] = this.resume(n);
      if (m.writes === before) break;
    }
  }

  /**
   * @param {number} n
   * @returns {boolean} true if the thread yielded SPIN
   */
  resume(n) {
    const t = this.threads[n];
    if (t === null) return false;
    const r = t.next();
    if (r.done) {
      // Foreground code on these boards never returns; if a port does, that
      // is a bug worth hearing about rather than a silently idle CPU.
      this.threads[n] = null;
      throw new Error(`CPU ${n} foreground returned`);
    }
    return r.value === SPIN;
  }
}
