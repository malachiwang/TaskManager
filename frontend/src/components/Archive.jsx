import { useState, useEffect } from 'react';
import { fetchArchives, fetchArchive, deleteArchive, renameArchive, previewImport, applyImport } from '../api.js';

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

function urgencyClass(u) {
  if (u >= 8) return 'urg-critical';
  if (u >= 6) return 'urg-high';
  if (u >= 3) return 'urg-noticeable';
  return 'urg-low';
}

// Local sparkline — no Dashboard import to avoid coupling.
function ArchiveSparkline({ trend }) {
  const maxCount = Math.max(...trend.map((d) => d.count), 1);
  const W = 300, H = 40, GAP = 1;
  const n = trend.length;
  const barW = n > 1 ? (W - GAP * (n - 1)) / n : W;
  return (
    <svg
      className="arch-sparkline"
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
            className="arch-sparkline-bar"
          />
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Archive analytics — computed entirely from snapshot_data_json, no live state
// ---------------------------------------------------------------------------

function ArchiveAnalytics({ snapshot }) {
  const tasks = snapshot.tasks ?? [];

  if (tasks.length === 0) {
    return (
      <div className="arch-analytics">
        <div className="arch-empty">No tasks in this archive.</div>
      </div>
    );
  }

  // ── Summary strip ─────────────────────────────────────────────────────
  const totalTasks       = tasks.length;
  const pausedCount      = tasks.filter((t) => t.is_paused).length;
  const scheduledCount   = tasks.filter((t) => t.is_scheduled ?? false).length;
  const endedCount       = tasks.filter((t) => t.is_ended ?? false).length;
  const totalCompletions = tasks.reduce(
    (s, t) => s + Object.values(t.completions ?? {}).reduce((a, b) => a + b, 0), 0,
  );
  const noteCount = tasks.reduce(
    (s, t) => s + Object.keys(t.cell_notes ?? {}).length, 0,
  );
  const rangeDays = snapshot.start_date && snapshot.end_date
    ? buildDates(snapshot.start_date, snapshot.end_date).length
    : null;

  // ── Top urgent ────────────────────────────────────────────────────────
  const topUrgent = tasks
    .filter((t) => !t.is_paused && !(t.is_scheduled ?? false) && !(t.is_ended ?? false))
    .sort((a, b) => (b.urgency ?? -Infinity) - (a.urgency ?? -Infinity))
    .slice(0, 5);

  // ── Section completion totals ─────────────────────────────────────────
  const secMap = {};
  for (const t of tasks) {
    const sec = t.section?.trim() || '(no section)';
    const count = Object.values(t.completions ?? {}).reduce((a, b) => a + b, 0);
    secMap[sec] = (secMap[sec] ?? 0) + count;
  }
  const allSecEntries = Object.entries(secMap).sort((a, b) => b[1] - a[1]);
  const nonZeroSecs   = allSecEntries.filter(([, c]) => c > 0);
  const displaySecs   = (nonZeroSecs.length > 0 ? nonZeroSecs : allSecEntries).slice(0, 8);
  const extraSecs     = nonZeroSecs.length > 8 ? nonZeroSecs.length - 8 : 0;
  const maxSecCount   = displaySecs[0]?.[1] ?? 1;

  // ── Range trend ───────────────────────────────────────────────────────
  const hasDates = !!(snapshot.start_date && snapshot.end_date);
  const trend = hasDates
    ? buildDates(snapshot.start_date, snapshot.end_date).map((d) => ({
        date: d,
        count: tasks.reduce((s, t) => s + (t.completions?.[d] ?? 0), 0),
      }))
    : null;

  return (
    <div className="arch-analytics">

      {/* ── Stat strip ── */}
      <div className="arch-stat-strip">
        {[
          { label: 'Tasks',       value: totalTasks },
          { label: 'Completions', value: totalCompletions },
          { label: 'Notes',       value: noteCount },
          { label: 'Paused',      value: pausedCount },
          { label: 'Scheduled',   value: scheduledCount },
          { label: 'Ended',       value: endedCount },
          { label: 'Range',       value: rangeDays !== null ? `${rangeDays}d` : '—' },
        ].map(({ label, value }) => (
          <div key={label} className="arch-stat-chip">
            <span className="arch-stat-label">{label}</span>
            <span className="arch-stat-value">{value}</span>
          </div>
        ))}
      </div>

      {/* ── Two-panel grid: top urgent + section totals ── */}
      <div className="arch-analytics-grid">

        {/* Top urgent */}
        <div className="arch-panel">
          <div className="arch-panel-title">Top archived urgency</div>
          {topUrgent.length === 0 ? (
            <div className="arch-empty">No active urgent tasks in this archive.</div>
          ) : (
            <table className="arch-top-table">
              <thead>
                <tr>
                  <th>Archived urg</th>
                  <th>Task</th>
                  <th>Section</th>
                  <th>Days</th>
                </tr>
              </thead>
              <tbody>
                {topUrgent.map((t) => (
                  <tr key={t.id}>
                    <td className={`arch-urg-num ${urgencyClass(t.urgency ?? 0)}`}>
                      {t.urgency != null ? t.urgency.toFixed(1) : '—'}
                    </td>
                    <td className="arch-task-name" title={t.name}>{t.name}</td>
                    <td className="arch-muted">{t.section || '—'}</td>
                    <td className="arch-num">{t.days_since ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Section completion totals */}
        <div className="arch-panel">
          <div className="arch-panel-title">Section completions</div>
          {totalCompletions === 0 ? (
            <div className="arch-empty">No completions in this archive range.</div>
          ) : (
            <>
              {displaySecs.map(([sec, count]) => (
                <div key={sec} className="arch-sec-row">
                  <span className="arch-sec-name" title={sec}>{sec}</span>
                  <div className="arch-sec-bar-wrap">
                    <div
                      className="arch-sec-bar"
                      style={{ width: `${maxSecCount > 0 ? (count / maxSecCount) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="arch-sec-count">{count}</span>
                </div>
              ))}
              {extraSecs > 0 && (
                <div className="arch-sec-more">
                  and {extraSecs} more section{extraSecs !== 1 ? 's' : ''}
                </div>
              )}
            </>
          )}
        </div>

      </div>

      {/* ── Range sparkline ── */}
      {trend && (
        <div className="arch-panel">
          <div className="arch-panel-title">Range activity</div>
          <div className="arch-sparkline-wrap">
            <ArchiveSparkline trend={trend} />
          </div>
          <div className="arch-sparkline-labels">
            <span>{snapshot.start_date}</span>
            <span>{snapshot.end_date}</span>
          </div>
          <div className="arch-sparkline-total">
            {totalCompletions} completion{totalCompletions !== 1 ? 's' : ''} across {trend.length} day{trend.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}

    </div>
  );
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
          {tasks.map((task) => {
            const isEnded = task.is_ended ?? false;
            const rowClass = ['task-row', task.is_paused ? 'paused' : '', isEnded ? 'ended' : '']
              .filter(Boolean).join(' ');
            return (
              <tr key={task.id} className={rowClass}>
                <td className="col-urg">{task.is_paused || isEnded ? '—' : task.urgency}</td>
                <td className="col-pri">{task.priority}</td>
                <td className="col-status">{task.status}</td>
                <td className="col-section">{task.section || ''}</td>
                <td className="col-cat">{task.category}</td>
                <td className="col-task" title={task.name}>{task.name}</td>
                <td className="col-freq">{task.interval_days}d</td>
                <td className="col-days">{task.is_paused || isEnded ? '—' : task.days_since}</td>
                {dates.map((d) => {
                  const count = task.completions?.[d] || 0;
                  const hasNote = !!(task.cell_notes?.[d]);
                  const isAfterEnd = !!(task.end_date && d > task.end_date);
                  const cellClass = [
                    'date-cell',
                    isWeekendDate(d) ? 'weekend' : '',
                    count && !isAfterEnd ? 'has-count' : '',
                    hasNote ? 'has-note' : '',
                    isAfterEnd ? 'after-end' : '',
                  ].filter(Boolean).join(' ');
                  return (
                    <td
                      key={d}
                      className={cellClass}
                      title={hasNote ? task.cell_notes[d] : (isAfterEnd ? 'After task end date' : undefined)}
                    >
                      {cellDisplay(count)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
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
  // rename state
  const [renamingId, setRenamingId]       = useState(null);
  const [renameVal, setRenameVal]         = useState('');

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

  function startRename(a, e) {
    e.stopPropagation();
    setRenamingId(a.id);
    setRenameVal(a.name);
    setDeleteConfirm(null);
  }

  async function commitRename(id) {
    const trimmed = renameVal.trim();
    if (!trimmed) { setRenamingId(null); return; }
    try {
      await renameArchive(id, trimmed);
      setRenamingId(null);
      if (selected?.id === id) setSelected((prev) => ({ ...prev, name: trimmed }));
      await loadArchives();
    } catch (e) {
      setError(e.message);
    }
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameVal('');
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
                onClick={() => renamingId === a.id ? null : handleView(a.id)}
              >
                <div>
                  <div className="ws-snap-name">{a.name}</div>
                  <span className="ws-snap-date">{a.start_date} → {a.end_date}</span>
                </div>
                <div className="ws-snap-right">
                  <span className="ws-snap-meta">
                    {a.archived_at.replace('T', ' ').slice(0, 10)}
                  </span>
                  <div className="ws-snap-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="ws-snap-btn" onClick={() => handleView(a.id)}>View →</button>
                    <button className="ws-snap-btn" onClick={(e) => startRename(a, e)}>Rename</button>
                    <button
                      className="ws-snap-btn ws-snap-btn--delete"
                      onClick={() => setDeleteConfirm(deleteConfirm === a.id ? null : a.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {renamingId === a.id && (
                  <div className="ws-snap-rename-row" onClick={(e) => e.stopPropagation()}>
                    <input
                      className="ws-snap-rename-input"
                      value={renameVal}
                      autoFocus
                      onChange={(e) => setRenameVal(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(a.id);
                        if (e.key === 'Escape') cancelRename();
                      }}
                    />
                    <div className="ws-snap-confirm-strip">
                      <button className="ws-snap-btn" onClick={() => commitRename(a.id)}>Save</button>
                      <button className="ws-snap-btn" onClick={cancelRename}>Cancel</button>
                    </div>
                  </div>
                )}
                {deleteConfirm === a.id && (
                  <div className="ws-snap-confirm-strip" onClick={(e) => e.stopPropagation()}>
                    <span className="ws-snap-delete-confirm">Delete this snapshot?</span>
                    <button
                      className="ws-snap-btn ws-snap-btn--delete"
                      onClick={() => handleDelete(a.id)}
                    >
                      Confirm
                    </button>
                    <button className="ws-snap-btn" onClick={() => setDeleteConfirm(null)}>Cancel</button>
                  </div>
                )}
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
          <ArchiveAnalytics snapshot={selected.snapshot_data_json} />
          <ArchiveMiniGrid data={selected.snapshot_data_json} />
        </div>
      )}

    </div>
  );
}
