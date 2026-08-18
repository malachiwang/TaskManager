import { useState, useEffect } from 'react';
import TaskGrid from './components/TaskGrid.jsx';
import Dashboard from './components/Dashboard.jsx';
import Archive from './components/Archive.jsx';
import Settings from './components/Settings.jsx';
import ReadingSheet from './components/ReadingSheet.jsx';
import MonthlyReport from './components/MonthlyReport.jsx';
import TopBarNetwork from './components/TopBarNetwork.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';
import { fetchHealth } from './api.js';
import { initAppearance } from './appearance.js';

export default function App() {
  // Navigation is split into two concepts (P5.0-fix1):
  //   activeSheet — the primary spreadsheet surface (Tasks | Reading), chosen
  //     from the bottom worksheet-tab bar. Its value is preserved while a tool
  //     view is open, so returning from a tool lands back on the last sheet.
  //   activeTool  — a supporting utility view (Dashboard | Archive | Settings)
  //     opened from the top toolbar; null means "show the active sheet".
  const [activeSheet, setActiveSheet] = useState('tasks');
  const [activeTool, setActiveTool] = useState(null);

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

  const showingTool = activeTool !== null;

  // Selecting a bottom sheet tab leaves any open tool view and shows that sheet.
  function openSheet(sheet) {
    setActiveSheet(sheet);
    setActiveTool(null);
  }

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
          {/* Utility/tool views — not primary sheets. */}
          <nav className="app-utility-nav" aria-label="Tools">
            <button className={`tab${activeTool === 'dashboard' ? ' active' : ''}`} onClick={() => setActiveTool('dashboard')}>Dashboard</button>
            <button className={`tab${activeTool === 'report' ? ' active' : ''}`} onClick={() => setActiveTool('report')}>Reports</button>
            <button className={`tab${activeTool === 'archive' ? ' active' : ''}`} onClick={() => setActiveTool('archive')}>Archive</button>
            <button className={`tab${activeTool === 'settings' ? ' active' : ''}`} onClick={() => setActiveTool('settings')}>Settings</button>
          </nav>
        </div>
      </header>

      <main className="app-main" data-tab={showingTool ? activeTool : activeSheet}>
        {!showingTool && activeSheet === 'tasks' && <TaskGrid />}
        {!showingTool && activeSheet === 'reading' && <ReadingSheet />}
        {activeTool === 'dashboard' && <Dashboard onOpenReports={() => setActiveTool('report')} />}
        {activeTool === 'report' && <MonthlyReport onOpenDashboard={() => setActiveTool('dashboard')} />}
        {activeTool === 'archive' && <Archive />}
        {activeTool === 'settings' && <Settings />}
      </main>

      {/* Primary sheet tabs — Google-Sheets-style worksheet tabs. */}
      <nav className="sheet-tabbar" aria-label="Sheets">
        <button
          className={`sheet-tab${!showingTool && activeSheet === 'tasks' ? ' sheet-tab-active' : ''}`}
          onClick={() => openSheet('tasks')}
        >Tasks</button>
        <button
          className={`sheet-tab${!showingTool && activeSheet === 'reading' ? ' sheet-tab-active' : ''}`}
          onClick={() => openSheet('reading')}
        >Reading</button>
      </nav>
    </div>
  );
}
