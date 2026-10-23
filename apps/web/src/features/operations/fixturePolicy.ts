/**
 * Fixture policy port: the DEFAULT binding for the operations and favorites
 * features when no shell wiring has injected the real engine yet.
 *
 * !!! DEMO-ONLY MIRROR !!!
 *
 * This module mirrors @utah-water/policy (packages/policy/src) for the
 * contract fixture world only - exactly like apps/web/src/shell/data/
 * projection.ts, this is a browser-side demonstration of what the
 * server-side policy projects, NOT a security boundary. The mirror is
 * cross-checked decision-by-decision against the real engine in
 * siteWorkspace.test.ts (personas x stations x field classes x boundary
 * clocks), so the demo cannot silently diverge from the authoritative
 * evaluation rules.
 *
 * Why a mirror at all: the real engine's sources cannot enter the web tsc
 * program (apps/web/tsconfig.json is orchestrator-owned and does not enable
 * allowImportingTsExtensions; see assignedScope.ts). The real engine stays
 * the authority in every test; the shell wiring line in README.md replaces
 * this port with `buildWorld` + `evaluate` from the policy package.
 *
 * Mirrored rules (packages/policy/src/engine.ts + matrix.ts):
 * - allow_public_read = explicit public action AND currently published AND
 *   public fields only;
 * - allow_protected = authenticated AND active AND capability satisfies the
 *   action AND scope covers the object AND field classes allowed AND
 *   lifecycle allows (read actions: any state);
 * - half-open validity windows [effectiveAt, expiresAt), deputy delegation
 *   window authoritative and checked first, revoked wins over everything,
 *   deputy grants require a delegation and may never be statewide;
 * - denial-reason precedence (revoked > delegation-expired > assignment-
 *   expired > delegation-not-effective > not-effective > invalid > missing
 *   capability), then scope, then field visibility, then lifecycle.
 */
import { entitlements, FIXTURE_CLOCK, organizations, stations, users } from '../../shell/data/fixtures';
import type { EntitlementRecord, StationRecord, UserRecord } from '../../shell/data/types';
import type {
  PolicyAssignmentMirror,
  PolicyDecisionMirror,
  PolicyEvaluator,
  PolicyFieldClass,
  PolicyObjectMirror,
  PolicyPrincipalMirror,
  PolicyRequestMirror,
  PolicyWorldMirror,
} from './assignedScope';

// ---------------------------------------------------------------------------
// The fixture world (mirrors engine.buildWorld over the contract fixtures)
// ---------------------------------------------------------------------------

function principalOf(user: UserRecord): PolicyPrincipalMirror {
  return {
    id: user.id,
    displayName: user.displayName,
    active: user.active === true,
    roles: [...user.roles],
    ...(user.assignedSystemId !== undefined ? { assignedSystemId: user.assignedSystemId } : {}),
  };
}

function assignmentOf(entitlement: EntitlementRecord): PolicyAssignmentMirror {
  // The entitlement contract schema carries 'revoked'; the shell fixture type
  // narrows to the statuses present in the frozen fixtures ('active').
  const status = entitlement.status as string;
  return {
    id: entitlement.id,
    principalId: entitlement.principalId,
    role: entitlement.role,
    capabilities: [...entitlement.capabilities],
    scope: { kind: entitlement.scopeType, id: entitlement.scopeId },
    effectiveAt: entitlement.effectiveAt,
    expiresAt: entitlement.expiresAt,
    status: status === 'revoked' ? 'revoked' : 'active',
    delegation: entitlement.delegation
      ? {
          effectiveAt: entitlement.delegation.effectiveAt,
          expiresAt: entitlement.delegation.expiresAt,
          delegatedBy: entitlement.delegation.delegatedBy,
        }
      : null,
    grantVersion: entitlement.grantVersion,
  };
}

function stationObjectOf(station: StationRecord): PolicyObjectMirror[] {
  const fields: Record<string, PolicyFieldClass> = {};
  if (station.internal) {
    for (const key of Object.keys(station.internal)) {
      if (key === 'visibility') continue;
      fields[key] = 'internal';
    }
  }
  const stationObject: PolicyObjectMirror = {
    id: station.id,
    kind: 'station',
    systemId: station.systemId,
    ownerOrganizationId: station.ownerOrganizationId ?? null,
    stationId: null,
    datasetId: null,
    visibility: station.visibility,
    status: station.status,
    fields,
  };
  const streamObjects = station.datastreams.map(
    (stream): PolicyObjectMirror => ({
      id: stream.id,
      kind: 'datastream',
      systemId: station.systemId,
      ownerOrganizationId: station.ownerOrganizationId ?? null,
      stationId: stream.stationId,
      datasetId: null,
      visibility: stream.visibility,
      status: station.status,
      fields: {},
    }),
  );
  return [stationObject, ...streamObjects];
}

/** Build the fixture world from the shell contract fixtures (frozen seed utah-water-fixture-v1). */
export function fixtureWorld(): PolicyWorldMirror {
  const principals: Record<string, PolicyPrincipalMirror> = {};
  const objects: Record<string, PolicyObjectMirror> = {};
  const assignments: PolicyAssignmentMirror[] = [];

  for (const organization of organizations) {
    objects[organization.id] = {
      id: organization.id,
      kind: 'organization',
      systemId: null,
      ownerOrganizationId: organization.id,
      stationId: null,
      datasetId: null,
      visibility: 'restricted',
      status: 'active',
      fields: {},
    };
  }
  for (const user of users) {
    principals[user.id] = principalOf(user);
    // Every user is also a manageable object (steward manage-users), like the engine's buildWorld.
    objects[user.id] = {
      id: user.id,
      kind: 'user',
      systemId: user.assignedSystemId ?? null,
      ownerOrganizationId: null,
      stationId: null,
      datasetId: null,
      visibility: 'internal',
      status: 'active',
      fields: {},
    };
  }
  for (const entitlement of entitlements) assignments.push(assignmentOf(entitlement));
  for (const station of stations) {
    for (const object of stationObjectOf(station)) objects[object.id] = object;
  }

  const assignmentVersion = assignments.reduce((max, assignment) => Math.max(max, assignment.grantVersion), 0);
  return { principals, assignments, objects, assignmentVersion };
}

// ---------------------------------------------------------------------------
// The mirror evaluation tables (packages/policy/src/matrix.ts, verbatim subset)
// ---------------------------------------------------------------------------

/** Actions satisfiable by the public read branch. */
const PUBLIC_ACTIONS: ReadonlySet<string> = new Set(['browse-published']);

/** Capabilities that satisfy `view-restricted-details` (matrix CAPABILITY_SATISFIES row). */
const VIEW_RESTRICTED_SATISFIERS: ReadonlySet<string> = new Set([
  'view-restricted-details',
  'enter-readings',
  'revise-best-available',
  'edit-site-metadata',
  'edit-permitted-site-fields',
  'create-sites',
  'review-data',
  'record-data-issues',
  'manage-thresholds',
  'approve-rating-curves',
  'finalize-accounting',
  'field-visits',
  'view-internal-diagnostics',
  'generate-reports',
  'create-exports',
  'read-approved-datasets',
  'statewide-administration',
]);

/** Capabilities permitting restricted-class field reads (matrix RESTRICTED_FIELD_READ_CAPABILITIES). */
const RESTRICTED_FIELD_READ: ReadonlySet<string> = VIEW_RESTRICTED_SATISFIERS;

/** Capabilities permitting internal-class field reads (matrix INTERNAL_FIELD_READ_CAPABILITIES). */
const INTERNAL_FIELD_READ: ReadonlySet<string> = new Set(['view-internal-diagnostics', 'edit-site-metadata', 'statewide-administration']);

function satisfiesCapability(action: string, granted: readonly string[]): boolean {
  if (action === 'browse-published') return granted.includes('browse-published');
  if (action === 'view-restricted-details') return granted.some((capability) => VIEW_RESTRICTED_SATISFIERS.has(capability));
  return granted.includes(action);
}

/** Read actions allow every lifecycle state; visibility still applies. */
const READ_ACTIONS: ReadonlySet<string> = new Set([
  'browse-published',
  'view-restricted-details',
  'view-internal-diagnostics',
  'read-approved-datasets',
  'generate-reports',
  'create-exports',
]);

function isCurrentlyPublished(object: PolicyObjectMirror): boolean {
  return object.visibility === 'public' && (object.status === 'active' || object.status === 'inactive');
}

interface ValidityVerdict {
  valid: boolean;
  reason: string | null;
}

/** Half-open windows; revoked wins; deputies need a delegation and may never be statewide. */
function isWithinValidity(assignment: PolicyAssignmentMirror, t: number): ValidityVerdict {
  if (assignment.status === 'revoked') return { valid: false, reason: 'DENY_ASSIGNMENT_REVOKED' };
  if (assignment.role === 'deputy') {
    if (assignment.delegation === null) return { valid: false, reason: 'DENY_INVALID_ASSIGNMENT' };
    if (assignment.scope.kind === 'statewide') return { valid: false, reason: 'DENY_INVALID_ASSIGNMENT' };
  }
  if (assignment.scope.kind === 'statewide' && assignment.scope.id !== null) return { valid: false, reason: 'DENY_INVALID_ASSIGNMENT' };
  if (assignment.delegation) {
    if (Date.parse(assignment.delegation.effectiveAt) > t) return { valid: false, reason: 'DENY_DELEGATION_NOT_EFFECTIVE' };
    if (t >= Date.parse(assignment.delegation.expiresAt)) return { valid: false, reason: 'DENY_DELEGATION_EXPIRED' };
  }
  if (Date.parse(assignment.effectiveAt) > t) return { valid: false, reason: 'DENY_ASSIGNMENT_NOT_EFFECTIVE' };
  if (assignment.expiresAt !== null && t >= Date.parse(assignment.expiresAt)) return { valid: false, reason: 'DENY_ASSIGNMENT_EXPIRED' };
  return { valid: true, reason: null };
}

function coversScope(scope: PolicyAssignmentMirror['scope'], object: PolicyObjectMirror): boolean {
  switch (scope.kind) {
    case 'statewide':
      return scope.id === null;
    case 'system':
      return scope.id !== null && object.systemId === scope.id;
    case 'organization':
      return scope.id !== null && object.ownerOrganizationId === scope.id;
    case 'site':
      return scope.id !== null && (object.id === scope.id || object.stationId === scope.id);
    case 'dataset':
      return scope.id !== null && (object.datasetId === scope.id || object.id === scope.id);
    default:
      return false;
  }
}

function fieldClassesAllowed(granted: readonly string[], fields: readonly PolicyFieldClass[]): boolean {
  for (const field of fields) {
    if (field === 'public') continue;
    if (field === 'restricted') {
      if (!granted.some((capability) => RESTRICTED_FIELD_READ.has(capability))) return false;
    } else if (field === 'internal') {
      if (!granted.some((capability) => INTERNAL_FIELD_READ.has(capability))) return false;
    } else {
      return false;
    }
  }
  return true;
}

function decision(effect: 'allow' | 'deny', reason: string, via: 'public-read' | 'protected' | null, request: PolicyRequestMirror, world: PolicyWorldMirror, matched: readonly string[] = []): PolicyDecisionMirror {
  return { effect, reason, via, assignmentVersion: world.assignmentVersion, matchedAssignmentIds: matched };
}

/**
 * The mirror evaluator. Signature and verdict shape are the real engine's
 * `evaluate(request, world, now)`; the mirror covers the read actions the
 * operations and favorites features use (browse-published,
 * view-restricted-details). Unknown actions deny DENY_CAPABILITY_NOT_GRANTED,
 * mirroring "a capability-looking string nobody grants denies everywhere".
 */
export const fixturePolicyEvaluate: PolicyEvaluator = (request, world, now): PolicyDecisionMirror => {
  const t = typeof now === 'string' ? Date.parse(now) : now.getTime();
  if (!request || typeof request.action !== 'string' || request.action.length === 0 || !request.object || typeof request.object.id !== 'string') {
    return decision('deny', 'DENY_INVALID_REQUEST', null, { principal: null, action: '', object: { kind: '', id: '' } }, world);
  }
  const object = world.objects[request.object.id];
  if (!object) return decision('deny', 'DENY_UNKNOWN_OBJECT', null, request, world);

  // allow_public_read branch (falls through to the protected branch when a
  // principal is present, exactly like the engine)
  if (PUBLIC_ACTIONS.has(request.action)) {
    if (!isCurrentlyPublished(object)) {
      if (!request.principal) return decision('deny', 'DENY_OBJECT_UNPUBLISHED', null, request, world);
    } else {
      const fields = request.object.fields ?? ['public'];
      if (fields.every((field) => field === 'public')) {
        return decision('allow', 'ALLOW_PUBLIC_READ', 'public-read', request, world);
      }
      if (!request.principal) return decision('deny', 'DENY_FIELDS_NOT_PUBLIC', null, request, world);
    }
  }

  // allow_protected branch
  if (!request.principal) return decision('deny', 'DENY_ANONYMOUS', null, request, world);
  const principal = world.principals[request.principal.id];
  if (!principal) return decision('deny', 'DENY_UNKNOWN_PRINCIPAL', null, request, world);
  if (!principal.active) return decision('deny', 'DENY_PRINCIPAL_INACTIVE', null, request, world);

  let revokedHit = false;
  let delegationExpiredHit = false;
  let expiredHit = false;
  let delegationNotEffectiveHit = false;
  let notEffectiveHit = false;
  let invalidHit = false;
  const capabilityMatches: PolicyAssignmentMirror[] = [];
  for (const assignment of world.assignments) {
    if (assignment.principalId !== principal.id) continue;
    const verdict = isWithinValidity(assignment, t);
    const satisfies = satisfiesCapability(request.action, assignment.capabilities);
    if (!verdict.valid) {
      if (satisfies) {
        if (verdict.reason === 'DENY_ASSIGNMENT_REVOKED') revokedHit = true;
        else if (verdict.reason === 'DENY_DELEGATION_EXPIRED') delegationExpiredHit = true;
        else if (verdict.reason === 'DENY_ASSIGNMENT_EXPIRED') expiredHit = true;
        else if (verdict.reason === 'DENY_DELEGATION_NOT_EFFECTIVE') delegationNotEffectiveHit = true;
        else if (verdict.reason === 'DENY_ASSIGNMENT_NOT_EFFECTIVE') notEffectiveHit = true;
        else if (verdict.reason === 'DENY_INVALID_ASSIGNMENT') invalidHit = true;
      }
      continue;
    }
    if (satisfies) capabilityMatches.push(assignment);
  }

  if (capabilityMatches.length === 0) {
    if (revokedHit) return decision('deny', 'DENY_ASSIGNMENT_REVOKED', null, request, world);
    if (delegationExpiredHit) return decision('deny', 'DENY_DELEGATION_EXPIRED', null, request, world);
    if (expiredHit) return decision('deny', 'DENY_ASSIGNMENT_EXPIRED', null, request, world);
    if (delegationNotEffectiveHit) return decision('deny', 'DENY_DELEGATION_NOT_EFFECTIVE', null, request, world);
    if (notEffectiveHit) return decision('deny', 'DENY_ASSIGNMENT_NOT_EFFECTIVE', null, request, world);
    if (invalidHit) return decision('deny', 'DENY_INVALID_ASSIGNMENT', null, request, world);
    return decision('deny', 'DENY_CAPABILITY_NOT_GRANTED', null, request, world);
  }

  const scopeMatches = capabilityMatches.filter((assignment) => coversScope(assignment.scope, object));
  if (scopeMatches.length === 0) return decision('deny', 'DENY_OUT_OF_SCOPE', null, request, world);

  const fields = request.object.fields ?? ['public'];
  const fieldMatches = scopeMatches.filter((assignment) => fieldClassesAllowed(assignment.capabilities, fields));
  if (fieldMatches.length === 0) return decision('deny', 'DENY_FIELD_VISIBILITY', null, request, world);

  if (!READ_ACTIONS.has(request.action)) {
    const allowed = object.status === 'active';
    if (!allowed) return decision('deny', 'DENY_LIFECYCLE_STATE', null, request, world);
  }

  return decision('allow', 'ALLOW_PROTECTED', 'protected', request, world, fieldMatches.map((assignment) => assignment.id));
};

/** The default demo port: fixture world at the fixed fixture clock. */
export interface FixturePolicyPort {
  readonly world: PolicyWorldMirror;
  readonly evaluate: PolicyEvaluator;
  readonly now: string;
}

let cachedPort: FixturePolicyPort | null = null;

/** Memoized default port (fixtures are frozen; the world is immutable). */
export function fixturePolicyPort(): FixturePolicyPort {
  cachedPort ??= { world: fixtureWorld(), evaluate: fixturePolicyEvaluate, now: FIXTURE_CLOCK };
  return cachedPort;
}
