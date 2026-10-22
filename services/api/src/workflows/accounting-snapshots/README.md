# accounting-snapshots (WD-025-R2, FR-028/FR-029/FR-030)

Decision evidence, immutable finalization, flexible periods and advisory
supplemental context for distribution accounting. Modeled SEPARATELY from
the revisable measurement stream (technical specification, "Originals and
corrections"): supersede, never rewrite.

| File | Role |
| --- | --- |
| `types.ts` | Domain vocabulary: `DecisionSnapshot` (exact observation/revision ids, curve lineage, calculation inputs, decidedAt/By), `FinalizedAccounting` (period as `PeriodSpec`, `contentHash`, finalizedBy/At, lifecycle, supersession linkage), `PeriodSpec` (calendar-year / water-year / irrigation-season / custom with explicit half-open instants, mid-month boundaries supported), `SupplementalContext` (approved inputs only, mandatory advisory label), plus the mandatory `ADVISORY_LABEL` and a `deepFreeze` helper. |
| `decisions.ts` | `recordDecision`: gates on the WD-025 report scope (generate-reports), then COPIES the exact current revision heads, curve lineage and calculation inputs into a deep-frozen snapshot. Later WD-011 corrections provably cannot alter it (test appends a correction after recording and asserts byte-identical bytes). Basis totals come from the WD-008 aggregation over the resolved window. |
| `finalize.ts` | Policy-gated finalize/reopen via the entitlement engine (explicit `finalize-accounting` capability; assignments pending owner ratification). `FinalizedLedger` freezes records with a sha256 `contentHash`; optimistic concurrency (`expectedCurrentId`) yields the typed `FINALIZE_CONFLICT` (409) for the loser of two simultaneous finalizations of one period slot; `finalizeSuperseding` is the authorized correction path: a new record with explicit `supersedes` linkage whose prior bytes - both hashes - never change. |
| `periods.ts` | `resolvePeriod` (governed kinds delegate to the WD-025 `periodWindow`; custom windows validate explicit half-open instants), DST day facts, half-open `selectObservationsInPeriod`, and `periodCategoryTotals` (WD-008 aggregation + WD-025 grant gates over ANY window - the reconciliation surface). |
| `supplemental.ts` | Advisory comparison against APPROVED inputs only; pending inputs are excluded and listed; the advisory label is mandatory on every row/context and `assertAdvisoryLabeled` throws if any output loses it. |
| `test/` | `decisions.test.ts` (evidence exactness, immutability under later corrections, determinism, recording authority), `finalize.test.ts` (authority matrix, concurrency conflict, supersession linkage with dual-hash stability, measurement-correction independence), `periods.test.ts` (mid-month selection goldens, DST facts, reconciliation to the WD-008/WD-025 aggregation), `supplemental.test.ts` (approved-only comparison, advisory labels), `determinism.test.ts` (full pipeline twice). |

## Authority (approval-gated)

Finalize/reopen requires an explicit `finalize-accounting` grant covering the system. `review-data` and `statewide-administration` do not satisfy it. The fixture steward holds an explicit grant; commissioner/deputy approval examples are test-specific assignments. Revocation, delegation windows and current scope remain enforced. Accountable roles and production assignments require program-owner ratification. `FINALIZE_AUTHORITY_RULE` is recorded on every finalized record.

## Running the tests

```bash
cd services/api
node --test --experimental-strip-types src/workflows/accounting-snapshots/test/*.test.ts
```

(The package glob `src/**/*.test.ts` picks these suites up.)
