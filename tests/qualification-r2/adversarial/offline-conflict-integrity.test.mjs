/**
 * WD-026 adversarial probe (c): offline conflict integrity — a conflicted
 * draft can NEVER be silently auto-resolved or lost, across store
 * round-trips, repeated syncs, crashes, quota storms and grant revocations.
 *
 * Written by the independent R2 qualification agent (qa_accessibility).
 * Attack surface: the REAL outbox engine (apps/web/src/offline) driven
 * through its public API only — enqueueDraft, syncOnReconnect, retryDraft,
 * resolveConflict, draftStatusView — against an independent in-process
 * server ledger that mirrors the accept.ts contract (commit once per
 * idempotency key; replay thereafter; conflict when baseRevision moved).
 *
 * Invariants under attack (FR-027 "routes conflicts ... without silent
 * loss"):
 *  1. a conflicted draft's captured payload stays byte-identical through
 *     every round-trip and every engine call that is not an explicit
 *     resolveConflict;
 *  2. nothing transitions a conflict out of 'conflict' except
 *     resolveConflict (and a discard demands confirmation);
 *  3. a conflicted draft is never re-uploaded by background sync;
 *  4. the draft is never dropped from the queue by any crash/reload cycle.
 *
 * Run (from repo root):
 *   node --test tests/qualification-r2/adversarial/offline-conflict-integrity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mulberry32 } from '../../qualification/adversarial/canaries.mjs';

register(new URL('../../../apps/web/tests/ts-resolve-hook.mjs', import.meta.url).href, import.meta.url);

const outbox = await import('../../../apps/web/src/offline/outbox.ts');
const { createMemoryOfflineStore } = await import('../../../apps/web/src/offline/store.ts');

const ACCOUNT = 'acct-fatima';
const ACTOR = 'principal-fatima-engineer';
const SITE = 'sta-bear-corinne';
const STREAM = 'str-corinne-q';
const NOW = '2026-03-12T18:00:00Z';
const LATER = '2026-03-12T19:00:00Z';

const PAYLOAD = Object.freeze({
  streamId: STREAM,
  observedAt: '2026-03-12T15:15:00Z',
  value: 87.3,
  unitId: 'cfs',
  note: 'airplane mode capture under attack',
});

function enqueue(queue, draftId, overrides = {}) {
  const result = outbox.enqueueDraft(queue, {
    draftId,
    accountId: ACCOUNT,
    actorId: ACTOR,
    kind: 'reading',
    siteId: SITE,
    streamId: STREAM,
    deviceTimestamp: '2026-03-12T15:30:00Z',
    deviceZone: 'America/Denver',
    captureTime: '2026-03-12T15:15:00Z',
    baseRevision: 4,
    attachments: [{ manifestId: 'man-1', category: 'photo', filename: 'gauge-plate.jpg', captureTime: '2026-03-12T15:10:00Z', visibility: 'public', sizeBytes: 2048 }],
    payload: { ...PAYLOAD },
    ...overrides,
  }, { currentBaseRevision: 4 });
  assert.equal(result.kind, 'queued', `enqueue of ${draftId} must succeed`);
  return result.queue;
}

/**
 * Independent server ledger (accept.ts contract). revisionFor(draftId)
 * decides per draft; conflicts never commit; commits replay by key.
 */
function serverLedger({ revision = 4 } = {}) {
  const commits = new Map();
  let sequence = 0;
  let uploadAttempts = 0;
  const server = {
    get commitCount() { return commits.size; },
    get uploadAttempts() { return uploadAttempts; },
    accept(envelope) {
      uploadAttempts += 1;
      const recorded = commits.get(envelope.idempotencyKey);
      if (recorded) return { kind: 'accepted', recordId: recorded, replayed: true };
      const current = typeof revision === 'function' ? revision(envelope.draftId) : revision;
      if (envelope.baseRevision !== current) {
        return { kind: 'conflict', reason: 'BASE_REVISION_MOVED', baseRevision: envelope.baseRevision, currentRevision: current };
      }
      sequence += 1;
      const recordId = `obs-entry-${1000 + sequence}`;
      commits.set(envelope.idempotencyKey, recordId);
      return { kind: 'accepted', recordId, replayed: false };
    },
  };
  return { server, transport: (envelope) => server.accept(envelope) };
}

const conflictDraft = (queue) => queue.find((envelope) => envelope.draftId === 'draft-conflict');

// ---------------------------------------------------------------------------
// 1. The core invariant: conflict survives everything that is not an
//    explicit resolution, payload byte-identical.
// ---------------------------------------------------------------------------

test('a conflicted draft keeps its payload byte-identical across reloads, re-syncs and crashes', async () => {
  const { server, transport } = serverLedger({ revision: (draftId) => (draftId === 'draft-conflict' ? 9 : 4) });
  const store = createMemoryOfflineStore();
  let queue = enqueue(enqueue([], 'draft-conflict'), 'draft-other');
  store.persist(ACCOUNT, queue);

  const first = await outbox.syncOnReconnect(store, ACCOUNT, { now: NOW, transport });
  assert.equal(first.conflicts.length, 1, 'the moved revision must produce exactly one conflict');
  assert.equal(first.conflicts[0].draftId, 'draft-conflict');
  const conflicted = conflictDraft(first.envelopes);
  assert.equal(conflicted.state, 'conflict');
  assert.deepEqual(conflicted.payload, PAYLOAD, 'payload preserved verbatim at the conflict');
  const payloadBytesAtConflict = JSON.stringify(conflicted.payload);
  assert.ok(conflicted.conflict, 'conflict detail attached');

  // Reload round-trips (the persistence boundary) x3.
  for (let i = 0; i < 3; i += 1) {
    const reloaded = store.load(ACCOUNT);
    const again = reloaded.find((envelope) => envelope.draftId === 'draft-conflict');
    assert.equal(again.state, 'conflict', `reload ${i}: still conflict`);
    assert.deepEqual(JSON.stringify(again.payload), payloadBytesAtConflict, `reload ${i}: payload bytes identical`);
    store.persist(ACCOUNT, reloaded);
  }

  // Re-sync twice more (background sync must NOT re-upload or resolve).
  const attemptsBefore = server.uploadAttempts;
  const second = await outbox.syncOnReconnect(store, ACCOUNT, { now: LATER, transport });
  const third = await outbox.syncOnReconnect(store, ACCOUNT, { now: LATER, transport });
  assert.equal(second.uploadedCount + third.uploadedCount, 0, 'a conflicted draft is never re-uploaded by background sync');
  assert.equal(server.uploadAttempts, attemptsBefore, 'no transport call touched the conflict');
  const survived = conflictDraft(third.envelopes);
  assert.equal(survived.state, 'conflict', 'still conflict after two more syncs');
  assert.deepEqual(JSON.stringify(survived.payload), payloadBytesAtConflict, 'payload bytes identical after re-syncs');

  // Explicit single-draft retry: the engine re-offers the draft, but the
  // stale baseRevision can only conflict again — never merge, never accept.
  const retry = await outbox.retryDraft(store, ACCOUNT, 'draft-conflict', { now: LATER, transport });
  const afterRetry = retry.envelopes.find((envelope) => envelope.draftId === 'draft-conflict');
  assert.ok(afterRetry, 'the draft was not dropped by the retry');
  assert.equal(afterRetry.state, 'conflict', 'retry against a moved revision re-conflicts (no auto-merge)');
  assert.deepEqual(JSON.stringify(afterRetry.payload), payloadBytesAtConflict, 'payload bytes identical after explicit retry');

  // Discard without confirmation is refused.
  const unconfirmed = outbox.resolveConflict(store, ACCOUNT, 'draft-conflict', { kind: 'discard', confirmed: false }, LATER);
  assert.equal(unconfirmed.kind, 'discard-unconfirmed', 'an unconfirmed discard must not act');
  const stillThere = store.load(ACCOUNT).find((envelope) => envelope.draftId === 'draft-conflict');
  assert.ok(stillThere && stillThere.state === 'conflict', 'the conflicted draft survived the unconfirmed discard');
});

// ---------------------------------------------------------------------------
// 2. Interleaved chaos: the conflict draft survives alongside accepted,
//    transport-failing and quota-blocked siblings.
// ---------------------------------------------------------------------------

test('chaos interleave: conflict draft survives accepted/failed/quota siblings untouched', async () => {
  const commits = new Map();
  const transportCalls = [];
  const transport = async (envelope) => {
    transportCalls.push(envelope.draftId);
    if (envelope.draftId === 'draft-flaky') throw new Error('ECONNRESET under attack');
    if (envelope.draftId === 'draft-quota') return { kind: 'quota', message: 'budget exhausted', retryAfter: '2026-03-13T00:00:00Z' };
    const recorded = commits.get(envelope.idempotencyKey);
    if (recorded) return { kind: 'accepted', recordId: recorded, replayed: true };
    // The server moved for the ATTACK draft only; the clean sibling's base
    // revision still matches.
    const current = envelope.draftId === 'draft-conflict' ? 9 : envelope.baseRevision;
    if (envelope.baseRevision !== current) return { kind: 'conflict', reason: 'BASE_REVISION_MOVED', baseRevision: envelope.baseRevision, currentRevision: current };
    const recordId = `obs-chaos-${commits.size + 1}`;
    commits.set(envelope.idempotencyKey, recordId);
    return { kind: 'accepted', recordId, replayed: false };
  };

  const store = createMemoryOfflineStore();
  let queue = enqueue([], 'draft-conflict'); // base 4 vs server 9 -> conflict
  queue = enqueue(queue, 'draft-accept', { draftId: 'draft-accept', payload: { ...PAYLOAD, note: 'clean sibling' } });
  queue = enqueue(queue, 'draft-flaky', { draftId: 'draft-flaky', payload: { ...PAYLOAD, note: 'flaky sibling' } });
  queue = enqueue(queue, 'draft-quota', { draftId: 'draft-quota', payload: { ...PAYLOAD, note: 'quota sibling' } });
  store.persist(ACCOUNT, queue);

  const payloadBytes = JSON.stringify(PAYLOAD);
  for (let round = 1; round <= 3; round += 1) {
    const outcome = await outbox.syncOnReconnect(store, ACCOUNT, { now: NOW, transport });
    const conflict = outcome.envelopes.find((envelope) => envelope.draftId === 'draft-conflict');
    assert.ok(conflict, `round ${round}: conflict draft lost`);
    assert.equal(conflict.state, 'conflict', `round ${round}: still conflict`);
    assert.deepEqual(JSON.stringify(conflict.payload), payloadBytes, `round ${round}: payload identical`);
    // The accepted sibling stays accepted; the flaky sibling stays queued.
    const accepted = outcome.envelopes.find((envelope) => envelope.draftId === 'draft-accept');
    assert.equal(accepted.state, 'accepted', `round ${round}: accepted sibling stable`);
  }

  // Crash-after-commit storm on whichever sibling next commits (transport
  // throws AFTER the server records): the recovery replay must not disturb
  // the conflict.
  const crashTransport = async (envelope) => {
    const verdict = await transport(envelope);
    if (verdict.kind === 'accepted' && !verdict.replayed) throw new Error('ack lost after commit');
    return verdict;
  };
  const outcome = await outbox.syncOnReconnect(store, ACCOUNT, { now: LATER, transport: crashTransport });
  const conflict = outcome.envelopes.find((envelope) => envelope.draftId === 'draft-conflict');
  assert.ok(conflict && conflict.state === 'conflict', 'conflict survived the crash interleave');
  assert.deepEqual(JSON.stringify(conflict.payload), payloadBytes, 'payload identical after the crash interleave');
});

// ---------------------------------------------------------------------------
// 3. Store round-trip fuzz: seeded random sequences of engine calls must
//    never drop or mutate the conflict.
// ---------------------------------------------------------------------------

test('seeded fuzz: 60 random engine-call sequences never drop or auto-resolve the conflict', async () => {
  const random = mulberry32(0xc0ffee);
  for (let trial = 0; trial < 60; trial += 1) {
    const store = createMemoryOfflineStore();
    const queue = enqueue(enqueue([], `draft-sibling-${trial}`), 'draft-conflict');
    store.persist(ACCOUNT, queue);
    const payloadBytes = JSON.stringify(PAYLOAD);
    const transport = (envelope) => {
      if (envelope.draftId === 'draft-conflict') {
        return { kind: 'conflict', reason: 'BASE_REVISION_MOVED', baseRevision: 4, currentRevision: 7 };
      }
      return { kind: 'accepted', recordId: `obs-fuzz-${trial}`, replayed: false };
    };

    const operations = [];
    for (let step = 0; step < 6; step += 1) {
      const choice = Math.floor(random() * 5);
      operations.push(choice);
      if (choice === 0) {
        await outbox.syncOnReconnect(store, ACCOUNT, { now: NOW, transport });
      } else if (choice === 1) {
        store.persist(ACCOUNT, store.load(ACCOUNT)); // reload round-trip
      } else if (choice === 2) {
        await outbox.retryDraft(store, ACCOUNT, 'draft-conflict', { now: NOW, transport });
      } else if (choice === 3) {
        // transport crash storm
        await outbox.syncOnReconnect(store, ACCOUNT, { now: NOW, transport: () => { throw new Error('storm'); } });
      } else {
        await outbox.syncOnReconnect(store, ACCOUNT, { now: NOW, transport, grant: { status: 'revoked', message: 'revoked under attack', policyReason: 'DENY_ASSIGNMENT_REVOKED' } });
      }
    }

    const finalQueue = store.load(ACCOUNT);
    const conflict = finalQueue.find((envelope) => envelope.draftId === 'draft-conflict');
    assert.ok(conflict, `trial ${trial} ops=${operations.join(',')}: the conflict draft was LOST`);
    // Never silently auto-resolved: against a transport that ALWAYS answers
    // conflict for this draft, 'accepted' is unreachable without an explicit
    // human revise (which this fuzz never performs). 'rejected' is a legal
    // routed outcome ONLY through the revoked-grant gate (retained for audit,
    // never uploaded) — it is a terminal routing, not a silent resolution.
    assert.notEqual(conflict.state, 'accepted', `trial ${trial} ops=${operations.join(',')}: silently accepted`);
    assert.ok(['queued', 'conflict', 'rejected'].includes(conflict.state), `trial ${trial}: unexpected state ${conflict.state}`);
    assert.deepEqual(JSON.stringify(conflict.payload), payloadBytes, `trial ${trial}: payload mutated`);
  }
});

// ---------------------------------------------------------------------------
// 4. The only exit: an EXPLICIT resolution, and it is auditable on the
//    envelope (revise requeues against the server's current revision).
// ---------------------------------------------------------------------------

test('the only exit from conflict is an explicit resolution; discard demands confirmation', async () => {
  const store = createMemoryOfflineStore();
  store.persist(ACCOUNT, enqueue([], 'draft-conflict'));
  const transport = () => ({ kind: 'conflict', reason: 'BASE_REVISION_MOVED', baseRevision: 4, currentRevision: 9 });
  await outbox.syncOnReconnect(store, ACCOUNT, { now: NOW, transport });

  const revised = outbox.resolveConflict(store, ACCOUNT, 'draft-conflict', {
    kind: 'revise',
    payload: { ...PAYLOAD, value: 91.4, note: 'human-revised against revision 9' },
    currentRevision: 9,
  }, LATER);
  assert.equal(revised.kind, 'resolved');
  const requeued = revised.queue.find((envelope) => envelope.draftId === 'draft-conflict');
  assert.equal(requeued.state, 'queued', 'the revised draft requeues for upload');
  assert.equal(requeued.baseRevision, 9, 'the revision was rebased on the server truth');
  assert.equal(requeued.payload.value, 91.4, 'the HUMAN revision — not a merge — is what uploads');

  const committed = await outbox.syncOnReconnect(store, ACCOUNT, {
    now: LATER,
    transport: (envelope) => ({ kind: 'accepted', recordId: 'obs-resolved-1', replayed: false }),
  });
  const done = committed.envelopes.find((envelope) => envelope.draftId === 'draft-conflict');
  assert.equal(done.state, 'accepted');

  // The discard path: unconfirmed refused, confirmed removes EXACTLY it.
  store.persist(ACCOUNT, enqueue([], 'draft-conflict-2'));
  const transport2 = () => ({ kind: 'conflict', reason: 'BASE_REVISION_MOVED', baseRevision: 4, currentRevision: 9 });
  await outbox.syncOnReconnect(store, ACCOUNT, { now: NOW, transport: transport2 });
  const unconfirmed = outbox.resolveConflict(store, ACCOUNT, 'draft-conflict-2', { kind: 'discard', confirmed: false }, LATER);
  assert.equal(unconfirmed.kind, 'discard-unconfirmed');
  const confirmed = outbox.resolveConflict(store, ACCOUNT, 'draft-conflict-2', { kind: 'discard', confirmed: true }, LATER);
  assert.equal(confirmed.kind, 'resolved');
  assert.ok(!confirmed.queue.some((envelope) => envelope.draftId === 'draft-conflict-2'), 'exactly the discarded draft is gone');
});

test('status view never hides a conflict behind a success label', () => {
  const store = createMemoryOfflineStore();
  store.persist(ACCOUNT, enqueue([], 'draft-conflict'));
  const conflict = store.load(ACCOUNT).find((envelope) => envelope.draftId === 'draft-conflict');
  const view = outbox.draftStatusView({ ...conflict, state: 'conflict', conflict: { reason: 'BASE_REVISION_MOVED', message: 'the gauge setup changed on the server', currentRevision: 9 } });
  assert.match(view.label, /conflict/i);
  assert.match(view.detail, /changed|revision|server/i);
});
