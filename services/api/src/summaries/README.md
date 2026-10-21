# summaries (WD-018, FR-058/059/060/061/062)

Public and policy summary domain for the Utah Water Measurement Data
Dashboard: self-describing statewide/per-system indicators and space/time
totals that reconcile exactly to the WD-008 aggregation semantics. Pure
TypeScript over the frozen contract fixtures (seed `utah-water-fixture-v1`,
fixed clock `2026-03-09T07:00:00Z` from seed-manifest) - no clock reads, no
randomness; the web presentation surface in
`apps/web/src/features/overview` mirrors these rules and is pinned to the
same numbers by its test suite.

## Files

| File | Role |
| --- | --- |
| `world.ts` | Fixture-backed policy world: stations with status/telemetry/site-type/water-source fields the series store does not expose, systems, observation/revision/gap rows (WD-008 series types), the fixed `asOf` clock, the status rule (only ACTIVE stations join a denominator; inactive/proposed/unknown-status are excluded with ids) and the scoped observation window. |
| `indicators.ts` | FR-058/FR-059 indicators. Every indicator carries `{label, numerator, denominator, unit, period (half-open, described), asOf, exclusions[]}` plus `fraction` (null on a zero denominator, never 0/0), `measureKind` (output vs outcome context) and a versioned method string. Telemetry coverage = active stations that are telemetered AND reported inside the freshness window (default 24 h). Reviewed-data coverage = normalized readings whose revision chain reached the governed `reviewed` level (a best-available correction alone does not count). Measured-vs-estimated classifies normalized readings at a stated basis from the observation flags; null frames and ungoverned value types form a DISTINCT `unknown` bucket, never folded into measured or estimated. Duplicate timestamps normalize to the latest-received retransmission (per stream and instant) and the superseded rows are listed as exclusions. |
| `totals.ts` | FR-061 space/time totals for a selected area/period/basis/visibility, computed by SUMMING the WD-008 daily buckets of `../series/aggregate.ts` (rectangle-right interval integration, missing-never-zero coverage, DST-correct local windows) - reconciliation is exact by construction. No-double-count policy: streams join exactly one accounting category derived from governed fields (`surface-storage-release` -> reservoir-release; site `natural-channel` -> natural-channel-flow; site `flume`/`weir` -> canal-delivery); totals are per category and `combinedVolumeAcreFeet` is always null; non-discharge dimensions (stage ft, voltage V) and non-public streams are excluded with stated reasons. |
| `test/indicators.test.ts` | Golden indicator values hand-derived from the fixture world (telemetry 2/4 with the inactive+proposed exclusions; reviewed 1/68; measured 66/68, estimated 1/68, unknown 1/68), the distinct-unknown-bucket behavior (incl. synthetic unclassifiable rows), half-open period boundaries, per-system zero-denominator nulls, self-describing shape and determinism twice. |
| `test/totals.test.ts` | Exact reconciliation of every category total to the underlying WD-008 daily sums (same order, `===`), golden volumes (natural-channel raw = the WD-008 weekly golden 10 039/121 acre-feet; canal-delivery manual-cadence integration; reservoir-release on all-visibility), the no-double-count guarantees (adjacent same-named Hyrum stations in different categories, combined total null, disjoint category stream sets), stream exclusion reasons, missing-day nulls, per-system/empty areas, WD-008 window denials and determinism twice. |

## Running the tests

```bash
cd services/api
node --test --experimental-strip-types src/summaries/test/indicators.test.ts src/summaries/test/totals.test.ts
```

(The package glob `src/**/*.test.ts` picks both suites up.)

## Golden status

Like the WD-008 goldens, the expected numbers here are hand-derived from the
published fixtures and are pending measurement-owner approval; each test file
documents its derivation for that review.

## Policy notes for reviewers

- Indicator denominators follow the status rule: 6 fixture stations, 4 active.
  Restricted and internal stations count as operating stations in the
  network-health indicators (aggregate counts only, no restricted data
  exposure); the restricted stream is excluded from PUBLIC flow totals.
- `fraction` is null whenever the denominator is zero (the Weber system has
  only a proposed station): unavailable, never a fabricated 0/0.
- Totals cover the enclosing local calendar windows of the request and
  volumes are sums over COVERED intervals only; the coverage fraction beside
  every total shows the holes. Missing is never zero.
