/**
 * Prompt-injection defense for the WD-019 NL filter layer (NFR-010, T-13).
 *
 * Threat model: utterance text is untrusted. The defense is STRUCTURAL, not
 * prompt-based — there is no model and no prompt in this layer:
 *
 * 1. The only artifact interpret() can emit is a FilterSetProposal whose
 *    filterSet uses governed identifier values exclusively. Free text can
 *    never become a filter value (FILTER_VALUE_PATTERN), so instruction
 *    text, SQL, URLs and role claims have no channel into execution.
 * 2. Injection-shaped fragments are detected for REPORTING (visible
 *    explanations per the technical specification), consumed out of the
 *    unknown-term stream (never echoed back as proposal content), and never
 *    widen parsing: patterns cannot add, remove or upgrade filter values.
 * 3. assertProposalInvariants() is the runtime proof: it throws unless the
 *    output is exactly the FilterSetProposal schema with allowlisted
 *    dimension keys, pattern-conforming values, governed matchedTerm ids and
 *    bounded echoes. validate.ts calls it; security.test.ts drives the whole
 *    adversarial corpus (fixtures/ai/injection-corpus.json) through it.
 *
 * There is no code path that builds SQL, fetches URLs, asserts roles or
 * performs writes: the module graph (types/vocabulary/lexer/parser/validate)
 * contains no such capability, and the tests assert the output type is
 * always FilterSetProposal.
 *
 * Pure module: no I/O, no clock, no eval, no dynamic import.
 */
import type { FilterSetProposal, NLFilterDimensionKey, ParserVocabulary, SecurityFinding } from './types';
import { ENUM_DIMENSIONS, governedValueIds } from './vocabulary';

/** Governed identifier shape — identical to the WD-007 FILTER_VALUE_PATTERN. */
export const FILTER_VALUE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The FilterSetProposal schema: exactly these top-level keys, nothing else may exist. */
export const PROPOSAL_SCHEMA_KEYS: readonly string[] = [
  'filterSet',
  'matchedTerms',
  'unknownTerms',
  'needsClarification',
  'clarifications',
  'dateFilters',
  'unsupported',
  'securityFindings',
];

/** The allowlisted dimension keys (mirror of the WD-007 registry). */
export const DIMENSION_KEYS: readonly NLFilterDimensionKey[] = [
  'distributionSystemIds',
  'subgroupIds',
  'siteTypeIds',
  'telemetry',
  'providerIds',
  'observedPropertyIds',
  'controlStructureIds',
  'structureMaterialIds',
  'structureSizeIds',
  'waterSourceTypeIds',
  'measuringDeviceTypeIds',
  'measurementMethodTypeIds',
  'siteStatusIds',
  'timeStepIds',
  'processingLevels',
];

/** Upper bound on echoed unknown-term text (display-only; bounded so logs cannot be flooded). */
export const MAX_ECHO_LENGTH = 80;

/** Longest utterance accepted (excess is truncated before lexing; findings still reported). */
export const MAX_UTTERANCE_LENGTH = 500;

export interface InjectionPattern {
  readonly id: string;
  readonly regex: RegExp;
  readonly note: string;
}

/**
 * The adversarial patterns (fixtures/ai/injection-corpus.json exercises every
 * family). Detection changes REPORTING only — never the parse result.
 */
export const INJECTION_PATTERNS: readonly InjectionPattern[] = [
  {
    id: 'override-instructions',
    regex: /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|your|all)\b[^.]{0,20}\b(instruction|instructions|prompt|prompts|rule|rules|directions)\b/i,
    note: 'Attempt to override interpreter instructions. Ignored: this layer has no instructions to override — only governed vocabulary maps to filters.',
  },
  {
    id: 'system-prompt-probe',
    regex: /\b(system prompt|reveal (your|the) (instructions|prompt|configuration)|print (your|the) (instructions|prompt))\b/i,
    note: 'Probe for interpreter internals. There is no model prompt; nothing to reveal.',
  },
  {
    id: 'role-assertion',
    regex: /\b(as|now|i am|acting as|act as|pretend (to be|you are)|speaking as)\b[^.]{0,24}\b(admin|administrator|steward|owner|root|sudo|engineer|internal|manager|supervisor)\b/i,
    note: 'Role assertion. Roles cannot alter discovery: filters run against the public catalog exactly like manual filters.',
  },
  {
    id: 'grant-request',
    regex: /\b(grant (me|us)|give (me|us)|elevate|escalate)\b[^.]{0,30}\b(access|permission|permissions|rights|role|privileges?|entitlements?)\b/i,
    note: 'Grant request. This layer cannot create, infer or expand grants; it only proposes public-dimension filters.',
  },
  {
    id: 'private-data-request',
    regex: /\b(show|include|list|display|reveal|return)\b[^.]{0,24}\b(all\s+)?(private|restricted|internal|hidden|owner-only|non-?public)\b[^.]{0,24}\b(data|records?|stations?|sites?|streams?|fields?|blocks?)\b/i,
    note: 'Request for non-public data. The public catalog is the only world filters can select from; restricted objects are not representable.',
  },
  {
    id: 'visibility-bypass',
    regex: /\b(bypass|circumvent|disable|override)\b[^.]{0,24}\b(permissions?|access controls?|visibility|authorization|security|filters? guard)\b/i,
    note: 'Bypass attempt. There is no path around validation: every proposal re-validates against manual-filter rules.',
  },
  {
    id: 'sql-fragment',
    regex: /\b(select\s+[\w*,\s`'"-]+?\s+from|drop\s+(table|database|schema)|truncate\s+table|insert\s+into|delete\s+from|update\s+\w+\s+set|union\s+(all\s+)?select|exec(ute)?\s+(sql|immediate)|;\s*--|--\s*$|\/\*!\d|\bor\s+1\s*=\s*1\b|\band\s+1\s*=\s*1\b|\b1\s*=\s*1\b)/i,
    note: 'SQL fragment. No SQL is generated or executed anywhere in this layer; text can never become a query.',
  },
  {
    id: 'credential-exfil',
    regex: /\b(passwords?|passwds?|credentials?|secrets?|api[_-]?keys?|tokens?)\b(\s*[=:]\s*\S+)?/i,
    note: 'Credential-looking fragment. Reported and discarded; this layer holds no secrets and transmits nothing.',
  },
  {
    id: 'url-fetch',
    regex: /(\bhttps?:\/\/\S+|\bwww\.[a-z0-9-]+\.\S+|\bfetch\s+[a-z]{0,12}\s*url\b|\bcall\s+(this|the)\s+(url|endpoint|api)\b|\bcurl\s+\S+)/i,
    note: 'URL or exfiltration endpoint. This layer fetches nothing; URLs can never be executed or embedded as filter values.',
  },
  {
    id: 'write-request',
    regex: /\b(delete|destroy|truncate|overwrite|update|modify|correct|finalize|erase)\b[^.]{0,30}\b(records?|data|values?|observations?|measurements?|sites?|stations?|rows?)\b/i,
    note: 'Write request. The filter layer is read-only: applying a proposal only ever sets the inspected manual filter set.',
  },
];

export interface SecurityScan {
  readonly findings: readonly SecurityFinding[];
  /** Character ranges [start, end) covered by a finding — the lexer never echoes these as unknown terms. */
  readonly coveredRanges: readonly [number, number][];
}

function excerptOf(utterance: string, start: number, end: number): string {
  const raw = utterance.slice(start, end).trim();
  return raw.length > MAX_ECHO_LENGTH ? `${raw.slice(0, MAX_ECHO_LENGTH)}…` : raw;
}

/** Scan raw utterance text (pre-normalization, so excerpts read naturally). Deterministic.
 *
 * `restrictedObjectIds` (from the vocabulary) additionally flags literal
 * identifiers of restricted objects: they are never filter values, never
 * echoed as unknown terms, and can never select anything.
 */
export function scanUtterance(utterance: string, restrictedObjectIds: readonly string[] = []): SecurityScan {
  const findings: SecurityFinding[] = [];
  const coveredRanges: [number, number][] = [];
  if (typeof utterance !== 'string') return { findings, coveredRanges };
  const bounded = utterance.length > MAX_UTTERANCE_LENGTH ? utterance.slice(0, MAX_UTTERANCE_LENGTH) : utterance;
  for (const pattern of INJECTION_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags.includes('g') ? pattern.regex.flags : `${pattern.regex.flags}g`);
    for (const match of bounded.matchAll(regex)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      coveredRanges.push([start, end]);
      findings.push({ patternId: pattern.id, excerpt: excerptOf(bounded, start, end), note: pattern.note });
    }
  }
  const restrictedNote =
    'Identifier of a restricted object. Restricted identifiers are never filter values and never select anything; the request cannot be honored as stated.';
  const lowered = bounded.toLowerCase();
  for (const id of restrictedObjectIds) {
    let from = 0;
    for (;;) {
      const at = lowered.indexOf(id, from);
      if (at < 0) break;
      coveredRanges.push([at, at + id.length]);
      findings.push({ patternId: 'restricted-identifier-request', excerpt: excerptOf(bounded, at, at + id.length), note: restrictedNote });
      from = at + id.length;
    }
  }
  return { findings, coveredRanges };
}

/** Is a raw utterance offset inside a security-covered range (never echo it as an unknown term)? */
export function isCoveredBySecurity(scan: SecurityScan, offset: number): boolean {
  return scan.coveredRanges.some(([start, end]) => offset >= start && offset < end);
}

// ---------------------------------------------------------------------------
// Output invariants — the runtime proof that the output type is always FilterSetProposal
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(`proposal invariant violated: ${message}`);
}

/**
 * Assert the proposal IS the FilterSetProposal schema and nothing more:
 * exactly the allowlisted top-level keys; dimension keys within the
 * allowlist; every value a governed identifier shape; enum dimensions
 * restricted to members; no restricted identifiers; matchedTerms reference
 * governed values; echoes bounded plain strings. Throws on any violation.
 */
export function assertProposalInvariants(proposal: FilterSetProposal, vocabulary: ParserVocabulary): void {
  if (typeof proposal !== 'object' || proposal === null) fail('proposal is not an object');
  const keys = Object.keys(proposal);
  const expected = new Set(PROPOSAL_SCHEMA_KEYS);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    fail(`top-level keys outside the FilterSetProposal schema: ${keys.join(', ')}`);
  }

  const governed = governedValueIds(vocabulary);
  const restricted = new Set(vocabulary.restrictedObjectIds);
  const filterSet = proposal.filterSet;
  if (typeof filterSet !== 'object' || filterSet === null) fail('filterSet is not an object');
  for (const key of Object.keys(filterSet)) {
    if (!DIMENSION_KEYS.includes(key as NLFilterDimensionKey)) fail(`dimension key outside the allowlist: ${key}`);
    const values = (filterSet as Record<string, unknown>)[key];
    if (!Array.isArray(values)) fail(`filterSet.${key} is not an array`);
    for (const value of values) {
      if (typeof value !== 'string' || !FILTER_VALUE_PATTERN.test(value)) {
        fail(`filterSet.${key} carries a non-governed value shape: ${String(value)}`);
      }
      if (restricted.has(value)) fail(`filterSet.${key} carries a restricted identifier: ${value}`);
      if (ENUM_DIMENSIONS.has(key as NLFilterDimensionKey) && !governed[key as NLFilterDimensionKey].has(value)) {
        fail(`filterSet.${key} carries a non-enum member: ${value}`);
      }
    }
    const sorted = [...values as string[]].sort();
    if (sorted.join('\u0000') !== (values as string[]).join('\u0000')) fail(`filterSet.${key} is not canonically sorted/deduped`);
    if ((values as string[]).length > 48) fail(`filterSet.${key} exceeds cardinality 48`);
  }

  for (const term of proposal.matchedTerms) {
    if (typeof term.input !== 'string' || term.input === '') fail('matchedTerm without input');
    if (!DIMENSION_KEYS.includes(term.dimension)) fail(`matchedTerm dimension outside allowlist: ${term.dimension}`);
    if (!governed[term.dimension].has(term.valueId)) fail(`matchedTerm references an ungoverned value: ${term.dimension}:${term.valueId}`);
    if (term.confidence !== 'exact' && term.confidence !== 'synonym') fail('matchedTerm confidence must be exact|synonym');
  }

  for (const term of proposal.unknownTerms) {
    if (typeof term !== 'string') fail('unknown term is not a string');
    if (term.length > MAX_ECHO_LENGTH) fail(`unknown term echo exceeds ${MAX_ECHO_LENGTH} chars`);
    if (/https?:\/\/|\bwww\./i.test(term)) fail('unknown term echo contains a URL');
    if (/\b(select\b.+\bfrom|drop\s+table|union\s+select|;\s*--)\b/i.test(term)) fail('unknown term echo contains SQL');
  }

  if (typeof proposal.needsClarification !== 'boolean') fail('needsClarification is not a boolean');
  if (proposal.needsClarification !== (proposal.clarifications.length > 0)) {
    fail('needsClarification must be true exactly when clarifications exist');
  }
  for (const clarification of proposal.clarifications) {
    if (!['unknown', 'ambiguous', 'security', 'unparsed'].includes(clarification.kind)) fail('clarification kind unknown');
    if (clarification.kind === 'ambiguous' && clarification.candidates.length < 2) {
      fail('ambiguous clarification must list at least two candidates');
    }
    for (const candidate of clarification.candidates) {
      if (!governed[candidate.dimension].has(candidate.valueId)) {
        fail(`clarification candidate not governed: ${candidate.dimension}:${candidate.valueId}`);
      }
    }
  }
  for (const draft of proposal.dateFilters) {
    if (draft.status !== 'pending-governance' && draft.status !== 'unsupported-pending-owner') fail('date draft status unknown');
    if (draft.status === 'unsupported-pending-owner' && (draft.start !== null || draft.end !== null)) {
      fail('unsupported-pending-owner date draft must not carry computed instants');
    }
  }
  for (const finding of proposal.securityFindings) {
    if (finding.excerpt.length > MAX_ECHO_LENGTH + 1) fail('security excerpt exceeds bound');
  }

  // Serializable (proposal crosses the future POST /search/interpret boundary as JSON).
  JSON.stringify(proposal);
}

/** The output type is always FilterSetProposal — the guard callers can assert cheaply. */
export function isFilterSetProposal(candidate: unknown): candidate is FilterSetProposal {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    Object.keys(candidate).length === PROPOSAL_SCHEMA_KEYS.length &&
    PROPOSAL_SCHEMA_KEYS.every((key) => key in candidate)
  );
}
