/**
 * Deterministic annual/multi-site distribution report generation
 * (WD-025; FR-024; acceptance T-06/T-15).
 *
 * DESIGN CONTRACTS:
 *
 * - SAME NUMERICS AS THE CHART APIs: every daily flow/volume number is
 *   produced by the WD-008 aggregation domain (../../series/aggregate.ts,
 *   rectangle-right@1) via aggregateSeries; nothing here recomputes an
 *   integral, a mean or a coverage fraction. Reconciliation to the series
 *   surface is exact by construction (the golden suite asserts it).
 * - SAME GRANT GATE: the request is gated per system (checkReportScope,
 *   action generate-reports) and every included stream passes the WD-008
 *   per-stream read gate (readStreamGrant) - fail closed on the first denial.
 * - PROVENANCE (FR-024 "generation time and data version"): the extraction
 *   timestamp comes from an injected clock (never Date.now()); per-stream
 *   source revision labels come from the WD-011 revision store
 *   (which chain produced best-available); the data version is a sha256 over
 *   the canonical serialization of those chains, so ANY appended revision
 *   changes it even when values do not.
 * - NO DOUBLE COUNT: totals reuse the WD-018 governed accounting categories
 *   (summaries/totals.ts accountingCategory); categories are reported
 *   separately and never summed (combinedVolumeAcreFeet is null by contract).
 * - DETERMINISM: no clock reads, no randomness, stable iteration order
 *   (stations/streams/categories/notes all sorted or fixed-order); the
 *   content hash is sha256 over a canonical key-sorted serialization.
 *   Identical inputs + identical clock produce a byte-identical report.
 * - SUPERSESSION, NEVER REWRITE (technical specification, "Originals and
 *   corrections"): regeneration registers a NEW version; the prior report
 *   object is never mutated - the registry only records the supersession in
 *   derived wrapper entries. Report FINALIZATION/immutability is FR-029, a
 *   separate R2 task (see finalize.ts and README.md).
 */
import { createHash } from 'node:crypto';

import { POLICY_VERSION, type PolicyWorld } from '../../../../../packages/policy/src/index.ts';
import { aggregateSeries, CUBIC_FEET_PER_ACRE_FOOT, checkWindow } from '../../series/aggregate.ts';
import { grantAllowed, readStreamGrant } from '../../series/grantCheck.ts';
import type { SeriesStore } from '../../series/load.ts';
import { seriesStore } from '../../series/load.ts';
import type {
  AggregatedInterval,
  AggregationResult,
  DomainResult,
  EffectivePoint,
  SeasonName,
} from '../../series/types.ts';
import { AGGREGATION_METHOD } from '../../series/types.ts';
import { PROGRAM_TIME_ZONE, localMidnightInstant, seasonWindow } from '../../series/zone.ts';
import type { RevisionStore } from '../revisions/store.ts';
import { createRevisionStore } from '../revisions/store.ts';
import { stationsInScope, statusExclusion, summaryWorld, type SummaryStation, type SummaryStream } from '../../summaries/world.ts';
import { CATEGORY_LABELS, NO_DOUBLE_COUNT_POLICY, accountingCategory, type AccountingCategory } from '../../summaries/totals.ts';
import { checkReportScope } from './scope.ts';
import { reportWorld, systemNameOf, type ReportWorld } from './world.ts';
import {
  DEFAULT_INCLUDE,
  PERIOD_BASIS_RULES,
  REPORT_SCHEMA_VERSION,
  type CategoryStreamTotal,
  type CategoryTotalRow,
  type DailyFlowRow,
  type DailyNoteCode,
  type ExcludedSiteEntry,
  type ExcludedStreamEntry,
  type FormulaStatement,
  type GeneratedReport,
  type PeriodBasis,
  type ReportIncludeFlags,
  type ReportPeriod,
  type ReportRequest,
  type RevisedObservationLabel,
  type SiteSection,
  type StreamReportSection,
  type StreamRevisionProvenance,
  type StreamTotals,
} from './types.ts';

/** Reporting zone: the program zone per the technical specification. */
export const REPORT_TIME_ZONE = PROGRAM_TIME_ZONE;

/** Same category order the WD-018 totals surface uses (fixed presentation order). */
const CATEGORY_ORDER: readonly AccountingCategory[] = ['natural-channel-flow', 'canal-delivery', 'reservoir-release'];

const ROUNDING_POLICY =
  'derived values are stored at full precision; presentation rounds volumes to 3 decimals and percentages to whole numbers; every total is summed from unrounded values and never re-summed from rounded ones';

// ---------------------------------------------------------------------------
// Canonical serialization and hashing
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Period basis -> reporting window
// ---------------------------------------------------------------------------

export interface PeriodWindow {
  readonly basis: PeriodBasis;
  readonly year: number;
  /** UTC instants, half-open [start, end), local midnights in America/Denver. */
  readonly start: string;
  readonly end: string;
  readonly dateRule: string;
  readonly timeZone: string;
}

const BASIS_TO_SEASON: Readonly<Record<PeriodBasis, SeasonName>> = {
  'calendar-year': 'calendar-year',
  'water-year': 'water-year',
  'irrigation-season': 'irrigation',
};

/**
 * The reporting window of a period basis + year, from the SAME seasonWindow
 * date rules as the WD-008 seasonal aggregation (documented defaults pending
 * measurement-owner ratification). Flexible/custom periods are R2.
 */
export function periodWindow(period: ReportPeriod): PeriodWindow {
  const range = seasonWindow(BASIS_TO_SEASON[period.basis], period.year);
  const startMs = localMidnightInstant(range.start, REPORT_TIME_ZONE);
  const endMs = localMidnightInstant(range.end, REPORT_TIME_ZONE);
  return {
    basis: period.basis,
    year: period.year,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    dateRule: PERIOD_BASIS_RULES[period.basis].dateRule,
    timeZone: REPORT_TIME_ZONE,
  };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface ReportDeps {
  readonly store: SeriesStore;
  readonly revisions: RevisionStore;
  /** Overrides the fixture report world (derived worlds in tests). */
  readonly world?: PolicyWorld | undefined;
  /** Injected clock: the extraction timestamp, echoed verbatim. */
  readonly now: string;
}

/** Convenience wrapper over the shared fixture stores and report world. */
export function fixtureReportDeps(now: string): ReportDeps {
  return { store: seriesStore(), revisions: createRevisionStore(), now };
}

const DAILY_NOTE_ORDER: readonly DailyNoteCode[] = [
  'no-data',
  'declared-gap',
  'range-excluded',
  'null-frame',
  'estimated',
  'suspect-zero',
  'duplicate-timestamp',
  'below-selected-basis',
  'late-arrival',
];

function dailyRow(bucket: AggregatedInterval, pointsInDay: readonly EffectivePoint[]): DailyFlowRow {
  const codes: DailyNoteCode[] = [];
  const push = (code: DailyNoteCode) => {
    if (!codes.includes(code)) codes.push(code);
  };
  if (bucket.coverageFraction === 0) push('no-data');
  if (bucket.gaps.length > 0) push('declared-gap');
  if (bucket.excludedPointCount > 0) push('range-excluded');
  if (bucket.nullPointCount > 0) push('null-frame');
  if (bucket.estimatedSeconds > 0) push('estimated');
  if (pointsInDay.some((point) => point.flags.includes('suspect-zero'))) push('suspect-zero');
  if (pointsInDay.some((point) => point.flags.includes('duplicate-timestamp'))) push('duplicate-timestamp');
  if (pointsInDay.some((point) => point.flags.includes('below-selected-basis'))) push('below-selected-basis');
  if (pointsInDay.some((point) => point.flags.includes('late-arrival'))) push('late-arrival');
  return {
    key: bucket.key,
    volumeAcreFeet: bucket.volumeAcreFeet,
    meanValue: bucket.meanValue,
    coverageFraction: bucket.coverageFraction,
    estimatedProportion: bucket.estimatedProportion,
    noteCodes: DAILY_NOTE_ORDER.filter((code) => codes.includes(code)),
  };
}

function streamTotalsOf(buckets: readonly AggregatedInterval[]): StreamTotals {
  let volume = 0;
  let coveredSeconds = 0;
  let durationSeconds = 0;
  let estimatedSeconds = 0;
  let daysWithNoData = 0;
  for (const bucket of buckets) {
    volume += bucket.volumeAcreFeet ?? 0;
    coveredSeconds += bucket.coveredSeconds;
    durationSeconds += bucket.durationSeconds;
    estimatedSeconds += bucket.estimatedSeconds;
    if (bucket.coverageFraction === 0) daysWithNoData += 1;
  }
  return {
    volumeAcreFeet: volume,
    coveredSeconds,
    durationSeconds,
    coverageFraction: durationSeconds > 0 ? coveredSeconds / durationSeconds : 0,
    estimatedSeconds,
    estimatedProportion: coveredSeconds > 0 ? estimatedSeconds / coveredSeconds : 0,
    dayCount: buckets.length,
    daysWithNoData,
  };
}

function qualityNotesOf(
  store: SeriesStore,
  result: AggregationResult,
  windowStartMs: number,
  windowEndMs: number,
  include: ReportIncludeFlags,
): string[] {
  const notes: string[] = [];
  const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;
  const gaps = store.gapsForStream(result.streamId).filter((gap) => Date.parse(gap.end) > windowStartMs && Date.parse(gap.start) < windowEndMs);
  if (gaps.length > 0) {
    if (include.gapDetail) {
      for (const gap of gaps) {
        const hours = (Math.min(Date.parse(gap.end), windowEndMs) - Math.max(Date.parse(gap.start), windowStartMs)) / 3_600_000;
        notes.push(`declared gap ${gap.id} (${gap.reason}): ${gap.start} to ${gap.end}; ${hours.toFixed(1)} h inside the period; missing readings are never zero-filled`);
      }
    } else {
      notes.push(`declared gaps overlapping the period: ${gaps.length} (set include.gapDetail for per-gap rows)`);
    }
  }
  const excluded = result.buckets.reduce((sum, bucket) => sum + bucket.excludedPointCount, 0);
  if (excluded > 0) notes.push(`range-excluded readings: ${excluded} (kept with flags; outside means and volumes)`);
  const nulls = result.buckets.reduce((sum, bucket) => sum + bucket.nullPointCount, 0);
  if (nulls > 0) notes.push(`null frames: ${nulls} (reported-but-empty; unavailable, not zero)`);
  const suspectZeros = result.rawPoints.filter((point) => point.flags.includes('suspect-zero')).length;
  if (suspectZeros > 0) notes.push(`suspect zeros: ${suspectZeros} (reported 0.0: covered and flagged, never treated as missing)`);
  const duplicates = result.rawPoints.filter((point) => point.flags.includes('duplicate-timestamp')).length;
  if (duplicates > 0) notes.push(`duplicate-timestamp instants: ${duplicates} (normalized to the latest retransmission; superseded originals retained)`);
  const estimatedSeconds = result.buckets.reduce((sum, bucket) => sum + bucket.estimatedSeconds, 0);
  const coveredSeconds = result.buckets.reduce((sum, bucket) => sum + bucket.coveredSeconds, 0);
  if (estimatedSeconds > 0 && coveredSeconds > 0) {
    notes.push(`estimated covered seconds: ${estimatedSeconds} (${pct(estimatedSeconds / coveredSeconds)} of coverage)`);
  }
  const late = result.rawPoints.filter((point) => point.flags.includes('late-arrival')).length;
  if (late > 0) notes.push(`late arrivals: ${late} (received more than 6 h after observation)`);
  const belowBasis = result.rawPoints.filter((point) => point.flags.includes('below-selected-basis')).length;
  if (belowBasis > 0) notes.push(`below-selected-basis fallbacks: ${belowBasis} (raw value shown; no revision reached the ${result.basis} basis)`);
  return notes;
}

function coverageNotesOf(result: AggregationResult, totals: StreamTotals): string[] {
  const pct = Math.round(totals.coverageFraction * 100);
  return [
    `period coverage: ${totals.coveredSeconds} of ${totals.durationSeconds} s (${pct}%)`,
    `days with no usable data: ${totals.daysWithNoData} of ${totals.dayCount} (unavailable days carry null volume, never zero)`,
  ];
}

function formulaStatementsOf(basis: PeriodBasis): readonly FormulaStatement[] {
  return [
    {
      id: 'volume',
      statement: `daily volume (acre-feet) = sum over covered intervals of (rate in cfs x seconds) / ${CUBIC_FEET_PER_ACRE_FOOT}; every reading is a rate representative of [observedAt, observedAt + cadence) intersected with the next reading's instant and the local calendar day`,
      methodRef: AGGREGATION_METHOD,
    },
    {
      id: 'mean',
      statement: 'daily mean rate = integrated cubic feet / covered seconds (mean over the covered portion only; never mean x 24 h)',
      methodRef: AGGREGATION_METHOD,
    },
    {
      id: 'coverage',
      statement: 'coverage fraction = covered seconds / local day duration; a DST day lasts 82 800 s (spring forward) or 90 000 s (fall back), never a flat 86 400 s',
      methodRef: AGGREGATION_METHOD,
    },
    {
      id: 'missing',
      statement: 'a missing reading is not zero: declared gaps, null frames, absent cadence slots and range-excluded spikes leave their interval uncovered; a null volume means no covered data',
      methodRef: AGGREGATION_METHOD,
    },
    {
      id: 'estimated',
      statement: 'estimated proportion = estimated covered seconds / covered seconds (estimated value types and interpolate-qualified revisions)',
      methodRef: AGGREGATION_METHOD,
    },
    { id: 'no-double-count', statement: NO_DOUBLE_COUNT_POLICY, methodRef: 'accounting-categories@1 (summaries/totals.ts)' },
    { id: 'period', statement: `period basis "${basis}": ${PERIOD_BASIS_RULES[basis].dateRule}`, methodRef: 'period-basis@1 (series/zone.ts seasonWindow)' },
  ];
}

/** Provenance labels for one stream from the WD-011 store. */
function streamProvenance(
  store: SeriesStore,
  revisions: RevisionStore,
  result: AggregationResult,
  windowStartMs: number,
  windowEndMs: number,
): StreamRevisionProvenance {
  const usedByObservation = new Map<string, string>();
  for (const point of result.rawPoints) {
    if (point.revisionId !== null) usedByObservation.set(point.observationId, point.revisionId);
  }
  const labels: RevisedObservationLabel[] = [];
  for (const observation of store.observationsForStream(result.streamId)) {
    const at = Date.parse(observation.observedAt);
    if (at < windowStartMs || at >= windowEndMs) continue;
    const chain = revisions.loadChain(observation.logicalKey);
    if (chain.length === 0) continue;
    const head = chain[chain.length - 1]!;
    labels.push({
      observationId: observation.id,
      logicalKey: observation.logicalKey,
      chainVersion: chain.length,
      headRevisionId: head.id,
      headProcessingLevel: head.processingLevel,
      headRecordedAt: head.recordedAt,
      usedAtSelectedBasis: usedByObservation.get(observation.id) === head.id,
    });
  }
  const usedRevisionCount = result.rawPoints.filter((point) => point.revisionId !== null).length;
  const rawFallbackCount = result.rawPoints.filter((point) => point.flags.includes('below-selected-basis')).length;
  return {
    streamId: result.streamId,
    stationDisplayName: result.stationDisplayName,
    basis: result.basis,
    revisedObservations: labels,
    usedRevisionCount,
    rawFallbackCount,
  };
}

/** sha256 over the canonical serialization of the revision chains behind the report. */
function dataVersionOf(store: SeriesStore, revisions: RevisionStore, streams: readonly { streamId: string; startMs: number; endMs: number }[], world: ReportWorld): string {
  const chainsByStream = streams.map((stream) => ({
    streamId: stream.streamId,
    observations: store
      .observationsForStream(stream.streamId)
      .filter((observation) => {
        const at = Date.parse(observation.observedAt);
        return at >= stream.startMs && at < stream.endMs;
      })
      .map((observation) => ({
        logicalKey: observation.logicalKey,
        chain: revisions
          .loadChain(observation.logicalKey)
          .map((record) => ({ id: record.id, value: record.value, processingLevel: record.processingLevel, recordedAt: record.recordedAt, version: record.version })),
      })),
  }));
  return sha256Hex(canonicalize({ seed: world.seed, kind: 'report-data-version@1', streams: chainsByStream }));
}

function includedFlowStream(station: SummaryStation, stream: SummaryStream): boolean {
  return stream.observedPropertyId === 'discharge' && stream.unitId === 'cfs';
}

/**
 * Generate one report. PURE: identical deps (fixtures + clock) and request
 * produce a byte-identical result; the extraction timestamp is deps.now.
 * Actor identity is the server-resolved principal id (null = anonymous).
 */
export function generateReport(deps: ReportDeps, request: ReportRequest, actorId: string | null): DomainResult<GeneratedReport> {
  const world = deps.world ?? reportWorld().policyWorld;
  const scope = checkReportScope(world, actorId, request.systemId, deps.now);
  if (scope.outcome === 'denied') return scope;

  if (!Number.isInteger(request.period.year) || request.period.year < 1900 || request.period.year > 2100) {
    return { outcome: 'denied', status: 422, code: 'INVALID_PERIOD', message: 'period.year must be an integer between 1900 and 2100' };
  }
  const window = periodWindow(request.period);
  const bounds = checkWindow({ start: window.start, end: window.end });
  if (bounds.outcome === 'denied') return bounds;
  const startMs = bounds.value.startMs;
  const endMs = bounds.value.endMs;

  const summary = summaryWorld();
  const include: ReportIncludeFlags = { ...DEFAULT_INCLUDE, ...request.include };
  let stations = stationsInScope(summary, request.systemId);
  if (request.siteIds !== null) {
    const systemIds = new Set(stations.map((station) => station.id));
    const wanted = [...new Set(request.siteIds)].sort();
    for (const siteId of wanted) {
      if (!systemIds.has(siteId)) {
        return { outcome: 'denied', status: 422, code: 'SITE_NOT_IN_SYSTEM', message: `site "${siteId}" is not part of system "${request.systemId}"` };
      }
    }
    const wantedSet = new Set(wanted);
    stations = stations.filter((station) => wantedSet.has(station.id));
  }

  const sites: SiteSection[] = [];
  const excludedSites: ExcludedSiteEntry[] = [];
  const totalsExcluded: ExcludedStreamEntry[] = [];
  const includedStreams: { station: SummaryStation; stream: SummaryStream; result: AggregationResult; totals: StreamTotals; projection: 'public' | 'full' }[] = [];

  for (const station of stations) {
    const statusExcluded = statusExclusion(station.status);
    if (statusExcluded !== null) {
      excludedSites.push({
        stationId: station.id,
        stationDisplayName: station.displayName,
        reason: `station ${statusExcluded} (measurement lifecycle closed; excluded from reporting)`,
      });
      continue;
    }
    const streams: StreamReportSection[] = [];
    const excludedStreams: ExcludedStreamEntry[] = [];
    for (const stream of [...station.streams].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const gate = readStreamGrant(deps.store, actorId, stream.id, deps.now);
      if (!grantAllowed(gate)) {
        // Fail closed: a system-level grant never bypasses the per-stream gate.
        return { outcome: 'denied', status: gate.status, code: gate.code, message: gate.message, ...(gate.policyReason !== undefined ? { policyReason: gate.policyReason } : {}) };
      }
      if (!includedFlowStream(station, stream)) {
        const reason = `dimension mismatch: reports aggregate discharge in cfs; ${stream.observedPropertyId} in ${stream.unitId} is a different dimension`;
        excludedStreams.push({ streamId: stream.id, observedPropertyId: stream.observedPropertyId, unitId: stream.unitId, reason });
        totalsExcluded.push({ streamId: stream.id, observedPropertyId: stream.observedPropertyId, unitId: stream.unitId, reason });
        continue;
      }
      const result = aggregateSeries(deps.store, {
        streamId: stream.id,
        start: window.start,
        end: window.end,
        basis: request.processingBasis,
        interval: 'daily',
      });
      if (result.outcome === 'denied') return result;
      const totals = streamTotalsOf(result.value.buckets);
      const category = accountingCategory(station, stream);
      if (category === null) {
        const reason = `no governed accounting category for site type ${station.siteTypeId} / water source ${station.waterSourceTypeId}`;
        totalsExcluded.push({ streamId: stream.id, observedPropertyId: stream.observedPropertyId, unitId: stream.unitId, reason });
      }
      const daily = include.dailyTable
        ? result.value.buckets.map((bucket) =>
            dailyRow(
              bucket,
              result.value.rawPoints.filter((point) => {
                const at = Date.parse(point.observedAt);
                return at >= Date.parse(bucket.intervalStart) && at < Date.parse(bucket.intervalEnd);
              }),
            ),
          )
        : [];
      streams.push({
        streamId: stream.id,
        stationId: station.id,
        observedPropertyId: stream.observedPropertyId,
        unitId: stream.unitId,
        cadenceMinutes: result.value.cadenceMinutes,
        projection: gate.projection,
        method: result.value.method,
        daily,
        totals,
        qualityNotes: include.qualityNotes ? qualityNotesOf(deps.store, result.value, startMs, endMs, include) : [],
        coverageNotes: coverageNotesOf(result.value, totals),
      });
      includedStreams.push({ station, stream, result: result.value, totals, projection: gate.projection });
    }
    sites.push({
      stationId: station.id,
      stationDisplayName: station.displayName,
      systemId: station.systemId,
      status: station.status,
      streams,
      excludedStreams,
    });
  }

  // Category-separated system totals (never summed across categories).
  const categories: CategoryTotalRow[] = CATEGORY_ORDER.filter((category) => includedStreams.some((entry) => accountingCategory(entry.station, entry.stream) === category)).map((category) => {
    const entries = includedStreams.filter((entry) => accountingCategory(entry.station, entry.stream) === category);
    const volume = entries.reduce((sum, entry) => sum + entry.totals.volumeAcreFeet, 0);
    const covered = entries.reduce((sum, entry) => sum + entry.totals.coveredSeconds, 0);
    const duration = entries.reduce((sum, entry) => sum + entry.totals.durationSeconds, 0);
    const estimated = entries.reduce((sum, entry) => sum + entry.totals.estimatedSeconds, 0);
    const perStream: CategoryStreamTotal[] = entries.map((entry) => ({
      streamId: entry.stream.id,
      volumeAcreFeet: entry.totals.volumeAcreFeet,
      coverageFraction: entry.totals.coverageFraction,
      estimatedProportion: entry.totals.estimatedProportion,
    }));
    return {
      category,
      label: CATEGORY_LABELS[category],
      streamIds: entries.map((entry) => entry.stream.id),
      volumeAcreFeet: volume,
      volumeUnit: 'acre-feet' as const,
      coveredSeconds: covered,
      durationSeconds: duration,
      coverageFraction: duration > 0 ? covered / duration : 0,
      estimatedSeconds: estimated,
      estimatedProportion: covered > 0 ? estimated / covered : 0,
      streams: perStream,
    };
  });

  const provenanceStreams = includedStreams
    .map((entry) => streamProvenance(deps.store, deps.revisions, entry.result, startMs, endMs))
    .sort((a, b) => (a.streamId < b.streamId ? -1 : 1));
  const dataVersion = dataVersionOf(
    deps.store,
    deps.revisions,
    includedStreams.map((entry) => ({ streamId: entry.stream.id, startMs, endMs })),
    reportWorld(),
  );

  const sections: GeneratedReport['sections'] = {
    sites,
    excludedSites,
    totals: {
      method: AGGREGATION_METHOD,
      noDoubleCountPolicy: NO_DOUBLE_COUNT_POLICY,
      combinedVolumeAcreFeet: null,
      categories,
      excludedStreams: totalsExcluded,
    },
    formulas: {
      methodVersion: AGGREGATION_METHOD,
      policyVersion: POLICY_VERSION,
      roundingPolicy: ROUNDING_POLICY,
      statements: formulaStatementsOf(request.period.basis),
    },
    provenance: {
      extractionTime: deps.now,
      methodVersion: AGGREGATION_METHOD,
      dataVersion,
      fixtureSeed: reportWorld().seed,
      streams: provenanceStreams,
    },
  };

  // Content hash: everything except reportId/version/supersedes (the hash
  // itself), so supersession bookkeeping never changes content identity.
  const preimage = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    system: { id: request.systemId },
    requestedBy: actorId,
    period: { basis: window.basis, year: window.year, start: window.start, end: window.end },
    processingBasis: request.processingBasis,
    include,
    extractionTime: deps.now,
    sections,
  };
  const contentHash = sha256Hex(canonicalize(preimage));
  return {
    outcome: 'allowed',
    value: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      reportId: `rep-${contentHash.slice(0, 12)}`,
      version: 1,
      supersedes: null,
      system: { id: request.systemId, name: systemNameOf(reportWorld(), request.systemId) ?? request.systemId },
      requestedBy: actorId ?? 'anonymous',
      period: { basis: window.basis, year: window.year, start: window.start, end: window.end, dateRule: window.dateRule, timeZone: window.timeZone },
      processingBasis: request.processingBasis,
      include,
      extractionTime: deps.now,
      sections,
      contentHash,
    },
  };
}

// ---------------------------------------------------------------------------
// Registry: supersession bookkeeping (new versions; prior reports never mutate)
// ---------------------------------------------------------------------------

/** Stable identity of a report series: same system/period/basis/include flags. */
export function reportKey(request: ReportRequest): string {
  return canonicalize({
    systemId: request.systemId,
    period: request.period,
    processingBasis: request.processingBasis,
    include: { ...DEFAULT_INCLUDE, ...request.include },
  });
}

export interface RegistryEntry {
  /** The report-series key (reportKey) this version belongs to. */
  readonly key: string;
  readonly report: GeneratedReport;
  /** Report id of the version that superseded this one, once any did. */
  readonly supersededBy: string | null;
}

export interface RegisterResult {
  readonly entry: RegistryEntry;
  /** The previously newest entry of the same key when a supersession happened. */
  readonly prior: RegistryEntry | null;
  /** True when identical content was re-registered: the stored version replays, nothing is superseded. */
  readonly replayed: boolean;
}

/**
 * In-memory registry of generated (NOT finalized) report versions. Registering
 * a report whose content differs from the newest version of the same key
 * creates version N+1 with `supersedes` pointing at the prior report id; the
 * PRIOR REPORT OBJECT IS NEVER MUTATED - only the registry's wrapper entry is
 * replaced by a derived copy carrying `supersededBy`. Registering identical
 * content replays the stored version (idempotent regeneration).
 */
export class ReportRegistry {
  private readonly entries: RegistryEntry[] = [];

  register(report: GeneratedReport, key: string): RegisterResult {
    const newest = [...this.entries].reverse().find((entry) => entry.key === key) ?? null;
    if (newest && newest.report.reportId === report.reportId) {
      return { entry: newest, prior: null, replayed: true };
    }
    const versioned: GeneratedReport = Object.freeze({
      ...report,
      version: newest ? newest.report.version + 1 : report.version,
      supersedes: newest ? newest.report.reportId : null,
    });
    const entry: RegistryEntry = Object.freeze({ key, report: versioned, supersededBy: null });
    this.entries.push(entry);
    let prior: RegistryEntry | null = null;
    if (newest) {
      prior = Object.freeze({ key, report: newest.report, supersededBy: versioned.reportId });
      const index = this.entries.lastIndexOf(newest);
      this.entries[index] = prior;
    }
    return { entry, prior, replayed: false };
  }

  list(): readonly RegistryEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  get(reportId: string): RegistryEntry | null {
    return this.entries.find((entry) => entry.report.reportId === reportId) ?? null;
  }
}
