/**
 * Space and time totals for a selected area, period and processing basis
 * (WD-018; FR-061), reconciled EXACTLY to the WD-008 aggregation semantics:
 * every category total is the sum of the underlying WD-008 daily buckets
 * produced by ../series/aggregate.ts (rectangle-right interval integration,
 * missing-never-zero coverage fractions, DST-correct local windows in
 * America/Denver). Nothing is recomputed or approximated here.
 *
 * NO-DOUBLE-COUNT POLICY (technical specification, "Numerical and temporal
 * rules": "Do not double-count upstream flow, downstream flow and canal
 * delivery in policy totals. A basin summary needs defined accounting
 * boundaries and distinct measured/estimated/computed categories"):
 *
 * - Every candidate stream is placed in ONE accounting category derived from
 *   governed station fields: water-source type 'surface-storage-release' ->
 *   reservoir-release; site type 'natural-channel' -> natural-channel-flow;
 *   site type 'flume'/'weir' -> canal-delivery. Anything without a governed
 *   category is excluded with its reason.
 * - Totals are reported PER CATEGORY and are NEVER summed across categories
 *   (combinedVolumeAcreFeet is null by contract): the same water can be
 *   measured at an upstream gauge, a downstream gauge and a canal delivery.
 *   The fixture world exercises exactly this trap: the two adjacent Hyrum
 *   stations share a display name and measure neighboring points - governed
 *   water-source/site-type fields place them in different categories
 *   (canal-delivery vs reservoir-release), and the public view additionally
 *   excludes the restricted owner stream.
 * - Only discharge in cfs joins flow totals; stage (ft) and equipment
 *   voltage (V) are different dimensions and are excluded with reasons
 *   (FR-061: never mix quantities with incompatible units).
 * - Totals cover the ENCLOSING local calendar windows of the request (the
 *   WD-008 effective bounds, returned), and volumes are sums over COVERED
 *   intervals only - a missing reading contributes no volume and is never
 *   zero-filled; the coverage fraction beside every total shows the holes.
 */
import { aggregateSeries, checkWindow } from '../series/aggregate.ts';
import type { SeriesStore } from '../series/load.ts';
import { seriesStore } from '../series/load.ts';
import { AGGREGATION_METHOD, type DomainResult, type ProcessingBasis } from '../series/types.ts';
import { stationsInScope, statusExclusion, summaryWorld, systemNameOf, type SummaryStation, type SummaryStream, type SummaryWorld } from './world.ts';

/** 'statewide' or one distribution system id. */
export type AreaSelection = 'statewide' | { readonly systemId: string };

export interface TotalsRequest {
  readonly area: AreaSelection;
  /** UTC instants; half-open [start, end) bounded by the WD-008 window limits. */
  readonly start: string;
  readonly end: string;
  readonly basis: ProcessingBasis;
  /** 'public' (default) keeps only public streams - the anonymous overview view. */
  readonly visibility?: 'public' | 'all';
}

export type AccountingCategory = 'natural-channel-flow' | 'canal-delivery' | 'reservoir-release';

export const CATEGORY_LABELS: Readonly<Record<AccountingCategory, string>> = {
  'natural-channel-flow': 'Natural channel flow (mainstem gauges)',
  'canal-delivery': 'Canal and diversion delivery',
  'reservoir-release': 'Reservoir release',
};

export const NO_DOUBLE_COUNT_POLICY =
  'Totals are reported per accounting category and are never summed across categories: the same water can be measured at an upstream gauge, a downstream gauge and a canal delivery. Categories come from governed station fields (water source, site type); restricted streams are excluded from public totals; volumes cover measured intervals only and missing readings are never zero-filled.';

export interface StreamAccountingEntry {
  readonly streamId: string;
  readonly stationId: string;
  readonly stationDisplayName: string;
  readonly systemId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  readonly category: AccountingCategory | null;
  readonly included: boolean;
  readonly exclusionReason: string | null;
  readonly volumeAcreFeet: number;
  readonly coveredSeconds: number;
  readonly durationSeconds: number;
  readonly coverageFraction: number;
  readonly estimatedSeconds: number;
}

export interface CategoryDailyValue {
  readonly key: string;
  readonly volumeAcreFeet: number | null;
  readonly coverageFraction: number;
}

export interface CategoryTotal {
  readonly category: AccountingCategory;
  readonly label: string;
  readonly streamIds: readonly string[];
  readonly volumeAcreFeet: number;
  readonly volumeUnit: 'acre-feet';
  readonly coveredSeconds: number;
  readonly durationSeconds: number;
  readonly coverageFraction: number;
  readonly estimatedSeconds: number;
  readonly estimatedProportion: number;
  readonly daily: readonly CategoryDailyValue[];
}

export interface AreaTotals {
  readonly areaId: string;
  readonly areaName: string;
  readonly basis: ProcessingBasis;
  readonly interval: 'daily';
  readonly requestedStart: string;
  readonly requestedEnd: string;
  /** Enclosing local calendar windows of the request (the WD-008 effective bounds). */
  readonly effectiveStart: string;
  readonly effectiveEnd: string;
  readonly timeZone: string;
  readonly method: string;
  readonly noDoubleCountPolicy: string;
  /** Always null by policy: cross-category sums can double-count the same water. */
  readonly combinedVolumeAcreFeet: null;
  readonly categories: readonly CategoryTotal[];
  readonly streams: readonly StreamAccountingEntry[];
}

const PROGRAM_TIME_ZONE = 'America/Denver';

/** Accounting category from governed station fields; null = no governed category. */
export function accountingCategory(station: SummaryStation, stream: SummaryStream): AccountingCategory | null {
  if (station.waterSourceTypeId === 'surface-storage-release') return 'reservoir-release';
  if (station.siteTypeId === 'natural-channel') return 'natural-channel-flow';
  if (station.siteTypeId === 'flume' || station.siteTypeId === 'weir') return 'canal-delivery';
  return null;
}

interface Inclusion {
  readonly included: boolean;
  readonly category: AccountingCategory | null;
  readonly reason: string | null;
}

function inclusionOf(station: SummaryStation, stream: SummaryStream, visibility: 'public' | 'all'): Inclusion {
  const status = statusExclusion(station.status);
  if (status !== null) return { included: false, category: null, reason: `station ${status}` };
  if (visibility === 'public' && stream.visibility !== 'public') {
    return { included: false, category: null, reason: `stream not in the public projection (${stream.visibility})` };
  }
  if (stream.observedPropertyId !== 'discharge' || stream.unitId !== 'cfs') {
    return { included: false, category: null, reason: `dimension mismatch: flow totals aggregate discharge in cfs; ${stream.observedPropertyId} in ${stream.unitId} is a different dimension` };
  }
  const category = accountingCategory(station, stream);
  if (category === null) {
    return { included: false, category: null, reason: `no governed accounting category for site type ${station.siteTypeId} / water source ${station.waterSourceTypeId}` };
  }
  return { included: true, category, reason: null };
}

const CATEGORY_ORDER: readonly AccountingCategory[] = ['natural-channel-flow', 'canal-delivery', 'reservoir-release'];

/**
 * Summarize one area/period/basis. Reuses the WD-008 aggregation exactly:
 * per included stream the daily buckets of aggregateSeries are summed (in
 * bucket order), so reconciliation with the underlying series is exact by
 * construction - totals.test.ts asserts the sums equal the bucket values.
 */
export function areaTotals(store: SeriesStore, world: SummaryWorld, request: TotalsRequest): DomainResult<AreaTotals> {
  const window = checkWindow({ start: request.start, end: request.end });
  if (window.outcome === 'denied') return window;

  const visibility = request.visibility ?? 'public';
  const systemId = request.area === 'statewide' ? undefined : request.area.systemId;
  const stations = stationsInScope(world, systemId);

  const streams: StreamAccountingEntry[] = [];
  const categoryStreams = new Map<AccountingCategory, { streamId: string; volume: number; covered: number; duration: number; estimated: number }[]>();
  const dailyByCategory = new Map<AccountingCategory, Map<string, { volume: number | null; covered: number; duration: number }>>();
  let effectiveStartMs: number | null = null;
  let effectiveEndMs: number | null = null;

  for (const station of [...stations].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (const stream of [...station.streams].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const inclusion = inclusionOf(station, stream, visibility);
      if (!inclusion.included || inclusion.category === null) {
        streams.push({
          streamId: stream.id,
          stationId: station.id,
          stationDisplayName: station.displayName,
          systemId: station.systemId,
          observedPropertyId: stream.observedPropertyId,
          unitId: stream.unitId,
          category: null,
          included: false,
          exclusionReason: inclusion.reason,
          volumeAcreFeet: 0,
          coveredSeconds: 0,
          durationSeconds: 0,
          coverageFraction: 0,
          estimatedSeconds: 0,
        });
        continue;
      }
      const result = aggregateSeries(store, {
        streamId: stream.id,
        start: request.start,
        end: request.end,
        basis: request.basis,
        interval: 'daily',
      });
      if (result.outcome === 'denied') return result;
      let volume = 0;
      let coveredSeconds = 0;
      let durationSeconds = 0;
      let estimatedSeconds = 0;
      const daily = dailyByCategory.get(inclusion.category) ?? new Map<string, { volume: number | null; covered: number; duration: number }>();
      for (const bucket of result.value.buckets) {
        // Missing is missing: an uncovered bucket contributes no volume (null
        // volume stays null in the daily table; the running total adds 0).
        volume += bucket.volumeAcreFeet ?? 0;
        coveredSeconds += bucket.coveredSeconds;
        durationSeconds += bucket.durationSeconds;
        estimatedSeconds += bucket.estimatedSeconds;
        const entry = daily.get(bucket.key) ?? { volume: null as number | null, covered: 0, duration: 0 };
        daily.set(bucket.key, {
          volume: entry.volume === null ? bucket.volumeAcreFeet : entry.volume + (bucket.volumeAcreFeet ?? 0),
          covered: entry.covered + bucket.coveredSeconds,
          duration: entry.duration + bucket.durationSeconds,
        });
      }
      dailyByCategory.set(inclusion.category, daily);
      effectiveStartMs = effectiveStartMs === null ? Date.parse(result.value.effectiveStart) : Math.min(effectiveStartMs, Date.parse(result.value.effectiveStart));
      effectiveEndMs = effectiveEndMs === null ? Date.parse(result.value.effectiveEnd) : Math.max(effectiveEndMs, Date.parse(result.value.effectiveEnd));

      const category = categoryStreams.get(inclusion.category) ?? [];
      category.push({ streamId: stream.id, volume, covered: coveredSeconds, duration: durationSeconds, estimated: estimatedSeconds });
      categoryStreams.set(inclusion.category, category);

      streams.push({
        streamId: stream.id,
        stationId: station.id,
        stationDisplayName: station.displayName,
        systemId: station.systemId,
        observedPropertyId: stream.observedPropertyId,
        unitId: stream.unitId,
        category: inclusion.category,
        included: true,
        exclusionReason: null,
        volumeAcreFeet: volume,
        coveredSeconds,
        durationSeconds,
        coverageFraction: durationSeconds > 0 ? coveredSeconds / durationSeconds : 0,
        estimatedSeconds,
      });
    }
  }

  const categories: CategoryTotal[] = CATEGORY_ORDER.filter((category) => categoryStreams.has(category)).map((category) => {
    const entries = categoryStreams.get(category)!;
    const volume = entries.reduce((sum, entry) => sum + entry.volume, 0);
    const covered = entries.reduce((sum, entry) => sum + entry.covered, 0);
    const duration = entries.reduce((sum, entry) => sum + entry.duration, 0);
    const estimated = entries.reduce((sum, entry) => sum + entry.estimated, 0);
    const dailyMap = dailyByCategory.get(category)!;
    const daily = [...dailyMap.keys()].sort().map((key) => {
      const entry = dailyMap.get(key)!;
      return {
        key,
        volumeAcreFeet: entry.volume,
        coverageFraction: entry.duration > 0 ? entry.covered / entry.duration : 0,
      };
    });
    return {
      category,
      label: CATEGORY_LABELS[category],
      streamIds: entries.map((entry) => entry.streamId),
      volumeAcreFeet: volume,
      volumeUnit: 'acre-feet' as const,
      coveredSeconds: covered,
      durationSeconds: duration,
      coverageFraction: duration > 0 ? covered / duration : 0,
      estimatedSeconds: estimated,
      estimatedProportion: covered > 0 ? estimated / covered : 0,
      daily,
    };
  });

  return {
    outcome: 'allowed',
    value: {
      areaId: request.area === 'statewide' ? 'statewide' : request.area.systemId,
      areaName: request.area === 'statewide' ? 'Statewide (all systems)' : systemNameOf(world, request.area.systemId) ?? request.area.systemId,
      basis: request.basis,
      interval: 'daily',
      requestedStart: request.start,
      requestedEnd: request.end,
      effectiveStart: effectiveStartMs === null ? request.start : new Date(effectiveStartMs).toISOString(),
      effectiveEnd: effectiveEndMs === null ? request.end : new Date(effectiveEndMs).toISOString(),
      timeZone: PROGRAM_TIME_ZONE,
      method: AGGREGATION_METHOD,
      noDoubleCountPolicy: NO_DOUBLE_COUNT_POLICY,
      combinedVolumeAcreFeet: null,
      categories,
      streams,
    },
  };
}

/** Convenience wrapper over the shared fixture store and world. */
export function fixtureAreaTotals(request: TotalsRequest): DomainResult<AreaTotals> {
  return areaTotals(seriesStore(), summaryWorld(), request);
}
