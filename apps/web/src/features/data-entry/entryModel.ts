/**
 * entryModel - the pure paste-text -> staged-preview model and the entry
 * form state machines for the WD-010 data-entry feature (FR-020, FR-021).
 *
 * MIRROR CONTRACT: the parse half of this module mirrors
 * services/api/src/workflows/readings/{pasteFormat,bulkImport}.ts
 * function-for-function so the browser preview shows exactly what the
 * server's validate stage will report. entryModel.test.ts loads the REAL
 * server parser at runtime (outside the web tsc program, the established
 * dynamic-import pattern from features/operations) and asserts identical
 * verdicts on the same pastes - any divergence found there is a defect in
 * this mirror and must be fixed here, not in the tests.
 *
 * The browser preview is parse-only: it sees fixture observations for
 * duplicate reporting but NOT rows entered since page load, and it performs
 * no authorization (the server's validate stage re-verifies per-row scope
 * and reports ROW_OUT_OF_SCOPE / ROW_LIFECYCLE_CLOSED). The preview states
 * this in its UI.
 *
 * Deterministic like its server twin: no clock reads, no randomness, no
 * Intl/tzdata (the 2007+ US Denver DST rule is coded explicitly).
 */
import { observations, stations, vocabulary } from '../../shell/data/fixtures';
import type { DatastreamRecord } from '../../shell/data/types';

// ---------------------------------------------------------------------------
// Time arithmetic - mirror of pasteFormat.ts
// ---------------------------------------------------------------------------

const MST_MINUTES = -7 * 60;
const MDT_MINUTES = -6 * 60;

function utcEpoch(year: number, month1to12: number, day: number, hour: number, minute: number, second: number, offsetMinutes: number): number {
  return Date.UTC(year, month1to12 - 1, day, hour, minute, second) - offsetMinutes * 60_000;
}

function nthSundayUtc(year: number, month1to12: number, nth: number): number {
  const weekday = new Date(Date.UTC(year, month1to12 - 1, 1)).getUTCDay();
  const firstSunday = 1 + ((7 - weekday) % 7);
  return Date.UTC(year, month1to12 - 1, firstSunday + (nth - 1) * 7);
}

/** 2007+ US DST rule, Denver: second Sunday of March 09:00Z to first Sunday of November 08:00Z. */
export function denverOffsetMinutesAt(utcEpochMs: number): number {
  const year = new Date(utcEpochMs).getUTCFullYear();
  const dstStart = nthSundayUtc(year, 3, 2) + 9 * 3_600_000;
  const dstEnd = nthSundayUtc(year, 11, 1) + 8 * 3_600_000;
  return utcEpochMs >= dstStart && utcEpochMs < dstEnd ? MDT_MINUTES : MST_MINUTES;
}

export type DenverLocalToUtc =
  | { readonly kind: 'ok'; readonly epochMs: number; readonly offsetMinutes: number }
  | { readonly kind: 'nonexistent' }
  | { readonly kind: 'ambiguous' };

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

export function formatUtcSecondPrecision(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

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
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

export interface TimeOfDay {
  hour: number;
  minute: number;
  second: number;
}

export function parseTimeCell(raw: string): TimeOfDay | null {
  const text = raw.trim().toUpperCase();
  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(AM|PM)?$/.exec(text);
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

export function isoHasExplicitOffset(text: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2}|[+-]\d{2})$/i.test(text.trim());
}

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
// Delimiter + header mapping - mirror of pasteFormat.ts
// ---------------------------------------------------------------------------

export function detectDelimiter(text: string): ',' | '\t' | ';' {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const tabs = countOf(firstLine, '\t');
  const commas = countOf(firstLine, ',');
  const semis = countOf(firstLine, ';');
  if (tabs > 0 && tabs >= commas && tabs >= semis) return '\t';
  if (semis > 0 && semis > commas) return ';';
  return ',';
}

function countOf(haystack: string, needle: string): number {
  let total = 0;
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) total += 1;
  return total;
}

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

export type ColumnKey =
  | 'stream'
  | 'station'
  | 'date'
  | 'time'
  | 'datetime'
  | 'offset'
  | 'value'
  | 'unit'
  | 'method'
  | 'note';

export const KNOWN_COLUMN_KEYS: readonly ColumnKey[] = [
  'stream', 'station', 'date', 'time', 'datetime', 'offset', 'value', 'unit', 'method', 'note',
];

export function mapHeader(headerCells: readonly string[]): {
  columns: Partial<Record<ColumnKey, number>>;
  unknownColumns: string[];
} {
  const columns: Partial<Record<ColumnKey, number>> = {};
  const unknownColumns: string[] = [];
  headerCells.forEach((cell, index) => {
    const normalized = cell.trim().toLowerCase().replace(/[\s-]+/g, '_');
    const key = HEADER_ALIASES[normalized];
    if (key && columns[key as ColumnKey] === undefined) columns[key as ColumnKey] = index;
    else if (!key) unknownColumns.push(cell.trim());
  });
  return { columns, unknownColumns };
}

export function splitLine(line: string, delimiter: ',' | '\t' | ';'): string[] {
  return line.split(delimiter).map((cell) => cell.trim());
}

export function pasteLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Preview model types (shape-compatible with the server's ParsedBatch)
// ---------------------------------------------------------------------------

export interface CellError {
  readonly rowIndex: number;
  readonly columnKey: ColumnKey | null;
  readonly columnIndex: number | null;
  readonly code: string;
  readonly message: string;
  readonly cellValue: string;
}

export interface ResolvedTime {
  readonly observedAt: string;
  readonly sourceOffset: string;
}

export interface PreviewMapping {
  readonly delimiter: ',' | '\t' | ';';
  readonly columns: Partial<Record<ColumnKey, number>>;
  readonly unknownColumns: readonly string[];
  readonly headerCells: readonly string[];
}

export type PreviewRowVerdict =
  | { readonly kind: 'accepted'; readonly rowIndex: number; readonly streamId: string; readonly time: ResolvedTime; readonly value: number; readonly unitId: string; readonly logicalKey: string; readonly methodTypeId: string; readonly note: string | null }
  | { readonly kind: 'duplicate'; readonly rowIndex: number; readonly streamId: string; readonly logicalKey: string; readonly against: 'batch' | 'store'; readonly existingId: string | null; readonly firstRowIndex: number | null; readonly time: ResolvedTime; readonly value: number; readonly unitId: string }
  | { readonly kind: 'rejected'; readonly rowIndex: number; readonly errors: readonly CellError[] };

export interface ParsedPreview {
  readonly mapping: PreviewMapping;
  readonly rowCount: number;
  readonly accepted: readonly Extract<PreviewRowVerdict, { kind: 'accepted' }>[];
  readonly duplicates: readonly Extract<PreviewRowVerdict, { kind: 'duplicate' }>[];
  readonly rejected: readonly Extract<PreviewRowVerdict, { kind: 'rejected' }>[];
  readonly batchErrors: readonly CellError[];
}

// ---------------------------------------------------------------------------
// Fixture-backed lookups (the browser's view of the world)
// ---------------------------------------------------------------------------

export interface PreviewStream {
  readonly id: string;
  readonly stationId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  readonly methodTypeId: string;
  readonly validRangeMin: number | null;
  readonly validRangeMax: number | null;
  readonly timeZone: string;
}

const previewStreams = new Map<string, PreviewStream>();
const stationStreamIds = new Map<string, string[]>();
for (const station of stations) {
  const ids: string[] = [];
  for (const stream of station.datastreams as DatastreamRecord[]) {
    previewStreams.set(stream.id, {
      id: stream.id,
      stationId: stream.stationId,
      observedPropertyId: stream.observedPropertyId,
      unitId: stream.unitId,
      methodTypeId: stream.methodTypeId,
      validRangeMin: stream.validRangeMin ?? null,
      validRangeMax: stream.validRangeMax ?? null,
      timeZone: stream.timeZone,
    });
    ids.push(stream.id);
  }
  stationStreamIds.set(station.id, ids);
}
const stationNameById = new Map(stations.map((station) => [station.id, station.displayName]));
const unitDimensionById = new Map(vocabulary.units.map((unit) => [unit.id, unit.dimension]));
const propertyDimensionById = new Map(vocabulary.observedProperties.map((property) => [property.id, property.dimension]));

/** All streams, for the entry pickers (scope filtering is the server's job). */
export const ENTRY_STREAMS: readonly PreviewStream[] = [...previewStreams.values()];
export const ENTRY_UNITS = vocabulary.units.map((unit) => ({ id: unit.id, name: unit.name, dimension: unit.dimension }));
export const DENVER_OFFSETS = [
  { id: '-07:00', label: 'MST (UTC-07:00)' },
  { id: '-06:00', label: 'MDT (UTC-06:00)' },
  { id: 'Z', label: 'UTC (Z)' },
] as const;

export function streamDisplayName(streamId: string): string {
  const stream = previewStreams.get(streamId);
  if (!stream) return streamId;
  const station = stationNameById.get(stream.stationId) ?? stream.stationId;
  return `${station} - ${stream.observedPropertyId} (${stream.unitId})`;
}

// Fixture observation keys (the browser can only know fixture rows; the
// server re-checks duplicates against everything at validate and commit).
const fixtureKeyOwners = new Map<string, string>();
for (const observation of observations) {
  fixtureKeyOwners.set(observation.logicalKey, observation.id);
}

export interface PreviewParseOptions {
  readonly defaultStreamId?: string | null;
  /** Row ids already known locally (fixture + nothing else by default). */
  readonly knownKeys?: ReadonlyMap<string, string>;
}

/**
 * Parse a paste into the staged preview - the exact mirror of the server's
 * parseStagedBatch minus authorization (documented above). Deterministic.
 */
export function parsePastePreview(text: string, options: PreviewParseOptions = {}): ParsedPreview {
  const knownKeys = options.knownKeys ?? fixtureKeyOwners;
  const lines = pasteLines(text);
  const batchErrors: CellError[] = [];
  if (lines.length === 0) {
    return emptyPreview(',', [], [cellError(0, null, null, 'EMPTY_PASTE', 'the paste is empty; expected a header row and at least one data row', '')]);
  }
  const delimiter = detectDelimiter(text);
  const headerCells = splitLine(lines[0] ?? '', delimiter);
  const { columns, unknownColumns } = mapHeader(headerCells);

  if (columns.value === undefined) {
    batchErrors.push(cellError(0, 'value', null, 'COLUMN_REQUIRED', 'a value column (header "value") is required', mappedColumnList(columns)));
  }
  if (columns.datetime === undefined && columns.date === undefined) {
    batchErrors.push(cellError(0, 'date', null, 'COLUMN_REQUIRED', 'a date or datetime column is required', mappedColumnList(columns)));
  }

  const accepted: Extract<PreviewRowVerdict, { kind: 'accepted' }>[] = [];
  const duplicates: Extract<PreviewRowVerdict, { kind: 'duplicate' }>[] = [];
  const rejected: Extract<PreviewRowVerdict, { kind: 'rejected' }>[] = [];
  const seenInBatch = new Map<string, number>();

  const dataLines = lines.slice(1);
  dataLines.forEach((line, index) => {
    const rowIndex = index + 1;
    const cells = splitLine(line, delimiter);
    const at = (key: ColumnKey): string => {
      const column = columns[key];
      return column === undefined ? '' : (cells[column] ?? '').trim();
    };
    const indexOf = (key: ColumnKey): number | null => (columns[key] === undefined ? null : columns[key] ?? null);
    const errors: CellError[] = [];

    // --- stream resolution (accepts display names for stations) -----------
    let stream: PreviewStream | null = null;
    const streamCell = at('stream');
    const stationCell = at('station');
    if (streamCell !== '') {
      stream = previewStreams.get(streamCell) ?? null;
      if (!stream) errors.push(cellError(rowIndex, 'stream', indexOf('stream'), 'STREAM_UNKNOWN', `stream "${streamCell}" does not exist`, streamCell));
    } else if (stationCell !== '') {
      // Station ids only: display names are never identifiers (fixture
      // axis-order/identifier contract) - exact mirror of the server parser.
      const ids = stationStreamIds.get(stationCell);
      if (!ids || ids.length === 0) {
        errors.push(cellError(rowIndex, 'station', indexOf('station'), 'STATION_UNKNOWN', `station "${stationCell}" does not exist`, stationCell));
      } else if (ids.length === 1) {
        stream = previewStreams.get(ids[0] ?? '') ?? null;
      } else {
        errors.push(cellError(rowIndex, 'stream', null, 'STREAM_UNRESOLVED', `station "${stationCell}" has ${ids.length} streams; add a stream column or bind the batch to one stream`, stationCell));
      }
    } else if (options.defaultStreamId) {
      stream = previewStreams.get(options.defaultStreamId) ?? null;
    } else {
      errors.push(cellError(rowIndex, 'stream', null, 'STREAM_UNRESOLVED', 'no stream or station column and the batch is not bound to a default stream', ''));
    }

    // --- time resolution ---------------------------------------------------
    let time: ResolvedTime | null = null;
    const datetimeCell = at('datetime');
    const dateCell = at('date');
    const timeCell = at('time');
    const offsetCell = at('offset');
    if (datetimeCell !== '') {
      const parsed = parseDateTimeWithOffset(datetimeCell);
      if (!parsed) {
        errors.push(cellError(rowIndex, 'datetime', indexOf('datetime'), 'TIME_UNPARSEABLE', `datetime "${datetimeCell}" is not ISO 8601 (with optional offset)`, datetimeCell));
      } else if (/\s*(Z|[+-]\d{2}:?\d{2}|[+-]\d{2})$/i.test(datetimeCell.trim())) {
        time = { observedAt: formatUtcSecondPrecision(parsed.epochMs), sourceOffset: parsed.offsetMinutes === 0 ? 'Z' : formatOffset(parsed.offsetMinutes) };
      } else {
        const asUtc = new Date(parsed.epochMs);
        time = resolveDenverLocal(asUtc.getUTCFullYear(), asUtc.getUTCMonth() + 1, asUtc.getUTCDate(), asUtc.getUTCHours(), asUtc.getUTCMinutes(), asUtc.getUTCSeconds(), rowIndex, 'datetime', indexOf('datetime'), datetimeCell, errors);
      }
    } else if (dateCell !== '') {
      const date = parseDateCell(dateCell);
      if (!date) {
        errors.push(cellError(rowIndex, 'date', indexOf('date'), 'DATE_UNPARSEABLE', `date "${dateCell}" is not a supported format (YYYY-MM-DD, M/D/YYYY)`, dateCell));
      } else {
        let hour = 0;
        let minute = 0;
        let second = 0;
        if (timeCell !== '') {
          const timeOfDay = parseTimeCell(timeCell);
          if (!timeOfDay) {
            errors.push(cellError(rowIndex, 'time', indexOf('time'), 'TIME_UNPARSEABLE', `time "${timeCell}" must be HH:mm[:ss] (24h) or h:mm AM/PM`, timeCell));
          } else {
            hour = timeOfDay.hour;
            minute = timeOfDay.minute;
            second = timeOfDay.second;
          }
        }
        if (offsetCell !== '') {
          const offset = parseOffsetCell(offsetCell);
          if (offset === null) {
            errors.push(cellError(rowIndex, 'offset', indexOf('offset'), 'OFFSET_UNPARSEABLE', `offset "${offsetCell}" must be Z, +/-HH:MM, +/-HHMM, +/-HH, MST or MDT`, offsetCell));
          } else {
            const epochMs = Date.UTC(date.year, date.month - 1, date.day, hour, minute, second) - offset * 60_000;
            time = { observedAt: formatUtcSecondPrecision(epochMs), sourceOffset: offset === 0 ? 'Z' : formatOffset(offset) };
          }
        } else if (stream && stream.timeZone !== 'America/Denver') {
          errors.push(cellError(rowIndex, 'offset', null, 'TIMEZONE_UNKNOWN', `stream time zone "${stream.timeZone}" has no offset column support; paste an explicit offset column`, ''));
        } else if (errors.length === 0 || errors.every((error) => error.code === 'STREAM_UNKNOWN')) {
          time = resolveDenverLocal(date.year, date.month, date.day, hour, minute, second, rowIndex, 'time', indexOf('time'), timeCell, errors);
        }
      }
    } else {
      errors.push(cellError(rowIndex, 'date', null, 'DATE_REQUIRED', 'row has no date or datetime cell', ''));
    }

    // --- value -------------------------------------------------------------
    const valueCell = at('value');
    let value: number | null = null;
    if (valueCell === '') {
      errors.push(cellError(rowIndex, 'value', indexOf('value'), 'VALUE_REQUIRED', 'value is required; a missing reading is an error, never zero', ''));
    } else {
      const numeric = Number(valueCell);
      if (Number.isNaN(numeric)) {
        errors.push(cellError(rowIndex, 'value', indexOf('value'), 'VALUE_NOT_NUMERIC', `value "${valueCell}" is not a number`, valueCell));
      } else if (!Number.isFinite(numeric)) {
        errors.push(cellError(rowIndex, 'value', indexOf('value'), 'VALUE_NOT_FINITE', `value "${valueCell}" is not finite`, valueCell));
      } else {
        value = numeric;
      }
    }

    // --- unit ---------------------------------------------------------------
    const unitCell = at('unit');
    let unitId = stream?.unitId ?? '';
    if (unitCell !== '') {
      const dimension = unitDimensionById.get(unitCell) ?? null;
      if (dimension === null) {
        errors.push(cellError(rowIndex, 'unit', indexOf('unit'), 'UNIT_UNKNOWN', `unit "${unitCell}" is not in the governed vocabulary`, unitCell));
      } else {
        unitId = unitCell;
      }
    }
    if (stream && unitId !== '' && errors.every((error) => error.code !== 'UNIT_UNKNOWN')) {
      if (!unitCompatible(stream, unitId)) {
        const dimension = unitDimensionById.get(unitId) ?? '';
        errors.push(cellError(rowIndex, 'unit', indexOf('unit'), 'UNIT_DIMENSION_MISMATCH', `unit "${unitId}" (${dimension}) is incompatible with the stream's observed property "${stream.observedPropertyId}"; conversions across dimensions are rejected`, unitCell || unitId));
      }
    }

    // --- range + method -------------------------------------------------------
    if (stream && value !== null) {
      const min = stream.validRangeMin ?? Number.NEGATIVE_INFINITY;
      const max = stream.validRangeMax ?? Number.POSITIVE_INFINITY;
      if (value < min || value > max) {
        errors.push(cellError(rowIndex, 'value', indexOf('value'), 'VALUE_OUT_OF_RANGE', `value ${value} is outside the stream's valid range [${stream.validRangeMin}, ${stream.validRangeMax}] ${stream.unitId}`, valueCell));
      }
    }
    const methodCell = at('method');
    if (stream && methodCell !== '' && methodCell !== stream.methodTypeId) {
      errors.push(cellError(rowIndex, 'method', indexOf('method'), 'METHOD_MISMATCH', `method "${methodCell}" does not match the stream's measurement method "${stream.methodTypeId}"`, methodCell));
    }

    if (errors.length > 0) {
      rejected.push({ kind: 'rejected', rowIndex, errors });
      return;
    }
    if (!stream || !time || value === null) {
      rejected.push({ kind: 'rejected', rowIndex, errors: [cellError(rowIndex, null, null, 'ROW_INCOMPLETE', 'row could not be resolved', line)] });
      return;
    }

    const logicalKey = `${stream.id}:${time.observedAt}`;
    const firstRowIndex = seenInBatch.get(logicalKey);
    if (firstRowIndex !== undefined) {
      duplicates.push({ kind: 'duplicate', rowIndex, streamId: stream.id, logicalKey, against: 'batch', existingId: null, firstRowIndex, time, value, unitId });
      return;
    }
    const existingOwner = knownKeys.get(logicalKey);
    if (existingOwner !== undefined) {
      duplicates.push({ kind: 'duplicate', rowIndex, streamId: stream.id, logicalKey, against: 'store', existingId: existingOwner, firstRowIndex: null, time, value, unitId });
      return;
    }
    seenInBatch.set(logicalKey, rowIndex);
    accepted.push({
      kind: 'accepted',
      rowIndex,
      streamId: stream.id,
      time,
      value,
      unitId,
      logicalKey,
      methodTypeId: stream.methodTypeId,
      note: at('note') !== '' ? at('note') : null,
    });
  });

  if (dataLines.length === 0) {
    batchErrors.push(cellError(0, null, null, 'NO_DATA_ROWS', 'the paste has a header but no data rows', ''));
  }

  return { mapping: { delimiter, columns, unknownColumns, headerCells }, rowCount: dataLines.length, accepted, duplicates, rejected, batchErrors };
}

function unitCompatible(stream: PreviewStream, unitId: string): boolean {
  if (unitId === stream.unitId) return true;
  const expected = propertyDimensionById.get(stream.observedPropertyId) ?? null;
  const actual = unitDimensionById.get(unitId) ?? null;
  return expected !== null && actual !== null && actual === expected;
}

function resolveDenverLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  rowIndex: number,
  columnKey: ColumnKey,
  columnIndex: number | null,
  cellValue: string,
  errors: CellError[],
): ResolvedTime | null {
  const resolved = denverLocalToUtc(year, month, day, hour, minute, second);
  if (resolved.kind === 'nonexistent') {
    errors.push(cellError(rowIndex, columnKey, columnIndex, 'LOCAL_TIME_NONEXISTENT', `local time ${cellValue || `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}`} does not exist on the ${year} spring-forward date (02:00-02:59 is skipped in America/Denver)`, cellValue));
    return null;
  }
  if (resolved.kind === 'ambiguous') {
    errors.push(cellError(rowIndex, columnKey, columnIndex, 'LOCAL_TIME_AMBIGUOUS', `local time ${cellValue || `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}`} occurs twice on the ${year} fall-back date in America/Denver; add an explicit offset column (MDT -06:00 or MST -07:00)`, cellValue));
    return null;
  }
  return { observedAt: formatUtcSecondPrecision(resolved.epochMs), sourceOffset: formatOffset(resolved.offsetMinutes) };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function cellError(rowIndex: number, columnKey: ColumnKey | null, columnIndex: number | null, code: string, message: string, cellValue: string): CellError {
  return { rowIndex, columnKey, columnIndex, code, message, cellValue };
}

function mappedColumnList(columns: Partial<Record<ColumnKey, number>>): string {
  // Same ordering as the server's joinMissing: canonical key order.
  return KNOWN_COLUMN_KEYS.filter((key) => columns[key] !== undefined).join(',');
}

function emptyPreview(delimiter: ',' | '\t' | ';', headerCells: readonly string[], batchErrors: CellError[]): ParsedPreview {
  return { mapping: { delimiter, columns: mapHeader(headerCells).columns, unknownColumns: [], headerCells }, rowCount: 0, accepted: [], duplicates: [], rejected: [], batchErrors };
}

// ---------------------------------------------------------------------------
// Manual entry form state machine (FR-020)
// ---------------------------------------------------------------------------

export interface ManualFormValues {
  readonly streamId: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly offset: string;
  readonly value: string;
  readonly unitId: string;
  readonly note: string;
}

export const EMPTY_MANUAL_FORM: ManualFormValues = {
  streamId: '',
  localDate: '',
  localTime: '',
  offset: '-07:00',
  value: '',
  unitId: '',
  note: '',
};

export interface ManualFormState {
  readonly phase: 'editing' | 'submitting' | 'saved' | 'error';
  readonly values: ManualFormValues;
  /** Field -> message; validation identifies the offending field (FR-020). */
  readonly fieldErrors: Readonly<Record<string, string>>;
  /** The saved record identifier returned by the server (FR-020). */
  readonly savedRecordId: string | null;
  readonly submitMessage: string | null;
}

export const INITIAL_MANUAL_FORM: ManualFormState = {
  phase: 'editing',
  values: EMPTY_MANUAL_FORM,
  fieldErrors: {},
  savedRecordId: null,
  submitMessage: null,
};

export type ManualFormEvent =
  | { readonly type: 'edit'; readonly field: keyof ManualFormValues; readonly value: string }
  | { readonly type: 'validate' }
  | { readonly type: 'submit-start' }
  | { readonly type: 'submit-ok'; readonly recordId: string; readonly duplicate: boolean }
  | { readonly type: 'submit-field-errors'; readonly errors: Readonly<Record<string, string>> }
  | { readonly type: 'submit-failed'; readonly message: string }
  | { readonly type: 'reset' };

/**
 * Pure client-side validation mirroring manualEntry.validateManualEntry's
 * field verdicts: explicit offset, finite value in range, unit compatibility,
 * method defaults from the stream. The SERVER re-validates; this only
 * identifies the offending field before submission.
 */
export function validateManualForm(values: ManualFormValues): Readonly<Record<string, string>> {
  const errors: Record<string, string> = {};
  if (!values.streamId) errors.streamId = 'Choose the stream this reading belongs to.';
  if (!values.localDate) errors.localDate = 'Date is required (YYYY-MM-DD).';
  if (!values.localTime) errors.localTime = 'Time is required (HH:mm, 24-hour local clock).';
  else if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(values.localTime.trim())) errors.localTime = 'Time must be HH:mm or HH:mm:ss.';
  if (!values.offset) errors.offset = 'Choose the UTC offset in effect when the reading was taken.';
  if (values.value.trim() === '') errors.value = 'Value is required; a missing reading is not zero.';
  else {
    const numeric = Number(values.value);
    if (Number.isNaN(numeric) || !Number.isFinite(numeric)) errors.value = 'Value must be a finite number.';
    else {
      const stream = previewStreams.get(values.streamId);
      if (stream && (numeric < (stream.validRangeMin ?? Number.NEGATIVE_INFINITY) || numeric > (stream.validRangeMax ?? Number.POSITIVE_INFINITY))) {
        errors.value = `Value is outside the stream's valid range [${stream.validRangeMin}, ${stream.validRangeMax}] ${stream.unitId}.`;
      }
    }
  }
  if (!values.unitId) errors.unitId = 'Unit is required.';
  else {
    const stream = previewStreams.get(values.streamId);
    if (stream && !unitCompatible(stream, values.unitId)) {
      errors.unitId = `Unit ${values.unitId} does not measure ${stream.observedPropertyId}; cross-dimension conversions are rejected.`;
    }
  }
  return errors;
}

/** Compose the ISO instant the form will submit (explicit offset, FR-020). */
export function composedObservedAt(values: ManualFormValues): string | null {
  if (!values.localDate || !values.localTime) return null;
  const date = parseDateCell(values.localDate);
  const time = parseTimeCell(values.localTime);
  const offset = parseOffsetCell(values.offset);
  if (!date || !time || offset === null) return null;
  const epochMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, time.second) - offset * 60_000;
  return formatUtcSecondPrecision(epochMs);
}

export function manualFormReducer(state: ManualFormState, event: ManualFormEvent): ManualFormState {
  switch (event.type) {
    case 'edit': {
      // Valid inputs are always preserved: editing clears only that field's
      // error, never the values (FR-020).
      const values = { ...state.values, [event.field]: event.value };
      const nextErrors = { ...state.fieldErrors };
      delete nextErrors[event.field];
      return { ...state, phase: 'editing', values, fieldErrors: nextErrors, submitMessage: null };
    }
    case 'validate': {
      const fieldErrors = validateManualForm(state.values);
      return { ...state, phase: Object.keys(fieldErrors).length > 0 ? 'editing' : 'editing', fieldErrors };
    }
    case 'submit-start':
      return { ...state, phase: 'submitting', submitMessage: null };
    case 'submit-ok':
      return {
        ...state,
        phase: 'saved',
        savedRecordId: event.recordId,
        fieldErrors: {},
        submitMessage: event.duplicate
          ? `This reading already exists - the original record ${event.recordId} was returned. No duplicate row was created.`
          : `Saved. Record identifier: ${event.recordId}`,
      };
    case 'submit-field-errors':
      // The server identified offending fields; the form keeps every value.
      return { ...state, phase: 'error', fieldErrors: event.errors, submitMessage: 'The reading was not saved - fix the flagged fields and submit again.' };
    case 'submit-failed':
      return { ...state, phase: 'error', submitMessage: event.message };
    case 'reset':
      return { ...INITIAL_MANUAL_FORM, values: { ...EMPTY_MANUAL_FORM, offset: state.values.offset } };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Bulk paste flow state machine (FR-021: paste -> validate -> review ->
// explicit commit, with the atomic/partial mode choice)
// ---------------------------------------------------------------------------

export type ImportModeChoice = 'atomic' | 'partial';

export type BulkFlowPhase =
  | 'paste'
  | 'mapping'
  | 'validated'
  | 'committing'
  | 'committed'
  | 'refused';

export interface BulkFlowState {
  readonly phase: BulkFlowPhase;
  readonly text: string;
  readonly defaultStreamId: string | null;
  readonly mode: ImportModeChoice;
  readonly preview: ParsedPreview | null;
  readonly commitSummary: { readonly inserted: number; readonly duplicates: number; readonly skipped: number } | null;
  readonly refusalMessage: string | null;
  readonly batchId: string | null;
}

export const INITIAL_BULK_FLOW: BulkFlowState = {
  phase: 'paste',
  text: '',
  defaultStreamId: null,
  mode: 'atomic',
  preview: null,
  commitSummary: null,
  refusalMessage: null,
  batchId: null,
};

export type BulkFlowEvent =
  | { readonly type: 'set-text'; readonly text: string }
  | { readonly type: 'set-stream'; readonly streamId: string | null }
  | { readonly type: 'set-mode'; readonly mode: ImportModeChoice }
  | { readonly type: 'to-mapping' }
  | { readonly type: 'validated'; readonly batchId: string; readonly preview: ParsedPreview }
  | { readonly type: 'commit-start' }
  | { readonly type: 'committed'; readonly batchId: string; readonly inserted: number; readonly duplicates: number; readonly skipped: number }
  | { readonly type: 'refused'; readonly message: string }
  | { readonly type: 'back-to-paste' };

export function bulkFlowReducer(state: BulkFlowState, event: BulkFlowEvent): BulkFlowState {
  switch (event.type) {
    case 'set-text':
      return { ...state, text: event.text, phase: 'paste', preview: null, commitSummary: null, refusalMessage: null };
    case 'set-stream':
      return { ...state, defaultStreamId: event.streamId };
    case 'set-mode':
      return { ...state, mode: event.mode };
    case 'to-mapping':
      if (state.text.trim() === '') return { ...state, refusalMessage: 'Paste data (or upload a CSV/TSV file) before mapping columns.' };
      return { ...state, phase: 'mapping', refusalMessage: null };
    case 'validated':
      return { ...state, phase: 'validated', preview: event.preview, batchId: event.batchId, refusalMessage: null };
    case 'commit-start':
      if (state.phase !== 'validated') return { ...state, refusalMessage: 'Validate the batch before committing.' };
      return { ...state, phase: 'committing', refusalMessage: null };
    case 'committed':
      return {
        ...state,
        phase: 'committed',
        commitSummary: { inserted: event.inserted, duplicates: event.duplicates, skipped: event.skipped },
      };
    case 'refused':
      // Atomic refusal or scope change: back to the validated preview with
      // the exact message; the user fixes rows or revalidates - retrying
      // never duplicates (the server replays the same batch id).
      return { ...state, phase: state.phase === 'committing' ? 'validated' : state.phase, refusalMessage: event.message };
    case 'back-to-paste':
      return { ...INITIAL_BULK_FLOW, text: state.text, defaultStreamId: state.defaultStreamId, mode: state.mode };
    default:
      return state;
  }
}
