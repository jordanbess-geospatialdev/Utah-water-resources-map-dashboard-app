import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { effectiveAssignmentRoles, inspectRoleVocabulary, readRoleSources } from '../role-vocabulary.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sources = () => readRoleSources(root);

test('runtime roles agree with grant validation, both OpenAPI shapes, schema and effective SQL', () => {
  const result = inspectRoleVocabulary(sources());
  assert.deepEqual(result.failures, []);
  assert.ok(result.roles.includes('water-user'));
  assert.ok(result.roles.includes('public'));
  assert.ok(!result.roles.includes('unrecognized-role'));
});

for (const [label, mutate] of [
  ['TypeScript RoleFamily', (s) => { s.policyTypes = s.policyTypes.replace("  | 'water-user'\n", ''); }],
  ['grant validator', (s) => { s.assignmentSource = s.assignmentSource.replace("'public', 'water-user', 'owner'", "'public', 'owner'"); }],
  ['JSON schema', (s) => { s.entitlementSchema.properties.role.enum = s.entitlementSchema.properties.role.enum.filter((role) => role !== 'water-user'); }],
  ['OpenAPI Entitlement', (s) => { s.openapi.components.schemas.Entitlement.properties.role.enum.push('unrecognized-role'); }],
  ['OpenAPI AssignmentPutRequest', (s) => { s.openapi.components.schemas.AssignmentPutRequest.properties.role.enum = ['owner']; }],
]) {
  test(`role drift in ${label} fails the consistency check`, () => {
    const input = sources();
    mutate(input);
    assert.notDeepEqual(inspectRoleVocabulary(input).failures, []);
  });
}

test('the appended migration accepts supplier roles; the unmodified baseline rejects them', () => {
  const input = sources();
  const before = input.migrations.filter((migration) => !migration.name.includes('WD-027_assignment_roles'));
  assert.ok(!effectiveAssignmentRoles(before).includes('water-user'));
  assert.ok(effectiveAssignmentRoles(input.migrations).includes('water-user'));
  assert.ok(!effectiveAssignmentRoles(input.migrations).includes('unrecognized-role'));
  assert.ok(inspectRoleVocabulary({ ...input, migrations: before }).failures.some((failure) => failure.includes('effective SQL')));
});

test('adding a broad SQL constraint without dropping the old one still detects rejected supplier grants', () => {
  const input = sources();
  const migration = input.migrations.find((item) => item.name.includes('WD-027_assignment_roles'));
  migration.sql = migration.sql
    .replace('ALTER TABLE water.assignment DROP CONSTRAINT assignment_role_check;', '')
    .replace('ADD CONSTRAINT assignment_role_check', 'ADD CONSTRAINT assignment_role_expanded');
  assert.ok(!effectiveAssignmentRoles(input.migrations).includes('water-user'));
  assert.ok(inspectRoleVocabulary(input).failures.some((failure) => failure.includes('effective SQL')));
});

test('dropping the role constraint without replacement and unsupported role DDL fail closed', () => {
  for (const sql of [
    'ALTER TABLE water.assignment DROP CONSTRAINT assignment_role_check;',
    'ALTER TABLE water.assignment ALTER COLUMN role TYPE integer;',
  ]) {
    const input = sources();
    input.migrations.push({ name: 'V209901010000__WD-999_regression.sql', sql });
    assert.notDeepEqual(inspectRoleVocabulary(input).failures, []);
  }
});
