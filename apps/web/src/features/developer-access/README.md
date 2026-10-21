# developer-access (WD-016, FR-064)

The scoped-credential account UI: list, create, rotate and revoke researcher
API tokens with a copy-once secret disclosure (PRD "Data lifecycle
decisions": the secret is displayed exactly once at creation or rotation;
thereafter label, scope, creation date, last use and rotate/revoke controls
only).

## Files

| File | Role |
| --- | --- |
| `derivation.ts` | Pure, dependency-free view model: status derivation (active/expiring/expired/revoked at an injected clock), expiry countdown, scope summarization, authority-bounded scope choices, create-draft validation and the draft-to-scopes request shape. No React, no clock reads. |
| `derivation.test.ts` | `node:test` suite: status boundaries (including the half-open expiry instant), countdown rounding, summaries, authority-bounded pickers, validation errors, narrowing semantics. |
| `DeveloperAccessPanel.tsx` | Mountable React panel: token list (label, scopes summary, created, expires, last used, status), create dialog with scope pickers BOUNDED by the account's authority, one-time secret disclosure that drops the secret from state when acknowledged (no re-show path), rotate/revoke with single confirmations naming the consequence, loading/error/empty states, keyboard-accessible dialogs (Escape, focus, labelled controls). |
| `index.ts` | Public exports plus the `developerAccessMount` descriptor. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/developer-access/derivation.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob picks this up via
`src/features/**/*.test.ts`.)

## Data source

By default the panel runs the frozen fixture world (Sarah the researcher)
with an in-memory simulation of the token domain, so it is fully functional
standalone - the demo secret is generated in the browser and exists only in
the disclosure state until acknowledged. Every operational prop can be
overridden by an API-backed loader: `tokens` (public projections, never
secrets), `onCreate`/`onRotate`/`onRevoke` (POST/DELETE `/me/api-tokens`),
`status`/`errorMessage`/`onRetry`, and `now` for a fixed clock.

The server-side policy (scope model, 90-day lifetime proposal, rotation
runbook, logging rules) is documented in `docs/api/TOKEN-POLICY.md`; the
token domain itself lives in `services/api/src/tokens/`.

## Pending shell wiring (persona_ui's next slice)

WD-016 may not edit `apps/web/src/shell/App.tsx`. The single pending line,
once the account surface accepts features:

```tsx
import { developerAccessMount } from '../../features/developer-access';
// register(developerAccessMount)  —  id 'developer-access', mountPath 'account/developer-access'
```

or, rendered directly in the account page:

```tsx
<DeveloperAccessPanel />
```

## Requirement traceability

- **FR-064** — research credential lifecycle: create scoped credential,
  copy secret once, rotate/revoke without a new account; revoked credentials
  fail on the next request; secrets never appear in logs or share URLs.
- **FR-065** — the panel links the researcher to the documented API
  (`docs/api/README.md`) whose examples the created tokens serve.
- **FR-066** — processing-level scope pickers (raw/provisional/reviewed/
  best-available) in the create dialog.
