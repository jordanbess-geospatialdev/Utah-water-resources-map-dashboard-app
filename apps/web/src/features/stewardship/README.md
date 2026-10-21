# stewardship (WD-014, FR-011 / FR-012 / FR-013 / FR-014 / FR-017)

The steward governance console for the Utah Water Measurement Data
Dashboard: universal vocabulary lifecycle where **retirement preserves
history**, assignment grant/revoke/deputy delegation with validity dates,
provider/site ingestion configuration with simulated staging connection
tests and the engineer-request/steward-promote boundary, connection health
**distinct from task failures** with weekday digests (Monday covers the
weekend interval exactly once), and consent-gated usage analytics that
exclude query content and identifiers.

## Files

| File | Role |
| --- | --- |
| `consoleModel.ts` | Pure view models: the policy-driven console-access verdict (`stewardConsoleAccess`), digest preview assembly (failed tasks first, connection entries carrying their filtered task-list link), health rollups (status from staging tests only; failed tasks a separate total), vocabulary change lists, ingestion queue summaries, usage tables with the FR-017 exclusion note. Structural mirror types of the server modules' outputs. |
| `consoleModel.test.ts` | Three layers: pure derivations; a demo-port cross-check of the console gate against the REAL `@utah-water/policy` engine for every fixture persona; and server parity - the REAL digest builder (`services/api/src/workflows/stewardship/connections.ts`, loaded at runtime) rendered through the view models. |
| `demoData.ts` | Demo-only default bindings (the operations-feature `fixturePolicy` pattern): a fixture world mirror, a demo evaluator for the console-gate question only (cross-checked decision-by-decision against the real engine), and a frozen demo data bundle mirroring the API fixture scenario. |
| `StewardConsole.tsx` | Mountable React panel: five WAI-ARIA tabs (vocabulary, assignments, ingestion, connection health, usage analytics) with keyboard operation, text+shape status, loading/empty/error states, and a policy-denied panel for every non-steward persona (403; 401 for identity failures). Mutations dispatch through optional callbacks; without one the controls explain the pending wiring instead of pretending to work. |
| `index.ts` | Public exports plus the `stewardshipMount` descriptor. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/stewardship/consoleModel.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob picks this up via
`src/features/**/*.test.ts`.)

## Server counterpart

The authoritative logic lives in
`services/api/src/workflows/stewardship/` (`vocabulary.ts`,
`assignments.ts`, `ingestion.ts`, `connections.ts`, `usageAnalytics.ts`),
gated by the real entitlement engine through the shared `gate.ts`
(steward-only mutations; 403 for other personas, 401 for identity
failures) and pinned by the suites in
`services/api/src/workflows/stewardship/test/` (evidence suite:
`connections.test.ts`).

## Pending shell wiring (one line)

WD-014 does not touch `apps/web/src/shell`. When the manage tab registers
features, the wiring is exactly:

```ts
import { stewardshipMount } from '../features/stewardship';
// registry.push(stewardshipMount)  // <- the one pending line
```

Replacing the demo bindings with live data is equally narrow: pass
`world`/`policy` from the shell's engine port and `data` from the
`/admin/connections` + `/admin/assignments` projections, plus the
`actions` callbacks bound to those endpoints.

## Why the policy engine is injected, not imported

`apps/web/tsconfig.json` is orchestrator-owned and does not enable
`allowImportingTsExtensions`, so the sources of `packages/policy` cannot
enter the web tsc program (same constraint documented in
`features/operations/README.md`). `consoleModel.ts` defines structural
mirror types; the tests load the real engine and the real server digest
builder at runtime via computed specifiers and cross-check the demo port
and the view models against them.
