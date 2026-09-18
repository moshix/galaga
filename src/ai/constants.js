// Copyright 2026 by Moshix
/**
 * Everything the AI believes about the game, in one place, each value traced
 * to where it came from.
 *
 * Almost none of these are tuning knobs. The hit boxes are read out of the
 * sub CPU's collision code, the movement numbers out of the main CPU's
 * joystick task, and the latencies were measured on the original ROM running
 * on the emulated board. The handful that are judgement calls say so.
 *
 * COORDINATES are the game's own, the ones in the sprite buffers:
 *   x = $9300+L          horizontal, increasing to the right. The fighter
 *                        ranges over $11..$E2.
 *   y = $9301+L | bit 0 of $9B01+L << 8
 *                        9-bit vertical, increasing downwards. The fighter
 *                        sits at y = $129.
 * Objects are indexed by an even offset L: $00-$5E aliens, $60/$62 the
 * fighters, $64/$66 the rockets, $68-$76 the bombs.
 */

// ------------------------------------------------------------- the fighter

/** Fighter y (9 bits): the row everything is tested against. */
export const FIGHTER_Y = 0x129;
/** Fighter y<8:1>, the resolution of the collision test. */
export const FIGHTER_YH = FIGHTER_Y >> 1;

/**
 * Horizontal limits, from f_1F85 (galaga-main.asm $1FB8-$1FD8): a move right
 * is refused once x >= $E1 ($D1 for the dual fighter), a move left once
 * x < $12. A move that is allowed can overshoot by the step size, so the
 * reachable range is a little wider than the tests.
 */
export const X_MIN = 0x11;
export const X_MAX = 0xe2;
export const X_MAX_DUAL = 0xd2;
export const RIGHT_LIMIT = 0xe1;
export const RIGHT_LIMIT_DUAL = 0xd1;
export const LEFT_LIMIT = 0x12;

/**
 * The dual fighter's second ship sits this far right of the first: f_1F85
 * writes $9360 = $9362 + $0F after every move.
 */
export const DUAL_OFFSET = 0x0f;

/**
 * Frames between closing a switch and the fighter reacting to it: the input
 * set before frame t moves the fighter on frame t+2 (the 51XX samples, the
 * main CPU reads its report a frame later). Measured on the oracle: a model
 * with this delay predicts 1114 of 1115 random moves exactly, the one miss
 * being the unknown step phase at the start.
 */
export const MOVE_DELAY = 2;

// ------------------------------------------------------------ the rockets

/**
 * Fire is a press, not a level: the 51XX reports one "fire" event per press,
 * and only if the switch was held for at least two frames and released for
 * at least two before it (measured). In the AI's frame index (k = 1 is the
 * frame the press is made on) the rocket is first seen at k = 4, at the
 * fighter's x on that same frame, and at y $129 or $123 depending on which
 * CPU got there first.
 */
export const FIRE_HOLD = 2;
export const FIRE_RELEASE = 2;
export const FIRE_DELAY = 4;
/** Rockets climb this many pixels a frame (rckt_man, galaga-sub.asm $0704). */
export const ROCKET_SPEED = 6;
/**
 * Rocket vs alien, from l_076A (galaga-sub.asm): alien y<8:1> minus rocket
 * y<8:1> in -3..+2, alien x minus rocket x in -5..+5.
 */
export const ROCKET_HIT_DX = 5;
export const ROCKET_HIT_DYH_LO = -3;
export const ROCKET_HIT_DYH_HI = 2;
/** Two rockets at most, $9364 and $9366; x = 0 marks a free one. */
export const ROCKET_SLOTS = [0x64, 0x66];

// ------------------------------------------------------- what kills the ship

/**
 * Fighter vs alien or bomb, from hitd_det_fghtr (galaga-sub.asm $06B7):
 * `(x - fx - 7) & $FF + $0D` carries for x - fx in -6..+6, and
 * `(yh - fyh - 4) & $FF + 7` for yh - fyh in -3..+3, yh being y<8:1>.
 */
export const HIT_HALF_X = 6;
export const HIT_HALF_YH = 3;

/**
 * Margins on top of the hit box.
 *
 * TIME: the sub CPU's IRQ work runs across the frame boundary, so the state
 * the AI samples can be a frame either side of the one the collision test
 * will see. Every threat is therefore treated as lethal over its positions
 * one frame before and after (see paths.js), which costs a pixel or two of
 * width and removes a whole class of "it was exact but a frame late" deaths.
 * SPACE: one pixel of rounding on each side; the fixed-point positions and
 * the bomb remainders are exact, but the formation drift is not.
 */
export const MARGIN_X = 1;

/**
 * The tractor beam catches the fighter while it is fully out ($928B = $40)
 * if `(beamX - fx + $1B) & $FF < $36` (l_233D, galaga-main.asm), i.e. fx in
 * beamX-$1A .. beamX+$1B.
 */
export const BEAM_LEFT = 0x1a;
export const BEAM_RIGHT = 0x1b;
/** Extra room kept from the beam; it is visible long before it is lethal. */
export const BEAM_MARGIN = 6;

// --------------------------------------------------------------- the bombs

/**
 * Bombs (f_1EA4, galaga-main.asm $1EA4) fall 2 or 3 pixels a frame -- 2 plus
 * bit 0 of the frame counter $92A0 -- and drift sideways by (rate & $7E)/32
 * pixels a frame with the remainder carried in $92B1+2n, bit 7 of the rate
 * giving the direction.
 */
export const BOMB_FIRST = 0x68;
export const BOMB_COUNT = 8;
export const BOMB_RATES = 0x92b0;
export const BOMB_CODE = 0x30;

// ------------------------------------------------------------ decision making

/**
 * How far ahead to look. The fighter covers 1.5 px a frame, so 64 frames is
 * 96 px -- nearly half the playfield; anything further off can be answered
 * later. It is also comfortably longer than any bomb's fall from the lowest
 * row a bomb can be dropped from.
 */
export const HORIZON = 64;

/** Most flying aliens at once: the motion queue has 12 slots. */
export const MOTION_SLOTS = 12;
export const MOTION_QUEUE = 0x9100;
export const MOTION_SLOT_SIZE = 0x14;

/**
 * Score weights. Survival (frames until the plan is first hit) is multiplied
 * by enough to dominate everything else together, so the other terms only
 * separate equally survivable plans -- which is what keeps them from needing
 * careful tuning.
 */
export const W_SURVIVAL = 1000;
/** Per lethal frame after the first: fewer is better even when all die. */
export const W_HITS = 50;
/** Per frame spent inside the soft margin around a threat. */
export const W_NEAR = 40;
/** Per pixel of travel: prefer the nearer of two equal spots. */
export const W_COST = 0.2;
/** Room from the walls, capped: walk off a wall, but no need for the middle. */
export const W_ROOM = 12;
export const ROOM_CAP = 24;
/** Being under something worth shooting. */
export const W_AIM = 200;
/**
 * Commitment (evade.js chooseMove). A bonus for keeping last frame's
 * target; the margin another target must beat it by, and more if reaching
 * it means turning round. These are what stop the fighter shaking between
 * two near-equal spots; W_AIM is the scale they are measured against.
 */
export const W_HOLD = 30;
export const HOLD_MARGIN = 10;
export const REVERSE_MARGIN = 20;
/**
 * A safer plan must live this many frames longer to be worth a change of
 * mind -- unless it lives through the whole horizon, or the current plan
 * dies within URGENT_FRAMES, when any gain counts and a sharp turn (even a
 * reversal on consecutive frames) is allowed.
 */
export const SAFETY_GAIN = 6;
export const URGENT_FRAMES = 12;
/** A target this close to where the fighter stands is not worth a move. */
export const DEAD_BAND = 2;

/** Soft margin, in pixels, around every threat. */
export const NEAR_MARGIN = 6;
