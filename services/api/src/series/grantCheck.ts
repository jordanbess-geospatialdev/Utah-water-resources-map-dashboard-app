/**
 * The single grant gate for every series, comparison and export request
 * (WD-008; FR-006, FR-007, FR-063; acceptance: "comparisons and CSV exports
 * enforce the same grants as chart APIs").
 *
 * Allow rules, exactly the policy-engine branches (technical specification,
 * "Identity and application permissions"):
 *
 *   allow_public_read = browse-published AND object_is_currently_published
 *                       AND fields_are_in_public_projection
 *   allow_protected   = authenticated AND active AND role_grants_requested_action
 *                       AND object_is_within_current_assignment
 *
 * For a datastream read the gate first tries the public projection
 * (action `browse-published`: public-visibility streams on active/inactive
 * published stations). When the stream is not in the public projection the
 * same read is evaluated as `view-restricted-details` (authorization matrix
 * row 3), which an assigned commissioner/engineer/steward satisfies through
 * their operational grants and Sarah only through an approved dataset grant.
 *
 * Denial mapping is the fixed hidden-object policy from
 * services/api/src/auth/README.md (identical to the WD-011 workflow):
 * identity denials 401; unknown object 404; out-of-scope on a NON-public
 * object 404 (the restricted row does not exist for the outsider);
 * out-of-scope on a public object and every other grant-state denial 403.
 *
 * Actor identity always arrives as a server-resolved principal id (session);
 * request bodies never carry it (FR-010).
 */
import { evaluate, type Capability, type Decision, type Principal } from '../../../../packages/policy/src/index.ts';
import type { SeriesStore } from './load.ts';
import type { DomainResult } from './types.ts';

/** What the caller may see when the gate allows. */
export interface ReadGrant {
  readonly streamId: string;
  readonly projection: 'public' | 'full';
  readonly via: 'public-read' | 'protected';
  readonly assignmentVersion: number;
}

export type ReadDenialCode = 'UNAUTHENTICATED' | 'NOT_FOUND' | 'FORBIDDEN';

export interface ReadDenial {
  readonly outcome: 'denied';
  readonly status: 401 | 403 | 404;
  readonly code: ReadDenialCode;
  readonly message: string;
  readonly policyReason: string;
  readonly streamId: string;
}

export type ReadGateResult = ReadGrant | ReadDenial;

const PUBLIC_READ: Capability = 'browse-published';
const PROTECTED_READ: Capability = 'view-restricted-details';

function mapDenial(streamId: string, policy: Decision, objectIsPublic: boolean): ReadDenial {
  if (
    policy.reason === 'DENY_ANONYMOUS' ||
    policy.reason === 'DENY_UNKNOWN_PRINCIPAL' ||
    policy.reason === 'DENY_PRINCIPAL_INACTIVE'
  ) {
    return {
      outcome: 'denied',
      status: 401,
      code: 'UNAUTHENTICATED',
      message: 'reading this stream requires an authenticated, active principal',
      policyReason: policy.reason,
      streamId,
    };
  }
  if (policy.reason === 'DENY_UNKNOWN_OBJECT') {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'stream not found', policyReason: policy.reason, streamId };
  }
  if (policy.reason === 'DENY_OUT_OF_SCOPE' && !objectIsPublic) {
    // Hidden-object policy: a restricted/internal stream does not exist for an outsider.
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'stream not found', policyReason: policy.reason, streamId };
  }
  return {
    outcome: 'denied',
    status: 403,
    code: 'FORBIDDEN',
    message: `actor is not permitted to read this stream (${policy.reason})`,
    policyReason: policy.reason,
    streamId,
  };
}

/**
 * Gate one stream read. `principalId` is null for anonymous callers. The
 * world snapshot comes from the store (authoritative assignment state at the
 * injected `now`); the Decision's assignmentVersion is echoed so callers can
 * refuse results computed from a stale snapshot.
 */
export function readStreamGrant(
  store: SeriesStore,
  principalId: string | null,
  streamId: string,
  now: string,
): ReadGateResult {
  const object = store.world.objects[streamId];
  const principal: Principal | null = principalId ? (store.world.principals[principalId] ?? null) : null;
  if (!object) {
    return {
      outcome: 'denied',
      status: 404,
      code: 'NOT_FOUND',
      message: 'stream not found',
      policyReason: 'DENY_UNKNOWN_OBJECT',
      streamId,
    };
  }

  // Public projection first: anonymous and authenticated callers alike.
  const publicDecision = evaluate({ principal, action: PUBLIC_READ, object: { kind: 'datastream', id: streamId } }, store.world, now);
  if (publicDecision.effect === 'allow') {
    return {
      streamId,
      projection: 'public',
      via: 'public-read',
      assignmentVersion: publicDecision.assignmentVersion,
    };
  }

  // Not in the public projection: the same read as a protected operation.
  const protectedDecision = evaluate(
    { principal, action: PROTECTED_READ, object: { kind: 'datastream', id: streamId } },
    store.world,
    now,
  );
  if (protectedDecision.effect === 'allow') {
    return {
      streamId,
      projection: 'full',
      via: 'protected',
      assignmentVersion: protectedDecision.assignmentVersion,
    };
  }
  // Report the protected-branch denial: an anonymous caller on a
  // non-public stream gets DENY_ANONYMOUS -> 401 (authenticate first);
  // an authenticated outsider gets DENY_OUT_OF_SCOPE -> 404 (hidden object).
  return mapDenial(streamId, protectedDecision, object.visibility === 'public');
}

/**
 * Gate every stream of a multi-stream request (comparison, multi-site
 * export). Fails closed on the first denial; the denial names the stream so
 * the HTTP layer can log it without disclosing it to the caller.
 */
export function readStreamsGrant(
  store: SeriesStore,
  principalId: string | null,
  streamIds: readonly string[],
  now: string,
): DomainResult<readonly ReadGrant[]> {
  const grants: ReadGrant[] = [];
  for (const streamId of streamIds) {
    const gate = readStreamGrant(store, principalId, streamId, now);
    if (gate.outcome === 'denied') {
      return { outcome: 'denied', status: gate.status, code: gate.code, message: gate.message, policyReason: gate.policyReason };
    }
    grants.push(gate);
  }
  return { outcome: 'allowed', value: grants };
}

/** True when the gate allowed (narrow helper for the export job runner). */
export function grantAllowed(result: ReadGateResult): result is ReadGrant {
  return result.outcome !== 'denied';
}
