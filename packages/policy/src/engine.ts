/**
 * The entitlement evaluation engine.
 *
 * Implements the technical specification rules exactly:
 *
 *   allow_public_read = explicit_public_read_action
 *                       AND object_is_currently_published
 *                       AND fields_are_in_public_projection
 *
 *   allow_protected = authenticated AND principal_is_active
 *                     AND role_grants_requested_action
 *                     AND object_is_within_current_assignment
 *                     AND field_visibility_allows_requested_fields
 *                     AND lifecycle_allows_requested_change
 *
 *   allow = allow_public_read OR allow_protected
 *
 * Purity contract: evaluate(request, world, now) reads nothing but its
 * arguments, never throws for unknown identifiers (unknown -> deny), and is
 * deterministic for identical inputs. Revocation, expiry and deactivation
 * are checked against the injected clock and the authoritative world
 * snapshot; the engine consults no cache, and the assignment version of the
 * snapshot it used is echoed on every Decision so callers can refuse results
 * computed from stale state.
 */
import type {
  ActorSnapshot,
  Assignment,
  AuthorizationRequest,
  Capability,
  Decision,
  DecisionReason,
  Delegation,
  FieldClass,
  LifecycleState,
  PolicyObject,
  PolicyWorld,
  Principal,
  PrincipalsFixture,
  RawEntitlement,
  Scope,
  ScopeKind,
  StationsFixture,
} from './types.ts';
import { POLICY_VERSION } from './types.ts';
import {
  ACTION_LIFECYCLE_CLASS,
  CAPABILITY_SATISFIES,
  INTERNAL_FIELD_READ_CAPABILITIES,
  LIFECYCLE_ALLOWED_STATES,
  OWN_ACCOUNT_ACTIONS,
  PUBLIC_ACTIONS,
  RESTRICTED_FIELD_READ_CAPABILITIES,
  SATISFACTION_ROLE_GATES,
} from './matrix.ts';

// ---------------------------------------------------------------------------
// Fixture parsing and world construction
// ---------------------------------------------------------------------------

/** Parse a fixture user into a Principal. Role strings are trusted to be schema-valid (schemas/entitlement.json enum). */
export function parsePrincipal(user: PrincipalsFixture['users'][number]): Principal {
  return Object.freeze({
    id: user.id,
    displayName: user.displayName,
    active: user.active === true,
    roles: Object.freeze([...user.roles]),
    assignedSystemId: user.assignedSystemId ?? null,
    description: user.description,
  });
}

/** Parse a fixture entitlement (scopeType/scopeId) into an engine Assignment. */
export function parseEntitlement(raw: RawEntitlement): Assignment {
  const scope: Scope = Object.freeze({ kind: raw.scopeType as ScopeKind, id: raw.scopeId ?? null });
  const delegation: Delegation | null = raw.delegation
    ? Object.freeze({
        effectiveAt: raw.delegation.effectiveAt,
        expiresAt: raw.delegation.expiresAt,
        delegatedBy: raw.delegation.delegatedBy,
      })
    : null;
  return Object.freeze({
    id: raw.id,
    principalId: raw.principalId,
    role: raw.role as Assignment['role'],
    capabilities: Object.freeze([...(raw.capabilities ?? [])]) as readonly Capability[],
    scope,
    effectiveAt: raw.effectiveAt,
    expiresAt: raw.expiresAt ?? null,
    status: raw.status === 'revoked' ? 'revoked' : 'active',
    delegation,
    grantedBy: raw.grantedBy,
    grantVersion: raw.grantVersion,
  });
}

function stationToObject(station: StationsFixture['stations'][number]): PolicyObject {
  const fields: Record<string, FieldClass> = {};
  if (station.internal) {
    for (const key of Object.keys(station.internal)) {
      if (key === 'visibility') continue;
      fields[key] = 'internal';
    }
  }
  return Object.freeze({
    id: station.id,
    kind: 'station',
    systemId: station.systemId,
    ownerOrganizationId: station.ownerOrganizationId ?? null,
    stationId: null,
    datasetId: null,
    ownerPrincipalId: null,
    targetObjectId: null,
    visibility: station.visibility === 'public' ? 'public' : station.visibility === 'internal' ? 'internal' : 'restricted',
    status: station.status as LifecycleState,
    fields: Object.freeze(fields),
  });
}

function datastreamToObject(station: StationsFixture['stations'][number], stream: { id: string; stationId: string; visibility: string }): PolicyObject {
  return Object.freeze({
    id: stream.id,
    kind: 'datastream',
    systemId: station.systemId,
    ownerOrganizationId: station.ownerOrganizationId ?? null,
    stationId: stream.stationId,
    datasetId: null,
    ownerPrincipalId: null,
    targetObjectId: null,
    visibility: stream.visibility === 'public' ? 'public' : stream.visibility === 'internal' ? 'internal' : 'restricted',
    // A datastream inherits its station's lifecycle: readings on an inactive
    // station are closed regardless of stream visibility.
    status: station.status as LifecycleState,
    fields: Object.freeze({}),
  });
}

export interface BuildWorldInput {
  principals: PrincipalsFixture;
  stations?: StationsFixture;
  /** Extra policy objects: datasets, preferences, tokens, vocabulary, providers, synthetic observations... */
  extraObjects?: readonly PolicyObject[];
  /** Extra principals (e.g. synthetic water-user/owner personas bound to fixture organizations). */
  extraPrincipals?: readonly Principal[];
  /** Extra entitlements in fixture shape. */
  extraEntitlements?: readonly RawEntitlement[];
}

/** Build the authoritative world snapshot from contract fixtures plus test/service-supplied extras. */
export function buildWorld(input: BuildWorldInput): PolicyWorld {
  const principals: Record<string, Principal> = {};
  const objects: Record<string, PolicyObject> = {};
  const assignments: Assignment[] = [];

  for (const org of input.principals.organizations ?? []) {
    objects[org.id] = Object.freeze({
      id: org.id,
      kind: 'organization',
      systemId: null,
      ownerOrganizationId: org.id,
      stationId: null,
      datasetId: null,
      ownerPrincipalId: null,
      targetObjectId: null,
      visibility: 'restricted',
      status: 'active',
      fields: Object.freeze({}),
    });
  }
  for (const user of input.principals.users) {
    const principal = parsePrincipal(user);
    principals[principal.id] = principal;
    // Every user is also a manageable object for the steward (manage-users).
    objects[principal.id] = Object.freeze({
      id: principal.id,
      kind: 'user',
      systemId: principal.assignedSystemId ?? null,
      ownerOrganizationId: null,
      stationId: null,
      datasetId: null,
      ownerPrincipalId: principal.id,
      targetObjectId: null,
      visibility: 'internal',
      status: 'active',
      fields: Object.freeze({}),
    });
  }
  for (const ent of input.principals.entitlements) assignments.push(parseEntitlement(ent));

  if (input.stations) {
    for (const station of input.stations.stations) {
      objects[station.id] = stationToObject(station);
      for (const stream of station.datastreams ?? []) objects[stream.id] = datastreamToObject(station, stream);
    }
  }

  for (const principal of input.extraPrincipals ?? []) principals[principal.id] = principal;
  for (const object of input.extraObjects ?? []) objects[object.id] = object;
  for (const ent of input.extraEntitlements ?? []) assignments.push(parseEntitlement(ent));

  const assignmentVersion = assignments.reduce((max, a) => Math.max(max, a.grantVersion), 0);
  return Object.freeze({
    seed: input.principals.seed,
    principals: Object.freeze(principals),
    assignments: Object.freeze(assignments),
    objects: Object.freeze(objects),
    assignmentVersion,
  });
}

/** Test/service helper: derive a modified world without mutating the original (decisions stay reproducible). */
export function withPrincipal(world: PolicyWorld, principalId: string, patch: Partial<{ active: boolean; roles: readonly string[] }>): PolicyWorld {
  const existing = world.principals[principalId];
  if (!existing) throw new Error(`withPrincipal: unknown principal "${principalId}"`);
  const principals = { ...world.principals, [principalId]: Object.freeze({ ...existing, ...patch }) };
  return Object.freeze({ ...world, principals: Object.freeze(principals) });
}

/** Test/service helper: derive a world with one entitlement patched (revocation, expiry change, scope change). */
export function withEntitlement(world: PolicyWorld, entitlementId: string, patch: Partial<RawEntitlement>): PolicyWorld {
  const index = world.assignments.findIndex((a) => a.id === entitlementId);
  if (index < 0) throw new Error(`withEntitlement: unknown entitlement "${entitlementId}"`);
  const raw: RawEntitlement = {
    id: 'id' in patch ? (patch.id as string) : world.assignments[index].id,
    principalId: 'principalId' in patch ? (patch.principalId as string) : world.assignments[index].principalId,
    role: 'role' in patch ? (patch.role as string) : world.assignments[index].role,
    capabilities: 'capabilities' in patch ? (patch.capabilities as readonly string[]) : [...world.assignments[index].capabilities],
    scopeType: 'scopeType' in patch ? (patch.scopeType as string) : world.assignments[index].scope.kind,
    scopeId: 'scopeId' in patch ? (patch.scopeId as string | null) : world.assignments[index].scope.id,
    effectiveAt: 'effectiveAt' in patch ? (patch.effectiveAt as string) : world.assignments[index].effectiveAt,
    expiresAt: 'expiresAt' in patch ? (patch.expiresAt as string | null) : world.assignments[index].expiresAt,
    status: 'status' in patch ? (patch.status as string) : world.assignments[index].status,
    delegation: 'delegation' in patch ? (patch.delegation as RawEntitlement['delegation']) : world.assignments[index].delegation,
    grantedBy: 'grantedBy' in patch ? (patch.grantedBy as string) : world.assignments[index].grantedBy,
    grantVersion: 'grantVersion' in patch ? (patch.grantVersion as number) : world.assignments[index].grantVersion,
  };
  const assignments = [...world.assignments];
  assignments[index] = parseEntitlement(raw);
  const assignmentVersion = assignments.reduce((max, a) => Math.max(max, a.grantVersion), 0);
  return Object.freeze({ ...world, assignments: Object.freeze(assignments), assignmentVersion });
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an actor snapshot for audit. Returns the principal even when
 * deactivated or when every assignment has lapsed: historical references
 * stay resolvable while remaining unusable for authorization (FR-011,
 * "deactivated actors remain identifiable in history"). Unknown ids return
 * null; they never authorize anything.
 */
export function resolveActor(world: PolicyWorld, principalId: string): ActorSnapshot | null {
  return world.principals[principalId] ?? null;
}

/** Authoritative assignment version for one principal: the max grantVersion over their entitlements (0 when none). */
export function assignmentVersionOf(world: PolicyWorld, principalId: string): number {
  return world.assignments.reduce((max, a) => (a.principalId === principalId ? Math.max(max, a.grantVersion) : max), 0);
}

/** Currently effective capabilities of a principal at `now` (for GET /session: subject, capabilities, assignment version, server time). */
export function capabilitiesOf(world: PolicyWorld, principalId: string, now: Date | string): readonly Capability[] {
  const t = instant(now);
  const principal = world.principals[principalId];
  if (!principal || !principal.active) return [];
  const result = new Set<Capability>();
  for (const assignment of world.assignments) {
    if (assignment.principalId !== principalId) continue;
    if (assignment.status !== 'active') continue;
    if (!isWithinValidity(assignment, t).valid) continue;
    for (const capability of assignment.capabilities) result.add(capability);
  }
  return [...result].sort();
}

// ---------------------------------------------------------------------------
// Core evaluation
// ---------------------------------------------------------------------------

function instant(now: Date | string): number {
  return typeof now === 'string' ? Date.parse(now) : now.getTime();
}

/**
 * "object_is_currently_published": a separately approved publication
 * projection. A public-visibility object whose lifecycle left the published
 * set (proposed, retired) is NOT currently published. Inactive stations
 * remain published as historical records; their measurement lifecycle is
 * closed separately by the lifecycle clause.
 */
export function isCurrentlyPublished(object: PolicyObject): boolean {
  return object.visibility === 'public' && (object.status === 'active' || object.status === 'inactive');
}

/** A grant capability satisfies the requested action per CAPABILITY_SATISFIES (matrix-constrained). */
export function satisfiesCapability(action: string, granted: readonly Capability[]): boolean {
  const satisfiers = CAPABILITY_SATISFIES[action];
  if (!satisfiers) return granted.includes(action as Capability);
  return satisfiers.some((s) => granted.includes(s));
}

/**
 * Persona-gate check (WD-004 / DEFECT-Q3): a satisfier bound in
 * SATISFACTION_ROLE_GATES for the requested action only satisfies when the
 * requesting principal belongs to one of the gate's role families. A role
 * label never grants anything by itself; like the deputy delegation checks
 * in isWithinValidity, it can only NARROW what a granted capability
 * satisfies. Ungated satisfiers are always permitted.
 */
function satisfierPermitted(action: string, satisfier: string, principal: Principal | null): boolean {
  const gate = SATISFACTION_ROLE_GATES[action]?.[satisfier];
  if (!gate) return true;
  if (!principal) return false;
  return principal.roles.some((role) => gate.includes(role));
}

/**
 * Principal-aware form of satisfiesCapability: the table question plus the
 * persona gates from matrix.ts. This is what `evaluate` consults, so a bare
 * statewide-administration grant satisfies field-visits only for the
 * steward persona family (ROLE_CEILING.steward carries the grant but does
 * not list field-visits); identical grants are never gated.
 */
export function satisfiesCapabilityFor(action: string, granted: readonly Capability[], principal: Principal | null): boolean {
  const satisfiers = CAPABILITY_SATISFIES[action];
  if (!satisfiers) return granted.includes(action as Capability);
  return satisfiers.some((satisfier) => granted.includes(satisfier) && satisfierPermitted(action, satisfier, principal));
}

interface ValidityVerdict {
  valid: boolean;
  reason: DecisionReason | null;
}

/**
 * Validity of an assignment at time t. Half-open intervals throughout:
 * [effectiveAt, expiresAt) and [delegation.effectiveAt, delegation.expiresAt).
 * A revoked status wins over every other consideration, including any cached
 * copy (entitlement schema: "revoked wins over any cached copy").
 * Deputies must carry a delegation and must not be statewide.
 */
function isWithinValidity(assignment: Assignment, t: number): ValidityVerdict {
  if (assignment.status === 'revoked') return { valid: false, reason: 'DENY_ASSIGNMENT_REVOKED' };
  const effectiveAt = Date.parse(assignment.effectiveAt);
  const expiresAt = assignment.expiresAt === null ? null : Date.parse(assignment.expiresAt);
  if (!Number.isFinite(t) || !Number.isFinite(effectiveAt) ||
      (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= effectiveAt))) {
    return { valid: false, reason: 'DENY_INVALID_ASSIGNMENT' };
  }
  if (assignment.role === 'deputy') {
    if (!assignment.delegation) return { valid: false, reason: 'DENY_INVALID_ASSIGNMENT' };
    if (assignment.scope.kind === 'statewide') return { valid: false, reason: 'DENY_INVALID_ASSIGNMENT' };
  }
  if (assignment.scope.kind === 'statewide' && assignment.scope.id !== null) return { valid: false, reason: 'DENY_INVALID_ASSIGNMENT' };
  // For deputies the delegation window is the authoritative, tighter bound:
  // check it before the generic assignment window so boundary denials name
  // the delegation (the audited object) rather than the carrying grant.
  if (assignment.delegation) {
    const delegatedAt = Date.parse(assignment.delegation.effectiveAt);
    const delegatedUntil = Date.parse(assignment.delegation.expiresAt);
    if (!Number.isFinite(delegatedAt) || !Number.isFinite(delegatedUntil) || delegatedUntil <= delegatedAt) {
      return { valid: false, reason: 'DENY_INVALID_ASSIGNMENT' };
    }
    if (delegatedAt > t) return { valid: false, reason: 'DENY_DELEGATION_NOT_EFFECTIVE' };
    if (t >= delegatedUntil) return { valid: false, reason: 'DENY_DELEGATION_EXPIRED' };
  }
  if (effectiveAt > t) return { valid: false, reason: 'DENY_ASSIGNMENT_NOT_EFFECTIVE' };
  if (expiresAt !== null && t >= expiresAt) return { valid: false, reason: 'DENY_ASSIGNMENT_EXPIRED' };
  return { valid: true, reason: null };
}

/**
 * "object_is_within_current_assignment": server-side scope resolution.
 * `destinationSystemId` implements the rule that a site edit moving a site to
 * another system must validate BOTH current and destination scope; a
 * system-scoped holder can therefore never move a site out of (or into) their
 * system. Ordinary commissioners cannot assign themselves sites: create-sites
 * is only satisfied by an explicit create-sites grant, which the fixture
 * commissioner does not hold.
 */
function coversScope(scope: Scope, object: PolicyObject, destinationSystemId: string | null | undefined): boolean {
  switch (scope.kind) {
    case 'statewide':
      if (scope.id !== null) return false;
      return true;
    case 'system':
      if (!scope.id || object.systemId !== scope.id) return false;
      if (destinationSystemId != null && destinationSystemId !== object.systemId) return false;
      return true;
    case 'organization':
      return scope.id !== null && object.ownerOrganizationId === scope.id;
    case 'site':
      if (!scope.id) return false;
      return object.id === scope.id || object.stationId === scope.id;
    case 'dataset':
      if (!scope.id) return false;
      return object.datasetId === scope.id || object.id === scope.id;
    default:
      return false;
  }
}

/** "field_visibility_allows_requested_fields": class-level check (FR-049: row visibility alone is not sufficient). */
function fieldClassesAllowed(granted: readonly Capability[], fields: readonly FieldClass[]): boolean {
  for (const field of fields) {
    if (field === 'public') continue;
    if (field === 'restricted') {
      if (!granted.some((c) => RESTRICTED_FIELD_READ_CAPABILITIES.has(c))) return false;
    } else if (field === 'internal') {
      if (!granted.some((c) => INTERNAL_FIELD_READ_CAPABILITIES.has(c))) return false;
    } else {
      return false;
    }
  }
  return true;
}

/** "lifecycle_allows_requested_change". */
function lifecycleAllows(action: string, object: PolicyObject): boolean {
  const lifecycleClass = ACTION_LIFECYCLE_CLASS[action] ?? 'mutate';
  const allowed = LIFECYCLE_ALLOWED_STATES[lifecycleClass];
  return allowed.includes(object.status);
}

function deny(reason: DecisionReason, request: AuthorizationRequest, world: PolicyWorld, now: number, detail?: string): Decision {
  return {
    effect: 'deny',
    reason,
    via: null,
    actorId: request.principal ? request.principal.id : null,
    policyVersion: POLICY_VERSION,
    evaluatedAt: new Date(now).toISOString(),
    matchedAssignmentIds: [],
    assignmentVersion: world.assignmentVersion,
    detail,
  };
}

function allow(reason: DecisionReason, request: AuthorizationRequest, world: PolicyWorld, now: number, matched: readonly string[], via: 'public-read' | 'protected'): Decision {
  return {
    effect: 'allow',
    reason,
    via,
    actorId: request.principal ? request.principal.id : null,
    policyVersion: POLICY_VERSION,
    evaluatedAt: new Date(now).toISOString(),
    matchedAssignmentIds: matched,
    assignmentVersion: world.assignmentVersion,
  };
}

/**
 * Can the principal read the target object at all (public projection or any
 * effective restricted-read grant)? Used for the favorites rule: a preference
 * may only target an object its owner can read
 * ("PUT /me/favorites/{siteId}: Add favorite only if published or otherwise
 * readable"). Deliberately shallow: public projection, or any valid
 * assignment covering the object with a restricted-read capability.
 */
function canReadObject(principal: Principal, object: PolicyObject, world: PolicyWorld, t: number): boolean {
  if (isCurrentlyPublished(object)) return true;
  for (const assignment of world.assignments) {
    if (assignment.principalId !== principal.id) continue;
    if (assignment.status !== 'active') continue;
    if (!isWithinValidity(assignment, t).valid) continue;
    if (!coversScope(assignment.scope, object, null)) continue;
    if (assignment.capabilities.some((c) => RESTRICTED_FIELD_READ_CAPABILITIES.has(c))) return true;
  }
  return false;
}

/**
 * The allow_public_read branch in isolation. Exported for transport layers
 * that must decide whether a response is eligible for public caching
 * (T-08): a decision allowing here and only here is public-projectable.
 * Reports DENY_NO_PUBLIC_ACTION when the requested action is not one of the
 * explicit public actions, DENY_OBJECT_UNPUBLISHED /
 * DENY_FIELDS_NOT_PUBLIC for the other two conjuncts.
 */
export function evaluatePublicRead(request: AuthorizationRequest, world: PolicyWorld, now: Date | string): Decision {
  const t = instant(now);
  if (!request || typeof request.action !== 'string' || request.action.length === 0 || !request.object || typeof request.object.id !== 'string' || request.object.id.length === 0) {
    return deny('DENY_INVALID_REQUEST', request ?? { principal: null, action: '' as Capability, object: { kind: 'station', id: '' } }, world, t);
  }
  const object = world.objects[request.object.id];
  if (!object) {
    return deny('DENY_UNKNOWN_OBJECT', request, world, t, `no object "${request.object.id}" in world "${world.seed}"`);
  }
  if (!PUBLIC_ACTIONS.has(request.action)) {
    return deny('DENY_NO_PUBLIC_ACTION', request, world, t, `"${request.action}" is not satisfiable by the public read branch`);
  }
  if (!isCurrentlyPublished(object)) {
    return deny('DENY_OBJECT_UNPUBLISHED', request, world, t, `object "${object.id}" is not currently published`);
  }
  const fields = request.object.fields ?? ['public'];
  if (!fields.every((f) => f === 'public')) {
    return deny('DENY_FIELDS_NOT_PUBLIC', request, world, t, 'requested fields leave the public projection');
  }
  return allow('ALLOW_PUBLIC_READ', request, world, t, [], 'public-read');
}

/**
 * Evaluate an authorization request against the authoritative world at `now`.
 * Never throws: unknown actions, objects or principals deny with a
 * machine-readable reason (unknown may not error into allow).
 */
export function evaluate(request: AuthorizationRequest, world: PolicyWorld, now: Date | string): Decision {
  const t = instant(now);

  if (!request || typeof request.action !== 'string' || request.action.length === 0 || !request.object || typeof request.object.id !== 'string' || request.object.id.length === 0) {
    return deny('DENY_INVALID_REQUEST', { principal: null, action: '' as Capability, object: { kind: 'station', id: '' } }, world, t);
  }

  const object = world.objects[request.object.id];
  if (!object) {
    return deny('DENY_UNKNOWN_OBJECT', request, world, t, `no object "${request.object.id}" in world "${world.seed}"`);
  }

  // --- allow_public_read branch -------------------------------------------
  if (PUBLIC_ACTIONS.has(request.action)) {
    if (!isCurrentlyPublished(object)) {
      if (!request.principal) return deny('DENY_OBJECT_UNPUBLISHED', request, world, t);
    } else {
      const fields = request.object.fields ?? ['public'];
      if (fields.every((f) => f === 'public')) {
        return allow('ALLOW_PUBLIC_READ', request, world, t, [], 'public-read');
      }
      if (!request.principal) return deny('DENY_FIELDS_NOT_PUBLIC', request, world, t);
    }
  }

  // --- allow_protected branch ---------------------------------------------
  if (!request.principal) {
    return deny('DENY_ANONYMOUS', request, world, t, 'protected action requires an authenticated principal');
  }
  const principal = world.principals[request.principal.id];
  if (!principal) {
    return deny('DENY_UNKNOWN_PRINCIPAL', request, world, t, `no principal "${request.principal.id}" in world "${world.seed}"`);
  }
  if (!principal.active) {
    return deny('DENY_PRINCIPAL_INACTIVE', request, world, t, 'deactivated principal; actor remains resolvable for audit via resolveActor()');
  }

  // Own-account objects (preferences, tokens): ownership satisfies the
  // action without an assignment, but a favorite must target a readable
  // object, and no favoriting ever grants anything else.
  const ownKind = OWN_ACCOUNT_ACTIONS[request.action];
  if (ownKind && object.kind === ownKind && object.ownerPrincipalId === principal.id) {
    if (request.action === 'manage-own-preferences' && object.targetObjectId) {
      const target = world.objects[object.targetObjectId];
      if (!target) return deny('DENY_UNKNOWN_OBJECT', request, world, t, `preference target "${object.targetObjectId}" not found`);
      if (!canReadObject(principal, target, world, t)) {
        return deny('DENY_OUT_OF_SCOPE', request, world, t, 'a favorite may only target a published or otherwise readable object');
      }
    }
    return allow('ALLOW_PROTECTED', request, world, t, [], 'protected');
  }

  // Scan the principal's assignments. Track why near-miss assignments failed
  // so denial reasons distinguish revoked / expired / not-yet-effective from
  // a plain missing grant.
  let revokedHit = false;
  let delegationExpiredHit = false;
  let expiredHit = false;
  let delegationNotEffectiveHit = false;
  let notEffectiveHit = false;
  let invalidHit = false;
  const capabilityMatches: Assignment[] = [];
  for (const assignment of world.assignments) {
    if (assignment.principalId !== principal.id) continue;
    const verdict = isWithinValidity(assignment, t);
    const satisfies = satisfiesCapabilityFor(request.action, assignment.capabilities, principal);
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
    if (revokedHit) return deny('DENY_ASSIGNMENT_REVOKED', request, world, t, 'grant revoked; authoritative status wins over any cache');
    if (delegationExpiredHit) return deny('DENY_DELEGATION_EXPIRED', request, world, t, 'deputy delegation window closed');
    if (expiredHit) return deny('DENY_ASSIGNMENT_EXPIRED', request, world, t, 'grant expired');
    if (delegationNotEffectiveHit) return deny('DENY_DELEGATION_NOT_EFFECTIVE', request, world, t, 'deputy delegation not yet effective');
    if (notEffectiveHit) return deny('DENY_ASSIGNMENT_NOT_EFFECTIVE', request, world, t, 'grant not yet effective');
    if (invalidHit) return deny('DENY_INVALID_ASSIGNMENT', request, world, t, 'structurally invalid grant (deputy without delegation or statewide deputy)');
    return deny('DENY_CAPABILITY_NOT_GRANTED', request, world, t, `no active grant of "${request.action}"`);
  }

  const scopeMatches = capabilityMatches.filter((a) => coversScope(a.scope, object, request.object.destinationSystemId ?? null));
  if (scopeMatches.length === 0) {
    return deny('DENY_OUT_OF_SCOPE', request, world, t, 'capability held but no current assignment covers the object');
  }

  const fields = request.object.fields ?? ['public'];
  const fieldMatches = scopeMatches.filter((a) => fieldClassesAllowed(a.capabilities, fields));
  if (fieldMatches.length === 0) {
    return deny('DENY_FIELD_VISIBILITY', request, world, t, `assignment does not cover requested field classes [${fields.join(', ')}]`);
  }

  if (!lifecycleAllows(request.action, object)) {
    return deny('DENY_LIFECYCLE_STATE', request, world, t, `lifecycle state "${object.status}" does not allow "${request.action}"`);
  }

  return allow('ALLOW_PROTECTED', request, world, t, fieldMatches.map((a) => a.id), 'protected');
}
