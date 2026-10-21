# MVP Release Notes — Utah Water Measurement Data Dashboard

Release: MVP (fixture-proven) | Prepared 2026-10-21 | State: machine qualification PASSED; production deployment NOT authorized (see below)

## What is included

The baseline assigns **51 functional requirements and 10 nonfunctional
requirements to MVP**, 15 functional requirements to R2, and two to Discovery
([traceability register](../traceability/requirements-traceability.csv)). Merged
delivery tasks provide fixture-tested modules for the MVP scope. Task completion
and unit tests do not establish integrated acceptance: the application shell
still needs the feature modules mounted, and the API needs an HTTP transport,
persistent stores and real identity integration. See the
[qualification report](../verification/MVP-QUALIFICATION-REPORT.md) and
[repository review](../verification/2026-10-21-repository-review.md).

Implemented module areas include:

- **Public experience (FR-001..010, FR-052, FR-058..066):** six-persona GeoLibre/
  MapLibre application, controlled metadata filters with unknown-vs-absent
  distinction, natural-language filter layer with injection defense, shareable
  view URLs (no persona/credentials ever serialized), DST-correct charts and
  aggregation with hand-derived golden values, CSV exports with formula
  neutralization, self-describing public indicators and policy summaries,
  researcher scoped API credentials with one-time secrets.
- **Operational workflows (FR-011..046 operational subset):** server-enforced
  entitlements (13x6 matrix, deputy delegations, engineer capability variants,
  revocation at next request), assigned workspaces, manual entry and 366-row
  golden bulk imports with atomic idempotent commits, append-only corrections
  with full point/interval audit, capability-gated raw withdrawal, field visits
  with the FR-049 attachment visibility wall, effective-dated site setup,
  versioned QC rules with test-before-promote, steward governance and
  connection health, deterministic annual distribution reports with provenance,
  scoped alert subscriptions with DST-correct digest schedules.
- **Platform:** contract-first OpenAPI (22 operations), Cloud SQL-compatible
  partitioned time-series model with SELECT-only publication views, authorized
  NeoServer gateway (live protocol qualification T-05: 13/14 checks, one honest
  upstream finding documented), CI with scope/trailer/migration/lockfile gates,
  fail-closed release pipeline, ops runbooks.

## Qualification verdict

`node tests/qualification/run-qualification.mjs` — **PASS** (fixture evidence),
deterministic across repeated runs; ~2,030 checks green across six packages.
Qualification defects Q1/Q2/Q3 were found by the independent adversarial pass,
fixed, and are now pinned by regression tripwires asserting the fixed state.

## Known limitations (honest, by design)

1. **Fixture-only evidence.** All data is synthetic. Live SQL (T-04 live parts),
   fresh NeoServer capture, HTTP-layer replay, browser E2E, manual accessibility,
   staging load tests, and the T-08/T-14 operational drills are recorded BLOCKED
   with exact reasons in the qualification report and remain production gates.
2. **Simulated channels.** Notification delivery, ingestion transport, and
   analytics collection are simulated interfaces. Those adapters do not deliver
   production messages or ingest live provider data.
3. **Pending owner decisions.** Golden values (measurement owner), permission
   matrix ratification, DR-009 database inventory, analytics privacy decisions
   D-1..D-6, and identity provider integration (DR-011).
4. **Application integration remains incomplete.** The runnable web entry point
   renders the fixture shell in `apps/web/src/shell/App.tsx`; the standalone
   feature panels are not yet mounted there. Domain APIs have no HTTP server or
   persistent backing store. Training steps and API examples describe target
   workflows and cannot yet serve as proof that users can complete them.

## Deferred to R2 / Discovery (explicitly NOT in this release, non-blocking)

- R2: supplier/water-use reporting (WD-017), rating curves and shifts
  (WD-011-R2), durable offline capture/sync and asset transfers (WD-012-R2),
  recurring quality trends (WD-013-R2), historical as-of reconstruction,
  voice notes and WCAT integration (WD-023-R2; FR-044/047/051), and decision
  snapshots, finalized reports and flexible accounting periods (WD-025-R2).
- Discovery: advanced field configuration (FR-050), extended modeling/rights
  transparency (FR-067), scoped through WD-023.

## Production authorization requirements

Deployment requires, per the development plan's release section: the named-owner
sign-offs in `docs/uat/SIGN-OFF.md`, pinned production dependencies/images, the
BLOCKED gate items executed in staging, a rehearsed backup/restore and rollback,
named on-call owners, and an approved production change. None of these is granted
by this repository's state.

Agent: orchestrator
