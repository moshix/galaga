// Copyright 2026 by Moshix
/**
 * Turns the Galaga board's video memory into pixels, the way MAME's
 * galaga_state::screen_update_galaga() does (reference/mame/galaga_v.cpp).
 *
 * The renderer reads only video RAM, the sprite registers and the video latch,
 * so it does not care whether those were filled in by the JavaScript port or
 * by the original Z80 program running in the emulator oracle. That is
 * deliberate: the real 1981 game can be rendered through this code and the
 * two compared pixel for pixel.
 *
 * COORDINATES. The monitor is mounted on its side (ROT90). The hardware, and
 * this renderer, compose the frame in RASTER space -- the monitor's native
 * 288 x 224 landscape scan -- and only the finished frame is rotated into the
 * player's 224 x 288 portrait view:
 *
 *     playerX = 223 - rasterY        rasterY in [0, 223]
 *     playerY = rasterX              rasterX in [0, 287]
 *
 * Working in raster space keeps every constant, flip bit and wraparound rule
 * below a literal copy of MAME's code, which is the point of an exact port.
 *
 * LAYERS, back to front (screen_update_galaga):
 *   1. black fill
 *   2. the 05xx starfield
 *   3. 64 sprites, in register order (a later sprite covers an earlier one)
 *   4. the 36 x 28 character layer
 *
 * The composed frame holds MAME "indirect colour" indices (0-31 PROM colours,
 * 32-95 star colours, plus BLACK); a 97-entry table turns them into RGBA
 * during the rotation pass.
 */

import { PALETTE, STAR_PALETTE, STAR_COLOR_BASE, CHAR_LUT, SPRITE_LUT,
  CHAR_TRANSPARENT, SPRITE_TRANSPARENT } from './palette.js';
import { TILE_PIXELS } from './tiles.js';
import { SPRITE_PIXELS, SPRITE_COUNT } from './sprites.js';
import { Starfield } from './starfield.js';

/** The player's view, after ROT90. */
export const SCREEN_WIDTH = 224;
export const SCREEN_HEIGHT = 288;

/** Raster space: set_raw(MASTER_CLOCK/3, 384, 0, 288, 264, 0, 224). */
export const RASTER_WIDTH = 288;
export const RASTER_HEIGHT = 224;

/** Tilemap geometry: 36 columns x 28 rows of 8x8 cells, in raster space. */
export const TILEMAP_COLS = 36;
export const TILEMAP_ROWS = 28;

/** Indirect colour index used for the black background fill. */
export const BLACK = 96;

/** Offsets of the sprite register blocks within ram1/ram2/ram3. */
const SPRITE_REGS = 0x380;
/** Offset of colour RAM ($8400) within the video RAM block ($8000). */
const COLOR_RAM = 0x400;

/**
 * tilemap_scan() (galaga_v.cpp): which video RAM offset a raster tilemap cell
 * reads. The board's RAM is organised as a 32x32 map; the 36x28 screen is
 * carved out of it. Columns 2-33 are the 32x28 playfield (offset
 * $040-$3BF: row-major, 32 cells per raster row). Columns 0-1 and 34-35 are
 * the two strips at the player's top and bottom; their col-2 goes negative or
 * past 31, sets bit 5, and they borrow the unused ends of the map:
 * $3C0-$3FF (player's top two rows) and $000-$03F (bottom two rows), each
 * strip 32 bytes of which only offsets 2-29 are on screen.
 *
 * @param {number} col raster column 0-35 (the player's row, top to bottom)
 * @param {number} row raster row 0-27 (the player's column, right to left)
 * @returns {number} offset 0-0x3FF into tile RAM ($8000) / colour RAM ($8400)
 */
export function tilemapScan(col, row) {
  const r = row + 2;
  const c = col - 2;
  // (c & 0x1f) in JS matches C for c = -2 / -1 (two's complement), giving
  // 30 / 31, i.e. the strips at $3C0 and $3E0.
  if (c & 0x20) return r + ((c & 0x1f) << 5);
  return c + (r << 5);
}

/**
 * The same mapping in the player's coordinates.
 * @param {number} x player's column, 0 (left) - 27 (right)
 * @param {number} y player's row, 0 (top) - 35 (bottom)
 * @returns {number} offset 0-0x3FF
 */
export function playerCellOffset(x, y) {
  return tilemapScan(y, TILEMAP_ROWS - 1 - x);
}

/** tilemapScan() for every raster cell, index row * 36 + col. */
const TILEMAP_OFFSET = (() => {
  const t = new Uint16Array(TILEMAP_COLS * TILEMAP_ROWS);
  for (let row = 0; row < TILEMAP_ROWS; row += 1) {
    for (let col = 0; col < TILEMAP_COLS; col += 1) t[row * TILEMAP_COLS + col] = tilemapScan(col, row);
  }
  return t;
})();

/** @param {readonly number[]} rgb @returns {number} little-endian RGBA as a Uint32 */
const rgba = (rgb) => ((255 << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]) >>> 0;

/** Indirect colour -> RGBA: 0-31 PROM, 32-95 stars, 96 black. */
const COLOR_RGBA = (() => {
  const t = new Uint32Array(BLACK + 1);
  PALETTE.forEach((c, i) => { t[i] = rgba(c); });
  STAR_PALETTE.forEach((c, i) => { t[STAR_COLOR_BASE + i] = rgba(c); });
  t[BLACK] = rgba([0, 0, 0]);
  return t;
})();

/**
 * gfx_offs[][] of draw_sprites(): the sub-sprite codes of a double-size
 * sprite, [row][col] in raster space.
 */
const GFX_OFFS = [[0, 1], [2, 3]];

export class Renderer {
  /** The player's 224 x 288 view as packed RGBA, ready for putImageData. */
  pixels = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);

  /**
   * The composed frame in raster space (288 x 224), one indirect colour
   * index per pixel. Exposed so tests and the oracle can compare frames
   * without going through RGB.
   */
  raster = new Uint8Array(RASTER_WIDTH * RASTER_HEIGHT);

  starfield = new Starfield();

  /** Q7 of the video latch, as of the last render(). */
  flipScreen = 0;

  /**
   * Render one frame.
   *
   * The latch is applied first, standing in for screen_vblank_galaga(): on
   * the board the 05xx samples Q0-Q5 at the END of vertical blank, i.e. just
   * before the frame is scanned, so the values the game wrote during the
   * previous blank are the ones this frame is drawn with. Pass the latch as
   * it stands when the frame is drawn (the start of the next blank); omit it
   * to keep the previous settings. Q7 (flip) takes effect immediately, as
   * MAME's flip_screen_set() does.
   *
   * @param {Uint8Array} video $8000-$87FF: tile codes, then tile colours
   * @param {Uint8Array} ram1 $8800-$8BFF (sprite code/colour at +$380)
   * @param {Uint8Array} ram2 $9000-$93FF (sprite position at +$380)
   * @param {Uint8Array} ram3 $9800-$9BFF (sprite flip/size/x-high at +$380)
   * @param {ArrayLike<number>} [latch] $A000-$A007, bit 0 of each write
   */
  render(video, ram1, ram2, ram3, latch) {
    if (latch) {
      this.starfield.vblank(latch);
      this.flipScreen = latch[7] & 1;
    }
    this.raster.fill(BLACK);
    this.starfield.draw(this.raster, RASTER_WIDTH, RASTER_HEIGHT, STAR_COLOR_BASE, 0);
    this.drawSprites(ram1, ram2, ram3);
    this.drawTilemap(video);
    this.rotate();
  }

  /**
   * draw_sprites() of galaga_v.cpp, register for register.
   *
   *   ram1+$380+2n  bits 0-6 sprite code        ram1+$381+2n  bits 0-5 colour
   *   ram2+$380+2n  Y: raster line = 257 - v     ram2+$381+2n  X bits 0-7
   *   ram3+$380+2n  bit 0 flip X, bit 1 flip Y, bit 2 double width (X),
   *                 bit 3 double height (Y)
   *   ram3+$381+2n  bits 0-1 X bits 8-9 -- a sprite is "disabled" by setting
   *                 bit 1, which pushes it far past the right edge
   *
   * @param {Uint8Array} ram1 @param {Uint8Array} ram2 @param {Uint8Array} ram3
   */
  drawSprites(ram1, ram2, ram3) {
    const out = this.raster;
    const flipScreen = this.flipScreen;
    for (let offs = 0; offs < 0x80; offs += 2) {
      const r = SPRITE_REGS + offs;
      const sprite = ram1[r] & 0x7f;
      const color = ram1[r + 1] & 0x3f;
      const sx = ram2[r + 1] - 40 + 0x100 * (ram3[r + 1] & 3);
      // "sprites are buffered and delayed by one scanline" -- hence the +1.
      let sy = 256 - ram2[r] + 1;
      let flipx = ram3[r] & 0x01;
      let flipy = (ram3[r] & 0x02) >> 1;
      const sizex = (ram3[r] & 0x04) >> 2;
      const sizey = (ram3[r] & 0x08) >> 3;

      // A double-height sprite grows upwards from its nominal position, and
      // the 8-bit line counter wraps: lines 224-255 land at -32..-1 (hidden
      // above the top), which is how the game parks sprites off screen.
      sy -= 16 * sizey;
      sy = (sy & 0xff) - 32;

      if (flipScreen) {
        flipx ^= 1;
        flipy ^= 1;
      }

      // Colour lookup and transparency for this sprite's four pens.
      const lut = color * 4;

      for (let y = 0; y <= sizey; y += 1) {
        for (let x = 0; x <= sizex; x += 1) {
          // When a double sprite is flipped, its quarters trade places too.
          // MAME's gfx element draw wraps the code modulo the element count.
          const code = (sprite + GFX_OFFS[y ^ (sizey * flipy)][x ^ (sizex * flipx)]) % SPRITE_COUNT;
          this.drawSprite16(out, code * 256, lut, flipx, flipy, sx + 16 * x, sy + 16 * y);
        }
      }
    }
  }

  /**
   * One 16x16 transmask draw, clipped to the raster.
   * @param {Uint8Array} out @param {number} base SPRITE_PIXELS index of the sprite
   * @param {number} lut SPRITE_LUT index of pen 0 @param {number} flipx
   * @param {number} flipy @param {number} dx left @param {number} dy top
   */
  drawSprite16(out, base, lut, flipx, flipy, dx, dy) {
    if (dx >= RASTER_WIDTH || dy >= RASTER_HEIGHT || dx <= -16 || dy <= -16) return;
    const x0 = dx < 0 ? -dx : 0;
    const x1 = dx + 16 > RASTER_WIDTH ? RASTER_WIDTH - dx : 16;
    const y0 = dy < 0 ? -dy : 0;
    const y1 = dy + 16 > RASTER_HEIGHT ? RASTER_HEIGHT - dy : 16;
    for (let py = y0; py < y1; py += 1) {
      const srcRow = base + (flipy ? 15 - py : py) * 16;
      const dstRow = (dy + py) * RASTER_WIDTH + dx;
      for (let px = x0; px < x1; px += 1) {
        const ind = SPRITE_LUT[lut + SPRITE_PIXELS[srcRow + (flipx ? 15 - px : px)]];
        if (ind !== SPRITE_TRANSPARENT) out[dstRow + px] = ind;
      }
    }
  }

  /**
   * The 36x28 character layer (get_tile_info + tilemap draw).
   *
   * Flip screen: MAME's tilemap flips the whole layer (cell (c, r) is shown at
   * (35-c, 27-r) with both pixel axes flipped), and get_tile_info adds
   * TILE_FLIPX and selects the hardware's x-mirrored character set (+0x80).
   * The two X flips cancel, so the glyph is taken from the mirrored set and
   * flipped only in Y -- which is exactly what the board does: Y by inverting
   * its timing, X by switching character set.
   *
   * @param {Uint8Array} video
   */
  drawTilemap(video) {
    const out = this.raster;
    const flip = this.flipScreen;
    const bank = flip ? 0x80 : 0;
    for (let row = 0; row < TILEMAP_ROWS; row += 1) {
      for (let col = 0; col < TILEMAP_COLS; col += 1) {
        const offs = TILEMAP_OFFSET[row * TILEMAP_COLS + col];
        const base = ((video[offs] & 0x7f) | bank) * 64;
        const lut = (video[offs + COLOR_RAM] & 0x3f) * 4;
        const cellX = (flip ? TILEMAP_COLS - 1 - col : col) * 8;
        const cellY = (flip ? TILEMAP_ROWS - 1 - row : row) * 8;
        for (let py = 0; py < 8; py += 1) {
          const srcRow = base + (flip ? 7 - py : py) * 8;
          const dstRow = (cellY + py) * RASTER_WIDTH + cellX;
          for (let px = 0; px < 8; px += 1) {
            // configure_groups(gfx, 0x1f): per colour, pens that look up to
            // indirect colour 0x1F are transparent.
            const ind = CHAR_LUT[lut + TILE_PIXELS[srcRow + px]];
            if (ind !== CHAR_TRANSPARENT) out[dstRow + px] = ind;
          }
        }
      }
    }
  }

  /** ROT90: raster (x, y) -> player (223 - y, x), through the colour table. */
  rotate() {
    const src = this.raster;
    const dst = this.pixels;
    for (let ry = 0; ry < RASTER_HEIGHT; ry += 1) {
      const px = SCREEN_WIDTH - 1 - ry;
      let s = ry * RASTER_WIDTH;
      for (let rx = 0; rx < RASTER_WIDTH; rx += 1) {
        dst[rx * SCREEN_WIDTH + px] = COLOR_RGBA[src[s]];
        s += 1;
      }
    }
  }
}
