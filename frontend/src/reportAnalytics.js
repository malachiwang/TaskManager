// Pure, frontend-derived analytics for the Monthly / Period Report (P6.0B).
// All data comes from existing endpoints (/completions?start&end, /tasks,
// /snapshots/pressure, /reading/books) — no backend/schema changes. Retrospective
// (what happened) rather than live action planning. Urgency banding reuses the
// shared model; no fresh thresholds.
import { urgencyBandKey } from './urgency.js';

const BAND_RANK = { none: 0, low: 1, noticeable: 2, high: 3, critical: 4 };
const bandRank = (u) => BAND_RANK[urgencyBandKey(u ?? 0)] ?? 0;

function pad(n) { return String(n).padStart(2, '0'); }

// Month is 1-indexed. Returns ISO start/end + day count.
export function monthRange(year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(month)}-${pad(lastDay)}`,
    days: lastDay,
  };
}

export function monthLabel(year, month) {
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(first)} – ${fmt(last)}, ${year}`;
}

// ── Report periods (P10.0) — Week / Month / Quarter / Year ───────────────────
// All analytics below are already start/end driven, so richer periods only
// need range computation. `anchor` is any Date inside the desired period.

export const PERIOD_MODES = ['week', 'month', 'quarter', 'year'];

function iso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function periodRange(mode, anchor) {
  const y = anchor.getFullYear();
  const m = anchor.getMonth(); // 0-indexed
  if (mode === 'week') {
    // Monday-start week containing the anchor.
    const day = (anchor.getDay() + 6) % 7; // Mon=0 … Sun=6
    const first = new Date(y, m, anchor.getDate() - day);
    const last = new Date(first.getFullYear(), first.getMonth(), first.getDate() + 6);
    return { start: iso(first), end: iso(last) };
  }
  if (mode === 'quarter') {
    const qStartMonth = Math.floor(m / 3) * 3;
    return { start: iso(new Date(y, qStartMonth, 1)), end: iso(new Date(y, qStartMonth + 3, 0)) };
  }
  if (mode === 'year') {
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  return { start: iso(new Date(y, m, 1)), end: iso(new Date(y, m + 1, 0)) }; // month
}

// Returns a new anchor date shifted by `delta` periods (±1 from the nav arrows).
export function shiftPeriodAnchor(mode, anchor, delta) {
  const d = new Date(anchor);
  if (mode === 'week') d.setDate(d.getDate() + delta * 7);
  else if (mode === 'quarter') d.setMonth(d.getMonth() + delta * 3, 1);
  else if (mode === 'year') d.setFullYear(d.getFullYear() + delta, d.getMonth(), 1);
  else d.setMonth(d.getMonth() + delta, 1);
  return d;
}

export function periodLabel(mode, anchor) {
  const { start, end } = periodRange(mode, anchor);
  if (mode === 'year') return String(anchor.getFullYear());
  if (mode === 'quarter') {
    const q = Math.floor(anchor.getMonth() / 3) + 1;
    return `Q${q} ${anchor.getFullYear()}`;
  }
  const fmt = (isoDate) => {
    const [yy, mm, dd] = isoDate.split('-').map(Number);
    return new Date(yy, mm - 1, dd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  return `${fmt(start)} – ${fmt(end)}, ${anchor.getFullYear()}`;
}

export function enumerateDays(start, end) {
  const out = [];
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  for (const d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  return out;
}

function sectionOf(t) { return (t && t.section && t.section.trim()) || '(no section)'; }
function isUncategorized(t) { return !((t.category && t.category.trim())); }

// ── Completion activity in the period ────────────────────────────────────────
export function completionSummary(completions, taskMap, start, end) {
  const byDate = {};
  const bySection = {};
  const byTask = {};
  const taskIdsWithCompletion = new Set();
  let total = 0;
  for (const c of completions) {
    const cnt = c.completion_count || 0;
    total += cnt;
    byDate[c.completion_date] = (byDate[c.completion_date] || 0) + cnt;
    taskIdsWithCompletion.add(c.task_id);
    const t = taskMap.get(c.task_id);
    const sec = t ? sectionOf(t) : '(deleted task)';
    bySection[sec] = (bySection[sec] || 0) + cnt;
    if (!byTask[c.task_id]) {
      byTask[c.task_id] = { id: c.task_id, name: t ? t.name : `Task #${c.task_id}`, section: sec, count: 0 };
    }
    byTask[c.task_id].count += cnt;
  }
  const dayList = enumerateDays(start, end);
  const perDay = dayList.map((d) => ({ date: d, count: byDate[d] || 0 }));
  const activeDays = perDay.filter((d) => d.count > 0).length;
  const bestDay = perDay.reduce((b, d) => (d.count > b.count ? d : b), { date: null, count: 0 });
  const topTasks = Object.values(byTask).sort((a, b) => b.count - a.count).slice(0, 8);
  const sectionRows = Object.entries(bySection)
    .map(([section, count]) => ({ section, count }))
    .sort((a, b) => b.count - a.count);
  return {
    total, perDay, activeDays, totalDays: dayList.length, bestDay, topTasks,
    sectionRows, mostActiveSection: sectionRows[0]?.section || null, taskIdsWithCompletion,
  };
}

// ── Consistency / momentum ───────────────────────────────────────────────────
export function consistency(perDay) {
  let longestStreak = 0, cur = 0, longestGap = 0, gap = 0;
  for (const d of perDay) {
    if (d.count > 0) { cur++; longestStreak = Math.max(longestStreak, cur); gap = 0; }
    else { cur = 0; gap++; longestGap = Math.max(longestGap, gap); }
  }
  const activeDays = perDay.filter((d) => d.count > 0).length;
  const total = perDay.reduce((s, d) => s + d.count, 0);
  return {
    longestStreak, longestGap, activeDays, totalDays: perDay.length,
    perActiveDay: activeDays ? +(total / activeDays).toFixed(1) : 0,
  };
}

// ── Finished in period (explicit end_date, not completion checkboxes) ─────────
export function finishedInPeriod(tasks, start, end) {
  return tasks
    .filter((t) => t.end_date && t.end_date >= start && t.end_date <= end)
    .sort((a, b) => (a.end_date < b.end_date ? 1 : -1));
}

// ── Carried forward (current-state approximation) ────────────────────────────
// Active, not Hiatus/Finished/scheduled, still carrying noticeable+ pressure.
export function carriedForward(tasks) {
  return tasks
    .filter((t) => !(t.is_paused === 1 || t.is_ended || t.is_scheduled) && bandRank(t.urgency) >= BAND_RANK.noticeable)
    .sort((a, b) => (b.urgency ?? 0) - (a.urgency ?? 0))
    .slice(0, 8);
}

// ── Neglected all period (no completion during the period) ────────────────────
export function neglectedAllPeriod(tasks, taskIdsWithCompletion, start, end) {
  return tasks
    .filter((t) => {
      if (t.is_paused === 1 || t.is_scheduled) return false;
      if (t.end_date && t.end_date < start) return false;             // finished before the period
      if (t.active_from && t.active_from > end) return false;          // not active during the period
      if ((t.created_at || '').slice(0, 10) > end) return false;       // created after the period
      if (taskIdsWithCompletion.has(t.id)) return false;               // had attention in the period
      return true;
    })
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)
      || (b.urgency ?? 0) - (a.urgency ?? 0)
      || (b.days_since ?? 0) - (a.days_since ?? 0)
      || a.id - b.id)
    .slice(0, 8);
}

// ── Section breakdown (completions + current pressure) ───────────────────────
export function sectionBreakdown(tasks, completionSectionRows, finished, neglectedIds) {
  const map = new Map();
  const ensure = (key) => {
    if (!map.has(key)) map.set(key, { section: key, completions: 0, count: 0, sumUrg: 0, highCrit: 0, neglected: 0, finished: 0 });
    return map.get(key);
  };
  for (const t of tasks) {
    if (t.is_paused === 1 || t.is_ended || t.is_scheduled) continue;
    const s = ensure(sectionOf(t));
    s.count++;
    s.sumUrg += t.urgency ?? 0;
    if (bandRank(t.urgency) >= BAND_RANK.high) s.highCrit++;
    if (neglectedIds.has(t.id)) s.neglected++;
  }
  for (const { section, count } of completionSectionRows) ensure(section).completions += count;
  for (const t of finished) ensure(sectionOf(t)).finished++;
  const rows = [...map.values()].map((s) => ({ ...s, avgUrg: s.count ? s.sumUrg / s.count : 0 }));
  rows.sort((a, b) => b.completions - a.completions || b.avgUrg - a.avgUrg || a.section.localeCompare(b.section));
  return rows;
}

// ── Section pressure change from snapshot history (Part K) ───────────────────
// Snapshots are section-level avg urgency over dates (task-level history isn't
// stored). Compares the mean of the first third of non-null values to the last
// third per section. Honest about how many snapshot days exist.
export function sectionPressureChange(snapshot) {
  const rows = (snapshot && snapshot.rows) || [];
  const dayCount = (snapshot && snapshot.dates && snapshot.dates.length) || 0;
  const changes = [];
  let usable = false;
  for (const row of rows) {
    const vals = (row.avg_values || []).filter((v) => v !== null && v !== undefined);
    if (vals.length < 4) continue;
    usable = true;
    const k = Math.max(1, Math.floor(vals.length / 3));
    const early = vals.slice(0, k).reduce((s, v) => s + v, 0) / k;
    const late = vals.slice(-k).reduce((s, v) => s + v, 0) / k;
    changes.push({ label: row.label, delta: +(late - early).toFixed(1), start: +early.toFixed(1), end: +late.toFixed(1) });
  }
  const rising = changes.filter((c) => c.delta >= 0.5).sort((a, b) => b.delta - a.delta).slice(0, 5);
  const falling = changes.filter((c) => c.delta <= -0.5).sort((a, b) => a.delta - b.delta).slice(0, 5);
  return { supported: usable, dayCount, rising, falling };
}

// ── System cleanup (retrospective) — reuse simple current-state signals ──────
export function cleanupReport(tasks) {
  const active = tasks.filter((t) => !(t.is_paused === 1 || t.is_ended || t.is_scheduled));
  const n = active.length;
  const neverDone = active.filter((t) => !t.latest_completion && !t.manual_last_done_override).length;
  const uncategorized = active.filter(isUncategorized).length;
  const reading = active.filter((t) => /\b(read|reading|book|chapter|pages?)\b/i.test(t.name || '') || /\b(read|reading|book)\b/i.test(t.category || '')).length;
  return {
    active: n,
    neverDone, neverDonePct: n ? Math.round((neverDone / n) * 100) : 0,
    uncategorized, uncategorizedPct: n ? Math.round((uncategorized / n) * 100) : 0,
    reading,
  };
}

// ── Optional Reading summary (books-only, no per-book entry fetches) ─────────
export function readingSummary(books, start, end) {
  const inRange = (d) => d && d.slice(0, 10) >= start && d.slice(0, 10) <= end;
  const updated = books.filter((b) => inRange(b.updated_at) || inRange(b.last_entry_date));
  const finished = books.filter((b) => b.status === 'finished' && inRange(b.finished_at));
  return {
    total: books.length,
    active: books.filter((b) => b.status === 'active').length,
    finishedTotal: books.filter((b) => b.status === 'finished').length,
    archived: books.filter((b) => b.status === 'archived').length,
    updatedInPeriod: updated.length,
    finishedInPeriod: finished,
    updatedList: updated.slice(0, 6),
  };
}
