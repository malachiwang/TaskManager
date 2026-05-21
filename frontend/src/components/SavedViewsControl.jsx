import { useState, useEffect, useRef } from 'react';
import {
  loadSavedViews, writeSavedViews,
  buildDefaultName, makeSavedView,
} from '../savedViews.js';
import { FILTER_LABELS } from '../filters.js';
import { GROUP_MODE_LABELS } from '../grouping.js';

function viewSummary(view) {
  const f = FILTER_LABELS[view.filter]        || view.filter;
  const g = GROUP_MODE_LABELS[view.groupMode] || view.groupMode;
  return view.searchQuery ? `${f} · ${g} · "${view.searchQuery}"` : `${f} · ${g}`;
}

export default function SavedViewsControl({
  activeFilter,
  groupMode,
  searchQuery,
  onApplyView,
}) {
  const [open,          setOpen]          = useState(false);
  const [views,         setViews]         = useState(() => loadSavedViews().views);
  const [saveName,      setSaveName]      = useState('');
  const [saveError,     setSaveError]     = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(null); // id of view pending confirm

  const panelRef = useRef(null);
  const btnRef   = useRef(null);

  // Close panel on outside click.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e) {
      if (
        panelRef.current && !panelRef.current.contains(e.target) &&
        btnRef.current   && !btnRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  function handleToggle() {
    if (!open) {
      setSaveName(buildDefaultName(activeFilter, groupMode));
      setSaveError('');
      setDeleteConfirm(null);
    }
    setOpen((v) => !v);
  }

  function handleSave() {
    const trimmed = saveName.trim();
    if (!trimmed) {
      setSaveError('Name required.');
      return;
    }
    if (trimmed.length > 40) {
      setSaveError('Max 40 characters.');
      return;
    }
    const view = makeSavedView({
      name: trimmed,
      filter: activeFilter,
      groupMode,
      searchQuery,
    });
    const data = loadSavedViews();
    data.views = [...data.views, view];
    writeSavedViews(data);
    setViews(data.views);
    setSaveName('');
    setSaveError('');
  }

  function handleApply(view) {
    onApplyView(view);
    setOpen(false);
  }

  function handleDelete(id) {
    if (deleteConfirm !== id) {
      setDeleteConfirm(id);
      return;
    }
    const data = loadSavedViews();
    data.views = data.views.filter((v) => v.id !== id);
    writeSavedViews(data);
    setViews(data.views);
    setDeleteConfirm(null);
  }

  return (
    <div className="ws-views">

      <button
        ref={btnRef}
        type="button"
        className={`ws-views-btn${open ? ' ws-views-btn--open' : ''}`}
        onClick={handleToggle}
        aria-expanded={open}
        aria-haspopup="true"
      >
        Views{views.length > 0 ? ` (${views.length})` : ''} ▾
      </button>

      {open && (
        <div
          ref={panelRef}
          className="ws-views-panel"
          role="dialog"
          aria-label="Saved views"
        >

          {/* ── Save current view ── */}
          <div className="ws-views-save">
            <div className="ws-views-head">Save current view</div>
            <div className="ws-views-save-row">
              <input
                type="text"
                className="ws-views-input"
                value={saveName}
                maxLength={40}
                placeholder="View name…"
                autoFocus
                onChange={(e) => { setSaveName(e.target.value); setSaveError(''); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter')  handleSave();
                  if (e.key === 'Escape') setOpen(false);
                }}
              />
              <button
                type="button"
                className="ws-views-save-btn"
                onClick={handleSave}
              >
                Save
              </button>
            </div>
            {saveError && <div className="ws-views-error">{saveError}</div>}
            <div className="ws-views-meta">
              {FILTER_LABELS[activeFilter] || activeFilter}
              {' · '}
              {GROUP_MODE_LABELS[groupMode] || groupMode}
              {searchQuery ? ` · "${searchQuery}"` : ''}
            </div>
          </div>

          {/* ── Saved views list ── */}
          {views.length === 0 ? (
            <div className="ws-views-empty">
              No saved views. Save the current configuration to get started.
            </div>
          ) : (
            <div className="ws-views-list">
              <div className="ws-views-head">Saved views</div>
              {views.map((view) => (
                <div key={view.id} className="ws-views-item">
                  <div className="ws-views-item-info">
                    <span className="ws-views-name">{view.name}</span>
                    <span className="ws-views-meta">{viewSummary(view)}</span>
                  </div>
                  <div className="ws-views-actions">
                    <button
                      type="button"
                      className="ws-views-action-btn"
                      onClick={() => handleApply(view)}
                    >
                      Apply
                    </button>
                    <button
                      type="button"
                      className={`ws-views-action-btn ws-views-action-btn--del${deleteConfirm === view.id ? ' ws-views-action-btn--confirm' : ''}`}
                      onClick={() => handleDelete(view.id)}
                    >
                      {deleteConfirm === view.id ? 'Confirm?' : '×'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

        </div>
      )}

    </div>
  );
}
