/**
 * Flexible-period tests (WD-025-R2; FR-030; T-06/T-15):
 * - the governed kinds resolve to the EXACT WD-025 windows (byte-identical
 *   instants and date rules);
 * - custom windows with MID-MONTH and mid-day boundaries select EXACTLY the
 *   fixture observations inside the half-open bounds (goldens);
 * - DST-spanning windows carry the real local day durations (82 800 s /
 *   90 000 s), never a flat 86 400 s;
 * - RECONCILIATION: period totals over any resolved window equal the
 *   WD-008/WD-025 aggregation over the same bounds, and over the governed
 *   bounds they equal the WD-025 report goldens (10299/121, 267947/484,
 *   26978/121).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateSeries } from '../../../series/aggregate.ts';
import { closeRelative } from '../../../series/golden.ts';
import { seriesStore } from '../../../series/load.ts';
import { generateReport, periodWindow } from '../../distribution-report/generate.ts';
import { DEFAULT_INCLUDE } from '../../distribution-report/types.ts';
import { createRevisionStore } from '../../revisions/store.ts';
import { fixturePeriodDeps, localMidnightIso, periodCategoryTotals, periodKeyOf, resolvePeriod, selectObservationsInPeriod } from '../periods.ts';
import type { PeriodSpec } from '../types.ts';

const NOW = '2026-03-09T07:00:00Z';
const CODY = 'principal-cody-commissioner';
const BEAR = 'sys-bear-river';

function resolveOrThrow(spec: PeriodSpec) {
  const result = resolvePeriod(spec);
  assert.equal(result.outcome, 'allowed');
  if (result.outcome === 'allowed') return result.value;
  throw new Error('unreachable');
}

// ---------------------------------------------------------------------------
// Governed kinds delegate to the WD-025 windows
// ---------------------------------------------------------------------------

test('governed kinds resolve to the exact WD-025 periodWindow instants and rules', () => {
  const cases: ReadonlyArray<{ spec: PeriodSpec; basis: 'calendar-year' | 'water-year' | 'irrigation-season'; year: number }> = [
    { spec: { kind: 'calendar-year', year: 2026 }, basis: 'calendar-year', year: 2026 },
    { spec: { kind: 'water-year', year: 2026 }, basis: 'water-year', year: 2026 },
    { spec: { kind: 'irrigation-season', year: 2026 }, basis: 'irrigation-season', year: 2026 },
  ];
  for (const testCase of cases) {
    const resolved = resolveOrThrow(testCase.spec);
    const window = periodWindow({ basis: testCase.basis, year: testCase.year });
    assert.equal(resolved.start, window.start, testCase.basis);
    assert.equal(resolved.end, window.end, testCase.basis);
    assert.equal(resolved.dateRule, window.dateRule, testCase.basis);
    assert.equal(resolved.timeZone, 'America/Denver');
  }
});

test('local day counts and DST facts: CY/WY span both transition days; the irrigation season spans none', () => {
  const cy = resolveOrThrow({ kind: 'calendar-year', year: 2026 });
  assert.equal(cy.localDayCount, 365);
  assert.deepEqual(
    cy.dstDayAdjustments.map((day) => [day.date, day.daySeconds]),
    [
      ['2026-03-08', 82_800],
      ['2026-11-01', 90_000],
    ],
  );

  const wy = resolveOrThrow({ kind: 'water-year', year: 2026 });
  assert.equal(wy.start, '2025-10-01T06:00:00.000Z'); // local Oct 1 midnight, MDT
  assert.equal(wy.localDayCount, 365);
  assert.equal(wy.dstDayAdjustments.length, 2);

  const irrigation = resolveOrThrow({ kind: 'irrigation-season', year: 2026 });
  assert.equal(irrigation.localDayCount, 214); // Apr 1 .. Oct 31 inclusive
  assert.equal(irrigation.dstDayAdjustments.length, 0); // neither transition day is inside
});

// ---------------------------------------------------------------------------
// Custom windows: mid-month and mid-day boundaries (FR-030)
// ---------------------------------------------------------------------------

test('localMidnightIso derives the program-zone midnights (MST vs MDT)', () => {
  assert.equal(localMidnightIso(2026, 3, 7), '2026-03-07T07:00:00.000Z'); // MST (UTC-7)
  assert.equal(localMidnightIso(2026, 3, 15), '2026-03-15T06:00:00.000Z'); // MDT (UTC-6) after spring forward
});

test('a water year starting March 15 (custom, mid-month) selects ZERO fixture observations', () => {
  const spec: PeriodSpec = {
    kind: 'custom',
    start: localMidnightIso(2026, 3, 15),
    end: localMidnightIso(2027, 3, 15),
    label: 'owner-configured water year starting March 15',
  };
  const resolved = resolveOrThrow(spec);
  assert.equal(resolved.start, '2026-03-15T06:00:00.000Z');
  assert.equal(resolved.localDayCount, 365);
  // Two DST transitions fall inside: fall-back 2026-11-01 (90 000 s) and the
  // 2027 spring-forward day (82 800 s - the exact March date is derived from
  // the zone table, never hard-coded).
  assert.equal(resolved.dstDayAdjustments.length, 2);
  assert.equal(resolved.dstDayAdjustments[0]?.date, '2026-11-01');
  assert.equal(resolved.dstDayAdjustments[0]?.daySeconds, 90_000);
  assert.equal(resolved.dstDayAdjustments[1]?.daySeconds, 82_800);
  assert.ok(resolved.dstDayAdjustments[1]?.date.startsWith('2027-03-'));
  // Every fixture observation lives on local days Mar 6-9, 2026: none inside.
  for (const streamId of ['str-corinne-q', 'str-hyrum-q-public', 'str-hyrum-q-owner']) {
    assert.deepEqual(selectObservationsInPeriod(seriesStore(), streamId, resolved), [], streamId);
  }
});

test('GOLDEN mid-day custom window [Mar 7 12:00 local, Mar 8 12:00 local): exactly obs-q-025..obs-q-041 (half-open)', () => {
  const resolved = resolveOrThrow({
    kind: 'custom',
    start: '2026-03-07T19:00:00.000Z',
    end: '2026-03-08T18:00:00.000Z',
    label: 'mid-season custom window',
  });
  // The window touches local days Mar 7 and Mar 8; Mar 8 is the 23-hour
  // spring-forward day and the 02:00->03:00 jump sits INSIDE the window.
  assert.equal(resolved.localDayCount, 2);
  assert.deepEqual(
    resolved.dstDayAdjustments.map((day) => [day.date, day.daySeconds]),
    [['2026-03-08', 82_800]],
  );
  const selected = selectObservationsInPeriod(seriesStore(), 'str-corinne-q', resolved);
  assert.deepEqual(
    selected.map((row) => row.observationId),
    Array.from({ length: 17 }, (_, i) => `obs-q-${String(25 + i).padStart(3, '0')}`),
  );
  // Half-open boundaries, both directions:
  // obs-q-024 @ 2026-03-07T18:00Z is BEFORE the start; obs-q-042 @ exactly
  // 2026-03-08T18:00Z is the EXCLUSIVE end.
  const ids = selected.map((row) => row.observationId);
  assert.ok(!ids.includes('obs-q-024'));
  assert.ok(!ids.includes('obs-q-042'));

  // Flipping the boundary to start AT 18:00Z includes obs-q-042.
  const flipped = resolveOrThrow({ kind: 'custom', start: '2026-03-08T18:00:00.000Z', end: '2026-03-09T07:00:00.000Z', label: 'boundary flip' });
  const flippedIds = selectObservationsInPeriod(seriesStore(), 'str-corinne-q', flipped).map((row) => row.observationId);
  assert.equal(flippedIds[0], 'obs-q-042');
});

test('invalid custom windows are rejected 422 (unordered, malformed, out-of-range years)', () => {
  const unordered = resolvePeriod({ kind: 'custom', start: '2026-04-01T00:00:00Z', end: '2026-03-01T00:00:00Z', label: 'bad' });
  assert.equal(unordered.outcome, 'denied');
  if (unordered.outcome === 'denied') assert.equal(unordered.code, 'INVALID_PERIOD');

  const malformed = resolvePeriod({ kind: 'custom', start: 'not-an-instant', end: '2026-03-09T00:00:00Z', label: 'bad' });
  assert.equal(malformed.outcome, 'denied');
  if (malformed.outcome === 'denied') assert.equal(malformed.code, 'INVALID_PERIOD');

  const badYear = resolvePeriod({ kind: 'calendar-year', year: 1899 });
  assert.equal(badYear.outcome, 'denied');
  if (badYear.outcome === 'denied') assert.equal(badYear.code, 'INVALID_PERIOD');
});

test('periodKeyOf separates slots and is stable', () => {
  assert.equal(periodKeyOf(BEAR, { kind: 'calendar-year', year: 2026 }), periodKeyOf(BEAR, { kind: 'calendar-year', year: 2026 }));
  assert.notEqual(periodKeyOf(BEAR, { kind: 'calendar-year', year: 2026 }), periodKeyOf(BEAR, { kind: 'water-year', year: 2026 }));
  assert.notEqual(periodKeyOf(BEAR, { kind: 'calendar-year', year: 2026 }), periodKeyOf('sys-weber-river', { kind: 'calendar-year', year: 2026 }));
});

// ---------------------------------------------------------------------------
// Reconciliation to the WD-008/WD-025 aggregation (T-15)
// ---------------------------------------------------------------------------

test('custom bounds equal to CY-2026 reproduce the WD-025 report totals EXACTLY (raw goldens)', () => {
  const customCy: PeriodSpec = { kind: 'custom', start: '2026-01-01T07:00:00.000Z', end: '2027-01-01T07:00:00.000Z', label: 'CY-2026 as custom bounds' };
  const totals = periodCategoryTotals(fixturePeriodDeps(NOW), { systemId: BEAR, period: customCy, processingBasis: 'raw', siteIds: null }, CODY);
  assert.equal(totals.outcome, 'allowed');
  const report = generateReport(
    { store: seriesStore(), revisions: createRevisionStore(), now: NOW },
    { systemId: BEAR, siteIds: null, period: { basis: 'calendar-year', year: 2026 }, processingBasis: 'raw', include: DEFAULT_INCLUDE },
    CODY,
  );
  assert.equal(report.outcome, 'allowed');
  if (totals.outcome !== 'allowed' || report.outcome !== 'allowed') return;

  const expectedGoldens: ReadonlyArray<[string, number]> = [
    ['natural-channel-flow', 10299 / 121],
    ['canal-delivery', 267947 / 484],
    ['reservoir-release', 26978 / 121],
  ];
  assert.equal(totals.value.categories.length, 3);
  for (const [category, golden] of expectedGoldens) {
    const row = totals.value.categories.find((candidate) => candidate.category === category);
    assert.ok(row, category);
    assert.ok(closeRelative(row?.volumeAcreFeet ?? 0, golden), `${category} golden ${golden}`);
    // EXACT equality with the WD-025 report over the same bounds (same
    // aggregation calls, same accumulation order).
    const reportRow = report.value.sections.totals.categories.find((candidate) => candidate.category === category);
    assert.ok(reportRow, category);
    assert.equal(row?.volumeAcreFeet, reportRow?.volumeAcreFeet, category);
    assert.equal(row?.coveredSeconds, reportRow?.coveredSeconds, category);
    assert.equal(row?.durationSeconds, reportRow?.durationSeconds, category);
    assert.equal(row?.estimatedSeconds, reportRow?.estimatedSeconds, category);
  }
});

test('mid-day custom totals reconcile to the WD-008 aggregation over the same bounds', () => {
  const spec: PeriodSpec = { kind: 'custom', start: '2026-03-07T19:00:00.000Z', end: '2026-03-08T18:00:00.000Z', label: 'mid-day window' };
  const totals = periodCategoryTotals(fixturePeriodDeps(NOW), { systemId: BEAR, period: spec, processingBasis: 'raw', siteIds: null }, CODY);
  assert.equal(totals.outcome, 'allowed');
  if (totals.outcome !== 'allowed') return;

  for (const row of totals.value.categories) {
    let volume = 0;
    let covered = 0;
    for (const streamId of row.streamIds) {
      const series = aggregateSeries(seriesStore(), { streamId, start: '2026-03-07T19:00:00.000Z', end: '2026-03-08T18:00:00.000Z', basis: 'raw', interval: 'daily' });
      assert.equal(series.outcome, 'allowed', streamId);
      if (series.outcome === 'allowed') {
        for (const bucket of series.value.buckets) {
          volume += bucket.volumeAcreFeet ?? 0;
          covered += bucket.coveredSeconds;
        }
      }
    }
    assert.ok(closeRelative(row.volumeAcreFeet, volume), `${row.category}: ${row.volumeAcreFeet} vs ${volume}`);
    assert.equal(row.coveredSeconds, covered);
  }
});

test('DST-spanning windows: the spring-forward day aggregates as 82 800 s and fall-back as 90 000 s', () => {
  const spring = aggregateSeries(seriesStore(), { streamId: 'str-corinne-q', start: '2026-03-08T07:00:00.000Z', end: '2026-03-09T06:00:00.000Z', basis: 'raw', interval: 'daily' });
  assert.equal(spring.outcome, 'allowed');
  if (spring.outcome === 'allowed') {
    const day = spring.value.buckets.find((bucket) => bucket.key === '2026-03-08');
    assert.ok(day);
    assert.equal(day?.durationSeconds, 82_800);
    assert.equal(day?.volumeAcreFeet, 3812 / 121); // the WD-008 daily golden for the 23-hour day
  }

  const fall = aggregateSeries(seriesStore(), { streamId: 'str-corinne-q', start: '2026-11-01T06:00:00.000Z', end: '2026-11-02T07:00:00.000Z', basis: 'raw', interval: 'daily' });
  assert.equal(fall.outcome, 'allowed');
  if (fall.outcome === 'allowed') {
    const day = fall.value.buckets.find((bucket) => bucket.key === '2026-11-01');
    assert.ok(day);
    assert.equal(day?.durationSeconds, 90_000);
    assert.equal(day?.volumeAcreFeet, null); // honestly uncovered, never zero
    assert.equal(day?.coverageFraction, 0);
  }

  // The resolved custom windows report the same DST facts.
  const springPeriod = resolveOrThrow({ kind: 'custom', start: '2026-03-08T07:00:00.000Z', end: '2026-03-09T06:00:00.000Z', label: 'DST day' });
  assert.deepEqual(springPeriod.dstDayAdjustments.map((day) => [day.date, day.daySeconds]), [['2026-03-08', 82_800]]);
  const fallPeriod = resolveOrThrow({ kind: 'custom', start: '2026-11-01T06:00:00.000Z', end: '2026-11-02T07:00:00.000Z', label: 'DST day' });
  assert.deepEqual(fallPeriod.dstDayAdjustments.map((day) => [day.date, day.daySeconds]), [['2026-11-01', 90_000]]);
});

test('period totals enforce the same scope gates as report generation (hidden system 404, anonymous 401)', () => {
  const hidden = periodCategoryTotals(fixturePeriodDeps(NOW), { systemId: 'sys-weber-river', period: { kind: 'calendar-year', year: 2026 }, processingBasis: 'raw', siteIds: null }, CODY);
  assert.equal(hidden.outcome, 'denied');
  if (hidden.outcome === 'denied') assert.equal(hidden.status, 404);

  const anonymous = periodCategoryTotals(fixturePeriodDeps(NOW), { systemId: BEAR, period: { kind: 'calendar-year', year: 2026 }, processingBasis: 'raw', siteIds: null }, null);
  assert.equal(anonymous.outcome, 'denied');
  if (anonymous.outcome === 'denied') assert.equal(anonymous.status, 401);
});
