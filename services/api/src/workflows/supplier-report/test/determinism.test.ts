/**
 * End-to-end determinism tests (WD-017; T-15): the ENTIRE supplier-report
 * journey, run twice from scratch with identical inputs and the injected
 * clock, produces byte-identical domain objects - draft ids, submitted
 * records (canonical serialization + content hash), PDF manifests and
 * boundary records. No clock reads, no randomness anywhere in the module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SupplierReportStore, approveResubmission, createDraft, submit, updateSection, type SectionPatch } from '../report.ts';
import { SupplierBoundaryStore, createBoundaryProposal, decideBoundaryProposal } from '../boundaries.ts';
import { buildPdfManifest, canonicalize, serializeManifest } from '../pdf.ts';
import type { ReportSections } from '../types.ts';
import { BEAR, LATER, NOW, supplierDeps, validSections } from './helpers.ts';
import { STANDARD_ACTORS } from '../world.ts';

const WILEY = STANDARD_ACTORS.WILEY;
const REVIEWER_CACHE = STANDARD_ACTORS.REVIEWER_CACHE;
const CY2026 = { basis: 'calendar-year', year: 2026 } as const;

interface JourneyResult {
  readonly draftId: string;
  readonly v1: unknown;
  readonly v2: unknown;
  readonly manifestV1: string;
  readonly boundaryV2: unknown;
}

/** The full journey: valid draft -> submit v1 -> resubmission approved -> corrected v2; plus a boundary approval. */
function runJourney(): JourneyResult {
  const deps = supplierDeps(NOW);
  const later = supplierDeps(LATER);
  const store = new SupplierReportStore();
  const boundaries = new SupplierBoundaryStore(NOW);

  const draft = createDraft(deps, store, { systemId: BEAR, period: CY2026 }, WILEY);
  assert.equal(draft.outcome, 'allowed');
  const sections = validSections();
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
    const result = updateSection(deps, store, draft.value.draftId, patch, WILEY);
    assert.equal(result.outcome, 'allowed');
  }

  const v1 = submit(later, store, draft.value.draftId, WILEY, { submissionId: 'sub-det-v1' });
  assert.equal(v1.outcome, 'allowed');
  const manifestV1 = serializeManifest(buildPdfManifest(v1.outcome === 'allowed' ? v1.value.submission : (null as never)));

  const approved = approveResubmission(later, store, 'sub-det-v1', REVIEWER_CACHE, 'correct the source inventory');
  assert.equal(approved.outcome, 'allowed');

  const draft2 = createDraft(later, store, { systemId: BEAR, period: CY2026 }, WILEY);
  assert.equal(draft2.outcome, 'allowed');
  const corrected: ReportSections = {
    ...validSections(),
    sourceInventory: [
      { sourceId: 'W-1', sourceType: 'well', name: 'Canyon Well 1', pumpCapacityGpm: 1500, annualWithdrawalGallons: 1_250_000_000, metered: true },
      { sourceId: 'SP-2', sourceType: 'spring', name: 'East Spring', pumpCapacityGpm: null, annualWithdrawalGallons: 600_000_000, metered: false },
    ],
  };
  for (const patch of [
    { category: 'culinary-use', section: corrected.culinaryUse },
    { category: 'source-inventory', section: corrected.sourceInventory },
    { category: 'purchase-inventory', section: corrected.purchaseInventory },
    { category: 'wholesale-inventory', section: corrected.wholesaleInventory },
    { category: 'return-inventory', section: corrected.returnInventory },
    { category: 'source-peak-demand', section: corrected.sourcePeakDemand },
    { category: 'secondary-use', section: corrected.secondaryUse },
  ] as const satisfies readonly SectionPatch[]) {
    const result = updateSection(later, store, draft2.value.draftId, patch, WILEY);
    assert.equal(result.outcome, 'allowed');
  }
  const v2 = submit(later, store, draft2.value.draftId, WILEY, { submissionId: 'sub-det-v2' });
  assert.equal(v2.outcome, 'allowed');

  const proposal = createBoundaryProposal(deps, boundaries, {
    systemId: BEAR,
    sections: [{ sectionId: 'service-area', proposedSummary: 'Deterministic annexation summary.', changeReason: 'Recorded annexation' }],
  }, WILEY);
  assert.equal(proposal.outcome, 'allowed');
  const decided = decideBoundaryProposal(later, boundaries, proposal.outcome === 'allowed' ? proposal.value.proposalId : 'x', { approve: true, note: 'verified' }, REVIEWER_CACHE);
  assert.equal(decided.outcome, 'allowed');

  return {
    draftId: draft.value.draftId,
    v1: v1.outcome === 'allowed' ? v1.value.submission : null,
    v2: v2.outcome === 'allowed' ? v2.value.submission : null,
    manifestV1,
    boundaryV2: decided.outcome === 'allowed' ? decided.value.boundary : null,
  };
}

test('the full journey runs twice byte-identically (drafts, submissions, manifests, boundaries)', () => {
  const first = runJourney();
  const second = runJourney();

  assert.equal(second.draftId, first.draftId, 'deterministic draft ids');
  assert.equal(canonicalize(second.v1), canonicalize(first.v1), 'byte-identical v1 submissions');
  assert.equal(canonicalize(second.v2), canonicalize(first.v2), 'byte-identical v2 submissions');
  assert.deepEqual(second.v2, first.v2);
  assert.equal(second.manifestV1, first.manifestV1, 'byte-identical PDF manifest serializations');
  assert.equal(canonicalize(second.boundaryV2), canonicalize(first.boundaryV2), 'byte-identical approved boundary v2 records');

  const v1 = first.v1 as { contentHash: string; pdf: { manifestHash: string }; version: number };
  const v1Again = second.v1 as { contentHash: string; pdf: { manifestHash: string } };
  assert.equal(v1Again.contentHash, v1.contentHash);
  assert.equal(v1Again.pdf.manifestHash, v1.pdf.manifestHash);
  assert.equal(v1.version, 1);
  assert.equal((first.v2 as { version: number }).version, 2);
});

test('timestamps echo the injected clocks verbatim (no real clock reads)', () => {
  const first = runJourney();
  const v1 = first.v1 as { submittedAt: string };
  assert.equal(v1.submittedAt, LATER);
});
