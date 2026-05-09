import { useState, useEffect, useCallback } from 'react';
import {
  fetchTasks,
  fetchCompletions,
  upsertCompletion,
  deleteCompletion,
  createTask,
  updateTask,
  createArchive,
  buildExportSheetUrl,
} from '../api.js';
import TaskRow from './TaskRow.jsx';
import TaskModal from './TaskModal.jsx';

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

function dateLabel(isoDate) {
  const [y, m, day] = isoDate.split('-').map(Number);
  const d = new Date(y, m - 1, day);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function TaskGrid() {
  const [dates] = useState(buildDateRange);
  const todayStr = dates[7];

  const [tasks, setTasks] = useState([]);
  const [completions, setCompletions] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Modal: closed when modalOpen=false. editingTask=null → add mode; task obj → edit mode.
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState(null);

  // Fetch tasks and completions. Called on mount and after every mutation.
  const loadData = useCallback(() => {
    const start = dates[0];
    const end = dates[dates.length - 1];
    return Promise.all([fetchTasks(), fetchCompletions(start, end)])
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

  useEffect(() => {
    loadData();
  }, [loadData]);

  // -------------------------------------------------------------------------
  // Completion cell handlers (unchanged from Ticket 3)
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Task management handlers
  // -------------------------------------------------------------------------

  function openAdd() {
    setEditingTask(null);
    setModalOpen(true);
  }

  function openEdit(task) {
    setEditingTask(task);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingTask(null);
  }

  async function handleSave(fields) {
    try {
      if (editingTask) {
        await updateTask(editingTask.id, fields);
      } else {
        await createTask(fields);
      }
      closeModal();
      await loadData();
    } catch (e) {
      console.error('save failed:', e);
    }
  }

  async function handleTogglePause(task) {
    try {
      await updateTask(task.id, { is_paused: !task.is_paused });
      await loadData();
    } catch (e) {
      console.error('pause toggle failed:', e);
    }
  }

  async function handleArchive() {
    const name = `${todayStr}`;
    try {
      await createArchive(name, dates[0], dates[dates.length - 1]);
    } catch (e) {
      console.error('archive failed:', e);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (loading) return <div className="grid-status">Loading…</div>;
  if (error) return (
    <div className="grid-status error">
      Error: {error}<br />
      Is the backend running? <code>uvicorn backend.main:app --reload</code>
    </div>
  );

  return (
    <>
      <div className="grid-toolbar">
        <button className="btn-add-task" onClick={openAdd}>+ Add Task</button>
        <button className="btn-archive-sheet" onClick={handleArchive}>Archive Current Sheet</button>
        <a
          className="btn-archive-sheet"
          href={buildExportSheetUrl(dates[0], dates[dates.length - 1])}
          download
        >Export Sheet CSV</a>
      </div>

      <div className="grid-wrapper">
        <table className="task-grid">
          <thead>
            <tr>
              <th className="meta-col col-actions"></th>
              <th className="meta-col col-urg" title="Urgency">Urg</th>
              <th className="meta-col col-pri" title="Priority">P</th>
              <th className="meta-col col-status">Status</th>
              <th className="meta-col col-section">Section</th>
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
                onEdit={openEdit}
                onTogglePause={handleTogglePause}
              />
            ))}
          </tbody>
        </table>

        {tasks.length === 0 && (
          <div className="grid-status">
            No tasks found. Click <strong>+ Add Task</strong> or run{' '}
            <code>python -m backend.seed</code> to add sample data.
          </div>
        )}
      </div>

      {modalOpen && (
        <TaskModal
          task={editingTask}
          onSave={handleSave}
          onClose={closeModal}
        />
      )}
    </>
  );
}
