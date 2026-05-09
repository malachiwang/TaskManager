import { useState, useEffect, useCallback } from 'react';
import { fetchTasks, fetchCompletions, upsertCompletion, deleteCompletion } from '../api.js';
import TaskRow from './TaskRow.jsx';

// Returns a local-timezone date string YYYY-MM-DD for a given Date object.
function toLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 14 dates: 7 days before today (index 0–6), today (index 7), 6 days after (index 8–13).
function buildDateRange() {
  const today = new Date();
  const dates = [];
  for (let offset = -7; offset <= 6; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    dates.push(toLocalDate(d));
  }
  return dates;
}

// Short column header label for a date string.
function dateLabel(isoDate) {
  const [y, m, day] = isoDate.split('-').map(Number);
  const d = new Date(y, m - 1, day);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function TaskGrid() {
  // dates is computed once on mount and never changes.
  const [dates] = useState(buildDateRange);
  const todayStr = dates[7]; // index 7 is always today

  const [tasks, setTasks] = useState([]);
  // completions: key "taskId:date" → completion_count
  const [completions, setCompletions] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const start = dates[0];
    const end = dates[dates.length - 1];
    Promise.all([fetchTasks(), fetchCompletions(start, end)])
      .then(([taskList, compList]) => {
        setTasks(taskList);
        const map = {};
        for (const c of compList) {
          map[`${c.task_id}:${c.completion_date}`] = c.completion_count;
        }
        setCompletions(map);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [dates]);

  // Increment count for a cell. Updates state after API confirms.
  const handleIncrement = useCallback(async (taskId, date) => {
    try {
      const result = await upsertCompletion(taskId, date);
      setCompletions((prev) => ({
        ...prev,
        [`${taskId}:${date}`]: result.completion_count,
      }));
    } catch (e) {
      console.error('increment failed:', e);
    }
  }, []);

  // Clear a cell. Removes key from state after API confirms.
  const handleClear = useCallback(async (taskId, date) => {
    try {
      await deleteCompletion(taskId, date);
      setCompletions((prev) => {
        const next = { ...prev };
        delete next[`${taskId}:${date}`];
        return next;
      });
    } catch (e) {
      console.error('clear failed:', e);
    }
  }, []);

  if (loading) return <div className="grid-status">Loading…</div>;
  if (error) return <div className="grid-status error">Error: {error}<br />Is the backend running? <code>uvicorn backend.main:app --reload</code></div>;

  return (
    <div className="grid-wrapper">
      <table className="task-grid">
        <thead>
          <tr>
            <th className="meta-col col-urg" title="Urgency">Urg</th>
            <th className="meta-col col-pri" title="Priority">P</th>
            <th className="meta-col col-status">Status</th>
            <th className="meta-col col-cat">Category</th>
            <th className="meta-col col-task">Task</th>
            <th className="meta-col col-sub">Subtask</th>
            <th className="meta-col col-freq" title="Frequency (days)">Freq</th>
            <th className="meta-col col-days" title="Days since last done">Days</th>
            <th className="meta-col col-notes">Notes</th>
            {dates.map((d) => (
              <th
                key={d}
                className={[
                  'date-col-header',
                  d === todayStr ? 'col-today' : '',
                  d > todayStr ? 'col-future' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {dateLabel(d)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              dates={dates}
              todayStr={todayStr}
              completions={completions}
              onIncrement={handleIncrement}
              onClear={handleClear}
            />
          ))}
        </tbody>
      </table>
      {tasks.length === 0 && (
        <div className="grid-status">
          No tasks found. Run <code>python -m backend.seed</code> to add sample data.
        </div>
      )}
    </div>
  );
}
