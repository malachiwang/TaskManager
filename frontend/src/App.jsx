import { useState } from 'react';
import TaskGrid from './components/TaskGrid.jsx';
import Dashboard from './components/Dashboard.jsx';

export default function App() {
  const [tab, setTab] = useState('grid');

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">TaskManagementOS</span>
        <nav className="app-tabs">
          <button className={`tab${tab === 'grid' ? ' active' : ''}`} onClick={() => setTab('grid')}>Grid</button>
          <button className={`tab${tab === 'dashboard' ? ' active' : ''}`} onClick={() => setTab('dashboard')}>Dashboard</button>
          <button className="tab" disabled>Archive</button>
          <button className="tab" disabled>Settings</button>
        </nav>
      </header>
      <main className="app-main">
        {tab === 'grid' && <TaskGrid />}
        {tab === 'dashboard' && <Dashboard />}
      </main>
    </div>
  );
}
