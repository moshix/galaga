// Copyright 2026 by Moshix
/**
 * A Galaga-shaped test rig around the 51XX: the LLE chip, the 06XX bus
 * model, a simulated screen (vblank edges on the real frame timing) and,
 * optionally, the HLE (src/machine/namco51.js) wired to the very same pins.
 *
 * The HLE is attached through a "tee" that sits in chip-select slot 0 next
 * to the LLE: every pin-level event the LLE sees (reset, vblank, strobe,
 * data write, data read, end of transfer) is translated, in the same order,
 * into the HLE's documented call protocol (reset / setInputs + vblank /
 * write / beginRead / read). So the HLE is driven exactly as the browser
 * port is meant to drive it, and a divergence is a real behaviour
 * difference rather than an artefact of the rig.
 */
import { Namco51 as Namco51Lle } from './namco51.mjs';
import { Bus06, FRAME_Z80 } from './bus06.mjs';

/**
 * @typedef {object} HleLike
 * @property {() => void} reset
 * @property {(in0: number, in1: number) => void} setInputs
 * @property {() => void} vblank
 * @property {(byte: number) => void} write
 * @property {() => void} beginRead
 * @property {() => number} read
 */

/** LLE (+ optional HLE) 51XX on a Galaga 06XX bus with a running screen. */
export class Session51 {
  /**
   * @param {object} options
   * @param {Uint8Array} options.rom       51xx.bin
   * @param {HleLike|null} [options.hle]   HLE to drive in lockstep
   * @param {number} [options.frameOrigin] Z80 time of the first vblank start
   */
  constructor({ rom, hle = null, frameOrigin = 40000 }) {
    /** Galaga IN0 / IN1, active low. Change them between frames. */
    this.in0 = 0xff;
    this.in1 = 0xff;
    /** Index of the frame whose vblank began most recently (-1 = none yet). */
    this.frame = -1;
    /** P port writes seen from each implementation. */
    this.lleP = [];
    this.hleP = [];
    /** Bytes returned by the HLE's read() calls, in order. */
    this.hleReads = [];
    /** Optional per-frame hook, run at vblank start before the chips see it. */
    /** @type {((frame: number) => void)|null} */
    this.onFrame = null;
    this.hle = hle;

    this.lle = new Namco51Lle({
      rom,
      in: [() => this.in0 & 0x0f, () => this.in0 >> 4, () => this.in1 & 0x0f, () => this.in1 >> 4],
      onOutput: (p) => this.lleP.push(p),
    });

    // The screen starts outside vblank, so /TC is asserted: MAME's m_ctr
    // powers up 0 and the first falling edge needs a prior assert.
    this.lle.vblank(0);

    const lle = this.lle;
    const self = this;
    let rwLevel = 0;
    let csLevel = 0;
    let inRead = false;
    /** The tee: LLE gets every pin event; HLE gets the protocol calls. */
    const tee = {
      run: (z) => lle.run(z),
      rw(state) { rwLevel = state; lle.rw(state); },
      chipSelect(state) {
        lle.chipSelect(state);
        // First read-mode strobe of a transfer = beginRead(). Write-mode
        // strobes are delivered with their data in write(), and later
        // read-mode strobes by read(), mirroring the NMI handler.
        if (hle && state && !csLevel && rwLevel && !inRead) {
          inRead = true;
          hle.beginRead();
        }
        csLevel = state;
      },
      write(data) { lle.write(data); if (hle) hle.write(data); },
      read() {
        if (hle) self.hleReads.push(hle.read());
        return lle.read();
      },
      vblank(state) {
        lle.vblank(state);
        if (hle && state) {
          hle.setInputs(self.in0, self.in1);
          hle.vblank();
        }
      },
      endTransfer() { inRead = false; },
    };

    this.bus = new Bus06({
      chips: [tee, null, null, null],
      frameOrigin,
      onVblank: (state) => {
        if (!state) return;
        this.frame += 1;
        if (this.onFrame) this.onFrame(this.frame);
      },
    });
  }

  /**
   * Power up: hold the chip in reset for a while, then release it (as the
   * main CPU does through the misc latch) and let the init code run.
   * @returns {void}
   */
  boot() {
    this.lle.reset(0);
    this.bus.advanceTo(2000);
    this.lle.reset(1);
    if (this.hle) this.hle.reset();
    this.bus.advanceTo(10000);
  }

  /**
   * Advance to `offset` Z80 cycles after the start of the NEXT frame whose
   * start + offset is still in the future.
   * @param {number} offset
   * @returns {void}
   */
  waitFrameOffset(offset) {
    const origin = this.bus.frameOrigin ?? 0;
    // Smallest frame k with origin + k * FRAME + offset strictly after now.
    const k = Math.max(0, Math.ceil((this.bus.now + 1 - origin - offset) / FRAME_Z80));
    const t = origin + k * FRAME_Z80 + offset;
    this.bus.advanceTo(t);
  }

  /**
   * One Galaga-style read transfer from the 51XX.
   * @param {number} [control] 0x71 (per frame) or 0xB1 (startup)
   * @returns {{lle: number[], hle: number[]}}
   */
  read3(control = 0x71) {
    const before = this.hleReads.length;
    const lle = this.bus.transfer(control, 3);
    return { lle, hle: this.hleReads.slice(before) };
  }

  /**
   * One Galaga-style write transfer to the 51XX.
   * @param {number} control  e.g. 0xA1, 0xE1, 0x61
   * @param {number[]} bytes
   * @returns {void}
   */
  write(control, bytes) {
    this.bus.transfer(control, bytes);
  }

  /**
   * Galaga's start-up conversation (main ROM $35D7 and $3737-$3766):
   * switch mode, then coinage + credit mode + remap off, then a B1 read.
   * The gaps match the main CPU's code path between transfers.
   * @param {number[]} coinage  the 4 "set coinage" arguments
   * @returns {{lle: number[], hle: number[]}} the B1 read
   */
  galagaStartup(coinage = [1, 1, 1, 1]) {
    this.waitFrameOffset(9000);
    this.write(0xa1, [5, 5, 5, 5]);
    this.waitFrameOffset(9000);
    this.write(0xe1, [1, ...coinage, 2, 3, 0]);
    // E1's `ld (hl),$10` -> NMI exit, c_io_cmd_wait, B1 set-up: ~144 cycles.
    this.bus.advanceTo(this.bus.now + 144);
    return this.read3(0xb1);
  }
}
