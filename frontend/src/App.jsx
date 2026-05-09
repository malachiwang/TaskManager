import TaskGrid from './components/TaskGrid.jsx';

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">TaskManagementOS</span>
        <nav className="app-tabs">
          <button className="tab active">Grid</button>
          <button className="tab" disabled>Dashboard</button>
          <button className="tab" disabled>Archive</button>
          <button className="tab" disabled>Settings</button>
        </nav>
      </header>
      <main className="app-main">
        <TaskGrid />
      </main>
    </div>
  );
}
