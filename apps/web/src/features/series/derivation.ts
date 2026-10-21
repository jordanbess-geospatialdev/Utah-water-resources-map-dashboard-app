/**
 * Pure fixtures -> chart-model derivation for the WD-008 series feature
 * (FR-005, FR-006, FR-062, FR-066). Dependency-free and pure like the
 * quality-history derivation: the panels pass the contract-fixture data in
 * (default: WD-006 shell loaders, read-only), derivation.test.ts feeds it
 * the frozen fixtures and synthetic edge rows.
 *
 * The numerical rules MIRROR services/api/src/series/aggregate.ts (the
 * authoritative implementation with its golden suite): local calendar days
 * in America/Denver, rectangle-right interval semantics, missing-never-zero
 * coverage. The daily numbers here are for on-chart annotations; the API
 * remains the source of truth - derivation.test.ts pins the same DST-day
 * goldens on both surfaces so they cannot drift apart silently.
 */

/** Structural subset of the shell SeriesPoint (no import; keep this module pure). */
export interface SeriesPointLike {
  readonly id: string;
  readonly streamId: string;
  readonly observedAt: string;
  readonly sourceOffset: string;
  readonly raw: number | null;
  readonly best: number | null;
  readonly valueType: 'observed' | 'estimated';
  readonly processingLevel: 'raw' | 'provisional' | 'reviewed' | 'best-available';
  readonly unitId: string;
  readonly receivedAt: string;
  readonly flags: readonly string[];
  readonly revisionIds: readonly string[];
}

/** Structural subset of the shell RevisionRecord. */
export interface RevisionLike {
  readonly id: string;
  readonly targetObservationId: string;
  readonly type: 'correction' | 'level-advance';
  readonly value: number;
  readonly unitId: string;
  readonly processingLevel: 'provisional' | 'reviewed' | 'best-available';
  readonly qualifierIds: readonly string[];
  readonly reason: string;
  readonly actorId: string;
  readonly recordedAt: string;
}

export interface StreamLike {
  readonly id: string;
  readonly unitId: string;
  readonly cadenceMinutes: number;
  readonly validRangeMin: number;
  readonly validRangeMax: number;
  readonly timeZone: string;
}

export interface GapBandLike {
  readonly id: string;
  readonly start: string;
  readonly end: string;
  readonly reason: string;
}

export type ProcessingBasis = 'raw' | 'provisional' | 'reviewed' | 'best-available';

const MATURITY: Record<ProcessingBasis, number> = {
  raw: 0,
  provisional: 1,
  reviewed: 2,
  'best-available': 3,
};

export const PROGRAM_TIME_ZONE = 'America/Denver';

// ---------------------------------------------------------------------------
// Processing-basis selection (FR-066)
// ---------------------------------------------------------------------------

export interface SelectedPoint {
  /** The point with `best`/`processingLevel` replaced by the selected basis. */
  readonly point: SeriesPointLike;
  /** Effective value at the selected basis (null only for a null frame). */
  readonly value: number | null;
  readonly level: ProcessingBasis;
  readonly revisionId: string | null;
  readonly qualifiers: readonly string[];
  /** True when the basis fell back to raw (chain never reached the maturity). */
  readonly belowBasis: boolean;
  readonly estimated: boolean;
  /** Presentation rules: ice-affected marker / estimated dashes / spikes. */
  readonly marker: 'ice-affected' | 'estimated' | 'out-of-range' | 'negative' | 'revised' | 'plain';
}

function headChainFor(point: SeriesPointLike, revisions: readonly RevisionLike[]): RevisionLike[] {
  return revisions
    .filter((rev) => rev.targetObservationId === point.id)
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || (a.id < b.id ? -1 : 1));
}

/**
 * Select points at a processing basis (at-or-above ladder, mirroring
 * services/api/src/series/aggregate.ts): `raw` keeps originals;
 * `best-available` takes the chain head; `provisional`/`reviewed` take the
 * latest revision at or above the maturity, else fall back to raw flagged
 * `below-selected-basis`.
 */
export function selectAtBasis(
  points: readonly SeriesPointLike[],
  revisions: readonly RevisionLike[],
  basis: ProcessingBasis,
  stream: StreamLike,
): SelectedPoint[] {
  return points.map((point) => {
    const chain = headChainFor(point, revisions);
    let value = point.raw;
    let level: ProcessingBasis = 'raw';
    let revisionId: string | null = null;
    let qualifiers: readonly string[] = [];
    let belowBasis = false;
    if (basis !== 'raw' && chain.length > 0) {
      const selected =
        basis === 'best-available'
          ? chain[chain.length - 1]!
          : ([...chain].reverse().find((rev) => MATURITY[rev.processingLevel] >= MATURITY[basis]) ?? null);
      if (selected) {
        value = selected.value;
        level = selected.processingLevel;
        revisionId = selected.id;
        qualifiers = selected.qualifierIds;
      } else {
        belowBasis = true;
      }
    } else if (basis !== 'raw') {
      belowBasis = true;
    }
    const estimated = point.valueType === 'estimated' || qualifiers.includes('interpolate');
    // Range flags are re-derived from the EFFECTIVE value so the chart marks
    // what it plots (a corrected in-range value is not flagged negative),
    // while duplicate/late-arrival provenance flags carry over untouched.
    const carriedFlags = point.flags.filter(
      (flag) => flag !== 'estimated' && flag !== 'revised' && flag !== 'out-of-range' && flag !== 'negative' && flag !== 'suspect-zero' && flag !== 'null-frame',
    );
    const extraFlags: string[] = [...carriedFlags];
    if (value === null) extraFlags.push('null-frame');
    else if (value > stream.validRangeMax) extraFlags.push('out-of-range');
    else if (value < stream.validRangeMin) extraFlags.push('negative');
    else if (value === 0) extraFlags.push('suspect-zero');
    if (estimated) extraFlags.push('estimated');
    if (belowBasis) extraFlags.push('below-selected-basis');
    const outOfRange = value !== null && value > stream.validRangeMax;
    const negative = value !== null && value < stream.validRangeMin;
    let marker: SelectedPoint['marker'] = 'plain';
    if (qualifiers.includes('ice-affected')) marker = 'ice-affected';
    else if (outOfRange) marker = 'out-of-range';
    else if (negative) marker = 'negative';
    else if (estimated) marker = 'estimated';
    else if (revisionId !== null) marker = 'revised';
    return {
      point: { ...point, best: value, processingLevel: level, flags: extraFlags },
      value,
      level,
      revisionId,
      qualifiers,
      belowBasis,
      estimated,
      marker,
    };
  });
}

// ---------------------------------------------------------------------------
// Local calendar days (presentation mirror of services zone.ts)
// ---------------------------------------------------------------------------

function zonedYMD(epochMs: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochMs));
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  return `${map.year}-${map.month}-${map.day}`;
}

function localDayStartMs(ymd: string, zone: string): number {
  const [year, month, day] = ymd.split('-').map(Number);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const partsOf = (t: number) => {
    const map: Record<string, string> = {};
    for (const part of dtf.formatToParts(new Date(t))) map[part.type] = part.value;
    return {
      asUtc: Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour) % 24, Number(map.minute), Number(map.second)),
    };
  };
  const naive = Date.UTC(year!, month! - 1, day!);
  let t = naive - 7 * 3_600_000;
  for (let i = 0; i < 4; i += 1) {
    const next = naive - (partsOf(t).asUtc - Math.floor(t / 1000) * 1000);
    if (next === t) return t;
    t = next;
  }
  return t;
}

function addDaysToYMD(ymd: string, days: number): string {
  const [year, month, day] = ymd.split('-').map(Number);
  const d = new Date(Date.UTC(year!, month! - 1, day!) + days * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export interface DaySummary {
  readonly key: string; // local YYYY-MM-DD
  readonly startMs: number;
  readonly endMs: number;
  /** 82 800 on the 23-hour DST day, 90 000 on the 25-hour fall-back day. */
  readonly durationSeconds: number;
  readonly coveredSeconds: number;
  readonly coverageFraction: number;
  readonly estimatedProportion: number;
  readonly meanValue: number | null;
  readonly volumeAcreFeet: number | null;
  readonly gapHours: number;
  readonly spikeExcluded: boolean;
}

/** True when the value participates in means (present and inside the valid range). */
function usable(value: number | null, stream: StreamLike): boolean {
  return value !== null && value >= stream.validRangeMin && value <= stream.validRangeMax;
}

/**
 * Daily summaries with the API's interval semantics: each reading covers
 * [observedAt, observedAt + cadence) intersected with the local day and cut
 * at the next reading; missing stays uncovered; spikes are excluded from the
 * mean but reported. Deterministic; no clock.
 *
 * INPUT CONTRACT: `points` carry the basis-effective value in `best` (run
 * `selectAtBasis` first and pass the mapped `.point` list).
 */
export function dailySummaries(
  points: readonly SeriesPointLike[],
  stream: StreamLike,
  gaps: readonly GapBandLike[],
  zone: string = stream.timeZone || PROGRAM_TIME_ZONE,
): DaySummary[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const firstDay = zonedYMD(Date.parse(sorted[0]!.observedAt) - stream.cadenceMinutes * 60_000, zone);
  const lastDay = zonedYMD(Date.parse(sorted[sorted.length - 1]!.observedAt), zone);
  const summaries: DaySummary[] = [];
  const cadenceSeconds = stream.cadenceMinutes * 60;
  for (let day = firstDay; day <= lastDay; day = addDaysToYMD(day, 1)) {
    const startMs = localDayStartMs(day, zone);
    const endMs = localDayStartMs(addDaysToYMD(day, 1), zone);
    const durationSeconds = (endMs - startMs) / 1000;
    let coveredSeconds = 0;
    let cubicFeet = 0;
    let estimatedSeconds = 0;
    let spikeExcluded = false;
    for (let i = 0; i < sorted.length; i += 1) {
      const point = sorted[i]!;
      const atMs = Date.parse(point.observedAt);
      if (atMs >= endMs) break;
      if (!usable(point.best, stream)) {
        if (atMs >= startMs && point.best !== null) spikeExcluded = true;
        continue;
      }
      const rawEndMs = atMs + cadenceSeconds * 1000;
      const nextMs = i + 1 < sorted.length ? Date.parse(sorted[i + 1]!.observedAt) : Number.POSITIVE_INFINITY;
      const end = Math.min(rawEndMs, nextMs, endMs);
      const start = Math.max(atMs, startMs);
      if (end <= start) continue;
      const seconds = (end - start) / 1000;
      coveredSeconds += seconds;
      cubicFeet += (point.best as number) * seconds;
      if (point.valueType === 'estimated') estimatedSeconds += seconds;
    }
    const gapHours = gaps.reduce((hours, gap) => {
      const overlap = Math.min(Date.parse(gap.end), endMs) - Math.max(Date.parse(gap.start), startMs);
      return hours + Math.max(overlap, 0) / 3_600_000;
    }, 0);
    summaries.push({
      key: day,
      startMs,
      endMs,
      durationSeconds,
      coveredSeconds,
      coverageFraction: coveredSeconds / durationSeconds,
      estimatedProportion: coveredSeconds > 0 ? estimatedSeconds / coveredSeconds : 0,
      meanValue: coveredSeconds > 0 ? cubicFeet / coveredSeconds : null,
      volumeAcreFeet: coveredSeconds > 0 ? cubicFeet / 43_560 : null,
      gapHours,
      spikeExcluded,
    });
  }
  return summaries;
}

/** Local YYYY-MM-DD day keys covering [startMs, endMs) in `zone` (inclusive start day, exclusive end day). */
export function localDayKeys(startMs: number, endMs: number, zone: string = PROGRAM_TIME_ZONE): string[] {
  const keys: string[] = [];
  let day = zonedYMD(startMs, zone);
  const lastDay = zonedYMD(endMs - 1, zone);
  for (; day <= lastDay; day = addDaysToYMD(day, 1)) keys.push(day);
  return keys;
}

// ---------------------------------------------------------------------------
// Presentation rules (FR-062: text + shape, never color alone)
// ---------------------------------------------------------------------------

export interface LegendItem {
  readonly shape: string;
  readonly label: string;
}

/** Text+shape legend for the chart quality vocabulary. */
export const SERIES_LEGEND: readonly LegendItem[] = [
  { shape: '◆', label: 'Ice affected (corrected reading retained with qualifier)' },
  { shape: '▲', label: 'Out of range above sensor maximum - labelled, never clipped' },
  { shape: '▼', label: 'Negative / below valid minimum - excluded from means, shown in the table' },
  { shape: '≈', label: 'Estimated value - dashed marker and estimated share in the day summary' },
  { shape: '▨', label: 'Declared gap - hatched band, coverage hole, never zero-filled' },
  { shape: '∅', label: 'No value reported (null frame) - unavailable, not zero' },
];

/** Accessible label for one selected point (chart focus + table summary). */
export function pointAriaLabel(
  selected: SelectedPoint,
  unitId: string,
  formatValue: (value: number | null, unit: string) => string,
  formatTime: (at: string) => string,
): string {
  const flags = selected.point.flags.join(', ');
  return [
    `${formatTime(selected.point.observedAt)} Mountain Time`,
    `${selected.level} ${formatValue(selected.value, unitId)}`,
    `raw ${formatValue(selected.point.raw, unitId)}`,
    selected.revisionId !== null ? `revision ${selected.revisionId}` : 'no revision',
    selected.qualifiers.length > 0 ? `qualifiers ${selected.qualifiers.join(', ')}` : 'no qualifiers',
    flags.length > 0 ? `flags ${flags}` : 'no flags',
    selected.belowBasis ? 'below the selected processing basis; raw value shown' : null,
  ]
    .filter((part) => part !== null)
    .join('; ');
}

/** Coverage annotation text for a day summary (used under the chart). */
export function coverageAnnotation(day: DaySummary): string {
  const coveragePct = Math.round(day.coverageFraction * 100);
  const estimatedPct = Math.round(day.estimatedProportion * 100);
  const parts = [`${day.key}: ${coveragePct}% covered`];
  if (day.estimatedProportion > 0) parts.push(`${estimatedPct}% estimated`);
  if (day.gapHours > 0) parts.push(`${Math.round(day.gapHours)} h declared gap (no data, not zero)`);
  if (day.spikeExcluded) parts.push('range-excluded reading present (flagged, kept out of the mean)');
  if (day.coverageFraction === 0) parts.push('no usable data');
  return parts.join(' · ');
}
