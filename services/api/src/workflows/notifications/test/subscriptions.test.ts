/**
 * Subscription lifecycle, event-type routing and digest content tests
 * (WD-015; FR-025, FR-052; T-15): create/update/cancel semantics (removal
 * persists), the four event types route only to subscriptions that selected
 * them, digest entries carry alert links and dedupe keys, and out-of-scope
 * or unselected events are counted, never listed.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/notifications/test/subscriptions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationService } from '../subscriptions.ts';
import { createDeliveryRecorder, NOTIFICATION_EVENT_TYPES } from '../types.ts';
import { buildTestWorld, event, testDeps, CODY, DIEGO, FATIMA, SARAH, SYSTEM_BEAR } from './helpers.ts';

test('subscriptions pick system or stream scope, an event-type subset, thresholds and one of the four cadences', () => {
  const world = buildTestWorld();
  const channel = createDeliveryRecorder();
  const svc = createNotificationService({ world, clock: () => '2026-03-02T15:00:00Z', channel });
  const created = svc.createSubscription(CODY, {
    scope: { kind: 'system', systemId: SYSTEM_BEAR },
    eventTypes: ['threshold', 'new-site'],
    thresholds: { discharge: { min: 0, max: 25 } },
    cadence: 'weekly',
    channelNote: 'route through the duty desk',
  });
  assert.ok(created.ok, JSON.stringify(created));
  assert.equal(created.subscription.recipientId, CODY);
  assert.deepEqual(created.subscription.eventTypes, ['new-site', 'threshold'], 'event types are stored as a sorted set');
  assert.deepEqual(created.subscription.thresholds, { discharge: { min: 0, max: 25 } });
  assert.equal(created.subscription.channelNote, 'route through the duty desk');
  assert.equal(created.subscription.nextDueAt, '2026-03-09T13:00:00Z', 'weekly cadence: next Monday 07:00 America/Denver');
  assert.deepEqual(NOTIFICATION_EVENT_TYPES, ['new-site', 'site-edit', 'no-signal', 'threshold']);

  // Validation: unknown cadence/scope, empty or unknown event types, bad bounds.
  const bad = svc.createSubscription(CODY, { scope: { kind: 'system', systemId: 'sys-atlantis' }, eventTypes: [], cadence: 'minutely', thresholds: { stage: { min: 9, max: 2 } } });
  assert.ok(!bad.ok && 'errors' in bad);
  assert.deepEqual([...bad.errors].sort(), ['bad-event-types', 'bad-thresholds', 'unknown-cadence', 'unknown-system']);
  const anonymous = svc.createSubscription(null, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, eventTypes: ['new-site'], cadence: 'daily' });
  assert.ok(!anonymous.ok && 'status' in anonymous && anonymous.status === 401);

  // Own-account: only the recipient's own active list is returned.
  assert.equal(svc.subscriptionsFor(CODY).length, 1);
  assert.equal(svc.subscriptionsFor(FATIMA).length, 0);
  const foreign = svc.cancelSubscription(FATIMA, created.subscription.id);
  assert.ok(!foreign.ok);
  assert.deepEqual(foreign.errors, ['not-own-subscription']);
  assert.equal(channel.count(), 0, 'non-delivery: the simulated channel receives NOTHING');
});

test('update persists cadence, event types, thresholds and note; the schedule restarts on the new grid', () => {
  const world = buildTestWorld();
  const channel = createDeliveryRecorder();
  const svc = createNotificationService({ world, clock: () => '2026-03-02T15:00:00Z', channel });
  const created = svc.createSubscription(CODY, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, eventTypes: ['new-site'], cadence: 'daily' });
  assert.ok(created.ok);

  const updated = svc.updateSubscription(CODY, created.subscription.id, { cadence: 'hourly', eventTypes: ['new-site', 'no-signal'], channelNote: 'n' });
  assert.ok(updated.ok);
  assert.equal(updated.subscription.cadence, 'hourly');
  assert.deepEqual(updated.subscription.eventTypes, ['new-site', 'no-signal']);
  assert.equal(updated.subscription.channelNote, 'n');
  assert.equal(updated.subscription.nextDueAt, '2026-03-02T16:00:00Z', 'regridded from the creation anchor');

  const badCadence = svc.updateSubscription(CODY, created.subscription.id, { cadence: 'always' });
  assert.ok(!badCadence.ok && 'errors' in badCadence);
  assert.deepEqual(badCadence.errors, ['unknown-cadence']);
  const badTypes = svc.updateSubscription(CODY, created.subscription.id, { eventTypes: [] });
  assert.ok(!badTypes.ok && 'errors' in badTypes);
  assert.deepEqual(badTypes.errors, ['bad-event-types']);
  assert.equal(channel.count(), 0, 'non-delivery: the simulated channel receives NOTHING');
});

test('event types route: only the selected kinds deliver; the rest are counted out-of-subscription', () => {
  const world = buildTestWorld();
  const channel = createDeliveryRecorder();
  const svc = createNotificationService({ world, clock: () => '2026-03-02T15:00:00Z', channel });
  const created = svc.createSubscription(DIEGO, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, eventTypes: ['new-site'], cadence: 'daily' });
  assert.ok(created.ok);
  const subscriptionId = created.subscription.id;

  const feed = [
    event({ id: 'ev-a', type: 'new-site', objectId: 'sta-bear-corinne', systemId: SYSTEM_BEAR, occurredAt: '2026-03-02T20:00:00Z' }),
    event({ id: 'ev-b', type: 'site-edit', objectId: 'sta-bear-corinne', systemId: SYSTEM_BEAR, occurredAt: '2026-03-02T21:00:00Z' }),
    event({ id: 'ev-c', type: 'no-signal', objectId: 'sta-bear-corinne', systemId: SYSTEM_BEAR, occurredAt: '2026-03-02T22:00:00Z' }),
    event({ id: 'ev-d', type: 'threshold', objectKind: 'datastream', objectId: 'str-corinne-q', streamId: 'str-corinne-q', systemId: SYSTEM_BEAR, occurredAt: '2026-03-02T23:00:00Z' }),
  ];
  const digest = svc.buildDigest(subscriptionId, '2026-03-03T14:00:00Z', feed);
  assert.ok(digest.issued);
  assert.deepEqual(
    digest.entries.map((entry) => entry.eventId),
    ['ev-a'],
  );
  assert.equal(digest.counts.outOfSubscription, 3, 'site-edit, no-signal and threshold were not selected');
  assert.equal(digest.counts.included, 1);
  assert.equal(digest.entries[0]!.eventTypeLabel, 'New sites');
  assert.equal(digest.entries[0]!.alertLink, '/alerts/ev-a');
  assert.deepEqual(digest.dedupeKeys, ['ev-a'], 'dedupe keys mirror the included event ids');

  // A subscription selecting ALL FOUR receives them type-sorted.
  const allFour = svc.createSubscription(DIEGO, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, eventTypes: ['new-site', 'site-edit', 'no-signal', 'threshold'], cadence: 'daily' });
  assert.ok(allFour.ok);
  const rich = svc.buildDigest(allFour.subscription.id, '2026-03-03T14:00:00Z', feed);
  assert.ok(rich.issued);
  assert.deepEqual(
    rich.entries.map((entry) => entry.eventType),
    ['new-site', 'site-edit', 'no-signal', 'threshold'],
  );
  assert.equal(channel.count(), 2, 'one receipt per delivering digest');
  assert.equal(channel.receipts()[1]!.eventIds.length, 4);
});

test('stream scope matches events on that stream (any event type selected); system events on it stay out', () => {
  const world = buildTestWorld();
  const channel = createDeliveryRecorder();
  const svc = createNotificationService({ world, clock: () => '2026-03-02T15:00:00Z', channel });
  const created = svc.createSubscription(SARAH, { scope: { kind: 'stream', streamId: 'str-corinne-q' }, eventTypes: ['no-signal', 'threshold'], cadence: 'hourly' });
  assert.ok(created.ok);
  const digest = svc.buildDigest(created.subscription.id, '2026-03-02T16:00:00Z', [
    event({ id: 'ev-stream', type: 'no-signal', objectKind: 'datastream', objectId: 'str-corinne-q', streamId: 'str-corinne-q', systemId: SYSTEM_BEAR, occurredAt: '2026-03-02T15:30:00Z' }),
    event({ id: 'ev-station', type: 'no-signal', objectId: 'sta-bear-corinne', systemId: SYSTEM_BEAR, occurredAt: '2026-03-02T15:40:00Z' }),
  ]);
  assert.ok(digest.issued);
  assert.deepEqual(
    digest.entries.map((entry) => entry.eventId),
    ['ev-stream'],
  );
  assert.equal(digest.counts.outOfSubscription, 1);
  assert.equal(channel.count(), 1);
});

test('duplicate event records inside a window collapse to one entry and are counted', () => {
  const world = buildTestWorld();
  const { deps, channel } = testDeps(() => world, () => '2026-03-02T15:00:00Z');
  const svc = createNotificationService(deps);
  const created = svc.createSubscription(DIEGO, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, eventTypes: ['new-site'], cadence: 'daily' });
  assert.ok(created.ok);
  const feed = [
    event({ id: 'ev-once', type: 'new-site', objectId: 'sta-bear-corinne', systemId: SYSTEM_BEAR, occurredAt: '2026-03-02T20:00:00Z' }),
    event({ id: 'ev-once', type: 'new-site', objectId: 'sta-bear-corinne', systemId: SYSTEM_BEAR, occurredAt: '2026-03-02T20:00:00Z' }),
    event({ id: 'ev-once', type: 'new-site', objectId: 'sta-bear-corinne', systemId: SYSTEM_BEAR, occurredAt: '2026-03-02T20:00:00Z' }),
  ];
  const digest = svc.buildDigest(created.subscription.id, '2026-03-03T14:00:00Z', feed);
  assert.ok(digest.issued);
  assert.equal(digest.counts.included, 1);
  assert.equal(digest.counts.duplicatesDropped, 2);
  assert.deepEqual(digest.dedupeKeys, ['ev-once']);
  assert.equal(channel.count(), 1);
  assert.deepEqual(channel.receipts()[0]!.eventIds, ['ev-once']);
});

test('the simulated channel note is bounded and receipts are records, never sends', () => {
  const world = buildTestWorld();
  const channel = createDeliveryRecorder();
  const svc = createNotificationService({ world, clock: () => '2026-03-02T15:00:00Z', channel });
  const created = svc.createSubscription(DIEGO, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, eventTypes: ['new-site'], cadence: 'daily', channelNote: 'x'.repeat(400) });
  assert.ok(created.ok);
  assert.equal(created.subscription.channelNote.length, 120, 'the channel note is bounded like the WD-009 preference seam');
  const digest = svc.buildDigest(created.subscription.id, '2026-03-03T14:00:00Z', [
    event({ id: 'ev-note', type: 'new-site', objectId: 'sta-bear-corinne', systemId: SYSTEM_BEAR, occurredAt: '2026-03-02T20:00:00Z' }),
  ]);
  assert.ok(digest.issued);
  const receipt = channel.receipts()[0]!;
  assert.equal(receipt.channel, 'simulated');
  assert.ok(receipt.summary.includes('SIMULATED channel, no real message sent'), receipt.summary);
  assert.equal(receipt.kind, 'digest');
});
