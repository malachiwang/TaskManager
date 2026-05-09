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
