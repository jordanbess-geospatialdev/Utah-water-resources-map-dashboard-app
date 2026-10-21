/**
 * The site-visit workflow (WD-012): POST /sites/{id}/visits.
 *
 * "Assigned field documentation and controlled attachment visibility"
 * (technical specification API table). Assigned engineers record site visits,
 * maintenance and inspection history; every attachment is hashed at attach
 * and carries its marked visibility; the visit appends to the per-site
 * append-only history and advances the structured lastChecked/lastRated
 * dates (FR-046), which survive equipment replacement because history is
 * never rewritten.
 *
 * Check order per mutation (deliberate, exercised by the tests):
 *  1. resolve the site                     -> 404 NOT_FOUND when unknown;
 *  2. capability via @utah-water/policy    -> 401 identity denials, 404
 *     hidden-object out-of-scope on non-public sites, else 403 (the engine
 *     also closes non-active sites: field-visits is a mutate-class action,
 *     so a proposed or inactive site refuses visits);
 *  3. idempotency replay                   -> same body: the recorded visit;
 *     different body: IDEMPOTENCY_CONFLICT (409);
 *  4. input validation                     -> 422 VALIDATION_FAILED with
 *     field paths (governed enums, ISO instants, structured dates not after
 *     the visit time, wiring notes never public, filename sanity);
 *  5. attach attachments through storage   -> sha256 recorded at attach,
 *     objectRef placeholder (no bytes in the visit log);
 *  6. append visit + audit + outbox        -> applied (201).
 *
 * Nothing in this module edits or removes visit history; the only mutation
 * path is store.appendVisit.
 */
import { evaluate, type AuthorizationRequest, type Capability, type Decision as PolicyDecision } from '../../../../../packages/policy/src/index.ts';
import type { AttachmentStorage } from './attachments.ts';
import { hashAttachmentContent } from './attachments.ts';
import {
  DEFAULT_RETENTION_CLASS,
  GOVERNED_ATTACHMENT_CATEGORIES,
  GOVERNED_ATTACHMENT_VISIBILITIES,
  GOVERNED_RETENTION_CLASSES,
  GOVERNED_VISIT_ACTIONS,
  GOVERNED_VISIT_TYPES,
  MAX_ATTACHMENT_PLACEHOLDER_BYTES,
  visitFingerprint,
  type VisitStore,
} from './store.ts';
import type {
  Attachment,
  AttachmentInput,
  CreateVisitInput,
  IdempotencyConflictVisitDecision,
  RejectedVisitDecision,
  SiteInspectionSummary,
  SiteRegistryRow,
  Visit,
  VisitAuditEvent,
  VisitContext,
  VisitDecision,
  VisitFieldError,
  VisitOutboxEvent,
} from './types.ts';

/** The matrix verb behind POST /sites/{id}/visits: assigned field documentation. */
export const FIELD_VISIT_CAPABILITY: Capability = 'field-visits';

function fieldError(fieldPath: string, code: string, message: string): VisitFieldError {
  return { fieldPath, code, message };
}

function reject(
  siteId: string,
  status: RejectedVisitDecision['status'],
  code: RejectedVisitDecision['code'],
  message: string,
  fieldErrors: readonly VisitFieldError[] = [],
  policyReason: string | null = null,
): RejectedVisitDecision {
  return { outcome: 'rejected', status, code, siteId, message, fieldErrors, policyReason };
}

/**
 * Policy denial -> API error mapping (the fixed hidden-object table shared
 * with the correction and site-setup workflows): identity denials 401;
 * unknown object 404; out-of-scope on a NON-public site 404 (the site does
 * not exist for the outsider); everything else 403.
 */
function policyRejection(site: SiteRegistryRow, policy: PolicyDecision): RejectedVisitDecision {
  if (
    policy.reason === 'DENY_ANONYMOUS' ||
    policy.reason === 'DENY_UNKNOWN_PRINCIPAL' ||
    policy.reason === 'DENY_PRINCIPAL_INACTIVE'
  ) {
    return reject(site.id, 401, 'UNAUTHENTICATED', 'recording a visit requires an authenticated, active principal', [], policy.reason);
  }
  if (policy.reason === 'DENY_UNKNOWN_OBJECT') {
    return reject(site.id, 404, 'NOT_FOUND', 'site not found', [], policy.reason);
  }
  if (policy.reason === 'DENY_OUT_OF_SCOPE' && site.visibility !== 'public') {
    return reject(site.id, 404, 'NOT_FOUND', 'site not found', [], policy.reason);
  }
  return reject(site.id, 403, 'FORBIDDEN', `actor is not permitted to record visits on this site (${policy.reason})`, [], policy.reason);
}

// ---------------------------------------------------------------------------
// Validation (step 4)
// ---------------------------------------------------------------------------

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isIsoInstant(value: string): boolean {
  return ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

function validateVisitInput(input: CreateVisitInput): readonly VisitFieldError[] {
  const errors: VisitFieldError[] = [];

  if (typeof input.visitTime !== 'string' || !isIsoInstant(input.visitTime)) {
    errors.push(fieldError('visitTime', 'VISIT_TIME_INVALID', 'visitTime must be an ISO 8601 instant with an explicit offset (e.g. 2026-03-12T15:30:00Z)'));
  }
  if (!GOVERNED_VISIT_TYPES.includes(input.type)) {
    errors.push(fieldError('type', 'VISIT_TYPE_UNKNOWN', `type "${String(input.type)}" must be one of ${GOVERNED_VISIT_TYPES.join(', ')}`));
  }
  if (!Array.isArray(input.actionIds) || input.actionIds.length === 0) {
    errors.push(fieldError('actionIds', 'ACTIONS_REQUIRED', 'record at least one measurement or maintenance action (FR-046)'));
  } else {
    const seen = new Set<string>();
    for (const [index, actionId] of input.actionIds.entries()) {
      if (seen.has(actionId)) {
        errors.push(fieldError(`actionIds[${index}]`, 'ACTION_DUPLICATE', `action "${actionId}" is recorded more than once`));
        continue;
      }
      seen.add(actionId);
      if (!GOVERNED_VISIT_ACTIONS_SET.has(actionId)) {
        errors.push(fieldError(`actionIds[${index}]`, 'ACTION_UNKNOWN', `action "${String(actionId)}" is not in the governed vocabulary`));
      }
    }
  }
  if (input.notes !== undefined && input.notes !== null && typeof input.notes !== 'string') {
    errors.push(fieldError('notes', 'NOTES_INVALID', 'notes must be a string'));
  }
  if (input.notes !== undefined && typeof input.notes === 'string' && input.notes.length > 4000) {
    errors.push(fieldError('notes', 'NOTES_TOO_LONG', 'notes must be at most 4000 characters'));
  }

  const visitMs = isIsoInstant(input.visitTime) ? Date.parse(input.visitTime) : null;
  for (const field of ['lastChecked', 'lastRated'] as const) {
    const value = input[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !isIsoInstant(value)) {
      errors.push(fieldError(field, 'STRUCTURED_DATE_INVALID', `${field} must be an ISO 8601 instant with an explicit offset, or null`));
    } else if (visitMs !== null && Date.parse(value) > visitMs) {
      errors.push(fieldError(field, 'STRUCTURED_DATE_AFTER_VISIT', `${field} (${value}) cannot be after the visit time; the structured dates describe the site state as observed during this visit`));
    }
  }

  if (!Array.isArray(input.attachments)) {
    errors.push(fieldError('attachments', 'ATTACHMENTS_INVALID', 'attachments must be an array (possibly empty)'));
    return errors;
  }
  for (const [index, attachment] of input.attachments.entries()) {
    errors.push(...validateAttachmentInput(index, attachment, visitMs));
  }
  return errors;
}

function validateAttachmentInput(index: number, attachment: AttachmentInput, visitMs: number | null): readonly VisitFieldError[] {
  const errors: VisitFieldError[] = [];
  const at = (field: string) => `attachments[${index}].${field}`;

  if (!GOVERNED_ATTACHMENT_CATEGORIES.includes(attachment.category)) {
    errors.push(fieldError(at('category'), 'CATEGORY_UNKNOWN', `category "${String(attachment.category)}" must be one of ${GOVERNED_ATTACHMENT_CATEGORIES.join(', ')}`));
  }
  if (!GOVERNED_ATTACHMENT_VISIBILITIES.includes(attachment.visibility)) {
    errors.push(fieldError(at('visibility'), 'VISIBILITY_UNKNOWN', `visibility "${String(attachment.visibility)}" must be one of ${GOVERNED_ATTACHMENT_VISIBILITIES.join(', ')}`));
  }
  if (attachment.category === 'wiring-note' && attachment.visibility === 'public') {
    // FR-049: a gate code or wiring detail can never be published. The
    // category is internal by policy; the uploader cannot opt out.
    errors.push(fieldError(at('visibility'), 'WIRING_NOTE_MUST_BE_INTERNAL', 'a wiring note (gate code or wiring detail) can never be marked public (FR-049); the category is internal by policy'));
  }
  if (typeof attachment.filename !== 'string' || attachment.filename.trim() === '') {
    errors.push(fieldError(at('filename'), 'FILENAME_REQUIRED', 'a filename is required'));
  } else if (/[\\/]|\.\./.test(attachment.filename)) {
    errors.push(fieldError(at('filename'), 'FILENAME_UNSAFE', 'the filename must not contain path separators or traversal sequences'));
  }
  if (typeof attachment.captureTime !== 'string' || !isIsoInstant(attachment.captureTime)) {
    errors.push(fieldError(at('captureTime'), 'CAPTURE_TIME_INVALID', 'captureTime must be an ISO 8601 instant with an explicit offset'));
  } else if (visitMs !== null && Date.parse(attachment.captureTime) > visitMs) {
    errors.push(fieldError(at('captureTime'), 'CAPTURE_TIME_AFTER_VISIT', `captureTime (${attachment.captureTime}) cannot be after the visit time; capture happens on site`));
  }
  if (attachment.retentionClass !== undefined && !GOVERNED_RETENTION_CLASSES.includes(attachment.retentionClass)) {
    errors.push(fieldError(at('retentionClass'), 'RETENTION_CLASS_UNKNOWN', `retentionClass "${String(attachment.retentionClass)}" must be one of ${GOVERNED_RETENTION_CLASSES.join(', ')}`));
  }
  if (attachment.note !== undefined && attachment.note !== null && typeof attachment.note !== 'string') {
    errors.push(fieldError(at('note'), 'NOTE_INVALID', 'note must be a string or null'));
  }
  if (typeof attachment.sizeBytes !== 'number' || !Number.isInteger(attachment.sizeBytes) || attachment.sizeBytes < 0) {
    errors.push(fieldError(at('sizeBytes'), 'SIZE_INVALID', 'sizeBytes must be a non-negative integer'));
  } else if (attachment.sizeBytes > MAX_ATTACHMENT_PLACEHOLDER_BYTES) {
    errors.push(fieldError(at('sizeBytes'), 'SIZE_TOO_LARGE', `sizeBytes must be at most ${MAX_ATTACHMENT_PLACEHOLDER_BYTES}`));
  }
  if (typeof attachment.content !== 'string' || attachment.content.length === 0) {
    errors.push(fieldError(at('content'), 'CONTENT_REQUIRED', 'content is required: the sha256 integrity hash is computed at attach (the bytes themselves are not kept in the visit log)'));
  }
  return errors;
}

const GOVERNED_VISIT_ACTIONS_SET = new Set<string>(GOVERNED_VISIT_ACTIONS);

// ---------------------------------------------------------------------------
// POST /sites/{id}/visits (step 1-6)
// ---------------------------------------------------------------------------

/** Normalized input shape used for the idempotency fingerprint. */
interface NormalizedVisit {
  readonly siteId: string;
  readonly visitTime: string;
  readonly type: string;
  readonly actionIds: readonly string[];
  readonly notes: string;
  readonly lastChecked: string | null;
  readonly lastRated: string | null;
  readonly attachments: ReadonlyArray<{
    category: string;
    visibility: string;
    filename: string;
    captureTime: string;
    retentionClass: string;
    sizeBytes: number;
    sha256: string;
  }>;
}

/**
 * Record a site visit (FR-046, FR-049). On success the visit is appended to
 * the site's append-only history with its attachments (hashed at attach),
 * the structured inspection summary advances, and an audit event plus a
 * publication-refresh outbox event land in the same logical transaction.
 */
export function createVisit(
  store: VisitStore,
  storage: AttachmentStorage,
  actorId: string,
  input: CreateVisitInput,
  ctx: VisitContext,
): VisitDecision {
  // 1. resolve the site
  const site = store.siteById(input.siteId);
  if (!site) {
    return reject(input.siteId, 404, 'NOT_FOUND', 'site not found', [fieldError('siteId', 'SITE_UNKNOWN', `site "${input.siteId}" does not exist`)]);
  }

  // 2. capability within actor scope via the policy engine
  const principal = store.world.principals[actorId] ?? null;
  const request: AuthorizationRequest = {
    principal,
    action: FIELD_VISIT_CAPABILITY,
    object: { kind: 'station', id: site.id },
  };
  const policy = evaluate(request, store.world, ctx.now);
  if (policy.effect !== 'allow') return policyRejection(site, policy);

  // 3. idempotency replay: the fingerprint covers the sha256 of each
  //    attachment's bytes (computed pure, via hashAttachmentContent - never
  //    the bytes themselves), so a replaying client needs no stored objects.
  const normalized: NormalizedVisit = {
    siteId: site.id,
    visitTime: input.visitTime,
    type: input.type,
    actionIds: [...input.actionIds].slice().sort(),
    notes: (input.notes ?? '').trim(),
    lastChecked: input.lastChecked ?? null,
    lastRated: input.lastRated ?? null,
    attachments: input.attachments.map((attachment) => ({
      category: String(attachment?.category),
      visibility: String(attachment?.visibility),
      filename: typeof attachment?.filename === 'string' ? attachment.filename.trim() : String(attachment?.filename),
      captureTime: String(attachment?.captureTime),
      retentionClass: String(attachment?.retentionClass ?? DEFAULT_RETENTION_CLASS[attachment?.category as keyof typeof DEFAULT_RETENTION_CLASS] ?? 'standard'),
      sizeBytes: typeof attachment?.sizeBytes === 'number' ? attachment.sizeBytes : -1,
      sha256: typeof attachment?.content === 'string' && attachment.content.length > 0 ? hashAttachmentContent(attachment.content) : '',
    })),
  };
  if (ctx.idempotencyKey) {
    const recorded = store.lookupIdempotency(ctx.idempotencyKey);
    if (recorded) {
      if (recorded.fingerprint === visitFingerprint(normalized)) {
        const visit = store.visitById(recorded.visitId) ?? null;
        if (visit) {
          return {
            outcome: 'applied',
            code: 'OK',
            status: 201,
            replayed: true,
            visit,
            summary: store.summaryFor(site.id),
            auditEvent: null, // no new mutation on replay
            outboxEvent: null,
          };
        }
      } else {
        const conflict: IdempotencyConflictVisitDecision = {
          outcome: 'conflict',
          code: 'IDEMPOTENCY_CONFLICT',
          status: 409,
          siteId: site.id,
          idempotencyKey: ctx.idempotencyKey,
          recordedVisitId: recorded.visitId,
          recordedAt: recorded.recordedAt,
        };
        return conflict;
      }
    }
  }

  // 4. input validation
  const errors = validateVisitInput(input);
  if (errors.length > 0) {
    return reject(site.id, 422, 'VALIDATION_FAILED', 'visit recording failed validation; see fieldErrors', errors);
  }

  // 5. attach attachments through storage: put() hashes the placeholder
  //    bytes and returns the objectRef; the sha256 is recorded at attach.
  //    This happens only after validation, so a rejected request leaves no
  //    stored objects behind.
  const prepared = prepareAttachments(store, storage, input);

  // 6. append visit + audit + outbox as one transaction (no bytes enter the log).
  const { visit, auditEvent, outboxEvent } = store.appendVisit({
    site,
    actorId,
    now: ctx.now,
    idempotencyKey: ctx.idempotencyKey ?? null,
    preparedAttachments: prepared,
    normalized,
    input: { ...input, notes: normalized.notes },
  });
  return {
    outcome: 'applied',
    code: 'OK',
    status: 201,
    replayed: false,
    visit,
    summary: store.summaryFor(site.id),
    auditEvent,
    outboxEvent,
  };
}

/**
 * Attach every input attachment through the storage interface: put() hashes
 * the placeholder bytes and returns the objectRef. The sha256 is recorded at
 * attach (integrity evidence). Provisional ids are sequence-derived and must
 * match the ids appendVisit assigns, so the objectRef of attachment i is
 * stable across prepare and append. Called only AFTER validation.
 */
function prepareAttachments(
  store: VisitStore,
  storage: AttachmentStorage,
  input: CreateVisitInput,
): ReadonlyArray<Omit<Attachment, 'id' | 'visitId' | 'siteId' | 'attachedAt' | 'attachedBy'>> {
  return input.attachments.map((attachment, index) => {
    const provisionalId = `att-${String(1000 + store.attachments.length + index + 1)}`;
    const { objectRef, sha256 } = storage.put({
      id: provisionalId,
      visibility: attachment.visibility,
      content: attachment.content,
    });
    return {
      category: attachment.category,
      visibility: attachment.visibility,
      objectRef,
      sha256,
      captureTime: attachment.captureTime,
      retentionClass: attachment.retentionClass ?? DEFAULT_RETENTION_CLASS[attachment.category] ?? 'standard',
      filename: attachment.filename.trim(),
      note: attachment.note !== undefined && attachment.note !== null ? attachment.note : null,
      sizeBytes: attachment.sizeBytes,
    };
  });
}

// ---------------------------------------------------------------------------
// History and structured-date reads (FR-046)
// ---------------------------------------------------------------------------

/** Per-site visit history in append order. The raw log - authorization and projection are the caller's concern (see attachments.ts). */
export function siteVisitHistory(store: VisitStore, siteId: string): readonly Visit[] {
  return store.visitsForSite(siteId);
}

/** The structured inspection summary of a site (lastChecked/lastRated derived from the append-only history). */
export function inspectionSummary(store: VisitStore, siteId: string): SiteInspectionSummary | null {
  if (!store.siteById(siteId)) return null;
  return store.summaryFor(siteId);
}

/**
 * Structured-date query (FR-046): sites not inspected since X - a site is
 * current when some visit asserted lastChecked at or after `since`; sites
 * with no visits at all are not inspected since any date.
 */
export function sitesNotInspectedSince(
  store: VisitStore,
  since: string,
): ReadonlyArray<SiteRegistryRow & { lastChecked: string | null }> | null {
  if (!isIsoInstant(since)) return null;
  return store.sitesNotInspectedSince(since);
}

/** Re-exported for the audit evidence surface (correlated audit + outbox of one visit). */
export function evidenceForVisit(
  store: VisitStore,
  correlationId: string,
): { audit: VisitAuditEvent | null; outbox: VisitOutboxEvent | null } {
  return {
    audit: store.auditEvents.find((event) => event.correlationId === correlationId) ?? null,
    outbox: store.outboxEvents.find((event) => event.correlationId === correlationId) ?? null,
  };
}
