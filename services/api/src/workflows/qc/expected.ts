/**
 * REVIEWED EXPECTED QC OUTCOMES on the contract fixture series (WD-013;
 * FR-015) - the QC equivalent of the WD-008 goldens.
 *
 * Status: **reviewed-pending-owner-approval**. Every violation below was
 * HAND-DERIVED from fixtures/contracts/observations.json and the stream
 * metadata in fixtures/contracts/stations.json (cadence, validRange,
 * visibility), independently of rules.ts; expected.test.ts asserts that
 * evaluate() reproduces exactly this set - no more, no less. An owner review
 * that disagrees with an entry changes THIS FILE (and its evidence note),
 * never the evaluator.
 *
 * Fixture series covered (all five streams that carry observations):
 * - str-corinne-q      discharge, cfs,  60-minute cadence, public  (54 points)
 * - str-corinne-stage  stage,     ft,   60-minute cadence, public  (4 points)
 * - str-hyrum-q-public discharge, cfs,  10080-minute cadence, public (4 points)
 * - str-hyrum-q-owner  discharge, cfs,  10080-minute cadence, restricted (2)
 * - str-diag-voltage   voltage,   V,    60-minute cadence, internal (5)
 *
 * Hand-derived totals per family (default configs, DEFAULT_RULE_CONFIGS):
 * - range         3 violations (negative -1.2, spike 9500, voltage 11.1 low)
 * - rate-of-change 6 violations (both edges of the zero, negative and spike)
 * - persistence   0 violations (the fixture has NO stuck window - documented
 *                 below with the deterministic synthesized stuck case)
 * - missing-data 10 violations (3 telemetry gaps, 3 stage gaps, 4 voltage gaps)
 * - zero-value    1 violation  (the isolated freeze zero obs-q-021)
 *
 * The fixture persistence outcome is deliberately zero: no fixture stream
 * contains consecutive exactly-equal readings, so the stuck-sensor family is
 * pinned by the synthesized STUCK_SENSOR_CASE (a deterministic 5-reading
 * flatline) rather than by fixture bytes.
 */

export const EXPECTED_REVIEW_STATUS = 'reviewed-pending-owner-approval';

export interface ExpectedViolation {
  readonly streamId: string;
  readonly interval: { readonly start: string; readonly end: string };
  readonly observed: string;
  readonly rationale: string;
  /** Hand-derivation evidence: which fixture rows (and arithmetic) produced this entry. */
  readonly evidence: string;
}

// ---------------------------------------------------------------------------
// range (qc-range v1: discharge 0-1200 cfs, stage 0-15 ft, voltage 11.5-15 V)
// ---------------------------------------------------------------------------

export const EXPECTED_RANGE: readonly ExpectedViolation[] = [
  {
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-08T02:00:00Z', end: '2026-03-08T03:00:00Z' },
    observed: '-1.2 cfs',
    rationale: 'value -1.2 cfs is below the rule minimum 0 cfs for property discharge (rule qc-range v1)',
    evidence: 'obs-q-032 = -1.2 cfs (negative spike under icing, validRangeMin 0): a below-minimum reading, not a missing one.',
  },
  {
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-08T20:00:00Z', end: '2026-03-08T21:00:00Z' },
    observed: '9500 cfs',
    rationale: 'value 9500 cfs is above the rule maximum 1200 cfs for property discharge (rule qc-range v1)',
    evidence: 'obs-q-044 = 9500 cfs, far above validRangeMax 1200 (the fixture out-of-range spike; labelled, never clipped).',
  },
  {
    streamId: 'str-diag-voltage',
    interval: { start: '2026-03-09T06:00:00Z', end: '2026-03-09T07:00:00Z' },
    observed: '11.1 V',
    rationale: 'value 11.1 V is below the rule minimum 11.5 V for property voltage (rule qc-range v1)',
    evidence: 'obs-v-005 = 11.1 V on the internal diagnostic stream, below validRangeMin 11.5 V (FR-015 explicitly includes voltage bounds).',
  },
];

// ---------------------------------------------------------------------------
// rate-of-change (qc-rate-of-change v1: max 5 cfs / 0.5 ft / 0.5 V per
// cadence interval, normalized over elapsed intervals; duplicate timestamps
// and null frames skipped)
// ---------------------------------------------------------------------------

export const EXPECTED_RATE_OF_CHANGE: readonly ExpectedViolation[] = [
  {
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-07T15:00:00Z', end: '2026-03-07T16:00:00Z' },
    observed: 'delta -19.5 cfs over 2 intervals',
    rationale: 'rate of change 9.75 cfs/interval exceeds the rule maximum 5 cfs/interval for property discharge (rule qc-rate-of-change v1)',
    evidence: 'obs-q-020 (13:00, 19.5) -> obs-q-021 (15:00, 0): delta -19.5 over 2 hourly intervals (14:00 absent) = 9.75/interval; the drop INTO the suspect zero.',
  },
  {
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-07T16:00:00Z', end: '2026-03-07T17:00:00Z' },
    observed: 'delta 19.6 cfs over 1 interval',
    rationale: 'rate of change 19.6 cfs/interval exceeds the rule maximum 5 cfs/interval for property discharge (rule qc-rate-of-change v1)',
    evidence: 'obs-q-021 (15:00, 0) -> obs-q-022 (16:00, 19.6): recovery out of the suspect zero.',
  },
  {
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-08T02:00:00Z', end: '2026-03-08T03:00:00Z' },
    observed: 'delta -22 cfs over 1 interval',
    rationale: 'rate of change 22 cfs/interval exceeds the rule maximum 5 cfs/interval for property discharge (rule qc-rate-of-change v1)',
    evidence: 'obs-q-031 (01:00, 20.8) -> obs-q-032 (02:00, -1.2): delta -22.0 into the negative spike.',
  },
  {
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-08T03:00:00Z', end: '2026-03-08T04:00:00Z' },
    observed: 'delta 22.2 cfs over 1 interval',
    rationale: 'rate of change 22.2 cfs/interval exceeds the rule maximum 5 cfs/interval for property discharge (rule qc-rate-of-change v1)',
    evidence: 'obs-q-032 (02:00, -1.2) -> obs-q-033 (03:00, 21.0): delta +22.2 out of the negative spike.',
  },
  {
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-08T20:00:00Z', end: '2026-03-08T21:00:00Z' },
    observed: 'delta 9476.2 cfs over 1 interval',
    rationale: 'rate of change 9476.2 cfs/interval exceeds the rule maximum 5 cfs/interval for property discharge (rule qc-rate-of-change v1)',
    evidence: 'obs-q-043 (19:00, 23.8) -> obs-q-044 (20:00, 9500): the spike ALSO trips rate-of-change, not just range.',
  },
  {
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-08T21:00:00Z', end: '2026-03-08T22:00:00Z' },
    observed: 'delta -9475.8 cfs over 1 interval',
    rationale: 'rate of change 9475.8 cfs/interval exceeds the rule maximum 5 cfs/interval for property discharge (rule qc-rate-of-change v1)',
    evidence: 'obs-q-044 (20:00, 9500) -> obs-q-045 (21:00, 24.2): the falling edge of the spike.',
  },
];

// ---------------------------------------------------------------------------
// missing-data (qc-missing-data v1: gapFactor 1.5 x the stream cadence;
// duplicate timestamps collapse to one instant)
// ---------------------------------------------------------------------------

export const EXPECTED_MISSING_DATA: readonly ExpectedViolation[] = [
  {
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-07T06:00:00Z', end: '2026-03-07T07:00:00Z' },
    observed: '1 missing reading',
    rationale: 'no reading for 120 minutes (1 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)',
    evidence: 'obs-q-012 (05:00) -> obs-q-013 (07:00): the 06:00Z reading never arrived (irregular interval, fixture note on obs-q-013).',
  },
  {
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-07T14:00:00Z', end: '2026-03-07T15:00:00Z' },
    observed: '1 missing reading',
    rationale: 'no reading for 120 minutes (1 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)',
    evidence: 'obs-q-020 (13:00) -> obs-q-021 (15:00): the 14:00Z irregular-interval absence.',
  },
  {
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-08T12:00:00Z', end: '2026-03-08T18:00:00Z' },
    observed: '6 missing readings',
    rationale: 'no reading for 420 minutes (6 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)',
    evidence: 'obs-q-041 (11:00) -> obs-q-042 (18:00): the EXACT declared outage gap-corinne-20260308 [12:00, 18:00), missingCount 6, reason source-outage. Missing readings stay missing (never back-filled, never zeros).',
  },
  {
    streamId: 'str-corinne-stage',
    interval: { start: '2026-03-07T13:00:00Z', end: '2026-03-08T00:00:00Z' },
    observed: '11 missing readings',
    rationale: 'no reading for 720 minutes (11 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)',
    evidence: 'obs-stage-001 (03-07 12:00) -> obs-stage-002 (03-08 00:00): the stage stream declares 60-minute cadence but is sampled every 12 hours - a genuine coverage gap the family must surface.',
  },
  {
    streamId: 'str-corinne-stage',
    interval: { start: '2026-03-08T01:00:00Z', end: '2026-03-08T20:00:00Z' },
    observed: '19 missing readings',
    rationale: 'no reading for 1200 minutes (19 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)',
    evidence: 'obs-stage-002 (00:00) -> obs-stage-003 (20:00): 19 expected hourly stage readings absent.',
  },
  {
    streamId: 'str-corinne-stage',
    interval: { start: '2026-03-08T21:00:00Z', end: '2026-03-09T06:00:00Z' },
    observed: '9 missing readings',
    rationale: 'no reading for 600 minutes (9 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)',
    evidence: 'obs-stage-003 (20:00) -> obs-stage-004 (03-09 06:00).',
  },
  {
    streamId: 'str-diag-voltage',
    interval: { start: '2026-03-07T13:00:00Z', end: '2026-03-08T00:00:00Z' },
    observed: '11 missing readings',
    rationale: 'no reading for 720 minutes (11 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)',
    evidence: 'obs-v-001 (12:00) -> obs-v-002 (00:00): the internal voltage stream is sampled every 12 h against a 60-minute declared cadence.',
  },
  {
    streamId: 'str-diag-voltage',
    interval: { start: '2026-03-08T01:00:00Z', end: '2026-03-08T12:00:00Z' },
    observed: '11 missing readings',
    rationale: 'no reading for 720 minutes (11 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)',
    evidence: 'obs-v-002 (00:00) -> obs-v-003 (12:00).',
  },
  {
    streamId: 'str-diag-voltage',
    interval: { start: '2026-03-08T13:00:00Z', end: '2026-03-09T00:00:00Z' },
    observed: '11 missing readings',
    rationale: 'no reading for 720 minutes (11 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)',
    evidence: 'obs-v-003 (12:00) -> obs-v-004 (03-09 00:00).',
  },
  {
    streamId: 'str-diag-voltage',
    interval: { start: '2026-03-09T01:00:00Z', end: '2026-03-09T06:00:00Z' },
    observed: '5 missing readings',
    rationale: 'no reading for 360 minutes (5 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)',
    evidence: 'obs-v-004 (00:00) -> obs-v-005 (06:00), the final voltage reading before the fixed clock 2026-03-09T07:00:00Z.',
  },
];

// ---------------------------------------------------------------------------
// zero-value (qc-zero-value v1: isolated exact zero, cadence <= 1440 min)
// ---------------------------------------------------------------------------

export const EXPECTED_ZERO_VALUE: readonly ExpectedViolation[] = [
  {
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-07T15:00:00Z', end: '2026-03-07T16:00:00Z' },
    observed: 'exact 0 cfs',
    rationale:
      'isolated exact zero between non-zero readings (previous 19.5, next 19.6) on a 60-minute cadence stream where readings are expected: a suspect flat zero, not a measured zero (rule qc-zero-value v1)',
    evidence:
      'obs-q-021 = 0 cfs (fixture note: "Flatline at exactly zero during freeze: a suspect zero, not a measured zero"). The null frame obs-q-010 is NOT a zero and the weekly manual streams may legitimately measure a dry zero, so neither trips this family.',
  },
];

// ---------------------------------------------------------------------------
// persistence (qc-persistence v1: minConsecutive 4 exactly-equal readings)
// ---------------------------------------------------------------------------

/**
 * The fixture outcome for persistence is EMPTY: none of the five series
 * contains even two consecutive exactly-equal readings (verified by the
 * expected.test.ts assertion against every fixture stream). The family is
 * therefore pinned by this DETERMINISTIC SYNTHESIZED stuck window: five
 * identical 21.0 cfs hourly readings followed by a real change.
 */
export const STUCK_SENSOR_CASE = {
  series: {
    streamId: 'str-synth-stuck',
    observedPropertyId: 'discharge',
    unitId: 'cfs',
    cadenceMinutes: 60,
    points: [
      { observationId: 'synth-stuck-001', observedAt: '2026-03-09T00:00:00Z', value: 21.0 },
      { observationId: 'synth-stuck-002', observedAt: '2026-03-09T01:00:00Z', value: 21.0 },
      { observationId: 'synth-stuck-003', observedAt: '2026-03-09T02:00:00Z', value: 21.0 },
      { observationId: 'synth-stuck-004', observedAt: '2026-03-09T03:00:00Z', value: 21.0 },
      { observationId: 'synth-stuck-005', observedAt: '2026-03-09T04:00:00Z', value: 21.0 },
      { observationId: 'synth-stuck-006', observedAt: '2026-03-09T05:00:00Z', value: 21.2 },
    ],
  },
  expected: {
    streamId: 'str-synth-stuck',
    interval: { start: '2026-03-09T00:00:00Z', end: '2026-03-09T05:00:00Z' },
    observed: '5 identical readings of 21 cfs',
    rationale:
      'value stayed exactly 21 cfs for 5 consecutive readings, at or above the rule minimum 4: consistent with a stuck sensor (rule qc-persistence v1)',
    evidence: 'Synthesized deterministic flatline: 5 hourly readings pinned at exactly 21.0 cfs (>= minConsecutive 4) before the sensor moves to 21.2.',
  },
} as const;

/** Golden per family (persistence fixture outcome: empty, see STUCK_SENSOR_CASE). */
export const EXPECTED_BY_FAMILY: Readonly<Record<string, readonly ExpectedViolation[]>> = Object.freeze({
  range: EXPECTED_RANGE,
  'rate-of-change': EXPECTED_RATE_OF_CHANGE,
  persistence: [],
  'missing-data': EXPECTED_MISSING_DATA,
  'zero-value': EXPECTED_ZERO_VALUE,
});
