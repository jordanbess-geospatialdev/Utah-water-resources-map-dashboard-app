/**
 * Derivation tests for the WD-018 public overview view model (FR-058,
 * FR-059, FR-061, FR-062; T-10/T-11).
 *
 * Run (zero dependencies, same runner as apps/web/tests):
 *   cd apps/web && node --test --experimental-strip-types src/features/overview/derivation.test.ts
 *
 * Two layers of protection:
 * 1. The hand-derived fixture goldens (telemetry 2/4 with the inactive and
 *    proposed exclusions; reviewed 1/68; measured 66/68, estimated 1/68,
 *    unknown 1/68; natural-channel raw volume = the WD-008 weekly golden
 *    10 039/121 acre-feet) pin the same numbers asserted by
 *    services/api/src/summaries/test/*.
 * 2. The view model is compared FIELD FOR FIELD against the authoritative
 *    services domain, imported here through computed specifiers: the public
 *    overview must show exactly the services numbers, never a parallel
 *    calculation that can drift.
 *
 * (Import pattern per apps/web/tests/adapters.test.ts: computed specifiers
 * for node --test --experimental-strip-types, type-only imports for tsc.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { MeasuredVersusEstimatedIndicator, SourceClassification, SummaryWorldInput } from './derivation';

// Extensionless src imports under node --test (see tests/ts-resolve-hook.mjs).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const derivationPath = './derivation.ts';
const d: typeof import('./derivation') = await import(derivationPath);
const fixturesPath = '../../shell/data/fixtures.ts';
const fixtures: typeof import('../../shell/data/fixtures') = await import(fixturesPath);

// The authoritative services domain (cross-surface equality target). Typed
// STRUCTURALLY (not via `typeof import`) so tsc does not pull the services
// sources - compiled under their own runner - into the web program; the
// runtime modules are the real implementations read-only.
interface ServicesIndicatorSet {
  readonly telemetry: unknown;
  readonly reviewed: unknown;
  readonly measuredVersusEstimated: unknown;
}
interface ServicesOverview {
  readonly statewide: ServicesIndicatorSet;
  readonly systems: readonly { readonly systemId: string; readonly indicators: ServicesIndicatorSet }[];
}
// Computed specifiers (adapters.test.ts pattern): tsc must not follow the
// services sources into the web program - the runtime modules are the real
// implementations, imported read-only for the equality assertions below.
const servicesIndicatorsPath = '../../../../../services/api/src/summaries/indicators.ts';
const servicesWorldPath = '../../../../../services/api/src/summaries/world.ts';
const servicesTotalsPath = '../../../../../services/api/src/summaries/totals.ts';
const servicesSeriesStorePath = '../../../../../services/api/src/series/load.ts';
const servicesGoldenPath = '../../../../../services/api/src/series/golden.ts';
const servicesIndicators = (await import(servicesIndicatorsPath)) as {
  statewideOverview: (world: unknown) => ServicesOverview;
};
const servicesWorld = (await import(servicesWorldPath)).summaryWorld() as unknown;
const servicesTotals = (await import(servicesTotalsPath)) as {
  areaTotals: (store: unknown, world: unknown, request: unknown) => { outcome: 'allowed'; value: unknown } | { outcome: 'denied' };
};
const servicesStore = (await import(servicesSeriesStorePath)).seriesStore() as unknown;
const servicesGolden = (await import(servicesGoldenPath)) as {
  closeRelative: (actual: number, expected: number) => boolean;
  CORINNE: { readonly weekly: { readonly rawVolumeAcreFeet: number } };
};

const world: SummaryWorldInput = {
  asOf: fixtures.FIXTURE_CLOCK,
  stations: fixtures.stations,
  systems: fixtures.systems,
  observations: fixtures.observations,
  revisions: fixtures.revisions,
};

const GOLDEN_WINDOW = { start: '2026-03-06T07:00:00.000Z', end: '2026-03-09T06:00:00.000Z' };

function close(actual: number, expected: number, message: string): void {
  assert.ok(servicesGolden.closeRelative(actual, expected), `${message}: ${actual} vs ${expected}`);
}

test('golden: telemetry coverage 2 of 4 active stations with inactive/proposed exclusions (FR-058)', () => {
  const indicator = d.telemetryCoverageIndicator(world);
  assert.equal(indicator.numerator, 2);
  assert.equal(indicator.denominator, 4);
  assert.equal(indicator.fraction, 0.5);
  assert.equal(indicator.asOf, '2026-03-09T07:00:00Z', 'asOf is the fixture fixed clock, never the wall clock');
  assert.equal(indicator.period.start, '2026-03-08T07:00:00.000Z');
  // DEFECT-Q1 fix: anonymous class counts only — no station identifiers.
  assert.deepEqual(
    indicator.exclusions.filter((exclusion) => exclusion.count > 0).map((exclusion) => [exclusion.reason, exclusion.count]),
    [
      ['inactive stations excluded', 1],
      ['proposed stations excluded', 1],
    ],
  );
});

test('golden: reviewed coverage 1 of 68; measured-vs-estimated 66/1/1 of 68 with a distinct unknown bucket (FR-059)', () => {
  const reviewed = d.reviewedDataCoverageIndicator(world);
  assert.equal(reviewed.numerator, 1);
  assert.equal(reviewed.denominator, 68);
  close(reviewed.fraction!, 1 / 68, 'reviewed fraction');

  const mve = d.measuredVersusEstimatedIndicator(world);
  const byClassification = new Map(mve.buckets.map((bucket) => [bucket.classification, bucket]));
  assert.equal(byClassification.get('measured')!.numerator, 66);
  assert.equal(byClassification.get('estimated')!.numerator, 1);
  assert.equal(byClassification.get('unknown')!.numerator, 1);
  close(byClassification.get('measured')!.fraction!, 33 / 34, '66/68 = 33/34');
  assert.equal(mve.buckets.reduce((sum, bucket) => sum + bucket.numerator, 0), mve.denominator, 'buckets partition the denominator');
});

test('unknown bucket never folds into measured or estimated (null frames, ungoverned value types)', () => {
  const records = d.normalizeRecords(fixtures.observations, fixtures.revisions, 'best-available', Date.parse('2026-02-23T17:00:00Z'), Date.parse('2026-03-09T07:00:00Z'));
  const nullFrame = records.find((record) => record.observationId === 'obs-q-010');
  assert.ok(nullFrame);
  assert.equal(nullFrame.value, null);
  assert.equal(d.classifyRecord(nullFrame), 'unknown');

  const synthetic = d.normalizeRecords(
    [
      { id: 'a', streamId: 'str-corinne-q', observedAt: '2026-03-09T06:30:00Z', receivedAt: '2026-03-09T06:30:00Z', sourceEventId: 'e-a', value: 5, valueType: 'computed' },
      { id: 'b', streamId: 'str-corinne-q', observedAt: '2026-03-09T06:40:00Z', receivedAt: '2026-03-09T06:40:00Z', sourceEventId: 'e-b', value: null, valueType: 'observed' },
    ],
    [],
    'raw',
    Date.parse('2026-03-09T06:00:00Z'),
    Date.parse('2026-03-09T07:00:00Z'),
  );
  assert.deepEqual(synthetic.map(d.classifyRecord), ['unknown', 'unknown']);
});

test('cross-surface equality: the view model IS the services indicator set, field for field', () => {
  const web = d.statewideOverview(world);
  const services = servicesIndicators.statewideOverview(servicesWorld);
  assert.deepEqual(web.statewide.telemetry, services.statewide.telemetry);
  assert.deepEqual(web.statewide.reviewed, services.statewide.reviewed);
  assert.deepEqual(web.statewide.measuredVersusEstimated, services.statewide.measuredVersusEstimated);
  for (const entry of web.systems) {
    const match = services.systems.find((candidate) => candidate.systemId === entry.systemId);
    assert.ok(match, entry.systemId);
    assert.deepEqual(entry.indicators.telemetry, match.indicators.telemetry);
    assert.deepEqual(entry.indicators.reviewed, match.indicators.reviewed);
    assert.deepEqual(entry.indicators.measuredVersusEstimated, match.indicators.measuredVersusEstimated);
  }
});

test('cross-surface equality: area totals match the services totals exactly (volumes, coverage, categories, exclusions)', () => {
  for (const basis of ['raw', 'best-available'] as const) {
    for (const visibility of ['public', 'all'] as const) {
      const web = d.areaTotals(world, { area: 'statewide', start: GOLDEN_WINDOW.start, end: GOLDEN_WINDOW.end, basis, visibility });
      const services = servicesTotals.areaTotals(servicesStore, servicesWorld, {
        area: 'statewide',
        start: GOLDEN_WINDOW.start,
        end: GOLDEN_WINDOW.end,
        basis,
        visibility,
      });
      assert.equal(services.outcome, 'allowed');
      assert.equal(web.outcome, 'allowed');
      if (web.outcome !== 'allowed' || services.outcome !== 'allowed') throw new Error('unreachable');
      assert.deepEqual(web.value, services.value, `${basis}/${visibility} totals must be identical to the services domain`);
    }
  }
});

test('golden: natural-channel raw volume equals the WD-008 weekly golden; daily values reconcile', () => {
  const result = d.areaTotals(world, { area: 'statewide', start: GOLDEN_WINDOW.start, end: GOLDEN_WINDOW.end, basis: 'raw' });
  assert.equal(result.outcome, 'allowed');
  if (result.outcome !== 'allowed') throw new Error('unreachable');
  const natural = result.value.categories.find((category) => category.category === 'natural-channel-flow');
  assert.ok(natural);
  close(natural.volumeAcreFeet, servicesGolden.CORINNE.weekly.rawVolumeAcreFeet, 'natural-channel raw volume');
  assert.equal(natural.coveredSeconds, 176_400);
  assert.equal(natural.durationSeconds, 255_600);
  const mar8 = natural.daily.find((day) => day.key === '2026-03-08');
  assert.ok(mar8);
  close(mar8.volumeAcreFeet!, 3812 / 121, 'DST-day volume golden');
  close(mar8.coverageFraction, 16 / 23, 'DST-day coverage 16/23');
  assert.equal(result.value.combinedVolumeAcreFeet, null, 'no cross-category total is fabricated');
});

test('the adjacent same-named Hyrum stations never share an accounting category (no double count)', () => {
  const result = d.areaTotals(world, { area: 'statewide', start: GOLDEN_WINDOW.start, end: GOLDEN_WINDOW.end, basis: 'raw', visibility: 'all' });
  assert.equal(result.outcome, 'allowed');
  if (result.outcome !== 'allowed') throw new Error('unreachable');
  const canal = result.value.streams.find((stream) => stream.streamId === 'str-hyrum-q-public');
  const owner = result.value.streams.find((stream) => stream.streamId === 'str-hyrum-q-owner');
  assert.ok(canal && owner);
  assert.equal(canal.stationDisplayName, owner.stationDisplayName, 'the fixture deliberately shares this display name');
  assert.notEqual(canal.category, owner.category, 'governed categories keep the same water out of one total');
  assert.ok(result.value.noDoubleCountPolicy.includes('never summed across categories'));
});

test('period boundaries are half-open; per-system Weber set has zero denominators (null fractions)', () => {
  const boundary = d.measuredVersusEstimatedIndicator(world, { start: '2026-03-08T07:00:00Z', end: '2026-03-09T06:00:00Z' });
  assert.equal(boundary.denominator, 22);
  const shifted = d.measuredVersusEstimatedIndicator(world, { start: '2026-03-08T07:00:00Z', end: '2026-03-09T06:00:00.001Z' });
  assert.equal(shifted.denominator, 25);

  const weber = d.summaryIndicators(world, { systemId: 'sys-weber-river' });
  assert.equal(weber.telemetry.denominator, 0);
  assert.equal(weber.telemetry.fraction, null);
  for (const bucket of weber.measuredVersusEstimated.buckets) assert.equal(bucket.fraction, null);
});

test('plain-language statewide lead states the exact indicator numbers (FR-058 intelligible overview)', () => {
  const text = d.plainLanguageSummary(d.summaryIndicators(world));
  assert.ok(text.startsWith('Statewide: 2 of 4 active measurement stations'), text);
  assert.ok(text.includes('1 of 68 reported readings'));
  assert.ok(text.includes('66 of 68 readings are direct measurements, 1 estimated and 1 unknown'));
  assert.ok(text.includes('Data as of 2026-03-09T07:00:00Z'));
});

test('chart view models carry the same values as their indicators and totals (FR-062 table parity)', () => {
  const mve = d.measuredVersusEstimatedIndicator(world);
  const bars = d.classificationBars(mve);
  assert.deepEqual(
    bars.map((bar) => [bar.classification as SourceClassification, bar.value, bar.shape]),
    [
      ['measured', 66, '●'],
      ['estimated', 1, '≈'],
      ['unknown', 1, '?'],
    ],
  );
  for (const bar of bars) {
    assert.ok(bar.ariaLabel.includes(`${bar.value} of ${bar.denominator}`), 'the accessible label carries numerator and denominator');
    assert.ok(bar.ariaLabel.includes('as of'));
  }

  const result = d.areaTotals(world, { area: 'statewide', start: GOLDEN_WINDOW.start, end: GOLDEN_WINDOW.end, basis: 'raw' });
  if (result.outcome !== 'allowed') throw new Error('unreachable');
  const series = d.volumeSeries(result.value);
  assert.equal(series.unit, 'acre-feet');
  assert.deepEqual(
    series.points.map((point) => point.day),
    ['2026-03-06', '2026-03-07', '2026-03-08'],
  );
  const mar8Natural = series.points[2]!.values.find((value) => value.category === 'natural-channel-flow');
  assert.ok(mar8Natural);
  close(mar8Natural.volumeAcreFeet!, 3812 / 121, 'chart model volume matches the golden');
  assert.ok(mar8Natural.ariaLabel.includes('acre-feet'));
});

test('determinism: deriving the overview and totals twice yields identical results', () => {
  const first = JSON.stringify({
    overview: d.statewideOverview(world),
    totals: d.areaTotals(world, { area: 'statewide', start: GOLDEN_WINDOW.start, end: GOLDEN_WINDOW.end, basis: 'best-available', visibility: 'all' }),
  });
  const second = JSON.stringify({
    overview: d.statewideOverview(world),
    totals: d.areaTotals(world, { area: 'statewide', start: GOLDEN_WINDOW.start, end: GOLDEN_WINDOW.end, basis: 'best-available', visibility: 'all' }),
  });
  assert.equal(first, second);
});

// ---------------------------------------------------------------------------
// DEFECT-Q1/Q2 fix: no restricted/internal identifier reaches the rendered
// public model (view model + totals), and the headline fractions are unchanged
// ---------------------------------------------------------------------------

/**
 * Restricted/internal fixture objects. The owner Hyrum station's display name
 * is deliberately NOT here: the fixture shares it with the adjacent PUBLIC
 * station (the no-double-count trap), so the name itself is a public object.
 */
const RESTRICTED_IDENTIFIERS = [
  'sta-hyrum-diversion-owner',
  'str-hyrum-q-owner',
  'sta-bear-lake-diagnostic',
  'str-diag-voltage',
  'sta-ogden-valley-proposed',
  'str-ogden-q-proposed',
  'Garden City Diagnostic Site',
  'Ogden Valley Upper Proposed Gauge',
];

test('DEFECT-Q1/Q2 fix: no restricted identifier reaches the rendered public model', () => {
  const surfaces: readonly (readonly [string, unknown])[] = [
    ['overview', d.statewideOverview(world)],
    ['totals-default-public', d.areaTotals(world, { area: 'statewide', start: GOLDEN_WINDOW.start, end: GOLDEN_WINDOW.end, basis: 'best-available' })],
    ['totals-explicit-public', d.areaTotals(world, { area: 'statewide', start: GOLDEN_WINDOW.start, end: GOLDEN_WINDOW.end, basis: 'raw', visibility: 'public' })],
    ['totals-weber', d.areaTotals(world, { area: { systemId: 'sys-weber-river' }, start: GOLDEN_WINDOW.start, end: GOLDEN_WINDOW.end, basis: 'raw' })],
  ];
  for (const [label, model] of surfaces) {
    const serialized = JSON.stringify(model);
    for (const identifier of RESTRICTED_IDENTIFIERS) {
      assert.ok(!serialized.includes(identifier), `${label} names restricted object ${identifier}`);
    }
  }
  // The indicator exclusions carry no identifier lists at all (structural).
  assert.ok(!JSON.stringify(d.statewideOverview(world)).includes('"ids"'));
  // The restricted streams appear only as anonymous class counts (never identified).
  const publicTotals = d.areaTotals(world, { area: 'statewide', start: GOLDEN_WINDOW.start, end: GOLDEN_WINDOW.end, basis: 'raw' });
  if (publicTotals.outcome !== 'allowed') throw new Error('unreachable');
  assert.equal(publicTotals.value.streams.length, 4, 'only the 4 public streams are itemized');
  assert.deepEqual(publicTotals.value.omittedStreams, [
    { reason: 'station not in the public projection (internal)', count: 1 },
    { reason: 'station not in the public projection (restricted)', count: 2 },
  ]);
});

test('DEFECT-Q1/Q2 fix leaves the headline rendered fractions unchanged: 2/4, 1/68, 66/68', () => {
  const set = d.summaryIndicators(world);
  assert.equal(set.telemetry.numerator, 2);
  assert.equal(set.telemetry.denominator, 4);
  close(set.telemetry.fraction!, 2 / 4, 'telemetry fraction is exactly 2/4');
  assert.equal(set.reviewed.numerator, 1);
  assert.equal(set.reviewed.denominator, 68);
  close(set.reviewed.fraction!, 1 / 68, 'reviewed fraction is exactly 1/68');
  assert.equal(set.measuredVersusEstimated.buckets[0]!.numerator, 66);
  assert.equal(set.measuredVersusEstimated.denominator, 68);
  close(set.measuredVersusEstimated.buckets[0]!.fraction!, 66 / 68, 'measured fraction is exactly 66/68');
  // The plain-language lead still states the same headline numbers.
  const text = d.plainLanguageSummary(set);
  assert.ok(text.includes('2 of 4 active measurement stations'));
  assert.ok(text.includes('1 of 68 reported readings'));
});

test('window validation mirrors the WD-008 bounds for the overview error state', () => {
  assert.equal(d.windowDenial('2026-03-09T07:00:00Z', '2026-03-09T07:00:00Z')?.code, 'EMPTY_WINDOW');
  assert.equal(d.windowDenial('nope', '2026-03-09T07:00:00Z')?.code, 'MALFORMED_WINDOW');
  assert.equal(d.windowDenial('2025-01-01T00:00:00Z', '2026-12-31T00:00:00Z')?.code, 'REQUEST_WINDOW_TOO_LARGE');
  assert.equal(d.windowDenial(GOLDEN_WINDOW.start, GOLDEN_WINDOW.end), null);
});

test('measuredVersusEstimatedIndicator result satisfies the indicator interface (type-level smoke)', () => {
  const mve: MeasuredVersusEstimatedIndicator = d.measuredVersusEstimatedIndicator(world, { systemId: 'sys-bear-river' });
  assert.equal(mve.id, 'measured-vs-estimated');
  assert.equal(mve.measureKind, 'output');
  assert.equal(mve.buckets.length, 3);
});
