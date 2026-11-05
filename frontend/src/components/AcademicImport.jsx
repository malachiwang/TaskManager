import { useState } from 'react';
import {
  academicImport, fetchAcademicCandidates, updateAcademicCandidate,
  approveAcademicCandidate, rejectAcademicCandidate, bulkAcademicCandidates,
} from '../api.js';

// Academic importer review UI (V5.3 Part VIII §26/§27).
//
// Paste → candidates → review. Candidates stay isolated until the user
// approves them; every row shows the exact source line it came from, and
// suspected duplicates / changed dates are flagged, never auto-resolved.
// Approval semantics live entirely on the server (§29) — this component
// only calls approve/reject/edit.

const KIND_LABELS = {
  assignment: 'Assignment', homework: 'Homework', quiz: 'Quiz', exam: 'Exam',
  project: 'Project', reading: 'Reading', presentation: 'Presentation',
  deadline: 'Deadline', milestone: 'Milestone', office_hours: 'Office hours',
  class: 'Class',
};
const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function timeLabel(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hh}:${String(m).padStart(2, '0')} ${ampm}` : `${hh} ${ampm}`;
}

export default function AcademicImport({ contexts, onClose, onChanged }) {
  const [text, setText] = useState('');
  const [contextName, setContextName] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [batchId, setBatchId] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [selected, setSelected] = useState([]);
  const [until, setUntil] = useState('');
  const [editRow, setEditRow] = useState(null); // { id, title, date }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rowErrors, setRowErrors] = useState({});

  async function refresh(id = batchId) {
    const rows = await fetchAcademicCandidates({ batch_id: id });
    setCandidates(rows);
    setSelected((sel) => sel.filter((x) =>
      rows.some((r) => r.id === x && r.status === 'pending')));
  }

  async function runImport() {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError('');
    try {
      const out = await academicImport({
        text,
        context_name: contextName.trim() || undefined,
        source_name: sourceName.trim() || undefined,
      });
      setBatchId(out.batch_id);
      setCandidates(out.candidates);
      setSelected(out.candidates.map((c) => c.id));
    } catch (err) {
      setError(err?.message || 'Import failed.');
    }
    setBusy(false);
  }

  async function approve(cand, body = {}) {
    setRowErrors((e) => ({ ...e, [cand.id]: null }));
    try {
      const isRecurring = cand.weekdays.length > 0 && cand.start_minutes != null;
      await approveAcademicCandidate(cand.id, {
        ...(isRecurring && until ? { until } : {}),
        ...body,
      });
      await refresh();
      onChanged();
    } catch (err) {
      setRowErrors((e) => ({ ...e, [cand.id]: err?.message || 'Approve failed.' }));
    }
  }

  async function reject(cand) {
    try {
      await rejectAcademicCandidate(cand.id);
      await refresh();
    } catch (err) {
      setRowErrors((e) => ({ ...e, [cand.id]: err?.message || 'Reject failed.' }));
    }
  }

  async function bulk(action) {
    if (busy || selected.length === 0) return;
    setBusy(true);
    try {
      const out = await bulkAcademicCandidates({
        ids: selected, action, ...(until ? { until } : {}),
      });
      const errs = {};
      for (const r of out.results) if (!r.ok) errs[r.id] = r.error;
      setRowErrors(errs);
      await refresh();
      onChanged();
    } catch (err) {
      setError(err?.message || 'Bulk action failed.');
    }
    setBusy(false);
  }

  async function saveEdit() {
    if (!editRow) return;
    try {
      await updateAcademicCandidate(editRow.id, {
        title: editRow.title, date: editRow.date ?? '',
      });
      setEditRow(null);
      await refresh();
    } catch (err) {
      setRowErrors((e) => ({ ...e, [editRow.id]: err?.message || 'Edit failed.' }));
    }
  }

  const pending = candidates.filter((c) => c.status === 'pending');

  return (
    <div className="task-modal-overlay" onClick={onClose}>
      <div className="task-modal-shell acad-shell" onClick={(e) => e.stopPropagation()}>
        <div className="task-modal-header">
          <div className="task-modal-header-left">
            <div className="task-modal-kicker">Academic Import · candidates only until approved</div>
            <div className="task-modal-title">
              {batchId == null ? 'Paste a syllabus or schedule' : 'Review extracted candidates'}
            </div>
          </div>
          <button className="task-modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="task-modal-body">
          {batchId == null ? (
            <>
              <div className="task-modal-grid">
                <div className="task-modal-field">
                  <label className="task-modal-label" htmlFor="acad-ctx">Course / context</label>
                  <input
                    id="acad-ctx"
                    className="task-modal-input"
                    list="acad-ctx-options"
                    placeholder="e.g. ISYE 2027"
                    value={contextName}
                    onChange={(e) => setContextName(e.target.value)}
                  />
                  <datalist id="acad-ctx-options">
                    {contexts.map((c) => <option key={c.id} value={c.name} />)}
                  </datalist>
                </div>
                <div className="task-modal-field">
                  <label className="task-modal-label" htmlFor="acad-src">Source name (optional)</label>
                  <input
                    id="acad-src"
                    className="task-modal-input"
                    placeholder="e.g. Fall 2026 syllabus"
                    value={sourceName}
                    onChange={(e) => setSourceName(e.target.value)}
                  />
                </div>
              </div>
              <div className="task-modal-field task-modal-field--full">
                <label className="task-modal-label" htmlFor="acad-text">Syllabus / schedule text</label>
                <textarea
                  id="acad-text"
                  className="task-modal-input acad-textarea"
                  rows={12}
                  placeholder={'Homework 1 due September 3\nMidterm Exam: September 24, 11:00am-12:15pm\nLecture: TR 11:00-12:15pm'}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </div>
              {error && <div className="task-modal-save-error" role="alert">{error}</div>}
            </>
          ) : (
            <>
              {candidates.length === 0 && (
                <div className="task-modal-field-hint">
                  No schedulable lines were recognized.
                </div>
              )}
              {pending.length > 0 && (
                <div className="acad-bulkbar">
                  <label className="cal-popover-checkline">
                    <input
                      type="checkbox"
                      checked={selected.length === pending.length && pending.length > 0}
                      onChange={(e) => setSelected(e.target.checked ? pending.map((c) => c.id) : [])}
                    />
                    {selected.length}/{pending.length} selected
                  </label>
                  <span className="acad-until">
                    <span>Recurring until</span>
                    <input
                      type="date"
                      className="task-modal-input cal-dup-date"
                      value={until}
                      onChange={(e) => setUntil(e.target.value)}
                    />
                  </span>
                  <button type="button" className="task-modal-save" disabled={busy || selected.length === 0}
                    onClick={() => bulk('approve')}>Approve selected</button>
                  <button type="button" className="task-modal-cancel" disabled={busy || selected.length === 0}
                    onClick={() => bulk('reject')}>Reject selected</button>
                </div>
              )}
              <div className="acad-list">
                {candidates.map((c) => (
                  <div key={c.id} className={`acad-row acad-row--${c.status}`}>
                    <div className="acad-row-main">
                      {c.status === 'pending' ? (
                        <input
                          type="checkbox"
                          checked={selected.includes(c.id)}
                          onChange={() => setSelected((sel) => (sel.includes(c.id)
                            ? sel.filter((x) => x !== c.id) : [...sel, c.id]))}
                        />
                      ) : (
                        <span className="acad-status-mark">
                          {c.status === 'approved' ? '✓' : '✕'}
                        </span>
                      )}
                      <span className="acad-kind">{KIND_LABELS[c.kind] ?? c.kind}</span>
                      {editRow?.id === c.id ? (
                        <>
                          <input className="task-modal-input acad-edit-title" value={editRow.title}
                            onChange={(e) => setEditRow((r) => ({ ...r, title: e.target.value }))} />
                          <input type="date" className="task-modal-input cal-dup-date" value={editRow.date ?? ''}
                            onChange={(e) => setEditRow((r) => ({ ...r, date: e.target.value }))} />
                          <button type="button" className="task-modal-save" onClick={saveEdit}>Save</button>
                          <button type="button" className="task-modal-cancel" onClick={() => setEditRow(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <span className="acad-title" title={`Source: ${c.source_text}`}>{c.title}</span>
                          <span className="acad-when">
                            {c.date ?? (c.weekdays.length
                              ? c.weekdays.map((w) => WEEKDAY_SHORT[w]).join('/')
                              : '—')}
                            {c.start_minutes != null
                              ? ` · ${timeLabel(c.start_minutes)}${c.end_minutes != null ? `–${timeLabel(c.end_minutes)}` : ''}`
                              : ''}
                          </span>
                        </>
                      )}
                    </div>
                    {c.duplicate_of && c.status === 'pending' && (
                      <div className="acad-warn">
                        {c.date_conflict
                          ? `Date changed: ${c.date_conflict} → ${c.date}`
                          : 'Possible duplicate of an existing record'}
                        {c.date_conflict && c.duplicate_of.startsWith('task:') && (
                          <button type="button" className="cal-flag-btn"
                            onClick={() => approve(c, { mode: 'update_existing' })}>
                            Accept change
                          </button>
                        )}
                      </div>
                    )}
                    {c.status === 'approved' && c.created_record && (
                      <div className="acad-created">Created: {c.created_record}</div>
                    )}
                    {rowErrors[c.id] && (
                      <div className="acad-warn" role="alert">{rowErrors[c.id]}</div>
                    )}
                    {c.status === 'pending' && editRow?.id !== c.id && (
                      <div className="acad-row-actions">
                        <button type="button" className="cal-flag-btn"
                          onClick={() => setEditRow({ id: c.id, title: c.title, date: c.date })}>
                          Edit
                        </button>
                        <button type="button" className="task-modal-save" onClick={() => approve(c)}>Approve</button>
                        <button type="button" className="task-modal-cancel" onClick={() => reject(c)}>Reject</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="task-modal-footer">
          <div />
          <div className="task-modal-actions">
            {batchId == null ? (
              <>
                <button type="button" className="task-modal-cancel" onClick={onClose}>Cancel</button>
                <button type="button" className="task-modal-save" disabled={busy || !text.trim()}
                  onClick={runImport}>
                  {busy ? 'Parsing…' : 'Extract candidates'}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="task-modal-cancel"
                  onClick={() => { setBatchId(null); setCandidates([]); setSelected([]); }}>
                  ← New import
                </button>
                <button type="button" className="task-modal-save" onClick={onClose}>Done</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
