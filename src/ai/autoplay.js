// Copyright 2026 by Moshix
/**
 * Placeholder for the self-playing AI; the real one replaces this file.
 * It must keep this API: constructor(machine), step() once per frame
 * before the machine samples its inputs, release() to let go of every
 * switch it holds.
 */
export class AutoPlayer {
  /** @param {import('../machine/machine.js').Machine} machine */
  constructor(machine) { this.m = machine; }
  step() {}
  release() {}
}
