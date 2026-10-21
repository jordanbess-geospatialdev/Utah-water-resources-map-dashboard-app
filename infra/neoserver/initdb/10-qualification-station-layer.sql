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

-- PUBLICATION VIEW (what NeoServer may read): approved fields only.
CREATE OR REPLACE VIEW qualification.stations_public_v AS
SELECT
    station_id,
    display_name,
    status,
    ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS geom
FROM qualification.station_all
WHERE visibility = 'public';

-- Restricted cohort view: same shape, restricted rows only. A cohort
-- workspace is valid only where every member may see every published field
-- in it (architecture: "Trust and data publication boundaries").
CREATE OR REPLACE VIEW qualification.stations_cohort_v AS
SELECT
    station_id,
    display_name,
    status,
    ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS geom
FROM qualification.station_all
WHERE visibility = 'restricted';

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

-- Defense in depth: explicitly no access to the originals for the reader role.
REVOKE ALL ON qualification.station_all FROM neoserver_reader;

-- Spatial index for tile/feature queries.
CREATE INDEX IF NOT EXISTS station_all_geom_idx
    ON qualification.station_all USING gist (ST_SetSRID(ST_MakePoint(lon, lat), 4326));
