/**
 * Digest schedule boundaries in the program zone (WD-015; FR-025 with the
 * FR-014/FR-016 calendar semantics).
 *
 * "Users choose system or stream scope and hourly, twice-daily, daily or
 * weekly cadence" (FR-016) - WD-015 gives site/system ALERT subscriptions the
 * same four schedules, anchored to fixed America/Denver wall-clock times:
 *
 * - hourly: every hour, on the hour;
 * - twice-daily: 06:00 and 18:00 America/Denver;
 * - daily: 07:00 America/Denver;
 * - weekly: Monday 07:00 America/Denver.
 *
 * A digest BOUNDARY is the instant a window closes (the digest "due" instant);
 * a WINDOW is [previous boundary, boundary). Boundaries are exact instants
 * resolved from Denver WALL-CLOCK time, so window DURATIONS are DST-correct:
 * the daily window ending after the 2026-03-08 spring-forward is 23 hours,
 * the 18:00->06:00 twice-daily window spanning it is 11 hours, the weekly
 * window covering it is 167 hours, and hourly windows stay exactly one hour
 * (Denver offsets are whole hours and the transition lands on an hour mark,
 * so Denver hour boundaries coincide with UTC hour boundaries - the skipped
 * local hour simply never exists).
 *
 * WEEKEND CATCH-UP (mirrors WD-014's documented window rule): windows are
 * CONTIGUOUS - [previous boundary, boundary) with no gap - so a Monday weekly
 * digest necessarily includes everything since the previous Monday, and the
 * Friday+Saturday+Sunday interval appears in that Monday digest EXACTLY ONCE
 * (per-event dedupe by id lives in subscriptions.ts; this module guarantees
 * no window boundary can fall between days and double-cover or skip a
 * weekend). A browser clock never redefines a boundary: every calculation is
 * keyed to America/Denver at an injected instant.
 *
 * Purity: no clock reads (the instant is always an argument), no I/O; Intl is
 * used only with the explicit fixed zone, so results are deterministic.
 */
import { PROGRAM_TIME_ZONE, programDayKey } from '../../support/analytics.ts';
import type { NotificationCadence } from './types.ts';

export { PROGRAM_TIME_ZONE };

// ---------------------------------------------------------------------------
// Denver wall-clock math (mirrors WD-014 connections.ts; DST-aware)
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

function parse(at: Date | string | number): number {
  if (typeof at === 'number') return at;
  return typeof at === 'string' ? Date.parse(at) : at.getTime();
}

function dayKeyToDate(dayKey: string): Date {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

function dateToDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDayKey(dayKey: string, days: number): string {
  return dateToDayKey(new Date(dayKeyToDate(dayKey).getTime() + days * MS_PER_DAY));
}

/** Weekday name of a YYYY-MM-DD calendar date (the date itself, zone-independent). */
export function weekdayOf(dayKey: string): string {
  return WEEKDAY_NAMES[dayKeyToDate(dayKey).getUTCDay()]!;
}

/** Denver UTC offset in ms at an instant (negative behind UTC), via Intl longOffset. */
function denverOffsetMs(instantMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: PROGRAM_TIME_ZONE, timeZoneName: 'longOffset' }).formatToParts(new Date(instantMs));
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (!match) return 0; // GMT (UTC±00:00)
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60 * 1000;
}

/**
 * Exact instant (ISO) of local `hour`:00 on the America/Denver calendar day
 * `dayKey`. DST transitions happen at 02:00 local; the schedule anchors
 * (06:00, 07:00, 18:00) never fall inside a transition window, so a single
 * refinement pass makes the boundary exact even on switch days.
 */
export function denverLocalInstant(dayKey: string, hour: number): string {
  const base = dayKeyToDate(dayKey).getTime();
  // First offset guess at an instant safely inside the same local day.
  let offset = denverOffsetMs(base + (hour + 7) * MS_PER_HOUR);
  let instant = base + hour * MS_PER_HOUR - offset;
  offset = denverOffsetMs(instant);
  instant = base + hour * MS_PER_HOUR - offset;
  return iso(instant);
}

// ---------------------------------------------------------------------------
// The four cadence anchors
// ---------------------------------------------------------------------------

/** Twice-daily boundaries: 06:00 and 18:00 America/Denver. */
export const TWICE_DAILY_HOURS: readonly [number, number] = [6, 18];
/** Daily boundary: 07:00 America/Denver (also the weekly Monday anchor). */
export const DAILY_HOUR = 7;
/** Weekly boundary: Monday (ISO weekday 1) at DAILY_HOUR America/Denver. */
export const WEEKLY_WEEKDAY = 1;

/** Monday key of the week containing `dayKey` (a Monday itself maps to itself). */
function mondayOfWeek(dayKey: string): string {
  const weekday = dayKeyToDate(dayKey).getUTCDay(); // 0=Sun .. 6=Sat
  const back = (weekday - WEEKLY_WEEKDAY + 7) % 7;
  return shiftDayKey(dayKey, -back);
}

/**
 * The latest cadence boundary at or before `at` (the digest "due" boundary
 * whose window just closed). For hourly cadence this is the UTC hour grid:
 * Denver keeps whole-hour offsets and switches at :00, so every existing
 * Denver hour boundary IS a UTC hour boundary.
 */
export function currentBoundary(cadence: NotificationCadence, at: Date | string | number): string {
  const atMs = parse(at);
  switch (cadence) {
    case 'hourly':
      return iso(Math.floor(atMs / MS_PER_HOUR) * MS_PER_HOUR);
    case 'twice-daily': {
      const dayKey = programDayKey(iso(atMs));
      const evening = denverLocalInstant(dayKey, TWICE_DAILY_HOURS[1]);
      if (atMs >= Date.parse(evening)) return evening;
      const morning = denverLocalInstant(dayKey, TWICE_DAILY_HOURS[0]);
      if (atMs >= Date.parse(morning)) return morning;
      return denverLocalInstant(shiftDayKey(dayKey, -1), TWICE_DAILY_HOURS[1]);
    }
    case 'daily': {
      const dayKey = programDayKey(iso(atMs));
      const today = denverLocalInstant(dayKey, DAILY_HOUR);
      if (atMs >= Date.parse(today)) return today;
      return denverLocalInstant(shiftDayKey(dayKey, -1), DAILY_HOUR);
    }
    case 'weekly': {
      const monday = mondayOfWeek(programDayKey(iso(atMs)));
      const thisWeek = denverLocalInstant(monday, DAILY_HOUR);
      if (atMs >= Date.parse(thisWeek)) return thisWeek;
      return denverLocalInstant(shiftDayKey(monday, -7), DAILY_HOUR);
    }
  }
}

/**
 * Step a boundary by `steps` grid positions IN LOCAL TERMS (DST-correct:
 * "same wall clock next day/week" resolves through denverLocalInstant).
 */
export function stepBoundary(cadence: NotificationCadence, boundary: string, steps: number): string {
  switch (cadence) {
    case 'hourly':
      return iso(Date.parse(boundary) + steps * MS_PER_HOUR);
    case 'daily':
      return denverLocalInstant(shiftDayKey(programDayKey(boundary), steps), DAILY_HOUR);
    case 'twice-daily': {
      const dayKey = programDayKey(boundary);
      const evening = Date.parse(boundary) === Date.parse(denverLocalInstant(dayKey, TWICE_DAILY_HOURS[1]));
      const slot = dayOrdinal(dayKey) * 2 + (evening ? 1 : 0) + steps;
      const nextDay = dateToDayKey(new Date(Math.floor(slot / 2) * MS_PER_DAY));
      return denverLocalInstant(nextDay, slot % 2 === 0 ? TWICE_DAILY_HOURS[0] : TWICE_DAILY_HOURS[1]);
    }
    case 'weekly':
      return denverLocalInstant(shiftDayKey(programDayKey(boundary), steps * 7), DAILY_HOUR);
  }
}

function dayOrdinal(dayKey: string): number {
  return Math.round(dayKeyToDate(dayKey).getTime() / MS_PER_DAY);
}

/** The boundary immediately before `boundary` (windows are contiguous). */
export function previousBoundary(cadence: NotificationCadence, boundary: string): string {
  return stepBoundary(cadence, boundary, -1);
}

/** The first boundary strictly after `after`. */
export function nextBoundary(cadence: NotificationCadence, after: Date | string | number): string {
  return stepBoundary(cadence, currentBoundary(cadence, after), 1);
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export interface CadenceWindow {
  readonly cadence: NotificationCadence;
  /** Window end == the digest boundary. */
  readonly windowEnd: string;
  readonly windowStart: string;
  /** Exact elapsed duration (DST-correct; hours may be 23/25 or 167/169). */
  readonly durationMs: number;
}

/** The window that closes AT `boundary` (boundary must be a real grid point). */
export function windowForBoundary(cadence: NotificationCadence, boundary: string): CadenceWindow {
  const start = previousBoundary(cadence, boundary);
  return {
    cadence,
    windowEnd: boundary,
    windowStart: start,
    durationMs: Date.parse(boundary) - Date.parse(start),
  };
}

/** The window whose boundary is current at `at` (the digest due now would cover this). */
export function currentWindow(cadence: NotificationCadence, at: Date | string | number): CadenceWindow {
  return windowForBoundary(cadence, currentBoundary(cadence, at));
}

/**
 * The Denver day keys of the Friday, Saturday and Sunday preceding a MONDAY
 * weekly boundary - the weekend interval the Monday digest must include
 * exactly once (WD-014's documented Monday catch-up rule; contiguity above
 * guarantees it, dedupe-by-id in subscriptions.ts enforces it).
 */
export function weekendCoverageDays(mondayBoundary: string): readonly string[] {
  const monday = programDayKey(mondayBoundary);
  return [shiftDayKey(monday, -3), shiftDayKey(monday, -2), shiftDayKey(monday, -1)];
}

// ---------------------------------------------------------------------------
// Display labels (fixed zone; deterministic)
// ---------------------------------------------------------------------------

export interface WallClock {
  readonly dayKey: string;
  readonly hour: number;
  readonly minute: number;
  readonly zone: string;
}

/** Denver wall clock of an instant, e.g. { '2026-03-09', 7, 0, 'MDT' }. */
export function denverWallClock(at: Date | string): WallClock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PROGRAM_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(typeof at === 'string' ? new Date(at) : at);
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const dayKey = `${value('year')}-${value('month')}-${value('day')}`;
  const hour = Number(value('hour'));
  return { dayKey, hour: hour === 24 ? 0 : hour, minute: Number(value('minute')), zone: value('timeZoneName') };
}

function hhmm(wall: WallClock): string {
  return `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;
}

/** '2026-03-09 07:00 MDT' - boundary/window-edge label in the program zone. */
export function denverInstantLabel(at: string): string {
  const wall = denverWallClock(at);
  return `${wall.dayKey} ${hhmm(wall)} ${wall.zone}`;
}

/**
 * Human window label: 'Mon 2026-03-09 07:00 → 08:00 MDT' on the same local
 * day, otherwise 'Fri 2026-03-06 07:00 MST → Mon 2026-03-09 07:00 MDT'
 * (always with the zone so a DST-crossing window is visible).
 */
export function windowLabel(windowStart: string, windowEnd: string): string {
  const start = denverWallClock(windowStart);
  const end = denverWallClock(windowEnd);
  const startDay = `${weekdayOf(start.dayKey)} ${start.dayKey} ${hhmm(start)}`;
  if (start.dayKey === end.dayKey) {
    return `${startDay} → ${hhmm(end)} ${end.zone}`;
  }
  return `${startDay} ${start.zone} → ${weekdayOf(end.dayKey)} ${end.dayKey} ${hhmm(end)} ${end.zone}`;
}
