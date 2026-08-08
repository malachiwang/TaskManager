import { useEffect, useId, useRef, useState } from 'react';

// TaskDatePicker (P11.1) — themed replacement for native <input type="date">
// in the Task Details modal. Value contract matches the old inputs exactly:
// an ISO 'YYYY-MM-DD' string, or '' when the field is empty.
//
// The text input accepts manual MM/DD/YYYY (or ISO) typing; the ▦ button opens
// a paper-styled calendar popover. All date math works on local calendar
// components — a Date object is only ever built from (y, m, d) parts and read
// back with getFullYear/getMonth/getDate, so no UTC shifting can occur.

export function getLocalTodayIso() {
  const d = new Date();
  return partsToIso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function partsToIso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isoToParts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

function isValidYmd(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(y, m, 0).getDate();
}

// ISO 'YYYY-MM-DD' → 'MM/DD/YYYY' for display. '' passes through.
export function formatDisplayDate(iso) {
  if (!iso) return '';
  const { y, m, d } = isoToParts(iso);
  if (!isValidYmd(y, m, d)) return iso;
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
}

// 'MM/DD/YYYY' (or M/D/YYYY, or ISO) → ISO 'YYYY-MM-DD'. null when the text
// is not a complete valid date — callers keep the last valid value.
export function parseDisplayDate(text) {
  const t = text.trim();
  if (!t) return null;
  let y, m, d;
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (us) { m = +us[1]; d = +us[2]; y = +us[3]; }
  else if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else return null;
  return isValidYmd(y, m, d) ? partsToIso(y, m, d) : null;
}

function addDaysIso(iso, delta) {
  const { y, m, d } = isoToParts(iso);
  const dt = new Date(y, m - 1, d + delta);
  return partsToIso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

// 42 cells (6 weeks, Sunday-start) covering the given view month.
function buildCalendarCells(viewY, viewM) {
  const firstWeekday = new Date(viewY, viewM - 1, 1).getDay();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const dt = new Date(viewY, viewM - 1, 1 - firstWeekday + i);
    cells.push({
      iso: partsToIso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()),
      inMonth: dt.getMonth() === viewM - 1,
    });
  }
  return cells;
}

const POPOVER_WIDTH = 264;
const POPOVER_HEIGHT = 308; // estimate for flip decision only

export default function TaskDatePicker({ id, value, onChange, clearable = true, ariaLabel }) {
  const [draft, setDraft] = useState(null); // non-null while the input is being edited
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(null);   // { y, m } of the visible month
  const [focusDate, setFocusDate] = useState(null); // ISO of keyboard-focused day
  const [pos, setPos] = useState(null);     // fixed-position coords for the popover

  const wrapRef = useRef(null);
  const gridRef = useRef(null);
  const toggleRef = useRef(null);
  const gridId = useId();

  const today = getLocalTodayIso();
  const displayText = draft ?? formatDisplayDate(value);

  // Fixed positioning escapes the modal body's overflow clipping; flip above
  // the field when the viewport below is too short.
  function computePosition() {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8));
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < POPOVER_HEIGHT + 8 && rect.top > spaceBelow) {
      setPos({ left, bottom: window.innerHeight - rect.top + 4 });
    } else {
      setPos({ left, top: rect.bottom + 4 });
    }
  }

  function openPopover() {
    const anchor = value || today;
    const { y, m } = isoToParts(anchor);
    setView({ y, m });
    setFocusDate(anchor);
    computePosition();
    setOpen(true);
  }

  function closePopover(refocusToggle = true) {
    setOpen(false);
    if (refocusToggle) toggleRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    gridRef.current?.focus();

    function onPointerDown(e) {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    }
    const onReposition = () => computePosition();
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close when focus leaves the whole component (Tab out) — no focus trap.
  function handleFocusOut(e) {
    if (!wrapRef.current?.contains(e.relatedTarget)) setOpen(false);
  }

  function selectDate(iso) {
    onChange(iso);
    closePopover();
  }

  function moveView(deltaMonths) {
    setView((v) => {
      const dt = new Date(v.y, v.m - 1 + deltaMonths, 1);
      return { y: dt.getFullYear(), m: dt.getMonth() + 1 };
    });
  }

  function moveFocus(deltaDays) {
    const next = addDaysIso(focusDate ?? today, deltaDays);
    setFocusDate(next);
    const { y, m } = isoToParts(next);
    setView((v) => (v.y === y && v.m === m ? v : { y, m }));
  }

  // On the popover container so it also catches Escape from the nav/footer
  // buttons. stopPropagation keeps the grid's Escape from closing the modal.
  function handlePopoverKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePopover();
    }
  }

  function handleGridKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (focusDate) selectDate(focusDate);
      return;
    }
    const deltas = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in deltas) {
      e.preventDefault();
      moveFocus(deltas[e.key]);
    }
  }

  function handleInputChange(e) {
    const text = e.target.value;
    setDraft(text);
    if (text.trim() === '') {
      onChange('');
      return;
    }
    const iso = parseDisplayDate(text);
    if (iso) onChange(iso);
  }

  function handleInputKeyDown(e) {
    if (e.key === 'ArrowDown' && !open) {
      e.preventDefault();
      openPopover();
      return;
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      closePopover(false);
    }
  }

  const cells = open && view ? buildCalendarCells(view.y, view.m) : [];

  return (
    <div className="tdp" ref={wrapRef} onBlur={handleFocusOut}>
      <div className="tdp-inputrow">
        <input
          id={id}
          className="task-modal-input tdp-input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="MM/DD/YYYY"
          aria-label={ariaLabel}
          value={displayText}
          onChange={handleInputChange}
          onFocus={() => setDraft(formatDisplayDate(value))}
          onBlur={() => setDraft(null)}
          onKeyDown={handleInputKeyDown}
        />
        <button
          ref={toggleRef}
          type="button"
          className="tdp-toggle"
          aria-label={open ? 'Close calendar' : 'Open calendar'}
          aria-expanded={open}
          onClick={() => (open ? closePopover(false) : openPopover())}
        >
          ▦
        </button>
      </div>

      {open && view && pos && (
        <div className="tdp-popover" style={pos} role="dialog" aria-label="Choose date"
          onKeyDown={handlePopoverKeyDown}
          onMouseDown={(e) => e.preventDefault() /* keep focus on the grid so
            inside-clicks never blur-close the popover before they land */}>
          <div className="tdp-head">
            <button type="button" className="tdp-nav" aria-label="Previous month"
              onClick={() => moveView(-1)}>‹</button>
            <span className="tdp-month">{MONTH_NAMES[view.m - 1]} {view.y}</span>
            <button type="button" className="tdp-nav" aria-label="Next month"
              onClick={() => moveView(1)}>›</button>
          </div>

          <div className="tdp-weekdays" aria-hidden="true">
            {WEEKDAY_LABELS.map((w) => <span key={w}>{w}</span>)}
          </div>

          <div
            ref={gridRef}
            id={gridId}
            className="tdp-grid"
            tabIndex={-1}
            role="listbox"
            aria-label="Calendar days"
            aria-activedescendant={focusDate ? `${gridId}-${focusDate}` : undefined}
            onKeyDown={handleGridKeyDown}
          >
            {cells.map((c) => (
              <div
                key={c.iso}
                id={`${gridId}-${c.iso}`}
                role="option"
                aria-selected={c.iso === value}
                className={
                  'tdp-day'
                  + (c.inMonth ? '' : ' tdp-day--outside')
                  + (c.iso === value ? ' tdp-day--selected' : '')
                  + (c.iso === today ? ' tdp-day--today' : '')
                  + (c.iso === focusDate ? ' tdp-day--focus' : '')
                }
                onClick={() => selectDate(c.iso)}
              >
                {isoToParts(c.iso).d}
              </div>
            ))}
          </div>

          <div className="tdp-foot">
            <button type="button" className="tdp-foot-btn" onClick={() => selectDate(today)}>
              Today
            </button>
            {clearable && value && (
              <button type="button" className="tdp-foot-btn" onClick={() => { onChange(''); closePopover(); }}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
