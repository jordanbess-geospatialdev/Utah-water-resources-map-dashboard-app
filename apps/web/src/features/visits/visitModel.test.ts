/**
 * Visits feature model tests (WD-012, FR-026/FR-046/FR-049): the form
 * validation matrix, submit-body composition, the unsent/retry state
 * machine (with runtime parity against the REAL server module), the
 * visibility-filtered history projection (wiring-note canary sweep) and the
 * structured-date derivations.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/visits/visitModel.test.ts
 *
 * The parity tests load the server module at RUNTIME (outside the web tsc
 * program, the established dynamic-import pattern from features/operations
 * and features/data-entry).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import type { AttachmentDraft, VisitFormValues, VisitTransport } from './visitModel';

register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const modelPath = './visitModel.ts';
const model: typeof import('./visitModel') = await import(modelPath);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validForm(overrides: Partial<VisitFormValues> = {}): VisitFormValues {
  return {
    siteId: 'sta-bear-corinne',
    localDate: '2026-03-12',
    localTime: '09:30',
    offset: '-07:00',
    type: 'inspection',
    actionIds: ['gauge-inspection'],
    notes: 'Annual inspection.',
    lastCheckedDate: '2026-03-12',
    lastRatedDate: '',
    attachments: [],
    ...overrides,
  };
}

function wiringRow(overrides: Partial<AttachmentDraft> = {}): AttachmentDraft {
  return {
    rowId: 'att-row-1',
    category: 'wiring-note',
    visibility: 'internal',
    filename: 'wiring-notes-2026-03.txt',
    captureDate: '2026-03-12',
    captureTime: '09:20',
    note: 'RTU enclosure on east abutment; lock combo rotates quarterly.',
    internalConfirmed: true,
    content: 'placeholder-wiring-content',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('a valid form passes validation and composes the server-shaped body', () => {
  const values = validForm({
    attachments: [wiringRow(), { ...model.newAttachmentRow('photo'), filename: 'plate.jpg', captureDate: '2026-03-12', captureTime: '09:25', content: 'JPEG' }],
  });
  const errors = model.validateVisitForm(values);
  assert.deepEqual(Object.keys(errors), []);
  const body = model.composeSubmitBody(values);
  assert.ok(body);
  assert.equal(body.visitTime, '2026-03-12T16:30:00Z', '09:30 MST composes to 16:30Z');
  assert.equal(body.lastChecked, '2026-03-12T07:00:00Z', 'structured date composes at local midnight with the visit offset');
  assert.equal(body.lastRated, null);
  assert.equal(body.attachments.length, 2);
  const wiring = body.attachments[0]!;
  assert.equal(wiring.visibility, 'internal');
  assert.equal(wiring.sizeBytes, 'placeholder-wiring-content'.length);
  assert.equal(wiring.captureTime, '2026-03-12T16:20:00Z');
});

test('required fields and formats are flagged next to their control', () => {
  const errors = model.validateVisitForm(validForm({ siteId: '', localDate: '03/12/2026', localTime: '9:30 am', actionIds: [] }));
  for (const field of ['siteId', 'localDate', 'localTime', 'actionIds']) {
    assert.ok(errors[field], `${field} flagged`);
  }
  assert.ok(errors.lastCheckedDate === undefined, 'absent structured dates are fine');
});

test('structured dates after the visit date are rejected', () => {
  const errors = model.validateVisitForm(validForm({ lastCheckedDate: '2026-03-13' }));
  assert.ok(errors.lastCheckedDate?.includes('cannot be after'));
});

test('wiring notes: visibility locked internal, explicit confirmation required, note text required', () => {
  const unconfirmed = model.validateVisitForm(validForm({ attachments: [wiringRow({ internalConfirmed: false })] }));
  assert.ok(unconfirmed['attachments[0].internalConfirmed']?.includes('stays internal'));
  const noNote = model.validateVisitForm(validForm({ attachments: [wiringRow({ note: '  ' })] }));
  assert.ok(noNote['attachments[0].note']);
  const publicWiring = model.validateVisitForm(validForm({ attachments: [wiringRow({ visibility: 'public' as AttachmentDraft['visibility'] })] }));
  assert.ok(publicWiring['attachments[0].visibility']?.includes('never be public'));
  // New wiring rows default to internal visibility.
  const fresh = model.newAttachmentRow('wiring-note');
  assert.equal(fresh.visibility, 'internal');
  assert.equal(model.newAttachmentRow('photo').visibility, 'public');
});

test('attachment filename safety and capture-time bounds mirror the server rules', () => {
  const unsafe = model.validateVisitForm(validForm({ attachments: [{ ...model.newAttachmentRow('photo'), filename: '../../secret', content: 'x', captureDate: '2026-03-12', captureTime: '09:00' }] }));
  assert.ok(unsafe['attachments[0].filename']?.includes('path separators'));
  const late = model.validateVisitForm(validForm({ attachments: [{ ...model.newAttachmentRow('photo'), filename: 'ok.jpg', content: 'x', captureDate: '2026-03-13', captureTime: '09:00' }] }));
  assert.ok(late['attachments[0].captureDate']?.includes('cannot be after'));
  const empty = model.validateVisitForm(validForm({ attachments: [model.newAttachmentRow('photo')] }));
  assert.ok(empty['attachments[0].filename'] && empty['attachments[0].content']);
});

test('composeInstant handles offsets and rejects malformed cells', () => {
  assert.equal(model.composeInstant('2026-03-12', '09:30', '-07:00'), '2026-03-12T16:30:00Z');
  assert.equal(model.composeInstant('2026-03-12', '09:30', '-06:00'), '2026-03-12T15:30:00Z');
  assert.equal(model.composeInstant('2026-03-12', '09:30', 'Z'), '2026-03-12T09:30:00Z');
  assert.equal(model.composeInstant('2026-02-30', '09:30', 'Z'), null, 'nonexistent calendar date');
  assert.equal(model.composeInstant('2026-03-12', '25:00', 'Z'), null);
  assert.equal(model.composeInstant('2026-03-12', '09:30', '+07'), null, 'offset must be HH:MM or Z');
});

// ---------------------------------------------------------------------------
// Unsent state machine + parity with the REAL server module
// ---------------------------------------------------------------------------

test('transport failure preserves the complete form as unsent, with retry and no partial submission', async () => {
  const values = validForm();
  let draft = model.initialVisitDraft(values, 'w-1');
  assert.equal(draft.idempotencyKey, 'visit-draft-w-1');

  const failing: VisitTransport = () => ({ kind: 'transport-error', message: 'ENETDOWN' });
  draft = await model.submitVisitDraft(draft, failing, '2026-03-12T16:00:00Z');
  assert.equal(draft.status, 'unsent');
  assert.equal(draft.attempts, 1);
  assert.ok(draft.lastError?.includes('ENETDOWN'));
  assert.deepEqual(draft.values, values, 'complete form preserved');

  const succeeding: VisitTransport = (_values, key) => {
    assert.equal(key, 'visit-draft-w-1', 'retry reuses the idempotency key');
    return { kind: 'sent', visitId: 'visit-1001', replayed: false };
  };
  draft = await model.submitVisitDraft(draft, succeeding, '2026-03-12T16:05:00Z');
  assert.equal(draft.status, 'sent');
  assert.equal(draft.sentVisitId, 'visit-1001');
  assert.deepEqual(draft.values, values, 'values remain visible after success');
});

test('thrown transports, repeated failures and mid-submit edits behave per the contract', async () => {
  let draft = model.initialVisitDraft(validForm(), 'w-2');
  const throwing: VisitTransport = () => {
    throw new Error('socket hang up');
  };
  draft = await model.submitVisitDraft(draft, throwing, '2026-03-12T16:00:00Z');
  assert.equal(draft.status, 'unsent');
  assert.ok(draft.lastError?.startsWith('network error:'));
  draft = await model.submitVisitDraft(draft, throwing, '2026-03-12T16:01:00Z');
  draft = await model.submitVisitDraft(draft, throwing, '2026-03-12T16:02:00Z');
  assert.equal(draft.attempts, 3);
  assert.equal(draft.unsentSince, '2026-03-12T16:00:00Z', 'first failure time preserved');

  const editing = model.visitDraftReducer(draft, { type: 'edit', values: validForm({ notes: 'fixed' }) });
  assert.equal(editing.status, 'unsent', 'editing keeps the unsent marker');
  const submitting = model.visitDraftReducer(editing, { type: 'submit-start', at: '2026-03-12T16:03:00Z' });
  const frozen = model.visitDraftReducer(submitting, { type: 'edit', values: validForm() });
  assert.equal(frozen.status, 'submitting', 'values cannot change mid-submit');
  assert.equal(frozen.values.notes, 'fixed');
});

test('PARITY: the web unsent machine matches the REAL server module step for step', async () => {
  const serverPath = '../../../../../services/api/src/workflows/visits/unsent.ts';
  const server = (await import(serverPath)) as {
    initialVisitDraft: <T>(values: T, draftId: string) => { status: string; attempts: number; lastError: string | null; unsentSince: string | null; sentVisitId: string | null; sentAt: string | null; sentReplayed: boolean; idempotencyKey: string };
    visitDraftReducer: (state: unknown, event: { type: string; [key: string]: unknown }) => { status: string; attempts: number; lastError: string | null; unsentSince: string | null; sentVisitId: string | null; sentAt: string | null; sentReplayed: boolean; idempotencyKey: string };
    submitVisitDraft: (state: never, transport: never, at: string) => Promise<{ status: string; attempts: number; lastError: string | null }>;
  };
  // Cast helper: run the same event sequence through both machines.
  const serverMachine = async () => {
    let state = server.initialVisitDraft({ notes: 'shared' }, 'p-1');
    state = server.visitDraftReducer(state, { type: 'submit-start', at: 'T1' });
    state = server.visitDraftReducer(state, { type: 'submit-failed', message: 'offline', at: 'T1' }) as typeof state;
    state = server.visitDraftReducer(state, { type: 'edit', values: { notes: 'shared' } }) as typeof state;
    state = server.visitDraftReducer(state, { type: 'submit-start', at: 'T2' }) as typeof state;
    state = server.visitDraftReducer(state, { type: 'submit-failed', message: 'offline again', at: 'T2' }) as typeof state;
    return state;
  };
  const webMachine = () => {
    let state = model.initialVisitDraft({ notes: 'shared' } as unknown as VisitFormValues, 'p-1');
    state = model.visitDraftReducer(state, { type: 'submit-start', at: 'T1' });
    state = model.visitDraftReducer(state, { type: 'submit-failed', message: 'offline', at: 'T1' });
    state = model.visitDraftReducer(state, { type: 'edit', values: { notes: 'shared' } as unknown as VisitFormValues });
    state = model.visitDraftReducer(state, { type: 'submit-start', at: 'T2' });
    state = model.visitDraftReducer(state, { type: 'submit-failed', message: 'offline again', at: 'T2' });
    return state;
  };
  const serverState = await serverMachine();
  const webState = webMachine();
  assert.deepEqual(
    {
      status: webState.status,
      attempts: webState.attempts,
      lastError: webState.lastError,
      unsentSince: webState.unsentSince,
      idempotencyKey: webState.idempotencyKey,
      sentReplayed: webState.sentReplayed,
    },
    {
      status: serverState.status,
      attempts: serverState.attempts,
      lastError: serverState.lastError,
      unsentSince: serverState.unsentSince,
      idempotencyKey: serverState.idempotencyKey,
      sentReplayed: serverState.sentReplayed,
    },
    'web mirror and server machine agree after the shared failure sequence',
  );
});

test('PARITY: server validation rejects what the web validation flags (wiring-note public)', async () => {
  const serverVisitsPath = '../../../../../services/api/src/workflows/visits/visits.ts';
  const serverStorePath = '../../../../../services/api/src/workflows/visits/store.ts';
  const serverAttachmentsPath = '../../../../../services/api/src/workflows/visits/attachments.ts';
  const serverVisits = (await import(serverVisitsPath)) as { createVisit: (...args: unknown[]) => { outcome: string; fieldErrors?: Array<{ code: string }> } };
  const serverStore = (await import(serverStorePath)) as { createVisitStore: () => unknown };
  const serverAttachments = (await import(serverAttachmentsPath)) as { createPlaceholderAttachmentStorage: () => unknown };

  const values = validForm({ attachments: [wiringRow({ visibility: 'public' as AttachmentDraft['visibility'] })] });
  assert.ok(model.validateVisitForm(values)['attachments[0].visibility'], 'web flags it');
  const body = model.composeSubmitBody(values);
  assert.ok(body);
  const decision = serverVisits.createVisit(serverStore.createVisitStore(), serverAttachments.createPlaceholderAttachmentStorage(), 'principal-fatima-engineer', body, { now: '2026-03-12T16:00:00Z' });
  assert.equal(decision.outcome, 'rejected');
  assert.ok(decision.fieldErrors?.some((error) => error.code === 'WIRING_NOTE_MUST_BE_INTERNAL'), 'server rejects the same input');
});

// ---------------------------------------------------------------------------
// History projection and structured dates
// ---------------------------------------------------------------------------

const DEMO_VISITS = [
  {
    id: 'visit-1001',
    siteId: 'sta-bear-corinne',
    actorId: 'principal-fatima-engineer',
    actorName: 'Fatima Al-Rashid',
    visitTime: '2026-03-12T15:30:00Z',
    recordedAt: '2026-03-12T16:00:00Z',
    type: 'inspection' as const,
    actionIds: ['gauge-inspection'],
    notes: 'Curve holding within tolerance.',
    lastChecked: '2026-03-12T15:00:00Z',
    lastRated: null,
    attachments: [
      { id: 'att-1001', category: 'photo' as const, visibility: 'public' as const, filename: 'plate.jpg', thumbnailPath: '/cache/attachments/att-1001/thumb-96.jpg' },
      { id: 'att-1002', category: 'wiring-note' as const, visibility: 'internal' as const, filename: 'wiring-notes.txt', thumbnailPath: null },
    ],
    hiddenAttachmentCount: 0,
  },
  {
    id: 'visit-1002',
    siteId: 'sta-bear-corinne',
    actorId: 'principal-fatima-engineer',
    actorName: 'Fatima Al-Rashid',
    visitTime: '2026-03-20T17:00:00Z',
    recordedAt: '2026-03-20T18:00:00Z',
    type: 'maintenance' as const,
    actionIds: ['sensor-replacement'],
    notes: 'FlumeLog 300 installed.',
    lastChecked: '2026-03-20T16:30:00Z',
    lastRated: '2026-03-20T17:00:00Z',
    attachments: [],
    hiddenAttachmentCount: 0,
  },
];

test('public projection hides actors, notes and internal attachments - and gives no existence hint', () => {
  const projected = model.projectHistoryVisits(DEMO_VISITS, { includeInternal: false });
  const first = projected[0]!;
  assert.equal(first.actorId, '');
  assert.equal(first.actorName, 'Field staff');
  assert.equal(first.notes, null);
  assert.equal(first.attachments.length, 1);
  assert.equal(first.attachments[0]!.visibility, 'public');
  assert.equal(first.hiddenAttachmentCount, 0, 'no count of hidden internal rows');

  // Byte sweep: the wiring-note canaries never enter the public projection.
  const serialized = JSON.stringify(projected);
  for (const canary of ['att-1002', 'wiring-notes.txt', 'wiring-note', 'Curve holding within tolerance.', 'Fatima Al-Rashid', 'principal-fatima-engineer']) {
    assert.ok(!serialized.includes(canary), `public history projection leaks "${canary}"`);
  }
});

test('engineer projection keeps actors, notes and internal attachments', () => {
  const projected = model.projectHistoryVisits(DEMO_VISITS, { includeInternal: true });
  const first = projected[0]!;
  assert.equal(first.actorName, 'Fatima Al-Rashid');
  assert.equal(first.notes, 'Curve holding within tolerance.');
  assert.equal(first.attachments.length, 2);
  assert.ok(first.attachments.some((attachment) => attachment.category === 'wiring-note'));
});

test('structured summary derives lastChecked/lastRated by visit time across the equipment change', () => {
  const summary = model.summarizeHistory('sta-bear-corinne', DEMO_VISITS);
  assert.equal(summary.visitCount, 2);
  assert.equal(summary.lastVisitTime, '2026-03-20T17:00:00Z');
  assert.equal(summary.lastChecked, '2026-03-20T16:30:00Z', 'the maintenance visit after the sensor replacement advanced the date');
  assert.equal(summary.lastRated, '2026-03-20T17:00:00Z');

  // Backdated third visit cannot regress the derived dates.
  const backdated = [...DEMO_VISITS, { ...DEMO_VISITS[0]!, id: 'visit-1003', visitTime: '2026-03-01T10:00:00Z', lastChecked: '2026-02-01T00:00:00Z', lastRated: '2026-02-01T00:00:00Z' }];
  const after = model.summarizeHistory('sta-bear-corinne', backdated);
  assert.equal(after.lastChecked, '2026-03-20T16:30:00Z');
  assert.equal(after.lastRated, '2026-03-20T17:00:00Z');
});

test('notInspectedSince flags sites with stale or absent lastChecked', () => {
  const sites = [
    { siteId: 'sta-bear-corinne', visits: DEMO_VISITS },
    { siteId: 'sta-hyrum-diversion-public', visits: [] },
  ];
  assert.deepEqual(model.notInspectedSince(sites, '2026-03-21T00:00:00Z'), ['sta-bear-corinne', 'sta-hyrum-diversion-public']);
  assert.deepEqual(model.notInspectedSince(sites, '2026-03-19T00:00:00Z'), ['sta-hyrum-diversion-public'], 'checked 2026-03-20 is current at that cutoff');
  assert.deepEqual(model.notInspectedSince([], '2026-03-21T00:00:00Z'), []);
});
