/**
 * Account cleanup tests (WD-012-R2, FR-027): sign-out and account switch
 * clear exactly the account's cached offline data - no residue across
 * accounts, no mixing during a switch, accepted drafts cleared too.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/offline/cleanup.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../tests/ts-resolve-hook.mjs', import.meta.url);

const { createMemoryOfflineStore } = await import('./store');
const { ACCOUNT_DATA_CLEARANCE_POLICY, hasAccountResidue, signOut, switchAccount } = await import('./cleanup');
const { enqueueDraft } = await import('./outbox');
type OfflineEnvelope<P = unknown> = import('./store').OfflineEnvelope<P>;

const NOW = '2026-03-12T18:00:00Z';
const LATER = '2026-03-12T19:30:00Z';

interface ReadingPayload {
  readonly streamId: string;
  readonly observedAt: string;
  readonly value: number;
  readonly unitId: string;
}

function draft(accountId: string, draftId: string, note: string): OfflineEnvelope<ReadingPayload> {
  const result = enqueueDraft<ReadingPayload>(
    [],
    {
      draftId,
      accountId,
      actorId: accountId === 'acct-fatima' ? 'principal-fatima-engineer' : 'principal-priya-engineer',
      kind: 'reading',
      siteId: 'sta-bear-corinne',
      streamId: 'str-corinne-q',
      deviceTimestamp: '2026-03-12T15:30:00Z',
      deviceZone: 'America/Denver',
      captureTime: '2026-03-12T15:15:00Z',
      baseRevision: 4,
      attachments: [{ manifestId: 'man-1', category: 'photo', filename: `${note}.jpg`, captureTime: '2026-03-12T15:10:00Z', visibility: 'internal', sizeBytes: 2048 }],
      payload: { streamId: 'str-corinne-q', observedAt: '2026-03-12T15:15:00Z', value: 12.5, unitId: 'cfs' },
    },
    { currentBaseRevision: 4 },
  );
  if (result.kind !== 'queued') throw new Error(`fixture draft failed to queue: ${JSON.stringify(result)}`);
  return result.envelope;
}

test('sign-out clears the account\'s drafts, accepted or not, and leaves other accounts intact', () => {
  const store = createMemoryOfflineStore();
  store.persist('acct-fatima', [draft('acct-fatima', 'd-f1', 'fatima-1'), draft('acct-fatima', 'd-f2', 'fatima-2')]);
  store.persist('acct-priya', [draft('acct-priya', 'd-p1', 'priya-1')]);

  const report = signOut(store, 'acct-fatima', NOW);

  assert.equal(report.accountId, 'acct-fatima');
  assert.equal(report.reason, 'sign-out');
  assert.deepEqual(report.removedDraftIds, ['d-f1', 'd-f2']);
  assert.deepEqual(store.load('acct-fatima'), [], 'no residue for the signed-out account');
  assert.equal(hasAccountResidue(store, 'acct-fatima'), false);
  assert.equal(store.load('acct-priya').length, 1, 'the other account is untouched');
  assert.deepEqual([...store.accounts], ['acct-priya']);
});

test('account switch clears the outgoing account BEFORE loading the incoming queue (no mixing)', () => {
  const store = createMemoryOfflineStore();
  const outgoing = [draft('acct-fatima', 'd-f1', 'fatima-1')];
  const incoming = [draft('acct-priya', 'd-p1', 'priya-1'), draft('acct-priya', 'd-p2', 'priya-2')];
  store.persist('acct-fatima', outgoing);
  store.persist('acct-priya', incoming);

  const { cleared, loaded } = switchAccount(store, 'acct-fatima', 'acct-priya', LATER);

  assert.equal(cleared.reason, 'account-switch');
  assert.deepEqual(cleared.removedDraftIds, ['d-f1']);
  assert.deepEqual(store.load('acct-fatima'), []);
  assert.equal(loaded.length, 2);
  assert.ok(loaded.every((envelope) => envelope.accountId === 'acct-priya'), 'the loaded queue contains only the incoming account');
  assert.equal(hasAccountResidue(store, 'acct-fatima'), false, 'the outgoing account left nothing behind');
  assert.ok(
    !store.load('acct-priya').some((envelope) => envelope.accountId === 'acct-fatima'),
    'no foreign draft rode along into the incoming partition',
  );
});

test('a draft misattributed to another partition is still detected by the residue sweep', () => {
  const store = createMemoryOfflineStore();
  // Simulated tampering/corruption: a fatima draft parked in priya's partition.
  store.persist('acct-priya', [draft('acct-fatima', 'd-smuggled', 'smuggled')]);
  assert.equal(hasAccountResidue(store, 'acct-fatima'), true, 'residue detection looks at payloads, not partition names alone');
  const report = signOut(store, 'acct-fatima', NOW);
  // The partition belongs to priya: clearing fatima's partition cannot
  // touch it; the sweep keeps reporting it so the UI escalates instead of
  // silently trusting partition names.
  assert.equal(hasAccountResidue(store, 'acct-fatima'), true);
  assert.deepEqual(report.removedDraftIds, []);
});

test('accepted drafts are cleared too: the device keeps no account data after sign-out', () => {
  const store = createMemoryOfflineStore();
  const accepted: OfflineEnvelope<ReadingPayload> = {
    ...draft('acct-fatima', 'd-accepted', 'done'),
    state: 'accepted',
    acceptedRecordId: 'obs-entry-1001',
    acceptedAt: NOW,
  };
  store.persist('acct-fatima', [accepted]);
  signOut(store, 'acct-fatima', LATER);
  assert.deepEqual(store.load('acct-fatima'), [], 'even accepted drafts leave the device (server audit is the record)');
  assert.ok(ACCOUNT_DATA_CLEARANCE_POLICY.includes('offline drafts'), 'the policy line names what is cleared');
});

test('determinism: cleanup twice from identical stores yields identical reports', () => {
  function run() {
    const store = createMemoryOfflineStore();
    store.persist('acct-fatima', [draft('acct-fatima', 'd-1', 'a'), draft('acct-fatima', 'd-2', 'b')]);
    const report = signOut(store, 'acct-fatima', NOW);
    return JSON.stringify({ report, accounts: store.accounts, queue: store.load('acct-fatima') });
  }
  assert.equal(run(), run());
});
