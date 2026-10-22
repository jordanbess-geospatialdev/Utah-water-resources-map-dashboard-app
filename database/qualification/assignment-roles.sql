-- WD-027 executable regression check for a NEW DISPOSABLE PostgreSQL database.
-- Run with psql -X -v ON_ERROR_STOP=1 -f database/qualification/assignment-roles.sql.
-- Creates a minimal copy of the baseline assignment role constraint, then runs
-- the actual appended migration. No PostGIS extension or existing data needed.
-- CREATE SCHEMA deliberately refuses an existing water schema before any DDL.
-- This checks the migration itself, not deployment readiness of the full schema.
\set ON_ERROR_STOP on

CREATE SCHEMA water;
CREATE TABLE water.assignment (
    assignment_id integer PRIMARY KEY,
    role text NOT NULL CHECK (role IN ('engineer', 'commissioner', 'deputy', 'steward', 'researcher', 'owner'))
);
INSERT INTO water.assignment (assignment_id, role) VALUES (1, 'engineer');

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'water.assignment'::regclass
          AND conname = 'assignment_role_check'
    ) THEN
        RAISE EXCEPTION 'baseline inline constraint has an unexpected name';
    END IF;
    BEGIN
        INSERT INTO water.assignment (assignment_id, role) VALUES (2, 'water-user');
        RAISE EXCEPTION 'baseline unexpectedly accepted water-user';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO water.assignment (assignment_id, role) VALUES (3, 'public');
        RAISE EXCEPTION 'baseline unexpectedly accepted public';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
END;
$$;

\ir ../migrations/V202610211203__WD-027_assignment_roles.sql

INSERT INTO water.assignment (assignment_id, role) VALUES (2, 'water-user'), (3, 'public');

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM water.assignment WHERE assignment_id = 1 AND role = 'engineer') THEN
        RAISE EXCEPTION 'migration changed or removed the existing engineer assignment';
    END IF;
    BEGIN
        INSERT INTO water.assignment (assignment_id, role) VALUES (4, 'unrecognized-role');
        RAISE EXCEPTION 'migrated constraint unexpectedly accepted an unknown role';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    IF (SELECT count(*) FROM water.assignment) <> 3 THEN
        RAISE EXCEPTION 'expected exactly the preserved engineer and two new valid assignments';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'water.assignment'::regclass
          AND conname = 'assignment_role_check' AND convalidated
    ) THEN
        RAISE EXCEPTION 'replacement role constraint is missing or unvalidated';
    END IF;
END;
$$;

SELECT assignment_id, role FROM water.assignment ORDER BY assignment_id;
\echo PASS: baseline rejected water-user/public; migration preserved engineer and accepted both; unknown role rejected.
