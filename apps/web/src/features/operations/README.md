# operations (WD-009, FR-019 / FR-036 / FR-038)

The assigned operations workspace for the Utah Water Measurement Data
Dashboard: commissioner/engineer/deputy sites derived from **live policy
grants**, a separate public browse tab, engineer site diagnostics, and known
data issues with visibility filtering.

## Files

| File | Role |
| --- | --- |
| `assignedScope.ts` | Pure, engine-driven derivation: every row admission, internal-field read and per-stream verdict is the verdict of an injected policy evaluator at an injected clock. No authorization logic lives here. Also exports `publicBrowseRows` (the strict public projection tab) and `isReadableForPrincipal` (the shared favorites readability rule). |
| `assignedScope.test.ts` | `node:test` suite against the REAL `@utah-water/policy` engine: Cody/Fatima/Priya/Diego/Ana matrices, half-open delegation boundaries, revocation/expiry at grant-version change, anonymous/unknown/inactive denials, plus a full cross-check of the fixture mirror (personas x objects x field classes x boundary clocks, 500+ decisions). |
| `fixturePolicy.ts` | Demo-only mirror of the policy engine over the frozen contract fixtures (the default port when no shell wiring exists). Cross-checked decision-by-decision against the real engine in `assignedScope.test.ts`; the projection module `shell/data/projection.ts` follows the same demo-mirror convention. |
| `knownIssues.ts` | The two synthetic FR-038 fixture issues (public issue on a public station anchored to the declared fixture gap; internal issue on the restricted owner station) with resolution history, and policy-driven visibility filtering (`knownIssuesForViewer`). |
| `knownIssues.test.ts` | FR-038 field coverage, history/status consistency, and the visibility matrix (anonymous, Cody-as-recorder, Fatima, Diego, Priya, revoked grant) against the real engine. |
| `OperationsWorkspace.tsx` | Mountable React panel: assigned-sites list with freshness and latest readings, quick filters reusing the discovery filter model read-only, separate Browse-public tab (public projection only), diagnostics section for internal-field-capable personas (voltage streams and internal blocks via the projection layer's entitlement path - never raw), known-issues display, loading/empty/denied/stale states, WAI-ARIA tabs with full keyboard operation. |
| `siteWorkspace.test.ts` | **The WD-009 evidence suite**: the persona matrix against the real engine - Cody assigned-system-only, deputy delegation window (before/inside/after; public browse intact), Fatima Bear-diagnostics-only, Priya cross-scope denial, revocation/expiry dropping rows at grant-version change, and favorites never granting access. |
| `index.ts` | Public exports plus the `operationsMount` descriptor. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/operations/assignedScope.test.ts \
  src/features/operations/knownIssues.test.ts src/features/operations/siteWorkspace.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob picks these up via
`src/features/**/*.test.ts`.)

## Why the policy engine is injected, not imported

`apps/web/tsconfig.json` is orchestrator-owned and does not enable
`allowImportingTsExtensions`, so the sources of `packages/policy` cannot
enter the web tsc program. `assignedScope.ts` therefore defines structural
mirror types of the engine's public surface (`PolicyWorldMirror`,
`PolicyEvaluator`, ...) that the real `buildWorld()` output and `evaluate()`
satisfy as-is. Tests inject the real engine (loaded via a computed
specifier, outside the tsc program - the same pattern as
`apps/web/tests/adapters.test.ts`), and `siteWorkspace.test.ts` is the
evidence that the derivation follows the engine verdict-for-verdict,
including deputy windows, revocation and engineer variants.

## Pending shell wiring (persona_ui's next slice)

WD-009 may not edit `apps/web/src/shell/App.tsx`. The single pending block,
once the shell accepts the manage tab:

```tsx
import { OperationsWorkspace, operationsMount } from '../../features/operations';
// register(operationsMount)  —  id 'operations', mountPath 'operations'

<OperationsWorkspace
  principalId={viewer.principalId}          // session identity
  role={viewer.role} organizationId={viewer.organizationId}
  cachedAssignmentVersion={cachedVersion}   // stale-state detection
  status={panelStatus} onRetry={retry}
/>
```

To bind the REAL engine instead of the fixture mirror (one line plus the
package import, for the orchestrator's wiring slice):

```tsx
import { buildWorld, evaluate } from '@utah-water/policy'; // or relative src import
<OperationsWorkspace world={buildWorld({ principals, stations })} policy={evaluate} now={clock} ... />
```

## Requirement traceability

- **FR-019** — assigned operations workspace: only currently assigned
  systems/sites; separate public browse tab; no request-body system id can
  widen scope (the derivation input carries the session principal only).
- **FR-036** — engineering diagnostics: internal streams (voltage) and
  internal blocks surface only through internal-field capability in scope,
  via the projection layer's entitlement path, never raw; a public site
  never publishes its internal diagnostics.
- **FR-038** — known issues with affected stream, half-open interval,
  status, visibility and resolution history; carrying and omission both
  follow engine verdicts.
- **FR-009 / FR-052 boundaries** — assignment version echo supports cached
  view invalidation; favorites never grant access (asserted in
  `siteWorkspace.test.ts`).
- Delegation windows, revocation and expiry semantics are the engine's
  (`packages/policy`), mirrored for the demo and cross-checked in tests.
