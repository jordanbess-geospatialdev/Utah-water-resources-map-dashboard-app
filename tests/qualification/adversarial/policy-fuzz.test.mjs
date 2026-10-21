/**
 * WD-021 adversarial sweep (b): policy fuzz.
 *
 * Generates 640 deterministic (principal, action, object, fields, clock)
 * tuples with a seeded PRNG and asserts the REAL engine's decision equals an
 * INDEPENDENT oracle re-derived from the specification formula
 *
 *   allow_public_read = explicit_public_read_action
 *                       AND object_is_currently_published
 *                       AND fields_are_in_public_projection
 *   allow_protected  = authenticated AND principal_is_active
 *                      AND role_grants_requested_action
 *                      AND object_is_within_current_assignment
 *                      AND field_visibility_allows_requested_fields
 *                      AND lifecycle_allows_requested_change
 *
 * plus the documented matrix notes (deputies need explicit time-bounded
 * delegations; statewide-administration satisfies the operational verbs it
 * covers; edit-permitted-site-fields is the commissioner variant of
 * edit-site-metadata; request-ingestion-configuration is never satisfied by
 * configure-ingestion; supplier-reporting is an R2 verb no MVP grant holds).
 * The oracle reads the fixture JSON directly and shares NO code with
 * packages/policy/src/engine.ts, so a bug in either side shows up as a
 * mismatch. Clocks deliberately hit every validity boundary (delegation
 * effective/expiry instants, assignment effective instants, half-open edges)
 * to catch off-by-one interval errors.
 *
 * Run (from repo root):
 *   node --test tests/qualification/adversarial/policy-fuzz.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, evaluate, withPrincipal } from '../../../packages/policy/src/index.ts';
import { ROLE_CEILING, CAPABILITY_SATISFIES } from '../../../packages/policy/src/matrix.ts';
import { mulberry32, pick, principalsFixture, stationsFixture, sha256 } from './canaries.mjs';

const moduleWorld = buildWorld({ principals: principalsFixture, stations: stationsFixture });
const world = moduleWorld;

// ---------------------------------------------------------------------------
// Independent oracle (specification formula + fixture JSON only)
// ---------------------------------------------------------------------------

/** Operational verbs that, when held over an object, satisfy view-restricted-details (matrix row 3 "Assigned"). */
const OPERATIONAL = new Set([
  'view-restricted-details',
  'enter-readings',
  'revise-best-available',
  'edit-site-metadata',
  'edit-permitted-site-fields',
  'create-sites',
  'review-data',
  'field-visits',
  'view-internal-diagnostics',
  'generate-reports',
  'create-exports',
  'read-approved-datasets',
]);

/** Capabilities that permit reading internal-class fields (gate codes, wiring notes). */
const INTERNAL_READERS = new Set(['view-internal-diagnostics', 'edit-site-metadata', 'statewide-administration']);

/**
 * Verbs the steward's statewide-administration grant satisfies: the matrix
 * column "Statewide..." for Diego (view-restricted-details, enter-readings,
 * revise-best-available, edit-site-metadata, create-sites, review-data,
 * manage-vocabulary, manage-users, configure-ingestion, withdraw-raw,
 * generate-reports, create-exports, read-approved-datasets,
 * view-internal-diagnostics, statewide-administration itself) PLUS
 * field-visits: CAPABILITY_SATISFIES also lets statewide-administration
 * satisfy field-visits although ROLE_CEILING.steward does not list it —
 * filed as DEFECT-Q3 (policy-data inconsistency, pinned by a test below).
 */
const STATEWIDE_SATISFIES = new Set([
  'view-restricted-details',
  'enter-readings',
  'revise-best-available',
  'edit-site-metadata',
  'create-sites',
  'review-data',
  'manage-vocabulary',
  'manage-users',
  'manage-assignments',
  'configure-ingestion',
  'withdraw-raw',
  'generate-reports',
  'create-exports',
  'read-approved-datasets',
  'view-internal-diagnostics',
  'field-visits',
  'statewide-administration',
]);

/**
 * Independent satisfaction table, derived from the matrix notes in
 * docs/product/baseline/02-technical-specification.md, NOT from matrix.ts.
 */
function oracleSatisfies(action, granted) {
  if (granted.includes(action)) return true;
  if (action === 'view-restricted-details') return granted.some((c) => OPERATIONAL.has(c));
  if (action === 'edit-site-metadata' || action === 'edit-permitted-site-fields') {
    return granted.includes('edit-permitted-site-fields') || granted.includes('edit-site-metadata') || granted.includes('statewide-administration');
  }
  // Only an identical grant satisfies own-account verbs, R2 verbs and
  // unknown/hostile action strings; every verb the matrix gives Diego
  // statewide is satisfied by statewide-administration (set above).
  return granted.includes('statewide-administration') && STATEWIDE_SATISFIES.has(action);
}

function oracleValidity(ent, tMs) {
  if (ent.status === 'revoked') return false;
  if (ent.role === 'deputy') {
    if (!ent.delegation) return false;
    if (ent.scopeType === 'statewide') return false;
  }
  if (ent.scopeType === 'statewide' && ent.scopeId !== null) return false;
  if (ent.delegation) {
    if (Date.parse(ent.delegation.effectiveAt) > tMs) return false;
    if (tMs >= Date.parse(ent.delegation.expiresAt)) return false;
  }
  if (Date.parse(ent.effectiveAt) > tMs) return false;
  if (ent.expiresAt !== null && tMs >= Date.parse(ent.expiresAt)) return false;
  return true;
}

function oracleCovers(ent, object, destinationSystemId) {
  switch (ent.scopeType) {
    case 'statewide':
      return ent.scopeId === null;
    case 'system':
      if (!ent.scopeId || object.systemId !== ent.scopeId) return false;
      if (destinationSystemId != null && destinationSystemId !== object.systemId) return false;
      return true;
    case 'organization':
      return ent.scopeId !== null && object.ownerOrganizationId === ent.scopeId;
    case 'site':
      return ent.scopeId !== null && (object.id === ent.scopeId || object.stationId === ent.scopeId);
    case 'dataset':
      return ent.scopeId !== null && (object.datasetId === ent.scopeId || object.id === ent.scopeId);
    default:
      return false;
  }
}

const LIFECYCLE = {
  read: ['proposed', 'active', 'inactive', 'retired', 'finalized'],
  mutate: ['active'],
  'draft-edit': ['proposed', 'active'],
  admin: ['proposed', 'active', 'inactive', 'retired', 'finalized'],
};

function oracleLifecycleClass(action) {
  if (['browse-published', 'view-restricted-details', 'view-internal-diagnostics', 'read-approved-datasets', 'generate-reports', 'create-exports'].includes(action)) return 'read';
  if (['enter-readings', 'revise-best-available', 'review-data', 'withdraw-raw', 'field-visits', 'create-sites'].includes(action)) return 'mutate';
  if (['edit-site-metadata', 'edit-permitted-site-fields'].includes(action)) return 'draft-edit';
  return 'admin';
}

function oracleEvaluate(principalId, action, objectId, fields, tMs, destinationSystemId, worldOverride) {
  const world = worldOverride ?? moduleWorld;
  const object = world.objects[objectId] ?? null;
  if (!object) return { effect: 'deny' };
  const fieldList = fields ?? ['public'];
  const principal = principalId ? (world.principals[principalId] ?? null) : null;

  // Public branch: the only explicit public action is browse-published.
  if (action === 'browse-published') {
    const published = object.visibility === 'public' && (object.status === 'active' || object.status === 'inactive');
    if (published && fieldList.every((f) => f === 'public')) return { effect: 'allow', via: 'public-read' };
    if (!principal) return { effect: 'deny' };
  }

  // Protected branch.
  if (!principal) return { effect: 'deny' };
  if (!principal.active) return { effect: 'deny' };

  const matches = [];
  for (const ent of principalsFixture.entitlements) {
    if (ent.principalId !== principalId) continue;
    if (!oracleValidity(ent, tMs)) continue;
    if (!oracleSatisfies(action, ent.capabilities ?? [])) continue;
    if (!oracleCovers(ent, object, destinationSystemId ?? null)) continue;
    // Field classes: restricted needs an operational read capability; internal needs the narrow internal set.
    let fieldsOk = true;
    for (const field of fieldList) {
      if (field === 'public') continue;
      if (field === 'restricted') {
        if (!(ent.capabilities ?? []).some((c) => OPERATIONAL.has(c))) fieldsOk = false;
      } else if (field === 'internal') {
        if (!(ent.capabilities ?? []).some((c) => INTERNAL_READERS.has(c))) fieldsOk = false;
      } else {
        fieldsOk = false;
      }
      if (!fieldsOk) break;
    }
    if (!fieldsOk) continue;
    matches.push(ent.id);
  }
  if (matches.length === 0) return { effect: 'deny' };
  if (!LIFECYCLE[oracleLifecycleClass(action)].includes(object.status)) return { effect: 'deny' };
  return { effect: 'allow', via: 'protected', matches };
}

// ---------------------------------------------------------------------------
// Corpus generation (deterministic)
// ---------------------------------------------------------------------------

const PRINCIPALS = [null, ...principalsFixture.users.map((u) => u.id)];
const ACTIONS = [
  ...new Set([
    'browse-published',
    'manage-own-preferences',
    'view-restricted-details',
    'enter-readings',
    'revise-best-available',
    'edit-site-metadata',
    'edit-permitted-site-fields',
    'create-sites',
    'review-data',
    'manage-vocabulary',
    'manage-users',
    'manage-assignments',
    'configure-ingestion',
    'request-ingestion-configuration',
    'withdraw-raw',
    'manage-own-tokens',
    'supplier-reporting',
    'field-visits',
    'view-internal-diagnostics',
    'read-approved-datasets',
    'create-exports',
    'generate-reports',
    'statewide-administration',
    // hostile / unsatisfiable
    'manage-cloud-infrastructure',
    'neoserver-super-admin',
  ]),
];
const OBJECTS = [...Object.keys(world.objects), 'sta-does-not-exist', ''];
const FIELD_SETS = [
  undefined,
  ['public'],
  ['public', 'restricted'],
  ['restricted'],
  ['public', 'internal'],
  ['internal'],
  ['internal', 'restricted', 'public'],
];
/** Boundary clocks: delegation/assignment edges (half-open [eff, exp)) plus far past/future and the DST spring-forward instant. */
const CLOCKS = [
  '2026-05-15T12:00:00Z',
  '2024-01-01T00:00:00Z',
  '2027-01-01T00:00:00Z',
  '2026-03-01T06:59:59.999Z', // 1 ms before the deputy delegation opens
  '2026-03-01T07:00:00Z', // exact delegation effectiveAt (inclusive edge)
  '2026-06-30T23:59:58.999Z', // 1 ms before the delegation closes
  '2026-06-30T23:59:59Z', // exact delegation expiresAt (exclusive edge)
  '2026-07-01T00:00:00Z', // after the delegation
  '2025-10-01T00:00:00Z', // fatima/cody assignment effectiveAt (inclusive)
  '2025-09-30T23:59:59.999Z', // 1 ms before
  '2026-02-01T00:00:00Z', // sarah dataset grant effectiveAt
  '2027-02-01T00:00:00Z', // sarah grant expiresAt (exclusive)
  '2026-03-08T09:00:00Z', // Utah DST spring-forward instant
  '2026-01-12T00:00:00Z', // priya assignment effectiveAt
];

const TUPLE_COUNT = 640;

function generateTuples() {
  const random = mulberry32(0x5744_3032);
  const tuples = [];
  for (let i = 0; i < TUPLE_COUNT; i += 1) {
    tuples.push({
      principalId: pick(random, PRINCIPALS),
      action: pick(random, ACTIONS),
      objectId: pick(random, OBJECTS),
      fields: pick(random, FIELD_SETS),
      clock: pick(random, CLOCKS),
      destinationSystemId: random() < 0.1 ? pick(random, ['sys-bear-river', 'sys-weber-river']) : undefined,
    });
  }
  return tuples;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('policy fuzz: 640 generated tuples match the independent oracle', () => {
  const tuples = generateTuples();
  assert.ok(tuples.length >= 500, 'at least 500 tuples');
  let allowed = 0;
  for (const [index, tuple] of tuples.entries()) {
    const engine = evaluate(
      {
        principal: tuple.principalId ? world.principals[tuple.principalId] : null,
        action: tuple.action,
        object: { kind: 'station', id: tuple.objectId, fields: tuple.fields, destinationSystemId: tuple.destinationSystemId ?? null },
      },
      world,
      tuple.clock,
    );
    const oracle = oracleEvaluate(tuple.principalId, tuple.action, tuple.objectId, tuple.fields, Date.parse(tuple.clock), tuple.destinationSystemId);
    assert.equal(
      engine.effect,
      oracle.effect,
      `tuple ${index} mismatch: principal=${tuple.principalId} action=${tuple.action} object=${tuple.objectId} fields=${JSON.stringify(tuple.fields)} clock=${tuple.clock} dest=${tuple.destinationSystemId} oracle=${JSON.stringify(oracle)}`,
    );
    if (engine.effect === 'allow') {
      allowed += 1;
      if (oracle.via === 'protected') {
        for (const matchedId of engine.matchedAssignmentIds) {
          assert.ok(oracle.matches.includes(matchedId), `tuple ${index}: engine allow cites assignment ${matchedId} the oracle did not justify`);
        }
      } else {
        assert.equal(engine.via, 'public-read', `tuple ${index}: oracle public-read but engine via=${engine.via}`);
      }
    }
  }
  assert.ok(allowed >= 40 && allowed <= tuples.length - 40, `corpus exercises both branches (allowed=${allowed})`);
});

test('fuzz corpus is deterministic: identical decisions on regeneration', () => {
  const run = () =>
    generateTuples().map((tuple) => {
      const decision = evaluate(
        {
          principal: tuple.principalId ? world.principals[tuple.principalId] : null,
          action: tuple.action,
          object: { kind: 'station', id: tuple.objectId, fields: tuple.fields, destinationSystemId: tuple.destinationSystemId ?? null },
        },
        world,
        tuple.clock,
      );
      return `${decision.effect}:${decision.reason}:${decision.via}`;
    });
  const first = run();
  const second = run();
  assert.equal(sha256(JSON.stringify(first)), sha256(JSON.stringify(second)));
  assert.equal(sha256(JSON.stringify(first)).length, 64);
});

test('matrix ceilings hold: no allow ever exceeds the documented authority', () => {
  const unsatisfiable = ['manage-cloud-infrastructure', 'neoserver-super-admin', 'neoserver-workspace-editor', 'database-owner', 'supplier-reporting'];
  for (const action of unsatisfiable) {
    for (const principalId of PRINCIPALS) {
      for (const objectId of ['sta-bear-corinne', 'sta-hyrum-diversion-owner', 'sta-bear-lake-diagnostic', 'principal-diego-steward']) {
        const decision = evaluate(
          { principal: principalId ? world.principals[principalId] : null, action, object: { kind: 'station', id: objectId } },
          world,
          '2026-05-15T12:00:00Z',
        );
        assert.equal(decision.effect, 'deny', `${principalId} must never be allowed ${action} on ${objectId}`);
      }
    }
  }
});

test('deputy boundaries: half-open delegation window with no statewide default', () => {
  const probe = (clock) =>
    evaluate(
      { principal: world.principals['principal-ana-deputy'], action: 'enter-readings', object: { kind: 'station', id: 'sta-bear-corinne' } },
      world,
      clock,
    );
  assert.equal(probe('2026-03-01T06:59:59.999Z').effect, 'deny', 'before the delegation opens');
  assert.equal(probe('2026-03-01T07:00:00Z').effect, 'allow', 'at the effective instant (inclusive)');
  assert.equal(probe('2026-06-30T23:59:58.999Z').effect, 'allow', 'last instant inside');
  assert.equal(probe('2026-06-30T23:59:59Z').effect, 'deny', 'at expiresAt (exclusive)');
  assert.equal(probe('2026-07-01T00:00:00Z').effect, 'deny', 'after expiry');
  // The deputy is scoped to sys-bear-river only — never statewide.
  assert.equal(
    evaluate(
      { principal: world.principals['principal-ana-deputy'], action: 'enter-readings', object: { kind: 'station', id: 'sta-ogden-valley-proposed' } },
      world,
      '2026-05-15T12:00:00Z',
    ).effect,
    'deny',
    'deputy must not reach the Weber River system',
  );
});

test('engineer cross-system isolation: priya (Weber) receives nothing from Bear River', () => {
  for (const objectId of ['sta-bear-corinne', 'sta-hyrum-diversion-owner', 'sta-bear-lake-diagnostic']) {
    for (const action of ['enter-readings', 'view-restricted-details', 'edit-site-metadata', 'view-internal-diagnostics']) {
      const decision = evaluate(
        {
          principal: world.principals['principal-priya-engineer'],
          action,
          object: { kind: 'station', id: objectId, fields: ['public', 'restricted', 'internal'] },
        },
        world,
        '2026-05-15T12:00:00Z',
      );
      assert.equal(decision.effect, 'deny', `priya must not ${action} on ${objectId}`);
    }
  }
});

test('DEFECT-Q3 pinned: statewide-administration satisfies field-visits although ROLE_CEILING.steward excludes it', () => {
  // Filed in docs/verification/MVP-QUALIFICATION-REPORT.md (DEFECT-Q3):
  // matrix.ts documents "Nothing here may exceed ROLE_CEILING for the role
  // that carries the grant", yet CAPABILITY_SATISFIES['field-visits']
  // includes statewide-administration while ROLE_CEILING.steward does not
  // list field-visits. Consequence: the fixture steward grant authorizes
  // field visits the ceiling says the steward may not be granted. Pinned
  // here; removing the inconsistency must update this test and the report.
  assert.ok(CAPABILITY_SATISFIES['field-visits'].includes('statewide-administration'), 'DEFECT-Q3 precondition: satisfaction table includes statewide-administration');
  assert.ok(!ROLE_CEILING.steward.includes('field-visits'), 'DEFECT-Q3 precondition: steward ceiling excludes field-visits');
  const decision = evaluate(
    { principal: world.principals['principal-diego-steward'], action: 'field-visits', object: { kind: 'station', id: 'sta-bear-corinne' } },
    world,
    '2026-05-15T12:00:00Z',
  );
  assert.equal(decision.effect, 'allow', 'DEFECT-Q3: the steward grant currently does authorize field-visits (pinned)');
});

test('exhaustive sweep: every fixture principal x every restricted object x every accessor family', () => {
  // The full non-random product the release gate asks for: no fixture
  // principal gains access to a restricted/internal object except through a
  // grant the independent oracle justifies. Field variants force the FR-049
  // check (row visibility alone is never sufficient).
  const restrictedObjects = [
    'sta-hyrum-diversion-owner',
    'str-hyrum-q-owner',
    'sta-bear-lake-diagnostic',
    'str-diag-voltage',
    'sta-ogden-valley-proposed',
    'str-ogden-q-proposed',
    'org-cache-water',
    'org-bear-river-users',
    'principal-diego-steward',
    'principal-fatima-engineer',
  ];
  const accessorFamilies = [
    { action: 'view-restricted-details', fields: ['public', 'restricted'] },
    { action: 'view-restricted-details', fields: ['public', 'restricted', 'internal'] },
    { action: 'view-internal-diagnostics', fields: ['public', 'internal'] },
    { action: 'enter-readings', fields: undefined },
    { action: 'edit-site-metadata', fields: undefined },
    { action: 'review-data', fields: undefined },
    { action: 'manage-users', fields: undefined },
    { action: 'browse-published', fields: ['public'] },
  ];
  const clocks = ['2026-05-15T12:00:00Z'];
  const deactivatedWorld = withPrincipal(world, 'principal-fatima-engineer', { active: false });
  const principalIds = [null, ...principalsFixture.users.map((u) => u.id)];

  let checked = 0;
  let denials = 0;
  for (const [worldForRun, worldLabel] of [
    [world, 'active'],
    [deactivatedWorld, 'fatima-deactivated'],
  ]) {
    for (const principalId of principalIds) {
      for (const objectId of restrictedObjects) {
        for (const accessor of accessorFamilies) {
          for (const clock of clocks) {
            const decision = evaluate(
              {
                principal: principalId ? worldForRun.principals[principalId] : null,
                action: accessor.action,
                object: { kind: 'station', id: objectId, fields: accessor.fields },
              },
              worldForRun,
              clock,
            );
            const oracle = oracleEvaluate(principalId, accessor.action, objectId, accessor.fields, Date.parse(clock), undefined, worldForRun);
            checked += 1;
            assert.equal(
              decision.effect,
              oracle.effect,
              `sweep mismatch (${worldLabel}): principal=${principalId} action=${accessor.action} object=${objectId} fields=${JSON.stringify(accessor.fields)} engine=${decision.effect} oracle=${oracle.effect} ${oracle.effect === 'allow' ? 'via=' + oracle.via : ''}`,
            );
            if (decision.effect === 'deny') denials += 1;
            // Hard invariant independent of the oracle: internal-class
            // fields (gate codes, wiring notes) are readable ONLY by a
            // holder of an internal-read capability (view-internal-diagnostics,
            // edit-site-metadata or statewide-administration) whose scope
            // covers the object. Derived from the fixture grants directly.
            if (accessor.fields?.includes('internal') && decision.effect === 'allow') {
              const object = world.objects[objectId];
              const justified = principalsFixture.entitlements.some(
                (ent) =>
                  ent.principalId === principalId &&
                  oracleValidity(ent, Date.parse(clock)) &&
                  (ent.capabilities ?? []).some((c) => INTERNAL_READERS.has(c)) &&
                  oracleCovers(ent, object, null),
              );
              assert.ok(justified, `internal-field allow without an in-scope internal-read capability: principal=${principalId} object=${objectId}`);
            }
          }
        }
      }
    }
  }
  assert.ok(checked >= 1000, `exhaustive product covered ${checked} combinations`);
  assert.ok(denials < checked, 'the product also contains justified allows (fixture entitlements work)');
});
