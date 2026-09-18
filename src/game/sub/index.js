// Copyright 2026 by Moshix
/** The sub CPU: registers gg1_5 and exposes its entry points. */
import './gg1_5.js';
import { SUB } from './routines.js';

/** @type {import('../scheduler.js').CpuPorts} */
export const subCpu = {
  /** Reset vector $0000. */
  reset: (m) => SUB.sub_reset(m),
  /** IM 1 vector $0038. */
  irq: (m) => SUB.sub_irq_steps(m),
};
