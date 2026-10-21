/**
 * Point and interval audit derivation (FR-042).
 *
 * "Selecting a point or flagged interval displays all authorized revisions
 * with actor, timestamp, original and replacement value, qualifiers and
 * reason, including a revision later superseded by another edit."
 *
 * The derivation reads the store's append-only log and NEVER rewrites it:
 * every revision appears exactly once, in chain order, whether or not a later
 * revision superseded it. Observation time (when the water was measured) and
 * revision time (when a person changed the record) are separate fields end to
 * end - the technical specification requires this separation from the first
 * release so point-in-time reconstruction stays possible.
 */
import type { RevisionStore } from './store.ts';
import type { AuditEvent, ObservationRow, OutboxEvent, RevisionRecord, RetainedOriginal } from './types.ts';

/** One audit row: one revision of one observation, with its supersession status. */
export interface PointAuditRow {
  readonly observationId: string;
  readonly logicalKey: string;
  readonly streamId: string;
  /** OBSERVATION time: when the reading was taken (with source offset). */
  readonly observedAt: string;
  readonly sourceOffset: string;
  /** REVISION time: when this edit was recorded. Deliberately separate. */
  readonly recordedAt: string;
  readonly version: number;
  readonly revisionId: string;
  readonly baseRevisionId: string | null;
  readonly type: RevisionRecord['type'];
  readonly actorId: string;
  /** Value this revision replaced (raw value for version 1). */
  readonly originalValue: number | null;
  /** Value this revision asserted (null + excluded for tombstones). */
  readonly replacementValue: number | null;
  readonly unitId: string;
  readonly excluded: boolean;
  readonly qualifierIds: readonly string[];
  readonly reason: string;
  /** Id of the revision that superseded this one, null when this is the chain head. */
  readonly supersededByRevisionId: string | null;
  readonly isLatest: boolean;
  /** Retained original evidence on tombstones (FR-039). */
  readonly retainedOriginal: RetainedOriginal | null;
}

/** Raw provenance of the never-edited original row. */
export interface OriginalProvenance {
  readonly observationId: string;
  readonly logicalKey: string;
  readonly streamId: string;
  /** OBSERVATION time of the original reading, with the retained source offset. */
  readonly observedAt: string;
  readonly sourceOffset: string;
  /** INGEST time of the original row (when the raw event was received). */
  readonly receivedAt: string;
  readonly value: number | null;
  readonly unitId: string;
  readonly valueType: ObservationRow['valueType'];
  readonly sourceEventId: string;
  readonly sourceId: string;
  readonly note: string | undefined;
}

export interface PointAudit {
  readonly provenance: OriginalProvenance;
  readonly rows: readonly PointAuditRow[];
}

function rowFor(observation: ObservationRow, revision: RevisionRecord, previous: RevisionRecord | null, next: RevisionRecord | null): PointAuditRow {
  return {
    observationId: observation.id,
    logicalKey: observation.logicalKey,
    streamId: observation.streamId,
    observedAt: observation.observedAt,
    sourceOffset: observation.sourceOffset,
    recordedAt: revision.recordedAt,
    version: revision.version,
    revisionId: revision.id,
    baseRevisionId: revision.baseRevisionId,
    type: revision.type,
    actorId: revision.actorId,
    originalValue: previous ? previous.value : observation.value,
    replacementValue: revision.value,
    unitId: revision.unitId,
    excluded: revision.excluded,
    qualifierIds: revision.qualifierIds,
    reason: revision.reason,
    supersededByRevisionId: next ? next.id : null,
    isLatest: next === null,
    retainedOriginal: revision.retainedOriginal,
  };
}

function chainRows(observation: ObservationRow, chain: readonly RevisionRecord[]): PointAuditRow[] {
  return chain.map((revision, index) =>
    rowFor(observation, revision, chain[index - 1] ?? null, chain[index + 1] ?? null),
  );
}

function provenanceOf(observation: ObservationRow): OriginalProvenance {
  return {
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
    note: observation.note,
  };
}

/**
 * Full audit for one point: the raw provenance plus every revision, including
 * superseded ones. Returns null when the logical key does not resolve.
 */
export function pointAudit(store: RevisionStore, logicalKey: string): PointAudit | null {
  const observation = store.observationByLogicalKey(logicalKey);
  if (!observation) return null;
  return { provenance: provenanceOf(observation), rows: chainRows(observation, store.loadChain(logicalKey)) };
}

/**
 * Interval audit (FR-042 "point or flagged interval"): audit rows for every
 * observation of a stream whose OBSERVATION time falls in the half-open
 * window [start, end) - the same interval semantics the gap contract uses.
 * Superseded revisions are included; unrevised points are not (an interval
 * audit answers "what was changed here", the raw series answers the rest).
 */
export function intervalAudit(
  store: RevisionStore,
  streamId: string,
  start: string,
  end: string,
): readonly PointAuditRow[] {
  const from = Date.parse(start);
  const to = Date.parse(end);
  const rows: PointAuditRow[] = [];
  for (const observation of store.observations) {
    if (observation.streamId !== streamId) continue;
    const at = Date.parse(observation.observedAt);
    if (at < from || at >= to) continue;
    rows.push(...chainRows(observation, store.loadChain(observation.logicalKey)));
  }
  return rows.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.version - b.version);
}

/** Every audit row across the whole store, chain-ordered (export/report feed). */
export function allAuditRows(store: RevisionStore): readonly PointAuditRow[] {
  const rows: PointAuditRow[] = [];
  for (const observation of store.observations) {
    rows.push(...chainRows(observation, store.loadChain(observation.logicalKey)));
  }
  return rows;
}

/**
 * Correlated evidence for one mutation: the audit event and outbox event it
 * produced share a correlation id (ADR-10 traceability).
 */
export function evidenceFor(store: RevisionStore, correlationId: string): { audit: AuditEvent | null; outbox: OutboxEvent | null } {
  return {
    audit: store.auditEvents.find((event) => event.correlationId === correlationId) ?? null,
    outbox: store.outboxEvents.find((event) => event.correlationId === correlationId) ?? null,
  };
}
