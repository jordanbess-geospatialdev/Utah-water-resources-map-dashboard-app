/**
 * Finalization tests (WD-025-R2; FR-029; T-06/T-15) - the acceptance
 * evidence suite for this task:
 *
 * - AUTHORITY MATRIX (approval-gated, OWNER-RATIFICATION-PENDING): the
 *   statewide steward finalizes; an explicitly granted reviewer (the Bear
 *   River commissioner, the deputy inside her delegation window) finalizes;
 *   everyone else is denied with the hidden-object/identity policy of the
 *   WD-025 scope gate. The actor and the satisfying path are recorded.
 * - CONCURRENCY: two simultaneous finalizations of the same period slot -
 *   one wins, the loser receives the TYPED conflict FINALIZE_CONFLICT (409)
 *   carrying the actual current id (optimistic guard, no lost updates).
 * - SUPERSESSION LINKAGE WITH DUAL-HASH STABILITY: an authorized correction
 *   (reopen / finalize-new-version) appends a linked record; BOTH hashes of
 *   the prior record (its contentHash and the hash of its stored bytes) are
 *   identical before and after.
 * - MEASUREMENT CORRECTIONS REMAIN SEPARATELY POSSIBLE: appending a WD-011
 *   revision (and a WD-011-R2 curve version) after finalization touches no
 *   finalized hash - finalized accounting is modeled separately from the
 *   revisable measurement stream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { seriesStore } from '../../../series/load.ts';
import { createRevisionStore } from '../../revisions/store.ts';
import { createRatingCurveStore } from '../../rating-curves/store.ts';
import { reportWorld } from '../../distribution-report/world.ts';
import { generateReport } from '../../distribution-report/generate.ts';
import { DEFAULT_INCLUDE } from '../../distribution-report/types.ts';
import { FinalizedLedger, checkFinalizeAuthority, finalizedContentFromDecision, finalizedContentFromReport, type FinalizeRequest } from '../finalize.ts';
import { recordDecision } from '../decisions.ts';
import { periodKeyOf } from '../periods.ts';
import type { FinalizedContent, PeriodSpec } from '../types.ts';

const NOW = '2026-03-09T07:00:00Z'; // the fixture fixed clock (inside Ana's delegation window)
const AFTER_DELEGATION = '2026-07-01T00:00:00Z'; // after ent-deputy-ana expires 2026-06-30T23:59:59Z

const DIEGO = 'principal-diego-steward';
const CODY = 'principal-cody-commissioner';
const ANA = 'principal-ana-deputy';
const FATIMA = 'principal-fatima-engineer';
const SARAH = 'principal-sarah-researcher';

const BEAR = 'sys-bear-river';
const CY2026: PeriodSpec = { kind: 'calendar-year', year: 2026 };

const WORLD = reportWorld().policyWorld;

function contentOf(scale: number, note: string): FinalizedContent {
  return {
    methodVersion: 'rectangle-right@1',
    policyVersion: 'policy@fixture',
    roundingPolicy: 'full precision; presentation rounds volumes to 3 decimals',
    noDoubleCountPolicy: 'Totals are reported per accounting category and are never summed across categories.',
    categories: [
      {
        category: 'natural-channel-flow',
        label: 'Natural channel flow (mainstem gauges)',
        streamIds: ['str-corinne-q'],
        volumeAcreFeet: (10299 / 121) * scale,
        volumeUnit: 'acre-feet',
        coveredSeconds: 180_000,
        durationSeconds: 31_536_000,
        coverageFraction: 180_000 / 31_536_000,
        estimatedSeconds: 3_600,
        estimatedProportion: 3_600 / 180_000,
      },
    ],
    sourceReportId: null,
    sourceContentHash: null,
    notes: [note],
  };
}

function finalizeRequest(actorId: string | null, content: FinalizedContent, expectedCurrentId: string | null, now: string = NOW): FinalizeRequest {
  return {
    systemId: BEAR,
    period: CY2026,
    decisionId: null,
    content,
    actorId,
    expectedCurrentId,
    now,
  };
}

// ---------------------------------------------------------------------------
// Authority matrix (OWNER-RATIFICATION-PENDING - see finalize.ts)
// ---------------------------------------------------------------------------

test('the steward finalizes via statewide-administration; the granted reviewer via review-data', () => {
  const steward = checkFinalizeAuthority(WORLD, DIEGO, BEAR, NOW);
  assert.equal(steward.outcome, 'authorized');
  if (steward.outcome === 'authorized') {
    assert.equal(steward.value.via, 'statewide-administration');
    assert.equal(steward.value.actorId, DIEGO);
    assert.ok(steward.value.rule.includes('PENDING OWNER RATIFICATION'));
  }
  const commissioner = checkFinalizeAuthority(WORLD, CODY, BEAR, NOW);
  assert.equal(commissioner.outcome, 'authorized');
  if (commissioner.outcome === 'authorized') assert.equal(commissioner.value.via, 'review-data');

  // The deputy is an explicitly granted reviewer INSIDE her delegation window.
  const deputy = checkFinalizeAuthority(WORLD, ANA, BEAR, NOW);
  assert.equal(deputy.outcome, 'authorized');
  if (deputy.outcome === 'authorized') assert.equal(deputy.value.via, 'review-data');

  // Outside the delegation window the same grant denies: the window, not the
  // role label, decides.
  const late = checkFinalizeAuthority(WORLD, ANA, BEAR, AFTER_DELEGATION);
  assert.equal(late.outcome, 'denied');
  if (late.outcome === 'denied') {
    assert.equal(late.status, 403);
    assert.equal(late.policyReason, 'DENY_DELEGATION_EXPIRED');
  }
});

test('anonymous 401; out-of-scope system is hidden 404; capability-less principals are 403', () => {
  const anonymous = checkFinalizeAuthority(WORLD, null, BEAR, NOW);
  assert.equal(anonymous.outcome, 'denied');
  if (anonymous.outcome === 'denied') {
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.policyReason, 'DENY_ANONYMOUS');
  }

  const hidden = checkFinalizeAuthority(WORLD, CODY, 'sys-weber-river', NOW);
  assert.equal(hidden.outcome, 'denied');
  if (hidden.outcome === 'denied') {
    assert.equal(hidden.status, 404);
    assert.equal(hidden.policyReason, 'DENY_OUT_OF_SCOPE');
  }

  const unknown = checkFinalizeAuthority(WORLD, CODY, 'sys-does-not-exist', NOW);
  assert.equal(unknown.outcome, 'denied');
  if (unknown.outcome === 'denied') assert.equal(unknown.status, 404);

  for (const actorId of [FATIMA, SARAH]) {
    const denied = checkFinalizeAuthority(WORLD, actorId, BEAR, NOW);
    assert.equal(denied.outcome, 'denied', actorId);
    if (denied.outcome === 'denied') {
      assert.equal(denied.status, 403, actorId);
      assert.equal(denied.code, 'FORBIDDEN');
    }
  }
});

test('finalize enforces the authority matrix and records the actor on the frozen record', () => {
  for (const actorId of [DIEGO, CODY, ANA]) {
    const ledger = new FinalizedLedger();
    const result = ledger.finalize(WORLD, finalizeRequest(actorId, contentOf(1, `finalized by ${actorId}`), null));
    assert.equal(result.outcome, 'finalized', actorId);
    if (result.outcome === 'finalized') {
      assert.equal(result.record.finalizedBy, actorId);
      assert.equal(result.record.finalizedAt, NOW);
      assert.equal(result.record.authority.actorId, actorId);
      assert.equal(result.record.status, 'finalized');
      assert.equal(result.record.supersedes, null);
      assert.ok(result.record.contentHash.match(/^[0-9a-f]{64}$/));
      assert.ok(result.record.id.startsWith('fin-'));
      assert.ok(Object.isFrozen(result.record));
    }
  }

  for (const actorId of [null, FATIMA, SARAH] as const) {
    const ledger = new FinalizedLedger();
    const result = ledger.finalize(WORLD, finalizeRequest(actorId, contentOf(1, 'denied'), null));
    assert.equal(result.outcome, 'denied', String(actorId));
    if (result.outcome === 'denied') assert.ok(result.status === 401 || result.status === 403);
  }

  const hiddenLedger = new FinalizedLedger();
  const hidden = hiddenLedger.finalize(WORLD, { ...finalizeRequest(CODY, contentOf(1, 'x'), null), systemId: 'sys-weber-river' });
  assert.equal(hidden.outcome, 'denied');
  if (hidden.outcome === 'denied') assert.equal(hidden.status, 404);
});

// ---------------------------------------------------------------------------
// Optimistic concurrency (two simultaneous finalizations of one period)
// ---------------------------------------------------------------------------

test('two simultaneous finalizations of the same period: one wins, the loser gets the typed FINALIZE_CONFLICT', () => {
  const ledger = new FinalizedLedger();
  // Both actors read an EMPTY slot (expectedCurrentId null) and race.
  const winner = ledger.finalize(WORLD, finalizeRequest(CODY, contentOf(1, 'cody wins the race'), null));
  const loser = ledger.finalize(WORLD, finalizeRequest(DIEGO, contentOf(2, 'diego loses the race'), null));

  assert.equal(winner.outcome, 'finalized');
  assert.equal(loser.outcome, 'conflict');
  if (winner.outcome === 'finalized' && loser.outcome === 'conflict') {
    assert.equal(loser.code, 'FINALIZE_CONFLICT');
    assert.equal(loser.status, 409);
    assert.equal(loser.currentFinalizedId, winner.record.id);
    assert.equal(loser.periodKey, periodKeyOf(BEAR, CY2026));
    // The winner's record is the slot's current head; the loser wrote nothing.
    const current = ledger.currentFor(periodKeyOf(BEAR, CY2026));
    assert.equal(current?.accounting.id, winner.record.id);
    assert.equal(ledger.list().length, 1);
  }
});

test('a stale expectedCurrentId (superseded record) also conflicts, naming the current record', () => {
  const ledger = new FinalizedLedger();
  const first = ledger.finalize(WORLD, finalizeRequest(CODY, contentOf(1, 'v1'), null));
  assert.equal(first.outcome, 'finalized');
  const superseded = ledger.finalizeSuperseding(WORLD, {
    ...finalizeRequest(DIEGO, contentOf(2, 'v2'), (first.outcome === 'finalized' ? first.record.id : null)),
    reason: 'post-audit correction',
  });
  assert.equal(superseded.outcome, 'finalized');

  // An actor still holding the FIRST id races against v2.
  const stale = ledger.finalize(WORLD, finalizeRequest(CODY, contentOf(3, 'v3'), first.outcome === 'finalized' ? first.record.id : 'unknown'));
  assert.equal(stale.outcome, 'conflict');
  if (stale.outcome === 'conflict' && superseded.outcome === 'finalized') {
    assert.equal(stale.currentFinalizedId, superseded.record.id);
  }
});

test('re-finalizing identical content with the correct guard replays (idempotent, no supersession)', () => {
  const ledger = new FinalizedLedger();
  const first = ledger.finalize(WORLD, finalizeRequest(CODY, contentOf(1, 'same'), null));
  assert.equal(first.outcome, 'finalized');
  const eventsAfterFirst = first.outcome === 'finalized' ? ledger.events.length : 0;

  const replay = ledger.finalize(WORLD, finalizeRequest(DIEGO, contentOf(1, 'same'), first.outcome === 'finalized' ? first.record.id : null));
  assert.equal(replay.outcome, 'finalized');
  if (replay.outcome === 'finalized' && first.outcome === 'finalized') {
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.id, first.record.id);
    assert.equal(ledger.list().length, 1);
    assert.equal(ledger.events.length, eventsAfterFirst + 1); // exactly one replay event
    assert.equal(ledger.events.at(-1)?.kind, 'replayed');
  }

  // Different content on an occupied slot is a conflict: it must supersede explicitly.
  const different = ledger.finalize(WORLD, finalizeRequest(DIEGO, contentOf(2, 'different'), first.outcome === 'finalized' ? first.record.id : null));
  assert.equal(different.outcome, 'conflict');
});

// ---------------------------------------------------------------------------
// Supersession linkage with dual-hash stability (FR-029)
// ---------------------------------------------------------------------------

test('supersession: explicit linkage; BOTH prior hashes identical before and after; status projected via views only', () => {
  const ledger = new FinalizedLedger();
  const first = ledger.finalize(WORLD, finalizeRequest(CODY, contentOf(1, 'v1: original accounting'), null));
  assert.equal(first.outcome, 'finalized');
  if (first.outcome !== 'finalized') return;
  const id1 = first.record.id;
  const contentHash1 = first.record.contentHash;
  const bytes1Before = ledger.storedBytes(id1);
  assert.ok(bytes1Before);

  const superseded = ledger.finalizeSuperseding(WORLD, {
    ...finalizeRequest(DIEGO, contentOf(1.05, 'v2: corrected accounting after a measurement revision'), id1),
    reason: 'authorized correction: obs-q-032 re-measured after year end',
  });
  assert.equal(superseded.outcome, 'finalized');
  if (superseded.outcome !== 'finalized') return;
  const id2 = superseded.record.id;

  // DUAL-HASH STABILITY: the prior record's contentHash AND its stored bytes
  // are identical before and after the supersession (never rewritten).
  assert.equal(ledger.storedBytes(id1), bytes1Before);
  assert.equal(ledger.viewOf(id1)?.accounting.contentHash, contentHash1);

  // Explicit linkage both directions (stored pointer up; derived pointer down).
  assert.equal(superseded.record.supersedes, id1);
  assert.equal(superseded.record.supersedeReason, 'authorized correction: obs-q-032 re-measured after year end');
  const priorView = ledger.viewOf(id1);
  assert.equal(priorView?.accounting.status, 'superseded'); // projected view
  assert.equal(priorView?.supersededBy, id2);
  assert.equal(priorView?.ordinal, 1);
  assert.equal(ledger.currentFor(periodKeyOf(BEAR, CY2026))?.accounting.id, id2);
  assert.equal(ledger.viewOf(id2)?.ordinal, 2);
  assert.equal(ledger.viewOf(id2)?.accounting.status, 'finalized');

  // The stored bytes of the prior record still say status 'finalized'
  // (authored-at-creation lifecycle; supersession never edits history).
  assert.ok((ledger.storedBytes(id1) ?? '').includes('"status":"finalized"'));
  // Audit trail carries the supersession with its reason.
  const supersedeEvent = ledger.events.find((event) => event.kind === 'superseded');
  assert.equal(supersedeEvent?.supersededRecordId, id1);
  assert.equal(supersedeEvent?.actorId, DIEGO);
});

test('supersession guards: reason required, prior record required, changed content required, authority required', () => {
  const empty = new FinalizedLedger();
  const nothing = empty.finalizeSuperseding(WORLD, { ...finalizeRequest(CODY, contentOf(1, 'x'), null), reason: 'nothing to supersede' });
  assert.equal(nothing.outcome, 'denied');
  if (nothing.outcome === 'denied') assert.equal(nothing.code, 'NOTHING_TO_SUPERSEDE');

  const ledger = new FinalizedLedger();
  const first = ledger.finalize(WORLD, finalizeRequest(CODY, contentOf(1, 'v1'), null));
  assert.equal(first.outcome, 'finalized');
  const id1 = first.outcome === 'finalized' ? first.record.id : null;

  const noReason = ledger.finalizeSuperseding(WORLD, { ...finalizeRequest(DIEGO, contentOf(2, 'v2'), id1), reason: '  ' });
  assert.equal(noReason.outcome === 'denied' && noReason.code, 'INVALID_REASON');

  const unchanged = ledger.finalizeSuperseding(WORLD, { ...finalizeRequest(DIEGO, contentOf(1, 'v1'), id1), reason: 'no-op correction' });
  assert.equal(unchanged.outcome === 'denied' && unchanged.code, 'UNCHANGED_CONTENT');

  const unauthorized = ledger.finalizeSuperseding(WORLD, { ...finalizeRequest(FATIMA, contentOf(2, 'v2'), id1), reason: 'unauthorized correction' });
  assert.equal(unauthorized.outcome === 'denied' && unauthorized.status, 403);

  const conflict = ledger.finalizeSuperseding(WORLD, { ...finalizeRequest(DIEGO, contentOf(2, 'v2'), null), reason: 'stale guard' });
  assert.equal(conflict.outcome, 'conflict');
  if (conflict.outcome === 'conflict') assert.equal(conflict.code, 'FINALIZE_CONFLICT');
});

// ---------------------------------------------------------------------------
// Measurement corrections remain separately possible (FR-029 tail)
// ---------------------------------------------------------------------------

test('a WD-011 revision append and a WD-011-R2 curve version after finalization touch NO finalized hash', () => {
  const ledger = new FinalizedLedger();
  const first = ledger.finalize(WORLD, finalizeRequest(CODY, contentOf(1, 'v1'), null));
  const superseded = ledger.finalizeSuperseding(WORLD, {
    ...finalizeRequest(DIEGO, contentOf(1.02, 'v2'), first.outcome === 'finalized' ? first.record.id : null),
    reason: 'year-end correction',
  });
  assert.equal(first.outcome, 'finalized');
  assert.equal(superseded.outcome, 'finalized');
  const stateBefore = JSON.stringify({
    list: ledger.list(),
    events: ledger.events,
    bytes: ledger.list().map((view) => ledger.storedBytes(view.accounting.id)),
  });

  // Measurement corrections proceed INDEPENDENTLY of the finalized ledger.
  const revisions = createRevisionStore();
  const curves = createRatingCurveStore();
  const observation = revisions.observationById('obs-q-042');
  assert.ok(observation);
  revisions.appendRevision({
    logicalKey: observation.logicalKey,
    observation,
    type: 'level-advance',
    value: 30.1,
    unitId: 'cfs',
    excluded: false,
    processingLevel: 'reviewed',
    qualifierIds: [],
    reason: 'measurement correction after finalization (independence test)',
    actorId: 'principal-fatima-engineer',
    now: '2026-06-01T00:00:00Z',
    idempotencyKey: null,
    retainedOriginal: null,
    action: 'apply-correction',
  });
  const open = curves.openCurveVersion('str-corinne-q');
  assert.ok(open);
  curves.appendCurveVersion({
    streamId: 'str-corinne-q',
    stationId: open.stationId,
    actorId: DIEGO,
    now: '2026-06-01T00:00:00Z',
    closeCurrentAt: '2026-05-31T00:00:00Z',
    action: 'supersede-curve',
    version: {
      stationId: open.stationId,
      streamId: 'str-corinne-q',
      coefficients: { c: 42.0, b: 1.9, e: 1.67 },
      unitPair: { fromUnitId: 'ft', toUnitId: 'cfs' },
      method: 'Log-linear least squares, n=24 calibrations (independence test)',
      effectiveFrom: '2026-05-31T00:00:00Z',
      effectiveTo: null,
      author: DIEGO,
      approvalState: 'approved',
      approvedBy: DIEGO,
      approvedAt: '2026-05-31T00:00:00Z',
      provenance: { source: 'independence test', calibrationCount: 24, note: 'post-finalization refit' },
    },
  });

  const stateAfter = JSON.stringify({
    list: ledger.list(),
    events: ledger.events,
    bytes: ledger.list().map((view) => ledger.storedBytes(view.accounting.id)),
  });
  assert.equal(stateAfter, stateBefore, 'finalized accounting must be unreachable from the measurement stream');
});

// ---------------------------------------------------------------------------
// Content sources (decision snapshots and WD-025 reports)
// ---------------------------------------------------------------------------

test('finalize content derived from a decision snapshot carries its evidence linkage', () => {
  const decision = recordDecision(
    { store: seriesStore(), revisions: createRevisionStore(), curves: createRatingCurveStore(), now: NOW },
    { systemId: BEAR, period: CY2026, processingBasis: 'raw', siteIds: null, statement: 'CY-2026 decision' },
    CODY,
  );
  assert.equal(decision.outcome, 'allowed');
  if (decision.outcome !== 'allowed') return;
  const content = finalizedContentFromDecision(decision.value);
  assert.equal(content.sourceReportId, null);
  assert.ok(content.notes[0]?.includes(decision.value.decisionId));

  const ledger = new FinalizedLedger();
  const result = ledger.finalize(WORLD, { ...finalizeRequest(CODY, content, null), decisionId: decision.value.decisionId });
  assert.equal(result.outcome, 'finalized');
  if (result.outcome === 'finalized') assert.equal(result.record.decisionId, decision.value.decisionId);
});

test('finalize content derived from a WD-025 report pins the report id and its content hash', () => {
  const report = generateReport(
    { store: seriesStore(), revisions: createRevisionStore(), now: NOW },
    { systemId: BEAR, siteIds: null, period: { basis: 'calendar-year', year: 2026 }, processingBasis: 'raw', include: DEFAULT_INCLUDE },
    CODY,
  );
  assert.equal(report.outcome, 'allowed');
  if (report.outcome !== 'allowed') return;
  const content = finalizedContentFromReport(report.value);
  assert.equal(content.sourceReportId, report.value.reportId);
  assert.equal(content.sourceContentHash, report.value.contentHash);

  // Same inputs -> same content hash -> same record id in a fresh ledger.
  const ledgerA = new FinalizedLedger();
  const ledgerB = new FinalizedLedger();
  const a = ledgerA.finalize(WORLD, finalizeRequest(CODY, content, null));
  const b = ledgerB.finalize(WORLD, finalizeRequest(DIEGO, content, null));
  assert.equal(a.outcome, 'finalized');
  assert.equal(b.outcome, 'finalized');
  if (a.outcome === 'finalized' && b.outcome === 'finalized') {
    assert.equal(a.record.contentHash, b.record.contentHash);
    assert.notEqual(a.record.id, b.record.id); // the RECORD id also binds actor+time
    assert.equal(a.record.authority.via, 'review-data');
    assert.equal(b.record.authority.via, 'statewide-administration');
  }
});
