// Copyright 2026 by Moshix
/**
 * Generate the annotated listings of the rev. B ROM this project is proven
 * against:
 *
 *   reference/galaga-main.asm    main CPU,  $0000-$3FFF
 *   reference/galaga-sub.asm     sub CPU,   $0000-$0FFF
 *   reference/galaga-sound.asm   sound CPU, $0000-$0FFF
 *   reference/symbols.json       routine/label and RAM names -> rev. B address
 *
 * Every byte comes from galaga.rom. Names and comments come from Glenn
 * Neidermeier's galagao source, which is one revision older: the tool lays
 * that source out at its own addresses (tools/neiderm.mjs), then walks it
 * against the rev. B image keeping a running address *delta*. Where rev. B
 * inserted or removed bytes the delta stops matching; the walker then searches
 * nearby deltas for one under which the next several source items match again
 * and carries on. Items it cannot place are listed at the end of each file,
 * so what the revisions changed is visible rather than silently dropped.
 *
 * Nothing here is typed in by hand, so re-running it is always safe:
 *   node tools/gen-listing.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadGalaga } from './romset.mjs';
import { disassemble, hex } from './z80dis.mjs';
import { layout, normalise, SRC_DIR } from './neiderm.mjs';

/** How many consecutive items must agree before a new delta is believed. */
const RESYNC_RUN = 8;
/** Furthest a patch is assumed to have moved code, in bytes. */
const MAX_SHIFT = 0x180;

/**
 * Does source item `it` match the ROM at `addr`?
 * @param {import('./neiderm.mjs').Item} it
 * @param {Uint8Array} rom
 * @param {number} addr
 * @returns {0|1|2} 0 = no, 1 = yes but uninformative (wildcard), 2 = yes
 */
function matchAt(it, rom, addr) {
  if (addr < 0 || addr >= rom.length) return 0;
  if (it.kind === 'byte') {
    if (Number.isNaN(it.value)) return 1;
    return rom[addr] === it.value ? 2 : 0;
  }
  const d = disassemble((a) => rom[a] ?? 0xff, addr);
  const n = normalise(d.text);
  if (n.pattern !== it.pattern) return 0;
  for (let i = 0; i < it.nums.length; i += 1) {
    if (!Number.isNaN(it.nums[i]) && it.nums[i] !== n.nums[i]) return 0;
  }
  return 2;
}

/** Score a run of items under a delta: informative matches, or -1 on a miss. */
function runScore(items, from, rom, delta) {
  let score = 0;
  for (let k = from; k < Math.min(items.length, from + RESYNC_RUN); k += 1) {
    const m = matchAt(items[k], rom, items[k].addr + delta);
    if (m === 0) return -1;
    score += m === 2 ? 1 : 0;
  }
  return score;
}

/**
 * Assign every source item a rev. B address (or null).
 * @param {import('./neiderm.mjs').Item[]} items
 * @param {Uint8Array} rom
 */
function align(items, rom) {
  /** @type {(number|null)[]} */
  const placed = new Array(items.length).fill(null);
  let delta = 0;
  let lastEnd = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    // A new chip, or an .org, restarts at a known base: reset the delta when
    // the source address jumps backwards or by more than a gap.
    if (i > 0 && it.addr !== items[i - 1].addr + items[i - 1].size) {
      if ((it.addr & 0xf000) !== (items[i - 1].addr & 0xf000)) delta = 0;
    }
    if (matchAt(it, rom, it.addr + delta) !== 0 && it.addr + delta >= lastEnd) {
      placed[i] = it.addr + delta;
      lastEnd = placed[i] + it.size;
      continue;
    }
    // Lost sync: find the nearest delta under which a run matches again.
    let best = null;
    for (let s = 0; s <= MAX_SHIFT && best === null; s += 1) {
      for (const cand of s === 0 ? [delta] : [delta + s, delta - s]) {
        if (it.addr + cand < lastEnd) continue;
        if (runScore(items, i, rom, cand) >= Math.min(3, RESYNC_RUN)) { best = cand; break; }
      }
    }
    if (best !== null) {
      delta = best;
      placed[i] = it.addr + delta;
      lastEnd = placed[i] + it.size;
    }
  }
  return placed;
}

/**
 * Evaluate a `.ds` size such as `$$40 * 2` or `0x10`: ASxxxx writes hex as
 * `$$nn`. Only numbers and + - * ( ) are accepted, so nothing is executed.
 * @param {string} expr @returns {number}
 */
function evalSize(expr) {
  const js = expr.trim().replace(/\$\$([0-9a-f]+)/gi, '0x$1');
  if (!/^[0-9a-fx+\-*() ]+$/i.test(js)) throw new Error(`cannot size .ds ${expr}`);
  return Function(`return (${js});`)();
}

/**
 * RAM variable names from mrw.s: `.area RAM0/1/2` blocks of labels and .ds.
 * @returns {Map<number, {name: string, comment: string}>}
 */
function ramSymbols() {
  const bases = { RAM0: 0x8800, RAM1: 0x9000, RAM2: 0x9800 };
  const out = new Map();
  let pc = 0;
  /** @type {Map<string, number>} */
  const at = new Map();
  /** @param {string[]} names @param {string} comment */
  const record = (names, comment) => {
    const prev = out.get(pc);
    if (prev) { prev.names.push(...names); if (!prev.comment) prev.comment = comment; }
    else out.set(pc, { names: [...names], name: names[0] ?? '', comment });
  };
  for (const raw of readFileSync(join(SRC_DIR, 'mrw.s'), 'utf8').split('\n')) {
    const semi = raw.indexOf(';');
    const code = (semi < 0 ? raw : raw.slice(0, semi)).trim();
    const comment = semi < 0 ? '' : raw.slice(semi + 1).trim();
    const area = code.match(/^\.area\s+(RAM\d)/);
    if (area) { pc = bases[area[1]]; continue; }
    // `. = label` rolls the location counter back, so overlapping views of
    // the same bytes can each have their own names (mrw.s does this at $9200).
    const back = code.match(/^\.\s*=\s*(\w+)/);
    if (back) { pc = at.get(back[1]) ?? pc; continue; }
    const lab = code.match(/^([A-Za-z_][\w]*)::?\s*(.*)$/);
    let rest = code;
    if (lab) { at.set(lab[1], pc); record([lab[1]], comment); rest = lab[2]; }
    const ds = rest.match(/^\.ds\s+(.+)$/);
    if (ds) {
      if (!lab && comment) record([], comment);
      pc += evalSize(ds[1]);
    }
  }
  // Hardware registers, from sfrs.inc and the MAME driver.
  const hw = {
    0x6800: 'dsw (bit n of DSWB | DSWA<<1)', 0x6805: 'wsg voice 0 waveform',
    0x680a: 'wsg voice 1 waveform', 0x680f: 'wsg voice 2 waveform', 0x6810: 'wsg frequency/volume',
    0x6820: 'main cpu irq enable', 0x6821: 'sub cpu irq enable', 0x6822: 'sound cpu nmi enable (0=on)',
    0x6823: 'sub/sound cpu run (0=reset)', 0x6830: 'watchdog', 0x7000: '06xx data', 0x7100: '06xx control',
    0xa000: 'starfield scroll x0', 0xa001: 'starfield scroll x1', 0xa002: 'starfield scroll x2',
    0xa003: 'starfield set sf0', 0xa004: 'starfield set sf1', 0xa005: 'starfield enable (_STARCLR)',
    0xa007: 'flip screen',
  };
  for (const [a, c] of Object.entries(hw)) if (!out.has(Number(a))) out.set(Number(a), { names: [], name: '', comment: c });
  return out;
}

/**
 * Mark every byte that executes as code: all source instructions that were
 * placed, plus whatever they flow or jump into. The second part is what finds
 * rev. B's patched code, which the older source knows nothing about.
 * @param {import('./neiderm.mjs').Item[]} items
 * @param {(number|null)[]} placed
 * @param {Uint8Array} rom
 * @returns {Uint8Array} 1 where the byte is part of an instruction
 */
function traceCode(items, placed, rom) {
  const code = new Uint8Array(rom.length);
  const isData = new Uint8Array(rom.length);
  items.forEach((it, i) => { if (placed[i] !== null && it.kind === 'byte') isData[placed[i]] = 1; });
  const work = [];
  items.forEach((it, i) => { if (placed[i] !== null && it.kind === 'insn') work.push(placed[i]); });
  const seen = new Uint8Array(rom.length);
  while (work.length) {
    let a = work.pop();
    while (a < rom.length && !seen[a] && !isData[a]) {
      seen[a] = 1;
      const d = disassemble((x) => rom[x] ?? 0xff, a);
      for (let k = 0; k < d.len && a + k < rom.length; k += 1) code[a + k] = 1;
      if (d.target !== null && d.target < rom.length) work.push(d.target);
      const stops = (d.flow === 'ret' || d.flow === 'jp' || d.flow === 'jr' || d.flow === 'jpind' || d.flow === 'halt' || d.flow === 'rst') && !d.cond;
      // rst $38 is the only unconditional flow that returns here in general;
      // but a run of $FF fill is not code, so treat rst as a stop.
      if (stops) break;
      a += d.len;
    }
  }
  return code;
}

/** @param {number[]} bytes */
const hexBytes = (bytes) => bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/**
 * @param {'main'|'sub'|'sound'} cpu
 * @param {Uint8Array} rom
 * @param {Map<number, {name: string, comment: string}>} ram
 * @param {Record<string, any>} symbols
 */
function generate(cpu, rom, ram, symbols) {
  const { items } = layout(cpu);
  const placed = align(items, rom);

  const code = traceCode(items, placed, rom);

  /** rev B address -> item index */
  const at = new Map();
  items.forEach((it, i) => { if (placed[i] !== null) at.set(placed[i], i); });
  const lost = items.filter((_, i) => placed[i] === null);

  // Label addresses, so a jump target in the disassembly can be named.
  /** @type {Map<number, string>} */
  const names = new Map();
  items.forEach((it, i) => {
    if (placed[i] === null) return;
    for (const l of it.labels) {
      if (!names.has(placed[i])) names.set(placed[i], l);
      symbols[cpu][l] = { rev_b: placed[i], galagao: it.addr, file: `${it.file}:${it.line}` };
    }
  });

  const lines = [];
  const title = { main: 'MAIN CPU (gg1_1b.3p gg1_2b.3m gg1_3.2m gg1_4b.2l)', sub: 'SUB CPU (gg1_5b.3f)', sound: 'SOUND CPU (gg1_7b.2c)' }[cpu];
  lines.push(`; Galaga (Namco rev. B) -- ${title}`);
  lines.push('; GENERATED by tools/gen-listing.mjs from galaga.rom. Do not edit.');
  lines.push('; Names and comments: G. Neidermeier galagao source (reference/neiderm), aligned');
  lines.push('; against rev. B. "[rev B]" marks bytes with no counterpart in that source.');
  lines.push(`; ${items.length - lost.length}/${items.length} source items placed.`);
  lines.push('');

  let a = 0;
  while (a < rom.length) {
    const idx = at.get(a);
    const it = idx === undefined ? null : items[idx];
    if (it) {
      if (it.notes.length) {
        lines.push('');
        for (const n of it.notes) lines.push(';; ' + n);
      }
      for (const l of it.labels) {
        const moved = it.addr !== a ? `   ; galagao ${hex(it.addr, 4)}` : '';
        lines.push(`${l}:${moved}`);
      }
    }
    // Data: run the consecutive data items together, 8 bytes to a line.
    if (it && it.kind === 'byte') {
      const bytes = [];
      let text = '';
      let b = a;
      let comment = it.comment;
      while (bytes.length < 8) {
        const j = at.get(b);
        if (j === undefined || items[j].kind !== 'byte') break;
        if (b !== a && (items[j].labels.length || items[j].notes.length || items[j].line !== it.line)) break;
        bytes.push(rom[b]);
        if (items[j].ascii !== undefined) text += items[j].ascii;
        b += 1;
      }
      if (text) comment = `"${text}"${comment ? ' ' + comment : ''}`;
      lines.push(`${hex(a, 4).slice(1)}: ${hexBytes(bytes).padEnd(24)}.db   ${bytes.map((x) => hex(x)).join(',')}${comment ? '  ; ' + comment : ''}`);
      a = b;
      continue;
    }
    if (!it && !code[a]) {
      // Bytes no source item claims and no traced path executes: data (or
      // fill) that rev. B added or moved. Group like any other .db run.
      const bytes = [];
      let b = a;
      while (bytes.length < 8 && b < rom.length && !at.has(b) && !code[b]) { bytes.push(rom[b]); b += 1; }
      lines.push(`${hex(a, 4).slice(1)}: ${hexBytes(bytes).padEnd(24)}.db   ${bytes.map((x) => hex(x)).join(',')}  ; [rev B]`);
      a = b;
      continue;
    }
    const d = disassemble((x) => rom[x] ?? 0xff, a);
    let note = '';
    if (it) {
      note = it.comment;
      if (normalise(it.src).pattern !== undefined && it.src.replace(/\s+/g, ' ') !== d.text.replace(/\s+/g, ' ')) {
        // Show the symbolic form from the source: it usually names the operand.
        const sym = it.src.replace(/\s+/g, ' ');
        if (/[a-z_]{3,}/i.test(sym.replace(/^\w+\s/, '').replace(/\b(ix|iy|hl|de|bc|af|sp|nz|nc|pe|po)\b/g, ''))) note = `{${sym}}` + (note ? ' ' + note : '');
      }
    } else {
      note = '[rev B]';
    }
    if (d.target !== null && names.has(d.target) && d.flow !== 'rst') note = `-> ${names.get(d.target)}` + (note ? '  ' + note : '');
    if (d.ref !== null && ram.has(d.ref) && !/\{/.test(note)) {
      const r = ram.get(d.ref);
      note = `[${r.name || hex(d.ref, 4)}${r.comment ? ': ' + r.comment : ''}]` + (note ? ' ' + note : '');
    }
    lines.push(`${hex(a, 4).slice(1)}: ${hexBytes(d.bytes).padEnd(24)}${d.text.padEnd(22)}${note ? '; ' + note : ''}`);
    a += d.len;
  }

  if (lost.length) {
    lines.push('');
    lines.push(';; ===========================================================================');
    lines.push(`;; ${lost.length} galagao source items with no place in rev. B:`);
    for (const it of lost) lines.push(`;;   ${hex(it.addr, 4)} ${it.file}:${it.line}  ${it.src}${it.labels.length ? '   <' + it.labels.join(',') + '>' : ''}`);
  }
  return { text: lines.join('\n') + '\n', placed: items.length - lost.length, total: items.length, code };
}

/**
 * Emit src/game/romdata.js: every byte of the three program ROMs that is NOT
 * code, at its original address. Game state in RAM holds pointers into these
 * tables (a flight path pointer is a ROM address), so byte-exact RAM demands
 * the port read its data at the same addresses the Z80 did. Code bytes are
 * left out, and reading one throws: that is always a porting mistake.
 * @param {Record<string, Uint8Array>} rom
 * @param {Record<string, Uint8Array>} masks
 */
function writeRomData(rom, masks) {
  const parts = [];
  /**
   * Code bytes the game also reads as data. The random number generator at
   * main $1000 indexes $0100-$01FF (the task manager's own code) as a table
   * of noise: `ld h,$01 / ld a,(hl)`. c_08AD/c_08BE ($08AD, $08BE) index
   * their bomber-timer tables without a bounds check and walk into
   * $0935-$0B0E -- in normal play (stage parameter 2 with 40 enemies reads
   * $0935) and for ~380 frames after power-on on RAM-test leftovers. On the
   * wrapped-around stage 0 (after stage 255) the wave builder c_25A2 indexes
   * its tables with $FF and reads $2896-$2ACD as wave data.
   */
  const READ_AS_DATA = {
    main: [[0x0100, 0x0200], [0x0935, 0x0b0f], [0x2896, 0x2ace]], sub: [], sound: [],
  };
  for (const cpu of ['main', 'sub', 'sound']) {
    const data = Uint8Array.from(rom[cpu]);
    for (const [lo, hi] of READ_AS_DATA[cpu]) masks[cpu].fill(0, lo, hi);
    const bits = new Uint8Array(Math.ceil(data.length / 8));
    for (let a = 0; a < data.length; a += 1) {
      if (masks[cpu][a]) data[a] = 0;
      else bits[a >> 3] |= 1 << (a & 7);
    }
    parts.push(`  ${cpu}: ['${Buffer.from(data).toString('base64')}', '${Buffer.from(bits).toString('base64')}'],`);
  }
  const src = `// Copyright 2026 by Moshix
// GENERATED by tools/gen-listing.mjs from galaga.rom -- do not edit.
/**
 * The data (non-code) bytes of the three program ROMs, at their original
 * addresses. Game state holds ROM addresses (flight paths, strings, tables),
 * so the port reads data exactly where the Z80 did. Code bytes are absent and
 * reading one throws, because that can only be a porting mistake.
 */

/** @param {string} b64 @returns {Uint8Array} */
function decode(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const RAW = {
${parts.join('\n')}
};

/** @typedef {'main'|'sub'|'sound'} Cpu */

/** @param {string[]} pair base64 data and base64 data-byte bitmap */
const unpack = ([d, m]) => ({ data: decode(d), mask: decode(m) });

/** @type {Record<Cpu, {data: Uint8Array, mask: Uint8Array}>} */
const ROMS = { main: unpack(RAW.main), sub: unpack(RAW.sub), sound: unpack(RAW.sound) };

/**
 * Read one data byte of a CPU's ROM.
 * @param {Cpu} cpu
 * @param {number} addr
 * @returns {number}
 */
export function romByte(cpu, addr) {
  const r = ROMS[cpu];
  const a = addr & 0xffff;
  if (a >= r.data.length) return 0;
  if (!((r.mask[a >> 3] >> (a & 7)) & 1)) throw new Error(\`\${cpu} ROM $\${a.toString(16)} is code, not data\`);
  return r.data[a];
}

/** Little-endian word from ROM data. @param {Cpu} cpu @param {number} addr */
export function romWord(cpu, addr) {
  return romByte(cpu, addr) | (romByte(cpu, addr + 1) << 8);
}

/** Main CPU data byte. @param {number} addr */
export const mainRom = (addr) => romByte('main', addr);
/** Sub CPU data byte. @param {number} addr */
export const subRom = (addr) => romByte('sub', addr);
/** Sound CPU data byte. @param {number} addr */
export const soundRom = (addr) => romByte('sound', addr);
`;
  writeFileSync(join(ROOT, 'src', 'game', 'romdata.js'), src);
}

function main() {
  const rom = loadGalaga();
  const ram = ramSymbols();
  const symbols = { main: {}, sub: {}, sound: {}, ram: {} };
  const codeMasks = {};
  for (const [a, r] of ram) for (const n of r.names) symbols.ram[n] = { addr: a, comment: r.comment };
  for (const cpu of /** @type {const} */ (['main', 'sub', 'sound'])) {
    const out = generate(cpu, rom[cpu], ram, symbols);
    writeFileSync(join(ROOT, 'reference', `galaga-${cpu}.asm`), out.text);
    codeMasks[cpu] = out.code;
    console.log(`${cpu.padEnd(6)} ${out.placed}/${out.total} source items placed`);
  }
  writeFileSync(join(ROOT, 'reference', 'symbols.json'), JSON.stringify(symbols, null, 1) + '\n');
  writeRomData(rom, codeMasks);
}

main();
