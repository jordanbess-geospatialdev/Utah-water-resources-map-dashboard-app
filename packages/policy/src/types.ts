/**
 * Type vocabulary for the @utah-water/policy entitlement engine.
 *
 * Source of truth: docs/product/baseline/02-technical-specification.md,
 * section "Identity and application permissions" (evaluation rules and the
 * proposed authorization matrix) and docs/product/baseline/01-product-requirements.md
 * ("Personas and proposed permissions"). Requirement anchors: FR-010
 * (server enforcement of scoped capabilities), FR-011 (user lifecycle and
 * scoped assignments), FR-019 (assigned operations workspace), FR-031
 * (engineer site setup), FR-049 (categorized attachments / field visibility),
 * FR-064 (research credential lifecycle).
 *
 * The engine is a pure function: (request, world, now) -> Decision. No I/O,
 * no clock reads, no cache. Callers inject the authoritative world snapshot
 * and the clock; see engine.ts for the evaluation order.
 */

/** Semantic version of the policy vocabulary and evaluation rules. Bumped on any observable behavior change. */
// 0.1.1 (WD-004 / DEFECT-Q3): statewide-administration satisfies field-visits
// only for the steward persona family (SATISFACTION_ROLE_GATES).
export const POLICY_VERSION = '0.1.1';

/** Role families from the entitlement schema (packages/contracts/schemas/entitlement.json). */
export type RoleFamily =
  | 'public'
  | 'water-user'
  | 'owner'
  | 'researcher'
  | 'commissioner'
  | 'deputy'
  | 'engineer'
  | 'steward';

/**
 * Engineer capability profiles are subsets of the engineer family, never extra
 * authority: field, automation, regional and modeler (technical specification,
 * authorization matrix notes). Profiles are data in matrix.ts.
 */
export type EngineerProfile = 'field' | 'automation' | 'regional' | 'modeler';

/**
 * Action verbs. Names follow the authorization matrix rows and the capability
 * strings already used by fixtures/contracts/principals.json and
 * schemas/entitlement.json so grants load without translation.
 */
export type Capability =
  // Matrix row verbs
  | 'browse-published'
  | 'manage-own-preferences'
  | 'view-restricted-details'
  | 'enter-readings'
  | 'revise-best-available'
  | 'edit-site-metadata'
  | 'edit-permitted-site-fields'
  | 'create-sites'
  | 'review-data'
  | 'manage-vocabulary'
  | 'manage-users'
  | 'manage-assignments'
  | 'configure-ingestion'
  | 'request-ingestion-configuration'
  | 'withdraw-raw'
  | 'manage-own-tokens'
  | 'supplier-reporting'
  // Operational verbs carried by fixture grants
  | 'field-visits'
  | 'view-internal-diagnostics'
  | 'read-approved-datasets'
  | 'create-exports'
  | 'generate-reports'
  | 'statewide-administration';

/** Machine-readable outcome explanations. Stable API: HTTP layers map these to status codes and logs. */
export type DecisionReason =
  | 'ALLOW_PUBLIC_READ'
  | 'ALLOW_PROTECTED'
  | 'DENY_INVALID_REQUEST'
  | 'DENY_UNKNOWN_OBJECT'
  | 'DENY_NO_PUBLIC_ACTION'
  | 'DENY_OBJECT_UNPUBLISHED'
  | 'DENY_FIELDS_NOT_PUBLIC'
  | 'DENY_ANONYMOUS'
  | 'DENY_UNKNOWN_PRINCIPAL'
  | 'DENY_PRINCIPAL_INACTIVE'
  | 'DENY_ASSIGNMENT_REVOKED'
  | 'DENY_ASSIGNMENT_NOT_EFFECTIVE'
  | 'DENY_ASSIGNMENT_EXPIRED'
  | 'DENY_DELEGATION_NOT_EFFECTIVE'
  | 'DENY_DELEGATION_EXPIRED'
  | 'DENY_INVALID_ASSIGNMENT'
  | 'DENY_CAPABILITY_NOT_GRANTED'
  | 'DENY_OUT_OF_SCOPE'
  | 'DENY_FIELD_VISIBILITY'
  | 'DENY_LIFECYCLE_STATE';

/** Field visibility classes (technical specification: "field_visibility_allows_requested_fields"; FR-049). */
export type FieldClass = 'public' | 'restricted' | 'internal';

/** Lifecycle states used by the "lifecycle_allows_requested_change" clause. */
export type LifecycleState = 'proposed' | 'active' | 'inactive' | 'retired' | 'finalized';

/** Object kinds the engine can authorize. Kinds without a fixture file are supplied as extra world objects. */
export type ObjectKind =
  | 'station'
  | 'datastream'
  | 'observation'
  | 'system'
  | 'organization'
  | 'dataset'
  | 'vocabulary'
  | 'user'
  | 'provider'
  | 'preference'
  | 'token'
  | 'export'
  | 'visit'
  | 'attachment'
  | 'report';

/** Assignment scope kinds (entitlement schema scopeType values). */
export type ScopeKind = 'site' | 'system' | 'organization' | 'statewide' | 'dataset';

/** A scope object: statewide carries no id; every other kind requires one. */
export interface Scope {
  readonly kind: ScopeKind;
  readonly id: string | null;
}

/**
 * A person (or service identity) that can hold assignments. `id` is the
 * immutable institutional subject; `active: false` is offboarding - the record
 * stays resolvable for audit while every decision denies (FR-011).
 */
export interface Principal {
  readonly id: string;
  readonly displayName: string;
  readonly roles: readonly RoleFamily[];
  readonly active: boolean;
  /** Convenience mirror of a single-system assignment on fixture principals. */
  readonly assignedSystemId?: string | null;
  readonly description?: string;
}

/** Audit-safe actor snapshot: identical to Principal; returned even after deactivation. */
export type ActorSnapshot = Principal;

/**
 * An entitlement grant (entitlement.json). Authority comes from
 * `capabilities` + `scope` + the validity window, never from the role label
 * alone. `grantVersion` is the monotonic assignment version a protected
 * request must be checked against (stale caches cannot authorize).
 */
export interface Assignment {
  readonly id: string;
  readonly principalId: string;
  readonly role: RoleFamily;
  readonly capabilities: readonly Capability[];
  readonly scope: Scope;
  /** UTC instants. Validity is half-open: [effectiveAt, expiresAt). Null expiry = no scheduled end. */
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
  readonly status: 'active' | 'revoked';
  /**
   * Present exactly for deputy grants: an explicit, time-bounded delegation.
   * The engine treats a deputy grant without delegation, or a statewide
   * deputy grant, as structurally invalid (never statewide by default).
   */
  readonly delegation: Delegation | null;
  readonly grantedBy: string;
  readonly grantVersion: number;
}

export interface Delegation {
  readonly effectiveAt: string;
  readonly expiresAt: string;
  readonly delegatedBy: string;
}

/** The object being acted on, as resolved inside the policy world. */
export interface PolicyObject {
  readonly id: string;
  readonly kind: ObjectKind;
  /** Scope anchors resolved server-side (FR-010: membership is never taken from the request body). */
  readonly systemId?: string | null;
  readonly ownerOrganizationId?: string | null;
  readonly stationId?: string | null;
  readonly datasetId?: string | null;
  /** For own-account objects (preferences, tokens): the only principal that may act on them. */
  readonly ownerPrincipalId?: string | null;
  /** For preferences: the object the favorite/alert points at; favoriting requires reading the target. */
  readonly targetObjectId?: string | null;
  readonly visibility: 'public' | 'restricted' | 'internal';
  readonly status: LifecycleState;
  /** Per-field visibility for objects that carry protected blocks (gate codes, wiring notes - FR-049). */
  readonly fields?: Readonly<Record<string, FieldClass>>;
}

/**
 * The authorization question. Field visibility defaults to the public
 * projection; lifecycle state lives on the object, not the request. The
 * request never carries an actor: identity comes from the session only.
 */
export interface AuthorizationRequest {
  readonly principal: Principal | null;
  readonly action: Capability;
  readonly object: {
    readonly kind: ObjectKind;
    readonly id: string;
    /** Field classes the caller is asking to read or write. */
    readonly fields?: readonly FieldClass[];
    /**
     * Set when a mutation would move an object (site) to a different system:
     * both the current and the destination scope must validate.
     */
    readonly destinationSystemId?: string | null;
  };
}

/** The verdict. Reasons are machine-readable; `via` records which branch of `allow = allow_public_read OR allow_protected` fired. */
export interface Decision {
  readonly effect: 'allow' | 'deny';
  readonly reason: DecisionReason;
  readonly via: 'public-read' | 'protected' | null;
  readonly actorId: string | null;
  readonly policyVersion: string;
  /** ISO instant taken from the injected clock (never read internally). */
  readonly evaluatedAt: string;
  /** Assignments that satisfied capability+scope+fields (audit trail). */
  readonly matchedAssignmentIds: readonly string[];
  /** Authoritative assignment version of the world snapshot used (>= any cached copy a caller may hold). */
  readonly assignmentVersion: number;
  readonly detail?: string;
}

/** The authoritative snapshot the engine evaluates against. Built by loadWorld/buildWorld from fixtures. */
export interface PolicyWorld {
  readonly seed: string;
  readonly principals: Readonly<Record<string, Principal>>;
  readonly assignments: readonly Assignment[];
  readonly objects: Readonly<Record<string, PolicyObject>>;
  /** Max grantVersion across all assignments; per-principal value via assignmentVersionOf(). */
  readonly assignmentVersion: number;
}

/** Shape of fixtures/contracts/principals.json (parsed). */
export interface PrincipalsFixture {
  seed: string;
  organizations?: ReadonlyArray<{
    id: string;
    name: string;
    kind: string;
    description?: string;
  }>;
  users: ReadonlyArray<{
    id: string;
    displayName: string;
    roles: readonly string[];
    active: boolean;
    assignedSystemId?: string | null;
    description?: string;
  }>;
  entitlements: ReadonlyArray<RawEntitlement>;
}

/** Entitlement as stored in fixtures/contracts (scopeType/scopeId naming from schemas/entitlement.json). */
export interface RawEntitlement {
  id: string;
  principalId: string;
  role: string;
  capabilities?: readonly string[];
  scopeType: string;
  scopeId: string | null;
  effectiveAt: string;
  expiresAt: string | null;
  status: string;
  delegation?: {
    effectiveAt: string;
    expiresAt: string;
    delegatedBy: string;
  } | null;
  grantedBy: string;
  grantVersion: number;
}

/** Shape of fixtures/contracts/stations.json (parsed; only fields the engine needs). */
export interface StationsFixture {
  seed: string;
  stations: ReadonlyArray<{
    id: string;
    systemId: string;
    status: string;
    visibility: string;
    ownerOrganizationId?: string | null;
    internal?: { visibility?: string } | null;
    datastreams?: ReadonlyArray<{
      id: string;
      stationId: string;
      visibility: string;
    }>;
  }>;
}
