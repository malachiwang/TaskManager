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

export async function fetchArchives() {
  const res = await fetch(`${BASE}/archives`);
  if (!res.ok) throw new Error(`fetchArchives failed: ${res.status}`);
  return res.json();
}

export async function createArchive(name, startDate, endDate) {
  const params = new URLSearchParams({ name, start_date: startDate, end_date: endDate });
  const res = await fetch(`${BASE}/archives?${params}`, { method: 'POST' });
  if (!res.ok) throw new Error(`createArchive failed: ${res.status}`);
  return res.json();
}

export async function fetchArchive(id) {
  const res = await fetch(`${BASE}/archives/${id}`);
  if (!res.ok) throw new Error(`fetchArchive failed: ${res.status}`);
  return res.json();
}

export async function renameArchive(id, name) {
  const params = new URLSearchParams({ name });
  const res = await fetch(`${BASE}/archives/${id}?${params}`, { method: 'PATCH' });
  if (!res.ok) throw new Error(`renameArchive failed: ${res.status}`);
  return res.json();
}

export async function deleteArchive(id) {
  const res = await fetch(`${BASE}/archives/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteArchive failed: ${res.status}`);
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

export async function previewImport(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${BASE}/import/preview`, { method: 'POST', body: formData });
  if (!res.ok) throw new Error(`previewImport failed: ${res.status}`);
  return res.json();
}

export async function reorderTasks(orderedIds) {
  const res = await fetch(`${BASE}/tasks/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: orderedIds }),
  });
  if (!res.ok) throw new Error(`reorderTasks failed: ${res.status}`);
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
