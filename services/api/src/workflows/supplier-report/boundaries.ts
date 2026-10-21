/**
 * Boundary proposals for WD-017 (FR-054): "An assigned supplier proposes a
 * boundary change with reason, views approval status, downloads an
 * authorized boundary file, and comments by section; a proposal never
 * replaces the approved boundary before the defined approval action."
 *
 * DESIGN CONTRACTS:
 *
 * - THE APPROVED BOUNDARY IS IMMUTABLE: createProposal/addComment/transition
 *   never touch it. Only the DISTINCT approval transition
 *   (approveBoundaryProposal, reviewer-only) derives boundary version N+1
 *   from the proposal; version N stays queryable and byte-identical forever.
 * - SECTIONED PROPOSALS AND COMMENTS: a proposal carries one change per
 *   boundary section with a change reason; suppliers and reviewers comment
 *   BY SECTION, append-only.
 * - ORGANIZATION ISOLATION: proposals and boundaries are gated by the same
 *   organization-scoped supplier-reporting grant as reports (checkSupplierScope
 *   / checkReviewerScope); the other supplier's proposal id is a hidden 404.
 * - The APPROVED file download and its geometry contract are the Water Use
 *   Program owner's pending decision; this module versions the SUMMARY
 *   record (the "authorized boundary file" producer) and deliberately does
 *   not fabricate geometry.
 * - DETERMINISM: ids from stable keys; timestamps from the injected clock.
 */
import type { DomainResult } from '../../series/types.ts';
import type { PolicyWorld } from '../../../../../packages/policy/src/index.ts';

import {
  type ApprovedBoundary,
  type BoundaryComment,
  type BoundaryProposal,
  type BoundaryProposalStatus,
  type BoundarySection,
  type ProposedSectionChange,
} from './types.ts';
import { checkReviewerScope, checkSupplierScope } from './scope.ts';
import { supplierWorld } from './world.ts';

/** Fixture boundary sections (documented defaults pending the Water Use owner's geometry contract). */
const INITIAL_SECTIONS: readonly { readonly sectionId: string; readonly title: string; readonly summary: string }[] = [
  {
    sectionId: 'service-area',
    title: 'Service area extent',
    summary: 'Fixture default: the current recorded service-area extent of the supplier system (summary record; geometry contract pending Water Use owner).',
  },
  {
    sectionId: 'sources',
    title: 'Source points',
    summary: 'Fixture default: sources of record attributed to this supplier within the system.',
  },
  {
    sectionId: 'delivery-points',
    title: 'Delivery and exchange points',
    summary: 'Fixture default: wholesale delivery and exchange points of record (purchases, sales, returns).',
  },
];

export interface SupplierDepsLike {
  readonly world?: PolicyWorld | undefined;
  readonly now: string;
}

function boundaryIdOf(orgId: string, systemId: string): string {
  return `boundary-${orgId}-${systemId}`;
}

function proposalIdOf(orgId: string, systemId: string, sequence: number): string {
  return `proposal-${orgId}-${systemId}-${sequence}`;
}

/** In-memory boundary store: approved versions (immutable) + proposals (state machine). */
export class SupplierBoundaryStore {
  private readonly approved = new Map<string, ApprovedBoundary[]>(); // boundaryId -> versions ascending
  private readonly proposals = new Map<string, BoundaryProposal>();
  private readonly proposalsByBoundary = new Map<string, string[]>();
  private sequence = 0;

  constructor(now: string, bootstrapActor = 'fixture-bootstrap') {
    // v1 approved boundary per supplier anchor (fixture world, read-only).
    for (const anchor of supplierWorld().anchors) {
      const id = boundaryIdOf(anchor.orgId, anchor.systemId);
      this.approved.set(id, [
        Object.freeze({
          boundaryId: id,
          orgId: anchor.orgId,
          systemId: anchor.systemId,
          version: 1,
          sections: Object.freeze(INITIAL_SECTIONS.map((section) => Object.freeze({ ...section }) as BoundarySection)),
          approvedBy: bootstrapActor,
          approvedAt: now,
        }),
      ]);
    }
  }

  approvedVersionsOf(orgId: string, systemId: string): readonly ApprovedBoundary[] {
    return this.approved.get(boundaryIdOf(orgId, systemId)) ?? [];
  }

  approvedVersionOf(orgId: string, systemId: string): number {
    const versions = this.approvedVersionsOf(orgId, systemId);
    return versions.length === 0 ? 0 : versions[versions.length - 1]!.version;
  }

  currentApproved(orgId: string, systemId: string): ApprovedBoundary | null {
    const versions = this.approvedVersionsOf(orgId, systemId);
    return versions.length === 0 ? null : versions[versions.length - 1]!;
  }

  approvedById(boundaryId: string): ApprovedBoundary | null {
    const versions = this.approved.get(boundaryId);
    return versions && versions.length > 0 ? versions[versions.length - 1]! : null;
  }

  proposalById(proposalId: string): BoundaryProposal | null {
    return this.proposals.get(proposalId) ?? null;
  }

  proposalsOf(orgId: string, systemId: string): readonly BoundaryProposal[] {
    return (this.proposalsByBoundary.get(boundaryIdOf(orgId, systemId)) ?? []).map((id) => this.proposals.get(id)!).filter((p) => p !== undefined);
  }

  /** Internal: record a new proposal (append-only). */
  putProposal(proposal: BoundaryProposal): void {
    this.proposals.set(proposal.proposalId, proposal);
    const key = boundaryIdOf(proposal.orgId, proposal.systemId);
    const list = this.proposalsByBoundary.get(key) ?? [];
    list.push(proposal.proposalId);
    this.proposalsByBoundary.set(key, list);
  }

  /** Internal: replace a proposal record by identity (status transitions; sections/comments untouched). */
  replaceProposal(proposal: BoundaryProposal): void {
    if (!this.proposals.has(proposal.proposalId)) throw new Error(`replaceProposal: unknown proposal "${proposal.proposalId}"`);
    this.proposals.set(proposal.proposalId, proposal);
  }

  /** Internal: append a NEW approved version (approval only; prior versions untouched). */
  appendApprovedVersion(next: ApprovedBoundary): void {
    const list = this.approved.get(next.boundaryId);
    if (!list) throw new Error(`appendApprovedVersion: unknown boundary "${next.boundaryId}"`);
    const prior = list[list.length - 1]!;
    if (next.version !== prior.version + 1) throw new Error('appendApprovedVersion: versions are consecutive');
    list.push(Object.freeze(next));
  }

  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The current approved boundary of the actor's organization (versioned; v1 fixture bootstrap). */
export function getApprovedBoundary(deps: SupplierDepsLike, store: SupplierBoundaryStore, systemId: string, actorId: string | null): DomainResult<ApprovedBoundary> {
  const world = deps.world ?? supplierWorld().policyWorld;
  const scope = checkSupplierScope(world, actorId, systemId, deps.now);
  if (scope.outcome === 'denied') return scope;
  const current = store.currentApproved(scope.value.orgId, systemId);
  if (!current) return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'no approved boundary for this system' };
  return { outcome: 'allowed', value: current };
}

/** Proposals of the actor's organization only (hidden from the other supplier). */
export function listProposals(deps: SupplierDepsLike, store: SupplierBoundaryStore, systemId: string, actorId: string | null): DomainResult<readonly BoundaryProposal[]> {
  const world = deps.world ?? supplierWorld().policyWorld;
  const scope = checkSupplierScope(world, actorId, systemId, deps.now);
  if (scope.outcome === 'denied') return scope;
  return { outcome: 'allowed', value: store.proposalsOf(scope.value.orgId, systemId) };
}

export function getProposal(deps: SupplierDepsLike, store: SupplierBoundaryStore, proposalId: string, actorId: string | null): DomainResult<BoundaryProposal> {
  const proposal = store.proposalById(proposalId);
  if (!proposal) return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: `proposal "${proposalId}" not found` };
  const world = deps.world ?? supplierWorld().policyWorld;
  const scope = checkSupplierScope(world, actorId, proposal.systemId, deps.now);
  if (scope.outcome === 'denied') return scope;
  if (scope.value.orgId !== proposal.orgId) return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'proposal not found' };
  return { outcome: 'allowed', value: proposal };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CreateProposalInput {
  readonly systemId: string;
  readonly sections: readonly { readonly sectionId: string; readonly proposedSummary: string; readonly changeReason: string }[];
}

/**
 * Propose a boundary change (supplier action). The proposal snapshots the
 * CURRENT approved summaries per section; the approved boundary record
 * itself is never mutated by proposing.
 */
export function createBoundaryProposal(deps: SupplierDepsLike, store: SupplierBoundaryStore, input: CreateProposalInput, actorId: string | null): DomainResult<BoundaryProposal> {
  const world = deps.world ?? supplierWorld().policyWorld;
  const scope = checkSupplierScope(world, actorId, input.systemId, deps.now);
  if (scope.outcome === 'denied') return scope;
  const current = store.currentApproved(scope.value.orgId, input.systemId);
  if (!current) return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'no approved boundary for this system' };
  if (input.sections.length === 0) {
    return { outcome: 'denied', status: 422, code: 'EMPTY_PROPOSAL', message: 'a boundary proposal must contain at least one section change' };
  }
  const sections: ProposedSectionChange[] = [];
  for (const change of input.sections) {
    const approvedSection = current.sections.find((section) => section.sectionId === change.sectionId);
    if (!approvedSection) {
      return {
        outcome: 'denied',
        status: 422,
        code: 'UNKNOWN_SECTION',
        message: `section "${change.sectionId}" is not part of the approved boundary (${current.sections.map((section) => section.sectionId).join(', ')})`,
      };
    }
    if (change.proposedSummary.trim().length === 0 || change.changeReason.trim().length === 0) {
      return { outcome: 'denied', status: 422, code: 'MISSING_REQUIRED', message: `section "${change.sectionId}" needs both a proposed summary and a change reason` };
    }
    sections.push({
      sectionId: approvedSection.sectionId,
      title: approvedSection.title,
      currentSummary: approvedSection.summary,
      proposedSummary: change.proposedSummary,
      changeReason: change.changeReason,
    });
  }
  const proposal: BoundaryProposal = Object.freeze({
    proposalId: proposalIdOf(scope.value.orgId, input.systemId, store.nextSequence()),
    orgId: scope.value.orgId,
    systemId: input.systemId,
    status: 'proposed',
    proposedBy: actorId ?? 'anonymous',
    proposedAt: deps.now,
    sections: Object.freeze(sections),
    comments: Object.freeze([]),
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    resultingBoundaryVersion: null,
  });
  store.putProposal(proposal);
  return { outcome: 'allowed', value: proposal };
}

/** Comment on ONE section of a proposal (suppliers and reviewers of the organization both may). */
export function addBoundaryComment(
  deps: SupplierDepsLike,
  store: SupplierBoundaryStore,
  proposalId: string,
  input: { readonly sectionId: string; readonly text: string },
  actorId: string | null,
): DomainResult<BoundaryProposal> {
  const gate = getProposal(deps, store, proposalId, actorId);
  if (gate.outcome === 'denied') return gate;
  const proposal = gate.value;
  if (proposal.status === 'approved' || proposal.status === 'rejected') {
    return { outcome: 'denied', status: 422, code: 'PROPOSAL_DECIDED', message: `proposal ${proposalId} is ${proposal.status}; its comment thread is closed` };
  }
  if (!proposal.sections.some((section) => section.sectionId === input.sectionId)) {
    return { outcome: 'denied', status: 422, code: 'UNKNOWN_SECTION', message: `section "${input.sectionId}" is not part of this proposal` };
  }
  if (input.text.trim().length === 0) {
    return { outcome: 'denied', status: 422, code: 'MISSING_REQUIRED', message: 'a comment needs text' };
  }
  // Reviewer detection mirrors the scope gate's role-family narrowing.
  const world = deps.world ?? supplierWorld().policyWorld;
  const scope = checkSupplierScope(world, actorId, proposal.systemId, deps.now);
  const authorRole: BoundaryComment['authorRole'] = scope.outcome === 'allowed' && scope.value.actorKind === 'reviewer' ? 'reviewer' : 'supplier';
  const comment: BoundaryComment = Object.freeze({
    commentId: `c-${proposal.proposalId}-${proposal.comments.length + 1}`,
    sectionId: input.sectionId,
    authorId: actorId ?? 'anonymous',
    authorRole,
    text: input.text,
    at: deps.now,
  });
  const next: BoundaryProposal = Object.freeze({
    ...proposal,
    comments: Object.freeze([...proposal.comments, comment]),
  });
  store.replaceProposal(next);
  return { outcome: 'allowed', value: next };
}

/** Supplier moves a proposal into review (an explicit, auditable hand-off). */
export function submitProposalForReview(deps: SupplierDepsLike, store: SupplierBoundaryStore, proposalId: string, actorId: string | null): DomainResult<BoundaryProposal> {
  const gate = getProposal(deps, store, proposalId, actorId);
  if (gate.outcome === 'denied') return gate;
  const proposal = gate.value;
  if (proposal.status !== 'proposed') {
    return { outcome: 'denied', status: 422, code: 'INVALID_TRANSITION', message: `proposal ${proposalId} is ${proposal.status}; only a proposed proposal moves to review` };
  }
  const next: BoundaryProposal = Object.freeze({ ...proposal, status: 'review' as BoundaryProposalStatus });
  store.replaceProposal(next);
  return { outcome: 'allowed', value: next };
}

/**
 * THE DISTINCT APPROVAL TRANSITION (FR-054). Reviewer-only; derives approved
 * boundary version N+1 from the proposal while version N stays immutable
 * and queryable. Rejecting never touches the approved boundary either.
 */
export function decideBoundaryProposal(
  deps: SupplierDepsLike,
  store: SupplierBoundaryStore,
  proposalId: string,
  decision: { readonly approve: boolean; readonly note: string },
  reviewerActorId: string | null,
): DomainResult<{ readonly proposal: BoundaryProposal; readonly boundary: ApprovedBoundary | null }> {
  const proposal = store.proposalById(proposalId);
  if (!proposal) return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: `proposal "${proposalId}" not found` };
  const world = deps.world ?? supplierWorld().policyWorld;
  const scope = checkReviewerScope(world, reviewerActorId, proposal.systemId, deps.now);
  if (scope.outcome === 'denied') return scope;
  if (scope.value.orgId !== proposal.orgId) return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'proposal not found' };
  if (proposal.status !== 'proposed' && proposal.status !== 'review') {
    return { outcome: 'denied', status: 422, code: 'INVALID_TRANSITION', message: `proposal ${proposalId} is ${proposal.status}; it can no longer be decided` };
  }
  if (decision.note.trim().length === 0) {
    return { outcome: 'denied', status: 422, code: 'MISSING_REQUIRED', message: 'a decision needs a note' };
  }

  if (!decision.approve) {
    const rejected: BoundaryProposal = Object.freeze({
      ...proposal,
      status: 'rejected',
      decidedBy: reviewerActorId,
      decidedAt: deps.now,
      decisionNote: decision.note,
      resultingBoundaryVersion: null,
    });
    store.replaceProposal(rejected);
    return { outcome: 'allowed', value: { proposal: rejected, boundary: null } };
  }

  const current = store.currentApproved(proposal.orgId, proposal.systemId)!;
  // Derive version N+1: approved sections updated from the proposal, in the
  // approved record's own section order (deterministic).
  const nextSections: BoundarySection[] = current.sections.map((section) => {
    const change = proposal.sections.find((candidate) => candidate.sectionId === section.sectionId);
    return change
      ? Object.freeze({ sectionId: section.sectionId, title: section.title, summary: change.proposedSummary })
      : section;
  });
  const nextBoundary: ApprovedBoundary = Object.freeze({
    boundaryId: current.boundaryId,
    orgId: current.orgId,
    systemId: current.systemId,
    version: current.version + 1,
    sections: Object.freeze(nextSections),
    approvedBy: reviewerActorId ?? 'anonymous',
    approvedAt: deps.now,
  });
  store.appendApprovedVersion(nextBoundary);
  const approved: BoundaryProposal = Object.freeze({
    ...proposal,
    status: 'approved',
    decidedBy: reviewerActorId,
    decidedAt: deps.now,
    decisionNote: decision.note,
    resultingBoundaryVersion: nextBoundary.version,
  });
  store.replaceProposal(approved);
  return { outcome: 'allowed', value: { proposal: approved, boundary: nextBoundary } };
}
