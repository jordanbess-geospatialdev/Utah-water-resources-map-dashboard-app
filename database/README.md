# Utah Water Measurement Data Dashboard - database baseline (WD-003)

Cloud SQL-compatible PostgreSQL/PostGIS schema, publication views, role
separation, read-only qualification pack and a deterministic contract-fixture
loader for the Utah Water Measurement Data Dashboard.

## Deployment qualification gate (read this first)

**Cloud SQL versus self-managed PostgreSQL must be inventoried before any
production schema work.** This is the open decision DR-009 (database service
and extensions, per the architecture decision register / release-qualification
table) and DR-005 (existing PostgreSQL host and TimescaleDB feasibility, per
the PRD register), and architecture ADR-05: Google Cloud is a hosting
environment, Cloud SQL is a specific managed service, and they are not
equivalent. The DWRi DBA / cloud owner runs the read-only queries in
[`qualification/queries.sql`](qualification/queries.sql) against the actual
service and records the output with the decision.

**This baseline is Cloud SQL-compatible by construction**: native PostgreSQL
declarative `PARTITION BY RANGE (observed_time)` with monthly partitions, a
conventional unique composite key, and **no TimescaleDB dependency** - there is
no Timescale-specific DDL anywhere. PostGIS (supported on Cloud SQL) is the
only required extension. If a qualified TimescaleDB deployment exists, the
documented conversion path and its trigger conditions are in
[`qualification/TIMESCALE-ALTERNATIVE.md`](qualification/TIMESCALE-ALTERNATIVE.md).

**No live database was accessed while producing this package.** Every SQL
artifact here is authored, statically gated and pending execution under the
qualification gate; query plans, view proofs and role grants are
authored-but-not-executed until that gate runs.

## Running the qualification queries (read-only)

```bash
psql "<inventory connection string>" -v ON_ERROR_STOP=1 -f database/qualification/queries.sql
```

The file contains only `SELECT`s, `information_schema` proofs and `EXPLAIN
ANALYZE` (which executes the underlying selects but writes nothing). To make
the read-only contract explicit at the session level:

```bash
psql "<connection string>" -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY" \
  -f database/qualification/queries.sql -c "ROLLBACK"
```

Section 1 is the inventory (service/extension decisions DR-009/DR-005); section
2 proves the publication views expose no restricted column and that
`neoserver_pub` holds exactly the two view grants; section 3 captures the
representative plans (GiST bbox lookup, one-month partition-pruned series scan,
revision history by logical key). Expected results are stated inline; run
sections 2-3 on a disposable seeded database (below).

## Layout

| Path | Contents |
| --- | --- |
| `migrations/V202610211200__WD-003_core_model.sql` | Core model: vocabulary, systems/groups, stations (UUID PK, PostGIS Point 4326, external-ID mapping, visibility, version), datastreams, device deployments, immutable monthly-partitioned originals with the `(stream_id, observed_time, source_event_id)` logical-key unique index, append-only revisions with optimistic version, rating curves/shifts, site visits/attachments, QC rules/results, assignments, audit events, transactional outbox |
| `migrations/V202610211201__WD-003_publication_views.sql` | SELECT-only publication layer: `v_public_stations`, `v_public_station_summary` (explicit column lists; restricted fields absent by construction) and the empty `v_cohort_water_owners` stub |
| `migrations/V202610211202__WD-003_roles.sql` | `neoserver_pub` / `app_read` / `app_write` / `app_migrate` role separation; migration operators alone hold DDL |
| `qualification/queries.sql` | Read-only qualification pack (see above) |
| `qualification/TIMESCALE-ALTERNATIVE.md` | TimescaleDB alternative record (ADR-05) |
| `load-fixtures.mjs` | Zero-dependency deterministic fixture loader (stdout SQL) |
| `check.mjs` + `package.json` | Static gate run by `pnpm test` inside `database/` |
| `../fixtures/database/expected-row-counts.json` | Exact per-table INSERT counts the loader must produce |

Migrations are append-only (repository gate `node scripts/gate.mjs migrations`);
never edit a merged file, always add `V<yyyyMMddHHmm>__WD-003_*.sql`. Monthly
observation partitions are added the same way (a `DEFAULT` partition currently
catches strays as an alerting signal, not a data path).

## Seeding a disposable database

```bash
psql "<disposable-db>" -v ON_ERROR_STOP=1 -f database/migrations/V202610211200__WD-003_core_model.sql
psql "<disposable-db>" -v ON_ERROR_STOP=1 -f database/migrations/V202610211201__WD-003_publication_views.sql
psql "<disposable-db>" -v ON_ERROR_STOP=1 -f database/migrations/V202610211202__WD-003_roles.sql
node database/load-fixtures.mjs | psql "<disposable-db>" -v ON_ERROR_STOP=1 -f -
```

The loader reads the WD-002 contract fixtures (`fixtures/contracts/*.json`),
validates them against `seed-manifest.json` counts, and emits deterministic,
idempotent SQL (stable row ordering, explicit columns, `ON CONFLICT DO
NOTHING`). Record identifiers are UUIDv5 values derived from a fixed namespace
(`9d1c0a44-6f7b-4a9e-8b2d-3c5f0e7a1b68`) and the fixture key, so a re-run
converges; changing the namespace re-keys every derived identifier.
`fixtures/database/expected-row-counts.json` pins the exact per-table counts
(165 INSERTs across 21 seeded tables; 8 further tables exist with zero fixture
rows).

## Static gate

```bash
cd database && pnpm test        # == node check.mjs
```

Checks: migration filename pattern; PRIMARY KEY on every `CREATE TABLE`
(partition children exempt - they inherit it); publication views declare
explicit column lists containing none of the forbidden columns (`gate_code`,
`internal_note`, `owner_contact`, `credential`, `password`); a forbidden-column
regex scan across all migration SQL confining those names to the private
`water.station_internal_detail` table; and the loader's emitted counts matching
`expected-row-counts.json` exactly across a deterministic double run. Node
built-ins only - the package declares no dependencies.

## Roles and provisioning

The roles migration creates functional NOLOGIN group roles; the DBA provisions
login accounts out-of-band (secrets live in the approved secret store, never in
migrations):

- `neoserver_pub` - NeoServer publication account (ADR-04): SELECT on
  `v_public_stations` and `v_public_station_summary` only. The cohort stub is
  intentionally not granted.
- `app_read` - application backend reads; row/field authorization is the
  backend's job.
- `app_write` - application DML; append-only tables get INSERT/SELECT only
  (immutability is additionally trigger-enforced).
- `app_migrate` - migration operator; **the only role with DDL** on schema
  `water`.

## Design invariants worth preserving

- Originals are immutable (trigger-enforced); corrections append revisions and
  never overwrite (ADR-06). Physical deletion needs a ratified retention rule
  and an operator with the trigger disabled.
- Uniqueness on the partitioned observation table always includes the
  partitioning column - never UUID-only (technical specification TimescaleDB
  caution; this is what makes the Timescale alternative convertible).
- Publication safety is by construction: the restricted internal block lives in
  `station_internal_detail`, which no view references and no publication role
  can read; a public station carrying restricted fields (fixture
  `sta-bear-corinne`, FR-049) still cannot leak them into tiles, GeoJSON or WFS.
- Owner linkage, contact data and diagnostic series are absent from the public
  projection by column list, not by `WHERE`.
- Timestamps are UTC instants; `source_offset` keeps DST reconstructible;
  station `time_zone` (America/Denver) governs display and reporting days.
- A missing reading is the absence of a row plus a `declared_gap` entry -
  never a zero and never silent interpolation.
