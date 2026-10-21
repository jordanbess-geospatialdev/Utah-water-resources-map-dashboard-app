/**
 * T-02 Policy unit tests (docs/product/baseline/04-ai-development-and-testing.md):
 * "Role x action x scope x visibility; missing grants deny; engineer
 * variants; deactivated users; unknown identifiers" -> "Parameterized
 * deterministic allow/deny results".
 *
 * The world is built from the frozen contract fixtures
 * (fixtures/contracts/principals.json, stations.json) and every clock input
 * is an injected constant, so the suite is fully deterministic. Wiley (the
 * water-user persona) has no user row in the fixture file by design - the two
 * owner ORGANIZATIONS are the fixture - so the two Wiley variants are
 * synthesized here as schema-shaped principals + entitlements bound to
 * org-cache-water (owns sta-hyrum-diversion-owner) and
 * org-bear-river-users (owns nothing), exactly the cross-owner split the
 * fixture $comment describes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  POLICY_VERSION,
  buildWorld,
  withEntitlement,
  withPrincipal,
  resolveActor,
  assignmentVersionOf,
  capabilitiesOf,
  evaluate,
  evaluatePublicRead,
  isCurrentlyPublished,
  satisfiesCapability,
  satisfiesCapabilityFor,
  AUTHORIZATION_MATRIX,
  DEPUTY_DELEGATION_POLICY,
  DOCUMENTED_BOUNDARIES,
  ENGINEER_FAMILY_CEILING,
  ENGINEER_PROFILES,
  ROLE_CEILING,
  CAPABILITY_SATISFIES,
  SATISFACTION_ROLE_GATES,
} from '../src/index.ts';
import type {
  AuthorizationRequest,
  Capability,
  Decision,
  FieldClass,
  PolicyObject,
  Principal,
  RawEntitlement,
} from '../src/index.ts';

// ---------------------------------------------------------------------------
// Fixture world
// ---------------------------------------------------------------------------

const readJson = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/contracts/${name}`, import.meta.url), 'utf8'));

const principalsFixture = readJson('principals.json');
const stationsFixture = readJson('stations.json');

/** Injected clock: inside Ana's delegation window, after every effectiveAt, before every expiresAt. */
const NOW = '2026-05-15T12:00:00Z';

function object(partial: Partial<PolicyObject> & { id: string; kind: PolicyObject['kind'] }): PolicyObject {
  return Object.freeze({
    systemId: null,
    ownerOrganizationId: null,
    stationId: null,
    datasetId: null,
    ownerPrincipalId: null,
    targetObjectId: null,
    visibility: 'restricted',
    status: 'active',
    fields: {},
    ...partial,
  } as PolicyObject);
}

const wileyA: Principal = { id: 'wiley-a', displayName: 'Wiley Barnes (Cache owner)', roles: ['water-user', 'owner'], active: true, assignedSystemId: null };
const wileyB: Principal = { id: 'wiley-b', displayName: 'Wiley Ortega (Bear River owner)', roles: ['water-user', 'owner'], active: true, assignedSystemId: null };

const ownerEntitlement = (id: string, principalId: string, scopeId: string, grantVersion: number): RawEntitlement => ({
  id,
  principalId,
  role: 'owner',
  capabilities: ['view-restricted-details', 'manage-own-preferences', 'manage-own-tokens'],
  scopeType: 'organization',
  scopeId,
  effectiveAt: '2025-07-01T00:00:00Z',
  expiresAt: null,
  status: 'active',
  delegation: null,
  grantedBy: 'principal-diego-steward',
  grantVersion,
});

const EXTRA_OBJECTS: PolicyObject[] = [
  // Distribution systems (create-sites targets; steward-managed per FR-012).
  // A system object is self-scoped: its systemId is its own id.
  object({ id: 'sys-bear-river', kind: 'system', systemId: 'sys-bear-river', visibility: 'public' }),
  object({ id: 'sys-weber-river', kind: 'system', systemId: 'sys-weber-river', visibility: 'public' }),
  object({ id: 'dataset-approved-discharge-v1', kind: 'dataset', datasetId: 'dataset-approved-discharge-v1', visibility: 'restricted' }),
  object({ id: 'vocab-processing-levels', kind: 'vocabulary', visibility: 'public' }),
  object({ id: 'prov-dwri-telemetry', kind: 'provider', visibility: 'internal' }),
  object({ id: 'obs-owner-w-001', kind: 'observation', stationId: 'sta-hyrum-diversion-owner', systemId: 'sys-bear-river', visibility: 'restricted' }),
  // Own-account preference objects (matrix row 2). Targets exercise the
  // "favorite only if published or otherwise readable" rule.
  object({ id: 'pref-wiley-1', kind: 'preference', ownerPrincipalId: 'wiley-a', targetObjectId: 'sta-hyrum-diversion-owner', visibility: 'public' }),
  object({ id: 'pref-sarah-1', kind: 'preference', ownerPrincipalId: 'principal-sarah-researcher', targetObjectId: 'sta-bear-corinne', visibility: 'public' }),
  object({ id: 'pref-sarah-restricted', kind: 'preference', ownerPrincipalId: 'principal-sarah-researcher', targetObjectId: 'sta-hyrum-diversion-owner', visibility: 'public' }),
  object({ id: 'pref-cody-1', kind: 'preference', ownerPrincipalId: 'principal-cody-commissioner', targetObjectId: 'sta-bear-corinne', visibility: 'public' }),
  object({ id: 'pref-fatima-1', kind: 'preference', ownerPrincipalId: 'principal-fatima-engineer', targetObjectId: 'sta-bear-corinne', visibility: 'public' }),
  object({ id: 'pref-diego-1', kind: 'preference', ownerPrincipalId: 'principal-diego-steward', targetObjectId: 'sta-hyrum-diversion-owner', visibility: 'public' }),
  object({ id: 'pref-ana-1', kind: 'preference', ownerPrincipalId: 'principal-ana-deputy', targetObjectId: 'sta-bear-corinne', visibility: 'public' }),
  // Own-account token objects (matrix row 12, FR-064).
  object({ id: 'tok-wiley-1', kind: 'token', ownerPrincipalId: 'wiley-a' }),
  object({ id: 'tok-sarah-1', kind: 'token', ownerPrincipalId: 'principal-sarah-researcher' }),
  object({ id: 'tok-cody-1', kind: 'token', ownerPrincipalId: 'principal-cody-commissioner' }),
  object({ id: 'tok-fatima-1', kind: 'token', ownerPrincipalId: 'principal-fatima-engineer' }),
  object({ id: 'tok-diego-1', kind: 'token', ownerPrincipalId: 'principal-diego-steward' }),
  object({ id: 'tok-ana-1', kind: 'token', ownerPrincipalId: 'principal-ana-deputy' }),
];

const world = buildWorld({
  principals: principalsFixture,
  stations: stationsFixture,
  extraPrincipals: [wileyA, wileyB],
  extraEntitlements: [
    ownerEntitlement('ent-owner-wiley-a', 'wiley-a', 'org-cache-water', 5),
    ownerEntitlement('ent-owner-wiley-b', 'wiley-b', 'org-bear-river-users', 6),
  ],
  extraObjects: EXTRA_OBJECTS,
});

/** Engineer-variant principals carrying the capability profiles from matrix.ts (Bear River scoped). */
const variantEngineer = (id: string, displayName: string): Principal => ({ id, displayName, roles: ['engineer'], active: true, assignedSystemId: 'sys-bear-river' });
const variantEntitlement = (id: string, principalId: string, profile: keyof typeof ENGINEER_PROFILES, grantVersion: number): RawEntitlement => ({
  id,
  principalId,
  role: 'engineer',
  capabilities: [...ENGINEER_PROFILES[profile]],
  scopeType: 'system',
  scopeId: 'sys-bear-river',
  effectiveAt: '2026-01-01T00:00:00Z',
  expiresAt: null,
  status: 'active',
  delegation: null,
  grantedBy: 'principal-diego-steward',
  grantVersion,
});

const variantWorld = buildWorld({
  principals: principalsFixture,
  stations: stationsFixture,
  extraPrincipals: [variantEngineer('eng-modeler', 'Modeler Engineer'), variantEngineer('eng-automation', 'Automation Engineer'), variantEngineer('eng-regional', 'Regional Engineer')],
  extraEntitlements: [
    variantEntitlement('ent-eng-modeler', 'eng-modeler', 'modeler', 20),
    variantEntitlement('ent-eng-automation', 'eng-automation', 'automation', 21),
    variantEntitlement('ent-eng-regional', 'eng-regional', 'regional', 22),
  ],
  extraObjects: [
    object({ id: 'sys-bear-river', kind: 'system', systemId: 'sys-bear-river', visibility: 'public' }),
    object({ id: 'sys-weber-river', kind: 'system', systemId: 'sys-weber-river', visibility: 'public' }),
    object({ id: 'prov-dwri-telemetry', kind: 'provider', visibility: 'internal' }),
    object({ id: 'obs-owner-w-001', kind: 'observation', stationId: 'sta-hyrum-diversion-owner', systemId: 'sys-bear-river', visibility: 'restricted' }),
  ],
});

const ACTORS: Record<string, Principal | null> = {
  donna: null,
  wiley: world.principals['wiley-a'] ?? null,
  wileyB: world.principals['wiley-b'] ?? null,
  sarah: world.principals['principal-sarah-researcher'] ?? null,
  cody: world.principals['principal-cody-commissioner'] ?? null,
  fatima: world.principals['principal-fatima-engineer'] ?? null,
  diego: world.principals['principal-diego-steward'] ?? null,
  ana: world.principals['principal-ana-deputy'] ?? null,
  priya: world.principals['principal-priya-engineer'] ?? null,
};

const req = (
  principal: Principal | null,
  action: Capability | string,
  objectId: string,
  fields?: readonly FieldClass[],
  destinationSystemId?: string,
): AuthorizationRequest => ({
  principal,
  action: action as Capability,
  object: { kind: 'station', id: objectId, fields, destinationSystemId: destinationSystemId ?? null },
});

const decide = (principal: Principal | null, action: Capability | string, objectId: string, fields?: readonly FieldClass[], destinationSystemId?: string, w = world, now = NOW): Decision =>
  evaluate(req(principal, action, objectId, fields, destinationSystemId), w, now);

// ---------------------------------------------------------------------------
// T-02 core: the deterministic role x action x scope grid
// ---------------------------------------------------------------------------

/**
 * Expected outcome per (matrix row, persona). This grid IS the T-02
 * deliverable: every cell is a deterministic allow/deny against the fixture
 * world at NOW. 'ana' is the deputy column of the "Cody commissioner/deputy"
 * matrix persona, evaluated inside the delegation window.
 * Deliberate fixture narrowings of the matrix ceiling (engineer field profile
 * without review-data; commissioner without create-sites; automation-only
 * withdrawal) are marked in NARROWED and must deny with
 * DENY_CAPABILITY_NOT_GRANTED - the matrix ceiling is grant-time guidance,
 * the grant is the authority.
 */
type Expect = 'allow' | 'deny';
const GRID: Record<string, Record<string, Expect>> = {
  'browse-published': { donna: 'allow', wiley: 'allow', sarah: 'allow', cody: 'allow', fatima: 'allow', diego: 'allow', ana: 'allow' },
  'manage-own-preferences': { donna: 'deny', wiley: 'allow', sarah: 'allow', cody: 'allow', fatima: 'allow', diego: 'allow', ana: 'allow' },
  'view-restricted-details': { donna: 'deny', wiley: 'allow', sarah: 'deny', cody: 'allow', fatima: 'allow', diego: 'allow', ana: 'allow' },
  'enter-readings': { donna: 'deny', wiley: 'deny', sarah: 'deny', cody: 'allow', fatima: 'allow', diego: 'allow', ana: 'allow' },
  'edit-site-metadata': { donna: 'deny', wiley: 'deny', sarah: 'deny', cody: 'allow', fatima: 'allow', diego: 'allow', ana: 'deny' },
  'create-sites': { donna: 'deny', wiley: 'deny', sarah: 'deny', cody: 'deny', fatima: 'allow', diego: 'allow', ana: 'deny' },
  'review-data': { donna: 'deny', wiley: 'deny', sarah: 'deny', cody: 'allow', fatima: 'deny', diego: 'allow', ana: 'allow' },
  'manage-vocabulary': { donna: 'deny', wiley: 'deny', sarah: 'deny', cody: 'deny', fatima: 'deny', diego: 'allow', ana: 'deny' },
  'manage-users': { donna: 'deny', wiley: 'deny', sarah: 'deny', cody: 'deny', fatima: 'deny', diego: 'allow', ana: 'deny' },
  'configure-ingestion': { donna: 'deny', wiley: 'deny', sarah: 'deny', cody: 'deny', fatima: 'deny', diego: 'allow', ana: 'deny' },
  'withdraw-raw': { donna: 'deny', wiley: 'deny', sarah: 'deny', cody: 'deny', fatima: 'deny', diego: 'allow', ana: 'deny' },
  'manage-own-tokens': { donna: 'deny', wiley: 'allow', sarah: 'allow', cody: 'allow', fatima: 'allow', diego: 'allow', ana: 'allow' },
  'supplier-reporting': { donna: 'deny', wiley: 'deny', sarah: 'deny', cody: 'deny', fatima: 'deny', diego: 'deny', ana: 'deny' },
};

/** Matrix cells whose fixture grant is intentionally narrower than the proposed ceiling, by denial kind. */
const NARROWED_CAPABILITY: ReadonlySet<string> = new Set([
  'create-sites|cody', // "Separate explicit grant" - fixture commissioner holds none
  'create-sites|ana',
  'review-data|fatima', // field profile: reviewing is not a field-engineer capability
  'configure-ingestion|fatima', // "Request/delegation only" - engineers request, never configure
  'withdraw-raw|fatima', // "Automation capability only"
  'edit-site-metadata|ana', // deputy delegation carries enter-readings + review-data only
]);
/** Cells where the persona holds a satisfying capability but its scope legitimately misses the object. */
const NARROWED_SCOPE: ReadonlySet<string> = new Set([
  'view-restricted-details|sarah', // dataset-scoped grant does not cover stations
]);

/** Representative request per matrix row (object, fields). Own-account rows resolve per persona below. */
const ROW_TARGET: Record<string, { objectId: string; fields: readonly FieldClass[] }> = {
  'browse-published': { objectId: 'sta-bear-corinne', fields: ['public'] },
  'view-restricted-details': { objectId: 'sta-hyrum-diversion-owner', fields: ['public', 'restricted'] },
  'enter-readings': { objectId: 'str-hyrum-q-owner', fields: ['public'] },
  'edit-site-metadata': { objectId: 'sta-hyrum-diversion-owner', fields: ['public'] },
  'create-sites': { objectId: 'sys-bear-river', fields: ['public'] },
  'review-data': { objectId: 'str-hyrum-q-owner', fields: ['public'] },
  'manage-vocabulary': { objectId: 'vocab-processing-levels', fields: ['public'] },
  'manage-users': { objectId: 'principal-fatima-engineer', fields: ['public'] },
  'configure-ingestion': { objectId: 'prov-dwri-telemetry', fields: ['public'] },
  'withdraw-raw': { objectId: 'obs-owner-w-001', fields: ['public'] },
  'supplier-reporting': { objectId: 'org-cache-water', fields: ['public'] },
};

function rowRequest(action: string, persona: string): AuthorizationRequest {
  if (action === 'manage-own-preferences') return req(ACTORS[persona], action, `pref-${persona === 'wiley' ? 'wiley' : persona}-1`, ['public']);
  if (action === 'manage-own-tokens') return req(ACTORS[persona], action, `tok-${persona === 'wiley' ? 'wiley' : persona}-1`, ['public']);
  const target = ROW_TARGET[action];
  return req(ACTORS[persona], action, target.objectId, target.fields);
}

test('T-02 matrix grid: role x action x scope allow/deny is deterministic for all personas', () => {
  for (const row of AUTHORIZATION_MATRIX) {
    assert.ok(GRID[row.id], `grid covers matrix row ${row.id}`);
    for (const persona of Object.keys(GRID[row.id])) {
      const expected = GRID[row.id][persona];
      const decision = evaluate(rowRequest(row.id, persona), world, NOW);
      assert.equal(
        decision.effect === 'allow' ? 'allow' : 'deny',
        expected,
        `${row.id} / ${persona}: expected ${expected}, got ${decision.reason} (${decision.detail ?? ''})`,
      );
      // Matrix-as-data consistency: cell semantics bound the engine outcome.
      const cell = row.cells[persona === 'wiley' ? 'wiley' : persona === 'ana' ? 'cody' : (persona as keyof typeof row.cells)];
      if (cell.effect === 'public') assert.equal(expected, 'allow', `${row.id}/${persona}: public cell must allow`);
      if (cell.effect === 'none' || cell.effect === 'future') assert.equal(expected, 'deny', `${row.id}/${persona}: ${cell.effect} cell must deny`);
      if (cell.effect === 'own-account') {
        assert.equal(expected, persona === 'donna' ? 'deny' : 'allow', `${row.id}/${persona}: own-account semantics`);
      }
      if (cell.effect === 'assigned' && persona === 'diego') assert.equal(expected, 'allow', `${row.id}/diego: steward statewide must allow`);
      // A deny under an "assigned" cell is only legal as a deliberately
      // narrower grant (capability missing) or a narrower scope, and then
      // the reason must say which conjunct failed.
      if (cell.effect === 'assigned' && expected === 'deny') {
        const key = `${row.id}|${persona}`;
        if (NARROWED_CAPABILITY.has(key)) assert.equal(decision.reason, 'DENY_CAPABILITY_NOT_GRANTED', `${key}: narrowed grant denies on capability`);
        else if (NARROWED_SCOPE.has(key)) assert.equal(decision.reason, 'DENY_OUT_OF_SCOPE', `${key}: narrower scope denies on scope`);
        else assert.fail(`${row.id}/${persona}: unexplained narrowing of an assigned cell (${decision.reason})`);
      }
    }
  }
});

test('T-02 allow reasons distinguish the public-read and protected branches', () => {
  const donna = decide(null, 'browse-published', 'sta-bear-corinne');
  assert.equal(donna.reason, 'ALLOW_PUBLIC_READ');
  assert.equal(donna.via, 'public-read');
  const fatima = decide(ACTORS.fatima, 'enter-readings', 'str-hyrum-q-owner');
  assert.equal(fatima.reason, 'ALLOW_PROTECTED');
  assert.equal(fatima.via, 'protected');
  assert.deepEqual([...fatima.matchedAssignmentIds], ['ent-engineer-fatima']);
  assert.equal(fatima.policyVersion, POLICY_VERSION);
  assert.equal(fatima.assignmentVersion, world.assignmentVersion);
});

// ---------------------------------------------------------------------------
// allow_public_read conjuncts (publication projection, field projection)
// ---------------------------------------------------------------------------

test('public read requires the object to be currently published', () => {
  assert.equal(isCurrentlyPublished(world.objects['sta-bear-corinne']), true);
  assert.equal(isCurrentlyPublished(world.objects['sta-summit-creek-inactive']), true, 'inactive stations stay published as historical records');
  assert.equal(decide(null, 'browse-published', 'sta-hyrum-diversion-owner').reason, 'DENY_OBJECT_UNPUBLISHED', 'restricted owner station');
  assert.equal(decide(null, 'browse-published', 'sta-ogden-valley-proposed').reason, 'DENY_OBJECT_UNPUBLISHED', 'proposed station not yet published');
  assert.equal(decide(null, 'browse-published', 'sta-bear-lake-diagnostic').reason, 'DENY_OBJECT_UNPUBLISHED', 'internal diagnostic station');
  assert.equal(decide(null, 'browse-published', 'sta-summit-creek-inactive').effect, 'allow');
});

test('FR-049: public read of a restricted/internal field is denied even on a public station', () => {
  // sta-bear-corinne is public but carries an internal block (gate code, wiring notes).
  assert.equal(world.objects['sta-bear-corinne'].fields?.gateCode, 'internal');
  const internal = decide(null, 'browse-published', 'sta-bear-corinne', ['public', 'internal']);
  assert.equal(internal.effect, 'deny');
  assert.equal(internal.reason, 'DENY_FIELDS_NOT_PUBLIC');
  const restricted = decide(null, 'browse-published', 'sta-bear-corinne', ['public', 'restricted']);
  assert.equal(restricted.reason, 'DENY_FIELDS_NOT_PUBLIC');
  assert.equal(decide(null, 'browse-published', 'sta-bear-corinne', ['public']).effect, 'allow');
});

test('evaluatePublicRead reports DENY_NO_PUBLIC_ACTION for non-public actions', () => {
  const decision = evaluatePublicRead(req(ACTORS.diego, 'enter-readings', 'sta-bear-corinne'), world, NOW);
  assert.equal(decision.effect, 'deny');
  assert.equal(decision.reason, 'DENY_NO_PUBLIC_ACTION');
  assert.equal(evaluatePublicRead(req(null, 'browse-published', 'sta-bear-corinne'), world, NOW).reason, 'ALLOW_PUBLIC_READ');
});

// ---------------------------------------------------------------------------
// Protected branch: scope, cross-owner, cross-system, field classes
// ---------------------------------------------------------------------------

test('cross-system denial: Bear River engineer receives nothing from Weber River and vice versa', () => {
  assert.equal(decide(ACTORS.fatima, 'view-restricted-details', 'sta-hyrum-diversion-owner', ['public', 'restricted']).reason, 'ALLOW_PROTECTED');
  assert.equal(decide(ACTORS.priya, 'view-restricted-details', 'sta-hyrum-diversion-owner', ['public', 'restricted']).reason, 'DENY_OUT_OF_SCOPE');
  assert.equal(decide(ACTORS.priya, 'enter-readings', 'str-hyrum-q-owner').reason, 'DENY_OUT_OF_SCOPE');
  assert.equal(decide(ACTORS.priya, 'enter-readings', 'str-ogden-q-proposed').reason, 'DENY_LIFECYCLE_STATE', 'Weber stream in scope but proposed');
  assert.equal(decide(ACTORS.priya, 'edit-site-metadata', 'sta-ogden-valley-proposed').effect, 'allow', 'draft edits on proposed sites are in scope for the assigned engineer');
  assert.equal(decide(ACTORS.fatima, 'edit-site-metadata', 'sta-ogden-valley-proposed').reason, 'DENY_OUT_OF_SCOPE');
});

test('cross-owner denial: owner organization A cannot read owner organization B records', () => {
  assert.equal(decide(ACTORS.wiley, 'view-restricted-details', 'sta-hyrum-diversion-owner', ['public', 'restricted']).reason, 'ALLOW_PROTECTED', 'org-cache-water owns this station');
  assert.equal(decide(ACTORS.wileyB, 'view-restricted-details', 'sta-hyrum-diversion-owner', ['public', 'restricted']).reason, 'DENY_OUT_OF_SCOPE', 'org-bear-river-users does not');
  assert.equal(decide(ACTORS.wileyB, 'edit-site-metadata', 'sta-hyrum-diversion-owner').reason, 'DENY_CAPABILITY_NOT_GRANTED', 'owners read; they do not edit');
});

test('site move across systems validates both current and destination scope', () => {
  const move = decide(ACTORS.fatima, 'edit-site-metadata', 'sta-hyrum-diversion-public', ['public'], 'sys-weber-river');
  assert.equal(move.reason, 'DENY_OUT_OF_SCOPE', 'system-scoped holder cannot move a site to another system');
  assert.equal(decide(ACTORS.fatima, 'edit-site-metadata', 'sta-hyrum-diversion-public', ['public'], 'sys-bear-river').effect, 'allow', 'same-system destination is fine');
  assert.equal(decide(ACTORS.diego, 'edit-site-metadata', 'sta-hyrum-diversion-public', ['public'], 'sys-weber-river').effect, 'allow', 'statewide steward covers both ends');
});

test('internal field classes require diagnostic capabilities; assignment alone is not enough', () => {
  const fields: readonly FieldClass[] = ['public', 'restricted', 'internal'];
  assert.equal(decide(ACTORS.fatima, 'view-internal-diagnostics', 'sta-bear-lake-diagnostic', fields).effect, 'allow', 'Fatima holds view-internal-diagnostics');
  assert.equal(decide(ACTORS.cody, 'view-restricted-details', 'sta-bear-lake-diagnostic', fields).reason, 'DENY_FIELD_VISIBILITY', 'commissioner sees restricted but not internal');
  assert.equal(decide(ACTORS.cody, 'view-restricted-details', 'sta-bear-lake-diagnostic', ['public', 'restricted']).effect, 'allow');
  assert.equal(decide(ACTORS.priya, 'view-restricted-details', 'sta-bear-lake-diagnostic', fields).reason, 'DENY_OUT_OF_SCOPE');
});

test('lifecycle closes mutations on inactive objects but keeps reads open', () => {
  assert.equal(decide(ACTORS.fatima, 'enter-readings', 'str-summit-q').reason, 'DENY_LIFECYCLE_STATE', 'inactive station accepts no new readings');
  assert.equal(decide(ACTORS.fatima, 'edit-site-metadata', 'sta-summit-creek-inactive').reason, 'DENY_LIFECYCLE_STATE');
  assert.equal(decide(ACTORS.fatima, 'view-restricted-details', 'sta-summit-creek-inactive', ['public']).effect, 'allow', 'reads outlive the operating lifecycle');
});

// ---------------------------------------------------------------------------
// Researcher scope and token boundary
// ---------------------------------------------------------------------------

test('researcher acts only inside the approved dataset grant', () => {
  assert.equal(decide(ACTORS.sarah, 'read-approved-datasets', 'dataset-approved-discharge-v1').reason, 'ALLOW_PROTECTED');
  assert.equal(decide(ACTORS.sarah, 'create-exports', 'dataset-approved-discharge-v1').effect, 'allow');
  assert.equal(decide(ACTORS.sarah, 'view-restricted-details', 'sta-hyrum-diversion-owner', ['public', 'restricted']).reason, 'DENY_OUT_OF_SCOPE', 'dataset scope does not cover stations');
  assert.equal(decide(ACTORS.sarah, 'enter-readings', 'str-hyrum-q-owner').reason, 'DENY_CAPABILITY_NOT_GRANTED');
});

test('FR-064 boundary: a token never exceeds the account authority (own tokens yes, restricted fields no)', () => {
  assert.equal(decide(ACTORS.sarah, 'manage-own-tokens', 'tok-sarah-1').reason, 'ALLOW_PROTECTED');
  assert.equal(decide(ACTORS.sarah, 'manage-own-tokens', 'tok-diego-1').reason, 'DENY_OUT_OF_SCOPE', 'tokens are own-account objects');
  assert.equal(decide(ACTORS.sarah, 'view-restricted-details', 'dataset-approved-discharge-v1', ['public', 'internal']).reason, 'DENY_FIELD_VISIBILITY', 'dataset grant does not open internal fields');
});

// ---------------------------------------------------------------------------
// Deputy delegation (FR-011)
// ---------------------------------------------------------------------------

test('deputy delegation window is half-open and checked at the clock boundary', () => {
  assert.equal(decide(ACTORS.ana, 'enter-readings', 'str-hyrum-q-owner', undefined, undefined, world, '2026-06-30T23:59:58.999Z').effect, 'allow', 'last instant inside the window');
  assert.equal(decide(ACTORS.ana, 'enter-readings', 'str-hyrum-q-owner', undefined, undefined, world, '2026-06-30T23:59:59Z').reason, 'DENY_DELEGATION_EXPIRED', 'expiresAt instant itself is outside (half-open)');
  assert.equal(decide(ACTORS.ana, 'enter-readings', 'str-hyrum-q-owner', undefined, undefined, world, '2026-03-01T07:00:00Z').effect, 'allow', 'effectiveAt instant itself is inside');
  assert.equal(decide(ACTORS.ana, 'enter-readings', 'str-hyrum-q-owner', undefined, undefined, world, '2026-03-01T06:59:59.999Z').reason, 'DENY_DELEGATION_NOT_EFFECTIVE');
});

test('deputy holds only the delegated subset and never statewide authority', () => {
  assert.equal(decide(ACTORS.ana, 'review-data', 'str-hyrum-q-owner').effect, 'allow', 'delegated review-data');
  assert.equal(decide(ACTORS.ana, 'edit-site-metadata', 'sta-hyrum-diversion-owner').reason, 'DENY_CAPABILITY_NOT_GRANTED', 'not delegated');
  assert.equal(decide(ACTORS.ana, 'manage-users', 'principal-fatima-engineer').reason, 'DENY_CAPABILITY_NOT_GRANTED');
  const delegation = world.assignments.find((a) => a.id === 'ent-deputy-ana')?.delegation;
  assert.equal(delegation?.delegatedBy, 'principal-cody-commissioner', 'delegation is explicit and audited');
  assert.equal(DEPUTY_DELEGATION_POLICY.requiresDelegation, true);
  assert.equal(DEPUTY_DELEGATION_POLICY.statewideByDefault, false);
});

test('structurally invalid deputy grants deny: no delegation block, or statewide scope', () => {
  const noDelegation = withEntitlement(world, 'ent-deputy-ana', { delegation: null });
  assert.equal(decide(ACTORS.ana, 'enter-readings', 'str-hyrum-q-owner', undefined, undefined, noDelegation).reason, 'DENY_INVALID_ASSIGNMENT');
  const statewide = withEntitlement(world, 'ent-deputy-ana', { scopeType: 'statewide', scopeId: null });
  assert.equal(decide(ACTORS.ana, 'enter-readings', 'str-hyrum-q-owner', undefined, undefined, statewide).reason, 'DENY_INVALID_ASSIGNMENT', 'a deputy is never statewide');
});

// ---------------------------------------------------------------------------
// Revocation, expiry, deactivation (FR-011)
// ---------------------------------------------------------------------------

test('revocation denies the next request and the authoritative version travels on the decision', () => {
  const revoked = withEntitlement(world, 'ent-commissioner-cody', { status: 'revoked', grantVersion: 12 });
  const decision = decide(ACTORS.cody, 'enter-readings', 'str-hyrum-q-owner', undefined, undefined, revoked);
  assert.equal(decision.reason, 'DENY_ASSIGNMENT_REVOKED');
  assert.equal(decision.assignmentVersion, 12, 'decision echoes the authoritative assignment version, refusing stale caches');
  assert.equal(assignmentVersionOf(revoked, 'principal-cody-commissioner'), 12);
  assert.equal(decide(ACTORS.cody, 'enter-readings', 'str-hyrum-q-owner').effect, 'allow', 'derived worlds do not mutate the original');
});

test('scheduled expiry denies at the boundary instant (researcher grant)', () => {
  assert.equal(decide(ACTORS.sarah, 'read-approved-datasets', 'dataset-approved-discharge-v1', undefined, undefined, world, '2027-01-31T23:59:59.999Z').effect, 'allow');
  assert.equal(decide(ACTORS.sarah, 'read-approved-datasets', 'dataset-approved-discharge-v1', undefined, undefined, world, '2027-02-01T00:00:00Z').reason, 'DENY_ASSIGNMENT_EXPIRED');
});

test('deactivated actor denies despite valid historical assignments, yet stays auditable', () => {
  const offboarded = withPrincipal(world, 'principal-cody-commissioner', { active: false });
  const decision = decide(ACTORS.cody, 'enter-readings', 'str-hyrum-q-owner', undefined, undefined, offboarded);
  assert.equal(decision.reason, 'DENY_PRINCIPAL_INACTIVE');
  assert.deepEqual([...capabilitiesOf(offboarded, 'principal-cody-commissioner', NOW)], [], 'no effective capabilities after offboarding');
  const snapshot = resolveActor(offboarded, 'principal-cody-commissioner');
  assert.ok(snapshot, 'historical actor references remain resolvable');
  assert.equal(snapshot?.displayName, 'Cody Jensen');
  assert.equal(snapshot?.active, false);
  assert.ok(snapshot?.roles.includes('commissioner'));
  assert.equal(resolveActor(world, 'principal-ghost'), null, 'unknown actor ids resolve to null, never authorize');
});

// ---------------------------------------------------------------------------
// Engineer capability variants
// ---------------------------------------------------------------------------

test('engineer profiles are subsets of the family ceiling (data integrity)', () => {
  for (const [profile, capabilities] of Object.entries(ENGINEER_PROFILES)) {
    for (const capability of capabilities) {
      assert.ok(ENGINEER_FAMILY_CEILING.includes(capability), `${profile}.${capability} inside family ceiling`);
      assert.ok(ROLE_CEILING.engineer.includes(capability), `${profile}.${capability} inside engineer role ceiling`);
    }
  }
  assert.equal(ENGINEER_PROFILES.modeler.includes('revise-best-available'), false, 'modelers do not automatically gain correction');
  assert.equal(ENGINEER_PROFILES.modeler.includes('enter-readings'), false);
  assert.equal(ENGINEER_PROFILES.modeler.includes('edit-site-metadata'), false, 'modelers do not gain hardware/field privileges');
  assert.equal(ENGINEER_PROFILES.modeler.includes('withdraw-raw'), false);
  assert.equal(ENGINEER_PROFILES.automation.includes('withdraw-raw'), true, 'automation-only withdrawal');
  assert.equal(ENGINEER_PROFILES.field.includes('withdraw-raw'), false);
  assert.equal(ENGINEER_PROFILES.regional.includes('withdraw-raw'), false);
  assert.equal(ENGINEER_PROFILES.regional.includes('request-ingestion-configuration'), true);
});

test('modeler cannot correct; automation withdrawal is a distinct capability', () => {
  const modeler = variantWorld.principals['eng-modeler'] ?? null;
  assert.equal(decide(modeler, 'revise-best-available', 'str-hyrum-q-owner', undefined, undefined, variantWorld).reason, 'DENY_CAPABILITY_NOT_GRANTED');
  assert.equal(decide(modeler, 'enter-readings', 'str-hyrum-q-owner', undefined, undefined, variantWorld).reason, 'DENY_CAPABILITY_NOT_GRANTED');
  assert.equal(decide(modeler, 'view-internal-diagnostics', 'sta-bear-lake-diagnostic', ['public', 'internal'], undefined, variantWorld).effect, 'allow', 'modeler keeps diagnostics read');
  const automation = variantWorld.principals['eng-automation'] ?? null;
  assert.equal(decide(automation, 'withdraw-raw', 'obs-owner-w-001', undefined, undefined, variantWorld).reason, 'ALLOW_PROTECTED');
  assert.equal(decide(ACTORS.fatima, 'withdraw-raw', 'obs-owner-w-001').reason, 'DENY_CAPABILITY_NOT_GRANTED', 'field profile cannot withdraw raw');
});

test('engineers request ingestion configuration for their system; only the steward configures providers', () => {
  const regional = variantWorld.principals['eng-regional'] ?? null;
  assert.equal(decide(regional, 'request-ingestion-configuration', 'sys-bear-river', undefined, undefined, variantWorld).effect, 'allow', 'request is scoped to the assigned system');
  assert.equal(decide(regional, 'request-ingestion-configuration', 'sys-weber-river', undefined, undefined, variantWorld).reason, 'DENY_OUT_OF_SCOPE', 'request cannot cross systems');
  assert.equal(decide(regional, 'configure-ingestion', 'prov-dwri-telemetry', undefined, undefined, variantWorld).reason, 'DENY_CAPABILITY_NOT_GRANTED');
  assert.equal(decide(ACTORS.fatima, 'configure-ingestion', 'prov-dwri-telemetry').reason, 'DENY_CAPABILITY_NOT_GRANTED');
  assert.equal(decide(ACTORS.diego, 'configure-ingestion', 'prov-dwri-telemetry').effect, 'allow');
});

// ---------------------------------------------------------------------------
// Statewide satisfaction is steward-persona-bound (WD-004 / DEFECT-Q3)
// ---------------------------------------------------------------------------

/**
 * A bare statewide-administration grant is NOT a steward role: the
 * authorization matrix has no site-visit row for Diego (field visits are
 * engineer-profile verbs) and ROLE_CEILING.steward does not list
 * field-visits, so statewide-administration may satisfy field-visits only
 * for the steward persona family (SATISFACTION_ROLE_GATES).
 */
const rogueStatewideCommissioner: Principal = {
  id: 'principal-rogue-statewide-commissioner',
  displayName: 'Rogue commissioner (bare statewide grant, no steward role)',
  roles: ['commissioner'],
  active: true,
  assignedSystemId: null,
};
const bareStewardAdmin: Principal = {
  id: 'principal-bare-steward-admin',
  displayName: 'Steward-family administrator (bare statewide grant, not the fixture steward)',
  roles: ['steward'],
  active: true,
  assignedSystemId: null,
};
const bareStatewideEntitlement = (id: string, principalId: string, role: string, grantVersion: number): RawEntitlement => ({
  id,
  principalId,
  role,
  capabilities: ['statewide-administration'],
  scopeType: 'statewide',
  scopeId: null,
  effectiveAt: '2025-07-01T00:00:00Z',
  expiresAt: null,
  status: 'active',
  delegation: null,
  grantedBy: 'principal-diego-steward',
  grantVersion,
});

const gateWorld = buildWorld({
  principals: principalsFixture,
  stations: stationsFixture,
  extraPrincipals: [rogueStatewideCommissioner, bareStewardAdmin],
  extraEntitlements: [
    bareStatewideEntitlement('ent-rogue-statewide', 'principal-rogue-statewide-commissioner', 'commissioner', 30),
    bareStatewideEntitlement('ent-bare-steward-statewide', 'principal-bare-steward-admin', 'steward', 31),
  ],
});

test('DEFECT-Q3: a bare statewide-administration grant denies field-visits outside the steward role family', () => {
  // The latent widening, closed: a commissioner holding ONLY
  // statewide-administration (a grant ROLE_CEILING says must never leave the
  // steward console) no longer satisfies field-visits.
  const rogue = gateWorld.principals['principal-rogue-statewide-commissioner'] ?? null;
  const denied = decide(rogue, 'field-visits', 'sta-bear-corinne', undefined, undefined, gateWorld);
  assert.equal(denied.effect, 'deny');
  assert.equal(denied.reason, 'DENY_CAPABILITY_NOT_GRANTED', 'the gated satisfaction is no capability grant for this principal');
  // The steward still allows: the fixture steward (roles: ['steward'])...
  assert.equal(decide(ACTORS.diego, 'field-visits', 'sta-bear-corinne').effect, 'allow');
  // ...and any steward-family principal with the same bare statewide grant.
  const bareSteward = gateWorld.principals['principal-bare-steward-admin'] ?? null;
  assert.equal(decide(bareSteward, 'field-visits', 'sta-bear-corinne', undefined, undefined, gateWorld).effect, 'allow');
  // An identical field-visits grant is never persona-gated: the assigned
  // field engineer keeps recording visits.
  assert.equal(decide(ACTORS.fatima, 'field-visits', 'sta-bear-corinne').effect, 'allow');
});

test('DEFECT-Q3 gate mechanics: the satisfaction entry stays listed; the gate is principal-aware', () => {
  // The table question is unchanged (the qualification suite pins the entry):
  // a statewide-administration grant carries a listed field-visits satisfier.
  assert.equal(CAPABILITY_SATISFIES['field-visits'].includes('statewide-administration'), true);
  assert.equal(satisfiesCapability('field-visits', ['statewide-administration']), true);
  assert.equal(ROLE_CEILING.steward.includes('field-visits'), false, 'precondition: the steward ceiling excludes field-visits');
  // The principal-aware evaluation the engine consults enforces the gate.
  assert.equal(satisfiesCapabilityFor('field-visits', ['statewide-administration'], ACTORS.diego), true);
  assert.equal(satisfiesCapabilityFor('field-visits', ['statewide-administration'], ACTORS.cody), false);
  assert.equal(satisfiesCapabilityFor('field-visits', ['statewide-administration'], null), false, 'no principal, no gated satisfaction');
  assert.equal(satisfiesCapabilityFor('field-visits', ['field-visits'], ACTORS.cody), true, 'identical grants are never gated');
  // Other statewide satisfaction rows are not persona-gated (they are all
  // backed by ROLE_CEILING.steward, asserted below).
  assert.equal(satisfiesCapabilityFor('enter-readings', ['statewide-administration'], ACTORS.cody), true);
});

test('DEFECT-Q3 audit: every statewide-administration satisfaction is ceiling-backed or persona-gated', () => {
  // edit-permitted-site-fields is the commissioner field-subset variant of
  // edit-site-metadata (matrix row 5 note: "deliberately weaker than full
  // edit-site-metadata"). The full verb in ROLE_CEILING.steward dominates
  // it, so its statewide satisfaction cannot exceed the steward ceiling.
  const DOMINATED_BY: Readonly<Record<string, readonly Capability[]>> = {
    'edit-permitted-site-fields': ['edit-site-metadata'],
  };
  for (const [action, satisfiers] of Object.entries(CAPABILITY_SATISFIES)) {
    if (!satisfiers.includes('statewide-administration')) continue;
    const directlyListed = ROLE_CEILING.steward.includes(action as Capability);
    const dominated = (DOMINATED_BY[action] ?? []).some((stronger) => ROLE_CEILING.steward.includes(stronger));
    const personaGated = SATISFACTION_ROLE_GATES[action]?.['statewide-administration']?.includes('steward') ?? false;
    assert.ok(
      directlyListed || dominated || personaGated,
      `${action}: statewide-administration satisfaction must be listed in ROLE_CEILING.steward (directly or via a dominating verb) or gated to the steward family`,
    );
  }
});

test('satisfaction gates reference listed satisfiers and name real role families', () => {
  assert.ok(Object.keys(SATISFACTION_ROLE_GATES).length >= 1);
  for (const [action, gates] of Object.entries(SATISFACTION_ROLE_GATES)) {
    const satisfiers = CAPABILITY_SATISFIES[action];
    assert.ok(satisfiers, `${action}: a gated action must exist in CAPABILITY_SATISFIES`);
    for (const [satisfier, families] of Object.entries(gates)) {
      assert.ok(satisfiers?.includes(satisfier as Capability), `${action}: gated satisfier "${satisfier}" must be listed in the satisfaction row`);
      assert.ok(families.length > 0, `${action}/${satisfier}: a gate names at least one role family`);
      for (const family of families) {
        assert.ok(Array.isArray(ROLE_CEILING[family]), `${action}/${satisfier}: gate names a real role family "${family}"`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Documented boundaries
// ---------------------------------------------------------------------------

test('favoriting grants nothing (matrix boundary "favoriting-grants-nothing")', () => {
  assert.equal(decide(ACTORS.wiley, 'manage-own-preferences', 'pref-wiley-1').effect, 'allow', 'owner-org member may favorite a station they can read');
  assert.equal(decide(ACTORS.wiley, 'edit-site-metadata', 'sta-hyrum-diversion-owner').reason, 'DENY_CAPABILITY_NOT_GRANTED', 'a favorite is not an edit entitlement');
  assert.equal(decide(ACTORS.wiley, 'enter-readings', 'str-hyrum-q-owner').reason, 'DENY_CAPABILITY_NOT_GRANTED');
  assert.equal(decide(ACTORS.sarah, 'manage-own-preferences', 'pref-sarah-restricted').reason, 'DENY_OUT_OF_SCOPE', 'favorite targets must be readable');
  assert.equal(decide(ACTORS.sarah, 'manage-own-preferences', 'pref-sarah-1').effect, 'allow');
  assert.equal(decide(ACTORS.diego, 'manage-own-preferences', 'pref-diego-1').effect, 'allow', 'steward may favorite restricted stations statewide');
});

test('steward is not the cloud infrastructure owner (boundary "steward-not-infrastructure")', () => {
  const boundary = DOCUMENTED_BOUNDARIES.find((b) => b.id === 'steward-not-infrastructure');
  assert.ok(boundary?.unsatisfiableActions?.length);
  for (const action of boundary.unsatisfiableActions ?? []) {
    const decision = decide(ACTORS.diego, action, 'sta-bear-corinne');
    assert.equal(decision.effect, 'deny', `${action} must be unsatisfiable`);
    assert.equal(decision.reason, 'DENY_CAPABILITY_NOT_GRANTED');
  }
  assert.equal(decide(ACTORS.diego, 'manage-users', 'principal-fatima-engineer').effect, 'allow', 'application administration still works');
});

// ---------------------------------------------------------------------------
// Unknown identifiers and robustness (never error into allow)
// ---------------------------------------------------------------------------

test('unknown identifiers deny with machine-readable reasons, never throw', () => {
  assert.equal(decide(ACTORS.fatima, 'browse-published', 'sta-does-not-exist').reason, 'DENY_UNKNOWN_OBJECT');
  const ghost: Principal = { id: 'principal-ghost', displayName: 'Ghost', roles: ['engineer'], active: true, assignedSystemId: 'sys-bear-river' };
  assert.equal(decide(ghost, 'enter-readings', 'str-hyrum-q-owner').reason, 'DENY_UNKNOWN_PRINCIPAL');
  assert.equal(decide(ACTORS.diego, 'time-travel', 'sta-bear-corinne').reason, 'DENY_CAPABILITY_NOT_GRANTED', 'unknown action');
  const malformed = evaluate({ principal: ACTORS.diego, action: '' as Capability, object: { kind: 'station', id: '' } }, world, NOW);
  assert.equal(malformed.reason, 'DENY_INVALID_REQUEST');
  assert.equal(decide(null, 'enter-readings', 'str-hyrum-q-owner').reason, 'DENY_ANONYMOUS', 'protected action without identity');
});

test('evaluation is deterministic for identical inputs (injected clock)', () => {
  const first = decide(ACTORS.fatima, 'view-restricted-details', 'sta-hyrum-diversion-owner', ['public', 'restricted']);
  const second = decide(ACTORS.fatima, 'view-restricted-details', 'sta-hyrum-diversion-owner', ['public', 'restricted']);
  assert.deepStrictEqual(first, second);
  const denyA = decide(ACTORS.priya, 'enter-readings', 'str-hyrum-q-owner');
  const denyB = decide(ACTORS.priya, 'enter-readings', 'str-hyrum-q-owner');
  assert.deepStrictEqual(denyA, denyB);
});

// ---------------------------------------------------------------------------
// Session-facing helpers
// ---------------------------------------------------------------------------

test('capabilitiesOf and assignmentVersionOf power GET /session (subject, capabilities, assignment version)', () => {
  const diegoCaps = capabilitiesOf(world, 'principal-diego-steward', NOW);
  for (const expected of ['manage-users', 'manage-assignments', 'manage-vocabulary', 'configure-ingestion', 'statewide-administration']) {
    assert.ok(diegoCaps.includes(expected as Capability), `diego capabilities include ${expected}`);
  }
  assert.equal(assignmentVersionOf(world, 'principal-diego-steward'), 4, 'fixture grantVersion 4');
  assert.equal(assignmentVersionOf(world, 'wiley-b'), 6);
  const anaNow = capabilitiesOf(world, 'principal-ana-deputy', NOW);
  assert.deepEqual(anaNow, ['enter-readings', 'review-data'], 'deputy capabilities inside the delegation window');
  assert.deepEqual(capabilitiesOf(world, 'principal-ana-deputy', '2026-07-01T00:00:00Z'), [], 'deputy capabilities vanish after expiry');
  assert.deepEqual(capabilitiesOf(world, 'principal-ghost', NOW), [], 'unknown principal has no capabilities');
});
