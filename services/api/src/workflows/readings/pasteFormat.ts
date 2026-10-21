/**
 * Pure paste-format primitives for staged bulk import (WD-010, FR-021).
 *
 * Deterministic, dependency-free parsing of pasted CSV/TSV text: delimiter
 * detection, header alias mapping, locale date/time formats, explicit UTC
 * offsets, and America/Denver DST conversion (the fixture world's only
 * zone). Everything here is a pure function of its arguments - no I/O, no
 * clock reads, no Intl/tzdata dependence (the 2007+ US DST rule is coded
 * explicitly so the 2026 fixture transitions resolve identically
 * everywhere).
 *
 * MIRROR CONTRACT: apps/web/src/features/data-entry/entryModel.ts mirrors
 * this module function-for-function so the browser preview shows exactly
 * what the server will validate. The mirror parity test in
 * apps/web (entryModel.test.ts) imports THIS file at runtime (outside the
 * web tsc program) and asserts identical verdicts on the 366-row golden
 * batch. Any divergence found there is a defect in the mirror.
 */

// ---------------------------------------------------------------------------
// Time arithmetic (UTC seconds; no Date object needed beyond epoch math)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
/** Denver standard offset in minutes west of UTC (MST). */
const MST_MINUTES = -7 * 60;
/** Denver daylight offset in minutes west of UTC (MDT). */
const MDT_MINUTES = -6 * 60;

function utcEpoch(year: number, month1to12: number, day: number, hour: number, minute: number, second: number, offsetMinutes: number): number {
  return Date.UTC(year, month1to12 - 1, day, hour, minute, second) - offsetMinutes * 60_000;
}

/** Day-of-week (0=Sunday..6) of a UTC calendar date. */
function utcWeekday(year: number, month1to12: number, day: number): number {
  return new Date(Date.UTC(year, month1to12 - 1, day)).getUTCDay();
}

/** UTC epoch of the n-th Sunday of a month at 00:00 UTC. */
function nthSundayUtc(year: number, month1to12: number, nth: number): number {
  const weekday = utcWeekday(year, month1to12, 1);
  const firstSunday = 1 + ((7 - weekday) % 7);
  return Date.UTC(year, month1to12 - 1, firstSunday + (nth - 1) * 7);
}

/**
 * 2007+ US DST rule, Denver: daylight time runs from the second Sunday of
 * March 02:00 local standard (09:00Z) to the first Sunday of November 02:00
 * local daylight (08:00Z). The fixture anchors match exactly: offset flips
 * at 2026-03-08T09:00:00Z (-07:00 -> -06:00).
 */
export function denverOffsetMinutesAt(utcEpochMs: number): number {
  const asUtc = new Date(utcEpochMs);
  const year = asUtc.getUTCFullYear();
  const dstStart = nthSundayUtc(year, 3, 2) + 9 * 3_600_000; // 09:00Z
  const dstEnd = nthSundayUtc(year, 11, 1) + 8 * 3_600_000; // 08:00Z
  return utcEpochMs >= dstStart && utcEpochMs < dstEnd ? MDT_MINUTES : MST_MINUTES;
}

export interface LocalToUtcResult {
  readonly kind: 'ok';
  readonly epochMs: number;
  readonly offsetMinutes: number;
}

export type DenverLocalToUtc =
  | LocalToUtcResult
  | { readonly kind: 'nonexistent' }
  | { readonly kind: 'ambiguous' };

/**
 * Resolve a Denver wall-clock time to a UTC instant. Spring-forward: the
 * skipped hour (02:00-02:59 on the second Sunday of March) is nonexistent.
 * Fall-back: the repeated hour (01:00-01:59 on the first Sunday of November)
 * is ambiguous and needs an explicit offset from the caller.
 */
export function denverLocalToUtc(year: number, month1to12: number, day: number, hour: number, minute: number, second: number): DenverLocalToUtc {
  const asStandard = utcEpoch(year, month1to12, day, hour, minute, second, MST_MINUTES);
  const asDaylight = utcEpoch(year, month1to12, day, hour, minute, second, MDT_MINUTES);
  const validStandard = denverOffsetMinutesAt(asStandard) === MST_MINUTES;
  const validDaylight = denverOffsetMinutesAt(asDaylight) === MDT_MINUTES;
  if (validStandard && validDaylight) return { kind: 'ambiguous' };
  if (validStandard) return { kind: 'ok', epochMs: asStandard, offsetMinutes: MST_MINUTES };
  if (validDaylight) return { kind: 'ok', epochMs: asDaylight, offsetMinutes: MDT_MINUTES };
  return { kind: 'nonexistent' };
}

/** UTC instant, second precision, formatted `YYYY-MM-DDTHH:mm:ssZ` (logical keys use this). */
export function formatUtcSecondPrecision(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Render an offset in minutes as `+HH:MM` / `-HH:MM`. */
export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// Cell parsing
// ---------------------------------------------------------------------------

/** Parse a date-only cell. Supported formats: ISO `YYYY-MM-DD`, US `M/D/YYYY`, `YYYY/M/D`. */
export function parseDateCell(raw: string): { year: number; month: number; day: number } | null {
  const text = raw.trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) return withDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (match) return withDate(Number(match[3]), Number(match[1]), Number(match[2]));
  match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text);
  if (match) return withDate(Number(match[1]), Number(match[2]), Number(match[3]));
  return null;
}

function withDate(year: number, month: number, day: number): { year: number; month: number; day: number } | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1900 || year > 9999) return null;
  const epoch = Date.UTC(year, month - 1, day);
  const check = new Date(epoch);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

export interface TimeOfDay {
  hour: number;
  minute: number;
  second: number;
}

/** Parse a time-of-day cell: `HH:mm[:ss]` 24h, or `h:mm[:ss] AM|PM`. */
export function parseTimeCell(raw: string): TimeOfDay | null {
  const text = raw.trim().toUpperCase();
  let match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(AM|PM)?$/.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  const meridiem = match[4];
  if (meridiem === 'AM' && hour === 12) hour = 0;
  if (meridiem === 'PM' && hour !== 12) hour += 12;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

/** Parse an explicit-offset cell: `Z`, `±HH:MM`, `±HHMM`, `±HH`, or MST/MDT (Denver aliases). */
export function parseOffsetCell(raw: string): number | null {
  const text = raw.trim().toUpperCase();
  if (text === '' || text === 'Z' || text === 'UTC' || text === 'GMT') return 0;
  if (text === 'MST') return MST_MINUTES;
  if (text === 'MDT') return MDT_MINUTES;
  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(text);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const hh = Number(match[2]);
  const mm = match[3] === undefined ? 0 : Number(match[3]);
  if (hh > 14 || mm > 59) return null;
  return sign * (hh * 60 + mm);
}

/** True when an ISO string carries an explicit offset (`Z`, `+HH:MM`, `-HHMM`, `+HH`). */
export function isoHasExplicitOffset(text: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2}|[+-]\d{2})$/i.test(text.trim());
}

/**
 * Parse a full ISO-ish datetime cell (may itself carry an offset) into an
 * exact instant. Accepts `YYYY-MM-DD[T ]HH:mm[:ss]` with optional offset.
 */
export function parseDateTimeWithOffset(raw: string): { epochMs: number; offsetMinutes: number } | null {
  const text = raw.trim();
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(Z|[+-]\d{2}:?\d{2}|[+-]\d{2})?$/i.exec(text);
  if (!match) return null;
  const date = withDate(Number(match[1]), Number(match[2]), Number(match[3]));
  if (!date) return null;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const offset = match[7] === undefined ? null : parseOffsetCell(match[7]);
  if (match[7] !== undefined && offset === null) return null;
  return { epochMs: utcEpoch(date.year, date.month, date.day, hour, minute, second, offset ?? 0), offsetMinutes: offset ?? 0 };
}

// ---------------------------------------------------------------------------
// Delimiter + header mapping
// ---------------------------------------------------------------------------

/** Detect the delimiter from the first non-empty line (tab beats comma beats semicolon). */
export function detectDelimiter(text: string): ',' | '\t' | ';' {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const tabs = count(firstLine, '\t');
  const commas = count(firstLine, ',');
  const semis = count(firstLine, ';');
  if (tabs > 0 && tabs >= commas && tabs >= semis) return '\t';
  if (semis > 0 && semis > commas) return ';';
  return ',';
}

function count(haystack: string, needle: string): number {
  let total = 0;
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) total += 1;
  return total;
}

/** Header aliases -> canonical column keys. Lowercased; spaces/underscores/hyphens fold. */
const HEADER_ALIASES: Readonly<Record<string, string>> = {
  stream: 'stream', stream_id: 'stream', datastream: 'stream', datastream_id: 'stream', streamid: 'stream',
  station: 'station', station_id: 'station', site: 'station', site_id: 'station', stationid: 'station', siteid: 'station',
  date: 'date', day: 'date', obs_date: 'date',
  time: 'time', obs_time: 'time',
  datetime: 'datetime', timestamp: 'datetime', observed_at: 'datetime', observedat: 'datetime', date_time: 'datetime',
  offset: 'offset', utc_offset: 'offset', utcoffset: 'offset', tz_offset: 'offset', zone: 'offset',
  value: 'value', reading: 'value', flow: 'value', discharge: 'value', stage_value: 'value', val: 'value',
  unit: 'unit', units: 'unit', unit_id: 'unit',
  method: 'method', method_type: 'method', methodtype: 'method', method_id: 'method',
  note: 'note', notes: 'note', comment: 'note', comments: 'note', remarks: 'note',
};

export const KNOWN_COLUMN_KEYS: readonly string[] = [
  'stream', 'station', 'date', 'time', 'datetime', 'offset', 'value', 'unit', 'method', 'note',
];

/** Map header cells onto canonical column keys; unknown headers are reported, not fatal. */
export function mapHeader(headerCells: readonly string[]): {
  columns: Record<string, number | undefined>;
  unknownColumns: string[];
} {
  const columns: Record<string, number | undefined> = {};
  for (const key of KNOWN_COLUMN_KEYS) columns[key] = undefined;
  const unknownColumns: string[] = [];
  headerCells.forEach((cell, index) => {
    const normalized = cell.trim().toLowerCase().replace(/[\s-]+/g, '_');
    const key = HEADER_ALIASES[normalized];
    if (key && columns[key] === undefined) columns[key] = index;
    else if (!key) unknownColumns.push(cell.trim());
  });
  return { columns, unknownColumns };
}

/** Split a paste line into cells (no quoted-cell support: field paste is the contract, documented in README). */
export function splitLine(line: string, delimiter: ',' | '\t' | ';'): string[] {
  return line.split(delimiter).map((cell) => cell.trim());
}

/** Iterate the non-empty lines of a paste (final newlines and blank lines ignored). */
export function pasteLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

export const DAY_MS_CONSTANT = DAY_MS;
