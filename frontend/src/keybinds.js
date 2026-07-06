// Centralized keyboard shortcut definitions.
//
// Architecture:
//   KEYBINDS          — static default definitions with full metadata
//   loadKbOverrides   — reads taskos-keybinds from localStorage
//   writeKbOverrides  — writes / removes taskos-keybinds in localStorage
//   buildResolvedFromOverrides — merges overrides onto defaults
//   resolveKeybinds   — convenience: load + build in one call
//   matchKeybind      — pure KeyboardEvent comparator
//   bindingLabel      — human-readable label for display
//   isReservedBinding — validation: blocks Enter, Esc, Arrows, etc.
//   findBindingConflict — validation: detects collisions with other actions
//   captureEventToBinding — normalizes a KeyboardEvent into a binding object

// ---------------------------------------------------------------------------
// KEYBINDS — one entry per action
// ---------------------------------------------------------------------------

export const KEYBINDS = {
  INCREMENT: {
    key: 'Enter', shift: false, meta: false, ctrl: false, alt: false,
    label: '↵',
    description: 'Increment completion for selected cell',
    group: 'Editing', customizable: false, requiresSelection: true,
  },
  DECREMENT: {
    key: 'Enter', shift: true, meta: false, ctrl: false, alt: false,
    label: '⇧↵',
    description: 'Decrement completion for selected cell',
    group: 'Editing', customizable: false, requiresSelection: true,
  },
  MOVE_LEFT: {
    key: 'ArrowLeft', shift: false, meta: false, ctrl: false, alt: false,
    label: '←',
    description: 'Move selection left',
    group: 'Navigation', customizable: false, requiresSelection: false,
  },
  MOVE_RIGHT: {
    key: 'ArrowRight', shift: false, meta: false, ctrl: false, alt: false,
    label: '→',
    description: 'Move selection right',
    group: 'Navigation', customizable: false, requiresSelection: false,
  },
  MOVE_UP: {
    key: 'ArrowUp', shift: false, meta: false, ctrl: false, alt: false,
    label: '↑',
    description: 'Move selection up',
    group: 'Navigation', customizable: false, requiresSelection: false,
  },
  MOVE_DOWN: {
    key: 'ArrowDown', shift: false, meta: false, ctrl: false, alt: false,
    label: '↓',
    description: 'Move selection down',
    group: 'Navigation', customizable: false, requiresSelection: false,
  },
  EDIT_TASK: {
    key: 'e', shift: false, meta: false, ctrl: false, alt: false,
    label: 'E',
    description: 'Open task details',
    group: 'Editing', customizable: true, requiresSelection: true,
  },
  NEW_TASK: {
    key: 'n', shift: false, meta: false, ctrl: false, alt: false,
    label: 'N',
    description: 'Add a new task',
    group: 'Editing', customizable: true, requiresSelection: false,
  },
  CLEAR_SELECTION: {
    key: 'Escape', shift: false, meta: false, ctrl: false, alt: false,
    label: 'Esc',
    description: 'Close modal, close help, or clear selection',
    group: 'View', customizable: false, requiresSelection: false,
  },
  TOGGLE_HELP: {
    key: '?', shift: false, meta: false, ctrl: false, alt: false,
    label: '?',
    description: 'Show or hide keyboard shortcuts',
    group: 'View', customizable: true, requiresSelection: false,
  },
};

// Display order for groups in Settings and KeyboardHelp.
export const KB_GROUP_ORDER = ['Navigation', 'Editing', 'View'];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Symbol keys (?, !, etc.) carry their own shift state in e.key — pressing
// Shift+/ gives e.key='?'. For these we skip the shift check in matchKeybind
// and normalize shift to false in captureEventToBinding.
function isSymbolKey(key) {
  return key.length === 1 && !/[a-zA-Z0-9]/.test(key);
}

// ---------------------------------------------------------------------------
// normalizeBinding — lowercase letters, coerce booleans, no mutation
// ---------------------------------------------------------------------------
export function normalizeBinding(binding) {
  return {
    key:   /^[a-zA-Z]$/.test(binding.key) ? binding.key.toLowerCase() : binding.key,
    shift: !!binding.shift,
    meta:  !!binding.meta,
    ctrl:  !!binding.ctrl,
    alt:   !!binding.alt,
  };
}

// ---------------------------------------------------------------------------
// bindingSignature — stable string for conflict detection
// Example: "e|false|false|false|false"
// ---------------------------------------------------------------------------
export function bindingSignature(binding) {
  const n = normalizeBinding(binding);
  // Symbol keys normalize shift to false so signatures are consistent with matchKeybind.
  const shift = isSymbolKey(n.key) ? false : n.shift;
  return `${n.key}|${shift}|${n.meta}|${n.ctrl}|${n.alt}`;
}

// ---------------------------------------------------------------------------
// bindingLabel — human-readable display string
// Examples: e→E, Enter→↵, Shift+Enter→⇧↵, ArrowLeft→←, ?→?
// ---------------------------------------------------------------------------
const KEY_DISPLAY = {
  Enter:      '↵',
  Escape:     'Esc',
  ArrowLeft:  '←',
  ArrowRight: '→',
  ArrowUp:    '↑',
  ArrowDown:  '↓',
  ' ':        'Space',
  Tab:        'Tab',
};

export function bindingLabel(binding) {
  const n = normalizeBinding(binding);
  const keyStr = KEY_DISPLAY[n.key] ?? (n.key.length === 1 ? n.key.toUpperCase() : n.key);
  let prefix = '';
  if (n.ctrl)  prefix += 'Ctrl+';
  if (n.alt)   prefix += 'Alt+';
  if (n.meta)  prefix += '⌘';
  // Skip shift prefix for symbol keys — the symbol already implies it.
  if (n.shift && !isSymbolKey(n.key)) prefix += '⇧';
  return prefix + keyStr;
}

// ---------------------------------------------------------------------------
// matchKeybind — compare a KeyboardEvent against a binding definition
// Pure function — no side effects.
// Symbol keys skip the shift check; see isSymbolKey above.
// ---------------------------------------------------------------------------
export function matchKeybind(event, binding) {
  const n = normalizeBinding(binding);
  if (event.key.toLowerCase() !== n.key.toLowerCase()) return false;
  if (!isSymbolKey(n.key) && !!event.shiftKey !== n.shift) return false;
  if (!!event.metaKey !== n.meta) return false;
  if (!!event.ctrlKey !== n.ctrl) return false;
  if (!!event.altKey  !== n.alt)  return false;
  return true;
}

// ---------------------------------------------------------------------------
// captureEventToBinding — convert a KeyboardEvent to a storable binding
// Returns null for pure modifier keys (Shift, Ctrl, etc.).
// Symbol keys: shift is normalized to false (symbol encodes its own shift state).
// ---------------------------------------------------------------------------
export function captureEventToBinding(event) {
  if (['Shift', 'Control', 'Meta', 'Alt', 'CapsLock'].includes(event.key)) return null;
  const key = /^[a-zA-Z]$/.test(event.key) ? event.key.toLowerCase() : event.key;
  const shift = isSymbolKey(event.key) ? false : !!event.shiftKey;
  return {
    key,
    shift,
    meta: !!event.metaKey,
    ctrl: !!event.ctrlKey,
    alt:  !!event.altKey,
  };
}

// ---------------------------------------------------------------------------
// isReservedBinding — true if the binding should never be allowed as a custom
// shortcut. Blocks: multi-char named keys (Enter, Esc, Arrows, etc.), Space,
// and any combination using Ctrl / Meta / Alt.
// ---------------------------------------------------------------------------
export function isReservedBinding(binding) {
  const n = normalizeBinding(binding);
  if (n.key.length > 1) return true;   // Enter, Escape, ArrowLeft, Tab, F1…
  if (n.key === ' ')    return true;   // Space
  if (n.meta || n.ctrl || n.alt) return true;
  return false;
}

// ---------------------------------------------------------------------------
// findBindingConflict — returns the conflicting action ID, or null.
// Validates against ALL resolved bindings (fixed + customizable).
// Uses bindingSignature for comparison, which already normalizes symbol shift.
// ---------------------------------------------------------------------------
export function findBindingConflict(binding, forAction, resolved) {
  const sig = bindingSignature(binding);
  for (const [action, b] of Object.entries(resolved)) {
    if (action === forAction) continue;
    if (bindingSignature(b) === sig) return action;
  }
  return null;
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

const LS_KEYBINDS_KEY = 'taskos-keybinds';

// loadKbOverrides — returns only the validated overrides object (not merged).
// Used to initialize Settings state so edits can be tracked separately.
export function loadKbOverrides() {
  try {
    const raw = localStorage.getItem(LS_KEYBINDS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [action, override] of Object.entries(parsed)) {
      if (
        KEYBINDS[action]?.customizable &&
        override &&
        typeof override === 'object' &&
        typeof override.key === 'string' &&
        override.key.length > 0
      ) {
        clean[action] = normalizeBinding(override);
      }
    }
    return clean;
  } catch {
    return {};
  }
}

// writeKbOverrides — persists the overrides object. Removes the key entirely
// when overrides is empty so localStorage stays clean.
export function writeKbOverrides(overrides) {
  try {
    if (Object.keys(overrides).length === 0) {
      localStorage.removeItem(LS_KEYBINDS_KEY);
    } else {
      localStorage.setItem(LS_KEYBINDS_KEY, JSON.stringify(overrides));
    }
  } catch {
    // localStorage unavailable — silently ignore.
  }
}

// buildResolvedFromOverrides — merge validated overrides onto KEYBINDS defaults.
// Separating this from loading lets Settings update resolvedKb reactively.
export function buildResolvedFromOverrides(overrides) {
  const result = {};
  for (const [action, binding] of Object.entries(KEYBINDS)) {
    const override = overrides[action];
    if (binding.customizable && override) {
      result[action] = { ...binding, ...override };
    } else {
      result[action] = binding;
    }
  }
  return result;
}

// resolveKeybinds — convenience wrapper: load overrides + build resolved map.
// Used by TaskGrid on mount.
export function resolveKeybinds() {
  return buildResolvedFromOverrides(loadKbOverrides());
}

// ---------------------------------------------------------------------------
// FIXED_SHORTCUTS — non-customizable shortcuts shown in the Settings panel.
// These are outside KEYBINDS because they are not single-action bindings.
// ---------------------------------------------------------------------------
export const FIXED_SHORTCUTS = [
  {
    group: 'Navigation',
    keys: '⇧ + digits',
    description: 'Opens the Jump panel and fills it live. No selection: Enter confirms row jump N. With selection: Enter confirms date column N. Hold ⇧, type digits, release ⇧ or press ↵.',
  },
];

// ---------------------------------------------------------------------------
// KEYBIND_HELP — structured data for KeyboardHelp panel.
// Items with `action` get their label from the resolved binding at render time.
// Items without `action` use the static `keys` string (combined nav rows).
// ---------------------------------------------------------------------------
export const KEYBIND_HELP = [
  {
    group: 'Navigation',
    items: [
      { keys: '↑ / ↓', desc: 'Move selection between tasks' },
      { keys: '← / →', desc: 'Move selection between dates' },
      { keys: '⇧ + digits', desc: 'Opens Jump panel live · release ⇧ or ↵ to confirm · no selection: row N · with selection: date column N' },
    ],
  },
  {
    group: 'Editing',
    items: [
      { action: 'INCREMENT', desc: 'Increment completion for selected date cell' },
      { action: 'DECREMENT', desc: 'Decrement completion for selected date cell' },
      { keys: 'Del / ⌫',    desc: 'Arm clear (1st press) · confirm clear (2nd press)' },
      { action: 'EDIT_TASK', desc: 'Open task details (scheduling, status, priority, notes)' },
      { action: 'NEW_TASK',  desc: 'Add a new task' },
    ],
  },
  {
    group: 'View',
    items: [
      { action: 'CLEAR_SELECTION', desc: 'Cancel armed clear / close modal / clear selection' },
      { action: 'TOGGLE_HELP',     desc: 'Show or hide keyboard shortcuts' },
    ],
  },
  {
    group: 'Mouse',
    items: [
      { keys: 'Click cell',   desc: 'Select date cell (no mutation)' },
      { keys: 'Click ☐ / ✓', desc: 'Increment completion count' },
      { keys: '⇧Click ✓',    desc: 'Clear completion count' },
      { keys: 'Click text',   desc: 'Select text cell (task / subtask / category)' },
      { keys: 'Dbl-click',    desc: 'Enter inline edit mode for text cell' },
    ],
  },
  {
    group: 'Inline Edit',
    items: [
      { keys: '↵',          desc: 'Commit text edit' },
      { keys: 'Esc',        desc: 'Cancel edit, restore original value' },
      { keys: 'Click away', desc: 'Commit text edit (blur)' },
    ],
  },
];
