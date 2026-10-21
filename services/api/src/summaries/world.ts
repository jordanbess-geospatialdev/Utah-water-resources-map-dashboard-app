/**
 * Fixture-backed policy world for the WD-018 summaries domain
 * (FR-058..FR-062), following the WD-008/WD-011 pattern of a pure, frozen,
 * fixture-loaded world: no clock reads, no randomness, two worlds built from
 * the same fixtures return byte-identical results.
 *
 * The summaries domain needs station-level policy fields the series store
 * does not expose (status, telemetry, site type, water source), so it reads
 * the same contract fixtures through its own loader. Observation, revision
 * and gap rows reuse the WD-008 series TYPES (../series/types.ts) so the
 * classification semantics stay aligned; the numerical totals reuse the
 * WD-008 aggregation itself (see totals.ts).
 */
import { readFileSync } from 'node:fs';
import type { GapRow, ObservationRow, RevisionRow } from '../series/types.ts';

const FIXTURE_DIR = '../../../../fixtures/contracts/';
const EXPECTED_SEED = 'utah-water-fixture-v1';

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(FIXTURE_DIR + name, import.meta.url), 'utf8')) as T;
}

/** Governed station status; anything else is excluded from indicator denominators. */
export type StationStatus = 'active' | 'inactive' | 'proposed';

/** Fields the summary indicators and accounting categories read from a datastream. */
export interface SummaryStream {
  readonly id: string;
  readonly stationId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  readonly visibility: 'public' | 'restricted' | 'internal';
  readonly timeZone: string;
}

export interface SummaryStation {
  readonly id: string;
  readonly displayName: string;
  readonly systemId: string;
  readonly status: string;
  readonly visibility: 'public' | 'restricted' | 'internal';
  readonly telemetry: string;
  readonly siteTypeId: string;
  readonly waterSourceTypeId: string;
  readonly streams: readonly SummaryStream[];
}

export interface SummarySystem {
  readonly id: string;
  readonly name: string;
}

export interface SummaryWorld {
  readonly seed: string;
  /** The fixture fixed clock (seed-manifest fixed_clock); every asOf defaults to it. */
  readonly asOf: string;
  readonly stations: readonly SummaryStation[];
  readonly systems: readonly SummarySystem[];
  readonly observations: readonly ObservationRow[];
  readonly revisions: readonly RevisionRow[];
  readonly gaps: readonly GapRow[];
}

interface StationFixture {
  seed: string;
  stations: ReadonlyArray<{
    id: string;
    displayName: string;
    systemId: string;
    status: string;
    visibility: string;
    telemetry: string;
    siteTypeId: string;
    waterSourceTypeId: string;
    datastreams?: ReadonlyArray<{
      id: string;
      stationId: string;
      observedPropertyId: string;
      unitId: string;
      visibility: string;
      timeZone: string;
    }>;
  }>;
}

function toVisibility(value: string): SummaryStation['visibility'] {
  return value === 'public' ? 'public' : value === 'internal' ? 'internal' : 'restricted';
}

/** Status rule shared by every indicator: only ACTIVE stations join a denominator. */
export function statusExclusion(status: string): 'inactive' | 'proposed' | 'unknown-status' | null {
  if (status === 'inactive') return 'inactive';
  if (status === 'proposed') return 'proposed';
  if (status === 'active') return null;
  return 'unknown-status'; // never silently included
}

export function createSummaryWorld(): SummaryWorld {
  const stationsFixture = readFixture<StationFixture>('stations.json');
  const systemsFixture = readFixture<{ seed: string; systems: ReadonlyArray<{ id: string; name: string }> }>('systems.json');
  const observationsFixture = readFixture<{
    seed: string;
    observations: readonly ObservationRow[];
    revisions: readonly RevisionRow[];
    gaps: readonly GapRow[];
  }>('observations.json');
  const manifest = readFixture<{ seed: string; fixed_clock: string }>('seed-manifest.json');
  if (
    stationsFixture.seed !== EXPECTED_SEED ||
    systemsFixture.seed !== EXPECTED_SEED ||
    observationsFixture.seed !== EXPECTED_SEED ||
    manifest.seed !== EXPECTED_SEED
  ) {
    throw new Error(`fixture seed mismatch: expected ${EXPECTED_SEED} in every contract file`);
  }

  const stations: SummaryStation[] = stationsFixture.stations.map((station) => ({
    id: station.id,
    displayName: station.displayName,
    systemId: station.systemId,
    status: station.status,
    visibility: toVisibility(station.visibility),
    telemetry: station.telemetry,
    siteTypeId: station.siteTypeId,
    waterSourceTypeId: station.waterSourceTypeId,
    streams: (station.datastreams ?? []).map((stream) => ({
      id: stream.id,
      stationId: stream.stationId,
      observedPropertyId: stream.observedPropertyId,
      unitId: stream.unitId,
      visibility: toVisibility(stream.visibility),
      timeZone: stream.timeZone,
    })),
  }));

  return Object.freeze({
    seed: EXPECTED_SEED,
    asOf: manifest.fixed_clock,
    stations: Object.freeze(stations),
    systems: Object.freeze(systemsFixture.systems.map((system) => Object.freeze({ id: system.id, name: system.name }))),
    observations: observationsFixture.observations,
    revisions: observationsFixture.revisions,
    gaps: observationsFixture.gaps,
  });
}

let shared: SummaryWorld | null = null;

/** Single shared frozen world for the process (fixtures are read-only). */
export function summaryWorld(): SummaryWorld {
  if (!shared) shared = createSummaryWorld();
  return shared;
}

export function systemNameOf(world: SummaryWorld, systemId: string): string | null {
  return world.systems.find((system) => system.id === systemId)?.name ?? null;
}

/** Stations in scope: statewide, or one distribution system, sorted by id. */
export function stationsInScope(world: SummaryWorld, systemId?: string): readonly SummaryStation[] {
  const scoped = systemId === undefined ? world.stations : world.stations.filter((station) => station.systemId === systemId);
  return [...scoped].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Earliest..latest observation instants reported by the scoped stations (verbatim fixture strings). */
export function observationWindow(world: SummaryWorld, systemId?: string): { start: string | null; end: string | null } {
  const scope = new Set(stationsInScope(world, systemId).flatMap((station) => station.streams.map((stream) => stream.id)));
  let minMs: number | null = null;
  let maxMs: number | null = null;
  let start: string | null = null;
  let end: string | null = null;
  for (const obs of world.observations) {
    if (!scope.has(obs.streamId)) continue;
    const at = Date.parse(obs.observedAt);
    if (minMs === null || at < minMs) {
      minMs = at;
      start = obs.observedAt;
    }
    if (maxMs === null || at > maxMs) {
      maxMs = at;
      end = obs.observedAt;
    }
  }
  return { start, end };
}
