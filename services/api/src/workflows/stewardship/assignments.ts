/**
 * Steward grant/revoke administration over the entitlement assignment model
 * (WD-014; FR-011).
 *
 * "A steward assigns systems or sites to an engineer or commissioner,
 * delegates a deputy with an expiry, and revokes access; deactivated actors
 * remain identifiable in history and revocation affects the next authorized
 * request."
 *
 * Semantics (aligned 1:1 with @utah-water/policy - the engine stays the
 * authority; this module only produces new authoritative snapshots):
 *
 * - STEWARD-ONLY: every mutation evaluates `manage-assignments` through the
 *   policy engine against the grantee's user object. Non-stewards get 403;
 *   anonymous/unknown/deactivated actors get 401.
 * - REVOCATION AFFECTS THE NEXT REQUEST: each mutation returns a NEW frozen
 *   PolicyWorld (`world` on the result). Evaluating any request against that
 *   snapshot - not a cache - sees the revocation immediately: a revoked
 *   grant denies with DENY_ASSIGNMENT_REVOKED at the very next evaluation.
 * - HALF-OPEN VALIDITY: [effectiveAt, expiresAt) exactly like the engine;
 *   deputy delegations carry the same window on both the grant and the
 *   delegation (the engine treats the delegation window as the
 *   authoritative, tighter bound). Boundary instants are tested against an
 *   injected clock.
 * - DEPUTY DELEGATION: explicit, time-bounded, audited, never statewide
 *   (DEPUTY_DELEGATION_POLICY); a deputy grant without a delegation or with
 *   a statewide scope is structurally invalid in the engine, so this module
 *   refuses to create one.
 * - GRANT-VERSION MONOTONIC COUNTER: every grant/delegation/revoke consumes
 *   the next integer of a single monotonic counter seeded from the world's
 *   assignmentVersion; a revocation stamps the bumped version on the
 *   assignment, so a stale cached grant can never re-authorize.
 * - DEACTIVATED ACTORS STAY IDENTIFIABLE: every audit entry embeds the
 *   grantee's ActorSnapshot at grant time, and resolveActorSnapshot keeps
 *   resolving through the engine after deactivation (history renders,
 *   authorization denies).
 */
import {
  parseEntitlement,
  resolveActor as engineResolveActor,
  type ActorSnapshot,
  type Assignment,
  type Capability,
  type PolicyWorld,
  type RawEntitlement,
  type RoleFamily,
  type ScopeKind,
} from '../../../../../packages/policy/src/index.ts';
import { ROLE_CEILING } from '../../../../../packages/policy/src/index.ts';
import { gateAct, governanceObject, instantIso, withExtraObjects, type GateOutcome, type PolicyEvaluator } from './gate.ts';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const ASSIGNMENT_AUDIT_ACTIONS = ['grant', 'delegate', 'revoke'] as const;
export type AssignmentAuditAction = (typeof ASSIGNMENT_AUDIT_ACTIONS)[number];

export interface AssignmentAuditEvent {
  readonly id: string;
  readonly at: string;
  /** The steward who performed the mutation. */
  readonly actorId: string;
  readonly action: AssignmentAuditAction;
  readonly assignmentId: string;
  readonly granteeId: string;
  readonly grantVersion: number;
  /** Grantee snapshot captured at mutation time: stays resolvable after deactivation (FR-011). */
  readonly granteeSnapshot: ActorSnapshot;
}

export interface GrantInput {
  readonly principalId: string;
  readonly role: RoleFamily | string;
  readonly capabilities: readonly (Capability | string)[];
  readonly scopeType: ScopeKind | string;
  readonly scopeId: string | null;
  readonly effectiveAt?: string;
  readonly expiresAt?: string | null;
}

export interface DelegateDeputyInput {
  readonly principalId: string;
  /** Deputies are never statewide (DEPUTY_DELEGATION_POLICY); system/site scopes only. */
  readonly scopeType: 'system' | 'site' | string;
  readonly scopeId: string;
  readonly effectiveAt: string;
  readonly expiresAt: string;
  /** The commissioner delegating part of their authority; defaults to the acting steward. */
  readonly delegatedBy?: string;
  /** Defaults to the fixture deputy capability set (enter-readings, review-data). */
  readonly capabilities?: readonly (Capability | string)[];
}

export type GrantErrorCode =
  | 'unknown-principal'
  | 'principal-inactive'
  | 'unknown-role'
  | 'capability-above-ceiling'
  | 'bad-scope'
  | 'empty-window'
  | 'deputy-not-statewide'
  | 'deputy-requires-window';

export type RevokeErrorCode = 'unknown-assignment' | 'already-revoked';

export type MutationDenial = { readonly ok: false; readonly denied: GateOutcome & { ok: false } };

export type MutationSuccess = {
  readonly ok: true;
  readonly assignment: Assignment;
  /** NEW authoritative world snapshot: evaluate the NEXT request against this (revocation semantics). */
  readonly world: PolicyWorld;
  readonly audit: AssignmentAuditEvent;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AssignmentServiceDeps {
  readonly world: PolicyWorld;
  /** REQUIRED injected clock (no hidden Date.now reads; boundary instants are tested). */
  readonly clock: () => Date | string;
  readonly policy?: PolicyEvaluator;
  /** Injectable assignment id generator; default is a per-service monotonic counter. */
  readonly idGenerator?: () => string;
}

export interface AssignmentService {
  grant(stewardId: string | null, input: Readonly<GrantInput>): MutationSuccess | { ok: false; errors: readonly GrantErrorCode[] } | MutationDenial;
  delegateDeputy(stewardId: string | null, input: Readonly<DelegateDeputyInput>): MutationSuccess | { ok: false; errors: readonly GrantErrorCode[] } | MutationDenial;
  revoke(stewardId: string | null, assignmentId: string): MutationSuccess | { ok: false; errors: readonly RevokeErrorCode[] } | MutationDenial;
  /** The latest authoritative world snapshot (immutable). */
  currentWorld(): PolicyWorld;
  /** Actor snapshot via the engine: resolvable even after deactivation (audit keeps names). */
  resolveActorSnapshot(principalId: string): ActorSnapshot | null;
  /** The monotonic grant-version counter's current value. */
  grantVersionCounter(): number;
  changeLog(): readonly AssignmentAuditEvent[];
  serialize(): string;
}

function toRaw(assignment: Assignment): RawEntitlement {
  return {
    id: assignment.id,
    principalId: assignment.principalId,
    role: assignment.role,
    capabilities: [...assignment.capabilities],
    scopeType: assignment.scope.kind,
    scopeId: assignment.scope.id,
    effectiveAt: assignment.effectiveAt,
    expiresAt: assignment.expiresAt,
    status: assignment.status,
    delegation: assignment.delegation
      ? { effectiveAt: assignment.delegation.effectiveAt, expiresAt: assignment.delegation.expiresAt, delegatedBy: assignment.delegation.delegatedBy }
      : null,
    grantedBy: assignment.grantedBy,
    grantVersion: assignment.grantVersion,
  };
}

const VALID_ROLES: readonly string[] = ['public', 'water-user', 'owner', 'researcher', 'commissioner', 'deputy', 'engineer', 'steward'];
const VALID_SCOPES: readonly string[] = ['site', 'system', 'organization', 'statewide', 'dataset'];
/** Fixture-aligned default deputy capability set (principals.json ent-deputy-ana). */
export const DEFAULT_DEPUTY_CAPABILITIES: readonly string[] = ['enter-readings', 'review-data'];

export function createAssignmentService(deps: AssignmentServiceDeps): AssignmentService {
  const clock = deps.clock;
  const policy = deps.policy;
  let raws: RawEntitlement[] = deps.world.assignments.map(toRaw);
  let counter = raws.reduce((max, raw) => Math.max(max, raw.grantVersion), 0);
  let auditCounter = 0;
  const audit: AssignmentAuditEvent[] = [];

  const nextVersion = (): number => {
    counter += 1;
    return counter;
  };
  const nextId = deps.idGenerator ?? (() => `asg-${String(counter + 1).padStart(6, '0')}`);
  const nextAuditId = (): string => `ae-${String((auditCounter += 1)).padStart(6, '0')}`;

  /** Rebuild the authoritative immutable snapshot from the current grants. */
  const rebuildWorld = (): PolicyWorld => {
    const assignments = Object.freeze(raws.map((raw) => parseEntitlement(raw)));
    const assignmentVersion = raws.reduce((max, raw) => Math.max(max, raw.grantVersion), 0);
    return Object.freeze({ ...deps.world, assignments, assignmentVersion });
  };

  /** manage-assignments gate against the grantee's user object. */
  const gate = (stewardId: string | null, granteeId: string): GateOutcome => {
    const userObject = deps.world.objects[granteeId] ?? governanceObject({ id: granteeId, kind: 'user' });
    return gateAct(
      { world: withExtraObjects(rebuildWorld(), [userObject]), clock, policy },
      stewardId,
      'manage-assignments',
      { kind: 'user', id: granteeId },
    );
  };

  const deny = (outcome: GateOutcome & { ok: false }): MutationDenial => ({ ok: false, denied: outcome });

  const validateGrantee = (principalId: string): GrantErrorCode[] => {
    const principal = deps.world.principals[principalId];
    if (!principal) return ['unknown-principal'];
    if (!principal.active) return ['principal-inactive'];
    return [];
  };

  const append = (
    stewardId: string | null,
    action: AssignmentAuditAction,
    raw: RawEntitlement,
    granteeSnapshot: ActorSnapshot,
  ): MutationSuccess => {
    raws = [...raws, raw];
    const world = rebuildWorld();
    const event: AssignmentAuditEvent = Object.freeze({
      id: nextAuditId(),
      at: instantIso(clock()),
      actorId: stewardId ?? '',
      action,
      assignmentId: raw.id,
      granteeId: raw.principalId,
      grantVersion: raw.grantVersion,
      granteeSnapshot: Object.freeze({ ...granteeSnapshot }),
    });
    audit.push(event);
    return { ok: true, assignment: parseEntitlement(raw), world, audit: event };
  };

  return {
    grant(stewardId, input) {
      const verdict = gate(stewardId, input.principalId);
      if (!verdict.ok) return deny(verdict);

      const errors: GrantErrorCode[] = [...validateGrantee(input.principalId)];
      const role = input.role as string;
      if (!VALID_ROLES.includes(role)) errors.push('unknown-role');
      const scopeType = input.scopeType as string;
      if (!VALID_SCOPES.includes(scopeType)) errors.push('bad-scope');
      else if (scopeType === 'statewide' && input.scopeId !== null) errors.push('bad-scope');
      else if (scopeType !== 'statewide' && (typeof input.scopeId !== 'string' || input.scopeId.length === 0)) errors.push('bad-scope');
      if (VALID_ROLES.includes(role)) {
        const ceiling = new Set<string>(ROLE_CEILING[role as RoleFamily]);
        if (input.capabilities.some((capability) => !ceiling.has(capability as string))) errors.push('capability-above-ceiling');
      }
      const effectiveAt = input.effectiveAt ?? instantIso(clock());
      const expiresAt = input.expiresAt ?? null;
      if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(effectiveAt)) errors.push('empty-window');
      if (errors.length > 0) return { ok: false, errors };

      const grantVersion = nextVersion();
      return append(stewardId, 'grant', {
        id: nextId(),        principalId: input.principalId,
        role,
        capabilities: [...input.capabilities] as string[],
        scopeType,
        scopeId: input.scopeId,
        effectiveAt,
        expiresAt,
        status: 'active',
        delegation: null,
        grantedBy: stewardId ?? '',
        grantVersion,
      }, deps.world.principals[input.principalId]!);
    },

    delegateDeputy(stewardId, input) {
      const verdict = gate(stewardId, input.principalId);
      if (!verdict.ok) return deny(verdict);

      const errors: GrantErrorCode[] = [...validateGrantee(input.principalId)];
      const scopeType = input.scopeType as string;
      if (scopeType === 'statewide' || !(scopeType === 'system' || scopeType === 'site')) errors.push('deputy-not-statewide');
      if (typeof input.scopeId !== 'string' || input.scopeId.length === 0) errors.push('bad-scope');
      if (!input.effectiveAt || !input.expiresAt) errors.push('deputy-requires-window');
      else if (Date.parse(input.expiresAt) <= Date.parse(input.effectiveAt)) errors.push('empty-window');
      const capabilities = (input.capabilities ?? DEFAULT_DEPUTY_CAPABILITIES) as readonly string[];
      const deputyCeiling = new Set<string>(ROLE_CEILING.deputy);
      if (capabilities.some((capability) => !deputyCeiling.has(capability))) errors.push('capability-above-ceiling');
      if (errors.length > 0) return { ok: false, errors };

      const grantVersion = nextVersion();
      const delegation = { effectiveAt: input.effectiveAt, expiresAt: input.expiresAt, delegatedBy: input.delegatedBy ?? stewardId ?? '' };
      return append(stewardId, 'delegate', {
        id: nextId(),
        principalId: input.principalId,
        role: 'deputy',
        capabilities: [...capabilities],
        scopeType,
        scopeId: input.scopeId,
        effectiveAt: input.effectiveAt,
        expiresAt: input.expiresAt,
        status: 'active',
        delegation,
        grantedBy: stewardId ?? '',
        grantVersion,
      }, deps.world.principals[input.principalId]!);
    },

    revoke(stewardId, assignmentId) {
      const index = raws.findIndex((raw) => raw.id === assignmentId);
      const target = index >= 0 ? raws[index]! : null;
      if (target) {
        const verdict = gate(stewardId, target.principalId);
        if (!verdict.ok) return deny(verdict);
      } else {
        // Unknown assignment: still gate against the root governance surface
        // so a non-steward cannot probe assignment ids.
        const verdict = gateAct(
          { world: withExtraObjects(deps.world, [governanceObject({ id: 'assignments:root', kind: 'user' })]), clock, policy },
          stewardId,
          'manage-assignments',
          { kind: 'user', id: 'assignments:root' },
        );
        if (!verdict.ok) return deny(verdict);
        return { ok: false, errors: ['unknown-assignment'] };
      }
      if (target!.status === 'revoked') return { ok: false, errors: ['already-revoked'] };

      const grantVersion = nextVersion();
      const revoked: RawEntitlement = { ...target!, status: 'revoked', grantVersion };
      raws = [...raws];
      raws[index!] = revoked;
      const world = rebuildWorld();
      const event: AssignmentAuditEvent = Object.freeze({
        id: nextAuditId(),
        at: instantIso(clock()),
        actorId: stewardId ?? '',
        action: 'revoke',
        assignmentId: revoked.id,
        granteeId: revoked.principalId,
        grantVersion,
        granteeSnapshot: Object.freeze({ ...(deps.world.principals[revoked.principalId] ?? engineResolveActor(deps.world, revoked.principalId)!) }),
      });
      audit.push(event);
      return { ok: true, assignment: parseEntitlement(revoked), world, audit: event };
    },

    currentWorld() {
      return rebuildWorld();
    },

    resolveActorSnapshot(principalId) {
      return engineResolveActor(rebuildWorld(), principalId);
    },

    grantVersionCounter() {
      return counter;
    },

    changeLog() {
      return [...audit];
    },

    serialize() {
      return JSON.stringify({ grantVersionCounter: counter, assignments: raws, audit }, null, 0);
    },
  };
}
