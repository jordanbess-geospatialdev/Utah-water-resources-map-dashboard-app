/**
 * Fixture-backed supplier world for WD-017: the water-owner organizations
 * from fixtures/contracts/principals.json, their supplier systems derived
 * from fixtures/contracts/stations.json (ownerOrganizationId), and a policy
 * world in which every supplier system is an authorizable {kind: 'system'}
 * object ANCHORED TO ITS OWNER ORGANIZATION (ownerOrganizationId).
 *
 * Authorization is organization-scoped (FR-053: "a verified supplier";
 * Wiley's boundary: "Supplier reports and boundaries need a verified
 * organization assignment"): the shared entitlement engine already resolves
 * organization scopes via object.ownerOrganizationId, so no policy-package
 * change is needed.
 *
 * The fixture world defines the two owner organizations but NO member
 * accounts (the Wiley shell persona is a documented demo synthesis). This
 * loader therefore follows the established extra-principal pattern
 * (../stewardship/test/helpers.ts, buildWorld extraPrincipals/extraEntitlements)
 * via the deriving helper withSupplierActor below: it NEVER edits
 * packages/policy (out of write scope and out of authority).
 *
 * The Water Use Manager reviewer is modeled as an organization-scoped
 * supplier-reporting grant with role family 'owner' (ROLE_CEILING.owner
 * includes supplier-reporting), while suppliers hold role 'water-user'
 * (Wiley's family, ceiling includes supplier-reporting). The role label
 * never grants anything by itself (the engine evaluates the capability);
 * supplier-report/Scope uses it only to NARROW who may approve, exactly like
 * the engine narrows deputies by role + delegation. PENDING Water Use
 * Program owner ratification (open product decision).
 */
import { readFileSync } from 'node:fs';

import {
  buildWorld,
  parseEntitlement,
  parsePrincipal,
  type PolicyObject,
  type PolicyWorld,
  type Principal,
  type RawEntitlement,
} from '../../../../../packages/policy/src/index.ts';

const FIXTURE_DIR = '../../../../../fixtures/contracts/';
const EXPECTED_SEED = 'utah-water-fixture-v1';

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(FIXTURE_DIR + name, import.meta.url), 'utf8')) as T;
}

interface StationsShape {
  seed: string;
  stations: ReadonlyArray<{
    id: string;
    displayName: string;
    systemId: string;
    status: string;
    visibility: string;
    ownerOrganizationId?: string | null;
    datastreams?: ReadonlyArray<{ id: string; stationId: string; observedPropertyId: string; unitId: string; visibility: string }>;
  }>;
}

interface SystemsShape {
  seed: string;
  systems: ReadonlyArray<{ id: string; name: string; kind: string }>;
}

interface PrincipalsShape {
  seed: string;
  organizations?: ReadonlyArray<{ id: string; name: string; kind: string }>;
  users: ReadonlyArray<{ id: string }>;
  entitlements: ReadonlyArray<RawEntitlement>;
}

/** One organization's supplier anchor: the system it reports on and its owned stations. */
export interface SupplierAnchor {
  readonly orgId: string;
  readonly orgName: string;
  readonly systemId: string;
  readonly systemName: string;
  readonly stationIds: readonly string[];
}

/** Station detail of one supplier org (FR-053 "assigned area sources"). */
export interface SupplierStationSummary {
  readonly orgId: string;
  readonly stationId: string;
  readonly displayName: string;
  readonly status: string;
  readonly visibility: 'public' | 'restricted' | 'internal';
  readonly dischargeStreams: readonly { readonly streamId: string; readonly unitId: string }[];
}

export interface SupplierWorld {
  readonly seed: string;
  readonly anchors: readonly SupplierAnchor[];
  readonly stations: readonly SupplierStationSummary[];
  readonly policyWorld: PolicyWorld;
}

function systemPolicyObject(systemId: string, ownerOrgId: string | null): PolicyObject {
  return Object.freeze({
    id: systemId,
    kind: 'system',
    systemId,
    ownerOrganizationId: ownerOrgId,
    stationId: null,
    datasetId: null,
    ownerPrincipalId: null,
    targetObjectId: null,
    visibility: 'restricted',
    status: 'active',
    fields: Object.freeze({}),
  });
}

export function createSupplierWorld(): SupplierWorld {
  const principalsFixture = readFixture<PrincipalsShape>('principals.json');
  const stationsFixture = readFixture<StationsShape>('stations.json');
  const systemsFixture = readFixture<SystemsShape>('systems.json');
  if (principalsFixture.seed !== EXPECTED_SEED || stationsFixture.seed !== EXPECTED_SEED || systemsFixture.seed !== EXPECTED_SEED) {
    throw new Error(`fixture seed mismatch: expected ${EXPECTED_SEED} in every contract file`);
  }

  const orgNames = new Map((principalsFixture.organizations ?? []).map((org) => [org.id, org.name] as const));
  const systemNames = new Map(systemsFixture.systems.filter((system) => system.kind === 'system').map((system) => [system.id, system.name] as const));

  // Owner org -> owning stations; a supplier system is a system that owns at
  // least one owner-organization station. Both fixture orgs anchor here:
  // org-cache-water -> sys-bear-river, org-bear-river-users -> sys-weber-river.
  const stationsByOrg = new Map<string, typeof stationsFixture.stations[number][]>();
  for (const station of stationsFixture.stations) {
    if (!station.ownerOrganizationId) continue;
    const list = stationsByOrg.get(station.ownerOrganizationId);
    if (list) list.push(station);
    else stationsByOrg.set(station.ownerOrganizationId, [station]);
  }

  const anchors: SupplierAnchor[] = [];
  const systemObjects: PolicyObject[] = [];
  const stationSummaries: SupplierStationSummary[] = [];
  for (const system of systemsFixture.systems) {
    if (system.kind !== 'system') continue;
    let ownerOrgId: string | null = null;
    const owned: string[] = [];
    for (const [orgId, stations] of stationsByOrg) {
      const inSystem = stations.filter((station) => station.systemId === system.id);
      if (inSystem.length === 0) continue;
      if (ownerOrgId !== null && ownerOrgId !== orgId) {
        throw new Error(`fixture ambiguity: system ${system.id} has owner stations from two organizations (${ownerOrgId}, ${orgId})`);
      }
      ownerOrgId = orgId;
      owned.push(...inSystem.map((station) => station.id));
      for (const station of inSystem) {
        stationSummaries.push(
          Object.freeze({
            orgId,
            stationId: station.id,
            displayName: station.displayName,
            status: station.status,
            visibility: station.visibility === 'public' ? 'public' : station.visibility === 'internal' ? 'internal' : 'restricted',
            dischargeStreams: Object.freeze(
              (station.datastreams ?? [])
                .filter((stream) => stream.observedPropertyId === 'discharge')
                .map((stream) => Object.freeze({ streamId: stream.id, unitId: stream.unitId })),
            ),
          }),
        );
      }
    }
    systemObjects.push(systemPolicyObject(system.id, ownerOrgId));
    if (ownerOrgId) {
      anchors.push(
        Object.freeze({
          orgId: ownerOrgId,
          orgName: orgNames.get(ownerOrgId) ?? ownerOrgId,
          systemId: system.id,
          systemName: systemNames.get(system.id) ?? system.id,
          stationIds: Object.freeze(owned.sort()),
        }),
      );
    }
  }
  anchors.sort((a, b) => (a.orgId < b.orgId ? -1 : 1));
  stationSummaries.sort((a, b) => (a.stationId < b.stationId ? -1 : 1));

  const policyWorld = buildWorld({
    principals: principalsFixture as Parameters<typeof buildWorld>[0]['principals'],
    stations: stationsFixture as Parameters<typeof buildWorld>[0]['stations'],
    extraObjects: systemObjects,
  });

  return Object.freeze({ seed: EXPECTED_SEED, anchors: Object.freeze(anchors), stations: Object.freeze(stationSummaries), policyWorld });
}

let shared: SupplierWorld | null = null;

/** Single shared frozen supplier world for the process (fixtures are read-only). */
export function supplierWorld(): SupplierWorld {
  if (!shared) shared = createSupplierWorld();
  return shared;
}

// ---------------------------------------------------------------------------
// Deriving supplier/reviewer actors (the established withEntitlement-family
// test pattern; derives a NEW frozen world, never mutates the original)
// ---------------------------------------------------------------------------

export type SupplierActorRole = 'water-user' | 'owner';

export interface SupplierActorInput {
  readonly principalId: string;
  readonly displayName: string;
  readonly orgId: string;
  /** 'water-user' = supplier member (Wiley's family); 'owner' = Water Use reviewer side. */
  readonly role: SupplierActorRole;
}

function nextGrantVersion(world: PolicyWorld): number {
  return world.assignments.reduce((max, a) => Math.max(max, a.grantVersion), 0) + 1;
}

/**
 * Derive a world with one more organization-scoped supplier-reporting actor.
 * The grant is the exact fixture vocabulary (capability 'supplier-reporting',
 * scopeType 'organization'); role family distinguishes supplier vs reviewer
 * for the domain-level approval narrowing documented above.
 */
export function withSupplierActor(world: PolicyWorld, actor: SupplierActorInput): PolicyWorld {
  const principal: Principal = parsePrincipal({
    id: actor.principalId,
    displayName: actor.displayName,
    roles: [actor.role],
    active: true,
    description: `WD-017 synthetic supplier-reporting actor (${actor.role}) for ${actor.orgId}`,
  });
  const entitlement: RawEntitlement = {
    id: `ent-${actor.principalId}`,
    principalId: actor.principalId,
    role: actor.role,
    capabilities: ['supplier-reporting'],
    scopeType: 'organization',
    scopeId: actor.orgId,
    effectiveAt: '2025-07-01T00:00:00Z',
    expiresAt: null,
    status: 'active',
    delegation: null,
    grantedBy: 'principal-diego-steward',
    grantVersion: nextGrantVersion(world),
  };
  const principals = { ...world.principals, [actor.principalId]: principal };
  const assignments = [...world.assignments, parseEntitlement(entitlement)];
  const assignmentVersion = assignments.reduce((max, a) => Math.max(max, a.grantVersion), 0);
  return Object.freeze({ ...world, principals: Object.freeze(principals), assignments: Object.freeze(assignments), assignmentVersion });
}

/** Convenience: the shared fixture world plus the standard test/demo actors. */
export interface StandardSupplierActors {
  /** Wiley: water user of org-cache-water (supplier on Bear River). */
  readonly WILEY: string;
  /** Second supplier: water user of org-bear-river-users (supplier on Weber River). */
  readonly MORGAN: string;
  /** Water Use reviewer for org-cache-water / Bear River. */
  readonly REVIEWER_CACHE: string;
  /** Water Use reviewer for org-bear-river-users / Weber River. */
  readonly REVIEWER_BEAR: string;
}

export const STANDARD_ACTORS: StandardSupplierActors = Object.freeze({
  WILEY: 'principal-wiley-water-user',
  MORGAN: 'principal-morgan-water-user',
  REVIEWER_CACHE: 'principal-wum-reviewer-cache',
  REVIEWER_BEAR: 'principal-wum-reviewer-bear',
});

/** The shared supplier world with the four standard synthetic actors attached. */
export function standardSupplierWorld(): PolicyWorld {
  const base = supplierWorld().policyWorld;
  const cache = supplierWorld().anchors.find((anchor) => anchor.orgId === 'org-cache-water');
  const bear = supplierWorld().anchors.find((anchor) => anchor.orgId === 'org-bear-river-users');
  if (!cache || !bear) throw new Error('fixture world missing one of the two owner organizations');
  return withSupplierActor(
    withSupplierActor(
      withSupplierActor(
        withSupplierActor(base, {
          principalId: STANDARD_ACTORS.WILEY,
          displayName: 'Wiley Ostler',
          orgId: 'org-cache-water',
          role: 'water-user',
        }),
        {
          principalId: STANDARD_ACTORS.MORGAN,
          displayName: 'Morgan Reyes',
          orgId: 'org-bear-river-users',
          role: 'water-user',
        },
      ),
      {
        principalId: STANDARD_ACTORS.REVIEWER_CACHE,
        displayName: 'Water Use Reviewer (Cache)',
        orgId: 'org-cache-water',
        role: 'owner',
      },
    ),
    {
      principalId: STANDARD_ACTORS.REVIEWER_BEAR,
      displayName: 'Water Use Reviewer (Bear River Users)',
      orgId: 'org-bear-river-users',
      role: 'owner',
    },
  );
}

export function anchorOfSystem(world: SupplierWorld, systemId: string): SupplierAnchor | null {
  return world.anchors.find((anchor) => anchor.systemId === systemId) ?? null;
}

export function anchorOfOrg(world: SupplierWorld, orgId: string): SupplierAnchor | null {
  return world.anchors.find((anchor) => anchor.orgId === orgId) ?? null;
}
