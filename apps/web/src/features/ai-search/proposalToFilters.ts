/**
 * Proposal → manual FilterSet application (WD-019, FR-003, T-13).
 *
 * The interpreted proposal is NEVER executed on arrival: it becomes editable
 * manual-filter state the user inspects, edits and explicitly applies. These
 * helpers are pure functions — the panel owns the apply button; nothing here
 * touches the shell's filter state.
 *
 * Rules:
 * - The proposal's filterSet is already manual-canonical (the parser
 *   validates against the same rules); every edit re-runs the REAL manual
 *   canonicalizer (discovery/filters.ts), so the applied result is by
 *   construction something the manual path could have produced.
 * - Clarifications REQUIRE user decisions before apply: ambiguous terms ask
 *   for one of the listed candidates; unknown/security/unparsed terms ask
 *   for explicit dismissal. Nothing is guessed (T-13).
 * - Chip removals (user edits) apply on top of the proposal.
 *
 * Browser-safe pure module: no React state, no clock, no I/O.
 */
import type {
  ClarificationCandidate,
  ClarificationRequest,
  FilterSetProposal,
  NLFilterDimensionKey,
} from '../../../../../services/api/src/ai/filter-parser/index';
import {
  canonicalizeFilters,
  DISCOVERY_DIMENSION_KEYS,
  withoutFilterValue,
  type CanonicalFilterResult,
  type DiscoveryFilterSet,
  type FilterDimensionKey,
} from '../discovery/filters';

/** One user decision on one clarification (by its position in the proposal). */
export interface ClarificationDecision {
  readonly index: number;
  /** The chosen candidate for ambiguous terms; null means "dismissed, not a filter". */
  readonly chosen: ClarificationCandidate | null;
}

/** User edits applied to a proposal before it may become manual filters. */
export interface ProposalEdits {
  /** Values removed from the proposed chips (the user narrowing the proposal). */
  readonly removals?: readonly { readonly dimension: FilterDimensionKey; readonly value: string }[];
  /** Decisions on the proposal's clarifications. */
  readonly decisions?: readonly ClarificationDecision[];
}

export interface ProposalToFiltersResult {
  /** The filter set the Apply button would set (manual-canonical). */
  readonly filterSet: DiscoveryFilterSet;
  /** Clarifications still requiring a decision before apply is allowed. */
  readonly pendingClarifications: readonly PendingClarification[];
  /** Redactions from the manual canonicalizer (defense in depth; empty in practice). */
  readonly canonicalization: CanonicalFilterResult;
  /** True when nothing blocks an explicit apply. */
  readonly readyToApply: boolean;
}

export interface PendingClarification {
  readonly index: number;
  readonly clarification: ClarificationRequest;
}

function decidedIndexes(edits: ProposalEdits): Map<number, ClarificationDecision> {
  const map = new Map<number, ClarificationDecision>();
  for (const decision of edits.decisions ?? []) map.set(decision.index, decision);
  return map;
}

/** Clarifications without a valid user decision (candidate chosen or dismissed). */
export function pendingClarificationsOf(proposal: FilterSetProposal, edits: ProposalEdits): readonly PendingClarification[] {
  const decided = decidedIndexes(edits);
  const pending: PendingClarification[] = [];
  proposal.clarifications.forEach((clarification, index) => {
    const decision = decided.get(index);
    if (!decision) {
      pending.push({ index, clarification });
      return;
    }
    if (clarification.kind === 'ambiguous' && decision.chosen === null) {
      // Dismissing an ambiguity is refusing the term entirely — allowed, but
      // only as an explicit decision; here it still needs the user's click,
      // which the panel records as chosen=null. Not pending.
      return;
    }
  });
  return pending;
}

/**
 * Compile the proposal + user edits into the manual FilterSet. Applying is a
 * separate, explicit user action (the panel's Apply button) — this function
 * only computes what WOULD be applied.
 */
export function proposalToFilterSet(proposal: FilterSetProposal, edits: ProposalEdits = {}): ProposalToFiltersResult {
  let filters: DiscoveryFilterSet = proposal.filterSet as unknown as DiscoveryFilterSet;

  // Ambiguity resolutions add the chosen governed value.
  const decided = decidedIndexes(edits);
  for (const [index, decision] of decided) {
    const clarification = proposal.clarifications[index];
    if (!clarification || decision.chosen === null) continue;
    const key = decision.chosen.dimension as FilterDimensionKey;
    const current = filters[key] ?? [];
    const next = [...current, decision.chosen.valueId].sort();
    const patched: Record<string, unknown> = {};
    for (const candidate of DISCOVERY_DIMENSION_KEYS) {
      const values = filters[candidate];
      if (values && values.length > 0) patched[candidate] = values;
    }
    patched[key] = next;
    filters = patched as unknown as DiscoveryFilterSet;
  }

  // Chip removals (user edits) apply on top.
  for (const removal of edits.removals ?? []) {
    filters = withoutFilterValue(filters, removal.dimension, removal.value);
  }

  // Re-validate through the REAL manual engine: the applied set is always a
  // set the manual filter path itself could have produced.
  const canonicalization = canonicalizeFilters(filters);
  const pending = pendingClarificationsOf(proposal, edits);
  return {
    filterSet: canonicalization.filters,
    pendingClarifications: pending,
    canonicalization,
    readyToApply: pending.length === 0,
  };
}

/**
 * The explicit apply: replaces the current manual filter set with the edited
 * proposal. Pure — returns the next filter set; the caller commits it.
 * Rejects (returns null) while clarifications are pending: the panel disables
 * the button, and this guard makes "never guessed, never auto-executed"
 * structural rather than cosmetic.
 */
export function applyProposal(
  currentFilters: DiscoveryFilterSet,
  proposal: FilterSetProposal,
  edits: ProposalEdits = {},
): DiscoveryFilterSet | null {
  void currentFilters; // replace semantics: the preview shows exactly what replaces the current set
  const compiled = proposalToFilterSet(proposal, edits);
  if (!compiled.readyToApply) return null;
  return compiled.filterSet;
}

/** Label for a proposal chip dimension/value pair, mirroring the discovery chip model. */
export function chipLabel(dimension: NLFilterDimensionKey, value: string, proposal: FilterSetProposal): string {
  const governed = proposal.matchedTerms.find((term) => term.dimension === dimension && term.valueId === value);
  return governed ? governed.input : value;
}
