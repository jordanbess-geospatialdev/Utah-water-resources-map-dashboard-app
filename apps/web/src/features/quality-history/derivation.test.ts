/**
 * Derivation tests for the FR-042 point/interval audit table model.
 *
 * Run (zero dependencies, same runner as apps/web/tests):
 *   cd apps/web && node --test --experimental-strip-types src/features/quality-history/derivation.test.ts
 *
 * The suite drives the PURE derivation with (a) the frozen contract fixtures
 * end to end - the two-corrections chain of obs-q-032 (rev-corinne-2001 then
 * rev-corinne-2004) with distinct reasons and qualifiers - and (b) synthetic
 * tombstone/supersession chains that exercise the FR-039 withdrawal
 * presentation the fixtures do not yet contain.
 *
 * (Import pattern per apps/web/tests/adapters.test.ts: computed specifiers
 * for node --test --experimental-strip-types, type-only imports for tsc.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { ChainRevision, IntervalSelector, QualityHistoryRow } from './derivation';

// Extensionless src imports under node --test (see tests/ts-resolve-hook.mjs).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const derivationPath = './derivation.ts';
const derivation: typeof import('./derivation') = await import(derivationPath);
const fixturesPath = '../../shell/data/fixtures.ts';
const fixtures: typeof import('../../shell/data/fixtures') = await import(fixturesPath);

const NAMES = {
  actorNames: {
    'principal-fatima-engineer': 'Fatima Al-Rashid',
    'principal-cody-commissioner': 'Cody Jensen',
    'principal-diego-steward': 'Diego Ruiz',
  },
  qualifierNames: {
    'ice-affected': 'Ice affected',
    interpolate: 'Interpolated',
  },
} as const;

function fixtureObservation(id: string) {
  const observation = fixtures.observations.find((candidate) => candidate.id === id);
  assert.ok(observation, `fixture observation ${id} present`);
  return observation;
}

// ---------------------------------------------------------------------------
// End to end over the contract fixtures: the two-corrections chain
// ---------------------------------------------------------------------------

test('fixture chain end to end: obs-q-032 correction then level-advance with distinct reasons and qualifiers', () => {
  const model = derivation.pointQualityHistory(fixtureObservation('obs-q-032'), fixtures.revisions, NAMES);
  assert.equal(model.kind, 'point');
  assert.equal(model.hasRevisions, true);
  assert.equal(model.rows.length, 2);

  const first = model.rows[0]!;
  assert.equal(first.revisionId, 'rev-corinne-2001');
  assert.equal(first.version, 1);
  assert.equal(first.type, 'correction');
  assert.equal(first.originalValue, -1.2); // the raw original is the "original value" of v1
  assert.equal(first.replacementValue, 20.9);
  assert.equal(first.processingLevel, 'provisional');
  assert.deepEqual([...first.qualifierNames], ['Ice affected']);
  assert.equal(first.actorName, 'Fatima Al-Rashid');
  assert.match(first.reason, /Negative spike/);

  const second = model.rows[1]!;
  assert.equal(second.revisionId, 'rev-corinne-2004');
  assert.equal(second.baseRevisionId, 'rev-corinne-2001');
  assert.equal(second.type, 'level-advance');
  assert.equal(second.originalValue, 20.9); // v1's value, not the raw -1.2
  assert.equal(second.replacementValue, 20.9);
  assert.equal(second.processingLevel, 'best-available');
  assert.match(second.reason, /best available/); // a DIFFERENT reason than v1
});

test('observation time and revision time stay separate fields end to end (FR-042)', () => {
  const model = derivation.pointQualityHistory(fixtureObservation('obs-q-032'), fixtures.revisions);
  const first = model.rows[0]!;
  assert.equal(first.observedAt, '2026-03-08T02:00:00Z'); // when the water was measured
  assert.equal(first.recordedAt, '2026-03-08T15:30:00Z'); // when the edit was recorded
  assert.notEqual(first.observedAt, first.recordedAt);
  // The raw provenance keeps both clock meanings of the ORIGINAL row too.
  assert.equal(model.provenance.observedAt, '2026-03-08T02:00:00Z');
  assert.equal(model.provenance.sourceOffset, '-07:00');
  assert.equal(model.provenance.receivedAt, '2026-03-08T02:00:48Z');
});

test('superseded revision remains in the model and is marked, latest is current', () => {
  const model = derivation.pointQualityHistory(fixtureObservation('obs-q-032'), fixtures.revisions);
  const [first, second] = model.rows as [QualityHistoryRow, QualityHistoryRow];
  assert.equal(first.status, 'superseded'); // FR-042: included, not hidden
  assert.equal(first.supersededByRevisionId, 'rev-corinne-2004');
  assert.equal(first.supersededByVersion, 2);
  assert.equal(first.statusText, 'Superseded by v2');
  assert.equal(first.statusMarker, '○');
  assert.equal(second.status, 'current');
  assert.equal(second.statusText, 'Current');
  assert.equal(second.statusMarker, '●');
  assert.equal(second.supersededByRevisionId, null);
});

test('unrevised point derives a raw-only provenance model (empty state)', () => {
  const model = derivation.pointQualityHistory(fixtureObservation('obs-q-044'), fixtures.revisions);
  assert.equal(model.hasRevisions, false);
  assert.deepEqual(model.rows, []);
  // Raw-only provenance: value, unit, source event and note of the original.
  assert.equal(model.provenance.value, 9500);
  assert.equal(model.provenance.unitId, 'cfs');
  assert.equal(model.provenance.sourceEventId, 'ev-corinne-q-20260308T2000Z');
  assert.equal(model.provenance.sourceId, 'src-corinne-logger-02');
  assert.match(model.provenance.note ?? '', /Out-of-range spike/);
});

test('chain order follows recorded time regardless of input order', () => {
  const reversed = [...fixtures.revisions].reverse();
  const model = derivation.pointQualityHistory(fixtureObservation('obs-q-032'), reversed);
  assert.deepEqual(
    model.rows.map((row) => row.revisionId),
    ['rev-corinne-2001', 'rev-corinne-2004'],
  );
});

test('name tables resolve display names; ids are the fallback', () => {
  const withNames = derivation.pointQualityHistory(fixtureObservation('obs-q-032'), fixtures.revisions, NAMES);
  assert.equal(withNames.rows[0]!.actorName, 'Fatima Al-Rashid');
  const bare = derivation.pointQualityHistory(fixtureObservation('obs-q-032'), fixtures.revisions);
  assert.equal(bare.rows[0]!.actorName, 'principal-fatima-engineer');
  assert.deepEqual([...bare.rows[0]!.qualifierNames], ['ice-affected']);
});

// ---------------------------------------------------------------------------
// Tombstone presentation (FR-039) - synthetic exclusion chains
// ---------------------------------------------------------------------------

const WITHDRAWN_AT = '2026-03-10T14:00:00Z';

function withdrawalOver(observationId: string): ChainRevision {
  return {
    id: 'rev-synth-withdraw-044',
    targetObservationId: observationId,
    baseRevisionId: null,
    type: 'exclusion',
    value: null,
    unitId: 'cfs',
    processingLevel: 'best-available',
    qualifierIds: [],
    reason: 'Physically impossible spike; withdrawn per the outage review.',
    actorId: 'principal-diego-steward',
    recordedAt: WITHDRAWN_AT,
    retainedOriginal: {
      value: 9500,
      unitId: 'cfs',
      observedAt: '2026-03-08T20:00:00Z',
      sourceOffset: '-06:00',
      sourceEventId: 'ev-corinne-q-20260308T2000Z',
      sourceId: 'src-corinne-logger-02',
      receivedAt: '2026-03-08T20:00:52Z',
    },
  };
}

test('tombstone row shows the withdrawal and the retained original evidence', () => {
  const model = derivation.pointQualityHistory(fixtureObservation('obs-q-044'), [withdrawalOver('obs-q-044')], NAMES);
  assert.equal(model.hasRevisions, true);
  const row = model.rows[0]!;
  assert.equal(row.isTombstone, true);
  assert.equal(row.type, 'exclusion');
  assert.equal(row.replacementValue, null); // nothing asserted: the point is withdrawn
  assert.equal(row.retainedOriginal?.value, 9500); // the original is retained, not destroyed
  assert.equal(row.retainedOriginal?.sourceEventId, 'ev-corinne-q-20260308T2000Z');
  assert.equal(row.status, 'current');
  assert.equal(row.statusText, 'Withdrawn — current');
  assert.equal(row.statusMarker, '✕');
  assert.match(derivation.formatChange(row), /9500 cfs → withdrawn/);
  assert.match(derivation.formatChange(row), /original 9500 cfs retained/);
});

test('a tombstone is an ordinary chain head: a later correction supersedes it', () => {
  const tombstone = withdrawalOver('obs-q-044');
  const rebased: ChainRevision = {
    id: 'rev-synth-rebased-044',
    targetObservationId: 'obs-q-044',
    baseRevisionId: tombstone.id,
    type: 'correction',
    value: 24.1,
    unitId: 'cfs',
    processingLevel: 'best-available',
    qualifierIds: ['interpolate'],
    reason: 'Spike replaced by the field-checked value after withdrawal.',
    actorId: 'principal-fatima-engineer',
    recordedAt: '2026-03-11T09:00:00Z',
  };
  const model = derivation.pointQualityHistory(fixtureObservation('obs-q-044'), [rebased, tombstone], NAMES);
  const [withdrawn, restored] = model.rows as [QualityHistoryRow, QualityHistoryRow];
  assert.equal(withdrawn.status, 'superseded');
  assert.equal(withdrawn.statusText, 'Withdrawn — superseded by v2');
  assert.equal(restored.status, 'current');
  assert.equal(restored.originalValue, null); // the withdrawn head asserted no value
  assert.equal(restored.replacementValue, 24.1);
  assert.equal(restored.baseRevisionId, 'rev-synth-withdraw-044');
  assert.match(derivation.formatChange(restored), /no value → 24\.1 cfs/);
});

// ---------------------------------------------------------------------------
// Interval audit (flagged intervals, half-open bounds)
// ---------------------------------------------------------------------------

test('interval audit covers a flagged window with superseded revisions included', () => {
  const model = derivation.intervalQualityHistory(fixtures.observations, fixtures.revisions, {
    streamId: 'str-corinne-q',
    start: '2026-03-08T00:00:00Z',
    end: '2026-03-09T00:00:00Z',
  });
  assert.equal(model.kind, 'interval');
  assert.equal(model.revisedPointCount, 2); // obs-q-032 and obs-q-042
  assert.deepEqual(
    model.rows.map((row) => row.revisionId),
    ['rev-corinne-2001', 'rev-corinne-2004', 'rev-corinne-2002'],
  );
  // rev-corinne-2003 targets 2026-03-07T12:00Z: outside the window.
  assert.ok(model.rows.every((row) => row.observedAt >= '2026-03-08T00:00:00Z' && row.observedAt < '2026-03-09T00:00:00Z'));
  // Rows carry their own observation time (points differ within the interval).
  assert.equal(model.rows[0]!.observedAt, '2026-03-08T02:00:00Z');
  assert.equal(model.rows[2]!.observedAt, '2026-03-08T18:00:00Z');
});

test('interval bounds are half-open [start, end) on observation time', () => {
  const window: IntervalSelector = {
    streamId: 'str-corinne-q',
    start: '2026-03-08T02:00:00Z', // exactly obs-q-032's instant: included
    end: '2026-03-08T18:00:00Z', // exactly obs-q-042's instant: excluded
  };
  const model = derivation.intervalQualityHistory(fixtures.observations, fixtures.revisions, window);
  assert.deepEqual(
    model.rows.map((row) => row.revisionId),
    ['rev-corinne-2001', 'rev-corinne-2004'],
  );
  assert.equal(model.revisedPointCount, 1);
});

test('interval audit of an unrevised window is empty, not zero-filled', () => {
  const model = derivation.intervalQualityHistory(fixtures.observations, fixtures.revisions, {
    streamId: 'str-corinne-stage',
    start: '2026-03-07T00:00:00Z',
    end: '2026-03-09T00:00:00Z',
  });
  assert.equal(model.revisedPointCount, 0);
  assert.deepEqual(model.rows, []);
});

// ---------------------------------------------------------------------------
// Selectable targets and status vocabulary
// ---------------------------------------------------------------------------

test('point audit targets flag revised and suspect points of the stream', () => {
  const targets = derivation.pointAuditTargets(fixtures.observations, fixtures.revisions, 'str-corinne-q', {
    min: 0,
    max: 1200,
  });
  const byId = new Map(targets.map((target) => [target.observation.id, target]));
  assert.equal(byId.get('obs-q-032')?.revisionCount, 2);
  assert.ok(byId.get('obs-q-032')?.flags.includes('revised'));
  assert.ok(byId.get('obs-q-032')?.flags.includes('negative'));
  assert.ok(byId.get('obs-q-044')?.flags.includes('out-of-range'));
  assert.ok(byId.get('obs-q-044')?.flags.includes('revised') === false); // unrevised in the fixtures
  assert.ok(byId.get('obs-q-010')?.flags.includes('null-frame'));
  assert.ok(byId.get('obs-q-021')?.flags.includes('suspect-zero'));
  assert.ok(byId.get('obs-q-042')?.flags.includes('estimated'));
  // Ordinary clean points are not offered as audit targets.
  assert.equal(byId.has('obs-q-001'), false);
});

test('every row carries a text status and a shape marker, never color alone', () => {
  const markers = new Set(['●', '○', '✕']);
  const point = derivation.pointQualityHistory(fixtureObservation('obs-q-032'), fixtures.revisions);
  const interval = derivation.intervalQualityHistory(fixtures.observations, fixtures.revisions, {
    streamId: 'str-corinne-q',
    start: '2026-03-08T00:00:00Z',
    end: '2026-03-09T00:00:00Z',
  });
  const tombstone = derivation.pointQualityHistory(fixtureObservation('obs-q-044'), [withdrawalOver('obs-q-044')]);
  for (const row of [...point.rows, ...interval.rows, ...tombstone.rows]) {
    assert.ok(markers.has(row.statusMarker), `marker ${row.statusMarker} is from the fixed set`);
    assert.ok(row.statusText.length > 0, 'status text is always present');
    assert.match(row.statusText, /^(Current|Superseded by v\d+|Withdrawn)/);
  }
});
