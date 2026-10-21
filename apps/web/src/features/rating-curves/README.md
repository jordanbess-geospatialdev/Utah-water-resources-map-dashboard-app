# rating-curves (WD-011-R2, FR-045)

Versioned, effective-dated rating-curve and shift management UI for the
Utah Water Measurement Data Dashboard: the full version timeline (curves
and shifts) with half-open effective periods, approval states, authors and
calibration provenance — superseded versions stay listed, history never
collapses — plus a conversion tester that resolves the version effective at
an instant and displays the value with its complete lineage (curve version
id + shift version id).

## Files

| File | Role |
| --- | --- |
| `curveModel.ts` | Pure, dependency-free view models: period labels (`[from, to)` half-open), timeline ordering, state badges (text + shape), lineage strings, and the local conversion evaluator mirroring the API workflow. No React, no fixtures, no clock. |
| `curveModel.test.ts` | `node:test` suite: boundary instants at the seeded 2019/2026 join, hand-derived conversion goldens, shift layering with both lineage ids, every documented rejection mode, timeline retention of superseded versions. |
| `RatingCurvePanel.tsx` | Mountable read-only React panel: version list, conversion tester, loading / error+retry / empty states. Real table with caption and scope headers; approval state is always text + shape; the conversion result is an aria-live region. |
| `index.ts` | Public exports plus the `ratingCurvesMount` descriptor. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/rating-curves/curveModel.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob also picks the
file up via `src/features/**/*.test.ts`.)

## Data source

By default the panel derives its data from the frozen contract fixtures
(read-only reuse of the WD-006 shell loaders): the `ratingCurvePeriods` of
the selected discharge stream (`str-corinne-q`), presented as published
versions with the documented working coefficients — the fixture publishes
period ids, dates and method labels only, so the numbers mirror the API
seed (`SEED_CURVE_COEFFICIENTS` in
`services/api/src/workflows/rating-curves/store.ts`) and are **pending
data-owner approval** per the R2 convention. Every prop can override the
data (`data`), the status (`status` / `errorMessage` / `onRetry`) and the
tester defaults (`defaultStageFt` / `defaultAt`), so an API-backed loader
can replace the fixtures without touching this component.

## Pending shell wiring

WD-011-R2 may not edit `apps/web/src/shell/App.tsx`. The single pending
line, once the station-detail tab surface accepts features:

```tsx
import { ratingCurvesMount } from '../../features/rating-curves';
// register(ratingCurvesMount)  —  id 'rating-curves', mountPath 'site-detail/rating-curves'
```

or, rendered directly inside the station detail panel for the selected
discharge stream:

```tsx
<RatingCurvePanel streamId={stream.id} />
```

## Requirement traceability

- **FR-045** — effective-dated curve and shift versions retain author,
  approval state and provenance; computed values identify the version
  used; a revised curve does not erase earlier conversions or inspection
  evidence.
- Technical specification, measurement model row "Rating curve and shift":
  versioned coefficients/method/unit, valid interval, approval and
  derived-output lineage.
- Technical specification, "Originals and corrections": raw readings are
  immutable; curve edits append versions and never rewrite history (the
  API-side immutability suite proves it by content hash).
