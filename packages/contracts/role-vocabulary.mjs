// Static cross-layer role contract. No database connection or TypeScript runtime
// import is needed. The SQL reader supports this repository's literal IN checks
// and explicit ADD/DROP CONSTRAINT migrations; unfamiliar role DDL fails closed.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const quoted = (text) => [...text.matchAll(/'([^']+)'/g)].map((match) => match[1]);
const sorted = (values) => [...new Set(values)].sort();
const clean = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

function sqlRoleLiterals(text) {
  if (!/^\s*'[a-z][a-z-]*'(?:\s*,\s*'[a-z][a-z-]*')*\s*$/.test(text)) {
    throw new Error('assignment role CHECK must contain an explicit list of role literals');
  }
  return quoted(text);
}

export function readRoleSources(root) {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  return {
    policyTypes: read('packages/policy/src/types.ts'),
    assignmentSource: read('services/api/src/workflows/stewardship/assignments.ts'),
    entitlementSchema: JSON.parse(read('packages/contracts/schemas/entitlement.json')),
    openapi: JSON.parse(read('packages/contracts/openapi.json')),
    migrations: readdirSync(join(root, 'database/migrations')).filter((name) => name.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: read(`database/migrations/${name}`) })),
  };
}

export function effectiveAssignmentRoles(migrations) {
  const constraints = new Map();
  let created = false;
  for (const { name, sql } of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const raw of clean(sql).split(';')) {
      const statement = raw.trim();
      if (/^CREATE\s+TABLE\s+water\.assignment\s*\(/i.test(statement)) {
        const roleCheck = statement.match(/\brole\s+text\s+NOT\s+NULL\s+CHECK\s*\(\s*role\s+IN\s*\(([^)]+)\)\s*\)/i);
        if (created || !roleCheck) throw new Error(`${name}: unsupported assignment role definition`);
        constraints.set('assignment_role_check', sqlRoleLiterals(roleCheck[1]));
        created = true;
        continue;
      }
      if (!/^ALTER\s+TABLE\s+water\.assignment\b/i.test(statement)) continue;
      const alteration = statement.replace(/^ALTER\s+TABLE\s+water\.assignment\s*/i, '');
      const drop = alteration.match(/^DROP\s+CONSTRAINT\s+(\w+)$/i);
      if (drop) {
        constraints.delete(drop[1]);
        continue;
      }
      const add = alteration.match(/^ADD\s+CONSTRAINT\s+(\w+)\s+CHECK\s*\(\s*role\s+IN\s*\(([^)]+)\)\s*\)$/i);
      if (add) {
        if (constraints.has(add[1])) throw new Error(`${name}: duplicate assignment role constraint ${add[1]}`);
        constraints.set(add[1], sqlRoleLiterals(add[2]));
        continue;
      }
      if (/\brole\b|assignment_role_check/i.test(alteration)) {
        throw new Error(`${name}: unsupported assignment role DDL; extend the static check explicitly`);
      }
    }
  }
  if (!created || constraints.size === 0) throw new Error('assignment role CHECK is absent after migrations');
  const checks = [...constraints.values()];
  // All active CHECK constraints apply. Adding a broad check without dropping
  // the old restrictive check must NOT appear to fix persistence.
  return sorted(checks[0].filter((role) => checks.every((roles) => roles.includes(role))));
}

export function inspectRoleVocabulary(sources) {
  const failures = [];
  const union = sources.policyTypes.match(/export\s+type\s+RoleFamily\s*=([\s\S]*?);/);
  const roles = union ? sorted(quoted(union[1])) : [];
  if (roles.length === 0) failures.push('runtime RoleFamily union is missing or unsupported');
  const granted = sources.assignmentSource.match(/const\s+VALID_ROLES[^=]*=\s*\[([^\]]+)\]/);
  const versions = {
    'runtime grant validator': granted ? quoted(granted[1]) : [],
    'entitlement schema': sources.entitlementSchema?.properties?.role?.enum ?? [],
    'OpenAPI Entitlement': sources.openapi?.components?.schemas?.Entitlement?.properties?.role?.enum ?? [],
    'OpenAPI AssignmentPutRequest': sources.openapi?.components?.schemas?.AssignmentPutRequest?.properties?.role?.enum ?? [],
  };
  try {
    versions['effective SQL assignment CHECK'] = effectiveAssignmentRoles(sources.migrations);
  } catch (error) {
    failures.push(error.message);
  }
  for (const [label, values] of Object.entries(versions)) {
    if (JSON.stringify(sorted(values)) !== JSON.stringify(roles)) {
      failures.push(`${label} roles differ from runtime RoleFamily: expected [${roles}], got [${sorted(values)}]`);
    }
    if (values.length !== new Set(values).size) failures.push(`${label} has duplicate roles`);
  }
  return { roles, failures };
}
