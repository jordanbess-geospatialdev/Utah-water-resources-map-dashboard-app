/**
 * Parser for the WD-019 grammar (FR-003): composes the lexer's controlled
 * matches into the raw FilterSetProposal.
 *
 * Semantics (mirroring WD-007 filters.ts):
 * - AND across dimensions, OR within a dimension: every matched value joins
 *   its dimension's array; arrays deduplicate and sort by code point; empty
 *   arrays are omitted (absent key = no constraint, never "unknown").
 * - matchedTerms carry the attribution (input phrase, dimension, valueId,
 *   exact|synonym) in utterance order — the user-inspectable explanation.
 * - AMBIGUOUS phrases (two candidate dimensions, e.g. "weir": site type vs
 *   measurement method) are NEVER applied: they become clarification
 *   requests listing the competing candidates.
 * - unknown runs become clarification requests of kind 'unknown' — never a
 *   guess, never a filter value.
 * - needsClarification is true exactly when at least one clarification
 *   exists (unknown, ambiguous, security-blocked, or nothing parsed at all).
 *
 * Pure module: lexer output in, raw proposal out.
 */
import type { LexResult, TermMatch } from './lexer';
import type {
  ClarificationCandidate,
  ClarificationRequest,
  FilterSetProposal,
  MatchedTerm,
  NLFilterSet,
} from './types';

export interface RawProposal {
  readonly filterSet: NLFilterSet;
  readonly matchedTerms: readonly MatchedTerm[];
  readonly clarifications: readonly ClarificationRequest[];
  readonly ambiguousMatches: readonly TermMatch[];
}

function candidateList(match: TermMatch): readonly ClarificationCandidate[] {
  const all = [match, ...match.alternatives];
  return all.map((candidate) => ({
    dimension: candidate.dimension,
    valueId: candidate.valueId,
    label: candidate.label,
  }));
}

/** Compose the lexer result into the raw proposal (validation happens in validate.ts). */
export function parseLexResult(lexResult: LexResult): RawProposal {
  const byDimension = new Map<string, string[]>();
  const matchedTerms: MatchedTerm[] = [];
  const clarifications: ClarificationRequest[] = [];
  const ambiguousMatches: TermMatch[] = [];

  for (const match of lexResult.matches) {
    if (match.alternatives.length > 0) {
      // Two or more dimensions answer to this phrase: ask, never guess.
      ambiguousMatches.push(match);
      clarifications.push({
        term: match.input,
        kind: 'ambiguous',
        message: `"${match.input}" can mean more than one filter dimension. Pick one to continue — nothing was guessed.`,
        candidates: candidateList(match),
      });
      continue;
    }
    const values = byDimension.get(match.dimension) ?? [];
    if (!values.includes(match.valueId)) values.push(match.valueId);
    byDimension.set(match.dimension, values);
    matchedTerms.push({
      input: match.input,
      dimension: match.dimension,
      valueId: match.valueId,
      confidence: match.confidence,
    });
  }

  for (const unknown of lexResult.unknownRuns) {
    clarifications.push({
      term: unknown,
      kind: 'unknown',
      message: `"${unknown}" is not in the controlled vocabulary. Filters never guess: clarify the term or pick the filters manually.`,
      candidates: [],
    });
  }

  const filterSet: Record<string, string[]> = {};
  for (const [dimension, values] of byDimension) {
    const canonical = [...new Set(values)].sort();
    if (canonical.length > 0) filterSet[dimension] = canonical;
  }

  return {
    filterSet: filterSet as unknown as NLFilterSet,
    matchedTerms,
    clarifications,
    ambiguousMatches,
  };
}

/**
 * The security-blocked clarification: an utterance carrying injection
 * patterns that matched NO controlled vocabulary needs explicit user
 * attention before anything can be applied.
 */
export function securityClarification(excerpts: readonly string[]): ClarificationRequest {
  const excerpt = excerpts[0] ?? 'the request';
  return {
    term: excerpt,
    kind: 'security',
    message:
      'This request contains instructions this interpreter cannot and will not follow (it only proposes public metadata filters). Rephrase using filter terms, or pick filters manually.',
    candidates: [],
  };
}

/** The nothing-parsed clarification (empty utterances, pure filler). */
export function unparsedClarification(): ClarificationRequest {
  return {
    term: 'the request',
    kind: 'unparsed',
    message: 'No controlled filter vocabulary was recognized. Try naming a system, site type, property, provider, status, telemetry state, method or time step — or pick filters manually.',
    candidates: [],
  };
}

/**
 * Assemble the final proposal shape from the raw parse plus lexer drafts.
 * (Final validation and invariants: validate.ts.)
 */
export function assembleProposal(
  raw: RawProposal,
  lexResult: LexResult,
  extraClarifications: readonly ClarificationRequest[],
): FilterSetProposal {
  const clarifications = [...raw.clarifications, ...extraClarifications];
  return {
    filterSet: raw.filterSet,
    matchedTerms: raw.matchedTerms,
    unknownTerms: lexResult.unknownRuns,
    needsClarification: clarifications.length > 0,
    clarifications,
    dateFilters: lexResult.dateDrafts,
    unsupported: lexResult.unsupportedRequests,
    securityFindings: lexResult.securityFindings,
  };
}
