# Repository review — 21 October 2026

The review found and corrected reproducible security, correctness, runtime,
database and CI defects. The resulting local checks pass. **The application
cannot yet be accepted as issue-free, production-ready, or fully compliant
with its MVP requirements:** substantial integration and acceptance work is
still missing. Passing domain tests does not establish complete user workflows.

## Scope and environment

- Reviewed the canonical `state-of-utah-waterresources` checkout, initially
  clean on `integration` at `073b159f1329ea82ba4764969189615c6a2e9266`.
- Review branch: `chore/deps-2026-10-21-review`. Verification was performed on
  the working tree before commit. No deployment, production data access, task
  completion or owner approval was changed. This cross-task review needs scoped changes before PR submission;
  the dependency branch's scope exception does not permit all these code edits.
- Windows 11 x64, Node v24.20.0; dependency install/update/audit invoked through
  Corepack pnpm 10.14.0. The qualification runner separately reports the pnpm
  11.25.0 available on PATH; its frozen install explicitly uses Corepack.
- Final lockfile SHA-256:
  `06403736adc9b4f2ed835015207cfd59adc1d339c4aadd7101af15f11de28d0f`.
- Parallel reviews covered frontend/runtime, API/policy/database, requirements
  and documentation, and repository/release tooling. Repository gate changes
  received a second review and synthetic Git reproductions.

## Corrected findings

| Priority | Defect and impact | Correction / evidence |
| --- | --- | --- |
| P1 | A denied outsider download could permanently fail another user's export and delete its artifact. | Requester reauthorization and caller denial are separated in `services/api/src/exports/exportJob.ts`; requester revocation still invalidates artifacts. Regression test reproduced the original behavior. |
| P1 | Token stream limits trusted optional query coordinates instead of the actual target; invalid dates could pass bounds checks. | `services/api/src/tokens/scopeEval.ts` binds stream scope to the target and denies invalid/reversed/out-of-range timestamps. Negative tests pass. |
| P1 | Malformed assignment/delegation dates could authorize; assignment administration retained an obsolete grant snapshot. | Policy rejects malformed windows; stewardship checks its rebuilt current assignment world, including after self-revocation. Negative tests pass. |
| P1 | Public SQL views exposed proposed/retired stations that the policy engine excludes. | Append-only migration `V202610211203__WD-003_publication_lifecycle.sql`; real PostgreSQL regression covers all 12 visibility/lifecycle combinations in both views. |
| P1 | Fixture SQL failed against PostgreSQL despite passing count-only checks. | Corrected vocabulary field mapping, parent-before-subgroup insertion, and typed empty arrays. All migrations and two complete fixture loads now execute. |
| P1 | MapLibre's worker failed to load under Vite, leaving the map blank. | Explicit Vite worker bundling in `StationMap.tsx`; development and production-preview map rendering verified in a browser. |
| P2 | Camera updates triggered repeated fitting; startup and basemap changes overwrote shared views; synchronous style events could leave the map loading. | Restore URL state before mount, stabilize projections, fit only on changed station locations, preserve camera, and subscribe before replacing the style. Model regressions and browser checks pass. |
| P2 | The chart area fill implied measurements across gaps; interactive chart controls were inside an image role. | Removed the gap-spanning fill and used a group role; chart point buttons are exposed in the browser accessibility tree. This is not full accessibility certification. |
| P2 | Fresh flagged stations could appear in the normal map category; export completion could bypass its time cap; CSV byte counts were incorrect for Unicode. | Correct category precedence, completion-time checks before/after rendering, and UTF-8 byte length with regressions. |
| P1 | CI secret scanning could report clean when the Git diff failed (`+U` was an invalid diff argument). | New added-line scanner fails on Git errors, detects full dashboard tokens and existing credential patterns, and redacts values. Regressions cover added/removed credentials and invalid bases. |
| P1 | Detached PR checkouts bypassed source-branch trailer rules; dependency PRs could not pass scope gates; missing base history silently passed. | Source branch plus exact PR head SHA, bounded dependency scopes, fail-closed missing history, argument-safe Git calls, and rename-safe migration checks. Synthetic two-parent merge tests prevent rejecting the host's generated merge commit. |
| P1 | Release preflight warned about unsigned tags but allowed them; workflow inputs were inserted directly into shell source. | Tag verification fails closed against the approved runner keyring, and inputs enter through environment variables. Tests verify a trusted signed tag succeeds and unsigned, untrusted or mismatched tags fail. Runner trust provisioning remains an operations prerequisite. |
| P1 | Dependency audit found 13 Vite advisories (4 high, 6 moderate, 3 low). | Vite upgraded from 7.1.3 to pinned 7.3.7; current registry audit reports zero known vulnerabilities. The [Vite advisory](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff) documents one affected Windows path-handling case. Audit results are time-specific and are not proof of exploitability or absence of unknown vulnerabilities. |
| P2 | Documentation described the repo as bootstrap-only while other documents claimed all functional requirements were implemented. | Updated root/package setup, release scope, training boundaries, source/API links, historical defect status and operations evidence; retained immutable baselines and captured artifacts. |

## Executed verification

| Check | Result and limits |
| --- | --- |
| Frozen install | `corepack pnpm install --frozen-lockfile` passed, including the qualification runner's install against the updated lockfile. |
| Full test command | `corepack pnpm test`: **845/845 Node tests passed**, zero skipped or failed: 13 repository gates, 242 web, 31 policy, 87 gateway, 472 API. |
| Contract check | 1,212 assertions; 22 operations, eight schemas, six fixtures and nine SHA-256 contract hashes verified. |
| Database static check | Six checks passed; four migrations and deterministic generation of 165 inserts across 21 populated tables. |
| Real SQL execution | Network-disabled disposable PostgreSQL 17.5 / PostGIS 3.5.2: four migrations, fixture load twice, qualification queries, and regression SQL passed. Historical public views reproduced the lifecycle disclosure before the new migration. [Detailed SQL evidence](../../database/qualification/review-2026-10-21.md). Container removed. |
| TypeScript | `corepack pnpm typecheck` passed for the configured web project. Backend packages have no independent typecheck scripts. |
| Production build | `corepack pnpm build` passed with Vite 7.3.7 and a separately bundled MapLibre worker. Large-chunk warnings remain: approximately 2.11 MB main JavaScript (588 KB gzip) and a 517 KB worker. Load/performance acceptance remains pending. |
| Qualification | `node tests/qualification/run-qualification.mjs` passed all nine groups on two runs with identical group results, while reporting nine BLOCKED items. Its live-SQL, browser, audit and infrastructure exclusions concern that runner; separate SQL, browser smoke and audit evidence is recorded here. Full staging qualification is still incomplete. |
| Browser smoke | Development and built-preview maps render; shared center/zoom survive startup and basemap changes; keyboard panning remains stable; Fit stations and filtering render expected locations; chart buttons appear in the accessibility tree. [Browser record](../../apps/web/README.md). Review servers/tabs closed; preexisting port 5173 left running. |
| Operations | `bash ops/verify.sh`: five checks, zero failures. Hosted CI and release dispatch were not executed. |
| Dependencies | `corepack pnpm audit --json`: zero known vulnerabilities after the upgrade. No license/compliance audit was performed. |
| Patch hygiene | `git diff --check` passed. All 57 relative Markdown links in changed/new documentation resolve; requirement mappings were inspected. |

The root `lint` command is a no-op because no workspace defines a lint script.
It is not recorded as lint coverage. Repository gate regressions test committed
temporary repositories; the task-scoped merge gate is not a validation of this
uncommitted, cross-task working tree.

## Requirement status and remaining work

The four imported baseline Markdown documents match the canonical originals
byte-for-byte. All **78 requirements** have traceability/backlog mappings:
51 MVP functional requirements, 10 MVP nonfunctional requirements, 15 R2
functional requirements, and two Discovery requirements. This verifies the
mapping, not implementation or acceptance of all 78 requirements.

| Priority | Remaining gap | Evidence / acceptance needed |
| --- | --- | --- |
| P1 | Many feature panels are not mounted in the runnable shell. | `apps/web/src/main.tsx` mounts `src/shell/App.tsx`, which does not import the later `features/*` panels. NLP filtering, richer series workflows, data entry, visits, reports and other panels require navigation/state integration and actual persona E2E tests. The shell's older share-state codec also differs from the discovery module's stronger public-only sharing contract. |
| P1 | API HTTP transport, production identity and durable repositories are missing. | `services/api/package.json` has no server/start entry point. Auth, tokens, notifications and attachments document fixture/in-memory/placeholder seams. FR-009/FR-010/FR-011 and production data workflows need authenticated routes, persistent adapters and direct unauthorized-request tests. |
| P1 | Staging acceptance is incomplete. | Full browser persona coverage, manual keyboard/screen-reader/zoom conformance, representative performance/load, real-host DB/extension qualification, cache/isolation, and coordinated recovery/rollback are still required. Local SQL and browser smoke tests do not replace these gates. |
| P2 | CI coverage has limits. | Configure a real linter and backend typechecks; automate live disposable SQL and browser workflows so unit checks cannot conceal transport or runtime failures. Preserve the new gate regressions and production build step. |
| P1 | Owner decisions and UAT sign-offs are outstanding. | [Decision register](../product/decision-register.md): 18 open decisions. [UAT register](../uat/SIGN-OFF.md): 12 pending sign-offs. Product, governance, identity and platform owners must ratify their own decisions. |
| Release boundary | R2 and Discovery are not delivered by the current checkout. | Rating history, offline sync and supplier reporting work exists separately in active worktrees/tasks; it was not merged, modified or certified by this review. Follow the existing release scopes rather than counting deferred features as MVP failures or completed features. |

The original T-05 capture's D5 finding is historical. The living
[NeoServer behavior record](../../infra/neoserver/qualification/KNOWN-SERVER-BEHAVIOR.md)
documents implemented MVT v1/v2 compatibility and the D7 deterministic-ID
correction. Its remaining upstream quirks and deployment requirements must be
qualified on the actual staging stack; this review did not re-capture it.

Next, integrate the MVP panels with authenticated HTTP/persistence adapters,
add the missing automated checks, and execute the staging acceptance matrix
before requesting the recorded owner sign-offs. No acceptance status or
production authorization is inferred from this review.
