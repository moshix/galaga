// Copyright 2026 by Moshix
/**
 * The joystick remapping screen.
 *
 * All the DOM in one place, so everything it drives -- the binding model, the
 * capture algorithm, the polling -- stays free of the browser and testable in
 * plain Node. This module is the only part of the input stack that cannot be
 * exercised by `npm test`, which is why it is kept as thin as it is: it reads
 * state, writes text into elements, and forwards button clicks.
 *
 * The markup lives in index.html rather than being built here. A native
 * `<dialog>` is worth more than it looks: `showModal()` gives focus trapping,
 * an inert background, Escape-to-close and a `::backdrop` for free, all of
 * which are easy to implement badly by hand.
 */

import { ACTIONS, describeBinding, assignBinding, DEFAULT_BINDINGS } from './bindings.js';

/** @typedef {import('./gamepad.js').GamepadInput} GamepadInput */

export class RemapUI {
  /**
   * @param {GamepadInput} gamepad
   * @param {Document} [doc]
   */
  constructor(gamepad, doc = document) {
    this.gamepad = gamepad;
    this.doc = doc;
    this.dialog = /** @type {HTMLDialogElement|null} */ (doc.getElementById('remap'));
    this.status = doc.getElementById('remapstatus');
    /** @type {Map<string, HTMLElement>} */
    this.cells = new Map();
    if (this.dialog === null) return;

    for (const row of this.dialog.querySelectorAll('tr[data-action]')) {
      const action = /** @type {string} */ (row.getAttribute('data-action'));
      const cell = /** @type {HTMLElement|null} */ (row.querySelector('[data-bind]'));
      if (cell !== null) this.cells.set(action, cell);
      row.querySelector('[data-set]')?.addEventListener('click', () => this.beginCapture(action));
      row.querySelector('[data-clear]')?.addEventListener('click', () => this.clear(action));
    }

    doc.getElementById('remapdefaults')?.addEventListener('click', () => {
      this.gamepad.cancelCapture();
      this.gamepad.setBindings(DEFAULT_BINDINGS);
      this.say('Back to the default bindings.');
    });
    doc.getElementById('remapcentre')?.addEventListener('click', () => {
      this.gamepad.recalibrate();
      this.say('Centre re-read. Let go of the stick before pressing this.');
    });
    doc.getElementById('remapclose')?.addEventListener('click', () => this.close());
    doc.getElementById('openremap')?.addEventListener('click', () => this.open());

    // Escape: abandon a capture in progress, or close if there is not one.
    this.dialog.addEventListener('cancel', (event) => {
      if (this.gamepad.capture.active) {
        event.preventDefault();
        this.gamepad.cancelCapture();
        this.say('Cancelled.');
        this.refresh();
        return;
      }
      this.gamepad.cancelCapture();
    });

    this.gamepad.onChange = () => this.refresh();
    this.gamepad.onCaptured = (action, binding) => {
      this.gamepad.setBindings(assignBinding(this.gamepad.bindings, action, binding));
      const saved = this.gamepad.persistent ? '' : ' (not saved: storage unavailable)';
      this.say(`${action} is now ${describeBinding(binding)}.${saved}`);
      this.refresh();
    };
  }

  /** @returns {boolean} */
  get isOpen() {
    return this.dialog !== null && this.dialog.open;
  }

  /** @returns {void} */
  open() {
    if (this.dialog === null) return;
    this.refresh();
    this.say(this.gamepad.connected
      ? 'Press "set", then move the control you want.'
      : 'No joystick seen yet. Plug one in and press a button on it.');
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** @returns {void} */
  close() {
    this.gamepad.cancelCapture();
    if (this.dialog !== null && this.dialog.open) this.dialog.close();
  }

  /** @returns {void} */
  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /**
   * @param {string} action
   * @returns {void}
   */
  beginCapture(action) {
    if (!this.gamepad.beginCapture(/** @type {typeof ACTIONS[number]} */ (action))) {
      this.say('No joystick detected. Press a button on it first -- browsers hide '
        + 'a gamepad until it has been used.');
      return;
    }
    this.say(`Move the control for ${action}…`);
    const cell = this.cells.get(action);
    if (cell !== undefined) cell.textContent = 'press…';
  }

  /**
   * @param {string} action
   * @returns {void}
   */
  clear(action) {
    this.gamepad.cancelCapture();
    const next = { ...this.gamepad.bindings, [action]: [] };
    this.gamepad.setBindings(next);
    this.say(`${action} is now unbound.`);
    this.refresh();
  }

  /** Redraw the bound-to column. @returns {void} */
  refresh() {
    for (const action of ACTIONS) {
      const cell = this.cells.get(action);
      if (cell === undefined) continue;
      const list = this.gamepad.bindings[action] ?? [];
      // The shipped defaults list several candidates per action; showing them
      // all is more honest than pretending one of them is "the" binding.
      cell.textContent = list.length === 0
        ? 'unbound'
        : list.map((b) => describeBinding(b)).join(', ');
      cell.classList.toggle('unbound', list.length === 0);
    }
  }

  /**
   * @param {string} text
   * @returns {void}
   */
  say(text) {
    if (this.status !== null) this.status.textContent = text;
  }
}

export default RemapUI;
