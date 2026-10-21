/**
 * Type vocabulary for the readings entry and bulk-import workflow (WD-010).
 *
 * Source of truth: docs/product/baseline/01-product-requirements.md FR-020
 * (manual measurement entry) and FR-021 (large batch paste and import);
 * docs/product/baseline/02-technical-specification.md "Offline, imports,
 * notifications and AI" (bulk paste accepts at least a full 366-day year of
 * daily rows per stream, whole-batch validation, explicit commit,
 * atomic-or-documented-partial with precise row errors, retry without
 * duplicates) and the API table rows POST /streams/{id}/observations,
 * POST /imports, POST /imports/{id}/validate, POST /imports/{id}/commit.
 *
 * Pure domain types only: no HTTP framework, no I/O, no clock reads. The
 * future Fastify layer maps the Decision unions below onto the error policy
 * (packages/contracts/schemas/error.json): 401 identity, 403 capability,
 * 404 hidden object, 409 idempotency / batch-state conflicts, 412 stale
 * If-Match, 422 validation with field paths.
 */

// ---------------------------------------------------------------------------
// Stream / station anchors (fields read from fixtures/contracts/stations.json)
// ---------------------------------------------------------------------------

/** A datastream definition the entry workflows validate against. */
export interface StreamDefinition {
  readonly id: string;
  readonly stationId: string;
  readonly systemId: string;
  readonly observedPropertyId: string;
  /** Canonical unit of the observed property (vocabulary.json). */
  readonly unitId: string;
  readonly methodTypeId: string;
  readonly cadenceMinutes: number;
  readonly validRangeMin: number | null;
  readonly validRangeMax: number | null;
  readonly visibility: 'public' | 'restricted' | 'internal';
  readonly timeZone: string;
  /**
   * Optimistic version of the measurement setup. Every setup change in the
   * sites workflow (device replacement, method change, threshold change)
   * bumps this so an in-flight import can be re-verified against the
   * CURRENT setup at commit time (FR-033 + spec: "recheck current scope
   * and row versions").
   */
  readonly setupVersion: number;
}

/** Station anchor fields the workflows resolve (FR-031 scope checks). */
export interface StationAnchor {
  readonly id: string;
  readonly systemId: string;
  readonly displayName: string;
  readonly status: string;
  readonly streamIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Observation rows (fixture raws are immutable; entered rows append)
// ---------------------------------------------------------------------------

/**
 * A reading row. Fixture rows load from observations.json; rows entered via
 * this workflow append with the entry provenance (manual or import batch).
 */
export interface ReadingRow {
  readonly id: string;
  readonly logicalKey: string;
  readonly streamId: string;
  /** UTC instant, second precision (logical keys use this exactly). */
  readonly observedAt: string;
  /** Offset the value was captured at, e.g. "-07:00" (kept, never re-derived). */
  readonly sourceOffset: string;
  readonly value: number;
  readonly unitId: string;
  readonly valueType: 'observed' | 'estimated';
  readonly processingLevel: 'raw';
  readonly sourceEventId: string;
  readonly receivedAt: string;
  readonly sourceId: string;
  readonly methodTypeId: string;
  /** Provenance: which entry path appended the row (fixture rows are 'fixture'). */
  readonly origin: 'fixture' | 'manual-entry' | 'import-batch';
  readonly importBatchId: string | null;
  readonly note: string | null;
}

// ---------------------------------------------------------------------------
// Manual entry (FR-020)
// ---------------------------------------------------------------------------

/** Body of POST /streams/{id}/observations. */
export interface ManualEntryInput {
  readonly streamId: string;
  /**
   * Observation time as ISO 8601 WITH an explicit UTC offset ("Z" or
   * "+/-HH:MM"). Naive local strings are rejected with field path
   * `observedAt` - the offset is part of the measurement record, never
   * guessed (technical specification: "Parse locale/time formats
   * explicitly").
   */
  readonly observedAt: string;
  /** Finite number. A missing reading is never entered as zero. */
  readonly value: number;
  /** Governed unit; its dimension must match the stream's observed property. */
  readonly unitId: string;
  /** Optional; when present it must match the stream's methodTypeId. */
  readonly methodTypeId?: string | null;
  readonly note?: string | null;
}

/** Execution context injected by the caller: clock and idempotency key. */
export interface EntryContext {
  /** UTC instant; the workflow never reads a clock internally. */
  readonly now: string;
  /** Idempotency-Key header. Same key + same body replays; different body is a 409. */
  readonly idempotencyKey?: string;
}

/** Field-scoped validation error (422): the offending field is identified. */
export interface FieldError {
  /** Dotted path into the request body, e.g. "value" or "observedAt". */
  readonly fieldPath: string;
  readonly code: string;
  readonly message: string;
}

/** The reading landed (or replayed / already existed as a duplicate). */
export interface ManualAppliedDecision {
  readonly outcome: 'applied';
  readonly code: 'OK' | 'DUPLICATE_LOGICAL_KEY';
  readonly status: 200;
  /** True when an idempotency-key replay returned the recorded result. */
  readonly replayed: boolean;
  /** True when the logical key already existed and the EXISTING row is returned; nothing was appended. */
  readonly duplicate: boolean;
  readonly record: ReadingRow;
  readonly auditEvent: EntryAuditEvent | null;
  readonly outboxEvent: EntryOutboxEvent | null;
}

export interface ManualRejectedDecision {
  readonly outcome: 'rejected';
  readonly status: 401 | 403 | 404 | 422;
  readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION_FAILED';
  readonly message: string;
  /** Field-scoped errors (422); empty for capability denials. */
  readonly fieldErrors: readonly FieldError[];
  /** Engine DENY_* reason when this is a capability denial. */
  readonly policyReason: string | null;
  readonly input: ManualEntryInput;
}

export interface ManualIdempotencyConflictDecision {
  readonly outcome: 'idempotency-conflict';
  readonly code: 'IDEMPOTENCY_CONFLICT';
  readonly status: 409;
  readonly streamId: string;
  readonly idempotencyKey: string;
  readonly recordedRecordId: string;
  readonly recordedAt: string;
}

export type ManualEntryDecision =
  | ManualAppliedDecision
  | ManualRejectedDecision
  | ManualIdempotencyConflictDecision;

// ---------------------------------------------------------------------------
// Paste parsing (shared by the staged batch and the web preview mirror)
// ---------------------------------------------------------------------------

/** Canonical column keys the header mapper resolves. */
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

/** One per-cell problem: row + column + machine reason (FR-021). */
export interface CellError {
  /** 1-based data row index (header is row 0). */
  readonly rowIndex: number;
  readonly columnKey: ColumnKey | null;
  /** 0-based physical column index in the pasted text (null for row-level problems). */
  readonly columnIndex: number | null;
  readonly code: string;
  readonly message: string;
  /** The offending cell exactly as pasted (empty string for missing cells). */
  readonly cellValue: string;
}

/** Resolved instant + the offset it was captured at. */
export interface ResolvedTime {
  /** UTC instant, second precision. */
  readonly observedAt: string;
  readonly sourceOffset: string;
}

/** Verdict for one parsed row. */
export type RowVerdict =
  | { readonly kind: 'accepted'; readonly rowIndex: number; readonly streamId: string; readonly time: ResolvedTime; readonly value: number; readonly unitId: string; readonly logicalKey: string; readonly methodTypeId: string; readonly note: string | null }
  | { readonly kind: 'duplicate'; readonly rowIndex: number; readonly streamId: string; readonly logicalKey: string; readonly against: 'batch' | 'store'; readonly existingId: string | null; readonly firstRowIndex: number | null; readonly time: ResolvedTime; readonly value: number; readonly unitId: string }
  | { readonly kind: 'rejected'; readonly rowIndex: number; readonly errors: readonly CellError[] };

/** Header mapping reported back to the mapping UI. */
export interface HeaderMapping {
  readonly delimiter: ',' | '\t' | ';';
  /** Canonical column key -> physical column index. */
  readonly columns: Readonly<Record<ColumnKey, number | undefined>>;
  /** Header labels that matched no known column key. */
  readonly unknownColumns: readonly string[];
  readonly headerCells: readonly string[];
}

/** Result of parsing + validating the whole pasted batch (whole-batch, not first-error). */
export interface ParsedBatch {
  readonly mapping: HeaderMapping;
  readonly rowCount: number;
  readonly accepted: readonly Extract<RowVerdict, { kind: 'accepted' }>[];
  readonly duplicates: readonly Extract<RowVerdict, { kind: 'duplicate' }>[];
  readonly rejected: readonly Extract<RowVerdict, { kind: 'rejected' }>[];
  /** Parse-level problems that are not tied to a data row (bad/missing header, no rows). */
  readonly batchErrors: readonly CellError[];
}

// ---------------------------------------------------------------------------
// Staged batch model: created -> validated -> committed/rejected
// ---------------------------------------------------------------------------

export type ImportBatchState = 'created' | 'validated' | 'committed' | 'rejected';

export type ImportMode = 'atomic' | 'partial';

export interface ImportBatchRecord {
  readonly id: string;
  readonly actorId: string;
  readonly createdAt: string;
  readonly state: ImportBatchState;
  readonly rawText: string;
  readonly defaultStreamId: string | null;
  readonly mode: ImportMode;
  /** assignmentVersionOf(actor) when the batch was created. */
  readonly createdActorVersion: number;
  /** assignmentVersionOf(actor) when the batch was last validated. */
  readonly validatedActorVersion: number | null;
  /** Stream setup versions captured at validation time (commit re-verifies). */
  readonly validatedStreamVersions: Readonly<Record<string, number>>;
  readonly validation: ParsedBatch | null;
  readonly validatedAt: string | null;
  readonly commitResult: ImportCommitResult | null;
  readonly committedAt: string | null;
  readonly rejection: ImportRejection | null;
  readonly rejectedAt: string | null;
}

export interface ImportRejection {
  readonly code:
    | 'ATOMIC_VALIDATION_ERRORS'
    | 'SCOPE_CHANGED'
    | 'STREAM_SETUP_CHANGED'
    | 'LIFECYCLE_CLOSED';
  readonly status: 403 | 409 | 422;
  readonly message: string;
  /** The exact row/cell errors that caused an atomic refusal (ATOMIC_VALIDATION_ERRORS). */
  readonly errors: readonly CellError[];
  readonly policyReason: string | null;
  readonly rejectedAt: string;
}

export interface ImportCommitResult {
  readonly batchId: string;
  readonly mode: ImportMode;
  /** Rows appended by THIS commit (empty on replay). */
  readonly inserted: readonly ReadingRow[];
  /** Duplicates reported, not silently skipped: within batch and against the store. */
  readonly duplicates: readonly Extract<RowVerdict, { kind: 'duplicate' }>[];
  /** Rows skipped with errors in documented-partial mode (empty in atomic mode). */
  readonly skipped: readonly Extract<RowVerdict, { kind: 'rejected' }>[];
  readonly auditEvent: EntryAuditEvent;
  readonly outboxEvent: EntryOutboxEvent;
  readonly committedAt: string;
}

export interface ImportCreatedDecision {
  readonly outcome: 'created';
  readonly batch: ImportBatchRecord;
}

export interface ImportNotFoundDecision {
  readonly outcome: 'not-found';
  readonly status: 404;
  readonly message: string;
}

export interface ImportForbiddenDecision {
  readonly outcome: 'forbidden';
  readonly status: 401 | 403 | 404;
  readonly message: string;
  readonly policyReason: string | null;
}

export interface ImportValidatedDecision {
  readonly outcome: 'validated';
  readonly batch: ImportBatchRecord;
}

export interface ImportCommittedDecision {
  readonly outcome: 'committed';
  readonly status: 200;
  /** True when the batch was already committed and the recorded result is returned unchanged. */
  readonly replayed: boolean;
  readonly result: ImportCommitResult;
}

export interface ImportRefusedDecision {
  readonly outcome: 'refused';
  readonly status: 403 | 404 | 409 | 422;
  readonly code: 'BATCH_NOT_VALIDATED' | 'BATCH_STATE_INVALID' | 'NOT_BATCH_OWNER' | string;
  readonly message: string;
  readonly rejection: ImportRejection | null;
}

export type ValidateImportDecision = ImportValidatedDecision | ImportNotFoundDecision | ImportForbiddenDecision | ImportRefusedDecision;
export type CommitImportDecision = ImportCommittedDecision | ImportNotFoundDecision | ImportForbiddenDecision | ImportRefusedDecision;
export type CreateImportDecision = ImportCreatedDecision | ImportForbiddenDecision;

// ---------------------------------------------------------------------------
// Audit + outbox (same shape as the revisions workflow; ADR-10)
// ---------------------------------------------------------------------------

export type EntryAuditAction =
  | 'enter-manual-reading'
  | 'commit-import';

export interface EntryAuditEvent {
  readonly id: string;
  readonly action: EntryAuditAction;
  readonly actorId: string;
  readonly streamIds: readonly string[];
  /** For manual entry: the one logical key; for imports: the batch id. */
  readonly targetId: string;
  readonly recordedAt: string;
  readonly correlationId: string;
  /** Counts for import commits; null for manual entry. */
  readonly summary: { readonly inserted: number; readonly duplicates: number; readonly skipped: number } | null;
}

export interface EntryOutboxEvent {
  readonly id: string;
  readonly type: 'publication-refresh';
  readonly streamIds: readonly string[];
  readonly recordedAt: string;
  readonly correlationId: string;
}
