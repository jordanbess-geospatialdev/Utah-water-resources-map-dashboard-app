/**
 * WD-011 domain tests (verification matrix row T-06): best-available
 * corrections, qualifiers, withdrawal tombstones and the point/interval
 * audit over the frozen contract fixtures.
 *
 * Run (zero dependencies):
 *   cd services/api && node --test --experimental-strip-types src/workflows/revisions/test/revisions.test.ts
 *
 * Every clock input is an injected constant; the store reads only the
 * fixture files, so the suite is deterministic - the final test runs the
 * whole scenario twice and compares byte-for-byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createRevisionStore } from '../store.ts';
import { applyCorrection, withdrawOriginal } from '../workflow.ts';
import { pointAudit, intervalAudit, evidenceFor } from '../audit.ts';
import type { RevisionStore } from '../store.ts';
import type { RevisionInput, TombstoneInput } from '../types.ts';

// ---------------------------------------------------------------------------
// Fixture anchors (seed utah-water-fixture-v1, fixed clock 2026-03-09T07:00Z)
// ---------------------------------------------------------------------------

const KEY_Q032 = 'str-corinne-q:2026-03-08T02:00:00Z'; // negative spike; revised by 2001 then 2004
const KEY_Q044 = 'str-corinne-q:2026-03-08T20:00:00Z'; // 9500 cfs out-of-range spike; unrevised
const KEY_Q019 = 'str-corinne-q:2026-03-07T12:00:00Z'; // level-advanced by 2003
const KEY_HO001 = 'str-hyrum-q-owner:2026-03-04T16:00:00Z'; // restricted owner stream

const FATIMA = 'principal-fatima-engineer'; // engineer, Bear River, revise-best-available
const CODY = 'principal-cody-commissioner'; // commissioner, Bear River, revise-best-available
const PRIYA = 'principal-priya-engineer'; // engineer, Weber River only -> out of scope here
const SARAH = 'principal-sarah-researcher'; // researcher -> no correction verb
const ANA = 'principal-ana-deputy'; // deputy: enter-readings/review-data only
const DIEGO = 'principal-diego-steward'; // steward: statewide-administration (satisfies withdraw-raw)

const NOW = '2026-03-10T14:00:00Z';
const AFTER_YEAR_END = '2027-01-15T12:00:00Z';

function correction(overrides: Partial<RevisionInput> = {}): RevisionInput {
  return {
    type: 'correction',
    value: 21.5,
    unitId: 'cfs',
    processingLevel: 'provisional',
    qualifierIds: ['ice-affected'],
    reason: 'Verified against the adjacent readings and the field check log.',
    baseRevisionVersion: 0,
    ...overrides,
  };
}

const withdrawal: TombstoneInput = {
  reason: 'Sensor spike physically impossible for this channel; withdrawn per the outage review.',
  qualifierIds: [],
  baseRevisionVersion: 0,
};

function freshFixtureObservations(): unknown {
  return JSON.parse(readFileSync(new URL('../../../../../../fixtures/contracts/observations.json', import.meta.url), 'utf8')).observations;
}

// ---------------------------------------------------------------------------
// Store loading and raw immutability
// ---------------------------------------------------------------------------

test('store loads the four fixture revisions with deterministic chain versions', () => {
  const store = createRevisionStore();
  assert.equal(store.revisions.length, 4);
  const chain = store.loadChain(KEY_Q032);
  assert.equal(chain.length, 2);
  assert.equal(chain[0]?.id, 'rev-corinne-2001');
  assert.equal(chain[0]?.version, 1);
  assert.equal(chain[1]?.id, 'rev-corinne-2004');
  assert.equal(chain[1]?.version, 2);
  assert.equal(chain[1]?.baseRevisionId, 'rev-corinne-2001');
  assert.equal(store.currentVersion(KEY_Q032), 2);
  assert.equal(store.currentVersion(KEY_Q019), 1);
  assert.equal(store.currentVersion(KEY_Q044), 0);
});

test('raw immutability: no operation edits an original observation row (FR-039)', () => {
  const store = createRevisionStore();
  const pristine = freshFixtureObservations();

  applyCorrection(store, FATIMA, KEY_Q032, correction({ baseRevisionVersion: 2 }), { now: NOW, idempotencyKey: 'imm-1' });
  withdrawOriginal(store, DIEGO, KEY_Q044, withdrawal, { now: NOW, idempotencyKey: 'imm-2' });
  applyCorrection(store, CODY, KEY_Q044, correction({ baseRevisionVersion: 1, value: 24.0 }), { now: NOW, idempotencyKey: 'imm-3' });

  assert.deepEqual(JSON.parse(JSON.stringify(store.observations)), pristine);
  assert.ok(store.observations.every((row) => Object.isFrozen(row)));
  // The fixture file itself is untouched: the store re-reads the same bytes.
  assert.deepEqual(freshFixtureObservations(), pristine);
});

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

test('unauthorized actors are denied with 403 capability rejections', () => {
  const store = createRevisionStore();
  const input = correction();
  for (const actor of [SARAH, ANA]) {
    const decision = applyCorrection(store, actor, KEY_Q044, input, { now: NOW });
    assert.equal(decision.outcome, 'rejected', actor);
    assert.equal(decision.code, 'FORBIDDEN', actor);
    if (decision.outcome === 'rejected') assert.equal(decision.status, 403);
  }
  assert.equal(store.currentVersion(KEY_Q044), 0, 'nothing appended by denied actors');
});

test('out-of-scope engineer on a public stream is forbidden; on a restricted stream the object is hidden (404)', () => {
  const store = createRevisionStore();
  const input = correction();
  // Priya HOLDS revise-best-available but only for sys-weber-river, so both
  // denials below are DENY_OUT_OF_SCOPE - the capability clause passed and the
  // scope clause refused. Sarah holds no correction verb at all and is covered
  // by the 403 capability test above.
  const publicRefusal = applyCorrection(store, PRIYA, KEY_Q044, input, { now: NOW });
  assert.equal(publicRefusal.outcome, 'rejected');
  if (publicRefusal.outcome === 'rejected') {
    assert.equal(publicRefusal.code, 'FORBIDDEN'); // str-corinne-q is public: existence visible, operation refused
    assert.equal(publicRefusal.policyReason, 'DENY_OUT_OF_SCOPE');
  }
  const hidden = applyCorrection(store, PRIYA, KEY_HO001, input, { now: NOW });
  assert.equal(hidden.outcome, 'rejected');
  if (hidden.outcome === 'rejected') {
    assert.equal(hidden.code, 'NOT_FOUND'); // restricted owner row: does not exist for outsiders
    assert.equal(hidden.policyReason, 'DENY_OUT_OF_SCOPE');
  }
});

test('unknown actor is unauthenticated, unknown logical key is not found', () => {
  const store = createRevisionStore();
  const unknownActor = applyCorrection(store, 'principal-ghost', KEY_Q044, correction(), { now: NOW });
  assert.equal(unknownActor.outcome, 'rejected');
  if (unknownActor.outcome === 'rejected') assert.equal(unknownActor.code, 'UNAUTHENTICATED');
  const unknownKey = applyCorrection(store, FATIMA, 'str-corinne-q:1999-01-01T00:00:00Z', correction(), { now: NOW });
  assert.equal(unknownKey.outcome, 'rejected');
  if (unknownKey.outcome === 'rejected') assert.equal(unknownKey.code, 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('missing or blank reason rejects (FR-041)', () => {
  const store = createRevisionStore();
  for (const reason of ['', '   ']) {
    const decision = applyCorrection(store, FATIMA, KEY_Q044, correction({ reason }), { now: NOW });
    assert.equal(decision.outcome, 'rejected');
    if (decision.outcome === 'rejected') {
      assert.equal(decision.code, 'VALIDATION_FAILED');
      assert.equal(decision.status, 422);
    }
  }
  assert.equal(store.currentVersion(KEY_Q044), 0);
});

test('ungoverned qualifier rejects; governed multiples are accepted', () => {
  const store = createRevisionStore();
  const bad = applyCorrection(store, FATIMA, KEY_Q044, correction({ qualifierIds: ['ice-affected', 'telepathic'] }), { now: NOW });
  assert.equal(bad.outcome, 'rejected');
  if (bad.outcome === 'rejected') {
    assert.equal(bad.code, 'VALIDATION_FAILED');
    assert.match(bad.message, /telepathic/);
  }
  const good = applyCorrection(store, FATIMA, KEY_Q044, correction({ qualifierIds: ['ice-affected', 'interpolate'] }), { now: NOW });
  assert.equal(good.outcome, 'applied');
  if (good.outcome === 'applied') assert.deepEqual([...good.revision.qualifierIds].sort(), ['ice-affected', 'interpolate']);
});

// ---------------------------------------------------------------------------
// Optimistic concurrency (If-Match)
// ---------------------------------------------------------------------------

test('stale base version returns a reviewable 412 conflict, never a silent overwrite (FR-022)', () => {
  const store = createRevisionStore();
  const input = correction({ baseRevisionVersion: 1 }); // server is already at 2 (2001 + 2004)
  const decision = applyCorrection(store, FATIMA, KEY_Q032, input, { now: NOW });
  assert.equal(decision.outcome, 'conflict');
  if (decision.outcome === 'conflict' && decision.code === 'PRECONDITION_FAILED') {
    assert.equal(decision.status, 412);
    assert.equal(decision.currentVersion, 2);
    assert.equal(decision.attemptedBaseRevisionVersion, 1);
    assert.equal(decision.currentHeadRevisionId, 'rev-corinne-2004');
    assert.deepEqual(decision.input, input); // caller's input preserved for review/resubmit
  } else {
    assert.fail('expected a PRECONDITION_FAILED conflict');
  }
  assert.equal(store.currentVersion(KEY_Q032), 2, 'conflict appended nothing');
  assert.equal(store.loadChain(KEY_Q032)[1]?.value, 20.9, 'head value untouched');
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('same key + same body replays the recorded result; same key + different body is a 409', () => {
  const store = createRevisionStore();
  const key = 'idem-key-a';
  const input = correction({ baseRevisionVersion: 2, value: 20.95 });
  const first = applyCorrection(store, FATIMA, KEY_Q032, input, { now: NOW, idempotencyKey: key });
  assert.equal(first.outcome, 'applied');
  assert.ok(first.outcome === 'applied' && !first.replayed);

  const replay = applyCorrection(store, FATIMA, KEY_Q032, input, { now: '2026-03-12T00:00:00Z', idempotencyKey: key });
  assert.equal(replay.outcome, 'applied');
  if (replay.outcome === 'applied') {
    assert.equal(replay.replayed, true);
    assert.equal(replay.revision.id, first.outcome === 'applied' ? first.revision.id : '');
    assert.equal(replay.auditEvent, null, 'replay emits no new audit event');
    assert.equal(replay.outboxEvent, null, 'replay emits no new outbox event');
  }
  assert.equal(store.currentVersion(KEY_Q032), 3, 'replay appended nothing');

  const divergent = applyCorrection(store, FATIMA, KEY_Q032, correction({ baseRevisionVersion: 3, value: 99 }), { now: NOW, idempotencyKey: key });
  assert.equal(divergent.outcome, 'conflict');
  if (divergent.outcome === 'conflict' && divergent.code === 'IDEMPOTENCY_CONFLICT') {
    assert.equal(divergent.status, 409);
    assert.equal(divergent.idempotencyKey, key);
  } else {
    assert.fail('expected an IDEMPOTENCY_CONFLICT');
  }
  assert.equal(store.currentVersion(KEY_Q032), 3);
});

test('a fixture-recorded idempotency key replays against the seeded revision', () => {
  const store = createRevisionStore();
  const fixtureKey = '6f1c9d2e-8b3a-4c5d-9e7f-1a2b3c4d5e6f'; // recorded on rev-corinne-2001
  const sameBody = correction({
    value: 20.9,
    processingLevel: 'provisional',
    qualifierIds: ['ice-affected'],
    reason: 'Negative spike inconsistent with channel conditions; verified against adjacent readings and the daily field check.',
    baseRevisionVersion: 0,
  });
  const replay = applyCorrection(store, FATIMA, KEY_Q032, sameBody, { now: NOW, idempotencyKey: fixtureKey });
  assert.equal(replay.outcome, 'applied');
  if (replay.outcome === 'applied') {
    assert.equal(replay.replayed, true);
    assert.equal(replay.revision.id, 'rev-corinne-2001');
  }
  const otherBody = applyCorrection(store, FATIMA, KEY_Q032, correction({ value: 1 }), { now: NOW, idempotencyKey: fixtureKey });
  assert.equal(otherBody.outcome, 'conflict');
});

// ---------------------------------------------------------------------------
// Append-only chains and supersession
// ---------------------------------------------------------------------------

test('superseded revisions remain in the chain and audit (FR-042)', () => {
  const store = createRevisionStore();
  const decision = applyCorrection(store, CODY, KEY_Q032, correction({ baseRevisionVersion: 2, value: 20.8, processingLevel: 'best-available' }), { now: NOW });
  assert.equal(decision.outcome, 'applied');
  const chain = store.loadChain(KEY_Q032);
  assert.equal(chain.length, 3);
  assert.deepEqual(chain.map((revision) => revision.id), ['rev-corinne-2001', 'rev-corinne-2004', decision.outcome === 'applied' ? decision.revision.id : '']);
  // The earlier fixture revisions are unchanged, not rewritten.
  assert.equal(chain[0]?.value, 20.9);
  assert.equal(chain[1]?.value, 20.9);
  const audit = pointAudit(store, KEY_Q032);
  assert.ok(audit);
  assert.equal(audit.rows.length, 3);
  assert.equal(audit.rows[0]?.supersededByRevisionId, 'rev-corinne-2004');
  assert.equal(audit.rows[2]?.isLatest, true);
  assert.equal(audit.rows[0]?.isLatest, false);
});

test('corrections remain possible after year end with no time lock (FR-040)', () => {
  const store = createRevisionStore();
  const decision = applyCorrection(store, FATIMA, KEY_Q019, correction({ baseRevisionVersion: 1, value: 19.25, processingLevel: 'best-available' }), { now: AFTER_YEAR_END });
  assert.equal(decision.outcome, 'applied');
  if (decision.outcome === 'applied') {
    assert.equal(decision.revision.recordedAt, AFTER_YEAR_END);
    assert.equal(decision.revision.type, 'correction');
  }
  assert.equal(store.currentVersion(KEY_Q019), 2);
});

// ---------------------------------------------------------------------------
// Withdrawal tombstones (FR-039)
// ---------------------------------------------------------------------------

test('withdrawal is a separate capability: correcting actors cannot withdraw, the steward can', () => {
  const store = createRevisionStore();
  for (const actor of [FATIMA, CODY]) {
    const denied = withdrawOriginal(store, actor, KEY_Q044, withdrawal, { now: NOW });
    assert.equal(denied.outcome, 'rejected', actor);
    if (denied.outcome === 'rejected') {
      assert.equal(denied.code, 'FORBIDDEN');
      assert.equal(denied.policyReason, 'DENY_CAPABILITY_NOT_GRANTED');
    }
  }
  assert.equal(store.currentVersion(KEY_Q044), 0);
  const allowed = withdrawOriginal(store, DIEGO, KEY_Q044, withdrawal, { now: NOW });
  assert.equal(allowed.outcome, 'applied');
});

test('tombstone excludes the point while retaining the original value and provenance (FR-039)', () => {
  const store = createRevisionStore();
  const decision = withdrawOriginal(store, DIEGO, KEY_Q044, withdrawal, { now: NOW, idempotencyKey: 'withdraw-1' });
  assert.equal(decision.outcome, 'applied');
  if (decision.outcome !== 'applied') return;
  const revision = decision.revision;
  assert.equal(revision.type, 'exclusion');
  assert.equal(revision.value, null);
  assert.equal(revision.excluded, true);
  assert.equal(revision.retainedOriginal?.value, 9500);
  assert.equal(revision.retainedOriginal?.unitId, 'cfs');
  assert.equal(revision.retainedOriginal?.sourceEventId, 'ev-corinne-q-20260308T2000Z');
  assert.equal(revision.retainedOriginal?.sourceId, 'src-corinne-logger-02');
  assert.equal(revision.baseRevisionId, null);
  // The raw row itself is never edited: value stays 9500 in the observation.
  const raw = store.observationByLogicalKey(KEY_Q044);
  assert.equal(raw?.value, 9500);
  // A later correction must rebase on the tombstone (version 1), proving the
  // tombstone is an ordinary chain head, not a terminal state.
  const stale = applyCorrection(store, FATIMA, KEY_Q044, correction({ baseRevisionVersion: 0 }), { now: NOW });
  assert.equal(stale.outcome, 'conflict');
  const rebased = applyCorrection(store, FATIMA, KEY_Q044, correction({ baseRevisionVersion: 1, value: 24.1, processingLevel: 'best-available' }), { now: NOW });
  assert.equal(rebased.outcome, 'applied');
});

test('withdrawal enforces reason and optimistic version like any revision', () => {
  const store = createRevisionStore();
  const noReason = withdrawOriginal(store, DIEGO, KEY_Q044, { ...withdrawal, reason: '' }, { now: NOW });
  assert.equal(noReason.outcome, 'rejected');
  if (noReason.outcome === 'rejected') assert.equal(noReason.code, 'VALIDATION_FAILED');
  const first = withdrawOriginal(store, DIEGO, KEY_Q044, withdrawal, { now: NOW, idempotencyKey: 'w-1' });
  assert.equal(first.outcome, 'applied');
  const stale = withdrawOriginal(store, DIEGO, KEY_Q044, withdrawal, { now: NOW, idempotencyKey: 'w-2' });
  assert.equal(stale.outcome, 'conflict');
  if (stale.outcome === 'conflict' && stale.code === 'PRECONDITION_FAILED') {
    assert.equal(stale.currentVersion, 1);
    assert.equal(stale.attemptedBaseRevisionVersion, 0);
  }
});

// ---------------------------------------------------------------------------
// Audit + outbox
// ---------------------------------------------------------------------------

test('every mutation appends exactly one audit event and one correlated outbox event', () => {
  const store = createRevisionStore();
  const mutations = [
    applyCorrection(store, FATIMA, KEY_Q032, correction({ baseRevisionVersion: 2 }), { now: NOW, idempotencyKey: 'e-1' }),
    withdrawOriginal(store, DIEGO, KEY_Q044, withdrawal, { now: NOW, idempotencyKey: 'e-2' }),
    applyCorrection(store, CODY, KEY_Q019, correction({ baseRevisionVersion: 1, value: 19.3 }), { now: NOW, idempotencyKey: 'e-3' }),
  ];
  for (const mutation of mutations) assert.equal(mutation.outcome, 'applied');
  assert.equal(store.auditEvents.length, 3);
  assert.equal(store.outboxEvents.length, 3);
  const actions = store.auditEvents.map((event) => event.action);
  assert.deepEqual(actions, ['apply-correction', 'withdraw-original', 'apply-correction']);
  for (const event of store.auditEvents) {
    const { audit, outbox } = evidenceFor(store, event.correlationId);
    assert.equal(audit?.id, event.id);
    assert.equal(outbox?.type, 'publication-refresh'); // ADR-10 transactional outbox
    assert.equal(outbox?.logicalKey, event.logicalKey);
    assert.equal(event.actorId === DIEGO, event.action === 'withdraw-original');
    assert.equal(event.after.version, event.before.version + 1);
    assert.equal(event.recordedAt, NOW);
  }
  // Seed revisions from the fixture carry no synthesized audit events: the
  // audit log starts empty and only records mutations made through the API.
  const fresh = createRevisionStore();
  assert.equal(fresh.auditEvents.length, 0);
});

test('audit distinguishes observation time from revision time (FR-042)', () => {
  const store = createRevisionStore();
  const audit = pointAudit(store, KEY_Q032);
  assert.ok(audit);
  assert.equal(audit.provenance.observedAt, '2026-03-08T02:00:00Z');
  assert.equal(audit.provenance.sourceOffset, '-07:00');
  const first = audit.rows[0];
  assert.equal(first?.observedAt, '2026-03-08T02:00:00Z');
  assert.equal(first?.recordedAt, '2026-03-08T15:30:00Z'); // 13.5 h later, a different clock meaning
  assert.notEqual(first?.observedAt, first?.recordedAt);
  assert.equal(first?.actorId, FATIMA);
  assert.equal(first?.originalValue, -1.2);
  assert.equal(first?.replacementValue, 20.9);
  assert.deepEqual([...(first?.qualifierIds ?? [])], ['ice-affected']);
  assert.match(first?.reason ?? '', /Negative spike/);
});

test('interval audit covers flagged intervals with half-open bounds and superseded revisions', () => {
  const store = createRevisionStore();
  const rows = intervalAudit(store, 'str-corinne-q', '2026-03-08T00:00:00Z', '2026-03-09T00:00:00Z');
  const ids = rows.map((row) => row.revisionId);
  assert.deepEqual(ids, ['rev-corinne-2001', 'rev-corinne-2004', 'rev-corinne-2002']);
  const r2001 = rows[0];
  const r2002 = rows[2];
  assert.equal(r2001?.observedAt, '2026-03-08T02:00:00Z');
  assert.equal(r2002?.observedAt, '2026-03-08T18:00:00Z');
  // rev-corinne-2003 targets 2026-03-07T12:00Z: outside [start, end).
  assert.ok(rows.every((row) => row.observedAt >= '2026-03-08T00:00:00Z' && row.observedAt < '2026-03-09T00:00:00Z'));
  assert.ok(!ids.includes('rev-corinne-2003'));
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

function runScenario(): string {
  const store = createRevisionStore();
  applyCorrection(store, FATIMA, KEY_Q032, correction({ baseRevisionVersion: 2, value: 20.95 }), { now: NOW, idempotencyKey: 'det-1' });
  applyCorrection(store, FATIMA, KEY_Q032, correction({ baseRevisionVersion: 2, value: 20.95 }), { now: '2026-03-10T15:00:00Z', idempotencyKey: 'det-1' });
  withdrawOriginal(store, DIEGO, KEY_Q044, withdrawal, { now: NOW, idempotencyKey: 'det-2' });
  applyCorrection(store, CODY, KEY_Q044, correction({ baseRevisionVersion: 1, value: 24.0, processingLevel: 'reviewed' }), { now: AFTER_YEAR_END });
  applyCorrection(store, SARAH, KEY_Q044, correction({ baseRevisionVersion: 2 }), { now: NOW });
  applyCorrection(store, FATIMA, KEY_Q032, correction({ baseRevisionVersion: 1 }), { now: NOW });
  return JSON.stringify(
    { revisions: store.revisions, audit: store.auditEvents, outbox: store.outboxEvents },
    (key, value) => (key === 'fields' ? undefined : value),
  );
}

test('fixed clock determinism: the full scenario run twice is byte-identical', () => {
  const first = runScenario();
  const second = runScenario();
  assert.equal(first, second);
  const parsed = JSON.parse(first);
  assert.equal(parsed.revisions.length, 7); // 4 seed + 3 applied (replay and denials appended nothing)
  assert.equal(parsed.audit.length, 3);
  assert.equal(parsed.outbox.length, 3);
});

test('store exposes the policy world with scoped observation objects', () => {
  const store: RevisionStore = createRevisionStore();
  const object = store.world.objects['obs-q-032'];
  assert.equal(object?.kind, 'observation');
  assert.equal(object?.systemId, 'sys-bear-river');
  const owner = store.world.objects['obs-ho-001'];
  assert.equal(owner?.visibility, 'restricted');
});
