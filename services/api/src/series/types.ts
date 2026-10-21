/**
 * Shared types for the WD-008 series domain (aggregation, comparison,
 * grant gate). Source of truth for the numerical rules:
 * docs/product/baseline/02-technical-specification.md, "Numerical and
 * temporal rules" and "Proposed application API" (GET /streams/{id}/observations),
 * plus FR-005/FR-006/FR-007/FR-063/FR-066 in the product requirements.
 */

/** Governed processing levels (vocabulary.json). `best-available` is derived, never stored on a raw row. */
export type ProcessingLevel = 'raw' | 'provisional' | 'reviewed' | 'best-available';

/** Processing basis a caller selects (FR-066: filter by processing basis). */
export type ProcessingBasis = ProcessingLevel;

/** Aggregation interval. Weekly buckets start Monday 00:00 local (America/Denver). */
export type AggregationInterval = 'daily' | 'weekly' | 'monthly' | 'seasonal';

/**
 * Named seasons (technical specification: "Define calendar year, water year
 * and irrigation-season dates per report type with program owners"). Dates
 * here are the documented DEFAULTS pending measurement-owner ratification.
 */
export type SeasonName = 'irrigation' | 'water-year' | 'calendar-year';

/** Quality flags on a point. Computed on the RAW value for raw listings; stats use the effective value at the selected basis. */
export type PointFlag =
  | 'out-of-range' // above validRangeMax
  | 'negative' // below validRangeMin (physically impossible for discharge; lineage naming kept from the shell chart)
  | 'suspect-zero' // exactly 0.0 during freeze: reported, kept, never treated as missing
  | 'null-frame' // reported-but-empty (NaN frame): missing is missing, never zero
  | 'estimated' // estimated value or interpolate-qualified revision
  | 'late-arrival'
  | 'duplicate-timestamp'
  | 'revised'
  | 'below-selected-basis'; // selected provisional/reviewed basis but no revision reached it: raw value shown

/** Raw fixture observation row (verbatim contract shape; fields the domain reads). */
export interface ObservationRow {
  id: string;
  logicalKey: string;
  streamId: string;
  observedAt: string;
  sourceOffset: string;
  value: number | null;
  unitId: string;
  valueType: 'observed' | 'estimated';
  processingLevel: 'raw';
  sourceEventId: string;
  receivedAt: string;
  methodTypeId?: string;
  sourceId: string;
  note?: string;
}

/** Append-only revision row (verbatim contract shape). */
export interface RevisionRow {
  id: string;
  targetObservationId: string;
  baseRevisionId: string | null;
  type: 'correction' | 'level-advance';
  value: number;
  unitId: string;
  processingLevel: 'provisional' | 'reviewed' | 'best-available';
  qualifierIds: string[];
  reason: string;
  actorId: string;
  recordedAt: string;
  idempotencyKey?: string;
}

/** Declared gap (half-open [start, end); the missing readings are NOT zero and NOT interpolated). */
export interface GapRow {
  id: string;
  streamId: string;
  start: string;
  end: string;
  reason: string;
  declaredAt: string;
  expectedCadenceMinutes: number;
  missingCount: number;
  note?: string;
}

/** Datastream fields the series domain needs. */
export interface StreamMeta {
  id: string;
  stationId: string;
  systemId: string;
  observedPropertyId: string;
  unitId: string;
  methodTypeId: string;
  cadenceMinutes: number;
  validRangeMin: number;
  validRangeMax: number;
  visibility: 'public' | 'restricted' | 'internal';
  timeZone: string;
  stationDisplayName: string;
}

/** A point after duplicate-timestamp normalization and basis selection. */
export interface EffectivePoint {
  readonly observationId: string;
  /** Earlier duplicate rows collapsed into this instant (both originals stay in the raw listing). */
  readonly collapsedDuplicateIds: readonly string[];
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly sourceOffset: string;
  readonly sourceEventId: string;
  readonly sourceId: string;
  /** Value at the selected basis (null only when the raw frame was empty). */
  readonly value: number | null;
  /** The raw value, always retained and distinguishable. */
  readonly rawValue: number | null;
  readonly unitId: string;
  readonly valueType: 'observed' | 'estimated';
  readonly processingLevel: ProcessingLevel;
  readonly revisionId: string | null;
  readonly qualifierIds: readonly string[];
  readonly estimated: boolean;
  /** Flags computed on the effective value (drives statistics exclusion). */
  readonly flags: readonly PointFlag[];
  /** Flags computed on the raw value (raw-listing surface keeps spikes visible). */
  readonly rawFlags: readonly PointFlag[];
}

/** One aggregation bucket over a local calendar window [intervalStart, intervalEnd). */
export interface AggregatedInterval {
  readonly key: string;
  readonly intervalStart: string;
  readonly intervalEnd: string;
  /** Actual local-window duration: 82800 s on the 23-hour spring-forward day, 90000 s on the 25-hour fall-back day. */
  readonly durationSeconds: number;
  readonly coveredSeconds: number;
  readonly coverageFraction: number;
  readonly estimatedSeconds: number;
  /** estimated covered seconds / covered seconds (0 when nothing is covered). */
  readonly estimatedProportion: number;
  /** Mean rate over the covered portion (volume / covered seconds); null when nothing is covered. Missing is never zero. */
  readonly meanValue: number | null;
  /** Integrated volume over the covered portion only; null when nothing is covered. */
  readonly volumeAcreFeet: number | null;
  readonly pointCount: number;
  readonly excludedPointCount: number;
  readonly nullPointCount: number;
  /** Declared gaps overlapping this bucket (rendered as hatching, never back-filled). */
  readonly gaps: readonly { id: string; start: string; end: string; reason: string }[];
}

/** Versioned integration method identity (every derived summary carries its method). */
export const AGGREGATION_METHOD = 'rectangle-right@1' as const;

/** Typed domain denial. HTTP layers map `status`/`code` per the auth error table. */
export interface DomainDenial {
  readonly outcome: 'denied';
  readonly status: 400 | 401 | 403 | 404 | 413 | 422;
  readonly code: string;
  readonly message: string;
  readonly policyReason?: string;
}

export interface DomainAllow<T> {
  readonly outcome: 'allowed';
  readonly value: T;
}

export type DomainResult<T> = DomainAllow<T> | DomainDenial;

export function denial(
  status: DomainDenial['status'],
  code: string,
  message: string,
  policyReason?: string,
): DomainDenial {
  return { outcome: 'denied', status, code, message, ...(policyReason !== undefined ? { policyReason } : {}) };
}

export function isDenial<T>(result: DomainResult<T>): result is DomainDenial {
  return result.outcome === 'denied';
}

/** Server-side maximum bounds (technical specification: bounded series, server-side maximum bounds). */
export const SERIES_LIMITS = {
  /** Largest requested [start,end) window. */
  maxWindowDays: 400,
  /** Largest raw point listing returned inline; larger selections must use aggregation or an export job. */
  maxRawPoints: 20000,
  /** Days of look-back (at stream cadence) so forward-cadence readings that govern the window are loaded. */
  maxLookBackDays: 31,
} as const;
