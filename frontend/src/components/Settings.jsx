import { useState } from 'react';
import { buildExportBackupUrl } from '../api.js';

const LS_SETTINGS_KEY  = 'taskos-settings';
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
  const [theme, setTheme]                   = useState(() => localStorage.getItem('taskos-theme') || 'sheets');
  const [defaultSection, setDefaultSection] = useState(() => loadSettings().defaultSection ?? 'General');
  const [defaultPriority, setDefaultPriority] = useState(() => loadSettings().defaultPriority ?? 5);
  const [defaultInterval, setDefaultInterval] = useState(() => loadSettings().defaultIntervalDays ?? 7);
  const [savedMsg, setSavedMsg]             = useState(false);
  const [colResetMsg, setColResetMsg]       = useState(false);

  function handleSaveDefaults(e) {
    e.preventDefault();
    try {
      localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify({
        defaultSection:     defaultSection.trim() || 'General',
        defaultPriority:    Math.min(10, Math.max(1, Number(defaultPriority) || 5)),
        defaultIntervalDays: Math.max(1, Number(defaultInterval) || 7),
      }));
      setSavedMsg(true);
      setTimeout(() => setSavedMsg(false), 2000);
    } catch {}
  }

  function handleThemeChange(e) {
    const value = e.target.value;
    setTheme(value);
    document.documentElement.dataset.theme = value;
    localStorage.setItem('taskos-theme', value);
  }

  function handleResetColumns() {
    localStorage.removeItem(LS_COL_WIDTHS_KEY);
    setColResetMsg(true);
  }

  return (
    <div className="ws-settings">

      {/* ── Page chrome — design report .mh as page header ── */}
      <div className="ws-page-header">
        <span>Settings</span>
        <span className="ws-page-header-sub">local preferences · stored in browser · never synced</span>
      </div>

      {/* ── Appearance — design report .stl/.grp pattern ── */}
      <div className="ws-frame">
        <div className="ws-frame-header">
          <span>Appearance</span>
        </div>
        <ul className="ws-settings-list">
          <li className="ws-settings-item">
            <div>
              <div className="ws-settings-name">Visual theme</div>
              <span className="ws-settings-desc">tokens only · no layout change</span>
            </div>
            <div className="ws-settings-ctl">
              <select
                className="settings-input"
                style={{ width: '180px' }}
                value={theme}
                onChange={handleThemeChange}
              >
                <option value="sheets">Sheets Classic</option>
                <option value="paper">Paper Workstation</option>
              </select>
            </div>
          </li>
        </ul>
      </div>

      {/* ── Task defaults ── */}
      <div className="ws-frame">
        <div className="ws-frame-header">
          <span>Task defaults</span>
          <span className="ws-frame-header-sub">applied when opening Add Task</span>
        </div>
        <div className="ws-frame-body">
          <p className="settings-help" style={{ marginBottom: '10px' }}>
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
              <button className="button-secondary" type="submit">Save Defaults</button>
              {savedMsg && <span className="settings-saved">Saved.</span>}
            </div>
          </form>
        </div>
      </div>

      {/* ── Grid columns ── */}
      <div className="ws-frame">
        <div className="ws-frame-header">
          <span>Grid columns</span>
        </div>
        <ul className="ws-settings-list">
          <li className="ws-settings-item">
            <div>
              <div className="ws-settings-name">Column widths</div>
              <span className="ws-settings-desc">drag column edges in the grid to resize · stored in localStorage</span>
            </div>
            <div className="ws-settings-ctl">
              <button className="button-secondary" onClick={handleResetColumns}>
                Reset widths
              </button>
            </div>
          </li>
          {colResetMsg && (
            <li className="ws-settings-item">
              <span className="settings-saved">
                Column widths cleared. Switch to the Grid tab to see the updated layout.
              </span>
            </li>
          )}
        </ul>
      </div>

      {/* ── Data safety — design report Privacy group pattern ── */}
      <div className="ws-frame">
        <div className="ws-frame-header">
          <span>Data safety</span>
          <span className="ws-frame-header-sub">export before bulk changes</span>
        </div>
        <ul className="ws-settings-list">
          <li className="ws-settings-item">
            <div>
              <div className="ws-settings-name">Database</div>
              <span className="ws-settings-desc">local SQLite · taskos.db · gitignored · never committed</span>
            </div>
            <span className="ws-settings-ctl verified">local</span>
          </li>
          <li className="ws-settings-item">
            <div>
              <div className="ws-settings-name">Cloud sync</div>
              <span className="ws-settings-desc">no cloud sync · no authentication · no external services</span>
            </div>
            <span className="ws-settings-ctl none">none</span>
          </li>
          <li className="ws-settings-item">
            <div>
              <div className="ws-settings-name">Telemetry</div>
              <span className="ws-settings-desc">there is none. ever.</span>
            </div>
            <span className="ws-settings-ctl verified">off</span>
          </li>
          <li className="ws-settings-item">
            <div>
              <div className="ws-settings-name">Network calls</div>
              <span className="ws-settings-desc">localhost only · 0 outbound requests</span>
            </div>
            <span className="ws-settings-ctl verified">verified</span>
          </li>
          <li className="ws-settings-item">
            <div>
              <div className="ws-settings-name">Export backup JSON</div>
              <span className="ws-settings-desc">full database export · use before importing or bulk changes</span>
            </div>
            <a className="button-secondary" href={buildExportBackupUrl()} download>
              Export JSON
            </a>
          </li>
        </ul>
      </div>

      {/* ── Urgency formula — read only ── */}
      <div className="ws-frame">
        <div className="ws-frame-header">
          <span>Urgency formula</span>
          <span className="ws-frame-header-sub">read only · fixed in backend/logic.py</span>
        </div>
        <div className="ws-frame-body">
          <p className="settings-help" style={{ marginBottom: '8px' }}>
            Asymptotic — urgency approaches 10 but never exceeds it. Paused tasks always have urgency 0.
            Formula constants are fixed in <code>backend/logic.py</code> and are not editable here.
          </p>
          <pre className="settings-pre">{`base   = f(priority)       — sets the urgency floor
floor  = base / 2
growth = 1 − exp(−k × D / I)
urgency = 10 × (floor + (1 − floor) × growth)

k = 2.0   D = days_since   I = interval_days`}</pre>
        </div>
      </div>

      {/* ── About ── */}
      <div className="ws-frame">
        <div className="ws-frame-header">
          <span>About</span>
        </div>
        <div className="ws-frame-body settings-prose">
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
      </div>

    </div>
  );
}
