import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import TaskGrid from './components/TaskGrid.jsx';
import CalendarView from './components/CalendarView.jsx';
import Settings from './components/Settings.jsx';
import ReadingSheet from './components/ReadingSheet.jsx';
import MonthlyReport from './components/MonthlyReport.jsx';
import TopBarNetwork from './components/TopBarNetwork.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';
import { fetchHealth } from './api.js';
import { initAppearance } from './appearance.js';
import { WorkspaceNavigation } from './components/WorkspaceSearch.jsx';
import { isTypingTarget, matchKeybind, resolveKeybinds } from './keybinds.js';

// Main's views, shown inline in the nav row while Main is active.
const MAIN_VIEWS = [['tasks', 'Grid'], ['reading', 'Reading'], ['calendar', 'Calendar']];

// Slides Main's view tabs open and closed (tm-clean 08; logic ported from
// drift-ref). Only width, the trailing margin and opacity animate. At rest a
// closed slot is unmounted, exactly as before, so focus order and the
// accessibility tree are unchanged; while sliding closed it is inert. No
// animation on first mount or when the OS asks for reduced motion.
const NAV_SLIDE_MS = 200;
function MainViewsSlot({ open, children }) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const slotRef = useRef(null);
  const animRef = useRef(null);
  // Previous value, so mount (and StrictMode's repeated mount effects) never animate.
  const prevOpen = useRef(open);
  const pendingOpen = useRef(false);
  const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const slide = (el, from, to, done) => {
    animRef.current?.cancel();
    // Collapsed frame: zero width plus a negative margin equal to the nav gap,
    // so the row measures exactly as if the slot were not rendered.
    const gap = parseFloat(getComputedStyle(el.parentElement).columnGap) || 0;
    const frame = (w) => (w === 0
      ? { width: '0px', marginRight: `-${gap}px`, opacity: 0 }
      : { width: `${w}px`, marginRight: '0px', opacity: 1 });
    el.style.overflow = 'hidden';
    // Closing holds its collapsed frame until React unmounts the slot, so the
    // full width never flashes back for a frame.
    const a = el.animate([frame(from), frame(to)], { duration: NAV_SLIDE_MS, easing: 'ease-out', fill: to === 0 ? 'forwards' : 'none' });
    animRef.current = a;
    a.onfinish = () => { el.style.overflow = ''; animRef.current = null; done?.(); };
    a.oncancel = () => { el.style.overflow = ''; };
  };
  useLayoutEffect(() => {
    if (prevOpen.current === open) return;
    prevOpen.current = open;
    if (open) {
      pendingOpen.current = !reduced();
      setClosing(false);
      setMounted(true);
    } else if (slotRef.current) {
      if (reduced()) { setMounted(false); return; }
      setClosing(true);
      const el = slotRef.current;
      slide(el, el.getBoundingClientRect().width, 0, () => { setMounted(false); setClosing(false); });
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!mounted || !open || !pendingOpen.current || !slotRef.current) return;
    pendingOpen.current = false;
    const el = slotRef.current;
    slide(el, 0, el.getBoundingClientRect().width);
  }, [mounted, open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!mounted) return null;
  return (
    <div
      ref={slotRef}
      className="main-views-slot"
      role="group"
      aria-label="Main views"
      {...(closing ? { inert: '', 'aria-hidden': 'true' } : {})}
    >
      {children}
    </div>
  );
}

export default function App() {
  // Top-level pages (tm-clean 05): Main | Reports | Settings.
  //   mainView — which Main surface is showing (Grid | Reading | Calendar).
  //     Its buttons appear in the nav row right after Main while Main is
  //     active (tm-clean 07); the value is kept while another page is open,
  //     so returning to Main lands on the last view.
  const [page, setPage] = useState('main');
  const [mainView, setMainView] = useState('tasks');
  const [gridMonth, setGridMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });

  // Schedule-from-Grid (P16.0 §13/§15): a Grid task handed to the Calendar,
  // which arms its placement mode and then consumes the request.
  const [calendarPlaceTask, setCalendarPlaceTask] = useState(null);

  // Boot gate (P8.0B) — the surfaces (TaskGrid, ReadingSheet, …) each own their
  // inline data loading, so there is no global data store to wait on. What is
  // worth waiting on is the backend actually being reachable: in the packaged
  // desktop build the Python sidecar takes a moment to come up. We poll the
  // dedicated /health endpoint (no DB work — P8.2; previously this probed
  // /tasks, duplicating TaskGrid's own heavier first fetch) until it answers,
  // then reveal the app. A hard cap guarantees we never trap the user on the
  // loading screen — if the backend stays down we still reveal the shell and
  // let each surface show its own error state.
  //
  // The cap is an INDEPENDENT timer, armed once when the effect starts. It used
  // to be an elapsed-time check inside the probe's catch block, which is not a
  // real deadline: a backend that accepts the connection but never answers left
  // `await fetchHealth()` pending forever, so the catch block — and therefore
  // the check — never ran, and the loading screen stayed up indefinitely.
  // fetchHealth is now bounded too (HEALTH_TIMEOUT_MS), so each attempt
  // settles; the standalone timer is the backstop that does not depend on it.
  const [booting, setBooting] = useState(true);
  useEffect(() => {
    const MAX_WAIT_MS = 6000;
    const RETRY_MS = 400;
    let done = false;
    let retryTimer = null;
    let hardStopTimer = null;

    // Reveal the shell at most once, and stop everything after. Also guards
    // against setState from a probe that lands after unmount or after the cap.
    function reveal() {
      if (done) return;
      done = true;
      clearTimeout(retryTimer);
      clearTimeout(hardStopTimer);
      setBooting(false);
    }

    hardStopTimer = setTimeout(reveal, MAX_WAIT_MS);

    async function probe() {
      try {
        await fetchHealth();
        reveal();
      } catch {
        if (done) return;
        retryTimer = setTimeout(probe, RETRY_MS);
      }
    }
    probe();

    return () => {
      done = true;
      clearTimeout(retryTimer);
      clearTimeout(hardStopTimer);
    };
  }, []);

  // Apply saved appearance on mount (P10.1: visual theme + mode + accent +
  // motion all live in appearance.js, which also migrates the legacy
  // taskos-theme key). A one-frame theme flash before this runs is acceptable
  // and keeps the implementation self-contained.
  useEffect(() => {
    initAppearance();
  }, []);

  // Remapped focus movement (tm-clean 13; ported from drift-ref). Tab and
  // Shift+Tab stay native; a custom FOCUS_NEXT / FOCUS_PREVIOUS binding moves
  // focus through visible, enabled controls outside text fields and dialogs.
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Tab' || isTypingTarget(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], .task-modal-overlay')) return;
      const kb = resolveKeybinds();
      const next = matchKeybind(event, kb.FOCUS_NEXT);
      const previous = matchKeybind(event, kb.FOCUS_PREVIOUS);
      if (!next && !previous) return;
      const focusable = [...document.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')]
        .filter((el) => !el.disabled && el.getClientRects().length);
      const index = focusable.indexOf(document.activeElement);
      event.preventDefault();
      focusable[(index + (previous ? -1 : 1) + focusable.length) % focusable.length]?.focus();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function openMainView(view) {
    setMainView(view);
    setPage('main');
  }
  function openPage(next) {
    setPage(next);
  }

  // Workspace search (tm-clean 11): pages switch directly; task hits open the
  // Grid on the hit's month, reading hits open Reading; the view consumes
  // searchTarget once it has revealed the record.
  const [searchTarget, setSearchTarget] = useState(null);
  const consumeSearchTarget = useCallback(() => setSearchTarget(null), []);
  function openSearchResult(result) {
    if (result.kind === 'navigation') {
      setPage(result.page);
      if (result.view) setMainView(result.view);
      return;
    }
    setPage('main');
    setMainView(result.kind === 'reading' ? 'reading' : 'tasks');
    if (result.kind === 'task' && result.date) {
      const [year, month] = result.date.split('-').map(Number);
      setGridMonth({ year, month });
    }
    setSearchTarget({ ...result, requestId: Date.now() });
  }
  const tabKey = page === 'main' ? mainView : page === 'reports' ? 'report' : page;

  if (booting) return <LoadingScreen />;

  return (
    <WorkspaceNavigation.Provider value={openSearchResult}>
    <div className="app">
      <header className="app-header">
        {/* Background-only network signature — pointer-events:none, behind
            content (P8.0B). */}
        <TopBarNetwork />
        <div className="app-topbar-content">
          <div className="app-identity">
            <span className="app-title">TaskManager</span>
            <span className="app-tagline">Local Workspace</span>
          </div>
          <nav className="app-utility-nav" aria-label="Pages">
            <button className={`tab${page === 'main' ? ' active' : ''}`} aria-current={page === 'main' ? 'page' : undefined} onClick={() => openPage('main')}>Main</button>
            <MainViewsSlot open={page === 'main'}>
              {MAIN_VIEWS.map(([view, label]) => (
                <button
                  key={view}
                  className={`tab${mainView === view ? ' active' : ''}`}
                  aria-pressed={mainView === view}
                  onClick={() => openMainView(view)}
                >{label}</button>
              ))}
            </MainViewsSlot>
            <button className={`tab${page === 'reports' ? ' active' : ''}`} aria-current={page === 'reports' ? 'page' : undefined} onClick={() => openPage('reports')}>Reports</button>
            <button className={`tab${page === 'settings' ? ' active' : ''}`} aria-current={page === 'settings' ? 'page' : undefined} onClick={() => openPage('settings')}>Settings</button>
          </nav>
        </div>
      </header>

      <main className="app-main" data-tab={tabKey}>
        {page === 'main' && mainView === 'tasks' && (
          <TaskGrid
            viewMonth={gridMonth}
            setViewMonth={setGridMonth}
            searchTarget={searchTarget}
            onTargetConsumed={consumeSearchTarget}
            onScheduleTask={(task) => {
              setCalendarPlaceTask(task);
              openMainView('calendar');
            }}
          />
        )}
        {page === 'main' && mainView === 'reading' && <ReadingSheet searchTarget={searchTarget} onTargetConsumed={consumeSearchTarget} />}
        {page === 'main' && mainView === 'calendar' && (
          <CalendarView
            placeRequest={calendarPlaceTask}
            onPlaceRequestConsumed={() => setCalendarPlaceTask(null)}
          />
        )}
        {page === 'reports' && <MonthlyReport />}
        {page === 'settings' && <Settings sheetMonth={gridMonth} />}
      </main>
    </div>
    </WorkspaceNavigation.Provider>
  );
}
