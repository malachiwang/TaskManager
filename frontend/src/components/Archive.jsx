import { useState, useEffect } from 'react';
import { fetchArchives, fetchArchive, previewImport, applyImport } from '../api.js';

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
            <th className="col-section">Section</th>
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
              <td className="col-section">{task.section || ''}</td>
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

// ---------------------------------------------------------------------------
// Import preview
// ---------------------------------------------------------------------------

function PreviewResults({ preview }) {
  const {
    row_count, detected_metadata_columns, detected_date_columns,
    candidate_date_columns, unrecognized_columns, sample_rows, warnings,
  } = preview;

  const detected = Object.entries(detected_metadata_columns).filter(([, v]) => v !== null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px' }}>
      <div><strong>Rows detected:</strong> {row_count}</div>

      {warnings.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, color: '#b36a00', marginBottom: '3px' }}>Warnings</div>
          <ul style={{ margin: 0, paddingLeft: '18px', color: '#b36a00' }}>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {detected.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: '3px' }}>Detected metadata columns</div>
          <table className="dash-table">
            <thead><tr><th>Field</th><th>CSV Header</th></tr></thead>
            <tbody>
              {detected.map(([field, header]) => (
                <tr key={field}><td>{field}</td><td>{header}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detected_date_columns.length > 0 && (
        <div>
          <strong>Date columns ({detected_date_columns.length}):</strong>{' '}
          {detected_date_columns.slice(0, 6).join(', ')}{detected_date_columns.length > 6 ? ' …' : ''}
        </div>
      )}

      {candidate_date_columns.length > 0 && (
        <div style={{ color: '#b36a00' }}>
          <strong>Non-ISO date-like headers (not imported):</strong>{' '}
          {candidate_date_columns.join(', ')}
        </div>
      )}

      {unrecognized_columns.length > 0 && (
        <div style={{ color: '#888' }}>
          <strong>Unrecognized columns:</strong> {unrecognized_columns.join(', ')}
        </div>
      )}

      {sample_rows.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: '3px' }}>Sample rows (up to 5)</div>
          <table className="dash-table">
            <thead>
              <tr>{Object.keys(sample_rows[0]).map((k) => <th key={k}>{k}</th>)}</tr>
            </thead>
            <tbody>
              {sample_rows.map((row, i) => (
                <tr key={i}>{Object.values(row).map((v, j) => <td key={j}>{String(v)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ImportSummary({ summary }) {
  const { tasks_created, completions_created, rows_skipped, potential_duplicates, warnings, errors } = summary;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
      <div style={{ fontWeight: 600, color: '#2a7a2a' }}>Import complete</div>
      <div>Tasks created: <strong>{tasks_created}</strong></div>
      <div>Completions created: <strong>{completions_created}</strong></div>
      <div>Rows skipped: <strong>{rows_skipped}</strong></div>
      {potential_duplicates.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, color: '#b36a00', marginBottom: '3px' }}>
            Potential duplicates skipped ({potential_duplicates.length})
          </div>
          <ul style={{ margin: 0, paddingLeft: '18px', color: '#b36a00' }}>
            {potential_duplicates.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, color: '#b36a00', marginBottom: '3px' }}>Warnings</div>
          <ul style={{ margin: 0, paddingLeft: '18px', color: '#b36a00' }}>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      {errors.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, color: '#b00000', marginBottom: '3px' }}>Errors</div>
          <ul style={{ margin: 0, paddingLeft: '18px', color: '#b00000' }}>
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function ImportPreview() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyResult, setApplyResult] = useState(null);
  const [applyError, setApplyError] = useState(null);

  const previewHasName = preview?.detected_metadata_columns?.name != null;

  async function handlePreview() {
    if (!file) return;
    setLoading(true);
    setError(null);
    setApplyResult(null);
    setApplyError(null);
    setConfirmed(false);
    try {
      setPreview(await previewImport(file));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleApply() {
    if (!file || !confirmed) return;
    setApplyLoading(true);
    setApplyError(null);
    setApplyResult(null);
    try {
      setApplyResult(await applyImport(file));
    } catch (e) {
      setApplyError(e.message);
    } finally {
      setApplyLoading(false);
    }
  }

  return (
    <section className="dash-section">
      <div className="dash-section-title">Import CSV</div>
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div
          style={{
            background: '#fff8e1', border: '1px solid #f0c040', borderRadius: '4px',
            padding: '8px 10px', fontSize: '12px', color: '#7a5800',
          }}
        >
          <strong>Before importing:</strong> export a backup via{' '}
          <em>Export Sheet CSV</em> or the backup JSON button so you can recover
          if something goes wrong. Import creates new tasks only — it never
          modifies or deletes existing data.
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="file"
            accept=".csv"
            style={{ fontSize: '12px' }}
            onChange={(e) => {
              setFile(e.target.files[0] || null);
              setPreview(null);
              setConfirmed(false);
              setApplyResult(null);
              setApplyError(null);
            }}
          />
          <button
            className="btn-archive-sheet"
            onClick={handlePreview}
            disabled={!file || loading}
          >
            {loading ? 'Parsing…' : 'Preview CSV'}
          </button>
        </div>
        {error && <div className="grid-status error" style={{ padding: '4px 0' }}>Error: {error}</div>}
        {preview && <PreviewResults preview={preview} />}
        {preview && previewHasName && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '12px', display: 'flex', gap: '6px', alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                style={{ marginTop: '2px' }}
              />
              I exported a backup and understand this will create new tasks.
            </label>
            <button
              className="btn-archive-sheet"
              onClick={handleApply}
              disabled={!confirmed || applyLoading}
              style={{ alignSelf: 'flex-start' }}
            >
              {applyLoading ? 'Importing…' : 'Apply Import'}
            </button>
          </div>
        )}
        {applyError && (
          <div className="grid-status error" style={{ padding: '4px 0' }}>Error: {applyError}</div>
        )}
        {applyResult && <ImportSummary summary={applyResult} />}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Archive list + detail
// ---------------------------------------------------------------------------

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
      <ImportPreview />
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
