/**
 * Shared types for the WD-019 deterministic natural-language filter layer
 * (FR-003, NFR-010, T-13).
 *
 * Design contract (docs/product/baseline/01-product-requirements.md, "Filter
 * semantics and data presentation"; 02-technical-specification.md, "Offline,
 * imports, notifications and AI"):
 *
 * - Natural-language filtering is a TRANSLATION into an allowlisted schema
 *   followed by user inspection and normal server validation. The only
 *   structured artifact this layer can emit is a FilterSetProposal whose
 *   `filterSet` uses exactly the WD-007 DiscoveryFilterSet dimension keys
 *   (apps/web/src/features/discovery/filters.ts — relative import is
 *   read-only; the key set below mirrors it 1:1 and equivalence.test.ts
 *   proves the mirror).
 * - AND across dimensions, OR within a dimension; absent key = no
 *   constraint; multi-value arrays deduplicated and sorted by code point.
 * - Unknown terms REQUIRE clarification — they are never guessed into a
 *   filter value. Ambiguous terms (two candidate dimensions) likewise
 *   require clarification, with the candidates listed.
 * - Dates parse into inspectable drafts only: the FilterSet schema has no
 *   governed date dimension at seed v0.1.0, and availability semantics
 *   (any-data-in-period vs complete coverage vs available-since) is a
 *   steward decision that must not be inferred from a label. Water-year
 *   phrasing is flagged unsupported-pending-owner.
 * - Computed questions (rapidly declining flow, current reservoir release)
 *   route to a clear limitation; no values are fabricated.
 *
 * Browser-safe pure types only: no node imports, no clock reads, no I/O.
 */

/** The 15 WD-007 discovery dimension keys, mirrored exactly (order = registry order). */
export type NLFilterDimensionKey =
  | 'distributionSystemIds'
  | 'subgroupIds'
  | 'siteTypeIds'
  | 'telemetry'
  | 'providerIds'
  | 'observedPropertyIds'
  | 'controlStructureIds'
  | 'structureMaterialIds'
  | 'structureSizeIds'
  | 'waterSourceTypeIds'
  | 'measuringDeviceTypeIds'
  | 'measurementMethodTypeIds'
  | 'siteStatusIds'
  | 'timeStepIds'
  | 'processingLevels';

/**
 * The parser-side mirror of DiscoveryFilterSet. Structurally identical: every
 * key optional, absent = no constraint, arrays are OR within the dimension.
 * Values are governed identifiers only (FILTER_VALUE_PATTERN); free text can
 * never enter (lexer only emits vocabulary ids).
 */
export interface NLFilterSet {
  readonly distributionSystemIds?: readonly string[];
  readonly subgroupIds?: readonly string[];
  readonly siteTypeIds?: readonly string[];
  readonly telemetry?: readonly string[];
  readonly providerIds?: readonly string[];
  readonly observedPropertyIds?: readonly string[];
  readonly controlStructureIds?: readonly string[];
  readonly structureMaterialIds?: readonly string[];
  readonly structureSizeIds?: readonly string[];
  readonly waterSourceTypeIds?: readonly string[];
  readonly measuringDeviceTypeIds?: readonly string[];
  readonly measurementMethodTypeIds?: readonly string[];
  readonly siteStatusIds?: readonly string[];
  readonly timeStepIds?: readonly string[];
  readonly processingLevels?: readonly string[];
}

/** How surely a spoken phrase mapped onto a governed value. */
export type MatchConfidence = 'exact' | 'synonym';

/** One recognized phrase → governed value attribution (user-inspectable). */
export interface MatchedTerm {
  /** The normalized input phrase that matched (lowercased, punctuation-stripped). */
  readonly input: string;
  readonly dimension: NLFilterDimensionKey;
  readonly valueId: string;
  readonly confidence: MatchConfidence;
}

/** A governed value offered as a clarification candidate. */
export interface ClarificationCandidate {
  readonly dimension: NLFilterDimensionKey;
  readonly valueId: string;
  readonly label: string;
}

/** Why the user must clarify before the proposal can be applied. */
export type ClarificationKind = 'unknown' | 'ambiguous' | 'security' | 'unparsed';

export interface ClarificationRequest {
  /** The term needing clarification (normalized input), or a bounded excerpt for security/unparsed. */
  readonly term: string;
  readonly kind: ClarificationKind;
  /** Human-facing message; never suggests a guess for unknown terms. */
  readonly message: string;
  /** Offered candidates (ambiguous terms list exactly the competing dimensions). */
  readonly candidates: readonly ClarificationCandidate[];
}

/** Parsed-but-pending date expression. Never part of the FilterSet; never applied silently. */
export interface DateFilterDraft {
  readonly input: string;
  readonly kind: 'relative' | 'absolute-since' | 'absolute-window' | 'water-year';
  /** ISO instant or null when semantics are pending and must not be computed. */
  readonly start: string | null;
  readonly end: string | null;
  readonly status: 'pending-governance' | 'unsupported-pending-owner';
  readonly limitation: string;
}

/** A request fragment this layer cannot honor, with the honest alternative. */
export interface UnsupportedRequest {
  readonly input: string;
  readonly capability: 'computed-analysis' | 'water-year' | 'other';
  readonly limitation: string;
}

/** Prompt-injection / hostile-input finding. Display-only; never widens parsing. */
export interface SecurityFinding {
  readonly patternId: string;
  /** Bounded excerpt of the matched input (for the visible explanation). */
  readonly excerpt: string;
  readonly note: string;
}

/**
 * The ONLY artifact interpret() can produce (T-13: "expected validated AST").
 * assertProposalInvariants (security.ts) enforces this shape at runtime.
 */
export interface FilterSetProposal {
  readonly filterSet: NLFilterSet;
  readonly matchedTerms: readonly MatchedTerm[];
  readonly unknownTerms: readonly string[];
  readonly needsClarification: boolean;
  readonly clarifications: readonly ClarificationRequest[];
  readonly dateFilters: readonly DateFilterDraft[];
  readonly unsupported: readonly UnsupportedRequest[];
  readonly securityFindings: readonly SecurityFinding[];
}

/** A governed value offered by one dimension of the controlled vocabulary. */
export interface VocabularyValue {
  readonly id: string;
  readonly label: string;
  /** Extra phrases mapping to this value, beyond label-derived and core synonyms. */
  readonly synonyms?: readonly string[];
}

/**
 * The controlled vocabulary the grammar runs over (built from the fixture
 * contracts by services/api/src/ai/filter-parser/fixtureVocabulary.ts and by
 * apps/web/src/features/ai-search/discoveryVocabulary.ts; equivalence.test.ts
 * proves both builders produce identical interpretations).
 */
export interface ParserVocabulary {
  readonly systems: readonly VocabularyValue[];
  readonly subgroups: readonly VocabularyValue[];
  readonly providers: readonly VocabularyValue[];
  readonly observedProperties: readonly VocabularyValue[];
  readonly siteTypes: readonly VocabularyValue[];
  readonly waterSourceTypes: readonly VocabularyValue[];
  readonly measurementMethodTypes: readonly VocabularyValue[];
  readonly timeSteps: readonly VocabularyValue[];
  readonly telemetryValues: readonly VocabularyValue[];
  readonly siteStatusValues: readonly VocabularyValue[];
  readonly processingLevels: readonly VocabularyValue[];
  /** Identifiers of restricted objects: never legal filter values, never echoed as proposals. */
  readonly restrictedObjectIds: readonly string[];
}

/** Options for interpret(). The clock is INJECTED for relative-date determinism. */
export interface InterpretOptions {
  /**
   * Effective "now" as an ISO instant or Date. Defaults to DEFAULT_CLOCK (the
   * fixture seed's fixed clock) so bare calls stay deterministic; callers
   * with a real clock inject it.
   */
  readonly now?: string | Date;
}

/** Determinism anchor: the seed manifest fixed clock (fixtures/contracts/seed-manifest.json). */
export const DEFAULT_CLOCK = '2026-03-09T07:00:00Z';
