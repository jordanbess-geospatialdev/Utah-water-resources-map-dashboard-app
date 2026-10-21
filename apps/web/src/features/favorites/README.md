# favorites (WD-009, FR-009 / FR-025 / FR-052)

My Sites for the Utah Water Measurement Data Dashboard: per-account
favorites with quick status, and per-account notification subscription
preferences - both persisted with versioned schemas and validated against
the account's readable scope by the policy port.

## Files

| File | Role |
| --- | --- |
| `favorites.ts` | Per-account favorites store keyed by principal id (in-memory or localStorage, versioned schema v1, corrupt/unknown versions reset). Adding validates the site is at least readable at ADD time; listing re-validates at READ time, so a favorite-then-restricted site degrades to `omitted-with-notice` (kept, never deleted, never operational data). Removal persists. Favorites carry NO authority - documented here and asserted against the real engine. |
| `favorites.test.ts` | `node:test` suite against the REAL `@utah-water/policy` engine: per-account keying, persistence roundtrip, corrupt-schema reset, add-time rejections (restricted out of scope), owner-organization grants, favorite-then-restricted degradation and return on republication, removal idempotence, and the no-authority boundary. |
| `notificationPrefs.ts` | Per-account subscription preferences: FR-025 event kinds (new-site, site-edit, no-signal, threshold), cadence enum (immediate/daily/weekly), channel note placeholder (delivery is a later task). Scope validation is policy-driven: a restricted site outside readable scope rejects with the engine's denial reason; system scopes require at least one readable station. |
| `notificationPrefs.test.ts` | Suite against the real engine: persistence and per-account keys, replace-in-place rescans, note bounding, FR-025 rejection cases (restricted site, deputy outside the delegation window, unknown scopes, all-restricted system), removal and corrupt-schema reset. |
| `MySitesPanel.tsx` | Mountable React panel: favorites list with quick status (freshness + latest reading), omitted-with-notice rows with the engine reason, manage-subscriptions UI (site picker bounded to the readable scope, event checkboxes, cadence, note), loading/empty/error states, signed-out state; labelled controls, `role=status` notices, `role=alert` rejections. |
| `index.ts` | Public exports plus the `mySitesMount` descriptor. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/favorites/favorites.test.ts \
  src/features/favorites/notificationPrefs.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob picks these up via
`src/features/**/*.test.ts`.)

## Data and policy source

Readability checks reuse `isReadableForPrincipal` from
`../operations/assignedScope.ts` (public projection OR an engine-allowed
protected read - exactly the engine's own preference rule, "Add favorite
only if published or otherwise readable"). The default runtime port is the
fixture mirror in `../operations/fixturePolicy.ts`; every test injects the
REAL `@utah-water/policy` engine (see the operations README for why the
engine cannot be imported statically into the web tsc program).

## Pending shell wiring (persona_ui's next slice)

WD-009 may not edit `apps/web/src/shell/App.tsx`. The single pending block:

```tsx
import { MySitesPanel, mySitesMount } from '../../features/favorites';
// register(mySitesMount)  —  id 'my-sites', mountPath 'my-sites'

<MySitesPanel principalId={viewer.principalId} status={panelStatus} onRetry={retry} />
```

Anonymous visitors get the signed-out state (no shared anonymous bucket);
favorites and preferences survive sign-out and return with the account
(FR-009). Delivery of notifications is NOT implemented here - only the
preferences, per FR-025's module boundary.

## Requirement traceability

- **FR-009** — unified account and saved preferences: per-account stores,
  persistence across mounts/sessions, versioned schema with safe reset.
- **FR-025** — subscription preferences distinguish new sites, site edits,
  no signal and threshold violations; subscribing outside the readable
  scope rejects; delivery itself is a later task (channel note is the
  placeholder).
- **FR-052** — favorites of published sites with personal subscriptions;
  removal persists; "removing a favorite or subscription ... does not alter
  a site's authority or ownership", and neither does ADDING one - the
  engine denies protected reads for favorited restricted sites regardless
  of the favorites list (asserted in `favorites.test.ts` and the operations
  evidence suite `siteWorkspace.test.ts`).
