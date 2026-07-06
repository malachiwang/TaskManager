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
  onIncrement,
  onClear,
  onSelect,
}) {
  const isBeforeActiveFrom = !!(activeFrom && date < activeFrom);
  const isAfterEndDate = !!(endDate && date > endDate);
  const isDisabled = isFuture || isPaused || isBeforeActiveFrom || isAfterEndDate;

  // Detect weekend (Saturday=6, Sunday=0) from ISO date string.
  const [wy, wm, wd] = date.split('-').map(Number);
  const isWeekend = new Date(wy, wm - 1, wd).getDay() % 6 === 0;

  // Cell body click: select only. No data mutation.
  function handleCellClick() {
    onSelect(taskId, date);
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
    count > 0 && !isPaused && !isBeforeActiveFrom && !isAfterEndDate ? 'has-count' : '',
    isSelected         ? 'selected'      : '',
    isArmed            ? 'armed'         : '',
    hasNote            ? 'has-note'      : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <td
      className={classes}
      onClick={handleCellClick}
      title={
        hasNote && noteText
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
