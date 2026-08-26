import { useEffect, useState } from 'react';
import {
  fetchExecutionReport, fetchEstimateReport, fetchPatternsReport, fetchForecast,
} from '../api.js';
import { displayTitle } from '../linkUtils.js';

// Execution view for Reports (V5.5 Part XIV) — planned vs actual over the
// selected period, plus estimate accuracy, behavioral calibration, and the
// semester load forecast. Everything shown is a measured fact with its
// sample size; groups under the sample floor say "not enough history yet"
// instead of pretending confidence, and no composite score exists anywhere.

function h(min) {
  if (min == null) return '—';
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const hrs = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${hrs}h ${String(rem).padStart(2, '0')}m` : `${hrs}h`;
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

const DEPTH_NAMES = { 0: 'No depth', 1: 'D1 · Deep', 2: 'D2 · Focused', 3: 'D3 · Shallow' };
const PART_NAMES = { morning: 'before noon', afternoon: 'afternoon', evening: 'after 5 PM' };

function InsufficientNote({ n }) {
  return <span className="exec-insufficient">Not enough history yet · n = {n}</span>;
}

export default function ExecutionReport({ start, end }) {
  const [includeEntries, setIncludeEntries] = useState(false);
  const [exec, setExec] = useState(null);
  const [execError, setExecError] = useState(null);
  const [estimates, setEstimates] = useState(null);
  const [patterns, setPatterns] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [openWeek, setOpenWeek] = useState(null);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    setExec(null);
    setExecError(null);
    fetchExecutionReport(start, end, includeEntries)
      .then(setExec).catch((e) => setExecError(e.message));
  }, [start, end, includeEntries]);

  useEffect(() => {
    fetchEstimateReport().then(setEstimates).catch(() => setEstimates(null));
    fetchPatternsReport().then(setPatterns).catch(() => setPatterns(null));
    fetchForecast(8).then(setForecast).catch(() => setForecast(null));
  }, []);

  if (execError) return <div className="ws-empty">Could not load execution data: {execError}</div>;
  if (!exec) return <div className="ws-empty">Loading execution data…</div>;

  const followThrough = exec.planned_minutes > 0
    ? exec.actual_minutes / exec.planned_minutes : null;
  const maxWeekLoad = forecast
    ? Math.max(1, ...forecast.weeks.map((w) => w.fixed_minutes + w.flexible_minutes))
    : 1;
  const suffTod = (patterns?.time_of_day ?? []).filter((x) => !x.insufficient);
  const suffWeekday = (patterns?.weekday ?? []).filter((x) => !x.insufficient);
  const suffCtx = (patterns?.context ?? []).filter((x) => !x.insufficient);
  const insufficientAll = patterns
    && suffTod.length === 0 && suffWeekday.length === 0 && suffCtx.length === 0;

  return (
    <div className="report-body exec-report">
      {/* ── Planned vs actual (§33) ── */}
      <div className="report-summary">
        <div className="report-tile">
          <div className="report-tile-value">{h(exec.planned_minutes)}</div>
          <div className="report-tile-label">Planned work</div>
        </div>
        <div className="report-tile">
          <div className="report-tile-value">{h(exec.actual_minutes)}</div>
          <div className="report-tile-label">Actual work</div>
        </div>
        <div className="report-tile">
          <div className="report-tile-value">{followThrough != null ? pct(followThrough) : '—'}</div>
          <div className="report-tile-label">of planned time happened</div>
        </div>
        <div className="report-tile">
          <div className="report-tile-value">{h(exec.entries_actual_minutes)}</div>
          <div className="report-tile-label">calendar-only time (separate)</div>
        </div>
      </div>
      <label className="cal-popover-checkline exec-toggle">
        <input
          type="checkbox"
          checked={includeEntries}
          onChange={(e) => setIncludeEntries(e.target.checked)}
        />
        Include calendar-only entries in the totals
      </label>

      <div className="ws-panels">
        {/* by context / by depth / by day */}
        <div className="ws-frame">
          <div className="ws-frame-header"><span>By course / context</span></div>
          {exec.by_context.length === 0 ? <div className="ws-empty">No sessions in this period.</div> : (
            <table className="exec-table"><tbody>
              {exec.by_context.map((c) => (
                <tr key={String(c.context_id)}>
                  <td>{c.context_name ?? '(no context)'}</td>
                  <td className="exec-num">{h(c.planned_minutes)} planned</td>
                  <td className="exec-num">{h(c.actual_minutes)} actual</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>
        <div className="ws-frame">
          <div className="ws-frame-header"><span>By depth</span></div>
          {exec.by_depth.length === 0 ? <div className="ws-empty">No sessions in this period.</div> : (
            <table className="exec-table"><tbody>
              {exec.by_depth.map((d) => (
                <tr key={d.depth}>
                  <td>{DEPTH_NAMES[d.depth]}</td>
                  <td className="exec-num">{h(d.planned_minutes)} planned</td>
                  <td className="exec-num">{h(d.actual_minutes)} actual</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>
        <div className="ws-frame">
          <div className="ws-frame-header"><span>By task</span></div>
          {exec.by_task.length === 0 ? <div className="ws-empty">No task sessions in this period.</div> : (
            <table className="exec-table"><tbody>
              {exec.by_task.slice(0, 10).map((t) => (
                <tr key={t.task_id}>
                  <td>{displayTitle(t.name)}</td>
                  <td className="exec-num">{t.sessions}×</td>
                  <td className="exec-num">{h(t.planned_minutes)} → {h(t.actual_minutes)}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>

        {/* ── Work log (§34/§52) ── */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header">
            <span>Work log</span>
            <button type="button" className="ws-dash-crosslink"
              onClick={() => setLogOpen((o) => !o)}>
              {logOpen ? 'collapse' : `show ${exec.log.length} sessions`}
            </button>
          </div>
          {logOpen && (
            <table className="exec-table exec-log"><tbody>
              {exec.log.slice(0, 200).map((s) => (
                <tr key={s.id} className={`exec-log--${s.status}`}>
                  <td className="exec-num">{s.planned_start.slice(5, 16).replace('T', ' ')}</td>
                  <td>
                    {displayTitle(s.name)}
                    {s.is_entry ? <span className="cal-entry-chip">calendar-only</span> : null}
                  </td>
                  <td className="exec-num">planned {h(s.planned_minutes)}</td>
                  <td className="exec-num">
                    {s.status === 'skipped' && 'skipped'}
                    {s.status === 'scheduled' && 'unresolved'}
                    {(s.status === 'completed' || s.status === 'partial') && (
                      <>
                        {s.status === 'partial' ? 'partial · ' : ''}
                        actual {h(s.actual_minutes)}
                        {s.actual_start ? ` (${s.actual_start.slice(11, 16)}–${s.actual_end ? s.actual_end.slice(11, 16) : '…'})` : ''}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>

        {/* ── Estimate accuracy (§35–§37) ── */}
        <div className="ws-frame">
          <div className="ws-frame-header">
            <span>Estimate accuracy</span>
            <span className="ws-frame-header-sub">medians over recorded history · informational only</span>
          </div>
          {!estimates ? <div className="ws-empty">Loading…</div> : (
            <div className="exec-facts">
              {estimates.sessions_by_depth.map((d) => (
                <div key={d.depth} className="exec-fact">
                  <span>{DEPTH_NAMES[d.depth]} sessions</span>
                  {d.insufficient ? <InsufficientNote n={d.n} /> : (
                    <span>
                      median planned {h(d.median_planned_minutes)} · median actual{' '}
                      {h(d.median_actual_minutes)} · {d.median_ratio}× · n = {d.n}
                    </span>
                  )}
                </div>
              ))}
              <div className="exec-fact">
                <span>Finished tasks vs estimates</span>
                {estimates.tasks_overall.insufficient
                  ? <InsufficientNote n={estimates.tasks_overall.n} />
                  : (
                    <span>
                      median actual/estimate {estimates.tasks_overall.median_ratio}× ·
                      n = {estimates.tasks_overall.n}
                    </span>
                  )}
              </div>
              {estimates.tasks_by_context.filter((c) => !c.insufficient).map((c) => (
                <div key={c.context_name} className="exec-fact">
                  <span>{c.context_name}</span>
                  <span>median actual/estimate {c.median_ratio}× · n = {c.n}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Behavioral calibration (§38–§41) ── */}
        <div className="ws-frame">
          <div className="ws-frame-header">
            <span>Execution patterns</span>
            <span className="ws-frame-header-sub">historical observations, not rules</span>
          </div>
          {!patterns ? <div className="ws-empty">Loading…</div> : insufficientAll ? (
            <div className="ws-empty">Not enough execution history yet — patterns appear once enough sessions are recorded (n ≥ {patterns.min_sample}).</div>
          ) : (
            <div className="exec-facts">
              {suffTod.map((x) => (
                <div key={`${x.depth}-${x.part}`} className="exec-fact">
                  <span>{DEPTH_NAMES[x.depth]} {PART_NAMES[x.part]}</span>
                  <span>{pct(x.completed_share)} completed as planned · n = {x.n}</span>
                </div>
              ))}
              {suffWeekday.map((x) => (
                <div key={x.weekday} className="exec-fact">
                  <span>{x.name}s</span>
                  <span>median {h(x.median_actual_minutes)} recorded · n = {x.n_days} {x.name}s</span>
                </div>
              ))}
              {suffCtx.map((x) => (
                <div key={String(x.context_id)} className="exec-fact">
                  <span>{x.context_name ?? '(no context)'} sessions</span>
                  <span>median actual/planned {x.median_ratio}× · n = {x.n}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Semester load forecast (§43–§48) ── */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header">
            <span>Upcoming load — next 8 weeks</span>
            <span className="ws-frame-header-sub">fixed commitments vs flexible estimated work · click a week for its sources</span>
          </div>
          {!forecast ? <div className="ws-empty">Loading…</div> : (
            <div className="exec-forecast">
              {forecast.weeks.map((w) => {
                const total = w.fixed_minutes + w.flexible_minutes;
                const isOpen = openWeek === w.week_start;
                return (
                  <div key={w.week_start} className="exec-week">
                    <button
                      type="button"
                      className={`exec-week-row${isOpen ? ' is-open' : ''}`}
                      onClick={() => setOpenWeek(isOpen ? null : w.week_start)}
                    >
                      <span className="exec-week-label">
                        {w.week_start.slice(5).replace('-', '/')}–{w.week_end.slice(5).replace('-', '/')}
                      </span>
                      <span className="exec-week-bar" aria-hidden="true">
                        <span className="exec-week-bar-fixed"
                          style={{ width: `${(w.fixed_minutes / maxWeekLoad) * 100}%` }} />
                        <span className="exec-week-bar-flex"
                          style={{ width: `${(w.flexible_minutes / maxWeekLoad) * 100}%` }} />
                      </span>
                      <span className="exec-week-nums">
                        {h(w.fixed_minutes)} fixed · {h(w.flexible_minutes)} flexible
                        {w.due_remaining_minutes > 0 && (
                          <span className="cal-coverage-warn"> · {h(w.due_remaining_minutes)} unscheduled</span>
                        )}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="exec-week-detail">
                        {w.items.length === 0 && <span className="dash-muted">No flexible work placed in this week.</span>}
                        {w.items.map((i, idx) => (
                          <div key={idx} className="exec-fact">
                            <span>
                              {displayTitle(i.name)}
                              {i.overdue ? ' · past due' : ''}
                              {i.type === 'scheduled' ? ` · scheduled ${i.date?.slice(5)}` : (i.due_date ? ` · due ${i.due_date.slice(5)}` : '')}
                            </span>
                            <span>{h(i.minutes)}</span>
                          </div>
                        ))}
                        {(w.depth_minutes['1'] || w.depth_minutes['2'] || w.depth_minutes['3']) ? (
                          <div className="dash-muted">
                            Depth: {['1', '2', '3'].filter((d) => w.depth_minutes[d] > 0)
                              .map((d) => `D${d} ${h(w.depth_minutes[d])}`).join(' · ')}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
              {forecast.undated.total_minutes > 0 && (
                <div className="exec-fact exec-undated">
                  <span>
                    Estimated work without a deadline (not placed in any week):{' '}
                    {forecast.undated.items.slice(0, 5).map((i) => displayTitle(i.name)).join(', ')}
                  </span>
                  <span>{h(forecast.undated.total_minutes)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
