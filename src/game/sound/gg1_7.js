// Copyright 2026 by Moshix
/**
 * The sound CPU program, gg1_7b.2c ($0000-$0FFF), routine by routine.
 *
 * The third Z80 does nothing but music and sound effects on the Namco WSG
 * (3 wavetable voices, registers $6800-$681F). Its foreground code is a ROM
 * self-test followed by an idle loop; all the work happens in the NMI
 * handler, which the board fires at scan lines 64 and 192 of every frame.
 *
 * INTERFACE WITH THE MAIN CPU. The main CPU never touches the WSG. It asks
 * for sounds by writing "count/enable" request bytes at $9AA0-$9AB7 (plus
 * the coin counter $9A79 and the formation-pulse direction $9211); the NMI
 * handler reads them, runs each effect's note sequencer, builds the new
 * register image in RAM ($9A60-$9A72) and copies it to the chip. Each
 * request slot `n` ($9AA0+n) has an "active" flag at $9AC0+n, a note
 * position at $9A30+k and a duration counter at $9A00+k (k = the slot's
 * data-track index from the table at $0734).
 *
 * RAM used by this CPU (all in $9A00-$9AFF, cleared at reset):
 *   $9A00+k   per-track duration counter ("sound_fx_status")
 *   $9A30+k   per-track offset of the current note pair in its data
 *   $9A60-6F  WSG frequency/volume image, copied to $6810-$681F
 *   $9A70-72  WSG waveform selects, copied to $6805/$680A/$680F
 *   $9A74     index of the request slot being processed
 *   $9A75-77  track parameters: first track, track count, first voice
 *   $9A78     "track ended" flag from c_0550
 *   $9A79     coin-in count posted by the main CPU
 *   $9A7A     pointer to the current note pair
 *   $9A7C-7F  capture-beam volume/wave counters
 *   $9A80-87  formation-pulse state
 *   $9A88-8A  header of the current track (envelope, decay, waveform)
 *   $9A8C     NMI re-entry guard [rev B]
 *   $9AA0-B7  request slots, $9AB8 "reset" test flag
 *   $9AC0-D6  active flags
 *
 * Addresses in comments are rev. B (reference/galaga-sound.asm).
 * @see docs/porting-guide.md
 */

import { SOUND, SOUND_AT } from './routines.js';
import { SPIN } from '../scheduler.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/** Result of the ROM checksum at $0091: the byte sum of $0000-$0FFF. */
const ROM_SUM = 0xff;

/** $9A74: index of the request slot being processed. */
const ACTV_SND_IDX = 0x9a74;
/** $9A75-$9A77: first track, track count, first voice of that slot. */
const PARMS_IDX = 0x9a75;
const PARMS_COUNT = 0x9a76;
const PARMS_VOICE = 0x9a77;
/** $9A78: set by c_0550 when a track hits its $FF terminator. */
const SND_DONE = 0x9a78;
/** $9A7A: pointer to the current note pair of the track c_0550 plays. */
const NOTE_PTR = 0x9a7a;

/** `rrca` x4: swap nibbles. @param {number} v @returns {number} */
const rrca4 = (v) => ((v >> 4) | (v << 4)) & 0xff;

/**
 * `ld hl,$9Axx / ld a,(n) / add a,l / ld l,a`: an index added to the LOW
 * byte only, so it wraps inside page $9A (no carry into H).
 * @param {number} base low byte of the table @param {number} idx
 * @returns {number}
 */
const page9A = (base, idx) => 0x9a00 | ((base + idx) & 0xff);

/**
 * `rst $18` ($0018): memset (HL), A for B bytes; B = 0 means 256.
 * @param {Machine} m @param {number} hl @param {number} a @param {number} b
 * @returns {number} HL after the loop
 */
function rst18(m, hl, a, b) {
  let n = b === 0 ? 256 : b;
  let p = hl;
  while (n > 0) { m.poke(p, a); p = (p + 1) & 0xffff; n -= 1; }
  return p;
}

/**
 * `ld hl,base / ld (hl),0 / ld de,base+1 / ld bc,n / ldir`: clears n + 1
 * bytes; every byte ldir copies is the zero it just wrote.
 * @param {Machine} m @param {number} base @param {number} n
 */
function clearBlock(m, base, n) {
  for (let i = 0; i <= n; i += 1) m.poke(base + i, 0);
}

// ---------------------------------------------------------------- reset

/**
 * RESET ($0085, reached from $0000): the sound CPU's foreground.
 *
 * Masks its own NMI, waits for the main CPU's go ($9101 == 0), checksums its
 * ROM into $9101 ($FF = good, $21 = bad), waits for the main CPU to clear
 * $9101 again, unmasks the NMI, clears $9A00-$9AFF and idles forever.
 * @see galaga-sound.asm $0085
 * @param {Machine} m
 * @returns {Generator<symbol|undefined, void, void>}
 */
export function* RESET(m) {
  // $0085: ld a,1 / ld ($6822),a -- mask the NMI during the self-test.
  m.poke(0x6822, 1);
  // $008D: wait for the main CPU (its foreground) to release us.
  while (m.peek(0x9101) !== 0) yield SPIN;
  // $0091-$009B: sum the 4 KB ROM. The port cannot read its own code bytes,
  // so the sum is the constant the real ROM produces (checked by the oracle
  // test). The loop is 16 x 256 x 26 cycles = ~106,700 cycles = ~2.1 frames;
  // the main CPU spends ~8 frames checksumming its own 16 KB before it looks
  // at $9101, so the exact count is unobservable. Burn 2 frames.
  yield;
  yield;
  // $009D: cp $FF / jr z / ld a,$21 -- error code $21 on a bad sum.
  m.poke(0x9101, ROM_SUM === 0xff ? 0xff : 0x21);
  // $00A4: wait for the main CPU to acknowledge (clear) the result.
  while (m.peek(0x9101) !== 0) yield SPIN;
  // $00A8: unmask the NMI.
  m.poke(0x6822, 0);
  // $00AC: memset($9A00, 0, $100).
  clearBlock(m, 0x9a00, 0xff);
  // $00B9: jr $00B9 -- everything else happens in the NMI.
  for (;;) yield;
}

// ------------------------------------------------------------------ NMI

/**
 * The NMI handler ($0066) [rev B]. Rev. B wraps c_nmi_proc in a re-entry
 * guard: if $9A8C is set (a previous NMI is still running) it returns at
 * once with RETN. Otherwise it pulses the NMI mask latch ($6822 = 1, then
 * 0), sets the guard, runs c_nmi_proc and clears the guard. (The normal
 * path returns with a plain RET at $0084.)
 * @see galaga-sound.asm $0066
 * @param {Machine} m
 */
export function sub_0066(m) {
  // $0067: ld a,($9A8C) / and a / jr z,$0070 ... pop af / retn
  if (m.peek(0x9a8c) !== 0) return;
  // $0070-$0079: A = 1 goes to both the latch and the guard; then latch = 0.
  m.poke(0x6822, 1);
  m.poke(0x9a8c, 1);
  m.poke(0x6822, 0);
  c_nmi_proc(m);
  // $007F: xor a / ld ($9A8C),a
  m.poke(0x9a8c, 0);
}

/**
 * c_nmi_proc ($00BB): one tick of the sound manager. Clears the
 * frequency/volume image, services every request slot in a fixed priority
 * order (later slots overwrite earlier ones' voices), then copies the image
 * to the WSG.
 * @see galaga-sound.asm $00BB
 * @param {Machine} m
 */
export function c_nmi_proc(m) {
  // $00BB: a "reset" request, never made by the main CPU.
  if (m.peek(0x9ab8) !== 0) { l_067A_reset_sfrs(m); return; }
  // $00C2: memset($9A60, 0, $10) -- all voices silent unless re-set below.
  clearBlock(m, 0x9a60, 0x0f);
  // $00CF: sound_mgr_reset (attract mode with demo sound off, game over...)
  if (m.peek(0x9ab7) !== 0) { l_033D_clear_all(m); return; }

  // $00D6: add the credits counted since last time to the coin slot $9AA8.
  const credits = m.peek(0x9a79);
  if (credits !== 0) {
    m.poke(0x9aa8, (credits + m.peek(0x9aa8)) & 0xff);
    m.poke(0x9a79, 0);
  }

  // $00E5: pulsing formation (voice 0, computed directly, no data track).
  if (m.peek(0x9aa0) !== 0) l_00D3_pulse(m);

  // $015A-$0205: the one-shot effects that restart when re-requested:
  // dive attack, shot, and the four "alien hit" sounds.
  for (const idx of [0x13, 0x0f, 0x03, 0x02, 0x04, 0x01]) {
    m.poke(ACTV_SND_IDX, idx);
    const req = 0x9aa0 + idx;
    if (m.peek(req) !== 0) {
      m.poke(req, 0);
      c_03F4(m);
    } else if (m.peek(0x9ac0 + idx) !== 0) {
      c_044A(m);
    }
  }

  // $0208: bonus-bee sound.
  if (m.peek(0x9ab2) !== 0) {
    m.poke(ACTV_SND_IDX, 0x12);
    c_04A2(m);
  }

  // $0216: capture beam, part 1 (slot 5): its volume pulses.
  if (m.peek(0x9aa5) !== 0) {
    m.poke(ACTV_SND_IDX, 0x05);
    c_0375(m);
    // $0224: every 6th tick step the volume down 12..3, then back to 12.
    const n = (m.peek(0x9a7e) + 1) & 0xff;
    m.poke(0x9a7e, n);
    if (n >= 6) {
      m.poke(0x9a7e, 0);
      const v = m.peek(0x9a7c);
      // $0234: cp 4 / jr c -- below 4 wraps back to $0C.
      m.poke(0x9a7c, v < 4 ? 0x0c : (v - 1) & 0xff);
    }
    // $0240: voice 2 volume.
    m.poke(0x9a6f, m.peek(0x9a7c));
  } else {
    // $0248: A is 0 here -- clear the active flag.
    m.poke(0x9ac5, 0);
  }

  // $024B: capture beam, part 2 (slot 6): its waveform cycles.
  if (m.peek(0x9aa6) !== 0) {
    m.poke(ACTV_SND_IDX, 0x06);
    c_0375(m);
    // $0259: every $1C ticks advance the voice-0 waveform.
    const n = (m.peek(0x9a7f) + 1) & 0xff;
    m.poke(0x9a7f, n);
    if (n === 0x1c) {
      m.poke(0x9a7f, 0);
      m.poke(0x9a7d, (m.peek(0x9a7d) + 1) & 0xff);
    }
    m.poke(0x9a70, m.peek(0x9a7d));
  } else {
    m.poke(0x9ac6, 0);
  }

  // $0278: slot 9 (continuous while requested).
  continuous(m, 0x09);

  // $028B: the fighter was shot: play it and skip the tunes below.
  if (m.peek(0x9aa7) !== 0) {
    m.poke(ACTV_SND_IDX, 0x07);
    c_04A2(m);
    // $0299: jp $033C [rev B]
    l_032D_coin(m);
    j_0357_set_SFRs(m);
    return;
  }

  // $029C: "rescued ship" theme (continuous while requested).
  continuous(m, 0x11);

  // $02AF: challenging-stage intro.
  oneShot(m, 0x0d);

  // $02BD: challenging-stage melody; its voices 1 and 2 are then forced to
  // fixed volumes.
  if (m.peek(0x9aae) !== 0) {
    m.poke(ACTV_SND_IDX, 0x0e);
    c_04A2(m);
    m.poke(0x9a6a, 0x09);
    m.poke(0x9a6f, 0x06);
  }

  // $02D5 "perfect!", $02E3 stage-token clicks, $02F1 extra fighter,
  // $02FF start-of-game theme.
  oneShot(m, 0x14);
  oneShot(m, 0x15);
  oneShot(m, 0x0a);
  oneShot(m, 0x0b);
  // $030D: slot $10 (continuous while requested).
  continuous(m, 0x10);
  // $0320, $032E: high-score tunes.
  oneShot(m, 0x0c);
  oneShot(m, 0x16);

  l_032D_coin(m);
  // $034A: jr j_0357_set_SFRs
  j_0357_set_SFRs(m);
}

/**
 * The "one-shot" pattern ($02AF etc.): if the slot is requested, make it
 * current and run c_04A2 (which clears or counts down the request when the
 * tune ends).
 * @param {Machine} m @param {number} idx request slot
 */
function oneShot(m, idx) {
  if (m.peek(0x9aa0 + idx) === 0) return;
  m.poke(ACTV_SND_IDX, idx);
  c_04A2(m);
}

/**
 * The "continuous" pattern ($0278 etc.): while the slot is requested run
 * c_0375; once the request drops, clear the slot's active flag (A is the
 * zero just tested, hence the store of 0).
 * @param {Machine} m @param {number} idx request slot
 */
function continuous(m, idx) {
  if (m.peek(0x9aa0 + idx) !== 0) {
    m.poke(ACTV_SND_IDX, idx);
    c_0375(m);
  } else {
    m.poke(0x9ac0 + idx, 0);
  }
}

/**
 * l_032D ($033C): the coin-in sound. $9AA8 is a count; c_04A2 decrements it
 * each time the jingle finishes, so it plays once per credit.
 * @param {Machine} m
 */
function l_032D_coin(m) {
  oneShot(m, 0x08);
}

/**
 * Pulsing-formation sound, $00EB-$0157 (reached when $9AA0 != 0).
 *
 * $9211 is the formation's breathing direction ($FF contracting, else
 * expanding), $9A80 its last seen value. On a change the pitch tables
 * switch ($06F4 expanding, $0704 contracting) and the step counter $9A81
 * restarts. Every $22 ticks $9A81 advances to the next table entry, loading
 * a pitch step ($9A84) and start pitch ($9A86, $20 bytes further on). Every
 * tick the pitch accumulates the step, and its high byte becomes voice 0's
 * frequency nibbles at volume $0A on waveform 0.
 * @param {Machine} m
 */
function l_00D3_pulse(m) {
  const sig = m.peek(0x9211);
  let reload = true;
  let step;
  if (sig !== m.peek(0x9a80)) {
    m.poke(0x9a80, sig);
    // $00F7: inc a / jr z -- $FF means contracting.
    if (sig === 0xff) {
      m.poke16(0x9a82, 0x0704);
      m.poke(0x9a00, 0);
    } else {
      m.poke16(0x9a82, 0x06f4);
      m.poke(0x9a00, 0);
    }
    // $010F: A is 0 on both paths.
    m.poke(0x9a81, 0);
    step = 0;
  } else {
    // $0114: inc sound_fx_status[0]; every $22 ticks move to the next entry.
    const t = (m.peek(0x9a00) + 1) & 0xff;
    m.poke(0x9a00, t);
    if (t === 0x22) {
      m.poke(0x9a00, 0);
      step = (m.peek(0x9a81) + 1) & 0xff;
      m.poke(0x9a81, step);
    } else {
      reload = false;
      step = 0;
    }
  }
  if (reload) {
    // $0126: hl = ($9A82) + 2*A (rst $08), DE = step word, then +$20 the
    // start pitch word.
    const hl = (m.peek16(0x9a82) + 2 * step) & 0xffff;
    m.poke(0x9a84, m.read('sound', hl));
    m.poke(0x9a85, m.read('sound', hl + 1));
    m.poke(0x9a86, m.read('sound', hl + 0x20));
    m.poke(0x9a87, m.read('sound', hl + 0x21));
  }
  // $013B: pitch += step; H is the frequency (low nibble to $9A61, the
  // high nibble, rotated down, to $9A62).
  const pitch = (m.peek16(0x9a86) + m.peek16(0x9a84)) & 0xffff;
  m.poke16(0x9a86, pitch);
  const h = pitch >> 8;
  m.poke(0x9a61, h);
  m.poke(0x9a62, rrca4(h));
  m.poke(0x9a65, 0x0a);
  m.poke(0x9a70, 0);
}

/**
 * l_033D_clear_all ($034C): silence everything -- clear the request slots
 * $9AA0-$9AB5 and active flags $9AC0-$9AD6 -- then load the (cleared)
 * register image into the WSG.
 * @see galaga-sound.asm $034C
 * @param {Machine} m
 */
export function l_033D_clear_all(m) {
  clearBlock(m, 0x9aa0, 0x15);
  clearBlock(m, 0x9ac0, 0x16);
  j_0357_set_SFRs(m);
}

/**
 * j_0357_set_SFRs ($0366): copy the register image to the chip:
 * $9A60-$9A6F -> $6810-$681F (frequencies and volumes), then the three
 * waveform selects.
 * @see galaga-sound.asm $0366
 * @param {Machine} m
 */
export function j_0357_set_SFRs(m) {
  for (let i = 0; i < 0x10; i += 1) m.poke(0x6810 + i, m.peek(0x9a60 + i));
  m.poke(0x6805, m.peek(0x9a70));
  m.poke(0x680a, m.peek(0x9a71));
  m.poke(0x680f, m.peek(0x9a72));
}

/**
 * l_067A_reset_sfrs ($06AB): clear all of $9A00-$9AFF, then `ld sp,$9B00 /
 * ret`. Only reached when $9AB8 is set, which no main-CPU code does. On the
 * Z80 the RET pops whatever word sits at $9B00 and jumps there; the port
 * cannot follow that, so it returns to the NMI wrapper instead (whose one
 * remaining write, $9A8C = 0, leaves RAM identical: the memset cleared it).
 * @see galaga-sound.asm $06AB
 * @param {Machine} m
 */
export function l_067A_reset_sfrs(m) {
  clearBlock(m, 0x9a00, 0xff);
}

// ---------------------------------------------------- slot sequencing

/**
 * Common prologue of c_0375/c_03F4/c_044A/c_04A2 ($0384-$03B2 etc.):
 * copy the slot's 3 track parameters from d_0703_snd_parms ($0734 + 3*idx)
 * into $9A75-$9A77. The challenging-stage melody (slot $0E) plays fewer of
 * its three tracks once track $1C/$1D have been restarted (their note
 * offsets $9A4C/$9A4D are zero): 1 track if $9A4C == 0, 2 if $9A4C == 1 or
 * $9A4D == 0, else all 3.
 * @param {Machine} m
 */
function loadParms(m) {
  const idx = m.peek(ACTV_SND_IDX);
  // add a,a / add a,(hl): 3*idx in 8 bits; rst $10 adds it to $0734.
  const a = (idx * 3) & 0xff;
  m.ldir(PARMS_IDX, 0x0734 + a, 3, 'sound');
  if (m.peek(ACTV_SND_IDX) !== 0x0e) return;
  const d0 = m.peek(0x9a4c);
  if (d0 === 0) { m.poke(PARMS_COUNT, 1); return; }
  if (d0 === 1 || m.peek(0x9a4d) === 0) m.poke(PARMS_COUNT, 2);
}

/**
 * Zero the duration counters and note offsets of the slot's tracks
 * ($03C2-$03DB): memset($9A30+first, 0, count) then memset($9A00+first, 0,
 * count). The base+first sum wraps in page $9A; the rst $18 run does not.
 * @param {Machine} m
 */
function resetTracks(m) {
  const b = m.peek(PARMS_COUNT);
  rst18(m, page9A(0x30, m.peek(PARMS_IDX)), 0, b);
  rst18(m, page9A(0x00, m.peek(PARMS_IDX)), 0, b);
}

/**
 * The first half of the "active" test in c_0375/c_04A2 ($03B5-$03DB): if
 * the slot is not active yet, mark it active and restart its tracks.
 * @param {Machine} m
 */
function startIfIdle(m) {
  const flag = page9A(0xc0, m.peek(ACTV_SND_IDX));
  if (m.peek(flag) !== 0) return;
  m.poke(flag, (m.peek(flag) + 1) & 0xff);
  resetTracks(m);
}

/**
 * The track loop and epilogue ($03DC-$0400, $048A-$04AE, $0509-$052D):
 * step each of the slot's tracks through c_0550 on consecutive voices; if
 * a track ended ($9A78) clear the flag and the slot's active flag.
 * @param {Machine} m
 * @returns {boolean} true if the slot's sound finished this tick
 */
function playTracks(m) {
  for (;;) {
    c_0550(m);
    // dec (hl) / jr z: count down the tracks (a count of 0 would run 256).
    const n = (m.peek(PARMS_COUNT) - 1) & 0xff;
    m.poke(PARMS_COUNT, n);
    if (n === 0) break;
    m.poke(PARMS_IDX, (m.peek(PARMS_IDX) + 1) & 0xff);
    m.poke(PARMS_VOICE, (m.peek(PARMS_VOICE) + 1) & 0xff);
  }
  if (m.peek(SND_DONE) === 0) return false;
  m.poke(SND_DONE, 0);
  m.poke(page9A(0xc0, m.peek(ACTV_SND_IDX)), 0);
  return true;
}

/**
 * c_0375 ($0384): tick a "continuous" sound -- start it if idle, then play
 * its tracks. When the tune ends the active flag drops, so it restarts
 * (loops) next tick while the request stays set.
 * @see galaga-sound.asm $0384
 * @param {Machine} m
 */
export function c_0375(m) {
  loadParms(m);
  startIfIdle(m);
  playTracks(m);
}

/**
 * c_03F4 ($0403): (re)start a sound from the top whatever its state: bump
 * its active flag, restart its tracks and play the first tick.
 * @see galaga-sound.asm $0403
 * @param {Machine} m
 */
export function c_03F4(m) {
  const flag = page9A(0xc0, m.peek(ACTV_SND_IDX));
  m.poke(flag, (m.peek(flag) + 1) & 0xff);
  loadParms(m);
  resetTracks(m);
  // $0457: jr j_047B
  playTracks(m);
}

/**
 * c_044A ($0459): continue a sound c_03F4 started.
 * @see galaga-sound.asm $0459
 * @param {Machine} m
 */
export function c_044A(m) {
  loadParms(m);
  playTracks(m);
}

/**
 * c_04A2 ($04B1): tick a one-shot tune. Like c_0375, but when the tune
 * ends it also updates the request slot ($052F):
 *   $08 coin       count down (one jingle per credit)
 *   $0C hi-score   count down; at 0, or on an odd count, request $16
 *   $14 perfect!   clear, and request the dive-attack sound $13
 *   $07 ship shot  [rev B] clear, plus most other requests and active
 *                  flags (all but $08 coin, $0A extra fighter)
 *   others         clear
 * @see galaga-sound.asm $04B1
 * @param {Machine} m
 */
export function c_04A2(m) {
  loadParms(m);
  startIfIdle(m);
  if (!playTracks(m)) return;
  const idx = m.peek(ACTV_SND_IDX);
  const hl = page9A(0xa0, idx);
  switch (idx) {
    case 0x08:
      m.poke(hl, (m.peek(hl) - 1) & 0xff);
      return;
    case 0x0c: {
      // $054F: dec (hl) / jr z / bit 0,(hl) / ret z
      const v = (m.peek(hl) - 1) & 0xff;
      m.poke(hl, v);
      if (v !== 0 && (v & 1) === 0) return;
      m.poke(0x9ab6, 1);
      return;
    }
    case 0x14:
      m.poke(hl, 0);
      m.poke(0x9ab3, 1);
      return;
    case 0x07: {
      // $0563 [rev B]: the fighter's death silences the tunes.
      m.poke(hl, 0);
      let p = rst18(m, 0x9aa0, 0, 8); // $9AA0-$9AA7
      p += 1; m.poke(p, 0); // $9AA9 (skips $9AA8 coin)
      p += 2; // skip $9AAA extra fighter
      rst18(m, p, 0, 0x0c); // $9AAB-$9AB6
      p = rst18(m, 0x9ac0, 0, 8); // $9AC0-$9AC7
      p += 1; m.poke(p, 0); // $9AC9
      p += 2;
      rst18(m, p, 0, 0x0c); // $9ACB-$9AD6
      return;
    }
    default:
      m.poke(hl, 0);
  }
}

// ------------------------------------------------------- note engine

/**
 * c_0550 ($0581): advance one track by one tick and write its voice.
 *
 * Track k's data (pointer at d_0748_p_snd_fx, $0779 + 2k) is a 3-byte
 * header -- [0] envelope type, [1] decay start, [2] waveform -- then note
 * pairs (note, length) ended by $FF. Note low nibble indexes the base
 * pitch table d_06A9_ndat ($06DA), high nibble is how many octaves to shift
 * down; note $0C is a rest. Length x the slot's tempo byte (d_07A6, $07D7 +
 * slot) is the note's duration in ticks.
 *
 * Volume ("envelope"): note $0C -> 0; else header[0] = 0: flat; 1: ramps
 * up 2 per tick for the first 6 ticks; >= 2: CPL of the tick count for the
 * first 6 ticks (bytes $FF..$FA, of which the WSG keeps the low nibble,
 * i.e. 15..10). Past that, header[1] = 0 means $0A; otherwise $0A until
 * tick header[1], then decaying 10 -> 0.
 * @see galaga-sound.asm $0581
 * @param {Machine} m
 */
export function c_0550(m) {
  const k = m.peek(PARMS_IDX);
  // $0581: sound_fx_status[k]++ -- the tick counter of the current note.
  const st = page9A(0x00, k);
  m.poke(st, (m.peek(st) + 1) & 0xff);

  // $058A: track pointer, 3-byte header into $9A88-$9A8A.
  const data = m.read16('sound', (0x0779 + 2 * m.peek(PARMS_IDX)) & 0xffff);
  m.ldir(0x9a88, data, 3, 'sound');
  // $059D: current pair = data + 3 + offset (rst $10: 16-bit add).
  const ptr = (data + 3 + m.peek(page9A(0x30, m.peek(PARMS_IDX)))) & 0xffff;
  m.poke16(NOTE_PTR, ptr);
  if (m.read('sound', ptr) === 0xff) { j_068B_close_voice_and_exit(m); return; }

  // $05B1: base pitch word of the note, shifted down hi-nibble octaves
  // (srl b / rr c).
  const note = m.read('sound', m.peek16(NOTE_PTR));
  let bc = m.read16('sound', 0x06da + 2 * (note & 0x0f));
  bc >>= (note >> 4) & 0x0f;

  // $05D0: frequency nibbles of the voice ($9A61/$9A66/$9A6B). Each byte
  // goes in whole, then rotated so its high nibble is in the low nibble.
  const voice = m.peek(PARMS_VOICE);
  const f = voice === 0 ? 0x9a61 : voice === 1 ? 0x9a66 : 0x9a6b;
  const c = bc & 0xff;
  const b = bc >> 8;
  m.poke(f, c);
  m.poke(f + 1, rrca4(m.peek(f)));
  m.poke(f + 2, b);
  m.poke(f + 3, rrca4(m.peek(f + 2)));

  // $05F7: volume register of the voice.
  const v2 = m.peek(PARMS_VOICE);
  const vol = v2 === 0 ? 0x9a65 : v2 === 1 ? 0x9a6a : 0x9a6f;
  m.poke(vol, envelope(m));

  // $065F: the voice's waveform from the header.
  m.poke(page9A(0x70, m.peek(PARMS_VOICE)), m.peek(0x9a8a));

  // $066B: duration = tempo[slot] * length, 8-bit shift-and-add multiply;
  // only the low byte (L) is used.
  const tempo = m.read('sound', (0x07d7 + m.peek(ACTV_SND_IDX)) & 0xffff);
  const len = m.read('sound', (m.peek16(NOTE_PTR) + 1) & 0xffff);
  const dur = (tempo * len) & 0xff;

  // $068B: still sounding? Otherwise step to the next pair and restart
  // the tick count.
  if (dur !== m.peek(page9A(0x00, m.peek(PARMS_IDX)))) return;
  const off = page9A(0x30, m.peek(PARMS_IDX));
  m.poke(off, (m.peek(off) + 1) & 0xff);
  m.poke(off, (m.peek(off) + 1) & 0xff);
  m.poke(page9A(0x00, m.peek(PARMS_IDX)), 0);
}

/**
 * The volume computation of c_0550, $060D-$065C. Returns the byte stored
 * (the WSG keeps its low nibble).
 * @param {Machine} m
 * @returns {number}
 */
function envelope(m) {
  // $060D: sub $0C / jr z -- a rest.
  if (m.read('sound', m.peek16(NOTE_PTR)) === 0x0c) return 0;
  const type = m.peek(0x9a88);
  const tick = () => m.peek(page9A(0x00, m.peek(PARMS_IDX)));
  if (type !== 0) {
    const t = tick();
    // $0627 / $0637: cp 6 / jr nc -- the attack lasts 5 ticks.
    if (t < 6) return type === 1 ? (t + t) & 0xff : (~t) & 0xff;
  }
  // $063E: decay.
  const start = m.peek(0x9a89);
  if (start === 0) return 0x0a;
  const t = tick();
  if (t < start) return 0x0a; // sub b / jr c
  const d = t - start;
  if (d >= 0x0a) return 0; // sub $0A / jr nc
  return (0x0a - d) & 0xff; // neg
}

/**
 * j_068B_close_voice_and_exit ($06BC): a track hit its $FF terminator:
 * silence its voice and set $9A78 so the caller ends the slot.
 * @see galaga-sound.asm $06BC
 * @param {Machine} m
 */
export function j_068B_close_voice_and_exit(m) {
  const v = m.peek(PARMS_VOICE);
  m.poke(v === 0 ? 0x9a65 : v === 1 ? 0x9a6a : 0x9a6f, 0);
  m.poke(SND_DONE, 1);
}

// ------------------------------------------------------------ register

/**
 * Reset entry for the scheduler: the foreground generator.
 * @param {Machine} m
 * @returns {Generator<symbol|undefined, void, void>}
 */
export function sound_reset(m) { return RESET(m); }

/**
 * NMI entry for the scheduler ($0066), run at lines 64 and 192.
 * @param {Machine} m
 */
export function sound_nmi(m) { sub_0066(m); }

Object.assign(SOUND, {
  sound_reset, sound_nmi, RESET, sub_0066, c_nmi_proc, l_033D_clear_all,
  j_0357_set_SFRs, l_067A_reset_sfrs, c_0375, c_03F4, c_044A, c_04A2, c_0550,
  j_068B_close_voice_and_exit,
});
Object.assign(SOUND_AT, {
  0x0000: RESET, 0x0066: sub_0066, 0x0085: RESET, 0x00bb: c_nmi_proc,
  0x034c: l_033D_clear_all, 0x0366: j_0357_set_SFRs, 0x0384: c_0375,
  0x0403: c_03F4, 0x0459: c_044A, 0x04b1: c_04A2, 0x0581: c_0550,
  0x06ab: l_067A_reset_sfrs, 0x06bc: j_068B_close_voice_and_exit,
});
