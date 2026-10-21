# visits (WD-012, FR-026 / FR-046 / FR-049)

Field visit recording, maintenance and inspection history, and categorized
public/internal attachments for the Utah Water Measurement Data Dashboard:
assigned engineers record visits with structured last-checked/last-rated
dates and categorized attachments; the visibility wall keeps internal
photos, wiring notes and gate codes out of every public payload (the
authoritative wall lives server-side, in
`services/api/src/workflows/visits`).

## Files

| File | Role |
| --- | --- |
| `visitModel.ts` | Pure, dependency-free models: form values, attachment drafts (wiring notes lock to internal with an explicit confirm), client-side validation mirroring the server's 422 verdicts, the unsent/retry state machine (mirror of the server's `unsent.ts`), history projection per acting persona, structured-date summary and the not-inspected-since query. No React, no clock reads. |
| `visitModel.test.ts` | `node:test` suite: validation matrix, submit-body composition, unsent preservation + retry parity against the REAL server module (runtime import), visibility-filtered history projection incl. a wiring-note canary sweep, structured-date derivation. |
| `VisitForm.tsx` | Mobile-first visit recording form (360px, single column): type, actions, notes, structured dates, attachment rows with category + visibility picker (internal default for wiring notes, locked, with an explicit confirm checkbox), and first-class unsent/retry states (FR-026). Submit path is an injected port; the demo port fails/succeeds deterministically. |
| `VisitHistoryPanel.tsx` | Per-site append-only history table: actor, type, actions, visibility-filtered attachments (engineer view vs public projection), structured inspection dates; loading / empty / error-with-retry / denied states; keyboard-navigable table; internal rows always carry a text marker, never color alone. |
| `index.ts` | Public exports plus the `visitsMount` and `visitEntryMount` descriptors. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/visits/visitModel.test.ts
```

The suite is also picked up by the package-wide
`pnpm --filter @utah-water/web test` glob (`src/features/**/*.test.ts`).

## Mirror contract

`visitModel.ts` mirrors `services/api/src/workflows/visits/{visits,unsent}.ts`:
the unsent state machine and the validation verdicts produce the same
outcomes on the same inputs. `visitModel.test.ts` loads the REAL server
modules at runtime (the established dynamic-import pattern from
features/operations and features/data-entry, outside the web tsc program)
and asserts identical results — a divergence found there is a defect in this
mirror, not in the tests. The browser preview never authorizes anything: the
server re-validates and owns every policy decision, including the FR-049
wall (public APIs, thumbnails, exports and report generation can never
retrieve an internal photo, note, gate code or wiring detail).

## Pending shell wiring (one line, next slice)

WD-012 must not edit `apps/web/src/shell/App.tsx`. Once the station-detail
tab surface and the operations workspace accept features:

```tsx
import { visitsMount, visitEntryMount } from '../../features/visits';
// register(visitsMount)       — id 'visits',       mountPath 'site-detail/visits'
// register(visitEntryMount)   — id 'visit-entry',  mountPath 'operations/visit-entry'
```

The history panel's `canSeeInternal` prop is the policy engine's verdict for
the acting persona on that site (engineer/steward in scope) — the shell
computes it; the panel never guesses from a role label.

## Offline behavior is R2

Reload-safe persistence and background synchronization are the separate R2
task (FR-027 offline field capture): the unsent state machine here is
in-memory, and its output shape is already the R2 IndexedDB envelope
(`unsentEnvelopeOf` in the server module documents it). Explicit retry works
without any background-sync feature; a retry reuses the draft's idempotency
key so an ambiguous failure can never double-append server-side.

## Requirement traceability

- **FR-026** — responsive mobile access and entry: the form works at 360 CSS
  pixels without horizontal scrolling, and submission survives a recoverable
  failure (explicit unsent state, preserved values, retry).
- **FR-046** — visits, maintenance and inspection history: site, author,
  visit time, type, actions and attachments; structured lastChecked/lastRated
  dates; append-only history that survives equipment replacement.
- **FR-049** — categorized public and internal attachments: visibility per
  attachment; wiring notes can never be public (locked + confirmed in the
  UI, rejected server-side); public projections carry no internal rows or
  fields.
