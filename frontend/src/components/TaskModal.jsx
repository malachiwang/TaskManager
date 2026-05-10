import { useState } from 'react';

const STATUS_OPTIONS = ['active', 'hiatus'];

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

export default function TaskModal({ task, onSave, onClose }) {
  const isEdit = task != null;

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
      active_from:               task?.active_from               ?? '',
    };
  });

  function set(key, val) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    onSave(form);
  }

  // (p-1)/9 maps [1..10] → [0%..100%], matching the slider thumb's actual travel range.
  const p = Math.min(10, Math.max(1, form.priority));
  const priorityPct = `${((p - 1) / 9) * 100}%`;

  return (
    <div className="task-modal-overlay" onClick={onClose}>
      <div className="task-modal-shell" onClick={(e) => e.stopPropagation()}>

        {/* ── Dark ink header ── */}
        <div className="task-modal-header">
          <div className="task-modal-header-left">
            <div className="task-modal-kicker">
              {isEdit ? 'Edit Task' : 'Add Task'}
            </div>
            <div className="task-modal-title">
              {isEdit ? (task.name || 'Untitled') : 'New task record'}
            </div>
            <div className="task-modal-subtitle">
              {isEdit ? 'spreadsheet row editor' : 'local task record · SQLite'}
            </div>
          </div>
          <button className="task-modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* ── Paper form body ── */}
        <form className="task-modal-body" onSubmit={handleSubmit}>

          {/* Identity */}
          <div className="task-modal-section">
            <div className="task-modal-section-title">Identity</div>
            <div className="task-modal-field task-modal-field--full">
              <label className="task-modal-label" htmlFor="tm-name">Name</label>
              <input
                id="tm-name"
                className="task-modal-input"
                required
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </div>
            <div className="task-modal-field task-modal-field--full">
              <label className="task-modal-label" htmlFor="tm-subtask">Subtask</label>
              <input
                id="tm-subtask"
                className="task-modal-input"
                value={form.subtask}
                onChange={(e) => set('subtask', e.target.value)}
              />
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
                    {s}
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
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="task-modal-section">
            <div className="task-modal-section-title">Notes</div>
            <div className="task-modal-field task-modal-field--full">
              <textarea
                id="tm-notes"
                className="task-modal-textarea"
                value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
              />
            </div>
          </div>

          {/* Footer command bar */}
          <div className="task-modal-footer">
            <span className="task-modal-footer-note">
              Changes save to local SQLite task record
            </span>
            <div className="task-modal-actions">
              <button type="button" className="task-modal-cancel" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="task-modal-save">
                {isEdit ? 'Save Changes' : 'Add Task'}
              </button>
            </div>
          </div>

        </form>
      </div>
    </div>
  );
}
