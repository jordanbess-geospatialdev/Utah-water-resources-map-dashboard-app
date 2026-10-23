-- WD-027: align persisted assignments with the existing runtime RoleFamily.
-- This changes only the accepted role vocabulary. Capabilities, organization
-- scope and reviewer approval authority remain enforced by domain policy.
-- PostgreSQL names the original inline column CHECK assignment_role_check.

BEGIN;

ALTER TABLE water.assignment DROP CONSTRAINT assignment_role_check;
ALTER TABLE water.assignment ADD CONSTRAINT assignment_role_check
    CHECK (role IN ('public', 'water-user', 'owner', 'researcher', 'commissioner', 'deputy', 'engineer', 'steward'));

COMMIT;
