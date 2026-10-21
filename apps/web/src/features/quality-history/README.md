# quality-history (WD-011, FR-042)

Point and interval audit UI for the Utah Water Measurement Data Dashboard:
selecting a quality-flagged observation (or a declared flagged interval)
renders the full revision chain read-only — revision version, recorded time
(labelled separately from observation time), actor, original → replacement
value, governed qualifiers, reason, and the superseded marker; withdrawn
tombstones present the retained original evidence (FR-039).

## Files

| File | Role |
| --- | --- |
| `derivation.ts` | Pure, dependency-free derivation of the table model from an observation (or interval) plus the append-only revision chain. No fixtures, no clock, no React. |
| `derivation.test.ts` | `node:test` suite: the two-corrections fixture chain (obs-q-032 / rev-corinne-2001 → rev-corinne-2004) end to end, supersession markers, raw-only empty state, synthetic tombstone presentation, half-open interval bounds, flagged-point targets. |
| `QualityHistoryPanel.tsx` | Mountable read-only React panel (loading / empty raw-only / error-with-retry states). Keyboard navigable table; status is always text + shape (● current, ○ superseded, ✕ withdrawn), never color alone. |
| `index.ts` | Public exports plus the `qualityHistoryMount` descriptor. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/quality-history/derivation.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob only picks up
`tests/*.test.ts`; this feature-local suite is run with the command above.)

## Data source

By default the panel derives its data from the frozen contract fixtures via
the WD-006 shell loaders (`../../shell/data/fixtures`, read-only reuse):
observations, the four seed revisions, qualifier names, actor display names,
stream valid ranges and the declared gap intervals. Every prop can override
the data (`data`), the status (`status`/`errorMessage`/`onRetry`) and the
initial selection (`defaultTarget`), so an API-backed loader can replace the
fixtures without touching this component.

## Pending shell wiring (persona_ui's next slice)

WD-011 may not edit `apps/web/src/shell/App.tsx`. The single pending line,
once the station-detail tab surface accepts features:

```tsx
import { qualityHistoryMount } from '../../features/quality-history';
// register(qualityHistoryMount)  —  id 'quality-history', mountPath 'site-detail/quality'
```

or, rendered directly inside the station detail panel for the selected
discharge stream:

```tsx
<QualityHistoryPanel streamId={stream.id} />
```

## Requirement traceability

- **FR-042** — point/interval audit history: every revision with actor,
  recorded time, original and replacement value, qualifiers and reason,
  including revisions later superseded.
- **FR-039** — withdrawal tombstones render the retained original value and
  provenance; the raw row is presented as immutable.
- **FR-041** — governed qualifiers and justification text appear in the
  table.
- Observation time vs revision time separation per the technical
  specification, "Originals and corrections".
