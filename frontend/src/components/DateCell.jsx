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
  onIncrement,
  onClear,
}) {
  const isDisabled = isFuture || isPaused;

  function display() {
    if (count === 0) return '';
    if (count === 1) return '✓';
    return String(count);
  }

  function handleClick(e) {
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
    count > 0 && !isPaused ? 'has-count' : '',
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
