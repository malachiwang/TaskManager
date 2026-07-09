import { useState, useEffect, useMemo } from 'react';
import { fetchTasks, fetchCompletions, fetchSnapshotPressure, fetchReadingBooks } from '../api.js';
import { urgencyClass, urgencyLabel } from '../urgency.js';
import {
  completionSummary, consistency, finishedInPeriod,
  carriedForward, neglectedAllPeriod, sectionBreakdown, sectionPressureChange,
  cleanupReport, readingSummary,
  PERIOD_MODES, periodRange, periodLabel, shiftPeriodAnchor,
} from '../reportAnalytics.js';

const PERIOD_MODE_LABELS = { week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' };

// Compact CSS/SVG day-bar chart for the period.
function PeriodBars({ perDay }) {
  const max = Math.max(...perDay.map((d) => d.count), 1);
  const W = 620, H = 40, GAP = 1;
  const barW = Math.max(1, (W - GAP * (perDay.length - 1)) / perDay.length);
  return (
    <svg className="report-bars" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {perDay.map((d, i) => {
        const h = d.count > 0 ? Math.max(2, (d.count / max) * H) : 0;
        return <rect key={d.date} x={i * (barW + GAP)} y={H - h} width={barW} height={h}
          className={d.count > 0 ? 'report-bar' : 'report-bar report-bar--empty'} />;
      })}
    </svg>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${m}/${d}`;
}

export default function MonthlyReport({ onOpenDashboard }) {
  const now = new Date();
  // Period = mode (week/month/quarter/year) + an anchor date inside it (P10.0).
  const [period, setPeriod] = useState({ mode: 'month', anchor: now });
  const [tasks, setTasks] = useState(null);
  const [tasksError, setTasksError] = useState(null);
  const [completions, setCompletions] = useState(null);
  const [compError, setCompError] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [books, setBooks] = useState(null);

  const { start, end } = useMemo(
    () => periodRange(period.mode, period.anchor),
    [period],
  );

  // Current-state fetches (once).
  useEffect(() => {
    fetchTasks().then(setTasks).catch((e) => setTasksError(e.message));
    fetchSnapshotPressure(60).then(setSnapshot).catch(() => setSnapshot({ rows: [], dates: [] }));
    fetchReadingBooks().then(setBooks).catch(() => setBooks([]));
  }, []);

  // Period completions (refetch on period change).
  useEffect(() => {
    setCompletions(null); setCompError(null);
    fetchCompletions(start, end).then(setCompletions).catch((e) => setCompError(e.message));
  }, [start, end]);

  const taskMap = useMemo(() => new Map((tasks || []).map((t) => [t.id, t])), [tasks]);
  const activity = useMemo(
    () => (completions ? completionSummary(completions, taskMap, start, end) : null),
    [completions, taskMap, start, end],
  );
  const finished = useMemo(() => (tasks ? finishedInPeriod(tasks, start, end) : []), [tasks, start, end]);
  const carried = useMemo(() => (tasks ? carriedForward(tasks) : []), [tasks]);
  const neglected = useMemo(
    () => (tasks && activity ? neglectedAllPeriod(tasks, activity.taskIdsWithCompletion, start, end) : []),
    [tasks, activity, start, end],
  );
  const breakdown = useMemo(
    () => (tasks && activity ? sectionBreakdown(tasks, activity.sectionRows, finished, new Set(neglected.map((t) => t.id))) : []),
    [tasks, activity, finished, neglected],
  );
  const cons = useMemo(() => (activity ? consistency(activity.perDay) : null), [activity]);
  const pressure = useMemo(() => sectionPressureChange(snapshot), [snapshot]);
  const cleanup = useMemo(() => (tasks ? cleanupReport(tasks) : null), [tasks]);
  const reading = useMemo(() => (books ? readingSummary(books, start, end) : null), [books, start, end]);

  const uncatHeavy = tasks && cleanup && cleanup.active > 0 && cleanup.uncategorizedPct >= 40;

  function shiftPeriod(delta) {
    setPeriod(({ mode, anchor }) => ({ mode, anchor: shiftPeriodAnchor(mode, anchor, delta) }));
  }
  function currentPeriod() { setPeriod(({ mode }) => ({ mode, anchor: new Date() })); }
  function setMode(mode) { setPeriod(({ anchor }) => ({ mode, anchor })); }

  const maxSectionComp = Math.max(...breakdown.map((s) => s.completions), 1);
  const label = periodLabel(period.mode, period.anchor);

  return (
    <div className="ws-dashboard report-view">
      {/* Header + period selector */}
      <div className="ws-dash-header">
        <div className="ws-dash-header-left">
          <div className="ws-dash-title">Reports</div>
          <div className="ws-dash-sub">
            what happened over time · historical trends, completion patterns, pressure changes, reading progress
            {onOpenDashboard && (
              <>
                {' · '}
                <button type="button" className="ws-dash-crosslink" onClick={onOpenDashboard}>
                  for what to do next, open Dashboard →
                </button>
              </>
            )}
          </div>
        </div>
        <div className="report-period">
          <div className="report-period-modes" role="group" aria-label="Report period">
            {PERIOD_MODES.map((m) => (
              <button
                key={m}
                className={`report-mode-btn${period.mode === m ? ' report-mode-btn--active' : ''}`}
                aria-pressed={period.mode === m}
                onClick={() => setMode(m)}
              >
                {PERIOD_MODE_LABELS[m]}
              </button>
            ))}
          </div>
          <button className="report-nav" onClick={() => shiftPeriod(-1)}>‹</button>
          <button className="report-nav report-nav--today" onClick={currentPeriod}>
            Current {PERIOD_MODE_LABELS[period.mode].toLowerCase()}
          </button>
          <span className="report-period-label">{label}</span>
          <button className="report-nav" onClick={() => shiftPeriod(1)}>›</button>
        </div>
      </div>

      <div className="report-body">

        {/* Summary tiles */}
        <div className="report-summary">
          <div className="report-tile"><div className="report-tile-value">{activity ? activity.total : '—'}</div><div className="report-tile-label">Completions</div></div>
          <div className="report-tile"><div className="report-tile-value">{activity ? `${activity.activeDays}/${activity.totalDays}` : '—'}</div><div className="report-tile-label">Active days</div></div>
          <div className="report-tile"><div className="report-tile-value">{activity ? activity.bestDay.count : '—'}</div><div className="report-tile-label">Best day</div></div>
          <div className="report-tile"><div className="report-tile-value report-tile-value--sm">{activity ? (activity.mostActiveSection || '—') : '—'}</div><div className="report-tile-label">Most active</div></div>
          <div className="report-tile"><div className="report-tile-value">{tasks ? finished.length : '—'}</div><div className="report-tile-label">Finished</div></div>
          <div className="report-tile"><div className="report-tile-value">{tasks ? carried.length : '—'}</div><div className="report-tile-label">Carried fwd</div></div>
          <div className="report-tile"><div className="report-tile-value">{tasks && activity ? neglected.length : '—'}</div><div className="report-tile-label">Neglected</div></div>
        </div>

        {/* Completed this period */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header"><span>Completed This Period</span><span className="ws-frame-header-sub">completion checkbox activity in {label}</span></div>
          <div className="ws-frame-body">
            {compError ? <div className="ws-empty">Could not load completions.</div>
              : !activity ? <div className="ws-empty">Loading…</div>
              : activity.total === 0 ? <div className="ws-empty">No completions were logged this period.</div>
              : (
                <>
                  <PeriodBars perDay={activity.perDay} />
                  <div className="report-activity-meta">
                    <span><strong>{activity.total}</strong> completions</span>
                    <span><strong>{activity.activeDays}</strong>/{activity.totalDays} active days</span>
                    <span>best day <strong>{activity.bestDay.count}</strong>{activity.bestDay.date ? ` (${fmtDate(activity.bestDay.date)})` : ''}</span>
                  </div>
                  <div className="report-two-col">
                    <div>
                      <div className="report-subhead">By section</div>
                      <table className="dash-table">
                        <tbody>
                          {activity.sectionRows.slice(0, 6).map((s) => (
                            <tr key={s.section}><td>{s.section}</td>
                              <td className="dash-num">{s.count}</td>
                              <td><span className="report-inbar"><span className="report-inbar-fill" style={{ width: `${(s.count / (activity.sectionRows[0]?.count || 1)) * 100}%` }} /></span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div>
                      <div className="report-subhead">Top tasks</div>
                      <table className="dash-table">
                        <tbody>
                          {activity.topTasks.map((t) => (
                            <tr key={t.id}><td className="dash-task-name">{t.name}</td>
                              <td className="dash-muted">{t.section}</td>
                              <td className="dash-num">{t.count}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
          </div>
        </div>

        {/* Finished this period */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header"><span>Finished This Period</span><span className="ws-frame-header-sub">explicit Finished (end date in period) · not completion checkboxes</span></div>
          {tasksError ? <div className="ws-empty">Could not load tasks.</div>
            : !tasks ? <div className="ws-empty">Loading…</div>
            : finished.length === 0 ? <div className="ws-empty">No tasks were marked Finished this period.</div>
            : (
              <table className="dash-table">
                <thead><tr><th>Task</th><th>Section</th><th>Category</th><th className="dash-th-num">Finished</th><th className="dash-th-num">Freq</th></tr></thead>
                <tbody>
                  {finished.map((t) => (
                    <tr key={t.id}><td className="dash-task-name">{t.name}</td>
                      <td className="dash-muted">{t.section || '—'}</td>
                      <td className="dash-muted">{t.category || '—'}</td>
                      <td className="dash-num">{fmtDate(t.end_date)}</td>
                      <td className="dash-num">{t.interval_days}d</td></tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>

        {/* Carried forward */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header"><span>Carried Forward</span><span className="ws-frame-header-sub">currently unresolved · high pressure still active (current-state approximation)</span></div>
          {!tasks ? <div className="ws-empty">Loading…</div>
            : carried.length === 0 ? <div className="ws-empty">Nothing high-pressure is currently carried forward.</div>
            : (
              <table className="dash-table">
                <thead><tr><th className="dash-th-urg">Urg</th><th>Task</th><th>Section</th><th className="dash-th-num">Overdue</th><th>Band</th></tr></thead>
                <tbody>
                  {carried.map((t) => (
                    <tr key={t.id}>
                      <td><span className={`dash-urg-num ${urgencyClass(t.urgency)}`}>{(t.urgency ?? 0).toFixed(1)}</span></td>
                      <td className="dash-task-name">{t.name}</td>
                      <td className="dash-muted">{t.section || '—'}</td>
                      <td className="dash-num">{(t.days_overdue ?? 0) > 0 ? `${t.days_overdue}d` : '—'}</td>
                      <td className="dash-muted">{urgencyLabel(t.urgency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>

        {/* Neglected all period */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header"><span>Neglected All Period</span><span className="ws-frame-header-sub">active but no completion during the period</span></div>
          {!tasks || !activity ? <div className="ws-empty">Loading…</div>
            : neglected.length === 0 ? <div className="ws-empty">Every relevant active task got some attention this period.</div>
            : (
              <table className="dash-table">
                <thead><tr><th className="dash-th-urg">Urg</th><th>Task</th><th>Section</th><th className="dash-th-num">P</th><th>Last done</th><th className="dash-th-num">Stale</th></tr></thead>
                <tbody>
                  {neglected.map((t) => (
                    <tr key={t.id}>
                      <td><span className={`dash-urg-num ${urgencyClass(t.urgency)}`}>{(t.urgency ?? 0).toFixed(1)}</span></td>
                      <td className="dash-task-name">{t.name}</td>
                      <td className="dash-muted">{t.section || '—'}</td>
                      <td className="dash-num">{t.priority}</td>
                      <td className="dash-muted">{t.latest_completion || 'never'}</td>
                      <td className="dash-num">{t.days_since}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>

        {/* Section breakdown */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header"><span>Section Breakdown</span><span className="ws-frame-header-sub">completions + current pressure by section</span></div>
          {uncatHeavy && (
            <div className="report-note">Category analysis is limited — {cleanup.uncategorizedPct}% of active tasks are uncategorized.</div>
          )}
          {!tasks || !activity ? <div className="ws-empty">Loading…</div>
            : breakdown.length === 0 ? <div className="ws-empty">No active sections.</div>
            : (
              <table className="dash-table dashboard-section-pressure">
                <thead><tr><th>Section</th><th className="dash-th-num">Completions</th><th className="dash-th-urg">Avg urg</th><th className="dash-th-num">High+</th><th className="dash-th-num">Neglected</th><th className="dash-th-num">Finished</th></tr></thead>
                <tbody>
                  {breakdown.map((s) => (
                    <tr key={s.section} className={s.section === '(no section)' ? 'dashboard-row-warn' : ''}>
                      <td>{s.section}</td>
                      <td className="dash-num">
                        <div className="dashboard-count-bar-cell"><span>{s.completions}</span>
                          <span className="dashboard-count-bar"><span className="dashboard-count-bar-fill" style={{ width: `${(s.completions / maxSectionComp) * 100}%`, background: 'var(--good)' }} /></span>
                        </div>
                      </td>
                      <td><span className={`dash-urg-num ${urgencyClass(s.avgUrg)}`}>{s.avgUrg.toFixed(1)}</span></td>
                      <td className={`dash-num${s.highCrit > 0 ? ' urg-high' : ''}`}>{s.highCrit}</td>
                      <td className="dash-num">{s.neglected}</td>
                      <td className="dash-num">{s.finished}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>

        {/* Consistency + Pressure change (two compact frames side by side via grid) */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header"><span>Consistency</span><span className="ws-frame-header-sub">momentum over the period</span></div>
          <div className="ws-frame-body">
            {!cons ? <div className="ws-empty">Loading…</div> : (
              <div className="report-stat-row">
                <span><strong>{cons.activeDays}</strong>/{cons.totalDays} active days</span>
                <span>longest streak <strong>{cons.longestStreak}</strong>d</span>
                <span>longest gap <strong>{cons.longestGap}</strong>d</span>
                <span><strong>{cons.perActiveDay}</strong> completions / active day</span>
              </div>
            )}
          </div>
        </div>

        {/* Pressure change */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header"><span>Pressure Change</span><span className="ws-frame-header-sub">section-level · from snapshot history (task-level history not stored)</span></div>
          <div className="ws-frame-body">
            {!snapshot ? <div className="ws-empty">Loading…</div>
              : !pressure.supported ? (
                <div className="report-note">Pressure change uses available snapshot days only — not enough snapshot history yet ({pressure.dayCount} day{pressure.dayCount !== 1 ? 's' : ''} captured). Visit the Dashboard regularly to build it.</div>
              ) : (
                <div className="report-two-col">
                  <div>
                    <div className="report-subhead">Getting worse</div>
                    {pressure.rising.length === 0 ? <div className="dashboard-insight-empty">None.</div> : (
                      <ul className="report-change-list">
                        {pressure.rising.map((r) => <li key={r.label}><span>{r.label}</span><span className="dash-pace-dn">▲ +{r.delta}</span><span className="dash-muted">{r.start}→{r.end}</span></li>)}
                      </ul>
                    )}
                  </div>
                  <div>
                    <div className="report-subhead">Improving</div>
                    {pressure.falling.length === 0 ? <div className="dashboard-insight-empty">None.</div> : (
                      <ul className="report-change-list">
                        {pressure.falling.map((r) => <li key={r.label}><span>{r.label}</span><span className="dash-pace-up">▼ {r.delta}</span><span className="dash-muted">{r.start}→{r.end}</span></li>)}
                      </ul>
                    )}
                  </div>
                </div>
              )}
          </div>
        </div>

        {/* System cleanup */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header"><span>System Cleanup</span><span className="ws-frame-header-sub">is this backlog real work, or dirty setup?</span></div>
          <div className="ws-frame-body">
            {!cleanup ? <div className="ws-empty">Loading…</div> : (
              <div className="report-stat-row">
                <span><strong>{cleanup.active}</strong> active tasks</span>
                <span className={cleanup.neverDonePct >= 25 ? 'dashboard-warn-text' : ''}><strong>{cleanup.neverDone}</strong> never done ({cleanup.neverDonePct}%)</span>
                <span className={cleanup.uncategorizedPct >= 40 ? 'dashboard-warn-text' : ''}><strong>{cleanup.uncategorized}</strong> uncategorized ({cleanup.uncategorizedPct}%)</span>
                {cleanup.reading > 0 && <span><strong>{cleanup.reading}</strong> reading-like (consider Reading Sheet)</span>}
              </div>
            )}
          </div>
        </div>

        {/* Reading summary (books-only, optional) */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header"><span>Reading Summary</span><span className="ws-frame-header-sub">books activity · from the Reading Sheet</span></div>
          <div className="ws-frame-body">
            {!reading ? <div className="ws-empty">Loading…</div>
              : reading.total === 0 ? <div className="ws-empty">No books tracked yet.</div>
              : (
                <>
                  <div className="report-stat-row">
                    <span><strong>{reading.updatedInPeriod}</strong> updated this period</span>
                    <span><strong>{reading.finishedInPeriod.length}</strong> finished this period</span>
                    <span>{reading.active} active · {reading.finishedTotal} finished · {reading.archived} archived</span>
                  </div>
                  {reading.updatedList.length > 0 && (
                    <div className="report-note">Recently updated: {reading.updatedList.map((b) => b.title).join(', ')}</div>
                  )}
                </>
              )}
          </div>
        </div>

      </div>
    </div>
  );
}
