import { useState, useEffect } from 'react';
import { fetchDashboard, fetchSnapshotPressure } from '../api.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function urgencyClass(u) {
  if (u >= 8) return 'urg-critical';
  if (u >= 6) return 'urg-high';
  if (u >= 3) return 'urg-noticeable';
  return 'urg-low';
}

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

// 4-row urgency distribution bar chart.
function UrgencyDist({ dist, total }) {
  const bins = [
    { key: 'critical',   label: 'Critical', cls: 'urg-critical' },
    { key: 'high',       label: 'High',     cls: 'urg-high' },
    { key: 'noticeable', label: 'Notice.',  cls: 'urg-noticeable' },
    { key: 'low',        label: 'Low',      cls: 'urg-low' },
  ];
  return (
    <div className="dash-urgdist">
      {bins.map(({ key, label, cls }) => {
        const count = dist[key] || 0;
        const pct = total > 0 ? (count / total) * 100 : 0;
        return (
          <div key={key} className="dash-urgdist-row">
            <span className="dash-urgdist-label">{label}</span>
            <div className="dash-urgdist-track">
              <div
                className={`dash-urgdist-fill ${cls}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="dash-urgdist-count">{count}</span>
          </div>
        );
      })}
    </div>
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

// Horizontal ratio bar — active vs paused.
function RatioBar({ activeCount, pausedCount }) {
  const total = activeCount + pausedCount;
  if (total === 0) return <div className="dash-ratio-empty">No tasks</div>;
  return (
    <div className="dash-ratio-bar">
      <div
        className="dash-ratio-segment dash-ratio-segment--active"
        style={{ width: `${(activeCount / total) * 100}%` }}
        title={`Active: ${activeCount}`}
      />
      <div
        className="dash-ratio-segment dash-ratio-segment--paused"
        style={{ width: `${(pausedCount / total) * 100}%` }}
        title={`Paused: ${pausedCount}`}
      />
    </div>
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

  useEffect(() => {
    fetchDashboard()
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="grid-status error">Error: {error}</div>;
  if (!data)  return <div className="grid-status">Loading…</div>;

  const {
    top_5_urgent, category_summary, dormant_tasks, paused_count, never_done_count,
    active_count, urgency_distribution, completion_trend, completion_heatmap,
  } = data;

  // ── Derived stats ────────────────────────────────────────────────────────

  // Done in last 7 days — sum of the last 7 completion_trend entries.
  const done7d = completion_trend.slice(-7).reduce((s, d) => s + d.count, 0);

  // Previous 7-day window (days 14–8 ago) for pace comparison.
  const prev7d = completion_trend.slice(-14, -7).reduce((s, d) => s + d.count, 0);

  // Percent change vs previous window; null when prev is 0 (avoids divide-by-zero).
  const paceChangePct = prev7d > 0 ? Math.round(((done7d - prev7d) / prev7d) * 100) : null;

  // Best single day in the 30-day window.
  const bestDay = Math.max(...completion_trend.map((d) => d.count), 0);

  // Number of days in the last 7 with at least one completion.
  const activeDays7d = completion_trend.slice(-7).filter((d) => d.count > 0).length;

  // Total completions in the 30-day window.
  const total30d = completion_trend.reduce((s, d) => s + d.count, 0);

  // Weighted average urgency from category_summary (active non-paused tasks).
  const catEntries = Object.entries(category_summary);
  const totalActive = catEntries.reduce((s, [, c]) => s + c.count, 0);
  const avgUrgencyRaw = totalActive > 0
    ? catEntries.reduce((s, [, c]) => s + c.avg_urgency * c.count, 0) / totalActive
    : null;
  const avgUrgency = avgUrgencyRaw !== null ? avgUrgencyRaw.toFixed(1) : '—';

  // Peak urgency.
  const peakUrgency   = top_5_urgent.length > 0 ? top_5_urgent[0].urgency.toFixed(1) : '—';
  const peakTaskName  = top_5_urgent.length > 0 ? top_5_urgent[0].name : null;

  // Tasks at/near peak (urgency ≥ 9.9) within the top-5 shown.
  const atPeakCount = top_5_urgent.filter(t => t.urgency >= 9.9).length;

  // Dormant count per category — crossref from dormant_tasks array.
  const dormantByCat = {};
  for (const t of dormant_tasks) {
    const key = t.category || '—';
    dormantByCat[key] = (dormantByCat[key] || 0) + 1;
  }

  // Categories sorted by avg urgency descending.
  const sortedCats = [...catEntries].sort((a, b) => b[1].avg_urgency - a[1].avg_urgency);

  // Dormant tasks sorted worst-first.
  const sortedDormant = [...dormant_tasks].sort((a, b) => b.days_since - a.days_since);

  return (
    <div className="ws-dashboard">

      {/* ── Serif headline ── */}
      <div className="ws-dash-header">
        <div className="ws-dash-header-left">
          <div className="ws-dash-title">Pressure readout</div>
          <div className="ws-dash-sub">
            passive readout · active non-paused tasks · {totalActive} in scope
          </div>
        </div>
        <div className="ws-dash-now">{nowLabel()}</div>
      </div>

      {/* ── 5-cell stat strip ── */}
      <div className="ws-stat-strip">

        {/* 1. Avg urgency — weighted avg across all active non-paused tasks */}
        <div className="ws-stat-cell">
          <div className="ws-stat-label">Avg urgency</div>
          <div className={`ws-stat-value dash-stat-urg${avgUrgencyRaw !== null ? ` ${urgencyClass(avgUrgencyRaw)}` : ''}`}>
            {avgUrgency}<small>/10</small>
          </div>
          <div className="ws-stat-delta">{totalActive} active tasks</div>
          {avgUrgencyRaw !== null && <UrgencyBar value={avgUrgencyRaw} wide />}
        </div>

        {/* 2. Peak urgency — top-ranked task */}
        <div className="ws-stat-cell">
          <div className="ws-stat-label">Peak urgency</div>
          <div className={`ws-stat-value dash-stat-urg${peakUrgency !== '—' ? ` ${urgencyClass(parseFloat(peakUrgency))}` : ''}`}>
            {peakUrgency}<small>/10</small>
          </div>
          <div className="ws-stat-delta" title={peakTaskName || ''}>
            {peakTaskName ? peakTaskName.slice(0, 20) : 'no active tasks'}
          </div>
          {peakUrgency !== '—' && <UrgencyBar value={parseFloat(peakUrgency)} wide />}
        </div>

        {/* 3. Done in 7d — sum of last 7 completion_trend entries */}
        <div className="ws-stat-cell">
          <div className="ws-stat-label">Done in 7d</div>
          <div className="ws-stat-value">{done7d}</div>
          <div className="ws-stat-delta">completions, last 7 days</div>
        </div>

        {/* 4. Dormant 30d+ */}
        <div className="ws-stat-cell">
          <div className="ws-stat-label">Dormant 30d+</div>
          <div className={`ws-stat-value${dormant_tasks.length > 0 ? ' dn' : ''}`}>
            {dormant_tasks.length}
          </div>
          <div className={`ws-stat-delta${dormant_tasks.length > 0 ? ' dn' : ''}`}>
            {dormant_tasks.length > 0 ? 'risk zone' : 'clear'}
          </div>
        </div>

        {/* 5. Hiatus */}
        <div className="ws-stat-cell">
          <div className="ws-stat-label">Hiatus</div>
          <div className="ws-stat-value">{paused_count}</div>
          <div className="ws-stat-delta">excluded from pressure</div>
        </div>

      </div>

      {/* ── Graph strip ── */}
      <div className="ws-graph-strip">

        <div className="ws-graph-card">
          <div className="ws-graph-title">7D Pace</div>
          <div className="dash-pace-primary">
            {done7d === 0 && prev7d === 0 ? (
              <span className="dash-pace-none">no activity</span>
            ) : (
              <>
                <span className="dash-pace-count">{done7d}</span>
                <span className="dash-pace-unit"> completions</span>
              </>
            )}
          </div>
          <div className="dash-pace-delta">
            {paceChangePct !== null ? (
              <span className={paceChangePct >= 0 ? 'dash-pace-up' : 'dash-pace-dn'}>
                {paceChangePct >= 0 ? '+' : ''}{paceChangePct}% vs prev 7d
              </span>
            ) : done7d > 0 ? (
              <span className="dash-pace-new">new activity</span>
            ) : null}
          </div>
          <div className="ws-graph-sub">
            best day: {bestDay} · {activeDays7d}/7 active days
          </div>
        </div>

        <div className="ws-graph-card">
          <div className="ws-graph-title">Urgency distribution</div>
          <UrgencyDist dist={urgency_distribution} total={active_count} />
        </div>

        <div className="ws-graph-card">
          <div className="ws-graph-title">Active / Hiatus</div>
          <RatioBar activeCount={active_count} pausedCount={paused_count} />
          <div className="ws-graph-sub">{active_count} active · {paused_count} hiatus</div>
        </div>

      </div>

      {/* ── Panels ── */}
      <div className="ws-panels">

        {/* ── Priority queue — full width ── */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header">
            <span>Priority queue</span>
            <span className="ws-frame-header-sub">
              top 5 · active non-paused · sorted by pressure score
              {atPeakCount > 0 && ` · ${atPeakCount} at peak (≥9.9)`}
            </span>
          </div>
          {top_5_urgent.length === 0 ? (
            <div className="ws-empty">No active tasks.</div>
          ) : (
            <table className="dash-table">
              <thead>
                <tr>
                  <th className="dash-th-urg">Urgency</th>
                  <th>Task</th>
                  <th>Section</th>
                  <th>Category</th>
                  <th className="dash-th-num">Days</th>
                  <th className="dash-th-num">Freq</th>
                  <th>Last done</th>
                </tr>
              </thead>
              <tbody>
                {top_5_urgent.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <div className="dash-urg-cell">
                        <span className={`dash-urg-num ${urgencyClass(t.urgency)}`}>
                          {t.urgency.toFixed(1)}
                        </span>
                        <UrgencyBar value={t.urgency} />
                      </div>
                    </td>
                    <td className="dash-task-name">{t.name}</td>
                    <td className="dash-muted">{t.section || '—'}</td>
                    <td className="dash-muted">{t.category || '—'}</td>
                    <td className="dash-num">{t.days_since}d</td>
                    <td className="dash-num">{t.interval_days}d</td>
                    <td className="dash-muted">{t.latest_completion || 'never'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Category pressure ── */}
        <div className="ws-frame">
          <div className="ws-frame-header">
            <span>By category</span>
            <span className="ws-frame-header-sub">avg · max · dormant · sorted by pressure</span>
          </div>
          {sortedCats.length === 0 ? (
            <div className="ws-empty">No categories.</div>
          ) : (
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="dash-th-num">Tasks</th>
                  <th className="dash-th-urg">Avg urg</th>
                  <th className="dash-th-num">Max</th>
                  <th className="dash-th-num">Dormant</th>
                </tr>
              </thead>
              <tbody>
                {sortedCats.map(([cat, s]) => (
                  <tr key={cat}>
                    <td>{cat || '—'}</td>
                    <td className="dash-num">{s.count}</td>
                    <td>
                      <div className="dash-urg-cell">
                        <span className={`dash-urg-num ${urgencyClass(s.avg_urgency)}`}>
                          {s.avg_urgency.toFixed(1)}
                        </span>
                        <UrgencyBar value={s.avg_urgency} />
                      </div>
                    </td>
                    <td className={`dash-num ${urgencyClass(s.max_urgency)}`}>
                      {s.max_urgency.toFixed(1)}
                    </td>
                    <td className={`dash-num${dormantByCat[cat] > 0 ? ' urg-high' : ''}`}>
                      {dormantByCat[cat] || 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Dormant / risk panel ── */}
        <div className="ws-frame">
          <div className="ws-frame-header">
            <span>Dormant tasks</span>
            <span className="ws-frame-header-sub">30+ days since last completion · risk zone</span>
          </div>
          {sortedDormant.length === 0 ? (
            <div className="ws-empty">No dormant tasks. All tasks completed recently.</div>
          ) : (
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Category</th>
                  <th className="dash-th-num">Days</th>
                  <th className="dash-th-num">Freq</th>
                  <th className="dash-th-num">Urg</th>
                  <th>Last done</th>
                </tr>
              </thead>
              <tbody>
                {sortedDormant.map((t) => (
                  <tr key={t.id}>
                    <td className="dash-task-name">{t.name}</td>
                    <td className="dash-muted">{t.category || '—'}</td>
                    <td className="dash-num urg-high">{t.days_since}d</td>
                    <td className="dash-num">{t.interval_days}d</td>
                    <td className={`dash-num ${urgencyClass(t.urgency)}`}>
                      {t.urgency.toFixed(1)}
                    </td>
                    <td className="dash-muted">{t.latest_completion || 'never'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Never done — compact metric ── */}
        <div className="ws-frame">
          <div className="ws-frame-header">
            <span>Never completed</span>
            <span className="ws-frame-header-sub">no completion record · no manual override</span>
          </div>
          <div className="ws-frame-body">
            <div className="dash-metric-block">
              <div className="dash-metric-value">{never_done_count}</div>
              <div className="dash-metric-desc">
                {never_done_count === 0
                  ? 'All active tasks have at least one completion or manual override on record.'
                  : `${never_done_count} active task${never_done_count !== 1 ? 's' : ''} have never been marked done. These may be new or persistently neglected.`
                }
              </div>
            </div>
          </div>
        </div>

        {/* ── Recent completions — 30-day trend ── */}
        <div className="ws-frame">
          <div className="ws-frame-header">
            <span>Recent completions</span>
            <span className="ws-frame-header-sub">
              30-day total · all tasks · {completion_trend[0]?.date} → {completion_trend[29]?.date}
            </span>
          </div>
          <div className="ws-frame-body ws-frame-body--chart">
            <SparklineBar trend={completion_trend} />
            <div className="dash-trend-labels">
              <span>{completion_trend[0]?.date}</span>
              <span>today</span>
            </div>
            <div className="dash-trend-total">
              {total30d} completion{total30d !== 1 ? 's' : ''} in 30 days
              {done7d > 0 ? ` · ${done7d} in the last 7` : ''}
            </div>
          </div>
        </div>

        {/* ── Completion heatmap — section × 30d ── */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header">
            <span>Completion heatmap</span>
            <span className="ws-frame-header-sub">
              section × date · SUM(completion_count) · {completion_heatmap.dates[0]} → {completion_heatmap.dates[29]}
            </span>
          </div>
          <div className="ws-frame-body">
            <HeatmapGrid heatmap={completion_heatmap} />
            <InsightStrip heatmap={completion_heatmap} trend={completion_trend} />
          </div>
        </div>

        {/* ── Pressure heatmap — section × historical snapshot dates ── */}
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
