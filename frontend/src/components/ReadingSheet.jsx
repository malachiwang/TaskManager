import { useState, useEffect, useCallback } from 'react';
import {
  fetchReadingBooks,
  createReadingBook,
  updateReadingBook,
  deleteReadingBook,
  createReadingEntry,
  fetchReadingEntries,
} from '../api.js';
import ReadingBookModal from './ReadingBookModal.jsx';

const STATUS_LABELS = { active: 'Active', finished: 'Finished', archived: 'Archived' };
const FILTERS = [
  { key: 'active',   label: 'Active' },
  { key: 'finished', label: 'Finished' },
  { key: 'archived', label: 'Archived' },
  { key: 'all',      label: 'All' },
];
const STALE_DAYS = 21; // subtle "not updated recently" indicator threshold

function getToday() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// Compact checkpoint/updated date: M/D for the current year, M/D/YY otherwise.
function formatDate(iso) {
  if (!iso) return '?';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const cur = new Date().getFullYear();
  return y === cur ? `${m}/${d}` : `${m}/${d}/${String(y).slice(2)}`;
}

export default function ReadingSheet() {
  const [books, setBooks] = useState([]);
  const [entriesByBook, setEntriesByBook] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('active');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingBook, setEditingBook] = useState(null);

  // Inline checkpoint entry state (which book row is adding, + draft values).
  const [addingFor, setAddingFor] = useState(null);
  const [draftPage, setDraftPage] = useState('');
  const [draftDate, setDraftDate] = useState(getToday());

  const load = useCallback(() => {
    setLoading(true);
    fetchReadingBooks()
      .then(async (rows) => {
        setBooks(rows);
        const pairs = await Promise.all(
          rows.map((b) =>
            fetchReadingEntries(b.id).then((e) => [b.id, e]).catch(() => [b.id, []]),
          ),
        );
        setEntriesByBook(Object.fromEntries(pairs));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = books.filter((b) => filter === 'all' || b.status === filter);
  const counts = books.reduce((acc, b) => { acc[b.status] = (acc[b.status] || 0) + 1; return acc; }, {});

  function replaceBook(updated) {
    setBooks((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
  }

  // Log a page checkpoint (current page reached on a date). Updates current_page
  // via the returned book and refreshes that book's checkpoint strip.
  function logCheckpoint(bookId, page, entryDate) {
    const val = parseInt(page, 10);
    if (Number.isNaN(val)) return Promise.resolve();
    return createReadingEntry(bookId, Math.max(0, val), { entry_date: entryDate || null })
      .then((updatedBook) => {
        replaceBook(updatedBook);
        return fetchReadingEntries(bookId).then((e) =>
          setEntriesByBook((prev) => ({ ...prev, [bookId]: e })),
        );
      })
      .catch((e) => console.error('log checkpoint failed:', e));
  }

  // Current-page input commit → today's checkpoint (only when it changed).
  function commitPage(book, raw) {
    const val = parseInt(raw, 10);
    if (Number.isNaN(val) || val === book.current_page) return;
    logCheckpoint(book.id, val, getToday());
  }

  function startAdd(bookId) { setAddingFor(bookId); setDraftPage(''); setDraftDate(getToday()); }
  function cancelAdd() { setAddingFor(null); setDraftPage(''); }
  function submitCheckpoint(bookId) {
    if (draftPage === '') { cancelAdd(); return; }
    logCheckpoint(bookId, draftPage, draftDate).then(cancelAdd);
  }

  function changeStatus(book, status) {
    updateReadingBook(book.id, { status }).then(replaceBook).catch((e) => console.error(e));
  }

  function openAdd() { setEditingBook(null); setModalOpen(true); }
  function openEdit(book) { setEditingBook(book); setModalOpen(true); }
  function closeModal() { setModalOpen(false); setEditingBook(null); }

  async function handleSave(fields) {
    try {
      if (editingBook) await updateReadingBook(editingBook.id, fields);
      else await createReadingBook(fields);
      closeModal();
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleDelete(id) {
    try { await deleteReadingBook(id); } catch (e) { console.error(e); }
    finally { closeModal(); load(); }
  }

  if (loading) return <div className="grid-status">Loading…</div>;
  if (error) return (
    <div className="grid-status error">
      Error: {error}<br />Is the backend running?
    </div>
  );

  return (
    <>
      <div className="ws-grid-shelf">
        <div className="ws-shelf-left">
          <button className="ws-shelf-btn ws-shelf-btn--primary" onClick={openAdd}>+ Add Book</button>
        </div>
      </div>

      <div className="ws-sheet-header">
        <div className="ws-sheet-header-left">
          <div className="ws-sheet-title">Reading</div>
          <div className="ws-sheet-meta">
            <span>{counts.active || 0} active</span>
            <span className="ws-meta-sep">·</span>
            <span>{counts.finished || 0} finished</span>
            <span className="ws-meta-sep">·</span>
            <span>{counts.archived || 0} archived</span>
          </div>
        </div>
      </div>

      <div className="ws-filter-bar">
        <div className="ws-filter-pills">
          {FILTERS.map((f) => (
            <button key={f.key}
              className={`ws-filter-pill${filter === f.key ? ' ws-filter-pill--active' : ''}`}
              onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="ws-grid-canvas">
        <div className="grid-wrapper">
          <table className="reading-grid">
            <thead>
              <tr>
                <th className="rd-col-title">Title</th>
                <th className="rd-col-author">Author</th>
                <th className="rd-col-page">Current Page</th>
                <th className="rd-col-total">Total</th>
                <th className="rd-col-progress">Progress</th>
                <th className="rd-col-updated">Last Updated</th>
                <th className="rd-col-status">Status</th>
                <th className="rd-col-actions"></th>
                <th className="rd-col-checkpoints">Checkpoints (page, date)</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((book) => {
                const pct = book.percent_complete;
                const stale = book.status === 'active' && book.days_since_update != null && book.days_since_update >= STALE_DAYS;
                const entries = entriesByBook[book.id] || [];
                return (
                  <tr key={book.id} className={`reading-row status-${book.status}`}>
                    <td className="rd-col-title" title={book.title}>{book.title}</td>
                    <td className="rd-col-author" title={book.author}>{book.author || '—'}</td>
                    <td className="rd-col-page">
                      <input
                        key={book.current_page}
                        type="number"
                        min="0"
                        className="rd-page-input"
                        defaultValue={book.current_page}
                        title="Current page — updates progress and logs today's checkpoint"
                        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                        onBlur={(e) => commitPage(book, e.target.value)}
                      />
                    </td>
                    <td className="rd-col-total">{book.total_pages ?? '—'}</td>
                    <td className="rd-col-progress">
                      {pct != null ? (
                        <div className="rd-progress" title={`${pct}% · ${book.pages_remaining} pages left`}>
                          <div className="rd-progress-bar"><div className="rd-progress-fill" style={{ width: `${pct}%` }} /></div>
                          <span className="rd-progress-pct">{pct}%</span>
                        </div>
                      ) : (
                        <span className="rd-progress-unknown">—</span>
                      )}
                    </td>
                    <td className={`rd-col-updated${stale ? ' rd-stale' : ''}`} title={stale ? `Not updated in ${book.days_since_update} days` : undefined}>
                      {formatDate(book.last_entry_date || book.updated_at)}
                    </td>
                    <td className="rd-col-status">
                      <span className={`rd-status-badge rd-status-${book.status}`}>{STATUS_LABELS[book.status]}</span>
                    </td>
                    <td className="rd-col-actions">
                      <div className="rd-action-group">
                        <button className="action-btn" onClick={() => openEdit(book)} title="Book details">EDIT</button>
                        {book.status === 'active' && (
                          <button className="action-btn" onClick={() => changeStatus(book, 'finished')} title="Mark finished">FINISH</button>
                        )}
                        {book.status !== 'archived' ? (
                          <button className="action-btn" onClick={() => changeStatus(book, 'archived')} title="Archive (keeps history)">ARCHIVE</button>
                        ) : (
                          <button className="action-btn" onClick={() => changeStatus(book, 'active')} title="Reactivate">UNARCHIVE</button>
                        )}
                      </div>
                    </td>
                    <td className="rd-col-checkpoints">
                      <div className="rd-checkpoints">
                        {entries.map((e) => (
                          <span key={e.id} className="rd-checkpoint" title={`page ${e.page} on ${e.entry_date}${e.note ? ` — ${e.note}` : ''}`}>
                            {e.page}<span className="rd-cp-date">, {formatDate(e.entry_date)}</span>
                          </span>
                        ))}
                        {addingFor === book.id ? (
                          <span className="rd-checkpoint rd-checkpoint-add-form">
                            <input type="number" min="0" className="rd-cp-page" placeholder="page" autoFocus
                              value={draftPage} onChange={(e) => setDraftPage(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') submitCheckpoint(book.id); if (e.key === 'Escape') cancelAdd(); }} />
                            <input type="date" className="rd-cp-dateinput"
                              value={draftDate} onChange={(e) => setDraftDate(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') submitCheckpoint(book.id); if (e.key === 'Escape') cancelAdd(); }} />
                            <button className="rd-cp-save" onClick={() => submitCheckpoint(book.id)} title="Save checkpoint">✓</button>
                            <button className="rd-cp-cancel" onClick={cancelAdd} title="Cancel">×</button>
                          </span>
                        ) : (
                          <button className="rd-checkpoint rd-checkpoint-add" onClick={() => startAdd(book.id)} title="Add a page checkpoint">+</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {books.length === 0 && (
            <div className="grid-status">
              No books yet. Click <strong>+ Add Book</strong> to start tracking your current page.
            </div>
          )}
          {books.length > 0 && visible.length === 0 && (
            <div className="grid-status">No {filter} books.</div>
          )}
        </div>
      </div>

      {modalOpen && (
        <ReadingBookModal
          book={editingBook}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={closeModal}
        />
      )}
    </>
  );
}
