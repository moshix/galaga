// Copyright 2026 by Moshix
/**
 * Disassembler for the Fujitsu MB88xx 4-bit MCUs (the Namco 51XX/54XX).
 *
 * Mnemonics follow the comments in MAME's mb88xx.cpp execute_run(), so a
 * listing can be read line by line against test/mcu/mb88.mjs. MAME's own
 * mb88dasm.cpp is not in reference/, but every opcode's meaning is spelled
 * out in the core itself.
 *
 * Addresses are printed as the linear 10-bit program address ($000-$3FF),
 * which is (PA << 6) | PC. The MB88 program counter is split into a 6-bit PC
 * and a page register PA; an in-page `jmp` (opcodes $C0-$FF) keeps PA from
 * *after* the fetch, so a jmp sitting in the last byte of a page lands in the
 * next page -- the disassembler reproduces that.
 *
 * Usage:  node tools/mb88dis.mjs [51|54]     (defaults to 51)
 */
import { fileURLToPath } from 'node:url';

/** @param {number} v @param {number} [w] */
const hex = (v, w = 2) => '$' + v.toString(16).toUpperCase().padStart(w, '0');

/** One-byte opcodes $00-$3C with no operand field. @see mb88xx.cpp execute_run */
const SIMPLE = [
  'nop', 'outO', 'outP', 'outR', 'tay', 'tath', 'tatl', 'tas',
  'icy', 'icm', 'stic', 'x', 'rol', 'l', 'adc', 'and',
  'daa', 'das', 'inK', 'inR', 'tya', 'ttha', 'ttla', 'tsa',
  'dcy', 'dcm', 'stdc', 'xx', 'ror', 'st', 'sbc', 'or',
  'setR', 'setc', 'rstR', 'rstc', 'tstR', 'tsti', 'tstv', 'tsts',
  'tstc', 'tstz', 'sts', 'ls', 'rts', 'neg', 'c', 'eor',
];

/**
 * @typedef {object} Mb88Instr
 * @property {number} addr     linear program address
 * @property {number} len      1 or 2 bytes
 * @property {number[]} bytes
 * @property {string} text     e.g. "call $1A3"
 * @property {number|null} target  branch destination (linear), or null
 */

/**
 * Disassemble one instruction.
 * @param {Uint8Array} rom  program image (1 KB for MB8843/44)
 * @param {number} addr     linear address
 * @returns {Mb88Instr}
 */
export function disassembleOne(rom, addr) {
  const mask = rom.length - 1;
  const op = rom[addr & mask];
  // The byte after the opcode, as INCPC would reach it (same linear order).
  const arg = rom[(addr + 1) & mask];
  /** @type {Mb88Instr} */
  const ins = { addr, len: 1, bytes: [op], text: '', target: null };
  const two = () => { ins.len = 2; ins.bytes.push(arg); };

  if (op < 0x30) ins.text = SIMPLE[op];
  else if (op < 0x34) ins.text = `sbit ${op & 3}`;
  else if (op < 0x38) ins.text = `rbit ${op & 3}`;
  else if (op < 0x3c) ins.text = `tbit ${op & 3}`;
  else if (op === 0x3c) ins.text = 'rti';
  else if (op === 0x3d) {
    // jpa reads its page operand without INCPC, but the byte still belongs
    // to the instruction (PC is overwritten anyway).
    two();
    ins.text = `jpa  ${hex(arg & 0x1f)}     ; PA=${hex(arg & 0x1f)}, PC=A*4`;
  } else if (op === 0x3e) { two(); ins.text = `en   ${hex(arg)}`; }
  else if (op === 0x3f) { two(); ins.text = `dis  ${hex(arg)}`; }
  else if (op < 0x44) ins.text = `setD ${op & 3}`;
  else if (op < 0x48) ins.text = `rstD ${op & 3}`;
  else if (op < 0x4c) ins.text = `tstD ${op & 3}`;
  else if (op < 0x50) ins.text = `tba  ${op & 3}`;
  else if (op < 0x54) ins.text = `xd   ${op & 3}`;
  else if (op < 0x58) ins.text = `xyd  ${(op & 3) + 4}`;
  else if (op < 0x60) ins.text = `lxi  ${op & 7}`;
  else if (op < 0x70) {
    two();
    // Target = page ((op & 7) << 2 | arg >> 6), offset arg & 0x3f, which
    // collapses to the 11-bit value ((op & 7) << 8) | arg.
    ins.target = ((op & 7) << 8) | arg;
    ins.text = `${op < 0x68 ? 'call' : 'jpl '} ${hex(ins.target, 3)}`;
  } else if (op < 0x80) ins.text = `ai   ${hex(op & 0x0f, 1)}`;
  else if (op < 0x90) ins.text = `lyi  ${hex(op & 0x0f, 1)}`;
  else if (op < 0xa0) ins.text = `li   ${hex(op & 0x0f, 1)}`;
  else if (op < 0xb0) ins.text = `cyi  ${hex(op & 0x0f, 1)}`;
  else if (op < 0xc0) ins.text = `ci   ${hex(op & 0x0f, 1)}`;
  else {
    const next = addr + 1; // PA as it stands after INCPC
    ins.target = (next & ~0x3f) | (op & 0x3f);
    ins.text = `jmp  ${hex(ins.target & mask, 3)}`;
  }
  return ins;
}

/**
 * Disassemble a whole program image linearly.
 * @param {Uint8Array} rom
 * @returns {string} listing, one instruction per line
 */
export function disassemble(rom) {
  const lines = [];
  for (let a = 0; a < rom.length;) {
    // Mark page starts: in-page jumps cannot leave them, so they are the
    // natural "function" boundaries of an MB88 program.
    if ((a & 0x3f) === 0) lines.push(`; ---- page ${hex(a >> 6)} ----`);
    // Collapse runs of 4+ nops (unused ROM and jump-table padding) that
    // stay inside the page, so the listing shows only code.
    let run = 0;
    while (a + run < rom.length && rom[a + run] === 0 && ((a + run) & 0x3f || run === 0)) run += 1;
    if (run >= 4) {
      lines.push(`${a.toString(16).toUpperCase().padStart(3, '0')}: 00 ...  nop  x${run}`);
      a += run;
      continue;
    }
    const ins = disassembleOne(rom, a);
    const bytes = ins.bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    lines.push(`${a.toString(16).toUpperCase().padStart(3, '0')}: ${bytes.padEnd(6)} ${ins.text}`);
    a += ins.len;
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { loadGalaga } = await import('./romset.mjs');
  const roms = loadGalaga();
  const which = process.argv[2] === '54' ? roms.mcu54 : roms.mcu51;
  process.stdout.write(disassemble(which) + '\n');
}
