# r2-extensions (WD-023-R2, FR-044 / FR-047)

R2 extension surfaces for the Utah Water Measurement Data Dashboard:

- **AsOfPanel** — the FR-044 historical as-of reconstruction view: pick a
  stream, an acting persona and an as-of instant (UTC); the T-view series
  assembles with gaps where nothing had been received at T, the basis block
  stays visible (as-of instant, basis revision, excluded-later count, and
  the same label the export embeds), and the authorization states render —
  including the hidden-object 404 a cross-scope actor gets on a restricted
  stream. Try 2026-03-08 15:30 UTC (the exact recorded instant of the
  Corinne correction) and 15:29:59 to see the raw spike that was known
  before it.
- **VoiceDraftPanel** — the FR-047 stub voice-note flow: record (stub),
  request transcription (deterministic provider stub attaching an empty,
  clearly labeled provider-pending draft), review the editable transcript
  (review checkbox + recorded reviewer actor), and SAVE — the only path to
  an attachment, locked with its blockers until review completes. The saved
  descriptor is internal-class with retention and provenance, and carries no
  measurement or inspection field.

The WCAT adapter seam (FR-051) intentionally has no panel: it is an
integration contract (services/integrations/r2/wcat) with fixture tests and
a documented manual fallback, pending the external WCAT contract owners.

## Files

| File | Role |
| --- | --- |
| `extensionsModel.ts` | Pure, dependency-free view models (no React, no fixtures, no clock, no network): the demo as-of assembly mirroring the server's recorded-time semantics, basis labels/notes, table rows (text + shape markers, never color alone), the demo authorization mirror, the voice badge lifecycle, review-wall blockers and the provider-pending label, plus the fixture-derived DEMO_* constants that mirror the reviewed outcomes in `services/integrations/r2/`. |
| `extensionsModel.test.ts` | `node:test` suite: boundary ON T / one millisecond before, gaps + counts, determinism, 422 validation mirror, restricted-hidden-cross-scope authorization mirror, basis label format, row markers, voice badges, review-wall blockers, provider-pending label. |
| `AsOfPanel.tsx` | FR-044 panel (stream/persona/as-of picker, basis block, T-view table with gaps, denied/error/idle states; accessible form controls and an `aria-live` status). |
| `VoiceDraftPanel.tsx` | FR-047 stub flow panel (record → provider-pending draft → review editor → SAVE-only attachment). |
| `index.ts` | Public exports plus the two mount descriptors. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/r2-extensions/extensionsModel.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob picks the suite up
via `src/features/**/*.test.ts`.)

## Server counterparts

All behavior lives in `services/integrations/r2/` (pure TypeScript,
`node:test`): `asof/` (FR-044 recorded-time reconstruction with the policy
engine deciding authorization as of T), `voice/` (FR-047 draft model +
review wall + deterministic provider stub) and `wcat/` (FR-051 adapter seam
+ fixture fake). The panels render what those modules decide; they decide
nothing themselves.

## Pending shell wiring (added by the wiring slice, not WD-023-R2)

WD-023-R2 does not touch `apps/web/src/shell/App.tsx`. When the orchestrator
authorizes wiring, the lines are:

```ts
import { asOfPanelMount, voiceDraftPanelMount, AsOfPanel, VoiceDraftPanel } from '../features/r2-extensions';
// registry entries (the established mount descriptor shape):
//   asOfPanelMount    -> 'r2/as-of'        (label: As-of reconstruction)
//   voiceDraftPanelMount -> 'r2/voice-drafts' (label: Voice note drafts)
```

No network code exists in this feature (statically scanned from
`services/integrations/r2/voice/test/voice.test.ts`).
