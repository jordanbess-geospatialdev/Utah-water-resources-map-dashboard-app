# distribution-report (WD-025, FR-024; FR-029 boundary)

Commissioner-facing annual / multi-site distribution report UI: request panel
with visible assigned-scope enforcement and period-basis date rules, plus the
report view with daily tables, category-separated totals, quality notes,
formulas, provenance and content-hash footer.

| File | Role |
| --- | --- |
| `reportModel.ts` | Pure view models: period-basis date math (calendar year; water year Oct-Sep, USGS; irrigation season Apr 1 - Oct 31 - documented defaults pending owner ratification), acting-scope resolution over the fixture entitlements, the demo report builder (numerics mirror of `services/api/src/workflows/distribution-report/generate.ts`: rectangle-right integration, missing-never-zero coverage, revision ladder, accounting categories, provenance + deterministic demo hash), formatting/legend/banner/hash-footer helpers. |
| `reportModel.test.ts` | `node:test` suite: period windows (CY 365 d; WY Oct 1 - Oct 1; irrigation 214 d), reportable systems per actor (Cody: Bear only; Diego: statewide; deputy/engineer: none), golden mirror to the API constants (daily 2012/121, 4215/121, 3812/121; totals 10299/121 raw, 10512/121 best, canal 267947/484, release 26978/121), determinism of the demo build, view-model formatting. |
| `ReportRequestPanel.tsx` | Request form: system picker restricted to the acting scope (other systems shown disabled with the hidden-object denial reason), optional site subset, basis + year with the date rule and live window preview, processing basis, include flags, generate action with loading/empty/denied states (`role=status`, `aria-live`), and the generated report rendered inline via `ReportView` (or handed to `onGenerate`). |
| `ReportView.tsx` | The generated report: header metadata (extraction time, method, report id), superseded-version banner, per-site daily flow/volume tables (the table alternative is always present) with a size-configurable volume sparkline (FR-024 chart sizing), quality/coverage notes, category-separated totals with the never-summed combined row, formula documentation block, per-stream revision labels, data version, text+shape legend, content-hash footer, printable-layout note. |
| `index.ts` | Public exports plus the `distributionReportMount` descriptor. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/distribution-report/reportModel.test.ts
```

(The package glob `src/features/**/*.test.ts` picks this suite up.)

## Data source and demo generation

Fixtures come from the WD-006 shell loaders (`../../shell/data/fixtures`,
read-only reuse). Until the HTTP service lands, Generate runs the
deterministic LOCAL mirror (`buildFixtureReport`) of the server domain; its
numbers are pinned by test to the same golden constants as the API suite, and
the panel says so in the UI. The server remains authoritative: the real
endpoint re-evaluates the entitlement engine and re-aggregates server-side.

The demo content hash is a deterministic FNV-style digest of the same
canonical preimage, NOT the server's sha256; the footer labels it as the demo
surface.

## Pending shell wiring (one line; shell is out of WD-025's write scope)

```tsx
import { distributionReportMount } from '../../features/distribution-report';
// register(distributionReportMount)  —  id 'distribution-report', mountPath 'operations/distribution-reports'
```

or rendered directly:

```tsx
import { ReportRequestPanel } from '../../features/distribution-report';
<ReportRequestPanel actorId={session.principalId} />
```

## R2 notes (documented, not implemented)

- **Immutable finalization (FR-029)**: regeneration supersedes (the banner
  explains version + supersedes), never rewrites; there is no finalize
  action here. The API ships a throwing stub
  (`services/api/src/workflows/distribution-report/finalize.ts`).
- **Flexible periods**: only the three governed period bases exist; ad-hoc
  date ranges are a later enhancement.
- **PDF transport**: the view is print-friendly and every displayed value
  reconciles to the selected dataset by construction, but rendering/serving a
  PDF is a later transport task on the export pipeline (POST /exports with
  download reauthorization), not this feature.

## Requirement traceability

- **FR-024** — selected authorized system and period; daily flow/volume;
  quality and coverage notes; configurable chart sizing; generation time
  (extraction time) and data version; deterministic regeneration.
- **FR-062** — text+shape note legend; always-present table alternative.
- **FR-029** — supersession banner documents the boundary; finalization is
  out of scope by design.
