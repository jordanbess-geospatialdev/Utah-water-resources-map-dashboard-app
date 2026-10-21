/**
 * Multi-site and multi-year comparison assembly (WD-008; FR-007).
 *
 * "Users compare selected upstream and downstream sites and years using
 * common units and aligned intervals; unavailable periods remain visible as
 * gaps and each series retains its source and quality legend."
 *
 * Rules:
 * - Aligned intervals: every selected stream is aggregated over the SAME
 *   local calendar buckets (America/Denver) with the same processing basis,
 *   and every series carries an entry for every bucket - a bucket with no
 *   data keeps a null mean and coverage 0 so gaps stay VISIBLE instead of
 *   disappearing from the alignment.
 * - Common units: every stream must share the observed property (dimension)
 *   and unit; mixing discharge cfs with stage ft or voltage V is a typed
 *   validation error, never a silent conversion (FR-061).
 * - Year comparison: the same stream (or site) across several years is
 *   aligned by bucket position within the year (e.g. day-of-year or month),
 *   so 2025 columns stay present as all-gap series when only 2026 has data.
 */
import { aggregateSeries } from './aggregate.ts';
import type { SeriesStore } from './load.ts';
import type { DomainResult, ProcessingBasis } from './types.ts';
import { denial } from './types.ts';

export interface CompareSelection {
  readonly streamId: string;
  /** When set, compare these local years of the stream (aligned within-year); omit for site comparison over the window. */
  readonly years?: readonly number[];
}

export interface CompareRequest {
  readonly selections: readonly CompareSelection[];
  /** Half-open window for non-year comparisons; ignored for year selections. */
  readonly start?: string;
  readonly end?: string;
  readonly basis: ProcessingBasis;
  readonly interval: AggregationInterval & ('daily' | 'weekly' | 'monthly');
}

export interface CompareBucketValue {
  readonly key: string;
  readonly intervalStart: string;
  readonly intervalEnd: string;
  readonly meanValue: number | null;
  readonly coverageFraction: number;
}

export interface CompareSeries {
  readonly label: string;
  readonly streamId: string;
  readonly stationId: string;
  readonly stationDisplayName: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  /** Source legend text: provider method, cadence and station identity stay attached to each series. */
  readonly sourceLabel: string;
  readonly methodTypeId: string;
  readonly cadenceMinutes: number;
  readonly basis: ProcessingBasis;
  readonly year: number | null;
  readonly buckets: readonly CompareBucketValue[];
  /** Stream-level declared gaps inside the compared range (rendered as hatching per series). */
  readonly gaps: readonly { id: string; start: string; end: string; reason: string }[];
}

export interface ComparisonResult {
  readonly interval: CompareRequest['interval'];
  readonly basis: ProcessingBasis;
  readonly commonPropertyId: string;
  readonly commonUnitId: string;
  readonly timeZone: string;
  readonly series: readonly CompareSeries[];
}

function bucketKeyWithinYear(key: string): string {
  // daily '2026-03-08' -> '03-08'; monthly '2026-03' -> '03'; weekly keys keep 'Www'.
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key.slice(5);
  if (/^\d{4}-\d{2}$/.test(key)) return key.slice(5);
  const weekMatch = /^(\d{4})-(W\d{2})$/.exec(key);
  if (weekMatch) return weekMatch[2]!;
  return key;
}

/**
 * Assemble the comparison. Grant gating happens BEFORE this function (the
 * HTTP layer gates every selected stream with grantCheck.readStreamsGrant);
 * here the numerics run over authorized data only.
 */
export function compareSeries(store: SeriesStore, request: CompareRequest): DomainResult<ComparisonResult> {
  if (request.selections.length === 0) {
    return denial(422, 'EMPTY_SELECTION', 'select at least one stream or stream-year to compare');
  }
  const streams = request.selections.map((selection) => store.streamById(selection.streamId));
  const unknown = request.selections.find((selection, index) => !streams[index]);
  if (unknown) return denial(404, 'NOT_FOUND', `stream "${unknown.streamId}" not found`);

  const metas = streams.map((stream) => stream!);
  const first = metas[0]!;
  const incompatible = metas.find(
    (stream) => stream.observedPropertyId !== first.observedPropertyId || stream.unitId !== first.unitId,
  );
  if (incompatible) {
    return denial(
      422,
      'INCOMPATIBLE_UNITS',
      `cannot compare ${incompatible.observedPropertyId}/${incompatible.unitId} with ${first.observedPropertyId}/${first.unitId}: common units and the same observed property are required`,
    );
  }

  const series: CompareSeries[] = [];
  const yearMode = request.selections.some((selection) => selection.years && selection.years.length > 0);

  for (const [index, selection] of request.selections.entries()) {
    const stream = metas[index]!;
    if (yearMode) {
      const years = selection.years && selection.years.length > 0 ? selection.years : [2026];
      for (const year of years) {
        const yearStart = `${year}-01-01T07:00:00.000Z`; // local midnight America/Denver (MST in January)
        const yearEnd = `${year + 1}-01-01T07:00:00.000Z`;
        const result = aggregateSeries(store, {
          streamId: stream.id,
          start: yearStart,
          end: yearEnd,
          basis: request.basis,
          interval: request.interval,
        });
        if (result.outcome === 'denied') return result;
        series.push(toCompareSeries(store, stream, request, result.value.buckets, year, bucketKeyWithinYear));
      }
      continue;
    }
    if (!request.start || !request.end) {
      return denial(422, 'MISSING_WINDOW', 'site comparison requires start and end (half-open, UTC instants)');
    }
    const result = aggregateSeries(store, {
      streamId: stream.id,
      start: request.start,
      end: request.end,
      basis: request.basis,
      interval: request.interval,
    });
    if (result.outcome === 'denied') return result;
    series.push(toCompareSeries(store, stream, request, result.value.buckets, null, (key) => key));
  }

  return {
    outcome: 'allowed',
    value: {
      interval: request.interval,
      basis: request.basis,
      commonPropertyId: first.observedPropertyId,
      commonUnitId: first.unitId,
      timeZone: first.timeZone,
      series,
    },
  };
}

function toCompareSeries(
  store: SeriesStore,
  stream: NonNullable<ReturnType<SeriesStore['streamById']>>,
  request: CompareRequest,
  buckets: ReadonlyArray<{ key: string; intervalStart: string; intervalEnd: string; meanValue: number | null; coverageFraction: number }>,
  year: number | null,
  rekey: (key: string) => string,
): CompareSeries {
  return {
    label:
      year === null
        ? `${stream.stationDisplayName} (${stream.id})`
        : `${stream.stationDisplayName} ${year} (${stream.id})`,
    streamId: stream.id,
    stationId: stream.stationId,
    stationDisplayName: stream.stationDisplayName,
    observedPropertyId: stream.observedPropertyId,
    unitId: stream.unitId,
    sourceLabel: `${stream.stationDisplayName} - ${stream.methodTypeId}, ${stream.cadenceMinutes >= 1440 ? `${Math.round(stream.cadenceMinutes / 1440)}-day` : `${stream.cadenceMinutes}-minute`} cadence`,
    methodTypeId: stream.methodTypeId,
    cadenceMinutes: stream.cadenceMinutes,
    basis: request.basis,
    year,
    buckets: buckets.map((bucket) => ({
      key: rekey(bucket.key),
      intervalStart: bucket.intervalStart,
      intervalEnd: bucket.intervalEnd,
      meanValue: bucket.meanValue,
      coverageFraction: bucket.coverageFraction,
    })),
    gaps: store.gapsForStream(stream.id).map((gap) => ({ id: gap.id, start: gap.start, end: gap.end, reason: gap.reason })),
  };
}
