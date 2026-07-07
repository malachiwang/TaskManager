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
        bands: { critical: 0, high: 0, noticeable: 0, low: 0, none: 0 },
      });
    }
    const s = map.get(key);
    s.count++;
    s.sumUrg += t.urgency ?? 0;
    s.maxUrg = Math.max(s.maxUrg, t.urgency ?? 0);
    s.bands[band(t)]++;
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

// ── Per-task diagnosis ───────────────────────────────────────────────────────
// Rich, non-destructive analysis of a single task: diagnosis chips + a short
// "why" + a suggested (informational) next action. Works from existing fields.
export function diagnoseTask(task) {
  const never = isNeverDoneTask(task);
  const uncat = isUncategorized(task);
  const r = ratio(task);
  const stale = r >= STALE_RATIO;
  const daily = (task.interval_days ?? Infinity) <= SHORT_INTERVAL;
  const overdueNow = isOverdue(task);
  const bandKey = band(task);
  const highPri = (task.priority ?? 0) >= HIGH_PRIORITY;
  const reading = looksLikeReading(task);
  const days = task.days_overdue ?? 0;

  const chips = [];
  if (reading) chips.push('Move to Reading?');
  if (never) chips.push('Never done');
  else if (overdueNow) chips.push('Overdue');
  if (uncat) chips.push('Uncategorized');
  if (never && stale) chips.push('Possibly stale');
  if (never && daily && r >= VERY_STALE_RATIO) chips.push('Frequency may be wrong');
  if (highPri) chips.push('High priority');
  if (daily && !never) chips.push('Daily');
  if (bandRank(bandKey) >= bandRank('critical')) chips.push('Critical');
  else if (bandRank(bandKey) >= bandRank('high')) chips.push('High');

  let reason, action;
  if (reading) {
    reason = 'Looks like reading — likely tracked better in the Reading Sheet, and it may be inflating task pressure.';
    action = 'Consider moving tracking to the Reading Sheet, then archive or Hiatus this task.';
  } else if (never && daily && r >= VERY_STALE_RATIO) {
    reason = 'Short-interval task with no completion record and very high staleness — possibly a stale configuration.';
    action = 'Decide: do it once, lower the frequency, or move to Hiatus.';
  } else if (never && (stale || uncat)) {
    reason = `Never completed${uncat ? ' and uncategorized' : ''} — its urgency is inflated by age, not a real cadence.`;
    action = uncat ? 'Categorize it, or decide: do once / archive / Hiatus.' : 'Decide: do it once, archive, or move to Hiatus.';
  } else if (never) {
    reason = 'Never completed yet — it may simply be new.';
    action = 'Do it once to establish a cadence, or clarify it.';
  } else if (overdueNow) {
    reason = `Established recurring task, overdue by ${days} day${days !== 1 ? 's' : ''}${daily ? ' (daily)' : ''}.`;
    action = 'Do it today.';
  } else {
    reason = 'Active and roughly on track — no action needed right now.';
    action = 'Safe to defer.';
  }
  return { chips: chips.slice(0, 4), reason, action };
}

// High/critical active tasks — the pressure drivers, for the Critical/Pressure lens.
export function getCriticalHighTasks(tasks) {
  return tasks
    .filter((t) => !isFutureOrInactiveTask(t) && bandRank(band(t)) >= bandRank('high'))
    .sort(cmpChain(
      (a, b) => (b.urgency ?? 0) - (a.urgency ?? 0),
      (a, b) => a.id - b.id,
    ))
    .slice(0, 12);
}

// Compress task-by-task analysis into an overview: how active tasks split across
// the action buckets (first match wins: Do Now → Quick Win → Decide → Other).
export function getDiagnosisDistribution(tasks, doNowIds = [], quickWinIds = [], triageIds = []) {
  const active = tasks.filter((t) => !isFutureOrInactiveTask(t));
  const dn = new Set(doNowIds), qw = new Set(quickWinIds), tr = new Set(triageIds);
  const out = { doNow: 0, quick: 0, decide: 0, other: 0, total: active.length };
  for (const t of active) {
    if (dn.has(t.id)) out.doNow++;
    else if (qw.has(t.id)) out.quick++;
    else if (tr.has(t.id)) out.decide++;
    else out.other++;
  }
  return out;
}

// Count active tasks in each urgency band (for the compact composition bar).
// Uses the shared band model — no fresh thresholds.
export function getUrgencyComposition(tasks) {
  const active = tasks.filter((t) => !isFutureOrInactiveTask(t));
  const out = { critical: 0, high: 0, noticeable: 0, low: 0, none: 0 };
  for (const t of active) out[band(t)]++;
  return out;
}

// ── Pressure Reducers (Part A) ───────────────────────────────────────────────
// Estimated leverage of completing a task: current urgency, weighted up for
// frequent tasks (they rebuild pressure fast, so clearing them relieves the most
// recurring load) and for overdue tasks. Output is an honest relief *tier* + a
// relative bar — no fake "points reduced". Ranked differently from Do Now
// (which is pure urgency), so it surfaces high-leverage recurring work.
export function getPressureReducers(tasks) {
  const scored = tasks
    .filter((t) => isActionableTask(t) && bandRank(band(t)) >= bandRank('noticeable'))
    .map((t) => {
      const iv = Math.max(1, Math.min(t.interval_days ?? 7, 30));
      const freqWeight = 7 / iv;                 // daily ≈ 7, weekly = 1, monthly ≈ 0.23
      const overdueBoost = 1 + Math.min(ratio(t), 3) * 0.15;
      return { task: t, score: (t.urgency ?? 0) * freqWeight * overdueBoost };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const max = scored.length ? scored[0].score : 0;
  return scored.map((r) => ({
    task: r.task,
    fill: max > 0 ? Math.round((r.score / max) * 100) : 0,
    relief: max > 0 && r.score >= max * 0.66 ? 'High'
      : max > 0 && r.score >= max * 0.33 ? 'Medium' : 'Low',
  }));
}

// ── Frequency Mismatch (Part D) ──────────────────────────────────────────────
export function isFrequencyMismatch(task) {
  if (isFutureOrInactiveTask(task)) return false;
  const iv = task.interval_days ?? Infinity;
  const never = isNeverDoneTask(task);
  const r = ratio(task);
  if (iv <= 1 && never) return true;                              // daily, never done
  if (iv <= 2 && r >= VERY_STALE_RATIO) return true;              // near-daily, very overdue
  if (iv <= 7 && never && r >= STALE_RATIO) return true;          // weekly-ish never done after many intervals
  if (iv <= 2 && band(task) === 'critical' && r >= NEGLECT_RATIO) return true; // very frequent + always critical
  return false;
}
function freqSuggestion(t) {
  const iv = t.interval_days ?? Infinity;
  const never = isNeverDoneTask(t);
  if (never && iv <= 2) return 'Never done at a daily cadence — do once to initialize, or lower the frequency.';
  if (never) return 'Never done after several intervals — lower frequency, clarify, or archive if obsolete.';
  return 'Frequent but always overdue — the interval may be unrealistic; consider raising it.';
}
export function getFrequencyMismatch(tasks) {
  return tasks
    .filter(isFrequencyMismatch)
    .sort((a, b) => ratio(b) - ratio(a))
    .slice(0, 5)
    .map((t) => ({ task: t, suggestion: freqSuggestion(t) }));
}

// ── System Bloat Meter (Part B) ──────────────────────────────────────────────
// Splits active pressure into "real recurring work" vs system dirtiness, and
// surfaces the top few bloat sources.
export function getBloatBreakdown(tasks) {
  const active = tasks.filter((t) => !isFutureOrInactiveTask(t));
  const n = active.length;
  const neverDone = active.filter(isNeverDoneTask).length;
  const stale = active.filter((t) => isNeverDoneTask(t) && ratio(t) >= STALE_RATIO).length;
  const uncategorized = active.filter(isUncategorized).length;
  const reading = active.filter(looksLikeReading).length;
  const freqMismatch = active.filter(isFrequencyMismatch).length;
  // "dirty" = a task that is never-done OR uncategorized OR reading-like (rough).
  const dirty = active.filter((t) => isNeverDoneTask(t) || isUncategorized(t) || looksLikeReading(t)).length;
  const sources = [
    { key: 'neverDone', label: 'Never done', count: neverDone },
    { key: 'uncategorized', label: 'Uncategorized', count: uncategorized },
    { key: 'stale', label: 'Possibly stale', count: stale },
    { key: 'freqMismatch', label: 'Frequency mismatch', count: freqMismatch },
    { key: 'reading', label: 'Reading-like', count: reading },
  ].filter((s) => s.count > 0).sort((a, b) => b.count - a.count);
  return {
    total: n,
    established: n - neverDone,
    neverDone, stale, uncategorized, reading, freqMismatch,
    dirty, healthy: Math.max(0, n - dirty),
    dirtyPct: n ? Math.round((dirty / n) * 100) : 0,
    topSources: sources.slice(0, 3),
  };
}

// ── Uncategorized Pressure Impact (Part F) ───────────────────────────────────
export function getUncategorizedImpact(tasks) {
  const active = tasks.filter((t) => !isFutureOrInactiveTask(t));
  const n = active.length;
  if (n === 0) return null;
  const uncat = active.filter(isUncategorized);
  if (uncat.length === 0) return { count: 0, pctActive: 0, pctHighCrit: 0, avgUrg: 0, top: [], warn: false };
  const highCrit = active.filter((t) => bandRank(band(t)) >= bandRank('high'));
  const uncatHighCrit = highCrit.filter(isUncategorized);
  const avgUrg = uncat.reduce((s, t) => s + (t.urgency ?? 0), 0) / uncat.length;
  const pctHighCrit = highCrit.length ? Math.round((uncatHighCrit.length / highCrit.length) * 100) : 0;
  return {
    count: uncat.length,
    pctActive: Math.round((uncat.length / n) * 100),
    pctHighCrit,
    avgUrg,
    top: [...uncat].sort((a, b) => (b.urgency ?? 0) - (a.urgency ?? 0)).slice(0, 3),
    warn: uncat.length / n >= 0.4 || pctHighCrit >= 40,
  };
}

// ── Reading Migration Candidates (Part G) ────────────────────────────────────
export function getReadingMigration(tasks) {
  return tasks
    .filter((t) => !isFutureOrInactiveTask(t) && looksLikeReading(t))
    .sort((a, b) => (b.urgency ?? 0) - (a.urgency ?? 0))
    .slice(0, 5);
}

// ── Completion Coverage (Part H) ─────────────────────────────────────────────
// Are recent completions covering the high-pressure sections? Uses the
// completion heatmap (section × 30d) + current section pressure.
export function getCompletionCoverage(sectionRows = [], completionHeatmap = {}) {
  const rows = completionHeatmap.rows || [];
  const activeSections = new Set(rows.filter((r) => r.total > 0).map((r) => r.label));
  const mostActive = rows.length ? rows[0].label : null; // heatmap rows sorted by total desc
  const uncovered = sectionRows
    .filter((s) => s.highCrit > 0 && !activeSections.has(s.section))
    .map((s) => s.section);
  return { mostActive, uncovered, sectionsWithCompletions: activeSections.size };
}

// ── Important but Neglected (Part I) ─────────────────────────────────────────
export function getImportantNeglected(tasks, doNowIds = []) {
  const excl = new Set(doNowIds);
  return tasks
    .filter((t) => {
      if (isFutureOrInactiveTask(t) || excl.has(t.id)) return false;
      if ((t.priority ?? 0) < 7) return false;
      return isOverdue(t) || (t.days_since ?? 0) >= 30 || ratio(t) >= 1.5;
    })
    .sort(cmpChain(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
      (a, b) => ratio(b) - ratio(a),
      (a, b) => (b.urgency ?? 0) - (a.urgency ?? 0),
      (a, b) => a.id - b.id,
    ))
    .slice(0, 5);
}

// ── Pressure Changes (Part E) — section-level worsening from snapshots ────────
// Snapshots are section-level avg urgency over dates (task-level urgency history
// is NOT stored), so we can only honestly report section trends. Compares the
// mean of the first third of non-null values to the last third per section.
export function getSectionPressureTrend(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.rows) || snapshot.rows.length === 0) {
    return { supported: false, rising: [] };
  }
  const rising = [];
  for (const row of snapshot.rows) {
    const vals = (row.avg_values || []).filter((v) => v !== null && v !== undefined);
    if (vals.length < 4) continue; // not enough history to call a trend
    const k = Math.max(1, Math.floor(vals.length / 3));
    const early = vals.slice(0, k).reduce((s, v) => s + v, 0) / k;
    const late = vals.slice(-k).reduce((s, v) => s + v, 0) / k;
    const delta = +(late - early).toFixed(1);
    if (delta >= 0.5) rising.push({ label: row.label, delta, now: +late.toFixed(1) });
  }
  rising.sort((a, b) => b.delta - a.delta);
  return { supported: rising.length > 0 || snapshot.rows.some((r) => (r.avg_values || []).filter((v) => v != null).length >= 4), rising: rising.slice(0, 5) };
}
