/**
 * Pure fixtures -> public-overview view model for WD-018 (FR-058, FR-059,
 * FR-060, FR-061, FR-062). Dependency-free and pure like the series
 * derivation: the panels pass contract-fixture data in (default: the WD-006
 * shell loaders, read-only); derivation.test.ts feeds it the frozen fixtures.
 *
 * The rules MIRROR services/api/src/summaries/{indicators,totals}.ts (the
 * authoritative implementation with its golden suite), which in turn reuse
 * the WD-008 aggregation semantics (rectangle-right interval integration,
 * missing-never-zero coverage, DST-correct local windows in America/Denver,
 * duplicate normalization to the latest retransmission). derivation.test.ts
 * imports the services modules and asserts the SAME NUMBERS on both
 * surfaces, so the public overview cannot drift from the API silently.
 *
 * Output measures versus outcomes (FR-058): telemetry, reviewed and
 * measured-vs-estimated indicators are OUTPUT measures (what the measurement
 * program produced); the volume totals carry outcome CONTEXT with their
 * coverage and no-double-count caveats, and every number is labeled with its
 * numerator, denominator, period, asOf and exclusions.
 */

export type IndicatorId = 'telemetry-coverage' | 'reviewed-data-coverage' | 'measured-vs-estimated';
export type MeasureKind = 'output' | 'outcome-context';
export type SourceClassification = 'measured' | 'estimated' | 'unknown';
export type ProcessingBasis = 'raw' | 'provisional' | 'reviewed' | 'best-available';

export interface IndicatorPeriod {
  readonly start: string;
  readonly end: string;
  readonly description: string;
}

/**
 * One exclusion applied to reach an indicator denominator: a public-safe
 * CLASS LABEL and a count only — never an identifier list. Exclusions cover
 * restricted/internal objects (e.g. an unpublished proposed gauge), whose
 * existence a public indicator must not confirm; omitted with counts,
 * never identified (hidden-object rule; mirrors the DEFECT-Q1 fix in
 * services/api/src/summaries/indicators.ts).
 */
export interface IndicatorExclusion {
  readonly reason: string;
  readonly count: number;
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
  readonly fraction: number | null;
  readonly unit: string;
  readonly period: IndicatorPeriod;
  readonly asOf: string;
  readonly measureKind: MeasureKind;
  readonly method: string;
  readonly exclusions: readonly IndicatorExclusion[];
}

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

export interface SystemIndicatorEntry {
  readonly systemId: string;
  readonly systemName: string;
  readonly indicators: SummaryIndicatorSet;
}

export interface StatewideOverview {
  readonly statewide: SummaryIndicatorSet;
  readonly systems: readonly SystemIndicatorEntry[];
}

// ---------------------------------------------------------------------------
// Structural inputs (the shell fixture records satisfy these without mapping)
// ---------------------------------------------------------------------------

export interface StreamInput {
  readonly id: string;
  readonly stationId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  readonly visibility: string;
  readonly timeZone: string;
  readonly cadenceMinutes: number;
  readonly validRangeMin: number;
  readonly validRangeMax: number;
}

export interface StationInput {
  readonly id: string;
  readonly displayName: string;
  readonly systemId: string;
  readonly status: string;
  /** Station visibility ('public' | 'restricted' | 'internal'): drives the anonymous-omission wall below. */
  readonly visibility: string;
  readonly telemetry: string;
  readonly siteTypeId: string;
  readonly waterSourceTypeId: string;
  readonly datastreams?: readonly StreamInput[];
}

export interface ObservationInput {
  readonly id: string;
  readonly streamId: string;
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly sourceEventId: string;
  readonly value: number | null;
  readonly valueType: string;
}

export interface RevisionInput {
  readonly id: string;
  readonly targetObservationId: string;
  readonly processingLevel: string;
  readonly qualifierIds: readonly string[];
  readonly recordedAt: string;
  readonly value: number;
}

export interface SummaryWorldInput {
  readonly asOf: string;
  readonly stations: readonly StationInput[];
  readonly systems: readonly { readonly id: string; readonly name: string }[];
  readonly observations: readonly ObservationInput[];
  readonly revisions: readonly RevisionInput[];
}

/** Versioned indicator method identity, identical to the services domain. */
export const INDICATOR_METHOD = 'station-and-record-rules@1' as const;
export const DEFAULT_FRESHNESS_HOURS = 24;
export const CUBIC_FEET_PER_ACRE_FOOT = 43_560;
export const PROGRAM_TIME_ZONE = 'America/Denver';
export const LOOK_BACK_CAP_MINUTES = 31 * 24 * 60;

const MATURITY: Readonly<Record<ProcessingBasis, number>> = {
  raw: 0,
  provisional: 1,
  reviewed: 2,
  'best-available': 3,
};

function stationsInScope(world: SummaryWorldInput, systemId?: string): readonly StationInput[] {
  const scoped = systemId === undefined ? world.stations : world.stations.filter((station) => station.systemId === systemId);
  return [...scoped].sort((a, b) => (a.id < b.id ? -1 : 1));
}

function systemNameOf(world: SummaryWorldInput, systemId: string): string | null {
  return world.systems.find((system) => system.id === systemId)?.name ?? null;
}

function scopeOf(world: SummaryWorldInput, systemId?: string): IndicatorScope {
  return {
    kind: systemId === undefined ? 'statewide' : 'system',
    systemId: systemId ?? null,
    systemName: systemId === undefined ? null : systemNameOf(world, systemId),
  };
}

function statusExclusion(status: string): 'inactive' | 'proposed' | 'unknown-status' | null {
  if (status === 'inactive') return 'inactive';
  if (status === 'proposed') return 'proposed';
  if (status === 'active') return null;
  return 'unknown-status';
}

function fractionOf(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function observationWindow(world: SummaryWorldInput, systemId?: string): { start: string | null; end: string | null } {
  const scope = new Set(stationsInScope(world, systemId).flatMap((station) => (station.datastreams ?? []).map((stream) => stream.id)));
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

// ---------------------------------------------------------------------------
// Record normalization (mirrors the WD-008 effectivePoints semantics)
// ---------------------------------------------------------------------------

export interface NormalizedRecord {
  readonly observationId: string;
  readonly streamId: string;
  readonly observedAt: string;
  readonly value: number | null;
  readonly valueType: string;
  readonly estimated: boolean;
  readonly reviewed: boolean;
  readonly collapsedDuplicateIds: readonly string[];
}

function sortObservations(rows: readonly ObservationInput[]): ObservationInput[] {
  return [...rows].sort((a, b) => {
    if (a.streamId !== b.streamId) return a.streamId < b.streamId ? -1 : 1;
    const at = Date.parse(a.observedAt) - Date.parse(b.observedAt);
    if (at !== 0) return at;
    const rt = Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
    if (rt !== 0) return rt;
    return a.sourceEventId < b.sourceEventId ? -1 : 1;
  });
}

function chainsByTarget(revisions: readonly RevisionInput[]): Map<string, RevisionInput[]> {
  const byTarget = new Map<string, RevisionInput[]>();
  for (const rev of [...revisions].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || (a.id < b.id ? -1 : 1))) {
    const chain = byTarget.get(rev.targetObservationId);
    if (chain) chain.push(rev);
    else byTarget.set(rev.targetObservationId, [rev]);
  }
  return byTarget;
}

/**
 * One record per reported instant per stream: duplicate timestamps collapse
 * to the latest-received retransmission (superseded ids retained), the value
 * is effective at `basis` (below-basis fallback keeps the raw value), and
 * `reviewed` records whether the chain reached the governed reviewed level.
 */
export function normalizeRecords(
  rows: readonly ObservationInput[],
  revisions: readonly RevisionInput[],
  basis: ProcessingBasis,
  startMs: number,
  endMs: number,
): NormalizedRecord[] {
  const byTarget = chainsByTarget(revisions);
  const inWindow = sortObservations(
    rows.filter((row) => {
      const at = Date.parse(row.observedAt);
      return at >= startMs && at < endMs;
    }),
  );

  const records: NormalizedRecord[] = [];
  let i = 0;
  while (i < inWindow.length) {
    const streamId = inWindow[i]!.streamId;
    const instant = inWindow[i]!.observedAt;
    let j = i + 1;
    while (j < inWindow.length && inWindow[j]!.streamId === streamId && inWindow[j]!.observedAt === instant) j += 1;
    const chosen = inWindow[j - 1]!;
    const chain = byTarget.get(chosen.id) ?? [];
    let value = chosen.value;
    let selected: RevisionInput | null = null;
    if (basis !== 'raw' && chain.length > 0) {
      selected =
        basis === 'best-available'
          ? chain[chain.length - 1] ?? null
          : ([...chain].reverse().find((rev) => MATURITY[rev.processingLevel as ProcessingBasis] >= MATURITY[basis]) ?? null);
      if (selected) value = selected.value;
    }
    const estimated =
      selected === null
        ? chosen.valueType === 'estimated'
        : chosen.valueType === 'estimated' || selected.qualifierIds.includes('interpolate');
    records.push({
      observationId: chosen.id,
      streamId,
      observedAt: chosen.observedAt,
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
 * FR-059 classification: observed source values are measured, flagged
 * estimates are estimated, and null frames or ungoverned value types are the
 * DISTINCT unknown bucket - never folded into measured or estimated.
 */
export function classifyRecord(record: NormalizedRecord): SourceClassification {
  if (record.value === null) return 'unknown';
  if (record.estimated) return 'estimated';
  if (record.valueType === 'observed') return 'measured';
  return 'unknown';
}

interface ScopedRows {
  readonly rows: readonly ObservationInput[];
  /** Anonymous exclusion classes: reason label + excluded-row count only (never identifiers). */
  readonly statusExclusions: readonly { reason: string; rowCount: number }[];
  readonly supersededDuplicateIds: readonly string[];
}

function scopedActiveRows(world: SummaryWorldInput, systemId: string | undefined, startMs: number, endMs: number): ScopedRows {
  const stations = stationsInScope(world, systemId);
  const buckets = { inactive: [] as string[], proposed: [] as string[], 'unknown-status': [] as string[] };
  const activeStreamIds = new Set<string>();
  for (const station of stations) {
    const exclusion = statusExclusion(station.status);
    if (exclusion === null) {
      for (const stream of station.datastreams ?? []) activeStreamIds.add(stream.id);
    } else {
      buckets[exclusion].push(station.id);
    }
  }

  const inWindow = sortObservations(
    world.observations.filter((row) => {
      const at = Date.parse(row.observedAt);
      return at >= startMs && at < endMs;
    }),
  );
  const rows: ObservationInput[] = [];
  const superseded: string[] = [];
  let i = 0;
  while (i < inWindow.length) {
    const streamId = inWindow[i]!.streamId;
    const instant = inWindow[i]!.observedAt;
    let j = i + 1;
    while (j < inWindow.length && inWindow[j]!.streamId === streamId && inWindow[j]!.observedAt === instant) j += 1;
    for (let k = i; k < j; k += 1) {
      const row = inWindow[k]!;
      if (!activeStreamIds.has(row.streamId)) continue;
      if (k === j - 1) rows.push(row);
      else superseded.push(row.id);
    }
    i = j;
  }

  // Anonymous exclusion classes: the station ids stay INTERNAL to the count
  // derivation — the emitted class is a label + row count only (DEFECT-Q1).
  const statusExclusions = [
    { reason: 'inactive stations excluded', ids: buckets.inactive as readonly string[] },
    { reason: 'proposed stations excluded', ids: buckets.proposed as readonly string[] },
    { reason: 'unknown-status stations excluded', ids: buckets['unknown-status'] as readonly string[] },
  ].map((entry) => {
    const streamIds = new Set(
      stations.filter((station) => entry.ids.includes(station.id)).flatMap((station) => (station.datastreams ?? []).map((stream) => stream.id)),
    );
    return { reason: entry.reason, rowCount: inWindow.filter((row) => streamIds.has(row.streamId)).length };
  });

  return { rows, statusExclusions, supersededDuplicateIds: superseded };
}

function rowExclusions(scoped: ScopedRows): IndicatorExclusion[] {
  const exclusions: IndicatorExclusion[] = scoped.statusExclusions.map((entry) => ({
    reason: entry.reason,
    count: entry.rowCount,
  }));
  if (scoped.supersededDuplicateIds.length > 0) {
    // Count only: the superseded observation ids stay internal (DEFECT-Q1).
    exclusions.push({
      reason: 'duplicate-timestamp retransmissions superseded (latest received kept; both originals stay in the raw listing)',
      count: scoped.supersededDuplicateIds.length,
    });
  }
  return exclusions;
}

// ---------------------------------------------------------------------------
// FR-058 telemetry coverage
// ---------------------------------------------------------------------------

export function telemetryCoverageIndicator(
  world: SummaryWorldInput,
  options: { systemId?: string | undefined; asOf?: string | undefined; freshnessHours?: number | undefined } = {},
): Indicator {
  const asOf = options.asOf ?? world.asOf;
  const freshnessHours = options.freshnessHours ?? DEFAULT_FRESHNESS_HOURS;
  const asOfMs = Date.parse(asOf);
  const startMs = asOfMs - freshnessHours * 3_600_000;
  const stations = stationsInScope(world, options.systemId);

  const active: StationInput[] = [];
  const buckets = { inactive: [] as string[], proposed: [] as string[], 'unknown-status': [] as string[] };
  for (const station of stations) {
    const exclusion = statusExclusion(station.status);
    if (exclusion === null) active.push(station);
    else buckets[exclusion].push(station.id);
  }

  const activeStreamIds = new Set(active.flatMap((station) => (station.datastreams ?? []).map((stream) => stream.id)));
  const currentStreams = new Set<string>();
  for (const row of world.observations) {
    const at = Date.parse(row.observedAt);
    if (at >= startMs && at < asOfMs && activeStreamIds.has(row.streamId)) currentStreams.add(row.streamId);
  }

  const numerator = active.filter(
    (station) => station.telemetry === 'telemetered' && (station.datastreams ?? []).some((stream) => currentStreams.has(stream.id)),
  ).length;

  return {
    id: 'telemetry-coverage',
    label: 'Telemetry coverage (active stations with current data)',
    scope: scopeOf(world, options.systemId),
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
    // Anonymous class counts only: an exclusion list never identifies the
    // excluded stations (the proposed class can include restricted objects;
    // DEFECT-Q1 fix - labels + counts, never ids).
    exclusions: [
      { reason: 'inactive stations excluded', count: buckets.inactive.length },
      { reason: 'proposed stations excluded', count: buckets.proposed.length },
      { reason: 'unknown-status stations excluded', count: buckets['unknown-status'].length },
    ],
  };
}

// ---------------------------------------------------------------------------
// FR-058 reviewed-data coverage
// ---------------------------------------------------------------------------

export function reviewedDataCoverageIndicator(
  world: SummaryWorldInput,
  options: { systemId?: string | undefined; start?: string | undefined; end?: string | undefined; basis?: ProcessingBasis | undefined } = {},
): Indicator {
  const asOf = options.end ?? world.asOf;
  const start = options.start ?? observationWindow(world, options.systemId).start ?? asOf;
  const scoped = scopedActiveRows(world, options.systemId, Date.parse(start), Date.parse(asOf));
  const records = normalizeRecords(scoped.rows, world.revisions, options.basis ?? 'best-available', Date.parse(start), Date.parse(asOf));
  const numerator = records.filter((record) => record.reviewed).length;

  return {
    id: 'reviewed-data-coverage',
    label: 'Reviewed-data coverage (readings through the governed review level)',
    scope: scopeOf(world, options.systemId),
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
    exclusions: rowExclusions(scoped),
  };
}

// ---------------------------------------------------------------------------
// FR-059 measured versus estimated
// ---------------------------------------------------------------------------

const CLASSIFICATION_LABELS: Readonly<Record<SourceClassification, string>> = {
  measured: 'Measured at the source',
  estimated: 'Estimated (estimated value type or interpolate qualifier)',
  unknown: 'Unknown or unclassifiable (null frames and ungoverned value types)',
};

export function measuredVersusEstimatedIndicator(
  world: SummaryWorldInput,
  options: { systemId?: string | undefined; basis?: ProcessingBasis | undefined; start?: string | undefined; end?: string | undefined } = {},
): MeasuredVersusEstimatedIndicator {
  const basis: ProcessingBasis = options.basis ?? 'best-available';
  const end = options.end ?? world.asOf;
  const start = options.start ?? observationWindow(world, options.systemId).start ?? end;
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
    scope: scopeOf(world, options.systemId),
    numerator: counts.measured,
    denominator,
    fraction: fractionOf(counts.measured, denominator),
    unit: 'reported readings',
    period,
    asOf: world.asOf,
    measureKind: 'output',
    method: `${INDICATOR_METHOD}; classification at the ${basis} basis; unknown stays a distinct bucket`,
    basis,
    exclusions: rowExclusions(scoped),
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

export function summaryIndicators(world: SummaryWorldInput, options: { systemId?: string | undefined } = {}): SummaryIndicatorSet {
  return {
    scope: scopeOf(world, options.systemId),
    telemetry: telemetryCoverageIndicator(world, { systemId: options.systemId }),
    reviewed: reviewedDataCoverageIndicator(world, { systemId: options.systemId }),
    measuredVersusEstimated: measuredVersusEstimatedIndicator(world, { systemId: options.systemId }),
  };
}

export function statewideOverview(world: SummaryWorldInput): StatewideOverview {
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

/** Plain-language statewide lead (FR-058 "intelligible overview"), derived - never hand-written prose that can drift. */
export function plainLanguageSummary(set: SummaryIndicatorSet): string {
  const { telemetry, reviewed, measuredVersusEstimated } = set;
  const scope = set.scope.kind === 'statewide' ? 'Statewide' : `In ${set.scope.systemName ?? set.scope.systemId}`;
  const pct = (fraction: number | null) => (fraction === null ? 'unavailable (no denominator)' : `${Math.round(fraction * 100)}%`);
  const measured = measuredVersusEstimated.buckets[0]!;
  const estimated = measuredVersusEstimated.buckets[1]!;
  const unknown = measuredVersusEstimated.buckets[2]!;
  return (
    `${scope}: ${telemetry.numerator} of ${telemetry.denominator} active measurement stations report by telemetry with data inside the last ` +
    `${DEFAULT_FRESHNESS_HOURS} hours (${pct(telemetry.fraction)}). ${reviewed.numerator} of ${reviewed.denominator} reported readings ` +
    `since ${reviewed.period.start} have completed the governed review (${pct(reviewed.fraction)}). ${measured.numerator} of ` +
    `${measuredVersusEstimated.denominator} readings are direct measurements, ${estimated.numerator} estimated and ${unknown.numerator} ` +
    `unknown (${pct(measuredVersusEstimated.fraction)} measured). Data as of ${telemetry.asOf}.`
  );
}

// ---------------------------------------------------------------------------
// Local calendar windows (mirror of services zone.ts / WD-008 semantics)
// ---------------------------------------------------------------------------

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(epochMs: number, zone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), hour: Number(map.hour) % 24, minute: Number(map.minute), second: Number(map.second) };
}

function zoneOffsetMs(epochMs: number, zone: string): number {
  const p = zonedParts(epochMs, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** The UTC instant of local midnight for a civil date in `zone` (fixed-point iteration, mirrors services zone.ts). */
export function localMidnightInstant(date: { year: number; month: number; day: number }, zone: string = PROGRAM_TIME_ZONE): number {
  const naive = Date.UTC(date.year, date.month - 1, date.day);
  let t = naive - zoneOffsetMs(naive - 7 * 3_600_000, zone);
  for (let i = 0; i < 4; i += 1) {
    const next = naive - zoneOffsetMs(t, zone);
    if (next === t) return t;
    t = next;
  }
  return t;
}

function addDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function dayKey(date: { year: number; month: number; day: number }): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function localDateOf(epochMs: number, zone: string): { year: number; month: number; day: number } {
  const p = zonedParts(epochMs, zone);
  return { year: p.year, month: p.month, day: p.day };
}

// ---------------------------------------------------------------------------
// FR-061 area totals (mirror of services totals.ts over WD-008 buckets)
// ---------------------------------------------------------------------------

export type AccountingCategory = 'natural-channel-flow' | 'canal-delivery' | 'reservoir-release';

export const CATEGORY_LABELS: Readonly<Record<AccountingCategory, string>> = {
  'natural-channel-flow': 'Natural channel flow (mainstem gauges)',
  'canal-delivery': 'Canal and diversion delivery',
  'reservoir-release': 'Reservoir release',
};

export const NO_DOUBLE_COUNT_POLICY =
  'Totals are reported per accounting category and are never summed across categories: the same water can be measured at an upstream gauge, a downstream gauge and a canal delivery. Categories come from governed station fields (water source, site type); restricted streams are excluded from public totals; volumes cover measured intervals only and missing readings are never zero-filled.';

export interface TotalsRequestInput {
  readonly area: 'statewide' | { readonly systemId: string };
  readonly start: string;
  readonly end: string;
  readonly basis: ProcessingBasis;
  readonly visibility?: 'public' | 'all' | undefined;
}

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

/**
 * One anonymous omission class of the default-public projection: a
 * public-safe class label and the count of streams omitted for that class.
 * Restricted/internal streams are acknowledged ONLY this way — never
 * identified by id, display name or property (hidden-object rule:
 * omitted with counts, never identified; mirrors the DEFECT-Q2 fix in
 * services/api/src/summaries/totals.ts). The 'all' projection itemizes
 * every stream instead and carries no anonymous classes.
 */
export interface OmittedStreamClass {
  readonly reason: string;
  readonly count: number;
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
  readonly effectiveStart: string;
  readonly effectiveEnd: string;
  readonly timeZone: string;
  readonly method: string;
  readonly noDoubleCountPolicy: string;
  readonly combinedVolumeAcreFeet: null;
  readonly categories: readonly CategoryTotal[];
  /**
   * Streams this projection does not enumerate, as anonymous class counts
   * (public projection only): restricted/internal stations and streams are
   * counted by omission class and never identified. Empty for 'all'
   * visibility, which itemizes every stream in `streams`.
   */
  readonly omittedStreams: readonly OmittedStreamClass[];
  readonly streams: readonly StreamAccountingEntry[];
}

export const AGGREGATION_METHOD = 'rectangle-right@1' as const;

const CATEGORY_ORDER: readonly AccountingCategory[] = ['natural-channel-flow', 'canal-delivery', 'reservoir-release'];

export function accountingCategory(station: StationInput): AccountingCategory | null {
  if (station.waterSourceTypeId === 'surface-storage-release') return 'reservoir-release';
  if (station.siteTypeId === 'natural-channel') return 'natural-channel-flow';
  if (station.siteTypeId === 'flume' || station.siteTypeId === 'weir') return 'canal-delivery';
  return null;
}

function inclusionOf(station: StationInput, stream: StreamInput, visibility: 'public' | 'all'): { included: boolean; category: AccountingCategory | null; reason: string | null } {
  const status = statusExclusion(station.status);
  if (status !== null) return { included: false, category: null, reason: `station ${status}` };
  if (visibility === 'public' && stream.visibility !== 'public') {
    return { included: false, category: null, reason: `stream not in the public projection (${stream.visibility})` };
  }
  if (stream.observedPropertyId !== 'discharge' || stream.unitId !== 'cfs') {
    return {
      included: false,
      category: null,
      reason: `dimension mismatch: flow totals aggregate discharge in cfs; ${stream.observedPropertyId} in ${stream.unitId} is a different dimension`,
    };
  }
  const category = accountingCategory(station);
  if (category === null) {
    return { included: false, category: null, reason: `no governed accounting category for site type ${station.siteTypeId} / water source ${station.waterSourceTypeId}` };
  }
  return { included: true, category, reason: null };
}

interface DailyBucket {
  readonly key: string;
  readonly durationSeconds: number;
  readonly coveredSeconds: number;
  readonly estimatedSeconds: number;
  readonly volumeAcreFeet: number | null;
}

/**
 * Daily buckets of one stream over the enclosing local calendar windows of
 * [startMs, endMs), mirroring the WD-008 aggregateBucket arithmetic exactly:
 * each usable reading covers [observedAt, observedAt + cadence) clipped to
 * the next reading and the bucket window; missing stays uncovered; volume =
 * integrated cubic feet / 43 560 over covered time only (null when nothing
 * is covered). A cadence look-back loads readings that still govern the
 * window opening.
 */
export function dailyBuckets(
  records: readonly NormalizedRecord[],
  stream: StreamInput,
  startMs: number,
  endMs: number,
  zone: string = stream.timeZone || PROGRAM_TIME_ZONE,
): DailyBucket[] {
  const windows: { key: string; startMs: number; endMs: number }[] = [];
  let date = localDateOf(startMs, zone);
  for (;;) {
    const windowStartMs = localMidnightInstant(date, zone);
    if (windowStartMs >= endMs) break;
    const windowEndMs = localMidnightInstant(addDays(date, 1), zone);
    windows.push({ key: dayKey(date), startMs: windowStartMs, endMs: windowEndMs });
    date = addDays(date, 1);
  }
  if (windows.length === 0) return [];

  const cadenceSeconds = stream.cadenceMinutes * 60;
  const lookBackMs = Math.min(stream.cadenceMinutes, LOOK_BACK_CAP_MINUTES) * 60_000;
  const loadingStartMs = windows[0]!.startMs - lookBackMs;
  const loadingEndMs = windows[windows.length - 1]!.endMs;
  const sorted = [...records]
    .filter((record) => {
      const at = Date.parse(record.observedAt);
      return at >= loadingStartMs && at < loadingEndMs;
    })
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));

  const usable = (record: NormalizedRecord): record is NormalizedRecord & { value: number } =>
    record.value !== null && record.value >= stream.validRangeMin && record.value <= stream.validRangeMax;

  return windows.map((window) => {
    let coveredSeconds = 0;
    let cubicFeet = 0;
    let estimatedSeconds = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      const record = sorted[i]!;
      const observedMs = Date.parse(record.observedAt);
      if (observedMs >= window.endMs) break;
      if (!usable(record)) continue; // spikes and null frames leave their interval uncovered
      const rawEndMs = observedMs + cadenceSeconds * 1000;
      const nextReadingMs = i + 1 < sorted.length ? Date.parse(sorted[i + 1]!.observedAt) : Number.POSITIVE_INFINITY;
      const sliceEndMs = Math.min(rawEndMs, nextReadingMs, window.endMs);
      const sliceStartMs = Math.max(observedMs, window.startMs);
      if (sliceEndMs <= sliceStartMs) continue;
      const seconds = (sliceEndMs - sliceStartMs) / 1000;
      coveredSeconds += seconds;
      cubicFeet += record.value * seconds;
      if (record.estimated) estimatedSeconds += seconds;
    }
    return {
      key: window.key,
      durationSeconds: (window.endMs - window.startMs) / 1000,
      coveredSeconds,
      estimatedSeconds,
      volumeAcreFeet: coveredSeconds > 0 ? cubicFeet / CUBIC_FEET_PER_ACRE_FOOT : null,
    };
  });
}

/** Validate a half-open window the WD-008 way (used by the overview error state). */
export function windowDenial(start: string, end: string): { code: 'MALFORMED_WINDOW' | 'EMPTY_WINDOW' | 'REQUEST_WINDOW_TOO_LARGE' } | null {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { code: 'MALFORMED_WINDOW' };
  if (endMs <= startMs) return { code: 'EMPTY_WINDOW' };
  if ((endMs - startMs) / 86_400_000 > 400) return { code: 'REQUEST_WINDOW_TOO_LARGE' };
  return null;
}

export function areaTotals(world: SummaryWorldInput, request: TotalsRequestInput): { outcome: 'allowed'; value: AreaTotals } | { outcome: 'denied'; code: string; message: string } {
  const denial = windowDenial(request.start, request.end);
  if (denial) return { outcome: 'denied', code: denial.code, message: `invalid window: ${denial.code}` };

  const visibility = request.visibility ?? 'public';
  const systemId = request.area === 'statewide' ? undefined : request.area.systemId;
  const stations = stationsInScope(world, systemId);
  const startMs = Date.parse(request.start);
  const endMs = Date.parse(request.end);

  const streams: StreamAccountingEntry[] = [];
  const categoryStreams = new Map<AccountingCategory, { streamId: string; volume: number; covered: number; duration: number; estimated: number }[]>();
  const dailyByCategory = new Map<AccountingCategory, Map<string, { volume: number | null; covered: number; duration: number }>>();
  const omittedByClass = new Map<string, number>();
  let effectiveStartMs: number | null = null;
  let effectiveEndMs: number | null = null;

  const streamRows = world.observations;
  for (const station of stations) {
    for (const stream of [...(station.datastreams ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (visibility === 'public' && (station.visibility !== 'public' || stream.visibility !== 'public')) {
        // Hidden-object rule (DEFECT-Q2 fix, mirroring services totals.ts): a
        // restricted/internal station or stream is never enumerated in the
        // public projection - no ids, no display names, no properties, not
        // even its status. It joins an anonymous class count (label + count
        // only). The status-based rules below apply to public objects only.
        const reason =
          station.visibility !== 'public'
            ? `station not in the public projection (${station.visibility})`
            : `stream not in the public projection (${stream.visibility})`;
        omittedByClass.set(reason, (omittedByClass.get(reason) ?? 0) + 1);
        continue;
      }
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
      const records = normalizeRecords(streamRows, world.revisions, request.basis, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)
        .filter((record) => record.streamId === stream.id);
      const buckets = dailyBuckets(records, stream, startMs, endMs, stream.timeZone || PROGRAM_TIME_ZONE);
      let volume = 0;
      let coveredSeconds = 0;
      let durationSeconds = 0;
      let estimatedSeconds = 0;
      const daily = dailyByCategory.get(inclusion.category) ?? new Map<string, { volume: number | null; covered: number; duration: number }>();
      for (const bucket of buckets) {
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
      if (buckets.length > 0) {
        const firstMs = localMidnightInstant(localDateOf(startMs, stream.timeZone || PROGRAM_TIME_ZONE), stream.timeZone || PROGRAM_TIME_ZONE);
        const lastMs = localMidnightInstant(addDays(localDateOf(endMs - 1, stream.timeZone || PROGRAM_TIME_ZONE), 1), stream.timeZone || PROGRAM_TIME_ZONE);
        effectiveStartMs = effectiveStartMs === null ? firstMs : Math.min(effectiveStartMs, firstMs);
        effectiveEndMs = effectiveEndMs === null ? lastMs : Math.max(effectiveEndMs, lastMs);
      }
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
    const dailyMap = dailyByCategory.get(category)!;
    const covered = entries.reduce((sum, entry) => sum + entry.covered, 0);
    const duration = entries.reduce((sum, entry) => sum + entry.duration, 0);
    const estimated = entries.reduce((sum, entry) => sum + entry.estimated, 0);
    return {
      category,
      label: CATEGORY_LABELS[category],
      streamIds: entries.map((entry) => entry.streamId),
      volumeAcreFeet: entries.reduce((sum, entry) => sum + entry.volume, 0),
      volumeUnit: 'acre-feet' as const,
      coveredSeconds: covered,
      durationSeconds: duration,
      coverageFraction: duration > 0 ? covered / duration : 0,
      estimatedSeconds: estimated,
      estimatedProportion: covered > 0 ? estimated / covered : 0,
      daily: [...dailyMap.keys()].sort().map((key) => {
        const entry = dailyMap.get(key)!;
        return { key, volumeAcreFeet: entry.volume, coverageFraction: entry.duration > 0 ? entry.covered / entry.duration : 0 };
      }),
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
      omittedStreams: [...omittedByClass.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => (a.reason < b.reason ? -1 : 1)),
      streams,
    },
  };
}

/** Default overview window: the latest 72 h before asOf (deterministic - no wall clock). */
export function defaultTotalsWindow(asOf: string): { start: string; end: string } {
  const endMs = Date.parse(asOf);
  return { start: new Date(endMs - 72 * 3_600_000).toISOString(), end: new Date(endMs).toISOString() };
}

// ---------------------------------------------------------------------------
// FR-062 chart view models (text + shape cues, never color alone)
// ---------------------------------------------------------------------------

export interface ClassificationBar {
  readonly classification: SourceClassification;
  readonly label: string;
  readonly shortLabel: string;
  readonly shape: string;
  readonly value: number;
  readonly denominator: number;
  readonly fraction: number | null;
  readonly ariaLabel: string;
}

export const CLASSIFICATION_COLORS: Readonly<Record<SourceClassification, string>> = {
  measured: '#16887e',
  estimated: '#c98a2d',
  unknown: '#7d5ba6',
};

export const CLASSIFICATION_SHAPES: Readonly<Record<SourceClassification, string>> = {
  measured: '●',
  estimated: '≈',
  unknown: '?',
};

export function classificationBars(indicator: MeasuredVersusEstimatedIndicator): ClassificationBar[] {
  const short: Record<SourceClassification, string> = { measured: 'Measured', estimated: 'Estimated', unknown: 'Unknown' };
  return indicator.buckets.map((bucket) => ({
    classification: bucket.classification,
    label: bucket.label,
    shortLabel: short[bucket.classification],
    shape: CLASSIFICATION_SHAPES[bucket.classification],
    value: bucket.numerator,
    denominator: bucket.denominator,
    fraction: bucket.fraction,
    ariaLabel:
      `${short[bucket.classification]}: ${bucket.numerator} of ${bucket.denominator} ${bucket.unit} ` +
      `(${bucket.fraction === null ? 'unavailable, no denominator' : `${Math.round(bucket.fraction * 100)}%`}); ` +
      `${bucket.period.description}; as of ${bucket.asOf}.`,
  }));
}

export const CATEGORY_SHAPES: Readonly<Record<AccountingCategory, string>> = {
  'natural-channel-flow': '●',
  'canal-delivery': '■',
  'reservoir-release': '▲',
};

export const CATEGORY_COLORS: Readonly<Record<AccountingCategory, string>> = {
  'natural-channel-flow': '#16887e',
  'canal-delivery': '#c98a2d',
  'reservoir-release': '#7d5ba6',
};

export interface VolumeSeriesModel {
  readonly unit: 'acre-feet';
  readonly categories: readonly { category: AccountingCategory; label: string; shape: string; color: string }[];
  readonly points: readonly {
    readonly day: string;
    readonly values: readonly { category: AccountingCategory; volumeAcreFeet: number | null; coverageFraction: number; ariaLabel: string }[];
  }[];
}

export function volumeSeries(totals: AreaTotals): VolumeSeriesModel {
  const categories = totals.categories.map((category) => ({
    category: category.category,
    label: category.label,
    shape: CATEGORY_SHAPES[category.category],
    color: CATEGORY_COLORS[category.category],
  }));
  const dayKeys = [...new Set(totals.categories.flatMap((category) => category.daily.map((day) => day.key)))].sort();
  return {
    unit: 'acre-feet',
    categories,
    points: dayKeys.map((day) => ({
      day,
      values: totals.categories.map((category) => {
        const dayEntry = category.daily.find((candidate) => candidate.key === day);
        const volume = dayEntry ? dayEntry.volumeAcreFeet : null;
        const coverage = dayEntry ? dayEntry.coverageFraction : 0;
        return {
          category: category.category,
          volumeAcreFeet: volume,
          coverageFraction: coverage,
          ariaLabel:
            `${day} ${category.label}: ` +
            (volume === null ? 'no measured volume (missing is never zero)' : `${volume.toFixed(2)} acre-feet, ${Math.round(coverage * 100)}% of the day covered`) +
            `.`,
        };
      }),
    })),
  };
}
