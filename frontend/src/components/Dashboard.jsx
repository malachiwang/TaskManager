import { useState, useEffect } from 'react';
import { fetchDashboard } from '../api.js';

function urgencyClass(u) {
  if (u >= 8) return 'urg-critical';
  if (u >= 6) return 'urg-high';
  if (u >= 3) return 'urg-noticeable';
  return 'urg-low';
}

function nowLabel() {
  const d = new Date();
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} · ${time}`;
}

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

  const { top_5_urgent, category_summary, dormant_tasks, paused_count, never_done_count } = data;

  // Derived from existing data only — no new API calls
  const peakUrgency  = top_5_urgent.length > 0 ? top_5_urgent[0].urgency.toFixed(1) : '—';
  const peakTaskName = top_5_urgent.length > 0 ? top_5_urgent[0].name : null;
  const categoryCount = Object.keys(category_summary).length;

  return (
    <div className="ws-dashboard">

      {/* ── Serif headline (§08 .dh pattern) ── */}
      <div className="ws-dash-header">
        <div className="ws-dash-header-left">
          <div className="ws-dash-title">Pressure readout</div>
          <div className="ws-dash-sub">all sections · live</div>
        </div>
        <div className="ws-dash-now">{nowLabel()}</div>
      </div>

      {/* ── Stat strip (§08 .ds/.st pattern — 5 cells, Plex Serif numerals) ── */}
      <div className="ws-stat-strip">
        <div className="ws-stat-cell">
          <div className="ws-stat-label">Peak urgency</div>
          <div className="ws-stat-value">{peakUrgency}<small>/10</small></div>
          <div className="ws-stat-delta">
            {peakTaskName ? peakTaskName.slice(0, 20) : 'no active tasks'}
          </div>
        </div>
        <div className="ws-stat-cell">
          <div className="ws-stat-label">Never done</div>
          <div className="ws-stat-value">{never_done_count}</div>
          <div className="ws-stat-delta">tasks</div>
        </div>
        <div className="ws-stat-cell">
          <div className="ws-stat-label">Dormant 30d+</div>
          <div className="ws-stat-value">{dormant_tasks.length}</div>
          <div className={`ws-stat-delta${dormant_tasks.length > 0 ? ' dn' : ''}`}>
            {dormant_tasks.length > 0 ? 'risk zone' : 'clear'}
          </div>
        </div>
        <div className="ws-stat-cell">
          <div className="ws-stat-label">Paused</div>
          <div className="ws-stat-value">{paused_count}</div>
          <div className="ws-stat-delta">tasks</div>
        </div>
        <div className="ws-stat-cell">
          <div className="ws-stat-label">Categories</div>
          <div className="ws-stat-value">{categoryCount}</div>
          <div className="ws-stat-delta">active</div>
        </div>
      </div>

      {/* ── Data panels (§09 .frame/.mh pattern) ── */}
      <div className="ws-panels">

        {/* Urgent queue */}
        <div className="ws-frame">
          <div className="ws-frame-header">
            <span>Urgent queue</span>
            <span className="ws-frame-header-sub">top 5 · by pressure score</span>
          </div>
          {top_5_urgent.length === 0 ? (
            <div className="ws-empty">No active tasks.</div>
          ) : (
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Urg</th>
                  <th>Task</th>
                  <th>Category</th>
                  <th>Days</th>
                  <th>Freq</th>
                </tr>
              </thead>
              <tbody>
                {top_5_urgent.map((t) => (
                  <tr key={t.id}>
                    <td className={urgencyClass(t.urgency)}>{t.urgency.toFixed(1)}</td>
                    <td>{t.name}</td>
                    <td>{t.category}</td>
                    <td>{t.days_since}</td>
                    <td>{t.interval_days}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Category breakdown */}
        <div className="ws-frame">
          <div className="ws-frame-header">
            <span>By category</span>
            <span className="ws-frame-header-sub">avg / max pressure</span>
          </div>
          {Object.keys(category_summary).length === 0 ? (
            <div className="ws-empty">No categories.</div>
          ) : (
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Tasks</th>
                  <th>Avg</th>
                  <th>Max</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(category_summary)
                  .sort((a, b) => b[1].avg_urgency - a[1].avg_urgency)
                  .map(([cat, s]) => (
                    <tr key={cat}>
                      <td>{cat || '—'}</td>
                      <td>{s.count}</td>
                      <td>{s.avg_urgency.toFixed(1)}</td>
                      <td className={urgencyClass(s.max_urgency)}>{s.max_urgency.toFixed(1)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Dormant tasks — full width */}
        <div className="ws-frame ws-frame--full">
          <div className="ws-frame-header">
            <span>Dormant tasks</span>
            <span className="ws-frame-header-sub">not completed in 30+ days · risk zone</span>
          </div>
          {dormant_tasks.length === 0 ? (
            <div className="ws-empty">No dormant tasks.</div>
          ) : (
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Category</th>
                  <th>Days</th>
                  <th>Freq</th>
                </tr>
              </thead>
              <tbody>
                {dormant_tasks.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{t.category}</td>
                    <td>{t.days_since}</td>
                    <td>{t.interval_days}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

      </div>
    </div>
  );
}
