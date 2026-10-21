# utah-water-dashboard
developed by Jordan Bess

Utah Water Measurement Data Dashboard — production monorepo.

Requirement baseline: the delivery specifications under
`TMG_OD-BK-DOCS/UTAH_Water_DWRi/output/specifications/` (PRD, technical
specification, architecture, AI development and testing plan). WD-001 imports
the baseline snapshot into `docs/product/` and `docs/traceability/`.

## Repository topology (ADR-13)

- `main` — protected release history; production deploys from signed tags only.
- `integration` — protected convergence branch; all task PRs target it; only the orchestrator merges.
- `feat/<WD-ID>-<slug>` — one task, one branch, one linked worktree, one writer.
- `test/<T-ID>-<slug>` — independent QA/security test branches.
- `contract/v<N>-<slug>` — shared contract proposals accepted by the orchestrator.
- `chore/deps-<date>` — the only branches allowed to change `pnpm-lock.yaml`.
- `release/`, `hotfix/` — platform operations.

Agent worktrees live in a sibling directory (`../utah-water-dashboard-worktrees/`).
Create, sync, push and remove them with `scripts/worktree.sh`.

## Merge gates

`node scripts/gate.mjs all <WD-ID>` (mirrored by `.github/workflows/ci.yml`):

- **scope** — changed paths fall inside the task's `write_scopes` in `tasks.json`.
- **trailers** — every commit on `feat|fix|test|contract` branches carries
  `Task:`/`Tests:` and `Agent:` trailers; local hooks enforce this at commit time.
- **migrations** — `database/migrations/` files are append-only after reaching integration.
- **lockfile** — `pnpm-lock.yaml` changes only on `chore/deps-` branches.

## Status

Bootstrap only. No runnable application packages exist yet — WD-006 imports the
validated prototype as the initial `apps/web` source once WD-002 contracts land.
Task queue and dependencies: `tasks.json` (orchestrator is the single writer).
