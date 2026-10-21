/**
 * Favorites store tests (FR-009, FR-052): per-account persistence with a
 * versioned schema, readability validation at ADD time AND at READ time
 * (favorite-then-restricted degrades to omitted-with-notice), removal
 * persistence, corrupt-schema reset, and the favorites-carry-no-authority
 * boundary - all against the REAL entitlement engine.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/favorites/favorites.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { PolicyEvaluator, PolicyWorldMirror } from '../operations/assignedScope';

register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const favoritesPath = './favorites.ts';
const favorites: typeof import('./favorites') = await import(favoritesPath);
const scopePath = '../operations/assignedScope.ts';
const scope: typeof import('../operations/assignedScope') = await import(scopePath);
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
  return favorites.createFavoritesStore({ principalId, world: worldSnapshot, policy: evaluate, now: NOW, storage });
}

// ---------------------------------------------------------------------------
// Per-account store, versioned persistence
// ---------------------------------------------------------------------------

test('favorites are per-account: separate keys in one storage, no cross-account reads', () => {
  const storage = favorites.inMemoryStorage();
  const sarah = storeFor('principal-sarah-researcher', world(), storage);
  assert.equal(sarah.addFavorite('sta-bear-corinne').ok, true);
  const cody = storeFor('principal-cody-commissioner', world(), storage);
  assert.equal(cody.recordCount(), 0);
  assert.equal(sarah.recordCount(), 1);
  assert.equal(favorites.favoritesStorageKey('principal-sarah-researcher') !== favorites.favoritesStorageKey('principal-cody-commissioner'), true);
});

test('persistence roundtrip: a new store over the same storage replays the saved favorites', () => {
  const storage = favorites.inMemoryStorage();
  const first = storeFor('principal-sarah-researcher', world(), storage);
  assert.equal(first.addFavorite('sta-bear-corinne').ok, true);
  assert.equal(first.addFavorite('sta-hyrum-diversion-public').ok, true);
  const second = storeFor('principal-sarah-researcher', world(), storage);
  assert.deepEqual(
    second.listFavorites().map((favorite) => favorite.stationId),
    ['sta-bear-corinne', 'sta-hyrum-diversion-public'],
  );
  // The persisted payload is the versioned schema.
  const raw = JSON.parse(storage.getItem(favorites.favoritesStorageKey('principal-sarah-researcher'))!) as { version: number; favorites: { stationId: string }[] };
  assert.equal(raw.version, favorites.FAVORITES_SCHEMA_VERSION);
  assert.deepEqual(
    raw.favorites.map((favorite) => favorite.stationId),
    ['sta-bear-corinne', 'sta-hyrum-diversion-public'],
  );
});

test('unknown schema version or corrupt payload resets to empty, never throws', () => {
  const storage = favorites.inMemoryStorage({
    [favorites.favoritesStorageKey('principal-sarah-researcher')]: '{"version":99,"favorites":[{"stationId":"x"}]}',
  });
  const store = storeFor('principal-sarah-researcher', world(), storage);
  assert.equal(store.recordCount(), 0);
  storage.setItem(favorites.favoritesStorageKey('principal-cody-commissioner'), 'not json at all');
  const cody = storeFor('principal-cody-commissioner', world(), storage);
  assert.equal(cody.recordCount(), 0);
});

// ---------------------------------------------------------------------------
// Add-time validation (readable now)
// ---------------------------------------------------------------------------

test('adding validates readability: public site ok for anyone, restricted site only in scope', () => {
  const sarah = storeFor('principal-sarah-researcher');
  assert.deepEqual(sarah.addFavorite('sta-bear-corinne'), { ok: true, at: NOW });
  const rejected = sarah.addFavorite('sta-hyrum-diversion-owner');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'DENY_OUT_OF_SCOPE');
  assert.equal(sarah.recordCount(), 1); // rejection stored nothing

  const cody = storeFor('principal-cody-commissioner');
  const inScope = cody.addFavorite('sta-hyrum-diversion-owner');
  assert.equal(inScope.ok, true); // commissioner's grant covers the owner station
  const listed = cody.listFavorites().find((favorite) => favorite.stationId === 'sta-hyrum-diversion-owner')!;
  assert.equal(listed.status, 'ok');
  assert.equal(listed.viaAssignment, true); // readable through the assignment, not the public projection
});

test('an owner-organization member favorites their restricted station through the organization grant', () => {
  const owner = policy.buildWorld({
    principals: {
      seed: fixtures.FIXTURE_SEED,
      organizations: fixtures.organizations as unknown as object[],
      users: fixtures.users as unknown as object[],
      entitlements: [
        ...(fixtures.entitlements as unknown as object[]),
        {
          id: 'ent-wiley-cache-water',
          principalId: 'principal-wiley-water-user',
          role: 'water-user',
          capabilities: ['view-restricted-details'],
          scopeType: 'organization',
          scopeId: 'org-cache-water',
          effectiveAt: '2025-10-01T00:00:00Z',
          expiresAt: null,
          status: 'active',
          delegation: null,
          grantedBy: 'principal-diego-steward',
          grantVersion: 20,
        },
      ],
    },
    extraPrincipals: [
      { id: 'principal-wiley-water-user', displayName: 'Wiley (demo water user)', roles: ['water-user'], active: true, assignedSystemId: null },
    ],
    stations: { seed: fixtures.FIXTURE_SEED, stations: fixtures.stations as unknown as object[] },
  });
  const wiley = favorites.createFavoritesStore({ principalId: 'principal-wiley-water-user', world: owner, policy: evaluate, now: NOW, storage: favorites.inMemoryStorage() });
  const added = wiley.addFavorite('sta-hyrum-diversion-owner');
  assert.equal(added.ok, true);
  // ...but the OTHER restricted station (another owner's) rejects.
  const foreign = wiley.addFavorite('sta-ogden-valley-proposed');
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'DENY_OUT_OF_SCOPE');
});

// ---------------------------------------------------------------------------
// Read-time validation (favorite-then-restricted)
// ---------------------------------------------------------------------------

test('a favorited site that later becomes restricted degrades to omitted-with-notice, never deleted', () => {
  const storage = favorites.inMemoryStorage();
  const before = storeFor('principal-sarah-researcher', world(), storage);
  assert.equal(before.addFavorite('sta-bear-corinne').ok, true);

  const restricted = world(
    (fixtures.stations as unknown as { id: string; visibility: string }[]).map((station) =>
      station.id === 'sta-bear-corinne' ? { ...station, visibility: 'restricted' } : station,
    ) as unknown as object[],
  );
  const after = storeFor('principal-sarah-researcher', restricted, storage); // same persisted favorites, new world
  assert.equal(after.recordCount(), 1); // the record is kept
  const view = after.listFavorites();
  assert.equal(view.length, 1);
  assert.equal(view[0]!.stationId, 'sta-bear-corinne');
  assert.equal(view[0]!.status, 'omitted-with-notice');
  // Sarah holds a (dataset-scoped) restricted-read capability, so the engine's
  // protected branch answers the read probe and denies by scope.
  assert.equal(view[0]!.reason, 'DENY_OUT_OF_SCOPE');

  // Republish: the favorite returns without any action.
  const republished = storeFor('principal-sarah-researcher', world(), storage);
  assert.equal(republished.listFavorites()[0]!.status, 'ok');
});

// ---------------------------------------------------------------------------
// Removal persists
// ---------------------------------------------------------------------------

test('removal persists across stores and never alters authority', () => {
  const storage = favorites.inMemoryStorage();
  const first = storeFor('principal-sarah-researcher', world(), storage);
  first.addFavorite('sta-bear-corinne');
  assert.deepEqual(first.removeFavorite('sta-bear-corinne'), { ok: true, removed: true });
  assert.equal(first.recordCount(), 0);
  const second = storeFor('principal-sarah-researcher', world(), storage);
  assert.equal(second.recordCount(), 0);
  assert.deepEqual(second.removeFavorite('sta-bear-corinne'), { ok: true, removed: false }); // idempotent
});

// ---------------------------------------------------------------------------
// Favorites carry NO authority (the FR-052 boundary)
// ---------------------------------------------------------------------------

test('favorites never grant access: the engine still denies every protected read for the favorited restricted site', () => {
  const snapshot = world();
  const cody = storeFor('principal-cody-commissioner', snapshot);
  cody.addFavorite('sta-hyrum-diversion-owner');
  // Sarah cannot even add it - and even with the favorite present in HER
  // storage from an earlier world, the workspace derivation stays empty.
  const storage = favorites.inMemoryStorage();
  storage.setItem(
    favorites.favoritesStorageKey('principal-sarah-researcher'),
    JSON.stringify({ version: 1, favorites: [{ stationId: 'sta-hyrum-diversion-owner', addedAt: NOW }] }),
  );
  const sarahWithFavorite = storeFor('principal-sarah-researcher', snapshot, storage);
  assert.equal(sarahWithFavorite.recordCount(), 1);
  const derived = scope.deriveAssignedScope({ principalId: 'principal-sarah-researcher', world: snapshot, policy: evaluate, now: NOW });
  assert.equal(derived.siteRows.length, 0); // the favorite added zero operational rows
  const verdict = evaluate(
    {
      principal: snapshot.principals['principal-sarah-researcher']!,
      action: 'view-restricted-details',
      object: { kind: 'station', id: 'sta-hyrum-diversion-owner', fields: ['restricted'] },
    },
    snapshot,
    NOW,
  );
  assert.equal(verdict.effect, 'deny'); // the engine has never heard of the favorite, by design
  assert.equal(verdict.reason, 'DENY_OUT_OF_SCOPE');
});
