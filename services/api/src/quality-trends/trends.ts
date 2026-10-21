/**
 * Recurring quality-incident trends (WD-013-R2; FR-043).
 *
 * "Users see chart markers and a sortable table of repeated flags or
 * corrections by site and period; counts reconcile to the selected issue and
 * revision records without counting one incident repeatedly."
 *
 * THE INCIDENT MODEL (the dedupe that makes FR-043 true):
 *
 * - ONE INCIDENT = one (site, kind, cause-cluster). The underlying raw
 *   records - QC rule hits (WD-013), revision events (WD-011), known issues
 *   (WD-013) and rating-version supersessions (WD-011-R2) - are grouped into
 *   incidents and NEVER surface one row per revision: the fixture's
 *   two-corrections chain on obs-q-032 (rev-corinne-2001 correction, then
 *   rev-corinne-2004 level-advance of the SAME point) is ONE correction
 *   incident with two evidence records, not two rows.
 * - CAUSE-CLUSTER KEYS, per kind (all deterministic, all documented):
 *   - qc-flag: the rule family. Hits of one family chain into the same
 *     incident while the next hit's start is within `clusterGapMs` (default
 *     6 h) of the previous hit's interval END; a larger gap starts a new
 *     incident (the six-hour outage missing-data storm is one incident, the
 *     earlier irregular-interval gaps are separate ones).
 *   - correction: the target observation chain. Every revision of one
 *     observation - corrections, level-advances and exclusions alike - is one
 *     incident regardless of when recorded (a chain is one story by
 *     construction; FR-043's "without counting one incident repeatedly").
 *   - known-issue: the known-issue id (one recorded issue is one incident,
 *     across its whole append-only resolution history).
 *   - curve-supersession: the superseded rating-version id (one closed
 *     version is one supersession event; see curveDiagnostics.ts).
 * - EXACT-DUPLICATE RECORDS (the same evidence id delivered twice, e.g. a
 *   re-delivered QC run) collapse to one hit and are counted in
 *   `duplicatesDropped` - the FR-016 digest dedupe rule, applied to trends.
 *
 * RECONCILIATION CONTRACT (asserted by test/trends.test.ts): every raw input
 * record is attributed to EXACTLY ONE incident - the sum of incident
 * hitCounts, plus exact duplicates dropped and records on streams absent
 * from the site table, equals the raw record count. Nothing is silently
 * dropped, nothing is counted twice. `reconcileTrends()` returns the
 * arithmetic so callers (and the suite) can prove it for any input.
 *
 * Purity: no I/O, no clock reads, no randomness. `now` is injected; incident
 * ids derive from (kind, stream, cause key, first evidence instant), so two
 * derivations over the same input are byte-identical (determinism suite).
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const TREND_KINDS = ['qc-flag', 'correction', 'known-issue', 'curve-supersession'] as const;
export type TrendKind = (typeof TREND_KINDS)[number];

export type StreamVisibilityClass = 'public' | 'restricted' | 'internal';

/** Stream site table row: where a stream lives and how protected it is. */
export interface TrendStreamMeta {
  readonly streamId: string;
  readonly stationId: string;
  readonly systemId: string;
  readonly visibility: StreamVisibilityClass;
}

/** Default rolling window (30 days) and cluster gap (6 h) in milliseconds. */
export const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const DEFAULT_CLUSTER_GAP_MS = 6 * 60 * 60_000;
/** Default reporting period length (7 days) and number of period buckets. */
export const DEFAULT_PERIOD_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_PERIOD_COUNT = 4;
/** One week, the unit of the recurrence rate. */
export const WEEK_MS = 7 * 24 * 60 * 60_000;
/**
 * Minimum span used when normalizing the recurrence rate, so two incidents
 * on the same day are not "infinite recurrences per week". One day.
 */
export const RATE_MIN_SPAN_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Input records (structural: the WD-011/WD-013/WD-011-R2 records satisfy them)
// ---------------------------------------------------------------------------

/** One QC rule hit, structurally compatible with WD-013 QcViolation. */
export interface QcHitRecord {
  /** Unique evidence id for the raw record (dedupe key), e.g. "qc-range#1". */
  readonly hitId: string;
  readonly streamId: string;
  /** Rule family (range, rate-of-change, ...) - the qc-flag cause key. */
  readonly family: string;
  /** Half-open [start, end) observation-time interval of the hit. */
  readonly interval: { readonly start: string; readonly end: string };
}

/** One revision event: WD-011 RevisionRecord joined to its observation row. */
export interface CorrectionEventRecord {
  /** Revision id (evidence id / dedupe key). */
  readonly revisionId: string;
  /** The observation chain this edit belongs to - the correction cause key. */
  readonly targetObservationId: string;
  readonly streamId: string;
  /** OBSERVATION time of the target point (the diagnostic-timeline anchor). */
  readonly observedAt: string;
  /** REVISION time: when the edit was recorded. Distinct field, kept verbatim. */
  readonly recordedAt: string;
  readonly type: 'correction' | 'level-advance' | 'exclusion';
  readonly actorId: string;
}

/** One known issue, structurally compatible with WD-013 KnownIssue. */
export interface KnownIssueRecord {
  readonly issueId: string;
  readonly streamId: string;
  readonly interval: { readonly start: string; readonly end: string };
  readonly title: string;
  readonly status: string;
  /** Issue-level visibility: internal issues never reach public projections. */
  readonly visibility: 'public' | 'internal';
}

/** One rating/shift supersession event (derived in curveDiagnostics.ts). */
export interface CurveSupersessionRecord {
  /** Evidence id: the superseded version id. */
  readonly supersededVersionId: string;
  readonly successorVersionId: string | null;
  readonly streamId: string;
  readonly kind: 'curve' | 'shift';
  /** Boundary instant: the superseded period's end == successor's start. */
  readonly boundaryAt: string;
}

/** Everything the derivation consumes. */
export interface TrendInput {
  /** Injected reference instant (the fixed fixture clock in tests/demos). */
  readonly now: string;
  readonly streamMeta: Readonly<Record<string, TrendStreamMeta>>;
  readonly qcHits?: readonly QcHitRecord[];
  readonly corrections?: readonly CorrectionEventRecord[];
  readonly knownIssues?: readonly KnownIssueRecord[];
  readonly curveSupersessions?: readonly CurveSupersessionRecord[];
  /** Rolling window length in ms (default 30 days). */
  readonly windowMs?: number;
  /** Max gap between hits of one qc-flag incident (default 6 h). */
  readonly clusterGapMs?: number;
  /** Reporting period length in ms (default 7 days). */
  readonly periodMs?: number;
  /** Number of period buckets ending at `now` (default 4). */
  readonly periodCount?: number;
}

// ---------------------------------------------------------------------------
// Derived model
// ---------------------------------------------------------------------------

/** One deduplicated recurring-incident row. */
export interface TrendIncident {
  /** Deterministic id: inc/<kind>/<streamId>/<causeKey>/<firstSeen>. */
  readonly incidentId: string;
  readonly kind: TrendKind;
  readonly streamId: string;
  readonly stationId: string;
  readonly systemId: string;
  readonly visibility: StreamVisibilityClass;
  /** The documented cause-cluster key (see module header). */
  readonly causeKey: string;
  /** Human cause label for the table ("rate-of-change flags", "obs-q-032 chain", ...). */
  readonly causeLabel: string;
  /** Underlying raw records: >= 1, chronological, exactly-once attributed. */
  readonly hitCount: number;
  readonly evidenceIds: readonly string[];
  /** Earliest / latest evidence instant on the diagnostic (observation) timeline. */
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** True while lastSeen falls inside the rolling window ending at `now`. */
  readonly inWindow: boolean;
  /** Known-issue incidents carry the issue's own visibility; null otherwise. */
  readonly recordVisibility: 'public' | 'internal' | null;
  /** Correction incidents expose the latest REVISION time; null otherwise. */
  readonly lastRecordedAt: string | null;
}

/** Incident counts by kind for one site in one half-open period bucket. */
export interface SitePeriodTrend {
  readonly stationId: string;
  readonly systemId: string;
  readonly visibility: StreamVisibilityClass;
  /** 0 = the period ending at `now`; higher = older (a 5th bucket merges older history). */
  readonly periodIndex: number;
  /** Half-open [periodStart, periodEnd). */
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly incidentCounts: Readonly<Record<TrendKind, number>>;
  readonly totalIncidents: number;
}

/** Recurrence metrics for one (site, kind) across the rolling window. */
export interface KindRecurrenceSummary {
  readonly stationId: string;
  readonly systemId: string;
  readonly visibility: StreamVisibilityClass;
  readonly kind: TrendKind;
  readonly incidentCount: number;
  readonly firstSeen: string | null;
  readonly lastSeen: string | null;
  /**
   * Recurrences per week: (incidentCount - 1) / weeks between the first and
   * last incident, over a one-day minimum span; 0 for a single incident
   * (nothing has recurred yet).
   */
  readonly recurrenceRatePerWeek: number;
  /** now - lastSeen in ms; null when the site has no incident of this kind. */
  readonly timeSinceLastMs: number | null;
}

/** Effective derivation options, echoed on the report for projections. */
export type TrendOptions = Required<
  Pick<TrendInput, 'now' | 'windowMs' | 'clusterGapMs' | 'periodMs' | 'periodCount'>
>;

/** Everything the trend surface renders, derived once from the input. */
export interface TrendReport {
  readonly incidents: readonly TrendIncident[];
  readonly sitePeriods: readonly SitePeriodTrend[];
  readonly kindRecurrence: readonly KindRecurrenceSummary[];
  readonly options: TrendOptions;
}

/** The reconciliation arithmetic (FR-043 "counts reconcile ... exactly"). */
export interface TrendReconciliation {
  /** Raw records presented to the derivation. */
  readonly rawRecordCount: number;
  /** Sum of incident hitCounts (every attributed record, counted once). */
  readonly attributedCount: number;
  /** Exact-duplicate records collapsed (same evidence id delivered twice). */
  readonly duplicatesDropped: number;
  /** Records that produced no incident row (unknown stream, or a derivation bug). */
  readonly unattributedCount: number;
  readonly incidentCount: number;
  /** True exactly when attributed + duplicates + unattributed == raw. */
  readonly balanced: boolean;
  /** Any evidence id attributed to more than one incident (must stay empty). */
  readonly doubleCountedIds: readonly string[];
  /** Attributed ids that do not exist in the raw input (must stay empty). */
  readonly phantomIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

function parse(instant: string): number {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new Error(`trends: unparseable instant "${instant}"`);
  return ms;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** Internal seed: one deduped raw record positioned on the diagnostic timeline. */
interface SeedHit {
  readonly evidenceId: string;
  readonly at: number;
  /** Evidence interval END (qc hit / known issue); null for point events. */
  readonly endAt: number | null;
  readonly streamId: string;
  readonly kind: TrendKind;
  readonly causeKey: string;
  readonly causeLabel: string;
  readonly recordVisibility: 'public' | 'internal' | null;
  readonly recordedAt: number | null;
}

/** Deterministic incident id (no randomness, URL-safe). */
function incidentIdOf(kind: TrendKind, streamId: string, causeKey: string, firstSeenMs: number): string {
  const sanitized = causeKey.replace(/[^a-z0-9._-]+/gi, '_');
  return `inc/${kind}/${streamId}/${sanitized}/${firstSeenMs}`;
}

/**
 * Group time-ordered seeds into incidents.
 * - correction / known-issue / curve-supersession: one incident per cause key
 *   (observation chain, issue id, closed version id) - grouped outright.
 * - qc-flag: hits of one (stream, family) chain while the next start is
 *   within clusterGapMs of the previous END; a larger gap mints a new
 *   incident keyed by the first hit's instant.
 */
function clusterSeeds(seeds: readonly SeedHit[], clusterGapMs: number): Map<string, SeedHit[]> {
  const groups = new Map<string, SeedHit[]>();
  const chains = new Map<string, { groupKey: string; end: number }>();
  for (const seed of seeds) {
    if (seed.kind !== 'qc-flag') {
      const key = `${seed.streamId}|${seed.kind}|${seed.causeKey}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(seed);
      else groups.set(key, [seed]);
      continue;
    }
    const chainKey = `${seed.streamId}|${seed.causeKey}`;
    const chain = chains.get(chainKey);
    const end = seed.endAt ?? seed.at;
    if (chain && seed.at - chain.end <= clusterGapMs) {
      groups.get(chain.groupKey)!.push(seed);
      chain.end = Math.max(chain.end, end);
      continue;
    }
    const groupKey = `${seed.streamId}|qc-flag|${seed.causeKey}|${seed.at}`;
    groups.set(groupKey, [seed]);
    chains.set(chainKey, { groupKey, end });
  }
  return groups;
}

/**
 * Derive the deduplicated incident list. Records on streams missing from
 * `streamMeta` produce no incident row but are still counted by
 * reconcileTrends, so the arithmetic stays honest for partial site tables.
 */
export function deriveIncidents(input: TrendInput): readonly TrendIncident[] {
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
  const clusterGapMs = input.clusterGapMs ?? DEFAULT_CLUSTER_GAP_MS;
  const nowMs = parse(input.now);

  const seeds: SeedHit[] = [];
  const seenEvidence = new Set<string>();
  const push = (seed: SeedHit): void => {
    if (seenEvidence.has(seed.evidenceId)) return; // exact-duplicate record
    seenEvidence.add(seed.evidenceId);
    seeds.push(seed);
  };

  for (const hit of input.qcHits ?? []) {
    push({
      evidenceId: hit.hitId,
      at: parse(hit.interval.start),
      endAt: parse(hit.interval.end),
      streamId: hit.streamId,
      kind: 'qc-flag',
      causeKey: hit.family,
      causeLabel: `${hit.family} flags`,
      recordVisibility: null,
      recordedAt: null,
    });
  }
  for (const correction of input.corrections ?? []) {
    push({
      evidenceId: correction.revisionId,
      at: parse(correction.observedAt),
      endAt: null,
      streamId: correction.streamId,
      kind: 'correction',
      causeKey: correction.targetObservationId,
      causeLabel: `${correction.targetObservationId} chain`,
      recordVisibility: null,
      recordedAt: parse(correction.recordedAt),
    });
  }
  for (const issue of input.knownIssues ?? []) {
    push({
      evidenceId: issue.issueId,
      at: parse(issue.interval.start),
      endAt: parse(issue.interval.end),
      streamId: issue.streamId,
      kind: 'known-issue',
      causeKey: issue.issueId,
      causeLabel: issue.title,
      recordVisibility: issue.visibility,
      recordedAt: null,
    });
  }
  for (const supersession of input.curveSupersessions ?? []) {
    push({
      evidenceId: supersession.supersededVersionId,
      at: parse(supersession.boundaryAt),
      endAt: null,
      streamId: supersession.streamId,
      kind: 'curve-supersession',
      causeKey: supersession.supersededVersionId,
      causeLabel: `${supersession.kind} ${supersession.supersededVersionId} superseded`,
      recordVisibility: null,
      recordedAt: null,
    });
  }

  // Deterministic order before clustering: (start instant, evidence id), so
  // the chaining decision never depends on input array order.
  seeds.sort((a, b) => a.at - b.at || (a.evidenceId < b.evidenceId ? -1 : 1));

  const groups = clusterSeeds(seeds, clusterGapMs);
  const incidents: TrendIncident[] = [];
  for (const [, bucket] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const ordered = [...bucket].sort((a, b) => a.at - b.at || (a.evidenceId < b.evidenceId ? -1 : 1));
    const first = ordered[0] as SeedHit;
    const meta = input.streamMeta[first.streamId];
    if (!meta) continue; // unknown site: counted by reconcileTrends, never listed
    // The incident's diagnostic span covers the evidence INTERVALS: from the
    // first start to the latest end (point events have end === start).
    const lastSeenMs = Math.max(...ordered.map((seed) => seed.endAt ?? seed.at));
    const lastRecordedAt = ordered
      .map((seed) => seed.recordedAt)
      .filter((value): value is number => value !== null)
      .reduce<number | null>((max, value) => (max === null || value > max ? value : max), null);
    incidents.push({
      incidentId: incidentIdOf(first.kind, first.streamId, first.causeKey, first.at),
      kind: first.kind,
      streamId: first.streamId,
      stationId: meta.stationId,
      systemId: meta.systemId,
      visibility: meta.visibility,
      causeKey: first.causeKey,
      causeLabel: first.causeLabel,
      hitCount: ordered.length,
      evidenceIds: Object.freeze(ordered.map((seed) => seed.evidenceId)),
      firstSeen: iso(first.at),
      lastSeen: iso(lastSeenMs),
      inWindow: lastSeenMs >= nowMs - windowMs,
      recordVisibility: first.recordVisibility,
      lastRecordedAt: lastRecordedAt === null ? null : iso(lastRecordedAt),
    });
  }
  incidents.sort(
    (a, b) => Date.parse(a.lastSeen) - Date.parse(b.lastSeen) || (a.incidentId < b.incidentId ? -1 : 1),
  );
  return incidents;
}

/**
 * Reconcile a derivation against its raw input: the FR-043 proof that every
 * raw record is attributed exactly once (no double counting, no silent
 * drops). `balanced === true` and empty id lists are the pass condition.
 */
export function reconcileTrends(input: TrendInput, incidents: readonly TrendIncident[]): TrendReconciliation {
  const raw: string[] = [
    ...(input.qcHits ?? []).map((hit) => hit.hitId),
    ...(input.corrections ?? []).map((correction) => correction.revisionId),
    ...(input.knownIssues ?? []).map((issue) => issue.issueId),
    ...(input.curveSupersessions ?? []).map((supersession) => supersession.supersededVersionId),
  ];
  const rawUnique = new Set(raw);

  const attributed = new Map<string, number>();
  let attributedCount = 0;
  for (const incident of incidents) {
    attributedCount += incident.hitCount;
    for (const id of incident.evidenceIds) attributed.set(id, (attributed.get(id) ?? 0) + 1);
  }

  // Records that produced no incident row: unknown streams (expected for
  // partial site tables) or - a derivation bug - records on known streams.
  // Counted per UNIQUE evidence id (DEFECT-R2-2): an exact-duplicate
  // delivery of an unattributed record is a duplicate (duplicatesDropped),
  // never a SECOND unattributed record, so every raw record lands in
  // exactly one bucket - attributed + duplicatesDropped + unattributed ==
  // raw holds on every input class, including duplicates on streams absent
  // from the site table.
  let unattributed = 0;
  for (const id of rawUnique) {
    if (!attributed.has(id)) unattributed += 1;
  }

  const attributedIds = new Set(attributed.keys());
  const duplicatesDropped = raw.length - rawUnique.size;
  return {
    rawRecordCount: raw.length,
    attributedCount,
    duplicatesDropped,
    unattributedCount: unattributed,
    incidentCount: incidents.length,
    balanced: attributedCount + duplicatesDropped + unattributed === raw.length,
    doubleCountedIds: Object.freeze(
      [...attributed.entries()].filter(([, count]) => count > 1).map(([id]) => id),
    ),
    phantomIds: Object.freeze([...attributedIds].filter((id) => !rawUnique.has(id))),
  };
}

// ---------------------------------------------------------------------------
// Aggregates (per site x period, and per site x kind)
// ---------------------------------------------------------------------------

/** Period bucket of one lastSeen instant: 0 = current, periodCount-1 caps older. */
function periodIndexOf(lastSeenMs: number, nowMs: number, periodMs: number, periodCount: number): number | null {
  const elapsed = Math.floor((nowMs - lastSeenMs) / periodMs);
  if (elapsed < 0) return null; // future-dated record: no bucket
  return Math.min(elapsed, periodCount - 1);
}

/** Per-site, per-period incident counts by kind, from an incident list. */
export function sitePeriodTrendsOfIncidents(
  incidents: readonly TrendIncident[],
  options: TrendOptions,
): readonly SitePeriodTrend[] {
  const nowMs = parse(options.now);
  const { periodMs, periodCount } = options;
  const sites = new Map<string, { stationId: string; systemId: string; visibility: StreamVisibilityClass; buckets: TrendIncident[][] }>();
  for (const incident of incidents) {
    const key = `${incident.stationId}|${incident.systemId}|${incident.visibility}`;
    let site = sites.get(key);
    if (!site) {
      site = {
        stationId: incident.stationId,
        systemId: incident.systemId,
        visibility: incident.visibility,
        buckets: Array.from({ length: periodCount }, () => [] as TrendIncident[]),
      };
      sites.set(key, site);
    }
    const bucket = periodIndexOf(parse(incident.lastSeen), nowMs, periodMs, periodCount);
    if (bucket === null) continue;
    site.buckets[bucket]!.push(incident);
  }
  const rows: SitePeriodTrend[] = [];
  for (const [, site] of [...sites.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    site.buckets.forEach((bucket, index) => {
      if (bucket.length === 0) return;
      const incidentCounts: Record<TrendKind, number> = {
        'qc-flag': 0,
        correction: 0,
        'known-issue': 0,
        'curve-supersession': 0,
      };
      for (const incident of bucket) incidentCounts[incident.kind] += 1;
      rows.push({
        stationId: site.stationId,
        systemId: site.systemId,
        visibility: site.visibility,
        periodIndex: index,
        periodStart: iso(nowMs - (index + 1) * periodMs),
        periodEnd: iso(nowMs - index * periodMs),
        incidentCounts,
        totalIncidents: bucket.length,
      });
    });
  }
  return rows;
}

/** Recurrence metrics per (site, kind) across the rolling window. */
export function kindRecurrenceOfIncidents(
  incidents: readonly TrendIncident[],
  options: TrendOptions,
): readonly KindRecurrenceSummary[] {
  const nowMs = parse(options.now);
  const groups = new Map<string, TrendIncident[]>();
  for (const incident of incidents) {
    if (!incident.inWindow) continue;
    const key = `${incident.stationId}|${incident.systemId}|${incident.visibility}|${incident.kind}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(incident);
    else groups.set(key, [incident]);
  }
  const rows: KindRecurrenceSummary[] = [];
  for (const [key, bucket] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const [stationId, systemId, visibility, kind] = key.split('|') as [string, string, StreamVisibilityClass, TrendKind];
    const firstSeenMs = Math.min(...bucket.map((incident) => parse(incident.firstSeen)));
    const lastSeenMs = Math.max(...bucket.map((incident) => parse(incident.lastSeen)));
    const spanMs = Math.max(lastSeenMs - firstSeenMs, RATE_MIN_SPAN_MS);
    rows.push({
      stationId,
      systemId,
      visibility,
      kind,
      incidentCount: bucket.length,
      firstSeen: iso(firstSeenMs),
      lastSeen: iso(lastSeenMs),
      recurrenceRatePerWeek: bucket.length > 1 ? (bucket.length - 1) / (spanMs / WEEK_MS) : 0,
      timeSinceLastMs: Math.max(nowMs - lastSeenMs, 0),
    });
  }
  return rows;
}

/** The effective options a report derives under. */
export function effectiveTrendOptions(input: TrendInput): TrendOptions {
  return {
    now: input.now,
    windowMs: input.windowMs ?? DEFAULT_WINDOW_MS,
    clusterGapMs: input.clusterGapMs ?? DEFAULT_CLUSTER_GAP_MS,
    periodMs: input.periodMs ?? DEFAULT_PERIOD_MS,
    periodCount: input.periodCount ?? DEFAULT_PERIOD_COUNT,
  };
}

/** The full report: deduplicated incidents plus both aggregate views. */
export function buildTrendReport(input: TrendInput): TrendReport {
  const options = effectiveTrendOptions(input);
  const incidents = deriveIncidents(input);
  return {
    incidents,
    sitePeriods: sitePeriodTrendsOfIncidents(incidents, options),
    kindRecurrence: kindRecurrenceOfIncidents(incidents, options),
    options,
  };
}
