import { useState, useEffect, useCallback, useMemo, Fragment, useRef } from 'react';
import {
  fetchTasks,
  fetchCompletions,
  upsertCompletion,
  deleteCompletion,
  setCompletionCount,
  createTask,
  updateTask,
  deleteTask,
  createArchive,
  buildExportSheetUrl,
  fetchNotes,
  upsertNote,
} from '../api.js';
import TaskRow from './TaskRow.jsx';
import TaskModal from './TaskModal.jsx';
import EditBar from './EditBar.jsx';
import KeyboardHelp from './KeyboardHelp.jsx';
import { FILTERS, FILTER_LABELS, taskPassesFilter } from '../filters.js';
import { GROUP_MODES, GROUP_MODE_LABELS, groupTasks } from '../grouping.js';
import { matchKeybind, resolveKeybinds } from '../keybinds.js';

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

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

function isWeekendDate(isoDate) {
  const [y, m, day] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, day).getDay() % 6 === 0;
}

// Returns a label like "May 1 – May 31, 2026" for the toolbar.
function monthRangeLabel(year, month) {
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0); // day 0 of next month = last day of this month
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(first)} – ${fmt(last)}, ${year}`;
}

// ---------------------------------------------------------------------------
// Column layout — widths and sticky left offsets
// ---------------------------------------------------------------------------

const LS_KEY = 'taskos-col-widths';
const MIN_COL_WIDTH = 24;

// Default widths (px) matching the original CSS layout.
export const DEFAULT_WIDTHS = {
  'col-actions':     28,
  'col-urg':         40,
  'col-pri':         28,
  'col-status':      62,
  'col-active-from': 72,
  'col-cat':         82,
  'col-task':       150,
  'col-sub':        100,
  'col-freq':        44,
  'col-days':        44,
  'col-notes':      100,
};

// These columns are position:sticky and need cumulative left offsets.
// col-sub (Subtask) is the last frozen column — content scrolls after it.
const STICKY_COLS = [
  'col-actions', 'col-urg', 'col-pri', 'col-status', 'col-active-from', 'col-cat', 'col-task', 'col-sub',
];

// Non-sticky metadata columns — resizable width only, no left offset.
const NON_STICKY_META_COLS = ['col-freq', 'col-days', 'col-notes'];

// Compute { widths, offsets } from current user overrides.
// widths: every meta col → px value
// offsets: sticky cols only → cumulative left offset
function computeColLayout(colWidths) {
  const widths = {};
  const offsets = {};
  let acc = 0;
  for (const col of STICKY_COLS) {
    widths[col] = colWidths[col] ?? DEFAULT_WIDTHS[col];
    offsets[col] = acc;
    acc += widths[col];
  }
  for (const col of NON_STICKY_META_COLS) {
    widths[col] = colWidths[col] ?? DEFAULT_WIDTHS[col];
  }
  return { widths, offsets };
}

// Returns the best default keyboard cell when no cell is selected.
// Fallback order: first non-paused non-scheduled task > first non-paused task > first task.
function getDefaultKeyboardCell(tasks, dates) {
  if (!tasks.length || !dates.length) return null;
  const todayStr = toLocalDate(new Date());
  const task =
    tasks.find((t) => t.is_paused !== 1 && !t.is_scheduled) ??
    tasks.find((t) => t.is_paused !== 1) ??
    tasks[0];
  let date;
  if (dates.includes(todayStr)) {
    date = todayStr;
  } else {
    const nonFuture = dates.filter((d) => d <= todayStr);
    date = nonFuture.length > 0 ? nonFuture[nonFuture.length - 1] : dates[0];
  }
  return { taskId: task.id, date };
}

export default function TaskGrid() {
  // Real today — always fixed regardless of which month is displayed.
  const todayStr = toLocalDate(new Date());

  // Currently displayed month. Shape is { year, month } (1-indexed month).
  // Future modes (Rolling 30, Custom Range) can extend this state shape.
  const [viewMonth, setViewMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });

  // Derive full date array from the selected month.
  const dates = useMemo(
    () => buildMonthRange(viewMonth.year, viewMonth.month),
    [viewMonth.year, viewMonth.month],
  );

  const [tasks, setTasks] = useState([]);
  const [completions, setCompletions] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [selectedCell, setSelectedCell] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);

  // Filtering / search state — Phase 1.
  const [activeFilter, setActiveFilter] = useState(FILTERS.ALL);
  const [searchQuery, setSearchQuery] = useState('');

  // Grouping mode — Phase 3. Persisted to localStorage.
  const [groupMode, setGroupMode] = useState(
    () => localStorage.getItem('taskos-group-mode') || GROUP_MODES.SECTION,
  );

  // Keyboard help panel — P4.
  const [helpOpen, setHelpOpen] = useState(false);

  // Cell notes — P5. Parallel map to completions: `${taskId}:${date}` → string.
  const [notes, setNotes] = useState({});

  // Column widths — stored as user overrides; missing keys fall back to DEFAULT_WIDTHS.
  const [colWidths, setColWidths] = useState(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  // Persist column widths to localStorage on every change.
  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(colWidths));
  }, [colWidths]);

  // Persist groupMode to localStorage.
  useEffect(() => {
    localStorage.setItem('taskos-group-mode', groupMode);
  }, [groupMode]);

  // Derive computed layout (widths + sticky offsets) from overrides.
  const colLayout = useMemo(() => computeColLayout(colWidths), [colWidths]);

  // ---------------------------------------------------------------------------
  // Filtering — applied client-side over the full tasks array.
  // filteredTasks is the source of truth for the rendered grid and keyboard nav.
  // ---------------------------------------------------------------------------

  const filteredTasks = useMemo(() => {
    let result = tasks;
    if (activeFilter !== FILTERS.ALL) {
      result = result.filter((t) => taskPassesFilter(t, activeFilter));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(
        (t) =>
          (t.name    && t.name.toLowerCase().includes(q)) ||
          (t.subtask && t.subtask.toLowerCase().includes(q)) ||
          (t.category && t.category.toLowerCase().includes(q)) ||
          (t.notes   && t.notes.toLowerCase().includes(q)),
      );
    }
    return result;
  }, [tasks, activeFilter, searchQuery]);

  // Group filtered tasks by the current groupMode.
  // groupTasks() suppresses empty groups automatically and computes metadata.
  const groupedTasks = useMemo(
    () => groupTasks(filteredTasks, groupMode),
    [filteredTasks, groupMode],
  );

  // Flat task list in visual render order — used for keyboard navigation.
  // CRITICAL: tasksRef.current must point here, not at filteredTasks.
  const flatGroupedTasks = useMemo(
    () => groupedTasks.flatMap((g) => g.tasks),
    [groupedTasks],
  );

  // ---------------------------------------------------------------------------
  // Data fetching — reruns when month changes (dates reference changes)
  // ---------------------------------------------------------------------------

  const loadData = useCallback(() => {
    const start = dates[0];
    const end = dates[dates.length - 1];
    return Promise.all([fetchTasks(), fetchCompletions(start, end), fetchNotes(start, end)])
      .then(([taskList, compList, noteList]) => {
        setTasks(taskList);
        const map = {};
        for (const c of compList) {
          map[`${c.task_id}:${c.completion_date}`] = c.completion_count;
        }
        setCompletions(map);
        const noteMap = {};
        for (const n of noteList) {
          noteMap[`${n.task_id}:${n.note_date}`] = n.note;
        }
        setNotes(noteMap);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [dates]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Refresh only the tasks array after a completion mutation so that
  // server-computed fields (days_since, urgency) update without a full reload.
  // Completions state is already updated locally from the mutation response,
  // so a full loadData() re-fetch is not needed here.
  const refreshTasks = useCallback(() => {
    fetchTasks()
      .then(setTasks)
      .catch((e) => console.error('refreshTasks failed:', e));
  }, []);

  // ---------------------------------------------------------------------------
  // Completion handlers
  // ---------------------------------------------------------------------------

  const handleIncrement = useCallback(async (taskId, date) => {
    try {
      const result = await upsertCompletion(taskId, date);
      setCompletions((prev) => ({
        ...prev,
        [`${taskId}:${date}`]: result.completion_count,
      }));
      refreshTasks();
    } catch (e) {
      console.error('increment failed:', e);
    }
  }, [refreshTasks]);

  const handleClear = useCallback(async (taskId, date) => {
    try {
      await deleteCompletion(taskId, date);
      setCompletions((prev) => {
        const next = { ...prev };
        delete next[`${taskId}:${date}`];
        return next;
      });
      refreshTasks();
    } catch (e) {
      console.error('clear failed:', e);
    }
  }, [refreshTasks]);

  // ---------------------------------------------------------------------------
  // Task handlers
  // ---------------------------------------------------------------------------

  function openAdd() { setEditingTask(null); setModalOpen(true); }
  function openEdit(task) { setEditingTask(task); setModalOpen(true); }
  function closeModal() { setModalOpen(false); setEditingTask(null); }

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

  async function handleDelete(taskId) {
    try {
      await deleteTask(taskId);
    } catch (e) {
      console.error('delete failed:', e);
    } finally {
      // Clear selection and close modal regardless of outcome
      setSelectedCell(null);
      closeModal();
      await loadData();
    }
  }

  const handleSelect = useCallback((taskId, date) => {
    setSelectedCell({ taskId, date });
  }, []);

  const handleSaveNote = useCallback(async (taskId, date, noteText) => {
    try {
      const result = await upsertNote(taskId, date, noteText);
      if (result.deleted) {
        setNotes((prev) => {
          const next = { ...prev };
          delete next[`${taskId}:${date}`];
          return next;
        });
      } else {
        setNotes((prev) => ({ ...prev, [`${taskId}:${date}`]: result.note }));
      }
    } catch (e) {
      console.error('saveNote failed:', e);
    }
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
      refreshTasks();
    } catch (e) {
      console.error('setCount failed:', e);
    }
  }, [refreshTasks]);

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

  // ---------------------------------------------------------------------------
  // Month navigation
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Keyboard workflow — Phase 1.1
  // Refs let the single window listener always read current values without
  // re-registering on every render. Assigned synchronously each render cycle.
  // ---------------------------------------------------------------------------

  const selectedCellRef    = useRef(null);
  const tasksRef           = useRef([]);
  const datesRef           = useRef([]);
  const completionsRef     = useRef({});
  const modalOpenRef       = useRef(false);
  const handlersRef        = useRef({});
  const helpOpenRef        = useRef(false);
  const helpBtnRef         = useRef(null);
  const helpPanelRef       = useRef(null);
  const helpCloseBtnRef    = useRef(null);
  // When true, the next helpOpen→false cycle skips returning focus to the trigger.
  // Used by click-outside close so natural click focus is not overridden.
  const skipFocusReturnRef = useRef(false);

  // Resolved keybinds — merged defaults + any localStorage overrides.
  // Resolved once on mount; future editing UI will update this via state.
  const [resolvedKb]    = useState(resolveKeybinds);
  const keybindsRef     = useRef(resolvedKb);

  // Sync refs each render — always current before any async event fires.
  // tasksRef uses flatGroupedTasks so keyboard nav follows visual render order.
  selectedCellRef.current = selectedCell;
  tasksRef.current        = flatGroupedTasks;
  datesRef.current        = dates;
  completionsRef.current  = completions;
  modalOpenRef.current    = modalOpen;
  helpOpenRef.current     = helpOpen;
  keybindsRef.current     = resolvedKb;
  handlersRef.current     = { handleIncrement, handleClear, handleSetCount, openAdd, openEdit, setSelectedCell, closeModal, setHelpOpen };

  // Clear selectedCell when the selected task is no longer in the flat grouped list.
  // Covers: soft-delete, filter change hiding the row, search hiding the row.
  useEffect(() => {
    if (selectedCellRef.current && !flatGroupedTasks.find((t) => t.id === selectedCellRef.current.taskId)) {
      setSelectedCell(null);
    }
  }, [flatGroupedTasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Also clear selectedCell immediately when the active filter changes,
  // since the new filter may show a completely different task set.
  useEffect(() => {
    setSelectedCell(null);
  }, [activeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear selectedCell when groupMode changes — render order may change completely.
  useEffect(() => {
    setSelectedCell(null);
  }, [groupMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close help panel when user clicks outside both the panel and the trigger button.
  useEffect(() => {
    if (!helpOpen) return;
    function onMouseDown(e) {
      if (
        helpPanelRef.current?.contains(e.target) ||
        helpBtnRef.current?.contains(e.target)
      ) return;
      // Skip focus-return so the natural click target keeps focus.
      skipFocusReturnRef.current = true;
      setHelpOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [helpOpen]);

  // Focus management: move focus into panel on open; return to trigger on close.
  useEffect(() => {
    if (helpOpen) {
      helpCloseBtnRef.current?.focus();
    } else if (!skipFocusReturnRef.current) {
      helpBtnRef.current?.focus();
    } else {
      skipFocusReturnRef.current = false;
    }
  }, [helpOpen]);

  // Register once on mount; TaskGrid only mounts on the Grid tab, so the
  // handler is automatically removed when the user switches to another tab.
  useEffect(() => {
    function onKeyDown(e) {
      const {
        handleIncrement, handleClear, handleSetCount,
        openAdd, openEdit, setSelectedCell, closeModal, setHelpOpen,
      } = handlersRef.current;
      const kb    = keybindsRef.current;
      const sel   = selectedCellRef.current;
      const tasks = tasksRef.current;
      const dates = datesRef.current;

      // Escape — three-level priority. Modal close is pre-guard (works while typing
      // inside a modal input). Help-close and selection-clear respect the typing guard.
      if (matchKeybind(e, kb.CLEAR_SELECTION)) {
        if (modalOpenRef.current) {
          closeModal();
          return;
        }
        const tag2 = document.activeElement?.tagName?.toLowerCase();
        const isTyping = ['input', 'textarea', 'select'].includes(tag2)
          || document.activeElement?.isContentEditable;
        if (!isTyping) {
          if (helpOpenRef.current) {
            setHelpOpen(false);
          } else if (sel) {
            setSelectedCell(null);
          }
        }
        return;
      }

      // For all non-Escape keys: ignore while typing or modal is open.
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag)) return;
      if (document.activeElement?.isContentEditable) return;
      if (modalOpenRef.current) return;

      // N — open Add Task modal (no selection required)
      if (matchKeybind(e, kb.NEW_TASK)) {
        openAdd();
        return;
      }

      // E — open Edit Task modal (requires selection; no auto-edit on bootstrap)
      if (matchKeybind(e, kb.EDIT_TASK)) {
        if (!sel) return;
        const task = tasks.find((t) => t.id === sel.taskId);
        if (task) openEdit(task);
        return;
      }

      // ? — toggle keyboard help panel (no selection required)
      if (matchKeybind(e, kb.TOGGLE_HELP)) {
        setHelpOpen((o) => !o);
        return;
      }

      // Arrow / Enter / Shift+Enter bootstrap selection when no cell is selected.
      const isNavKey = matchKeybind(e, kb.MOVE_LEFT)  || matchKeybind(e, kb.MOVE_RIGHT) ||
                       matchKeybind(e, kb.MOVE_UP)    || matchKeybind(e, kb.MOVE_DOWN)  ||
                       matchKeybind(e, kb.INCREMENT)  || matchKeybind(e, kb.DECREMENT);
      if (!sel && isNavKey) {
        e.preventDefault();
        const defaultCell = getDefaultKeyboardCell(tasks, dates);
        if (defaultCell) setSelectedCell(defaultCell);
        // Do not apply movement or mutation on the bootstrap keypress — just select.
        return;
      }

      if (!sel) return;

      const rowIdx  = tasks.findIndex((t) => t.id === sel.taskId);
      const dateIdx = dates.indexOf(sel.date);

      if (matchKeybind(e, kb.MOVE_LEFT)) {
        e.preventDefault();
        const next = Math.max(0, dateIdx - 1);
        setSelectedCell({ taskId: sel.taskId, date: dates[next] });
        return;
      }
      if (matchKeybind(e, kb.MOVE_RIGHT)) {
        e.preventDefault();
        const next = Math.min(dates.length - 1, dateIdx + 1);
        setSelectedCell({ taskId: sel.taskId, date: dates[next] });
        return;
      }
      if (matchKeybind(e, kb.MOVE_UP)) {
        e.preventDefault();
        if (rowIdx < 0) return;
        const next = Math.max(0, rowIdx - 1);
        setSelectedCell({ taskId: tasks[next].id, date: sel.date });
        return;
      }
      if (matchKeybind(e, kb.MOVE_DOWN)) {
        e.preventDefault();
        if (rowIdx < 0) return;
        const next = Math.min(tasks.length - 1, rowIdx + 1);
        setSelectedCell({ taskId: tasks[next].id, date: sel.date });
        return;
      }

      // Enter — increment (plain) or true decrement (shift).
      // Reuses existing setCompletionCount (PATCH) and deleteCompletion (DELETE) paths.
      // Check DECREMENT first (Shift+Enter) before INCREMENT (Enter).
      if (matchKeybind(e, kb.DECREMENT) || matchKeybind(e, kb.INCREMENT)) {
        const task = tasks.find((t) => t.id === sel.taskId);
        if (!task) return;
        if (task.is_paused === 1) return;
        if (sel.date > toLocalDate(new Date())) return; // no-op on future dates
        if (task.active_from && sel.date < task.active_from) return; // no-op before active_from

        if (matchKeybind(e, kb.DECREMENT)) {
          const count = completionsRef.current[`${sel.taskId}:${sel.date}`] || 0;
          if (count === 0) return;
          if (count === 1) {
            handleClear(sel.taskId, sel.date);
          } else {
            handleSetCount(sel.taskId, sel.date, count - 1);
          }
        } else {
          handleIncrement(sel.taskId, sel.date);
        }
        return;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — intentionally reads from refs

  // ---------------------------------------------------------------------------
  // Column resize
  // ---------------------------------------------------------------------------

  function resetColWidths() {
    setColWidths({});
    localStorage.removeItem(LS_KEY);
  }

  // Starts a drag resize for the given column key.
  // Uses document-level mousemove/mouseup listeners; cleans up on mouseup.
  // Width updates are throttled to one per animation frame.
  function handleResizeStart(colKey, startClientX) {
    const startWidth = colWidths[colKey] ?? DEFAULT_WIDTHS[colKey];
    let rafId = null;

    function onMouseMove(e) {
      const delta = e.clientX - startClientX;
      const newWidth = Math.max(MIN_COL_WIDTH, startWidth + delta);
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        setColWidths((prev) => ({ ...prev, [colKey]: newWidth }));
      });
    }

    function onMouseUp() {
      if (rafId) cancelAnimationFrame(rafId);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Resize handle element rendered inside each resizable <th>.
  function rh(colKey) {
    return (
      <div
        className="col-resize-handle"
        onMouseDown={(e) => { e.preventDefault(); handleResizeStart(colKey, e.clientX); }}
      />
    );
  }

  // Inline style for a header <th> or body <td>.
  // minWidth + maxWidth = width enforces the cell against table layout compression.
  // Sticky cols additionally get left; non-sticky cols get width constraints only.
  function thStyle(col) {
    const w = colLayout.widths[col];
    const style = { width: w, minWidth: w, maxWidth: w };
    if (colLayout.offsets[col] !== undefined) style.left = colLayout.offsets[col];
    return style;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) return <div className="grid-status">Loading…</div>;
  if (error) return (
    <div className="grid-status error">
      Error: {error}<br />
      Is the backend running? <code>uvicorn backend.main:app --reload</code>
    </div>
  );

  return (
    <>
      {/* ── Tier 1: Operations shelf — ink dark, primary actions only ── */}
      <div className="ws-grid-shelf">
        <div className="ws-shelf-left">
          <button className="ws-shelf-btn ws-shelf-btn--primary" onClick={openAdd}>+ Add Task</button>
          <button className="ws-shelf-btn" onClick={handleArchive}>Archive Sheet</button>
          <a
            className="ws-shelf-btn"
            href={buildExportSheetUrl(dates[0], dates[dates.length - 1])}
            download
          >Export CSV</a>
          {confirmReset ? (
            <>
              <span className="ws-shelf-confirm-text">Reset column widths? Task data is unchanged.</span>
              <button className="ws-shelf-btn ws-shelf-btn--confirm" onClick={() => { resetColWidths(); setConfirmReset(false); }}>Confirm reset</button>
              <button className="ws-shelf-btn" onClick={() => setConfirmReset(false)}>Cancel</button>
            </>
          ) : (
            <button className="ws-shelf-btn" onClick={() => setConfirmReset(true)}>Reset Column Widths</button>
          )}
        </div>
      </div>

      {/* ── Tier 2: Sheet header — paper surface, identity + nav + status ── */}
      <div className="ws-sheet-header">
        <div className="ws-sheet-header-left">
          <div className="ws-sheet-title">Task Sheet</div>
          <div className="ws-sheet-meta">
            <span>{tasks.filter(t => !t.is_paused).length} active</span>
            <span className="ws-meta-sep">·</span>
            <span>{tasks.filter(t => t.is_paused).length} paused</span>
            <span className="ws-meta-sep">·</span>
            <span>{tasks.length} total</span>
          </div>
        </div>
        <div className="ws-sheet-header-nav">
          <button className="ws-sheet-nav" onClick={goToPrevMonth}>‹</button>
          <button className="ws-sheet-nav ws-sheet-nav--today" onClick={goToCurrentMonth}>Today</button>
          <span className="ws-sheet-range">{monthRangeLabel(viewMonth.year, viewMonth.month)}</span>
          <button className="ws-sheet-nav" onClick={goToNextMonth}>›</button>
        </div>
        <div className="ws-sheet-header-right">
          <span className="ws-status-pill ws-status-pill--ok">local</span>
          <span className="ws-status-pill ws-status-pill--ok">SQLite</span>
          <span className="ws-status-pill ws-status-pill--dim">synced: never</span>
          <div className="ws-kbd-help-anchor">
            <button
              ref={helpBtnRef}
              type="button"
              className="ws-kbd-help-btn"
              aria-label="Keyboard shortcuts"
              aria-haspopup="dialog"
              aria-expanded={helpOpen}
              onClick={() => setHelpOpen((o) => !o)}
            >
              ?
            </button>
            {helpOpen && (
              <KeyboardHelp
                panelRef={helpPanelRef}
                closeButtonRef={helpCloseBtnRef}
                onClose={() => setHelpOpen(false)}
                resolvedKb={resolvedKb}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── Filter bar — pills + search, sits between header and inspector ── */}
      <div className="ws-filter-bar">
        <div className="ws-filter-pills">
          {Object.values(FILTERS).map((f) => (
            <button
              key={f}
              className={`ws-filter-pill${activeFilter === f ? ' ws-filter-pill--active' : ''}`}
              onClick={() => setActiveFilter(f)}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
        <input
          className="ws-filter-input"
          type="search"
          placeholder="Search tasks…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {filteredTasks.length !== tasks.length && (
          <span className="ws-filter-count">
            {filteredTasks.length} of {tasks.length}
          </span>
        )}
        <label className="ws-group-label">
          <span>Group</span>
          <select
            className="ws-group-select"
            value={groupMode}
            onChange={(e) => setGroupMode(e.target.value)}
          >
            {Object.values(GROUP_MODES).map((mode) => (
              <option key={mode} value={mode}>{GROUP_MODE_LABELS[mode]}</option>
            ))}
          </select>
        </label>
      </div>

      {/* ── Inspector strip — compositionally framed EditBar ── */}
      <div className="ws-inspector-strip">
        <div className="ws-inspector-badge">
          {selectedCell ? '▸ cell' : '○ inspector'}
        </div>
        <div className="ws-inspector-body">
          <EditBar
            selectedCell={selectedCell}
            tasks={tasks}
            completions={completions}
            notes={notes}
            todayStr={todayStr}
            onIncrement={handleIncrement}
            onClear={handleClear}
            onSetCount={handleSetCount}
            onSaveNote={handleSaveNote}
          />
        </div>
      </div>

      <div className="ws-grid-canvas">
      <div className="grid-wrapper">
        <table className="task-grid">
          <thead>
            <tr>
              <th className="meta-col sticky-col col-actions" style={thStyle('col-actions')}></th>
              <th className="meta-col sticky-col col-urg" title="Urgency" style={thStyle('col-urg')}>
                Urg{rh('col-urg')}
              </th>
              <th className="meta-col sticky-col col-pri" title="Priority" style={thStyle('col-pri')}>
                P{rh('col-pri')}
              </th>
              <th className="meta-col sticky-col col-status" style={thStyle('col-status')}>
                Status{rh('col-status')}
              </th>
              <th className="meta-col sticky-col col-active-from" title="Active from date" style={thStyle('col-active-from')}>
                From{rh('col-active-from')}
              </th>
              <th className="meta-col sticky-col col-cat" style={thStyle('col-cat')}>
                Category{rh('col-cat')}
              </th>
              <th className="meta-col sticky-col col-task" style={thStyle('col-task')}>
                Task{rh('col-task')}
              </th>
              <th className="meta-col sticky-col col-sub" style={thStyle('col-sub')}>
                Subtask{rh('col-sub')}
              </th>
              <th className="meta-col scroll-meta-col col-freq" title="Frequency (days)" style={thStyle('col-freq')}>
                Freq{rh('col-freq')}
              </th>
              <th className="meta-col scroll-meta-col col-days" title="Days since last done" style={thStyle('col-days')}>
                Days{rh('col-days')}
              </th>
              <th className="meta-col scroll-meta-col col-notes" style={thStyle('col-notes')}>
                Notes{rh('col-notes')}
              </th>
              {dates.map((d) => (
                <th
                  key={d}
                  className={[
                    'date-col-header',
                    d === todayStr ? 'col-today' : '',
                    d > todayStr ? 'col-future' : '',
                    isWeekendDate(d) ? 'weekend' : '',
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
            {groupedTasks.map((group) => (
              <Fragment key={group.key}>
                {group.label !== null && (
                  <tr className="ws-section-row">
                    {/* Frozen td: sticky left, spans all 8 frozen columns.
                        Uses the same position:sticky mechanism as TaskRow sticky cells —
                        directly on the <td>, not a child element. Avoids jank. */}
                    <td className="ws-section-frozen" colSpan={8}>
                      <span className="ws-section-title">{group.label}</span>
                      <span className="ws-section-meta">
                        {group.tasks.length} task{group.tasks.length !== 1 ? 's' : ''}
                        {group.pausedCount > 0 ? ` · ${group.pausedCount} paused` : ''}
                        {group.avgUrgency !== null ? ` · avg urg ${group.avgUrgency}` : ''}
                      </span>
                    </td>
                    {/* Overflow td: spans the 3 non-sticky meta cols + all date cols,
                        provides background colour across the full row width. */}
                    <td className="ws-section-overflow" colSpan={3 + dates.length}></td>
                  </tr>
                )}
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    dates={dates}
                    todayStr={todayStr}
                    completions={completions}
                    notes={notes}
                    selectedCell={selectedCell}
                    colLayout={colLayout}
                    onIncrement={handleIncrement}
                    onClear={handleClear}
                    onEdit={openEdit}
                    onSelect={handleSelect}
                  />
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>

        {tasks.length === 0 && (
          <div className="grid-status">
            No tasks found. Click <strong>+ Add Task</strong> or run{' '}
            <code>python -m backend.seed</code> to add sample data.
          </div>
        )}
        {tasks.length > 0 && filteredTasks.length === 0 && (
          <div className="grid-status">No tasks match the current filter.</div>
        )}
      </div>
      </div>

      {modalOpen && (
        <TaskModal
          task={editingTask}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={closeModal}
        />
      )}
    </>
  );
}
