import DateCell from './DateCell.jsx';

// Map urgency value to a CSS class for color coding.
function urgencyClass(urgency) {
  if (urgency >= 8) return 'urg-critical';
  if (urgency >= 6) return 'urg-high';
  if (urgency >= 3) return 'urg-noticeable';
  return 'urg-low';
}

export default function TaskRow({
  task, dates, todayStr, completions, selectedCell, colLayout,
  onIncrement, onClear, onEdit, onTogglePause, onSelect,
}) {
  const isPaused = task.is_paused === 1;

  // Returns inline style for a metadata column cell.
  // Sticky cols get width + left; non-sticky cols get width only.
  function cs(col) {
    const style = { width: colLayout.widths[col] };
    if (colLayout.offsets[col] !== undefined) style.left = colLayout.offsets[col];
    return style;
  }

  return (
    <tr className={isPaused ? 'task-row paused' : 'task-row'}>
      <td className="meta-col col-actions" style={cs('col-actions')}>
        <button
          className="action-btn"
          onClick={() => onEdit(task)}
          title="Edit task"
        >✏</button>
        <button
          className="action-btn"
          onClick={() => onTogglePause(task)}
          title={isPaused ? 'Unpause' : 'Pause'}
        >{isPaused ? '▶' : '⏸'}</button>
      </td>
      <td className={`meta-col col-urg ${isPaused ? '' : urgencyClass(task.urgency)}`} style={cs('col-urg')}>
        {isPaused ? '—' : task.urgency}
      </td>
      <td className="meta-col col-pri" style={cs('col-pri')}>{task.priority}</td>
      <td className="meta-col col-status" style={cs('col-status')}>{task.status}</td>
      <td className="meta-col col-section" style={cs('col-section')}>{task.section || ''}</td>
      <td className="meta-col col-cat" style={cs('col-cat')}>{task.category}</td>
      <td className="meta-col col-task" title={task.name} style={cs('col-task')}>{task.name}</td>
      <td className="meta-col col-sub" title={task.subtask} style={cs('col-sub')}>{task.subtask || ''}</td>
      <td className="meta-col col-freq" style={cs('col-freq')}>{task.interval_days}d</td>
      <td className="meta-col col-days" style={cs('col-days')}>{isPaused ? '—' : task.days_since}</td>
      <td className="meta-col col-notes" title={task.notes} style={cs('col-notes')}>{task.notes || ''}</td>
      {dates.map((date) => {
        const isFuture = date > todayStr;
        const count = completions[`${task.id}:${date}`] || 0;
        return (
          <DateCell
            key={date}
            taskId={task.id}
            date={date}
            count={count}
            isFuture={isFuture}
            isToday={date === todayStr}
            isPaused={isPaused}
            isSelected={selectedCell?.taskId === task.id && selectedCell?.date === date}
            onIncrement={onIncrement}
            onClear={onClear}
            onSelect={onSelect}
          />
        );
      })}
    </tr>
  );
}
