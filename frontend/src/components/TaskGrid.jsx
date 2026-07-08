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
  downloadExportSheet,
  fetchNotes,
  upsertNote,
  reorderTasks,
} from '../api.js';
import TaskRow from './TaskRow.jsx';
import TaskModal from './TaskModal.jsx';
import EditBar from './EditBar.jsx';
import KeyboardHelp from './KeyboardHelp.jsx';
import { FILTERS, FILTER_LABELS, taskPassesFilter } from '../filters.js';
import { GROUP_MODES, groupTasks } from '../grouping.js';
import { matchKeybind, resolveKeybinds } from '../keybinds.js';
import SavedViewsControl from './SavedViewsControl.jsx';
import GroupSelect from './GroupSelect.jsx';

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
  'col-actions':     56,
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

// Returns the best default date column for keyboard bootstrap.
// Today if visible; else last non-future date; else first date; else null.
function getDefaultKeyboardDate(dates) {
  if (!dates.length) return null;
  const todayStr = toLocalDate(new Date());
  if (dates.includes(todayStr)) return todayStr;
  const nonFuture = dates.filter((d) => d <= todayStr);
  return nonFuture.length > 0 ? nonFuture[nonFuture.length - 1] : dates[0];
}

// Returns the best default keyboard cell when no cell is selected.
// Fallback order: non-paused non-scheduled non-ended > non-paused non-ended > non-paused > first task.
function getDefaultKeyboardCell(tasks, dates) {
  if (!tasks.length || !dates.length) return null;
  const task =
    tasks.find((t) => t.is_paused !== 1 && !t.is_scheduled && !t.is_ended) ??
    tasks.find((t) => t.is_paused !== 1 && !t.is_ended) ??
    tasks.find((t) => t.is_paused !== 1) ??
    tasks[0];
  const date = getDefaultKeyboardDate(dates);
  return date ? { taskId: task.id, date } : null;
}

// Parse a jump input string into a { task } | { date } | { error } result.
// Accepts: integer row number, ISO date YYYY-MM-DD, M/D date, or task name fragment.
function resolveJump(raw, dates, tasks) {
  const v = raw.trim();
  if (!v) return null;

  // Pure integer → 1-indexed row number
  if (/^\d+$/.test(v)) {
    const idx = parseInt(v, 10) - 1;
    if (idx < 0 || idx >= tasks.length) {
      return { error: `Only ${tasks.length} row${tasks.length !== 1 ? 's' : ''} visible` };
    }
    return { task: tasks[idx] };
  }

  // ISO date YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    if (dates.includes(v)) return { date: v };
    return { error: `${v} not in current view` };
  }

  // M/D or M-D → resolve against current view's year
  const mdMatch = v.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (mdMatch) {
    const year = dates.length > 0 ? dates[0].substring(0, 4) : String(new Date().getFullYear());
    const candidate = `${year}-${mdMatch[1].padStart(2, '0')}-${mdMatch[2].padStart(2, '0')}`;
    if (dates.includes(candidate)) return { date: candidate };
    return { error: `${v} not in current view` };
  }

  // Text search — case-insensitive fragment match on name, subtask, category
  const q = v.toLowerCase();
  const match = tasks.find(
    (t) => (t.name     && t.name.toLowerCase().includes(q))
        || (t.subtask  && t.subtask.toLowerCase().includes(q))
        || (t.category && t.category.toLowerCase().includes(q)),
  );
  if (match) return { task: match };
  return { error: `No match for "${v}"` };
}

// Resolve the task id of the grid row under a screen point, skipping excludeId.
// Uses closest('tr[data-task-id]') so a hit on a <td>/<span>/dc-box still resolves
// its parent row. The drag clone's <tr> has no data-task-id, so it is never matched.
function resolveRowIdAt(clientX, clientY, excludeId) {
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    const tr = el.closest?.('tr[data-task-id]');
    if (!tr) continue;
    const id = parseInt(tr.dataset.taskId, 10);
    if (!Number.isNaN(id) && id !== excludeId) return id;
  }
  return null;
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
  const [selectedMetaCell, setSelectedMetaCell] = useState(null);
  const [editingTextCell, setEditingTextCell] = useState(null);
  const [armedCell, setArmedCell] = useState(null); // P2.0D: armed for two-step keyboard clear

  // Filtering / search state — Phase 1.
  const [activeFilter, setActiveFilter] = useState(FILTERS.ALL);
  const [searchQuery, setSearchQuery] = useState('');

  // Grouping mode — Phase 3. Persisted to localStorage.
  const [groupMode, setGroupMode] = useState(
    () => localStorage.getItem('taskos-group-mode') || GROUP_MODES.SECTION,
  );

  // Keyboard help panel — P4.
  const [helpOpen, setHelpOpen] = useState(false);

  // Jump mode — Shift+0 full jump prompt (name, date, row#).
  // null = closed; or { type: 'quick', value: '', error: '' }
  const [jumpMode, setJumpMode] = useState(null);

  // Quick Jump enabled — read from taskos-settings on mount; never changes during grid's life.
  // (Settings tab unmounts TaskGrid, so value is always fresh on tab switch.)
  const [quickJumpEnabled] = useState(() => {
    try {
      const saved = localStorage.getItem('taskos-settings');
      return (saved ? JSON.parse(saved) : {}).quickJumpEnabled ?? true;
    } catch { return true; }
  });

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

  // P4.0A-fix1: reorder handles are available in every view (all filters, search,
  // and all group modes). Reorder only ever changes display_order — never task
  // fields — and the drop handler restricts drops within grouped views to the same
  // rendered group, so a task can never appear to cross a semantic boundary.
  const reorderEnabled = true;

  // Pointer-based row drag state.
  // dragStateRef holds drag geometry — mutated imperatively, no re-render on move.
  // dragOverIdRef mirrors dragOverId for synchronous reads in event handlers.
  // ghostElRef holds the imperative full-row clone overlay DOM node (position:fixed).
  const dragStateRef = useRef({ active: false });
  const dragOverIdRef = useRef(null);
  const ghostElRef = useRef(null);
  const [dragSrcId, setDragSrcId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  // Derive computed layout (widths + sticky offsets) from overrides.
  const colLayout = useMemo(() => computeColLayout(colWidths), [colWidths]);

  // ---------------------------------------------------------------------------
  // Filtering — applied client-side over the full tasks array.
  // filteredTasks is the source of truth for the rendered grid and keyboard nav.
  // ---------------------------------------------------------------------------

  const filteredTasks = useMemo(() => {
    // Finished-task month visibility (P3.0B): a task marked Finished (end_date set)
    // is hidden in month views AFTER its finish month, but stays visible in the
    // finish month and all earlier months. Keyed strictly on end_date — a plain
    // completion entry never sets end_date, so completing a cell never hides a task.
    const viewYearMonth = `${viewMonth.year}-${String(viewMonth.month).padStart(2, '0')}`;
    let result = tasks.filter(
      (t) => !t.end_date || t.end_date.slice(0, 7) >= viewYearMonth,
    );
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
  }, [tasks, activeFilter, searchQuery, viewMonth.year, viewMonth.month]);

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

  // taskId → rendered group key, using the exact grouping that draws the headers.
  // Used by the drop handler to keep reorder within a semantic group (see below).
  // In NONE mode every task shares the single '__none__' group, so nothing is blocked.
  const groupKeyById = useMemo(() => {
    const m = new Map();
    for (const g of groupedTasks) {
      for (const t of g.tasks) m.set(t.id, g.key);
    }
    return m;
  }, [groupedTasks]);

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
      // Re-throw so the modal can surface the failure to the user instead of
      // the save silently doing "nothing". Modal stays open (closeModal above
      // is skipped on throw), so no edits are lost.
      console.error('save failed:', e);
      throw e;
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
    setSelectedMetaCell(null);
    setArmedCell(null);
  }, []);

  const handleSelectMeta = useCallback((taskId, col) => {
    setSelectedMetaCell({ taskId, col });
    setSelectedCell(null);
    setArmedCell(null);
  }, []);

  const handleStartTextEdit = useCallback((taskId, col) => {
    setEditingTextCell({ taskId, col });
    setSelectedMetaCell({ taskId, col });
    setSelectedCell(null);
  }, []);

  async function handleCommitTextEdit(taskId, col, value) {
    const fieldMap = { 'col-task': 'name', 'col-sub': 'subtask', 'col-cat': 'category' };
    const field = fieldMap[col];
    if (!field) { setEditingTextCell(null); return; }
    try {
      await updateTask(taskId, { [field]: value });
      refreshTasks();
    } catch (e) {
      console.error('inline text edit failed:', e);
    }
    setEditingTextCell(null);
  }

  function handleCancelTextEdit() {
    setEditingTextCell(null);
  }

  // ---------------------------------------------------------------------------
  // Pointer-based row drag handler — only active when reorderEnabled.
  // Uses pointer events + a fixed-position clone of the real <tr> instead of the
  // HTML drag API. The clone is a full visible row (frozen meta columns + the
  // date cells currently on screen), so the whole spreadsheet row visibly follows
  // the cursor rather than producing a static ghost image or a partial strip.
  // ---------------------------------------------------------------------------

  function handleHandlePointerDown(e, taskId) {
    if (!reorderEnabled || e.button !== 0) return;
    e.preventDefault();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    const srcTr = document.querySelector(`tr[data-task-id="${taskId}"]`);
    const srcTable = srcTr?.closest('table.task-grid');
    const scrollEl = srcTr?.closest('.grid-wrapper');
    if (!srcTr || !srcTable || !scrollEl) return;

    const trRect = srcTr.getBoundingClientRect();
    const scrollRect = scrollEl.getBoundingClientRect();

    // Build a fixed-position clip window aligned to the visible grid viewport,
    // holding a clone of the source table cropped to a single row and scrolled to
    // match the grid's current horizontal scroll. Because the clip is itself a
    // scroll container, the sticky meta columns pin left exactly as in the real
    // grid while the visible date cells scroll into view — the moving visual reads
    // as the actual full row lifted from the sheet.
    const clip = document.createElement('div');
    clip.className = 'row-drag-ghost-clip';
    clip.style.left = scrollRect.left + 'px';
    clip.style.top = trRect.top + 'px';
    clip.style.width = scrollRect.width + 'px';
    clip.style.height = trRect.height + 'px';

    const tableClone = srcTable.cloneNode(false);
    tableClone.style.width = srcTable.getBoundingClientRect().width + 'px';
    tableClone.style.tableLayout = 'fixed';
    tableClone.style.margin = '0';
    tableClone.style.minWidth = '0';

    const tbody = document.createElement('tbody');
    const trClone = srcTr.cloneNode(true);
    trClone.removeAttribute('data-task-id'); // keep it out of elementsFromPoint hit testing
    trClone.classList.remove('drag-over', 'drag-source');

    // Lock every cell to its rendered width so the fixed-layout clone matches the
    // real row exactly (date cells have no inline width otherwise).
    const srcCells = srcTr.children;
    const cloneCells = trClone.children;
    for (let i = 0; i < srcCells.length; i++) {
      const w = srcCells[i].getBoundingClientRect().width;
      const cc = cloneCells[i];
      if (!cc) continue;
      cc.style.width = w + 'px';
      cc.style.minWidth = w + 'px';
      cc.style.maxWidth = w + 'px';
    }

    tbody.appendChild(trClone);
    tableClone.appendChild(tbody);
    clip.appendChild(tableClone);
    document.body.appendChild(clip);
    // Mirror horizontal scroll so the clone shows the same date cells now on screen.
    clip.scrollLeft = scrollEl.scrollLeft;

    ghostElRef.current = clip;
    dragStateRef.current = { active: true, taskId, pointerOffsetY: e.clientY - trRect.top };
    dragOverIdRef.current = null;
    setDragSrcId(taskId);

    function onPointerMove(ev) {
      if (!dragStateRef.current.active) return;
      if (ghostElRef.current) {
        ghostElRef.current.style.top = (ev.clientY - dragStateRef.current.pointerOffsetY) + 'px';
      }
      let newOverId = resolveRowIdAt(ev.clientX, ev.clientY, taskId);
      // In grouped views, only show the insertion line on a same-group target so
      // the indicator matches where a drop will actually land (cross-group no-ops).
      if (newOverId != null && groupMode !== GROUP_MODES.NONE) {
        const srcGroup = groupKeyById.get(taskId);
        const tgtGroup = groupKeyById.get(newOverId);
        if (srcGroup === undefined || tgtGroup === undefined || srcGroup !== tgtGroup) {
          newOverId = null;
        }
      }
      if (newOverId !== dragOverIdRef.current) {
        dragOverIdRef.current = newOverId;
        setDragOverId(newOverId);
      }
    }

    function cleanup() {
      dragStateRef.current.active = false;
      dragOverIdRef.current = null;
      if (ghostElRef.current) {
        ghostElRef.current.remove();
        ghostElRef.current = null;
      }
      setDragSrcId(null);
      setDragOverId(null);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', cleanup);
      window.removeEventListener('keydown', onEscKey);
      window.removeEventListener('blur', cleanup);
    }

    function onPointerUp(ev) {
      const srcId = dragStateRef.current.taskId;
      // Re-resolve the row under the pointer at drop time; fall back to the last
      // hovered id so a drop that lands between pointermove samples still counts.
      const resolved = resolveRowIdAt(ev.clientX, ev.clientY, srcId);
      const targetId = resolved ?? dragOverIdRef.current;
      cleanup();
      if (!srcId || !targetId || srcId === targetId) return;
      const prev = tasks;
      const src = prev.find((t) => t.id === srcId);
      const tgt = prev.find((t) => t.id === targetId);
      if (!src || !tgt) return;
      // Grouped views: allow reorder only within the same rendered group; reject
      // cross-group drops cleanly. Reorder never mutates task fields (section,
      // category, status, urgency band, dates), so a task can never jump a semantic
      // boundary — a cross-group drop simply no-ops. NONE mode has one group so
      // free reorder applies; filtered/search flat views reorder among visible rows
      // while the full-list move below preserves every hidden task's relative order.
      if (groupMode !== GROUP_MODES.NONE) {
        const srcGroup = groupKeyById.get(srcId);
        const tgtGroup = groupKeyById.get(targetId);
        if (srcGroup === undefined || tgtGroup === undefined || srcGroup !== tgtGroup) return;
      }
      // Insert source immediately before target — matches the black top insertion line.
      const next = [...prev];
      const srcIdx = next.findIndex((t) => t.id === srcId);
      next.splice(srcIdx, 1);
      const targetIdx = next.findIndex((t) => t.id === targetId);
      if (targetIdx === -1) return;
      next.splice(targetIdx, 0, src);
      setTasks(next);
      reorderTasks(next.map((t) => t.id)).catch(() => setTasks(prev));
    }

    function onEscKey(ev) {
      if (ev.key === 'Escape') cleanup();
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', cleanup);
    window.addEventListener('keydown', onEscKey);
    window.addEventListener('blur', cleanup);
  }

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
    setArmedCell(null);
  }

  function goToNextMonth() {
    setViewMonth(({ year, month }) =>
      month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 },
    );
    setSelectedCell(null);
    setArmedCell(null);
  }

  function goToCurrentMonth() {
    const now = new Date();
    setViewMonth({ year: now.getFullYear(), month: now.getMonth() + 1 });
    setSelectedCell(null);
    setArmedCell(null);
  }

  // ---------------------------------------------------------------------------
  // Keyboard workflow — Phase 1.1
  // Refs let the single window listener always read current values without
  // re-registering on every render. Assigned synchronously each render cycle.
  // ---------------------------------------------------------------------------

  const selectedCellRef     = useRef(null);
  const selectedMetaCellRef = useRef(null);
  const editingTextCellRef  = useRef(null);
  const armedCellRef        = useRef(null);
  const tasksRef           = useRef([]);
  const datesRef           = useRef([]);
  const completionsRef     = useRef({});
  const modalOpenRef       = useRef(false);
  const handlersRef        = useRef({});
  const helpOpenRef        = useRef(false);
  const jumpModeRef          = useRef(null);
  // Numeric buffer — synchronous digit accumulation for Shift+digit jump.
  // Updated on every Shift+digit keydown so onKeyUp sees the current value
  // even if React hasn't re-rendered yet. Cleared on manual panel edit or close.
  const numericBufferRef     = useRef(null);
  const jumpInputRef         = useRef(null);
  const quickJumpEnabledRef  = useRef(quickJumpEnabled);
  const helpBtnRef           = useRef(null);
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
  selectedCellRef.current     = selectedCell;
  selectedMetaCellRef.current = selectedMetaCell;
  editingTextCellRef.current  = editingTextCell;
  armedCellRef.current        = armedCell;
  tasksRef.current            = flatGroupedTasks;
  datesRef.current            = dates;
  completionsRef.current      = completions;
  modalOpenRef.current        = modalOpen;
  helpOpenRef.current         = helpOpen;
  jumpModeRef.current           = jumpMode;
  quickJumpEnabledRef.current   = quickJumpEnabled;
  keybindsRef.current           = resolvedKb;
  handlersRef.current           = { handleIncrement, handleClear, handleSetCount, openAdd, openEdit, setSelectedCell, closeModal, setHelpOpen, setSelectedMetaCell, setEditingTextCell, setArmedCell, setJumpMode };

  // Clear selectedCell when the selected task is no longer in the flat grouped list.
  // Covers: soft-delete, filter change hiding the row, search hiding the row.
  useEffect(() => {
    if (selectedCellRef.current && !flatGroupedTasks.find((t) => t.id === selectedCellRef.current.taskId)) {
      setSelectedCell(null);
      setArmedCell(null);
    }
  }, [flatGroupedTasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Also clear selectedCell immediately when the active filter changes,
  // since the new filter may show a completely different task set.
  useEffect(() => {
    setSelectedCell(null);
    setArmedCell(null);
  }, [activeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear selectedCell when groupMode changes — render order may change completely.
  useEffect(() => {
    setSelectedCell(null);
    setArmedCell(null);
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
        setSelectedMetaCell, setEditingTextCell, setArmedCell,
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
          } else if (armedCellRef.current) {
            setArmedCell(null); // cancel armed state; press Esc again to clear selection
          } else if (sel) {
            setSelectedCell(null);
          } else if (selectedMetaCellRef.current) {
            setSelectedMetaCell(null);
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

      // E — open Task Details modal. Works for a selected date/grid cell OR a
      // selected Task/Subtask/meta text cell (parity fix) — both carry taskId.
      // The typing guard above already prevents this from firing while editing.
      if (matchKeybind(e, kb.EDIT_TASK)) {
        const editTaskId = sel?.taskId ?? selectedMetaCellRef.current?.taskId;
        if (editTaskId == null) return;
        const task = tasks.find((t) => t.id === editTaskId);
        if (task) openEdit(task);
        return;
      }

      // ? — toggle keyboard help panel (no selection required)
      if (matchKeybind(e, kb.TOGGLE_HELP)) {
        setHelpOpen((o) => !o);
        return;
      }

      // Shift+digit (0–9) — opens/fills the Jump panel for context-aware Quick Jump.
      // Uses event.code (layout-agnostic) because Shift+3 → '#' in event.key on US keyboards.
      // Fires only when no other input is focused (panel not yet open); subsequent digits
      // while panel is open are handled by the panel input's own onKeyDown.
      // Shift+0 is now just a digit — no longer opens a separate prompt.
      if (quickJumpEnabledRef.current && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && /^Digit[0-9]$/.test(e.code)) {
        const digit = e.code[5]; // '0'–'9'
        e.preventDefault();
        numericBufferRef.current = (numericBufferRef.current ?? '') + digit;
        setArmedCell(null);
        setJumpMode((m) => m === null
          ? { type: 'numeric', value: digit, error: '' }
          : { ...m, value: m.value + digit, error: '' }
        );
        return;
      }

      // Enter on a selected text (meta) cell → enter inline edit mode.
      // Must be checked before the isNavKey bootstrap so it takes priority.
      if (matchKeybind(e, kb.INCREMENT) && !sel && selectedMetaCellRef.current && !editingTextCellRef.current) {
        e.preventDefault();
        setEditingTextCell({ ...selectedMetaCellRef.current });
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

      // Delete / Backspace — guarded two-step keyboard clear for DateCell completions.
      // First press arms the cell (shows amber indicator + hint); second press confirms.
      // Changing selection, navigating away, or pressing Escape cancels armed state.
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const task = tasks.find((t) => t.id === sel.taskId);
        if (!task || task.is_paused === 1) return;
        if (sel.date > toLocalDate(new Date())) return;
        if (task.active_from && sel.date < task.active_from) return;
        if (task.end_date && sel.date > task.end_date) return;
        const count = completionsRef.current[`${sel.taskId}:${sel.date}`] || 0;
        if (count === 0) return;
        const armed = armedCellRef.current;
        if (armed && armed.taskId === sel.taskId && armed.date === sel.date) {
          setArmedCell(null);
          handleClear(sel.taskId, sel.date);
        } else {
          setArmedCell({ taskId: sel.taskId, date: sel.date });
        }
        return;
      }

      const rowIdx  = tasks.findIndex((t) => t.id === sel.taskId);
      const dateIdx = dates.indexOf(sel.date);

      if (matchKeybind(e, kb.MOVE_LEFT)) {
        e.preventDefault();
        setArmedCell(null);
        const next = Math.max(0, dateIdx - 1);
        setSelectedCell({ taskId: sel.taskId, date: dates[next] });
        return;
      }
      if (matchKeybind(e, kb.MOVE_RIGHT)) {
        e.preventDefault();
        setArmedCell(null);
        const next = Math.min(dates.length - 1, dateIdx + 1);
        setSelectedCell({ taskId: sel.taskId, date: dates[next] });
        return;
      }
      if (matchKeybind(e, kb.MOVE_UP)) {
        e.preventDefault();
        if (rowIdx < 0) return;
        setArmedCell(null);
        const next = Math.max(0, rowIdx - 1);
        setSelectedCell({ taskId: tasks[next].id, date: sel.date });
        return;
      }
      if (matchKeybind(e, kb.MOVE_DOWN)) {
        e.preventDefault();
        if (rowIdx < 0) return;
        setArmedCell(null);
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
        if (task.end_date && sel.date > task.end_date) return; // no-op after end_date

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

    // Shared by Enter (keydown) and Shift release (keyup): resolve buffer → jump.
    // Context-aware: with a selected cell, jumps to date column N in that row;
    // without a selection, jumps to row N.
    function confirmRowJump(buf) {
      const { setSelectedCell, setArmedCell, setJumpMode } = handlersRef.current;
      const tasks = tasksRef.current;
      const dates = datesRef.current;
      const sel = selectedCellRef.current;
      const idx = parseInt(buf, 10) - 1;
      numericBufferRef.current = null;
      setJumpMode(null);
      if (idx < 0) return;

      if (sel) {
        // With selection: jump to 1-indexed date column in the current row.
        if (idx >= dates.length) return;
        setArmedCell(null);
        setSelectedCell({ taskId: sel.taskId, date: dates[idx] });
        const d = dates[idx];
        requestAnimationFrame(() => {
          document.querySelector(`th[data-date="${d}"]`)
            ?.scrollIntoView({ inline: 'nearest', behavior: 'smooth' });
        });
      } else {
        // No selection: jump to 1-indexed row in the current visible/filtered order.
        if (idx >= tasks.length) return;
        const task = tasks[idx];
        const date = getDefaultKeyboardDate(dates);
        if (!date) return;
        setArmedCell(null);
        setSelectedCell({ taskId: task.id, date });
        const tid = task.id;
        requestAnimationFrame(() => {
          document.querySelector(`tr[data-task-id="${tid}"]`)
            ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          document.querySelector(`th[data-date="${date}"]`)
            ?.scrollIntoView({ inline: 'nearest', behavior: 'smooth' });
        });
      }
    }

    function onKeyUp(e) {
      if (e.key === 'Shift') {
        const buf = numericBufferRef.current;
        if (buf !== null) confirmRowJump(buf);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — intentionally reads from refs

  // Saved views
  // ---------------------------------------------------------------------------

  function handleApplyView(view) {
    const validFilter    = Object.values(FILTERS).includes(view.filter)
      ? view.filter    : FILTERS.ALL;
    const validGroupMode = Object.values(GROUP_MODES).includes(view.groupMode)
      ? view.groupMode : GROUP_MODES.SECTION;
    setActiveFilter(validFilter);
    setGroupMode(validGroupMode);
    setSearchQuery(view.searchQuery || '');
    setSelectedCell(null);
  }

  // ---------------------------------------------------------------------------
  // Jump mode handlers (Quick Jump panel)
  // ---------------------------------------------------------------------------

  function handleJumpChange(e) {
    // Manual edit transitions panel to 'quick' mode so Shift-release won't confirm.
    numericBufferRef.current = null;
    setJumpMode((m) => ({ ...m, type: 'quick', value: e.target.value, error: '' }));
  }

  function handleJumpKeyDown(e) {
    // Allow additional Shift+digits to accumulate in the panel while it's open.
    if (quickJumpEnabled && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && /^Digit[0-9]$/.test(e.code)) {
      const digit = e.code[5];
      e.preventDefault();
      numericBufferRef.current = (numericBufferRef.current ?? '') + digit;
      setJumpMode((m) => ({ ...m, type: 'numeric', value: (m?.value ?? '') + digit, error: '' }));
      return;
    }

    // Backspace in numeric mode: manually trim last digit and stay numeric.
    // preventDefault blocks the browser input event so handleJumpChange doesn't fire
    // and exit numeric mode. If last digit is removed, cancel the jump entirely.
    if (e.key === 'Backspace' && jumpMode?.type === 'numeric' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const current = numericBufferRef.current ?? jumpMode.value ?? '';
      const trimmed = current.slice(0, -1);
      if (trimmed.length === 0) {
        numericBufferRef.current = null;
        setJumpMode(null);
      } else {
        numericBufferRef.current = trimmed;
        setJumpMode((m) => ({ ...m, type: 'numeric', value: trimmed, error: '' }));
      }
      return;
    }

    if (e.key === 'Escape') {
      numericBufferRef.current = null;
      setJumpMode(null);
      return;
    }
    if (e.key !== 'Enter') return;

    // Enter in numeric mode: context-aware jump (same logic as Shift-release).
    if (jumpMode?.type === 'numeric') {
      const buf = numericBufferRef.current ?? jumpMode.value;
      numericBufferRef.current = null;
      const idx = parseInt(buf, 10) - 1;
      setJumpMode(null);
      if (idx < 0) return;
      const sel = selectedCell;
      if (sel) {
        if (idx >= dates.length) return;
        setArmedCell(null);
        setSelectedCell({ taskId: sel.taskId, date: dates[idx] });
        const d = dates[idx];
        requestAnimationFrame(() => {
          document.querySelector(`th[data-date="${d}"]`)
            ?.scrollIntoView({ inline: 'nearest', behavior: 'smooth' });
        });
      } else {
        if (idx >= flatGroupedTasks.length) return;
        const task = flatGroupedTasks[idx];
        const date = getDefaultKeyboardDate(dates);
        if (!date) return;
        setArmedCell(null);
        setSelectedCell({ taskId: task.id, date });
        const tid = task.id;
        requestAnimationFrame(() => {
          document.querySelector(`tr[data-task-id="${tid}"]`)
            ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          document.querySelector(`th[data-date="${date}"]`)
            ?.scrollIntoView({ inline: 'nearest', behavior: 'smooth' });
        });
      }
      return;
    }

    const result = resolveJump(jumpMode.value, dates, flatGroupedTasks);
    if (!result) { setJumpMode(null); return; }

    if (result.error) {
      setJumpMode((m) => ({ ...m, error: result.error }));
      return;
    }

    setArmedCell(null);

    if (result.task) {
      const date = getDefaultKeyboardDate(dates);
      if (date) {
        setSelectedCell({ taskId: result.task.id, date });
        const tid = result.task.id;
        requestAnimationFrame(() => {
          document.querySelector(`tr[data-task-id="${tid}"]`)
            ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          document.querySelector(`th[data-date="${date}"]`)
            ?.scrollIntoView({ inline: 'nearest', behavior: 'smooth' });
        });
      }
    } else if (result.date) {
      const taskId = selectedCell?.taskId;
      if (taskId) setSelectedCell({ taskId, date: result.date });
      const d = result.date;
      requestAnimationFrame(() => {
        document.querySelector(`th[data-date="${d}"]`)
          ?.scrollIntoView({ inline: 'nearest', behavior: 'smooth' });
      });
    }

    setJumpMode(null);
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
          <button
            className="ws-shelf-btn"
            onClick={() => downloadExportSheet(dates[0], dates[dates.length - 1])}
          >Export CSV</button>
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
        <GroupSelect value={groupMode} onChange={setGroupMode} />
        <SavedViewsControl
          activeFilter={activeFilter}
          groupMode={groupMode}
          searchQuery={searchQuery}
          onApplyView={handleApplyView}
        />
        {quickJumpEnabled && (
          <button
            type="button"
            className="ws-filter-pill"
            onClick={() => { setArmedCell(null); numericBufferRef.current = null; setJumpMode({ type: 'quick', value: '', error: '' }); }}
            title="Quick jump to row, task name, or date"
          >
            Jump
          </button>
        )}
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
            armedCell={armedCell}
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
                Urgency{rh('col-urg')}
              </th>
              <th className="meta-col sticky-col col-pri" title="Priority" style={thStyle('col-pri')}>
                Priority{rh('col-pri')}
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
                Frequency{rh('col-freq')}
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
                  data-date={d}
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
                    selectedMetaCell={selectedMetaCell}
                    editingTextCell={editingTextCell}
                    armedCell={armedCell}
                    reorderEnabled={reorderEnabled}
                    isDragOver={dragOverId === task.id}
                    isDragSource={dragSrcId === task.id}
                    onHandlePointerDown={handleHandlePointerDown}
                    onIncrement={handleIncrement}
                    onClear={handleClear}
                    onEdit={openEdit}
                    onSelect={handleSelect}
                    onSelectMeta={handleSelectMeta}
                    onStartTextEdit={handleStartTextEdit}
                    onCommitTextEdit={handleCommitTextEdit}
                    onCancelTextEdit={handleCancelTextEdit}
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

      {jumpMode && (
        <div className="ws-jump-prompt" role="dialog" aria-label="Quick jump">
          <div className="ws-jump-title">Quick Jump</div>
          <input
            ref={jumpInputRef}
            className="ws-jump-input"
            type="text"
            placeholder="row#, name, or date"
            autoFocus
            value={jumpMode.value}
            onChange={handleJumpChange}
            onKeyDown={handleJumpKeyDown}
            onBlur={() => { numericBufferRef.current = null; setJumpMode(null); }}
            aria-label="Jump to row number, task name, or date"
          />
          {jumpMode.error && (
            <div className="ws-jump-error" role="alert">{jumpMode.error}</div>
          )}
          <div className="ws-jump-hint">3 · gym · 7/15 · 2026-07-15 — Enter · Esc</div>
        </div>
      )}

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
