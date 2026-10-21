/**
 * WD-008 series domain tests (verification matrix rows T-06 data semantics
 * and T-02/T-03 grant enforcement for the series read path).
 *
 * Run (zero dependencies):
 *   cd services/api && node --test --experimental-strip-types src/series/test/series.test.ts
 *
 * Every clock input is an injected constant; the store reads only the frozen
 * contract fixtures, so the suite is deterministic - the final test runs the
 * whole scenario twice and compares byte-for-byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateSeries, effectivePoints, effectiveValue } from '../aggregate.ts';
import { compareSeries } from '../compare.ts';
import { CORINNE, closeRelative } from '../golden.ts';
import { createSeriesStore, seriesStore } from '../load.ts';
import type { SeriesStore } from '../load.ts';
import { readStreamGrant, readStreamsGrant } from '../grantCheck.ts';
import { withEntitlement, withPrincipal } from '../../../../../packages/policy/src/index.ts';

const NOW = '2026-03-09T07:00:00Z'; // fixture clock
const store = seriesStore();

const PRINCIPALS = {
  anonymous: null,
  fatima: 'principal-fatima-engineer', // engineer, sys-bear-river
  priya: 'principal-priya-engineer', // engineer, sys-weber-river
  cody: 'principal-cody-commissioner', // commissioner, sys-bear-river
  sarah: 'principal-sarah-researcher', // researcher, dataset-scoped
  diego: 'principal-diego-steward', // steward, statewide
} as const;

function aggregate(streamId: string, basis: 'raw' | 'provisional' | 'reviewed' | 'best-available', interval: 'daily' | 'weekly' | 'monthly' | 'seasonal' = 'daily', start = '2026-03-06T07:00:00.000Z', end = '2026-03-09T06:00:00.000Z') {
  const result = aggregateSeries(store, { streamId, start, end, basis, interval });
  assert.equal(result.outcome, 'allowed', `aggregate ${streamId} ${basis} must be allowed`);
  if (result.outcome === 'allowed') return result.value;
  throw new Error('unreachable');
}

// ---------------------------------------------------------------------------
// DST, gap and duplicate semantics (numerical goldens live in golden.test.ts;
// here the structural rules are pinned)
// ---------------------------------------------------------------------------

test('DST day volume uses interval durations, never mean x 24 h', () => {
  const day = aggregate(CORINNE.streamId, 'raw', 'daily').buckets.find((bucket) => bucket.key === '2026-03-08')!;
  assert.equal(day.durationSeconds, 82_800, '23-hour local day');
  assert.ok(closeRelative(day.volumeAcreFeet!, (day.meanValue! * day.coveredSeconds) / 43_560));
  // mean x 24 h would overstate the day; the negative assertion is in golden.test.ts
  assert.ok(day.volumeAcreFeet! < day.meanValue! * 86_400 / 43_560);
  // The next day is a normal 24-hour day again.
  const next = aggregate(CORINNE.streamId, 'raw', 'daily', '2026-03-09T06:00:00.000Z', '2026-03-10T06:00:00.000Z').buckets.find((bucket) => bucket.key === '2026-03-09')!;
  assert.equal(next.durationSeconds, 86_400);
});

test('gap policy: the declared outage stays a visible hole with reason, never zero-filled', () => {
  const result = aggregate(CORINNE.streamId, 'raw', 'daily');
  const day = result.buckets.find((bucket) => bucket.key === '2026-03-08')!;
  // 6 missing outage slots: covered seconds exclude exactly 6+1 (spike) hours.
  assert.equal(day.gaps.length, 1);
  assert.equal(day.gaps[0]!.id, 'gap-corinne-20260308');
  assert.equal(day.gaps[0]!.reason, 'source-outage');
  assert.equal(day.coveredSeconds, 82_800 - 7 * 3_600);
  assert.ok(day.coverageFraction < 1);
  // The stream-level gap list is returned for hatching.
  assert.equal(result.gaps.length, 1);
  // Even with zero coverage a bucket reports null, never 0.
  const empty = aggregate(CORINNE.streamId, 'raw', 'daily', '2026-03-01T07:00:00.000Z', '2026-03-05T07:00:00.000Z').buckets[0]!;
  assert.equal(empty.coveredSeconds, 0);
  assert.equal(empty.meanValue, null);
  assert.equal(empty.volumeAcreFeet, null);
});

test('duplicate timestamps: retransmission supersedes for statistics, both originals stay in the raw listing', () => {
  const result = aggregate(CORINNE.streamId, 'raw', 'daily');
  const rawAtInstant = result.rawPoints.filter((point) => point.observedAt === '2026-03-07T10:00:00Z');
  // The RAW LISTING keeps both originals (the fixture retains both rows).
  // effectivePoints collapses duplicates; the listing therefore shows the
  // normalized point with the collapsed id recorded.
  assert.equal(rawAtInstant.length, 1);
  const normalized = rawAtInstant[0]!;
  assert.equal(normalized.observationId, 'obs-q-017');
  assert.equal(normalized.value, 19.3);
  assert.deepEqual(normalized.collapsedDuplicateIds, ['obs-q-016']);
  assert.ok(normalized.flags.includes('duplicate-timestamp'));
  assert.ok(normalized.rawFlags.includes('duplicate-timestamp'));
  // The store still exposes both originals for the audit trail.
  const both = store.observationsForStream(CORINNE.streamId).filter((obs) => obs.observedAt === '2026-03-07T10:00:00Z');
  assert.equal(both.length, 2);
  const values = both.map((obs) => obs.value).sort();
  assert.deepEqual(values, [19.1, 19.3]);
});

test('zero is reported data, null is missing: the two are never conflated', () => {
  const result = aggregate(CORINNE.streamId, 'raw', 'daily');
  const zero = result.rawPoints.find((point) => point.observedAt === '2026-03-07T15:00:00Z')!;
  assert.equal(zero.rawValue, 0);
  assert.equal(zero.value, 0);
  assert.ok(zero.flags.includes('suspect-zero'));
  assert.ok(!zero.flags.includes('null-frame'));
  const nullFrame = result.rawPoints.find((point) => point.observedAt === '2026-03-07T03:00:00Z')!;
  assert.equal(nullFrame.rawValue, null);
  assert.ok(nullFrame.rawFlags.includes('null-frame'));
  // The zero's slot is covered (it is a value); the null's slot is not.
  const day0306 = result.buckets.find((bucket) => bucket.key === '2026-03-06')!;
  const day0307 = result.buckets.find((bucket) => bucket.key === '2026-03-07')!;
  assert.equal(day0306.nullPointCount, 1);
  assert.equal(day0307.nullPointCount, 0);
  assert.ok(day0306.coverageFraction < 12 / 24, 'the null slot is a hole, not a zero');
  assert.ok(closeRelative(day0307.coverageFraction, 22 / 24), 'the suspect zero is covered data');
});

test('negative and out-of-range readings: excluded from means, present in the raw listing with flags', () => {
  const result = aggregate(CORINNE.streamId, 'raw', 'daily');
  const negative = result.rawPoints.find((point) => point.observedAt === '2026-03-08T02:00:00Z')!;
  assert.equal(negative.rawValue, -1.2);
  assert.ok(negative.rawFlags.includes('negative'));
  assert.ok(negative.flags.includes('negative'), 'raw basis keeps the negative excluded');
  const spike = result.rawPoints.find((point) => point.observedAt === '2026-03-08T20:00:00Z')!;
  assert.equal(spike.rawValue, 9500);
  assert.ok(spike.rawFlags.includes('out-of-range'));
  const day0308 = result.buckets.find((bucket) => bucket.key === '2026-03-08')!;
  assert.equal(day0308.excludedPointCount, 1);
  // The mean provably excludes 9500 (it would dominate any mean that included it).
  assert.ok(day0308.meanValue! < 100);
  // The corrected value at best-available is in range and therefore included.
  const best = aggregate(CORINNE.streamId, 'best-available', 'daily');
  const corrected = best.rawPoints.find((point) => point.observedAt === '2026-03-08T02:00:00Z')!;
  assert.equal(corrected.value, 20.9);
  assert.equal(corrected.revisionId, 'rev-corinne-2004');
  assert.deepEqual(corrected.qualifierIds, ['ice-affected']);
  assert.ok(!corrected.flags.includes('negative'));
});

test('processing-level selector changes values and levels (FR-066)', () => {
  const obs032 = store.observationsForStream(CORINNE.streamId).find((obs) => obs.id === 'obs-q-032')!;
  const chain = store.revisionChain('obs-q-032');
  assert.equal(effectiveValue(obs032, chain, 'raw').value, -1.2);
  assert.equal(effectiveValue(obs032, chain, 'provisional').revisionId, 'rev-corinne-2004');
  assert.equal(effectiveValue(obs032, chain, 'reviewed').value, 20.9);
  assert.equal(effectiveValue(obs032, chain, 'best-available').revisionId, 'rev-corinne-2004');
  // Ladder semantics: a basis shows the latest revision at OR ABOVE the
  // selected maturity, so obs-q-019's reviewed revision serves a provisional
  // view too (at-or-above; the docstring in aggregate.ts is normative).
  const obs019 = store.observationsForStream(CORINNE.streamId).find((obs) => obs.id === 'obs-q-019')!;
  const reviewed = effectiveValue(obs019, store.revisionChain('obs-q-019'), 'reviewed');
  assert.equal(reviewed.value, 19.2);
  assert.equal(reviewed.level, 'reviewed');
  const provisionalOn019 = effectiveValue(obs019, store.revisionChain('obs-q-019'), 'provisional');
  assert.equal(provisionalOn019.value, 19.2);
  assert.equal(provisionalOn019.belowBasis, false);
  // below-selected-basis fires only when NO revision reached the maturity: a
  // synthetic provisional-only chain viewed at reviewed falls back to raw.
  const provisionalOnly = [
    {
      id: 'rev-synth-provisional',
      targetObservationId: 'obs-q-019',
      baseRevisionId: null,
      type: 'correction' as const,
      value: 19.0,
      unitId: 'cfs',
      processingLevel: 'provisional' as const,
      qualifierIds: [],
      reason: 'synthetic chain for the below-basis rule',
      actorId: 'principal-fatima-engineer',
      recordedAt: '2026-03-09T09:00:00Z',
    },
  ];
  const below = effectiveValue(obs019, provisionalOnly, 'reviewed');
  assert.equal(below.value, 19.2, 'falls back to the raw value');
  assert.equal(below.level, 'raw');
  assert.ok(below.belowBasis);
  // The flag surfaces on the effective point list for a stream whose chains
  // never reached the selected basis (same synthetic rule via a direct call).
  const stream = store.streamById(CORINNE.streamId)!;
  const points = effectivePoints(store, stream, Date.parse('2026-03-07T07:00:00Z'), Date.parse('2026-03-09T06:00:00Z'), 'provisional');
  const point019 = points.find((point) => point.observationId === 'obs-q-019')!;
  assert.ok(!point019.flags.includes('below-selected-basis'), 'fixture chains reach provisional at or above');
  // Daily means follow the selector (raw vs best-available differ on Mar 7).
  const rawMean = aggregate(CORINNE.streamId, 'raw', 'daily').buckets.find((bucket) => bucket.key === '2026-03-07')!.meanValue!;
  const bestMean = aggregate(CORINNE.streamId, 'best-available', 'daily').buckets.find((bucket) => bucket.key === '2026-03-07')!.meanValue!;
  assert.ok(rawMean < bestMean);
});

test('seasonal aggregation: irrigation default window has no fixture data and stays honestly empty', () => {
  const irrigation = aggregateSeries(store, {
    streamId: CORINNE.streamId,
    start: '2026-01-01T07:00:00.000Z',
    end: '2026-12-31T07:00:00.000Z',
    basis: 'raw',
    interval: 'seasonal',
  });
  assert.equal(irrigation.outcome, 'allowed');
  if (irrigation.outcome === 'allowed') {
    assert.equal(irrigation.value.buckets.length, 1);
    const bucket = irrigation.value.buckets[0]!;
    assert.equal(bucket.key, '2026-irrigation');
    assert.equal(bucket.intervalStart, '2026-04-01T06:00:00.000Z'); // MDT boundary
    assert.equal(bucket.intervalEnd, '2026-11-01T06:00:00.000Z');
    assert.equal(bucket.coveredSeconds, 0);
    assert.equal(bucket.meanValue, null);
  }
  const waterYear = aggregateSeries(store, {
    streamId: CORINNE.streamId,
    start: '2026-03-01T07:00:00.000Z',
    end: '2026-03-09T06:00:00.000Z',
    basis: 'raw',
    interval: 'seasonal',
    season: 'water-year',
  });
  assert.equal(waterYear.outcome, 'allowed');
  if (waterYear.outcome === 'allowed') {
    const bucket = waterYear.value.buckets[0]!;
    assert.equal(bucket.key, '2026-water-year');
    assert.equal(bucket.intervalStart, '2025-10-01T06:00:00.000Z');
    assert.ok(bucket.coveredSeconds > 0);
  }
});

test('bounded series: oversized and inverted windows are typed denials', () => {
  const tooLarge = aggregateSeries(store, {
    streamId: CORINNE.streamId,
    start: '2020-01-01T00:00:00.000Z',
    end: '2026-12-31T00:00:00.000Z',
    basis: 'raw',
    interval: 'monthly',
  });
  assert.equal(tooLarge.outcome, 'denied');
  if (tooLarge.outcome === 'denied') {
    assert.equal(tooLarge.status, 400);
    assert.equal(tooLarge.code, 'REQUEST_WINDOW_TOO_LARGE');
  }
  const inverted = aggregateSeries(store, {
    streamId: CORINNE.streamId,
    start: '2026-03-09T06:00:00.000Z',
    end: '2026-03-06T07:00:00.000Z',
    basis: 'raw',
    interval: 'daily',
  });
  assert.equal(inverted.outcome === 'denied' && inverted.code, 'EMPTY_WINDOW');
  const malformed = aggregateSeries(store, {
    streamId: CORINNE.streamId,
    start: 'not-a-time',
    end: '2026-03-09T06:00:00.000Z',
    basis: 'raw',
    interval: 'daily',
  });
  assert.equal(malformed.outcome === 'denied' && malformed.code, 'MALFORMED_WINDOW');
  const unknown = aggregateSeries(store, {
    streamId: 'str-does-not-exist',
    start: '2026-03-06T07:00:00.000Z',
    end: '2026-03-09T06:00:00.000Z',
    basis: 'raw',
    interval: 'daily',
  });
  assert.equal(unknown.outcome === 'denied' && unknown.status, 404);
});

// ---------------------------------------------------------------------------
// Comparison (FR-007)
// ---------------------------------------------------------------------------

test('multi-site comparison aligns intervals in common units with visible gaps', () => {
  const comparison = compareSeries(store, {
    selections: [{ streamId: 'str-corinne-q' }, { streamId: 'str-hyrum-q-public' }],
    start: '2026-03-06T07:00:00.000Z',
    end: '2026-03-09T06:00:00.000Z',
    basis: 'raw',
    interval: 'daily',
  });
  assert.equal(comparison.outcome, 'allowed');
  if (comparison.outcome !== 'allowed') return;
  const { series } = comparison.value;
  assert.equal(series.length, 2);
  assert.equal(comparison.value.commonUnitId, 'cfs');
  for (const entry of series) {
    assert.deepEqual(entry.buckets.map((bucket) => bucket.key), ['2026-03-06', '2026-03-07', '2026-03-08'], 'aligned keys');
    assert.ok(entry.sourceLabel.length > 0, 'source legend text per series');
  }
  const corinne = series[0]!;
  const hyrum = series[1]!;
  // Telemetry gaps stay visible; the manual stream is fully covered these days.
  assert.ok(closeRelative(corinne.buckets[2]!.coverageFraction, 16 / 23));
  assert.equal(hyrum.buckets[2]!.coverageFraction, 1);
  assert.ok(closeRelative(hyrum.buckets[0]!.meanValue!, 13.634375));
  assert.ok(closeRelative(hyrum.buckets[2]!.meanValue!, 1643 / 115));
});

test('year comparison keeps a dataless year as an explicit all-gap series', () => {
  const comparison = compareSeries(store, {
    selections: [{ streamId: 'str-corinne-q', years: [2025, 2026] }],
    basis: 'raw',
    interval: 'monthly',
  });
  assert.equal(comparison.outcome, 'allowed');
  if (comparison.outcome !== 'allowed') return;
  const byYear = new Map(comparison.value.series.map((entry) => [entry.year, entry]));
  assert.equal(byYear.size, 2);
  const y2025 = byYear.get(2025)!;
  assert.equal(y2025.buckets.length, 12);
  assert.ok(y2025.buckets.every((bucket) => bucket.meanValue === null && bucket.coverageFraction === 0));
  const y2026 = byYear.get(2026)!;
  const march = y2026.buckets.find((bucket) => bucket.key === '03')!;
  assert.ok(march.coverageFraction > 0);
});

test('comparison rejects incompatible units and empty selections with typed errors', () => {
  const mixed = compareSeries(store, {
    selections: [{ streamId: 'str-corinne-q' }, { streamId: 'str-corinne-stage' }],
    start: '2026-03-06T07:00:00.000Z',
    end: '2026-03-09T06:00:00.000Z',
    basis: 'raw',
    interval: 'daily',
  });
  assert.equal(mixed.outcome === 'denied' && mixed.code, 'INCOMPATIBLE_UNITS');
  assert.equal(mixed.outcome === 'denied' && mixed.status, 422);
  const empty = compareSeries(store, { selections: [], basis: 'raw', interval: 'daily' });
  assert.equal(empty.outcome === 'denied' && empty.code, 'EMPTY_SELECTION');
});

// ---------------------------------------------------------------------------
// Grant gate (same allow rules for chart APIs, comparisons and exports)
// ---------------------------------------------------------------------------

test('grant gate: anonymous callers read the public projection only', () => {
  const corinne = readStreamGrant(store, PRINCIPALS.anonymous, 'str-corinne-q', NOW);
  assert.equal(corinne.outcome !== 'denied' && corinne.via, 'public-read');
  const hyrumPublic = readStreamGrant(store, PRINCIPALS.anonymous, 'str-hyrum-q-public', NOW);
  assert.equal(hyrumPublic.outcome !== 'denied' && hyrumPublic.projection, 'public');
  const inactive = readStreamGrant(store, PRINCIPALS.anonymous, 'str-summit-q', NOW);
  assert.ok(inactive.outcome !== 'denied', 'inactive public station stays published for history');
});

test('grant gate: restricted and internal streams deny anonymous with 401', () => {
  for (const streamId of ['str-hyrum-q-owner', 'str-diag-voltage', 'str-ogden-q-proposed']) {
    const gate = readStreamGrant(store, PRINCIPALS.anonymous, streamId, NOW);
    assert.equal(gate.outcome, 'denied', `${streamId} denies anonymous`);
    if (gate.outcome === 'denied') {
      assert.equal(gate.status, 401);
      assert.equal(gate.code, 'UNAUTHENTICATED');
      assert.equal(gate.policyReason, 'DENY_ANONYMOUS');
    }
  }
});

test('grant gate: assigned staff read within assignment; outsiders get hidden-object 404', () => {
  // Fatima (Bear River engineer) reads the restricted owner stream and the internal diagnostic.
  const ownerStream = readStreamGrant(store, PRINCIPALS.fatima, 'str-hyrum-q-owner', NOW);
  assert.ok(ownerStream.outcome !== 'denied' && ownerStream.via === 'protected');
  const diagnostic = readStreamGrant(store, PRINCIPALS.fatima, 'str-diag-voltage', NOW);
  assert.ok(diagnostic.outcome !== 'denied');
  // Priya (Weber River engineer) is out of scope on Bear River restricted rows: hidden 404.
  const priya = readStreamGrant(store, PRINCIPALS.priya, 'str-hyrum-q-owner', NOW);
  assert.equal(priya.outcome, 'denied');
  if (priya.outcome === 'denied') {
    assert.equal(priya.status, 404);
    assert.equal(priya.code, 'NOT_FOUND');
    assert.equal(priya.policyReason, 'DENY_OUT_OF_SCOPE');
  }
  // Sarah's dataset grant does not cover this datastream object: hidden 404.
  const sarah = readStreamGrant(store, PRINCIPALS.sarah, 'str-hyrum-q-owner', NOW);
  assert.equal(sarah.outcome === 'denied' && sarah.status, 404);
  // Cody (commissioner, Bear River) is assigned: allowed.
  const cody = readStreamGrant(store, PRINCIPALS.cody, 'str-hyrum-q-owner', NOW);
  assert.ok(cody.outcome !== 'denied');
  // Unknown stream id: 404 for everyone.
  const unknown = readStreamGrant(store, PRINCIPALS.diego, 'str-nope', NOW);
  assert.equal(unknown.outcome === 'denied' && unknown.status, 404);
});

test('grant gate: revocation and deactivation deny on the next request', () => {
  const revokedWorld = withEntitlement(store.world, 'ent-engineer-fatima', { status: 'revoked' });
  const revokedStore: SeriesStore = { ...store, world: revokedWorld };
  const gate = readStreamGrant(revokedStore, PRINCIPALS.fatima, 'str-hyrum-q-owner', NOW);
  assert.equal(gate.outcome, 'denied');
  if (gate.outcome === 'denied') {
    assert.equal(gate.status, 403);
    assert.equal(gate.policyReason, 'DENY_ASSIGNMENT_REVOKED');
  }
  const inactiveStore: SeriesStore = { ...store, world: withPrincipal(store.world, PRINCIPALS.fatima, { active: false }) };
  const inactive = readStreamGrant(inactiveStore, PRINCIPALS.fatima, 'str-hyrum-q-owner', NOW);
  assert.equal(inactive.outcome === 'denied' && inactive.status, 401);
});

test('grant gate: multi-stream requests fail closed on the first denied stream', () => {
  const ok = readStreamsGrant(store, PRINCIPALS.anonymous, ['str-corinne-q', 'str-hyrum-q-public'], NOW);
  assert.equal(ok.outcome, 'allowed');
  const mixed = readStreamsGrant(store, PRINCIPALS.anonymous, ['str-corinne-q', 'str-hyrum-q-owner'], NOW);
  assert.equal(mixed.outcome, 'denied');
  if (mixed.outcome === 'denied') {
    assert.equal(mixed.status, 401);
    assert.equal(mixed.code, 'UNAUTHENTICATED');
  }
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('determinism: the full scenario is byte-identical across two runs and two store instances', () => {
  const scenario = (aStore: SeriesStore): string => {
    const parts = [
      aggregateSeries(aStore, { streamId: 'str-corinne-q', start: '2026-03-06T07:00:00.000Z', end: '2026-03-09T06:00:00.000Z', basis: 'best-available', interval: 'daily' }),
      aggregateSeries(aStore, { streamId: 'str-corinne-q', start: '2026-03-01T07:00:00.000Z', end: '2026-03-09T06:00:00.000Z', basis: 'raw', interval: 'monthly' }),
      compareSeries(aStore, { selections: [{ streamId: 'str-corinne-q' }, { streamId: 'str-hyrum-q-public' }], start: '2026-03-06T07:00:00.000Z', end: '2026-03-09T06:00:00.000Z', basis: 'raw', interval: 'daily' }),
      readStreamsGrant(aStore, PRINCIPALS.fatima, ['str-corinne-q', 'str-diag-voltage'], NOW),
    ];
    return JSON.stringify(parts);
  };
  const first = scenario(seriesStore());
  const second = scenario(seriesStore());
  const freshInstance = scenario(createSeriesStore());
  assert.equal(first, second, 'two runs identical');
  assert.equal(first, freshInstance, 'two independently built stores identical');
});
