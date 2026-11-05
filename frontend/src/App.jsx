import { useState, useEffect } from 'react';
import TaskGrid from './components/TaskGrid.jsx';
import CalendarView from './components/CalendarView.jsx';
import Settings from './components/Settings.jsx';
import ReadingSheet from './components/ReadingSheet.jsx';
import MonthlyReport from './components/MonthlyReport.jsx';
import TopBarNetwork from './components/TopBarNetwork.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';
import { fetchHealth } from './api.js';
import { initAppearance } from './appearance.js';

// Main's views, shown inline in the nav row while Main is active.
const MAIN_VIEWS = [['tasks', 'Grid'], ['reading', 'Reading'], ['calendar', 'Calendar']];

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

  function openMainView(view) {
    setMainView(view);
    setPage('main');
  }
  function openPage(next) {
    setPage(next);
  }
  const tabKey = page === 'main' ? mainView : page === 'reports' ? 'report' : page;

  if (booting) return <LoadingScreen />;

  return (
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
            {page === 'main' && MAIN_VIEWS.map(([view, label]) => (
              <button
                key={view}
                className={`tab${mainView === view ? ' active' : ''}`}
                aria-pressed={mainView === view}
                onClick={() => openMainView(view)}
              >{label}</button>
            ))}
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
            onScheduleTask={(task) => {
              setCalendarPlaceTask(task);
              openMainView('calendar');
            }}
          />
        )}
        {page === 'main' && mainView === 'reading' && <ReadingSheet />}
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
  );
}
