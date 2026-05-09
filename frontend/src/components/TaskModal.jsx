import { useState } from 'react';

const STATUS_OPTIONS = ['active', 'focus', 'background', 'passive', 'on-hold', 'someday'];

function loadTaskDefaults() {
  try {
    const saved = localStorage.getItem('taskos-settings');
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

export default function TaskModal({ task, onSave, onClose }) {
  const isEdit = task != null;

  const [form, setForm] = useState(() => {
    const d = isEdit ? {} : loadTaskDefaults();
    return {
      name: task?.name ?? '',
      section: task?.section ?? d.defaultSection ?? 'General',
      category: task?.category ?? '',
      status: task?.status ?? 'active',
      subtask: task?.subtask ?? '',
      priority: task?.priority ?? d.defaultPriority ?? 5,
      interval_days: task?.interval_days ?? d.defaultIntervalDays ?? 7,
      notes: task?.notes ?? '',
      manual_last_done_override: task?.manual_last_done_override ?? '',
    };
  });

  function set(key, val) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    onSave(form);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{isEdit ? 'Edit Task' : 'Add Task'}</span>
          <button className="modal-close" type="button" onClick={onClose}>×</button>
        </div>

        <form className="modal-form" onSubmit={handleSubmit}>

          <div className="modal-group">
            <div className="section-kicker">Identity</div>
            <div className="modal-row full-width">
              <label>
                Name
                <input
                  required
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="modal-group">
            <div className="section-kicker">Classification</div>
            <div className="modal-row">
              <label>
                Section
                <input
                  value={form.section}
                  onChange={(e) => set('section', e.target.value)}
                  placeholder="General"
                />
              </label>
              <label>
                Category
                <input
                  value={form.category}
                  onChange={(e) => set('category', e.target.value)}
                />
              </label>
            </div>
            <div className="modal-row full-width">
              <label>
                Status
                <select value={form.status} onChange={(e) => set('status', e.target.value)}>
                  {STATUS_OPTIONS.map((s) => <option key={s}>{s}</option>)}
                </select>
              </label>
            </div>
          </div>

          <div className="modal-group">
            <div className="section-kicker">Scheduling</div>
            <div className="modal-row">
              <label>
                Subtask
                <input
                  value={form.subtask}
                  onChange={(e) => set('subtask', e.target.value)}
                />
              </label>
              <label>
                Priority (1–10)
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={form.priority}
                  onChange={(e) => set('priority', Number(e.target.value))}
                />
              </label>
            </div>
            <div className="modal-row">
              <label>
                Interval (days)
                <input
                  type="number"
                  min="1"
                  value={form.interval_days}
                  onChange={(e) => set('interval_days', Number(e.target.value))}
                />
              </label>
              <label>
                Manual last done
                <input
                  type="date"
                  value={form.manual_last_done_override}
                  onChange={(e) => set('manual_last_done_override', e.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="modal-group">
            <div className="section-kicker">Notes</div>
            <div className="modal-row full-width">
              <label>
                Notes
                <textarea
                  value={form.notes}
                  onChange={(e) => set('notes', e.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="modal-row full-width modal-actions">
            <button type="submit">{isEdit ? 'Save Changes' : 'Add Task'}</button>
            <button type="button" className="btn-cancel" onClick={onClose}>Cancel</button>
          </div>

        </form>
      </div>
    </div>
  );
}
