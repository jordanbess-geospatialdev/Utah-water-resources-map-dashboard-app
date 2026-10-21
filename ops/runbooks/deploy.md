# Deploy runbook (WD-024) — pre-flight gates and canary order

Status: **AUTHORED / NOT EXECUTED.** No deployment has run and none may run
until the authorization gate below is satisfied. This is the evidence file
for WD-024 (`Evidence: ops/runbooks/deploy.md`).

## Authorization gate (hard stop)

Deployment and live database access are **disabled until explicit environment
authorization** (WD-024 acceptance; `tasks.json`). Authorization means a
recorded decision — environment name, authorizing owner (platform owner with
DWRi concurrence), date, ticket, and the completed qualification checklist in
`infra/runtime/README.md`. The release pipeline encodes this: its `deploy` job
is a **fail-closed stub** that exits non-zero with "requires explicit
environment authorization" on every run until a reviewed change replaces it.
A green build is never authorization.

## Pre-flight gates (all must pass, in order)

1. **Release provenance exists and verifies.** The `release` workflow
   (`.github/workflows/release.yml`) ran to its manifest stage for the tag:
   - the signed tag's commit equals `origin/integration` HEAD (preflight
     verified it; re-check at execution time),
   - `release-manifest.json` records the commit SHA, `pnpm-lock.yaml`
     sha256, the digest-pinned external images from
     `infra/neoserver/docker-compose.yml`, and artifact hashes,
   - the manifest's lockfile hash matches a fresh local
     `sha256sum pnpm-lock.yaml`.
2. **CI green on the tag's merge commit**: gate/scope/trailers, secret scan,
   full matrix, lockfile integrity, ops verification — the same checks the PR
   carried, re-run at the release ref.
3. **Ops static verification passes**: `bash ops/verify.sh` (secret
   placeholders, digest pins, gate/secrets jobs present, no auto-push).
4. **Qualification checklist complete** (`infra/runtime/README.md`):
   database inventory, secrets provisioned as references, key recovery
   decided, T-14 drills green in disposable staging, RPO/RTO ratified,
   monitoring live with redaction probe, rollback rehearsed, caps reviewed.
5. **Backups fresh and verified**: latest quiesced NeoServer store snapshot
   and PostgreSQL backup are inside the ratified RPO window, and the most
   recent restore drill met RTO (`ops/runbooks/backup-restore.md`).
6. **Rollback rehearsed for this release class** (`ops/runbooks/rollback.md`)
   and the previous release's manifest is on hand for artifact rollback.
7. **Named on-call owner for the deploy window** and an open incident channel
   (`ops/runbooks/incident.md` routing table).
8. **Change record approved** per the production change policy (human
   ownership and release decisions, `04-ai-development-and-testing.md`).

## Deploy order

Runtime definitions come from `infra/runtime/services/*.yaml` (single source
of truth — console edits are drift and are reverted). Apply order:

1. **Secrets first (references only)**: every `${SECRET_REF:*}` name exists in
   the approved secret manager for the target environment. No secret value is
   ever passed through this runbook, a worktree or a log.
2. **Stateful layer**: NeoServer single-active VM per
   `neoserver-vm.yaml` — first-time apply uses the fenced-start procedure
   (store initialized, key from secret manager, exactly one writer). For an
   existing environment this step is a no-op verify, never a re-create.
3. **Database migrations**: append-only, applied by the migration account
   only (see rollback policy before applying anything destructive).
4. **Worker service**: scale up workers **before** backend so the outbox
   drains and publication caches are current when read traffic arrives.
5. **Backend/gateway service**: apply `backend.yaml` with the image digest
   from the release manifest.
6. **Static assets**: immutable versioned assets; never overwrite a live
   version path.

## Canary order (from the release plan)

1. **Public read first.** Deploy read-only/public journeys to the canary
   slice: map discovery, public profiles, bounded series/export flows. The
   public/policy persona needs no account — exercise exactly that path.
2. **Watch window (minimum 30 minutes, or the ratified duration)** with the
   stop-triggers below. Deny-path checks run during the window: anonymous
   probes against cohort/private routes must return denials, never cached
   private bytes (T-08 evidence method).
3. **Limited operational cohort second.** Admit a small named operational
   cohort (assigned engineers + one commissioner pair) and exercise
   corrections + publication freshness end to end: committed revision →
   outbox → NeoServer cache refresh → public visibility within the freshness
   target, with the revision/freshness timestamp visible.
4. **Staged broadening.** Only after both cohorts hold their windows: widen
   to remaining personas, then full traffic, one step per watch window.

## Watch items during every window

- Denied-request rate and any denied-request spike (probe signal —
  `ops/runbooks/incident.md`).
- Stale-publication lag (`cacheRevisionLag` / `ingestionLag`) — public
  freshness target and visible timestamps.
- Import/sync task failures and export queue depth/rejections (queue caps
  must reject loudly, never queue unbounded).
- Audit-loss alerts (any gap is an integrity stop).
- Database pressure: pool saturation, statement timeouts.
- Error/latency budgets per `ops/monitoring.md`.

## Stop conditions (halt rollout, execute rollback runbook)

- Any authorization failure (denied principal received private content, or an
  entitled principal's grant leaked across scope).
- Any data-integrity failure (lost edit, duplicated outbox effect, revision
  mismatch between store and database).
- Any recoverability failure (backup/restore verification fails, key
  recovery broken, single-writer fence violated).
- Telemetry loss — rolling forward without observability is prohibited.

## After the deploy

Record in the release evidence (`docs/releases/**`): tag, manifest sha256,
environment, authorization record, canary windows with their metric
snapshots, deviations, and the on-call owner. Update the rollback pointer to
this release.
