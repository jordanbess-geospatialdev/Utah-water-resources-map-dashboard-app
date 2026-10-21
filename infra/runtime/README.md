# infra/runtime — WD-024 reproducible runtime definitions

TARGET-SHAPE definitions (authored, **not applied**). Nothing in this
directory has been deployed, provisioned or connected to any live system: the
WD-024 acceptance explicitly keeps **deployment and live database access
disabled until explicit environment authorization**. These files are the
reviewable definition of the runtime the platform owner will qualify and apply
once that authorization exists.

| Path | Purpose |
| --- | --- |
| `services/backend.yaml` | Stateless backend + spatial-gateway service: min/max instances, VPC egress connector reference, bounded DB connection pools, request concurrency/timeout caps, bounded render/export queue caps, session-revocation cache TTL, rate limits. Secrets are `${SECRET_REF:...}` placeholders only. |
| `services/worker.yaml` | Outbox-driven worker service (ADR-10): bounded claim batches, retry caps with poison queue, bounded concurrent export renders with row/wall-clock limits, NeoServer cache-refresh staleness alert. No public ingress. |
| `services/neoserver-vm.yaml` | Single-active stateful NeoServer VM (ADR-09): maxReplicas 1 with stop-then-start fencing, persistent encrypted-store disk, quiesced maintenance window, fenced restart steps, quiesced store backup + non-rotatable key-recovery notes, SELECT-only publication DB account, digest-pinned image matching `infra/neoserver/docker-compose.yml`. |

Conventions enforced by `ops/verify.sh` (run in CI):

1. **Secrets are references, never literals.** Secret-valued fields use
   `${SECRET_REF:<logical-name>}`; values resolve per environment from the
   approved secret manager at qualification time. A literal value in any
   `infra/**` file fails CI.
2. **Images are digest-pinned.** External images carry `tag@sha256:<64-hex>`
   (NeoServer pin shared with the WD-005 stack). Application images are
   `${RELEASE_IMAGE_*_DIGEST}` placeholders resolved **only** from the
   release-manifest digest produced by `.github/workflows/release.yml`; a
   mutable tag never substitutes.
3. **Queue/pool caps are explicit and bounded.** Every queue and pool names
   its max depth/connections and its overrun behavior (reject/backpressure,
   never unbounded). Numeric values are initial proposals tied to the
   "Operational targets and budget" open decision in
   `docs/product/baseline/03-architecture.md` and are re-ratified with the
   agreed load dataset before contractual use.

## Qualification checklist — what must be true before ANY apply

Every box must be checked by the named owner with evidence attached. An
unchecked list means apply is blocked; there is no partial apply.

- [ ] **Explicit environment authorization recorded** (platform owner +
      DWRi) naming the environment, date, approver and ticket. Until this
      exists the release pipeline's deploy stage stays fail-closed and no
      `apply` command may be run against any non-disposable target.
- [ ] **Database qualification complete** (WD-003/ADR-05 evidence): actual
      PostgreSQL service inventoried (product, version, extensions — PostGIS
      and, if applicable, TimescaleDB), private connectivity, separate
      accounts (publication read / app query / app write+migration /
      ingestion) and backup posture confirmed by the DBA owner.
- [ ] **Secret manager populated with every `${SECRET_REF:*}` name** used in
      these files (store key, DB URLs, OIDC issuer, session signing key,
      scoped NeoServer credential, notification sender, backup destination);
      no secret value has ever transited a worktree, prompt or log.
- [ ] **NeoServer store key recovery decided** (ADR-09): key escrow owner
      named, rebuild-from-source procedure rehearsed, "cannot rotate in
      place" acknowledged in writing.
- [ ] **Image digests verified against the registry** (re-pin deliberately
      on any drift — "reviewed upstream `main` documentation is evidence
      about a design seam, not a reproducible release pin") **and** the
      application image digests match the release manifest being deployed.
- [ ] **T-14 drills green in disposable staging** (see
      `ops/drills/README.md`): single-writer restart, quiesced
      backup/restore with checksum, external-write cache-refresh failure
      injection, telemetry/audit-loss alert. Drill logs + timings archived.
- [ ] **RPO/RTO and retention ratified** (NFR-005; proposed RPO 1 h / RTO
      4 h are placeholders until then) and a restore drill has met them.
- [ ] **Monitoring live with redaction verified** (NFR-009,
      `ops/monitoring.md`): request-ID correlation, latency/denied/tile/
      export/sync/ingestion/audit metrics flowing, alert routing tested,
      a deliberate probe confirms no secrets or private content appear in
      logs.
- [ ] **Rollback rehearsed** per `ops/runbooks/rollback.md`, including the
      append-only migration policy decision tree.
- [ ] **Queue/pool/concurrency caps reviewed** against the ratified load
      dataset; any change lands as a reviewed diff to these YAML files
      (they are the source of truth, not console edits).
- [ ] **Signed release tag + manifest verified** (`.github/workflows/
      release.yml` outputs): tag commit equals integration HEAD, lockfile
      hash and image digests in the manifest match the deployed artifacts.

Post-apply, any manual deviation from these definitions must be reverted or
folded back into the files in the same change window — configuration drift
is an incident per `ops/runbooks/incident.md`.
