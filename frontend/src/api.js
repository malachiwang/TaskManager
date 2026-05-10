const BASE = '/api';

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

// Export URL builders — used as href/window.open targets, not fetch calls.
export function buildExportSheetUrl(startDate, endDate) {
  return `${BASE}/export/sheet.csv?start=${startDate}&end=${endDate}`;
}

export function buildExportBackupUrl() {
  return `${BASE}/export/backup.json`;
}

export async function setCompletionCount(taskId, date, count) {
  const res = await fetch(
    `${BASE}/completions/${taskId}/${date}?count=${count}`,
    { method: 'PATCH' },
  );
  if (!res.ok) throw new Error(`setCompletionCount failed: ${res.status}`);
  return res.json();
}

export async function previewImport(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${BASE}/import/preview`, { method: 'POST', body: formData });
  if (!res.ok) throw new Error(`previewImport failed: ${res.status}`);
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
