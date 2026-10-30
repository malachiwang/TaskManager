export const DESTINATIONS = [
  { label: 'Main', page: 'main' },
  { label: 'Grid', page: 'main', view: 'grid' },
  { label: 'Reading', page: 'main', view: 'reading' },
  { label: 'Calendar', page: 'main', view: 'calendar' },
  { label: 'Reports', page: 'reports' },
  { label: 'Settings', page: 'settings' },
];
export function navigationMatches(query) {
  const q = query.trim().toLowerCase();
  return q ? DESTINATIONS.filter(d => d.label.toLowerCase().includes(q)).map(d => ({ ...d, kind: 'navigation' })) : [];
}
export function nextSearchIndex(index, delta, length) {
  return length ? (index + delta + length) % length : 0;
}

// Retired archive links may still arrive from an older in-memory search result.
// Keep the date/task target, but always reveal ordinary records in the Grid.
export function currentWorkspaceTarget(result) {
  const { snapshotId, ...target } = result;
  if (target.kind === 'navigation' && ['archive', 'history'].includes(target.page)) {
    return { kind: 'navigation', page: 'main', view: 'grid' };
  }
  return target;
}
