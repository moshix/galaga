// Copyright 2026 by Moshix
/**
 * The 06XX custom-chip bus, at the level the game code sees it.
 *
 * On the board the main CPU talks to the 51XX (switches, coins, credits) and
 * the 54XX (explosion noise) through the 06XX. It loads HL', DE' and BC' with
 * a source, a destination and a count, writes a command to $7100, and the
 * 06XX then fires an NMI every few hundred cycles; each NMI moves exactly one
 * byte with `ldi` (main CPU $0066). When BC' reaches zero the handler writes
 * $10 to $7100, which is what `c_io_cmd_wait` ($37F6) polls for.
 *
 * The whole transfer finishes within a frame, long before anything reads the
 * result, so the port performs it in one go at the point the command is
 * issued. The NMI handler's other job -- starting the 54XX "fighter hit"
 * explosion when $9AB9 is set -- runs at the same point, as it does on the
 * board when the previous transfer completes.
 *
 *   control $71  read 3 bytes from the 51XX          (every vblank, $02A3)
 *   control $A1  write to the 51XX                    (coinage/mode commands)
 *   control $A8  write to the 54XX                    (noise parameters/triggers)
 *   control $10  idle; transfer complete
 *
 * @see reference/galaga-main.asm $0066 (NMI), $0299-$02A5, $37F6
 * @see reference/mame/namco06.cpp
 */

import { mainRom } from './romdata.js';

/** 06XX control values the ROM uses. */
export const IO = Object.freeze({
  IDLE: 0x10,
  READ_51XX: 0x71,
  WRITE_51XX: 0xa1,
  WRITE_54XX: 0xa8,
});

/** $9AB9: set by the game when the fighter is hit; the NMI plays the explosion. */
export const FIGHTER_HIT_SOUND = 0x9ab9;
/** $0092: the four 54XX command bytes the NMI handler sends for it. */
export const HIT_SOUND_BYTES = 0x0092;

/**
 * A device on the bus, as the port models it.
 * @typedef {object} IoChip
 * @property {(byte: number) => void} write
 * @property {() => number} [read]
 * @property {() => void} [beginRead]  called once before a read transfer
 */

/**
 * @typedef {import('../machine/machine.js').Machine} Machine
 */

export class IoBus {
  /**
   * @param {Machine} m
   * @param {{ n51: IoChip, n54: IoChip }} chips
   */
  constructor(m, chips) {
    this.m = m;
    this.n51 = chips.n51;
    this.n54 = chips.n54;
  }

  /**
   * Issue a command and run the transfer to completion, as the NMI chain
   * would. Chip select is the low nibble of `control`: bit 0 = 51XX,
   * bit 3 = 54XX. Bit 4 set means the chip is read.
   *
   * @param {number} control value written to $7100
   * @param {number} addr    RAM destination (read) or ROM/RAM source (write);
   *                         what the ROM loads into DE' or HL'
   * @param {number} count   what the ROM loads into BC'
   */
  transfer(control, addr, count) {
    const m = this.m;
    m.poke(0x7100, control);
    const chip = (control & 0x01) ? this.n51 : (control & 0x08) ? this.n54 : null;
    // The 51XX loads each byte on the strobe *before* the CPU reads it, so a
    // read transfer starts over at byte 0. @see src/machine/namco51.js
    if ((control & 0x10) && chip !== null && chip.beginRead) chip.beginRead();
    for (let i = 0; i < count; i += 1) {
      if (control & 0x10) {
        // 06xx data_r: 0xFF ANDed with each selected chip.
        const v = chip && chip.read ? chip.read() : 0xff;
        m.poke(addr + i, v);
      } else if (chip !== null) {
        chip.write(m.read('main', addr + i));
      }
    }
    this.complete();
  }

  /**
   * What the NMI handler does after the last byte ($006C-$008C): signal
   * completion, then, if the fighter-hit flag is up, clear it and start the
   * four-byte 54XX explosion command.
   */
  complete() {
    const m = this.m;
    m.poke(0x7100, IO.IDLE);
    if (m.peek(FIGHTER_HIT_SOUND) !== 0) {
      m.poke(FIGHTER_HIT_SOUND, 0);
      m.poke(0x7100, IO.WRITE_54XX);
      for (let i = 0; i < 4; i += 1) this.n54.write(mainRom(HIT_SOUND_BYTES + i));
      m.poke(0x7100, IO.IDLE);
    }
  }
}
