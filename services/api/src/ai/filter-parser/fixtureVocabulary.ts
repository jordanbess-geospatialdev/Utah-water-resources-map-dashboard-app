/**
 * Fixture-backed ParserVocabulary loader (node-only; NOT part of the
 * browser-safe core — index.ts must stay free of node imports so apps/web
 * can bundle it).
 *
 * Reads the contract fixtures (fixtures/contracts, seed
 * utah-water-fixture-v1) exactly like WD-007's discovery registry does and
 * mirrors its vocabulary breadth:
 *
 * - governed registries (systems, subgroups, providers) by name;
 * - observed properties and processing levels from vocabulary.json;
 * - site types / water source types / measurement method types from ALL
 *   fixture stations (values carried only by non-public stations —
 *   "diagnostic", "surface-storage-release", "method-direct-read" — stay in
 *   the vocabulary: they are classifications, not object identifiers, and
 *   they select NOTHING publicly, which the equivalence suite proves; the
 *   restricted object IDENTIFIARS themselves are never values);
 * - time steps: the deterministic derivation domain (15/60/1440/10080 min);
 * - restricted object identifiers (non-public stations + their non-public
 *   streams, users, organizations) for the security scan.
 *
 * Deterministic: two loads produce deep-equal vocabularies.
 */
import { readFileSync } from 'node:fs';
import {
  prettifyValueId,
  SEED_LABELS,
  SEED_SITE_STATUS_VALUES,
  SEED_TELEMETRY_VALUES,
  SEED_TIME_STEPS,
} from './vocabulary';
import type { ParserVocabulary, VocabularyValue } from './types';

const FIXTURE_DIR = '../../../../../fixtures/contracts/';

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(FIXTURE_DIR + name, import.meta.url), 'utf-8')) as T;
}

interface SystemsFixture {
  seed: string;
  systems: { id: string; name: string; kind: string }[];
  subgroups: { id: string; systemId: string; name: string }[];
  providers: { id: string; name: string; kind: string }[];
}
interface VocabularyFixture {
  seed: string;
  observedProperties: { id: string; name: string }[];
  processingLevels: { id: string; name: string }[];
}
interface StationsFixture {
  seed: string;
  stations: {
    id: string;
    visibility: string;
    siteTypeId: string;
    waterSourceTypeId: string;
    status: string;
    telemetry: string;
    datastreams?: { id: string; visibility: string; methodTypeId: string; cadenceMinutes: number }[];
  }[];
}
interface PrincipalsFixture {
  seed: string;
  users: { id: string }[];
  organizations: { id: string }[];
}

const KNOWN_TIME_STEPS = new Set(SEED_TIME_STEPS.map((step) => step.id));

/** Cadence → time-step id, mirroring WD-007 timeStepIdForCadence. */
function timeStepIdForCadence(cadenceMinutes: number): string {
  const byCadence: Record<number, string> = { 15: 'fifteen-minute', 60: 'hourly', 1440: 'daily', 10080: 'weekly' };
  if (!Number.isFinite(cadenceMinutes) || cadenceMinutes <= 0) return 'irregular';
  return byCadence[cadenceMinutes] ?? `every-${cadenceMinutes}-minutes`;
}

function labelFor(group: 'siteTypes' | 'waterSources' | 'methods', id: string): string {
  return SEED_LABELS[group][id] ?? prettifyValueId(id);
}

/** Load the controlled vocabulary from the contract fixtures. */
export function loadFixtureVocabulary(): ParserVocabulary {
  const systems = readFixture<SystemsFixture>('systems.json');
  const vocabulary = readFixture<VocabularyFixture>('vocabulary.json');
  const stations = readFixture<StationsFixture>('stations.json');
  const principals = readFixture<PrincipalsFixture>('principals.json');

  const seeds = [systems, vocabulary, stations, principals].map((file) => file.seed);
  if (!seeds.every((seed) => seed === 'utah-water-fixture-v1')) {
    throw new Error('fixture seed mismatch: expected utah-water-fixture-v1 in every contract file');
  }

  const siteTypes = new Map<string, VocabularyValue>();
  const waterSources = new Map<string, VocabularyValue>();
  const methods = new Map<string, VocabularyValue>();
  const restricted: string[] = [];

  for (const station of stations.stations) {
    if (station.visibility !== 'public') restricted.push(station.id);
    siteTypes.set(station.siteTypeId, { id: station.siteTypeId, label: labelFor('siteTypes', station.siteTypeId) });
    waterSources.set(station.waterSourceTypeId, {
      id: station.waterSourceTypeId,
      label: labelFor('waterSources', station.waterSourceTypeId),
    });
    for (const stream of station.datastreams ?? []) {
      if (stream.visibility !== 'public') restricted.push(stream.id);
      methods.set(stream.methodTypeId, { id: stream.methodTypeId, label: labelFor('methods', stream.methodTypeId) });
      const stepId = timeStepIdForCadence(stream.cadenceMinutes);
      if (!KNOWN_TIME_STEPS.has(stepId)) {
        throw new Error(`fixture cadence ${stream.cadenceMinutes} maps outside the known time-step domain (${stepId})`);
      }
    }
  }
  restricted.push(...principals.users.map((user) => user.id), ...principals.organizations.map((org) => org.id));

  const byName = (entries: { id: string; name: string }[]): VocabularyValue[] =>
    [...entries].map((entry) => ({ id: entry.id, label: entry.name })).sort((a, b) => (a.id < b.id ? -1 : 1));

  const sorted = (values: Iterable<VocabularyValue>): VocabularyValue[] =>
    [...values].sort((a, b) => (a.id < b.id ? -1 : 1));

  return {
    systems: byName(systems.systems.filter((system) => system.kind === 'system')),
    subgroups: byName(systems.subgroups),
    providers: byName(systems.providers),
    observedProperties: byName(vocabulary.observedProperties),
    processingLevels: byName(vocabulary.processingLevels),
    siteTypes: sorted(siteTypes.values()),
    waterSourceTypes: sorted(waterSources.values()),
    measurementMethodTypes: sorted(methods.values()),
    timeSteps: [...SEED_TIME_STEPS].sort((a, b) => (a.id < b.id ? -1 : 1)),
    telemetryValues: [...SEED_TELEMETRY_VALUES],
    siteStatusValues: [...SEED_SITE_STATUS_VALUES],
    restrictedObjectIds: [...new Set(restricted)].sort(),
  };
}
