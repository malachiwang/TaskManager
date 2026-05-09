// A single date-grid cell.
//
// Behavior:
//   click           → increment completion count (POST /completions)
//   shift+click     → clear completion count (DELETE /completions)
//   future or paused → disabled, no interaction
//
// Display:
//   count 0  → blank
//   count 1  → ✓
//   count 2+ → number

export default function DateCell({
  taskId,
  date,
  count,
  isFuture,
  isToday,
  isPaused,
  isSelected,
  onIncrement,
  onClear,
  onSelect,
}) {
  const isDisabled = isFuture || isPaused;

  // Detect weekend (Saturday=6, Sunday=0) from ISO date string.
  const [wy, wm, wd] = date.split('-').map(Number);
  const isWeekend = new Date(wy, wm - 1, wd).getDay() % 6 === 0;

  function display() {
    if (count === 0) return '';
    if (count === 1) return '✓';
    return String(count);
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
    isFuture ? 'future' : '',
    isToday && !isFuture ? 'today' : '',
    isWeekend ? 'weekend' : '',
    count > 0 && !isPaused ? 'has-count' : '',
    isSelected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <td
      className={classes}
      onClick={handleClick}
      title={isDisabled ? (isFuture ? 'Future date — not available' : 'Task is paused') : date}
    >
      {display()}
    </td>
  );
}
