import { useEffect, useState } from 'react';
import {
  updateTask, updateSession, deleteSession, createContext,
  createRecurrenceSeries, updateRecurrenceSeries, deleteRecurrenceSeries,
} from '../api.js';
import SectionCombobox from './SectionCombobox.jsx';
import {
  DAY_MINUTES, MIN_SESSION_MINUTES,
  plannedDate, plannedMinutes, combinePlanned, combinePlannedEnd,
  durationLabel, fullDateLabel, weekdayOfIso, addDaysIso,
  describeRecurrence, formatTimeRange,
} from '../calendarUtils.js';
import { displayTitle } from '../linkUtils.js';

// CalendarEditor (P13.1) — the Calendar-native session/task editor.
//
// Focused on scheduling: name, classification, depth, priority, estimate,
// THIS session's time + fixed/flexible, and the Repeat rule (Calendar
// recurrence — recurring scheduled sessions, never duplicate Grid tasks).
// Grid-recurrence machinery (interval days, manual last done, active from,
// end date, hiatus history) deliberately does not appear here — "Open full
// task" opens the complete canonical TaskModal when deeper editing is needed.
//
// Saving patches the SAME canonical records the Grid uses: task fields via
// PATCH /tasks/{id}, session times via PATCH /sessions/{id}, repeat rules
// via the recurrence-series endpoints. Deleting here removes sessions (with
// Google Calendar-style scope for recurring occurrences), never the task.

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

const REPEAT_DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Repeat control (Calendar recurrence). Weekly is the prominent one-click
// option (§4); Custom opens multi-day / interval / end-condition fields
// without turning the editor into a wall of controls (§5).
export function RepeatFields({ repeat, onChange, anchorWeekday, startMin, endMin, disabled = false }) {
  function set(patch) {
    onChange({ ...repeat, ...patch });
  }
  const previewRule = repeat.mode === 'none' ? '' : describeRecurrence({
    weekdays: repeat.weekdays,
    interval_weeks: repeat.interval,
    until_date: repeat.ends === 'date' ? (repeat.until || null) : null,
    count: repeat.ends === 'count' ? Number(repeat.count) || null : null,
  });
  return (
    <>
      <div className="task-modal-seg" role="group" aria-label="Repeat">
        <button
          type="button"
          className={`task-modal-seg-btn${repeat.mode === 'none' ? ' task-modal-seg-btn--active' : ''}`}
          aria-pressed={repeat.mode === 'none'}
          disabled={disabled}
          onClick={() => set({ mode: 'none' })}
        >
          None
        </button>
        <button
          type="button"
          className={`task-modal-seg-btn${repeat.mode === 'weekly' ? ' task-modal-seg-btn--active' : ''}`}
          aria-pressed={repeat.mode === 'weekly'}
          disabled={disabled}
          title="Repeat every week on the same weekday at the same time"
          onClick={() => set({ mode: 'weekly', weekdays: [anchorWeekday], interval: 1 })}
        >
          Weekly
        </button>
        <button
          type="button"
          className={`task-modal-seg-btn${repeat.mode === 'custom' ? ' task-modal-seg-btn--active' : ''}`}
          aria-pressed={repeat.mode === 'custom'}
          disabled={disabled}
          onClick={() => set({ mode: 'custom' })}
        >
          Custom…
        </button>
      </div>
      {repeat.mode === 'custom' && (
        <div className="cal-repeat-custom">
          <div className="cal-repeat-days" role="group" aria-label="Repeat on weekdays">
            {REPEAT_DAY_LABELS.map((label, wd) => {
              const on = repeat.weekdays.includes(wd);
              return (
                <button
                  key={label}
                  type="button"
                  className={`cal-repeat-day${on ? ' cal-repeat-day--on' : ''}`}
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => {
                    const next = on
                      ? repeat.weekdays.filter((d) => d !== wd)
                      : [...repeat.weekdays, wd].sort((a, b) => a - b);
                    if (next.length > 0) set({ weekdays: next });
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <label className="cal-repeat-interval">
            <span>Every</span>
            <input
              type="number"
              min="1"
              max="26"
              value={repeat.interval}
              disabled={disabled}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 1) set({ interval: Math.round(v) });
              }}
            />
            <span>{repeat.interval === 1 ? 'week' : 'weeks'}</span>
          </label>
          <div className="cal-repeat-ends">
            <span className="task-modal-label">Ends</span>
            <div className="task-modal-seg" role="group" aria-label="Repeat end condition">
              {[['never', 'Never'], ['date', 'On date'], ['count', 'After N']].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`task-modal-seg-btn${repeat.ends === value ? ' task-modal-seg-btn--active' : ''}`}
                  aria-pressed={repeat.ends === value}
                  disabled={disabled}
                  onClick={() => set({ ends: value })}
                >
                  {label}
                </button>
              ))}
            </div>
            {repeat.ends === 'date' && (
              <input
                type="date"
                value={repeat.until}
                disabled={disabled}
                onChange={(e) => set({ until: e.target.value })}
              />
            )}
            {repeat.ends === 'count' && (
              <span className="cal-time-duration">
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={repeat.count}
                  disabled={disabled}
                  onChange={(e) => set({ count: e.target.value })}
                />
                <span>times</span>
              </span>
            )}
          </div>
        </div>
      )}
      {previewRule && (
        <div className="cal-repeat-preview" aria-live="polite">
          ↻ {previewRule} · {formatTimeRange(startMin, endMin)}
        </div>
      )}
    </>
  );
}

export function repeatFromSeries(series) {
  const simpleWeekly = series.interval_weeks === 1
    && series.weekdays.length === 1 && !series.until_date && !series.count;
  return {
    mode: simpleWeekly ? 'weekly' : 'custom',
    weekdays: series.weekdays,
    interval: series.interval_weeks,
    ends: series.until_date ? 'date' : (series.count ? 'count' : 'never'),
    until: series.until_date || '',
    count: series.count || 10,
  };
}

export function emptyRepeat(anchorWeekday) {
  return { mode: 'none', weekdays: [anchorWeekday], interval: 1, ends: 'never', until: '', count: 10 };
}

// Repeat form state → recurrence-series rule fields.
export function repeatRuleFields(repeat) {
  return {
    weekdays: repeat.weekdays,
    interval_weeks: repeat.interval,
    until_date: repeat.ends === 'date' ? (repeat.until || null) : null,
    count: repeat.ends === 'count' ? Number(repeat.count) || null : null,
  };
}

export default function CalendarEditor({
  session, task, series = null, sectionSuggestions, contexts = [],
  onClose, onOpenFullTask, onChanged, onCompleteSession, onPromote,
}) {
  // task == null → calendar-only entry (P14.0): no canonical record behind
  // it, so no Grid fields — just title/time/depth/fixed plus the explicit
  // "Add to main Grid…" promotion.
  const isLinked = task != null;
  const isRecurring = series != null;
  const dateIso = plannedDate(session.planned_start);
  // The slot this occurrence represents in its series (differs from the
  // planned date when the occurrence was moved across days).
  const occDate = session.occurrence_date || dateIso;
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
      // Entry context (V5.0): relational metadata only, entries only —
      // linked sessions show their task's context read-only.
      contextName: isLinked ? '' : (session.context_name ?? ''),
    };
  });
  const [repeat, setRepeat] = useState(() => (
    series ? repeatFromSeries(series) : emptyRepeat(weekdayOfIso(dateIso))
  ));
  // Google Calendar-style scope for time/detail changes on a recurring
  // occurrence (§13). Repeat-rule changes always apply series-wide.
  const [applyScope, setApplyScope] = useState('occurrence');
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

  async function resolveContextId() {
    // Context resolves find-or-create by name; blank clears (0).
    const ctxName = form.contextName.trim();
    if (!ctxName) return 0;
    const ctx = await createContext(ctxName);
    return ctx.id;
  }

  async function handleSave() {
    if (saving) return;
    if (!form.name.trim()) {
      setError('Name must not be empty.');
      return;
    }
    if (repeat.mode !== 'none' && repeat.ends === 'date' && !repeat.until) {
      setError('Pick the date the repeat ends, or choose Never.');
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
      }

      const rule = repeatRuleFields(repeat);
      const durationMin = form.endMin - form.startMin;
      const sessionTimePatch = {
        planned_start: combinePlanned(dateIso, form.startMin),
        planned_end: combinePlannedEnd(dateIso, form.endMin),
        is_fixed: form.isFixed,
      };

      async function patchThisOccurrence() {
        if (isLinked) {
          await updateSession(session.id, sessionTimePatch);
        } else {
          await updateSession(session.id, {
            title: form.name.trim(),
            depth: form.depth || 0,
            context_id: await resolveContextId(),
            ...sessionTimePatch,
          });
        }
      }

      if (!isRecurring) {
        await patchThisOccurrence();
        if (repeat.mode !== 'none') {
          // One extra click made this weekly (§4/§22): the saved block
          // becomes the series anchor; occurrences appear on reload.
          await createRecurrenceSeries({ from_session_id: session.id, ...rule });
        }
      } else if (repeat.mode === 'none') {
        // Repeat turned off: this occurrence and all history stay; the
        // series stops generating from the next day on (§38).
        await patchThisOccurrence();
        await deleteRecurrenceSeries(series.id, addDaysIso(occDate, 1));
      } else {
        const ruleChanged = JSON.stringify(rule.weekdays) !== JSON.stringify(series.weekdays)
          || rule.interval_weeks !== series.interval_weeks
          || (rule.until_date || null) !== (series.until_date || null)
          || (rule.count || null) !== (series.count || null);
        const entryIdentity = isLinked ? {} : {
          title: form.name.trim(),
          depth: form.depth || 0,
          context_id: await resolveContextId(),
        };
        if (applyScope === 'occurrence') {
          await patchThisOccurrence();
          if (ruleChanged) {
            // The rule belongs to the whole series — times were scoped to
            // this occurrence, the pattern change was not.
            await updateRecurrenceSeries(series.id, { scope: 'all', ...rule });
          }
        } else if (applyScope === 'following') {
          await updateRecurrenceSeries(series.id, {
            scope: 'following',
            from_date: occDate,
            ...rule,
            start_minutes: form.startMin,
            duration_minutes: durationMin,
            is_fixed: form.isFixed,
            ...entryIdentity,
          });
        } else {
          await updateRecurrenceSeries(series.id, {
            scope: 'all',
            ...rule,
            start_minutes: form.startMin,
            duration_minutes: durationMin,
            is_fixed: form.isFixed,
            ...entryIdentity,
          });
        }
      }
      onChanged();
      onClose();
    } catch (err) {
      setSaving(false);
      setError(err?.message || 'Save failed. Please try again.');
    }
  }

  async function handleDeleteSession(scope = 'occurrence') {
    try {
      await deleteSession(session.id, scope);
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
              {isRecurring ? ' · ↻ recurring' : ''}
            </div>
            <div className="task-modal-title">{displayTitle(task?.name || session.task_name)}</div>
            <div className="task-modal-subtitle">
              {fullDateLabel(dateIso)} · {statusLabel.toLowerCase()}
              {isRecurring ? ` · ${series.label}` : ''}
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
              <div className="task-modal-field">
                <label className="task-modal-label" htmlFor="ce-context">Context / course</label>
                <input
                  id="ce-context"
                  className="task-modal-input"
                  list="ce-context-options"
                  placeholder="e.g. ISYE 2027 (optional)"
                  value={form.contextName}
                  onChange={(e) => set('contextName', e.target.value)}
                />
                <datalist id="ce-context-options">
                  {contexts.map((c) => <option key={c.id} value={c.name} />)}
                </datalist>
              </div>
            )}
            {!isLinked && !isRecurring && (
              <div className="task-modal-field-hint">
                This lives only on the Calendar — it is not a Grid task and
                carries no pressure. Use “Add to main Grid…” to promote it.
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
            {isRecurring && (
              <div className="task-modal-field task-modal-field--full">
                <label className="task-modal-label">Apply changes to</label>
                <div className="task-modal-seg" role="group" aria-label="Edit scope">
                  {[['occurrence', 'This occurrence'], ['following', 'This + following'], ['all', 'All occurrences']].map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`task-modal-seg-btn${applyScope === value ? ' task-modal-seg-btn--active' : ''}`}
                      aria-pressed={applyScope === value}
                      onClick={() => setApplyScope(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="task-modal-field-hint">
                  Past occurrences and recorded work are never rewritten.
                </div>
              </div>
            )}
          </div>

          <div className="task-modal-section">
            <div className="task-modal-section-title">Repeat</div>
            <RepeatFields
              repeat={repeat}
              onChange={setRepeat}
              anchorWeekday={weekdayOfIso(dateIso)}
              startMin={form.startMin}
              endMin={form.endMin}
            />
            {isRecurring && (
              <div className="task-modal-field-hint">
                Repeat-rule changes apply to the whole series. Choosing None
                stops the repeat after this occurrence — history stays.
              </div>
            )}
          </div>

          <div className="task-modal-footer">
            {confirmDelete ? (
              <div className="task-modal-confirm-zone">
                <span className="task-modal-confirm-copy">
                  {isRecurring
                    ? 'This block repeats. Remove how much? Recorded work is never deleted.'
                    : isLinked
                      ? 'Remove this scheduled session only — the task itself stays in the Grid and keeps its history.'
                      : 'Remove this calendar entry. It was never on the Grid, so nothing else changes.'}
                </span>
                <div className="task-modal-confirm-actions">
                  <button type="button" className="task-modal-cancel" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                  {isRecurring ? (
                    <>
                      <button type="button" className="task-modal-confirm-delete" onClick={() => handleDeleteSession('occurrence')}>
                        This occurrence
                      </button>
                      <button type="button" className="task-modal-confirm-delete" onClick={() => handleDeleteSession('following')}>
                        This + following
                      </button>
                      <button type="button" className="task-modal-confirm-delete" onClick={() => handleDeleteSession('all')}>
                        All occurrences
                      </button>
                    </>
                  ) : (
                    <button type="button" className="task-modal-confirm-delete" onClick={() => handleDeleteSession('occurrence')}>
                      {isLinked ? 'Remove session' : 'Remove entry'}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="task-modal-delete-btn"
                  title={isRecurring
                    ? 'Remove this occurrence, this and following, or the whole series'
                    : isLinked
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
