import { useEffect, useState } from 'react';
import { fetchForecast, fetchPatternsReport } from '../api.js';
import { displayTitle } from '../linkUtils.js';

// Dashboard semester signals (V5.5 Part XIII §49/§50) — only ACTIONABLE
// facts surface here; history and full analysis live in Reports. Every card
// renders only when it has something worth attention, so an empty semester
// shows nothing instead of noise.

function h(min) {
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const hrs = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${hrs}h ${String(rem).padStart(2, '0')}m` : `${hrs}h`;
}

const DEPTH_NAMES = { 1: 'D1', 2: 'D2', 3: 'D3' };
const PART_NAMES = { morning: 'before noon', afternoon: 'in the afternoon', evening: 'after 5 PM' };

export default function SemesterSignals({ tasks }) {
  const [forecast, setForecast] = useState(null);
  const [patterns, setPatterns] = useState(null);

  useEffect(() => {
    fetchForecast(6).then(setForecast).catch(() => setForecast(null));
    fetchPatternsReport().then(setPatterns).catch(() => setPatterns(null));
  }, []);

  // ── Upcoming load: call out a week that stands out from its neighbors ────
  let loadCard = null;
  if (forecast) {
    const weeks = forecast.weeks;
    const loads = weeks.map((w) => w.fixed_minutes + w.flexible_minutes);
    const max = Math.max(...loads);
    if (max > 0) {
      const heaviestIdx = loads.indexOf(max);
      const others = loads.filter((_, i) => i !== heaviestIdx);
      const othersMax = Math.max(...others, 0);
      const heavy = weeks[heaviestIdx];
      const unscheduled = weeks.reduce((s, w) => s + w.due_remaining_minutes, 0);
      loadCard = {
        weeks,
        max,
        callout: max >= othersMax * 1.4 && max >= 120 ? heavy : null,
        unscheduled,
      };
    }
  }

  // ── Deadline coverage: due within 7 days with unscheduled remaining ──────
  const today = new Date();
  const horizon = new Date(today.getTime() + 7 * 86400000);
  const isoHorizon = horizon.toISOString().slice(0, 10);
  const coverage = (tasks || [])
    .filter((t) => !t.is_paused && !t.is_ended
      && (t.remaining_unscheduled_before_due ?? 0) > 0
      && t.due_date && t.due_date <= isoHorizon)
    .sort((a, b) => (a.due_date < b.due_date ? -1 : 1))
    .slice(0, 3);

  // ── Execution pattern: strongest sufficient same-depth contrast ──────────
  let patternFact = null;
  if (patterns) {
    const suff = patterns.time_of_day.filter((x) => !x.insufficient && x.depth > 0);
    let best = null;
    for (const a of suff) {
      for (const b of suff) {
        if (a.depth !== b.depth || a.part === b.part) continue;
        const gap = a.completed_share - b.completed_share;
        if (gap >= 0.2 && (!best || gap > best.gap)) best = { a, b, gap };
      }
    }
    if (best) {
      patternFact = `${DEPTH_NAMES[best.a.depth]} work ${PART_NAMES[best.a.part]} has completed as planned ${Math.round(best.a.completed_share * 100)}% of the time (n = ${best.a.n}), vs ${Math.round(best.b.completed_share * 100)}% ${PART_NAMES[best.b.part]} (n = ${best.b.n}).`;
    }
  }

  if (!loadCard && coverage.length === 0 && !patternFact) return null;

  return (
    <div className="ws-frame ws-frame--full dash-semester">
      <div className="ws-frame-header">
        <span>Semester signals</span>
      </div>
      <div className="ws-frame-body dash-semester-grid">
        {loadCard && (
          <div className="dash-signal">
            <div className="dash-signal-title">Upcoming load</div>
            <div className="dash-signal-bars" aria-hidden="true">
              {loadCard.weeks.map((w) => (
                <div key={w.week_start} className="dash-signal-week"
                  title={`${w.week_start.slice(5)}: ${h(w.fixed_minutes)} fixed + ${h(w.flexible_minutes)} flexible`}>
                  <div className="dash-signal-bar">
                    <div className="dash-signal-bar-flex"
                      style={{ height: `${(w.flexible_minutes / loadCard.max) * 100}%` }} />
                    <div className="dash-signal-bar-fixed"
                      style={{ height: `${(w.fixed_minutes / loadCard.max) * 100}%` }} />
                  </div>
                  <span className="dash-signal-week-label">{w.week_start.slice(8)}</span>
                </div>
              ))}
            </div>
            <div className="dash-signal-copy">
              {loadCard.callout
                ? `Week of ${loadCard.callout.week_start.slice(5).replace('-', '/')} is substantially heavier than surrounding weeks (${h(loadCard.callout.fixed_minutes + loadCard.callout.flexible_minutes)}).`
                : 'No week stands out from its neighbors right now.'}
              {loadCard.unscheduled > 0
                ? ` ${h(loadCard.unscheduled)} of estimated work is not yet scheduled.`
                : ''}
            </div>
          </div>
        )}
        {coverage.length > 0 && (
          <div className="dash-signal">
            <div className="dash-signal-title">Deadline coverage</div>
            {coverage.map((t) => (
              <div key={t.id} className="dash-signal-row">
                <span>{displayTitle(t.name)}</span>
                <span className="cal-coverage-warn">
                  {h(t.remaining_unscheduled_before_due)} unscheduled before {t.due_date.slice(5)}
                </span>
              </div>
            ))}
            <div className="dash-signal-copy dash-muted">Schedule sessions on the Calendar to close the gap.</div>
          </div>
        )}
        {patternFact && (
          <div className="dash-signal">
            <div className="dash-signal-title">Execution pattern</div>
            <div className="dash-signal-copy">{patternFact}</div>
            <div className="dash-signal-copy dash-muted">A historical observation, not a rule.</div>
          </div>
        )}
      </div>
    </div>
  );
}
