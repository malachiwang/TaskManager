import { useState, useEffect } from 'react';
import { fetchDashboard } from '../api.js';

function urgencyClass(u) {
  if (u >= 8) return 'urg-critical';
  if (u >= 6) return 'urg-high';
  if (u >= 3) return 'urg-noticeable';
  return 'urg-low';
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
  if (!data) return <div className="grid-status">Loading…</div>;

  const { top_5_urgent, category_summary, dormant_tasks, paused_count, never_done_count } = data;

  return (
    <div className="dashboard">

      {/* Summary stats */}
      <section className="dash-section">
        <div className="dash-section-title">Overview</div>
        <div className="dash-stats">
          <div className="dash-stat">
            <span className="dash-stat-value">{paused_count}</span>
            <span className="dash-stat-label">Paused</span>
          </div>
          <div className="dash-stat">
            <span className="dash-stat-value">{never_done_count}</span>
            <span className="dash-stat-label">Never done</span>
          </div>
          <div className="dash-stat">
            <span className="dash-stat-value">{dormant_tasks.length}</span>
            <span className="dash-stat-label">Dormant (30d+)</span>
          </div>
        </div>
      </section>

      {/* Top 5 urgent */}
      <section className="dash-section">
        <div className="dash-section-title">Top 5 Urgent</div>
        {top_5_urgent.length === 0 ? (
          <div className="dash-empty">No active tasks.</div>
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
                  <td className={urgencyClass(t.urgency)}>{t.urgency}</td>
                  <td>{t.name}</td>
                  <td>{t.category}</td>
                  <td>{t.days_since}</td>
                  <td>{t.interval_days}d</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Category summary */}
      <section className="dash-section">
        <div className="dash-section-title">By Category</div>
        {Object.keys(category_summary).length === 0 ? (
          <div className="dash-empty">No categories.</div>
        ) : (
          <table className="dash-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Tasks</th>
                <th>Avg Urg</th>
                <th>Max Urg</th>
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
      </section>

      {/* Dormant tasks */}
      <section className="dash-section">
        <div className="dash-section-title">Dormant Tasks (30+ days)</div>
        {dormant_tasks.length === 0 ? (
          <div className="dash-empty">No dormant tasks.</div>
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
      </section>

    </div>
  );
}
