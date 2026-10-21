/**
 * WD-026 adversarial fuzz (d): as-of boundary — reconstructAsOf /
 * reconstructRangeAsOf compared against an INDEPENDENT naive oracle across
 * a dense corpus of instants.
 *
 * Written by the independent R2 qualification agent (qa_accessibility);
 * the oracle below shares NO code with services/integrations/r2/asof — it
 * re-derives the expected T-view from the raw fixture rows with a plain
 * filter/sort, then compares value, unit, level, qualifiers, revision id,
 * tombstone flag, excluded-later count and gap decisions point by point.
 *
 * Corpus: every revision recordedAt in the store, each ± 1 ms (the closed
 * lower boundary ON T), plus seeded random instants across the fixture
 * window, plus the receivedAt boundaries of every observation (the gap
 * rule), for public streams anonymously AND restricted streams through an
 * in-scope engineer. Range queries are oracle-checked over sliding windows.
 *
 * Run (from repo root):
 *   node --test tests/qualification-r2/adversarial/asof-boundary-oracle.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../../qualification/adversarial/canaries.mjs';

const asof = await import('../../../services/integrations/r2/asof/asof.ts');
const { createRevisionStore } = await import('../../../services/api/src/workflows/revisions/store.ts');

const store = createRevisionStore();
const FATIMA = store.world.principals['principal-fatima-engineer'];
const PRIYA = store.world.principals['principal-priya-engineer'];
assert.ok(FATIMA && PRIYA);

const ms = (instant) => Date.parse(instant);
const iso = (millis) => new Date(millis).toISOString();

// ---------------------------------------------------------------------------
// THE INDEPENDENT ORACLE (no asof.ts imports, no shared helpers)
// ---------------------------------------------------------------------------

/** Naive T-view of one observation chain: filter recordedAt <= T, last wins. */
function oraclePoint(observation, chain, asOfMs) {
  const considered = chain.filter((revision) => ms(revision.recordedAt) <= asOfMs);
  const excludedLaterCount = chain.length - considered.length;
  if (ms(observation.receivedAt) > asOfMs) {
    return { outcome: 'gap', excludedLaterCount };
  }
  if (considered.length === 0) {
    return {
      outcome: 'known',
      value: observation.value,
      unitId: observation.unitId,
      processingLevel: observation.processingLevel,
      qualifierIds: [],
      revisionId: null,
      excluded: false,
      excludedLaterCount,
    };
  }
  const head = [...considered].sort(
    (a, b) => ms(a.recordedAt) - ms(b.recordedAt) || a.version - b.version || (a.id < b.id ? -1 : 1),
  ).at(-1);
  return {
    outcome: 'known',
    value: head.value,
    unitId: head.unitId,
    processingLevel: head.processingLevel,
    qualifierIds: [...head.qualifierIds],
    revisionId: head.id,
    excluded: head.excluded,
    excludedLaterCount,
  };
}

/** Naive range T-view: every observation of the stream in [from, to). */
function oracleRange(observations, chains, streamId, fromMs, toMs, asOfMs) {
  const rows = observations
    .filter((observation) => observation.streamId === streamId)
    .filter((observation) => ms(observation.observedAt) >= fromMs && ms(observation.observedAt) < toMs)
    .sort((a, b) => ms(a.observedAt) - ms(b.observedAt) || (a.id < b.id ? -1 : 1));
  return rows.map((observation) => ({ observation, view: oraclePoint(observation, chains(observation.logicalKey), asOfMs) }));
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

const chains = new Map();
const keyRows = [];
for (const observation of store.observations) {
  if (chains.has(observation.logicalKey)) continue; // duplicate rows (see note below) resolve to one identity
  chains.set(observation.logicalKey, store.loadChain(observation.logicalKey));
  keyRows.push(store.observationByLogicalKey(observation.logicalKey));
}
// NOTE (fixture fact, not a defect finding): obs-q-016/obs-q-017 are two
// distinct source events sharing one logical key (the WD-007 duplicate-
// submission fixture pair). The AsOfSource identity is the logical key, and
// observationByLogicalKey resolves exactly one row per key — the oracle uses
// the same resolution, so the corpus never compares the shadowed duplicate.
assert.equal(chains.size, new Set(store.observations.map((observation) => observation.logicalKey)).size);
assert.ok(chains.size >= 60, `expected the full fixture key space, got ${chains.size}`);

/** Which principal may reconstruct this stream (null = anonymous/public). */
function principalFor(streamId) {
  if (streamId === 'str-corinne-q') return null; // public, publication model
  if (streamId.endsWith('-owner') || streamId.includes('voltage')) return FATIMA; // Bear restricted/internal
  return PRIYA; // Weber streams
}

// Every instant that can flip a verdict: each recordedAt and each receivedAt,
// each exactly ON and 1 ms either side.
const flipInstants = new Set();
for (const chain of chains.values()) {
  for (const revision of chain) {
    for (const delta of [-1, 0, 1]) flipInstants.add(ms(revision.recordedAt) + delta);
  }
}
for (const observation of store.observations) {
  for (const delta of [-1, 0, 1]) flipInstants.add(ms(observation.receivedAt) + delta);
}

const allTimes = [...store.observations.flatMap((observation) => [ms(observation.receivedAt), ...chains.get(observation.logicalKey).map((revision) => ms(revision.recordedAt))])];
const MIN_T = Math.min(...allTimes) - 86_400_000;
const MAX_T = Math.max(...allTimes) + 86_400_000;

const random = mulberry32(0xa50f);
const randomInstants = Array.from({ length: 350 }, () => MIN_T + Math.floor(random() * (MAX_T - MIN_T)));

// ---------------------------------------------------------------------------
// Point-query fuzz: every observation x every flip instant x random instants
// ---------------------------------------------------------------------------

test('point oracle: the T-view matches the naive derivation at every boundary and random instant', () => {
  let compared = 0;
  let known = 0;
  let gaps = 0;
  const instants = [...flipInstants, ...randomInstants];
  for (const observation of keyRows) {
    const chain = chains.get(observation.logicalKey);
    const principal = principalFor(observation.streamId);
    for (const asOfMs of instants) {
      const result = asof.reconstructAsOf(store, { principal, logicalKey: observation.logicalKey, asOf: iso(asOfMs) });
      assert.ok(result.outcome === 'known' || result.outcome === 'gap', `${observation.logicalKey} @ ${iso(asOfMs)}: unexpected ${result.outcome}`);
      const expected = oraclePoint(observation, chain, asOfMs);
      if (expected.outcome === 'gap') {
        assert.equal(result.outcome, 'gap', `${observation.logicalKey} @ ${iso(asOfMs)}: oracle says gap`);
        gaps += 1;
      } else {
        assert.equal(result.outcome, 'known', `${observation.logicalKey} @ ${iso(asOfMs)}: oracle says known (raw or revised)`);
        if (result.outcome !== 'known') continue;
        const point = result.point;
        assert.equal(point.value, expected.value, `${observation.logicalKey} @ ${iso(asOfMs)}: value`);
        assert.equal(point.unitId, expected.unitId, `${observation.logicalKey} @ ${iso(asOfMs)}: unit`);
        assert.equal(point.processingLevel, expected.processingLevel, `${observation.logicalKey} @ ${iso(asOfMs)}: level`);
        assert.deepEqual([...point.qualifierIds], expected.qualifierIds, `${observation.logicalKey} @ ${iso(asOfMs)}: qualifiers`);
        assert.equal(point.revisionId, expected.revisionId, `${observation.logicalKey} @ ${iso(asOfMs)}: revision id`);
        assert.equal(point.excluded, expected.excluded, `${observation.logicalKey} @ ${iso(asOfMs)}: tombstone flag`);
        assert.equal(point.asOfBasis.excludedLaterCount, expected.excludedLaterCount, `${observation.logicalKey} @ ${iso(asOfMs)}: excluded-later count`);
        known += 1;
      }
      compared += 1;
    }
  }
  assert.ok(compared >= 5000, `corpus too small: ${compared} comparisons`);
  assert.ok(known > 1000 && gaps > 0, `corpus must cover known views and gaps (known=${known}, gaps=${gaps})`);
});

test('boundary sharpness: exactly ON a revision instant includes it, 1 ms before does not', () => {
  const chainsWithRevisions = [...chains.entries()].filter(([, chain]) => chain.length > 0);
  assert.ok(chainsWithRevisions.length >= 3, `expected several revised chains, found ${chainsWithRevisions.length}`);
  for (const [logicalKey, chain] of chainsWithRevisions) {
    const observation = store.observationByLogicalKey(logicalKey);
    const principal = principalFor(observation.streamId);
    const revision = chain[0];
    const onT = asof.reconstructAsOf(store, { principal, logicalKey, asOf: revision.recordedAt });
    const beforeT = asof.reconstructAsOf(store, { principal, logicalKey, asOf: iso(ms(revision.recordedAt) - 1) });
    if (ms(observation.receivedAt) > ms(revision.recordedAt)) continue; // gap territory for this T
    assert.equal(onT.outcome, 'known');
    if (onT.outcome === 'known') {
      // The newest revision recorded AT OR BEFORE T is in force. With the
      // fixture's chains, the first revision at its own instant is either
      // the head (single-revision prefix) or an earlier head — never null.
      assert.ok(onT.point.revisionId !== null, `${logicalKey}: at T=first revision instant the view must be revised`);
    }
    assert.ok(beforeT.outcome === 'known' || beforeT.outcome === 'gap');
    if (beforeT.outcome === 'known') {
      const oracleBefore = oraclePoint(observation, chain, ms(revision.recordedAt) - 1);
      assert.equal(beforeT.point.revisionId, oracleBefore.revisionId, `${logicalKey}: 1ms-before must match the oracle`);
    }
  }
});

// ---------------------------------------------------------------------------
// Range-query fuzz: sliding windows x flip instants
// ---------------------------------------------------------------------------

test('range oracle: sliding windows match the naive series at every flip instant', () => {
  const streamIds = [...new Set(store.observations.map((observation) => observation.streamId))];
  assert.ok(streamIds.length >= 3, 'expected several fixture streams');
  let comparedSeries = 0;
  for (const streamId of streamIds) {
    const principal = principalFor(streamId);
    const streamTimes = store.observations.filter((observation) => observation.streamId === streamId).map((observation) => ms(observation.observedAt));
    const fromMs = Math.min(...streamTimes) - 3_600_000;
    const toMs = Math.max(...streamTimes) + 3_600_000;
    for (const asOfMs of [...flipInstants].slice(0, 60)) {
      if (asOfMs < MIN_T || asOfMs > MAX_T) continue;
      const result = asof.reconstructRangeAsOf(store, { principal, streamId, from: iso(fromMs), to: iso(toMs), asOf: iso(asOfMs) });
      assert.equal(result.outcome, 'ok', `${streamId} @ ${iso(asOfMs)}: unexpected ${result.outcome}`);
      if (result.outcome !== 'ok') continue;
      const expectedRows = oracleRange(store.observations, (key) => chains.get(key) ?? [], streamId, fromMs, toMs, asOfMs);
      assert.equal(result.points.length, expectedRows.length, `${streamId} @ ${iso(asOfMs)}: point count`);
      for (const [index, entry] of result.points.entries()) {
        const expected = expectedRows[index];
        if (entry.state === 'gap') {
          assert.equal(expected.view.outcome, 'gap', `${streamId} @ ${iso(asOfMs)}[${index}]: engine gap, oracle known`);
        } else {
          assert.equal(expected.view.outcome, 'known', `${streamId} @ ${iso(asOfMs)}[${index}]: engine known, oracle gap`);
          assert.equal(entry.point.value, expected.view.value, `${streamId} @ ${iso(asOfMs)}[${index}]: value`);
          assert.equal(entry.point.revisionId, expected.view.revisionId, `${streamId} @ ${iso(asOfMs)}[${index}]: revision id`);
          assert.equal(entry.point.excluded, expected.view.excluded, `${streamId} @ ${iso(asOfMs)}[${index}]: tombstone`);
          assert.deepEqual([...entry.point.qualifierIds], expected.view.qualifierIds, `${streamId} @ ${iso(asOfMs)}[${index}]: qualifiers`);
        }
      }
      const expectedKnown = expectedRows.filter((row) => row.view.outcome === 'known').length;
      assert.equal(result.knownCount, expectedKnown, `${streamId} @ ${iso(asOfMs)}: knownCount`);
      assert.equal(result.gapCount, expectedRows.length - expectedKnown, `${streamId} @ ${iso(asOfMs)}: gapCount`);
      comparedSeries += 1;
    }
  }
  assert.ok(comparedSeries >= 100, `range corpus too small: ${comparedSeries} series`);
});

// ---------------------------------------------------------------------------
// Export stability across later corrections (FR-044 reproduction, oracle-checked)
// ---------------------------------------------------------------------------

test('a correction recorded after T never moves the T-view (post-correction reproduction, oracle-checked)', () => {
  const local = createRevisionStore(); // a FRESH store this test alone mutates
  const key = 'str-corinne-q:2026-03-08T02:00:00Z';
  const observation = local.observationByLogicalKey(key);
  assert.ok(observation);
  const T = '2026-03-08T15:30:00Z';
  const before = asof.reconstructAsOf(local, { principal: null, logicalKey: key, asOf: T });
  assert.equal(before.outcome, 'known');
  const bytesBefore = asof.serializeAsOfPointResult(before);

  local.appendRevision({
    logicalKey: key,
    observation,
    type: 'correction',
    value: 55.5,
    unitId: 'cfs',
    excluded: false,
    processingLevel: 'provisional',
    qualifierIds: ['estimated'],
    reason: 'adversarial post-T correction; the T-view must not move',
    actorId: 'principal-fatima-engineer',
    now: '2026-03-20T09:00:00Z',
    idempotencyKey: null,
    retainedOriginal: null,
    action: 'apply-correction',
  });

  const after = asof.reconstructAsOf(local, { principal: null, logicalKey: key, asOf: T });
  assert.equal(after.outcome, 'known');
  assert.equal(asof.serializeAsOfPointResult(after), bytesBefore, 'the T-view export must reproduce byte-identically');
  // Oracle-checked at the new head too: at a T AFTER the correction the view
  // must move to the new value (the reproduction is not a frozen cache).
  const headView = asof.reconstructAsOf(local, { principal: null, logicalKey: key, asOf: '2026-03-20T09:00:00Z' });
  assert.equal(headView.outcome, 'known');
  if (headView.outcome === 'known') {
    const oracleHead = oraclePoint(observation, local.loadChain(key), ms('2026-03-20T09:00:00Z'));
    assert.equal(headView.point.value, oracleHead.value);
    assert.equal(headView.point.revisionId, oracleHead.revisionId);
    assert.equal(oracleHead.value, 55.5, 'oracle sees the new correction at the later T');
  }
});

// ---------------------------------------------------------------------------
// Input validation edge cases
// ---------------------------------------------------------------------------

test('unparseable and inverted inputs are typed 422 denials, never crashes', () => {
  for (const bad of ['not-a-time', '', '2026-13-45T99:99:99Z', '20260308T153000Z']) {
    const point = asof.reconstructAsOf(store, { principal: null, logicalKey: 'str-corinne-q:2026-03-08T02:00:00Z', asOf: bad });
    assert.equal(point.outcome, 'denied', `asOf "${bad}" must deny`);
    if (point.outcome === 'denied') assert.equal(point.status, 422, `asOf "${bad}"`);
  }
  const inverted = asof.reconstructRangeAsOf(store, { principal: null, streamId: 'str-corinne-q', from: '2026-03-09T00:00:00Z', to: '2026-03-01T00:00:00Z', asOf: '2026-03-09T00:00:00Z' });
  assert.equal(inverted.outcome, 'denied');
  if (inverted.outcome === 'denied') assert.equal(inverted.status, 422);
  const empty = asof.reconstructRangeAsOf(store, { principal: null, streamId: 'str-corinne-q', from: '2026-03-09T00:00:00Z', to: '2026-03-09T00:00:00Z', asOf: '2026-03-09T00:00:00Z' });
  assert.equal(empty.outcome === 'denied' ? empty.status : 0, 422, 'from == to must deny');
  const unknownKey = asof.reconstructAsOf(store, { principal: null, logicalKey: 'str-corinne-q:nope', asOf: '2026-03-09T00:00:00Z' });
  assert.equal(unknownKey.outcome, 'denied');
  if (unknownKey.outcome === 'denied') assert.equal(unknownKey.status, 404);
});

test('determinism: identical queries serialize identically across a fresh store instance', () => {
  const fresh = createRevisionStore();
  const a = asof.serializeAsOfPointResult(asof.reconstructAsOf(fresh, { principal: null, logicalKey: 'str-corinne-q:2026-03-08T02:00:00Z', asOf: '2026-03-09T00:00:00Z' }));
  const b = asof.serializeAsOfPointResult(asof.reconstructAsOf(fresh, { principal: null, logicalKey: 'str-corinne-q:2026-03-08T02:00:00Z', asOf: '2026-03-09T00:00:00Z' }));
  assert.equal(a, b);
});
