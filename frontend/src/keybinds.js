// Centralized keyboard shortcut definitions.
//
// Each action carries full metadata so the handler, Settings, and KeyboardHelp
// can all derive from one source of truth.
//
// Future phase: editing UI writes user overrides to localStorage('taskos-keybinds').
// resolveKeybinds() already merges those overrides — the handler will reflect
// custom bindings automatically once the editing UI exists.

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
    description: 'Edit the selected task',
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
// Symbol key detection
// ---------------------------------------------------------------------------
// Symbol keys (?, !, @, …) carry their own shift state in e.key — pressing
// Shift+/ gives e.key='?'. For these keys we skip the shift check in
// matchKeybind so the binding works on any keyboard layout.

function isSymbolKey(key) {
  return key.length === 1 && !/[a-zA-Z0-9]/.test(key);
}

// ---------------------------------------------------------------------------
// normalizeBinding
// ---------------------------------------------------------------------------
// Returns a new binding object with:
//   - single-letter keys lowercased
//   - all modifier fields coerced to booleans
// Does not mutate the input.

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
// bindingSignature
// ---------------------------------------------------------------------------
// Returns a stable string for conflict detection / map keys.
// Example: "e|false|false|false|false"

export function bindingSignature(binding) {
  const n = normalizeBinding(binding);
  return `${n.key}|${n.shift}|${n.meta}|${n.ctrl}|${n.alt}`;
}

// ---------------------------------------------------------------------------
// bindingLabel
// ---------------------------------------------------------------------------
// Returns a compact human-readable label.
// Examples: e → E, Enter → ↵, Shift+Enter → ⇧↵, ArrowLeft → ←, ? → ?

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
  // Skip shift prefix for symbol keys — the symbol character already implies it.
  if (n.shift && !isSymbolKey(n.key)) prefix += '⇧';
  return prefix + keyStr;
}

// ---------------------------------------------------------------------------
// matchKeybind
// ---------------------------------------------------------------------------
// Compares a KeyboardEvent against a binding definition.
// Pure function — no side effects.
//
// Symbol keys (?, etc.) skip the shift check because e.key already encodes
// the shift state (Shift+/ → e.key='?' with e.shiftKey=true on US keyboards).

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
// resolveKeybinds
// ---------------------------------------------------------------------------
// Returns a resolved keybind map: KEYBINDS defaults merged with any valid
// localStorage overrides. Only actions where customizable===true are
// overridable. Invalid or corrupt entries are silently ignored.

const LS_KEYBINDS_KEY = 'taskos-keybinds';

export function resolveKeybinds() {
  let overrides = {};
  try {
    const raw = localStorage.getItem(LS_KEYBINDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        overrides = parsed;
      }
    }
  } catch {
    // Corrupt JSON — use all defaults.
  }

  const result = {};
  for (const [action, binding] of Object.entries(KEYBINDS)) {
    const override = overrides[action];
    if (
      binding.customizable &&
      override &&
      typeof override === 'object' &&
      typeof override.key === 'string' &&
      override.key.length > 0
    ) {
      result[action] = { ...binding, ...normalizeBinding(override) };
    } else {
      result[action] = binding;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// KEYBIND_HELP — static structured data for KeyboardHelp panel.
// Groups and descriptions match KEYBINDS above.
// ---------------------------------------------------------------------------

export const KEYBIND_HELP = [
  {
    group: 'Navigation',
    items: [
      { keys: '↑ / ↓', desc: 'Move selection between tasks'  },
      { keys: '← / →', desc: 'Move selection between dates'  },
    ],
  },
  {
    group: 'Editing',
    items: [
      { keys: '↵',   desc: 'Increment completion for selected cell' },
      { keys: '⇧ ↵', desc: 'Decrement completion for selected cell' },
      { keys: 'E',   desc: 'Edit the selected task' },
      { keys: 'N',   desc: 'Add a new task' },
    ],
  },
  {
    group: 'View',
    items: [
      { keys: 'Esc', desc: 'Close modal, close help, or clear selection' },
      { keys: '?',   desc: 'Show or hide keyboard shortcuts' },
    ],
  },
];
