/**
 * Determinism tests (WD-012-R2): the full offline-sync + asset-transfer
 * scenario, run TWICE from pristine stores with the same injected clock,
 * produces byte-identical logs - observations, audits, visits, sync
 * verdicts/ledger, equipment registry, association timeline, transfers and
 * transfer audits. No clock reads, no randomness anywhere in the domain.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/sync/test/determinism.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReadingsStore } from '../../readings/store.ts';
import { createVisitStore } from '../../visits/store.ts';
import { createPlaceholderAttachmentStorage } from '../../visits/attachments.ts';
import { createSyncStore } from '../store.ts';
import { acceptDrafts, type SyncDeps } from '../accept.ts';
import { registerEquipment, transferEquipment } from '../transfers.ts';
import type { OfflineSyncRequest } from '../types.ts';

const FATIMA = 'principal-fatima-engineer';
const SITE = 'sta-bear-corinne';
const OTHER = 'sta-hyrum-diversion-public';
const STREAM = 'str-corinne-q';

function readingRequest(draftId: string, observedAt: string, baseRevision: number): OfflineSyncRequest {
  return {
    draftId,
    idempotencyKey: `offline-reading-${draftId}`,
    actorId: FATIMA,
    kind: 'reading',
    siteId: SITE,
    streamId: STREAM,
    deviceTimestamp: '2026-03-12T15:30:00Z',
    deviceZone: 'America/Denver',
    captureTime: observedAt,
    baseRevision,
    attachments: [],
    payload: { streamId: STREAM, observedAt, value: 21.5, unitId: 'cfs', note: 'airplane-mode capture' },
  };
}

function visitRequest(draftId: string, visitTime: string, baseRevision: number): OfflineSyncRequest {
  return {
    draftId,
    idempotencyKey: `offline-visit-${draftId}`,
    actorId: FATIMA,
    kind: 'visit',
    siteId: SITE,
    streamId: null,
    deviceTimestamp: '2026-03-12T15:40:00Z',
    deviceZone: 'America/Denver',
    captureTime: visitTime,
    baseRevision,
    attachments: [],
    payload: {
      siteId: SITE,
      visitTime,
      type: 'inspection',
      actionIds: ['gauge-inspection'],
      notes: 'offline inspection',
      lastChecked: visitTime,
      lastRated: null,
      attachments: [],
    },
  };
}

/** The whole WD-012-R2 scenario; returns every log the domain produces. */
function runScenario(): string {
  const readingsStore = createReadingsStore();
  const visitStore = createVisitStore();
  const syncStore = createSyncStore({ perActorDailySyncQuota: 5 });
  const deps: SyncDeps = { syncStore, readingsStore, visitStore, attachmentStorage: createPlaceholderAttachmentStorage() };

  // Sync batch 1: two readings + one visit; one draft conflicts (setup
  // changed server-side), one replay of an earlier commit.
  const batch1 = acceptDrafts(
    deps,
    FATIMA,
    [readingRequest('d-1', '2026-03-12T15:15:00Z', 12), readingRequest('d-2', '2026-03-12T15:20:00Z', 12), visitRequest('d-3', '2026-03-12T15:30:00Z', 12)],
    { now: '2026-03-12T18:00:00Z' },
  );
  readingsStore.applyStreamSetupChange(STREAM); // setup epoch: 12 -> 13
  const batch2 = acceptDrafts(deps, FATIMA, [readingRequest('d-4', '2026-03-12T15:25:00Z', 12)], { now: '2026-03-12T18:30:00Z' });
  const batch3 = acceptDrafts(
    deps,
    FATIMA,
    [readingRequest('d-1', '2026-03-12T15:15:00Z', 12), readingRequest('d-4', '2026-03-12T15:25:00Z', 13)],
    { now: '2026-03-12T19:00:00Z' },
  );

  // Asset transfers: register, transfer, transfer back.
  const registered = registerEquipment(
    syncStore,
    FATIMA,
    { make: 'FlumeLog', model: '300', identifier: 'rtu-corinne-02', serial: 'FL300-2201-88', photoRefs: ['placeholder://attachments/eq-1'], initialSiteId: SITE, effectiveFrom: '2026-01-01T00:00:00Z' },
    { now: '2026-03-12T20:00:00Z' },
  );
  if (registered.outcome !== 'applied') throw new Error('registration failed in scenario');
  transferEquipment(syncStore, FATIMA, { equipmentId: registered.equipment.id, fromSiteId: SITE, toSiteId: OTHER, effectiveAt: '2026-04-01T00:00:00Z', identifier: 'rtu-corinne-02', serial: 'FL300-2201-88' }, { now: '2026-04-01T16:00:00Z' });
  transferEquipment(syncStore, FATIMA, { equipmentId: registered.equipment.id, fromSiteId: OTHER, toSiteId: SITE, effectiveAt: '2026-07-01T00:00:00Z', identifier: 'rtu-corinne-02', serial: 'FL300-2201-88' }, { now: '2026-07-01T16:00:00Z' });

  return JSON.stringify({
    batch1: batch1.verdicts,
    batch2: batch2.verdicts,
    batch3: batch3.verdicts,
    observations: readingsStore.observations,
    entryAudits: readingsStore.auditEvents,
    visits: visitStore.visits,
    visitAudits: visitStore.auditEvents,
    syncAudits: syncStore.syncAuditEvents,
    ledger: syncStore.ledgerEntries,
    equipment: syncStore.equipment,
    associations: syncStore.associations,
    transfers: syncStore.transfers,
    transferAudits: syncStore.transferAuditEvents,
  });
}

test('the full scenario run twice produces byte-identical logs', () => {
  const first = runScenario();
  const second = runScenario();
  assert.equal(first, second);
});

test('the scenario produces the expected verdict mix (not vacuously deterministic)', () => {
  const readingsStore = createReadingsStore();
  const visitStore = createVisitStore();
  const syncStore = createSyncStore({ perActorDailySyncQuota: 5 });
  const deps: SyncDeps = { syncStore, readingsStore, visitStore, attachmentStorage: createPlaceholderAttachmentStorage() };
  const batch1 = acceptDrafts(deps, FATIMA, [readingRequest('d-1', '2026-03-12T15:15:00Z', 12), visitRequest('d-3', '2026-03-12T15:30:00Z', 12)], { now: '2026-03-12T18:00:00Z' });
  assert.deepEqual(
    batch1.verdicts.map((verdict) => verdict.kind),
    ['accepted', 'accepted'],
  );
  readingsStore.applyStreamSetupChange(STREAM);
  const conflict = acceptDrafts(deps, FATIMA, [readingRequest('d-4', '2026-03-12T15:25:00Z', 12)], { now: '2026-03-12T18:30:00Z' });
  assert.equal(conflict.verdicts[0]!.kind, 'conflict');
  const replay = acceptDrafts(deps, FATIMA, [readingRequest('d-1', '2026-03-12T15:15:00Z', 12)], { now: '2026-03-12T19:00:00Z' });
  assert.equal(replay.verdicts[0]!.kind, 'accepted');
  assert.equal((replay.verdicts[0] as { replayed: boolean }).replayed, true);
});
