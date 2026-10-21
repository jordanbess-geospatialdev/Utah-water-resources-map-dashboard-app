/**
 * Decision-snapshot tests (WD-025-R2; FR-028; T-06): a saved distribution
 * decision references the EXACT observation/revision versions used, the
 * rating-curve lineage, and its calculation inputs - and later corrections
 * provably do not change any of it.
 *
 * Immutability proof strategy (FR-028's hard claim): record a decision,
 * serialize its bytes, then REALLY append a correction (WD-011
 * appendRevision) and a curve supersession (WD-011-R2 appendCurveVersion),
 * and assert the recorded snapshot's bytes are identical while a FRESH
 * decision against the same stores picks up the new heads (the stream moved;
 * the snapshot did not).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { closeRelative } from '../../../series/golden.ts';
import { seriesStore } from '../../../series/load.ts';
import { createRevisionStore } from '../../revisions/store.ts';
import { createRatingCurveStore } from '../../rating-curves/store.ts';
import { generateReport } from '../../distribution-report/generate.ts';
import { DEFAULT_INCLUDE } from '../../distribution-report/types.ts';
import { reportWorld } from '../../distribution-report/world.ts';
import { decisionBytes, fixtureDecisionDeps, recordDecision, type DecisionDeps } from '../decisions.ts';
import type { DecisionSnapshot } from '../types.ts';

const NOW = '2026-03-09T07:00:00Z'; // the fixture fixed clock
const CODY = 'principal-cody-commissioner';
const DIEGO = 'principal-diego-steward';
const FATIMA = 'principal-fatima-engineer';

const BEAR_CY2026 = {
  systemId: 'sys-bear-river',
  period: { kind: 'calendar-year', year: 2026 } as const,
  processingBasis: 'raw' as const,
  siteIds: null,
  statement: 'Bear River CY-2026 seasonal distribution decision (fixture demo)',
};

/** Local Mar 7 12:00 -> Mar 8 12:00 (America/Denver), spanning the declared gap and DST edges. */
const MIDDAY_CUSTOM = {
  systemId: 'sys-bear-river',
  period: { kind: 'custom', start: '2026-03-07T19:00:00.000Z', end: '2026-03-08T18:00:00.000Z', label: 'mid-season custom window' } as const,
  processingBasis: 'best-available' as const,
  siteIds: null,
  statement: 'Custom mid-season window decision',
};

function freshDeps(): DecisionDeps {
  return { store: seriesStore(), revisions: createRevisionStore(), curves: createRatingCurveStore(), now: NOW };
}

function record(deps: DecisionDeps, request: typeof BEAR_CY2026 | typeof MIDDAY_CUSTOM, actor: string | null): DecisionSnapshot {
  const result = recordDecision(deps, request, actor);
  assert.equal(result.outcome, 'allowed');
  if (result.outcome === 'allowed') return result.value;
  throw new Error('unreachable');
}

// ---------------------------------------------------------------------------
// Recording authority (the WD-025 report gate is reused verbatim)
// ---------------------------------------------------------------------------

test('Cody (Bear River commissioner) records a decision; Diego statewide too', () => {
  for (const actor of [CODY, DIEGO]) {
    const snapshot = record(freshDeps(), BEAR_CY2026, actor);
    assert.equal(snapshot.decidedBy, actor);
    assert.equal(snapshot.decidedAt, NOW);
    assert.ok(snapshot.decisionId.startsWith('dec-'));
    assert.equal(snapshot.schemaVersion, 'accounting-snapshots@1');
  }
});

test('anonymous callers cannot record (401), engineers cannot (403), hidden systems are 404', () => {
  const anonymous = recordDecision(freshDeps(), BEAR_CY2026, null);
  assert.equal(anonymous.outcome, 'denied');
  if (anonymous.outcome === 'denied') assert.equal(anonymous.status, 401);

  const engineer = recordDecision(freshDeps(), BEAR_CY2026, FATIMA);
  assert.equal(engineer.outcome, 'denied');
  if (engineer.outcome === 'denied') assert.equal(engineer.status, 403);

  const hidden = recordDecision(freshDeps(), { ...BEAR_CY2026, systemId: 'sys-weber-river' }, CODY);
  assert.equal(hidden.outcome, 'denied');
  if (hidden.outcome === 'denied') {
    assert.equal(hidden.status, 404);
    assert.equal(hidden.policyReason, 'DENY_OUT_OF_SCOPE');
  }
});

test('an empty statement is rejected 422', () => {
  const result = recordDecision(freshDeps(), { ...BEAR_CY2026, statement: '   ' }, CODY);
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') assert.equal(result.code, 'INVALID_STATEMENT');
});

// ---------------------------------------------------------------------------
// Evidence exactness (FR-028)
// ---------------------------------------------------------------------------

test('pinned evidence: exact observation ids inside the half-open window, exact revision ids used', () => {
  const snapshot = record(freshDeps(), MIDDAY_CUSTOM, CODY);
  const ids = snapshot.referencedObservations.map((row) => row.observationId);
  // Local [Mar 7 12:00, Mar 8 12:00): str-corinne-q obs-q-025..obs-q-041
  // (obs-q-024 at the excluded Mar 7 11:00 local instant stays out; obs-q-042
  // at the exclusive end 18:00Z stays out) plus the owner release reading
  // ho-002 at 2026-03-08T17:00Z.
  assert.deepEqual(ids, ['obs-ho-002', ...Array.from({ length: 17 }, (_, i) => `obs-q-${String(25 + i).padStart(3, '0')}`)]);

  // obs-q-032: chain rev-corinne-2001 -> rev-corinne-2004; at best-available
  // the decision pins the HEAD revision with its exact value and level.
  const pinned = snapshot.referencedObservations.find((row) => row.observationId === 'obs-q-032');
  assert.ok(pinned);
  assert.equal(pinned?.revisionId, 'rev-corinne-2004');
  assert.equal(pinned?.usedVersion, 2);
  assert.equal(pinned?.headRevisionId, 'rev-corinne-2004');
  assert.equal(pinned?.chainVersion, 2);
  assert.equal(pinned?.usedProcessingLevel, 'best-available');
  assert.equal(pinned?.value, 20.9);
  assert.equal(pinned?.belowSelectedBasis, false);

  // Unrevised observations pin the raw original.
  const unrevised = snapshot.referencedObservations.find((row) => row.observationId === 'obs-q-025');
  assert.ok(unrevised);
  assert.equal(unrevised?.revisionId, null);
  assert.equal(unrevised?.usedVersion, 0);
  assert.equal(unrevised?.usedProcessingLevel, 'raw');
  assert.equal(unrevised?.belowSelectedBasis, false); // best-available falls back to raw without a below-basis flag
});

test('curve lineage: overlapping approved versions + the version in force at the period start', () => {
  const snapshot = record(freshDeps(), BEAR_CY2026, CODY);
  const corinne = snapshot.curveLineage.find((entry) => entry.streamId === 'str-corinne-q');
  assert.ok(corinne);
  assert.deepEqual(corinne?.curveVersionIds, ['rc-corinne-2019', 'rc-corinne-2026']);
  assert.equal(corinne?.curveAtStart, 'rc-corinne-2019'); // CY-2026 starts Jan 1: the 2019 curve is in force
  assert.ok((corinne?.method ?? '').startsWith('Log-linear'));
  // Calculation inputs pin the method versions (FR-028 "recorded calculation inputs").
  assert.equal(snapshot.calculationInputs.aggregationMethod, 'rectangle-right@1');
  assert.equal(snapshot.calculationInputs.processingBasis, 'raw');
  assert.ok(snapshot.calculationInputs.curveMethods.length >= 1);
  assert.ok(snapshot.calculationInputs.supplementalPolicy.includes('Advisory only'));
});

test('basis totals reconcile to the WD-025 report over the same governed bounds (raw goldens)', () => {
  const snapshot = record(freshDeps(), BEAR_CY2026, CODY);
  const report = generateReport(
    { store: seriesStore(), revisions: createRevisionStore(), now: NOW },
    { systemId: 'sys-bear-river', siteIds: null, period: { basis: 'calendar-year', year: 2026 }, processingBasis: 'raw', include: DEFAULT_INCLUDE },
    CODY,
  );
  assert.equal(report.outcome, 'allowed');
  assert.equal(snapshot.basisTotals.length, 3);
  const byCategory = new Map(snapshot.basisTotals.map((total) => [total.category, total]));
  const expected: ReadonlyArray<[string, number]> = [
    ['natural-channel-flow', 10299 / 121],
    ['canal-delivery', 267947 / 484],
    ['reservoir-release', 26978 / 121],
  ];
  for (const [category, volume] of expected) {
    const total = byCategory.get(category as DecisionSnapshot['basisTotals'][number]['category']);
    assert.ok(total, category);
    assert.ok(closeRelative(total?.volumeAcreFeet ?? 0, volume), `${category}: ${total?.volumeAcreFeet} vs ${volume}`);
    const reportRow = report.outcome === 'allowed' ? report.value.sections.totals.categories.find((row) => row.category === category) : undefined;
    assert.ok(reportRow, category);
    assert.equal(total?.coveredSeconds, reportRow?.coveredSeconds);
    assert.equal(total?.durationSeconds, reportRow?.durationSeconds);
    assert.equal(total?.estimatedSeconds, reportRow?.estimatedSeconds);
  }
});

// ---------------------------------------------------------------------------
// Immutability under later corrections (the FR-028 hard claim)
// ---------------------------------------------------------------------------

test('a later WD-011 correction does NOT change the recorded snapshot; a fresh decision sees the new head', () => {
  const deps = freshDeps();
  // best-available pins the chain HEAD's value, so the correction below is
  // visible to a FRESH decision but not to the recorded snapshot.
  const snapshot = record(deps, { ...BEAR_CY2026, processingBasis: 'best-available' }, CODY);
  const bytesBefore = decisionBytes(snapshot);
  const evidenceBefore = snapshot.evidenceHash;

  // REALLY append a correction to a referenced observation (WD-011 store).
  const observation = deps.revisions.observationById('obs-q-032');
  assert.ok(observation);
  deps.revisions.appendRevision({
    logicalKey: observation.logicalKey,
    observation,
    type: 'correction',
    value: 55.5,
    unitId: 'cfs',
    excluded: false,
    processingLevel: 'reviewed',
    qualifierIds: [],
    reason: 'post-decision correction (immutability test)',
    actorId: 'principal-fatima-engineer',
    now: '2026-04-01T00:00:00Z',
    idempotencyKey: null,
    retainedOriginal: null,
    action: 'apply-correction',
  });

  assert.equal(decisionBytes(snapshot), bytesBefore, 'snapshot bytes must be identical after the correction');
  assert.equal(snapshot.evidenceHash, evidenceBefore);
  const pinned = snapshot.referencedObservations.find((row) => row.observationId === 'obs-q-032');
  assert.equal(pinned?.value, 20.9, 'the pinned value is the value known at decision time');
  assert.equal(pinned?.chainVersion, 2, 'the pinned chain length is the length known at decision time');

  // The measurement stream DID move: a fresh decision pins the new head.
  const fresh = record(deps, { ...BEAR_CY2026, processingBasis: 'best-available' }, CODY);
  const freshPinned = fresh.referencedObservations.find((row) => row.observationId === 'obs-q-032');
  assert.equal(freshPinned?.chainVersion, 3);
  assert.equal(freshPinned?.headRevisionId, 'rev-appended-1005');
  assert.equal(freshPinned?.revisionId, 'rev-appended-1005');
  assert.equal(freshPinned?.value, 55.5);
  assert.notEqual(fresh.evidenceHash, snapshot.evidenceHash);
});

test('a later WD-011-R2 curve supersession does NOT change the recorded snapshot', () => {
  const deps = freshDeps();
  const snapshot = record(deps, BEAR_CY2026, CODY);
  const bytesBefore = decisionBytes(snapshot);

  const open = deps.curves.openCurveVersion('str-corinne-q');
  assert.ok(open);
  deps.curves.appendCurveVersion({
    streamId: 'str-corinne-q',
    stationId: open.stationId,
    actorId: 'principal-diego-steward',
    now: '2026-04-02T00:00:00Z',
    closeCurrentAt: '2026-04-01T00:00:00Z',
    action: 'supersede-curve',
    version: {
      stationId: open.stationId,
      streamId: 'str-corinne-q',
      coefficients: { c: 43.1, b: 1.95, e: 1.66 },
      unitPair: { fromUnitId: 'ft', toUnitId: 'cfs' },
      method: 'Log-linear least squares, n=25 calibrations (post-decision refit)',
      effectiveFrom: '2026-04-01T00:00:00Z',
      effectiveTo: null,
      author: 'principal-diego-steward',
      approvalState: 'approved',
      approvedBy: 'principal-diego-steward',
      approvedAt: '2026-04-01T00:00:00Z',
      provenance: { source: 'immutability test', calibrationCount: 25, note: 'post-decision refit' },
    },
  });

  assert.equal(decisionBytes(snapshot), bytesBefore);
  const corinne = snapshot.curveLineage.find((entry) => entry.streamId === 'str-corinne-q');
  assert.deepEqual(corinne?.curveVersionIds, ['rc-corinne-2019', 'rc-corinne-2026']);
});

test('deep freeze: mutation attempts throw or are no-ops (frozen evidence)', () => {
  const snapshot = record(freshDeps(), BEAR_CY2026, CODY);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.referencedObservations));
  assert.ok(Object.isFrozen(snapshot.calculationInputs));
  assert.throws(() => {
    'use strict';
    (snapshot as unknown as { statement: string }).statement = 'tampered';
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('recording twice against identical stores and clock yields byte-identical snapshots', () => {
  const first = record(freshDeps(), BEAR_CY2026, CODY);
  const second = record(freshDeps(), BEAR_CY2026, CODY);
  assert.equal(decisionBytes(first), decisionBytes(second));
  assert.equal(first.decisionId, second.decisionId);
  assert.equal(first.evidenceHash, second.evidenceHash);
});
