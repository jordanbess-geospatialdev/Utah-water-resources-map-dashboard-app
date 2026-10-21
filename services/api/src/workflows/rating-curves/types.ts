/**
 * Type vocabulary for the rating-curve workflow (WD-011-R2, FR-045):
 * "Effective-dated curve and shift versions retain author, approval state
 * and provenance; computed values identify the version used, and a revised
 * curve does not erase earlier conversions or inspection evidence."
 *
 * Domain model (technical specification, measurement model row "Rating curve
 * and shift": "Versioned coefficients/method/unit, valid interval,
 * deployment, approval and derived-output lineage"):
 * - RatingCurveVersion - one append-only version of a station's stage ->
 *   discharge curve with log-linear coefficients Q = c * (G - e)^b, a unit
 *   pair, the fitting method, a HALF-OPEN effective interval
 *   [effectiveFrom, effectiveTo), the author, a governance state
 *   (draft -> approved -> superseded) and calibration provenance.
 * - RatingShift - the same governance shape for shift adjustments: stage
 *   offset segments layered ON a curve, effective-dated like the curve.
 * - ComputedValue - a conversion result carrying full lineage (the curve
 *   version id and shift version id it was computed under).
 *
 * Purity contract: domain types only. No HTTP framework, no I/O, no clock
 * reads; every mutation takes an injected `now` (WorkflowContext). The
 * future Fastify layer maps these decisions onto the shared error policy:
 * 401 identity, 403 capability, 404 hidden object, 409 period overlap or
 * invalid transition, 422 validation with field paths.
 */

/** Governance states of a curve or shift version (FR-045 "approval state"). */
export type ApprovalState = 'draft' | 'approved' | 'superseded';

/** Coefficients of the log-linear power curve Q = c * (G - e)^b. */
export interface LogLinearCoefficients {
  /** Discharge coefficient: cfs at unit effective depth. Must be > 0. */
  readonly c: number;
  /** Exponent (log-space slope). Must be > 0; fractional exponents are normal. */
  readonly b: number;
  /** Zero-flow datum offset e in feet: stage minus offset is the effective depth. Must be >= 0. */
  readonly e: number;
}

/** Input/output unit pair of a curve (governed vocabulary units). */
export interface UnitPair {
  readonly fromUnitId: string;
  readonly toUnitId: string;
}

/**
 * Calibration provenance retained with every version (FR-045): where the
 * coefficients came from and what they were fitted against.
 */
export interface RatingCurveProvenance {
  /** Human-readable origin (e.g. fixture ratingCurvePeriods entry, field calibration file). */
  readonly source: string;
  /** Number of calibration measurements the fit used, when known. */
  readonly calibrationCount: number | null;
  readonly note: string | null;
}

/**
 * One version of a station's rating curve. The record is append-only: a
 * revision CLOSES the prior version's interval (without deleting it) and
 * appends a new version; `version` is the 1-based ordinal within the
 * stream's chain so history never collapses.
 */
export interface RatingCurveVersion {
  readonly id: string;
  readonly stationId: string;
  readonly streamId: string;
  readonly coefficients: LogLinearCoefficients;
  readonly unitPair: UnitPair;
  /** Fitting method label (e.g. "Log-linear least squares, n=18 calibrations"). */
  readonly method: string;
  /** UTC instant; the interval is HALF-OPEN [effectiveFrom, effectiveTo). null end = open. */
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  /** Principal id of the author (retained after actor deactivation, FR-045). */
  readonly author: string;
  readonly approvalState: ApprovalState;
  /** Approver principal id; null while the version is a draft. */
  readonly approvedBy: string | null;
  /** Approval instant; null while the version is a draft. */
  readonly approvedAt: string | null;
  readonly provenance: RatingCurveProvenance;
  /** 1-based ordinal within the stream's chain (superseded versions keep theirs). */
  readonly version: number;
  /** Creation (append) instant. */
  readonly createdAt: string;
  /** Supersession instant; null until a later version closes this one. */
  readonly supersededAt: string | null;
}

/** One stage-offset segment of a shift: stages [fromStageFt, toStageFt) shift by offsetFt. */
export interface ShiftSegment {
  readonly fromStageFt: number;
  /** Segment upper bound in feet; null = open tail covering everything above. */
  readonly toStageFt: number | null;
  /** Stage offset added BEFORE the curve is applied (negative lowers the effective stage). */
  readonly offsetFt: number;
}

/**
 * One version of a shift adjustment layered on a station's curve. Same
 * governance as a curve version: author, half-open effective interval,
 * draft/approved/superseded and provenance (FR-045 extends to shifts).
 */
export interface RatingShift {
  readonly id: string;
  readonly stationId: string;
  readonly streamId: string;
  /** Stage-offset segments, sorted by fromStageFt; the tail segment may be open. */
  readonly segments: readonly ShiftSegment[];
  /** Why the shift exists (gauge datum move, debris, icing...); retained as provenance. */
  readonly reason: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly author: string;
  readonly approvalState: ApprovalState;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly provenance: RatingCurveProvenance;
  readonly version: number;
  readonly createdAt: string;
  readonly supersededAt: string | null;
}

/**
 * A conversion result with FULL lineage (FR-045 "computed values identify
 * the version used"): the curve version and, when a shift was layered, the
 * shift version. Ledger entries are frozen once recorded - a later curve
 * revision never rewrites them.
 */
export interface ComputedValue {
  /** Requested (measured) stage in feet. */
  readonly stageFt: number;
  /** Stage after the shift offset (equal to stageFt when no shift applies). */
  readonly effectiveStageFt: number;
  /** Discharge in the curve's output unit. */
  readonly value: number;
  readonly unitId: string;
  /** Resolution instant: which effective interval was matched. */
  readonly at: string;
  readonly curveVersionId: string;
  /** Shift version id applied before the curve; null when no shift is in effect. */
  readonly shiftVersionId: string | null;
  /** Substituted formula, e.g. "Q = 41.2 * (2.52 - 1.68)^1.92 cfs". */
  readonly formula: string;
  /** Ledger record instant (injected clock at conversion time). */
  readonly computedAt: string;
}

/** Field-level validation error (mirrors the WD-010/Wd-011 shape). */
export interface RatingCurveFieldError {
  readonly fieldPath: string;
  readonly code: string;
  readonly message: string;
}

export type RatingCurveAction =
  | 'create-curve'
  | 'approve-curve'
  | 'supersede-curve'
  | 'create-shift'
  | 'approve-shift'
  | 'supersede-shift';

/**
 * Audit row for one mutation: actor, action, the version appended (and the
 * version it superseded), the state transition, and the correlation id it
 * shares with the outbox event (ADR-10 traceability).
 */
export interface CurveAuditEvent {
  readonly id: string;
  readonly action: RatingCurveAction;
  readonly actorId: string;
  readonly stationId: string;
  readonly streamId: string;
  /** Version this event appended or transitioned. */
  readonly versionId: string;
  /** Version closed by this event, when the event superseded one. */
  readonly supersededVersionId: string | null;
  /** Governance state before / after the event ('' for the initial create). */
  readonly beforeState: ApprovalState | null;
  readonly afterState: ApprovalState;
  readonly recordedAt: string;
  readonly correlationId: string;
}

/** Transactional-outbox publication refresh written with every mutation. */
export interface CurveOutboxEvent {
  readonly id: string;
  readonly type: 'rating-curve-published' | 'rating-shift-published';
  readonly streamId: string;
  readonly versionId: string;
  readonly recordedAt: string;
  readonly correlationId: string;
}

export interface AppliedVersionDecision<T> {
  readonly outcome: 'applied';
  readonly code: 'OK';
  readonly status: 200 | 201;
  readonly version: T;
  readonly auditEvent: CurveAuditEvent;
  readonly outboxEvent: CurveOutboxEvent;
}

export type VersionRejectedCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PERIOD_OVERLAP'
  | 'INVALID_TRANSITION'
  | 'VALIDATION_FAILED';

export interface RejectedDecision {
  readonly outcome: 'rejected';
  readonly status: 401 | 403 | 404 | 409 | 422;
  readonly code: VersionRejectedCode;
  readonly message: string;
  readonly fieldErrors: readonly RatingCurveFieldError[];
  /** Policy-engine DENY_* reason when this is a capability denial. */
  readonly policyReason: string | null;
}

export type VersionDecision<T> = AppliedVersionDecision<T> | RejectedDecision;

export type ConversionRejectedCode =
  | 'NOT_FOUND'
  | 'AT_INSTANT_INVALID'
  | 'NO_CURVE_AT_INSTANT'
  | 'NO_APPROVED_CURVE_AT_INSTANT'
  | 'STAGE_BELOW_DATUM'
  | 'STAGE_NOT_FINITE'
  | 'SHIFT_STAGE_UNCOVERED';

export interface ConvertedDecision {
  readonly outcome: 'converted';
  readonly code: 'OK';
  readonly value: ComputedValue;
}

export interface ConversionRejectedDecision {
  readonly outcome: 'rejected';
  readonly status: 404 | 409 | 422;
  readonly code: ConversionRejectedCode;
  readonly message: string;
  /** Resolution detail for the UI: the versions that exist but are not approved. */
  readonly pendingVersionIds: readonly string[];
}

export type ConversionDecision = ConvertedDecision | ConversionRejectedDecision;

/** Injected execution context: the workflow never reads a clock internally. */
export interface WorkflowContext {
  readonly now: string;
}

/** Body of a curve-version creation (or of the superseding successor). */
export interface CurveVersionInput {
  readonly coefficients: LogLinearCoefficients;
  readonly unitPair: UnitPair;
  readonly method: string;
  readonly effectiveFrom: string;
  /** Optional explicit end; null = open-ended (must be superseded later). */
  readonly effectiveTo?: string | null;
  readonly provenance?: RatingCurveProvenance;
}

/** Body of a supersession: the successor curve plus why the prior is replaced. */
export interface SupersedeCurveInput extends CurveVersionInput {
  /** Required justification retained as provenance of the transition. */
  readonly supersedeReason: string;
}

/** Body of a shift-version creation (or of the superseding successor). */
export interface ShiftVersionInput {
  readonly segments: readonly ShiftSegment[];
  readonly reason: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
  readonly provenance?: RatingCurveProvenance;
}

/** Body of a shift supersession. */
export interface SupersedeShiftInput extends ShiftVersionInput {
  readonly supersedeReason: string;
}

/** Options for a conversion: layer the effective approved shift or not. */
export interface ConvertOptions {
  readonly applyShift?: boolean;
}
