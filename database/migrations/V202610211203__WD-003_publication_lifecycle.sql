-- Align SQL publication with policy.isCurrentlyPublished: active and inactive
-- public stations remain readable; proposed and retired stations do not.
-- Append-only correction: preserve historical migrations and view columns.

CREATE OR REPLACE VIEW water.v_public_stations
    (station_id, station_key, display_name, system_key, system_name, provider_key,
     provider_name, site_type_id, water_source_type_id, status, telemetry,
     state_code, elevation_ft, geom) AS
SELECT
    s.station_id, s.station_key, s.display_name, ds.system_key, ds.name,
    p.provider_key, p.name, s.site_type_id, s.water_source_type_id, s.status,
    s.telemetry, s.state_code, s.elevation_ft, s.geom
FROM water.station s
JOIN water.distribution_system ds ON ds.system_id = s.system_id
LEFT JOIN water.provider p ON p.provider_id = s.provider_id
WHERE s.visibility = 'public' AND s.status IN ('active', 'inactive');

COMMENT ON COLUMN water.v_public_stations.status IS 'Only public active or inactive stations are currently published, matching the policy engine. Proposed and retired stations are excluded.';

CREATE OR REPLACE VIEW water.v_public_station_summary
    (station_id, station_key, display_name, telemetry, public_stream_keys,
     public_stream_count, observed_properties, earliest_observed_time,
     latest_observed_time, latest_received_at) AS
SELECT
    s.station_id, s.station_key, s.display_name, s.telemetry,
    coalesce(array_agg(DISTINCT d.datastream_key ORDER BY d.datastream_key) FILTER (WHERE d.datastream_key IS NOT NULL), '{}'),
    count(DISTINCT d.datastream_id),
    coalesce(array_agg(DISTINCT d.observed_property_id ORDER BY d.observed_property_id) FILTER (WHERE d.observed_property_id IS NOT NULL), '{}'),
    min(o.observed_time), max(o.observed_time), max(o.received_at)
FROM water.station s
LEFT JOIN water.datastream d
       ON d.station_id = s.station_id
      AND d.visibility = 'public'
      AND (d.effective_from IS NULL OR d.effective_from <= now())
      AND (d.effective_to IS NULL OR d.effective_to > now())
LEFT JOIN water.observation_original o ON o.stream_id = d.datastream_id
WHERE s.visibility = 'public' AND s.status IN ('active', 'inactive')
GROUP BY s.station_id, s.station_key, s.display_name, s.telemetry;
