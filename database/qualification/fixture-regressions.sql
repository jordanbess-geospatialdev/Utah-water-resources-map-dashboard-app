-- DISPOSABLE FIXTURE DATABASE ONLY. Apply every migration and seed twice first.
-- Unlike queries.sql this suite temporarily changes a fixture station to test
-- publication policy, then rolls back. psql -v ON_ERROR_STOP=1 -f this-file.sql
BEGIN;

DO $$
DECLARE
    fixture_station uuid;
    lifecycle text;
    audience text;
    expected integer;
    actual integer;
BEGIN
    IF (SELECT count(*) FROM water.station) <> 6 OR
       (SELECT count(*) FROM water.observation_original) <> 69 OR
       (SELECT count(*) FROM water.observation_revision) <> 4 THEN
        RAISE EXCEPTION 'Fixture row counts are incorrect; apply fixtures twice to verify idempotence';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM water.vocab_observed_property
                   WHERE observed_property_id = 'discharge' AND canonical_unit_id = 'cfs') OR
       (SELECT count(*) FROM water.vocab_unit) <> 3 OR
       (SELECT count(*) FROM water.vocab_qualifier) <> 2 OR
       (SELECT count(*) FROM water.vocab_processing_level) <> 4 THEN
        RAISE EXCEPTION 'Fixture vocabulary identifiers or canonical units were not mapped';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM water.distribution_system child
                   JOIN water.distribution_system parent ON parent.system_id = child.parent_system_id
                   WHERE child.system_key = 'sub-bear-logan-canyon'
                     AND parent.system_key = 'sys-bear-river'
                     AND child.state_codes = ARRAY[]::text[]) THEN
        RAISE EXCEPTION 'Subgroup parent or empty state array was not seeded';
    END IF;
    IF has_table_privilege('neoserver_pub', 'water.station', 'SELECT') OR
       has_table_privilege('neoserver_pub', 'water.station_internal_detail', 'SELECT') OR
       NOT has_table_privilege('neoserver_pub', 'water.v_public_stations', 'SELECT') THEN
        RAISE EXCEPTION 'Publication account grants do not preserve the view-only boundary';
    END IF;

    SELECT station_id INTO STRICT fixture_station FROM water.station WHERE station_key = 'sta-bear-corinne';
    FOREACH audience IN ARRAY ARRAY['public', 'restricted', 'internal'] LOOP
        FOREACH lifecycle IN ARRAY ARRAY['active', 'inactive', 'proposed', 'retired'] LOOP
            UPDATE water.station SET visibility = audience, status = lifecycle WHERE station_id = fixture_station;
            expected := CASE WHEN audience = 'public' AND lifecycle IN ('active', 'inactive') THEN 1 ELSE 0 END;
            SELECT count(*) INTO actual FROM water.v_public_stations WHERE station_id = fixture_station;
            IF actual <> expected THEN
                RAISE EXCEPTION 'Station publication mismatch for visibility % / status %', audience, lifecycle;
            END IF;
            SELECT count(*) INTO actual FROM water.v_public_station_summary WHERE station_id = fixture_station;
            IF actual <> expected THEN
                RAISE EXCEPTION 'Summary publication mismatch for visibility % / status %', audience, lifecycle;
            END IF;
        END LOOP;
    END LOOP;
END
$$;

ROLLBACK;
