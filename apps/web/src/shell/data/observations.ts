/**
 * Observation series logic ported from the validated prototype's
 * observations.ts, adapted to the contract fixtures. Core rules carried over
 * and made explicit against the fixture world:
 *
 * - Raw observations are immutable; corrections append revisions and the
 *   best-available value is derived, never overwritten (rev-corinne-2001 is
 *   retained when rev-corinne-2004 advances the same point).
 * - Missing readings stay missing: a null value is reported-but-empty, a
 *   declared gap is a hole, and neither is ever rendered as zero.
 * - Duplicate timestamps are retained (obs-q-016/obs-q-017) and ordered by
 *   receipt so both originals survive.
 * - Order follows observedAt, not receivedAt, so a late arrival
 *   (obs-q-005) lands on its observation instant.
 * - Out-of-range values are labelled, not clipped (obs-q-044).
 */
import { FIXTURE_CLOCK, gaps, observations as allObservations, revisions, stations } from './fixtures';
import type { DatastreamRecord, ObservationRecord, RevisionRecord, StationRecord } from './types';

export type PointFlag =
  | 'out-of-range'
  | 'negative'
  | 'suspect-zero'
  | 'late-arrival'
  | 'duplicate-timestamp'
  | 'estimated'
  | 'revised'
  | 'null-frame';

export interface SeriesPoint {
  id: string;
  streamId: string;
  observedAt: string;
  sourceOffset: string;
  /** Exactly as received; null means reported-but-empty. */
  raw: number | null;
  /** Latest revision value when one exists, otherwise the raw value. */
  best: number | null;
  valueType: 'observed' | 'estimated';
  /** Processing level of the best-available value ('raw' when unrevised). */
  processingLevel: 'raw' | 'provisional' | 'reviewed' | 'best-available';
  unitId: string;
  receivedAt: string;
  flags: PointFlag[];
  revisionIds: string[];
}

const LATE_ARRIVAL_MS = 6 * 60 * 60 * 1000;

function compareObserved(a: ObservationRecord, b: ObservationRecord): number {
  const at = Date.parse(a.observedAt) - Date.parse(b.observedAt);
  return at !== 0 ? at : Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
}

function revisionsFor(observationId: string): RevisionRecord[] {
  return revisions
    .filter((rev) => rev.targetObservationId === observationId)
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
}

function flagsFor(observation: ObservationRecord, stream: DatastreamRecord, duplicateTimestamps: Set<string>): PointFlag[] {
  const flags: PointFlag[] = [];
  const value = observation.value;
  if (value === null) flags.push('null-frame');
  if (value !== null && value > stream.validRangeMax) flags.push('out-of-range');
  if (value !== null && value < stream.validRangeMin) flags.push('negative');
  if (value === 0) flags.push('suspect-zero');
  if (observation.valueType === 'estimated') flags.push('estimated');
  if (Date.parse(observation.receivedAt) - Date.parse(observation.observedAt) > LATE_ARRIVAL_MS) flags.push('late-arrival');
  if (duplicateTimestamps.has(observation.observedAt)) flags.push('duplicate-timestamp');
  return flags;
}

/** Best-available series for a datastream: raw observations with revisions applied on top. */
export function streamSeries(streamId: string): SeriesPoint[] {
  const stream = stations.flatMap((station) => station.datastreams).find((s) => s.id === streamId);
  if (!stream) return [];
  const inStream = allObservations
    .filter((obs) => obs.streamId === streamId)
    .sort(compareObserved);
  const duplicateTimestamps = new Set(
    inStream
      .map((obs) => obs.observedAt)
      .filter((at, index, all) => all.indexOf(at) !== index),
  );
  return inStream.map((observation) => {
    const revs = revisionsFor(observation.id);
    const latest = revs.at(-1);
    const flags = flagsFor(observation, stream, duplicateTimestamps);
    if (revs.length > 0) flags.push('revised');
    return {
      id: observation.id,
      streamId,
      observedAt: observation.observedAt,
      sourceOffset: observation.sourceOffset,
      raw: observation.value,
      best: latest ? latest.value : observation.value,
      valueType: observation.valueType,
      processingLevel: latest ? latest.processingLevel : 'raw',
      unitId: observation.unitId,
      receivedAt: observation.receivedAt,
      flags,
      revisionIds: revs.map((rev) => rev.id),
    } satisfies SeriesPoint;
  });
}

/** The discharge datastream a station's dashboard card and chart are bound to (first when several exist). */
export function dischargeStream(station: StationRecord): DatastreamRecord | undefined {
  return station.datastreams.find((stream) => stream.observedPropertyId === 'discharge');
}

export interface LatestReading {
  value: number | null;
  unitId: string;
  observedAt: string;
  processingLevel: SeriesPoint['processingLevel'];
  flags: PointFlag[];
}

/** Latest discharge reading for a station; null value means unavailable, never zero. */
export function latestReading(station: StationRecord): LatestReading | null {
  const stream = dischargeStream(station);
  if (!stream) return null;
  const last = streamSeries(stream.id).at(-1);
  if (!last) return null;
  return { value: last.best, unitId: last.unitId, observedAt: last.observedAt, processingLevel: last.processingLevel, flags: last.flags };
}

export type Freshness = 'current' | 'stale' | 'inactive' | 'no-data';

/**
 * Freshness against the fixed fixture clock. Stale readings stay visible with
 * their timestamp rather than implying a live connection (NFR-004).
 */
export function stationFreshness(station: StationRecord): Freshness {
  if (station.status !== 'active') return 'inactive';
  const stream = dischargeStream(station);
  if (!stream) return 'no-data';
  const last = streamSeries(stream.id).at(-1);
  if (!last) return 'no-data';
  const ageMs = Date.parse(FIXTURE_CLOCK) - Date.parse(last.observedAt);
  return ageMs > stream.cadenceMinutes * 3 * 60 * 1000 ? 'stale' : 'current';
}

/** Declared gaps for a stream, ordered by start. Missing readings are declared, not back-filled. */
export function streamGaps(streamId: string) {
  return gaps.filter((gap) => gap.streamId === streamId).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** Revisions touching any of a station's datastreams, newest first, with actor and full history preserved. */
export function stationRevisions(station: StationRecord): (RevisionRecord & { observationId: string; observedAt: string })[] {
  const streamIds = new Set(station.datastreams.map((stream) => stream.id));
  const observedAtById = new Map(allObservations.map((obs) => [obs.id, obs.observedAt]));
  return revisions
    .filter((rev) => {
      const obs = allObservations.find((o) => o.id === rev.targetObservationId);
      return obs !== undefined && streamIds.has(obs.streamId);
    })
    .map((rev) => ({ ...rev, observationId: rev.targetObservationId, observedAt: observedAtById.get(rev.targetObservationId) ?? '' }))
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
}

/** Points within the trailing `days` window of the fixture clock (inclusive). */
export function windowedPoints(streamId: string, days: number): SeriesPoint[] {
  const clock = Date.parse(FIXTURE_CLOCK);
  const from = clock - days * 24 * 60 * 60 * 1000;
  return streamSeries(streamId).filter((point) => {
    const at = Date.parse(point.observedAt);
    return at >= from && at <= clock;
  });
}
