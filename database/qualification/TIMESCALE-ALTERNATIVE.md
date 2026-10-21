# TimescaleDB alternative record (ADR-05 / DR-005 / DR-009)

Status: NOT chosen for the baseline. The WD-003 migrations are Cloud SQL
compatible: native PostgreSQL declarative `PARTITION BY RANGE (observed_time)`
with monthly partitions, and no TimescaleDB-specific DDL anywhere. This file
records when and how a qualified TimescaleDB deployment could replace the
native partitioning, per the technical specification's TimescaleDB caution.

## Trigger conditions for choosing TimescaleDB

All of the following must hold before any conversion work starts:

1. **Inventory says it is real.** `database/qualification/queries.sql` section 1
   shows `timescaledb` in `pg_extension` (installed, not merely available) on
   the actual existing service, which is self-managed PostgreSQL on a GCP
   VM/Kubernetes or an approved compatible service - not Cloud SQL, whose
   supported-extension list does not include it.
2. **Version compatibility is pinned.** The TimescaleDB version is qualified
   against the exact PostgreSQL version, and the DBA/cloud owner accepts
   ownership of extension upgrades, HA, backup and license terms (Apache-2
   community edition vs Enterprise features used).
3. **A scale problem native partitioning cannot meet is measured.** For
   example: compression of multi-year hourly series, continuous aggregates for
   the policy summary views, or faster bounded-range scans than the native
   B-tree + partition pruning shown in the qualification plans.
4. **A staging restore drill passed.** The conversion is executed against a
   restored production snapshot and the qualification EXPLAIN ANALYZE set is
   re-run and compared before any production cutover.

If any condition fails, stay on the native baseline. It preserves the same API
semantics (the technical specification explicitly allows this).

## Conversion notes

Worked against the baseline in
`database/migrations/V202610211200__WD-003_core_model.sql`:

- **Hypertable creation.** `create_hypertable()` cannot convert a table that is
  already a declaratively partitioned parent. Either create a fresh
  `observation_original` hypertable and copy data, or detach the monthly
  partitions and run
  `SELECT create_hypertable('water.observation_original', 'observed_time', chunk_time_interval => INTERVAL '1 month', migrate_data => true);`
  then re-attach nothing (chunks replace partitions). Drop
  `observation_original_default`; a default partition and hypertable chunking
  do not mix.
- **Uniqueness under partitioning (the tech-spec caution).** Hypertable
  PRIMARY KEY / UNIQUE constraints must include the partitioning column.
  The baseline keys already comply - keep them verbatim:
  - `PRIMARY KEY (observation_id, observed_time)`
  - `UNIQUE (stream_id, observed_time, source_event_id)`
  Never replace these with UUID-only uniqueness; that is exactly the failure
  mode the specification warns about.
- **Foreign keys referencing the hypertable.** `observation_revision` and
  `qc_result` carry composite FKs `(observation_id, observed_time)` into the
  partitioned target. Depending on the installed TimescaleDB/PostgreSQL
  version, FKs *referencing* a hypertable may be unsupported. This must be part
  of the qualification test; the fallback is to drop those two FKs, keep the
  `(observation_id, observed_time)` columns, and enforce integrity in the
  application transaction plus the logical-key indexes. This is why the
  baseline keys revisions by the composite identity rather than by a bare UUID.
- **Immutability triggers.** `observation_original_is_immutable()` and the
  append-only trigger on `observation_revision` stay unchanged; triggers work
  the same on hypertables.
- **Roles and publication views.** Nothing in
  `V202610211202__WD-003_roles.sql` or the publication views touches storage
  layout; the neoserver_pub projection guarantees are unaffected. Optionally,
  continuous aggregates can later back `v_public_station_summary` freshness
  columns, but the view's column list must stay identical (allowlist proof 2c
  in `queries.sql` must keep passing).
- **Migration chain.** The conversion ships as an appended migration (never
  edit `V202610211200`), together with a rollback note (reattach monthly
  partitions, restore native parent) and updated `queries.sql` evidence.

## Decision evidence to file

When this alternative is exercised, attach to the decision record: inventory
query output, TimescaleDB/PostgreSQL versions, staging restore drill report,
before/after EXPLAIN ANALYZE plans, and the owner sign-offs required by the
architecture's release-qualification table.
