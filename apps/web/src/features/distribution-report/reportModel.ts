/**
 * reportModel - pure view models for the WD-025 distribution-report feature
 * (FR-024; FR-029 boundary visible, not implemented).
 *
 * MIRROR CONTRACT (the established WD-008/WD-011 pattern):
 * - Period-basis date math mirrors services/api/src/series/zone.ts
 *   seasonWindow + localMidnightInstant (documented defaults pending
 *   measurement-owner ratification: calendar year Jan-Dec, water year Oct-Sep
 *   (USGS), irrigation season Apr 1 - Oct 31).
 * - The demo generation (buildFixtureReport) mirrors
 *   services/api/src/workflows/distribution-report/generate.ts: daily
 *   rectangle-right interval integration, missing-never-zero coverage, the
 *   at-or-above revision ladder, governed accounting categories and the
 *   provenance/data-version shape. reportModel.test.ts pins the SAME golden
 *   numbers as the API suite (corinne CY-2026 raw 10299/121 etc.) so the two
 *   surfaces cannot drift silently. The API remains the source of truth; the
 *   demo exists because the HTTP service is not wired yet (README.md).
 * - The demo content hash is a deterministic FNV-style digest of the same
 *   canonical preimage, NOT the server's sha256; the view labels it as a
 *   demo stand-in.
 *
 * Deterministic: no clock reads (the extraction time is passed in, default
 * the fixture clock), no randomness, fixed iteration orders.
 */
import { entitlements, FIXTURE_CLOCK, gaps, observations, revisions, stations, systems, users } from '../../shell/data/fixtures';
import type { DatastreamRecord, EntitlementRecord, ObservationRecord, RevisionRecord, StationRecord } from '../../shell/data/types';

// ---------------------------------------------------------------------------
// Period bases (date rules visible in the request UI)
// ---------------------------------------------------------------------------

export type PeriodBasis = 'calendar-year' | 'water-year' | 'irrigation-season';
export type ProcessingBasis = 'raw' | 'provisional' | 'reviewed' | 'best-available';

export interface PeriodBasisOption {
  readonly id: PeriodBasis;
  readonly label: string;
  /** The date rule, shown verbatim next to the picker (never one year's meaning for all personas). */
  readonly dateRule: string;
  /** Plain-language month span for the picker hint. */
  readonly months: string;
}

export const PERIOD_BASES: readonly PeriodBasisOption[] = [
  {
    id: 'calendar-year',
    label: 'Calendar year',
    dateRule: 'local calendar year: Jan 1 00:00 (inclusive) through Jan 1 next year (exclusive), America/Denver',
    months: 'January - December',
  },
  {
    id: 'water-year',
    label: 'Water year (Oct - Sep)',
    dateRule: 'USGS water year: Oct 1 of the previous year (inclusive) through Oct 1 of the period year (exclusive; the water year ends Sep 30), America/Denver',
    months: 'October (year-1) - September (year)',
  },
  {
    id: 'irrigation-season',
    label: 'Irrigation season (Apr 1 - Oct 31)',
    dateRule: 'irrigation season: Apr 1 (inclusive) through Nov 1 (exclusive) of the period year, America/Denver',
    months: 'April - October',
  },
] as const;

export const PROGRAM_TIME_ZONE = 'America/Denver';

// ---------------------------------------------------------------------------
// Local-calendar mirror (presentation twin of series/zone.ts)
// ---------------------------------------------------------------------------

function zonedParts(epochMs: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
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
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function offsetMs(epochMs: number, zone: string): number {
  const p = zonedParts(epochMs, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** UTC instant of local midnight for a civil date in the zone (fixed-point, like zone.ts). */
export function localMidnightMs(year: number, month: number, day: number, zone: string = PROGRAM_TIME_ZONE): number {
  const naive = Date.UTC(year, month - 1, day);
  let t = naive - 7 * 3_600_000;
  for (let i = 0; i < 4; i += 1) {
    const next = naive - offsetMs(t, zone);
    if (next === t) return t;
    t = next;
  }
  return t;
}

function addMonthsUtc(year: number, month: number, count: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + count;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

export interface PeriodWindowModel {
  readonly basis: PeriodBasis;
  readonly year: number;
  /** UTC instants of the local window bounds; half-open [start, end). */
  readonly start: string;
  readonly end: string;
  readonly dateRule: string;
  /** Whole local days in the window (a DST hour lost is regained within the year). */
  readonly dayCount: number;
}

/** The reporting window of a basis + year (mirror of the API periodWindow). */
export function periodWindow(basis: PeriodBasis, year: number): PeriodWindowModel {
  const option = PERIOD_BASES.find((candidate) => candidate.id === basis)!;
  let startYear = year;
  let startMonth = 1;
  let spanMonths = 12;
  if (basis === 'water-year') {
    startYear = year - 1;
    startMonth = 10;
  } else if (basis === 'irrigation-season') {
    startMonth = 4;
    spanMonths = 7;
  }
  const startMs = localMidnightMs(startYear, startMonth, 1);
  const end = addMonthsUtc(startYear, startMonth, spanMonths);
  const endMs = localMidnightMs(end.year, end.month, 1);
  return {
    basis,
    year,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    dateRule: option.dateRule,
    dayCount: Math.round((endMs - startMs) / 86_400_000),
  };
}

// ---------------------------------------------------------------------------
// Acting scope (assigned-system enforcement, visible in the request UI)
// ---------------------------------------------------------------------------

export interface ActorReportScope {
  readonly principalId: string;
  readonly displayName: string;
  readonly role: string;
  readonly reportableSystemIds: readonly string[];
  /** Why the actor can generate (or why not, when reportableSystemIds is empty). */
  readonly basis: string;
  /** Delegation window when the authority is a deputy delegation (null otherwise). */
  readonly delegation: { effectiveAt: string; expiresAt: string; delegatedBy: string } | null;
}

function withinWindow(ent: EntitlementRecord, atMs: number): boolean {
  if (ent.status !== 'active') return false;
  if (Date.parse(ent.effectiveAt) > atMs) return false;
  if (ent.expiresAt !== null && atMs >= Date.parse(ent.expiresAt)) return false;
  const delegation = ent.delegation ?? null;
  if (delegation) {
    if (Date.parse(delegation.effectiveAt) > atMs) return false;
    if (atMs >= Date.parse(delegation.expiresAt)) return false;
  }
  return true;
}

/**
 * Which distribution systems the actor may generate reports for at `now`
 * (mirror of the engine's allow rules for action generate-reports: an
 * explicit grant (or statewide-administration) on a currently-valid,
 * in-scope assignment). The SERVER re-evaluates the real engine on every
 * request; this model only drives what the picker shows.
 */
export function actorReportScope(principalId: string, now: string = FIXTURE_CLOCK): ActorReportScope | null {
  const user = users.find((candidate) => candidate.id === principalId);
  if (!user || user.active !== true) return null;
  const atMs = Date.parse(now);
  const systemIds = new Set<string>();
  let delegation: ActorReportScope['delegation'] = null;
  let statewide = false;
  for (const ent of entitlements) {
    if (ent.principalId !== principalId || !withinWindow(ent, atMs)) continue;
    if (!ent.capabilities.includes('generate-reports') && !ent.capabilities.includes('statewide-administration')) continue;
    if (ent.scopeType === 'system' && ent.scopeId) systemIds.add(ent.scopeId);
    if (ent.scopeType === 'statewide') statewide = true;
    if (ent.delegation) delegation = ent.delegation;
  }
  const reportable = statewide ? systems.map((system) => system.id) : [...systemIds].sort();
  const role = user.roles[0] ?? 'user';
  const basis =
    reportable.length > 0
      ? statewide
        ? 'statewide-administration (every system)'
        : `generate-reports assignment${reportable.length > 1 ? 's' : ''}: ${reportable.join(', ')}`
      : delegation
        ? 'no generate-reports capability inside the current delegation window'
        : 'no generate-reports capability held';
  return { principalId, displayName: user.displayName, role, reportableSystemIds: reportable, basis, delegation };
}

export interface SiteOption {
  readonly stationId: string;
  readonly displayName: string;
  readonly status: string;
  readonly flowStreamIds: readonly string[];
}

/** Reporting sites of a system for the subset picker (discharge streams only count as flow sites). */
export function systemSiteOptions(systemId: string): readonly SiteOption[] {
  return stations
    .filter((station) => station.systemId === systemId)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((station) => ({
      stationId: station.id,
      displayName: station.displayName,
      status: station.status,
      flowStreamIds: station.datastreams.filter((stream) => isFlowStream(stream)).map((stream) => stream.id),
    }));
}

// ---------------------------------------------------------------------------
// Report shape (structural mirror of the API GeneratedReport; no runtime import)
// ---------------------------------------------------------------------------

export type DailyNoteCode =
  | 'no-data'
  | 'declared-gap'
  | 'range-excluded'
  | 'null-frame'
  | 'estimated'
  | 'suspect-zero'
  | 'duplicate-timestamp'
  | 'below-selected-basis'
  | 'late-arrival';

/** Text+shape legend for the note vocabulary (FR-062: never color alone). */
export const NOTE_LEGEND: readonly { shape: string; code: DailyNoteCode; label: string }[] = [
  { shape: '∅', code: 'no-data', label: 'No usable data (null volume, never zero)' },
  { shape: '▨', code: 'declared-gap', label: 'Declared outage gap overlapping the day' },
  { shape: '▲', code: 'range-excluded', label: 'Out-of-range or negative reading (kept, excluded from stats)' },
  { shape: '▱', code: 'null-frame', label: 'Reported-but-empty frame' },
  { shape: '≈', code: 'estimated', label: 'Estimated share above zero' },
  { shape: '●', code: 'suspect-zero', label: 'Suspect zero (reported, covered, flagged)' },
  { shape: '⧉', code: 'duplicate-timestamp', label: 'Duplicate timestamps (retransmission wins)' },
  { shape: '▼', code: 'below-selected-basis', label: 'Below the selected processing basis (raw shown)' },
  { shape: '◷', code: 'late-arrival', label: 'Late arrival (more than 6 h after observation)' },
] as const;

export interface DailyRowLike {
  readonly key: string;
  readonly volumeAcreFeet: number | null;
  readonly meanValue: number | null;
  readonly coverageFraction: number;
  readonly estimatedProportion: number;
  readonly noteCodes: readonly DailyNoteCode[];
}

export interface StreamSectionLike {
  readonly streamId: string;
  readonly stationDisplayName: string;
  readonly unitId: string;
  readonly cadenceMinutes: number;
  readonly method: string;
  readonly daily: readonly DailyRowLike[];
  readonly totals: {
    readonly volumeAcreFeet: number;
    readonly coveredSeconds: number;
    readonly durationSeconds: number;
    readonly coverageFraction: number;
    readonly estimatedSeconds: number;
    readonly estimatedProportion: number;
    readonly dayCount: number;
    readonly daysWithNoData: number;
  };
  readonly qualityNotes: readonly string[];
  readonly coverageNotes: readonly string[];
}

export interface ReportLike {
  readonly reportId: string;
  readonly version: number;
  readonly supersedes: string | null;
  readonly system: { readonly id: string; readonly name: string };
  readonly requestedBy: string;
  readonly period: { readonly basis: PeriodBasis; readonly year: number; readonly start: string; readonly end: string; readonly dateRule: string; readonly timeZone: string };
  readonly processingBasis: ProcessingBasis;
  readonly extractionTime: string;
  readonly sections: {
    readonly sites: readonly {
      stationId: string;
      stationDisplayName: string;
      status: string;
      streams: readonly StreamSectionLike[];
      excludedStreams: readonly { streamId: string; reason: string }[];
    }[];
    readonly excludedSites: readonly { stationId: string; stationDisplayName: string; reason: string }[];
    readonly totals: {
      readonly noDoubleCountPolicy: string;
      readonly combinedVolumeAcreFeet: number | null;
      readonly categories: readonly { category: string; label: string; streamIds: readonly string[]; volumeAcreFeet: number; coverageFraction: number; estimatedProportion: number }[];
      readonly excludedStreams: readonly { streamId: string; reason: string }[];
    };
    readonly formulas: { readonly methodVersion: string; readonly roundingPolicy: string; readonly statements: readonly { id: string; statement: string; methodRef: string }[] };
    readonly provenance: {
      readonly extractionTime: string;
      readonly methodVersion: string;
      readonly dataVersion: string;
      readonly streams: readonly {
        streamId: string;
        stationDisplayName: string;
        basis: string;
        revisedObservations: readonly { observationId: string; logicalKey: string; chainVersion: number; headRevisionId: string; headProcessingLevel: string; headRecordedAt: string; usedAtSelectedBasis: boolean }[];
        usedRevisionCount: number;
        rawFallbackCount: number;
      }[];
    };
  };
  readonly contentHash: string;
}

// ---------------------------------------------------------------------------
// Demo generation (numerics mirror of the API domain; API stays authoritative)
// ---------------------------------------------------------------------------

const CUBIC_FEET_PER_ACRE_FOOT = 43_560;
const AGGREGATION_METHOD = 'rectangle-right@1';
const MATURITY: Record<ProcessingBasis, number> = { raw: 0, provisional: 1, reviewed: 2, 'best-available': 3 };

function isFlowStream(stream: DatastreamRecord): boolean {
  return stream.observedPropertyId === 'discharge' && stream.unitId === 'cfs';
}

function accountingCategoryOf(station: StationRecord): string | null {
  if (station.waterSourceTypeId === 'surface-storage-release') return 'reservoir-release';
  if (station.siteTypeId === 'natural-channel') return 'natural-channel-flow';
  if (station.siteTypeId === 'flume' || station.siteTypeId === 'weir') return 'canal-delivery';
  return null;
}

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  'natural-channel-flow': 'Natural channel flow (mainstem gauges)',
  'canal-delivery': 'Canal and diversion delivery',
  'reservoir-release': 'Reservoir release',
};

const NO_DOUBLE_COUNT_POLICY =
  'Totals are reported per accounting category and are never summed across categories: the same water can be measured at an upstream gauge, a downstream gauge and a canal delivery.';

interface SelectedReading {
  readonly observationId: string;
  readonly logicalKey: string;
  readonly observedAtMs: number;
  readonly receivedAtMs: number;
  readonly value: number | null;
  readonly revisionId: string | null;
  readonly estimated: boolean;
  readonly belowBasis: boolean;
  readonly duplicate: boolean;
  readonly lateArrival: boolean;
}

function chainFor(observationId: string): RevisionRecord[] {
  return revisions
    .filter((revision) => revision.targetObservationId === observationId)
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || (a.id < b.id ? -1 : 1));
}

/** Duplicate-timestamp normalization + the at-or-above revision ladder (mirror of the API). */
function selectedReadings(rows: readonly ObservationRecord[], basis: ProcessingBasis): SelectedReading[] {
  const sorted = [...rows].sort(
    (a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || Date.parse(a.receivedAt) - Date.parse(b.receivedAt) || (a.sourceEventId < b.sourceEventId ? -1 : 1),
  );
  const selected: SelectedReading[] = [];
  let i = 0;
  while (i < sorted.length) {
    const instant = sorted[i]!.observedAt;
    let j = i + 1;
    while (j < sorted.length && sorted[j]!.observedAt === instant) j += 1;
    const chosen = sorted[j - 1]!;
    const duplicate = j - 1 - i > 0;
    const chain = chainFor(chosen.id);
    let value = chosen.value;
    let revisionId: string | null = null;
    let qualifiers: readonly string[] = [];
    let belowBasis = false;
    if (basis !== 'raw' && chain.length > 0) {
      const pick = basis === 'best-available' ? chain[chain.length - 1]! : [...chain].reverse().find((revision) => MATURITY[revision.processingLevel] >= MATURITY[basis]) ?? null;
      if (pick) {
        value = pick.value;
        revisionId = pick.id;
        qualifiers = pick.qualifierIds;
      } else {
        belowBasis = true;
      }
    }
    selected.push({
      observationId: chosen.id,
      logicalKey: chosen.logicalKey,
      observedAtMs: Date.parse(chosen.observedAt),
      receivedAtMs: Date.parse(chosen.receivedAt),
      value,
      revisionId,
      estimated: chosen.valueType === 'estimated' || qualifiers.includes('interpolate'),
      belowBasis,
      duplicate,
      lateArrival: Date.parse(chosen.receivedAt) - Date.parse(chosen.observedAt) > 6 * 3_600_000,
    });
    i = j;
  }
  return selected;
}

function dayKeyOf(epochMs: number): string {
  const p = zonedParts(epochMs, PROGRAM_TIME_ZONE);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function dayStartMs(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return localMidnightMs(year!, month!, day!);
}

function nextDayKey(key: string): string {
  const [year, month, day] = key.split('-').map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day!) + 86_400_000);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function streamRows(
  stream: DatastreamRecord,
  windowStartMs: number,
  windowEndMs: number,
  basis: ProcessingBasis,
): { rows: DailyRowLike[]; readings: SelectedReading[]; coveredSeconds: number; durationSeconds: number; estimatedSeconds: number } {
  const cadenceMs = stream.cadenceMinutes * 60_000;
  const readings = selectedReadings(
    observations.filter((row) => row.streamId === stream.id && Date.parse(row.observedAt) >= windowStartMs - cadenceMs && Date.parse(row.observedAt) < windowEndMs),
    basis,
  );
  const streamGaps = gaps.filter((gap) => gap.streamId === stream.id);
  const rows: DailyRowLike[] = [];
  let totalCoveredSeconds = 0;
  let totalDurationSeconds = 0;
  let totalEstimatedSeconds = 0;
  let key = dayKeyOf(windowStartMs);
  const lastKey = dayKeyOf(windowEndMs - 1);
  for (; key <= lastKey; key = nextDayKey(key)) {
    const startMs = dayStartMs(key);
    const endMs = dayStartMs(nextDayKey(key));
    const durationSeconds = (endMs - startMs) / 1000;
    let coveredSeconds = 0;
    let cubicFeet = 0;
    let estimatedSeconds = 0;
    const inDay: SelectedReading[] = [];
    for (let i = 0; i < readings.length; i += 1) {
      const reading = readings[i]!;
      if (reading.observedAtMs >= endMs) break;
      if (reading.observedAtMs >= startMs) inDay.push(reading);
      const usable = reading.value !== null && reading.value >= stream.validRangeMin && reading.value <= stream.validRangeMax;
      if (!usable) continue;
      const rawEndMs = reading.observedAtMs + cadenceMs;
      const nextMs = i + 1 < readings.length ? readings[i + 1]!.observedAtMs : Number.POSITIVE_INFINITY;
      const sliceEndMs = Math.min(rawEndMs, nextMs, endMs);
      const sliceStartMs = Math.max(reading.observedAtMs, startMs);
      if (sliceEndMs <= sliceStartMs) continue;
      const seconds = (sliceEndMs - sliceStartMs) / 1000;
      coveredSeconds += seconds;
      cubicFeet += (reading.value as number) * seconds;
      if (reading.estimated) estimatedSeconds += seconds;
    }
    const codes: DailyNoteCode[] = [];
    const usableInDay = inDay.filter((reading) => reading.value !== null && reading.value >= stream.validRangeMin && reading.value <= stream.validRangeMax);
    if (coveredSeconds === 0) codes.push('no-data');
    if (streamGaps.some((gap) => Date.parse(gap.end) > startMs && Date.parse(gap.start) < endMs)) codes.push('declared-gap');
    if (inDay.some((reading) => reading.value !== null && (reading.value > stream.validRangeMax || reading.value < stream.validRangeMin))) codes.push('range-excluded');
    if (inDay.some((reading) => reading.value === null)) codes.push('null-frame');
    if (estimatedSeconds > 0) codes.push('estimated');
    if (usableInDay.some((reading) => reading.value === 0)) codes.push('suspect-zero');
    if (inDay.some((reading) => reading.duplicate)) codes.push('duplicate-timestamp');
    if (inDay.some((reading) => reading.belowBasis)) codes.push('below-selected-basis');
    if (inDay.some((reading) => reading.lateArrival)) codes.push('late-arrival');
    rows.push({
      key,
      volumeAcreFeet: coveredSeconds > 0 ? cubicFeet / CUBIC_FEET_PER_ACRE_FOOT : null,
      meanValue: coveredSeconds > 0 ? cubicFeet / coveredSeconds : null,
      coverageFraction: durationSeconds > 0 ? coveredSeconds / durationSeconds : 0,
      estimatedProportion: coveredSeconds > 0 ? estimatedSeconds / coveredSeconds : 0,
      noteCodes: codes,
    });
    totalCoveredSeconds += coveredSeconds;
    totalDurationSeconds += durationSeconds;
    totalEstimatedSeconds += estimatedSeconds;
  }
  return {
    rows,
    readings: readings.filter((reading) => reading.observedAtMs >= windowStartMs),
    coveredSeconds: totalCoveredSeconds,
    durationSeconds: totalDurationSeconds,
    estimatedSeconds: totalEstimatedSeconds,
  };
}

/** Deterministic 64-bit-style digest (two FNV-1a 32-bit lanes) - demo stand-in for the server's sha256. */
export function demoDigest(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = (h1 ^ code) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + code + i) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(2);
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

export interface DemoReportRequest {
  readonly systemId: string;
  readonly siteIds: readonly string[] | null;
  readonly period: { basis: PeriodBasis; year: number };
  readonly processingBasis: ProcessingBasis;
  readonly include: { dailyTable: boolean; qualityNotes: boolean; gapDetail: boolean };
}

export const DEFAULT_INCLUDE = { dailyTable: true, qualityNotes: true, gapDetail: true } as const;

/**
 * Demo generation over the fixture world (the server's generateReport is the
 * authoritative implementation; this mirror exists until the HTTP service is
 * wired - see README.md). Deterministic: same inputs + same extraction time
 * produce an identical report and hash.
 */
export function buildFixtureReport(request: DemoReportRequest, actorId = 'principal-cody-commissioner', now: string = FIXTURE_CLOCK): ReportLike {
  const window = periodWindow(request.period.basis, request.period.year);
  const windowStartMs = Date.parse(window.start);
  const windowEndMs = Date.parse(window.end);

  const allStations = stations
    .filter((station) => station.systemId === request.systemId)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const wanted = request.siteIds === null ? null : new Set(request.siteIds);
  const scoped = allStations.filter((station) => wanted === null || wanted.has(station.id));

  const sites: {
    stationId: string;
    stationDisplayName: string;
    status: string;
    streams: StreamSectionLike[];
    excludedStreams: { streamId: string; reason: string }[];
  }[] = [];
  const excludedSites: { stationId: string; stationDisplayName: string; reason: string }[] = [];
  const totalsExcluded: { streamId: string; reason: string }[] = [];
  const included: { stream: StreamSectionLike; category: string | null; station: StationRecord; streamRecord: DatastreamRecord }[] = [];

  for (const station of scoped) {
    if (station.status !== 'active') {
      excludedSites.push({ stationId: station.id, stationDisplayName: station.displayName, reason: `station ${station.status} (measurement lifecycle closed; excluded from reporting)` });
      continue;
    }
    const streams: StreamSectionLike[] = [];
    const excludedStreams: { streamId: string; reason: string }[] = [];
    for (const stream of [...station.datastreams].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (!isFlowStream(stream)) {
        const reason = `dimension mismatch: reports aggregate discharge in cfs; ${stream.observedPropertyId} in ${stream.unitId} is a different dimension`;
        excludedStreams.push({ streamId: stream.id, reason });
        totalsExcluded.push({ streamId: stream.id, reason });
        continue;
      }
      const { rows, coveredSeconds, durationSeconds, estimatedSeconds } = streamRows(stream, windowStartMs, windowEndMs, request.processingBasis);
      let volume = 0;
      let daysWithNoData = 0;
      for (const row of rows) {
        volume += row.volumeAcreFeet ?? 0;
        if (row.coverageFraction === 0) daysWithNoData += 1;
      }
      const category = accountingCategoryOf(station);
      if (category === null) totalsExcluded.push({ streamId: stream.id, reason: `no governed accounting category for site type ${station.siteTypeId} / water source ${station.waterSourceTypeId}` });
      const streamGaps = gaps.filter((gap) => gap.streamId === stream.id && Date.parse(gap.end) > windowStartMs && Date.parse(gap.start) < windowEndMs);
      const qualityNotes: string[] = [];
      if (request.include.qualityNotes) {
        if (request.include.gapDetail) {
          for (const gap of streamGaps) {
            const hours = (Math.min(Date.parse(gap.end), windowEndMs) - Math.max(Date.parse(gap.start), windowStartMs)) / 3_600_000;
            qualityNotes.push(`declared gap ${gap.id} (${gap.reason}): ${gap.start} to ${gap.end}; ${hours.toFixed(1)} h inside the period; missing readings are never zero-filled`);
          }
        } else if (streamGaps.length > 0) {
          qualityNotes.push(`declared gaps overlapping the period: ${streamGaps.length} (set gap detail for per-gap rows)`);
        }
      }
      const section: StreamSectionLike = {
        streamId: stream.id,
        stationDisplayName: station.displayName,
        unitId: stream.unitId,
        cadenceMinutes: stream.cadenceMinutes,
        method: AGGREGATION_METHOD,
        daily: request.include.dailyTable ? rows : [],
        totals: {
          volumeAcreFeet: volume,
          coveredSeconds,
          durationSeconds,
          coverageFraction: durationSeconds > 0 ? coveredSeconds / durationSeconds : 0,
          estimatedSeconds,
          estimatedProportion: coveredSeconds > 0 ? estimatedSeconds / coveredSeconds : 0,
          dayCount: rows.length,
          daysWithNoData,
        },
        qualityNotes,
        coverageNotes: [
          `period coverage: ${coveredSeconds} of ${durationSeconds} s (${Math.round((durationSeconds > 0 ? coveredSeconds / durationSeconds : 0) * 100)}%)`,
          `days with no usable data: ${daysWithNoData} of ${rows.length} (unavailable days carry null volume, never zero)`,
        ],
      };
      streams.push(section);
      included.push({ stream: section, category, station, streamRecord: stream });
    }
    sites.push({ stationId: station.id, stationDisplayName: station.displayName, status: station.status, streams, excludedStreams });
  }

  const categoryOrder = ['natural-channel-flow', 'canal-delivery', 'reservoir-release'];
  const categories = categoryOrder
    .filter((category) => included.some((entry) => entry.category === category))
    .map((category) => {
      const entries = included.filter((entry) => entry.category === category);
      const volume = entries.reduce((sum, entry) => sum + entry.stream.totals.volumeAcreFeet, 0);
      const covered = entries.reduce((sum, entry) => sum + entry.stream.totals.coveredSeconds, 0);
      const duration = entries.reduce((sum, entry) => sum + entry.stream.totals.durationSeconds, 0);
      return {
        category,
        label: CATEGORY_LABELS[category] ?? category,
        streamIds: entries.map((entry) => entry.stream.streamId),
        volumeAcreFeet: volume,
        coverageFraction: duration > 0 ? covered / duration : 0,
        estimatedProportion: covered > 0 ? entries.reduce((sum, entry) => sum + entry.stream.totals.estimatedSeconds, 0) / covered : 0,
      };
    });

  const provenanceStreams = included
    .map((entry) => {
      const inWindow = observations.filter((row) => row.streamId === entry.stream.streamId && Date.parse(row.observedAt) >= windowStartMs && Date.parse(row.observedAt) < windowEndMs);
      const labels = inWindow
        .map((row) => {
          const chain = chainFor(row.id);
          if (chain.length === 0) return null;
          const head = chain[chain.length - 1]!;
          const selected = selectedReadings([row], request.processingBasis)[0] ?? null;
          return {
            observationId: row.id,
            logicalKey: row.logicalKey,
            chainVersion: chain.length,
            headRevisionId: head.id,
            headProcessingLevel: head.processingLevel,
            headRecordedAt: head.recordedAt,
            usedAtSelectedBasis: selected?.revisionId === head.id,
          };
        })
        .filter((label): label is NonNullable<typeof label> => label !== null);
      const usedCount = labels.filter((label) => label.usedAtSelectedBasis).length;
      return {
        streamId: entry.stream.streamId,
        stationDisplayName: entry.station.displayName,
        basis: request.processingBasis,
        revisedObservations: labels,
        usedRevisionCount: usedCount,
        rawFallbackCount: request.processingBasis === 'raw' ? 0 : inWindow.filter((row) => (selectedReadings([row], request.processingBasis)[0] ?? { belowBasis: false }).belowBasis).length,
      };
    })
    .sort((a, b) => (a.streamId < b.streamId ? -1 : 1));

  const dataVersion = demoDigest(
    canonicalize({
      seed: 'utah-water-fixture-v1',
      kind: 'report-data-version@1',
      streams: included.map((entry) => ({
        streamId: entry.stream.streamId,
        observations: observations
          .filter((row) => row.streamId === entry.stream.streamId && Date.parse(row.observedAt) >= windowStartMs && Date.parse(row.observedAt) < windowEndMs)
          .map((row) => ({ logicalKey: row.logicalKey, chain: chainFor(row.id).map((revision) => ({ id: revision.id, value: revision.value, processingLevel: revision.processingLevel, recordedAt: revision.recordedAt })) })),
      })),
    }),
  );

  const systemName = systems.find((system) => system.id === request.systemId)?.name ?? request.systemId;
  const sections: ReportLike['sections'] = {
    sites,
    excludedSites,
    totals: { noDoubleCountPolicy: NO_DOUBLE_COUNT_POLICY, combinedVolumeAcreFeet: null, categories, excludedStreams: totalsExcluded },
    formulas: {
      methodVersion: AGGREGATION_METHOD,
      roundingPolicy: 'derived values are stored at full precision; presentation rounds volumes to 3 decimals and percentages to whole numbers',
      statements: [
        { id: 'volume', statement: `daily volume (acre-feet) = sum over covered intervals of (rate in cfs x seconds) / ${CUBIC_FEET_PER_ACRE_FOOT}`, methodRef: AGGREGATION_METHOD },
        { id: 'coverage', statement: 'coverage fraction = covered seconds / local day duration (a DST day is 82 800 or 90 000 s, never a flat 86 400 s)', methodRef: AGGREGATION_METHOD },
        { id: 'missing', statement: 'a missing reading is not zero: gaps, null frames and excluded spikes leave their interval uncovered', methodRef: AGGREGATION_METHOD },
        { id: 'no-double-count', statement: NO_DOUBLE_COUNT_POLICY, methodRef: 'accounting-categories@1' },
        { id: 'period', statement: `period basis "${request.period.basis}": ${window.dateRule}`, methodRef: 'period-basis@1' },
      ],
    },
    provenance: { extractionTime: now, methodVersion: AGGREGATION_METHOD, dataVersion, streams: provenanceStreams },
  };
  const contentHash = demoDigest(
    canonicalize({
      system: { id: request.systemId },
      requestedBy: actorId,
      period: { basis: window.basis, year: window.year, start: window.start, end: window.end },
      processingBasis: request.processingBasis,
      include: request.include,
      extractionTime: now,
      sections,
    }),
  );
  return {
    reportId: `rep-${contentHash.slice(0, 12)}`,
    version: 1,
    supersedes: null,
    system: { id: request.systemId, name: systemName },
    requestedBy: actorId,
    period: { basis: window.basis, year: window.year, start: window.start, end: window.end, dateRule: window.dateRule, timeZone: PROGRAM_TIME_ZONE },
    processingBasis: request.processingBasis,
    extractionTime: now,
    sections,
    contentHash,
  };
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export function formatVolume(value: number | null): string {
  return value === null ? 'Unavailable' : `${value.toFixed(3)} acre-feet`;
}

export function formatMean(value: number | null): string {
  return value === null ? 'Unavailable' : value.toFixed(2);
}

export function formatPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function noteSymbols(codes: readonly DailyNoteCode[]): string {
  return codes.length === 0 ? '—' : codes.map((code) => NOTE_LEGEND.find((entry) => entry.code === code)?.shape ?? '?').join(' ');
}

export function noteText(codes: readonly DailyNoteCode[]): string {
  return codes.length === 0 ? 'none' : codes.join(', ');
}

export function supersededBanner(report: ReportLike): string | null {
  if (report.supersedes === null) return null;
  return `Superseded version: report v${report.version} (${report.reportId}) supersedes ${report.supersedes}. Regeneration creates a new version and never rewrites the prior one; immutable finalization is R2 (FR-029).`;
}

export function hashFooter(report: ReportLike): string {
  return `content ${report.contentHash} · data version ${report.sections.provenance.dataVersion} · ${report.sections.provenance.methodVersion}`;
}

/** Volume series for the configurable-size daily chart (null days stay gaps, never zero). */
export function volumeChartPoints(stream: StreamSectionLike): readonly { key: string; volume: number | null }[] {
  return stream.daily.map((row) => ({ key: row.key, volume: row.volumeAcreFeet }));
}
