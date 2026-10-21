# R2 Release Notes — Utah Water Measurement Data Dashboard

Release: R2 (fixture-proven) | Prepared 2026-10-21 | R2 gate: PASSED; production deployment NOT authorized

## Included (FR coverage added on top of the MVP)

- **Offline field capture (FR-027, FR-048):** outbox drafts surviving reload,
  exactly-once synchronization under double-send and commit-before-ack crash,
  conflicts preserved for explicit resolution, sync-time grant revalidation,
  account-scoped sign-out cleanup; asset transfers with dated associations
  that never move historical inspections.
- **Rating governance (FR-045):** versioned effective-dated curves and shifts
  with approval gating, millisecond boundary goldens, lineage that survives
  supersession, and triple immutability proofs.
- **Supplier reporting (FR-053..057):** organization-isolated drafts and
  submissions with frozen content hashes, boundary proposals with distinct
  approval, field-level validation with accessible summaries.
- **Decision evidence and finalization (FR-028..030):** snapshots pinning
  exact revision/curve evidence, immutable finalized accounting with
  concurrency and linked supersession (dual-hash proof), flexible mid-month
  periods reconciling to the aggregation goldens.
- **Recurring quality trends (FR-043):** deduplicated incidents with balanced
  reconciliation arithmetic; restricted sites byte-swept from public trends.
- **Extensions (FR-044, FR-047, FR-051):** recorded-time as-of reconstruction
  (existence-oracle defect found by the gate, fixed, tripwire-pinned);
  voice-note drafts as review-required over a deterministic stub (no network
  anywhere); WCAT adapter seam with provenance-enforced exchanges.

## Qualification verdict

R2 gate PASSED on fixture evidence (tests/qualification-r2, deterministic,
exit 0); defects R2-1/R2-2 found by the gate were fixed and are pinned by
tripwires asserting the fixed state. Full regression: six packages green
(api 651, web 304, policy 30, geo-gateway 87, contracts 1212 assertions,
database gate) plus the MVP reproducer.

## Known limitations (unchanged from MVP unless noted)

Fixture-only evidence; simulated channels; BLOCKED environment gates (live
database, device browsers for offline, staging load, provider/privacy for
voice, real WCAT contract). New owner-ratification items added by R2:
finalize/reopen authority mapping, supplier validation ranges, rating-curve
coefficients, curve-boundary tolerance.

## Production authorization

Same rule as the MVP: the named-owner sign-off register
(docs/uat/SIGN-OFF.md) plus the R2-specific ratifications above and the
BLOCKED items executed in staging. Nothing in this repository state
authorizes deployment.

Agent: orchestrator
