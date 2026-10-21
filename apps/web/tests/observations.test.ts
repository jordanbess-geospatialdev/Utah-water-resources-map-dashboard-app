/**
 * Observation tests, ported from the validated prototype's observations.test.ts
 * and adapted to the contract fixtures: raw immutability with appended
 * revisions, missing-never-zero, duplicates retained, late arrivals ordered
 * by observation instant, declared gaps, DST offsets, and labelled outliers.
 *
 * (See adapters.test.ts for the import-pattern note: computed specifiers for
 * node --test --experimental-strip-types, type-only imports for tsc.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Extensionless src imports under node --test (see ts-resolve-hook.mjs).
register('./ts-resolve-hook.mjs', import.meta.url);

const observationsPath = '../src/shell/data/observations.ts';
const observations: typeof import('../src/shell/data/observations') = await import(observationsPath);
const fixturesPath = '../src/shell/data/fixtures.ts';
const fixtures: typeof import('../src/shell/data/fixtures') = await import(fixturesPath);

const corinne = fixtures.stationById.get('sta-bear-corinne')!;

function point(id: string) {
  const point = observations.streamSeries('str-corinne-q').find((candidate) => candidate.id === id);
  assert.ok(point, `observation ${id} present in series`);
  return point;
}

test('raw values stay immutable while revisions derive the best available value', () => {
  // obs-q-032 is the negative icing spike; rev-corinne-2001 corrects it and
  // rev-corinne-2004 advances the same point. Raw is retained, best is derived.
  const negative = point('obs-q-032');
  assert.equal(negative.raw, -1.2);
  assert.equal(negative.best, 20.9);
  assert.equal(negative.processingLevel, 'best-available');
  assert.deepEqual(negative.revisionIds, ['rev-corinne-2001', 'rev-corinne-2004']);
  assert.ok(negative.flags.includes('revised'));
  assert.ok(negative.flags.includes('negative'));

  // Level advance (obs-q-019): same value, promoted processing level.
  const advanced = point('obs-q-019');
  assert.equal(advanced.raw, 19.2);
  assert.equal(advanced.best, 19.2);
  assert.equal(advanced.processingLevel, 'reviewed');

  // Unrevised point stays raw.
  const plain = point('obs-q-001');
  assert.equal(plain.best, plain.raw);
  assert.equal(plain.processingLevel, 'raw');
  assert.deepEqual(plain.flags, []);
});

test('missing readings stay missing: null frames and gaps are never zero', () => {
  const nullFrame = point('obs-q-010');
  assert.equal(nullFrame.raw, null);
  assert.equal(nullFrame.best, null);
  assert.ok(nullFrame.flags.includes('null-frame'));

  // The declared gap is six absent hours on 2026-03-08: no synthetic points.
  const series = observations.streamSeries('str-corinne-q');
  const inGap = series.filter((candidate) => {
    const at = Date.parse(candidate.observedAt);
    return at > Date.parse('2026-03-08T12:00:00Z') && at < Date.parse('2026-03-08T18:00:00Z');
  });
  assert.equal(inGap.length, 0, 'gap interval must not be back-filled');
  assert.equal(series.filter((candidate) => candidate.best === 0 || candidate.raw === 0).length, 1, 'only the reported suspect zero is zero');

  const gaps = observations.streamGaps('str-corinne-q');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.missingCount, 6);
  assert.equal(gaps[0]!.reason, 'source-outage');
});

test('the reported zero is a flagged suspect zero, not a measured zero', () => {
  const zero = point('obs-q-021');
  assert.equal(zero.raw, 0);
  assert.equal(zero.best, 0);
  assert.ok(zero.flags.includes('suspect-zero'));
});

test('duplicate timestamps keep both originals, ordered by receipt', () => {
  const series = observations.streamSeries('str-corinne-q');
  const duplicates = series.filter((candidate) => candidate.observedAt === '2026-03-07T10:00:00Z');
  assert.equal(duplicates.length, 2);
  assert.deepEqual(duplicates.map((candidate) => candidate.id), ['obs-q-016', 'obs-q-017']);
  for (const duplicate of duplicates) assert.ok(duplicate.flags.includes('duplicate-timestamp'));
});

test('series orders by observation instant, not receipt time', () => {
  const series = observations.streamSeries('str-corinne-q');
  const lateIndex = series.findIndex((candidate) => candidate.id === 'obs-q-005');
  const beforeIndex = series.findIndex((candidate) => candidate.id === 'obs-q-004');
  const afterIndex = series.findIndex((candidate) => candidate.id === 'obs-q-006');
  assert.ok(lateIndex > beforeIndex && lateIndex < afterIndex, 'late arrival lands on its observed instant');
  assert.ok(series[lateIndex]!.flags.includes('late-arrival'));
});

test('DST spring-forward is carried by sourceOffset', () => {
  const before = point('obs-q-038'); // last full MST hour
  const after = point('obs-q-039'); // first MDT hour
  assert.equal(before.sourceOffset, '-07:00');
  assert.equal(after.sourceOffset, '-06:00');
});

test('out-of-range and estimated values are labelled, not clipped', () => {
  const spike = point('obs-q-044');
  assert.equal(spike.raw, 9500);
  assert.equal(spike.best, 9500);
  assert.ok(spike.flags.includes('out-of-range'));

  const estimated = point('obs-q-042');
  assert.equal(estimated.raw, 23.5);
  assert.equal(estimated.best, 23.9);
  assert.equal(estimated.valueType, 'estimated');
  assert.ok(estimated.flags.includes('estimated'));
  assert.ok(estimated.flags.includes('revised'));
});

test('latest readings and freshness against the fixed fixture clock', () => {
  const latest = observations.latestReading(corinne)!;
  assert.equal(latest.value, 26.0);
  assert.equal(latest.observedAt, '2026-03-09T06:00:00Z');
  assert.equal(latest.unitId, 'cfs');
  assert.equal(observations.stationFreshness(corinne), 'current');

  // Summit Creek: inactive station, no observations at all.
  const summit = fixtures.stationById.get('sta-summit-creek-inactive')!;
  assert.equal(observations.latestReading(summit), null);
  assert.equal(observations.stationFreshness(summit), 'inactive');

  // Ogden Valley: proposed station with a discharge stream but no data.
  const ogden = fixtures.stationById.get('sta-ogden-valley-proposed')!;
  assert.equal(observations.stationFreshness(ogden), 'inactive');
  const diagnostic = fixtures.stationById.get('sta-bear-lake-diagnostic')!;
  assert.equal(observations.stationFreshness(diagnostic), 'no-data', 'no discharge stream means no data, not zero');

  // Corinne revisions expose actor and history for the QA view.
  const revisions = observations.stationRevisions(corinne);
  assert.equal(revisions.length, 4);
  assert.deepEqual(
    revisions.map((revision) => revision.id).sort(),
    ['rev-corinne-2001', 'rev-corinne-2002', 'rev-corinne-2003', 'rev-corinne-2004'],
  );
});

test('window selection bounds the chart to the trailing fixture window', () => {
  const week = observations.windowedPoints('str-corinne-q', 7);
  assert.ok(week.length > 0);
  for (const candidate of week) {
    assert.ok(Date.parse(candidate.observedAt) >= Date.parse(fixtures.FIXTURE_CLOCK) - 7 * 86400000);
    assert.ok(Date.parse(candidate.observedAt) <= Date.parse(fixtures.FIXTURE_CLOCK));
  }
  const fortnight = observations.windowedPoints('str-corinne-q', 14);
  assert.ok(fortnight.length >= week.length);
});
