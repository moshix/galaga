// Copyright 2026 by Moshix
/**
 * Cycle-counted Z80 CPU core -- the execution engine of the Galaxian test
 * oracle.
 *
 * Scope and priorities:
 *  - Every documented opcode plus the CB / ED / DD / FD / DDCB / FDCB prefixes.
 *  - Flags are exact, including the undocumented X (bit 3) and Y (bit 5)
 *    copies of the result. The Galaxian ROM threads booleans through
 *    `rrca` + `jr c` chains and leaves X/Y lying around after `bit`, so an
 *    "approximately right" flag model is not good enough for a diff oracle.
 *  - T-state counts are the standard Zilog figures, because the machine
 *    harness schedules the vblank NMI by cycle position inside the frame.
 *
 * Deliberate simplification: MEMPTR/WZ is modelled (it is what supplies X/Y
 * for `bit n,(hl)`), but the NMOS "Q" register that perturbs X/Y after
 * SCF/CCF is not -- SCF/CCF take X/Y from A, which is the behaviour described
 * in "The Undocumented Z80 Documented" and the one every other emulator
 * implements. No Galaxian code path can observe the difference: the ROM only
 * ever uses scf/ccf to feed a carry (e.g. CALCULATE_TANGENT, .asm:751-761).
 */

/** Carry. */
export const FLAG_C = 0x01;
/** Add/Subtract. */
export const FLAG_N = 0x02;
/** Parity / overflow. */
export const FLAG_P = 0x04;
/** Undocumented copy of result bit 3. */
export const FLAG_X = 0x08;
/** Half carry. */
export const FLAG_H = 0x10;
/** Undocumented copy of result bit 5. */
export const FLAG_Y = 0x20;
/** Zero. */
export const FLAG_Z = 0x40;
/** Sign. */
export const FLAG_S = 0x80;

const C = FLAG_C, N = FLAG_N, PV = FLAG_P, XF = FLAG_X;
const HF = FLAG_H, YF = FLAG_Y, ZF = FLAG_Z, SF = FLAG_S;

/** Parity flag for every byte value (set when the number of 1 bits is even). */
const PARITY = new Uint8Array(256);
/** S, Z, X and Y for every byte value. */
const SZXY = new Uint8Array(256);
/** S, Z, X, Y and parity for every byte value. */
const SZXYP = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) {
  let bits = 0;
  for (let b = 0; b < 8; b += 1) bits += (i >> b) & 1;
  PARITY[i] = bits % 2 === 0 ? PV : 0;
  SZXY[i] = (i & (SF | XF | YF)) | (i === 0 ? ZF : 0);
  SZXYP[i] = SZXY[i] | PARITY[i];
}

/**
 * Base T-states per unprefixed opcode. Conditional instructions hold the
 * "not taken" figure; the extra is added at the branch site. The four prefix
 * bytes hold 0 -- prefixed instructions account for themselves.
 */
const BASE_CYCLES = Uint8Array.from([
  4, 10, 7, 6, 4, 4, 7, 4, 4, 11, 7, 6, 4, 4, 7, 4,
  8, 10, 7, 6, 4, 4, 7, 4, 12, 11, 7, 6, 4, 4, 7, 4,
  7, 10, 16, 6, 4, 4, 7, 4, 7, 11, 16, 6, 4, 4, 7, 4,
  7, 10, 13, 6, 11, 11, 10, 4, 7, 11, 13, 6, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  7, 7, 7, 7, 7, 7, 4, 7, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  5, 10, 10, 10, 10, 11, 7, 11, 5, 10, 10, 0, 10, 17, 7, 11,
  5, 10, 10, 11, 10, 11, 7, 11, 5, 4, 10, 11, 10, 0, 7, 11,
  5, 10, 10, 19, 10, 11, 7, 11, 5, 4, 10, 4, 10, 0, 7, 11,
  5, 10, 10, 4, 10, 11, 7, 11, 5, 6, 10, 4, 10, 0, 7, 11,
]);

/** Interrupt mode selected by the y field of an ED 46-style opcode. */
const IM_TABLE = Uint8Array.from([0, 0, 1, 2, 0, 0, 1, 2]);

/**
 * @typedef {object} Bus
 * @property {(addr: number) => number} read     memory read, returns 0..255
 * @property {(addr: number, value: number) => void} write memory write
 * @property {((port: number) => number)=} readIo   IN (port is the full 16 bits)
 * @property {((port: number, value: number) => void)=} writeIo OUT
 */

/**
 * @typedef {object} RegisterSet
 * @property {number} af @property {number} bc @property {number} de
 * @property {number} hl @property {number} af_ @property {number} bc_
 * @property {number} de_ @property {number} hl_ @property {number} ix
 * @property {number} iy @property {number} sp @property {number} pc
 * @property {number} i @property {number} r @property {number} iff1
 * @property {number} iff2 @property {number} im @property {boolean} halted
 */

export class Z80 {
  /** @param {Bus} bus */
  constructor(bus) {
    /** @type {Bus} */
    this.bus = bus;
    /** Total T-states executed since construction. @type {number} */
    this.cycles = 0;
    this.reset();
  }

  /** Power-on / RESET state. @returns {void} */
  reset() {
    this.a = 0xff; this.f = 0xff;
    this.b = 0; this.c = 0; this.d = 0; this.e = 0; this.h = 0; this.l = 0;
    this.a_ = 0; this.f_ = 0;
    this.b_ = 0; this.c_ = 0; this.d_ = 0; this.e_ = 0; this.h_ = 0; this.l_ = 0;
    this.ixh = 0xff; this.ixl = 0xff; this.iyh = 0xff; this.iyl = 0xff;
    this.sp = 0xffff;
    this.pc = 0;
    this.i = 0;
    this.r = 0;          // low 7 bits, incremented per M1
    this.r7 = 0;         // bit 7, only ever changed by LD R,A
    this.iff1 = 0; this.iff2 = 0; this.im = 0;
    this.halted = false;
    this.wz = 0;         // MEMPTR
    this.nmiPending = false;
    this.intPending = false;
    this.intData = 0xff;
    /** Set while EI is "in the shadow": interrupts resume after the next op. */
    this.eiPending = false;
    this.t = 0;
  }

  // ---------------------------------------------------------------- registers

  get bc() { return (this.b << 8) | this.c; }
  set bc(v) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }
  get de() { return (this.d << 8) | this.e; }
  set de(v) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }
  get hl() { return (this.h << 8) | this.l; }
  set hl(v) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }
  get af() { return (this.a << 8) | this.f; }
  set af(v) { this.a = (v >> 8) & 0xff; this.f = v & 0xff; }
  get ix() { return (this.ixh << 8) | this.ixl; }
  set ix(v) { this.ixh = (v >> 8) & 0xff; this.ixl = v & 0xff; }
  get iy() { return (this.iyh << 8) | this.iyl; }
  set iy(v) { this.iyh = (v >> 8) & 0xff; this.iyl = v & 0xff; }

  /**
   * Snapshot of every architectural register, as a plain object, for tests.
   * @returns {RegisterSet}
   */
  getRegisters() {
    return {
      af: this.af, bc: this.bc, de: this.de, hl: this.hl,
      af_: (this.a_ << 8) | this.f_,
      bc_: (this.b_ << 8) | this.c_,
      de_: (this.d_ << 8) | this.e_,
      hl_: (this.h_ << 8) | this.l_,
      ix: this.ix, iy: this.iy, sp: this.sp, pc: this.pc,
      i: this.i, r: (this.r & 0x7f) | this.r7,
      iff1: this.iff1, iff2: this.iff2, im: this.im, halted: this.halted,
    };
  }

  /**
   * Load registers from a partial plain object (anything omitted is untouched).
   * @param {Partial<RegisterSet>} regs
   * @returns {void}
   */
  setRegisters(regs) {
    if (regs.af !== undefined) this.af = regs.af;
    if (regs.bc !== undefined) this.bc = regs.bc;
    if (regs.de !== undefined) this.de = regs.de;
    if (regs.hl !== undefined) this.hl = regs.hl;
    if (regs.af_ !== undefined) { this.a_ = (regs.af_ >> 8) & 0xff; this.f_ = regs.af_ & 0xff; }
    if (regs.bc_ !== undefined) { this.b_ = (regs.bc_ >> 8) & 0xff; this.c_ = regs.bc_ & 0xff; }
    if (regs.de_ !== undefined) { this.d_ = (regs.de_ >> 8) & 0xff; this.e_ = regs.de_ & 0xff; }
    if (regs.hl_ !== undefined) { this.h_ = (regs.hl_ >> 8) & 0xff; this.l_ = regs.hl_ & 0xff; }
    if (regs.ix !== undefined) this.ix = regs.ix;
    if (regs.iy !== undefined) this.iy = regs.iy;
    if (regs.sp !== undefined) this.sp = regs.sp & 0xffff;
    if (regs.pc !== undefined) this.pc = regs.pc & 0xffff;
    if (regs.i !== undefined) this.i = regs.i & 0xff;
    if (regs.r !== undefined) { this.r = regs.r & 0x7f; this.r7 = regs.r & 0x80; }
    if (regs.iff1 !== undefined) this.iff1 = regs.iff1 ? 1 : 0;
    if (regs.iff2 !== undefined) this.iff2 = regs.iff2 ? 1 : 0;
    if (regs.im !== undefined) this.im = regs.im;
    if (regs.halted !== undefined) this.halted = regs.halted;
  }

  // ------------------------------------------------------------------ memory

  /** @param {number} addr @returns {number} */
  rb(addr) { return this.bus.read(addr & 0xffff) & 0xff; }
  /** @param {number} addr @param {number} v @returns {void} */
  wb(addr, v) { this.bus.write(addr & 0xffff, v & 0xff); }
  /** @param {number} addr @returns {number} */
  rw(addr) { return this.rb(addr) | (this.rb(addr + 1) << 8); }
  /** @param {number} addr @param {number} v @returns {void} */
  ww(addr, v) { this.wb(addr, v & 0xff); this.wb(addr + 1, (v >> 8) & 0xff); }

  /** @returns {number} */
  fetch() { const v = this.rb(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  /** @returns {number} */
  fetch16() { const v = this.rw(this.pc); this.pc = (this.pc + 2) & 0xffff; return v; }
  /** Signed displacement byte. @returns {number} */
  fetchDisp() { const v = this.fetch(); return v < 0x80 ? v : v - 256; }

  /** @param {number} v @returns {void} */
  push16(v) {
    this.sp = (this.sp - 2) & 0xffff;
    this.ww(this.sp, v);
  }

  /** @returns {number} */
  pop16() {
    const v = this.rw(this.sp);
    this.sp = (this.sp + 2) & 0xffff;
    return v;
  }

  /** Bump the memory refresh counter, once per M1 (opcode fetch) cycle. */
  incR() { this.r = (this.r + 1) & 0x7f; }

  // ------------------------------------------------------------ interrupts

  /** Assert the non-maskable interrupt line. @returns {void} */
  nmi() { this.nmiPending = true; }

  /**
   * Assert the maskable interrupt line. Galaxian never uses it (the board
   * wires vblank to NMI only) but a CPU core without INT is not a Z80.
   * @param {number} [data] byte the device puts on the bus for IM 0 / IM 2
   * @returns {void}
   */
  irq(data = 0xff) { this.intPending = true; this.intData = data & 0xff; }

  /** @returns {void} */
  clearIrq() { this.intPending = false; }

  // ------------------------------------------------------------------- step

  /**
   * Execute one instruction (or take a pending interrupt).
   * @returns {number} T-states consumed
   */
  step() {
    this.t = 0;

    if (this.nmiPending) {
      this.nmiPending = false;
      this.halted = false;
      this.incR();
      // The NMI copies IFF1 into IFF2 so RETN can restore it, then clears
      // IFF1. Galaxian's handler relies on nothing here except the vector,
      // but RETN correctness is free once IFF2 is right.
      this.iff2 = this.iff1;
      this.iff1 = 0;
      this.push16(this.pc);
      this.pc = 0x0066;
      this.wz = 0x0066;
      this.t += 11;
      this.cycles += this.t;
      return this.t;
    }

    if (this.intPending && this.iff1 && !this.eiPending) {
      this.halted = false;
      this.incR();
      this.iff1 = 0; this.iff2 = 0;
      if (this.im === 2) {
        this.push16(this.pc);
        const vec = ((this.i << 8) | this.intData) & 0xffff;
        this.pc = this.rw(vec);
        this.wz = this.pc;
        this.t += 19;
      } else if (this.im === 1) {
        this.push16(this.pc);
        this.pc = 0x0038;
        this.wz = 0x0038;
        this.t += 13;
      } else {
        // IM 0: execute the byte on the bus. In practice always an RST.
        this.push16(this.pc);
        this.pc = this.intData & 0x38;
        this.wz = this.pc;
        this.t += 13;
      }
      this.cycles += this.t;
      return this.t;
    }

    this.eiPending = false;

    if (this.halted) {
      this.incR();
      this.t += 4;
      this.cycles += this.t;
      return this.t;
    }

    this.exec(0);
    this.cycles += this.t;
    return this.t;
  }

  // ------------------------------------------------------------ ALU helpers

  /** @param {number} v @returns {void} */
  add8(v) {
    const a = this.a;
    const r = a + v;
    const res = r & 0xff;
    this.f = (res & (SF | XF | YF)) | (res === 0 ? ZF : 0)
      | ((a ^ v ^ res) & HF)
      | (((a ^ res) & (v ^ res) & 0x80) >> 5)
      | (r > 0xff ? C : 0);
    this.a = res;
  }

  /** @param {number} v @returns {void} */
  adc8(v) {
    const a = this.a;
    const r = a + v + (this.f & C);
    const res = r & 0xff;
    this.f = (res & (SF | XF | YF)) | (res === 0 ? ZF : 0)
      | ((a ^ v ^ res) & HF)
      | (((a ^ res) & (v ^ res) & 0x80) >> 5)
      | (r > 0xff ? C : 0);
    this.a = res;
  }

  /** @param {number} v @returns {void} */
  sub8(v) {
    const a = this.a;
    const r = a - v;
    const res = r & 0xff;
    this.f = (res & (SF | XF | YF)) | (res === 0 ? ZF : 0)
      | ((a ^ v ^ res) & HF)
      | (((a ^ v) & (a ^ res) & 0x80) >> 5)
      | (r < 0 ? C : 0) | N;
    this.a = res;
  }

  /** @param {number} v @returns {void} */
  sbc8(v) {
    const a = this.a;
    const r = a - v - (this.f & C);
    const res = r & 0xff;
    this.f = (res & (SF | XF | YF)) | (res === 0 ? ZF : 0)
      | ((a ^ v ^ res) & HF)
      | (((a ^ v) & (a ^ res) & 0x80) >> 5)
      | (r < 0 ? C : 0) | N;
    this.a = res;
  }

  /**
   * CP differs from SUB in one subtle, load-bearing way: X and Y come from
   * the *operand*, not from the (discarded) result.
   * @param {number} v @returns {void}
   */
  cp8(v) {
    const a = this.a;
    const r = a - v;
    const res = r & 0xff;
    this.f = (res & SF) | (res === 0 ? ZF : 0)
      | (v & (XF | YF))
      | ((a ^ v ^ res) & HF)
      | (((a ^ v) & (a ^ res) & 0x80) >> 5)
      | (r < 0 ? C : 0) | N;
  }

  /** @param {number} v @returns {void} */
  and8(v) { this.a &= v; this.f = SZXYP[this.a] | HF; }
  /** @param {number} v @returns {void} */
  xor8(v) { this.a ^= v; this.f = SZXYP[this.a]; }
  /** @param {number} v @returns {void} */
  or8(v) { this.a |= v; this.f = SZXYP[this.a]; }

  /** @param {number} v @returns {number} */
  inc8(v) {
    const res = (v + 1) & 0xff;
    this.f = (this.f & C) | SZXY[res]
      | ((res & 0x0f) === 0 ? HF : 0)
      | (res === 0x80 ? PV : 0);
    return res;
  }

  /** @param {number} v @returns {number} */
  dec8(v) {
    const res = (v - 1) & 0xff;
    this.f = (this.f & C) | SZXY[res]
      | ((res & 0x0f) === 0x0f ? HF : 0)
      | (res === 0x7f ? PV : 0) | N;
    return res;
  }

  /** @param {number} hl @param {number} v @returns {number} */
  add16(hl, v) {
    this.wz = (hl + 1) & 0xffff;
    const r = hl + v;
    this.f = (this.f & (SF | ZF | PV))
      | (((hl ^ v ^ r) >> 8) & HF)
      | ((r >> 8) & (XF | YF))
      | (r > 0xffff ? C : 0);
    return r & 0xffff;
  }

  /** @param {number} v @returns {void} */
  adc16(v) {
    const hl = this.hl;
    this.wz = (hl + 1) & 0xffff;
    const r = hl + v + (this.f & C);
    const res = r & 0xffff;
    this.f = ((res >> 8) & (SF | XF | YF)) | (res === 0 ? ZF : 0)
      | (((hl ^ v ^ res) >> 8) & HF)
      | (((hl ^ res) & (v ^ res) & 0x8000) >> 13)
      | (r > 0xffff ? C : 0);
    this.hl = res;
  }

  /** @param {number} v @returns {void} */
  sbc16(v) {
    const hl = this.hl;
    this.wz = (hl + 1) & 0xffff;
    const r = hl - v - (this.f & C);
    const res = r & 0xffff;
    this.f = ((res >> 8) & (SF | XF | YF)) | (res === 0 ? ZF : 0)
      | (((hl ^ v ^ res) >> 8) & HF)
      | (((hl ^ v) & (hl ^ res) & 0x8000) >> 13)
      | (r < 0 ? C : 0) | N;
    this.hl = res;
  }

  /**
   * Decimal adjust after add/subtract.
   *
   * The correction amount depends only on C, H and the two nibbles of A --
   * never on N. N decides only whether the correction is added or subtracted.
   * That is the behaviour the scoring code depends on: UPDATE_PLAYER_SCORE
   * (.asm:7563) adds packed BCD digits with `add a,(hl)` + `daa`, and
   * CONVERT_A_TO_BCD (.asm:8212) walks a binary value into BCD with
   * `add a,a` + `daa` in a loop, which hits the "A > $99" carry path.
   * @returns {void}
   */
  daa() {
    const a = this.a;
    let diff = 0;
    let carry = this.f & C;
    if ((this.f & HF) !== 0 || (a & 0x0f) > 9) diff |= 0x06;
    if (carry !== 0 || a > 0x99) { diff |= 0x60; carry = C; }
    let res;
    let half;
    if ((this.f & N) !== 0) {
      res = (a - diff) & 0xff;
      // Borrow out of bit 3 only if there was a half-borrow to propagate.
      half = ((this.f & HF) !== 0 && (a & 0x0f) < 6) ? HF : 0;
    } else {
      res = (a + diff) & 0xff;
      half = (a & 0x0f) > 9 ? HF : 0;
    }
    this.a = res;
    this.f = SZXYP[res] | half | (this.f & N) | carry;
  }

  // ------------------------------------------------------------- CB helpers

  /** @param {number} v @returns {number} */
  rlc(v) { const c = (v >> 7) & 1; const r = ((v << 1) | c) & 0xff; this.f = SZXYP[r] | c; return r; }
  /** @param {number} v @returns {number} */
  rrc(v) { const c = v & 1; const r = ((v >> 1) | (c << 7)) & 0xff; this.f = SZXYP[r] | c; return r; }
  /** @param {number} v @returns {number} */
  rl(v) { const c = (v >> 7) & 1; const r = ((v << 1) | (this.f & C)) & 0xff; this.f = SZXYP[r] | c; return r; }
  /** @param {number} v @returns {number} */
  rr(v) { const c = v & 1; const r = ((v >> 1) | ((this.f & C) << 7)) & 0xff; this.f = SZXYP[r] | c; return r; }
  /** @param {number} v @returns {number} */
  sla(v) { const c = (v >> 7) & 1; const r = (v << 1) & 0xff; this.f = SZXYP[r] | c; return r; }
  /** @param {number} v @returns {number} */
  sra(v) { const c = v & 1; const r = ((v >> 1) | (v & 0x80)) & 0xff; this.f = SZXYP[r] | c; return r; }
  /** Undocumented SLL: shifts left and feeds a 1 into bit 0. @param {number} v @returns {number} */
  sll(v) { const c = (v >> 7) & 1; const r = ((v << 1) | 1) & 0xff; this.f = SZXYP[r] | c; return r; }
  /** @param {number} v @returns {number} */
  srl(v) { const c = v & 1; const r = (v >> 1) & 0xff; this.f = SZXYP[r] | c; return r; }

  /**
   * @param {number} bit  0..7
   * @param {number} v    value under test
   * @param {number} xy   byte X/Y are taken from (the operand, or WZ>>8 for memory)
   * @returns {void}
   */
  bitTest(bit, v, xy) {
    const masked = v & (1 << bit);
    this.f = (this.f & C) | HF
      | (masked === 0 ? (ZF | PV) : 0)
      | (masked & SF)
      | (xy & (XF | YF));
  }

  // -------------------------------------------------------- register access

  /**
   * Read register by 3-bit encoding. Index 6 means memory at `ea`.
   * @param {number} idx 0..7 (B,C,D,E,H,L,(HL),A)
   * @param {number} pre 0 = none, 1 = IX, 2 = IY
   * @param {number} ea  effective address used when idx === 6
   * @returns {number}
   */
  getR(idx, pre, ea) {
    switch (idx) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return pre === 0 ? this.h : (pre === 1 ? this.ixh : this.iyh);
      case 5: return pre === 0 ? this.l : (pre === 1 ? this.ixl : this.iyl);
      case 6: return this.rb(ea);
      default: return this.a;
    }
  }

  /**
   * @param {number} idx @param {number} pre @param {number} ea @param {number} v
   * @returns {void}
   */
  setR(idx, pre, ea, v) {
    const b = v & 0xff;
    switch (idx) {
      case 0: this.b = b; break;
      case 1: this.c = b; break;
      case 2: this.d = b; break;
      case 3: this.e = b; break;
      case 4: if (pre === 0) this.h = b; else if (pre === 1) this.ixh = b; else this.iyh = b; break;
      case 5: if (pre === 0) this.l = b; else if (pre === 1) this.ixl = b; else this.iyl = b; break;
      case 6: this.wb(ea, b); break;
      default: this.a = b; break;
    }
  }

  /**
   * Register pair by 2-bit encoding, with SP as pair 3 (the rp table).
   * @param {number} p @param {number} pre @returns {number}
   */
  getRP(p, pre) {
    switch (p) {
      case 0: return this.bc;
      case 1: return this.de;
      case 2: return pre === 0 ? this.hl : (pre === 1 ? this.ix : this.iy);
      default: return this.sp;
    }
  }

  /** @param {number} p @param {number} pre @param {number} v @returns {void} */
  setRP(p, pre, v) {
    const w = v & 0xffff;
    switch (p) {
      case 0: this.bc = w; break;
      case 1: this.de = w; break;
      case 2: if (pre === 0) this.hl = w; else if (pre === 1) this.ix = w; else this.iy = w; break;
      default: this.sp = w; break;
    }
  }

  /**
   * Condition codes NZ, Z, NC, C, PO, PE, P, M.
   * @param {number} cc 0..7 @returns {boolean}
   */
  cond(cc) {
    switch (cc) {
      case 0: return (this.f & ZF) === 0;
      case 1: return (this.f & ZF) !== 0;
      case 2: return (this.f & C) === 0;
      case 3: return (this.f & C) !== 0;
      case 4: return (this.f & PV) === 0;
      case 5: return (this.f & PV) !== 0;
      case 6: return (this.f & SF) === 0;
      default: return (this.f & SF) !== 0;
    }
  }

  /** @param {number} op @param {number} v @returns {void} */
  alu(op, v) {
    switch (op) {
      case 0: this.add8(v); break;
      case 1: this.adc8(v); break;
      case 2: this.sub8(v); break;
      case 3: this.sbc8(v); break;
      case 4: this.and8(v); break;
      case 5: this.xor8(v); break;
      case 6: this.or8(v); break;
      default: this.cp8(v); break;
    }
  }

  // ------------------------------------------------------------ main decode

  /**
   * Fetch and execute one (possibly prefixed) instruction.
   * @param {number} pre 0 = plain, 1 = DD (IX), 2 = FD (IY)
   * @returns {void}
   */
  exec(pre) {
    this.incR();
    const op = this.fetch();

    if (op === 0xdd) { this.t += 4; this.exec(1); return; }
    if (op === 0xfd) { this.t += 4; this.exec(2); return; }
    if (op === 0xcb) { if (pre === 0) this.execCB(); else this.execIndexCB(pre); return; }
    if (op === 0xed) { this.execED(); return; }

    this.t += BASE_CYCLES[op];

    const x = op >> 6;
    const y = (op >> 3) & 7;
    const z = op & 7;
    const p = y >> 1;
    const q = y & 1;

    // An index prefix turns (HL) into (IX+d): the displacement is fetched
    // straight after the opcode, and costs 8 extra T-states (5 for the
    // LD (IX+d),n special case, where the operand fetch overlaps).
    let ea = 0;
    let usesMem = false;
    if (x === 1) usesMem = (y === 6 || z === 6) && op !== 0x76;
    else if (x === 0) usesMem = (z === 4 || z === 5 || z === 6) && y === 6;
    else if (x === 2) usesMem = z === 6;
    if (usesMem) {
      if (pre === 0) {
        ea = this.hl;
      } else {
        const d = this.fetchDisp();
        ea = ((pre === 1 ? this.ix : this.iy) + d) & 0xffff;
        this.wz = ea;
        this.t += (x === 0 && z === 6) ? 5 : 8;
      }
    }

    switch (x) {
      case 0:
        switch (z) {
          case 0:
            if (y === 0) break;                                  // NOP
            if (y === 1) {                                       // EX AF,AF'
              let tmp = this.a; this.a = this.a_; this.a_ = tmp;
              tmp = this.f; this.f = this.f_; this.f_ = tmp;
              break;
            }
            if (y === 2) {                                       // DJNZ d
              const d = this.fetchDisp();
              this.b = (this.b - 1) & 0xff;
              if (this.b !== 0) {
                this.pc = (this.pc + d) & 0xffff;
                this.wz = this.pc;
                this.t += 5;
              }
              break;
            }
            if (y === 3) {                                       // JR d
              const d = this.fetchDisp();
              this.pc = (this.pc + d) & 0xffff;
              this.wz = this.pc;
              break;
            }
            {                                                    // JR cc,d
              const d = this.fetchDisp();
              if (this.cond(y - 4)) {
                this.pc = (this.pc + d) & 0xffff;
                this.wz = this.pc;
                this.t += 5;
              }
            }
            break;

          case 1:
            if (q === 0) this.setRP(p, pre, this.fetch16());      // LD rp,nn
            else this.setRP(2, pre, this.add16(this.getRP(2, pre), this.getRP(p, pre))); // ADD HL,rp
            break;

          case 2:
            switch (y) {
              case 0:                                             // LD (BC),A
                this.wb(this.bc, this.a);
                this.wz = ((this.bc + 1) & 0xff) | (this.a << 8);
                break;
              case 1:                                             // LD A,(BC)
                this.a = this.rb(this.bc);
                this.wz = (this.bc + 1) & 0xffff;
                break;
              case 2:                                             // LD (DE),A
                this.wb(this.de, this.a);
                this.wz = ((this.de + 1) & 0xff) | (this.a << 8);
                break;
              case 3:                                             // LD A,(DE)
                this.a = this.rb(this.de);
                this.wz = (this.de + 1) & 0xffff;
                break;
              case 4: {                                           // LD (nn),HL
                const nn = this.fetch16();
                this.ww(nn, this.getRP(2, pre));
                this.wz = (nn + 1) & 0xffff;
                break;
              }
              case 5: {                                           // LD HL,(nn)
                const nn = this.fetch16();
                this.setRP(2, pre, this.rw(nn));
                this.wz = (nn + 1) & 0xffff;
                break;
              }
              case 6: {                                           // LD (nn),A
                const nn = this.fetch16();
                this.wb(nn, this.a);
                this.wz = ((nn + 1) & 0xff) | (this.a << 8);
                break;
              }
              default: {                                          // LD A,(nn)
                const nn = this.fetch16();
                this.a = this.rb(nn);
                this.wz = (nn + 1) & 0xffff;
                break;
              }
            }
            break;

          case 3:                                                 // INC/DEC rp
            this.setRP(p, pre, this.getRP(p, pre) + (q === 0 ? 1 : -1));
            break;

          case 4:                                                 // INC r
            this.setR(y, pre, ea, this.inc8(this.getR(y, pre, ea)));
            break;

          case 5:                                                 // DEC r
            this.setR(y, pre, ea, this.dec8(this.getR(y, pre, ea)));
            break;

          case 6:                                                 // LD r,n
            this.setR(y, pre, ea, this.fetch());
            break;

          default:
            switch (y) {
              case 0: {                                           // RLCA
                const c = (this.a >> 7) & 1;
                this.a = ((this.a << 1) | c) & 0xff;
                this.f = (this.f & (SF | ZF | PV)) | (this.a & (XF | YF)) | c;
                break;
              }
              case 1: {                                           // RRCA
                const c = this.a & 1;
                this.a = ((this.a >> 1) | (c << 7)) & 0xff;
                this.f = (this.f & (SF | ZF | PV)) | (this.a & (XF | YF)) | c;
                break;
              }
              case 2: {                                           // RLA
                const c = (this.a >> 7) & 1;
                this.a = ((this.a << 1) | (this.f & C)) & 0xff;
                this.f = (this.f & (SF | ZF | PV)) | (this.a & (XF | YF)) | c;
                break;
              }
              case 3: {                                           // RRA
                const c = this.a & 1;
                this.a = ((this.a >> 1) | ((this.f & C) << 7)) & 0xff;
                this.f = (this.f & (SF | ZF | PV)) | (this.a & (XF | YF)) | c;
                break;
              }
              case 4:                                             // DAA
                this.daa();
                break;
              case 5:                                             // CPL
                this.a = (~this.a) & 0xff;
                this.f = (this.f & (SF | ZF | PV | C)) | HF | N | (this.a & (XF | YF));
                break;
              case 6:                                             // SCF
                this.f = (this.f & (SF | ZF | PV)) | (this.a & (XF | YF)) | C;
                break;
              default:                                            // CCF
                this.f = (this.f & (SF | ZF | PV)) | (this.a & (XF | YF))
                  | ((this.f & C) << 4) | ((this.f & C) ^ C);
                break;
            }
            break;
        }
        break;

      case 1:
        if (op === 0x76) {                                        // HALT
          this.halted = true;
          break;
        }
        // With an index prefix, only the memory side is indexed: LD H,(IX+d)
        // writes the *real* H, and LD (IX+d),L reads the *real* L.
        if (y === 6) this.setR(6, pre, ea, this.getR(z, 0, 0));
        else if (z === 6) this.setR(y, 0, 0, this.getR(6, pre, ea));
        else this.setR(y, pre, ea, this.getR(z, pre, ea));
        break;

      case 2:
        this.alu(y, this.getR(z, pre, ea));
        break;

      default:
        switch (z) {
          case 0:                                                 // RET cc
            if (this.cond(y)) { this.pc = this.pop16(); this.wz = this.pc; this.t += 6; }
            break;

          case 1:
            if (q === 0) {                                        // POP rp2
              if (p === 3) this.af = this.pop16();
              else this.setRP(p, pre, this.pop16());
            } else if (p === 0) {                                 // RET
              this.pc = this.pop16(); this.wz = this.pc;
            } else if (p === 1) {                                 // EXX
              let t = this.b; this.b = this.b_; this.b_ = t;
              t = this.c; this.c = this.c_; this.c_ = t;
              t = this.d; this.d = this.d_; this.d_ = t;
              t = this.e; this.e = this.e_; this.e_ = t;
              t = this.h; this.h = this.h_; this.h_ = t;
              t = this.l; this.l = this.l_; this.l_ = t;
            } else if (p === 2) {                                 // JP (HL)
              this.pc = this.getRP(2, pre);
            } else {                                              // LD SP,HL
              this.sp = this.getRP(2, pre);
            }
            break;

          case 2: {                                               // JP cc,nn
            const nn = this.fetch16();
            this.wz = nn;
            if (this.cond(y)) this.pc = nn;
            break;
          }

          case 3:
            switch (y) {
              case 0: {                                           // JP nn
                const nn = this.fetch16();
                this.pc = nn; this.wz = nn;
                break;
              }
              case 2: {                                           // OUT (n),A
                const n = this.fetch();
                const port = (this.a << 8) | n;
                if (this.bus.writeIo) this.bus.writeIo(port, this.a);
                this.wz = ((n + 1) & 0xff) | (this.a << 8);
                break;
              }
              case 3: {                                           // IN A,(n)
                const n = this.fetch();
                const port = (this.a << 8) | n;
                this.a = this.bus.readIo ? this.bus.readIo(port) & 0xff : 0xff;
                this.wz = (port + 1) & 0xffff;
                break;
              }
              case 4: {                                           // EX (SP),HL
                const v = this.rw(this.sp);
                this.ww(this.sp, this.getRP(2, pre));
                this.setRP(2, pre, v);
                this.wz = v;
                break;
              }
              case 5: {                                           // EX DE,HL
                const t = this.de; this.de = this.hl; this.hl = t;
                break;
              }
              case 6:                                             // DI
                this.iff1 = 0; this.iff2 = 0;
                break;
              default:                                            // EI
                this.iff1 = 1; this.iff2 = 1; this.eiPending = true;
                break;
            }
            break;

          case 4: {                                               // CALL cc,nn
            const nn = this.fetch16();
            this.wz = nn;
            if (this.cond(y)) { this.push16(this.pc); this.pc = nn; this.t += 7; }
            break;
          }

          case 5:
            if (q === 0) {                                        // PUSH rp2
              this.push16(p === 3 ? this.af : this.getRP(p, pre));
            } else {                                              // CALL nn
              const nn = this.fetch16();
              this.push16(this.pc);
              this.pc = nn; this.wz = nn;
            }
            break;

          case 6:                                                 // alu n
            this.alu(y, this.fetch());
            break;

          default:                                                // RST p
            this.push16(this.pc);
            this.pc = y * 8;
            this.wz = this.pc;
            break;
        }
        break;
    }
  }

  /** CB-prefixed opcodes. Adds the full instruction cost. @returns {void} */
  execCB() {
    this.incR();
    const op = this.fetch();
    const x = op >> 6;
    const y = (op >> 3) & 7;
    const z = op & 7;
    const mem = z === 6;
    this.t += mem ? (x === 1 ? 12 : 15) : 8;
    const ea = this.hl;
    const v = mem ? this.rb(ea) : this.getR(z, 0, 0);

    if (x === 0) {
      this.setR(z, 0, ea, this.shiftOp(y, v));
    } else if (x === 1) {
      // BIT n,(HL) takes X/Y from the internal WZ register, not from the byte.
      this.bitTest(y, v, mem ? (this.wz >> 8) : v);
    } else if (x === 2) {
      this.setR(z, 0, ea, v & ~(1 << y));
    } else {
      this.setR(z, 0, ea, v | (1 << y));
    }
  }

  /**
   * DDCB / FDCB: opcode layout is <prefix> CB <displacement> <opcode>.
   * The result is written back to (IX+d) *and*, undocumented, to the register
   * named by the low 3 bits unless that is 6.
   * The 4 T-states of the index prefix were charged by exec(), so only the
   * remaining 19 (16 for BIT) are added here.
   * @param {number} pre 1 = IX, 2 = IY
   * @returns {void}
   */
  execIndexCB(pre) {
    const d = this.fetchDisp();
    const ea = ((pre === 1 ? this.ix : this.iy) + d) & 0xffff;
    this.wz = ea;
    // No incR() here: in the DD CB d op layout only the DD and CB fetches are
    // M1 cycles, so R goes up by two for the whole instruction, not three.
    const op = this.fetch();
    const x = op >> 6;
    const y = (op >> 3) & 7;
    const z = op & 7;
    this.t += x === 1 ? 16 : 19;
    const v = this.rb(ea);

    if (x === 1) {
      this.bitTest(y, v, this.wz >> 8);
      return;
    }
    let res;
    if (x === 0) res = this.shiftOp(y, v);
    else if (x === 2) res = v & ~(1 << y);
    else res = v | (1 << y);
    this.wb(ea, res);
    if (z !== 6) this.setR(z, 0, 0, res);
  }

  /** @param {number} y @param {number} v @returns {number} */
  shiftOp(y, v) {
    switch (y) {
      case 0: return this.rlc(v);
      case 1: return this.rrc(v);
      case 2: return this.rl(v);
      case 3: return this.rr(v);
      case 4: return this.sla(v);
      case 5: return this.sra(v);
      case 6: return this.sll(v);
      default: return this.srl(v);
    }
  }

  /** ED-prefixed opcodes. Adds the full instruction cost. @returns {void} */
  execED() {
    this.incR();
    const op = this.fetch();
    const x = op >> 6;
    const y = (op >> 3) & 7;
    const z = op & 7;
    const p = y >> 1;
    const q = y & 1;

    if (x === 1) {
      switch (z) {
        case 0: {                                                // IN r,(C)
          this.t += 12;
          const v = this.bus.readIo ? this.bus.readIo(this.bc) & 0xff : 0xff;
          this.wz = (this.bc + 1) & 0xffff;
          this.f = (this.f & C) | SZXYP[v];
          if (y !== 6) this.setR(y, 0, 0, v);                     // y === 6: IN (C), flags only
          return;
        }
        case 1: {                                                // OUT (C),r
          this.t += 12;
          const v = y === 6 ? 0 : this.getR(y, 0, 0);
          if (this.bus.writeIo) this.bus.writeIo(this.bc, v);
          this.wz = (this.bc + 1) & 0xffff;
          return;
        }
        case 2:                                                  // SBC/ADC HL,rp
          this.t += 15;
          if (q === 0) this.sbc16(this.getRP(p, 0));
          else this.adc16(this.getRP(p, 0));
          return;
        case 3: {                                                // LD (nn),rp / LD rp,(nn)
          this.t += 20;
          const nn = this.fetch16();
          if (q === 0) this.ww(nn, this.getRP(p, 0));
          else this.setRP(p, 0, this.rw(nn));
          this.wz = (nn + 1) & 0xffff;
          return;
        }
        case 4: {                                                // NEG
          this.t += 8;
          const v = this.a;
          this.a = 0;
          this.sub8(v);
          return;
        }
        case 5:                                                  // RETN / RETI
          this.t += 14;
          this.pc = this.pop16();
          this.wz = this.pc;
          this.iff1 = this.iff2;
          return;
        case 6:                                                  // IM n
          // y: 0/4 -> IM 0, 1/5 -> IM 0 (undocumented), 2/6 -> IM 1, 3/7 -> IM 2
          this.t += 8;
          this.im = IM_TABLE[y];
          return;
        default:
          switch (y) {
            case 0: this.t += 9; this.i = this.a; return;         // LD I,A
            case 1: this.t += 9; this.r = this.a & 0x7f; this.r7 = this.a & 0x80; return; // LD R,A
            case 2:                                              // LD A,I
              this.t += 9;
              this.a = this.i;
              this.f = (this.f & C) | SZXY[this.a] | (this.iff2 ? PV : 0);
              return;
            case 3:                                              // LD A,R
              this.t += 9;
              this.a = (this.r & 0x7f) | this.r7;
              this.f = (this.f & C) | SZXY[this.a] | (this.iff2 ? PV : 0);
              return;
            case 4: {                                            // RRD
              this.t += 18;
              const v = this.rb(this.hl);
              this.wb(this.hl, ((v >> 4) | (this.a << 4)) & 0xff);
              this.a = (this.a & 0xf0) | (v & 0x0f);
              this.wz = (this.hl + 1) & 0xffff;
              this.f = (this.f & C) | SZXYP[this.a];
              return;
            }
            case 5: {                                            // RLD
              this.t += 18;
              const v = this.rb(this.hl);
              this.wb(this.hl, ((v << 4) | (this.a & 0x0f)) & 0xff);
              this.a = (this.a & 0xf0) | ((v >> 4) & 0x0f);
              this.wz = (this.hl + 1) & 0xffff;
              this.f = (this.f & C) | SZXYP[this.a];
              return;
            }
            default: this.t += 8; return;                        // NOP
          }
      }
    }

    if (x === 2 && z <= 3 && y >= 4) { this.execBlock(y, z); return; }

    this.t += 8;                                                 // NONI + NOP
  }

  /**
   * Block instructions LDI/LDD/LDIR/LDDR, CPI/CPD/CPIR/CPDR and the I/O
   * variants. The repeating forms re-execute by rewinding PC by two, which is
   * exactly how the hardware makes them interruptible -- Galaxian's NMI can
   * and does land in the middle of the LDIR at .asm:799-802 that blits the
   * sprite back buffer to OBJRAM.
   * @param {number} y 4..7 (I, D, IR, DR)
   * @param {number} z 0..3 (LD, CP, IN, OUT)
   * @returns {void}
   */
  execBlock(y, z) {
    const inc = (y & 1) === 0 ? 1 : -1;     // y 4/6 -> increment, 5/7 -> decrement
    const repeat = y >= 6;
    this.t += 16;

    switch (z) {
      case 0: {                                                  // LDI/LDD/LDIR/LDDR
        const v = this.rb(this.hl);
        this.wb(this.de, v);
        this.hl = (this.hl + inc) & 0xffff;
        this.de = (this.de + inc) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        const nx = (this.a + v) & 0xff;
        this.f = (this.f & (SF | ZF | C))
          | (nx & XF) | ((nx & 0x02) !== 0 ? YF : 0)
          | (this.bc !== 0 ? PV : 0);
        if (repeat && this.bc !== 0) {
          this.pc = (this.pc - 2) & 0xffff;
          this.wz = (this.pc + 1) & 0xffff;
          this.t += 5;
        }
        return;
      }
      case 1: {                                                  // CPI/CPD/CPIR/CPDR
        const v = this.rb(this.hl);
        const r = (this.a - v) & 0xff;
        const half = ((this.a ^ v ^ r) & HF);
        const nx = (r - (half !== 0 ? 1 : 0)) & 0xff;
        this.hl = (this.hl + inc) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        this.f = (this.f & C) | N | (r & SF) | (r === 0 ? ZF : 0) | half
          | (nx & XF) | ((nx & 0x02) !== 0 ? YF : 0)
          | (this.bc !== 0 ? PV : 0);
        if (repeat && this.bc !== 0 && r !== 0) {
          this.pc = (this.pc - 2) & 0xffff;
          this.wz = (this.pc + 1) & 0xffff;
          this.t += 5;
        } else {
          this.wz = (this.wz + inc) & 0xffff;
        }
        return;
      }
      case 2: {                                                  // INI/IND/INIR/INDR
        const v = this.bus.readIo ? this.bus.readIo(this.bc) & 0xff : 0xff;
        this.wz = (this.bc + inc) & 0xffff;
        this.wb(this.hl, v);
        this.b = (this.b - 1) & 0xff;
        this.hl = (this.hl + inc) & 0xffff;
        const k = (v + ((this.c + inc) & 0xff)) & 0x1ff;
        this.f = SZXY[this.b] | ((v & 0x80) !== 0 ? N : 0)
          | (k > 0xff ? (HF | C) : 0)
          | PARITY[(k & 7) ^ this.b];
        if (repeat && this.b !== 0) { this.pc = (this.pc - 2) & 0xffff; this.t += 5; }
        return;
      }
      default: {                                                 // OUTI/OUTD/OTIR/OTDR
        const v = this.rb(this.hl);
        this.b = (this.b - 1) & 0xff;
        this.wz = (this.bc + inc) & 0xffff;
        this.hl = (this.hl + inc) & 0xffff;
        if (this.bus.writeIo) this.bus.writeIo(this.bc, v);
        const k = (v + this.l) & 0x1ff;
        this.f = SZXY[this.b] | ((v & 0x80) !== 0 ? N : 0)
          | (k > 0xff ? (HF | C) : 0)
          | PARITY[(k & 7) ^ this.b];
        if (repeat && this.b !== 0) { this.pc = (this.pc - 2) & 0xffff; this.t += 5; }
        return;
      }
    }
  }
}

export default Z80;
