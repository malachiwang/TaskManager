import { useState, useMemo, useEffect, useRef } from 'react';
import { downloadExportBackup, restoreBackup, fetchDoc } from '../api.js';
import {
  KEYBINDS, KB_GROUP_ORDER, FIXED_SHORTCUTS,
  loadKbOverrides, writeKbOverrides, buildResolvedFromOverrides,
  isReservedBinding, findBindingConflict, captureEventToBinding,
  bindingLabel, bindingSignature, normalizeBinding,
} from '../keybinds.js';
import {
  loadAppearance, saveAppearance,
  APPEARANCE_MODES, ACCENT_THEMES, MOTION_LEVELS,
} from '../appearance.js';
import {
  loadPreferences as loadDashPrefs,
  toggleSection as dashToggleSection,
  toggleCard as dashToggleCard,
  resetVisibility as dashResetVisibility,
  resetDismissals as dashResetDismissals,
  hasDismissals as dashHasDismissals,
  DASHBOARD_SECTIONS, DASHBOARD_CARDS,
} from '../dashboardPreferences.js';

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
  // Appearance mode / accent / motion (P10.0) — applied live, saved locally.
  const [appearance, setAppearance]           = useState(loadAppearance);
  const [defaultSection, setDefaultSection]   = useState(() => loadSettings().defaultSection      ?? 'General');
  const [defaultPriority, setDefaultPriority] = useState(() => loadSettings().defaultPriority     ?? 5);
  const [defaultInterval, setDefaultInterval] = useState(() => loadSettings().defaultIntervalDays ?? 7);
  const [quickJumpEnabled, setQuickJumpEnabled] = useState(() => loadSettings().quickJumpEnabled  ?? true);
  const [savedMsg, setSavedMsg]               = useState(false);
  const [colResetMsg, setColResetMsg]         = useState(false);

  // Restore-from-backup flow (P9.0). A selected file arms an explicit
  // confirmation step — nothing is sent to the backend until the user
  // confirms the overwrite warning.
  const restoreInputRef = useRef(null);
  const [restoreFile, setRestoreFile]     = useState(null);
  const [restoreBusy, setRestoreBusy]     = useState(false);
  const [restoreResult, setRestoreResult] = useState(null);
  const [restoreError, setRestoreError]   = useState('');

  function handleRestoreFilePicked(e) {
    const file = e.target.files?.[0] ?? null;
    setRestoreFile(file);
    setRestoreResult(null);
    setRestoreError('');
    // Allow re-picking the same file later.
    e.target.value = '';
  }

  function cancelRestore() {
    setRestoreFile(null);
    setRestoreError('');
  }

  async function confirmRestore() {
    if (!restoreFile || restoreBusy) return;
    setRestoreBusy(true);
    setRestoreError('');
    try {
      const result = await restoreBackup(restoreFile);
      setRestoreResult(result);
      setRestoreFile(null);
    } catch (err) {
      setRestoreError(err?.message || 'Restore failed.');
    } finally {
      setRestoreBusy(false);
    }
  }

  // Dashboard display/recommendation preferences (localStorage-only, P6.0A-fix6).
  const [dashPrefs, setDashPrefs] = useState(loadDashPrefs);
  const dashHidden = (k) => !!dashPrefs.hiddenSections[k];
  const dashCardHidden = (k) => !!dashPrefs.hiddenCards[k];
  const handleDashToggleSection = (k) => setDashPrefs((p) => dashToggleSection(p, k));
  const handleDashToggleCard = (k) => setDashPrefs((p) => dashToggleCard(p, k));
  const handleDashResetVisibility = () => setDashPrefs((p) => dashResetVisibility(p));
  const handleDashResetDismissals = () => setDashPrefs((p) => dashResetDismissals(p));

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

      // Shift+0–9 reserved for Quick Jump (row/column navigation and jump prompt).
      // event.code check is layout-agnostic (Shift+0 gives ')' in event.key on US keyboards).
      if (e.shiftKey && /^Digit[0-9]$/.test(e.code)) {
        setRecordingError('Reserved — Shift+digits are used by Quick Jump navigation');
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

  function handleQuickJumpToggle(e) {
    const value = e.target.checked;
    setQuickJumpEnabled(value);
    try {
      const current = loadSettings();
      localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify({ ...current, quickJumpEnabled: value }));
    } catch {}
  }

  function handleSaveDefaults(e) {
    e.preventDefault();
    try {
      localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify({
        defaultSection:      defaultSection.trim() || 'General',
        defaultPriority:     Math.min(10, Math.max(1, Number(defaultPriority) || 5)),
        defaultIntervalDays: Math.max(1, Number(defaultInterval) || 7),
        quickJumpEnabled,
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

  function updateAppearance(patch) {
    setAppearance((prev) => {
      const next = { ...prev, ...patch };
      saveAppearance(next);
      return next;
    });
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
            <div className="ws-ctrl-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Appearance</span>
                <span className="ws-ctrl-desc">
                  System follows your OS light/dark preference. Urgency colors keep
                  their meaning in every mode.
                </span>
              </div>
              <div className="ws-ctrl-action">
                <div className="settings-seg" role="group" aria-label="Appearance mode">
                  {APPEARANCE_MODES.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      className={`settings-seg-btn${appearance.mode === m.value ? ' settings-seg-btn--active' : ''}`}
                      aria-pressed={appearance.mode === m.value}
                      onClick={() => updateAppearance({ mode: m.value })}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="ws-ctrl-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Accent theme</span>
                <span className="ws-ctrl-desc">
                  Colors links, selection outlines, focus rings, chips, and active
                  accents. Blue is the default.
                </span>
              </div>
              <div className="ws-ctrl-action">
                <div className="settings-swatches" role="group" aria-label="Accent theme">
                  {ACCENT_THEMES.map((a) => (
                    <button
                      key={a.value}
                      type="button"
                      className={`settings-swatch${appearance.accent === a.value ? ' settings-swatch--active' : ''}`}
                      style={{ '--swatch': a.swatch }}
                      title={a.label}
                      aria-label={`${a.label} accent${appearance.accent === a.value ? ' (active)' : ''}`}
                      aria-pressed={appearance.accent === a.value}
                      onClick={() => updateAppearance({ accent: a.value })}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="ws-ctrl-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Background motion</span>
                <span className="ws-ctrl-desc">
                  Drift of the node-edge network in the header and loading screen.
                  Off draws a static frame. Reduced-motion OS settings always win.
                </span>
              </div>
              <div className="ws-ctrl-action">
                <div className="settings-seg" role="group" aria-label="Background motion">
                  {MOTION_LEVELS.map((l) => (
                    <button
                      key={l.value}
                      type="button"
                      className={`settings-seg-btn${appearance.motion === l.value ? ' settings-seg-btn--active' : ''}`}
                      aria-pressed={appearance.motion === l.value}
                      onClick={() => updateAppearance({ motion: l.value })}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
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
                <span className="ws-ctrl-label">Quick Jump</span>
                <span className="ws-ctrl-desc">
                  Use Shift+number shortcuts and the Jump button to navigate the grid.
                  No selection: Shift+digits jumps to that row. With a cell selected:
                  Shift+digits jumps to that date column in the current row.
                </span>
              </div>
              <div className="ws-ctrl-action">
                <label className="settings-switch-row settings-switch-row--inline">
                  <input
                    type="checkbox"
                    className="settings-switch-input"
                    checked={quickJumpEnabled}
                    onChange={handleQuickJumpToggle}
                  />
                  <span className="settings-switch"><span className="settings-switch-thumb" /></span>
                  <span className="settings-switch-label">{quickJumpEnabled ? 'Enabled' : 'Disabled'}</span>
                </label>
              </div>
            </div>
            <div className="ws-ctrl-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Column widths</span>
                <span className="ws-ctrl-desc">
                  Drag column edges to resize. Widths are saved in browser storage per device.
                  {colResetMsg && (
                    <span className="settings-saved" style={{ display: 'block', marginTop: '4px' }}>
                      Widths cleared. Switch to the Tasks sheet to see the updated layout.
                    </span>
                  )}
                </span>
              </div>
              <div className="ws-ctrl-action">
                <button className="button-secondary" onClick={handleResetColumns}>
                  Reset grid column widths
                </button>
              </div>
            </div>
          </div>

          {/* 04 Dashboard */}
          <div className="ws-frame">
            <div className="ws-frame-header">
              <span className="ws-frame-kicker">04</span>
              <span>Dashboard</span>
              <span className="ws-frame-header-sub">show/hide panels · browser storage · no task data changed</span>
            </div>

            <div className="ws-settings-group">Dashboard sections</div>
            <div className="settings-toggle-grid">
              {DASHBOARD_SECTIONS.map((s) => (
                <label key={s.key} className="settings-switch-row">
                  <input
                    type="checkbox"
                    className="settings-switch-input"
                    checked={!dashHidden(s.key)}
                    onChange={() => handleDashToggleSection(s.key)}
                  />
                  <span className="settings-switch"><span className="settings-switch-thumb" /></span>
                  <span className="settings-switch-label">{s.label}</span>
                </label>
              ))}
            </div>

            <div className="ws-settings-group">Pressure diagnostics cards</div>
            <div className="settings-toggle-grid">
              {DASHBOARD_CARDS.map((c) => (
                <label key={c.key} className="settings-switch-row">
                  <input
                    type="checkbox"
                    className="settings-switch-input"
                    checked={!dashCardHidden(c.key)}
                    onChange={() => handleDashToggleCard(c.key)}
                  />
                  <span className="settings-switch"><span className="settings-switch-thumb" /></span>
                  <span className="settings-switch-label">{c.label}</span>
                </label>
              ))}
            </div>

            <div className="ws-settings-group">Recommendation dismissals</div>
            <div className="ws-ctrl-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Reset display &amp; dismissals</span>
                <span className="ws-ctrl-desc">
                  Dashboard-only preferences — hidden from Dashboard, does not edit any task.
                  Changes apply next time you open the Dashboard.
                </span>
              </div>
              <div className="ws-ctrl-action settings-dash-reset">
                <button className="button-secondary" onClick={handleDashResetVisibility}>Show all sections</button>
                <button className="button-secondary" onClick={handleDashResetDismissals} disabled={!dashHasDismissals(dashPrefs)}>
                  Reset dismissed suggestions
                </button>
              </div>
            </div>
          </div>

        </div>{/* end left column */}

        {/* ══ Right column ══ */}
        <div className="ws-settings-col">

          {/* 05 Data & Backup */}
          <div className="ws-frame">
            <div className="ws-frame-header">
              <span className="ws-frame-kicker">05</span>
              <span>Data &amp; backup</span>
              <span className="ws-frame-header-sub">export before bulk changes or imports</span>
            </div>

            {/* Primary export action */}
            <div className="ws-backup-primary">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Export full backup</span>
                <span className="ws-ctrl-desc">
                  One JSON file with all tasks, completions, statuses, notes, cell notes,
                  reading books and checkpoints, and archive snapshots. Use it before bulk
                  edits or imports — and to move your workspace to another device. Store the
                  file somewhere safe; it is your data.
                </span>
              </div>
              <button className="button-secondary ws-backup-btn" onClick={() => downloadExportBackup()}>
                Download JSON
              </button>
            </div>

            {/* Restore from backup (P9.0) — explicit confirm before overwrite */}
            <div className="ws-ctrl-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Restore from backup</span>
                <span className="ws-ctrl-desc">
                  Load a backup JSON exported above — for device transfer, restore it on the
                  new device. <strong>Restoring replaces all current tasks, completions,
                  reading data, notes, and archives</strong> with the backup&rsquo;s contents.
                  A safety copy of the current database is saved automatically first.
                </span>
              </div>
              <div className="ws-ctrl-action">
                <input
                  ref={restoreInputRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={handleRestoreFilePicked}
                />
                <button
                  className="button-secondary"
                  onClick={() => restoreInputRef.current?.click()}
                  disabled={restoreBusy}
                >
                  Choose backup file…
                </button>
              </div>
            </div>

            {restoreFile && (
              <div className="ws-restore-confirm" role="alertdialog" aria-label="Confirm restore">
                <div className="ws-restore-confirm-copy">
                  Restore <strong>{restoreFile.name}</strong>? This <strong>overwrites your
                  current workspace</strong> — every task, completion, reading book, note, and
                  archive is replaced by the backup&rsquo;s contents. A pre-restore safety copy
                  of the current database is written first. Keep the backup file until you have
                  verified the result.
                </div>
                <div className="ws-restore-confirm-actions">
                  <button className="button-secondary" onClick={cancelRestore} disabled={restoreBusy}>
                    Cancel
                  </button>
                  <button className="ws-restore-danger-btn" onClick={confirmRestore} disabled={restoreBusy}>
                    {restoreBusy ? 'Restoring…' : 'Restore & overwrite'}
                  </button>
                </div>
              </div>
            )}

            {restoreError && (
              <div className="ws-restore-msg ws-restore-msg--error" role="alert">
                Restore failed: {restoreError} Your current data was not replaced.
              </div>
            )}
            {restoreResult && (
              <div className="ws-restore-msg ws-restore-msg--ok" role="status">
                Restore complete — {restoreResult.tasks} tasks, {restoreResult.completions} completions,{' '}
                {restoreResult.reading_books} reading books, {restoreResult.archive_snapshots} archives
                restored. Switch to the Tasks sheet to load the restored data.
              </div>
            )}

            <div className="ws-ctrl-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Storage location</span>
                <span className="ws-ctrl-desc">
                  All task data lives in <code>taskos.db</code> — a local SQLite file (project
                  root in development, app-data directory in the packaged app; overridable with
                  the <code>TASKOS_DB_PATH</code> environment variable). Gitignored, never
                  committed. UI preferences (theme, column widths, dashboard toggles, shortcuts)
                  stay in this browser&rsquo;s localStorage and are <em>not</em> included in
                  backups — they do not transfer between devices.
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
              <span className="ws-frame-kicker">06</span>
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
              <span className="ws-frame-kicker">07</span>
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

          {/* 08 About & Policies */}
          <div className="ws-frame">
            <div className="ws-frame-header">
              <span className="ws-frame-kicker">08</span>
              <span>About &amp; Policies</span>
            </div>
            <div className="ws-frame-body settings-prose">
              <p>
                <strong>TaskManager</strong> is a local-first task, reading, and pressure
                tracker. FastAPI backend, SQLite storage, React/Vite frontend. Built as a
                personal productivity instrument.
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
                <DocSection name="privacy"       label="Privacy Policy" />
                <DocSection name="accessibility" label="Accessibility Statement" />
                <DocSection name="terms"         label="Terms / Disclaimer" />
              </div>
            </div>
          </div>

        </div>{/* end right column */}
      </div>{/* end layout */}

    </div>
  );
}
