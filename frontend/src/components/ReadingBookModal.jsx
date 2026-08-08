import { useState } from 'react';
import { normalizeSafeUrl } from '../linkUtils.js';

const STATUS_OPTIONS = ['active', 'finished', 'archived'];
const STATUS_LABELS = { active: 'Active', finished: 'Finished', archived: 'Archived' };

// Book priority scale (P11.0): 1–5, calmer than task urgency. Labels drive the
// badge tooltip and the colored chips here and in ReadingSheet rows.
export const PRIORITY_LABELS = { 1: 'Background', 2: 'Low', 3: 'Normal', 4: 'High', 5: 'Highest' };

function getLocalToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Lightweight editor for a reading book. Reuses the dense task-modal styling so
// the Reading sheet feels like a sibling of the task grid, not a card UI.
// initialToBuy seeds new books created from the "To Buy" view; the mode toggle
// lets any book move between the library and the to-buy list.
export default function ReadingBookModal({ book, onSave, onDelete, onClose, initialToBuy = false }) {
  const isEdit = book != null;
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [form, setForm] = useState(() => ({
    title:          book?.title          ?? '',
    author:         book?.author         ?? '',
    total_pages:    book?.total_pages    ?? '',
    current_page:   book?.current_page   ?? 0,
    status:         book?.status         ?? 'active',
    started_at:     book?.started_at     ?? (isEdit ? '' : getLocalToday()),
    finished_at:    book?.finished_at    ?? '',
    notes:          book?.notes          ?? '',
    priority:       book?.priority       ?? 3,
    to_buy:         book ? !!book.to_buy : !!initialToBuy,
    purchase_url:   book?.purchase_url   ?? '',
    purchase_notes: book?.purchase_notes ?? '',
  }));

  function set(key, val) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  // Mirror the backend safe-link rule: empty is fine; a non-empty URL must be
  // http/https/mailto/www or the save button is disabled with a hint.
  const purchaseUrlTrimmed = form.purchase_url.trim();
  const purchaseUrlInvalid = !!purchaseUrlTrimmed && !normalizeSafeUrl(purchaseUrlTrimmed);

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.title.trim() || purchaseUrlInvalid) return;
    // Coerce numeric fields; blank total_pages → null (unknown length).
    const payload = {
      title:          form.title.trim(),
      author:         form.author.trim(),
      total_pages:    form.total_pages === '' ? null : Math.max(0, parseInt(form.total_pages, 10) || 0),
      current_page:   Math.max(0, parseInt(form.current_page, 10) || 0),
      status:         form.status,
      started_at:     form.started_at || null,
      finished_at:    form.finished_at || null,
      notes:          form.notes,
      priority:       form.priority,
      to_buy:         form.to_buy,
      purchase_url:   purchaseUrlTrimmed,
      purchase_notes: form.purchase_notes,
    };
    onSave(payload);
  }

  const kicker = isEdit
    ? (form.to_buy ? 'Book Details · To Buy' : 'Book Details')
    : (form.to_buy ? 'Add Book to Buy' : 'Add Book');

  return (
    <div className="task-modal-overlay" onClick={onClose}>
      <div className="task-modal-shell" onClick={(e) => e.stopPropagation()}>
        <div className="task-modal-header">
          <div className="task-modal-header-left">
            <div className="task-modal-kicker">{kicker}</div>
            <div className="task-modal-title">{isEdit ? (book.title || 'Untitled') : 'New book'}</div>
            <div className="task-modal-subtitle">
              {form.to_buy ? 'reading wishlist · priority · purchase link' : 'reading sheet · current page · progress'}
            </div>
          </div>
          <button className="task-modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form className="task-modal-body" onSubmit={handleSubmit}>
          <div className="task-modal-section">
            <div className="task-modal-section-title">Book</div>
            <div className="task-modal-grid">
              <div className="task-modal-field task-modal-field--full">
                <label className="task-modal-label">Where it lives</label>
                <div className="task-modal-seg" role="group" aria-label="Library or to-buy">
                  <button type="button"
                    className={`task-modal-seg-btn${!form.to_buy ? ' task-modal-seg-btn--active' : ''}`}
                    onClick={() => set('to_buy', false)}>
                    In library
                  </button>
                  <button type="button"
                    className={`task-modal-seg-btn${form.to_buy ? ' task-modal-seg-btn--active' : ''}`}
                    onClick={() => set('to_buy', true)}>
                    To buy
                  </button>
                </div>
                {isEdit && !!book.to_buy && !form.to_buy && (
                  <div className="task-modal-field-hint">
                    Saving marks this book bought — it moves to the library as an unread book.
                  </div>
                )}
              </div>
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
              <div className="task-modal-field task-modal-field--full">
                <label className="task-modal-label">
                  Priority <span className="task-modal-priority-val">{PRIORITY_LABELS[form.priority]}</span>
                </label>
                <div className="task-modal-seg rd-priority-seg" role="group" aria-label="Book priority">
                  {[1, 2, 3, 4, 5].map((p) => (
                    <button key={p} type="button"
                      className={`task-modal-seg-btn rd-pri-seg-${p}${form.priority === p ? ' task-modal-seg-btn--active' : ''}`}
                      title={PRIORITY_LABELS[p]}
                      onClick={() => set('priority', p)}>
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              {!form.to_buy && (
                <>
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
                </>
              )}
            </div>
          </div>

          {form.to_buy ? (
            <div className="task-modal-section">
              <div className="task-modal-section-title">Purchase</div>
              <div className="task-modal-grid">
                <div className="task-modal-field task-modal-field--full">
                  <label className="task-modal-label" htmlFor="rb-purl">Purchase link</label>
                  <input id="rb-purl" className="task-modal-input" value={form.purchase_url}
                    onChange={(e) => set('purchase_url', e.target.value)}
                    placeholder="https://… (optional)" />
                  {purchaseUrlInvalid && (
                    <div className="insert-link-error">Use http, https, mailto, or www links.</div>
                  )}
                </div>
                <div className="task-modal-field task-modal-field--full">
                  <label className="task-modal-label" htmlFor="rb-pnotes">Why / notes</label>
                  <input id="rb-pnotes" className="task-modal-input" value={form.purchase_notes}
                    onChange={(e) => set('purchase_notes', e.target.value)}
                    placeholder="recommended by…, edition, price… (optional)" />
                </div>
              </div>
            </div>
          ) : (
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
          )}

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
                  <button type="submit" className="task-modal-save" disabled={!form.title.trim() || purchaseUrlInvalid}>
                    {isEdit ? 'Save Changes' : (form.to_buy ? 'Add to Buy List' : 'Add Book')}
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
