import { useState } from 'react';

const STATUS_OPTIONS = ['active', 'finished', 'archived'];
const STATUS_LABELS = { active: 'Active', finished: 'Finished', archived: 'Archived' };

function getLocalToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Lightweight editor for a reading book. Reuses the dense task-modal styling so
// the Reading sheet feels like a sibling of the task grid, not a card UI.
export default function ReadingBookModal({ book, onSave, onDelete, onClose }) {
  const isEdit = book != null;
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [form, setForm] = useState(() => ({
    title:        book?.title        ?? '',
    author:       book?.author       ?? '',
    total_pages:  book?.total_pages  ?? '',
    current_page: book?.current_page ?? 0,
    status:       book?.status       ?? 'active',
    started_at:   book?.started_at   ?? (isEdit ? '' : getLocalToday()),
    finished_at:  book?.finished_at  ?? '',
    notes:        book?.notes        ?? '',
  }));

  function set(key, val) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.title.trim()) return;
    // Coerce numeric fields; blank total_pages → null (unknown length).
    const payload = {
      title:        form.title.trim(),
      author:       form.author.trim(),
      total_pages:  form.total_pages === '' ? null : Math.max(0, parseInt(form.total_pages, 10) || 0),
      current_page: Math.max(0, parseInt(form.current_page, 10) || 0),
      status:       form.status,
      started_at:   form.started_at || null,
      finished_at:  form.finished_at || null,
      notes:        form.notes,
    };
    onSave(payload);
  }

  return (
    <div className="task-modal-overlay" onClick={onClose}>
      <div className="task-modal-shell" onClick={(e) => e.stopPropagation()}>
        <div className="task-modal-header">
          <div className="task-modal-header-left">
            <div className="task-modal-kicker">{isEdit ? 'Book Details' : 'Add Book'}</div>
            <div className="task-modal-title">{isEdit ? (book.title || 'Untitled') : 'New book'}</div>
            <div className="task-modal-subtitle">reading sheet · current page · progress</div>
          </div>
          <button className="task-modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form className="task-modal-body" onSubmit={handleSubmit}>
          <div className="task-modal-section">
            <div className="task-modal-section-title">Book</div>
            <div className="task-modal-grid">
              <div className="task-modal-field task-modal-field--full">
                <label className="task-modal-label" htmlFor="rb-title">Title</label>
                <input id="rb-title" className="task-modal-input" value={form.title}
                  onChange={(e) => set('title', e.target.value)} autoFocus required />
              </div>
              <div className="task-modal-field task-modal-field--full">
                <label className="task-modal-label" htmlFor="rb-author">Author</label>
                <input id="rb-author" className="task-modal-input" value={form.author}
                  onChange={(e) => set('author', e.target.value)} placeholder="optional" />
              </div>
              <div className="task-modal-field">
                <label className="task-modal-label" htmlFor="rb-current">Current page</label>
                <input id="rb-current" className="task-modal-input" type="number" min="0"
                  value={form.current_page} onChange={(e) => set('current_page', e.target.value)} />
              </div>
              <div className="task-modal-field">
                <label className="task-modal-label" htmlFor="rb-total">Total pages</label>
                <input id="rb-total" className="task-modal-input" type="number" min="0"
                  value={form.total_pages} onChange={(e) => set('total_pages', e.target.value)}
                  placeholder="unknown" />
              </div>
            </div>
          </div>

          <div className="task-modal-section">
            <div className="task-modal-section-title">Status & dates</div>
            <div className="task-modal-grid">
              <div className="task-modal-field task-modal-field--full">
                <label className="task-modal-label">Status</label>
                <div className="task-modal-seg" role="group" aria-label="Status">
                  {STATUS_OPTIONS.map((s) => (
                    <button key={s} type="button"
                      className={`task-modal-seg-btn${form.status === s ? ' task-modal-seg-btn--active' : ''}`}
                      onClick={() => set('status', s)}>
                      {STATUS_LABELS[s]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="task-modal-field">
                <label className="task-modal-label" htmlFor="rb-started">Started</label>
                <input id="rb-started" className="task-modal-input" type="date"
                  value={form.started_at} onChange={(e) => set('started_at', e.target.value)} />
                <div className="task-modal-field-hint">MM/DD/YYYY</div>
              </div>
              <div className="task-modal-field">
                <label className="task-modal-label" htmlFor="rb-finished">Finished</label>
                <input id="rb-finished" className="task-modal-input" type="date"
                  value={form.finished_at} onChange={(e) => set('finished_at', e.target.value)} />
                <div className="task-modal-field-hint">MM/DD/YYYY</div>
              </div>
            </div>
          </div>

          <div className="task-modal-section">
            <div className="task-modal-section-title">Notes</div>
            <div className="task-modal-field task-modal-field--full">
              <textarea id="rb-notes" className="task-modal-textarea" value={form.notes}
                onChange={(e) => set('notes', e.target.value)} />
            </div>
          </div>

          <div className="task-modal-footer">
            {isEdit && onDelete && confirmDelete ? (
              <div className="task-modal-confirm-zone">
                <span className="task-modal-confirm-copy">
                  This permanently removes the book and its page history. To keep
                  history, use Archive instead.
                </span>
                <div className="task-modal-confirm-actions">
                  <button type="button" className="task-modal-cancel" onClick={() => setConfirmDelete(false)}>Cancel</button>
                  <button type="button" className="task-modal-confirm-delete" onClick={() => onDelete(book.id)}>Confirm Delete</button>
                </div>
              </div>
            ) : (
              <>
                {isEdit && onDelete && (
                  <button type="button" className="task-modal-delete-btn" onClick={() => setConfirmDelete(true)}>Delete Book</button>
                )}
                {!isEdit && (
                  <span className="task-modal-footer-note">Changes save to local SQLite reading record</span>
                )}
                <div className="task-modal-actions">
                  <button type="button" className="task-modal-cancel" onClick={onClose}>Cancel</button>
                  <button type="submit" className="task-modal-save" disabled={!form.title.trim()}>
                    {isEdit ? 'Save Changes' : 'Add Book'}
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
