# help (WD-020, FR-008 / FR-017 / FR-018 / FR-068)

Role-aware help, feedback capture with a transparency preview, the skippable
first-visit onboarding tour, and the browser analytics-consent persistence
model for the Utah Water Measurement Data Dashboard.

## Files

| File | Role |
| --- | --- |
| `HelpPanel.tsx` | Mountable Help panel: role-aware task guides for the six fixture personas (pointing at the docs/training checklists), a restart-tour affordance, and the FR-018 feedback form. The SUPPORT-CONTEXT PREVIEW shows the user exactly what ships BEFORE submit: the versioned share query built by the REAL WD-007 codec (`../discovery/shareUrl` - filters/extent/selected public site only), the app version, the timestamp and every omission notice. Validation mirrors `services/api/src/support/feedback.ts` (caps, closed categories, no free-form URLs, no secret-shaped text, attachment-id screenshot references). Without an injected submit handler, reports queue in memory with an honest notice (endpoint wiring is a later task). |
| `OnboardingTour.tsx` | The FR-068 tour: 5-7 role-relevant steps per persona, first-visit only (`shouldAutoStart`), skippable (Skip button + Escape), with the disable-auto-return choice persisted per persona (versioned schema, corrupt records reset). Keyboard navigable (ArrowRight/ArrowLeft/Escape), role=dialog with aria-modal, focus moved into the dialog on open and returned to the anchor on close. |
| `consent.ts` | Browser mirror of the analytics consent record (`services/api/src/support/analytics.ts`): opt-in, per-account, persisted in localStorage (in-memory fallback), versioned against the privacy proposal it answered; stale or corrupt records read as UNANSWERED (re-ask, never guess). |
| `consent.test.ts` | `node:test` suite: opt-in default, per-account persistence, policy-version staleness re-ask, corrupt reset, logout clear, storage round trip. |
| `index.ts` | Public exports plus the `helpMount` (tab) and `onboardingTourMount` (overlay) descriptors. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/help/consent.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob picks these up via
`src/features/**/*.test.ts`.)

## Data sources

- Personas: `apps/web/src/shell/data/personas.ts` (Donna, Wiley, Sarah,
  Cody, Fatima, Diego - the six fixture personas).
- Share links: the REAL WD-007 codec in `../discovery/shareUrl.ts` (the
  server-side mirror lives in `services/api/src/support/supportContext.ts`;
  byte-format equivalence is pinned there by test).
- Feedback/consent rules mirror `services/api/src/support/feedback.ts` and
  `analytics.ts`, which remain the domain authority and re-validate
  everything server-side.

## Pending shell wiring (persona_ui's next slice)

WD-020 may not edit `apps/web/src/shell/App.tsx`. The pending blocks:

```tsx
import { HelpPanel, helpMount, OnboardingTour, onboardingTourMount, shouldAutoStart } from '../../features/help';

// register(helpMount)  —  id 'help', mountPath 'help'
// register(onboardingTourMount)  —  kind 'overlay'

<HelpPanel
  personaId={viewer.personaId}
  principalId={viewer.principalId}
  viewState={currentShareState}
  status={panelStatus}
  onRetry={retry}
  onRestartTour={() => setTourOpen(true)}
/>
<OnboardingTour
  personaId={viewer.personaId}
  open={tourOpen}
  onEnd={() => setTourOpen(false)}
/>
// tourOpen initializes from shouldAutoStart(tourStorage, viewer.personaId)
```

The feedback endpoint (`POST /support/feedback`, steward queue routes) and
the consent endpoints are later integration tasks; until then the panel
accepts an injected `onSubmitFeedback` or queues locally.
