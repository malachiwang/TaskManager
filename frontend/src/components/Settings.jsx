import { useState, useMemo, useEffect, useRef } from 'react';
import { downloadExportBackup, downloadExportSheet, restoreBackup, fetchDoc } from '../api.js';
import CsvImport from './CsvImport.jsx';
import {
  KEYBINDS, KB_GROUP_ORDER, FIXED_SHORTCUTS, FIXED_REASON_LABELS,
  loadKbOverrides, writeKbOverrides, buildResolvedFromOverrides,
  isReservedBinding, findBindingConflict, captureEventToBinding,
  bindingLabel, bindingSignature, normalizeBinding,
} from '../keybinds.js';
import {
  loadAppearance, saveAppearance,
  APPEARANCE_MODES, ACCENT_THEMES, MOTION_LEVELS, VISUAL_THEMES,
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

// Collapsible reference block (P10.1 Settings IA) — documentation-style
// content stays findable but out of the way. Settings itself shows controls;
// explanations live behind these disclosures.
function RefSection({ label, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ws-doc-section">
      <button type="button" className="ws-doc-toggle" onClick={() => setOpen((v) => !v)}>
        {label} {open ? '▴' : '▾'}
      </button>
      {open && <div className="ws-ref-body">{children}</div>}
    </div>
  );
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

export default function Settings({ sheetMonth = null }) {
  // Export (tm-clean 04): JSON = full backup; CSV = the grid's month.
  const month = sheetMonth ?? { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
  const sheetMonthLabel = new Date(month.year, month.month - 1, 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const [exportFormat, setExportFormat] = useState('json');
  const [exportError, setExportError]   = useState('');
  async function handleExport() {
    setExportError('');
    try {
      if (exportFormat === 'json') {
        await downloadExportBackup();
      } else {
        const prefix = `${month.year}-${String(month.month).padStart(2, '0')}`;
        const lastDay = new Date(month.year, month.month, 0).getDate();
        await downloadExportSheet(`${prefix}-01`, `${prefix}-${String(lastDay).padStart(2, '0')}`);
      }
    } catch (e) {
      setExportError(e?.message || 'Export failed.');
    }
  }
  // Appearance mode / visual theme / accent / motion (P10.0–P10.1) —
  // applied live, saved in localStorage (taskos-appearance).
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

      // Block everything else from triggering browser shortcuts while recording.
      e.preventDefault();
      e.stopPropagation();

      const binding = captureEventToBinding(e);
      if (!binding) return;

      // Every key can be bound (tm-clean 13); only modifier-only/unidentified
      // events are ignored. Conflicts are still rejected below.
      if (isReservedBinding(binding)) return;

      const conflict = findBindingConflict(binding, recordingAction, resolvedKb);
      if (conflict) {
        const where = KEYBINDS[conflict].group;
        setRecordingError(`Already used for "${KEYBINDS[conflict].description}" (${where}) — pick another key or reset that shortcut first`);
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

    // Capture phase: the recorder sees Tab, Enter, Esc… before anything else.
    window.addEventListener('keydown', captureKey, true);
    return () => window.removeEventListener('keydown', captureKey, true);
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
    // The default may since have been given to another action.
    const conflict = findBindingConflict(KEYBINDS[action], action, resolvedKb);
    if (conflict) {
      setRecordingAction(action);
      setRecordingError(`Default conflicts with "${KEYBINDS[conflict].description}". Change that binding or reset all shortcuts.`);
      return;
    }
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

  const themeLabel = VISUAL_THEMES.find((t) => t.value === appearance.theme)?.label ?? 'Classic Sheet';

  return (
    <div className="ws-settings">

      {/* ── Hero ── */}
      <div className="ws-page-header">
        <span>Settings</span>
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
            <div className="ws-ctrl-row ws-ctrl-row--stack">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Visual theme</span>
              </div>
              <div className="settings-theme-grid" role="group" aria-label="Visual theme">
                {VISUAL_THEMES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    className={`settings-theme-card${appearance.theme === t.value ? ' settings-theme-card--active' : ''}`}
                    aria-pressed={appearance.theme === t.value}
                    onClick={() => updateAppearance({ theme: t.value })}
                  >
                    <span className="settings-theme-preview" aria-hidden="true">
                      {t.swatch.map((c, i) => (
                        <span key={i} style={{ background: c }} />
                      ))}
                    </span>
                    <span className="settings-theme-name">
                      {t.label}
                      {t.darkBase ? ' · dark' : ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="ws-ctrl-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Appearance</span>
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
            </div>
            <form onSubmit={handleSaveDefaults}>
              <div className="ws-ctrl-row">
                <div className="ws-ctrl-info">
                  <span className="ws-ctrl-label">Default section</span>
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
            </div>
            <div className="ws-ctrl-row">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Quick Jump</span>
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
                  {colResetMsg && (
                    <span className="settings-saved" style={{ display: 'block', marginTop: '4px' }}>
                      Widths cleared. Switch to the Grid to see the updated layout.
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
            </div>

            {/* Export (JSON full backup or CSV of the grid's month), with
                Restore beside it. Restore still confirms before overwriting. */}
            <div className="ws-backup-primary">
              <div className="ws-ctrl-info">
                <span className="ws-ctrl-label">Export</span>
                <span className="ws-ctrl-desc">
                  JSON is a full backup. CSV covers {sheetMonthLabel}.
                </span>
              </div>
              <div className="ws-ctrl-action">
                <div className="settings-seg" role="group" aria-label="Export format">
                  {['json', 'csv'].map((f) => (
                    <button
                      key={f}
                      type="button"
                      className={`settings-seg-btn${exportFormat === f ? ' settings-seg-btn--active' : ''}`}
                      aria-pressed={exportFormat === f}
                      onClick={() => setExportFormat(f)}
                    >
                      {f.toUpperCase()}
                    </button>
                  ))}
                </div>
                <button className="button-secondary ws-backup-btn" onClick={handleExport}>
                  Export
                </button>
                <input
                  ref={restoreInputRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={handleRestoreFilePicked}
                />
                <button
                  className="button-secondary ws-backup-btn"
                  onClick={() => restoreInputRef.current?.click()}
                  disabled={restoreBusy}
                >
                  Restore…
                </button>
              </div>
            </div>
            {exportError && (
              <div className="ws-restore-msg ws-restore-msg--error" role="alert">
                Export failed: {exportError}
              </div>
            )}

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
          </div>

          <CsvImport />

          {/* 05 Keyboard Shortcuts */}
          <div className="ws-frame">
            <div className="ws-frame-header">
              <span className="ws-frame-kicker">06</span>
              <span>Keyboard shortcuts</span>
            </div>
            {kbGroups.map(({ group, actions }) => (
              <div key={group}>
                <div className="ws-settings-group">{group}</div>
                {actions.map(([action, binding]) => {
                  const isRecording = recordingAction === action;
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
                  const isChanged = action in kbOverrides;
                  return (
                    <div key={action} className="ws-kbd-shortcut-row">
                      <kbd className="ws-kbd-key">{bindingLabel(resolvedKb[action])}</kbd>
                      <span className="ws-kbd-shortcut-desc">
                        {binding.description}
                        {isChanged && (
                          <span className="ws-kbd-default-hint"> · default {bindingLabel(binding)}</span>
                        )}
                      </span>
                      <button className="ws-kbd-action-btn" onClick={() => startRecording(action)}>Change</button>
                      {isChanged && (
                        <button className="ws-kbd-action-btn ws-kbd-action-btn--reset" onClick={() => resetOverride(action)}>Reset</button>
                      )}
                    </div>
                  );
                })}
                {FIXED_SHORTCUTS.filter((s) => s.group === group).map((s) => (
                  <div key={s.keys + s.description} className="ws-kbd-shortcut-row">
                    <kbd className="ws-kbd-key">{s.keys}</kbd>
                    <span className="ws-kbd-shortcut-desc">{s.description}</span>
                    <span className="ws-state-badge ws-state-badge--dim">
                      fixed · {FIXED_REASON_LABELS[s.reason] || 'fixed'}
                    </span>
                  </div>
                ))}
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

          {/* 07 Technical reference — documentation, collapsed by default
              (P10.1 Settings IA: controls up front, explanations on demand). */}
          <div className="ws-frame">
            <div className="ws-frame-header">
              <span className="ws-frame-kicker">07</span>
              <span>Technical reference</span>
            </div>
            <div className="ws-frame-body">
              <RefSection label="Urgency formula">
                <pre className="settings-pre">{`urgency = 10 × (floor + (1 − floor) × growth)

base   = f(priority)        floor  = base / 2
growth = 1 − exp(−k × D/I)  k = 2.0

D = days_since   I = interval_days`}</pre>
              </RefSection>
            </div>
          </div>

          {/* 08 About & Policies */}
          <div className="ws-frame">
            <div className="ws-frame-header">
              <span className="ws-frame-kicker">08</span>
              <span>About &amp; Policies</span>
            </div>
            <div className="ws-frame-body settings-prose">
              {/* Build identity (P17 §5) — the one place to check whether a
                  packaged app is stale relative to the source tree. */}
              <p style={{ marginTop: '8px', fontVariantNumeric: 'tabular-nums' }}>
                Build: <code>{typeof __BUILD_INFO__ !== 'undefined' ? __BUILD_INFO__.commit : 'dev'}</code>
                {typeof __BUILD_INFO__ !== 'undefined' ? ` · built ${__BUILD_INFO__.date}` : ''}
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
