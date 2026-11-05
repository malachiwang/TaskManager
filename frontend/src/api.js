const BASE = import.meta.env.VITE_API_BASE ?? '/api';

// ---------------------------------------------------------------------------
// Bounded requests
//
// Native fetch() has no timeout. A backend that accepts the TCP connection but
// never sends a response leaves the promise permanently *pending* — it never
// resolves and never rejects. Any loading gate awaiting such a request (the App
// boot probe, TaskGrid's Promise.all, ReadingSheet's load) then sits on
// "Loading…" forever, because even `.finally()` never runs.
//
// requestWithTimeout puts a hard deadline on the whole exchange — connect,
// headers, and body read — via AbortController, and reports the stall as a
// labelled RequestTimeoutError so UI error states can name the endpoint that
// hung. Timeouts are deliberately distinguishable from ordinary HTTP errors,
// which keep their original `<fnName> failed: <status>` text.
//
// This is applied to the reads that gate a full screen or sheet on startup.
// It is *not* applied blanket-wide: downloads, restores and imports can take
// legitimately much longer and are left alone.
// ---------------------------------------------------------------------------

// Per-attempt cap for the boot readiness probe. Short because App.jsx retries.
export const HEALTH_TIMEOUT_MS = 1500;
// Cap for the initial data reads behind a loading gate.
export const READ_TIMEOUT_MS = 8000;

function formatTimeout(ms) {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

export class RequestTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} timed out after ${formatTimeout(timeoutMs)}`);
    this.name = 'RequestTimeoutError';
    this.isTimeout = true;
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

// `label` names the request in user-facing text ("Hiatus history request").
// `failureName` keeps the pre-existing message for non-2xx responses.
// Nothing user-specific (paths, task names, DB contents) goes into either.
async function requestWithTimeout(url, options, { timeoutMs, label, failureName }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`${failureName} failed: ${res.status}`);
    // Parsed inside the deadline: a response whose body never finishes
    // streaming would otherwise hang here instead.
    return await res.json();
  } catch (err) {
    if (timedOut) {
      console.warn(`[TaskManager API] ${label} timed out after ${timeoutMs}ms`);
      throw new RequestTimeoutError(label, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Cheap readiness probe — used by the App boot gate. Hits the backend /health
// endpoint (no DB work) instead of a heavy data endpoint.
export async function fetchHealth() {
  return requestWithTimeout(`${BASE}/health`, undefined, {
    timeoutMs: HEALTH_TIMEOUT_MS,
    label: 'Backend health check',
    failureName: 'fetchHealth',
  });
}

export async function fetchDoc(name) {
  const res = await fetch(`${BASE}/docs/${name}`);
  if (!res.ok) throw new Error(`fetchDoc failed: ${res.status}`);
  return res.text();
}

export async function fetchTasks() {
  return requestWithTimeout(`${BASE}/tasks`, undefined, {
    timeoutMs: READ_TIMEOUT_MS,
    label: 'Tasks request',
    failureName: 'fetchTasks',
  });
}

export async function fetchCompletions(start, end) {
  return requestWithTimeout(`${BASE}/completions?start=${start}&end=${end}`, undefined, {
    timeoutMs: READ_TIMEOUT_MS,
    label: 'Completions request',
    failureName: 'fetchCompletions',
  });
}

export async function upsertCompletion(taskId, date) {
  const res = await fetch(
    `${BASE}/completions?task_id=${taskId}&completion_date=${date}`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`upsertCompletion failed: ${res.status}`);
  return res.json();
}

export async function deleteCompletion(taskId, date) {
  const res = await fetch(`${BASE}/completions/${taskId}/${date}`, {
    method: 'DELETE',
  });
  // 404 means the cell was already empty — that is fine
  if (!res.ok && res.status !== 404) {
    throw new Error(`deleteCompletion failed: ${res.status}`);
  }
}

// Build a query string from a fields object, skipping null/undefined values.
function toParams(fields) {
  const p = new URLSearchParams();
  for (const [key, val] of Object.entries(fields)) {
    if (val !== null && val !== undefined) {
      p.append(key, String(val));
    }
  }
  return p.toString();
}

export async function createTask(fields) {
  const res = await fetch(`${BASE}/tasks?${toParams(fields)}`, { method: 'POST' });
  if (!res.ok) throw new Error(`createTask failed: ${res.status}`);
  return res.json();
}

export async function updateTask(id, fields) {
  const res = await fetch(`${BASE}/tasks/${id}?${toParams(fields)}`, { method: 'PATCH' });
  if (!res.ok) throw new Error(`updateTask failed: ${res.status}`);
  return res.json();
}

export async function fetchDashboard() {
  const res = await fetch(`${BASE}/dashboard`);
  if (!res.ok) throw new Error(`fetchDashboard failed: ${res.status}`);
  return res.json();
}

export async function fetchSnapshotPressure(days = 30) {
  const res = await fetch(`${BASE}/snapshots/pressure?days=${days}`);
  if (!res.ok) throw new Error(`fetchSnapshotPressure failed: ${res.status}`);
  return res.json();
}

export async function deleteTask(id) {
  const res = await fetch(`${BASE}/tasks/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteTask failed: ${res.status}`);
  return res.json();
}

// Custom banner image (tm-clean 25) — stored next to the database.
export async function uploadBannerImage(file) {
  const body = new FormData();
  body.append('file', file);
  const res = await fetch(`${BASE}/banner-image`, { method: 'POST', body });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).detail; } catch { /* not JSON */ }
    throw new Error(detail || `Upload failed (${res.status}).`);
  }
  return (await res.json()).filename;
}

export async function deleteBannerImage() {
  const res = await fetch(`${BASE}/banner-image`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteBannerImage failed: ${res.status}`);
}

export function bannerImageUrl(filename) {
  return `${BASE}/banner-image/${encodeURIComponent(filename)}`;
}

// Workspace search (tm-clean 11).
export async function searchWorkspace(q, signal) {
  const res = await fetch(`${BASE}/search/workspace?q=${encodeURIComponent(q)}`, { signal });
  if (!res.ok) throw new Error(`searchWorkspace failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Export downloads — fetch → blob → programmatic click.
// Direct anchor navigation (href + download) is not honored in Tauri's
// WKWebView, which renders the response inline instead of downloading.
// ---------------------------------------------------------------------------

function buildExportSheetUrl(startDate, endDate) {
  return `${BASE}/export/sheet.csv?start=${startDate}&end=${endDate}`;
}

function buildExportBackupUrl() {
  return `${BASE}/export/backup.json`;
}

async function downloadBlob(url, fallbackFilename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  // Prefer the filename the backend sends in Content-Disposition.
  const cd = res.headers.get('Content-Disposition');
  const match = cd?.match(/filename="([^"]+)"/);
  const filename = match?.[1] ?? fallbackFilename;

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export async function downloadExportBackup() {
  await downloadBlob(buildExportBackupUrl(), 'taskos-backup.json');
}

// Restore the full workspace from a JSON backup produced by the export above.
// Replaces ALL local data (the backend writes a pre-restore safety .db first).
export async function restoreBackup(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${BASE}/restore/backup.json`, { method: 'POST', body: formData });
  if (!res.ok) {
    let detail = `restoreBackup failed: ${res.status}`;
    try { const b = await res.json(); if (b.detail) detail = b.detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

export async function downloadExportSheet(startDate, endDate) {
  await downloadBlob(buildExportSheetUrl(startDate, endDate), 'taskos-sheet.csv');
}

export async function setCompletionCount(taskId, date, count) {
  const res = await fetch(
    `${BASE}/completions/${taskId}/${date}?count=${count}`,
    { method: 'PATCH' },
  );
  if (!res.ok) throw new Error(`setCompletionCount failed: ${res.status}`);
  return res.json();
}

export async function fetchNotes(start, end) {
  return requestWithTimeout(`${BASE}/notes?start=${start}&end=${end}`, undefined, {
    timeoutMs: READ_TIMEOUT_MS,
    label: 'Notes request',
    failureName: 'fetchNotes',
  });
}

export async function upsertNote(taskId, date, note) {
  const params = new URLSearchParams({ note });
  const res = await fetch(`${BASE}/notes/${taskId}/${date}?${params}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`upsertNote failed: ${res.status}`);
  return res.json();
}

export async function deleteNote(taskId, date) {
  const res = await fetch(`${BASE}/notes/${taskId}/${date}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`deleteNote failed: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Date-cell text overrides (P9.1) — convert a task/date cell to a text cell.
// ---------------------------------------------------------------------------

export async function fetchDateCellOverrides(start, end) {
  return requestWithTimeout(`${BASE}/date-cell-overrides?start=${start}&end=${end}`, undefined, {
    timeoutMs: READ_TIMEOUT_MS,
    label: 'Cell text overrides request',
    failureName: 'fetchDateCellOverrides',
  });
}

export async function upsertDateCellOverride(taskId, date, text) {
  const params = new URLSearchParams({ text });
  const res = await fetch(`${BASE}/date-cell-overrides/${taskId}/${date}?${params}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`upsertDateCellOverride failed: ${res.status}`);
  return res.json();
}

export async function deleteDateCellOverride(taskId, date) {
  const res = await fetch(`${BASE}/date-cell-overrides/${taskId}/${date}`, { method: 'DELETE' });
  // 404 means the cell was already in checkbox mode — that is fine
  if (!res.ok && res.status !== 404) {
    throw new Error(`deleteDateCellOverride failed: ${res.status}`);
  }
}

// Batch upsert text overrides for many task/date cells (range delete → text).
// items: [{ task_id, date, text }]
export async function batchUpsertDateCellOverrides(items) {
  const res = await fetch(`${BASE}/date-cell-overrides/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error(`batchUpsertDateCellOverrides failed: ${res.status}`);
  return res.json();
}

// Batch delete overrides for many task/date cells (range restore checkboxes).
// items: [{ task_id, date }]
export async function batchDeleteDateCellOverrides(items) {
  const res = await fetch(`${BASE}/date-cell-overrides/batch-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error(`batchDeleteDateCellOverrides failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Task hiatus periods (P11.0) — persisted intervals behind DateCell blanking.
// ---------------------------------------------------------------------------

// Intervals overlapping [start, end] — used for grid range rendering.
export async function fetchHiatusPeriodsInRange(start, end) {
  return requestWithTimeout(`${BASE}/task-hiatus-periods?start=${start}&end=${end}`, undefined, {
    timeoutMs: READ_TIMEOUT_MS,
    label: 'Hiatus history request',
    failureName: 'fetchHiatusPeriodsInRange',
  });
}

// All intervals for one task — used by the Task Details hiatus history list.
export async function fetchHiatusPeriodsForTask(taskId) {
  const res = await fetch(`${BASE}/task-hiatus-periods?task_id=${taskId}`);
  if (!res.ok) throw new Error(`fetchHiatusPeriodsForTask failed: ${res.status}`);
  return res.json();
}

// Edit one interval's dates (P11.2). fields: { start_date, end_date } — ISO
// strings; end_date '' clears the interval back to open. Backend validation
// failures (inverted range, overlap, duplicate open) surface their detail
// message so the modal can show it next to the editor.
export async function updateHiatusPeriod(periodId, fields) {
  const res = await fetch(`${BASE}/task-hiatus-periods/${periodId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    let detail = `updateHiatusPeriod failed: ${res.status}`;
    try { const b = await res.json(); if (b.detail) detail = b.detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

export async function deleteHiatusPeriod(id) {
  const res = await fetch(`${BASE}/task-hiatus-periods/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteHiatusPeriod failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Calendar (P12.0) — task sessions + depth windows.
// Sessions are scheduled time allocations toward canonical task records; the
// Calendar view renders and mutates them. Times are local-naive
// "YYYY-MM-DDTHH:MM" strings throughout.
// ---------------------------------------------------------------------------

// Sessions overlapping [start, end] (ISO dates), joined with task info.
export async function fetchSessions(start, end) {
  return requestWithTimeout(`${BASE}/sessions?start=${start}&end=${end}`, undefined, {
    timeoutMs: READ_TIMEOUT_MS,
    label: 'Sessions request',
    failureName: 'fetchSessions',
  });
}

// fields: { task_id, planned_start, planned_end, is_fixed? }
export async function createSession(fields) {
  const res = await fetch(`${BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    let detail = `createSession failed: ${res.status}`;
    try { const b = await res.json(); if (b.detail) detail = b.detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

// fields: any of { planned_start, planned_end, status, is_fixed,
// actual_start, actual_end, actual_minutes }
export async function updateSession(id, fields) {
  const res = await fetch(`${BASE}/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    let detail = `updateSession failed: ${res.status}`;
    try { const b = await res.json(); if (b.detail) detail = b.detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

// scope (recurring occurrences only): 'occurrence' (default — removes this
// one and records a skip so it never regenerates), 'following', or 'all'.
export async function deleteSession(id, scope = 'occurrence') {
  const res = await fetch(`${BASE}/sessions/${id}?scope=${scope}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteSession failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Calendar recurrence series — recurring scheduled sessions/entries.
// Never creates or duplicates canonical tasks.
// ---------------------------------------------------------------------------

export async function fetchRecurrenceSeries() {
  const res = await fetch(`${BASE}/recurrence-series`);
  if (!res.ok) throw new Error(`fetchRecurrenceSeries failed: ${res.status}`);
  return res.json();
}

// fields: { from_session_id } adopts an existing block as the anchor (the
// one-click "Repeat weekly" path — omitted rule fields default from the
// block); optional weekdays, interval_weeks, until_date, count.
export async function createRecurrenceSeries(fields) {
  const res = await fetch(`${BASE}/recurrence-series`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    let detail = `createRecurrenceSeries failed: ${res.status}`;
    try { const b = await res.json(); if (b.detail) detail = b.detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

// fields: { scope: 'all'|'following', from_date?, weekdays?, interval_weeks?,
// start_minutes?, duration_minutes?, until_date?, count?, is_fixed?, ... }
export async function updateRecurrenceSeries(id, fields) {
  const res = await fetch(`${BASE}/recurrence-series/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    let detail = `updateRecurrenceSeries failed: ${res.status}`;
    try { const b = await res.json(); if (b.detail) detail = b.detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

// fromDate: stop the series starting that day (history stays); omitted =
// remove the whole series (executed occurrences survive as plain history).
export async function deleteRecurrenceSeries(id, fromDate = null) {
  const url = fromDate
    ? `${BASE}/recurrence-series/${id}?from_date=${fromDate}`
    : `${BASE}/recurrence-series/${id}`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteRecurrenceSeries failed: ${res.status}`);
  return res.json();
}

// All depth windows (one-off + recurring); the frontend expands recurring
// windows onto concrete dates.
export async function fetchDepthWindows() {
  return requestWithTimeout(`${BASE}/depth-windows`, undefined, {
    timeoutMs: READ_TIMEOUT_MS,
    label: 'Depth windows request',
    failureName: 'fetchDepthWindows',
  });
}

// fields: { depth, start_minutes, end_minutes, date? | weekday?, protected? }
export async function createDepthWindow(fields) {
  const res = await fetch(`${BASE}/depth-windows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    let detail = `createDepthWindow failed: ${res.status}`;
    try { const b = await res.json(); if (b.detail) detail = b.detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

// Exempt one date from a recurring window ("remove just this day", P13.0).
export async function skipDepthWindowDay(id, date) {
  const res = await fetch(`${BASE}/depth-windows/${id}/skips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }),
  });
  if (!res.ok) throw new Error(`skipDepthWindowDay failed: ${res.status}`);
  return res.json();
}

export async function updateDepthWindow(id, fields) {
  const res = await fetch(`${BASE}/depth-windows/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`updateDepthWindow failed: ${res.status}`);
  return res.json();
}

export async function deleteDepthWindow(id) {
  const res = await fetch(`${BASE}/depth-windows/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteDepthWindow failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// External calendars (P15.0) — read-only ICS commitments. Failures here are
// isolated by callers; nothing else depends on these requests.
// ---------------------------------------------------------------------------

export async function fetchExternalCalendars() {
  const res = await fetch(`${BASE}/external-calendars`);
  if (!res.ok) throw new Error(`fetchExternalCalendars failed: ${res.status}`);
  return res.json();
}

export async function createExternalCalendar(name, url) {
  const res = await fetch(`${BASE}/external-calendars`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url }),
  });
  if (!res.ok) {
    let detail = `createExternalCalendar failed: ${res.status}`;
    try { const b = await res.json(); if (b.detail) detail = b.detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

export async function updateExternalCalendar(id, fields) {
  const res = await fetch(`${BASE}/external-calendars/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`updateExternalCalendar failed: ${res.status}`);
  return res.json();
}

export async function deleteExternalCalendar(id) {
  const res = await fetch(`${BASE}/external-calendars/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteExternalCalendar failed: ${res.status}`);
  return res.json();
}

export async function syncExternalCalendar(id) {
  const res = await fetch(`${BASE}/external-calendars/${id}/sync`, { method: 'POST' });
  if (!res.ok) {
    let detail = `syncExternalCalendar failed: ${res.status}`;
    try { const b = await res.json(); if (b.detail) detail = b.detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

export async function fetchExternalEvents(start, end) {
  const res = await fetch(`${BASE}/external-events?start=${start}&end=${end}`);
  if (!res.ok) throw new Error(`fetchExternalEvents failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Depth window templates (P15.0)
// ---------------------------------------------------------------------------

export async function fetchWindowTemplates() {
  const res = await fetch(`${BASE}/depth-window-templates`);
  if (!res.ok) throw new Error(`fetchWindowTemplates failed: ${res.status}`);
  return res.json();
}

export async function createWindowTemplate(name, items) {
  const res = await fetch(`${BASE}/depth-window-templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, items }),
  });
  if (!res.ok) throw new Error(`createWindowTemplate failed: ${res.status}`);
  return res.json();
}

export async function updateWindowTemplate(id, fields) {
  const res = await fetch(`${BASE}/depth-window-templates/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`updateWindowTemplate failed: ${res.status}`);
  return res.json();
}

export async function deleteWindowTemplate(id) {
  const res = await fetch(`${BASE}/depth-window-templates/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteWindowTemplate failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Contexts + contextual scheduling (P16.0)
// ---------------------------------------------------------------------------

export async function fetchContexts() {
  const res = await fetch(`${BASE}/contexts`);
  if (!res.ok) throw new Error(`fetchContexts failed: ${res.status}`);
  return res.json();
}

// Find-or-create by exact name.
export async function createContext(name) {
  const res = await fetch(`${BASE}/contexts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`createContext failed: ${res.status}`);
  return res.json();
}

export async function renameContext(id, name) {
  const res = await fetch(`${BASE}/contexts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`renameContext failed: ${res.status}`);
  return res.json();
}

export async function deleteContext(id) {
  const res = await fetch(`${BASE}/contexts/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteContext failed: ${res.status}`);
  return res.json();
}

export async function linkEventToContext(contextId, calendarId, uid) {
  const res = await fetch(`${BASE}/context-event-links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context_id: contextId, calendar_id: calendarId, uid }),
  });
  if (!res.ok) throw new Error(`linkEventToContext failed: ${res.status}`);
  return res.json();
}

export async function unlinkEventFromContext(calendarId, uid) {
  const res = await fetch(
    `${BASE}/context-event-links?calendar_id=${calendarId}&uid=${encodeURIComponent(uid)}`,
    { method: 'DELETE' },
  );
  if (!res.ok && res.status !== 404) throw new Error(`unlinkEventFromContext failed: ${res.status}`);
}

export async function fetchTaskEventLinks(params) {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/task-event-links?${q}`);
  if (!res.ok) throw new Error(`fetchTaskEventLinks failed: ${res.status}`);
  return res.json();
}

export async function createTaskEventLink(fields) {
  const res = await fetch(`${BASE}/task-event-links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`createTaskEventLink failed: ${res.status}`);
  return res.json();
}

export async function deleteTaskEventLink(id) {
  const res = await fetch(`${BASE}/task-event-links/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteTaskEventLink failed: ${res.status}`);
  return res.json();
}

export async function updateTaskEventLink(id, fields) {
  const res = await fetch(`${BASE}/task-event-links/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`updateTaskEventLink failed: ${res.status}`);
  return res.json();
}

// Repositioning proposal for sessions related to a moved external event
// (V5.0). Read-only — applying a choice goes through updateSession +
// updateTaskEventLink so nothing ever moves without an explicit user act.
export async function fetchEventMoveProposal(calendarId, uid) {
  const res = await fetch(
    `${BASE}/event-move-proposals?calendar_id=${calendarId}&uid=${encodeURIComponent(uid)}`,
  );
  if (!res.ok) throw new Error(`fetchEventMoveProposal failed: ${res.status}`);
  return res.json();
}

export async function fetchSuggestions() {
  const res = await fetch(`${BASE}/suggestions`);
  if (!res.ok) throw new Error(`fetchSuggestions failed: ${res.status}`);
  return res.json();
}

// Academic importer (V5.3) — candidate pipeline. Importing only parses;
// canonical records appear exclusively through explicit approvals.
export async function academicImport(body) {
  const res = await fetch(`${BASE}/academic/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`academicImport failed: ${res.status}`);
  return res.json();
}

export async function fetchAcademicCandidates(params = {}) {
  const q = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null)),
  ).toString();
  const res = await fetch(`${BASE}/academic/candidates${q ? `?${q}` : ''}`);
  if (!res.ok) throw new Error(`fetchAcademicCandidates failed: ${res.status}`);
  return res.json();
}

export async function updateAcademicCandidate(id, fields) {
  const res = await fetch(`${BASE}/academic/candidates/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`updateAcademicCandidate failed: ${res.status}`);
  return res.json();
}

export async function approveAcademicCandidate(id, body = {}) {
  const res = await fetch(`${BASE}/academic/candidates/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `approveAcademicCandidate failed: ${res.status}`;
    try { detail = (await res.json()).detail ?? detail; } catch { /* keep default */ }
    throw new Error(detail);
  }
  return res.json();
}

export async function rejectAcademicCandidate(id) {
  const res = await fetch(`${BASE}/academic/candidates/${id}/reject`, { method: 'POST' });
  if (!res.ok) throw new Error(`rejectAcademicCandidate failed: ${res.status}`);
  return res.json();
}

export async function bulkAcademicCandidates(body) {
  const res = await fetch(`${BASE}/academic/candidates/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`bulkAcademicCandidates failed: ${res.status}`);
  return res.json();
}

// Execution analytics (V5.4) — read-only facts: planned vs actual, estimate
// accuracy, behavioral patterns, and forward load. No scores.
export async function fetchExecutionReport(start, end, includeEntries = false) {
  const res = await fetch(
    `${BASE}/reports/execution?start=${start}&end=${end}&include_entries=${includeEntries}`,
  );
  if (!res.ok) throw new Error(`fetchExecutionReport failed: ${res.status}`);
  return res.json();
}

export async function fetchEstimateReport() {
  const res = await fetch(`${BASE}/reports/estimates`);
  if (!res.ok) throw new Error(`fetchEstimateReport failed: ${res.status}`);
  return res.json();
}

export async function fetchPatternsReport() {
  const res = await fetch(`${BASE}/reports/patterns`);
  if (!res.ok) throw new Error(`fetchPatternsReport failed: ${res.status}`);
  return res.json();
}

export async function fetchForecast(weeks = 8) {
  const res = await fetch(`${BASE}/forecast?weeks=${weeks}`);
  if (!res.ok) throw new Error(`fetchForecast failed: ${res.status}`);
  return res.json();
}

// Natural-language scheduling (V5.2) — interpretation only; the caller shows
// the parsed proposal for confirmation before anything is created.
export async function parseNaturalLanguage(q) {
  const res = await fetch(`${BASE}/nl/parse?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`parseNaturalLanguage failed: ${res.status}`);
  return res.json();
}

// Calendar search (V5.2) — params: q, types, start, end, context_id, depth,
// status, calendar_id. Read-only.
export async function searchCalendar(params) {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
  const res = await fetch(`${BASE}/search?${new URLSearchParams(clean)}`);
  if (!res.ok) throw new Error(`searchCalendar failed: ${res.status}`);
  return res.json();
}

export async function fetchReminders() {
  const res = await fetch(`${BASE}/reminders`);
  if (!res.ok) throw new Error(`fetchReminders failed: ${res.status}`);
  return res.json();
}

export async function previewImport(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${BASE}/import/preview`, { method: 'POST', body: formData });
  if (!res.ok) throw new Error(`previewImport failed: ${res.status}`);
  return res.json();
}

// sectionUpdates (optional): [{ id, section }] — cross-section drag moves,
// applied by the backend in the same transaction as the ordering write.
export async function reorderTasks(orderedIds, sectionUpdates) {
  const body = { order: orderedIds };
  if (sectionUpdates?.length) body.section_updates = sectionUpdates;
  const res = await fetch(`${BASE}/tasks/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`reorderTasks failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Sections (P12.1) — persisted manual section ordering.
// Section name '' is the blank/"(no section)" group.
// ---------------------------------------------------------------------------

export async function fetchSections() {
  return requestWithTimeout(`${BASE}/sections`, undefined, {
    timeoutMs: READ_TIMEOUT_MS,
    label: 'Sections request',
    failureName: 'fetchSections',
  });
}

export async function reorderSections(orderedNames) {
  const res = await fetch(`${BASE}/sections/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: orderedNames }),
  });
  if (!res.ok) throw new Error(`reorderSections failed: ${res.status}`);
  return res.json();
}

// Remove an EMPTY section from the ordering list (409 if it still has tasks).
export async function deleteSectionOrder(name) {
  const res = await fetch(`${BASE}/sections?name=${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`deleteSectionOrder failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Reading Sheet (P5.0)
// ---------------------------------------------------------------------------

export async function fetchReadingBooks() {
  return requestWithTimeout(`${BASE}/reading/books`, undefined, {
    timeoutMs: READ_TIMEOUT_MS,
    label: 'Reading library request',
    failureName: 'fetchReadingBooks',
  });
}

export async function createReadingBook(fields) {
  const res = await fetch(`${BASE}/reading/books`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    let detail = `createReadingBook failed: ${res.status}`;
    try { const b = await res.json(); if (b.detail) detail = b.detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

export async function updateReadingBook(id, fields) {
  const res = await fetch(`${BASE}/reading/books/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    let detail = `updateReadingBook failed: ${res.status}`;
    try { const b = await res.json(); if (b.detail) detail = b.detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

// Convenience wrappers over updateReadingBook for status changes.
export async function finishReadingBook(id) {
  return updateReadingBook(id, { status: 'finished' });
}

export async function archiveReadingBook(id) {
  return updateReadingBook(id, { status: 'archived' });
}

export async function deleteReadingBook(id) {
  const res = await fetch(`${BASE}/reading/books/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteReadingBook failed: ${res.status}`);
  return res.json();
}

// Log a page checkpoint (current page). Updates current_page + preserves history.
export async function createReadingEntry(bookId, page, opts = {}) {
  const res = await fetch(`${BASE}/reading/books/${bookId}/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page, entry_date: opts.entry_date ?? null, note: opts.note ?? null }),
  });
  if (!res.ok) throw new Error(`createReadingEntry failed: ${res.status}`);
  return res.json();
}

export async function fetchReadingEntries(bookId) {
  return requestWithTimeout(`${BASE}/reading/books/${bookId}/entries`, undefined, {
    timeoutMs: READ_TIMEOUT_MS,
    label: 'Reading history request',
    failureName: 'fetchReadingEntries',
  });
}

export async function reorderReadingBooks(orderedIds) {
  const res = await fetch(`${BASE}/reading/books/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: orderedIds }),
  });
  if (!res.ok) throw new Error(`reorderReadingBooks failed: ${res.status}`);
  return res.json();
}

export async function applyImport(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${BASE}/import/apply`, { method: 'POST', body: formData });
  if (!res.ok) {
    let detail = `applyImport failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body.detail) detail = body.detail;
    } catch {}
    throw new Error(detail);
  }
  return res.json();
}
