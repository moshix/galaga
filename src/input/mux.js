// Copyright 2026 by Moshix
/**
 * Merging two input sources onto one set of switches.
 *
 * The board has no notion of *who* closed a switch, and neither does
 * `Machine.setInput` -- it just sets or clears a port bit. That is fine while
 * the keyboard is the only input, because a key event is an *edge*: keydown
 * closes the switch, keyup opens it, and nothing ever re-asserts a switch that
 * is already closed.
 *
 * A gamepad cannot work that way. The Gamepad API has no events for button
 * state; you read the whole device once per frame. So the gamepad necessarily
 * asserts both "pressed" and "not pressed" every single frame, and a naive
 * `setInput('left', false)` sixty times a second would stamp on a left arrow
 * the player is holding down on the keyboard.
 *
 * This is the fix, and it is the only place in the port that knows two humans'
 * worth of input can exist at once: each source owns a *set* of names it is
 * currently holding, and the switch is closed if ANY source holds it. Releases
 * only reach the machine when no source holds the name any more, so a source
 * can re-assert its full state as often as it likes for free.
 *
 * Deliberately knows nothing about `Machine`, the DOM, or what a "source" is --
 * it takes a callback and a pair of strings, which is what makes it testable in
 * plain Node.
 */

/**
 * Switch names this can carry. These are exactly the names
 * `Machine.setInput` accepts; the mux does not validate them, it only routes.
 * @typedef {'coin1'|'coin2'|'left'|'right'|'fire'|'start1'|'start2'
 *          |'p2left'|'p2right'|'p2fire'|'test'|'service'|'cocktail'} InputName
 */

export class InputMux {
  /**
   * @param {(name: InputName, down: boolean) => void} apply called only when a
   *   switch actually changes state
   */
  constructor(apply) {
    /** @type {(name: InputName, down: boolean) => void} */
    this.apply = apply;
    /**
     * Held names per source. A source with nothing held keeps an empty set
     * rather than being deleted, which costs nothing and keeps `flush` simple.
     * @type {Map<string, Set<InputName>>}
     */
    this.sources = new Map();
    /**
     * What we last told `apply` about. This is a *cache*, not the truth: if
     * something else writes the ports behind our back -- which the AI does,
     * every frame -- it goes stale and {@link invalidate} is how you say so.
     * @type {Set<InputName>}
     */
    this.applied = new Set();
  }

  /**
   * @param {string} source
   * @returns {Set<InputName>}
   */
  sourceSet(source) {
    let set = this.sources.get(source);
    if (set === undefined) {
      set = new Set();
      this.sources.set(source, set);
    }
    return set;
  }

  /**
   * One edge from one source. This is the keyboard's shape.
   * @param {string} source
   * @param {InputName} name
   * @param {boolean} down
   * @returns {void}
   */
  set(source, name, down) {
    const set = this.sourceSet(source);
    if (down) set.add(name);
    else set.delete(name);
    this.flush();
  }

  /**
   * Replace everything a source holds. This is the gamepad's shape: it knows
   * its whole state each frame and does not track edges itself.
   * @param {string} source
   * @param {Iterable<InputName>} names
   * @returns {void}
   */
  setAll(source, names) {
    const set = this.sourceSet(source);
    set.clear();
    for (const name of names) set.add(name);
    this.flush();
  }

  /**
   * Drop a source entirely, releasing only the switches no other source holds.
   * Used when a gamepad is unplugged.
   * @param {string} source
   * @returns {void}
   */
  clearSource(source) {
    this.sources.delete(source);
    this.flush();
  }

  /**
   * Forget everything, including what we believe is applied, without emitting.
   *
   * For the `blur` handler, which zeroes both port bytes by hand: the switches
   * are already open, so emitting releases would be redundant, but our cache
   * has to agree with reality or the next press would look like a no-op.
   * @returns {void}
   */
  reset() {
    this.sources.clear();
    this.applied.clear();
  }

  /**
   * Keep the source sets but forget what has been applied, so the next
   * {@link flush} re-asserts everything currently held.
   *
   * This exists for the self-playing AI, which writes `setInput` directly and
   * clears the controls every frame. When control comes back to the human, the
   * ports no longer match our cache; without this, a direction the player never
   * let go of would stay open and the ship would sit still.
   * @returns {void}
   */
  invalidate() {
    this.applied.clear();
    this.flush();
  }

  /**
   * Union the sources, diff against what is applied, and emit only the changes.
   * @returns {void}
   */
  flush() {
    /** @type {Set<InputName>} */
    const wanted = new Set();
    for (const set of this.sources.values()) {
      for (const name of set) wanted.add(name);
    }

    for (const name of wanted) {
      if (!this.applied.has(name)) {
        this.applied.add(name);
        this.apply(name, true);
      }
    }
    for (const name of [...this.applied]) {
      if (!wanted.has(name)) {
        this.applied.delete(name);
        this.apply(name, false);
      }
    }
  }

  /**
   * Everything currently held, by any source. For tests and for the console.
   * @returns {Set<InputName>}
   */
  held() {
    return new Set(this.applied);
  }
}

export default InputMux;
