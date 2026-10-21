/**
 * Golden indicator tests for the WD-018 summaries domain (FR-058, FR-059;
 * T-10). Expected values are derived BY HAND from the published fixture world
 * (seed utah-water-fixture-v1, fixed clock 2026-03-09T07:00:00Z) following
 * the same pending-owner-approval status as the WD-008 goldens:
 *
 * STATIONS (6 total). Status rules: only ACTIVE stations join a denominator.
 *   active (4): sta-bear-corinne (telemetered), sta-hyrum-diversion-public
 *     (manual), sta-hyrum-diversion-owner (manual, restricted),
 *     sta-bear-lake-diagnostic (telemetered, internal)
 *   inactive (1): sta-summit-creek-inactive - excluded
 *   proposed (1): sta-ogden-valley-proposed - excluded
 *
 * TELEMETRY COVERAGE, freshness 24 h before asOf = [2026-03-08T07:00Z,
 * 2026-03-09T07:00Z): numerator 2 (Corinne latest reading 2026-03-09T06:00Z,
 * diagnostic latest 2026-03-09T06:00Z; both telemetered with current data);
 * denominator 4 -> fraction 1/2. sta-hyrum-diversion-public reported current
 * data (2026-03-09T00:30Z) but is MANUAL, so it stays out of the numerator.
 *
 * REPORTED READINGS: 69 fixture observation rows; the duplicate instant
 * 2026-03-07T10:00Z normalizes to the retransmission obs-q-017, superseding
 * obs-q-016 -> 68 normalized readings, all from active stations.
 *
 * REVIEWED COVERAGE: exactly one chain reached the governed 'reviewed' level
 * (rev-corinne-2003 -> obs-q-019). obs-q-032's chain stops at best-available
 * (rev-corinne-2004), which does NOT count -> 1/68.
 *
 * MEASURED VS ESTIMATED (best-available basis, window
 * [2026-02-23T17:00Z, 2026-03-09T07:00Z)): measured 66 (observed source
 * values; the out-of-range 9500 cfs spike and the -1.2 negative stay
 * measured - classification is by source, exclusion is by range), estimated
 * 1 (obs-q-042), unknown 1 (obs-q-010 null frame) -> 66/68 = 33/34, 1/68,
 * 1/68. The unknown bucket is distinct, never folded into measured/estimated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRecord,
  measuredVersusEstimatedIndicator,
  normalizeRecords,
  reviewedDataCoverageIndicator,
  statewideOverview,
  summaryIndicators,
  telemetryCoverageIndicator,
} from '../indicators.ts';
import { summaryWorld, type SummaryStation, type SummaryWorld } from '../world.ts';
import { closeRelative } from '../../series/golden.ts';

const world = summaryWorld();

function syntheticWorld(over: { stations?: SummaryStation[]; observations?: SummaryWorld['observations'] }): SummaryWorld {
  return {
    seed: world.seed,
    asOf: world.asOf,
    stations: over.stations ?? world.stations,
    systems: world.systems,
    observations: over.observations ?? world.observations,
    revisions: over.observations === undefined ? world.revisions : [],
    gaps: world.gaps,
  };
}

function station(id: string, telemetry: string, status: string, streamIds: string[]): SummaryStation {
  return {
    id,
    displayName: id,
    systemId: 'sys-bear-river',
    status,
    visibility: 'public',
    telemetry,
    siteTypeId: 'flume',
    waterSourceTypeId: 'surface-natural-flow',
    streams: streamIds.map((streamId) => ({
      id: streamId,
      stationId: id,
      observedPropertyId: 'discharge',
      unitId: 'cfs',
      visibility: 'public' as const,
      timeZone: 'America/Denver',
    })),
  };
}

function obs(id: string, streamId: string, observedAt: string, value: number | null, valueType: string): SummaryWorld['observations'][number] {
  return {
    id,
    logicalKey: `${streamId}:${observedAt}`,
    streamId,
    observedAt,
    sourceOffset: '-07:00',
    value,
    unitId: 'cfs',
    valueType: valueType as 'observed' | 'estimated',
    processingLevel: 'raw',
    sourceEventId: `ev-${id}`,
    receivedAt: observedAt,
    sourceId: 'src-test',
  };
}

test('telemetry coverage golden: 2 of 4 active stations, inactive+proposed excluded (FR-058)', () => {
  const indicator = telemetryCoverageIndicator(world);
  assert.equal(indicator.numerator, 2);
  assert.equal(indicator.denominator, 4);
  assert.equal(indicator.fraction, 0.5);
  assert.equal(indicator.unit, 'stations');
  assert.equal(indicator.asOf, '2026-03-09T07:00:00Z', 'asOf is the fixture fixed clock, never Date.now()');
  assert.equal(indicator.period.start, '2026-03-08T07:00:00.000Z');
  assert.equal(indicator.period.end, '2026-03-09T07:00:00.000Z');
  assert.ok(indicator.period.description.includes('24 h'), 'the freshness window length is stated');
  assert.deepEqual(
    indicator.exclusions.map((exclusion) => [exclusion.reason, exclusion.count, exclusion.ids]),
    [
      ['inactive stations excluded', 1, ['sta-summit-creek-inactive']],
      ['proposed stations excluded', 1, ['sta-ogden-valley-proposed']],
      ['unknown-status stations excluded', 0, []],
    ],
  );
});

test('telemetry numerator needs telemetry AND current data (manual-but-current and telemetered-but-stale stay out)', () => {
  // sta-hyrum-diversion-public reported current data at 2026-03-09T00:30Z but
  // is manual: the statewide numerator is 2, not 3.
  assert.equal(telemetryCoverageIndicator(world).numerator, 2);

  const stale = syntheticWorld({
    stations: [station('sta-tlm-current', 'telemetered', 'active', ['str-tlm-c']), station('sta-tlm-stale', 'telemetered', 'active', ['str-tlm-s']), station('sta-manual-current', 'manual', 'active', ['str-man-c'])],
    observations: [
      obs('t1', 'str-tlm-c', '2026-03-09T06:00:00Z', 1, 'observed'),
      obs('t2', 'str-man-c', '2026-03-09T06:00:00Z', 2, 'observed'),
      obs('t3', 'str-tlm-s', '2026-03-05T06:00:00Z', 3, 'observed'), // 4 days before asOf
    ],
  });
  const indicator = telemetryCoverageIndicator(stale);
  assert.equal(indicator.numerator, 1, 'only the telemetered station with current data counts');
  assert.equal(indicator.denominator, 3);
  assert.ok(closeRelative(indicator.fraction!, 1 / 3));
});

test('telemetry per-system: Bear River 2/4; Weber River 0 active stations -> fraction null, never 0/0', () => {
  const bear = telemetryCoverageIndicator(world, { systemId: 'sys-bear-river' });
  assert.equal(bear.numerator, 2);
  assert.equal(bear.denominator, 4);
  assert.equal(bear.scope.kind, 'system');
  assert.equal(bear.scope.systemName, 'Bear River Distribution System');

  const weber = telemetryCoverageIndicator(world, { systemId: 'sys-weber-river' });
  assert.equal(weber.numerator, 0);
  assert.equal(weber.denominator, 0, 'the only Weber station is proposed');
  assert.equal(weber.fraction, null, 'a zero denominator is null, never a fabricated 0/0 fraction');
});

test('reviewed-data coverage golden: 1 of 68 readings reached the reviewed level (FR-058)', () => {
  const indicator = reviewedDataCoverageIndicator(world);
  assert.equal(indicator.numerator, 1);
  assert.equal(indicator.denominator, 68, '69 rows minus the superseded duplicate obs-q-016');
  assert.ok(closeRelative(indicator.fraction!, 1 / 68));
  assert.equal(indicator.unit, 'reported readings');
  assert.equal(indicator.period.start, '2026-02-23T17:00:00Z', 'fixture data window start');
  assert.equal(indicator.period.end, '2026-03-09T07:00:00Z');
  // obs-q-032's chain (provisional -> best-available) never reached 'reviewed'
  // and must not be counted alongside obs-q-019 (rev-corinne-2003).
  assert.notEqual(indicator.numerator, 2);
  const duplicate = indicator.exclusions.find((exclusion) => exclusion.reason.includes('duplicate-timestamp'));
  assert.ok(duplicate);
  assert.equal(duplicate.count, 1);
  assert.deepEqual(duplicate.ids, ['obs-q-016']);
});

test('measured-vs-estimated golden: 66/68 measured, 1/68 estimated, 1/68 unknown (FR-059)', () => {
  const indicator = measuredVersusEstimatedIndicator(world);
  assert.equal(indicator.basis, 'best-available');
  const [measured, estimated, unknown] = indicator.buckets;
  assert.equal(measured.classification, 'measured');
  assert.equal(measured.numerator, 66);
  assert.equal(estimated.numerator, 1);
  assert.equal(unknown.numerator, 1);
  for (const bucket of indicator.buckets) {
    assert.equal(bucket.denominator, 68);
    assert.equal(bucket.unit, 'reported readings');
    assert.equal(bucket.asOf, '2026-03-09T07:00:00Z');
    assert.ok(bucket.period.description.includes('best-available'), 'the classification basis is stated');
  }
  assert.ok(closeRelative(measured.fraction!, 33 / 34), '66/68 = 33/34');
  assert.ok(closeRelative(estimated.fraction!, 1 / 68));
  assert.ok(closeRelative(unknown.fraction!, 1 / 68));
  // Buckets partition the denominator exactly.
  assert.equal(indicator.buckets.reduce((sum, bucket) => sum + bucket.numerator, 0), indicator.denominator);
});

test('unknown bucket stays distinct: null frames and ungoverned value types are never measured or estimated', () => {
  const records = normalizeRecords(world.observations, world.revisions, 'best-available', Date.parse('2026-02-23T17:00:00Z'), Date.parse('2026-03-09T07:00:00Z'));
  const nullFrame = records.find((record) => record.observationId === 'obs-q-010');
  assert.ok(nullFrame, 'the null frame obs-q-010 is present');
  assert.equal(nullFrame.value, null);
  assert.equal(classifyRecord(nullFrame), 'unknown', 'a reported-but-empty frame is unknown, never zero or measured');

  const odd = [
    obs('odd-1', 'str-corinne-q', '2026-03-09T06:30:00Z', 5, 'computed'), // ungoverned value type
    obs('odd-2', 'str-corinne-q', '2026-03-09T06:40:00Z', 5, 'estimated'),
    obs('odd-3', 'str-corinne-q', '2026-03-09T06:50:00Z', null, 'observed'), // another null frame
  ];
  const oddRecords = normalizeRecords(odd, [], 'raw', Date.parse('2026-03-09T06:00:00Z'), Date.parse('2026-03-09T07:00:00Z'));
  const classifications = oddRecords.map(classifyRecord);
  assert.deepEqual(classifications, ['unknown', 'estimated', 'unknown']);
  const counts = { measured: 0, estimated: 0, unknown: 0 };
  for (const classification of classifications) counts[classification] += 1;
  assert.equal(counts.measured, 0, 'unclassifiable rows never fold into measured');
  assert.equal(counts.estimated, 1);
  assert.equal(counts.unknown, 2);
});

test('period boundaries are half-open [start, end): the reading at end joins only when end moves past it', () => {
  const endAtReading = measuredVersusEstimatedIndicator(world, {
    start: '2026-03-08T07:00:00Z',
    end: '2026-03-09T06:00:00Z',
  });
  // Corinne q-037..q-053 (17), stage-003 (1), hp-004 (1), ho-002 (1), v-003/v-004 (2) = 22
  assert.equal(endAtReading.denominator, 22);
  assert.equal(endAtReading.buckets[0].numerator, 21);
  assert.equal(endAtReading.buckets[1].numerator, 1, 'obs-q-042 estimated inside the window');
  assert.equal(endAtReading.buckets[2].numerator, 0);
  assert.equal(endAtReading.period.start, '2026-03-08T07:00:00Z');
  assert.equal(endAtReading.period.end, '2026-03-09T06:00:00Z');

  const endPastReading = measuredVersusEstimatedIndicator(world, {
    start: '2026-03-08T07:00:00Z',
    end: '2026-03-09T06:00:00.001Z',
  });
  // obs-q-054, obs-stage-004 and obs-v-005 sit exactly at 06:00:00Z: excluded
  // when end is 06:00:00.000Z, included one millisecond later.
  assert.equal(endPastReading.denominator, 25);
  assert.equal(endPastReading.buckets[0].numerator, 24);
});

test('raw basis reports the same fixture counts and states its basis (the only interpolate revision targets an estimated row)', () => {
  const raw = measuredVersusEstimatedIndicator(world, { basis: 'raw' });
  assert.equal(raw.basis, 'raw');
  assert.deepEqual(
    raw.buckets.map((bucket) => [bucket.classification, bucket.numerator]),
    [
      ['measured', 66],
      ['estimated', 1],
      ['unknown', 1],
    ],
  );
});

test('statewideOverview leads statewide and lists systems in stable order with zero-denominator nulls', () => {
  const overview = statewideOverview(world);
  assert.equal(overview.statewide.scope.kind, 'statewide');
  assert.deepEqual(overview.systems.map((entry) => entry.systemId), ['sys-bear-river', 'sys-weber-river']);
  const bear = overview.systems[0];
  assert.equal(bear.indicators.telemetry.numerator, 2);
  assert.equal(bear.indicators.reviewed.denominator, 68);
  const weber = overview.systems[1];
  assert.equal(weber.indicators.telemetry.fraction, null);
  assert.equal(weber.indicators.reviewed.fraction, null);
  for (const bucket of weber.indicators.measuredVersusEstimated.buckets) {
    assert.equal(bucket.denominator, 0);
    assert.equal(bucket.fraction, null);
  }
});

test('every indicator is self-describing: label, numerator, denominator, unit, period, asOf and exclusions all present (FR-058)', () => {
  const collect = (set: ReturnType<typeof summaryIndicators>) => [set.telemetry, set.reviewed, set.measuredVersusEstimated];
  const all = [...collect(summaryIndicators(world)), ...collect(summaryIndicators(world, { systemId: 'sys-weber-river' }))];
  for (const indicator of all) {
    assert.ok(indicator.label.length > 0, 'label');
    assert.ok(Number.isInteger(indicator.numerator));
    assert.ok(Number.isInteger(indicator.denominator));
    assert.ok(indicator.unit.length > 0);
    assert.ok(indicator.period.start <= indicator.period.end, 'ordered period bounds (equal only for an empty scope)');
    assert.ok(indicator.period.description.length > 0, 'the period meaning is stated');
    assert.ok(Date.parse(indicator.asOf) > 0);
    assert.ok(Array.isArray(indicator.exclusions));
    assert.ok(indicator.method.length > 0);
    assert.ok(indicator.measureKind === 'output' || indicator.measureKind === 'outcome-context');
  }
  // A non-empty scope states a real half-open window.
  const statewide = summaryIndicators(world);
  assert.ok(statewide.telemetry.period.start < statewide.telemetry.period.end);
  assert.ok(statewide.reviewed.period.start < statewide.reviewed.period.end);
  assert.ok(statewide.measuredVersusEstimated.period.start < statewide.measuredVersusEstimated.period.end);
});

test('determinism: deriving the full overview twice yields identical results', () => {
  const first = JSON.stringify(statewideOverview(world));
  const second = JSON.stringify(statewideOverview(world));
  assert.equal(first, second);
});
