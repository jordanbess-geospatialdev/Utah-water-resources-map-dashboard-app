/**
 * Determinism tests (WD-015; T-15): the whole pipeline - subscription
 * creation, threshold evaluation, digest building, simulated delivery - is a
 * pure function of its inputs. Two runs over identical inputs produce
 * byte-identical subscriptions, digests and receipts, and repeated boundary
 * math is stable run over run. Non-delivery paths are re-asserted: the
 * recorder receives NOTHING.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/notifications/test/determinism.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationService } from '../subscriptions.ts';
import { evaluateThresholdEvents } from '../thresholds.ts';
import { createDeliveryRecorder } from '../types.ts';
import { buildTestWorld, CODY, DIEGO, FATIMA, SYSTEM_BEAR, event } from './helpers.ts';

interface RunOutput {
  readonly subscriptions: string;
  readonly digests: string;
  readonly receipts: string;
}

/** The whole scenario, twice: identical inputs must give identical bytes. */
function runScenario(): RunOutput {
  const world = buildTestWorld();
  const channel = createDeliveryRecorder();
  const clock = () => '2026-03-02T15:00:00Z';
  const svc = createNotificationService({ world, clock, channel });

  const a = svc.createSubscription(FATIMA, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, eventTypes: ['new-site', 'site-edit', 'no-signal', 'threshold'], thresholds: { discharge: { max: 25 } }, cadence: 'weekly', channelNote: 'duty desk' });
  const b = svc.createSubscription(CODY, { scope: { kind: 'stream', streamId: 'str-corinne-q' }, eventTypes: ['threshold'], cadence: 'daily' });
  const c = svc.createSubscription(DIEGO, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, eventTypes: ['new-site'], cadence: 'hourly' });
  assert.ok(a.ok && b.ok && c.ok);

  const thresholdFeed = evaluateThresholdEvents(
    { streamId: 'str-corinne-q', systemId: SYSTEM_BEAR, observedPropertyId: 'discharge', unitId: 'cfs' },
    [
      { observedAt: '2026-03-04T15:00:00Z', value: 26 },
      { observedAt: '2026-03-04T15:30:00Z', value: 30 },
      { observedAt: '2026-03-05T15:00:00Z', value: 28 },
    ],
    { start: '2026-03-04T14:00:00Z', end: '2026-03-05T14:00:00Z' }, // a daily 07:00 Denver window
    a.ok ? a.subscription.thresholds : undefined,
  );
  const feed = [
    event({ id: 'ev-mon', type: 'new-site', objectId: 'sta-bear-corinne', systemId: SYSTEM_BEAR, occurredAt: '2026-03-02T20:00:00Z' }),
    event({ id: 'ev-tue', type: 'site-edit', objectId: 'sta-hyrum-diversion-owner', systemId: SYSTEM_BEAR, occurredAt: '2026-03-03T18:00:00Z' }),
    event({ id: 'ev-sat', type: 'no-signal', objectId: 'sta-bear-corinne', systemId: SYSTEM_BEAR, occurredAt: '2026-03-07T10:00:00Z' }),
    ...thresholdFeed,
  ];

  // Weekly Monday 07:00 America/Denver digest for Fatima; daily 07:00 MST
  // digests for Cody's threshold stream; hourly digests for the steward.
  svc.buildDigest(a.ok ? a.subscription.id : '', '2026-03-09T13:00:00Z', feed);
  svc.buildDigest(b.ok ? b.subscription.id : '', '2026-03-05T14:00:00Z', feed);
  svc.buildDigest(b.ok ? b.subscription.id : '', '2026-03-06T14:00:00Z', feed);
  svc.buildDigest(c.ok ? c.subscription.id : '', '2026-03-02T21:00:00Z', feed);
  svc.buildDigest(c.ok ? c.subscription.id : '', '2026-03-02T22:00:00Z', feed);

  return {
    subscriptions: JSON.stringify(svc.subscriptionsFor(FATIMA).concat(svc.subscriptionsFor(CODY), svc.subscriptionsFor(DIEGO))),
    digests: JSON.stringify(svc.digests(a.ok ? a.subscription.id : '').concat(svc.digests(b.ok ? b.subscription.id : ''), svc.digests(c.ok ? c.subscription.id : ''))),
    receipts: JSON.stringify(channel.receipts()),
  };
}

test('the pipeline is byte-deterministic across two independent runs', () => {
  const first = runScenario();
  const second = runScenario();
  assert.equal(first.subscriptions, second.subscriptions);
  assert.equal(first.digests, second.digests);
  assert.equal(first.receipts, second.receipts);
  assert.ok(first.digests.includes('windowEnd'));
  assert.ok(first.receipts.includes('"channel":"simulated"'));
});

test('the simulated channel receives nothing on every non-delivery path (re-asserted)', () => {
  const world = buildTestWorld();
  const channel = createDeliveryRecorder();
  const svc = createNotificationService({ world, clock: () => '2026-03-02T15:00:00Z', channel });
  const created = svc.createSubscription(FATIMA, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, eventTypes: ['new-site'], cadence: 'daily' });
  assert.ok(created.ok);

  // Not due.
  svc.buildDigest(created.subscription.id, '2026-03-02T15:30:00Z', [event({ id: 'x', type: 'new-site', objectId: 'sta-bear-corinne', systemId: SYSTEM_BEAR, occurredAt: '2026-03-02T15:10:00Z' })]);
  // Unknown subscription.
  svc.buildDigest('nsub-999999', '2026-03-03T14:00:00Z', []);
  // Due, but no in-window events at all.
  svc.buildDigest(created.subscription.id, '2026-03-03T14:00:00Z', []);
  // Due, but only unauthorized events (a Weber restricted object mis-anchored
  // under the Bear system: scope passes, the ENGINE denies the object).
  const unauthorized = svc.buildDigest(created.subscription.id, '2026-03-04T14:00:00Z', [
    event({ id: 'ev-weber', type: 'new-site', objectKind: 'datastream', objectId: 'str-ogden-q-proposed', streamId: 'str-ogden-q-proposed', systemId: SYSTEM_BEAR, occurredAt: '2026-03-03T20:00:00Z' }),
  ]);
  assert.ok(unauthorized.issued);
  assert.equal(unauthorized.counts.omittedForAuthorization, 1);
  // Test dispatch to nobody eligible.
  svc.dispatchTestEvent(event({ id: 't', type: 'threshold', objectKind: 'datastream', objectId: 'str-diag-voltage', streamId: 'str-diag-voltage', systemId: SYSTEM_BEAR, occurredAt: '2026-03-02T15:20:00Z' }));

  assert.equal(channel.count(), 0, 'non-delivery: the simulated channel received NOTHING on any path');
});
