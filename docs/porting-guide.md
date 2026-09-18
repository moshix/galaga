# Porting guide — how the Galaga ROM becomes JavaScript

This is the contract every module of the port follows. It exists so several
people can port different parts of the ROM at once and the parts still fit.

## 0. The goal

The browser game is the 1981 program **re-implemented routine by routine in
JavaScript** — not emulated. Every routine of the three Z80 programs gets a JS
function that does the same thing to the same memory. Game state lives at the
addresses the original used, in `Machine.mem` (`src/machine/machine.js`), so a
test can run the real ROM on the emulated board (`test/z80/machine.mjs`) next
to the port and demand that **every byte of RAM matches**.

Fidelity is the whole point. "Plays about the same" is a failure; "the RAM is
identical after 10,000 frames" is the bar.

## 1. Sources of truth, in order

1. **`reference/galaga-main.asm`, `galaga-sub.asm`, `galaga-sound.asm`** —
   generated from `galaga.rom` (the rev. B set) by `tools/gen-listing.mjs`.
   Every byte is real. Labels and comments are Neidermeier's (for the older
   galagao revision) aligned onto rev. B; `[rev B]` marks code he never saw.
   **The bytes win over any comment.** If a comment and the code disagree,
   the code is right.
2. **`reference/neiderm/galag/galagao_ASxxx/rom0/*.s`** — the fully commented
   source the labels came from. Great for *meaning*; its addresses are
   galagao's, and a few routines differ in rev. B.
3. **`reference/symbols.json`** — every label with its rev. B address
   (`main`, `sub`, `sound`) and every RAM variable (`ram`).
4. `reference/computerarcheology/` — a third, Midway-set annotation.
5. `reference/mame/` — the hardware.

## 2. Where code lives

| CPU / ROM range            | Module (import side effects register routines) |
|----------------------------|-----------------------------------------------|
| main `$0000-$0FFF` gg1_1b  | `src/game/main/gg1_1.js` (+ helper files)     |
| main `$1000-$1FFF` gg1_2b  | `src/game/main/gg1_2.js`                      |
| main `$2000-$2FFF` gg1_3   | `src/game/main/gg1_3.js`                      |
| main `$3000-$3FFF` gg1_4b  | `src/game/main/gg1_4.js`                      |
| sub  `$0000-$0FFF` gg1_5b  | `src/game/sub/gg1_5.js`                       |
| sound `$0000-$0FFF` gg1_7b | `src/game/sound/gg1_7.js`                     |

A module may split itself into more files, but the file in the table is the
one that registers everything for its range.

## 3. Names, and calling routines in other modules

* **A routine's JS name is its label in the listing**, exactly:
  `c_sctrl_sprite_ram_clr`, `f_0828`, `j_Game_init`. A routine with no label
  (rev. B code, or an unnamed entry point) is `sub_XXXX` with its rev. B
  address in upper-case hex. JSDoc on every routine gives the rev. B address
  (`@see galaga-main.asm $0828`), what it does, its inputs and outputs.
* **Cross-module calls go through the routine tables**, never through a direct
  `import` of another module's function. Each CPU has a leaf module:

  ```js
  // src/game/main/routines.js (also sub/routines.js, sound/routines.js)
  export const MAIN = {};     // name    -> function
  export const MAIN_AT = {};  // address -> function, for jump tables
  ```

  Every module registers what it defines at load time:

  ```js
  import { MAIN, MAIN_AT } from './routines.js';
  Object.assign(MAIN, { f_0827, f_0828, c_sctrl_sprite_ram_clr });
  Object.assign(MAIN_AT, { 0x0827: f_0827, 0x0828: f_0828 });
  ```

  and calls others as `MAIN.c_1234(m, { hl: 0x8800 })`. This lets modules be
  written in parallel: a routine that doesn't exist yet fails only when
  called, not when the file is imported.
* **`MAIN_AT` must contain every routine reached indirectly** — through a
  task table (`$0096`), a `jp (hl)` jump table, or a pointer stored in RAM or
  ROM data. Dispatchers look the address up there, the way the Z80 would.
  Directly-called routines may be added too; it never hurts.

## 4. Calling convention

* Every routine takes the machine first: `(m, regs)`.
* **Register inputs arrive as one object** named after the Z80 registers the
  routine reads before writing: `{ a, b, c, d, e, h, l, bc, de, hl, ix, iy }`.
  Use pairs (`hl`) unless the routine really treats the halves separately.
* **Register outputs are returned as an object** with the registers (and
  flags) any caller uses afterwards: `return { a, hl, cf: true, zf: false }`.
  `cf` is carry, `zf` is zero. Look at the callers in the listing to see
  what they consume; return everything any caller reads. If nothing is
  consumed, return nothing.
* Internal helpers private to one module may use any signature.

## 5. Memory

* `m.peek(addr)`, `m.poke(addr, v)`, `m.peek16`, `m.poke16` — RAM and I/O as
  the CPU sees it (`$6800-$6807` reads dip switches, `$6820` etc. are latches).
* `m.read(cpu, addr)`, `m.read16(cpu, addr)` — through a pointer that may be
  ROM (`< $4000`, that CPU's ROM) or RAM. `cpu` is `'main' | 'sub' | 'sound'`.
* ROM data: `import { mainRom, subRom, soundRom, romByte, romWord } from
  '../romdata.js'`. **Read tables at their ROM addresses**, don't copy them into
  arrays by hand. Code bytes are not in romdata and reading one throws.
* `m.ldir(dst, src, count, cpu)` and `m.fill(addr, value, count)` for block ops.
* **Write every byte the Z80 writes, in the same order, including
  temporaries and scratch variables in RAM.** RAM is compared byte for byte.
  The only RAM that is exempt is the Z80 stacks (`$9030-$90FF`, `$9AE0-$9AFF`):
  the port has no stack, so a `push`/`pop` is just a JS local.
* Keep Z80 arithmetic exact: 8-bit wraps (`& 0xff`), 16-bit wraps, carries
  into the next instruction, `daa` BCD, signed displacements, `rlca` vs `rla`.
  When a routine relies on a flag left over from an earlier instruction,
  reproduce it deliberately and comment why.

## 6. Interrupts, waiting, and generators

`src/game/scheduler.js` runs one frame as: sound NMI (line 64), sound NMI
(line 192), vblank IRQs (sub handler, then main handler), then each CPU's
foreground until it waits.

* **Interrupt handlers and the tasks they call are plain functions** that run
  to completion.
* **Foreground code is a generator.** Where the Z80 loops waiting for an
  interrupt handler to change something (a frame timer, a flag), the port
  `yield`s once per iteration:

  ```js
  // 0x2F24: ld a,($9AA0) / and a / jr nz,$2F24
  while (m.peek(0x9aa0) !== 0) yield;
  ```

  `yield SPIN` (from scheduler.js) instead of `yield` when the loop waits on
  *another CPU's foreground* (boot handshakes), so the wait resolves within
  the frame.
* **Calling a routine from foreground code**: if it might wait (anywhere down
  its call tree), it must be a generator and be called with `yield*`. When
  calling a routine owned by another module from a generator, always use the
  helper, which works whether or not the callee is a generator:

  ```js
  import { call } from '../call.js';
  const out = yield* call(MAIN.c_1234, m, { hl });
  ```
* `di`/`ei` in foreground code: `m.di()` / `m.ei()`. Enabling interrupts can
  run a pending IRQ handler immediately, as on the Z80.
* A busy loop that burns time without waiting on anything (delay loops, the
  RAM test) must `yield` once for every frame the real Z80 spends in it. Get
  that number from the oracle (run it and count frames), and comment it.

## 7. The 06XX I/O chips

Don't poke `$7000`/`$7100` to talk to the 51XX/54XX. Use `IoBus.transfer`
(`src/game/io.js`), which performs a whole NMI-driven transfer at once:
`io.transfer(0x71, 0x99b5, 3)` is the per-frame switch read. The bus is
`m.io` (set up by the host). `c_io_cmd_wait` ($37F6, spin until `$7100` reads
`$10`) therefore never waits in the port.

## 8. Testing

Every module ships tests in `test/oracle/<module>.test.mjs` that run the real
ROM routine and the JS routine from the same state and compare:

```js
import { makeOracle, callRoutine, loadState, diffRam } from '../helpers/oracle.mjs';
import { Machine } from '../../src/machine/machine.js';
import '../../src/game/main/index.js';           // registers every routine
import { MAIN } from '../../src/game/main/routines.js';

const board = makeOracle();
const m = new Machine();
// ... set up identical state in both (poke both, or loadState(m, board))
const regs = callRoutine(board, 0, 0x1234, { hl: 0x8800, af: 0x0500 });
const out = MAIN.c_1234(m, { hl: 0x8800, a: 0x05 });
assert.deepEqual(diffRam(board, m), []);
assert.equal(out.a, regs.af >> 8);
```

Prefer many states over one: randomised-but-seeded RAM contents, every branch
of the routine. A routine test that only exercises the happy path proves
little. `node --test test/oracle/<file>` must pass before a module is done.

## 9. Style

* First line `// Copyright 2026 by Moshix`, JSDoc on every export.
* Comment the *why*, and anything a reader of the asm would trip on. Quote the
  instruction when the JS is non-obvious (`// 0x1A3F: rrca -- carry into bit 7`).
* Explain complex logic with comments. No TypeScript `any` in JSDoc.
* Plain ES modules, no dependencies, no build step. Node >= 20 for tests.
* Anything printed to a text console must stay within 79 columns.
