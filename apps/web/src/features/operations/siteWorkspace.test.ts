/**
 * WD-009 site workspace persona matrix - THE EVIDENCE SUITE for the
 * assigned operations workspace (FR-019, FR-025 boundaries, FR-036, FR-038,
 * FR-052 no-authority rule, FR-009 persistence seams).
 *
 * Every scenario runs the derivation against the REAL entitlement engine
 * (@utah-water/policy) over the frozen contract fixtures (seed
 * utah-water-fixture-v1), with the clock injected per case. The matrix:
 *
 *  - Cody (commissioner, sys-bear-river) sees ONLY his assigned system's
 *    operational rows - all five Bear stations, nothing from Weber - and no
 *    internal diagnostics (no internal-field capability).
 *  - Ana (deputy) sees the same rows ONLY inside the explicit delegation
 *    window [2026-03-01T07:00:00Z, 2026-06-30T23:59:59Z); outside it she
 *    sees none while public browse stays intact.
 *  - Fatima (engineer variant with view-internal-diagnostics) sees
 *    diagnostics for Bear only - the voltage stream and internal blocks -
 *    and nothing from Weber; Priya (engineer without the capability, Weber
 *    scope) is the cross-scope denial case.
 *  - Revoked/expired assignments drop the rows on the very next derivation
 *    and bump the echoed assignment version (cached views invalidate).
 *  - Favoriting NEVER grants access: a favorited restricted site yields no
 *    operational row for a viewer without grants - it degrades to the
 *    public projection or an omitted-with-notice entry in My Sites, never
 *    operational data.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/operations/siteWorkspace.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { PolicyEvaluator, PolicyWorldMirror } from './assignedScope';

register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const scopePath = './assignedScope.ts';
const scope: typeof import('./assignedScope') = await import(scopePath);
const knownIssuesPath = './knownIssues.ts';
const ki: typeof import('./knownIssues') = await import(knownIssuesPath);
const favoritesPath = '../favorites/favorites.ts';
const favorites: typeof import('../favorites/favorites') = await import(favoritesPath);
const fixturesPath = '../../shell/data/fixtures.ts';
const fixtures: typeof import('../../shell/data/fixtures') = await import(fixturesPath);

const policyPath = '../../../../../packages/policy/src/index.ts';
const policy = (await import(policyPath)) as {
  buildWorld: (input: Record<string, unknown>) => PolicyWorldMirror;
  withEntitlement: (world: PolicyWorldMirror, id: string, patch: Record<string, unknown>) => PolicyWorldMirror;
  evaluate: PolicyEvaluator;
};

const evaluate = policy.evaluate;
const NOW = fixtures.FIXTURE_CLOCK; // 2026-03-09T07:00:00Z (fixed demo clock, inside Ana's window)

const BEAR = ['sta-bear-corinne', 'sta-bear-lake-diagnostic', 'sta-hyrum-diversion-owner', 'sta-hyrum-diversion-public', 'sta-summit-creek-inactive'];

function world(): PolicyWorldMirror {
  return policy.buildWorld({
    principals: {
      seed: fixtures.FIXTURE_SEED,
      organizations: fixtures.organizations as unknown as object[],
      users: fixtures.users as unknown as object[],
      entitlements: fixtures.entitlements as unknown as object[],
    },
    stations: { seed: fixtures.FIXTURE_SEED, stations: fixtures.stations as unknown as object[] },
  });
}

function derive(principalId: string | null, worldSnapshot: PolicyWorldMirror = world(), now: string | Date = NOW) {
  return scope.deriveAssignedScope({ principalId, world: worldSnapshot, policy: evaluate, now });
}

// ---------------------------------------------------------------------------
// Cody: assigned systems only
// ---------------------------------------------------------------------------

test('Cody sees only his assigned system\'s operational rows - all five Bear stations, zero Weber rows', () => {
  const cody = derive('principal-cody-commissioner');
  assert.deepEqual(
    cody.siteRows.map((row) => row.stationId),
    BEAR,
  );
  assert.equal(cody.siteRows.some((row) => row.systemId === 'sys-weber-river'), false);
  // Every admitted row is admitted by his own grant, never another principal's.
  assert.equal(cody.siteRows.every((row) => row.admittedBy.matchedAssignmentIds.length === 1 && row.admittedBy.matchedAssignmentIds[0] === 'ent-commissioner-cody'), true);
});

test('Cody sees restricted AND internal station rows in his system, but no internal FIELD reads (FR-049 discipline)', () => {
  const cody = derive('principal-cody-commissioner');
  const owner = cody.siteRows.find((row) => row.stationId === 'sta-hyrum-diversion-owner')!;
  assert.equal(owner.visibility, 'restricted'); // owner station row is in scope
  const diagnostic = cody.siteRows.find((row) => row.stationId === 'sta-bear-lake-diagnostic')!;
  assert.equal(diagnostic.visibility, 'internal'); // internal station row is in scope for assigned staff
  assert.equal(cody.siteRows.every((row) => row.internalBlockReadable === false), true); // ...but gate codes deny
  assert.equal(diagnostic.diagnosticsStreamIds.length, 0); // and the voltage stream denies
  assert.equal(cody.diagnosticsCapable, false);
});

// ---------------------------------------------------------------------------
// Deputy: effective delegation window at an injected clock
// ---------------------------------------------------------------------------

test('deputy inside the delegation window sees the assigned rows; outside it (before AND after) she sees none', () => {
  const inside = derive('principal-ana-deputy', world(), NOW);
  assert.equal(inside.siteRows.length, 5);

  const before = derive('principal-ana-deputy', world(), '2026-02-20T12:00:00Z');
  assert.equal(before.siteRows.length, 0);
  assert.equal(before.emptyReason, 'delegation-not-effective');

  const after = derive('principal-ana-deputy', world(), '2026-07-05T00:00:00Z');
  assert.equal(after.siteRows.length, 0);
  assert.equal(after.emptyReason, 'delegation-expired');
});

test('deputy outside the delegation window keeps intact public browse (separate tab, public projection only)', () => {
  const browse = scope.publicBrowseRows(world(), evaluate, '2026-07-05T00:00:00Z');
  assert.deepEqual(
    browse.map((row) => row.stationId),
    ['sta-bear-corinne', 'sta-hyrum-diversion-public', 'sta-summit-creek-inactive'],
  );
  // The delegation notice carries the audited window so the UI can explain the empty tab.
  const after = derive('principal-ana-deputy', world(), '2026-07-05T00:00:00Z');
  assert.equal(after.delegation!.delegatedBy, 'principal-cody-commissioner');
  assert.equal(after.delegation!.expiresAt, '2026-06-30T23:59:59Z');
});

// ---------------------------------------------------------------------------
// Fatima vs Priya: engineer capability variants and cross-scope denial
// ---------------------------------------------------------------------------

test('Fatima sees diagnostics for Bear only: voltage stream allowed, internal blocks allowed, nothing from Weber', () => {
  const fatima = derive('principal-fatima-engineer');
  assert.deepEqual(
    fatima.siteRows.map((row) => row.stationId),
    BEAR,
  );
  assert.equal(fatima.siteRows.some((row) => row.systemId === 'sys-weber-river'), false);
  const diagnostic = fatima.siteRows.find((row) => row.stationId === 'sta-bear-lake-diagnostic')!;
  assert.deepEqual(diagnostic.diagnosticsStreamIds, ['str-diag-voltage']);
  const voltage = diagnostic.streams.find((stream) => stream.streamId === 'str-diag-voltage')!;
  assert.equal(voltage.allowed, true);
  assert.equal(voltage.reason, 'ALLOW_PROTECTED');
  const corinne = fatima.siteRows.find((row) => row.stationId === 'sta-bear-corinne')!;
  assert.equal(corinne.internalBlockReadable, true); // FR-049: public station, internal block, capability in scope
});

test('Priya (engineer WITHOUT view-internal-diagnostics, Weber scope) receives nothing from Bear', () => {
  const priya = derive('principal-priya-engineer');
  assert.deepEqual(
    priya.siteRows.map((row) => row.stationId),
    ['sta-ogden-valley-proposed'],
  );
  // Direct cross-scope probes on every Bear station and the Bear voltage stream.
  const snapshot = world();
  for (const id of [...BEAR, 'str-diag-voltage']) {
    const verdict = evaluate(
      { principal: snapshot.principals['principal-priya-engineer']!, action: 'view-restricted-details', object: { kind: 'station', id, fields: ['restricted'] } },
      snapshot,
      NOW,
    );
    assert.equal(verdict.effect, 'deny', `${id} must deny for Priya`);
    assert.equal(verdict.reason, 'DENY_OUT_OF_SCOPE', `${id} denial reason for Priya`);
  }
  // Priya's variant carries no view-internal-diagnostics, but her grant DOES
  // carry edit-site-metadata - which the matrix also admits for internal-field
  // reads inside her own scope. The variant difference shows on BEAR (nothing
  // at all), not on internal-class capability per se.
  assert.equal(priya.diagnosticsCapable, true); // Weber-only, via edit-site-metadata
  assert.equal(priya.siteRows.every((row) => row.diagnosticsStreamIds.length === 0), true); // no internal stream exists in Weber
});

// ---------------------------------------------------------------------------
// Revocation and expiry: immediate effect at grant-version change
// ---------------------------------------------------------------------------

test('revoked assignment drops every row on the next derivation (before/after instants at the version change)', () => {
  const snapshot = world();
  const before = derive('principal-cody-commissioner', snapshot, NOW);
  assert.equal(before.siteRows.length, 5);
  assert.equal(before.assignmentVersion, 11);

  const revoked = policy.withEntitlement(snapshot, 'ent-commissioner-cody', { status: 'revoked', grantVersion: 12 });
  const after = derive('principal-cody-commissioner', revoked, NOW); // same clock: only the version changed
  assert.equal(after.siteRows.length, 0);
  assert.equal(after.emptyReason, 'assignment-revoked');
  assert.equal(after.assignmentVersion, 12); // a view cached at version 11 is now stale/invalid

  // Same grant, simply expired, behaves identically.
  const expired = policy.withEntitlement(snapshot, 'ent-commissioner-cody', { expiresAt: '2026-03-08T00:00:00Z', grantVersion: 13 });
  const afterExpiry = derive('principal-cody-commissioner', expired, NOW);
  assert.equal(afterExpiry.siteRows.length, 0);
  assert.equal(afterExpiry.emptyReason, 'assignment-expired');
  assert.equal(afterExpiry.assignmentVersion, 13);
});

test('revocation also removes the diagnostics and internal known-issue context Fatima had', () => {
  const snapshot = world();
  const revoked = policy.withEntitlement(snapshot, 'ent-engineer-fatima', { status: 'revoked', grantVersion: 12 });
  const after = derive('principal-fatima-engineer', revoked, NOW);
  assert.equal(after.siteRows.length, 0);
  const issues = ki.knownIssuesForViewer({ principalId: 'principal-fatima-engineer', world: revoked, policy: evaluate, now: NOW });
  assert.deepEqual(
    issues.carried.map((entry) => entry.issue.id),
    ['ki-corinne-outage-20260308'], // public context only; the internal issue is gone
  );
});

// ---------------------------------------------------------------------------
// Favorites never grant access (FR-052 boundary, operations side)
// ---------------------------------------------------------------------------

test('a favorited restricted site yields NO operational row for a grant-less viewer: favorites carry no authority', () => {
  // Sarah (researcher, dataset scope only) favorites the restricted owner station.
  const store = favorites.createFavoritesStore({
    principalId: 'principal-sarah-researcher',
    world: world(),
    policy: evaluate,
    now: NOW,
    storage: favorites.inMemoryStorage(),
  });
  const added = store.addFavorite('sta-hyrum-diversion-owner');
  assert.equal(added.ok, false, 'add itself rejects: the site is not readable for Sarah at all');
  assert.equal(added.reason, 'DENY_OUT_OF_SCOPE');

  // Favorite a PUBLIC station, then the world restricts it: the workspace
  // still grants nothing and the favorite degrades (read-time validation).
  const storage = favorites.inMemoryStorage();
  const store2 = favorites.createFavoritesStore({
    principalId: 'principal-sarah-researcher',
    world: world(),
    policy: evaluate,
    now: NOW,
    storage,
  });
  assert.equal(store2.addFavorite('sta-bear-corinne').ok, true);
  const restrictedCorinne = policy.buildWorld({
    principals: {
      seed: fixtures.FIXTURE_SEED,
      organizations: fixtures.organizations as unknown as object[],
      users: fixtures.users as unknown as object[],
      entitlements: fixtures.entitlements as unknown as object[],
    },
    stations: {
      seed: fixtures.FIXTURE_SEED,
      stations: (fixtures.stations as unknown as { id: string; visibility: string }[]).map((station) =>
        station.id === 'sta-bear-corinne' ? { ...station, visibility: 'restricted' } : station,
      ) as unknown as object[],
    },
  });
  const sarah = derive('principal-sarah-researcher', restrictedCorinne, NOW);
  assert.equal(sarah.siteRows.length, 0); // no operational rows even though the site is favorited
  const view = favorites.createFavoritesStore({
    principalId: 'principal-sarah-researcher',
    world: restrictedCorinne,
    policy: evaluate,
    now: NOW,
    storage, // same persisted favorites, re-validated against the changed world
  }).listFavorites();
  const degraded = view.find((entry) => entry.stationId === 'sta-bear-corinne')!;
  assert.equal(degraded.status, 'omitted-with-notice'); // never operational data
  // And an in-scope engineer WITH grants keeps operational rows for it after the same change.
  const fatima = derive('principal-fatima-engineer', restrictedCorinne, NOW);
  assert.equal(fatima.siteRows.some((row) => row.stationId === 'sta-bear-corinne'), true);
});

// ---------------------------------------------------------------------------
// Known-issue context rides the same matrix (FR-038)
// ---------------------------------------------------------------------------

test('known-issue context follows the same scope matrix: Cody public-only, Fatima both, Priya none of Bear', () => {
  const forId = (principalId: string) =>
    ki.knownIssuesForViewer({ principalId, world: world(), policy: evaluate, now: NOW }).carried.map((entry) => entry.issue.id);
  assert.deepEqual(forId('principal-cody-commissioner'), ['ki-corinne-outage-20260308']);
  assert.deepEqual(forId('principal-fatima-engineer'), ['ki-corinne-outage-20260308', 'ki-hyrum-owner-weir-202603']);
  assert.deepEqual(forId('principal-priya-engineer'), ['ki-corinne-outage-20260308']); // public context of a published Bear station only
});
