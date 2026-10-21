# Monitoring specification (WD-024) — metrics and redaction rules

Status: **AUTHORED / NOT LIVE.** No deployment exists; these are the metric
and redaction contracts the runtime (`infra/runtime/services/*.yaml`
observability blocks) must implement, verified by the T-14 telemetry drill.
Implements NFR-009 and the instrumentation line in
`docs/product/baseline/02-technical-specification.md` ("Proposed service
targets and operations").

## Correlation contract

- **Request IDs propagate across every hop**: gateway → backend → worker/jobs
  → database session (`requestIdPropagation: true` in all three service
  definitions). A user-visible failure is answerable with one request/job ID.
- Request IDs are opaque random values; they never embed user, site or
  owner identifiers.
- Audit events carry the acting principal's stable identifier, the object
  scope and the request ID — this is the join key between telemetry and the
  append-only audit trail, and the only place principal identity is
  correlated.

## Metric list

| Metric | Source | Why / threshold basis |
| --- | --- | --- |
| `requestLatency` (p50/p95 per route class) | backend + gateway | Public screen p95 ≤ 3 s; bounded query/chart p95 ≤ 2 s proposals; alert at budget breach |
| `deniedAccess` (count/rate by route class + status) | gateway + backend | Deny-path health; SPIKE alert (see incident runbook); denials must remain denials |
| `tileFailures` | gateway (NeoServer upstream) | Spatial journey availability; distinguish upstream 5xx from gateway 4xx |
| `exportFailures` + `exportQueueDepth` + queue rejections | worker | FR-065 bounded exports; bounded queues must reject loudly — rejections alert, never silently drop |
| `syncConflicts` | worker (outbox/revision) | Optimistic-lock conflicts expected but trended; spike = training or defect signal |
| `ingestionLag` | worker | NFR-004 separately monitored ingestion health; FR-014 digest links failed tasks |
| `cacheRevisionLag` | worker + NeoServer | Public spatial freshness (5-min proposal); stale beyond 2x → visible staleness + incident path |
| `poolSaturation` (per pool: active/waiting/acquire timeouts) | backend + worker + NeoServer DB pool | Bounded pools (runtime YAML caps); saturation = capacity incident, never remove the cap |
| `queueDepth` + `queueRejections` (render/export/claim) | backend + worker | Queue-cap acceptance: bounded with loud rejection |
| `taskFailure` (by task class, with attempt count) | worker | FR-014 failed connection vs failed task distinction |
| `auditLoss` (audit write failures/gaps) | backend + worker | Sev-1 integrity signal (incident runbook) |
| `storeLockViolations` | NeoServer VM | ADR-09 single-writer fence; any occurrence pages |
| Availability (public read journeys) | synthesized | NFR-004 99.5% monthly proposal |

Thresholds are proposals tied to the operational-targets ratification
(`docs/product/baseline/03-architecture.md` open decisions); alert configs
are placeholders until then, and every alert routes per
`ops/runbooks/incident.md`.

## Redaction rules (NFR-009) — hard rules, enforced by review + drill

1. **No secrets ever**: tokens, cookies, API keys, passwords, the NeoServer
   store key, session signing material, OIDC tokens — none appear in logs,
   metrics labels, error bodies or analytics payloads. Error surfaces return
   request IDs, not stack internals.
2. **No private content**: measurement values, site notes, photos, gate
   codes, wiring details, internal QC commentary, attachment names and any
   non-published field never enter telemetry. Logs record THAT a tile/export/
   download was authorized/denied (route, scope decision, request ID), never
   the bytes or field values.
3. **Mask sensitive fields by default**: principal identifiers appear only
   in the audit join (above); dashboards aggregate. Administrative and field
   content is excluded by default even from internal views.
4. **No session replay or content-capture analytics** until a recorded
   privacy decision approves them (tech spec requirement).
5. **Denied-access logs** carry route class + status + request ID — never the
   response body, the attempted credential, or the URL query beyond route
   template (queries can embed filters over private identifiers).
6. **Export/job logs** record row counts, durations, scope decision and job
   ID — never data samples.
7. **Drill verification**: the T-14 telemetry-loss drill includes a probe
   that greps a sampled log window for the qualification canary strings and
   credential patterns; any hit fails the drill (method shared with WD-005's
   `capture.mjs` canary check).

## Log retention and access

Retention follows the ratified retention policy (PLACEHOLDER pending
governance decision, NFR-005 table). Access to raw logs is restricted to the
platform on-call role; analytic views are the default surface. Log exports
outside the platform follow the same redaction rules — export the metrics,
not the raw logs, unless an incident requires the join key.
