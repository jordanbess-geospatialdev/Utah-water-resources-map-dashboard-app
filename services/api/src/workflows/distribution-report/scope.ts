/**
 * The report-generation grant gate (WD-025; FR-024 "selected authorized
 * system"; FR-010 server-enforced scoped capabilities).
 *
 * A distribution report is requested against a SYSTEM, so authorization is
 * the action `generate-reports` on the policy object { kind: 'system', id }
 * evaluated by the shared entitlement engine. The engine already implements
 * the deputy delegation window (half-open, delegation-checked before the
 * carrying grant), revocation, expiry and capability satisfaction
 * ('generate-reports' is satisfied by an explicit generate-reports grant or
 * statewide-administration; it is a read-lifecycle action).
 *
 * Denial mapping copies the fixed hidden-object policy used by
 * ../../series/grantCheck.ts and ../revisions (services/api/src/auth/README.md):
 * identity denials 401; unknown object 404; out-of-scope on a NON-public
 * object 404 (the other system does not exist for the caller); every other
 * grant-state denial (capability not granted, delegation expired, field
 * visibility) 403. Actor identity is always a server-resolved principal id;
 * null means anonymous.
 */
import { evaluate } from '../../../../../packages/policy/src/index.ts';
import type { Capability, Decision, PolicyWorld } from '../../../../../packages/policy/src/index.ts';
import type { DomainDenial } from '../../series/types.ts';

const REPORT_ACTION: Capability = 'generate-reports';

export interface ReportScopeGrant {
  readonly systemId: string;
  readonly via: 'protected';
  readonly assignmentVersion: number;
}

export type ReportScopeResult = { outcome: 'allowed'; value: ReportScopeGrant } | DomainDenial;

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
      message: 'generating a distribution report requires an authenticated, active principal',
      policyReason: policy.reason,
    };
  }
  if (policy.reason === 'DENY_UNKNOWN_OBJECT') {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'system not found', policyReason: policy.reason };
  }
  if (policy.reason === 'DENY_OUT_OF_SCOPE') {
    // Hidden-object policy: a system outside the caller's assignment does not
    // exist for them. Systems are never public objects.
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'system not found', policyReason: policy.reason };
  }
  return {
    outcome: 'denied',
    status: 403,
    code: 'FORBIDDEN',
    message: `actor is not permitted to generate reports for this system (${policy.reason})`,
    policyReason: policy.reason,
  };
}

/**
 * Gate one report request. `principalId` is null for anonymous callers; the
 * world must contain the system policy objects (reportWorld().policyWorld or
 * a derived world from withEntitlement/withPrincipal).
 */
export function checkReportScope(world: PolicyWorld, principalId: string | null, systemId: string, now: string): ReportScopeResult {
  const object = world.objects[systemId];
  if (!object) {
    return {
      outcome: 'denied',
      status: 404,
      code: 'NOT_FOUND',
      message: 'system not found',
      policyReason: 'DENY_UNKNOWN_OBJECT',
    };
  }
  const principal = principalId ? (world.principals[principalId] ?? null) : null;
  // generate-reports is never a public action: the public branch denies with
  // DENY_NO_PUBLIC_ACTION and the protected branch below decides.
  const decision = evaluate({ principal, action: REPORT_ACTION, object: { kind: 'system', id: systemId } }, world, now);
  if (decision.effect === 'allow') {
    return { outcome: 'allowed', value: { systemId, via: 'protected', assignmentVersion: decision.assignmentVersion } };
  }
  return mapDenial(systemId, decision);
}
