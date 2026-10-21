/**
 * Type vocabulary for the field-visits workflow (WD-012).
 *
 * Source of truth: docs/product/baseline/01-product-requirements.md FR-046
 * (visits, maintenance and inspection history) and FR-049 (categorized
 * public and internal attachments), plus
 * docs/product/baseline/02-technical-specification.md - the "Site visit and
 * attachment" entity row (capture/visit time, actor, categories, visibility,
 * object reference, retention class and integrity hash) and the API table
 * row `POST /sites/{id}/visits` (assigned field documentation and controlled
 * attachment visibility).
 *
 * Pure domain types only: no HTTP framework, no I/O, no clock reads. The
 * future Fastify layer maps the Decision unions below onto the shared error
 * policy (401 identity, 403 capability/field visibility, 404 hidden object,
 * 409 idempotency conflict, 422 validation with field paths).
 */

/** FR-046: "type" of the visit - inspection, maintenance, measurement, other. */
export type VisitType = 'inspection' | 'maintenance' | 'measurement' | 'other';

/**
 * FR-049 attachment categories. `wiring-note` is the gate-code / wiring
 * detail category: POLICY-INTERNAL by nature and can never be marked public
 * (the workflow rejects the combination at validation time).
 */
export type AttachmentCategory = 'photo' | 'wiring-note' | 'document' | 'audio';

/** Permitted visibility an uploader marks on each attachment (FR-049). */
export type AttachmentVisibility = 'public' | 'internal';

/**
 * Retention class of the stored object (technical specification, site visit
 * and attachment entity). Recorded at attach and carried on every internal
 * view; never part of the public projection.
 */
export type RetentionClass = 'standard' | 'extended' | 'permanent';

/**
 * One measurement or maintenance action recorded by the visit (FR-046:
 * "measurement or maintenance actions"). Governed vocabulary, validated by
 * the workflow like qualifiers in the correction workflow.
 */
export type VisitActionId =
  | 'measurement-taken'
  | 'gauge-inspection'
  | 'rating-verification'
  | 'equipment-maintenance'
  | 'sensor-replacement'
  | 'battery-replacement'
  | 'site-cleanup'
  | 'other';

/**
 * A categorized attachment recorded with a visit (FR-049). The object
 * reference is a storage placeholder in this task - no bytes persist in the
 * visit log; only the reference, the sha256 integrity hash recorded at
 * attach, and the metadata below.
 */
export interface Attachment {
  readonly id: string;
  readonly visitId: string;
  readonly siteId: string;
  readonly category: AttachmentCategory;
  readonly visibility: AttachmentVisibility;
  /** Storage placeholder reference (`placeholder://attachments/<id>`); real object storage is out of scope for WD-012. */
  readonly objectRef: string;
  /** sha256 of the attached content, recorded at attach (integrity evidence). */
  readonly sha256: string;
  /** Capture time: when the photo/document/audio/note was captured (technical specification, distinct from the visit time). */
  readonly captureTime: string;
  readonly retentionClass: RetentionClass;
  /** Display filename. A filename hint of an internal attachment must never reach a public serialization. */
  readonly filename: string;
  /** Category note; for wiring notes this is the wiring/gate detail text itself - internal only. */
  readonly note: string | null;
  readonly sizeBytes: number;
  readonly attachedAt: string;
  readonly attachedBy: string;
}

/**
 * A site visit (FR-046): site, actor, visit time, type, measurement or
 * maintenance actions, attachments, and the structured lastChecked /
 * lastRated dates. VISIT TIME (when the crew was on site) and RECORDED TIME
 * (when the visit landed in the log) are separate fields end to end, like
 * observation time vs revision time in the correction workflow.
 *
 * Visit history is APPEND-ONLY: a visit is never edited, reordered or
 * removed, so the structured dates and the whole history survive equipment
 * replacement (which only ever appends setup epochs in WD-010).
 */
export interface Visit {
  readonly id: string;
  readonly siteId: string;
  readonly actorId: string;
  /** VISIT time (on site), with the source offset retained by the client. */
  readonly visitTime: string;
  /** RECORDED time (when the visit was appended to the log). */
  readonly recordedAt: string;
  readonly type: VisitType;
  readonly actionIds: readonly VisitActionId[];
  /**
   * Free-form visit note. Internal-class by policy (the specification's
   * engineer field-work row carries "internal attachments, visit notes"):
   * it never enters any public projection.
   */
  readonly notes: string;
  /** Structured queryable date: when the site/gauge was last checked, asserted by this visit. */
  readonly lastChecked: string | null;
  /** Structured queryable date: when the rating was last rated, asserted by this visit. */
  readonly lastRated: string | null;
  readonly attachments: readonly Attachment[];
  /** Optimistic ordinal of the visit within the site's append-only history (1-based). */
  readonly sequence: number;
}

/**
 * Structured inspection state of a site, derived from its append-only visit
 * history (never stored separately, so it can never disagree with the log).
 */
export interface SiteInspectionSummary {
  readonly siteId: string;
  readonly visitCount: number;
  readonly lastVisitTime: string | null;
  /** Latest non-null lastChecked by visit time (FR-046 structured field). */
  readonly lastChecked: string | null;
  readonly lastCheckedVisitId: string | null;
  /** Latest non-null lastRated by visit time (FR-046 structured field). */
  readonly lastRated: string | null;
  readonly lastRatedVisitId: string | null;
}

/** Minimal site registry row the visit store keeps from fixtures/contracts/stations.json. */
export interface SiteRegistryRow {
  readonly id: string;
  readonly displayName: string;
  readonly systemId: string;
  readonly status: 'proposed' | 'active' | 'inactive' | 'retired';
  readonly visibility: 'public' | 'internal' | 'restricted';
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Attachment upload descriptor inside POST /sites/{id}/visits. */
export interface AttachmentInput {
  readonly category: AttachmentCategory;
  readonly visibility: AttachmentVisibility;
  readonly filename: string;
  readonly captureTime: string;
  readonly retentionClass?: RetentionClass;
  readonly note?: string;
  readonly sizeBytes: number;
  /**
   * Placeholder content payload (never persisted in the visit log): present
   * so the sha256 integrity hash can be computed and recorded AT ATTACH.
   */
  readonly content: string;
}

/** Body of POST /sites/{id}/visits. */
export interface CreateVisitInput {
  readonly siteId: string;
  readonly visitTime: string;
  readonly type: VisitType;
  readonly actionIds: readonly string[];
  readonly notes?: string;
  readonly lastChecked?: string | null;
  readonly lastRated?: string | null;
  readonly attachments: readonly AttachmentInput[];
}

// ---------------------------------------------------------------------------
// Execution context, audit and decisions
// ---------------------------------------------------------------------------

/** Execution context injected by the caller: clock and idempotency key. */
export interface VisitContext {
  /** UTC instant; the workflow never reads a clock internally. */
  readonly now: string;
  /** Idempotency-Key header. Same key + same body replays the recorded visit; same key + different body is a 409. */
  readonly idempotencyKey?: string;
}

export type VisitAuditAction = 'record-visit';

/**
 * Audit event for one visit append (Audit event row of the data model:
 * actor, action, object, time, correlation id, structured change; secrets
 * excluded - wiring-note text and attachment bytes never enter audit).
 */
export interface VisitAuditEvent {
  readonly id: string;
  readonly action: VisitAuditAction;
  readonly actorId: string;
  readonly siteId: string;
  readonly visitId: string;
  /** Structured before/after of the site's inspection state. */
  readonly before: SiteInspectionSummary;
  readonly after: SiteInspectionSummary;
  readonly attachmentCount: number;
  readonly internalAttachmentCount: number;
  readonly recordedAt: string;
  readonly correlationId: string;
}

/**
 * Transactional-outbox publication refresh (ADR-10): a visit with public
 * attachments changes the public site page; internal attachments never do.
 */
export interface VisitOutboxEvent {
  readonly id: string;
  readonly type: 'publication-refresh';
  readonly siteId: string;
  /** Public attachment ids included in the refresh; internal ids are never listed here. */
  readonly publicAttachmentIds: readonly string[];
  readonly recordedAt: string;
  readonly correlationId: string;
}

/** Stable machine codes, aligned with the shared API error policy. */
export type VisitDecisionCode =
  | 'OK'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT';

/** One validation error, tied to the offending field (FR-020-style field paths). */
export interface VisitFieldError {
  readonly fieldPath: string;
  readonly code: string;
  readonly message: string;
}

/** The visit landed (or had already landed and is being replayed). */
export interface AppliedVisitDecision {
  readonly outcome: 'applied';
  readonly code: 'OK';
  readonly status: 201;
  /** True when an idempotency-key replay returned the recorded visit without a new append. */
  readonly replayed: boolean;
  readonly visit: Visit;
  /** The site's inspection summary after the append. */
  readonly summary: SiteInspectionSummary;
  /** Null on replay: no new mutation, therefore no new audit/outbox rows. */
  readonly auditEvent: VisitAuditEvent | null;
  readonly outboxEvent: VisitOutboxEvent | null;
}

/** Same Idempotency-Key replayed with a different body: rejected (409). */
export interface IdempotencyConflictVisitDecision {
  readonly outcome: 'conflict';
  readonly code: 'IDEMPOTENCY_CONFLICT';
  readonly status: 409;
  readonly siteId: string;
  readonly idempotencyKey: string;
  readonly recordedVisitId: string;
  readonly recordedAt: string;
}

/** Validation, capability or resolution failure; nothing was appended. */
export interface RejectedVisitDecision {
  readonly outcome: 'rejected';
  readonly status: 401 | 403 | 404 | 422;
  readonly code: Exclude<VisitDecisionCode, 'OK' | 'IDEMPOTENCY_CONFLICT'>;
  readonly siteId: string;
  readonly message: string;
  readonly fieldErrors: readonly VisitFieldError[];
  /** Engine DENY_* reason when this rejection is a policy denial. */
  readonly policyReason: string | null;
}

export type VisitDecision = AppliedVisitDecision | IdempotencyConflictVisitDecision | RejectedVisitDecision;
