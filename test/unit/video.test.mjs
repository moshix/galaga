// Copyright 2026 by Moshix
/**
 * Tests for the video layer: the tilemap address mapping, the palette math,
 * the 05xx starfield, the decoded graphics and the renderer as a whole.
 *
 * Where a test pins a number, the number comes from MAME's source or from the
 * 05xx documentation in reference/mame/starfield_05xx.cpp, not from running
 * the code under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGalaga } from '../../tools/romset.mjs';
import { decodeGfx, unscrambleChars, CHAR_LAYOUT, SPRITE_LAYOUT } from '../../tools/gen-graphics.mjs';
import { blankBoard, putText, putSprite, charCode } from '../../tools/render-sheet.mjs';
import { computeResistorWeights, combineWeights, galagaCorePalette, galagaStarPalette } from '../../src/video/resnet.js';
import { PALETTE, STAR_PALETTE, CHAR_LUT, SPRITE_LUT } from '../../src/video/palette.js';
import { TILE_PIXELS, TILE_COUNT } from '../../src/video/tiles.js';
import { SPRITE_PIXELS, SPRITE_COUNT } from '../../src/video/sprites.js';
import {
  Starfield, nextLfsr, starSet, starColor, LFSR_SEED, LFSR_HIT_MASK, LFSR_HIT_VALUE,
  SPEED_X_CYCLE_OFFSET, PRE_VIS_CYCLES, POST_VIS_CYCLES,
} from '../../src/video/starfield.js';
import {
  Renderer, SCREEN_WIDTH, SCREEN_HEIGHT, RASTER_WIDTH, RASTER_HEIGHT, BLACK,
  tilemapScan, playerCellOffset,
} from '../../src/video/renderer.js';

const rom = loadGalaga();

// ---------------------------------------------------------------- tilemap

test('tilemap: top two rows come from $83C0-$83FF, right to left', () => {
  // mrw.s ascii art: row "2" (the player's top row) runs .3DD ... .3C2.
  assert.equal(playerCellOffset(0, 0), 0x3dd);
  assert.equal(playerCellOffset(27, 0), 0x3c2);
  assert.equal(playerCellOffset(0, 1), 0x3fd);
  assert.equal(playerCellOffset(27, 1), 0x3e2);
});

test('tilemap: playfield is $040-$3BF, columns 32 bytes apart', () => {
  assert.equal(playerCellOffset(0, 2), 0x3a0);   // top-left
  assert.equal(playerCellOffset(27, 2), 0x040);  // top-right
  assert.equal(playerCellOffset(0, 33), 0x3bf);  // bottom-left
  assert.equal(playerCellOffset(27, 33), 0x05f); // bottom-right
  // One step right on screen is 32 bytes DOWN in RAM; one step down is +1.
  assert.equal(playerCellOffset(5, 10) - playerCellOffset(6, 10), 0x20);
  assert.equal(playerCellOffset(5, 11) - playerCellOffset(5, 10), 1);
});

test('tilemap: bottom two rows come from $8000-$803F', () => {
  assert.equal(playerCellOffset(0, 34), 0x01d);
  assert.equal(playerCellOffset(27, 34), 0x002);
  assert.equal(playerCellOffset(0, 35), 0x03d);
  assert.equal(playerCellOffset(27, 35), 0x022);
});

test('tilemap: raster tilemap_scan matches MAME for the corner cells', () => {
  // col/row are raster; row += 2, col -= 2 (galaga_v.cpp tilemap_scan).
  assert.equal(tilemapScan(0, 0), 0x3c2);
  assert.equal(tilemapScan(35, 27), 0x03d);
  assert.equal(tilemapScan(2, 0), 0x040);
});

test('tilemap: 1008 distinct cells, strip ends never shown', () => {
  const seen = new Set();
  for (let y = 0; y < 36; y += 1) for (let x = 0; x < 28; x += 1) seen.add(playerCellOffset(x, y));
  assert.equal(seen.size, 36 * 28);
  for (const hidden of [0x000, 0x001, 0x01e, 0x01f, 0x3c0, 0x3c1, 0x3de, 0x3df, 0x3e0, 0x3ff]) {
    assert.ok(!seen.has(hidden), `offset ${hidden.toString(16)} should be off screen`);
  }
});

// ---------------------------------------------------------------- palette

test('resnet: 1k/470/220 ladder gives MAME weights 0x21/0x47/0x97, blue 0x51/0xAE', () => {
  const [r, g, b] = computeResistorWeights(0, 255, -1, [
    { resistances: [1000, 470, 220] }, { resistances: [1000, 470, 220] }, { resistances: [470, 220] },
  ]);
  assert.deepEqual(r.map((w) => combineWeights([w], 1)), [0x21, 0x47, 0x97]);
  assert.deepEqual(g.map((w) => combineWeights([w], 1)), [0x21, 0x47, 0x97]);
  assert.deepEqual(b.map((w) => combineWeights([w], 1)), [0x51, 0xae]);
  assert.equal(combineWeights(r, 1, 1, 1), 255);
  assert.equal(combineWeights(b, 1, 1), 255);
});

test('palette.js is the resistor math applied to prom-5.5n', () => {
  assert.deepEqual(PALETTE.map((c) => [...c]), galagaCorePalette(rom.palette));
  assert.deepEqual(STAR_PALETTE.map((c) => [...c]), galagaStarPalette());
  // PROM 0xF6 = BB GGG RRR 11 110 110 -> 0x47+0x97 on red and green, full blue.
  assert.equal(rom.palette[0], 0xf6);
  assert.deepEqual([...PALETTE[0]], [0xde, 0xde, 0xff]);
  // PROM 0x0F / 0x1F are black: the sprite and character "transparent" colours.
  assert.deepEqual([...PALETTE[0x0f]], [0, 0, 0]);
  assert.deepEqual([...PALETTE[0x1f]], [0, 0, 0]);
});

test('star palette: 1k pull-down on red/green, four levels per gun', () => {
  assert.deepEqual([...STAR_PALETTE[0]], [0, 0, 0]);
  assert.deepEqual(STAR_PALETTE.slice(0, 4).map((c) => c[0]), [0, 0x47, 0x97, 0xde]);
  assert.deepEqual(STAR_PALETTE.slice(0, 4).map((c) => c[1]), [0, 0, 0, 0]);
  assert.deepEqual([0, 16, 32, 48].map((i) => STAR_PALETTE[i][2]), [0, 0x51, 0xae, 0xff]);
});

test('colour lookup tables come from the PROMs', () => {
  for (let i = 0; i < 256; i += 1) {
    assert.equal(CHAR_LUT[i], (rom.charLut[i] & 0x0f) | 0x10);
    assert.equal(SPRITE_LUT[i], rom.spriteLut[i] & 0x0f);
  }
});

// ---------------------------------------------------------------- graphics

test('graphics: counts and pen range', () => {
  assert.equal(TILE_COUNT, 256);
  assert.equal(SPRITE_COUNT, 128);
  assert.equal(TILE_PIXELS.length, 256 * 64);
  assert.equal(SPRITE_PIXELS.length, 128 * 256);
  assert.ok(TILE_PIXELS.every((p) => p <= 3));
  assert.ok(SPRITE_PIXELS.every((p) => p <= 3));
});

test('graphics: emitted modules equal a fresh decode of the ROM', () => {
  assert.deepEqual(decodeGfx(unscrambleChars(rom.chars), CHAR_LAYOUT), TILE_PIXELS);
  assert.deepEqual(decodeGfx(rom.sprites, SPRITE_LAYOUT), SPRITE_PIXELS);
});

test('graphics: characters 0x80-0xFF are 0x00-0x7F mirrored in raster X', () => {
  // The hardware's second character set, used for flip screen. Only true
  // after init_galaga()'s half swap, so this also checks unscrambleChars.
  for (let n = 0; n < 128; n += 1) {
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        assert.equal(TILE_PIXELS[(n + 128) * 64 + y * 8 + 7 - x], TILE_PIXELS[n * 64 + y * 8 + x], `char ${n}`);
      }
    }
  }
});

test('graphics: font -- 0x24 blank, digits and letters are glyphs', () => {
  const blank = (/** @type {number} */ n) => TILE_PIXELS.subarray(n * 64, n * 64 + 64).every((p) => p === 0);
  assert.ok(blank(0x24));
  for (let n = 0; n <= 0x23; n += 1) assert.ok(!blank(n), `char ${n} should not be blank`);
  assert.equal(charCode('0'), 0);
  assert.equal(charCode('A'), 0x0a);
  assert.equal(charCode('Z'), 0x23);
  // '1' is narrower than '0': fewer lit pixels.
  const lit = (/** @type {number} */ n) => TILE_PIXELS.subarray(n * 64, n * 64 + 64).filter((p) => p).length;
  assert.ok(lit(1) < lit(0));
});

test('graphics: upright boss (0x0F) is left-right symmetric on screen', () => {
  // Player horizontal = raster Y; the ship is symmetric about raster line 7.
  const base = 0x0f * 256;
  for (let y = 0; y < 15; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      assert.equal(SPRITE_PIXELS[base + y * 16 + x], SPRITE_PIXELS[base + (14 - y) * 16 + x]);
    }
  }
});

// ---------------------------------------------------------------- starfield

test('starfield: LFSR is maximal (period 65535) and 0x7FFF is on the cycle', () => {
  let s = LFSR_SEED;
  let n = 0;
  do { s = nextLfsr(s); n += 1; } while (s !== LFSR_SEED && n <= 65536);
  assert.equal(n, 65535);
});

test('starfield: 256 hits per period, 64 per set, colours from the doc', () => {
  let s = LFSR_SEED;
  const perSet = [0, 0, 0, 0];
  let hits = 0;
  let black = 0;
  for (let i = 0; i < 65535; i += 1) {
    if ((s & LFSR_HIT_MASK) === LFSR_HIT_VALUE) {
      hits += 1;
      perSet[starSet(s)] += 1;
      if (starColor(s) === 0) black += 1;
    }
    s = nextLfsr(s);
  }
  assert.equal(hits, 256);
  assert.deepEqual(perSet, [64, 64, 64, 64]);
  // "1 star in every bank has the color 0x00" (starfield_05xx.cpp notes).
  assert.equal(black, 4);
  // colour = (!B4 !B1 !B0 !B7 !B6 !B5), where the doc's "B4" is the bit at
  // position 3 (its hit pattern reads "... B4 0 B1 B0"): with those six
  // positions set the star is black.
  assert.equal(starColor(0x7800 | 0x08 | 0x02 | 0x01 | 0x80 | 0x40 | 0x20), 0);
  assert.equal(starColor(0x7800), 0x3f);
});

test('starfield: scroll speed tables', () => {
  assert.deepEqual([...SPEED_X_CYCLE_OFFSET], [0, 1, 2, 3, -4, -3, -2, -1]);
  const sf = new Starfield();
  // Galaga: SCROLL_Y grounded, so the frame is 22 + 224 + 10 = 256 lines.
  for (let x = 0; x < 8; x += 1) {
    sf.setScrollSpeed(x, 0);
    assert.equal(sf.preVisCycleCount + 224 * 256 + sf.postVisCycleCount, 65536 + SPEED_X_CYCLE_OFFSET[x]);
  }
  assert.equal(PRE_VIS_CYCLES[0], 22 * 256);
  assert.equal(POST_VIS_CYCLES[0], 10 * 256);
});

test('starfield: _STARCLR low reseeds 0x7FFF and blanks the field', () => {
  const sf = new Starfield();
  sf.vblank([0, 0, 0, 0, 0, 1, 0, 0]);
  const raster = new Uint8Array(RASTER_WIDTH * RASTER_HEIGHT);
  sf.draw(raster, RASTER_WIDTH, RASTER_HEIGHT, 32);
  assert.notEqual(sf.lfsr, LFSR_SEED);
  sf.vblank([0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(sf.lfsr, LFSR_SEED);
  assert.equal(sf.enable, 0);
  const before = raster.slice();
  sf.draw(raster, RASTER_WIDTH, RASTER_HEIGHT, 32);
  assert.deepEqual(raster, before);
  assert.equal(sf.lfsr, LFSR_SEED);
});

test('starfield: latch wiring -- Q3 is set A, Q4|2 is set B', () => {
  const sf = new Starfield();
  sf.vblank([1, 1, 1, 1, 1, 1, 0, 0]);
  assert.equal(sf.setA, 1);
  assert.equal(sf.setB, 3);
  assert.equal(sf.preVisCycleCount, 22 * 256 - 1);
  sf.vblank([0, 0, 0, 0, 0, 1, 0, 0]);
  assert.equal(sf.setA, 0);
  assert.equal(sf.setB, 2);
});

/**
 * Run `frames` frames from the seed and return the last frame's stars.
 * @param {number} speed @param {number} frames @returns {Uint8Array}
 */
function starFrame(speed, frames) {
  const sf = new Starfield();
  const latch = [speed & 1, (speed >> 1) & 1, (speed >> 2) & 1, 0, 0, 1, 0, 0];
  let raster = new Uint8Array(0);
  for (let i = 0; i < frames; i += 1) {
    sf.vblank(latch);
    raster = new Uint8Array(RASTER_WIDTH * RASTER_HEIGHT);
    sf.draw(raster, RASTER_WIDTH, RASTER_HEIGHT, 32);
  }
  return raster;
}

test('starfield: deterministic, and speed 7 is stationary', () => {
  assert.deepEqual(starFrame(0, 3), starFrame(0, 3));
  assert.deepEqual(starFrame(7, 2), starFrame(7, 5));
  const stars = starFrame(7, 2).filter((v) => v !== 0).length;
  assert.ok(stars > 30 && stars < 128, `${stars} stars`);
});

test('starfield: speed 0 drifts one pixel per frame towards -X', () => {
  const a = starFrame(0, 2);
  const b = starFrame(0, 3);
  let compared = 0;
  for (let y = 0; y < RASTER_HEIGHT; y += 1) {
    for (let x = 16; x < 16 + 255; x += 1) {
      // Frame n+1 at x holds what frame n had at x+1 (same line).
      if (a[y * RASTER_WIDTH + x + 1] !== 0 && x + 1 < 16 + 256) {
        assert.equal(b[y * RASTER_WIDTH + x], a[y * RASTER_WIDTH + x + 1]);
        compared += 1;
      }
    }
  }
  assert.ok(compared > 30);
});

test('starfield: stars only in raster columns 16-271', () => {
  const r = starFrame(0, 1);
  for (let y = 0; y < RASTER_HEIGHT; y += 1) {
    for (let x = 0; x < RASTER_WIDTH; x += 1) {
      if (x < 16 || x >= 272) assert.equal(r[y * RASTER_WIDTH + x], 0);
    }
  }
});

// ---------------------------------------------------------------- renderer

/**
 * RGBA of the player's pixel (x, y).
 * @param {Renderer} r @param {number} x @param {number} y
 */
const px = (r, x, y) => r.pixels[y * SCREEN_WIDTH + x];
const OPAQUE_BLACK = 0xff000000;

/** @param {Renderer} r @param {number} cx @param {number} cy @returns {number} lit pixels in a cell */
function litInCell(r, cx, cy) {
  let n = 0;
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) if (px(r, cx * 8 + x, cy * 8 + y) !== OPAQUE_BLACK) n += 1;
  return n;
}

test('renderer: dimensions and a blank board renders black', () => {
  assert.equal(SCREEN_WIDTH, 224);
  assert.equal(SCREEN_HEIGHT, 288);
  const b = blankBoard();
  const r = new Renderer();
  r.render(b.video, b.ram1, b.ram2, b.ram3, b.latch);
  assert.equal(r.pixels.length, 224 * 288);
  assert.ok(r.pixels.every((p) => p === OPAQUE_BLACK));
  assert.ok(r.raster.every((p) => p === BLACK));
});

test('renderer: text lands in the right player cells, upright', () => {
  const b = blankBoard();
  putText(b.video, 9, 0, 'HIGH SCORE', 4);
  putText(b.video, 0, 35, 'CREDIT', 0);
  const r = new Renderer();
  r.render(b.video, b.ram1, b.ram2, b.ram3, b.latch);
  assert.ok(litInCell(r, 9, 0) > 0);    // H
  assert.equal(litInCell(r, 8, 0), 0);
  assert.equal(litInCell(r, 13, 0), 0); // the space
  assert.ok(litInCell(r, 0, 35) > 0);   // C
  // 'H' upright: the glyph (column 0 and row 7 of the cell are spacing)
  // has two full-height strokes and a crossbar on its 4th line.
  const rows = [];
  for (let y = 0; y < 8; y += 1) {
    let s = '';
    for (let x = 72; x < 80; x += 1) s += px(r, x, y) !== OPAQUE_BLACK ? '#' : '.';
    rows.push(s);
  }
  assert.deepEqual(rows, [
    '.##...##', '.##...##', '.##...##', '.#######', '.##...##', '.##...##', '.##...##', '........',
  ]);
});

test('renderer: characters are drawn over sprites; sprite pens 0x0F are clear', () => {
  const b = blankBoard();
  putSprite(b, 0, { code: 0x0f, color: 0, x: 100, y: 100 });
  const r = new Renderer();
  r.render(b.video, b.ram1, b.ram2, b.ram3, b.latch);
  const lit = r.pixels.filter((p) => p !== OPAQUE_BLACK).length;
  // Only the non-transparent pixels of the sprite, all inside its 16x16 box.
  const opaque = [...SPRITE_PIXELS.subarray(0x0f * 256, 0x10 * 256)]
    .filter((p) => SPRITE_LUT[p] !== 0x0f).length;
  assert.equal(lit, opaque);
  for (let y = 0; y < SCREEN_HEIGHT; y += 1) {
    for (let x = 0; x < SCREEN_WIDTH; x += 1) {
      if (px(r, x, y) !== OPAQUE_BLACK) assert.ok(x >= 100 && x < 116 && y >= 100 && y < 116);
    }
  }
  // A solid character (0x2C area has blocks; use any cell) on top wins.
  const offs = playerCellOffset(12, 12);
  b.video[offs] = 0x0a; // 'A'
  b.video[offs + 0x400] = 1;
  r.render(b.video, b.ram1, b.ram2, b.ram3, b.latch);
  const charInd = r.raster.filter((v) => v >= 0x10 && v < 0x20).length;
  assert.ok(charInd > 0);
});

test('renderer: sprite X bit 9 (ram3+1 bit 1) hides the sprite', () => {
  const b = blankBoard();
  putSprite(b, 3, { code: 0x06, color: 9, x: 50, y: 50 });
  b.ram3[0x381 + 6] |= 0x02;
  const r = new Renderer();
  r.render(b.video, b.ram1, b.ram2, b.ram3, b.latch);
  assert.ok(r.pixels.every((p) => p === OPAQUE_BLACK));
});

test('renderer: sprite position registers and flips', () => {
  const b = blankBoard();
  putSprite(b, 0, { code: 0x06, color: 9, x: 60, y: 80 });
  const r = new Renderer();
  r.render(b.video, b.ram1, b.ram2, b.ram3, b.latch);
  const plain = r.pixels.slice();
  // Raster flip Y (ram3 bit 1) is a left-right mirror for the player.
  b.ram3[0x380] |= 0x02;
  r.render(b.video, b.ram1, b.ram2, b.ram3, b.latch);
  for (let y = 80; y < 96; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      assert.equal(r.pixels[y * SCREEN_WIDTH + 60 + x], plain[y * SCREEN_WIDTH + 75 - x]);
    }
  }
  // Raster flip X (bit 0) is an upside-down mirror.
  b.ram3[0x380] = 0x01;
  r.render(b.video, b.ram1, b.ram2, b.ram3, b.latch);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 60; x < 76; x += 1) {
      assert.equal(r.pixels[(80 + y) * SCREEN_WIDTH + x], plain[(95 - y) * SCREEN_WIDTH + x]);
    }
  }
});

test('renderer: double-size sprite uses codes n..n+3 in 2x2', () => {
  const b = blankBoard();
  putSprite(b, 0, { code: 0x48, color: 5, x: 40, y: 40, sizex: 1, sizey: 1 });
  const r = new Renderer();
  r.render(b.video, b.ram1, b.ram2, b.ram3, b.latch);
  const single = new Renderer();
  // Each quarter must match that code drawn alone at the matching spot.
  // Raster quarter (qx, qy) -> gfx_offs[qy][qx]; player: qx is down, qy is left.
  const quarters = [[0, 0, 0], [1, 0, 1], [0, 1, 2], [1, 1, 3]];
  for (const [qx, qy, add] of quarters) {
    const s = blankBoard();
    const x = 40 + (1 - qy) * 16;
    const y = 40 + qx * 16;
    putSprite(s, 0, { code: 0x48 + add, color: 5, x, y });
    single.render(s.video, s.ram1, s.ram2, s.ram3, s.latch);
    for (let yy = y; yy < y + 16; yy += 1) {
      for (let xx = x; xx < x + 16; xx += 1) {
        assert.equal(r.pixels[yy * SCREEN_WIDTH + xx], single.pixels[yy * SCREEN_WIDTH + xx]);
      }
    }
  }
});

test('renderer: flip screen rotates the character layer 180 degrees', () => {
  const b = blankBoard();
  putText(b.video, 3, 5, 'GALAGA', 1);
  const r = new Renderer();
  r.render(b.video, b.ram1, b.ram2, b.ram3, b.latch);
  const normal = r.pixels.slice();
  b.latch[7] = 1;
  r.render(b.video, b.ram1, b.ram2, b.ram3, b.latch);
  assert.equal(r.flipScreen, 1);
  for (let y = 0; y < SCREEN_HEIGHT; y += 1) {
    for (let x = 0; x < SCREEN_WIDTH; x += 1) {
      assert.equal(r.pixels[y * SCREEN_WIDTH + x], normal[(SCREEN_HEIGHT - 1 - y) * SCREEN_WIDTH + SCREEN_WIDTH - 1 - x]);
    }
  }
});

test('renderer: starfield enabled by Q5 draws stars behind everything', () => {
  const b = blankBoard();
  b.latch[5] = 1;
  const r = new Renderer();
  r.render(b.video, b.ram1, b.ram2, b.ram3, b.latch);
  const stars = r.raster.filter((v) => v >= 32 && v < 96).length;
  assert.ok(stars > 30, `${stars} stars`);
  // Stars occupy player rows 16..271 only (raster X 16..271).
  for (let y = 0; y < SCREEN_HEIGHT; y += 1) {
    if (y >= 16 && y < 272) continue;
    for (let x = 0; x < SCREEN_WIDTH; x += 1) assert.equal(px(r, x, y), OPAQUE_BLACK);
  }
});

test('renderer: a full frame renders in under 8 ms', () => {
  const b = blankBoard();
  b.latch[5] = 1;
  for (let i = 0; i < 0x400; i += 1) { b.video[i] = i & 0x7f; b.video[0x400 + i] = i & 7; }
  for (let n = 0; n < 64; n += 1) putSprite(b, n, { code: n, color: n & 15, x: (n * 3) % 200, y: (n * 4) % 270 });
  const r = new Renderer();
  const start = performance.now();
  for (let i = 0; i < 60; i += 1) r.render(b.video, b.ram1, b.ram2, b.ram3, b.latch);
  const perFrame = (performance.now() - start) / 60;
  assert.ok(perFrame < 8, `${perFrame.toFixed(2)} ms per frame`);
});
