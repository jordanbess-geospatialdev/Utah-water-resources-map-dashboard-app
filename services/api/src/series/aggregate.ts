/**
 * Bounded series loading and calendar aggregation (WD-008; FR-005, FR-006,
 * FR-066). Numerical and temporal rules implemented here, per the technical
 * specification:
 *
 * - Half-open intervals [start, end) everywhere; effective bounds returned.
 * - Aggregation windows are LOCAL calendar windows in America/Denver; a
 *   reporting day is never redefined by browser time. The DST spring-forward
 *   day 2026-03-08 lasts 82 800 s (23 local hours) and the fall-back day
 *   2026-11-01 lasts 90 000 s (25 local hours); durations come from the zone,
 *   so a daily volume can never be mean x 24 h.
 * - Volume uses interval semantics, not mean x duration: every reading is a
 *   rate representative of the declared cadence interval
 *   [observedAt, observedAt + cadence) intersected with [next reading,
 *   ...) and the bucket window; acre-feet = integrated cubic feet / 43 560.
 *   A reading never stretches across a later reading, across a missing slot,
 *   or beyond its cadence - that would be silent interpolation.
 * - Gap policy: missing is missing. A null frame (reported-but-empty), an
 *   absent cadence slot, a declared gap and a range-excluded spike all leave
 *   their interval UNCOVERED; coverage fraction and estimated proportion are
 *   returned, and nothing is ever zero-filled or silently interpolated.
 *   Values outside [validRangeMin, validRangeMax] are excluded from means and
 *   volumes but stay present (with flags) in the raw listing.
 * - Zero is a reported value: a suspect zero counts as covered data; it is
 *   flagged, never confused with missing.
 * - Duplicate timestamps normalize for statistics to the latest-received
 *   retransmission (obs-q-017 supersedes obs-q-016 at 2026-03-07T10:00Z);
 *   both originals stay visible in the raw listing with flags.
 * - The processing-level selector changes values: `raw` shows originals;
 *   `best-available` shows the head revision; `provisional`/`reviewed` show
 *   the latest revision whose governed level reached the selected maturity,
 *   falling back to the raw value with a `below-selected-basis` flag when no
 *   revision reached it.
 */
import type { SeriesStore } from './load.ts';
import {
  AGGREGATION_METHOD,
  SERIES_LIMITS,
  type AggregatedInterval,
  type AggregationInterval,
  type DomainDenial,
  type DomainResult,
  type EffectivePoint,
  type GapRow,
  type ObservationRow,
  type ProcessingBasis,
  type ProcessingLevel,
  type RevisionRow,
  type SeasonName,
  type StreamMeta,
  denial,
} from './types.ts';
import {
  PROGRAM_TIME_ZONE,
  addDays,
  addMonths,
  isoWeek,
  localDateKey,
  localDateOf,
  localMidnightInstant,
  mondayOfWeek,
  seasonWindow,
} from './zone.ts';

/** Cubic feet per acre-foot: cfs integrated over seconds / 43560 = acre-feet. */
export const CUBIC_FEET_PER_ACRE_FOOT = 43_560;

const MATURITY: Readonly<Record<ProcessingLevel, number>> = {
  raw: 0,
  provisional: 1,
  reviewed: 2,
  'best-available': 3,
};

const LATE_ARRIVAL_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface SeriesRequest {
  readonly streamId: string;
  /** UTC instants; half-open [start, end); bounded by SERIES_LIMITS.maxWindowDays. */
  readonly start: string;
  readonly end: string;
  readonly basis: ProcessingBasis;
  readonly interval: AggregationInterval;
  /** Season window used when interval === 'seasonal'. Default 'irrigation'. */
  readonly season?: SeasonName;
}

export interface RawListing {
  readonly points: readonly EffectivePoint[];
  readonly gaps: readonly GapRow[];
}

export interface AggregationResult {
  readonly streamId: string;
  readonly stationId: string;
  readonly stationDisplayName: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  readonly timeZone: string;
  readonly cadenceMinutes: number;
  readonly basis: ProcessingBasis;
  readonly interval: AggregationInterval;
  readonly requestedStart: string;
  readonly requestedEnd: string;
  /** Effective bounds: the enclosing calendar windows of the request (half-open). */
  readonly effectiveStart: string;
  readonly effectiveEnd: string;
  readonly method: string;
  readonly buckets: readonly AggregatedInterval[];
  /** Raw listing clipped to the REQUEST window: originals with revisions visible, spikes present with flags. */
  readonly rawPoints: readonly EffectivePoint[];
  readonly gaps: readonly GapRow[];
}

// ---------------------------------------------------------------------------
// Basis selection
// ---------------------------------------------------------------------------

export interface EffectiveValue {
  readonly value: number | null;
  readonly level: ProcessingLevel;
  readonly revisionId: string | null;
  readonly qualifierIds: readonly string[];
  readonly estimated: boolean;
  readonly belowBasis: boolean;
}

function flagsForEffective(
  value: number | null,
  stream: StreamMeta,
  extra: readonly ('estimated' | 'late-arrival' | 'duplicate-timestamp' | 'revised' | 'null-frame' | 'below-selected-basis')[],
): string[] {
  const flags: string[] = [];
  if (value === null) flags.push('null-frame');
  else if (value > stream.validRangeMax) flags.push('out-of-range');
  else if (value < stream.validRangeMin) flags.push('negative');
  else if (value === 0) flags.push('suspect-zero');
  flags.push(...extra);
  return flags;
}

function isLateArrival(observation: ObservationRow): boolean {
  return Date.parse(observation.receivedAt) - Date.parse(observation.observedAt) > LATE_ARRIVAL_MS;
}

/** Effective value of one observation at the selected basis (see module doc). */
export function effectiveValue(
  observation: ObservationRow,
  chain: readonly RevisionRow[],
  basis: ProcessingBasis,
): EffectiveValue {
  if (basis === 'raw' || chain.length === 0) {
    return {
      value: observation.value,
      level: 'raw',
      revisionId: null,
      qualifierIds: [],
      estimated: observation.valueType === 'estimated',
      belowBasis: false,
    };
  }
  const head = chain[chain.length - 1] as RevisionRow;
  const selected =
    basis === 'best-available'
      ? head
      : ([...chain].reverse().find((rev) => MATURITY[rev.processingLevel] >= MATURITY[basis]) ?? null);
  if (!selected) {
    return {
      value: observation.value,
      level: 'raw',
      revisionId: null,
      qualifierIds: [],
      estimated: observation.valueType === 'estimated',
      belowBasis: basis !== 'raw',
    };
  }
  return {
    value: selected.value,
    level: selected.processingLevel,
    revisionId: selected.id,
    qualifierIds: [...selected.qualifierIds],
    estimated: observation.valueType === 'estimated' || selected.qualifierIds.includes('interpolate'),
    belowBasis: false,
  };
}

/** A point is USABLE for statistics when its effective value exists and is inside the valid range. */
export function isUsable(point: EffectivePoint): boolean {
  return point.value !== null && !point.flags.includes('out-of-range') && !point.flags.includes('negative');
}

/** Normalize a stream's observations inside a window to effective points (duplicate timestamps collapse to the retransmission). */
export function effectivePoints(
  store: SeriesStore,
  stream: StreamMeta,
  windowStartMs: number,
  windowEndMs: number,
  basis: ProcessingBasis,
): EffectivePoint[] {
  const inWindow = store.observationsForStream(stream.id).filter((obs) => {
    const at = Date.parse(obs.observedAt);
    return at >= windowStartMs && at < windowEndMs;
  });

  const duplicateInstants = new Set<string>();
  for (let i = 1; i < inWindow.length; i += 1) {
    if (inWindow[i]?.observedAt === inWindow[i - 1]?.observedAt) duplicateInstants.add(inWindow[i]!.observedAt);
  }

  const points: EffectivePoint[] = [];
  let i = 0;
  while (i < inWindow.length) {
    const instant = inWindow[i]!.observedAt;
    let j = i + 1;
    while (j < inWindow.length && inWindow[j]!.observedAt === instant) j += 1;
    // Latest received wins (a retransmission supersedes; identical receipts break on sourceEventId order).
    const chosen = inWindow[j - 1]!;
    const collapsed = inWindow.slice(i, j - 1).map((obs) => obs.id);
    const chain = store.revisionChain(chosen.id);
    const eff = effectiveValue(chosen, chain, basis);
    const extras: Array<'estimated' | 'late-arrival' | 'duplicate-timestamp' | 'revised' | 'below-selected-basis'> = [];
    if (eff.estimated) extras.push('estimated');
    if (isLateArrival(chosen)) extras.push('late-arrival');
    if (collapsed.length > 0) extras.push('duplicate-timestamp');
    if (chain.length > 0) extras.push('revised');
    if (eff.belowBasis) extras.push('below-selected-basis');
    const rawExtras = [...extras];
    if (chosen.valueType === 'estimated' && !rawExtras.includes('estimated')) rawExtras.push('estimated');
    const rawValueFlags = flagsForEffective(chosen.value, stream, rawExtras);
    points.push({
      observationId: chosen.id,
      collapsedDuplicateIds: collapsed,
      observedAt: chosen.observedAt,
      receivedAt: chosen.receivedAt,
      sourceOffset: chosen.sourceOffset,
      sourceEventId: chosen.sourceEventId,
      sourceId: chosen.sourceId,
      value: eff.value,
      rawValue: chosen.value,
      unitId: chosen.unitId,
      valueType: chosen.valueType,
      processingLevel: eff.level,
      revisionId: eff.revisionId,
      qualifierIds: eff.qualifierIds,
      estimated: eff.estimated,
      flags: flagsForEffective(eff.value, stream, extras),
      rawFlags: rawValueFlags,
    });
    i = j;
  }
  return points;
}

// ---------------------------------------------------------------------------
// Interval windows
// ---------------------------------------------------------------------------

export interface CalendarWindow {
  readonly key: string;
  readonly startMs: number;
  readonly endMs: number;
}

function enumerateWindows(
  requestStartMs: number,
  requestEndMs: number,
  interval: AggregationInterval,
  season: SeasonName,
  zone: string,
): CalendarWindow[] {
  const windows: CalendarWindow[] = [];
  if (interval === 'daily') {
    let date = localDateOf(requestStartMs, zone);
    for (;;) {
      const startMs = localMidnightInstant(date, zone);
      if (startMs >= requestEndMs) break;
      const endMs = localMidnightInstant(addDays(date, 1), zone);
      windows.push({ key: localDateKey(date), startMs, endMs });
      date = addDays(date, 1);
    }
    return windows;
  }
  if (interval === 'weekly') {
    let date = mondayOfWeek(localDateOf(requestStartMs, zone));
    for (;;) {
      const startMs = localMidnightInstant(date, zone);
      if (startMs >= requestEndMs) break;
      const endMs = localMidnightInstant(addDays(date, 7), zone);
      const iso = isoWeek(date);
      windows.push({ key: `${iso.year}-W${String(iso.week).padStart(2, '0')}`, startMs, endMs });
      date = addDays(date, 7);
    }
    return windows;
  }
  if (interval === 'monthly') {
    let date = localDateOf(requestStartMs, zone);
    date = { year: date.year, month: date.month, day: 1 };
    for (;;) {
      const startMs = localMidnightInstant(date, zone);
      if (startMs >= requestEndMs) break;
      const next = addMonths(date, 1);
      const endMs = localMidnightInstant(next, zone);
      windows.push({ key: `${date.year}-${String(date.month).padStart(2, '0')}`, startMs, endMs });
      date = next;
    }
    return windows;
  }
  // seasonal: named season windows intersecting the request
  const firstYear = localDateOf(requestStartMs, zone).year;
  const lastYear = localDateOf(requestEndMs - 1, zone).year;
  for (let year = firstYear - 1; year <= lastYear + 1; year += 1) {
    const seasonRange = seasonWindow(season, year);
    const startMs = localMidnightInstant(seasonRange.start, zone);
    const endMs = localMidnightInstant(seasonRange.end, zone);
    if (endMs > requestStartMs && startMs < requestEndMs) {
      windows.push({ key: `${year}-${season}`, startMs, endMs });
    }
  }
  return windows.sort((a, b) => a.startMs - b.startMs);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface CoverSlice {
  seconds: number;
  value: number;
  estimated: boolean;
}

/**
 * Covered slices of one point's representative interval inside a bucket:
 * [observedAt, observedAt + cadence) clipped to the bucket and to the next
 * reading's instant (a reading never governs past a later reading).
 */
function coverSlices(
  points: readonly EffectivePoint[],
  pointIndex: number,
  windowStartMs: number,
  windowEndMs: number,
  cadenceSeconds: number,
): CoverSlice[] {
  const point = points[pointIndex]!;
  if (!isUsable(point)) return [];
  const start = Math.max(Date.parse(point.observedAt), windowStartMs);
  const rawEnd = Date.parse(point.observedAt) + cadenceSeconds * 1000;
  const nextReading = points[pointIndex + 1];
  const nominalEnd = nextReading ? Math.min(rawEnd, Date.parse(nextReading.observedAt)) : rawEnd;
  const end = Math.min(nominalEnd, windowEndMs);
  if (end <= start) return [];
  return [{ seconds: (end - start) / 1000, value: point.value as number, estimated: point.estimated }];
}

export function aggregateBucket(
  points: readonly EffectivePoint[],
  window: CalendarWindow,
  cadenceSeconds: number,
  gaps: readonly GapRow[],
): AggregatedInterval {
  const durationSeconds = (window.endMs - window.startMs) / 1000;
  let coveredSeconds = 0;
  let cubicFeet = 0;
  let estimatedSeconds = 0;
  let pointCount = 0;
  let excludedPointCount = 0;
  let nullPointCount = 0;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i]!;
    const observedMs = Date.parse(point.observedAt);
    if (observedMs >= window.startMs && observedMs < window.endMs) {
      pointCount += 1;
      if (point.value === null) nullPointCount += 1;
      else if (!isUsable(point)) excludedPointCount += 1;
    }
    // Coverage contribution: a reading observed BEFORE the bucket can still
    // govern its opening (a manual reading holds until the next visit), so
    // the slice - not the observation instant - decides membership.
    if (observedMs >= window.endMs) continue;
    for (const slice of coverSlices(points, i, window.startMs, window.endMs, cadenceSeconds)) {
      coveredSeconds += slice.seconds;
      cubicFeet += slice.value * slice.seconds;
      if (slice.estimated) estimatedSeconds += slice.seconds;
    }
  }
  const overlappingGaps = gaps
    .filter((gap) => Date.parse(gap.end) > window.startMs && Date.parse(gap.start) < window.endMs)
    .map((gap) => ({ id: gap.id, start: gap.start, end: gap.end, reason: gap.reason }));
  return {
    key: window.key,
    intervalStart: new Date(window.startMs).toISOString(),
    intervalEnd: new Date(window.endMs).toISOString(),
    durationSeconds,
    coveredSeconds,
    coverageFraction: durationSeconds > 0 ? coveredSeconds / durationSeconds : 0,
    estimatedSeconds,
    estimatedProportion: coveredSeconds > 0 ? estimatedSeconds / coveredSeconds : 0,
    meanValue: coveredSeconds > 0 ? cubicFeetPerSecond(cubicFeet, coveredSeconds) : null,
    volumeAcreFeet: coveredSeconds > 0 ? cubicFeet / CUBIC_FEET_PER_ACRE_FOOT : null,
    pointCount,
    excludedPointCount,
    nullPointCount,
    gaps: overlappingGaps,
  };
}

function cubicFeetPerSecond(cubicFeet: number, seconds: number): number {
  return cubicFeet / seconds;
}

/** Validate and bound a series window request. Returns the denial or the parsed instants. */
export function checkWindow(request: { start: string; end: string }): DomainResult<{ startMs: number; endMs: number }> {
  const startMs = Date.parse(request.start);
  const endMs = Date.parse(request.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return denial(400, 'MALFORMED_WINDOW', 'start and end must be RFC 3339 instants');
  }
  if (endMs <= startMs) {
    return denial(400, 'EMPTY_WINDOW', 'end must be after start (half-open [start, end))');
  }
  if ((endMs - startMs) / 86_400_000 > SERIES_LIMITS.maxWindowDays) {
    return denial(
      400,
      'REQUEST_WINDOW_TOO_LARGE',
      `requested window exceeds the server-side maximum of ${SERIES_LIMITS.maxWindowDays} days`,
    );
  }
  return { outcome: 'allowed', value: { startMs, endMs } };
}

/**
 * Aggregate one stream. Callers MUST pass the grant gate first
 * (grantCheck.readStream); this function is pure numerics over authorized data.
 */
export function aggregateSeries(store: SeriesStore, request: SeriesRequest): DomainResult<AggregationResult> {
  const stream = store.streamById(request.streamId);
  if (!stream) return denial(404, 'NOT_FOUND', 'stream not found');
  const window = checkWindow(request);
  if (window.outcome === 'denied') return window;

  const zone = stream.timeZone || PROGRAM_TIME_ZONE;
  const season: SeasonName = request.season ?? 'irrigation';
  const windows = enumerateWindows(window.value.startMs, window.value.endMs, request.interval, season, zone);
  if (windows.length === 0) {
    return denial(400, 'EMPTY_WINDOW', 'no calendar windows intersect the requested window');
  }

  const loadingStartMs = windows[0]!.startMs - Math.min(stream.cadenceMinutes, SERIES_LIMITS.maxLookBackDays * 24 * 60) * 60_000;
  const loadingEndMs = windows[windows.length - 1]!.endMs;
  const points = effectivePoints(store, stream, loadingStartMs, loadingEndMs, request.basis);
  const gaps = store.gapsForStream(stream.id);
  const cadenceSeconds = stream.cadenceMinutes * 60;

  const rawPoints = points.filter((point) => {
    const at = Date.parse(point.observedAt);
    return at >= window.value.startMs && at < window.value.endMs;
  });
  if (rawPoints.length > SERIES_LIMITS.maxRawPoints) {
    return denial(
      413,
      'RESULT_TOO_LARGE',
      `raw listing of ${rawPoints.length} points exceeds the inline limit of ${SERIES_LIMITS.maxRawPoints}; use aggregation or an export job`,
    );
  }

  return {
    outcome: 'allowed',
    value: {
      streamId: stream.id,
      stationId: stream.stationId,
      stationDisplayName: stream.stationDisplayName,
      observedPropertyId: stream.observedPropertyId,
      unitId: stream.unitId,
      timeZone: zone,
      cadenceMinutes: stream.cadenceMinutes,
      basis: request.basis,
      interval: request.interval,
      requestedStart: new Date(window.value.startMs).toISOString(),
      requestedEnd: new Date(window.value.endMs).toISOString(),
      effectiveStart: new Date(windows[0]!.startMs).toISOString(),
      effectiveEnd: new Date(loadingEndMs).toISOString(),
      method: AGGREGATION_METHOD,
      buckets: windows.map((calendarWindow) => aggregateBucket(points, calendarWindow, cadenceSeconds, gaps)),
      rawPoints,
      gaps,
    },
  };
}
