/**
 * Fixture-backed append-only visit store (WD-012).
 *
 * Loads the frozen contract world (fixtures/contracts: stations, principals)
 * and keeps the per-site visit history. Invariants (FR-046/FR-049):
 *
 * - The visit history is APPEND-ONLY: entries are frozen records, never
 *   edited, reordered or removed. History therefore survives equipment
 *   replacement (WD-010 setup epochs only ever append) and actor
 *   deactivation (actorId stays resolvable via the policy engine).
 * - The structured lastChecked/lastRated dates are NOT stored state: the
 *   per-site summary is derived from the log on every read, so it can never
 *   disagree with the history it summarizes.
 * - Every append is one logical transaction: visit row + audit event +
 *   transactional-outbox publication-refresh event (ADR-10) land together
 *   or not at all. The outbox event lists PUBLIC attachment ids only.
 * - The idempotency ledger maps key -> body fingerprint -> recorded visit,
 *   so the retry of an unsent form can never double-append (the same key +
 *   same body replays the recorded visit; a different body is a 409 the
 *   workflow decides).
 * - No clock reads and no randomness: identifiers derive from the append
 *   sequence, so two runs with the same injected clock and the same
 *   operations produce byte-identical logs (see the determinism test).
 *
 * Attachment BYTES never enter this store: createVisit hands each
 * attachment to the storage interface (attachments.ts) which returns the
 * objectRef placeholder and the sha256 recorded at attach; the visit log
 * keeps only the reference and the metadata.
 */
import { readFileSync } from 'node:fs';
import { buildWorld, type PolicyWorld, type StationsFixture } from '../../../../../packages/policy/src/index.ts';
import type {
  Attachment,
  AttachmentCategory,
  AttachmentInput,
  AttachmentVisibility,
  CreateVisitInput,
  RetentionClass,
  SiteInspectionSummary,
  SiteRegistryRow,
  Visit,
  VisitActionId,
  VisitAuditEvent,
  VisitOutboxEvent,
} from './types.ts';

const FIXTURE_DIR = '../../../../../fixtures/contracts/';

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(FIXTURE_DIR + name, import.meta.url), 'utf8')) as T;
}

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}

/** Governed measurement/maintenance action vocabulary (FR-046). */
export const GOVERNED_VISIT_ACTIONS: readonly VisitActionId[] = [
  'measurement-taken',
  'gauge-inspection',
  'rating-verification',
  'equipment-maintenance',
  'sensor-replacement',
  'battery-replacement',
  'site-cleanup',
  'other',
];

/** Governed visit types (FR-046). */
export const GOVERNED_VISIT_TYPES: readonly string[] = ['inspection', 'maintenance', 'measurement', 'other'];

/** Governed attachment categories (FR-049). */
export const GOVERNED_ATTACHMENT_CATEGORIES: readonly string[] = ['photo', 'wiring-note', 'document', 'audio'];

/** Governed visibility marks (FR-049). */
export const GOVERNED_ATTACHMENT_VISIBILITIES: readonly string[] = ['public', 'internal'];

/** Governed retention classes (technical specification, attachment entity). */
export const GOVERNED_RETENTION_CLASSES: readonly string[] = ['standard', 'extended', 'permanent'];

/** Upper bound for the placeholder content payload (hashing input only). */
export const MAX_ATTACHMENT_PLACEHOLDER_BYTES = 50 * 1024 * 1024;

/** Default retention class per category when the uploader does not mark one. */
export const DEFAULT_RETENTION_CLASS: Readonly<Record<AttachmentCategory, RetentionClass>> = {
  photo: 'standard',
  'wiring-note': 'extended',
  document: 'standard',
  audio: 'extended',
};

/**
 * Canonical fingerprint of a visit body for idempotency comparison. The
 * workflow records the normalized body (trimmed notes, sorted actions), so
 * the replay fingerprint must normalize identically or a same-body retry
 * would 409 (same approach as the correction workflow).
 */
export function visitFingerprint(input: {
  siteId: string;
  visitTime: string;
  type: string;
  actionIds: readonly string[];
  notes: string;
  lastChecked: string | null;
  lastRated: string | null;
  attachments: ReadonlyArray<{
    category: string;
    visibility: string;
    filename: string;
    captureTime: string;
    retentionClass: string;
    sizeBytes: number;
    sha256: string;
  }>;
}): string {
  return JSON.stringify({
    siteId: input.siteId,
    visitTime: input.visitTime,
    type: input.type,
    actionIds: [...input.actionIds].slice().sort(),
    notes: input.notes,
    lastChecked: input.lastChecked,
    lastRated: input.lastRated,
    attachments: input.attachments.map((attachment) => ({
      category: attachment.category,
      visibility: attachment.visibility,
      filename: attachment.filename,
      captureTime: attachment.captureTime,
      retentionClass: attachment.retentionClass,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
    })),
  });
}

export interface AppendVisitRequest {
  readonly site: SiteRegistryRow;
  readonly actorId: string;
  readonly now: string;
  readonly idempotencyKey: string | null;
  /** Attachments already hashed by the storage interface at attach time. */
  readonly preparedAttachments: ReadonlyArray<Omit<Attachment, 'id' | 'visitId' | 'siteId' | 'attachedAt' | 'attachedBy'>>;
  /** The normalized input the workflow validated (for the idempotency ledger). */
  readonly normalized: Omit<Parameters<typeof visitFingerprint>[0], 'attachments'> & {
    attachments: ReadonlyArray<{
      category: string;
      visibility: string;
      filename: string;
      captureTime: string;
      retentionClass: string;
      sizeBytes: number;
      sha256: string;
    }>;
  };
  readonly input: CreateVisitInput;
}

export interface VisitStore {
  readonly world: PolicyWorld;
  readonly visits: readonly Visit[];
  readonly attachments: readonly Attachment[];
  readonly auditEvents: readonly VisitAuditEvent[];
  readonly outboxEvents: readonly VisitOutboxEvent[];

  /** A derived view sharing every mutable registry but a different policy snapshot (revocation tests). */
  withWorld(world: PolicyWorld): VisitStore;

  siteById(siteId: string): SiteRegistryRow | null;
  readonly sites: readonly SiteRegistryRow[];
  visitById(visitId: string): Visit | null;
  /** Per-site history in append order; never rewritten (FR-046). */
  visitsForSite(siteId: string): readonly Visit[];
  attachmentById(attachmentId: string): Attachment | null;
  attachmentsForSite(siteId: string): readonly Attachment[];

  /** Derived structured inspection state (FR-046: queryable, survives equipment replacement). */
  summaryFor(siteId: string): SiteInspectionSummary;
  /**
   * Structured-date query (FR-046): sites whose lastChecked is absent or
   * strictly before `since` - i.e. not inspected since X. Deterministic
   * order (sorted by site id).
   */
  sitesNotInspectedSince(since: string): ReadonlyArray<SiteRegistryRow & { lastChecked: string | null }>;

  isGovernedAction(id: string): boolean;

  /** Idempotency ledger lookup: recorded fingerprint + visit id for a key. */
  lookupIdempotency(key: string): { fingerprint: string; visitId: string; recordedAt: string } | null;

  /**
   * The single mutation path: appends visit + audit + outbox as one
   * transaction. No validation happens here (the workflow owns policy and
   * input checks); this function only maintains the structural invariants.
   */
  appendVisit(request: AppendVisitRequest): { visit: Visit; auditEvent: VisitAuditEvent; outboxEvent: VisitOutboxEvent };
}

interface FixtureStation {
  id: string;
  displayName: string;
  systemId: string;
  status: string;
  visibility: string;
}

export function createVisitStore(): VisitStore {
  const stationsFile = readFixture<{ stations: FixtureStation[] }>('stations.json');
  const principalsFile = readFixture<Parameters<typeof buildWorld>[0]['principals']>('principals.json');
  const world = buildWorld({ principals: principalsFile, stations: stationsFile as unknown as StationsFixture });

  const asStatus = (raw: string): SiteRegistryRow['status'] =>
    raw === 'proposed' || raw === 'inactive' || raw === 'retired' ? raw : 'active';
  const asVisibility = (raw: string): SiteRegistryRow['visibility'] =>
    raw === 'public' ? 'public' : raw === 'internal' ? 'internal' : 'restricted';

  // --- site registry (read-only fixture view) -------------------------------
  const sites: readonly SiteRegistryRow[] = Object.freeze(
    stationsFile.stations.map((station) =>
      freeze({
        id: station.id,
        displayName: station.displayName,
        systemId: station.systemId,
        status: asStatus(station.status),
        visibility: asVisibility(station.visibility),
      } satisfies SiteRegistryRow),
    ),
  );
  const siteById = new Map(sites.map((site) => [site.id, site]));

  // --- append-only visit log -------------------------------------------------
  const visits: Visit[] = [];
  const visitsBySite = new Map<string, Visit[]>();
  const visitById = new Map<string, Visit>();
  const attachments: Attachment[] = [];
  const attachmentById = new Map<string, Attachment>();
  const governedActions = new Set<string>(GOVERNED_VISIT_ACTIONS);
  const auditEvents: VisitAuditEvent[] = [];
  const outboxEvents: VisitOutboxEvent[] = [];
  const idempotencyLedger = new Map<string, { fingerprint: string; visitId: string; recordedAt: string }>();

  const summaryFor = (siteId: string): SiteInspectionSummary => {
    const history = visitsBySite.get(siteId) ?? [];
    let lastVisitTime: string | null = null;
    let lastChecked: string | null = null;
    let lastCheckedVisitId: string | null = null;
    let lastCheckedAtVisitTime = Number.NEGATIVE_INFINITY;
    let lastRated: string | null = null;
    let lastRatedVisitId: string | null = null;
    let lastRatedAtVisitTime = Number.NEGATIVE_INFINITY;
    for (const visit of history) {
      const at = Date.parse(visit.visitTime);
      // Structured dates advance by VISIT time, not append order: a
      // backdated visit must not post-date a later one (ties resolve to
      // the later append, matching the append-only reading order).
      if (lastVisitTime === null || at >= Date.parse(lastVisitTime)) {
        lastVisitTime = visit.visitTime;
      }
      if (visit.lastChecked !== null && at >= lastCheckedAtVisitTime) {
        lastChecked = visit.lastChecked;
        lastCheckedVisitId = visit.id;
        lastCheckedAtVisitTime = at;
      }
      if (visit.lastRated !== null && at >= lastRatedAtVisitTime) {
        lastRated = visit.lastRated;
        lastRatedVisitId = visit.id;
        lastRatedAtVisitTime = at;
      }
    }
    return freeze({
      siteId,
      visitCount: history.length,
      lastVisitTime,
      lastChecked,
      lastCheckedVisitId,
      lastRated,
      lastRatedVisitId,
    } satisfies SiteInspectionSummary);
  };

  const store: VisitStore = {
    world,
    withWorld(nextWorld) {
      return { ...store, world: nextWorld };
    },
    get visits() {
      return Object.freeze([...visits]);
    },
    get attachments() {
      return Object.freeze([...attachments]);
    },
    get auditEvents() {
      return Object.freeze([...auditEvents]);
    },
    get outboxEvents() {
      return Object.freeze([...outboxEvents]);
    },
    siteById(siteId: string) {
      return siteById.get(siteId) ?? null;
    },
    sites,
    visitById(visitId: string) {
      return visitById.get(visitId) ?? null;
    },
    visitsForSite(siteId: string) {
      return Object.freeze([...(visitsBySite.get(siteId) ?? [])]);
    },
    attachmentById(attachmentId: string) {
      return attachmentById.get(attachmentId) ?? null;
    },
    attachmentsForSite(siteId: string) {
      return Object.freeze(attachments.filter((attachment) => attachment.siteId === siteId));
    },
    summaryFor,
    sitesNotInspectedSince(since: string) {
      const boundary = Date.parse(since);
      const rows: Array<SiteRegistryRow & { lastChecked: string | null }> = [];
      for (const site of sites) {
        const lastChecked = summaryFor(site.id).lastChecked;
        const overdue = lastChecked === null || Date.parse(lastChecked) < boundary;
        if (overdue) rows.push({ ...site, lastChecked });
      }
      return Object.freeze(rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
    },
    isGovernedAction(id: string) {
      return governedActions.has(id);
    },
    lookupIdempotency(key: string) {
      return idempotencyLedger.get(key) ?? null;
    },
    appendVisit(request) {
      const before = summaryFor(request.site.id);
      const history = visitsBySite.get(request.site.id) ?? [];
      const sequence = history.length + 1;
      const visitOrdinal = visits.length + 1;
      const visitId = `visit-${String(1000 + visitOrdinal)}`;

      const visitAttachments: Attachment[] = request.preparedAttachments.map((prepared, index) => {
        const attachment = freeze({
          ...prepared,
          id: `att-${String(1000 + attachments.length + index + 1)}`,
          visitId,
          siteId: request.site.id,
          attachedAt: request.now,
          attachedBy: request.actorId,
        } satisfies Attachment);
        return attachment;
      });
      const frozenAttachments: readonly Attachment[] = Object.freeze([...visitAttachments]);

      const visit = freeze({
        id: visitId,
        siteId: request.site.id,
        actorId: request.actorId,
        visitTime: request.input.visitTime,
        recordedAt: request.now,
        type: request.input.type,
        actionIds: Object.freeze([...request.input.actionIds]) as readonly VisitActionId[],
        notes: request.input.notes ?? '',
        lastChecked: request.input.lastChecked ?? null,
        lastRated: request.input.lastRated ?? null,
        attachments: frozenAttachments,
        sequence,
      } satisfies Visit);

      history.push(visit);
      visitsBySite.set(request.site.id, history);
      visits.push(visit);
      visitById.set(visitId, visit);
      for (const attachment of frozenAttachments) {
        attachments.push(attachment);
        attachmentById.set(attachment.id, attachment);
      }

      const after = summaryFor(request.site.id);
      const correlationId = request.idempotencyKey ?? `corr-${String(1000 + auditEvents.length + 1)}`;
      const auditEvent = freeze({
        id: `visit-audit-${String(1000 + auditEvents.length + 1)}`,
        action: 'record-visit',
        actorId: request.actorId,
        siteId: request.site.id,
        visitId,
        before,
        after,
        attachmentCount: frozenAttachments.length,
        internalAttachmentCount: frozenAttachments.filter((attachment) => attachment.visibility === 'internal').length,
        recordedAt: request.now,
        correlationId,
      } satisfies VisitAuditEvent);
      const outboxEvent = freeze({
        id: `visit-outbox-${String(1000 + outboxEvents.length + 1)}`,
        type: 'publication-refresh',
        siteId: request.site.id,
        // INTERNAL attachment ids are never listed on the publication event.
        publicAttachmentIds: Object.freeze(
          frozenAttachments.filter((attachment) => attachment.visibility === 'public').map((attachment) => attachment.id),
        ),
        recordedAt: request.now,
        correlationId,
      } satisfies VisitOutboxEvent);
      auditEvents.push(auditEvent);
      outboxEvents.push(outboxEvent);
      if (request.idempotencyKey) {
        idempotencyLedger.set(request.idempotencyKey, {
          fingerprint: visitFingerprint(request.normalized),
          visitId,
          recordedAt: request.now,
        });
      }
      return { visit, auditEvent, outboxEvent };
    },
  };

  return store;
}
