/**
 * Pure view models for the recurring-quality feature (WD-013-R2, FR-043).
 *
 * No React, no fixtures, no clock: these functions map already-derived
 * trend incidents (the shape services/api/src/quality-trends returns,
 * including the curve-boundary annotations of curveDiagnostics.ts) onto
 * renderable table rows, chart series, filters and labels.
 *
 * The counting contract is carried end to end: one incident = one (site,
 * kind, cause-cluster) - the two-corrections chain on obs-q-032 stays ONE
 * incident with two evidence records, and every row shows BOTH numbers
 * (incidents and underlying records) so the table reconciles visibly to the
 * revision/QC/known-issue/rating-version records it summarizes.
 *
 * Every kind marker is a SHAPE plus a TEXT label (never color alone), per
 * the FR-034 accessibility rule the quality features follow.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const TREND_KINDS = ['qc-flag', 'correction', 'known-issue', 'curve-supersession'] as const;
export type TrendKind = (typeof TREND_KINDS)[number];

/** Shape + text labels: identity never rides on color alone. */
export const KIND_LABELS: Readonly<Record<TrendKind, string>> = Object.freeze({
  'qc-flag': 'QC flag',
  correction: 'Correction',
  'known-issue': 'Known issue',
  'curve-supersession': 'Curve supersession',
});

export const KIND_MARKERS: Readonly<Record<TrendKind, string>> = Object.freeze({
  'qc-flag': '▲',
  correction: '●',
  'known-issue': '■',
  'curve-supersession': '◆',
});

export const DEFAULT_PERIOD_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_PERIOD_COUNT = 4;
export const WEEK_MS = 7 * 24 * 60 * 60_000;
const RATE_MIN_SPAN_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Input view shapes (field-compatible with the API quality-trends types)
// ---------------------------------------------------------------------------

/** Curve-boundary annotation carried by an adjacent incident. */
export interface BoundaryAnnotationView {
  readonly boundaryAt: string;
  readonly label: string;
  readonly relation: 'before' | 'during' | 'after';
  readonly distanceMs: number;
}

/** One deduplicated incident, as returned by the API derivation. */
export interface IncidentView {
  readonly incidentId: string;
  readonly kind: TrendKind;
  readonly streamId: string;
  readonly stationId: string;
  readonly systemId: string;
  readonly visibility: 'public' | 'restricted' | 'internal';
  readonly causeKey: string;
  readonly causeLabel: string;
  readonly hitCount: number;
  readonly evidenceIds: readonly string[];
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly inWindow: boolean;
  readonly recordVisibility: 'public' | 'internal' | null;
  readonly lastRecordedAt: string | null;
  readonly boundaryAnnotations: readonly BoundaryAnnotationView[];
}

// ---------------------------------------------------------------------------
// Table rows
// ---------------------------------------------------------------------------

/** One table/chart row: one (site, kind, period) aggregate. */
export interface TrendRow {
  /** `${stationId}|${kind}|${periodIndex}` */
  readonly rowId: string;
  readonly stationId: string;
  readonly systemId: string;
  readonly visibility: 'public' | 'restricted' | 'internal';
  readonly kind: TrendKind;
  readonly kindLabel: string;
  readonly kindMarker: string;
  readonly periodIndex: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly periodLabel: string;
  /** Deduplicated incidents in this bucket (FR-043: never one row per revision). */
  readonly incidentCount: number;
  /** Underlying raw records behind those incidents (the reconciliation number). */
  readonly hitCount: number;
  readonly lastSeen: string;
  readonly lastSeenLabel: string;
  readonly timeSinceLastMs: number;
  readonly timeSinceLabel: string;
  /** Recurrences per week within the bucket; '—' when nothing recurred. */
  readonly recurrenceRatePerWeek: number;
  readonly recurrenceRateLabel: string;
  readonly causeLabels: readonly string[];
  readonly boundaryAnnotationLabels: readonly string[];
  readonly streamIds: readonly string[];
}

export interface BuildRowsOptions {
  /** Injected reference instant (never Date.now). */
  readonly now: string;
  readonly periodMs?: number;
  readonly periodCount?: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/** Period bucket of a lastSeen instant: 0 = current, capped at count - 1; null = future. */
export function periodIndexOf(lastSeen: string, now: string, periodMs: number, periodCount: number): number | null {
  const elapsed = Math.floor((Date.parse(now) - Date.parse(lastSeen)) / periodMs);
  if (elapsed < 0) return null;
  return Math.min(elapsed, periodCount - 1);
}

/**
 * Group incidents into (site, kind, period) rows. Pure and deterministic:
 * rows sort by (stationId, kind, periodIndex) and every count is a plain
 * sum over the group's incidents.
 */
export function buildTrendRows(incidents: readonly IncidentView[], options: BuildRowsOptions): readonly TrendRow[] {
  const periodMs = options.periodMs ?? DEFAULT_PERIOD_MS;
  const periodCount = options.periodCount ?? DEFAULT_PERIOD_COUNT;
  const nowMs = Date.parse(options.now);
  const groups = new Map<string, IncidentView[]>();
  for (const incident of incidents) {
    if (!incident.inWindow) continue;
    const periodIndex = periodIndexOf(incident.lastSeen, options.now, periodMs, periodCount);
    if (periodIndex === null) continue;
    const key = `${incident.stationId}|${incident.kind}|${periodIndex}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(incident);
    else groups.set(key, [incident]);
  }
  const rows: TrendRow[] = [];
  for (const [key, bucket] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const [stationId, kind, periodIndexText] = key.split('|') as [string, TrendKind, string];
    const periodIndex = Number(periodIndexText);
    const first = bucket[0] as IncidentView;
    const lastSeenMs = Math.max(...bucket.map((incident) => Date.parse(incident.lastSeen)));
    const firstSeenMs = Math.min(...bucket.map((incident) => Date.parse(incident.firstSeen)));
    const spanMs = Math.max(lastSeenMs - firstSeenMs, RATE_MIN_SPAN_MS);
    const incidentCount = bucket.length;
    const recurrenceRate = incidentCount > 1 ? (incidentCount - 1) / (spanMs / WEEK_MS) : 0;
    const annotations = new Set<string>();
    for (const incident of bucket) {
      for (const annotation of incident.boundaryAnnotations) annotations.add(annotation.label);
    }
    rows.push({
      rowId: key,
      stationId,
      systemId: first.systemId,
      visibility: first.visibility,
      kind,
      kindLabel: KIND_LABELS[kind],
      kindMarker: KIND_MARKERS[kind],
      periodIndex,
      periodStart: iso(nowMs - (periodIndex + 1) * periodMs),
      periodEnd: iso(nowMs - periodIndex * periodMs),
      periodLabel: `${iso(nowMs - (periodIndex + 1) * periodMs).slice(0, 10)} → ${iso(nowMs - periodIndex * periodMs).slice(0, 10)}`,
      incidentCount,
      hitCount: bucket.reduce((sum, incident) => sum + incident.hitCount, 0),
      lastSeen: iso(lastSeenMs),
      lastSeenLabel: iso(lastSeenMs).replace('T', ' ').slice(0, 16),
      timeSinceLastMs: Math.max(nowMs - lastSeenMs, 0),
      timeSinceLabel: formatTimeSince(Math.max(nowMs - lastSeenMs, 0)),
      recurrenceRatePerWeek: recurrenceRate,
      recurrenceRateLabel: formatRate(recurrenceRate),
      causeLabels: Object.freeze(bucket.map((incident) => incident.causeLabel)),
      boundaryAnnotationLabels: Object.freeze([...annotations].sort()),
      streamIds: Object.freeze([...new Set(bucket.map((incident) => incident.streamId))].sort()),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Sorting and filtering
// ---------------------------------------------------------------------------

export type TrendSortBy = 'site' | 'kind' | 'period' | 'count' | 'lastSeen';
export type TrendSortDirection = 'asc' | 'desc';

export interface TrendSort {
  readonly by: TrendSortBy;
  readonly direction: TrendSortDirection;
}

/** Deterministic multi-key sort; ties break by rowId so order is stable. */
export function sortTrendRows(rows: readonly TrendRow[], sort: TrendSort): readonly TrendRow[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let delta = 0;
    switch (sort.by) {
      case 'site':
        delta = a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0;
        break;
      case 'kind':
        delta = TREND_KINDS.indexOf(a.kind) - TREND_KINDS.indexOf(b.kind);
        break;
      case 'period':
        delta = a.periodIndex - b.periodIndex;
        break;
      case 'count':
        delta = a.incidentCount - b.incidentCount;
        break;
      case 'lastSeen':
        delta = Date.parse(a.lastSeen) - Date.parse(b.lastSeen);
        break;
    }
    if (delta !== 0) return delta * sign;
    return a.rowId < b.rowId ? -1 : 1;
  });
}

export interface TrendFilter {
  readonly kind?: TrendKind | 'all';
  readonly periodIndex?: number | 'all';
}

/** Filter rows by kind and/or period ('all' or undefined = no restriction). */
export function filterTrendRows(rows: readonly TrendRow[], filter: TrendFilter): readonly TrendRow[] {
  return rows.filter(
    (row) =>
      (filter.kind === undefined || filter.kind === 'all' || row.kind === filter.kind) &&
      (filter.periodIndex === undefined || filter.periodIndex === 'all' || row.periodIndex === filter.periodIndex),
  );
}

// ---------------------------------------------------------------------------
// Chart series
// ---------------------------------------------------------------------------

/** One chart point: incident count of one kind in one period (marker + label). */
export interface ChartSeriesPoint {
  readonly periodIndex: number;
  readonly periodLabel: string;
  readonly kind: TrendKind;
  readonly kindLabel: string;
  readonly kindMarker: string;
  readonly count: number;
  readonly hitCount: number;
}

/**
 * Chart data derived from the SAME rows as the table (chart/table parity):
 * one point per (period, kind) with at least one incident.
 */
export function chartSeries(rows: readonly TrendRow[]): readonly ChartSeriesPoint[] {
  return rows
    .map((row) => ({
      periodIndex: row.periodIndex,
      periodLabel: row.periodLabel,
      kind: row.kind,
      kindLabel: row.kindLabel,
      kindMarker: row.kindMarker,
      count: row.incidentCount,
      hitCount: row.hitCount,
    }))
    .sort((a, b) => a.periodIndex - b.periodIndex || TREND_KINDS.indexOf(a.kind) - TREND_KINDS.indexOf(b.kind));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Compact duration: '45 m', '9 h', '3 d 4 h'. */
export function formatTimeSince(ms: number): string {
  if (ms < 60 * 60_000) return `${Math.max(Math.round(ms / 60_000), 0)} m`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))} h`;
  const days = Math.floor(ms / (24 * 60 * 60_000));
  const hours = Math.round((ms - days * 24 * 60 * 60_000) / (60 * 60_000));
  return hours === 0 ? `${days} d` : `${days} d ${hours} h`;
}

/** Recurrence rate label: '38.8/wk', or '—' when nothing recurred. */
export function formatRate(ratePerWeek: number): string {
  if (ratePerWeek <= 0) return '—';
  return `${ratePerWeek >= 10 ? ratePerWeek.toFixed(0) : ratePerWeek.toFixed(1)}/wk`;
}

// ---------------------------------------------------------------------------
// Reviewed demo data (pending API wiring)
// ---------------------------------------------------------------------------

export const DEMO_NOW = '2026-03-09T07:00:00Z';

/** The single seeded fixture curve boundary (WD-011-R2 chains). */
function curveBoundary(relation: BoundaryAnnotationView['relation'], distanceMs: number): BoundaryAnnotationView {
  return {
    boundaryAt: '2026-03-07T18:00:00Z',
    label: 'curve boundary 2026-03-07T18:00:00Z (rc-corinne-2019 → rc-corinne-2026)',
    relation,
    distanceMs,
  };
}

/**
 * REVIEWED DEMO SNAPSHOT of the fixture derivation (reviewed-pending-owner-
 * approval, mirroring services/api quality-trends over the contract
 * fixtures): 18 incidents from 27 reviewed records - 20 QC hits, the 4
 * fixture revisions (the two-corrections chain on obs-q-032 is ONE
 * incident), 2 known issues and the rc-corinne-2019 supersession. Boundary
 * annotations use the API default 12 h adjacency.
 */
export const REVIEWED_DEMO_INCIDENTS: readonly IncidentView[] = Object.freeze([
  { incidentId: 'inc/qc-flag/str-corinne-q/missing-data/1772863200000', kind: 'qc-flag', streamId: 'str-corinne-q', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public', causeKey: 'missing-data', causeLabel: 'missing-data flags', hitCount: 1, evidenceIds: ['qc:missing-data:str-corinne-q:2026-03-07T06:00:00Z'], firstSeen: '2026-03-07T06:00:00Z', lastSeen: '2026-03-07T07:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: null, boundaryAnnotations: [curveBoundary('after', 39_600_000)] },
  { incidentId: 'inc/correction/str-corinne-q/obs-q-019/1772884800000', kind: 'correction', streamId: 'str-corinne-q', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public', causeKey: 'obs-q-019', causeLabel: 'obs-q-019 chain', hitCount: 1, evidenceIds: ['rev-corinne-2003'], firstSeen: '2026-03-07T12:00:00Z', lastSeen: '2026-03-07T12:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: '2026-03-09T06:00:00Z', boundaryAnnotations: [curveBoundary('after', 21_600_000)] },
  { incidentId: 'inc/qc-flag/str-corinne-q/missing-data/1772892000000', kind: 'qc-flag', streamId: 'str-corinne-q', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public', causeKey: 'missing-data', causeLabel: 'missing-data flags', hitCount: 1, evidenceIds: ['qc:missing-data:str-corinne-q:2026-03-07T14:00:00Z'], firstSeen: '2026-03-07T14:00:00Z', lastSeen: '2026-03-07T15:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: null, boundaryAnnotations: [curveBoundary('after', 10_800_000)] },
  { incidentId: 'inc/qc-flag/str-corinne-q/zero-value/1772895600000', kind: 'qc-flag', streamId: 'str-corinne-q', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public', causeKey: 'zero-value', causeLabel: 'zero-value flags', hitCount: 1, evidenceIds: ['qc:zero-value:str-corinne-q:2026-03-07T15:00:00Z'], firstSeen: '2026-03-07T15:00:00Z', lastSeen: '2026-03-07T16:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: null, boundaryAnnotations: [curveBoundary('after', 7_200_000)] },
  { incidentId: 'inc/qc-flag/str-corinne-q/rate-of-change/1772895600000', kind: 'qc-flag', streamId: 'str-corinne-q', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public', causeKey: 'rate-of-change', causeLabel: 'rate-of-change flags', hitCount: 2, evidenceIds: ['qc:rate-of-change:str-corinne-q:2026-03-07T15:00:00Z', 'qc:rate-of-change:str-corinne-q:2026-03-07T16:00:00Z'], firstSeen: '2026-03-07T15:00:00Z', lastSeen: '2026-03-07T17:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: null, boundaryAnnotations: [curveBoundary('after', 3_600_000)] },
  { incidentId: 'inc/curve-supersession/str-corinne-q/rc-corinne-2019/1772906400000', kind: 'curve-supersession', streamId: 'str-corinne-q', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public', causeKey: 'rc-corinne-2019', causeLabel: 'curve rc-corinne-2019 superseded', hitCount: 1, evidenceIds: ['rc-corinne-2019'], firstSeen: '2026-03-07T18:00:00Z', lastSeen: '2026-03-07T18:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: null, boundaryAnnotations: [curveBoundary('during', 0)] },
  { incidentId: 'inc/correction/str-corinne-q/obs-q-032/1772935200000', kind: 'correction', streamId: 'str-corinne-q', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public', causeKey: 'obs-q-032', causeLabel: 'obs-q-032 chain', hitCount: 2, evidenceIds: ['rev-corinne-2001', 'rev-corinne-2004'], firstSeen: '2026-03-08T02:00:00Z', lastSeen: '2026-03-08T02:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: '2026-03-09T06:20:00Z', boundaryAnnotations: [curveBoundary('before', 28_800_000)] },
  { incidentId: 'inc/qc-flag/str-corinne-q/range/1772935200000', kind: 'qc-flag', streamId: 'str-corinne-q', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public', causeKey: 'range', causeLabel: 'range flags', hitCount: 1, evidenceIds: ['qc:range:str-corinne-q:2026-03-08T02:00:00Z'], firstSeen: '2026-03-08T02:00:00Z', lastSeen: '2026-03-08T03:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: null, boundaryAnnotations: [curveBoundary('before', 28_800_000)] },
  { incidentId: 'inc/known-issue/str-corinne-q/issue-000001/1772895600000', kind: 'known-issue', streamId: 'str-corinne-q', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public', causeKey: 'issue-000001', causeLabel: 'Freeze window: suspect zero and icing spikes', hitCount: 1, evidenceIds: ['issue-000001'], firstSeen: '2026-03-07T15:00:00Z', lastSeen: '2026-03-08T04:00:00Z', inWindow: true, recordVisibility: 'public', lastRecordedAt: null, boundaryAnnotations: [curveBoundary('during', 0)] },
  { incidentId: 'inc/qc-flag/str-corinne-q/rate-of-change/1772935200000', kind: 'qc-flag', streamId: 'str-corinne-q', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public', causeKey: 'rate-of-change', causeLabel: 'rate-of-change flags', hitCount: 2, evidenceIds: ['qc:rate-of-change:str-corinne-q:2026-03-08T02:00:00Z', 'qc:rate-of-change:str-corinne-q:2026-03-08T03:00:00Z'], firstSeen: '2026-03-08T02:00:00Z', lastSeen: '2026-03-08T04:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: null, boundaryAnnotations: [curveBoundary('before', 28_800_000)] },
  { incidentId: 'inc/correction/str-corinne-q/obs-q-042/1772992800000', kind: 'correction', streamId: 'str-corinne-q', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public', causeKey: 'obs-q-042', causeLabel: 'obs-q-042 chain', hitCount: 1, evidenceIds: ['rev-corinne-2002'], firstSeen: '2026-03-08T18:00:00Z', lastSeen: '2026-03-08T18:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: '2026-03-09T05:10:00Z', boundaryAnnotations: [] },
  { incidentId: 'inc/qc-flag/str-corinne-q/missing-data/1772971200000', kind: 'qc-flag', streamId: 'str-corinne-q', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public', causeKey: 'missing-data', causeLabel: 'missing-data flags', hitCount: 1, evidenceIds: ['qc:missing-data:str-corinne-q:2026-03-08T12:00:00Z'], firstSeen: '2026-03-08T12:00:00Z', lastSeen: '2026-03-08T18:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: null, boundaryAnnotations: [] },
  { incidentId: 'inc/qc-flag/str-corinne-q/range/1773000000000', kind: 'qc-flag', streamId: 'str-corinne-q', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public', causeKey: 'range', causeLabel: 'range flags', hitCount: 1, evidenceIds: ['qc:range:str-corinne-q:2026-03-08T20:00:00Z'], firstSeen: '2026-03-08T20:00:00Z', lastSeen: '2026-03-08T21:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: null, boundaryAnnotations: [] },
  { incidentId: 'inc/qc-flag/str-corinne-q/rate-of-change/1773000000000', kind: 'qc-flag', streamId: 'str-corinne-q', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public', causeKey: 'rate-of-change', causeLabel: 'rate-of-change flags', hitCount: 2, evidenceIds: ['qc:rate-of-change:str-corinne-q:2026-03-08T20:00:00Z', 'qc:rate-of-change:str-corinne-q:2026-03-08T21:00:00Z'], firstSeen: '2026-03-08T20:00:00Z', lastSeen: '2026-03-08T22:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: null, boundaryAnnotations: [] },
  { incidentId: 'inc/qc-flag/str-corinne-stage/missing-data/1772888400000', kind: 'qc-flag', streamId: 'str-corinne-stage', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public', causeKey: 'missing-data', causeLabel: 'missing-data flags', hitCount: 3, evidenceIds: ['qc:missing-data:str-corinne-stage:2026-03-07T13:00:00Z', 'qc:missing-data:str-corinne-stage:2026-03-08T01:00:00Z', 'qc:missing-data:str-corinne-stage:2026-03-08T21:00:00Z'], firstSeen: '2026-03-07T13:00:00Z', lastSeen: '2026-03-09T06:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: null, boundaryAnnotations: [] },
  { incidentId: 'inc/qc-flag/str-diag-voltage/missing-data/1772888400000', kind: 'qc-flag', streamId: 'str-diag-voltage', stationId: 'sta-bear-lake-diagnostic', systemId: 'sys-bear-river', visibility: 'internal', causeKey: 'missing-data', causeLabel: 'missing-data flags', hitCount: 4, evidenceIds: ['qc:missing-data:str-diag-voltage:2026-03-07T13:00:00Z', 'qc:missing-data:str-diag-voltage:2026-03-08T01:00:00Z', 'qc:missing-data:str-diag-voltage:2026-03-08T13:00:00Z', 'qc:missing-data:str-diag-voltage:2026-03-09T01:00:00Z'], firstSeen: '2026-03-07T13:00:00Z', lastSeen: '2026-03-09T06:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: null, boundaryAnnotations: [] },
  { incidentId: 'inc/known-issue/str-diag-voltage/issue-000002/1773036000000', kind: 'known-issue', streamId: 'str-diag-voltage', stationId: 'sta-bear-lake-diagnostic', systemId: 'sys-bear-river', visibility: 'internal', causeKey: 'issue-000002', causeLabel: 'Battery voltage sagging below minimum', hitCount: 1, evidenceIds: ['issue-000002'], firstSeen: '2026-03-09T06:00:00Z', lastSeen: '2026-03-09T07:00:00Z', inWindow: true, recordVisibility: 'internal', lastRecordedAt: null, boundaryAnnotations: [] },
  { incidentId: 'inc/qc-flag/str-diag-voltage/range/1773036000000', kind: 'qc-flag', streamId: 'str-diag-voltage', stationId: 'sta-bear-lake-diagnostic', systemId: 'sys-bear-river', visibility: 'internal', causeKey: 'range', causeLabel: 'range flags', hitCount: 1, evidenceIds: ['qc:range:str-diag-voltage:2026-03-09T06:00:00Z'], firstSeen: '2026-03-09T06:00:00Z', lastSeen: '2026-03-09T07:00:00Z', inWindow: true, recordVisibility: null, lastRecordedAt: null, boundaryAnnotations: [] },
] as const);
