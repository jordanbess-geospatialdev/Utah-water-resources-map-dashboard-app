-- V202610211202__WD-003_roles.sql
-- Database role separation (architecture, "Trust and data publication boundaries"):
--
--   neoserver_pub  publication read account for the NeoServer map service.
--                  SELECT on the publication views ONLY. No base-table access,
--                  no internal notes, no owner tables, no detail blocks.
--   app_read       application backend read paths (scoped queries, history).
--   app_write      application backend write paths. Append-only tables get
--                  INSERT/SELECT only (immutability is additionally enforced
--                  by triggers on originals and revisions).
--   app_migrate    migration operator. MIGRATION OPERATORS ALONE HOLD DDL:
--                  CREATE/ALTER/DROP in schema water is granted to this role
--                  only. Ingestion, publication and application accounts never
--                  receive schema privileges.
--
-- These are functional group roles (NOLOGIN). The DBA provisions the actual
-- login accounts out-of-band and grants them membership; secrets are managed
-- by the approved secret store, never inside migrations.
--
-- Role creation is idempotent (CREATE ROLE has no IF NOT EXISTS).

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neoserver_pub') THEN
        CREATE ROLE neoserver_pub NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_read') THEN
        CREATE ROLE app_read NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_write') THEN
        CREATE ROLE app_write NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrate') THEN
        CREATE ROLE app_migrate NOLOGIN NOINHERIT;
    END IF;
END
$$;

COMMENT ON ROLE neoserver_pub IS 'NeoServer publication read account (ADR-04): SELECT on water.v_public_stations and water.v_public_station_summary only. Must never gain base-table or internal-detail privileges.';
COMMENT ON ROLE app_read IS 'Application backend read account: SELECT across schema water. Row/field authorization is evaluated by the application backend, not by this grant.';
COMMENT ON ROLE app_write IS 'Application backend write account: DML on workflow tables. Append-only tables (observation_original, observation_revision, revision_qualifier, audit_event) receive INSERT/SELECT only; outbox_event adds UPDATE for claim/retry.';
COMMENT ON ROLE app_migrate IS 'Migration operator group: the ONLY role with DDL (CREATE on schema water). Runs the migration chain; nothing else may create, alter or drop objects. NOINHERIT so its privileges are never accidentally assumed by a shared session.';

-- -----------------------------------------------------------------------------
-- Schema access
-- -----------------------------------------------------------------------------
REVOKE ALL ON SCHEMA water FROM PUBLIC;
GRANT USAGE ON SCHEMA water TO neoserver_pub, app_read, app_write, app_migrate;
GRANT CREATE ON SCHEMA water TO app_migrate;
COMMENT ON SCHEMA water IS 'Utah Water Measurement Data Dashboard data model. DDL: app_migrate only. Publication reads: the views in V202610211201 only, via neoserver_pub.';

-- -----------------------------------------------------------------------------
-- neoserver_pub: publication views ONLY.
-- v_cohort_water_owners is deliberately NOT granted: the cohort stub is empty
-- and its membership is unproven (see the publication-views migration).
-- -----------------------------------------------------------------------------
GRANT SELECT ON water.v_public_stations TO neoserver_pub;
GRANT SELECT ON water.v_public_station_summary TO neoserver_pub;

-- Belt and braces: no table in schema water is readable by the publication
-- account even if a future view accidentally exposes one.
REVOKE ALL ON ALL TABLES IN SCHEMA water FROM neoserver_pub;
GRANT SELECT ON water.v_public_stations TO neoserver_pub;
GRANT SELECT ON water.v_public_station_summary TO neoserver_pub;

-- -----------------------------------------------------------------------------
-- app_read: read everything (authorization happens in the application backend).
-- -----------------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA water TO app_read;

-- -----------------------------------------------------------------------------
-- app_write: DML per table class.
-- -----------------------------------------------------------------------------
-- Workflow tables: full DML.
GRANT SELECT, INSERT, UPDATE, DELETE ON
    water.distribution_system,
    water.provider,
    water.organization,
    water.principal,
    water.station,
    water.station_external_id,
    water.station_internal_detail,
    water.station_group_membership,
    water.datastream,
    water.device_deployment,
    water.rating_curve,
    water.rating_shift,
    water.site_visit,
    water.site_visit_attachment,
    water.qc_rule,
    water.qc_rule_run,
    water.qc_result,
    water.declared_gap,
    water.assignment
TO app_write;

-- Capability join table: membership changes only.
GRANT SELECT, INSERT, DELETE ON water.assignment_capability TO app_write;

-- Append-only measurement history: INSERT/SELECT only. UPDATE and DELETE are
-- additionally rejected by trigger (ADR-06); physical deletion of originals
-- requires a separately ratified retention rule executed by the migration
-- operator with the trigger explicitly disabled.
GRANT SELECT, INSERT ON water.observation_original TO app_write;
GRANT SELECT, INSERT ON water.observation_revision TO app_write;
GRANT SELECT, INSERT ON water.revision_qualifier TO app_write;
GRANT SELECT, INSERT ON water.audit_event TO app_write;

-- Transactional outbox: workers claim and retry (ADR-10).
GRANT SELECT, INSERT, UPDATE ON water.outbox_event TO app_write;

-- Identity sequences for audit_event / outbox_event inserts.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA water TO app_write;

-- -----------------------------------------------------------------------------
-- Default privileges for objects the migration operator creates later, so an
-- appended migration does not silently widen or narrow access. The roles
-- migration remains the authoritative record: append a new roles migration
-- whenever a new object class appears.
-- -----------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA water
    GRANT SELECT ON TABLES TO app_read;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA water
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_write;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA water
    GRANT USAGE ON SEQUENCES TO app_write;
