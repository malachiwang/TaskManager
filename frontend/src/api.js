const BASE = import.meta.env.VITE_API_BASE ?? '/api';

export async function fetchDoc(name) {
  const res = await fetch(`${BASE}/docs/${name}`);
  if (!res.ok) throw new Error(`fetchDoc failed: ${res.status}`);
  return res.text();
}

export async function fetchTasks() {
  const res = await fetch(`${BASE}/tasks`);
  if (!res.ok) throw new Error(`fetchTasks failed: ${res.status}`);
  return res.json();
}

export async function fetchCompletions(start, end) {
  const res = await fetch(`${BASE}/completions?start=${start}&end=${end}`);
  if (!res.ok) throw new Error(`fetchCompletions failed: ${res.status}`);
  return res.json();
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
  const res = await fetch(`${BASE}/notes?start=${start}&end=${end}`);
  if (!res.ok) throw new Error(`fetchNotes failed: ${res.status}`);
  return res.json();
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
  const res = await fetch(`${BASE}/reading/books`);
  if (!res.ok) throw new Error(`fetchReadingBooks failed: ${res.status}`);
  return res.json();
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
  const res = await fetch(`${BASE}/reading/books/${bookId}/entries`);
  if (!res.ok) throw new Error(`fetchReadingEntries failed: ${res.status}`);
  return res.json();
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
