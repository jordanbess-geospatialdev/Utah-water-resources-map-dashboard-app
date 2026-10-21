# Utah Water Measurement Data Dashboard

Developed by Jordan Bess.

This monorepo contains a runnable synthetic-data map prototype, frontend
feature modules, API domain libraries, authorization policy, versioned
contracts, PostgreSQL/PostGIS migrations, and qualification tooling.
It is **not yet a production-ready, integrated application**. In particular,
the web shell does not mount all feature panels, the API has no HTTP server,
and identity/persistence/delivery adapters remain fixture-backed or unbound.
See the [repository review](docs/verification/2026-10-21-repository-review.md)
for verified fixes, test evidence, and the remaining acceptance gaps.

## Run locally

Use Node.js 22.18 or newer and the
repository-pinned pnpm 10.14.0. Corepack selects that version from
`packageManager`; do not regenerate the lockfile with a different manager.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @utah-water/web dev
```

Open `http://127.0.0.1:5173` (Vite prints a different port if occupied).
The role picker simulates personas against synthetic fixtures; it is not
authentication. Basemaps require external network access. There are no real
credentials or production services needed to run the prototype.

## Packages and boundaries

| Path | Responsibility |
| --- | --- |
| [`apps/web`](apps/web/README.md) | React/Vite map shell, chart, discovery, and feature panels; see its README for which panels are reachable. |
| `services/api/src` | Authorization-aware domain functions, reports, exports, tokens and workflows. No HTTP transport or production storage binding yet. |
| [`services/geo-gateway`](services/geo-gateway/README.md) | Authorized spatial proxy logic and protocol tests; requires a deployed transport and qualified NeoServer for live requests. |
| `packages/policy` | Shared authorization engine and policy matrix. |
| [`packages/contracts`](packages/contracts/openapi.json) | OpenAPI and schema contracts, fixture checks, immutable agreement hashes. |
| [`database`](database/README.md) | Append-only SQL migrations, deterministic fixture loader, static and executable SQL checks. |
| [`infra/runtime`](infra/runtime/README.md), [`ops`](ops/README.md) | Runtime definitions, release/recovery runbooks and deployment gates. |

## Verify changes

Run these from the repository root:

```sh
corepack pnpm test                 # repository gate regressions + all package suites
corepack pnpm typecheck            # configured web TypeScript project (not every backend module)
corepack pnpm build                # production web build
corepack pnpm test:qualification   # adversarial checks, contracts and recorded-evidence checks
corepack pnpm audit                # current registry advisories for the pinned dependencies
bash ops/verify.sh                 # static infrastructure/workflow checks; Git Bash on Windows
```

Qualification exit code zero means its executable checks passed; explicitly
reported BLOCKED items are still incomplete acceptance evidence. The root
`lint` command currently delegates to package scripts, but no package defines
a lint script: it is not lint coverage. Database static checks do not replace
executing migrations/fixtures and SQL regressions; follow
[`database/README.md`](database/README.md) against a disposable database.

## Requirements and release evidence

The authoritative imported snapshot is
[`docs/product/baseline`](docs/product/baseline/01-product-requirements.md),
with [traceability](docs/traceability/requirements-traceability.csv) and
[task acceptance criteria](docs/delivery/specifications/backlog.json).
The originals came from `TMG_OD-BK-DOCS/UTAH_Water_DWRi/output/specifications/`.
`tasks.json` records delivery task status; a completed module task is not proof
that its end-to-end workflow or requirement has passed acceptance.

The baseline assigns 51 functional and 10 nonfunctional requirements to MVP,
15 functional requirements to R2, and two to Discovery. Remaining MVP gates
include application integration, real identity/storage adapters, browser and
accessibility checks, representative load and coordinated recovery evidence,
protocol defect resolution, and owner sign-offs. See
[release notes](docs/releases/MVP-RELEASE-NOTES.md) and the
[UAT sign-off register](docs/uat/SIGN-OFF.md).

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

CI supplies the source branch and PR head SHA so detached synthetic merge
commits do not bypass trailer rules or introduce spurious trailer failures.
Missing base history fails the gate. Dependency branches without a task ID
are limited to package manifests, the workspace/lockfile, and the NeoServer
image compose file. Cross-task review changes must be divided into scoped
task changes before proposing merges.

The added-line secret scanner is `node scripts/scan-secrets.mjs`; Git errors
fail closed and suspected values are redacted. It detects a bounded set of
credential patterns, including complete dashboard tokens, and does not scan
generated bundles. Release preflight verifies tag signatures against the
runner's approved signing keyring. Deployment remains disabled pending the
explicit environment acceptance described in the operations runbooks.
