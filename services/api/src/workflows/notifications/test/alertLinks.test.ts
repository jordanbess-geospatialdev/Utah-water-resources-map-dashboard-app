/**
 * Alert link re-authorization tests (WD-015; FR-025 "the alert link repeats
 * the authorization check"; T-15): the link builder produces a bare route,
 * and the resolver RE-RUNS the entitlement engine against the CURRENT world
 * at resolve time - a grant revoked after the digest was built makes the
 * link resolve to denied.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/notifications/test/alertLinks.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertLinkFor, createAlertLinkRegistry, parseAlertLink } from '../alertLinks.ts';
import { createNotificationService } from '../subscriptions.ts';
import { createDeliveryRecorder } from '../types.ts';
import { buildTestWorld, deactivate, event, revoke, worldHolder, CODY, DIEGO, FATIMA, NINA, SARAH, SYSTEM_BEAR } from './helpers.ts';

const internalEvent = event({
  id: 'ev-voltage-ns',
  type: 'no-signal',
  objectKind: 'datastream',
  objectId: 'str-diag-voltage',
  streamId: 'str-diag-voltage',
  systemId: SYSTEM_BEAR,
  occurredAt: '2026-03-10T06:00:00Z',
  summary: 'no signal on the internal voltage stream',
});

test('the link is a bare route: round-trips, carries no membership or authority', () => {
  const link = alertLinkFor(internalEvent);
  assert.equal(link, '/alerts/ev-voltage-ns');
  assert.equal(parseAlertLink(link), 'ev-voltage-ns');
  assert.equal(parseAlertLink('/alerts/'), null);
  assert.equal(parseAlertLink('https://evil.example/alerts/ev-voltage-ns'), null, 'only the dashboard route parses');
  assert.ok(!link.includes('token') && !link.includes('grant'));
});

test('resolve re-runs authorization: eligible recipient reads the event; denials carry the engine reason', () => {
  const holder = worldHolder();
  const registry = createAlertLinkRegistry({ world: holder.world, clock: () => '2026-03-10T14:00:00Z' });
  const link = registry.register(internalEvent);
  assert.equal(registry.size(), 1);
  registry.register(internalEvent);
  assert.equal(registry.size(), 1, 'registering is idempotent by event id');

  // The Bear engineer holds view-internal-diagnostics in scope: resolved.
  const fatima = registry.resolve(FATIMA, link);
  assert.ok(fatima.ok, JSON.stringify(fatima));
  assert.equal(fatima.event.id, 'ev-voltage-ns');
  assert.equal(fatima.resolvedAt, '2026-03-10T14:00:00Z');

  // Anonymous: 401 identity mapping.
  const anonymous = registry.resolve(null, link);
  assert.ok(!anonymous.ok);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.reason, 'DENY_ANONYMOUS');

  // A Weber engineer with the capability but outside the Bear scope: 403.
  const nina = registry.resolve(NINA, link);
  assert.ok(!nina.ok);
  assert.equal(nina.status, 403);
  assert.equal(nina.reason, 'DENY_OUT_OF_SCOPE');

  // The commissioner lacks the internal-diagnostics capability entirely: 403.
  const cody = registry.resolve(CODY, link);
  assert.ok(!cody.ok);
  assert.equal(cody.reason, 'DENY_CAPABILITY_NOT_GRANTED');

  // Unknown links never fall back to a view.
  const unknown = registry.resolve(DIEGO, '/alerts/never-minted');
  assert.ok(!unknown.ok);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.reason, 'DENY_UNKNOWN_OBJECT');
  const malformed = registry.resolve(DIEGO, 'not-a-link');
  assert.ok(!malformed.ok);
  assert.equal(malformed.status, 404);
});

test('a grant revoked AFTER the digest was built makes the SAME link resolve to denied', () => {
  const holder = worldHolder();
  const clock = () => '2026-03-10T14:00:00Z';
  const registry = createAlertLinkRegistry({ world: holder.world, clock });
  const link = registry.register(internalEvent);
  assert.ok(registry.resolve(FATIMA, link).ok, 'admitted while the grant is current');

  holder.replace(revoke(holder.world(), 'ent-engineer-fatima'));
  const revoked = registry.resolve(FATIMA, link);
  assert.ok(!revoked.ok);
  assert.equal(revoked.status, 403);
  assert.equal(revoked.reason, 'DENY_ASSIGNMENT_REVOKED', 'revocation affects the very next resolve');
  assert.ok(revoked.detail.includes('revoked'));

  // A deactivated principal is 401 on the protected action (identity mapping).
  const sarahWorld = deactivate(holder.world(), SARAH);
  const sarahRegistry = createAlertLinkRegistry({ world: () => sarahWorld, clock });
  sarahRegistry.register(internalEvent);
  const deactivated = sarahRegistry.resolve(SARAH, link);
  assert.ok(!deactivated.ok);
  assert.equal(deactivated.status, 401);
  assert.equal(deactivated.reason, 'DENY_PRINCIPAL_INACTIVE');

  // Re-granting (a new world snapshot) re-enables the SAME link: the check is
  // per-resolve, never cached in the link.
  holder.replace(buildTestWorld());
  assert.ok(registry.resolve(FATIMA, link).ok);
});

test('digest entries carry resolvable links end to end', () => {
  const holder = worldHolder();
  const channel = createDeliveryRecorder();
  const svc = createNotificationService({ world: holder.world, clock: () => '2026-03-02T15:00:00Z', channel });
  const created = svc.createSubscription(FATIMA, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, eventTypes: ['no-signal'], cadence: 'daily' });
  assert.ok(created.ok);
  // An in-window twin of the internal-stream event (window [Mar 2 15:00Z, Mar 3 14:00Z MST]).
  const digestEvent = { ...internalEvent, id: 'ev-voltage-mar2', occurredAt: '2026-03-02T20:00:00Z' };
  const digest = svc.buildDigest(created.subscription.id, '2026-03-03T14:00:00Z', [digestEvent]);
  assert.ok(digest.issued);
  assert.equal(digest.counts.included, 1);

  // The entry's link resolves through a registry sharing the world provider.
  const registry = createAlertLinkRegistry({ world: holder.world, clock: () => '2026-03-10T14:00:00Z' });
  const link = registry.register(digestEvent);
  assert.equal(digest.entries[0]!.alertLink, link, 'the digest entry carries exactly the registered link');
  assert.ok(registry.resolve(FATIMA, link).ok);

  // Revoke after the digest was BUILT: the already-issued entry's link denies.
  holder.replace(revoke(holder.world(), 'ent-engineer-fatima'));
  assert.ok(!registry.resolve(FATIMA, link).ok);
  assert.equal(channel.count(), 1, 'the digest itself was delivered while the grant was current');
});
