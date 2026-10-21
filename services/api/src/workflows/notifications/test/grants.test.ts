/**
 * Grant enforcement and revocation tests (WD-015; FR-025, FR-052; T-15):
 * every digest build and test dispatch re-checks the recipient's CURRENT
 * grants through the entitlement engine; a revoked subscription owner
 * receives nothing for grant-protected objects; a deactivated recipient
 * receives nothing at all; cross-scope events are never delivered; a test
 * event reaches only CURRENTLY eligible subscribers; and the simulated
 * delivery recorder receives NOTHING on every non-delivery path.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/notifications/test/grants.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../../../../../../packages/policy/src/index.ts';
import { createNotificationService } from '../subscriptions.ts';
import { buildTestWorld, deactivate, event, revoke, testDeps, worldHolder, CODY, FATIMA, NINA, PRIYA, SARAH, SYSTEM_BEAR, SYSTEM_WEBER } from './helpers.ts';

/** A restricted-stream site-edit event inside the Bear system. */
const restrictedEdit = (at = '2026-03-10T08:00:00Z') =>
  event({ id: 'ev-hyrum-edit', type: 'site-edit', objectKind: 'datastream', objectId: 'str-hyrum-q-owner', streamId: 'str-hyrum-q-owner', systemId: SYSTEM_BEAR, occurredAt: at, summary: 'metadata edit on the restricted owner stream' });

test('a stream-scope subscription may only target a stream the recipient can already read (favorites rule)', () => {
  const holder = worldHolder();
  const { deps, channel } = testDeps(holder.world, () => '2026-03-10T14:00:00Z');
  const svc = createNotificationService(deps);

  // The Bear commissioner (review-data, Bear) may subscribe to the restricted owner stream.
  const cody = svc.createSubscription(CODY, { scope: { kind: 'stream', streamId: 'str-hyrum-q-owner' }, eventTypes: ['site-edit'], cadence: 'daily' });
  assert.ok(cody.ok, JSON.stringify(cody));

  // The dataset-scoped researcher cannot: 403 with the engine's reason.
  const sarah = svc.createSubscription(SARAH, { scope: { kind: 'stream', streamId: 'str-hyrum-q-owner' }, eventTypes: ['site-edit'], cadence: 'daily' });
  assert.ok(!sarah.ok && 'status' in sarah);
  assert.equal(sarah.status, 403);
  assert.equal(sarah.reason, 'DENY_OUT_OF_SCOPE');

  // The Weber engineer holds view-internal-diagnostics but not in Bear: cross-system denial at creation.
  const nina = svc.createSubscription(NINA, { scope: { kind: 'stream', streamId: 'str-diag-voltage' }, eventTypes: ['no-signal'], cadence: 'hourly' });
  assert.ok(!nina.ok && 'status' in nina);
  assert.equal(nina.status, 403);
  assert.equal(nina.reason, 'DENY_OUT_OF_SCOPE');

  // Anonymous and unknown identities are 401.
  const anonymous = svc.createSubscription(null, { scope: { kind: 'stream', streamId: 'str-corinne-q' }, eventTypes: ['no-signal'], cadence: 'hourly' });
  assert.ok(!anonymous.ok && 'status' in anonymous);
  assert.equal(anonymous.status, 401);
  assert.equal(channel.count(), 0, 'non-delivery: nothing handed to the simulated channel');
});

test('every digest re-checks CURRENT grants: a revoked owner receives nothing (recorder stays empty)', () => {
  const holder = worldHolder();
  const clock = () => '2026-03-10T14:00:00Z';
  const { deps, channel } = testDeps(holder.world, clock);
  const svc = createNotificationService(deps);
  const created = svc.createSubscription(CODY, { scope: { kind: 'stream', streamId: 'str-hyrum-q-owner' }, eventTypes: ['site-edit'], cadence: 'daily' });
  assert.ok(created.ok);
  const subscriptionId = created.subscription.id;

  // Before revocation: the digest delivers (created 2026-03-10T14:00Z = the
  // fixed clock; first daily boundary after that is Mar 11 07:00 MDT).
  const before = svc.buildDigest(subscriptionId, '2026-03-12T14:00:00Z', [restrictedEdit('2026-03-11T20:00:00Z')]);
  assert.ok(before.issued, JSON.stringify(before));
  assert.equal(before.counts.included, 1);
  assert.equal(channel.count(), 1, 'one digest receipt before revocation');

  // Revoke the commissioner's only entitlement. The SAME service re-reads the
  // world snapshot on the next build: the grant-protected stream now denies.
  holder.replace(revoke(holder.world(), 'ent-commissioner-cody'));
  const revokedDigest = svc.buildDigest(subscriptionId, '2026-03-13T14:00:00Z', [restrictedEdit('2026-03-12T20:00:00Z')]);
  assert.ok(revokedDigest.issued);
  assert.equal(revokedDigest.counts.included, 0, 'a revoked owner receives NOTHING for the grant-protected stream');
  assert.equal(revokedDigest.counts.omittedForAuthorization, 1, 'the event is counted, never listed');
  assert.equal(revokedDigest.receipt, null, 'no receipt is produced for an empty digest');
  assert.equal(channel.count(), 1, 'non-delivery: the simulated channel receives NOTHING new');

  // A deactivated recipient receives nothing at all - even PUBLIC events.
  holder.replace(deactivate(holder.world(), FATIMA));
  const fatima = svc.createSubscription(FATIMA, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, eventTypes: ['new-site'], cadence: 'daily' });
  assert.ok(fatima.ok, 'creating a system-scope preference stays possible (own-account); only delivery is grant-bound');
  const inactiveDigest = svc.buildDigest(fatima.subscription.id, '2026-03-14T14:00:00Z', [
    event({ id: 'ev-public', type: 'new-site', objectId: 'sta-bear-corinne', systemId: SYSTEM_BEAR, occurredAt: '2026-03-13T20:00:00Z' }),
  ]);
  assert.ok(inactiveDigest.issued);
  assert.equal(inactiveDigest.counts.included, 0);
  assert.equal(inactiveDigest.counts.omittedForAuthorization, 1);
  assert.equal(channel.count(), 1, 'non-delivery: the simulated channel receives NOTHING');
});

test('cross-scope events are never delivered (system scope, stream scope, and the engine agree)', () => {
  const holder = worldHolder();
  const clock = () => '2026-03-10T14:00:00Z';
  const { deps, channel } = testDeps(holder.world, clock);
  const svc = createNotificationService(deps);

  // Priya is the WEBER engineer: her system-scope subscription never sees Bear events.
  const priya = svc.createSubscription(PRIYA, { scope: { kind: 'system', systemId: SYSTEM_WEBER }, eventTypes: ['site-edit', 'no-signal'], cadence: 'daily' });
  assert.ok(priya.ok);
  const digest = svc.buildDigest(priya.subscription.id, '2026-03-11T14:00:00Z', [restrictedEdit('2026-03-10T20:00:00Z')]);
  assert.ok(digest.issued);
  assert.equal(digest.counts.included, 0);
  assert.equal(digest.counts.outOfSubscription, 1, 'a Bear event is outside the Weber scope before admission even runs');
  assert.equal(channel.count(), 0, 'non-delivery: the simulated channel receives NOTHING');

  // Nina holds view-internal-diagnostics in Weber ONLY: a Bear internal
  // no-signal event is a genuine DENY_OUT_OF_SCOPE at digest time.
  const nina = svc.createSubscription(NINA, { scope: { kind: 'system', systemId: SYSTEM_WEBER }, eventTypes: ['no-signal'], cadence: 'daily' });
  assert.ok(nina.ok);
  const ninaDigest = svc.buildDigest(nina.subscription.id, '2026-03-11T14:00:00Z', [
    event({ id: 'ev-bear-internal', type: 'no-signal', objectId: 'sta-bear-lake-diagnostic', systemId: SYSTEM_BEAR, occurredAt: '2026-03-10T20:00:00Z' }),
  ]);
  assert.equal(ninaDigest.counts.outOfSubscription, 1);

  // Even a feed that mis-anchors a Weber object under the Bear system never
  // delivers it to a Bear-scope recipient: admission runs on the OBJECT.
  const cody = svc.createSubscription(CODY, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, eventTypes: ['no-signal'], cadence: 'daily' });
  assert.ok(cody.ok);
  const anchored = svc.buildDigest(cody.subscription.id, '2026-03-11T14:00:00Z', [
    event({ id: 'ev-weber-obj', type: 'no-signal', objectId: 'str-ogden-q-proposed', streamId: 'str-ogden-q-proposed', objectKind: 'datastream', systemId: SYSTEM_BEAR, occurredAt: '2026-03-10T20:00:00Z' }),
  ]);
  assert.ok(anchored.issued);
  assert.equal(anchored.counts.included, 0);
  assert.equal(anchored.counts.omittedForAuthorization, 1, 'the Weber restricted stream denies the Bear commissioner (DENY_OUT_OF_SCOPE)');
  assert.equal(channel.count(), 0, 'non-delivery: the simulated channel receives NOTHING');
});

test('a test event reaches only CURRENTLY eligible subscribers', () => {
  const holder = worldHolder();
  const clock = () => '2026-03-10T14:00:00Z';
  const { deps, channel } = testDeps(holder.world, clock);
  const svc = createNotificationService(deps);

  const fatima = svc.createSubscription(FATIMA, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, eventTypes: ['new-site', 'site-edit', 'no-signal', 'threshold'], cadence: 'daily' });
  const cody = svc.createSubscription(CODY, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, eventTypes: ['new-site', 'site-edit', 'no-signal', 'threshold'], cadence: 'daily' });
  const sarah = svc.createSubscription(SARAH, { scope: { kind: 'stream', streamId: 'str-corinne-q' }, eventTypes: ['no-signal'], cadence: 'hourly' });
  assert.ok(fatima.ok && cody.ok && sarah.ok);

  const probe = event({ id: 'test-1', type: 'no-signal', objectId: 'sta-bear-lake-diagnostic', systemId: SYSTEM_BEAR, occurredAt: '2026-03-10T14:00:00Z', summary: 'SIMULATED test event (internal diagnostic station)' });
  const rows = svc.dispatchTestEvent(probe);
  assert.deepEqual(
    rows.map((row) => [row.subscriptionId, row.delivered, row.reason]),
    [
      ['nsub-000001', true, null], // Fatima: view-internal-diagnostics in Bear -> eligible
      ['nsub-000002', false, 'not-admitted'], // Cody: no internal-diagnostics capability
      ['nsub-000003', false, 'out-of-scope'], // Sarah: stream scope on a public stream
    ],
  );
  assert.equal(channel.count(), 1, 'only the eligible subscriber receives the test event');
  assert.equal(channel.receipts()[0]!.recipientId, FATIMA);
  assert.equal(channel.receipts()[0]!.kind, 'test-event');

  // Revoking Fatima's grant: the SAME test event now reaches nobody.
  holder.replace(revoke(holder.world(), 'ent-engineer-fatima'));
  const rowsAfter = svc.dispatchTestEvent(probe, '2026-03-10T15:00:00Z');
  assert.deepEqual(
    rowsAfter.map((row) => row.delivered),
    [false, false, false],
  );
  assert.equal(channel.count(), 1, 'non-delivery: no new receipt after revocation');

  // Event-type routing on dispatch: a site-edit test event skips Sarah's
  // no-signal subscription entirely. On the PUBLIC station the engine's
  // public-read branch admits Cody AND the revoked-entitlement Fatima (public
  // data stays public); grant revocation suppresses the protected objects
  // (proven above by rowsAfter), not the public projection.
  const editProbe = event({ id: 'test-2', type: 'site-edit', objectId: 'sta-bear-corinne', systemId: SYSTEM_BEAR, occurredAt: '2026-03-10T16:00:00Z', summary: 'SIMULATED test event (public station)' });
  const editRows = svc.dispatchTestEvent(editProbe);
  assert.deepEqual(
    editRows.map((row) => [row.subscriptionId, row.delivered, row.reason]),
    [
      ['nsub-000001', true, null], // Fatima: public-read branch (grant revoked, public data public)
      ['nsub-000002', true, null], // Cody: public station, site-edit selected, Bear scope
      ['nsub-000003', false, 'event-type-not-selected'], // Sarah: no-signal only
    ],
  );
  assert.equal(channel.count(), 3, 'exactly two more receipts (Fatima + Cody), none for the skipped event type');
  assert.deepEqual(
    channel.receipts().slice(1).map((receipt) => receipt.recipientId).sort(),
    [CODY, FATIMA],
  );
});

test('favorites and subscriptions never grant anything (FR-052): the engine denies protected reads regardless', () => {
  const world = buildTestWorld();
  const { deps, channel } = testDeps(() => world, () => '2026-03-10T14:00:00Z');
  const svc = createNotificationService(deps);
  // Sarah subscribes to the PUBLIC discharge stream.
  const created = svc.createSubscription(SARAH, { scope: { kind: 'stream', streamId: 'str-corinne-q' }, eventTypes: ['threshold'], cadence: 'daily' });
  assert.ok(created.ok);

  // Owning a subscription (or a favorite) never satisfies a protected read:
  // the engine still denies Sarah the restricted owner stream, and Cody's
  // Bear grants still do not reach the Weber system.
  const sarahDenied = evaluate(
    { principal: world.principals[SARAH]!, action: 'view-restricted-details', object: { kind: 'datastream', id: 'str-hyrum-q-owner' } },
    world,
    '2026-03-10T14:00:00Z',
  );
  assert.equal(sarahDenied.effect, 'deny');
  const codyDenied = evaluate(
    { principal: world.principals[CODY]!, action: 'view-restricted-details', object: { kind: 'datastream', id: 'str-ogden-q-proposed' } },
    world,
    '2026-03-10T14:00:00Z',
  );
  assert.equal(codyDenied.effect, 'deny');
  assert.equal(channel.count(), 0, 'non-delivery: the simulated channel receives NOTHING');
});

test('unknown and cancelled subscriptions never issue or deliver anything', () => {
  const holder = worldHolder();
  const { deps, channel } = testDeps(holder.world, () => '2026-03-10T14:00:00Z');
  const svc = createNotificationService(deps);
  const unknown = svc.buildDigest('nsub-does-not-exist', '2026-03-11T14:00:00Z', [restrictedEdit()]);
  assert.ok(!unknown.issued && unknown.reason === 'unknown-subscription');

  const created = svc.createSubscription(FATIMA, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, eventTypes: ['site-edit'], cadence: 'daily' });
  assert.ok(created.ok);
  const cancelled = svc.cancelSubscription(FATIMA, created.subscription.id);
  assert.ok(cancelled.ok);
  assert.equal(cancelled.subscription.status, 'cancelled');

  const afterCancel = svc.buildDigest(created.subscription.id, '2026-03-12T14:00:00Z', [restrictedEdit('2026-03-11T20:00:00Z')]);
  assert.ok(!afterCancel.issued && afterCancel.reason === 'cancelled');
  assert.equal(svc.dueSubscriptions('2026-03-12T14:00:00Z').length, 0, 'a cancelled subscription is never due');
  assert.equal(svc.subscriptionsFor(FATIMA).length, 0, 'cancellation persists: not listed as active');

  // Cancelled is terminal: update cannot resurrect it.
  const resurrect = svc.updateSubscription(FATIMA, created.subscription.id, { cadence: 'hourly' });
  assert.ok(!resurrect.ok);
  assert.deepEqual(resurrect.errors, ['cancelled-subscription']);
  assert.equal(channel.count(), 0, 'non-delivery: the simulated channel receives NOTHING');
});
