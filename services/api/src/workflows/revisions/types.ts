/**
 * Type vocabulary for the best-available correction workflow (WD-011).
 *
 * Source of truth: docs/product/baseline/02-technical-specification.md
 * "Originals and corrections" + "Example correction contract", the Revision
 * row of the measurement model, and packages/contracts/schemas/revision.json.
 * Requirement anchors: FR-022 (correction with reason/qualifiers and a
 * reviewable conflict), FR-039 (raw immutability and separately authorized
 * withdrawal), FR-040 (best available remains correctable after year end),
 * FR-041 (multiple governed qualifiers plus justification), FR-042 (point and
 * interval audit history).
 *
 * Pure domain types only: no HTTP framework, no I/O, no clock reads. The
 * future Fastify layer maps the Decision unions below onto the error policy
 * in packages/contracts/schemas/error.json (409 idempotency conflict, 412
 * stale If-Match, 403 capability, 422 validation, 404 hidden object).
 */

/** Revision kinds (revision.json enum). Exclusion is the FR-039 tombstone. */
export type RevisionType = 'correction' | 'level-advance' | 'exclusion';

/** Governed processing levels (vocabulary.json). */
export type ProcessingLevel = 'raw' | 'provisional' | 'reviewed' | 'best-available';

/** A revision never re-asserts the raw level; only the original row is raw. */
export type AssertedProcessingLevel = Exclude<ProcessingLevel, 'raw'>;

/**
 * Evidence an exclusion tombstone retains so the withdrawn original stays
 * available per the approved retention and visibility policy (FR-039). The
 * raw row itself is never edited; this snapshot mirrors it at withdrawal.
 */
export interface RetainedOriginal {
  readonly value: number | null;
  readonly unitId: string;
  readonly observedAt: string;
  readonly sourceOffset: string;
  readonly sourceEventId: string;
  readonly sourceId: string;
  readonly receivedAt: string;
}

/** An original observation row as loaded from fixtures/contracts (never mutated). */
export interface ObservationRow {
  readonly id: string;
  readonly logicalKey: string;
  readonly streamId: string;
  readonly observedAt: string;
  readonly sourceOffset: string;
  readonly value: number | null;
  readonly unitId: string;
  readonly valueType: 'observed' | 'estimated';
  readonly processingLevel: 'raw';
  readonly sourceEventId: string;
  readonly receivedAt: string;
  readonly methodTypeId?: string;
  readonly sourceId: string;
  readonly note?: string;
}

/**
 * An appended revision. Field names follow revision.json one-for-one so the
 * fixture revisions (rev-corinne-2001..2004) load without translation.
 * `version` is the 1-based ordinal within the observation's chain and the
 * basis of the If-Match optimistic version (version 0 == the raw original).
 */
export interface RevisionRecord {
  readonly id: string;
  readonly targetObservationId: string;
  readonly targetLogicalKey: string;
  readonly baseRevisionId: string | null;
  readonly type: RevisionType;
  readonly value: number | null;
  readonly unitId: string;
  readonly excluded: boolean;
  readonly processingLevel: ProcessingLevel;
  readonly qualifierIds: readonly string[];
  readonly reason: string;
  readonly actorId: string;
  readonly recordedAt: string;
  readonly idempotencyKey: string | null;
  readonly version: number;
  /** Present exactly on exclusions: the retained original evidence (FR-039). */
  readonly retainedOriginal: RetainedOriginal | null;
}

/**
 * Body of POST /observations/{key}/revisions (the example correction
 * contract): a value (correction) or a re-stated value at a higher level
 * (level-advance). Exclusion is a SEPARATE operation (TombstoneInput +
 * withdrawOriginal) with its own capability; it is never expressible here.
 */
export interface RevisionInput {
  /** Defaults to 'correction'; 'level-advance' re-states the same value at a higher level. */
  readonly type?: 'correction' | 'level-advance';
  readonly value: number;
  readonly unitId: string;
  readonly processingLevel: AssertedProcessingLevel;
  readonly qualifierIds: readonly string[];
  /** REQUIRED and non-empty (FR-041). */
  readonly reason: string;
  /** If-Match optimistic version: the chain version this edit builds on. */
  readonly baseRevisionVersion: number;
}

/**
 * Withdrawal body (FR-039): reason is REQUIRED; the tombstone's null value,
 * retained evidence and exclusion type are set by the workflow, not caller.
 */
export interface TombstoneInput {
  /** REQUIRED and non-empty. */
  readonly reason: string;
  readonly qualifierIds: readonly string[];
  readonly baseRevisionVersion: number;
}

/** Execution context injected by the caller: clock and idempotency key. */
export interface WorkflowContext {
  /** UTC instant; the workflow never reads a clock internally. */
  readonly now: string;
  /** Idempotency-Key header. Same key + same body replays the recorded result; same key + different body is a 409. */
  readonly idempotencyKey?: string;
}

/** Stable machine codes, aligned with packages/contracts/schemas/error.json. */
export type DecisionCode =
  | 'OK'
  | 'VALIDATION_FAILED'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PRECONDITION_FAILED';

/** Structured change for one mutation (Audit event row of the data model). */
export interface AuditEvent {
  readonly id: string;
  readonly action: 'apply-correction' | 'withdraw-original';
  readonly actorId: string;
  readonly logicalKey: string;
  readonly targetObservationId: string;
  readonly streamId: string;
  /** Observation time of the target (distinct from `recordedAt`, the revision time). */
  readonly observedAt: string;
  readonly before: RevisionSnapshot;
  readonly after: RevisionSnapshot;
  readonly recordedAt: string;
  readonly correlationId: string;
}

/** Before/after state of a chain within one audit event. */
export interface RevisionSnapshot {
  readonly version: number;
  readonly headRevisionId: string | null;
  readonly value: number | null;
  readonly unitId: string;
  readonly excluded: boolean;
  readonly processingLevel: ProcessingLevel;
}

/**
 * Transactional-outbox publication refresh (ADR-10: external edits do not
 * automatically invalidate NeoServer caches). Written in the same logical
 * transaction as the revision append and its audit event.
 */
export interface OutboxEvent {
  readonly id: string;
  readonly type: 'publication-refresh';
  readonly logicalKey: string;
  readonly streamId: string;
  readonly recordedAt: string;
  readonly correlationId: string;
}

/** The mutation landed (or had already landed and is being replayed). */
export interface AppliedDecision {
  readonly outcome: 'applied';
  readonly code: 'OK';
  readonly status: 200;
  /** True when an idempotency-key replay returned the recorded result without a new mutation. */
  readonly replayed: boolean;
  readonly revision: RevisionRecord;
  /** Null on replay: no new mutation, therefore no new audit/outbox rows. */
  readonly auditEvent: AuditEvent | null;
  readonly outboxEvent: OutboxEvent | null;
}

/**
 * Reviewable conflict (FR-022: concurrent changes produce a conflict, never a
 * silent overwrite). Carries BOTH versions and preserves the caller's input
 * so the reviewer can rebase and resubmit.
 */
export interface VersionConflictDecision {
  readonly outcome: 'conflict';
  readonly code: 'PRECONDITION_FAILED';
  readonly status: 412;
  readonly logicalKey: string;
  /** Chain version the server currently holds. */
  readonly currentVersion: number;
  /** Chain version the caller's If-Match base claimed. */
  readonly attemptedBaseRevisionVersion: number;
  readonly currentHeadRevisionId: string | null;
  /** The caller's input, preserved verbatim for review/rebase. */
  readonly input: RevisionInput | TombstoneInput;
}

/** Same Idempotency-Key replayed with a different body: rejected (409). */
export interface IdempotencyConflictDecision {
  readonly outcome: 'conflict';
  readonly code: 'IDEMPOTENCY_CONFLICT';
  readonly status: 409;
  readonly logicalKey: string;
  readonly idempotencyKey: string;
  readonly recordedRevisionId: string;
  readonly recordedAt: string;
}

/** Validation, capability or resolution failure; nothing was appended. */
export interface RejectedDecision {
  readonly outcome: 'rejected';
  readonly status: 401 | 403 | 404 | 422;
  readonly code: Exclude<DecisionCode, 'OK' | 'PRECONDITION_FAILED' | 'IDEMPOTENCY_CONFLICT'>;
  readonly logicalKey: string;
  readonly message: string;
  /** Engine DENY_* reason when this rejection is a capability denial. */
  readonly policyReason: string | null;
  readonly input: RevisionInput | TombstoneInput;
}

export type RevisionDecision =
  | AppliedDecision
  | VersionConflictDecision
  | IdempotencyConflictDecision
  | RejectedDecision;

/** Narrow helpers for consumers switching on `outcome`. */
export type CorrectionDecision = RevisionDecision;
export type WithdrawalDecision = RevisionDecision;
