/**
 * Validation for the WD-019 NL filter layer (FR-003, NFR-010, T-13).
 *
 * A proposal must validate against the SAME rules as manual filters. This
 * module mirrors WD-007 apps/web/src/features/discovery/filters.ts exactly
 * (value shape, restricted identifiers, closed-enum membership, "unknown"
 * sentinel legality, canonical ordering, cardinality) and
 * equivalence.test.ts proves the mirror against the real module on every
 * curated utterance: canonicalizeFilters(proposal.filterSet).filters must
 * deep-equal proposal.filterSet, i.e. the proposal is already in the form
 * the manual engine would accept unchanged.
 *
 * Why a mirror instead of an import: the deterministic parser is a
 * browser-safe core shared with apps/web (which bundles it), while the WD-007
 * module sits inside the web app's fixture shell. The equivalence suite is
 * the contract between them; drift fails CI, not users.
 *
 * Classification (mirroring classifyFilterValue):
 * - 'known': governed by the current vocabulary;
 * - 'unknown': well-formed identifier the vocabulary does not govern — kept,
 *   inspectable, matches nothing (FR-060 semantics; e.g. the fixture knows
 *   "surface-storage-release" as a classification, but no PUBLIC station
 *   carries it, so it is offered, shown as an unknown-value chip and selects
 *   nothing — no grant expansion);
 * - 'rejected': free text, restricted identifier, or a non-member of a
 *   closed enum — REMOVED with an explicit notice; the lexer cannot produce
 *   these (it only emits vocabulary ids), so a rejection here means an
 *   internal defect and validation fails loudly.
 *
 * Pure module.
 */
import { assertProposalInvariants, FILTER_VALUE_PATTERN } from './security';
import { ENUM_DIMENSIONS, governedValueIds } from './vocabulary';
import type { FilterSetProposal, NLFilterDimensionKey, NLFilterSet, ParserVocabulary } from './types';

/** Mirrors WD-007 MAX_VALUES_PER_DIMENSION. */
export const MAX_VALUES_PER_DIMENSION = 48;
/** The contract sentinel from filter-set.json: selects records whose value is unset. */
export const UNKNOWN_SENTINEL = 'unknown';

export type ValueVerdict = 'known' | 'unknown' | 'rejected';

export interface ValidationNotice {
  readonly dimension: NLFilterDimensionKey;
  readonly value: string;
  readonly reason: 'free-text' | 'restricted-identifier' | 'not-enum-member' | 'cardinality';
}

export interface ValidatedProposal {
  readonly proposal: FilterSetProposal;
  readonly notices: readonly ValidationNotice[];
}

/** Mirror of classifyFilterValue over the parser vocabulary. */
export function classifyValue(vocabulary: ParserVocabulary, dimension: NLFilterDimensionKey, value: string): ValueVerdict {
  if (typeof value !== 'string' || !FILTER_VALUE_PATTERN.test(value)) return 'rejected';
  if (vocabulary.restrictedObjectIds.includes(value)) return 'rejected';
  if (value === UNKNOWN_SENTINEL) return 'known'; // the contract sentinel is always legal
  const governed = governedValueIds(vocabulary)[dimension];
  if (ENUM_DIMENSIONS.has(dimension)) {
    return governed.has(value) ? 'known' : 'rejected';
  }
  return governed.has(value) ? 'known' : 'unknown';
}

/**
 * Canonicalize the parsed filterSet under manual-filter rules:
 * deduplicate, sort by code point, drop empty arrays, enforce cardinality,
 * reject anything the manual engine would redact. Returns the canonical set
 * plus notices (empty in normal operation — the lexer only emits governed
 * ids; a notice is an internal defect marker, surfaced, never hidden).
 */
export function canonicalizeProposalFilterSet(
  vocabulary: ParserVocabulary,
  filterSet: NLFilterSet,
): { canonical: NLFilterSet; notices: ValidationNotice[] } {
  const notices: ValidationNotice[] = [];
  const out: Record<string, string[]> = {};
  for (const [dimension, values] of Object.entries(filterSet) as [NLFilterDimensionKey, readonly string[]][]) {
    if (!Array.isArray(values)) continue;
    const kept: string[] = [];
    for (const value of [...new Set(values)].sort()) {
      if (kept.length >= MAX_VALUES_PER_DIMENSION) {
        notices.push({ dimension, value, reason: 'cardinality' });
        continue;
      }
      const verdict = classifyValue(vocabulary, dimension, value);
      if (verdict === 'rejected') {
        notices.push({
          dimension,
          value,
          reason: vocabulary.restrictedObjectIds.includes(value) ? 'restricted-identifier' : ENUM_DIMENSIONS.has(dimension) ? 'not-enum-member' : 'free-text',
        });
        continue;
      }
      kept.push(value);
    }
    if (kept.length > 0) out[dimension] = kept;
  }
  return { canonical: out as unknown as NLFilterSet, notices };
}

/**
 * Validate a raw proposal: canonicalize under manual rules, re-check that
 * matchedTerm attribution still lines up with the canonical set, then assert
 * the full FilterSetProposal invariants. Throws on invariant violation
 * (defense in depth — the security suite relies on it).
 */
export function validateProposal(
  raw: FilterSetProposal,
  vocabulary: ParserVocabulary,
): ValidatedProposal {
  const { canonical, notices } = canonicalizeProposalFilterSet(vocabulary, raw.filterSet);
  const matchedTerms = raw.matchedTerms.filter((term) => {
    const values = (canonical as Record<string, readonly string[] | undefined>)[term.dimension] ?? [];
    return values.includes(term.valueId);
  });

  const validated: FilterSetProposal = {
    filterSet: canonical,
    matchedTerms,
    unknownTerms: raw.unknownTerms,
    needsClarification: raw.clarifications.length > 0,
    clarifications: raw.clarifications,
    dateFilters: raw.dateFilters,
    unsupported: raw.unsupported,
    securityFindings: raw.securityFindings,
  };

  assertProposalInvariants(validated, vocabulary);
  return { proposal: validated, notices };
}
