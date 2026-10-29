import { useState, useEffect } from 'react';
import TaskGrid from './components/TaskGrid.jsx';
import CalendarView from './components/CalendarView.jsx';
import Settings from './components/Settings.jsx';
import ReadingSheet from './components/ReadingSheet.jsx';
import MonthlyReport from './components/MonthlyReport.jsx';
import TopBarNetwork from './components/TopBarNetwork.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';
import { fetchHealth } from './api.js';
import WorkspaceSearch from './components/WorkspaceSearch.jsx';
import { initAppearance } from './appearance.js';

export default function App() {
  const [page, setPage] = useState('main');
  const [mainView, setMainView] = useState('grid');
  const [gridMonth, setGridMonth] = useState(() => ({ year: new Date().getFullYear(), month: new Date().getMonth() + 1 }));
  const [calendarState, setCalendarState] = useState({});
  const [reportState, setReportState] = useState({});
  const [searchTarget, setSearchTarget] = useState(null);
  const [calendarPlaceTask, setCalendarPlaceTask] = useState(null);

  function navigate(result) {
    if (result.kind === 'navigation') {
      setPage(result.page);
      if (result.view) setMainView(result.view);
    } else {
      setPage('main');
      setMainView(result.kind === 'reading' ? 'reading' : 'grid');
      if (result.date && result.kind !== 'reading') {
        const [year, month] = result.date.split('-').map(Number);
        setGridMonth({ year, month });
      }
      setSearchTarget({ ...result, requestId: Date.now() });
    }
  }

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
    // Retired views can never reapply hidden filtering. Grouping is independent.
    localStorage.removeItem('taskos-saved-views');
  }, []);

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
          <WorkspaceSearch onOpen={navigate} />
          <nav className="app-utility-nav" aria-label="Pages">
            {['main', 'reports', 'settings'].map((id) => (
              <button key={id} className={`tab${page === id ? ' active' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}>
                {id[0].toUpperCase() + id.slice(1)}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {page === 'main' && <nav className="main-subnav" aria-label="Main views">
        {['grid', 'reading', 'calendar'].map((id) => (
          <button key={id} className={`tab${mainView === id ? ' active' : ''}`} aria-current={mainView === id ? 'page' : undefined} onClick={() => setMainView(id)}>
            {id[0].toUpperCase() + id.slice(1)}
          </button>
        ))}
      </nav>}
      <main className="app-main" data-tab={page === 'main' ? mainView : page}>
        {page === 'main' && mainView === 'grid' && <TaskGrid
          viewMonth={gridMonth} setViewMonth={setGridMonth}
          searchTarget={searchTarget} onTargetConsumed={() => setSearchTarget(null)}
          onScheduleTask={(task) => { setCalendarPlaceTask(task); setMainView('calendar'); }}
        />}
        {page === 'main' && mainView === 'reading' && <ReadingSheet searchTarget={searchTarget} onTargetConsumed={() => setSearchTarget(null)} />}
        {page === 'main' && mainView === 'calendar' && <CalendarView
          savedState={calendarState} onStateChange={setCalendarState}
          placeRequest={calendarPlaceTask} onPlaceRequestConsumed={() => setCalendarPlaceTask(null)}
        />}
        {page === 'reports' && <MonthlyReport savedState={reportState} onStateChange={setReportState} />}
        {page === 'settings' && <Settings sheetMonth={gridMonth} />}
      </main>
    </div>
  );
}
