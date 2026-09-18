// Copyright 2026 by Moshix
/**
 * A small, table-free Z80 disassembler.
 *
 * Decodes by the x/y/z/p/q field method (see "Decoding Z80 Opcodes",
 * z80.info), which covers every documented opcode and the undocumented
 * IXH/IXL/IYH/IYL forms in a few dozen lines rather than a 1,500 entry table.
 * It is only ever used by the listing and table generators in tools/, so it
 * favours being obviously correct over being fast.
 *
 * Output syntax is Zilog with lower-case mnemonics and `$` hex, e.g.
 *   ld   a,($9AA0)
 */

const R = ['b', 'c', 'd', 'e', 'h', 'l', '(hl)', 'a'];
const RP = ['bc', 'de', 'hl', 'sp'];
const RP2 = ['bc', 'de', 'hl', 'af'];
const CC = ['nz', 'z', 'nc', 'c', 'po', 'pe', 'p', 'm'];
const ALU = ['add  a,', 'adc  a,', 'sub  ', 'sbc  a,', 'and  ', 'xor  ', 'or   ', 'cp   '];
const ROT = ['rlc', 'rrc', 'rl', 'rr', 'sla', 'sra', 'sll', 'srl'];
const X0Z7 = ['rlca', 'rrca', 'rla', 'rra', 'daa', 'cpl', 'scf', 'ccf'];
const IM = ['0', '0/1', '1', '2', '0', '0/1', '1', '2'];
const BLI = [
  ['ldi', 'cpi', 'ini', 'outi'], ['ldd', 'cpd', 'ind', 'outd'],
  ['ldir', 'cpir', 'inir', 'otir'], ['lddr', 'cpdr', 'indr', 'otdr'],
];

/** @param {number} v @param {number} [w] */
const hex = (v, w = 2) => '$' + v.toString(16).toUpperCase().padStart(w, '0');

/** @param {string} m @param {string} [ops] */
const fmt = (m, ops) => (ops === undefined ? m : m.padEnd(5) + ops);

/**
 * @typedef {object} Instr
 * @property {number} addr
 * @property {number} len      bytes consumed
 * @property {string} text     e.g. "ld   a,($9AA0)"
 * @property {number[]} bytes
 * @property {number|null} target  jump/call destination, or null
 * @property {'jp'|'jr'|'call'|'rst'|'ret'|'jpind'|'halt'|null} flow
 * @property {boolean} cond    flow is conditional
 * @property {number|null} ref  absolute memory operand, e.g. ($9AA0) or ld hl,$1234
 */

/**
 * Disassemble one instruction.
 * @param {(addr: number) => number} read byte reader
 * @param {number} addr
 * @returns {Instr}
 */
export function disassemble(read, addr) {
  let pc = addr;
  const next = () => { const v = read(pc & 0xffff) & 0xff; pc += 1; return v; };
  const next16 = () => { const lo = next(); return lo | (next() << 8); };
  /** @type {Instr} */
  const out = { addr, len: 0, text: '', bytes: [], target: null, flow: null, cond: false, ref: null };

  let op = next();
  /** '' | 'ix' | 'iy' */
  let idx = '';
  if (op === 0xdd || op === 0xfd) {
    idx = op === 0xdd ? 'ix' : 'iy';
    op = next();
    // A second prefix (or ED) cancels the first; treat the lone prefix as a nop.
    if (op === 0xdd || op === 0xfd || op === 0xed) {
      pc -= 1;
      out.text = fmt('nop*');
      return finish(out, pc, read);
    }
  }

  let disp = 0;
  /** Register name with index substitution. `(hl)` becomes `(ix+d)`. */
  const reg = (i, allowHalf = true) => {
    if (!idx) return R[i];
    if (i === 6) return `(${idx}${disp < 0 ? '-' : '+'}${hex(Math.abs(disp))})`;
    if (allowHalf && i === 4) return idx + 'h';
    if (allowHalf && i === 5) return idx + 'l';
    return R[i];
  };
  const rp = (i) => (i === 2 && idx ? idx : RP[i]);
  const rp2 = (i) => (i === 2 && idx ? idx : RP2[i]);
  const readDisp = () => { const d = next(); disp = d < 0x80 ? d : d - 256; };

  if (op === 0xcb) {
    if (idx) readDisp();
    const cb = next();
    const x = cb >> 6, y = (cb >> 3) & 7, z = cb & 7;
    // With an index prefix the operand is always (ix+d); a z != 6 form also
    // copies the result into a register (undocumented).
    const target = idx ? reg(6) : R[z];
    const extra = idx && z !== 6 ? ',' + R[z] : '';
    if (x === 0) out.text = fmt(ROT[y], target + extra);
    else if (x === 1) out.text = fmt('bit', `${y},${target}`);
    else if (x === 2) out.text = fmt('res', `${y},${target}${extra}`);
    else out.text = fmt('set', `${y},${target}${extra}`);
    return finish(out, pc, read);
  }

  if (op === 0xed) {
    const e = next();
    const x = e >> 6, y = (e >> 3) & 7, z = e & 7, p = y >> 1, q = y & 1;
    if (x === 1) {
      if (z === 0) out.text = fmt('in', `${y === 6 ? '(c)' : R[y]},(c)`);
      else if (z === 1) out.text = fmt('out', `(c),${y === 6 ? '0' : R[y]}`);
      else if (z === 2) out.text = fmt(q ? 'adc' : 'sbc', `hl,${RP[p]}`);
      else if (z === 3) {
        const nn = next16();
        out.ref = nn;
        out.text = q ? fmt('ld', `${RP[p]},(${hex(nn, 4)})`) : fmt('ld', `(${hex(nn, 4)}),${RP[p]}`);
      } else if (z === 4) out.text = fmt('neg');
      else if (z === 5) { out.text = fmt(y === 1 ? 'reti' : 'retn'); out.flow = 'ret'; }
      else if (z === 6) out.text = fmt('im', IM[y]);
      else out.text = fmt(['ld   i,a', 'ld   r,a', 'ld   a,i', 'ld   a,r', 'rrd', 'rld', 'nop*', 'nop*'][y]);
    } else if (x === 2 && z <= 3 && y >= 4) {
      out.text = fmt(BLI[y - 4][z]);
    } else {
      out.text = fmt('nop*');
    }
    return finish(out, pc, read);
  }

  const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1, q = y & 1;

  if (x === 0) {
    switch (z) {
      case 0:
        if (y === 0) out.text = 'nop';
        else if (y === 1) out.text = fmt('ex', "af,af'");
        else {
          const d = next();
          const t = (pc + (d < 0x80 ? d : d - 256)) & 0xffff;
          out.target = t; out.flow = 'jr'; out.cond = y >= 4;
          if (y === 2) out.text = fmt('djnz', hex(t, 4));
          else if (y === 3) out.text = fmt('jr', hex(t, 4));
          else out.text = fmt('jr', `${CC[y - 4]},${hex(t, 4)}`);
          if (y === 2) out.cond = true;
        }
        break;
      case 1:
        if (q === 0) { const nn = next16(); out.ref = nn; out.text = fmt('ld', `${rp(p)},${hex(nn, 4)}`); }
        else out.text = fmt('add', `${rp(2)},${rp(p)}`);
        break;
      case 2: {
        const forms = ['(bc),a', 'a,(bc)', '(de),a', 'a,(de)'];
        if (p < 2) out.text = fmt('ld', forms[p * 2 + q]);
        else {
          const nn = next16(); out.ref = nn;
          const m = `(${hex(nn, 4)})`;
          if (p === 2) out.text = fmt('ld', q ? `${rp(2)},${m}` : `${m},${rp(2)}`);
          else out.text = fmt('ld', q ? `a,${m}` : `${m},a`);
        }
        break;
      }
      case 3: out.text = fmt(q ? 'dec' : 'inc', rp(p)); break;
      case 4: if (y === 6 && idx) readDisp(); out.text = fmt('inc', reg(y)); break;
      case 5: if (y === 6 && idx) readDisp(); out.text = fmt('dec', reg(y)); break;
      case 6: {
        if (y === 6 && idx) readDisp();
        const n = next();
        out.text = fmt('ld', `${reg(y)},${hex(n)}`);
        break;
      }
      default: out.text = X0Z7[y];
    }
    return finish(out, pc, read);
  }

  if (x === 1) {
    if (z === 6 && y === 6) { out.text = 'halt'; out.flow = 'halt'; return finish(out, pc, read); }
    // ld r,(ix+d) / ld (ix+d),r: the other operand is never IXH/IXL.
    if (idx && (y === 6 || z === 6)) readDisp();
    const mem = y === 6 || z === 6;
    out.text = fmt('ld', `${reg(y, !mem)},${reg(z, !mem)}`);
    return finish(out, pc, read);
  }

  if (x === 2) {
    if (z === 6 && idx) readDisp();
    out.text = ALU[y] + reg(z);
    return finish(out, pc, read);
  }

  // x === 3
  switch (z) {
    case 0: out.text = fmt('ret', CC[y]); out.flow = 'ret'; out.cond = true; break;
    case 1:
      if (q === 0) out.text = fmt('pop', rp2(p));
      else if (p === 0) { out.text = 'ret'; out.flow = 'ret'; }
      else if (p === 1) out.text = 'exx';
      else if (p === 2) { out.text = fmt('jp', `(${rp(2)})`); out.flow = 'jpind'; }
      else out.text = fmt('ld', `sp,${rp(2)}`);
      break;
    case 2: {
      const nn = next16();
      out.target = nn; out.flow = 'jp'; out.cond = true;
      out.text = fmt('jp', `${CC[y]},${hex(nn, 4)}`);
      break;
    }
    case 3:
      if (y === 0) { const nn = next16(); out.target = nn; out.flow = 'jp'; out.text = fmt('jp', hex(nn, 4)); }
      else if (y === 2) { const n = next(); out.text = fmt('out', `(${hex(n)}),a`); }
      else if (y === 3) { const n = next(); out.text = fmt('in', `a,(${hex(n)})`); }
      else if (y === 4) out.text = fmt('ex', `(sp),${rp(2)}`);
      else if (y === 5) out.text = fmt('ex', 'de,hl');
      else if (y === 6) out.text = 'di';
      else if (y === 7) out.text = 'ei';
      break;
    case 4: {
      const nn = next16();
      out.target = nn; out.flow = 'call'; out.cond = true;
      out.text = fmt('call', `${CC[y]},${hex(nn, 4)}`);
      break;
    }
    case 5:
      if (q === 0) out.text = fmt('push', rp2(p));
      else if (p === 0) { const nn = next16(); out.target = nn; out.flow = 'call'; out.text = fmt('call', hex(nn, 4)); }
      else out.text = 'nop*';
      break;
    case 6: { const n = next(); out.text = ALU[y] + hex(n); break; }
    default: out.target = y * 8; out.flow = 'rst'; out.text = fmt('rst', hex(y * 8)); break;
  }
  return finish(out, pc, read);
}

/** @param {Instr} out @param {number} pc @param {(a:number)=>number} read */
function finish(out, pc, read) {
  out.len = pc - out.addr;
  for (let a = out.addr; a < pc; a += 1) out.bytes.push(read(a & 0xffff) & 0xff);
  return out;
}

export { hex };
