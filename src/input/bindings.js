// Copyright 2026 by Moshix
/**
 * What a joystick control *means*, and how to tell when it is being used.
 *
 * The Gamepad API only promises a fixed layout when it says so: a pad reporting
 * `mapping: "standard"` has the buttons and axes where you expect. A no-name
 * USB stick usually reports `mapping: ""` and numbers its axes and buttons
 * however its firmware felt like, which is why this file exists and why the
 * game ships a remapping screen instead of a table of magic indices.
 *
 * THE ONE IDEA WORTH INTERNALISING: a control is active when it has moved away
 * from where it *rests*, not when its value is large. Cheap sticks do not
 * centre at zero -- a worn potentiometer idles at 0.2 or 0.3 -- and analogue
 * triggers conventionally rest at -1.0 and travel to +1.0, so a trigger sitting
 * completely untouched reports the most extreme value the API can express. Test
 * the absolute value and such a stick reads as "hard left, forever". Test the
 * deviation from a rest value sampled while nobody was touching it and both
 * cases come out right, with no special-casing per device.
 *
 * Everything here is a pure function of plain data, so the whole model is
 * exercised in plain Node with no browser (test/unit/input-bindings.test.mjs).
 * The storage helpers take a Storage-like object rather than reaching for
 * `localStorage` for the same reason.
 */

/**
 * Everything a joystick may drive.
 *
 * The first three close switches on the board. `coin` and `start` do too -- a
 * cabinet has those buttons on the panel, so a stick should be able to reach
 * them and the player never has to touch the keyboard. `pause` does not: there
 * is no pause on a 1979 arcade board, so it is a *host* action handled by the
 * page rather than routed to a port. See {@link MACHINE_INPUT}.
 */
export const ACTIONS = Object.freeze(/** @type {const} */ ([
  'left', 'right', 'fire', 'coin', 'start', 'pause',
]));

/**
 * Which board switch each action closes, for the actions that close one.
 *
 * An action absent from this map is handled by the host and must never be
 * routed to the input mux -- `Machine.setInput` would not recognise the name.
 * @type {Readonly<Record<string, string|undefined>>}
 */
export const MACHINE_INPUT = Object.freeze({
  left: 'left',
  right: 'right',
  fire: 'fire',
  coin: 'coin1',
  start: 'start1',
});

/**
 * Actions that toggle on the press rather than being held.
 *
 * `left`, `right`, `fire`, `coin` and `start` are all *levels*: the board reads
 * the port every frame and does its own edge detection where it wants it (the
 * coin slot credits on release, the fire button on the rising edge). `pause` is
 * a host toggle, so the page has to find the edge itself or holding the button
 * would flip pause sixty times a second.
 * @type {ReadonlySet<string>}
 */
export const EDGE_ACTIONS = Object.freeze(new Set(['pause']));

/**
 * Deviation from rest at which an axis closes its switch, and the lower value
 * at which an already-closed switch stays closed.
 *
 * The gap is hysteresis. A noisy stick hovering exactly on a single threshold
 * would open and close the switch every frame, and because the swarm reads the
 * port once per frame that reads on screen as the ship vibrating rather than
 * moving. Digital hats slam between 0 and +-1 and never notice the gap.
 */
export const DEADZONE_ON = 0.5;
export const DEADZONE_OFF = 0.35;

/**
 * Where a control lives on the device.
 * @typedef {{type: 'button', index: number}
 *          |{type: 'axis', index: number, dir: 1 | -1}} Binding
 */
/**
 * @typedef {{left: Binding[], right: Binding[], fire: Binding[],
 *            coin: Binding[], start: Binding[], pause: Binding[]}} Bindings
 */
/** @typedef {{axes: number[], buttons: number[]}} PadSnapshot */

/**
 * Bindings used until the player remaps something.
 *
 * Each action lists several candidates and is active if any of them is, which
 * is the cheapest way to cover a standard pad and a no-name stick at once:
 * axis 0 is the horizontal axis on essentially every device, buttons 14 and 15
 * are the d-pad under the standard mapping, and button 0 is the primary button
 * everywhere -- with 1 and 2 included because plenty of sticks do not start
 * their numbering where you would guess.
 *
 * Note what is deliberately absent: the hat-as-one-axis encoding some adapters
 * use, where a single axis takes eight discrete values for eight directions.
 * Its values are not monotonic in any direction, so no deviation test can read
 * it, and guessing would produce a stick that moves the ship at random. That
 * device is exactly why the remapping screen exists.
 */
export const DEFAULT_BINDINGS = Object.freeze({
  left: Object.freeze([
    Object.freeze({ type: 'axis', index: 0, dir: -1 }),
    Object.freeze({ type: 'button', index: 14 }),
  ]),
  right: Object.freeze([
    Object.freeze({ type: 'axis', index: 0, dir: 1 }),
    Object.freeze({ type: 'button', index: 15 }),
  ]),
  fire: Object.freeze([
    Object.freeze({ type: 'button', index: 0 }),
    Object.freeze({ type: 'button', index: 1 }),
    Object.freeze({ type: 'button', index: 2 }),
  ]),
  // Under the standard mapping button 8 is Select/Back and 9 is Start, which is
  // as close as a modern pad gets to a coin slot and a start button. Pause takes
  // button 3 (Y / Triangle) because it is the one face button fire does not
  // claim -- overlapping them would pause the game every time you shot.
  coin: Object.freeze([
    Object.freeze({ type: 'button', index: 8 }),
  ]),
  start: Object.freeze([
    Object.freeze({ type: 'button', index: 9 }),
  ]),
  pause: Object.freeze([
    Object.freeze({ type: 'button', index: 3 }),
  ]),
});

/**
 * Flatten a live Gamepad into plain numbers.
 *
 * The API hands back a fresh snapshot object every poll and its `buttons` are
 * `GamepadButton` objects; reducing both to arrays of numbers here means every
 * function below can be handed a literal in a test.
 *
 * A button reduces to the larger of its two readings: `pressed` (some drivers
 * only ever set this) and `value` (an analogue trigger that never claims to be
 * "pressed" still travels, and at 90% pulled the player clearly means it).
 * Taking the maximum means neither kind of device needs special-casing.
 *
 * @param {{axes: ArrayLike<number>, buttons: ArrayLike<{pressed?: boolean, value?: number}|number>}} pad
 * @returns {PadSnapshot}
 */
export function snapshotOf(pad) {
  const axes = Array.from(pad.axes ?? [], (v) => (Number.isFinite(v) ? v : 0));
  const buttons = Array.from(pad.buttons ?? [], (b) => {
    if (typeof b === 'number') return Number.isFinite(b) ? b : 0;
    if (b === null || b === undefined) return 0;
    const value = Number.isFinite(b.value) ? /** @type {number} */ (b.value) : 0;
    return Math.max(b.pressed === true ? 1 : 0, value);
  });
  return { axes, buttons };
}

/**
 * The rest position to measure deviation against.
 *
 * Taken while the player is not touching the stick -- on connect, and again
 * whenever the page regains focus, since a pad can be moved while the tab is
 * in the background.
 *
 * @param {PadSnapshot} snapshot
 * @returns {PadSnapshot}
 */
export function calibrateRest(snapshot) {
  return { axes: [...snapshot.axes], buttons: [...snapshot.buttons] };
}

/** A rest position for a device we have not calibrated yet. @returns {PadSnapshot} */
export function neutralRest() {
  return { axes: [], buttons: [] };
}

/**
 * Is this one control being used right now?
 *
 * @param {Binding} binding
 * @param {PadSnapshot} now
 * @param {PadSnapshot} rest
 * @param {boolean} [wasActive] previous state, for hysteresis
 * @returns {boolean}
 */
export function isBindingActive(binding, now, rest, wasActive = false) {
  if (binding.type === 'button') {
    // A button out of range is simply not pressed: a pad can be swapped for one
    // with fewer controls while a stale binding is still loaded.
    const value = now.buttons[binding.index];
    if (value === undefined) return false;
    const base = rest.buttons[binding.index] ?? 0;
    return value - base > 0.5;
  }
  const value = now.axes[binding.index];
  if (value === undefined) return false;
  const base = rest.axes[binding.index] ?? 0;
  const travel = (value - base) * binding.dir;
  return travel >= (wasActive ? DEADZONE_OFF : DEADZONE_ON);
}

/**
 * Which switches the stick is closing.
 *
 * @param {Bindings} bindings
 * @param {PadSnapshot} now
 * @param {PadSnapshot} rest
 * @param {ReadonlySet<string>} [previous] last frame's result, for hysteresis
 * @returns {Set<string>} a subset of {@link ACTIONS}
 */
export function activeActions(bindings, now, rest, previous = new Set()) {
  /** @type {Set<string>} */
  const active = new Set();
  for (const action of ACTIONS) {
    const list = bindings[action] ?? [];
    const was = previous.has(action);
    for (const binding of list) {
      if (isBindingActive(binding, now, rest, was)) { active.add(action); break; }
    }
  }
  return active;
}

/** @param {Binding} a @param {Binding} b @returns {boolean} */
export function bindingsEqual(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (a.type !== b.type || a.index !== b.index) return false;
  return a.type !== 'axis' || a.dir === /** @type {{dir: number}} */ (b).dir;
}

/**
 * Give an action a new binding, returning a fresh object.
 *
 * If the control already drives a different action the two are **swapped**
 * rather than the old one being silently dropped. Nearly every remap that hits
 * this case is somebody fixing a stick whose left and right came out backwards,
 * and swapping fixes both rows in one press instead of leaving one unbound.
 *
 * @param {Bindings} bindings
 * @param {typeof ACTIONS[number]} action
 * @param {Binding} binding
 * @returns {Bindings}
 */
export function assignBinding(bindings, action, binding) {
  /** @type {Bindings} */
  const next = { left: [], right: [], fire: [], coin: [], start: [], pause: [] };
  for (const key of ACTIONS) next[key] = [...(bindings[key] ?? [])];

  const previous = next[action][0];
  for (const key of ACTIONS) {
    if (key === action) continue;
    if (next[key].some((b) => bindingsEqual(b, binding))) {
      next[key] = previous === undefined ? [] : [previous];
    }
  }
  next[action] = [binding];
  return next;
}

/**
 * Human-readable name for the remapping screen.
 * @param {Binding} [binding]
 * @returns {string}
 */
export function describeBinding(binding) {
  if (binding === undefined || binding === null) return 'unbound';
  if (binding.type === 'button') return `button ${binding.index}`;
  return `axis ${binding.index} ${binding.dir < 0 ? '−' : '+'}`;
}

/** @param {unknown} value @returns {value is Binding} */
function validBinding(value) {
  if (typeof value !== 'object' || value === null) return false;
  const b = /** @type {{type?: unknown, index?: unknown, dir?: unknown}} */ (value);
  if (!Number.isInteger(b.index) || /** @type {number} */ (b.index) < 0) return false;
  if (b.type === 'button') return true;
  return b.type === 'axis' && (b.dir === 1 || b.dir === -1);
}

/**
 * Coerce whatever came out of storage into usable bindings.
 *
 * Stored JSON is not trusted: it may be from an older version of the game, or
 * hand-edited, or truncated. Anything unrecognised falls back per action rather
 * than throwing, because a corrupt preference must never be able to leave the
 * player unable to move.
 *
 * An action present as an empty array stays empty -- that is somebody who
 * deliberately cleared a binding, not corruption.
 *
 * Defaults are filled in only *after* every stored action has been read, and a
 * default **button** the stored profile has already given to something else is
 * dropped. This is what makes adding an action to {@link ACTIONS} safe: a
 * profile saved before `pause` existed may well have moved FIRE onto button 3,
 * and handing pause its default -- the same button 3 -- would freeze the game on
 * every shot, with nothing in the saved data to explain why. An action whose
 * whole default is taken arrives unbound, which the remapping screen shows and
 * can fix.
 *
 * Axes are deliberately left alone. A button does one thing, so two actions on
 * one button is unambiguously a mistake; an axis is shared by the left/right
 * pair by design, and dropping half of that pair because a stored profile
 * mentions axis 0 would leave a player unable to steer -- much the worse
 * failure of the two.
 *
 * @param {unknown} raw
 * @returns {Bindings}
 */
export function normalizeBindings(raw) {
  /** @type {Bindings} */
  const out = { left: [], right: [], fire: [], coin: [], start: [], pause: [] };
  const src = (typeof raw === 'object' && raw !== null)
    ? /** @type {Record<string, unknown>} */ (raw) : {};
  /** Actions the stored data said nothing about. @type {string[]} */
  const absent = [];
  for (const action of ACTIONS) {
    const list = src[action];
    if (Array.isArray(list)) {
      out[action] = list.filter(validBinding).map((b) => (b.type === 'axis'
        ? { type: 'axis', index: b.index, dir: b.dir }
        : { type: 'button', index: b.index }));
    } else {
      absent.push(action);
    }
  }
  /** Is this button already spoken for? @param {Binding} binding @returns {boolean} */
  const taken = (binding) => binding.type === 'button' && ACTIONS.some(
    (a) => out[a].some((b) => bindingsEqual(b, binding)),
  );
  for (const action of absent) {
    out[action] = DEFAULT_BINDINGS[action].filter((b) => !taken(b));
  }
  return out;
}

// ------------------------------------------------------------------ storage

/** Where preferences live. The suffix is a schema version, not a game version. */
export const STORAGE_KEY = 'galaga.gamepad.v1';
const SCHEMA_VERSION = 1;

/**
 * Identify a device across reconnections.
 *
 * `Gamepad.index` is only a slot number -- unplug and replug and it changes --
 * and `id` strings differ between browsers for the same hardware. Folding in
 * the axis and button counts separates two different no-name sticks that both
 * report an empty or generic `id`, which is the common case this has to handle.
 *
 * @param {{id?: string, axes?: ArrayLike<unknown>, buttons?: ArrayLike<unknown>}} pad
 * @returns {string}
 */
export function profileKey(pad) {
  const id = String(pad.id ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${id}|a${pad.axes?.length ?? 0}|b${pad.buttons?.length ?? 0}`;
}

/**
 * `localStorage`, or null where it cannot be used.
 *
 * Access throws outright in some privacy modes and from `file://` in some
 * browsers, and a quota can be full, so it is probed with a real write rather
 * than tested for existence. A null return is not an error: the caller keeps
 * preferences in memory for the session and says so on screen.
 *
 * @returns {Storage | null}
 */
export function safeStorage() {
  try {
    const store = globalThis.localStorage;
    if (store === undefined || store === null) return null;
    const probe = `${STORAGE_KEY}.probe`;
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

/**
 * @param {Pick<Storage, 'getItem'> | null} [storage]
 * @returns {Record<string, unknown>} profiles by {@link profileKey}
 */
export function loadProfiles(storage) {
  if (storage === null || storage === undefined) return {};
  try {
    const text = storage.getItem(STORAGE_KEY);
    if (typeof text !== 'string') return {};
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return {};
    if (parsed.version !== SCHEMA_VERSION) return {};
    const profiles = parsed.profiles;
    return (typeof profiles === 'object' && profiles !== null) ? profiles : {};
  } catch {
    return {};
  }
}

/**
 * @param {Pick<Storage, 'getItem'> | null} storage
 * @param {string} key from {@link profileKey}
 * @returns {Bindings} the stored bindings, or the defaults
 */
export function loadBindings(storage, key) {
  const profiles = loadProfiles(storage);
  const stored = profiles[key];
  if (stored === undefined) return normalizeBindings(undefined);
  return normalizeBindings(stored);
}

/**
 * @param {Storage | null} storage
 * @param {string} key
 * @param {Bindings} bindings
 * @returns {boolean} false when the preference could not be persisted
 */
export function saveBindings(storage, key, bindings) {
  if (storage === null || storage === undefined) return false;
  try {
    const profiles = loadProfiles(storage);
    profiles[key] = bindings;
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, profiles }));
    return true;
  } catch {
    // A full quota or a locked-down browser is not worth breaking a frame over.
    return false;
  }
}
