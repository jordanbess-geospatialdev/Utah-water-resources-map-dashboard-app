/**
 * FR-044 as-of reconstruction tests (WD-023-R2, T-06).
 *
 * Covers the ratified contract in docs/extensions/r2/R2-EXTENSIONS-SCOPE.md:
 *  - boundary instants: a revision recorded exactly AT T is included
 *    (closed lower bound on T); one millisecond earlier it is excluded,
 *    counted, and the T-view falls back to the raw original;
 *  - post-correction reproduction: appending a correction recorded after T
 *    leaves the serialized T-view BYTE-IDENTICAL (FR-044 "exports state the
 *    as-of basis and reproduce the fixture result after later corrections");
 *  - a range query assembling a T-view series with gaps where the
 *    observation was not yet received at T, raw originals where no revision
 *    existed by T, and revised values where one had;
 *  - determinism: identical inputs serialize identically (twice);
 *  - authorization via the policy engine evaluated as of T: a restricted
 *    stream is denied cross-scope (hidden-object 404) and to anonymous
 *    callers, while an in-scope engineer reconstructs it; an EMPTY range
 *    window on an existing non-public stream hides with the same 404 bytes
 *    as an unknown id (DEFECT-R2-1 parity; never an existence oracle).
 *
 * Run:
 *   node --test --experimental-strip-types services/integrations/r2/asof/test/asof.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRevisionStore } from '../../../../../services/api/src/workflows/revisions/store.ts';
import type { ObservationRow } from '../../../../../services/api/src/workflows/revisions/types.ts';
import {
  asOfBasisLabel,
  reconstructAsOf,
  reconstructRangeAsOf,
  serializeAsOfPointResult,
  serializeAsOfRangeResult,
  type AsOfPointResult,
  type AsOfRangeDecision,
  type AsOfSource,
} from '../asof.ts';

const store = createRevisionStore();
const source: AsOfSource = store;
const fatima = store.world.principals['principal-fatima-engineer'];
const priya = store.world.principals['principal-priya-engineer'];
assert.ok(fatima && priya, 'fixture principals must exist');

// Fixture facts this suite pins (fixtures/contracts/observations.json):
// obs-q-032 raw -1.2 cfs observed 2026-03-08T02:00:00Z (negative spike);
// rev-corinne-2001 corrects it to 20.9 (provisional, ice-affected) recorded
// 2026-03-08T15:30:00Z; rev-corinne-2004 level-advances to best-available
// recorded 2026-03-09T06:20:00Z.
const KEY_032 = 'str-corinne-q:2026-03-08T02:00:00Z';
const T_AT_2001 = '2026-03-08T15:30:00Z';
const T_1MS_BEFORE_2001 = '2026-03-08T15:29:59.999Z';

function known(result: AsOfPointResult): { value: number | null; revisionId: string | null; excludedLaterCount: number; level: string } {
  assert.equal(result.outcome, 'known', `expected a known T-view, got ${JSON.stringify(result)}`);
  if (result.outcome !== 'known') throw new Error('unreachable');
  return {
    value: result.point.value,
    revisionId: result.point.revisionId,
    excludedLaterCount: result.point.asOfBasis.excludedLaterCount,
    level: result.point.processingLevel,
  };
}

test('boundary ON T: the revision recorded exactly at T is included', () => {
  const result = reconstructAsOf(source, { principal: null, logicalKey: KEY_032, asOf: T_AT_2001 });
  const view = known(result);
  assert.equal(view.revisionId, 'rev-corinne-2001');
  assert.equal(view.value, 20.9);
  assert.equal(view.level, 'provisional');
  assert.equal(view.excludedLaterCount, 1, 'rev-corinne-2004 (recorded 2026-03-09T06:20) is later than T and excluded');
});

test('boundary one millisecond before T: the revision is excluded, counted, and the raw original shows', () => {
  const result = reconstructAsOf(source, { principal: null, logicalKey: KEY_032, asOf: T_1MS_BEFORE_2001 });
  const view = known(result);
  assert.equal(view.revisionId, null, 'no revision had been recorded yet');
  assert.equal(view.value, -1.2, 'the T-view is the raw original, negative spike included');
  assert.equal(view.level, 'raw');
  assert.equal(view.excludedLaterCount, 2, 'rev-corinne-2001 AND rev-corinne-2004 are both later than T');
});

test('later revisions on the chain are excluded and counted as T moves between them', () => {
  const between = reconstructAsOf(source, { principal: null, logicalKey: KEY_032, asOf: '2026-03-09T06:00:00Z' });
  const view = known(between);
  assert.equal(view.revisionId, 'rev-corinne-2001');
  assert.equal(view.excludedLaterCount, 1, 'rev-corinne-2004 (recorded 06:20) is excluded');
  const after = reconstructAsOf(source, { principal: null, logicalKey: KEY_032, asOf: '2026-03-09T06:20:00Z' });
  const afterView = known(after);
  assert.equal(afterView.revisionId, 'rev-corinne-2004');
  assert.equal(afterView.level, 'best-available');
  assert.equal(afterView.value, 20.9, 'level-advance restates the same value at a higher level');
});

test('observation time and revision time stay distinct fields on the T-view', () => {
  const result = reconstructAsOf(source, { principal: null, logicalKey: KEY_032, asOf: T_AT_2001 });
  assert.ok(result.outcome === 'known');
  assert.equal(result.point.observedAt, '2026-03-08T02:00:00Z', 'observation time passes through verbatim from the raw row');
  assert.equal(result.point.asOfBasis.asOf, '2026-03-08T15:30:00.000Z', 'the as-of instant itself is normalized');
  assert.equal(result.point.asOfBasis.latestConsideredRevisionId, 'rev-corinne-2001');
  const revision = store.loadChain(KEY_032).find((r) => r.id === 'rev-corinne-2001');
  assert.ok(revision);
  assert.equal(revision.recordedAt, '2026-03-08T15:30:00Z');
  assert.notEqual(result.point.observedAt, revision.recordedAt);
});

test('post-correction reproduction: a correction recorded after T leaves the export byte-identical', () => {
  // Fresh store: this test APPENDS a correction, and no other test may see it.
  const local = createRevisionStore();
  const before = reconstructAsOf(local, { principal: fatima, logicalKey: KEY_032, asOf: T_AT_2001 });
  assert.equal(before.outcome, 'known');
  if (before.outcome !== 'known') throw new Error('unreachable');
  const bytesBefore = serializeAsOfPointResult(before);
  assert.ok(bytesBefore.includes(asOfBasisLabel(before.point.asOfBasis)), 'export embeds the basis label');
  assert.equal(before.point.asOfBasis.excludedLaterCount, 1, 'only rev-corinne-2004 is later than T on the pristine chain');

  // Append a correction RECORDED AFTER T (the workflow's own transactional path).
  const observation: ObservationRow = local.observationByLogicalKey(KEY_032)!;
  local.appendRevision({
    logicalKey: KEY_032,
    observation,
    type: 'correction',
    value: 99.9,
    unitId: 'cfs',
    excluded: false,
    processingLevel: 'provisional',
    qualifierIds: ['estimated'],
    reason: 'Post-T correction appended by the reproduction test; the T-view must not move.',
    actorId: 'principal-fatima-engineer',
    now: '2026-03-10T09:00:00Z',
    idempotencyKey: null,
    retainedOriginal: null,
    action: 'apply-correction',
  });

  const after = reconstructAsOf(local, { principal: fatima, logicalKey: KEY_032, asOf: T_AT_2001 });
  const bytesAfter = serializeAsOfPointResult(after);
  assert.equal(bytesAfter, bytesBefore, 'the T-view export reproduces byte-identically after a later correction (FR-044)');
  // The live result still reports the newer state transparently: the basis
  // count grew, but the exported T-view (value, level, qualifiers, revision
  // id, basis label) did not move.
  const later = known(after);
  assert.equal(later.revisionId, 'rev-corinne-2001');
  assert.equal(later.value, 20.9);
  assert.equal(later.excludedLaterCount, 2, 'rev-corinne-2004 and the appended correction are both excluded at T');
  assert.equal(asOfBasisLabel(before.point.asOfBasis), asOfBasisLabel(after.outcome === 'known' ? after.point.asOfBasis : before.point.asOfBasis));
});

test('range query: T-view series with gaps, raw originals and revised points, plus the aggregate basis', () => {
  const decision: AsOfRangeDecision = reconstructRangeAsOf(source, {
    principal: null,
    streamId: 'str-corinne-q',
    from: '2026-03-08T00:00:00Z',
    to: '2026-03-09T00:00:00Z',
    asOf: T_AT_2001,
  });
  assert.equal(decision.outcome, 'ok');
  if (decision.outcome !== 'ok') throw new Error('unreachable');
  assert.ok(decision.points.length > 0, 'fixture window has hourly observations');

  const revised = decision.points.find((p) => p.state === 'known' && p.point.revisionId === 'rev-corinne-2001');
  assert.ok(revised && revised.state === 'known', 'obs-q-032 appears revised at T');
  assert.equal(revised.point.value, 20.9);

  const raw = decision.points.find((p) => p.state === 'known' && p.point.revisionId === null);
  assert.ok(raw, 'points with no revision by T show their raw original');
  if (raw.state === 'known') assert.equal(raw.point.processingLevel, 'raw');

  // Hourly rows observed after 15:30 were received after T: gaps in the T-view.
  const gaps = decision.points.filter((p) => p.state === 'gap');
  assert.ok(gaps.length > 0, 'observations not yet received at T are gaps');
  for (const gap of gaps) {
    assert.equal(gap.reason, 'observation-not-yet-received');
    assert.ok(Date.parse(gap.observedAt) > Date.parse(T_AT_2001));
  }
  assert.equal(decision.knownCount + decision.gapCount, decision.points.length);
  assert.equal(decision.asOfBasis.asOf, '2026-03-08T15:30:00.000Z');
  assert.equal(decision.asOfBasis.latestConsideredRevisionId, 'rev-corinne-2001');
  assert.equal(decision.asOfBasis.excludedLaterCount, 1, 'only obs-q-032 carries a chain; every other known point is raw at T');

  const bytes = serializeAsOfRangeResult(decision);
  assert.ok(bytes.includes('as-of:2026-03-08T15:30:00.000Z | basis:rev-corinne-2001'), 'range export embeds the basis label');
  assert.ok(!bytes.includes('excludedLaterCount'), 'the volatile later-revision count stays out of the byte-stable export');
});

test('determinism: identical inputs serialize byte-identically (twice)', () => {
  const query = { principal: fatima, logicalKey: KEY_032, asOf: '2026-03-09T00:00:00Z' } as const;
  const one = serializeAsOfPointResult(reconstructAsOf(source, query));
  const two = serializeAsOfPointResult(reconstructAsOf(source, query));
  assert.equal(one, two);
  const rangeQuery = { principal: fatima, streamId: 'str-corinne-q', from: '2026-03-08T00:00:00Z', to: '2026-03-09T00:00:00Z', asOf: '2026-03-09T00:00:00Z' } as const;
  assert.equal(serializeAsOfRangeResult(reconstructRangeAsOf(source, rangeQuery)), serializeAsOfRangeResult(reconstructRangeAsOf(source, rangeQuery)));
});

test('authorization: restricted stream as-of is denied anonymous and cross-scope, allowed in scope', () => {
  const restricted = store.observations.find((o) => o.streamId === 'str-hyrum-q-owner')!;
  assert.ok(restricted, 'restricted fixture stream has observations');

  const anonymous = reconstructAsOf(source, { principal: null, logicalKey: restricted.logicalKey, asOf: '2026-03-08T00:00:00Z' });
  assert.equal(anonymous.outcome, 'denied');
  if (anonymous.outcome === 'denied') {
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.code, 'UNAUTHENTICATED');
  }

  // Priya is scoped to sys-weber-river; the restricted Bear-River owner
  // stream stays HIDDEN (404, never a 403 that confirms existence).
  const crossScope = reconstructAsOf(source, { principal: priya, logicalKey: restricted.logicalKey, asOf: '2026-03-08T00:00:00Z' });
  assert.equal(crossScope.outcome, 'denied');
  if (crossScope.outcome === 'denied') {
    assert.equal(crossScope.status, 404);
    assert.equal(crossScope.code, 'NOT_FOUND');
    assert.equal(crossScope.policyReason, 'DENY_OUT_OF_SCOPE');
  }

  // The same restricted stream reconstructs for the in-scope Bear-River engineer.
  const inScope = reconstructAsOf(source, { principal: fatima, logicalKey: restricted.logicalKey, asOf: '2026-03-08T00:00:00Z' });
  assert.equal(inScope.outcome, 'known');
  if (inScope.outcome === 'known') {
    assert.equal(inScope.point.streamId, 'str-hyrum-q-owner');
    assert.equal(inScope.point.value, restricted.value);
  }

  // Range reconstruction of the restricted stream denies cross-scope too.
  const crossRange = reconstructRangeAsOf(source, { principal: priya, streamId: 'str-hyrum-q-owner', from: '2026-03-04T00:00:00Z', to: '2026-03-09T00:00:00Z', asOf: '2026-03-08T00:00:00Z' });
  assert.equal(crossRange.outcome, 'denied');
  if (crossRange.outcome === 'denied') assert.equal(crossRange.status, 404);
});

test('public stream answers anonymous as-of via the public read branch', () => {
  const result = reconstructAsOf(source, { principal: null, logicalKey: 'str-corinne-q:2026-03-06T18:00:00Z', asOf: '2026-03-07T00:00:00Z' });
  assert.equal(result.outcome, 'known');
});

test('DEFECT-R2-1 regression: empty-window range on an existing non-public stream is the SAME hidden 404 as an unknown id', () => {
  // str-ogden-q-proposed exists (restricted, Weber system) but carries NO
  // observations, so every window is empty - previously the empty window
  // skipped authorization entirely and answered ok, echoing the stream id
  // while an unknown id denied: an existence oracle. Anonymous and
  // out-of-scope actors must now get the IDENTICAL denial bytes.
  const probed = 'str-ogden-q-proposed';
  assert.ok(store.world.objects[probed], 'precondition: the probed stream exists in the policy world');
  assert.ok(!store.observations.some((observation) => observation.streamId === probed), 'precondition: the stream has no observations');
  const window = { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z', asOf: '2026-03-09T00:00:00Z' } as const;

  for (const principal of [null, fatima] as const) {
    // Fatima is scoped to sys-bear-river: out of scope for the Weber stream.
    const label = principal ? 'out-of-scope engineer' : 'anonymous';
    const existing = reconstructRangeAsOf(source, { principal, streamId: probed, ...window });
    assert.equal(existing.outcome, 'denied', `${label}: an existing unreadable stream must deny, not answer ok`);
    if (existing.outcome === 'denied') {
      assert.equal(existing.status, 404, `${label}: the hidden-object 404`);
      assert.equal(existing.code, 'NOT_FOUND');
    }
    const unknown = reconstructRangeAsOf(source, { principal, streamId: 'str-does-not-exist', ...window });
    assert.equal(unknown.outcome, 'denied');
    assert.equal(
      serializeAsOfRangeResult(existing),
      serializeAsOfRangeResult(unknown),
      `${label}: existing-but-unreadable and unknown must be byte-indistinguishable`,
    );
  }

  // The same parity holds for a restricted stream WITH observations probed
  // through a window slice that contains none of them.
  const emptySlice = reconstructRangeAsOf(source, {
    principal: priya, // Weber engineer: out of scope for the Bear-River owner stream
    streamId: 'str-hyrum-q-owner',
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-02T00:00:00Z',
    asOf: '2026-03-08T00:00:00Z',
  });
  assert.equal(emptySlice.outcome, 'denied');
  if (emptySlice.outcome === 'denied') assert.equal(emptySlice.status, 404);
});

test('DEFECT-R2-1 regression: empty windows still answer ok for actors who may read the stream', () => {
  // In-scope engineer on the observation-less restricted stream: ok, zero points.
  const inScope = reconstructRangeAsOf(source, {
    principal: priya, // Weber-River engineer: in scope for str-ogden-q-proposed
    streamId: 'str-ogden-q-proposed',
    from: '2026-01-01T00:00:00Z',
    to: '2027-01-01T00:00:00Z',
    asOf: '2026-03-09T00:00:00Z',
  });
  assert.equal(inScope.outcome, 'ok');
  if (inScope.outcome === 'ok') {
    assert.equal(inScope.points.length, 0);
    assert.equal(inScope.knownCount, 0);
    assert.equal(inScope.gapCount, 0);
  }

  // In-scope engineer on a restricted stream through an EMPTY slice: still ok.
  const ownerEmpty = reconstructRangeAsOf(source, {
    principal: fatima, // Bear-River engineer: in scope for the owner stream
    streamId: 'str-hyrum-q-owner',
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-02T00:00:00Z',
    asOf: '2026-03-08T00:00:00Z',
  });
  assert.equal(ownerEmpty.outcome, 'ok');
  if (ownerEmpty.outcome === 'ok') assert.equal(ownerEmpty.points.length, 0);

  // Public stream, anonymous, empty window: the public read branch answers.
  const publicEmpty = reconstructRangeAsOf(source, {
    principal: null,
    streamId: 'str-corinne-q',
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-02T00:00:00Z',
    asOf: '2026-03-08T00:00:00Z',
  });
  assert.equal(publicEmpty.outcome, 'ok');
  if (publicEmpty.outcome === 'ok') assert.equal(publicEmpty.points.length, 0);
});

test('input validation: unparseable instants and unknown keys are 422/404, never a throw', () => {
  const bad = reconstructAsOf(source, { principal: fatima, logicalKey: KEY_032, asOf: 'not-an-instant' });
  assert.equal(bad.outcome, 'denied');
  if (bad.outcome === 'denied') assert.equal(bad.status, 422);
  const missing = reconstructAsOf(source, { principal: fatima, logicalKey: 'str-none:2026-01-01T00:00:00Z', asOf: '2026-03-08T00:00:00Z' });
  assert.equal(missing.outcome, 'denied');
  if (missing.outcome === 'denied') assert.equal(missing.status, 404);
  const inverted = reconstructRangeAsOf(source, { principal: fatima, streamId: 'str-corinne-q', from: '2026-03-09T00:00:00Z', to: '2026-03-08T00:00:00Z', asOf: '2026-03-09T00:00:00Z' });
  assert.equal(inverted.outcome, 'denied');
  if (inverted.outcome === 'denied') assert.equal(inverted.code, 'VALIDATION_FAILED');
});
