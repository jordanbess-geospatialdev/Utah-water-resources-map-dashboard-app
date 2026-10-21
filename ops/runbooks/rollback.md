# Rollback runbook (WD-024) — artifacts and migrations

Status: **AUTHORED; APPLICATION ROLLBACK REHEARSAL PENDING.** Rehearse this
runbook in an approved disposable environment before release acceptance.
The recorded NeoServer restart/store recovery checks do not prove artifact
rollback, application compatibility or migration roll-forward. No production
rollback is authorized by those synthetic checks.

## Decision order

1. **Stop new traffic first** (canary slice → cohorts → full), per the stop
   conditions in `ops/runbooks/deploy.md`.
2. **Identify the failure class**: artifact (bad build/image), configuration
   (drift from `infra/runtime/`), migration (schema/data), or data-content
   (bad data ingested/published). Artifact and configuration roll back;
   migrations and data roll **forward** or restore — see policy below.
3. **Announce** on the incident channel with the release tag, the last-good
   tag and the reason (`ops/runbooks/incident.md` routing).

## Artifact rollback (services and static assets)

- The unit of rollback is a **release manifest** (`.github/workflows/
  release.yml` output), never a mutable tag. Take the previous release's
  `release-manifest.json` and redeploy exactly its digests/hashes:
  - backend/gateway and worker: previous `${RELEASE_IMAGE_*_DIGEST}` values
    from that manifest, applied per `infra/runtime/services/backend.yaml` /
    `worker.yaml` (caps unchanged — rollback never relaxes limits).
  - static assets: immutable versioned paths mean rollback is a pointer
    flip to the previous version; no file is overwritten in place.
- **Order**: worker before backend (outbox drains against the old contract),
  backend next, then the asset pointer flip; NeoServer is untouched by
  artifact rollback (see below).
- **NeoServer**: do NOT roll its image back as part of an artifact rollback
  unless the failure is the NeoServer image itself — its encrypted catalog
  store is the state, and an image change is a fenced restart
  (`infra/runtime/services/neoserver-vm.yaml` fencedRestart). If the NeoServer
  image must change: quiesce → stop → verify single writer down → start the
  previous digest → verify served revision matches the public revision table.
- Verify after rollback: health, deny-path probes (anonymous + cross-cohort),
  one correction → publication-freshness round trip, error/latency back in
  budget.

## Database migration rollback policy

Migrations are **append-only** (repository rule enforced by
`scripts/gate.mjs` and CI: a merged migration file is never edited;
ADR-06 keeps originals and provenance). Therefore:

1. **Default: roll forward.** A defective migration is fixed by a NEW
   migration that repairs/compensates (e.g. drop the bad object, re-add a
   constraint, append corrections). This preserves the audit chain and the
   immutable originals; finalized accounting/report snapshots are superseded,
   never rewritten (ADR-07).
2. **`gcloud`-style "migrate down" is not used.** No down-migrations are
   authored; any tooling that rewrites history is prohibited on the
   migration account.
3. **Restore instead of reverse** when rolling forward cannot preserve
   integrity (corrupting migration, unrecoverable data errors): execute the
   coordinated restore in `ops/runbooks/backup-restore.md` to the last backup
   inside the ratified RPO, replaying the outbox/publication revision
   reconciliation. This is a data-loss decision — requires the data
   governance owner + measurement owner sign-off, and is logged as a Sev-1
   incident with a post-mortem.
4. **Never combine** an artifact rollback with an unreviewed schema change:
   the old artifacts must be compatible with the current schema; if they are
   not, restore is the path, and the deploy was missequenced (post-mortem
   item).

## Configuration drift rollback

Any live setting that differs from `infra/runtime/services/*.yaml` is drift.
Remediation: re-apply the definition file or commit a reviewed diff — console
fixes expire with the incident window and must be folded back into the files
in the same window.

## Rehearsal requirement

Rollback is rehearsed per T-14 before any production cutover (drill 4 in
`ops/drills/README.md` references this file): timed artifact rollback plus a
migration roll-forward case in disposable staging, with the drill log as
evidence. A rollback path that has not been rehearsed does not count as a
rollback path.
