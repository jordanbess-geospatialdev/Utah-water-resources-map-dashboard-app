/**
 * Type vocabulary for the offline sync workflow (WD-012-R2).
 *
 * Source of truth: docs/product/baseline/01-product-requirements.md FR-027
 * (offline capture: drafts sync exactly once after reconnect; conflicts and
 * revoked access routed for resolution without silent loss) and FR-048
 * (asset transfers), plus
 * docs/product/baseline/02-technical-specification.md - "Offline, imports,
 * notifications and AI" (scoped queue envelope; queued/syncing/accepted/
 * conflict/rejected states; identity and assignment revalidated at sync;
 * revoked offline drafts must not upload; no silent conflict resolution).
 *
 * Pure domain types only: no HTTP framework, no I/O, no clock reads. The
 * verdict union is mirrored by apps/web/src/offline/outbox.ts (see the
 * mirror contract in its README).
 */

/** What was captured offline (FR-027). */
export type OfflineDraftKind = 'reading' | 'visit';

/** Typed machine codes for a terminally rejected offline draft. */
export type SyncRejectionCode =
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

/** Manifest of one captured attachment, as queued on the device. */
export interface SyncAttachmentManifestEntry {
  readonly manifestId: string;
  readonly category: string;
  readonly filename: string;
  readonly captureTime: string;
  readonly visibility: string;
  readonly sizeBytes: number;
}

/**
 * One offline draft as it arrives at the sync endpoint: the persistence
 * envelope of apps/web/src/offline/store.ts minus the purely client-side
 * lifecycle fields (state, attempts, error trail - the server derives its
 * own view).
 */
export interface OfflineSyncRequest {
  readonly draftId: string;
  /** Reused by every attempt of this draft (exactly-once basis). */
  readonly idempotencyKey: string;
  /** The field actor who captured the draft; must equal the session actor. */
  readonly actorId: string;
  readonly kind: OfflineDraftKind;
  readonly siteId: string;
  /** Target stream for reading drafts; null for visits. */
  readonly streamId: string | null;
  readonly deviceTimestamp: string;
  readonly deviceZone: string;
  readonly captureTime: string;
  /** The revision of the target the draft was captured against. */
  readonly baseRevision: number;
  readonly attachments: readonly SyncAttachmentManifestEntry[];
  /** The captured body: a manual-entry reading input, or a visit input. */
  readonly payload: Record<string, unknown>;
}

/** The server's per-draft verdict (mirrored by the web outbox). */
export type SyncVerdict =
  | { readonly kind: 'accepted'; readonly recordId: string; readonly replayed: boolean }
  | {
      readonly kind: 'conflict';
      readonly reason: 'BASE_REVISION_MOVED';
      readonly baseRevision: number;
      readonly currentRevision: number;
    }
  | {
      readonly kind: 'rejected';
      readonly code: SyncRejectionCode;
      readonly message: string;
      readonly policyReason: string | null;
    }
  | { readonly kind: 'quota'; readonly message: string; readonly retryAfter: string };

/**
 * The accept endpoint's answer: one verdict per request, in request order.
 * A transport that loses this response mid-flight changes nothing: the
 * client re-sends with the same idempotency key and replays these
 * verdicts.
 */
export interface SyncAcceptResult {
  readonly verdicts: readonly SyncVerdict[];
}

/** Ledger entry: the terminal verdict recorded for one idempotency key. */
export interface SyncLedgerEntry {
  readonly idempotencyKey: string;
  readonly draftId: string;
  readonly actorId: string;
  readonly kind: OfflineDraftKind;
  readonly verdict: SyncVerdict;
  readonly recordedAt: string;
}

/** Audit outcome vocabulary for the sync log. */
export type SyncAuditOutcome = 'accepted' | 'replayed' | 'conflict' | 'rejected' | 'quota';

/** One sync-domain audit event (append-only, actor-resolvable after deactivation). */
export interface SyncAuditEvent {
  readonly id: string;
  readonly draftId: string;
  readonly idempotencyKey: string;
  readonly kind: OfflineDraftKind;
  readonly actorId: string;
  readonly siteId: string;
  readonly outcome: SyncAuditOutcome;
  readonly detail: string;
  readonly recordedAt: string;
  readonly sequence: number;
}

// ---------------------------------------------------------------------------
// Asset transfers (FR-048)
// ---------------------------------------------------------------------------

/**
 * An equipment record: "Equipment records preserve make, model, identifier
 * and serial-number evidence" (FR-048). Photo references are placeholder
 * object refs (same scheme as WD-012 attachments).
 */
export interface EquipmentRecord {
  readonly id: string;
  readonly make: string;
  readonly model: string;
  /** Asset identifier / tag (e.g. the RTU tag painted on the enclosure). */
  readonly identifier: string;
  readonly serial: string;
  /** Evidence photos (placeholder object refs). */
  readonly photoRefs: readonly string[];
  readonly registeredAt: string;
  readonly registeredBy: string;
  readonly notes: string | null;
}

/**
 * One effective-dated site association of an equipment record. Half-open
 * period [effectiveFrom, effectiveTo); effectiveTo null = currently at
 * that site. A transfer CLOSES the old association and OPENS the new one
 * at the same instant - it never rewrites either.
 */
export interface SiteAssociation {
  readonly equipmentId: string;
  readonly siteId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  /** The transfer that opened this association; null for initial registration. */
  readonly openedByTransferId: string | null;
  /** The transfer that closed this association; null while open. */
  readonly closedByTransferId: string | null;
}

/** One executed transfer (auditable, immutable once recorded). */
export interface TransferRecord {
  readonly id: string;
  readonly equipmentId: string;
  readonly fromSiteId: string;
  readonly toSiteId: string;
  /** The association boundary: old closes, new opens, at this instant. */
  readonly effectiveAt: string;
  /** The evidence the actor confirmed at transfer time (must match the record). */
  readonly confirmedIdentifier: string;
  readonly confirmedSerial: string;
  readonly transferredBy: string;
  readonly recordedAt: string;
}

/** Transfer-domain audit actions. */
export type TransferAuditAction = 'register-equipment' | 'transfer-equipment';

/** Append-only audit event for equipment registration and transfers. */
export interface TransferAuditEvent {
  readonly id: string;
  readonly action: TransferAuditAction;
  readonly actorId: string;
  readonly equipmentId: string;
  readonly fromSiteId: string | null;
  readonly toSiteId: string | null;
  readonly effectiveAt: string | null;
  /** The equipment's association timeline before / after the action. */
  readonly before: readonly SiteAssociation[];
  readonly after: readonly SiteAssociation[];
  readonly recordedAt: string;
  readonly sequence: number;
}

/** Field-scoped validation error (same shape as the other workflows). */
export interface TransferFieldError {
  readonly fieldPath: string;
  readonly code: string;
  readonly message: string;
}

/** Equipment registration input. */
export interface RegisterEquipmentInput {
  readonly make: string;
  readonly model: string;
  readonly identifier: string;
  readonly serial: string;
  readonly photoRefs: readonly string[];
  readonly initialSiteId: string;
  /** Association start of the initial registration. */
  readonly effectiveFrom: string;
  readonly notes?: string | null;
}

/** Asset transfer input (FR-048). */
export interface TransferEquipmentInput {
  readonly equipmentId: string;
  readonly fromSiteId: string;
  readonly toSiteId: string;
  /** The association boundary instant (closes old, opens new). */
  readonly effectiveAt: string;
  /** Evidence confirmed on site; must match the registered record. */
  readonly identifier: string;
  readonly serial: string;
  readonly notes?: string | null;
}

/** The transfer landed: record + the equipment's full timeline after it. */
export interface TransferAppliedDecision {
  readonly outcome: 'applied';
  readonly code: 'OK';
  readonly transfer: TransferRecord | null;
  readonly equipment: EquipmentRecord;
  readonly associations: readonly SiteAssociation[];
  readonly auditEvent: TransferAuditEvent;
}

/** Nothing changed; field errors and/or a policy reason explain why. */
export interface TransferRejectedDecision {
  readonly outcome: 'rejected';
  readonly status: 401 | 403 | 404 | 422 | 409;
  readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION_FAILED' | 'ASSOCIATION_MISMATCH' | 'EVIDENCE_MISMATCH';
  readonly message: string;
  readonly fieldErrors: readonly TransferFieldError[];
  readonly policyReason: string | null;
}

export type TransferDecision = TransferAppliedDecision | TransferRejectedDecision;
