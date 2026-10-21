# distribution-report (WD-025, FR-024; FR-029 boundary)

Annual and multi-site distribution report generation for the Utah Water
Measurement Data Dashboard, built DIRECTLY on the WD-008 aggregation domain:
every daily flow/volume number comes from `aggregateSeries`
(`../../series/aggregate.ts`, method `rectangle-right@1`), never from a
reimplementation. Commissioner-scoped, provenance-labeled and deterministic.

## Files

| File | Role |
| --- | --- |
| `types.ts` | Domain types: `ReportRequest` (system, optional site subset, period with the explicit `PeriodBasis` enum and its documented date rules, processing basis, include flags), `GeneratedReport` (sections, extraction timestamp, per-stream revision labels, method + data versions, formula documentation block, sha256 content hash). |
| `world.ts` | Fixture report world: distribution systems from `fixtures/contracts/systems.json` plus a policy world where every system is an authorizable `{kind: 'system'}` object (visibility restricted -> hidden-object denial mapping). |
| `scope.ts` | The report grant gate: action `generate-reports` on the system object through the shared entitlement engine; deputy delegation windows, revocation and expiry evaluated against the injected clock. Denial mapping identical to `series/grantCheck.ts` (401 identity, 404 unknown/hidden object, 403 otherwise). |
| `generate.ts` | `generateReport` (pure; clock injected) builds per-site daily flow/volume tables, quality and coverage notes, category-separated system totals (WD-018 governed accounting categories, `combinedVolumeAcreFeet` always null), the formula documentation block and per-stream revision labels from the WD-011 store. `periodWindow` derives the reporting window from the same `seasonWindow` date rules as WD-008 seasonal aggregation. `ReportRegistry` models regeneration as SUPERSESSION (new version + supersedes marker; prior report objects never mutated). |
| `finalize.ts` | R2 BOUNDARY: `finalizeReport` throws `not implemented - R2 scope (FR-029)`. Finalization/immutability is a separate task; see below. |
| `test/determinism.test.ts` | Byte-identical repeated generation (deep equality + identical canonical serialization + identical hash), extraction time = injected clock, hash sensitivity (basis, year, processing basis, include flags, clock), data-version sensitivity to a WD-011 revision append, registry supersession semantics, finalize stub throws. |
| `test/scope.test.ts` | Cody (Bear) allowed; Cody -> Weber 404 hidden object (DENY_OUT_OF_SCOPE); unknown system 404; anonymous 401; engineer/researcher 403 (DENY_CAPABILITY_NOT_GRANTED); deputy with delegated generate-reports allowed inside the window and 403 DENY_DELEGATION_EXPIRED outside it; statewide steward both systems; out-of-system site subset 422. |
| `test/golden.test.ts` | One hand-documented golden report (Bear River, calendar year 2026, raw + best-available): the report's daily rows equal the WD-008 daily goldens; every total equals the sum of its daily rows AND the independent `aggregateSeries` recomputation AND the hand constants (natural-channel raw 10299/121 = the WD-008 March golden; canal-delivery 267947/484 with the weekly-cadence cap; reservoir-release 26978/121); no-double-count category separation; provenance labels; formula block. PENDING measurement-owner approval like all goldens. |

## Running the tests

```bash
cd services/api
node --test --experimental-strip-types "src/workflows/distribution-report/test/*.test.ts"
```

(The package glob `src/**/*.test.ts` picks these suites up.)

## Design contracts

- SAME NUMERICS AS THE CHART APIS: reconciliation to the series surface is
  exact by construction; the golden suite pins it to the WD-008 golden
  constants.
- SAME GATES: one system-level gate (`generate-reports`) plus the per-stream
  WD-008 read gate for every included stream - fail closed on first denial.
  The fixture commissioner's `generate-reports` grant also satisfies
  `view-restricted-details`, so his report legitimately includes the
  restricted owner stream via a protected (`full`) projection.
- PERIOD BASES (documented defaults pending measurement-owner ratification,
  mirrored from `series/zone.ts` `seasonWindow`): calendar-year Jan 1 -> Jan 1
  local; water-year Oct 1 (year-1) -> Oct 1 (USGS water year ends Sep 30);
  irrigation-season Apr 1 -> Nov 1. All windows are half-open local windows
  in America/Denver; a reporting day is never redefined by browser time.
- NO DOUBLE COUNT: totals per governed accounting category, never summed
  across categories (upstream/downstream/canal can measure the same water).
- DETERMINISM: no clock reads (extraction time is injected), no randomness,
  fixed iteration orders, canonical key-sorted serialization for the sha256
  content hash. Identical inputs + clock -> byte-identical report and hash.
- PROVENANCE: extraction timestamp, aggregation method version, fixture seed,
  per-stream revision labels (which WD-011 chain produced best-available, and
  whether the selected basis used it), and a data version = sha256 over the
  canonical serialization of the underlying revision chains - any appended
  revision changes it even when values do not.

## R2 boundaries (documented, NOT implemented)

- FINALIZATION / IMMUTABILITY (FR-029): `finalizeReport` deliberately throws.
  Generated reports are regenerable; supersession (`supersedes` on the new
  version, `supersededBy` on the prior registry wrapper) is the only
  versioning mechanism and never rewrites a prior report.
- FLEXIBLE/CUSTOM PERIODS: only the three governed period bases exist; ad-hoc
  date ranges are a later enhancement.
- PDF TRANSPORT: FR-024's "exported PDF values reconcile to the selected
  dataset" is honored on the DATA side (the report object carries exactly the
  selected dataset's numbers); rendering/serving a PDF is a later transport
  task on the export pipeline (POST /exports), as documented in the web
  feature README.

## Requirement traceability

- **FR-024** — annual/multi-site distribution reports: daily flow/volume,
  quality and coverage notes, generation time (extraction timestamp), data
  version (revision labels + data-version hash), documented formulas and
  period-basis date rules; deterministic regeneration.
- **FR-029** — explicitly out of scope (R2); the throwing stub documents the
  boundary.
- **FR-010/FR-011** — actor identity is a server-resolved principal id;
  deputy authority exists only through the explicit, time-bounded delegation.
