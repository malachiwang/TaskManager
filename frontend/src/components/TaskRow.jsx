import DateCell from './DateCell.jsx';

// Map urgency value to a CSS class for color coding.
function urgencyClass(urgency) {
  if (urgency >= 8) return 'urg-critical';
  if (urgency >= 6) return 'urg-high';
  if (urgency >= 3) return 'urg-noticeable';
  return 'urg-low';
}

export default function TaskRow({ task, dates, todayStr, completions, onIncrement, onClear }) {
  const isPaused = task.is_paused === 1;

  return (
    <tr className={isPaused ? 'task-row paused' : 'task-row'}>
      <td className={`meta-col col-urg ${isPaused ? '' : urgencyClass(task.urgency)}`}>
        {isPaused ? '—' : task.urgency}
      </td>
      <td className="meta-col col-pri">{task.priority}</td>
      <td className="meta-col col-status">{task.status}</td>
      <td className="meta-col col-cat">{task.category}</td>
      <td className="meta-col col-task" title={task.name}>{task.name}</td>
      <td className="meta-col col-sub" title={task.subtask}>{task.subtask || ''}</td>
      <td className="meta-col col-freq">{task.interval_days}d</td>
      <td className="meta-col col-days">{isPaused ? '—' : task.days_since}</td>
      <td className="meta-col col-notes" title={task.notes}>{task.notes || ''}</td>
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
            onIncrement={onIncrement}
            onClear={onClear}
          />
        );
      })}
    </tr>
  );
}
