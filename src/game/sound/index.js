// Copyright 2026 by Moshix
/** The sound CPU: registers gg1_7 and exposes its entry points. */
import './gg1_7.js';
import { SOUND } from './routines.js';

/** @type {import('../scheduler.js').CpuPorts} */
export const soundCpu = {
  /** Reset vector $0000. */
  reset: (m) => SOUND.sound_reset(m),
  /** NMI vector $0066, twice a frame. */
  nmi: (m) => SOUND.sound_nmi(m),
};
