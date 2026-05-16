import { useState, useEffect } from 'react';
import { fetchArchives, fetchArchive, deleteArchive, previewImport, applyImport } from '../api.js';

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

function isWeekendDate(isoDate) {
  const [y, m, day] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, day).getDay() % 6 === 0;
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
              <th key={d} className={`date-col-header${isWeekendDate(d) ? ' weekend' : ''}`}>{dateLabel(d)}</th>
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
                  <td key={d} className={`date-cell${isWeekendDate(d) ? ' weekend' : ''}${count ? ' has-count' : ''}`}>
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
// Import preview — behavior entirely preserved, only outer wrapper removed
// so Archive can wrap it in a ws-frame panel.
// ---------------------------------------------------------------------------

function PreviewResults({ preview }) {
  const {
    row_count, detected_metadata_columns, detected_date_columns,
    candidate_date_columns, unrecognized_columns, sample_rows, warnings,
  } = preview;

  const detected = Object.entries(detected_metadata_columns).filter(([, v]) => v !== null);

  return (
    <div className="import-result">
      <div><strong>Rows detected:</strong> {row_count}</div>

      {warnings.length > 0 && (
        <div>
          <div className="import-subhead import-warn-text">Warnings</div>
          <ul className="import-list import-warn-text">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {detected.length > 0 && (
        <div>
          <div className="import-subhead">Detected metadata columns</div>
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
        <div className="import-warn-text">
          <strong>Non-ISO date-like headers (not imported):</strong>{' '}
          {candidate_date_columns.join(', ')}
        </div>
      )}

      {unrecognized_columns.length > 0 && (
        <div className="import-muted-text">
          <strong>Unrecognized columns:</strong> {unrecognized_columns.join(', ')}
        </div>
      )}

      {sample_rows.length > 0 && (
        <div>
          <div className="import-subhead">Sample rows (up to 5)</div>
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
    <div className="import-result">
      <div className="import-success-text">Import complete</div>
      <div>Tasks created: <strong>{tasks_created}</strong></div>
      <div>Completions created: <strong>{completions_created}</strong></div>
      <div>Rows skipped: <strong>{rows_skipped}</strong></div>
      {potential_duplicates.length > 0 && (
        <div>
          <div className="import-subhead import-warn-text">
            Potential duplicates skipped ({potential_duplicates.length})
          </div>
          <ul className="import-list import-warn-text">
            {potential_duplicates.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div>
          <div className="import-subhead import-warn-text">Warnings</div>
          <ul className="import-list import-warn-text">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      {errors.length > 0 && (
        <div>
          <div className="import-subhead import-error-text">Errors</div>
          <ul className="import-list import-error-text">
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// ImportPreview renders only its inner content — Archive wraps it in ws-frame.
function ImportPreviewBody() {
  const [file, setFile]             = useState(null);
  const [preview, setPreview]       = useState(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);
  const [confirmed, setConfirmed]   = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyResult, setApplyResult]   = useState(null);
  const [applyError, setApplyError]     = useState(null);

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
    <div className="ws-frame-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Dry-run banner — design report .ban pattern */}
      <div className="ws-import-banner">
        <div>
          <span className="ws-import-banner-label">Before importing</span>
          Export a backup via <em>Export Backup JSON</em> so you can recover if something
          goes wrong. Import creates new tasks only — it never modifies or deletes existing data.
        </div>
      </div>

      <div className="import-file-row">
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
        <div className="import-apply-row">
          <label className="import-confirm-label">
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
  );
}

// ---------------------------------------------------------------------------
// Archive — main component
// ---------------------------------------------------------------------------

export default function Archive() {
  const [archives, setArchives]           = useState([]);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState(null);
  const [selected, setSelected]           = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // id of the archive pending delete confirmation, or null
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  function loadArchives() {
    return fetchArchives()
      .then(setArchives)
      .catch((e) => setError(e.message));
  }

  useEffect(() => {
    loadArchives().finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleView(id) {
    setDetailLoading(true);
    fetchArchive(id)
      .then(setSelected)
      .catch((e) => setError(e.message))
      .finally(() => setDetailLoading(false));
  }

  async function handleDelete(id) {
    try {
      await deleteArchive(id);
      // Clear detail pane if the deleted snapshot was open.
      if (selected?.id === id) setSelected(null);
      setDeleteConfirm(null);
      await loadArchives();
    } catch (e) {
      setError(e.message);
    }
  }

  if (loading) return <div className="grid-status">Loading…</div>;
  if (error)   return <div className="grid-status error">Error: {error}</div>;

  return (
    <div className="ws-archive">

      {/* ── Page chrome — design report .mh as page header ── */}
      <div className="ws-page-header">
        <span>Archive</span>
        <span className="ws-page-header-sub">monthly snapshots · read only</span>
      </div>

      {/* ── Zone 1: Import CSV ── */}
      <div className="ws-frame">
        <div className="ws-frame-header">
          <span>Import CSV</span>
          <span className="ws-frame-header-sub">create tasks from a backup export</span>
        </div>
        <ImportPreviewBody />
      </div>

      {/* ── Zone 2: Snapshot list — design report .snap pattern ── */}
      <div className="ws-frame">
        <div className="ws-frame-header">
          <span>Saved snapshots</span>
          <span className="ws-frame-header-sub">
            {archives.length} archived sheet{archives.length !== 1 ? 's' : ''}
          </span>
        </div>

        {archives.length === 0 ? (
          <div className="ws-empty">
            No archives yet. Use <strong>Archive Current Sheet</strong> in the Grid tab.
          </div>
        ) : (
          <ul className="ws-snap-list">
            {archives.map((a) => (
              <li
                key={a.id}
                className={`ws-snap-item${selected?.id === a.id ? ' ws-snap-item--active' : ''}`}
                onClick={() => handleView(a.id)}
              >
                <div>
                  <div className="ws-snap-name">{a.name}</div>
                  <span className="ws-snap-date">{a.start_date} → {a.end_date}</span>
                </div>
                <div className="ws-snap-right">
                  <span className="ws-snap-meta">
                    {a.archived_at.replace('T', ' ').slice(0, 10)}
                  </span>
                  <button
                    className="action-btn"
                    onClick={(e) => { e.stopPropagation(); handleView(a.id); }}
                  >
                    View →
                  </button>
                  {deleteConfirm === a.id ? (
                    <>
                      <span className="ws-snap-delete-confirm">Delete?</span>
                      <button
                        className="action-btn action-btn--danger"
                        onClick={(e) => { e.stopPropagation(); handleDelete(a.id); }}
                      >
                        Confirm
                      </button>
                      <button
                        className="action-btn"
                        onClick={(e) => { e.stopPropagation(); setDeleteConfirm(null); }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      className="action-btn"
                      onClick={(e) => { e.stopPropagation(); setDeleteConfirm(a.id); }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Zone 3: Snapshot detail ── */}
      {detailLoading && <div className="grid-status">Loading snapshot…</div>}

      {selected && !detailLoading && (
        <div className="ws-frame">
          <div className="ws-frame-header">
            <span>{selected.name}</span>
            <span className="ws-frame-header-sub">
              {selected.snapshot_data_json.start_date} → {selected.snapshot_data_json.end_date}
              {' · '}snapshot · read only
            </span>
          </div>
          <ArchiveMiniGrid data={selected.snapshot_data_json} />
        </div>
      )}

    </div>
  );
}
