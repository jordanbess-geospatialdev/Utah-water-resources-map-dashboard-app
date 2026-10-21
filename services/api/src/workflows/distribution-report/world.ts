/**
 * Fixture-backed report world for WD-025: the distribution systems from
 * fixtures/contracts/systems.json plus a policy world in which every system
 * is an authorizable policy object (kind 'system', scope anchor = itself).
 *
 * The WD-008 series store world (../../series/load.ts) builds stations and
 * datastream objects but carries no system objects, and report authorization
 * targets the SYSTEM ("For a selected authorized system and period...",
 * FR-024). This loader therefore rebuilds the world from the same contract
 * fixtures with the system objects added - same seed assertion, no mutation
 * of any other store's world.
 *
 * Systems are operational groupings, not published objects: visibility
 * 'restricted' means the hidden-object denial policy maps an out-of-scope
 * cross-system request to 404 (the other system does not exist for the
 * caller), exactly like a restricted stream in grantCheck.ts.
 */
import { readFileSync } from 'node:fs';
import { buildWorld, type PolicyObject, type PolicyWorld } from '../../../../../packages/policy/src/index.ts';

const FIXTURE_DIR = '../../../../../fixtures/contracts/';
const EXPECTED_SEED = 'utah-water-fixture-v1';

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(FIXTURE_DIR + name, import.meta.url), 'utf8')) as T;
}

export interface ReportSystem {
  readonly id: string;
  readonly name: string;
  readonly stateCodes: readonly string[];
}

interface SystemsFixture {
  seed: string;
  systems: ReadonlyArray<{ id: string; name: string; kind: string; stateCodes: string[] }>;
}

function systemPolicyObject(system: ReportSystem): PolicyObject {
  return Object.freeze({
    id: system.id,
    kind: 'system',
    systemId: system.id,
    ownerOrganizationId: null,
    stationId: null,
    datasetId: null,
    ownerPrincipalId: null,
    targetObjectId: null,
    visibility: 'restricted',
    status: 'active',
    fields: Object.freeze({}),
  });
}

export interface ReportWorld {
  readonly seed: string;
  readonly systems: readonly ReportSystem[];
  /** Policy world including one object per distribution system. */
  readonly policyWorld: PolicyWorld;
}

export function createReportWorld(): ReportWorld {
  const systemsFixture = readFixture<SystemsFixture>('systems.json');
  const principalsFixture = readFixture<Parameters<typeof buildWorld>[0]['principals']>('principals.json');
  const stationsFixture = readFixture<Parameters<typeof buildWorld>[0]['stations']>('stations.json');
  if (systemsFixture.seed !== EXPECTED_SEED || principalsFixture.seed !== EXPECTED_SEED || stationsFixture.seed !== EXPECTED_SEED) {
    throw new Error(`fixture seed mismatch: expected ${EXPECTED_SEED} in every contract file`);
  }

  const systems: ReportSystem[] = systemsFixture.systems
    .filter((system) => system.kind === 'system')
    .map((system) => Object.freeze({ id: system.id, name: system.name, stateCodes: Object.freeze([...system.stateCodes]) }));

  const policyWorld = buildWorld({
    principals: principalsFixture,
    stations: stationsFixture,
    extraObjects: systems.map(systemPolicyObject),
  });

  return Object.freeze({
    seed: EXPECTED_SEED,
    systems: Object.freeze(systems),
    policyWorld,
  });
}

let shared: ReportWorld | null = null;

/** Single shared frozen report world for the process (fixtures are read-only). */
export function reportWorld(): ReportWorld {
  if (!shared) shared = createReportWorld();
  return shared;
}

export function systemNameOf(world: ReportWorld, systemId: string): string | null {
  return world.systems.find((system) => system.id === systemId)?.name ?? null;
}
