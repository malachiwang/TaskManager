// Unified urgency band model (P4.0B) — the single source of truth for how a
// numeric urgency (0–10, computed by backend Pressure Scoring V2) maps to a
// band key, label, CSS class, and human explanation. Grid coloring, urgency
// grouping, dashboard bins, and the Urgent filter all derive from here so the
// whole app agrees on what "low / noticeable / high / critical" means.
//
// The backend duplicates these numeric thresholds in two places for server-side
// binning (dashboard urgency_distribution and the snapshot heatmap); this file
// is canonical and the two must be kept in sync (noted in main.py).

export const URG_CRITICAL   = 9.5;
export const URG_HIGH       = 8.0;
export const URG_NOTICEABLE = 5.0;

// Ordered high → low. `min` is the inclusive lower bound for classification.
// 'low' is urgency > 0 and < NOTICEABLE; 'none' is urgency <= 0 (inactive tasks
// forced to 0: Hiatus / Finished / scheduled, plus any genuinely zero-pressure).
export const URGENCY_BANDS = [
  { key: 'critical',   label: 'Critical',   cls: 'urg-critical',   min: URG_CRITICAL },
  { key: 'high',       label: 'High',       cls: 'urg-high',       min: URG_HIGH },
  { key: 'noticeable', label: 'Noticeable', cls: 'urg-noticeable', min: URG_NOTICEABLE },
  { key: 'low',        label: 'Low',        cls: 'urg-low',        min: 0 },
  { key: 'none',       label: 'None',       cls: 'urg-none',       min: -Infinity },
];

// Classify a numeric urgency into a band key.
export function urgencyBandKey(u) {
  const v = typeof u === 'number' ? u : 0;
  if (v >= URG_CRITICAL)   return 'critical';
  if (v >= URG_HIGH)       return 'high';
  if (v >= URG_NOTICEABLE) return 'noticeable';
  if (v > 0)               return 'low';
  return 'none';
}

// CSS class for the grid/dashboard urgency color ladder.
export function urgencyClass(u) {
  return 'urg-' + urgencyBandKey(u);
}

// Human-readable band label (Critical / High / Noticeable / Low / None).
export function urgencyLabel(u) {
  const key = urgencyBandKey(u);
  return (URGENCY_BANDS.find((b) => b.key === key) || { label: 'None' }).label;
}

// Short, low-noise explanation of why a task carries the pressure it does.
// Uses lifecycle state first (inactive tasks never generate pressure), then the
// backend decomposition fields (days_overdue, overdue_ratio) + priority.
// Examples: "On hiatus", "Finished", "Scheduled for future", "On track",
// "Due soon", "Overdue by 3 days", "High priority · overdue by 5 days",
// "Long-neglected (28 days overdue)".
export function urgencyReason(task) {
  if (!task) return '';
  if (task.is_ended) return 'Finished';
  if (task.is_scheduled) return 'Scheduled for future';
  if (task.is_paused === 1) return 'On hiatus';

  const overdue = task.days_overdue ?? 0;
  const ratio = task.overdue_ratio ?? 0;
  const highPriority = (task.priority ?? 0) >= 8;

  if (overdue <= 0) {
    // Not yet past one interval.
    return ratio >= 0.75 ? 'Due soon' : 'On track';
  }

  const days = overdue === 1 ? '1 day' : `${overdue} days`;
  if (ratio >= 3) {
    return highPriority ? `High priority · long-neglected` : `Long-neglected (${days} overdue)`;
  }
  if (highPriority) return `High priority · overdue by ${days}`;
  return `Overdue by ${days}`;
}
