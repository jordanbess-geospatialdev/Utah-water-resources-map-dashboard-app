/**
 * Boundary proposal tests (WD-017; FR-054): "An assigned supplier proposes a
 * boundary change with reason, views approval status, downloads an
 * authorized boundary file, and comments by section; a proposal never
 * replaces the approved boundary before the defined approval action."
 *
 * - proposing and commenting NEVER mutate the approved boundary;
 * - approval is a DISTINCT, reviewer-only transition that derives boundary
 *   version N+1 while version N stays immutable and queryable;
 * - rejection never touches the boundary;
 * - cross-supplier isolation on proposals and boundaries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SupplierBoundaryStore,
  addBoundaryComment,
  createBoundaryProposal,
  decideBoundaryProposal,
  getApprovedBoundary,
  getProposal,
  listProposals,
  submitProposalForReview,
} from '../boundaries.ts';
import { BEAR, LATER, NOW, supplierDeps, WEBER } from './helpers.ts';
import { STANDARD_ACTORS } from '../world.ts';

const WILEY = STANDARD_ACTORS.WILEY;
const MORGAN = STANDARD_ACTORS.MORGAN;
const REVIEWER_CACHE = STANDARD_ACTORS.REVIEWER_CACHE;

function makeStore(): SupplierBoundaryStore {
  return new SupplierBoundaryStore(NOW);
}

test('the fixture world bootstraps approved boundary v1 per supplier system', () => {
  const store = makeStore();
  const bear = getApprovedBoundary(supplierDeps(NOW), store, BEAR, WILEY);
  assert.equal(bear.outcome, 'allowed');
  if (bear.outcome === 'allowed') {
    assert.equal(bear.value.version, 1);
    assert.deepEqual(bear.value.sections.map((section) => section.sectionId), ['service-area', 'sources', 'delivery-points']);
    assert.equal(bear.value.orgId, 'org-cache-water');
  }
});

test('a proposal never replaces the approved boundary: propose + comment leave v1 byte-identical', () => {
  const deps = supplierDeps(NOW);
  const store = makeStore();
  const before = getApprovedBoundary(deps, store, BEAR, WILEY);
  assert.equal(before.outcome, 'allowed');
  const beforeValue = before.outcome === 'allowed' ? before.value : null;
  assert.ok(beforeValue);

  const proposal = createBoundaryProposal(deps, store, {
    systemId: BEAR,
    sections: [{ sectionId: 'service-area', proposedSummary: 'Extended to include the 2025 annexation west of the canal.', changeReason: 'Recorded annexation, plat 2025-11' }],
  }, WILEY);
  assert.equal(proposal.outcome, 'allowed');
  if (proposal.outcome !== 'allowed') return;
  assert.equal(proposal.value.status, 'proposed');
  assert.equal(proposal.value.sections[0]!.currentSummary, beforeValue.sections[0]!.summary, 'the proposal snapshots the current summary');
  assert.notEqual(proposal.value.sections[0]!.proposedSummary, beforeValue.sections[0]!.summary);

  const commented = addBoundaryComment(deps, store, proposal.value.proposalId, { sectionId: 'service-area', text: 'Please attach the recorded plat with the submission.' }, REVIEWER_CACHE);
  assert.equal(commented.outcome, 'allowed');
  const supplierComment = addBoundaryComment(deps, store, proposal.value.proposalId, { sectionId: 'service-area', text: 'Plat attached to the proposal documents.' }, WILEY);
  assert.equal(supplierComment.outcome, 'allowed');

  // The approved boundary is untouched through all of it.
  const after = getApprovedBoundary(deps, store, BEAR, WILEY);
  assert.equal(after.outcome, 'allowed');
  if (after.outcome === 'allowed') {
    assert.equal(after.value.version, 1);
    assert.deepEqual(after.value, beforeValue, 'the approved boundary record is byte-identical after proposing and commenting');
    assert.equal(after.value.sections[0]!.summary, beforeValue.sections[0]!.summary);
  }
});

test('comments are by section, append-only, and role-labeled', () => {
  const deps = supplierDeps(NOW);
  const store = makeStore();
  const proposal = createBoundaryProposal(deps, store, {
    systemId: BEAR,
    sections: [{ sectionId: 'sources', proposedSummary: 'Add the new well field as sources of record.', changeReason: 'Two wells commissioned 2026' }],
  }, WILEY);
  assert.equal(proposal.outcome, 'allowed');
  if (proposal.outcome !== 'allowed') return;

  const badSection = addBoundaryComment(deps, store, proposal.value.proposalId, { sectionId: 'service-area', text: 'wrong section' }, WILEY);
  assert.equal(badSection.outcome, 'denied');
  if (badSection.outcome === 'denied') assert.equal(badSection.code, 'UNKNOWN_SECTION');

  const r1 = addBoundaryComment(deps, store, proposal.value.proposalId, { sectionId: 'sources', text: 'Include the well tags.' }, REVIEWER_CACHE);
  const r2 = addBoundaryComment(deps, store, proposal.value.proposalId, { sectionId: 'sources', text: 'Tags W-2026-041 and W-2026-042.' }, WILEY);
  assert.equal(r1.outcome, 'allowed');
  assert.equal(r2.outcome, 'allowed');
  if (r2.outcome !== 'allowed') return;
  assert.deepEqual(r2.value.comments.map((comment) => comment.authorRole), ['reviewer', 'supplier']);
  assert.ok(r2.value.comments.every((comment) => comment.sectionId === 'sources'));
  // Prior comment objects survive appending (append-only thread).
  assert.equal(r2.value.comments[0]!.text, 'Include the well tags.');
});

test('approval is a DISTINCT reviewer transition: v2 derived, v1 immutable, supplier cannot approve', () => {
  const deps = supplierDeps(NOW);
  const store = makeStore();
  const v1 = getApprovedBoundary(deps, store, BEAR, WILEY);
  assert.equal(v1.outcome, 'allowed');
  const v1Value = v1.outcome === 'allowed' ? v1.value : null;
  assert.ok(v1Value);

  const proposal = createBoundaryProposal(deps, store, {
    systemId: BEAR,
    sections: [
      { sectionId: 'service-area', proposedSummary: 'Extended service area summary.', changeReason: 'Annexation' },
      { sectionId: 'delivery-points', proposedSummary: 'Added the north exchange point.', changeReason: 'New wholesale contract' },
    ],
  }, WILEY);
  assert.equal(proposal.outcome, 'allowed');
  if (proposal.outcome !== 'allowed') return;

  // The supplier cannot approve their own proposal.
  const self = decideBoundaryProposal(deps, store, proposal.value.proposalId, { approve: true, note: 'self' }, WILEY);
  assert.equal(self.outcome, 'denied');
  if (self.outcome === 'denied') assert.equal(self.code, 'REVIEWER_REQUIRED');
  // A decision needs a note.
  const noNote = decideBoundaryProposal(deps, store, proposal.value.proposalId, { approve: true, note: '  ' }, REVIEWER_CACHE);
  assert.equal(noNote.outcome, 'denied');
  if (noNote.outcome === 'denied') assert.equal(noNote.code, 'MISSING_REQUIRED');

  // Explicit supplier hand-off to review, then the reviewer approves.
  const inReview = submitProposalForReview(deps, store, proposal.value.proposalId, WILEY);
  assert.equal(inReview.outcome, 'allowed');
  const decided = decideBoundaryProposal({ now: LATER, world: deps.world }, store, proposal.value.proposalId, { approve: true, note: 'Annexation verified against county records.' }, REVIEWER_CACHE);
  assert.equal(decided.outcome, 'allowed');
  if (decided.outcome !== 'allowed') return;
  assert.equal(decided.value.proposal.status, 'approved');
  assert.equal(decided.value.proposal.resultingBoundaryVersion, 2);
  assert.equal(decided.value.proposal.decidedBy, REVIEWER_CACHE);
  assert.ok(decided.value.boundary);
  assert.equal(decided.value.boundary.version, 2);
  assert.equal(decided.value.boundary.approvedAt, LATER);

  // v2 content: changed sections take the proposed summaries; untouched
  // sections keep their approved text, in the approved record's order.
  assert.deepEqual(
    decided.value.boundary.sections.map((section) => [section.sectionId, section.summary]),
    [
      ['service-area', 'Extended service area summary.'],
      ['sources', v1Value.sections[1]!.summary],
      ['delivery-points', 'Added the north exchange point.'],
    ],
  );

  // v1 is immutable and still queryable through the store.
  const versions = store.approvedVersionsOf('org-cache-water', BEAR);
  assert.equal(versions.length, 2);
  assert.deepEqual(versions[0], v1Value);

  // The decided proposal can no longer be decided again.
  const again = decideBoundaryProposal(deps, store, proposal.value.proposalId, { approve: true, note: 'again' }, REVIEWER_CACHE);
  assert.equal(again.outcome, 'denied');
  if (again.outcome === 'denied') assert.equal(again.code, 'INVALID_TRANSITION');

  // The comment thread closes on a decided proposal.
  const late = addBoundaryComment(deps, store, proposal.value.proposalId, { sectionId: 'service-area', text: 'late' }, WILEY);
  assert.equal(late.outcome, 'denied');
  if (late.outcome === 'denied') assert.equal(late.code, 'PROPOSAL_DECIDED');
});

test('rejection never touches the approved boundary', () => {
  const deps = supplierDeps(NOW);
  const store = makeStore();
  const before = getApprovedBoundary(deps, store, BEAR, WILEY);
  const proposal = createBoundaryProposal(deps, store, {
    systemId: BEAR,
    sections: [{ sectionId: 'sources', proposedSummary: 'Remove the decommissioned spring.', changeReason: 'Spring decommissioned' }],
  }, WILEY);
  assert.equal(proposal.outcome, 'allowed');
  if (proposal.outcome !== 'allowed') return;

  const rejected = decideBoundaryProposal(deps, store, proposal.value.proposalId, { approve: false, note: 'Spring still contributes to the record; resubmit with evidence.' }, REVIEWER_CACHE);
  assert.equal(rejected.outcome, 'allowed');
  if (rejected.outcome !== 'allowed') return;
  assert.equal(rejected.value.proposal.status, 'rejected');
  assert.equal(rejected.value.boundary, null);

  const after = getApprovedBoundary(deps, store, BEAR, WILEY);
  assert.equal(after.outcome, 'allowed');
  if (after.outcome === 'allowed' && before.outcome === 'allowed') assert.deepEqual(after.value, before.value);
});

test('proposals are org-isolated in both directions; unknown sections are 422', () => {
  const deps = supplierDeps(NOW);
  const store = makeStore();
  const bearProposal = createBoundaryProposal(deps, store, {
    systemId: BEAR,
    sections: [{ sectionId: 'service-area', proposedSummary: 'Cache proposal.', changeReason: 'reason' }],
  }, WILEY);
  assert.equal(bearProposal.outcome, 'allowed');

  // Morgan cannot read, list or comment Wiley's proposal.
  const cross = getProposal(deps, store, bearProposal.outcome === 'allowed' ? bearProposal.value.proposalId : 'x', MORGAN);
  assert.equal(cross.outcome, 'denied');
  if (cross.outcome === 'denied') assert.equal(cross.status, 404);
  // Morgan is out of scope on BEAR entirely: listing the system's proposals
  // is a hidden 404, exactly like every other cross-supplier read.
  const crossList = listProposals(deps, store, BEAR, MORGAN);
  assert.equal(crossList.outcome, 'denied');
  if (crossList.outcome === 'denied') assert.equal(crossList.status, 404);
  const crossComment = addBoundaryComment(deps, store, bearProposal.outcome === 'allowed' ? bearProposal.value.proposalId : 'x', { sectionId: 'service-area', text: 'hi' }, MORGAN);
  assert.equal(crossComment.outcome, 'denied');
  if (crossComment.outcome === 'denied') assert.equal(crossComment.status, 404);

  // Wiley cannot even propose on Weber (the other supplier's system).
  const foreign = createBoundaryProposal(deps, store, {
    systemId: WEBER,
    sections: [{ sectionId: 'service-area', proposedSummary: 'nope', changeReason: 'nope' }],
  }, WILEY);
  assert.equal(foreign.outcome, 'denied');
  if (foreign.outcome === 'denied') assert.equal(foreign.status, 404);

  // Unknown section ids and empty proposals are 422.
  const unknownSection = createBoundaryProposal(deps, store, {
    systemId: BEAR,
    sections: [{ sectionId: 'not-a-section', proposedSummary: 'x', changeReason: 'x' }],
  }, WILEY);
  assert.equal(unknownSection.outcome, 'denied');
  if (unknownSection.outcome === 'denied') assert.equal(unknownSection.code, 'UNKNOWN_SECTION');
  const empty = createBoundaryProposal(deps, store, { systemId: BEAR, sections: [] }, WILEY);
  assert.equal(empty.outcome, 'denied');
  if (empty.outcome === 'denied') assert.equal(empty.code, 'EMPTY_PROPOSAL');
});
