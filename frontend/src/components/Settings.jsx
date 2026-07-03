import { useState, useMemo, useEffect } from 'react';
import { downloadExportBackup, fetchDoc } from '../api.js';
import {
  KEYBINDS, KB_GROUP_ORDER, FIXED_SHORTCUTS,
  loadKbOverrides, writeKbOverrides, buildResolvedFromOverrides,
  isReservedBinding, findBindingConflict, captureEventToBinding,
  bindingLabel, bindingSignature, normalizeBinding,
} from '../keybinds.js';

const LS_SETTINGS_KEY   = 'taskos-settings';
const LS_COL_WIDTHS_KEY = 'taskos-col-widths';

function loadSettings() {
  try {
    const saved = localStorage.getItem(LS_SETTINGS_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

function DocSection({ name, label }) {
  const [open,    setOpen]    = useState(false);
  const [content, setContent] = useState(null);
  const [err,     setErr]     = useState(false);

  function handleToggle() {
    if (!open && content === null && !err) {
      fetchDoc(name)
        .then(setContent)
        .catch(() => setErr(true));
    }
    setOpen((v) => !v);
  }

  return (
    <div className="ws-doc-section">
      <button type="button" className="ws-doc-toggle" onClick={handleToggle}>
        {label} {open ? '▴' : '▾'}
      </button>
      {open && (
        err
          ? <pre className="ws-doc-pre" style={{ color: 'var(--urg-crit)' }}>Could not load {label.toLowerCase()} document.</pre>
          : content !== null
            ? <pre className="ws-doc-pre">{content}</pre>
            : <pre className="ws-doc-pre" style={{ color: 'var(--muted-2)' }}>Loading…</pre>
      )}
    </div>
  );
}

export default function Settings() {
  const [theme, setTheme]                     = useState(() => localStorage.getItem('taskos-theme') || 'sheets');
  const [defaultSection, setDefaultSection]   = useState(() => loadSettings().defaultSection      ?? 'General');
  const [defaultPriority, setDefaultPriority] = useState(() => loadSettings().defaultPriority     ?? 5);
  const [defaultInterval, setDefaultInterval] = useState(() => loadSettings().defaultIntervalDays ?? 7);
  const [savedMsg, setSavedMsg]               = useState(false);
  const [colResetMsg, setColResetMsg]         = useState(false);

  // Keybind overrides state — only the overrides (not full resolved map).
  // Updating this state re-derives resolvedKb immediately.
  const [kbOverrides, setKbOverrides] = useState(loadKbOverrides);
  const resolvedKb = useMemo(() => buildResolvedFromOverrides(kbOverrides), [kbOverrides]);

  // Recording state: which action is being recorded, and any inline error.
  const [recordingAction, setRecordingAction] = useState(null);
  const [recordingError,  setRecordingError]  = useState('');

  // Static group/action structure — shape never changes.
  const kbGroups = useMemo(() =>
    KB_GROUP_ORDER.map((group) => ({
      group,
      actions: Object.entries(KEYBINDS).filter(([, b]) => b.group === group),
    })),
  []);

  // ---------------------------------------------------------------------------
  // Keybind recording — capture next keydown while recording is active.
  // TaskGrid is unmounted on the Settings tab so there is no handler conflict.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!recordingAction) return;

    function captureKey(e) {
      // Pure modifier keys — ignore silently; user is still composing.
      if (['Shift', 'Control', 'Meta', 'Alt', 'CapsLock'].includes(e.key)) return;

      // Escape always cancels recording, never binds.
      if (e.key === 'Escape') {
        e.preventDefault();
        setRecordingAction(null);
        setRecordingError('');
        return;
      }

      // Block everything else from triggering browser shortcuts while recording.
      e.preventDefault();
      e.stopPropagation();

      const binding = captureEventToBinding(e);
      if (!binding) return;

      // Shift+0–9 reserved: Shift+0 opens jump mode, Shift+1–9 quick-select.
      // event.code check is layout-agnostic (Shift+0 gives ')' in event.key on US keyboards).
      if (e.shiftKey && /^Digit[0-9]$/.test(e.code)) {
        setRecordingError('Reserved — Shift+0 opens jump mode; Shift+1–9 for quick selection');
        return;
      }

      if (isReservedBinding(binding)) {
        setRecordingError('Reserved — choose a letter, digit, or symbol');
        return;
      }

      const conflict = findBindingConflict(binding, recordingAction, resolvedKb);
      if (conflict) {
        setRecordingError(`Already used for "${KEYBINDS[conflict].description}"`);
        return;
      }

      // Valid — apply using functional update to avoid stale kbOverrides closure.
      const action = recordingAction;
      setKbOverrides((prev) => {
        const isDefault =
          bindingSignature(binding) === bindingSignature(normalizeBinding(KEYBINDS[action]));
        const next = { ...prev };
        if (isDefault) {
          delete next[action];
        } else {
          next[action] = binding;
        }
        writeKbOverrides(next);
        return next;
      });
      setRecordingAction(null);
      setRecordingError('');
    }

    window.addEventListener('keydown', captureKey);
    return () => window.removeEventListener('keydown', captureKey);
  }, [recordingAction, resolvedKb]); // eslint-disable-line react-hooks/exhaustive-deps

  function startRecording(action) {
    setRecordingAction(action);
    setRecordingError('');
  }

  function cancelRecording() {
    setRecordingAction(null);
    setRecordingError('');
  }

  function resetOverride(action) {
    setKbOverrides((prev) => {
      const next = { ...prev };
      delete next[action];
      writeKbOverrides(next);
      return next;
    });
    // Cancel recording for this action if it was active.
    if (recordingAction === action) cancelRecording();
  }

  function resetAllOverrides() {
    writeKbOverrides({});
    setKbOverrides({});
    cancelRecording();
  }

  function handleSaveDefaults(e) {
    e.preventDefault();
    try {
      localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify({
        defaultSection:      defaultSection.trim() || 'General',
        defaultPriority:     Math.min(10, Math.max(1, Number(defaultPriority) || 5)),
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
    setTimeout(() => setColResetMsg(false), 4000);
  }

  const themeLabel = theme === 'paper' ? 'Paper Workstation' : 'Sheets Classic';

  return (
    <div className="ws-settings">

      {/* ── Hero ── */}
      <div className="ws-page-header">
        <span>Settings</span>
        <span className="ws-page-header-sub">local preferences · browser storage · never synced</span>
      </div>

      {/* ── Summary strip ── */}
      <div className="ws-settings-summary">
        <div className="ws-settings-summary-cell">
          <span className="ws-settings-summary-label">Theme</span>
          <span className="ws-settings-summary-value">{themeLabel}</span>
        </div>
        <div className="ws-settings-summary-cell">
          <span className="ws-settings-summary-label">Default section</span>
          <span className="ws-settings-summary-value">{defaultSection || 'General'}</span>
        </div>
        <div className="ws-settings-summary-cell">
          <span className="ws-settings-summary-label">Default priority</span>
          <span className="ws-settings-summary-value">{defaultPriority} / 10</span>
        </div>
        <div className="ws-settings-summary-cell">
          <span className="ws-settings-summary-label">Storage</span>
          <span className="ws-settings-summary-value">local SQLite</span>
        </div>
      </div>

      {/* ── Two-column layout ── */}
      <div className="ws-settings-layout">

        {/* ══ Left column ══ */}
        <div className="ws-settings-col">

          {/* 01 Appearance */}
          <div className="ws-frame">
            <div className="ws-frame-header">
              <span className="ws-frame-kicker">01</span>
              <span>Appearance</span>
            </div>
            <div className="ws-ctrl-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Visual theme</span>
                <span className="ws-ctrl-desc">
                  Paper Workstation is the primary theme. Sheets Classic is a legacy alternative.
                </span>
              </div>
              <div className="ws-ctrl-action">
                <select
                  className="settings-input"
                  style={{ width: '170px' }}
                  value={theme}
                  onChange={handleThemeChange}
                >
                  <option value="sheets">Sheets Classic</option>
                  <option value="paper">Paper Workstation</option>
                </select>
              </div>
            </div>
          </div>

          {/* 02 Task Defaults */}
          <div className="ws-frame">
            <div className="ws-frame-header">
              <span className="ws-frame-kicker">02</span>
              <span>Task defaults</span>
              <span className="ws-frame-header-sub">pre-filled in Add Task</span>
            </div>
            <form onSubmit={handleSaveDefaults}>
              <div className="ws-ctrl-row">
                <div className="ws-ctrl-info">
                  <span className="ws-ctrl-label">Default section</span>
                  <span className="ws-ctrl-desc">Pre-filled section name for new tasks.</span>
                </div>
                <div className="ws-ctrl-action">
                  <input
                    className="settings-input"
                    style={{ width: '120px' }}
                    value={defaultSection}
                    onChange={(e) => { setDefaultSection(e.target.value); setSavedMsg(false); }}
                    placeholder="General"
                  />
                </div>
              </div>
              <div className="ws-ctrl-row">
                <div className="ws-ctrl-info">
                  <span className="ws-ctrl-label">Default priority <span className="settings-label-hint">(1–10)</span></span>
                  <span className="ws-ctrl-desc">Starting priority level for new tasks.</span>
                </div>
                <div className="ws-ctrl-action">
                  <input
                    type="number"
                    min="1"
                    max="10"
                    className="settings-input"
                    style={{ width: '64px' }}
                    value={defaultPriority}
                    onChange={(e) => { setDefaultPriority(e.target.value); setSavedMsg(false); }}
                  />
                </div>
              </div>
              <div className="ws-ctrl-row">
                <div className="ws-ctrl-info">
                  <span className="ws-ctrl-label">Default interval <span className="settings-label-hint">(days)</span></span>
                  <span className="ws-ctrl-desc">How often a new task recurs by default.</span>
                </div>
                <div className="ws-ctrl-action">
                  <input
                    type="number"
                    min="1"
                    className="settings-input"
                    style={{ width: '64px' }}
                    value={defaultInterval}
                    onChange={(e) => { setDefaultInterval(e.target.value); setSavedMsg(false); }}
                  />
                </div>
              </div>
              <div className="ws-ctrl-row ws-ctrl-row--action">
                <div className="ws-ctrl-info" />
                <div className="ws-ctrl-action">
                  {savedMsg && <span className="settings-saved">Saved.</span>}
                  <button className="button-secondary" type="submit">Save defaults</button>
                </div>
              </div>
            </form>
          </div>

          {/* 03 Grid Preferences */}
          <div className="ws-frame">
            <div className="ws-frame-header">
              <span className="ws-frame-kicker">03</span>
              <span>Grid preferences</span>
              <span className="ws-frame-header-sub">layout only · no task data changed</span>
            </div>
            <div className="ws-ctrl-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Column widths</span>
                <span className="ws-ctrl-desc">
                  Drag column edges to resize. Widths are saved in browser storage per device.
                  {colResetMsg && (
                    <span className="settings-saved" style={{ display: 'block', marginTop: '4px' }}>
                      Widths cleared. Switch to the Grid tab to see the updated layout.
                    </span>
                  )}
                </span>
              </div>
              <div className="ws-ctrl-action">
                <button className="button-secondary" onClick={handleResetColumns}>
                  Reset widths
                </button>
              </div>
            </div>
          </div>

        </div>{/* end left column */}

        {/* ══ Right column ══ */}
        <div className="ws-settings-col">

          {/* 04 Data & Backup */}
          <div className="ws-frame">
            <div className="ws-frame-header">
              <span className="ws-frame-kicker">04</span>
              <span>Data &amp; backup</span>
              <span className="ws-frame-header-sub">export before bulk changes or imports</span>
            </div>

            {/* Primary export action */}
            <div className="ws-backup-primary">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Export full backup</span>
                <span className="ws-ctrl-desc">
                  JSON with all tasks, completions, and archive snapshots. Use before CSV imports
                  or bulk edits you may want to reverse.
                </span>
              </div>
              <button className="button-secondary ws-backup-btn" onClick={() => downloadExportBackup()}>
                Download JSON
              </button>
            </div>

            <div className="ws-ctrl-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Storage location</span>
                <span className="ws-ctrl-desc">
                  All task data lives in <code>taskos.db</code> — a local SQLite file in the project
                  root. Gitignored, never committed. UI preferences are stored in browser localStorage.
                </span>
              </div>
              <div className="ws-ctrl-action">
                <span className="ws-state-badge ws-state-badge--on">local</span>
              </div>
            </div>

            <div className="ws-ctrl-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Privacy</span>
                <span className="ws-ctrl-desc">
                  No cloud sync. No authentication. No external services. No telemetry.
                  All network traffic is localhost only.
                </span>
              </div>
              <div className="ws-ctrl-action">
                <span className="ws-state-badge ws-state-badge--on">offline</span>
              </div>
            </div>
          </div>

          {/* 05 Keyboard Shortcuts */}
          <div className="ws-frame">
            <div className="ws-frame-header">
              <span className="ws-frame-kicker">05</span>
              <span>Keyboard shortcuts</span>
              <span className="ws-frame-header-sub">customizable · saved in browser storage</span>
            </div>
            {kbGroups.map(({ group, actions }) => (
              <div key={group}>
                <div className="ws-settings-group">{group}</div>
                {FIXED_SHORTCUTS.filter((s) => s.group === group).map((s) => (
                  <div key={s.keys} className="ws-kbd-shortcut-row">
                    <kbd className="ws-kbd-key">{s.keys}</kbd>
                    <span className="ws-kbd-shortcut-desc">{s.description}</span>
                    <span className="ws-state-badge ws-state-badge--dim">fixed</span>
                  </div>
                ))}
                {actions.map(([action, binding]) => {
                  const isRecording = recordingAction === action;
                  if (!binding.customizable) {
                    return (
                      <div key={action} className="ws-kbd-shortcut-row">
                        <kbd className="ws-kbd-key">{bindingLabel(resolvedKb[action])}</kbd>
                        <span className="ws-kbd-shortcut-desc">{binding.description}</span>
                        <span className="ws-state-badge ws-state-badge--dim">fixed</span>
                      </div>
                    );
                  }
                  if (isRecording) {
                    return (
                      <div key={action} className="ws-kbd-shortcut-row ws-kbd-shortcut-row--recording">
                        <span className="ws-kbd-recording-prompt">Press a key…</span>
                        {recordingError
                          ? <span className="ws-kbd-error" aria-live="polite">{recordingError}</span>
                          : <span className="ws-kbd-shortcut-desc">{binding.description}</span>
                        }
                        <button className="ws-kbd-action-btn" onClick={cancelRecording}>Cancel</button>
                      </div>
                    );
                  }
                  return (
                    <div key={action} className="ws-kbd-shortcut-row">
                      <kbd className="ws-kbd-key">{bindingLabel(resolvedKb[action])}</kbd>
                      <span className="ws-kbd-shortcut-desc">{binding.description}</span>
                      <button className="ws-kbd-action-btn" onClick={() => startRecording(action)}>Change</button>
                      {action in kbOverrides && (
                        <button className="ws-kbd-action-btn ws-kbd-action-btn--reset" onClick={() => resetOverride(action)}>Reset</button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            {Object.keys(kbOverrides).length > 0 && (
              <div className="ws-kbd-reset-all">
                <button className="ws-kbd-action-btn" onClick={resetAllOverrides}>
                  Reset all shortcuts
                </button>
              </div>
            )}
          </div>

          {/* 06 System Behavior */}
          <div className="ws-frame">
            <div className="ws-frame-header">
              <span className="ws-frame-kicker">06</span>
              <span>System behavior</span>
              <span className="ws-frame-header-sub">reference</span>
            </div>

            <div className="ws-settings-group">Urgency formula</div>
            <div className="ws-formula-block">
              <pre className="settings-pre">{`urgency = 10 × (floor + (1 − floor) × growth)

base   = f(priority)        floor  = base / 2
growth = 1 − exp(−k × D/I)  k = 2.0

D = days_since   I = interval_days`}</pre>
              <p className="ws-formula-note">
                Asymptotic — approaches 10, never exceeds it. At D = I (due), urgency is
                roughly halfway to 10. At D = 2I, urgency is near-peak. Hiatus tasks always score 0.
              </p>
            </div>

            <div className="ws-settings-group">Task status</div>
            <div className="ws-state-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Active</span>
                <span className="ws-ctrl-desc">Accumulates urgency. Appears in all pressure calculations. Default for all new tasks.</span>
              </div>
              <span className="ws-state-badge ws-state-badge--on">tracking</span>
            </div>
            <div className="ws-state-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Hiatus</span>
                <span className="ws-ctrl-desc">Suspended. Scores 0 urgency. Hidden from dashboard pressure and priority queue. Fully recoverable — set back to Active to resume.</span>
              </div>
              <span className="ws-state-badge ws-state-badge--off">suspended</span>
            </div>

            <div className="ws-settings-group">Other fields</div>
            <div className="ws-state-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Active from</span>
                <span className="ws-ctrl-desc">Optional display-only date. Stored and visible in the grid. Does not affect urgency calculations.</span>
              </div>
              <span className="ws-state-badge">display only</span>
            </div>
            <div className="ws-state-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Delete task</span>
                <span className="ws-ctrl-desc">Sets <code>is_active = 0</code>. Disappears from grid and dashboard. Completion history and archive snapshots are fully preserved. Recoverable via backup.</span>
              </div>
              <span className="ws-state-badge">soft delete</span>
            </div>
            <div className="ws-state-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Archive snapshots</span>
                <span className="ws-ctrl-desc">Frozen JSON copy of all active tasks for a date range. Independent of live tasks — renaming or deleting current tasks has no effect on snapshots.</span>
              </div>
              <span className="ws-state-badge">immutable</span>
            </div>
          </div>

          {/* 07 About */}
          <div className="ws-frame">
            <div className="ws-frame-header">
              <span className="ws-frame-kicker">07</span>
              <span>About</span>
            </div>
            <div className="ws-frame-body settings-prose">
              <p>
                <strong>TaskManager</strong> is a spreadsheet-style task pressure tracker.
                FastAPI backend, SQLite storage, React/Vite frontend. Built as a personal
                productivity instrument.
              </p>
              <p style={{ marginTop: '8px' }}>
                All data is stored in <code>taskos.db</code> at the project root. Gitignored,
                never leaves your machine. No cloud, no account, no external runtime dependencies.
              </p>
              <p style={{ marginTop: '8px', color: 'var(--muted)' }}>
                Personal tool — not a public SaaS product. No notifications, no mobile, no
                multi-user support. Current limitations are known and intentional.
              </p>
              <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <DocSection name="privacy"       label="Privacy" />
                <DocSection name="accessibility" label="Accessibility" />
                <DocSection name="terms"         label="Terms" />
              </div>
            </div>
          </div>

        </div>{/* end right column */}
      </div>{/* end layout */}

    </div>
  );
}
