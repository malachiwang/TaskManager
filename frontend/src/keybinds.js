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
//   isReservedBinding — rejects keys that cannot identify an action
//   findBindingConflict — validation: detects collisions with other actions
//   captureEventToBinding — normalizes a KeyboardEvent into a binding object

// ---------------------------------------------------------------------------
// KEYBINDS — the shortcut registry: one entry per keyboard-triggered action.
//
// Fields:
//   key/shift/meta/ctrl/alt — the DEFAULT binding (current app defaults).
//   label        — display fallback for the default binding.
//   description  — help text shown in Settings and the help panel.
//   group        — display grouping (Settings / help panel sections).
//   context      — global, grid, reading, or sheet (grid + reading). Two actions
//                  may share a binding only if their contexts differ AND
//                  neither is 'global' (a global binding must stay unique).
//   customizable — all keyboard actions offer Change in Settings.
//   requiresSelection — informational; used by handlers, not the registry.
//
// Custom bindings live in localStorage (taskos-keybinds) as {ACTION: binding}
// overrides on top of these defaults — never in SQLite or JSON backups.
// Unknown/invalid saved actions are dropped safely on load (see
// loadKbOverrides), so stale data from older versions cannot crash resolution.
// ---------------------------------------------------------------------------

export const KEYBINDS = {
  INCREMENT: {
    key: 'Enter', shift: false, meta: false, ctrl: false, alt: false,
    label: '↵',
    description: 'Increment completion for selected cell (opens the editor on a text cell)',
    group: 'Task Grid', context: 'grid',
    customizable: true,
    requiresSelection: true,
  },
  DECREMENT: {
    key: 'Enter', shift: true, meta: false, ctrl: false, alt: false,
    label: '⇧↵',
    description: 'Decrement completion for selected cell',
    group: 'Task Grid', context: 'grid',
    customizable: true,
    requiresSelection: true,
  },
  MOVE_LEFT: {
    key: 'ArrowLeft', shift: false, meta: false, ctrl: false, alt: false,
    label: '←',
    description: 'Move selection left',
    group: 'Navigation', context: 'sheet',
    customizable: true,
    requiresSelection: false,
  },
  MOVE_RIGHT: {
    key: 'ArrowRight', shift: false, meta: false, ctrl: false, alt: false,
    label: '→',
    description: 'Move selection right',
    group: 'Navigation', context: 'sheet',
    customizable: true,
    requiresSelection: false,
  },
  MOVE_UP: {
    key: 'ArrowUp', shift: false, meta: false, ctrl: false, alt: false,
    label: '↑',
    description: 'Move selection up',
    group: 'Navigation', context: 'sheet',
    customizable: true,
    requiresSelection: false,
  },
  MOVE_DOWN: {
    key: 'ArrowDown', shift: false, meta: false, ctrl: false, alt: false,
    label: '↓',
    description: 'Move selection down',
    group: 'Navigation', context: 'sheet',
    customizable: true,
    requiresSelection: false,
  },
  EDIT_TASK: {
    key: 'e', shift: false, meta: false, ctrl: false, alt: false,
    label: 'E',
    description: 'Open task details',
    group: 'Task Grid', context: 'grid',
    customizable: true, requiresSelection: true,
  },
  NEW_TASK: {
    key: 'n', shift: false, meta: false, ctrl: false, alt: false,
    label: 'N',
    description: 'Add a new task',
    group: 'Task Grid', context: 'grid',
    customizable: true, requiresSelection: false,
  },
  FOCUS_SEARCH: {
    key: '/', shift: false, meta: false, ctrl: false, alt: false,
    label: '/',
    description: 'Focus the task search box',
    group: 'Task Grid', context: 'grid',
    customizable: true, requiresSelection: false,
  },
  CLEAR_SELECTION: {
    key: 'Escape', shift: false, meta: false, ctrl: false, alt: false,
    label: 'Esc',
    description: 'Close modal, collapse range, or clear selection',
    group: 'Global', context: 'global',
    customizable: true,
    requiresSelection: false,
  },
  TOGGLE_HELP: {
    key: '?', shift: false, meta: false, ctrl: false, alt: false,
    label: '?',
    description: 'Show or hide keyboard shortcuts',
    group: 'Global', context: 'global',
    customizable: true, requiresSelection: false,
  },
  READING_NEW_BOOK: {
    key: 'n', shift: false, meta: false, ctrl: false, alt: false,
    label: 'N',
    description: 'Add a new book',
    group: 'Reading', context: 'reading',
    customizable: true, requiresSelection: false,
  },
  READING_EDIT_BOOK: {
    key: 'e', shift: false, meta: false, ctrl: false, alt: false,
    label: 'E',
    description: 'Edit the selected book',
    group: 'Reading', context: 'reading',
    customizable: true, requiresSelection: true,
  },
  READING_FOCUS_SEARCH: {
    key: '/', shift: false, meta: false, ctrl: false, alt: false,
    label: '/',
    description: 'Focus the reading search box',
    group: 'Reading', context: 'reading',
    customizable: true, requiresSelection: false,
  },
};

// All app keyboard actions are editable; mouse gestures remain documented separately.
for (const direction of ['LEFT', 'RIGHT', 'UP', 'DOWN']) {
  KEYBINDS[`RANGE_${direction}`] = {
    ...KEYBINDS[`MOVE_${direction}`], shift: true, group: 'Navigation', context: 'grid',
    description: `Extend selection ${direction.toLowerCase()}`, requiresSelection: true,
  };
}
for (let digit = 0; digit <= 9; digit++) {
  KEYBINDS[`JUMP_${digit}`] = {
    key: String(digit), shift: true, meta: false, ctrl: false, alt: false,
    description: `Jump: append digit ${digit} (release Shift or Enter to confirm)`,
    group: 'Navigation', context: 'grid', customizable: true,
  };
}
for (const [action, key, context, description] of [
  ['DELETE_CELL', 'Delete', 'grid', 'Convert selected cells to blank text; keep completion history'],
  ['BACKSPACE_CELL', 'Backspace', 'grid', 'Convert selected cells to blank text (alternate)'],
  ['READING_CHECKPOINT', 'Enter', 'reading', 'Add a page checkpoint for the selected book'],
  ['READING_DELETE', 'Delete', 'reading', 'Delete selected book after confirmation'],
  ['READING_BACKSPACE', 'Backspace', 'reading', 'Delete selected book after confirmation (alternate)'],
  ['FOCUS_NEXT', 'Tab', 'global', 'Move focus forward'],
  ['FOCUS_PREVIOUS', 'Tab', 'global', 'Move focus backward'],
]) {
  KEYBINDS[action] = { key, shift: action === 'FOCUS_PREVIOUS', meta: false, ctrl: false, alt: false,
    context, group: context === 'reading' ? 'Reading' : context === 'grid' ? 'DateCells' : 'Global',
    description, customizable: true };
}

export function isTypingTarget(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]');
}
// Native Escape still dismisses editors; a remapped printable cancel never eats text.
export function canDismiss(event, binding, modalOpen = false) {
  return (event.key === 'Escape' && (modalOpen || isTypingTarget(event.target))) || (!isTypingTarget(event.target) && matchKeybind(event, binding));
}
export function jumpDigit(event, resolved) {
  for (let digit = 0; digit <= 9; digit++) {
    if (matchKeybind(event, resolved[`JUMP_${digit}`])) return String(digit);
  }
  return null;
}

// Human copy for fixedReason badges (Settings + help panel).
export const FIXED_REASON_LABELS = {
  navigation:    'navigation',
  cancel:        'cancel key',
  foundational:  'core editing',
  mouse:         'mouse gesture',
  system:        'browser/system',
  accessibility: 'accessibility',
  guarded:       'guarded delete',
};

// Display order for groups in Settings and KeyboardHelp.
export const KB_GROUP_ORDER = ['Global', 'Navigation', 'Task Grid', 'DateCells', 'Reading', 'Mouse gestures'];

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
  const shiftedDigits = ')!@#$%^&*(';
  if (binding.key.length === 1 && shiftedDigits.includes(binding.key)) {
    binding = { ...binding, key: String(shiftedDigits.indexOf(binding.key)), shift: true };
  }
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
  if (!binding) return false;
  const n = normalizeBinding(binding);
  // Shift+digit is read from event.code so Quick Jump works on any layout
  // (b15a9f6 behavior); other keys use event.key.
  const key = event.shiftKey && /^Digit[0-9]$/.test(event.code || '') ? event.code[5] : event.key;
  const actual = normalizeBinding({ key, shift: event.shiftKey, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey });
  if (actual.key.toLowerCase() !== n.key.toLowerCase()) return false;
  if (!isSymbolKey(n.key) && actual.shift !== n.shift) return false;
  if (actual.meta !== n.meta || actual.ctrl !== n.ctrl || actual.alt !== n.alt) return false;
  return true;
}

// ---------------------------------------------------------------------------
// captureEventToBinding — convert a KeyboardEvent to a storable binding
// Returns null for pure modifier keys (Shift, Ctrl, etc.).
// Symbol keys: shift is normalized to false (symbol encodes its own shift state).
// ---------------------------------------------------------------------------
export function captureEventToBinding(event) {
  if (['Shift', 'Control', 'Meta', 'Alt', 'CapsLock'].includes(event.key)) return null;
  // Shift+digit records the digit (layout-independent, as matchKeybind reads it).
  if (event.shiftKey && /^Digit[0-9]$/.test(event.code || '')) {
    return { key: event.code[5], shift: true, meta: !!event.metaKey, ctrl: !!event.ctrlKey, alt: !!event.altKey };
  }
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
// Reject modifier-only/unidentified events. Conflicts are validated separately.
export function isReservedBinding(binding) {
  return ['Shift', 'Control', 'Meta', 'Alt', 'CapsLock', 'Unidentified', 'Dead'].includes(binding.key);
}

// ---------------------------------------------------------------------------
// findBindingConflict — returns the conflicting action ID, or null.
// Validates against ALL resolved bindings (fixed + customizable), but only
// within the same conflict scope: two actions may share a binding when their
// contexts differ and neither is 'global' (e.g. N = new task on the Task Grid
// and N = new book on Reading are unambiguous — only one page listens at a
// time). A 'global' action's binding must be unique everywhere.
// Uses bindingSignature for comparison, which already normalizes symbol shift.
// ---------------------------------------------------------------------------
export function findBindingConflict(binding, forAction, resolved) {
  const sig = bindingSignature(binding);
  const forCtx = KEYBINDS[forAction]?.context ?? 'global';
  for (const [action, b] of Object.entries(resolved)) {
    if (action === forAction) continue;
    if (bindingSignature(b) !== sig) continue;
    const ctx = KEYBINDS[action]?.context ?? 'global';
    if (ctx === forCtx || ctx === 'global' || forCtx === 'global'
        || (ctx === 'sheet' && ['grid', 'reading'].includes(forCtx))
        || (forCtx === 'sheet' && ['grid', 'reading'].includes(ctx))) return action;
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
      result[action] = { ...binding, ...normalizeBinding(override) };
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
// FIXED_SHORTCUTS — non-customizable shortcuts/gestures shown in the Settings
// panel. These are outside KEYBINDS because they are not single-action
// bindings (chords, mouse gestures, multi-key flows). `reason` maps to
// FIXED_REASON_LABELS and explains why the entry cannot be rebound.
// ---------------------------------------------------------------------------
export const FIXED_SHORTCUTS = [
  { group: 'Mouse gestures', keys: 'Click ☐ / ✓', reason: 'mouse', description: 'Increment completion count.' },
  { group: 'Mouse gestures', keys: '⇧Click / drag', reason: 'mouse', description: 'Select a rectangular range.' },
  { group: 'Mouse gestures', keys: '⌥Click', reason: 'mouse', description: 'Select without toggling.' },
  { group: 'Mouse gestures', keys: 'Dbl-click', reason: 'mouse', description: 'Edit a text cell inline.' },
];

// ---------------------------------------------------------------------------
// KEYBIND_HELP — structured data for KeyboardHelp panel.
// Items with `action` get their label from the resolved binding at render time.
// Items without `action` use the static `keys` string (combined nav rows).
// ---------------------------------------------------------------------------
export const KEYBIND_HELP = KB_GROUP_ORDER.map(group => ({
  group,
  items: [
    ...Object.entries(KEYBINDS).filter(([, b]) => b.group === group).map(([action, b]) => ({ action, desc: b.description })),
    ...FIXED_SHORTCUTS.filter(b => b.group === group).map(b => ({ keys: b.keys, desc: b.description })),
  ],
}));
