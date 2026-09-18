// Copyright 2026 by Moshix
/**
 * Minimal PNG encoder, built on node:zlib so the project keeps its zero
 * dependency rule. Enough for screenshots and sprite sheets: 8-bit RGBA,
 * non-interlaced.
 */

import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Uint8Array} bytes @returns {number} */
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Uint8Array} data @returns {Buffer} */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 8), Buffer.from(data), tail]);
}

/**
 * Encode packed RGBA pixels as a PNG.
 * @param {Uint32Array|Uint8Array} pixels RGBA, row-major
 * @param {number} width
 * @param {number} height
 * @param {number} [scale] integer pixel magnification
 * @returns {Buffer}
 */
export function encodePng(pixels, width, height, scale = 1) {
  const src = pixels instanceof Uint32Array
    ? new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)
    : pixels;
  const outW = width * scale;
  const outH = height * scale;
  // Each scanline is prefixed with a filter byte; 0 means "no filter".
  const raw = Buffer.alloc(outH * (outW * 4 + 1));
  let p = 0;
  for (let y = 0; y < outH; y += 1) {
    raw[p] = 0;
    p += 1;
    const srcRow = Math.floor(y / scale) * width;
    for (let x = 0; x < outW; x += 1) {
      const s = (srcRow + Math.floor(x / scale)) * 4;
      raw[p] = src[s];
      raw[p + 1] = src[s + 1];
      raw[p + 2] = src[s + 2];
      raw[p + 3] = src[s + 3];
      p += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(outW, 0);
  ihdr.writeUInt32BE(outH, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type 6 = RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // non-interlaced

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
