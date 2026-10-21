/**
 * Versioned automated QC rules (WD-013; FR-015).
 *
 * "Range including voltage, rate-of-change, persistence, missing-data and
 * zero-value rules detect known fixture violations; each rule stores author
 * and update time, runs independently, and can be tested before promotion."
 *
 * The FIVE rule families are pure, versioned CONFIGURATIONS plus a pure
 * evaluator: evaluate(series, ruleVersion) -> violations. Every violation
 * carries (ruleId, ruleVersion, streamId, half-open interval, observed
 * summary, expected rationale text). No I/O, no clock reads - the engine
 * (engine.ts) injects time and isolation; the golden fixture outcomes are
 * hand-derived in expected.ts (reviewed-pending-owner-approval).
 *
 * Determinism contract: the input series may arrive in any order; points are
 * sorted by (observedAt, observationId) before evaluation and violations are
 * returned sorted by (observedAt start, observed) so two runs over the same
 * series produce byte-identical output.
 *
 * Semantics chosen for the five families (each documented where implemented):
 *
 * - range: per-OBSERVED-PROPERTY min/max bounds (the discharge/stage bounds
 *   of the telemetry fixture and the VOLTAGE bounds of the internal
 *   diagnostic stream). A null value (reported-but-empty NaN frame) is not a
 *   range violation - missing data is the missing-data family's concern.
 * - rate-of-change: max |delta| per CADENCE INTERVAL, normalized over the
 *   elapsed intervals between consecutive NON-NULL readings, so a legitimate
 *   gap-edge step is not a false positive. Duplicate timestamps (elapsed 0)
 *   are skipped: an instantaneous delta has no rate.
 * - persistence: N or more consecutive NON-NULL readings with EXACTLY equal
 *   values (a stuck sensor). The fixture has no stuck window, so the
 *   reviewed expected outcome for the fixture series is ZERO persistence
 *   violations and a deterministic SYNTHESIZED stuck window is part of the
 *   golden (expected.ts).
 * - missing-data: a gap between consecutive observations longer than
 *   gapFactor x cadence. Duplicate timestamps collapse to one instant (they
 *   are an ingestion concern, not a missing-data violation); the reported
 *   interval is the missing slot span [prev + cadence, next).
 * - zero-value: an ISOLATED exact zero (nearest non-null neighbours both
 *   non-zero) on a stream whose cadence implies readings
 *   (cadenceMinutes <= maxCadenceMinutes). A sustained true zero is the
 *   persistence family's story, not this one.
 */

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const RULE_FAMILIES = ['range', 'rate-of-change', 'persistence', 'missing-data', 'zero-value'] as const;
export type QcRuleFamily = (typeof RULE_FAMILIES)[number];

/** Lifecycle per FR-015: authored draft -> fixture-tested -> steward-promoted. */
export const RULE_STATUSES = ['draft', 'test', 'promoted'] as const;
export type QcRuleStatus = (typeof RULE_STATUSES)[number];

export interface RangeRuleConfig {
  readonly family: 'range';
  /** Min/max per observedPropertyId, INCLUDING the voltage bounds (FR-015). */
  readonly bounds: Readonly<Record<string, { readonly min: number; readonly max: number }>>;
}

export interface RateOfChangeRuleConfig {
  readonly family: 'rate-of-change';
  /** Max |delta| per cadence interval, per observedPropertyId. */
  readonly maxDeltaPerInterval: Readonly<Record<string, number>>;
}

export interface PersistenceRuleConfig {
  readonly family: 'persistence';
  /** Consecutive exactly-equal non-null readings at/above this count are stuck. */
  readonly minConsecutive: number;
}

export interface MissingDataRuleConfig {
  readonly family: 'missing-data';
  /** A gap is a violation when elapsed > gapFactor x cadenceMinutes. */
  readonly gapFactor: number;
}

export interface ZeroValueRuleConfig {
  readonly family: 'zero-value';
  /** Streams with cadence at/below this many minutes imply readings (telemetry). */
  readonly maxCadenceMinutes: number;
}

export type QcRuleConfig =
  | RangeRuleConfig
  | RateOfChangeRuleConfig
  | PersistenceRuleConfig
  | MissingDataRuleConfig
  | ZeroValueRuleConfig;

/** One immutable version of a rule (FR-015: author + created/updated + status). */
export interface QcRuleVersion {
  readonly ruleId: string;
  readonly family: QcRuleFamily;
  /** 1-based, monotonic per ruleId; edits append a new draft version. */
  readonly version: number;
  readonly status: QcRuleStatus;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly config: QcRuleConfig;
  readonly notes: string | null;
}

export interface QcSeriesPoint {
  /** Fixture/source observation id (evidence links); null for synthesized points. */
  readonly observationId: string | null;
  /** ISO instant (UTC). */
  readonly observedAt: string;
  /** null = reported-but-empty (NaN frame): missing-but-present, never zero. */
  readonly value: number | null;
}

export interface QcSeries {
  readonly streamId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  readonly cadenceMinutes: number;
  readonly points: readonly QcSeriesPoint[];
}

/** Half-open [start, end) interval on observation time, ISO instants. */
export interface QcInterval {
  readonly start: string;
  readonly end: string;
}

export interface QcViolation {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly family: QcRuleFamily;
  readonly streamId: string;
  readonly interval: QcInterval;
  /** Observed value / delta / window summary, e.g. "-1.2 cfs" or "6 missing readings". */
  readonly observed: string;
  /** Expected rationale text: names the threshold and the breach. */
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O; floats formatted to avoid binary noise in goldens)
// ---------------------------------------------------------------------------

/** Format a number with up to 4 decimals, trailing zeros trimmed ('-22', '9.75'). */
export function fmt(value: number): string {
  const fixed = value.toFixed(4);
  const trimmed = fixed.replace(/\.?0+$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

function endOfBucket(startIso: string, cadenceMinutes: number): string {
  return isoAt(Date.parse(startIso) + cadenceMinutes * 60_000);
}

function sortedViolations(violations: readonly QcViolation[]): readonly QcViolation[] {
  return [...violations].sort((a, b) => (a.interval.start < b.interval.start ? -1 : a.interval.start > b.interval.start ? 1 : a.observed < b.observed ? -1 : 1));
}

interface SortedPoint {
  readonly point: QcSeriesPoint;
  readonly atMs: number;
}

/** Deterministic point order: (observedAt, observationId). */
function sortedPoints(series: QcSeries): readonly SortedPoint[] {
  return [...series.points]
    .map((point) => ({ point, atMs: Date.parse(point.observedAt) }))
    .sort((a, b) => (a.atMs - b.atMs !== 0 ? a.atMs - b.atMs : `${a.point.observationId ?? ''}` < `${b.point.observationId ?? ''}` ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Family evaluators
// ---------------------------------------------------------------------------

function evaluateRange(series: QcSeries, rule: QcRuleVersion, config: RangeRuleConfig): QcViolation[] {
  const bounds = config.bounds[series.observedPropertyId];
  if (!bounds) return []; // property without configured bounds: rule does not apply
  const cadenceMs = series.cadenceMinutes * 60_000;
  const out: QcViolation[] = [];
  for (const { point } of sortedPoints(series)) {
    if (point.value === null) continue; // null frame: missing-data family, not range
    if (point.value < bounds.min) {
      out.push({
        ruleId: rule.ruleId,
        ruleVersion: rule.version,
        family: 'range',
        streamId: series.streamId,
        interval: { start: point.observedAt, end: isoAt(Date.parse(point.observedAt) + cadenceMs) },
        observed: `${fmt(point.value)} ${series.unitId}`,
        rationale: `value ${fmt(point.value)} ${series.unitId} is below the rule minimum ${fmt(bounds.min)} ${series.unitId} for property ${series.observedPropertyId} (rule ${rule.ruleId} v${rule.version})`,
      });
    } else if (point.value > bounds.max) {
      out.push({
        ruleId: rule.ruleId,
        ruleVersion: rule.version,
        family: 'range',
        streamId: series.streamId,
        interval: { start: point.observedAt, end: isoAt(Date.parse(point.observedAt) + cadenceMs) },
        observed: `${fmt(point.value)} ${series.unitId}`,
        rationale: `value ${fmt(point.value)} ${series.unitId} is above the rule maximum ${fmt(bounds.max)} ${series.unitId} for property ${series.observedPropertyId} (rule ${rule.ruleId} v${rule.version})`,
      });
    }
  }
  return out;
}

function evaluateRateOfChange(series: QcSeries, rule: QcRuleVersion, config: RateOfChangeRuleConfig): QcViolation[] {
  const max = config.maxDeltaPerInterval[series.observedPropertyId];
  if (max === undefined) return [];
  const cadenceMs = series.cadenceMinutes * 60_000;
  const valued = sortedPoints(series).filter((entry) => entry.point.value !== null);
  const out: QcViolation[] = [];
  for (let index = 1; index < valued.length; index += 1) {
    const prev = valued[index - 1]!;
    const current = valued[index]!;
    const intervals = (current.atMs - prev.atMs) / cadenceMs;
    if (intervals <= 0) continue; // duplicate timestamp: no rate over zero time
    const delta = current.point.value! - prev.point.value!;
    const rate = Math.abs(delta) / intervals;
    if (rate > max) {
      out.push({
        ruleId: rule.ruleId,
        ruleVersion: rule.version,
        family: 'rate-of-change',
        streamId: series.streamId,
        interval: { start: current.point.observedAt, end: isoAt(current.atMs + cadenceMs) },
        observed: `delta ${fmt(delta)} ${series.unitId} over ${fmt(intervals)} interval${intervals === 1 ? '' : 's'}`,
        rationale: `rate of change ${fmt(rate)} ${series.unitId}/interval exceeds the rule maximum ${fmt(max)} ${series.unitId}/interval for property ${series.observedPropertyId} (rule ${rule.ruleId} v${rule.version})`,
      });
    }
  }
  return out;
}

function evaluatePersistence(series: QcSeries, rule: QcRuleVersion, config: PersistenceRuleConfig): QcViolation[] {
  const cadenceMs = series.cadenceMinutes * 60_000;
  const valued = sortedPoints(series).filter((entry) => entry.point.value !== null);
  const out: QcViolation[] = [];
  let runStart = 0;
  while (runStart < valued.length) {
    let runEnd = runStart + 1;
    while (runEnd < valued.length && valued[runEnd]!.point.value === valued[runStart]!.point.value) runEnd += 1;
    const count = runEnd - runStart;
    if (count >= config.minConsecutive) {
      const first = valued[runStart]!;
      const last = valued[runEnd - 1]!;
      const value = first.point.value!;
      out.push({
        ruleId: rule.ruleId,
        ruleVersion: rule.version,
        family: 'persistence',
        streamId: series.streamId,
        interval: { start: first.point.observedAt, end: isoAt(last.atMs + cadenceMs) },
        observed: `${count} identical readings of ${fmt(value)} ${series.unitId}`,
        rationale: `value stayed exactly ${fmt(value)} ${series.unitId} for ${count} consecutive readings, at or above the rule minimum ${config.minConsecutive}: consistent with a stuck sensor (rule ${rule.ruleId} v${rule.version})`,
      });
    }
    runStart = runEnd;
  }
  return out;
}

function evaluateMissingData(series: QcSeries, rule: QcRuleVersion, config: MissingDataRuleConfig): QcViolation[] {
  const cadenceMs = series.cadenceMinutes * 60_000;
  // Duplicate timestamps collapse to one instant: a retransmission is an
  // ingestion concern and must never masquerade as a data gap.
  const unique = sortedPoints(series).filter((entry, index, all) => index === 0 || entry.atMs !== all[index - 1]!.atMs);
  const out: QcViolation[] = [];
  for (let index = 1; index < unique.length; index += 1) {
    const prev = unique[index - 1]!;
    const next = unique[index]!;
    const elapsedMs = next.atMs - prev.atMs;
    if (elapsedMs <= config.gapFactor * cadenceMs) continue;
    const steps = Math.max(1, Math.round(elapsedMs / cadenceMs));
    const missing = Math.max(0, steps - 1);
    if (missing < 1) continue;
    const elapsedMinutes = elapsedMs / 60_000;
    out.push({
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      family: 'missing-data',
      streamId: series.streamId,
      interval: { start: isoAt(prev.atMs + cadenceMs), end: next.point.observedAt },
      observed: `${missing} missing reading${missing === 1 ? '' : 's'}`,
      rationale: `no reading for ${fmt(elapsedMinutes)} minutes (${missing} expected at ${series.cadenceMinutes}-minute cadence), beyond the rule threshold ${fmt(config.gapFactor)}x cadence (rule ${rule.ruleId} v${rule.version})`,
    });
  }
  return out;
}

function evaluateZeroValue(series: QcSeries, rule: QcRuleVersion, config: ZeroValueRuleConfig): QcViolation[] {
  if (series.cadenceMinutes > config.maxCadenceMinutes) return []; // manual/weekly zero may be a measured dry reading
  const cadenceMs = series.cadenceMinutes * 60_000;
  const valued = sortedPoints(series).filter((entry) => entry.point.value !== null);
  const out: QcViolation[] = [];
  for (let index = 0; index < valued.length; index += 1) {
    const current = valued[index]!;
    if (current.point.value !== 0) continue;
    const prev = valued[index - 1];
    const next = valued[index + 1];
    // Isolated: nearest non-null neighbours on both sides are non-zero (a
    // sustained zero run is the persistence family's story).
    if (prev !== undefined && prev.point.value === 0) continue;
    if (next !== undefined && next.point.value === 0) continue;
    const prevText = prev !== undefined ? `previous ${fmt(prev.point.value!)}` : 'series start';
    const nextText = next !== undefined ? `next ${fmt(next.point.value!)}` : 'series end';
    out.push({
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      family: 'zero-value',
      streamId: series.streamId,
      interval: { start: current.point.observedAt, end: isoAt(current.atMs + cadenceMs) },
      observed: `exact 0 ${series.unitId}`,
      rationale: `isolated exact zero between non-zero readings (${prevText}, ${nextText}) on a ${series.cadenceMinutes}-minute cadence stream where readings are expected: a suspect flat zero, not a measured zero (rule ${rule.ruleId} v${rule.version})`,
    });
  }
  return out;
}

/**
 * Evaluate ONE rule version against ONE series (pure). Unknown families and
 * config/family mismatches yield no violations (defensive, never a throw);
 * orchestration, isolation and failure recording live in engine.ts.
 */
export function evaluate(series: QcSeries, rule: QcRuleVersion): readonly QcViolation[] {
  const { config } = rule;
  let out: QcViolation[];
  switch (rule.family) {
    case 'range':
      out = config.family === 'range' ? evaluateRange(series, rule, config) : [];
      break;
    case 'rate-of-change':
      out = config.family === 'rate-of-change' ? evaluateRateOfChange(series, rule, config) : [];
      break;
    case 'persistence':
      out = config.family === 'persistence' ? evaluatePersistence(series, rule, config) : [];
      break;
    case 'missing-data':
      out = config.family === 'missing-data' ? evaluateMissingData(series, rule, config) : [];
      break;
    case 'zero-value':
      out = config.family === 'zero-value' ? evaluateZeroValue(series, rule, config) : [];
      break;
    default:
      out = [];
  }
  return sortedViolations(out);
}

/** Dedupe helper shared with the digest builder (same key = same violation). */
export function violationDedupeKey(v: QcViolation): string {
  return `${v.ruleId}|v${v.ruleVersion}|${v.streamId}|${v.interval.start}`;
}

// ---------------------------------------------------------------------------
// Reviewed default configs (the five FR-015 families, fixture-calibrated)
// ---------------------------------------------------------------------------

/**
 * The five reviewed rule CONFIGS. Bounds mirror the contract fixtures
 * (fixtures/contracts/stations.json validRange values): discharge 0-1200 cfs,
 * stage 0-15 ft, and the VOLTAGE bounds 11.5-15 V of the internal diagnostic
 * stream. The rate threshold (5 cfs/interval) sits far above the fixture's
 * normal hourly jitter (~0.3 cfs) and far below the spike edges. The golden
 * outcomes of these configs are hand-derived in expected.ts.
 */
export const DEFAULT_RULE_CONFIGS: Readonly<Record<QcRuleFamily, QcRuleConfig>> = Object.freeze({
  range: Object.freeze({
    family: 'range',
    bounds: Object.freeze({
      discharge: Object.freeze({ min: 0, max: 1200 }),
      stage: Object.freeze({ min: 0, max: 15 }),
      voltage: Object.freeze({ min: 11.5, max: 15 }),
    }),
  }),
  'rate-of-change': Object.freeze({
    family: 'rate-of-change',
    maxDeltaPerInterval: Object.freeze({ discharge: 5, stage: 0.5, voltage: 0.5 }),
  }),
  persistence: Object.freeze({ family: 'persistence', minConsecutive: 4 }),
  'missing-data': Object.freeze({ family: 'missing-data', gapFactor: 1.5 }),
  'zero-value': Object.freeze({ family: 'zero-value', maxCadenceMinutes: 1440 }),
});

export const DEFAULT_RULE_IDS: Readonly<Record<QcRuleFamily, string>> = Object.freeze({
  range: 'qc-range',
  'rate-of-change': 'qc-rate-of-change',
  persistence: 'qc-persistence',
  'missing-data': 'qc-missing-data',
  'zero-value': 'qc-zero-value',
});

/** Author the five default rules as v1 drafts (caller supplies identity + clock). */
export function defaultRuleDrafts(author: string, at: string): readonly QcRuleVersion[] {
  return RULE_FAMILIES.map((family) => ({
    ruleId: DEFAULT_RULE_IDS[family],
    family,
    version: 1,
    status: 'draft' as const,
    author,
    createdAt: at,
    updatedAt: at,
    config: DEFAULT_RULE_CONFIGS[family],
    notes: 'Reviewed default configuration (expected.ts golden, reviewed-pending-owner-approval).',
  }));
}

/** Build a QcSeries view of contract observations for one datastream. */
export function seriesFromObservations(
  stream: { readonly id: string; readonly observedPropertyId: string; readonly unitId: string; readonly cadenceMinutes: number },
  observations: ReadonlyArray<{ readonly streamId: string; readonly id: string; readonly observedAt: string; readonly value: number | null }>,
): QcSeries {
  return {
    streamId: stream.id,
    observedPropertyId: stream.observedPropertyId,
    unitId: stream.unitId,
    cadenceMinutes: stream.cadenceMinutes,
    points: observations
      .filter((observation) => observation.streamId === stream.id)
      .map((observation) => ({ observationId: observation.id, observedAt: observation.observedAt, value: observation.value })),
  };
}
