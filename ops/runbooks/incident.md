# Incident runbook (WD-024) — routing and first response

Status: **AUTHORED / NOT EXECUTED.** Alert routing below is pending the
named on-call owners decision; placeholders are explicit and must be filled
before any authorized deployment window.

## Severity model

| Severity | Definition | Response target |
| --- | --- | --- |
| Sev-1 | Authorization bypass, private-data exposure, data loss/integrity, single-writer fence violation, audit loss | Page on-call immediately; stop rollout |
| Sev-2 | Public journey degraded beyond budget, stale publication beyond target, export/ingestion queues rejecting work | Acknowledge within 15 min; incident channel |
| Sev-3 | Degradation with workaround; drill/dev-env only | Next business day |

## Routing table (PLACEHOLDERS pending owner ratification)

| Signal | Routes to | Escalation |
| --- | --- | --- |
| All Sev-1 | `${ONCALL_PRIMARY_REF}` (platform) | `${ONCALL_SECONDARY_REF}` → platform owner → DWRi product owner |
| Denied-request spike | platform on-call + security/identity owner | Data governance steward if exposure suspected |
| Stale-publication lag | platform on-call | Publication freshness owner (spatial integration) |
| Audit loss | platform on-call + data governance steward | Measurement/data owner — integrity stop |
| Database pressure | platform on-call + DBA owner | — |
| NeoServer dual-writer | platform on-call (page) | Platform owner — ADR-09 fence breach |

## Scenario: denied-request spike

Symptom: `deniedAccess` rate crosses the alert threshold
(`ops/monitoring.md`) without a matching deploy or grant change.

1. **Triage within 5 minutes**: pull the request IDs behind the denials —
   which principal cohort, which routes (portal paths vs direct protocol
   paths: tiles, features, queryables, bulk). Direct-protocol probing is
   expected behavior the design assumes; confirm the denials ARE denials
   (401/403/404), not errors.
2. **If any response was NOT a denial** (private bytes, 200 on a cohort
   route from an unentitled principal): Sev-1 — stop rollout, capture the
   response bytes as evidence, route to security/identity owner. Do not
   delete logs (they contain request IDs, not content).
3. **If all probes were correctly denied**: suspected enumeration/probing —
   apply rate limits (caps in `infra/runtime/services/backend.yaml`), record
   the pattern, consider blocking policy with the security owner. Denial
   details in logs carry request IDs and routes only, never response bodies
   (NFR-009).
4. **Communicate**: incident channel note with rate, window, cohort, action.

## Scenario: stale-publication lag

Symptom: `cacheRevisionLag` / public spatial freshness exceeds the target
(5-minute proposal) after a committed public revision.

1. Check outbox first (ADR-10): are publication-refresh items CLAIMED,
   PENDING or RETRYING? FR-014 applies — distinguish failed connection from
   failed tasks.
2. If items are PENDING: worker service down or claim-capped — check worker
   health and queue caps (bounded queues reject loudly; rejections are an
   alert, not silent queueing).
3. If RETRYING (cache refresh failures): NeoServer reachability/health;
   retries must not repeat the domain write. If attempts hit the poison
   queue, run the manual refresh path and page the platform owner.
4. Never fix by editing the store or the database directly; the outbox is
   the only publication mechanism.
5. If lag crosses 2x the freshness target: post the visible-staleness
   notice path — public pages must show timestamps/revisions, not imply
   live data (NFR-004).

## Scenario: audit-loss alert

Symptom: audit sequence gap or audit-write failure (`auditLoss` metric).

1. **Treat as integrity incident immediately** (Sev-1): an unrecorded
   mutation is indistinguishable from tampering.
2. Freeze writes if the audit sink is failing (fail-closed preference:
  a rejected write is recoverable; an unaudited accepted write is not).
3. Capture the gap window (last contiguous audit id → first resumed id),
   reconcile affected objects via the revision chain (ADR-06 append-only
   revisions make reconstruction possible).
4. Route to data governance steward + measurement owner with the gap record.
5. Root-cause the sink before lifting the freeze; the freeze lift is an
   explicit owner decision, recorded in the incident log.

## Scenario: single-writer fence violation (NeoServer)

Symptom: `storeLockViolations` / dual-writer detection (ADR-09).

1. Sev-1 page. Stop the junior writer (later start time) immediately.
2. Verify store integrity via the restart drill verification (served content
   sha256 vs the last quiesced snapshot record).
3. If integrity is in doubt: quiesce → restore from the last consistent
   snapshot per `ops/runbooks/backup-restore.md`; replay outbox.
4. Root-cause: autoscaler misconfiguration, manual second instance, or fence
   failure — all three are configuration drift incidents.

## Communication templates

- Sev-1 opening: `SEV-1 <summary> — impact <cohorts/journeys> — started
  <UTC> — on-call <name> — next update in 30 min. Rollout stopped.`
- Resolution: `RESOLVED <id> — root cause <one line> — evidence <link> —
  follow-ups <tickets>.` Every incident closes with a post-mortem file in
  the incident record referencing the relevant runbook section and any
  runbook correction (this file is versioned with the repo).
