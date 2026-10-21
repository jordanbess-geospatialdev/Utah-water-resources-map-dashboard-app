/**
 * Space/time totals tests (WD-018; FR-061; T-11): every category total
 * reconciles EXACTLY (same summation order, ===) to the underlying WD-008
 * daily buckets, and the hand-derived golden fractions below (pending
 * measurement-owner approval like the WD-008 goldens) pin the fixture world:
 *
 * Window [2026-03-06T07:00Z, 2026-03-09T06:00Z) = local days 2026-03-06..
 * 2026-03-08 (the third is the 23-hour DST day). Public visibility.
 *
 * NATURAL-CHANNEL-FLOW (str-corinne-q, raw): the three daily goldens
 * 2012/121 + 4215/121 + 3812/121 = 10 039/121 acre-feet (the WD-008 weekly
 * golden volume); covered 39 600+79 200+57 600 = 176 400 s of
 * 86 400+86 400+82 800 = 255 600 s -> coverage 49/71; estimated 3 600 s.
 * Best-available basis: 2012/121 + 4424/121 + 3816/121 = 10 252/121.
 *
 * CANAL-DELIVERY (str-hyrum-q-public, manual weekly cadence, raw): day 03-06
 * 13.1 cfs x 35 100 s + 14.0 x 51 300 s; day 03-07 14.0 x 86 400 s; day 03-08
 * 14.0 x 63 000 s + 15.2 x 19 800 s; full coverage, nothing estimated.
 *
 * RESERVOIR-RELEASE (str-hyrum-q-owner, restricted - 'all' visibility only):
 * 9.8 x (86 400 + 86 400 + 36 000) + 10.4 x 46 800 cubic feet / 43 560.
 *
 * NO DOUBLE COUNT: the adjacent Hyrum public/owner stations share a display
 * name and measure neighboring points; governed water-source/site-type
 * fields place them in DIFFERENT categories and combinedVolumeAcreFeet stays
 * null - the summary never sums across categories.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateSeries } from '../../series/aggregate.ts';
import { CORINNE, GOLDEN_WINDOW, closeRelative } from '../../series/golden.ts';
import { seriesStore } from '../../series/load.ts';
import type { DomainResult } from '../../series/types.ts';
import { areaTotals, fixtureAreaTotals, NO_DOUBLE_COUNT_POLICY, type AreaTotals } from '../totals.ts';
import { summaryWorld } from '../world.ts';

const store = seriesStore();
const world = summaryWorld();

function totals(options: Partial<Parameters<typeof fixtureAreaTotals>[0]> = {}): AreaTotals {
  const result = fixtureAreaTotals({
    area: 'statewide',
    start: GOLDEN_WINDOW.start,
    end: GOLDEN_WINDOW.end,
    basis: 'raw',
    ...options,
  });
  assert.equal(result.outcome, 'allowed');
  if (result.outcome === 'allowed') return result.value;
  throw new Error('unreachable');
}

function categoryOf(result: ReturnType<typeof totals>, category: string) {
  const entry = result.categories.find((candidate) => candidate.category === category);
  assert.ok(entry, `category ${category} present`);
  return entry;
}

/** Independent recomputation: the sum of the WD-008 daily buckets of one stream. */
function streamDailySums(streamId: string, basis: 'raw' | 'best-available') {
  const result = aggregateSeries(store, {
    streamId,
    start: GOLDEN_WINDOW.start,
    end: GOLDEN_WINDOW.end,
    basis,
    interval: 'daily',
  });
  assert.equal(result.outcome, 'allowed');
  if (result.outcome !== 'allowed') throw new Error('unreachable');
  const sums = { volumeAcreFeet: 0, coveredSeconds: 0, durationSeconds: 0, estimatedSeconds: 0 };
  for (const bucket of result.value.buckets) {
    sums.volumeAcreFeet += bucket.volumeAcreFeet ?? 0;
    sums.coveredSeconds += bucket.coveredSeconds;
    sums.durationSeconds += bucket.durationSeconds;
    sums.estimatedSeconds += bucket.estimatedSeconds;
  }
  return sums;
}

function assertClose(actual: number, expected: number, message: string) {
  assert.ok(closeRelative(actual, expected), `${message}: ${actual} vs ${expected}`);
}

test('golden: natural-channel-flow raw volume equals the WD-008 weekly golden 10039/121 acre-feet', () => {
  const natural = categoryOf(totals(), 'natural-channel-flow');
  assert.deepEqual(natural.streamIds, ['str-corinne-q']);
  assertClose(natural.volumeAcreFeet, CORINNE.weekly.rawVolumeAcreFeet, 'raw natural-channel volume');
  assert.equal(natural.volumeUnit, 'acre-feet');
  assert.equal(natural.coveredSeconds, 176_400);
  assert.equal(natural.durationSeconds, 255_600);
  assertClose(natural.coverageFraction, 49 / 71, 'coverage 176400/255600 = 49/71');
  assert.equal(natural.estimatedSeconds, 3_600, 'the estimated gap-edge hour on 2026-03-08');
  assert.deepEqual(
    natural.daily.map((day) => day.key),
    ['2026-03-06', '2026-03-07', '2026-03-08'],
  );
  assertClose(natural.daily[0].volumeAcreFeet, 2012 / 121, 'daily Mar 6 golden');
  assertClose(natural.daily[2].volumeAcreFeet, 3812 / 121, 'daily Mar 8 golden (DST day)');
  assertClose(natural.daily[2].coverageFraction, 16 / 23, 'DST-day coverage 16/23');
});

test('golden: canal-delivery raw volume integrates the manual weekly-cadence readings', () => {
  const canal = categoryOf(totals(), 'canal-delivery');
  assert.deepEqual(canal.streamIds, ['str-hyrum-q-public']);
  const expected = (13.1 * 35_100 + 14.0 * 51_300 + 14.0 * 86_400 + 14.0 * 63_000 + 15.2 * 19_800) / 43_560;
  assertClose(canal.volumeAcreFeet, expected, 'canal-delivery volume');
  assert.equal(canal.coveredSeconds, canal.durationSeconds, 'the diversion flow is covered end to end');
  assert.equal(canal.coverageFraction, 1);
  assert.equal(canal.estimatedSeconds, 0);
});

test('reconciliation: category totals equal the sums of the underlying WD-008 daily values EXACTLY (raw and best-available)', () => {
  for (const basis of ['raw', 'best-available'] as const) {
    const result = totals({ basis });
    const natural = categoryOf(result, 'natural-channel-flow');
    const canal = categoryOf(result, 'canal-delivery');
    const corinne = streamDailySums('str-corinne-q', basis);
    const hyrum = streamDailySums('str-hyrum-q-public', basis);
    // Same summation order as the implementation: exact equality, not tolerance.
    assert.equal(natural.volumeAcreFeet, corinne.volumeAcreFeet, `${basis} natural-channel volume reconciles exactly`);
    assert.equal(natural.coveredSeconds, corinne.coveredSeconds);
    assert.equal(natural.durationSeconds, corinne.durationSeconds);
    assert.equal(natural.estimatedSeconds, corinne.estimatedSeconds);
    assert.equal(canal.volumeAcreFeet, hyrum.volumeAcreFeet, `${basis} canal-delivery volume reconciles exactly`);
    assert.equal(canal.coveredSeconds, hyrum.coveredSeconds);
    assert.equal(canal.estimatedSeconds, hyrum.estimatedSeconds);
    // Per-stream entries reconcile too, and each category equals its streams.
    const naturalStream = result.streams.find((stream) => stream.streamId === 'str-corinne-q');
    assert.ok(naturalStream);
    assert.equal(naturalStream.volumeAcreFeet, corinne.volumeAcreFeet);
    assert.equal(natural.volumeAcreFeet, naturalStream.volumeAcreFeet + 0);
  }
});

test('golden: best-available basis changes the totals (obs-q-032 -1.2 -> 20.9; gap edge 23.5 -> 23.9)', () => {
  const natural = categoryOf(totals({ basis: 'best-available' }), 'natural-channel-flow');
  assertClose(natural.volumeAcreFeet, 10_252 / 121, '2012/121 + 4424/121 + 3816/121');
  assert.equal(natural.coveredSeconds, 180_000, 'the corrected negative reading covers its slot: 176400 + 3600');
  assert.equal(natural.estimatedSeconds, 3_600, 'the interpolated gap edge stays estimated at best-available');
});

test('no double count: categories stay separate, the adjacent Hyrum stations never share one, combined total is null', () => {
  const all = totals({ visibility: 'all' });
  assert.equal(all.combinedVolumeAcreFeet, null, 'a cross-category sum could double-count the same water');
  assert.equal(all.noDoubleCountPolicy, NO_DOUBLE_COUNT_POLICY);
  assert.ok(all.noDoubleCountPolicy.includes('never summed across categories'));

  const canal = categoryOf(all, 'canal-delivery');
  const release = categoryOf(all, 'reservoir-release');
  assert.deepEqual(canal.streamIds, ['str-hyrum-q-public']);
  assert.deepEqual(release.streamIds, ['str-hyrum-q-owner']);
  // The fixture trap: the two adjacent Hyrum stations share a display name
  // and measure neighboring points, yet governed water-source/site-type
  // fields place them in DIFFERENT categories - so they can never pool the
  // same water into one total.
  const canalStation = all.streams.find((stream) => stream.streamId === 'str-hyrum-q-public');
  const releaseStation = all.streams.find((stream) => stream.streamId === 'str-hyrum-q-owner');
  assert.ok(canalStation && releaseStation);
  assert.equal(canalStation.stationDisplayName, releaseStation.stationDisplayName, 'the fixture deliberately shares this display name');
  assert.notEqual(canalStation.category, releaseStation.category);
  const categorySets = all.categories.map((category) => new Set(category.streamIds));
  for (let i = 0; i < categorySets.length; i += 1) {
    for (let j = i + 1; j < categorySets.length; j += 1) {
      for (const streamId of categorySets[i]!) {
        assert.ok(!categorySets[j]!.has(streamId), 'a stream joins exactly one accounting category');
      }
    }
  }
});

test('golden: reservoir-release appears only with all-visibility (restricted owner stream)', () => {
  const publicView = totals();
  assert.equal(publicView.categories.find((category) => category.category === 'reservoir-release'), undefined);
  const all = totals({ visibility: 'all' });
  const release = categoryOf(all, 'reservoir-release');
  const expected = (9.8 * (86_400 + 86_400 + 36_000) + 10.4 * 46_800) / 43_560;
  assertClose(release.volumeAcreFeet, expected, 'reservoir-release volume');
  assert.equal(release.coverageFraction, 1);
});

test('stream inclusion reasons: 5 streams excluded with governed reasons, exactly 2 included', () => {
  const result = totals();
  const included = result.streams.filter((stream) => stream.included).map((stream) => stream.streamId);
  assert.deepEqual(included, ['str-corinne-q', 'str-hyrum-q-public']);
  const excluded = new Map(
    result.streams
      .filter((stream) => !stream.included)
      .map((stream) => [stream.streamId, stream.exclusionReason ?? '']),
  );
  assert.equal(excluded.size, 5);
  assert.match(excluded.get('str-summit-q')!, /station inactive/);
  assert.match(excluded.get('str-ogden-q-proposed')!, /station proposed/);
  assert.match(excluded.get('str-hyrum-q-owner')!, /not in the public projection \(restricted\)/);
  assert.match(excluded.get('str-corinne-stage')!, /dimension mismatch.*stage in ft/);
  assert.match(excluded.get('str-diag-voltage')!, /not in the public projection \(internal\)/);
});

test('a day with no data keeps volume null in the daily table (missing is never zero)', () => {
  const result = totals({ start: '2026-03-10T07:00:00Z', end: '2026-03-11T07:00:00Z' });
  const natural = categoryOf(result, 'natural-channel-flow');
  const day0310 = natural.daily.find((day) => day.key === '2026-03-10');
  assert.ok(day0310, 'the enclosing local day is tabulated');
  assert.equal(day0310.volumeAcreFeet, null, 'no coverage -> no volume synthesized');
  assert.equal(day0310.coverageFraction, 0);
  assert.equal(natural.volumeAcreFeet, 0, 'the running total adds nothing for uncovered time');
});

test('per-system area and empty-area behavior', () => {
  const bear = fixtureAreaTotals({ area: { systemId: 'sys-bear-river' }, start: GOLDEN_WINDOW.start, end: GOLDEN_WINDOW.end, basis: 'raw' });
  assert.equal(bear.outcome, 'allowed');
  if (bear.outcome === 'allowed') {
    assert.equal(bear.value.areaName, 'Bear River Distribution System');
    assert.equal(bear.value.categories.length, 2);
  }
  const weber = fixtureAreaTotals({ area: { systemId: 'sys-weber-river' }, start: GOLDEN_WINDOW.start, end: GOLDEN_WINDOW.end, basis: 'raw' });
  assert.equal(weber.outcome, 'allowed');
  if (weber.outcome === 'allowed') {
    assert.deepEqual(weber.value.categories, [], 'the only Weber station is proposed: no totals are fabricated');
    assert.deepEqual(
      weber.value.streams.map((stream) => [stream.streamId, stream.exclusionReason]),
      [['str-ogden-q-proposed', 'station proposed']],
    );
  }
});

test('window validation reuses the WD-008 bounds (denials, not crashes)', () => {
  const empty = areaTotals(store, world, { area: 'statewide', start: '2026-03-09T07:00:00Z', end: '2026-03-09T07:00:00Z', basis: 'raw' });
  assert.equal(empty.outcome, 'denied');
  if (empty.outcome === 'denied') assert.equal(empty.code, 'EMPTY_WINDOW');

  const malformed = areaTotals(store, world, { area: 'statewide', start: 'not-an-instant', end: '2026-03-09T07:00:00Z', basis: 'raw' });
  assert.equal(malformed.outcome, 'denied');
  if (malformed.outcome === 'denied') assert.equal(malformed.code, 'MALFORMED_WINDOW');

  const tooLarge = areaTotals(store, world, { area: 'statewide', start: '2025-01-01T00:00:00Z', end: '2026-12-31T00:00:00Z', basis: 'raw' });
  assert.equal(tooLarge.outcome, 'denied');
  if (tooLarge.outcome === 'denied') assert.equal(tooLarge.code, 'REQUEST_WINDOW_TOO_LARGE');
});

test('effective bounds document the enclosing local calendar windows (WD-008 contract)', () => {
  const result = totals();
  assert.equal(result.effectiveStart, '2026-03-06T07:00:00.000Z');
  assert.equal(result.effectiveEnd, '2026-03-09T06:00:00.000Z');
  assert.equal(result.timeZone, 'America/Denver');
  assert.equal(result.method, 'rectangle-right@1', 'totals carry the WD-008 integration method identity');
  assert.equal(result.interval, 'daily');
});

test('determinism: deriving the same totals twice yields identical results', () => {
  const first = JSON.stringify(totals({ visibility: 'all' }));
  const second = JSON.stringify(totals({ visibility: 'all' }));
  assert.equal(first, second);
});
