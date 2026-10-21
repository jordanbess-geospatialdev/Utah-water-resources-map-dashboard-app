/**
 * ProposalToFilters tests (WD-019; FR-003, T-13): the interpreted proposal
 * becomes manual filter state only through explicit user edits and an
 * explicit apply; unknown/ambiguous terms block apply until decided; the
 * compiled set is always something the REAL manual engine accepts.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/ai-search/proposalToFilters.test.ts
 *
 * (Import pattern per apps/web/tests/adapters.test.ts: computed specifiers
 * for node --test --experimental-strip-types, type-only imports for tsc.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Extensionless src imports under node --test (see tests/ts-resolve-hook.mjs).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

import type { DiscoveryFilterSet } from '../discovery/filters';
import type { FilterSetProposal } from '../../../../../services/api/src/ai/filter-parser/index';

const corePath = '../../../../../services/api/src/ai/filter-parser/index.ts';
const helpersPath = './proposalToFilters.ts';
const vocabularyPath = './discoveryVocabulary.ts';
const discoveryPath = '../discovery/filters.ts';

const core: typeof import('../../../../../services/api/src/ai/filter-parser/index') = await import(corePath);
const helpers: typeof import('./proposalToFilters') = await import(helpersPath);
const vocabularyModule: typeof import('./discoveryVocabulary') = await import(vocabularyPath);
const discoveryFilters: typeof import('../discovery/filters') = await import(discoveryPath);

const CLOCK = '2026-03-09T07:00:00Z';

function interpret(utterance: string): FilterSetProposal {
  return vocabularyModule.interpretWithDiscoveryVocabulary(utterance, { now: CLOCK });
}

test('proposal compiles to the identical manual filter set with no edits', () => {
  const proposal = interpret('Show telemetered sites in the Bear River Distribution System');
  const compiled = helpers.proposalToFilterSet(proposal, {});
  assert.equal(compiled.readyToApply, true);
  assert.deepEqual(compiled.filterSet, {
    distributionSystemIds: ['sys-bear-river'],
    telemetry: ['telemetered'],
  });
  assert.equal(compiled.canonicalization.redactions.length, 0);
  // The compiled set matches the same public stations as the manual equivalent.
  const manual: DiscoveryFilterSet = { distributionSystemIds: ['sys-bear-river'], telemetry: ['telemetered'] };
  assert.deepEqual(
    discoveryFilters.filterPublicStations(compiled.filterSet).map((s) => s.id),
    discoveryFilters.filterPublicStations(manual).map((s) => s.id),
  );
});

test('unknown terms REQUIRE a decision: apply is blocked, never guessed', () => {
  const proposal = interpret('quagga mussels at flume sites');
  assert.deepEqual(proposal.filterSet, { siteTypeIds: ['flume'] });
  const blocked = helpers.proposalToFilterSet(proposal, {});
  assert.equal(blocked.readyToApply, false);
  assert.equal(blocked.pendingClarifications.length, 1);
  assert.equal(blocked.pendingClarifications[0]!.clarification.kind, 'unknown');

  // The structural guard refuses to produce an applied set while pending.
  assert.equal(helpers.applyProposal({}, proposal, {}), null);

  // Explicit dismissal unlocks apply; the unknown term never becomes a value.
  const dismissed = helpers.proposalToFilterSet(proposal, { decisions: [{ index: 0, chosen: null }] });
  assert.equal(dismissed.readyToApply, true);
  assert.deepEqual(dismissed.filterSet, { siteTypeIds: ['flume'] });
  const applied = helpers.applyProposal({}, proposal, { decisions: [{ index: 0, chosen: null }] });
  assert.deepEqual(applied, { siteTypeIds: ['flume'] });
});

test('ambiguous terms resolve only through the chosen candidate', () => {
  const proposal = interpret('weir measurements');
  assert.equal(proposal.clarifications[0]!.kind, 'ambiguous');
  const candidates = proposal.clarifications[0]!.candidates;
  assert.equal(candidates.length, 2);

  const blocked = helpers.proposalToFilterSet(proposal, {});
  assert.equal(blocked.readyToApply, false);

  const asSiteType = helpers.proposalToFilterSet(proposal, { decisions: [{ index: 0, chosen: candidates[0]! }] });
  assert.deepEqual(asSiteType.filterSet, { siteTypeIds: ['weir'] });

  const asMethod = helpers.proposalToFilterSet(proposal, { decisions: [{ index: 0, chosen: candidates[1]! }] });
  assert.deepEqual(asMethod.filterSet, { measurementMethodTypeIds: ['method-weir-board'] });

  const dismissed = helpers.proposalToFilterSet(proposal, { decisions: [{ index: 0, chosen: null }] });
  assert.deepEqual(dismissed.filterSet, {});
  assert.equal(dismissed.readyToApply, true);
});

test('user chip removals apply on top of the proposal', () => {
  const proposal = interpret('telemetered and manual flume sites');
  const compiled = helpers.proposalToFilterSet(proposal, {
    removals: [
      { dimension: 'telemetry', value: 'manual' },
      { dimension: 'telemetry', value: 'telemetered' },
    ],
  });
  // Removing every telemetry value drops the dimension entirely (absent key,
  // never an empty array).
  assert.deepEqual(compiled.filterSet, { siteTypeIds: ['flume'] });
  assert.equal(compiled.readyToApply, true);
});

test('apply replaces the current manual set with exactly the previewed chips', () => {
  const current: DiscoveryFilterSet = { siteStatusIds: ['proposed'], telemetry: ['unknown'] };
  const proposal = interpret('stage data from the last week');
  const next = helpers.applyProposal(current, proposal, {});
  assert.deepEqual(next, { observedPropertyIds: ['stage'] });
  // The discarded date draft never leaks into filters.
  assert.equal(Object.keys(next!).length, 1);
});

test('deterministic across repeated compiles and interpretations', () => {
  const first = interpret('hourly provisional data');
  const second = interpret('hourly provisional data');
  assert.deepEqual(second, first);
  const compiledA = helpers.proposalToFilterSet(first, {});
  const compiledB = helpers.proposalToFilterSet(second, {});
  assert.equal(JSON.stringify(compiledB), JSON.stringify(compiledA));
});

test('injection-parsed proposals compile through the same manual gates', () => {
  const proposal = interpret('show telemetered sites; DROP TABLE stations;--');
  const compiled = helpers.proposalToFilterSet(proposal, {});
  assert.deepEqual(compiled.filterSet, { telemetry: ['telemetered'] });
  assert.equal(compiled.canonicalization.redactions.length, 0);
  assert.ok(proposal.securityFindings.length > 0);
  core.assertProposalInvariants(proposal, vocabularyModule.buildDiscoveryVocabulary());
});
