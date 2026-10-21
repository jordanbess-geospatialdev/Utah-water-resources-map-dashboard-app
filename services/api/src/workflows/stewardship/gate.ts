/**
 * The shared steward-only authorization gate for the stewardship workflows
 * (WD-014; FR-011..FR-014, FR-017).
 *
 * Every governance mutation in this package (vocabulary create/retire,
 * assignment grant/revoke/delegate, ingestion registration/promotion,
 * connection test) asks THE entitlement engine
 * (@utah-water/policy evaluate) - never a role-label check. The module the
 * gate protects only ever renders verdicts; it decides nothing itself.
 *
 * Status mapping mirrors services/api/src/auth/authorize.ts (the fixed
 * hidden-object policy): identity failures (anonymous, unknown principal,
 * deactivated principal) map to 401, every other denial to 403. Steward
 * console governance objects are internal-visibility, so an out-of-scope
 * actor gets 403 (existence of the console is not hidden from logged-in
 * staff; the operation is what is refused).
 *
 * Purity: no clock reads (the clock is injected), no I/O, no cache. The
 * world snapshot is passed in per call and may be a service-updated
 * immutable derivation, so a revocation performed through assignments.ts is
 * visible to the very next gate evaluation (FR-011 "revocation affects the
 * next authorized request").
 */
import {
  evaluate as engineEvaluate,
  type Capability,
  type Decision,
  type DecisionReason,
  type FieldClass,
  type ObjectKind,
  type PolicyObject,
  type PolicyWorld,
  type Principal,
} from '../../../../../packages/policy/src/index.ts';

/** Injectable evaluator (tests / alternate engines). Defaults to the real engine. */
export type PolicyEvaluator = (request: {
  principal: Principal | null;
  action: Capability | string;
  object: { kind: ObjectKind | string; id: string; fields?: readonly FieldClass[] };
}, world: PolicyWorld, now: Date | string) => Decision;

export interface GateDeps {
  /** Authoritative world snapshot; a service may hand an updated immutable derivation. */
  readonly world: PolicyWorld;
  /** REQUIRED injected clock (no hidden Date.now reads; determinism is tested). */
  readonly clock: () => Date | string;
  /** Policy engine; defaults to @utah-water/policy evaluate. */
  readonly policy?: PolicyEvaluator;
}

export type GateOutcome = { readonly ok: true; readonly decision: Decision } | GateDenial;

export interface GateDenial {
  readonly ok: false;
  /** HTTP status per the authorize.ts status policy: 401 identity, 403 forbidden. */
  readonly status: 401 | 403;
  readonly reason: DecisionReason;
  readonly decision: Decision;
}

const IDENTITY_REASONS: ReadonlySet<string> = new Set(['DENY_ANONYMOUS', 'DENY_UNKNOWN_PRINCIPAL', 'DENY_PRINCIPAL_INACTIVE']);

/**
 * Evaluate a governance action for `principalId` against `objectId`.
 * The actor comes from the world (server-side identity), never a body field.
 */
export function gateAct(
  deps: GateDeps,
  principalId: string | null,
  action: Capability | string,
  object: { kind: ObjectKind | string; id: string; fields?: readonly FieldClass[] },
): GateOutcome {
  const principal = principalId === null ? null : deps.world.principals[principalId] ?? null;
  const now = deps.clock();
  const decision = (deps.policy ?? engineEvaluate)({ principal, action, object }, deps.world, now);
  if (decision.effect === 'allow') return { ok: true, decision };
  const status: 401 | 403 = IDENTITY_REASONS.has(decision.reason) ? 401 : 403;
  return { ok: false, status, reason: decision.reason, decision };
}

/**
 * Derive a world with extra policy objects (vocabulary terms, provider
 * configs, system anchors) without mutating the original. Pure copy;
 * assignments and principals are shared by reference because they are frozen.
 */
export function withExtraObjects(world: PolicyWorld, objects: readonly PolicyObject[]): PolicyWorld {
  const next: Record<string, PolicyObject> = { ...world.objects };
  for (const object of objects) next[object.id] = object;
  return Object.freeze({ ...world, objects: Object.freeze(next) });
}

/** Build an internal-visibility policy object for a governance record. */
export function governanceObject(input: {
  readonly id: string;
  readonly kind: ObjectKind | string;
  readonly status?: string;
  readonly systemId?: string | null;
}): PolicyObject {
  return Object.freeze({
    id: input.id,
    kind: input.kind as ObjectKind,
    systemId: input.systemId ?? null,
    ownerOrganizationId: null,
    stationId: null,
    datasetId: null,
    ownerPrincipalId: null,
    targetObjectId: null,
    visibility: 'internal',
    status: (input.status ?? 'active') as PolicyObject['status'],
    fields: Object.freeze({}),
  });
}

/** Normalize an injected clock reading to an ISO instant string. */
export function instantIso(now: Date | string): string {
  return typeof now === 'string' ? now : new Date(now.getTime()).toISOString();
}
