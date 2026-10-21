-- V202610211201__WD-003_publication_views.sql
-- SELECT-only spatial publication layer (ADR-04, mandatory architecture control).
--
-- NeoServer reads ONLY the views in this file, through the neoserver_pub role
-- granted in V202610211202__WD-003_roles.sql. Everything else in schema water is
-- invisible to it.
--
-- PROJECTION SAFETY - ABSENCE BY CONSTRUCTION
--   Every view below projects an EXPLICIT column list. The restricted internal
--   detail block, owner affiliation, contact data, service secrets and
--   diagnostic data are absent because they are NOT in the column list - never
--   because a WHERE clause hides them. A hidden map label does not remove a
--   property from downloaded tile bytes, so field-level absence is the only
--   acceptable mechanism for MVT, GeoJSON and WFS alike (architecture, "Trust
--   and data publication boundaries"; fixture sta-bear-corinne is public yet
--   carries a restricted internal block - FR-049).
--   database/check.mjs enforces mechanically that the forbidden columns never
--   appear in any view defined by these migrations.
--
-- ROW SCOPE
--   visibility = 'public' additionally limits WHICH stations appear. This is
--   defense in depth on top of projection safety, not a substitute for it:
--   restricted and internal stations (owner-operated and diagnostic fixtures)
--   are out of scope for the public layer entirely.

-- =============================================================================
-- v_public_stations - statewide public station layer
-- Serves OGC API Features / Tiles / WFS / WMS station collections.
-- =============================================================================
CREATE OR REPLACE VIEW water.v_public_stations
    (station_id, station_key, display_name, system_key, system_name, provider_key,
     provider_name, site_type_id, water_source_type_id, status, telemetry,
     state_code, elevation_ft, geom) AS
SELECT
    s.station_id,
    s.station_key,
    s.display_name,
    ds.system_key,
    ds.name,
    p.provider_key,
    p.name,
    s.site_type_id,
    s.water_source_type_id,
    s.status,
    s.telemetry,
    s.state_code,
    s.elevation_ft,
    s.geom
FROM water.station s
JOIN water.distribution_system ds ON ds.system_id = s.system_id
LEFT JOIN water.provider p ON p.provider_id = s.provider_id
WHERE s.visibility = 'public';

COMMENT ON VIEW water.v_public_stations IS 'PUBLIC publication projection of stations (ADR-04). Explicit column list only: the restricted internal block, owner linkage and any service-side detail are absent BY CONSTRUCTION (not filtered). Read by neoserver_pub only.';
COMMENT ON COLUMN water.v_public_stations.station_id IS 'Stable internal UUID; safe to publish. Display names are never identifiers (fixture pair shares one display name).';
COMMENT ON COLUMN water.v_public_stations.geom IS 'EPSG:4326 point, PostGIS axis order (longitude, latitude).';
COMMENT ON COLUMN water.v_public_stations.status IS 'Lifecycle state stays visible; publication class is governed by station.visibility, and only public rows reach this view.';

-- =============================================================================
-- v_public_station_summary - public overview / freshness
-- Aggregates ONLY public datastreams, so internal diagnostic series (e.g.
-- equipment voltage) are structurally outside this projection: they never join
-- in. Missing readings are not zeros - freshness is min/max over rows that
-- actually exist, and gap detail belongs to the domain API, not this view.
-- =============================================================================
CREATE OR REPLACE VIEW water.v_public_station_summary
    (station_id, station_key, display_name, telemetry, public_stream_keys,
     public_stream_count, observed_properties, earliest_observed_time,
     latest_observed_time, latest_received_at) AS
SELECT
    s.station_id,
    s.station_key,
    s.display_name,
    s.telemetry,
    coalesce(array_agg(DISTINCT d.datastream_key ORDER BY d.datastream_key) FILTER (WHERE d.datastream_key IS NOT NULL), '{}') AS public_stream_keys,
    count(DISTINCT d.datastream_id) AS public_stream_count,
    coalesce(array_agg(DISTINCT d.observed_property_id ORDER BY d.observed_property_id) FILTER (WHERE d.observed_property_id IS NOT NULL), '{}') AS observed_properties,
    min(o.observed_time) AS earliest_observed_time,
    max(o.observed_time) AS latest_observed_time,
    max(o.received_at) AS latest_received_at
FROM water.station s
LEFT JOIN water.datastream d
       ON d.station_id = s.station_id
      AND d.visibility = 'public'
      AND (d.effective_from IS NULL OR d.effective_from <= now())
      AND (d.effective_to IS NULL OR d.effective_to > now())
LEFT JOIN water.observation_original o
       ON o.stream_id = d.datastream_id
WHERE s.visibility = 'public'
GROUP BY s.station_id, s.station_key, s.display_name, s.telemetry;

COMMENT ON VIEW water.v_public_station_summary IS 'PUBLIC overview summary: public stream inventory and observed-data freshness per station. Diagnostic and restricted streams are excluded structurally (join on visibility = public), and absent fields stay absent by construction.';
COMMENT ON COLUMN water.v_public_station_summary.latest_received_at IS 'Ingestion-side freshness (max received_at), distinct from observation time: late arrivals (fixture obs-q-005) do not fake observation-time freshness.';

-- =============================================================================
-- v_cohort_water_owners - PRIVATE COHORT STUB (DO NOT USE AS-IS)
--
-- Intended shape: stations a proven water-owner cohort may see together with
-- the fields approved for every member of that cohort. A private cohort
-- service is valid ONLY where all members may see ALL published features and
-- fields in the cohort (architecture, "Trust and data publication boundaries").
--
-- The stub is deliberately EMPTY BY CONSTRUCTION (WHERE false): cohort
-- membership has NOT been proven, so no row and no field may leave the
-- database through it. Before first use someone must (a) prove membership for
-- every member, (b) ratify the field set, and (c) extend this view and grant
-- it in the roles migration. Until then it is intentionally NOT granted to
-- neoserver_pub or any other role.
-- =============================================================================
CREATE OR REPLACE VIEW water.v_cohort_water_owners
    (station_id, station_key, display_name, geom) AS
SELECT
    s.station_id,
    s.station_key,
    s.display_name,
    s.geom
FROM water.station s
WHERE false;

COMMENT ON VIEW water.v_cohort_water_owners IS 'STUB - EMPTY BY CONSTRUCTION. Cohort membership must be proven before use: all members must be entitled to every feature and field this cohort view would expose. Do not grant to any publication role until that proof is recorded. Dynamic owner or arbitrary site assignments stay behind the application backend or a separately proven principal-aware spatial service.';
