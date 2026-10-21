/**
 * The reviewed expected QC outcomes on the contract fixtures (WD-013;
 * FR-015; verification rows T-06/T-15).
 *
 * Status: reviewed-pending-owner-approval (expected.ts). This suite asserts
 * that evaluate() with the five reviewed default rule versions reproduces
 * EXACTLY the hand-derived violation set per family - the golden includes
 * the ZERO-violation outcomes (persistence on every fixture stream) and the
 * deterministic synthesized stuck-sensor window, and it pins determinism:
 * every family is evaluated twice and must be byte-identical.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/qc/test/expected.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULE_CONFIGS, DEFAULT_RULE_IDS, evaluate, type QcRuleFamily, type QcRuleVersion, type QcSeries, type QcViolation } from '../rules.ts';
import { EXPECTED_BY_FAMILY, EXPECTED_REVIEW_STATUS, STUCK_SENSOR_CASE, type ExpectedViolation } from '../expected.ts';
import { NOW, fixtureSeries } from './helpers.ts';

const AUTHOR = 'principal-diego-steward';

function ruleFor(family: QcRuleFamily): QcRuleVersion {
  return {
    ruleId: DEFAULT_RULE_IDS[family],
    family,
    version: 1,
    status: 'draft',
    author: AUTHOR,
    createdAt: NOW,
    updatedAt: NOW,
    config: DEFAULT_RULE_CONFIGS[family],
    notes: null,
  };
}

/** Evaluate one family across every fixture series, aggregated deterministically. */
function evaluateFamily(family: QcRuleFamily, series: readonly QcSeries[]): readonly QcViolation[] {
  const rule = ruleFor(family);
  return series
    .flatMap((one) => [...evaluate(one, rule)])
    .sort((a, b) => (a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : a.interval.start < b.interval.start ? -1 : a.interval.start > b.interval.start ? 1 : a.observed < b.observed ? -1 : 1));
}

function actualTuple(v: QcViolation) {
  return { streamId: v.streamId, interval: v.interval, observed: v.observed, rationale: v.rationale };
}

function expectedTuple(e: ExpectedViolation) {
  return { streamId: e.streamId, interval: e.interval, observed: e.observed, rationale: e.rationale };
}

test('the golden is marked reviewed-pending-owner-approval and every entry carries hand-derivation evidence', () => {
  assert.equal(EXPECTED_REVIEW_STATUS, 'reviewed-pending-owner-approval');
  for (const [family, entries] of Object.entries(EXPECTED_BY_FAMILY)) {
    for (const entry of entries) {
      assert.ok(entry.evidence.length > 20, `${family} entry ${entry.streamId} ${entry.interval.start} lacks evidence note`);
    }
  }
});

test('range family: exactly the negative, the 9500 cfs spike and the low voltage reading (3)', () => {
  const actual = evaluateFamily('range', fixtureSeries());
  assert.deepEqual(actual.map(actualTuple), EXPECTED_BY_FAMILY.range!.map(expectedTuple));
  assert.equal(actual.length, 3);
  // The spike (obs-q-044) is 9500 cfs above validRangeMax 1200; the negative
  // (obs-q-032) is below min 0; the voltage reading (obs-v-005) is 11.1 V
  // below 11.5 V on the INTERNAL diagnostic stream (FR-015 voltage bounds).
  assert.deepEqual(
    actual.map((v) => `${v.streamId} ${v.observed}`),
    ['str-corinne-q -1.2 cfs', 'str-corinne-q 9500 cfs', 'str-diag-voltage 11.1 V'],
  );
});

test('rate-of-change family: both edges of the zero, the negative and the 9500 spike (6); the gap edge does NOT trip', () => {
  const actual = evaluateFamily('rate-of-change', fixtureSeries());
  assert.deepEqual(actual.map(actualTuple), EXPECTED_BY_FAMILY['rate-of-change']!.map(expectedTuple));
  assert.equal(actual.length, 6);
  // Normalized over elapsed intervals, the outage gap edge (22.1 -> 23.5
  // over 7 intervals = 0.2/interval) stays below the threshold; the same
  // spike trips BOTH range and rate-of-change per the acceptance criteria.
  for (const violation of actual) assert.equal(violation.streamId, 'str-corinne-q');
  assert.ok(actual.some((v) => v.interval.start === '2026-03-08T20:00:00Z' && v.observed.includes('9476.2')), 'the 9500 spike entry edge');
  assert.ok(actual.some((v) => v.interval.start === '2026-03-08T21:00:00Z' && v.observed.includes('-9475.8')), 'the 9500 spike exit edge');
});

test('persistence family: ZERO fixture violations (no stuck window exists) plus the synthesized stuck case', () => {
  const actual = evaluateFamily('persistence', fixtureSeries());
  assert.deepEqual(actual.map(actualTuple), EXPECTED_BY_FAMILY.persistence!.map(expectedTuple));
  assert.equal(actual.length, 0, 'no fixture stream contains consecutive exactly-equal readings');

  const stuck = evaluate(STUCK_SENSOR_CASE.series as QcSeries, ruleFor('persistence'));
  assert.equal(stuck.length, 1);
  assert.deepEqual(actualTuple(stuck[0]!), expectedTuple(STUCK_SENSOR_CASE.expected));
  // A run BELOW minConsecutive must not trip: 3 identical readings are legal jitter.
  const shortRun: QcSeries = {
    ...STUCK_SENSOR_CASE.series,
    points: STUCK_SENSOR_CASE.series.points.slice(0, 3),
  };
  assert.equal(evaluate(shortRun, ruleFor('persistence')).length, 0);
});

test('missing-data family: the exact declared outage interval plus the irregular, stage and voltage gaps (10)', () => {
  const actual = evaluateFamily('missing-data', fixtureSeries());
  assert.deepEqual(actual.map(actualTuple), EXPECTED_BY_FAMILY['missing-data']!.map(expectedTuple));
  assert.equal(actual.length, 10);
  // The outage gap must surface with its EXACT interval: [12:00, 18:00) with
  // 6 missing hourly readings, matching declared gap-corinne-20260308.
  const outage = actual.find((v) => v.observed === '6 missing readings');
  assert.ok(outage, 'declared outage violation present');
  assert.deepEqual(outage!.interval, { start: '2026-03-08T12:00:00Z', end: '2026-03-08T18:00:00Z' });
  // The duplicate timestamps (obs-q-016/017 at 10:00Z) are NOT a gap: the
  // telemetry stream reports exactly 3 gaps, not 4.
  assert.equal(actual.filter((v) => v.streamId === 'str-corinne-q').length, 3);
  // The weekly manual streams (hyrum public/owner) have NO missing-data
  // violations: elapsed between manual readings is under the weekly cadence.
  assert.equal(actual.filter((v) => v.streamId.startsWith('str-hyrum')).length, 0);
});

test('zero-value family: exactly the isolated freeze zero (obs-q-021); nulls and manual streams never trip', () => {
  const actual = evaluateFamily('zero-value', fixtureSeries());
  assert.deepEqual(actual.map(actualTuple), EXPECTED_BY_FAMILY['zero-value']!.map(expectedTuple));
  assert.equal(actual.length, 1);
  assert.equal(actual[0]!.streamId, 'str-corinne-q');
  assert.deepEqual(actual[0]!.interval, { start: '2026-03-07T15:00:00Z', end: '2026-03-07T16:00:00Z' });
  // The null frame (obs-q-010) is reported-but-empty, not a zero: it must
  // not appear in ANY family's violations.
  const allViolations = [...evaluateFamily('range', fixtureSeries()), ...evaluateFamily('zero-value', fixtureSeries())];
  assert.ok(allViolations.every((v) => !v.observed.startsWith('null')));
});

test('determinism: every family evaluated twice is byte-identical', () => {
  const series = fixtureSeries();
  for (const family of Object.keys(DEFAULT_RULE_CONFIGS) as QcRuleFamily[]) {
    const first = JSON.stringify(evaluateFamily(family, series));
    const second = JSON.stringify(evaluateFamily(family, series));
    assert.equal(first, second, family);
  }
});

test('input point order never changes the output (late arrival obs-q-005 arrives last and stays in place)', () => {
  const series = fixtureSeries();
  const reversed: QcSeries[] = series.map((one) => ({ ...one, points: [...one.points].reverse() }));
  for (const family of Object.keys(DEFAULT_RULE_CONFIGS) as QcRuleFamily[]) {
    assert.equal(JSON.stringify(evaluateFamily(family, series)), JSON.stringify(evaluateFamily(family, reversed)), family);
  }
});
