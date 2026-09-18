// Copyright 2026 by Moshix
/**
 * The Namco 05xx starfield generator, ported from MAME's starfield_05xx.cpp.
 *
 * Like Galaxian's stars, Galaga's are not data: the 05xx runs a 16-bit
 * Fibonacci LFSR once per pixel over a 256x256 window of the frame and emits a
 * star wherever the register happens to hold a "hit" pattern. Reproducing the
 * register and its clocking reproduces the exact star positions and colours.
 *
 * What the port preserves, and why it matters:
 *
 *  - The LFSR period is 65535, one short of the 65536 pixels it runs over per
 *    frame. That one-clock slip is what makes the field drift by one pixel per
 *    frame even at "speed 0". All scrolling is done by running a few extra or
 *    fewer clocks in the invisible part of the frame (SCROLL_X table below).
 *  - Only 256 of the 65535 states are hits (8 of the 16 bits are pinned), so a
 *    frame holds at most 256 stars in 4 sets of 64; the SF0/SF1 inputs choose
 *    which two sets are shown. Alternating sets is what makes stars blink.
 *  - _STARCLR low stops the register AND reloads the seed 0x7FFF, so the
 *    field restarts identically every time the game clears it.
 *
 * Everything is in RASTER space (the monitor's native 288x224 landscape
 * frame); the renderer rotates the finished frame into the player's view.
 * The object is a plain state machine -- no clocks, no randomness -- so a
 * frame's output is a pure function of its fields and can be unit tested.
 */

/** Seed loaded while _STARCLR is low. starfield_05xx.cpp LFSR_SEED. */
export const LFSR_SEED = 0x7fff;
/** A hit is `(lfsr & LFSR_HIT_MASK) === LFSR_HIT_VALUE`: bits 14-11 set, 15/9/4/2 clear. */
export const LFSR_HIT_MASK = 0xfa14;
export const LFSR_HIT_VALUE = 0x7800;

/** Lines the LFSR runs over while the beam is in the visible 224 lines. */
const VISIBLE_LINES = 224;
/** The 05xx's LFSR_RUN window is 256 pixel clocks per line. */
const STARFIELD_PIXEL_WIDTH = 256;
const LFSR_CYCLES_PER_LINE = 256;

/**
 * Extra (+) or withheld (-) LFSR clocks per frame for each SCROLL_X input
 * value (starfield_05xx.cpp speed_X_cycle_count_offset). Index 0 advances one
 * pixel per frame in -X, index 7 is stationary.
 */
export const SPEED_X_CYCLE_OFFSET = Object.freeze([0, 1, 2, 3, -4, -3, -2, -1]);

/**
 * LFSR clocks before and after the visible lines, per SCROLL_Y input value
 * (pre_vis_cycle_count_values / post_vis_cycle_count_values). Galaga ties
 * SCROLL_Y to ground so only index 0 is used, but the table is kept whole.
 */
export const PRE_VIS_CYCLES = Object.freeze([22, 23, 22, 23, 19, 20, 20, 22].map((n) => n * LFSR_CYCLES_PER_LINE));
export const POST_VIS_CYCLES = Object.freeze([10, 10, 12, 12, 9, 9, 10, 9].map((n) => n * LFSR_CYCLES_PER_LINE));

/**
 * Galaga's set_starfield_config() (galaga.cpp lines 716-717 and 1717): the
 * 256-pixel star window starts 16 pixels into the 288-pixel raster line, and
 * no Y offset.
 */
export const STARFIELD_X_OFFSET_GALAGA = 16;
export const STARFIELD_X_LIMIT_GALAGA = 256 + STARFIELD_X_OFFSET_GALAGA;

/**
 * One step of the Fibonacci LFSR (get_next_lfsr_state): taps at bits
 * 0, 3, 5 and 10 (the doc's "16, 13, 11, 6" counted from the other end),
 * feedback shifted in at bit 15. Maximal length: 65535 states.
 * @param {number} lfsr 16-bit state
 * @returns {number}
 */
export function nextLfsr(lfsr) {
  const bit = (lfsr ^ (lfsr >> 3) ^ (lfsr >> 5) ^ (lfsr >> 10)) & 1;
  return (lfsr >> 1) | (bit << 15);
}

/**
 * Which of the four star sets a hit belongs to: bits 10 and 8 (bitswap<2>).
 * @param {number} lfsr @returns {number} 0-3
 */
export function starSet(lfsr) {
  return (((lfsr >> 10) & 1) << 1) | ((lfsr >> 8) & 1);
}

/**
 * The 6-bit star colour BBGGRR of a hit, computed exactly as draw_starfield()
 * does: the complement of register bits (3 1 0 7 6 5). The 05xx notes write
 * this as (!B4 !B1 !B0 !B7 !B6 !B5) because their hit diagram relabels the
 * bit at position 3 as "B4"; the code, which we follow, uses position 3.
 * @param {number} lfsr @returns {number} 0-63
 */
export function starColor(lfsr) {
  let color = (lfsr >> 5) & 0x7;
  color |= (lfsr << 3) & 0x18;
  color |= (lfsr << 2) & 0x20;
  return (~color) & 0x3f;
}

export class Starfield {
  /** Output enable, from _STARCLR. */
  enable = 0;
  /** The 16-bit register. */
  lfsr = LFSR_SEED;
  /** Clocks before the visible lines (uint16 in MAME). */
  preVisCycleCount = 0;
  /** Clocks after the visible lines (uint16 in MAME). */
  postVisCycleCount = 0;
  /** The two active star sets (SF0 and SF1|2 on Galaga). */
  setA = 0;
  setB = 0;
  offsetX = STARFIELD_X_OFFSET_GALAGA;
  offsetY = 0;
  limitX = STARFIELD_X_LIMIT_GALAGA;

  /** device_reset(): everything off, seed loaded. */
  reset() {
    this.enable = 0;
    this.lfsr = LFSR_SEED;
    this.preVisCycleCount = 0;
    this.postVisCycleCount = 0;
    this.setA = 0;
    this.setB = 0;
  }

  /**
   * enable_starfield(): _STARCLR. Low (0) disables output and reseeds.
   * @param {number} on
   */
  enableStarfield(on) {
    if (!on) this.lfsr = LFSR_SEED;
    this.enable = on ? 1 : 0;
  }

  /**
   * set_scroll_speed(): X scrolling is folded into the pre-visible count
   * because that is where the 05xx inserts or skips its clocks.
   * @param {number} indexX SCROLL_X2..0 (0-7)
   * @param {number} indexY SCROLL_Y2..0 (0-7), always 0 on Galaga
   */
  setScrollSpeed(indexX, indexY) {
    // MAME holds these in uint16_t; the mask keeps the same wrap behaviour.
    this.preVisCycleCount = (PRE_VIS_CYCLES[indexY & 7] + SPEED_X_CYCLE_OFFSET[indexX & 7]) & 0xffff;
    this.postVisCycleCount = POST_VIS_CYCLES[indexY & 7] & 0xffff;
  }

  /**
   * set_active_starfield_sets()
   * @param {number} setA @param {number} setB
   */
  setActiveStarfieldSets(setA, setB) {
    this.setA = setA;
    this.setB = setB;
  }

  /**
   * galaga_state::screen_vblank_galaga() on the falling edge of VBLANK: sample
   * the video latch (LS259 at 5K) into the 05xx inputs.
   *   Q0-Q2 SCROLL_X, SCROLL_Y tied low; Q3 SF0; Q4 SF1 (set B is Q4|2,
   *   because of how SF1 selects between sets 2 and 3); Q5 _STARCLR.
   * @param {ArrayLike<number>} latch 8 entries, 0 or 1 (bit 0 of each $A00x write)
   */
  vblank(latch) {
    const speedX = ((latch[2] & 1) << 2) | ((latch[1] & 1) << 1) | (latch[0] & 1);
    this.setScrollSpeed(speedX, 0);
    this.setActiveStarfieldSets(latch[3] & 1, (latch[4] & 1) | 2);
    this.enableStarfield(latch[5] & 1);
  }

  /**
   * draw_starfield(): run the LFSR through one whole frame and write a star
   * pixel into the raster buffer at every hit of an active set.
   *
   * @param {Uint8Array} raster raster-space frame of indirect colour indices
   * @param {number} width raster line length (288)
   * @param {number} height visible lines (224)
   * @param {number} colorBase indirect index of star colour 0
   * @param {number} [flip] MAME's flip argument; Galaga always passes 0
   */
  draw(raster, width, height, colorBase, flip = 0) {
    if (!this.enable) return;

    let lfsr = this.lfsr;

    // MAME uses do { } while (--count) on a uint16_t, so a count of 0 would
    // run 65536 times; mirror that rather than silently doing nothing.
    let pre = this.preVisCycleCount;
    do { lfsr = nextLfsr(lfsr); pre = (pre - 1) & 0xffff; } while (pre);

    const setA = this.setA;
    const setB = this.setB;
    const yEnd = VISIBLE_LINES + this.offsetY;
    const xEnd = STARFIELD_PIXEL_WIDTH + this.offsetX;
    for (let y = this.offsetY; y < yEnd; y += 1) {
      for (let x = this.offsetX; x < xEnd; x += 1) {
        if ((lfsr & LFSR_HIT_MASK) === LFSR_HIT_VALUE) {
          const set = starSet(lfsr);
          if ((setA === set || setB === set) && x < this.limitX) {
            const dx = flip ? x + 64 : x;
            // cliprect.contains(): the screen's visible area.
            if (dx >= 0 && dx < width && y >= 0 && y < height) {
              raster[y * width + dx] = colorBase + starColor(lfsr);
            }
          }
        }
        lfsr = nextLfsr(lfsr);
      }
    }

    let post = this.postVisCycleCount;
    do { lfsr = nextLfsr(lfsr); post = (post - 1) & 0xffff; } while (post);

    this.lfsr = lfsr;
  }
}
