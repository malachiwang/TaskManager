import { useState, useEffect } from 'react';
import TaskGrid from './components/TaskGrid.jsx';
import Dashboard from './components/Dashboard.jsx';
import Archive from './components/Archive.jsx';
import Settings from './components/Settings.jsx';
import { buildExportBackupUrl } from './api.js';

export default function App() {
  const [tab, setTab] = useState('grid');

  // Apply saved theme on mount — reads before first paint would require an
  // inline <script> in index.html; for a local-first app a one-frame flash
  // is acceptable and this keeps the implementation self-contained.
  useEffect(() => {
    const saved = localStorage.getItem('taskos-theme') || 'sheets';
    document.documentElement.dataset.theme = saved;
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-identity">
          <span className="app-title">TaskManagementOS</span>
          <span className="app-tagline">local-first · pressure tracker</span>
        </div>
        <nav className="app-tabs">
          <button className={`tab${tab === 'grid' ? ' active' : ''}`} onClick={() => setTab('grid')}>Grid</button>
          <button className={`tab${tab === 'dashboard' ? ' active' : ''}`} onClick={() => setTab('dashboard')}>Dashboard</button>
          <button className={`tab${tab === 'archive' ? ' active' : ''}`} onClick={() => setTab('archive')}>Archive</button>
          <button className={`tab${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}>Settings</button>
        </nav>
        <a className="header-pill" href={buildExportBackupUrl()} download>
          ⤓ <span className="pill-value">Export</span>
        </a>
      </header>
      <main className="app-main" data-tab={tab}>
        {tab === 'grid' && <TaskGrid />}
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'archive' && <Archive />}
        {tab === 'settings' && <Settings />}
      </main>
    </div>
  );
}
