// Calendar (P12.0) — pure date/time/layout helpers for CalendarView.
// No React, no fetch: everything here is deterministic and testable.
//
// Conventions:
//   - "iso"      = local date string  "YYYY-MM-DD"
//   - "planned"  = local datetime string "YYYY-MM-DDTHH:MM" (no timezone)
//   - minutes    = minutes from local midnight (0…1440)
//   - weeks start on Sunday, matching TaskDatePicker's month grid

export const SNAP_MINUTES = 15;
export const MIN_SESSION_MINUTES = 15;
export const DEFAULT_SESSION_MINUTES = 60;
export const DAY_MINUTES = 1440;

// Vertical time density (V5.1 Part VI). One module-level scale keeps every
// pixel↔minute conversion in the app agreeing with the CSS var
// (--cal-hour-px) that CalendarView sets from the same table. Interaction
// precision is unaffected: snapping happens in minutes, not pixels.
export const DENSITY_SCALES = { compact: 32, standard: 48, detailed: 72 };
let pxPerHour = DENSITY_SCALES.standard;

export function setPxPerHour(px) {
  pxPerHour = px;
}

export function getPxPerHour() {
  return pxPerHour;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Local Date → "YYYY-MM-DD" (never toISOString — that shifts to UTC).
export function isoDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayIso() {
  return isoDate(new Date());
}

// "YYYY-MM-DD" → local Date at midnight.
export function isoToDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDaysIso(iso, delta) {
  const d = isoToDate(iso);
  d.setDate(d.getDate() + delta);
  return isoDate(d);
}

// Sunday-start week containing iso.
export function startOfWeekIso(iso) {
  const d = isoToDate(iso);
  return addDaysIso(iso, -d.getDay());
}

export function weekDates(anchorIso) {
  const start = startOfWeekIso(anchorIso);
  return Array.from({ length: 7 }, (_, i) => addDaysIso(start, i));
}

export function isWeekendIso(iso) {
  const day = isoToDate(iso).getDay();
  return day === 0 || day === 6;
}

// JS getDay() (0=Sun…6=Sat) → backend weekday (0=Mon…6=Sun).
export function jsDayToWeekday(jsDay) {
  return (jsDay + 6) % 7;
}

export function weekdayOfIso(iso) {
  return jsDayToWeekday(isoToDate(iso).getDay());
}

// ---------------------------------------------------------------------------
// planned "YYYY-MM-DDTHH:MM" ⇄ (date, minutes)
// ---------------------------------------------------------------------------

export function plannedDate(planned) {
  return planned.slice(0, 10);
}

export function plannedMinutes(planned) {
  return Number(planned.slice(11, 13)) * 60 + Number(planned.slice(14, 16));
}

export function combinePlanned(dateIso, minutes) {
  const m = Math.max(0, Math.min(DAY_MINUTES - 1, Math.round(minutes)));
  return `${dateIso}T${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

// End-of-session variant: 1440 means midnight, stored as 24:00 of the same
// day would be invalid — use next day 00:00.
export function combinePlannedEnd(dateIso, minutes) {
  const m = Math.max(0, Math.min(DAY_MINUTES, Math.round(minutes)));
  if (m >= DAY_MINUTES) return `${addDaysIso(dateIso, 1)}T00:00`;
  return combinePlanned(dateIso, m);
}

export function snapMinutes(minutes, step = SNAP_MINUTES) {
  return Math.round(minutes / step) * step;
}

export function clampDayMinutes(m) {
  return Math.max(0, Math.min(DAY_MINUTES, m));
}

// A session's [startMin, endMin) segment on one specific date, clamped to that
// day; null when the session does not touch the date at all.
export function sessionSegmentOnDate(session, dateIso) {
  const dayStart = `${dateIso}T00:00`;
  const dayEnd = `${addDaysIso(dateIso, 1)}T00:00`;
  if (session.planned_end <= dayStart || session.planned_start >= dayEnd) return null;
  const startMin = session.planned_start <= dayStart ? 0 : plannedMinutes(session.planned_start);
  const endMin = session.planned_end >= dayEnd ? DAY_MINUTES : plannedMinutes(session.planned_end);
  if (endMin <= startMin) return null;
  return { startMin, endMin };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export function formatTimeOfDay(minutes) {
  const m = ((Math.round(minutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const period = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return mm === 0 ? `${h12} ${period}` : `${h12}:${pad2(mm)} ${period}`;
}

export function formatHourLabel(hour) {
  return formatTimeOfDay(hour * 60);
}

export function formatTimeRange(startMin, endMin) {
  return `${formatTimeOfDay(startMin)} – ${formatTimeOfDay(endMin)}`;
}

export function durationLabel(minutes) {
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

// "Tue 25"
export function dayHeaderLabel(iso) {
  const d = isoToDate(iso);
  return { weekday: WEEKDAY_NAMES[d.getDay()], dayNum: d.getDate() };
}

// "Tuesday, Aug 25" style label for popovers.
export function fullDateLabel(iso) {
  const d = isoToDate(iso);
  const full = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `${full[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

// "Aug 24 – 30, 2026" / "Aug 30 – Sep 5, 2026" / "Dec 28, 2026 – Jan 3, 2027"
export function rangeLabel(dates) {
  const a = isoToDate(dates[0]);
  const b = isoToDate(dates[dates.length - 1]);
  if (dates.length === 1) {
    return `${MONTH_NAMES[a.getMonth()]} ${a.getDate()}, ${a.getFullYear()}`;
  }
  if (a.getFullYear() !== b.getFullYear()) {
    return `${MONTH_NAMES[a.getMonth()]} ${a.getDate()}, ${a.getFullYear()} – ${MONTH_NAMES[b.getMonth()]} ${b.getDate()}, ${b.getFullYear()}`;
  }
  if (a.getMonth() !== b.getMonth()) {
    return `${MONTH_NAMES[a.getMonth()]} ${a.getDate()} – ${MONTH_NAMES[b.getMonth()]} ${b.getDate()}, ${b.getFullYear()}`;
  }
  return `${MONTH_NAMES[a.getMonth()]} ${a.getDate()} – ${b.getDate()}, ${a.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Depth windows
// ---------------------------------------------------------------------------

// Windows applying to one date: one-off rows matching the date plus recurring
// rows matching its weekday, minus per-day exceptions (skips, P13.0).
export function windowsOnDate(windows, dateIso) {
  const wd = weekdayOfIso(dateIso);
  return windows.filter((w) => {
    if (w.date != null) return w.date === dateIso;
    if (w.weekday !== wd) return false;
    return !(w.skips ?? []).includes(dateIso);
  });
}

// Shift a planned "YYYY-MM-DDTHH:MM" by whole days, keeping the time of day.
export function shiftPlannedDays(planned, deltaDays) {
  return `${addDaysIso(plannedDate(planned), deltaDays)}T${planned.slice(11, 16)}`;
}

// Whole minutes between two planned datetimes (end - start, floor 0).
export function plannedDiffMinutes(startPlanned, endPlanned) {
  const ms = new Date(endPlanned) - new Date(startPlanned);
  return Math.max(0, Math.round(ms / 60000));
}

// ---------------------------------------------------------------------------
// Overlap layout — Google Calendar-style column packing.
// blocks: [{ startMin, endMin, ... }] for ONE day column.
// Returns new objects with { col, cols } added: col = 0-based column index,
// cols = column count of the block's overlap cluster.
// ---------------------------------------------------------------------------

export function layoutBlocks(blocks) {
  const sorted = [...blocks].sort(
    (a, b) => a.startMin - b.startMin || b.endMin - a.endMin,
  );
  const out = [];
  let cluster = [];
  let colEnds = [];
  let clusterEnd = -1;

  function flush() {
    for (const item of cluster) item.cols = colEnds.length;
    out.push(...cluster);
    cluster = [];
    colEnds = [];
  }

  for (const b of sorted) {
    if (cluster.length > 0 && b.startMin >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= b.startMin);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(b.endMin);
    } else {
      colEnds[col] = b.endMin;
    }
    cluster.push({ ...b, col, cols: 1 });
    clusterEnd = cluster.length === 1 ? b.endMin : Math.max(clusterEnd, b.endMin);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Pixel ⇄ minute conversion
// ---------------------------------------------------------------------------

export function minutesToPx(minutes) {
  return (minutes / 60) * pxPerHour;
}

export function pxToMinutes(px) {
  return (px / pxPerHour) * 60;
}
