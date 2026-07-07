// Pure helpers that classify the enriched task list (from GET /tasks) into the
// dashboard's action-oriented buckets (P6.0A). No backend calls, no side effects.
// All urgency banding comes from the shared urgency.js module — this file must
// NOT introduce fresh numeric urgency thresholds.
import { urgencyBandKey, URG_HIGH } from './urgency.js';

// Tunables (task-shape thresholds, not urgency thresholds).
const QUICK_WIN_INTERVAL = 7;   // "frequent enough" to be a quick win (days)
const SHORT_INTERVAL     = 3;   // "daily-ish"
const STALE_RATIO        = 3;   // overdue_ratio considered long-stale
const VERY_STALE_RATIO   = 4;   // overdue_ratio considered abandoned/bloat
const NEGLECT_RATIO      = 2;   // section-pressure "neglected" cutoff
const HIGH_PRIORITY      = 8;

const BAND_RANK = { none: 0, low: 1, noticeable: 2, high: 3, critical: 4 };
const bandRank = (key) => BAND_RANK[key] ?? 0;
const band = (t) => urgencyBandKey(t.urgency ?? 0);
const ratio = (t) => t.overdue_ratio ?? 0;
const isOverdue = (t) => (t.days_overdue ?? 0) > 0;

// Chain comparators: first non-zero result wins.
function cmpChain(...cmps) {
  return (a, b) => {
    for (const c of cmps) { const r = c(a, b); if (r) return r; }
    return 0;
  };
}

// ── Population predicates ──────────────────────────────────────────────────

export function getTaskSection(task) {
  return (task.section && task.section.trim()) || '(no section)';
}
export function getTaskCategory(task) {
  return (task.category && task.category.trim()) || '';
}
export function isUncategorized(task) {
  return getTaskCategory(task) === '';
}

// Hiatus (paused), Finished (ended), or scheduled/future → never in action buckets.
export function isFutureOrInactiveTask(task) {
  return task.is_paused === 1 || task.is_ended === true || task.is_scheduled === true;
}

// Never done: no completion history and no manual last-done override.
export function isNeverDoneTask(task) {
  return !task.latest_completion && !task.manual_last_done_override;
}

// Established: has a real cadence (completion history or manual override).
export function isEstablishedTask(task) {
  return !isNeverDoneTask(task);
}

// Actionable: active (not paused/finished/scheduled) and carrying some pressure.
export function isActionableTask(task) {
  return !isFutureOrInactiveTask(task) && (task.urgency ?? 0) > 0;
}

const VAGUE_NAMES = new Set(['todo', 'task', 'stuff', 'misc', 'thing', 'notes', 'note']);
export function isVagueName(task) {
  const n = (task.name || '').trim().toLowerCase();
  return n.length <= 3 || VAGUE_NAMES.has(n);
}

const READING_RE = /\b(read|reading|book|chapter|pages?)\b/i;
export function looksLikeReading(task) {
  return READING_RE.test(task.name || '') || READING_RE.test(task.category || '');
}

// ── Do Now ─────────────────────────────────────────────────────────────────
// Established, overdue, meaningfully urgent tasks — the few things you normally
// do and are now behind on. Never-done tasks are only admitted when clearly
// important (very high priority, or high/critical + categorized + not abandoned);
// otherwise they belong in Decide/Clarify so they never dominate Do Now.
export function getDoNowTasks(tasks) {
  const rows = tasks.filter((t) => {
    if (!isActionableTask(t) || !isOverdue(t)) return false;
    if (bandRank(band(t)) < bandRank('noticeable')) return false;
    if (isEstablishedTask(t)) return true;
    return (t.priority ?? 0) >= HIGH_PRIORITY
      || (bandRank(band(t)) >= bandRank('high') && !isUncategorized(t) && ratio(t) < VERY_STALE_RATIO);
  });
  rows.sort(cmpChain(
    (a, b) => (b.urgency ?? 0) - (a.urgency ?? 0),
    (a, b) => ratio(b) - ratio(a),
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    (a, b) => (b.days_overdue ?? 0) - (a.days_overdue ?? 0),
    (a, b) => a.id - b.id,
  ));
  return rows.slice(0, 5);
}

// ── Likely Quick Wins ────────────────────────────────────────────────────────
// Overdue, at least noticeable, and either frequent (short interval) or a
// high/critical low-priority task — likely to shed pressure fast. Excludes Do Now.
export function getQuickWinTasks(tasks, doNowIds = []) {
  const excl = new Set(doNowIds);
  const rows = tasks.filter((t) => {
    if (!isActionableTask(t) || excl.has(t.id) || !isOverdue(t)) return false;
    // Established only: a quick win is a recurring thing you actually do and can
    // knock out. Never-done tasks (whose urgency is inflated by age) belong in
    // Decide/Clarify, so they never masquerade as quick wins.
    if (!isEstablishedTask(t)) return false;
    if (bandRank(band(t)) < bandRank('noticeable')) return false;
    const frequent = (t.interval_days ?? Infinity) <= QUICK_WIN_INTERVAL;
    const highButLowPriority = bandRank(band(t)) >= bandRank('high') && (t.priority ?? 5) <= 6;
    return frequent || highButLowPriority;
  });
  rows.sort(cmpChain(
    (a, b) => ratio(b) - ratio(a),
    (a, b) => (b.urgency ?? 0) - (a.urgency ?? 0),
    (a, b) => (a.interval_days ?? Infinity) - (b.interval_days ?? Infinity),
    (a, b) => a.id - b.id,
  ));
  return rows.slice(0, 5);
}

// ── Decide / Clarify ─────────────────────────────────────────────────────────
// Tasks whose right move is a decision (categorize, rename, lower frequency,
// hiatus, archive, convert to Reading) rather than "do now". Returns objects
// { task, chips[], suggestion }.
export function getTriageTasks(tasks) {
  const rows = [];
  for (const t of tasks) {
    if (isFutureOrInactiveTask(t)) continue;
    const never = isNeverDoneTask(t);
    const uncat = isUncategorized(t);
    const stale = ratio(t) >= STALE_RATIO;
    const daily = (t.interval_days ?? Infinity) <= SHORT_INTERVAL;
    const vague = isVagueName(t);
    const reading = looksLikeReading(t);

    const needsDecision =
      (never && (stale || uncat || vague)) ||
      (never && daily && ratio(t) >= VERY_STALE_RATIO) ||
      reading;
    if (!needsDecision) continue;

    const chips = [];
    if (never) chips.push('Never done');
    if (uncat) chips.push('Uncategorized');
    if (never && stale) chips.push('Possibly stale');
    if (never && daily && ratio(t) >= VERY_STALE_RATIO) chips.push('Frequency may be wrong');
    if (reading) chips.push('Move to Reading?');
    if (vague) chips.push('Needs rename');
    if (chips.length === 0) continue;

    rows.push({ task: t, chips, suggestion: triageSuggestion(t, { never, uncat, stale, daily, reading }) });
  }
  rows.sort(cmpChain(
    (a, b) => (b.task.urgency ?? 0) - (a.task.urgency ?? 0),
    (a, b) => (b.task.days_since ?? 0) - (a.task.days_since ?? 0),
    (a, b) => a.task.id - b.task.id,
  ));
  return rows.slice(0, 6);
}

function triageSuggestion(t, f) {
  if (f.reading) return 'Consider moving tracking to the Reading Sheet.';
  if (f.never && f.daily) return 'Decide: do once, lower the frequency, or move to Hiatus.';
  if (f.uncat) return 'Categorize this so pressure maps stay useful.';
  if (f.never) return 'Decide: do once, archive, or move to Hiatus.';
  return 'Review and clarify this task.';
}

// ── System Hygiene ───────────────────────────────────────────────────────────
// Aggregate system-cleanup signals. Ranked by severity, capped at 4 cards.
export function getSystemHygieneInsights(tasks) {
  const active = tasks.filter((t) => !isFutureOrInactiveTask(t));
  const n = active.length;
  const out = [];
  if (n === 0) return out;

  const uncat = active.filter(isUncategorized);
  const uncatAvg = uncat.length ? uncat.reduce((s, t) => s + (t.urgency ?? 0), 0) / uncat.length : 0;
  if (uncat.length / n >= 0.4 || uncatAvg >= URG_HIGH) {
    out.push({ key: 'uncategorized', severity: uncat.length,
      title: 'Uncategorized pressure dominates',
      body: `${uncat.length} of ${n} active tasks have no category.`,
      action: 'Categorize the top uncategorized tasks.' });
  }
  const never = active.filter(isNeverDoneTask);
  if (never.length / n >= 0.25 || never.length >= 8) {
    out.push({ key: 'neverdone', severity: never.length,
      title: 'Many never-completed active tasks',
      body: `${never.length} active tasks have never been logged.`,
      action: 'Do once, clarify, archive, or move to Hiatus.' });
  }
  const dailyCrit = active.filter((t) => (t.interval_days ?? Infinity) <= 1 && band(t) === 'critical');
  if (dailyCrit.length >= 3) {
    out.push({ key: 'dailycrit', severity: dailyCrit.length,
      title: 'Too many daily critical tasks',
      body: `${dailyCrit.length} daily tasks are critical.`,
      action: 'Some daily tasks may be misconfigured.' });
  }
  const staleUncat = active.filter((t) => isUncategorized(t) && ratio(t) >= STALE_RATIO);
  if (staleUncat.length >= 3) {
    out.push({ key: 'staleuncat', severity: staleUncat.length,
      title: 'Long-stale uncategorized tasks',
      body: `${staleUncat.length} uncategorized tasks are ${STALE_RATIO}×+ overdue.`,
      action: 'Categorize or retire these.' });
  }
  const reading = active.filter(looksLikeReading);
  if (reading.length >= 1) {
    out.push({ key: 'reading', severity: reading.length,
      title: 'Reading tasks still in the task grid',
      body: `${reading.length} active task${reading.length !== 1 ? 's' : ''} look like reading.`,
      action: 'Consider moving reading tracking to the Reading Sheet.' });
  }
  const highCrit = active.filter((t) => bandRank(band(t)) >= bandRank('high'));
  if (highCrit.length >= 4) {
    const bySection = {};
    for (const t of highCrit) { const s = getTaskSection(t); bySection[s] = (bySection[s] || 0) + 1; }
    const top = Object.entries(bySection).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] / highCrit.length >= 0.5) {
      out.push({ key: 'concentration', severity: top[1],
        title: 'Section pressure concentration',
        body: `${top[0]} holds ${top[1]} of ${highCrit.length} high/critical tasks.`,
        action: 'This section is carrying most of the pressure.' });
    }
  }
  out.sort((a, b) => b.severity - a.severity);
  return out.slice(0, 4);
}

// ── Section Pressure ─────────────────────────────────────────────────────────
export function getSectionPressure(tasks) {
  const active = tasks.filter((t) => !isFutureOrInactiveTask(t));
  const map = new Map();
  for (const t of active) {
    const key = getTaskSection(t);
    if (!map.has(key)) {
      map.set(key, {
        section: key, count: 0, sumUrg: 0, maxUrg: 0,
        highCrit: 0, neglected: 0, neverDone: 0, uncategorized: 0,
      });
    }
    const s = map.get(key);
    s.count++;
    s.sumUrg += t.urgency ?? 0;
    s.maxUrg = Math.max(s.maxUrg, t.urgency ?? 0);
    if (bandRank(band(t)) >= bandRank('high')) s.highCrit++;
    if (ratio(t) >= NEGLECT_RATIO || (t.days_since ?? 0) >= 30) s.neglected++;
    if (isNeverDoneTask(t)) s.neverDone++;
    if (isUncategorized(t)) s.uncategorized++;
  }
  const rows = [...map.values()].map((s) => ({ ...s, avgUrg: s.count ? s.sumUrg / s.count : 0 }));
  rows.sort(cmpChain(
    (a, b) => b.avgUrg - a.avgUrg,
    (a, b) => b.highCrit - a.highCrit,
    (a, b) => a.section.localeCompare(b.section),
  ));
  return rows;
}

// ── Activity summary ─────────────────────────────────────────────────────────
export function getActivitySummary(completionTrend = []) {
  const total30d = completionTrend.reduce((s, d) => s + d.count, 0);
  const done7d = completionTrend.slice(-7).reduce((s, d) => s + d.count, 0);
  const prev7d = completionTrend.slice(-14, -7).reduce((s, d) => s + d.count, 0);
  const paceChangePct = prev7d > 0 ? Math.round(((done7d - prev7d) / prev7d) * 100) : null;
  const bestDay = Math.max(...completionTrend.map((d) => d.count), 0);
  const activeDays7d = completionTrend.slice(-7).filter((d) => d.count > 0).length;
  return { total30d, done7d, prev7d, paceChangePct, bestDay, activeDays7d };
}
