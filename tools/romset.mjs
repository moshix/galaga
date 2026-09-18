// Copyright 2026 by Moshix
/**
 * Reader for the MAME `galaga` ROM set (Namco rev. B).
 *
 * galaga.rom at the repository root is a ZIP archive despite its extension --
 * it is the stock MAME romset. It is the only first-hand evidence of what the
 * 1981 chips held, so everything in the port that is data rather than code
 * (graphics, colour PROMs, waveform PROM, the program's own tables) is
 * extracted from here by the tools/ generators and never typed in by hand.
 *
 * The archive uses only the two methods the format has always guaranteed --
 * stored and deflate -- so node:zlib covers it and the project stays free of
 * dependencies.
 *
 * | Chip        | Size | What it is                                   |
 * |-------------|------|----------------------------------------------|
 * | gg1_1b.3p   | 4 KB | main CPU $0000-$0FFF                          |
 * | gg1_2b.3m   | 4 KB | main CPU $1000-$1FFF                          |
 * | gg1_3.2m    | 4 KB | main CPU $2000-$2FFF                          |
 * | gg1_4b.2l   | 4 KB | main CPU $3000-$3FFF                          |
 * | gg1_5b.3f   | 4 KB | sub CPU $0000-$0FFF                           |
 * | gg1_7b.2c   | 4 KB | sound CPU $0000-$0FFF                         |
 * | gg1_9.4l    | 4 KB | 8x8 characters, 2bpp                          |
 * | gg1_11.4d   | 4 KB | 16x16 sprites 0-63, 2bpp                      |
 * | gg1_10.4f   | 4 KB | 16x16 sprites 64-127, 2bpp                    |
 * | prom-5.5n   |  32  | RGB palette                                   |
 * | prom-4.2n   | 256  | character colour lookup                       |
 * | prom-3.1c   | 256  | sprite colour lookup                          |
 * | prom-1.1d   | 256  | WSG sound waveforms (8 x 32 samples, 4 bit)   |
 * | prom-2.5c   | 256  | video timing (not used by emulation)          |
 * | 51xx.bin    | 1 KB | MB8843 program of the 51XX I/O chip           |
 * | 54xx.bin    | 1 KB | MB8844 program of the 54XX noise generator    |
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ARCHIVE = join(ROOT, 'galaga.rom');

/** End-of-central-directory signature, and the central record signature. */
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

/**
 * Unpack every member of a ZIP archive.
 * @param {string} [path]
 * @returns {Map<string, Buffer>} file name -> contents
 */
export function readRomset(path = ARCHIVE) {
  const zip = readFileSync(path);
  // The end-of-central-directory record sits at the tail, after a comment of
  // unknown length (torrentzip writes one), so it is found by scanning back.
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== EOCD) eocd -= 1;
  if (eocd < 0) throw new Error('no end-of-central-directory record');

  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  /** @type {Map<string, Buffer>} */
  const out = new Map();

  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(p) !== CENTRAL) throw new Error(`bad central record ${i}`);
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const plain = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('latin1', p + 46, p + 46 + nameLen);

    // The local header repeats the name and extra fields and its extra field
    // may differ in length from the central one, so the data offset must come
    // from the local header's own counts.
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataAt, dataAt + compressed);
    const body = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    if (body.length !== plain) throw new Error(`${name}: ${body.length} bytes, expected ${plain}`);
    out.set(name, body);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** @param {Map<string, Buffer>} files @param {string[]} names @returns {Uint8Array} */
function concat(files, names) {
  return new Uint8Array(Buffer.concat(names.map((n) => {
    const b = files.get(n);
    if (!b) throw new Error(`romset is missing ${n}`);
    return b;
  })));
}

/**
 * Every chip of the set, grouped the way the board wires them.
 * @param {Map<string, Buffer>} [files]
 */
export function loadGalaga(files = readRomset()) {
  return {
    /** 16 KB, $0000-$3FFF of the main CPU. */
    main: concat(files, ['gg1_1b.3p', 'gg1_2b.3m', 'gg1_3.2m', 'gg1_4b.2l']),
    /** 4 KB, $0000-$0FFF of the sub CPU. */
    sub: concat(files, ['gg1_5b.3f']),
    /** 4 KB, $0000-$0FFF of the sound CPU. */
    sound: concat(files, ['gg1_7b.2c']),
    chars: concat(files, ['gg1_9.4l']),
    /** 8 KB: sprites 0-63 from 4D, then 64-127 from 4F. */
    sprites: concat(files, ['gg1_11.4d', 'gg1_10.4f']),
    palette: concat(files, ['prom-5.5n']),
    charLut: concat(files, ['prom-4.2n']),
    spriteLut: concat(files, ['prom-3.1c']),
    wave: concat(files, ['prom-1.1d']),
    mcu51: concat(files, ['51xx.bin']),
    mcu54: concat(files, ['54xx.bin']),
  };
}
