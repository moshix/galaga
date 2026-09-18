// Copyright 2026 by Moshix
/**
 * Main CPU reset path and vblank interrupt handler (int.s, task_man.s).
 *
 *   $0000  reset vector: 06XX control to idle, jp CPU0_RESET
 *   $02C4  CPU0_RESET: im 1, clear $99E0-$99EF, jp jp_RAM_test ($336C)
 *   $0038  rst $38 / IM 1 vector: jp jp_Task_man
 *   $0237  jp_Task_man: starfield control, watchdog, the task manager,
 *          then the per-frame 51XX switch read
 *
 * @see reference/galaga-main.asm $0000, $0038, $0237-$02D0
 */

import { MAIN, mainAt } from './routines.js';
import { call } from '../call.js';
import { rrca } from '../z80ops.js';
import { mainState } from './gg1_1_state.js';

/**
 * @typedef {import('../../machine/machine.js').Machine} Machine
 * @typedef {Generator<symbol|undefined, void, void>} Thread
 */

/**
 * The reset vector: the main CPU's whole foreground thread.
 *
 *   $0000: ld a,$10 / ld ($7100),a / jp $02C4
 *
 * Besides running CPU0_RESET, this generator is the "program counter" the
 * port needs for f_0977's jump from the interrupt handler to the RAM test
 * (see gg1_1_state.js): it drives the game-flow generator itself and, when
 * a restart has been requested, drops it and starts jp_RAM_test afresh --
 * the Z80 simply abandoned whatever it had been doing.
 * @see galaga-main.asm $0000
 * @param {Machine} m
 * @returns {Thread}
 */
export function* main_reset(m) {
  // $0000: reset/clear the 06XX command state (not a transfer: no io.transfer).
  m.poke(0x7100, 0x10);
  const st = mainState(m);
  st.ramTest = false;
  /** @type {Generator<symbol|undefined, unknown, void>} */
  let inner = CPU0_RESET(m);
  for (;;) {
    for (;;) {
      const r = inner.next();
      if (r.done) throw new Error('main CPU foreground returned');
      // A restart requested by an IRQ that ran inside this slice (m.ei()).
      if (st.ramTest) break;
      yield r.value;
      // ... or by the vblank IRQ that ran while we were suspended.
      if (st.ramTest) break;
    }
    inner.return(undefined);
    st.ramTest = false;
    // $097C: jp z,$336C
    inner = call(MAIN.jp_RAM_test, m);
  }
}

/**
 * $02C4 CPU0_RESET: `im 1` (the port's scheduler always uses IM 1), clear
 * the 16 bytes of machine data at $99E0, then jp jp_RAM_test ($336C, in the
 * $3000 range), which never returns (it ends in jp j_Game_init).
 * @see galaga-main.asm $02C4
 * @param {Machine} m
 * @returns {Generator<symbol|undefined, unknown, void>}
 */
export function* CPU0_RESET(m) {
  for (let i = 0; i < 0x10; i += 1) m.poke(0x99e0 + i, 0);
  return yield* call(MAIN.jp_RAM_test, m);
}

/**
 * $0237 jp_Task_man: the vblank (rst $38) handler.
 *
 *  1. $0241: starfield control. Bits 3-4 of a value derived from the frame
 *     counter, OR'ed with the star-control parameter ($99BE, or 7 when the
 *     freeze dip switch is on), written to $A000-$A004 one bit per latch
 *     (the value is rotated right between writes).
 *  2. Kick the watchdog with whatever A holds, disable IRQ1 ($6820 = 0).
 *  3. Freeze switch on: skip straight to re-enabling IRQ1.
 *  4. The task manager: walk ds_cpu0_task_actv ($9000); a non-zero entry
 *     runs the task at the same index of d_cpu0_task_table ($0096), then
 *     the index advances by the entry's own value (1 normally, $20 to stop
 *     after this task). Zero entries are skipped one at a time. The loop
 *     ends when the index reaches $20 or more.
 *  5. Start the 3-byte 51XX switch read into $99B5 (the 06XX NMIs do it).
 *  6. Re-enable IRQ1.
 *
 * The scheduler clears and restores the interrupt flip-flop around the call
 * (IM 1 and the final `ei`).
 * @see galaga-main.asm $0237
 * @param {Machine} m
 */
export function main_irq(m) {
  const d = m.peek(0x6804); // DSWA freeze switch in bit 1 (active low)
  // $0245: c = ((f & $1C) ^ ((f & $1C) >>> 1 rotated)) & $18
  let c = m.peek(0x92a0) & 0x1c;
  c = (rrca(c).a ^ c) & 0x18;
  let a = (d & 0x02) ? m.peek(0x99be) : 0x07;
  a = (a & 0x07) | c;
  // $025C: five latches, one bit each (the latch keeps bit 0 only).
  for (let i = 0; i < 5; i += 1) {
    m.poke(0xa000 + i, a);
    a = rrca(a).a;
  }
  m.poke(0x6830, a); // watchdog
  m.poke(0x6820, 0); // IRQ1 off while the tasks run

  if (d & 0x02) {
    // $0272: C = 0 ... the scheduler loop.
    let ci = 0;
    do {
      // $0273: skip empty slots. HL = $9000 + C with an 8-bit add (L only).
      let b;
      while ((b = m.peek(0x9000 | ci)) === 0) ci = (ci + 1) & 0xff;
      // $0281: pointer at $0096 + 2C, again an 8-bit add into L (H = 0).
      const p = (0x96 + ((ci << 1) & 0xff)) & 0xff;
      const task = m.read('main', p) | (m.read('main', p + 1) << 8);
      // $028E: call c_task_switcher -> jp (hl)
      mainAt(task)(m);
      // f_0977 may have jumped to the RAM test: the Z80 never comes back,
      // so neither the 51XX read nor the IRQ1 re-enable happens.
      if (mainState(m).ramTest) return;
      ci = (b + ci) & 0xff;
    } while ((ci & 0xe0) === 0);

    // $0299: HL'=$7000 DE'=$99B5 BC'=3, then $71 -> $7100.
    if (m.io) {
      m.io.transfer(0x71, 0x99b5, 3);
    } else {
      // No bus installed (unit tests): the command write is all that
      // happens, and the transfer "completes" at once with nothing read.
      m.poke(0x7100, 0x71);
      m.poke(0x7100, 0x10);
    }
  }
  // $02A8: IRQ1 back on.
  m.poke(0x6820, 1);
}
