/**
 * Sync acceptance tests (WD-012-R2, FR-027): the per-draft verdicts of the
 * sync endpoint against the REAL readings/visits workflows.
 *
 * Covered: acceptance + commit through the existing workflows, sync-ledger
 * replay, the commit-before-ack crash window (workflow committed, sync
 * ledger write lost), double-send within one batch, base-revision
 * conflicts (readings via setup epochs, visits via site edits), sync-time
 * revocation/expiry/delegation-expiry revalidation with typed rejections,
 * actor mismatch, validation mapping, quota with retryAfter, audit trail.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/sync/test/accept.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withEntitlement } from '../../../../../../packages/policy/src/index.ts';
import { createReadingsStore } from '../../readings/store.ts';
import { createVisitStore } from '../../visits/store.ts';
import { createPlaceholderAttachmentStorage } from '../../visits/attachments.ts';
import { submitManualReading } from '../../readings/manualEntry.ts';
import type { ManualEntryInput } from '../../readings/types.ts';
import { createSyncStore } from '../store.ts';
import { acceptDrafts, type SyncDeps } from '../accept.ts';
import type { OfflineSyncRequest, SyncVerdict } from '../types.ts';

const FATIMA = 'principal-fatima-engineer';
const ANA = 'principal-ana-deputy';
const SITE = 'sta-bear-corinne';
const STREAM = 'str-corinne-q';
const NOW = '2026-03-12T18:00:00Z';

interface ReadingPayload {
  readonly streamId: string;
  readonly observedAt: string;
  readonly value: number;
  readonly unitId: string;
  readonly note: string | null;
}

function readingRequest(overrides: Partial<OfflineSyncRequest> = {}, payloadOverrides: Partial<ReadingPayload> = {}): OfflineSyncRequest {
  const payload: ReadingPayload = {
    streamId: STREAM,
    observedAt: '2026-03-12T15:15:00Z',
    value: 21.5,
    unitId: 'cfs',
    note: 'airplane-mode capture',
    ...payloadOverrides,
  };
  return {
    draftId: 'd-reading-1',
    idempotencyKey: 'offline-reading-d-reading-1',
    actorId: FATIMA,
    kind: 'reading',
    siteId: SITE,
    streamId: STREAM,
    deviceTimestamp: '2026-03-12T15:30:00Z',
    deviceZone: 'America/Denver',
    captureTime: '2026-03-12T15:15:00Z',
    baseRevision: 12,
    attachments: [
      { manifestId: 'man-1', category: 'photo', filename: 'gauge-plate.jpg', captureTime: '2026-03-12T15:10:00Z', visibility: 'public', sizeBytes: 2048 },
      { manifestId: 'man-2', category: 'audio', filename: 'field-note.m4a', captureTime: '2026-03-12T15:12:00Z', visibility: 'internal', sizeBytes: 4096 },
    ],
    payload: payload as unknown as Record<string, unknown>,
    ...overrides,
  };
}

function visitRequest(overrides: Partial<OfflineSyncRequest> = {}): OfflineSyncRequest {
  return {
    draftId: 'd-visit-1',
    idempotencyKey: 'offline-visit-d-visit-1',
    actorId: FATIMA,
    kind: 'visit',
    siteId: SITE,
    streamId: null,
    deviceTimestamp: '2026-03-12T15:40:00Z',
    deviceZone: 'America/Denver',
    captureTime: '2026-03-12T15:30:00Z',
    baseRevision: 12,
    attachments: [{ manifestId: 'man-3', category: 'photo', filename: 'flume.jpg', captureTime: '2026-03-12T15:25:00Z', visibility: 'public', sizeBytes: 1024 }],
    payload: {
      siteId: SITE,
      visitTime: '2026-03-12T15:30:00Z',
      type: 'inspection',
      actionIds: ['gauge-inspection', 'measurement-taken'],
      notes: 'offline inspection with a complete sentence the user typed.',
      lastChecked: '2026-03-12T15:00:00Z',
      lastRated: null,
      attachments: [
        {
          category: 'photo',
          visibility: 'public',
          filename: 'gauge-plate.jpg',
          captureTime: '2026-03-12T15:10:00Z',
          sizeBytes: 2048,
          content: 'JPEG-bytes:gauge-plate',
        },
        {
          category: 'wiring-note',
          visibility: 'internal',
          filename: 'wiring.txt',
          captureTime: '2026-03-12T15:12:00Z',
          note: 'RTU enclosure on east abutment.',
          sizeBytes: 31,
          content: 'RTU enclosure on east abutment.',
        },
      ],
    } as unknown as Record<string, unknown>,
    ...overrides,
  };
}

function createDeps(quota?: number) {
  const readingsStore = createReadingsStore();
  const visitStore = createVisitStore();
  const syncStore = createSyncStore(quota === undefined ? undefined : { perActorDailySyncQuota: quota });
  const deps: SyncDeps = {
    syncStore,
    readingsStore,
    visitStore,
    attachmentStorage: createPlaceholderAttachmentStorage(),
  };
  return { deps, readingsStore, visitStore, syncStore };
}

function verdictOf(result: { verdicts: readonly SyncVerdict[] }, index = 0): SyncVerdict {
  return result.verdicts[index]!;
}

test('a reading draft commits through the manual-entry workflow exactly once', () => {
  const { deps, readingsStore, syncStore } = createDeps();
  const before = readingsStore.observations.length;
  const result = acceptDrafts(deps, FATIMA, [readingRequest()], { now: NOW });

  const verdict = verdictOf(result);
  assert.equal(verdict.kind, 'accepted');
  if (verdict.kind !== 'accepted') return;
  assert.equal(verdict.replayed, false);
  assert.equal(readingsStore.observations.length, before + 1);
  const appended = readingsStore.observations[readingsStore.observations.length - 1]!;
  assert.equal(appended.id, verdict.recordId);
  assert.equal(appended.value, 21.5);
  // The draft provenance is audited.
  assert.equal(syncStore.syncAuditEvents.length, 1);
  assert.equal(syncStore.syncAuditEvents[0]!.outcome, 'accepted');
  assert.equal(syncStore.syncAuditEvents[0]!.draftId, 'd-reading-1');
  assert.equal(syncStore.quotaUsed(FATIMA, NOW), 1);
});

test('a visit draft with categorized attachments commits through the visit workflow', () => {
  const { deps, visitStore } = createDeps();
  const result = acceptDrafts(deps, FATIMA, [visitRequest()], { now: NOW });
  const verdict = verdictOf(result);
  assert.equal(verdict.kind, 'accepted');
  if (verdict.kind !== 'accepted') return;
  assert.equal(visitStore.visits.length, 1);
  assert.equal(visitStore.visits[0]!.id, verdict.recordId);
  assert.equal(visitStore.visits[0]!.attachments.length, 2, 'categorized attachments landed with the visit');
  assert.equal(visitStore.visits[0]!.attachments[1]!.category, 'wiring-note');
  assert.equal(visitStore.visits[0]!.attachments[1]!.visibility, 'internal');
});

test('re-sending the same draft replays the recorded verdict and commits nothing new', () => {
  const { deps, readingsStore } = createDeps();
  const request = readingRequest();
  const first = acceptDrafts(deps, FATIMA, [request], { now: NOW });
  const firstVerdict = verdictOf(first);
  assert.equal(firstVerdict.kind, 'accepted');
  const afterFirst = readingsStore.observations.length;

  const second = acceptDrafts(deps, FATIMA, [request], { now: '2026-03-12T19:00:00Z' });
  const verdict = verdictOf(second);
  assert.equal(verdict.kind, 'accepted');
  if (verdict.kind !== 'accepted' || firstVerdict.kind !== 'accepted') return;
  assert.equal(verdict.replayed, true, 'the replay is marked');
  assert.equal(verdict.recordId, firstVerdict.recordId, 'the ORIGINAL record id comes back');
  assert.equal(readingsStore.observations.length, afterFirst, 'no duplicate row');
});

test('a double-send inside one batch replays the first verdict for the second copy', () => {
  const { deps, readingsStore } = createDeps();
  const before = readingsStore.observations.length;
  const request = readingRequest();
  const result = acceptDrafts(deps, FATIMA, [request, { ...request }], { now: NOW });
  assert.equal(result.verdicts.length, 2);
  assert.equal(verdictOf(result, 0).kind, 'accepted');
  const replay = verdictOf(result, 1);
  assert.equal(replay.kind, 'accepted');
  if (replay.kind !== 'accepted') return;
  assert.equal(replay.replayed, true);
  assert.equal(readingsStore.observations.length, before + 1, 'exactly one appended row despite the duplicate delivery');
});

test('crash AFTER commit BEFORE the sync-ledger write: the workflow ledger probe replays the commit', () => {
  const { deps, readingsStore } = createDeps();
  const request = readingRequest();
  // The workflow committed (its ledger row exists) but the sync ledger
  // write never happened - the process died between commit and ack.
  const committed = submitManualReading(readingsStore, FATIMA, request.payload as unknown as ManualEntryInput, { now: '2026-03-12T17:59:00Z', idempotencyKey: request.idempotencyKey });
  assert.equal(committed.outcome, 'applied');
  const afterCommit = readingsStore.observations.length;

  const result = acceptDrafts(deps, FATIMA, [request], { now: NOW });
  const verdict = verdictOf(result);
  assert.equal(verdict.kind, 'accepted');
  if (verdict.kind !== 'accepted') return;
  assert.equal(verdict.replayed, true, 'the probe surfaced the recorded commit');
  assert.equal(readingsStore.observations.length, afterCommit, 'still exactly one row');
  // And the repaired sync ledger now answers replays directly.
  assert.ok(deps.syncStore.lookupLedger(request.idempotencyKey) !== null);
});

test('a moved stream setup version conflicts; the draft is never merged or committed', () => {
  const { deps, readingsStore } = createDeps();
  deps.readingsStore.applyStreamSetupChange(STREAM); // WD-010 setup epoch: 12 -> 13
  const result = acceptDrafts(deps, FATIMA, [readingRequest()], { now: NOW });
  const verdict = verdictOf(result);
  assert.equal(verdict.kind, 'conflict');
  if (verdict.kind !== 'conflict') return;
  assert.equal(verdict.baseRevision, 12);
  assert.equal(verdict.currentRevision, 13);
  assert.equal(readingsStore.observations.filter((row) => row.sourceId === FATIMA).length, 0, 'nothing committed for the conflicted draft');
  // A conflict is not terminal under the key: an explicit revision against
  // the current state may retry with the SAME idempotency key.
  const revised = acceptDrafts(deps, FATIMA, [readingRequest({ baseRevision: 13 })], { now: '2026-03-12T19:00:00Z' });
  assert.equal(verdictOf(revised).kind, 'accepted');
});

test('a moved site revision conflicts a visit draft the same way', () => {
  const { deps, syncStore, visitStore } = createDeps();
  syncStore.applySiteChange(SITE); // WD-010 site edit mirror: 12 -> 13
  const result = acceptDrafts(deps, FATIMA, [visitRequest()], { now: NOW });
  const verdict = verdictOf(result);
  assert.equal(verdict.kind, 'conflict');
  assert.equal(visitStore.visits.length, 0);
});

test('a REVOKED grant is revalidated at sync time: typed GRANT_REVOKED, nothing committed, terminal', () => {
  const { deps, readingsStore, syncStore } = createDeps();
  const revokedWorld = withEntitlement(readingsStore.world, 'ent-engineer-fatima', { status: 'revoked' });
  // The readings store's world is authoritative for reading drafts (the
  // workflow evaluates against it at commit time too).
  readingsStore.replaceWorldSnapshot(revokedWorld);

  const result = acceptDrafts(deps, FATIMA, [readingRequest()], { now: NOW });
  const verdict = verdictOf(result);
  assert.equal(verdict.kind, 'rejected');
  if (verdict.kind !== 'rejected') return;
  assert.equal(verdict.code, 'GRANT_REVOKED');
  assert.equal(verdict.policyReason, 'DENY_ASSIGNMENT_REVOKED');
  assert.equal(readingsStore.observations.filter((row) => row.sourceId === FATIMA).length, 0, 'revoked offline drafts must not upload (no commit)');
  assert.ok(syncStore.lookupLedger('offline-reading-d-reading-1') !== null, 'the rejection is ledgered (terminal under the key)');

  // Re-sending stays rejected - even if the world snapshot is repaired
  // later, this draft's verdict is history (a NEW capture gets a new key).
  const again = acceptDrafts(deps, FATIMA, [readingRequest()], { now: '2026-03-12T19:00:00Z' });
  const replay = verdictOf(again);
  assert.equal(replay.kind, 'rejected');
  if (replay.kind !== 'rejected') return;
  assert.equal(replay.code, 'GRANT_REVOKED');
});

test('an EXPIRED assignment at sync time is typed GRANT_EXPIRED (deputy window closed)', () => {
  const { deps, readingsStore } = createDeps();
  // The deputy's ASSIGNMENT expired 2026-06-30; extend the delegation past
  // it so the engine names the assignment (not the delegation) as the
  // binding expiry, then reconnect in July.
  const world = withEntitlement(readingsStore.world, 'ent-deputy-ana', {
    delegation: { effectiveAt: '2026-03-01T07:00:00Z', expiresAt: '2026-12-31T23:59:59Z', delegatedBy: 'principal-cody-commissioner' },
  });
  readingsStore.replaceWorldSnapshot(world);
  const result = acceptDrafts(deps, ANA, [readingRequest({ actorId: ANA, idempotencyKey: 'offline-reading-d-ana', draftId: 'd-ana' })], { now: '2026-07-01T14:00:00Z' });
  const verdict = verdictOf(result);
  assert.equal(verdict.kind, 'rejected');
  if (verdict.kind !== 'rejected') return;
  assert.equal(verdict.code, 'GRANT_EXPIRED');
  assert.equal(verdict.policyReason, 'DENY_ASSIGNMENT_EXPIRED');
  assert.equal(readingsStore.observations.filter((row) => row.sourceId === ANA).length, 0);
});

test('a closed DELEGATION window is typed DELEGATION_EXPIRED', () => {
  const { deps, readingsStore } = createDeps();
  // The fixture delegation itself closed 2026-03-01 (before NOW): the
  // delegation is the authoritative tighter bound for a deputy.
  const world = withEntitlement(readingsStore.world, 'ent-deputy-ana', {
    delegation: { effectiveAt: '2026-01-01T00:00:00Z', expiresAt: '2026-03-01T00:00:00Z', delegatedBy: 'principal-diego-steward' },
  });
  readingsStore.replaceWorldSnapshot(world);
  const result = acceptDrafts(deps, ANA, [readingRequest({ actorId: ANA, idempotencyKey: 'offline-reading-d-ana2', draftId: 'd-ana2' })], { now: NOW });
  const verdict = verdictOf(result);
  assert.equal(verdict.kind, 'rejected');
  if (verdict.kind !== 'rejected') return;
  assert.equal(verdict.code, 'DELEGATION_EXPIRED');
  assert.equal(verdict.policyReason, 'DENY_DELEGATION_EXPIRED');
});

test('a draft whose actor is not the session actor is rejected ACTOR_MISMATCH without upload', () => {
  const { deps, readingsStore } = createDeps();
  const result = acceptDrafts(deps, ANA, [readingRequest({ actorId: FATIMA })], { now: NOW });
  const verdict = verdictOf(result);
  assert.equal(verdict.kind, 'rejected');
  if (verdict.kind !== 'rejected') return;
  assert.equal(verdict.code, 'ACTOR_MISMATCH');
  assert.equal(readingsStore.observations.filter((row) => row.sourceId === FATIMA).length, 0);
  // Not ledgered: the legitimate session may still send its own draft.
  const own = acceptDrafts(deps, FATIMA, [readingRequest()], { now: NOW });
  assert.equal(verdictOf(own).kind, 'accepted');
});

test('an unknown target maps to a typed NOT_FOUND verdict', () => {
  const { deps } = createDeps();
  const result = acceptDrafts(deps, FATIMA, [readingRequest({ streamId: 'str-nope', idempotencyKey: 'offline-reading-d-unknown' })], { now: NOW });
  const verdict = verdictOf(result);
  assert.equal(verdict.kind, 'rejected');
  if (verdict.kind !== 'rejected') return;
  assert.equal(verdict.code, 'NOT_FOUND');
});

test('a validation failure maps to VALIDATION_FAILED with field paths; nothing commits', () => {
  const { deps, readingsStore } = createDeps();
  const result = acceptDrafts(
    deps,
    FATIMA,
    [readingRequest({}, { value: 9999, observedAt: '2026-03-12T15:15:00' })], // out of range + naive time
    { now: NOW },
  );
  const verdict = verdictOf(result);
  assert.equal(verdict.kind, 'rejected');
  if (verdict.kind !== 'rejected') return;
  assert.equal(verdict.code, 'VALIDATION_FAILED');
  assert.match(verdict.message, /VALUE_OUT_OF_RANGE/);
  assert.match(verdict.message, /OFFSET_REQUIRED/);
  assert.equal(readingsStore.observations.filter((row) => row.sourceId === FATIMA).length, 0);
});

test('quota: beyond the daily budget the verdict is retryable (not rejected), with retryAfter; a later retry commits', () => {
  const { deps, readingsStore, syncStore } = createDeps(2);
  const first = acceptDrafts(deps, FATIMA, [readingRequest({ draftId: 'd-q1', idempotencyKey: 'offline-reading-d-q1' }, { observedAt: '2026-03-12T15:15:00Z' })], { now: NOW });
  const second = acceptDrafts(deps, FATIMA, [readingRequest({ draftId: 'd-q2', idempotencyKey: 'offline-reading-d-q2' }, { observedAt: '2026-03-12T15:20:00Z' })], { now: NOW });
  assert.equal(verdictOf(first).kind, 'accepted');
  assert.equal(verdictOf(second).kind, 'accepted');
  assert.equal(syncStore.quotaUsed(FATIMA, NOW), 2);

  const third = acceptDrafts(deps, FATIMA, [readingRequest({ draftId: 'd-q3', idempotencyKey: 'offline-reading-d-q3' }, { observedAt: '2026-03-12T15:25:00Z' })], { now: NOW });
  const quotaVerdict = verdictOf(third);
  assert.equal(quotaVerdict.kind, 'quota');
  if (quotaVerdict.kind !== 'quota') return;
  assert.equal(quotaVerdict.retryAfter, '2026-03-13T00:00:00Z');
  assert.match(quotaVerdict.message, /2\/2/);
  assert.equal(syncStore.lookupLedger('offline-reading-d-q3'), null, 'quota is not terminal under the key');
  assert.equal(readingsStore.observations.filter((row) => row.sourceId === FATIMA).length, 2);

  // The same draft, retried after the budget window, commits.
  const retried = acceptDrafts(deps, FATIMA, [readingRequest({ draftId: 'd-q3', idempotencyKey: 'offline-reading-d-q3' }, { observedAt: '2026-03-12T15:25:00Z' })], { now: '2026-03-13T14:00:00Z' });
  assert.equal(verdictOf(retried).kind, 'accepted');
});

test('every verdict lands in the audit trail with draft provenance', () => {
  const { deps, syncStore } = createDeps(1);
  acceptDrafts(deps, FATIMA, [
    readingRequest({ draftId: 'd-a', idempotencyKey: 'offline-reading-d-a' }),
    readingRequest({ draftId: 'd-b', idempotencyKey: 'offline-reading-d-b' }, { observedAt: '2026-03-12T16:00:00Z' }),
    readingRequest({ draftId: 'd-c', idempotencyKey: 'offline-reading-d-c' }, { observedAt: '2026-03-12T16:30:00Z' }),
  ], { now: NOW });
  const outcomes = syncStore.syncAuditEvents.map((event) => `${event.draftId}:${event.outcome}`);
  assert.deepEqual(outcomes, ['d-a:accepted', 'd-b:quota', 'd-c:quota']);
  assert.ok(syncStore.syncAuditEvents.every((event) => event.actorId === FATIMA && event.siteId === SITE));
  assert.ok(syncStore.syncAuditEvents.every((event) => event.idempotencyKey.startsWith('offline-reading-')));
});
