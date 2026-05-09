import { useState } from 'react';
import { buildExportBackupUrl } from '../api.js';

const LS_SETTINGS_KEY = 'taskos-settings';
const LS_COL_WIDTHS_KEY = 'taskos-col-widths';

function loadSettings() {
  try {
    const saved = localStorage.getItem(LS_SETTINGS_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

export default function Settings() {
  const [defaultSection, setDefaultSection] = useState(() => loadSettings().defaultSection ?? 'General');
  const [defaultPriority, setDefaultPriority] = useState(() => loadSettings().defaultPriority ?? 5);
  const [defaultInterval, setDefaultInterval] = useState(() => loadSettings().defaultIntervalDays ?? 7);
  const [savedMsg, setSavedMsg] = useState(false);
  const [colResetMsg, setColResetMsg] = useState(false);

  function handleSaveDefaults(e) {
    e.preventDefault();
    try {
      localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify({
        defaultSection: defaultSection.trim() || 'General',
        defaultPriority: Math.min(10, Math.max(1, Number(defaultPriority) || 5)),
        defaultIntervalDays: Math.max(1, Number(defaultInterval) || 7),
      }));
      setSavedMsg(true);
      setTimeout(() => setSavedMsg(false), 2000);
    } catch {}
  }

  function handleResetColumns() {
    localStorage.removeItem(LS_COL_WIDTHS_KEY);
    setColResetMsg(true);
  }

  return (
    <div className="settings">

      {/* Task Defaults */}
      <section className="dash-section">
        <div className="dash-section-title">Task Defaults</div>
        <div className="settings-body">
          <p className="settings-help">
            Applied when opening the Add Task dialog. Editing an existing task always uses its saved values.
          </p>
          <form onSubmit={handleSaveDefaults} className="settings-form">
            <div className="settings-form-row">
              <label className="settings-label">
                Default Section
                <input
                  className="settings-input"
                  style={{ width: '130px' }}
                  value={defaultSection}
                  onChange={(e) => { setDefaultSection(e.target.value); setSavedMsg(false); }}
                  placeholder="General"
                />
              </label>
              <label className="settings-label">
                Default Priority (1–10)
                <input
                  type="number"
                  min="1"
                  max="10"
                  className="settings-input"
                  style={{ width: '80px' }}
                  value={defaultPriority}
                  onChange={(e) => { setDefaultPriority(e.target.value); setSavedMsg(false); }}
                />
              </label>
              <label className="settings-label">
                Default Interval (days)
                <input
                  type="number"
                  min="1"
                  className="settings-input"
                  style={{ width: '80px' }}
                  value={defaultInterval}
                  onChange={(e) => { setDefaultInterval(e.target.value); setSavedMsg(false); }}
                />
              </label>
            </div>
            <div className="settings-actions">
              <button className="btn-archive-sheet" type="submit">Save Defaults</button>
              {savedMsg && <span className="settings-saved">Saved.</span>}
            </div>
          </form>
        </div>
      </section>

      {/* Columns */}
      <section className="dash-section">
        <div className="dash-section-title">Columns</div>
        <div className="settings-body">
          <div>
            <button className="btn-archive-sheet" onClick={handleResetColumns}>
              Reset Column Widths
            </button>
          </div>
          {colResetMsg && (
            <span className="settings-saved">
              Column widths cleared. Switch to the Grid tab (or refresh the page) to see the updated layout.
            </span>
          )}
        </div>
      </section>

      {/* Data */}
      <section className="dash-section">
        <div className="dash-section-title">Data</div>
        <div className="settings-body">
          <p className="settings-help">
            Export a full backup before importing or making bulk changes.
          </p>
          <div>
            <a className="btn-archive-sheet" href={buildExportBackupUrl()} download>
              Export Backup JSON
            </a>
          </div>
        </div>
      </section>

      {/* Urgency Formula */}
      <section className="dash-section">
        <div className="dash-section-title">Urgency Formula</div>
        <div className="settings-body">
          <p className="settings-help">
            Asymptotic — urgency approaches 10 but never exceeds it. Paused tasks always have urgency 0.
            Formula constants are fixed in <code>backend/logic.py</code> and are not editable here.
          </p>
          <pre className="settings-pre">{`base   = f(priority)       — sets the urgency floor
floor  = base / 2
growth = 1 − exp(−k × D / I)
urgency = 10 × (floor + (1 − floor) × growth)

k = 2.0   D = days_since   I = interval_days`}</pre>
        </div>
      </section>

      {/* About */}
      <section className="dash-section">
        <div className="dash-section-title">About</div>
        <div className="settings-body settings-prose">
          <p><strong>TaskManagementOS</strong> is a local-first task-pressure tracker.</p>
          <ul>
            <li>All data is stored in a local SQLite file (<code>taskos.db</code>).</li>
            <li><code>taskos.db</code> is gitignored — it is never committed to version control.</li>
            <li>There is no cloud sync, no authentication, and no external services.</li>
            <li>UI preferences (column widths, settings) are stored in browser localStorage.</li>
            <li>This is a personal MVP — not a public SaaS product.</li>
            <li>Current limitations: no notifications, no mobile app, no multi-user support.</li>
          </ul>
        </div>
      </section>

    </div>
  );
}
