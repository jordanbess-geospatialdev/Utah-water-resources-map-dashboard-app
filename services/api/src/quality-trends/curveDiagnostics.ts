/**
 * Curve diagnostics (WD-013-R2; FR-043 + FR-045): relate the WD-011-R2
 * approved rating/shift version periods to the recurring diagnostic history.
 *
 * "Effective-dated curve and shift versions retain author, approval state
 * and provenance; ... a revised curve does not erase earlier conversions or
 * inspection evidence." - so the diagnostic timeline shows BOTH sides of
 * every version transition: the supersession event (with its lineage ids)
 * and the correction/QC/known-issue incidents that cluster around the
 * boundary instant where one period ends and the next begins.
 *
 * WHAT THIS MODULE DOES:
 * - Reads the versioned effective-dated chains from the WD-011-R2 store
 *   (relative import, read-only: this module never mutates curves, shifts,
 *   revisions or observations) and derives the APPROVED BOUNDARIES: instants
 *   where one approved-or-superseded version's half-open period
 *   [effectiveFrom, effectiveTo) ends and its successor's begins (the seeded
 *   fixture chains touch exactly once, at 2026-03-07T18:00:00Z).
 * - Converts every closed approved version into a curve-supersession record
 *   for trends.ts, so supersession events count as incidents that reconcile
 *   to the underlying rating-version records (FR-043 reconciliation).
 * - ANNOTATES diagnostic incidents adjacent to a boundary: an incident whose
 *   diagnostic span lies within `adjacencyMs` (default 12 h, roughly the
 *   working day around a device/curve change) of a boundary instant carries
 *   that boundary - e.g. the negative-spike correction chain on obs-q-032
 *   (observed 8 h after the 2026 RTU replacement) is annotated with the
 *   rc-corinne-2019 -> rc-corinne-2026 boundary.
 * - Merges everything into ONE ordered diagnostic timeline in which a
 *   supersession event appears with its lineage ids.
 *
 * Purity: the only I/O is the fixture read inside the supplied store; no
 * clock reads, no randomness, no mutation of the store or its chains.
 */
import type { RatingCurveStore } from '../workflows/rating-curves/store.ts';
import type { ApprovalState, RatingCurveVersion, RatingShift } from '../workflows/rating-curves/types.ts';
import type { CurveSupersessionRecord, TrendIncident } from './trends.ts';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Default boundary-adjacency window: half a day either side of a boundary. */
export const DEFAULT_ADJACENCY_MS = 12 * 60 * 60_000;

/** A version with approval evidence (approval survives supersession, FR-045). */
export function hasApprovalEvidence(version: { approvalState: ApprovalState; approvedAt: string | null }): boolean {
  return version.approvedAt !== null && (version.approvalState === 'approved' || version.approvalState === 'superseded');
}

/** Half-open period of one version, [effectiveFrom, effectiveTo | open). */
export interface VersionPeriod {
  readonly from: string;
  readonly to: string | null;
}

/**
 * One approved version-boundary instant: the end of one approved period and
 * the start of its successor (the two half-open intervals touch exactly once).
 */
export interface CurveBoundary {
  readonly streamId: string;
  readonly stationId: string;
  /** Which chain the boundary belongs to. */
  readonly kind: 'curve' | 'shift';
  /** The boundary instant (superseded.effectiveTo === successor.effectiveFrom). */
  readonly at: string;
  readonly supersededVersionId: string;
  readonly successorVersionId: string | null;
  readonly supersededApprovalState: ApprovalState | null;
  readonly successorApprovalState: ApprovalState | null;
  readonly supersededPeriod: VersionPeriod;
  readonly successorPeriod: VersionPeriod | null;
  /** Human lineage label, e.g. "rc-corinne-2019 → rc-corinne-2026". */
  readonly label: string;
}

/** A boundary annotation attached to an adjacent diagnostic incident. */
export interface BoundaryAnnotation {
  readonly boundaryAt: string;
  readonly kind: 'curve' | 'shift';
  readonly supersededVersionId: string;
  readonly successorVersionId: string | null;
  /** Boundary position relative to the incident's diagnostic span. */
  readonly relation: 'before' | 'during' | 'after';
  /** Distance from the span in ms; 0 while the span covers the boundary. */
  readonly distanceMs: number;
  /** Human label carried verbatim by the table/chart (text, never color). */
  readonly label: string;
}

/** A diagnostic incident enriched with its adjacent curve boundaries. */
export type AnnotatedTrendIncident = TrendIncident & {
  readonly boundaryAnnotations: readonly BoundaryAnnotation[];
};

/** One ordered entry of the unified diagnostic timeline. */
export type DiagnosticTimelineEntry =
  | {
      readonly entryType: 'incident';
      readonly at: string;
      readonly incident: AnnotatedTrendIncident;
    }
  | {
      readonly entryType: 'curve-boundary';
      readonly at: string;
      readonly boundary: CurveBoundary;
    }
  | {
      readonly entryType: 'curve-supersession';
      readonly at: string;
      readonly streamId: string;
      readonly stationId: string;
      readonly kind: 'curve' | 'shift';
      /** LINEAGE: which version closed, and which took over (FR-045). */
      readonly supersededVersionId: string;
      readonly successorVersionId: string | null;
      readonly lineageLabel: string;
      /** The incident row this event also counts as (FR-043 reconciliation). */
      readonly incidentId: string | null;
    };

export interface CurveDiagnosticsOptions {
  /** Max distance between an incident span and a boundary (default 12 h). */
  readonly adjacencyMs?: number;
}

// ---------------------------------------------------------------------------
// Boundary derivation (read-only over the WD-011-R2 chains)
// ---------------------------------------------------------------------------

function boundariesOfChain<T extends RatingCurveVersion | RatingShift>(
  chain: readonly T[],
  streamId: string,
  stationId: string,
  kind: 'curve' | 'shift',
): CurveBoundary[] {
  const ordered = [...chain].sort((a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom));
  const boundaries: CurveBoundary[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const superseded = ordered[index] as T;
    const successor = ordered[index + 1] as T;
    // A boundary exists exactly where the two half-open periods touch.
    if (superseded.effectiveTo !== successor.effectiveFrom) continue;
    // Relate APPROVED periods only (draft experiments do not move the boundary).
    if (!hasApprovalEvidence(superseded) || !hasApprovalEvidence(successor)) continue;
    boundaries.push({
      streamId,
      stationId,
      kind,
      at: superseded.effectiveTo as string,
      supersededVersionId: superseded.id,
      successorVersionId: successor.id,
      supersededApprovalState: superseded.approvalState,
      successorApprovalState: successor.approvalState,
      supersededPeriod: { from: superseded.effectiveFrom, to: superseded.effectiveTo },
      successorPeriod: { from: successor.effectiveFrom, to: successor.effectiveTo },
      label: `${superseded.id} → ${successor.id}`,
    });
  }
  // A closed approved version with NO successor at its close instant is still
  // a supersession boundary (the chain currently ends there); successor null.
  const last = ordered.at(-1);
  if (last && last.effectiveTo !== null && hasApprovalEvidence(last)) {
    const alreadyCovered = boundaries.some((boundary) => boundary.supersededVersionId === last.id);
    if (!alreadyCovered) {
      boundaries.push({
        streamId,
        stationId,
        kind,
        at: last.effectiveTo,
        supersededVersionId: last.id,
        successorVersionId: null,
        supersededApprovalState: last.approvalState,
        successorApprovalState: null,
        supersededPeriod: { from: last.effectiveFrom, to: last.effectiveTo },
        successorPeriod: null,
        label: `${last.id} → (no successor in chain)`,
      });
    }
  }
  return boundaries.sort((a, b) => Date.parse(a.at) - Date.parse(a.at) || (a.label < b.label ? -1 : 1));
}

/** Every approved boundary of every stream chain the store knows. */
export function approvedBoundaries(store: RatingCurveStore): readonly CurveBoundary[] {
  const streamIds = Object.values(store.world.objects)
    .filter((object) => object.kind === 'datastream')
    .map((object) => object.id)
    .sort();
  const boundaries: CurveBoundary[] = [];
  for (const streamId of streamIds) {
    const stream = store.streamById(streamId);
    if (!stream) continue;
    boundaries.push(
      ...boundariesOfChain(store.curveVersionsOf(streamId), streamId, stream.stationId, 'curve'),
      ...boundariesOfChain(store.shiftVersionsOf(streamId), streamId, stream.stationId, 'shift'),
    );
  }
  return boundaries;
}

/**
 * One curve-supersession record per CLOSED APPROVED version - the trend input
 * that makes supersession events countable incidents reconciling to the
 * underlying rating-version records.
 */
export function curveSupersessionsOf(store: RatingCurveStore): readonly CurveSupersessionRecord[] {
  const boundaries = approvedBoundaries(store);
  return boundaries.map((boundary) => ({
    supersededVersionId: boundary.supersededVersionId,
    successorVersionId: boundary.successorVersionId,
    streamId: boundary.streamId,
    kind: boundary.kind,
    boundaryAt: boundary.at,
  }));
}

// ---------------------------------------------------------------------------
// Adjacency annotation
// ---------------------------------------------------------------------------

/**
 * Annotate every incident whose diagnostic span [firstSeen, lastSeen] lies
 * within `adjacencyMs` of an approved boundary instant (either side), or
 * covers it. Pure; incidents without adjacent boundaries pass through with an
 * empty annotation list.
 */
export function annotateCurveBoundaries(
  incidents: readonly TrendIncident[],
  boundaries: readonly CurveBoundary[],
  options: CurveDiagnosticsOptions = {},
): readonly AnnotatedTrendIncident[] {
  const adjacencyMs = options.adjacencyMs ?? DEFAULT_ADJACENCY_MS;
  return incidents.map((incident) => {
    const annotations: BoundaryAnnotation[] = [];
    for (const boundary of boundaries) {
      if (boundary.streamId !== incident.streamId) continue;
      const boundaryMs = Date.parse(boundary.at);
      const startMs = Date.parse(incident.firstSeen);
      const endMs = Date.parse(incident.lastSeen);
      let relation: 'before' | 'during' | 'after';
      let distanceMs: number;
      if (boundaryMs < startMs) {
        relation = 'before';
        distanceMs = startMs - boundaryMs;
      } else if (boundaryMs > endMs) {
        relation = 'after';
        distanceMs = boundaryMs - endMs;
      } else {
        relation = 'during';
        distanceMs = 0;
      }
      if (distanceMs > adjacencyMs) continue;
      annotations.push({
        boundaryAt: boundary.at,
        kind: boundary.kind,
        supersededVersionId: boundary.supersededVersionId,
        successorVersionId: boundary.successorVersionId,
        relation,
        distanceMs,
        label: `${boundary.kind} boundary ${boundary.at} (${boundary.label})`,
      });
    }
    annotations.sort((a, b) => a.distanceMs - b.distanceMs || (a.boundaryAt < b.boundaryAt ? -1 : 1));
    return { ...incident, boundaryAnnotations: Object.freeze(annotations) };
  });
}

// ---------------------------------------------------------------------------
// Unified diagnostic timeline
// ---------------------------------------------------------------------------

/**
 * One ordered timeline of diagnostic history and curve governance:
 * incidents (with their boundary annotations), approved boundary instants,
 * and supersession events carrying their LINEAGE ids. Sorted by instant,
 * then by a stable key so two builds are byte-identical.
 */
export function diagnosticTimeline(
  incidents: readonly AnnotatedTrendIncident[],
  boundaries: readonly CurveBoundary[],
  supersessions: readonly CurveSupersessionRecord[] = [],
): readonly DiagnosticTimelineEntry[] {
  const supersessionByEvidence = new Map(supersessions.map((record) => [record.supersededVersionId, record]));
  const entries: DiagnosticTimelineEntry[] = [];
  for (const incident of incidents) {
    entries.push({ entryType: 'incident', at: incident.lastSeen, incident });
    if (incident.kind !== 'curve-supersession') continue;
    const record = incident.evidenceIds
      .map((id) => supersessionByEvidence.get(id))
      .find((candidate) => candidate !== undefined);
    if (!record) continue;
    entries.push({
      entryType: 'curve-supersession',
      at: record.boundaryAt,
      streamId: record.streamId,
      stationId: incident.stationId,
      kind: record.kind,
      supersededVersionId: record.supersededVersionId,
      successorVersionId: record.successorVersionId,
      lineageLabel:
        record.successorVersionId === null
          ? `${record.supersededVersionId} closed (no successor in chain)`
          : `${record.supersededVersionId} → ${record.successorVersionId}`,
      incidentId: incident.incidentId,
    });
  }
  for (const boundary of boundaries) {
    entries.push({ entryType: 'curve-boundary', at: boundary.at, boundary });
  }
  return entries.sort((a, b) => {
    const atDelta = Date.parse(a.at) - Date.parse(b.at);
    if (atDelta !== 0) return atDelta;
    const keyOf = (entry: DiagnosticTimelineEntry): string =>
      entry.entryType === 'incident'
        ? `incident:${entry.incident.incidentId}`
        : entry.entryType === 'curve-boundary'
          ? `boundary:${entry.boundary.kind}:${entry.boundary.at}:${entry.boundary.supersededVersionId}`
          : `supersession:${entry.supersededVersionId}`;
    return keyOf(a) < keyOf(b) ? -1 : 1;
  });
}

// ---------------------------------------------------------------------------
// Convenience bundle
// ---------------------------------------------------------------------------

/** Everything the diagnostics view needs, derived from the store + incidents. */
export interface CurveDiagnosticsReport {
  readonly boundaries: readonly CurveBoundary[];
  readonly supersessions: readonly CurveSupersessionRecord[];
  readonly annotatedIncidents: readonly AnnotatedTrendIncident[];
  readonly timeline: readonly DiagnosticTimelineEntry[];
  readonly adjacencyMs: number;
}

/** Boundaries + supersession records + annotated incidents + timeline, in one call. */
export function curveDiagnosticsReport(
  store: RatingCurveStore,
  incidents: readonly TrendIncident[],
  options: CurveDiagnosticsOptions = {},
): CurveDiagnosticsReport {
  const boundaries = approvedBoundaries(store);
  const supersessions = curveSupersessionsOf(store);
  const annotatedIncidents = annotateCurveBoundaries(incidents, boundaries, options);
  return {
    boundaries,
    supersessions,
    annotatedIncidents,
    timeline: diagnosticTimeline(annotatedIncidents, boundaries, supersessions),
    adjacencyMs: options.adjacencyMs ?? DEFAULT_ADJACENCY_MS,
  };
}
