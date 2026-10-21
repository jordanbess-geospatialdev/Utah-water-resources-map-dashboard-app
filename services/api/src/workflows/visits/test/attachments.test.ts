/**
 * WD-012 visibility-wall tests (verification rows T-03/T-10, evidence file
 * for the task): the FR-049 wall - public APIs, thumbnails, exports and
 * report generation can never retrieve an internal photo, note, gate code
 * or wiring detail.
 *
 * Run (zero dependencies):
 *   cd services/api && node --test --experimental-strip-types src/workflows/visits/test/attachments.test.ts
 *
 * The sweep tests are byte-level: every public-facing artifact this module
 * can produce is JSON.stringified and asserted free of every internal
 * canary (attachment ids, filename hints, wiring-note text, object refs,
 * hashes) - the attachment twin of the station gate-code canary sweep.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVisitStore } from '../store.ts';
import {
  collectInternalCanaries,
  createPlaceholderAttachmentStorage,
  exportManifest,
  internalAttachmentList,
  publicAttachmentViews,
  publicVisitHistory,
  type AttachmentStorage,
} from '../attachments.ts';
import { createVisit } from '../visits.ts';
import type { CreateVisitInput } from '../types.ts';

const SITE = 'sta-bear-corinne'; // public, active, Bear River (carries the gate-code internal block)
const HYRUM_OWNER = 'sta-hyrum-diversion-owner'; // restricted site: hidden for out-of-scope principals
const FATIMA = 'principal-fatima-engineer'; // field-visits + view-internal-diagnostics @ Bear River
const PRIYA = 'principal-priya-engineer'; // field-visits + edit-site-metadata @ Weber River (out of scope here)
const CODY = 'principal-cody-commissioner'; // Bear commissioner: no internal-field read capability
const DIEGO = 'principal-diego-steward'; // statewide administration
const SARAH = 'principal-sarah-researcher';

const NOW = '2026-03-12T16:00:00Z';

const WIRING_NOTE_TEXT = 'Gate code 4471-CDX; RTU enclosure on east abutment, solar controller replaced 2026-03-02. Lock combo rotates quarterly.';
const INTERNAL_PHOTO_FILE = 'rtu-enclosure-internal-2026-03-12.jpg';
const PUBLIC_PHOTO_FILE = 'corinne-gauge-plate-2026-03-12.jpg';

function mixedVisitInput(siteId = SITE): CreateVisitInput {
  return {
    siteId,
    visitTime: '2026-03-12T15:30:00Z',
    type: 'inspection',
    actionIds: ['gauge-inspection'],
    notes: 'Inspection visit notes: control box lock was sticky.', // internal-class visit note
    lastChecked: '2026-03-12T15:00:00Z',
    lastRated: null,
    attachments: [
      {
        category: 'photo',
        visibility: 'public',
        filename: PUBLIC_PHOTO_FILE,
        captureTime: '2026-03-12T15:10:00Z',
        sizeBytes: 2400,
        content: 'JPEG-bytes:gauge-plate-public',
      },
      {
        category: 'photo',
        visibility: 'internal',
        filename: INTERNAL_PHOTO_FILE,
        captureTime: '2026-03-12T15:12:00Z',
        sizeBytes: 3100,
        content: 'JPEG-bytes:rtu-enclosure-internal',
      },
      {
        category: 'wiring-note',
        visibility: 'internal',
        filename: 'wiring-notes-2026-03.txt',
        captureTime: '2026-03-12T15:15:00Z',
        note: WIRING_NOTE_TEXT,
        sizeBytes: WIRING_NOTE_TEXT.length,
        content: WIRING_NOTE_TEXT,
      },
      {
        category: 'document',
        visibility: 'public',
        filename: 'inspection-checklist-2026-03.pdf',
        captureTime: '2026-03-12T15:20:00Z',
        sizeBytes: 900,
        content: 'PDF-bytes:inspection-checklist',
      },
    ],
  };
}

function seedMixedVisits() {
  const store = createVisitStore();
  const storage = createPlaceholderAttachmentStorage();
  const decision = createVisit(store, storage, FATIMA, mixedVisitInput(), { now: NOW });
  assert.equal(decision.outcome, 'applied');
  return { store, storage, visit: decision.outcome === 'applied' ? decision.visit : null! };
}

/** Every public-facing artifact this module can produce for a site. */
function publicArtifacts(store: ReturnType<typeof createVisitStore>, storage: AttachmentStorage, siteId: string): Record<string, unknown> {
  return {
    publicAttachmentViews: publicAttachmentViews(store, storage, siteId),
    publicVisitHistory: publicVisitHistory(store, storage, siteId),
    exportManifest: exportManifest(store, siteId),
    siteSummary: store.summaryFor(siteId),
  };
}

// ---------------------------------------------------------------------------
// Projection wall: internal attachments and internal fields are stripped
// ---------------------------------------------------------------------------

test('public attachment list carries public attachments only, with public fields only', () => {
  const { store, storage } = seedMixedVisits();
  const views = publicAttachmentViews(store, storage, SITE);
  assert.equal(views.length, 2, 'the internal photo and the wiring note are stripped before projection');
  assert.deepEqual(
    views.map((view) => view.filename),
    [PUBLIC_PHOTO_FILE, 'inspection-checklist-2026-03.pdf'],
  );
  for (const view of views) {
    assert.ok('thumbnailPath' in view && view.thumbnailPath.startsWith('/cache/attachments/'));
    assert.ok(!('note' in view), 'no note field on the public view');
    assert.ok(!('retentionClass' in view), 'retention class is internal metadata');
    assert.ok(!('objectRef' in view), 'the storage object reference never enters the public payload');
    assert.ok(!('sha256' in view), 'hashes are internal evidence');
  }
});

test('public visit history strips actor ids, visit notes and internal attachments entirely', () => {
  const { store, storage } = seedMixedVisits();
  const history = publicVisitHistory(store, storage, SITE);
  assert.equal(history.length, 1);
  const visit = history[0]!;
  assert.ok(!('actorId' in visit), 'actor identity is not part of the public visit projection');
  assert.ok(!('notes' in visit), 'visit notes are internal-class (engineer field work row)');
  assert.equal(visit.publicAttachments.length, 2);
  assert.equal(visit.internalAttachmentCount, null, 'not even a count hint of internal attachments');
  assert.equal(visit.lastChecked, '2026-03-12T15:00:00Z', 'structured dates are public queryable fields');
});

test('unpublished sites have no public projection at all', () => {
  const { store, storage } = seedMixedVisits();
  // The restricted owner site gets a visit from Fatima (in scope), but its
  // attachments can never be projected publicly.
  const seeded = createVisit(store, storage, FATIMA, mixedVisitInput(HYRUM_OWNER), { now: '2026-03-12T17:00:00Z' });
  assert.equal(seeded.outcome, 'applied');
  assert.equal(publicAttachmentViews(store, storage, HYRUM_OWNER).length, 0);
  assert.equal(publicVisitHistory(store, storage, HYRUM_OWNER).length, 0);
  const unknown = publicAttachmentViews(store, storage, 'sta-nope');
  assert.equal(unknown.length, 0);
});

// ---------------------------------------------------------------------------
// Byte-level canary sweep (the FR-049 acceptance, attachment twin)
// ---------------------------------------------------------------------------

test('byte sweep: no internal canary appears in ANY public-facing serialization', () => {
  const { store, storage } = seedMixedVisits();
  const canaries = collectInternalCanaries(store, SITE);
  assert.ok(canaries.length >= 5, 'the seeded visit contributes internal canaries');
  assert.ok(canaries.includes(WIRING_NOTE_TEXT));
  assert.ok(canaries.includes(INTERNAL_PHOTO_FILE));

  const artifacts = publicArtifacts(store, storage, SITE);
  for (const [name, artifact] of Object.entries(artifacts)) {
    const serialized = JSON.stringify(artifact);
    for (const canary of canaries) {
      assert.ok(!serialized.includes(canary), `${name} leaks internal canary "${canary.slice(0, 40)}"`);
    }
    // Structural markers that reveal the existence of internal rows.
    assert.ok(!serialized.includes('"visibility":"internal"'), `${name} reveals internal visibility`);
    assert.ok(!serialized.includes('placeholder://'), `${name} leaks a storage object reference`);
  }

  // The outbox publication event is itself a public artifact (cache refresh).
  const outboxSerialized = JSON.stringify(store.outboxEvents);
  for (const canary of canaries) {
    assert.ok(!outboxSerialized.includes(canary), `outbox event leaks "${canary.slice(0, 40)}"`);
  }
  assert.ok(!outboxSerialized.includes('wiring-note'), 'the wiring-note category never appears on publication events');
});

// ---------------------------------------------------------------------------
// Storage wall: per-visibility checks at EVERY accessor
// ---------------------------------------------------------------------------

test('storage publicRead and publicThumbnail refuse internal objects at every call', () => {
  const { store, storage } = seedMixedVisits();
  const internal = store.attachmentsForSite(SITE).filter((attachment) => attachment.visibility === 'internal');
  assert.equal(internal.length, 2);
  for (const attachment of internal) {
    const read = storage.publicRead(attachment.objectRef);
    assert.equal(read.allowed, false, `${attachment.id} publicRead`);
    if (!read.allowed) {
      assert.equal(read.code, 'ATTACHMENT_INTERNAL');
      assert.ok(read.message.includes('FR-049'));
    }
    const thumb = storage.publicThumbnail(attachment.objectRef);
    assert.equal(thumb.allowed, false, `${attachment.id} publicThumbnail`);
    if (!thumb.allowed) assert.equal(thumb.code, 'ATTACHMENT_INTERNAL');
  }
  const ghost = storage.publicRead('placeholder://attachments/att-9999');
  assert.equal(ghost.allowed, false);
  if (!ghost.allowed) assert.equal(ghost.code, 'ATTACHMENT_UNKNOWN');

  // Public objects pass every public accessor.
  const publicAttachments = store.attachmentsForSite(SITE).filter((attachment) => attachment.visibility === 'public');
  for (const attachment of publicAttachments) {
    assert.equal(storage.publicRead(attachment.objectRef).allowed, true);
    assert.equal(storage.publicThumbnail(attachment.objectRef).allowed, true);
  }
});

test('storage internalRead demands BOTH a policy grant and internal visibility', () => {
  const { store, storage } = seedMixedVisits();
  const wiringNote = store.attachmentsForSite(SITE).find((attachment) => attachment.category === 'wiring-note')!;
  // No grant carried: refused even for the right object.
  const refused = storage.internalRead(wiringNote.objectRef, {
    actorId: FATIMA,
    siteId: SITE,
    matchedAssignmentIds: [],
    evaluatedAt: NOW,
  });
  assert.equal(refused.allowed, false);
  if (!refused.allowed) assert.equal(refused.code, 'GRANT_REQUIRED');

  // A real grant (from the internal list decision) opens the internal read.
  const allowed = internalAttachmentList(store, FATIMA, SITE, NOW);
  assert.equal(allowed.outcome, 'allowed');
  if (allowed.outcome === 'allowed') {
    assert.ok(allowed.grant.matchedAssignmentIds.length > 0);
    const read = storage.internalRead(wiringNote.objectRef, allowed.grant);
    assert.equal(read.allowed, true);
    if (read.allowed) assert.equal(read.content, WIRING_NOTE_TEXT);
  }
});

test('integrity: sha256 recorded at attach; tampering with stored bytes is detected', () => {
  const { store, storage } = seedMixedVisits();
  const publicPhoto = store.attachmentsForSite(SITE).find((attachment) => attachment.filename === PUBLIC_PHOTO_FILE)!;
  // The hash recorded at attach (in the append-only visit log) matches the bytes.
  const verdict = storage.verifyIntegrity(publicPhoto.objectRef);
  assert.ok(verdict);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.actualSha256, publicPhoto.sha256, 'hash recorded at attach matches the stored bytes');

  // Tamper simulation: storage-level corruption re-stamps the storage's own
  // record, but CANNOT rewrite the hash the append-only visit log recorded
  // at attach - comparing the two detects the mutation.
  const victim = createPlaceholderAttachmentStorage();
  const attachTime = victim.put({ id: 'att-x', visibility: 'public', content: 'JPEG-bytes:original' });
  victim.put({ id: 'att-x', visibility: 'public', content: 'JPEG-bytes:MUTATED' });
  const tampered = victim.verifyIntegrity(attachTime.objectRef);
  assert.ok(tampered);
  assert.notEqual(tampered.actualSha256, attachTime.sha256, 'the attach-time hash no longer matches the stored bytes: tampering detected');
});

// ---------------------------------------------------------------------------
// Export / report manifest: hard-walled to public attachments
// ---------------------------------------------------------------------------

test('export manifest lists public attachments only, whoever asks', () => {
  const { store } = seedMixedVisits();
  const manifest = exportManifest(store, SITE);
  assert.equal(manifest.visibilityPolicy, 'public-attachments-only');
  assert.equal(manifest.attachmentCount, 2);
  assert.ok(manifest.rows.every((row) => !row.filename.includes('internal')));
  assert.ok(manifest.rows.every((row) => row.category !== 'wiring-note'));
  const serialized = JSON.stringify(manifest);
  for (const canary of collectInternalCanaries(store, SITE)) {
    assert.ok(!serialized.includes(canary), `export manifest leaks "${canary.slice(0, 40)}"`);
  }
});

test('report generation path: exportRead serves public objects and refuses internal ones at every call', () => {
  const { store, storage } = seedMixedVisits();
  const manifest = exportManifest(store, SITE);
  for (const row of manifest.rows) {
    const attachment = store.attachmentById(row.attachmentId)!;
    const read = storage.exportRead(attachment.objectRef);
    assert.equal(read.allowed, true, row.filename);
  }
  // Even the steward (statewide) cannot pull an internal object through the
  // export path: the wall is structural, not actor-gated.
  const internalAttachment = store.attachmentsForSite(SITE).find((attachment) => attachment.visibility === 'internal')!;
  const refused = storage.exportRead(internalAttachment.objectRef);
  assert.equal(refused.allowed, false);
  if (!refused.allowed) {
    assert.equal(refused.code, 'ATTACHMENT_INTERNAL');
    assert.ok(refused.message.includes('exports and report generation can never retrieve it'));
  }
});

// ---------------------------------------------------------------------------
// Internal list: policy-gated engineer/steward in scope (projection semantics)
// ---------------------------------------------------------------------------

test('internal list admits the assigned engineer carrying an internal-field read capability', () => {
  const { store } = seedMixedVisits();
  const decision = internalAttachmentList(store, FATIMA, SITE, NOW);
  assert.equal(decision.outcome, 'allowed');
  if (decision.outcome === 'allowed') {
    assert.equal(decision.rows.length, 2);
    const wiring = decision.rows.find((row) => row.category === 'wiring-note')!;
    assert.equal(wiring.note, WIRING_NOTE_TEXT, 'the internal view carries the wiring note text');
    assert.equal(wiring.retentionClass, 'extended', 'default retention class for wiring notes');
    assert.ok(wiring.objectRef.startsWith('placeholder://attachments/'));
    assert.equal(wiring.sha256.length, 64, 'sha256 recorded at attach');
  }
});

test('internal list denies the commissioner (no internal-field capability) with 403', () => {
  const { store } = seedMixedVisits();
  const decision = internalAttachmentList(store, CODY, SITE, NOW);
  assert.equal(decision.outcome, 'denied');
  if (decision.outcome === 'denied') {
    assert.equal(decision.status, 403);
    assert.equal(decision.policyReason, 'DENY_FIELD_VISIBILITY', 'assignment over the site is not sufficient for internal fields');
  }
});

test('internal list hides non-public sites from out-of-scope principals (404) and refuses capability-less actors (403)', () => {
  const store = createVisitStore();
  const storage = createPlaceholderAttachmentStorage();
  // Seed internal attachments on the restricted owner site (Fatima in scope).
  const seeded = createVisit(store, storage, FATIMA, mixedVisitInput(HYRUM_OWNER), { now: NOW });
  assert.equal(seeded.outcome === 'applied', true);

  const outOfScope = internalAttachmentList(store, PRIYA, HYRUM_OWNER, NOW);
  assert.equal(outOfScope.outcome, 'denied');
  if (outOfScope.outcome === 'denied') {
    assert.equal(outOfScope.status, 404, 'restricted site: does not exist for the Weber engineer');
    assert.equal(outOfScope.policyReason, 'DENY_OUT_OF_SCOPE');
  }
  // Sarah holds read-approved-datasets (a view-restricted-details satisfier)
  // but only as a dataset-scoped grant, so the station is out of scope: 403
  // on a public site, with the engine's own reason.
  const noScope = internalAttachmentList(store, SARAH, SITE, NOW);
  assert.equal(noScope.outcome, 'denied');
  if (noScope.outcome === 'denied') {
    assert.equal(noScope.status, 403);
    assert.equal(noScope.policyReason, 'DENY_OUT_OF_SCOPE');
  }
  const anonymous = internalAttachmentList(store, 'principal-ghost', SITE, NOW);
  assert.equal(anonymous.outcome, 'denied');
  if (anonymous.outcome === 'denied') {
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.code, 'UNAUTHENTICATED');
  }
  // Priya CAN read internal attachments of a Weber River site (she holds
  // edit-site-metadata there, an internal-field read capability) - but the
  // only Weber site is proposed, so no visits exist on it yet; the decision
  // still proves the gate opens in scope.
  const weber = internalAttachmentList(store, PRIYA, 'sta-ogden-valley-proposed', NOW);
  assert.equal(weber.outcome, 'allowed', 'in-scope internal-field capability admits the empty internal list');
  if (weber.outcome === 'allowed') assert.equal(weber.rows.length, 0);
});

test('steward reads internal attachments statewide', () => {
  const { store } = seedMixedVisits();
  const decision = internalAttachmentList(store, DIEGO, SITE, NOW);
  assert.equal(decision.outcome, 'allowed');
  if (decision.outcome === 'allowed') assert.equal(decision.rows.length, 2);
});

// ---------------------------------------------------------------------------
// Validation of the visibility mark itself
// ---------------------------------------------------------------------------

test('a wiring note can never be marked public: validation rejects the combination', () => {
  const store = createVisitStore();
  const storage = createPlaceholderAttachmentStorage();
  const input = mixedVisitInput();
  const forbidden: CreateVisitInput = {
    ...input,
    attachments: [
      {
        category: 'wiring-note',
        visibility: 'public',
        filename: 'oops.txt',
        captureTime: '2026-03-12T15:15:00Z',
        note: 'Gate code 0000.',
        sizeBytes: 14,
        content: 'Gate code 0000.',
      },
    ],
  };
  const decision = createVisit(store, storage, FATIMA, forbidden, { now: NOW });
  assert.equal(decision.outcome, 'rejected');
  if (decision.outcome === 'rejected') {
    assert.equal(decision.status, 422);
    assert.ok(decision.fieldErrors.some((error) => error.code === 'WIRING_NOTE_MUST_BE_INTERNAL'));
    assert.ok(decision.fieldErrors.some((error) => error.fieldPath === 'attachments[0].visibility'));
  }
  assert.equal(store.visits.length, 0);
  assert.equal(store.attachments.length, 0, 'a rejected visit leaves no attachment rows behind');
});
