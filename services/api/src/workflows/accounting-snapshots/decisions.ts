/**
 * Decision snapshots (WD-025-R2; FR-028; T-06): record a distribution
 * decision capturing the EXACT observation/revision versions, rating-curve
 * lineage and calculation inputs it rests on.
 *
 * FR-028: "A saved distribution decision references the exact observation
 * or revision versions used; later corrections do not change those
 * referenced values or the decision's recorded calculation inputs."
 *
 * How that is guaranteed here:
 * - EVIDENCE IS COPIED, NOT REFERENCED: recordDecision reads the CURRENT
 *   head of each observation's revision chain (the WD-011 revision store)
 *   and the CURRENT approved curve versions (the WD-011-R2 rating-curve
 *   store) and copies ids/values/inputs into a deep-frozen snapshot. A
 *   correction appended afterwards extends the chain; the snapshot keeps
 *   the pinned bytes (the immutability suite asserts byte-identity under a
 *   real appendRevision + curve supersession).
 * - THE NUMBERS NEVER MOVE EITHER: basisTotals are produced by the WD-008
 *   aggregation over the resolved window at recording time (same calls and
 *   grant gates as the WD-025 generator), then frozen into the record.
 * - Determinism: identifiers derive from the evidence hash; identical
 *   stores + clock + request yield byte-identical snapshots.
 *
 * Authority: recording a distribution decision is gated like report
 * generation (action generate-reports on the system object - the WD-025
 * scope gate is reused verbatim). Finalize/reopen authority is the SEPARATE
 * review-data gate in finalize.ts.
 *
 * Pure: injected deps and clock; no I/O beyond the fixture stores.
 */
import { POLICY_VERSION, type PolicyWorld } from '../../../../../packages/policy/src/index.ts';
import { aggregateSeries } from '../../series/aggregate.ts';
import { grantAllowed, readStreamGrant } from '../../series/grantCheck.ts';
import type { SeriesStore } from '../../series/load.ts';
import { seriesStore } from '../../series/load.ts';
import type { DomainResult, ProcessingBasis } from '../../series/types.ts';
import { denial } from '../../series/types.ts';
import type { ObservationRow } from '../revisions/types.ts';
import type { RevisionRecord, RevisionStore } from '../revisions/store.ts';
import { createRevisionStore } from '../revisions/store.ts';
import type { RatingCurveShift, RatingCurveVersion } from '../rating-curves/types.ts';
import type { RatingCurveStore } from '../rating-curves/store.ts';
import { createRatingCurveStore, intervalsOverlap } from '../rating-curves/store.ts';
import { checkReportScope } from '../distribution-report/scope.ts';
import { reportWorld } from '../distribution-report/world.ts';
import { stationsInScope, statusExclusion, summaryWorld, type SummaryStation, type SummaryStream } from '../../summaries/world.ts';
import { accountingCategory, CATEGORY_LABELS, type AccountingCategory } from '../../summaries/totals.ts';
import { canonicalize, sha256Hex } from '../distribution-report/generate.ts';
import { ADVISORY_LABEL, deepFreeze, type CurveLineageEntry, type DecisionCategoryTotal, type DecisionSnapshot, type PeriodSpec, type ReferencedObservation } from './types.ts';
import { resolvePeriod } from './periods.ts';

// ---------------------------------------------------------------------------
// Revision ladder (mirror of series/aggregate.ts effectiveValue selection)
// ---------------------------------------------------------------------------

const MATURITY: Readonly<Record<string, number>> = { raw: 0, provisional: 1, reviewed: 2, 'best-available': 3 };

/**
 * The revision a decision USES at the selected basis: the chain head for
 * best-available, else the newest chain version at or above the basis
 * (the same at-or-above ladder as series/aggregate.ts effectiveValue).
 */
function revisionUsedAtBasis(chain: readonly RevisionRecord[], basis: ProcessingBasis): RevisionRecord | null {
  if (basis === 'raw' || chain.length === 0) return null;
  if (basis === 'best-available') return chain[chain.length - 1] ?? null;
  return [...chain].reverse().find((record) => MATURITY[record.processingLevel] >= MATURITY[basis]) ?? null;
}

/** Pin ONE observation against its chain at the selected basis. */
function pinObservation(observation: ObservationRow, chain: readonly RevisionRecord[], basis: ProcessingBasis): ReferencedObservation {
  const used = revisionUsedAtBasis(chain, basis);
  const head = chain[chain.length - 1] ?? null;
  return {
    observationId: observation.id,
    logicalKey: observation.logicalKey,
    streamId: observation.streamId,
    observedAt: observation.observedAt,
    revisionId: used ? used.id : null,
    usedVersion: used ? used.version : 0,
    headRevisionId: head ? head.id : null,
    chainVersion: chain.length,
    usedProcessingLevel: used ? used.processingLevel : 'raw',
    value: used ? used.value : observation.value,
    unitId: used ? used.unitId : observation.unitId,
    belowSelectedBasis: used === null && basis !== 'raw' && chain.length > 0,
  };
}

/** Curve lineage of one stream over the window: overlapping APPROVED versions + the version in force at start. */
function pinCurveLineage(
  curves: RatingCurveStore,
  stationId: string,
  streamId: string,
  start: string,
  end: string,
): CurveLineageEntry {
  const approvedOverlapping = (versions: readonly (RatingCurveVersion | RatingShift)[]): string[] =>
    versions
      .filter((version) => version.approvalState !== 'draft')
      .filter((version) => intervalsOverlap(version.effectiveFrom, version.effectiveTo, start, end))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((version) => version.id);
  const atStart = curves.approvedCurveAt(streamId, start);
  return {
    streamId,
    stationId,
    curveVersionIds: approvedOverlapping(curves.curveVersionsOf(streamId)),
    shiftVersionIds: approvedOverlapping(curves.shiftVersionsOf(streamId)),
    curveAtStart: atStart ? atStart.id : null,
    method: atStart ? atStart.method : '',
  };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface DecisionDeps {
  readonly store: SeriesStore;
  readonly revisions: RevisionStore;
  readonly curves: RatingCurveStore;
  /** Overrides the fixture report world (derived worlds in tests). */
  readonly world?: PolicyWorld | undefined;
  /** Injected clock: decidedAt, echoed verbatim. */
  readonly now: string;
}

/** Convenience wrapper over the shared fixture stores. */
export function fixtureDecisionDeps(now: string): DecisionDeps {
  return { store: seriesStore(), revisions: createRevisionStore(), curves: createRatingCurveStore(), now };
}

export interface DecisionRequest {
  readonly systemId: string;
  readonly period: PeriodSpec;
  readonly processingBasis: ProcessingBasis;
  readonly siteIds: readonly string[] | null;
  /** The decision statement, pinned verbatim into the snapshot. */
  readonly statement: string;
}

export type DecisionResult = DomainResult<DecisionSnapshot>;

/**
 * Record a distribution decision. The snapshot copies the EXACT current
 * evidence (revision ids at the selected basis, chain heads, curve lineage,
 * calculation inputs and basis totals) into a deep-frozen record whose id
 * derives from the evidence hash. Later corrections extend the stores; they
 * cannot reach into this record (test-proven byte identity).
 */
export function recordDecision(deps: DecisionDeps, request: DecisionRequest, actorId: string | null): DecisionResult {
  const world = deps.world ?? reportWorld().policyWorld;
  const scope = checkReportScope(world, actorId, request.systemId, deps.now);
  if (scope.outcome === 'denied') return scope;
  if (request.statement.trim() === '') {
    return denial(422, 'INVALID_STATEMENT', 'a decision must carry a non-empty statement');
  }

  const resolved = resolvePeriod(request.period);
  if (resolved.outcome === 'denied') return resolved;
  const window = resolved.value;
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);

  const summary = summaryWorld();
  let stations = stationsInScope(summary, request.systemId);
  if (request.siteIds !== null) {
    const systemIds = new Set(stations.map((station) => station.id));
    for (const siteId of [...new Set(request.siteIds)].sort()) {
      if (!systemIds.has(siteId)) {
        return denial(422, 'SITE_NOT_IN_SYSTEM', `site "${siteId}" is not part of system "${request.systemId}"`);
      }
    }
    const wanted = new Set(request.siteIds);
    stations = stations.filter((station) => wanted.has(station.id));
  }

  const referenced: ReferencedObservation[] = [];
  const lineage: CurveLineageEntry[] = [];
  const categoryStreams = new Map<AccountingCategory, { streamIds: string[]; volume: number; covered: number; duration: number; estimated: number }>();

  for (const station of stations) {
    if (statusExclusion(station.status) !== null) continue;
    for (const stream of [...station.streams].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const gate = readStreamGrant(deps.store, actorId, stream.id, deps.now);
      if (!grantAllowed(gate)) {
        // Fail closed: a system-level grant never bypasses the per-stream gate.
        return { outcome: 'denied', status: gate.status, code: gate.code, message: gate.message, ...(gate.policyReason !== undefined ? { policyReason: gate.policyReason } : {}) };
      }
      if (stream.observedPropertyId !== 'discharge' || stream.unitId !== 'cfs') continue;
      const category = accountingCategory(station, stream);
      if (category === null) continue;

      // EXACT observation/revision evidence inside the half-open window.
      for (const observation of deps.store.observationsForStream(stream.id)) {
        const at = Date.parse(observation.observedAt);
        if (at < startMs || at >= endMs) continue;
        referenced.push(pinObservation(observation, deps.revisions.loadChain(observation.logicalKey), request.processingBasis));
      }
      lineage.push(pinCurveLineage(deps.curves, station.id, stream.id, window.start, window.end));

      // Basis totals: WD-008 aggregation over the same window (frozen copies).
      const result = aggregateSeries(deps.store, {
        streamId: stream.id,
        start: window.start,
        end: window.end,
        basis: request.processingBasis,
        interval: 'daily',
      });
      if (result.outcome === 'denied') return result;
      const bucket = categoryStreams.get(category) ?? { streamIds: [], volume: 0, covered: 0, duration: 0, estimated: 0 };
      bucket.streamIds.push(stream.id);
      for (const day of result.value.buckets) {
        bucket.volume += day.volumeAcreFeet ?? 0;
        bucket.covered += day.coveredSeconds;
        bucket.duration += day.durationSeconds;
        bucket.estimated += day.estimatedSeconds;
      }
      categoryStreams.set(category, bucket);
    }
  }

  referenced.sort((a, b) => (a.observationId < b.observationId ? -1 : 1));
  lineage.sort((a, b) => (a.streamId < b.streamId ? -1 : 1));

  const CATEGORY_ORDER: readonly AccountingCategory[] = ['natural-channel-flow', 'canal-delivery', 'reservoir-release'];
  const basisTotals: DecisionCategoryTotal[] = CATEGORY_ORDER.filter((category) => categoryStreams.has(category)).map((category) => {
    const bucket = categoryStreams.get(category)!;
    return {
      category,
      label: CATEGORY_LABELS[category],
      streamIds: Object.freeze(bucket.streamIds),
      volumeAcreFeet: bucket.volume,
      volumeUnit: 'acre-feet' as const,
      coveredSeconds: bucket.covered,
      durationSeconds: bucket.duration,
      coverageFraction: bucket.duration > 0 ? bucket.covered / bucket.duration : 0,
      estimatedSeconds: bucket.estimated,
      estimatedProportion: bucket.covered > 0 ? bucket.estimated / bucket.covered : 0,
    };
  });

  const calculationInputs = {
    processingBasis: request.processingBasis,
    aggregationMethod: 'rectangle-right@1',
    policyVersion: POLICY_VERSION,
    periodRule: window.dateRule,
    curveMethods: Object.freeze([...new Set(lineage.filter((entry) => entry.method !== '').map((entry) => entry.method))].sort()),
    supplementalPolicy: ADVISORY_LABEL,
  };

  // Evidence hash over everything the decision rests on EXCEPT decidedAt
  // (same evidence at a later time = same evidence hash, distinct snapshot).
  const evidenceHash = sha256Hex(
    canonicalize({
      schemaVersion: 'accounting-snapshots@1',
      kind: 'decision-evidence@1',
      systemId: request.systemId,
      period: request.period,
      decidedBy: actorId,
      statement: request.statement,
      calculationInputs,
      referencedObservations: referenced,
      curveLineage: lineage,
      basisTotals,
    }),
  );

  const snapshot: DecisionSnapshot = deepFreeze({
    schemaVersion: 'accounting-snapshots@1',
    decisionId: `dec-${evidenceHash.slice(0, 12)}`,
    systemId: request.systemId,
    period: request.period,
    resolvedPeriod: { start: window.start, end: window.end, dateRule: window.dateRule, timeZone: window.timeZone },
    decidedBy: actorId ?? 'anonymous',
    decidedAt: deps.now,
    statement: request.statement,
    calculationInputs,
    referencedObservations: Object.freeze(referenced),
    curveLineage: Object.freeze(lineage),
    basisTotals: Object.freeze(basisTotals),
    evidenceHash,
  });
  return { outcome: 'allowed', value: snapshot };
}

/** Canonical serialization of a snapshot (byte-identity comparisons). */
export function decisionBytes(snapshot: DecisionSnapshot): string {
  return canonicalize(snapshot);
}

/** Independent sha256 helper for callers verifying snapshot bytes. */
export { sha256Hex };
