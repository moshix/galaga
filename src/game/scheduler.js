// Copyright 2026 by Moshix
/**
 * Runs the three ported CPUs frame by frame.
 *
 * On the real board three Z80s run truly in parallel on shared RAM. The port
 * replaces that with one fixed order per 1/60.606 s frame, chosen to follow
 * the hardware's own timeline:
 *
 *   line 160   (FRAME_LINE: where a port frame starts)
 *   line 192   sound CPU NMI          (galaga.cpp cpu3_interrupt_callback)
 *   line 224   vblank: main and sub CPU IRQs (galaga_state::vblank_irq)
 *              -> the IRQ handlers run to completion (they never wait,
 *                 except at the sprite-copy rendezvous, which cannot block
 *                 in a sequential order -- see f_0828 / f_05BF)
 *   then       each CPU's foreground code runs until it waits again
 *   line  64   sound CPU NMI (of the next board frame)
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
 *
 * THE VBLANK RENDEZVOUS. An IRQ handler may be a generator that yields
 * RENDEZVOUS once. At vblank the scheduler runs every handler up to that
 * point first (in irqOrder), then lets each run to completion (same order).
 */

import { CPU } from '../machine/machine.js';

/** Value a foreground generator yields to be re-polled within the frame. */
export const SPIN = Symbol('spin');

/**
 * Yielded by foreground code at a Z80 `halt`: sleep until the next vblank
 * interrupt. It differs from a plain `yield` only when the CPU is still
 * busy with work carried over from earlier frames (Machine.charge): the
 * `halt` is reached only once that work is done, so it wakes one interrupt
 * after that, not at the next one.
 */
export const HALT = Symbol('halt');

/**
 * Yielded by foreground code right after charging measured time
 * (Machine.charge) for a stretch of work: "this took the Z80 that long".
 * The scheduler resumes the code at once if the time fits in what is left
 * of the frame, and otherwise only once the frames it spills into have
 * passed -- so whatever comes next happens when it does on the board.
 */
export const BUSY = Symbol('busy');

/**
 * Yielded by an IRQ handler generator at the vblank rendezvous: right after
 * the main CPU's f_0828 and the sub CPU's f_05BF have each copied their half
 * of the sprite buffers to the sprite registers, and before either CPU does
 * anything else. On the board the two handlers start at the same instant and
 * wait for each other there, so both copies see the sprite buffers as the
 * previous frame left them -- before the sub CPU moves any enemy.
 */
export const RENDEZVOUS = Symbol('rendezvous');

/** Z80 cycles in one video frame: 384 * 264 pixel clocks / 2. */
export const CYCLES_PER_FRAME = 50688;

/**
 * Z80 cycles the main CPU's vblank handler spends besides whatever its
 * routines explicitly charge (Machine.charge). Measured on the oracle: the
 * handler that includes the 49,723-cycle attract step takes 63,631 in all,
 * leaving about 13,900; ordinary handlers take 11,000-15,000. Only the
 * comparison with a frame matters, and only heavy routines charge, so the
 * margin is wide either way.
 */
export const MAIN_IRQ_BASE_CYCLES = 13000;

/**
 * Roughly how long the sub CPU's handler takes to move every enemy after the
 * rendezvous. Main tasks that start later than this see the moved enemies,
 * so once the main handler has been charged more than this, its remaining
 * tasks run after the sub CPU's. Any value below the smallest heavy charge
 * (18,296) and above zero gives the same result today.
 */
export const SUB_OVERLAP_CYCLES = 8000;

/** The sub CPU's task slot that moves the enemies (f_08D3). */
export const SUB_MOTION_SLOT = 2;

/**
 * Thrown by ported code where the Z80 would loop forever (for example the
 * wave builder on the wrapped-around stage 0 at some ranks). The scheduler
 * parks that CPU's foreground for good -- interrupts keep being serviced,
 * exactly like a real Z80 spinning in place -- instead of locking up the
 * browser in a JavaScript infinite loop. Throw it only after doing every
 * write the endless loop would have settled into.
 */
export class CpuHang extends Error {
  /** @param {string} where */
  constructor(where) {
    super(`CPU loops forever at ${where}`);
    this.name = 'CpuHang';
  }
}

/** A foreground that does nothing, forever. @returns {Thread} */
function* parked() { for (;;) yield; }

/** Sound CPU NMI scan lines. */
export const SOUND_NMI_LINES = Object.freeze([64, 192]);

/**
 * Where a port frame begins and ends, as a scan line of the board's frame.
 * The port's frame k covers the board from this line of frame k to this line
 * of frame k+1, which is also where the lock-step tests sample the oracle.
 * It must fall after both vblank handlers have finished (the sub CPU's runs
 * until about line 103 of the next frame) and before the next sound NMI at
 * line 192, so that the sampled board is quiet and the port's frame has done
 * exactly the same work: sound NMI (192), vblank (224), sound NMI (64).
 */
export const FRAME_LINE = 160;

/**
 * The main foreground's time on either side of the vblank handlers within
 * one port frame (FRAME_LINE to FRAME_LINE): before vblank, and after it.
 */
export const PRE_SLOT_CYCLES = (224 - FRAME_LINE) * 192;
export const POST_SLOT_CYCLES = CYCLES_PER_FRAME - PRE_SLOT_CYCLES;

/**
 * @typedef {import('../machine/machine.js').Machine} Machine
 * @typedef {Generator<symbol|undefined, void, void>} Thread
 * @typedef {object} CpuPorts entry points each ported CPU provides
 * @property {(m: Machine) => Thread} reset  foreground from the reset vector
 * @property {((m: Machine) => (void|Thread))=} irq  IRQ (rst $38) handler;
 *           a generator handler may yield RENDEZVOUS once
 * @property {((m: Machine) => void)=} nmi    NMI handler
 */

export class Scheduler {
  /**
   * @param {Machine} m
   * @param {{ main: CpuPorts, sub: CpuPorts, sound: CpuPorts }} cpus
   * @param {{ irqOrder?: number[], mainSplit?: number, mainLate?: number, onVblank?: () => void }} [options]
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
    /**
     * After the rendezvous the two CPUs overlap: the main CPU works down its
     * task list while the sub CPU moves every enemy. The port runs the main
     * CPU's tasks in slots below `mainSplit` first, then the whole rest of
     * the sub CPU's handler, then the remaining main tasks. The value is the
     * one under which the lock-step tests match the ROM best
     * (tools/lockstep-run.mjs, measured over attract mode and played games).
     */
    this.mainSplit = options.mainSplit ?? 9;
    /**
     * The vblank timeline after the rendezvous, as [cpu, before-slot] steps
     * (see stepFrame). Measured on the oracle, in cycles after vblank: the
     * main CPU runs its tasks from about +5,000; the sub CPU moves every
     * enemy (its task 2) from about +4,900 to +18,000, then moves shots and
     * checks collisions (tasks 4 and 5). Main tasks early in its list start
     * before the sub's motion pass has got far; the ones after `mainLate`
     * (player movement and firing, which have a lot of work ahead of them in
     * a busy frame) start after the sub's collision tasks. Which exact slots
     * split best was measured with tools/lockstep-run.mjs over attract mode
     * and played games; the true order varies from frame to frame with the
     * workload, which is what the remaining one-frame blips are.
     * @type {Array<[number, number]>}
     */
    this.phases = [
      [CPU.MAIN, this.mainSplit],
      [CPU.SUB, SUB_MOTION_SLOT + 1],
      [CPU.MAIN, options.mainLate ?? 12],
      [CPU.SUB, Infinity],
      [CPU.MAIN, Infinity],
    ];
    /** Why each CPU's foreground is hung, if it is (CpuHang). @type {(string|null)[]} */
    this.hung = [null, null, null];
    /** Cycles the main handler charged this frame (for the foreground budget). */
    this.irqCharged = 0;
    /** Main foreground work still owed from earlier frames, in cycles. */
    this.fgDebt = 0;
    /** What each foreground last yielded (SPIN, HALT or undefined). @type {unknown[]} */
    this.lastYield = [undefined, undefined, undefined];
    /** Slot each CPU's handler is paused before, if any. @type {(number|null)[]} */
    this.pendingSlot = [null, null, null];
    /** @type {(Thread|null)[]} */
    this.threads = [null, null, null];
    /** True while a CPU is inside its interrupt handler. */
    this.inHandler = [false, false, false];
    this.frame = 0;
    /**
     * A main vblank handler that runs past the next vblank keeps its IRQ
     * enable latch clear the whole time ($026A ... $02A8), so that vblank
     * finds the enable off and asserts nothing: the board loses one main
     * interrupt, and the handler's remaining tasks run in the next frame.
     */
    /**
     * The rest of a main vblank handler that ran past the next vblank.
     * @type {Thread | null}
     */
    this.mainTail = null;

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
   * @param {boolean} [park] stop a generator handler at RENDEZVOUS and
   *   return it instead of finishing it
   * @returns {Thread | null} the parked handler, if any
   */
  tryIrq(cpu, park = false) {
    const m = this.m;
    if (cpu > CPU.SUB || !m.irqLine[cpu] || !m.iff[cpu] || this.inHandler[cpu]) return null;
    const handler = this.cpus[cpu].irq;
    if (handler === undefined || !this.running(cpu)) return null;
    m.iff[cpu] = false;
    this.inHandler[cpu] = true;
    const r = handler(m);
    if (isIterator(r)) {
      const t = /** @type {Thread} */ (r);
      if (park) {
        // Run up to the rendezvous (past the progress markers of any task
        // before the sprite copy).
        let r = t.next();
        while (!r.done && typeof r.value === 'number') r = t.next();
        if (!r.done && r.value === RENDEZVOUS) return t;
        if (!r.done) this.drain(t);
      } else {
        this.drain(t);
      }
    }
    this.leaveIrq(cpu);
    return null;
  }

  /** Run a handler generator to the end. @param {Thread} t */
  drain(t) {
    for (let r = t.next(); !r.done; r = t.next()) { /* past the rendezvous */ }
  }

  /** @param {number} cpu */
  leaveIrq(cpu) {
    this.inHandler[cpu] = false;
    // Every handler in these ROMs returns through `ei` / `ret`.
    this.m.iff[cpu] = true;
  }

  /** Advance the whole board by one video frame. */
  stepFrame() {
    const m = this.m;
    this.soundNmi(); // line 192
    this.preForeground(); // FRAME_LINE .. vblank
    // Vblank asserts the IRQ lines of the CPUs whose enable latch is set. A
    // main handler still running from last frame has its latch clear, so
    // this vblank is simply lost for it.
    if (m.misc[0]) m.irqLine[CPU.MAIN] = true;
    if (m.misc[1] && this.running(CPU.SUB)) m.irqLine[CPU.SUB] = true;
    if (this.onVblank !== null) this.onVblank();

    // Both handlers up to the rendezvous, then both to the end.
    /** @type {Array<[number, Thread]>} */
    const parked = [];
    const tail = this.mainTail;
    this.mainTail = null;
    if (tail === null) m.charged = 0;
    this.pendingSlot[CPU.SUB] = null;
    if (tail === null) this.pendingSlot[CPU.MAIN] = null;
    for (const cpu of this.irqOrder) {
      const t = this.tryIrq(cpu, true);
      if (t !== null) parked.push([cpu, t]);
    }
    const main = parked.find(([cpu]) => cpu === CPU.MAIN);
    const sub = parked.find(([cpu]) => cpu === CPU.SUB);
    // After the rendezvous the two handlers overlap. VBLANK_PHASES is the
    // order the port runs them in: each entry runs one CPU up to (not
    // including) a task slot. See the table's comment.
    for (const [cpu, before] of this.phases) {
      const entry = cpu === CPU.MAIN ? main : sub;
      if (entry === undefined || !this.inHandler[cpu] || this.mainTail === entry[1]) continue;
      if (cpu === CPU.MAIN) this.runMain(entry[1], before);
      else this.runSub(entry[1], before);
    }
    // Last frame's overrunning main handler finishes after this frame's
    // sub handler: that is where its remaining tasks really ran.
    if (tail !== null) this.runMain(tail, Infinity);
    this.irqCharged = m.charged;
    this.runForeground();
    this.soundNmi(); // line 64 of the next board frame
    this.frame += 1;
  }

  /** The sound CPU's NMI, if it runs and its NMI is enabled (latch Q2 low). */
  soundNmi() {
    if (this.running(CPU.SOUND) && !this.m.misc[2] && this.cpus[CPU.SOUND].nmi) this.cpus[CPU.SOUND].nmi(this.m);
  }

  /**
   * Run the sub CPU's handler until it is about to run a task in slot
   * `before` or later, or to the end.
   * @param {Thread} t @param {number} before
   * @returns {boolean} true if it stopped early and still has work
   */
  runSub(t, before) {
    return this.runUntil(CPU.SUB, t, before);
  }

  /**
   * Resume a handler generator. It pauses *before* each task, yielding the
   * task's slot; a pause at slot >= `before` is where this run stops -- and
   * the next resume will run that very task.
   * @param {number} cpu @param {Thread} t @param {number} before
   * @returns {boolean} true if it stopped early and still has work
   */
  runUntil(cpu, t, before) {
    const pending = this.pendingSlot[cpu];
    if (pending !== null && pending >= before) return true;
    this.pendingSlot[cpu] = null;
    for (;;) {
      const r = t.next();
      if (r.done) { this.leaveIrq(cpu); return false; }
      if (cpu === CPU.MAIN && MAIN_IRQ_BASE_CYCLES + this.m.charged > CYCLES_PER_FRAME) {
        // Ran past the next vblank: the rest belongs to the next frame.
        this.m.charged = 0;
        this.mainTail = t;
        this.pendingSlot[cpu] = typeof r.value === 'number' ? r.value : null;
        return false;
      }
      if (typeof r.value === 'number' && r.value >= before) {
        this.pendingSlot[cpu] = r.value;
        return true;
      }
      // A long task pushes the rest of main's work past the sub CPU's.
      if (cpu === CPU.MAIN && before !== Infinity && this.m.charged > SUB_OVERLAP_CYCLES) {
        this.pendingSlot[cpu] = typeof r.value === 'number' ? r.value : null;
        return true;
      }
    }
  }

  /**
   * Run the main CPU's handler until it is about to run a task in slot
   * `before` or later (or to the end), or until the time charged to it
   * passes the next vblank -- in which case the rest is parked in
   * `mainTail` and runs next frame.
   * @param {Thread} t @param {number} before
   * @returns {boolean} true if it stopped early and still has work
   */
  runMain(t, before) {
    return this.runUntil(CPU.MAIN, t, before);
  }


  /**
   * Resume every CPU's foreground once, then keep re-polling the threads
   * that yielded SPIN for as long as some thread is still writing memory.
   */
  runForeground() {
    const m = this.m;
    /** @type {boolean[]} */
    const spinning = [false, false, false];
    // The main CPU's foreground gets what its vblank handler leaves of the
    // port frame, up to FRAME_LINE. Work it charged beyond that (a playfield
    // clear is most of a frame) keeps the real Z80 busy into the following
    // frames, so the port holds its foreground back for as long -- the work
    // itself already happened, but nothing after it can happen any sooner
    // than on the board. (The stretch from FRAME_LINE to vblank is spent in
    // preForeground at the start of the next frame.)
    const budget = Math.max(0, POST_SLOT_CYCLES - MAIN_IRQ_BASE_CYCLES - this.irqCharged);
    let mainFree = this.fgDebt < budget;
    if (!mainFree) this.fgDebt -= budget;
    else if (this.fgDebt > 0 && this.lastYield[CPU.MAIN] === HALT) {
      // The work finishes this frame and only then reaches the `halt`,
      // which sleeps until the next interrupt.
      this.fgDebt = 0;
      mainFree = false;
    }
    const chargedBefore = m.charged;
    for (let n = 0; n < 3; n += 1) {
      if (n === CPU.MAIN && !mainFree) continue;
      spinning[n] = this.resume(n);
      // Carry on after a BUSY while the charged time still fits the frame.
      while (n === CPU.MAIN && this.lastYield[n] === BUSY
        && this.fgDebt + (m.charged - chargedBefore) <= budget) {
        spinning[n] = this.resume(n);
      }
    }
    for (let round = 0; round < 64 && spinning.some(Boolean); round += 1) {
      const before = m.writes;
      for (let n = 0; n < 3; n += 1) if (spinning[n]) spinning[n] = this.resume(n);
      if (m.writes === before) break;
    }
    if (mainFree) {
      const spent = this.fgDebt + (m.charged - chargedBefore);
      this.fgDebt = Math.max(0, spent - budget);
    }
  }

  /**
   * The stretch of the board frame from FRAME_LINE to vblank, where the
   * main CPU's foreground runs BEFORE this frame's vblank handlers. Only
   * work carried over from earlier frames can be in progress there; when it
   * finishes in this stretch, what follows it on the Z80 (unless that is a
   * `halt`) also happens before the handlers, so the port resumes it here.
   */
  preForeground() {
    const m = this.m;
    if (this.fgDebt === 0 || this.threads[CPU.MAIN] === null || this.inHandler[CPU.MAIN]) return;
    if (this.fgDebt > PRE_SLOT_CYCLES) { this.fgDebt -= PRE_SLOT_CYCLES; return; }
    const left = PRE_SLOT_CYCLES - this.fgDebt;
    this.fgDebt = 0;
    // A `halt` reached here wakes at this frame's interrupt: resume it in
    // the normal slot, after the handlers.
    if (this.lastYield[CPU.MAIN] === HALT) return;
    const chargedBefore = m.charged;
    this.resume(CPU.MAIN);
    while (this.lastYield[CPU.MAIN] === BUSY && m.charged - chargedBefore <= left) this.resume(CPU.MAIN);
    this.fgDebt = Math.max(0, m.charged - chargedBefore - left);
    // Charged here, not by a handler: don't let the handler budget see it.
    m.charged = chargedBefore;
  }

  /**
   * @param {number} n
   * @returns {boolean} true if the thread yielded SPIN
   */
  resume(n) {
    const t = this.threads[n];
    // A CPU still inside an interrupt handler runs no foreground code.
    if (this.inHandler[n]) return false;
    if (t === null) return false;
    let r;
    try {
      r = t.next();
    } catch (e) {
      if (!(e instanceof CpuHang)) throw e;
      this.threads[n] = parked();
      this.hung[n] = e.message;
      return false;
    }
    if (r.done) {
      // Foreground code on these boards never returns; if a port does, that
      // is a bug worth hearing about rather than a silently idle CPU.
      this.threads[n] = null;
      throw new Error(`CPU ${n} foreground returned`);
    }
    this.lastYield[n] = r.value;
    return r.value === SPIN;
  }
}

/** @param {unknown} r @returns {boolean} */
function isIterator(r) {
  return r !== null && typeof r === 'object'
    && typeof /** @type {{next?: unknown}} */ (r).next === 'function';
}
