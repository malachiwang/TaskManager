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
// KEYBINDS — the shortcut registry: one entry per keyboard-triggered action.
//
// Fields:
//   key/shift/meta/ctrl/alt — the DEFAULT binding (current app defaults).
//   label        — display fallback for the default binding.
//   description  — help text shown in Settings and the help panel.
//   group        — display grouping (Settings / help panel sections).
//   context      — conflict scope: 'global' | 'grid' | 'reading'. Two actions
//                  may share a binding only if their contexts differ AND
//                  neither is 'global' (a global binding must stay unique).
//   customizable — whether the Settings UI offers rebinding. Non-customizable
//                  entries carry fixedReason explaining why.
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
    customizable: false, fixedReason: 'foundational',
    requiresSelection: true,
  },
  DECREMENT: {
    key: 'Enter', shift: true, meta: false, ctrl: false, alt: false,
    label: '⇧↵',
    description: 'Decrement completion for selected cell',
    group: 'Task Grid', context: 'grid',
    customizable: false, fixedReason: 'foundational',
    requiresSelection: true,
  },
  MOVE_LEFT: {
    key: 'ArrowLeft', shift: false, meta: false, ctrl: false, alt: false,
    label: '←',
    description: 'Move selection left',
    group: 'Navigation', context: 'global',
    customizable: false, fixedReason: 'navigation',
    requiresSelection: false,
  },
  MOVE_RIGHT: {
    key: 'ArrowRight', shift: false, meta: false, ctrl: false, alt: false,
    label: '→',
    description: 'Move selection right',
    group: 'Navigation', context: 'global',
    customizable: false, fixedReason: 'navigation',
    requiresSelection: false,
  },
  MOVE_UP: {
    key: 'ArrowUp', shift: false, meta: false, ctrl: false, alt: false,
    label: '↑',
    description: 'Move selection up',
    group: 'Navigation', context: 'global',
    customizable: false, fixedReason: 'navigation',
    requiresSelection: false,
  },
  MOVE_DOWN: {
    key: 'ArrowDown', shift: false, meta: false, ctrl: false, alt: false,
    label: '↓',
    description: 'Move selection down',
    group: 'Navigation', context: 'global',
    customizable: false, fixedReason: 'navigation',
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
    customizable: false, fixedReason: 'cancel',
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
export const KB_GROUP_ORDER = ['Global', 'Navigation', 'Task Grid', 'DateCells', 'Reading', 'Fixed gestures'];

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
    if (ctx === forCtx || ctx === 'global' || forCtx === 'global') return action;
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
// FIXED_SHORTCUTS — non-customizable shortcuts/gestures shown in the Settings
// panel. These are outside KEYBINDS because they are not single-action
// bindings (chords, mouse gestures, multi-key flows). `reason` maps to
// FIXED_REASON_LABELS and explains why the entry cannot be rebound.
// ---------------------------------------------------------------------------
export const FIXED_SHORTCUTS = [
  {
    group: 'Navigation',
    keys: '⇧ + digits',
    reason: 'navigation',
    description: 'Opens the Jump panel and fills it live. No selection: Enter confirms row jump N. With selection: Enter confirms date column N. Hold ⇧, type digits, release ⇧ or press ↵.',
  },
  {
    group: 'Navigation',
    keys: '⇧ + arrows',
    reason: 'navigation',
    description: 'Extend the date-cell range selection from the anchor.',
  },
  {
    group: 'DateCells',
    keys: 'Del / ⌫',
    reason: 'guarded',
    description: 'Convert selected cell(s) to blank text cells — completion history is preserved; Restore checkbox reveals it again.',
  },
  {
    group: 'Reading',
    keys: '↵',
    reason: 'foundational',
    description: 'Add a page checkpoint for the selected book.',
  },
  {
    group: 'Reading',
    keys: 'Del / ⌫',
    reason: 'guarded',
    description: 'Delete the selected book (always asks for confirmation first).',
  },
  {
    group: 'Fixed gestures',
    keys: 'Click ☐ / ✓',
    reason: 'mouse',
    description: 'Increment completion count.',
  },
  {
    group: 'Fixed gestures',
    keys: '⇧Click / drag',
    reason: 'mouse',
    description: 'Select a rectangular date-cell range (never toggles).',
  },
  {
    group: 'Fixed gestures',
    keys: '⌥Click',
    reason: 'mouse',
    description: 'Select a date cell without toggling it.',
  },
  {
    group: 'Fixed gestures',
    keys: 'Dbl-click',
    reason: 'mouse',
    description: 'Edit a text cell inline.',
  },
  {
    group: 'Fixed gestures',
    keys: 'Tab / ⇧Tab',
    reason: 'accessibility',
    description: 'Standard focus movement — never remapped.',
  },
];

// ---------------------------------------------------------------------------
// KEYBIND_HELP — structured data for KeyboardHelp panel.
// Items with `action` get their label from the resolved binding at render time.
// Items without `action` use the static `keys` string (combined nav rows).
// ---------------------------------------------------------------------------
export const KEYBIND_HELP = [
  {
    group: 'Global',
    items: [
      { action: 'TOGGLE_HELP',     desc: 'Show or hide keyboard shortcuts' },
      { action: 'CLEAR_SELECTION', desc: 'Close modal / collapse range / clear selection' },
    ],
  },
  {
    group: 'Navigation',
    items: [
      { keys: '↑ / ↓', desc: 'Move selection between rows' },
      { keys: '← / →', desc: 'Move selection between dates' },
      { keys: '⇧ + arrows', desc: 'Extend date-cell range selection' },
      { keys: '⇧ + digits', desc: 'Opens Jump panel live · release ⇧ or ↵ to confirm · no selection: row N · with selection: date column N' },
    ],
  },
  {
    group: 'Task Grid',
    items: [
      { action: 'INCREMENT',    desc: 'Increment completion for selected date cell' },
      { action: 'DECREMENT',    desc: 'Decrement completion for selected date cell' },
      { action: 'EDIT_TASK',    desc: 'Open task details (scheduling, status, priority, notes)' },
      { action: 'NEW_TASK',     desc: 'Add a new task' },
      { action: 'FOCUS_SEARCH', desc: 'Focus the task search box' },
    ],
  },
  {
    group: 'DateCells',
    note: 'To type into a date cell, first delete the checkbox with Del/⌫. This creates a blank text cell while preserving hidden completion state — then typing edits the text cell.',
    items: [
      { keys: 'Del / ⌫',  desc: 'Convert selected cell(s) to blank text cells — completion history is kept; Restore checkbox brings it back' },
      { keys: 'Type text', desc: 'Edit a TEXT cell in place (replaces its text; Esc cancels). Checkbox cells ignore typing.' },
      { keys: '↵ on text', desc: 'Open the text-cell editor' },
    ],
  },
  {
    group: 'Reading',
    items: [
      { action: 'READING_NEW_BOOK',     desc: 'Add a new book' },
      { action: 'READING_EDIT_BOOK',    desc: 'Edit the selected book' },
      { action: 'READING_FOCUS_SEARCH', desc: 'Focus the reading search box' },
      { keys: '↵',        desc: 'Add a page checkpoint for the selected book' },
      { keys: 'Del / ⌫', desc: 'Delete the selected book (asks for confirmation)' },
    ],
  },
  {
    group: 'Fixed gestures',
    items: [
      { keys: 'Click cell',   desc: 'Select date cell (no mutation)' },
      { keys: 'Click ☐ / ✓', desc: 'Increment completion count' },
      { keys: '⇧Click / drag', desc: 'Select a rectangular date-cell range (never toggles)' },
      { keys: '⌥Click',      desc: 'Select a date cell without toggling it' },
      { keys: 'Dbl-click',    desc: 'Enter inline edit mode for text cells' },
    ],
  },
];
