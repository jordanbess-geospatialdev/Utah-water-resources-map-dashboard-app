/**
 * Typed loading of the agreed contract fixtures. The JSON files in
 * ./fixtures/ are verbatim copies of fixtures/contracts/* (seed
 * `utah-water-fixture-v1`); every synthetic value rendered by this shell
 * comes from here, never from the older prototype fixtures.
 *
 * The seed identity and the key scenario anchors are asserted at load time so
 * a stale or mismatched fixture copy fails loudly instead of rendering a
 * subtly different demo world.
 */
import stationsJson from './fixtures/stations.json' with { type: 'json' };
import observationsJson from './fixtures/observations.json' with { type: 'json' };
import systemsJson from './fixtures/systems.json' with { type: 'json' };
import principalsJson from './fixtures/principals.json' with { type: 'json' };
import vocabularyJson from './fixtures/vocabulary.json' with { type: 'json' };
import seedManifestJson from './fixtures/seed-manifest.json' with { type: 'json' };
import type {
  EntitlementRecord,
  GapRecord,
  ObservationRecord,
  OrganizationRecord,
  ProviderRecord,
  RevisionRecord,
  SeedManifest,
  StationRecord,
  SubgroupRecord,
  SystemRecord,
  UserRecord,
  VocabularyRecord,
} from './types';

/** The fixed demo clock; freshness is computed against it, never Date.now(), so results are reproducible. */
export const FIXTURE_SEED = 'utah-water-fixture-v1';
export const FIXTURE_CLOCK = '2026-03-09T07:00:00Z';
export const FIXTURE_TIME_ZONE = 'America/Denver';

export const stations: StationRecord[] = (stationsJson as { seed: string; stations: StationRecord[] }).stations;
export const observations: ObservationRecord[] = (observationsJson as { observations: ObservationRecord[] }).observations;
export const revisions: RevisionRecord[] = (observationsJson as { revisions: RevisionRecord[] }).revisions;
export const gaps: GapRecord[] = (observationsJson as { gaps: GapRecord[] }).gaps;
export const systems: SystemRecord[] = (systemsJson as { systems: SystemRecord[] }).systems;
export const subgroups: SubgroupRecord[] = (systemsJson as { subgroups: SubgroupRecord[] }).subgroups;
export const providers: ProviderRecord[] = (systemsJson as { providers: ProviderRecord[] }).providers;
export const organizations: OrganizationRecord[] = (principalsJson as { organizations: OrganizationRecord[] }).organizations;
export const users: UserRecord[] = (principalsJson as { users: UserRecord[] }).users;
export const entitlements: EntitlementRecord[] = (principalsJson as { entitlements: EntitlementRecord[] }).entitlements;
export const vocabulary: VocabularyRecord = vocabularyJson as unknown as VocabularyRecord;
export const seedManifest: SeedManifest = seedManifestJson as unknown as SeedManifest;

function assertFixtureWorld(): void {
  const seeds = [stationsJson, observationsJson, systemsJson, principalsJson, vocabularyJson, seedManifestJson]
    .map((file) => (file as { seed?: string }).seed);
  if (!seeds.every((seed) => seed === FIXTURE_SEED)) throw new Error('fixture seed mismatch: expected utah-water-fixture-v1 in every contract file');
  if (seedManifest.fixed_clock !== FIXTURE_CLOCK) throw new Error('fixture clock mismatch');
  const index = seedManifest.scenario_index;
  const anchors: [string, string][] = [
    [index.public_telemetry_station ?? '', 'sta-bear-corinne'],
    [index.restricted_owner_station ?? '', 'sta-hyrum-diversion-owner'],
    [index.internal_diagnostic_station ?? '', 'sta-bear-lake-diagnostic'],
    [index.negative_value_observation ?? '', 'obs-q-032'],
    [index.null_value_observation ?? '', 'obs-q-010'],
  ];
  for (const [actual, expected] of anchors) if (actual !== expected) throw new Error(`fixture scenario anchor mismatch: ${actual} !== ${expected}`);
}
assertFixtureWorld();

export const stationById = new Map(stations.map((station) => [station.id, station]));
export const systemById = new Map(systems.map((system) => [system.id, system]));
export const providerById = new Map(providers.map((provider) => [provider.id, provider]));
export const organizationById = new Map(organizations.map((organization) => [organization.id, organization]));
export const userById = new Map(users.map((user) => [user.id, user]));
export const qualifierName = new Map(vocabulary.qualifiers.map((qualifier) => [qualifier.id, qualifier.name]));
export const processingLevelName = new Map(vocabulary.processingLevels.map((level) => [level.id, level.name]));
export const propertyName = new Map(vocabulary.observedProperties.map((prop) => [prop.id, prop.name]));

export function systemName(systemId: string): string {
  return systemById.get(systemId)?.name ?? systemId;
}

export function providerName(providerId: string): string {
  return providerById.get(providerId)?.name ?? providerId;
}

export function principalName(principalId: string): string {
  return userById.get(principalId)?.displayName ?? principalId;
}

/** Active, unexpired entitlements for a principal evaluated at the fixed fixture clock. */
export function activeEntitlements(principalId: string): EntitlementRecord[] {
  const clock = Date.parse(FIXTURE_CLOCK);
  return entitlements.filter((ent) => {
    if (ent.principalId !== principalId) return false;
    if (ent.status !== 'active') return false;
    if (Date.parse(ent.effectiveAt) > clock) return false;
    if (ent.expiresAt !== null && Date.parse(ent.expiresAt) <= clock) return false;
    return true;
  });
}
