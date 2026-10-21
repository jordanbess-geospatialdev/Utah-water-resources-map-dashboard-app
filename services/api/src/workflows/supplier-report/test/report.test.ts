/**
 * Draft/submission lifecycle tests (WD-017; FR-053, FR-056, FR-057; T-06,
 * T-15). This is the suite named as task evidence.
 *
 * - draft CRUD is organization-isolated in both directions (get/list/update
 *   and the assigned system view);
 * - submit validates ALL categories first: errors block with the summary
 *   object attached, warnings are acknowledged into the submission;
 * - submit is an idempotent state machine: the same submission id retries
 *   return the ORIGINAL submitted record; the draft locks; a new version
 *   exists only after the reviewer-approved resubmission transition;
 * - attribution (submitter, submittedAt = injected clock, version) and the
 *   frozen contentHash are proven stable, and the PDF manifest matches the
 *   submitted version by contentHash equality;
 * - the assigned system view shows sources, historical discharge (null =
 *   unavailable, never zero) and ONLY this organization's history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SupplierReportStore,
  approveResubmission,
  createDraft,
  getDraft,
  listDrafts,
  listSubmissions,
  submit,
  systemView,
  updateSection,
  type SectionPatch,
} from '../report.ts';
import { buildPdfManifest, renderPdfTransport, serializeManifest } from '../pdf.ts';
import type { ReportSections, SubmittedReport } from '../types.ts';
import { BEAR, LATER, NOW, ORG_BEAR_USERS, ORG_CACHE, supplierDeps, validSections, WEBER } from './helpers.ts';
import { STANDARD_ACTORS } from '../world.ts';

const WILEY = STANDARD_ACTORS.WILEY;
const MORGAN = STANDARD_ACTORS.MORGAN;
const REVIEWER_CACHE = STANDARD_ACTORS.REVIEWER_CACHE;
const CY2026 = { basis: 'calendar-year', year: 2026 } as const;

function applyAll(deps: ReturnType<typeof supplierDeps>, store: SupplierReportStore, draftId: string, sections: ReportSections, actor: string): void {
  const patches: readonly SectionPatch[] = [
    { category: 'culinary-use', section: sections.culinaryUse },
    { category: 'source-inventory', section: sections.sourceInventory },
    { category: 'purchase-inventory', section: sections.purchaseInventory },
    { category: 'wholesale-inventory', section: sections.wholesaleInventory },
    { category: 'return-inventory', section: sections.returnInventory },
    { category: 'source-peak-demand', section: sections.sourcePeakDemand },
    { category: 'secondary-use', section: sections.secondaryUse },
  ];
  for (const patch of patches) {
    const result = updateSection(deps, store, draftId, patch, actor);
    assert.equal(result.outcome, 'allowed', patch.category);
  }
}

/** A store with one fully valid Bear River draft prepared by Wiley. */
function storeWithValidDraft(): { store: SupplierReportStore; draftId: string } {
  const deps = supplierDeps(NOW);
  const store = new SupplierReportStore();
  const draft = createDraft(deps, store, { systemId: BEAR, period: CY2026 }, WILEY);
  assert.equal(draft.outcome, 'allowed');
  applyAll(deps, store, draft.value.draftId, validSections(), WILEY);
  return { store, draftId: draft.value.draftId };
}

test('the organization comes from the assignment, never the request; drafts list org-isolated both directions', () => {
  const deps = supplierDeps(NOW);
  const store = new SupplierReportStore();
  const bear = createDraft(deps, store, { systemId: BEAR, period: CY2026 }, WILEY);
  assert.equal(bear.outcome, 'allowed');
  assert.equal(bear.value.orgId, ORG_CACHE);

  const weber = createDraft(deps, store, { systemId: WEBER, period: CY2026 }, MORGAN);
  assert.equal(weber.outcome, 'allowed');
  assert.equal(weber.value.orgId, ORG_BEAR_USERS);

  const wileyList = listDrafts(deps, store, WILEY);
  assert.equal(wileyList.outcome, 'allowed');
  assert.deepEqual(wileyList.value.map((draft) => draft.draftId), [bear.value.draftId]);

  const morganList = listDrafts(deps, store, MORGAN);
  assert.equal(morganList.outcome, 'allowed');
  assert.deepEqual(morganList.value.map((draft) => draft.draftId), [weber.value.draftId]);
});

test('cross-supplier draft access is a hidden 404 in both directions (get and update)', () => {
  const deps = supplierDeps(NOW);
  const store = new SupplierReportStore();
  const bear = createDraft(deps, store, { systemId: BEAR, period: CY2026 }, WILEY);
  const weber = createDraft(deps, store, { systemId: WEBER, period: CY2026 }, MORGAN);
  assert.equal(bear.outcome, 'allowed');
  assert.equal(weber.outcome, 'allowed');

  const morganReadsBear = getDraft(deps, store, bear.value.draftId, MORGAN);
  assert.equal(morganReadsBear.outcome, 'denied');
  if (morganReadsBear.outcome === 'denied') {
    assert.equal(morganReadsBear.status, 404);
    assert.equal(morganReadsBear.policyReason, 'DENY_OUT_OF_SCOPE');
  }

  const wileyReadsWeber = getDraft(deps, store, weber.value.draftId, WILEY);
  assert.equal(wileyReadsWeber.outcome, 'denied');
  if (wileyReadsWeber.outcome === 'denied') assert.equal(wileyReadsWeber.status, 404);

  const crossUpdate = updateSection(deps, store, bear.value.draftId, { category: 'culinary-use', section: validSections().culinaryUse }, MORGAN);
  assert.equal(crossUpdate.outcome, 'denied');
  if (crossUpdate.outcome === 'denied') assert.equal(crossUpdate.status, 404);
});

test('opening the same (system, period) twice is idempotent; a bad period year is 422', () => {
  const deps = supplierDeps(NOW);
  const store = new SupplierReportStore();
  const first = createDraft(deps, store, { systemId: BEAR, period: CY2026 }, WILEY);
  const second = createDraft(deps, store, { systemId: BEAR, period: CY2026 }, WILEY);
  assert.equal(second.outcome, 'allowed');
  assert.equal(second.value.draftId, first.value.draftId);
  assert.equal(listDrafts(deps, store, WILEY).value.length, 1);

  const bad = createDraft(deps, store, { systemId: BEAR, period: { basis: 'calendar-year', year: 3025 } }, WILEY);
  assert.equal(bad.outcome, 'denied');
  if (bad.outcome === 'denied') assert.equal(bad.code, 'INVALID_PERIOD');
});

test('submit validates ALL categories first: errors block with the summary object attached', () => {
  const deps = supplierDeps(NOW);
  const store = new SupplierReportStore();
  const draft = createDraft(deps, store, { systemId: BEAR, period: CY2026 }, WILEY);
  assert.equal(draft.outcome, 'allowed');
  // Only culinary use filled: everything else missing.
  updateSection(deps, store, draft.value.draftId, { category: 'culinary-use', section: validSections().culinaryUse }, WILEY);

  const result = submit(deps, store, draft.value.draftId, WILEY, { submissionId: 'sub-err-1' });
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.equal(result.status, 422);
    assert.equal(result.code, 'VALIDATION_FAILED');
    const denial = result as import('../report.ts').SupplierDenial;
    assert.ok(denial.issues && denial.issues.length > 0, 'field-level issues attached');
    assert.ok(denial.summary, 'the error SUMMARY object attached');
    assert.match(denial.summary!.headline, /errors and .* warnings/);
    assert.ok(denial.summary!.lines.length > 0);
    assert.ok(denial.issues!.some((issue) => issue.fieldPath === 'sourceInventory'));
  }
  // Nothing was submitted; the draft is still a draft.
  assert.equal(store.draftById(draft.value.draftId)!.status, 'draft');
  assert.equal(store.submissionById('sub-err-1'), null);
});

test('submit freezes a valid draft with attribution: submitter, injected clock, version 1, contentHash, PDF manifest', () => {
  const { store, draftId } = storeWithValidDraft();
  const outcome = submit(supplierDeps(LATER), store, draftId, WILEY, { submissionId: 'sub-v1' });
  assert.equal(outcome.outcome, 'allowed');
  if (outcome.outcome !== 'allowed') return;
  const submission = outcome.value.submission;

  assert.equal(outcome.value.replayed, false);
  assert.equal(outcome.value.superseded, null);
  assert.equal(submission.version, 1);
  assert.equal(submission.submitter, WILEY);
  assert.equal(submission.submittedAt, LATER, 'submittedAt is the injected clock, verbatim');
  assert.match(submission.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(submission.pdf.manifestVersion, 1);
  assert.match(submission.pdf.manifestHash, /^[0-9a-f]{64}$/);

  const manifest = buildPdfManifest(submission);
  assert.equal(manifest.submittedContentHash, submission.contentHash, 'the PDF manifest carries the submitted content hash');
  assert.equal(manifest.manifestHash, submission.pdf.manifestHash, 'the stored manifest reference equals a rebuilt manifest');
  assert.equal(manifest.submitter, WILEY);
  assert.equal(manifest.submittedVersion, 1);
});

test('submit retries are idempotent: the same submission id returns the ORIGINAL record', () => {
  const { store, draftId } = storeWithValidDraft();
  const first = submit(supplierDeps(LATER), store, draftId, WILEY, { submissionId: 'sub-idem' });
  assert.equal(first.outcome, 'allowed');
  const original: SubmittedReport = first.outcome === 'allowed' ? first.value.submission : (null as never);

  const retryWithId = submit(supplierDeps('2027-01-01T00:00:00Z'), store, draftId, WILEY, { submissionId: 'sub-idem' });
  assert.equal(retryWithId.outcome, 'allowed');
  if (retryWithId.outcome === 'allowed') {
    assert.equal(retryWithId.value.replayed, true);
    assert.deepEqual(retryWithId.value.submission, original, 'the ORIGINAL submitted record replays, even with a different clock');
  }

  const retryWithoutId = submit(supplierDeps(LATER), store, draftId, WILEY);
  assert.equal(retryWithoutId.outcome, 'allowed');
  if (retryWithoutId.outcome === 'allowed') {
    assert.equal(retryWithoutId.value.replayed, true);
    assert.deepEqual(retryWithoutId.value.submission, original);
  }
  // Exactly one submission exists.
  assert.equal(listSubmissions(supplierDeps(LATER), store, WILEY).value.length, 1);
});

test('a submission id belongs to exactly one draft (no cross-draft id reuse)', () => {
  const deps = supplierDeps(NOW);
  const store = new SupplierReportStore();
  const a = createDraft(deps, store, { systemId: BEAR, period: CY2026 }, WILEY);
  const b = createDraft(deps, store, { systemId: BEAR, period: { basis: 'water-year', year: 2026 } }, WILEY);
  applyAll(deps, store, a.value.draftId, validSections(), WILEY);
  applyAll(deps, store, b.value.draftId, { ...validSections(), sourcePeakDemand: { peakDayDate: '2026-03-05', peakDayVolumeGallons: 7_000_000, peakHourDemandGpm: 3_100 } }, WILEY);
  const first = submit(deps, store, a.value.draftId, WILEY, { submissionId: 'sub-shared' });
  assert.equal(first.outcome, 'allowed');
  const reused = submit(deps, store, b.value.draftId, WILEY, { submissionId: 'sub-shared' });
  assert.equal(reused.outcome, 'denied');
  if (reused.outcome === 'denied') assert.equal(reused.code, 'SUBMISSION_ID_REUSED');
});

test('the submitted draft is frozen: section updates are denied and the content never changes', () => {
  const { store, draftId } = storeWithValidDraft();
  const outcome = submit(supplierDeps(LATER), store, draftId, WILEY);
  assert.equal(outcome.outcome, 'allowed');
  const frozen = updateSection(supplierDeps(LATER), store, draftId, { category: 'culinary-use', section: validSections().culinaryUse }, WILEY);
  assert.equal(frozen.outcome, 'denied');
  if (frozen.outcome === 'denied') assert.equal(frozen.code, 'DRAFT_LOCKED');

  const after = listSubmissions(supplierDeps(LATER), store, WILEY).value[0]!;
  assert.equal(after.content.contentHash ?? after.contentHash, after.contentHash);
  assert.equal(after.content.culinaryUse.populationServed, validSections().culinaryUse.populationServed);
});

test('a new version requires the approved resubmission path (the state machine)', () => {
  const { store, draftId } = storeWithValidDraft();
  const deps = supplierDeps(LATER);
  const v1 = submit(deps, store, draftId, WILEY, { submissionId: 'sub-v1' });
  assert.equal(v1.outcome, 'allowed');

  // While v1 is 'submitted', the period is locked: no new draft, no v2.
  const locked = createDraft(deps, store, { systemId: BEAR, period: CY2026 }, WILEY);
  assert.equal(locked.outcome, 'denied');
  if (locked.outcome === 'denied') assert.equal(locked.code, 'SUBMISSION_LOCKED');

  // The proposing supplier cannot self-approve the resubmission.
  const self = approveResubmission(deps, store, 'sub-v1', WILEY, 'self approve');
  assert.equal(self.outcome, 'denied');
  if (self.outcome === 'denied') assert.equal(self.code, 'REVIEWER_REQUIRED');

  // The reviewer of the OTHER organization is hidden.
  const crossReviewer = approveResubmission(deps, store, 'sub-v1', STANDARD_ACTORS.REVIEWER_BEAR, 'cross');
  assert.equal(crossReviewer.outcome, 'denied');
  if (crossReviewer.outcome === 'denied') assert.equal(crossReviewer.status, 404);

  // The reviewer of this organization approves; the CONTENT stays frozen.
  const approved = approveResubmission(deps, store, 'sub-v1', REVIEWER_CACHE, 'source inventory correction requested');
  assert.equal(approved.outcome, 'allowed');
  if (approved.outcome === 'allowed') {
    assert.equal(approved.value.status, 'resubmission-approved');
    assert.equal(approved.value.contentHash, v1.outcome === 'allowed' ? v1.value.submission.contentHash : '', 'resubmission approval never changes the content hash');
    assert.equal(approved.value.resubmissionApprovedBy, REVIEWER_CACHE);
    assert.equal(approved.value.resubmissionApprovedAt, LATER);
    assert.deepEqual(approved.value.content, v1.outcome === 'allowed' ? v1.value.submission.content : null);
  }

  // The same approval cannot repeat.
  const twice = approveResubmission(deps, store, 'sub-v1', REVIEWER_CACHE, 'again');
  assert.equal(twice.outcome, 'denied');
  if (twice.outcome === 'denied') assert.equal(twice.code, 'RESUBMISSION_ALREADY_APPROVED');

  // A new draft opens, and its submission becomes version 2 superseding v1.
  const draft2 = createDraft(deps, store, { systemId: BEAR, period: CY2026 }, WILEY);
  assert.equal(draft2.outcome, 'allowed');
  applyAll(deps, store, draft2.value.draftId, { ...validSections(), culinaryUse: { populationServed: 52_400, activeConnections: 14_350, annualCulinaryVolumeGallons: 1_850_000_000, meteredPercent: 97 } }, WILEY);
  const v2 = submit(deps, store, draft2.value.draftId, WILEY, { submissionId: 'sub-v2' });
  assert.equal(v2.outcome, 'allowed');
  if (v2.outcome === 'allowed') {
    assert.equal(v2.value.submission.version, 2);
    assert.equal(v2.value.superseded, 'sub-v1');
    assert.notEqual(v2.value.submission.contentHash, v1.outcome === 'allowed' ? v1.value.submission.contentHash : '');
    // v1 remains queryable and untouched.
    assert.equal(store.submissionById('sub-v1')!.version, 1);
    assert.equal(store.supersededByOf('sub-v1'), 'sub-v2');
  }
});

test('the resubmission reviewer of a foreign submission is hidden (404)', () => {
  const deps = supplierDeps(NOW);
  const store = new SupplierReportStore();
  const weber = createDraft(deps, store, { systemId: WEBER, period: CY2026 }, MORGAN);
  assert.equal(weber.outcome, 'allowed');
  applyAll(deps, store, weber.value.draftId, { ...validSections(), sourcePeakDemand: { peakDayDate: '2026-05-30', peakDayVolumeGallons: 4_000_000, peakHourDemandGpm: 2_000 } }, MORGAN);
  const submitted = submit(deps, store, weber.value.draftId, MORGAN, { submissionId: 'sub-weber-1' });
  assert.equal(submitted.outcome, 'allowed');
  // Wiley (the other supplier) is out of scope on Weber: the submission is
  // HIDDEN from him (404) before any reviewer-vs-supplier distinction applies.
  const cross = approveResubmission(deps, store, 'sub-weber-1', WILEY, 'nope');
  assert.equal(cross.outcome, 'denied');
  if (cross.outcome === 'denied') {
    assert.equal(cross.status, 404);
    assert.equal(cross.policyReason, 'DENY_OUT_OF_SCOPE');
  }
  // Cache reviewer is out of scope on Weber as well (hidden object).
  const foreign = approveResubmission(deps, store, 'sub-weber-1', REVIEWER_CACHE, 'nope');
  assert.equal(foreign.outcome, 'denied');
  if (foreign.outcome === 'denied') assert.equal(foreign.status, 404);
});

test('contentHash stability: identical content, actor and clock hash identically; any change re-hashes', () => {
  function freshSubmission(clock: string, sections: ReportSections, id: string): SubmittedReport {
    const deps = supplierDeps(clock);
    const store = new SupplierReportStore();
    const draft = createDraft(deps, store, { systemId: BEAR, period: CY2026 }, WILEY);
    applyAll(deps, store, draft.value.draftId, sections, WILEY);
    const outcome = submit(deps, store, draft.value.draftId, WILEY, { submissionId: id });
    assert.equal(outcome.outcome, 'allowed');
    return outcome.outcome === 'allowed' ? outcome.value.submission : (null as never);
  }
  const a = freshSubmission(LATER, validSections(), 'sub-hash-a');
  const b = freshSubmission(LATER, validSections(), 'sub-hash-b');
  assert.equal(b.contentHash, a.contentHash, 'same content + clock -> same hash');

  const changed = freshSubmission(LATER, { ...validSections(), secondaryUse: { irrigatedAcres: 400, secondaryConnections: 2_400, annualSecondaryVolumeGallons: 480_000_000, metered: true } }, 'sub-hash-c');
  assert.notEqual(changed.contentHash, a.contentHash, 'changed content -> different hash');

  const otherClock = freshSubmission('2026-05-01T00:00:00Z', validSections(), 'sub-hash-d');
  assert.notEqual(otherClock.contentHash, a.contentHash, 'attribution (submittedAt) is part of the hash');
});

test('the PDF manifest is byte-stable and proves it matches the submitted version', () => {
  const { store, draftId } = storeWithValidDraft();
  const outcome = submit(supplierDeps(LATER), store, draftId, WILEY, { submissionId: 'sub-pdf' });
  assert.equal(outcome.outcome, 'allowed');
  const submission = outcome.outcome === 'allowed' ? outcome.value.submission : (null as never);

  const first = buildPdfManifest(submission);
  const second = buildPdfManifest(submission);
  assert.equal(serializeManifest(second), serializeManifest(first), 'byte-identical serialization');
  assert.deepEqual(second, first);

  // The PDF-matches-submission proof is contentHash equality.
  assert.equal(first.submittedContentHash, submission.contentHash);
  assert.ok(first.blocks.some((block) => block.kind === 'hash-footer' && block.hash === submission.contentHash));
  assert.ok(first.blocks.some((block) => block.kind === 'meta' && block.value === WILEY));

  // A manifest of a different submission does not match.
  const changedStore = new SupplierReportStore();
  const changedDeps = supplierDeps(LATER);
  const changedDraft = createDraft(changedDeps, changedStore, { systemId: BEAR, period: { basis: 'water-year', year: 2026 } }, WILEY);
  applyAll(changedDeps, changedStore, changedDraft.value.draftId, { ...validSections(), sourcePeakDemand: { peakDayDate: '2025-12-01', peakDayVolumeGallons: 8_800_000, peakHourDemandGpm: 4_100 } }, WILEY);
  const changed = submit(changedDeps, changedStore, changedDraft.value.draftId, WILEY, { submissionId: 'sub-pdf-2' });
  assert.equal(changed.outcome, 'allowed');
  const other = buildPdfManifest(changed.outcome === 'allowed' ? changed.value.submission : (null as never));
  assert.notEqual(other.manifestHash, first.manifestHash);
  assert.notEqual(other.submittedContentHash, first.submittedContentHash);
});

test('PDF rendering remains a transport concern: the stub throws', () => {
  const { store, draftId } = storeWithValidDraft();
  const outcome = submit(supplierDeps(LATER), store, draftId, WILEY);
  assert.equal(outcome.outcome, 'allowed');
  const manifest = buildPdfManifest(outcome.outcome === 'allowed' ? outcome.value.submission : (null as never));
  assert.throws(() => renderPdfTransport({ manifest, requesterId: WILEY }), /not implemented - transport concern/);
});

test('the assigned system view shows sources, history and only this organization (FR-053)', () => {
  const deps = supplierDeps(NOW);
  const store = new SupplierReportStore();
  const draft = createDraft(deps, store, { systemId: BEAR, period: CY2026 }, WILEY);
  applyAll(deps, store, draft.value.draftId, validSections(), WILEY);
  const submitted = submit(deps, store, draft.value.draftId, WILEY, { submissionId: 'sub-view-1' });
  assert.equal(submitted.outcome, 'allowed');

  const view = systemView(deps, store, WILEY, BEAR);
  assert.equal(view.outcome, 'allowed');
  if (view.outcome !== 'allowed') return;
  assert.equal(view.value.orgId, ORG_CACHE);
  assert.equal(view.value.orgName, 'Cache Water Conservancy District');
  assert.ok(view.value.sources.length >= 1);
  assert.ok(view.value.sources.some((source) => source.stationId === 'sta-hyrum-diversion-owner'));

  // Historical discharge: the owned restricted stream has 2026 data; 2024
  // and 2025 are honestly null (unavailable, never zero).
  const row = view.value.historicalDischarge.find((candidate) => candidate.streamId === 'str-hyrum-q-owner');
  assert.ok(row, 'the owner stream appears in the supplier history');
  const byYear = new Map(row.years.map((year) => [year.year, year.volumeAcreFeet]));
  assert.equal(byYear.get(2024), null);
  assert.equal(byYear.get(2025), null);
  assert.ok((byYear.get(2026) ?? 0) > 0);

  assert.equal(view.value.submittedHistory.length, 1);
  assert.equal(view.value.submittedHistory[0]!.submissionId, 'sub-view-1');
  assert.equal(view.value.inventorySnapshot.kind, 'submitted');

  // Morgan sees NONE of this on Bear River (hidden object).
  const cross = systemView(deps, store, MORGAN, BEAR);
  assert.equal(cross.outcome, 'denied');
  if (cross.outcome === 'denied') assert.equal(cross.status, 404);
});

test('submissions list is organization-isolated (Wiley never sees Morgan submissions)', () => {
  const deps = supplierDeps(NOW);
  const store = new SupplierReportStore();
  const bear = createDraft(deps, store, { systemId: BEAR, period: CY2026 }, WILEY);
  applyAll(deps, store, bear.value.draftId, validSections(), WILEY);
  assert.equal(submit(deps, store, bear.value.draftId, WILEY, { submissionId: 'sub-iso-bear' }).outcome, 'allowed');

  const weber = createDraft(deps, store, { systemId: WEBER, period: CY2026 }, MORGAN);
  applyAll(deps, store, weber.value.draftId, { ...validSections(), sourcePeakDemand: { peakDayDate: '2026-06-02', peakDayVolumeGallons: 3_500_000, peakHourDemandGpm: 1_800 } }, MORGAN);
  assert.equal(submit(deps, store, weber.value.draftId, MORGAN, { submissionId: 'sub-iso-weber' }).outcome, 'allowed');

  const wileySubmissions = listSubmissions(deps, store, WILEY).value;
  assert.deepEqual(wileySubmissions.map((s) => s.submissionId), ['sub-iso-bear']);
  const morganSubmissions = listSubmissions(deps, store, MORGAN).value;
  assert.deepEqual(morganSubmissions.map((s) => s.submissionId), ['sub-iso-weber']);
});

test('acknowledged warnings ride along into the frozen submission and its PDF manifest', () => {
  const deps = supplierDeps(LATER);
  const store = new SupplierReportStore();
  const draft = createDraft(deps, store, { systemId: BEAR, period: CY2026 }, WILEY);
  assert.equal(draft.outcome, 'allowed');
  const withWarning: ReportSections = { ...validSections(), sourcePeakDemand: { peakDayDate: '2026-07-12', peakDayVolumeGallons: 9_500_000, peakHourDemandGpm: 90_000 } };
  applyAll(deps, store, draft.value.draftId, withWarning, WILEY);
  const stored = store.draftById(draft.value.draftId)!;
  assert.equal(stored.validation.summary.warningCount, 1);
  assert.equal(stored.validation.summary.errorCount, 0);

  const outcome = submit(deps, store, draft.value.draftId, WILEY, { submissionId: 'sub-warn' });
  assert.equal(outcome.outcome, 'allowed');
  if (outcome.outcome !== 'allowed') return;
  assert.equal(outcome.value.submission.acknowledgedWarnings.length, 1);
  assert.equal(outcome.value.submission.acknowledgedWarnings[0]!.fieldPath, 'sourcePeakDemand.peakHourDemandGpm');
  const manifest = buildPdfManifest(outcome.value.submission);
  assert.equal(manifest.acknowledgedWarnings.length, 1);
  assert.match(manifest.acknowledgedWarnings[0]!.message, /plausible range/);
});
