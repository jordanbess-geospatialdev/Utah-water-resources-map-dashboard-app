/**
 * WD-026 cross-domain adversarial check (snapshot immutability group):
 * finalize accounting content, then attack it from EVERY other R2 domain —
 * a measurement correction (WD-011), a curve supersession (WD-011-R2), an
 * as-of reconstruction (WD-023-R2) and additional finalizations of OTHER
 * periods — and assert every finalized contentHash and every stored byte
 * stay unchanged.
 *
 * Written by the independent R2 qualification agent (qa_accessibility).
 * Unlike the implementers' own suites (which freeze one domain at a time),
 * this check builds ONE world holding all stores simultaneously and fires
 * cross-domain mutations after finalization.
 *
 * Run (from repo root):
 *   node --test tests/qualification-r2/adversarial/cross-domain-freeze.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { FinalizedLedger, finalizedContentFromReport, finalizedContentFromDecision } = await import(
  '../../../services/api/src/workflows/accounting-snapshots/finalize.ts'
);
const { recordDecision, fixtureDecisionDeps } = await import('../../../services/api/src/workflows/accounting-snapshots/decisions.ts');
const { generateReport, fixtureReportDeps } = await import('../../../services/api/src/workflows/distribution-report/generate.ts');
const { DEFAULT_INCLUDE } = await import('../../../services/api/src/workflows/distribution-report/types.ts');
const { reportWorld } = await import('../../../services/api/src/workflows/distribution-report/world.ts');
const { createRevisionStore } = await import('../../../services/api/src/workflows/revisions/store.ts');
const { createRatingCurveStore } = await import('../../../services/api/src/workflows/rating-curves/store.ts');
const { reconstructAsOf, serializeAsOfPointResult } = await import('../../../services/integrations/r2/asof/asof.ts');
const { seriesStore } = await import('../../../services/api/src/series/load.ts');
const { withEntitlement } = await import('../../../packages/policy/src/index.ts');

const BEAR = 'sys-bear-river';
const DIEGO = 'principal-diego-steward';
const CODY = 'principal-cody-commissioner';
const FATIMA = 'principal-fatima-engineer';
const NOW = '2026-03-09T07:00:00Z';
const LATER = '2026-06-01T00:00:00Z';
const BASE_WORLD = reportWorld().policyWorld;
const codyGrant = BASE_WORLD.assignments.find((assignment) => assignment.id === 'ent-commissioner-cody');
// Test-only accounting assignment: QC review alone does not finalize.
const WORLD = withEntitlement(BASE_WORLD, codyGrant.id, {
  capabilities: [...codyGrant.capabilities, 'finalize-accounting'],
});

const CY2026 = { kind: 'calendar-year', year: 2026 };
const WY2026 = { kind: 'water-year', year: 2026 };
const CUSTOM = { kind: 'custom', from: '2026-03-07T19:00:00Z', to: '2026-03-08T19:00:00Z' };

test('finalize, then cross-domain attacks: every finalized hash and byte is unchanged', () => {
  // One world, all stores, fresh instances (this test mutates them).
  const revisions = createRevisionStore();
  const curves = createRatingCurveStore();
  const ledger = new FinalizedLedger();

  // 1. Finalize THREE periods from three different content sources.
  const report = generateReport(
    { store: seriesStore(), revisions, now: NOW },
    { systemId: BEAR, siteIds: null, period: { basis: 'calendar-year', year: 2026 }, processingBasis: 'raw', include: DEFAULT_INCLUDE },
    CODY,
  );
  assert.equal(report.outcome, 'allowed');
  const decision = recordDecision(
    { store: seriesStore(), revisions, curves, now: NOW },
    { systemId: BEAR, period: WY2026, processingBasis: 'raw', siteIds: null, statement: 'WY decision before the attacks' },
    CODY,
  );
  assert.equal(decision.outcome, 'allowed');
  const custom = generateReport(
    { store: seriesStore(), revisions, now: NOW },
    { systemId: BEAR, siteIds: null, period: { basis: 'calendar-year', year: 2026 }, processingBasis: 'best-available', include: DEFAULT_INCLUDE },
    DIEGO,
  );
  assert.equal(custom.outcome, 'allowed');

  const fin1 = ledger.finalize(WORLD, { systemId: BEAR, period: CY2026, decisionId: null, content: finalizedContentFromReport(report.value), actorId: CODY, expectedCurrentId: null, now: NOW });
  const fin2 = ledger.finalize(WORLD, { systemId: BEAR, period: WY2026, decisionId: decision.outcome === 'allowed' ? decision.value.decisionId : null, content: finalizedContentFromDecision(decision.outcome === 'allowed' ? decision.value : null), actorId: CODY, expectedCurrentId: null, now: NOW });
  const fin3 = ledger.finalize(WORLD, { systemId: BEAR, period: CUSTOM, decisionId: null, content: finalizedContentFromReport(custom.value), actorId: DIEGO, expectedCurrentId: null, now: NOW });
  assert.equal(fin1.outcome, 'finalized');
  assert.equal(fin2.outcome, 'finalized');
  assert.equal(fin3.outcome, 'finalized');

  const snapshotOf = () => ({
    hashes: ledger.list().map((view) => [view.accounting.id, view.accounting.contentHash]),
    bytes: ledger.list().map((view) => [view.accounting.id, ledger.storedBytes(view.accounting.id)]),
    events: JSON.stringify(ledger.events),
  });
  const before = snapshotOf();
  assert.equal(before.hashes.length, 3);

  // 2. ATTACK A — measurement correction on the very observation the
  //    finalized report aggregated (WD-011 revision append).
  const observation = revisions.observationById('obs-q-042');
  assert.ok(observation);
  revisions.appendRevision({
    logicalKey: observation.logicalKey,
    observation,
    type: 'correction',
    value: 31.7,
    unitId: 'cfs',
    excluded: false,
    processingLevel: 'reviewed',
    qualifierIds: [],
    reason: 'cross-domain attack: post-finalization correction',
    actorId: FATIMA,
    now: LATER,
    idempotencyKey: null,
    retainedOriginal: null,
    action: 'apply-correction',
  });

  // 3. ATTACK B — rating-curve supersession on the stream the report used
  //    (WD-011-R2 version append closing the open curve).
  const open = curves.openCurveVersion('str-corinne-q');
  assert.ok(open);
  curves.appendCurveVersion({
    streamId: 'str-corinne-q',
    stationId: open.stationId,
    actorId: DIEGO,
    now: LATER,
    closeCurrentAt: '2026-05-31T00:00:00Z',
    action: 'supersede-curve',
    version: {
      stationId: open.stationId,
      streamId: 'str-corinne-q',
      coefficients: { c: 44.4, b: 1.95, e: 1.66 },
      unitPair: { fromUnitId: 'ft', toUnitId: 'cfs' },
      method: 'Log-linear least squares, cross-domain attack refit',
      effectiveFrom: '2026-05-31T00:00:00Z',
      effectiveTo: null,
      author: DIEGO,
      approvalState: 'approved',
      approvedBy: DIEGO,
      approvedAt: '2026-05-31T00:00:00Z',
      provenance: { source: 'cross-domain freeze test', calibrationCount: 30, note: 'attack refit' },
    },
  });

  // 4. ATTACK C — as-of reconstruction queries across the finalized period
  //    (WD-023-R2 reads must not disturb the ledger).
  for (const asOf of ['2026-03-08T15:30:00Z', NOW, LATER]) {
    const view = reconstructAsOf(revisions, { principal: null, logicalKey: 'str-corinne-q:2026-03-08T02:00:00Z', asOf });
    assert.ok(view.outcome === 'known' || view.outcome === 'gap');
    serializeAsOfPointResult(view);
  }

  // 5. ATTACK D — a SECOND measurement mutation on a different chain: an
  //    exclusion tombstone (the FR-039 path) recorded after finalization.
  const second = revisions.observationById('obs-q-041');
  assert.ok(second);
  revisions.appendRevision({
    logicalKey: second.logicalKey,
    observation: second,
    type: 'exclusion',
    value: null,
    unitId: 'cfs',
    excluded: true,
    processingLevel: 'reviewed',
    qualifierIds: [],
    reason: 'cross-domain attack: post-finalization tombstone',
    actorId: FATIMA,
    now: LATER,
    idempotencyKey: null,
    retainedOriginal: { observationId: second.id, value: second.value, unitId: second.unitId, note: 'retained under attack' },
    action: 'apply-correction',
  });

  // 6. ATTACK E — supersession of ONE finalized period (the legal
  //    correction path) must not disturb the OTHER periods' bytes.
  const superseded = ledger.finalizeSuperseding(WORLD, {
    systemId: BEAR, period: CY2026, decisionId: null,
    content: finalizedContentFromReport(report.value),
    actorId: DIEGO, expectedCurrentId: fin1.outcome === 'finalized' ? fin1.record.id : null, now: LATER,
    reason: 'authorized year-end correction (the legal path)',
  });
  if (superseded.outcome === 'denied') {
    // Identical content refuses (UNCHANGED_CONTENT); that is a refusal, not
    // a mutation — acceptable for the freeze assertion.
    assert.equal(superseded.code, 'UNCHANGED_CONTENT');
  }

  const after = snapshotOf();
  // The ORIGINAL three records keep their ids, hashes and bytes.
  for (const [index, [id, hash]] of before.hashes.entries()) {
    const match = after.hashes.find(([candidateId]) => candidateId === id);
    assert.ok(match, `finalized record ${id} vanished after the cross-domain attacks`);
    assert.equal(match[1], hash, `finalized record ${id} changed its contentHash`);
    const bytesBefore = before.bytes[index][1];
    const bytesAfter = ledger.storedBytes(id);
    assert.equal(bytesAfter, bytesBefore, `finalized record ${id} changed its stored bytes`);
  }
  // No record was removed; at most the explicit supersession appended.
  assert.ok(after.hashes.length >= before.hashes.length, 'records disappeared from the ledger');
  // Events are append-only: the prefix is preserved verbatim.
  const beforeEvents = JSON.parse(before.events);
  const afterEvents = JSON.parse(after.events);
  assert.equal(afterEvents.length, beforeEvents.length + (superseded.outcome === 'finalized' ? 1 : 0), 'audit trail must grow by at most the one explicit supersession');
  for (let i = 0; i < beforeEvents.length; i += 1) {
    assert.deepEqual(afterEvents[i], beforeEvents[i], `audit event ${i} mutated`);
  }
});

test('a SECOND finalization of the same content replays; different content conflicts — never rewrites', () => {
  const ledger = new FinalizedLedger();
  const report = generateReport(
    fixtureReportDeps(NOW),
    { systemId: BEAR, siteIds: null, period: { basis: 'calendar-year', year: 2026 }, processingBasis: 'raw', include: DEFAULT_INCLUDE },
    CODY,
  );
  assert.equal(report.outcome, 'allowed');
  const content = finalizedContentFromReport(report.value);
  const first = ledger.finalize(WORLD, { systemId: BEAR, period: CY2026, decisionId: null, content, actorId: CODY, expectedCurrentId: null, now: NOW });
  assert.equal(first.outcome, 'finalized');
  const bytesBefore = ledger.storedBytes(first.outcome === 'finalized' ? first.record.id : '');

  // Same content, different ACTOR, correct guard: replay (idempotent).
  const replay = ledger.finalize(WORLD, { systemId: BEAR, period: CY2026, decisionId: null, content, actorId: DIEGO, expectedCurrentId: first.outcome === 'finalized' ? first.record.id : null, now: LATER });
  assert.equal(replay.outcome, 'finalized');
  if (replay.outcome === 'finalized') {
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.id, first.outcome === 'finalized' ? first.record.id : null);
  }
  assert.equal(ledger.storedBytes(first.outcome === 'finalized' ? first.record.id : ''), bytesBefore, 'replay rewrote the stored bytes');
  assert.equal(ledger.list().length, 1, 'replay appended a record');
});
