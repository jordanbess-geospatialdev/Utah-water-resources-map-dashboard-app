/**
 * Outbox engine tests (WD-012-R2, FR-027) - the evidence file named in the
 * task's commit trailer.
 *
 * Covered acceptance:
 * - reload survival (store round-trip of every transition);
 * - exactly-once synchronization: double-send AND the commit-before-ack
 *   crash (server records accepted; the client re-sends; the idempotent
 *   replay returns the original result - no duplicate);
 * - base-revision conflict: the draft is preserved VERBATIM and routed for
 *   explicit resolution (never auto-merged; discard demands confirmation);
 * - revoked / expired grant at reconnect: the draft is NEVER uploaded and
 *   is retained in the rejected state for audit visibility;
 * - quota: client enqueue limits with visible retry guidance, and a
 *   server quota verdict returning the draft to queued (retryable);
 * - explicit retry works without background sync;
 * - determinism: the whole scenario, run twice from fresh stores with the
 *   same injected clock, produces identical queues.
 *
 * The "server" here is a deterministic in-process ledger mirroring the
 * contract of services/api/src/workflows/sync/accept.ts (commit once per
 * idempotency key, replay thereafter). The REAL server domain against the
 * REAL readings/visits workflows is exercised in
 * services/api/src/workflows/sync/test/.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/offline/outbox.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../tests/ts-resolve-hook.mjs', import.meta.url);

const outbox = await import('./outbox');
const { createMemoryOfflineStore } = await import('./store');
const cleanupModule = await import('./cleanup');
type OfflineEnvelope = import('./store').OfflineEnvelope;
type SyncVerdict = import('./outbox').SyncVerdict;
type SyncTransport = import('./outbox').SyncTransport;

const {
  DEFAULT_QUEUE_LIMITS,
  enqueueDraft,
  manifestDigestOf,
  outboxTransition,
  resolveConflict,
  retryDraft,
  syncOnReconnect,
  draftStatusView,
} = outbox;

const ACCOUNT = 'acct-fatima';
const ACTOR = 'principal-fatima-engineer';
const SITE = 'sta-bear-corinne';
const STREAM = 'str-corinne-q';
const ZONE = 'America/Denver';

const RECONNECT_AT = '2026-03-12T18:00:00Z';
const LATER_AT = '2026-03-12T19:00:00Z';

interface ReadingPayload {
  readonly streamId: string;
  readonly observedAt: string;
  readonly value: number;
  readonly unitId: string;
  readonly note: string | null;
}

function readingDraft(draftId: string, baseRevision = 4, value = 142.6) {
  return enqueueDraft<ReadingPayload>(
    [],
    {
      draftId,
      accountId: ACCOUNT,
      actorId: ACTOR,
      kind: 'reading',
      siteId: SITE,
      streamId: STREAM,
      deviceTimestamp: '2026-03-12T15:30:00Z',
      deviceZone: ZONE,
      captureTime: '2026-03-12T15:15:00Z',
      baseRevision,
      attachments: [
        { manifestId: 'man-1', category: 'photo', filename: 'gauge-plate.jpg', captureTime: '2026-03-12T15:10:00Z', visibility: 'public', sizeBytes: 2048 },
        { manifestId: 'man-2', category: 'audio', filename: 'site-note.m4a', captureTime: '2026-03-12T15:12:00Z', visibility: 'internal', sizeBytes: 4096 },
      ],
      payload: { streamId: STREAM, observedAt: '2026-03-12T15:15:00Z', value, unitId: 'cfs', note: 'airplane mode capture' },
    },
    { currentBaseRevision: 4 },
  );
}

function visitDraft(draftId: string, baseRevision = 2) {
  return enqueueDraft<{ siteId: string; visitTime: string; type: string; notes: string }>(
    [],
    {
      draftId,
      accountId: ACCOUNT,
      actorId: ACTOR,
      kind: 'visit',
      siteId: SITE,
      streamId: null,
      deviceTimestamp: '2026-03-12T15:40:00Z',
      deviceZone: ZONE,
      captureTime: '2026-03-12T15:30:00Z',
      baseRevision,
      attachments: [{ manifestId: 'man-3', category: 'photo', filename: 'flume.jpg', captureTime: '2026-03-12T15:25:00Z', visibility: 'public', sizeBytes: 1024 }],
      payload: { siteId: SITE, visitTime: '2026-03-12T15:30:00Z', type: 'inspection', notes: 'offline inspection' },
    },
    { currentBaseRevision: 2 },
  );
}

/**
 * Deterministic server ledger: commits each idempotency key ONCE and
 * replays the recorded verdict afterwards (the accept.ts contract). The
 * currentRevision models the server's revision for the draft's target.
 */
function createServerLedger(options: { currentRevision?: number; revisions?: Readonly<Record<string, number>> } = {}) {
  const commits = new Map<string, { recordId: string; body: unknown }>();
  let commitSequence = 0;
  // Revision per draft TARGET (stream for readings, site for visits),
  // mirroring accept.ts reading the authoritative store revision.
  const revisions = new Map<string, number>();
  if (options.revisions) {
    for (const [target, revision] of Object.entries(options.revisions)) revisions.set(target, revision);
  } else if (options.currentRevision !== undefined) {
    revisions.set('*', options.currentRevision);
  }
  const server = {
    get commitCount() {
      return commits.size;
    },
    bumpRevision(target: string, to: number) {
      revisions.set(target, to);
    },
    revisionOf(envelope: OfflineEnvelope): number {
      const target = envelope.streamId ?? envelope.siteId;
      return revisions.get(target) ?? revisions.get('*') ?? envelope.baseRevision;
    },
    /** The sync endpoint: one draft in, one verdict out. */
    accept(envelope: OfflineEnvelope): SyncVerdict {
      const recorded = commits.get(envelope.idempotencyKey);
      if (recorded) {
        return { kind: 'accepted', recordId: recorded.recordId, replayed: true };
      }
      const currentRevision = server.revisionOf(envelope);
      if (envelope.baseRevision !== currentRevision) {
        return { kind: 'conflict', reason: 'BASE_REVISION_MOVED', baseRevision: envelope.baseRevision, currentRevision };
      }
      commitSequence += 1;
      const recordId = `obs-entry-${1000 + commitSequence}`;
      commits.set(envelope.idempotencyKey, { recordId, body: envelope.payload });
      return { kind: 'accepted', recordId, replayed: false };
    },
  };
  return server;
}

/** Transport wrapper simulating CRASH AFTER COMMIT BEFORE ACK: the commit lands, the ack never does. */
function crashAfterCommit(server: ReturnType<typeof createServerLedger>, crashOnAttempt: number) {
  let attempts = 0;
  const transport: SyncTransport = (envelope) => {
    attempts += 1;
    const verdict = server.accept(envelope);
    if (verdict.kind === 'accepted' && attempts === crashOnAttempt) {
      // Committed server-side; the response is lost (tunnel teardown).
      throw new Error('network error: response lost after server commit (ECONNRESET)');
    }
    return verdict;
  };
  return transport;
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

test('enqueue queues a valid draft with the derived idempotency key and manifests digested', () => {
  const result = readingDraft('d-1001');
  assert.equal(result.kind, 'queued');
  if (result.kind !== 'queued') return;
  const envelope = result.envelope;
  assert.equal(envelope.state, 'queued');
  assert.equal(envelope.idempotencyKey, 'offline-reading-d-1001', 'WD-012 pattern: key derives from the draft UUID once');
  assert.equal(envelope.attachments.length, 2);
  assert.match(envelope.attachments[0]!.digest, /^fnv1a-[0-9a-f]{8}$/);
  assert.equal(
    envelope.attachments[0]!.digest,
    manifestDigestOf({ manifestId: 'man-1', category: 'photo', filename: 'gauge-plate.jpg', captureTime: '2026-03-12T15:10:00Z', visibility: 'public', sizeBytes: 2048 }),
  );
});

test('enqueue validation: base revision ahead of the device is refused, not queued', () => {
  const result = readingDraft('d-ahead', 9);
  assert.equal(result.kind, 'invalid');
  if (result.kind !== 'invalid') return;
  assert.ok(result.fieldErrors.some((error) => error.code === 'BASE_REVISION_AHEAD_OF_DEVICE'));
});

test('enqueue validation: integrity field errors identify the offending paths', () => {
  const bad = enqueueDraft<ReadingPayload>(
    [],
    {
      draftId: 'd-bad',
      accountId: '',
      actorId: ACTOR,
      kind: 'reading',
      siteId: SITE,
      streamId: null,
      deviceTimestamp: '2026-03-12T15:30:00Z',
      deviceZone: ZONE,
      captureTime: '2026-03-12T16:00:00Z',
      baseRevision: 4,
      attachments: [{ manifestId: 'm', category: 'wiring-note', filename: 'w.txt', captureTime: '2026-03-12T15:00:00Z', visibility: 'public', sizeBytes: 10 }],
      payload: { streamId: STREAM, observedAt: '2026-03-12T15:15:00Z', value: 1, unitId: 'cfs', note: null },
    },
    { currentBaseRevision: 4 },
  );
  assert.equal(bad.kind, 'invalid');
  if (bad.kind !== 'invalid') return;
  const codes = bad.fieldErrors.map((error) => error.code);
  assert.ok(codes.includes('ACCOUNT_REQUIRED'));
  assert.ok(codes.includes('STREAM_REQUIRED'), 'a reading draft requires its stream');
  assert.ok(codes.includes('CAPTURE_TIME_AFTER_QUEUE'));
  assert.ok(codes.includes('WIRING_NOTE_MUST_BE_INTERNAL'), 'FR-049 wall holds in the manifest too');
});

test('duplicate draft ids are refused (a draft UUID is queued exactly once)', () => {
  const first = readingDraft('d-dup');
  assert.equal(first.kind, 'queued');
  const second = enqueueDraft<ReadingPayload>(first.kind === 'queued' ? first.queue : [], {
    draftId: 'd-dup',
    accountId: ACCOUNT,
    actorId: ACTOR,
    kind: 'reading',
    siteId: SITE,
    streamId: STREAM,
    deviceTimestamp: '2026-03-12T15:31:00Z',
    deviceZone: ZONE,
    captureTime: '2026-03-12T15:15:00Z',
    baseRevision: 4,
    attachments: [],
    payload: { streamId: STREAM, observedAt: '2026-03-12T15:15:00Z', value: 1, unitId: 'cfs', note: null },
  }, { currentBaseRevision: 4 });
  assert.equal(second.kind, 'invalid');
  if (second.kind !== 'invalid') return;
  assert.ok(second.fieldErrors.some((error) => error.code === 'DRAFT_ID_DUPLICATE'));
});

test('client-side quota: a full queue refuses NEW drafts with visible retry guidance and drops nothing', () => {
  const limits = { maxDrafts: 2, maxAttachmentBytes: DEFAULT_QUEUE_LIMITS.maxAttachmentBytes };
  const first = enqueueDraft<ReadingPayload>([], captureInput('d-q1'), { currentBaseRevision: 4, limits });
  const second = enqueueDraft<ReadingPayload>(first.kind === 'queued' ? first.queue : [], captureInput('d-q2'), { currentBaseRevision: 4, limits });
  assert.equal(first.kind, 'queued');
  assert.equal(second.kind, 'queued');
  const queue = second.kind === 'queued' ? second.queue : [];
  const third = enqueueDraft<ReadingPayload>(queue, captureInput('d-q3'), { currentBaseRevision: 4, limits });
  assert.equal(third.kind, 'quota-exceeded');
  if (third.kind !== 'quota-exceeded') return;
  assert.match(third.message, /queue is full \(2\/2 drafts\)/);
  assert.match(third.retryGuidance, /synchronize the 2 pending drafts/i);
  assert.equal(third.queue.length, 2, 'nothing already queued was dropped');
});

function captureInput(draftId: string): import('./outbox').EnqueueInput<ReadingPayload> {
  return {
    draftId,
    accountId: ACCOUNT,
    actorId: ACTOR,
    kind: 'reading',
    siteId: SITE,
    streamId: STREAM,
    deviceTimestamp: '2026-03-12T15:30:00Z',
    deviceZone: ZONE,
    captureTime: '2026-03-12T15:15:00Z',
    baseRevision: 4,
    attachments: [],
    payload: { streamId: STREAM, observedAt: '2026-03-12T15:15:00Z', value: 12.5, unitId: 'cfs', note: null },
  };
}

// ---------------------------------------------------------------------------
// Reload survival + accepted sync
// ---------------------------------------------------------------------------

test('readings, visits and attachment manifests survive an offline reload and sync exactly once', async () => {
  const store = createMemoryOfflineStore();
  const reading = readingDraft('d-r1');
  const visit = visitDraft('d-v1');
  assert.equal(reading.kind, 'queued');
  assert.equal(visit.kind, 'queued');
  store.persist(ACCOUNT, [...(reading.kind === 'queued' ? reading.queue : []), ...(visit.kind === 'queued' ? visit.queue : [])]);

  // Reload: a NEW session reads only what the store persisted.
  const reloaded = store.load(ACCOUNT);
  assert.equal(reloaded.length, 2);
  const readingEnvelope = reloaded.find((envelope) => envelope.draftId === 'd-r1')!;
  const visitEnvelope = reloaded.find((envelope) => envelope.draftId === 'd-v1')!;
  assert.equal(readingEnvelope.attachments.length, 2, 'categorized attachment manifests survived');
  assert.equal(readingEnvelope.attachments[1]!.category, 'audio');
  assert.equal(visitEnvelope.kind, 'visit');

  const server = createServerLedger({ revisions: { [STREAM]: 4, [SITE]: 2 } });
  const outcome = await syncOnReconnect(store, ACCOUNT, {
    now: RECONNECT_AT,
    transport: (envelope) => server.accept(envelope),
  });
  assert.equal(outcome.accepted.length, 2);
  assert.equal(server.commitCount, 2, 'each draft committed exactly once');
  assert.equal(outcome.uploadedCount, 2);

  // The accepted states also survive a reload.
  const after = store.load(ACCOUNT);
  assert.ok(after.every((envelope) => envelope.state === 'accepted'));
  assert.equal(after.find((envelope) => envelope.draftId === 'd-r1')!.acceptedRecordId, 'obs-entry-1001');
  const view = draftStatusView(after[0]!);
  assert.equal(view.label, 'Synced');
});

// ---------------------------------------------------------------------------
// Exactly-once: double send and commit-before-ack crash
// ---------------------------------------------------------------------------

test('double-send is exactly-once: the duplicate delivery replays the original record id', async () => {
  const store = createMemoryOfflineStore();
  const queued = readingDraft('d-double');
  assert.equal(queued.kind, 'queued');
  store.persist(ACCOUNT, queued.queue);
  const server = createServerLedger();

  // First delivery accepted...
  let calls = 0;
  const outcome = await syncOnReconnect(store, ACCOUNT, {
    now: RECONNECT_AT,
    transport: (envelope) => {
      calls += 1;
      return server.accept(envelope);
    },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.accepted.length, 1);
  const firstAccepted = outcome.accepted[0]!;
  assert.equal(firstAccepted.replayed, false);
  assert.equal(firstAccepted.acceptedRecordId, 'obs-entry-1001');

  // ...then the SAME envelope is delivered AGAIN (duplicate network
  // delivery): the server replays its recorded result, nothing appends.
  const replayVerdict = server.accept(firstAccepted);
  assert.deepEqual(replayVerdict, { kind: 'accepted', recordId: 'obs-entry-1001', replayed: true });
  const reapplied = outboxTransition(firstAccepted, { type: 'sync-accepted', recordId: 'obs-entry-1001', replayed: true, at: LATER_AT });
  assert.equal(reapplied.state, 'accepted');
  assert.equal(reapplied.acceptedRecordId, firstAccepted.acceptedRecordId);
  assert.equal(server.commitCount, 1, 'exactly one server commit across both deliveries');
});

test('crash AFTER server commit BEFORE acknowledgement: the re-send replays; no duplicate lands', async () => {
  const store = createMemoryOfflineStore();
  const queued = readingDraft('d-crash');
  assert.equal(queued.kind, 'queued');
  store.persist(ACCOUNT, queued.queue);
  const server = createServerLedger();

  // Attempt 1: the server COMMITS, then the connection dies before the
  // client can process the acknowledgement.
  const crashed = await syncOnReconnect(store, ACCOUNT, { now: RECONNECT_AT, transport: crashAfterCommit(server, 1) });
  assert.equal(server.commitCount, 1, 'the server committed');
  assert.equal(crashed.accepted.length, 0, 'but the client never saw the acknowledgement');
  const afterCrash = store.load(ACCOUNT);
  assert.equal(afterCrash[0]!.state, 'queued', 'back to queued, retained');
  assert.equal(afterCrash[0]!.attempts, 1);
  assert.match(afterCrash[0]!.lastError ?? '', /response lost after server commit/);
  const keyAfterCrash = afterCrash[0]!.idempotencyKey;

  // "Reload" (a fresh session reads the persisted queue) then reconnect:
  // the client re-sends with the SAME idempotency key.
  const reloaded = store.load(ACCOUNT);
  assert.equal(reloaded[0]!.idempotencyKey, keyAfterCrash);
  const recovered = await syncOnReconnect(store, ACCOUNT, {
    now: LATER_AT,
    transport: (envelope) => server.accept(envelope),
  });
  assert.equal(recovered.accepted.length, 1);
  const recoveredDraft = recovered.accepted[0]!;
  assert.equal(recoveredDraft.acceptedRecordId, 'obs-entry-1001', 'the replay returned the ORIGINAL result');
  assert.equal(recoveredDraft.replayed, true, 'and is marked as a replay, not a second append');
  assert.equal(server.commitCount, 1, 'exactly-once held: still a single commit');
});

test('a draft left syncing by a crashed run is requeued on the next load with the same key', async () => {
  const store = createMemoryOfflineStore();
  const queued = readingDraft('d-mid');
  assert.equal(queued.kind, 'queued');
  const envelope = queued.envelope;
  // Simulate: the run marked it syncing, persisted, then the tab died.
  const syncing = outboxTransition(envelope, { type: 'sync-start', at: RECONNECT_AT });
  assert.equal(syncing.state, 'syncing');
  store.persist(ACCOUNT, [syncing]);
  assert.equal(store.load(ACCOUNT)[0]!.state, 'syncing', 'the crash froze the draft mid-sync');

  const server = createServerLedger();
  const outcome = await syncOnReconnect(store, ACCOUNT, { now: LATER_AT, transport: (envelope2) => server.accept(envelope2) });
  assert.equal(outcome.accepted.length, 1);
  assert.equal(outcome.accepted[0]!.idempotencyKey, envelope.idempotencyKey, 'same key across the interrupted run');
  assert.equal(outcome.accepted[0]!.replayed, false, 'nothing had committed; this was the first real commit');
  assert.equal(server.commitCount, 1);
});

// ---------------------------------------------------------------------------
// Conflict: preserved verbatim, explicit resolution only
// ---------------------------------------------------------------------------

test('a moved base revision conflicts: the draft is preserved VERBATIM and routed, never auto-merged', async () => {
  const store = createMemoryOfflineStore();
  const queued = readingDraft('d-conflict', 4, 88.9);
  assert.equal(queued.kind, 'queued');
  const original = queued.envelope;
  store.persist(ACCOUNT, queued.queue);

  const server = createServerLedger({ revisions: { [STREAM]: 4 } });
  server.bumpRevision(STREAM, 5); // the stream's setup changed while the device was offline
  const outcome = await syncOnReconnect(store, ACCOUNT, { now: RECONNECT_AT, transport: (envelope) => server.accept(envelope) });

  assert.equal(outcome.conflicts.length, 1);
  const conflicted = outcome.conflicts[0]!;
  assert.equal(conflicted.state, 'conflict');
  assert.equal(conflicted.conflict!.reason, 'BASE_REVISION_MOVED');
  assert.equal(conflicted.conflict!.baseRevision, 4);
  assert.equal(conflicted.conflict!.currentRevision, 5);
  // VERBATIM: the captured payload is byte-identical, not merged with the
  // server's newer state, and nothing was lost.
  assert.deepEqual(conflicted.payload, original.payload);
  assert.deepEqual(conflicted.attachments, original.attachments);
  assert.equal(server.commitCount, 0, 'a conflicted draft never commits');
  assert.match(draftStatusView(conflicted).label, /Conflict/);

  // An unconfirmed discard is refused (a stray click cannot lose field data).
  const unconfirmed = resolveConflict(store, ACCOUNT, 'd-conflict', { kind: 'discard', confirmed: false }, LATER_AT);
  assert.equal(unconfirmed.kind, 'discard-unconfirmed');
  assert.equal(store.load(ACCOUNT)[0]!.state, 'conflict');

  // Explicit revise on the current revision: requeued with the SAME key,
  // then it syncs cleanly.
  const revised = resolveConflict<ReadingPayload>(store, ACCOUNT, 'd-conflict', {
    kind: 'revise',
    payload: { ...original.payload, value: 88.9, note: 're-measured against setup v5' },
    currentRevision: 5,
  }, LATER_AT);
  assert.equal(revised.kind, 'resolved');
  const requeued = revised.queue.find((envelope) => envelope.draftId === 'd-conflict')!;
  assert.equal(requeued.state, 'queued');
  assert.equal(requeued.baseRevision, 5);
  assert.equal(requeued.revisions, 1);
  assert.equal(requeued.idempotencyKey, original.idempotencyKey, 'the conflict never committed, so the key stays');

  const resolved = await syncOnReconnect(store, ACCOUNT, {
    now: '2026-03-12T20:00:00Z',
    transport: (envelope) => server.accept(envelope),
  });
  assert.equal(resolved.accepted.length, 1);
  assert.equal(resolved.accepted[0]!.replayed, false);
  assert.equal(server.commitCount, 1);
});

test('an explicit confirmed discard removes the conflicted draft and only that draft', async () => {
  const store = createMemoryOfflineStore();
  const a = readingDraft('d-keep');
  const b = readingDraft('d-drop', 4, 77.7);
  assert.equal(a.kind, 'queued');
  assert.equal(b.kind, 'queued');
  store.persist(ACCOUNT, [a.envelope, b.envelope]);
  const server = createServerLedger({ revisions: { [STREAM]: 4 } });
  server.bumpRevision(STREAM, 5);
  await syncOnReconnect(store, ACCOUNT, { now: RECONNECT_AT, transport: (envelope) => server.accept(envelope) });

  const result = resolveConflict(store, ACCOUNT, 'd-drop', { kind: 'discard', confirmed: true }, LATER_AT);
  assert.equal(result.kind, 'resolved');
  const remaining = store.load(ACCOUNT);
  assert.deepEqual(remaining.map((envelope) => envelope.draftId), ['d-keep'], 'only the discarded draft left');
  assert.equal(remaining[0]!.state, 'conflict', 'the other conflicted draft is untouched');
});

// ---------------------------------------------------------------------------
// Revoked / expired grants: never uploaded, retained for audit
// ---------------------------------------------------------------------------

test('a REVOKED grant at reconnect rejects the draft WITHOUT uploading it, retained for audit', async () => {
  const store = createMemoryOfflineStore();
  const queued = readingDraft('d-revoked');
  assert.equal(queued.kind, 'queued');
  store.persist(ACCOUNT, queued.queue);
  const server = createServerLedger();
  let transportCalls = 0;

  const outcome = await syncOnReconnect(store, ACCOUNT, {
    now: RECONNECT_AT,
    transport: (envelope) => {
      transportCalls += 1;
      return server.accept(envelope);
    },
    grant: { status: 'revoked', message: 'entitlement revoked while the device was offline', policyReason: 'DENY_ASSIGNMENT_REVOKED' },
  });

  assert.equal(transportCalls, 0, 'revoked offline drafts must not upload');
  assert.equal(outcome.uploadedCount, 0);
  assert.equal(server.commitCount, 0);
  assert.equal(outcome.rejected.length, 1);
  const rejected = outcome.rejected[0]!;
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.rejection!.code, 'GRANT_REVOKED');
  assert.equal(rejected.rejection!.uploaded, false);
  assert.equal(rejected.rejection!.policyReason, 'DENY_ASSIGNMENT_REVOKED');
  // RETAINED: the draft is still in the store, payload intact, for audit visibility.
  const retained = store.load(ACCOUNT).find((envelope) => envelope.draftId === 'd-revoked')!;
  assert.equal(retained.state, 'rejected');
  assert.deepEqual(retained.payload, queued.envelope.payload);
});

test('an EXPIRED grant at reconnect behaves identically (typed GRANT_EXPIRED)', async () => {
  const store = createMemoryOfflineStore();
  const queued = readingDraft('d-expired');
  assert.equal(queued.kind, 'queued');
  store.persist(ACCOUNT, queued.queue);
  let transportCalls = 0;
  const outcome = await syncOnReconnect(store, ACCOUNT, {
    now: RECONNECT_AT,
    transport: () => {
      transportCalls += 1;
      return { kind: 'accepted', recordId: 'should-never-happen', replayed: false } as SyncVerdict;
    },
    grant: { status: 'expired', message: 'the deputy delegation window closed', policyReason: 'DENY_DELEGATION_EXPIRED' },
  });
  assert.equal(transportCalls, 0);
  assert.equal(outcome.rejected[0]!.rejection!.code, 'GRANT_EXPIRED');
  assert.equal(store.load(ACCOUNT)[0]!.state, 'rejected');
});

// ---------------------------------------------------------------------------
// Quota verdict + transport failure + explicit retry
// ---------------------------------------------------------------------------

test('a server quota verdict returns the draft to queued with visible retry guidance, and a later explicit retry succeeds', async () => {
  const store = createMemoryOfflineStore();
  const queued = readingDraft('d-quota');
  assert.equal(queued.kind, 'queued');
  store.persist(ACCOUNT, queued.queue);

  let quotaOnce = true;
  const outcome = await syncOnReconnect(store, ACCOUNT, {
    now: RECONNECT_AT,
    transport: () => {
      if (quotaOnce) {
        quotaOnce = false;
        return { kind: 'quota', message: 'daily sync budget exhausted for this account', retryAfter: '2026-03-13T00:00:00Z' };
      }
      return { kind: 'accepted', recordId: 'obs-entry-1002', replayed: false };
    },
  });
  assert.equal(outcome.accepted.length, 0);
  assert.equal(outcome.quotaBlocked.length, 1, 'surfaced as quota-blocked, not rejected');
  const blocked = outcome.quotaBlocked[0]!;
  assert.equal(blocked.state, 'queued', 'quota keeps the draft retryable');
  assert.match(blocked.lastError ?? '', /daily sync budget exhausted/);
  assert.match(blocked.lastError ?? '', /retry after 2026-03-13T00:00:00Z/);

  // Explicit retry (no background sync involved) once the window reopened.
  const retried = await retryDraft(store, ACCOUNT, 'd-quota', {
    now: '2026-03-13T08:00:00Z',
    transport: () => ({ kind: 'accepted', recordId: 'obs-entry-1002', replayed: false }),
  });
  assert.equal(retried.accepted.length, 1);
  assert.equal(retried.accepted[0]!.acceptedRecordId, 'obs-entry-1002');
  assert.equal(store.load(ACCOUNT)[0]!.state, 'accepted');
});

test('a transport failure keeps the draft queued and retryable; an explicit single-draft retry completes it', async () => {
  const store = createMemoryOfflineStore();
  const queued = readingDraft('d-flaky');
  assert.equal(queued.kind, 'queued');
  store.persist(ACCOUNT, queued.queue);

  const failing = await syncOnReconnect(store, ACCOUNT, {
    now: RECONNECT_AT,
    transport: () => {
      throw new Error('fetch failed: ENETDOWN');
    },
  });
  assert.equal(failing.accepted.length, 0);
  const after = store.load(ACCOUNT)[0]!;
  assert.equal(after.state, 'queued');
  assert.equal(after.attempts, 1);
  assert.match(after.lastError ?? '', /network error: fetch failed: ENETDOWN/);

  const server = createServerLedger();
  const retried = await retryDraft(store, ACCOUNT, 'd-flaky', {
    now: LATER_AT,
    transport: (envelope) => server.accept(envelope),
  });
  assert.equal(retried.accepted.length, 1);
  assert.equal(server.commitCount, 1);
  assert.equal(store.load(ACCOUNT)[0]!.state, 'accepted');
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('determinism: the same scenario run twice produces identical persisted queues', async () => {
  async function runScenario(): Promise<string> {
    const store = createMemoryOfflineStore();
    const reading = readingDraft('d-det-1');
    const visit = visitDraft('d-det-2');
    const conflicted = readingDraft('d-det-3', 4, 55.5);
    assert.equal(reading.kind, 'queued');
    assert.equal(visit.kind, 'queued');
    assert.equal(conflicted.kind, 'queued');
    store.persist(ACCOUNT, [reading.envelope, visit.envelope, conflicted.envelope]);
    const server = createServerLedger({ revisions: { [STREAM]: 4, [SITE]: 2 } });
    server.bumpRevision(STREAM, 5); // the setup moves before the first reconnect
    await syncOnReconnect(store, ACCOUNT, { now: RECONNECT_AT, transport: (envelope) => server.accept(envelope) });
    resolveConflict(store, ACCOUNT, 'd-det-3', { kind: 'discard', confirmed: true }, '2026-03-12T21:00:00Z');
    await syncOnReconnect(store, ACCOUNT, { now: LATER_AT, transport: (envelope) => server.accept(envelope) });
    return JSON.stringify(store.load(ACCOUNT));
  }
  const first = await runScenario();
  const second = await runScenario();
  assert.equal(first, second);
});

test('account cleanup leaves no residue after sign-out (cross-module contract with cleanup.ts)', async () => {
  const store = createMemoryOfflineStore();
  const queued = readingDraft('d-cleanup');
  assert.equal(queued.kind, 'queued');
  store.persist(ACCOUNT, queued.queue);
  await syncOnReconnect(store, ACCOUNT, {
    now: RECONNECT_AT,
    transport: () => ({ kind: 'accepted', recordId: 'obs-entry-1001', replayed: false }),
  });
  assert.equal(store.load(ACCOUNT)[0]!.state, 'accepted');
  cleanupModule.signOut(store, ACCOUNT, LATER_AT);
  assert.deepEqual(store.load(ACCOUNT), []);
  assert.equal(cleanupModule.hasAccountResidue(store, ACCOUNT), false);
});
