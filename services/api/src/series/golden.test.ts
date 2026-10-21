/**
 * Golden assertions for the fixture series (WD-008; T-06 "Golden values").
 *
 * Run (zero dependencies):
 *   cd services/api && node --test --experimental-strip-types src/series/golden.test.ts
 *
 * The expected numbers are hand-computed in golden.ts from the published
 * fixture values and asserted with tolerance 1e-9 relative. They are
 * PENDING MEASUREMENT-OWNER APPROVAL per the development plan ("Test data and
 * scientific invariants": golden calculations are approved by the measurement
 * data owner); golden.ts documents every derivation step for that review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateSeries } from './aggregate.ts';
import type { AggregationResult } from './aggregate.ts';
import { CORINNE, GOLDEN_WINDOW, HYRUM, closeRelative } from './golden.ts';
import { seriesStore } from './load.ts';
import type { AggregatedInterval, DomainResult } from './types.ts';

const store = seriesStore();

function allowed(result: DomainResult<AggregationResult>): AggregationResult {
  assert.equal(result.outcome, 'allowed');
  if (result.outcome === 'allowed') return result.value;
  throw new Error('unreachable');
}

function findBucket(result: AggregationResult, key: string): AggregatedInterval {
  const entry = result.buckets.find((bucket) => bucket.key === key);
  assert.ok(entry, `bucket ${key} exists`);
  return entry;
}

function daily(basis: 'raw' | 'best-available', key: string): AggregatedInterval {
  const result = aggregateSeries(store, {
    streamId: CORINNE.streamId,
    start: GOLDEN_WINDOW.start,
    end: GOLDEN_WINDOW.end,
    basis,
    interval: 'daily',
  });
  return findBucket(allowed(result), key);
}

test('golden: daily mean and volume for 2026-03-06 (null frame and absent slot leave coverage holes)', () => {
  const day = daily('raw', CORINNE.daily0306.key);
  assert.equal(day.intervalStart, CORINNE.daily0306.intervalStart);
  assert.equal(day.intervalEnd, CORINNE.daily0306.intervalEnd);
  assert.equal(day.durationSeconds, CORINNE.daily0306.durationSeconds);
  assert.equal(day.coveredSeconds, CORINNE.daily0306.coveredSeconds);
  assert.ok(closeRelative(day.coverageFraction, CORINNE.daily0306.coverageFraction));
  assert.ok(closeRelative(day.meanValue!, CORINNE.daily0306.meanValue), `mean ${day.meanValue}`);
  assert.ok(closeRelative(day.volumeAcreFeet!, CORINNE.daily0306.volumeAcreFeet), `volume ${day.volumeAcreFeet}`);
  assert.equal(day.nullPointCount, CORINNE.daily0306.nullPointCount);
  assert.equal(day.excludedPointCount, CORINNE.daily0306.excludedPointCount);
  assert.equal(day.pointCount, 12); // 11 usable + 1 null frame (the absent 06:00Z slot has no row at all)
  // A zero-fill of the null frame or the absent slot would raise the mean
  // denominator to 12 or 13; the golden pins the usable count at 11.
  assert.ok(!closeRelative(day.meanValue!, 201.2 / 12));
  assert.ok(!closeRelative(day.meanValue!, 201.2 / 13));
});

test('golden: daily 2026-03-07 raw basis (duplicate normalization, zero counted, negative excluded)', () => {
  const day = daily('raw', CORINNE.daily0307Raw.key);
  assert.equal(day.intervalStart, CORINNE.daily0307Raw.intervalStart);
  assert.equal(day.coveredSeconds, CORINNE.daily0307Raw.coveredSeconds);
  assert.ok(closeRelative(day.coverageFraction, CORINNE.daily0307Raw.coverageFraction));
  assert.ok(closeRelative(day.meanValue!, CORINNE.daily0307Raw.meanValue), `mean ${day.meanValue}`);
  // The duplicate instant 10:00Z contributes exactly once, as 19.3
  // (retransmission supersedes). With the superseded 19.1 the sum were 421.3.
  assert.ok(closeRelative(day.meanValue!, 421.5 / 22));
  assert.ok(!closeRelative(day.meanValue!, 421.3 / 22));
  assert.ok(!closeRelative(day.meanValue!, (421.5 - 19.3 + 19.1) / 22));
  assert.ok(closeRelative(day.volumeAcreFeet!, CORINNE.daily0307Raw.volumeAcreFeet));
  assert.equal(day.excludedPointCount, CORINNE.daily0307Raw.excludedPointCount); // the -1.2 reading
});

test('golden: daily 2026-03-07 best-available basis (obs-q-032 -1.2 -> 20.9)', () => {
  const day = daily('best-available', CORINNE.daily0307Raw.key);
  assert.equal(day.coveredSeconds, CORINNE.daily0307Best.coveredSeconds);
  assert.ok(closeRelative(day.coverageFraction, CORINNE.daily0307Best.coverageFraction));
  assert.ok(closeRelative(day.meanValue!, CORINNE.daily0307Best.meanValue), `mean ${day.meanValue}`);
  assert.ok(closeRelative(day.volumeAcreFeet!, CORINNE.daily0307Best.volumeAcreFeet));
  assert.equal(day.excludedPointCount, CORINNE.daily0307Best.excludedPointCount);
});

test('golden: DST day 2026-03-08 (23 local hours) raw basis volume and coverage on the declared gap', () => {
  const day = daily('raw', CORINNE.daily0308Raw.key);
  assert.equal(day.intervalStart, CORINNE.daily0308Raw.intervalStart);
  assert.equal(day.intervalEnd, CORINNE.daily0308Raw.intervalEnd);
  assert.equal(day.durationSeconds, CORINNE.daily0308Raw.durationSeconds, '23-hour local day');
  assert.equal(day.coveredSeconds, CORINNE.daily0308Raw.coveredSeconds);
  assert.ok(closeRelative(day.coverageFraction, CORINNE.daily0308Raw.coverageFraction), 'coverage 16/23');
  assert.ok(closeRelative(day.meanValue!, CORINNE.daily0308Raw.meanValue), 'mean exactly 23.825');
  assert.ok(closeRelative(day.volumeAcreFeet!, CORINNE.daily0308Raw.volumeAcreFeet), `volume ${day.volumeAcreFeet}`);
  // Interval semantics, never mean x 24 h across the DST boundary.
  assert.ok(!closeRelative(day.volumeAcreFeet!, CORINNE.daily0308Raw.naiveMeanTimes24hAcreFeet));
  // The declared outage gap is reported on the bucket, never zero-filled:
  // 6 missing slots + 1 excluded out-of-range slot = 23 - 16 uncovered hours.
  assert.equal(day.gaps.length, 1);
  assert.equal(day.gaps[0]!.id, CORINNE.gap.id);
  assert.equal(day.gaps[0]!.reason, CORINNE.gap.reason);
  assert.ok(closeRelative((day.durationSeconds - day.coveredSeconds) / 3600, CORINNE.gap.missingSlots + 1));
  // The gap-edge reading is estimated: estimated proportion 1/16.
  assert.equal(day.estimatedSeconds, CORINNE.daily0308Raw.estimatedSeconds);
  assert.ok(closeRelative(day.estimatedProportion, CORINNE.daily0308Raw.estimatedProportion));
});

test('golden: DST day 2026-03-08 best-available basis (gap edge 23.5 -> 23.9, still estimated)', () => {
  const day = daily('best-available', CORINNE.daily0308Raw.key);
  assert.equal(day.durationSeconds, CORINNE.daily0308Raw.durationSeconds);
  assert.ok(closeRelative(day.meanValue!, CORINNE.daily0308Best.meanValue), 'mean exactly 23.85');
  assert.ok(closeRelative(day.volumeAcreFeet!, CORINNE.daily0308Best.volumeAcreFeet));
  assert.equal(day.estimatedSeconds, CORINNE.daily0308Best.estimatedSeconds);
  assert.ok(closeRelative(day.estimatedProportion, CORINNE.daily0308Best.estimatedProportion));
});

test('golden: weekly bucket (Mon 2026-03-02, 167 h) reconciles with the daily goldens', () => {
  const week = findBucket(
    allowed(
      aggregateSeries(store, {
        streamId: CORINNE.streamId,
        start: GOLDEN_WINDOW.start,
        end: GOLDEN_WINDOW.end,
        basis: 'raw',
        interval: 'weekly',
      }),
    ),
    CORINNE.weekly.key,
  );
  assert.equal(week.intervalStart, CORINNE.weekly.intervalStart);
  assert.equal(week.intervalEnd, CORINNE.weekly.intervalEnd);
  assert.equal(week.durationSeconds, CORINNE.weekly.durationSeconds, '167-hour DST week');
  assert.equal(week.coveredSeconds, CORINNE.weekly.rawCoveredSeconds);
  assert.ok(closeRelative(week.coverageFraction, CORINNE.weekly.rawCoverageFraction));
  assert.ok(closeRelative(week.meanValue!, CORINNE.weekly.rawMeanValue));
  assert.ok(closeRelative(week.volumeAcreFeet!, CORINNE.weekly.rawVolumeAcreFeet));
  // Reconciliation: the weekly volume is exactly the three daily goldens.
  const dailyVolumeSum = ['2026-03-06', '2026-03-07', '2026-03-08']
    .map((key) => daily('raw', key).volumeAcreFeet ?? 0)
    .reduce((sum, volume) => sum + volume, 0);
  assert.ok(closeRelative(week.volumeAcreFeet!, dailyVolumeSum));

  const bestWeek = findBucket(
    allowed(
      aggregateSeries(store, {
        streamId: CORINNE.streamId,
        start: GOLDEN_WINDOW.start,
        end: GOLDEN_WINDOW.end,
        basis: 'best-available',
        interval: 'weekly',
      }),
    ),
    CORINNE.weekly.key,
  );
  assert.ok(closeRelative(bestWeek.coverageFraction, CORINNE.weekly.bestCoverageFraction));
  assert.ok(closeRelative(bestWeek.meanValue!, CORINNE.weekly.bestMeanValue));
});

test('golden: monthly bucket 2026-03 (743 h) with the same sums', () => {
  const month = findBucket(
    allowed(
      aggregateSeries(store, {
        streamId: CORINNE.streamId,
        start: '2026-03-01T07:00:00.000Z',
        end: '2026-03-09T06:00:00.000Z',
        basis: 'raw',
        interval: 'monthly',
      }),
    ),
    CORINNE.monthly.key,
  );
  assert.equal(month.intervalStart, CORINNE.monthly.intervalStart);
  assert.equal(month.intervalEnd, CORINNE.monthly.intervalEnd);
  assert.equal(month.durationSeconds, CORINNE.monthly.durationSeconds, '743-hour DST month');
  assert.equal(month.coveredSeconds, CORINNE.monthly.coveredSeconds);
  assert.ok(closeRelative(month.coverageFraction, CORINNE.monthly.rawCoverageFraction));
  assert.ok(closeRelative(month.meanValue!, CORINNE.monthly.rawMeanValue));
  assert.ok(closeRelative(month.volumeAcreFeet!, CORINNE.monthly.rawVolumeAcreFeet));
});

test('golden: manual weekly-cadence stream integration (a reading governs until the next visit)', () => {
  const result = allowed(
    aggregateSeries(store, {
      streamId: HYRUM.streamId,
      start: '2026-03-06T07:00:00.000Z',
      end: '2026-03-09T06:00:00.000Z',
      basis: 'raw',
      interval: 'daily',
    }),
  );
  const day0306 = findBucket(result, '2026-03-06');
  const day0308 = findBucket(result, '2026-03-08');
  assert.ok(closeRelative(day0306.meanValue!, HYRUM.daily0306Mean), `mean ${day0306.meanValue}`);
  assert.ok(closeRelative(day0306.coverageFraction, HYRUM.daily0306Coverage));
  assert.ok(closeRelative(day0308.meanValue!, HYRUM.daily0308Mean), `mean ${day0308.meanValue}`);
  assert.ok(closeRelative(day0308.coverageFraction, HYRUM.daily0308Coverage));
  assert.equal(day0308.durationSeconds, 82_800, 'manual stream daily bucket is DST-correct too');
});

test('golden: fall-back day 2026-11-01 has a 25-hour window and stays unavailable (never zero)', () => {
  const day = findBucket(
    allowed(
      aggregateSeries(store, {
        streamId: CORINNE.streamId,
        start: '2026-10-30T06:00:00.000Z',
        end: '2026-11-03T07:00:00.000Z',
        basis: 'raw',
        interval: 'daily',
      }),
    ),
    '2026-11-01',
  );
  assert.equal(day.durationSeconds, CORINNE.fallBackDayDurationSeconds, '25-hour local day');
  assert.equal(day.coveredSeconds, 0);
  assert.equal(day.coverageFraction, 0);
  assert.equal(day.meanValue, null, 'no data: unavailable, not zero');
  assert.equal(day.volumeAcreFeet, null, 'no volume is synthesized for a dataless day');
});
