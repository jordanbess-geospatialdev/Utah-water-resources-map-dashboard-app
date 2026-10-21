/**
 * Fixture-backed sync-domain store (WD-012-R2): the idempotency ledger,
 * quota counters, site-revision registry, sync audit log and the FR-048
 * equipment registry (records, effective-dated site associations,
 * transfers, transfer audit).
 *
 * Invariants (mirroring WD-011/WD-010/WD-012 stores):
 * - The sync ledger maps idempotency key -> TERMINAL verdict (accepted or
 *   rejected). Replaying a key returns the recorded verdict, so a client
 *   that never saw the first response observes history, not a re-decision.
 *   Conflict and quota verdicts are NOT ledgered: nothing committed, so a
 *   later legitimate retry (a revised draft, a reopened quota window) may
 *   still succeed under the same key.
 * - Site revisions for VISIT drafts mirror the sites workflow's optimistic
 *   site version (WD-010): seeded from the fixture station version and
 *   bumped by applySiteChange (the documented mirror of a site edit). The
 *   revision for READING drafts is authoritative in the readings store
 *   (streamSetupVersion, WD-010 setup epochs) and is read there directly.
 * - The equipment association timeline is append-only: a transfer closes
 *   the open association (effectiveTo = boundary) and opens the new one;
 *   no row is ever edited or removed, so historical inspections and visits
 *   can never be moved to the wrong site (FR-048).
 * - Quota counters are keyed (actor, UTC day derived from the injected
 *   now) - no clock reads, no randomness; identical operation sequences
 *   produce byte-identical logs (see the determinism test).
 */
import { readFileSync } from 'node:fs';
import { buildWorld, type PolicyWorld, type StationsFixture } from '../../../../../packages/policy/src/index.ts';
import type {
  EquipmentRecord,
  OfflineDraftKind,
  SiteAssociation,
  SyncAuditEvent,
  SyncLedgerEntry,
  SyncVerdict,
  TransferAuditEvent,
  TransferRecord,
} from './types.ts';

const FIXTURE_DIR = '../../../../../fixtures/contracts/';

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(FIXTURE_DIR + name, import.meta.url), 'utf8')) as T;
}

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}

/** Default per-actor daily budget of accepted offline drafts (configurable for tests). */
export const DEFAULT_PER_ACTOR_DAILY_SYNC_QUOTA = 500;

export interface SyncStore {
  readonly world: PolicyWorld;
  /** Derived view sharing every mutable registry but a different policy snapshot (revocation tests). */
  withWorld(world: PolicyWorld): SyncStore;

  // --- idempotency ledger ---------------------------------------------------
  lookupLedger(idempotencyKey: string): SyncLedgerEntry | null;
  readonly ledgerEntries: readonly SyncLedgerEntry[];
  recordLedger(entry: SyncLedgerEntry): void;

  // --- audit ----------------------------------------------------------------
  readonly syncAuditEvents: readonly SyncAuditEvent[];
  appendSyncAudit(event: Omit<SyncAuditEvent, 'id' | 'sequence'>): SyncAuditEvent;

  // --- quota ----------------------------------------------------------------
  /** Accepted drafts charged against the actor's quota for the UTC day of `now`. */
  quotaUsed(actorId: string, now: string): number;
  chargeQuota(actorId: string, now: string): void;
  readonly perActorDailySyncQuota: number;

  // --- site revision registry (visit-draft conflict basis) ------------------
  siteRevision(siteId: string): number;
  /**
   * The documented mirror of a WD-010 site edit: bumps the site's revision
   * so an offline visit draft captured against the older revision conflicts
   * at sync time. Returns the new revision.
   */
  applySiteChange(siteId: string): number;

  // --- equipment registry (FR-048) -------------------------------------------
  readonly equipment: readonly EquipmentRecord[];
  equipmentById(equipmentId: string): EquipmentRecord | null;
  equipmentByIdentifier(identifier: string): EquipmentRecord | null;
  readonly associations: readonly SiteAssociation[];
  associationsForEquipment(equipmentId: string): readonly SiteAssociation[];
  /** The currently open association of an equipment record, or null. */
  currentAssociation(equipmentId: string): SiteAssociation | null;
  recordEquipment(request: {
    equipment: EquipmentRecord;
    association: SiteAssociation;
    audit: Omit<TransferAuditEvent, 'id' | 'sequence'>;
  }): { equipment: EquipmentRecord; association: SiteAssociation; auditEvent: TransferAuditEvent };
  applyTransfer(request: {
    transfer: TransferRecord;
    closeAssociation: SiteAssociation;
    openAssociation: SiteAssociation;
    audit: Omit<TransferAuditEvent, 'id' | 'sequence'>;
  }): { transfer: TransferRecord; closed: SiteAssociation; opened: SiteAssociation; auditEvent: TransferAuditEvent };
  readonly transfers: readonly TransferRecord[];
  transferById(transferId: string): TransferRecord | null;
  readonly transferAuditEvents: readonly TransferAuditEvent[];
}

interface FixtureStation {
  readonly id: string;
  readonly displayName: string;
  readonly systemId: string;
  readonly status: string;
  readonly visibility: string;
  readonly version: number;
}

export function createSyncStore(options: { perActorDailySyncQuota?: number } = {}): SyncStore {
  const stationsFile = readFixture<{ stations: FixtureStation[] }>('stations.json');
  const principalsFile = readFixture<Parameters<typeof buildWorld>[0]['principals']>('principals.json');
  const world = buildWorld({ principals: principalsFile, stations: stationsFile as unknown as StationsFixture });

  const ledger = new Map<string, SyncLedgerEntry>();
  const ledgerOrder: string[] = [];
  const syncAudit: SyncAuditEvent[] = [];
  const quotaByActorDay = new Map<string, number>();
  const siteRevisions = new Map<string, number>(stationsFile.stations.map((station) => [station.id, station.version]));

  const equipment = new Map<string, EquipmentRecord>();
  const equipmentOrder: string[] = [];
  const associations: SiteAssociation[] = [];
  const transfers = new Map<string, TransferRecord>();
  const transferOrder: string[] = [];
  const transferAudit: TransferAuditEvent[] = [];

  const store: SyncStore = {
    perActorDailySyncQuota: options.perActorDailySyncQuota ?? DEFAULT_PER_ACTOR_DAILY_SYNC_QUOTA,
    world,
    withWorld(nextWorld) {
      return { ...store, world: nextWorld };
    },
    lookupLedger(idempotencyKey) {
      return ledger.get(idempotencyKey) ?? null;
    },
    get ledgerEntries() {
      return Object.freeze(ledgerOrder.map((key) => ledger.get(key)).filter((entry): entry is SyncLedgerEntry => entry !== undefined));
    },
    recordLedger(entry) {
      if (!ledger.has(entry.idempotencyKey)) ledgerOrder.push(entry.idempotencyKey);
      ledger.set(entry.idempotencyKey, freeze({ ...entry }));
    },
    get syncAuditEvents() {
      return Object.freeze([...syncAudit]);
    },
    appendSyncAudit(event) {
      const record = freeze({
        ...event,
        id: `sync-audit-${String(1000 + syncAudit.length + 1)}`,
        sequence: syncAudit.length + 1,
      } satisfies SyncAuditEvent);
      syncAudit.push(record);
      return record;
    },
    quotaUsed(actorId, now) {
      return quotaByActorDay.get(`${actorId}|${now.slice(0, 10)}`) ?? 0;
    },
    chargeQuota(actorId, now) {
      const key = `${actorId}|${now.slice(0, 10)}`;
      quotaByActorDay.set(key, (quotaByActorDay.get(key) ?? 0) + 1);
    },
    siteRevision(siteId) {
      return siteRevisions.get(siteId) ?? 0;
    },
    applySiteChange(siteId) {
      const current = siteRevisions.get(siteId);
      if (current === undefined) throw new Error(`applySiteChange: unknown site "${siteId}"`);
      const next = current + 1;
      siteRevisions.set(siteId, next);
      return next;
    },
    get equipment() {
      return Object.freeze(equipmentOrder.map((id) => equipment.get(id)).filter((row): row is EquipmentRecord => row !== undefined));
    },
    equipmentById(equipmentId) {
      return equipment.get(equipmentId) ?? null;
    },
    equipmentByIdentifier(identifier) {
      return equipmentOrder.map((id) => equipment.get(id)).find((row) => row?.identifier === identifier) ?? null;
    },
    get associations() {
      return Object.freeze([...associations]);
    },
    associationsForEquipment(equipmentId) {
      return Object.freeze(associations.filter((row) => row.equipmentId === equipmentId));
    },
    currentAssociation(equipmentId) {
      return associations.find((row) => row.equipmentId === equipmentId && row.effectiveTo === null) ?? null;
    },
    recordEquipment(request) {
      equipment.set(request.equipment.id, freeze(request.equipment));
      equipmentOrder.push(request.equipment.id);
      associations.push(freeze(request.association));
      const auditEvent = freeze({
        ...request.audit,
        id: `xfer-audit-${String(1000 + transferAudit.length + 1)}`,
        sequence: transferAudit.length + 1,
      } satisfies TransferAuditEvent);
      transferAudit.push(auditEvent);
      return { equipment: request.equipment, association: request.association, auditEvent };
    },
    applyTransfer(request) {
      const closedIndex = associations.findIndex((row) => row.equipmentId === request.closeAssociation.equipmentId && row.effectiveTo === null);
      if (closedIndex < 0) throw new Error('applyTransfer: no open association to close');
      associations[closedIndex] = freeze(request.closeAssociation);
      associations.push(freeze(request.openAssociation));
      transfers.set(request.transfer.id, freeze(request.transfer));
      transferOrder.push(request.transfer.id);
      const auditEvent = freeze({
        ...request.audit,
        id: `xfer-audit-${String(1000 + transferAudit.length + 1)}`,
        sequence: transferAudit.length + 1,
      } satisfies TransferAuditEvent);
      transferAudit.push(auditEvent);
      return { transfer: request.transfer, closed: request.closeAssociation, opened: request.openAssociation, auditEvent };
    },
    get transfers() {
      return Object.freeze(transferOrder.map((id) => transfers.get(id)).filter((row): row is TransferRecord => row !== undefined));
    },
    transferById(transferId) {
      return transfers.get(transferId) ?? null;
    },
    get transferAuditEvents() {
      return Object.freeze([...transferAudit]);
    },
  };

  return store;
}

/** The UTC day of an injected instant (quota bucket key derivation, shared with tests). */
export function utcDayOf(now: string): string {
  return now.slice(0, 10);
}

/** Deterministic retry-after for a quota verdict: the next UTC midnight after `now` (second precision). */
export function nextUtcMidnight(now: string): string {
  const day = utcDayOf(now);
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000);
  return `${next.toISOString().slice(0, 19)}Z`;
}

/**
 * Half-open association containment: [effectiveFrom, effectiveTo). The
 * boundary instant belongs to the NEW association (a transfer at T closes
 * the old period at T and opens the new one at T).
 */
export function associationCovers(association: SiteAssociation, at: string): boolean {
  if (Date.parse(at) < Date.parse(association.effectiveFrom)) return false;
  if (association.effectiveTo !== null && Date.parse(at) >= Date.parse(association.effectiveTo)) return false;
  return true;
}

/** Verdict kind helper used by the audit trail narration. */
export function verdictOutcome(verdict: SyncVerdict, replayed: boolean): 'accepted' | 'replayed' | 'conflict' | 'rejected' | 'quota' {
  if (verdict.kind === 'accepted') return replayed ? 'replayed' : 'accepted';
  if (verdict.kind === 'conflict') return 'conflict';
  if (verdict.kind === 'rejected') return 'rejected';
  return 'quota';
}

/** Narrow helper: does this draft kind target a stream (readings) or a site (visits)? */
export function targetOf(request: { kind: OfflineDraftKind; streamId: string | null; siteId: string }): string {
  return request.kind === 'reading' ? (request.streamId ?? '') : request.siteId;
}
