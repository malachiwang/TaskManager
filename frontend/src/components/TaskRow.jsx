import DateCell from './DateCell.jsx';

// Map urgency value to a CSS class for color coding.
function urgencyClass(urgency) {
  if (urgency >= 8) return 'urg-critical';
  if (urgency >= 6) return 'urg-high';
  if (urgency >= 3) return 'urg-noticeable';
  return 'urg-low';
}

export default function TaskRow({
  task, dates, todayStr, completions, notes, selectedCell, colLayout,
  onIncrement, onClear, onEdit, onSelect,
}) {
  const isPaused = task.is_paused === 1;
  const isScheduled = task.is_scheduled === true;
  const isOverdue =
    !isPaused &&
    !isScheduled &&
    task.days_since != null &&
    task.interval_days != null &&
    task.days_since >= task.interval_days;

  // Returns inline style for a metadata column cell.
  // minWidth + maxWidth = width enforces the cell against table layout compression.
  // Sticky cols additionally get left; non-sticky cols get width constraints only.
  function cs(col) {
    const w = colLayout.widths[col];
    const style = { width: w, minWidth: w, maxWidth: w };
    if (colLayout.offsets[col] !== undefined) style.left = colLayout.offsets[col];
    return style;
  }

  const rowClass = ['task-row', isPaused ? 'paused' : '', isScheduled ? 'scheduled' : '']
    .filter(Boolean).join(' ');

  return (
    <tr className={rowClass}>
      <td className="meta-col sticky-col col-actions" style={cs('col-actions')}>
        <button
          className="action-btn"
          onClick={() => onEdit(task)}
          title="Edit task"
        >✏</button>
      </td>
      <td className={`meta-col sticky-col col-urg ${isPaused || isScheduled ? '' : urgencyClass(task.urgency)}`} style={cs('col-urg')}>
        {isPaused || isScheduled ? '—' : task.urgency}
      </td>
      <td className="meta-col sticky-col col-pri" style={cs('col-pri')}>{task.priority}</td>
      <td className="meta-col sticky-col col-status" style={cs('col-status')}>{task.status}</td>
      <td className="meta-col sticky-col col-active-from" style={cs('col-active-from')}>{task.active_from || ''}</td>
      <td className="meta-col sticky-col col-cat" style={cs('col-cat')}>{task.category}</td>
      <td className="meta-col sticky-col col-task" title={task.name} style={cs('col-task')}>{task.name}</td>
      <td className="meta-col sticky-col col-sub" title={task.subtask} style={cs('col-sub')}>{task.subtask || ''}</td>
      <td className="meta-col scroll-meta-col col-freq" style={cs('col-freq')}>{task.interval_days}d</td>
      <td className={`meta-col scroll-meta-col col-days${isOverdue ? ' days-overdue' : ''}`} style={cs('col-days')}>{isPaused || isScheduled ? '—' : task.days_since}</td>
      <td className="meta-col scroll-meta-col col-notes" title={task.notes} style={cs('col-notes')}>{task.notes || ''}</td>
      {dates.map((date) => {
        const isFuture = date > todayStr;
        const count = completions[`${task.id}:${date}`] || 0;
        const noteKey = `${task.id}:${date}`;
        const hasNote = !!notes[noteKey];
        const noteText = notes[noteKey] || '';
        return (
          <DateCell
            key={date}
            taskId={task.id}
            date={date}
            count={count}
            isFuture={isFuture}
            isToday={date === todayStr}
            isPaused={isPaused}
            activeFrom={task.active_from || null}
            isSelected={selectedCell?.taskId === task.id && selectedCell?.date === date}
            hasNote={hasNote}
            noteText={noteText}
            onIncrement={onIncrement}
            onClear={onClear}
            onSelect={onSelect}
          />
        );
      })}
    </tr>
  );
}
