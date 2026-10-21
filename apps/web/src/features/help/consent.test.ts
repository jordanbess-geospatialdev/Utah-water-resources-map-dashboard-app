/**
 * Consent persistence tests (WD-020; FR-017).
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/help/consent.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Static .ts imports are not allowed by the web tsc program; follow the
// shareUrl.test.ts convention (extensionless type import + dynamic runtime
// import, which node --test --experimental-strip-types resolves directly).
const consentPath = './consent.ts';
const c: typeof import('./consent') = await import(consentPath);

const { ANALYTICS_POLICY_VERSION, clearConsent, consentStatus, consentStorageKey, inMemoryStorage, localStorageAdapter, readConsent, recordConsent } = c;

const SARAH = 'principal-sarah-researcher';
const CODY = 'principal-cody-commissioner';
const NOW = '2026-10-21T15:00:00Z';

test('default status is unanswered: consent is opt-in, never assumed', () => {
  const storage = inMemoryStorage();
  assert.equal(consentStatus(storage, SARAH), 'unanswered');
  assert.equal(readConsent(storage, SARAH), null);
});

test('grant and withdrawal persist per account with the policy version they answered', () => {
  const storage = inMemoryStorage();
  recordConsent(storage, { accountId: SARAH, granted: true, now: NOW });
  recordConsent(storage, { accountId: CODY, granted: false, now: NOW });

  assert.equal(consentStatus(storage, SARAH), 'granted');
  assert.equal(consentStatus(storage, CODY), 'withheld');
  assert.deepEqual(readConsent(storage, SARAH), {
    accountId: SARAH,
    granted: true,
    decidedAt: NOW,
    policyVersion: ANALYTICS_POLICY_VERSION,
  });
  // Per-account keys: one account's decision never answers for another.
  assert.notEqual(consentStorageKey(SARAH), consentStorageKey(CODY));
});

test('a stale policy version is unanswered: consent is re-asked, never inherited', () => {
  const storage = inMemoryStorage();
  recordConsent(storage, { accountId: SARAH, granted: true, now: NOW, policyVersion: '2020-01-01.0' });
  assert.equal(consentStatus(storage, SARAH), 'unanswered');
  // Answering again under the current policy upgrades the record.
  recordConsent(storage, { accountId: SARAH, granted: true, now: NOW });
  assert.equal(consentStatus(storage, SARAH), 'granted');
});

test('corrupt persistence is unanswered, never guessed', () => {
  const storage = inMemoryStorage({ [consentStorageKey(SARAH)]: '{not json' });
  assert.equal(readConsent(storage, SARAH), null);
  assert.equal(consentStatus(storage, SARAH), 'unanswered');

  const malformed = inMemoryStorage({ [consentStorageKey(SARAH)]: JSON.stringify({ accountId: SARAH }) });
  assert.equal(readConsent(malformed, SARAH), null);
});

test('clearConsent removes the decision (logout / account switch)', () => {
  const storage = inMemoryStorage();
  recordConsent(storage, { accountId: SARAH, granted: true, now: NOW });
  clearConsent(storage, SARAH);
  assert.equal(consentStatus(storage, SARAH), 'unanswered');
  clearConsent(storage, SARAH); // idempotent
});

test('localStorage adapter falls back to null when the platform has none', () => {
  // The test runner has no DOM localStorage; the adapter must degrade, not throw.
  const adapter = localStorageAdapter();
  assert.ok(adapter === null || typeof adapter.getItem === 'function');
});

test('persistence round trip survives a fresh storage seeded from the written value', () => {
  const first = inMemoryStorage();
  recordConsent(first, { accountId: SARAH, granted: true, now: NOW });
  const raw = first.getItem(consentStorageKey(SARAH))!;

  const second = inMemoryStorage({ [consentStorageKey(SARAH)]: raw });
  assert.equal(consentStatus(second, SARAH), 'granted');
  assert.deepEqual(readConsent(second, SARAH), readConsent(first, SARAH));
});
