// Copyright 2026 by Moshix
/**
 * High-level emulation of the Namco 51XX I/O chip as Galaga uses it.
 *
 * The real chip is an MB8843 running a 626-byte program (51xx.bin). The
 * browser port does not execute MB88 code; instead this module re-states
 * that program in JavaScript. It was derived by reading the disassembly
 * (`node tools/mb88dis.mjs 51`) and checked instruction-for-instruction
 * against the LLE in test/mcu/ (test/unit/namco51-hle.test.mjs drives both
 * with the same randomized input and compares every byte read, every P port
 * write and the chip's RAM). Addresses in comments like "@0E9" are MB88
 * program addresses in that disassembly.
 *
 * The state IS the chip's RAM: 64 nibbles addressed row:column (X:Y), kept
 * in `ram` under the same addresses the program uses, so a mismatch against
 * the LLE can be read straight off a RAM dump. Map (row 0 is scratch/config,
 * row 1 coin logic, row 2 input history and the output buffer):
 *
 *   $02 remap disabled (cmd 03 -> 1, cmd 04 -> 0)
 *   $03 mode: 1 = switch mode (reset default, cmd 05), 0 = credit mode
 *       (cmd 02), 2 = game mode (entered when a start button is accepted)
 *   $06 read pointer: column of the next output byte in row 2 (4, 6, 8, A)
 *   $09 TL value seen at the start of the current frame
 *   $10-$13 coinage: $13 coins/credit (slot 1), $12 credits added,
 *       $11 coins/credit (slot 2), $10 credits added. Any 0 argument sets
 *       $1A = $A (free play).
 *   $14 debounced falling edges of R3 (bit0 COIN1, bit1 COIN2, bit2 SERVICE),
 *       active low; $15-$17 R3 history (newest first)
 *   $18 "credit added this frame" (blocks start buttons for that frame)
 *   $19/$1A credits, BCD low/high digit; $1A = $A means free play
 *   $1B/$1C pending coin-counter pulses (slot 1 / slot 2)
 *   $1D/$1E coins inserted toward the next credit (slot 1 / slot 2)
 *   $1F P port image: bit0/bit1 start lamps, bit2/bit3 coin counters 2/1
 *       (counters active low)
 *   $20-$22 R2 history (oldest first), $23 debounced falling edges of R2
 *       (bit0 FIRE1, bit1 FIRE2, bit2 START1, bit3 START2), active low
 *   $24-$2B output buffer, four bytes, low nibble first:
 *       byte0 $24/$25, byte1 $26/$27, byte2 $28/$29, byte3 $2A/$2B
 *
 * ---------------------------------------------------------------------------
 * The byte protocol (what Galaga reads):
 *
 *   Credit/game mode (after command 02):
 *     byte0 = credits in BCD ($00-$99); $A0 in free play. Stale values:
 *             $BB is shown (and the chip drops to switch mode, clearing the
 *             credits) while the TEST switch (IN1 bit 7) is on.
 *     byte1 = player 1: bits 0-3 = IN0 bits 0-3 raw (bit1 RIGHT, bit3 LEFT,
 *             active low); bit4 = FIRE1 "new press" (0 for exactly one frame
 *             when the button has read pressed on 2 consecutive frames after
 *             2 frames released), bit5 = FIRE1 current level (0 = pressed),
 *             bits 6-7 = 0.
 *     byte2 = the same for player 2 / cocktail: IN0 bits 4-7 raw (bit1
 *             RIGHT, bit3 LEFT), bit4 FIRE2 new press, bit5 FIRE2 level.
 *     byte3 = $FF (never seen by Galaga, see "reads" below).
 *     IMPORTANT: bytes 1 and 2 are only refreshed in game mode (after a
 *     start button was accepted). In credit mode they keep their last value.
 *   Switch mode (reset default, command 05):
 *     byte0 = IN1 raw, byte1 = IN0 raw, byte2 = byte3 = $FF.
 *
 *   Coins: a coin/service input is counted on its debounced falling edge
 *   (2 frames high then 2 frames low). START1 needs >= 1 credit, START2
 *   >= 2; the start edge subtracts 1 or 2 credits and enters game mode.
 *   Credits saturate at 99.
 *
 * ---------------------------------------------------------------------------
 * Call granularity (how the port must drive this object):
 *
 *   vblank()       once per frame, at the START of vblank (the chip's timer
 *                  is clocked by vblank and its whole frame of work runs
 *                  right after the tick). Call setInputs() first.
 *   write(byte)    once per byte of a 06XX write transfer to the 51XX
 *                  (control $A1/$E1/$61...), in order.
 *   beginRead()    when the main CPU writes a read control value ($71/$B1)
 *                  -- models the 06XX's first strobe, which has no NMI.
 *   read()         once per NMI of the read transfer (Galaga: 3 times).
 *
 * Why beginRead(): every 06XX strobe makes the chip put the NEXT output
 * byte on the latch, but the main CPU's NMI for a strobe reads the latch
 * before the chip has updated it (the MB88 needs ~15-30 of its cycles). The
 * 06XX therefore strobes once without an NMI first. A 3-byte read is 4
 * strobes, which advances the pointer by 4 = once around the 4-byte buffer,
 * so every Galaga read starts at byte0 again. Any write command resets the
 * pointer to byte0.
 *
 * ---------------------------------------------------------------------------
 * Where the HLE is exact and where it cannot be (timing on the real chip):
 *
 *  1. The chip's frame work ("body", @097-@186) is done atomically in
 *     vblank(). On the chip it ends at most 241 MB88 cycles (~2900 Z80
 *     cycles) after vblank starts (measured over randomized input). A
 *     strobe arriving inside that window interrupts the body; a READ
 *     strobe there can return the previous
 *     frame's value for bytes not yet rebuilt, and a mode command (02/05)
 *     there can give one frame that mixes the old and new mode. Galaga
 *     issues its $71 read at the end of its vblank interrupt handler and
 *     its game-over $61 write after that read, both later than the window.
 *  2. A strobe that arrives while the chip is still in the handler for the
 *     previous one is LOST (its external interrupt is disabled until the
 *     handler's `en $04`): up to ~19 MB88 cycles (~230 Z80) after a write
 *     strobe and ~34 (~410 Z80) after a read strobe. The HLE never loses a
 *     strobe. Galaga's transfers space strobes >= 512 Z80 cycles, but a
 *     transfer started right after the previous one can lose its first
 *     strobe: with the 06XX model in test/mcu/bus06.mjs, E1 -> B1 at
 *     Galaga's own pace (~144 Z80 cycles between the $10 write and the B1
 *     write) is safe, while <= 100 cycles loses the strobe.
 *  3. The coinage command (01) runs its argument loop inside the interrupt
 *     handler; if vblank arrives meanwhile the chip's frame work is delayed
 *     until the 4th argument has arrived. The HLE models this (the frame
 *     work runs from the write() that delivers the 4th argument), and runs
 *     it once no matter how many vblanks passed, like the chip.
 *  4. MB88 `daa` as emulated by MAME loses the carry of a binary sum >= 16
 *     (e.g. 9 credits + 7), so such additions wrap. Galaga's coinage table
 *     adds at most 3 credits per coin, so 9 + 3 is the largest sum; the HLE
 *     reproduces MAME's arithmetic exactly anyway.
 *  5. The serial port (SB) and coin lockout are not modelled: MAME never
 *     connects them, and the program only ever writes SB.
 */

/** RAM addresses (row << 4 | column) used by the 51xx program. */
export const RAM = Object.freeze({
  REMAP_OFF: 0x02,
  MODE: 0x03,
  READ_PTR: 0x06,
  IRQ_SCRATCH_Y: 0x07,
  TL_SEEN: 0x09,
  CREDITS_B: 0x10,
  COINS_B: 0x11,
  CREDITS_A: 0x12,
  COINS_A: 0x13,
  COIN_EDGES: 0x14,
  COIN_HIST: 0x15, // $15 newest .. $17 oldest
  CREDIT_ADDED: 0x18,
  CRED_LO: 0x19,
  CRED_HI: 0x1a,
  PULSES_A: 0x1b,
  PULSES_B: 0x1c,
  COUNT_A: 0x1d,
  COUNT_B: 0x1e,
  PORT_P: 0x1f,
  BTN_HIST: 0x20, // $20 oldest .. $22 newest
  BTN_EDGES: 0x23,
  OUT: 0x24, // $24-$2B: four output bytes, low nibble first
});

/** Chip modes stored at RAM.MODE. */
export const MODE = Object.freeze({ CREDIT: 0, SWITCH: 1, GAME: 2 });

/**
 * The 8-way joystick remap table at @280 (jpa $0A: entry n is at $280 + 4n).
 * Galaga disables remapping (command 03), but it is part of the chip.
 */
const REMAP = Uint8Array.from([
  0xf, 0xe, 0xd, 0x5, 0xc, 0x9, 0x7, 0x6, 0xb, 0x3, 0xa, 0x4, 0x1, 0x2, 0x0, 0x8,
]);

/**
 * @typedef {object} Namco51Options
 * @property {(p: number) => void} [onOutput]
 *   Called with the P port nibble every time the chip writes it (once per
 *   frame in credit/game mode, never in switch mode). Galaga: bit0 = LED 1,
 *   bit1 = LED 0, bit2 = coin counter 1 (active low), bit3 = coin counter 0
 *   (active low). @see reference/mame/galaga.cpp galaga_state::out
 */

/** HLE of the Namco 51XX running 51xx.bin. */
export class Namco51 {
  /** @param {Namco51Options} [options] */
  constructor(options = {}) {
    this.onOutput = options.onOutput ?? (() => {});
    /** The chip's 64-nibble data RAM (see RAM for the map). */
    this.ram = new Uint8Array(64);
    /** Timer low/high nibbles; TL counts vblanks. */
    this.tl = 0;
    this.th = 0;
    /** The data latch shared with the 06XX (m_portO in MAME). */
    this.latch = 0;
    /** Raw input bytes, active low (Galaga IN0 / IN1). */
    this.in0 = 0xff;
    this.in1 = 0xff;
    /** >= 0 while the coinage command collects arguments: next RAM column. */
    this.argIndex = -1;
    /** A vblank arrived during the coinage argument loop. */
    this.bodyPending = false;
    this.reset();
  }

  /**
   * Chip reset (release of /RESET): run the program's init code @07E-@096
   * and its first frame of work, which the chip does immediately without
   * waiting for a vblank. The data latch is outside the MCU and survives.
   * @returns {void}
   */
  reset() {
    const m = this.ram;
    m.fill(0); // @07E-@087 clears every row
    this.tl = 0;
    this.th = 0;
    this.argIndex = -1;
    this.bodyPending = false;
    m[RAM.PORT_P] = 0xc; // @088: counters off, lamps off
    m[0x2a] = 0xf; // @08C: byte3 = $FF
    m[0x2b] = 0xf;
    m[RAM.MODE] = MODE.SWITCH; // @093
    this.body();
  }

  /**
   * Set the input ports as the board presents them (active low).
   * @param {number} in0  IN0: joysticks (bit1 R, bit3 L, bit5 R2, bit7 L2)
   * @param {number} in1  IN1: bit0 FIRE1, bit1 FIRE2, bit2 START1,
   *                      bit3 START2, bit4 COIN1, bit5 COIN2, bit6 SERVICE,
   *                      bit7 TEST
   * @returns {void}
   */
  setInputs(in0, in1) {
    this.in0 = in0 & 0xff;
    this.in1 = in1 & 0xff;
  }

  /**
   * Start of vblank: clock the timer and run one frame of the program.
   * @returns {void}
   */
  vblank() {
    // /TC falling edge -> increment_timer (TH wraps silently; the program
    // never enables the timer interrupt).
    this.tl = (this.tl + 1) & 0xf;
    if (this.tl === 0) this.th = (this.th + 1) & 0xf;
    if (this.argIndex >= 0) {
      this.bodyPending = true; // the chip is stuck in the interrupt handler
      return;
    }
    this.body();
  }

  /**
   * One byte of a 06XX write transfer.
   * @param {number} byte
   * @returns {void}
   */
  write(byte) {
    this.latch = byte & 0xff;
    this.strobe(0);
  }

  /**
   * The main CPU started a read transfer: the 06XX's first strobe, which
   * has no NMI, makes the chip latch the byte the first read() returns.
   * @returns {void}
   */
  beginRead() {
    this.strobe(1);
  }

  /**
   * One NMI of a 06XX read transfer: returns the latch, and the same 06XX
   * edge strobes the chip for the following byte.
   * @returns {number}
   */
  read() {
    const value = this.latch;
    this.strobe(1);
    return value;
  }

  /** The last value the chip wrote to its P port. @returns {number} */
  get portP() {
    return this.ram[RAM.PORT_P];
  }

  /**
   * One chip-select strobe = one run of the external interrupt handler @002.
   * The handler reads K = R/W << 3 | latch & 7 and dispatches through the
   * jump table @040 (writes) / @060 (reads). Note only 3 bits of each
   * written byte reach the chip.
   * @param {number} rw  1 = the host is reading
   * @returns {void}
   */
  strobe(rw) {
    const k = (rw << 3) | (this.latch & 7);
    const m = this.ram;

    if (this.argIndex >= 0) {
      // Coinage argument loop @00D-@01E, polling the chip select inside the
      // interrupt handler. Arguments land in $13, $12, $11, $10.
      if (k === 0) {
        m[RAM.CRED_HI] = 0xa; // @016: a zero argument means free play
        m[RAM.IRQ_SCRATCH_Y] = 0xa; // side effect of the xyd 7 swap
      }
      m[0x10 + this.argIndex] = k;
      this.argIndex -= 1;
      if (this.argIndex < 0) {
        m[RAM.READ_PTR] = 4; // @022
        if (this.bodyPending) {
          this.bodyPending = false;
          this.body();
        }
      }
      return;
    }

    if (rw) {
      // @24F: put the next output byte on O (low nibble, then high) and
      // advance the pointer by two columns, wrapping from $C back to 4.
      const p = m[RAM.READ_PTR];
      this.latch = m[0x20 | p] | (m[0x20 | ((p + 1) & 0xf)] << 4);
      let y = (p + 2) & 0xf;
      if (y === 0xc) y = 4;
      m[RAM.READ_PTR] = y;
      return;
    }

    switch (k) {
      case 1: this.argIndex = 3; return; // @008 coinage: 4 more bytes follow
      case 2: m[RAM.MODE] = MODE.CREDIT; break; // @048
      case 3: m[RAM.REMAP_OFF] = 1; break; // @04C
      case 4: m[RAM.REMAP_OFF] = 0; break; // @050
      case 5: m[RAM.MODE] = MODE.SWITCH; break; // @054
      default: break; // 0, 6, 7: nop
    }
    m[RAM.READ_PTR] = 4; // @022: every write command rewinds the reader
  }

  /**
   * The program's frame work, @097-@17D, run once per timer tick.
   * @returns {void}
   */
  body() {
    const m = this.ram;
    m[RAM.CREDIT_ADDED] = 0; // @097
    m[RAM.TL_SEEN] = this.tl; // @09B

    const r0 = this.in0 & 0xf;
    const r1 = this.in0 >> 4;
    const r2 = this.in1 & 0xf;
    const r3 = this.in1 >> 4;

    if (m[RAM.MODE] === 1) {
      // @0A4 switch mode: raw inputs, byte0 = IN1, byte1 = IN0.
      m[0x24] = r2;
      m[0x25] = r3;
      m[0x27] = r1;
      m[0x26] = r0;
      m[0x28] = m[0x29] = m[0x2a] = m[0x2b] = 0xf;
      return;
    }

    if (!(r3 & 0x8)) {
      // @239 TEST switch on: clear credits, show $BB, drop to switch mode.
      m[RAM.CRED_LO] = 0;
      m[RAM.CRED_HI] = 0;
      m[RAM.COUNT_A] = 0;
      m[RAM.COUNT_B] = 0;
      m[0x24] = 0xb;
      m[0x25] = 0xb;
      m[RAM.MODE] = MODE.SWITCH;
      this.onOutput(0xf);
      return;
    }

    if (m[RAM.CRED_HI] !== 0xa) {
      // @0CA: shift the coin history and find debounced falling edges.
      const edges = Namco51.edges(r3, m, RAM.COIN_HIST, RAM.COIN_HIST + 1, RAM.COIN_HIST + 2);
      m[RAM.COIN_EDGES] = edges;
      if (!(edges & 1)) this.coinA();
      if (!(m[RAM.COIN_EDGES] & 2)) this.coinB();
      if (!(m[RAM.COIN_EDGES] & 4)) this.service();
    }

    this.showCredits(); // @0E7

    // @0E9: the same history/edge logic for buttons, in row 2 (newest $22).
    m[RAM.BTN_EDGES] = Namco51.edges(r2, m, 0x22, 0x21, 0x20);

    if (m[RAM.MODE] !== 0) this.gameFrame(r0, r1);
    else this.creditFrame();

    // @120: coin counter pulses and lamps.
    m[RAM.PORT_P] &= 0xc;
    if (m[RAM.PULSES_A] !== 0) {
      // Counter 1 (P bit 3, active low): on at TL=0, off at TL=4.
      if (this.tl === 4) {
        if (!(m[RAM.PORT_P] & 8)) {
          m[RAM.PORT_P] |= 8;
          m[RAM.PULSES_A] = (m[RAM.PULSES_A] - 1) & 0xf;
        }
      } else if (this.tl === 0) {
        m[RAM.PORT_P] &= ~8;
      }
    }
    if (m[RAM.PULSES_B] !== 0) {
      // Counter 2 (P bit 2): on at TL=8, off at TL=12.
      if (this.tl === 0xc) {
        if (!(m[RAM.PORT_P] & 4)) {
          m[RAM.PORT_P] |= 4;
          m[RAM.PULSES_B] = (m[RAM.PULSES_B] - 1) & 0xf;
        }
      } else if (this.tl === 8) {
        m[RAM.PORT_P] &= ~4;
      }
    }
    if (m[RAM.MODE] === 0) {
      // @157 start lamps blink with TH bit 0 (16 frames on, 16 off): both
      // with >= 2 credits (or free play), only bit 1 with exactly 1 credit.
      const hi = m[RAM.CRED_HI];
      const lo = m[RAM.CRED_LO];
      const blink = this.th & 1;
      if (hi === 0 && lo === 1) {
        if (blink) m[RAM.PORT_P] = (m[RAM.PORT_P] + 2) & 0xf;
      } else if (hi !== 0 || lo !== 0) {
        if (blink) m[RAM.PORT_P] = (m[RAM.PORT_P] + 3) & 0xf;
      }
    }
    this.onOutput(m[RAM.PORT_P]); // @16F outP
  }

  /**
   * Shift a 4-bit input into a 3-deep history and return its debounced
   * falling edges (@0CA-@0D9 / @0E9-@0F9). A bit of the result is 0 iff
   * the input is 0 now and on the previous frame, and was 1 on the two
   * frames before that:  edges = cur | h0 | ~(h1 & h2).
   * @param {number} cur  new input nibble
   * @param {Uint8Array} m RAM
   * @param {number} a0   newest history slot
   * @param {number} a1   middle slot
   * @param {number} a2   oldest slot
   * @returns {number}
   */
  static edges(cur, m, a0, a1, a2) {
    const h0 = m[a0];
    const h1 = m[a1];
    const h2 = m[a2];
    m[a0] = cur;
    m[a1] = h0;
    m[a2] = h1;
    return (cur | h0 | (~(h2 & h1) & 0xf)) & 0xf;
  }

  /**
   * @0E7 / @265: copy credits to output byte0.
   * @returns {void}
   */
  showCredits() {
    this.ram[0x24] = this.ram[RAM.CRED_LO];
    this.ram[0x25] = this.ram[RAM.CRED_HI];
  }

  /**
   * Add `n` to the BCD credit count with the MB88 `adc`/`daa` sequence of
   * @193-@19E, saturating at 99 when the high digit reaches $A.
   * @param {number} n
   * @returns {void}
   */
  addCredits(n) {
    const m = this.ram;
    let a = m[RAM.CRED_LO] + n; // rstc; adc
    let cf = (a & 0x10) ? 1 : 0;
    a &= 0xf;
    if (cf || a > 9) a += 6; // daa (carry is that of the +6 only)
    cf = (a & 0x10) ? 1 : 0;
    m[RAM.CRED_LO] = a & 0xf;
    const hi = (m[RAM.CRED_HI] + cf) & 0xf; // li 0; adc
    m[RAM.CRED_HI] = hi;
    if (hi === 0xa) {
      m[RAM.CRED_HI] = 9;
      m[RAM.CRED_LO] = 9;
    }
  }

  /**
   * Coin slot 1, @187.
   * @returns {void}
   */
  coinA() {
    const m = this.ram;
    m[RAM.COUNT_A] = (m[RAM.COUNT_A] + 1) & 0xf;
    if (m[RAM.COUNT_A] === m[RAM.COINS_A]) {
      m[RAM.COUNT_A] = 0;
      m[RAM.CREDIT_ADDED] = m[RAM.CREDITS_A];
      this.addCredits(m[RAM.CREDITS_A]);
    }
    // One more coin-counter pulse, saturating at 15 (icm; dcm on wrap).
    if (m[RAM.PULSES_A] !== 0xf) m[RAM.PULSES_A] += 1;
  }

  /**
   * Coin slot 2, @1A4. (It ORs into the "credit added" flag rather than
   * overwriting it, since slot 1 may have set it this frame.)
   * @returns {void}
   */
  coinB() {
    const m = this.ram;
    m[RAM.COUNT_B] = (m[RAM.COUNT_B] + 1) & 0xf;
    if (m[RAM.COUNT_B] === m[RAM.COINS_B]) {
      m[RAM.COUNT_B] = 0;
      m[RAM.CREDIT_ADDED] |= m[RAM.CREDITS_B];
      this.addCredits(m[RAM.CREDITS_B]);
    }
    if (m[RAM.PULSES_B] !== 0xf) m[RAM.PULSES_B] += 1;
  }

  /**
   * SERVICE button, @1C6: one free credit, no coin counter.
   * @returns {void}
   */
  service() {
    this.ram[RAM.CREDIT_ADDED] = 1;
    this.addCredits(1);
  }

  /**
   * Credit mode, @100: accept a start button if there are enough credits.
   * @returns {void}
   */
  creditFrame() {
    const m = this.ram;
    if (m[RAM.CREDIT_ADDED] !== 0) return; // no start in a coin frame
    const edges = m[RAM.BTN_EDGES];
    const hi = m[RAM.CRED_HI];
    const lo = m[RAM.CRED_LO];
    if (hi === 0 && lo === 0) return;
    if (hi === 0 && lo === 1) {
      if (!(edges & 4)) this.start(1); // @11B: only START1 with one credit
      return;
    }
    if (!(edges & 4)) this.start(1); // @10F
    else if (!(edges & 8)) this.start(2);
  }

  /**
   * Start button accepted, @1D7/@1D9: subtract credits (MB88 sbc/das),
   * enter game mode and forget partial coins.
   * @param {number} n  1 or 2 credits
   * @returns {void}
   */
  start(n) {
    const m = this.ram;
    let a = (m[RAM.CRED_LO] - n) & 0xff; // rstc; sbc
    let cf = (a & 0x10) ? 1 : 0;
    a &= 0xf;
    if (cf || a > 9) a += 10; // das
    cf = (a & 0x10) ? 1 : 0;
    m[RAM.CRED_LO] = a & 0xf;
    m[RAM.CRED_HI] = (m[RAM.CRED_HI] - cf) & 0xf; // li 0; sbc
    this.showCredits(); // @1E3
    m[RAM.MODE] = MODE.GAME;
    m[RAM.COUNT_A] = 0;
    m[RAM.COUNT_B] = 0;
    if (m[RAM.COINS_A] === 0) {
      // @1F3 free play: reset the display to "$A0".
      m[RAM.CRED_LO] = 0;
      m[RAM.CRED_HI] = 0xa;
    }
  }

  /**
   * Game mode, @1F9: rebuild the two joystick bytes.
   * @param {number} r0  IN0 low nibble (player 1 stick)
   * @param {number} r1  IN0 high nibble (player 2 stick)
   * @returns {void}
   */
  gameFrame(r0, r1) {
    const m = this.ram;
    const edges = m[RAM.BTN_EDGES];
    const now = m[0x22];
    m[0x27] = (edges & 1) | ((now & 1) << 1);
    m[0x26] = m[RAM.REMAP_OFF] !== 0 ? r0 : REMAP[r0];
    m[0x29] = ((edges & 2) >> 1) | (now & 2);
    m[0x28] = m[RAM.REMAP_OFF] !== 0 ? r1 : REMAP[r1];
  }
}
