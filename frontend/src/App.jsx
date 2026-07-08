import { useState, useEffect } from 'react';
import TaskGrid from './components/TaskGrid.jsx';
import Dashboard from './components/Dashboard.jsx';
import Archive from './components/Archive.jsx';
import Settings from './components/Settings.jsx';
import ReadingSheet from './components/ReadingSheet.jsx';
import MonthlyReport from './components/MonthlyReport.jsx';
import TopBarNetwork from './components/TopBarNetwork.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';
import { fetchTasks } from './api.js';

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
  // desktop build the Python sidecar takes a moment to come up. We poll a cheap
  // real endpoint until it answers, then reveal the app. A hard cap guarantees
  // we never trap the user on the loading screen — if the backend stays down we
  // still reveal the shell and let each surface show its own error state.
  const [booting, setBooting] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    const MAX_WAIT_MS = 6000;
    async function probe() {
      try {
        await fetchTasks();
        if (!cancelled) setBooting(false);
      } catch {
        if (cancelled) return;
        if (Date.now() - startedAt >= MAX_WAIT_MS) setBooting(false);
        else setTimeout(probe, 400);
      }
    }
    probe();
    return () => { cancelled = true; };
  }, []);

  // Apply saved theme on mount — reads before first paint would require an
  // inline <script> in index.html; avoids a one-frame theme flash
  // is acceptable and this keeps the implementation self-contained.
  useEffect(() => {
    const saved = localStorage.getItem('taskos-theme') || 'sheets';
    document.documentElement.dataset.theme = saved;
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
            <span className="app-tagline">Pressure Tracker</span>
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
        {activeTool === 'dashboard' && <Dashboard />}
        {activeTool === 'report' && <MonthlyReport />}
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
