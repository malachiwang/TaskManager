import { useEffect, useState } from 'react';
import { updateTask, updateSession, deleteSession } from '../api.js';
import SectionCombobox from './SectionCombobox.jsx';
import {
  DAY_MINUTES, MIN_SESSION_MINUTES,
  plannedDate, plannedMinutes, combinePlanned, combinePlannedEnd,
  durationLabel, fullDateLabel,
} from '../calendarUtils.js';
import { displayTitle } from '../linkUtils.js';

// CalendarEditor (P13.1) — the Calendar-native session/task editor.
//
// Focused on scheduling: name, classification, depth, priority, estimate,
// and THIS session's time + fixed/flexible. Grid-recurrence machinery
// (interval days, manual last done, active from, end date, hiatus history)
// deliberately does not appear here — "Open full task" opens the complete
// canonical TaskModal when deeper editing is needed.
//
// Saving patches the SAME canonical records the Grid uses: task fields via
// PATCH /tasks/{id}, session times via PATCH /sessions/{id}. Deleting here
// removes only the session, never the task.

function pad2(n) {
  return String(n).padStart(2, '0');
}

function minutesToTimeValue(m) {
  const clamped = Math.max(0, Math.min(DAY_MINUTES - 1, Math.round(m)));
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

function timeValueToMinutes(v) {
  if (!v) return null;
  const [h, m] = v.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

// Start / End / Duration row (§9). The three stay synchronized: moving Start
// preserves duration, editing End or Duration adjusts the other. The caller
// re-renders any on-calendar highlight from the same values, so form and
// highlight can never disagree.
export function TimeRangeFields({ startMin, endMin, onChange }) {
  const dur = endMin - startMin;
  const [durText, setDurText] = useState(String(dur));
  useEffect(() => { setDurText(String(dur)); }, [dur]);
  return (
    <div className="cal-time-fields">
      <label className="cal-time-field">
        <span>Start</span>
        <input
          type="time"
          step="900"
          value={minutesToTimeValue(startMin)}
          onChange={(e) => {
            const v = timeValueToMinutes(e.target.value);
            if (v == null) return;
            onChange({ startMin: v, endMin: Math.min(DAY_MINUTES, v + dur) });
          }}
        />
      </label>
      <label className="cal-time-field">
        <span>End</span>
        <input
          type="time"
          step="900"
          value={minutesToTimeValue(endMin)}
          onChange={(e) => {
            const v = timeValueToMinutes(e.target.value);
            if (v == null) return;
            onChange({ startMin, endMin: Math.max(startMin + MIN_SESSION_MINUTES, v) });
          }}
        />
      </label>
      <label className="cal-time-field">
        <span>Duration</span>
        <span className="cal-time-duration">
          <input
            type="number"
            min={MIN_SESSION_MINUTES}
            step="15"
            value={durText}
            onChange={(e) => {
              setDurText(e.target.value);
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= MIN_SESSION_MINUTES) {
                onChange({ startMin, endMin: Math.min(DAY_MINUTES, startMin + Math.round(v)) });
              }
            }}
          />
          <span>min</span>
        </span>
      </label>
    </div>
  );
}

const DEPTH_OPTIONS = [
  { value: 0, label: 'None' },
  { value: 1, label: 'D1' },
  { value: 2, label: 'D2' },
  { value: 3, label: 'D3' },
];

export default function CalendarEditor({
  session, task, sectionSuggestions,
  onClose, onOpenFullTask, onChanged, onCompleteSession, onPromote,
}) {
  // task == null → calendar-only entry (P14.0): no canonical record behind
  // it, so no Grid fields — just title/time/depth/fixed plus the explicit
  // "Add to main Grid…" promotion.
  const isLinked = task != null;
  const dateIso = plannedDate(session.planned_start);
  const [form, setForm] = useState(() => {
    const startMin = plannedMinutes(session.planned_start);
    return {
      name: isLinked ? task.name : (session.title || session.task_name),
      section: task?.section ?? 'General',
      category: task?.category ?? '',
      depth: isLinked ? (task.depth ?? 0) : (session.depth ?? 0),
      priority: task?.priority ?? 5,
      estimated_minutes: task?.estimated_minutes ?? '',
      startMin,
      endMin: Math.min(DAY_MINUTES, startMin + session.planned_minutes),
      isFixed: !!session.is_fixed,
    };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  function set(key, val) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  // Escape closes the editor (capture phase so the Calendar's own keyboard
  // handler never sees it while the editor is open).
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  async function handleSave() {
    if (saving) return;
    if (!form.name.trim()) {
      setError('Name must not be empty.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (isLinked) {
        await updateTask(task.id, {
          name: form.name.trim(),
          section: form.section,
          category: form.category,
          depth: form.depth || 0,
          priority: form.priority,
          estimated_minutes: form.estimated_minutes === '' ? 0 : Number(form.estimated_minutes),
        });
        await updateSession(session.id, {
          planned_start: combinePlanned(dateIso, form.startMin),
          planned_end: combinePlannedEnd(dateIso, form.endMin),
          is_fixed: form.isFixed,
        });
      } else {
        await updateSession(session.id, {
          title: form.name.trim(),
          depth: form.depth || 0,
          planned_start: combinePlanned(dateIso, form.startMin),
          planned_end: combinePlannedEnd(dateIso, form.endMin),
          is_fixed: form.isFixed,
        });
      }
      onChanged();
      onClose();
    } catch (err) {
      setSaving(false);
      setError(err?.message || 'Save failed. Please try again.');
    }
  }

  async function handleDeleteSession() {
    try {
      await deleteSession(session.id);
      onChanged();
      onClose();
    } catch (err) {
      setError(err?.message || 'Delete failed. Please try again.');
    }
  }

  const statusLabel = { scheduled: 'Scheduled', completed: 'Completed', partial: 'Partial', skipped: 'Skipped' }[session.status] ?? session.status;

  return (
    <div className="task-modal-overlay" onClick={onClose}>
      <div className="task-modal-shell cal-editor-shell" onClick={(e) => e.stopPropagation()}>

        <div className="task-modal-header">
          <div className="task-modal-header-left">
            <div className="task-modal-kicker">
              {isLinked ? 'Calendar Session · linked to Grid task' : 'Calendar Entry · not on the Grid'}
            </div>
            <div className="task-modal-title">{displayTitle(task?.name || session.task_name)}</div>
            <div className="task-modal-subtitle">
              {fullDateLabel(dateIso)} · {statusLabel.toLowerCase()}
              {task?.estimated_minutes
                ? ` · ${durationLabel(task.logged_minutes ?? 0)} logged · ${durationLabel(task.remaining_minutes ?? 0)} remaining`
                : ''}
            </div>
          </div>
          <button className="task-modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form
          className="task-modal-body"
          onSubmit={(e) => { e.preventDefault(); handleSave(); }}
        >
          <div className="task-modal-section">
            <div className="task-modal-section-title">{isLinked ? 'Task' : 'Entry'}</div>
            <div className="task-modal-field task-modal-field--full">
              <label className="task-modal-label" htmlFor="ce-name">Name</label>
              <input
                id="ce-name"
                className="task-modal-input"
                required
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </div>
            {isLinked && (
              <div className="task-modal-grid">
                <div className="task-modal-field">
                  <label className="task-modal-label" htmlFor="ce-section">Section</label>
                  <SectionCombobox
                    id="ce-section"
                    value={form.section}
                    onChange={(v) => set('section', v)}
                    suggestions={sectionSuggestions}
                    placeholder="General"
                  />
                </div>
                <div className="task-modal-field">
                  <label className="task-modal-label" htmlFor="ce-category">Category</label>
                  <input
                    id="ce-category"
                    className="task-modal-input"
                    value={form.category}
                    onChange={(e) => set('category', e.target.value)}
                  />
                </div>
              </div>
            )}
            <div className="task-modal-grid">
              <div className="task-modal-field">
                <label className="task-modal-label">Cognitive depth</label>
                <div className="task-modal-seg" role="group" aria-label="Cognitive depth">
                  {DEPTH_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      className={`task-modal-seg-btn${form.depth === o.value ? ' task-modal-seg-btn--active' : ''}`}
                      aria-pressed={form.depth === o.value}
                      onClick={() => set('depth', o.value)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              {isLinked && (
                <div className="task-modal-field">
                  <label className="task-modal-label" htmlFor="ce-priority">Priority (1–10)</label>
                  <input
                    id="ce-priority"
                    className="task-modal-input"
                    type="number"
                    min="1"
                    max="10"
                    value={form.priority}
                    onChange={(e) => set('priority', Number(e.target.value))}
                  />
                </div>
              )}
            </div>
            {isLinked && (
              <div className="task-modal-field">
                <label className="task-modal-label" htmlFor="ce-estimate">Estimated total effort (min)</label>
                <input
                  id="ce-estimate"
                  className="task-modal-input"
                  type="number"
                  min="0"
                  step="5"
                  placeholder="e.g. 180"
                  value={form.estimated_minutes}
                  onChange={(e) => set('estimated_minutes', e.target.value)}
                />
              </div>
            )}
            {!isLinked && (
              <div className="task-modal-field-hint">
                This lives only on the Calendar — it is not a Grid task and
                carries no recurrence or pressure. Use “Add to main Grid…” to
                promote it.
              </div>
            )}
          </div>

          <div className="task-modal-section">
            <div className="task-modal-section-title">This session</div>
            <TimeRangeFields
              startMin={form.startMin}
              endMin={form.endMin}
              onChange={({ startMin, endMin }) => setForm((p) => ({ ...p, startMin, endMin }))}
            />
            <div className="task-modal-field task-modal-field--full">
              <label className="task-modal-label">Scheduling</label>
              <div className="task-modal-seg" role="group" aria-label="Fixed or flexible">
                <button
                  type="button"
                  className={`task-modal-seg-btn${!form.isFixed ? ' task-modal-seg-btn--active' : ''}`}
                  aria-pressed={!form.isFixed}
                  onClick={() => set('isFixed', false)}
                >
                  Flexible
                </button>
                <button
                  type="button"
                  className={`task-modal-seg-btn${form.isFixed ? ' task-modal-seg-btn--active' : ''}`}
                  aria-pressed={form.isFixed}
                  onClick={() => set('isFixed', true)}
                >
                  Fixed
                </button>
              </div>
              <div className="task-modal-field-hint">
                Fixed sessions resist future automatic replanning. Session status: {statusLabel}.
              </div>
            </div>
          </div>

          <div className="task-modal-footer">
            {confirmDelete ? (
              <div className="task-modal-confirm-zone">
                <span className="task-modal-confirm-copy">
                  {isLinked
                    ? 'Remove this scheduled session only — the task itself stays in the Grid and keeps its history.'
                    : 'Remove this calendar entry. It was never on the Grid, so nothing else changes.'}
                </span>
                <div className="task-modal-confirm-actions">
                  <button type="button" className="task-modal-cancel" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                  <button type="button" className="task-modal-confirm-delete" onClick={handleDeleteSession}>
                    {isLinked ? 'Remove session' : 'Remove entry'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="task-modal-delete-btn"
                  title={isLinked
                    ? 'Remove only this scheduled session — never the task'
                    : 'Remove this calendar entry'}
                  onClick={() => setConfirmDelete(true)}
                >
                  {isLinked ? 'Remove session' : 'Remove entry'}
                </button>
                <div className="task-modal-actions">
                  {error && <span className="task-modal-save-error" role="alert">{error}</span>}
                  {session.status !== 'completed' && (
                    <button
                      type="button"
                      className="task-modal-cancel"
                      title={isLinked
                        ? 'Mark this session completed (records a completion for its date)'
                        : 'Mark this entry completed — calendar-only, no Grid completion'}
                      onClick={() => { onCompleteSession(); onClose(); }}
                    >
                      {isLinked ? 'Complete session' : 'Complete entry'}
                    </button>
                  )}
                  {isLinked ? (
                    <button
                      type="button"
                      className="task-modal-cancel"
                      title="Open the complete TaskManager record editor"
                      onClick={onOpenFullTask}
                    >
                      Open full task
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="task-modal-cancel"
                      title="Create a canonical Grid task from this entry via the standard New Task form"
                      onClick={() => onPromote({
                        name: form.name.trim() || session.task_name,
                        depth: form.depth || 0,
                        estimated_minutes: form.endMin - form.startMin,
                      })}
                    >
                      Add to main Grid…
                    </button>
                  )}
                  <button type="button" className="task-modal-cancel" onClick={onClose} disabled={saving}>
                    Cancel
                  </button>
                  <button type="submit" className="task-modal-save" disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
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
