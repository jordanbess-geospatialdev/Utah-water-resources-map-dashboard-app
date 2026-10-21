/**
 * The offline outbox engine (FR-027, WD-012-R2): enqueue validated drafts,
 * survive reloads through the OfflineStore, and synchronize exactly once
 * after reconnection.
 *
 * ACCEPTANCE mapped to machinery (all exercised in outbox.test.ts):
 * - reload survival: every transition persists; a fresh load() replays the
 *   identical queue (the memory store round-trips JSON, so serialization
 *   fidelity is proven, not assumed);
 * - exactly once: the idempotency key is minted ONCE at enqueue and reused
 *   by every attempt (the WD-012 `visit-draft-<id>` pattern), so a
 *   double-send or a re-send after "server committed, ack lost" replays
 *   the server's recorded result instead of appending a duplicate;
 * - commit-before-ack crash: a draft left in 'syncing' by a crashed run is
 *   re-queued ON RELOAD with the SAME key; the re-send either commits (no
 *   earlier commit existed) or replays (it did) - either way, one record;
 * - conflict: when the server reports the base revision moved, the draft
 *   is preserved VERBATIM and routed for explicit resolution; the engine
 *   never merges, overwrites, or discards it (resolveConflict is the only
 *   way out, and it is explicit);
 * - revoked/expired grants: a draft whose grant is revoked or expired at
 *   reconnect NEVER UPLOADS (the transport is not called); it moves to
 *   'rejected' with a typed code and is retained for audit visibility;
 * - quota: exceeded queue limits refuse NEW drafts with visible retry
 *   guidance (nothing queued is dropped), and a server-side quota verdict
 *   returns the draft to 'queued' with its retryAfter, never to 'rejected'.
 *
 * Pure module: no clock reads (every `at` is injected), no randomness, no
 * DOM, no IndexedDB - storage is the injected OfflineStore port.
 */
import {
  type AttachmentManifestEntry,
  type ConflictDetail,
  type OfflineDraftKind,
  type OfflineEnvelope,
  type OfflineRejectionCode,
  type OfflineStore,
  type RejectionDetail,
} from './store';

// ---------------------------------------------------------------------------
// Verdicts (mirror of services/api/src/workflows/sync - see README.md)
// ---------------------------------------------------------------------------

/** Machine codes shared with the server sync domain (typed rejections). */
export type SyncRejectionCode = OfflineRejectionCode;

/** The server's per-draft verdict at sync time. */
export type SyncVerdict =
  | { readonly kind: 'accepted'; readonly recordId: string; readonly replayed: boolean }
  | {
      readonly kind: 'conflict';
      readonly reason: 'BASE_REVISION_MOVED';
      readonly baseRevision: number;
      readonly currentRevision: number;
    }
  | { readonly kind: 'rejected'; readonly code: SyncRejectionCode; readonly message: string; readonly policyReason: string | null }
  | { readonly kind: 'quota'; readonly message: string; readonly retryAfter: string };

/** The transport port: one draft in, one verdict out; a THROW is a transport error (retryable). */
export type SyncTransport = (envelope: OfflineEnvelope) => SyncVerdict | Promise<SyncVerdict>;

/** What the device knows about the account's grant AFTER reconnect, before any upload. */
export interface GrantStatus {
  readonly status: 'valid' | 'revoked' | 'expired';
  /** Engine/authority message shown with a rejected draft. */
  readonly message: string | null;
  /** Engine DENY_* reason mirrored from the session revalidation. */
  readonly policyReason: string | null;
}

/** One synchronization run: injected clock, transport, and grant knowledge. */
export interface SyncSession {
  /** UTC instant of the reconnect (injected; never Date.now()). */
  readonly now: string;
  readonly transport: SyncTransport;
  /** Grant state at reconnect; omitted means 'valid' (nothing to block). */
  readonly grant?: GrantStatus;
}

// ---------------------------------------------------------------------------
// Queue limits (client-side quota with visible retry guidance)
// ---------------------------------------------------------------------------

export const MAX_QUEUED_DRAFTS_PER_ACCOUNT = 25;
export const MAX_QUEUED_ATTACHMENT_BYTES = 200 * 1024 * 1024;

export interface QueueLimits {
  readonly maxDrafts: number;
  readonly maxAttachmentBytes: number;
}

export const DEFAULT_QUEUE_LIMITS: QueueLimits = {
  maxDrafts: MAX_QUEUED_DRAFTS_PER_ACCOUNT,
  maxAttachmentBytes: MAX_QUEUED_ATTACHMENT_BYTES,
};

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/** Input for queueing one captured draft. */
export interface EnqueueInput<P> {
  readonly draftId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly kind: OfflineDraftKind;
  readonly siteId: string;
  readonly streamId: string | null;
  /** UTC instant the device queued the draft. */
  readonly deviceTimestamp: string;
  readonly deviceZone: string;
  readonly captureTime: string;
  readonly baseRevision: number;
  readonly attachments: ReadonlyArray<Omit<AttachmentManifestEntry, 'digest'>>;
  readonly payload: P;
}

export interface EnqueueFieldError {
  readonly fieldPath: string;
  readonly code: string;
  readonly message: string;
}

export type EnqueueResult<P> =
  | { readonly kind: 'queued'; readonly envelope: OfflineEnvelope<P>; readonly queue: readonly OfflineEnvelope<P>[] }
  | { readonly kind: 'invalid'; readonly fieldErrors: readonly EnqueueFieldError[]; readonly queue: readonly OfflineEnvelope<P>[] }
  | { readonly kind: 'quota-exceeded'; readonly message: string; readonly retryGuidance: string; readonly queue: readonly OfflineEnvelope<P>[] };

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isIsoInstant(value: string): boolean {
  return ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

function err(fieldPath: string, code: string, message: string): EnqueueFieldError {
  return { fieldPath, code, message };
}

/**
 * Deterministic 32-bit FNV-1a digest of a manifest entry (hex). This is a
 * TRANSFER CHECKSUM for the queued bytes, not a security hash: the server
 * computes the authoritative sha256 at attach (visits/attachments.ts).
 */
export function digestOf(entry: Omit<AttachmentManifestEntry, 'digest'>): string {
  const text = `${entry.category}|${entry.filename}|${entry.captureTime}|${entry.visibility}|${entry.sizeBytes}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Queue one draft. Validation covers the envelope's own integrity AND the
 * base revision against what the device has actually seen
 * (`currentBaseRevision`): a draft may be captured against an OLDER
 * revision than the device now holds (that is exactly the offline case the
 * server resolves as a conflict), but never against a revision the device
 * has never seen.
 */
export function enqueueDraft<P>(
  queue: readonly OfflineEnvelope<P>[],
  input: EnqueueInput<P>,
  options: {
    readonly currentBaseRevision: number;
    readonly limits?: QueueLimits;
    readonly now?: string;
  },
): EnqueueResult<P> {
  const limits = options.limits ?? DEFAULT_QUEUE_LIMITS;
  const at = options.now ?? input.deviceTimestamp;
  const errors: EnqueueFieldError[] = [];

  if (typeof input.draftId !== 'string' || input.draftId.trim() === '') {
    errors.push(err('draftId', 'DRAFT_ID_REQUIRED', 'a draft UUID is required'));
  } else if (queue.some((draft) => draft.draftId === input.draftId)) {
    errors.push(err('draftId', 'DRAFT_ID_DUPLICATE', `draft "${input.draftId}" is already queued`));
  }
  if (typeof input.accountId !== 'string' || input.accountId.trim() === '') {
    errors.push(err('accountId', 'ACCOUNT_REQUIRED', 'the account partition is required'));
  }
  if (typeof input.actorId !== 'string' || input.actorId.trim() === '') {
    errors.push(err('actorId', 'ACTOR_REQUIRED', 'the capturing actor is required'));
  }
  if (input.kind !== 'reading' && input.kind !== 'visit') {
    errors.push(err('kind', 'KIND_UNKNOWN', 'kind must be "reading" or "visit"'));
  }
  if (typeof input.siteId !== 'string' || input.siteId.trim() === '') {
    errors.push(err('siteId', 'SITE_REQUIRED', 'the site is required'));
  }
  if (input.kind === 'reading' && (typeof input.streamId !== 'string' || input.streamId.trim() === '')) {
    errors.push(err('streamId', 'STREAM_REQUIRED', 'a reading draft requires its target stream'));
  }
  if (typeof input.deviceTimestamp !== 'string' || !isIsoInstant(input.deviceTimestamp)) {
    errors.push(err('deviceTimestamp', 'DEVICE_TIME_INVALID', 'deviceTimestamp must be an ISO 8601 instant with an explicit offset'));
  }
  if (typeof input.deviceZone !== 'string' || input.deviceZone.trim() === '') {
    errors.push(err('deviceZone', 'DEVICE_ZONE_REQUIRED', 'the device IANA time zone is required provenance'));
  }
  if (typeof input.captureTime !== 'string' || !isIsoInstant(input.captureTime)) {
    errors.push(err('captureTime', 'CAPTURE_TIME_INVALID', 'captureTime must be an ISO 8601 instant with an explicit offset'));
  } else if (isIsoInstant(input.deviceTimestamp) && Date.parse(input.captureTime) > Date.parse(input.deviceTimestamp)) {
    errors.push(err('captureTime', 'CAPTURE_TIME_AFTER_QUEUE', 'captureTime cannot be after the device timestamp that queues it'));
  }
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 1) {
    errors.push(err('baseRevision', 'BASE_REVISION_INVALID', 'baseRevision must be a positive integer (the revision the draft was captured against)'));
  } else if (input.baseRevision > options.currentBaseRevision) {
    errors.push(
      err(
        'baseRevision',
        'BASE_REVISION_AHEAD_OF_DEVICE',
        `the draft's base revision ${input.baseRevision} is ahead of the device's current revision ${options.currentBaseRevision}; refresh the site before queueing`,
      ),
    );
  }
  if (!Array.isArray(input.attachments)) {
    errors.push(err('attachments', 'MANIFEST_INVALID', 'attachments must be an array (possibly empty)'));
  } else {
    for (const [index, attachment] of input.attachments.entries()) {
      const at2 = `attachments[${index}]`;
      if (attachment.category !== 'photo' && attachment.category !== 'audio' && attachment.category !== 'document' && attachment.category !== 'wiring-note') {
        errors.push(err(`${at2}.category`, 'CATEGORY_UNKNOWN', `category "${String(attachment.category)}" must be photo, audio, document or wiring-note`));
      }
      if (attachment.category === 'wiring-note' && attachment.visibility === 'public') {
        errors.push(err(`${at2}.visibility`, 'WIRING_NOTE_MUST_BE_INTERNAL', 'a wiring note can never be marked public (FR-049)'));
      }
      if (typeof attachment.filename !== 'string' || attachment.filename.trim() === '') {
        errors.push(err(`${at2}.filename`, 'FILENAME_REQUIRED', 'a filename is required'));
      }
      if (typeof attachment.captureTime !== 'string' || !isIsoInstant(attachment.captureTime)) {
        errors.push(err(`${at2}.captureTime`, 'CAPTURE_TIME_INVALID', 'the attachment captureTime must be an ISO 8601 instant'));
      }
      if (typeof attachment.sizeBytes !== 'number' || !Number.isInteger(attachment.sizeBytes) || attachment.sizeBytes < 0) {
        errors.push(err(`${at2}.sizeBytes`, 'SIZE_INVALID', 'sizeBytes must be a non-negative integer'));
      }
    }
  }
  if (errors.length > 0) {
    return { kind: 'invalid', fieldErrors: errors, queue };
  }

  // --- client-side quota: refuse NEW drafts, never touch queued ones ------
  const pendingBytes = queue.reduce(
    (total, draft) => total + draft.attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0),
    input.attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0),
  );
  if (queue.length + 1 > limits.maxDrafts) {
    return {
      kind: 'quota-exceeded',
      message: `the offline queue is full (${queue.length}/${limits.maxDrafts} drafts)`,
      retryGuidance: `reconnect and synchronize the ${queue.length} pending drafts to free queue space, then capture again - nothing already queued was dropped`,
      queue,
    };
  }
  if (pendingBytes > limits.maxAttachmentBytes) {
    const mb = Math.round(pendingBytes / (1024 * 1024));
    return {
      kind: 'quota-exceeded',
      message: `queued attachment bytes (${mb} MB) exceed the offline budget (${Math.round(limits.maxAttachmentBytes / (1024 * 1024))} MB)`,
      retryGuidance: `synchronize the pending drafts while online to upload the ${mb} MB of evidence, then capture again - nothing already queued was dropped`,
      queue,
    };
  }

  const envelope: OfflineEnvelope<P> = Object.freeze({
    draftId: input.draftId,
    idempotencyKey: `offline-${input.kind}-${input.draftId}`,
    accountId: input.accountId,
    actorId: input.actorId,
    kind: input.kind,
    siteId: input.siteId,
    streamId: input.kind === 'reading' ? input.streamId : null,
    deviceTimestamp: input.deviceTimestamp,
    deviceZone: input.deviceZone,
    captureTime: input.captureTime,
    baseRevision: input.baseRevision,
    attachments: Object.freeze(input.attachments.map((attachment) => Object.freeze({ ...attachment, digest: digestOf(attachment) }))),
    payload: input.payload,
    state: 'queued',
    attempts: 0,
    lastError: null,
    queuedAt: at,
    syncingSince: null,
    acceptedRecordId: null,
    acceptedAt: null,
    replayed: false,
    conflict: null,
    rejection: null,
    revisions: 0,
    lastTransitionAt: at,
  });
  return { kind: 'queued', envelope, queue: [...queue, envelope] };
}

// ---------------------------------------------------------------------------
// State transitions (reducer style, mirror of the WD-012 draft machine)
// ---------------------------------------------------------------------------

export type OutboxEvent =
  | { readonly type: 'sync-start'; readonly at: string }
  | { readonly type: 'sync-accepted'; readonly recordId: string; readonly replayed: boolean; readonly at: string }
  | {
      readonly type: 'sync-conflict';
      readonly currentRevision: number;
      readonly at: string;
    }
  | { readonly type: 'sync-rejected'; readonly detail: RejectionDetail }
  | { readonly type: 'sync-quota'; readonly message: string; readonly retryAfter: string; readonly at: string }
  | { readonly type: 'sync-transport-failed'; readonly message: string; readonly at: string }
  /** Reload recovery: a run crashed mid-flight; requeue with the SAME key. */
  | { readonly type: 'requeue-interrupted'; readonly message: string; readonly at: string }
  /** Explicit conflict resolution: revised payload against the current revision. */
  | { readonly type: 'conflict-revised'; readonly payload: unknown; readonly baseRevision: number; readonly at: string };

export function outboxTransition<P>(envelope: OfflineEnvelope<P>, event: OutboxEvent): OfflineEnvelope<P> {
  switch (event.type) {
    case 'sync-start': {
      if (envelope.state !== 'queued') return envelope;
      return Object.freeze({
        ...envelope,
        state: 'syncing',
        syncingSince: event.at,
        attempts: envelope.attempts + 1,
        lastTransitionAt: event.at,
      });
    }
    case 'sync-accepted': {
      if (envelope.state !== 'syncing') return envelope;
      return Object.freeze({
        ...envelope,
        state: 'accepted',
        acceptedRecordId: event.recordId,
        acceptedAt: event.at,
        replayed: event.replayed,
        lastError: null,
        syncingSince: null,
        conflict: null,
        rejection: null,
        lastTransitionAt: event.at,
      });
    }
    case 'sync-conflict': {
      if (envelope.state !== 'syncing') return envelope;
      const conflict: ConflictDetail = Object.freeze({
        reason: 'BASE_REVISION_MOVED',
        baseRevision: envelope.baseRevision,
        currentRevision: event.currentRevision,
        detectedAt: event.at,
        message: `captured against revision ${envelope.baseRevision}; the server is at revision ${event.currentRevision} - resolve explicitly (revise on the current revision, or discard); nothing was merged or overwritten`,
      });
      // The payload is carried over UNCHANGED: preserved verbatim, never
      // auto-merged, never silently overwritten.
      return Object.freeze({ ...envelope, state: 'conflict', conflict, syncingSince: null, lastTransitionAt: event.at });
    }
    case 'sync-rejected': {
      // Accepted from 'syncing' (the server refused the upload) AND from
      // 'queued' (the client-side grant gate blocks the upload before any
      // transport call - revoked offline drafts must not upload).
      if (envelope.state !== 'syncing' && envelope.state !== 'queued') return envelope;
      return Object.freeze({
        ...envelope,
        state: 'rejected',
        rejection: Object.freeze(event.detail),
        syncingSince: null,
        lastTransitionAt: event.detail.rejectedAt,
      });
    }
    case 'sync-quota': {
      // Quota is NOT a rejection: the draft stays queued and retryable.
      if (envelope.state !== 'syncing') return envelope;
      return Object.freeze({
        ...envelope,
        state: 'queued',
        lastError: `${event.message} (retry after ${event.retryAfter}; explicit retry needs no background sync)`,
        syncingSince: null,
        lastTransitionAt: event.at,
      });
    }
    case 'sync-transport-failed': {
      if (envelope.state !== 'syncing') return envelope;
      return Object.freeze({
        ...envelope,
        state: 'queued',
        lastError: event.message,
        syncingSince: null,
        lastTransitionAt: event.at,
      });
    }
    case 'requeue-interrupted': {
      if (envelope.state !== 'syncing') return envelope;
      return Object.freeze({
        ...envelope,
        state: 'queued',
        lastError: event.message,
        syncingSince: null,
        lastTransitionAt: event.at,
      });
    }
    case 'conflict-revised': {
      if (envelope.state !== 'conflict') return envelope;
      return Object.freeze({
        ...envelope,
        state: 'queued',
        // The explicitly revised payload the user approved; the only code
        // path that ever replaces a conflicted draft's body.
        payload: event.payload as P,
        baseRevision: event.baseRevision,
        conflict: null,
        revisions: envelope.revisions + 1,
        attempts: 0,
        lastError: null,
        queuedAt: event.at,
        lastTransitionAt: event.at,
      });
    }
    default:
      return envelope;
  }
}

// ---------------------------------------------------------------------------
// The reconnect orchestrator
// ---------------------------------------------------------------------------

export interface SyncOutcome {
  /** The full queue after the run, in queue order. */
  readonly envelopes: readonly OfflineEnvelope[];
  readonly accepted: readonly OfflineEnvelope[];
  readonly conflicts: readonly OfflineEnvelope[];
  readonly rejected: readonly OfflineEnvelope[];
  readonly quotaBlocked: readonly OfflineEnvelope[];
  readonly stillQueued: readonly OfflineEnvelope[];
  /** How many drafts were actually uploaded (transport invocations). */
  readonly uploadedCount: number;
  /** Drafts blocked before upload because the grant was revoked/expired. */
  readonly uploadBlocked: readonly OfflineEnvelope[];
}

/** Queue order: (queuedAt, draftId) - deterministic across reloads. */
function queueOrder(left: OfflineEnvelope, right: OfflineEnvelope): number {
  const leftAt = left.queuedAt ?? '';
  const rightAt = right.queuedAt ?? '';
  if (leftAt < rightAt) return -1;
  if (leftAt > rightAt) return 1;
  return left.draftId < right.draftId ? -1 : left.draftId > right.draftId ? 1 : 0;
}

function applyAll(store: OfflineStore, accountId: string, envelopes: readonly OfflineEnvelope[]): readonly OfflineEnvelope[] {
  store.persist(accountId, envelopes);
  return store.load(accountId);
}

/**
 * Synchronize the account's outbox after reconnect. Order of operations
 * per draft (exercised by the tests):
 *
 *  1. reload: envelopes come FROM the store (a crashed 'syncing' draft is
 *     requeued first, keeping its idempotency key - commit-before-ack
 *     recovery);
 *  2. grant gate: revoked/expired drafts never upload (no transport call)
 *     and become 'rejected' with a typed code, RETAINED for audit;
 *  3. upload in queue order, one draft at a time, persisting every
 *     transition so a crash at ANY point leaves a consistent queue;
 *  4. verdicts: accepted (record id + replayed flag), conflict (payload
 *     preserved verbatim, routed for explicit resolution), rejected
 *     (typed, retained), quota (back to queued with retry guidance),
 *     transport error (back to queued, retryable without background sync).
 */
export async function syncOnReconnect(store: OfflineStore, accountId: string, session: SyncSession): Promise<SyncOutcome> {
  const loaded = store.load(accountId);

  // 1. crash recovery: any 'syncing' draft belongs to an interrupted run.
  let envelopes = loaded.map((envelope) =>
    envelope.state === 'syncing'
      ? outboxTransition(envelope, {
          type: 'requeue-interrupted',
          message: 'synchronization interrupted before acknowledgement; re-queued with the same idempotency key (a committed server result replays instead of duplicating)',
          at: session.now,
        })
      : envelope,
  );
  envelopes = [...applyAll(store, accountId, envelopes)];

  const grant = session.grant ?? { status: 'valid' as const, message: null, policyReason: null };
  const accepted: OfflineEnvelope[] = [];
  const conflicts: OfflineEnvelope[] = [];
  const rejected: OfflineEnvelope[] = [];
  const quotaBlocked: OfflineEnvelope[] = [];
  const stillQueued: OfflineEnvelope[] = [];
  const uploadBlocked: OfflineEnvelope[] = [];
  let uploadedCount = 0;

  // 2. grant gate: revoked/expired drafts must not upload (FR-027).
  if (grant.status === 'revoked' || grant.status === 'expired') {
    const code: OfflineRejectionCode = grant.status === 'revoked' ? 'GRANT_REVOKED' : 'GRANT_EXPIRED';
    envelopes = envelopes.map((envelope) => {
      if (envelope.state !== 'queued') return envelope;
      const blocked = outboxTransition(envelope, {
        type: 'sync-rejected',
        detail: {
          code,
          message: grant.message ?? `the account's grant is ${grant.status}; the draft was never uploaded and is retained for audit visibility`,
          policyReason: grant.policyReason,
          rejectedAt: session.now,
          uploaded: false,
        },
      });
      uploadBlocked.push(blocked);
      return blocked;
    });
    envelopes = [...applyAll(store, accountId, envelopes)];
  }

  // 3. upload the queued drafts in deterministic order.
  const pending = envelopes.filter((envelope) => envelope.state === 'queued').sort(queueOrder);
  const byId = new Map(envelopes.map((envelope) => [envelope.draftId, envelope]));
  for (const draft of pending) {
    let current = byId.get(draft.draftId);
    if (!current || current.state !== 'queued') continue;
    current = outboxTransition(current, { type: 'sync-start', at: session.now });
    byId.set(current.draftId, current);
    envelopes = [...applyAll(store, accountId, [...byId.values()].sort(queueOrder))];

    let verdict: SyncVerdict;
    try {
      verdict = await session.transport(current);
      uploadedCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      current = outboxTransition(current, { type: 'sync-transport-failed', message: `network error: ${message}`, at: session.now });
      byId.set(current.draftId, current);
      envelopes = [...applyAll(store, accountId, [...byId.values()].sort(queueOrder))];
      continue;
    }

    current = applyVerdict(current, verdict, session.now);
    if (verdict.kind === 'quota') quotaBlocked.push(current);
    byId.set(current.draftId, current);
    envelopes = [...applyAll(store, accountId, [...byId.values()].sort(queueOrder))];
  }

  const finalQueue = store.load(accountId);
  for (const envelope of finalQueue) {
    if (envelope.state === 'accepted') accepted.push(envelope);
    else if (envelope.state === 'conflict') conflicts.push(envelope);
    else if (envelope.state === 'rejected') rejected.push(envelope);
    else if (envelope.state === 'queued') stillQueued.push(envelope);
  }
  return {
    envelopes: finalQueue,
    accepted,
    conflicts,
    rejected,
    quotaBlocked,
    stillQueued,
    uploadedCount,
    uploadBlocked,
  };
}

/** Apply one server verdict to a syncing draft (pure; the caller persists). */
export function applyVerdict(envelope: OfflineEnvelope, verdict: SyncVerdict, at: string): OfflineEnvelope {
  switch (verdict.kind) {
    case 'accepted':
      return outboxTransition(envelope, { type: 'sync-accepted', recordId: verdict.recordId, replayed: verdict.replayed, at });
    case 'conflict':
      return outboxTransition(envelope, { type: 'sync-conflict', currentRevision: verdict.currentRevision, at });
    case 'rejected':
      return outboxTransition(envelope, {
        type: 'sync-rejected',
        detail: {
          code: verdict.code,
          message: verdict.message,
          policyReason: verdict.policyReason,
          rejectedAt: at,
          uploaded: true,
        },
      });
    case 'quota':
      return outboxTransition(envelope, { type: 'sync-quota', message: verdict.message, retryAfter: verdict.retryAfter, at });
    default:
      return envelope;
  }
}

/**
 * Explicit retry of one draft (technical specification: "explicit retry
 * must work on Safari and other browsers without that feature"). Runs the
 * same pipeline for a single queued draft - no background sync involved.
 */
export async function retryDraft(store: OfflineStore, accountId: string, draftId: string, session: SyncSession): Promise<SyncOutcome> {
  const queue = store.load(accountId);
  const target = queue.find((envelope) => envelope.draftId === draftId);
  if (!target || target.state !== 'queued') {
    return {
      envelopes: queue,
      accepted: [],
      conflicts: [],
      rejected: [],
      quotaBlocked: [],
      stillQueued: queue.filter((envelope) => envelope.state === 'queued'),
      uploadedCount: 0,
      uploadBlocked: [],
    };
  }
  const seen = new Set<string>([draftId]);
  const soloTransport: SyncTransport = async (envelope) => {
    if (seen.has(envelope.draftId)) return session.transport(envelope);
    // Other drafts are not part of this explicit retry.
    throw new Error(`explicit retry targets draft ${draftId} only`);
  };
  const rest = queue.filter((envelope) => envelope.draftId !== draftId);
  store.persist(accountId, [target]);
  const outcome = await syncOnReconnect(store, accountId, { ...session, transport: soloTransport });
  const merged = [...store.load(accountId), ...rest].sort(queueOrder);
  store.persist(accountId, merged);
  return { ...outcome, envelopes: store.load(accountId) };
}

// ---------------------------------------------------------------------------
// Explicit conflict resolution (the only path out of 'conflict')
// ---------------------------------------------------------------------------

export type ConflictResolution<P> =
  /** Discard the draft: an explicit user decision, recorded and final. */
  | { readonly kind: 'discard'; readonly confirmed: boolean }
  /** Revise the payload against the server's current revision and requeue. */
  | { readonly kind: 'revise'; readonly payload: P; readonly currentRevision: number };

export type ConflictResolutionResult<P> =
  | { readonly kind: 'resolved'; readonly queue: readonly OfflineEnvelope<P>[] }
  | { readonly kind: 'not-in-conflict'; readonly queue: readonly OfflineEnvelope<P>[] }
  | { readonly kind: 'discard-unconfirmed'; readonly queue: readonly OfflineEnvelope<P>[] };

/**
 * Resolve a conflicted draft EXPLICITLY. The engine itself never resolves,
 * merges, or discards a conflict; this function only acts on the caller's
 * decision (and a discard demands confirmation, so a stray click cannot
 * lose captured field data).
 */
export function resolveConflict<P>(
  store: OfflineStore,
  accountId: string,
  draftId: string,
  resolution: ConflictResolution<P>,
  at: string,
): ConflictResolutionResult<P> {
  const queue = store.load(accountId) as readonly OfflineEnvelope<P>[];
  const target = queue.find((envelope) => envelope.draftId === draftId);
  if (!target || target.state !== 'conflict') {
    return { kind: 'not-in-conflict', queue };
  }
  if (resolution.kind === 'discard') {
    if (!resolution.confirmed) return { kind: 'discard-unconfirmed', queue };
    const next = queue.filter((envelope) => envelope.draftId !== draftId);
    store.persist(accountId, next);
    return { kind: 'resolved', queue: store.load(accountId) as readonly OfflineEnvelope<P>[] };
  }
  const revised = outboxTransition(target, {
    type: 'conflict-revised',
    payload: resolution.payload,
    baseRevision: resolution.currentRevision,
    at,
  });
  const next = queue.map((envelope) => (envelope.draftId === draftId ? revised : envelope));
  store.persist(accountId, next);
  return { kind: 'resolved', queue: store.load(accountId) as readonly OfflineEnvelope<P>[] };
}

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

/** The five UI states of a draft (FR-027 "shows status"). */
export function draftStatusView(envelope: OfflineEnvelope): {
  readonly state: OfflineEnvelope['state'];
  readonly label: string;
  readonly detail: string | null;
} {
  switch (envelope.state) {
    case 'queued':
      return { state: 'queued', label: 'Queued', detail: envelope.lastError };
    case 'syncing':
      return { state: 'syncing', label: 'Syncing', detail: envelope.syncingSince };
    case 'accepted':
      return {
        state: 'accepted',
        label: envelope.replayed ? 'Synced (recovered)' : 'Synced',
        detail: `recorded as ${envelope.acceptedRecordId ?? '(unknown)'} at ${envelope.acceptedAt ?? ''}`,
      };
    case 'conflict':
      return { state: 'conflict', label: 'Conflict - action needed', detail: envelope.conflict?.message ?? null };
    case 'rejected':
      return { state: 'rejected', label: `Rejected (${envelope.rejection?.code ?? 'UNKNOWN'})`, detail: envelope.rejection?.message ?? null };
    default:
      return { state: envelope.state, label: envelope.state, detail: null };
  }
}

/**
 * Deterministic FNV-1a digest export for manifests built elsewhere (the
 * capture UI computes the same digest the tests assert).
 */
export { digestOf as manifestDigestOf };
