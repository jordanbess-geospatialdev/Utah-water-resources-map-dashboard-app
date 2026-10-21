/**
 * FR-044 historical as-of reconstruction over the revision store (WD-023-R2).
 *
 * Bounded contract (docs/extensions/r2/R2-EXTENSIONS-SCOPE.md, ratified by
 * the orchestrator): given an as-of instant T, a query returns the
 * observation state as known at T - the revisions RECORDED at or before T
 * (recorded-time semantics; observation time and revision time remain
 * distinct fields end to end, exactly like visit time vs recorded time in
 * WD-012). The revision store already retains everything required; this
 * module only reads it.
 *
 *   - Boundary: recordedAt <= T is INCLUDED (closed lower bound ON T);
 *     revisions recorded later are excluded and COUNTED. Tested at the
 *     exact boundary instant and one millisecond past it.
 *   - Basis: every result carries an asOfBasis block {asOf,
 *     latestConsideredRevisionId, excludedLaterCount}; exports embed the
 *     derived basis label so the output states its own as-of basis. The
 *     label and export bytes freeze only the REPRODUCIBLE basis (asOf +
 *     basis revision): excludedLaterCount counts revisions recorded after T
 *     and therefore grows with later appends, so it stays on the live
 *     result object and out of the byte-stable export.
 *   - Determinism: identical inputs serialize byte-identically, and a
 *     correction recorded AFTER T provably does not change the serialized
 *     T-view (post-correction reproduction test).
 *   - Authorization: the @utah-water/policy engine decides, evaluated AS OF
 *     T - a grant that only became effective after T does not open the
 *     T-view, and a restricted stream stays hidden from out-of-scope
 *     actors (cross-scope denial maps to a hidden-object 404, like the
 *     WD-012 attachment wall). Public streams answer via the public read
 *     branch, which is publication-state based and time independent.
 *
 * Purity: no clock reads (every instant is injected), no randomness, no
 * I/O, no network. The module is a read-only projection over an injected
 * AsOfSource (satisfied structurally by the WD-011 RevisionStore).
 */
import {
  evaluate,
  evaluatePublicRead,
  type Decision,
  type PolicyWorld,
  type Principal,
} from '../../../../packages/policy/src/index.ts';
import type {
  ObservationRow,
  ProcessingLevel,
  RevisionRecord,
} from '../../../../services/api/src/workflows/revisions/types.ts';

// ---------------------------------------------------------------------------
// Source seam (structural: the WD-011 RevisionStore satisfies it unchanged)
// ---------------------------------------------------------------------------

/** The read surface as-of reconstruction needs; no mutation path exists here. */
export interface AsOfSource {
  readonly observations: readonly ObservationRow[];
  readonly world: PolicyWorld;
  observationByLogicalKey(logicalKey: string): ObservationRow | null;
  /** Full revision chain for a logical key in append (recorded-time) order. */
  loadChain(logicalKey: string): readonly RevisionRecord[];
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** The basis every as-of result states (FR-044). */
export interface AsOfBasis {
  /** Normalized UTC instant (Date.toISOString form). */
  readonly asOf: string;
  /** Revision id the returned state came from; null when the T-view is the raw original. */
  readonly latestConsideredRevisionId: string | null;
  /** Revisions on the chain recorded AFTER T - excluded from this view and counted. */
  readonly excludedLaterCount: number;
}

/** One observation's state as known at T. */
export interface AsOfPointState {
  readonly logicalKey: string;
  readonly observationId: string;
  readonly streamId: string;
  /** OBSERVATION time (when the reading was taken) - distinct from revision time. */
  readonly observedAt: string;
  /** RECORDED receive time of the raw row; the row exists for the T-view only when receivedAt <= T. */
  readonly receivedAt: string;
  readonly value: number | null;
  readonly unitId: string;
  readonly processingLevel: ProcessingLevel;
  readonly qualifierIds: readonly string[];
  /** The revision that produced this state; null == raw original as received. */
  readonly revisionId: string | null;
  /** True when the latest considered revision is an exclusion tombstone (FR-039). */
  readonly excluded: boolean;
  /** Observed/estimated flag of the raw row (revisions restate value, not valueType). */
  readonly valueType: ObservationRow['valueType'];
  readonly asOfBasis: AsOfBasis;
}

/** Stable machine codes, aligned with the shared error policy vocabulary. */
export type AsOfDenialCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION_FAILED';

/** Shared denial shape (mapped from engine reasons like WD-012 attachments). */
export interface AsOfDenial {
  readonly outcome: 'denied';
  readonly status: 401 | 403 | 404 | 422;
  readonly code: AsOfDenialCode;
  readonly message: string;
  /** Engine DENY_* reason when this denial came from policy; null for input validation. */
  readonly policyReason: string | null;
}

/** The observation was not yet received at T: a gap in the T-view. */
export interface AsOfGap {
  readonly outcome: 'gap';
  readonly logicalKey: string;
  readonly observationId: string;
  readonly streamId: string;
  readonly observedAt: string;
  readonly reason: 'observation-not-yet-received';
  readonly asOfBasis: AsOfBasis;
}

export type AsOfPointResult = AsOfDenial | AsOfGap | { readonly outcome: 'known'; readonly point: AsOfPointState };

/** One point of a range T-view series: known state, or a gap marker. */
export type AsOfSeriesPoint =
  | { readonly state: 'known'; readonly point: AsOfPointState }
  | { readonly state: 'gap'; readonly observedAt: string; readonly logicalKey: string; readonly reason: 'observation-not-yet-received' };

export interface AsOfRangeResult {
  readonly outcome: 'ok';
  readonly streamId: string;
  /** Half-open observation-time window [from, to). */
  readonly from: string;
  readonly to: string;
  readonly points: readonly AsOfSeriesPoint[];
  readonly knownCount: number;
  readonly gapCount: number;
  /** Aggregate basis: latest considered revision across the series + total excluded-later count. */
  readonly asOfBasis: AsOfBasis;
}

export type AsOfRangeDecision = AsOfDenial | AsOfRangeResult;

// ---------------------------------------------------------------------------
// Input contracts
// ---------------------------------------------------------------------------

/** Point query: one logical observation key at instant T. */
export interface AsOfPointQuery {
  /** Acting principal (null = anonymous public read); entitlements evaluated as of `asOf`. */
  readonly principal: Principal | null;
  readonly logicalKey: string;
  /** As-of instant T (UTC ISO-8601). Normalized internally; unparseable input is a 422. */
  readonly asOf: string;
}

/** Range query: every observation of a stream whose observedAt falls in [from, to). */
export interface AsOfRangeQuery {
  readonly principal: Principal | null;
  readonly streamId: string;
  /** Inclusive lower bound on observation time. */
  readonly from: string;
  /** Exclusive upper bound on observation time. */
  readonly to: string;
  readonly asOf: string;
}

// ---------------------------------------------------------------------------
// Basis and serialization
// ---------------------------------------------------------------------------

/** Normalize an injected instant to canonical UTC form; null when unparseable. */
export function normalizeInstant(instant: string): string | null {
  const ms = Date.parse(instant);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * The FR-044 basis label every export carries, e.g.
 *   as-of:2026-03-08T15:30:00.000Z | basis:rev-corinne-2001
 * ("raw-original" when no revision had been recorded by T). The label states
 * the REPRODUCIBLE basis only: `excludedLaterCount` is deliberately NOT in
 * the label or the export bytes, because a count of later revisions grows
 * whenever a later correction is appended, and FR-044 requires the export
 * to reproduce byte-identically after later corrections. The count stays on
 * the live result object (and `excludedLaterNote` renders it for UIs).
 */
export function asOfBasisLabel(basis: AsOfBasis): string {
  const basisId = basis.latestConsideredRevisionId ?? 'raw-original';
  return `as-of:${basis.asOf} | basis:${basisId}`;
}

/** Live transparency note for UIs (NOT part of the byte-stable export). */
export function excludedLaterNote(basis: AsOfBasis): string {
  return `${String(basis.excludedLaterCount)} later revision${basis.excludedLaterCount === 1 ? '' : 's'} excluded`;
}

/**
 * Canonical EXPORT serialization with the basis label embedded. This is the
 * artifact FR-044 pins: identical inputs produce byte-identical bytes, and
 * a correction recorded after T does not change them (post-correction
 * reproduction test). The volatile later-revision count is intentionally
 * absent (see asOfBasisLabel); every T-view field is present, rebuilt in a
 * fixed field order from normalized values so JSON.stringify is
 * deterministic.
 */
export function serializeAsOfPointResult(result: AsOfPointResult): string {
  if (result.outcome !== 'known') {
    return JSON.stringify({ type: 'as-of-point', basisLabel: null, result });
  }
  const point = result.point;
  return JSON.stringify({
    type: 'as-of-point',
    basisLabel: asOfBasisLabel(point.asOfBasis),
    view: {
      logicalKey: point.logicalKey,
      observationId: point.observationId,
      streamId: point.streamId,
      observedAt: point.observedAt,
      receivedAt: point.receivedAt,
      value: point.value,
      unitId: point.unitId,
      processingLevel: point.processingLevel,
      qualifierIds: point.qualifierIds,
      revisionId: point.revisionId,
      excluded: point.excluded,
      valueType: point.valueType,
      asOf: point.asOfBasis.asOf,
      basisRevisionId: point.asOfBasis.latestConsideredRevisionId,
    },
  });
}

/** Canonical EXPORT serialization of a range T-view series (same contract). */
export function serializeAsOfRangeResult(result: AsOfRangeDecision): string {
  if (result.outcome !== 'ok') {
    return JSON.stringify({ type: 'as-of-range', basisLabel: null, result });
  }
  return JSON.stringify({
    type: 'as-of-range',
    basisLabel: asOfBasisLabel(result.asOfBasis),
    view: {
      streamId: result.streamId,
      from: result.from,
      to: result.to,
      knownCount: result.knownCount,
      gapCount: result.gapCount,
      basisRevisionId: result.asOfBasis.latestConsideredRevisionId,
      points: result.points.map((entry) =>
        entry.state === 'known'
          ? {
              state: entry.state,
              observedAt: entry.point.observedAt,
              logicalKey: entry.point.logicalKey,
              value: entry.point.value,
              unitId: entry.point.unitId,
              processingLevel: entry.point.processingLevel,
              qualifierIds: entry.point.qualifierIds,
              revisionId: entry.point.revisionId,
              excluded: entry.point.excluded,
            }
          : { state: entry.state, observedAt: entry.observedAt, logicalKey: entry.logicalKey, reason: entry.reason },
      ),
    },
  });
}

// ---------------------------------------------------------------------------
// Authorization (policy engine, evaluated AS OF T)
// ---------------------------------------------------------------------------

const PUBLIC_READ_ACTION = 'browse-published';
const RESTRICTED_READ_ACTION = 'view-restricted-details';

function toDenial(reason: string, isPublic: boolean): AsOfDenial {
  if (reason === 'DENY_ANONYMOUS' || reason === 'DENY_UNKNOWN_PRINCIPAL' || reason === 'DENY_PRINCIPAL_INACTIVE') {
    return { outcome: 'denied', status: 401, code: 'UNAUTHENTICATED', message: 'as-of reconstruction requires an authenticated, active principal for this object', policyReason: reason };
  }
  if (reason === 'DENY_UNKNOWN_OBJECT') {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'object not found', policyReason: reason };
  }
  // Hidden-object rule (WD-012 attachment wall pattern): out-of-scope actors
  // learn NOTHING about non-public observations, not even their existence.
  if (reason === 'DENY_OUT_OF_SCOPE' && !isPublic) {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'object not found', policyReason: reason };
  }
  return { outcome: 'denied', status: 403, code: 'FORBIDDEN', message: `as-of query denied (${reason})`, policyReason: reason };
}

/**
 * Decide whether the acting principal may reconstruct this observation's
 * T-view at all. Public observations answer via the public read branch
 * (publication state is time independent); everything else requires an
 * in-scope restricted-read grant, evaluated as of T.
 */
function authorizeObservation(source: AsOfSource, observation: ObservationRow, principal: Principal | null, asOf: string): AsOfDenial | null {
  const policyObject = source.world.objects[observation.id];
  if (!policyObject) {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'object not found', policyReason: 'DENY_UNKNOWN_OBJECT' };
  }
  const publicRead = evaluatePublicRead(
    { principal: null, action: PUBLIC_READ_ACTION, object: { kind: policyObject.kind, id: policyObject.id } },
    source.world,
    asOf,
  );
  if (publicRead.effect === 'allow') return null;
  const decision: Decision = evaluate(
    { principal, action: RESTRICTED_READ_ACTION, object: { kind: policyObject.kind, id: policyObject.id, fields: ['public'] } },
    source.world,
    asOf,
  );
  if (decision.effect === 'allow') return null;
  return toDenial(decision.reason, policyObject.visibility === 'public');
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

interface ChainView {
  readonly considered: readonly RevisionRecord[];
  readonly head: RevisionRecord | null;
  readonly excludedLaterCount: number;
}

/**
 * The T-slice of one chain: revisions with recordedAt <= T in chain order
 * (closed lower bound ON T), the head being the last of them, plus the
 * count of revisions recorded after T. The chain is append-only and ordered
 * by recorded time, so "last considered" is also "latest recorded by T";
 * the (recordedAt, version) tiebreak makes that explicit and total.
 */
export function chainViewAt(chain: readonly RevisionRecord[], asOfMs: number): ChainView {
  const considered = chain.filter((revision) => Date.parse(revision.recordedAt) <= asOfMs);
  const head =
    considered.length === 0
      ? null
      : [...considered].sort(
          (a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a.version - b.version || a.id.localeCompare(b.id),
        ).at(-1) ?? null;
  return { considered, head, excludedLaterCount: chain.length - considered.length };
}

function pointStateAt(observation: ObservationRow, chain: readonly RevisionRecord[], asOf: string): AsOfPointState {
  const view = chainViewAt(chain, Date.parse(asOf));
  const head = view.head;
  return {
    logicalKey: observation.logicalKey,
    observationId: observation.id,
    streamId: observation.streamId,
    observedAt: observation.observedAt,
    receivedAt: observation.receivedAt,
    value: head ? head.value : observation.value,
    unitId: head ? head.unitId : observation.unitId,
    processingLevel: head ? head.processingLevel : observation.processingLevel,
    qualifierIds: head ? [...head.qualifierIds] : [],
    revisionId: head ? head.id : null,
    excluded: head ? head.excluded : false,
    valueType: observation.valueType,
    asOfBasis: {
      asOf,
      latestConsideredRevisionId: head ? head.id : null,
      excludedLaterCount: view.excludedLaterCount,
    },
  };
}

/** Point query: the observation state as known at T (FR-044). */
export function reconstructAsOf(source: AsOfSource, query: AsOfPointQuery): AsOfPointResult {
  const asOf = normalizeInstant(query.asOf);
  if (asOf === null) {
    return { outcome: 'denied', status: 422, code: 'VALIDATION_FAILED', message: `unparseable as-of instant "${query.asOf}"`, policyReason: null };
  }
  const observation = source.observationByLogicalKey(query.logicalKey);
  if (!observation) {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: `no observation for logical key "${query.logicalKey}"`, policyReason: null };
  }
  const denial = authorizeObservation(source, observation, query.principal, asOf);
  if (denial) return denial;
  const chain = source.loadChain(query.logicalKey);
  const view = chainViewAt(chain, Date.parse(asOf));
  if (Date.parse(observation.receivedAt) > Date.parse(asOf)) {
    // The raw row itself arrived after T: the T-view has a gap here, not a value.
    return {
      outcome: 'gap',
      logicalKey: observation.logicalKey,
      observationId: observation.id,
      streamId: observation.streamId,
      observedAt: observation.observedAt,
      reason: 'observation-not-yet-received',
      asOfBasis: { asOf, latestConsideredRevisionId: view.head ? view.head.id : null, excludedLaterCount: view.excludedLaterCount },
    };
  }
  return { outcome: 'known', point: pointStateAt(observation, chain, asOf) };
}

/** Range query: the T-view series of a stream over observation time [from, to). */
export function reconstructRangeAsOf(source: AsOfSource, query: AsOfRangeQuery): AsOfRangeDecision {
  const asOf = normalizeInstant(query.asOf);
  if (asOf === null) {
    return { outcome: 'denied', status: 422, code: 'VALIDATION_FAILED', message: `unparseable as-of instant "${query.asOf}"`, policyReason: null };
  }
  const from = normalizeInstant(query.from);
  const to = normalizeInstant(query.to);
  if (from === null || to === null) {
    return { outcome: 'denied', status: 422, code: 'VALIDATION_FAILED', message: 'unparseable range bound', policyReason: null };
  }
  if (Date.parse(from) >= Date.parse(to)) {
    return { outcome: 'denied', status: 422, code: 'VALIDATION_FAILED', message: 'range must satisfy from < to (half-open [from, to))', policyReason: null };
  }
  if (!source.world.objects[query.streamId]) {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: `unknown stream "${query.streamId}"`, policyReason: null };
  }
  const asOfMs = Date.parse(asOf);
  const inWindow = source.observations
    .filter((observation) => observation.streamId === query.streamId)
    .filter((observation) => Date.parse(observation.observedAt) >= Date.parse(from) && Date.parse(observation.observedAt) < Date.parse(to))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.id.localeCompare(b.id));

  // Authorize EVERY observation in the window first: an out-of-scope actor
  // must not learn which timestamps are gaps on a restricted stream.
  for (const observation of inWindow) {
    const denial = authorizeObservation(source, observation, query.principal, asOf);
    if (denial) return denial;
  }

  const points: AsOfSeriesPoint[] = inWindow.map((observation) => {
    const chain = source.loadChain(observation.logicalKey);
    if (Date.parse(observation.receivedAt) > asOfMs) {
      return { state: 'gap', observedAt: observation.observedAt, logicalKey: observation.logicalKey, reason: 'observation-not-yet-received' };
    }
    return { state: 'known', point: pointStateAt(observation, chain, asOf) };
  });

  const known = points.filter((point): point is { state: 'known'; point: AsOfPointState } => point.state === 'known');
  const latestHead =
    known.length === 0
      ? null
      : known
          .map((entry) => entry.point.asOfBasis.latestConsideredRevisionId)
          .filter((id): id is string => id !== null)
          .sort()
          .at(-1) ?? null;
  const excludedLaterCount = known.reduce((sum, entry) => sum + entry.point.asOfBasis.excludedLaterCount, 0);

  return {
    outcome: 'ok',
    streamId: query.streamId,
    from,
    to,
    points,
    knownCount: known.length,
    gapCount: points.length - known.length,
    asOfBasis: { asOf, latestConsideredRevisionId: latestHead, excludedLaterCount },
  };
}
