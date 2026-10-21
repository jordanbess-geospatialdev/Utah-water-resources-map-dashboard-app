# quality (WD-013, FR-015 / FR-016 / FR-034 / FR-036 / FR-038)

QC rules, violation digests, engineering diagnostics and known data issues
for the Utah Water Measurement Data Dashboard:

- **QcRulesPanel** — the versioned rule console: five rule families (range
  including voltage bounds, rate-of-change, persistence, missing-data,
  zero-value) with author and update times, lifecycle ○ draft → ◐
  fixture-tested → ● promoted, a test-run view showing the fixture outcomes
  BEFORE promotion, the steward-only promote button (disabled with its
  reason until the entitlement gate and a passing fixture test exist), and
  the isolation banner where one failed rule never hides its siblings'
  counts.
- **ViolationsPanel** — the acting persona's violation digest: entries
  already scope- and authorization-filtered server-side, sortable by
  violation type or time, every entry linking to the matching filtered
  context, dedupe/omission transparency counts, and subscription management
  (system/stream scope, hourly/twice-daily/daily/weekly cadence).
- **DiagnosticsPanel** — the engineer diagnostics view: discharge, level and
  voltage streams in scope (including internal ones), scoped + versioned
  capacity threshold flags rendered as symbol + text + severity word (never
  color alone), and the denied state with the server's status/reason for
  non-engineers.
- **KnownIssuesPanel** — the known data issue list: stream + half-open
  interval, status (● open / ◐ monitoring / ✓ resolved), visibility rules
  for charts and exports, and the append-only resolution history.

## Files

| File | Role |
| --- | --- |
| `qualityModel.ts` | Pure, dependency-free view models (no React, no fixtures, no clock): badges, promote gating, type sorting, context links, subscription/issue rows, plus the fixture-derived DEMO_* defaults that mirror the reviewed expected outcomes. |
| `qualityModel.test.ts` | `node:test` suite: badge text+shape contract, promote gating, isolation-visible rule rows, type/time sorting, interval formatting, cadence labels, indicator badges, known-issue rows. |
| `QcRulesPanel.tsx` | FR-015 rule console (test-before-promote, steward-only promote, isolation). |
| `ViolationsPanel.tsx` | FR-016 digest view + subscription management. |
| `DiagnosticsPanel.tsx` | FR-036 engineer view with FR-034 labelled threshold flags; denied state for non-engineers. |
| `KnownIssuesPanel.tsx` | FR-038 issue list with visibility filtering and resolution history. |
| `index.ts` | Public exports plus the four mount descriptors. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/quality/qualityModel.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob picks the suite up
via `src/features/**/*.test.ts`.)

## Server counterpart

All behavior lives in `services/api/src/workflows/qc/` (pure TypeScript,
`node:test`): `rules.ts` (the five versioned families + `evaluate`),
`expected.ts` (the hand-derived golden, **reviewed-pending-owner-approval**
— the demo constants here mirror it), `engine.ts` (isolated runs,
test-before-promote, run history), `subscriptions.ts` (digests), 
`diagnostics.ts` (engineer view + thresholds + public projection) and
`knownIssues.ts` (lifecycle + export context). The panels render what those
modules decide; they decide nothing themselves.

## Pending shell wiring (persona_ui's next slice)

WD-013 may not edit `apps/web/src/shell/App.tsx`. The pending lines, once
the quality tab surface accepts features:

```tsx
import { qcRulesMount, violationsMount, diagnosticsMount, knownIssuesMount } from '../../features/quality';
// register(qcRulesMount)         —  id 'quality-rules',         mountPath 'quality/rules'
// register(violationsMount)      —  id 'quality-violations',    mountPath 'quality/violations'
// register(diagnosticsMount)     —  id 'quality-diagnostics',   mountPath 'quality/diagnostics'
// register(knownIssuesMount)     —  id 'quality-issues',        mountPath 'quality/issues'
```

or, rendered directly inside a quality tab:

```tsx
<QcRulesPanel />
<ViolationsPanel />
<DiagnosticsPanel access={verdict.access} deniedStatus={verdict.status} deniedReason={verdict.reason} />
<KnownIssuesPanel includeInternal={maySeeInternal} />
```

## Requirement traceability

- **FR-015** — versioned automated QC rules: five families, author/update
  times, independent execution, test before promotion.
- **FR-016** — QC subscriptions: system/stream scope, four cadences, digests
  with only authorized violating streams, violation-type sorting, matching
  context links.
- **FR-034** — capacity thresholds: scoped and versioned, labelled map and
  series indicators with symbol or text as well as color.
- **FR-036** — engineering diagnostics: discharge/level/voltage streams for
  authorized engineers; internal diagnostics never public.
- **FR-038** — known data issues: stream + interval, status, visibility,
  resolution history; charts/exports carry the permitted issue context.
