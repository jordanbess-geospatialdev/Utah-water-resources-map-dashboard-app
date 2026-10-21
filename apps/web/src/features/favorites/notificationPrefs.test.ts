/**
 * Notification preference tests (FR-009, FR-025): per-account subscriptions
 * with FR-025 event kinds and cadence, validated against the account's
 * readable scope by the REAL entitlement engine - subscribing to a
 * restricted site outside scope rejects; delivery itself is out of scope
 * here (the channel note is a placeholder).
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/favorites/notificationPrefs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { PolicyEvaluator, PolicyWorldMirror } from '../operations/assignedScope';

register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const prefsPath = './notificationPrefs.ts';
const prefs: typeof import('./notificationPrefs') = await import(prefsPath);
const favoritesPath = './favorites.ts';
const favorites: typeof import('./favorites') = await import(favoritesPath);
const fixturesPath = '../../shell/data/fixtures.ts';
const fixtures: typeof import('../../shell/data/fixtures') = await import(fixturesPath);

const policyPath = '../../../../../packages/policy/src/index.ts';
const policy = (await import(policyPath)) as {
  buildWorld: (input: Record<string, unknown>) => PolicyWorldMirror;
  evaluate: PolicyEvaluator;
};

const evaluate = policy.evaluate;
const NOW = fixtures.FIXTURE_CLOCK;

function world(stationsOverride?: object[]): PolicyWorldMirror {
  return policy.buildWorld({
    principals: {
      seed: fixtures.FIXTURE_SEED,
      organizations: fixtures.organizations as unknown as object[],
      users: fixtures.users as unknown as object[],
      entitlements: fixtures.entitlements as unknown as object[],
    },
    stations: { seed: fixtures.FIXTURE_SEED, stations: stationsOverride ?? (fixtures.stations as unknown as object[]) },
  });
}

function storeFor(principalId: string, worldSnapshot: PolicyWorldMirror = world(), storage = favorites.inMemoryStorage()) {
  return prefs.createNotificationPrefsStore({ principalId, world: worldSnapshot, policy: evaluate, now: NOW, storage });
}

// ---------------------------------------------------------------------------
// Saving valid subscriptions
// ---------------------------------------------------------------------------

test('a readable public site subscribes with FR-025 event kinds and cadence, persisted per account', () => {
  const storage = favorites.inMemoryStorage();
  const store = storeFor('principal-sarah-researcher', world(), storage);
  const result = store.setPref({ scope: { kind: 'site', id: 'sta-bear-corinne' }, events: ['no-signal', 'threshold', 'threshold'], cadence: 'daily', channelNote: 'weekday digests only' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.pref.events, ['no-signal', 'threshold']); // deduplicated and sorted
  assert.equal(result.pref.cadence, 'daily');
  const replayed = storeFor('principal-sarah-researcher', world(), storage);
  assert.equal(replayed.listPrefs().length, 1);
  assert.equal(replayed.listPrefs()[0]!.scope.id, 'sta-bear-corinne');
  // Per-account keys, favorites never collide with prefs.
  assert.notEqual(prefs.notificationPrefsStorageKey('a'), prefs.notificationPrefsStorageKey('b'));
  assert.notEqual(prefs.notificationPrefsStorageKey('a'), favorites.favoritesStorageKey('a'));
});

test('resubscribing the same scope replaces the preference in place', () => {
  const store = storeFor('principal-sarah-researcher');
  const first = store.setPref({ scope: { kind: 'site', id: 'sta-bear-corinne' }, events: ['no-signal'], cadence: 'daily' });
  const second = store.setPref({ scope: { kind: 'site', id: 'sta-bear-corinne' }, events: ['threshold'], cadence: 'weekly' });
  assert.equal(second.ok, true);
  assert.equal(store.listPrefs().length, 1);
  assert.equal(store.listPrefs()[0]!.cadence, 'weekly');
  assert.equal(first.ok && second.ok ? second.pref.id === first.pref.id : false, true); // stable id per scope
});

test('the channel note is a bounded placeholder', () => {
  const store = storeFor('principal-sarah-researcher');
  const result = store.setPref({ scope: { kind: 'site', id: 'sta-bear-corinne' }, events: ['new-site'], cadence: 'immediate', channelNote: 'x'.repeat(500) });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.pref.channelNote.length, prefs.CHANNEL_NOTE_MAX_LENGTH);
});

// ---------------------------------------------------------------------------
// FR-025 boundaries: scope validation against readable scope
// ---------------------------------------------------------------------------

test('subscribing to a restricted site outside the account\'s readable scope rejects with the engine reason (FR-025)', () => {
  const sarah = storeFor('principal-sarah-researcher');
  const rejected = sarah.setPref({ scope: { kind: 'site', id: 'sta-hyrum-diversion-owner' }, events: ['site-edit'], cadence: 'daily' });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.reason, 'unreadable-scope');
    assert.equal(rejected.detail, 'DENY_OUT_OF_SCOPE');
  }
  assert.equal(sarah.listPrefs().length, 0);

  // In-scope commissioner subscribes to the same site successfully.
  const cody = storeFor('principal-cody-commissioner');
  assert.equal(cody.setPref({ scope: { kind: 'site', id: 'sta-hyrum-diversion-owner' }, events: ['site-edit'], cadence: 'daily' }).ok, true);
});

test('deputy subscriptions follow the delegation window: reject before it opens, allow inside it', () => {
  const before = favorites.inMemoryStorage();
  const early = prefs.createNotificationPrefsStore({
    principalId: 'principal-ana-deputy',
    world: world(),
    policy: evaluate,
    now: '2026-02-01T00:00:00Z',
    storage: before,
  });
  const rejected = early.setPref({ scope: { kind: 'site', id: 'sta-hyrum-diversion-owner' }, events: ['no-signal'], cadence: 'immediate' });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.detail, 'DENY_DELEGATION_NOT_EFFECTIVE');

  const inside = storeFor('principal-ana-deputy', world(), favorites.inMemoryStorage());
  assert.equal(inside.setPref({ scope: { kind: 'site', id: 'sta-hyrum-diversion-owner' }, events: ['no-signal'], cadence: 'immediate' }).ok, true);
});

test('unknown site or unknown system scopes reject; a system with no readable station rejects', () => {
  const sarah = storeFor('principal-sarah-researcher');
  const unknownSite = sarah.setPref({ scope: { kind: 'site', id: 'sta-does-not-exist' }, events: ['new-site'], cadence: 'daily' });
  assert.equal(unknownSite.ok, false);
  const unknownSystem = sarah.setPref({ scope: { kind: 'system', id: 'sys-does-not-exist' }, events: ['new-site'], cadence: 'daily' });
  assert.equal(unknownSystem.ok, false);

  // Every Bear station restricted: the system leaves Sarah's readable scope.
  const allRestricted = world(
    (fixtures.stations as unknown as { id: string; systemId: string; visibility: string }[]).map((station) =>
      station.systemId === 'sys-bear-river' ? { ...station, visibility: 'restricted' } : station,
    ) as unknown as object[],
  );
  const restrictedWorld = storeFor('principal-sarah-researcher', allRestricted);
  const rejected = restrictedWorld.setPref({ scope: { kind: 'system', id: 'sys-bear-river' }, events: ['new-site'], cadence: 'daily' });
  assert.equal(rejected.ok, false);
  // In the UNRESTRICTED world Sarah may subscribe to Bear (its public
  // stations are readable), and the in-scope engineer may subscribe even
  // when every Bear station is restricted.
  assert.equal(storeFor('principal-sarah-researcher').setPref({ scope: { kind: 'system', id: 'sys-bear-river' }, events: ['new-site'], cadence: 'daily' }).ok, true);
  assert.equal(storeFor('principal-fatima-engineer', allRestricted).setPref({ scope: { kind: 'system', id: 'sys-bear-river' }, events: ['new-site'], cadence: 'daily' }).ok, true);
});

// ---------------------------------------------------------------------------
// Removal and persistence hygiene
// ---------------------------------------------------------------------------

test('removal persists; invalid payloads reset; invalid enum values never save', () => {
  const storage = favorites.inMemoryStorage();
  const store = storeFor('principal-sarah-researcher', world(), storage);
  const saved = store.setPref({ scope: { kind: 'site', id: 'sta-bear-corinne' }, events: ['no-signal'], cadence: 'daily' });
  assert.equal(saved.ok, true);
  const prefId = saved.ok ? saved.pref.id : '';
  assert.deepEqual(store.removePref(prefId), { ok: true, removed: true });
  assert.equal(storeFor('principal-sarah-researcher', world(), storage).listPrefs().length, 0);

  storage.setItem(prefs.notificationPrefsStorageKey('principal-cody-commissioner'), '{"version":7,"prefs":[]}');
  assert.equal(storeFor('principal-cody-commissioner', world(), storage).listPrefs().length, 0);

  const invalid = storeFor('principal-sarah-researcher').setPref({ scope: { kind: 'site', id: 'sta-bear-corinne' }, events: [], cadence: 'hourly' as 'daily' });
  assert.equal(invalid.ok, false);
});
