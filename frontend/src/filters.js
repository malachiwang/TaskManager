// Centralized filter definitions for the task grid — Filtering/Search Phase 1.
//
// URGENT_THRESHOLD  aligns with the shared urgency model — "Urgent" = High band
//   and above (urgency >= URG_HIGH), so it agrees with the grid's amber/red rows.
// DORMANT_THRESHOLD mirrors the backend dashboard definition (days_since >= 30).

import { URG_HIGH } from './urgency.js';

export const URGENT_THRESHOLD  = URG_HIGH;
export const DORMANT_THRESHOLD = 30;

export const FILTERS = {
  ALL:        'all',
  ACTIVE:     'active',
  HIATUS:     'hiatus',
  URGENT:     'urgent',
  DORMANT:    'dormant',
  NEVER_DONE: 'never_done',
  SCHEDULED:  'scheduled',
  ENDED:      'ended',
};

export const FILTER_LABELS = {
  [FILTERS.ALL]:        'All',
  [FILTERS.ACTIVE]:     'Active',
  [FILTERS.HIATUS]:     'Hiatus',
  [FILTERS.URGENT]:     'Urgent',
  [FILTERS.DORMANT]:    'Dormant',
  [FILTERS.NEVER_DONE]: 'Never done',
  [FILTERS.SCHEDULED]:  'Scheduled',
  [FILTERS.ENDED]:      'Finished',
};

// P10.0 filter-bar split: the primary status scope is a single-select
// segmented control; the remaining filters are secondary on/off toggles that
// AND on top of the primary scope. Filter *semantics* (taskPassesFilter) are
// unchanged — only how they combine in the UI.
export const PRIMARY_FILTERS = [
  FILTERS.ALL,
  FILTERS.ACTIVE,
  FILTERS.HIATUS,
  FILTERS.ENDED,
];

export const SECONDARY_FILTERS = [
  FILTERS.URGENT,
  FILTERS.DORMANT,
  FILTERS.NEVER_DONE,
  FILTERS.SCHEDULED,
];

// Returns true if the task passes the given filter.
export function taskPassesFilter(task, filter) {
  switch (filter) {
    case FILTERS.ACTIVE:
      return task.is_paused !== 1 && !task.is_ended;
    case FILTERS.HIATUS:
      return task.is_paused === 1 && !task.is_ended;
    case FILTERS.URGENT:
      return task.is_paused !== 1
        && !task.is_scheduled
        && !task.is_ended
        && typeof task.urgency === 'number'
        && task.urgency >= URGENT_THRESHOLD;
    case FILTERS.DORMANT:
      return task.is_paused !== 1
        && !task.is_scheduled
        && !task.is_ended
        && task.days_since != null
        && task.days_since >= DORMANT_THRESHOLD;
    case FILTERS.NEVER_DONE:
      return !task.latest_completion && !task.is_scheduled && !task.is_ended;
    case FILTERS.SCHEDULED:
      return task.is_scheduled === true && !task.is_ended;
    case FILTERS.ENDED:
      return task.is_ended === true;
    default:
      return true; // FILTERS.ALL
  }
}
