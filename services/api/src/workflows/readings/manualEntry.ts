/**
 * Manual single-reading entry (WD-010, FR-020): POST /streams/{id}/observations.
 *
 * "Users enter observation time, value, unit, stream and optional note for
 * an assigned site; validation identifies the offending field, preserves
 * valid inputs, and returns a saved record identifier on success."
 *
 * Check order per call (deliberate, exercised by the tests):
 *  1. resolve the stream                    -> 404 NOT_FOUND (field streamId);
 *  2. capability via @utah-water/policy     -> 401 identity denials, 404
 *     hidden-object out-of-scope on non-public streams, else 403 (including
 *     DENY_LIFECYCLE_STATE: an inactive or proposed station's measurement
 *     lifecycle is closed);
 *  3. idempotency replay                    -> same body: the recorded
 *     applied result; different body: IDEMPOTENCY_CONFLICT (409);
 *  4. input validation                      -> VALIDATION_FAILED (422) with
 *     field paths: explicit-offset observation time, finite value inside the
 *     stream's valid range, governed unit whose dimension matches the
 *     stream's observed property, method consistency with the stream's
 *     datastream definition;
 *  5. duplicate by logical key              -> the EXISTING record is
 *     returned (200 DUPLICATE_LOGICAL_KEY); no duplicate row is appended;
 *  6. append reading + audit + outbox       -> applied (200) with record id.
 *
 * The workflow is pure: store, actor, input and clock are injected; nothing
 * is read internally. The rejected decision preserves the input verbatim so
 * the calling form can re-render valid fields untouched.
 */
import {
  evaluate,
  type AuthorizationRequest,
  type Capability,
  type Decision as PolicyDecision,
} from '../../../../../packages/policy/src/index.ts';
import type { ReadingsStore } from './store.ts';
import { manualFingerprint } from './store.ts';
import { formatOffset, formatUtcSecondPrecision, isoHasExplicitOffset, parseDateTimeWithOffset } from './pasteFormat.ts';
import { unitCompatible } from './bulkImport.ts';
import type {
  EntryContext,
  FieldError,
  ManualAppliedDecision,
  ManualEntryDecision,
  ManualEntryInput,
  ManualIdempotencyConflictDecision,
  ManualRejectedDecision,
} from './types.ts';

/** Matrix row "Enter readings and revise best available". */
export const ENTRY_CAPABILITY: Capability = 'enter-readings';

function reject(
  input: ManualEntryInput,
  status: ManualRejectedDecision['status'],
  code: ManualRejectedDecision['code'],
  message: string,
  fieldErrors: readonly FieldError[] = [],
  policyReason: string | null = null,
): ManualRejectedDecision {
  return { outcome: 'rejected', status, code, message, fieldErrors, policyReason, input };
}

/**
 * Map a policy denial onto the API error policy (same fixed hidden-object
 * table as WD-011): identity denials 401; unknown object 404; out-of-scope
 * on a NON-public stream 404 (the stream does not exist for the outsider);
 * everything else 403.
 */
function policyRejection(
  input: ManualEntryInput,
  policy: PolicyDecision,
  isPublicStream: boolean,
): ManualRejectedDecision {
  if (
    policy.reason === 'DENY_ANONYMOUS' ||
    policy.reason === 'DENY_UNKNOWN_PRINCIPAL' ||
    policy.reason === 'DENY_PRINCIPAL_INACTIVE'
  ) {
    return reject(input, 401, 'UNAUTHENTICATED', 'reading entry requires an authenticated, active principal', [], policy.reason);
  }
  if (policy.reason === 'DENY_UNKNOWN_OBJECT') {
    return reject(input, 404, 'NOT_FOUND', 'stream not found', [field('streamId', 'STREAM_UNKNOWN', `stream "${input.streamId}" does not exist`)], policy.reason);
  }
  if (policy.reason === 'DENY_OUT_OF_SCOPE' && !isPublicStream) {
    return reject(input, 404, 'NOT_FOUND', 'stream not found', [], policy.reason);
  }
  return reject(input, 403, 'FORBIDDEN', `actor is not permitted to enter readings on this stream (${policy.reason})`, [], policy.reason);
}

function field(fieldPath: string, code: string, message: string): FieldError {
  return { fieldPath, code, message };
}

/** Validate one manual entry body. Returns field-scoped errors (empty = valid). */
export function validateManualEntry(store: ReadingsStore, input: ManualEntryInput): FieldError[] {
  const errors: FieldError[] = [];
  const stream = store.streamById(input.streamId);

  // --- observation time: explicit offset required, never guessed ----------
  const observedText = typeof input.observedAt === 'string' ? input.observedAt.trim() : '';
  if (observedText === '') {
    errors.push(field('observedAt', 'TIME_REQUIRED', 'observation time is required'));
  } else {
    const parsed = parseDateTimeWithOffset(observedText);
    if (parsed === null) {
      errors.push(
        field('observedAt', 'TIME_UNPARSEABLE', 'observation time must be ISO 8601 with an explicit UTC offset, e.g. 2026-03-08T02:15:00-07:00'),
      );
    } else if (!isoHasExplicitOffset(observedText)) {
      errors.push(
        field('observedAt', 'OFFSET_REQUIRED', 'observation time must carry an explicit UTC offset (e.g. 2026-03-08T02:15:00-07:00 or 2026-03-08T09:15:00Z); a naive local time is ambiguous and is rejected'),
      );
    }
  }

  // --- value: finite number; a missing reading is never entered as zero ---
  if (input.value === null || input.value === undefined || typeof input.value !== 'number' || !Number.isFinite(input.value)) {
    errors.push(field('value', 'VALUE_REQUIRED', 'value is required and must be a finite number; a missing reading is not zero'));
  } else if (stream && (stream.validRangeMin !== null || stream.validRangeMax !== null)) {
    const min = stream.validRangeMin ?? Number.NEGATIVE_INFINITY;
    const max = stream.validRangeMax ?? Number.POSITIVE_INFINITY;
    if (input.value < min || input.value > max) {
      errors.push(
        field('value', 'VALUE_OUT_OF_RANGE', `value ${input.value} is outside the stream's valid range [${min}, ${max}] ${stream.unitId}`),
      );
    }
  }

  // --- unit: governed, and compatible with the stream's observed property ---
  if (typeof input.unitId !== 'string' || input.unitId.trim() === '') {
    errors.push(field('unitId', 'UNIT_REQUIRED', 'unit is required (e.g. cfs)'));
  } else if (store.unitDimension(input.unitId) === null) {
    errors.push(field('unitId', 'UNIT_UNKNOWN', `unit "${input.unitId}" is not in the governed vocabulary`));
  } else if (stream && !unitCompatible(store, stream, input.unitId)) {
    errors.push(
      field(
        'unitId',
        'UNIT_DIMENSION_MISMATCH',
        `unit "${input.unitId}" (${store.unitDimension(input.unitId)}) is incompatible with the stream's observed property "${stream.observedPropertyId}"; conversions across dimensions are rejected`,
      ),
    );
  }

  // --- method: optional, but must be consistent with the stream definition -
  if (input.methodTypeId !== undefined && input.methodTypeId !== null && input.methodTypeId !== '') {
    if (stream && input.methodTypeId !== stream.methodTypeId) {
      errors.push(
        field(
          'methodTypeId',
          'METHOD_MISMATCH',
          `method "${input.methodTypeId}" does not match the stream's measurement method "${stream.methodTypeId}"`,
        ),
      );
    }
  }

  return errors;
}

/**
 * Submit one manual reading (FR-020). Returns the saved record identifier on
 * success; duplicates by logical key return the existing record without
 * appending a second row.
 */
export function submitManualReading(
  store: ReadingsStore,
  actorId: string,
  input: ManualEntryInput,
  ctx: EntryContext,
): ManualEntryDecision {
  // 1. resolve the stream (field-level 404 so the form can flag the field)
  const stream = store.streamById(input.streamId);
  if (!stream) {
    return reject(input, 404, 'NOT_FOUND', 'stream not found', [field('streamId', 'STREAM_UNKNOWN', `stream "${input.streamId}" does not exist`)]);
  }

  // 2. capability on the datastream object
  const principal = store.world.principals[actorId] ?? null;
  const request: AuthorizationRequest = {
    principal,
    action: ENTRY_CAPABILITY,
    object: { kind: 'datastream', id: stream.id },
  };
  const policy = evaluate(request, store.world, ctx.now);
  if (policy.effect !== 'allow') {
    return policyRejection(input, policy, stream.visibility === 'public');
  }

  // 3. idempotency replay
  const fingerprint = manualFingerprint({
    streamId: input.streamId,
    observedAt: input.observedAt,
    value: input.value,
    unitId: input.unitId,
    methodTypeId: input.methodTypeId ?? null,
    note: input.note ?? null,
  });
  if (ctx.idempotencyKey) {
    const recorded = store.lookupManualIdempotency(ctx.idempotencyKey);
    if (recorded) {
      if (recorded.fingerprint !== fingerprint) {
        const conflict: ManualIdempotencyConflictDecision = {
          outcome: 'idempotency-conflict',
          code: 'IDEMPOTENCY_CONFLICT',
          status: 409,
          streamId: input.streamId,
          idempotencyKey: ctx.idempotencyKey,
          recordedRecordId: recorded.recordId,
          recordedAt: recorded.recordedAt,
        };
        return conflict;
      }
      const existing = store.observations.find((row) => row.id === recorded.recordId) ?? null;
      if (existing) {
        const replayed: ManualAppliedDecision = {
          outcome: 'applied',
          code: 'OK',
          status: 200,
          replayed: true,
          duplicate: false,
          record: existing,
          auditEvent: null, // no new mutation on replay
          outboxEvent: null,
        };
        return replayed;
      }
    }
  }

  // 4. input validation with field paths
  const fieldErrors = validateManualEntry(store, input);
  if (fieldErrors.length > 0) {
    return reject(input, 422, 'VALIDATION_FAILED', 'manual entry failed validation; see fieldErrors for the offending fields', fieldErrors);
  }

  // 5. duplicate by logical key: return the existing record, append nothing
  const parsedTime = parseDateTimeWithOffset(input.observedAt.trim());
  const observedAt = formatUtcSecondPrecision(parsedTime.epochMs);
  const logicalKey = `${input.streamId}:${observedAt}`;
  const existing = store.observationByLogicalKey(logicalKey);
  if (existing) {
    const duplicate: ManualAppliedDecision = {
      outcome: 'applied',
      code: 'DUPLICATE_LOGICAL_KEY',
      status: 200,
      replayed: false,
      duplicate: true,
      record: existing,
      auditEvent: null, // no mutation: nothing appended, therefore no audit/outbox rows
      outboxEvent: null,
    };
    return duplicate;
  }

  // 6. append reading + audit + outbox as one transaction
  const { rows, auditEvent, outboxEvent } = store.appendReadings({
    actorId,
    now: ctx.now,
    idempotencyKey: ctx.idempotencyKey ?? null,
    idempotencyFingerprint: fingerprint,
    rows: [
      {
        streamId: input.streamId,
        observedAt,
        sourceOffset: parsedTime.offsetMinutes === 0 ? 'Z' : formatOffset(parsedTime.offsetMinutes),
        value: input.value,
        unitId: input.unitId,
        methodTypeId: input.methodTypeId ?? stream.methodTypeId,
        note: typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim() : null,
      },
    ],
    importBatchId: null,
    action: 'enter-manual-reading',
    correlationId: ctx.idempotencyKey ?? `entry-${observedAt}`,
    summary: null,
  });
  const applied: ManualAppliedDecision = {
    outcome: 'applied',
    code: 'OK',
    status: 200,
    replayed: false,
    duplicate: false,
    record: rows[0],
    auditEvent,
    outboxEvent,
  };
  return applied;
}
