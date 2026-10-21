/**
 * Equivalence suite for the WD-019 NL filter layer (FR-003, T-13).
 *
 * For EVERY curated utterance in fixtures/ai/curated-utterances.json:
 *
 * 1. interpret() (deterministic core, fixture vocabulary, pinned clock)
 *    produces a filterSet that deep-equals the DOCUMENTED manual equivalent
 *    (canonicalized by the REAL WD-007 engine);
 * 2. the proposal's filterSet is unchanged by the real manual
 *    canonicalizer (canonicalizeFilters) with zero redactions — i.e. it is
 *    already exactly what the manual filter path would accept;
 * 3. the REAL discovery matcher (filterPublicStations) returns the expected
 *    public station ids for the manual set AND for the NL proposal — the
 *    identical site list, which is the FR-003 acceptance ("produce the same
 *    site IDs as manual filters");
 * 4. matched/unknown term attribution, clarifications (structural fields),
 *    date drafts and unsupported markers match the fixture;
 * 5. the apps/web vocabulary adapter produces the SAME interpretation as the
 *    API fixture loader (one grammar, two builders, no drift);
 * 6. interpret() is deterministic: a second call returns a deep-equal
 *    proposal.
 *
 * The WD-007 discovery modules are imported READ-ONLY across the package
 * boundary (per the WD-019 task brief); the resolve hook appended to .ts
 * makes their extensionless src imports load under node --test.
 *
 * Run: cd services/api && node --test --experimental-strip-types src/ai/filter-parser/equivalence.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// Extensionless src imports under node --test (see resolve-hook.mjs).
register('./resolve-hook.mjs', import.meta.url);

const parser: typeof import('./index') = await import('./index');
const loader: typeof import('./fixtureVocabulary') = await import('./fixtureVocabulary');
const discovery: typeof import('../../../../../apps/web/src/features/discovery/filters') = await import(
  '../../../../../apps/web/src/features/discovery/filters'
);
const webVocabularyModule: typeof import('../../../../../apps/web/src/features/ai-search/discoveryVocabulary') = await import(
  '../../../../../apps/web/src/features/ai-search/discoveryVocabulary'
);

interface CuratedCase {
  id: string;
  utterance: string;
  notes: string;
  expected: {
    filterSet: Record<string, string[]>;
    manualEquivalent: Record<string, string[]>;
    matchedTerms: { input: string; dimension: string; valueId: string; confidence: string }[];
    unknownTerms: string[];
    needsClarification: boolean;
    clarifications: { kind: string; term: string; candidates: { dimension: string; valueId: string; label: string }[] }[];
    dateFilters: { input: string; kind: string; start: string | null; end: string | null; status: string }[];
    unsupported: { input: string; capability: string }[];
    securityFindingIds: string[];
    expectedStationIds: string[];
  };
}

const curated = JSON.parse(
  readFileSync(new URL('../../../../../fixtures/ai/curated-utterances.json', import.meta.url), 'utf-8'),
) as { seed: string; clock: string; cases: CuratedCase[] };

const apiVocabulary = loader.loadFixtureVocabulary();
const webVocabulary = webVocabularyModule.buildDiscoveryVocabulary();
const clock = curated.clock;

const canonical = (filters: Record<string, string[]>) =>
  discovery.canonicalizeFilters(filters as never).filters as unknown as Record<string, string[]>;
const stationIds = (filters: Record<string, string[]>) =>
  discovery.filterPublicStations(filters as never).map((station) => station.id);

test('fixture world is pinned (seed, clock, curated set size)', () => {
  assert.equal(curated.seed, 'utah-water-fixture-v1');
  assert.equal(clock, '2026-03-09T07:00:00Z', 'curated clock must be the fixture fixed clock');
  assert.equal(curated.cases.length, 21, 'FR-003 three examples plus at least 12 more');
  assert.ok(curated.cases.length >= 15, 'minimum curated set (3 + 12)');
  assert.equal(apiVocabulary.restrictedObjectIds.length, 14);
});

test('both vocabulary builders produce identical controlled vocabularies', () => {
  assert.deepEqual(webVocabulary, apiVocabulary);
});

for (const testCase of curated.cases) {
  test(`curated ${testCase.id}: "${testCase.utterance}"`, () => {
    const proposal = parser.interpret(testCase.utterance, apiVocabulary, { now: clock });
    const expected = testCase.expected;

    // 1. NL filterSet equals the documented manual equivalent (canonically).
    assert.deepEqual(proposal.filterSet, canonical(expected.manualEquivalent), 'NL filterSet vs canonical manual equivalent');
    assert.deepEqual(proposal.filterSet, expected.filterSet, 'NL filterSet vs fixture expectation');

    // 2. The proposal is already canonical under the REAL manual rules: no
    //    redactions, no reordering, nothing dropped.
    const recanonicalized = discovery.canonicalizeFilters(proposal.filterSet as never);
    assert.equal(recanonicalized.redactions.length, 0, 'manual engine redacts nothing from the proposal');
    assert.deepEqual(recanonicalized.filters as unknown as object, proposal.filterSet, 'proposal is manual-canonical');

    // 3. Same site IDs as manual filters (the FR-003 acceptance).
    const manualStations = stationIds(expected.manualEquivalent);
    assert.deepEqual(manualStations, expected.expectedStationIds, 'manual filter station ids');
    const nlStations = stationIds(proposal.filterSet as unknown as Record<string, string[]>);
    assert.deepEqual(nlStations, manualStations, 'NL and manual produce IDENTICAL station results');

    // 4. Attribution and clarification projections.
    assert.deepEqual(proposal.matchedTerms, expected.matchedTerms, 'matched terms');
    assert.deepEqual(proposal.unknownTerms, expected.unknownTerms, 'unknown terms');
    assert.equal(proposal.needsClarification, expected.needsClarification, 'needsClarification');
    assert.deepEqual(
      proposal.clarifications.map((c) => ({ kind: c.kind, term: c.term, candidates: c.candidates })),
      expected.clarifications,
      'clarifications (structural)',
    );
    assert.ok(
      proposal.clarifications.every((c) => c.message.length > 0 && c.candidates.every((candidate) => candidate.label.length > 0)),
      'clarifications carry visible messages/labels',
    );
    assert.deepEqual(
      proposal.dateFilters.map((d) => ({ input: d.input, kind: d.kind, start: d.start, end: d.end, status: d.status })),
      expected.dateFilters,
      'date drafts (structural)',
    );
    assert.ok(proposal.dateFilters.every((d) => d.limitation.length > 0), 'date drafts carry limitations');
    assert.deepEqual(
      proposal.unsupported.map((u) => ({ input: u.input, capability: u.capability })),
      expected.unsupported,
      'unsupported requests (structural)',
    );
    assert.ok(proposal.unsupported.every((u) => u.limitation.length > 0), 'unsupported requests carry limitations');
    assert.deepEqual(proposal.securityFindings.map((f) => f.patternId), expected.securityFindingIds, 'security findings');

    // 5. The web adapter interprets identically (one engine, no drift).
    const webProposal = webVocabularyModule.interpretWithDiscoveryVocabulary(testCase.utterance, { now: clock });
    assert.deepEqual(webProposal, proposal, 'web-built vocabulary yields the identical proposal');

    // 6. Deterministic: a second call is deep-equal, and JSON-stable.
    const again = parser.interpret(testCase.utterance, apiVocabulary, { now: clock });
    assert.deepEqual(again, proposal);
    assert.equal(JSON.stringify(again), JSON.stringify(proposal));

    // Output type is always FilterSetProposal.
    assert.ok(parser.isFilterSetProposal(proposal));
    parser.assertProposalInvariants(proposal, apiVocabulary);
  });
}

test('relative dates follow the injected clock, not wall time', () => {
  const proposal = parser.interpret('stage data from the last week', apiVocabulary, { now: '2026-06-01T00:00:00Z' });
  const draft = proposal.dateFilters[0]!;
  assert.equal(draft.kind, 'relative');
  assert.equal(draft.start, '2026-05-25T00:00:00Z');
  assert.equal(draft.end, '2026-06-01T00:00:00Z');
  const again = parser.interpret('stage data from the last week', apiVocabulary, { now: new Date('2026-06-01T00:00:00Z') });
  assert.deepEqual(again.dateFilters, proposal.dateFilters, 'Date and ISO clock inputs agree');
});

test('every curated case passes through the injected clock deterministically (double run)', () => {
  for (const testCase of curated.cases) {
    const first = parser.interpret(testCase.utterance, apiVocabulary, { now: clock });
    const second = parser.interpret(testCase.utterance, apiVocabulary, { now: clock });
    assert.deepEqual(second, first, testCase.id);
  }
});

test('NL proposals never redact under manual rules across the whole curated set', () => {
  for (const testCase of curated.cases) {
    const proposal = parser.interpret(testCase.utterance, apiVocabulary, { now: clock });
    const result = discovery.canonicalizeFilters(proposal.filterSet as never);
    assert.deepEqual(
      result.filters as unknown as object,
      proposal.filterSet,
      `${testCase.id}: proposal must be manual-canonical as-is`,
    );
  }
});
