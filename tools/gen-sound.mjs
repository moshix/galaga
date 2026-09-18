// Copyright 2026 by Moshix
/**
 * Emit the sound data modules from the Galaga ROM set. Nothing is
 * transcribed by hand.
 *
 * src/audio/waveforms.js: the eight 32-step
 * 4-bit waveforms of the Namco WSG, read from prom-1.1d exactly as MAME's
 * namco_audio_device::waveform_r does (low nibble of each PROM byte,
 * waveform n at bytes n*32 .. n*32+31).
 *
 * src/audio/mcu54rom.js: 54xx.bin, the MB8844 program of the 54XX noise
 * chip, for src/machine/namco54.js in the browser (base64).
 *
 * Usage: node tools/gen-sound.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGalaga, ROOT } from './romset.mjs';

const WAVES = 8;
const STEPS = 32;

/**
 * Render the module text.
 * @param {Uint8Array} prom prom-1.1d (256 bytes)
 * @returns {string}
 */
export function renderWaveforms(prom) {
  if (prom.length < WAVES * STEPS) throw new Error('prom-1.1d too short');
  const rows = [];
  for (let w = 0; w < WAVES; w += 1) {
    const vals = [];
    for (let i = 0; i < STEPS; i += 1) vals.push(prom[w * STEPS + i] & 0x0f);
    const fmt = (a) => a.map((v) => v.toString().padStart(2)).join(',');
    rows.push(`  // waveform ${w}`);
    rows.push(`  ${fmt(vals.slice(0, 16))},`);
    rows.push(`  ${fmt(vals.slice(16))},`);
  }
  return `// Copyright 2026 by Moshix
/**
 * GENERATED FILE -- do not edit by hand.
 * Run \`node tools/gen-sound.mjs\` to regenerate.
 *
 * The Namco WSG's eight waveforms, from the Galaga sound PROM prom-1.1d:
 * 32 steps each, 4-bit unsigned (0-15; the chip plays them as value - 8).
 * Waveform n occupies entries n*32 .. n*32+31, the same addressing MAME
 * uses ((select << 5) + position).
 */

/** Number of waveforms and steps per waveform. */
export const WAVE_COUNT = ${WAVES};
export const WAVE_STEPS = ${STEPS};

/** @type {Uint8Array} 256 entries, low nibble of each PROM byte. */
export const WAVEFORMS = Uint8Array.from([
${rows.join('\n')}
]);
`;
}

/**
 * Render the 54XX program module.
 * @param {Uint8Array} rom 54xx.bin (1 KB)
 * @returns {string}
 */
export function renderMcu54(rom) {
  if (rom.length !== 1024) throw new Error(`54xx.bin is ${rom.length} bytes, expected 1024`);
  const b64 = Buffer.from(rom).toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(`'${b64.slice(i, i + 76)}'`);
  return `// Copyright 2026 by Moshix
/**
 * GENERATED FILE -- do not edit by hand.
 * Run \`node tools/gen-sound.mjs\` to regenerate.
 *
 * 54xx.bin from the Galaga ROM set: the MB8844 program of the Namco 54XX
 * explosion/noise chip, run by src/machine/namco54.js. Namco's code.
 */

const B64 =
  ${lines.join('\n  + ')};

/** @param {string} s @returns {Uint8Array} */
function decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** The 1 KB 54XX program. @type {Uint8Array} */
export const MCU54_ROM = decode(B64);
`;
}

/** Write src/audio/waveforms.js and src/audio/mcu54rom.js. */
function main() {
  const { wave, mcu54 } = loadGalaga();
  const dir = join(ROOT, 'src/audio');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of [['waveforms.js', renderWaveforms(wave)], ['mcu54rom.js', renderMcu54(mcu54)]]) {
    const out = join(dir, name);
    writeFileSync(out, text);
    console.log(`wrote ${out}`);
  }
}

// Run only as a script, so tests can import renderWaveforms.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
