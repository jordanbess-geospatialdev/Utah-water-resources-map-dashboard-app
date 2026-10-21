/**
 * WD-012 determinism test: the whole scenario runs twice against fresh
 * stores and the serialized visit log, audit log, outbox log and idempotency
 * ledger must be byte-identical. No clock reads, no randomness: identifiers
 * derive from append sequences and every timestamp is an injected constant.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/visits/test/determinism.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVisitStore } from '../store.ts';
import { createPlaceholderAttachmentStorage, exportManifest, internalAttachmentList } from '../attachments.ts';
import { createVisit } from '../visits.ts';
import { initialVisitDraft, submitVisitDraft } from '../unsent.ts';
import type { CreateVisitInput } from '../types.ts';

const FATIMA = 'principal-fatima-engineer';
const DIEGO = 'principal-diego-steward';
const CORINNE = 'sta-bear-corinne';
const HYRUM_PUBLIC = 'sta-hyrum-diversion-public';
const NOW = '2026-03-12T16:00:00Z';

async function scenarioRun(): Promise<string> {
  const store = createVisitStore();
  const storage = createPlaceholderAttachmentStorage();

  const first: CreateVisitInput = {
    siteId: CORINNE,
    visitTime: '2026-03-12T15:30:00Z',
    type: 'inspection',
    actionIds: ['gauge-inspection', 'measurement-taken'],
    notes: 'Annual inspection.',
    lastChecked: '2026-03-12T15:00:00Z',
    lastRated: null,
    attachments: [
      { category: 'photo', visibility: 'public', filename: 'plate.jpg', captureTime: '2026-03-12T15:10:00Z', sizeBytes: 2048, content: 'JPEG:plate' },
      { category: 'wiring-note', visibility: 'internal', filename: 'wiring.txt', captureTime: '2026-03-12T15:12:00Z', note: 'East abutment enclosure.', sizeBytes: 26, content: 'East abutment enclosure.' },
    ],
  };
  const second: CreateVisitInput = {
    siteId: HYRUM_PUBLIC,
    visitTime: '2026-03-20T17:00:00Z',
    type: 'maintenance',
    actionIds: ['equipment-maintenance'],
    notes: '',
    lastChecked: '2026-03-20T16:30:00Z',
    lastRated: '2026-03-20T17:00:00Z',
    attachments: [],
  };

  const a = createVisit(store, storage, FATIMA, first, { now: NOW, idempotencyKey: 'det-1' });
  if (a.outcome !== 'applied') throw new Error(`scenario first visit failed: ${JSON.stringify(a)}`);
  const replay = createVisit(store, storage, FATIMA, first, { now: '2026-03-12T16:01:00Z', idempotencyKey: 'det-1' });
  if (replay.outcome !== 'applied' || !replay.replayed) throw new Error('scenario replay was not idempotent');
  const b = createVisit(store, storage, DIEGO, second, { now: '2026-03-20T18:00:00Z' });
  if (b.outcome !== 'applied') throw new Error('scenario second visit failed');

  // Unsent flow on top: one failure, then a retry that lands.
  const draft = initialVisitDraft({ ...first, notes: 'Determinism retry visit.', visitTime: '2026-03-22T09:00:00Z', lastChecked: '2026-03-22T08:30:00Z', attachments: [] }, 'det');
  const failing = async () => ({ kind: 'transport-error' as const, message: 'offline' });
  const unsent = await submitVisitDraft(draft, failing, '2026-03-22T09:05:00Z');
  const ok = async (values: CreateVisitInput, idempotencyKey: string) => {
    const decision = createVisit(store, storage, FATIMA, values, { now: '2026-03-22T09:06:00Z', idempotencyKey });
    return decision.outcome === 'applied'
      ? { kind: 'sent' as const, visitId: decision.visit.id, replayed: decision.replayed }
      : { kind: 'transport-error' as const, message: 'rejected' };
  };
  const sent = await submitVisitDraft(unsent, ok, '2026-03-22T09:06:00Z');
  if (sent.status !== 'sent') throw new Error('scenario retry did not land');

  return JSON.stringify({
    visits: store.visits,
    attachments: store.attachments,
    audit: store.auditEvents,
    outbox: store.outboxEvents,
    summaries: store.sites.map((site) => store.summaryFor(site.id)),
    notInspected: store.sitesNotInspectedSince('2026-03-21T00:00:00Z'),
    internalListFatima: internalAttachmentList(store, FATIMA, CORINNE, NOW),
    manifest: exportManifest(store, CORINNE),
  });
}

test('determinism: two full scenario runs serialize byte-identically', async () => {
  const runOne = await scenarioRun();
  const runTwo = await scenarioRun();
  assert.equal(runOne, runTwo);
  // And the run is non-trivial: three appended visits across two sites.
  const parsed = JSON.parse(runOne) as { visits: unknown[]; audit: unknown[] };
  assert.equal(parsed.visits.length, 3);
  assert.equal(parsed.audit.length, 3);
});
