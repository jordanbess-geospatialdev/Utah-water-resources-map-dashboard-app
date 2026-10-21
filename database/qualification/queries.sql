-- database/qualification/queries.sql
-- READ-ONLY deployment qualification pack for the Utah Water Measurement Data
-- Dashboard database baseline (WD-003).
--
-- WHY THIS EXISTS
--   No live database was accessed while authoring the migrations. ADR-05 and
--   decision DR-009/DR-005 (database service and extensions; TimescaleDB
--   feasibility) are OPEN: Cloud SQL vs self-managed PostgreSQL must be
--   inventoried before any production schema work. This file is the evidence
--   checklist the DWRi DBA / cloud owner runs against the actual service.
--
-- HOW TO RUN (read-only; nothing here mutates state)
--   psql "<connection string>" -v ON_ERROR_STOP=1 --single-transaction -f database/qualification/queries.sql
--   or, to be explicit about the read-only contract:
--   psql "<connection string>" -c "BEGIN READ ONLY" -f ... (see README.md)
--   EXPLAIN ANALYZE executes the underlying SELECTs; the immutability triggers
--   and role grants are untouched, and no rows are written.
--
-- Sections
--   1. Service inventory (decision input for DR-009/DR-005)
--   2. Private-field absence proof for the publication views
--   3. Representative EXPLAIN ANALYZE proofs (GiST bbox, bounded month scan,
--      revision history by logical key)

-- =============================================================================
-- 1. SERVICE INVENTORY (verbatim from the architecture decision record)
-- =============================================================================

-- 1a. Exact PostgreSQL build. Record it next to the deployment decision.
SELECT version();

-- 1b. Installed extensions with versions. Expect postgis present.
--     timescaledb present would reopen ADR-05 (see TIMESCALE-ALTERNATIVE.md).
SELECT extname, extversion FROM pg_extension ORDER BY extname;

-- 1c. Availability of postgis / timescaledb on this service.
SELECT name, default_version, installed_version
FROM pg_available_extensions
WHERE name IN ('postgis', 'timescaledb');

-- 1d. Supplemental: confirm the PostGIS geometry type and GiST access method
--     are usable in this database (the baseline depends on both).
SELECT postgis_full_version();
SELECT amname FROM pg_am WHERE amname = 'gist';

-- =============================================================================
-- 2. PRIVATE-FIELD ABSENCE PROOF (publication projection safety, ADR-04)
--    All three proofs must be run AFTER V202610211201__WD-003_publication_views.sql.
--    Each query states its expected result; a deviation is a release blocker.
-- =============================================================================

-- 2a. Diff of station columns NOT projected by v_public_stations.
--     Expected: owner_organization_id, version, created_at, updated_at,
--     system_id, provider_id, visibility (internal identifiers/stamps and
--     the publication classification) - and NOTHING ELSE
--     that is descriptive of the station. The restricted detail block lives in
--     water.station_internal_detail, which this view never references.
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'water' AND table_name = 'station'
EXCEPT
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'water' AND table_name = 'v_public_stations'
ORDER BY column_name;

-- 2b. RESTRICTED-COLUMN ABSENCE ASSERTION. Expected result: 0 rows.
--     Any row means a restricted column exists on a publication view and the
--     release is blocked (fix the view; do not widen this list).
WITH restricted(column_name) AS (
    VALUES
        ('gate_code'),
        ('wiring_notes'),
        ('internal_note'),
        ('owner_contact'),
        ('owner_organization_id'),
        ('credential'),
        ('password')
), projected AS (
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'water'
      AND table_name IN ('v_public_stations', 'v_public_station_summary', 'v_cohort_water_owners')
)
SELECT r.column_name, p.table_name
FROM restricted r
JOIN information_schema.columns p
  ON p.column_name = r.column_name
 AND p.table_schema = 'water'
 AND p.table_name  IN ('v_public_stations', 'v_public_station_summary', 'v_cohort_water_owners');

-- 2c. ALLOWLIST PARITY. Expected result: 0 rows and a count of 14.
--     Every v_public_stations column must be one of the 14 approved names -
--     absence of the restricted set is necessary but not sufficient; no
--     unapproved column may ride along either.
WITH approved(column_name) AS (
    VALUES
        ('station_id'), ('station_key'), ('display_name'),
        ('system_key'), ('system_name'),
        ('provider_key'), ('provider_name'),
        ('site_type_id'), ('water_source_type_id'),
        ('status'), ('telemetry'), ('state_code'),
        ('elevation_ft'), ('geom')
), projected AS (
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'water' AND table_name = 'v_public_stations'
)
SELECT column_name FROM projected
WHERE column_name NOT IN (SELECT column_name FROM approved);

SELECT count(*) AS v_public_stations_column_count -- expected 14
FROM information_schema.columns
WHERE table_schema = 'water' AND table_name = 'v_public_stations';

-- 2d. PRIVILEGE PROOF. Expected: exactly the two publication views for
--     neoserver_pub, and nothing else (no base tables, no cohort stub).
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'neoserver_pub' AND table_schema = 'water'
ORDER BY table_name;

-- =============================================================================
-- 3. REPRESENTATIVE EXPLAIN ANALYZE PROOFS
--    Run these on the seeded disposable database (migrations + load-fixtures
--    output) with realistic data volume. Fixtures are intentionally small;
--    the plans, not the timings, are the evidence at fixture scale.
-- =============================================================================

-- 3a. Bbox station lookup through the publication view via the GiST index.
--     Expected plan: Bitmap/Index Scan using station_geom_gix on
--     water.station, with the view's visibility predicate applied; no
--     sequential scan on station at production volume.
EXPLAIN (ANALYZE, BUFFERS)
SELECT station_id, display_name, geom
FROM water.v_public_stations
WHERE geom && public.ST_MakeEnvelope(-112.25, 41.20, -111.40, 42.00, 4326);

-- 3b. One-month bounded series scan on the partitioned originals.
--     Expected plan: partition pruning to observation_original_2026_03 ONLY,
--     served by observation_original_stream_time_idx; the 2026-02 partition
--     and the default partition must not appear.
EXPLAIN (ANALYZE, BUFFERS)
SELECT observation_id, observed_time, source_value, source_unit_id, value_type, processing_level
FROM water.observation_original
WHERE stream_id = (SELECT datastream_id FROM water.datastream WHERE datastream_key = 'str-corinne-q')
  AND observed_time >= '2026-03-01T00:00:00Z'
  AND observed_time <  '2026-04-01T00:00:00Z'
ORDER BY observed_time;

-- 3c. Revision history by logical key (stream + observed instant + source
--     event). Expected plan: index scan on the logical-key unique index
--     (stream pruning via the subquery) joined to
--     observation_revision_observation_idx; ordered by revision_version.
EXPLAIN (ANALYZE, BUFFERS)
SELECT r.revision_id, r.revision_type, r.value, r.unit_id, r.processing_level,
       r.reason, r.actor_principal_id, r.recorded_at, r.revision_version,
       r.base_revision_id
FROM water.observation_revision r
JOIN water.observation_original o
  ON o.observation_id = r.observation_id
 AND o.observed_time = r.observed_time
WHERE o.stream_id = (SELECT datastream_id FROM water.datastream WHERE datastream_key = 'str-corinne-q')
  AND o.observed_time = '2026-03-08T02:00:00Z'
  AND o.source_event_id = 'ev-corinne-q-20260308T0200Z'
ORDER BY r.revision_version;

-- 3d. (Optional cross-check) Immutability proof: this MUST raise
--     'water.observation_original is append-only'. Run manually and expect
--     the error; it is intentionally left commented so -f runs stay green.
-- UPDATE water.observation_original SET source_value = 0 WHERE true;
