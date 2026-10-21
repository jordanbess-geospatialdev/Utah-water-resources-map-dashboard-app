/**
 * The versioned rating-curve workflow (WD-011-R2; FR-045; acceptance T-06):
 * "Effective-dated curve and shift versions retain author, approval state
 * and provenance; computed values identify the version used, and a revised
 * curve does not erase earlier conversions or inspection evidence."
 *
 * GOVERNANCE MAPPING (via @utah-water/policy, the entitlement engine):
 * - Authoring a curve version (create, supersede) is measurement-method
 *   configuration on a station: capability `edit-site-metadata` (matrix row
 *   "Change site metadata/photos" - engineers assigned to the station's
 *   system, or the statewide steward). The fixture world makes Fatima
 *   (Bear River engineer) an author, Priya (Weber River engineer) an
 *   out-of-scope author, and Sarah/anonymous non-authors.
 * - APPROVING a version (draft -> approved) is a data-owner act: capability
 *   `review-data` (matrix row "Review data and change processing status" -
 *   assigned owner side or statewide steward). In the fixture world that is
 *   Cody (Bear River commissioner, the data owner side) and Diego
 *   (statewide steward via statewide-administration); Ana may approve only
 *   inside her deputy delegation window; the authoring engineer Fatima
 *   deliberately holds NO review-data grant, so authors cannot self-approve.
 *
 * Check order per mutation (exercised by the suites):
 *  1. resolve the stream                   -> 404 NOT_FOUND;
 *  2. capability via @utah-water/policy    -> 401 identity, 403 capability
 *     (404 hidden object for out-of-scope on non-public stations);
 *  3. field validation                     -> 422 with field paths
 *     (finite positive coefficients, the governed ft -> cfs unit pair,
 *     effective interval ordering, forward-only supersession);
 *  4. effective-interval overlap guard     -> 409 PERIOD_OVERLAP naming the
 *     conflicting versions: at most one version of a kind may cover any
 *     instant (half-open intervals; boundary touching is legal);
 *  5. transition guard                     -> 409 INVALID_TRANSITION
 *     (only a draft can be approved; only the open version can be
 *     superseded);
 *  6. append version + audit + outbox      -> applied.
 *
 * CONVERSIONS: convertStage resolves the version approved for the instant
 * `at` (approval evidence survives supersession, so a superseded curve still
 * defines its own historical period), evaluates the documented formula and
 * records a frozen ledger entry carrying the version ids used (lineage).
 * No conversion path writes observations, revisions or reports - the
 * immutability suite proves this by content hash before/after.
 */
import {
  evaluate,
  type AuthorizationRequest,
  type Capability,
  type Decision as PolicyDecision,
} from '../../../../../packages/policy/src/index.ts';
import type { RatingCurveStore } from './store.ts';
import { intervalsOverlap } from './store.ts';
import type {
  ComputedValue,
  ConvertOptions,
  ConversionDecision,
  ConversionRejectedDecision,
  CurveVersionInput,
  RatingCurveFieldError,
  RatingCurveVersion,
  RejectedDecision,
  SupersedeCurveInput,
  VersionDecision,
  WorkflowContext,
} from './types.ts';

/** Authoring verb: measurement-method configuration on a station. */
export const AUTHOR_CURVE_CAPABILITY: Capability = 'edit-site-metadata';
/** Approval verb: the data-owner / steward gate for draft -> approved. */
export const APPROVE_CURVE_CAPABILITY: Capability = 'review-data';

/** The only governed unit pair for stage -> discharge conversion. */
export const STAGE_DISCHARGE_UNIT_PAIR = { fromUnitId: 'ft', toUnitId: 'cfs' } as const;

// ---------------------------------------------------------------------------
// Decision helpers
// ---------------------------------------------------------------------------

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

/** Policy denial -> API error mapping (the fixed hidden-object table shared with WD-010/WD-011). */
function policyRejection(policy: PolicyDecision, isPublicObject: boolean, action: string): RejectedDecision {
  if (
    policy.reason === 'DENY_ANONYMOUS' ||
    policy.reason === 'DENY_UNKNOWN_PRINCIPAL' ||
    policy.reason === 'DENY_PRINCIPAL_INACTIVE'
  ) {
    return reject(401, 'UNAUTHENTICATED', `${action} requires an authenticated, active principal`, [], policy.reason);
  }
  if (policy.reason === 'DENY_UNKNOWN_OBJECT') {
    return reject(404, 'NOT_FOUND', 'station not found', [], policy.reason);
  }
  if (policy.reason === 'DENY_OUT_OF_SCOPE' && !isPublicObject) {
    return reject(404, 'NOT_FOUND', 'station not found', [], policy.reason);
  }
  return reject(403, 'FORBIDDEN', `actor is not permitted to ${action} (${policy.reason})`, [], policy.reason);
}

function authorize(
  store: RatingCurveStore,
  actorId: string,
  action: Capability,
  stationId: string,
  now: string,
): RejectedDecision | null {
  const principal = store.world.principals[actorId] ?? null;
  const request: AuthorizationRequest = {
    principal,
    action,
    object: { kind: 'station', id: stationId },
  };
  const decision = evaluate(request, store.world, now);
  if (decision.effect === 'allow') return null;
  const object = store.world.objects[stationId];
  return policyRejection(decision, object?.visibility === 'public', action === AUTHOR_CURVE_CAPABILITY ? 'author rating curves' : 'approve rating curves');
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

function validateCoefficients(coefficients: CurveVersionInput['coefficients']): RatingCurveFieldError[] {
  const errors: RatingCurveFieldError[] = [];
  const { c, b, e } = coefficients;
  if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0) {
    errors.push(fieldError('coefficients.c', 'COEFFICIENT_INVALID', 'coefficients.c must be a finite number > 0 (cfs at unit effective depth)'));
  }
  if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0) {
    errors.push(fieldError('coefficients.b', 'EXPONENT_INVALID', 'coefficients.b must be a finite number > 0 (fractional log-space slopes are normal)'));
  }
  if (typeof e !== 'number' || !Number.isFinite(e) || e < 0) {
    errors.push(fieldError('coefficients.e', 'DATUM_OFFSET_INVALID', 'coefficients.e must be a finite number >= 0 (zero-flow datum offset in feet)'));
  }
  return errors;
}

function validatePeriod(input: CurveVersionInput): RatingCurveFieldError[] {
  const errors: RatingCurveFieldError[] = [];
  const from = Date.parse(input.effectiveFrom);
  if (Number.isNaN(from)) {
    errors.push(fieldError('effectiveFrom', 'EFFECTIVE_DATE_INVALID', 'effectiveFrom must be an ISO 8601 instant'));
  }
  if (input.effectiveTo !== undefined && input.effectiveTo !== null) {
    const to = Date.parse(input.effectiveTo);
    if (Number.isNaN(to)) {
      errors.push(fieldError('effectiveTo', 'EFFECTIVE_DATE_INVALID', 'effectiveTo must be null or an ISO 8601 instant'));
    } else if (!Number.isNaN(from) && to <= from) {
      errors.push(fieldError('effectiveTo', 'EFFECTIVE_DATE_ORDER', 'effectiveTo must be strictly after effectiveFrom; the interval is half-open [from, to)'));
    }
  }
  if (typeof input.method !== 'string' || input.method.trim() === '') {
    errors.push(fieldError('method', 'METHOD_REQUIRED', 'method is required (the fitting method is retained provenance)'));
  }
  if (input.unitPair.fromUnitId !== STAGE_DISCHARGE_UNIT_PAIR.fromUnitId || input.unitPair.toUnitId !== STAGE_DISCHARGE_UNIT_PAIR.toUnitId) {
    errors.push(
      fieldError('unitPair', 'UNIT_PAIR_UNGOVERNED', `only the governed pair ft -> cfs is accepted for stage-discharge curves (got ${input.unitPair.fromUnitId} -> ${input.unitPair.toUnitId})`),
    );
  }
  return errors;
}

/**
 * Overlap guard (FR-045 "effective-dated versions"): at most one version of
 * a kind may cover any instant. Boundary touching is legal - it is how the
 * seeded 2019/2026 periods join at 2026-03-07T18:00:00Z.
 */
export function curvePeriodConflicts(
  store: RatingCurveStore,
  streamId: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  /** Versions already closed at effectiveFrom by this very transition (touching, not overlapping). */
  excludeIds: readonly string[] = [],
): readonly RatingCurveVersion[] {
  return store.curveVersionsOf(streamId).filter(
    (existing) =>
      !excludeIds.includes(existing.id) &&
      intervalsOverlap(effectiveFrom, effectiveTo, existing.effectiveFrom, existing.effectiveTo),
  );
}

// ---------------------------------------------------------------------------
// create: append the first (or a non-overlapping bounded) version as draft
// ---------------------------------------------------------------------------

export function createCurveVersion(
  store: RatingCurveStore,
  actorId: string,
  streamId: string,
  input: CurveVersionInput,
  ctx: WorkflowContext,
): VersionDecision<RatingCurveVersion> {
  const stream = store.streamById(streamId);
  if (!stream) {
    return reject(404, 'NOT_FOUND', 'stream not found', [fieldError('streamId', 'STREAM_UNKNOWN', `stream "${streamId}" does not exist`)]);
  }
  const denied = authorize(store, actorId, AUTHOR_CURVE_CAPABILITY, stream.stationId, ctx.now);
  if (denied) return denied;

  const errors = [...validateCoefficients(input.coefficients), ...validatePeriod(input)];
  if (errors.length > 0) {
    return reject(422, 'VALIDATION_FAILED', 'curve version failed validation; see fieldErrors', errors);
  }

  const effectiveTo = input.effectiveTo ?? null;
  const conflicts = curvePeriodConflicts(store, streamId, input.effectiveFrom, effectiveTo);
  if (conflicts.length > 0) {
    return reject(
      409,
      'PERIOD_OVERLAP',
      `the requested period [${input.effectiveFrom}, ${effectiveTo ?? 'open'}) overlaps version(s) ${conflicts.map((version) => version.id).join(', ')}; at most one curve version may cover any instant (half-open intervals; boundary touching is allowed)`,
      [fieldError('effectiveFrom', 'PERIOD_OVERLAP', `overlaps ${conflicts.map((version) => version.id).join(', ')}`)],
    );
  }

  const { version, auditEvent, outboxEvent } = store.appendCurveVersion({
    streamId,
    stationId: stream.stationId,
    actorId,
    now: ctx.now,
    closeCurrentAt: null,
    action: 'create-curve',
    version: {
      stationId: stream.stationId,
      streamId,
      coefficients: { ...input.coefficients },
      unitPair: { ...input.unitPair },
      method: input.method.trim(),
      effectiveFrom: input.effectiveFrom,
      effectiveTo,
      author: actorId,
      approvalState: 'draft',
      approvedBy: null,
      approvedAt: null,
      provenance:
        input.provenance ??
        {
          source: `authored by ${actorId}`,
          calibrationCount: null,
          note: 'Draft curve version awaiting data-owner approval.',
        },
    },
  });
  return { outcome: 'applied', code: 'OK', status: 201, version, auditEvent, outboxEvent };
}

// ---------------------------------------------------------------------------
// approve: the steward-or-owner-gated transition (draft -> approved)
// ---------------------------------------------------------------------------

export function approveCurveVersion(
  store: RatingCurveStore,
  actorId: string,
  versionId: string,
  ctx: WorkflowContext,
): VersionDecision<RatingCurveVersion> {
  const version = store.curveVersionById(versionId);
  if (!version) {
    return reject(404, 'NOT_FOUND', 'curve version not found', [fieldError('versionId', 'VERSION_UNKNOWN', `curve version "${versionId}" does not exist`)]);
  }
  const denied = authorize(store, actorId, APPROVE_CURVE_CAPABILITY, version.stationId, ctx.now);
  if (denied) return denied;

  if (version.approvalState !== 'draft') {
    return reject(
      409,
      'INVALID_TRANSITION',
      `curve version "${versionId}" is ${version.approvalState}; only a draft can be approved`,
      [fieldError('versionId', 'NOT_DRAFT', `approvalState is ${version.approvalState}`)],
    );
  }

  const result = store.approveCurveVersion({ versionId, actorId, now: ctx.now, from: 'draft', to: 'approved' });
  return { outcome: 'applied', code: 'OK', status: 200, version: result.version, auditEvent: result.auditEvent, outboxEvent: result.outboxEvent };
}

// ---------------------------------------------------------------------------
// supersede: close the prior interval WITHOUT deleting it, append successor
// ---------------------------------------------------------------------------

export function supersedeCurveVersion(
  store: RatingCurveStore,
  actorId: string,
  streamId: string,
  input: SupersedeCurveInput,
  ctx: WorkflowContext,
): VersionDecision<RatingCurveVersion> {
  const stream = store.streamById(streamId);
  if (!stream) {
    return reject(404, 'NOT_FOUND', 'stream not found', [fieldError('streamId', 'STREAM_UNKNOWN', `stream "${streamId}" does not exist`)]);
  }
  const denied = authorize(store, actorId, AUTHOR_CURVE_CAPABILITY, stream.stationId, ctx.now);
  if (denied) return denied;

  const errors = [...validateCoefficients(input.coefficients), ...validatePeriod(input)];
  if (typeof input.supersedeReason !== 'string' || input.supersedeReason.trim() === '') {
    errors.push(fieldError('supersedeReason', 'REASON_REQUIRED', 'supersedeReason is required and retained as the transition provenance'));
  }
  const current = store.openCurveVersion(streamId);
  if (!current) {
    errors.push(fieldError('streamId', 'NO_OPEN_VERSION', `stream "${streamId}" has no open curve version to supersede; use createCurveVersion for the first version`));
  } else if (!Number.isNaN(Date.parse(input.effectiveFrom)) && Date.parse(input.effectiveFrom) <= Date.parse(current.effectiveFrom)) {
    errors.push(
      fieldError(
        'effectiveFrom',
        'EFFECTIVE_DATE_NOT_FORWARD',
        `effectiveFrom must be strictly after the open version's start ${current.effectiveFrom}; versions are effective-dated forward and never backdated over closed periods`,
      ),
    );
  }
  if (errors.length > 0) {
    return reject(422, 'VALIDATION_FAILED', 'curve supersession failed validation; see fieldErrors', errors);
  }

  // After closing the open version at effectiveFrom the join is a boundary
  // touch, so only OTHER versions could still conflict.
  const conflicts = curvePeriodConflicts(store, streamId, input.effectiveFrom, input.effectiveTo ?? null, current ? [current.id] : []);
  if (conflicts.length > 0) {
    return reject(
      409,
      'PERIOD_OVERLAP',
      `the successor period [${input.effectiveFrom}, ${input.effectiveTo ?? 'open'}) overlaps version(s) ${conflicts.map((version) => version.id).join(', ')}`,
      [fieldError('effectiveFrom', 'PERIOD_OVERLAP', `overlaps ${conflicts.map((version) => version.id).join(', ')}`)],
    );
  }

  const { version, auditEvent, outboxEvent } = store.appendCurveVersion({
    streamId,
    stationId: stream.stationId,
    actorId,
    now: ctx.now,
    closeCurrentAt: input.effectiveFrom,
    action: 'supersede-curve',
    version: {
      stationId: stream.stationId,
      streamId,
      coefficients: { ...input.coefficients },
      unitPair: { ...input.unitPair },
      method: input.method.trim(),
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      author: actorId,
      approvalState: 'draft',
      approvedBy: null,
      approvedAt: null,
      provenance:
        input.provenance ??
        {
          source: `supersedes ${current?.id ?? '(none)'}: ${input.supersedeReason.trim()}`,
          calibrationCount: null,
          note: 'Draft successor awaiting data-owner approval; the prior version is closed, retained and still authoritative for its own period.',
        },
    },
  });
  return { outcome: 'applied', code: 'OK', status: 201, version, auditEvent, outboxEvent };
}

// ---------------------------------------------------------------------------
// Conversion: at-instant resolution with full lineage
// ---------------------------------------------------------------------------

/** Human-readable formula with the coefficients substituted. */
export function formulaText(coefficients: { c: number; b: number; e: number }, stageFt: number, unitId: string): string {
  const { c, b, e } = coefficients;
  const depth = stageFt - e;
  return `Q = ${c} * (${stageFt.toFixed(2)} - ${e})^${b} = ${c} * ${depth.toFixed(2)}^${b} ${unitId}`;
}

/** Evaluate the documented log-linear formula Q = c * (G - e)^b. */
export function evaluateCurve(coefficients: { c: number; b: number; e: number }, stageFt: number): number {
  return coefficients.c * Math.pow(stageFt - coefficients.e, coefficients.b);
}

/**
 * Resolve the curve version approved for `at` and convert `stageFt` to
 * discharge under it. Pure with respect to governance (the version chain is
 * already governed); the only write is the append-only lineage ledger entry,
 * which a later supersession never rewrites.
 *
 * Rejections distinguish three situations:
 * - NO_CURVE_AT_INSTANT: no version at all covers the instant (before the
 *   first curve, after a bounded final period, or an unknown stream -> 404);
 * - NO_APPROVED_CURVE_AT_INSTANT: a version covers the instant but is still
 *   a draft (e.g. the successor window between supersession and approval);
 * - STAGE_BELOW_DATUM / STAGE_NOT_FINITE: the input stage is not evaluable.
 */
export function convertStage(
  store: RatingCurveStore,
  streamId: string,
  stageFt: number,
  at: string,
  ctx: WorkflowContext,
  options: ConvertOptions = {},
): ConversionDecision {
  const stream = store.streamById(streamId);
  if (!stream) {
    return conversionReject(404, 'NOT_FOUND', 'stream not found', []);
  }
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) {
    return conversionReject(422, 'AT_INSTANT_INVALID', 'at must be an ISO 8601 instant', []);
  }
  if (typeof stageFt !== 'number' || !Number.isFinite(stageFt)) {
    return conversionReject(422, 'STAGE_NOT_FINITE', 'stage must be a finite number of feet', []);
  }

  const covering = store.curvesCovering(streamId, at);
  if (covering.length === 0) {
    return conversionReject(
      409,
      'NO_CURVE_AT_INSTANT',
      `no rating-curve version covers ${at} on stream "${streamId}"`,
      [],
    );
  }
  const approved = store.approvedCurveAt(streamId, at);
  if (!approved) {
    return conversionReject(
      409,
      'NO_APPROVED_CURVE_AT_INSTANT',
      `curve version(s) ${covering.map((version) => version.id).join(', ')} cover ${at} but none is approved for conversion yet`,
      covering.filter((version) => version.approvalState === 'draft').map((version) => version.id),
    );
  }

  // Shift layering (see shifts.ts); applyShift defaults to true so the
  // combined conversion is the standard path.
  let effectiveStage = stageFt;
  let shiftVersionId: string | null = null;
  if (options.applyShift !== false) {
    const shift = store.approvedShiftAt(streamId, at);
    if (shift) {
      const segment = shift.segments.find(
        (candidate) =>
          stageFt >= candidate.fromStageFt && (candidate.toStageFt === null || stageFt < candidate.toStageFt),
      );
      if (!segment) {
        return conversionReject(
          422,
          'SHIFT_STAGE_UNCOVERED',
          `shift version ${shift.id} is effective at ${at} but has no segment covering stage ${stageFt} ft; refusing to convert with a partially applied shift`,
          [],
        );
      }
      effectiveStage = stageFt + segment.offsetFt;
      shiftVersionId = shift.id;
    }
  }

  if (effectiveStage <= approved.coefficients.e) {
    return conversionReject(
      422,
      'STAGE_BELOW_DATUM',
      `effective stage ${effectiveStage} ft is at or below the zero-flow datum ${approved.coefficients.e} ft of ${approved.id}`,
      [],
    );
  }

  const value = evaluateCurve(approved.coefficients, effectiveStage);
  const computed: ComputedValue = store.appendComputed({
    stageFt,
    effectiveStageFt: effectiveStage,
    value,
    unitId: approved.unitPair.toUnitId,
    at,
    curveVersionId: approved.id,
    shiftVersionId,
    formula: formulaText(approved.coefficients, effectiveStage, approved.unitPair.toUnitId),
    computedAt: ctx.now,
  });
  return { outcome: 'converted', code: 'OK', value: computed };
}

function conversionReject(
  status: ConversionRejectedDecision['status'],
  code: ConversionRejectedDecision['code'],
  message: string,
  pendingVersionIds: readonly string[],
): ConversionRejectedDecision {
  return { outcome: 'rejected', status, code, message, pendingVersionIds };
}
