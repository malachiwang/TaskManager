import { useState, useEffect } from 'react';
import { fetchDashboard, fetchSnapshotPressure, fetchTasks } from '../api.js';
import { urgencyClass, urgencyReason } from '../urgency.js';
import {
  getDoNowTasks,
  getQuickWinTasks,
  getTriageTasks,
  getSystemHygieneInsights,
  getSectionPressure,
  getActivitySummary,
} from '../dashboardInsights.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// CSS-only micro-bar — no chart library.
function UrgencyBar({ value, wide = false }) {
  const pct = Math.min(100, (value / 10) * 100).toFixed(1);
  return (
    <div className={`dash-microbar${wide ? ' dash-microbar--wide' : ''}`}>
      <div
        className={`dash-microbar-fill dash-microbar-fill--${urgencyClass(value)}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// SVG bar sparkline — 30-day completion trend.
function SparklineBar({ trend }) {
  const maxCount = Math.max(...trend.map((d) => d.count), 1);
  const W = 300, H = 44, GAP = 1;
  const barW = (W - GAP * 29) / 30;
  return (
    <svg
      className="dash-sparkline"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {trend.map((d, i) => {
        const h = Math.max(2, (d.count / maxCount) * H);
        return (
          <rect
            key={d.date}
            x={i * (barW + GAP)}
            y={H - h}
            width={barW}
            height={h}
            className="dash-sparkline-bar"
          />
        );
      })}
    </svg>
  );
}

// Section × 30-day completion density heatmap.
const TICK_INDICES = new Set([0, 7, 14, 21, 29]);

function HeatmapGrid({ heatmap }) {
  const { dates, rows, max_value } = heatmap;

  if (rows.length === 0) {
    return <div className="dash-heatmap-empty">No completions in the last 30 days.</div>;
  }

  return (
    <div className="dash-heatmap">
      {/* Sparse date axis */}
      <div className="dash-heatmap-axis">
        <div className="dash-heatmap-label" aria-hidden="true" />
        <div className="dash-heatmap-cells">
          {dates.map((d, i) => (
            <div key={d} className="dash-heatmap-axis-cell">
              {TICK_INDICES.has(i) ? d.slice(8) : null}
            </div>
          ))}
        </div>
      </div>
      {rows.map((row) => (
        <div key={row.key} className="dash-heatmap-row">
          <div className="dash-heatmap-label" title={row.label}>
            <span className="dash-heatmap-label-name">{row.label}</span>
            <span className="dash-heatmap-label-total">{row.total}</span>
          </div>
          <div className="dash-heatmap-cells">
            {row.values.map((count, i) => {
              const intensity = max_value > 0 && count > 0
                ? Math.max(count / max_value, 0.15)
                : 0;
              return (
                <div
                  key={dates[i]}
                  className="dash-heatmap-cell"
                  style={intensity > 0
                    ? { background: `rgba(58,123,213,${intensity.toFixed(2)})` }
                    : undefined}
                  title={`${row.label} · ${dates[i]} · ${count} completion${count !== 1 ? 's' : ''}`}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// Compact insight strip — computed from heatmap + trend, no backend changes.
function fmtInsightDate(isoDate) {
  const [y, m, day] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function InsightStrip({ heatmap, trend }) {
  const { rows } = heatmap;
  const total30d = trend.reduce((s, d) => s + d.count, 0);

  if (total30d === 0 || rows.length === 0) return null;

  const bestEntry = trend.reduce(
    (best, d) => d.count > best.count ? d : best,
    { date: null, count: 0 },
  );

  const activeDays = trend.filter((d) => d.count > 0).length;

  const totalAll = rows.reduce((s, r) => s + r.total, 0);
  const concentrationPct = rows.length >= 2 && totalAll > 0
    ? Math.round((rows[0].total / totalAll) * 100)
    : null;

  return (
    <div className="dash-insight-strip">
      <div className="dash-insight-chip">
        <span className="dash-insight-label">Most active</span>
        <span className="dash-insight-value">{rows[0].label} · {rows[0].total}</span>
      </div>
      {bestEntry.date && (
        <div className="dash-insight-chip">
          <span className="dash-insight-label">Best day</span>
          <span className="dash-insight-value">{fmtInsightDate(bestEntry.date)} · {bestEntry.count}</span>
        </div>
      )}
      <div className="dash-insight-chip">
        <span className="dash-insight-label">Active days</span>
        <span className="dash-insight-value">{activeDays}/30</span>
      </div>
      {concentrationPct !== null && (
        <div className="dash-insight-chip">
          <span className="dash-insight-label">Top section</span>
          <span className="dash-insight-value">{concentrationPct}%</span>
        </div>
      )}
    </div>
  );
}

// Amber→orange→red color ramp for urgency heatmap cells.
function pressureColor(value) {
  if (value === null || value === undefined) return null;
  if (value <= 0) return 'transparent';
  const pct = Math.min(value / 10, 1);
  const r = Math.round(200 + pct * 55);
  const g = Math.round(140 - pct * 110);
  const a = Math.max(0.18, pct).toFixed(2);
  return `rgba(${r},${g},20,${a})`;
}

// Section × snapshot-date avg-urgency heatmap — reads from GET /snapshots/pressure.
function PressureHeatmap() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    fetchSnapshotPressure(days)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [days]);

  const dayOptions = [7, 14, 30, 60, 90];

  return (
    <>
      <div className="dash-pheat-controls">
        {dayOptions.map((d) => (
          <button
            key={d}
            type="button"
            className={`dash-pheat-btn${days === d ? ' dash-pheat-btn--active' : ''}`}
            onClick={() => setDays(d)}
          >
            {d}d
          </button>
        ))}
      </div>
      {error ? (
        <div className="ws-empty">Error: {error}</div>
      ) : !data ? (
        <div className="ws-empty">Loading…</div>
      ) : data.rows.length === 0 ? (
        <div className="dash-pheat-empty">
          No snapshot history yet. Visit the dashboard daily to build history.
        </div>
      ) : (
        <div className="dash-pheat">
          {data.dates.length > 7 && (
            <div className="dash-pheat-axis">
              <div className="dash-pheat-label" aria-hidden="true" />
              <div className="dash-pheat-cells">
                {data.dates.map((d, i) => (
                  <div key={d} className="dash-pheat-axis-cell">
                    {(i === 0 || i === data.dates.length - 1) ? d.slice(5) : null}
                  </div>
                ))}
              </div>
            </div>
          )}
          {data.rows.map((row) => (
            <div key={row.key} className="dash-pheat-row">
              <div className="dash-pheat-label" title={row.label}>
                <span className="dash-pheat-label-name">{row.label}</span>
                <span className={`dash-pheat-label-avg ${urgencyClass(row.avg_urgency)}`}>
                  {row.avg_urgency.toFixed(1)}
                </span>
              </div>
              <div className="dash-pheat-cells">
                {row.avg_values.map((val, i) => {
                  const bg = pressureColor(val);
                  return (
                    <div
                      key={data.dates[i]}
                      className={`dash-pheat-cell${val === null ? ' dash-pheat-cell--null' : ''}`}
                      style={bg && bg !== 'transparent' ? { background: bg } : undefined}
                      title={val !== null
                        ? `${row.label} · ${data.dates[i]} · avg ${val.toFixed(1)}`
                        : `${row.label} · ${data.dates[i]} · no data`}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {data && data.snapshot_count < data.days_requested && (
        <div className="dash-pheat-caption">
          {data.snapshot_count} of {data.days_requested} snapshot days captured
        </div>
      )}
    </>
  );
}

// Compact reusable action table for Do Now / Quick Wins.
function ActionTable({ rows, emptyText, reasonPrefix }) {
  if (!rows.length) return <div className="ws-empty">{emptyText}</div>;
  return (
    <table className="dash-table dashboard-action-table">
      <thead>
        <tr>
          <th className="dash-th-urg">Urg</th>
          <th>Task</th>
          <th>Section</th>
          <th className="dash-th-num">Overdue</th>
          <th className="dash-th-num">Freq</th>
          <th>Why</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.id}>
            <td>
              <div className="dash-urg-cell">
                <span className={`dash-urg-num ${urgencyClass(t.urgency)}`}>{t.urgency.toFixed(1)}</span>
                <UrgencyBar value={t.urgency} />
              </div>
            </td>
            <td className="dash-task-name">{t.name}</td>
            <td className="dash-muted">{t.section || '—'}</td>
            <td className="dash-num">{(t.days_overdue ?? 0) > 0 ? `${t.days_overdue}d` : '—'}</td>
            <td className="dash-num">{t.interval_days}d</td>
            <td className="dash-muted dash-reason">
              {reasonPrefix ? `${reasonPrefix} · ` : ''}{urgencyReason(t)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function nowLabel() {
  const d = new Date();
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} · ${time}`;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [tasksError, setTasksError] = useState(null);

  useEffect(() => {
    fetchDashboard().then(setData).catch((e) => setError(e.message));
    fetchTasks().then(setTasks).catch((e) => setTasksError(e.message));
  }, []);

  if (error) return <div className="grid-status error">Error: {error}</div>;
  if (!data) return <div className="grid-status">Loading…</div>;

  const { urgency_distribution, completion_trend, completion_heatmap } = data;

  // Activity momentum (from completion_trend).
  const act = getActivitySummary(completion_trend);

  // Task-level action insights (from GET /tasks). Guard against a failed/pending
  // /tasks fetch — the rest of the dashboard still renders from /dashboard.
  const tasksReady = Array.isArray(tasks);
  const doNow = tasksReady ? getDoNowTasks(tasks) : [];
  const doNowIds = doNow.map((t) => t.id);
  const quickWins = tasksReady ? getQuickWinTasks(tasks, doNowIds) : [];
  const triage = tasksReady ? getTriageTasks(tasks) : [];
  const hygiene = tasksReady ? getSystemHygieneInsights(tasks) : [];
  const sectionPressure = tasksReady ? getSectionPressure(tasks) : [];
  const inScope = tasksReady
    ? tasks.filter((t) => !(t.is_paused === 1 || t.is_ended || t.is_scheduled)).length
    : 0;

  const critHigh = (urgency_distribution.critical || 0) + (urgency_distribution.high || 0);

  // Weighted avg urgency across active tasks (from /dashboard category_summary).
  const catEntries = Object.entries(data.category_summary || {});
  const totalActive = catEntries.reduce((s, [, c]) => s + c.count, 0);
  const avgUrgencyRaw = totalActive > 0
    ? catEntries.reduce((s, [, c]) => s + c.avg_urgency * c.count, 0) / totalActive
    : null;
  const avgUrgency = avgUrgencyRaw !== null ? avgUrgencyRaw.toFixed(1) : '—';

  const actionWarning = !tasksReady
    ? (tasksError ? 'Could not load task details — action lists unavailable.' : 'Loading task details…')
    : null;

  return (
    <div className="ws-dashboard">
      <div className="ws-dash-header">
        <div className="ws-dash-header-left">
          <div className="ws-dash-title">What should I do now?</div>
          <div className="ws-dash-sub">
            action queue · active non-hiatus tasks{tasksReady ? ` · ${inScope} in scope` : ''}
          </div>
        </div>
        <div className="ws-dash-now">{nowLabel()}</div>
      </div>

      {/* ── Action Summary ── */}
      <div className="dashboard-action-summary">
        <div className={`dashboard-summary-chip${doNow.length ? ' is-accent' : ''}`}>
          <div className="dashboard-summary-value">{tasksReady ? doNow.length : '—'}</div>
          <div className="dashboard-summary-label">Do now</div>
        </div>
        <div className="dashboard-summary-chip">
          <div className="dashboard-summary-value">{tasksReady ? quickWins.length : '—'}</div>
          <div className="dashboard-summary-label">Quick wins</div>
        </div>
        <div className="dashboard-summary-chip">
          <div className="dashboard-summary-value">{tasksReady ? triage.length : '—'}</div>
          <div className="dashboard-summary-label">Decide</div>
        </div>
        <div className={`dashboard-summary-chip${critHigh ? ' is-warn' : ''}`}>
          <div className="dashboard-summary-value">{critHigh}</div>
          <div className="dashboard-summary-label">Critical / High</div>
        </div>
        <div className="dashboard-summary-chip">
          <div className={`dashboard-summary-value ${avgUrgencyRaw !== null ? urgencyClass(avgUrgencyRaw) : ''}`}>{avgUrgency}</div>
          <div className="dashboard-summary-label">Avg urgency</div>
        </div>
        <div className="dashboard-summary-chip">
          <div className="dashboard-summary-value">{act.done7d}</div>
          <div className="dashboard-summary-label">Done 7d</div>
        </div>
      </div>

      {actionWarning && (
        <div className={`dashboard-action-warning${tasksError ? ' error' : ''}`}>{actionWarning}</div>
      )}

      <div className="ws-panels">
        {/* ── Do Now ── */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header">
            <span>Do Now</span>
            <span className="ws-frame-header-sub">established overdue tasks worth doing today · top 5</span>
          </div>
          <ActionTable rows={doNow} emptyText={tasksReady ? 'No urgent established tasks right now.' : (actionWarning || '')} />
        </div>

        {/* ── Likely Quick Wins ── */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header">
            <span>Likely Quick Wins</span>
            <span className="ws-frame-header-sub">frequent / overdue tasks that likely shed pressure fast · top 5</span>
          </div>
          <ActionTable rows={quickWins} emptyText={tasksReady ? 'No likely quick wins found.' : (actionWarning || '')} reasonPrefix="Likely quick win" />
        </div>

        {/* ── Decide / Clarify ── */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header">
            <span>Decide / Clarify</span>
            <span className="ws-frame-header-sub">tasks that may need a decision, not immediate completion · top 6</span>
          </div>
          {!tasksReady ? (
            <div className="ws-empty">{actionWarning}</div>
          ) : triage.length === 0 ? (
            <div className="ws-empty">Nothing needs a decision right now.</div>
          ) : (
            <table className="dash-table">
              <thead>
                <tr>
                  <th className="dash-th-urg">Urg</th>
                  <th>Task</th>
                  <th>Diagnosis</th>
                  <th>Suggestion</th>
                </tr>
              </thead>
              <tbody>
                {triage.map(({ task, chips, suggestion }) => (
                  <tr key={task.id}>
                    <td><span className={`dash-urg-num ${urgencyClass(task.urgency)}`}>{task.urgency.toFixed(1)}</span></td>
                    <td className="dash-task-name">{task.name}</td>
                    <td>
                      <div className="dashboard-diagnosis-chips">
                        {chips.map((c) => <span key={c} className="dashboard-diagnosis-chip">{c}</span>)}
                      </div>
                    </td>
                    <td className="dash-muted dash-reason">{suggestion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── System Hygiene ── */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header">
            <span>System Hygiene</span>
            <span className="ws-frame-header-sub">system-level cleanup signals · highest-signal first</span>
          </div>
          {!tasksReady ? (
            <div className="ws-empty">{actionWarning}</div>
          ) : hygiene.length === 0 ? (
            <div className="ws-empty">No system hygiene warnings triggered.</div>
          ) : (
            <div className="dashboard-hygiene-grid">
              {hygiene.map((h) => (
                <div key={h.key} className="dashboard-hygiene-card">
                  <div className="dashboard-hygiene-title">{h.title}</div>
                  <div className="dashboard-hygiene-body">{h.body}</div>
                  <div className="dashboard-hygiene-action">{h.action}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Section Pressure ── */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header">
            <span>Section Pressure</span>
            <span className="ws-frame-header-sub">active tasks grouped by section · sorted by avg urgency</span>
          </div>
          {!tasksReady ? (
            <div className="ws-empty">{actionWarning}</div>
          ) : sectionPressure.length === 0 ? (
            <div className="ws-empty">No active tasks.</div>
          ) : (
            <table className="dash-table dashboard-section-pressure">
              <thead>
                <tr>
                  <th>Section</th>
                  <th className="dash-th-num">Tasks</th>
                  <th className="dash-th-urg">Avg</th>
                  <th className="dash-th-num">Max</th>
                  <th className="dash-th-num">High+</th>
                  <th className="dash-th-num">Neglect</th>
                  <th className="dash-th-num">Never</th>
                  <th className="dash-th-num">Uncat</th>
                </tr>
              </thead>
              <tbody>
                {sectionPressure.map((s) => (
                  <tr key={s.section} className={s.section === '(no section)' ? 'dashboard-row-warn' : ''}>
                    <td>{s.section}</td>
                    <td className="dash-num">{s.count}</td>
                    <td>
                      <div className="dash-urg-cell">
                        <span className={`dash-urg-num ${urgencyClass(s.avgUrg)}`}>{s.avgUrg.toFixed(1)}</span>
                        <UrgencyBar value={s.avgUrg} />
                      </div>
                    </td>
                    <td className={`dash-num ${urgencyClass(s.maxUrg)}`}>{s.maxUrg.toFixed(1)}</td>
                    <td className={`dash-num${s.highCrit > 0 ? ' urg-high' : ''}`}>{s.highCrit}</td>
                    <td className="dash-num">{s.neglected}</td>
                    <td className="dash-num">{s.neverDone}</td>
                    <td className={`dash-num${s.uncategorized > 0 ? ' dashboard-warn-text' : ''}`}>{s.uncategorized}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Activity Context (compressed) ── */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header">
            <span>Activity Context</span>
            <span className="ws-frame-header-sub">recent momentum · context, not action</span>
          </div>
          <div className="ws-frame-body dashboard-context-panel">
            <div className="dashboard-context-stats">
              <span><strong>{act.total30d}</strong> in 30d</span>
              <span><strong>{act.done7d}</strong> in 7d</span>
              {act.paceChangePct !== null && (
                <span className={act.paceChangePct >= 0 ? 'dash-pace-up' : 'dash-pace-dn'}>
                  {act.paceChangePct >= 0 ? '+' : ''}{act.paceChangePct}% vs prev 7d
                </span>
              )}
              <span>best day {act.bestDay}</span>
              <span>{act.activeDays7d}/7 active days</span>
            </div>
            <SparklineBar trend={completion_trend} />
            <HeatmapGrid heatmap={completion_heatmap} />
            <InsightStrip heatmap={completion_heatmap} trend={completion_trend} />
          </div>
        </div>

        {/* ── Pressure History (bottom, unchanged) ── */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header">
            <span>Pressure history</span>
            <span className="ws-frame-header-sub">
              section × snapshot date · avg urgency · hiatus &amp; scheduled excluded
            </span>
          </div>
          <div className="ws-frame-body">
            <PressureHeatmap />
          </div>
        </div>
      </div>
    </div>
  );
}
