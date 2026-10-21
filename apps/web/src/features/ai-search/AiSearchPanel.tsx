/**
 * AiSearchPanel - the inspectable natural-language search UI (WD-019;
 * FR-003, NFR-010, T-13).
 *
 * Behavior contract:
 * - The deterministic interpreter (services/api/src/ai/filter-parser, no
 *   external AI provider wired) turns the utterance into a FilterSetProposal.
 * - The proposal is previewed as EXACT manual filter chips — the same
 *   discovery filter model the manual panel edits — which the user can
 *   remove before applying. Chips are the proposal, not a rendering of it.
 * - Unknown terms REQUIRE clarification (never guessed): ambiguous terms
 *   offer their candidate dimensions as choices; unknown/security terms are
 *   dismissed explicitly. Apply stays disabled until every clarification is
 *   resolved.
 * - Dates and computed questions render as pending/unsupported limitations,
 *   never as filters and never with fabricated values.
 * - NOTHING auto-executes: filters change only through the explicit Apply
 *   button, which replaces the manual filter set with exactly the chips
 *   shown ("runs the same as manual filters" notice is always visible).
 * - Applied vs proposed are visually distinct sections.
 *
 * Accessibility: native form controls only; the proposal summary is a
 * role="status" aria-live="polite" region; groups carry legends; every
 * clarification control is a real button with an accessible name.
 *
 * Mountable, shell-free: state arrives via props; see index.ts + README.md
 * for the one-line shell wiring point.
 */
import { useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import type { ClarificationCandidate, FilterSetProposal, InterpretOptions } from '../../../../../services/api/src/ai/filter-parser/index';
import { DEFAULT_CLOCK } from '../../../../../services/api/src/ai/filter-parser/index';
import { appliedFilterChips, hasActiveFilters, type DiscoveryFilterSet, type FilterDimensionKey } from '../discovery/filters';
import {
  applyProposal,
  proposalToFilterSet,
  type ClarificationDecision,
  type ProposalEdits,
} from './proposalToFilters';
import { interpretWithDiscoveryVocabulary } from './discoveryVocabulary';

export interface AiSearchPanelProps {
  /** The currently applied manual filters (single source of truth stays in the parent). */
  readonly appliedFilters: DiscoveryFilterSet;
  /** Explicit apply: replaces the applied filter set with the reviewed proposal. */
  readonly onApply: (next: DiscoveryFilterSet) => void;
  /** Count of public sites matching the PROPOSED (edited) set, when the parent computes it. */
  readonly proposedResultCount?: number | null;
  /** Injected clock for relative-date determinism (defaults to the fixture fixed clock). */
  readonly clock?: string;
}

const HELP_STYLE: CSSProperties = { margin: '2px 0 6px', fontSize: 11, color: '#5a6355' };
const SECTION_STYLE: CSSProperties = { border: '1px solid #d7dcd3', borderRadius: 6, margin: '10px 0', padding: '6px 10px 10px' };
const CHIP_LIST_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, listStyle: 'none', margin: '4px 0 8px', padding: 0 };
const CHIP_STYLE: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid #9db3a8', borderRadius: 999, padding: '2px 8px', fontSize: 12 };
const APPLIED_CHIP_STYLE: CSSProperties = { ...CHIP_STYLE, background: '#eef2ec', borderStyle: 'solid' };
const UNKNOWN_CHIP_STYLE: CSSProperties = { ...CHIP_STYLE, borderStyle: 'dashed', borderColor: '#c98a2d', color: '#7a5313' };
const NOTICE_STYLE: CSSProperties = { fontSize: 11, color: '#5a6355', margin: '4px 0' };
const SECURITY_STYLE: CSSProperties = { fontSize: 11, color: '#8a2f2f', margin: '2px 0' };
const BUTTON_STYLE: CSSProperties = { font: 'inherit' };

type PanelStatus = 'idle' | 'interpreted' | 'error';

export function AiSearchPanel({ appliedFilters, onApply, proposedResultCount = null, clock = DEFAULT_CLOCK }: AiSearchPanelProps) {
  const [utterance, setUtterance] = useState('');
  const [proposal, setProposal] = useState<FilterSetProposal | null>(null);
  const [removals, setRemovals] = useState<readonly { dimension: FilterDimensionKey; value: string }[]>([]);
  const [decisions, setDecisions] = useState<readonly ClarificationDecision[]>([]);
  const [status, setStatus] = useState<PanelStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [appliedNotice, setAppliedNotice] = useState(false);

  const edits: ProposalEdits = useMemo(() => ({ removals, decisions }), [removals, decisions]);
  const compiled = useMemo(
    () => (proposal ? proposalToFilterSet(proposal, edits) : null),
    [proposal, edits],
  );

  const proposedChips = useMemo(() => (compiled ? appliedFilterChips(compiled.filterSet) : []), [compiled]);
  const appliedChips = useMemo(() => appliedFilterChips(appliedFilters), [appliedFilters]);

  function handleInterpret(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAppliedNotice(false);
    if (utterance.trim() === '') {
      setProposal(null);
      setStatus('idle');
      setError(null);
      return;
    }
    try {
      const options: InterpretOptions = { now: clock };
      const next = interpretWithDiscoveryVocabulary(utterance, options);
      setProposal(next);
      setRemovals([]);
      setDecisions([]);
      setError(null);
      setStatus('interpreted');
    } catch (interpretError) {
      // The deterministic layer throws only on internal defects; never a guess.
      setProposal(null);
      setError(interpretError instanceof Error ? interpretError.message : 'The search could not be interpreted.');
      setStatus('error');
    }
  }

  function removeChip(dimension: FilterDimensionKey, value: string): void {
    setRemovals((current) => [...current, { dimension, value }]);
  }

  function decide(index: number, chosen: ClarificationCandidate | null): void {
    setDecisions((current) => [...current.filter((decision) => decision.index !== index), { index, chosen }]);
  }

  function handleApply(): void {
    if (!proposal || !compiled || !compiled.readyToApply) return;
    const next = applyProposal(appliedFilters, proposal, edits);
    if (next === null) return; // structural guard: pending clarifications block apply
    onApply(next);
    setAppliedNotice(true);
    setProposal(null);
    setUtterance('');
    setStatus('idle');
  }

  function handleDiscard(): void {
    setProposal(null);
    setRemovals([]);
    setDecisions([]);
    setStatus('idle');
  }

  return (
    <section aria-label="Plain-language search" style={{ minWidth: 260 }}>
      <h3 style={{ fontSize: 13, margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: 0.4 }}>Search in plain language</h3>
      <p style={NOTICE_STYLE}>
        Interpreted searches run through the <strong>same filter engine as the manual filters</strong> — the proposal below is
        ordinary filter state you can inspect and edit. Nothing runs until you press Apply. No external AI provider is wired;
        this is the deterministic validation layer.
      </p>

      <form onSubmit={handleInterpret}>
        <label htmlFor="ai-search-input" style={{ display: 'block', fontSize: 12 }}>
          Describe what you are looking for (e.g. “telemetered sites in the Bear River system”)
        </label>
        <input
          id="ai-search-input"
          type="text"
          value={utterance}
          onChange={(event) => setUtterance(event.target.value)}
          style={{ width: '92%', font: 'inherit', margin: '4px 0' }}
          aria-describedby="ai-search-help"
        />
        <p id="ai-search-help" style={HELP_STYLE}>
          Names, site types, telemetry words, properties (discharge/flow, stage, voltage), methods, providers, statuses,
          processing levels and time steps are understood. Dates and computed questions (trends, releases) are shown as
          pending/unsupported rather than guessed.
        </p>
        <button type="submit" style={BUTTON_STYLE}>
          Interpret
        </button>
        {proposal && (
          <button type="button" onClick={handleDiscard} style={{ ...BUTTON_STYLE, marginLeft: 6 }}>
            Discard proposal
          </button>
        )}
      </form>

      <div role="status" aria-live="polite" style={{ margin: '8px 0', fontSize: 12 }}>
        {status === 'error' && <p style={SECURITY_STYLE}>The search could not be interpreted: {error}</p>}
        {status === 'idle' && !appliedNotice && 'Enter a search to propose filters.'}
        {appliedNotice && 'Filters applied — the manual filter panel now shows exactly these filters.'}
        {status === 'interpreted' && proposal && compiled && (
          <span>
            {proposal.matchedTerms.length === 0
              ? 'No controlled vocabulary recognized.'
              : `${proposal.matchedTerms.length} term${proposal.matchedTerms.length === 1 ? '' : 's'} matched governed filters.`}
            {compiled.pendingClarifications.length > 0 &&
              ` ${compiled.pendingClarifications.length} item${compiled.pendingClarifications.length === 1 ? '' : 's'} need your clarification before applying.`}
            {compiled.readyToApply && ' Ready to apply after your review.'}
            {proposedResultCount !== null &&
              ` ${proposedResultCount} public ${proposedResultCount === 1 ? 'site' : 'sites'} would match.`}
          </span>
        )}
      </div>

      {status === 'interpreted' && proposal && compiled && (
        <>
          <fieldset style={SECTION_STYLE}>
            <legend style={{ fontSize: 12, fontWeight: 600, padding: '0 4px' }}>Proposed filters (editable before apply)</legend>
            {proposedChips.length === 0 && <p style={NOTICE_STYLE}>No filters proposed.</p>}
            <ul style={CHIP_LIST_STYLE}>
              {proposedChips.map((chip) => (
                <li key={`proposed:${chip.dimension}:${chip.value}`} style={chip.known ? CHIP_STYLE : UNKNOWN_CHIP_STYLE}>
                  <span>
                    <strong>{chip.dimensionLabel}:</strong> {chip.valueLabel}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeChip(chip.dimension, chip.value)}
                    aria-label={`Remove proposed ${chip.dimensionLabel} filter ${chip.valueLabel}`}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, font: 'inherit' }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            {proposal.matchedTerms.length > 0 && (
              <p style={NOTICE_STYLE}>
                Matched: {proposal.matchedTerms.map((term) => `${term.input} → ${term.dimension}: ${term.valueId} (${term.confidence})`).join('; ')}.
              </p>
            )}
            <button type="button" onClick={handleApply} disabled={!compiled.readyToApply} style={BUTTON_STYLE}>
              Apply these filters
            </button>
            {!compiled.readyToApply && <p style={NOTICE_STYLE}>Resolve the clarification{compiled.pendingClarifications.length === 1 ? '' : 's'} above to enable Apply.</p>}
          </fieldset>

          {proposal.clarifications.length > 0 && (
            <fieldset style={SECTION_STYLE}>
              <legend style={{ fontSize: 12, fontWeight: 600, padding: '0 4px' }}>Needs your clarification (never guessed)</legend>
              {proposal.clarifications.map((clarification, index) => {
                const decided = decisions.some((decision) => decision.index === index);
                return (
                  <div key={`clarification:${index}`} style={{ margin: '6px 0' }}>
                    <p style={{ margin: '2px 0', fontSize: 12 }}>{clarification.message}</p>
                    {clarification.candidates.map((candidate) => (
                      <button
                        key={`${candidate.dimension}:${candidate.valueId}`}
                        type="button"
                        onClick={() => decide(index, candidate)}
                        disabled={decided}
                        aria-label={`Use ${candidate.label} as ${candidate.dimension}`}
                        style={{ ...BUTTON_STYLE, margin: '0 6px 4px 0' }}
                      >
                        {candidate.label} ({candidate.dimension})
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => decide(index, null)}
                      disabled={decided}
                      aria-label={`Dismiss "${clarification.term}" without filtering`}
                      style={{ ...BUTTON_STYLE, margin: '0 0 4px' }}
                    >
                      Not a filter — dismiss
                    </button>
                    {decided && <span style={NOTICE_STYLE}> resolved</span>}
                  </div>
                );
              })}
            </fieldset>
          )}

          {proposal.dateFilters.length > 0 && (
            <fieldset style={SECTION_STYLE}>
              <legend style={{ fontSize: 12, fontWeight: 600, padding: '0 4px' }}>Date filters (pending, not applied)</legend>
              {proposal.dateFilters.map((draft, index) => (
                <p key={`date:${index}`} style={NOTICE_STYLE}>
                  “{draft.input}” ({draft.kind}
                  {draft.start !== null && draft.end !== null ? `, ${draft.start} to ${draft.end}` : ''}) — {draft.limitation}
                </p>
              ))}
            </fieldset>
          )}

          {proposal.unsupported.length > 0 && (
            <fieldset style={SECTION_STYLE}>
              <legend style={{ fontSize: 12, fontWeight: 600, padding: '0 4px' }}>Not supported by metadata filtering</legend>
              {proposal.unsupported.map((request, index) => (
                <p key={`unsupported:${index}`} style={NOTICE_STYLE}>
                  “{request.input}” — {request.limitation}
                </p>
              ))}
            </fieldset>
          )}

          {proposal.securityFindings.length > 0 && (
            <fieldset style={SECTION_STYLE}>
              <legend style={{ fontSize: 12, fontWeight: 600, padding: '0 4px' }}>Ignored instructions (reported, never followed)</legend>
              {proposal.securityFindings.map((finding, index) => (
                <p key={`security:${index}`} style={SECURITY_STYLE}>
                  “{finding.excerpt}” — {finding.note}
                </p>
              ))}
            </fieldset>
          )}
        </>
      )}

      <fieldset style={SECTION_STYLE}>
        <legend style={{ fontSize: 12, fontWeight: 600, padding: '0 4px' }}>Currently applied filters</legend>
        {appliedChips.length === 0 || !hasActiveFilters(appliedFilters) ? (
          <p style={NOTICE_STYLE}>No filters applied.</p>
        ) : (
          <ul style={CHIP_LIST_STYLE}>
            {appliedChips.map((chip) => (
              <li key={`applied:${chip.dimension}:${chip.value}`} style={APPLIED_CHIP_STYLE}>
                <span>
                  <strong>{chip.dimensionLabel}:</strong> {chip.valueLabel}
                </span>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
    </section>
  );
}

export default AiSearchPanel;
