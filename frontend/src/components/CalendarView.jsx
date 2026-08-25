import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchTasks, fetchSessions, fetchDepthWindows, fetchCompletions,
  createTask, updateTask, deleteTask,
  createSession, updateSession, deleteSession,
  createDepthWindow, deleteDepthWindow,
  upsertCompletion, setCompletionCount,
} from '../api.js';
import {
  SNAP_MINUTES, MIN_SESSION_MINUTES, DEFAULT_SESSION_MINUTES, DAY_MINUTES,
  todayIso, isoDate, addDaysIso, weekDates, isWeekendIso, weekdayOfIso,
  plannedDate, plannedMinutes, combinePlanned, combinePlannedEnd,
  snapMinutes, clampDayMinutes, sessionSegmentOnDate,
  formatHourLabel, formatTimeRange, durationLabel,
  dayHeaderLabel, fullDateLabel, rangeLabel,
  windowsOnDate, layoutBlocks, minutesToPx, pxToMinutes,
} from '../calendarUtils.js';
import TaskModal from './TaskModal.jsx';

// Pointer capture keeps a drag alive when the cursor leaves the grid. It is
// an enhancement, not a requirement — synthetic events (tests, automation)
// have no active pointer and would throw NotFoundError.
function capturePointer(el, pointerId) {
  try {
    el?.setPointerCapture(pointerId);
  } catch {
    /* no active pointer — drag still works via event bubbling */
  }
}

// Calendar (P12.0) — Google Calendar-style week/day scheduling surface over
// canonical TaskManager records. Sessions (scheduled time allocations) render
// as blocks; every mutation here goes through the same task/session/completion
// endpoints the rest of the app uses — there is no separate calendar store.
//
// Interaction grammar:
//   drag empty time        → select interval, creation popover on release
//   modifier + drag        → inline quick-create task (⌥ on macOS, Ctrl elsewhere;
//                            Ctrl+click is the macOS right-click, so ⌥ there)
//   shift + drag           → create a Depth Window (background capacity region)
//   drag block             → reschedule (day + time, duration preserved)
//   drag block bottom edge → resize (change planned duration)
//   click block            → detail popover (complete, depth, open, delete)
//   T / W / D / ← → / Esc  → today, week view, day view, prev/next, cancel

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform ?? '');
const QUICK_CREATE_HINT = IS_MAC ? '⌥ drag' : 'Ctrl drag';
const DRAG_THRESHOLD_MIN = 8; // unsnapped minutes of travel before a press counts as a drag

const DEPTH_LABELS = { 1: 'D1 · Deep', 2: 'D2 · Focused', 3: 'D3 · Shallow' };

function isQuickCreate(e) {
  return e.altKey || (!IS_MAC && e.ctrlKey);
}

function DepthSeg({ value, onChange, allowNone = true }) {
  const opts = allowNone ? [0, 1, 2, 3] : [1, 2, 3];
  return (
    <div className="cal-depth-seg" role="group" aria-label="Cognitive depth">
      {opts.map((d) => (
        <button
          key={d}
          type="button"
          className={`cal-depth-seg-btn${value === d ? ' is-active' : ''}${d ? ` cal-depth-seg-btn--d${d}` : ''}`}
          aria-pressed={value === d}
          title={d === 0 ? 'No depth' : DEPTH_LABELS[d]}
          onClick={() => onChange(d)}
        >
          {d === 0 ? '—' : `D${d}`}
        </button>
      ))}
    </div>
  );
}

export default function CalendarView() {
  const [viewMode, setViewMode] = useState('week'); // 'week' | 'day'
  const [anchorIso, setAnchorIso] = useState(() => todayIso());

  const [tasks, setTasks] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [upcomingSessions, setUpcomingSessions] = useState([]);
  const [windows, setWindows] = useState([]);
  const [completions, setCompletions] = useState({}); // "taskId:date" -> count
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Interaction state. Drag is mirrored in a ref: pointer events can arrive
  // faster than React re-renders (a fast flick is pointerdown+move+up inside
  // one frame), so handlers read/write dragRef synchronously and the state
  // copy exists only to render ghosts.
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const updateDrag = useCallback((next) => {
    dragRef.current = next;
    setDrag(next);
  }, []);
  const [creator, setCreator] = useState(null);
  const [selected, setSelected] = useState(null); // { sessionId, rect }
  const [editingTask, setEditingTask] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Drawer drag uses HTML5 DnD; the dragged task lives in a ref for the same
  // reason as dragRef — drop can fire before any dragstart state would commit.
  const drawerDragRef = useRef(null);
  const [dropPreview, setDropPreview] = useState(null);

  const daysRef = useRef(null);
  const scrollRef = useRef(null);
  const creatorInputRef = useRef(null);
  const loadedOnce = useRef(false);

  const dates = useMemo(
    () => (viewMode === 'week' ? weekDates(anchorIso) : [anchorIso]),
    [viewMode, anchorIso],
  );
  const rangeStart = dates[0];
  const rangeEnd = dates[dates.length - 1];

  // ── Now indicator — updates every 30s ──────────────────────────────────────
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const nowDate = new Date(nowTick);
  const nowIso = isoDate(nowDate);
  const nowMin = nowDate.getHours() * 60 + nowDate.getMinutes();

  // ── Data loading — same shape as the other self-fetching views ────────────
  const loadData = useCallback(async ({ gate = false } = {}) => {
    if (gate) setLoading(true);
    setError('');
    try {
      const today = todayIso();
      const [tasksData, rangeSessions, upcoming, windowsData, completionRows] =
        await Promise.all([
          fetchTasks(),
          fetchSessions(rangeStart, rangeEnd),
          fetchSessions(today, addDaysIso(today, 365)),
          fetchDepthWindows(),
          fetchCompletions(rangeStart, rangeEnd),
        ]);
      setTasks(tasksData);
      setSessions(rangeSessions);
      setUpcomingSessions(upcoming);
      setWindows(windowsData);
      const compMap = {};
      for (const row of completionRows) {
        compMap[`${row.task_id}:${row.completion_date}`] = row.completion_count;
      }
      setCompletions(compMap);
      loadedOnce.current = true;
    } catch (err) {
      console.error('calendar load failed:', err);
      setError(err?.message || 'Failed to load calendar data.');
    } finally {
      if (gate) setLoading(false);
    }
  }, [rangeStart, rangeEnd]);

  useEffect(() => {
    loadData({ gate: !loadedOnce.current });
  }, [loadData]);

  // Initial scroll to morning so the working day is on screen.
  useEffect(() => {
    if (!loading && scrollRef.current) {
      scrollRef.current.scrollTop = minutesToPx(7 * 60) - 6;
    }
  }, [loading, viewMode]);

  useEffect(() => {
    if (creator && creatorInputRef.current) creatorInputRef.current.focus();
  }, [creator?.dateIso, creator?.startMin, creator?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  function closeOverlays() {
    setCreator(null);
    setSelected(null);
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  const shiftPeriod = useCallback((dir) => {
    setAnchorIso((a) => addDaysIso(a, dir * (viewMode === 'week' ? 7 : 1)));
    closeOverlays();
  }, [viewMode]);

  const goToday = useCallback(() => {
    setAnchorIso(todayIso());
    closeOverlays();
  }, []);

  // ── Keyboard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e) {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
      if (editingTask) return;
      if (e.key === 'Escape') {
        updateDrag(null);
        closeOverlays();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === 't') goToday();
      else if (k === 'w') setViewMode('week');
      else if (k === 'd') setViewMode('day');
      else if (e.key === 'ArrowLeft') shiftPeriod(-1);
      else if (e.key === 'ArrowRight') shiftPeriod(1);
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editingTask, goToday, shiftPeriod, updateDrag]);

  // ── Pointer → slot math ────────────────────────────────────────────────────
  const pointToSlot = useCallback((clientX, clientY) => {
    const el = daysRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const colW = rect.width / dates.length;
    let idx = Math.floor((clientX - rect.left) / colW);
    idx = Math.max(0, Math.min(dates.length - 1, idx));
    const minutes = clampDayMinutes(pxToMinutes(clientY - rect.top));
    return { dateIso: dates[idx], minutes };
  }, [dates]);

  // ── Empty-grid interactions (select / quick-create / depth window) ────────
  function onGridPointerDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('.cal-block, .cal-creator-inline, .cal-window-del, .cal-now-line')) return;
    const slot = pointToSlot(e.clientX, e.clientY);
    if (!slot) return;
    closeOverlays();
    const anchorMin = Math.floor(slot.minutes / SNAP_MINUTES) * SNAP_MINUTES;
    updateDrag({
      type: e.shiftKey ? 'window' : 'select',
      quick: isQuickCreate(e),
      dateIso: slot.dateIso,
      anchorMin,
      anchorRawMin: slot.minutes,
      startMin: anchorMin,
      endMin: Math.min(DAY_MINUTES, anchorMin + SNAP_MINUTES),
      moved: false,
    });
    capturePointer(e.currentTarget, e.pointerId);
  }

  function onGridPointerMove(e) {
    const d = dragRef.current;
    if (!d) return;
    const slot = pointToSlot(e.clientX, e.clientY);
    if (!slot) return;
    if (d.type === 'select' || d.type === 'window') {
      const cur = snapMinutes(slot.minutes);
      updateDrag({
        ...d,
        // Modifiers are live during the drag: pressing ⇧ mid-selection turns
        // it into a depth-window drag, and the quick-create modifier can be
        // added after the press.
        type: e.shiftKey ? 'window' : 'select',
        quick: d.quick || isQuickCreate(e),
        moved: d.moved || Math.abs(slot.minutes - d.anchorRawMin) > DRAG_THRESHOLD_MIN,
        startMin: Math.min(d.anchorMin, cur),
        endMin: Math.max(Math.min(DAY_MINUTES, d.anchorMin + SNAP_MINUTES), cur),
      });
    } else if (d.type === 'move') {
      const startMin = Math.max(0, Math.min(DAY_MINUTES - d.durMin,
        snapMinutes(slot.minutes - d.grabOffsetMin)));
      updateDrag({
        ...d,
        dateIso: slot.dateIso,
        startMin,
        moved: d.moved || d.dateIso !== slot.dateIso
          || Math.abs(slot.minutes - d.anchorRawMin) > DRAG_THRESHOLD_MIN,
      });
    } else if (d.type === 'resize') {
      updateDrag({
        ...d,
        endMin: Math.max(d.startMin + MIN_SESSION_MINUTES,
          Math.min(DAY_MINUTES, snapMinutes(slot.minutes))),
        moved: true,
      });
    }
  }

  function onGridPointerUp() {
    const d = dragRef.current;
    if (!d) return;
    updateDrag(null);
    if (d.type === 'select' || d.type === 'window') {
      let { startMin, endMin } = d;
      if (!d.moved) {
        startMin = d.anchorMin;
        endMin = Math.min(DAY_MINUTES, startMin + DEFAULT_SESSION_MINUTES);
      }
      if (endMin - startMin < MIN_SESSION_MINUTES) endMin = Math.min(DAY_MINUTES, startMin + MIN_SESSION_MINUTES);
      if (d.type === 'window') {
        setCreator({ kind: 'window', dateIso: d.dateIso, startMin, endMin, depth: 1, weekly: false, saving: false, error: '' });
      } else {
        setCreator({
          kind: 'task',
          mode: d.quick ? 'inline' : 'popover',
          dateIso: d.dateIso, startMin, endMin,
          title: '', depth: 0, saving: false, error: '',
        });
      }
    } else if (d.type === 'move') {
      if (d.moved) commitMove(d);
      else openSessionPopover(d.session, d.blockRect);
    } else if (d.type === 'resize') {
      if (d.moved) commitResize(d);
      else openSessionPopover(d.session, d.blockRect);
    }
  }

  function onGridPointerCancel() {
    updateDrag(null);
    setDropPreview(null);
  }

  // ── Block interactions ─────────────────────────────────────────────────────
  function onBlockPointerDown(e, session, seg) {
    if (e.button !== 0) return;
    if (e.target.closest('.cal-block-check')) return;
    e.stopPropagation();
    const slot = pointToSlot(e.clientX, e.clientY);
    if (!slot) return;
    closeOverlays();
    const blockRect = e.currentTarget.getBoundingClientRect();
    if (e.target.closest('.cal-block-resize')) {
      updateDrag({
        type: 'resize',
        session,
        dateIso: plannedDate(session.planned_start),
        startMin: plannedMinutes(session.planned_start),
        endMin: seg.endMin,
        anchorRawMin: slot.minutes,
        blockRect,
        moved: false,
      });
    } else {
      updateDrag({
        type: 'move',
        session,
        durMin: Math.min(session.planned_minutes, DAY_MINUTES),
        grabOffsetMin: slot.minutes - seg.startMin,
        dateIso: slot.dateIso,
        startMin: seg.startMin,
        anchorRawMin: slot.minutes,
        blockRect,
        moved: false,
      });
    }
    capturePointer(daysRef.current, e.pointerId);
  }

  async function commitMove(d) {
    const start = combinePlanned(d.dateIso, d.startMin);
    const end = combinePlannedEnd(d.dateIso, d.startMin + d.durMin);
    setSessions((prev) => prev.map((s) =>
      (s.id === d.session.id ? { ...s, planned_start: start, planned_end: end } : s)));
    try {
      await updateSession(d.session.id, { planned_start: start, planned_end: end });
    } catch (err) {
      console.error('reschedule failed:', err);
    }
    loadData();
  }

  async function commitResize(d) {
    const end = combinePlannedEnd(d.dateIso, d.endMin);
    setSessions((prev) => prev.map((s) =>
      (s.id === d.session.id ? { ...s, planned_end: end } : s)));
    try {
      await updateSession(d.session.id, { planned_end: end });
    } catch (err) {
      console.error('resize failed:', err);
    }
    loadData();
  }

  function openSessionPopover(session, rect) {
    setCreator(null);
    setSelected({ sessionId: session.id, rect });
  }

  // ── Completion — session status + real completion record ──────────────────
  // Checking a block completes the session AND increments the task's
  // completion_count for that date (the same record the grid edits).
  // Future-dated sessions only flip session status: the backend deliberately
  // rejects future completion dates, matching grid semantics.
  async function toggleComplete(session) {
    const dateIso = plannedDate(session.planned_start);
    const completing = session.status !== 'completed';
    setSessions((prev) => prev.map((s) =>
      (s.id === session.id ? { ...s, status: completing ? 'completed' : 'scheduled' } : s)));
    try {
      await updateSession(session.id, { status: completing ? 'completed' : 'scheduled' });
      if (dateIso <= todayIso()) {
        if (completing) {
          await upsertCompletion(session.task_id, dateIso);
        } else {
          const count = completions[`${session.task_id}:${dateIso}`] ?? 0;
          if (count > 0) await setCompletionCount(session.task_id, dateIso, count - 1);
        }
      }
    } catch (err) {
      console.error('toggle completion failed:', err);
    }
    loadData();
  }

  // ── Creation ───────────────────────────────────────────────────────────────
  async function commitCreateTask() {
    const c = creator;
    if (!c || c.saving) return;
    const title = c.title.trim();
    if (!title) {
      setCreator((cc) => (cc ? { ...cc, error: 'Enter a task name.' } : cc));
      return;
    }
    setCreator((cc) => (cc ? { ...cc, saving: true, error: '' } : cc));
    try {
      const task = await createTask({
        name: title,
        depth: c.depth || 0,
        estimated_minutes: c.endMin - c.startMin,
      });
      await createSession({
        task_id: task.id,
        planned_start: combinePlanned(c.dateIso, c.startMin),
        planned_end: combinePlannedEnd(c.dateIso, c.endMin),
      });
      setCreator(null);
      await loadData();
    } catch (err) {
      setCreator((cc) => (cc ? { ...cc, saving: false, error: err?.message || 'Create failed.' } : cc));
    }
  }

  async function commitCreateWindow() {
    const c = creator;
    if (!c || c.saving) return;
    setCreator((cc) => (cc ? { ...cc, saving: true, error: '' } : cc));
    try {
      const fields = {
        depth: c.depth,
        start_minutes: c.startMin,
        end_minutes: c.endMin,
        protected: false,
      };
      if (c.weekly) fields.weekday = weekdayOfIso(c.dateIso);
      else fields.date = c.dateIso;
      await createDepthWindow(fields);
      setCreator(null);
      setWindows(await fetchDepthWindows());
    } catch (err) {
      setCreator((cc) => (cc ? { ...cc, saving: false, error: err?.message || 'Create failed.' } : cc));
    }
  }

  async function removeWindow(id) {
    try {
      await deleteDepthWindow(id);
      setWindows((prev) => prev.filter((w) => w.id !== id));
    } catch (err) {
      console.error('delete depth window failed:', err);
    }
  }

  async function removeSession(sessionId) {
    setSelected(null);
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    try {
      await deleteSession(sessionId);
    } catch (err) {
      console.error('delete session failed:', err);
    }
    loadData();
  }

  async function setTaskDepth(taskId, depth) {
    setSessions((prev) => prev.map((s) =>
      (s.task_id === taskId ? { ...s, task_depth: depth || null } : s)));
    try {
      await updateTask(taskId, { depth: depth || 0 });
    } catch (err) {
      console.error('set depth failed:', err);
    }
    loadData();
  }

  // ── Drawer → grid drag (HTML5 DnD from the unscheduled list) ──────────────
  // Shared slot math for the HTML5 drag preview and the actual drop, so the
  // committed session always matches what the ghost showed.
  function drawerDropTarget(clientX, clientY) {
    const task = drawerDragRef.current;
    if (!task) return null;
    const slot = pointToSlot(clientX, clientY);
    if (!slot) return null;
    const dur = task.estimated_minutes || DEFAULT_SESSION_MINUTES;
    const startMin = Math.max(0, Math.min(DAY_MINUTES - dur, snapMinutes(slot.minutes)));
    return { task, dateIso: slot.dateIso, startMin, endMin: startMin + dur };
  }

  function onGridDragOver(e) {
    const target = drawerDropTarget(e.clientX, e.clientY);
    if (!target) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropPreview({ dateIso: target.dateIso, startMin: target.startMin, endMin: target.endMin });
  }

  async function onGridDrop(e) {
    const target = drawerDropTarget(e.clientX, e.clientY);
    drawerDragRef.current = null;
    setDropPreview(null);
    if (!target) return;
    e.preventDefault();
    try {
      await createSession({
        task_id: target.task.id,
        planned_start: combinePlanned(target.dateIso, target.startMin),
        planned_end: combinePlannedEnd(target.dateIso, target.endMin),
      });
    } catch (err) {
      console.error('schedule from drawer failed:', err);
    }
    loadData();
  }

  // ── Derived render data ────────────────────────────────────────────────────
  const blocksByDate = useMemo(() => {
    const map = {};
    for (const dIso of dates) {
      const dayBlocks = [];
      for (const s of sessions) {
        const seg = sessionSegmentOnDate(s, dIso);
        if (seg) dayBlocks.push({ session: s, ...seg });
      }
      map[dIso] = layoutBlocks(dayBlocks);
    }
    return map;
  }, [sessions, dates]);

  const unscheduledByDepth = useMemo(() => {
    const scheduledIds = new Set(upcomingSessions.map((s) => s.task_id));
    const groups = { 1: [], 2: [], 3: [], 0: [] };
    for (const t of tasks) {
      if (t.is_paused || t.is_ended || scheduledIds.has(t.id)) continue;
      groups[t.depth ?? 0].push(t);
    }
    return groups;
  }, [tasks, upcomingSessions]);

  const unscheduledCount = unscheduledByDepth[1].length + unscheduledByDepth[2].length
    + unscheduledByDepth[3].length + unscheduledByDepth[0].length;

  const sectionSuggestions = useMemo(
    () => [...new Set(tasks.map((t) => t.section).filter(Boolean))],
    [tasks],
  );

  const selectedSession = selected
    ? sessions.find((s) => s.id === selected.sessionId) ?? null
    : null;

  // ── Render helpers ─────────────────────────────────────────────────────────
  function renderGhost(dateIso) {
    // Selection / window-creation ghost, move/resize target, drawer drop preview.
    const ghosts = [];
    if (drag && (drag.type === 'select' || drag.type === 'window') && drag.dateIso === dateIso) {
      ghosts.push({
        key: 'sel',
        cls: drag.type === 'window' ? 'cal-ghost cal-ghost--window' : 'cal-ghost',
        startMin: drag.startMin,
        endMin: drag.endMin,
      });
    }
    if (drag && drag.type === 'move' && drag.moved && drag.dateIso === dateIso) {
      ghosts.push({ key: 'move', cls: 'cal-ghost cal-ghost--move', startMin: drag.startMin, endMin: drag.startMin + drag.durMin });
    }
    if (drag && drag.type === 'resize' && drag.moved
      && plannedDate(drag.session.planned_start) === dateIso) {
      ghosts.push({ key: 'resize', cls: 'cal-ghost cal-ghost--move', startMin: drag.startMin, endMin: drag.endMin });
    }
    if (dropPreview && dropPreview.dateIso === dateIso) {
      ghosts.push({ key: 'drop', cls: 'cal-ghost cal-ghost--move', startMin: dropPreview.startMin, endMin: dropPreview.endMin });
    }
    return ghosts.map((g) => (
      <div
        key={g.key}
        className={g.cls}
        style={{ top: minutesToPx(g.startMin), height: Math.max(10, minutesToPx(g.endMin - g.startMin)) }}
      >
        <span className="cal-ghost-time">
          {formatTimeRange(g.startMin, g.endMin)} · {durationLabel(g.endMin - g.startMin)}
        </span>
      </div>
    ));
  }

  function renderInlineCreator(dateIso) {
    if (!creator || creator.kind !== 'task' || creator.mode !== 'inline' || creator.dateIso !== dateIso) return null;
    return (
      <div
        className="cal-creator-inline cal-ghost"
        style={{ top: minutesToPx(creator.startMin), height: Math.max(24, minutesToPx(creator.endMin - creator.startMin)) }}
      >
        <input
          ref={creatorInputRef}
          className="cal-creator-inline-input"
          placeholder="New task…"
          value={creator.title}
          onChange={(e) => setCreator((c) => (c ? { ...c, title: e.target.value } : c))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitCreateTask(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCreator(null); }
          }}
          onBlur={() => { if (!creator.title.trim() && !creator.saving) setCreator(null); }}
        />
        <span className="cal-ghost-time">
          {formatTimeRange(creator.startMin, creator.endMin)} · Enter to create
        </span>
        {creator.error && <span className="cal-creator-error">{creator.error}</span>}
      </div>
    );
  }

  function renderBlock(item, dateIso) {
    const s = item.session;
    const isDragSource = drag && (drag.type === 'move' || drag.type === 'resize')
      && drag.moved && drag.session.id === s.id;
    const done = s.status === 'completed';
    const depth = s.task_depth;
    const heightPx = Math.max(14, minutesToPx(item.endMin - item.startMin) - 2);
    const compact = heightPx < 34;
    const width = 100 / item.cols;
    return (
      <div
        key={`${s.id}:${dateIso}`}
        className={[
          'cal-block',
          depth ? `cal-block--d${depth}` : 'cal-block--d0',
          done ? 'is-done' : '',
          s.is_fixed ? 'is-fixed' : '',
          isDragSource ? 'is-drag-source' : '',
        ].filter(Boolean).join(' ')}
        style={{
          top: minutesToPx(item.startMin),
          height: heightPx,
          left: `${item.col * width}%`,
          width: `calc(${width}% - 3px)`,
        }}
        onPointerDown={(e) => onBlockPointerDown(e, s, item)}
        title={`${s.task_name} · ${formatTimeRange(item.startMin, item.endMin)}`}
      >
        <div className="cal-block-head">
          <button
            type="button"
            className={`cal-block-check${done ? ' is-done' : ''}`}
            aria-label={done ? 'Mark session not completed' : 'Mark session completed'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); toggleComplete(s); }}
          >
            {done ? '✓' : ''}
          </button>
          <span className="cal-block-title">{s.task_name}</span>
          {depth != null && <span className={`cal-depth-pill cal-depth-pill--d${depth}`}>D{depth}</span>}
        </div>
        {!compact && (
          <div className="cal-block-meta">
            {formatTimeRange(item.startMin, item.endMin)}
            {s.task_section && s.task_section !== 'General' ? ` · ${s.task_section}` : ''}
          </div>
        )}
        <div className="cal-block-resize" aria-hidden="true" />
      </div>
    );
  }

  function popoverPosition(rect, width = 300, height = 280) {
    if (!rect) return { top: 80, left: 80, width };
    let left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 12));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    return { top, left, width };
  }

  // ── Popover: creation (normal drag / click) ────────────────────────────────
  function renderCreatorPopover() {
    if (!creator) return null;
    if (creator.kind === 'task' && creator.mode !== 'popover') return null;

    // Anchor the popover to the selected interval's on-screen position.
    let anchorRect = null;
    if (daysRef.current) {
      const rect = daysRef.current.getBoundingClientRect();
      const colW = rect.width / dates.length;
      const idx = dates.indexOf(creator.dateIso);
      if (idx >= 0) {
        anchorRect = {
          left: rect.left + idx * colW,
          top: rect.top + minutesToPx(creator.startMin),
          bottom: rect.top + minutesToPx(creator.endMin),
        };
      }
    }
    const style = popoverPosition(anchorRect, 320, creator.kind === 'window' ? 240 : 300);
    const minutes = creator.endMin - creator.startMin;

    if (creator.kind === 'window') {
      return (
        <div className="cal-popover" style={style} role="dialog" aria-label="New depth window">
          <div className="cal-popover-kicker">New Depth Window</div>
          <div className="cal-popover-time">
            {fullDateLabel(creator.dateIso)}
            <br />{formatTimeRange(creator.startMin, creator.endMin)} · {durationLabel(minutes)}
          </div>
          <DepthSeg
            allowNone={false}
            value={creator.depth}
            onChange={(d) => setCreator((c) => (c ? { ...c, depth: d } : c))}
          />
          <label className="cal-popover-checkline">
            <input
              type="checkbox"
              checked={creator.weekly}
              onChange={(e) => setCreator((c) => (c ? { ...c, weekly: e.target.checked } : c))}
            />
            Repeat weekly on {fullDateLabel(creator.dateIso).split(',')[0]}s
          </label>
          <div className="cal-popover-hint">
            Depth windows are background capacity regions — what kind of work this
            time is for, not a task.
          </div>
          {creator.error && <div className="cal-popover-error" role="alert">{creator.error}</div>}
          <div className="cal-popover-actions">
            <button type="button" className="task-modal-cancel" onClick={() => setCreator(null)}>Cancel</button>
            <button type="button" className="task-modal-save" onClick={commitCreateWindow} disabled={creator.saving}>
              {creator.saving ? 'Creating…' : 'Create window'}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="cal-popover" style={style} role="dialog" aria-label="New task">
        <div className="cal-popover-kicker">New Task</div>
        <input
          ref={creatorInputRef}
          className="task-modal-input cal-popover-title"
          placeholder="Task name…"
          value={creator.title}
          onChange={(e) => setCreator((c) => (c ? { ...c, title: e.target.value } : c))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitCreateTask(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCreator(null); }
          }}
        />
        <div className="cal-popover-time">
          {fullDateLabel(creator.dateIso)} · {formatTimeRange(creator.startMin, creator.endMin)} · {durationLabel(minutes)}
        </div>
        <DepthSeg
          value={creator.depth}
          onChange={(d) => setCreator((c) => (c ? { ...c, depth: d } : c))}
        />
        <div className="cal-popover-hint">
          Creates a real task record scheduled here. Tip: {QUICK_CREATE_HINT} on
          empty time for instant inline creation; ⇧ drag for a depth window.
        </div>
        {creator.error && <div className="cal-popover-error" role="alert">{creator.error}</div>}
        <div className="cal-popover-actions">
          <button type="button" className="task-modal-cancel" onClick={() => setCreator(null)}>Cancel</button>
          <button type="button" className="task-modal-save" onClick={commitCreateTask} disabled={creator.saving}>
            {creator.saving ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </div>
    );
  }

  // ── Popover: session detail ────────────────────────────────────────────────
  function renderSessionPopover() {
    if (!selectedSession) return null;
    const s = selectedSession;
    const startMin = plannedMinutes(s.planned_start);
    const dateIso = plannedDate(s.planned_start);
    const style = popoverPosition(selected.rect, 300, 250);
    const done = s.status === 'completed';
    const task = tasks.find((t) => t.id === s.task_id) ?? null;
    return (
      <div className="cal-popover" style={style} role="dialog" aria-label="Session details">
        <div className="cal-popover-head">
          <span className="cal-popover-name">{s.task_name}</span>
          <button type="button" className="cal-popover-close" aria-label="Close" onClick={() => setSelected(null)}>×</button>
        </div>
        <div className="cal-popover-time">
          {fullDateLabel(dateIso)}
          <br />
          {formatTimeRange(startMin, startMin + s.planned_minutes)} · {durationLabel(s.planned_minutes)}
          {s.task_section && s.task_section !== 'General' ? ` · ${s.task_section}` : ''}
        </div>
        <DepthSeg value={s.task_depth ?? 0} onChange={(d) => setTaskDepth(s.task_id, d)} />
        <div className="cal-popover-actions cal-popover-actions--spread">
          <button
            type="button"
            className={`cal-complete-btn${done ? ' is-done' : ''}`}
            onClick={() => toggleComplete(s)}
          >
            {done ? '✓ Completed' : 'Mark complete'}
          </button>
          <div className="cal-popover-actions-right">
            <button
              type="button"
              className="task-modal-cancel"
              onClick={() => { setSelected(null); if (task) setEditingTask(task); }}
              disabled={!task}
            >
              Open task
            </button>
            <button
              type="button"
              className="cal-danger-btn"
              title="Remove this scheduled session — the task itself is untouched"
              onClick={() => removeSession(s.id)}
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Drawer ─────────────────────────────────────────────────────────────────
  function renderDrawer() {
    if (!drawerOpen) return null;
    const groups = [
      [1, unscheduledByDepth[1]],
      [2, unscheduledByDepth[2]],
      [3, unscheduledByDepth[3]],
      [0, unscheduledByDepth[0]],
    ].filter(([, list]) => list.length > 0);
    return (
      <aside className="cal-drawer" aria-label="Unscheduled tasks">
        <div className="cal-drawer-head">
          <span>Unscheduled</span>
          <span className="cal-drawer-count">{unscheduledCount}</span>
        </div>
        <div className="cal-drawer-hint">Drag a task onto the calendar to schedule it.</div>
        {groups.length === 0 && (
          <div className="cal-drawer-empty">Every active task has an upcoming session.</div>
        )}
        {groups.map(([depth, list]) => (
          <div key={depth} className="cal-drawer-group">
            <div className="cal-drawer-group-title">
              {depth === 0 ? 'No depth' : DEPTH_LABELS[depth]}
            </div>
            {list.map((t) => (
              <div
                key={t.id}
                className={`cal-drawer-item${depth ? ` cal-drawer-item--d${depth}` : ''}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', String(t.id));
                  e.dataTransfer.effectAllowed = 'copy';
                  drawerDragRef.current = t;
                }}
                onDragEnd={() => {
                  drawerDragRef.current = null;
                  setDropPreview(null);
                }}
                title="Drag onto the calendar to schedule"
              >
                <span className="cal-drawer-item-name">{t.name}</span>
                <span className="cal-drawer-item-meta">
                  {t.estimated_minutes ? durationLabel(t.estimated_minutes) : '—'}
                  {t.section && t.section !== 'General' ? ` · ${t.section}` : ''}
                </span>
              </div>
            ))}
          </div>
        ))}
      </aside>
    );
  }

  // ── Top-level render ───────────────────────────────────────────────────────
  if (loading) {
    return <div className="cal-view"><div className="cal-status">Loading calendar…</div></div>;
  }
  if (error && !loadedOnce.current) {
    return (
      <div className="cal-view">
        <div className="cal-status cal-status--error">
          {error}
          <button type="button" className="report-nav" onClick={() => loadData({ gate: true })}>Retry</button>
        </div>
      </div>
    );
  }

  const hours = Array.from({ length: 24 }, (_, h) => h);

  return (
    <div className="cal-view">
      {/* ── Toolbar ── */}
      <div className="cal-toolbar">
        <div className="cal-toolbar-nav">
          <button type="button" className="cal-nav-btn cal-nav-btn--today" onClick={goToday}>Today</button>
          <button type="button" className="cal-nav-btn" aria-label="Previous period" onClick={() => shiftPeriod(-1)}>‹</button>
          <button type="button" className="cal-nav-btn" aria-label="Next period" onClick={() => shiftPeriod(1)}>›</button>
          <span className="cal-range-label">{rangeLabel(dates)}</span>
        </div>
        <div className="cal-toolbar-right">
          <div className="cal-seg" role="group" aria-label="Calendar view">
            <button
              type="button"
              className={`cal-seg-btn${viewMode === 'week' ? ' is-active' : ''}`}
              aria-pressed={viewMode === 'week'}
              onClick={() => setViewMode('week')}
            >Week</button>
            <button
              type="button"
              className={`cal-seg-btn${viewMode === 'day' ? ' is-active' : ''}`}
              aria-pressed={viewMode === 'day'}
              onClick={() => setViewMode('day')}
            >Day</button>
          </div>
          <button
            type="button"
            className={`cal-nav-btn cal-drawer-toggle${drawerOpen ? ' is-active' : ''}`}
            aria-pressed={drawerOpen}
            onClick={() => setDrawerOpen((o) => !o)}
          >
            Unscheduled{unscheduledCount ? ` · ${unscheduledCount}` : ''}
          </button>
        </div>
      </div>

      <div className="cal-main">
        <div className="cal-scroll" ref={scrollRef}>
          {/* ── Sticky day headers ── */}
          <div className="cal-header-row">
            <div className="cal-gutter-spacer" />
            <div className="cal-day-headers">
              {dates.map((dIso) => {
                const { weekday, dayNum } = dayHeaderLabel(dIso);
                const isToday = dIso === nowIso;
                return (
                  <button
                    type="button"
                    key={dIso}
                    className={`cal-day-header${isToday ? ' is-today' : ''}`}
                    title="Open day view"
                    onClick={() => { setAnchorIso(dIso); setViewMode('day'); }}
                  >
                    <span className="cal-day-header-weekday">{weekday}</span>
                    <span className="cal-day-header-num">{dayNum}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Time grid ── */}
          <div className="cal-grid-row">
            <div className="cal-gutter">
              {hours.map((h) => (
                <div key={h} className="cal-gutter-hour" style={{ top: minutesToPx(h * 60) }}>
                  {h === 0 ? '' : formatHourLabel(h)}
                </div>
              ))}
            </div>
            <div
              className="cal-days"
              ref={daysRef}
              onPointerDown={onGridPointerDown}
              onPointerMove={onGridPointerMove}
              onPointerUp={onGridPointerUp}
              onPointerCancel={onGridPointerCancel}
              onDragOver={onGridDragOver}
              onDrop={onGridDrop}
              onDragLeave={() => setDropPreview(null)}
            >
              {dates.map((dIso) => {
                const isToday = dIso === nowIso;
                return (
                  <div
                    key={dIso}
                    className={[
                      'cal-day-col',
                      isToday ? 'is-today' : '',
                      isWeekendIso(dIso) ? 'is-weekend' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    {windowsOnDate(windows, dIso).map((w) => (
                      <div
                        key={w.id}
                        className={`cal-window cal-window--d${w.depth}`}
                        style={{
                          top: minutesToPx(w.start_minutes),
                          height: minutesToPx(w.end_minutes - w.start_minutes),
                        }}
                      >
                        <span className="cal-window-label">
                          D{w.depth}{w.weekday != null ? ' · weekly' : ''}
                        </span>
                        <button
                          type="button"
                          className="cal-window-del"
                          aria-label="Remove depth window"
                          title={w.weekday != null
                            ? 'Remove this weekly depth window (all weeks)'
                            : 'Remove this depth window'}
                          onClick={() => removeWindow(w.id)}
                        >×</button>
                      </div>
                    ))}
                    {blocksByDate[dIso]?.map((item) => renderBlock(item, dIso))}
                    {renderGhost(dIso)}
                    {renderInlineCreator(dIso)}
                    {isToday && (
                      <div className="cal-now-line" style={{ top: minutesToPx(nowMin) }}>
                        <span className="cal-now-dot" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        {renderDrawer()}
      </div>

      {renderCreatorPopover()}
      {renderSessionPopover()}

      {editingTask && (
        <TaskModal
          task={editingTask}
          sectionSuggestions={sectionSuggestions}
          onSave={async (payload) => {
            await updateTask(editingTask.id, payload);
            setEditingTask(null);
            await loadData();
          }}
          onDelete={async (id) => {
            await deleteTask(id);
            setEditingTask(null);
            await loadData();
          }}
          onClose={() => setEditingTask(null)}
          onHiatusChanged={() => loadData()}
        />
      )}
    </div>
  );
}
