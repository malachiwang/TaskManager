// Saved views — localStorage persistence for named grid configurations.
//
// A saved view captures: activeFilter, groupMode, searchQuery.
// It does NOT capture: selectedCell, viewMonth, colWidths, modal state.
//
// localStorage key: taskos-saved-views

import { FILTER_LABELS } from './filters.js';
import { GROUP_MODE_LABELS } from './grouping.js';

const LS_KEY  = 'taskos-saved-views';
const VERSION = 1;

// ---------------------------------------------------------------------------
// Load / write
// ---------------------------------------------------------------------------

export function loadSavedViews() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return _empty();
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || data.version !== VERSION) return _empty();
    const views = Array.isArray(data.views)
      ? data.views.filter(validateView)
      : [];
    return { version: VERSION, views };
  } catch {
    return _empty();
  }
}

export function writeSavedViews(data) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch {
    // localStorage unavailable or full — silently skip
  }
}

function _empty() {
  return { version: VERSION, views: [] };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateView(view) {
  return (
    view !== null &&
    typeof view === 'object' &&
    typeof view.id === 'string' && view.id.length > 0 &&
    typeof view.name === 'string' && view.name.trim().length > 0 &&
    typeof view.filter === 'string' &&
    typeof view.groupMode === 'string' &&
    typeof view.searchQuery === 'string'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildDefaultName(filter, groupMode) {
  const f = FILTER_LABELS[filter]    || filter;
  const g = GROUP_MODE_LABELS[groupMode] || groupMode;
  return `${f} · ${g}`;
}

export function makeSavedView({ name, filter, secondary, groupMode, searchQuery }) {
  const now = new Date().toISOString();
  return {
    id:          Date.now().toString(),
    name:        name.trim().slice(0, 40),
    filter,
    // Secondary filter toggles (P10.0). Optional — older views without this
    // key still validate and apply with no toggles.
    secondary:   Array.isArray(secondary) ? [...secondary] : [],
    groupMode,
    searchQuery: searchQuery || '',
    createdAt:   now,
    updatedAt:   now,
  };
}
