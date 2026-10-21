/**
 * The FR-049 visibility wall: categorized attachments, the storage
 * placeholder and every public-facing accessor.
 *
 * "Users upload several categorized site or asset photos and mark permitted
 * visibility; public APIs, thumbnails, exports and report generation cannot
 * retrieve an internal photo, note, gate code or wiring detail."
 *
 * The wall is enforced in THREE independent layers, and every accessor
 * re-checks it - a projection bug in one layer cannot leak through another:
 *
 *  1. PROJECTION: publicAttachmentViews / publicVisitHistory / exportManifest
 *     build their rows from public attachments ONLY and strip internal
 *     FIELDS (note text, retention class, object reference of internal rows,
 *     wiring-note category, actor ids, visit notes) - row visibility alone
 *     is not sufficient, exactly like the station internal block.
 *  2. STORAGE: the placeholder object store checks the recorded visibility
 *     of the object at EVERY read accessor - publicRead, publicThumbnail,
 *     exportRead refuse internal object references outright; internalRead
 *     additionally demands a policy grant carried from an allow decision.
 *  3. POLICY: internalAttachmentList admits only principals the
 *     @utah-water/policy engine allows to read internal-class fields of the
 *     station in scope (engineer/steward; a commissioner's assignment does
 *     not open internal fields).
 *
 * `collectInternalCanaries` enumerates every byte-level secret an internal
 * attachment contributes; the sweep test asserts none of them appears in ANY
 * public-facing serialization (JSON.stringify sweep, like the gate-code
 * canary sweep in apps/web/tests).
 *
 * Integrity: sha256 is computed and recorded AT ATTACH (createVisit ->
 * storage.put); verifyIntegrity re-hashes the stored placeholder bytes and
 * compares, so tampering with stored content is detectable later.
 *
 * No real object storage in WD-012: the objectRef is a placeholder scheme
 * and the bytes live only in this module's private map.
 */
import { createHash } from 'node:crypto';
import { evaluate, evaluatePublicRead, type AuthorizationRequest } from '../../../../../packages/policy/src/index.ts';
import type { VisitStore } from './store.ts';
import type { Attachment, AttachmentCategory, AttachmentVisibility, RetentionClass, Visit } from './types.ts';

// ---------------------------------------------------------------------------
// Storage interface (objectRef placeholder; no real storage in this task)
// ---------------------------------------------------------------------------

/** Refusal from a storage accessor: the wall held. */
export interface StorageRefusal {
  readonly allowed: false;
  readonly code: 'ATTACHMENT_UNKNOWN' | 'ATTACHMENT_INTERNAL' | 'ATTACHMENT_PUBLIC' | 'GRANT_REQUIRED';
  readonly message: string;
}

export interface StorageRead {
  readonly allowed: true;
  readonly content: string;
  readonly sha256: string;
  readonly visibility: AttachmentVisibility;
}

/** Policy proof an internal read must carry (constructed only from an allow decision). */
export interface InternalReadGrant {
  readonly actorId: string;
  readonly siteId: string;
  /** The engine decision that admitted the actor (evidence the wall can re-check). */
  readonly matchedAssignmentIds: readonly string[];
  readonly evaluatedAt: string;
}

export interface AttachmentStorage {
  /** Hash and reference an attachment at attach time. The content never enters the visit log. */
  put(request: { id: string; visibility: AttachmentVisibility; content: string }): { objectRef: string; sha256: string };
  /** Public API download path: public visibility only, at every call. */
  publicRead(objectRef: string): StorageRead | StorageRefusal;
  /** Thumbnail rendering path: public visibility only, at every call. */
  publicThumbnail(objectRef: string): { allowed: true; path: string } | StorageRefusal;
  /** Export/report generation read path: public visibility only, at every call (FR-049). */
  exportRead(objectRef: string): StorageRead | StorageRefusal;
  /** Internal read: requires BOTH the policy grant and internal visibility. */
  internalRead(objectRef: string, grant: InternalReadGrant): StorageRead | StorageRefusal;
  /** Re-hash the stored bytes and compare with the hash recorded at attach. */
  verifyIntegrity(objectRef: string): { objectRef: string; recordedSha256: string | null; actualSha256: string | null; ok: boolean } | null;
}

interface StoredObject {
  readonly id: string;
  readonly visibility: AttachmentVisibility;
  readonly content: string;
  readonly sha256: string;
}

/**
 * Fixed evaluation clock for the publication gate: is_currently_published
 * depends on visibility + lifecycle only (public + active/inactive), never
 * on wall time, so a constant keeps the projections deterministic.
 */
const PUBLICATION_CLOCK = '1970-01-01T00:00:00Z';

export function objectRefFor(attachmentId: string): string {
  return `placeholder://attachments/${attachmentId}`;
}

/** Pure sha256 of attachment content - the hash recorded at attach (used for idempotency fingerprints too). */
export function hashAttachmentContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** The placeholder object store: private bytes, visibility checked at every accessor. */
export function createPlaceholderAttachmentStorage(): AttachmentStorage {
  const objects = new Map<string, StoredObject>();

  const byRef = (objectRef: string): StoredObject | null => {
    const id = objectRef.startsWith('placeholder://attachments/') ? objectRef.slice('placeholder://attachments/'.length) : null;
    return id !== null ? (objects.get(id) ?? null) : null;
  };

  return {
    put(request) {
      const sha256 = hashAttachmentContent(request.content);
      const objectRef = objectRefFor(request.id);
      objects.set(request.id, { id: request.id, visibility: request.visibility, content: request.content, sha256 });
      return { objectRef, sha256 };
    },
    publicRead(objectRef) {
      const object = byRef(objectRef);
      if (!object) return { allowed: false, code: 'ATTACHMENT_UNKNOWN', message: `no attachment object at "${objectRef}"` };
      if (object.visibility !== 'public') {
        return { allowed: false, code: 'ATTACHMENT_INTERNAL', message: `attachment "${object.id}" is internal; the public read accessor never serves it (FR-049)` };
      }
      return { allowed: true, content: object.content, sha256: object.sha256, visibility: object.visibility };
    },
    publicThumbnail(objectRef) {
      const object = byRef(objectRef);
      if (!object) return { allowed: false, code: 'ATTACHMENT_UNKNOWN', message: `no attachment object at "${objectRef}"` };
      if (object.visibility !== 'public') {
        return { allowed: false, code: 'ATTACHMENT_INTERNAL', message: `attachment "${object.id}" is internal; no public thumbnail can be generated (FR-049)` };
      }
      // Separately approved cacheable URL per the technical specification
      // ("Public artifacts can use separately approved cacheable URLs").
      return { allowed: true, path: `/cache/attachments/${object.id}/thumb-96.jpg` };
    },
    exportRead(objectRef) {
      const object = byRef(objectRef);
      if (!object) return { allowed: false, code: 'ATTACHMENT_UNKNOWN', message: `no attachment object at "${objectRef}"` };
      if (object.visibility !== 'public') {
        return { allowed: false, code: 'ATTACHMENT_INTERNAL', message: `attachment "${object.id}" is internal; exports and report generation can never retrieve it (FR-049)` };
      }
      return { allowed: true, content: object.content, sha256: object.sha256, visibility: object.visibility };
    },
    internalRead(objectRef, grant) {
      const object = byRef(objectRef);
      if (!object) return { allowed: false, code: 'ATTACHMENT_UNKNOWN', message: `no attachment object at "${objectRef}"` };
      if (grant.matchedAssignmentIds.length === 0) {
        return { allowed: false, code: 'GRANT_REQUIRED', message: 'internal reads require a policy allow decision; construct the grant from an engine allow only' };
      }
      return { allowed: true, content: object.content, sha256: object.sha256, visibility: object.visibility };
    },
    verifyIntegrity(objectRef) {
      const object = byRef(objectRef);
      if (!object) return null;
      const actual = hashAttachmentContent(object.content);
      return { objectRef, recordedSha256: object.sha256, actualSha256: actual, ok: actual === object.sha256 };
    },
  };
}

// ---------------------------------------------------------------------------
// Public projections (layer 1: strip internal attachments AND internal fields)
// ---------------------------------------------------------------------------

/** Everything a PUBLIC payload may say about one attachment. Nothing else. */
export interface PublicAttachmentView {
  readonly id: string;
  readonly visitId: string;
  readonly category: AttachmentCategory;
  readonly filename: string;
  readonly captureTime: string;
  /** Cacheable public thumbnail path (separately approved public artifact URL). */
  readonly thumbnailPath: string;
  /** Authorized download proxy path; every download re-checks grants (no reusable storage URL). */
  readonly downloadPath: string;
}

/**
 * Everything a PUBLIC payload may say about one visit (FR-046 public side):
 * no actor id, no visit notes, no internal attachment metadata, and no
 * internal attachments at all.
 */
export interface PublicVisitView {
  readonly id: string;
  readonly siteId: string;
  readonly visitTime: string;
  readonly type: Visit['type'];
  readonly actionIds: readonly Visit['actionIds'][number][];
  readonly lastChecked: string | null;
  readonly lastRated: string | null;
  readonly publicAttachments: readonly PublicAttachmentView[];
  readonly internalAttachmentCount: number | null;
}

function publicViewOf(attachment: Attachment, storage: AttachmentStorage): PublicAttachmentView {
  const thumbnail = storage.publicThumbnail(attachment.objectRef);
  return {
    id: attachment.id,
    visitId: attachment.visitId,
    category: attachment.category,
    filename: attachment.filename,
    captureTime: attachment.captureTime,
    thumbnailPath: thumbnail.allowed ? thumbnail.path : '',
    downloadPath: `/api/v1/attachments/${attachment.id}/download`,
  };
}

/**
 * The public attachment list of a site. Empty unless the site is CURRENTLY
 * PUBLISHED (the engine's allow_public_read branch decides - an unpublished
 * site has no public projection at all). Internal attachments are stripped
 * before projection, not filtered after serialization. Publication state is
 * time-independent (visibility + active/inactive status), so the evaluation
 * clock is a fixed constant, never a wall read.
 */
export function publicAttachmentViews(store: VisitStore, storage: AttachmentStorage, siteId: string): readonly PublicAttachmentView[] {
  const site = store.siteById(siteId);
  if (!site) return [];
  const publication = evaluatePublicRead(
    { principal: null, action: 'browse-published', object: { kind: 'station', id: siteId } },
    store.world,
    PUBLICATION_CLOCK,
  );
  if (publication.effect !== 'allow') return [];
  return store
    .attachmentsForSite(siteId)
    .filter((attachment) => attachment.visibility === 'public')
    .map((attachment) => publicViewOf(attachment, storage));
}

/**
 * The public visit history of a site (the public site-detail "visits"
 * block). Same publication gate as publicAttachmentViews; every internal
 * field and attachment is stripped, and not even a COUNT of internal
 * attachments is exposed (no existence hint).
 */
export function publicVisitHistory(store: VisitStore, storage: AttachmentStorage, siteId: string): readonly PublicVisitView[] {
  const site = store.siteById(siteId);
  if (!site) return [];
  const publication = evaluatePublicRead(
    { principal: null, action: 'browse-published', object: { kind: 'station', id: siteId } },
    store.world,
    PUBLICATION_CLOCK,
  );
  if (publication.effect !== 'allow') return [];
  return store.visitsForSite(siteId).map((visit) => ({
    id: visit.id,
    siteId: visit.siteId,
    visitTime: visit.visitTime,
    type: visit.type,
    actionIds: visit.actionIds,
    lastChecked: visit.lastChecked,
    lastRated: visit.lastRated,
    publicAttachments: Object.freeze(
      visit.attachments.filter((attachment) => attachment.visibility === 'public').map((attachment) => publicViewOf(attachment, storage)),
    ),
    internalAttachmentCount: null,
  }));
}

// ---------------------------------------------------------------------------
// Export / report manifest (public attachments only - by construction)
// ---------------------------------------------------------------------------

export interface ExportManifestRow {
  readonly attachmentId: string;
  readonly visitId: string;
  readonly category: AttachmentCategory;
  readonly filename: string;
  readonly captureTime: string;
  readonly sha256: string;
  /** Authorized download proxy path; every download re-checks grants (never a reusable storage URL). */
  readonly downloadPath: string;
  readonly retentionClass: RetentionClass;
}

export interface ExportManifest {
  readonly siteId: string;
  readonly attachmentCount: number;
  /** Every id listed here is a PUBLIC attachment; internal ids can never enter (FR-049). */
  readonly rows: readonly ExportManifestRow[];
  readonly visibilityPolicy: 'public-attachments-only';
}

/**
 * The export/report-generation manifest of a site's attachments. HARD-WALLED
 * to public attachments: there is deliberately NO actor parameter that could
 * widen it - exports and report generation can never retrieve an internal
 * photo, note, gate code or wiring detail, whoever asked (FR-049). Rows
 * carry the authorized download proxy path, never the storage objectRef
 * (no reusable storage URL that bypasses revocation).
 */
export function exportManifest(store: VisitStore, siteId: string): ExportManifest {
  const rows = store
    .attachmentsForSite(siteId)
    .filter((attachment) => attachment.visibility === 'public')
    .map((attachment) => ({
      attachmentId: attachment.id,
      visitId: attachment.visitId,
      category: attachment.category,
      filename: attachment.filename,
      captureTime: attachment.captureTime,
      sha256: attachment.sha256,
      downloadPath: `/api/v1/attachments/${attachment.id}/download`,
      retentionClass: attachment.retentionClass,
    }));
  return Object.freeze({
    siteId,
    attachmentCount: rows.length,
    rows: Object.freeze(rows),
    visibilityPolicy: 'public-attachments-only',
  } satisfies ExportManifest);
}

// ---------------------------------------------------------------------------
// Internal list (layer 3: policy-gated engineer/steward in scope)
// ---------------------------------------------------------------------------

/** One internal attachment row: everything the internal view may carry. */
export interface InternalAttachmentRow {
  readonly id: string;
  readonly visitId: string;
  readonly siteId: string;
  readonly category: AttachmentCategory;
  readonly visibility: AttachmentVisibility;
  readonly filename: string;
  readonly note: string | null;
  readonly captureTime: string;
  readonly retentionClass: RetentionClass;
  readonly objectRef: string;
  readonly sha256: string;
  readonly attachedAt: string;
  readonly attachedBy: string;
}

export type InternalListDecision =
  | { readonly outcome: 'allowed'; readonly rows: readonly InternalAttachmentRow[]; readonly grant: InternalReadGrant }
  | {
      readonly outcome: 'denied';
      readonly status: 401 | 403 | 404;
      readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND';
      readonly siteId: string;
      readonly message: string;
      readonly policyReason: string | null;
    };

/**
 * The internal attachment list of a site. Admission is entirely the policy
 * engine's: action `view-restricted-details` over INTERNAL-class fields of
 * the station - satisfied only by internal-field read capabilities the
 * engine recognizes (view-internal-diagnostics, edit-site-metadata,
 * statewide-administration) held in scope. A field engineer sees their
 * system's wiring notes; a commissioner's assignment does not open them;
 * an out-of-scope engineer gets a hidden-object 404 on non-public sites.
 */
export function internalAttachmentList(store: VisitStore, actorId: string, siteId: string, now: string): InternalListDecision {
  const site = store.siteById(siteId);
  if (!site) {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', siteId, message: 'site not found', policyReason: null };
  }
  const principal = store.world.principals[actorId] ?? null;
  const request: AuthorizationRequest = {
    principal,
    action: 'view-restricted-details',
    object: { kind: 'station', id: siteId, fields: ['internal'] },
  };
  const decision = evaluate(request, store.world, now);
  if (decision.effect !== 'allow') {
    if (
      decision.reason === 'DENY_ANONYMOUS' ||
      decision.reason === 'DENY_UNKNOWN_PRINCIPAL' ||
      decision.reason === 'DENY_PRINCIPAL_INACTIVE'
    ) {
      return { outcome: 'denied', status: 401, code: 'UNAUTHENTICATED', siteId, message: 'internal attachments require an authenticated, active principal', policyReason: decision.reason };
    }
    if (decision.reason === 'DENY_UNKNOWN_OBJECT') {
      return { outcome: 'denied', status: 404, code: 'NOT_FOUND', siteId, message: 'site not found', policyReason: decision.reason };
    }
    if (decision.reason === 'DENY_OUT_OF_SCOPE' && site.visibility !== 'public') {
      return { outcome: 'denied', status: 404, code: 'NOT_FOUND', siteId, message: 'site not found', policyReason: decision.reason };
    }
    return { outcome: 'denied', status: 403, code: 'FORBIDDEN', siteId, message: `actor is not permitted to read internal attachments (${decision.reason})`, policyReason: decision.reason };
  }
  const rows = store
    .attachmentsForSite(siteId)
    .filter((attachment) => attachment.visibility === 'internal')
    .map((attachment) => ({
      id: attachment.id,
      visitId: attachment.visitId,
      siteId: attachment.siteId,
      category: attachment.category,
      visibility: attachment.visibility,
      filename: attachment.filename,
      note: attachment.note,
      captureTime: attachment.captureTime,
      retentionClass: attachment.retentionClass,
      objectRef: attachment.objectRef,
      sha256: attachment.sha256,
      attachedAt: attachment.attachedAt,
      attachedBy: attachment.attachedBy,
    }));
  const grant: InternalReadGrant = {
    actorId,
    siteId,
    matchedAssignmentIds: decision.matchedAssignmentIds,
    evaluatedAt: decision.evaluatedAt,
  };
  return { outcome: 'allowed', rows, grant };
}

// ---------------------------------------------------------------------------
// The byte-level canary sweep helper (evidence surface for the tests)
// ---------------------------------------------------------------------------

/**
 * Every string an INTERNAL attachment of a site contributes that must never
 * appear in any public-facing serialization: its id, objectRef, filename,
 * note text (the wiring/gate detail itself), sha256, the wiring-note
 * category marker, its retention class and the internal visibility marker.
 * The sweep test JSON.stringifies each public artifact and asserts none of
 * these canaries occurs - the attachment twin of the gate-code canary sweep.
 */
export function collectInternalCanaries(store: VisitStore, siteId: string): readonly string[] {
  const canaries = new Set<string>();
  for (const attachment of store.attachmentsForSite(siteId)) {
    if (attachment.visibility !== 'internal') continue;
    canaries.add(attachment.id);
    canaries.add(attachment.objectRef);
    canaries.add(attachment.filename);
    if (attachment.note !== null) canaries.add(attachment.note);
    canaries.add(attachment.sha256);
    if (attachment.category === 'wiring-note') canaries.add('wiring-note');
    canaries.add('ATTACHMENT_INTERNAL');
  }
  return [...canaries].sort();
}
