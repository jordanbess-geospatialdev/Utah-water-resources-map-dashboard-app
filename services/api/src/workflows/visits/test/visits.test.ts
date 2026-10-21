/**
 * WD-012 domain tests (verification rows T-03/T-10): the field-visit scope
 * matrix (assigned engineers only, within their system), the append-only
 * per-site history with structured lastChecked/lastRated dates (FR-046),
 * validation, idempotency and the audit/outbox transaction.
 *
 * Run (zero dependencies):
 *   cd services/api && node --test --experimental-strip-types src/workflows/visits/test/visits.test.ts
 *
 * Every clock input is an injected constant; the store reads only the
 * fixture files, so the suite is deterministic (see determinism.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVisitStore } from '../store.ts';
import { createPlaceholderAttachmentStorage } from '../attachments.ts';
import { createVisit, inspectionSummary, sitesNotInspectedSince, siteVisitHistory, evidenceForVisit } from '../visits.ts';
import { withEntitlement } from '../../../../../../packages/policy/src/index.ts';
import type { CreateVisitInput } from '../types.ts';

// ---------------------------------------------------------------------------
// Fixture anchors (seed utah-water-fixture-v1)
// ---------------------------------------------------------------------------

const CORINNE = 'sta-bear-corinne'; // public, active, Bear River, carries the gate-code internal block
const HYRUM_PUBLIC = 'sta-hyrum-diversion-public'; // public, active, Bear River
const HYRUM_OWNER = 'sta-hyrum-diversion-owner'; // restricted, active, Bear River (hidden for outsiders)
const DIAGNOSTIC = 'sta-bear-lake-diagnostic'; // internal, active, Bear River
const SUMMIT_INACTIVE = 'sta-summit-creek-inactive'; // public, INACTIVE, Bear River
const OGDEN_PROPOSED = 'sta-ogden-valley-proposed'; // restricted, PROPOSED, Weber River

const FATIMA = 'principal-fatima-engineer'; // field-visits @ sys-bear-river
const PRIYA = 'principal-priya-engineer'; // field-visits @ sys-weber-river only
const DIEGO = 'principal-diego-steward'; // statewide-administration satisfies field-visits statewide
const CODY = 'principal-cody-commissioner'; // Bear commissioner, NO field-visits grant
const ANA = 'principal-ana-deputy'; // deputy: enter-readings/review-data only
const SARAH = 'principal-sarah-researcher'; // researcher: no operational verb

const NOW = '2026-03-12T16:00:00Z';

function visitInput(overrides: Partial<CreateVisitInput> = {}): CreateVisitInput {
  return {
    siteId: CORINNE,
    visitTime: '2026-03-12T15:30:00Z',
    type: 'inspection',
    actionIds: ['gauge-inspection', 'measurement-taken'],
    notes: 'Annual gauge inspection; curve holding within tolerance.',
    lastChecked: '2026-03-12T15:00:00Z',
    lastRated: null,
    attachments: [
      {
        category: 'photo',
        visibility: 'public',
        filename: 'corinne-gauge-plate-2026-03.jpg',
        captureTime: '2026-03-12T15:10:00Z',
        sizeBytes: 2400,
        content: 'JPEG-bytes-placeholder:corinne-gauge-plate',
      },
    ],
    ...overrides,
  };
}

function freshStore() {
  return { store: createVisitStore(), storage: createPlaceholderAttachmentStorage() };
}

// ---------------------------------------------------------------------------
// Scope matrix: assigned engineers within their system (FR-046 + matrix row)
// ---------------------------------------------------------------------------

test('assigned engineer records a visit in scope: appended with structured dates', () => {
  const { store, storage } = freshStore();
  const decision = createVisit(store, storage, FATIMA, visitInput(), { now: NOW });
  assert.equal(decision.outcome, 'applied');
  if (decision.outcome === 'applied') {
    assert.equal(decision.status, 201);
    assert.equal(decision.replayed, false);
    assert.equal(decision.visit.siteId, CORINNE);
    assert.equal(decision.visit.actorId, FATIMA);
    assert.equal(decision.visit.sequence, 1);
    assert.equal(decision.summary.lastChecked, '2026-03-12T15:00:00Z');
    assert.equal(decision.summary.lastCheckedVisitId, decision.visit.id);
    assert.equal(decision.summary.lastRated, null);
    assert.ok(decision.auditEvent);
    assert.ok(decision.outboxEvent);
  }
});

test('Fatima can visit every ACTIVE Bear River site, including restricted and internal ones', () => {
  const { store, storage } = freshStore();
  for (const siteId of [CORINNE, HYRUM_PUBLIC, HYRUM_OWNER, DIAGNOSTIC]) {
    const decision = createVisit(store, storage, FATIMA, visitInput({ siteId }), { now: NOW });
    assert.equal(decision.outcome, 'applied', siteId);
  }
  assert.equal(store.visits.length, 4);
});

test('cross-system denial: Priya (Weber River) is forbidden on public Bear sites and gets a hidden 404 on non-public ones', () => {
  const { store, storage } = freshStore();
  const input = visitInput();
  const publicRefusal = createVisit(store, storage, PRIYA, input, { now: NOW });
  assert.equal(publicRefusal.outcome, 'rejected');
  if (publicRefusal.outcome === 'rejected') {
    assert.equal(publicRefusal.status, 403, 'public site: existence visible, operation refused');
    assert.equal(publicRefusal.code, 'FORBIDDEN');
    assert.equal(publicRefusal.policyReason, 'DENY_OUT_OF_SCOPE');
  }
  for (const siteId of [HYRUM_OWNER, DIAGNOSTIC]) {
    const hidden = createVisit(store, storage, PRIYA, visitInput({ siteId }), { now: NOW });
    assert.equal(hidden.outcome, 'rejected', siteId);
    if (hidden.outcome === 'rejected') {
      assert.equal(hidden.status, 404, `${siteId}: does not exist for the out-of-scope engineer`);
      assert.equal(hidden.code, 'NOT_FOUND');
      assert.equal(hidden.policyReason, 'DENY_OUT_OF_SCOPE');
    }
  }
  assert.equal(store.visits.length, 0, 'nothing appended by denied actors');
});

test('Priya (Weber River) holds field-visits but the only Weber site is proposed: lifecycle denies (403)', () => {
  const { store, storage } = freshStore();
  const decision = createVisit(store, storage, PRIYA, visitInput({ siteId: OGDEN_PROPOSED }), { now: NOW });
  assert.equal(decision.outcome, 'rejected');
  if (decision.outcome === 'rejected') {
    assert.equal(decision.status, 403);
    assert.equal(decision.policyReason, 'DENY_LIFECYCLE_STATE', 'field-visits is mutate-class: only active sites receive visits');
  }
});

test('inactive site refuses visits even for the assigned engineer (lifecycle)', () => {
  const { store, storage } = freshStore();
  const decision = createVisit(store, storage, FATIMA, visitInput({ siteId: SUMMIT_INACTIVE }), { now: NOW });
  assert.equal(decision.outcome, 'rejected');
  if (decision.outcome === 'rejected') {
    assert.equal(decision.status, 403);
    assert.equal(decision.policyReason, 'DENY_LIFECYCLE_STATE');
  }
});

test('steward records a visit statewide (statewide-administration satisfies field-visits)', () => {
  const { store, storage } = freshStore();
  const decision = createVisit(store, storage, DIEGO, visitInput({ siteId: HYRUM_PUBLIC }), { now: NOW });
  assert.equal(decision.outcome, 'applied');
});

test('commissioner, deputy, researcher and unauthenticated actors are denied (403/401)', () => {
  const { store, storage } = freshStore();
  const input = visitInput();
  for (const actor of [CODY, ANA, SARAH]) {
    const decision = createVisit(store, storage, actor, input, { now: NOW });
    assert.equal(decision.outcome, 'rejected', actor);
    if (decision.outcome === 'rejected') {
      assert.equal(decision.status, 403, actor);
      assert.equal(decision.policyReason, 'DENY_CAPABILITY_NOT_GRANTED', actor);
    }
  }
  const anonymous = createVisit(store, storage, 'principal-ghost', input, { now: NOW });
  assert.equal(anonymous.outcome, 'rejected');
  if (anonymous.outcome === 'rejected') {
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.code, 'UNAUTHENTICATED');
    assert.equal(anonymous.policyReason, 'DENY_ANONYMOUS', 'unresolvable actor id maps to a null principal');
  }
  assert.equal(store.visits.length, 0);
});

test('unknown site is 404 for anyone (resolution precedes authorization)', () => {
  const { store, storage } = freshStore();
  const decision = createVisit(store, storage, FATIMA, visitInput({ siteId: 'sta-nope' }), { now: NOW });
  assert.equal(decision.outcome, 'rejected');
  if (decision.outcome === 'rejected') {
    assert.equal(decision.status, 404);
    assert.deepEqual(
      decision.fieldErrors.map((error) => error.code),
      ['SITE_UNKNOWN'],
    );
  }
});

test('revoked grant denies immediately at the next evaluation (withEntitlement world swap)', () => {
  const { store, storage } = freshStore();
  const first = createVisit(store, storage, FATIMA, visitInput(), { now: NOW });
  assert.equal(first.outcome, 'applied');
  const revoked = withEntitlement(store.world, 'ent-engineer-fatima', { status: 'revoked' });
  const second = createVisit(store.withWorld(revoked), storage, FATIMA, visitInput({ visitTime: '2026-03-13T15:30:00Z' }), { now: NOW });
  assert.equal(second.outcome, 'rejected');
  if (second.outcome === 'rejected') {
    assert.equal(second.policyReason, 'DENY_ASSIGNMENT_REVOKED');
    assert.equal(second.status, 403);
  }
  // History survives the revocation: the recorded visit remains readable.
  assert.equal(store.visitsForSite(CORINNE).length, 1);
});

// ---------------------------------------------------------------------------
// Validation (422 with field paths)
// ---------------------------------------------------------------------------

test('validation rejections carry the offending field paths', () => {
  const { store, storage } = freshStore();
  const cases: Array<[CreateVisitInput, string]> = [
    [visitInput({ type: 'surprise' as CreateVisitInput['type'] }), 'VISIT_TYPE_UNKNOWN'],
    [visitInput({ actionIds: [] }), 'ACTIONS_REQUIRED'],
    [visitInput({ actionIds: ['gauge-inspection', 'gauge-inspection'] }), 'ACTION_DUPLICATE'],
    [visitInput({ actionIds: ['teleportation'] }), 'ACTION_UNKNOWN'],
    [visitInput({ visitTime: '2026-03-12 15:30' }), 'VISIT_TIME_INVALID'],
    [visitInput({ lastChecked: '2026-03-13T00:00:00Z' }), 'STRUCTURED_DATE_AFTER_VISIT'],
    [visitInput({ lastRated: 'not-a-date' }), 'STRUCTURED_DATE_INVALID'],
  ];
  for (const [input, code] of cases) {
    const decision = createVisit(store, storage, FATIMA, input, { now: NOW });
    assert.equal(decision.outcome, 'rejected', code);
    if (decision.outcome === 'rejected') {
      assert.equal(decision.status, 422, code);
      assert.equal(decision.code, 'VALIDATION_FAILED', code);
      assert.ok(decision.fieldErrors.some((error) => error.code === code), `${code} in fieldErrors`);
    }
  }
  assert.equal(store.visits.length, 0, 'validation rejections append nothing');
});

test('attachment validation: missing content, unsafe filename, capture after visit, bad enums', () => {
  const { store, storage } = freshStore();
  const cases: Array<[CreateVisitInput, string]> = [
    [
      visitInput({ attachments: [{ category: 'photo', visibility: 'public', filename: 'a.jpg', captureTime: '2026-03-12T15:00:00Z', sizeBytes: 10, content: '' }] }),
      'CONTENT_REQUIRED',
    ],
    [
      visitInput({ attachments: [{ category: 'photo', visibility: 'public', filename: '../etc/passwd', captureTime: '2026-03-12T15:00:00Z', sizeBytes: 10, content: 'x' }] }),
      'FILENAME_UNSAFE',
    ],
    [
      visitInput({ attachments: [{ category: 'photo', visibility: 'public', filename: 'a.jpg', captureTime: '2026-03-12T16:00:00Z', sizeBytes: 10, content: 'x' }] }),
      'CAPTURE_TIME_AFTER_VISIT',
    ],
    [
      visitInput({ attachments: [{ category: 'sketch', visibility: 'public', filename: 'a.jpg', captureTime: '2026-03-12T15:00:00Z', sizeBytes: 10, content: 'x' }] }),
      'CATEGORY_UNKNOWN',
    ],
    [
      visitInput({ attachments: [{ category: 'photo', visibility: 'secret', filename: 'a.jpg', captureTime: '2026-03-12T15:00:00Z', sizeBytes: 10, content: 'x' }] }),
      'VISIBILITY_UNKNOWN',
    ],
    [
      visitInput({ attachments: [{ category: 'photo', visibility: 'public', filename: 'a.jpg', captureTime: '2026-03-12T15:00:00Z', sizeBytes: -5, content: 'x' }] }),
      'SIZE_INVALID',
    ],
  ];
  for (const [input, code] of cases) {
    const decision = createVisit(store, storage, FATIMA, input, { now: NOW });
    assert.equal(decision.outcome, 'rejected', code);
    if (decision.outcome === 'rejected') {
      assert.equal(decision.status, 422, code);
      assert.ok(decision.fieldErrors.some((error) => error.code === code), `${code} in fieldErrors`);
    }
  }
});

// ---------------------------------------------------------------------------
// Append-only history and structured dates (FR-046)
// ---------------------------------------------------------------------------

test('visit history is append-only: earlier visits are never rewritten by later appends', () => {
  const { store, storage } = freshStore();
  createVisit(store, storage, FATIMA, visitInput({ lastChecked: '2026-03-12T15:00:00Z' }), { now: '2026-03-12T16:00:00Z' });
  const snapshotAfterFirst = JSON.parse(JSON.stringify(store.visitsForSite(CORINNE)));

  // Equipment replacement visit (WD-010 replaces the sensor; the visit that
  // documents it appends here) and a routine maintenance visit.
  createVisit(
    store,
    storage,
    FATIMA,
    visitInput({
      type: 'maintenance',
      actionIds: ['sensor-replacement', 'equipment-maintenance'],
      visitTime: '2026-03-20T17:00:00Z',
      lastChecked: '2026-03-20T16:30:00Z',
      attachments: [],
    }),
    { now: '2026-03-20T18:00:00Z' },
  );
  createVisit(store, storage, DIEGO, visitInput({ type: 'other', actionIds: ['site-cleanup'], visitTime: '2026-03-22T09:00:00Z', lastChecked: null, attachments: [] }), { now: '2026-03-22T10:00:00Z' });

  const history = store.visitsForSite(CORINNE);
  assert.equal(history.length, 3);
  assert.equal(history[0]?.sequence, 1);
  assert.equal(history[1]?.sequence, 2);
  assert.equal(history[2]?.sequence, 3);
  assert.ok(history.every((visit) => Object.isFrozen(visit)));
  // The first visit is byte-identical to its snapshot after it was recorded.
  assert.deepEqual(JSON.parse(JSON.stringify(history[0])), snapshotAfterFirst[0]);
  // Order is append order, not visit-time order (the later cleanup visit has
  // an earlier-in-day timestamp than its append neighbors but stays third).
  assert.deepEqual(
    history.map((visit) => visit.id),
    ['visit-1001', 'visit-1002', 'visit-1003'],
  );
});

test('structured lastChecked/lastRated advance by VISIT time; backdated visits do not regress them', () => {
  const { store, storage } = freshStore();
  createVisit(store, storage, FATIMA, visitInput({ lastChecked: '2026-03-12T15:00:00Z', lastRated: null }), { now: '2026-03-12T16:00:00Z' });
  createVisit(
    store,
    storage,
    FATIMA,
    visitInput({ visitTime: '2026-03-20T17:00:00Z', lastChecked: '2026-03-20T16:30:00Z', lastRated: '2026-03-20T17:00:00Z', attachments: [] }),
    { now: '2026-03-20T18:00:00Z' },
  );
  // Backdated visit asserting an OLDER checked date and an older rating.
  createVisit(
    store,
    storage,
    DIEGO,
    visitInput({ visitTime: '2026-03-01T10:00:00Z', lastChecked: '2026-02-01T00:00:00Z', lastRated: '2026-02-01T00:00:00Z', attachments: [] }),
    { now: '2026-03-21T08:00:00Z' },
  );
  const summary = inspectionSummary(store, CORINNE);
  assert.ok(summary);
  assert.equal(summary.visitCount, 3);
  assert.equal(summary.lastChecked, '2026-03-20T16:30:00Z', 'backdated visit cannot regress lastChecked');
  assert.equal(summary.lastRated, '2026-03-20T17:00:00Z', 'backdated visit cannot regress lastRated');
  assert.equal(summary.lastVisitTime, '2026-03-20T17:00:00Z', 'latest by visit time wins even when appended earlier-order');
});

test('inspection history survives equipment replacement: the pre-replacement visit and its dates remain', () => {
  const { store, storage } = freshStore();
  const before = createVisit(store, storage, FATIMA, visitInput({ lastChecked: '2026-03-07T15:00:00Z', lastRated: '2026-03-07T15:00:00Z' }), { now: '2026-03-07T16:00:00Z' });
  // Equipment replaced 2026-03-07T18:35Z per the fixture deployment record;
  // the replacement visit appends afterwards and asserts NO new dates.
  const after = createVisit(
    store,
    storage,
    FATIMA,
    visitInput({ type: 'maintenance', actionIds: ['sensor-replacement'], visitTime: '2026-03-08T15:00:00Z', lastChecked: null, lastRated: null, attachments: [] }),
    { now: '2026-03-08T16:00:00Z' },
  );
  assert.equal(before.outcome, 'applied');
  assert.equal(after.outcome, 'applied');
  const summary = inspectionSummary(store, CORINNE);
  assert.ok(summary);
  // The structured dates come from the inspection VISIT, which the append-
  // only history preserves across the equipment change.
  assert.equal(summary.lastChecked, '2026-03-07T15:00:00Z');
  assert.equal(summary.lastRated, '2026-03-07T15:00:00Z');
  const firstVisit = siteVisitHistory(store, CORINNE)[0];
  assert.equal(firstVisit.lastChecked, '2026-03-07T15:00:00Z');
  assert.ok(Object.isFrozen(firstVisit.attachments));
});

test('sites not inspected since X: structured query over the derived lastChecked', () => {
  const { store, storage } = freshStore();
  createVisit(store, storage, FATIMA, visitInput({ lastChecked: '2026-03-12T15:00:00Z' }), { now: NOW });
  createVisit(
    store,
    storage,
    DIEGO,
    visitInput({ siteId: HYRUM_PUBLIC, visitTime: '2026-03-20T17:00:00Z', lastChecked: '2026-03-20T16:30:00Z', attachments: [] }),
    { now: '2026-03-20T18:00:00Z' },
  );

  const sinceBefore = sitesNotInspectedSince(store, '2026-03-15T00:00:00Z');
  assert.ok(sinceBefore);
  const ids = sinceBefore!.map((row) => row.id);
  assert.ok(!ids.includes(HYRUM_PUBLIC), 'inspected 2026-03-20: current');
  assert.ok(ids.includes(CORINNE), 'last checked 2026-03-12: overdue');
  assert.ok(ids.includes(HYRUM_OWNER) && ids.includes(DIAGNOSTIC) && ids.includes(SUMMIT_INACTIVE) && ids.includes(OGDEN_PROPOSED), 'never-inspected sites are overdue by definition');
  const corinneRow = sinceBefore!.find((row) => row.id === CORINNE);
  assert.equal(corinneRow?.lastChecked, '2026-03-12T15:00:00Z', 'the overdue row carries the structured date');

  // Boundary semantics: inspected exactly AT the boundary is current.
  const sinceExact = sitesNotInspectedSince(store, '2026-03-20T16:30:00Z');
  assert.ok(!sinceExact!.some((row) => row.id === HYRUM_PUBLIC), 'lastChecked == since: not overdue');

  const sinceLater = sitesNotInspectedSince(store, '2026-03-21T00:00:00Z');
  assert.ok(sinceLater!.some((row) => row.id === HYRUM_PUBLIC), 'past the boundary: overdue');

  assert.equal(sitesNotInspectedSince(store, 'yesterday'), null, 'malformed bound is rejected, not guessed');
});

// ---------------------------------------------------------------------------
// Idempotency, audit and outbox
// ---------------------------------------------------------------------------

test('idempotency: same key + same body replays the recorded visit; different body is a 409', () => {
  const { store, storage } = freshStore();
  const first = createVisit(store, storage, FATIMA, visitInput(), { now: NOW, idempotencyKey: 'visit-key-1' });
  assert.equal(first.outcome, 'applied');
  const replay = createVisit(store, storage, FATIMA, visitInput(), { now: '2026-03-12T18:00:00Z', idempotencyKey: 'visit-key-1' });
  assert.equal(replay.outcome, 'applied');
  if (replay.outcome === 'applied' && first.outcome === 'applied') {
    assert.equal(replay.replayed, true);
    assert.equal(replay.visit.id, first.visit.id);
    assert.equal(replay.auditEvent, null, 'no new mutation on replay');
    assert.equal(replay.outboxEvent, null);
  }
  assert.equal(store.visits.length, 1, 'replay appends nothing');

  const conflict = createVisit(store, storage, FATIMA, visitInput({ notes: 'different body' }), { now: NOW, idempotencyKey: 'visit-key-1' });
  assert.equal(conflict.outcome, 'conflict');
  if (conflict.outcome === 'conflict') {
    assert.equal(conflict.status, 409);
    assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(conflict.recordedVisitId, first.outcome === 'applied' ? first.visit.id : '');
  }
  assert.equal(store.visits.length, 1, 'conflict appends nothing');
});

test('audit before/after summaries and the correlated outbox event land in one transaction', () => {
  const { store, storage } = freshStore();
  const decision = createVisit(store, storage, FATIMA, visitInput(), { now: NOW, idempotencyKey: 'corr-key-1' });
  assert.equal(decision.outcome, 'applied');
  if (decision.outcome !== 'applied') return;
  const { audit: auditEvent, outbox } = evidenceForVisit(store, decision.auditEvent!.correlationId);
  assert.ok(auditEvent);
  assert.ok(outbox);
  assert.equal(auditEvent.visitId, decision.visit.id);
  assert.equal(auditEvent.before.visitCount, 0);
  assert.equal(auditEvent.after.visitCount, 1);
  assert.equal(auditEvent.after.lastChecked, decision.visit.lastChecked);
  assert.equal(auditEvent.internalAttachmentCount, 0);
  // The publication-refresh event lists the PUBLIC attachment id only.
  assert.deepEqual(outbox!.publicAttachmentIds, decision.visit.attachments.filter((a) => a.visibility === 'public').map((a) => a.id));
});
