/**
 * Scoped-request evaluation: where a token's declared scopes INTERSECT the
 * policy engine's decision (WD-016; FR-064/FR-065).
 *
 * The composition rule, applied on every request:
 *
 *   scoped_allow = token_allows_action
 *                  AND token_covers_the_requested_data
 *                  AND policy_engine_allows_for_the_PRINCIPAL_now
 *
 * The third conjunct is the load-bearing one: a token NEVER carries authority
 * of its own. It borrows the principal's CURRENT authority, re-resolved from
 * the authoritative world snapshot at request time - so revoking the
 * underlying assignment (or deactivating the account) kills the token's
 * request even while the token record itself is still active. Tests pin this
 * cascade in test/tokens.test.ts ("principal-grant revocation cascades").
 *
 * The second conjunct implements the FR-065 data bounds: a token without the
 * property/processing-level/date/stream dimension cannot query it, and a
 * window outside the token's dateRange is REJECTED (403, TOKEN_SCOPE), never
 * silently clamped - the same "no silent truncation" rule FR-063 sets for
 * exports.
 */
import {
  evaluate,
  type Capability,
  type Decision,
  type ObjectKind,
  type PolicyWorld,
  type Principal,
} from '../../../../packages/policy/src/index.ts';
import type { ProcessingLevel, TokenAction, TokenRecord, TokenScopes } from './types.ts';

/**
 * Which policy capability each wire action requires. `observations:read`
 * needs the two-step public/protected treatment (identical to
 * services/api/src/series/grantCheck.ts): the public projection first, then
 * `view-restricted-details` for streams outside it.
 */
export const ACTION_REQUIREMENTS: Readonly<Record<TokenAction, readonly Capability[]>> = {
  'catalog:read': ['browse-published'],
  'sites:read': ['browse-published'],
  'observations:read': ['browse-published', 'view-restricted-details'],
  'history:read': ['read-approved-datasets'],
  'exports:create': ['create-exports'],
};

/** Capabilities an action can be satisfied by (public branch needs none). */
export function capabilitiesRequiredBy(action: TokenAction): readonly Capability[] {
  return ACTION_REQUIREMENTS[action] ?? [];
}

/** True when the token's declared action list admits this action. */
export function tokenAllowsAction(scopes: TokenScopes, action: TokenAction): boolean {
  if (!scopes.actions) return true; // absent = every action, still bounded by the principal
  return scopes.actions.includes(action);
}

/** Query coordinates the data bounds apply to. Absent fields are unconstrained. */
export interface ScopedQuery {
  readonly streamId?: string;
  readonly observedPropertyId?: string;
  readonly processingLevel?: ProcessingLevel;
  /** Half-open [start, end) observation-time window of the request. */
  readonly start?: string;
  readonly end?: string;
}

export type ScopeCoverReason =
  | 'COVERED'
  | 'STREAM_NOT_IN_SCOPE'
  | 'PROPERTY_NOT_IN_SCOPE'
  | 'PROCESSING_LEVEL_NOT_IN_SCOPE'
  | 'DATE_RANGE_NOT_IN_SCOPE';

export interface ScopeCoverResult {
  readonly covered: boolean;
  readonly reason: ScopeCoverReason;
  readonly detail?: string;
}

/**
 * Do the token's DATA bounds cover this query? Pure, clock-free, throws
 * never. Absent scope dimensions never block; present dimensions must fully
 * contain the request.
 */
export function scopeCoversQuery(scopes: TokenScopes, query: ScopedQuery): ScopeCoverResult {
  if (scopes.streams && query.streamId !== undefined && !scopes.streams.includes(query.streamId)) {
    return { covered: false, reason: 'STREAM_NOT_IN_SCOPE', detail: `stream "${query.streamId}" is outside this token's declared streams` };
  }
  if (scopes.properties && query.observedPropertyId !== undefined && !scopes.properties.includes(query.observedPropertyId)) {
    return {
      covered: false,
      reason: 'PROPERTY_NOT_IN_SCOPE',
      detail: `property "${query.observedPropertyId}" is outside this token's declared properties`,
    };
  }
  if (scopes.processingLevels && query.processingLevel !== undefined && !scopes.processingLevels.includes(query.processingLevel)) {
    return {
      covered: false,
      reason: 'PROCESSING_LEVEL_NOT_IN_SCOPE',
      detail: `processing level "${query.processingLevel}" is outside this token's declared levels`,
    };
  }
  const range = scopes.dateRange ?? null;
  if (range) {
    if (query.start !== undefined && Date.parse(query.start) < Date.parse(range.start)) {
      return { covered: false, reason: 'DATE_RANGE_NOT_IN_SCOPE', detail: `requested start precedes the token's window (${range.start})` };
    }
    if (query.end !== undefined && Date.parse(query.end) > Date.parse(range.end)) {
      return { covered: false, reason: 'DATE_RANGE_NOT_IN_SCOPE', detail: `requested end exceeds the token's window (${range.end})` };
    }
  }
  return { covered: true, reason: 'COVERED' };
}

/** The scoped-request verdict for the transport layer. */
export interface ScopedDecision {
  readonly effect: 'allow' | 'deny';
  /** Policy engine Decision when it ran (audit trail); null on token-scope denials before it. */
  readonly policy: Decision | null;
  /** Token-scope denial reason; 'OK' on allow and on pure policy denials. */
  readonly scopeReason: ScopeCoverReason | 'ACTION_NOT_IN_SCOPE' | 'OK';
  /** Policy denial reason when effect is deny and the engine produced one. */
  readonly policyReason: string | null;
  readonly tokenId: string;
  readonly principalId: string;
  readonly action: TokenAction;
}

/**
 * The credential view authorizeScoped needs: identity + scopes. Accepts a
 * full TokenRecord or its public view (the hash is irrelevant here - this
 * evaluation happens AFTER verify()).
 */
export type ScopedCredential = Pick<TokenRecord, 'id' | 'principalId' | 'scopes'>;

function scopedDeny(token: ScopedCredential, action: TokenAction, scopeReason: ScopedDecision['scopeReason'], policy: Decision | null): ScopedDecision {
  return {
    effect: 'deny',
    policy,
    scopeReason,
    policyReason: policy ? policy.reason : null,
    tokenId: token.id,
    principalId: token.principalId,
    action,
  };
}

/**
 * Authorize one scoped request. `object` is the policy target (datastream,
 * site, dataset, export, ...); `query` carries the request's data coordinates
 * for the bounds check. The principal is resolved from the world by the
 * TOKEN's owner - identity always arrives server-side (FR-010), here from the
 * verified credential rather than from any request field.
 *
 * Evaluation order (fail-closed, cheapest and most token-local first):
 * 1. action within the token's declared actions;
 * 2. query within the token's data bounds;
 * 3. policy engine over the principal's CURRENT authority:
 *    observations:read uses the public-then-protected two-step, everything
 *    else its single required capability.
 */
export function authorizeScoped(
  token: ScopedCredential,
  action: TokenAction,
  object: { kind: ObjectKind; id: string },
  query: ScopedQuery,
  world: PolicyWorld,
  now: string,
): ScopedDecision {
  if (!tokenAllowsAction(token.scopes, action)) {
    return scopedDeny(token, action, 'ACTION_NOT_IN_SCOPE', null);
  }
  const cover = scopeCoversQuery(token.scopes, query);
  if (!cover.covered) {
    return scopedDeny(token, action, cover.reason, null);
  }
  const principal: Principal | null = world.principals[token.principalId] ?? null;
  if (!principal) {
    const policy = evaluate({ principal: null, action: 'browse-published', object }, world, now);
    return scopedDeny(token, action, 'OK', { ...policy, effect: 'deny', reason: 'DENY_UNKNOWN_PRINCIPAL' });
  }

  if (action === 'observations:read') {
    // Two-step, exactly grantCheck.readStreamGrant: the public projection
    // first, then the same read as a protected operation.
    const publicDecision = evaluate({ principal, action: 'browse-published', object }, world, now);
    if (publicDecision.effect === 'allow') {
      return { effect: 'allow', policy: publicDecision, scopeReason: 'OK', policyReason: null, tokenId: token.id, principalId: token.principalId, action };
    }
    const protectedDecision = evaluate({ principal, action: 'view-restricted-details', object }, world, now);
    if (protectedDecision.effect === 'allow') {
      return { effect: 'allow', policy: protectedDecision, scopeReason: 'OK', policyReason: null, tokenId: token.id, principalId: token.principalId, action };
    }
    return scopedDeny(token, action, 'OK', protectedDecision);
  }

  const required = ACTION_REQUIREMENTS[action]!;
  const policy = evaluate({ principal, action: required[0]!, object }, world, now);
  if (policy.effect === 'allow') {
    return { effect: 'allow', policy, scopeReason: 'OK', policyReason: null, tokenId: token.id, principalId: token.principalId, action };
  }
  return scopedDeny(token, action, 'OK', policy);
}

/**
 * Can the principal read this stream right now (public projection or an
 * effective protected grant)? Issue-time validation of a token's declared
 * `streams` uses this: you may not pin a token to data your account cannot
 * currently read (SCOPE_EXCEEDS_AUTHORITY at issue time).
 */
export function principalCanReadStream(world: PolicyWorld, principalId: string, streamId: string, now: string): Decision {
  const principal: Principal | null = world.principals[principalId] ?? null;
  const object = { kind: 'datastream' as ObjectKind, id: streamId };
  const publicDecision = evaluate({ principal, action: 'browse-published', object }, world, now);
  if (publicDecision.effect === 'allow') return publicDecision;
  return evaluate({ principal, action: 'view-restricted-details', object }, world, now);
}
