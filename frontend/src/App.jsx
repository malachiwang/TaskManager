import { useState, useEffect } from 'react';
import TaskGrid from './components/TaskGrid.jsx';
import Dashboard from './components/Dashboard.jsx';
import Archive from './components/Archive.jsx';
import Settings from './components/Settings.jsx';
import ReadingSheet from './components/ReadingSheet.jsx';
import MonthlyReport from './components/MonthlyReport.jsx';

export default function App() {
  // Navigation is split into two concepts (P5.0-fix1):
  //   activeSheet — the primary spreadsheet surface (Tasks | Reading), chosen
  //     from the bottom worksheet-tab bar. Its value is preserved while a tool
  //     view is open, so returning from a tool lands back on the last sheet.
  //   activeTool  — a supporting utility view (Dashboard | Archive | Settings)
  //     opened from the top toolbar; null means "show the active sheet".
  const [activeSheet, setActiveSheet] = useState('tasks');
  const [activeTool, setActiveTool] = useState(null);

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

  return (
    <div className="app">
      <header className="app-header">
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
