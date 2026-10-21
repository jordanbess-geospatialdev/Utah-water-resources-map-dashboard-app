# ops — runtime operations for the Utah Water dashboard (WD-024)

Status: **RUNBOOKS AUTHORED; SYNTHETIC NEOSERVER QUALIFICATION RECORDED.**
The 21 October 2026 [capture report](../infra/neoserver/qualification/recorded/CAPTURE-REPORT.md)
records disposable Docker/PostGIS protocol checks, external-write cache refresh,
single-writer exclusion, restart and quiesced NeoServer store recovery. Those
checks used synthetic data and the stack was removed afterward. They do not
establish a production deployment or complete the application-wide database,
secret-recovery, telemetry-loss and rollback drills. Re-run the required drills
against the approved release environment and manifest before acceptance; see
the [deployment gate](runbooks/deploy.md) and
[qualification checklist](../infra/runtime/README.md).

| Path | Purpose |
| --- | --- |
| `verify.sh` | Zero-dependency static verifier (below). Runs in CI via the `ops-verify` job in `.github/workflows/ci.yml` and in the release suite. |
| `runbooks/deploy.md` | Pre-flight gates, apply order, canary order (public read first, then limited operational cohort), watch items, stop conditions. **WD-024 evidence file.** |
| `runbooks/rollback.md` | Artifact rollback by release manifest; append-only migration rollback policy (roll forward or restore — never reverse migrations); configuration drift rule. |
| `runbooks/backup-restore.md` | Coordinated NeoServer store + PostgreSQL backup/restore; RPO/RTO placeholders pending owner ratification (NFR-005); restore drill outline (T-14). |
| `runbooks/incident.md` | Severity model, routing placeholders, first-response playbooks: denied-request spike, stale-publication lag, audit loss, single-writer fence violation. |
| `monitoring.md` | Metric list with redaction rules per NFR-009 (request IDs, latency, denied access, tile/export failures, sync conflicts, ingestion lag; no secrets/private content ever). |
| `drills/README.md` | T-14 drill scripts to execute in disposable staging when available: single-writer restart, backup/restore checksum, cache-refresh failure injection, telemetry-loss alert + rollback rehearsal. |

## Running the verifier

No package.json, no Node, no dependencies — bash + coreutils only:

```bash
bash ops/verify.sh        # from anywhere; the script locates the repo root
```

It is idempotent (run it twice, same result) and read-only. CI calls it from
the `ops-verify` job on every pull request, and the release workflow calls it
again before building artifacts.

Checks (each fails the run with a specific finding):

1. **Secret placeholders** — every secret-ish key (`password`, `secret`,
   `token`, `api key`, `store/signing/private key`, `credential`) in
   `infra/**` structured files (`*.yaml`, `*.yml`, `.env.example`) must carry
   a placeholder value: `${...}`, `<...>`, `replace-with-...`,
   `placeholder`/`pending`. A literal value fails. Code and prose files are
   excluded by type so identifiers in scripts are not false positives; the
   CI secret scan and pre-commit hook remain the pattern-based backstop.
2. **Digest-pinned images** — every `image:` in `infra/**` YAML is either
   `name:tag@sha256:<64 hex>` or an explicit release-time `${...}` placeholder
   for application images resolved from the release manifest. Bare tags
   (`:latest`, `:1.2`, unpinned) fail.
3. **CI gates intact** — `.github/workflows/ci.yml` still contains the
   `gate` job (invoking `node scripts/gate.mjs all`), the `secrets` job and
   the `build` job, keeps the `pull_request` trigger, and carries the
   one-run-per-ref concurrency guard.
4. **No auto-push in release** — `.github/workflows/release.yml` is
   `workflow_dispatch`-only (no push/schedule/pr/call triggers) and contains
   no executable `git push`, release-publish, registry-push or
   infrastructure-apply step, and its deploy stage still fails closed with
   the authorization error. Operator instructions inside the generated
   tag-signing block are prefixed with `$ ` (operator prompt) — the verifier
   skips those lines because CI never executes a line beginning with `$`.
5. **YAML structure sanity** — key-presence checks for the runtime service
   definitions (pool/queue caps, single-writer fence, backup/key-recovery
   blocks) and both workflows (required jobs/inputs), a no-tab-character rule
   for all scanned YAML, and two-space indentation parity for the runtime
   definition files.

## Standing rules

- Runbooks are versioned with the code: an incident that reveals a wrong step
  files a correction in the same change window.
- Placeholders (`PENDING_OWNER_RATIFICATION`, `${...}` refs, RPO/RTO) are
  deliberate: owner decisions are recorded, not assumed. A placeholder that
  ships to an authorized deployment is a blocked release.
- Drills and restores never run against production first; disposable staging
  with synthetic data only, log discipline per NFR-009.
- Release preflight verifies the annotated tag's signature and commit. The
  runner must have the approved public signing keys and trust configuration;
  absent keys or a failed signature check block release. The setup and ownership
  are recorded in the [deploy runbook](runbooks/deploy.md).
