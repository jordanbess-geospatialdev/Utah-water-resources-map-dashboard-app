/**
 * The versioned shift workflow (WD-011-R2; FR-045; acceptance T-06).
 *
 * A shift layers stage-offset segments ON the station's curve: the effective
 * stage G' = G + offset(segment) feeds the curve, Q = c * (G' - e)^b. Shift
 * versions carry exactly the same governance as curve versions:
 * - append-only chains per stream, half-open effective intervals
 *   [effectiveFrom, effectiveTo);
 * - author, approval state (draft -> approved -> superseded) and provenance
 *   retained; supersession closes the prior interval without deleting it;
 * - authoring gated by `edit-site-metadata` (assigned engineer / steward),
 *   approval gated by `review-data` (data owner / steward) via the policy
 *   engine - authors cannot self-approve;
 * - overlap rejection: at most one shift version covers any instant.
 *
 * The combined conversion (convertWithShift) carries BOTH lineage ids: the
 * curve version id and the shift version id, so every derived value names
 * the exact version pair it was computed under (FR-045 "computed values
 * identify the version used"). Shifts that do not cover the requested stage
 * are never partially applied: the conversion is rejected instead.
 */
import { evaluate } from '../../../../../packages/policy/src/index.ts';
import type { RatingCurveStore } from './store.ts';
import { convertStage } from './curves.ts';
import { APPROVE_CURVE_CAPABILITY, AUTHOR_CURVE_CAPABILITY } from './curves.ts';
import type {
  ConversionDecision,
  ConvertOptions,
  RatingCurveFieldError,
  RatingShift,
  RejectedDecision,
  ShiftSegment,
  ShiftVersionInput,
  SupersedeShiftInput,
  VersionDecision,
  WorkflowContext,
} from './types.ts';

export const AUTHOR_SHIFT_CAPABILITY = AUTHOR_CURVE_CAPABILITY;
export const APPROVE_SHIFT_CAPABILITY = APPROVE_CURVE_CAPABILITY;

function reject(
  status: RejectedDecision['status'],
  code: RejectedDecision['code'],
  message: string,
  fieldErrors: readonly RatingCurveFieldError[] = [],
  policyReason: string | null = null,
): RejectedDecision {
  return { outcome: 'rejected', status, code, message, fieldErrors, policyReason };
}

function fieldError(fieldPath: string, code: string, message: string): RatingCurveFieldError {
  return { fieldPath, code, message };
}

/**
 * Segment table validation: segments are sorted by fromStageFt, each has a
 * strictly positive span (toStageFt null only on the final, open tail), and
 * consecutive segments may touch but never overlap. Offsets may be negative
 * (a datum correction can lower the effective stage).
 */
export function validateSegments(segments: readonly ShiftSegment[]): RatingCurveFieldError[] {
  const errors: RatingCurveFieldError[] = [];
  if (!Array.isArray(segments) || segments.length === 0) {
    return [fieldError('segments', 'SEGMENTS_REQUIRED', 'at least one shift segment is required')];
  }
  for (const [index, segment] of segments.entries()) {
    const path = `segments[${index}]`;
    if (typeof segment.fromStageFt !== 'number' || !Number.isFinite(segment.fromStageFt)) {
      errors.push(fieldError(`${path}.fromStageFt`, 'BOUND_NOT_FINITE', 'fromStageFt must be a finite number of feet'));
    }
    if (segment.toStageFt !== null && (typeof segment.toStageFt !== 'number' || !Number.isFinite(segment.toStageFt))) {
      errors.push(fieldError(`${path}.toStageFt`, 'BOUND_NOT_FINITE', 'toStageFt must be null or a finite number of feet'));
    }
    if (
      segment.toStageFt !== null &&
      typeof segment.fromStageFt === 'number' &&
      typeof segment.toStageFt === 'number' &&
      segment.toStageFt <= segment.fromStageFt
    ) {
      errors.push(fieldError(`${path}.toStageFt`, 'SPAN_NOT_POSITIVE', 'toStageFt must be strictly above fromStageFt; the segment interval is half-open'));
    }
    if (index > 0 && segments[index - 1] !== undefined) {
      const previous = segments[index - 1]!;
      if (typeof segment.fromStageFt === 'number' && previous.toStageFt !== null && typeof previous.toStageFt === 'number') {
        if (segment.fromStageFt < previous.toStageFt) {
          errors.push(fieldError(`${path}.fromStageFt`, 'SEGMENTS_OVERLAP', `segment ${index} starts inside segment ${index - 1}'s span; segments may touch, never overlap`));
        }
      }
    }
    if (index < segments.length - 1 && segment.toStageFt === null) {
      errors.push(fieldError(`${path}.toStageFt`, 'OPEN_TAIL_NOT_LAST', 'only the final segment may have a null (open) upper bound'));
    }
    if (typeof segment.offsetFt !== 'number' || !Number.isFinite(segment.offsetFt)) {
      errors.push(fieldError(`${path}.offsetFt`, 'OFFSET_NOT_FINITE', 'offsetFt must be a finite number of feet (negative offsets are valid)'));
    }
  }
  return errors;
}

function overlapsShift(
  store: RatingCurveStore,
  streamId: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  excludeIds: readonly string[] = [],
): readonly RatingShift[] {
  const fromMs = Date.parse(effectiveFrom);
  const toMs = effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(effectiveTo);
  return store.shiftVersionsOf(streamId).filter((existing) => {
    if (excludeIds.includes(existing.id)) return false;
    const existingFrom = Date.parse(existing.effectiveFrom);
    const existingTo = existing.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(existing.effectiveTo);
    return fromMs < existingTo && existingFrom < toMs;
  });
}

function provenanceFor(input: ShiftVersionInput, fallbackSource: string): NonNullable<ShiftVersionInput['provenance']> {
  return (
    input.provenance ?? {
      source: fallbackSource,
      calibrationCount: null,
      note: 'Shift adjustment awaiting data-owner approval.',
    }
  );
}

// ---------------------------------------------------------------------------
// create: append a draft shift version
// ---------------------------------------------------------------------------

export function createShiftVersion(
  store: RatingCurveStore,
  actorId: string,
  streamId: string,
  input: ShiftVersionInput,
  ctx: WorkflowContext,
): VersionDecision<RatingShift> {
  const stream = store.streamById(streamId);
  if (!stream) {
    return reject(404, 'NOT_FOUND', 'stream not found', [fieldError('streamId', 'STREAM_UNKNOWN', `stream "${streamId}" does not exist`)]);
  }
  // Authorization reuses the curves gate (imported capability + the shared
  // authorize helper semantics): authoring shifts is the same station-
  // measurement configuration authority.
  const denied = authorizeStation(store, actorId, AUTHOR_SHIFT_CAPABILITY, stream.stationId, ctx.now);
  if (denied) return denied;

  const errors = [...validateSegments(input.segments)];
  if (typeof input.reason !== 'string' || input.reason.trim() === '') {
    errors.push(fieldError('reason', 'REASON_REQUIRED', 'reason is required and retained as shift provenance'));
  }
  if (Number.isNaN(Date.parse(input.effectiveFrom))) {
    errors.push(fieldError('effectiveFrom', 'EFFECTIVE_DATE_INVALID', 'effectiveFrom must be an ISO 8601 instant'));
  }
  if (input.effectiveTo !== undefined && input.effectiveTo !== null && !Number.isNaN(Date.parse(input.effectiveTo))) {
    if (Number.isNaN(Date.parse(input.effectiveFrom)) || Date.parse(input.effectiveTo) <= Date.parse(input.effectiveFrom)) {
      errors.push(fieldError('effectiveTo', 'EFFECTIVE_DATE_ORDER', 'effectiveTo must be strictly after effectiveFrom (half-open interval)'));
    }
  }
  if (errors.length > 0) {
    return reject(422, 'VALIDATION_FAILED', 'shift version failed validation; see fieldErrors', errors);
  }

  const effectiveTo = input.effectiveTo ?? null;
  const conflicts = overlapsShift(store, streamId, input.effectiveFrom, effectiveTo);
  if (conflicts.length > 0) {
    return reject(
      409,
      'PERIOD_OVERLAP',
      `the requested shift period [${input.effectiveFrom}, ${effectiveTo ?? 'open'}) overlaps shift version(s) ${conflicts.map((shift) => shift.id).join(', ')}; at most one shift version may cover any instant`,
      [fieldError('effectiveFrom', 'PERIOD_OVERLAP', `overlaps ${conflicts.map((shift) => shift.id).join(', ')}`)],
    );
  }

  const { shift, auditEvent, outboxEvent } = store.appendShiftVersion({
    streamId,
    stationId: stream.stationId,
    actorId,
    now: ctx.now,
    closeCurrentAt: null,
    action: 'create-shift',
    shift: {
      stationId: stream.stationId,
      streamId,
      segments: [...input.segments],
      reason: input.reason.trim(),
      effectiveFrom: input.effectiveFrom,
      effectiveTo,
      author: actorId,
      approvalState: 'draft',
      approvedBy: null,
      approvedAt: null,
      provenance: provenanceFor(input, `authored by ${actorId}`),
    },
  });
  return { outcome: 'applied', code: 'OK', status: 201, version: shift, auditEvent, outboxEvent };
}

// ---------------------------------------------------------------------------
// approve: data-owner / steward gate (draft -> approved)
// ---------------------------------------------------------------------------

export function approveShiftVersion(
  store: RatingCurveStore,
  actorId: string,
  shiftVersionId: string,
  ctx: WorkflowContext,
): VersionDecision<RatingShift> {
  const shift = store.shiftVersionById(shiftVersionId);
  if (!shift) {
    return reject(404, 'NOT_FOUND', 'shift version not found', [fieldError('versionId', 'VERSION_UNKNOWN', `shift version "${shiftVersionId}" does not exist`)]);
  }
  const denied = authorizeStation(store, actorId, APPROVE_SHIFT_CAPABILITY, shift.stationId, ctx.now);
  if (denied) return denied;

  if (shift.approvalState !== 'draft') {
    return reject(
      409,
      'INVALID_TRANSITION',
      `shift version "${shiftVersionId}" is ${shift.approvalState}; only a draft can be approved`,
      [fieldError('versionId', 'NOT_DRAFT', `approvalState is ${shift.approvalState}`)],
    );
  }
  const result = store.approveShiftVersion({ versionId: shiftVersionId, actorId, now: ctx.now, from: 'draft', to: 'approved' });
  return { outcome: 'applied', code: 'OK', status: 200, version: result.shift, auditEvent: result.auditEvent, outboxEvent: result.outboxEvent };
}

// ---------------------------------------------------------------------------
// supersede: close the prior shift interval without deleting it
// ---------------------------------------------------------------------------

export function supersedeShiftVersion(
  store: RatingCurveStore,
  actorId: string,
  streamId: string,
  input: SupersedeShiftInput,
  ctx: WorkflowContext,
): VersionDecision<RatingShift> {
  const stream = store.streamById(streamId);
  if (!stream) {
    return reject(404, 'NOT_FOUND', 'stream not found', [fieldError('streamId', 'STREAM_UNKNOWN', `stream "${streamId}" does not exist`)]);
  }
  const denied = authorizeStation(store, actorId, AUTHOR_SHIFT_CAPABILITY, stream.stationId, ctx.now);
  if (denied) return denied;

  const errors = [...validateSegments(input.segments)];
  if (typeof input.supersedeReason !== 'string' || input.supersedeReason.trim() === '') {
    errors.push(fieldError('supersedeReason', 'REASON_REQUIRED', 'supersedeReason is required and retained as the transition provenance'));
  }
  const current = store.openShiftVersion(streamId);
  if (!current) {
    errors.push(fieldError('streamId', 'NO_OPEN_VERSION', `stream "${streamId}" has no open shift version to supersede; use createShiftVersion`));
  } else if (!Number.isNaN(Date.parse(input.effectiveFrom)) && Date.parse(input.effectiveFrom) <= Date.parse(current.effectiveFrom)) {
    errors.push(
      fieldError('effectiveFrom', 'EFFECTIVE_DATE_NOT_FORWARD', `effectiveFrom must be strictly after the open shift version's start ${current.effectiveFrom}`),
    );
  }
  if (errors.length > 0) {
    return reject(422, 'VALIDATION_FAILED', 'shift supersession failed validation; see fieldErrors', errors);
  }

  const conflicts = overlapsShift(store, streamId, input.effectiveFrom, input.effectiveTo ?? null, current ? [current.id] : []);
  if (conflicts.length > 0) {
    return reject(
      409,
      'PERIOD_OVERLAP',
      `the successor shift period [${input.effectiveFrom}, ${input.effectiveTo ?? 'open'}) overlaps shift version(s) ${conflicts.map((shift) => shift.id).join(', ')}`,
      [fieldError('effectiveFrom', 'PERIOD_OVERLAP', `overlaps ${conflicts.map((shift) => shift.id).join(', ')}`)],
    );
  }

  const { shift, auditEvent, outboxEvent } = store.appendShiftVersion({
    streamId,
    stationId: stream.stationId,
    actorId,
    now: ctx.now,
    closeCurrentAt: input.effectiveFrom,
    action: 'supersede-shift',
    shift: {
      stationId: stream.stationId,
      streamId,
      segments: [...input.segments],
      reason: input.reason.trim(),
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      author: actorId,
      approvalState: 'draft',
      approvedBy: null,
      approvedAt: null,
      provenance: provenanceFor(input, `supersedes ${current?.id ?? '(none)'}: ${input.supersedeReason.trim()}`),
    },
  });
  return { outcome: 'applied', code: 'OK', status: 201, version: shift, auditEvent, outboxEvent };
}

// ---------------------------------------------------------------------------
// Combined conversion: curve + shift with BOTH lineage ids
// ---------------------------------------------------------------------------

/**
 * Convert stage to discharge at an instant with the effective approved
 * shift layered on the effective approved curve. Returns a ComputedValue
 * whose curveVersionId AND shiftVersionId name the exact versions used
 * (shiftVersionId null when no shift is in effect at the instant).
 */
export function convertWithShift(
  store: RatingCurveStore,
  streamId: string,
  stageFt: number,
  at: string,
  ctx: WorkflowContext,
): ConversionDecision {
  const options: ConvertOptions = { applyShift: true };
  return convertStage(store, streamId, stageFt, at, ctx, options);
}

// ---------------------------------------------------------------------------
// Shared authorization (the same fixed denial mapping as curves.ts)
// ---------------------------------------------------------------------------

function authorizeStation(
  store: RatingCurveStore,
  actorId: string,
  action: typeof AUTHOR_SHIFT_CAPABILITY | typeof APPROVE_SHIFT_CAPABILITY,
  stationId: string,
  now: string,
): RejectedDecision | null {
  const principal = store.world.principals[actorId] ?? null;
  const decision = evaluate(
    { principal, action, object: { kind: 'station', id: stationId } },
    store.world,
    now,
  );
  if (decision.effect === 'allow') return null;
  const object = store.world.objects[stationId];
  const isPublicObject = object?.visibility === 'public';
  const actionLabel = action === AUTHOR_SHIFT_CAPABILITY ? 'author rating shifts' : 'approve rating shifts';
  if (
    decision.reason === 'DENY_ANONYMOUS' ||
    decision.reason === 'DENY_UNKNOWN_PRINCIPAL' ||
    decision.reason === 'DENY_PRINCIPAL_INACTIVE'
  ) {
    return reject(401, 'UNAUTHENTICATED', `${actionLabel} requires an authenticated, active principal`, [], decision.reason);
  }
  if (decision.reason === 'DENY_UNKNOWN_OBJECT') {
    return reject(404, 'NOT_FOUND', 'station not found', [], decision.reason);
  }
  if (decision.reason === 'DENY_OUT_OF_SCOPE' && !isPublicObject) {
    return reject(404, 'NOT_FOUND', 'station not found', [], decision.reason);
  }
  return reject(403, 'FORBIDDEN', `actor is not permitted to ${actionLabel} (${decision.reason})`, [], decision.reason);
}
