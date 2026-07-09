// Appearance preferences (P10.0) — appearance mode (system/light/dark),
// accent theme, and background-motion level.
//
// Local UI preferences only: stored in localStorage (taskos-appearance),
// applied as data attributes on <html>, never persisted to the backend and
// never included in JSON backups — consistent with theme/column-width
// handling. The visual-theme select (sheets/paper) keeps its existing
// taskos-theme key untouched.

const LS_KEY = 'taskos-appearance';

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

const DEFAULTS = { mode: 'system', accent: 'blue', motion: 'subtle' };

export function loadAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return {
      mode:   APPEARANCE_MODES.some((m) => m.value === saved.mode)   ? saved.mode   : DEFAULTS.mode,
      accent: ACCENT_THEMES.some((a) => a.value === saved.accent)    ? saved.accent : DEFAULTS.accent,
      motion: MOTION_LEVELS.some((l) => l.value === saved.motion)    ? saved.motion : DEFAULTS.motion,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function systemPrefersDark() {
  return typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

// Applies data attributes to <html> and notifies listeners (TopBarNetwork
// reacts to motion changes without a remount).
export function applyAppearance(prefs) {
  const resolved = prefs.mode === 'system'
    ? (systemPrefersDark() ? 'dark' : 'light')
    : prefs.mode;
  const el = document.documentElement;
  el.dataset.appearance = resolved;
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
