/**
 * The supplier-reporting grant gate (WD-017; FR-053 "verified supplier";
 * FR-010 server-enforced scoped capabilities).
 *
 * Every supplier-report action is requested against a SYSTEM whose policy
 * object is anchored to its owner organization, so authorization is the
 * action `supplier-reporting` evaluated by the shared entitlement engine
 * with an organization-scoped assignment. The engine already implements
 * validity windows, revocation and deactivation; capability satisfaction is
 * the exact grant only (matrix note: "No MVP grant satisfies
 * supplier-reporting" - notably NOT statewide-administration, so the data
 * steward is deliberately outside this workflow; the Water Use Manager is a
 * separate future owner).
 *
 * Denial mapping copies the fixed hidden-object policy used by
 * ../distribution-report/scope.ts and ../../series/grantCheck.ts: identity
 * denials 401; unknown object 404; out-of-scope on a non-public object 404
 * (the other supplier's system does not exist for the caller - FR-053
 * cross-supplier isolation); every other grant-state denial 403. Actor
 * identity is always a server-resolved principal id; null means anonymous.
 */
import { evaluate } from '../../../../../packages/policy/src/index.ts';
import type { Assignment, Capability, Decision, PolicyWorld } from '../../../../../packages/policy/src/index.ts';
import type { DomainDenial } from '../../series/types.ts';

const SUPPLIER_ACTION: Capability = 'supplier-reporting';

/** Domain-side persona narrowing of the shared grant (documented in world.ts; PENDING owner ratification). */
export type SupplierActorKind = 'supplier' | 'reviewer';

export interface SupplierScopeGrant {
  readonly systemId: string;
  /** The owner organization the matched assignment is scoped to. */
  readonly orgId: string;
  /** 'reviewer' when the matched assignment's role family is 'owner'; suppliers otherwise. */
  readonly actorKind: SupplierActorKind;
  readonly assignmentId: string;
  readonly assignmentVersion: number;
}

export type SupplierScopeResult = { outcome: 'allowed'; value: SupplierScopeGrant } | DomainDenial;

function mapDenial(systemId: string, policy: Decision): DomainDenial {
  if (
    policy.reason === 'DENY_ANONYMOUS' ||
    policy.reason === 'DENY_UNKNOWN_PRINCIPAL' ||
    policy.reason === 'DENY_PRINCIPAL_INACTIVE'
  ) {
    return {
      outcome: 'denied',
      status: 401,
      code: 'UNAUTHENTICATED',
      message: 'supplier reporting requires an authenticated, active principal with a verified organization assignment',
      policyReason: policy.reason,
    };
  }
  if (policy.reason === 'DENY_UNKNOWN_OBJECT') {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'system not found', policyReason: policy.reason };
  }
  if (policy.reason === 'DENY_OUT_OF_SCOPE') {
    // Hidden-object policy: a supplier system outside the caller's
    // organization does not exist for them (FR-053: cross-supplier isolation).
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'system not found', policyReason: policy.reason };
  }
  return {
    outcome: 'denied',
    status: 403,
    code: 'FORBIDDEN',
    message: `actor is not permitted supplier reporting on this system (${policy.reason})`,
    policyReason: policy.reason,
  };
}

function actorKindOf(assignment: Assignment): SupplierActorKind {
  return assignment.role === 'owner' ? 'reviewer' : 'supplier';
}

/**
 * Gate one supplier-report request. `principalId` is null for anonymous
 * callers; the world must contain the supplier system objects
 * (supplierWorld().policyWorld or a derived world from withSupplierActor /
 * withEntitlement).
 */
export function checkSupplierScope(world: PolicyWorld, principalId: string | null, systemId: string, now: string): SupplierScopeResult {
  const object = world.objects[systemId];
  if (!object || object.kind !== 'system') {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'system not found', policyReason: 'DENY_UNKNOWN_OBJECT' };
  }
  const principal = principalId ? (world.principals[principalId] ?? null) : null;
  // supplier-reporting is never a public action: the protected branch decides.
  const decision = evaluate({ principal, action: SUPPLIER_ACTION, object: { kind: 'system', id: systemId } }, world, now);
  if (decision.effect === 'allow') {
    const matched = decision.matchedAssignmentIds
      .map((id) => world.assignments.find((assignment) => assignment.id === id))
      .filter((assignment): assignment is Assignment => assignment !== undefined)
      .find((assignment) => assignment.scope.kind === 'organization' && assignment.scope.id !== null);
    if (!matched) {
      // Structurally impossible via the fixture vocabulary, but fail closed.
      return { outcome: 'denied', status: 403, code: 'FORBIDDEN', message: 'no organization-scoped supplier assignment matched', policyReason: 'DENY_OUT_OF_SCOPE' };
    }
    return {
      outcome: 'allowed',
      value: {
        systemId,
        orgId: matched.scope.id as string,
        actorKind: actorKindOf(matched),
        assignmentId: matched.id,
        assignmentVersion: decision.assignmentVersion,
      },
    };
  }
  return mapDenial(systemId, decision);
}

/**
 * Reviewer-only gate for the distinct approval transitions (boundary
 * approval, resubmission approval): the same organization-scoped
 * supplier-reporting grant but with role family 'owner' (the Water Use side).
 * A supplier ('water-user' family) proposing is never the one approving.
 */
export function checkReviewerScope(world: PolicyWorld, principalId: string | null, systemId: string, now: string): SupplierScopeResult {
  const scope = checkSupplierScope(world, principalId, systemId, now);
  if (scope.outcome === 'denied') return scope;
  if (scope.value.actorKind !== 'reviewer') {
    return {
      outcome: 'denied',
      status: 403,
      code: 'REVIEWER_REQUIRED',
      message: 'approval is a distinct reviewer transition: the proposing supplier account cannot approve (role family must be owner)',
      policyReason: 'DENY_CAPABILITY_NOT_GRANTED',
    };
  }
  return scope;
}
