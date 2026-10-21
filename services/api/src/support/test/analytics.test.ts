/**
 * Consent-gated analytics tests (WD-020; FR-017, FR-068).
 *
 * Run (zero dependencies):
 *   cd services/api && node --test --experimental-strip-types src/support/test/analytics.test.ts
 *
 * Pins:
 * - NO event is recorded without explicit, current-policy consent; refusal
 *   stores nothing (not even a "denied" placeholder).
 * - The static field allowlist: hostile extra fields drop the WHOLE event;
 *   query VALUES never travel (dimension keys only); free text has no field
 *   to live in.
 * - Withdrawal stops collection on the very next call and DELETES pending
 *   raw events in the same call; consent is per account and per policy
 *   version (a stale policy version re-asks, never inherits).
 * - Proposed retention windows (90 days raw / 13 months aggregated - PENDING
 *   owner decision in docs/training/PRIVACY-PROPOSAL.md) are implemented,
 *   not aspirational: purge drops exactly the expired events.
 * - Reporting days key on the program zone (America/Denver), not the
 *   submitter's browser clock.
 * - Determinism: identical drives serialize byte-identically (twice).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANALYTICS_POLICY_VERSION,
  consentStorageKey,
  createAnalyticsService,
  inMemoryConsentStorage,
  programDayKey,
  RAW_RETENTION_DAYS,
  readConsent,
  type AnalyticsEvent,
} from '../analytics.ts';

const SARAH = 'principal-sarah-researcher';
const CODY = 'principal-cody-commissioner';
const ACCOUNTS = [SARAH, CODY];

const NOW = '2026-10-21T15:00:00Z'; // 15:00 UTC = 09:00 America/Denver (MDT, UTC-6)

function stepClock(start = Date.parse(NOW), stepMs = 60_000): () => string {
  let current = start - stepMs;
  return () => new Date((current += stepMs)).toISOString();
}

function service(clock = stepClock(), seed?: Record<string, string>) {
  return createAnalyticsService({ knownAccountIds: ACCOUNTS, clock, storage: inMemoryConsentStorage(seed) });
}

const pageView: AnalyticsEvent = { kind: 'page-view', routeId: 'discovery', dimensionKeys: ['distributionSystemIds', 'telemetry'] };
const taskDone: AnalyticsEvent = { kind: 'task-completed', routeId: 'help', taskStepId: 'pub-filter-sites' };

test('no consent: nothing recorded, nothing stored, for every event kind', () => {
  const analytics = service();
  assert.deepEqual(analytics.recordEvent(SARAH, pageView), { recorded: false, reason: 'consent-required' });
  assert.deepEqual(analytics.recordEvent(SARAH, taskDone), { recorded: false, reason: 'consent-required' });
  assert.deepEqual(analytics.recordEvent(CODY, pageView), { recorded: false, reason: 'consent-required' });
  assert.equal(analytics.pendingEvents(SARAH).length, 0);
  assert.equal(analytics.serialize(), '{"policyVersion":"2026-10-21.1","rawEvents":[]}');
});

test('unknown accounts never record, with or without consent', () => {
  const analytics = service();
  assert.ok(analytics.grantConsent(SARAH).ok);
  assert.deepEqual(analytics.recordEvent('principal-unknown-actor', pageView), { recorded: false, reason: 'unknown-account' });
  assert.deepEqual(analytics.grantConsent('principal-unknown-actor'), { ok: false, reason: 'unknown-account' });
});

test('consent granted: allowlisted events record; the service clock wins over caller timestamps', () => {
  const clock = stepClock();
  const analytics = service(clock);
  analytics.grantConsent(SARAH);

  const first = analytics.recordEvent(SARAH, { ...pageView, occurredAt: '2000-01-01T00:00:00Z' });
  assert.ok(first.recorded);
  assert.ok(first.event.occurredAt.startsWith('2026-10-21T15:'), `service clock won: ${first.event.occurredAt}`);
  assert.notEqual(first.event.occurredAt, '2000-01-01T00:00:00.000Z', 'caller-supplied occurredAt is overwritten');
  assert.equal(first.event.day, '2026-10-21');
  assert.deepEqual(first.event.dimensionKeys, ['distributionSystemIds', 'telemetry'], 'dimension keys travel sorted; values never do');

  const second = analytics.recordEvent(SARAH, taskDone);
  assert.ok(second.recorded);
  assert.equal(analytics.pendingEvents(SARAH).length, 2);
});

test('static allowlist: hostile extra fields drop the WHOLE event; no partial records', () => {
  const analytics = service();
  analytics.grantConsent(SARAH);

  const hostile = { ...pageView, persona: 'steward', credentials: 'uwdat_x', screenshot: 'data:image/png;base64,AAAA', freeText: 'searched for Bear River' } as unknown as AnalyticsEvent;
  const outcome = analytics.recordEvent(SARAH, hostile);
  assert.ok(!outcome.recorded);
  assert.equal(outcome.reason, 'field-not-allowed');
  assert.equal((outcome as { detail?: string }).detail, 'persona,credentials,screenshot,freeText');

  const badKind = analytics.recordEvent(SARAH, { kind: 'session-replay' } as unknown as AnalyticsEvent);
  assert.ok(!badKind.recorded);
  assert.equal(badKind.reason, 'field-not-allowed');

  assert.equal(analytics.pendingEvents(SARAH).length, 0, 'nothing was stored from the hostile events');
});

test('field value shapes: governed ids and dimension KEYS only', () => {
  const analytics = service();
  analytics.grantConsent(SARAH);

  assert.equal(analytics.recordEvent(SARAH, { kind: 'page-view', routeId: 'Not A Route!' }).reason, 'bad-field-value');
  assert.equal(analytics.recordEvent(SARAH, { kind: 'task-completed', routeId: 'help', taskStepId: 'STOP-1' }).reason, 'bad-field-value');
  // A filter VALUE smuggled into dimensionKeys is not a known dimension key.
  assert.equal(analytics.recordEvent(SARAH, { kind: 'page-view', routeId: 'discovery', dimensionKeys: ['sys-bear-river'] }).reason, 'bad-field-value');
  assert.equal(analytics.pendingEvents(SARAH).length, 0);
});

test('withdrawal stops collection immediately and deletes pending events in the same call', () => {
  const analytics = service();
  analytics.grantConsent(SARAH);
  assert.ok(analytics.recordEvent(SARAH, pageView).recorded);
  assert.ok(analytics.recordEvent(SARAH, taskDone).recorded);
  assert.equal(analytics.pendingEvents(SARAH).length, 2);

  const withdrawal = analytics.withdrawConsent(SARAH);
  assert.ok(withdrawal.ok);
  assert.equal(withdrawal.deletedPendingEvents, 2);
  assert.equal(analytics.pendingEvents(SARAH).length, 0);

  // The very next event is refused and nothing is stored.
  assert.deepEqual(analytics.recordEvent(SARAH, pageView), { recorded: false, reason: 'consent-required' });
  assert.equal(analytics.pendingEvents(SARAH).length, 0);

  // Re-granting starts from a clean slate of events (deleted stays deleted).
  analytics.grantConsent(SARAH);
  assert.equal(analytics.pendingEvents(SARAH).length, 0);
  assert.ok(analytics.recordEvent(SARAH, pageView).recorded);
  assert.equal(analytics.pendingEvents(SARAH).length, 1);
});

test('consent is per account: one withdrawal never touches another account', () => {
  const analytics = service();
  analytics.grantConsent(SARAH);
  analytics.grantConsent(CODY);
  assert.ok(analytics.recordEvent(SARAH, pageView).recorded);
  assert.ok(analytics.recordEvent(CODY, pageView).recorded);

  analytics.withdrawConsent(SARAH);
  assert.equal(analytics.pendingEvents(SARAH).length, 0);
  assert.equal(analytics.pendingEvents(CODY).length, 1);
  assert.ok(analytics.recordEvent(CODY, taskDone).recorded, 'Cody keeps collecting under his own consent');
});

test('consent is persisted per account and versioned against the policy it answered', () => {
  const storage = inMemoryConsentStorage();
  const analytics = service(stepClock(), undefined);
  void analytics;
  const second = createAnalyticsService({ knownAccountIds: ACCOUNTS, clock: stepClock(), storage });
  const granted = second.grantConsent(SARAH);
  assert.ok(granted.ok);
  assert.equal(granted.record.policyVersion, ANALYTICS_POLICY_VERSION);
  assert.ok(storage.getItem(consentStorageKey(SARAH))!.includes('"granted":true'));

  // A fresh service over the same storage reads the same consent (persistence).
  const third = createAnalyticsService({ knownAccountIds: ACCOUNTS, clock: stepClock(), storage });
  assert.deepEqual(third.consentFor(SARAH), second.consentFor(SARAH));
  assert.ok(third.recordEvent(SARAH, pageView).recorded);

  // A stale policy version is treated as ABSENT consent: re-ask, never inherit.
  const stale = inMemoryConsentStorage({
    [consentStorageKey(SARAH)]: JSON.stringify({ accountId: SARAH, granted: true, decidedAt: NOW, policyVersion: '2020-01-01.0' }),
  });
  const staleService = createAnalyticsService({ knownAccountIds: ACCOUNTS, clock: stepClock(), storage: stale });
  assert.deepEqual(staleService.recordEvent(SARAH, pageView), { recorded: false, reason: 'consent-required' });

  // Corrupt persistence is consent ABSENT, never guessed.
  const corrupt = inMemoryConsentStorage({ [consentStorageKey(SARAH)]: '{not json' });
  assert.equal(readConsent(corrupt, SARAH), null);
});

test('proposed retention (PENDING owner): 90-day raw purge drops exactly the expired events', () => {
  const analytics = service(stepClock());
  analytics.grantConsent(SARAH);

  const oldNow = Date.parse(NOW) - (RAW_RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000;
  const injectedOld = createAnalyticsService({
    knownAccountIds: ACCOUNTS,
    clock: () => new Date(oldNow).toISOString(),
    storage: inMemoryConsentStorage({ [consentStorageKey(SARAH)]: JSON.stringify({ accountId: SARAH, granted: true, decidedAt: NOW, policyVersion: ANALYTICS_POLICY_VERSION }) }),
  });
  assert.ok(injectedOld.recordEvent(SARAH, pageView).recorded);

  // The current service over the same clock records a fresh event.
  assert.ok(analytics.recordEvent(SARAH, taskDone).recorded);

  // Purge inside the old service: its 95-day-old event is dropped.
  assert.equal(injectedOld.purgeExpiredRaw(NOW), 1);
  assert.equal(injectedOld.pendingEvents(SARAH).length, 0);
});

test('aggregates carry no account ids and key on program-zone days', () => {
  const analytics = service();
  analytics.grantConsent(SARAH);
  analytics.grantConsent(CODY);
  assert.ok(analytics.recordEvent(SARAH, pageView).recorded);
  assert.ok(analytics.recordEvent(CODY, pageView).recorded);

  const aggregates = analytics.dailyAggregates();
  assert.equal(aggregates.length, 1);
  assert.equal(aggregates[0]!.count, 2);
  assert.equal(aggregates[0]!.day, '2026-10-21');
  assert.ok(!JSON.stringify(aggregates).includes(SARAH), 'aggregates never carry account ids');

  // 2026-10-21 15:00 UTC is 09:00 America/Denver: same program day.
  assert.equal(programDayKey('2026-10-22T01:00:00Z'), '2026-10-21', '23:00 MDT boundary stays on the Denver day');
  assert.equal(programDayKey('2026-10-22T07:00:00Z'), '2026-10-22', '01:00 MDT next Denver day');
});

test('determinism: identical drives serialize byte-identically (twice)', () => {
  const drive = (): string => {
    const clock = stepClock();
    const analytics = service(clock);
    analytics.grantConsent(SARAH);
    analytics.recordEvent(SARAH, pageView);
    analytics.recordEvent(SARAH, taskDone);
    analytics.withdrawConsent(CODY);
    analytics.grantConsent(CODY);
    analytics.recordEvent(CODY, pageView);
    return analytics.serialize();
  };
  assert.equal(drive(), drive());
});
