/**
 * Fixture-backed readings store (WD-010): the append-only world manual
 * entry (FR-020) and staged bulk import (FR-021) operate on.
 *
 * Invariants (mirroring WD-011 revisions/store.ts):
 * - Fixture observation rows are IMMUTABLE: loaded once, frozen, and no
 *   store operation writes to them. Entry appends new rows only.
 * - The observation log is append-only; rows are never removed or edited
 *   (corrections belong to WD-011's revision chains, not this store).
 * - Every append lands as one logical transaction: reading row(s) + audit
 *   event + transactional-outbox publication-refresh event (ADR-10).
 * - The idempotency ledger maps key -> body fingerprint -> appended record;
 *   same-body replays return the recorded result, different bodies 409.
 * - No clock reads, no randomness: identifiers derive from the append
 *   sequence, so identical inputs produce byte-identical logs.
 *
 * The policy world is replaceable via replaceWorldSnapshot(): the spec
 * target "Internal revoked access: next protected request denied using
 * authoritative assignment version/revocation state" means commit-time
 * re-verification must see the CURRENT assignment state, not the snapshot
 * captured at validation time.
 */
import { readFileSync } from 'node:fs';
import {
  assignmentVersionOf,
  buildWorld,
  type PolicyWorld,
  type StationsFixture,
} from '../../../../../packages/policy/src/index.ts';
import type {
  EntryAuditAction,
  EntryAuditEvent,
  EntryOutboxEvent,
  ImportBatchRecord,
  ImportMode,
  ReadingRow,
  StationAnchor,
  StreamDefinition,
} from './types.ts';

const FIXTURE_DIR = '../../../../../fixtures/contracts/';

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(FIXTURE_DIR + name, import.meta.url), 'utf8')) as T;
}

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}

/** Fixture datastream shape (fields this store reads). */
interface FixtureDatastream {
  id: string;
  stationId: string;
  observedPropertyId: string;
  unitId: string;
  methodTypeId: string;
  cadenceMinutes: number;
  validRangeMin: number | null;
  validRangeMax: number | null;
  visibility: string;
  timeZone: string;
}

interface FixtureStation {
  id: string;
  displayName: string;
  systemId: string;
  status: string;
  version: number;
  datastreams?: FixtureDatastream[];
}

/** Governed vocabulary subset the entry validations consult. */
export interface VocabularyIndex {
  readonly units: ReadonlyArray<{ id: string; dimension: string }>;
  readonly properties: ReadonlyArray<{ id: string; dimension: string; canonicalUnitId: string }>;
  readonly qualifiers: readonly string[];
  readonly processingLevels: readonly string[];
}

export interface ReadingsStore {
  readonly world: PolicyWorld;
  readonly observations: readonly ReadingRow[];
  readonly auditEvents: readonly EntryAuditEvent[];
  readonly outboxEvents: readonly EntryOutboxEvent[];
  readonly batches: readonly ImportBatchRecord[];

  streamById(streamId: string): StreamDefinition | null;
  stationById(stationId: string): StationAnchor | null;
  vocabulary(): VocabularyIndex;
  observationByLogicalKey(logicalKey: string): ReadingRow | null;
  /** Governed unit + its dimension ('' when unknown). */
  unitDimension(unitId: string): string | null;
  propertyDimension(propertyId: string): string | null;

  /** Current optimistic setup version of a stream (bumped by applyStreamSetupChange). */
  streamSetupVersion(streamId: string): number;
  /**
   * Models the sites workflow (WD-010 siteSetup) changing a measurement
   * setup: bumps the stream's setupVersion so an in-flight import batch is
   * re-verified at commit. Returns the new version.
   */
  applyStreamSetupChange(streamId: string): number;

  /**
   * Replace the authoritative policy snapshot (revocation, expiry, grant
   * version bump). The next protected call re-evaluates against this world.
   */
  replaceWorldSnapshot(world: PolicyWorld): void;
  actorVersion(actorId: string): number;

  /** Idempotency ledger: recorded fingerprint + record id for a key. */
  lookupManualIdempotency(key: string): { fingerprint: string; recordId: string; recordedAt: string } | null;

  /**
   * The single append path for entered readings. No validation here (the
   * workflows own policy and input checks); maintains the structural
   * invariants only (append-only, frozen rows, audit + outbox, ledger).
   */
  appendReadings(request: {
    actorId: string;
    now: string;
    idempotencyKey: string | null;
    /** Body fingerprint recorded in the ledger (manual entry; null for imports). */
    idempotencyFingerprint: string | null;
    rows: ReadonlyArray<{
      streamId: string;
      observedAt: string;
      sourceOffset: string;
      value: number;
      unitId: string;
      methodTypeId: string;
      note: string | null;
    }>;
    importBatchId: string | null;
    action: EntryAuditAction;
    correlationId: string;
    summary: { inserted: number; duplicates: number; skipped: number } | null;
  }): { rows: ReadingRow[]; auditEvent: EntryAuditEvent; outboxEvent: EntryOutboxEvent };

  /** Staged-batch registry mutations (bulkImport owns all validation). */
  recordBatch(batch: ImportBatchRecord): void;
  batchById(batchId: string): ImportBatchRecord | null;
}

/** Canonical fingerprint of a manual-entry body for idempotency comparison. */
export function manualFingerprint(input: {
  streamId: string;
  observedAt: string;
  value: number;
  unitId: string;
  methodTypeId: string | null;
  note: string | null;
}): string {
  return JSON.stringify({
    streamId: input.streamId,
    observedAt: input.observedAt.trim(),
    value: input.value,
    unitId: input.unitId,
    methodTypeId: input.methodTypeId,
    note: input.note,
  });
}

export function createReadingsStore(): ReadingsStore {
  const observationsFile = readFixture<{ observations: Array<Record<string, unknown>> }>('observations.json');
  const stationsFile = readFixture<{ stations: FixtureStation[] }>('stations.json');
  const principalsFile = readFixture<Parameters<typeof buildWorld>[0]['principals']>('principals.json');
  const vocabularyFile = readFixture<{
    units: Array<{ id: string; dimension: string }>;
    observedProperties: Array<{ id: string; dimension: string; canonicalUnitId: string }>;
    qualifiers: Array<{ id: string }>;
    processingLevels: Array<{ id: string }>;
  }>('vocabulary.json');

  // --- stream + station registries ----------------------------------------
  const streamIndex = new Map<string, StreamDefinition>();
  const stationIndex = new Map<string, StationAnchor>();
  const streamSetupVersions = new Map<string, number>();
  for (const station of stationsFile.stations) {
    const streamIds: string[] = [];
    for (const stream of station.datastreams ?? []) {
      streamIds.push(stream.id);
      streamIndex.set(
        stream.id,
        freeze({
          id: stream.id,
          stationId: stream.stationId,
          systemId: station.systemId,
          observedPropertyId: stream.observedPropertyId,
          unitId: stream.unitId,
          methodTypeId: stream.methodTypeId,
          cadenceMinutes: stream.cadenceMinutes,
          validRangeMin: stream.validRangeMin ?? null,
          validRangeMax: stream.validRangeMax ?? null,
          visibility: stream.visibility === 'public' ? 'public' : stream.visibility === 'internal' ? 'internal' : 'restricted',
          timeZone: stream.timeZone,
          // The station's fixture version seeds the stream setup version;
          // applyStreamSetupChange() bumps it from there.
          setupVersion: station.version,
        } satisfies StreamDefinition),
      );
      streamSetupVersions.set(stream.id, station.version);
    }
    stationIndex.set(
      station.id,
      freeze({
        id: station.id,
        displayName: station.displayName,
        systemId: station.systemId,
        status: station.status,
        streamIds: freeze([...streamIds]),
      } satisfies StationAnchor),
    );
  }

  let world: PolicyWorld = buildWorld({ principals: principalsFile, stations: stationsFile as unknown as StationsFixture });

  const vocabulary: VocabularyIndex = freeze({
    units: freeze([...vocabularyFile.units]),
    properties: freeze([...vocabularyFile.observedProperties]),
    qualifiers: freeze(vocabularyFile.qualifiers.map((q) => q.id)),
    processingLevels: freeze(vocabularyFile.processingLevels.map((l) => l.id)),
  });
  const unitDimension = new Map(vocabularyFile.units.map((unit) => [unit.id, unit.dimension]));
  const propertyDimension = new Map(vocabularyFile.observedProperties.map((property) => [property.id, property.dimension]));

  // --- immutable fixture observations --------------------------------------
  const observations: ReadingRow[] = observationsFile.observations.map((raw) =>
    freeze({
      id: String(raw.id),
      logicalKey: String(raw.logicalKey),
      streamId: String(raw.streamId),
      observedAt: String(raw.observedAt),
      sourceOffset: String(raw.sourceOffset ?? 'Z'),
      value: raw.value === null ? 0 : Number(raw.value),
      unitId: String(raw.unitId),
      valueType: (raw.valueType as 'observed' | 'estimated') ?? 'observed',
      processingLevel: 'raw' as const,
      sourceEventId: String(raw.sourceEventId ?? ''),
      receivedAt: String(raw.receivedAt ?? ''),
      sourceId: String(raw.sourceId ?? 'fixture'),
      methodTypeId: methodOfStream(String(raw.streamId)),
      origin: 'fixture' as const,
      importBatchId: null,
      note: raw.note === undefined ? null : String(raw.note),
    }),
  );
  function methodOfStream(streamId: string): string {
    return streamIndex.get(streamId)?.methodTypeId ?? '';
  }
  const observationByKey = new Map(observations.map((row) => [row.logicalKey, row]));

  const auditEvents: EntryAuditEvent[] = [];
  const outboxEvents: EntryOutboxEvent[] = [];
  const manualLedger = new Map<string, { fingerprint: string; recordId: string; recordedAt: string }>();
  const batches = new Map<string, ImportBatchRecord>();

  const store: ReadingsStore = {
    get world() {
      return world;
    },
    get observations() {
      return Object.freeze([...observations]);
    },
    get auditEvents() {
      return Object.freeze([...auditEvents]);
    },
    get outboxEvents() {
      return Object.freeze([...outboxEvents]);
    },
    get batches() {
      return Object.freeze([...batches.values()]);
    },
    streamById(streamId) {
      return streamIndex.get(streamId) ?? null;
    },
    stationById(stationId) {
      return stationIndex.get(stationId) ?? null;
    },
    vocabulary() {
      return vocabulary;
    },
    observationByLogicalKey(logicalKey) {
      return observationByKey.get(logicalKey) ?? null;
    },
    unitDimension(unitId) {
      return unitDimension.get(unitId) ?? null;
    },
    propertyDimension(propertyId) {
      return propertyDimension.get(propertyId) ?? null;
    },
    streamSetupVersion(streamId) {
      return streamSetupVersions.get(streamId) ?? 0;
    },
    applyStreamSetupChange(streamId) {
      const current = streamSetupVersions.get(streamId);
      if (current === undefined) throw new Error(`applyStreamSetupChange: unknown stream "${streamId}"`);
      const next = current + 1;
      streamSetupVersions.set(streamId, next);
      return next;
    },
    replaceWorldSnapshot(nextWorld) {
      world = nextWorld;
    },
    actorVersion(actorId) {
      return assignmentVersionOf(world, actorId);
    },
    lookupManualIdempotency(key) {
      return manualLedger.get(key) ?? null;
    },
    appendReadings(request) {
      const streamIds = [...new Set(request.rows.map((row) => row.streamId))];
      const appended: ReadingRow[] = [];
      const rows = request.rows.map((row, index) => {
        const sequence = observations.length + 1;
        const id =
          request.importBatchId !== null
            ? `obs-imp-${request.importBatchId}-${String(sequence)}r${String(index + 1)}`
            : `obs-entry-${String(1000 + sequence)}`;
        const record = freeze({
          id,
          logicalKey: `${row.streamId}:${row.observedAt}`,
          streamId: row.streamId,
          observedAt: row.observedAt,
          sourceOffset: row.sourceOffset,
          value: row.value,
          unitId: row.unitId,
          valueType: 'observed' as const,
          processingLevel: 'raw' as const,
          sourceEventId: `manual-${id}`,
          receivedAt: request.now,
          sourceId: request.actorId,
          methodTypeId: row.methodTypeId,
          origin: request.importBatchId !== null ? ('import-batch' as const) : ('manual-entry' as const),
          importBatchId: request.importBatchId,
          note: row.note,
        } satisfies ReadingRow);
        appended.push(record);
        observations.push(record);
        observationByKey.set(record.logicalKey, record);
        return record;
      });
      const auditEvent = freeze({
        id: `entry-audit-${String(1000 + auditEvents.length + 1)}`,
        action: request.action,
        actorId: request.actorId,
        streamIds: freeze(streamIds),
        targetId: request.importBatchId ?? rows[0]?.logicalKey ?? '',
        recordedAt: request.now,
        correlationId: request.correlationId,
        summary: request.summary,
      } satisfies EntryAuditEvent);
      const outboxEvent = freeze({
        id: `entry-outbox-${String(1000 + outboxEvents.length + 1)}`,
        type: 'publication-refresh' as const,
        streamIds: freeze(streamIds),
        recordedAt: request.now,
        correlationId: request.correlationId,
      } satisfies EntryOutboxEvent);
      auditEvents.push(auditEvent);
      outboxEvents.push(outboxEvent);
      const first = rows[0];
      if (request.idempotencyKey && first) {
        manualLedger.set(request.idempotencyKey, {
          fingerprint: request.idempotencyFingerprint ?? first.logicalKey,
          recordId: first.id,
          recordedAt: request.now,
        });
      }
      return { rows: appended, auditEvent, outboxEvent };
    },
    recordBatch(batch) {
      batches.set(batch.id, batch);
    },
    batchById(batchId) {
      return batches.get(batchId) ?? null;
    },
  };

  return store;
}

/** Default import mode when a batch does not declare one (documented atomic-first default). */
export const DEFAULT_IMPORT_MODE: ImportMode = 'atomic';
