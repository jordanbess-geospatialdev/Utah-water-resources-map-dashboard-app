/**
 * Assigned-scope derivation tests (FR-019), driven by the REAL entitlement
 * engine (@utah-water/policy) over the frozen contract fixtures.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/operations/assignedScope.test.ts
 *
 * (Import pattern per apps/web/tests/adapters.test.ts: computed specifiers
 * for node --test --experimental-strip-types, type-only imports for tsc.
 * The real engine's sources cannot enter the web tsc program - see
 * assignedScope.ts - so the test loads it through a computed specifier and
 * the derivation consumes it through the structural port.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { AssignedSiteRow, PolicyDecisionMirror, PolicyEvaluator, PolicyWorldMirror } from './assignedScope';

// Extensionless src imports under node --test (see tests/ts-resolve-hook.mjs).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const scopePath = './assignedScope.ts';
const scope: typeof import('./assignedScope') = await import(scopePath);
const fixturePolicyPath = './fixturePolicy.ts';
const fixturePolicy: typeof import('./fixturePolicy') = await import(fixturePolicyPath);
const fixturesPath = '../../shell/data/fixtures.ts';
const fixtures: typeof import('../../shell/data/fixtures') = await import(fixturesPath);

// The real engine (packages/policy/src), loaded outside the tsc program.
const policyPath = '../../../../../packages/policy/src/index.ts';
const policy = (await import(policyPath)) as {
  buildWorld: (input: Record<string, unknown>) => PolicyWorldMirror;
  withEntitlement: (world: PolicyWorldMirror, id: string, patch: Record<string, unknown>) => PolicyWorldMirror;
  evaluate: PolicyEvaluator;
};

/** The fixture world built by the REAL engine; the derivation consumes it through the structural port. */
function realWorld(): PolicyWorldMirror {
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

const evaluate = policy.evaluate;
const NOW = fixtures.FIXTURE_CLOCK; // 2026-03-09T07:00:00Z, inside Ana's delegation window
const ids = (rows: readonly AssignedSiteRow[]) => rows.map((row) => row.stationId);

const BEAR_STATIONS = ['sta-bear-corinne', 'sta-bear-lake-diagnostic', 'sta-hyrum-diversion-owner', 'sta-hyrum-diversion-public', 'sta-summit-creek-inactive'];

function derive(principalId: string | null, world: PolicyWorldMirror = realWorld(), now: string | Date = NOW) {
  return scope.deriveAssignedScope({ principalId, world, policy: evaluate, now });
}

// ---------------------------------------------------------------------------
// Row admission through the real engine
// ---------------------------------------------------------------------------

test('Cody derives exactly his assigned system (Bear River) with every fixture station, deterministic order', () => {
  const first = derive('principal-cody-commissioner');
  const second = derive('principal-cody-commissioner');
  assert.deepEqual(ids(first.siteRows), BEAR_STATIONS);
  assert.deepEqual(first, second); // pure: identical inputs, identical outputs

  assert.equal(first.systems.length, 1);
  assert.equal(first.systems[0]!.systemId, 'sys-bear-river');
  assert.deepEqual(ids(first.systems[0]!.siteRows), BEAR_STATIONS); // sorted station ids
  assert.equal(first.emptyReason, null);
  assert.equal(first.assignmentVersion, 11); // max fixture grantVersion
  assert.equal(first.displayName, 'Cody Jensen');
  // The admitting decision is the engine's, with the audit trail.
  const admitted = first.siteRows[0]!.admittedBy as PolicyDecisionMirror;
  assert.equal(admitted.effect, 'allow');
  assert.equal(admitted.reason, 'ALLOW_PROTECTED');
  assert.deepEqual(admitted.matchedAssignmentIds, ['ent-commissioner-cody']);
});

test('commissioner holds no internal-field capability: internal blocks and diagnostic streams deny', () => {
  const cody = derive('principal-cody-commissioner');
  for (const row of cody.siteRows) {
    assert.equal(row.internalBlockReadable, false, `${row.stationId} internal block must deny for Cody`);
  }
  const diagnostic = cody.siteRows.find((row) => row.stationId === 'sta-bear-lake-diagnostic')!;
  const voltage = diagnostic.streams.find((stream) => stream.streamId === 'str-diag-voltage')!;
  assert.equal(voltage.allowed, false);
  assert.equal(voltage.reason, 'DENY_FIELD_VISIBILITY');
  assert.equal(voltage.diagnostic, true);
  assert.equal(cody.diagnosticsCapable, false);
});

test('Fatima (engineer variant with view-internal-diagnostics) sees Bear diagnostics only', () => {
  const fatima = derive('principal-fatima-engineer');
  assert.deepEqual(ids(fatima.siteRows), BEAR_STATIONS);
  assert.equal(fatima.diagnosticsCapable, true);
  const diagnostic = fatima.siteRows.find((row) => row.stationId === 'sta-bear-lake-diagnostic')!;
  assert.deepEqual(diagnostic.diagnosticsStreamIds, ['str-diag-voltage']);
  // Public station with an internal block (FR-049): row visibility is not sufficient,
  // but Fatima's capability + scope satisfies the internal class read.
  const corinne = fatima.siteRows.find((row) => row.stationId === 'sta-bear-corinne')!;
  assert.equal(corinne.internalBlockReadable, true);
});

test('Priya derives Weber only: every Bear evaluation denies out of scope', () => {
  const priya = derive('principal-priya-engineer');
  assert.deepEqual(ids(priya.siteRows), ['sta-ogden-valley-proposed']); // restricted + proposed, read class allows it
  assert.equal(priya.systems[0]!.systemId, 'sys-weber-river');
  // Cross-scope denial: probe the engine directly for one Bear station.
  const bear = realWorld().objects['sta-bear-corinne']!;
  const verdict = evaluate({ principal: realWorld().principals['principal-priya-engineer']!, action: 'view-restricted-details', object: { kind: 'station', id: bear.id, fields: ['restricted'] } }, realWorld(), NOW) as PolicyDecisionMirror;
  assert.equal(verdict.effect, 'deny');
  assert.equal(verdict.reason, 'DENY_OUT_OF_SCOPE');
});

test('Diego (statewide steward) derives every station in both systems', () => {
  const diego = derive('principal-diego-steward');
  assert.deepEqual(ids(diego.siteRows), [...BEAR_STATIONS, 'sta-ogden-valley-proposed']);
  assert.equal(diego.systems.length, 2);
  assert.equal(diego.diagnosticsCapable, true); // statewide-administration covers internal fields
});

// ---------------------------------------------------------------------------
// Deputy delegation window at an injected clock
// ---------------------------------------------------------------------------

test('deputy inside the delegation window derives assigned rows through the delegation grant', () => {
  const ana = derive('principal-ana-deputy');
  assert.deepEqual(ids(ana.siteRows), BEAR_STATIONS);
  assert.deepEqual(ana.siteRows[0]!.admittedBy.matchedAssignmentIds, ['ent-deputy-ana']);
  assert.deepEqual(ana.delegation, { effectiveAt: '2026-03-01T07:00:00Z', expiresAt: '2026-06-30T23:59:59Z', delegatedBy: 'principal-cody-commissioner' });
  assert.equal(ana.siteRows.every((row) => row.internalBlockReadable === false), true); // deputy grant carries no internal-field capability
});

test('deputy delegation window is half-open: last instant inside, first instant outside', () => {
  const lastInside = derive('principal-ana-deputy', realWorld(), '2026-06-30T23:59:58Z');
  assert.equal(lastInside.siteRows.length, 5);
  const firstOutside = derive('principal-ana-deputy', realWorld(), '2026-06-30T23:59:59Z');
  assert.equal(firstOutside.siteRows.length, 0);
  assert.equal(firstOutside.emptyReason, 'delegation-expired');
});

test('deputy before the delegation window sees nothing, but public browse stays intact', () => {
  const before = derive('principal-ana-deputy', realWorld(), '2026-02-15T00:00:00Z');
  assert.equal(before.siteRows.length, 0);
  assert.equal(before.emptyReason, 'delegation-not-effective');
  const browse = scope.publicBrowseRows(realWorld(), evaluate, '2026-02-15T00:00:00Z');
  assert.deepEqual(browse.map((row) => row.stationId), ['sta-bear-corinne', 'sta-hyrum-diversion-public', 'sta-summit-creek-inactive']);
  for (const row of browse) {
    assert.equal(row.publishedBy.reason, 'ALLOW_PUBLIC_READ');
    assert.equal(row.publishedBy.via, 'public-read');
  }
});

// ---------------------------------------------------------------------------
// Revocation and expiry at grant-version change
// ---------------------------------------------------------------------------

test('revoking the commissioner grant drops every row on the next derivation and bumps the echoed version', () => {
  const world = realWorld();
  const before = derive('principal-cody-commissioner', world);
  assert.equal(before.siteRows.length, 5);
  assert.equal(before.assignmentVersion, 11);

  const revokedWorld = policy.withEntitlement(world, 'ent-commissioner-cody', { status: 'revoked', grantVersion: 12 });
  const after = derive('principal-cody-commissioner', revokedWorld);
  assert.equal(after.siteRows.length, 0);
  assert.equal(after.emptyReason, 'assignment-revoked');
  assert.equal(after.assignmentVersion, 12); // cached views keyed on 11 are stale
});

test('expiring the commissioner grant drops rows the same way', () => {
  const world = realWorld();
  const expiredWorld = policy.withEntitlement(world, 'ent-commissioner-cody', { expiresAt: '2026-03-01T00:00:00Z', grantVersion: 12 });
  const after = derive('principal-cody-commissioner', expiredWorld);
  assert.equal(after.siteRows.length, 0);
  assert.equal(after.emptyReason, 'assignment-expired');
});

// ---------------------------------------------------------------------------
// Anonymous, unknown and inactive principals
// ---------------------------------------------------------------------------

test('anonymous, unknown and inactive principals derive empty with distinct reasons', () => {
  assert.equal(derive(null).emptyReason, 'anonymous');
  assert.equal(derive('principal-nobody').emptyReason, 'unknown-principal');

  const world = realWorld();
  const inactiveWorld = (policy as unknown as { withPrincipal: (w: PolicyWorldMirror, id: string, patch: Record<string, unknown>) => PolicyWorldMirror }).withPrincipal(world, 'principal-cody-commissioner', { active: false });
  const inactive = derive('principal-cody-commissioner', inactiveWorld);
  assert.equal(inactive.emptyReason, 'principal-inactive');
  assert.equal(inactive.siteRows.length, 0);
});

// ---------------------------------------------------------------------------
// Public browse and shared readability rule
// ---------------------------------------------------------------------------

test('public browse is the strict public projection: restricted and internal stations never appear', () => {
  const browse = scope.publicBrowseRows(realWorld(), evaluate, NOW);
  assert.deepEqual(
    browse.map((row) => row.stationId),
    ['sta-bear-corinne', 'sta-hyrum-diversion-public', 'sta-summit-creek-inactive'], // inactive stays published as a historical record
  );
});

test('isReadableForPrincipal: public projection or a protected read, nothing more', () => {
  const world = realWorld();
  // Public station: readable by anyone (favorites rule, FR-052).
  assert.deepEqual(scope.isReadableForPrincipal(null, 'sta-bear-corinne', world, evaluate, NOW), { readable: true, reason: 'ALLOW_PUBLIC_READ' });
  // Restricted owner station: Cody in scope reads it, Sarah (dataset scope) does not.
  assert.equal(scope.isReadableForPrincipal('principal-cody-commissioner', 'sta-hyrum-diversion-owner', world, evaluate, NOW).readable, true);
  const sarah = scope.isReadableForPrincipal('principal-sarah-researcher', 'sta-hyrum-diversion-owner', world, evaluate, NOW);
  assert.equal(sarah.readable, false);
  assert.equal(sarah.reason, 'DENY_OUT_OF_SCOPE');
  // Unknown object denies, never errors.
  assert.equal(scope.isReadableForPrincipal('principal-cody-commissioner', 'sta-does-not-exist', world, evaluate, NOW).readable, false);
});

// ---------------------------------------------------------------------------
// The fixture mirror port equals the real engine over the fixture matrix
// ---------------------------------------------------------------------------

test('fixture mirror world equals the real engine world (objects, assignments, version)', () => {
  const real = realWorld();
  const mirror = fixturePolicy.fixtureWorld();
  assert.equal(mirror.assignmentVersion, real.assignmentVersion);
  assert.deepEqual(Object.keys(mirror.objects).sort(), Object.keys(real.objects).sort());
  for (const id of Object.keys(real.objects)) {
    const a = real.objects[id]!;
    const b = mirror.objects[id]!;
    assert.equal(b.kind, a.kind, `${id} kind`);
    assert.equal(b.visibility, a.visibility, `${id} visibility`);
    assert.equal(b.status, a.status, `${id} status`);
    assert.equal(b.systemId ?? null, a.systemId ?? null, `${id} systemId`);
    assert.equal(b.stationId ?? null, a.stationId ?? null, `${id} stationId`);
    assert.equal(b.ownerOrganizationId ?? null, a.ownerOrganizationId ?? null, `${id} ownerOrganizationId`);
    assert.deepEqual(b.fields ?? {}, a.fields ?? {}, `${id} fields`);
  }
  assert.equal(mirror.assignments.length, real.assignments.length);
});

test('fixture mirror evaluator agrees with the real engine on every fixture persona x object x field class x boundary clock', () => {
  const world = realWorld();
  const principals = [
    null,
    'principal-diego-steward',
    'principal-fatima-engineer',
    'principal-priya-engineer',
    'principal-cody-commissioner',
    'principal-ana-deputy',
    'principal-sarah-researcher',
  ];
  const clocks = [
    '2025-12-01T00:00:00Z', // nobody but Diego and Cody effective; Priya not yet
    '2026-03-01T06:59:59Z', // one instant before Ana's delegation opens
    '2026-03-01T07:00:00Z', // exactly at the delegation boundary (half-open: inside)
    fixtures.FIXTURE_CLOCK, // 2026-03-09T07:00:00Z
    '2026-06-30T23:59:59Z', // delegation expired (first outside instant)
  ];
  const actions: { action: string; fields: readonly ('public' | 'restricted' | 'internal')[] }[] = [
    { action: 'browse-published', fields: ['public'] },
    { action: 'view-restricted-details', fields: ['public'] },
    { action: 'view-restricted-details', fields: ['restricted'] },
    { action: 'view-restricted-details', fields: ['internal'] },
  ];
  let compared = 0;
  for (const now of clocks) {
    for (const principalId of principals) {
      const principal = principalId === null ? null : world.principals[principalId] ?? null;
      for (const id of Object.keys(world.objects).sort()) {
        const object = world.objects[id]!;
        if (object.kind === 'user' || object.kind === 'organization') continue; // own-account/org objects: not exercised by this feature
        for (const { action, fields } of actions) {
          const request = { principal, action, object: { kind: object.kind, id: object.id, fields } };
          const real = evaluate(request, world, now) as PolicyDecisionMirror;
          const mirror = fixturePolicy.fixturePolicyEvaluate(request, world, now);
          assert.equal(mirror.effect, real.effect, `${action} ${id} [${fields}] principal=${principalId} now=${now}`);
          assert.equal(mirror.reason, real.reason, `${action} ${id} [${fields}] principal=${principalId} now=${now}`);
          assert.equal(mirror.via, real.via, `${action} ${id} [${fields}] principal=${principalId} now=${now}`);
          assert.deepEqual(mirror.matchedAssignmentIds, real.matchedAssignmentIds, `${action} ${id} [${fields}] principal=${principalId} now=${now}`);
          compared += 1;
        }
      }
    }
  }
  assert.ok(compared > 500, `cross-checked ${compared} decisions`);
});

test('fixture mirror derivation equals the real-engine derivation for every fixture persona', () => {
  const realWorldSnapshot = realWorld();
  // Normalize decisions to the port's own fields: the real engine echoes
  // extra audit fields (actorId, policyVersion, evaluatedAt) the mirror
  // port does not model, and the derivation stores decisions as-is.
  const normalize = (result: ReturnType<typeof scope.deriveAssignedScope>) => {
    const normalizedRow = (row: typeof result.siteRows[number]) => ({
      stationId: row.stationId,
      systemId: row.systemId,
      visibility: row.visibility,
      status: row.status,
      internalBlockReadable: row.internalBlockReadable,
      diagnosticsStreamIds: row.diagnosticsStreamIds,
      streams: row.streams,
      admittedBy: {
        effect: row.admittedBy.effect,
        reason: row.admittedBy.reason,
        via: row.admittedBy.via,
        assignmentVersion: row.admittedBy.assignmentVersion,
        matchedAssignmentIds: row.admittedBy.matchedAssignmentIds,
      },
    });
    return {
      principalId: result.principalId,
      active: result.active,
      emptyReason: result.emptyReason,
      diagnosticsCapable: result.diagnosticsCapable,
      delegation: result.delegation,
      assignmentVersion: result.assignmentVersion,
      evaluatedAt: result.evaluatedAt,
      rows: result.siteRows.map(normalizedRow),
      systems: result.systems.map((group) => ({ systemId: group.systemId, siteRows: group.siteRows.map(normalizedRow) })),
    };
  };
  for (const principalId of ['principal-cody-commissioner', 'principal-fatima-engineer', 'principal-priya-engineer', 'principal-ana-deputy', 'principal-diego-steward', 'principal-sarah-researcher', null]) {
    const viaReal = normalize(scope.deriveAssignedScope({ principalId, world: realWorldSnapshot, policy: evaluate, now: NOW }));
    const viaMirror = normalize(
      scope.deriveAssignedScope({
        principalId,
        world: fixturePolicy.fixtureWorld(),
        policy: fixturePolicy.fixturePolicyEvaluate,
        now: NOW,
      }),
    );
    assert.deepEqual(viaMirror, viaReal, `persona ${principalId}`);
  }
});
