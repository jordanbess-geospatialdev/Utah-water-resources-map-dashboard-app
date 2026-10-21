/**
 * WD-019 deterministic natural-language filter interpretation (FR-003,
 * NFR-010, T-13).
 *
 * interpret(utterance, vocabulary, options) is the whole engine:
 * security scan → lex (dates, computed markers, controlled phrases, unknown
 * runs) → parse (AND across dimensions, OR within) → validate (manual-filter
 * rules, mirrored and equivalence-tested) → FilterSetProposal.
 *
 * Properties (tested in security.test.ts / equivalence.test.ts):
 * - PURE and DETERMINISTIC: same utterance + vocabulary + clock →
 *   byte-identical proposal. The clock is injected (options.now; defaults to
 *   the fixture seed's fixed clock so bare calls stay reproducible).
 * - The output type is ALWAYS FilterSetProposal — nothing else exists on any
 *   path, and assertProposalInvariants enforces the shape at runtime.
 * - No SQL generation, no URL fetching, no permission inference, no writes:
 *   the module graph contains no such capability (T-13 denial tests).
 * - No external AI provider is wired: this is the deterministic validation
 *   layer a future approved provider integration (NFR-010) would feed; the
 *   provider's only permitted output is an utterance for THIS parser.
 *
 * Browser-safe core: no node imports (the fixture loader lives in
 * fixtureVocabulary.ts, used by API-side tests and future
 * POST /search/interpret wiring only).
 */
import { lex } from './lexer';
import { assembleProposal, parseLexResult, securityClarification, unparsedClarification } from './parser';
import { validateProposal } from './validate';
import { buildVocabularyIndex } from './vocabulary';
import { DEFAULT_CLOCK, type FilterSetProposal, type InterpretOptions, type ParserVocabulary } from './types';

/**
 * Interpret one utterance into a validated FilterSetProposal.
 *
 * @param utterance raw user text (untrusted; truncated at MAX_UTTERANCE_LENGTH)
 * @param vocabulary the controlled vocabulary (fixture-built)
 * @param options.now injected clock for relative dates (default: fixture fixed clock)
 */
export function interpret(
  utterance: string,
  vocabulary: ParserVocabulary,
  options?: InterpretOptions,
): FilterSetProposal {
  const now =
    options?.now === undefined
      ? new Date(DEFAULT_CLOCK)
      : options.now instanceof Date
        ? options.now
        : new Date(options.now);

  const index = buildVocabularyIndex(vocabulary);
  const lexResult = lex({ utterance, index, now, restrictedObjectIds: vocabulary.restrictedObjectIds });
  const raw = parseLexResult(lexResult);

  const extra = [];
  if (raw.matchedTerms.length === 0 && lexResult.securityFindings.length > 0) {
    extra.push(securityClarification(lexResult.securityFindings.map((finding) => finding.excerpt)));
  }
  if (
    raw.clarifications.length === 0 &&
    extra.length === 0 &&
    raw.matchedTerms.length === 0 &&
    lexResult.dateDrafts.length === 0 &&
    lexResult.unsupportedRequests.length === 0
  ) {
    extra.push(unparsedClarification());
  }

  const assembled = assembleProposal(raw, lexResult, extra);
  const { proposal, notices } = validateProposal(assembled, vocabulary);
  if (notices.length > 0) {
    // The lexer only emits governed ids: a notice means an internal defect.
    // Fail loudly rather than silently diverging from manual-filter rules.
    throw new Error(
      `filter-parser internal defect: values rejected by manual-filter validation: ${JSON.stringify(notices)}`,
    );
  }
  return proposal;
}

// ---------------------------------------------------------------------------
// Public surface (types + pure helpers) for consumers and tests
// ---------------------------------------------------------------------------

export type {
  ClarificationCandidate,
  ClarificationKind,
  ClarificationRequest,
  DateFilterDraft,
  FilterSetProposal,
  InterpretOptions,
  MatchConfidence,
  MatchedTerm,
  NLFilterDimensionKey,
  NLFilterSet,
  ParserVocabulary,
  SecurityFinding,
  UnsupportedRequest,
  VocabularyValue,
} from './types';
export { DEFAULT_CLOCK } from './types';
export {
  buildVocabularyIndex,
  governedValueIds,
  normalizePhrase,
  prettifyValueId,
  SEED_LABELS,
  SEED_SITE_STATUS_VALUES,
  SEED_TELEMETRY_VALUES,
  SEED_TIME_STEPS,
} from './vocabulary';
export type { TermCandidate, VocabularyIndex } from './vocabulary';
export {
  assertProposalInvariants,
  DIMENSION_KEYS,
  FILTER_VALUE_PATTERN,
  INJECTION_PATTERNS,
  isFilterSetProposal,
  MAX_ECHO_LENGTH,
  MAX_UTTERANCE_LENGTH,
  PROPOSAL_SCHEMA_KEYS,
  scanUtterance,
} from './security';
export type { InjectionPattern, SecurityScan } from './security';
export {
  canonicalizeProposalFilterSet,
  classifyValue,
  MAX_VALUES_PER_DIMENSION,
  UNKNOWN_SENTINEL,
  validateProposal,
} from './validate';
export type { ValidationNotice, ValidatedProposal, ValueVerdict } from './validate';
export { lex } from './lexer';
export type { LexResult, TermMatch } from './lexer';
export { parseLexResult } from './parser';
export type { RawProposal } from './parser';
