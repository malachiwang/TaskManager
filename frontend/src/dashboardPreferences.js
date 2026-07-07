// Frontend-only dashboard UI preferences (P6.0A-fix5), persisted to localStorage.
// These are display/noise preferences only — they never touch task data, status,
// urgency, or any backend/SQLite state. Storage is resilient: missing or corrupt
// values fall back to sensible defaults and never crash the dashboard.

const NS = 'taskmanager.dashboard.v1.';
const KEYS = {
  hiddenSections: NS + 'hiddenSections',
  hiddenCards: NS + 'hiddenInsightCards',
  dismissed: NS + 'dismissedRecommendations',
  snoozed: NS + 'snoozedRecommendations',
};

function safeGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const val = JSON.parse(raw);
    return val && typeof val === 'object' ? val : fallback;
  } catch {
    return fallback;
  }
}

function safeSet(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* localStorage unavailable/full — preferences simply don't persist */
  }
}

// Load all preferences as a single object. Shapes:
//   hiddenSections / hiddenCards: { [key]: true }
//   dismissed: { "taskId:type": { taskId, type, dismissedAt } }
//   snoozed:   { "taskId:type": { taskId, type, snoozeUntil } }
export function loadPreferences() {
  return {
    hiddenSections: safeGet(KEYS.hiddenSections, {}),
    hiddenCards: safeGet(KEYS.hiddenCards, {}),
    dismissed: safeGet(KEYS.dismissed, {}),
    snoozed: safeGet(KEYS.snoozed, {}),
  };
}

export function recommendationKey(taskId, type) {
  return `${taskId}:${type}`;
}

// A recommendation is active (visible) unless it is dismissed or currently snoozed.
export function isRecommendationActive(prefs, taskId, type) {
  const k = recommendationKey(taskId, type);
  if (prefs.dismissed[k]) return false;
  const sn = prefs.snoozed[k];
  if (sn && sn.snoozeUntil && new Date(sn.snoozeUntil) > new Date()) return false;
  return true;
}

export function dismissRecommendation(prefs, taskId, type) {
  const k = recommendationKey(taskId, type);
  const dismissed = { ...prefs.dismissed, [k]: { taskId, type, dismissedAt: new Date().toISOString() } };
  safeSet(KEYS.dismissed, dismissed);
  return { ...prefs, dismissed };
}

export function snoozeRecommendation(prefs, taskId, type, days = 30) {
  const k = recommendationKey(taskId, type);
  const snoozeUntil = new Date(Date.now() + days * 86400000).toISOString();
  const snoozed = { ...prefs.snoozed, [k]: { taskId, type, snoozeUntil } };
  safeSet(KEYS.snoozed, snoozed);
  return { ...prefs, snoozed };
}

export function resetDismissals(prefs) {
  safeSet(KEYS.dismissed, {});
  safeSet(KEYS.snoozed, {});
  return { ...prefs, dismissed: {}, snoozed: {} };
}

export function hasDismissals(prefs) {
  return Object.keys(prefs.dismissed).length > 0 || Object.keys(prefs.snoozed).length > 0;
}

export function toggleSection(prefs, key) {
  const hiddenSections = { ...prefs.hiddenSections };
  if (hiddenSections[key]) delete hiddenSections[key];
  else hiddenSections[key] = true;
  safeSet(KEYS.hiddenSections, hiddenSections);
  return { ...prefs, hiddenSections };
}

export function toggleCard(prefs, key) {
  const hiddenCards = { ...prefs.hiddenCards };
  if (hiddenCards[key]) delete hiddenCards[key];
  else hiddenCards[key] = true;
  safeSet(KEYS.hiddenCards, hiddenCards);
  return { ...prefs, hiddenCards };
}

export function resetVisibility(prefs) {
  safeSet(KEYS.hiddenSections, {});
  safeSet(KEYS.hiddenCards, {});
  return { ...prefs, hiddenSections: {}, hiddenCards: {} };
}
