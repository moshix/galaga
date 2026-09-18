// Copyright 2026 by Moshix
/**
 * Render a synthetic test screen through src/video/renderer.js and save it as
 * assets/render-test.png, to check layout, orientation and colours by eye.
 *
 * Video RAM is filled the way the game does it -- tile codes at $8000, colour
 * codes at $8400, sprite registers in the three RAM banks -- and nothing else,
 * so what comes out is what the renderer would show for the real program.
 *
 * Galaga's font (verified on assets/tiles.png): codes 0x00-0x09 are the digits,
 * 0x0A-0x23 the letters A-Z, 0x24 a blank.
 *
 * Usage: node tools/render-sheet.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ROOT } from './romset.mjs';
import { encodePng } from './png.mjs';
import { Renderer, SCREEN_WIDTH, SCREEN_HEIGHT, playerCellOffset } from '../src/video/renderer.js';

/** Blank character. */
export const SPACE = 0x24;

/**
 * Galaga tile code of an ASCII character (digits, A-Z, space).
 * @param {string} ch @returns {number}
 */
export function charCode(ch) {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 65 + 0x0a;
  return SPACE;
}

/**
 * Write text left to right at the player's cell (x, y).
 * @param {Uint8Array} video $8000-$87FF
 * @param {number} x player column 0-27 @param {number} y player row 0-35
 * @param {string} text @param {number} color character colour code 0-63
 */
export function putText(video, x, y, text, color) {
  for (let i = 0; i < text.length; i += 1) {
    const offs = playerCellOffset(x + i, y);
    video[offs] = charCode(text[i]);
    video[offs + 0x400] = color;
  }
}

/**
 * The machine's video-side memory, blank.
 * @returns {{video: Uint8Array, ram1: Uint8Array, ram2: Uint8Array, ram3: Uint8Array, latch: Uint8Array}}
 */
export function blankBoard() {
  const video = new Uint8Array(0x800);
  video.fill(SPACE, 0, 0x400);
  const ram1 = new Uint8Array(0x400);
  const ram2 = new Uint8Array(0x400);
  const ram3 = new Uint8Array(0x400);
  // Park every sprite the way the game does: X bit 9 set, far off screen.
  for (let n = 0; n < 64; n += 1) ram3[0x381 + 2 * n] = 0x02;
  return { video, ram1, ram2, ram3, latch: new Uint8Array(8) };
}

/**
 * Program sprite register n so that a single (or double) sprite's top-left
 * corner lands at the player's pixel (x, y). Inverts draw_sprites():
 * raster sx = player y; raster top line = 223 - x - (width - 1).
 * @param {{ram1: Uint8Array, ram2: Uint8Array, ram3: Uint8Array}} b
 * @param {number} n sprite 0-63
 * @param {{code: number, color: number, x: number, y: number,
 *   flipx?: number, flipy?: number, sizex?: number, sizey?: number}} s
 */
export function putSprite(b, n, s) {
  const r = 0x380 + 2 * n;
  const sizex = s.sizex ?? 0;
  const sizey = s.sizey ?? 0;
  const sx = s.y + 40;                                   // raster X = player Y
  const top = 223 - s.x - (16 * (sizey + 1) - 1);         // raster Y of top line
  // sy = ((257 - v - 16*sizey) & 0xff) - 32  =>  v = 257 - 16*sizey - (top + 32)
  const v = (257 - 16 * sizey - (top + 32)) & 0xff;
  b.ram1[r] = s.code;
  b.ram1[r + 1] = s.color;
  b.ram2[r] = v;
  b.ram2[r + 1] = sx & 0xff;
  b.ram3[r] = (s.flipx ?? 0) | ((s.flipy ?? 0) << 1) | (sizex << 2) | (sizey << 3);
  b.ram3[r + 1] = (sx >> 8) & 1;
}

function main() {
  const b = blankBoard();
  // Top two rows ($83C0-$83FF), as in the attract screen.
  putText(b.video, 3, 0, '1UP', 4);
  putText(b.video, 9, 0, 'HIGH SCORE', 4);
  putText(b.video, 1, 1, '00', 0);
  putText(b.video, 11, 1, '20000', 0);
  // Playfield.
  putText(b.video, 11, 12, 'GALAGA', 0);
  putText(b.video, 0, 2, 'TOP LEFT', 1);
  putText(b.video, 18, 33, 'BOT RIGHT', 1);
  // Bottom two rows ($8000-$803F).
  putText(b.video, 0, 35, 'CREDIT 0', 0);
  putText(b.video, 27, 34, 'Z', 1);

  // Sprites in the player's coordinates.
  putSprite(b, 0, { code: 0x06, color: 9, x: 104, y: 256 });                  // fighter
  putSprite(b, 1, { code: 0x08, color: 0, x: 40, y: 64 });                    // boss (green)
  putSprite(b, 2, { code: 0x08, color: 2, x: 64, y: 64 });                    // boss (hit)
  putSprite(b, 3, { code: 0x10, color: 1, x: 88, y: 64 });                    // butterfly?
  putSprite(b, 4, { code: 0x18, color: 3, x: 112, y: 64 });                   // bee?
  putSprite(b, 5, { code: 0x06, color: 9, x: 140, y: 64, flipy: 1 });         // fighter, flipped
  putSprite(b, 6, { code: 0x48, color: 5, x: 150, y: 150, sizex: 1, sizey: 1 }); // double size
  putSprite(b, 7, { code: 0x06, color: 9, x: 0, y: 272 });                    // bottom-left corner
  putSprite(b, 8, { code: 0x06, color: 9, x: 208, y: 0 });                    // top-right corner

  // Stars on: _STARCLR high, speed index 0, sets 0 and 2. Run a few frames so
  // the field is past its seed state, as it would be in play.
  b.latch[5] = 1;
  const r = new Renderer();
  for (let i = 0; i < 4; i += 1) r.render(b.video, b.ram1, b.ram2, b.ram3, b.latch);

  mkdirSync(join(ROOT, 'assets'), { recursive: true });
  writeFileSync(join(ROOT, 'assets/render-test.png'), encodePng(r.pixels, SCREEN_WIDTH, SCREEN_HEIGHT, 2));
  console.log('wrote assets/render-test.png');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
