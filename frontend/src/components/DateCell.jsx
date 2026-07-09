import { useRef } from 'react';

// A single date-grid cell.
//
// Interaction model (P2.0A, extended P10.0):
//   click cell body    → select/focus cell only — no data mutation
//   click dc-box       → explicit increment (POST /completions)
//   shift+click        → extend rectangular range selection from the anchor
//                        cell (never toggles/increments)
//   alt/option+click   → select only, even on the dc-box action zone
//   drag across cells  → rectangular range selection (handled by TaskGrid)
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
// Text override mode (P9.1/P10.0): when overrideText !== undefined this exact
// task/date cell is a plain-text cell instead of a checkbox. Any completion
// count is hidden (never deleted) while the override exists. Double-click (or
// typing / Enter via the grid handler / EditBar) opens an inline editor;
// Enter/blur commit, Escape cancels. Delete/Backspace on a selected cell
// converts it to a blank text cell (TaskGrid owns that logic). A cell can
// also be in edit mode before any override exists — typing into a checkbox
// cell seeds the editor (overrideEditSeed) and only commits on Enter/blur.

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
  isInRange,
  hasNote,
  noteText,
  overrideText,
  isEditingOverride,
  overrideEditSeed,
  onIncrement,
  onSelect,
  onExtendRange,
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

  // Cell body click: select only (shift extends the range). No data mutation.
  function handleCellClick(e) {
    if (e.shiftKey) {
      onExtendRange(taskId, date);
    } else {
      onSelect(taskId, date);
    }
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
  // Shift = range selection, Alt/Option = select-without-toggle — both are
  // handled by the bubbled cell click and must never increment.
  function handleBoxClick(e) {
    if (isDisabled || e.shiftKey || e.altKey || e.metaKey) return;
    onIncrement(taskId, date);
  }

  function renderContent() {
    // Inline editor — active for existing text cells AND for checkbox cells
    // being converted by typing (seeded edit; no override exists until commit).
    if (isEditingOverride && !isDisabled) {
      return (
        <input
          className="dc-text-input"
          defaultValue={overrideEditSeed ?? overrideText ?? ''}
          autoFocus
          onFocus={(e) => {
            const len = e.target.value.length;
            e.target.setSelectionRange(len, len);
          }}
          onKeyDown={handleOverrideKeyDown}
          onBlur={handleOverrideBlur}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Text for ${date}`}
        />
      );
    }

    // Text override mode (P9.1) — replaces the checkbox for this exact cell.
    // Overrides on disabled cells (future/pre-active/after-end/hiatus) stay
    // visible read-only; editing is only reachable on enabled cells.
    if (isTextOverride) {
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

    // Active filled cell — box is the increment action zone.
    return (
      <span
        className="dc-box dc-box--filled"
        onClick={handleBoxClick}
        role="button"
        tabIndex={-1}
        aria-label={`${count} completion${count !== 1 ? 's' : ''}. Click to add.`}
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
    isInRange          ? 'in-range'      : '',
    hasNote            ? 'has-note'      : '',
    isTextOverride     ? 'text-override' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <td
      className={classes}
      data-dc-task={taskId}
      data-dc-date={date}
      aria-selected={isSelected || isInRange || undefined}
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
