// Copyright 2026 by Moshix
/**
 * favicon.png: the player's fighter, straight from the sprite ROM and colour
 * PROMs (via the generated src/video tables), scaled 2x to 32x32 with a
 * transparent background. Generated, never drawn by hand:
 *
 *   node tools/gen-favicon.mjs [code] [colour]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './romset.mjs';
import { SPRITE_PIXELS } from '../src/video/sprites.js';
import { PALETTE, SPRITE_LUT, SPRITE_TRANSPARENT } from '../src/video/palette.js';
import { encodePng } from './png.mjs';

/** The upright fighter and the colour set the game draws it in. */
const [code = 6, colour = 9] = process.argv.slice(2).map(Number);
const SCALE = 2;
const px = new Uint8Array(16 * 16 * 4);
for (let y = 0; y < 16; y += 1) {
  for (let x = 0; x < 16; x += 1) {
    // Sprites are stored as the monitor scans them; the cabinet's monitor is
    // turned 90 degrees, so the player's view is a quarter turn of that.
    const pen = SPRITE_PIXELS[code * 256 + (15 - x) * 16 + y];
    const idx = SPRITE_LUT[colour * 4 + pen];
    const o = (y * 16 + x) * 4;
    if (idx === SPRITE_TRANSPARENT) continue; // alpha stays 0
    const [r, g, b] = PALETTE[idx];
    px.set([r, g, b, 255], o);
  }
}
const out = process.env.FAVICON_OUT ?? join(ROOT, 'favicon.png');
writeFileSync(out, encodePng(px, 16, 16, SCALE));
console.log(`${out}: sprite ${code}, colour ${colour}`);
