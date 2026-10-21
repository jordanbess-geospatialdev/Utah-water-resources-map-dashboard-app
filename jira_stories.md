# Utah Water Measurement Dashboard — Jira Program

Version 1.0 | 21 October 2026 | Import-ready program definition built from the approved baseline

This file defines the complete Jira program for building the Utah Water Measurement Data Dashboard from scratch: 10 epics, 54 stories, their acceptance criteria, task decompositions, UAT scripts and a full traceability appendix proving that every requirement, backlog task and test group is covered.

## 1. How to use this file

**ID conventions**

- **EP-xx** — epics (EP-01 .. EP-10). One Jira epic per row in the summary table below.
- **S-xxx** — stories (S-001 .. S-107). The hundreds digit groups stories by epic family: S-0xx foundations/data/identity/spatial, S-04x/05x public experience, S-06x operations, S-07x support, S-08x test automation, S-09x UAT/release, S-10x deferred R2/Discovery. Story ids are stable; never renumber.
- **Subtasks** — the `- [ ]` checkboxes inside each story. One Jira subtask per checkbox; check them off as work merges.
- **FR-001..FR-068, NFR-001..NFR-010, WD-001..WD-026 (+ five `-R2` packages), T-01..T-16** — stable cross-references to the source specifications. They are quoted verbatim in the `Covers:` field of every story and must never be renamed or dropped; they are the join keys to the PRD, backlog and test plan.

**Story format** (every story in section 3 uses exactly this block):

```text
#### S-xxx — Title
- Epic: EP-xx
- Release: MVP | R2 | Discovery
- Covers: WD-xxx; FR-xxx…; NFR-xxx…; T-xx…      (source ids this story implements, registers decisions for, or verifies)
- Depends on: S-xxx…                            (story ids; derived from the WD dependency graph in backlog.json)
- Story: As a <persona/role> I want … so that …  (personas: Donna public, Wiley water user, Sarah researcher,
                                                  Cody commissioner/deputy, Fatima engineer variants, Diego steward)
- Acceptance criteria: Given/When/Then or checkable bullets, derived from the PRD acceptance criterion and the
                       backlog task's acceptance_criteria — no invented scope
- Tasks: [ ] implementation subtasks (schemas, modules, tests, docs) from the WD write scopes
```

**Definition of Done (gate discipline — identical for every story)**

1. **Scoped branch per story.** One story maps to one `feat/<WD-ID>-<slug>` branch cut from `integration`, in one linked worktree, with one writer. Never two agents in one worktree; never edit another task's write scope.
2. **CI gates pass** on the PR into `integration`: changed paths inside the task's `write_scopes`; `pnpm-lock.yaml` untouched (only `chore/deps-<date>` branches change it); migrations append-only; Conventional Commit trailers (`Task:`/`Refs:`/`Tests:`/`Agent:`/`Evidence:`) present; lint, typecheck, unit, contract, affected integration and secret-scan green.
3. **Independent review** is merge-blocking: a different agent or human reproduces the checks from the reviewer packet. The implementer is never the sole approver of their own branch.
4. **Evidence in ticket:** executed commands with results, artifacts (fixtures, captures, videos, drill logs), deviations from write scope, and unresolved decisions are recorded on the story before it closes. A proposed command reported as a completed check, or a demo, never closes a production story.
5. The orchestrator squash-merges, records PR number and merge SHA, and only then marks the story done. Production deployment, live database access, destructive raw deletion, grant changes and real notifications each require separate explicit authorization.

**Source of truth**

- Production monorepo: `C:/TMG/Client_work/Utah_WaterResources_MapApp/utah-water-dashboard` (topology per ADR-13).
- Requirements: `docs/delivery/specifications/01-product-requirements.md` (68 FRs, 10 NFRs, personas, releases).
- Task graph: `docs/delivery/specifications/backlog.json` (31 WD tasks, phases P0–P4, execution policy).
- Test plan: `docs/delivery/specifications/04-ai-development-and-testing.md` (T-01..T-16, gate discipline, UAT/ownership).
- Architecture/ADRs: `docs/product/baseline/03-architecture.md`; open decisions DR-001..DR-018: `docs/product/decision-register.md`.

If this file and the specifications disagree, the specifications win; fix this file. Release re-allocations must update the PRD, traceability CSV, contracts and this file together so deferred work is never represented as shipped.

**Phase map:** P0 qualification/foundation → EP-01..EP-04 + S-010..S-012; P1 public/read-only → S-040..S-046, S-021; P2 operational field work → S-060..S-064; P3 governance/acceptance → S-065..S-069, S-070..S-072, S-080..S-086, S-090..S-096; P4 separately scoped → EP-10.

## 2. Epic summary table

| Epic | Name | Objective | Release | Stories |
| --- | --- | --- | --- | --- |
| EP-01 | Program Foundations & Delivery Infrastructure | Bootstrap the protected monorepo, per-story branch/worktree/CI gates, pinned reproducible runtime and release pipeline, and operations runbooks (ADR-13) so every later story ships the same audited way. | MVP | 4 (S-001..S-004) |
| EP-02 | Data Contracts, Fixtures & Database | Versioned OpenAPI/JSON contracts, the deterministic fixture world with scientific invariants, and a SELECT-only publication/time-series database model plus platform qualification. | MVP | 3 (S-010..S-012) |
| EP-03 | Identity, Entitlements & Security | Server-validated capabilities and scoped assignments, researcher token lifecycle, and an independent security review that never self-approves. | MVP | 3 (S-020..S-022) |
| EP-04 | Geospatial Services | Digest-pinned NeoServer protocol qualification behind an allowlisted, same-origin authorized gateway that can never leak owner-specific fields in any format. | MVP | 1 (S-030) |
| EP-05 | Public Web Experience | Account-free persona shell, discovery with governed filters and share URLs, charts/aggregation/comparisons, CSV exports, honest statewide summaries, and natural-language filtering as inspectable structured filters. | MVP | 7 (S-040..S-046) |
| EP-06 | Operational Workflows | Assigned workspaces and the full measurement lifecycle: manual/bulk entry, site setup, corrections and audit, visits/attachments, QC diagnostics, stewardship, reports, alerts and digests. | MVP | 10 (S-060..S-069) |
| EP-07 | Support, Analytics & Onboarding | Help/feedback with reproducible share-state context, consented usage analytics, role-relevant tours and commissioner training. | MVP | 3 (S-070..S-072) |
| EP-08 | Test Automation & Quality | The independent T-01..T-16 catalog as CI/staging suites with their evidence requirements, built by agents that did not implement the features. | MVP + R2 (T-09) | 8 (S-080..S-087) |
| EP-09 | UAT & Release Readiness | Per-persona task-based UAT including the 60% commissioner pilot target, manual accessibility review, performance profile run, adversarial pass, operational drills, and the release go/no-go. | MVP | 7 (S-090..S-096) |
| EP-10 | Deferred R2 & Discovery | R2: offline sync/asset transfers, supplier reporting, rating governance, decision snapshots/flexible periods, as-of/voice/WCAT, R2 qualification. Discovery: FR-050/FR-067 contracts. | R2 + Discovery | 8 (S-100..S-107) |

**Total: 10 epics, 54 stories.**

## 3. Epics with stories

### EP-01 Program Foundations & Delivery Infrastructure

Objective: the repo bootstrap, branch/worktree/CI gate machinery, runtime/release pipeline and ops runbooks every later story depends on (ADR-13, `backlog.json` execution policy).

#### S-001 — Establish source and decision baseline
- **Epic:** EP-01
- **Release:** MVP (P0)
- **Covers:** WD-001; FR-001, FR-010, FR-039, FR-044, FR-050, FR-051, FR-067, FR-068 (baseline/decision registration); T-01 (traceability wiring); DR-001..DR-018
- **Depends on:** — (entry point)
- **Story:** As the product owner I want every source page, Figma flow and open decision reconciled into a decision register before implementation begins so that no later story invents scope or silently resolves an open governance question.
- **Acceptance criteria:**
  - The six PDF personas are reconciled with the six supplied Figma flows, including Donna's starting node `81:365` on page `81:364`; exact source PDF pages and accessible nodes are recorded; no Figma frame is claimed as visually verified while access is pending.
  - Unresolved ownership, scope, data classifications, identity provider and the actual GCP database/extension inventory are captured in the decision register (DR-001..DR-018) without fabrication.
  - Release assignments for all 68 FRs are recorded so deferred items (FR-044 R2, FR-050/FR-067 Discovery, FR-051 R2) stay visible with owner and dependency.
  - The water-user and commissioner Figma links sharing node 1193-1908 are flagged for verification of the intended water-user frame before any visual-fidelity acceptance.
- **Tasks:**
  - [ ] Reconcile six personas x six Figma flows; record source pages and node ids in `docs/product/`
  - [ ] Consolidate PRD + architecture open decisions into the decision register with accountable owners
  - [ ] Record the FR-001..FR-068 release-scope map (MVP/R2/Discovery) for the traceability report
  - [ ] Publish source baseline snapshots in `docs/product/baseline` with MANIFEST
  - [ ] Wire requirement registry + backlog + plan cross-references for the T-01 traceability report

#### S-002 — Bootstrap monorepo, branch/worktree strategy and CI gates
- **Epic:** EP-01
- **Release:** MVP (P0)
- **Covers:** WD-001, WD-002 (bootstrap evidence); ADR-13; NFR-008 (automated builds, traceable migrations/rollback procedures)
- **Depends on:** S-001
- **Story:** As the delivery orchestrator I want one protected monorepo with per-story branches, linked worktrees and mechanical CI gates so that parallel work cannot collide, drift or merge unreviewed.
- **Acceptance criteria:**
  - Repository `utah-water-dashboard` exists on the DWRi-approved Git service with protected `main` and `integration`; production deploys happen only from signed `vX.Y.Z` tags on `main`.
  - The directory tree equals the write-scope vocabulary used by the agent table and `backlog.json`, so a branch's changed paths can be mechanically checked against its task's `write_scopes`.
  - CI rejects a PR when: changed paths fall outside the task's write scopes (except `test/` branches and enumerated shared-file exceptions); `pnpm-lock.yaml` changed on a non-`chore/deps` branch; a migration already merged into `integration` was modified rather than appended; commit trailers are missing task or agent identity; or lint, typecheck, unit, contract, affected integration or secret-scan gates fail.
  - One branch, one worktree, one writer per task; per-worktree `pnpm install --frozen-lockfile`; ephemeral branch-named test schemas/containers; no secrets in any worktree; environment files hold only secret references.
  - Independent review is a merge-blocking status; the implementer can never be the sole approver of their own branch; the orchestrator is sole merger and sole `backlog.json` status writer.
- **Tasks:**
  - [ ] Create the monorepo layout (`apps/web`, `packages/contracts`, `packages/policy`, `services/api`, `services/geo-gateway`, `database`, `tests`, `fixtures`, `infra`, `ops`, `docs`, `.github`)
  - [ ] Implement `scripts/gate.mjs` scope/trailer/migration/lockfile checks wired into CI
  - [ ] Add CODEOWNERS mapping directories to owning agent roles, plus the PR template (task id, requirement ids, executed commands, evidence, deviations, unresolved decisions)
  - [ ] Document the worktree lifecycle (create, rebase daily, squash-merge, cleanup incl. schema drop and env deletion) and the three-workers-plus-orchestrator scheduling rule
  - [ ] Define migration naming `V<yyyyMMddHHmm>__<wd-id>_<slug>.sql` and orchestrator renumbering at merge

#### S-003 — Pinned supply chain, secret isolation and fail-closed release pipeline
- **Epic:** EP-01
- **Release:** MVP (P0)
- **Covers:** WD-024 (pipeline portion); FR-065 (reproducible runtime backing the documented API); NFR-006 (managed secrets), NFR-008; T-16
- **Depends on:** S-002, S-011, S-030
- **Story:** As the platform operator I want pinned source/package/image revisions, isolated secrets and a dispatch-only release pipeline so that every release is reproducible and nothing reaches production without explicit authorization.
- **Acceptance criteria:**
  - Source, package and container image revisions are pinned; GeoLibre and NeoServer revisions are pinned and compatibility-tested before upgrades; no second lockfile from another installer (NFR-008).
  - Secrets live only in the approved secret manager; bundles, source maps, fixture data and agent prompts contain none; environment files hold only secret references created per worktree and deleted at cleanup.
  - The release pipeline is dispatch-only and fail-closed: no executable push; deployment and live database access stay disabled until explicit environment authorization.
  - T-16 evidence produced: locked versions/integrity; actual GeoLibre headless API import/build; no secrets in bundle/source maps; dependency/license inventory and scan artifact.
- **Tasks:**
  - [ ] Implement the `chore/deps-<date>` pipeline for lockfile/pinned-image changes that always merges alone
  - [ ] Implement release dispatch with signed `vX.Y.Z` tags and a release manifest (tag, commit SHA, lockfile hash, container digests deployed)
  - [ ] Add secret scanning to CI and secret-reference-only environment handling
  - [ ] Produce the dependency/license/supply-chain inventory artifact for T-16
  - [ ] Document `release/vX.Y` hardening and `hotfix/vX.Y.z` expedited path with the same review gates

#### S-004 — Observability, health monitoring and operations runbooks
- **Epic:** EP-01
- **Release:** MVP (P0)
- **Covers:** WD-024 (monitoring/ops portion); FR-013, FR-014, FR-015 (ingestion/QC health monitoring), FR-049 (protected attachment operations), FR-065 (query/runtime health); NFR-004, NFR-005, NFR-009; T-08 (cache-failure alerting), T-12 (resource traces), T-14 (drill runbooks; execution in S-095)
- **Depends on:** S-003
- **Story:** As an on-call operator I want correlated logs, metrics and runbooks covering API latency, denied access, tile/export failures, sync conflicts, ingestion lag and notification delivery so that a user-visible failure can be traced to a request or job id and drilled without guesswork.
- **Acceptance criteria:**
  - User-visible failures correlate to request or job IDs; monitoring covers API latency, denied access, tile and export failures, sync conflicts, ingestion lag and notification delivery without logging secrets or sensitive content (NFR-009).
  - Logs and metrics are published without sensitive data; connection and render queues are capped.
  - Proposed monthly 99.5% service objective for public read journeys with separately monitored ingestion and notification health (NFR-004); stale readings remain visible with their timestamps rather than implying a live connection.
  - Runbooks exist for single NeoServer writer/restart, quiesced backup/restore, secret recovery, cache-refresh failure, telemetry/audit-loss alert and rollback (T-14 drill content, executed in S-095).
  - Recovery objectives (proposed RPO 1 hour, RTO 4 hours) are documented for DWRi approval and infrastructure validation (NFR-005).
- **Tasks:**
  - [ ] Wire central logs/metrics/traces for backend, gateway, NeoServer and workers with request/job-id correlation
  - [ ] Add dashboards and alerts for latency, denied access, tile/export failures, ingestion lag, notification delivery, audit loss
  - [ ] Write ops runbooks: single-writer restart, backup/restore, secret recovery, cache refresh failure, rollback
  - [ ] Cap connection/render queues and document saturation limits for load planning
  - [ ] Record SLO/RPO/RTO proposals with owners for ratification

### EP-02 Data Contracts, Fixtures & Database

Objective: the versioned contracts, deterministic fixture world and safe spatial publication/time-series model that every consumer and test relies on; the database platform is qualified before DDL executes.

#### S-010 — Versioned contracts and deterministic fixture world
- **Epic:** EP-02
- **Release:** MVP (P0)
- **Covers:** WD-002; FR-002, FR-010, FR-033, FR-040, FR-065, FR-066; NFR-008; T-01, T-04
- **Depends on:** S-001
- **Story:** As the contract and data engineer I want versioned OpenAPI/JSON schemas plus a deterministic fixture world so that every consumer builds against the same agreed hashes and every test run is reproducible.
- **Acceptance criteria:**
  - OpenAPI and JSON schemas are committed for catalog, sites, observations, revisions, entitlements and async jobs; consumers agree a contract hash.
  - Fixtures use a fixed clock and seed with two owners, two systems, one subgroup, public/private fields and missing/irregular series (WD-002).
  - The fixture world carries the plan's invariants: two engineers on different systems, one commissioner/deputy pair, one steward, one researcher, one anonymous user; six synthetic stations (public telemetry, public manual, restricted owner, internal diagnostic, inactive, proposed); one public and one private station sharing a display name; a restricted field/photo on a public station; zero, null, negative and out-of-range readings; irregular intervals, duplicate timestamps, an explicit gap; UTC timestamps spanning a Utah daylight-saving transition; observed vs estimated values; raw, provisional and best-available versions; two later corrections with different reasons; one source outage, one late arrival, one device replacement, two rating-curve periods; Utah coordinates plus a second latitude where a WMS axis-order error becomes obvious.
  - Golden calculations (unit conversions, cumulative volume from irregular flow samples, missing-interval behavior, aggregation boundaries, rating-curve effective periods) are recorded for measurement-owner approval, with missing data preserved as missing and documented tolerances.
  - Date-filter semantics (any data in period / complete coverage / available since) and unknown-vs-absent-vs-not-applicable distinctions are encoded in the schema vocabulary.
- **Tasks:**
  - [ ] Author OpenAPI operations and JSON schemas for catalog/sites/observations/revisions/entitlements/async jobs
  - [ ] Generate typed clients and contract hashes; define the `contract/vN` acceptance flow
  - [ ] Build the deterministic fixture generator (fixed clock + seed) implementing the full invariant list
  - [ ] Add golden-value files with derivation notes and tolerances for owner review
  - [ ] Wire T-01 contract validation and T-04 schema/constraint assertions into CI

#### S-011 — Database publication views and time-series read model
- **Epic:** EP-02
- **Release:** MVP (P0)
- **Covers:** WD-003; FR-002, FR-012, FR-033, FR-039, FR-040, FR-060, FR-066; NFR-007; T-04, T-06
- **Depends on:** S-010, S-012 (DDL execution gated on the platform inventory)
- **Story:** As the data engineer I want SELECT-only publication views over a revision-preserving time-series model so that NeoServer can never read a private field and raw observations stay immutable.
- **Acceptance criteria:**
  - Migrations create publication views with stable IDs and safe properties only; private fields are proven absent from view definitions and representative query plans are measured (WD-003).
  - Original-immutability triggers prevent raw edits; append-only revisions preserve actor, time, reason and qualifiers; the model retains revision time, observation time, calculation versions and decision references so FR-028/FR-044 lineage survives even though the full historical query UI is deferred.
  - Raw values cannot be edited; withdrawal is a separate tombstone operation retaining the original per the approved retention/visibility policy (FR-039); best-available measurements remain correctable indefinitely (FR-040).
  - Controlled vocabulary tables carry identifier, label, definition and lifecycle status; used terms cannot be deleted in a way that breaks historical records (FR-012) and fields link to dictionary definitions (FR-060).
  - T-04 evidence: migrations, publication safe fields, unique IDs, SQL constraints, indexes/query plans, transaction rollback and pool isolation on a disposable database.
- **Tasks:**
  - [ ] Author append-only migrations for sites/streams/observations/revisions/vocabulary/assignments/audit/outbox
  - [ ] Create SELECT-only publication views with a field allowlist; prove private fields absent (byte-level checks)
  - [ ] Add original-immutability triggers plus tombstone/withdrawal tables under a separate capability
  - [ ] Keep observation-time vs revision-time, calculation-version and decision-reference columns for future as-of queries
  - [ ] Add the T-04 integration suite on disposable PostgreSQL/PostGIS with query-plan review

#### S-012 — Database platform qualification (PostGIS/TimescaleDB inventory)
- **Epic:** EP-02
- **Release:** MVP (P0 gate)
- **Covers:** WD-003 (qualification criterion); ADR-05; DR-005, DR-009
- **Depends on:** S-001
- **Story:** As the DWRi platform owner I want the actual database service, versions and supported extensions inventoried before schema execution so that the time-series deployment path is chosen on facts rather than the assumption that managed Google Cloud PostgreSQL supports TimescaleDB.
- **Acceptance criteria:**
  - The read-only qualification queries (`SELECT version()`, `pg_extension`, `pg_available_extensions` for `postgis`/`timescaledb`) are executed by the DBA in the approved environment and the inventory is recorded.
  - An explicit path decision is made per ADR-05: retain a confirmed TimescaleDB host, or Cloud SQL PostgreSQL with PostGIS plus native partitioning/materialized summaries, or a separately approved compatible timeseries deployment.
  - No migration or infrastructure provisioning executes on the basis of the document alone; provider product, backup configuration and license eligibility are captured separately; HydroServer migration boundary stays an explicit dependency.
- **Tasks:**
  - [ ] Run the read-only qualification queries with the DBA and record results in the decision register
  - [ ] Resolve DR-009/ADR-05 with the chosen time-series path and evidence
  - [ ] Update database checks and deployment docs to the confirmed platform

### EP-03 Identity, Entitlements & Security

Objective: permissions are server-side capabilities plus scoped assignments evaluated per request; tokens never exceed account authority; an independent reviewer adversarially validates every control.

#### S-020 — Server identity, entitlements and the policy engine
- **Epic:** EP-03
- **Release:** MVP (P0)
- **Covers:** WD-004; FR-010, FR-011, FR-019, FR-031, FR-049, FR-064; NFR-006; T-02, T-03, T-08
- **Depends on:** S-010
- **Story:** As any authenticated persona I want the server to validate every read and mutation — including feature lookup, tiles, exports, audit history, batch operations, attachments, notification links and report downloads — against my current capability and object scope so that hiding a button or changing a browser role value never grants access.
- **Acceptance criteria:**
  - Institutional identities resolve to server grants; persona is separated from action, assignment and visibility; multiple roles evaluate per requested action and object scope; the API records the actor and denies missing or expired assignments (PRD permissions model).
  - Cross-owner, cross-system and direct-URL requests are denied for single and batch APIs, feature services, exports and attachments (FR-010); deputy statewide structural denial, revocation precedence and public-field projection are verified.
  - A steward's deputy delegation is explicit, time-bounded and audited; revocation affects the next authorized request; deactivated actors remain identifiable in history (FR-011).
  - Engineer variants (field, automation, regional, modeling) hold distinct capability subsets; a modeling assignment does not grant measurement correction, equipment configuration or raw-withdrawal authority.
  - T-02: parameterized role x action x scope x visibility allow/deny matrix; missing grants deny; deactivated users; unknown identifiers produce deterministic results.
- **Tasks:**
  - [ ] Implement `packages/policy` evaluation engine (capability + site/system/region/organization/report scopes)
  - [ ] Implement `services/api/src/auth` session/grant resolution with actor recording on every mutation
  - [ ] Encode deputy expiry, revocation precedence and historic-actor preservation
  - [ ] Build the T-02 parameterized policy-matrix suite and the T-03 API authorization suite
  - [ ] Publish the allow/deny matrix and negative-test catalog for independent review

#### S-021 — Researcher credentials and documented programmatic API
- **Epic:** EP-03
- **Release:** MVP (P1)
- **Covers:** WD-016; FR-063, FR-064, FR-065, FR-066; T-03, T-06, T-10, T-16
- **Depends on:** S-020, S-042
- **Story:** As Sarah the researcher I want to create, rotate and revoke scoped credentials and follow documented query examples so that I can build reproducible analyses without my token ever exceeding my account's current authority.
- **Acceptance criteria:**
  - An authenticated researcher creates a scoped credential and copies the secret at creation only; afterwards the label, scope, creation date, last use and revoke/rotate controls are displayed (one-time secret display; DR-006 ratification of the 90-day lifetime default pending security-owner approval).
  - Rotation and revocation are tested without creating a new account; revoked credentials fail on the next request; authority revocation cascades to tokens; secrets do not appear in logs or share URLs; a token cannot retrieve internal notes (FR-064).
  - Documentation shows site, time interval, property and processing-level queries with documented pagination, limits and error responses (FR-065); contract tests validate returned schema, authorization and date-boundary behavior.
  - No privileged token literals appear in bundles, shared URLs or logs (T-16 scan).
- **Tasks:**
  - [ ] Implement `services/api/src/tokens` issuance with one-time secret display and salted constant-time storage
  - [ ] Build the developer-access UI (create/rotate/revoke, last-use display)
  - [ ] Author `docs/api` examples (list-sites, observations, issue-token, create-export) with paging/limits/errors
  - [ ] Add token scope/rotation cases to T-03 and date-boundary contract tests
  - [ ] Sweep bundles, source maps and logs for token literals

#### S-022 — Independent security review and threat model
- **Epic:** EP-03
- **Release:** MVP (P0-P3, rolling)
- **Covers:** WD-021 (security component); NFR-006; T-03, T-08 (adversarial design)
- **Depends on:** S-020, S-030
- **Story:** As the agency security owner I want a reviewer who did not implement a control to adversarially validate entitlements, caches and protocols so that no control is ever approved by its own author.
- **Acceptance criteria:**
  - Threat review and adversarial validation are produced in `docs/security` and `tests/security` by the security-reviewer role, never the implementing agent.
  - Negative security tests call the service and each permitted protocol directly — collection listings, queryables, feature info, tiles, bulk downloads and cached variants; a hidden UI action or client-side filter never counts as a successful authorization test.
  - NeoServer workspace roles are demonstrated not to establish owner-specific entitlements; owner-specific data is tested through the domain backend and cohort/public map publications separately.
  - Private cache keys include effective authorization scope and data-visibility version (NFR-006).
  - Findings carry exploit steps, affected FR ids and severity; high-severity security or data-integrity findings block release until resolved.
- **Tasks:**
  - [ ] Produce the threat model covering auth, entitlements, spatial gateway, caches, exports, attachments, tokens
  - [ ] Run the adversarial matrix (altered ids/body, cohort cache poisoning, direct protocol URLs, CSRF, expiry/revocation)
  - [ ] Record findings with severity, exploit steps and affected FRs in the ticket evidence
  - [ ] Re-run failing probes after fixes; approval only by the non-implementer

### EP-04 Geospatial Services

Objective: qualify NeoServer's actual protocol behavior on a digest-pinned stack and front it with an authorized, allowlisted same-origin gateway (ADR-02, ADR-04, ADR-08, ADR-09, ADR-10).

#### S-030 — NeoServer protocol qualification and authorized geo-gateway
- **Epic:** EP-04
- **Release:** MVP (P0)
- **Covers:** WD-005; FR-001, FR-004, FR-010, FR-049, FR-065; ADR-02/04/08/09/10; T-03, T-05, T-08, T-14
- **Depends on:** S-011, S-020
- **Story:** As Donna the public user I want published sites served through a qualified, allowlisted geospatial gateway so that map tiles, features and downloads reveal no owner-specific or internal field in any supported format.
- **Acceptance criteria:**
  - NeoServer release/image digest is pinned; the actual OpenAPI, collections, TileJSON and capabilities are captured on the disposable stack (WD-005).
  - Features paging/bbox/datetime, explicit WFS GeoJSON (lon-first CRS:84), MVT source-layer and z/y/x order, and WMS CRS/axis correctness are proven at known Utah control points plus a second latitude where an axis-order error becomes obvious (T-05); tile z/y/x swap detection is machine-checked.
  - Denied cohorts reveal no content: admin-prefix denial, cohort 401s, and zero canary bytes across all captured artifacts; the browser never embeds a broad NeoServer or database credential (FR-010).
  - The gateway allowlists workspace, service, layer and operation, resolves the permitted projection, enforces limits, strips caller-supplied service credentials, forwards a narrowly scoped service credential, never proxies arbitrary URLs, and disables WFS mutations for portal routes.
  - External-write cache invalidation and one-active-store ownership are proven: stale-cache confirmation after external write, single-writer lock, backup-recovery with identical checksums, and a control tile byte-identical across restart and full teardown/reseed (T-08/T-14 groundwork).
  - Upstream defect behavior on the pinned digest (e.g., MVT layer version 1 vs 2) is recorded as an explicit accepted policy, never silently ignored.
- **Tasks:**
  - [ ] Stand up the digest-pinned disposable NeoServer stack and capture capabilities/OpenAPI snapshots
  - [ ] Implement `services/geo-gateway` allowlist, scoped-credential forwarding and same-origin tile templates
  - [ ] Execute the T-05 protocol probes (z/y/x order, WFS/WMS axis, paging, datetime filters)
  - [ ] Execute the T-08 cohort/canary cache probes including stale-cache-after-external-write
  - [ ] Record single-writer/backup drill evidence and pin findings/fixes (e.g., `fix/T-05-findings`) in the ticket

### EP-05 Public Web Experience

Objective: the account-free experience — persona shell, discovery and share URLs, charts and exports, honest summaries with a data dictionary, and natural-language requests translated into inspectable structured filters.

#### S-040 — GeoLibre persona shell and responsive application frame
- **Epic:** EP-05
- **Release:** MVP (P1)
- **Covers:** WD-006; FR-001, FR-004, FR-005, FR-009, FR-026, FR-058, FR-062; NFR-001, NFR-002; T-10, T-11, T-16
- **Depends on:** S-010
- **Story:** As any of the six personas I want a single responsive shell with my own entry point, an accessible map with a table fallback and a visible synthetic-data banner so that I can reach my workflows on desktop or a 360 CSS px phone, without an account where none is needed.
- **Acceptance criteria:**
  - The actual GeoLibre headless package with MapLibre is used (verified import/build, locked dependencies) with an explicit synthetic-data banner; all six persona entry points are present, preserving Donna's account-free starting node.
  - An anonymous user sees published sites on the map, switches approved topographic and imagery basemaps, and retains selection and filters; attribution remains visible (FR-001).
  - The map has a table alternative, loading/error/empty states and keyboard controls; charts provide clear labels and keyboard-accessible values (NFR-001, FR-062 groundwork).
  - Public browse and core entry tasks work at 360 CSS pixels without horizontal page scrolling; entry controls are usable by touch and keyboard (FR-026, NFR-002).
  - Personas are never serialized into URLs; restricted fields (e.g., gate codes) are absent from every public serialization and visible only to in-scope staff.
  - Build and policy/adapter tests pass on locked dependencies (WD-006).
- **Tasks:**
  - [ ] Scaffold `apps/web/src/shell` with persona routing, sign-in state and the synthetic-data banner
  - [ ] Integrate the real `@geolibre/map` + MapLibre with basemap switching and persistent attribution
  - [ ] Build the table fallback, loading/error/empty states and keyboard map controls
  - [ ] Implement the responsive 360 px layout with touch-friendly entry controls
  - [ ] Add projection tests proving restricted fields absent from every public serialization

#### S-041 — Public discovery, controlled filters and share URLs
- **Epic:** EP-05
- **Release:** MVP (P1)
- **Covers:** WD-007; FR-001, FR-002, FR-004, FR-008, FR-035, FR-060; T-01, T-05, T-10, T-11
- **Depends on:** S-030, S-040
- **Story:** As Donna I want account-free map discovery with governed metadata filters and a shareable URL so that I can find the sites I care about and send exactly what I see to a colleague.
- **Acceptance criteria:**
  - Account-free discovery supports approved controlled metadata filters and bounded retrieval (WD-007).
  - Fixture queries for each named dimension return the expected site IDs; AND across dimensions and multi-select OR within a dimension are documented; unknown telemetry differs from no telemetry (FR-002); unknown vocabulary values remain inspectable.
  - Engineering facets filter by installation date, year-round versus seasonal operation and WCAT use, with exact irrigation dates driving expected availability (FR-035); date filters state whether they select any-data-in-period, complete coverage, or availability-since (PRD filter semantics).
  - Opening a copied URL reproduces public filters, selected site, time interval and map extent; inaccessible objects are omitted with a clear message; no credentials or internal note text are encoded (FR-008).
  - Clicking a map site displays site/station identifiers, latest value, unit, observation time and freshness with a working detail link; missing readings render as unavailable rather than zero (FR-004).
  - Restricted-field leak scans and hostile share-URL input tests pass (WD-007 review).
- **Tasks:**
  - [ ] Implement `apps/web/src/features/discovery` filter UI across the governed dimensions (+ processing level, dataset type)
  - [ ] Implement share-state encode/decode with omission-with-notice and hostile-input tests
  - [ ] Build the quick site card popup wired to detail routes
  - [ ] Add installation/season/WCAT facets and explicit date-semantics filters
  - [ ] Add discovery-engine parity tests (reused later for AI-filter equivalence)

#### S-042 — Time-series charts, aggregation and comparisons
- **Epic:** EP-05
- **Release:** MVP (P1)
- **Covers:** WD-008 (charts portion); FR-005, FR-006, FR-007, FR-066; NFR-003, NFR-007; T-03, T-06, T-10, T-12
- **Depends on:** S-011, S-041
- **Story:** As Wiley the water user I want unit-labelled charts with daily, weekly, monthly and seasonal aggregation and site/year comparisons so that I can understand conditions without misreading a gap, a unit or a stale value.
- **Acceptance criteria:**
  - Golden unit/volume/aggregation results pass on irregular and gapped readings; the DST golden is hand-verifiable (e.g., 57,600 s x 23.825 cfs / 43,560 = 3812/121 acre-feet) and remains pending measurement-owner approval (WD-008).
  - Daily, weekly, monthly and seasonal views produce agreed fixture totals and averages; conversions state units, time zone, coverage and gap policy; incomplete coverage is flagged and never silently filled with zero (FR-006).
  - Users compare selected upstream and downstream sites and years using common units and aligned intervals; unavailable periods remain visible gaps; each series retains its source and quality legend (FR-007).
  - Charts show observation time separately from ingestion or revision time; the interface defaults to the site's agreed local zone and labels it (PRD presentation rules).
  - Processing-level selection (raw, provisional, reviewed, best-available) is governed; unavailable decision-time reconstruction links to the R2 capability rather than simulating it (FR-066).
  - Site profiles show authorized photos and location, available discharge or level series, quality status, reservoir storage where applicable, and a tabular alternative with the same selected data (FR-005, FR-062).
  - Bounded chart responses meet the p95 ≤ 2 s interactive target under the agreed profile (NFR-003).
- **Tasks:**
  - [ ] Implement `services/api/src/series` with downsampling, coverage metadata and unit conversion
  - [ ] Implement aggregation views (daily/weekly/monthly/seasonal) with documented gap/coverage policy
  - [ ] Build the comparison UI (sites/years, common units, aligned intervals, per-series quality legend)
  - [ ] Add golden tests covering DST transition, irregular intervals, zero-vs-null distinction
  - [ ] Document derivations (e.g., `golden.ts`) and submit values to the measurement owner for approval

#### S-043 — CSV exports and asynchronous export jobs
- **Epic:** EP-05
- **Release:** MVP (P1)
- **Covers:** WD-008 (export portion); FR-063; NFR-003; T-12
- **Depends on:** S-011, S-041
- **Story:** As Sarah I want single-site and multi-site CSV exports with full provenance columns and visible job status for large requests so that my datasets are reproducible and never silently truncated.
- **Acceptance criteria:**
  - CSV exports contain only eligible rows and include site, stream, timestamps, units, processing level, qualifiers and source identifiers (FR-063).
  - Multi-site data uses documented ordering; large requests run as bounded asynchronous jobs with visible status rather than silent truncation (FR-063, NFR-003).
  - Exports enforce the same grants as the chart APIs (WD-008); served files apply CSV formula neutralization.
- **Tasks:**
  - [ ] Implement `services/api/src/exports` CSV builder with provenance columns and documented ordering
  - [ ] Add the async job queue with status polling for large exports
  - [ ] Enforce scope checks identical to series APIs and add grant-parity tests
  - [ ] Add formula-neutralization safeguards for served files

#### S-044 — Public overview, performance indicators and data dictionary
- **Epic:** EP-05
- **Release:** MVP (P3)
- **Covers:** WD-018; FR-058, FR-059, FR-060, FR-061, FR-062; T-03, T-06, T-10, T-11, T-12
- **Depends on:** S-041, S-042
- **Story:** As Donna the policy reader I want an intelligible statewide overview with honest indicators and a maintained data dictionary so that I can quote numbers knowing exactly what each numerator and denominator means.
- **Acceptance criteria:**
  - Anonymous users start with an intelligible overview and can drill into site metadata; telemetry and reviewed-data indicators state numerator, denominator, period and update time, with output measures distinguished from outcomes (FR-058).
  - The measured-versus-estimated indicator distinguishes measured, estimated and unknown source classifications, reports its denominator and period, and reconciles to the selected authorized source records without presenting old audit percentages as live results (FR-059); the unknown bucket stays distinct.
  - Space/time summaries lead with permitted statewide or selected-system totals, use clear units, denominators and dates, reconcile exactly to the approved golden data (same totals as S-042), and avoid double-counting a flow measured at multiple points or mixing incompatible units (FR-061).
  - The data dictionary exposes definitions of fields, units, processing levels, qualifiers, lineage and dataset relationships; a vocabulary change publishes a corresponding version or effective date and links API fields to the same definitions (FR-060).
  - Charts use clear labels and keyboard-accessible values, avoid color-only meanings, use a limited color-blind-aware palette and zero-based bar axes, and offer a readable table with the same selected values (FR-062).
- **Tasks:**
  - [ ] Implement `services/api/src/summaries` (statewide/selected-system totals, indicator numerators/denominators/periods)
  - [ ] Build the overview UI with drill-down and indicator metadata display
  - [ ] Implement data-dictionary views wired to vocabulary tables with version/effective dates
  - [ ] Reconcile summary totals to the WD-008 goldens with view-model deep-equal tests
  - [ ] Apply the accessible chart standards (labels, tables, palette, zero-based axes)

#### S-045 — Natural-language filter proposal layer
- **Epic:** EP-05
- **Release:** MVP (P1)
- **Covers:** WD-019; FR-003; NFR-010; T-01, T-03, T-13
- **Depends on:** S-010, S-041
- **Story:** As Donna I want to describe what I am looking for in plain language and then inspect the proposed structured filters before anything executes so that convenience never becomes unreviewable automation.
- **Acceptance criteria:**
  - The three metadata examples on source PDF p. 15 produce the same site IDs as the equivalent manual filters (equivalence tested against the real discovery engine).
  - Users inspect and edit the proposed filter set before and after execution; unsupported computed questions (rapidly declining flow, current reservoir release) return a clear alternative without fabricated values and remain Discovery scope.
  - AI output is only a validated controlled-field AST (FilterSetProposal runtime invariants); no prompt, model output or generated SQL broadens scope or executes arbitrary queries; the injection corpus has no channel into filter values.
  - An approved provider and state-policy review precede external processing; a deterministic manual fallback remains available (NFR-010).
- **Tasks:**
  - [ ] Implement `services/api/src/ai/filter-parser` producing a validated FilterSetProposal AST
  - [ ] Build the inspect/edit proposal UI reusing the manual filter components
  - [ ] Curate the `fixtures/ai` evaluation set (equivalence, clarification, injection corpus)
  - [ ] Run the T-13 equivalence/security/denial suites and document the deterministic fallback

#### S-046 — Unified account, favorites and saved preferences
- **Epic:** EP-05
- **Release:** MVP (P1/P2)
- **Covers:** WD-006, WD-009 (account/favorites portion); FR-009, FR-052
- **Depends on:** S-040, S-020
- **Story:** As Wiley I want one sign-in that carries my favorites and display preferences across all dashboard modules and sessions so that the dashboard feels like mine without favoriting a site ever granting me authority over it.
- **Acceptance criteria:**
  - One authenticated session supports the dashboard modules; favorites and display preferences survive sign-out and return; anonymous exploration remains possible (FR-009).
  - A registered user favorites any published site, opens its charts and permitted photos, and manages personal subscriptions; removing a favorite or subscription persists and does not alter a site's authority or ownership (FR-052).
  - Assignment changes take effect in API and cached views (WD-009).
- **Tasks:**
  - [ ] Implement the account/session module with preference persistence
  - [ ] Build My Sites favorites and the personal subscription management entry point
  - [ ] Add preference/favorite persistence tests across sign-out and return
  - [ ] Add a policy test proving favoriting confers no edit or ownership rights

### EP-06 Operational Workflows

Objective: assigned workspaces and the full measurement lifecycle — entry and imports, site setup, corrections and audit, visits and attachments, QC diagnostics, stewardship, reports, alerts and digests.

#### S-060 — Assigned operational workspaces and site context
- **Epic:** EP-06
- **Release:** MVP (P2)
- **Covers:** WD-009; FR-019, FR-025 (subscription entry points), FR-031 (edit entry), FR-032, FR-035, FR-036, FR-037, FR-038, FR-052 (workspace favorites); T-02, T-03, T-10
- **Depends on:** S-020, S-042
- **Story:** As Cody or Fatima I want a manage workspace listing only my currently assigned systems and sites, with useful site context, so that my morning review starts from my scope instead of a statewide search.
- **Acceptance criteria:**
  - The manage tab lists only currently assigned systems and sites; a separate public explorer remains available; changing a requested system ID cannot reveal another system's private operational records (FR-019); deputy boundary instants, cross-system denial and revocation-at-grant-version are verified.
  - Commissioner/deputy and engineer variants see assigned scope with permitted public browsing and useful site diagnostics (WD-009).
  - Authorized engineer views expose available discharge, level, voltage and other relevant streams; internal diagnostics do not become public merely because a site is public (FR-036).
  - Site detail identifies provider, surface or groundwater source, storage or natural-flow context, combined flows and available user or rights associations; unresolved links are explicitly unverified rather than inferred (FR-037).
  - Users record a known issue with affected stream and time interval, status and visibility; affected charts and exports carry the permitted issue context and resolution history (FR-038).
  - A site may be assigned to governed groups and subgroups; filter results update consistently; the API prevents unauthorized membership changes and orphaned subgroup references (FR-032).
  - Preferences, favorites and known issues persist per account (WD-009).
- **Tasks:**
  - [ ] Implement `apps/web/src/features/operations` workspace (commissioner/deputy and engineer variants)
  - [ ] Add site-context panels: diagnostics streams, water source/rights, known issues, groups/subgroups
  - [ ] Wire the workspace policy mirror to the real engine with cross-checked decisions
  - [ ] Add deputy-boundary, cross-system denial and revocation tests

#### S-061 — Manual measurement entry and bulk paste import
- **Epic:** EP-06
- **Release:** MVP (P2)
- **Covers:** WD-010 (readings portion); FR-020, FR-021, FR-022 (entry/correction entry); T-03, T-06, T-07, T-10
- **Depends on:** S-011, S-060
- **Story:** As Cody I want to type or paste a full season of readings with exact cell-level feedback and a documented import mode so that a large entry session never creates duplicates or loses my valid rows.
- **Acceptance criteria:**
  - Users enter observation time, value, unit, stream and optional note for an assigned site; validation identifies the offending field, preserves valid inputs, and returns a saved record identifier on success (FR-020).
  - A user pastes or uploads at least a full 366-day fixture for several sites, previews mapping and row errors, chooses the documented atomic or partial import mode, and retries without creating duplicate readings (FR-021); the leap-year golden produces exact valid/error/duplicate counts (e.g., 363/3/0) and idempotent replay.
  - Preview and validation cover headers, units and timezone; concurrency checks prevent silent overwrites (WD-010).
  - T-07 evidence: full year of daily rows, headers/units/dates, duplicate submission, invalid-cell preview, atomic accepted-batch behavior, CSV formula neutralization, exact row error results.
- **Tasks:**
  - [ ] Implement `services/api/src/workflows/readings` manual entry with field-level validation
  - [ ] Build the staged bulk paste/upload previewer with row errors and atomic/partial modes
  - [ ] Add idempotency keys and concurrency checks preventing repeated imports and silent overwrites
  - [ ] Add the 366-row leap-year golden, replay and retry-without-duplicates tests

#### S-062 — Site setup, datastreams, thresholds and metadata history
- **Epic:** EP-06
- **Release:** MVP (P2)
- **Covers:** WD-010 (sites portion); FR-023, FR-031, FR-033, FR-034; T-03, T-06, T-10
- **Depends on:** S-011, S-060
- **Story:** As Fatima I want to create and edit sites, set up effective-dated measurement streams and versioned capacity thresholds so that old readings keep their original device and method context and out-of-range values are flagged without color-only cues.
- **Acceptance criteria:**
  - Authorized engineers create or edit site name, type, capacities, location, elevation, system and photos within their scope; required metadata and coordinate validation run before save (FR-031).
  - Engineers select governed properties and sensors; changing a measurement setup creates a distinct effective-dated stream or setup record so old readings retain the original device and method context (FR-033); new devices retain stream history (WD-010).
  - Out-of-range fixture values trigger labelled map and series indicators; thresholds are scoped and versioned and the UI uses a symbol or text as well as color (FR-034).
  - Authorized edits to name, location, elevation, capacities, system or photographs record actor, time and before-and-after values; history remains after actor deactivation (FR-023).
- **Tasks:**
  - [ ] Implement `services/api/src/workflows/sites` create/edit with validation and audit fields
  - [ ] Add effective-dated datastream/setup records on device or method change
  - [ ] Implement scoped, versioned capacity thresholds with labelled (non-color-only) indicators
  - [ ] Build metadata history views and tests for before/after values and actor deactivation

#### S-063 — Corrections, raw withdrawal and point/interval audit
- **Epic:** EP-06
- **Release:** MVP (P2)
- **Covers:** WD-011; FR-022, FR-039, FR-040, FR-041, FR-042, FR-066; NFR-007; T-03, T-06, T-08
- **Depends on:** S-011, S-020
- **Story:** As Fatima or Cody I want to correct a point or interval with governed qualifiers and a reason while every prior value stays inspectable so that a correction preserves the evidence behind earlier decisions.
- **Acceptance criteria:**
  - An assigned reviewer corrects one point or a selected interval, supplies a reason and qualifiers, and advances an allowed processing level; the raw observation and prior revisions remain distinguishable; concurrent changes produce a reviewable conflict, not an overwrite (FR-022); optimistic conflicts return a reviewable failure.
  - Raw readings cannot be edited; a separately approved automation capability withdraws an erroneous point with reason and audit evidence, retaining the original under the approved retention and visibility policy (FR-039); frozen raw rows and idempotency different-body 409 verified.
  - A permitted engineer corrects a prior-year best-available value after year end without overwriting raw input or prior revisions; correction does not mutate an already finalized accounting transaction or report; no year-end lock (FR-040).
  - Corrections support multiple governed qualifiers (e.g., interpolation, ice-affected) plus justification text; stored qualifiers and reason appear in permitted point history and exports (FR-041).
  - Selecting a point or flagged interval displays all authorized revisions with actor, timestamp, original and replacement value, qualifiers and reason — including a revision later superseded by another edit (FR-042).
  - Changes trigger the authorized publication cache refresh via the outbox (WD-011).
- **Tasks:**
  - [ ] Implement `services/api/src/workflows/revisions` (correct point/interval, processing-level advance, qualifiers/reason)
  - [ ] Implement the separate withdraw-raw capability with tombstone retention of the original
  - [ ] Build `apps/web/src/features/quality-history` point/interval audit views
  - [ ] Add optimistic-lock conflict and idempotency tests
  - [ ] Wire outbox-driven publication cache refresh on every change

#### S-064 — Visits, maintenance, inspections and categorized attachments
- **Epic:** EP-06
- **Release:** MVP (P2)
- **Covers:** WD-012; FR-026 (online entry portion), FR-046, FR-049; NFR-002, NFR-007; T-03, T-10, T-11
- **Depends on:** S-061, S-063
- **Story:** As Fatima I want to record visits and maintenance with categorized photographs whose visibility is enforced server-side so that field evidence is durable and internal wiring details never leak into public payloads, caches, exports or reports.
- **Acceptance criteria:**
  - A visit records site, author, visit time, type, measurement or maintenance actions and attachments; last-checked and last-rated dates are structured queryable fields; visit history survives equipment replacement (FR-046).
  - Users upload several categorized site or asset photos and mark permitted visibility; public APIs, thumbnails, exports and report generation cannot retrieve an internal photo, note, gate code or wiring detail (FR-049) — the visibility wall is verified at every accessor including export manifests, with a byte-level canary sweep; wiring notes are internal by server-side policy.
  - Network errors preserve an explicit unsent form state; full reload-safe offline synchronization remains the separate R2 story (WD-012 boundary).
  - Mobile entry remains usable by touch and keyboard (FR-026 online portion).
- **Tasks:**
  - [ ] Implement `services/api/src/workflows/visits` with structured last-checked/last-rated fields
  - [ ] Implement attachment storage with categories and server-enforced visibility policy
  - [ ] Build the visits UI with categorized photo upload and unsent-state preservation
  - [ ] Add canary sweep tests across APIs, thumbnails, exports and report generation

#### S-065 — Automated QC rules and diagnostics views
- **Epic:** EP-06
- **Release:** MVP (P3)
- **Covers:** WD-013; FR-015, FR-016 (violation surfacing), FR-034, FR-036, FR-038; T-06, T-10, T-15
- **Depends on:** S-063, S-067
- **Story:** As Diego I want versioned QC rules I can test outside production before promoting them so that bad data is detected without a rule change ever hiding who authored or approved it.
- **Acceptance criteria:**
  - Range including voltage, rate-of-change, persistence, missing-data and zero-value rules detect known fixture violations; each rule stores author and update time, runs independently, and can be tested before promotion (FR-015); editor and version are recorded.
  - One failing monitoring task does not stop the others; voltage and known issues are discoverable in diagnostics (WD-013).
  - Users choose system or stream scope and hourly, twice-daily, daily or weekly cadence; each digest contains only authorized violating streams, supports violation-type sorting, and links to the matching context (FR-016; delivery engine in S-068).
  - Out-of-range values trigger labelled map and series indicators (FR-034); engineering diagnostics expose authorized streams without becoming public (FR-036); known-issue context is carried into affected views (FR-038).
- **Tasks:**
  - [ ] Implement `services/api/src/workflows/qc` rule engine (five rule types, independent execution)
  - [ ] Add rule versioning with author/time and the test-before-promotion flow
  - [ ] Build `apps/web/src/features/quality` diagnostics views (violations, voltage, known issues)
  - [ ] Add fixture-violation tests with reviewed expected outcomes

#### S-066 — Steward governance: assignments, vocabulary and distribution systems
- **Epic:** EP-06
- **Release:** MVP (P3)
- **Covers:** WD-014 (governance portion); FR-011, FR-012, FR-023; T-02, T-03, T-10, T-15
- **Depends on:** S-011, S-020, S-060
- **Story:** As Diego I want sole, audited authority over controlled vocabulary, distribution systems and scoped assignments so that governance changes never break a historical record.
- **Acceptance criteria:**
  - A steward assigns systems or sites to an engineer or commissioner, delegates a deputy with an expiry, and revokes access; deactivated actors remain identifiable in history and revocation affects the next authorized request (FR-011).
  - Only an authorized steward creates or retires distribution systems and global sensors, properties, units, qualifiers and processing levels; used terms cannot be deleted in a way that breaks historical records (FR-012); retired-term history preservation is verified.
  - Steward-only vocabulary, system and assignment changes preserve history and validation (WD-014).
  - Site metadata changes record actor, time and before/after values, surviving actor deactivation (FR-023, shared with S-062).
  - The steward must resolve the measurement-method-type versus method-type vocabulary overlap before the API contract is finalized (PRD filter semantics; DR-002).
- **Tasks:**
  - [ ] Implement `services/api/src/workflows/stewardship` assignment/delegation/revocation flows
  - [ ] Implement vocabulary and distribution-system lifecycle with retirement instead of deletion
  - [ ] Build stewardship UI surfaces (users and assignments, vocabulary, distribution systems)
  - [ ] Add retired-term history, deputy expiry and steward-only authorization tests

#### S-067 — Provider ingestion setup and connection health
- **Epic:** EP-06
- **Release:** MVP (P3)
- **Covers:** WD-014 (ingestion/health portion); FR-013, FR-014; T-15 (digest rules); WD-024 monitoring adjacency
- **Depends on:** S-011, S-020, S-060
- **Story:** As Diego I want to register provider ingestion configurations and see failed connections distinguished from failed tasks in a weekday digest so that operations can fix the right thing without reviewing every station manually.
- **Acceptance criteria:**
  - A steward registers a provider and site ingestion configuration, validates required parameters, and tests a connection in staging; engineer requests can be submitted but cannot bypass the approved ownership policy (FR-013; DR-003).
  - Health distinguishes a failed connection from failed tasks; a configurable weekday digest links to failed tasks first, and a Monday digest includes the weekend interval without duplicate incident counts (FR-014) — verified with fixed-clock tests in the agency timezone.
  - Monitoring existing ingestion remains distinct from implementing a new ingestion platform (WD-014 boundary).
- **Tasks:**
  - [ ] Implement provider/site ingestion registration with parameter validation and a staging connection test
  - [ ] Implement the connection-versus-task health model
  - [ ] Build the weekday digest scheduler with weekend catch-up and dedupe
  - [ ] Add fixed-clock digest tests (Monday weekend interval, no duplicate incidents)

#### S-068 — Scoped alerts, subscriptions and digest schedules
- **Epic:** EP-06
- **Release:** MVP (P3)
- **Covers:** WD-015; FR-014 (cadence rules), FR-016, FR-025, FR-052 (personal subscriptions); T-03, T-15
- **Depends on:** S-060, S-065, S-066, S-067
- **Story:** As any subscribed user I want alerts scoped to what I am currently authorized to see, at my chosen cadence, so that a notification can never become a data leak.
- **Acceptance criteria:**
  - Subscriptions distinguish new sites, site edits, no signal and threshold violations; a test event reaches only eligible subscribers and the alert link repeats the authorization check (FR-025).
  - Subscriptions enforce current grants and support agreed threshold and event types with dedupe (WD-015).
  - Fixed-clock tests prove the configured agency timezone, hourly/daily/weekly frequencies and Monday weekend catch-up; no real messages are sent by tests (WD-015).
  - QC violation digests contain only authorized violating streams, support violation-type sorting, and link to matching context (FR-016).
- **Tasks:**
  - [ ] Implement `services/api/src/workflows/notifications` subscription and evaluation engine
  - [ ] Re-check eligibility at send time and on alert-link follow
  - [ ] Build `apps/web/src/features/notifications` subscription management UI
  - [ ] Add fixed-clock schedule, dedupe and no-real-send tests

#### S-069 — Annual distribution and multi-station reports
- **Epic:** EP-06
- **Release:** MVP (P3)
- **Covers:** WD-025; FR-024; T-03, T-06, T-10, T-15
- **Depends on:** S-042, S-061, S-063
- **Story:** As Cody I want to generate an annual distribution report for my assigned system that reconciles exactly to the selected dataset so that delivered-water accounting is defensible.
- **Acceptance criteria:**
  - For a selected authorized system and period, the report includes daily flow or volume, quality and coverage notes, configurable chart sizing, generation time and data version; exported PDF values reconcile to the selected dataset (FR-024).
  - The report labels the extraction time and source revisions; repeat generation is deterministic for the same inputs (WD-025).
  - Indefinitely immutable accounting/finalization and flexible-period behavior remain the separate R2 story and are stated as out of scope here (WD-025 boundary).
- **Tasks:**
  - [ ] Implement `services/api/src/workflows/distribution-report` generation with documented formulas, dates and processing context
  - [ ] Build the report UI (system/period selection, chart sizing) and PDF export
  - [ ] Record extraction time and data version on every artifact
  - [ ] Add determinism and PDF-to-dataset reconciliation tests

### EP-07 Support, Analytics & Onboarding

Objective: reproducible support context, consented analytics, and role-relevant onboarding/training that feeds observed failures back into the backlog.

#### S-070 — In-app help, feedback and support context
- **Epic:** EP-07
- **Release:** MVP (P3)
- **Covers:** WD-020 (support portion); FR-008, FR-018; T-01, T-10, T-11
- **Depends on:** S-041, S-060
- **Story:** As any user I want to report a problem with my exact dashboard state attached — and nothing secret — so that Diego receives reproducible context without gaining access to restricted records.
- **Acceptance criteria:**
  - A user can report a problem with a shareable state link; the steward receives reproducible permitted context and can assign a priority without embedded secrets or granted access to restricted records (FR-018).
  - Hostile share-state redaction is verified: the URL cannot smuggle tokens, internal note text or private identifiers (FR-008 adjacency; WD-020 review).
  - Role-specific guidance surfaces the right help per persona (WD-020).
- **Tasks:**
  - [ ] Implement `services/api/src/support` feedback intake with redacted state capture
  - [ ] Build `apps/web/src/features/help` role-specific guidance and the feedback widget
  - [ ] Add hostile-state redaction tests
  - [ ] Build the steward-side triage view with priority assignment

#### S-071 — Consented usage and operational analytics
- **Epic:** EP-07
- **Release:** MVP (P3)
- **Covers:** WD-020, WD-014 (analytics portion); FR-017
- **Depends on:** S-041, S-060
- **Story:** As the product owner I want approved analytics on visitors, users and downloads by day, month and year, with consent controls, so that adoption is measurable without exposing credentials, sensitive query content or internal records to third-party telemetry.
- **Acceptance criteria:**
  - Approved analytics report visitor, user and download counts by day, month and year (FR-017).
  - Credentials, sensitive query content and internal records are excluded from third-party telemetry (FR-017).
  - Analytics privacy, consent and retention are agreed with the agency owner; consent withdrawal includes deletion of consented data (WD-020 pending-owner decisions closed).
- **Tasks:**
  - [ ] Implement consented analytics events with the agreed retention policy
  - [ ] Build day/month/year reporting views for operations and product owners
  - [ ] Add the consent withdrawal-with-deletion flow and tests
  - [ ] Close the pending privacy/retention decisions with the agency owner and record the outcome

#### S-072 — Onboarding tours and commissioner training
- **Epic:** EP-07
- **Release:** MVP (P3)
- **Covers:** WD-020 (onboarding portion); FR-068
- **Depends on:** S-041, S-060
- **Story:** As a new commissioner or first-time visitor I want a short role-relevant tour I can stop from auto-returning, plus task-based commissioner training, so that I can become independent quickly.
- **Acceptance criteria:**
  - A user can complete a short role-relevant tour and disable its automatic return (FR-068).
  - Commissioners receive task-based training; observed pilot task failures feed a prioritized backlog with named owners (FR-068).
  - Training tasks exist for public and operational users (WD-020).
- **Tasks:**
  - [ ] Build the tour component with role variants and dismiss/auto-return persistence
  - [ ] Author training task guides for public and operational users in `docs/training`
  - [ ] Wire pilot-failure capture into the prioritized backlog with named owners

### EP-08 Test Automation & Quality

Objective: the T-01..T-16 verification matrix as independent CI/staging suites with their evidence requirements. These suites are built by the QA/accessibility and security-reviewer roles on `test/<T-ID>-<slug>` branches (never containing feature code) and are reproduced independently before any feature task closes.

#### S-080 — Requirements/contract and database integration suites (T-01, T-04)
- **Epic:** EP-08
- **Release:** MVP
- **Covers:** T-01, T-04 (suite owner); WD-001, WD-002, WD-003 (evidence hooks)
- **Depends on:** S-010, S-011
- **Story:** As the QA agent I want the T-01 traceability report and the T-04 PostgreSQL integration suite runnable from CI on a disposable database so that contract or migration drift fails the build instead of the release.
- **Acceptance criteria:**
  - T-01: all FR ids resolve; source, priority and status are explicit; OpenAPI and schemas validate; mock/live provider conformance is checked. Evidence: traceability report, schema diff, contract hash.
  - T-04: migrations, publication safe fields, unique IDs, SQL constraints, indexes/query plans, transaction rollback and pool isolation. Evidence: disposable database logs and query-plan review.
- **Tasks:**
  - [ ] Stand up `tests/` suites on `test/T-01-*` and `test/T-04-*` branches (no feature code)
  - [ ] Generate the FR-to-test traceability report from the requirement registry and backlog
  - [ ] Run T-04 against an ephemeral branch-named schema and archive plan-review artifacts

#### S-081 — Policy unit and API authorization suites (T-02, T-03)
- **Epic:** EP-08
- **Release:** MVP
- **Covers:** T-02, T-03 (suite owner); NFR-006
- **Depends on:** S-020
- **Story:** As the security reviewer I want machine-run allow/deny matrices for policy and API requests so that any entitlement regression is a red test, not a discovered leak.
- **Acceptance criteria:**
  - T-02: role x action x scope x visibility; missing grants deny; engineer variants; deactivated users; unknown identifiers — parameterized deterministic allow/deny results.
  - T-03: anonymous, owner A/B, commissioner system A/B, engineer A/B, steward; altered IDs and body; CSRF; session expiry/revocation; token scope/rotation — HTTP status and redacted response assertions.
- **Tasks:**
  - [ ] Build the parameterized policy-matrix runner against `packages/policy`
  - [ ] Build the API cohort fixtures for all persona/owner combinations
  - [ ] Add redaction assertions (no sensitive echo in any denial response)

#### S-082 — Spatial protocol and cache/privacy suites (T-05, T-08)
- **Epic:** EP-08
- **Release:** MVP
- **Covers:** T-05, T-08 (suite owner)
- **Depends on:** S-030
- **Story:** As the QA agent I want repeatable protocol and cache-isolation probes against the pinned NeoServer stack so that a format, axis or cache regression is caught before any cohort sees another cohort's bytes.
- **Acceptance criteria:**
  - T-05: Features paging/bbox/datetime; WFS explicit GeoJSON; WMS GetMap/GetFeatureInfo; MVT decode; z/y/x, source-layer and CRS/axis control points — capabilities/OpenAPI snapshots and known coordinate checks.
  - T-08: owner/cohort A warms a tile/feature/export; B and public cannot receive it; a publish revision invalidates the external-write stale cache; revoked grants are blocked even with warm caches — decoded PBF/GeoJSON and cache/header assertions.
- **Tasks:**
  - [ ] Build the protocol probe harness (paging, bbox, datetime, axis order, MVT decode)
  - [ ] Run the canary-bytes sweep across all captured artifacts
  - [ ] Automate the stale-cache-after-external-write invalidation check

#### S-083 — Data/revisions and bulk input suites (T-06, T-07)
- **Epic:** EP-08
- **Release:** MVP
- **Covers:** T-06, T-07 (suite owner); NFR-007
- **Depends on:** S-061, S-063
- **Story:** As the QA agent I want golden-value revision chains and exact bulk-import error results so that scientific correctness and import safety are proven, not asserted.
- **Acceptance criteria:**
  - T-06: raw immutable; authorized tombstone retains history; correction reason/qualifiers; optimistic lock; indefinite best-available revisions; stable finalized report snapshot — golden values, before/after revisions and audit chain.
  - T-07: full year of daily rows; headers/units/dates; duplicate submission; invalid cell preview; atomic accepted batch behavior; CSV formula neutralization — import fixture and exact row error results.
- **Tasks:**
  - [ ] Build audit-chain assertions across correction, withdrawal and supersession
  - [ ] Build the import fixture with exact row-error expectations
  - [ ] Add the CSV formula-injection corpus for served files

#### S-084 — Persona E2E and accessibility automation (T-10, T-11)
- **Epic:** EP-08
- **Release:** MVP
- **Covers:** T-10, T-11 (suite owner); NFR-001 (automation portion)
- **Depends on:** S-021, S-041, S-046, S-060, S-061, S-063, S-064, S-066, S-069
- **Story:** As the QA agent I want scripted six-persona browser journeys and automated accessibility scans so that every release candidate proves the primary journeys end to end.
- **Acceptance criteria:**
  - T-10: public discover; steward assign/review; commissioner bulk entry/report; engineer correct/visit; owner favorite/report; scientist filtered export — Playwright run/video with role-specific assertions.
  - T-11 automation portion: automated axe scan with no critical findings; keyboard map alternatives and table; focus order/dialog return; non-color quality meaning; contrast; 200% zoom; responsive layout (the manual record completes in S-092).
- **Tasks:**
  - [ ] Build the six-persona Playwright journeys with recorded videos
  - [ ] Integrate axe scans into CI
  - [ ] Automate 200% zoom and responsive-layout checks

#### S-085 — Performance and dependency/supply-chain suites (T-12, T-16)
- **Epic:** EP-08
- **Release:** MVP
- **Covers:** T-12, T-16 (suite owner); NFR-003, NFR-008
- **Depends on:** S-003, S-042, S-043, S-044
- **Story:** As the QA agent I want a repeatable load harness and supply-chain checks with a full environment record so that a performance or dependency pass can serve as a regression baseline.
- **Acceptance criteria:**
  - T-12: cold/warm map, first usable page, bbox pan, chart and export queues under stated load; DB saturation and rendering limits — repeatable test profile, p50/p95 and resource traces.
  - A pass without the environment record (commits/image digests, database extension versions, browser versions, CPU/network profile, fixture seed and clock) is insufficient for a regression baseline (plan requirement).
  - T-16: locked versions/integrity; actual GeoLibre headless API import/build; no secrets in bundle/source maps; dependency/license findings — lockfile, build, inventory and scan artifacts.
- **Tasks:**
  - [ ] Build the load harness against the reference profile (10,000 features, 100 sessions, 10 Mbps/100 ms)
  - [ ] Capture p50/p95 and resource traces with the environment record
  - [ ] Produce the supply-chain inventory and secret-scan artifacts

#### S-086 — AI behavior and alerts/reports suites (T-13, T-15)
- **Epic:** EP-08
- **Release:** MVP
- **Covers:** T-13, T-15 (suite owner); NFR-010
- **Depends on:** S-045, S-068
- **Story:** As the QA agent I want curated AI evaluation sets and fixed-clock alert/report checks so that neither the language layer nor the scheduler can silently change behavior.
- **Acceptance criteria:**
  - T-13: NLP/manual query equivalence; inspectable filters; unknown terms require clarification; prompt injection cannot expand grants; no generated SQL execution; transcription remains editable draft — curated evaluation set, expected validated AST and denial tests.
  - T-15: threshold/rate/persistence/missing/zero checks; independent failure isolation; digest timezone/weekend rules; ownership; report validation and immutable submitted PDF — fixed-clock schedules, event dedupe, approved report fixture.
- **Tasks:**
  - [ ] Build the curated AI evaluation runner (equivalence + denial corpora)
  - [ ] Build fixed-clock alert scheduler tests (timezone, weekend catch-up, dedupe)
  - [ ] Validate the report fixture including submitted-PDF immutability

#### S-087 — Offline sync suite (T-09)
- **Epic:** EP-08
- **Release:** R2
- **Covers:** T-09 (suite owner); NFR-002, NFR-007 (R2 portions)
- **Depends on:** S-100
- **Story:** As the QA agent I want an offline-sync suite that injects crashes, conflicts and revocations so that "no dropped edits" is a tested invariant of the R2 release, not a hope.
- **Acceptance criteria:**
  - T-09: capture offline; reload; attachments; reconnect; idempotency; crash after server commit before acknowledgement; conflicting edit; expired/revoked grant; visible retry/quota failure; sign-out cleanup — browser storage and server event sequence, no duplicates.
  - The R2 portions of T-06/T-13/T-15 qualify the separate R2 gate; they do not block MVP acceptance (plan release policy).
- **Tasks:**
  - [ ] Build the browser-storage inspection harness
  - [ ] Add crash injection (commit-before-ack) and conflict scenarios
  - [ ] Add revoked-grant, quota and sign-out-cleanup assertions

### EP-09 UAT & Release Readiness

Objective: human acceptance. Task-based persona UAT (including the 60% commissioner pilot target), the manual accessibility record, the staging performance run, the adversarial pass, the operational drills, and the go/no-go decision. Full execution scripts for these stories are in section 4.

#### S-090 — Public, water-user and researcher persona UAT (Donna, Wiley, Sarah)
- **Epic:** EP-09
- **Release:** MVP
- **Covers:** WD-022 (UAT portion); FR-058, FR-068 (task-based UAT/training acceptance); T-10 (persona journey confirmation)
- **Depends on:** S-021, S-044, S-046, S-070, S-072
- **Story:** As representative public/policy, water-user and researcher participants we want to complete our real tasks unaided so that the product is accepted on evidence rather than demonstration.
- **Acceptance criteria:**
  - Representative Donna, Wiley and Sarah participants complete the section-4 persona scripts unaided; results recorded per task with completion times.
  - Donna's account-free path is verified end-to-end: no login prompt appears on any public step.
  - Observed task failures feed a prioritized backlog with named owners (FR-068).
- **Tasks:**
  - [ ] Recruit representative participants and agree baseline completion times
  - [ ] Run the Donna, Wiley and Sarah scripts (section 4.1-4.3) and record results
  - [ ] File observed failures as prioritized backlog items with named owners

#### S-091 — Operational persona UAT and commissioner pilot (Cody, Fatima variants, Diego)
- **Epic:** EP-09
- **Release:** MVP
- **Covers:** WD-022 (UAT/report acceptance); FR-024 (report acceptance), FR-068; the 60% commissioner pilot target; T-10
- **Depends on:** S-061, S-062, S-063, S-064, S-066, S-069, S-072
- **Story:** As commissioners of varying technical confidence, engineer variants and the data steward we want to complete our operational tasks independently so that the first pilot proves usable, not just functional.
- **Acceptance criteria:**
  - A representative pilot cohort and baseline completion times are agreed before claiming any usability improvement (PRD outcome discipline).
  - At least 60% of the approximately 55 commissioners and deputies complete the agreed core tasks without facilitator intervention; the source's "about 30" approximation is not used as an exact acceptance count.
  - Commissioner and data owners accept the MVP annual distribution report as part of UAT (WD-022).
  - Engineer variants (field, automation, regional, modeling) and the steward complete their section-4 scripts; deputy delegation is exercised with expiry.
  - Observed failures feed the prioritized backlog with named owners.
- **Tasks:**
  - [ ] Agree the cohort, core tasks and baseline times with the product owner
  - [ ] Run the unaided commissioner/deputy pilot and compute the completion percentage
  - [ ] Run the Fatima-variant and Diego scripts (section 4.5-4.6)
  - [ ] Obtain data-owner acceptance of the annual distribution report
  - [ ] File observed failures as prioritized backlog items with named owners

#### S-092 — Manual accessibility review
- **Epic:** EP-09
- **Release:** MVP
- **Covers:** NFR-001; T-11 (manual portion); WD-021
- **Depends on:** S-084
- **Story:** As an accessibility reviewer I want to complete the keyboard, screen-reader and zoom review myself so that acceptance does not rest on automated scans alone.
- **Acceptance criteria:**
  - Keyboard and screen-reader review covers map alternatives, forms, error messages, dialogs, charts and reports (NFR-001); automated scans alone are insufficient acceptance.
  - The manual record covers: keyboard map alternatives and table; focus order and dialog return; screen-reader labels/live status; non-color quality meaning; contrast; 200% zoom; responsive layout (T-11).
  - The target is the DWRi-approved current accessibility standard, with WCAG 2.2 AA as the proposed implementation target.
  - Release target met: no critical automated findings plus successful manual task completion.
- **Tasks:**
  - [ ] Complete the keyboard-only pass across all journeys
  - [ ] Complete the screen-reader pass (map alternatives, forms, errors, dialogs, charts, reports)
  - [ ] Complete 200% zoom and responsive-layout checks
  - [ ] Record findings and open remediation tickets before go/no-go

#### S-093 — Performance profile run
- **Epic:** EP-09
- **Release:** MVP
- **Covers:** NFR-003; T-12 (staging execution); WD-021
- **Depends on:** S-085
- **Story:** As the platform owner I want a measured staging run against the agreed load profile so that the proposed latency targets become approved release acceptance, not aspiration.
- **Acceptance criteria:**
  - Under the agreed staging profile: p95 structured filter and site-detail API response at most 2 seconds; core UI becomes usable within 3 seconds on the agreed field-network profile; complex exports run asynchronously with visible status (NFR-003).
  - The plan's narrower provisional targets are measured and reported: first usable page and useful map within 3 seconds p95; bounded chart within 2 seconds p95; initial bbox feature response within 1 second p95; no dropped edits in repeated interrupted sync (R2).
  - Reference profile: 10,000 visible station features, 100 concurrent sessions, a four-core desktop, a midrange phone, 10 Mbps / 100 ms RTT.
  - The staging load profile is set after the real site count, observation volume, geographic extent and user concurrency are known (DR-008/DR-018); the run records p50/p95, resource traces and the full environment record.
- **Tasks:**
  - [ ] Stage the synthetic dataset and profile (seed, clock, digests recorded)
  - [ ] Execute cold/warm map, first usable page, bbox pan, chart and export-queue scenarios
  - [ ] Record p50/p95 and resource traces and compare against the targets
  - [ ] Publish the profile report for owner conversion into approved acceptance

#### S-094 — Security and adversarial acceptance pass
- **Epic:** EP-09
- **Release:** MVP
- **Covers:** NFR-006; WD-021 (security criterion); T-03, T-08 (adversarial execution)
- **Depends on:** S-022, S-082
- **Story:** As the agency security owner I want the final adversarial pass run against the release candidate by someone who did not build it so that production authorization rests on reproduced, not self-reported, evidence.
- **Acceptance criteria:**
  - A different security reviewer and tester reproduce approved MVP behavior from the contracts; direct multi-format, cache and isolation attacks yield no restricted content (WD-021).
  - Least-privilege service identities, encrypted transport, managed secrets, validated tokens and session expiry, audit protection, tested object access and rate limits are verified (NFR-006).
  - No unresolved high-severity security or data-integrity defects remain (release criterion).
- **Tasks:**
  - [ ] Re-run the full adversarial matrix against the staging release candidate
  - [ ] Verify rate limits, session expiry/revocation and audit protection
  - [ ] Assemble the evidence pack with findings, severities and closures

#### S-095 — Operational drills: backup/restore, rollback, single-writer restart
- **Epic:** EP-09
- **Release:** MVP
- **Covers:** NFR-005; T-14 (execution); WD-021, WD-024
- **Depends on:** S-004, S-030
- **Story:** As the operations owner I want rehearsed recovery drills with timed evidence so that recoverability is a demonstrated capability before pilot acceptance.
- **Acceptance criteria:**
  - A staging restore proves recovery of database revisions, attachments, grants and NeoServer configuration before pilot acceptance (NFR-005); drill log, restored checksum and timed recovery recorded (T-14).
  - Single NeoServer writer, restart, quiesced backup/restore, secret recovery, cache refresh failure, telemetry/audit-loss alert and rollback are exercised (T-14).
  - The rollback exercise completes from a release tag with named on-call owners (release criteria).
  - Measured recovery is compared to the proposed RPO 1 hour / RTO 4 hours objectives for DWRi approval.
- **Tasks:**
  - [ ] Execute the quiesced backup and restore with checksum verification
  - [ ] Execute the fenced single-writer restart drill
  - [ ] Execute the rollback exercise from a signed release tag
  - [ ] Record timed recovery versus RPO/RTO and publish the drill log

#### S-096 — MVP system qualification and release go/no-go
- **Epic:** EP-09
- **Release:** MVP
- **Covers:** WD-021, WD-022; FR-010, FR-024, FR-026, FR-049, FR-062, FR-063, FR-065, FR-068; NFR-001, NFR-002, NFR-003, NFR-004, NFR-005, NFR-006, NFR-007, NFR-008, NFR-009, NFR-010; T-01, T-02, T-03, T-04, T-05, T-06, T-07, T-08, T-10, T-11, T-12, T-13, T-14, T-15, T-16 (whole-catalog gate)
- **Depends on:** S-030, S-042, S-043, S-045, S-061, S-062, S-063, S-064, S-065, S-066, S-067, S-068, S-069, S-021, S-044, S-070, S-071, S-072, S-003, S-004, S-080, S-081, S-082, S-083, S-084, S-085, S-086, S-090, S-091, S-092, S-093, S-094, S-095
- **Story:** As the DWRi product owner I want one qualification story that assembles every piece of MVP evidence and forces a named go/no-go decision so that "released" means accepted, recoverable and authorized.
- **Acceptance criteria:**
  - Complete MVP browser, accessibility, scientific calculation, performance, restore and dependency evidence exists with exact environment revisions (WD-021).
  - A different security reviewer and tester reproduce approved MVP behavior from contracts; direct multi-format/cache/isolation attacks yield no restricted content (WD-021).
  - R2 offline/supplier/finalized-accounting acceptance is not required for MVP; those capabilities are documented as planned and unimplemented (WD-021 boundary).
  - Commissioner and data owners accept the MVP annual distribution report and representative task-based UAT (WD-022).
  - Named humans accept MVP scope, formulas, security, accessibility, operations and rollback; production change is separately authorized (WD-022).
  - Deferred R2/Discovery features are visible in release notes and do not block MVP qualification (WD-022).
  - The section-4 go/no-go checklist is fully executed with recorded decisions, including the MVP evidence set: requirement-to-test report, scoped permission matrix, API and import contract results, unit and time-boundary reconciliation, representative browser and accessibility results, and persona task observations (PRD acceptance section).
- **Tasks:**
  - [ ] Assemble the requirement-to-test report and evidence index
  - [ ] Collect named owner sign-offs (scope, formulas, security, accessibility, operations, rollback)
  - [ ] Run the go/no-go checklist and record the decision
  - [ ] Publish release notes including deferred R2/Discovery scope
  - [ ] Record the production-change authorization as a separate explicit decision

### EP-10 Deferred R2 & Discovery

Objective: the separately scoped later work. R2: durable offline capture and conflict handling, expanded assets and inspection workflow, rating and shift governance, decision snapshots and historical reconstruction, WCAT integration, supplier reporting (ADR-11, ADR-12). Discovery: FR-050/FR-067 contract definition. None of these block MVP qualification.

#### S-100 — Offline capture, outbox sync and asset transfers (R2)
- **Epic:** EP-10
- **Release:** R2
- **Covers:** WD-012-R2; FR-027, FR-048; NFR-002, NFR-007; T-03, T-09, T-10, T-11
- **Depends on:** S-061, S-062, S-063, S-064
- **Story:** As Fatima in the field I want airplane-mode drafts of readings, visits, photos and audio that synchronize exactly once after reconnection so that lost connectivity never means lost work or duplicated records.
- **Acceptance criteria:**
  - In airplane mode, authorized users save reading, visit, photo and audio drafts; after reconnection each draft syncs once, shows status, and routes conflicts or revoked access for resolution without silent loss (FR-027).
  - Expired/revoked grants, conflicts, quota and commit-before-ack crash are exercised; no silent overwrite or lost edits; sign-out cleans account-specific cached data under the approved policy (WD-012-R2).
  - Readings, visits and categorized attachments survive offline reload and synchronize exactly once after recovery (WD-012-R2).
  - Equipment records preserve make, model, identifier and serial-number evidence; transferring an asset closes the old site association and opens a dated new association without moving historical inspections to the wrong site (FR-048).
- **Tasks:**
  - [ ] Implement `apps/web/src/offline` durable capture and outbox
  - [ ] Implement `services/api/src/workflows/sync` with idempotency and conflict routing
  - [ ] Build the asset-transfer workflow with dated site associations and preserved evidence
  - [ ] Automate the T-09 scenarios (crash injection, revocation, sign-out cleanup)

#### S-101 — Versioned rating curves and shifts (R2)
- **Epic:** EP-10
- **Release:** R2
- **Covers:** WD-011-R2; FR-045; T-03, T-06, T-08
- **Depends on:** S-063
- **Story:** As Fatima I want effective-dated rating curves, regressions and shifts with recorded approval so that a revised curve never erases the basis of earlier conversions or inspection evidence.
- **Acceptance criteria:**
  - Effective-dated curve and shift versions retain author, approval state and provenance; computed values identify the version used; a revised curve does not erase earlier conversions or inspection evidence (FR-045).
  - Version effective rating-curve/regression and shift periods use approved data-owner formulas and provenance; prior curves remain available; edited curves cannot silently rewrite raw readings or finalized report snapshots (WD-011-R2).
- **Tasks:**
  - [ ] Implement the rating-curve/shift version model with effective dating
  - [ ] Implement the conversion engine tagging every computed value with its curve version
  - [ ] Build the approval/provenance workflow with recorded owner
  - [ ] Add regression tests proving prior-curve availability and raw/finalized immutability

#### S-102 — Recurrent quality trends and curve diagnostics (R2)
- **Epic:** EP-10
- **Release:** R2
- **Covers:** WD-013-R2; FR-043, FR-045; T-06, T-10, T-15
- **Depends on:** S-065, S-101
- **Story:** As Diego I want charts and a sortable table of repeated flags and corrections so that chronic sites get fixed instead of repeatedly re-corrected.
- **Acceptance criteria:**
  - Users see chart markers and a sortable table of repeated flags or corrections by site and period; counts reconcile to the selected issue and revision records without counting one incident repeatedly (FR-043).
  - Summaries are graphical and tabular without exposing restricted sites; aggregates reconcile to reviewed fixture records (WD-013-R2).
  - Approved rating/shift periods relate to diagnostic history (FR-045 adjacency).
- **Tasks:**
  - [ ] Implement `services/api/src/quality-trends` aggregation with incident dedupe
  - [ ] Build the trend UI (chart markers plus sortable table)
  - [ ] Add reconciliation tests against fixture issue/revision records
  - [ ] Link curve/shift periods into the diagnostic history views

#### S-103 — Water supplier reporting and boundary workflows (R2)
- **Epic:** EP-10
- **Release:** R2
- **Covers:** WD-017; FR-053, FR-054, FR-055, FR-056, FR-057; T-03, T-07, T-10, T-15
- **Depends on:** S-061, S-062, S-063, S-064
- **Story:** As a verified water supplier I want to inspect my system, propose boundary changes and submit a versioned annual use report so that reporting is one traceable workflow instead of email attachments.
- **Acceptance criteria:**
  - A verified supplier sees assigned area sources, purchases, wholesale and returns plus historical discharge comparisons; an account assigned to a different supplier cannot retrieve the system's private report or boundary workflow (FR-053).
  - An assigned supplier proposes a boundary change with reason, views approval status, downloads an authorized boundary file, and comments by section; a proposal never replaces the approved boundary before the defined approval action (FR-054).
  - Forms cover culinary use, source, purchase, wholesale and returns inventories, source peak demand and secondary use; missing and unreasonable values produce field-level text messages and an error summary in addition to color (FR-055).
  - Manual entry and documented file import populate the same validated reporting model; a preview displays mapped units and periods, identifies invalid rows, and avoids duplicate values when a file is retried (FR-056).
  - A valid assigned report transitions from draft to submitted, records submitter and version, and produces a PDF matching that submitted version; resubmission or review changes follow an approved state machine; retry cannot create a duplicate submission (FR-057).
  - Supplier sees permitted system/history; the Water Use Manager dashboard remains future work (S1 pp. 21-22 boundary).
- **Tasks:**
  - [ ] Build the supplier workspace with verified-organization assignment checks
  - [ ] Implement the boundary proposal, section comments and approval-status workflow
  - [ ] Implement the category forms with field-level messages and an error summary
  - [ ] Implement file import preview with mapped units/periods and duplicate-safe retry
  - [ ] Implement the draft-to-submitted state machine and the stable submitted PDF

#### S-104 — Decision snapshots, finalized accounting and flexible periods (R2)
- **Epic:** EP-10
- **Release:** R2
- **Covers:** WD-025-R2; FR-028, FR-029, FR-030; T-03, T-06, T-10, T-15
- **Depends on:** S-069, S-063
- **Story:** As Cody I want saved distribution decisions to reference the exact values they used and finalized records to be immutable so that later corrections create new versions instead of rewriting history.
- **Acceptance criteria:**
  - A saved distribution decision references the exact observation or revision versions used; later corrections do not change those referenced values or the decision's recorded calculation inputs (FR-028).
  - Finalizing an accounting transaction or report prevents in-place modification or deletion; an authorized correction creates a linked reversal or superseding version while measurement corrections remain separately possible (FR-029).
  - A configured season or custom water year, including a mid-month boundary, selects the correct fixture observations; supplemental use is compared only against approved inputs and is labelled advisory until accounting semantics are approved (FR-030).
  - Finalize/reopen authority and concurrency behavior are approved with the data owner (WD-025-R2).
- **Tasks:**
  - [ ] Implement `services/api/src/workflows/accounting-snapshots` with exact revision references
  - [ ] Implement finalize/immutability and the linked supersede workflow
  - [ ] Implement the flexible period selector including mid-month boundaries
  - [ ] Record data-owner approval of finalize/reopen authority and concurrency rules

#### S-105 — As-of reconstruction, voice notes and WCAT integration (R2)
- **Epic:** EP-10
- **Release:** R2
- **Covers:** WD-023-R2; FR-044, FR-047, FR-051; NFR-010 adjacency; T-01, T-03, T-06, T-13
- **Depends on:** S-096, S-063, S-021
- **Story:** As Sarah or Fatima I want bounded as-of reconstruction, reviewable voice transcription and an agreed WCAT exchange so that historical questions can be answered honestly and external integrations stay governed.
- **Acceptance criteria:**
  - Given a supported as-of timestamp, a query returns the revisions known at that timestamp and distinguishes observation time from revision time; exports state the as-of basis and reproduce the fixture result after later corrections (FR-044).
  - A user records a voice note and optionally requests an approved transcription or summary; the user reviews it before saving; original media follows retention policy; no AI text changes measurements or inspection status automatically (FR-047).
  - An agreed adapter exchanges identified stream and model inputs or results with WCAT; sync is repeatable, reports changed inputs, and preserves observed versus calculated versus modeled distinctions and authoritative ownership (FR-051).
  - Bounded as-of reconstruction, editable voice transcription and WCAT contracts are agreed before implementation; approved provider/privacy review precedes sending internal text or audio externally; grants and deterministic manual fallback are tested (WD-023-R2).
- **Tasks:**
  - [ ] Implement the as-of query and export with stated basis
  - [ ] Implement voice capture with user-reviewed transcription drafts
  - [ ] Implement the agreed WCAT adapter with change reporting
  - [ ] Record privacy/provider approvals and add manual-fallback tests

#### S-106 — Independent R2 qualification and acceptance
- **Epic:** EP-10
- **Release:** R2
- **Covers:** WD-026; FR-027, FR-028, FR-029, FR-030, FR-043, FR-044, FR-045, FR-047, FR-048, FR-051, FR-053, FR-054, FR-055, FR-056, FR-057; T-03, T-06, T-09, T-10, T-11, T-13, T-14, T-15
- **Depends on:** S-096, S-100, S-101, S-102, S-103, S-104, S-105
- **Story:** As the QA agent I want to independently prove the approved R2 capabilities and regression-test MVP so that the second release is held to the same gate as the first.
- **Acceptance criteria:**
  - Approved R2 offline/conflict/revocation behavior, snapshots, rating history, supplier and extension behavior are independently proven (WD-026).
  - Data-owner, security and privacy acceptance is obtained for every enabled R2 capability; MVP is regression-tested; no unapproved Discovery dependency exists (WD-026).
- **Tasks:**
  - [ ] Build `tests/r2` suites covering the R2 requirement set
  - [ ] Collect data-owner/security/privacy acceptance records
  - [ ] Run the MVP regression suite
  - [ ] Publish R2 release notes and verification evidence

#### S-107 — Discovery: advanced field configuration and right-network/modeling integrations
- **Epic:** EP-10
- **Release:** Discovery
- **Covers:** WD-023; FR-050, FR-067; T-01, T-03, T-06, T-13
- **Depends on:** S-096
- **Story:** As the product owner I want separately contracted definitions for advanced field configuration and right-network/modeling integrations so that Discovery work never leaks unscoped obligations into a release.
- **Acceptance criteria:**
  - A scoped follow-on design defines equipment addresses, communications links, custom ingestion headers and optional access points; approved fixtures demonstrate correct access and parsing before any such fields are exposed (FR-050).
  - Separate contracts define rights-to-field links, change-application effective history, OpenET comparison, depletion, apportionment and machine-readable transaction schedules; approved fixtures distinguish measured inputs from modeled results (FR-067).
  - A separate approved delivery scope is created; no initial production gate depends on unresolved Discovery (WD-023).
- **Tasks:**
  - [ ] Author the `docs/extensions` contracts defining ownership, authoritative inputs, semantics and acceptance
  - [ ] Build fixture demonstrations for access/parsing and measured-vs-modeled distinction
  - [ ] Define the separately accepted scope with the accountable owners
  - [ ] Record the scope acceptance decision

## 4. UAT & testing stories

These are the EP-08/EP-09 stories listed with their full execution content: S-080..S-087 (test suites, summarized — full definitions in section 3), S-090..S-096 (UAT and release readiness, expanded below into the scripts each story executes). Every checkbox below is an execution step of the named story, recorded as evidence on that story.

### 4.0 Test suite index (EP-08)

| Story | Suites | Evidence required |
| --- | --- | --- |
| S-080 | T-01 requirements/contract, T-04 PostgreSQL integration | Traceability report, schema diff, contract hash; disposable DB logs and query-plan review |
| S-081 | T-02 policy unit, T-03 API authorization | Parameterized deterministic allow/deny results; HTTP status and redacted response assertions |
| S-082 | T-05 protocol/spatial, T-08 cache/privacy | Capabilities/OpenAPI snapshots, known coordinate checks; decoded PBF/GeoJSON and cache/header assertions |
| S-083 | T-06 data/revisions, T-07 bulk inputs | Golden values, before/after revisions, audit chain; import fixture with exact row error results |
| S-084 | T-10 persona E2E, T-11 accessibility (automation) | Playwright run/video with role-specific assertions; axe scan with no critical findings |
| S-085 | T-12 performance, T-16 dependency/supply chain | Repeatable profile, p50/p95 and resource traces with environment record; lockfile, build, inventory and scan artifacts |
| S-086 | T-13 AI behavior, T-15 alerts/reports | Curated evaluation set, expected validated AST, denial tests; fixed-clock schedules, event dedupe, approved report fixture |
| S-087 | T-09 offline sync (R2) | Browser storage and server event sequence, no duplicates |

### 4.1 Donna — public user / policy reader (S-090)

- [ ] Open the site with no sign-in: an intelligible public overview loads with statewide indicators; each indicator states numerator, denominator, period and update time (FR-058)
- [ ] Explore the map; switch between approved topographic and imagery basemaps; filters and selection persist; attribution remains visible (FR-001)
- [ ] Apply manual metadata filters: verify AND across dimensions and multi-select OR within one dimension; confirm unknown telemetry presents differently from no telemetry (FR-002)
- [ ] Type one of the three source natural-language examples; inspect and edit the proposed filter set before applying; confirm the result matches the manual-filter site IDs; try an unsupported computed question and receive a clear alternative (FR-003)
- [ ] Click a map site: quick card shows identifiers, latest value, unit, observation time and freshness; open the detail link (FR-004)
- [ ] Open a site profile: charts, quality status, reservoir storage where applicable, and the tabular alternative with the same selected data (FR-005)
- [ ] View dynamic space/time summaries for a selected area and period; confirm totals reconcile with the exported data (FR-061)
- [ ] Copy the share URL and open it in a private window: filters, selected site, interval and extent reproduce; no credentials are encoded (FR-008)
- [ ] Look up processing-level and qualifier definitions in the data dictionary; confirm the definition page carries a version/effective date (FR-060, FR-066)
- [ ] Complete the short public tour and disable its automatic return (FR-068)
- [ ] Report a problem with the share-state link attached (FR-018)

### 4.2 Wiley — registered water user (S-090)

- [ ] Sign in once; move between public explorer and My Sites without re-authenticating (FR-009)
- [ ] Favorite a published site from the public explorer; open its charts and permitted photos (FR-052)
- [ ] Manage a personal alert subscription (new site, no signal, threshold) and confirm a test event arrives (FR-052, FR-025)
- [ ] Remove the favorite; confirm it stays removed after sign-out/in and that no edit affordance appeared on the site (FR-052)
- [ ] Browse and complete a core entry/read task at 360 CSS px width with no horizontal page scrolling (FR-026)
- [ ] Submit feedback with the current dashboard state attached (FR-018)

### 4.3 Sarah — researcher / consultant (S-090)

- [ ] Sign in; create a scoped programmatic credential; copy the secret at creation (FR-064)
- [ ] Rotate the credential; revoke the old one; confirm the revoked credential fails on its next request (FR-064)
- [ ] Follow documented examples querying site, time interval, property and processing level with pagination and limits; provoke and read a documented error response (FR-065)
- [ ] Select a processing basis (raw/provisional/reviewed/best-available) and note the governed distinctions and permitted issue context (FR-066)
- [ ] Export a single-site CSV with provenance columns; start a large multi-site export and watch its job status rather than a truncated download (FR-063)
- [ ] Reconcile the CSV totals against the on-screen summaries for the same selection (FR-061)

### 4.4 Cody — commissioner / deputy (S-091, includes the pilot target)

- [ ] Sign in; the manage tab lists only currently assigned systems/sites; open the separate public explorer (FR-019)
- [ ] Morning review: see recent flow and freshness for all assigned sites; compare upstream and downstream conditions (FR-007, FR-019)
- [ ] Enter one reading with a deliberate error; confirm the offending field is identified and valid inputs survive; correct and save; receive the record identifier (FR-020)
- [ ] Paste a full 366-day multi-site batch; preview row errors; choose the documented atomic or partial mode; retry and confirm no duplicate readings (FR-021)
- [ ] Correct one point and one interval with reason and qualifiers; advance the processing level; open the audit history showing the raw value and prior revisions (FR-022, FR-042)
- [ ] Trigger a concurrent edit from a second session; confirm the conflict is reviewable and nothing is overwritten (FR-022)
- [ ] Generate the annual distribution report for an assigned system; verify generation time, data version and PDF reconciliation (FR-024)
- [ ] Deputy scenario: delegation is time-bounded, audited, and expires (FR-011)
- [ ] Pilot measurement: without facilitator intervention, complete the agreed core tasks; the pilot passes when at least 60% of the approximately 55 commissioners and deputies succeed unaided (cohort and baseline times agreed first; "about 30" is not an acceptance count)

### 4.5 Fatima — engineer variants (field / automation / regional / modeling) (S-091)

- [ ] Open an assigned site; check battery voltage and available diagnostic streams; internal diagnostics stay non-public (FR-036)
- [ ] Review and record a known issue with affected stream, interval, status and visibility; see it carried on charts/exports (FR-038)
- [ ] Edit site metadata (name, elevation, capacities); confirm validation and the recorded before/after history (FR-031, FR-023)
- [ ] Change the measurement setup; confirm a new effective-dated stream and that old readings keep their device/method context (FR-033)
- [ ] Record a visit with maintenance actions and categorized photos; mark one photo internal and confirm it never appears publicly (FR-046, FR-049)
- [ ] Apply a justified best-available correction to a prior-year value; confirm raw and prior revisions remain distinguishable (FR-040, FR-041)
- [ ] Select the corrected point; read the full revision list including a superseded revision (FR-042)
- [ ] Automation variant only: withdraw an erroneous raw point with reason; confirm the retained original under the approved policy (FR-039)
- [ ] Modeling variant only: confirm no correction, equipment-configuration or raw-withdrawal affordances without the corresponding capability
- [ ] R2 script (after S-100): airplane-mode capture of reading/visit/photo drafts; reconnect; each syncs once with visible status; revoked authority blocks submission (FR-027)

### 4.6 Diego — data steward (S-091)

- [ ] Assign a system to an engineer and a commissioner; delegate a deputy with expiry; revoke one grant; confirm denial on the next request and the deactivated actor still identifiable in history (FR-011)
- [ ] Create a distribution system and vocabulary terms; retire a used term; confirm history is preserved, not broken (FR-012)
- [ ] Register a provider ingestion configuration; validate parameters; run the staging connection test; submit an engineer request that cannot bypass ownership policy (FR-013)
- [ ] Open the connection health digest; confirm failed connections are distinguished from failed tasks; a Monday digest includes the weekend without duplicate incidents (FR-014)
- [ ] Update a QC rule version; test it outside production; promote it with a recorded owner (FR-015)
- [ ] Review a QC violation digest; confirm it contains only authorized streams, sorts by violation type, and links to matching context (FR-016)
- [ ] Open the analytics report; confirm visitor/user/download counts by day, month and year and no sensitive content in telemetry (FR-017)
- [ ] Triage a user-reported problem; confirm reproducible permitted context and priority assignment with no secret material (FR-018)

### 4.7 Manual accessibility review (S-092)

- [ ] Keyboard-only: complete public discovery, site profile, entry form and report generation without a pointer; map alternatives/table reachable (T-11, NFR-001)
- [ ] Focus order is logical; focus returns to the invoking control after every dialog closes
- [ ] Screen reader: labels and live status announced for filters, charts, error messages, jobs; quality states voiced with text, not color alone
- [ ] Contrast passes the approved standard; the palette is color-blind-aware; bar axes are zero-based
- [ ] 200% zoom: no loss of content or function; no horizontal page scrolling at 360 CSS px
- [ ] Record: automated axe results plus the manual record; automated scans alone are insufficient acceptance

### 4.8 Performance profile run (S-093)

- [ ] Stage the synthetic dataset and record the environment (commits/digests, extension versions, browser versions, CPU/network profile, fixture seed, clock)
- [ ] Run under the reference profile: 10,000 visible station features, 100 concurrent sessions, 10 Mbps / 100 ms RTT, four-core desktop and midrange phone
- [ ] Measure p95: structured filter and site-detail API at most 2 seconds; core UI usable within 3 seconds; complex exports asynchronous with visible status (NFR-003)
- [ ] Measure the plan's provisional targets: first usable page and useful map within 3 seconds; bounded chart within 2 seconds; initial bbox features within 1 second
- [ ] Record p50/p95 and resource traces; check DB saturation and rendering limits; publish for owner conversion into approved acceptance

### 4.9 Security / adversarial pass (S-094)

- [ ] Call every permitted protocol directly (collection listings, queryables, feature info, tiles, bulk downloads, cached variants) as denied cohorts; expect zero restricted bytes (T-08)
- [ ] Alter ids and request bodies across single and batch APIs, exports and attachments; expect denials with redacted responses (T-03)
- [ ] Attempt CSRF, session reuse after expiry, and token use after revocation/rotation; expect failure
- [ ] Warm caches as cohort A; request as cohort B and anonymous; expect no cross-cohort content; verify publish-revision cache invalidation
- [ ] Verify rate limits, least-privilege service identities, encrypted transport and audit protection (NFR-006)
- [ ] Confirm no unresolved high-severity security or data-integrity findings remain

### 4.10 Operational drills (S-095)

- [ ] Quiesced backup and restore; verify restored checksums match (database revisions, attachments, grants, NeoServer configuration) (NFR-005, T-14)
- [ ] Single NeoServer writer drill: fenced restart; confirm one-active-store ownership and byte-identical control tile across restart
- [ ] Secret recovery: restore service operation from the secret manager without exposing material
- [ ] Cache refresh failure injection: confirm alerting and eventual consistency without serving stale restricted content
- [ ] Telemetry/audit-loss alert fires when deliberately broken
- [ ] Rollback exercise from a signed release tag with timed recovery compared to RPO 1 h / RTO 4 h proposals

### 4.11 Release go/no-go checklist (S-096)

- [ ] Approved scope and data policy
- [ ] Pinned dependencies and images; release manifest records tag, commit SHA, lockfile hash and container digests actually deployed
- [ ] Critical-path and negative tests passed (T-01..T-08, T-10..T-16 results attached)
- [ ] No unresolved high-severity security or data-integrity defects
- [ ] Reviewed accessibility results (automated plus the S-092 manual record)
- [ ] Rehearsed backup/restore and rollback (S-095 drill log)
- [ ] Named on-call owners
- [ ] Approved production change (separate explicit authorization)
- [ ] Rollout order: read-only/public functions first, then a limited authorized operational cohort
- [ ] Monitoring live for denied requests, stale data, import/sync failures, audit loss and database pressure
- [ ] Stop condition acknowledged: stop rollout when authorization, data integrity or recoverability evidence fails
- [ ] MVP evidence set assembled: requirement-to-test report, scoped permission matrix, API and import contract results, unit and time-boundary reconciliation, representative browser and accessibility results, persona task observations
- [ ] Production-readiness additions verified: staging identity integration, migration reconciliation, backup restore evidence, monitoring ownership, rollback exercise
- [ ] Deferred R2/Discovery features listed in release notes and not blocking qualification
- [ ] Decision recorded: GO or NO-GO with named accountable owners and date

## 5. Traceability appendix

### 5.1 Functional requirements FR-001..FR-068 → stories

| FR | Stories | | FR | Stories | | FR | Stories |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FR-001 | S-001, S-030, S-040, S-041 | | FR-024 | S-069, S-091, S-096 | | FR-047 | S-105 |
| FR-002 | S-010, S-011, S-041 | | FR-025 | S-060, S-068 | | FR-048 | S-100 |
| FR-003 | S-045 | | FR-026 | S-040, S-064, S-096 | | FR-049 | S-004, S-020, S-030, S-064, S-096 |
| FR-004 | S-030, S-040, S-041 | | FR-027 | S-100, S-106 | | FR-050 | S-001, S-107 |
| FR-005 | S-040, S-042 | | FR-028 | S-104, S-106 | | FR-051 | S-001, S-105, S-106 |
| FR-006 | S-042 | | FR-029 | S-104, S-106 | | FR-052 | S-046, S-060, S-068 |
| FR-007 | S-042 | | FR-030 | S-104, S-106 | | FR-053 | S-103, S-106 |
| FR-008 | S-041, S-070 | | FR-031 | S-020, S-060, S-062 | | FR-054 | S-103, S-106 |
| FR-009 | S-040, S-046 | | FR-032 | S-060 | | FR-055 | S-103, S-106 |
| FR-010 | S-001, S-010, S-020, S-030, S-096 | | FR-033 | S-010, S-011, S-062 | | FR-056 | S-103, S-106 |
| FR-011 | S-020, S-066 | | FR-034 | S-062, S-065 | | FR-057 | S-103, S-106 |
| FR-012 | S-011, S-066 | | FR-035 | S-041, S-060 | | FR-058 | S-040, S-044, S-090 |
| FR-013 | S-004, S-067 | | FR-036 | S-060, S-065 | | FR-059 | S-044 |
| FR-014 | S-004, S-067, S-068 | | FR-037 | S-060 | | FR-060 | S-011, S-041, S-044 |
| FR-015 | S-004, S-065 | | FR-038 | S-060, S-065 | | FR-061 | S-044 |
| FR-016 | S-065, S-068 | | FR-039 | S-001, S-011, S-063 | | FR-062 | S-040, S-044, S-096 |
| FR-017 | S-071 | | FR-040 | S-010, S-011, S-063 | | FR-063 | S-021, S-043, S-096 |
| FR-018 | S-070 | | FR-041 | S-063 | | FR-064 | S-020, S-021 |
| FR-019 | S-020, S-060 | | FR-042 | S-063 | | FR-065 | S-003, S-010, S-021, S-030, S-096 |
| FR-020 | S-061 | | FR-043 | S-102, S-106 | | FR-066 | S-010, S-011, S-021, S-042, S-063 |
| FR-021 | S-061 | | FR-044 | S-001, S-105, S-106 | | FR-067 | S-001, S-107 |
| FR-022 | S-061, S-063 | | FR-045 | S-101, S-102, S-106 | | FR-068 | S-001, S-072, S-090, S-091, S-096 |
| FR-023 | S-062, S-066 | | FR-046 | S-064 | | | |

All 68 functional requirements map to at least one story.

### 5.2 Nonfunctional requirements NFR-001..NFR-010 → stories

| NFR | Stories |
| --- | --- |
| NFR-001 | S-040, S-084, S-092, S-096 |
| NFR-002 | S-040, S-064, S-087, S-096, S-100 |
| NFR-003 | S-042, S-043, S-085, S-093, S-096 |
| NFR-004 | S-004, S-096 |
| NFR-005 | S-004, S-095, S-096 |
| NFR-006 | S-003, S-020, S-022, S-081, S-094, S-096 |
| NFR-007 | S-011, S-042, S-063, S-064, S-083, S-087, S-096, S-100 |
| NFR-008 | S-002, S-003, S-004, S-010, S-085, S-096 |
| NFR-009 | S-004, S-096 |
| NFR-010 | S-045, S-086, S-096 |

### 5.3 Test groups T-01..T-16 → stories

| Test | Suite owner story | Also cited by |
| --- | --- | --- |
| T-01 | S-080 | S-001, S-010, S-041, S-045, S-070, S-096, S-105, S-107 |
| T-02 | S-081 | S-020, S-060, S-066 |
| T-03 | S-081 | S-020, S-021, S-030, S-042, S-061, S-063, S-064, S-068, S-069, S-094, S-096, S-100, S-101, S-103, S-104, S-105, S-106 |
| T-04 | S-080 | S-010, S-011 |
| T-05 | S-082 | S-030, S-041 |
| T-06 | S-083 | S-011, S-021, S-042, S-061, S-063, S-065, S-069, S-096, S-101, S-102, S-104, S-105, S-106, S-107 |
| T-07 | S-083 | S-043, S-061, S-103 |
| T-08 | S-082 | S-004, S-020, S-030, S-063, S-094, S-096, S-101 |
| T-09 | S-087 | S-100, S-106 |
| T-10 | S-084 | S-021, S-030, S-040, S-041, S-042, S-046, S-060, S-061, S-062, S-063, S-064, S-065, S-066, S-067, S-068, S-069, S-070, S-090, S-091, S-096, S-100, S-102, S-103, S-104, S-106 |
| T-11 | S-084 | S-040, S-041, S-044, S-064, S-070, S-092, S-096, S-100, S-106 |
| T-12 | S-085 | S-004, S-042, S-044, S-093, S-096 |
| T-13 | S-086 | S-045, S-096, S-105, S-107 |
| T-14 | S-095 | S-004, S-030, S-096, S-106 |
| T-15 | S-086 | S-065, S-066, S-067, S-068, S-069, S-096, S-102, S-103, S-104, S-106 |
| T-16 | S-085 | S-003, S-021, S-040, S-096 |

### 5.4 Backlog task coverage WD-001..WD-026 (+R2) → stories

| Task | Stories | | Task | Stories | | Task | Stories |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WD-001 | S-001, S-002 | | WD-010 | S-061, S-062 | | WD-020 | S-070, S-071, S-072 |
| WD-002 | S-002, S-010 | | WD-011 | S-063 | | WD-021 | S-022, S-092, S-093, S-094, S-095, S-096 |
| WD-003 | S-011, S-012 | | WD-012 | S-064 | | WD-022 | S-090, S-091, S-096 |
| WD-004 | S-020 | | WD-013 | S-065 | | WD-023 | S-107 |
| WD-005 | S-030 | | WD-014 | S-066, S-067 | | WD-024 | S-003, S-004 |
| WD-006 | S-040, S-046 | | WD-015 | S-068 | | WD-025 | S-069 |
| WD-007 | S-041 | | WD-016 | S-021 | | WD-026 | S-106 |
| WD-008 | S-042, S-043 | | WD-017 | S-103 | | WD-011-R2 | S-101 |
| WD-009 | S-046, S-060 | | WD-018 | S-044 | | WD-012-R2 | S-100 |
| — | — | | WD-019 | S-045 | | WD-013-R2 | S-102 |
| — | — | | — | — | | WD-023-R2 | S-105 |
| — | — | | — | — | | WD-025-R2 | S-104 |

All 31 backlog tasks map to at least one story. Structural decisions: WD-008 was split into charts (S-042) and exports (S-043); WD-010 into readings (S-061) and sites (S-062); WD-014 into governance (S-066) and ingestion/health (S-067); WD-020 into support (S-070), analytics (S-071) and onboarding (S-072); WD-024 into pipeline (S-003) and observability (S-004); WD-021/WD-022 acceptance evidence is distributed across S-022, S-090..S-095 and consolidated in S-096; the T-01..T-16 catalog became EP-08 suite stories S-080..S-087 plus the EP-09 execution stories.

