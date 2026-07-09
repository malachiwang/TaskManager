import { useState, useEffect, useRef } from 'react';
import { SECONDARY_FILTERS, FILTER_LABELS } from '../filters.js';

// Compact "Filters ▾" dropdown for the secondary filter toggles (P10.0).
// Active toggles also render as removable chips next to the button, so the
// bar shows at a glance which filters are narrowing the grid.
export default function FilterMenu({ active, onToggle }) {
  const [open, setOpen] = useState(false);
  const btnRef   = useRef(null);
  const panelRef = useRef(null);

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

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const activeCount = active.length;

  return (
    <div className="ws-filter-menu">
      <button
        ref={btnRef}
        type="button"
        className={`ws-filter-menu-btn${open ? ' ws-filter-menu-btn--open' : ''}${activeCount > 0 ? ' ws-filter-menu-btn--active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
      >
        Filters{activeCount > 0 ? ` (${activeCount})` : ''} ▾
      </button>

      {open && (
        <div
          ref={panelRef}
          className="ws-filter-menu-panel"
          role="group"
          aria-label="Secondary filters"
        >
          {SECONDARY_FILTERS.map((f) => (
            <label key={f} className="ws-filter-menu-option">
              <input
                type="checkbox"
                checked={active.includes(f)}
                onChange={() => onToggle(f)}
              />
              <span>{FILTER_LABELS[f]}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
