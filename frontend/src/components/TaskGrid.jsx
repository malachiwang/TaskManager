import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  fetchTasks,
  fetchCompletions,
  upsertCompletion,
  deleteCompletion,
  setCompletionCount,
  createTask,
  updateTask,
  createArchive,
  buildExportSheetUrl,
} from '../api.js';
import TaskRow from './TaskRow.jsx';
import TaskModal from './TaskModal.jsx';
import EditBar from './EditBar.jsx';

function toLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Builds an array of ISO date strings for every day in the given calendar month.
// Future modes (Rolling 30, Custom Range) can replace or extend this function.
function buildMonthRange(year, month) {
  const dates = [];
  const d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) {
    dates.push(toLocalDate(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function dateLabel(isoDate) {
  const [y, m, day] = isoDate.split('-').map(Number);
  const d = new Date(y, m - 1, day);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Returns a label like "May 1 – May 31, 2026" for the toolbar.
function monthRangeLabel(year, month) {
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0); // day 0 of next month = last day of this month
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(first)} – ${fmt(last)}, ${year}`;
}

export default function TaskGrid() {
  // Real today — always fixed regardless of which month is displayed.
  const todayStr = toLocalDate(new Date());

  // Currently displayed month. Shape is { year, month } (month is 1-indexed).
  // Future modes (Rolling 30, Custom Range) can extend this state shape.
  const [viewMonth, setViewMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });

  // Derive the full date array from the selected month.
  const dates = useMemo(
    () => buildMonthRange(viewMonth.year, viewMonth.month),
    [viewMonth.year, viewMonth.month],
  );

  const [tasks, setTasks] = useState([]);
  const [completions, setCompletions] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Modal: closed when modalOpen=false. editingTask=null → add mode; task obj → edit mode.
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState(null);

  // Selected date cell for the EditBar.
  const [selectedCell, setSelectedCell] = useState(null);

  // Fetch tasks and completions for the visible date range.
  // Re-runs automatically when `dates` changes (i.e. when the month changes).
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
  // Completion cell handlers
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

  const handleSelect = useCallback((taskId, date) => {
    setSelectedCell({ taskId, date });
  }, []);

  const handleSetCount = useCallback(async (taskId, date, count) => {
    try {
      const result = await setCompletionCount(taskId, date, count);
      if (result.deleted) {
        setCompletions((prev) => {
          const next = { ...prev };
          delete next[`${taskId}:${date}`];
          return next;
        });
      } else {
        setCompletions((prev) => ({
          ...prev,
          [`${taskId}:${date}`]: result.completion_count,
        }));
      }
    } catch (e) {
      console.error('setCount failed:', e);
    }
  }, []);

  // Archive is named by selected month (e.g. "2026-05") so it is stable
  // regardless of what day the button is clicked.
  async function handleArchive() {
    const name = `${viewMonth.year}-${String(viewMonth.month).padStart(2, '0')}`;
    try {
      await createArchive(name, dates[0], dates[dates.length - 1]);
    } catch (e) {
      console.error('archive failed:', e);
    }
  }

  // -------------------------------------------------------------------------
  // Month navigation
  // -------------------------------------------------------------------------

  function goToPrevMonth() {
    setViewMonth(({ year, month }) =>
      month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 },
    );
    setSelectedCell(null);
  }

  function goToNextMonth() {
    setViewMonth(({ year, month }) =>
      month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 },
    );
    setSelectedCell(null);
  }

  function goToCurrentMonth() {
    const now = new Date();
    setViewMonth({ year: now.getFullYear(), month: now.getMonth() + 1 });
    setSelectedCell(null);
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
        <div className="range-nav">
          <button className="range-btn" onClick={goToPrevMonth}>← Prev</button>
          <button className="range-btn" onClick={goToCurrentMonth}>Current</button>
          <button className="range-btn" onClick={goToNextMonth}>Next →</button>
          <span className="range-label">{monthRangeLabel(viewMonth.year, viewMonth.month)}</span>
        </div>
      </div>

      <EditBar
        selectedCell={selectedCell}
        tasks={tasks}
        completions={completions}
        todayStr={todayStr}
        onIncrement={handleIncrement}
        onClear={handleClear}
        onSetCount={handleSetCount}
      />

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
                selectedCell={selectedCell}
                onIncrement={handleIncrement}
                onClear={handleClear}
                onEdit={openEdit}
                onTogglePause={handleTogglePause}
                onSelect={handleSelect}
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
