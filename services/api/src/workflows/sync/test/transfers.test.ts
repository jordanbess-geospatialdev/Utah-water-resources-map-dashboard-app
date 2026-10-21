/**
 * Asset transfer tests (WD-012-R2, FR-048): evidence-bearing equipment
 * records, dated association close/open, and the HISTORY INTEGRITY rule -
 * "transferring an asset ... without moving historical inspections to the
 * wrong site" - proven against the REAL WD-012 visit workflow.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/sync/test/transfers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withEntitlement } from '../../../../../../packages/policy/src/index.ts';
import { createVisitStore } from '../../visits/store.ts';
import { createPlaceholderAttachmentStorage } from '../../visits/attachments.ts';
import { createVisit } from '../../visits/visits.ts';
import type { CreateVisitInput } from '../../visits/types.ts';
import { createSyncStore } from '../store.ts';
import {
  associationAt,
  associationPeriodsAtSite,
  equipmentAtSite,
  locationHistory,
  registerEquipment,
  transferEquipment,
} from '../transfers.ts';
import type { TransferEquipmentInput, TransferRejectedDecision } from '../types.ts';

const FATIMA = 'principal-fatima-engineer';
const PRIYA = 'principal-priya-engineer';
const CORINNE = 'sta-bear-corinne';
const HYRUM_PUBLIC = 'sta-hyrum-diversion-public';
const OGDEN_WEBER = 'sta-ogden-valley-proposed'; // sys-weber-river, restricted - outside Fatima's system

const NOW = '2026-04-01T16:00:00Z';

const EVIDENCE = {
  make: 'FlumeLog',
  model: '300',
  identifier: 'rtu-corinne-02',
  serial: 'FL300-2201-88',
  photoRefs: ['placeholder://attachments/eq-photo-1', 'placeholder://attachments/eq-photo-2'],
};

function registerAt(siteId: string, effectiveFrom = '2026-01-01T00:00:00Z') {
  const syncStore = createSyncStore();
  const decision = registerEquipment(syncStore, FATIMA, { ...EVIDENCE, initialSiteId: siteId, effectiveFrom }, { now: NOW });
  assert.equal(decision.outcome, 'applied', JSON.stringify(decision));
  if (decision.outcome !== 'applied') throw new Error('fixture registration failed');
  return { syncStore, equipment: decision.equipment };
}

function transferInput(equipmentId: string, fromSiteId: string, toSiteId: string, effectiveAt: string, evidence = EVIDENCE): TransferEquipmentInput {
  return {
    equipmentId,
    fromSiteId,
    toSiteId,
    effectiveAt,
    identifier: evidence.identifier,
    serial: evidence.serial,
  };
}

// ---------------------------------------------------------------------------
// Registration (the evidence record)
// ---------------------------------------------------------------------------

test('registration preserves make, model, identifier, serial and photo evidence', () => {
  const { syncStore, equipment } = registerAt(CORINNE);
  assert.equal(equipment.make, 'FlumeLog');
  assert.equal(equipment.model, '300');
  assert.equal(equipment.identifier, 'rtu-corinne-02');
  assert.equal(equipment.serial, 'FL300-2201-88');
  assert.deepEqual(equipment.photoRefs, EVIDENCE.photoRefs);
  assert.equal(syncStore.currentAssociation(equipment.id)!.siteId, CORINNE);
  assert.equal(syncStore.currentAssociation(equipment.id)!.effectiveFrom, '2026-01-01T00:00:00Z');
});

test('registration validation: missing evidence fields, duplicate identifier, unknown site', () => {
  const { syncStore, equipment } = registerAt(CORINNE);
  const missing = registerEquipment(syncStore, FATIMA, { ...EVIDENCE, serial: '   ', initialSiteId: HYRUM_PUBLIC, effectiveFrom: '2026-02-01T00:00:00Z' }, { now: NOW });
  assert.equal(missing.outcome, 'rejected');
  if (missing.outcome !== 'rejected') return;
  assert.equal(missing.code, 'VALIDATION_FAILED');
  assert.ok(missing.fieldErrors.some((error) => error.code === 'SERIAL_REQUIRED'));

  const duplicate = registerEquipment(syncStore, FATIMA, { ...EVIDENCE, initialSiteId: HYRUM_PUBLIC, effectiveFrom: '2026-02-01T00:00:00Z' }, { now: NOW });
  assert.equal(duplicate.outcome, 'rejected');
  if (duplicate.outcome !== 'rejected') return;
  assert.ok(duplicate.fieldErrors.some((error) => error.code === 'IDENTIFIER_TAKEN'));

  const unknownSite = registerEquipment(syncStore, FATIMA, { ...EVIDENCE, initialSiteId: 'sta-nope', effectiveFrom: '2026-02-01T00:00:00Z' }, { now: NOW });
  assert.equal((unknownSite as TransferRejectedDecision).code, 'NOT_FOUND');
  void equipment;
});

test('registration requires the site-edit capability within scope (an out-of-system engineer is refused)', () => {
  const syncStore = createSyncStore();
  // Priya is scoped to sys-weber-river; Corinne is a public Bear River site.
  const denied = registerEquipment(syncStore, PRIYA, { ...EVIDENCE, initialSiteId: CORINNE, effectiveFrom: '2026-01-01T00:00:00Z' }, { now: NOW });
  assert.equal(denied.outcome, 'rejected');
  if (denied.outcome !== 'rejected') return;
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'FORBIDDEN');
  assert.equal(denied.policyReason, 'DENY_OUT_OF_SCOPE');
});

// ---------------------------------------------------------------------------
// transfer(): dated close + open
// ---------------------------------------------------------------------------

test('transfer closes the old association and opens a dated new one at the boundary instant', () => {
  const { syncStore, equipment } = registerAt(CORINNE);
  const decision = transferEquipment(syncStore, FATIMA, transferInput(equipment.id, CORINNE, HYRUM_PUBLIC, '2026-04-01T00:00:00Z'), { now: NOW });
  assert.equal(decision.outcome, 'applied');
  if (decision.outcome !== 'applied') return;

  const history = locationHistory(syncStore, equipment.id);
  assert.equal(history.length, 2);
  const [closed, opened] = history;
  assert.equal(closed!.siteId, CORINNE);
  assert.equal(closed!.effectiveFrom, '2026-01-01T00:00:00Z');
  assert.equal(closed!.effectiveTo, '2026-04-01T00:00:00Z', 'old association CLOSED at the boundary');
  assert.equal(closed!.closedByTransferId, decision.transfer!.id);
  assert.equal(opened!.siteId, HYRUM_PUBLIC);
  assert.equal(opened!.effectiveFrom, '2026-04-01T00:00:00Z', 'new association DATED at the boundary');
  assert.equal(opened!.effectiveTo, null);
  assert.equal(opened!.openedByTransferId, decision.transfer!.id);
  // The transfer is audited with the full before/after timeline.
  assert.equal(decision.auditEvent.action, 'transfer-equipment');
  assert.equal(decision.auditEvent.before.length, 1);
  assert.equal(decision.auditEvent.after.length, 2);
  assert.equal(decision.auditEvent.effectiveAt, '2026-04-01T00:00:00Z');
});

test('the boundary instant belongs to the NEW association (half-open periods)', () => {
  const { syncStore, equipment } = registerAt(CORINNE);
  transferEquipment(syncStore, FATIMA, transferInput(equipment.id, CORINNE, HYRUM_PUBLIC, '2026-04-01T00:00:00Z'), { now: NOW });
  const eve = associationAt(syncStore, equipment.id, '2026-03-31T23:59:59Z');
  const boundary = associationAt(syncStore, equipment.id, '2026-04-01T00:00:00Z');
  assert.equal(eve!.siteId, CORINNE);
  assert.equal(boundary!.siteId, HYRUM_PUBLIC, 'at exactly the boundary the asset is at the new site');
});

test('evidence mismatch: a wrong serial never moves the asset', () => {
  const { syncStore, equipment } = registerAt(CORINNE);
  const wrongSerial = transferEquipment(syncStore, FATIMA, transferInput(equipment.id, CORINNE, HYRUM_PUBLIC, '2026-04-01T00:00:00Z', { ...EVIDENCE, serial: 'FL300-9999-00' }), { now: NOW });
  assert.equal(wrongSerial.outcome, 'rejected');
  if (wrongSerial.outcome !== 'rejected') return;
  assert.equal(wrongSerial.code, 'VALIDATION_FAILED');
  assert.ok(wrongSerial.fieldErrors.some((error) => error.code === 'EVIDENCE_MISMATCH'));
  assert.equal(syncStore.currentAssociation(equipment.id)!.siteId, CORINNE, 'nothing moved');
});

test('association mismatch and dating rules are enforced', () => {
  const { syncStore, equipment } = registerAt(CORINNE);

  const wrongFrom = transferEquipment(syncStore, FATIMA, transferInput(equipment.id, HYRUM_PUBLIC, CORINNE, '2026-04-01T00:00:00Z'), { now: NOW });
  assert.ok((wrongFrom as TransferRejectedDecision).fieldErrors?.some((error) => error.code === 'ASSOCIATION_MISMATCH'));

  const sameSite = transferEquipment(syncStore, FATIMA, transferInput(equipment.id, CORINNE, CORINNE, '2026-04-01T00:00:00Z'), { now: NOW });
  assert.ok((sameSite as TransferRejectedDecision).fieldErrors?.some((error) => error.code === 'SAME_SITE'));

  const backdated = transferEquipment(syncStore, FATIMA, transferInput(equipment.id, CORINNE, HYRUM_PUBLIC, '2026-01-01T00:00:00Z'), { now: NOW });
  assert.ok((backdated as TransferRejectedDecision).fieldErrors?.some((error) => error.code === 'EFFECTIVE_DATE_NOT_FORWARD'), 'never backdated over the open period');

  assert.equal(syncStore.associations.length, 1, 'no rejected transfer mutated the timeline');
});

test('an out-of-system destination site is hidden: NOT_FOUND for the outsider', () => {
  const { syncStore, equipment } = registerAt(CORINNE);
  // sta-ogden-valley-proposed is restricted and in sys-weber-river: for the
  // Bear River engineer it does not exist (the fixed hidden-object table).
  const denied = transferEquipment(syncStore, FATIMA, transferInput(equipment.id, CORINNE, OGDEN_WEBER, '2026-04-01T00:00:00Z'), { now: NOW });
  assert.equal(denied.outcome, 'rejected');
  if (denied.outcome !== 'rejected') return;
  assert.equal(denied.status, 404);
  assert.equal(denied.code, 'NOT_FOUND');
  assert.equal(syncStore.currentAssociation(equipment.id)!.siteId, CORINNE);
});

test('a revoked grant closes the door at transfer time', () => {
  const { syncStore, equipment } = registerAt(CORINNE);
  const revokedWorld = withEntitlement(syncStore.world, 'ent-engineer-fatima', { status: 'revoked' });
  const denied = transferEquipment(syncStore.withWorld(revokedWorld), FATIMA, transferInput(equipment.id, CORINNE, HYRUM_PUBLIC, '2026-04-01T00:00:00Z'), { now: NOW });
  assert.equal(denied.outcome, 'rejected');
  if (denied.outcome !== 'rejected') return;
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'FORBIDDEN');
  assert.equal(denied.policyReason, 'DENY_ASSIGNMENT_REVOKED', 'revocation is an assignment denial, not an identity one');
  assert.equal(syncStore.currentAssociation(equipment.id)!.siteId, CORINNE);
});

// ---------------------------------------------------------------------------
// HISTORY INTEGRITY (the FR-048 acceptance rule)
// ---------------------------------------------------------------------------

/** A valid WD-012 visit body for a site, at a given visit time. */
function visitBody(siteId: string, visitTime: string, note: string): CreateVisitInput {
  return {
    siteId,
    visitTime,
    type: 'inspection',
    actionIds: ['gauge-inspection'],
    notes: note,
    lastChecked: visitTime,
    lastRated: null,
    attachments: [],
  };
}

test('a pre-transfer visit NEVER appears in the new site\'s history (FR-048 integrity)', () => {
  const { syncStore, equipment } = registerAt(CORINNE);
  const visitStore = createVisitStore();
  const storage = createPlaceholderAttachmentStorage();

  // Pre-transfer inspection at Corinne (2026-03-12), while the RTU was there.
  const preTransfer = createVisit(visitStore, storage, FATIMA, visitBody(CORINNE, '2026-03-12T15:30:00Z', 'pre-transfer inspection at Corinne'), { now: '2026-03-12T16:00:00Z' });
  assert.equal(preTransfer.outcome, 'applied');

  // The transfer, effective 2026-04-01.
  const decision = transferEquipment(syncStore, FATIMA, transferInput(equipment.id, CORINNE, HYRUM_PUBLIC, '2026-04-01T00:00:00Z'), { now: NOW });
  assert.equal(decision.outcome, 'applied');

  // Post-transfer inspection at Hyrum (2026-04-02).
  const postTransfer = createVisit(visitStore, storage, FATIMA, visitBody(HYRUM_PUBLIC, '2026-04-02T15:30:00Z', 'post-transfer inspection at Hyrum'), { now: '2026-04-02T16:00:00Z' });
  assert.equal(postTransfer.outcome, 'applied');

  // The pre-transfer visit stays in CORINNE's history...
  const corinneHistory = visitStore.visitsForSite(CORINNE);
  assert.equal(corinneHistory.length, 1);
  assert.equal(corinneHistory[0]!.id, (preTransfer as { visit: { id: string } }).visit.id);
  // ...and NEVER appears in the new site's history.
  const hyrumHistory = visitStore.visitsForSite(HYRUM_PUBLIC);
  assert.equal(hyrumHistory.length, 1);
  assert.equal(hyrumHistory[0]!.id, (postTransfer as { visit: { id: string } }).visit.id);
  assert.ok(
    !hyrumHistory.some((visit) => visit.id === (preTransfer as { visit: { id: string } }).visit.id),
    'the pre-transfer visit was not moved to the wrong site',
  );
  // The equipment's location history explains WHY: it was at Corinne on
  // 2026-03-12 and at Hyrum on 2026-04-02.
  assert.equal(associationAt(syncStore, equipment.id, '2026-03-12T15:30:00Z')!.siteId, CORINNE);
  assert.equal(associationAt(syncStore, equipment.id, '2026-04-02T15:30:00Z')!.siteId, HYRUM_PUBLIC);
});

test('serial, photo and location history survive a chain of transfers (append-only timeline)', () => {
  const { syncStore, equipment } = registerAt(CORINNE);
  transferEquipment(syncStore, FATIMA, transferInput(equipment.id, CORINNE, HYRUM_PUBLIC, '2026-04-01T00:00:00Z'), { now: '2026-04-01T16:00:00Z' });
  transferEquipment(syncStore, FATIMA, transferInput(equipment.id, HYRUM_PUBLIC, CORINNE, '2026-07-01T00:00:00Z'), { now: '2026-07-01T16:00:00Z' });

  const history = locationHistory(syncStore, equipment.id);
  assert.deepEqual(
    history.map((row) => `${row.siteId} [${row.effectiveFrom} -> ${row.effectiveTo ?? 'open'}]`),
    [
      `${CORINNE} [2026-01-01T00:00:00Z -> 2026-04-01T00:00:00Z]`,
      `${HYRUM_PUBLIC} [2026-04-01T00:00:00Z -> 2026-07-01T00:00:00Z]`,
      `${CORINNE} [2026-07-01T00:00:00Z -> open]`,
    ],
  );
  // The first transfer's closed row was never rewritten by the second.
  assert.equal(history[0]!.closedByTransferId, syncStore.transfers[0]!.id);
  assert.equal(history[1]!.closedByTransferId, syncStore.transfers[1]!.id);
  assert.equal(history[2]!.openedByTransferId, syncStore.transfers[1]!.id);

  // Evidence survives the chain untouched.
  const record = syncStore.equipmentById(equipment.id)!;
  assert.equal(record.serial, EVIDENCE.serial);
  assert.deepEqual(record.photoRefs, EVIDENCE.photoRefs);

  // Site views: what was at Corinne in February vs June vs August.
  assert.deepEqual(equipmentAtSite(syncStore, CORINNE, '2026-02-15T00:00:00Z').map((row) => row.id), [equipment.id]);
  assert.deepEqual(equipmentAtSite(syncStore, CORINNE, '2026-06-15T00:00:00Z'), []);
  assert.deepEqual(equipmentAtSite(syncStore, CORINNE, '2026-08-15T00:00:00Z').map((row) => row.id), [equipment.id]);
  assert.deepEqual(equipmentAtSite(syncStore, HYRUM_PUBLIC, '2026-06-15T00:00:00Z').map((row) => row.id), [equipment.id]);

  // The per-site period view powers the panel's history tab.
  assert.equal(associationPeriodsAtSite(syncStore, CORINNE).length, 2);
  assert.equal(associationPeriodsAtSite(syncStore, HYRUM_PUBLIC).length, 1);

  // Every registration and transfer is audited, in order.
  assert.deepEqual(
    syncStore.transferAuditEvents.map((event) => event.action),
    ['register-equipment', 'transfer-equipment', 'transfer-equipment'],
  );
});
