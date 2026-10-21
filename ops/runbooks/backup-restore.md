# Backup and restore runbook (WD-024) — NeoServer store + PostgreSQL

Status: **COORDINATED RELEASE RESTORE PENDING; SYNTHETIC STORE RESTORE RECORDED.**
The 21 October 2026 [NeoServer capture](../../infra/neoserver/qualification/recorded/CAPTURE-REPORT.md)
records a quiesced store backup restored into a fresh Docker volume, with
matching served tile bytes. It does not establish recovery of the full
application database, revisions, grants, attachments and outbox within
ratified RPO/RTO targets. Execute the coordinated T-14 drill below in an
approved disposable environment before release acceptance. Production access
and restoration remain subject to explicit environment authorization.

## Objectives (RPO/RTO — PLACEHOLDERS pending owner ratification)

| Objective | Proposed initial value | Status |
| --- | --- | --- |
| RPO (max accepted loss window) | 1 hour | PLACEHOLDER — DWRi ratification required (NFR-005) |
| RTO (max restore time) | 4 hours | PLACEHOLDER — DWRi ratification required (NFR-005) |
| Retention | TBD | PLACEHOLDER — governance decision |
| Backup storage location | `${BACKUP_DESTINATION_REF}` | resolved per environment at qualification |

These proposals become objectives only when the infrastructure owner
ratifies them against measured restore times; staging restore must prove
recovery of database revisions, attachments, grants and NeoServer
configuration before pilot acceptance (NFR-005).

## What must be recoverable together

A restore is only valid if the PAIR is consistent:

1. **PostgreSQL/PostGIS** — schemas (append-only migrations), measurement
   revisions and audit trail, outbox state, public revision table, grants.
2. **NeoServer catalog store** — the encrypted store (persistent disk /
   `serverdata`), whose content is a materialized cache of APPROVED views:
   it is rebuildable from source data, but its **store key is not rotatable
   in place** (ADR-09): losing the key means rebuilding the store and
   re-issuing stored workspace credentials.

Consistency rule: the database's recorded public revision after restore must
be >= the revisions materialized in the restored store. Reconcile by
replaying outbox cache-refresh events — never by editing the store or the
database outside the application.

## Backup procedure (coordinated)

- **NeoServer store: quiesced snapshot.** External writes do not invalidate
  NeoServer caches (ADR-10), so a live copy can be mid-state: stop (or
  quiesce) the single writer first, snapshot/copy the store volume, restart
  via the fenced restart steps (`infra/runtime/services/neoserver-vm.yaml`).
  This mirrors the WD-005 compose procedure: `docker compose stop neoserver`
  → copy the volume → start.
- **PostgreSQL: scheduled backups + WAL.** Per the DBA owner's existing
  approved mechanism (managed backups/PITR where available); the repository
  pins no provider here on purpose (ADR-05 qualification first).
- **Pair recording:** every backup event records (a) store snapshot id +
  sha256 of the snapshot archive, (b) database backup id + LSN/timestamp,
  (c) the public revision number at quiesce time. The restore drill uses
  this record to pick a consistent pair.
- **Store key escrow:** the store key lives in the approved secret manager
  under `${SECRET_REF:neoserver-store-key}` with a named escrow owner
  (PLACEHOLDER pending ratification). The key is backed up independently of
  the store. Without the key the store is unrecoverable by design; with both,
  recovery is the drill below.

## Restore drill outline (T-14; disposable staging only)

Script shape — execute verbatim in staging, record every step's duration:

1. **Preconditions**: disposable staging environment (never production);
  consistent backup pair from the record above; store key from the
  staging secret manager; synthetic data only.
2. **Restore database**: create the staging database from the backup id;
  verify migration state matches the backup's migration ledger; verify the
  audit trail is contiguous (no gaps — audit loss is a stop).
3. **Restore store**: quiesce staging NeoServer (single writer down),
  write the store snapshot into its persistent disk, start via fenced
  restart, confirm the store reopens with the store key.
4. **Reconcile**: replay outbox cache-refresh events from the database's
  recorded public revision to the store's materialized revision; confirm
  `public_revision >= store_revision` after replay.
5. **Checksum verification**: fetch a fixed set of tiles/TileJSON/features
  (Utah control points from `infra/neoserver/qualification/recorded/
  EXPECTATIONS.md`) and compare sha256 against the pre-drill capture set —
  identical for unchanged data.
6. **Functional verification**: anonymous public read; deny-path probes;
  one correction → publication freshness round trip.
7. **Timing**: total wall clock vs RTO; loss window vs RPO. Record both.
8. **Teardown**: destroy the staging database/store; confirm no synthetic
  or private data remains; archive the drill log + timings as T-14
  evidence.

Pass criteria: identical checksums (step 5), contiguous audit, coherent
revisions, RTO met, RPO window confirmed, zero secrets in the drill log
(request IDs and hashes only, per NFR-009).

## Failure handling during a real restore

- Store will not reopen with the key → treat as key compromise path:
  rebuild the store from approved views per the rebuild procedure and
  re-issue stored credentials (ADR-09); page the platform owner.
- Revision mismatch that replay cannot reconcile → stop; escalate to data
  governance + measurement owners; do not hand-edit.
- RTO at risk at 50% elapsed → declare an incident
  (`ops/runbooks/incident.md`), communicate expected outage extension.
