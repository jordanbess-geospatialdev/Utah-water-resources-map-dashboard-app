/**
 * Pure derivation of the FR-042 point/interval audit table model.
 *
 * "Selecting a point or flagged interval displays all authorized revisions
 * with actor, timestamp, original and replacement value, qualifiers and
 * reason, including a revision later superseded by another edit."
 *
 * This module is deliberately dependency-free and pure: it turns an
 * observation (or a flagged interval of a stream) plus its append-only
 * revision chain into a render-ready row model. It never mutates its inputs,
 * reads no clock, and loads no fixtures - the panel passes the contract
 * fixtures (or any other data) in, and derivation.test.ts feeds it both the
 * frozen fixture chain and synthetic tombstones.
 *
 * Time discipline carried end to end (technical specification, "Originals and
 * corrections"): OBSERVATION time (when the water was measured, with the
 * retained source offset) is a different field from REVISION time (when a
 * person recorded an edit). Both surface separately in every row model.
 */

/** Revision kinds. `exclusion` is the FR-039 withdrawal tombstone. */
export type ChainRevisionType = 'correction' | 'level-advance' | 'exclusion';

/** Governed non-raw processing levels a revision may assert. */
export type ChainProcessingLevel = 'provisional' | 'reviewed' | 'best-available';

/**
 * Evidence a withdrawal tombstone retains so the withdrawn original stays
 * available per the approved retention and visibility policy (FR-039). The
 * raw row itself is never edited; this snapshot mirrors it at withdrawal.
 */
export interface RetainedOriginal {
  readonly value: number | null;
  readonly unitId: string;
  readonly observedAt: string;
  readonly sourceOffset: string;
  readonly sourceEventId: string;
  readonly sourceId: string;
  readonly receivedAt: string;
}

/**
 * One revision of the append-only chain. Structurally compatible with both
 * the shell fixture revisions (correction/level-advance) and the API-side
 * revision records (adds the exclusion tombstone fields).
 */
export interface ChainRevision {
  readonly id: string;
  readonly targetObservationId: string;
  readonly baseRevisionId: string | null;
  readonly type: ChainRevisionType;
  readonly value: number | null;
  readonly unitId: string;
  readonly processingLevel: ChainProcessingLevel;
  readonly qualifierIds: readonly string[];
  readonly reason: string;
  readonly actorId: string;
  /** REVISION time: when this edit was recorded (not the observation time). */
  readonly recordedAt: string;
  readonly idempotencyKey?: string | null;
  /** True exactly on exclusions; derivable from type but kept explicit for the fixture shape. */
  readonly excluded?: boolean;
  readonly retainedOriginal?: RetainedOriginal | null;
}

/** A raw observation row exactly as received (never edited). */
export interface AuditObservation {
  readonly id: string;
  readonly logicalKey: string;
  readonly streamId: string;
  /** OBSERVATION time of the reading. */
  readonly observedAt: string;
  readonly sourceOffset: string;
  readonly value: number | null;
  readonly unitId: string;
  readonly valueType: 'observed' | 'estimated';
  readonly receivedAt: string;
  readonly sourceEventId: string;
  readonly sourceId: string;
  readonly note?: string;
}

/** Supersession status of one revision within its chain. */
export type RevisionStatus = 'current' | 'superseded';

/** Shape + text status vocabulary (never color-only meaning): */
export type StatusMarker = '●' | '○' | '✕';

/** One audit table row: one revision with its before/after and status. */
export interface QualityHistoryRow {
  /** 1-based chain ordinal; the value an If-Match optimistic version refers to. */
  readonly version: number;
  readonly revisionId: string;
  readonly baseRevisionId: string | null;
  readonly observationId: string;
  readonly logicalKey: string;
  readonly streamId: string;
  /** OBSERVATION time of the target point (measurement time). */
  readonly observedAt: string;
  /** REVISION time of this edit (recorded time). Deliberately a separate field. */
  readonly recordedAt: string;
  readonly type: ChainRevisionType;
  readonly actorId: string;
  /** Display name when a name table was supplied, else the actor id. */
  readonly actorName: string;
  /** Value this revision replaced: the previous revision's value, or the raw original for version 1. */
  readonly originalValue: number | null;
  readonly originalUnitId: string;
  /** Value this revision asserted; null on tombstones (the point is withdrawn). */
  readonly replacementValue: number | null;
  readonly replacementUnitId: string;
  readonly processingLevel: ChainProcessingLevel;
  readonly isTombstone: boolean;
  /** Retained original evidence on tombstones (FR-039); null otherwise. */
  readonly retainedOriginal: RetainedOriginal | null;
  readonly qualifierIds: readonly string[];
  /** Governed qualifier display names, resolved through the supplied table. */
  readonly qualifierNames: readonly string[];
  readonly reason: string;
  readonly status: RevisionStatus;
  readonly statusText: string;
  readonly statusMarker: StatusMarker;
  readonly supersededByRevisionId: string | null;
  readonly supersededByVersion: number | null;
}

/** Raw provenance of the never-edited original row. */
export interface QualityProvenance {
  readonly observationId: string;
  readonly logicalKey: string;
  readonly streamId: string;
  readonly observedAt: string;
  readonly sourceOffset: string;
  readonly receivedAt: string;
  readonly value: number | null;
  readonly unitId: string;
  readonly valueType: 'observed' | 'estimated';
  readonly sourceEventId: string;
  readonly sourceId: string;
  readonly note?: string;
}

/** Full audit model for one selected point. */
export interface PointQualityHistory {
  readonly kind: 'point';
  readonly provenance: QualityProvenance;
  /** Every revision in chain order, superseded ones included (FR-042). */
  readonly rows: readonly QualityHistoryRow[];
  readonly hasRevisions: boolean;
}

/** Audit model for a flagged interval: rows across every revised point in window. */
export interface IntervalQualityHistory {
  readonly kind: 'interval';
  readonly streamId: string;
  /** Effective half-open bounds [start, end) on OBSERVATION time, returned per the temporal rules. */
  readonly start: string;
  readonly end: string;
  readonly rows: readonly QualityHistoryRow[];
  readonly revisedPointCount: number;
}

export type QualityHistoryModel = PointQualityHistory | IntervalQualityHistory;

/** Optional display-name tables (ids are always the fallback). */
export interface NameTables {
  readonly actorNames?: Readonly<Record<string, string>>;
  readonly qualifierNames?: Readonly<Record<string, string>>;
}

/** Half-open interval selector on observation time. */
export interface IntervalSelector {
  readonly streamId: string;
  readonly start: string;
  readonly end: string;
}

function chainFor(observationId: string, revisions: readonly ChainRevision[]): ChainRevision[] {
  return revisions
    .filter((revision) => revision.targetObservationId === observationId)
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a.id.localeCompare(b.id));
}

function isTombstone(revision: ChainRevision): boolean {
  return revision.type === 'exclusion' || revision.excluded === true;
}

function statusFor(
  position: number,
  chainLength: number,
  tombstone: boolean,
  nextVersion: number | null,
): { status: RevisionStatus; statusText: string; statusMarker: StatusMarker } {
  const current = position === chainLength - 1;
  if (tombstone) {
    return {
      status: current ? 'current' : 'superseded',
      statusText: current ? 'Withdrawn — current' : `Withdrawn — superseded by v${nextVersion}`,
      statusMarker: '✕',
    };
  }
  return current
    ? { status: 'current', statusText: 'Current', statusMarker: '●' }
    : { status: 'superseded', statusText: `Superseded by v${nextVersion}`, statusMarker: '○' };
}

function rowFor(
  observation: AuditObservation,
  chain: readonly ChainRevision[],
  index: number,
  names: NameTables,
): QualityHistoryRow {
  const revision = chain[index] as ChainRevision;
  const previous = index > 0 ? (chain[index - 1] as ChainRevision) : null;
  const next = index + 1 < chain.length ? (chain[index + 1] as ChainRevision) : null;
  const tombstone = isTombstone(revision);
  const status = statusFor(index, chain.length, tombstone, next ? index + 2 : null);
  const qualifierNames = revision.qualifierIds.map(
    (id) => names.qualifierNames?.[id] ?? id,
  );
  return {
    version: index + 1,
    revisionId: revision.id,
    baseRevisionId: revision.baseRevisionId,
    observationId: observation.id,
    logicalKey: observation.logicalKey,
    streamId: observation.streamId,
    observedAt: observation.observedAt,
    recordedAt: revision.recordedAt,
    type: revision.type,
    actorId: revision.actorId,
    actorName: names.actorNames?.[revision.actorId] ?? revision.actorId,
    originalValue: previous ? previous.value : observation.value,
    originalUnitId: previous ? previous.unitId : observation.unitId,
    replacementValue: revision.value,
    replacementUnitId: revision.unitId,
    processingLevel: revision.processingLevel,
    isTombstone: tombstone,
    retainedOriginal: revision.retainedOriginal ?? null,
    qualifierIds: revision.qualifierIds,
    qualifierNames,
    reason: revision.reason,
    ...status,
    supersededByRevisionId: next ? next.id : null,
    supersededByVersion: next ? index + 2 : null,
  };
}

function provenanceOf(observation: AuditObservation): QualityProvenance {
  const provenance: QualityProvenance = {
    observationId: observation.id,
    logicalKey: observation.logicalKey,
    streamId: observation.streamId,
    observedAt: observation.observedAt,
    sourceOffset: observation.sourceOffset,
    receivedAt: observation.receivedAt,
    value: observation.value,
    unitId: observation.unitId,
    valueType: observation.valueType,
    sourceEventId: observation.sourceEventId,
    sourceId: observation.sourceId,
  };
  return observation.note === undefined ? provenance : { ...provenance, note: observation.note };
}

/**
 * Full point audit: the raw provenance plus every revision of the chain in
 * order, including revisions later superseded by another edit (FR-042).
 */
export function pointQualityHistory(
  observation: AuditObservation,
  revisions: readonly ChainRevision[],
  names: NameTables = {},
): PointQualityHistory {
  const chain = chainFor(observation.id, revisions);
  return {
    kind: 'point',
    provenance: provenanceOf(observation),
    rows: chain.map((_, index) => rowFor(observation, chain, index, names)),
    hasRevisions: chain.length > 0,
  };
}

/**
 * Interval audit over a flagged interval: every revision of every revised
 * point of the stream whose OBSERVATION time falls in the half-open window
 * [start, end). Unrevised points are not rows (an interval audit answers
 * "what was changed here"); superseded revisions are included.
 */
export function intervalQualityHistory(
  observations: readonly AuditObservation[],
  revisions: readonly ChainRevision[],
  selector: IntervalSelector,
  names: NameTables = {},
): IntervalQualityHistory {
  const from = Date.parse(selector.start);
  const to = Date.parse(selector.end);
  const rows: QualityHistoryRow[] = [];
  let revisedPointCount = 0;
  for (const observation of observations) {
    if (observation.streamId !== selector.streamId) continue;
    const at = Date.parse(observation.observedAt);
    if (at < from || at >= to) continue;
    const chain = chainFor(observation.id, revisions);
    if (chain.length === 0) continue;
    revisedPointCount += 1;
    rows.push(...chain.map((_, index) => rowFor(observation, chain, index, names)));
  }
  rows.sort(
    (a, b) =>
      Date.parse(a.observedAt) - Date.parse(b.observedAt) ||
      a.version - b.version ||
      a.revisionId.localeCompare(b.revisionId),
  );
  return {
    kind: 'interval',
    streamId: selector.streamId,
    start: selector.start,
    end: selector.end,
    rows,
    revisedPointCount,
  };
}

/** Reason codes that make a point worth auditing (flag vocabulary is UI-side). */
export type PointFlagReason =
  | 'revised'
  | 'null-frame'
  | 'out-of-range'
  | 'negative'
  | 'suspect-zero'
  | 'estimated';

export interface PointAuditTarget {
  readonly observation: AuditObservation;
  readonly revisionCount: number;
  readonly flags: readonly PointFlagReason[];
}

/**
 * Selectable point targets for a stream: every point that is revised or
 * otherwise quality-flagged. Pure: the valid range comes in as an argument
 * (the caller reads it from the station fixture).
 */
export function pointAuditTargets(
  observations: readonly AuditObservation[],
  revisions: readonly ChainRevision[],
  streamId: string,
  validRange?: { readonly min: number; readonly max: number },
): readonly PointAuditTarget[] {
  const revisionCountByObservation = new Map<string, number>();
  for (const revision of revisions) {
    revisionCountByObservation.set(
      revision.targetObservationId,
      (revisionCountByObservation.get(revision.targetObservationId) ?? 0) + 1,
    );
  }
  return observations
    .filter((observation) => observation.streamId === streamId)
    .map((observation) => {
      const flags: PointFlagReason[] = [];
      const revisionCount = revisionCountByObservation.get(observation.id) ?? 0;
      if (revisionCount > 0) flags.push('revised');
      if (observation.value === null) flags.push('null-frame');
      if (observation.value !== null && validRange) {
        if (observation.value > validRange.max) flags.push('out-of-range');
        if (observation.value < validRange.min) flags.push('negative');
      }
      if (observation.value === 0) flags.push('suspect-zero');
      if (observation.valueType === 'estimated') flags.push('estimated');
      return { observation, revisionCount, flags };
    })
    .filter((target) => target.flags.length > 0)
    .sort((a, b) => Date.parse(a.observation.observedAt) - Date.parse(b.observation.observedAt));
}

/** Value + unit presentation shared by the table and provenance card. */
export function formatAuditValue(value: number | null, unitId: string): string {
  return value === null ? 'no value' : `${value} ${unitId}`;
}

/** "original → replacement" cell text; tombstones present the retained original. */
export function formatChange(row: QualityHistoryRow): string {
  if (row.isTombstone) {
    const retained = row.retainedOriginal;
    const retainedText = retained
      ? `original ${formatAuditValue(retained.value, retained.unitId)} retained`
      : 'original retained';
    return `${formatAuditValue(row.originalValue, row.originalUnitId)} → withdrawn (${retainedText})`;
  }
  return `${formatAuditValue(row.originalValue, row.originalUnitId)} → ${formatAuditValue(row.replacementValue, row.replacementUnitId)}`;
}
