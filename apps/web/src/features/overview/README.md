# overview (WD-018, FR-058/059/060/061/062)

The public and policy summary surface for the Utah Water Measurement Data
Dashboard: the intelligible statewide lead, self-describing indicator cards
(telemetry coverage, reviewed-data coverage, measured-vs-estimated with a
distinct unknown bucket), the FR-060 data-dictionary entry point, and the
selected-system drill-down with space/time totals and accessible charts.

## Files

| File | Role |
| --- | --- |
| `derivation.ts` | Pure fixtures -> view model, mirroring `services/api/src/summaries/{indicators,totals}.ts` (which reuse the WD-008 aggregation semantics). Indicator derivation: status rules (only active stations join a denominator), duplicate normalization to the latest retransmission, basis-effective classification with the distinct unknown bucket. Totals: daily buckets via the WD-008 rectangle-right interval integration with cadence look-back and DST-correct local windows, governed accounting categories, no-double-count policy, missing-never-zero daily values. Also the chart view models (shapes, colors, aria labels) and the derived plain-language lead. |
| `derivation.test.ts` | `node:test` suite (13 tests): the fixture goldens (telemetry 2/4, reviewed 1/68, measured 66/68 + 1/68 estimated + 1/68 unknown; natural-channel raw volume = the WD-008 weekly golden 10 039/121 acre-feet), unknown-bucket behavior, half-open period boundaries, zero-denominator nulls, chart/table parity, determinism twice - and CROSS-SURFACE equality: the services domain is imported through computed specifiers and the view model is asserted field-for-field identical (indicators and full area totals, raw and best-available, public and all visibility). |
| `PublicOverview.tsx` | The FR-058 overview: statewide lead first (derived from the indicators, never hand-written), indicator cards showing numerator/denominator/period/asOf/exclusions VISIBLY (not tooltips) with output-measure vs outcome-context chips, the data-dictionary link, keyboard-operable system drill-down, processing-basis selector, per-category totals table with stream exclusions, and loading/empty/error/stale states. |
| `SummaryCharts.tsx` | FR-061/FR-062 charts: zero-based bar chart of the source classification and zero-based daily-volume line chart per accounting category, limited color-blind-aware palette WITH shape+text cues (● ≈ ? / ● ■ ▲, ∅ for no data), keyboard-focusable values carrying full context in aria-labels, and an accessible data table with the SAME selected values beside every chart. |
| `index.ts` | Public exports plus the `overviewMount` descriptor. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/overview/derivation.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob picks up
`src/features/**/*.test.ts`, so this suite is included there too. The
cross-surface test imports `services/api/src/summaries` read-only through
computed specifiers, per the `apps/web/tests/adapters.test.ts` import
pattern.)

## Data source

Fixture world only, read-only reuse of the WD-006 shell loaders
(`../../shell/data/fixtures`): stations, observations, revisions and systems,
with `FIXTURE_CLOCK` as the deterministic asOf. No clock reads, no network.

## Pending shell wiring (one block; the shell is out of WD-018's write scope)

```tsx
import { overviewMount, PublicOverview } from './features/overview';
import { DataDictionaryPanel } from './features/discovery';

// register(overviewMount)  —  id 'overview', mountPath 'overview'
// or render directly as the anonymous landing view:
//   <PublicOverview
//     selectedSystemId={selectedSystemId}
//     onSelectSystem={setSelectedSystemId}
//     onOpenDataDictionary={() => showPanel(<DataDictionaryPanel />)}  // FR-060 lineage
//     status={summaryStatus}  // 'loading' | 'ready' | 'stale' | 'error'
//   />
```

## Requirement traceability

- **FR-058** — public overview leading with an intelligible statewide
  summary; telemetry and reviewed indicators state numerator, denominator,
  period and update time; output measures distinguished from outcomes.
- **FR-059** — measured/estimated/unknown classifications with denominator
  and period, reconciled to the selected source records (never an old audit
  percentage); unknown never folds into measured or estimated.
- **FR-060** — data-dictionary entry point linking the indicator vocabulary
  (units, processing levels, qualifiers) to the maintained dictionary panel.
- **FR-061** — dynamic space/time summaries for the selected area, period
  and processing basis, reconciled to the WD-008 daily values with the
  no-double-count accounting-category policy; incompatible dimensions never
  mixed.
- **FR-062** — zero-based bar axes, clear units and dates, limited
  color-blind-aware palette plus text+shape cues, keyboard-accessible
  values, and a readable table with the same selected values beside every
  chart.
