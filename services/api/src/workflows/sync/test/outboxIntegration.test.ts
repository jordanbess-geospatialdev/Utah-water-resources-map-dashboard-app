/**
 * End-to-end offline synchronization tests (WD-012-R2, FR-027): the REAL
 * web outbox engine (apps/web/src/offline) driving the REAL server sync
 * domain (acceptDrafts) over the REAL readings/visits workflows.
 *
 * Covered: reload survival into sync, exactly-once under double-send AND
 * commit-before-ack crash, conflict preservation verbatim, sync-time
 * revocation discovered by the server (client unaware), and sign-out
 * cleanup after a completed sync.
 *
 * The web modules are loaded at RUNTIME (the established dynamic-import
 * pattern; the api package has no tsc program, and the web tsconfig's
 * extensionless imports need the web test resolve hook).
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/sync/test/outboxIntegration.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../../../../apps/web/tests/ts-resolve-hook.mjs', import.meta.url);

const webOutbox = await import('../../../../../../apps/web/src/offline/outbox');
const webStore = await import('../../../../../../apps/web/src/offline/store');
const webCleanup = await import('../../../../../../apps/web/src/offline/cleanup');

const { withEntitlement } = await import('../../../../../../packages/policy/src/index.ts');
const { createReadingsStore } = await import('../../readings/store.ts');
const { createVisitStore } = await import('../../visits/store.ts');
const { createPlaceholderAttachmentStorage } = await import('../../visits/attachments.ts');
const { createSyncStore } = await import('../store.ts');
const { acceptDrafts } = await import('../accept.ts');

type OfflineEnvelope = import('../../../../../../apps/web/src/offline/store').OfflineEnvelope;
type SyncVerdict = import('../types.ts').SyncVerdict;
type OfflineSyncRequest = import('../types.ts').OfflineSyncRequest;

const ACCOUNT = 'acct-fatima';
const ACTOR = 'principal-fatima-engineer';
const SITE = 'sta-bear-corinne';
const STREAM = 'str-corinne-q';
const RECONNECT = '2026-03-12T18:00:00Z';
const LATER = '2026-03-12T19:00:00Z';

interface ReadingPayload {
  readonly streamId: string;
  readonly observedAt: string;
  readonly value: number;
  readonly unitId: string;
  readonly note: string | null;
}

/** The server-side sync deps over pristine stores. */
function createServer() {
  const readingsStore = createReadingsStore();
  const visitStore = createVisitStore();
  const syncStore = createSyncStore();
  const deps = {
    syncStore,
    readingsStore,
    visitStore,
    attachmentStorage: createPlaceholderAttachmentStorage(),
  };
  return { deps, readingsStore, visitStore, syncStore };
}

/** Map a persisted client envelope onto the server's request shape. */
function toRequest(envelope: OfflineEnvelope): OfflineSyncRequest {
  return {
    draftId: envelope.draftId,
    idempotencyKey: envelope.idempotencyKey,
    actorId: envelope.actorId,
    kind: envelope.kind,
    siteId: envelope.siteId,
    streamId: envelope.streamId,
    deviceTimestamp: envelope.deviceTimestamp,
    deviceZone: envelope.deviceZone,
    captureTime: envelope.captureTime,
    baseRevision: envelope.baseRevision,
    attachments: envelope.attachments.map((attachment) => ({
      manifestId: attachment.manifestId,
      category: attachment.category,
      filename: attachment.filename,
      captureTime: attachment.captureTime,
      visibility: attachment.visibility,
      sizeBytes: attachment.sizeBytes,
    })),
    payload: envelope.payload as Record<string, unknown>,
  };
}

/** A transport that pushes one envelope through the real acceptDrafts. */
function serverTransport(deps: ReturnType<typeof createServer>['deps'], now: () => string) {
  return (envelope: OfflineEnvelope): SyncVerdict => acceptDrafts(deps, envelope.actorId, [toRequest(envelope)], { now: now() }).verdicts[0]!;
}

function queueReading(store: unknown, draftId: string, value = 21.5, baseRevision = 12): void {
  const result = webOutbox.enqueueDraft<ReadingPayload>(
    [],
    {
      draftId,
      accountId: ACCOUNT,
      actorId: ACTOR,
      kind: 'reading',
      siteId: SITE,
      streamId: STREAM,
      deviceTimestamp: '2026-03-12T15:30:00Z',
      deviceZone: 'America/Denver',
      captureTime: '2026-03-12T15:15:00Z',
      baseRevision,
      attachments: [{ manifestId: 'man-1', category: 'photo', filename: 'gauge-plate.jpg', captureTime: '2026-03-12T15:10:00Z', visibility: 'public', sizeBytes: 2048 }],
      payload: { streamId: STREAM, observedAt: '2026-03-12T15:15:00Z', value, unitId: 'cfs', note: 'airplane-mode capture' },
    },
    { currentBaseRevision: 12 },
  );
  if (result.kind !== 'queued') throw new Error(`fixture draft failed to queue: ${JSON.stringify(result)}`);
  (store as { persist(id: string, queue: unknown[]): void }).persist(ACCOUNT, result.queue);
}

test('offline drafts survive reload and synchronize exactly once through the real server domain', async () => {
  const store = webStore.createMemoryOfflineStore();
  const { deps, readingsStore, syncStore } = createServer();

  // Two offline captures (device offline): a reading at base revision 12
  // and a visit draft with a categorized attachment manifest.
  queueReading(store, 'd-int-reading');
  const visit = webOutbox.enqueueDraft<{ siteId: string; visitTime: string; type: string; actionIds: string[]; notes: string; attachments: unknown[] }>(
    [],
    {
      draftId: 'd-int-visit',
      accountId: ACCOUNT,
      actorId: ACTOR,
      kind: 'visit',
      siteId: SITE,
      streamId: null,
      deviceTimestamp: '2026-03-12T15:40:00Z',
      deviceZone: 'America/Denver',
      captureTime: '2026-03-12T15:30:00Z',
      baseRevision: 12,
      attachments: [{ manifestId: 'man-2', category: 'audio', filename: 'site-note.m4a', captureTime: '2026-03-12T15:25:00Z', visibility: 'internal', sizeBytes: 4096 }],
      payload: {
        siteId: SITE,
        visitTime: '2026-03-12T15:30:00Z',
        type: 'inspection',
        actionIds: ['gauge-inspection'],
        notes: 'offline inspection',
        lastChecked: '2026-03-12T15:00:00Z',
        lastRated: null,
        attachments: [{ category: 'wiring-note', visibility: 'internal', filename: 'wiring.txt', captureTime: '2026-03-12T15:20:00Z', note: 'RTU on east abutment.', sizeBytes: 31, content: 'RTU on east abutment.' }],
      },
    },
    { currentBaseRevision: 12 },
  );
  if (visit.kind !== 'queued') throw new Error('visit fixture failed to queue');
  store.persist(ACCOUNT, [...store.load(ACCOUNT), ...visit.queue]);

  // RELOAD: the orchestrator reads only what survived persistence.
  const reloaded = store.load(ACCOUNT);
  assert.equal(reloaded.length, 2, 'both drafts survived the reload');
  const visitEnvelope = reloaded.find((envelope) => envelope.draftId === 'd-int-visit')!;
  assert.equal(visitEnvelope.attachments[0]!.category, 'audio', 'attachment manifests survived');

  const observationsBefore = readingsStore.observations.length;
  const outcome = await webOutbox.syncOnReconnect(store, ACCOUNT, { now: RECONNECT, transport: serverTransport(deps, () => RECONNECT) });

  assert.equal(outcome.accepted.length, 2);
  assert.equal(readingsStore.observations.length, observationsBefore + 1, 'the reading committed exactly once');
  assert.equal(deps.visitStore.visits.length, 1, 'the visit committed exactly once');
  assert.equal(deps.visitStore.visits[0]!.attachments.length, 1);
  assert.equal(deps.visitStore.visits[0]!.attachments[0]!.category, 'wiring-note');
  assert.equal(syncStore.syncAuditEvents.length, 2);
  // Accepted states survive a further reload (FR-027 "shows status").
  assert.ok(store.load(ACCOUNT).every((envelope) => envelope.state === 'accepted'));
});

test('commit-before-ack crash against the real server: the re-send replays; exactly one record exists', async () => {
  const store = webStore.createMemoryOfflineStore();
  const { deps, readingsStore } = createServer();
  queueReading(store, 'd-int-crash');
  const observationsBefore = readingsStore.observations.length;

  // The server COMMITS, the acknowledgement is lost in transit.
  const crashingTransport = (envelope: OfflineEnvelope): SyncVerdict => {
    const verdict = serverTransport(deps, () => RECONNECT)(envelope);
    if (verdict.kind === 'accepted' && !verdict.replayed) {
      throw new Error('network error: acknowledgement lost after server commit');
    }
    return verdict;
  };
  const crashed = await webOutbox.syncOnReconnect(store, ACCOUNT, { now: RECONNECT, transport: crashingTransport });
  assert.equal(crashed.accepted.length, 0, 'the client never saw the ack');
  assert.equal(readingsStore.observations.length, observationsBefore + 1, 'but the server had committed');

  // Recovery: reload + reconnect re-sends with the SAME key; the server
  // replays its recorded result. Exactly one record exists either way.
  const recovered = await webOutbox.syncOnReconnect(store, ACCOUNT, { now: LATER, transport: serverTransport(deps, () => LATER) });
  assert.equal(recovered.accepted.length, 1);
  const recoveredDraft = recovered.accepted[0]!;
  assert.equal(recoveredDraft.replayed, true);
  assert.equal(readingsStore.observations.length, observationsBefore + 1, 'still exactly one row');
  const appended = readingsStore.observations[readingsStore.observations.length - 1]!;
  assert.equal(appended.id, recoveredDraft.acceptedRecordId);
});

test('a base-revision conflict against the real server preserves the draft verbatim for explicit resolution', async () => {
  const store = webStore.createMemoryOfflineStore();
  const { deps, readingsStore } = createServer();
  queueReading(store, 'd-int-conflict', 88.9, 12);
  const queuedPayload = store.load(ACCOUNT)[0]!.payload;

  // The stream's setup changed server-side while the device was offline.
  readingsStore.applyStreamSetupChange(STREAM);

  const outcome = await webOutbox.syncOnReconnect(store, ACCOUNT, { now: RECONNECT, transport: serverTransport(deps, () => RECONNECT) });
  assert.equal(outcome.conflicts.length, 1);
  const conflicted = outcome.conflicts[0]!;
  assert.equal(conflicted.conflict!.baseRevision, 12);
  assert.equal(conflicted.conflict!.currentRevision, 13);
  assert.deepEqual(conflicted.payload, queuedPayload, 'preserved verbatim, never merged');
  assert.equal(readingsStore.observations.filter((row) => row.value === 88.9).length, 0, 'nothing committed');

  // Explicit revision on the current revision, then a clean sync.
  const revised = webOutbox.resolveConflict<ReadingPayload>(store, ACCOUNT, 'd-int-conflict', {
    kind: 'revise',
    payload: { ...queuedPayload, note: 're-measured against setup v13' },
    currentRevision: 13,
  }, LATER);
  assert.equal(revised.kind, 'resolved');
  const synced = await webOutbox.syncOnReconnect(store, ACCOUNT, { now: '2026-03-12T20:00:00Z', transport: serverTransport(deps, () => '2026-03-12T20:00:00Z') });
  assert.equal(synced.accepted.length, 1);
  assert.equal(synced.accepted[0]!.replayed, false);
  assert.equal(readingsStore.observations.filter((row) => row.value === 88.9).length, 1);
});

test('server-side revocation the client does not know about: typed rejection, draft retained', async () => {
  const store = webStore.createMemoryOfflineStore();
  const { deps, readingsStore } = createServer();
  queueReading(store, 'd-int-revoked');

  // The entitlement was revoked while the device was offline; the client's
  // session has not learned it yet (no grant gate set).
  const revokedWorld = withEntitlement(readingsStore.world, 'ent-engineer-fatima', { status: 'revoked' });
  readingsStore.replaceWorldSnapshot(revokedWorld);

  const outcome = await webOutbox.syncOnReconnect(store, ACCOUNT, { now: RECONNECT, transport: serverTransport(deps, () => RECONNECT) });
  assert.equal(outcome.rejected.length, 1);
  const rejected = outcome.rejected[0]!;
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.rejection!.code, 'GRANT_REVOKED');
  assert.equal(rejected.rejection!.uploaded, true, 'the client tried; the server refused at sync time');
  assert.equal(readingsStore.observations.filter((row) => row.sourceId === ACTOR).length, 0);
  // Retained on the device for audit visibility.
  const retained = store.load(ACCOUNT).find((envelope) => envelope.draftId === 'd-int-revoked')!;
  assert.equal(retained.state, 'rejected');
  assert.equal(retained.rejection!.policyReason, 'DENY_ASSIGNMENT_REVOKED');
});

test('sign-out after a completed sync leaves the device with no account-cached data', async () => {
  const store = webStore.createMemoryOfflineStore();
  const { deps } = createServer();
  queueReading(store, 'd-int-cleanup');
  store.persist('acct-priya', []);
  await webOutbox.syncOnReconnect(store, ACCOUNT, { now: RECONNECT, transport: serverTransport(deps, () => RECONNECT) });
  assert.equal(store.load(ACCOUNT)[0]!.state, 'accepted');

  const report = webCleanup.signOut(store, ACCOUNT, LATER);
  assert.deepEqual(report.removedDraftIds, ['d-int-cleanup']);
  assert.deepEqual(store.load(ACCOUNT), []);
  assert.equal(webCleanup.hasAccountResidue(store, ACCOUNT), false);
  // The server keeps the record and its audit: the device copy is the only
  // thing cleared.
  assert.equal(deps.syncStore.syncAuditEvents.length, 1);
});
