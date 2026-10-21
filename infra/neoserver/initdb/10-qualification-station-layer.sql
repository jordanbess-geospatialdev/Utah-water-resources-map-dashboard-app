-- =============================================================================
-- WD-005 qualification seed: a small SYNTHETIC station layer for NeoServer.
--
-- Data source: fixtures/contracts/stations.json (frozen contract fixture
-- world, seed utah-water-fixture-v1). All rows are synthetic; no real
-- measurements, gate codes or credentials appear here - the gate_code column
-- below carries an obviously-fake marker string on purpose: it is the
-- canary the capture harness greps for (it must NEVER appear in any
-- captured Feature/tile/capabilities artifact).
--
-- Pattern per docs/product/baseline/02-technical-specification.md, "NeoServer
-- and map transport": spatial PUBLICATION VIEWS contain only approved
-- fields; the NeoServer database account gets SELECT on the views, without
-- access to originals, internal notes or gate codes. In this disposable
-- stack the database user is the local superuser, but the view + grant
-- structure is the production shape and the capture assertions still hold.
--
-- T-05 DEFECT FIX (D7, CAPTURE-REPORT.md section 4): NeoServer 0.3.0 MVT
-- generation requires an INTEGER feature-id column (mvt_agg_transfn: "Could
-- not find column 'id' of integer type"). These views originally exposed
-- none, forcing the qualification into a layer sql_view with
-- row_number() OVER () AS id - whose assignment order Postgres does NOT
-- guarantee, so identical data produced different MVT feature ids and
-- therefore different tile BYTES between runs (run-3 vs run-4 control-tile
-- shas differed). The views now expose a STABLE integer id derived
-- deterministically from the station key (see qualification.station_key_id
-- below), so identical data yields identical tile bytes across restarts
-- and reseeds - and the layer needs NO sql_view at all (create it directly
-- over the view with id_column "id"; see qualification/KNOWN-SERVER-
-- BEHAVIOR.md before reaching for a sql_view).
-- Owner: spatial_integration.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS qualification;

-- Base table (originals): includes fields that must NEVER be published.
CREATE TABLE IF NOT EXISTS qualification.station_all (
    station_id   text PRIMARY KEY,
    display_name text NOT NULL,
    status       text NOT NULL,
    visibility   text NOT NULL,
    lat          double precision NOT NULL,
    lon          double precision NOT NULL,
    internal_notes text NOT NULL DEFAULT '',
    gate_code    text NOT NULL DEFAULT 'SYNTHETIC-NEVER-PUBLISH'
);

-- Synthetic public stations from the fixture world (coordinates are the
-- Utah control points used across WD-005: lat ~41.6, lon ~-112/-111).
INSERT INTO qualification.station_all (station_id, display_name, status, visibility, lat, lon, internal_notes) VALUES
    ('sta-bear-corinne',          'Bear River near Corinne',      'active', 'public', 41.6337, -112.1965, 'SYNTHETIC internal note - never publish'),
    ('sta-hyrum-diversion-public','Hyrum Diversion (public)',     'active', 'public', 41.6295, -111.8524, 'SYNTHETIC internal note - never publish'),
    ('sta-summit-creek-inactive', 'Summit Creek',                 'inactive','public', 41.7351, -111.8280, 'SYNTHETIC internal note - never publish'),
    ('sta-hyrum-diversion-owner', 'Hyrum Diversion (owner-only)', 'active', 'restricted', 41.6288, -111.8531, 'SYNTHETIC internal note - never publish');

-- D7 deterministic station-key -> integer id (T-05 CAPTURE-REPORT.md D7).
--
-- Derivation, chosen so identical data ALWAYS yields identical ids across
-- restarts, reseeds and Postgres upgrades:
--   1. md5(station_id) - a frozen, version-stable text hash;
--   2. substr(...,1,8) - the first 8 hex chars = 32 hash bits;
--   3. ('x'||...)::bit(32)::bigint - those bits read as a non-negative
--      32-bit pattern (0 .. 4294967295, no sign issues);
--   4. & 2147483647 - fold to 0 .. 2^31-1 so the result always fits int4.
-- A hash expression (not a serial column) is used deliberately: no sequence
-- state, no insert-order dependence, no mapping table to maintain - the id
-- is a pure function of the station key. NOTE for sql_view users: this is a
-- Postgres-side function living in the seeded schema, NOT something the
-- NeoServer layer sql_view can call (the sql-view function allowlist
-- rejected hashtext during T-05); with this view you should not need a
-- sql_view at all.
CREATE OR REPLACE FUNCTION qualification.station_key_id(k text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
RETURN (('x' || substr(md5(k), 1, 8))::bit(32)::bigint & 2147483647)::int;

COMMENT ON FUNCTION qualification.station_key_id(text) IS
    'D7: deterministic int4 feature id folded from the first 32 md5 bits of the station key; stable across restarts/upgrades; see initdb/10-qualification-station-layer.sql';

-- PUBLICATION VIEW (what NeoServer may read): approved fields only.
-- The leading `id` column is the D7 fix: a STABLE integer feature id.
CREATE OR REPLACE VIEW qualification.stations_public_v AS
SELECT
    qualification.station_key_id(station_id) AS id,
    station_id,
    display_name,
    status,
    ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS geom
FROM qualification.station_all
WHERE visibility = 'public'
-- Best-effort stable feature ORDER for plain `SELECT ... FROM <view>` reads
-- (Postgres applies a view's ORDER BY to direct selects only). The
-- determinism guarantee itself comes from station_key_id, not this clause.
ORDER BY id;

-- Restricted cohort view: same shape, restricted rows only. A cohort
-- workspace is valid only where every member may see every published field
-- in it (architecture: "Trust and data publication boundaries").
-- Same D7 stable integer id as the public view.
CREATE OR REPLACE VIEW qualification.stations_cohort_v AS
SELECT
    qualification.station_key_id(station_id) AS id,
    station_id,
    display_name,
    status,
    ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS geom
FROM qualification.station_all
WHERE visibility = 'restricted'
ORDER BY id;

-- T-05 D7 deterministic-id collision guard: the station_key_id hash fold
-- must never map two station keys to the same integer (a shared MVT feature
-- id would corrupt tile consumers). Fails the seed LOUDLY instead of
-- producing ambiguous tiles. ~2^31 id space: collision odds stay negligible
-- far beyond any qualification dataset (the fixture world has 4 stations).
DO $$
DECLARE
    colliding_groups int;
BEGIN
    SELECT count(*) INTO colliding_groups FROM (
        SELECT 1 FROM qualification.station_all
        GROUP BY qualification.station_key_id(station_id)
        HAVING count(*) > 1
    ) AS collisions;
    IF colliding_groups > 0 THEN
        RAISE EXCEPTION 'D7 deterministic-id collision: % group(s) of qualification.station_all fold to the same station_key_id integer', colliding_groups;
    END IF;
END
$$;

-- Publication read role: SELECT on the VIEWS ONLY.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neoserver_reader') THEN
        CREATE ROLE neoserver_reader NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA qualification TO neoserver_reader;
GRANT SELECT ON qualification.stations_public_v TO neoserver_reader;
GRANT SELECT ON qualification.stations_cohort_v TO neoserver_reader;
-- Views execute their functions with the view owner's privileges by
-- default, but grant EXECUTE explicitly so security_invoker views would
-- keep working too.
GRANT EXECUTE ON FUNCTION qualification.station_key_id(text) TO neoserver_reader;

-- Defense in depth: explicitly no access to the originals for the reader role.
REVOKE ALL ON qualification.station_all FROM neoserver_reader;

-- Spatial index for tile/feature queries.
CREATE INDEX IF NOT EXISTS station_all_geom_idx
    ON qualification.station_all USING gist (ST_SetSRID(ST_MakePoint(lon, lat), 4326));
