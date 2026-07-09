// Appearance preferences (P10.0/P10.1) — appearance mode (system/light/dark),
// visual theme, accent theme, and background-motion level.
//
// Local UI preferences only: stored in localStorage (taskos-appearance),
// applied as data attributes on <html>, never persisted to the backend and
// never included in JSON backups — consistent with column-width handling.
//
// P10.1 folds the old standalone visual-theme select (taskos-theme:
// 'sheets' | 'paper') into this module as the `theme` field, expanded to six
// curated token-only themes. The legacy key is read once for migration
// ('sheets' → 'classic'); the CSS keeps using html[data-theme="…"] selectors.

const LS_KEY = 'taskos-appearance';
const LEGACY_THEME_KEY = 'taskos-theme';

export const APPEARANCE_MODES = [
  { value: 'system', label: 'System' },
  { value: 'light',  label: 'Light' },
  { value: 'dark',   label: 'Dark' },
];

// Blue is the pre-P10.0 default accent, so existing installs look identical
// until the user picks something else.
export const ACCENT_THEMES = [
  { value: 'blue',     label: 'Blue',     swatch: '#3a7bd5' },
  { value: 'graphite', label: 'Graphite', swatch: '#5f6368' },
  { value: 'green',    label: 'Green',    swatch: '#1e8e3e' },
  { value: 'purple',   label: 'Purple',   swatch: '#7c4dff' },
  { value: 'rose',     label: 'Rose',     swatch: '#c2185b' },
  { value: 'amber',    label: 'Amber',    swatch: '#b26a00' },
];

export const MOTION_LEVELS = [
  { value: 'off',    label: 'Off' },
  { value: 'subtle', label: 'Subtle' },
  { value: 'lively', label: 'Lively' },
];

// Curated visual themes (P10.1) — token-only surface palettes. No shape,
// layout, or component changes; urgency semantic colors are never themed.
// `swatch` drives the mini preview in Settings: [background, panel, border,
// header]. `darkBase: true` means the theme implies a dark appearance
// regardless of the Light/Dark/System mode (Midnight).
export const VISUAL_THEMES = [
  { value: 'classic',  label: 'Classic Sheet', swatch: ['#f5f5f5', '#ffffff', '#dddddd', '#1c1c1c'] },
  { value: 'paper',    label: 'Soft Paper',    swatch: ['#f4f1ea', '#fbfaf6', '#e6e0d2', '#1c1c1c'] },
  { value: 'graphite', label: 'Graphite',      swatch: ['#f2f2f3', '#fbfbfc', '#d9d9dc', '#232326'] },
  { value: 'ocean',    label: 'Ocean',         swatch: ['#edf2f6', '#f9fbfd', '#d2dee7', '#16222c'] },
  { value: 'forest',   label: 'Forest',        swatch: ['#eef2ee', '#f8faf7', '#d4e0d4', '#182018'] },
  { value: 'midnight', label: 'Midnight',      swatch: ['#101014', '#17171d', '#2e2e38', '#0a0a0e'], darkBase: true },
];

const DEFAULTS = { mode: 'system', theme: 'classic', accent: 'blue', motion: 'subtle' };

// One-time migration source: the pre-P10.1 standalone visual-theme key.
function legacyTheme() {
  try {
    const legacy = localStorage.getItem(LEGACY_THEME_KEY);
    if (legacy === 'paper') return 'paper';
    return 'classic'; // 'sheets' and anything else map to the default look
  } catch {
    return 'classic';
  }
}

export function loadAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return {
      mode:   APPEARANCE_MODES.some((m) => m.value === saved.mode) ? saved.mode : DEFAULTS.mode,
      theme:  VISUAL_THEMES.some((t) => t.value === saved.theme)   ? saved.theme : legacyTheme(),
      accent: ACCENT_THEMES.some((a) => a.value === saved.accent)  ? saved.accent : DEFAULTS.accent,
      motion: MOTION_LEVELS.some((l) => l.value === saved.motion)  ? saved.motion : DEFAULTS.motion,
    };
  } catch {
    return { ...DEFAULTS, theme: legacyTheme() };
  }
}

function systemPrefersDark() {
  return typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

// Applies data attributes to <html> and notifies listeners (TopBarNetwork
// reacts to motion changes without a remount). A darkBase theme (Midnight)
// always resolves to the dark appearance — its surfaces only make sense on a
// dark text ramp.
export function applyAppearance(prefs) {
  const themeDef = VISUAL_THEMES.find((t) => t.value === prefs.theme);
  const resolved = themeDef?.darkBase
    ? 'dark'
    : prefs.mode === 'system'
      ? (systemPrefersDark() ? 'dark' : 'light')
      : prefs.mode;
  const el = document.documentElement;
  el.dataset.appearance = resolved;
  el.dataset.theme = prefs.theme;
  el.dataset.accent = prefs.accent;
  el.dataset.motion = prefs.motion;
  window.dispatchEvent(new CustomEvent('taskos-appearance-change', { detail: prefs }));
}

export function saveAppearance(prefs) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage unavailable — preference still applies for this session
  }
  applyAppearance(prefs);
}

// Called once from App on mount: apply saved prefs and follow OS light/dark
// changes while mode is "system".
export function initAppearance() {
  applyAppearance(loadAppearance());
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const prefs = loadAppearance();
      if (prefs.mode === 'system') applyAppearance(prefs);
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
  }
}

// Current motion level for canvas components ('off' | 'subtle' | 'lively').
export function getMotionLevel() {
  return loadAppearance().motion;
}
