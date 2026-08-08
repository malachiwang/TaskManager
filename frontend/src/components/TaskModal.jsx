import { useEffect, useRef, useState } from 'react';
import { urgencyLabel, urgencyReason } from '../urgency.js';
import { extractLinks, normalizeSafeUrl, spliceMarkdownLink } from '../linkUtils.js';
import { handleSafeLinkClick } from '../openExternalLink.js';
import { fetchHiatusPeriodsForTask, updateHiatusPeriod, deleteHiatusPeriod } from '../api.js';
import LinkifiedText from './LinkifiedText.jsx';
import SectionCombobox from './SectionCombobox.jsx';
import TaskDatePicker, { getLocalTodayIso } from './TaskDatePicker.jsx';

// Modal-level status choices (P11.1). 'active' and 'hiatus' are the stored
// status values; 'finished' is a UI alias for the canonical end_date pathway
// (is_ended = end_date <= today) — the backend never stores a 'finished' status.
const STATUS_OPTIONS = ['active', 'hiatus', 'finished'];
const STATUS_LABELS = { active: 'Active', hiatus: 'Hiatus', finished: 'Finished' };

// One-line consequence hint under the status control. Transition-specific
// copy (opening/closing a hiatus, un-finishing) wins over the steady state.
function statusHint(choice, task) {
  if (choice === 'active') {
    if (task?.status === 'hiatus') {
      return 'Resuming closes the hiatus as of yesterday — its dates stay blank permanently. Today onward returns to normal checkboxes.';
    }
    if (task?.is_ended) {
      return 'Clears the end date — the task returns to normal tracking.';
    }
    return 'Tracks normally and counts toward pressure.';
  }
  if (choice === 'hiatus') {
    if (task?.status !== 'hiatus') {
      return 'Hiatus starts today. Dates during the hiatus render as blank cells; completion history underneath is preserved.';
    }
    return 'Paused — hiatus-period cells render blank; completion history is preserved.';
  }
  if (task?.is_ended) {
    return 'Finished — excluded from tracking and pressure. Past completions are preserved.';
  }
  return 'Sets the End date below — dates after it are disabled and the task leaves active tracking. Past completions are preserved.';
}

function loadTaskDefaults() {
  try {
    const saved = localStorage.getItem('taskos-settings');
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

function priorityFillColor(p) {
  if (p >= 8) return 'var(--urg-crit)';   /* 8–10: red */
  if (p >= 5) return 'var(--urg-mid)';    /* 5–7:  amber/orange */
  if (p >= 2) return 'var(--good)';       /* 2–4:  green */
  return 'var(--accent)';                 /* 1:    blue */
}

function stopLinkUiEvent(e) {
  e.preventDefault();
  e.stopPropagation();
}

function stopLinkUiPropagation(e) {
  e.stopPropagation();
}

export default function TaskModal({ task, sectionSuggestions = [], onSave, onDelete, onClose, onHiatusChanged }) {
  const isEdit = task != null;

  const [confirmDelete, setConfirmDelete] = useState(false);

  // Hiatus history (P11.0) — persisted intervals for this task. Dates inside
  // any interval render as blank cells in the grid, even after resume.
  // Deleting an interval here is the correction path for a mistaken hiatus.
  const [hiatusPeriods, setHiatusPeriods] = useState([]);
  const [confirmPeriodDelete, setConfirmPeriodDelete] = useState(null);

  useEffect(() => {
    if (!isEdit) return;
    fetchHiatusPeriodsForTask(task.id)
      .then(setHiatusPeriods)
      .catch(() => setHiatusPeriods([]));
  }, [isEdit, task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleDeletePeriod(periodId) {
    setConfirmPeriodDelete(null);
    try {
      await deleteHiatusPeriod(periodId);
      setHiatusPeriods((prev) => prev.filter((p) => p.id !== periodId));
      onHiatusChanged?.();
    } catch (e) {
      console.error('delete hiatus period failed:', e);
    }
  }

  // Inline interval editor (P11.2) — one row at a time. wasOpen remembers
  // whether the interval was open when editing began: only then may End stay
  // blank (sent as '' = keep open); closed intervals require an end date.
  const [editingPeriod, setEditingPeriod] = useState(null); // { id, start, end, wasOpen, error, saving }

  function startEditPeriod(p) {
    setConfirmPeriodDelete(null);
    setEditingPeriod({
      id: p.id,
      start: p.start_date,
      end: p.end_date ?? '',
      wasOpen: p.end_date === null,
      error: '',
      saving: false,
    });
  }

  function cancelEditPeriod() {
    setEditingPeriod(null);
  }

  async function saveEditPeriod() {
    const { id, start, end, wasOpen, saving } = editingPeriod;
    if (saving) return;
    // Fast client-side checks; the backend re-validates all of these plus overlap.
    let error = '';
    if (!start) error = 'Start date is required.';
    else if (!end && !wasOpen) error = 'End date is required for a closed interval.';
    else if (end && end < start) error = 'End date must not be before the start date.';
    if (error) {
      setEditingPeriod((e) => (e ? { ...e, error } : e));
      return;
    }
    setEditingPeriod((e) => (e ? { ...e, saving: true, error: '' } : e));
    try {
      const updated = await updateHiatusPeriod(id, { start_date: start, end_date: end });
      setHiatusPeriods((prev) =>
        prev.map((p) => (p.id === id ? updated : p))
            .sort((a, b) => (a.start_date < b.start_date ? -1 : 1)),
      );
      setEditingPeriod(null);
      onHiatusChanged?.();
    } catch (err) {
      setEditingPeriod((e) =>
        (e ? { ...e, saving: false, error: err?.message || 'Save failed. Please try again.' } : e),
      );
    }
  }

  // Escape cancels the interval editor without closing the whole modal. The
  // date picker's own popover Escape never reaches here (it stops propagation).
  // Enter in a date input commits the interval edit — without this it would
  // implicitly submit the surrounding task form and discard the edit. Buttons
  // keep native Enter activation (target check), and the picker's calendar
  // grid handles its own Enter on a div, which this ignores.
  function handlePeriodEditorKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEditPeriod();
    }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      e.stopPropagation();
      saveEditPeriod();
    }
  }
  const nameRef = useRef(null);
  const subtaskRef = useRef(null);
  const notesRef = useRef(null);
  const linkUrlRef = useRef(null);

  const [form, setForm] = useState(() => {
    const d = isEdit ? {} : loadTaskDefaults();
    return {
      name:                      task?.name                      ?? '',
      section:                   task?.section                   ?? d.defaultSection      ?? 'General',
      category:                  task?.category                  ?? '',
      status:                    task?.status                    ?? 'active',
      subtask:                   task?.subtask                   ?? '',
      priority:                  task?.priority                  ?? d.defaultPriority     ?? 5,
      interval_days:             task?.interval_days             ?? d.defaultIntervalDays ?? 7,
      notes:                     task?.notes                     ?? '',
      manual_last_done_override: task?.manual_last_done_override ?? '',
      active_from:               task?.active_from               ?? (isEdit ? '' : getLocalTodayIso()),
      end_date:                  task?.end_date                  ?? '',
    };
  });

  // Three-way status choice (P11.1). Finished wins over the stored status when
  // the task is already ended, so the control reflects what the grid shows.
  const [statusChoice, setStatusChoice] = useState(() =>
    task?.is_ended ? 'finished' : (task?.status ?? 'active'),
  );

  function chooseStatus(next) {
    setStatusChoice(next);
    const today = getLocalTodayIso();
    setForm((prev) => {
      if (next === 'finished') {
        // Prefill the End date so the field shows what saving will do.
        // An already-past end date is kept; form.status is left untouched so
        // finishing never opens/closes hiatus intervals as a side effect.
        const ended = prev.end_date && prev.end_date <= today;
        return { ...prev, end_date: ended ? prev.end_date : today };
      }
      // Leaving Finished clears a past end date (un-finishes); a future
      // end date is unrelated to Finished and stays.
      const ended = prev.end_date && prev.end_date <= today;
      return { ...prev, status: next, end_date: ended ? '' : prev.end_date };
    });
  }
  const [linkPanelOpen, setLinkPanelOpen] = useState(false);
  const [linkText, setLinkText] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkSelection, setLinkSelection] = useState({ key: 'notes', value: '', start: 0, end: 0 });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  function set(key, val) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  // Await the save so a failure is shown to the user instead of the button
  // appearing to "do nothing". On success onSave closes the modal (unmounting
  // this component); on failure the modal stays open with the error and edits.
  async function handleSubmit(e) {
    e.preventDefault();
    if (saving) return;
    setSaveError('');
    setSaving(true);
    try {
      const payload = { ...form };
      if (statusChoice === 'finished') {
        // Finished must actually finish even if the End date was hand-cleared
        // after selecting it. Status is sent unchanged from the stored value so
        // finishing never triggers a hiatus open/close transition.
        const today = getLocalTodayIso();
        if (!payload.end_date || payload.end_date > today) payload.end_date = today;
        payload.status = task?.status ?? 'active';
      }
      await onSave(payload);
    } catch (err) {
      setSaving(false);
      setSaveError(err?.message || 'Save failed. Please try again.');
    }
  }

  function fieldRef(key) {
    if (key === 'name') return nameRef;
    if (key === 'subtask') return subtaskRef;
    return notesRef;
  }

  function getFieldSelection(key) {
    const ref = fieldRef(key);
    const el = ref.current;
    const value = form[key] ?? '';
    const len = value.length;
    if (!el || typeof el.selectionStart !== 'number' || typeof el.selectionEnd !== 'number') {
      return { start: len, end: len, selectedText: '' };
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    return { value, start, end, selectedText: value.slice(start, end) };
  }

  function openInsertLink(key = 'notes', e = null) {
    if (e) stopLinkUiEvent(e);
    const selection = getFieldSelection(key);
    setLinkSelection({ key, value: selection.value, start: selection.start, end: selection.end });
    setLinkText(selection.selectedText);
    setLinkUrl('');
    setLinkPanelOpen(true);
  }

  function closeInsertLink() {
    setLinkPanelOpen(false);
    requestAnimationFrame(() => fieldRef(linkSelection.key).current?.focus());
  }

  function insertMarkdownLink() {
    const result = spliceMarkdownLink(
      linkSelection.value,
      linkSelection.start,
      linkSelection.end,
      linkText,
      linkUrl,
    );
    if (!result) return;

    setForm((prev) => {
      const key = linkSelection.key;
      return {
        ...prev,
        [key]: result.text,
      };
    });
    setLinkPanelOpen(false);
    requestAnimationFrame(() => {
      const ref = fieldRef(linkSelection.key).current;
      ref?.focus();
      ref?.setSelectionRange(result.cursor, result.cursor);
    });
  }

  function handleTextFieldKeyDown(key, e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openInsertLink(key, e);
    }
  }

  useEffect(() => {
    if (linkPanelOpen) linkUrlRef.current?.focus();
  }, [linkPanelOpen]);

  // Shared keys for both Insert Link inputs. Escape closes the panel only —
  // stopPropagation keeps the grid's global Escape from closing the modal.
  // Enter inserts (when the URL is valid) instead of submitting the form.
  function handleLinkPanelKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (linkUrlSafe) insertMarkdownLink();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeInsertLink();
    }
  }

  // (p-1)/9 maps [1..10] → [0%..100%], matching the slider thumb's actual travel range.
  const p = Math.min(10, Math.max(1, form.priority));
  const priorityPct = `${((p - 1) / 9) * 100}%`;
  const noteLinks = extractLinks(form.notes);
  const linkUrlSafe = normalizeSafeUrl(linkUrl);

  function renderInsertLinkPanel(key) {
    if (!linkPanelOpen || linkSelection.key !== key) return null;
    return (
      <div
        className="insert-link-panel"
        role="dialog"
        aria-label="Insert link"
        onMouseDown={stopLinkUiPropagation}
        onClick={stopLinkUiPropagation}
      >
        <label className="insert-link-field">
          <span>Text</span>
          <input
            className="task-modal-input"
            value={linkText}
            onChange={(e) => setLinkText(e.target.value)}
            onMouseDown={stopLinkUiPropagation}
            onClick={stopLinkUiPropagation}
            onKeyDown={handleLinkPanelKeyDown}
          />
        </label>
        <label className="insert-link-field">
          <span>URL</span>
          <input
            ref={linkUrlRef}
            className="task-modal-input"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onMouseDown={stopLinkUiPropagation}
            onClick={stopLinkUiPropagation}
            onKeyDown={handleLinkPanelKeyDown}
            placeholder="https://example.com"
          />
        </label>
        {linkUrl && !linkUrlSafe && (
          <div className="insert-link-error">Use http, https, mailto, or www links.</div>
        )}
        <div className="insert-link-actions">
          <button type="button" className="task-modal-cancel" onMouseDown={stopLinkUiEvent} onClick={(e) => { stopLinkUiEvent(e); closeInsertLink(); }}>
            Cancel
          </button>
          <button
            type="button"
            className="task-modal-save"
            onMouseDown={stopLinkUiEvent}
            onClick={(e) => { stopLinkUiEvent(e); insertMarkdownLink(); }}
            disabled={!linkUrlSafe}
          >
            Insert
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="task-modal-overlay" onClick={onClose}>
      <div className="task-modal-shell" onClick={(e) => e.stopPropagation()}>

        {/* ── Dark ink header ── */}
        <div className="task-modal-header">
          <div className="task-modal-header-left">
            <div className="task-modal-kicker">
              {isEdit ? 'Task Details' : 'Add Task'}
            </div>
            <div className="task-modal-title">
              {isEdit ? (task.name || 'Untitled') : 'New task record'}
            </div>
            <div className="task-modal-subtitle">
              {isEdit ? 'scheduling · status · priority · notes' : 'local task record · SQLite'}
            </div>
            {isEdit && (() => {
              // Read-only urgency decomposition (P4.0B) — explains the current
              // pressure. Inactive tasks (Hiatus/Finished/scheduled) show '—'.
              const inactive = task.is_paused === 1 || task.is_ended || task.is_scheduled;
              return (
                <div className="task-modal-urgency">
                  <span className="task-modal-urgency-val">{inactive ? '—' : task.urgency}</span>
                  {!inactive && <span className="task-modal-urgency-band">{urgencyLabel(task.urgency)}</span>}
                  <span className="task-modal-urgency-reason">{urgencyReason(task)}</span>
                </div>
              );
            })()}
          </div>
          <button className="task-modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* ── Paper form body ── */}
        <form className="task-modal-body" onSubmit={handleSubmit}>

          {/* Identity */}
          <div className="task-modal-section">
            <div className="task-modal-section-title">Identity</div>
            <div className="task-modal-field task-modal-field--full">
              <div className="notes-toolbar">
                <label className="task-modal-label" htmlFor="tm-name">Name</label>
                <button
                  type="button"
                  className="insert-link-btn"
                  onMouseDown={(e) => openInsertLink('name', e)}
                  onClick={stopLinkUiEvent}
                >
                  Insert link
                </button>
              </div>
              <input
                ref={nameRef}
                id="tm-name"
                className="task-modal-input"
                required
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                onKeyDown={(e) => handleTextFieldKeyDown('name', e)}
              />
              {renderInsertLinkPanel('name')}
            </div>
            <div className="task-modal-field task-modal-field--full">
              <div className="notes-toolbar">
                <label className="task-modal-label" htmlFor="tm-subtask">Subtask</label>
                <button
                  type="button"
                  className="insert-link-btn"
                  onMouseDown={(e) => openInsertLink('subtask', e)}
                  onClick={stopLinkUiEvent}
                >
                  Insert link
                </button>
              </div>
              <input
                ref={subtaskRef}
                id="tm-subtask"
                className="task-modal-input"
                value={form.subtask}
                onChange={(e) => set('subtask', e.target.value)}
                onKeyDown={(e) => handleTextFieldKeyDown('subtask', e)}
              />
              {renderInsertLinkPanel('subtask')}
            </div>
          </div>

          {/* Classification */}
          <div className="task-modal-section">
            <div className="task-modal-section-title">Classification</div>

            {/* Section + Category */}
            <div className="task-modal-grid">
              <div className="task-modal-field">
                <label className="task-modal-label" htmlFor="tm-section">Section</label>
                <SectionCombobox
                  id="tm-section"
                  value={form.section}
                  onChange={(v) => set('section', v)}
                  suggestions={sectionSuggestions}
                  placeholder="General"
                />
              </div>
              <div className="task-modal-field">
                <label className="task-modal-label" htmlFor="tm-category">Category</label>
                <input
                  id="tm-category"
                  className="task-modal-input"
                  value={form.category}
                  onChange={(e) => set('category', e.target.value)}
                />
              </div>
            </div>

            {/* Status — segmented buttons (Active / Hiatus / Finished) */}
            <div className="task-modal-field task-modal-field--full">
              <label className="task-modal-label">Status</label>
              <div className="task-modal-seg" role="group" aria-label="Status">
                {STATUS_OPTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`task-modal-seg-btn${statusChoice === s ? ' task-modal-seg-btn--active' : ''}`}
                    aria-pressed={statusChoice === s}
                    onClick={() => chooseStatus(s)}
                  >
                    {STATUS_LABELS[s] ?? s}
                  </button>
                ))}
              </div>
              <div className="task-modal-field-hint">{statusHint(statusChoice, task)}</div>
            </div>

            {/* Hiatus history (P11.0/P11.2) — per-interval Edit + guarded delete */}
            {isEdit && hiatusPeriods.length > 0 && (
              <div className="task-modal-field task-modal-field--full">
                <label className="task-modal-label">Hiatus history</label>
                <div className="task-modal-hiatus-list">
                  {hiatusPeriods.map((p) => (
                    editingPeriod?.id === p.id ? (
                      <div key={p.id} className="task-modal-hiatus-editor"
                        onKeyDown={handlePeriodEditorKeyDown}>
                        <div className="task-modal-hiatus-editor-fields">
                          <label className="task-modal-hiatus-editor-field">
                            <span>Start</span>
                            <TaskDatePicker
                              value={editingPeriod.start}
                              onChange={(v) => setEditingPeriod((e) => (e ? { ...e, start: v, error: '' } : e))}
                              clearable={false}
                              ariaLabel="Hiatus start date"
                            />
                          </label>
                          <label className="task-modal-hiatus-editor-field">
                            <span>End</span>
                            <TaskDatePicker
                              value={editingPeriod.end}
                              onChange={(v) => setEditingPeriod((e) => (e ? { ...e, end: v, error: '' } : e))}
                              clearable={editingPeriod.wasOpen}
                              ariaLabel="Hiatus end date"
                            />
                          </label>
                        </div>
                        {editingPeriod.wasOpen && (
                          <div className="task-modal-field-hint">
                            Leave End blank to keep this hiatus open.
                          </div>
                        )}
                        {editingPeriod.error && (
                          <div className="task-modal-hiatus-editor-error" role="alert">
                            {editingPeriod.error}
                          </div>
                        )}
                        <div className="task-modal-hiatus-editor-actions">
                          <button type="button" className="task-modal-cancel"
                            onClick={cancelEditPeriod} disabled={editingPeriod.saving}>Cancel</button>
                          <button type="button" className="task-modal-save"
                            onClick={saveEditPeriod} disabled={editingPeriod.saving}>
                            {editingPeriod.saving ? 'Saving…' : 'Save'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div key={p.id} className="task-modal-hiatus-row">
                        <span className="task-modal-hiatus-range">
                          {p.end_date === null
                            ? `On hiatus since ${p.start_date}`
                            : `${p.start_date} → ${p.end_date}`}
                        </span>
                        {confirmPeriodDelete === p.id ? (
                          <span className="task-modal-hiatus-confirm">
                            Un-blank these dates?
                            <button type="button" className="task-modal-confirm-delete"
                              onClick={() => handleDeletePeriod(p.id)}>Remove</button>
                            <button type="button" className="task-modal-cancel"
                              onClick={() => setConfirmPeriodDelete(null)}>Cancel</button>
                          </span>
                        ) : (
                          <span className="task-modal-hiatus-actions">
                            <button type="button" className="task-modal-hiatus-edit-btn"
                              title="Edit this interval's dates — blanking follows the new range; completions are untouched"
                              onClick={() => startEditPeriod(p)}>Edit</button>
                            <button type="button" className="task-modal-hiatus-delete"
                              title="Remove this hiatus interval — its dates return to normal cells; nothing else changes"
                              onClick={() => setConfirmPeriodDelete(p.id)}>Remove</button>
                          </span>
                        )}
                      </div>
                    )
                  ))}
                </div>
                <div className="task-modal-field-hint">
                  Dates inside these intervals render as blank hiatus cells.
                  Editing an interval changes which dates are blank; removing one
                  un-blanks its dates. Completions and text overrides are preserved.
                </div>
              </div>
            )}

            {/* Priority — number + visual meter */}
            <div className="task-modal-field task-modal-field--full">
              <label className="task-modal-label" htmlFor="tm-priority">
                Priority <span className="task-modal-priority-val">{form.priority}<span className="task-modal-priority-max">/10</span></span>
              </label>
              <div className="task-modal-priority-wrap">
                <div className="task-modal-priority-meter">
                  <div
                    className="task-modal-priority-fill"
                    style={{ width: priorityPct, background: priorityFillColor(form.priority) }}
                  />
                </div>
                <input
                  id="tm-priority"
                  className="task-modal-input task-modal-input--priority"
                  type="range"
                  min="1"
                  max="10"
                  value={form.priority}
                  onChange={(e) => set('priority', Number(e.target.value))}
                />
              </div>
            </div>
          </div>

          {/* Scheduling */}
          <div className="task-modal-section">
            <div className="task-modal-section-title">Scheduling</div>
            <div className="task-modal-grid">
              <div className="task-modal-field">
                <label className="task-modal-label" htmlFor="tm-interval">Interval (days)</label>
                <input
                  id="tm-interval"
                  className="task-modal-input"
                  type="number"
                  min="1"
                  value={form.interval_days}
                  onChange={(e) => set('interval_days', Number(e.target.value))}
                />
              </div>
              <div className="task-modal-field">
                <label className="task-modal-label" htmlFor="tm-lastdone">Manual last done</label>
                <TaskDatePicker
                  id="tm-lastdone"
                  value={form.manual_last_done_override}
                  onChange={(v) => set('manual_last_done_override', v)}
                />
                <div className="task-modal-field-hint">MM/DD/YYYY</div>
              </div>
              <div className="task-modal-field">
                <label className="task-modal-label" htmlFor="tm-active-from">Active from</label>
                <TaskDatePicker
                  id="tm-active-from"
                  value={form.active_from}
                  onChange={(v) => set('active_from', v)}
                />
                <div className="task-modal-field-hint">MM/DD/YYYY</div>
              </div>
              <div className="task-modal-field">
                <label className="task-modal-label" htmlFor="tm-end-date">End date</label>
                <TaskDatePicker
                  id="tm-end-date"
                  value={form.end_date}
                  onChange={(v) => set('end_date', v)}
                />
                <div className="task-modal-field-hint">
                  MM/DD/YYYY · Dates after this are disabled; past completions are preserved.
                </div>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="task-modal-section">
            <div className="task-modal-section-title">Notes</div>
            <div className="task-modal-field task-modal-field--full">
              <textarea
                ref={notesRef}
                id="tm-notes"
                className="task-modal-textarea"
                value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
              />
              {noteLinks.length > 0 && (
                <div className="task-modal-link-reference">
                  <div className="task-modal-link-preview">
                    <span className="task-modal-link-kicker">Preview</span>
                    <LinkifiedText text={form.notes} />
                  </div>
                  <div className="task-modal-link-list" aria-label="Reference links">
                    <span className="task-modal-link-kicker">Reference links</span>
                    {noteLinks.map((link, i) => (
                      <a
                        key={`${link.href}-${i}`}
                        href={link.href}
                        className="task-modal-reference-link"
                        target="_blank"
                        rel="noopener noreferrer"
                        title={link.href}
                        onClick={(e) => handleSafeLinkClick(e, link.href)}
                      >
                        {link.label}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Footer command bar */}
          <div className="task-modal-footer">
            {confirmDelete ? (
              /* ── Delete confirmation zone ── */
              <div className="task-modal-confirm-zone">
                <span className="task-modal-confirm-copy">
                  This removes the task from the grid and dashboard.
                  Completion history is preserved and will remain in any existing archive snapshots.
                </span>
                <div className="task-modal-confirm-actions">
                  <button
                    type="button"
                    className="task-modal-cancel"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="task-modal-confirm-delete"
                    onClick={() => onDelete(task.id)}
                  >
                    Confirm Delete
                  </button>
                </div>
              </div>
            ) : (
              /* ── Normal footer ── */
              <>
                {isEdit && (
                  <button
                    type="button"
                    className="task-modal-delete-btn"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete Task
                  </button>
                )}
                {!isEdit && (
                  <span className="task-modal-footer-note">
                    Changes save to local SQLite task record
                  </span>
                )}
                <div className="task-modal-actions">
                  {saveError && (
                    <span className="task-modal-save-error" role="alert">{saveError}</span>
                  )}
                  <button type="button" className="task-modal-cancel" onClick={onClose} disabled={saving}>
                    Cancel
                  </button>
                  <button type="submit" className="task-modal-save" disabled={saving}>
                    {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Task')}
                  </button>
                </div>
              </>
            )}
          </div>

        </form>
      </div>
    </div>
  );
}
