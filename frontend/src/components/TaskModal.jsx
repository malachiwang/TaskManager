import { useEffect, useRef, useState } from 'react';
import { urgencyLabel, urgencyReason } from '../urgency.js';
import { extractLinks, normalizeSafeUrl, spliceMarkdownLink } from '../linkUtils.js';
import LinkifiedText from './LinkifiedText.jsx';

const STATUS_OPTIONS = ['active', 'hiatus'];
// Display labels only — the stored status value stays lowercase ('active'/'hiatus').
const STATUS_LABELS = { active: 'Active', hiatus: 'Hiatus' };

function getLocalToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

export default function TaskModal({ task, onSave, onDelete, onClose }) {
  const isEdit = task != null;

  const [confirmDelete, setConfirmDelete] = useState(false);
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
      active_from:               task?.active_from               ?? (isEdit ? '' : getLocalToday()),
      end_date:                  task?.end_date                  ?? '',
    };
  });
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
      await onSave(form);
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
            onKeyDown={(e) => {
              if (e.key === 'Enter' && linkUrlSafe) {
                e.preventDefault();
                insertMarkdownLink();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                closeInsertLink();
              }
            }}
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
                <input
                  id="tm-section"
                  className="task-modal-input"
                  value={form.section}
                  onChange={(e) => set('section', e.target.value)}
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

            {/* Status — segmented buttons */}
            <div className="task-modal-field task-modal-field--full">
              <label className="task-modal-label">Status</label>
              <div className="task-modal-seg" role="group" aria-label="Status">
                {STATUS_OPTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`task-modal-seg-btn${form.status === s ? ' task-modal-seg-btn--active' : ''}`}
                    onClick={() => set('status', s)}
                  >
                    {STATUS_LABELS[s] ?? s}
                  </button>
                ))}
              </div>
            </div>

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
                <input
                  id="tm-lastdone"
                  className="task-modal-input"
                  type="date"
                  value={form.manual_last_done_override}
                  onChange={(e) => set('manual_last_done_override', e.target.value)}
                />
                <div className="task-modal-field-hint">MM/DD/YYYY</div>
              </div>
              <div className="task-modal-field">
                <label className="task-modal-label" htmlFor="tm-active-from">Active from</label>
                <input
                  id="tm-active-from"
                  className="task-modal-input"
                  type="date"
                  value={form.active_from}
                  onChange={(e) => set('active_from', e.target.value)}
                />
                <div className="task-modal-field-hint">MM/DD/YYYY</div>
              </div>
              <div className="task-modal-field">
                <label className="task-modal-label" htmlFor="tm-end-date">End date</label>
                <input
                  id="tm-end-date"
                  className="task-modal-input"
                  type="date"
                  value={form.end_date}
                  onChange={(e) => set('end_date', e.target.value)}
                />
                <button
                  type="button"
                  className="task-modal-end-today-btn"
                  onClick={() => set('end_date', getLocalToday())}
                >
                  End today
                </button>
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
