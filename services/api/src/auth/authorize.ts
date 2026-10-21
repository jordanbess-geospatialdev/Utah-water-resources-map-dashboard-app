/**
 * The authorize() boundary: the single server-side gate every endpoint,
 * queued job, download and spatial request must call before touching data.
 *
 * Contract highlights (FR-010):
 * - The actor is derived from the SESSION ONLY. `objectContext` carries
 *   object coordinates, never identity; any body `actorId`/`role`/owner
 *   field a client submits is structurally unread here.
 * - The world snapshot is loaded per call from the authoritative source via
 *   `deps.worldLoader`. There is deliberately no entitlement cache in this
 *   layer: the Decision echoes the authoritative assignmentVersion, and a
 *   cached grant may not outlive a revocation (entitlement schema: "revoked
 *   wins over any cached copy").
 * - Denials raise typed errors the HTTP layer maps per the technical
 *   specification status policy: 401 missing/expired identity, 403
 *   permitted-object-forbidden-operation, 404 to avoid disclosing hidden
 *   object existence. The hidden-object choice is fixed below and MUST be
 *   exercised by the T-03 HTTP suite.
 */
import {
  evaluate,
  type AuthorizationRequest,
  type Capability,
  type Decision,
  type FieldClass,
  type ObjectKind,
  type PolicyWorld,
} from '../../../../packages/policy/src/index.ts';
import type { SessionContext } from './session.ts';

/** Object coordinates for the request. Identity fields are intentionally absent. */
export interface ObjectContext {
  readonly kind: ObjectKind;
  readonly id: string;
  readonly fields?: readonly FieldClass[];
  /** Present only for scope-moving mutations (site transfer): validates BOTH scopes. */
  readonly destinationSystemId?: string | null;
}

export interface AuthorizeDeps {
  /** Loads the AUTHORITATIVE world snapshot; called once per authorization, never cached across calls. */
  worldLoader: () => PolicyWorld;
  /** Injected clock; defaults to the system clock. Tests inject constants. */
  clock?: () => Date;
  /** Policy engine; defaults to @utah-water/policy evaluate. Injectable for tests. */
  policy?: (request: AuthorizationRequest, world: PolicyWorld, now: Date | string) => Decision;
}

/** Base class for denial errors the HTTP layer maps onto the status policy. */
export class PolicyDeniedError extends Error {
  readonly status: 401 | 403 | 404;
  readonly decision: Decision;

  constructor(decision: Decision, status: 401 | 403 | 404, message: string) {
    super(message);
    this.name = 'PolicyDeniedError';
    this.decision = decision;
    this.status = status;
  }
}

/** 401: missing, unknown or expired identity. Never used for an authenticated actor. */
export class AuthenticationRequiredError extends PolicyDeniedError {
  constructor(decision: Decision) {
    super(decision, 401, `authentication required (${decision.reason})`);
    this.name = 'AuthenticationRequiredError';
  }
}

/** 403: the actor is inside the object fence but the operation/field/lifecycle is forbidden. */
export class ForbiddenError extends PolicyDeniedError {
  constructor(decision: Decision) {
    super(decision, 403, `forbidden (${decision.reason})`);
    this.name = 'ForbiddenError';
  }
}

/** 404: the object is hidden from this actor (existence itself must not be disclosed). */
export class HiddenObjectError extends PolicyDeniedError {
  constructor(decision: Decision) {
    super(decision, 404, `not found (${decision.reason})`);
    this.name = 'HiddenObjectError';
  }
}

const IDENTITY_REASONS: ReadonlySet<string> = new Set(['DENY_ANONYMOUS', 'DENY_UNKNOWN_PRINCIPAL', 'DENY_PRINCIPAL_INACTIVE']);

/**
 * Hidden-object policy (fixed and testable):
 * - identity failures -> 401 (no object information leaks);
 * - unknown object id -> always 404;
 * - out-of-scope on a NON-public object -> 404 (restricted/internal rows do
 *   not exist for outsiders), on a public object -> 403 (existence is public
 *   knowledge; the operation is what is refused);
 * - every other denial (capability, field visibility, lifecycle, revoked or
 *   expired grants, deputy expiry) -> 403.
 */
export function denialStatus(decision: Decision, object: { visibility?: string } | undefined): 401 | 403 | 404 {
  if (IDENTITY_REASONS.has(decision.reason)) return 401;
  if (decision.reason === 'DENY_UNKNOWN_OBJECT') return 404;
  if (decision.reason === 'DENY_OUT_OF_SCOPE' && object && object.visibility !== 'public') return 404;
  return 403;
}

export function denialError(decision: Decision, object: { visibility?: string } | undefined): PolicyDeniedError {
  const status = denialStatus(decision, object);
  if (status === 401) return new AuthenticationRequiredError(decision);
  if (status === 404) return new HiddenObjectError(decision);
  return new ForbiddenError(decision);
}

/**
 * Resolve the actor from the session and evaluate the request against the
 * authoritative world. Returns the allow Decision or throws a typed
 * PolicyDeniedError subclass for the HTTP layer to map.
 *
 * Reauthorization rule: every call re-derives identity and reloads the
 * world; queued jobs and downloads call this again at execution/download
 * time (exports must not outlive a revoked permission - "reauthorize on
 * download").
 */
export async function authorize(
  session: SessionContext,
  action: Capability | string,
  objectContext: ObjectContext,
  deps: AuthorizeDeps,
): Promise<Decision> {
  if (!session || typeof session.resolver?.resolve !== 'function') {
    throw new TypeError('authorize: session.resolver is required (SessionContext from session.ts)');
  }
  const principal = session.token ? await session.resolver.resolve(session.token) : null;
  const world = deps.worldLoader();
  const now = deps.clock ? deps.clock() : new Date();
  const request: AuthorizationRequest = {
    principal,
    action: action as Capability,
    object: {
      kind: objectContext.kind,
      id: objectContext.id,
      fields: objectContext.fields,
      destinationSystemId: objectContext.destinationSystemId ?? null,
    },
  };
  const decision = (deps.policy ?? evaluate)(request, world, now);
  if (decision.effect === 'allow') return decision;
  throw denialError(decision, world.objects[objectContext.id]);
}
