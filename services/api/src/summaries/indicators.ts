/**
 * Statewide and per-system policy indicators (WD-018; FR-058, FR-059).
 *
 * Every indicator is SELF-DESCRIBING: it carries its label, numerator,
 * denominator, unit, period (half-open [start, end), explicit), asOf instant
 * and the exclusions applied to reach its denominator, so a public overview
 * never shows a bare percentage (FR-058: "telemetry and reviewed-data
 * indicators state numerator, denominator, period and update time, with
 * output measures distinguished from outcomes"; FR-059: "an indicator
 * distinguishes measured, estimated and unknown source classifications,
 * reports its denominator and period, and reconciles to the selected
 * authorized source records without presenting old audit percentages as live
 * results").
 *
 * Status rules: only ACTIVE stations join a denominator; inactive, proposed
 * and unknown-status stations are excluded with their ids listed. A zero
 * denominator yields fraction null (never a fabricated 0/0). Unknown or
 * unclassifiable readings form a DISTINCT 'unknown' bucket, never folded
 * into measured or estimated.
 *
 * Determinism: pure functions of the frozen fixture world and the explicit
 * options; the default asOf is the fixture fixed clock (never Date.now()).
 */
import type { ObservationRow, ProcessingBasis, RevisionRow } from '../series/types.ts';
import { observationWindow, stationsInScope, statusExclusion, systemNameOf, type SummaryStation, type SummaryWorld } from './world.ts';

/** Versioned indicator method identity (every derived indicator carries its method). */
export const INDICATOR_METHOD = 'station-and-record-rules@1' as const;

/** Default freshness window for "current data": an observation within 24 h before asOf. */
export const DEFAULT_FRESHNESS_HOURS = 24;

const MATURITY: Readonly<Record<ProcessingBasis, number>> = {
  raw: 0,
  provisional: 1,
  reviewed: 2,
  'best-available': 3,
};

export type IndicatorId = 'telemetry-coverage' | 'reviewed-data-coverage' | 'measured-vs-estimated';

/** FR-058: output measures (program work) are distinguished from outcome context. */
export type MeasureKind = 'output' | 'outcome-context';

export interface IndicatorPeriod {
  /** Half-open [start, end). */
  readonly start: string;
  readonly end: string;
  readonly description: string;
}

export interface IndicatorExclusion {
  readonly reason: string;
  readonly count: number;
  readonly ids: readonly string[];
}

export interface IndicatorScope {
  readonly kind: 'statewide' | 'system';
  readonly systemId: string | null;
  readonly systemName: string | null;
}

export interface Indicator {
  readonly id: IndicatorId;
  readonly label: string;
  readonly scope: IndicatorScope;
  readonly numerator: number;
  readonly denominator: number;
  /** numerator/denominator; null when the denominator is zero (never 0/0). */
  readonly fraction: number | null;
  readonly unit: string;
  readonly period: IndicatorPeriod;
  readonly asOf: string;
  readonly measureKind: MeasureKind;
  readonly method: string;
  readonly exclusions: readonly IndicatorExclusion[];
}

export type SourceClassification = 'measured' | 'estimated' | 'unknown';

/** Each classification bucket is itself a self-describing indicator (FR-059). */
export interface ClassificationBucket {
  readonly classification: SourceClassification;
  readonly label: string;
  readonly numerator: number;
  readonly denominator: number;
  readonly fraction: number | null;
  readonly unit: string;
  readonly period: IndicatorPeriod;
  readonly asOf: string;
}

export interface MeasuredVersusEstimatedIndicator extends Indicator {
  readonly id: 'measured-vs-estimated';
  readonly basis: ProcessingBasis;
  readonly buckets: readonly ClassificationBucket[];
}

export interface SummaryIndicatorSet {
  readonly scope: IndicatorScope;
  readonly telemetry: Indicator;
  readonly reviewed: Indicator;
  readonly measuredVersusEstimated: MeasuredVersusEstimatedIndicator;
}

// ---------------------------------------------------------------------------
// Record normalization (mirrors ../series/aggregate.ts effectivePoints)
// ---------------------------------------------------------------------------

export interface NormalizedRecord {
  readonly observationId: string;
  readonly observedAt: string;
  readonly receivedAt: string;
  /** Effective value at the selected basis (null only for a null frame). */
  readonly value: number | null;
  readonly valueType: string;
  /** Effective estimated flag at the selected basis (valueType or interpolate qualifier). */
  readonly estimated: boolean;
  /** The revision chain reached the governed 'reviewed' level (a best-available correction alone does not). */
  readonly reviewed: boolean;
  readonly collapsedDuplicateIds: readonly string[];
}

function sortRows(rows: readonly ObservationRow[]): ObservationRow[] {
  return [...rows].sort((a, b) => {
    if (a.streamId !== b.streamId) return a.streamId < b.streamId ? -1 : 1;
    const at = Date.parse(a.observedAt) - Date.parse(b.observedAt);
    if (at !== 0) return at;
    const rt = Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
    if (rt !== 0) return rt;
    return a.sourceEventId < b.sourceEventId ? -1 : 1; // total order even for identical receipts
  });
}

function selectRevision(chain: readonly RevisionRow[], basis: ProcessingBasis): RevisionRow | null {
  if (basis === 'best-available') return chain[chain.length - 1] ?? null;
  return [...chain].reverse().find((rev) => MATURITY[rev.processingLevel] >= MATURITY[basis]) ?? null;
}

/**
 * Normalize scoped observation rows to one record per reported instant
 * (duplicate timestamps collapse to the latest-received retransmission, the
 * superseded ids are retained) with the effective value at `basis` and the
 * reviewed-chain fact. Window is half-open [startMs, endMs). Duplicates are
 * grouped per STREAM and instant - two streams reporting at the same instant
 * are different readings, never duplicates of each other.
 */
export function normalizeRecords(
  rows: readonly ObservationRow[],
  revisions: readonly RevisionRow[],
  basis: ProcessingBasis,
  startMs: number,
  endMs: number,
): NormalizedRecord[] {
  const byTarget = new Map<string, RevisionRow[]>();
  for (const rev of [...revisions].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || (a.id < b.id ? -1 : 1))) {
    const chain = byTarget.get(rev.targetObservationId);
    if (chain) chain.push(rev);
    else byTarget.set(rev.targetObservationId, [rev]);
  }

  const inWindow = sortRows(rows.filter((row) => {
    const at = Date.parse(row.observedAt);
    return at >= startMs && at < endMs;
  }));

  const records: NormalizedRecord[] = [];
  let i = 0;
  while (i < inWindow.length) {
    const streamId = inWindow[i]!.streamId;
    const instant = inWindow[i]!.observedAt;
    let j = i + 1;
    while (j < inWindow.length && inWindow[j]!.streamId === streamId && inWindow[j]!.observedAt === instant) j += 1;
    const chosen = inWindow[j - 1]!; // latest received wins (a retransmission supersedes)
    const chain = byTarget.get(chosen.id) ?? [];
    let value = chosen.value;
    let selected: RevisionRow | null = null;
    if (basis !== 'raw' && chain.length > 0) {
      selected = selectRevision(chain, basis);
      if (selected) value = selected.value; // else: below-selected-basis fallback keeps the raw value
    }
    const estimated =
      selected === null
        ? chosen.valueType === 'estimated' // raw or below-basis fallback: the raw estimate flag only
        : chosen.valueType === 'estimated' || selected.qualifierIds.includes('interpolate');
    records.push({
      observationId: chosen.id,
      observedAt: chosen.observedAt,
      receivedAt: chosen.receivedAt,
      value,
      valueType: chosen.valueType,
      estimated,
      reviewed: chain.some((rev) => rev.processingLevel === 'reviewed'),
      collapsedDuplicateIds: inWindow.slice(i, j - 1).map((row) => row.id),
    });
    i = j;
  }
  return records;
}

/**
 * Classify one normalized record (FR-059): observed source values are
 * 'measured', flagged estimates are 'estimated', and everything that cannot
 * be classified - a reported-but-empty null frame, or a value type outside
 * the governed {observed, estimated} vocabulary - is the DISTINCT 'unknown'
 * bucket, never folded into measured or estimated. Range-excluded spikes
 * stay classified by their source (a measured spike is still measured).
 */
export function classifyRecord(record: NormalizedRecord): SourceClassification {
  if (record.value === null) return 'unknown';
  if (record.estimated) return 'estimated';
  if (record.valueType === 'observed') return 'measured';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Scope plumbing
// ---------------------------------------------------------------------------

function scopeOf(world: SummaryWorld, systemId?: string): IndicatorScope {
  return {
    kind: systemId === undefined ? 'statewide' : 'system',
    systemId: systemId ?? null,
    systemName: systemId === undefined ? null : systemNameOf(world, systemId),
  };
}

interface ScopedRows {
  readonly stations: readonly SummaryStation[];
  readonly rows: readonly ObservationRow[];
  readonly excludedRows: readonly { reason: string; status: string; ids: readonly string[]; rowCount: number }[];
  readonly supersededDuplicateIds: readonly string[];
}

/** Active-station status rule applied to the observation rows. */
function scopedActiveRows(world: SummaryWorld, systemId: string | undefined, startMs: number, endMs: number): ScopedRows {
  const stations = stationsInScope(world, systemId);
  const activeStreamIds = new Set<string>();
  const inactive: string[] = [];
  const proposed: string[] = [];
  const unknownStatus: string[] = [];
  for (const station of stations) {
    const exclusion = statusExclusion(station.status);
    if (exclusion === null) {
      for (const stream of station.streams) activeStreamIds.add(stream.id);
    } else if (exclusion === 'inactive') inactive.push(station.id);
    else if (exclusion === 'proposed') proposed.push(station.id);
    else unknownStatus.push(station.id);
  }

  const inWindow = sortRows(
    world.observations.filter((row) => {
      const at = Date.parse(row.observedAt);
      return at >= startMs && at < endMs;
    }),
  );
  const rows: ObservationRow[] = [];
  const superseded: string[] = [];
  let i = 0;
  // Duplicates collapse per STREAM and instant (a retransmission supersedes;
  // two streams reporting at the same instant are different readings).
  while (i < inWindow.length) {
    const streamId = inWindow[i]!.streamId;
    const instant = inWindow[i]!.observedAt;
    let j = i + 1;
    while (j < inWindow.length && inWindow[j]!.streamId === streamId && inWindow[j]!.observedAt === instant) j += 1;
    for (let k = i; k < j; k += 1) {
      const row = inWindow[k]!;
      if (!activeStreamIds.has(row.streamId)) continue;
      if (k === j - 1) rows.push(row);
      else superseded.push(row.id); // the retransmission supersedes; both stay visible in the raw listing
    }
    i = j;
  }

  const excludedRows = [
    { reason: 'inactive stations excluded', status: 'inactive', ids: inactive },
    { reason: 'proposed stations excluded', status: 'proposed', ids: proposed },
    { reason: 'unknown-status stations excluded', status: 'unknown-status', ids: unknownStatus },
  ].map((entry) => {
    const streamIds = new Set(
      stations
        .filter((station) => entry.ids.includes(station.id))
        .flatMap((station) => station.streams.map((stream) => stream.id)),
    );
    return {
      reason: entry.reason,
      status: entry.status,
      ids: entry.ids,
      rowCount: inWindow.filter((row) => streamIds.has(row.streamId)).length,
    };
  });

  return {
    stations,
    rows,
    excludedRows,
    supersededDuplicateIds: superseded,
  };
}

function rowExclusions(scoped: ScopedRows, includeDuplicateSupersession: boolean): IndicatorExclusion[] {
  const exclusions: IndicatorExclusion[] = scoped.excludedRows.map((entry) => ({
    reason: entry.reason,
    count: entry.rowCount,
    ids: entry.ids,
  }));
  if (includeDuplicateSupersession && scoped.supersededDuplicateIds.length > 0) {
    exclusions.push({
      reason: 'duplicate-timestamp retransmissions superseded (latest received kept; both originals stay in the raw listing)',
      count: scoped.supersededDuplicateIds.length,
      ids: scoped.supersededDuplicateIds,
    });
  }
  return exclusions;
}

function fractionOf(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

// ---------------------------------------------------------------------------
// FR-058 telemetry coverage
// ---------------------------------------------------------------------------

export interface TelemetryOptions {
  readonly systemId?: string | undefined;
  readonly asOf?: string | undefined;
  readonly freshnessHours?: number | undefined;
}

/**
 * Telemetry coverage: numerator = ACTIVE stations whose governed telemetry
 * kind is 'telemetered' AND that reported data inside the freshness window
 * [asOf - freshnessHours, asOf); denominator = active stations in scope.
 * Any observation of the station counts as telemetry evidence - the
 * indicator measures network health, not data visibility.
 */
export function telemetryCoverageIndicator(world: SummaryWorld, options: TelemetryOptions = {}): Indicator {
  const asOf = options.asOf ?? world.asOf;
  const freshnessHours = options.freshnessHours ?? DEFAULT_FRESHNESS_HOURS;
  const asOfMs = Date.parse(asOf);
  const startMs = asOfMs - freshnessHours * 3_600_000;
  const scope = scopeOf(world, options.systemId);
  const stations = stationsInScope(world, options.systemId);

  const active: SummaryStation[] = [];
  const inactive: string[] = [];
  const proposed: string[] = [];
  const unknownStatus: string[] = [];
  for (const station of stations) {
    const exclusion = statusExclusion(station.status);
    if (exclusion === null) active.push(station);
    else if (exclusion === 'inactive') inactive.push(station.id);
    else if (exclusion === 'proposed') proposed.push(station.id);
    else unknownStatus.push(station.id);
  }

  const activeStreamIds = new Set(active.flatMap((station) => station.streams.map((stream) => stream.id)));
  const currentStations = new Set<string>();
  for (const row of world.observations) {
    const at = Date.parse(row.observedAt);
    if (at >= startMs && at < asOfMs && activeStreamIds.has(row.streamId)) {
      currentStations.add(row.streamId);
    }
  }

  const numerator = active.filter((station) => station.telemetry === 'telemetered' && station.streams.some((stream) => currentStations.has(stream.id))).length;
  const exclusions: IndicatorExclusion[] = [
    { reason: 'inactive stations excluded', count: inactive.length, ids: inactive },
    { reason: 'proposed stations excluded', count: proposed.length, ids: proposed },
    { reason: 'unknown-status stations excluded', count: unknownStatus.length, ids: unknownStatus },
  ];

  return {
    id: 'telemetry-coverage',
    label: 'Telemetry coverage (active stations with current data)',
    scope,
    numerator,
    denominator: active.length,
    fraction: fractionOf(numerator, active.length),
    unit: 'stations',
    period: {
      start: new Date(startMs).toISOString(),
      end: new Date(asOfMs).toISOString(),
      description: `current-data freshness window: the ${freshnessHours} h before asOf (half-open)`,
    },
    asOf,
    measureKind: 'output',
    method: INDICATOR_METHOD,
    exclusions,
  };
}

// ---------------------------------------------------------------------------
// FR-058 reviewed-data coverage
// ---------------------------------------------------------------------------

export interface ReviewedOptions {
  readonly systemId?: string | undefined;
  readonly start?: string | undefined;
  readonly end?: string | undefined;
  readonly basis?: ProcessingBasis | undefined;
}

/**
 * Reviewed-data coverage: numerator = reported readings (normalized; one per
 * reported instant) whose revision chain reached the governed 'reviewed'
 * level inside the period; denominator = all reported readings of active
 * stations in the period. A best-available correction alone does NOT count
 * as reviewed (the fixture's obs-q-032 chain stops at best-available).
 */
export function reviewedDataCoverageIndicator(world: SummaryWorld, options: ReviewedOptions = {}): Indicator {
  const asOf = options.end ?? world.asOf;
  const start = options.start ?? observationWindow(world, options.systemId).start ?? asOf;
  const scope = scopeOf(world, options.systemId);
  const scoped = scopedActiveRows(world, options.systemId, Date.parse(start), Date.parse(asOf));
  const records = normalizeRecords(scoped.rows, world.revisions, options.basis ?? 'best-available', Date.parse(start), Date.parse(asOf));
  const numerator = records.filter((record) => record.reviewed).length;

  return {
    id: 'reviewed-data-coverage',
    label: 'Reviewed-data coverage (readings through the governed review level)',
    scope,
    numerator,
    denominator: records.length,
    fraction: fractionOf(numerator, records.length),
    unit: 'reported readings',
    period: {
      start,
      end: asOf,
      description: 'reporting period of the fixture data window, half-open [start, end); every asOf update re-derives the live counts',
    },
    asOf: world.asOf,
    measureKind: 'output',
    method: `${INDICATOR_METHOD}; reviewed = revision chain contains the governed reviewed level`,
    exclusions: rowExclusions(scoped, true),
  };
}

// ---------------------------------------------------------------------------
// FR-059 measured versus estimated (with the distinct unknown bucket)
// ---------------------------------------------------------------------------

export interface MeasuredVersusEstimatedOptions {
  readonly systemId?: string | undefined;
  readonly basis?: ProcessingBasis | undefined;
  readonly start?: string | undefined;
  readonly end?: string | undefined;
}

const CLASSIFICATION_LABELS: Readonly<Record<SourceClassification, string>> = {
  measured: 'Measured at the source',
  estimated: 'Estimated (estimated value type or interpolate qualifier)',
  unknown: 'Unknown or unclassifiable (null frames and ungoverned value types)',
};

export function measuredVersusEstimatedIndicator(
  world: SummaryWorld,
  options: MeasuredVersusEstimatedOptions = {},
): MeasuredVersusEstimatedIndicator {
  const basis: ProcessingBasis = options.basis ?? 'best-available';
  const end = options.end ?? world.asOf;
  const start = options.start ?? observationWindow(world, options.systemId).start ?? end;
  const scope = scopeOf(world, options.systemId);
  const scoped = scopedActiveRows(world, options.systemId, Date.parse(start), Date.parse(end));
  const records = normalizeRecords(scoped.rows, world.revisions, basis, Date.parse(start), Date.parse(end));

  const counts: Record<SourceClassification, number> = { measured: 0, estimated: 0, unknown: 0 };
  for (const record of records) counts[classifyRecord(record)] += 1;
  const denominator = records.length;
  const period: IndicatorPeriod = {
    start,
    end,
    description: `selected source records at the ${basis} basis, half-open [start, end); computed live from the records, never an old audit percentage`,
  };

  return {
    id: 'measured-vs-estimated',
    label: 'Measured versus estimated source classification',
    scope,
    numerator: counts.measured,
    denominator,
    fraction: fractionOf(counts.measured, denominator),
    unit: 'reported readings',
    period,
    asOf: world.asOf,
    measureKind: 'output',
    method: `${INDICATOR_METHOD}; classification at the ${basis} basis; unknown stays a distinct bucket`,
    basis,
    exclusions: rowExclusions(scoped, true),
    buckets: (['measured', 'estimated', 'unknown'] as const).map((classification) => ({
      classification,
      label: CLASSIFICATION_LABELS[classification],
      numerator: counts[classification],
      denominator,
      fraction: fractionOf(counts[classification], denominator),
      unit: 'reported readings',
      period,
      asOf: world.asOf,
    })),
  };
}

// ---------------------------------------------------------------------------
// Sets for the public overview (statewide first, then per-system drill-down)
// ---------------------------------------------------------------------------

export function summaryIndicators(world: SummaryWorld, options: { systemId?: string | undefined } = {}): SummaryIndicatorSet {
  return {
    scope: scopeOf(world, options.systemId),
    telemetry: telemetryCoverageIndicator(world, { systemId: options.systemId }),
    reviewed: reviewedDataCoverageIndicator(world, { systemId: options.systemId }),
    measuredVersusEstimated: measuredVersusEstimatedIndicator(world, { systemId: options.systemId }),
  };
}

export interface SystemIndicatorEntry {
  readonly systemId: string;
  readonly systemName: string;
  readonly indicators: SummaryIndicatorSet;
}

export interface StatewideOverview {
  readonly statewide: SummaryIndicatorSet;
  readonly systems: readonly SystemIndicatorEntry[];
}

/** Statewide set first (the overview leads with it), then every system sorted by id. */
export function statewideOverview(world: SummaryWorld): StatewideOverview {
  return {
    statewide: summaryIndicators(world),
    systems: [...world.systems]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((system) => ({
        systemId: system.id,
        systemName: system.name,
        indicators: summaryIndicators(world, { systemId: system.id }),
      })),
  };
}
