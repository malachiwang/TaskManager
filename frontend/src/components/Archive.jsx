import { useState, useEffect } from 'react';
import { fetchArchives, fetchArchive } from '../api.js';

function buildDates(start, end) {
  const dates = [];
  const d = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  while (d <= e) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function cellDisplay(count) {
  if (!count) return '';
  if (count === 1) return '✓';
  return String(count);
}

function dateLabel(isoDate) {
  const [y, m, day] = isoDate.split('-').map(Number);
  const d = new Date(y, m - 1, day);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function ArchiveMiniGrid({ data }) {
  const { tasks, start_date, end_date } = data;
  const dates = buildDates(start_date, end_date);

  return (
    <div className="archive-grid-wrapper">
      <table className="task-grid archive-grid">
        <thead>
          <tr>
            <th className="col-urg" title="Urgency">Urg</th>
            <th className="col-pri" title="Priority">P</th>
            <th className="col-status">Status</th>
            <th className="col-cat">Category</th>
            <th className="col-task">Task</th>
            <th className="col-freq" title="Frequency">Freq</th>
            <th className="col-days" title="Days since">Days</th>
            {dates.map((d) => (
              <th key={d} className="date-col-header">{dateLabel(d)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id} className={task.is_paused ? 'task-row paused' : 'task-row'}>
              <td className="col-urg">{task.is_paused ? '—' : task.urgency}</td>
              <td className="col-pri">{task.priority}</td>
              <td className="col-status">{task.status}</td>
              <td className="col-cat">{task.category}</td>
              <td className="col-task" title={task.name}>{task.name}</td>
              <td className="col-freq">{task.interval_days}d</td>
              <td className="col-days">{task.is_paused ? '—' : task.days_since}</td>
              {dates.map((d) => {
                const count = task.completions?.[d] || 0;
                return (
                  <td key={d} className={`date-cell${count ? ' has-count' : ''}`}>
                    {cellDisplay(count)}
                  </td>
                );
              })}
            </tr>
          ))}
          {tasks.length === 0 && (
            <tr>
              <td colSpan={7 + dates.length} className="dash-empty">No tasks in this snapshot.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function Archive() {
  const [archives, setArchives] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    fetchArchives()
      .then(setArchives)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function handleView(id) {
    setDetailLoading(true);
    fetchArchive(id)
      .then(setSelected)
      .catch((e) => setError(e.message))
      .finally(() => setDetailLoading(false));
  }

  if (loading) return <div className="grid-status">Loading…</div>;
  if (error) return <div className="grid-status error">Error: {error}</div>;

  return (
    <div className="archive">
      <section className="dash-section">
        <div className="dash-section-title">Saved Snapshots</div>
        {archives.length === 0 ? (
          <div className="dash-empty">
            No archives yet. Use <strong>Archive Current Sheet</strong> in the Grid tab.
          </div>
        ) : (
          <table className="dash-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Date Range</th>
                <th>Archived At</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {archives.map((a) => (
                <tr key={a.id} className={selected?.id === a.id ? 'archive-row-selected' : ''}>
                  <td>{a.name}</td>
                  <td>{a.start_date} → {a.end_date}</td>
                  <td>{a.archived_at.replace('T', ' ').slice(0, 19)}</td>
                  <td>
                    <button className="action-btn" onClick={() => handleView(a.id)}>View</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {detailLoading && <div className="grid-status">Loading snapshot…</div>}

      {selected && !detailLoading && (
        <section className="dash-section archive-detail">
          <div className="dash-section-title">
            {selected.name} — {selected.snapshot_data_json.start_date} to {selected.snapshot_data_json.end_date}
          </div>
          <ArchiveMiniGrid data={selected.snapshot_data_json} />
        </section>
      )}
    </div>
  );
}
