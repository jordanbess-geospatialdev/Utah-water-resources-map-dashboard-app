# recurring-quality (WD-013-R2, FR-043 + FR-045)

Recurring correction-trend UI for the Utah Water Measurement Data Dashboard:
chart markers and a sortable table of repeated flags, corrections, known
issues and curve supersessions by site and period, with the deduplicated
incident counts reconciling visibly to the underlying revision / QC /
known-issue / rating-version records (each row shows both numbers), and
approved rating-curve version boundaries annotated against adjacent
diagnostic history.

## Files

| File | Role |
| --- | --- |
| `trendsModel.ts` | Pure, dependency-free view models: (site, kind, period) row building with incident + record counts, deterministic sorting/filtering, chart series with shape markers + text labels, duration/rate formatters, and the reviewed demo snapshot (18 incidents / 27 records of the contract fixtures, including the obs-q-032 two-corrections chain as ONE incident). No React, no fixtures, no clock reads. |
| `trendsModel.test.ts` | `node:test` suite: row reconciliation to the reviewed snapshot, boundary-annotation surfacing, accessible labels (marker + text), every sort column and direction, filters, chart/table parity, windowing, determinism twice. |
| `RecurringQualityPanel.tsx` | Mountable read-only React panel: grouped bar chart (kind markers + counts as text, never color alone) and the sortable table of the same rows; kind/period filters with an aria-live result count; loading / empty / error / denied states. |
| `index.ts` | Public exports plus the `recurringQualityMount` descriptor. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/recurring-quality/trendsModel.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob picks up
`tests/*.test.ts`; this feature-local suite is run with the command above,
like the sibling quality features.)

## Data source

By default the panel renders `REVIEWED_DEMO_INCIDENTS`: a reviewed snapshot
(reviewed-pending-owner-approval) of the API derivation in
`services/api/src/quality-trends` over the frozen contract fixtures - the 20
reviewed QC hits, the four fixture revisions, two known issues and the
rc-corinne-2019 supersession, with boundary annotations from the WD-011-R2
chains (default 12 h adjacency). Every prop can override the data
(`data.incidents`, `data.now`, `data.siteNames`), the status
(`status`/`errorMessage`/`onRetry`, incl. `denied` for callers the server-side
visibility projection refuses) and the viewer label, so the API-backed loader
replaces the snapshot without touching this component.

## Pending shell wiring (persona_ui's next slice)

WD-013-R2 may not edit `apps/web/src/shell/App.tsx`. The single pending line,
once the quality tab surface accepts features:

```tsx
import { recurringQualityMount } from '../../features/recurring-quality';
// register(recurringQualityMount)  —  id 'recurring-quality', mountPath 'quality/recurring'
```

or, rendered directly inside the quality surface:

```tsx
<RecurringQualityPanel viewerLabel="Fatima (engineer, Bear River)" />
```

## Requirement traceability

- **FR-043** — chart markers and a sortable table of repeated flags or
  corrections by site and period; counts reconcile to the selected issue and
  revision records without counting one incident repeatedly (the
  two-corrections chain on obs-q-032 is one incident with two records).
- **FR-045** — approved rating/shift version periods relate to diagnostic
  history: rows adjacent to a curve effective-boundary instant carry that
  boundary with its lineage (rc-corinne-2019 → rc-corinne-2026).
- **FR-034 rule** — every kind marker is a shape plus a text label, never
  color alone; the same data backs both the chart and the table.
- Restricted and internal sites only ever appear through the server-side
  visibility projection (`services/api/src/quality-trends/visibility.ts`);
  the panel renders what it is given.
