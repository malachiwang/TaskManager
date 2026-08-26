import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchTasks, fetchSessions, fetchDepthWindows, fetchCompletions,
  createTask, updateTask, deleteTask,
  createSession, updateSession, deleteSession,
  createDepthWindow, deleteDepthWindow, skipDepthWindowDay,
  upsertCompletion, setCompletionCount,
  fetchExternalCalendars, createExternalCalendar, updateExternalCalendar,
  deleteExternalCalendar, syncExternalCalendar, fetchExternalEvents,
  fetchWindowTemplates, createWindowTemplate, updateWindowTemplate, deleteWindowTemplate,
  fetchContexts, createContext, linkEventToContext, unlinkEventFromContext,
  fetchTaskEventLinks, createTaskEventLink, deleteTaskEventLink,
  updateTaskEventLink, fetchEventMoveProposal,
  fetchSuggestions, fetchReminders,
  parseNaturalLanguage, searchCalendar,
} from '../api.js';
import {
  SNAP_MINUTES, MIN_SESSION_MINUTES, DEFAULT_SESSION_MINUTES, DAY_MINUTES,
  DENSITY_SCALES, setPxPerHour,
  todayIso, isoDate, addDaysIso, weekDates, isWeekendIso, weekdayOfIso,
  plannedDate, plannedMinutes, combinePlanned, combinePlannedEnd,
  shiftPlannedDays, plannedDiffMinutes,
  snapMinutes, clampDayMinutes, sessionSegmentOnDate,
  formatHourLabel, formatTimeRange, formatTimeOfDay, durationLabel,
  dayHeaderLabel, fullDateLabel, rangeLabel,
  windowsOnDate, layoutBlocks, minutesToPx, pxToMinutes,
} from '../calendarUtils.js';
import TaskModal from './TaskModal.jsx';
import CalendarEditor, { TimeRangeFields } from './CalendarEditor.jsx';
import CommandPalette from './CommandPalette.jsx';
import AcademicImport from './AcademicImport.jsx';
import { displayTitle } from '../linkUtils.js';

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

export default function CalendarView({ placeRequest = null, onPlaceRequestConsumed = null }) {
  const [viewMode, setViewMode] = useState('week'); // 'week' | 'day'
  const [anchorIso, setAnchorIso] = useState(() => todayIso());

  const [tasks, setTasks] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [upcomingSessions, setUpcomingSessions] = useState([]);
  const [recentSessions, setRecentSessions] = useState([]); // trailing 14d, for reconciliation
  const [windows, setWindows] = useState([]);
  const [completions, setCompletions] = useState({}); // "taskId:date" -> count
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Execution-surface preferences (P13.0) — localStorage like other UI prefs.
  const [hideCompleted, setHideCompleted] = useState(
    () => localStorage.getItem('taskos-cal-hide-completed') === '1',
  );
  useEffect(() => {
    localStorage.setItem('taskos-cal-hide-completed', hideCompleted ? '1' : '0');
  }, [hideCompleted]);

  // Reconciliation / confirmation surfaces (P13.0)
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [partialEdit, setPartialEdit] = useState(null); // { sessionId, minutes }
  const [confirmAction, setConfirmAction] = useState(null); // { message, onConfirm }
  const [windowMenu, setWindowMenu] = useState(null); // { windowId, dateIso }

  // External commitments (P15.0) — read-only ICS calendars. Their load and
  // sync failures never touch core surfaces (§12).
  const [externalCalendars, setExternalCalendars] = useState([]);
  const [externalEvents, setExternalEvents] = useState([]);
  const [calsOpen, setCalsOpen] = useState(false);
  const [calDraft, setCalDraft] = useState({ name: '', url: '', busy: false, error: '' });

  // Replanning (P15.0): Shift Remaining Day plan, Did This Instead dialog,
  // Schedule Remaining placement, and depth-window template modes.
  const [shiftOpen, setShiftOpen] = useState(false);
  const [shiftPlan, setShiftPlan] = useState(null);   // { minutes, proposed: [...] }
  const [insteadFor, setInsteadFor] = useState(null); // { session, title, startMin, endMin, error }
  const [placingTask, setPlacingTask] = useState(null); // canonical task awaiting an interval
  const [templates, setTemplates] = useState([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateMode, setTemplateMode] = useState(null); // {type:'apply',tpl} | {type:'save'} | {type:'update',tpl}
  const [templateRename, setTemplateRename] = useState(null); // { id, name }

  // Contextual layer (P16.0): server-computed Good Fits + reminders,
  // contexts, external-event detail panel, post-class review draft.
  const [suggestData, setSuggestData] = useState(null); // { gap, current_window, suggestions }
  const [reminders, setReminders] = useState([]);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [contexts, setContexts] = useState([]);
  const [extDetail, setExtDetail] = useState(null); // { event, rect, links, linkPicker, ctxDraft }
  const [reviewDraft, setReviewDraft] = useState(null); // { contextName } → TaskModal then place
  const [reminderPrefs, setReminderPrefs] = useState(() => {
    try { return JSON.parse(localStorage.getItem('taskos-reminder-prefs') || '{}'); } catch { return {}; }
  });
  const [dismissedReminders, setDismissedReminders] = useState(() => {
    try { return JSON.parse(localStorage.getItem('taskos-reminders-dismissed') || '[]'); } catch { return []; }
  });
  useEffect(() => {
    localStorage.setItem('taskos-reminder-prefs', JSON.stringify(reminderPrefs));
  }, [reminderPrefs]);
  useEffect(() => {
    localStorage.setItem('taskos-reminders-dismissed', JSON.stringify(dismissedReminders.slice(-200)));
  }, [dismissedReminders]);

  // Schedule-from-Grid (§13/§15): consume the handed-off task into the
  // existing placement mode. The Grid task carries its rollups already.
  useEffect(() => {
    if (!placeRequest) return;
    setPlacingTask(placeRequest);
    onPlaceRequestConsumed?.();
  }, [placeRequest, onPlaceRequestConsumed]);

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
  // Selection is independent of the quick popover (P15.0 §4): a block can be
  // selected (ring + keyboard target) with the popover closed — e.g. right
  // after the full editor closes. The popover and the full editor are
  // mutually exclusive by construction.
  const [selected, setSelected] = useState(null); // { sessionId, rect }
  const selectedSession = selected
    ? sessions.find((s) => s.id === selected.sessionId) ?? null
    : null;

  // Command palette (V5.1 Part II) + duplicate menu (Part VII) + density
  // (Part VI). Density is persisted; the module pixel scale and the CSS var
  // are both set from DENSITY_SCALES so hit-testing and rendering can never
  // disagree (§19).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [dupDate, setDupDate] = useState('');
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false); // academic importer (V5.3)

  // Calendar search (V5.2 Part V) — server-side matching, read-only. The
  // panel narrows by type/status/date and can pin a context taken from its
  // own results (§16); selecting a dated result navigates the Calendar.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFilters, setSearchFilters] = useState({ types: null, status: null, from: '', to: '' });
  const [searchCtx, setSearchCtx] = useState(null); // pinned {id, name}
  const [searchResults, setSearchResults] = useState(null);
  const [density, setDensity] = useState(() => {
    const saved = localStorage.getItem('taskos-cal-density');
    return DENSITY_SCALES[saved] ? saved : 'standard';
  });
  // The module pixel scale must be set DURING render, before any minutesToPx
  // call positions a block — an effect would run after paint and leave every
  // block at the old scale until some later re-render.
  setPxPerHour(DENSITY_SCALES[density]);
  useEffect(() => {
    localStorage.setItem('taskos-cal-density', density);
  }, [density]);
  const [quickOpen, setQuickOpen] = useState(false);
  const [editorSessionId, setEditorSessionId] = useState(null); // Calendar session editor (P13.1)
  const [editingTask, setEditingTask] = useState(null); // full canonical TaskModal
  // Promotion (P14.0): "Add to main Grid…" — the standard New Task modal,
  // prefilled from a calendar-only entry; on save the entry links to the
  // created task. { sessionId, initialValues }
  const [promoteFor, setPromoteFor] = useState(null);
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
    nudgeBaseRef.current = null; // server truth supersedes any keyboard base
    try {
      const today = todayIso();
      const [tasksData, rangeSessions, upcoming, recent, windowsData, completionRows] =
        await Promise.all([
          fetchTasks(),
          fetchSessions(rangeStart, rangeEnd),
          fetchSessions(today, addDaysIso(today, 365)),
          fetchSessions(addDaysIso(today, -14), today),
          fetchDepthWindows(),
          fetchCompletions(rangeStart, rangeEnd),
        ]);
      setTasks(tasksData);
      setSessions(rangeSessions);
      setUpcomingSessions(upcoming);
      setRecentSessions(recent);
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
    // External calendars + templates load in ISOLATION (§12): a broken feed
    // or endpoint failure leaves the core calendar fully functional, keeping
    // whatever external data we already had.
    try {
      const [cals, evs] = await Promise.all([
        fetchExternalCalendars(),
        fetchExternalEvents(rangeStart, rangeEnd),
      ]);
      setExternalCalendars(cals);
      setExternalEvents(evs);
    } catch (err) {
      console.warn('external calendars unavailable:', err);
    }
    try {
      setTemplates(await fetchWindowTemplates());
    } catch (err) {
      console.warn('window templates unavailable:', err);
    }
    try {
      const [sug, rem, ctxs] = await Promise.all([
        fetchSuggestions(), fetchReminders(), fetchContexts(),
      ]);
      setSuggestData(sug);
      setReminders(rem);
      setContexts(ctxs);
    } catch (err) {
      console.warn('contextual data unavailable:', err);
    }
  }, [rangeStart, rangeEnd]);

  // Reminders + Good Fits track the clock: refresh with the 30s now-tick.
  useEffect(() => {
    if (loading) return;
    let stale = false;
    (async () => {
      try {
        const [sug, rem] = await Promise.all([fetchSuggestions(), fetchReminders()]);
        if (!stale) { setSuggestData(sug); setReminders(rem); }
      } catch { /* isolated */ }
    })();
    return () => { stale = true; };
  }, [nowTick, loading]);

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
    // Deliberately NOT keyed on start/end: editing the time fields re-renders
    // the creator and must not yank focus back into the title/search input.
  }, [creator?.dateIso, creator?.kind, creator?.tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Transient surfaces only — deliberately does NOT clear block selection;
  // Escape clears selection as its own final step (§4).
  function closeTransients() {
    setPaletteOpen(false);
    setDupOpen(false);
    setSearchOpen(false);
    setCreator(null);
    setQuickOpen(false);
    setConfirmAction(null);
    setWindowMenu(null);
    setPartialEdit(null);
    setReconcileOpen(false);
    setCalsOpen(false);
    setShiftOpen(false);
    setShiftPlan(null);
    setInsteadFor(null);
    setPlacingTask(null);
    setTemplatesOpen(false);
    setTemplateMode(null);
    setTemplateRename(null);
    setRemindersOpen(false);
    setExtDetail(null);
  }

  // Auto-refresh stale external calendars once per mount — fire-and-forget,
  // then re-read events. Sync failures stay silent here (last_error shows in
  // the Calendars manager).
  const autoSyncedRef = useRef(false);
  useEffect(() => {
    if (loading || autoSyncedRef.current || externalCalendars.length === 0) return;
    autoSyncedRef.current = true;
    const STALE_MS = 15 * 60 * 1000;
    const stale = externalCalendars.filter((c) =>
      !c.last_synced_at || (Date.now() - new Date(c.last_synced_at).getTime()) > STALE_MS);
    if (stale.length === 0) return;
    (async () => {
      for (const c of stale) {
        try { await syncExternalCalendar(c.id); } catch { /* recorded server-side */ }
      }
      try {
        setExternalCalendars(await fetchExternalCalendars());
        setExternalEvents(await fetchExternalEvents(rangeStart, rangeEnd));
      } catch { /* isolated */ }
    })();
  }, [loading, externalCalendars, rangeStart, rangeEnd]);

  function closeOverlays() {
    closeTransients();
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
      // ⌘K / Ctrl+K toggles the command palette from anywhere, including
      // inputs — it is modifier-chorded, so it can never be typed by
      // accident (§14). Everything else respects editable focus below.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (paletteOpen) setPaletteOpen(false);
        else { closeTransients(); setPaletteOpen(true); }
        return;
      }
      if (paletteOpen) return; // the palette owns its own keys (incl. Escape)
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
      if (editingTask || editorSessionId || newTaskOpen || importOpen) return;
      if (e.key === 'Escape') {
        // Staged dismissal (§4): transient UI first, selection second.
        updateDrag(null);
        const hadTransient = creator || quickOpen || confirmAction || windowMenu
          || partialEdit || reconcileOpen || calsOpen || shiftOpen || shiftPlan
          || insteadFor || placingTask || templatesOpen || templateMode
          || remindersOpen || extDetail || dupOpen || searchOpen;
        if (hadTransient) closeTransients();
        else setSelected(null);
        return;
      }
      // Keyboard scheduling (V5.1 §12/§13) — a selected, still-scheduled
      // block moves in SNAP_MINUTES steps (Shift = 30m), jumps days with
      // ⌥←/→, and resizes with ⌘/Ctrl+Shift+↑/↓. Completed/partial/skipped
      // sessions never move — their planned history is settled.
      if (selectedSession && selectedSession.status === 'scheduled') {
        const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
        const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
        const dir = (e.key === 'ArrowUp' || e.key === 'ArrowLeft') ? -1 : 1;
        if (vertical && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
          nudgeResize(selectedSession, dir * SNAP_MINUTES);
          e.preventDefault();
          return;
        }
        if (horizontal && e.altKey && !e.metaKey && !e.ctrlKey) {
          nudgeMoveDays(selectedSession, dir);
          e.preventDefault();
          return;
        }
        if (vertical && !e.metaKey && !e.ctrlKey && !e.altKey) {
          nudgeMoveMinutes(selectedSession, dir * (e.shiftKey ? 30 : SNAP_MINUTES));
          e.preventDefault();
          return;
        }
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === 't') goToday();
      else if (k === 'w') setViewMode('week');
      else if (k === 'd') setViewMode('day');
      else if (k === 'e' && selected) {
        // §14 — E edits the selected session; the quick popover closes FIRST
        // so the two transient editors never render together (§4).
        setQuickOpen(false);
        setEditorSessionId(selected.sessionId);
      } else if (e.key === 'ArrowLeft') shiftPeriod(-1);
      else if (e.key === 'ArrowRight') shiftPeriod(1);
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editingTask, editorSessionId, selected, selectedSession, creator, quickOpen,
    confirmAction, windowMenu, partialEdit, reconcileOpen, calsOpen, shiftOpen,
    shiftPlan, insteadFor, placingTask, templatesOpen, templateMode, remindersOpen,
    extDetail, paletteOpen, dupOpen, newTaskOpen, searchOpen, importOpen,
    goToday, shiftPeriod, updateDrag]);

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
      // Schedule Remaining placement (P15.0 §24): while a task is armed,
      // click OR drag places another session of the SAME canonical task.
      if (placingTask && d.type === 'select') {
        const dur = Math.max(MIN_SESSION_MINUTES,
          placingTask.__suggested || placingTask.remaining_unscheduled_minutes
          || placingTask.estimated_minutes || DEFAULT_SESSION_MINUTES);
        const startMin = d.moved ? d.startMin : d.anchorMin;
        const endMin = d.moved
          ? Math.max(d.endMin, startMin + MIN_SESSION_MINUTES)
          : Math.min(DAY_MINUTES, startMin + dur);
        const task = placingTask;
        setPlacingTask(null);
        const commit = async () => {
          try {
            await createSession({
              task_id: task.id,
              planned_start: combinePlanned(d.dateIso, startMin),
              planned_end: combinePlannedEnd(d.dateIso, endMin),
            });
          } catch (err) {
            console.error('schedule remaining failed:', err);
          }
          loadData();
        };
        const conflict = protectedConflictAt(d.dateIso, startMin, endMin, task.depth);
        if (conflict) confirmProtected(conflict, task.depth, task.name, commit);
        else commit();
        return;
      }
      // §2 — a plain click on empty space never opens creation; creating a
      // scheduled block requires an intentional drag gesture.
      if (!d.moved) return;
      let { startMin, endMin } = d;
      if (endMin - startMin < MIN_SESSION_MINUTES) endMin = Math.min(DAY_MINUTES, startMin + MIN_SESSION_MINUTES);
      if (d.type === 'window') {
        setCreator({ kind: 'window', dateIso: d.dateIso, startMin, endMin, depth: 1, weekly: false, protected: false, saving: false, error: '' });
      } else {
        setCreator({
          kind: 'task',
          mode: d.quick ? 'inline' : 'popover',
          tab: 'new',
          dateIso: d.dateIso, startMin, endMin,
          title: '', depth: 0, isFixed: false,
          search: '',
          saving: false, error: '',
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

  // ── Depth-window awareness (P13.0) ─────────────────────────────────────────
  // Advisory only (§7): a session overlapping windows on its date, none of
  // which match the task's depth. Returns a representative window or null.
  function depthMismatchAt(dateIso, startMin, endMin, taskDepth) {
    if (!taskDepth) return null;
    const overlapping = windowsOnDate(windows, dateIso)
      .filter((w) => w.start_minutes < endMin && w.end_minutes > startMin);
    if (overlapping.length === 0) return null;
    if (overlapping.some((w) => w.depth === taskDepth)) return null;
    return overlapping[0];
  }

  // Protected windows (§8): scheduling other-depth work into one asks first —
  // always overridable, never blocking.
  function protectedConflictAt(dateIso, startMin, endMin, taskDepth) {
    return windowsOnDate(windows, dateIso).find((w) =>
      w.protected === 1 && w.depth !== taskDepth
      && w.start_minutes < endMin && w.end_minutes > startMin) ?? null;
  }

  function confirmProtected(window, taskDepth, taskName, proceed) {
    setConfirmAction({
      message: `This is a protected D${window.depth} window`
        + `${taskDepth ? ` and “${taskName}” is D${taskDepth}` : taskName ? ` and “${taskName}” has no depth` : ''}. `
        + 'Schedule anyway?',
      onConfirm: proceed,
    });
  }

  function commitMove(d) {
    const conflict = protectedConflictAt(
      d.dateIso, d.startMin, d.startMin + d.durMin, d.session.task_depth);
    if (conflict) {
      confirmProtected(conflict, d.session.task_depth, d.session.task_name, () => performMove(d));
      return;
    }
    performMove(d);
  }

  async function performMove(d) {
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
    setQuickOpen(true);
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
      // Calendar-only entries (P14.0) have no canonical task — their
      // completion is session-level only and never writes a Grid completion.
      if (session.task_id != null && dateIso <= todayIso()) {
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

  // ── Execution actions (P13.0, §3/§36/§37) ──────────────────────────────────
  // Lightweight Start/Finish stamps actual_* without turning this into a
  // timer app; planned_* is never touched by execution.

  async function startNow(session) {
    try {
      await updateSession(session.id, { actual_start: combinePlanned(nowIso, nowMin) });
    } catch (err) {
      console.error('start session failed:', err);
    }
    loadData();
  }

  async function finishNow(session) {
    const end = combinePlanned(nowIso, nowMin);
    const minutes = Math.max(1, plannedDiffMinutes(session.actual_start, end));
    const dateIso = plannedDate(session.planned_start);
    try {
      await updateSession(session.id, {
        actual_end: end, actual_minutes: minutes, status: 'completed',
      });
      if (session.task_id != null && dateIso <= todayIso()) {
        await upsertCompletion(session.task_id, dateIso);
      }
    } catch (err) {
      console.error('finish session failed:', err);
    }
    loadData();
  }

  async function savePartial(session) {
    const minutes = Number(partialEdit?.minutes);
    setPartialEdit(null);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    try {
      await updateSession(session.id, { status: 'partial', actual_minutes: Math.round(minutes) });
    } catch (err) {
      console.error('partial completion failed:', err);
    }
    loadData();
  }

  async function toggleFixed(session) {
    const next = session.is_fixed ? 0 : 1;
    setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, is_fixed: next } : s)));
    try {
      await updateSession(session.id, { is_fixed: !!next });
    } catch (err) {
      console.error('toggle fixed failed:', err);
    }
    loadData();
  }

  // §50 / V5.1 §21 — another session of the same canonical task (or another
  // block of the same calendar-only entry). Never duplicates the task
  // record. targetDateIso (from "Pick date") wins over deltaDays.
  async function duplicateSession(session, deltaDays = 1, targetDateIso = null) {
    try {
      const startMin = plannedMinutes(session.planned_start);
      const body = session.task_id != null
        ? { task_id: session.task_id }
        : {
          title: session.title || session.task_name,
          depth: session.depth ?? 0,
          context_id: session.context_id,
        };
      await createSession({
        ...body,
        planned_start: targetDateIso
          ? combinePlanned(targetDateIso, startMin)
          : shiftPlannedDays(session.planned_start, deltaDays),
        planned_end: targetDateIso
          ? combinePlannedEnd(targetDateIso, startMin + session.planned_minutes)
          : shiftPlannedDays(session.planned_end, deltaDays),
      });
    } catch (err) {
      console.error('duplicate session failed:', err);
    }
    loadData();
  }

  // ── Keyboard scheduling (V5.1 §12/§13) ─────────────────────────────────────
  // Rapid presses must compound on each other, and React state can lag a
  // fast key burst (listeners re-bind in effects, which run after paint).
  // nudgeBaseRef is the synchronous source of truth for the latest applied
  // times — updated in the same tick as the PATCH, immune to render timing.
  // The optimistic setSessions keeps the screen current; the debounced
  // reload reconciles rollups once the burst settles.
  const nudgeReloadRef = useRef(null);
  const nudgeBaseRef = useRef(null); // { id, start, end, minutes }

  function nudgeTimesOf(session) {
    const b = nudgeBaseRef.current;
    if (b && b.id === session.id) return b;
    return {
      id: session.id,
      start: session.planned_start,
      end: session.planned_end,
      minutes: session.planned_minutes,
    };
  }

  async function applyNudge(session, newStart, newEnd) {
    nudgeBaseRef.current = {
      id: session.id, start: newStart, end: newEnd,
      minutes: plannedDiffMinutes(newStart, newEnd),
    };
    setQuickOpen(false); // its anchor rect is stale the moment the block moves
    setSessions((prev) => prev.map((x) => (x.id === session.id
      ? {
        ...x,
        planned_start: newStart,
        planned_end: newEnd,
        planned_minutes: plannedDiffMinutes(newStart, newEnd),
      }
      : x)));
    try {
      await updateSession(session.id, { planned_start: newStart, planned_end: newEnd });
      clearTimeout(nudgeReloadRef.current);
      nudgeReloadRef.current = setTimeout(() => loadData(), 800);
    } catch (err) {
      console.error('keyboard reschedule failed:', err);
      loadData();
    }
  }

  function nudgeMoveMinutes(session, delta) {
    const base = nudgeTimesOf(session);
    const startMin = plannedMinutes(base.start);
    const next = Math.max(0, Math.min(DAY_MINUTES - base.minutes, startMin + delta));
    if (next === startMin) return;
    const dateIso = plannedDate(base.start);
    applyNudge(
      session,
      combinePlanned(dateIso, next),
      combinePlannedEnd(dateIso, next + base.minutes),
    );
  }

  function nudgeMoveDays(session, dir) {
    const base = nudgeTimesOf(session);
    applyNudge(
      session,
      shiftPlannedDays(base.start, dir),
      shiftPlannedDays(base.end, dir),
    );
  }

  function nudgeResize(session, delta) {
    const base = nudgeTimesOf(session);
    const startMin = plannedMinutes(base.start);
    const dur = Math.max(
      MIN_SESSION_MINUTES,
      Math.min(DAY_MINUTES - startMin, base.minutes + delta),
    );
    if (dur === base.minutes) return;
    applyNudge(
      session,
      base.start,
      combinePlannedEnd(plannedDate(base.start), startMin + dur),
    );
  }

  async function rescheduleSession(session, deltaDays) {
    try {
      await updateSession(session.id, {
        planned_start: shiftPlannedDays(session.planned_start, deltaDays),
        planned_end: shiftPlannedDays(session.planned_end, deltaDays),
      });
    } catch (err) {
      console.error('reschedule session failed:', err);
    }
    loadData();
  }

  // Skipped = "this didn't happen": planned history is kept, the block stays
  // (muted) as displaced work, and the effort returns to the backlog.
  async function skipSession(session) {
    try {
      await updateSession(session.id, { status: 'skipped' });
    } catch (err) {
      console.error('skip session failed:', err);
    }
    loadData();
  }

  // ── Shift Remaining Day (P15.0 §14–§17) ────────────────────────────────────
  // Moves today's remaining FLEXIBLE scheduled work later by N minutes.
  // Fixed sessions, external commitments, and depth windows stay put; any
  // resulting overlap with a fixed obstacle is surfaced for the user to
  // resolve — never silently overlapped, shortened, or discarded.

  function todayFixedObstacles() {
    const today = todayIso();
    const out = [];
    for (const s of sessions) {
      if (!s.is_fixed || s.status !== 'scheduled') continue;
      if (plannedDate(s.planned_start) !== today) continue;
      const startMin = plannedMinutes(s.planned_start);
      out.push({ startMin, endMin: Math.min(DAY_MINUTES, startMin + s.planned_minutes),
        label: displayTitle(s.task_name) });
    }
    for (const ev of externalEvents) {
      if (ev.all_day || plannedDate(ev.start) !== today) continue;
      const startMin = plannedMinutes(ev.start);
      const endMin = plannedDate(ev.end) === today ? plannedMinutes(ev.end) : DAY_MINUTES;
      out.push({ startMin, endMin, label: `${displayTitle(ev.title)} (${ev.calendar_name})` });
    }
    return out;
  }

  function buildShiftPlan(minutes) {
    const today = todayIso();
    const obstacles = todayFixedObstacles();
    const proposed = sessions
      .filter((s) => s.status === 'scheduled' && !s.is_fixed
        && plannedDate(s.planned_start) === today && s.planned_start >= nowStamp)
      .map((s) => {
        const dur = Math.min(s.planned_minutes, DAY_MINUTES);
        let newStartMin = plannedMinutes(s.planned_start) + minutes;
        let newEndMin = newStartMin + dur;
        if (newEndMin > DAY_MINUTES) { newEndMin = DAY_MINUTES; newStartMin = Math.max(0, DAY_MINUTES - dur); }
        const conflict = obstacles.find((o) => o.startMin < newEndMin && o.endMin > newStartMin) ?? null;
        return { session: s, newStartMin, newEndMin, conflict, resolution: conflict ? 'keep' : null };
      })
      .sort((a, b) => a.newStartMin - b.newStartMin);
    setShiftOpen(false);
    setShiftPlan({ minutes, proposed });
  }

  // Resolved [start, end] for one proposed move given its conflict choice.
  function resolvedShiftTimes(p) {
    const dur = p.newEndMin - p.newStartMin;
    if (!p.conflict || p.resolution === 'keep') return [p.newStartMin, p.newEndMin];
    if (p.resolution === 'after') {
      const s = p.conflict.endMin;
      return [s, Math.min(DAY_MINUTES, s + dur)];
    }
    if (p.resolution === 'shorten') {
      return [p.newStartMin, Math.max(p.newStartMin + MIN_SESSION_MINUTES, p.conflict.startMin)];
    }
    return [p.newStartMin, p.newEndMin];
  }

  async function applyShiftPlan() {
    const plan = shiftPlan;
    if (!plan) return;
    setShiftPlan(null);
    const today = todayIso();
    try {
      for (const p of plan.proposed) {
        if (p.resolution === 'unschedule') {
          await updateSession(p.session.id, { status: 'skipped' });
          continue;
        }
        const [sm, em] = resolvedShiftTimes(p);
        await updateSession(p.session.id, {
          planned_start: combinePlanned(today, sm),
          planned_end: combinePlannedEnd(today, em),
        });
      }
    } catch (err) {
      console.error('shift remaining failed:', err);
    }
    loadData();
  }

  // ── Did This Instead (P15.0 §18–§22) ───────────────────────────────────────
  // Preserves both facts: the original block keeps its planned times and
  // becomes displaced (skipped — linked-task effort returns to the backlog);
  // what actually happened lands as a COMPLETED calendar-only entry over the
  // actual interval. No Grid obligation is created for the replacement.
  async function recordInstead() {
    const d = insteadFor;
    if (!d) return;
    const title = d.title.trim();
    if (!title) {
      setInsteadFor((x) => (x ? { ...x, error: 'What did you do instead?' } : x));
      return;
    }
    const dateIso = plannedDate(d.session.planned_start);
    setInsteadFor(null);
    try {
      await updateSession(d.session.id, { status: 'skipped' });
      const entry = await createSession({
        title,
        planned_start: combinePlanned(dateIso, d.startMin),
        planned_end: combinePlannedEnd(dateIso, d.endMin),
      });
      await updateSession(entry.id, {
        status: 'completed',
        actual_start: combinePlanned(dateIso, d.startMin),
        actual_end: combinePlannedEnd(dateIso, d.endMin),
        actual_minutes: d.endMin - d.startMin,
      });
    } catch (err) {
      console.error('did-this-instead failed:', err);
    }
    loadData();
  }

  function openInstead(session) {
    closeTransients();
    const dateIso = plannedDate(session.planned_start);
    const startMin = plannedMinutes(session.planned_start);
    const plannedEnd = Math.min(DAY_MINUTES, startMin + session.planned_minutes);
    const endMin = dateIso === nowIso && nowMin > startMin
      ? Math.min(plannedEnd, Math.max(startMin + MIN_SESSION_MINUTES, snapMinutes(nowMin)))
      : plannedEnd;
    setInsteadFor({ session, title: '', startMin, endMin, error: '' });
  }

  // ── Depth window templates (P15.0 §28/§29) ─────────────────────────────────
  async function applyTemplateToDate(tpl, dateIso) {
    setTemplateMode(null);
    try {
      for (const item of tpl.items) {
        await createDepthWindow({
          depth: item.depth,
          date: dateIso,
          start_minutes: item.start_minutes,
          end_minutes: item.end_minutes,
          protected: !!item.protected,
        });
      }
      setWindows(await fetchDepthWindows());
    } catch (err) {
      console.error('apply template failed:', err);
    }
  }

  async function captureTemplateFromDate(dateIso, updateTpl = null) {
    setTemplateMode(null);
    const items = windowsOnDate(windows, dateIso).map((w) => ({
      depth: w.depth,
      start_minutes: w.start_minutes,
      end_minutes: w.end_minutes,
      protected: w.protected === 1,
    }));
    if (items.length === 0) {
      console.warn('no windows on that day to capture');
      return;
    }
    try {
      if (updateTpl) {
        await updateWindowTemplate(updateTpl.id, { items });
      } else {
        const { weekday, dayNum } = dayHeaderLabel(dateIso);
        await createWindowTemplate(`Windows from ${weekday} ${dayNum}`, items);
      }
      setTemplates(await fetchWindowTemplates());
      setTemplatesOpen(true);
    } catch (err) {
      console.error('save template failed:', err);
    }
  }

  // ── External commitment detail (P16.0 §44) ─────────────────────────────────
  async function openExtDetail(ev, rect) {
    closeTransients();
    let links = [];
    let proposal = null;
    try {
      links = await fetchTaskEventLinks({ calendar_id: ev.calendar_id, uid: ev.uid });
      // Moved event with related sessions (V5.0 §3/§4)? The proposal is
      // computed server-side; fetching it changes nothing.
      if (links.some((l) => l.event_status === 'moved')) {
        const p = await fetchEventMoveProposal(ev.calendar_id, ev.uid);
        if (p.moved) proposal = p;
      }
    } catch { /* isolated */ }
    setExtDetail({ event: ev, rect, links, proposal, reviewSel: null, linkPicker: null, ctxDraft: '' });
  }

  // Apply an event-move decision (V5.0 §4). sessionIds picks which flexible
  // sessions actually move (empty = "keep current schedule"); either way the
  // links' remembered event_start advances so the offer is acknowledged.
  async function resolveEventMove(ev, proposal, sessionIds) {
    try {
      for (const item of proposal.items) {
        if (!sessionIds.includes(item.session_id)) continue;
        await updateSession(item.session_id, {
          planned_start: item.proposed_start,
          planned_end: item.proposed_end,
        });
      }
      for (const linkId of proposal.link_ids) {
        await updateTaskEventLink(linkId, { event_start: proposal.new_start });
      }
      await loadData();
      const links = await fetchTaskEventLinks({ calendar_id: ev.calendar_id, uid: ev.uid });
      setExtDetail((d) => (d && d.event.uid === ev.uid
        ? { ...d, links, proposal: null, reviewSel: null } : d));
    } catch (err) {
      console.error('event-move resolution failed:', err);
    }
  }

  async function refreshExtDetailLinks(ev) {
    try {
      const links = await fetchTaskEventLinks({ calendar_id: ev.calendar_id, uid: ev.uid });
      setExtDetail((d) => (d && d.event.uid === ev.uid ? { ...d, links } : d));
    } catch { /* isolated */ }
  }

  async function assignEventContext(ev, name) {
    const trimmed = name.trim();
    try {
      if (!trimmed) {
        await unlinkEventFromContext(ev.calendar_id, ev.uid);
      } else {
        const ctx = await createContext(trimmed);
        await linkEventToContext(ctx.id, ev.calendar_id, ev.uid);
        setContexts(await fetchContexts());
      }
      await refreshExternal();
      setExtDetail((d) => (d ? {
        ...d,
        ctxDraft: '',
        event: { ...d.event, context_name: trimmed || null },
      } : d));
    } catch (err) {
      console.error('assign context failed:', err);
    }
  }

  async function addEventTaskLink(ev, task, relation) {
    try {
      await createTaskEventLink({
        task_id: task.id,
        calendar_id: ev.calendar_id,
        uid: ev.uid,
        relation,
        event_start: ev.start,
      });
      await refreshExtDetailLinks(ev);
      setExtDetail((d) => (d ? { ...d, linkPicker: null } : d));
    } catch (err) {
      console.error('link task failed:', err);
    }
  }

  // Post-class review (§41/§42): suggestion-driven only. If the context has
  // an unfinished task with remaining effort, arm placement for it;
  // otherwise open the canonical New Task modal prefilled, then place.
  function scheduleReview(rem) {
    closeTransients();
    const ctxTask = tasks.find((t) => t.context_name === rem.context_name
      && !t.is_paused && !t.is_ended
      && /review/i.test(t.name)
      && (t.remaining_unscheduled_minutes ?? 0) > 0);
    if (ctxTask) {
      setPlacingTask(ctxTask);
    } else {
      setReviewDraft({ contextName: rem.context_name });
    }
    dismissReminder(rem.key);
  }

  function dismissReminder(key) {
    setDismissedReminders((prev) => (prev.includes(key) ? prev : [...prev, key]));
  }

  const visibleReminders = useMemo(() => (
    reminders.filter((r) => reminderPrefs[r.type] !== false && !dismissedReminders.includes(r.key))
  ), [reminders, reminderPrefs, dismissedReminders]);

  async function refreshExternal() {
    try {
      setExternalCalendars(await fetchExternalCalendars());
      setExternalEvents(await fetchExternalEvents(rangeStart, rangeEnd));
    } catch (err) {
      console.warn('external refresh failed:', err);
    }
  }

  async function addExternalCalendar() {
    const name = calDraft.name.trim();
    const url = calDraft.url.trim();
    if (!name || !url) {
      setCalDraft((d) => ({ ...d, error: 'Name and ICS URL are both required.' }));
      return;
    }
    setCalDraft((d) => ({ ...d, busy: true, error: '' }));
    try {
      const cal = await createExternalCalendar(name, url);
      setCalDraft({ name: '', url: '', busy: false, error: cal.last_error ? `Added, but sync failed: ${cal.last_error}` : '' });
      await refreshExternal();
    } catch (err) {
      setCalDraft((d) => ({ ...d, busy: false, error: err?.message || 'Add failed.' }));
    }
  }

  async function skipWindowDay(windowId, dateIso) {
    setWindowMenu(null);
    try {
      await skipDepthWindowDay(windowId, dateIso);
      setWindows((prev) => prev.map((w) =>
        (w.id === windowId ? { ...w, skips: [...(w.skips ?? []), dateIso] } : w)));
    } catch (err) {
      console.error('skip window day failed:', err);
    }
  }

  // ── Creation ───────────────────────────────────────────────────────────────
  // Default drag creation makes a CALENDAR-ONLY entry (P14.0) — nothing is
  // written to the Grid. "Add to main Grid…" is the explicit promotion path.
  async function commitCreateEntry() {
    const c = creator;
    if (!c || c.saving) return;
    const title = c.title.trim();
    if (!title) {
      setCreator((cc) => (cc ? { ...cc, error: 'Enter a name.' } : cc));
      return;
    }
    setCreator((cc) => (cc ? { ...cc, saving: true, error: '' } : cc));
    try {
      await createSession({
        title,
        depth: c.depth || null,
        context_id: c.nlContextId || null, // NL-matched course (V5.2), if any
        planned_start: combinePlanned(c.dateIso, c.startMin),
        planned_end: combinePlannedEnd(c.dateIso, c.endMin),
        is_fixed: !!c.isFixed,
      });
      setCreator(null);
      await loadData();
    } catch (err) {
      setCreator((cc) => (cc ? { ...cc, saving: false, error: err?.message || 'Create failed.' } : cc));
    }
  }

  // Creation-time promotion: persist the entry first, then route through the
  // canonical New Task modal; the entry links on save (§3/§4). If the modal
  // is cancelled the calendar entry simply stays calendar-only.
  async function addToGridFromCreator() {
    const c = creator;
    if (!c || c.saving) return;
    const title = c.title.trim();
    if (!title) {
      setCreator((cc) => (cc ? { ...cc, error: 'Enter a name first.' } : cc));
      return;
    }
    setCreator((cc) => (cc ? { ...cc, saving: true, error: '' } : cc));
    try {
      const entry = await createSession({
        title,
        depth: c.depth || null,
        planned_start: combinePlanned(c.dateIso, c.startMin),
        planned_end: combinePlannedEnd(c.dateIso, c.endMin),
        is_fixed: !!c.isFixed,
      });
      setCreator(null);
      setPromoteFor({
        sessionId: entry.id,
        initialValues: {
          name: title,
          depth: c.depth || 0,
          estimated_minutes: c.endMin - c.startMin,
        },
      });
      await loadData();
    } catch (err) {
      setCreator((cc) => (cc ? { ...cc, saving: false, error: err?.message || 'Create failed.' } : cc));
    }
  }

  // Existing-task mode (§7/§33): schedules ONE new session for the chosen
  // canonical task in the selected interval — never a duplicate task record.
  async function scheduleExistingTask(task) {
    const c = creator;
    if (!c || c.saving) return;
    const commit = async () => {
      setCreator((cc) => (cc ? { ...cc, saving: true, error: '' } : cc));
      try {
        await createSession({
          task_id: task.id,
          planned_start: combinePlanned(c.dateIso, c.startMin),
          planned_end: combinePlannedEnd(c.dateIso, c.endMin),
        });
        setCreator(null);
        await loadData();
      } catch (err) {
        setCreator((cc) => (cc ? { ...cc, saving: false, error: err?.message || 'Schedule failed.' } : cc));
      }
    };
    const conflict = protectedConflictAt(c.dateIso, c.startMin, c.endMin, task.depth);
    if (conflict) {
      confirmProtected(conflict, task.depth, task.name, commit);
      return;
    }
    await commit();
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
        protected: c.protected,
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

  // Depth change routes to the right canonical home: the task when linked,
  // the entry row itself when calendar-only (P14.0).
  async function setDepthFor(session, depth) {
    setSessions((prev) => prev.map((s) =>
      (s.id === session.id || (session.task_id != null && s.task_id === session.task_id)
        ? { ...s, task_depth: depth || null } : s)));
    try {
      if (session.task_id != null) {
        await updateTask(session.task_id, { depth: depth || 0 });
      } else {
        await updateSession(session.id, { depth: depth || 0 });
      }
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
    // Multi-session tasks (§17): the next session offers the task's remaining
    // unscheduled effort, falling back to the full estimate, then the default.
    const dur = Math.max(MIN_SESSION_MINUTES,
      task.remaining_unscheduled_minutes || task.estimated_minutes || DEFAULT_SESSION_MINUTES);
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

  function onGridDrop(e) {
    const target = drawerDropTarget(e.clientX, e.clientY);
    drawerDragRef.current = null;
    setDropPreview(null);
    if (!target) return;
    e.preventDefault();
    const conflict = protectedConflictAt(
      target.dateIso, target.startMin, target.endMin, target.task.depth);
    if (conflict) {
      confirmProtected(conflict, target.task.depth, target.task.name, () => performDrawerDrop(target));
      return;
    }
    performDrawerDrop(target);
  }

  async function performDrawerDrop(target) {
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
        if (hideCompleted && s.status === 'completed') continue;
        const seg = sessionSegmentOnDate(s, dIso);
        if (seg) dayBlocks.push({ session: s, ...seg });
      }
      // External commitments share the overlap layout so events and work
      // blocks column-pack together like one surface (P15.0).
      for (const ev of externalEvents) {
        if (ev.all_day) continue;
        const seg = sessionSegmentOnDate({ planned_start: ev.start, planned_end: ev.end }, dIso);
        if (seg) dayBlocks.push({ ext: ev, ...seg });
      }
      map[dIso] = layoutBlocks(dayBlocks);
    }
    return map;
  }, [sessions, externalEvents, dates, hideCompleted]);

  // All-day external events render as slim banners at the top of the column.
  const allDayByDate = useMemo(() => {
    const map = {};
    for (const ev of externalEvents) {
      if (!ev.all_day) continue;
      let d = plannedDate(ev.start);
      const last = plannedDate(ev.end); // exclusive end
      while (d < last) {
        (map[d] = map[d] ?? []).push(ev);
        d = addDaysIso(d, 1);
      }
    }
    return map;
  }, [externalEvents]);

  // Unscheduled queue (P13.0, §16/§17): a task is offered when it has no
  // upcoming scheduled session, OR when its estimate still has unscheduled
  // remaining effort — multi-session tasks stay available until covered.
  const unscheduledByDepth = useMemo(() => {
    const scheduledIds = new Set(
      upcomingSessions.filter((s) => s.status === 'scheduled').map((s) => s.task_id),
    );
    const groups = { 1: [], 2: [], 3: [], 0: [] };
    for (const t of tasks) {
      if (t.is_paused || t.is_ended) continue;
      const hasUpcoming = scheduledIds.has(t.id);
      const hasRemaining = !!t.estimated_minutes && (t.remaining_unscheduled_minutes ?? 0) > 0;
      if (hasUpcoming && !hasRemaining) continue;
      groups[t.depth ?? 0].push(t);
    }
    return groups;
  }, [tasks, upcomingSessions]);

  // Sessions whose planned time has fully passed while still 'scheduled' —
  // the end-of-day reconciliation queue (§36). Union of the visible range and
  // the trailing 14 days so last week's misses surface too.
  const nowStamp = combinePlanned(nowIso, nowMin);
  const unresolvedSessions = useMemo(() => {
    const byId = new Map();
    for (const s of [...recentSessions, ...sessions, ...upcomingSessions]) {
      if (s.status !== 'scheduled') continue;
      if (s.planned_end >= nowStamp) continue;
      byId.set(s.id, s);
    }
    return [...byId.values()].sort((a, b) => (a.planned_start < b.planned_start ? -1 : 1));
  }, [recentSessions, sessions, upcomingSessions, nowStamp]);

  // Existing-task selector candidates (§7) — active canonical tasks matching
  // the search across name / section / category / depth ("d1" matches).
  const existingTaskMatches = useMemo(() => {
    if (!creator || creator.kind !== 'task' || creator.tab !== 'existing') return [];
    const q = (creator.search ?? '').trim().toLowerCase();
    const out = [];
    for (const t of tasks) {
      if (t.is_paused || t.is_ended) continue;
      if (q) {
        const hay = `${t.name} ${t.section ?? ''} ${t.category ?? ''} d${t.depth ?? ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push(t);
      if (out.length >= 30) break;
    }
    return out;
  }, [creator, tasks]);

  const unscheduledCount = unscheduledByDepth[1].length + unscheduledByDepth[2].length
    + unscheduledByDepth[3].length + unscheduledByDepth[0].length;

  const sectionSuggestions = useMemo(
    () => [...new Set(tasks.map((t) => t.section).filter(Boolean))],
    [tasks],
  );

  // ── Natural-language creation + search (V5.2) ──────────────────────────────
  // NL parse is interpretation only — the creator popover shows the parsed
  // proposal (date, time, assumptions, matched task/context) and the user
  // confirms or edits before anything exists (§10). Calendar-only default
  // (§11) holds because confirmation goes through the ordinary entry tab.
  async function nlCreate(q) {
    try {
      const p = await parseNaturalLanguage(q);
      closeTransients();
      setAnchorIso(p.date);
      setCreator({
        kind: 'task',
        mode: 'popover',
        tab: p.task_id ? 'existing' : 'new',
        dateIso: p.date,
        startMin: p.start_minutes,
        endMin: Math.max(p.start_minutes + MIN_SESSION_MINUTES,
          Math.min(DAY_MINUTES, p.end_minutes)),
        title: p.title || q,
        depth: p.depth ?? 0,
        isFixed: !!p.is_fixed,
        search: p.task_name || '',
        nlNotes: p.notes || [],
        nlContextId: p.context_id || null,
        nlContextName: p.context_name || null,
        saving: false,
        error: '',
      });
    } catch (err) {
      console.error('natural-language parse failed:', err);
    }
  }

  function openSearch(q = '') {
    closeTransients();
    setSearchQuery(q);
    setSearchCtx(null);
    setSearchResults(null);
    setSearchOpen(true);
  }

  useEffect(() => {
    if (!searchOpen) return undefined;
    const q = searchQuery.trim();
    if (!q && !searchCtx) {
      setSearchResults(null);
      return undefined;
    }
    const timer = setTimeout(async () => {
      try {
        setSearchResults(await searchCalendar({
          q,
          types: searchFilters.types ?? undefined,
          status: searchFilters.status ?? undefined,
          start: searchFilters.from || undefined,
          end: searchFilters.to || undefined,
          context_id: searchCtx?.id,
        }));
      } catch (err) {
        console.error('search failed:', err);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [searchOpen, searchQuery, searchFilters, searchCtx]);

  // §17 — a result is a place, not a text row: navigate there and select it.
  function gotoSearchSession(r) {
    setSearchOpen(false);
    setAnchorIso(r.planned_start.slice(0, 10));
    setSelected({ sessionId: r.id, rect: null });
    setQuickOpen(false);
  }

  function gotoSearchEvent(r) {
    setSearchOpen(false);
    setAnchorIso(r.start.slice(0, 10));
  }

  // ── Command palette (V5.1 Part II) ─────────────────────────────────────────
  // Every command dispatches to the exact handler its equivalent button uses.
  // Context-aware (§7): session-specific commands appear only with a session
  // selected, and only the ones its status actually supports.
  function openPaletteCreator() {
    closeTransients();
    const today = todayIso();
    const dateIso = dates.includes(today) ? today : dates[0];
    let startMin = 9 * 60;
    if (dateIso === today) {
      startMin = Math.max(0, Math.min(DAY_MINUTES - 60,
        Math.ceil(nowMin / SNAP_MINUTES) * SNAP_MINUTES));
    }
    setCreator({
      kind: 'task', mode: 'popover', tab: 'new',
      dateIso, startMin, endMin: Math.min(DAY_MINUTES, startMin + DEFAULT_SESSION_MINUTES),
      title: '', depth: 0, isFixed: false, search: '',
      saving: false, error: '',
    });
  }

  function buildPaletteCommands() {
    const periodNoun = viewMode === 'week' ? 'week' : 'day';
    const cmds = [
      { id: 'today', label: 'Go to today', hint: 'T', keywords: 'now current', run: goToday },
      { id: 'view-day', label: 'Day view', hint: 'D', run: () => setViewMode('day') },
      { id: 'view-week', label: 'Week view', hint: 'W', run: () => setViewMode('week') },
      { id: 'next', label: `Next ${periodNoun}`, hint: '→', keywords: 'forward', run: () => shiftPeriod(1) },
      { id: 'prev', label: `Previous ${periodNoun}`, hint: '←', keywords: 'back', run: () => shiftPeriod(-1) },
      { id: 'new-entry', label: 'New calendar entry…', keywords: 'create block session', run: openPaletteCreator },
      { id: 'new-task', label: 'New Grid task…', keywords: 'create canonical', run: () => { closeTransients(); setNewTaskOpen(true); } },
      { id: 'search', label: 'Search Calendar…', keywords: 'find lookup history', run: () => openSearch('') },
      { id: 'academic', label: 'Academic import…', keywords: 'syllabus course schedule paste', run: () => { closeTransients(); setImportOpen(true); } },
      {
        id: 'drawer',
        label: drawerOpen ? 'Close unscheduled drawer' : 'Open unscheduled drawer',
        keywords: 'tasks remaining place',
        run: () => setDrawerOpen((o) => !o),
      },
      { id: 'shift', label: 'Shift remaining day…', keywords: 'replan later push', run: () => { closeTransients(); setShiftOpen(true); } },
      { id: 'reminders', label: 'Reminders…', keywords: 'notifications', run: () => { closeTransients(); setRemindersOpen(true); } },
      { id: 'calendars', label: 'External calendars…', keywords: 'ics feeds subscribe', run: () => { closeTransients(); setCalsOpen(true); } },
      { id: 'templates', label: 'Depth window templates…', keywords: 'windows apply', run: () => { closeTransients(); setTemplatesOpen(true); } },
      {
        id: 'hide-done',
        label: hideCompleted ? 'Show completed sessions' : 'Hide completed sessions',
        run: () => setHideCompleted((v) => !v),
      },
      ...['compact', 'standard', 'detailed'].map((d) => ({
        id: `density-${d}`,
        label: `Density: ${d[0].toUpperCase()}${d.slice(1)}`,
        keywords: 'zoom scale hours',
        hint: density === d ? 'current' : undefined,
        run: () => setDensity(d),
      })),
    ];
    if (unresolvedSessions.length > 0) {
      cmds.push({
        id: 'reconcile',
        label: `Review unresolved sessions · ${unresolvedSessions.length}`,
        keywords: 'reconcile past',
        run: () => { closeTransients(); setReconcileOpen(true); },
      });
    }
    if (selectedSession) {
      const s = selectedSession;
      const linkedTask = s.task_id != null ? tasks.find((t) => t.id === s.task_id) : null;
      const label = displayTitle(s.task_name);
      cmds.push({
        id: 'sel-edit', label: `Edit “${label}”`, hint: 'E',
        run: () => { setQuickOpen(false); setEditorSessionId(s.id); },
      });
      if (s.status !== 'completed') {
        cmds.push({
          id: 'sel-complete',
          label: linkedTask ? 'Complete session' : 'Complete entry',
          run: () => toggleComplete(s),
        });
      }
      if (s.status === 'scheduled') {
        cmds.push({
          id: 'sel-instead', label: 'Did this instead…',
          keywords: 'replace displaced actual',
          run: () => openInstead(s),
        });
      }
      if (linkedTask) {
        cmds.push({
          id: 'sel-open', label: 'Open full task',
          run: () => { closeTransients(); setEditingTask(linkedTask); },
        });
        if ((linkedTask.remaining_unscheduled_minutes ?? 0) > 0) {
          cmds.push({
            id: 'sel-remaining',
            label: `Schedule remaining · ${durationLabel(linkedTask.remaining_unscheduled_minutes)}`,
            run: () => { closeTransients(); setPlacingTask(linkedTask); },
          });
        }
      }
      cmds.push(
        {
          id: 'sel-dup-tomorrow', label: 'Duplicate session · tomorrow',
          keywords: 'another again', run: () => duplicateSession(s, 1),
        },
        {
          id: 'sel-dup-week', label: 'Duplicate session · next week',
          keywords: 'another again', run: () => duplicateSession(s, 7),
        },
        {
          id: 'sel-remove', label: linkedTask ? 'Remove session' : 'Remove entry',
          keywords: 'delete', run: () => removeSession(s.id),
        },
      );
    }
    return cmds;
  }

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
    // §3 — the selected interval stays highlighted (with its exact times)
    // while the creation UI is open, and tracks live edits to start/end.
    if (creator && creator.dateIso === dateIso
      && (creator.kind === 'window' || creator.mode === 'popover')) {
      ghosts.push({
        key: 'creator',
        cls: creator.kind === 'window'
          ? 'cal-ghost cal-ghost--window cal-ghost--pinned'
          : 'cal-ghost cal-ghost--pinned',
        startMin: creator.startMin,
        endMin: creator.endMin,
      });
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
            if (e.key === 'Enter') { e.preventDefault(); commitCreateEntry(); }
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
    const partial = s.status === 'partial';
    const skipped = s.status === 'skipped';
    const isEntry = s.task_id == null; // calendar-only (P14.0)
    const depth = s.task_depth;
    // Now state (§3): the current-time line is inside this still-scheduled
    // block on today — restrained highlight, actions live in the popover.
    const isNow = dateIso === nowIso && s.status === 'scheduled'
      && item.startMin <= nowMin && nowMin < item.endMin;
    const mismatch = depthMismatchAt(dateIso, item.startMin, item.endMin, depth);
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
          partial ? 'is-partial' : '',
          skipped ? 'is-skipped' : '',
          isNow ? 'is-now' : '',
          isEntry ? 'cal-block--entry' : '',
          s.is_fixed ? 'is-fixed' : '',
          isDragSource ? 'is-drag-source' : '',
          selected?.sessionId === s.id || editorSessionId === s.id ? 'is-selected' : '',
        ].filter(Boolean).join(' ')}
        style={{
          top: minutesToPx(item.startMin),
          height: heightPx,
          left: `${item.col * width}%`,
          width: `calc(${width}% - 3px)`,
        }}
        onPointerDown={(e) => onBlockPointerDown(e, s, item)}
        title={`${displayTitle(s.task_name)} · ${formatTimeRange(item.startMin, item.endMin)}`}
      >
        <div className="cal-block-head">
          <button
            type="button"
            className={`cal-block-check${done ? ' is-done' : ''}${isEntry ? ' cal-block-check--entry' : ''}`}
            aria-label={isEntry
              ? (done ? 'Mark entry not completed' : 'Mark entry completed (calendar-only)')
              : (done ? 'Mark session not completed' : 'Mark session completed')}
            title={isEntry ? 'Calendar-only entry — completing it never writes a Grid completion' : undefined}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); toggleComplete(s); }}
          >
            {done ? '✓' : partial ? '◐' : ''}
          </button>
          <span className="cal-block-title">{displayTitle(s.task_name)}</span>
          {isNow && <span className="cal-now-chip">NOW</span>}
          {mismatch && (
            <span
              className="cal-mismatch"
              title={`D${depth} task in D${mismatch.depth} window`}
            >!</span>
          )}
          {depth != null && <span className={`cal-depth-pill cal-depth-pill--d${depth}`}>D{depth}</span>}
        </div>
        {!compact && (
          <div className="cal-block-meta">
            {formatTimeRange(item.startMin, item.endMin)}
            {partial && s.actual_minutes ? ` · ${durationLabel(s.actual_minutes)} done` : ''}
            {skipped ? ' · skipped' : ''}
            {!partial && !skipped && s.task_section && s.task_section !== 'General' ? ` · ${s.task_section}` : ''}
          </div>
        )}
        <div className="cal-block-resize" aria-hidden="true" />
      </div>
    );
  }

  // External commitment block (P15.0 §9): source-marked, Fixed, read-only —
  // no checkbox, no drag, no resize; never a task or an entry.
  function renderExtBlock(item, dateIso) {
    const ev = item.ext;
    const heightPx = Math.max(14, minutesToPx(item.endMin - item.startMin) - 2);
    const compact = heightPx < 34;
    const width = 100 / item.cols;
    return (
      <div
        key={`ext${ev.id}:${dateIso}`}
        className="cal-block cal-block--ext"
        style={{
          top: minutesToPx(item.startMin),
          height: heightPx,
          left: `${item.col * width}%`,
          width: `calc(${width}% - 3px)`,
        }}
        title={`${displayTitle(ev.title)} · ${formatTimeRange(item.startMin, item.endMin)} · ${ev.calendar_name} — external commitment (fixed)`}
        onClick={(e) => openExtDetail(ev, e.currentTarget.getBoundingClientRect())}
      >
        <div className="cal-block-head">
          <span className="cal-ext-marker" aria-hidden="true">▸</span>
          <span className="cal-block-title">{displayTitle(ev.title)}</span>
        </div>
        {!compact && (
          <div className="cal-block-meta">
            {formatTimeRange(item.startMin, item.endMin)} · {ev.calendar_name}
          </div>
        )}
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
    const style = popoverPosition(anchorRect, creator.kind === 'window' ? 340 : 380, creator.kind === 'window' ? 330 : 430);
    const minutes = creator.endMin - creator.startMin;

    if (creator.kind === 'window') {
      return (
        <div className="cal-popover cal-creator" style={style} role="dialog" aria-label="New depth window">
          <div className="cal-popover-kicker">New Depth Window</div>
          <div className="cal-popover-time">
            {fullDateLabel(creator.dateIso)} · {formatTimeRange(creator.startMin, creator.endMin)} · {durationLabel(minutes)}
          </div>
          <TimeRangeFields
            startMin={creator.startMin}
            endMin={creator.endMin}
            onChange={({ startMin, endMin }) => setCreator((c) => (c ? { ...c, startMin, endMin } : c))}
          />
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
          <label className="cal-popover-checkline">
            <input
              type="checkbox"
              checked={creator.protected}
              onChange={(e) => setCreator((c) => (c ? { ...c, protected: e.target.checked } : c))}
            />
            Protected — ask before scheduling other-depth work here
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

    const setTimes = ({ startMin, endMin }) =>
      setCreator((c) => (c ? { ...c, startMin, endMin } : c));
    const timeLine = `${fullDateLabel(creator.dateIso)} · ${formatTimeRange(creator.startMin, creator.endMin)} · ${durationLabel(creator.endMin - creator.startMin)}`;

    return (
      <div className="cal-popover cal-creator" style={style} role="dialog" aria-label="Schedule this time">
        {/* §6 — one selected interval, two intents. */}
        <div className="cal-seg cal-creator-tabs" role="tablist" aria-label="Creation mode">
          <button
            type="button"
            role="tab"
            aria-selected={creator.tab === 'new'}
            className={`cal-seg-btn${creator.tab === 'new' ? ' is-active' : ''}`}
            onClick={() => setCreator((c) => (c ? { ...c, tab: 'new', error: '' } : c))}
          >
            Calendar entry
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={creator.tab === 'existing'}
            className={`cal-seg-btn${creator.tab === 'existing' ? ' is-active' : ''}`}
            onClick={() => setCreator((c) => (c ? { ...c, tab: 'existing', error: '' } : c))}
          >
            Existing task
          </button>
        </div>
        <div className="cal-popover-time">{timeLine}</div>
        <TimeRangeFields
          startMin={creator.startMin}
          endMin={creator.endMin}
          onChange={setTimes}
        />
        {/* NL interpretation transparency (V5.2 §10) — what was matched and
            what was assumed, shown BEFORE anything is created. */}
        {creator.nlContextName && (
          <div className="cal-popover-hint">Context: {creator.nlContextName}</div>
        )}
        {creator.nlNotes?.length > 0 && (
          <div className="cal-popover-hint">Assumed: {creator.nlNotes.join(' · ')}</div>
        )}

        {creator.tab === 'new' ? (
          <>
            <input
              ref={creatorInputRef}
              className="task-modal-input cal-popover-title"
              placeholder="What is this time for?"
              value={creator.title}
              onChange={(e) => setCreator((c) => (c ? { ...c, title: e.target.value } : c))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitCreateEntry(); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCreator(null); }
              }}
            />
            <div className="cal-creator-row">
              <DepthSeg
                value={creator.depth}
                onChange={(d) => setCreator((c) => (c ? { ...c, depth: d } : c))}
              />
              <button
                type="button"
                className={`cal-flag-btn${creator.isFixed ? ' is-active' : ''}`}
                aria-pressed={creator.isFixed}
                title="Fixed sessions resist future automatic replanning"
                onClick={() => setCreator((c) => (c ? { ...c, isFixed: !c.isFixed } : c))}
              >
                {creator.isFixed ? 'Fixed' : 'Flexible'}
              </button>
            </div>
            <div className="cal-popover-hint">
              Creates a calendar entry only — nothing is added to the Grid
              unless you choose “Add to main Grid…”. {QUICK_CREATE_HINT} for
              inline creation · ⇧ drag for a depth window.
            </div>
            {(() => {
              const pw = protectedConflictAt(creator.dateIso, creator.startMin, creator.endMin, creator.depth || null);
              return pw ? (
                <div className="cal-popover-warn">
                  This time sits in a protected D{pw.depth} window.
                </div>
              ) : null;
            })()}
            {creator.error && <div className="cal-popover-error" role="alert">{creator.error}</div>}
            <div className="cal-popover-actions cal-popover-actions--spread">
              <button
                type="button"
                className="task-modal-cancel"
                title="Create this as a canonical Grid task via the standard New Task form"
                onClick={addToGridFromCreator}
                disabled={creator.saving}
              >
                Add to main Grid…
              </button>
              <div className="cal-popover-actions-right">
                <button type="button" className="task-modal-cancel" onClick={() => setCreator(null)}>Cancel</button>
                <button type="button" className="task-modal-save" onClick={commitCreateEntry} disabled={creator.saving}>
                  {creator.saving ? 'Creating…' : 'Create entry'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <input
              ref={creatorInputRef}
              className="task-modal-input cal-popover-title"
              placeholder="Search tasks — name, section, category, d1…"
              value={creator.search}
              onChange={(e) => setCreator((c) => (c ? { ...c, search: e.target.value } : c))}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCreator(null); }
                if (e.key === 'Enter' && existingTaskMatches.length === 1) {
                  e.preventDefault();
                  scheduleExistingTask(existingTaskMatches[0]);
                }
              }}
            />
            <div className="cal-task-picker" role="listbox" aria-label="Choose a task to schedule">
              {existingTaskMatches.length === 0 && (
                <div className="cal-task-picker-empty">No matching active tasks.</div>
              )}
              {existingTaskMatches.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="option"
                  aria-selected="false"
                  className={`cal-task-picker-row${t.depth ? ` cal-task-picker-row--d${t.depth}` : ''}`}
                  title="Schedule this task in the selected interval"
                  onClick={() => scheduleExistingTask(t)}
                >
                  <span className="cal-task-picker-name">{displayTitle(t.name)}</span>
                  <span className="cal-task-picker-meta">
                    {[
                      t.section && t.section !== 'General' ? t.section : null,
                      t.depth ? `D${t.depth}` : null,
                      t.estimated_minutes
                        ? (t.remaining_minutes != null && t.remaining_minutes !== t.estimated_minutes
                          ? `${durationLabel(t.remaining_minutes)} remaining`
                          : durationLabel(t.estimated_minutes))
                        : null,
                    ].filter(Boolean).join(' · ') || '—'}
                  </span>
                </button>
              ))}
            </div>
            <div className="cal-popover-hint">
              Schedules a session for the chosen task — the task itself is never
              duplicated.
            </div>
            {creator.error && <div className="cal-popover-error" role="alert">{creator.error}</div>}
            <div className="cal-popover-actions">
              <button type="button" className="task-modal-cancel" onClick={() => setCreator(null)}>Cancel</button>
            </div>
          </>
        )}
      </div>
    );
  }

  // ── Popover: session detail ────────────────────────────────────────────────
  function renderSessionPopover() {
    // Mutually exclusive with the full editor (§4) — quickOpen is cleared
    // before the editor ever opens, and closing the editor never sets it.
    if (!quickOpen || editorSessionId || !selectedSession) return null;
    const s = selectedSession;
    const startMin = plannedMinutes(s.planned_start);
    const dateIso = plannedDate(s.planned_start);
    const style = popoverPosition(selected.rect, 320, 320);
    const done = s.status === 'completed';
    const task = tasks.find((t) => t.id === s.task_id) ?? null;
    const isNow = dateIso === nowIso && startMin <= nowMin && nowMin < startMin + s.planned_minutes;
    const canStart = isNow && s.status === 'scheduled' && !s.actual_start;
    const canFinish = s.actual_start && !s.actual_end && s.status === 'scheduled';
    const actualLine = s.actual_start || s.actual_minutes != null
      ? [
        s.actual_start ? `${s.actual_start.slice(11, 16)}${s.actual_end ? `–${s.actual_end.slice(11, 16)}` : '–…'}` : null,
        s.actual_minutes != null ? durationLabel(s.actual_minutes) : null,
      ].filter(Boolean).join(' · ')
      : null;
    return (
      <div className="cal-popover" style={style} role="dialog" aria-label="Session details">
        <div className="cal-popover-head">
          <span className="cal-popover-name">
            {isNow && s.status === 'scheduled' && <span className="cal-now-chip">NOW</span>}
            {displayTitle(s.task_name)}
            {s.task_id == null && (
              <span className="cal-entry-chip" title="Lives only on the Calendar — not a Grid task">
                calendar-only
              </span>
            )}
          </span>
          <button type="button" className="cal-popover-close" aria-label="Close" onClick={() => setSelected(null)}>×</button>
        </div>
        <div className="cal-popover-time">
          {fullDateLabel(dateIso)}
          <br />
          {formatTimeRange(startMin, startMin + s.planned_minutes)} · {durationLabel(s.planned_minutes)}
          {s.task_section && s.task_section !== 'General' ? ` · ${s.task_section}` : ''}
          {s.context_name ? ` · ${s.context_name}` : ''}
          {s.status === 'partial' ? ' · partial' : s.status === 'skipped' ? ' · skipped' : ''}
          {actualLine && (
            <>
              <br />
              <span className="cal-popover-actual">Actual: {actualLine}</span>
            </>
          )}
        </div>
        {task?.estimated_minutes ? (
          <div className="cal-popover-effort">
            Effort: {durationLabel(task.logged_minutes ?? 0)} logged ·{' '}
            {durationLabel(task.remaining_minutes ?? 0)} remaining of{' '}
            {durationLabel(task.estimated_minutes)}
          </div>
        ) : null}
        <DepthSeg value={s.task_depth ?? 0} onChange={(d) => setDepthFor(s, d)} />
        {partialEdit?.sessionId === s.id ? (
          <div className="cal-partial-row">
            <span>Worked</span>
            <input
              type="number"
              min="1"
              className="cal-partial-input"
              autoFocus
              value={partialEdit.minutes}
              onChange={(e) => setPartialEdit((p) => (p ? { ...p, minutes: e.target.value } : p))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); savePartial(s); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPartialEdit(null); }
              }}
            />
            <span>min</span>
            <button type="button" className="task-modal-save" onClick={() => savePartial(s)}>Save</button>
            <button type="button" className="task-modal-cancel" onClick={() => setPartialEdit(null)}>Cancel</button>
          </div>
        ) : (
          <div className="cal-popover-actions cal-popover-actions--wrap">
            {canStart && (
              <button type="button" className="cal-complete-btn" onClick={() => startNow(s)}
                title="Stamp the actual start time — planned times are untouched">
                Start now
              </button>
            )}
            {canFinish && (
              <button type="button" className="cal-complete-btn" onClick={() => finishNow(s)}
                title="Stamp the actual end, record the actual minutes, and complete the session">
                Finish
              </button>
            )}
            <button
              type="button"
              className={`cal-complete-btn${done ? ' is-done' : ''}`}
              onClick={() => toggleComplete(s)}
            >
              {done ? '✓ Completed' : 'Complete'}
            </button>
            <button
              type="button"
              className="cal-complete-btn"
              title="Record that only part of this session's work happened"
              onClick={() => setPartialEdit({ sessionId: s.id, minutes: s.planned_minutes })}
            >
              Partial…
            </button>
            {s.status === 'scheduled' && (
              <button
                type="button"
                className="cal-complete-btn"
                title="Record what actually happened in this slot — the plan is preserved as displaced"
                onClick={() => openInstead(s)}
              >
                Instead…
              </button>
            )}
            {task && !!task.estimated_minutes && (task.remaining_unscheduled_minutes ?? 0) > 0 && (
              <button
                type="button"
                className="cal-complete-btn"
                title="Place another session of this same task — never a duplicate task"
                onClick={() => { closeTransients(); setPlacingTask(task); }}
              >
                Schedule remaining · {durationLabel(task.remaining_unscheduled_minutes)}
              </button>
            )}
          </div>
        )}
        <div className="cal-popover-actions cal-popover-actions--spread">
          <div className="cal-popover-actions-right">
            <button
              type="button"
              className={`cal-flag-btn${s.is_fixed ? ' is-active' : ''}`}
              aria-pressed={!!s.is_fixed}
              title="Fixed sessions resist future automatic replanning; task sessions default to flexible"
              onClick={() => toggleFixed(s)}
            >
              {s.is_fixed ? 'Fixed' : 'Flexible'}
            </button>
            <button
              type="button"
              className={`cal-flag-btn${dupOpen ? ' is-active' : ''}`}
              aria-expanded={dupOpen}
              title="Add another session — same task or entry, never a duplicate record"
              onClick={() => { setDupOpen((o) => !o); setDupDate(''); }}
            >
              Duplicate ▾
            </button>
          </div>
          <div className="cal-popover-actions-right">
            <button
              type="button"
              className="task-modal-cancel"
              title="Edit this session and its task's scheduling fields (E)"
              onClick={() => { setQuickOpen(false); setEditorSessionId(s.id); }}
            >
              Edit
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
        {/* Duplicate menu (V5.1 §21/§22) — richer targets; the effort line
            states the facts and never blocks the action. */}
        {dupOpen && (
          <div className="cal-dup-menu">
            {task?.estimated_minutes ? (
              <div className={`cal-popover-hint${s.planned_minutes > (task.remaining_unscheduled_minutes ?? 0) ? ' cal-coverage-warn' : ''}`}>
                New session: {durationLabel(s.planned_minutes)} ·{' '}
                {durationLabel(Math.max(0, task.remaining_unscheduled_minutes ?? 0))} estimated remaining unscheduled
              </div>
            ) : null}
            <div className="cal-popover-actions cal-popover-actions--wrap">
              <button type="button" className="cal-flag-btn"
                title="Same time tomorrow"
                onClick={() => { setDupOpen(false); duplicateSession(s, 1); }}>
                Tomorrow
              </button>
              <button type="button" className="cal-flag-btn"
                title="Same time next week"
                onClick={() => { setDupOpen(false); duplicateSession(s, 7); }}>
                Next week
              </button>
              <input
                type="date"
                className="task-modal-input cal-dup-date"
                aria-label="Duplicate on date"
                value={dupDate}
                onChange={(e) => setDupDate(e.target.value)}
              />
              <button type="button" className="cal-flag-btn"
                disabled={!dupDate}
                title="Same time on the picked date"
                onClick={() => { setDupOpen(false); duplicateSession(s, 0, dupDate); }}>
                On date
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Drawer ─────────────────────────────────────────────────────────────────
  function renderDrawer() {
    const groups = [
      [1, unscheduledByDepth[1]],
      [2, unscheduledByDepth[2]],
      [3, unscheduledByDepth[3]],
      [0, unscheduledByDepth[0]],
    ].filter(([, list]) => list.length > 0);
    // Always mounted; open/close animates width (§22) and scroll position
    // survives because nothing unmounts.
    return (
      <aside
        className={`cal-drawer${drawerOpen ? ' is-open' : ''}`}
        aria-label="Unscheduled tasks"
        aria-hidden={!drawerOpen}
      >
        <div className="cal-drawer-inner">
        <div className="cal-drawer-head">
          <span>Unscheduled</span>
          <span className="cal-drawer-count">{unscheduledCount}</span>
        </div>
        <div className="cal-drawer-hint">Drag a task onto the calendar to schedule it.</div>
        {/* Good Fits Now (P16.0 §3) — optional, transparent, on TOP of the
            manual drawer; every row explains itself and only arms placement. */}
        {suggestData && suggestData.suggestions.length > 0 && (
          <div className="cal-goodfits">
            <div className="cal-drawer-group-title">Good fits now</div>
            <div className="cal-goodfits-gap">
              Available until {formatTimeOfDay(suggestData.gap.end_minutes)} ·{' '}
              {durationLabel(suggestData.gap.minutes)}
              {suggestData.gap.bounded_by !== 'end of day' ? ` · then ${displayTitle(suggestData.gap.bounded_by)}` : ''}
              {suggestData.current_window
                ? ` · D${suggestData.current_window.depth} window${suggestData.current_window.protected ? ' (protected)' : ''}`
                : ''}
            </div>
            {suggestData.suggestions.map((s) => {
              const task = tasks.find((t) => t.id === s.task_id);
              return (
                <div key={s.task_id} className={`cal-drawer-item${s.depth ? ` cal-drawer-item--d${s.depth}` : ''} cal-goodfits-item`}>
                  <span className="cal-drawer-item-name">{displayTitle(s.name)}</span>
                  <span className="cal-drawer-item-meta">{s.reasons.join(' · ')}</span>
                  <button
                    type="button"
                    className="cal-flag-btn cal-goodfits-place"
                    title="Arm placement for this task — you pick the interval"
                    onClick={() => {
                      if (!task) return;
                      closeTransients();
                      setDrawerOpen(true);
                      setPlacingTask({ ...task, __suggested: s.suggested_minutes });
                    }}
                  >
                    Place {durationLabel(s.suggested_minutes)}
                  </button>
                </div>
              );
            })}
          </div>
        )}
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
                <span className="cal-drawer-item-name">{displayTitle(t.name)}</span>
                <span className="cal-drawer-item-meta">
                  {t.estimated_minutes
                    ? ((t.logged_minutes || t.scheduled_pending_minutes)
                      ? `${durationLabel(t.remaining_unscheduled_minutes ?? 0)} left of ${durationLabel(t.estimated_minutes)}`
                      : durationLabel(t.estimated_minutes))
                    : '—'}
                  {t.section && t.section !== 'General' ? ` · ${t.section}` : ''}
                  {t.context_name ? ` · ${t.context_name}` : ''}
                  {(t.remaining_unscheduled_before_due ?? 0) > 0 && (
                    <span className="cal-coverage-warn">
                      {' '}· {durationLabel(t.remaining_unscheduled_before_due)} unscheduled before {t.due_date.slice(5)}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        ))}
        </div>
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
    <div className="cal-view" style={{ '--cal-hour-px': `${DENSITY_SCALES[density]}px` }}>
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
            className="cal-nav-btn"
            title={`Vertical density — click to cycle (now: ${density})`}
            onClick={() => setDensity(
              density === 'compact' ? 'standard' : density === 'standard' ? 'detailed' : 'compact',
            )}
          >
            {density === 'compact' ? 'Compact' : density === 'standard' ? 'Standard' : 'Detailed'}
          </button>
          <button
            type="button"
            className="cal-nav-btn"
            title={`Command palette (${IS_MAC ? '⌘' : 'Ctrl+'}K)`}
            onClick={() => { closeTransients(); setPaletteOpen(true); }}
          >
            {IS_MAC ? '⌘K' : 'Ctrl+K'}
          </button>
          {visibleReminders.length > 0 && (
            <button
              type="button"
              className={`cal-nav-btn cal-review-btn${remindersOpen ? ' is-active' : ''}`}
              aria-pressed={remindersOpen}
              title="Reminders — upcoming sessions, commitments, prep and deadlines"
              onClick={() => { const open = remindersOpen; closeTransients(); setRemindersOpen(!open); }}
            >
              ⚑ {visibleReminders.length}
            </button>
          )}
          <button
            type="button"
            className={`cal-nav-btn${calsOpen ? ' is-active' : ''}`}
            aria-pressed={calsOpen}
            title="External calendars (read-only ICS feeds — classes, meetings, personal)"
            onClick={() => { const open = calsOpen; closeTransients(); setCalsOpen(!open); }}
          >
            Calendars{externalCalendars.length ? ` · ${externalCalendars.length}` : ''}
          </button>
          <button
            type="button"
            className="cal-nav-btn"
            title="Academic import — paste a syllabus/schedule, review candidates, approve what's real"
            onClick={() => { closeTransients(); setImportOpen(true); }}
          >
            Import
          </button>
          <button
            type="button"
            className={`cal-nav-btn${shiftOpen ? ' is-active' : ''}`}
            aria-pressed={shiftOpen}
            title="Shift today's remaining flexible work later — fixed commitments stay put"
            onClick={() => { const open = shiftOpen; closeTransients(); setShiftOpen(!open); }}
          >
            Shift
          </button>
          <button
            type="button"
            className={`cal-nav-btn${templatesOpen ? ' is-active' : ''}`}
            aria-pressed={templatesOpen}
            title="Depth window templates — reusable window sets"
            onClick={() => { const open = templatesOpen; closeTransients(); setTemplatesOpen(!open); }}
          >
            Windows
          </button>
          {unresolvedSessions.length > 0 && (
            <button
              type="button"
              className={`cal-nav-btn cal-review-btn${reconcileOpen ? ' is-active' : ''}`}
              aria-pressed={reconcileOpen}
              title="Planned sessions whose time passed without being resolved"
              onClick={() => { const open = reconcileOpen; closeTransients(); setReconcileOpen(!open); }}
            >
              Review · {unresolvedSessions.length}
            </button>
          )}
          <button
            type="button"
            className={`cal-nav-btn${hideCompleted ? ' is-active' : ''}`}
            aria-pressed={hideCompleted}
            title="Hide completed sessions (history is kept — this only filters the view)"
            onClick={() => setHideCompleted((v) => !v)}
          >
            {hideCompleted ? 'Done hidden' : 'Hide done'}
          </button>
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


      {/* Arm-mode banner (P15.0): Schedule Remaining placement + template modes. */}
      {(placingTask || templateMode) && (
        <div className="cal-mode-banner" role="status">
          {placingTask
            ? `Placing “${displayTitle(placingTask.name)}”${
              placingTask.remaining_unscheduled_minutes
                ? ` · ${durationLabel(placingTask.remaining_unscheduled_minutes)} remaining${placingTask.due_date ? ` · due ${placingTask.due_date.slice(5)}` : ''}`
                : ''} — drag or click a time slot · Esc cancels`
            : templateMode.type === 'apply'
              ? `Click a day header to apply “${templateMode.tpl.name}” · Esc cancels`
              : templateMode.type === 'update'
                ? `Click a day header to update “${templateMode.tpl.name}” from that day's windows · Esc cancels`
                : 'Click a day header to save its depth windows as a template · Esc cancels'}
        </div>
      )}

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
                    className={`cal-day-header${isToday ? ' is-today' : ''}${templateMode ? ' is-arm-target' : ''}`}
                    title={templateMode ? 'Apply template action to this day' : 'Open day view'}
                    onClick={() => {
                      // Template arm modes intercept the day-header click.
                      if (templateMode?.type === 'apply') { applyTemplateToDate(templateMode.tpl, dIso); return; }
                      if (templateMode?.type === 'update') { captureTemplateFromDate(dIso, templateMode.tpl); return; }
                      if (templateMode?.type === 'save') { captureTemplateFromDate(dIso); return; }
                      setAnchorIso(dIso);
                      setViewMode('day');
                    }}
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
              className={`cal-days${viewMode === 'day' ? ' cal-days--day' : ''}`}
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
                        className={`cal-window cal-window--d${w.depth}${w.protected ? ' is-protected' : ''}`}
                        style={{
                          top: minutesToPx(w.start_minutes),
                          height: minutesToPx(w.end_minutes - w.start_minutes),
                        }}
                      >
                        <span className="cal-window-label">
                          D{w.depth}
                          {w.weekday != null ? ' · weekly' : ''}
                          {w.protected ? ' · protected' : ''}
                        </span>
                        {windowMenu?.windowId === w.id && windowMenu.dateIso === dIso ? (
                          <span className="cal-window-menu">
                            <button type="button" title="Remove only this day's occurrence"
                              onClick={() => skipWindowDay(w.id, dIso)}>This day</button>
                            <button type="button" title="Delete the whole weekly window"
                              onClick={() => { setWindowMenu(null); removeWindow(w.id); }}>All weeks</button>
                            <button type="button" aria-label="Cancel"
                              onClick={() => setWindowMenu(null)}>×</button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="cal-window-del"
                            aria-label="Remove depth window"
                            title={w.weekday != null
                              ? 'Remove — choose this day only or the whole series'
                              : 'Remove this depth window'}
                            onClick={() => (w.weekday != null
                              ? setWindowMenu({ windowId: w.id, dateIso: dIso })
                              : removeWindow(w.id))}
                          >×</button>
                        )}
                      </div>
                    ))}
                    {(allDayByDate[dIso] ?? []).map((ev, i) => (
                      <div
                        key={`ad${ev.id}`}
                        className="cal-allday"
                        style={{ top: 2 + i * 18 }}
                        title={`${displayTitle(ev.title)} · ${ev.calendar_name} · all day (external)`}
                      >
                        ▸ {displayTitle(ev.title)}
                      </div>
                    ))}
                    {blocksByDate[dIso]?.map((item) => (
                      item.ext ? renderExtBlock(item, dIso) : renderBlock(item, dIso)
                    ))}
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

      {/* End-of-day reconciliation (§36) — lightweight, never mandatory. */}
      {reconcileOpen && (
        <div className="cal-popover cal-reconcile" role="dialog" aria-label="Sessions needing review">
          <div className="cal-popover-head">
            <span className="cal-popover-kicker">Needs review</span>
            <button type="button" className="cal-popover-close" aria-label="Close"
              onClick={() => setReconcileOpen(false)}>×</button>
          </div>
          <div className="cal-popover-hint">
            Planned sessions whose time passed without being resolved. Deciding
            keeps the history honest — nothing here is required.
          </div>
          {unresolvedSessions.length === 0 && (
            <div className="cal-popover-time">All caught up.</div>
          )}
          {unresolvedSessions.map((s) => {
            const dIso = plannedDate(s.planned_start);
            const sm = plannedMinutes(s.planned_start);
            return (
              <div key={s.id} className="cal-reconcile-row">
                <div className="cal-reconcile-info">
                  <span className="cal-reconcile-name">{displayTitle(s.task_name)}</span>
                  <span className="cal-reconcile-time">
                    {fullDateLabel(dIso)} · {formatTimeRange(sm, sm + s.planned_minutes)}
                  </span>
                </div>
                {partialEdit?.sessionId === s.id ? (
                  <div className="cal-partial-row">
                    <input
                      type="number"
                      min="1"
                      className="cal-partial-input"
                      autoFocus
                      value={partialEdit.minutes}
                      onChange={(e) => setPartialEdit((p) => (p ? { ...p, minutes: e.target.value } : p))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); savePartial(s); }
                        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPartialEdit(null); }
                      }}
                    />
                    <span>min</span>
                    <button type="button" className="task-modal-save" onClick={() => savePartial(s)}>Save</button>
                    <button type="button" className="task-modal-cancel" onClick={() => setPartialEdit(null)}>Cancel</button>
                  </div>
                ) : (
                  <div className="cal-reconcile-actions">
                    <button type="button" title="It happened as planned"
                      onClick={() => toggleComplete(s)}>Done</button>
                    <button type="button" title="Some of it happened — record the minutes"
                      onClick={() => setPartialEdit({ sessionId: s.id, minutes: s.planned_minutes })}>
                      Partial…
                    </button>
                    <button type="button" title="Move this session to tomorrow, same time"
                      onClick={() => rescheduleSession(s, 1)}>Tmrw</button>
                    <button type="button" title="Something else happened in this slot — record it"
                      onClick={() => openInstead(s)}>Instead…</button>
                    <button type="button" title="It didn't happen — keep the record, return the effort to the backlog"
                      onClick={() => skipSession(s)}>Skip</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* External calendars manager (P15.0 §6/§10) — read-only ICS sources. */}
      {calsOpen && (
        <div className="cal-popover cal-reconcile" role="dialog" aria-label="External calendars">
          <div className="cal-popover-head">
            <span className="cal-popover-kicker">External calendars</span>
            <button type="button" className="cal-popover-close" aria-label="Close"
              onClick={() => setCalsOpen(false)}>×</button>
          </div>
          <div className="cal-popover-hint">
            Read-only ICS feeds. For Google Calendar: Settings → your calendar →
            “Secret address in iCal format”. Events show as fixed external
            commitments — never tasks.
          </div>
          {externalCalendars.map((c) => (
            <div key={c.id} className="cal-reconcile-row">
              <div className="cal-reconcile-info">
                <span className="cal-reconcile-name">{c.name}{c.visible ? '' : ' (hidden)'}</span>
                <span className="cal-reconcile-time">
                  {c.event_count} events
                  {c.last_error
                    ? ` · error: ${c.last_error.slice(0, 48)}`
                    : c.last_synced_at ? ` · synced ${c.last_synced_at.slice(5, 16).replace('T', ' ')}` : ' · never synced'}
                </span>
              </div>
              <div className="cal-reconcile-actions">
                <button type="button" title={c.visible ? 'Hide this calendar' : 'Show this calendar'}
                  onClick={async () => { await updateExternalCalendar(c.id, { visible: !c.visible }); refreshExternal(); }}>
                  {c.visible ? 'Hide' : 'Show'}
                </button>
                <button type="button" title="Fetch the feed again now"
                  onClick={async () => { try { await syncExternalCalendar(c.id); } catch {} refreshExternal(); }}>
                  Sync
                </button>
                <button type="button" title="Remove this calendar and its events"
                  onClick={async () => { await deleteExternalCalendar(c.id); refreshExternal(); }}>
                  ×
                </button>
              </div>
            </div>
          ))}
          <div className="cal-cal-add">
            <input
              className="task-modal-input"
              placeholder="Name (e.g. GT Classes)"
              value={calDraft.name}
              onChange={(e) => setCalDraft((d) => ({ ...d, name: e.target.value }))}
            />
            <input
              className="task-modal-input"
              placeholder="ICS URL (https://…/basic.ics)"
              value={calDraft.url}
              onChange={(e) => setCalDraft((d) => ({ ...d, url: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExternalCalendar(); } }}
            />
            {calDraft.error && <div className="cal-popover-error" role="alert">{calDraft.error}</div>}
            <div className="cal-popover-actions">
              <button type="button" className="task-modal-save" onClick={addExternalCalendar} disabled={calDraft.busy}>
                {calDraft.busy ? 'Adding…' : 'Add calendar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Shift Remaining Day chooser (P15.0 §14). */}
      {shiftOpen && (
        <div className="cal-popover cal-reconcile" role="dialog" aria-label="Shift remaining flexible work">
          <div className="cal-popover-head">
            <span className="cal-popover-kicker">Shift remaining day</span>
            <button type="button" className="cal-popover-close" aria-label="Close"
              onClick={() => setShiftOpen(false)}>×</button>
          </div>
          <div className="cal-popover-hint">
            Moves today's remaining flexible blocks later. Fixed sessions,
            external commitments, and depth windows stay where they are;
            conflicts are shown before anything is applied.
          </div>
          <div className="cal-popover-actions cal-popover-actions--wrap">
            {[15, 30, 45, 60, 90].map((m) => (
              <button key={m} type="button" className="cal-flag-btn" onClick={() => buildShiftPlan(m)}>
                +{durationLabel(m)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Shift plan preview + conflict resolution (§16/§17). */}
      {shiftPlan && (
        <div className="cal-confirm-overlay" onClick={() => setShiftPlan(null)}>
          <div className="cal-popover cal-confirm cal-shift-plan" role="dialog"
            aria-label="Shift plan" onClick={(e) => e.stopPropagation()}>
            <div className="cal-popover-kicker">Shift remaining flexible work +{durationLabel(shiftPlan.minutes)}</div>
            {shiftPlan.proposed.length === 0 ? (
              <div className="cal-popover-time">Nothing flexible remains today.</div>
            ) : (
              <>
                <div className="cal-popover-hint">
                  {shiftPlan.proposed.length} block{shiftPlan.proposed.length !== 1 ? 's' : ''} will move.
                  Fixed commitments stay put.
                </div>
                {shiftPlan.proposed.map((p, idx) => {
                  const [sm, em] = resolvedShiftTimes(p);
                  const canShorten = p.conflict && (p.conflict.startMin - p.newStartMin) >= MIN_SESSION_MINUTES;
                  return (
                    <div key={p.session.id} className="cal-reconcile-row">
                      <div className="cal-reconcile-info">
                        <span className="cal-reconcile-name">{displayTitle(p.session.task_name)}</span>
                        <span className="cal-reconcile-time">
                          {p.resolution === 'unschedule'
                            ? 'returned to backlog (skipped)'
                            : `→ ${formatTimeRange(sm, em)}`}
                          {p.conflict ? ` · overlaps ${p.conflict.label}` : ''}
                        </span>
                      </div>
                      {p.conflict && (
                        <div className="cal-reconcile-actions">
                          <button type="button"
                            className={p.resolution === 'keep' ? 'is-active' : ''}
                            title="Allow the overlap"
                            onClick={() => setShiftPlan((pl) => ({ ...pl, proposed: pl.proposed.map((x, i) => (i === idx ? { ...x, resolution: 'keep' } : x)) }))}>
                            Overlap
                          </button>
                          <button type="button"
                            className={p.resolution === 'after' ? 'is-active' : ''}
                            title="Place it after the fixed commitment"
                            onClick={() => setShiftPlan((pl) => ({ ...pl, proposed: pl.proposed.map((x, i) => (i === idx ? { ...x, resolution: 'after' } : x)) }))}>
                            After
                          </button>
                          {canShorten && (
                            <button type="button"
                              className={p.resolution === 'shorten' ? 'is-active' : ''}
                              title="Shorten it to end where the fixed commitment begins"
                              onClick={() => setShiftPlan((pl) => ({ ...pl, proposed: pl.proposed.map((x, i) => (i === idx ? { ...x, resolution: 'shorten' } : x)) }))}>
                              Shorten
                            </button>
                          )}
                          <button type="button"
                            className={p.resolution === 'unschedule' ? 'is-active' : ''}
                            title="Skip this session — its effort returns to the backlog"
                            onClick={() => setShiftPlan((pl) => ({ ...pl, proposed: pl.proposed.map((x, i) => (i === idx ? { ...x, resolution: 'unschedule' } : x)) }))}>
                            Unschedule
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
            <div className="cal-popover-actions">
              <button type="button" className="task-modal-cancel" onClick={() => setShiftPlan(null)}>Cancel</button>
              {shiftPlan.proposed.length > 0 && (
                <button type="button" className="task-modal-save" onClick={applyShiftPlan}>Apply shift</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Did This Instead (§18–§22): both facts are preserved. */}
      {insteadFor && (
        <div className="cal-confirm-overlay" onClick={() => setInsteadFor(null)}>
          <div className="cal-popover cal-confirm" role="dialog" aria-label="Did this instead"
            onClick={(e) => e.stopPropagation()}>
            <div className="cal-popover-kicker">Did This Instead</div>
            <div className="cal-popover-time">
              Planned: {displayTitle(insteadFor.session.task_name)} ·{' '}
              {formatTimeRange(plannedMinutes(insteadFor.session.planned_start),
                plannedMinutes(insteadFor.session.planned_start) + insteadFor.session.planned_minutes)}
            </div>
            <input
              className="task-modal-input"
              placeholder="What actually happened?"
              autoFocus
              value={insteadFor.title}
              onChange={(e) => setInsteadFor((x) => (x ? { ...x, title: e.target.value, error: '' } : x))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); recordInstead(); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setInsteadFor(null); }
              }}
            />
            <TimeRangeFields
              startMin={insteadFor.startMin}
              endMin={insteadFor.endMin}
              onChange={({ startMin, endMin }) => setInsteadFor((x) => (x ? { ...x, startMin, endMin } : x))}
            />
            <div className="cal-popover-hint">
              The planned block stays in history as displaced
              {insteadFor.session.task_id != null ? ' and the task keeps its remaining effort' : ''}.
              What happened is recorded as a completed calendar-only entry — use
              “Add to main Grid…” later if it deserves to become a task.
            </div>
            {insteadFor.error && <div className="cal-popover-error" role="alert">{insteadFor.error}</div>}
            <div className="cal-popover-actions">
              <button type="button" className="task-modal-cancel" onClick={() => setInsteadFor(null)}>Cancel</button>
              <button type="button" className="task-modal-save" onClick={recordInstead}>Record</button>
            </div>
          </div>
        </div>
      )}

      {/* Depth window templates (§28/§29). */}
      {templatesOpen && (
        <div className="cal-popover cal-reconcile" role="dialog" aria-label="Depth window templates">
          <div className="cal-popover-head">
            <span className="cal-popover-kicker">Depth window templates</span>
            <button type="button" className="cal-popover-close" aria-label="Close"
              onClick={() => setTemplatesOpen(false)}>×</button>
          </div>
          <div className="cal-popover-hint">
            Reusable window sets you define — applying one creates those
            windows on the day you pick. No inferred capacity, ever.
          </div>
          {templates.length === 0 && (
            <div className="cal-popover-time">No templates yet — save one from a day below.</div>
          )}
          {templates.map((t) => (
            <div key={t.id} className="cal-reconcile-row">
              <div className="cal-reconcile-info">
                {templateRename?.id === t.id ? (
                  <input
                    className="task-modal-input"
                    autoFocus
                    value={templateRename.name}
                    onChange={(e) => setTemplateRename((r) => (r ? { ...r, name: e.target.value } : r))}
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (templateRename.name.trim()) {
                          await updateWindowTemplate(t.id, { name: templateRename.name.trim() });
                          setTemplates(await fetchWindowTemplates());
                        }
                        setTemplateRename(null);
                      }
                      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setTemplateRename(null); }
                    }}
                  />
                ) : (
                  <span className="cal-reconcile-name">{t.name}</span>
                )}
                <span className="cal-reconcile-time">
                  {t.items.map((i) => `D${i.depth} ${formatTimeOfDay(i.start_minutes)}–${formatTimeOfDay(i.end_minutes)}${i.protected ? ' 🛡' : ''}`).join(' · ') || 'empty'}
                </span>
              </div>
              <div className="cal-reconcile-actions">
                <button type="button" title="Apply to a day — click a day header next"
                  onClick={() => { setTemplatesOpen(false); setTemplateMode({ type: 'apply', tpl: t }); }}>
                  Apply…
                </button>
                <button type="button" title="Replace this template's windows from a day — click a day header next"
                  onClick={() => { setTemplatesOpen(false); setTemplateMode({ type: 'update', tpl: t }); }}>
                  ⟳
                </button>
                <button type="button" title="Rename"
                  onClick={() => setTemplateRename({ id: t.id, name: t.name })}>
                  ✎
                </button>
                <button type="button" title="Delete this template"
                  onClick={async () => { await deleteWindowTemplate(t.id); setTemplates(await fetchWindowTemplates()); }}>
                  ×
                </button>
              </div>
            </div>
          ))}
          <div className="cal-popover-actions">
            <button type="button" className="task-modal-save"
              title="Capture an existing day's windows as a new template"
              onClick={() => { setTemplatesOpen(false); setTemplateMode({ type: 'save' }); }}>
              New from day…
            </button>
          </div>
        </div>
      )}

      {/* Reminders tray (P16.0 Part VI) — in-app, dismissible, per-type
          toggles. Nothing fires actions without the user clicking. */}
      {remindersOpen && (
        <div className="cal-popover cal-reconcile" role="dialog" aria-label="Reminders">
          <div className="cal-popover-head">
            <span className="cal-popover-kicker">Reminders</span>
            <button type="button" className="cal-popover-close" aria-label="Close"
              onClick={() => setRemindersOpen(false)}>×</button>
          </div>
          {visibleReminders.length === 0 && (
            <div className="cal-popover-time">Nothing needs attention right now.</div>
          )}
          {visibleReminders.map((r) => (
            <div key={r.key} className="cal-reconcile-row">
              <div className="cal-reconcile-info">
                <span className="cal-reconcile-name">{displayTitle(r.title)}</span>
                <span className="cal-reconcile-time">{r.detail}</span>
              </div>
              <div className="cal-reconcile-actions">
                {r.type === 'class_review' && (
                  <button type="button" title="Schedule review work — nothing is created until you decide"
                    onClick={() => scheduleReview(r)}>Schedule…</button>
                )}
                {r.type === 'deadline' && (
                  <button type="button" title="Arm placement for this task's remaining effort"
                    onClick={() => {
                      const t = tasks.find((x) => x.id === r.task_id);
                      if (t) { closeTransients(); setPlacingTask(t); }
                    }}>Schedule…</button>
                )}
                {r.type === 'reconcile' && (
                  <button type="button" onClick={() => { closeTransients(); setReconcileOpen(true); }}>
                    Review
                  </button>
                )}
                {r.type === 'event_moved' && (
                  <button type="button"
                    title="Jump to the event — its detail panel offers the move"
                    onClick={() => {
                      closeTransients();
                      if (r.event_start) setAnchorIso(r.event_start.slice(0, 10));
                    }}>Open</button>
                )}
                <button type="button" title="Dismiss this reminder"
                  onClick={() => dismissReminder(r.key)}>×</button>
              </div>
            </div>
          ))}
          <div className="cal-popover-hint">Reminder types — untick to silence:</div>
          <div className="cal-popover-actions cal-popover-actions--wrap">
            {[['session_soon', 'Sessions'], ['event_soon', 'Commitments'], ['prep', 'Prep'],
              ['followup', 'Follow-ups'], ['reconcile', 'Review'], ['deadline', 'Deadlines'],
              ['class_review', 'Post-class'], ['event_moved', 'Event moves']].map(([type, label]) => (
              <button
                key={type}
                type="button"
                className={`cal-flag-btn${reminderPrefs[type] !== false ? ' is-active' : ''}`}
                aria-pressed={reminderPrefs[type] !== false}
                onClick={() => setReminderPrefs((p) => ({ ...p, [type]: p[type] === false }))}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Calendar search (V5.2 Part V) — read-only; results navigate. */}
      {searchOpen && (
        <div className="cal-popover cal-search" role="dialog" aria-label="Calendar search">
          <div className="cal-popover-head">
            <span className="cal-popover-kicker">Search Calendar</span>
            <button type="button" className="cal-popover-close" aria-label="Close"
              onClick={() => setSearchOpen(false)}>×</button>
          </div>
          <input
            className="task-modal-input"
            autoFocus
            placeholder="Tasks, sessions, entries, events, courses…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSearchOpen(false); }
            }}
          />
          {searchCtx && (
            <div className="cal-partial-row">
              <span className="cal-reconcile-name">Filtered to {searchCtx.name}</span>
              <button type="button" className="cal-flag-btn" onClick={() => setSearchCtx(null)}>×</button>
            </div>
          )}
          <div className="cal-popover-actions cal-popover-actions--wrap">
            {[['All', null], ['Tasks', 'task'], ['Sessions', 'session'], ['Entries', 'entry'], ['Events', 'event']]
              .map(([label, val]) => (
                <button key={label} type="button"
                  className={`cal-flag-btn${searchFilters.types === val ? ' is-active' : ''}`}
                  aria-pressed={searchFilters.types === val}
                  onClick={() => setSearchFilters((f) => ({ ...f, types: val }))}>
                  {label}
                </button>
              ))}
          </div>
          <div className="cal-popover-actions cal-popover-actions--wrap">
            {[['Any status', null], ['Open', 'incomplete'], ['Done', 'completed']].map(([label, val]) => (
              <button key={label} type="button"
                className={`cal-flag-btn${searchFilters.status === val ? ' is-active' : ''}`}
                aria-pressed={searchFilters.status === val}
                onClick={() => setSearchFilters((f) => ({ ...f, status: val }))}>
                {label}
              </button>
            ))}
            <input type="date" className="task-modal-input cal-dup-date" aria-label="From date"
              value={searchFilters.from}
              onChange={(e) => setSearchFilters((f) => ({ ...f, from: e.target.value }))} />
            <input type="date" className="task-modal-input cal-dup-date" aria-label="To date"
              value={searchFilters.to}
              onChange={(e) => setSearchFilters((f) => ({ ...f, to: e.target.value }))} />
          </div>
          {searchResults && (
            <div className="cal-search-results">
              {searchResults.contexts.length > 0 && (
                <div className="cal-ext-links">
                  <span className="cal-drawer-group-title">Courses / contexts</span>
                  {searchResults.contexts.map((c) => (
                    <button key={c.id} type="button" className="cal-task-picker-row"
                      title="Filter results to this context"
                      onClick={() => { setSearchCtx({ id: c.id, name: c.name }); setSearchQuery(''); }}>
                      <span className="cal-task-picker-name">{c.name}</span>
                      <span className="cal-task-picker-meta">{c.task_count} task{c.task_count !== 1 ? 's' : ''}</span>
                    </button>
                  ))}
                </div>
              )}
              {searchResults.tasks.length > 0 && (
                <div className="cal-ext-links">
                  <span className="cal-drawer-group-title">Grid tasks</span>
                  {searchResults.tasks.map((t) => (
                    <button key={t.id} type="button" className="cal-task-picker-row"
                      title="Open the full task record"
                      onClick={() => {
                        const full = tasks.find((x) => x.id === t.id);
                        setSearchOpen(false);
                        if (full) setEditingTask(full);
                      }}>
                      <span className="cal-task-picker-name">{displayTitle(t.name)}</span>
                      <span className="cal-task-picker-meta">
                        {t.context_name ?? (t.section !== 'General' ? t.section : '—')}
                        {t.due_date ? ` · due ${t.due_date.slice(5)}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {searchResults.sessions.length > 0 && (
                <div className="cal-ext-links">
                  <span className="cal-drawer-group-title">Sessions & entries</span>
                  {searchResults.sessions.map((r) => (
                    <button key={r.id} type="button" className="cal-task-picker-row"
                      title="Go to this block on the Calendar"
                      onClick={() => gotoSearchSession(r)}>
                      <span className="cal-task-picker-name">
                        {displayTitle(r.name)}
                        {r.task_id == null ? ' ·▫' : ''}
                      </span>
                      <span className="cal-task-picker-meta">
                        {r.planned_start.slice(5, 16).replace('T', ' ')} · {r.status}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {searchResults.events.length > 0 && (
                <div className="cal-ext-links">
                  <span className="cal-drawer-group-title">External commitments</span>
                  {searchResults.events.map((r, i) => (
                    <button key={`${r.uid}:${r.start}:${i}`} type="button" className="cal-task-picker-row"
                      title="Go to this commitment on the Calendar"
                      onClick={() => gotoSearchEvent(r)}>
                      <span className="cal-task-picker-name">▸ {displayTitle(r.title)}</span>
                      <span className="cal-task-picker-meta">
                        {r.start.slice(5, 16).replace('T', ' ')} · {r.calendar_name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {searchResults.tasks.length === 0 && searchResults.sessions.length === 0
                && searchResults.events.length === 0 && searchResults.contexts.length === 0 && (
                <div className="cal-popover-hint">No matches.</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* External commitment detail (P16.0 §44/§45) — read-only event;
          local actions only (context, task links). No "edit event" illusion. */}
      {extDetail && (() => {
        const ev = extDetail.event;
        const startMin = plannedMinutes(ev.start);
        const endMin = plannedDate(ev.end) === plannedDate(ev.start)
          ? plannedMinutes(ev.end) : DAY_MINUTES;
        const style = popoverPosition(extDetail.rect, 340, 380);
        const groups = { before: [], after: [], related: [] };
        for (const l of extDetail.links) groups[l.relation]?.push(l);
        return (
          <div className="cal-popover" style={style} role="dialog" aria-label="External commitment">
            <div className="cal-popover-head">
              <span className="cal-popover-name">
                <span className="cal-ext-marker" aria-hidden="true">▸ </span>
                {displayTitle(ev.title)}
              </span>
              <button type="button" className="cal-popover-close" aria-label="Close"
                onClick={() => setExtDetail(null)}>×</button>
            </div>
            <div className="cal-popover-time">
              {fullDateLabel(plannedDate(ev.start))}
              <br />
              {ev.all_day ? 'All day' : formatTimeRange(startMin, endMin)} · {ev.calendar_name} · fixed
              <br />
              <span className="cal-popover-actual">Read-only external event — edit it in its source calendar.</span>
            </div>
            <div className="cal-ext-context">
              <span className="cal-creator-field"><span>Context / course</span></span>
              {ev.context_name ? (
                <div className="cal-partial-row">
                  <span className="cal-reconcile-name">{ev.context_name}</span>
                  <button type="button" className="task-modal-cancel"
                    title="Remove this association — the event and any tasks stay"
                    onClick={() => assignEventContext(ev, '')}>Unlink</button>
                </div>
              ) : (
                <div className="cal-partial-row">
                  <input
                    className="task-modal-input"
                    list="cal-ctx-options"
                    placeholder="e.g. ISYE 2027"
                    value={extDetail.ctxDraft}
                    onChange={(e) => setExtDetail((d) => (d ? { ...d, ctxDraft: e.target.value } : d))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); assignEventContext(ev, extDetail.ctxDraft); }
                      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setExtDetail(null); }
                    }}
                  />
                  <datalist id="cal-ctx-options">
                    {contexts.map((c) => <option key={c.id} value={c.name} />)}
                  </datalist>
                  <button type="button" className="task-modal-save"
                    onClick={() => assignEventContext(ev, extDetail.ctxDraft)}>Set</button>
                </div>
              )}
            </div>
            {/* Event-move proposal (V5.0 §4): effect shown before applying;
                only Flexible sessions are offered. Nothing moves silently —
                even "keep" is an explicit acknowledgement. */}
            {extDetail.proposal && (() => {
              const p = extDetail.proposal;
              const sel = extDetail.reviewSel;
              const dayOf = (s) => s.slice(5, 10);
              const rangeOf = (s, e) => formatTimeRange(plannedMinutes(s), plannedMinutes(e));
              return (
                <div className="cal-ext-links cal-move-proposal">
                  <span className="cal-drawer-group-title cal-coverage-warn">
                    Event moved · {p.old_start.slice(11, 16)} → {p.new_start.slice(5, 16).replace('T', ' ')}
                  </span>
                  {p.items.map((item) => (
                    <div key={item.session_id} className="cal-reconcile-row">
                      <div className="cal-reconcile-info">
                        <span className="cal-reconcile-name">
                          {sel != null && (
                            <input
                              type="checkbox"
                              checked={sel.includes(item.session_id)}
                              onChange={() => setExtDetail((d) => (d ? {
                                ...d,
                                reviewSel: d.reviewSel.includes(item.session_id)
                                  ? d.reviewSel.filter((id) => id !== item.session_id)
                                  : [...d.reviewSel, item.session_id],
                              } : d))}
                            />
                          )}
                          {' '}{displayTitle(item.task_name)}
                        </span>
                        <span className="cal-reconcile-time">
                          {dayOf(item.planned_start)} {rangeOf(item.planned_start, item.planned_end)}
                          {' → '}
                          {dayOf(item.proposed_start)} {rangeOf(item.proposed_start, item.proposed_end)}
                        </span>
                      </div>
                    </div>
                  ))}
                  {p.fixed_count > 0 && (
                    <div className="cal-popover-hint">
                      {p.fixed_count} fixed session{p.fixed_count !== 1 ? 's' : ''} stay
                      put unless you move them yourself.
                    </div>
                  )}
                  <div className="cal-popover-actions cal-popover-actions--wrap">
                    {p.items.length === 0 ? (
                      <button type="button" className="task-modal-cancel"
                        title="Acknowledge the new time — nothing is scheduled"
                        onClick={() => resolveEventMove(ev, p, [])}>Got it</button>
                    ) : sel != null ? (
                      <>
                        <button type="button" className="task-modal-save"
                          disabled={sel.length === 0}
                          onClick={() => resolveEventMove(ev, p, sel)}>Move selected</button>
                        <button type="button" className="task-modal-cancel"
                          onClick={() => setExtDetail((d) => (d ? { ...d, reviewSel: null } : d))}>
                          Back
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="task-modal-save"
                          onClick={() => resolveEventMove(ev, p, p.items.map((i) => i.session_id))}>
                          Move related sessions
                        </button>
                        <button type="button" className="task-modal-cancel"
                          onClick={() => resolveEventMove(ev, p, [])}>Keep current schedule</button>
                        {p.items.length > 1 && (
                          <button type="button" className="task-modal-cancel"
                            onClick={() => setExtDetail((d) => (d ? {
                              ...d, reviewSel: d.proposal.items.map((i) => i.session_id),
                            } : d))}>
                            Review individually
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })()}
            {['before', 'after', 'related'].map((rel) => groups[rel].length > 0 && (
              <div key={rel} className="cal-ext-links">
                <span className="cal-drawer-group-title">{rel === 'before' ? 'Before' : rel === 'after' ? 'After' : 'Related'}</span>
                {groups[rel].map((l) => (
                  <div key={l.id} className="cal-reconcile-row">
                    <div className="cal-reconcile-info">
                      <span className="cal-reconcile-name">
                        {l.task_done ? '☑' : '□'} {displayTitle(l.task_name)}
                      </span>
                      {l.event_status !== 'ok' && (
                        <span className="cal-reconcile-time cal-coverage-warn">
                          {l.event_status === 'moved'
                            ? `event moved → ${l.next_start ? l.next_start.slice(5, 16).replace('T', ' ') : '?'}`
                            : 'related event was cancelled'}
                        </span>
                      )}
                      {l.offset_minutes ? (
                        <span className="cal-reconcile-time">{durationLabel(l.offset_minutes)} {l.relation} event</span>
                      ) : null}
                    </div>
                    <div className="cal-reconcile-actions">
                      <button type="button" title="Detach this relationship — the task survives"
                        onClick={async () => { await deleteTaskEventLink(l.id); refreshExtDetailLinks(ev); }}>×</button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
            {extDetail.linkPicker ? (
              <div className="cal-task-picker" role="listbox" aria-label="Choose a task to link">
                {tasks.filter((t) => !t.is_paused && !t.is_ended).slice(0, 20).map((t) => (
                  <button key={t.id} type="button" className="cal-task-picker-row"
                    onClick={() => addEventTaskLink(ev, t, extDetail.linkPicker)}>
                    <span className="cal-task-picker-name">{displayTitle(t.name)}</span>
                    <span className="cal-task-picker-meta">{t.section !== 'General' ? t.section : '—'}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="cal-popover-actions cal-popover-actions--wrap">
                {[['before', 'Link before…'], ['after', 'Link after…'], ['related', 'Link related…']].map(([rel, label]) => (
                  <button key={rel} type="button" className="cal-flag-btn"
                    onClick={() => setExtDetail((d) => (d ? { ...d, linkPicker: rel } : d))}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Post-class review draft (§42) — canonical New Task modal, prefilled;
          created task is then armed for placement. */}
      {reviewDraft && (
        <TaskModal
          task={null}
          initialValues={{
            name: `Review ${reviewDraft.contextName}`,
            depth: 2,
            estimated_minutes: 30,
            context_name: reviewDraft.contextName,
          }}
          sectionSuggestions={sectionSuggestions}
          onSave={async (payload) => {
            const created = await createTask(payload);
            setReviewDraft(null);
            await loadData();
            setPlacingTask(created);
          }}
          onDelete={() => {}}
          onClose={() => setReviewDraft(null)}
        />
      )}

      {/* New Grid task from the palette (V5.1) — the canonical modal, no
          shortcuts around Grid semantics. */}
      {newTaskOpen && (
        <TaskModal
          task={null}
          sectionSuggestions={sectionSuggestions}
          onSave={async (payload) => {
            await createTask(payload);
            setNewTaskOpen(false);
            await loadData();
          }}
          onDelete={() => {}}
          onClose={() => setNewTaskOpen(false)}
        />
      )}

      {/* Academic importer (V5.3) — candidates stay isolated until approved. */}
      {importOpen && (
        <AcademicImport
          contexts={contexts}
          onClose={async () => {
            setImportOpen(false);
            setContexts(await fetchContexts().catch(() => contexts));
          }}
          onChanged={() => loadData()}
        />
      )}

      {/* Command palette (V5.1 Part II) — keyboard-first dispatch to the
          same handlers every button uses. */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={buildPaletteCommands()}
        placeholder="Type a command, or describe something to schedule…"
        freeTextActions={[
          {
            id: 'nl-create',
            hint: 'e.g. “research tomorrow 9am 90m d1”',
            label: (q) => `Create: “${q}”`,
            run: (q) => nlCreate(q),
          },
          {
            id: 'search',
            hint: 'search calendar',
            label: (q) => `Search: “${q}”`,
            run: (q) => openSearch(q),
          },
        ]}
      />

      {/* Protected-window override (§8) — always permits scheduling. */}
      {confirmAction && (
        <div className="cal-confirm-overlay" onClick={() => setConfirmAction(null)}>
          <div className="cal-popover cal-confirm" role="alertdialog" aria-label="Protected window"
            onClick={(e) => e.stopPropagation()}>
            <div className="cal-popover-kicker">Protected window</div>
            <div className="cal-popover-time">{confirmAction.message}</div>
            <div className="cal-popover-actions">
              <button type="button" className="task-modal-cancel"
                onClick={() => setConfirmAction(null)}>Cancel</button>
              <button type="button" className="task-modal-save"
                onClick={() => {
                  const go = confirmAction.onConfirm;
                  setConfirmAction(null);
                  go();
                }}>Schedule anyway</button>
            </div>
          </div>
        </div>
      )}

      {/* Calendar-native session editor (P13.1/P14.0) — task is null for
          calendar-only entries; Grid-recurrence fields live only in the full
          TaskModal behind "Open full task". */}
      {editorSessionId && (() => {
        const editorSession = sessions.find((x) => x.id === editorSessionId)
          ?? recentSessions.find((x) => x.id === editorSessionId)
          ?? upcomingSessions.find((x) => x.id === editorSessionId);
        if (!editorSession) return null;
        const editorTask = editorSession.task_id != null
          ? tasks.find((t) => t.id === editorSession.task_id) ?? null
          : null;
        if (editorSession.task_id != null && !editorTask) return null;
        return (
          <CalendarEditor
            session={editorSession}
            task={editorTask}
            sectionSuggestions={sectionSuggestions}
            contexts={contexts}
            onClose={() => setEditorSessionId(null)}
            onOpenFullTask={() => {
              setEditorSessionId(null);
              setEditingTask(editorTask);
            }}
            onChanged={() => loadData()}
            onCompleteSession={() => toggleComplete(editorSession)}
            onPromote={(initialValues) => {
              setEditorSessionId(null);
              setPromoteFor({ sessionId: editorSession.id, initialValues });
            }}
          />
        );
      })()}

      {/* "Add to main Grid…" (P14.0) — the canonical New Task modal, prefilled
          from the calendar entry. Saving creates exactly one task and links
          the existing entry to it; cancelling leaves the entry calendar-only. */}
      {promoteFor && (
        <TaskModal
          task={null}
          initialValues={promoteFor.initialValues}
          sectionSuggestions={sectionSuggestions}
          onSave={async (payload) => {
            const created = await createTask(payload);
            await updateSession(promoteFor.sessionId, { link_task_id: created.id });
            setPromoteFor(null);
            await loadData();
          }}
          onDelete={() => {}}
          onClose={() => setPromoteFor(null)}
        />
      )}

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
