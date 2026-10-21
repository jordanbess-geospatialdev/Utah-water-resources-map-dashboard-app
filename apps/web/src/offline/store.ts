/**
 * The offline persistence layer for FR-027 (WD-012-R2): the scoped queue
 * the technical specification prescribes - "a scoped IndexedDB queue with
 * draft UUID, actor, site, device timestamp/zone, capture time, base
 * revision and attachment manifests" with "queued/syncing/accepted/
 * conflict/rejected states".
 *
 * DESIGN
 * - Storage is behind the OfflineStore interface so tests run WITHOUT any
 *   real IndexedDB: createMemoryOfflineStore() is the in-memory fake every
 *   suite uses; createIndexedDbOfflineStore() (bottom of this file) is the
 *   documented browser adapter skeleton - never constructed in tests.
 * - Envelopes are plain JSON documents (no Dates, no undefined, no
 *   functions) so persistence is a faithful serialization, not a
 *   re-encoding: the memory fake round-trips through JSON on every
 *   persist/load, so a field that would silently vanish in IndexedDB
 *   fails the reload-survival tests here, not in the field.
 * - Everything is account-scoped: persist/load/clearByAccount key on the
 *   signed-in account id, so cleanup.ts can clear exactly one account's
 *   cached drafts on logout/account switch without touching another's.
 * - Pure module: no clock reads, no randomness; `at` is always injected.
 */

/** Bump when the envelope shape changes; see migrateEnvelopes() below. */
export const ENVELOPE_SCHEMA_VERSION = 1;

/** What was captured offline (FR-027: reading, visit, photo, audio drafts). */
export type OfflineDraftKind = 'reading' | 'visit';

/**
 * The five synchronization states of a draft (technical specification,
 * "Offline, imports, notifications and AI").
 */
export type OfflineDraftState = 'queued' | 'syncing' | 'accepted' | 'conflict' | 'rejected';

/**
 * One entry of the attachment manifest: what was captured alongside the
 * draft (photo/audio/document/wiring-note evidence). The MANIFEST travels
 * with the envelope; the bytes stay in device storage until upload.
 */
export interface AttachmentManifestEntry {
  readonly manifestId: string;
  readonly category: 'photo' | 'audio' | 'document' | 'wiring-note';
  readonly filename: string;
  /** Capture time: when the attachment was captured on site (spec field). */
  readonly captureTime: string;
  readonly visibility: 'public' | 'internal';
  readonly sizeBytes: number;
  /**
   * Client-side transfer checksum (deterministic digest, see digestOf in
   * outbox.ts). The server computes the authoritative sha256 at attach;
   * this digest only lets the UI prove the queued bytes were not mutated
   * while offline.
   */
  readonly digest: string;
}

/**
 * Conflict routing (never auto-merged): the draft's base revision no
 * longer matches the server's current revision, so the draft is preserved
 * verbatim and a human resolves it explicitly (revise-and-requeue, or
 * discard) - see resolveConflict in outbox.ts.
 */
export interface ConflictDetail {
  readonly reason: 'BASE_REVISION_MOVED';
  readonly baseRevision: number;
  readonly currentRevision: number;
  readonly detectedAt: string;
  readonly message: string;
}

/** Typed machine codes for a terminally rejected draft (never uploaded or refused server-side). */
export type OfflineRejectionCode =
  | 'GRANT_REVOKED'
  | 'GRANT_EXPIRED'
  | 'DELEGATION_EXPIRED'
  | 'UNAUTHENTICATED'
  | 'ACTOR_MISMATCH'
  | 'OUT_OF_SCOPE'
  | 'FORBIDDEN'
  | 'VALIDATION_FAILED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_FOUND';

/** Why a draft is in the rejected state; the draft itself is RETAINED for audit visibility. */
export interface RejectionDetail {
  readonly code: OfflineRejectionCode;
  readonly message: string;
  /** Policy-engine DENY_* reason when the rejection came from revalidation. */
  readonly policyReason: string | null;
  readonly rejectedAt: string;
  /**
   * False when the client blocked the upload itself (grant already known
   * revoked/expired at reconnect: "revoked offline drafts must not upload"),
   * true when the server refused the uploaded draft at sync time.
   */
  readonly uploaded: boolean;
}

/**
 * The persistence envelope: one offline draft with its full provenance and
 * lifecycle. Generic in the payload so the reading and visit features bind
 * their form models; the JSON shape is identical for both.
 */
export interface OfflineEnvelope<P = unknown> {
  /** Draft UUID, minted once at capture; also the idempotency-key seed. */
  readonly draftId: string;
  /** Stable key reused by every attempt (WD-012 pattern): exactly-once sync. */
  readonly idempotencyKey: string;
  /** Account partition: the signed-in account this draft belongs to. */
  readonly accountId: string;
  /** The field actor who captured the draft (policy revalidates at sync). */
  readonly actorId: string;
  readonly kind: OfflineDraftKind;
  readonly siteId: string;
  /** Target stream for reading drafts; null for visits. */
  readonly streamId: string | null;
  /** When the draft was queued on the device (UTC instant). */
  readonly deviceTimestamp: string;
  /** IANA zone of the device at capture (provenance for local times). */
  readonly deviceZone: string;
  /** When the observation/visit actually happened on site (spec field). */
  readonly captureTime: string;
  /** The target revision the draft was captured against (conflict basis). */
  readonly baseRevision: number;
  readonly attachments: readonly AttachmentManifestEntry[];
  /** The captured body (reading input or visit input), preserved verbatim. */
  readonly payload: P;
  readonly state: OfflineDraftState;
  /** Send attempts so far (transport failures + quota pushes + sends). */
  readonly attempts: number;
  readonly lastError: string | null;
  readonly queuedAt: string | null;
  readonly syncingSince: string | null;
  readonly acceptedRecordId: string | null;
  readonly acceptedAt: string | null;
  /** True when the server replayed its recorded result instead of committing anew. */
  readonly replayed: boolean;
  /** Conflict detail when state is 'conflict' (never auto-resolved). */
  readonly conflict: ConflictDetail | null;
  /** Rejection detail when state is 'rejected'; the draft is retained. */
  readonly rejection: RejectionDetail | null;
  /** Explicit conflict resolutions so far (revise-and-requeue count). */
  readonly revisions: number;
  /** Timestamp of the last state transition (UTC instant). */
  readonly lastTransitionAt: string;
}

// ---------------------------------------------------------------------------
// The storage interface
// ---------------------------------------------------------------------------

/**
 * Account-scoped persistence for offline envelopes. The methods are
 * synchronous by design: the IndexedDB adapter hydrates its partition into
 * memory at open() and then writes through synchronously (see the adapter
 * skeleton), so the outbox engine stays deterministic and testable.
 */
export interface OfflineStore {
  /** Replace the account's persisted queue (whole-partition write). */
  persist(accountId: string, envelopes: readonly OfflineEnvelope[]): void;
  /** Load the account's queue; [] when the account has nothing persisted. */
  load(accountId: string): readonly OfflineEnvelope[];
  /** Clear exactly one account's cached drafts (logout / account switch). */
  clearByAccount(accountId: string): void;
  /** Persisted account ids, sorted (observable for cleanup verification). */
  readonly accounts: readonly string[];
}

/** Deep JSON clone: the same fidelity boundary a real serialization imposes. */
export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * True when the value survives a persistence round-trip unchanged: every
 * leaf must be JSON-native. A Date would come back as a string, undefined
 * keys would vanish and functions would be dropped - all silent mutations
 * this check exists to catch.
 */
export function isPersistenceSafe(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return true;
    case 'undefined':
    case 'function':
    case 'bigint':
    case 'symbol':
      return false;
    case 'object':
      if (value instanceof Date) return false;
      if (Array.isArray(value)) return value.every((entry) => isPersistenceSafe(entry));
      return Object.values(value).every((entry) => isPersistenceSafe(entry));
    default:
      return false;
  }
}

/**
 * In-memory OfflineStore fake for tests (and the SSR/dev preview): each
 * persist() and load() round-trips through JSON so the suite exercises the
 * exact serialization boundary IndexedDB would impose - a field that
 * cannot survive persistence fails here, loudly.
 */
export function createMemoryOfflineStore(): OfflineStore {
  const partitions = new Map<string, string>(); // accountId -> serialized queue
  const store: OfflineStore = {
    persist(accountId, envelopes) {
      partitions.set(accountId, JSON.stringify(envelopes));
    },
    load(accountId) {
      const raw = partitions.get(accountId);
      if (raw === undefined) return [];
      return JSON.parse(raw) as OfflineEnvelope[];
    },
    clearByAccount(accountId) {
      partitions.delete(accountId);
    },
    get accounts() {
      return Object.freeze([...partitions.keys()].sort());
    },
  };
  return store;
}

/**
 * Schema guard for data loaded from an older/newer schema version:
 * entries are partitioned, never dropped silently - a queue the code
 * cannot interpret is surfaced to the caller for an explicit decision.
 */
export function migrateEnvelopes(
  loaded: readonly OfflineEnvelope[],
  fromVersion: number,
): { readonly envelopes: readonly OfflineEnvelope[]; readonly quarantined: readonly OfflineEnvelope[] } {
  if (fromVersion === ENVELOPE_SCHEMA_VERSION) return { envelopes: loaded, quarantined: [] };
  return { envelopes: [], quarantined: [...loaded] };
}

// ---------------------------------------------------------------------------
// IndexedDB adapter skeleton (browser only; NEVER executed in tests)
// ---------------------------------------------------------------------------

/**
 * Documented browser adapter for the scoped queue. NOT executed by any
 * test (the technical specification's queue is IndexedDB, but node:test
 * has no IndexedDB; the memory fake above is the tested implementation).
 *
 * Shape of the adapter once the shell wires it:
 *
 *   export async function openIndexedDbOfflineStore(dbName: string): Promise<OfflineStore> {
 *     const db = await new Promise<IDBDatabase>((resolve, reject) => {
 *       const request = indexedDB.open(dbName, ENVELOPE_SCHEMA_VERSION);
 *       request.onupgradeneeded = () => {
 *         const database = request.result;
 *         // One object store per account partition: 'outbox:<accountId>'.
 *         // keyPath 'draftId'; index on 'state' for the sync orchestrator.
 *         if (!database.objectStoreNames.contains('partitions')) {
 *           database.createObjectStore('partitions', { keyPath: 'accountId' });
 *         }
 *       };
 *       request.onsuccess = () => resolve(request.result);
 *       request.onerror = () => reject(request.error);
 *     });
 *     // Hydrate every partition into memory, then serve the synchronous
 *     // OfflineStore interface from the mirror and write through on
 *     // persist()/clearByAccount() inside one IDB transaction each. The
 *     // write is the whole partition (small queues; crash-atomic swap),
 *     // which keeps 'crash between persist calls' from splitting a queue.
 *     ...
 *   }
 *
 * Why a write-through mirror instead of async methods: the outbox engine
 * (outbox.ts) is a pure, deterministic state machine over envelope arrays;
 * the adapter is the only asynchronous edge and it lives entirely inside
 * open(). Private drafts (photo/audio manifests, visit notes) are stored
 * under the account partition key only, so clearByAccount(accountId) is a
 * single object-store delete - the property cleanup.ts relies on for
 * "sensitive data cleared per policy on logout/account switch".
 */
export const INDEXEDDB_ADAPTER_NOTES =
  'Browser adapter is a write-through mirror hydrated at open(); tests use createMemoryOfflineStore(). See the skeleton above.';
