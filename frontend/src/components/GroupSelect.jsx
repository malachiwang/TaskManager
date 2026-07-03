import { useState, useEffect, useRef } from 'react';
import { GROUP_MODES, GROUP_MODE_LABELS } from '../grouping.js';

export default function GroupSelect({ value, onChange }) {
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

  function handleSelect(mode) {
    onChange(mode);
    setOpen(false);
    btnRef.current?.focus();
  }

  function handleBtnKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen((v) => !v);
    }
  }

  return (
    <div className="ws-group-ctrl">
      <button
        ref={btnRef}
        type="button"
        className={`ws-group-btn${open ? ' ws-group-btn--open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleBtnKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Group by: ${GROUP_MODE_LABELS[value]}`}
      >
        Group: {GROUP_MODE_LABELS[value]} ▾
      </button>

      {open && (
        <div
          ref={panelRef}
          className="ws-group-panel"
          role="listbox"
          aria-label="Group by"
        >
          {Object.values(GROUP_MODES).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`ws-group-option${value === mode ? ' ws-group-option--active' : ''}`}
              role="option"
              aria-selected={value === mode}
              onClick={() => handleSelect(mode)}
            >
              {GROUP_MODE_LABELS[mode]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
