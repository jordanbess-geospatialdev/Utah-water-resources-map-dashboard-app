# ai-search (WD-019, FR-003 / NFR-010 / T-13)

The inspectable plain-language search surface. A deterministic,
controlled-vocabulary parser (no external AI provider wired — see the note
below) turns an utterance into a **validated FilterSetProposal**, which the
user reviews as exact manual filter chips, edits, and applies explicitly.
The same filter engine runs manual and interpreted queries (technical
specification, "Offline, imports, notifications and AI").

## Files

| File | Role |
| --- | --- |
| `AiSearchPanel.tsx` | Accessible panel: input + interpret, proposal preview as EXACT manual filter chips (remove per chip), unknown-term clarification prompts with candidate options, applied-vs-proposed distinction, date/computed limitations, ignored-injection notices, apply/discard. Native controls only; `role="status"` announcements; Apply disabled until every clarification is decided. |
| `proposalToFilters.ts` | Pure proposal→FilterSet compile with user edits (chip removals, clarification decisions). Re-runs the REAL manual canonicalizer; `applyProposal` is a structural guard that refuses while clarifications are pending — nothing auto-executes. |
| `proposalToFilters.test.ts` | `node:test` suite (7 tests): identical compile, unknown-terms-block-apply, ambiguity candidate resolution, chip removals, replace-on-apply, determinism, injection proposals through the same gates. |
| `discoveryVocabulary.ts` | Browser-safe builder of the parser vocabulary from the shell fixture world; mirrors the API-side loader exactly (the equivalence suite asserts identical vocabularies and interpretations). |
| `index.ts` | Public exports plus the `aiSearchMount` descriptor. |

## The deterministic core (read-only relative import)

`services/api/src/ai/filter-parser/` is the single interpretation engine:
lexer + parser over the controlled vocabulary, validation mirroring the
WD-007 manual rules (equivalence-proven), prompt-injection defenses, and a
curated equivalence/injection test suite driven by `fixtures/ai/`. This
feature imports it extensionless via
`../../../../../services/api/src/ai/filter-parser/index` (resolves under
tsc/Vite natively and under `node --test` through the repo's resolve hook).

**No external AI provider is wired.** Per NFR-010, an approved provider +
state-policy review precede any external processing; this feature is the
deterministic validation layer such an integration must feed (its only
permitted output is an utterance for this parser). The proposed
`POST /search/interpret` route (technical specification) would call the same
`interpret()` on the server.

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/ai-search/proposalToFilters.test.ts

# server-side suites (equivalence + injection corpus):
cd services/api
node --test --experimental-strip-types src/ai/filter-parser/equivalence.test.ts src/ai/filter-parser/security.test.ts src/ai/filter-parser/parser.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob picks up
`src/features/**/*.test.ts`, and `@utah-water/api test` picks up
`src/**/*.test.ts`, so all suites run in CI too.)

## Pending shell wiring (one block, not yet applied)

WD-019 may not edit `apps/web/src/shell/App.tsx`. The integration is one
import plus mounting the descriptor's component; conceptually:

```tsx
import { aiSearchMount } from './features/ai-search';

// in the discovery view, above the manual filters panel:
//   <aiSearchMount.components.searchPanel
//     appliedFilters={filters}
//     onApply={setFilters}
//     proposedResultCount={filterPublicStations(proposedFilterSet).length}
//   />
```

`onApply` receives the exact manual `DiscoveryFilterSet` the chips showed —
the shell's existing filter state and share-URL codec work unchanged.

## Requirement traceability

- **FR-003** — NL metadata filtering: proposal preview as editable manual
  chips before apply; unsupported computed questions show clear limitations.
- **NFR-010** — responsible AI: structured-output validation, deterministic
  manual fallback (same engine), no external processing wired.
- **T-13** — inspectable filters, unknown terms require clarification,
  injection cannot expand grants, no generated SQL execution.
