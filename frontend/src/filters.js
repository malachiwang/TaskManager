// Centralized filter definitions for the task grid — Filtering/Search Phase 1.
//
// URGENT_THRESHOLD  matches the urg-high/urg-critical CSS bands (urgency >= 6).
// DORMANT_THRESHOLD mirrors the backend dashboard definition (days_since >= 30).

export const URGENT_THRESHOLD  = 6;
export const DORMANT_THRESHOLD = 30;

export const FILTERS = {
  ALL:        'all',
  ACTIVE:     'active',
  HIATUS:     'hiatus',
  URGENT:     'urgent',
  DORMANT:    'dormant',
  NEVER_DONE: 'never_done',
  SCHEDULED:  'scheduled',
};

export const FILTER_LABELS = {
  [FILTERS.ALL]:        'All',
  [FILTERS.ACTIVE]:     'Active',
  [FILTERS.HIATUS]:     'Hiatus',
  [FILTERS.URGENT]:     'Urgent',
  [FILTERS.DORMANT]:    'Dormant',
  [FILTERS.NEVER_DONE]: 'Never done',
  [FILTERS.SCHEDULED]:  'Scheduled',
};

// Returns true if the task passes the given filter.
export function taskPassesFilter(task, filter) {
  switch (filter) {
    case FILTERS.ACTIVE:
      return task.is_paused !== 1;
    case FILTERS.HIATUS:
      return task.is_paused === 1;
    case FILTERS.URGENT:
      return task.is_paused !== 1
        && !task.is_scheduled
        && typeof task.urgency === 'number'
        && task.urgency >= URGENT_THRESHOLD;
    case FILTERS.DORMANT:
      return task.is_paused !== 1
        && !task.is_scheduled
        && task.days_since != null
        && task.days_since >= DORMANT_THRESHOLD;
    case FILTERS.NEVER_DONE:
      return !task.latest_completion && !task.is_scheduled;
    case FILTERS.SCHEDULED:
      return task.is_scheduled === true;
    default:
      return true; // FILTERS.ALL
  }
}
