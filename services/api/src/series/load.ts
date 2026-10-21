/**
 * Fixture-backed series store (WD-008), following the WD-011 pattern of a
 * pure, frozen, fixture-loaded world. Loads the contract fixtures
 * (fixtures/contracts, seed utah-water-fixture-v1) once and exposes:
 *
 * - stream metadata (cadence, valid range, visibility, station identity);
 * - the immutable raw observations of a stream inside a bounded window
 *   (plus a cadence look-back so a forward-cadence manual reading that still
 *   governs the window is not dropped);
 * - the append-only revision chains keyed by target observation;
 * - declared gaps;
 * - the policy world (datastream + station objects) for grantCheck.
 *
 * No clock reads, no randomness: two stores built from the same fixtures
 * return byte-identical results.
 */
import { readFileSync } from 'node:fs';
import { buildWorld, type PolicyWorld } from '../../../../packages/policy/src/index.ts';
import type { GapRow, ObservationRow, RevisionRow, StreamMeta } from './types.ts';

const FIXTURE_DIR = '../../../../fixtures/contracts/';

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(FIXTURE_DIR + name, import.meta.url), 'utf8')) as T;
}

interface StationFixture {
  seed: string;
  stations: ReadonlyArray<{
    id: string;
    displayName: string;
    systemId: string;
    status: string;
    visibility: string;
    datastreams?: ReadonlyArray<{
      id: string;
      stationId: string;
      observedPropertyId: string;
      unitId: string;
      methodTypeId: string;
      cadenceMinutes: number;
      validRangeMin: number;
      validRangeMax: number;
      visibility: string;
      timeZone: string;
    }>;
  }>;
}

interface ObservationsFixture {
  seed: string;
  observations: readonly ObservationRow[];
  revisions: readonly RevisionRow[];
  gaps: readonly GapRow[];
}

export interface SeriesStore {
  readonly world: PolicyWorld;
  streamById(streamId: string): StreamMeta | null;
  /** All observation ids of a stream ordered by (observedAt, receivedAt) - duplicates retained. */
  observationsForStream(streamId: string): readonly ObservationRow[];
  /** Append-order revision chain for an observation id (empty when unrevised). */
  revisionChain(observationId: string): readonly RevisionRow[];
  gapsForStream(streamId: string): readonly GapRow[];
  /** Bounded window check shared by series, comparison and export requests. */
  vocabularyUnitIds(): readonly string[];
}

export function createSeriesStore(): SeriesStore {
  const stationsFixture = readFixture<StationFixture>('stations.json');
  const observationsFixture = readFixture<ObservationsFixture>('observations.json');
  const principalsFixture = readFixture<{ seed: string }>('principals.json');
  const vocabularyFixture = readFixture<{ seed: string; units: ReadonlyArray<{ id: string }> }>('vocabulary.json');

  if (
    stationsFixture.seed !== 'utah-water-fixture-v1' ||
    observationsFixture.seed !== 'utah-water-fixture-v1' ||
    principalsFixture.seed !== 'utah-water-fixture-v1' ||
    vocabularyFixture.seed !== 'utah-water-fixture-v1'
  ) {
    throw new Error('fixture seed mismatch: expected utah-water-fixture-v1 in every contract file');
  }

  const streamMeta = new Map<string, StreamMeta>();
  for (const station of stationsFixture.stations) {
    for (const stream of station.datastreams ?? []) {
      streamMeta.set(stream.id, Object.freeze({
        id: stream.id,
        stationId: station.id,
        systemId: station.systemId,
        observedPropertyId: stream.observedPropertyId,
        unitId: stream.unitId,
        methodTypeId: stream.methodTypeId,
        cadenceMinutes: stream.cadenceMinutes,
        validRangeMin: stream.validRangeMin,
        validRangeMax: stream.validRangeMax,
        visibility: stream.visibility === 'public' ? 'public' : stream.visibility === 'internal' ? 'internal' : 'restricted',
        timeZone: stream.timeZone,
        stationDisplayName: station.displayName,
      }));
    }
  }

  const byStream = new Map<string, ObservationRow[]>();
  for (const obs of observationsFixture.observations) {
    const list = byStream.get(obs.streamId);
    if (list) list.push(Object.freeze({ ...obs }));
    else byStream.set(obs.streamId, [Object.freeze({ ...obs })]);
  }
  for (const list of byStream.values()) {
    list.sort((a, b) => {
      const at = Date.parse(a.observedAt) - Date.parse(b.observedAt);
      if (at !== 0) return at;
      const rt = Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
      if (rt !== 0) return rt;
      return a.sourceEventId < b.sourceEventId ? -1 : 1; // total order even for identical receipts
    });
  }

  const chains = new Map<string, RevisionRow[]>();
  for (const rev of [...observationsFixture.revisions].sort(
    (a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || (a.id < b.id ? -1 : 1),
  )) {
    const chain = chains.get(rev.targetObservationId);
    if (chain) chain.push(Object.freeze({ ...rev }));
    else chains.set(rev.targetObservationId, [Object.freeze({ ...rev })]);
  }

  const world = buildWorld({
    principals: readFixture<Parameters<typeof buildWorld>[0]['principals']>('principals.json'),
    stations: stationsFixture as Parameters<typeof buildWorld>[0]['stations'],
  });

  const gapsByStream = new Map<string, GapRow[]>();
  for (const gap of observationsFixture.gaps) {
    const list = gapsByStream.get(gap.streamId);
    if (list) list.push(Object.freeze({ ...gap }));
    else gapsByStream.set(gap.streamId, [Object.freeze({ ...gap })]);
  }

  return {
    world,
    streamById: (streamId) => streamMeta.get(streamId) ?? null,
    observationsForStream: (streamId) => byStream.get(streamId) ?? [],
    revisionChain: (observationId) => chains.get(observationId) ?? [],
    gapsForStream: (streamId) =>
      [...(gapsByStream.get(streamId) ?? [])].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)),
    vocabularyUnitIds: () => vocabularyFixture.units.map((unit) => unit.id),
  };
}

/** Single shared frozen store for the process (fixtures are read-only). */
let sharedStore: SeriesStore | null = null;
export function seriesStore(): SeriesStore {
  if (!sharedStore) sharedStore = createSeriesStore();
  return sharedStore;
}
