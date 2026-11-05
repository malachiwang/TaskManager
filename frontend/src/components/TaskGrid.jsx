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
  fetchNotes,
  upsertNote,
  reorderTasks,
  fetchSections,
  reorderSections,
  deleteSectionOrder,
  fetchDateCellOverrides,
  upsertDateCellOverride,
  deleteDateCellOverride,
  batchUpsertDateCellOverrides,
  batchDeleteDateCellOverrides,
  fetchHiatusPeriodsInRange,
} from '../api.js';
import TaskRow from './TaskRow.jsx';
import TaskModal from './TaskModal.jsx';
import EditBar from './EditBar.jsx';
import KeyboardHelp from './KeyboardHelp.jsx';
import WorkspaceSearch from './WorkspaceSearch.jsx';
import { FILTERS, FILTER_LABELS, PRIMARY_FILTERS, taskPassesFilter } from '../filters.js';
import { GROUP_MODES, groupTasks, uniqueSections } from '../grouping.js';
import { matchKeybind, resolveKeybinds } from '../keybinds.js';
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

// Resolve the drop target under a screen point for a task drag (P12.1).
// Task rows resolve to a before/after edge from the pointer's row half —
// 'after' on a section's last row is what makes the true bottom reachable.
// Section header rows and empty-section body rows (SECTION mode adds
// data-section-key/data-section-drop) resolve to section targets: 'start'
// inserts at the top of that section, 'into' drops into an empty section.
// The drag clone's <tr> carries no data attributes, so it is never matched.
function resolveDropTargetAt(clientX, clientY, excludeId) {
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    const tr = el.closest?.('tr[data-task-id], tr[data-section-key]');
    if (!tr) continue;
    if (tr.dataset.taskId !== undefined) {
      const id = parseInt(tr.dataset.taskId, 10);
      if (Number.isNaN(id)) continue;
      if (id === excludeId) return null; // hovering the source row — no target
      const rect = tr.getBoundingClientRect();
      const edge = clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      return { type: 'task', id, edge };
    }
    return {
      type: 'section',
      key: tr.dataset.sectionKey,
      mode: tr.dataset.sectionDrop, // 'start' (header row) | 'into' (empty body)
    };
  }
  return null;
}

function sameDropTarget(a, b) {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'task') return a.id === b.id && a.edge === b.edge;
  return a.key === b.key && a.mode === b.mode;
}

// Edge-autoscroll loop for pointer drags (P12.1) — keeps the far end of a
// long scrollable section reachable: holding the pointer near the top/bottom
// edge of the grid viewport scrolls it. Returns a stop() function.
// A timer (not requestAnimationFrame) on purpose: rAF is suspended when the
// window is occluded, and this is input handling, not animation.
function startEdgeAutoscroll(scrollEl, getPointerY, onScrollTick) {
  const EDGE_PX = 48;
  const MAX_STEP = 14;
  const TICK_MS = 40;
  const timer = setInterval(() => {
    const rect = scrollEl.getBoundingClientRect();
    const y = getPointerY();
    let dy = 0;
    if (y < rect.top + EDGE_PX) {
      dy = -Math.ceil(((rect.top + EDGE_PX - y) / EDGE_PX) * MAX_STEP);
    } else if (y > rect.bottom - EDGE_PX) {
      dy = Math.ceil(((y - (rect.bottom - EDGE_PX)) / EDGE_PX) * MAX_STEP);
    }
    if (dy !== 0) {
      const before = scrollEl.scrollTop;
      scrollEl.scrollTop = before + dy;
      if (scrollEl.scrollTop !== before) onScrollTick();
    }
  }, TICK_MS);
  return () => clearInterval(timer);
}

export default function TaskGrid({ onScheduleTask = null, viewMonth: sharedMonth = null, setViewMonth: setSharedMonth = null, searchTarget = null, onTargetConsumed = () => {} }) {
  // Real today — always fixed regardless of which month is displayed.
  const todayStr = toLocalDate(new Date());

  // Currently displayed month. Shape is { year, month } (1-indexed month).
  // Future modes (Rolling 30, Custom Range) can extend this state shape.
  // Held by App when provided, so Settings' CSV export follows the month the
  // grid last showed.
  const [localMonth, setLocalMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  const viewMonth = sharedMonth ?? localMonth;
  const setViewMonth = setSharedMonth ?? setLocalMonth;

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

  // Filtering / search state. activeFilter is the status scope
  // (All/Active/Hiatus/Finished).
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

  // Date-cell text overrides (P9.1) — map `${taskId}:${date}` → text. A key's
  // presence means that cell is in text mode (empty string is a valid, empty
  // text cell). editingOverrideCell mirrors editingTextCell for meta cells.
  const [cellOverrides, setCellOverrides] = useState({});
  const [editingOverrideCell, setEditingOverrideCell] = useState(null);

  // Hiatus periods (P11.0) — persisted intervals overlapping the visible month.
  // hiatusCells derives the per-cell lookup every guard and renderer shares:
  // a `${taskId}:${date}` key is present iff that date falls inside an interval
  // (start inclusive; end inclusive; open interval = no end yet).
  const [hiatusPeriods, setHiatusPeriods] = useState([]);

  const hiatusCells = useMemo(() => {
    const set = new Set();
    for (const p of hiatusPeriods) {
      for (const date of dates) {
        if (date >= p.start_date && (!p.end_date || date <= p.end_date)) {
          set.add(`${p.task_id}:${date}`);
        }
      }
    }
    return set;
  }, [hiatusPeriods, dates]);

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
  // dragOverRef mirrors dragOverTarget for synchronous reads in event handlers.
  // ghostElRef holds the imperative full-row clone overlay DOM node (position:fixed).
  const dragStateRef = useRef({ active: false });
  const dragOverRef = useRef(null);
  const ghostElRef = useRef(null);
  const [dragSrcId, setDragSrcId] = useState(null);
  const [dragOverTarget, setDragOverTarget] = useState(null);

  // Section drag state (P12.1) — mirrors the task-drag architecture: refs for
  // synchronous geometry, state only for the rendered indicator.
  const sectionDragRef = useRef({ active: false });
  const sectionDropRef = useRef(null);
  const [sectionDragKey, setSectionDragKey] = useState(null);
  const [sectionDropIdx, setSectionDropIdx] = useState(null);

  // Persisted manual section order (P12.1) — loaded with the grid data; the
  // single authority for SECTION-mode group order. Never derived from tasks.
  const [sections, setSections] = useState([]);

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

  // Any filter/search hides tasks — empty sections are suppressed then, since
  // a section that merely *looks* empty under a filter is a confusing target.
  const hasActiveFilters =
    activeFilter !== FILTERS.ALL || searchQuery.trim() !== '';

  // Group filtered tasks by the current groupMode.
  // SECTION mode follows the persisted manual order (P12.1) and renders
  // empty sections (drop targets) when nothing is filtered.
  const groupedTasks = useMemo(
    () => groupTasks(
      filteredTasks,
      groupMode,
      groupMode === GROUP_MODES.SECTION && sections.length > 0
        ? { sectionOrder: sections.map((s) => s.name), includeEmptySections: !hasActiveFilters }
        : {},
    ),
    [filteredTasks, groupMode, sections, hasActiveFilters],
  );

  // Section names for the Add/Edit modal combobox — persisted order first,
  // then any task-only stragglers not yet registered.
  const sectionSuggestions = useMemo(() => {
    const out = sections.map((s) => s.name).filter(Boolean);
    const seen = new Set(out);
    for (const n of uniqueSections(tasks)) {
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  }, [sections, tasks]);

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
    let hiatusCount = 0;
    for (const t of rows) {
      for (const date of dateSlice) {
        const hiatus = hiatusCells.has(`${t.id}:${date}`);
        const disabled = hiatus
          || date > todayStr
          || t.is_paused === 1
          || (t.active_from && date < t.active_from)
          || (t.end_date && date > t.end_date);
        const ov = cellOverrides[`${t.id}:${date}`];
        const isOverride = ov !== undefined;
        cells.push({ taskId: t.id, date, disabled, hiatus, isOverride, hasText: !!ov });
        if (hiatus) hiatusCount += 1;
        else if (disabled) lockedCount += 1;
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
      hiatusCount,
      taskIdSet: new Set(rows.map((t) => t.id)),
      minDate: dateSlice[0],
      maxDate: dateSlice[dateSlice.length - 1],
    };
  }, [selectedCell, rangeEnd, flatGroupedTasks, dates, cellOverrides, hiatusCells, todayStr]);

  const showFeedback = useCallback((msg) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setCellFeedback(msg);
    feedbackTimerRef.current = setTimeout(() => setCellFeedback(null), 5000);
  }, []);

  // ---------------------------------------------------------------------------
  // Data fetching — reruns when month changes (dates reference changes)
  // ---------------------------------------------------------------------------

  // Every request below is timeout-bounded in api.js, so this Promise.all
  // always settles and `.finally` always clears the loading gate — the grid
  // can no longer be stranded on "Loading…" by a request that hangs.
  // The all-or-nothing load is deliberate: hiatus intervals and cell text
  // overrides decide whether a date cell is interactive and what it means, so
  // a partial render would show misleading cells.
  //
  // `gate` engages the full-surface loading state. Only the initial mount load
  // and the explicit Retry do that; post-mutation refreshes and month changes
  // swap data in place, as before, so the grid does not flash.
  const loadData = useCallback((options) => {
    const start = dates[0];
    const end = dates[dates.length - 1];
    if (options?.gate === true) setLoading(true);
    setError(null);
    return Promise.all([
      fetchTasks(), fetchCompletions(start, end), fetchNotes(start, end),
      fetchDateCellOverrides(start, end), fetchHiatusPeriodsInRange(start, end),
      fetchSections(),
    ])
      .then(([taskList, compList, noteList, overrideList, hiatusList, sectionList]) => {
        setTasks(taskList);
        setSections(sectionList);
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
        setHiatusPeriods(hiatusList);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [dates]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Manual recovery from a failed/timed-out load — no app restart needed.
  const retryLoad = useCallback(() => { loadData({ gate: true }); }, [loadData]);

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
    dragStateRef.current = {
      active: true, taskId,
      pointerOffsetY: e.clientY - trRect.top,
      lastX: e.clientX, lastY: e.clientY,
    };
    dragOverRef.current = null;
    setDragSrcId(taskId);

    // Accept a raw hit-test target only where a drop would actually land —
    // the indicator and the drop share this rule, so the line never lies.
    // Same rendered group: always. Cross-group: only SECTION mode (the drag
    // becomes an atomic section move). Section header/empty targets: SECTION
    // mode only. NONE mode is one flat list.
    function validateDropTarget(target) {
      if (!target) return null;
      if (target.type === 'task') {
        if (groupMode === GROUP_MODES.NONE) return target;
        const srcGroup = groupKeyById.get(taskId);
        const tgtGroup = groupKeyById.get(target.id);
        if (srcGroup !== undefined && srcGroup === tgtGroup) return target;
        return groupMode === GROUP_MODES.SECTION ? target : null;
      }
      return groupMode === GROUP_MODES.SECTION ? target : null;
    }

    function updateIndicator(x, y) {
      const valid = validateDropTarget(resolveDropTargetAt(x, y, taskId));
      if (!sameDropTarget(valid, dragOverRef.current)) {
        dragOverRef.current = valid;
        setDragOverTarget(valid);
      }
    }

    function onPointerMove(ev) {
      if (!dragStateRef.current.active) return;
      dragStateRef.current.lastX = ev.clientX;
      dragStateRef.current.lastY = ev.clientY;
      if (ghostElRef.current) {
        ghostElRef.current.style.top = (ev.clientY - dragStateRef.current.pointerOffsetY) + 'px';
      }
      updateIndicator(ev.clientX, ev.clientY);
    }

    // Long sections: holding the pointer near the grid's top/bottom edge
    // scrolls, and the indicator re-resolves against the rows that scrolled
    // under the (stationary) pointer.
    const stopAutoscroll = startEdgeAutoscroll(
      scrollEl,
      () => dragStateRef.current.lastY,
      () => updateIndicator(dragStateRef.current.lastX, dragStateRef.current.lastY),
    );

    function cleanup() {
      dragStateRef.current.active = false;
      dragOverRef.current = null;
      stopAutoscroll();
      if (ghostElRef.current) {
        ghostElRef.current.remove();
        ghostElRef.current = null;
      }
      setDragSrcId(null);
      setDragOverTarget(null);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', cleanup);
      window.removeEventListener('keydown', onEscKey);
      window.removeEventListener('blur', cleanup);
    }

    function onPointerUp(ev) {
      const srcId = dragStateRef.current.taskId;
      // Re-resolve at drop time; fall back to the last valid hover so a drop
      // that lands between pointermove samples still counts.
      const resolved = validateDropTarget(resolveDropTargetAt(ev.clientX, ev.clientY, srcId));
      const target = resolved ?? dragOverRef.current;
      cleanup();
      if (!srcId || !target) return;
      applyTaskDrop(srcId, target);
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

  // Apply a completed task drop: recompute the full ordered list (hidden/
  // filtered tasks keep their relative order via anchored splices) and, for a
  // cross-section drop in SECTION mode, the task's new section — sent to the
  // backend in ONE request so position + container change atomically.
  function applyTaskDrop(srcId, target) {
    const prev = tasks;
    const src = prev.find((t) => t.id === srcId);
    if (!src) return;
    const srcSection = src.section?.trim() || '';
    let destSection = null; // non-null → section changes with this drop

    const next = prev.filter((t) => t.id !== srcId);
    if (target.type === 'task') {
      const anchor = prev.find((t) => t.id === target.id);
      if (!anchor) return;
      const idx = next.findIndex((t) => t.id === target.id);
      if (idx === -1) return;
      next.splice(target.edge === 'before' ? idx : idx + 1, 0, src);
      if (groupMode === GROUP_MODES.SECTION) {
        const anchorSection = anchor.section?.trim() || '';
        if (anchorSection !== srcSection) destSection = anchorSection;
      }
    } else {
      const sectionName = target.key === '(no section)' ? '' : target.key;
      if (target.mode === 'start') {
        // Insert before the section's first task in the FULL list; a section
        // with no tasks at all behaves like 'into'.
        const idx = next.findIndex((t) => (t.section?.trim() || '(no section)') === target.key);
        next.splice(idx === -1 ? next.length : idx, 0, src);
      } else {
        next.push(src);
      }
      if (sectionName !== srcSection) destSection = sectionName;
    }

    const optimistic = destSection !== null
      ? next.map((t) => (t.id === srcId ? { ...t, section: destSection } : t))
      : next;
    setTasks(optimistic);
    const sectionUpdates = destSection !== null
      ? [{ id: srcId, section: destSection }]
      : undefined;
    reorderTasks(optimistic.map((t) => t.id), sectionUpdates)
      .catch(() => setTasks(prev));
  }

  // ---------------------------------------------------------------------------
  // Section drag (P12.1) — same interaction grammar as task rows: grab the
  // handle, an insertion line tracks the pointer, drop persists the order.
  // Only meaningful in SECTION group mode.
  // ---------------------------------------------------------------------------

  function handleSectionPointerDown(e, group) {
    if (groupMode !== GROUP_MODES.SECTION || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const headerTr = e.target.closest('tr');
    const scrollEl = headerTr?.closest('.grid-wrapper');
    if (!scrollEl) return;

    // Lightweight floating label — section rows span the whole sheet, so a
    // full-row clone would just be a wide bar; the name chip reads better.
    const ghost = document.createElement('div');
    ghost.className = 'section-drag-ghost';
    ghost.textContent = group.label;
    ghost.style.left = (e.clientX + 14) + 'px';
    ghost.style.top = (e.clientY - 12) + 'px';
    document.body.appendChild(ghost);

    sectionDragRef.current = {
      active: true, key: group.key, sectionName: group.sectionName,
      lastX: e.clientX, lastY: e.clientY,
    };
    sectionDropRef.current = null;
    setSectionDragKey(group.key);

    // Insertion index over the rendered section blocks: a block spans from
    // its header's top to the next header's top (last block ends at the
    // tbody's bottom). The pointer inserts after every block whose midpoint
    // it has passed.
    function updateIdx(y) {
      const headers = Array.from(
        scrollEl.querySelectorAll('tr.ws-section-row[data-section-key]'),
      );
      if (headers.length === 0) return;
      const tbodyBottom = headers[0].closest('tbody').getBoundingClientRect().bottom;
      let idx = 0;
      for (let i = 0; i < headers.length; i++) {
        const top = headers[i].getBoundingClientRect().top;
        const bottom = i + 1 < headers.length
          ? headers[i + 1].getBoundingClientRect().top
          : tbodyBottom;
        if (y > (top + bottom) / 2) idx = i + 1;
      }
      if (idx !== sectionDropRef.current) {
        sectionDropRef.current = idx;
        setSectionDropIdx(idx);
      }
    }
    updateIdx(e.clientY);

    function onPointerMove(ev) {
      if (!sectionDragRef.current.active) return;
      sectionDragRef.current.lastX = ev.clientX;
      sectionDragRef.current.lastY = ev.clientY;
      ghost.style.left = (ev.clientX + 14) + 'px';
      ghost.style.top = (ev.clientY - 12) + 'px';
      updateIdx(ev.clientY);
    }

    const stopAutoscroll = startEdgeAutoscroll(
      scrollEl,
      () => sectionDragRef.current.lastY,
      () => updateIdx(sectionDragRef.current.lastY),
    );

    function cleanup() {
      sectionDragRef.current.active = false;
      stopAutoscroll();
      ghost.remove();
      setSectionDragKey(null);
      setSectionDropIdx(null);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', cleanup);
      window.removeEventListener('keydown', onEscKey);
      window.removeEventListener('blur', cleanup);
    }

    function onPointerUp() {
      const toIdx = sectionDropRef.current;
      const dragged = sectionDragRef.current;
      cleanup();
      if (toIdx == null) return;
      applySectionDrop(dragged.sectionName, toIdx);
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

  // toIdx is an insertion index over the DISPLAYED section blocks. The new
  // order is applied to the FULL persisted list (sections hidden by filters
  // keep their place) by inserting relative to the displayed neighbor.
  function applySectionDrop(sectionName, toIdx) {
    const displayed = groupedTasks.map((g) => g.sectionName);
    const fromIdx = displayed.indexOf(sectionName);
    if (fromIdx === -1) return;
    if (toIdx === fromIdx || toIdx === fromIdx + 1) return; // dropped in place

    const fullWithout = sections.map((s) => s.name).filter((n) => n !== sectionName);
    let insertAt;
    if (toIdx >= displayed.length) {
      const lastDisplayed = displayed.filter((n) => n !== sectionName).pop();
      insertAt = lastDisplayed === undefined ? fullWithout.length
        : fullWithout.indexOf(lastDisplayed) + 1;
    } else {
      const anchorName = displayed[toIdx];
      const anchorIdx = fullWithout.indexOf(anchorName);
      insertAt = anchorIdx === -1 ? fullWithout.length : anchorIdx;
    }
    const newOrder = [...fullWithout];
    newOrder.splice(insertAt, 0, sectionName);

    const prevSections = sections;
    const byName = new Map(sections.map((s) => [s.name, s]));
    setSections(newOrder.map((n, i) => ({ ...(byName.get(n) ?? { name: n }), position: i })));
    reorderSections(newOrder).catch(() => setSections(prevSections));
  }

  // Remove an EMPTY section's ordering row (the affordance lives on the
  // empty-section body row; the backend refuses populated sections anyway).
  async function handleRemoveSection(group) {
    try {
      await deleteSectionOrder(group.sectionName);
      setSections((prev) => prev.filter((s) => s.name !== group.sectionName));
    } catch (err) {
      console.error('remove section failed:', err);
    }
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
  // after-end/paused) cells are skipped and reported; hiatus-interval blanks
  // (P11.0) are skipped and reported separately.
  const handleDeleteCells = useCallback(async (cells) => {
    const eligible = cells.filter((c) => !c.disabled);
    const skippedHiatus = cells.filter((c) => c.hiatus).length;
    const skipped = cells.length - eligible.length - skippedHiatus;
    const skipMsg =
      (skipped > 0 ? ` · skipped ${skipped} locked cell${skipped !== 1 ? 's' : ''}` : '')
      + (skippedHiatus > 0 ? ` · skipped ${skippedHiatus} hiatus cell${skippedHiatus !== 1 ? 's' : ''}` : '');
    // Only cells that actually change: checkbox cells gain a blank override;
    // override cells with text get blanked. Already-blank overrides are no-ops.
    const items = eligible
      .filter((c) => !c.isOverride || c.hasText)
      .map((c) => ({ task_id: c.taskId, date: c.date, text: '' }));
    if (items.length === 0) {
      if (skipped > 0 || skippedHiatus > 0) showFeedback(`Nothing to convert —${skipMsg.replace(' ·', '')}.`);
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
        + skipMsg
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
  const hiatusCellsRef     = useRef(new Set());
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
  const searchInputRef       = useRef(null);
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
  hiatusCellsRef.current      = hiatusCells;
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
  }, [activeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Workspace search (tm-clean 11): show everything, then select and scroll to
  // the hit's cell once the target month's rows are rendered. A hit that is
  // not in the month (e.g. removed meanwhile) is simply consumed.
  useEffect(() => {
    if (!searchTarget || searchTarget.kind !== 'task') return;
    setActiveFilter(FILTERS.ALL);
    setSearchQuery('');
    setRangeEnd(null);
    setSelectedMetaCell(null);
  }, [searchTarget]);
  useEffect(() => {
    if (!searchTarget || searchTarget.kind !== 'task' || loading) return undefined;
    if (activeFilter !== FILTERS.ALL || searchQuery !== '') return undefined;
    const date = searchTarget.date && dates.includes(searchTarget.date) ? searchTarget.date : null;
    if (searchTarget.date && !date) return undefined; // month switch still pending
    if (!flatGroupedTasks.some((t) => t.id === searchTarget.id)) { onTargetConsumed(); return undefined; }
    const cellDate = date || dates[0];
    setSelectedCell({ taskId: searchTarget.id, date: cellDate });
    const frame = requestAnimationFrame(() => {
      document.querySelector(`tr[data-task-id="${searchTarget.id}"]`)?.scrollIntoView({ block: 'center', inline: 'nearest' });
      document.querySelector(`td[data-dc-task="${searchTarget.id}"][data-dc-date="${cellDate}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      onTargetConsumed();
    });
    return () => cancelAnimationFrame(frame);
  }, [searchTarget, loading, activeFilter, searchQuery, flatGroupedTasks, dates, onTargetConsumed]);

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
        const hiatus = hiatusCellsRef.current.has(`${taskId}:${date}`);
        const disabled = !task || hiatus || task.is_paused === 1
          || date > toLocalDate(new Date())
          || (task.active_from && date < task.active_from)
          || (task.end_date && date > task.end_date);
        const ov = cellOverridesRef.current[`${taskId}:${date}`];
        return { taskId, date, disabled, hiatus, isOverride: ov !== undefined, hasText: !!ov };
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

      // Typing into a selected, enabled TEXT-OVERRIDE date cell (P10.1) —
      // spreadsheet-style: a printable character starts text entry seeded with
      // that character, replacing the cell's existing text (committed on
      // Enter/blur; Escape cancels). Normal checkbox cells deliberately do NOT
      // accept typing — delete the checkbox first (Delete/Backspace creates a
      // blank text cell), then type. This keeps single-letter app shortcuts
      // (N/E/? etc.) working while a checkbox cell is selected.
      if (sel && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const meta = cellMeta(sel.taskId, sel.date);
        if (meta.isOverride && !meta.disabled) {
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

      // / — focus the task search box (customizable via FOCUS_SEARCH)
      if (matchKeybind(e, kb.FOCUS_SEARCH)) {
        e.preventDefault();
        searchInputRef.current?.focus();
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
        if (hiatusCellsRef.current.has(`${sel.taskId}:${sel.date}`)) return; // hiatus blank (P11.0)
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

  // Edit Task (tm-clean 12) acts on the task of the selected date or meta cell.
  const selectedTask = tasks.find((t) => t.id === (selectedCell?.taskId ?? selectedMetaCell?.taskId));

  if (loading) return <div className="grid-status">Loading…</div>;
  if (error) return (
    <div className="grid-status error">
      Could not load workspace data.
      <span className="grid-status-detail">{error}</span>
      <span className="grid-status-detail grid-status-hint">
        If this keeps happening, check the backend:{' '}
        <code>uvicorn backend.main:app --reload</code>
      </span>
      <div className="grid-status-actions">
        <button className="grid-status-retry" onClick={retryLoad}>Retry</button>
      </div>
    </div>
  );

  return (
    <>
      {/* ── Tier 1: Operations shelf — ink dark, primary actions only ── */}
      <div className="ws-grid-shelf">
        <div className="ws-shelf-left">
          <button className="ws-shelf-btn ws-shelf-btn--primary" onClick={openAdd}>+ Add Task</button>
          <button
            className="ws-shelf-btn"
            disabled={!selectedTask}
            onClick={() => selectedTask && openEdit(selectedTask)}
            title={selectedTask ? undefined : 'Select a task first'}
          >Edit Task</button>
        </div>
      </div>

      {/* ── Tier 2: Sheet header — paper surface, identity + nav + status ── */}
      <div className="ws-sheet-header ws-sheet-header--centered">
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
          <WorkspaceSearch />
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
        <input
          ref={searchInputRef}
          className="ws-filter-input"
          type="search"
          placeholder="Search tasks…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') e.target.blur(); }}
        />
        {filteredTasks.length !== tasks.length && (
          <span className="ws-filter-count">
            {filteredTasks.length} of {tasks.length}
          </span>
        )}
        <GroupSelect value={groupMode} onChange={setGroupMode} />
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
            hiatusCells={hiatusCells}
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
            {groupedTasks.map((group, groupIdx) => (
              <Fragment key={group.key}>
                {group.label !== null && (
                  <tr
                    className={[
                      'ws-section-row',
                      sectionDropIdx === groupIdx ? 'ws-section-drop-before' : '',
                      sectionDragKey === group.key ? 'ws-section-drag-source' : '',
                      dragOverTarget?.type === 'section'
                        && dragOverTarget.mode === 'start'
                        && dragOverTarget.key === group.key ? 'ws-drop-below' : '',
                    ].filter(Boolean).join(' ')}
                    {...(groupMode === GROUP_MODES.SECTION
                      ? { 'data-section-key': group.key, 'data-section-drop': 'start' }
                      : {})}
                  >
                    {/* Frozen td: sticky left, spans all 8 frozen columns.
                        Uses the same position:sticky mechanism as TaskRow sticky cells —
                        directly on the <td>, not a child element. Avoids jank. */}
                    <td className="ws-section-frozen" colSpan={8}>
                      {groupMode === GROUP_MODES.SECTION && (
                        <span
                          className="drag-handle section-drag-handle"
                          title="Drag to reorder section"
                          onPointerDown={(e) => handleSectionPointerDown(e, group)}
                        >⠿</span>
                      )}
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
                {/* Empty section (P12.1) — stays rendered and droppable. */}
                {groupMode === GROUP_MODES.SECTION && group.label !== null
                  && group.tasks.length === 0 && (
                  <tr
                    className={`ws-section-empty-row${
                      dragOverTarget?.type === 'section'
                        && dragOverTarget.mode === 'into'
                        && dragOverTarget.key === group.key ? ' ws-drop-into' : ''}`}
                    data-section-key={group.key}
                    data-section-drop="into"
                  >
                    <td className="ws-section-empty-frozen" colSpan={8}>
                      <span className="ws-section-empty-note">No tasks — drag a task here</span>
                      <button
                        type="button"
                        className="ws-section-empty-remove"
                        title="Remove this empty section from the list"
                        onClick={() => handleRemoveSection(group)}
                      >Remove section</button>
                    </td>
                    <td className="ws-section-empty-overflow" colSpan={3 + dates.length}></td>
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
                    hiatusCells={hiatusCells}
                    editingOverrideCell={editingOverrideCell}
                    selectedCell={selectedCell}
                    colLayout={colLayout}
                    selectedMetaCell={selectedMetaCell}
                    editingTextCell={editingTextCell}
                    rangeSelection={rangeSelection}
                    reorderEnabled={reorderEnabled}
                    dragOverEdge={dragOverTarget?.type === 'task' && dragOverTarget.id === task.id
                      ? dragOverTarget.edge : null}
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
            {/* Section-drag "after the last section" indicator (P12.1). */}
            {sectionDropIdx != null && sectionDropIdx >= groupedTasks.length && (
              <tr className="ws-section-end-indicator" aria-hidden="true">
                <td colSpan={11 + dates.length}></td>
              </tr>
            )}
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
          sectionSuggestions={sectionSuggestions}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={closeModal}
          onHiatusChanged={loadData}
          onSchedule={onScheduleTask ? (task) => { closeModal(); onScheduleTask(task); } : null}
        />
      )}
    </>
  );
}
