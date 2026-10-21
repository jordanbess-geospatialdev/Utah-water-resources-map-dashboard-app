# T-14 operations drills (WD-024) — scripts to execute in disposable staging

Status: **AUTHORED / EXECUTION PENDING.** These drills are the T-14 evidence
("Single NeoServer writer, restart, quiesced backup/restore, secret
recovery, cache refresh failure, telemetry/audit-loss alert, rollback —
drill log, restored checksum and timed recovery" per
`docs/product/baseline/04-ai-development-and-testing.md`). They may run ONLY
in a disposable staging environment with synthetic data once one exists; no
Docker daemon, staging environment, live database or deployment is available
or authorized in the authoring environment. Companion NeoServer-side drills
(sections 8–9 of the WD-005 checklist) live in
`infra/neoserver/qualification/recorded/EXPECTATIONS.md`.

Drill log discipline: every run records UTC start/end, environment id, image
digests, the exact commands executed, pass/fail per check, timings vs RTO,
and the sha256 checksums it produced — request IDs only, no credentials, no
private content (NFR-009).

## Common preconditions (all drills)

- Disposable staging: synthetic fixtures only (WD-002 fixture set), pinned
  digests verified against the registry (`docker compose pull` re-verification
  or release-manifest match).
- Secrets staged as references in the staging secret manager; nothing in
  files or command history.
- Baseline capture taken BEFORE the fault is injected (state + checksums).
- Watcher running for the alert under test; alert routing per
  `ops/runbooks/incident.md`.

## Drill 1 — single-writer restart

- **Purpose (ADR-09)**: prove exactly one active writer and that a fenced
  restart preserves content.
- **Steps (outline)**:
  1. Baseline: capture served TileJSON + control tiles (Utah control points),
     record sha256s and the current public revision.
  2. Attempt a second writer: start a second instance attached to the same
     store volume / attempt `--scale 2`. **Expect**: refusal to start or
     store lock — record the exact failure mode; a successful second start
     is a FAIL (page per incident runbook).
  3. Fenced restart: drain → stop → verify instance fully down (lease
     released) → start → verify store reopens with the store key.
  4. Re-capture the baseline artifacts; compare sha256 — identical for
     unchanged data.
  5. Exercise one correction → publication refresh after restart.
- **Pass**: second writer refused; identical checksums; freshness round trip
  green; restart time recorded.
- **Script hook**: extend `infra/neoserver/qualification/capture.mjs` capture
  set, or run its control-tile fetches before/after and diff.

## Drill 2 — backup/restore checksum (T-14 core)

- **Purpose (NFR-005)**: coordinated NeoServer store + PostgreSQL restore
  with checksum proof and timed recovery.
- **Steps**: execute the drill outline verbatim from
  `ops/runbooks/backup-restore.md` (quiesced store snapshot → coordinated
  database backup → restore pair into fresh staging → outbox reconciliation
  → sha256 comparison of control artifacts → functional probes → timings vs
  RTO/RPO).
- **Pass**: identical checksums, contiguous audit chain, coherent revisions
  (`public_revision >= store_revision`), RTO met.
- **Record**: the timing table and the checksum set become the drill log.

## Drill 3 — cache-refresh failure injection (ADR-10 / T-08 cousin)

- **Purpose**: external writes do not invalidate NeoServer caches; the
  outbox retry must recover publication without repeating the domain write.
- **Steps (outline)**:
  1. Commit a public metadata revision through the domain API; note the
     outbox item id and the correction's idempotency key.
  2. Before the worker refreshes, inject failure: make NeoServer unreachable
     from the worker (network policy / stop upstream briefly).
  3. Observe: refresh attempts RETRY (bounded attempts, backoff per
     `infra/runtime/services/worker.yaml`); the correction is NOT re-applied
     (revision count unchanged in the database).
  4. Restore reachability; confirm the retry (or manual replay) refreshes
     the cache; `cacheRevisionLag` returns to zero; the new revision is
     publicly visible within the freshness target.
  5. Verify no spontaneous invalidation occurred during the outage window
     (stale tile served until the explicit refresh — the reason ADR-10
     exists).
- **Pass**: exactly one domain write, eventual freshness, lag alert fired
  and cleared, poison-queue behavior verified if attempts exhausted.

## Drill 4 — telemetry-loss alert (+ rollback rehearsal)

- **Purpose (NFR-009 + T-14 rollback)**: telemetry/audit-loss is detected
  and routed; the rollback path is rehearsed and timed.
- **Steps (outline)**:
  1. Block the audit sink (or metrics sink) in staging; perform an audited
     write.
  2. **Expect**: `auditLoss` alert fires and routes per the incident runbook
     (platform on-call + data governance steward); the write freeze decision
     path is exercised at least as a tabletop with the owners.
  3. Un-block; verify gap detection reports the exact missing audit window.
  4. Rollback rehearsal: execute `ops/runbooks/rollback.md` artifact rollback
     to the previous release manifest in staging (worker → backend → asset
     pointer), timing each step; verify deny-path probes and one publication
     round trip after rollback.
- **Pass**: alert fired + routed within its threshold; gap precisely
  reported; rollback completed within its rehearsed budget with verification
  green.

## Evidence and sign-off

Each drill keeps its own log under this directory when executed
(`drill-<n>-<date>.md`, gitignored? no — committed as evidence once real;
never fabricated). Sign-off fields per log: executed by, date, environment,
digests verified, timings, deviations. A drill that has not run is recorded
exactly as this README records it: authored, pending — never implied
complete.
