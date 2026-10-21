/**
 * snapshotModel suite (WD-025-R2, FR-028/FR-029/FR-030): pure view-model
 * behaviour - flexible period math incl. mid-month custom boundaries and
 * DST facts, decision evidence pinning exact revision ids over the fixture
 * chains, the demo finalize ledger (authority mirror, optimistic-concurrency
 * conflict, supersession chain with linkage text, byte stability of prior
 * records), and the advisory supplemental mirror. Runs under node:test with
 * the repo-wide web glob.
 *
 * (Import pattern per apps/web/tests/adapters.test.ts: computed specifiers
 * for node --test --experimental-strip-types, type-only imports for tsc.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { DemoFinalizeLedger, FinalizedLike, PeriodSpecModel } from './snapshotModel';

// Extensionless src imports under node --test (see tests/ts-resolve-hook.mjs).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const modelPath = './snapshotModel.ts';
const model: typeof import('./snapshotModel') = await import(modelPath);
const {
  ADVISORY_LABEL_MODEL,
  DEMO_SUPPLEMENTAL_INPUTS,
  buildDecisionSnapshotDemo,
  buildSupplementalRowsModel,
  finalizeAuthorities,
  instantFromLocal,
  linkageText,
  localMidnightMs,
  periodKeyModel,
  resolvePeriodModel,
  supplementalRowTextModel,
  supersededBanner,
  supersessionChain,
} = model;

const NOW = '2026-03-09T07:00:00Z';
const CODY = 'principal-cody-commissioner';
const DIEGO = 'principal-diego-steward';
const FATIMA = 'principal-fatima-engineer';

// ---------------------------------------------------------------------------
// Flexible periods (FR-030)
// ---------------------------------------------------------------------------

test('governed kinds mirror the WD-025 windows (CY 365 d; WY starts local Oct 1; irrigation 214 d)', () => {
  const cy = resolvePeriodModel({ kind: 'calendar-year', year: 2026 });
  assert.equal(cy.ok, true);
  if (cy.ok) {
    assert.equal(cy.value.start, '2026-01-01T07:00:00.000Z');
    assert.equal(cy.value.end, '2027-01-01T07:00:00.000Z');
    assert.equal(cy.value.localDayCount, 365);
    assert.deepEqual(
      cy.value.dstDays.map((day) => [day.date, day.daySeconds]),
      [
        ['2026-03-08', 82_800],
        ['2026-11-01', 90_000],
      ],
    );
  }

  const wy = resolvePeriodModel({ kind: 'water-year', year: 2026 });
  assert.equal(wy.ok, true);
  if (wy.ok) {
    assert.equal(wy.value.start, '2025-10-01T06:00:00.000Z');
    assert.equal(wy.value.end, '2026-10-01T06:00:00.000Z');
  }

  const irrigation = resolvePeriodModel({ kind: 'irrigation-season', year: 2026 });
  assert.equal(irrigation.ok, true);
  if (irrigation.ok) {
    assert.equal(irrigation.value.start, '2026-04-01T06:00:00.000Z');
    assert.equal(irrigation.value.end, '2026-11-01T06:00:00.000Z');
    assert.equal(irrigation.value.localDayCount, 214);
    assert.equal(irrigation.value.dstDays.length, 0);
  }
});

test('custom mid-month boundary: a water year starting March 15 resolves exactly', () => {
  const spec: PeriodSpecModel = { kind: 'custom', start: instantFromLocal(2026, 3, 15, 0, 0), end: instantFromLocal(2027, 3, 15, 0, 0), label: 'owner-configured water year' };
  const resolved = resolvePeriodModel(spec);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.value.start, '2026-03-15T06:00:00.000Z'); // MDT after spring forward
    assert.equal(resolved.value.end, '2027-03-15T06:00:00.000Z');
    assert.equal(resolved.value.localDayCount, 365);
    assert.equal(resolved.value.dstDays.length, 2);
    assert.equal(resolved.value.dstDays[0]?.date, '2026-11-01');
    assert.equal(resolved.value.dstDays[1]?.daySeconds, 82_800); // the 2027 spring-forward day
  }
  assert.equal(localMidnightMs(2026, 3, 7), Date.parse('2026-03-07T07:00:00.000Z')); // MST (UTC-7)
});

test('custom windows reject unordered, malformed and oversized spans', () => {
  const unordered = resolvePeriodModel({ kind: 'custom', start: '2026-04-01T00:00:00Z', end: '2026-03-01T00:00:00Z', label: 'bad' });
  assert.equal(unordered.ok, false);
  if (!unordered.ok) assert.match(unordered.message, /strictly before end/);

  const malformed = resolvePeriodModel({ kind: 'custom', start: 'nope', end: '2026-03-09T00:00:00Z', label: 'bad' });
  assert.equal(malformed.ok, false);

  const oversized = resolvePeriodModel({ kind: 'custom', start: '2024-01-01T00:00:00Z', end: '2026-06-01T00:00:00Z', label: 'too long' });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.match(oversized.message, /400-day/);
});

// ---------------------------------------------------------------------------
// Decision evidence (FR-028)
// ---------------------------------------------------------------------------

test('decision evidence pins exact revision ids: obs-q-032 -> rev-corinne-2004 at best-available', () => {
  const built = buildDecisionSnapshotDemo({
    period: { kind: 'custom', start: '2026-03-07T19:00:00.000Z', end: '2026-03-08T18:00:00.000Z', label: 'mid-season' },
    processingBasis: 'best-available',
    actorId: CODY,
    now: NOW,
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const ids = built.value.evidence.map((row) => row.observationId);
  assert.deepEqual(ids, ['obs-ho-002', ...Array.from({ length: 17 }, (_, i) => `obs-q-${String(25 + i).padStart(3, '0')}`)]);
  const pinned = built.value.evidence.find((row) => row.observationId === 'obs-q-032');
  assert.ok(pinned);
  assert.equal(pinned?.revisionId, 'rev-corinne-2004');
  assert.equal(pinned?.usedVersion, 2);
  assert.equal(pinned?.chainVersion, 2);
  assert.equal(pinned?.value, 20.9);
  const corinne = built.value.curveLineage.find((entry) => entry.streamId === 'str-corinne-q');
  assert.deepEqual(corinne?.curveVersionIds, ['rc-corinne-2019', 'rc-corinne-2026']);
  assert.match(built.value.evidenceHash, /^[0-9a-f]{32}$/);
});

test('a built snapshot is a value object: rebuilding with the same inputs is identical (determinism)', () => {
  const request = {
    period: { kind: 'calendar-year', year: 2026 } as PeriodSpecModel,
    processingBasis: 'best-available' as const,
    actorId: CODY,
    now: NOW,
  };
  const first = buildDecisionSnapshotDemo(request);
  const second = buildDecisionSnapshotDemo(request);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(first.value.evidenceHash, second.value.evidenceHash);
    assert.equal(first.value.decisionId, second.value.decisionId);
    assert.deepEqual(JSON.parse(JSON.stringify(first.value.evidence)), JSON.parse(JSON.stringify(second.value.evidence)));
  }
});

// ---------------------------------------------------------------------------
// Authority mirror (owner-ratification-pending)
// ---------------------------------------------------------------------------

test('finalize authorities mirror the review-data gate (steward statewide, Cody Bear only, deputy via delegation)', () => {
  const authorities = finalizeAuthorities(NOW);
  const byId = new Map(authorities.map((authority) => [authority.principalId, authority]));
  assert.deepEqual([...(byId.get(DIEGO)?.canFinalizeSystemIds ?? [])].sort(), ['sys-bear-river', 'sys-weber-river']);
  assert.equal(byId.get(DIEGO)?.via, 'statewide-administration');
  assert.deepEqual(byId.get(CODY)?.canFinalizeSystemIds, ['sys-bear-river']);
  assert.equal(byId.get(CODY)?.via, 'review-data');
  assert.deepEqual(byId.get('principal-ana-deputy')?.canFinalizeSystemIds, ['sys-bear-river']);
  assert.deepEqual(byId.get(FATIMA)?.canFinalizeSystemIds, []);
  assert.deepEqual(byId.get('principal-sarah-researcher')?.canFinalizeSystemIds, []);

  // After Ana's delegation expires (2026-06-30) she loses the authority.
  const later = finalizeAuthorities('2026-07-01T00:00:00Z');
  assert.deepEqual(later.find((authority) => authority.principalId === 'principal-ana-deputy')?.canFinalizeSystemIds, []);
});

// ---------------------------------------------------------------------------
// Demo finalize ledger (FR-029)
// ---------------------------------------------------------------------------

const CY2026: PeriodSpecModel = { kind: 'calendar-year', year: 2026 };

function finalizeOk(ledger: DemoFinalizeLedger, actorId: string | null, contentTag: string, expectedCurrentId: string | null): FinalizedLike {
  const result = ledger.finalize({ actorId, period: CY2026, contentTag, expectedCurrentId });
  assert.equal(result.outcome, 'finalized');
  if (result.outcome === 'finalized') return result.record;
  throw new Error('unreachable');
}

test('authority gate: anonymous 401-style denial, engineer denial, hidden-system denial', () => {
  const ledger = new model.DemoFinalizeLedger();
  const anonymous = ledger.finalize({ actorId: null, period: CY2026, contentTag: 'v1', expectedCurrentId: null });
  assert.equal(anonymous.outcome, 'denied');
  if (anonymous.outcome === 'denied') assert.equal(anonymous.status, 401);

  const engineer = ledger.finalize({ actorId: FATIMA, period: CY2026, contentTag: 'v1', expectedCurrentId: null });
  assert.equal(engineer.outcome, 'denied');
  if (engineer.outcome === 'denied') assert.equal(engineer.status, 403);

  const hidden = ledger.finalize({ actorId: CODY, period: CY2026, contentTag: 'v1', expectedCurrentId: null, systemId: 'sys-weber-river' });
  assert.equal(hidden.outcome, 'denied');
  if (hidden.outcome === 'denied') assert.equal(hidden.status, 403); // hidden-object policy in the demo surface
});

test('two simultaneous finalizations: the loser receives the typed FINALIZE_CONFLICT naming the winner', () => {
  const ledger = new model.DemoFinalizeLedger();
  const winner = finalizeOk(ledger, CODY, 'cody content', null);
  const loser = ledger.finalize({ actorId: DIEGO, period: CY2026, contentTag: 'diego content', expectedCurrentId: null });
  assert.equal(loser.outcome, 'conflict');
  if (loser.outcome === 'conflict') {
    assert.equal(loser.code, 'FINALIZE_CONFLICT');
    assert.equal(loser.currentFinalizedId, winner.id);
  }
  assert.equal(ledger.chain(periodKeyModel('sys-bear-river', CY2026)).length, 1);
});

test('supersession chain: explicit linkage, prior record bytes unchanged, status badges and banners', () => {
  const ledger = new model.DemoFinalizeLedger();
  const first = finalizeOk(ledger, CODY, 'v1 content', null);
  const superseded = ledger.finalizeSuperseding({
    actorId: DIEGO,
    period: CY2026,
    contentTag: 'v2 corrected content',
    expectedCurrentId: first.id,
    reason: 'authorized correction after a year-end measurement revision',
  });
  assert.equal(superseded.outcome, 'finalized');
  if (superseded.outcome !== 'finalized') return;

  const chain = ledger.chain(periodKeyModel('sys-bear-river', CY2026));
  assert.equal(chain.length, 2);
  assert.equal(chain[0]?.status, 'superseded');
  assert.equal(chain[0]?.supersededBy, superseded.record.id);
  assert.equal(chain[1]?.status, 'finalized');
  assert.equal(chain[1]?.record.supersedes, first.id);
  assert.equal(chain[1]?.record.supersedeReason, 'authorized correction after a year-end measurement revision');

  // The prior record object is untouched (byte stability): same id, same hash.
  assert.equal(chain[0]?.record.id, first.id);
  assert.equal(chain[0]?.record.contentHash, first.contentHash);

  assert.match(linkageText(chain[1]!), /supersedes fin-/);
  assert.match(linkageText(chain[0]!), /superseded by fin-/);
  assert.match(linkageText(chain[0]!), /never rewritten/);
  const banner = supersededBanner(chain[0]!);
  assert.ok(banner);
  assert.match(banner, /SUPERSEDED/);
  assert.equal(supersededBanner(chain[1]!), null);
  assert.deepEqual(model.statusBadge('finalized'), { marker: '●', text: 'Finalized' });
  assert.deepEqual(model.statusBadge('superseded'), { marker: '✕', text: 'Superseded' });

  // supersessionChain also works standalone over plain record lists.
  const standalone = supersessionChain(ledger.allRecords, periodKeyModel('sys-bear-river', CY2026));
  assert.equal(standalone.length, 2);
});

test('superseding guards: unchanged content and stale expected ids reject', () => {
  const ledger = new model.DemoFinalizeLedger();
  const first = finalizeOk(ledger, CODY, 'v1', null);

  const unchanged = ledger.finalizeSuperseding({ actorId: DIEGO, period: CY2026, contentTag: 'v1', expectedCurrentId: first.id, reason: 'no-op' });
  assert.equal(unchanged.outcome, 'denied');
  if (unchanged.outcome === 'denied') assert.match(unchanged.message, /identical/);

  const stale = ledger.finalizeSuperseding({ actorId: DIEGO, period: CY2026, contentTag: 'v2', expectedCurrentId: null, reason: 'stale' });
  assert.equal(stale.outcome, 'conflict');

  const empty = ledger.finalizeSuperseding({ actorId: DIEGO, period: CY2026, contentTag: 'v2', expectedCurrentId: first.id, reason: '   ' });
  assert.equal(empty.outcome, 'denied');
});

// ---------------------------------------------------------------------------
// Supplemental advisory mirror (FR-030)
// ---------------------------------------------------------------------------

test('supplemental rows compare against APPROVED inputs only and every row carries the advisory label', () => {
  const measured = [
    { category: 'natural-channel-flow', volumeAcreFeet: 10299 / 121 },
    { category: 'canal-delivery', volumeAcreFeet: 267947 / 484 },
    { category: 'reservoir-release', volumeAcreFeet: 26978 / 121 },
  ];
  const rows = buildSupplementalRowsModel(measured);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.advisory, true);
    assert.equal(row.advisoryLabel, ADVISORY_LABEL_MODEL);
  }
  // The PENDING reservoir declaration never reaches a number.
  const release = rows.find((row) => row.category === 'reservoir-release');
  assert.equal(release?.supplementalVolumeAcreFeet, 0);
  const canal = rows.find((row) => row.category === 'canal-delivery');
  assert.equal(canal?.supplementalVolumeAcreFeet, 560.25);
  assert.match(supplementalRowTextModel(rows[0]!), /Advisory only/);
  assert.equal(DEMO_SUPPLEMENTAL_INPUTS.filter((input) => input.status === 'pending').length, 1);
});
