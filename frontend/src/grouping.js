// Grouping modes for the task grid — Grouping Modes Phase 3.
//
// groupTasks(tasks, groupMode) is a pure function:
//   - input:  filteredTasks array + groupMode string
//   - output: GroupedSection[]
//   - preserves backend order within every group
//   - suppresses empty groups automatically
//   - metadata (pausedCount, avgUrgency) computed here, not in JSX

export const GROUP_MODES = {
  SECTION:  'section',
  CATEGORY: 'category',
  STATUS:   'status',
  URGENCY:  'urgency',
  NONE:     'none',
};

export const GROUP_MODE_LABELS = {
  [GROUP_MODES.SECTION]:  'Section',
  [GROUP_MODES.CATEGORY]: 'Category',
  [GROUP_MODES.STATUS]:   'Status',
  [GROUP_MODES.URGENCY]:  'Urgency',
  [GROUP_MODES.NONE]:     'None',
};

// Urgency band definitions — fixed display order.
// Ended tasks are routed by is_ended before is_paused or any urgency threshold,
// so they can never appear in Low or Paused bands.
export const URGENCY_BANDS = [
  { key: 'critical',   label: 'Critical',   minUrgency: 8  },
  { key: 'high',       label: 'High',        minUrgency: 6  },
  { key: 'noticeable', label: 'Noticeable',  minUrgency: 3  },
  { key: 'low',        label: 'Low',         minUrgency: 0  },
  { key: 'paused',     label: 'Hiatus',      paused: true   },
  { key: 'ended',      label: 'Finished',    ended: true    },
];

// Derives pausedCount and avgUrgency for a task array.
function groupMeta(tasks) {
  const pausedCount = tasks.filter((t) => t.is_paused === 1).length;
  // Exclude ended tasks from avgUrgency — their urgency=0 would distort the average.
  const active = tasks.filter(
    (t) => t.is_paused !== 1 && !t.is_ended && typeof t.urgency === 'number',
  );
  const avgUrgency =
    active.length > 0
      ? +(active.reduce((sum, t) => sum + t.urgency, 0) / active.length).toFixed(1)
      : null;
  return { pausedCount, avgUrgency };
}

// Groups tasks by the given mode.
// Returns GroupedSection[]:
//   { key: string, label: string|null, tasks: Task[], pausedCount: number, avgUrgency: number|null }
//
// label === null signals None mode — the render loop suppresses the divider row.
export function groupTasks(tasks, groupMode) {
  switch (groupMode) {

    case GROUP_MODES.SECTION: {
      // Preserve current behavior exactly — encounter order, blank → '(no section)'.
      const map = new Map();
      for (const task of tasks) {
        const key = task.section?.trim() || '(no section)';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(task);
      }
      return Array.from(map.entries()).map(([key, group]) => ({
        key,
        label: key,
        tasks: group,
        ...groupMeta(group),
      }));
    }

    case GROUP_MODES.CATEGORY: {
      const map = new Map();
      for (const task of tasks) {
        const key = task.category?.trim() || '(no category)';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(task);
      }
      return Array.from(map.entries()).map(([key, group]) => ({
        key,
        label: key,
        tasks: group,
        ...groupMeta(group),
      }));
    }

    case GROUP_MODES.STATUS: {
      // Fixed order: Active, Hiatus, Finished. Finished tasks excluded from Active/Hiatus.
      const active = tasks.filter((t) => t.is_paused !== 1 && !t.is_ended);
      const hiatus = tasks.filter((t) => t.is_paused === 1 && !t.is_ended);
      const ended  = tasks.filter((t) => t.is_ended === true);
      const groups = [];
      if (active.length > 0)
        groups.push({ key: 'active', label: 'Active', tasks: active, ...groupMeta(active) });
      if (hiatus.length > 0)
        groups.push({ key: 'hiatus', label: 'Hiatus', tasks: hiatus, ...groupMeta(hiatus) });
      if (ended.length > 0)
        groups.push({ key: 'ended', label: 'Finished', tasks: ended, ...groupMeta(ended) });
      return groups;
    }

    case GROUP_MODES.URGENCY: {
      // is_ended check comes FIRST — ended tasks go to Ended, never Low or Paused.
      // is_paused check is second — paused tasks go to Paused, never Low.
      const buckets = { critical: [], high: [], noticeable: [], low: [], paused: [], ended: [] };
      for (const task of tasks) {
        if (task.is_ended) {
          buckets.ended.push(task);
        } else if (task.is_paused === 1) {
          buckets.paused.push(task);
        } else {
          const urg = typeof task.urgency === 'number' ? task.urgency : 0;
          if      (urg >= 8) buckets.critical.push(task);
          else if (urg >= 6) buckets.high.push(task);
          else if (urg >= 3) buckets.noticeable.push(task);
          else               buckets.low.push(task);
        }
      }
      // Emit only non-empty buckets in fixed band order.
      return URGENCY_BANDS
        .filter((band) => buckets[band.key].length > 0)
        .map((band) => ({
          key:   band.key,
          label: band.label,
          tasks: buckets[band.key],
          ...groupMeta(buckets[band.key]),
        }));
    }

    case GROUP_MODES.NONE:
    default: {
      if (tasks.length === 0) return [];
      return [{ key: '__none__', label: null, tasks, ...groupMeta(tasks) }];
    }
  }
}
