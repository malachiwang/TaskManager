import { useRef } from 'react';

// A single date-grid cell.
//
// Interaction model (P2.0A):
//   click cell body  → select/focus cell only — no data mutation
//   click dc-box     → explicit increment (POST /completions)
//   shift+click dc-box → clear completion count (DELETE /completions)
//   future / before-active / after-end → disabled; dc-box display only
//   paused → disabled; existing counts shown muted, no interaction
//
// Display:
//   count 0, active   → dc-box--empty  (15×15 border outline)
//   count 0, disabled → blank
//   count 1           → dc-box--filled (neutral ink, white ✓, 15×15)
//   count 2+          → dc-box--filled (neutral ink, white number, 15×15)
//   paused + count    → dc-box--filled dc-box--muted (muted color, no interaction)
//
// Text override mode (P9.1): when overrideText !== undefined this exact
// task/date cell is a plain-text cell instead of a checkbox. Any completion
// count is hidden (never deleted) while the override exists. Double-click (or
// Enter via the grid handler / EditBar) opens an inline editor; Enter/blur
// commit, Escape cancels. All checkbox behavior above is untouched for cells
// without an override.

export default function DateCell({
  taskId,
  date,
  count,
  isFuture,
  isToday,
  isPaused,
  activeFrom,
  endDate,
  isSelected,
  isArmed,
  hasNote,
  noteText,
  overrideText,
  isEditingOverride,
  onIncrement,
  onClear,
  onSelect,
  onStartOverrideEdit,
  onCommitOverrideText,
  onCancelOverrideEdit,
}) {
  const isBeforeActiveFrom = !!(activeFrom && date < activeFrom);
  const isAfterEndDate = !!(endDate && date > endDate);
  const isDisabled = isFuture || isPaused || isBeforeActiveFrom || isAfterEndDate;
  const isTextOverride = overrideText !== undefined;
  // Set when Enter/Escape already handled the edit, so the input's unmount
  // blur does not double-commit (or commit a cancelled edit).
  const overrideCancelledRef = useRef(false);

  // Detect weekend (Saturday=6, Sunday=0) from ISO date string.
  const [wy, wm, wd] = date.split('-').map(Number);
  const isWeekend = new Date(wy, wm - 1, wd).getDay() % 6 === 0;

  // Cell body click: select only. No data mutation.
  function handleCellClick() {
    onSelect(taskId, date);
  }

  // Text-override cells: double-click opens the inline editor (disabled cells
  // keep their text visible but read-only).
  function handleCellDoubleClick() {
    if (isTextOverride && !isDisabled) onStartOverrideEdit(taskId, date);
  }

  function handleOverrideKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      overrideCancelledRef.current = true; // suppress the follow-up blur commit
      onCommitOverrideText(taskId, date, e.target.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      overrideCancelledRef.current = true;
      onCancelOverrideEdit();
    }
  }

  function handleOverrideBlur(e) {
    if (overrideCancelledRef.current) {
      overrideCancelledRef.current = false;
      return;
    }
    onCommitOverrideText(taskId, date, e.target.value);
  }

  // dc-box click: explicit completion action.
  // Bubbles up to <td> so the cell also becomes selected as a side effect.
  function handleBoxClick(e) {
    if (isDisabled) return;
    if (e.shiftKey) {
      if (count > 0) onClear(taskId, date);
    } else {
      onIncrement(taskId, date);
    }
  }

  function renderContent() {
    // Text override mode (P9.1) — replaces the checkbox for this exact cell.
    // Overrides on disabled cells (future/pre-active/after-end/hiatus) stay
    // visible read-only; editing is only reachable on enabled cells.
    if (isTextOverride) {
      if (isEditingOverride && !isDisabled) {
        return (
          <input
            className="dc-text-input"
            defaultValue={overrideText}
            autoFocus
            onKeyDown={handleOverrideKeyDown}
            onBlur={handleOverrideBlur}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Text for ${date}`}
          />
        );
      }
      return (
        <span
          className={`dc-text${overrideText ? '' : ' dc-text--empty'}${isDisabled ? ' dc-text--muted' : ''}`}
        >
          {overrideText || '—'}
        </span>
      );
    }

    if (isFuture) return null;

    // Disabled with existing completions — display only, no action.
    if (isPaused || isBeforeActiveFrom || isAfterEndDate) {
      if (count === 0) return null;
      return (
        <span className="dc-box dc-box--filled dc-box--muted">
          {count === 1 ? '✓' : count}
        </span>
      );
    }

    // Active empty cell — box is the increment action zone.
    if (count === 0) {
      return (
        <span
          className="dc-box dc-box--empty"
          onClick={handleBoxClick}
          role="button"
          tabIndex={-1}
          aria-label="Add completion"
        />
      );
    }

    // Active filled cell — box is the increment / shift-clear action zone.
    return (
      <span
        className="dc-box dc-box--filled"
        onClick={handleBoxClick}
        role="button"
        tabIndex={-1}
        aria-label={`${count} completion${count !== 1 ? 's' : ''}. Click to add, Shift+click to clear.`}
      >
        {count === 1 ? '✓' : count}
      </span>
    );
  }

  const classes = [
    'date-cell',
    isFuture           ? 'future'        : '',
    isPaused           ? 'paused'        : '',
    isBeforeActiveFrom ? 'before-active' : '',
    isAfterEndDate     ? 'after-end'     : '',
    isToday && !isFuture ? 'today'       : '',
    isWeekend          ? 'weekend'       : '',
    count > 0 && !isTextOverride && !isPaused && !isBeforeActiveFrom && !isAfterEndDate ? 'has-count' : '',
    isSelected         ? 'selected'      : '',
    isArmed            ? 'armed'         : '',
    hasNote            ? 'has-note'      : '',
    isTextOverride     ? 'text-override' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <td
      className={classes}
      onClick={handleCellClick}
      onDoubleClick={handleCellDoubleClick}
      title={
        isTextOverride
          ? (overrideText || 'Text cell — double-click to edit')
          : hasNote && noteText
            ? noteText
            : isFuture
              ? 'Future date — not available'
              : isBeforeActiveFrom
                ? 'Before active date'
                : isAfterEndDate
                  ? 'After task end date'
                  : isPaused
                    ? 'Task is on hiatus'
                    : date
      }
    >
      <span className="dc-cell-center">
        {renderContent()}
      </span>
    </td>
  );
}
