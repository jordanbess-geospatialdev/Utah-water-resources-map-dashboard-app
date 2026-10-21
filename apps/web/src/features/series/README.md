# series (WD-008, FR-005 / FR-006 / FR-007 / FR-063 / FR-066)

Chart, comparison and export UI for site-detail time series:

| File | Role |
| --- | --- |
| `derivation.ts` | Pure, dependency-free fixtures -> chart-model derivation: processing-basis selection (at-or-above ladder mirroring `services/api/src/series/aggregate.ts`), daily coverage summaries with the same rectangle-right interval semantics, marker/legend rules (ice-affected, estimated, out-of-range, negative, null frame, declared gaps), aria-label and coverage-annotation helpers. |
| `derivation.test.ts` | `node:test` suite over the frozen contract fixtures asserting the SAME DST-day goldens as the API suite (mean 23.825, coverage 16/23, volume 3812/121 acre-feet on the 23-hour local day 2026-03-08) plus presentation rules and the below-basis fallback. |
| `SeriesChart.tsx` | Mountable panel reusing the accessible chart lineage (`../../components/Chart`, read-only relative import) with a processing-level selector, daily coverage strip with ZERO-BASED coverage bars and gap hatching, text+shape legend, and the `ObservationTable` alternative carrying the SAME selected values (FR-062). Loading/empty/error states included. |
| `ComparisonPanel.tsx` | Multi-site comparison on aligned local days in common units: per-series color AND shape, line breaks at gaps (no interpolation), per-series source/quality legend, aligned table alternative, typed visible refusal for incompatible units. |
| `ExportPanel.tsx` | Selection summary (stations, half-open window, basis, estimated rows), async job status/progress states (queued/running/succeeded/failed incl. row/time caps), download-link PLACEHOLDER honoring the reauthorization contract, typed denial states. |
| `index.ts` | Public exports plus the `seriesMount` descriptor. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/series/derivation.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob already includes
`src/features/**/*.test.ts`, so this suite also runs with the package test
script.)

## Data source

Default data comes from the WD-006 shell loaders (`../../shell/data/*`,
read-only reuse): fixture observations, the four seed revisions, stream
metadata (cadence, valid ranges), declared gaps and station names. Every
panel accepts overriding props (`data`, `selection`, `denial`, `status`) so
API-backed loaders can replace the fixtures without touching components.

The numerical presentation mirrors the authoritative API domain in
`services/api/src/series/` (golden-tested there); `derivation.test.ts`
re-asserts the same DST-day golden numbers on this surface so the two
cannot drift silently.

## Pending shell wiring (one line; shell is out of WD-008's write scope)

```tsx
import { seriesMount } from '../../features/series';
// register(seriesMount)  —  id 'series', mountPath 'site-detail/series'
```

or rendered directly for the selected stream:

```tsx
import { SeriesPanels } from '../../features/series';
<SeriesPanels streamId={stream.id} />
```

## Requirement traceability

- **FR-005** — site profile series chart with quality status, units and a
  tabular alternative exposing the same selected data.
- **FR-006** — daily aggregation with coverage and gap policy visible
  (coverage %, estimated share, declared gap hours; never zero-filled).
- **FR-007** — site comparisons on aligned intervals in common units;
  unavailable periods stay visible gaps; per-series source/quality legend.
- **FR-062** — accessible visualization: keyboard-selectable chart points
  (inherited from the chart lineage), text+shape legend, table alternative
  with identical values, zero-based coverage bars.
- **FR-063** — export selection summary, async job states, row-cap refusal
  messaging, download placeholder that re-authorizes per download.
- **FR-066** — raw/provisional/reviewed/best-available selector with
  below-basis fallback flagged, raw values always distinguishable.
