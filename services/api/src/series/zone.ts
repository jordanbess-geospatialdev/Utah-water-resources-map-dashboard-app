/**
 * Local-calendar machinery for America/Denver (technical specification,
 * "Numerical and temporal rules"): display and aggregate in the configured
 * program zone; user browser time must not redefine a reporting day.
 *
 * Pure and deterministic: built on Intl.DateTimeFormat with a fixed IANA zone
 * (no wall clock, no locale-dependent parsing). US DST rules since 2007 make
 * the second Sunday in March the 23-hour local day (2026-03-08) and the first
 * Sunday in November the 25-hour local day (2026-11-01); the code derives
 * both from the zone table, never from hard-coded transition dates.
 *
 * Cross-checked against the retained source offsets in
 * fixtures/contracts/observations.json: the spring-forward instant is
 * 2026-03-08T09:00:00Z (last MST hour 2026-03-08T08:00Z, first MDT hour
 * 2026-03-08T09:00Z) and the local day 2026-03-08 spans
 * [2026-03-08T07:00Z, 2026-03-09T06:00Z) = 82 800 seconds.
 */

/** Program reporting zone for Utah per the technical specification. */
export const PROGRAM_TIME_ZONE = 'America/Denver' as const;

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let dtf = partsCache.get(zone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    partsCache.set(zone, dtf);
  }
  return dtf;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Break an instant into calendar fields of `zone` (hour 0-23; ICU emits 24 for midnight under hour12:false, normalized here). */
export function zonedParts(epochMs: number, zone: string = PROGRAM_TIME_ZONE): ZonedParts {
  const parts = formatterFor(zone).formatToParts(new Date(epochMs));
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** Offset (ms) of `zone` at an instant, derived by comparing zone fields against UTC fields. */
function zoneOffsetMs(epochMs: number, zone: string): number {
  const p = zonedParts(epochMs, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Civil (y,m,d) tuple arithmetic without touching wall-clock time. */
export interface LocalDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

export function localDateOf(epochMs: number, zone: string = PROGRAM_TIME_ZONE): LocalDate {
  const p = zonedParts(epochMs, zone);
  return { year: p.year, month: p.month, day: p.day };
}

export function localDateKey(date: LocalDate): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/** Days in a month (leap-year correct). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const utc = Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000;
  const d = new Date(utc);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function addMonths(date: LocalDate, months: number): LocalDate {
  const targetMonthIndex = date.month - 1 + months;
  const year = date.year + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12 + 1;
  const day = Math.min(date.day, daysInMonth(year, month));
  return { year, month, day };
}

/**
 * The UTC instant of local midnight for a civil date in `zone`. Fixed-point
 * iteration over the zone offset (converges in at most 3 iterations; the
 * iteration count guard keeps it total even for pathological zone data).
 */
export function localMidnightInstant(date: LocalDate, zone: string = PROGRAM_TIME_ZONE): number {
  const naive = Date.UTC(date.year, date.month - 1, date.day);
  let t = naive - zoneOffsetMs(naive - 7 * 3_600_000, zone); // Utah-adjacent first estimate
  for (let i = 0; i < 4; i += 1) {
    const next = naive - zoneOffsetMs(t, zone);
    if (next === t) return t;
    t = next;
  }
  return t;
}

/** Duration (s) of the local day [midnight, next midnight): 82 800 / 86 400 / 90 000 around US DST transitions. */
export function localDayDurationSeconds(date: LocalDate, zone: string = PROGRAM_TIME_ZONE): number {
  return (localMidnightInstant(addDays(date, 1), zone) - localMidnightInstant(date, zone)) / 1000;
}

/** Monday of the local week containing `date`. */
export function mondayOfWeek(date: LocalDate): LocalDate {
  const dow = dayOfWeek(date);
  return addDays(date, -(dow - 1));
}

/** ISO day of week 1 (Mon) - 7 (Sun). */
export function dayOfWeek(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() || 7;
}

/** ISO 8601 week number and owning year for a date (week 1 contains the first Thursday). */
export function isoWeek(date: LocalDate): { year: number; week: number } {
  const thu = addDays(mondayOfWeek(date), 3);
  const week1Mon = mondayOfWeek({ year: thu.year, month: 1, day: 4 });
  const weeks = Math.round(
    (Date.UTC(thu.year, thu.month - 1, thu.day) - Date.UTC(week1Mon.year, week1Mon.month - 1, week1Mon.day)) / (7 * 86_400_000),
  ) + 1;
  return { year: thu.year, week: weeks };
}

export interface NamedSeasonWindow {
  readonly season: 'irrigation' | 'water-year' | 'calendar-year';
  readonly year: number;
  readonly start: LocalDate;
  readonly end: LocalDate;
}

/**
 * Season windows per season name and (season-)year. DEFAULTS pending
 * measurement-owner ratification per the technical specification:
 * - irrigation: Apr 1 (inclusive) through Nov 1 (exclusive), [start,end);
 * - water-year: Oct 1 of year-1 through Oct 1 of year (USGS water year ends Sep 30);
 * - calendar-year: Jan 1 through Jan 1.
 */
export function seasonWindow(season: 'irrigation' | 'water-year' | 'calendar-year', year: number): NamedSeasonWindow {
  switch (season) {
    case 'irrigation':
      return { season, year, start: { year, month: 4, day: 1 }, end: { year, month: 11, day: 1 } };
    case 'water-year':
      return { season, year, start: { year: year - 1, month: 10, day: 1 }, end: { year, month: 10, day: 1 } };
    case 'calendar-year':
      return { season, year, start: { year, month: 1, day: 1 }, end: { year: year + 1, month: 1, day: 1 } };
  }
}
