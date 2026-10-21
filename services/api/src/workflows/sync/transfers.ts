/**
 * Asset inventory and transfers (WD-012-R2, FR-048).
 *
 * "Equipment records preserve make, model, identifier and serial-number
 * evidence; transferring an asset closes the old site association and
 * opens a dated new association without moving historical inspections to
 * the wrong site."
 *
 * Design (all exercised by the tests):
 * - An equipment record carries its evidence (make, model, identifier,
 *   serial, photo references); a transfer must CONFIRM the identifier and
 *   serial against the registered record, so an asset can never be moved
 *   on a tag misread (EVIDENCE_MISMATCH).
 * - Associations are EFFECTIVE-DATED and append-only, exactly like the
 *   WD-010 setup epochs: transfer() closes the open association at the
 *   boundary instant (effectiveTo = effectiveAt, closedByTransferId) and
 *   opens the new one at the same instant. Periods are half-open
 *   [from, to): at the boundary instant the equipment is already at the
 *   NEW site. No association row is ever edited or removed after the fact.
 * - Visits, inspections and readings NEVER move: they live in their own
 *   stores keyed by the site where they occurred (WD-012 append-only
 *   history); a transfer touches only the equipment's association tables.
 *   The integrity test proves a pre-transfer visit stays in the old
 *   site's history and never appears in the new site's.
 * - Authorization: the actor must hold the site-edit capability on BOTH
 *   stations (from and to) within their current assignment - an engineer
 *   scoped to one system can neither pull an asset out of another system
 *   nor push one into it (the policy engine evaluates both objects at the
 *   injected now; revocation closes the door at transfer time).
 * - Every registration and transfer appends an audit event with the
 *   equipment's full before/after association timeline.
 *
 * Check order per mutation: resolve -> policy -> validation -> apply +
 * audit. Pure module: store, actor, input and clock are injected.
 */
import { evaluate, type AuthorizationRequest, type Capability, type Decision as PolicyDecision } from '../../../../../packages/policy/src/index.ts';
import type { SyncStore } from './store.ts';
import type {
  EquipmentRecord,
  RegisterEquipmentInput,
  SiteAssociation,
  TransferAppliedDecision,
  TransferAuditEvent,
  TransferDecision,
  TransferEquipmentInput,
  TransferFieldError,
  TransferRejectedDecision,
} from './types.ts';

/** A transfer edits the site association of an asset: the site-edit capability, validated on BOTH sites. */
export const TRANSFER_CAPABILITY: Capability = 'edit-site-metadata';

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function fieldError(fieldPath: string, code: string, message: string): TransferFieldError {
  return { fieldPath, code, message };
}

function reject(
  status: TransferRejectedDecision['status'],
  code: TransferRejectedDecision['code'],
  message: string,
  fieldErrors: readonly TransferFieldError[] = [],
  policyReason: string | null = null,
): TransferRejectedDecision {
  return { outcome: 'rejected', status, code, message, fieldErrors, policyReason };
}

/** Policy denial -> API error mapping (the fixed hidden-object table shared with WD-010/WD-012). */
function policyRejection(policy: PolicyDecision, isPublicSite: boolean): TransferRejectedDecision {
  if (
    policy.reason === 'DENY_ANONYMOUS' ||
    policy.reason === 'DENY_UNKNOWN_PRINCIPAL' ||
    policy.reason === 'DENY_PRINCIPAL_INACTIVE'
  ) {
    return reject(401, 'UNAUTHENTICATED', 'asset transfers require an authenticated, active principal', [], policy.reason);
  }
  if (policy.reason === 'DENY_UNKNOWN_OBJECT') {
    return reject(404, 'NOT_FOUND', 'site not found', [], policy.reason);
  }
  if (policy.reason === 'DENY_OUT_OF_SCOPE' && !isPublicSite) {
    return reject(404, 'NOT_FOUND', 'site not found', [], policy.reason);
  }
  return reject(403, 'FORBIDDEN', `actor is not permitted to transfer assets between these sites (${policy.reason})`, [], policy.reason);
}

/** Evaluate the transfer capability on one station; null when allowed. */
function authorizeSite(syncStore: SyncStore, actorId: string, siteId: string, now: string): TransferRejectedDecision | null {
  const principal = syncStore.world.principals[actorId] ?? null;
  const request: AuthorizationRequest = {
    principal,
    action: TRANSFER_CAPABILITY,
    object: { kind: 'station', id: siteId },
  };
  const decision = evaluate(request, syncStore.world, now);
  if (decision.effect === 'allow') return null;
  const object = syncStore.world.objects[siteId];
  return policyRejection(decision, object?.visibility === 'public');
}

function siteExists(syncStore: SyncStore, siteId: string): boolean {
  return syncStore.world.objects[siteId] !== undefined;
}

// ---------------------------------------------------------------------------
// Registration (FR-048: the evidence record)
// ---------------------------------------------------------------------------

export function registerEquipment(
  syncStore: SyncStore,
  actorId: string,
  input: RegisterEquipmentInput,
  ctx: { readonly now: string },
): TransferDecision {
  // resolve + policy: the initial association site must be in scope.
  if (!siteExists(syncStore, input.initialSiteId)) {
    return reject(404, 'NOT_FOUND', 'site not found', [fieldError('initialSiteId', 'SITE_UNKNOWN', `site "${input.initialSiteId}" does not exist`)]);
  }
  const denied = authorizeSite(syncStore, actorId, input.initialSiteId, ctx.now);
  if (denied) return denied;

  const errors: TransferFieldError[] = [];
  for (const field of ['make', 'model', 'identifier', 'serial'] as const) {
    const value = input[field];
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(fieldError(field, `${field.toUpperCase()}_REQUIRED`, `${field} is required evidence (FR-048)`));
    }
  }
  if (syncStore.equipmentByIdentifier(input.identifier)) {
    errors.push(fieldError('identifier', 'IDENTIFIER_TAKEN', `identifier "${input.identifier}" is already registered on another equipment record`));
  }
  if (!Array.isArray(input.photoRefs) || input.photoRefs.some((ref) => typeof ref !== 'string' || ref.trim() === '')) {
    errors.push(fieldError('photoRefs', 'PHOTO_REFS_INVALID', 'photoRefs must be an array of non-empty object references'));
  }
  if (typeof input.effectiveFrom !== 'string' || !ISO_INSTANT.test(input.effectiveFrom) || Number.isNaN(Date.parse(input.effectiveFrom))) {
    errors.push(fieldError('effectiveFrom', 'EFFECTIVE_DATE_INVALID', 'effectiveFrom must be an ISO 8601 instant'));
  }
  if (errors.length > 0) {
    return reject(422, 'VALIDATION_FAILED', 'equipment registration failed validation; see fieldErrors', errors);
  }

  const id = `eq-${String(1000 + syncStore.equipment.length + 1)}`;
  const equipment = Object.freeze({
    id,
    make: input.make.trim(),
    model: input.model.trim(),
    identifier: input.identifier.trim(),
    serial: input.serial.trim(),
    photoRefs: Object.freeze([...input.photoRefs]),
    registeredAt: ctx.now,
    registeredBy: actorId,
    notes: input.notes ?? null,
  });
  const association: SiteAssociation = Object.freeze({
    equipmentId: id,
    siteId: input.initialSiteId,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: null,
    openedByTransferId: null,
    closedByTransferId: null,
  });
  const { auditEvent } = syncStore.recordEquipment({
    equipment,
    association,
    audit: {
      action: 'register-equipment',
      actorId,
      equipmentId: id,
      fromSiteId: null,
      toSiteId: input.initialSiteId,
      effectiveAt: input.effectiveFrom,
      before: [],
      after: [association],
      recordedAt: ctx.now,
    },
  });
  return { outcome: 'applied', code: 'OK', transfer: null, equipment, associations: [association], auditEvent } satisfies TransferAppliedDecision;
}

// ---------------------------------------------------------------------------
// transfer() (FR-048: close old, open new, dated; history never moves)
// ---------------------------------------------------------------------------

export function transferEquipment(
  syncStore: SyncStore,
  actorId: string,
  input: TransferEquipmentInput,
  ctx: { readonly now: string },
): TransferDecision {
  // 1. resolve the equipment and both sites.
  const equipment = syncStore.equipmentById(input.equipmentId);
  if (!equipment) {
    return reject(404, 'NOT_FOUND', 'equipment not found', [fieldError('equipmentId', 'EQUIPMENT_UNKNOWN', `equipment "${input.equipmentId}" is not registered`)]);
  }
  if (!siteExists(syncStore, input.fromSiteId) || !siteExists(syncStore, input.toSiteId)) {
    return reject(404, 'NOT_FOUND', 'site not found', [
      ...(siteExists(syncStore, input.fromSiteId) ? [] : [fieldError('fromSiteId', 'SITE_UNKNOWN', `site "${input.fromSiteId}" does not exist`)]),
      ...(siteExists(syncStore, input.toSiteId) ? [] : [fieldError('toSiteId', 'SITE_UNKNOWN', `site "${input.toSiteId}" does not exist`)]),
    ]);
  }

  // 2. policy on BOTH sites (an out-of-system site does not exist for the
  //    outsider unless public; the engine decides, this maps).
  const deniedFrom = authorizeSite(syncStore, actorId, input.fromSiteId, ctx.now);
  if (deniedFrom) return deniedFrom;
  const deniedTo = authorizeSite(syncStore, actorId, input.toSiteId, ctx.now);
  if (deniedTo) return deniedTo;

  // 3. validation: evidence, association state, dating.
  const current = syncStore.currentAssociation(input.equipmentId);
  const errors: TransferFieldError[] = [];
  if (input.identifier !== equipment.identifier || input.serial !== equipment.serial) {
    errors.push(
      fieldError(
        'serial',
        'EVIDENCE_MISMATCH',
        `the confirmed evidence (identifier "${input.identifier}", serial "${input.serial}") does not match the registered record (identifier "${equipment.identifier}", serial "${equipment.serial}"); an asset transfer requires the serial-number evidence to agree`,
      ),
    );
  }
  if (!current) {
    errors.push(fieldError('equipmentId', 'NO_OPEN_ASSOCIATION', 'the equipment has no open site association to transfer'));
  } else {
    if (current.siteId !== input.fromSiteId) {
      errors.push(
        fieldError(
          'fromSiteId',
          'ASSOCIATION_MISMATCH',
          `the equipment's open association is site "${current.siteId}" (since ${current.effectiveFrom}), not "${input.fromSiteId}"`,
        ),
      );
    }
    if (typeof input.effectiveAt !== 'string' || !ISO_INSTANT.test(input.effectiveAt) || Number.isNaN(Date.parse(input.effectiveAt))) {
      errors.push(fieldError('effectiveAt', 'EFFECTIVE_DATE_INVALID', 'effectiveAt must be an ISO 8601 instant'));
    } else if (!(Date.parse(input.effectiveAt) > Date.parse(current.effectiveFrom))) {
      errors.push(
        fieldError(
          'effectiveAt',
          'EFFECTIVE_DATE_NOT_FORWARD',
          `effectiveAt must be after the open association's start ${current.effectiveFrom}; associations are effective-dated forward and never overlap or collapse`,
        ),
      );
    }
  }
  if (input.fromSiteId === input.toSiteId) {
    errors.push(fieldError('toSiteId', 'SAME_SITE', 'the destination site must differ from the current site'));
  }
  if (errors.length > 0) {
    return reject(422, 'VALIDATION_FAILED', 'asset transfer failed validation; see fieldErrors', errors);
  }
  if (!current) {
    // Unreachable (validation above rejects a missing open association);
    // kept so the applied branch below never sees a nullable row.
    return reject(409, 'ASSOCIATION_MISMATCH', 'the equipment has no open site association to transfer');
  }

  // 4. apply: CLOSE the old association, OPEN the new one, at the boundary.
  const transferId = `xfer-${String(1000 + syncStore.transfers.length + 1)}`;
  const transfer = Object.freeze({
    id: transferId,
    equipmentId: equipment.id,
    fromSiteId: input.fromSiteId,
    toSiteId: input.toSiteId,
    effectiveAt: input.effectiveAt,
    confirmedIdentifier: input.identifier,
    confirmedSerial: input.serial,
    transferredBy: actorId,
    recordedAt: ctx.now,
  });
  const before = syncStore.associationsForEquipment(equipment.id);
  const closed: SiteAssociation = Object.freeze({
    ...current,
    effectiveTo: input.effectiveAt,
    closedByTransferId: transferId,
  });
  const opened: SiteAssociation = Object.freeze({
    equipmentId: equipment.id,
    siteId: input.toSiteId,
    effectiveFrom: input.effectiveAt,
    effectiveTo: null,
    openedByTransferId: transferId,
    closedByTransferId: null,
  });
  const { auditEvent } = syncStore.applyTransfer({
    transfer,
    closeAssociation: closed,
    openAssociation: opened,
    audit: {
      action: 'transfer-equipment',
      actorId,
      equipmentId: equipment.id,
      fromSiteId: input.fromSiteId,
      toSiteId: input.toSiteId,
      effectiveAt: input.effectiveAt,
      before,
      after: syncStoreAssociationsAfter(syncStore, equipment.id, closed, opened),
      recordedAt: ctx.now,
    },
  });
  return {
    outcome: 'applied',
    code: 'OK',
    transfer,
    equipment,
    associations: syncStore.associationsForEquipment(equipment.id),
    auditEvent,
  } satisfies TransferAppliedDecision;
}

/** The equipment's timeline after replacing the open row with (closed, opened). */
function syncStoreAssociationsAfter(
  syncStore: SyncStore,
  equipmentId: string,
  closed: SiteAssociation,
  opened: SiteAssociation,
): readonly SiteAssociation[] {
  return syncStore.associationsForEquipment(equipmentId).map((row) => (row.effectiveTo === null ? closed : row)).concat([opened]);
}

// ---------------------------------------------------------------------------
// History reads (FR-048: association periods, location history)
// ---------------------------------------------------------------------------

/** The equipment's location history: association periods ordered by effectiveFrom. */
export function locationHistory(syncStore: SyncStore, equipmentId: string): readonly SiteAssociation[] {
  return [...syncStore.associationsForEquipment(equipmentId)].sort((left, right) =>
    Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom) || (left.siteId < right.siteId ? -1 : 1),
  );
}

/** The association covering `at` (half-open [from, to)); the boundary belongs to the NEW period. */
export function associationAt(syncStore: SyncStore, equipmentId: string, at: string): SiteAssociation | null {
  return locationHistory(syncStore, equipmentId).find((association) => {
    if (Date.parse(at) < Date.parse(association.effectiveFrom)) return false;
    if (association.effectiveTo !== null && Date.parse(at) >= Date.parse(association.effectiveTo)) return false;
    return true;
  }) ?? null;
}

/** Equipment records associated with a site at `at` (site-history view, FR-048). */
export function equipmentAtSite(syncStore: SyncStore, siteId: string, at: string): readonly EquipmentRecord[] {
  const equipmentIds = new Set(
    syncStore.associations
      .filter((association) => association.siteId === siteId)
      .filter((association) => {
        if (Date.parse(at) < Date.parse(association.effectiveFrom)) return false;
        if (association.effectiveTo !== null && Date.parse(at) >= Date.parse(association.effectiveTo)) return false;
        return true;
      })
      .map((association) => association.equipmentId),
  );
  return syncStore.equipment.filter((record) => equipmentIds.has(record.id));
}

/** Every association period at one site, ordered (the panel's history view). */
export function associationPeriodsAtSite(syncStore: SyncStore, siteId: string): readonly SiteAssociation[] {
  return [...syncStore.associations]
    .filter((association) => association.siteId === siteId)
    .sort((left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom));
}
