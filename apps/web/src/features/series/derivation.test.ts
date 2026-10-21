/**
 * Derivation tests for the WD-008 series chart model (FR-005, FR-006,
 * FR-062, FR-066).
 *
 * Run (zero dependencies, same runner as apps/web/tests):
 *   cd apps/web && node --test --experimental-strip-types src/features/series/derivation.test.ts
 *
 * The suite drives the PURE derivation with the frozen contract fixtures
 * (seed utah-water-fixture-v1) and asserts the SAME DST-day goldens as
 * services/api/src/series/golden.test.ts (mean 23.825, coverage 16/23,
 * volume 3812/121 acre-feet on the 23-hour local day 2026-03-08), so the
 * presentation surface cannot drift from the authoritative API numbers.
 *
 * (Import pattern per apps/web/tests/adapters.test.ts: computed specifiers
 * for node --test --experimental-strip-types, type-only imports for tsc.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { DaySummary, GapBandLike, ProcessingBasis, RevisionLike, SelectedPoint, SeriesPointLike, StreamLike } from './derivation';

// Extensionless src imports under node --test (see tests/ts-resolve-hook.mjs).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const derivationPath = './derivation.ts';
const derivation: typeof import('./derivation') = await import(derivationPath);
const observationsPath = '../../shell/data/observations.ts';
const observations: typeof import('../../shell/data/observations') = await import(observationsPath);
const fixturesPath = '../../shell/data/fixtures.ts';
const fixtures: typeof import('../../shell/data/fixtures') = await import(fixturesPath);

const CLOSE = 1e-9;
function close(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= CLOSE * Math.max(Math.abs(expected), 1e-12);
}

const CORINNE_STREAM = fixtures.stations
  .flatMap((station) => station.datastreams)
  .find((stream) => stream.id === 'str-corinne-q')!;
const STREAM: StreamLike = {
  id: CORINNE_STREAM.id,
  unitId: CORINNE_STREAM.unitId,
  cadenceMinutes: CORINNE_STREAM.cadenceMinutes,
  validRangeMin: CORINNE_STREAM.validRangeMin,
  validRangeMax: CORINNE_STREAM.validRangeMax,
  timeZone: CORINNE_STREAM.timeZone,
};
const GAPS: GapBandLike[] = fixtures.gaps
  .filter((gap) => gap.streamId === 'str-corinne-q')
  .map((gap) => ({ id: gap.id, start: gap.start, end: gap.end, reason: gap.reason }));

function pointsAt(basis: ProcessingBasis): SelectedPoint[] {
  return derivation.selectAtBasis(observations.streamSeries('str-corinne-q'), fixtures.revisions as readonly RevisionLike[], basis, STREAM);
}

function dayOf(summaries: readonly DaySummary[], key: string): DaySummary {
  const day = summaries.find((entry) => entry.key === key);
  assert.ok(day, `day ${key} summarized`);
  return day;
}

// ---------------------------------------------------------------------------
// Processing-basis selection (FR-066)
// ---------------------------------------------------------------------------

test('basis selection: raw keeps originals; best-available takes the chain head', () => {
  const raw = pointsAt('raw').find((selected) => selected.point.id === 'obs-q-032')!;
  assert.equal(raw.value, -1.2);
  assert.equal(raw.level, 'raw');
  const best = pointsAt('best-available').find((selected) => selected.point.id === 'obs-q-032')!;
  assert.equal(best.value, 20.9);
  assert.equal(best.revisionId, 'rev-corinne-2004');
  assert.deepEqual(best.qualifiers, ['ice-affected']);
  assert.equal(best.level, 'best-available');
});

test('basis selection: provisional/reviewed use the at-or-above ladder; fallback is flagged', () => {
  const provisional = pointsAt('provisional').find((selected) => selected.point.id === 'obs-q-032')!;
  assert.equal(provisional.value, 20.9, 'latest revision at or above provisional');
  const reviewed = pointsAt('reviewed').find((selected) => selected.point.id === 'obs-q-032')!;
  assert.equal(reviewed.value, 20.9);
  // A chain that never reached the maturity falls back to raw, flagged.
  const selected = derivation.selectAtBasis(
    [observations.streamSeries('str-corinne-q').find((point) => point.id === 'obs-q-019')!],
    [
      {
        id: 'rev-synth',
        targetObservationId: 'obs-q-019',
        type: 'correction',
        value: 19.05,
        unitId: 'cfs',
        processingLevel: 'provisional',
        qualifierIds: [],
        reason: 'synthetic below-basis chain',
        actorId: 'principal-fatima-engineer',
        recordedAt: '2026-03-09T09:00:00Z',
      },
    ] as readonly RevisionLike[],
    'reviewed',
    STREAM,
  )[0]!;
  assert.equal(selected.value, 19.2, 'raw fallback');
  assert.ok(selected.belowBasis);
  assert.ok(selected.point.flags.includes('below-selected-basis'));
});

test('presentation rules: markers follow the displayed value, provenance flags carry over', () => {
  const best = new Map(pointsAt('best-available').map((selected) => [selected.point.id, selected]));
  // obs-q-032: corrected value in range -> ice-affected marker (qualifier), not negative.
  const corrected = best.get('obs-q-032')!;
  assert.equal(corrected.marker, 'ice-affected');
  assert.ok(!corrected.point.flags.includes('negative'), 'range flags re-derived from the effective value');
  // obs-q-044: unrevised 9500 stays out-of-range at every basis.
  const spike = best.get('obs-q-044')!;
  assert.equal(spike.marker, 'out-of-range');
  assert.ok(spike.point.flags.includes('out-of-range'));
  // obs-q-042: gap-edge estimate is estimated at best-available too (interpolate qualifier).
  const gapEdge = best.get('obs-q-042')!;
  assert.equal(gapEdge.value, 23.9);
  assert.equal(gapEdge.marker, 'estimated');
  // obs-q-021: a zero is reported data - suspect-zero, never null-frame.
  const zero = best.get('obs-q-021')!;
  assert.equal(zero.value, 0);
  assert.ok(zero.point.flags.includes('suspect-zero'));
  // obs-q-010: null frame stays unavailable at every basis.
  const nullFrame = best.get('obs-q-010')!;
  assert.equal(nullFrame.value, null);
  assert.ok(nullFrame.point.flags.includes('null-frame'));
  // Duplicates keep both rows and the duplicate flag.
  const duplicates = pointsAt('raw').filter((selected) => selected.point.observedAt === '2026-03-07T10:00:00Z');
  assert.equal(duplicates.length, 2, 'both originals retained in the point list');
  assert.ok(duplicates.every((selected) => selected.point.flags.includes('duplicate-timestamp')));
});

// ---------------------------------------------------------------------------
// Daily summaries: the same DST-day goldens as the API suite
// ---------------------------------------------------------------------------

test('daily summary goldens: DST day 2026-03-08 raw (23-hour day, gap, spike, estimate)', () => {
  const summaries = derivation.dailySummaries(
    pointsAt('raw').map((selected) => selected.point),
    STREAM,
    GAPS,
  );
  const day = dayOf(summaries, '2026-03-08');
  assert.equal(day.durationSeconds, 82_800, '23-hour local day');
  assert.equal(day.coveredSeconds, 57_600);
  assert.ok(close(day.coverageFraction, 16 / 23));
  assert.ok(close(day.meanValue!, 23.825), `mean ${day.meanValue}`);
  assert.ok(close(day.volumeAcreFeet!, 3812 / 121), `volume ${day.volumeAcreFeet}`);
  assert.equal(Math.round(day.gapHours), 6, 'declared outage gap reported as 6 hours');
  assert.equal(day.spikeExcluded, true, 'the 9500 reading is excluded from the mean');
  assert.ok(close(day.estimatedProportion, 1 / 16), 'the gap-edge estimate covers 1/16 of the covered time');
});

test('daily summary goldens: DST day 2026-03-08 best-available (gap edge corrected to 23.9)', () => {
  const summaries = derivation.dailySummaries(
    pointsAt('best-available').map((selected) => selected.point),
    STREAM,
    GAPS,
  );
  const day = dayOf(summaries, '2026-03-08');
  assert.ok(close(day.meanValue!, 23.85));
  assert.ok(close(day.volumeAcreFeet!, 3816 / 121));
  assert.ok(close(day.coverageFraction, 16 / 23));
  assert.ok(close(day.estimatedProportion, 1 / 16), 'corrected gap edge still estimated (interpolate qualifier)');
});

test('daily summary goldens: 2026-03-06/07 raw (null hole vs reported zero, duplicate normalization)', () => {
  const summaries = derivation.dailySummaries(
    pointsAt('raw').map((selected) => selected.point),
    STREAM,
    GAPS,
  );
  const day0306 = dayOf(summaries, '2026-03-06');
  assert.ok(close(day0306.coverageFraction, 11 / 24), 'null frame and absent slot leave holes');
  assert.ok(close(day0306.meanValue!, 201.2 / 11));
  assert.ok(close(day0306.volumeAcreFeet!, 2012 / 121));
  const day0307 = dayOf(summaries, '2026-03-07');
  assert.ok(close(day0307.meanValue!, 421.5 / 22), 'duplicate contributes once as the retransmission 19.3');
  assert.ok(!close(day0307.meanValue!, 421.3 / 22));
  assert.ok(close(day0307.coverageFraction, 22 / 24), 'suspect zero counts as covered data');
  assert.equal(day0307.spikeExcluded, true, 'the -1.2 reading is excluded at raw basis');
  const day0307Best = dayOf(
    derivation.dailySummaries(
      pointsAt('best-available').map((selected) => selected.point),
      STREAM,
      GAPS,
    ),
    '2026-03-07',
  );
  assert.ok(close(day0307Best.meanValue!, 442.4 / 23), 'corrected value joins the mean at best-available');
  assert.equal(day0307Best.spikeExcluded, false);
});

test('daily summaries stay empty-but-visible on dataless days (never zero)', () => {
  const summaries = derivation.dailySummaries(
    pointsAt('raw').map((selected) => selected.point),
    STREAM,
    GAPS,
  );
  const day0305 = summaries.find((entry) => entry.key === '2026-03-05');
  assert.equal(day0305, undefined, 'no fabricated buckets before the first data');
  const day0309 = dayOf(summaries, '2026-03-09');
  assert.ok(day0309.coverageFraction > 0, 'the 00:00 local reading covers its hour');
  // A day with zero usable data reports null values; the annotation says so.
  const annotation = derivation.coverageAnnotation({
    key: '2026-03-05',
    startMs: 0,
    endMs: 0,
    durationSeconds: 86_400,
    coveredSeconds: 0,
    coverageFraction: 0,
    estimatedProportion: 0,
    meanValue: null,
    volumeAcreFeet: null,
    gapHours: 0,
    spikeExcluded: false,
  });
  assert.match(annotation, /no usable data/);
});

test('accessibility helpers: legend carries shape+text; aria labels name value, basis, revision and flags', () => {
  assert.ok(derivation.SERIES_LEGEND.length >= 6);
  assert.ok(derivation.SERIES_LEGEND.every((item) => item.shape.length > 0 && item.label.length > 0));
  const selected = pointsAt('best-available').find((entry) => entry.point.id === 'obs-q-032')!;
  const label = derivation.pointAriaLabel(
    selected,
    'cfs',
    (value, unit) => (value === null ? 'Unavailable' : `${value.toFixed(1)} ${unit}`),
    (at) => `time ${at}`,
  );
  assert.match(label, /best-available 20\.9 cfs/);
  assert.match(label, /raw -1\.2 cfs/);
  assert.match(label, /revision rev-corinne-2004/);
  assert.match(label, /qualifiers ice-affected/);
  const day = dayOf(
    derivation.dailySummaries(
      pointsAt('raw').map((entry) => entry.point),
      STREAM,
      GAPS,
    ),
    '2026-03-08',
  );
  const annotation = derivation.coverageAnnotation(day);
  assert.match(annotation, /2026-03-08/);
  assert.match(annotation, /70% covered/);
  assert.match(annotation, /6 h declared gap/);
});
