// Workspace search destinations (tm-clean 11; ported from drift-ref).
export const DESTINATIONS = [
  { label: 'Main', page: 'main' },
  { label: 'Grid', page: 'main', view: 'tasks' },
  { label: 'Reading', page: 'main', view: 'reading' },
  { label: 'Calendar', page: 'main', view: 'calendar' },
  { label: 'Reports', page: 'reports' },
  { label: 'Settings', page: 'settings' },
];

export function navigationMatches(query) {
  const q = query.trim().toLowerCase();
  return q ? DESTINATIONS.filter((d) => d.label.toLowerCase().includes(q)).map((d) => ({ ...d, kind: 'navigation' })) : [];
}

export function nextSearchIndex(index, delta, length) {
  return length ? (index + delta + length) % length : 0;
}
