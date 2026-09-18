# Galaga (1981), rewritten in JavaScript

Copyright 2026 by Moshix

This is Namco's Galaga running in a browser. It isn't an emulator. Nothing in
here executes Z80 machine code while you play. I went through the original
program routine by routine and rewrote each one in plain JavaScript, and then
built a way to prove the rewrite does exactly what the arcade board does.

It's the second one of these. The first was [Galaxian](../galaxian), and this
one uses the same method on a much bigger machine.

## Running it

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>. There's no build step and nothing to
install. It's plain ES modules served as static files.

| Key | What it does |
|-----|--------------|
| ← → | move |
| Space | fire |
| 5 / 6 | coin (slot 1 / slot 2) |
| 1 / 2 | 1 or 2 player start |
| A | let the computer play |
| P | pause |
| M | sound on/off |
| + / − | zoom |
| G | set up a joystick or gamepad |

Any USB stick or pad works. Press G, then push the control you want for each
action. Cheap sticks report their buttons in whatever order they like, so
there's no fixed layout to guess at.

## So what's different from MAME?

An emulator pretends to be the hardware. MAME builds three Z80s, the custom
chips and the video board in software, loads the ROM files, and lets the
original machine code run. That's the right way to preserve a game, and I
lean on MAME's documentation of the hardware all through this project.

The catch is that with an emulator you never really see the game. You see a
CPU fetching bytes. How the enemies pick their dive paths, how the tractor
beam decides to fire, why the score table in attract mode looks the way it
does: all of that is in there, but only as 24 KB of opcodes.

In this version it's all written out as source code you can read:

* The Galaga board has **three Z80s** sharing RAM. The main one runs the game,
  the second one flies every enemy on screen and does the collision checks,
  and the third one plays the sound. Each one's program is ported to its own
  set of JavaScript modules, one per ROM chip, and each function is named
  after the label of the routine it replaces in the disassembly.
* **The game keeps the original memory map.** There's no `Enemy` class and no
  `Player` object. The formation, the flight paths, the score and the sprite
  list live at the same addresses the 1981 code used. That sounds like a
  strange choice for new code, and it is, but it's what makes the next part
  possible.
* **It's checked against the real thing, byte for byte.** Under `test/` there
  *is* an emulator: three Z80 cores, the shared RAM, the 06xx bus chip and the
  two Fujitsu microcontrollers (51xx for coins and controls, 54xx for the
  explosion noise), all running the actual ROM. The tests run a routine on
  that board and the JavaScript version on the port from the same starting
  state, then require every byte of RAM to match. None of this ships to the
  browser. It's only there to catch me when I get something wrong.

The payoff is that "looks about right" isn't the bar. If a diving butterfly
ends up one pixel off after two hundred frames, a test names the variable
that went wrong and the frame it happened on.

## Things I found along the way

**The random numbers depend on how many instructions ran.** Galaga's random
routine at `$1000` reads the Z80's `R` register. That's a counter the CPU
bumps on every instruction fetch, for DRAM refresh. Its value depends on
exactly how many instructions ran since power-on, and a rewrite has no way of
knowing that. In the browser, `R` comes from a small pseudo-random source with
the same 0-127 range, which you can't tell apart while playing. In the tests,
the harness records the values the real ROM read and feeds them to the port in
the same order, so the comparison stays exact.

**The game reads its own code as data.** The same random routine indexes the
bytes at `$0100-$01FF` as a noise table, and those bytes are the task
manager's own instructions. Another routine that picks bomber timings runs off
the end of its table and into the code after it, both in normal play and for
a few seconds after power-on while RAM still holds test patterns. The port has
the ROM's data tables but not its code, so these two ranges are exported
explicitly, with a note explaining why.

**Two CPUs meet in the middle every frame.** At vblank the main CPU and the
enemy CPU each copy half of the sprite list to the video hardware, then wait
for each other. Only after that does the enemy CPU move anything. Getting
this wrong is subtle: if the port lets the enemy CPU go first, the main CPU
copies positions that have already moved, and nothing looks wrong until the
enemies start diving.

**Three CPUs racing each other is where "byte for byte" runs out.** After
that meeting point the two CPUs really do work at the same time on the same
RAM. Whether an enemy launched this frame gets its first move this frame or
the next depends on which CPU reaches that slot first, and sometimes the
margin is 19 CPU cycles. A rewrite has no cycle clock, so the port runs the
two handlers in a fixed, measured order of task slots. The effect is that the
port is occasionally one frame early or late with something like that, which
you can't see while playing but a byte-for-byte comparison can.

The same goes for time. The vblank handler sometimes runs longer than a
frame (clearing the playfield takes most of one), and then the real board
simply skips the next interrupt and finishes the job in the following frame.
The few routines that are that slow tell the port how long they took, and the
scheduler skips the interrupt, or holds the game flow back, as the board does.
That one took a while to find: game over was happening two frames early.

**There's a leftover bug in the enemy code.** When an enemy clones itself (the
three-way split some of the bees do in later stages), the ROM means to copy a
few bytes of its state to the new one. It adds the wrong register, and the
copy goes to an address in ROM, where it does nothing. The clone just keeps
whatever the previous occupant of that slot left behind. The port does the
same thing on purpose.

## The ROM set

`galaga.rom` is MAME's `galaga` set, "Galaga (Namco rev. B)", as a zip file.
The annotated disassembly I worked from was written for an older revision, so
`tools/gen-listing.mjs` lines up its comments against the rev. B bytes and
generates `reference/galaga-main.asm`, `galaga-sub.asm` and `galaga-sound.asm`.
Every byte in those listings comes from the ROM. The names and comments come
from Glenn Neidermeier's reconstructed source. Where rev. B changed the code,
the listing marks it `[rev B]`.

Graphics, colours, sound waveforms and the program's own data tables are all
pulled out of the ROM by scripts in `tools/`. None of them are typed in by
hand, because nobody can proofread a 4 KB table of hex.

## What's a port and what's still emulated

To be straight about where the line is:

* **Ported:** all three Z80 programs, the 51xx I/O chip's behaviour (checked
  against its real firmware running on an MB88 emulator for thousands of
  frames), and the video pipeline: tiles, sprites, palette and the 05xx
  starfield's shift register.
* **Emulated in the browser:** the two sound chips. The WSG waveform generator
  is simple digital hardware and is reproduced sample for sample from MAME's
  description. The 54xx explosion chip is a microcontroller running its own
  firmware, and I run that firmware on the same MB88 core the tests use. Its
  analogue filter network is an approximation.

## Tests

```sh
npm test                 # everything, about 320 tests
npm run test:oracle      # just the comparisons against the real ROM
node tools/lockstep-run.mjs 20000 --resync --play=3   # a long side-by-side run
node tools/shoot.mjs out.png 1300    # screenshot of the ORIGINAL ROM at frame 1300
```

The headline test is `test/oracle/lockstep.test.mjs`. It powers up the real
ROM and the port together and compares all of RAM after every frame:

* From power-on through the self test, the cross hatch and well into the
  attract demo (about 2,300 frames) the two are identical, apart from a few
  frames where the board is caught halfway through a playfield clear.
* Over longer runs, attract mode and played games with a seeded random
  joystick, the CPU races described above start to show up. The test copies
  the ROM's RAM into the port whenever a difference lasts three frames and
  requires that no difference ever lasts more than five. A race costs a
  frame or two; a real bug keeps coming back right after every copy, and that
  is what the test catches. Today about 2-3% of frames show a short blip.

`tools/shoot.mjs` runs the real ROM on the test board and draws the result
with the port's renderer. If those screenshots look like Galaga, the renderer
is right. If the port's screenshots differ from them, the port is wrong.

## Layout

```
src/machine/   the board as the game code sees it: memory map, latches, 51xx
src/game/      main/ sub/ sound/ -- one module per ROM chip, plus the
               per-frame scheduler and the 06xx bus
src/video/     tilemap, sprites, starfield, palette (generated from PROMs)
src/audio/     WSG synthesis and the 54xx noise chip
src/input/     keyboard / gamepad mux and the remapping dialog
src/ai/        the self-playing mode
test/z80/      the Z80 core and the three-CPU board that runs the real ROM
test/mcu/      the MB88 microcontroller wrappers for the 51xx and 54xx
test/oracle/   routine-by-routine comparisons against the ROM
tools/         disassembly, listing, graphics and sound generators
reference/     listings, symbols, MAME driver sources, the commented source
docs/          porting guide and notes
```

## Credits

* **Glenn A. Neidermeier**, for the reconstructed and commented Galaga source.
  This project would have taken years longer without it.
* **Chris Cantrell** and computerarcheology.com, for the Galaga annotations
  and the write-up of the "no-fire" bug.
* **The MAME team**, for the Galaga driver, the 06xx/51xx/54xx devices, the
  WSG, and R. Hildinger's reverse engineering of the 05xx starfield.
* **Namco**, 1981.

Galaga is a trademark of Bandai Namco. This is a non-commercial study of a
program I love. The game code here is a rewrite, but the graphics, colour
PROMs, sound waveforms, the program's data tables and the 54xx firmware are
generated from the original ROM set and ship with the game, so treat those as
Namco's. The ROM zip itself is not in the repository; the tools and tests
expect it as `galaga.rom` (MAME's `galaga` set). The listing generator also
wants Neidermeier's source next to it:

```sh
git clone https://github.com/neiderm/arcade.git reference/neiderm
```
