/**
 * WD-012 unsent-form tests: a failed submit (injected transport error)
 * preserves the COMPLETE form state with an explicit "unsent" status and a
 * retry; no silent loss, no partial submission. Reload-safe persistence is
 * the R2 offline task (FR-027) - documented, not implemented here.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/visits/test/unsent.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVisitStore } from '../store.ts';
import { createPlaceholderAttachmentStorage } from '../attachments.ts';
import { createVisit } from '../visits.ts';
import {
  initialVisitDraft,
  submitVisitDraft,
  unsentEnvelopeOf,
  visitDraftReducer,
  type VisitDraftState,
  type VisitTransport,
} from '../unsent.ts';
import type { CreateVisitInput } from '../types.ts';

const FATIMA = 'principal-fatima-engineer';
const SITE = 'sta-bear-corinne';
const NOW = '2026-03-12T16:00:00Z';

const FORM: CreateVisitInput = {
  siteId: SITE,
  visitTime: '2026-03-12T15:30:00Z',
  type: 'inspection',
  actionIds: ['gauge-inspection', 'measurement-taken'],
  notes: 'Field visit notes with a complete sentence the user typed.',
  lastChecked: '2026-03-12T15:00:00Z',
  lastRated: null,
  attachments: [
    {
      category: 'photo',
      visibility: 'public',
      filename: 'gauge-plate.jpg',
      captureTime: '2026-03-12T15:10:00Z',
      sizeBytes: 2048,
      content: 'JPEG-bytes:gauge-plate',
    },
    {
      category: 'wiring-note',
      visibility: 'internal',
      filename: 'wiring.txt',
      captureTime: '2026-03-12T15:12:00Z',
      note: 'RTU enclosure on east abutment.',
      sizeBytes: 31,
      content: 'RTU enclosure on east abutment.',
    },
  ],
};

/** Build the real transport against a fresh store: sent <=> the visit was appended server-side. */
function liveTransport(store: ReturnType<typeof createVisitStore>, mode: 'ok' | 'throw' | 'report-error') {
  const storage = createPlaceholderAttachmentStorage();
  const transport: VisitTransport<CreateVisitInput> = async (values, idempotencyKey) => {
    if (mode === 'throw') throw new Error('fetch failed: ENETDOWN');
    if (mode === 'report-error') return { kind: 'transport-error', message: 'request timeout after 30000ms (unsent)' };
    const decision = createVisit(store, storage, FATIMA, values, { now: NOW, idempotencyKey });
    if (decision.outcome === 'applied') {
      return { kind: 'sent', visitId: decision.visit.id, replayed: decision.replayed };
    }
    // Server-side rejections are NOT transport errors; surfaced as an error
    // message the UI would show while keeping the draft unsent.
    return { kind: 'transport-error', message: `server rejected: ${decision.message}` };
  };
  return { storage, transport };
}

test('a thrown transport error preserves the complete form as unsent, with the error and attempt recorded', async () => {
  const store = createVisitStore();
  const { transport } = liveTransport(store, 'throw');
  const frozenForm = Object.freeze(structuredClone(FORM));
  const state: VisitDraftState<CreateVisitInput> = initialVisitDraft(frozenForm, 'd-1');

  const unsent = await submitVisitDraft(state, transport, NOW);
  assert.equal(unsent.status, 'unsent', 'explicit unsent status, never a silent loss');
  assert.equal(unsent.attempts, 1);
  assert.equal(unsent.unsentSince, NOW);
  assert.ok(unsent.lastError?.includes('ENETDOWN'));
  assert.ok(unsent.lastError?.startsWith('network error:'));

  // The complete form state is preserved BY REFERENCE (nothing rebuilt).
  assert.ok(Object.is(unsent.values, frozenForm), 'values carried over by reference');
  assert.deepEqual(unsent.values, FORM, 'and byte-equal to the submitted form');
  assert.equal(unsent.sentVisitId, null, 'no visit id: nothing was partially submitted');
  assert.equal(store.visits.length, 0, 'the visit store is untouched by the failed submit');
});

test('a reported transport error behaves identically to a thrown one', async () => {
  const store = createVisitStore();
  const { transport } = liveTransport(store, 'report-error');
  const state = initialVisitDraft(FORM, 'd-2');
  const unsent = await submitVisitDraft(state, transport, NOW);
  assert.equal(unsent.status, 'unsent');
  assert.equal(unsent.lastError, 'request timeout after 30000ms (unsent)');
  assert.deepEqual(unsent.values, FORM);
  assert.equal(store.visits.length, 0);
});

test('retry resubmits the SAME form with the SAME idempotency key and succeeds exactly once', async () => {
  const store = createVisitStore();
  const failing = liveTransport(store, 'report-error').transport;
  const state = initialVisitDraft(FORM, 'd-3');
  const key = state.idempotencyKey;

  const unsent = await submitVisitDraft(state, failing, NOW);
  assert.equal(unsent.status, 'unsent');
  const seenKeys: string[] = [];
  const succeeding: VisitTransport<CreateVisitInput> = async (values, idempotencyKey) => {
    seenKeys.push(idempotencyKey);
    return liveTransport(store, 'ok').transport(values, idempotencyKey);
  };
  const sent = await submitVisitDraft(unsent, succeeding, '2026-03-12T16:05:00Z');
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sentVisitId, 'visit-1001');
  assert.deepEqual(seenKeys, [key], 'the retry reuses the draft idempotency key exactly');
  assert.equal(store.visits.length, 1, 'exactly one visit appended across failure + retry');
  assert.deepEqual(sent.values, FORM, 'values remain visible after success until an explicit reset');
});

test('a retry after an ambiguous failure replays the recorded visit instead of duplicating it', async () => {
  const store = createVisitStore();
  // First attempt: the server records the visit, then the response is lost.
  let recordedOnce = false;
  const ambiguous: VisitTransport<CreateVisitInput> = async (values, idempotencyKey) => {
    const decision = createVisit(store, createPlaceholderAttachmentStorage(), FATIMA, values, { now: NOW, idempotencyKey });
    if (decision.outcome !== 'applied') throw new Error('unexpected rejection');
    if (!recordedOnce) {
      recordedOnce = true;
      return { kind: 'transport-error', message: 'response lost after the server committed' };
    }
    return { kind: 'sent', visitId: decision.visit.id, replayed: decision.replayed };
  };
  const state = initialVisitDraft(FORM, 'd-4');
  const unsent = await submitVisitDraft(state, ambiguous, NOW);
  assert.equal(unsent.status, 'unsent');
  const sent = await submitVisitDraft(unsent, ambiguous, NOW);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sentReplayed, true, 'the retry replayed the recorded visit');
  assert.equal(store.visits.length, 1, 'no duplicate despite the ambiguous first attempt');
});

test('repeated failures keep the form, count attempts and never partially submit', async () => {
  const store = createVisitStore();
  const { transport } = liveTransport(store, 'throw');
  let state: VisitDraftState<CreateVisitInput> = initialVisitDraft(FORM, 'd-5');
  state = await submitVisitDraft(state, transport, '2026-03-12T16:00:00Z');
  state = await submitVisitDraft(state, transport, '2026-03-12T16:01:00Z');
  state = await submitVisitDraft(state, transport, '2026-03-12T16:02:00Z');
  assert.equal(state.status, 'unsent');
  assert.equal(state.attempts, 3);
  assert.equal(state.unsentSince, '2026-03-12T16:00:00Z', 'first failure time preserved');
  assert.deepEqual(state.values, FORM);
  assert.equal(store.visits.length, 0);
});

test('editing an unsent draft fixes values without losing the error trail; submitting is blocked mid-flight', async () => {
  const store = createVisitStore();
  const { transport } = liveTransport(store, 'report-error');
  const state = initialVisitDraft(FORM, 'd-6');
  const unsent = await submitVisitDraft(state, transport, NOW);

  const edited = visitDraftReducer(unsent, { type: 'edit', values: { ...unsent.values, notes: 'Fixed note.' } });
  assert.equal(edited.status, 'unsent', 'editing keeps the explicit unsent status');
  assert.equal(edited.attempts, 1);
  assert.equal(edited.lastError, unsent.lastError);
  assert.equal(edited.values.notes, 'Fixed note.');

  const submitting = visitDraftReducer(edited, { type: 'submit-start', at: NOW });
  assert.equal(submitting.status, 'submitting');
  const blocked = visitDraftReducer(submitting, { type: 'edit', values: FORM });
  assert.equal(blocked.status, 'submitting', 'values cannot change while submitting');
  assert.ok(Object.is(blocked.values, submitting.values));
});

test('reset only after an explicit action; the R2 envelope is described, not persisted', async () => {
  const store = createVisitStore();
  const { transport } = liveTransport(store, 'report-error');
  const state = initialVisitDraft(FORM, 'd-7');
  const unsent = await submitVisitDraft(state, transport, NOW);

  const envelope = unsentEnvelopeOf(unsent, { draftId: 'd-7', actorId: FATIMA, siteId: SITE, deviceZone: 'America/Denver' });
  assert.ok(envelope);
  assert.equal(envelope.idempotencyKey, 'visit-draft-d-7');
  assert.equal(envelope.attempts, 1);
  assert.equal(envelope.deviceZone, 'America/Denver');
  assert.deepEqual(envelope.values, FORM, 'the R2 IndexedDB queue will store exactly this shape');

  const reset = visitDraftReducer(unsent, { type: 'reset', values: { ...FORM, notes: '' }, draftId: 'd-8' });
  assert.equal(reset.status, 'editing');
  assert.equal(reset.attempts, 0);
  assert.equal(reset.lastError, null);
  assert.equal(reset.idempotencyKey, 'visit-draft-d-8');
  // No persistence layer exists in WD-012 by design (FR-027 is R2).
  assert.equal(unsentEnvelopeOf(reset, { draftId: 'd-8', actorId: FATIMA, siteId: SITE, deviceZone: 'America/Denver' }), null);
});

test('a server validation rejection surfaces as an unsent draft with the message (recoverable, FR-026)', async () => {
  const store = createVisitStore();
  const { transport } = liveTransport(store, 'ok');
  const invalid: CreateVisitInput = { ...FORM, actionIds: [] };
  const state = initialVisitDraft(invalid, 'd-9');
  const unsent = await submitVisitDraft(state, transport, NOW);
  assert.equal(unsent.status, 'unsent');
  assert.ok(unsent.lastError?.startsWith('server rejected:'));
  assert.deepEqual(unsent.values, invalid, 'data submission survives a recoverable validation failure');
  assert.equal(store.visits.length, 0);
});
