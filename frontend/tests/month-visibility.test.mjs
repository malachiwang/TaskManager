import test from 'node:test';
import assert from 'node:assert/strict';
import { monthBounds, relevantFrom, isLiveInMonth, checkInTaskIds, isVisibleInMonth } from '../src/monthVisibility.js';

const MONTHS = [[2026, 7], [2026, 8], [2026, 9], [2026, 10]];
const visibleMonths = (task, checkIns = () => new Set()) =>
  MONTHS.filter(([y, m]) => isVisibleInMonth(task, y, m, checkIns(y, m))).map(([, m]) => m);

test('month bounds cover month lengths, leap years and December', () => {
  assert.deepEqual(monthBounds(2026, 8), { first: '2026-08-01', last: '2026-08-31' });
  assert.deepEqual(monthBounds(2026, 9), { first: '2026-09-01', last: '2026-09-30' });
  assert.deepEqual(monthBounds(2028, 2), { first: '2028-02-01', last: '2028-02-29' });
  assert.deepEqual(monthBounds(2026, 12), { first: '2026-12-01', last: '2026-12-31' });
});

test('relevance uses active_from, falling back to created_at', () => {
  assert.equal(relevantFrom({ active_from: '2026-08-15', created_at: '2026-06-01' }), '2026-08-15');
  assert.equal(relevantFrom({ active_from: null, created_at: '2026-09-10T08:00:00' }), '2026-09-10');
  assert.equal(relevantFrom({}), null);
});

test('July–October: ongoing, finished, mid-month start, hiatus and recurring', () => {
  assert.deepEqual(visibleMonths({ id: 1, active_from: '2026-06-01' }), [7, 8, 9, 10]);
  assert.deepEqual(visibleMonths({ id: 2, active_from: '2026-06-01', end_date: '2026-08-20' }), [7, 8]);
  assert.deepEqual(visibleMonths({ id: 3, active_from: '2026-08-15' }), [8, 9, 10]);
  assert.deepEqual(visibleMonths({ id: 4, active_from: '2026-09-10', end_date: '2026-10-05' }), [9, 10]);
  // Hiatus status never hides a live task.
  assert.deepEqual(visibleMonths({ id: 5, status: 'hiatus', is_paused: true, active_from: '2026-07-01' }), [7, 8, 9, 10]);
  // The repeat interval has no effect on visibility.
  assert.deepEqual(visibleMonths({ id: 6, interval_days: 30, active_from: '2026-09-01' }), [9, 10]);
  // Legacy row without active_from uses created_at.
  assert.deepEqual(visibleMonths({ id: 7, active_from: null, created_at: '2026-10-31T23:00:00' }), [10]);
});

test('a task starting on the last day of a month is live in that month only from then on', () => {
  const task = { id: 8, active_from: '2026-08-31' };
  assert.equal(isLiveInMonth(task, 2026, 7), false);
  assert.equal(isLiveInMonth(task, 2026, 8), true);
  assert.equal(isLiveInMonth(task, 2026, 9), true);
  assert.equal(isLiveInMonth({ id: 9, active_from: '2026-09-01' }, 2026, 8), false);
});

test('a task finished on the first day of a month is still live in that month', () => {
  const task = { id: 10, active_from: '2026-07-01', end_date: '2026-09-01' };
  assert.equal(isLiveInMonth(task, 2026, 9), true);
  assert.equal(isLiveInMonth(task, 2026, 10), false);
  assert.equal(isLiveInMonth({ id: 11, active_from: '2026-07-01', end_date: '2026-08-31' }, 2026, 9), false);
});

test('check-ins inside the month always show the task; other months and zero counts do not', () => {
  const maps = {
    completions: { '12:2026-08-03': 1, '13:2026-08-04': 0, '14:2026-09-01': 2 },
    notes: { '15:2026-08-31': 'note', '16:2026-08-10': '' },
    overrides: { '17:2026-08-01': '' },
  };
  const ids = checkInTaskIds(maps, 2026, 8);
  assert.deepEqual([...ids].sort((a, b) => a - b), [12, 15, 17]);
  // Starts in October, but a recorded August completion keeps it in August.
  const late = { id: 12, active_from: '2026-10-01' };
  assert.deepEqual(visibleMonths(late, (y, m) => checkInTaskIds(maps, y, m)), [8, 10]);
  // Finished in July, but an August text cell keeps it in August.
  assert.equal(isVisibleInMonth({ id: 17, active_from: '2026-06-01', end_date: '2026-07-15' }, 2026, 8, ids), true);
});
