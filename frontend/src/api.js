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
