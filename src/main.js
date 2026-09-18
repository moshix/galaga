// Copyright 2026 by Moshix
/**
 * Bootstrap: owns the canvas, the frame clock and input routing.
 *
 * The clock is deliberately not "one frame per requestAnimationFrame". The
 * original runs at 60.606 Hz (6.144 MHz pixel clock / (384 * 264)), which no
 * display matches exactly, so we accumulate real elapsed time and run however
 * many whole game frames are due. Game logic therefore always advances in
 * discrete 1/60.606 s steps -- the same steps the Z80 oracle takes --
 * regardless of what the monitor is doing.
 */

import { Machine, FRAME_RATE } from './machine/machine.js';
import { Renderer, SCREEN_WIDTH, SCREEN_HEIGHT } from './video/renderer.js';
import { Scheduler } from './game/scheduler.js';
import { IoBus } from './game/io.js';
import { mainCpu } from './game/main/index.js';
import { subCpu } from './game/sub/index.js';
import { soundCpu } from './game/sound/index.js';
import { Namco51 } from './machine/namco51.js';
import { AutoPlayer } from './ai/autoplay.js';
import { InputMux } from './input/mux.js';
import { GamepadInput } from './input/gamepad.js';
import { MACHINE_INPUT } from './input/bindings.js';
import { RemapUI } from './input/remapui.js';
import { SoundEngine } from './audio/sound.js';

/**
 * Displayed in the corner of the page and the single place this is written
 * down. Bump it here when a feature lands, and keep `package.json` in step.
 */
export const VERSION = '0.2';

const FRAME_MS = 1000 / FRAME_RATE;
/** Never try to catch up more than this after a tab has been backgrounded. */
const MAX_CATCHUP_FRAMES = 4;

/**
 * The controls that count as the player taking the sticks back from the AI.
 * Coin, start and pause are deliberately not in here -- feeding the machine a
 * credit, or freezing it to look at something, should not end the demo.
 */
const TAKEOVER_ACTIONS = /** @type {ReadonlySet<string>} */ (
  new Set(['left', 'right', 'fire'])
);

/** Keyboard to switch mapping. @see reference/mame/galaga.cpp INPUT_PORTS */
const KEY_MAP = /** @type {const} */ ({
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Space: 'fire',
  Digit5: 'coin1',
  Digit6: 'coin2',
  Digit1: 'start1',
  Digit2: 'start2',
});

export class Game {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx === null) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;

    this.machine = new Machine();
    this.renderer = new Renderer();
    // The renderer draws into a Uint32Array; wrap the same buffer in the
    // Uint8ClampedArray that ImageData wants, so presenting copies nothing.
    this.frame = new ImageData(
      new Uint8ClampedArray(this.renderer.pixels.buffer), SCREEN_WIDTH, SCREEN_HEIGHT,
    );

    this.sound = new SoundEngine();
    /** The 51XX: switches, coins and credits, as the 06XX bus sees it. */
    this.n51 = new Namco51();
    this.machine.io = new IoBus(this.machine, {
      n51: this.n51,
      // The 54XX is a noise generator; its commands go to the audio engine.
      n54: { write: (byte) => this.sound.write54xx(byte) },
    });
    this.scheduler = new Scheduler(this.machine, { main: mainCpu, sub: subCpu, sound: soundCpu }, {
      // The 51XX samples the switches and runs its coin timer off vblank.
      onVblank: () => {
        this.n51.setInputs(this.machine.in0, this.machine.in1);
        this.n51.vblank();
      },
    });

    /** Whole game frames elapsed since boot. */
    this.frameCount = 0;
    /** Leftover real time not yet converted into game frames, in ms. */
    this.accumulator = 0;
    /** @type {number | null} */
    this.lastTime = null;
    this.running = false;
    this.aiEnabled = false;
    /** Frozen by the player, with P or the pad. Survives a tab switch. */
    this.paused = false;
    /** Frozen because the tab is not visible; kept apart from `paused`. */
    this.hidden = false;
    /** Last seen state of the pad's pause control, for edge detection. */
    this.padPauseHeld = false;
    /** Last seen state of the pad's fly-the-ship controls, for edge detection. */
    this.padTakeoverHeld = false;
    this.zoom = 2;

    this.ai = new AutoPlayer(this.machine);
    /**
     * Keyboard and gamepad both close the same switches, so they go through a
     * mux rather than writing the ports directly. @see src/input/mux.js
     */
    this.mux = new InputMux((name, down) => this.machine.setInput(
      /** @type {import('./machine/machine.js').InputName} */ (name), down,
    ));
    this.gamepad = new GamepadInput();

    this.scheduler.powerOn();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = null;
    requestAnimationFrame(this.tick);
  }

  stop() { this.running = false; }

  /** @param {number} now milliseconds from requestAnimationFrame */
  tick = (now) => {
    if (!this.running) return;
    if (this.lastTime === null) this.lastTime = now;
    this.accumulator += now - this.lastTime;
    this.lastTime = now;

    // Poll the pad here rather than in stepFrame: pause has to keep working
    // while the simulation is frozen, or the button that paused the game
    // could never unpause it.
    const padActions = this.gamepad.poll();
    this.handlePauseEdge(padActions.has('pause'));
    this.handleTakeoverEdge(padActions);

    if (this.frozen) {
      // Drop the accumulator, or the time spent paused would be owed to the
      // simulation and it would fast-forward the instant it resumed.
      this.accumulator = 0;
      requestAnimationFrame(this.tick);
      return;
    }

    let due = Math.floor(this.accumulator / FRAME_MS);
    if (due > MAX_CATCHUP_FRAMES) {
      // The tab was hidden or the machine stalled: drop the backlog rather
      // than fast-forwarding through it.
      this.accumulator = 0;
      due = 1;
    } else {
      this.accumulator -= due * FRAME_MS;
    }

    for (let i = 0; i < due; i += 1) this.stepFrame(padActions);
    if (due > 0) this.present();

    requestAnimationFrame(this.tick);
  };

  /**
   * Advance the simulation by exactly one 1/60.606 s frame.
   * @param {ReadonlySet<string>} [padActions] this tick's gamepad state
   */
  stepFrame(padActions) {
    this.frameCount += 1;
    // The AI drives the same switches a human does, so it decides before
    // the machine samples its inputs.
    if (this.aiEnabled) this.ai.step();
    else this.mux.setAll('gamepad', toSwitchNames(padActions ?? this.gamepad.poll()));
    this.scheduler.stepFrame();
    // Render every frame, not every display refresh: the starfield
    // generator advances once per video frame, as the 05XX does.
    this.renderer.render(this.machine.video, this.machine.ram1, this.machine.ram2,
      this.machine.ram3, this.machine.videoLatch);
    this.sound.update(this.machine);
  }

  /** True while the simulation is stopped, for either reason. */
  get frozen() { return this.paused || this.hidden; }

  /**
   * Hand the controls back to the player, if the AI had them.
   * @returns {boolean} true if this call actually left AI mode
   */
  takeOver() {
    if (!this.aiEnabled) return false;
    this.setAi(false);
    return true;
  }

  /**
   * End AI mode when a fly-the-ship control is newly pressed on the pad.
   * Edge-triggered: a stick already held when the AI is switched on is a
   * state, not an input.
   * @param {ReadonlySet<string>} padActions
   */
  handleTakeoverEdge(padActions) {
    let held = false;
    for (const action of TAKEOVER_ACTIONS) {
      if (padActions.has(action)) { held = true; break; }
    }
    if (held && !this.padTakeoverHeld) this.takeOver();
    this.padTakeoverHeld = held;
  }

  /** @param {boolean} held */
  handlePauseEdge(held) {
    if (held && !this.padPauseHeld) this.setPaused(!this.paused);
    this.padPauseHeld = held;
  }

  /** @param {boolean} on */
  setPaused(on) {
    if (this.paused === on) return;
    this.paused = on;
    this.applyFrozen();
  }

  /** @param {boolean} on */
  setHidden(on) {
    if (this.hidden === on) return;
    this.hidden = on;
    this.applyFrozen();
  }

  /**
   * Bring sound, the on-screen indicator and the clock in line with the two
   * freeze flags. Only a deliberate pause is announced on screen.
   */
  applyFrozen() {
    const frozen = this.frozen;
    this.sound.setPaused(frozen);
    const hint = document.getElementById('hint');
    if (hint !== null) hint.classList.toggle('paused', this.paused);
    if (!frozen) {
      this.mux.invalidate();
      this.lastTime = null;
      this.accumulator = 0;
    }
  }

  /** @param {boolean} on */
  setAi(on) {
    this.aiEnabled = on;
    // Hand the controls back cleanly, or the last AI input stays held.
    this.ai.release();
    this.mux.clearSource('gamepad');
    this.mux.invalidate();
    const indicator = document.getElementById('ai-hint');
    if (indicator !== null) indicator.classList.toggle('on', on);
  }

  present() {
    this.ctx.putImageData(this.frame, 0, 0);
    // Expose progress on the element itself, so a headless browser can tell
    // a running game from a stalled one.
    this.canvas.dataset.frame = String(this.frameCount);
  }

  /** Handy in the console: `galaga.state()`. @returns {Record<string, number>} */
  state() {
    const m = this.machine;
    return {
      frame: this.frameCount,
      gameState: m.peek(0x9201),
      credits: m.peek(0x99b8),
    };
  }

  /** @param {number} z */
  setZoom(z) {
    this.zoom = Math.max(1, Math.min(6, z));
    this.canvas.style.setProperty('--zoom', String(this.zoom));
  }
}

/**
 * Translate gamepad actions into board switch names, dropping host-only
 * actions such as `pause`.
 * @param {ReadonlySet<string>} actions
 * @returns {Set<string>}
 */
function toSwitchNames(actions) {
  const out = new Set();
  for (const action of actions) {
    const name = MACHINE_INPUT[action];
    if (name !== undefined) out.add(name);
  }
  return out;
}

/** @param {Game} game */
function attachInput(game) {
  /** @param {KeyboardEvent} e @param {boolean} down */
  const handle = (e, down) => {
    if (e.repeat) return;
    // The remap dialog owns the keyboard while it is open.
    if (game.remap?.isOpen === true) {
      if (down && e.code === 'KeyG') { game.remap.close(); e.preventDefault(); }
      return;
    }
    const mapped = KEY_MAP[/** @type {keyof typeof KEY_MAP} */ (e.code)];
    if (mapped !== undefined) {
      // Arrow or fire while the AI is playing means the player has taken
      // over; on the press only, before the switch is applied.
      if (down && TAKEOVER_ACTIONS.has(mapped)) game.takeOver();
      game.mux.set('keyboard', mapped, down);
      e.preventDefault();
      return;
    }
    if (!down) return;
    if (e.code === 'KeyA') {
      game.setAi(!game.aiEnabled);
      void game.sound.start();
      e.preventDefault();
    } else if (e.code === 'KeyG') {
      game.remap?.toggle();
      void game.sound.start();
      e.preventDefault();
    } else if (e.code === 'KeyP') {
      game.setPaused(!game.paused);
      e.preventDefault();
    } else if (e.code === 'KeyM') {
      void game.sound.start().then(() => game.sound.toggle());
      e.preventDefault();
    }
    else if (e.code === 'Equal' || e.code === 'NumpadAdd') game.setZoom(game.zoom + 1);
    else if (e.code === 'Minus' || e.code === 'NumpadSubtract') game.setZoom(game.zoom - 1);
  };
  // Any key is a user gesture, which is what browsers require before audio.
  window.addEventListener('keydown', (e) => { void game.sound.start(); handle(e, true); });
  window.addEventListener('keyup', (e) => handle(e, false));
  document.addEventListener('visibilitychange', () => {
    game.setHidden(document.hidden === true);
  });

  window.addEventListener('gamepadconnected', () => { game.gamepad.recalibrate(); });
  window.addEventListener('gamepaddisconnected', () => {
    game.gamepad.handleDisconnect();
    game.mux.clearSource('gamepad');
  });
  window.addEventListener('focus', () => {
    game.gamepad.enabled = true;
    game.gamepad.recalibrate();
  });
  window.addEventListener('blur', () => {
    game.gamepad.enabled = false;
    // Open every switch: a key held while focus leaves never sends keyup.
    game.mux.reset();
    game.machine.in0 = 0xff;
    game.machine.in1 = 0xff;
  });
}

/**
 * Optional warm-up from the URL, for headless screenshots:
 * `?frames=N` steps N frames synchronously; `&coin=1&start=1` feeds a credit
 * and a start press on the way.
 * @param {Game} game
 */
function applyUrlWarmup(game) {
  const params = new URLSearchParams(location.search);
  const frames = Number.parseInt(params.get('frames') ?? '', 10);
  if (!Number.isFinite(frames) || frames <= 0) return;

  /** @param {import('./machine/machine.js').InputName} name */
  const tap = (name, held = 4, released = 12) => {
    game.machine.setInput(name, true);
    for (let i = 0; i < held; i += 1) game.stepFrame();
    game.machine.setInput(name, false);
    for (let i = 0; i < released; i += 1) game.stepFrame();
  };

  const coinAt = Number.parseInt(params.get('coinAt') ?? '', 10);
  const before = Math.min(frames, params.has('coin') ? (Number.isFinite(coinAt) ? coinAt : frames) : frames);
  for (let i = 0; i < before; i += 1) game.stepFrame();
  if (params.has('coin')) tap('coin1');
  if (params.has('start')) tap('start1');
  for (let i = before; i < frames; i += 1) game.stepFrame();
  if (params.has('ai')) game.setAi(true);
  game.present();
}

/** Stamp the version into the corner of the page. */
function showVersion() {
  const el = document.getElementById('version');
  if (el !== null) el.textContent = `version ${VERSION} · code by Moshix`;
}

const canvas = /** @type {HTMLCanvasElement | null} */ (document.getElementById('screen'));
showVersion();

if (canvas !== null) {
  const game = new Game(canvas);
  game.setZoom(2);
  game.remap = new RemapUI(game.gamepad);
  attachInput(game);
  applyUrlWarmup(game);
  game.start();
  // Handy for headless tests and for poking at things in the console.
  Reflect.set(globalThis, 'galaga', game);
}
