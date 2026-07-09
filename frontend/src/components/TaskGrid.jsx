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
  fetchDateCellOverrides,
  upsertDateCellOverride,
  deleteDateCellOverride,
  batchUpsertDateCellOverrides,
  batchDeleteDateCellOverrides,
} from '../api.js';
import TaskRow from './TaskRow.jsx';
import TaskModal from './TaskModal.jsx';
import EditBar from './EditBar.jsx';
import KeyboardHelp from './KeyboardHelp.jsx';
import { FILTERS, FILTER_LABELS, PRIMARY_FILTERS, SECONDARY_FILTERS, taskPassesFilter } from '../filters.js';
import FilterMenu from './FilterMenu.jsx';
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
  // Range selection (P10.0) — selectedCell is the anchor; rangeEnd the focus
  // corner. Non-null rangeEnd means a rectangular DateCell range is selected.
  const [rangeEnd, setRangeEnd] = useState(null);
  // Transient feedback for range operations ("Converted 12 cells…").
  const [cellFeedback, setCellFeedback] = useState(null);
  const feedbackTimerRef = useRef(null);

  // Filtering / search state — Phase 1, split in P10.0.
  // activeFilter is the primary status scope (All/Active/Hiatus/Finished);
  // secondaryFilters are on/off toggles (Urgent/Dormant/…) ANDed on top.
  const [activeFilter, setActiveFilter] = useState(FILTERS.ALL);
  const [secondaryFilters, setSecondaryFilters] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');

  function toggleSecondaryFilter(f) {
    setSecondaryFilters((prev) =>
      prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f],
    );
  }

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

  // Date-cell text overrides (P9.1) — map `${taskId}:${date}` → text. A key's
  // presence means that cell is in text mode (empty string is a valid, empty
  // text cell). editingOverrideCell mirrors editingTextCell for meta cells.
  const [cellOverrides, setCellOverrides] = useState({});
  const [editingOverrideCell, setEditingOverrideCell] = useState(null);

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
    // Secondary toggles — AND semantics: a task must pass every active toggle.
    for (const f of secondaryFilters) {
      result = result.filter((t) => taskPassesFilter(t, f));
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
  }, [tasks, activeFilter, secondaryFilters, searchQuery, viewMonth.year, viewMonth.month]);

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
  // Range selection (P10.0) — rectangle between selectedCell (anchor) and
  // rangeEnd, in visual render order. Precomputes per-cell eligibility so the
  // delete/restore actions and the EditBar summary agree exactly.
  // ---------------------------------------------------------------------------

  const rangeSelection = useMemo(() => {
    if (!selectedCell || !rangeEnd) return null;
    const rowA = flatGroupedTasks.findIndex((t) => t.id === selectedCell.taskId);
    const rowB = flatGroupedTasks.findIndex((t) => t.id === rangeEnd.taskId);
    const dA = dates.indexOf(selectedCell.date);
    const dB = dates.indexOf(rangeEnd.date);
    if (rowA < 0 || rowB < 0 || dA < 0 || dB < 0) return null;
    const rows = flatGroupedTasks.slice(Math.min(rowA, rowB), Math.max(rowA, rowB) + 1);
    const dateSlice = dates.slice(Math.min(dA, dB), Math.max(dA, dB) + 1);
    const cells = [];
    let checkboxCount = 0;
    let overrideCount = 0;
    let overrideWithText = 0;
    let lockedCount = 0;
    for (const t of rows) {
      for (const date of dateSlice) {
        const disabled = date > todayStr
          || t.is_paused === 1
          || (t.active_from && date < t.active_from)
          || (t.end_date && date > t.end_date);
        const ov = cellOverrides[`${t.id}:${date}`];
        const isOverride = ov !== undefined;
        cells.push({ taskId: t.id, date, disabled, isOverride, hasText: !!ov });
        if (disabled) lockedCount += 1;
        else if (isOverride) {
          overrideCount += 1;
          if (ov) overrideWithText += 1;
        } else checkboxCount += 1;
      }
    }
    return {
      cells,
      count: cells.length,
      checkboxCount,
      overrideCount,
      overrideWithText,
      lockedCount,
      taskIdSet: new Set(rows.map((t) => t.id)),
      minDate: dateSlice[0],
      maxDate: dateSlice[dateSlice.length - 1],
    };
  }, [selectedCell, rangeEnd, flatGroupedTasks, dates, cellOverrides, todayStr]);

  const showFeedback = useCallback((msg) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setCellFeedback(msg);
    feedbackTimerRef.current = setTimeout(() => setCellFeedback(null), 5000);
  }, []);

  // ---------------------------------------------------------------------------
  // Data fetching — reruns when month changes (dates reference changes)
  // ---------------------------------------------------------------------------

  const loadData = useCallback(() => {
    const start = dates[0];
    const end = dates[dates.length - 1];
    return Promise.all([
      fetchTasks(), fetchCompletions(start, end), fetchNotes(start, end),
      fetchDateCellOverrides(start, end),
    ])
      .then(([taskList, compList, noteList, overrideList]) => {
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
        const overrideMap = {};
        for (const o of overrideList) {
          overrideMap[`${o.task_id}:${o.date}`] = o.text;
        }
        setCellOverrides(overrideMap);
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
    setRangeEnd(null);
  }, []);

  // Shift+click (or drag) — extend the range from the current anchor. With no
  // anchor yet, the shift-click simply selects (and never toggles).
  // Reads the anchor through selectedCellRef (synced every render below) so
  // the state updaters stay pure.
  const handleExtendRange = useCallback((taskId, date) => {
    setSelectedMetaCell(null);
    if (selectedCellRef.current) {
      setRangeEnd({ taskId, date });
    } else {
      setSelectedCell({ taskId, date });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectMeta = useCallback((taskId, col) => {
    setSelectedMetaCell({ taskId, col });
    setSelectedCell(null);
    setRangeEnd(null);
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

  // ---------------------------------------------------------------------------
  // DateCell drag-select (P10.0) — press on a date cell and drag across others
  // to select a rectangular range. The gesture only "activates" once the
  // pointer reaches a different cell, so a plain click (and dc-box toggle)
  // behaves exactly as before. Once active, the click that follows pointerup
  // is swallowed by handleGridClickCapture so no cell toggles or reselects.
  // ---------------------------------------------------------------------------

  const suppressNextClickRef = useRef(false);

  function dateCellAt(clientX, clientY) {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const td = el.closest?.('td.date-cell');
      if (td && td.dataset.dcDate) {
        return { taskId: parseInt(td.dataset.dcTask, 10), date: td.dataset.dcDate };
      }
    }
    return null;
  }

  function handleGridPointerDown(e) {
    if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey) return;
    const td = e.target.closest?.('td.date-cell');
    if (!td || !td.dataset.dcDate) return;
    if (e.target.closest('input')) return; // inline text editor — never drag
    const start = { taskId: parseInt(td.dataset.dcTask, 10), date: td.dataset.dcDate };
    if (Number.isNaN(start.taskId)) return;
    let active = false;

    function onMove(ev) {
      const cur = dateCellAt(ev.clientX, ev.clientY);
      if (!cur) return;
      if (!active) {
        if (cur.taskId === start.taskId && cur.date === start.date) return;
        // Threshold crossed — this gesture is a range drag, not a click.
        active = true;
        setSelectedCell(start);
        setSelectedMetaCell(null);
      }
      setRangeEnd((prev) =>
        prev && prev.taskId === cur.taskId && prev.date === cur.date ? prev : cur,
      );
    }

    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (active) suppressNextClickRef.current = true;
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function handleGridClickCapture(e) {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
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

  // ---------------------------------------------------------------------------
  // Date-cell text override handlers (P9.1)
  //
  // Converting to text mode creates an (initially empty) override row and opens
  // the inline editor. Any completion record for the cell is left untouched —
  // hidden while the override exists, visible again after restore. Restoring
  // checkbox mode deletes only the override row.
  // ---------------------------------------------------------------------------

  const handleConvertToText = useCallback(async (taskId, date) => {
    try {
      await upsertDateCellOverride(taskId, date, '');
      setCellOverrides((prev) => ({ ...prev, [`${taskId}:${date}`]: '' }));
      setEditingOverrideCell({ taskId, date });
    } catch (e) {
      console.error('convert to text cell failed:', e);
    }
  }, []);

  // Delete/Backspace on selected cell(s): visually remove checkboxes by
  // converting every eligible cell to a BLANK text override, and blank the
  // text of override cells. Completion rows are never touched — restoring
  // the checkbox reveals the prior count. Locked (future/pre-active/
  // after-end/hiatus) cells are skipped and reported.
  const handleDeleteCells = useCallback(async (cells) => {
    const eligible = cells.filter((c) => !c.disabled);
    const skipped = cells.length - eligible.length;
    // Only cells that actually change: checkbox cells gain a blank override;
    // override cells with text get blanked. Already-blank overrides are no-ops.
    const items = eligible
      .filter((c) => !c.isOverride || c.hasText)
      .map((c) => ({ task_id: c.taskId, date: c.date, text: '' }));
    if (items.length === 0) {
      if (skipped > 0) showFeedback(`Nothing to convert — skipped ${skipped} locked cell${skipped !== 1 ? 's' : ''}.`);
      return;
    }
    try {
      await batchUpsertDateCellOverrides(items);
      setCellOverrides((prev) => {
        const next = { ...prev };
        for (const it of items) next[`${it.task_id}:${it.date}`] = '';
        return next;
      });
      showFeedback(
        `Converted ${items.length} cell${items.length !== 1 ? 's' : ''} to blank text`
        + (skipped > 0 ? ` · skipped ${skipped} locked cell${skipped !== 1 ? 's' : ''}` : '')
        + '. Completion history is preserved.',
      );
    } catch (e) {
      console.error('range convert to text failed:', e);
      showFeedback('Could not convert cells — no changes were made.');
    }
  }, [showFeedback]);

  // Restore checkboxes for every eligible override cell in the selection.
  // Confirmation for non-empty text is handled by the EditBar before calling.
  const handleRestoreCells = useCallback(async (cells) => {
    const eligible = cells.filter((c) => !c.disabled && c.isOverride);
    const skipped = cells.filter((c) => c.isOverride && c.disabled).length;
    if (eligible.length === 0) {
      if (skipped > 0) showFeedback(`Nothing restored — skipped ${skipped} locked cell${skipped !== 1 ? 's' : ''}.`);
      return;
    }
    try {
      await batchDeleteDateCellOverrides(eligible.map((c) => ({ task_id: c.taskId, date: c.date })));
      setEditingOverrideCell(null);
      setCellOverrides((prev) => {
        const next = { ...prev };
        for (const c of eligible) delete next[`${c.taskId}:${c.date}`];
        return next;
      });
      showFeedback(
        `Restored ${eligible.length} checkbox${eligible.length !== 1 ? 'es' : ''}`
        + (skipped > 0 ? ` · skipped ${skipped} locked cell${skipped !== 1 ? 's' : ''}` : '')
        + '.',
      );
    } catch (e) {
      console.error('range restore failed:', e);
      showFeedback('Could not restore checkboxes — no changes were made.');
    }
  }, [showFeedback]);

  const handleCommitOverrideText = useCallback(async (taskId, date, text) => {
    setEditingOverrideCell(null);
    const key = `${taskId}:${date}`;
    try {
      await upsertDateCellOverride(taskId, date, text);
      setCellOverrides((prev) => ({ ...prev, [key]: text }));
    } catch (e) {
      console.error('save text cell failed:', e);
    }
  }, []);

  const handleCancelOverrideEdit = useCallback(() => {
    setEditingOverrideCell(null);
  }, []);

  const handleStartOverrideEdit = useCallback((taskId, date) => {
    setEditingOverrideCell({ taskId, date });
    setSelectedCell({ taskId, date });
    setSelectedMetaCell(null);
    setRangeEnd(null);
  }, []);

  // Typing into a selected cell (spreadsheet-style): open the inline editor
  // seeded with the typed character. No override is created until the edit
  // commits — Escape leaves a checkbox cell exactly as it was.
  const handleStartSeededEdit = useCallback((taskId, date, seed) => {
    setEditingOverrideCell({ taskId, date, seed });
    setSelectedCell({ taskId, date });
    setSelectedMetaCell(null);
    setRangeEnd(null);
  }, []);

  const handleRestoreCheckbox = useCallback(async (taskId, date) => {
    try {
      await deleteDateCellOverride(taskId, date);
      setEditingOverrideCell(null);
      setCellOverrides((prev) => {
        const next = { ...prev };
        delete next[`${taskId}:${date}`];
        return next;
      });
    } catch (e) {
      console.error('restore checkbox failed:', e);
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

  // ---------------------------------------------------------------------------
  // Month navigation
  // ---------------------------------------------------------------------------

  function goToPrevMonth() {
    setViewMonth(({ year, month }) =>
      month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 },
    );
    setSelectedCell(null);
    setRangeEnd(null);
  }

  function goToNextMonth() {
    setViewMonth(({ year, month }) =>
      month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 },
    );
    setSelectedCell(null);
    setRangeEnd(null);
  }

  function goToCurrentMonth() {
    const now = new Date();
    setViewMonth({ year: now.getFullYear(), month: now.getMonth() + 1 });
    setSelectedCell(null);
    setRangeEnd(null);
  }

  // ---------------------------------------------------------------------------
  // Keyboard workflow — Phase 1.1
  // Refs let the single window listener always read current values without
  // re-registering on every render. Assigned synchronously each render cycle.
  // ---------------------------------------------------------------------------

  const selectedCellRef     = useRef(null);
  const selectedMetaCellRef = useRef(null);
  const editingTextCellRef  = useRef(null);
  const rangeSelectionRef   = useRef(null);
  const rangeEndRef         = useRef(null);
  const tasksRef           = useRef([]);
  const datesRef           = useRef([]);
  const completionsRef     = useRef({});
  const cellOverridesRef   = useRef({});
  const editingOverrideCellRef = useRef(null);
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
  rangeSelectionRef.current   = rangeSelection;
  rangeEndRef.current         = rangeEnd;
  tasksRef.current            = flatGroupedTasks;
  datesRef.current            = dates;
  completionsRef.current      = completions;
  cellOverridesRef.current    = cellOverrides;
  editingOverrideCellRef.current = editingOverrideCell;
  modalOpenRef.current        = modalOpen;
  helpOpenRef.current         = helpOpen;
  jumpModeRef.current           = jumpMode;
  quickJumpEnabledRef.current   = quickJumpEnabled;
  keybindsRef.current           = resolvedKb;
  handlersRef.current           = { handleIncrement, handleClear, handleSetCount, openAdd, openEdit, setSelectedCell, closeModal, setHelpOpen, setSelectedMetaCell, setEditingTextCell, setRangeEnd, setJumpMode, setEditingOverrideCell, handleDeleteCells, handleStartSeededEdit };

  // Clear selectedCell when the selected task is no longer in the flat grouped list.
  // Covers: soft-delete, filter change hiding the row, search hiding the row.
  useEffect(() => {
    if (selectedCellRef.current && !flatGroupedTasks.find((t) => t.id === selectedCellRef.current.taskId)) {
      setSelectedCell(null);
      setRangeEnd(null);
    }
  }, [flatGroupedTasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Also clear selectedCell immediately when the active filters change,
  // since the new filters may show a completely different task set.
  useEffect(() => {
    setSelectedCell(null);
    setRangeEnd(null);
  }, [activeFilter, secondaryFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear selectedCell when groupMode changes — render order may change completely.
  useEffect(() => {
    setSelectedCell(null);
    setRangeEnd(null);
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

  // Register once on mount; TaskGrid only mounts on the Tasks sheet, so the
  // handler is automatically removed when the user switches to another tab.
  useEffect(() => {
    function onKeyDown(e) {
      const {
        handleIncrement, handleClear, handleSetCount,
        openAdd, openEdit, setSelectedCell, closeModal, setHelpOpen,
        setSelectedMetaCell, setEditingTextCell, setRangeEnd,
        handleDeleteCells, handleStartSeededEdit,
      } = handlersRef.current;
      const kb    = keybindsRef.current;
      const sel   = selectedCellRef.current;
      const tasks = tasksRef.current;
      const dates = datesRef.current;

      // Eligibility metadata for one cell — mirrors the rangeSelection memo so
      // single-cell Delete and range Delete share the exact same guards.
      function cellMeta(taskId, date) {
        const task = tasks.find((t) => t.id === taskId);
        const disabled = !task || task.is_paused === 1
          || date > toLocalDate(new Date())
          || (task.active_from && date < task.active_from)
          || (task.end_date && date > task.end_date);
        const ov = cellOverridesRef.current[`${taskId}:${date}`];
        return { taskId, date, disabled, isOverride: ov !== undefined, hasText: !!ov };
      }

      // Escape — priority: modal > help > range > cell selection. Modal close
      // is pre-guard (works while typing inside a modal input); the rest
      // respect the typing guard.
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
          } else if (rangeEndRef.current) {
            setRangeEnd(null); // collapse range; press Esc again to clear selection
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

      // Shift+digit (0–9) — opens/fills the Jump panel for context-aware Quick Jump.
      // Reserved before typing-to-edit below, so Shift+digits never type into cells.
      // Uses event.code (layout-agnostic) because Shift+3 → '#' in event.key on US keyboards.
      if (quickJumpEnabledRef.current && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && /^Digit[0-9]$/.test(e.code)) {
        const digit = e.code[5]; // '0'–'9'
        e.preventDefault();
        numericBufferRef.current = (numericBufferRef.current ?? '') + digit;
        setJumpMode((m) => m === null
          ? { type: 'numeric', value: digit, error: '' }
          : { ...m, value: m.value + digit, error: '' }
        );
        return;
      }

      // Shift+Arrow — extend the range from the anchor, spreadsheet-style.
      if (sel && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
          && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const focus = rangeEndRef.current ?? sel;
        const rIdx = tasks.findIndex((t) => t.id === focus.taskId);
        const dIdx = dates.indexOf(focus.date);
        if (rIdx < 0 || dIdx < 0) return;
        let nr = rIdx;
        let nd = dIdx;
        if (e.key === 'ArrowLeft')  nd = Math.max(0, dIdx - 1);
        if (e.key === 'ArrowRight') nd = Math.min(dates.length - 1, dIdx + 1);
        if (e.key === 'ArrowUp')    nr = Math.max(0, rIdx - 1);
        if (e.key === 'ArrowDown')  nr = Math.min(tasks.length - 1, rIdx + 1);
        setRangeEnd({ taskId: tasks[nr].id, date: dates[nd] });
        return;
      }

      // Typing into a selected, enabled date cell (P10.0) — spreadsheet-style:
      // any printable character starts text entry, converting a checkbox cell
      // to a text cell (committed on Enter/blur; Escape cancels with no
      // override created) or replacing an existing text cell's content.
      // Checked before the letter keybinds (N/E/?) so typing wins while a date
      // cell is selected; those shortcuts still work with no date cell selected.
      if (sel && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const meta = cellMeta(sel.taskId, sel.date);
        if (!meta.disabled) {
          e.preventDefault();
          handleStartSeededEdit(sel.taskId, sel.date, e.key);
          return;
        }
      }

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

      // Delete / Backspace — convert selected cell(s) to blank text cells.
      // Range selection converts every eligible cell; the underlying completion
      // counts are preserved and locked cells are skipped (handleDeleteCells).
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const range = rangeSelectionRef.current;
        handleDeleteCells(range ? range.cells : [cellMeta(sel.taskId, sel.date)]);
        return;
      }

      // Text-override cells (P9.1): Enter opens the inline text editor;
      // Shift+Enter is a no-op. Arrow navigation falls through unchanged.
      if (cellOverridesRef.current[`${sel.taskId}:${sel.date}`] !== undefined) {
        const { setEditingOverrideCell } = handlersRef.current;
        if (matchKeybind(e, kb.DECREMENT)) {
          e.preventDefault();
          return;
        }
        if (matchKeybind(e, kb.INCREMENT)) {
          e.preventDefault();
          if (!cellMeta(sel.taskId, sel.date).disabled) {
            setEditingOverrideCell({ taskId: sel.taskId, date: sel.date });
          }
          return;
        }
      }

      const rowIdx  = tasks.findIndex((t) => t.id === sel.taskId);
      const dateIdx = dates.indexOf(sel.date);

      if (matchKeybind(e, kb.MOVE_LEFT)) {
        e.preventDefault();
        setRangeEnd(null);
        const next = Math.max(0, dateIdx - 1);
        setSelectedCell({ taskId: sel.taskId, date: dates[next] });
        return;
      }
      if (matchKeybind(e, kb.MOVE_RIGHT)) {
        e.preventDefault();
        setRangeEnd(null);
        const next = Math.min(dates.length - 1, dateIdx + 1);
        setSelectedCell({ taskId: sel.taskId, date: dates[next] });
        return;
      }
      if (matchKeybind(e, kb.MOVE_UP)) {
        e.preventDefault();
        if (rowIdx < 0) return;
        setRangeEnd(null);
        const next = Math.max(0, rowIdx - 1);
        setSelectedCell({ taskId: tasks[next].id, date: sel.date });
        return;
      }
      if (matchKeybind(e, kb.MOVE_DOWN)) {
        e.preventDefault();
        if (rowIdx < 0) return;
        setRangeEnd(null);
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
      const { setSelectedCell, setRangeEnd, setJumpMode } = handlersRef.current;
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
        setRangeEnd(null);
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
        setRangeEnd(null);
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
    // Legacy views saved before the primary/secondary split may carry a
    // secondary filter (Urgent/Dormant/…) as their primary — map it to
    // All + that toggle so the visible task set is identical.
    if (SECONDARY_FILTERS.includes(validFilter)) {
      setActiveFilter(FILTERS.ALL);
      setSecondaryFilters([validFilter]);
    } else {
      setActiveFilter(validFilter);
      setSecondaryFilters(
        Array.isArray(view.secondary)
          ? view.secondary.filter((f) => SECONDARY_FILTERS.includes(f))
          : [],
      );
    }
    setGroupMode(validGroupMode);
    setSearchQuery(view.searchQuery || '');
    setSelectedCell(null);
    setRangeEnd(null);
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
        setRangeEnd(null);
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
        setRangeEnd(null);
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

    setRangeEnd(null);

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

      {/* ── Filter bar — status scope + secondary toggles + search (P10.0) ── */}
      <div className="ws-filter-bar">
        <div className="ws-filter-seg" role="group" aria-label="Task status scope">
          {PRIMARY_FILTERS.map((f) => (
            <button
              key={f}
              className={`ws-filter-seg-btn${activeFilter === f ? ' ws-filter-seg-btn--active' : ''}`}
              aria-pressed={activeFilter === f}
              onClick={() => setActiveFilter(f)}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
        <FilterMenu active={secondaryFilters} onToggle={toggleSecondaryFilter} />
        {secondaryFilters.map((f) => (
          <span key={f} className="ws-filter-chip">
            {FILTER_LABELS[f]}
            <button
              type="button"
              className="ws-filter-chip-x"
              aria-label={`Remove ${FILTER_LABELS[f]} filter`}
              onClick={() => toggleSecondaryFilter(f)}
            >
              ×
            </button>
          </span>
        ))}
        {secondaryFilters.length > 0 && (
          <button
            type="button"
            className="ws-filter-clear"
            onClick={() => setSecondaryFilters([])}
          >
            Clear filters
          </button>
        )}
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
          secondaryFilters={secondaryFilters}
          groupMode={groupMode}
          searchQuery={searchQuery}
          onApplyView={handleApplyView}
        />
        {quickJumpEnabled && (
          <button
            type="button"
            className="ws-filter-pill"
            onClick={() => { setRangeEnd(null); numericBufferRef.current = null; setJumpMode({ type: 'quick', value: '', error: '' }); }}
            title="Quick jump to row, task name, or date"
          >
            Jump
          </button>
        )}
      </div>

      {/* ── Inspector strip — compositionally framed EditBar ── */}
      <div className="ws-inspector-strip">
        <div className="ws-inspector-badge">
          {rangeSelection && rangeSelection.count > 1 ? '▸ range' : selectedCell ? '▸ cell' : '○ inspector'}
        </div>
        <div className="ws-inspector-body">
          <EditBar
            selectedCell={selectedCell}
            tasks={tasks}
            completions={completions}
            notes={notes}
            todayStr={todayStr}
            cellOverrides={cellOverrides}
            rangeSelection={rangeSelection}
            feedback={cellFeedback}
            onIncrement={handleIncrement}
            onClear={handleClear}
            onSetCount={handleSetCount}
            onSaveNote={handleSaveNote}
            onConvertToText={handleConvertToText}
            onRestoreCheckbox={handleRestoreCheckbox}
            onEditOverride={handleStartOverrideEdit}
            onRangeDelete={handleDeleteCells}
            onRangeRestore={handleRestoreCells}
          />
        </div>
      </div>

      <div className="ws-grid-canvas">
      <div
        className="grid-wrapper"
        onPointerDown={handleGridPointerDown}
        onClickCapture={handleGridClickCapture}
      >
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
                    cellOverrides={cellOverrides}
                    editingOverrideCell={editingOverrideCell}
                    selectedCell={selectedCell}
                    colLayout={colLayout}
                    selectedMetaCell={selectedMetaCell}
                    editingTextCell={editingTextCell}
                    rangeSelection={rangeSelection}
                    reorderEnabled={reorderEnabled}
                    isDragOver={dragOverId === task.id}
                    isDragSource={dragSrcId === task.id}
                    onHandlePointerDown={handleHandlePointerDown}
                    onIncrement={handleIncrement}
                    onEdit={openEdit}
                    onSelect={handleSelect}
                    onExtendRange={handleExtendRange}
                    onSelectMeta={handleSelectMeta}
                    onStartTextEdit={handleStartTextEdit}
                    onCommitTextEdit={handleCommitTextEdit}
                    onCancelTextEdit={handleCancelTextEdit}
                    onStartOverrideEdit={handleStartOverrideEdit}
                    onCommitOverrideText={handleCommitOverrideText}
                    onCancelOverrideEdit={handleCancelOverrideEdit}
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
          <div className="grid-status">
            No tasks match the current filters.
            {secondaryFilters.length > 0 && (
              <>
                {' '}
                <button
                  type="button"
                  className="ws-filter-clear"
                  onClick={() => setSecondaryFilters([])}
                >
                  Clear filters
                </button>
              </>
            )}
          </div>
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
