// Copyright 2026 by Moshix
/**
 * Parser for Glenn Neidermeier's reconstructed Galaga source
 * (reference/neiderm/galag/galagao_ASxxx/rom0/*.s, ASxxxx syntax).
 *
 * That source rebuilds the *galagao* set ("Galaga (Namco)", the first
 * revision). The ROM this project is proven against is the *galaga* set
 * ("Namco rev. B"), so the source cannot simply be assembled and trusted:
 * gg1_3.2m is shared between the two revisions, but the other five program
 * chips were patched. What the source gives us is names and commentary.
 *
 * This module turns the source into a flat list of items (instructions and
 * data bytes) laid out at their galagao addresses, with each item carrying a
 * *pattern* -- the instruction with every numeric or symbolic operand
 * replaced by `N` -- so that tools/gen-listing.mjs can align it against the
 * disassembly of the rev. B ROM without having to resolve a single symbol.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { disassemble } from './z80dis.mjs';
import { ROOT } from './romset.mjs';

export const SRC_DIR = join(ROOT, 'reference/neiderm/galag/galagao_ASxxx/rom0');

const REGS = new Set([
  'a', 'b', 'c', 'd', 'e', 'h', 'l', 'i', 'r', 'af', "af'", 'bc', 'de', 'hl', 'sp',
  'ix', 'iy', 'ixh', 'ixl', 'iyh', 'iyl', '(hl)', '(bc)', '(de)', '(sp)', '(c)',
  '(ix)', '(iy)', 'nz', 'z', 'nc', 'po', 'pe', 'p', 'm',
]);

/**
 * Normalise one operand to a pattern token.
 * @param {string} op operand text, already lower-cased and trimmed
 * @param {number[]} nums numeric literals are appended here when known
 * @returns {string}
 */
function normOperand(op, nums) {
  if (REGS.has(op)) return op;
  // ASxxxx indexed form: 0x13(ix)  ->  (ix+N)
  let m = op.match(/^(.*)\((ix|iy)\)$/);
  if (m && m[1] !== '') { pushNum(m[1], nums); return `(${m[2]}+N)`; }
  // Disassembler indexed form: (ix+$13) / (ix-$02)
  m = op.match(/^\((ix|iy)([+-])(.+)\)$/);
  if (m) { const v = parseNum(m[3]); if (v !== null) nums.push(m[2] === '-' ? (-v) & 0xff : v); return `(${m[1]}+N)`; }
  if (op === '(ix)' || op === '(iy)') { nums.push(0); return `${op.slice(0, 3)}+N)`; }
  m = op.match(/^\((.*)\)$/);
  if (m) { pushNum(m[1], nums); return '(N)'; }
  pushNum(op.replace(/^#/, ''), nums);
  return 'N';
}

/** @param {string} s @returns {number|null} */
function parseNum(s) {
  const t = s.trim().replace(/^#/, '');
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
  if (/^\$[0-9a-f]+$/i.test(t)) return parseInt(t.slice(1), 16);
  if (/^\$\$[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
  if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
  return null;
}

/** @param {string} s @param {number[]} nums */
function pushNum(s, nums) {
  const v = parseNum(s);
  if (v !== null) nums.push(v);
  else nums.push(NaN); // symbolic: matches anything
}

/**
 * Split an operand list on top-level commas.
 * @param {string} s
 */
function splitOperands(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

/**
 * Pattern for an instruction, from either side.
 * @param {string} text e.g. "ld   a,($9AA0)" or "ld   a,#0x10"
 * @returns {{pattern: string, nums: number[]}}
 */
export function normalise(text) {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const sp = t.indexOf(' ');
  let mn = sp < 0 ? t : t.slice(0, sp);
  const rest = sp < 0 ? '' : t.slice(sp + 1).replace(/\s+/g, '');
  const nums = [];
  if (mn === 'nop*') return { pattern: 'nop*', nums };
  let ops = rest === '' ? [] : splitOperands(rest);
  // `sub a,n` and `sub n` are the same instruction; the disassembler writes
  // the short form for sub/and/xor/or/cp and `add a,` for add/adc/sbc.
  if (['sub', 'and', 'xor', 'or', 'cp'].includes(mn) && ops.length === 2 && ops[0] === 'a') ops = ops.slice(1);
  if (mn === 'rst') {
    const v = parseNum(ops[0]);
    return { pattern: `rst ${v === null ? ops[0] : v}`, nums };
  }
  if (mn === 'im') return { pattern: `im ${ops[0]}`, nums };
  if (['bit', 'res', 'set'].includes(mn)) {
    const bit = parseNum(ops[0]);
    const tail = ops.slice(1).map((o) => normOperand(o, nums));
    return { pattern: `${mn} ${bit},${tail.join(',')}`, nums };
  }
  if (mn === 'ex' && ops[0] === 'af') ops = ['af', "af'"];
  const norm = ops.map((o) => normOperand(o, nums));
  if (mn === 'jp' && norm.length === 1 && /^\((hl|ix|iy)/.test(ops[0])) return { pattern: `jp (${ops[0].replace(/[()]/g, '')})`, nums: [] };
  return { pattern: norm.length ? `${mn} ${norm.join(',')}` : mn, nums };
}

/** Pattern -> instruction length, learned by disassembling every opcode. */
let SIZES = null;
function sizes() {
  if (SIZES !== null) return SIZES;
  SIZES = new Map();
  const buf = new Uint8Array(8);
  const read = (a) => buf[a] ?? 0;
  const learn = (bytes) => {
    buf.fill(0x12);
    buf.set(bytes);
    const ins = disassemble(read, 0);
    const { pattern } = normalise(ins.text);
    if (!SIZES.has(pattern)) SIZES.set(pattern, ins.len);
  };
  for (let a = 0; a < 256; a += 1) {
    learn([a]);
    learn([0xcb, a]);
    learn([0xed, a]);
    learn([0xdd, a]); learn([0xfd, a]);
    learn([0xdd, 0xcb, 0x05, a]); learn([0xfd, 0xcb, 0x05, a]);
  }
  return SIZES;
}

/**
 * @typedef {object} Item
 * @property {'insn'|'byte'} kind
 * @property {number} addr      galagao address
 * @property {number} size
 * @property {string} pattern   normalised instruction, or 'db'
 * @property {number[]} nums    numeric operands (NaN where symbolic)
 * @property {number} [value]   for a data byte, its value (NaN if symbolic)
 * @property {string} src       source text (without comment)
 * @property {string} comment   trailing comment
 * @property {string[]} labels  labels attached immediately before this item
 * @property {string[]} notes   block comments preceding this item
 * @property {string} file
 * @property {number} line
 */

/** Link order and placement, transcribed from rom0/makefile. */
export const LAYOUT = {
  main: [
    { file: 'int.s', base: 0x0000 },
    { file: 'task_man.s', base: 0x0096, area: 'CSEG00' },
    { file: 'game_ctrl.s', area: 'CSEG00' },
    { file: 'gg1-2.s', base: 0x1000 },
    { file: 'gg1-2_fx.s', base: 0x1700 },
    { file: 'gg1-3.s', base: 0x2000 },
    { file: 'new_stage.s', base: 0x2c00 },
    { file: 'gg1-4.s', base: 0x3000 },
  ],
  sub: [{ file: 'gg1-5.s', base: 0x0000 }],
  sound: [{ file: 'gg1-7.s', base: 0x0000 }],
};

/**
 * Parse and lay out one CPU's source files.
 * @param {'main'|'sub'|'sound'} cpu
 * @returns {{items: Item[], unknown: string[]}}
 */
export function layout(cpu) {
  const table = sizes();
  /** @type {Item[]} */
  const items = [];
  const unknown = [];
  let pc = 0;
  for (const part of LAYOUT[cpu]) {
    if (part.base !== undefined) pc = part.base;
    const lines = readFileSync(join(SRC_DIR, part.file), 'utf8').split('\n');
    let labels = [];
    let notes = [];
    lines.forEach((raw, i) => {
      const semi = findComment(raw);
      const code = (semi < 0 ? raw : raw.slice(0, semi)).trim();
      const comment = semi < 0 ? '' : raw.slice(semi + 1).trim();
      if (code === '') {
        // Keep the routine headers: ";; c_foo()" / ";;  Description:" blocks.
        if (comment !== '' && !/^[;=\-]+$/.test(comment)) notes.push(comment.replace(/^;+\s?/, ''));
        return;
      }
      let rest = code;
      // Labels: "name:" or "name::" at the start of the line.
      let m;
      while ((m = rest.match(/^([A-Za-z_.$][\w.$]*)::?\s*(.*)$/)) && !/^\./.test(m[1])) {
        labels.push(m[1]);
        rest = m[2];
      }
      if (rest === '') return;
      if (/^[A-Za-z_][\w]*\s*=/.test(rest)) return; // symbol equate
      const dir = rest.match(/^\.(\w+)\s*(.*)$/);
      const base = { src: rest, comment, file: part.file, line: i + 1 };
      if (dir) {
        const d = dir[1].toLowerCase();
        const arg = dir[2];
        if (d === 'org') { pc = parseNum(arg) ?? pc; return; }
        if (d === 'db' || d === 'byte') {
          for (const v of splitOperands(arg)) {
            const n = parseNum(v.replace(/^#/, ''));
            items.push({ ...base, labels, notes, kind: 'byte', addr: pc, size: 1, pattern: 'db', nums: [], value: n === null ? NaN : n & 0xff });
            pc += 1; labels = []; notes = [];
          }
          return;
        }
        if (d === 'dw' || d === 'word') {
          for (const v of splitOperands(arg)) {
            const n = parseNum(v.replace(/^#/, ''));
            for (const half of [0, 1]) {
              const value = n === null ? NaN : (half ? n >> 8 : n) & 0xff;
              items.push({ ...base, labels, notes, kind: 'byte', addr: pc, size: 1, pattern: 'db', nums: [], value });
              pc += 1; labels = []; notes = [];
            }
          }
          return;
        }
        if (d === 'ascii') {
          // The source spells strings in ASCII but the ROM holds tile codes,
          // so the bytes only occupy space; they never vote in the alignment.
          const s = arg.match(/^"(.*)"$/)?.[1] ?? '';
          for (const ch of s) {
            items.push({ ...base, labels, notes, kind: 'byte', addr: pc, size: 1, pattern: 'db', nums: [], value: NaN, ascii: ch });
            pc += 1; labels = []; notes = [];
          }
          return;
        }
        if (d === 'ds' || d === 'blkb') { pc += parseNum(arg) ?? 0; return; }
        return; // .module, .area, .include, .globl, .bank ...
      }
      // gg1-2.s macro: `_dea row col` emits the tile RAM address of a
      // playfield cell as a .dw. @see gg1-2.s:1257
      const dea = rest.match(/^_dea\s+(\d+)\s+(\d+)$/);
      if (dea) {
        const v = 0x8000 + 0x40 + (0x1c - Number(dea[2]) - 1) * 0x20 + Number(dea[1]);
        for (const value of [v & 0xff, v >> 8]) {
          items.push({ ...base, labels, notes, kind: 'byte', addr: pc, size: 1, pattern: 'db', nums: [], value });
          pc += 1; labels = []; notes = [];
        }
        return;
      }
      const { pattern, nums } = normalise(rest);
      const size = table.get(pattern);
      if (size === undefined) { unknown.push(`${part.file}:${i + 1}: ${rest} -> ${pattern}`); return; }
      items.push({ ...base, labels, notes, kind: 'insn', addr: pc, size, pattern, nums });
      pc += size; labels = []; notes = [];
    });
  }
  return { items, unknown };
}

/** Index of the comment ';' outside a string literal, or -1. @param {string} s */
function findComment(s) {
  let q = false;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '"') q = !q;
    if (s[i] === ';' && !q) return i;
  }
  return -1;
}
