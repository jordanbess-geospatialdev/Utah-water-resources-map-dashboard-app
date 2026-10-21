/**
 * Staged bulk paste import (WD-010, FR-021): POST /imports, POST
 * /imports/{id}/validate, POST /imports/{id}/commit.
 *
 * Batch model: created -> validated -> committed | rejected (terminal).
 *
 * - validateStage parses the pasted CSV/TSV text with header mapping,
 *   locale date formats and explicit offsets, and reports EVERY row's
 *   verdict (accepted / duplicate / rejected with row+column+reason) -
 *   whole-batch validation, never first-error-only.
 * - Duplicate detection runs BOTH within the batch and against existing
 *   store rows; duplicates are REPORTED, never silently skipped.
 * - Commit re-verifies per row: actor scope (policy engine), the actor's
 *   grant version captured at validate time, each stream's CURRENT setup
 *   version, and store duplicates at commit time. A grant change between
 *   validate and commit rejects the batch.
 * - Atomic mode (the documented default) refuses to commit any row when the
 *   validated batch contains a rejected row, returning the exact cell
 *   errors. Partial mode is the documented alternative: accepted rows
 *   commit, rejected rows and duplicates are reported precisely.
 * - Replaying commit on a committed batch returns the ORIGINAL result
 *   (idempotent); retrying the same paste as a NEW batch yields duplicate
 *   reports against the store and inserts nothing - retries never create
 *   duplicate readings.
 * - Every commit appends one audit event and one transactional-outbox
 *   publication-refresh event covering the touched streams (ADR-10).
 *
 * The parse half (parseStagedBatch) is pure and port-injected so the web
 * preview (apps/web/src/features/data-entry/entryModel.ts) mirrors it
 * exactly; the parity test asserts identical verdicts.
 */
import {
  evaluate,
  type AuthorizationRequest,
  type DecisionReason,
} from '../../../../../packages/policy/src/index.ts';
import type { ReadingsStore } from './store.ts';
import { DEFAULT_IMPORT_MODE } from './store.ts';
import {
  denverLocalToUtc,
  denverOffsetMinutesAt,
  detectDelimiter,
  formatOffset,
  formatUtcSecondPrecision,
  mapHeader,
  parseDateCell,
  parseDateTimeWithOffset,
  parseOffsetCell,
  parseTimeCell,
  pasteLines,
  splitLine,
} from './pasteFormat.ts';
import type {
  CellError,
  ColumnKey,
  CommitImportDecision,
  CreateImportDecision,
  EntryContext,
  HeaderMapping,
  ImportBatchRecord,
  ImportCommitResult,
  ImportMode,
  ImportRejection,
  ParsedBatch,
  ReadingRow,
  ResolvedTime,
  RowVerdict,
  StationAnchor,
  ValidateImportDecision,
} from './types.ts';
import { ENTRY_CAPABILITY } from './manualEntry.ts';

type AcceptedRow = Extract<RowVerdict, { kind: 'accepted' }>;
type DuplicateRow = Extract<RowVerdict, { kind: 'duplicate' }>;
type RejectedRow = Extract<RowVerdict, { kind: 'rejected' }>;

// ---------------------------------------------------------------------------
// Parse ports (injected so the web mirror runs the same logic)
// ---------------------------------------------------------------------------

/** Minimal stream-definition surface the parser needs (web mirror satisfies it from fixture data). */
export interface StreamLookup {
  readonly id: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  readonly methodTypeId: string;
  readonly validRangeMin: number | null;
  readonly validRangeMax: number | null;
  readonly timeZone: string;
}

export interface ParseDeps {
  streamById(streamId: string): StreamLookup | null;
  stationById(stationId: string): Pick<StationAnchor, 'id' | 'streamIds'> | null;
  unitDimension(unitId: string): string | null;
  propertyDimension(propertyId: string): string | null;
  /** Per-row policy verdict; omit for a parse-only preview (web mirror). */
  policyForRow?(streamId: string): { allowed: true } | { allowed: false; reason: DecisionReason | string };
  /** Existing-store duplicate lookup; omit for a parse-only preview. */
  existingByKey?(logicalKey: string): { id: string } | null;
}

export interface ParseOptions {
  /** Stream bound at batch creation; per-row stream/station columns override. */
  readonly defaultStreamId?: string | null;
}

const SUPPORTED_ZONE = 'America/Denver';

/**
 * A unit is compatible with a stream when it IS the stream's canonical unit
 * (the fixture defines stage streams in ft even though the vocabulary calls
 * the property dimension "level" and the unit dimension "length"), or when
 * the property and unit dimensions match. Conversions ACROSS dimensions
 * (e.g. cfs pasted onto a stage stream, volts onto discharge) are rejected.
 * Exported for manualEntry (same rule) and mirrored in the web preview.
 */
export function unitCompatible(
  deps: Pick<ParseDeps, 'unitDimension' | 'propertyDimension'>,
  stream: Pick<StreamLookup, 'unitId' | 'observedPropertyId'>,
  unitId: string,
): boolean {
  if (unitId === stream.unitId) return true;
  const expected = deps.propertyDimension(stream.observedPropertyId);
  const actual = deps.unitDimension(unitId);
  return expected !== null && actual !== null && actual === expected;
}

function cellError(rowIndex: number, columnKey: ColumnKey | null, columnIndex: number | null, code: string, message: string, cellValue: string): CellError {
  return { rowIndex, columnKey, columnIndex, code, message, cellValue };
}

/**
 * Parse and validate the whole pasted batch. Pure: every external fact is a
 * port on `deps`. Rows are verdicted in paste order; a row can carry
 * multiple cell errors. Deterministic - identical text and deps produce
 * identical results.
 */
export function parseStagedBatch(deps: ParseDeps, text: string, options: ParseOptions = {}): ParsedBatch {
  const lines = pasteLines(text);
  const batchErrors: CellError[] = [];
  if (lines.length === 0) {
    return emptyBatch(',', [], batchErrors.concat(cellError(0, null, null, 'EMPTY_PASTE', 'the paste is empty; expected a header row and at least one data row', '')));
  }
  const delimiter = detectDelimiter(text);
  const headerCells = splitLine(lines[0] ?? '', delimiter);
  const { columns, unknownColumns } = mapHeader(headerCells);
  const headerMapping: HeaderMapping = { delimiter, columns, unknownColumns, headerCells };

  if (columns.value === undefined) {
    batchErrors.push(cellError(0, 'value', null, 'COLUMN_REQUIRED', 'a value column (header "value") is required', joinMissing(columns)));
  }
  const hasAnyTimeColumn = columns.datetime !== undefined || columns.date !== undefined;
  if (!hasAnyTimeColumn) {
    batchErrors.push(cellError(0, 'date', null, 'COLUMN_REQUIRED', 'a date or datetime column is required', joinMissing(columns)));
  }

  const accepted: AcceptedRow[] = [];
  const duplicates: DuplicateRow[] = [];
  const rejected: RejectedRow[] = [];
  const seenInBatch = new Map<string, { rowIndex: number; id: string | null }>();

  const dataLines = lines.slice(1);
  dataLines.forEach((line, index) => {
    const rowIndex = index + 1; // 1-based data row index (header is row 0)
    const cells = splitLine(line, delimiter);
    const at = (key: ColumnKey): string => (columns[key] === undefined ? '' : (cells[columns[key] as number] ?? '').trim());
    const indexOf = (key: ColumnKey): number | null => (columns[key] === undefined ? null : columns[key] as number);
    const errors: CellError[] = [];

    // --- stream resolution --------------------------------------------------
    let stream: StreamLookup | null = null;
    const streamCell = at('stream');
    const stationCell = at('station');
    if (streamCell !== '') {
      stream = deps.streamById(streamCell);
      if (!stream) errors.push(cellError(rowIndex, 'stream', indexOf('stream'), 'STREAM_UNKNOWN', `stream "${streamCell}" does not exist`, streamCell));
    } else if (stationCell !== '') {
      const station = deps.stationById(stationCell);
      if (!station) {
        errors.push(cellError(rowIndex, 'station', indexOf('station'), 'STATION_UNKNOWN', `station "${stationCell}" does not exist`, stationCell));
      } else if (station.streamIds.length === 1) {
        stream = deps.streamById(station.streamIds[0] ?? '');
      } else {
        errors.push(cellError(rowIndex, 'stream', null, 'STREAM_UNRESOLVED', `station "${stationCell}" has ${station.streamIds.length} streams; add a stream column or bind the batch to one stream`, stationCell));
      }
    } else if (options.defaultStreamId) {
      stream = deps.streamById(options.defaultStreamId);
    } else {
      errors.push(cellError(rowIndex, 'stream', null, 'STREAM_UNRESOLVED', 'no stream or station column and the batch is not bound to a default stream', ''));
    }

    // --- time resolution ----------------------------------------------------
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
        const resolved = resolveDenverLocal(datetimeCellToParts(parsed), rowIndex, 'datetime', indexOf('datetime'), datetimeCell, errors);
        time = resolved;
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
            // Explicit offset: the instant is exact; no DST ambiguity applies.
            const epochMs = Date.UTC(date.year, date.month - 1, date.day, hour, minute, second) - offset * 60_000;
            time = { observedAt: formatUtcSecondPrecision(epochMs), sourceOffset: offset === 0 ? 'Z' : formatOffset(offset) };
          }
        } else if (stream && stream.timeZone !== SUPPORTED_ZONE) {
          errors.push(cellError(rowIndex, 'offset', null, 'TIMEZONE_UNKNOWN', `stream time zone "${stream.timeZone}" has no offset column support; paste an explicit offset column`, ''));
        } else if (errors.length === 0 || errors.every((e) => e.code === 'STREAM_UNKNOWN')) {
          time = resolveDenverLocal({ year: date.year, month: date.month, day: date.day, hour, minute, second }, rowIndex, 'time', indexOf('time'), timeCell, errors);
        }
      }
    } else {
      errors.push(cellError(rowIndex, 'date', null, 'DATE_REQUIRED', 'row has no date or datetime cell', ''));
    }

    // --- value ---------------------------------------------------------------
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

    // --- unit -----------------------------------------------------------------
    const unitCell = at('unit');
    let unitId = stream?.unitId ?? '';
    if (unitCell !== '') {
      const dimension = deps.unitDimension(unitCell);
      if (dimension === null) {
        errors.push(cellError(rowIndex, 'unit', indexOf('unit'), 'UNIT_UNKNOWN', `unit "${unitCell}" is not in the governed vocabulary`, unitCell));
      } else {
        unitId = unitCell;
      }
    }
    if (stream && unitId !== '' && errors.every((error) => error.code !== 'UNIT_UNKNOWN')) {
      if (!unitCompatible(deps, stream, unitId)) {
        const actual = deps.unitDimension(unitId) ?? '';
        errors.push(
          cellError(rowIndex, 'unit', indexOf('unit'), 'UNIT_DIMENSION_MISMATCH', `unit "${unitId}" (${actual}) is incompatible with the stream's observed property "${stream.observedPropertyId}"; conversions across dimensions are rejected`, unitCell || unitId),
        );
      }
    }

    // --- range + method ---------------------------------------------------------
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

    // --- per-row policy (server side only) ---------------------------------------
    if (stream && deps.policyForRow) {
      const verdict = deps.policyForRow(stream.id);
      if (!verdict.allowed) {
        const reason = String(verdict.reason);
        const code = reason === 'DENY_LIFECYCLE_STATE' ? 'ROW_LIFECYCLE_CLOSED' : 'ROW_OUT_OF_SCOPE';
        errors.push(cellError(rowIndex, null, null, code, `actor is not permitted to enter readings on stream "${stream.id}" (${reason})`, ''));
      }
    }

    if (errors.length > 0) {
      rejected.push({ kind: 'rejected', rowIndex, errors });
      return;
    }
    if (!stream || !time || value === null) {
      // Defensive: any missing resolution must have produced an error above.
      rejected.push({ kind: 'rejected', rowIndex, errors: [cellError(rowIndex, null, null, 'ROW_INCOMPLETE', 'row could not be resolved', line)] });
      return;
    }

    const logicalKey = `${stream.id}:${time.observedAt}`;
    const batchSeen = seenInBatch.get(logicalKey);
    if (batchSeen) {
      duplicates.push({ kind: 'duplicate', rowIndex, streamId: stream.id, logicalKey, against: 'batch', existingId: batchSeen.id, firstRowIndex: batchSeen.rowIndex, time, value, unitId });
      return;
    }
    if (deps.existingByKey) {
      const existing = deps.existingByKey(logicalKey);
      if (existing) {
        duplicates.push({ kind: 'duplicate', rowIndex, streamId: stream.id, logicalKey, against: 'store', existingId: existing.id, firstRowIndex: null, time, value, unitId });
        return;
      }
    }
    seenInBatch.set(logicalKey, { rowIndex, id: null });
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

  return { mapping: headerMapping, rowCount: dataLines.length, accepted, duplicates, rejected, batchErrors };
}

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function datetimeCellToParts(parsed: { epochMs: number }): LocalDateTimeParts {
  // Re-derive local wall parts from the parsed-as-UTC epoch (parseDateTimeWithOffset
  // with no offset returns the wall components as UTC).
  const asUtc = new Date(parsed.epochMs);
  return {
    year: asUtc.getUTCFullYear(),
    month: asUtc.getUTCMonth() + 1,
    day: asUtc.getUTCDate(),
    hour: asUtc.getUTCHours(),
    minute: asUtc.getUTCMinutes(),
    second: asUtc.getUTCSeconds(),
  };
}

/** Resolve a Denver wall-clock time without an explicit offset (DST rules apply). */
function resolveDenverLocal(
  parts: LocalDateTimeParts,
  rowIndex: number,
  columnKey: ColumnKey,
  columnIndex: number | null,
  cellValue: string,
  errors: CellError[],
): ResolvedTime | null {
  const resolved = denverLocalToUtc(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
  if (resolved.kind === 'nonexistent') {
    errors.push(cellError(rowIndex, columnKey, columnIndex, 'LOCAL_TIME_NONEXISTENT', `local time ${cellValue || `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`} does not exist on the ${parts.year} spring-forward date (02:00-02:59 is skipped in America/Denver)`, cellValue));
    return null;
  }
  if (resolved.kind === 'ambiguous') {
    errors.push(cellError(rowIndex, columnKey, columnIndex, 'LOCAL_TIME_AMBIGUOUS', `local time ${cellValue || `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`} occurs twice on the ${parts.year} fall-back date in America/Denver; add an explicit offset column (MDT -06:00 or MST -07:00)`, cellValue));
    return null;
  }
  return { observedAt: formatUtcSecondPrecision(resolved.epochMs), sourceOffset: formatOffset(resolved.offsetMinutes) };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function joinMissing(columns: Record<string, number | undefined>): string {
  return Object.entries(columns)
    .filter(([, index]) => index !== undefined)
    .map(([key]) => key)
    .join(',');
}

function emptyBatch(delimiter: ',' | '\t' | ';', headerCells: string[], batchErrors: CellError[]): ParsedBatch {
  return {
    mapping: { delimiter, columns: mapHeader(headerCells).columns, unknownColumns: [], headerCells },
    rowCount: 0,
    accepted: [],
    duplicates: [],
    rejected: [],
    batchErrors,
  };
}

// ---------------------------------------------------------------------------
// Server-side deps (real engine + store)
// ---------------------------------------------------------------------------

function serverDeps(store: ReadingsStore, actorId: string, now: string): ParseDeps {
  return {
    streamById: (streamId) => store.streamById(streamId),
    stationById: (stationId) => store.stationById(stationId),
    unitDimension: (unitId) => store.unitDimension(unitId),
    propertyDimension: (propertyId) => store.propertyDimension(propertyId),
    policyForRow: (streamId) => {
      const principal = store.world.principals[actorId] ?? null;
      const request: AuthorizationRequest = {
        principal,
        action: ENTRY_CAPABILITY,
        object: { kind: 'datastream', id: streamId },
      };
      const decision = evaluate(request, store.world, now);
      return decision.effect === 'allow' ? { allowed: true } : { allowed: false, reason: decision.reason };
    },
    existingByKey: (logicalKey) => store.observationByLogicalKey(logicalKey),
  };
}

// ---------------------------------------------------------------------------
// Stage 1: create
// ---------------------------------------------------------------------------

export interface CreateImportInput {
  readonly text: string;
  /** Stream the whole batch is bound to (may be empty when rows carry stream/station columns). */
  readonly defaultStreamId?: string | null;
  readonly mode?: ImportMode;
}

export function createImport(store: ReadingsStore, actorId: string, input: CreateImportInput, ctx: EntryContext): CreateImportDecision {
  const principal = store.world.principals[actorId] ?? null;
  if (!principal) {
    return { outcome: 'forbidden', status: 401, message: 'imports require an authenticated principal', policyReason: 'DENY_UNKNOWN_PRINCIPAL' };
  }
  if (!principal.active) {
    return { outcome: 'forbidden', status: 401, message: 'principal is deactivated', policyReason: 'DENY_PRINCIPAL_INACTIVE' };
  }
  if (input.defaultStreamId) {
    const stream = store.streamById(input.defaultStreamId);
    if (!stream) {
      return { outcome: 'forbidden', status: 404, message: `stream "${input.defaultStreamId}" does not exist`, policyReason: 'DENY_UNKNOWN_OBJECT' };
    }
    const request: AuthorizationRequest = {
      principal,
      action: ENTRY_CAPABILITY,
      object: { kind: 'datastream', id: stream.id },
    };
    const decision = evaluate(request, store.world, ctx.now);
    if (decision.effect !== 'allow') {
      return { outcome: 'forbidden', status: decision.reason === 'DENY_OUT_OF_SCOPE' && stream.visibility !== 'public' ? 404 : 403, message: `actor cannot import into stream "${stream.id}" (${decision.reason})`, policyReason: decision.reason };
    }
  }
  const id = `imp-${String(1000 + store.batches.length + 1)}`;
  const batch: ImportBatchRecord = {
    id,
    actorId,
    createdAt: ctx.now,
    state: 'created',
    rawText: input.text,
    defaultStreamId: input.defaultStreamId ?? null,
    mode: input.mode ?? DEFAULT_IMPORT_MODE,
    createdActorVersion: store.actorVersion(actorId),
    validatedActorVersion: null,
    validatedStreamVersions: {},
    validation: null,
    validatedAt: null,
    commitResult: null,
    committedAt: null,
    rejection: null,
    rejectedAt: null,
  };
  store.recordBatch(batch);
  return { outcome: 'created', batch };
}

// ---------------------------------------------------------------------------
// Stage 2: validate
// ---------------------------------------------------------------------------

export function validateImport(store: ReadingsStore, actorId: string, batchId: string, ctx: EntryContext): ValidateImportDecision {
  const batch = store.batchById(batchId);
  if (!batch || batch.actorId !== actorId) {
    return { outcome: 'not-found', status: 404, message: `import batch "${batchId}" not found` };
  }
  if (batch.state === 'committed' || batch.state === 'rejected') {
    return {
      outcome: 'refused',
      status: 409,
      code: 'BATCH_STATE_INVALID',
      message: `batch "${batchId}" is ${batch.state}; create a new batch to import again`,
      rejection: null,
    };
  }
  const deps = serverDeps(store, actorId, ctx.now);
  const validation = parseStagedBatch(deps, batch.rawText, { defaultStreamId: batch.defaultStreamId });
  const touchedStreams = [...new Set([...validation.accepted, ...validation.duplicates].map((row) => row.streamId))];
  const validatedStreamVersions: Record<string, number> = {};
  for (const streamId of touchedStreams) validatedStreamVersions[streamId] = store.streamSetupVersion(streamId);
  const updated: ImportBatchRecord = {
    ...batch,
    state: 'validated',
    validation,
    validatedAt: ctx.now,
    validatedActorVersion: store.actorVersion(actorId),
    validatedStreamVersions,
  };
  store.recordBatch(updated);
  return { outcome: 'validated', batch: updated };
}

// ---------------------------------------------------------------------------
// Stage 3: commit
// ---------------------------------------------------------------------------

export function commitImport(
  store: ReadingsStore,
  actorId: string,
  batchId: string,
  ctx: EntryContext,
  modeOverride?: ImportMode,
): CommitImportDecision {
  const batch = store.batchById(batchId);
  if (!batch || batch.actorId !== actorId) {
    return { outcome: 'not-found', status: 404, message: `import batch "${batchId}" not found` };
  }
  // Idempotent replay: a committed batch returns the ORIGINAL commit result.
  if (batch.state === 'committed' && batch.commitResult) {
    return { outcome: 'committed', status: 200, replayed: true, result: batch.commitResult };
  }
  if (batch.state === 'rejected' && batch.rejection) {
    return {
      outcome: 'refused',
      status: batch.rejection.status,
      code: 'BATCH_REJECTED',
      message: batch.rejection.message,
      rejection: batch.rejection,
    };
  }
  if (batch.state === 'created') {
    return {
      outcome: 'refused',
      status: 409,
      code: 'BATCH_NOT_VALIDATED',
      message: `batch "${batchId}" has not been validated; run validate first`,
      rejection: null,
    };
  }

  const validation = batch.validation;
  if (!validation) {
    return { outcome: 'refused', status: 409, code: 'BATCH_NOT_VALIDATED', message: 'batch has no validation result', rejection: null };
  }
  const mode: ImportMode = modeOverride ?? batch.mode;
  const now = ctx.now;

  // --- re-verification 1: the actor's grant must be unchanged ---------------
  const currentActorVersion = store.actorVersion(actorId);
  if (batch.validatedActorVersion !== null && currentActorVersion !== batch.validatedActorVersion) {
    return rejectBatch(store, batch, 'SCOPE_CHANGED', 403, `the actor's grant version changed between validate (${batch.validatedActorVersion}) and commit (${currentActorVersion}); revalidate in a new batch`, [], 'GRANT_VERSION_CHANGED', now);
  }
  const principal = store.world.principals[actorId] ?? null;
  if (!principal || !principal.active) {
    return rejectBatch(store, batch, 'SCOPE_CHANGED', 403, 'actor is no longer an active principal; revalidate in a new batch', [], 'DENY_PRINCIPAL_INACTIVE', now);
  }

  // --- re-verification 2: per-row scope via the policy engine ----------------
  const policyVerdicts = new Map<string, { allowed: boolean; reason: string }>();
  for (const row of validation.accepted) {
    if (policyVerdicts.has(row.streamId)) continue;
    const request: AuthorizationRequest = {
      principal,
      action: ENTRY_CAPABILITY,
      object: { kind: 'datastream', id: row.streamId },
    };
    const decision = evaluate(request, store.world, now);
    policyVerdicts.set(row.streamId, { allowed: decision.effect === 'allow', reason: decision.reason });
  }
  const deniedStream = [...policyVerdicts.entries()].find(([, verdict]) => !verdict.allowed);
  if (deniedStream) {
    const [streamId, verdict] = deniedStream;
    return rejectBatch(store, batch, 'SCOPE_CHANGED', 403, `actor is no longer permitted to enter readings on stream "${streamId}" (${verdict.reason}); nothing was committed`, [], verdict.reason, now);
  }

  // --- re-verification 3: stream setup versions -------------------------------
  for (const [streamId, validatedVersion] of Object.entries(batch.validatedStreamVersions)) {
    if (store.streamSetupVersion(streamId) !== validatedVersion) {
      return rejectBatch(
        store,
        batch,
        'STREAM_SETUP_CHANGED',
        409,
        `the measurement setup of stream "${streamId}" changed between validate (v${validatedVersion}) and commit (v${store.streamSetupVersion(streamId)}); revalidate to pick up the new device/method context`,
        [],
        null,
        now,
      );
    }
  }

  // --- atomic mode: one bad row rejects the whole batch ------------------------
  if (mode === 'atomic' && validation.rejected.length > 0) {
    const errors = validation.rejected.flatMap((row) => row.errors);
    return rejectBatch(
      store,
      batch,
      'ATOMIC_VALIDATION_ERRORS',
      422,
      `atomic import refused: ${validation.rejected.length} of ${validation.rowCount} rows failed validation; nothing was committed`,
      errors,
      null,
      now,
    );
  }

  // --- insert, re-verifying store duplicates at commit time --------------------
  const inserted: ReadingRow[] = [];
  const duplicates: DuplicateRow[] = [...validation.duplicates];
  const rowsToInsert: AcceptedRow[] = [];
  for (const row of validation.accepted) {
    const existing = store.observationByLogicalKey(row.logicalKey);
    if (existing) {
      duplicates.push({ ...row, kind: 'duplicate', against: 'store', existingId: existing.id, firstRowIndex: null });
      continue;
    }
    rowsToInsert.push(row);
  }

  const { rows, auditEvent, outboxEvent } = store.appendReadings({
    actorId,
    now,
    idempotencyKey: null,
    idempotencyFingerprint: null,
    rows: rowsToInsert.map((row) => ({
      streamId: row.streamId,
      observedAt: row.time.observedAt,
      sourceOffset: row.time.sourceOffset,
      value: row.value,
      unitId: row.unitId,
      methodTypeId: row.methodTypeId,
      note: row.note,
    })),
    importBatchId: batch.id,
    action: 'commit-import',
    correlationId: `commit-${batch.id}`,
    summary: { inserted: rowsToInsert.length, duplicates: duplicates.length, skipped: mode === 'partial' ? validation.rejected.length : 0 },
  });
  inserted.push(...rows);

  const result: ImportCommitResult = {
    batchId: batch.id,
    mode,
    inserted,
    duplicates,
    skipped: mode === 'partial' ? validation.rejected : [],
    auditEvent,
    outboxEvent,
    committedAt: now,
  };
  store.recordBatch({ ...batch, state: 'committed', commitResult: result, committedAt: now, mode });
  return { outcome: 'committed', status: 200, replayed: false, result };
}

function rejectBatch(
  store: ReadingsStore,
  batch: ImportBatchRecord,
  code: ImportRejection['code'],
  status: ImportRejection['status'],
  message: string,
  errors: readonly CellError[],
  policyReason: string | null,
  now: string,
): CommitImportDecision {
  const rejection: ImportRejection = { code, status, message, errors, policyReason, rejectedAt: now };
  store.recordBatch({ ...batch, state: 'rejected', rejection, rejectedAt: now });
  return { outcome: 'refused', status, code, message, rejection };
}

// ---------------------------------------------------------------------------
// Deterministic 366-row golden fixture scenario (spec: "a proposed 366-row
// minimum scenario"). Generates a full leap-year (2024) of DAILY rows for one
// stream as paste text, with optionally seeded cell errors.
// ---------------------------------------------------------------------------

export interface GoldenPasteOptions {
  /** Data-row indexes (1-based, header is row 0) to corrupt with a seeded error. */
  readonly seedErrors?: ReadonlyArray<{ rowIndex: number; kind: 'value-not-numeric' | 'date-unparseable' | 'value-missing' }>;
}

export const GOLDEN_STREAM_ID = 'str-corinne-q';
export const GOLDEN_YEAR = 2024;

/** Deterministic daily value for the golden batch: always inside [0, 1200] cfs. */
export function goldenDailyValue(dayIndex: number): number {
  return Math.round((18 + (dayIndex % 23) + dayIndex / 100) * 10) / 10;
}

/**
 * Build the 366-row leap-year paste text (header `date,offset,value,unit`,
 * one local-midnight row per calendar day of 2024 in America/Denver, offset
 * per the Denver DST rule). Exactly 366 data rows: seeded errors corrupt
 * cells, they never remove rows. The batch is bound to a stream at
 * createImport (defaultStreamId), not inside the text.
 */
export function buildLeapYearDailyPaste(options: GoldenPasteOptions = {}): string {
  const year = GOLDEN_YEAR;
  const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const lines: string[] = ['date,offset,value,unit'];
  let dayIndex = 0;
  for (let month = 1; month <= 12; month += 1) {
    for (let day = 1; day <= (daysInMonth[month - 1] ?? 30); day += 1) {
      dayIndex += 1;
      const rowIndex = dayIndex; // 1-based data row index
      const seeded = options.seedErrors?.find((error) => error.rowIndex === rowIndex);
      const dateText = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const offset = formatOffset(offsetForLocalNoon(year, month, day));
      let valueText = String(goldenDailyValue(dayIndex));
      let dateCell = dateText;
      if (seeded?.kind === 'value-not-numeric') valueText = 'abc';
      if (seeded?.kind === 'value-missing') valueText = '';
      if (seeded?.kind === 'date-unparseable') dateCell = `${year}-13-45`;
      lines.push(`${dateCell},${offset},${valueText},cfs`);
    }
  }
  return lines.join('\n');
}

/** Denver offset for a calendar date, judged at local noon (noon never falls in a transition). */
function offsetForLocalNoon(year: number, month: number, day: number): number {
  const noonUtcGuess = Date.UTC(year, month - 1, day, 12);
  return denverOffsetMinutesAt(noonUtcGuess);
}

export type { AcceptedRow, DuplicateRow, RejectedRow };
