# The self-playing AI

`src/ai/` is a *controller*, not a cheat. It reads the game's state from RAM,
but its only outputs are the switches a human has: left, right and fire
(plus coin and start, to begin a game when none is running). It cannot move
the fighter faster than the game moves it (1 and 2 pixels on alternate
frames), cannot fire more often than the 51XX reports presses or while two
rockets are in flight, and dies to exactly the same hit boxes. Press `A`.

It plays to survive first and score second, and it goes for the dual
fighter the way a good player does.

    src/ai/autoplay.js   arbitration: the switches, fire policy, dual fighter
    src/ai/threats.js    the only file that reads the machine: RAM -> world
    src/ai/flight.js     the sub CPU's flight-path interpreter, replayed
    src/ai/paths.js      bombs, divers, the fighter and its rockets, forward
    src/ai/evade.js      the danger map and the escape search
    src/ai/aim.js        where to stand to shoot, and whether to shoot
    src/ai/constants.js  hit boxes, speeds, latencies, weights -- each traced
    tools/ai-bench.mjs   play N games headlessly and report how it did

The AI needs only `peek(addr)` for $8000-$9BFF and `setInput(name, down)`.
The port's `Machine` and the oracle board (`test/z80/machine.mjs`) both have
them, so the same AI plays the original ROM and the port. The one thing it
takes from outside RAM is the flight-path *data* in the sub ROM, which it
reads from the generated `src/game/romdata.js` -- the same knowledge a human
acquires by watching the attack patterns.

## How it plays

* **A diver's flight is computable.** Galaga's aliens do not fall in a line:
  the sub CPU flies each one along a path in ROM -- (speed, turn rate,
  duration) segments and commands -- turning by up to 20 degrees a frame.
  Extrapolating the current velocity is wrong within a handful of frames.
  But the motion-queue slot at $9100 holds the position, heading, speed and
  a pointer into the path, so `flight.js` runs the same interpreter
  (f_08D3, galaga-sub.asm $08D3-$0E5E) on a private copy of the slot. The
  oracle test checks it step for step against the real ROM: 22,631 of 22,642
  predicted steps are byte-identical (the rest are frames on which the main
  CPU itself rewrites a slot). Bombs (f_1EA4) are predicted exactly, with the
  sideways rate's remainder.
* **The sub CPU's work straddles the frame boundary.** On the emulated
  board, the motion runner is still going when a frame ends, so some slots
  have had this frame's step and some have not. Its loop counter lives in
  RAM ($9289), which says which is which, and so which frame parity (speed
  +0A or +0B) each slot's next step uses. That is the difference between
  "exact" and "a frame out, most of the time".
* **Danger is a span of frames.** Everything that kills is painted into a
  map: for each of the next 64 frames, which fighter positions are lethal,
  with one bit per threat. Every reachable target is then tried by
  simulating the controller walking there -- the real 1-2-1-2 step logic,
  the pause that lands exactly instead of overshooting, and the inputs
  already on their way -- and the plan that survives longest wins. When
  nothing survives, the least-bad plan still wins, which is what walks the
  fighter out of a hopeless spot instead of freezing in it.
* **The latency is measured, not assumed.** The stick moves the fighter two
  frames after it is closed on the emulated board (stepped a whole video
  frame at a time), and one frame after on the port (whose frame ends with
  every interrupt handler finished). The AI checks every frame which
  latency explains the fighter's last step and uses that one. Planning with
  the wrong one was the main cause of the shaking seen in the browser.
* **Shoot your way out.** The last aliens of a stage never stop diving, so
  an AI that only dodges can dodge for ever and never finish the stage. A
  plan that runs into a diver gets a second look: could a rocket fired from
  that plan kill it first? If so, the diver's cells after the impact do not
  count. The per-threat bits make that question cheap.
* **Fire only at something.** A rocket is fired when, from where the plan
  puts the fighter on the frame the rocket appears, it will meet a target's
  predicted position (for both possible first-frame phases of the rocket).
  Formation aliens are led by their measured drift. The aim map -- the value
  of standing at each x -- breaks ties between equally safe spots.
* **Stay off the walls.** Nearly every loss in the long runs happened
  against a side wall: bombs are aimed at the fighter, and at a wall it can
  only get away in one direction, across their path. Room from the walls is
  now worth more than any single shot.
* **No shaking.** Targets are held until another is clearly better (more
  so if reaching it means turning round), a better plan must live a few
  frames longer to be believed, a target within 2 px is not worth a move,
  and the stick does not reverse within 16 frames of the last reversal --
  unless the current course runs into something within 12 frames, when the
  fighter may turn as sharply as the stick allows.

### The dual fighter

With a reserve fighter to spare (`$9820 >= 1`) and a single ship, the AI
wants to be captured: while a capture boss dives to its spot or beams, the
beam is not painted as a threat, standing under it is worth more than any
shot, and the capture boss is not shot. Once our fighter is held (an object
$00-$06 whose sprite colour is 7, riding the boss at $30 + that object):

* the captive is never shot (hitting it destroys it for good);
* its boss is not shot at home -- a boss killed in the formation leaves the
  captive behind as an enemy -- but is the most valuable target on the
  screen while it and the captive dive together, which is when a kill frees
  the fighter (l_081E tests the captive for status 9);
* no rocket is fired if it could pass within 8 px of the captive before
  the intended target stops it.

The freed fighter spins down and docks ($901D, then $9827 = 1). As a dual
fighter, or with no reserve, every beam is avoided: a capture then would
cost half the dual fighter, or the game. The hit box of the dual fighter is
15 px wider, which is folded into the danger map. `new AutoPlayer(machine,
{ dualFighter: false })` (bench: `--no-dual`) avoids every beam instead.

## RAM it relies on

| address | meaning |
|---|---|
| $9201 | game state: 1 attract, 2 credit in, 3 playing |
| $99B8 | credits |
| $9014 / $9015 | joystick (and collision) task / fire task running: fighter live |
| $9362 | fighter x (buffer); $9360 is the dual fighter's second ship, x + $0F |
| $92A3 | fighter step flag (1-2-1-2 phase) |
| $9827 | dual fighter |
| $9820 | reserve fighters (falls by one per loss) |
| $9821 / $9825 | stage / 0 on a challenging stage |
| $9008 | attack wave being launched (only transients $38-$3E collide) |
| $92A0 | frame counter: speed and bomb-fall parity |
| $9289 | motion runner's slots still to go this IRQ |
| $9100 + 20n | motion queue: 12 slots, position, heading, speed, path, bomb timer |
| $8800 + L | object status: 1 home, 2 settling, 3 convoy, 9 diving, 6 bomb, $80 free |
| $9300 + L, $9301 + L, $9B01 + L bit 0 | sprite x, y low bits, y bit 8 |
| $8B00 + L / $8B01 + L | sprite code / colour ($30 bomb, colour 7 captured fighter) |
| $9200 + L | hit notification (bit 7: already hit) |
| $9364 / $9366 | the two rockets' x (0: free) and y at +1 |
| $92B0 + 2n / + 1 | bomb n's sideways rate and remainder |
| $9019 / $9018 | capture boss diving to its spot / beam running |
| $928A / $928B / $928C / $982A | beam column / beam state ($40 fully out) / step timer / step period |
| $9828 | capture boss object |
| $901C / $901D | fighter being pulled up / rescued fighter docking |
| $99C8, $99C9, $92AA, $901D, $92C8, $92E2, $9800-$981F, $9900-$991F | flight-path command inputs |
| $83F8-$83FE | player 1 score digits (benchmark only) |

## How well it plays

`node tools/ai-bench.mjs` plays complete games headlessly on the **oracle**:
the original ROM on the emulated three-Z80 board. `--target=port` runs the
JavaScript port instead. Runs differ by how long attract mode runs before the
coin goes in, which changes every random draw of the game (the ROM mixes the
Z80's refresh register into its random numbers); run n is always the same
game.

Twelve games per policy, capped at 100,000 frames (27.5 minutes of play):

| on the oracle, 12 games | dual fighter (default) | `--no-dual` |
|---|---:|---:|
| frames survived (median) | 100,001 * | 100,001 * |
| stage reached (median) | 56.5 | 57 |
| score (median) | 594,630 | 578,165 |
| fighters lost per game | 4.33 | 0.50 |
| of which captures, on purpose | 4.00 | 0 |
| rescues per game | 3.17 | 0 |
| frames as the dual fighter, per game | 20,346 (20.3%) | 0 |

\* every game hits the benchmark's frame cap: the real figure is unknown.
It stops because the harness stops, not because the fighter runs out. In
earlier runs of 300,000 frames (83 minutes) every game was still going too.

The port (`--target=port`, same 12 games, same cap) agrees: every game
capped, median stage 59, median score 623,295 (dual) and 630,130
(`--no-dual`); 2.0 captures, 1.9 rescues and 11.8% of play as the dual
fighter per game, and no fighter lost to a hit at all without it.

A capture is a lost fighter by design, so the dual policy's "lost" column
is mostly the price of the dual fighter: 0.33 fighters per game are lost to
hits, against 0.50 without it. Three captures in four are converted into a
dual fighter (38 of 48); why the other quarter is lost has not been
investigated. A dual fighter losing one of its halves is not counted as a
loss; a dual fighter lasts about 6,400 frames (three or four stages) on
average, and the AI then goes for a capture again. The dual fighter's double rockets
are worth about 3% in score.

It costs about 0.06 ms of the 16.5 ms frame.

### The shaking, before and after

Reversals of the fighter's direction per 1000 frames under control, and how
many of those came within 6 frames of the previous one (the visible shake):

| | before | after |
|---|---:|---:|
| oracle: reversals per 1000 frames | 75.0 | 20.6 |
| oracle: of which within 6 frames | 50.7 | 0.02 |
| port: reversals per 1000 frames | 313.1 | 20.2 |
| port: of which within 6 frames | 289.4 | 0.0 |

On the port -- the browser -- the old AI planned with the oracle's two-frame
latency against a one-frame game, overshot every target and turned back:
a reversal every three frames. Measuring the latency took that to the
oracle's level; the commitment rules took both to one reversal every
second or so, and none in quick succession. Survival did not suffer: the
old AI lost 0.78 fighters per 100,000 frames on the oracle (28 in twelve
300,000-frame games), the new one without captures 0.50.

### Tried and dropped

* **Bombs not yet dropped.** Every diver's bomb timer is in its slot, and
  replaying it predicts every real drop (841 of 841 checked, with 22% false
  alarms when all eight bomb objects are busy); the aim at the fighter is
  exact too. But a plan in this search walks to a spot and *stops*, so a
  bomb aimed at where it stops always "hits" it, and every plan looked
  doomed. Losses doubled; it was taken out. Doing it properly needs plans
  that react after the drop.
* **The turn limit inside the search.** Making "no second reversal within
  16 frames" a hard constraint on the plans, rather than a check on the
  stick, kept the fighter on courses the search already knew were doomed:
  losses more than doubled on the oracle.
* **Capping the "too close" penalty** to stop it pushing the fighter to the
  walls made things worse; making the walls themselves expensive worked.

### Open questions

* The dual fighter pays for itself in score, not in survival: each capture
  costs a reserve, and the wider fighter loses a half sooner than a single
  fighter loses its life. Games still reach the frame cap.
* The port's runs vary less than the oracle's (its random numbers repeat
  across pre-rolls), so its averages rest on fewer distinct games.
* All the numbers are for player 1 on an upright cabinet; the flipped
  cocktail screen is not modelled.
