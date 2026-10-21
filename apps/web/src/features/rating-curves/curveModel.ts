/**
 * Pure view models for the rating-curves feature (WD-011-R2, FR-045).
 *
 * No React, no fixtures, no clock: every function maps already-loaded
 * version chains (the shape the API workflow returns) onto renderable
 * rows, period labels, timeline order, state badges and lineage strings,
 * and evaluates the conversion tester locally.
 *
 * The evaluation mirrors the authoritative workflow
 * (services/api/src/workflows/rating-curves) exactly: half-open intervals
 * [effectiveFrom, effectiveTo), the version approved for the instant
 * (approval evidence survives supersession, so a superseded curve still
 * defines its own historical period), the documented formula
 * Q = c * (G - e)^b and shift segments applied to the stage before the
 * curve. The panel's README documents the pending API wiring.
 */

export type ApprovalState = 'draft' | 'approved' | 'superseded';

/** View shape of a rating-curve version (field-compatible with the API type). */
export interface CurveVersionView {
  readonly id: string;
  readonly version: number;
  readonly method: string;
  readonly coefficients: { readonly c: number; readonly b: number; readonly e: number };
  readonly unitPair: { readonly fromUnitId: string; readonly toUnitId: string };
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly author: string;
  readonly approvalState: ApprovalState;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly provenanceNote: string | null;
}

export interface ShiftSegmentView {
  readonly fromStageFt: number;
  readonly toStageFt: number | null;
  readonly offsetFt: number;
}

/** View shape of a shift version. */
export interface ShiftVersionView {
  readonly id: string;
  readonly version: number;
  readonly segments: readonly ShiftSegmentView[];
  readonly reason: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly author: string;
  readonly approvalState: ApprovalState;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
}

/** One renderable row of the version timeline (curves and shifts together). */
export interface VersionRow {
  readonly kind: 'curve' | 'shift';
  readonly id: string;
  readonly version: number;
  /** State is ALWAYS text + shape, never color alone. */
  readonly stateMarker: '●' | '○' | '✕';
  readonly stateText: string;
  readonly periodLabel: string;
  readonly title: string;
  readonly detail: string;
  readonly author: string;
  readonly approvalLabel: string;
  readonly superseded: boolean;
  readonly lineageLabel: string;
}

/** Result of the conversion tester. */
export type ConversionResult =
  | {
      readonly kind: 'converted';
      readonly value: number;
      readonly unitId: string;
      readonly stageFt: number;
      readonly effectiveStageFt: number;
      readonly curveVersionId: string;
      readonly shiftVersionId: string | null;
      readonly formula: string;
      readonly periodLabel: string;
      readonly lineage: string;
    }
  | {
      readonly kind: 'rejected';
      readonly code: 'NO_CURVE' | 'NOT_APPROVED' | 'STAGE_BELOW_DATUM' | 'STAGE_INVALID' | 'SHIFT_UNCOVERED' | 'AT_INVALID';
      readonly message: string;
    };

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Half-open interval label: '[2019-10-01T00:00:00Z, 2026-03-07T18:00:00Z)' or '[…, open)'. */
export function formatInterval(from: string, to: string | null): string {
  return `[${from}, ${to ?? 'open'})`;
}

/** True when the half-open interval [from, to) covers `at`. */
export function intervalCovers(from: string, to: string | null, at: string): boolean {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return false;
  return Date.parse(from) <= t && (to === null || t < Date.parse(to));
}

/** Approval badge: marker + text, identical for curves and shifts. */
export function stateBadge(state: ApprovalState): { marker: '●' | '○' | '✕'; text: string } {
  switch (state) {
    case 'approved':
      return { marker: '●', text: 'approved' };
    case 'draft':
      return { marker: '○', text: 'draft (pending owner approval)' };
    case 'superseded':
      return { marker: '✕', text: 'superseded (retained)' };
  }
}

/** Approval column: approver + instant, or the pending label. */
export function approvalLabel(version: { approvalState: ApprovalState; approvedBy: string | null; approvedAt: string | null }): string {
  if (version.approvalState === 'draft') return 'pending';
  const who = version.approvedBy ?? 'unknown';
  const when = version.approvedAt ?? 'unknown time';
  return `${who} at ${when}`;
}

/** Substituted formula text: 'Q = 41.2 * (2.52 - 1.68)^1.92 cfs'. */
export function formulaText(coefficients: { c: number; b: number; e: number }, stageFt: number, unitId: string): string {
  const depth = stageFt - coefficients.e;
  return `Q = ${coefficients.c} * (${stageFt.toFixed(2)} - ${coefficients.e})^${coefficients.b} = ${coefficients.c} * ${depth.toFixed(2)}^${coefficients.b} ${unitId}`;
}

/** Curve-formula summary for the version table (symbolic, no stage). */
export function curveFormula(coefficients: { c: number; b: number; e: number }, unitPair: { fromUnitId: string; toUnitId: string }): string {
  return `Q[${unitPair.toUnitId}] = ${coefficients.c} × (G[${unitPair.fromUnitId}] − ${coefficients.e})^${coefficients.b}`;
}

/** Shift-segment summary: '+0.03 ft on [0, 2.45); +0.06 ft on [2.45, open)'. */
export function shiftSegmentsText(segments: readonly ShiftSegmentView[]): string {
  return segments
    .map((segment) => `${segment.offsetFt >= 0 ? '+' : ''}${segment.offsetFt} ft on [${segment.fromStageFt}, ${segment.toStageFt ?? 'open'})`)
    .join('; ');
}

/** Lineage string naming every version a value was computed under. */
export function lineageString(value: { curveVersionId: string; shiftVersionId: string | null }): string {
  return value.shiftVersionId === null
    ? `curve ${value.curveVersionId}`
    : `curve ${value.curveVersionId} + shift ${value.shiftVersionId}`;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * The version timeline: every curve and shift version, oldest first,
 * superseded versions INCLUDED (history never collapses - FR-045). The
 * timeline is the single ordering the panel renders.
 */
export function buildTimeline(curves: readonly CurveVersionView[], shifts: readonly ShiftVersionView[]): readonly VersionRow[] {
  const rows: VersionRow[] = [];
  for (const curve of curves) {
    const badge = stateBadge(curve.approvalState);
    rows.push({
      kind: 'curve',
      id: curve.id,
      version: curve.version,
      stateMarker: badge.marker,
      stateText: badge.text,
      periodLabel: formatInterval(curve.effectiveFrom, curve.effectiveTo),
      title: curve.method,
      detail: curveFormula(curve.coefficients, curve.unitPair) + (curve.provenanceNote ? ` — ${curve.provenanceNote}` : ''),
      author: curve.author,
      approvalLabel: approvalLabel(curve),
      superseded: curve.approvalState === 'superseded',
      lineageLabel: `v${curve.version} ${curve.id}`,
    });
  }
  for (const shift of shifts) {
    const badge = stateBadge(shift.approvalState);
    rows.push({
      kind: 'shift',
      id: shift.id,
      version: shift.version,
      stateMarker: badge.marker,
      stateText: badge.text,
      periodLabel: formatInterval(shift.effectiveFrom, shift.effectiveTo),
      title: shift.reason,
      detail: shiftSegmentsText(shift.segments),
      author: shift.author,
      approvalLabel: approvalLabel(shift),
      superseded: shift.approvalState === 'superseded',
      lineageLabel: `v${shift.version} ${shift.id}`,
    });
  }
  return rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.version - b.version);
}

// ---------------------------------------------------------------------------
// Conversion (mirrors the API workflow; see the file header)
// ---------------------------------------------------------------------------

/**
 * Convert a stage at an instant under the version chains. Resolution order:
 * 1. the curve version whose interval covers `at` - none -> NO_CURVE;
 * 2. it must carry approval evidence (approved OR superseded-with-approval)
 *    -> NOT_APPROVED while only a draft covers the instant;
 * 3. an approved shift covering `at` applies its matching segment to the
 *    stage first (no partial application: SHIFT_UNCOVERED);
 * 4. the effective stage must sit above the curve datum.
 */
export function convertStage(
  curves: readonly CurveVersionView[],
  shifts: readonly ShiftVersionView[],
  stageFt: number,
  at: string,
): ConversionResult {
  if (typeof stageFt !== 'number' || !Number.isFinite(stageFt)) {
    return { kind: 'rejected', code: 'STAGE_INVALID', message: 'stage must be a finite number of feet' };
  }
  const t = Date.parse(at);
  if (Number.isNaN(t)) {
    return { kind: 'rejected', code: 'AT_INVALID', message: 'the instant must be an ISO 8601 timestamp' };
  }
  const covering = curves.filter((curve) => intervalCovers(curve.effectiveFrom, curve.effectiveTo, at));
  const curve = covering.find((candidate) => candidate.approvedAt !== null && candidate.approvalState !== 'draft');
  if (covering.length === 0) {
    return { kind: 'rejected', code: 'NO_CURVE', message: `no rating-curve version covers ${at}` };
  }
  if (!curve) {
    return {
      kind: 'rejected',
      code: 'NOT_APPROVED',
      message: `curve version(s) ${covering.map((candidate) => candidate.id).join(', ')} cover ${at} but none is approved yet`,
    };
  }

  let effectiveStage = stageFt;
  let shiftId: string | null = null;
  const shift = shifts.find((candidate) => candidate.approvedAt !== null && candidate.approvalState !== 'draft' && intervalCovers(candidate.effectiveFrom, candidate.effectiveTo, at));
  if (shift) {
    const segment = shift.segments.find(
      (candidate) => stageFt >= candidate.fromStageFt && (candidate.toStageFt === null || stageFt < candidate.toStageFt),
    );
    if (!segment) {
      return {
        kind: 'rejected',
        code: 'SHIFT_UNCOVERED',
        message: `shift ${shift.id} is effective at ${at} but has no segment covering ${stageFt} ft`,
      };
    }
    effectiveStage = stageFt + segment.offsetFt;
    shiftId = shift.id;
  }

  if (effectiveStage <= curve.coefficients.e) {
    return {
      kind: 'rejected',
      code: 'STAGE_BELOW_DATUM',
      message: `effective stage ${effectiveStage.toFixed(2)} ft is at or below the zero-flow datum ${curve.coefficients.e} ft of ${curve.id}`,
    };
  }

  const value = curve.coefficients.c * Math.pow(effectiveStage - curve.coefficients.e, curve.coefficients.b);
  return {
    kind: 'converted',
    value,
    unitId: curve.unitPair.toUnitId,
    stageFt,
    effectiveStageFt: effectiveStage,
    curveVersionId: curve.id,
    shiftVersionId: shiftId,
    formula: formulaText(curve.coefficients, effectiveStage, curve.unitPair.toUnitId),
    periodLabel: formatInterval(curve.effectiveFrom, curve.effectiveTo),
    lineage: lineageString({ curveVersionId: curve.id, shiftVersionId: shiftId }),
  };
}
