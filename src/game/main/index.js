// Copyright 2026 by Moshix
/**
 * The main CPU: loads every module (each registers its routines into
 * MAIN / MAIN_AT) and exposes the entry points the scheduler drives.
 */
import './gg1_1.js';
import './gg1_2.js';
import './gg1_3.js';
import './gg1_4.js';
import { MAIN } from './routines.js';

/** @type {import('../scheduler.js').CpuPorts} */
export const mainCpu = {
  /** Reset vector $0000. */
  reset: (m) => MAIN.main_reset(m),
  /** rst $38 / IM 1 vector: the task manager at $0237. */
  irq: (m) => MAIN.main_irq_steps(m),
};
