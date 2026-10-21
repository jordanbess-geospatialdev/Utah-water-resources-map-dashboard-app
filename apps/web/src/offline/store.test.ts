/**
 * Offline store tests (WD-012-R2, FR-027): the envelope survives a
 * persistence round-trip byte-for-byte (reload survival starts here),
 * partitions are account-scoped, and clearByAccount removes exactly one
 * account's data.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/offline/store.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../tests/ts-resolve-hook.mjs', import.meta.url);

const storeModule = await import('./store');
const {
  ENVELOPE_SCHEMA_VERSION,
  createMemoryOfflineStore,
  isPersistenceSafe,
  migrateEnvelopes,
} = storeModule;
type OfflineEnvelope = import('./store').OfflineEnvelope;

const NOW = '2026-03-12T15:30:00Z';

/** A complete, representative envelope: reading draft with a photo + audio manifest. */
function sampleEnvelope(draftId: string, accountId: string): OfflineEnvelope {
  return {
    draftId,
    idempotencyKey: `offline-reading-${draftId}`,
    accountId,
    actorId: 'principal-fatima-engineer',
    kind: 'reading',
    siteId: 'sta-bear-corinne',
    streamId: 'str-corinne-q',
    deviceTimestamp: NOW,
    deviceZone: 'America/Denver',
    captureTime: '2026-03-12T15:15:00Z',
    baseRevision: 4,
    attachments: [
      { manifestId: 'man-1', category: 'photo', filename: 'gauge-plate.jpg', captureTime: '2026-03-12T15:10:00Z', visibility: 'public', sizeBytes: 2048, digest: 'fnv1a-00000001' },
      { manifestId: 'man-2', category: 'audio', filename: 'site-note.m4a', captureTime: '2026-03-12T15:12:00Z', visibility: 'internal', sizeBytes: 8192, digest: 'fnv1a-00000002' },
    ],
    payload: { streamId: 'str-corinne-q', observedAt: '2026-03-12T15:15:00Z', value: 142.6, unitId: 'cfs', methodTypeId: null, note: 'airplane mode capture' },
    state: 'queued',
    attempts: 0,
    lastError: null,
    queuedAt: NOW,
    syncingSince: null,
    acceptedRecordId: null,
    acceptedAt: null,
    replayed: false,
    conflict: null,
    rejection: null,
    revisions: 0,
    lastTransitionAt: NOW,
  };
}

test('an envelope round-trips through the store byte-for-byte (reload survival)', () => {
  const store = createMemoryOfflineStore();
  const envelope = sampleEnvelope('d-1001', 'acct-fatima');
  store.persist('acct-fatima', [envelope]);

  const reloaded = store.load('acct-fatima');
  assert.equal(reloaded.length, 1);
  // Deep equality with the ORIGINAL object: persistence did not re-encode,
  // drop or reorder anything the offline capture recorded.
  assert.deepEqual(reloaded[0], envelope);
  // And a second reload is stable (idempotent reads).
  assert.deepEqual(store.load('acct-fatima'), reloaded);
});

test('load of an unknown account is an empty queue, not an error', () => {
  const store = createMemoryOfflineStore();
  assert.deepEqual(store.load('acct-nobody'), []);
  assert.deepEqual([...store.accounts], []);
});

test('partitions are account-scoped: one account never sees another\'s drafts', () => {
  const store = createMemoryOfflineStore();
  store.persist('acct-fatima', [sampleEnvelope('d-1', 'acct-fatima')]);
  store.persist('acct-priya', [sampleEnvelope('d-2', 'acct-priya'), sampleEnvelope('d-3', 'acct-priya')]);

  assert.equal(store.load('acct-fatima').length, 1);
  assert.equal(store.load('acct-priya').length, 2);
  assert.equal(store.load('acct-fatima')[0]!.accountId, 'acct-fatima');
  assert.ok(store.load('acct-priya').every((envelope) => envelope.accountId === 'acct-priya'));
  assert.deepEqual([...store.accounts], ['acct-fatima', 'acct-priya']);
});

test('clearByAccount removes exactly one partition; the other survives intact', () => {
  const store = createMemoryOfflineStore();
  const fatima = sampleEnvelope('d-1', 'acct-fatima');
  const priya = sampleEnvelope('d-2', 'acct-priya');
  store.persist('acct-fatima', [fatima]);
  store.persist('acct-priya', [priya]);

  store.clearByAccount('acct-fatima');
  assert.deepEqual(store.load('acct-fatima'), [], 'the cleared account has no residue');
  assert.deepEqual(store.load('acct-priya'), [priya], 'the other account is untouched');
  assert.deepEqual([...store.accounts], ['acct-priya']);
});

test('isPersistenceSafe flags what JSON serialization would silently lose', () => {
  assert.equal(isPersistenceSafe(sampleEnvelope('d-9', 'a')), true);
  assert.equal(isPersistenceSafe({ at: new Date(NOW) }), false, 'Date objects do not survive JSON');
  assert.equal(isPersistenceSafe({ fn: () => 1 }), false, 'functions do not survive JSON');
  assert.equal(isPersistenceSafe({ optional: undefined }), false, 'undefined-valued keys vanish in JSON');
});

test('every envelope state serializes cleanly (queued/syncing/accepted/conflict/rejected)', () => {
  const base = sampleEnvelope('d-states', 'acct-fatima');
  const states: readonly OfflineEnvelope[] = [
    base,
    { ...base, state: 'syncing', syncingSince: NOW, attempts: 1 },
    { ...base, state: 'accepted', acceptedRecordId: 'obs-entry-1001', acceptedAt: NOW, replayed: false },
    {
      ...base,
      state: 'conflict',
      conflict: { reason: 'BASE_REVISION_MOVED', baseRevision: 4, currentRevision: 5, detectedAt: NOW, message: 'moved' },
    },
    {
      ...base,
      state: 'rejected',
      rejection: { code: 'GRANT_REVOKED', message: 'revoked at sync', policyReason: 'DENY_ASSIGNMENT_REVOKED', rejectedAt: NOW, uploaded: false },
    },
  ];
  const store = createMemoryOfflineStore();
  store.persist('acct-fatima', states);
  assert.deepEqual(store.load('acct-fatima'), states);
  for (const envelope of states) {
    assert.equal(isPersistenceSafe(envelope), true, `state ${envelope.state} must be persistence-safe`);
  }
});

test('migrateEnvelopes quarantines unknown schema versions instead of dropping them silently', () => {
  const loaded = [sampleEnvelope('d-old', 'acct-fatima')];
  const same = migrateEnvelopes(loaded, ENVELOPE_SCHEMA_VERSION);
  assert.deepEqual(same.envelopes, loaded);
  assert.deepEqual(same.quarantined, []);

  const older = migrateEnvelopes(loaded, ENVELOPE_SCHEMA_VERSION - 1);
  assert.deepEqual(older.envelopes, [], 'an older queue is not silently reinterpreted');
  assert.deepEqual(older.quarantined, loaded, 'the drafts are surfaced for an explicit decision');
});
