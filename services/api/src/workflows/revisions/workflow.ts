/**
 * The best-available correction workflow (WD-011).
 *
 * Pure domain orchestration over the fixture-backed store; the future HTTP
 * layer (POST /observations/{key}/revisions with If-Match + Idempotency-Key)
 * calls these functions and maps the returned Decision onto the error policy
 * (packages/contracts/schemas/error.json): 412 stale If-Match, 409 idempotency
 * conflict, 403 capability, 422 validation, 404 hidden object.
 *
 * Check order per call (deliberate, exercised by the tests):
 *  1. resolve the observation           -> NOT_FOUND (404) when unknown;
 *  2. capability via @utah-water/policy -> 401 identity denials, 404
 *     hidden-object out-of-scope on non-public streams, else 403;
 *  3. idempotency replay                -> same body: the recorded applied
 *     result; different body: IDEMPOTENCY_CONFLICT (409);
 *  4. input validation                  -> VALIDATION_FAILED (422): required
 *     reason, governed qualifiers/units/levels, finite value;
 *  5. optimistic version (If-Match)     -> PRECONDITION_FAILED (412)
 *     reviewable conflict carrying both versions and the preserved input;
 *  6. append revision + audit + outbox  -> applied (200).
 *
 * No time lock: corrections after calendar year end are ordinary appends
 * (FR-040); finalized accounting is a separate, non-mutated concern.
 */
import {
  evaluate,
  type AuthorizationRequest,
  type Capability,
  type Decision as PolicyDecision,
} from '../../../../../packages/policy/src/index.ts';
import type { RevisionStore } from './store.ts';
import { bodyFingerprint } from './store.ts';
import type {
  AppliedDecision,
  IdempotencyConflictDecision,
  RejectedDecision,
  RevisionDecision,
  RevisionInput,
  TombstoneInput,
  VersionConflictDecision,
  WorkflowContext,
} from './types.ts';

/** Correction verb: the matrix row "Enter readings and revise best available". */
export const CORRECTION_CAPABILITY: Capability = 'revise-best-available';
/** Withdrawal verb: separate capability, automation/steward only (FR-039). */
export const WITHDRAW_CAPABILITY: Capability = 'withdraw-raw';

function reject(
  logicalKey: string,
  status: RejectedDecision['status'],
  code: RejectedDecision['code'],
  message: string,
  input: RevisionInput | TombstoneInput,
  policyReason: string | null = null,
): RejectedDecision {
  return { outcome: 'rejected', status, code, logicalKey, message, policyReason, input };
}

/**
 * Map a policy-engine denial onto the API error policy, mirroring the fixed
 * hidden-object table in services/api/src/auth/README.md: identity denials
 * 401; unknown object 404; out-of-scope on a NON-public object 404 (the
 * restricted row does not exist for the outsider); everything else 403.
 */
function policyRejection(
  logicalKey: string,
  policy: PolicyDecision,
  isPublicObject: boolean,
  input: RevisionInput | TombstoneInput,
): RejectedDecision {
  if (
    policy.reason === 'DENY_ANONYMOUS' ||
    policy.reason === 'DENY_UNKNOWN_PRINCIPAL' ||
    policy.reason === 'DENY_PRINCIPAL_INACTIVE'
  ) {
    return reject(logicalKey, 401, 'UNAUTHENTICATED', 'correction requires an authenticated, active principal', input, policy.reason);
  }
  if (policy.reason === 'DENY_UNKNOWN_OBJECT') {
    return reject(logicalKey, 404, 'NOT_FOUND', 'observation not found', input, policy.reason);
  }
  if (policy.reason === 'DENY_OUT_OF_SCOPE' && !isPublicObject) {
    return reject(logicalKey, 404, 'NOT_FOUND', 'observation not found', input, policy.reason);
  }
  return reject(logicalKey, 403, 'FORBIDDEN', `actor is not permitted to perform this operation (${policy.reason})`, input, policy.reason);
}

function authorize(
  store: RevisionStore,
  actorId: string,
  action: Capability,
  observationId: string,
  logicalKey: string,
  now: string,
  input: RevisionInput | TombstoneInput,
): RejectedDecision | null {
  const principal = store.world.principals[actorId] ?? null;
  const request: AuthorizationRequest = {
    principal,
    action,
    object: { kind: 'observation', id: observationId },
  };
  const policy = evaluate(request, store.world, now);
  if (policy.effect === 'allow') return null;
  const object = store.world.objects[observationId];
  return policyRejection(logicalKey, policy, object?.visibility === 'public', input);
}

function validateCommon(
  store: RevisionStore,
  logicalKey: string,
  input: RevisionInput | TombstoneInput,
  qualifierIds: readonly string[],
): RejectedDecision | null {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return reject(logicalKey, 422, 'VALIDATION_FAILED', 'reason is required and must be non-empty (FR-041)', input);
  }
  const ungoverned = qualifierIds.filter((id) => !store.isGovernedQualifier(id));
  if (ungoverned.length > 0) {
    return reject(
      logicalKey,
      422,
      'VALIDATION_FAILED',
      `qualifier(s) not in the governed vocabulary: ${ungoverned.join(', ')}`,
      input,
    );
  }
  if (!Number.isInteger(input.baseRevisionVersion) || input.baseRevisionVersion < 0) {
    return reject(logicalKey, 422, 'VALIDATION_FAILED', 'baseRevisionVersion must be a non-negative integer', input);
  }
  return null;
}

/** Replay check. Returns a decision when the replay is decided here, else null. */
function idempotencyReplay(
  store: RevisionStore,
  logicalKey: string,
  ctx: WorkflowContext,
  fingerprint: string,
): AppliedDecision | IdempotencyConflictDecision | null {
  if (!ctx.idempotencyKey) return null;
  const recorded = store.lookupIdempotency(ctx.idempotencyKey);
  if (!recorded) return null;
  if (recorded.fingerprint === fingerprint) {
    const revision = store.revisions.find((candidate) => candidate.id === recorded.revisionId) ?? null;
    if (!revision) return null;
    return {
      outcome: 'applied',
      code: 'OK',
      status: 200,
      replayed: true,
      revision,
      auditEvent: null, // no new mutation on replay
      outboxEvent: null,
    };
  }
  return {
    outcome: 'conflict',
    code: 'IDEMPOTENCY_CONFLICT',
    status: 409,
    logicalKey,
    idempotencyKey: ctx.idempotencyKey,
    recordedRevisionId: recorded.revisionId,
    recordedAt: recorded.recordedAt,
  };
}

function optimisticConflict(
  logicalKey: string,
  currentVersion: number,
  input: RevisionInput | TombstoneInput,
  currentHeadRevisionId: string | null,
): VersionConflictDecision {
  return {
    outcome: 'conflict',
    code: 'PRECONDITION_FAILED',
    status: 412,
    logicalKey,
    currentVersion,
    attemptedBaseRevisionVersion: input.baseRevisionVersion,
    currentHeadRevisionId,
    input,
  };
}

/**
 * A revision may assert any governed level EXCEPT raw: only the original row
 * is raw, and nothing can "correct" a point back to raw. Takes the level as a
 * plain string because untyped callers are validated here, not in the type.
 */
function isAssertableProcessingLevel(store: RevisionStore, level: string): boolean {
  return store.isGovernedProcessingLevel(level) && level !== 'raw';
}

/**
 * Append a correction or level-advance (FR-022, FR-040, FR-041). The raw
 * observation is never touched; the revision lands on the chain head with an
 * audit event and a transactional-outbox publication refresh.
 */
export function applyCorrection(
  store: RevisionStore,
  actorId: string,
  logicalKey: string,
  input: RevisionInput,
  ctx: WorkflowContext,
): RevisionDecision {
  const observation = store.observationByLogicalKey(logicalKey);
  if (!observation) {
    return reject(logicalKey, 404, 'NOT_FOUND', 'observation not found', input);
  }

  const denied = authorize(store, actorId, CORRECTION_CAPABILITY, observation.id, logicalKey, ctx.now, input);
  if (denied) return denied;

  const type: 'correction' | 'level-advance' = input.type ?? 'correction';
  // Review is separate from editing a best-available value. Check before
  // replay so revoking review authority also blocks an old idempotent retry.
  if (type === 'level-advance' || input.processingLevel === 'reviewed') {
    const reviewDenied = authorize(store, actorId, 'review-data', observation.id, logicalKey, ctx.now, input);
    if (reviewDenied) return reviewDenied;
  }
  const replay = idempotencyReplay(
    store,
    logicalKey,
    ctx,
    // The ledger stores the recorded (trimmed) body; the replay fingerprint
    // must normalize identically or a same-body retry would 409.
    bodyFingerprint({
      type,
      value: input.value,
      unitId: input.unitId,
      processingLevel: input.processingLevel,
      qualifierIds: input.qualifierIds,
      reason: input.reason.trim(),
    }),
  );
  if (replay) return replay;

  const invalid =
    validateCommon(store, logicalKey, input, input.qualifierIds) ??
    (typeof input.value !== 'number' || !Number.isFinite(input.value)
      ? reject(logicalKey, 422, 'VALIDATION_FAILED', 'value must be a finite number; use withdrawOriginal to exclude a point', input)
      : !store.isGovernedUnit(input.unitId)
        ? reject(logicalKey, 422, 'VALIDATION_FAILED', `unit "${input.unitId}" is not in the governed vocabulary`, input)
        : !isAssertableProcessingLevel(store, input.processingLevel)
          ? reject(logicalKey, 422, 'VALIDATION_FAILED', 'processingLevel must be a governed non-raw level', input)
          : null);
  if (invalid) return invalid;

  const currentVersion = store.currentVersion(logicalKey);
  if (input.baseRevisionVersion !== currentVersion) {
    return optimisticConflict(logicalKey, currentVersion, input, store.headRevision(logicalKey)?.id ?? null);
  }

  const { revision, auditEvent, outboxEvent } = store.appendRevision({
    logicalKey,
    observation,
    type,
    value: input.value,
    unitId: input.unitId,
    excluded: false,
    processingLevel: input.processingLevel,
    qualifierIds: input.qualifierIds,
    reason: input.reason.trim(),
    actorId,
    now: ctx.now,
    idempotencyKey: ctx.idempotencyKey ?? null,
    retainedOriginal: null,
    action: 'apply-correction',
  });
  return { outcome: 'applied', code: 'OK', status: 200, replayed: false, revision, auditEvent, outboxEvent };
}

/**
 * Withdraw an erroneous original (FR-039): a separately authorized
 * exclusion/tombstone. The raw row is never edited; the tombstone carries the
 * retained original value and provenance, the required reason and the actor.
 * Withdrawal capability is distinct from correction: the matrix gives it to
 * the automation engineer profile and the steward's governance grant only -
 * field engineers, commissioners and deputies are denied here even when they
 * may correct the same point.
 */
export function withdrawOriginal(
  store: RevisionStore,
  actorId: string,
  logicalKey: string,
  input: TombstoneInput,
  ctx: WorkflowContext,
): RevisionDecision {
  const observation = store.observationByLogicalKey(logicalKey);
  if (!observation) {
    return reject(logicalKey, 404, 'NOT_FOUND', 'observation not found', input);
  }

  const denied = authorize(store, actorId, WITHDRAW_CAPABILITY, observation.id, logicalKey, ctx.now, input);
  if (denied) return denied;

  const replay = idempotencyReplay(
    store,
    logicalKey,
    ctx,
    bodyFingerprint({
      type: 'exclusion',
      value: null,
      unitId: observation.unitId,
      processingLevel: 'best-available',
      qualifierIds: input.qualifierIds,
      reason: input.reason.trim(),
    }),
  );
  if (replay) return replay;

  const invalid = validateCommon(store, logicalKey, input, input.qualifierIds);
  if (invalid) return invalid;

  const currentVersion = store.currentVersion(logicalKey);
  if (input.baseRevisionVersion !== currentVersion) {
    return optimisticConflict(logicalKey, currentVersion, input, store.headRevision(logicalKey)?.id ?? null);
  }

  const retained = {
    value: observation.value,
    unitId: observation.unitId,
    observedAt: observation.observedAt,
    sourceOffset: observation.sourceOffset,
    sourceEventId: observation.sourceEventId,
    sourceId: observation.sourceId,
    receivedAt: observation.receivedAt,
  };
  const { revision, auditEvent, outboxEvent } = store.appendRevision({
    logicalKey,
    observation,
    type: 'exclusion',
    value: null,
    unitId: observation.unitId,
    excluded: true,
    // The tombstone removes the point from the best-available projection;
    // the retained original stays available per the retention policy.
    processingLevel: 'best-available',
    qualifierIds: input.qualifierIds,
    reason: input.reason.trim(),
    actorId,
    now: ctx.now,
    idempotencyKey: ctx.idempotencyKey ?? null,
    retainedOriginal: retained,
    action: 'withdraw-original',
  });
  return { outcome: 'applied', code: 'OK', status: 200, replayed: false, revision, auditEvent, outboxEvent };
}
