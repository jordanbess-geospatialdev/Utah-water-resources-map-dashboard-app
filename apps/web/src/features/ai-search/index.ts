/**
 * WD-019 natural-language search feature entry point (FR-003, NFR-010, T-13).
 *
 * Exports the inspectable search panel plus the pure proposal→filter
 * helpers and the discovery vocabulary adapter. The deterministic parser
 * core is imported read-only from services/api/src/ai/filter-parser (the
 * same engine the future POST /search/interpret route will call).
 *
 * No external AI provider is wired: this is the deterministic validation
 * layer per NFR-010 (an approved provider integration is a separate task
 * whose only permitted output is an utterance for THIS parser).
 *
 * WD-019 does not edit apps/web/src/shell/App.tsx: the pending integration
 * is one import plus mounting the descriptor's component (README.md).
 */
import AiSearchPanel from './AiSearchPanel';

export { AiSearchPanel };
export default AiSearchPanel;
export type { AiSearchPanelProps } from './AiSearchPanel';
export {
  applyProposal,
  chipLabel,
  pendingClarificationsOf,
  proposalToFilterSet,
} from './proposalToFilters';
export type {
  ClarificationDecision,
  PendingClarification,
  ProposalEdits,
  ProposalToFiltersResult,
} from './proposalToFilters';
export { buildDiscoveryVocabulary, interpretWithDiscoveryVocabulary } from './discoveryVocabulary';

// Read-only re-exports of the deterministic core surface used by the shell/tests.
export {
  assertProposalInvariants,
  DEFAULT_CLOCK,
  DIMENSION_KEYS,
  interpret,
  isFilterSetProposal,
} from '../../../../../services/api/src/ai/filter-parser/index';
export type {
  ClarificationCandidate,
  ClarificationRequest,
  DateFilterDraft,
  FilterSetProposal,
  InterpretOptions,
  MatchedTerm,
  NLFilterDimensionKey,
  NLFilterSet,
  ParserVocabulary,
  SecurityFinding,
  UnsupportedRequest,
} from '../../../../../services/api/src/ai/filter-parser/index';

import AiSearchPanelComponent from './AiSearchPanel';

/** Registration descriptor for the shell's feature registry (plain-language search surface). */
export const aiSearchMount = {
  id: 'ai-search',
  label: 'Plain-language search',
  mountPath: 'ai-search',
  components: {
    searchPanel: AiSearchPanelComponent,
  },
} as const;
