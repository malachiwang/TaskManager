// A single date-grid cell.
//
// Behavior:
//   click           → increment completion count (POST /completions)
//   shift+click     → clear completion count (DELETE /completions)
//   future or paused → disabled, no interaction
//
// Display:
//   count 0, active   → dc-box--empty  (15×15 border outline)
//   count 0, disabled → blank
//   count 1           → dc-box--filled (neutral ink, white ✓, 15×15)
//   count 2+          → dc-box--filled (neutral ink, white number, 15×15)
//   paused + count    → dc-box--filled dc-box--muted (same size, muted color)

export default function DateCell({
  taskId,
  date,
  count,
  isFuture,
  isToday,
  isPaused,
  isSelected,
  hasNote,
  noteText,
  onIncrement,
  onClear,
  onSelect,
}) {
  const isDisabled = isFuture || isPaused;

  // Detect weekend (Saturday=6, Sunday=0) from ISO date string.
  const [wy, wm, wd] = date.split('-').map(Number);
  const isWeekend = new Date(wy, wm - 1, wd).getDay() % 6 === 0;

  function renderContent() {
    if (isFuture) return null;
    if (isPaused) {
      if (count === 0) return null;
      return (
        <span className="dc-box dc-box--filled dc-box--muted">
          {count === 1 ? '✓' : count}
        </span>
      );
    }
    if (count === 0) return <span className="dc-box dc-box--empty" />;
    return (
      <span className="dc-box dc-box--filled">
        {count === 1 ? '✓' : count}
      </span>
    );
  }

  function handleClick(e) {
    onSelect(taskId, date);
    if (isDisabled) return;
    if (e.shiftKey) {
      if (count > 0) onClear(taskId, date);
    } else {
      onIncrement(taskId, date);
    }
  }

  const classes = [
    'date-cell',
    isFuture  ? 'future'  : '',
    isPaused  ? 'paused'  : '',
    isToday && !isFuture ? 'today' : '',
    isWeekend ? 'weekend' : '',
    count > 0 && !isPaused ? 'has-count' : '',
    isSelected ? 'selected' : '',
    hasNote ? 'has-note' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <td
      className={classes}
      onClick={handleClick}
      title={hasNote && noteText ? noteText : (isDisabled ? (isFuture ? 'Future date — not available' : 'Task is paused') : date)}
    >
      <span className="dc-cell-center">
        {renderContent()}
      </span>
    </td>
  );
}
