// Copyright 2026 by Moshix
/**
 * Emit src/video/{tiles,sprites,palette}.js from the Galaga ROM set, and draw
 * reference sheets of the result into assets/ so a human can check them.
 *
 * Nothing here is transcribed: the graphics are decoded from gg1_9.4l (chars)
 * and gg1_11.4d + gg1_10.4f (sprites) with MAME's own gfx_layout descriptions,
 * and the colours are computed from the three PROMs with a port of MAME's
 * resistor-network math (src/video/resnet.js).
 *
 * ORIENTATION. Bitmaps are emitted in RASTER orientation -- the way MAME's
 * gfxdecode holds them and the way the video hardware scans them, i.e. the
 * monitor's native 288x224 landscape frame. They are NOT pre-rotated. The
 * renderer composes the frame in raster space exactly like MAME's
 * screen_update_galaga() and rotates the finished frame once (ROT90) into the
 * player's 224x288 view. Keeping MAME's orientation makes every coordinate,
 * flip bit and clip rule in the renderer a literal copy of MAME's, which is
 * the whole point of an exact port. The PNG sheets below, by contrast, are
 * drawn rotated so they look like what the player sees.
 *
 * Usage: node tools/gen-graphics.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadGalaga, ROOT } from './romset.mjs';
import { encodePng } from './png.mjs';
import { galagaCorePalette, galagaStarPalette } from '../src/video/resnet.js';

/**
 * A MAME gfx_layout. All offsets are in BITS, as in MAME.
 * @typedef {{width: number, height: number, planes: number[],
 *   xoffset: number[], yoffset: number[], increment: number}} GfxLayout
 */

/**
 * MAME's STEPn(start, step) macros.
 * @param {number} n @param {number} start @param {number} step_ @returns {number[]}
 */
const step = (n, start, step_) => Array.from({ length: n }, (_, i) => start + i * step_);

/**
 * charlayout_2bpp (galaga.cpp line 1428): 8x8, 2 planes at bit offsets 0 and 4
 * of each byte. The left half of the character (x 0-3) comes from bytes 8-15,
 * the right half (x 4-7) from bytes 0-7; each byte is one row.
 * @type {GfxLayout}
 */
export const CHAR_LAYOUT = {
  width: 8,
  height: 8,
  planes: [0, 4],
  xoffset: [...step(4, 8 * 8, 1), ...step(4, 0 * 8, 1)],
  yoffset: step(8, 0 * 8, 8),
  increment: 16 * 8,
};

/**
 * spritelayout_galaga (galaga.cpp line 1472): 16x16, 2 planes, four 4-pixel
 * wide column strips at bytes 0, 8, 16, 24, and rows 8-15 32 bytes further on.
 * @type {GfxLayout}
 */
export const SPRITE_LAYOUT = {
  width: 16,
  height: 16,
  planes: [0, 4],
  xoffset: [...step(4, 0 * 8, 1), ...step(4, 8 * 8, 1), ...step(4, 16 * 8, 1), ...step(4, 24 * 8, 1)],
  yoffset: [...step(8, 0 * 8, 8), ...step(8, 32 * 8, 8)],
  increment: 64 * 8,
};

/**
 * Decode a ROM region with a gfx_layout, the way MAME's gfx_element does:
 * bits are numbered MSB first within each byte, and plane 0 (the first entry
 * of `planes`) supplies the MOST significant bit of the pixel value.
 * @param {Uint8Array} rom
 * @param {GfxLayout} layout
 * @returns {Uint8Array} pixel (x, y) of element n at n*w*h + y*w + x
 */
export function decodeGfx(rom, layout) {
  const { width, height, planes, xoffset, yoffset, increment } = layout;
  const count = (rom.length * 8) / increment; // RGN_FRAC(1,1)
  const out = new Uint8Array(count * width * height);
  const bit = (/** @type {number} */ b) => (rom[b >> 3] >> (7 - (b & 7))) & 1;
  for (let n = 0; n < count; n += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let v = 0;
        for (let p = 0; p < planes.length; p += 1) {
          const b = n * increment + planes[p] + yoffset[y] + xoffset[x];
          v |= bit(b) << (planes.length - 1 - p);
        }
        out[(n * height + y) * width + x] = v;
      }
    }
  }
  return out;
}

/**
 * init_galaga() (galaga.cpp line 3509): the second half of the character ROM
 * holds the hardware's x-flipped character set, whose two 8-byte halves are
 * stored the other way round. MAME swaps them so both sets decode with the
 * same layout; so do we.
 * @param {Uint8Array} chars
 * @returns {Uint8Array}
 */
export function unscrambleChars(chars) {
  const rom = Uint8Array.from(chars);
  for (let i = 0; i < rom.length; i += 1) {
    if ((i & 0x0808) === 0x0800) {
      const t = rom[i];
      rom[i] = rom[i + 8];
      rom[i + 8] = t;
    }
  }
  return rom;
}

/**
 * Pack 2-bit pixels four to a byte, low pixel first, and base64 it.
 * @param {Uint8Array} pixels
 * @returns {string}
 */
function packBase64(pixels) {
  const packed = new Uint8Array(Math.ceil(pixels.length / 4));
  for (let i = 0; i < pixels.length; i += 1) packed[i >> 2] |= (pixels[i] & 3) << ((i & 3) * 2);
  return Buffer.from(packed).toString('base64');
}

/** @param {string} b64 @param {number} [width] @returns {string} */
function wrapBase64(b64, width = 96) {
  /** @type {string[]} */
  const lines = [];
  for (let i = 0; i < b64.length; i += width) lines.push(`  '${b64.slice(i, i + width)}'`);
  return lines.join('\n  + ');
}

/** @param {ArrayLike<number>} values @param {number} perLine @returns {string} */
function numberRows(values, perLine) {
  /** @type {string[]} */
  const rows = [];
  for (let i = 0; i < values.length; i += perLine) {
    rows.push(`  ${Array.from(values).slice(i, i + perLine).map((v) => `0x${v.toString(16).padStart(2, '0')}`).join(', ')},`);
  }
  return rows.join('\n');
}

// The unpacker emitted into tiles.js and sprites.js. It works in both the
// browser (atob) and Node (Buffer) so the tests can import the same modules.
const UNPACK = `/** @param {string} b64 @param {number} length @returns {Uint8Array} */
function unpack(b64, length) {
  const binary = typeof atob === 'function'
    ? atob(b64)
    : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = (binary.charCodeAt(i >> 2) >> ((i & 3) * 2)) & 3;
  }
  return out;
}`;

// Emitted into every generated file: they are overwritten wholesale, so a
// notice added to them by hand would not survive the next regeneration.
const PROVENANCE = `// Copyright 2026 by Moshix
/**
 * GENERATED FILE -- do not edit by hand.
 * Run \`node tools/gen-graphics.mjs\` to regenerate.
 *
 * Decoded from the MAME \`galaga\` ROM set (galaga.rom) using MAME's gfx
 * layouts and palette math. The artwork is Namco's, from the 1981 board.
 *
 * Pixels are 2 bits (pen 0-3), packed four per byte and base64 encoded.
 * Bitmaps are in RASTER orientation (the monitor's native landscape scan, as
 * MAME holds them), NOT rotated for the player: the renderer rotates the
 * whole finished frame once. See tools/gen-graphics.mjs.
 */`;

/**
 * Draw a grid of decoded elements, rotated into the player's view (ROT90:
 * raster (x, y) of a WxH element lands at player (H-1-y, x)).
 * @param {Uint8Array} pixels
 * @param {number} size element edge (square elements)
 * @param {number[]} codes elements to draw, row by row
 * @param {number} perRow
 * @param {(code: number, pen: number) => number} colour packed RGBA, or 0 for transparent
 * @returns {{rgba: Uint32Array, width: number, height: number}}
 */
function sheet(pixels, size, codes, perRow, colour) {
  const cell = size + 1;
  const width = perRow * cell + 1;
  const height = Math.ceil(codes.length / perRow) * cell + 1;
  const rgba = new Uint32Array(width * height).fill(0xff402020); // dark blue-grey grid
  codes.forEach((code, i) => {
    const ox = (i % perRow) * cell + 1;
    const oy = Math.floor(i / perRow) * cell + 1;
    for (let py = 0; py < size; py += 1) {
      for (let px = 0; px < size; px += 1) {
        // Player pixel (px, py) comes from raster pixel (py, size-1-px).
        const pen = pixels[(code * size + (size - 1 - px)) * size + py];
        const c = colour(code, pen);
        rgba[(oy + py) * width + ox + px] = c === 0 ? 0xff000000 : c;
      }
    }
  });
  return { rgba, width, height };
}

/** @param {readonly number[]} rgb @returns {number} */
const pack = (rgb) => ((255 << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]) >>> 0;

function main() {
  const rom = loadGalaga();

  // ---- graphics --------------------------------------------------------
  const tiles = decodeGfx(unscrambleChars(rom.chars), CHAR_LAYOUT);
  const sprites = decodeGfx(rom.sprites, SPRITE_LAYOUT);
  const tileCount = tiles.length / 64;
  const spriteCount = sprites.length / 256;

  writeFileSync(join(ROOT, 'src/video/tiles.js'), `${PROVENANCE}

/**
 * Number of 8x8 characters. charlayout_2bpp is RGN_FRAC(1,1) over the 4 KB
 * ROM, i.e. 256: codes 0x00-0x7F are the normal set and 0x80-0xFF the same
 * glyphs mirrored in raster X, which the hardware selects instead of
 * flipping pixels when the screen is flipped (see get_tile_info in MAME's
 * galaga_v.cpp). Video RAM only ever supplies 7 bits of code.
 */
export const TILE_COUNT = ${tileCount};
export const TILE_SIZE = 8;

const PACKED =
${wrapBase64(packBase64(tiles))};

/**
 * All characters as one flat array of 2-bit pens in raster orientation:
 * pixel (x, y) of character n is at \`n * 64 + y * 8 + x\`, where x runs along
 * the monitor's scan line (the player's screen Y, downwards) and y across scan
 * lines (the player's screen X, right to left).
 * @type {Uint8Array}
 */
export const TILE_PIXELS = unpack(PACKED, TILE_COUNT * 64);

${UNPACK}
`);

  writeFileSync(join(ROOT, 'src/video/sprites.js'), `${PROVENANCE}

/**
 * Number of 16x16 sprites: 8 KB / 64 bytes. 0-63 come from gg1_11.4d, 64-127
 * from gg1_10.4f. Double-size sprites use four consecutive codes.
 */
export const SPRITE_COUNT = ${spriteCount};
export const SPRITE_SIZE = 16;

const PACKED =
${wrapBase64(packBase64(sprites))};

/**
 * All sprites as one flat array of 2-bit pens in raster orientation: pixel
 * (x, y) of sprite n is at \`n * 256 + y * 16 + x\` (same axes as TILE_PIXELS).
 * @type {Uint8Array}
 */
export const SPRITE_PIXELS = unpack(PACKED, SPRITE_COUNT * 256);

${UNPACK}
`);

  // ---- colours ---------------------------------------------------------
  const core = galagaCorePalette(rom.palette);
  const stars = galagaStarPalette();
  // galaga_palette(): characters use indirect colours 0x10-0x1F, sprites
  // 0x00-0x0F; the PROMs only drive four bits.
  const charLut = Array.from(rom.charLut, (v) => (v & 0x0f) | 0x10);
  const spriteLut = Array.from(rom.spriteLut, (v) => v & 0x0f);

  const rgbRows = (/** @type {number[][]} */ list, /** @type {(i: number) => string} */ note) => list
    .map((c, i) => `  [${c.map((v) => String(v).padStart(3, ' ')).join(', ')}], // ${note(i)}`)
    .join('\n');

  writeFileSync(join(ROOT, 'src/video/palette.js'), `// Copyright 2026 by Moshix
/**
 * GENERATED FILE -- do not edit by hand.
 * Run \`node tools/gen-graphics.mjs\` to regenerate.
 *
 * Colours computed from the Galaga colour PROMs (prom-5.5n, prom-4.2n,
 * prom-3.1c) by galaga_state::galaga_palette() in MAME's galaga_v.cpp, using
 * the resistor-network math ported in src/video/resnet.js.
 *
 * MAME's colour model is two-level ("indirect"): a pen of a tile or sprite
 * goes through a lookup PROM to an INDIRECT COLOUR 0-95, which is an RGB value:
 *   0x00-0x0F  palette PROM entries 0-15  (reached by sprites)
 *   0x10-0x1F  palette PROM entries 16-31 (reached by characters)
 *   0x20-0x5F  the 64 starfield colours (05xx output, 2 bits per gun)
 */

/** Indirect colours 0-31: the palette PROM through the 1k/470/220 ladders. @type {ReadonlyArray<readonly [number, number, number]>} */
export const PALETTE = Object.freeze([
${rgbRows(core, (i) => `0x${i.toString(16).padStart(2, '0')} PROM 0x${rom.palette[i].toString(16).padStart(2, '0')}`)}
].map((c) => Object.freeze(c)));

/** Indirect colours 32-95: star colour BBGGRR (2 bits each). @type {ReadonlyArray<readonly [number, number, number]>} */
export const STAR_PALETTE = Object.freeze([
${rgbRows(stars, (i) => `star 0x${i.toString(16).padStart(2, '0')}`)}
].map((c) => Object.freeze(c)));

/** Offset of the star colours in the indirect colour space. */
export const STAR_COLOR_BASE = 32;

/**
 * Character colour lookup: CHAR_LUT[colour * 4 + pen] is the indirect colour
 * (0x10-0x1F) of pen \`pen\` of a character in colour code \`colour\` (0-63).
 * @type {Uint8Array}
 */
export const CHAR_LUT = Uint8Array.from([
${numberRows(charLut, 16)}
]);

/**
 * Sprite colour lookup: SPRITE_LUT[colour * 4 + pen] is the indirect colour
 * (0x00-0x0F) of pen \`pen\` of a sprite in colour code \`colour\` (0-63).
 * @type {Uint8Array}
 */
export const SPRITE_LUT = Uint8Array.from([
${numberRows(spriteLut, 16)}
]);

/**
 * Transparency is decided by the LOOKED-UP colour, not the pen number:
 * a character pixel is see-through where CHAR_LUT gives 0x1F
 * (configure_groups(gfx, 0x1f) in video_start), a sprite pixel where
 * SPRITE_LUT gives 0x0F (transpen_mask(..., 0x0f) in draw_sprites).
 */
export const CHAR_TRANSPARENT = 0x1f;
export const SPRITE_TRANSPARENT = 0x0f;
`);

  // ---- reference sheets ------------------------------------------------
  mkdirSync(join(ROOT, 'assets'), { recursive: true });
  const coreRgba = core.map(pack);

  // Characters: all 256 in colour 0 (white text on the hardware), 16 per row.
  const charColour = (/** @type {number} */ c) => (/** @type {number} */ _code, /** @type {number} */ pen) => {
    const ind = charLut[c * 4 + pen];
    return ind === 0x1f ? 0 : coreRgba[ind];
  };
  const tileSheet = sheet(tiles, 8, step(tileCount, 0, 1), 16, charColour(0));
  writeFileSync(join(ROOT, 'assets/tiles.png'), encodePng(tileSheet.rgba, tileSheet.width, tileSheet.height, 4));

  // Sprites: every sprite in every non-empty colour code, one row of 128
  // sprites (as 8 lines of 16) per colour block, blocks stacked 3 across.
  const spriteColours = step(16, 0, 1).filter((c) => spriteLut.slice(c * 4, c * 4 + 4).some((v) => v !== 0));
  const blocks = spriteColours.map((c) => sheet(sprites, 16, step(spriteCount, 0, 1), 16, (_code, pen) => {
    const ind = spriteLut[c * 4 + pen];
    return ind === 0x0f ? 0 : coreRgba[ind];
  }));
  const across = 3;
  const bw = blocks[0].width + 4;
  const bh = blocks[0].height + 4;
  const sw = across * bw;
  const sh = Math.ceil(blocks.length / across) * bh;
  const spriteSheet = new Uint32Array(sw * sh).fill(0xff808080);
  blocks.forEach((b, i) => {
    const ox = (i % across) * bw + 2;
    const oy = Math.floor(i / across) * bh + 2;
    for (let y = 0; y < b.height; y += 1) {
      spriteSheet.set(b.rgba.subarray(y * b.width, (y + 1) * b.width), (oy + y) * sw + ox);
    }
  });
  writeFileSync(join(ROOT, 'assets/sprites.png'), encodePng(spriteSheet, sw, sh, 1));
  // A single large block in colour 1 for close inspection.
  writeFileSync(join(ROOT, 'assets/sprites-c1.png'), encodePng(blocks[1].rgba, blocks[1].width, blocks[1].height, 3));

  // Palette: row 0 the 32 PROM colours, rows 1-2 the 64 star colours.
  const sw2 = 32;
  const pal = new Uint32Array(sw2 * 3);
  core.forEach((c, i) => { pal[i] = pack(c); });
  stars.forEach((c, i) => { pal[sw2 + i] = pack(c); });
  writeFileSync(join(ROOT, 'assets/palette.png'), encodePng(pal, sw2, 3, 16));

  console.log('wrote src/video/tiles.js    ', tileCount, 'characters');
  console.log('wrote src/video/sprites.js  ', spriteCount, 'sprites');
  console.log('wrote src/video/palette.js  ', core.length, 'colours +', stars.length, 'star colours');
  console.log('wrote assets/tiles.png, sprites.png, sprites-c1.png, palette.png');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
