# Utah Water Dashboard Verification Record

21 October 2026

This record distinguishes executed checks from planned production acceptance. The specification backlog remains planned even where a synthetic prototype demonstrates part of a requirement.

## Completed checks

| Check | Result and scope |
| --- | --- |
| Source extraction | Updated requirements: 72 pages; staff augmentation scope: 5 pages; modernization roadmap: 42 pages. Originals remain unchanged. |
| Requirement registry | 68 functional and 10 nonfunctional requirement IDs; unique and complete evidence/acceptance fields. |
| Backlog | 31 unique tasks, exact coverage of all 78 requirements, valid references and acyclic dependencies. MVP readiness has no R2 or Discovery dependency. All task statuses remain planned. |
| Documentation links | All relative links in the four specification documents resolve within the workspace. |
| Cross-document review | Independent review reconciled performance/recovery targets, scoped engineer profiles, public browse, revocation, protected downloads and release gates. |
| Worktree and branch strategy refinement | Added the mandatory repository topology section to the development plan (branch taxonomy, one-task-one-worktree rules, shared-file arbitration, lifecycle and protection), ADR-13 to the architecture, execution-policy keys to `backlog.json`, and PR/worktree templates. The worktree script passed `bash -n` and a smoke test of usage, list and no-remote failure paths in a throwaway repository; it has not run against the production repository because that repository does not yet exist. |
| Wave 3 partial: WD-007 + WD-024 merged; P0 complete | WD-007 discovery suites reproduced (29/29 + 11/11, web total 85/85) with leak-scan and hostile-URL assertions verified. WD-024 ops verifier reproduced 5/5; CI gates intact, release pipeline dispatch-only and fail-closed, no executable push steps. All P0 qualification tasks (WD-001..005, WD-024) are now merged. Docker became available and a live T-05 NeoServer qualification capture was dispatched on a test branch; its verdicts are pending. |
| Wave 2 complete (WD-005/WD-011) | Both branches gated, independently reviewed and squash-merged after recovery from a platform usage-limit interruption (agents were killed mid-run; drafts were verified and completed by relaunched agents, with WD-005 fixing five real draft defects incl. a WMS axis-order trap). Root pnpm test now covers six packages, all green: contracts 1212 assertions, database 5/5, policy 26/26, web 45/45, api 20/20, geo-gateway 84/84. Live NeoServer capture and all drills remain pending Docker/registry access; corrections/audit and gateway enforcement are fixture-tested only. |
| Wave 1 complete (WD-003/WD-004/WD-006) | All three wave-1 branches gated, independently reviewed and squash-merged into integration (0fe6c37, d399cc3, 482c495). Full root test suite green from one command: contracts 1212 assertions, database 5/5 static checks, policy 26/26, web 32/32. The web agent additionally performed a browser smoke test of persona switching, GeoLibre rendering and the denied-URL flow; the orchestrator did not re-verify browser behavior under this environment loopback policy, so browser QA remains a pending release gate. All worktree branches were removed after merge; one stale preview server process was stopped and its directory cleared. |
| Production build kickoff | Bootstrapped the production monorepo (ADR-13 topology, working gates and hooks proven by a rejected trailer-less commit). WD-001 merged at integration `2cc22b7` after snapshot-integrity review; WD-002 merged at `328629e` after gate re-run, checker reproduction (1212 assertions) and route-table verification; the apps/web dependency baseline was locked through a `chore/deps` branch with a passing build. WD-003/WD-004/WD-006 dispatched to background agents in dedicated worktrees — their merges are pending and must not be reported as complete until gated and reviewed. Code was moved to `C:\TMG\Client_work\Utah_WaterResources_MapApp` per user direction after OneDrive held worktree file locks; the OneDrive copies were deleted and the moved repository verified intact (full history, clean status). |
| Dependency installation | Pinned pnpm install with `--frozen-lockfile` completed successfully; package integrity resolution preserved. |
| Unit checks | 12 Node tests passed across policy, service adapters and observation logic. They test demo scope/export decisions, validation, original preservation, appended corrections, duplicate timestamp normalization, zero values, latest quality and URL construction. |
| Type checking | Strict TypeScript check completed successfully. |
| Production build | Vite build completed successfully; compiled assets are included under `prototype/dist`. |
| GeoLibre integration | Source imports and build resolve actual `@geolibre/map` 3.3.0 and `@geolibre/core` 3.3.0 with MapLibre GL JS 6.15.0. |
| Independent code review | A separate reviewer identified and checked fixes for encoded tile placeholders, equivalent timestamp duplicates, historical correction quality and read/write scope separation. |
| Private publication | Sites reported `succeeded` for the exact saved source commit `6ea21e744fd25f72ad4d01028acfbbc6b152d38b`; the synthetic prototype remains owner-private. |

The final JavaScript bundle is approximately 2.06 MB uncompressed and 576 KB gzip. Vite reports a large-chunk warning. This is a measured build size, not an acceptable-performance benchmark; lazy loading and field-device performance remain production work.

The [private hosted prototype](https://utah-water-persona-prototype.perky-yew-4670.chatgpt.site) contains only the synthetic app. Deployment ID: `appgdep_6ad83db8494881918fa06192e7193d68`. Publication confirms hosting success, not browser or live-integration acceptance. The Windows archive-helper path issue was repaired by running the official helper under MSYS Bash with POSIX paths; no application security setting was changed. Temporary local preview/idle packaging processes were stopped after publication.

## Browser and visual review limit

The local launcher started, but the readiness request could not connect through the environment's loopback restrictions. The browser tool refused the local URL under its URL policy. No alternate browser or automation method was used to bypass that refusal. Browser rendering, click workflows, responsive layout, map drawing, keyboard behavior, console errors and accessibility have therefore not been verified in a browser.

The prototype's forms, map integration and focus handling have source-level and build checks. These do not establish browser or WCAG conformance. Review all six personas at desktop and mobile sizes using the hosted copy or the included launcher before accepting UI behavior.

All six supplied Figma references are recorded. Their content was not accessible in the session, so frame fidelity, interaction parity and the commissioner/water-user starting-node ambiguity still require design review. Two of the six prototype URLs were fetched again during the 21 October refinement and returned only the JavaScript-rendered shell, confirming the limitation is on the Figma side of the exchange; no visual content could be extracted without authenticated API access.

## Production checks still planned

- Institutional OIDC, sessions, CSRF, researcher credential lifecycle and server-enforced object/field permissions.
- Actual Google Cloud database product/version/extensions, network/TLS, PostGIS views, TimescaleDB feasibility and database migrations.
- Live NeoServer collections, OpenAPI/capabilities, MVT source layers and coordinates, Features pagination, WFS GeoJSON and WMS axis behavior.
- Multi-user/cohort isolation, decoded-tile property review, private attachment access, revocation and cache behavior.
- Scientific golden values, DST/irregular-flow aggregation, coverage and finalized report reconciliation.
- Offline queues, synchronization, conflicts, device retention, real ingestion, QC rules, digests and official reports.
- Load tests, manual accessibility, all transitive licenses/dependency findings, restore/recovery and deployment rollback.

Use the [development and testing plan](specifications/04-ai-development-and-testing.md) for the exact planned acceptance groups and evidence contracts. The local demo deliberately includes every synthetic fixture in its client bundle; changing the demo role does not create a security boundary.
