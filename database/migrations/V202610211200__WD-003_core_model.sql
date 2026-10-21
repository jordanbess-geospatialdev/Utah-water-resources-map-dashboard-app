-- V202610211200__WD-003_core_model.sql
-- Utah Water Measurement Data Dashboard - core measurement and metadata model.
--
-- Implements the "Measurement and metadata model" entity table of the technical
-- specification (docs/product/baseline/02-technical-specification.md) and the
-- trust boundaries of the architecture (03-architecture.md, ADR-04/ADR-05/ADR-06).
--
-- DEPLOYMENT CONSTRAINTS
--   * Cloud SQL compatible: native PostgreSQL declarative RANGE partitioning,
--     NO TimescaleDB DDL (ADR-05; see database/qualification/TIMESCALE-ALTERNATIVE.md).
--   * PostGIS is required (geometry(Point,4326) on water.station). The extension
--     is created idempotently below and must be pre-approved on the target
--     service (Cloud SQL supports PostGIS in its supported-extension list).
--     CREATE EXTENSION requires elevated privileges: run migrations as the
--     migration operator account (see V202610211202__WD-003_roles.sql).
--   * NO live database was accessed while authoring this file. Every statement
--     here is pending execution under the qualification gate
--     (database/qualification/queries.sql).
--
-- IDENTIFIER POLICY
--   * Record entities use stable UUID primary keys (tech spec: "internal stable
--     UUID identifiers"); the deterministic fixture loader (database/load-fixtures.mjs)
--     derives them as UUIDv5 from fixture keys so seeds are reproducible.
--   * Each record entity also carries a human-readable *_key UNIQUE column
--     (e.g. station_key 'sta-bear-corinne'). Display names are NEVER keys and
--     are not unique (fixture pair sta-hyrum-diversion-public / -owner).
--   * Governed vocabulary tables use their steward-managed code as the PK.
--   * Legacy provider identifiers live ONLY in water.station_external_id as a
--     unique (provider_id, external_id) mapping.

CREATE SCHEMA IF NOT EXISTS water;
COMMENT ON SCHEMA water IS 'Utah Water Measurement Data Dashboard data model. Publication access is only through the views in V202610211201__WD-003_publication_views.sql (ADR-04).';

CREATE EXTENSION IF NOT EXISTS postgis;
COMMENT ON EXTENSION postgis IS 'Station geometry (Point, EPSG:4326). Qualify the product/version via database/qualification/queries.sql before production (DR-009).';

-- =============================================================================
-- Governed vocabulary (steward-managed; FR-012)
-- Only stewards create or retire terms; used terms are never hard-deleted in a
-- way that breaks historical records.
-- =============================================================================

CREATE TABLE water.vocab_unit (
    unit_id     text PRIMARY KEY,
    name        text NOT NULL,
    dimension   text NOT NULL,
    description text
);
COMMENT ON TABLE water.vocab_unit IS 'Governed unit vocabulary. Flow, stage/level and equipment are distinct dimensions and are never silently converted into one another (technical specification, Numerical and temporal rules).';

CREATE TABLE water.vocab_observed_property (
    observed_property_id text PRIMARY KEY,
    name                 text NOT NULL,
    dimension            text NOT NULL,
    canonical_unit_id    text NOT NULL REFERENCES water.vocab_unit (unit_id),
    description          text
);
COMMENT ON COLUMN water.vocab_observed_property.dimension IS 'Dimension gate: a property of dimension flow can never be stored in a unit of dimension level/equipment without a governed conversion.';

CREATE TABLE water.vocab_qualifier (
    qualifier_id text PRIMARY KEY,
    name         text NOT NULL,
    description  text
);
COMMENT ON TABLE water.vocab_qualifier IS 'Governed value qualifiers (e.g. ice-affected, interpolate) attached to revisions, never to originals.';

CREATE TABLE water.vocab_processing_level (
    processing_level_id text PRIMARY KEY,
    name                text NOT NULL,
    description         text,
    rank                integer NOT NULL CHECK (rank >= 1)
);
COMMENT ON TABLE water.vocab_processing_level IS 'Governed processing levels raw < provisional < reviewed < best-available (rank). Reviewed does NOT imply public; publication is a separate decision.';

-- =============================================================================
-- Parties: organizations, principals, providers
-- =============================================================================

CREATE TABLE water.organization (
    organization_id   uuid PRIMARY KEY,
    organization_key  text NOT NULL UNIQUE,
    name              text NOT NULL,
    kind              text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE water.organization IS 'Water-owner and similar organizations. Owner linkage on a station is a restricted fact: it is absent from every publication view by construction.';

CREATE TABLE water.principal (
    principal_id         uuid PRIMARY KEY,
    principal_key        text NOT NULL UNIQUE,
    external_subject_id  text UNIQUE,
    display_name         text NOT NULL,
    account_kind         text NOT NULL DEFAULT 'user' CHECK (account_kind IN ('user', 'service')),
    active               boolean NOT NULL DEFAULT true,
    offboarded_at        timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE water.principal IS 'Actors (people and services). external_subject_id maps the institutional OIDC subject. Identity and name snapshot are preserved after offboarding (active = false, offboarded_at set) without making the account usable.';

CREATE TABLE water.provider (
    provider_id   uuid PRIMARY KEY,
    provider_key  text NOT NULL UNIQUE,
    name          text NOT NULL,
    kind          text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE water.provider IS 'Data providers (telemetry networks, cooperator manual programs). Provider connection credentials are application secrets held outside this schema (never in tables, fixtures or logs).';

-- =============================================================================
-- Distribution systems, groups and subgroups
-- Entity row: "System and group - Stable ID, hierarchy and membership history;
-- universal vocabulary managed by steward."
-- =============================================================================

CREATE TABLE water.distribution_system (
    system_id         uuid PRIMARY KEY,
    system_key        text NOT NULL UNIQUE,
    kind              text NOT NULL CHECK (kind IN ('system', 'subgroup')),
    parent_system_id  uuid REFERENCES water.distribution_system (system_id),
    name              text NOT NULL,
    state_codes       text[] NOT NULL DEFAULT '{}',
    description       text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CHECK (kind = 'system' OR parent_system_id IS NOT NULL),
    CHECK (kind <> 'system' OR parent_system_id IS NULL)
);
COMMENT ON TABLE water.distribution_system IS 'Distribution systems and their governed subgroups (self-referencing hierarchy).';
COMMENT ON COLUMN water.distribution_system.parent_system_id IS 'Subgroups reference their parent system; systems are roots.';

-- =============================================================================
-- Stations
-- Entity row: "Station - Geometry in EPSG:4326, system, provider, status,
-- site/source/structure classifications, visibility, version."
-- =============================================================================

CREATE TABLE water.station (
    station_id            uuid PRIMARY KEY,
    station_key           text NOT NULL UNIQUE,
    display_name          text NOT NULL,
    system_id             uuid NOT NULL REFERENCES water.distribution_system (system_id),
    provider_id           uuid REFERENCES water.provider (provider_id),
    site_type_id          text NOT NULL,
    water_source_type_id  text,
    status                text NOT NULL CHECK (status IN ('proposed', 'active', 'inactive', 'retired')),
    visibility            text NOT NULL CHECK (visibility IN ('public', 'restricted', 'internal')),
    telemetry             text NOT NULL CHECK (telemetry IN ('telemetered', 'manual', 'unknown')),
    state_code            text NOT NULL,
    geom                  public.geometry(Point, 4326) NOT NULL,
    elevation_ft          numeric,
    owner_organization_id uuid REFERENCES water.organization (organization_id),
    version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE water.station IS 'Measurement stations. Stable UUID PK; display_name is never an identifier and may repeat. version supports optimistic concurrency for PATCH /sites/{id}.';
COMMENT ON COLUMN water.station.geom IS 'EPSG:4326 point stored as (longitude, latitude) per PostGIS axis order. Fixtures state coordinates lat-first, so loaders MUST pass (longitude, latitude) to ST_MakePoint - an axis swap displaces Utah points by ~70 degrees.';
COMMENT ON COLUMN water.station.visibility IS 'Record visibility class. A public station may still carry an internal detail block (fixture sta-bear-corinne): row visibility alone is never sufficient (FR-049).';
COMMENT ON COLUMN water.station.owner_organization_id IS 'Restricted fact: owner affiliation is joined only by scoped application queries and is absent from publication views by construction.';

CREATE INDEX station_system_idx ON water.station (system_id);
CREATE INDEX station_visibility_idx ON water.station (visibility);
CREATE INDEX station_geom_gix ON water.station USING gist (geom);
COMMENT ON INDEX water.station_geom_gix IS 'GiST index for bbox/viewport station lookups; exercised by database/qualification/queries.sql.';

-- Legacy external-ID mapping: unique per provider, one station may carry several.
CREATE TABLE water.station_external_id (
    station_external_id  uuid PRIMARY KEY,
    station_id           uuid NOT NULL REFERENCES water.station (station_id),
    provider_id          uuid NOT NULL REFERENCES water.provider (provider_id),
    external_id          text NOT NULL,
    mapped_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider_id, external_id)
);
COMMENT ON TABLE water.station_external_id IS 'Legacy provider/external-ID mapping (tech spec identifier policy). external_id is unique within a provider, never globally.';

-- PRIVATE table: the internal detail block (gate code, wiring notes).
-- This is the ONLY table allowed to carry the restricted columns; publication
-- views never reference it and publication roles never receive privileges on it.
CREATE TABLE water.station_internal_detail (
    station_id    uuid PRIMARY KEY REFERENCES water.station (station_id),
    gate_code     text NOT NULL,
    wiring_notes  text,
    visibility    text NOT NULL DEFAULT 'internal' CHECK (visibility = 'internal')
);
COMMENT ON TABLE water.station_internal_detail IS 'PRIVATE - physical-access and maintenance detail for field staff. Never granted to any publication role; never referenced by any publication view (see check.mjs forbidden-column gate). Kept in a dedicated table so a public station carrying these fields cannot leak them through a star-projection.';

-- Group/subgroup membership with history (half-open validity intervals).
CREATE TABLE water.station_group_membership (
    station_group_membership_id  uuid PRIMARY KEY,
    station_id                   uuid NOT NULL REFERENCES water.station (station_id),
    group_id                     uuid NOT NULL REFERENCES water.distribution_system (system_id),
    effective_from               timestamptz,
    effective_to                 timestamptz,
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from),
    UNIQUE (station_id, group_id, effective_from)
);
COMMENT ON TABLE water.station_group_membership IS 'Membership history [effective_from, effective_to). v0.1.0 fixtures carry only the current snapshot (effective bounds NULL = since inception / still current).';

-- =============================================================================
-- Datastreams
-- Entity row: "Datastream - Station, observed property, unit, method,
-- deployment, time zone, cadence, capacity limits and processing policy."
-- =============================================================================

CREATE TABLE water.datastream (
    datastream_id      uuid PRIMARY KEY,
    datastream_key     text NOT NULL UNIQUE,
    station_id         uuid NOT NULL REFERENCES water.station (station_id),
    observed_property_id text NOT NULL REFERENCES water.vocab_observed_property (observed_property_id),
    unit_id            text NOT NULL REFERENCES water.vocab_unit (unit_id),
    method_type_id     text,
    time_zone          text NOT NULL DEFAULT 'America/Denver',
    cadence_minutes    integer NOT NULL CHECK (cadence_minutes > 0),
    valid_range_min    numeric,
    valid_range_max    numeric,
    visibility         text NOT NULL CHECK (visibility IN ('public', 'restricted', 'internal')),
    processing_policy  text,
    effective_from     timestamptz,
    effective_to       timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (valid_range_min IS NULL OR valid_range_max IS NULL OR valid_range_max >= valid_range_min),
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
);
COMMENT ON TABLE water.datastream IS 'Observed series per station. time_zone is the IANA zone used for display and day aggregation (America/Denver for Utah); browser time never redefines a reporting day.';
COMMENT ON COLUMN water.datastream.valid_range_min IS 'Inclusive plausibility bounds (capacity limits). Out-of-range values are LABELLED, never silently clipped (fixture obs-q-044 at 9500 cfs vs max 1200).';
COMMENT ON COLUMN water.datastream.effective_from IS 'Effective dating [effective_from, effective_to); NULL = since inception. A new stream (not an edit) is opened on device configuration change.';

CREATE INDEX datastream_station_idx ON water.datastream (station_id);
CREATE INDEX datastream_visibility_idx ON water.datastream (visibility);

-- =============================================================================
-- Device deployments
-- Entity row: "Device deployment - Device ID, serial/model, installation/removal
-- times, station and inspection history."
-- =============================================================================

CREATE TABLE water.device_deployment (
    device_deployment_id  uuid PRIMARY KEY,
    device_key            text NOT NULL,
    serial                text,
    model                 text,
    station_id            uuid NOT NULL REFERENCES water.station (station_id),
    datastream_id         uuid REFERENCES water.datastream (datastream_id),
    installed_at          timestamptz NOT NULL,
    removed_at            timestamptz,
    CHECK (removed_at IS NULL OR removed_at >= installed_at),
    UNIQUE (device_key, installed_at)
);
COMMENT ON TABLE water.device_deployment IS 'Effective-dated device installations. A replacement closes the old deployment (removed_at) and opens a dated new one (fixtures dev-rtu-corinne-01 -> dev-rtu-corinne-02).';

CREATE INDEX device_deployment_device_idx ON water.device_deployment (device_key);
CREATE INDEX device_deployment_stream_idx ON water.device_deployment (datastream_id, installed_at);

-- =============================================================================
-- Rating curves and shifts
-- Entity row: "Rating curve and shift - Versioned coefficients/method/unit,
-- valid interval, deployment, approval and derived-output lineage."
-- =============================================================================

CREATE TABLE water.rating_curve (
    rating_curve_id       uuid PRIMARY KEY,
    rating_curve_key      text NOT NULL UNIQUE,
    datastream_id         uuid NOT NULL REFERENCES water.datastream (datastream_id),
    device_deployment_id  uuid REFERENCES water.device_deployment (device_deployment_id),
    version               integer NOT NULL CHECK (version >= 1),
    method                text NOT NULL,
    coefficients          jsonb,
    unit_id               text REFERENCES water.vocab_unit (unit_id),
    valid_from            timestamptz NOT NULL,
    valid_to              timestamptz,
    approval_state        text NOT NULL DEFAULT 'draft' CHECK (approval_state IN ('draft', 'in-review', 'approved', 'superseded')),
    derived_output_lineage jsonb,
    created_at            timestamptz NOT NULL DEFAULT now(),
    CHECK (valid_to IS NULL OR valid_to > valid_from),
    UNIQUE (datastream_id, version)
);
COMMENT ON TABLE water.rating_curve IS 'Versioned rating curves with half-open validity intervals [valid_from, valid_to). Derived outputs record lineage so recomputation is traceable to the curve version used.';

CREATE INDEX rating_curve_stream_idx ON water.rating_curve (datastream_id, valid_from);

CREATE TABLE water.rating_shift (
    rating_shift_id  uuid PRIMARY KEY,
    rating_curve_id  uuid NOT NULL REFERENCES water.rating_curve (rating_curve_id),
    shift_value      numeric NOT NULL,
    unit_id          text NOT NULL REFERENCES water.vocab_unit (unit_id),
    valid_from       timestamptz NOT NULL,
    valid_to         timestamptz,
    approval_state   text NOT NULL DEFAULT 'draft' CHECK (approval_state IN ('draft', 'in-review', 'approved', 'superseded')),
    reason           text,
    CHECK (valid_to IS NULL OR valid_to > valid_from)
);
COMMENT ON TABLE water.rating_shift IS 'Effective-dated shifts applied on top of a rating curve, with the same approval lifecycle.';

-- =============================================================================
-- Original observations (immutable, natively partitioned)
-- Entity row: "Original observation - Stable logical key, stream ID, observed
-- timestamp, source event ID, source value/unit, received timestamp, provenance
-- and hash."
--
-- The logical key is (stream_id, observed_time, source_event_id): retransmitted
-- events may duplicate an instant under a NEW source_event_id and both
-- originals are retained (fixtures obs-q-016 / obs-q-017). The API-facing
-- "logical key" string (stream:instant) addresses the GROUP; source_event_id
-- disambiguates within it.
--
-- TimescaleDB caution (technical specification): unique indexes on a
-- partitioned/hypertable target MUST include the partitioning column. Both the
-- PK (observation_id, observed_time) and the logical-key UNIQUE index include
-- observed_time. There is NO UUID-only uniqueness on this table.
-- =============================================================================

CREATE TABLE water.observation_original (
    observation_id      uuid NOT NULL,
    stream_id           uuid NOT NULL REFERENCES water.datastream (datastream_id),
    observed_time       timestamptz NOT NULL,
    source_event_id     text NOT NULL,
    source_value        numeric,
    source_unit_id      text NOT NULL REFERENCES water.vocab_unit (unit_id),
    value_type          text NOT NULL CHECK (value_type IN ('observed', 'estimated', 'computed')),
    processing_level    text NOT NULL REFERENCES water.vocab_processing_level (processing_level_id),
    method_type_id      text,
    source_id           text NOT NULL,
    source_offset       text NOT NULL CHECK (source_offset ~ '^[+-](0[0-9]|1[0-3]):[0-5][0-9]$'),
    received_at         timestamptz NOT NULL,
    note                text,
    source_payload_hash text NOT NULL,
    PRIMARY KEY (observation_id, observed_time),
    UNIQUE (stream_id, observed_time, source_event_id)
) PARTITION BY RANGE (observed_time);
COMMENT ON TABLE water.observation_original IS 'APPEND-ONLY originals (ADR-06): UPDATE and DELETE are rejected by trigger; corrections append observation_revision rows. observed_time and received_at are distinct from the first release (late arrivals, fixture obs-q-005).';
COMMENT ON COLUMN water.observation_original.source_value IS 'Source value in source_unit_id. NULL is a reported-but-empty reading (NOT zero); a missing reading is the absence of a row plus a declared_gap entry.';
COMMENT ON COLUMN water.observation_original.source_offset IS 'Source-local UTC offset at capture (e.g. -07:00 / -06:00) so the 2026-03-08 spring-forward day stays reconstructible.';
COMMENT ON COLUMN water.observation_original.source_payload_hash IS 'sha256 of the canonical source record (deterministic JSON with recursively sorted keys); provenance for tamper evidence and idempotent re-ingestion.';

-- Monthly partitions. Fixtures occupy 2026-02 and 2026-03 only; later months
-- arrive through appended migrations or the scheduled partition job.
CREATE TABLE water.observation_original_2026_02 PARTITION OF water.observation_original
    FOR VALUES FROM ('2026-02-01T00:00:00Z') TO ('2026-03-01T00:00:00Z');
CREATE TABLE water.observation_original_2026_03 PARTITION OF water.observation_original
    FOR VALUES FROM ('2026-03-01T00:00:00Z') TO ('2026-04-01T00:00:00Z');
-- Safety net for rows outside every declared month; an INSERT landing here is
-- an alert to add the missing monthly partition, not a data-loss path.
CREATE TABLE water.observation_original_default PARTITION OF water.observation_original DEFAULT;

CREATE INDEX observation_original_stream_time_idx ON water.observation_original (stream_id, observed_time);
COMMENT ON INDEX water.observation_original_stream_time_idx IS 'Bounded series scans; declared on the partitioned parent so PostgreSQL creates it on every partition (plan proof in qualification/queries.sql).';

-- Immutability enforcement (ADR-06): originals are never editable.
-- UPDATE/DELETE raise; exclusion is an appended revision (tombstone), and any
-- physical deletion requires a separately ratified retention rule, executed by
-- the migration operator with the trigger explicitly disabled.
CREATE OR REPLACE FUNCTION water.observation_original_is_immutable() RETURNS trigger
AS $$
BEGIN
    RAISE EXCEPTION 'water.observation_original is append-only (ADR-06): % is blocked; append a water.observation_revision instead', TG_OP
        USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION water.observation_original_is_immutable() IS 'Blocks UPDATE/DELETE on originals. PostgreSQL 13+ propagates row triggers from the partitioned parent to partitions.';

CREATE TRIGGER observation_original_no_update
    BEFORE UPDATE OR DELETE ON water.observation_original
    FOR EACH ROW EXECUTE FUNCTION water.observation_original_is_immutable();

-- =============================================================================
-- Revisions (append-only corrections; ADR-06)
-- Entity row: "Revision - Logical observation key, revision ID, value or
-- exclusion, processing level, qualifiers, reason, actor, recorded time,
-- base revision."
-- =============================================================================

CREATE TABLE water.observation_revision (
    revision_id        uuid PRIMARY KEY,
    revision_key       text NOT NULL UNIQUE,
    observation_id     uuid NOT NULL,
    observed_time      timestamptz NOT NULL,
    base_revision_id   uuid REFERENCES water.observation_revision (revision_id),
    revision_type      text NOT NULL CHECK (revision_type IN ('correction', 'exclusion', 'level-advance')),
    value              numeric,
    unit_id            text REFERENCES water.vocab_unit (unit_id),
    excluded           boolean NOT NULL DEFAULT false,
    processing_level   text NOT NULL REFERENCES water.vocab_processing_level (processing_level_id),
    reason             text NOT NULL,
    actor_principal_id uuid NOT NULL REFERENCES water.principal (principal_id),
    recorded_at        timestamptz NOT NULL,
    revision_version   integer NOT NULL CHECK (revision_version >= 1),
    idempotency_key    text UNIQUE,
    created_at         timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (observation_id, observed_time) REFERENCES water.observation_original (observation_id, observed_time),
    UNIQUE (observation_id, revision_version),
    CHECK (excluded = (revision_type = 'exclusion')),
    CHECK (revision_type <> 'correction' OR value IS NOT NULL)
);
COMMENT ON TABLE water.observation_revision IS 'APPEND-ONLY revision history. Corrections never overwrite earlier revisions (trigger below); best available stays correctable after year end.';
COMMENT ON COLUMN water.observation_revision.observed_time IS 'Carried alongside observation_id because the FK target is partitioned and its uniqueness includes the partition key.';
COMMENT ON COLUMN water.observation_revision.base_revision_id IS 'Optimistic-concurrency lineage: a new revision states the revision it builds on; If-Match against the current revision_version turns concurrent edits into 409/412 instead of silent overwrite.';
COMMENT ON COLUMN water.observation_revision.reason IS 'Mandatory justification. Redacted from public projections of revision history when internal.';
COMMENT ON COLUMN water.observation_revision.idempotency_key IS 'Replaying the same key with a different body is rejected by the application transaction.';

CREATE INDEX observation_revision_observation_idx ON water.observation_revision (observation_id, recorded_at);

CREATE OR REPLACE FUNCTION water.observation_revision_is_append_only() RETURNS trigger
AS $$
BEGIN
    RAISE EXCEPTION 'water.observation_revision is append-only (ADR-06): % is blocked; append a superseding revision instead', TG_OP
        USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER observation_revision_no_update
    BEFORE UPDATE OR DELETE ON water.observation_revision
    FOR EACH ROW EXECUTE FUNCTION water.observation_revision_is_append_only();

CREATE TABLE water.revision_qualifier (
    revision_id   uuid NOT NULL REFERENCES water.observation_revision (revision_id),
    qualifier_id  text NOT NULL REFERENCES water.vocab_qualifier (qualifier_id),
    PRIMARY KEY (revision_id, qualifier_id)
);
COMMENT ON TABLE water.revision_qualifier IS 'Governed qualifiers per revision (e.g. ice-affected, interpolate).';

-- =============================================================================
-- Declared gaps
-- Missing readings stay missing: never back-filled with zeros and never
-- silently interpolated (technical specification, Numerical and temporal rules).
-- =============================================================================

CREATE TABLE water.declared_gap (
    gap_id                    uuid PRIMARY KEY,
    gap_key                   text NOT NULL UNIQUE,
    stream_id                 uuid NOT NULL REFERENCES water.datastream (datastream_id),
    start_time                timestamptz NOT NULL,
    end_time                  timestamptz NOT NULL,
    reason                    text NOT NULL,
    declared_at               timestamptz NOT NULL,
    expected_cadence_minutes  integer NOT NULL CHECK (expected_cadence_minutes > 0),
    missing_count             integer NOT NULL CHECK (missing_count >= 0),
    note                      text,
    CHECK (end_time > start_time)
);
COMMENT ON TABLE water.declared_gap IS 'Explicitly declared missing-data intervals [start_time, end_time). Coverage APIs report the gap with estimated proportion and method; a missing reading is not zero.';

-- =============================================================================
-- Site visits and attachments
-- Entity row: "Site visit and attachment - Capture/visit time, actor,
-- categories, visibility, object reference, retention class and integrity hash."
-- =============================================================================

CREATE TABLE water.site_visit (
    site_visit_id       uuid PRIMARY KEY,
    station_id          uuid NOT NULL REFERENCES water.station (station_id),
    visit_time          timestamptz NOT NULL,
    actor_principal_id  uuid NOT NULL REFERENCES water.principal (principal_id),
    visit_categories    text[] NOT NULL DEFAULT '{}',
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE water.site_visit IS 'Field visit records (equipment work, inspections, measurements).';

CREATE TABLE water.site_visit_attachment (
    attachment_id       uuid PRIMARY KEY,
    site_visit_id       uuid NOT NULL REFERENCES water.site_visit (site_visit_id),
    category            text NOT NULL,
    visibility_class    text NOT NULL CHECK (visibility_class IN ('public', 'restricted', 'internal')),
    storage_object_ref  text NOT NULL,
    capture_time        timestamptz,
    retention_class     text NOT NULL,
    integrity_hash      text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE water.site_visit_attachment IS 'Attachments live in private object storage; storage_object_ref is the bucket key, never a public URL. Downloads proxy through the application so every request re-checks current grants; visibility_class decides public attachment exposure.';
COMMENT ON COLUMN water.site_visit_attachment.integrity_hash IS 'sha256 of the object bytes captured at ingest.';

-- =============================================================================
-- QC rules and results (versioned)
-- Entity row: "QC rule and result - Versioned type/configuration, author,
-- effective interval, run identity, violations and failure state."
-- =============================================================================

CREATE TABLE water.qc_rule (
    qc_rule_id          uuid PRIMARY KEY,
    rule_key            text NOT NULL,
    version             integer NOT NULL CHECK (version >= 1),
    rule_type           text NOT NULL,
    configuration       jsonb NOT NULL,
    author_principal_id uuid NOT NULL REFERENCES water.principal (principal_id),
    effective_from      timestamptz NOT NULL,
    effective_to        timestamptz,
    status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'testing', 'promoted', 'retired')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (effective_to IS NULL OR effective_to > effective_from),
    UNIQUE (rule_key, version)
);
COMMENT ON TABLE water.qc_rule IS 'Range, rate-of-change, persistence, missing and zero checks. Each rule version carries its configuration, author and test/promote history; failures are isolated by run.';

CREATE TABLE water.qc_rule_run (
    qc_rule_run_id  uuid PRIMARY KEY,
    qc_rule_id      uuid NOT NULL REFERENCES water.qc_rule (qc_rule_id),
    stream_id       uuid NOT NULL REFERENCES water.datastream (datastream_id),
    window_start    timestamptz NOT NULL,
    window_end      timestamptz NOT NULL,
    started_at      timestamptz NOT NULL,
    finished_at     timestamptz,
    run_state       text NOT NULL DEFAULT 'running' CHECK (run_state IN ('running', 'succeeded', 'failed', 'isolated')),
    failure_detail  jsonb,
    CHECK (window_end >= window_start)
);
COMMENT ON TABLE water.qc_rule_run IS 'One evaluation of a rule version over a stream window; run identity links results to task health.';

CREATE TABLE water.qc_result (
    qc_result_id     uuid PRIMARY KEY,
    qc_rule_run_id   uuid NOT NULL REFERENCES water.qc_rule_run (qc_rule_run_id),
    observation_id   uuid NOT NULL,
    observed_time    timestamptz NOT NULL,
    violated         boolean NOT NULL DEFAULT true,
    violation_detail jsonb,
    failure_state    text NOT NULL DEFAULT 'flagged' CHECK (failure_state IN ('flagged', 'confirmed', 'dismissed')),
    FOREIGN KEY (observation_id, observed_time) REFERENCES water.observation_original (observation_id, observed_time)
);
COMMENT ON TABLE water.qc_result IS 'Per-observation QC outcome. The composite FK mirrors the partitioned target identity (see TimescaleDB caution).';

-- =============================================================================
-- Assignments (entitlements)
-- Entity row: "Assignment - Principal, action/capability, scoped
-- object/system/organization, validity dates and grant audit."
-- Mirrors packages/contracts/schemas/entitlement.json.
-- =============================================================================

CREATE TABLE water.assignment (
    assignment_id             uuid PRIMARY KEY,
    assignment_key            text NOT NULL UNIQUE,
    principal_id              uuid NOT NULL REFERENCES water.principal (principal_id),
    role                      text NOT NULL CHECK (role IN ('engineer', 'commissioner', 'deputy', 'steward', 'researcher', 'owner')),
    scope_type                text NOT NULL CHECK (scope_type IN ('system', 'organization', 'site', 'statewide', 'dataset')),
    scope_system_id           uuid REFERENCES water.distribution_system (system_id),
    scope_organization_id     uuid REFERENCES water.organization (organization_id),
    scope_station_id          uuid REFERENCES water.station (station_id),
    scope_dataset_id          text,
    effective_at              timestamptz NOT NULL,
    expires_at                timestamptz,
    status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    delegation                jsonb,
    granted_by_principal_id   uuid NOT NULL REFERENCES water.principal (principal_id),
    grant_version             integer NOT NULL CHECK (grant_version >= 1),
    created_at                timestamptz NOT NULL DEFAULT now(),
    CHECK (scope_type <> 'statewide' OR (scope_system_id IS NULL AND scope_organization_id IS NULL AND scope_station_id IS NULL AND scope_dataset_id IS NULL)),
    CHECK (scope_type <> 'system' OR scope_system_id IS NOT NULL),
    CHECK (scope_type <> 'organization' OR scope_organization_id IS NOT NULL),
    CHECK (scope_type <> 'site' OR scope_station_id IS NOT NULL),
    CHECK (scope_type <> 'dataset' OR scope_dataset_id IS NOT NULL),
    CHECK (expires_at IS NULL OR expires_at > effective_at)
);
COMMENT ON TABLE water.assignment IS 'Authorization is evaluated on every endpoint, queued job, download and spatial request. Scoped membership is resolved server-side; a body actorId or browser role switch never grants anything (FR-010).';
COMMENT ON COLUMN water.assignment.delegation IS 'Deputy grants carry an explicit, time-bounded delegation {effectiveAt, expiresAt, delegatedBy}; authority is never automatically statewide.';
COMMENT ON COLUMN water.assignment.grant_version IS 'Monotonic assignment version: protected requests compare against it so a stale cache cannot outlive a revocation.';

CREATE INDEX assignment_principal_idx ON water.assignment (principal_id, status);

CREATE TABLE water.assignment_capability (
    assignment_id  uuid NOT NULL REFERENCES water.assignment (assignment_id),
    capability     text NOT NULL,
    PRIMARY KEY (assignment_id, capability)
);
COMMENT ON TABLE water.assignment_capability IS 'Action-specific capabilities of a grant (enter-readings, revise-best-available, ...).';

-- =============================================================================
-- Audit events
-- Entity row: "Audit event - Actor, action, object/version, time, correlation
-- ID and structured change; secrets excluded."
-- =============================================================================

CREATE TABLE water.audit_event (
    audit_event_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_principal_id uuid REFERENCES water.principal (principal_id),
    action             text NOT NULL,
    object_type        text NOT NULL,
    object_id          text NOT NULL,
    object_version     integer,
    occurred_at        timestamptz NOT NULL DEFAULT now(),
    correlation_id     text NOT NULL,
    change             jsonb NOT NULL
);
COMMENT ON TABLE water.audit_event IS 'Append-oriented audit trail. correlation_id ties a change to the request/job across gateway, backend, workers and DB. change is a structured diff that EXCLUDES secrets, tokens and private notes by contract.';

CREATE INDEX audit_event_correlation_idx ON water.audit_event (correlation_id);
CREATE INDEX audit_event_object_idx ON water.audit_event (object_type, object_id, occurred_at);

-- =============================================================================
-- Transactional outbox (ADR-10)
-- Committing a measurement/station change enqueues a publication cache refresh
-- in the SAME transaction; a worker claims it and refreshes/truncates the
-- NeoServer cache, retrying without repeating the domain change.
-- =============================================================================

CREATE TABLE water.outbox_event (
    outbox_event_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type       text NOT NULL,
    aggregate_type   text NOT NULL,
    aggregate_id     text NOT NULL,
    payload          jsonb NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    available_at     timestamptz NOT NULL DEFAULT now(),
    claimed_at       timestamptz,
    claimed_by       text,
    attempts         integer NOT NULL DEFAULT 0,
    status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done', 'failed')),
    last_error       text
);
COMMENT ON TABLE water.outbox_event IS 'Transactional outbox for publication cache refresh and asynchronous jobs. A committed change can display "publication pending" until the worker records the public revision here.';

CREATE INDEX outbox_event_pending_idx ON water.outbox_event (available_at) WHERE status = 'pending';
