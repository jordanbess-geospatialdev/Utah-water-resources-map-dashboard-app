# notifications (WD-015, FR-025 / FR-052)

Scoped alert subscriptions and digest schedules for the Utah Water
Measurement Data Dashboard: the four FR-025 event kinds (new sites, site
edits, no signal, threshold violations) over a system or stream scope, at
hourly / twice-daily (06:00 & 18:00) / daily (07:00) / weekly (Monday 07:00)
cadences - all boundaries in the agency timezone **America/Denver**, DST-
correct, with Monday weekly digests covering the Fri+Sat+Sun weekend
interval exactly once.

**Delivery is SIMULATED everywhere in this feature and in the backing API
workflow** (`services/api/src/workflows/notifications/`): digests and test
events are handed to an in-memory recorder; there is no email, SMS or
webhook code. The channel note field is a display placeholder.

## Files

| File | Role |
| --- | --- |
| `digestModel.ts` | Pure digest/subscription view models: agency-timezone window labels (zone abbreviation visible across DST boundaries), event-type grouping in digest order, dedupe display ("counted, never listed"), subscription rows with the favorites badge, threshold summary text, and the demo constants mirroring the API evidence scenario. Dependency-free (no React, no clock reads). |
| `digestModel.test.ts` | `node:test` suite: instant/window labels across the 2026-03-08 spring-forward (MST/MDT both visible), grouping order, dedupe note variants, header view, subscription rows incl. the ★ favorites badge and cancelled-subscription exclusion, threshold summaries, demo-constant consistency. |
| `NotificationPrefsPanel.tsx` | Mountable React panel: subscription management with a scope picker bounded to the acting grants (the favorites rule - saving outside the readable scope is DENIED with the engine's reason), FR-025 event checkboxes, per-property threshold bounds, cadence select, channel note, removal that persists, a clearly labelled SIMULATED test-event button with per-subscription eligibility rows, the favorites-are-distinct notice, loading/empty/error/signed-out/denied states, labelled controls and `role=status`/`role=alert` semantics. Includes the demo `NotificationsPort` (in-memory, evaluator-driven) used until the shell wires the API service. |
| `index.ts` | Public exports plus the `notificationsMount` descriptor. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/notifications/digestModel.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob picks this up via
`src/features/**/*.test.ts`.)

## Data and policy source

Scope eligibility reuses `isReadableForPrincipal` from
`../operations/assignedScope.ts` through the injected evaluator (the default
binding is the fixture mirror in `../operations/fixturePolicy.ts`; the real
`@utah-water/policy` engine is injected by tests and, later, by the shell).
The authoritative digest pipeline - grant re-checks at every build, alert
links that re-run authorization at resolve time, the Denver cadence
boundary math, threshold evaluation reusing WD-013's reviewed range bounds -
lives in `services/api/src/workflows/notifications/` and is proven there by
fixed-clock suites (`schedules.test.ts` is the WD-015 evidence file).

## Pending shell wiring (next slice)

WD-015 may not edit `apps/web/src/shell/App.tsx`. The single pending block:

```tsx
import { NotificationPrefsPanel, notificationsMount } from '../../features/notifications';
// register(notificationsMount)  —  id 'notifications', mountPath 'notifications'

<NotificationPrefsPanel
  principalId={viewer.principalId}
  favoriteObjectIds={favoritesStore.listFavorites().map((favorite) => favorite.stationId)}
  status={panelStatus}
  onRetry={retry}
/>
```

The `favoriteObjectIds` prop is the favorites distinction: a ★ badge marks
subscription scopes that are also favorites; the two lists stay separate and
neither ever grants authority (FR-052). Passing a real digest view model
(`DigestView`) replaces the demo evidence block.

## Requirement traceability

- **FR-025** - site and system event alerts: subscriptions distinguish new
  sites, site edits, no signal and threshold violations; the test event
  button dispatches a SIMULATED event that reaches only currently eligible
  subscribers; every digest entry carries an alert link whose resolver
  re-checks grants at resolve time (API: `alertLinks.ts`, tested).
- **FR-052** - water user favorites and notifications: personal
  subscriptions over readable scopes; removal persists; favorites are
  visibly distinct and never alter authority or ownership.
- **FR-014/FR-016 context** - the cadence calendar mirrors WD-014's weekday /
  Monday weekend-catch-up semantics and WD-013's digest scope rules.
