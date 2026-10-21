/**
 * Fixture-backed append-only revision store (WD-011).
 *
 * Loads the frozen contract world (fixtures/contracts: observations with the
 * four seed revisions, stations, principals, vocabulary) and exposes the
 * chain query surface the correction workflow and the point/interval audit
 * build on: loadChain(logicalKey) and currentVersion(logicalKey).
 *
 * Invariants enforced here (FR-022/FR-039/FR-040):
 * - The raw observation rows are IMMUTABLE: they are loaded once, frozen,
 *   and no store operation has any code path that writes to them. The
 *   correction workflow appends revisions only.
 * - The revision log is append-only: entries are frozen records and are
 *   never removed, reordered or edited; superseded revisions stay.
 * - Every append is one logical transaction: revision row + audit event +
 *   transactional-outbox publication-refresh event (ADR-10) land together
 *   or not at all (the mutation function is synchronous end to end).
 * - The idempotency ledger maps key -> body fingerprint -> recorded
 *   revision, so a same-body replay returns the recorded result and a
 *   different-body replay can be rejected by the workflow.
 *
 * No clock reads and no randomness: identifiers are derived from the append
 * sequence, so two runs with the same injected clock and the same operations
 * produce byte-identical logs (see the determinism test).
 */
import { readFileSync } from 'node:fs';
import {
  buildWorld,
  type PolicyObject,
  type PolicyWorld,
  type StationsFixture,
} from '../../../../../packages/policy/src/index.ts';
import type {
  AuditEvent,
  ObservationRow,
  OutboxEvent,
  RetainedOriginal,
  RevisionRecord,
  RevisionSnapshot,
  RevisionType,
} from './types.ts';

/** Raw fixture observation shape (fields the store reads; notes preserved). */
interface RawObservation extends ObservationRow {}
interface RawRevision {
  id: string;
  targetObservationId: string;
  baseRevisionId: string | null;
  type: string;
  value: number | null;
  unitId: string;
  processingLevel: string;
  qualifierIds: string[];
  reason: string;
  actorId: string;
  recordedAt: string;
  idempotencyKey?: string;
}

const FIXTURE_DIR = '../../../../../fixtures/contracts/';

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(FIXTURE_DIR + name, import.meta.url), 'utf8')) as T;
}

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}

/** Canonical fingerprint of a request body for idempotency comparison. */
export function bodyFingerprint(parts: {
  type: RevisionType;
  value: number | null;
  unitId: string;
  processingLevel: string;
  qualifierIds: readonly string[];
  reason: string;
}): string {
  return JSON.stringify({
    type: parts.type,
    value: parts.value,
    unitId: parts.unitId,
    processingLevel: parts.processingLevel,
    qualifierIds: [...parts.qualifierIds].sort(),
    reason: parts.reason,
  });
}

export interface RevisionStore {
  /** The immutable raw observations, exactly as loaded from the contract fixture. */
  readonly observations: readonly ObservationRow[];
  /** Policy world including one policy object per observation (scoped to the owning station's system). */
  readonly world: PolicyWorld;
  /** All revisions in append order (fixture seed first). Superseded revisions remain. */
  readonly revisions: readonly RevisionRecord[];
  readonly auditEvents: readonly AuditEvent[];
  readonly outboxEvents: readonly OutboxEvent[];

  observationByLogicalKey(logicalKey: string): ObservationRow | null;
  observationById(id: string): ObservationRow | null;
  /** Full revision chain for a logical key, version 1..n; empty when unrevised. */
  loadChain(logicalKey: string): readonly RevisionRecord[];
  /** Current If-Match version: chain length (0 == raw original, no revision yet). */
  currentVersion(logicalKey: string): number;
  headRevision(logicalKey: string): RevisionRecord | null;
  /** Governed qualifier ids from vocabulary.json (FR-041). */
  isGovernedQualifier(id: string): boolean;
  isGovernedUnit(id: string): boolean;
  isGovernedProcessingLevel(id: string): boolean;
  /** Idempotency ledger lookup: recorded fingerprint + revision id for a key. */
  lookupIdempotency(key: string): { fingerprint: string; revisionId: string; recordedAt: string } | null;
  /**
   * The single mutation path: appends revision + audit + outbox as one
   * transaction. No validation happens here (the workflow owns policy and
   * input checks); this function trusts its caller and only maintains the
   * structural invariants (append-only, atomic triple, ledger entry).
   */
  appendRevision(request: {
    logicalKey: string;
    observation: ObservationRow;
    type: RevisionType;
    value: number | null;
    unitId: string;
    excluded: boolean;
    processingLevel: RevisionRecord['processingLevel'];
    qualifierIds: readonly string[];
    reason: string;
    actorId: string;
    now: string;
    idempotencyKey: string | null;
    retainedOriginal: RetainedOriginal | null;
    action: AuditEvent['action'];
  }): { revision: RevisionRecord; auditEvent: AuditEvent; outboxEvent: OutboxEvent };
}

export function createRevisionStore(): RevisionStore {
  const observationsFile = readFixture<{ observations: RawObservation[] }>('observations.json');
  const revisionsFile = readFixture<{ revisions: RawRevision[] }>('observations.json');
  const stationsFile = readFixture<StationsFixture>('stations.json');
  const principalsFile = readFixture<Parameters<typeof buildWorld>[0]['principals']>('principals.json');
  const vocabularyFile = readFixture<{
    qualifiers: Array<{ id: string }>;
    units: Array<{ id: string }>;
    processingLevels: Array<{ id: string }>;
  }>('vocabulary.json');

  // --- immutable raw layer ------------------------------------------------
  const observations: readonly ObservationRow[] = Object.freeze(
    observationsFile.observations.map((observation) => freeze({ ...observation })),
  );
  const observationByLogicalKey = new Map(observations.map((observation) => [observation.logicalKey, observation]));
  const observationById = new Map(observations.map((observation) => [observation.id, observation]));

  // Stream -> station -> system anchors so each observation becomes a policy
  // object scoped inside its station's system (the engine then decides
  // whether Fatima's Bear-River grant, Priya's Weber-River grant, Cody's
  // grant or Diego's statewide administration covers the point).
  const asVisibility = (raw: string): PolicyObject['visibility'] =>
    raw === 'public' ? 'public' : raw === 'internal' ? 'internal' : 'restricted';
  const streamAnchor = new Map<string, { systemId: string; stationId: string; visibility: PolicyObject['visibility'] }>();
  for (const station of stationsFile.stations) {
    for (const stream of station.datastreams ?? []) {
      streamAnchor.set(stream.id, {
        systemId: station.systemId,
        stationId: stream.stationId,
        visibility: asVisibility(stream.visibility),
      });
    }
  }

  const world = buildWorld({
    principals: principalsFile,
    stations: stationsFile,
    extraObjects: observations.map((observation) => {
      const anchor = streamAnchor.get(observation.streamId);
      return freeze({
        id: observation.id,
        kind: 'observation',
        systemId: anchor?.systemId ?? null,
        ownerOrganizationId: null,
        stationId: anchor?.stationId ?? null,
        datasetId: null,
        ownerPrincipalId: null,
        targetObjectId: null,
        visibility: anchor?.visibility ?? 'restricted',
        status: 'active',
        fields: freeze({}),
      } satisfies PolicyObject);
    }),
  });

  // --- append-only revision log -------------------------------------------
  const observationsByIdForSeed = observationById;
  const seedRevisions: RevisionRecord[] = revisionsFile.revisions.map((raw, index) => {
    const observation = observationsByIdForSeed.get(raw.targetObservationId);
    if (!observation) {
      throw new Error(`fixture revision ${raw.id} targets unknown observation ${raw.targetObservationId}`);
    }
    return freeze({
      id: raw.id,
      targetObservationId: raw.targetObservationId,
      targetLogicalKey: observation.logicalKey,
      baseRevisionId: raw.baseRevisionId,
      type: raw.type as RevisionType,
      value: raw.value,
      unitId: raw.unitId,
      excluded: raw.type === 'exclusion',
      processingLevel: raw.processingLevel as RevisionRecord['processingLevel'],
      qualifierIds: Object.freeze([...raw.qualifierIds]),
      reason: raw.reason,
      actorId: raw.actorId,
      recordedAt: raw.recordedAt,
      idempotencyKey: raw.idempotencyKey ?? null,
      version: 0, // assigned below from the chain order
      retainedOriginal: null,
    });
  });

  const revisions: RevisionRecord[] = [];
  const chainIndex = new Map<string, RevisionRecord[]>();
  const appendOrdered = (record: RevisionRecord): RevisionRecord => {
    const chain = chainIndex.get(record.targetLogicalKey) ?? [];
    const versioned = freeze({ ...record, version: chain.length + 1 }) as RevisionRecord;
    chain.push(versioned);
    chainIndex.set(record.targetLogicalKey, chain);
    revisions.push(versioned);
    return versioned;
  };
  // Load the seed revisions in recorded-time order so chain versions are
  // deterministic (rev-corinne-2004 builds on rev-corinne-2001: v1 -> v2).
  for (const seed of [...seedRevisions].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a.id.localeCompare(b.id))) {
    appendOrdered(seed);
  }

  // --- audit log, outbox and idempotency ledger -----------------------------
  const auditEvents: AuditEvent[] = [];
  const outboxEvents: OutboxEvent[] = [];
  const idempotencyLedger = new Map<string, { fingerprint: string; revisionId: string; recordedAt: string }>();
  for (const revision of revisions) {
    if (revision.idempotencyKey) {
      idempotencyLedger.set(revision.idempotencyKey, {
        fingerprint: bodyFingerprint({
          type: revision.type,
          value: revision.value,
          unitId: revision.unitId,
          processingLevel: revision.processingLevel,
          qualifierIds: revision.qualifierIds,
          reason: revision.reason,
        }),
        revisionId: revision.id,
        recordedAt: revision.recordedAt,
      });
    }
  }

  const qualifierIds = new Set(vocabularyFile.qualifiers.map((qualifier) => qualifier.id));
  const unitIds = new Set(vocabularyFile.units.map((unit) => unit.id));
  const processingLevelIds = new Set(vocabularyFile.processingLevels.map((level) => level.id));

  const snapshotOf = (logicalKey: string): RevisionSnapshot => {
    const chain = chainIndex.get(logicalKey) ?? [];
    const head = chain.at(-1);
    const observation = observationByLogicalKey.get(logicalKey);
    return freeze({
      version: chain.length,
      headRevisionId: head ? head.id : null,
      value: head ? head.value : observation ? observation.value : null,
      unitId: head ? head.unitId : observation ? observation.unitId : '',
      excluded: head ? head.excluded : false,
      processingLevel: head ? head.processingLevel : 'raw',
    });
  };

  const store: RevisionStore = {
    observations,
    world,
    get revisions() {
      return Object.freeze([...revisions]);
    },
    get auditEvents() {
      return Object.freeze([...auditEvents]);
    },
    get outboxEvents() {
      return Object.freeze([...outboxEvents]);
    },
    observationByLogicalKey(logicalKey: string) {
      return observationByLogicalKey.get(logicalKey) ?? null;
    },
    observationById(id: string) {
      return observationById.get(id) ?? null;
    },
    loadChain(logicalKey: string) {
      return Object.freeze([...(chainIndex.get(logicalKey) ?? [])]);
    },
    currentVersion(logicalKey: string) {
      return (chainIndex.get(logicalKey) ?? []).length;
    },
    headRevision(logicalKey: string) {
      return (chainIndex.get(logicalKey) ?? []).at(-1) ?? null;
    },
    isGovernedQualifier(id: string) {
      return qualifierIds.has(id);
    },
    isGovernedUnit(id: string) {
      return unitIds.has(id);
    },
    isGovernedProcessingLevel(id: string) {
      return processingLevelIds.has(id);
    },
    lookupIdempotency(key: string) {
      return idempotencyLedger.get(key) ?? null;
    },
    appendRevision(request) {
      const before = snapshotOf(request.logicalKey);
      const sequence = revisions.length + 1;
      const revision = appendOrdered(
        freeze({
          id: `rev-appended-${String(1000 + sequence)}`,
          targetObservationId: request.observation.id,
          targetLogicalKey: request.logicalKey,
          baseRevisionId: before.headRevisionId,
          type: request.type,
          value: request.value,
          unitId: request.unitId,
          excluded: request.excluded,
          processingLevel: request.processingLevel,
          qualifierIds: Object.freeze([...request.qualifierIds]),
          reason: request.reason,
          actorId: request.actorId,
          recordedAt: request.now,
          idempotencyKey: request.idempotencyKey,
          version: 0, // assigned by appendOrdered
          retainedOriginal: request.retainedOriginal,
        } satisfies RevisionRecord),
      );
      const after = snapshotOf(request.logicalKey);
      const correlationId = request.idempotencyKey ?? `corr-${String(1000 + auditEvents.length + 1)}`;
      const auditEvent = freeze({
        id: `audit-${String(1000 + auditEvents.length + 1)}`,
        action: request.action,
        actorId: request.actorId,
        logicalKey: request.logicalKey,
        targetObservationId: request.observation.id,
        streamId: request.observation.streamId,
        observedAt: request.observation.observedAt,
        before,
        after,
        recordedAt: request.now,
        correlationId,
      } satisfies AuditEvent);
      const outboxEvent = freeze({
        id: `outbox-${String(1000 + outboxEvents.length + 1)}`,
        type: 'publication-refresh',
        logicalKey: request.logicalKey,
        streamId: request.observation.streamId,
        recordedAt: request.now,
        correlationId,
      } satisfies OutboxEvent);
      auditEvents.push(auditEvent);
      outboxEvents.push(outboxEvent);
      if (request.idempotencyKey) {
        idempotencyLedger.set(request.idempotencyKey, {
          fingerprint: bodyFingerprint({
            type: revision.type,
            value: revision.value,
            unitId: revision.unitId,
            processingLevel: revision.processingLevel,
            qualifierIds: revision.qualifierIds,
            reason: revision.reason,
          }),
          revisionId: revision.id,
          recordedAt: revision.recordedAt,
        });
      }
      return { revision, auditEvent, outboxEvent };
    },
  };

  return store;
}
