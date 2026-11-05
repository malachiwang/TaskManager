// Month visibility for the Grid (TM Part D).
//
// A task is live in a viewed month when it became relevant on or before the
// month's last day and was not finished before the month's first day.
//   - "Became relevant" is active_from (the FROM column); rows without it fall
//     back to created_at, matching the never-done rule.
//   - "Finished" is end_date. A task finished on the first day is still live.
// Status does not matter: hiatus tasks stay visible (paused rows are shown but
// excluded from urgency), and the repeat interval has no effect.
// A task with any recorded check-in in the month (completion, cell note, or
// text cell) is always shown, so recorded data is never hidden.

function pad(n) { return String(n).padStart(2, '0'); }

export function monthBounds(year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  return { first: `${year}-${pad(month)}-01`, last: `${year}-${pad(month)}-${pad(lastDay)}` };
}

export function relevantFrom(task) {
  const value = task.active_from || task.created_at || '';
  return value ? value.slice(0, 10) : null;
}

export function isLiveInMonth(task, year, month) {
  const { first, last } = monthBounds(year, month);
  const start = relevantFrom(task);
  if (start && start > last) return false;
  const end = task.end_date ? task.end_date.slice(0, 10) : null;
  if (end && end < first) return false;
  return true;
}

// Task ids with a check-in dated inside the month. Each map is keyed
// `${taskId}:${YYYY-MM-DD}`; completions count only when above zero.
export function checkInTaskIds({ completions = {}, notes = {}, overrides = {} }, year, month) {
  const { first, last } = monthBounds(year, month);
  const ids = new Set();
  const add = (key, include) => {
    const split = key.lastIndexOf(':');
    const date = key.slice(split + 1);
    if (include && date >= first && date <= last) ids.add(Number(key.slice(0, split)));
  };
  for (const [key, count] of Object.entries(completions)) add(key, count > 0);
  for (const [key, note] of Object.entries(notes)) add(key, !!note);
  for (const key of Object.keys(overrides)) add(key, true);
  return ids;
}

export function isVisibleInMonth(task, year, month, checkInIds = new Set()) {
  return checkInIds.has(task.id) || isLiveInMonth(task, year, month);
}
