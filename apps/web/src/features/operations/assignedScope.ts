/**
 * Assigned-scope derivation for the FR-019 operations workspace.
 *
 * "The manage tab lists only currently assigned systems and sites; a separate
 * public explorer remains available; changing a requested system ID cannot
 * reveal another system's private operational records."
 *
 * The derivation is POLICY-ENGINE-DRIVEN and nothing else: every row
 * admission, every field-class read (gate codes, wiring notes, internal
 * diagnostic streams) and every public-browse row is the verdict of an
 * injected entitlement evaluator evaluated against an authoritative world
 * snapshot at an injected clock. This module contains NO authorization logic
 * of its own - revocation, expiry, deputy delegation windows, engineer
 * capability variants and scope resolution all live in the evaluator
 * (@utah-water/policy in packages/policy/src, mirrored for the demo by
 * ./fixturePolicy.ts and cross-checked against the real engine in
 * siteWorkspace.test.ts).
 *
 * Why the engine is injected instead of imported: apps/web/tsconfig.json
 * (orchestrator-owned, outside this task's write scope) does not enable
 * allowImportingTsExtensions, so the policy package sources cannot enter the
 * web tsc program. The structural types below mirror the engine's public
 * surface (packages/policy/src/types.ts); the real `buildWorld()` output and
 * `evaluate()` satisfy them structurally and are injected by tests and,
 * later, by the one shell wiring line documented in README.md.
 *
 * Pure module: no React, no DOM, no clock reads, no storage. `now` is always
 * an argument; identical inputs produce identical outputs (order is derived
 * from sorted identifiers, never object insertion order).
 */

// ---------------------------------------------------------------------------
// Structural mirror of the @utah-water/policy public surface (injectable port)
// ---------------------------------------------------------------------------

/** Field visibility classes (technical specification, FR-049). */
export type PolicyFieldClass = 'public' | 'restricted' | 'internal';

/** Assignment scope kinds (entitlement schema scopeType values). */
export type PolicyScopeKind = 'site' | 'system' | 'organization' | 'statewide' | 'dataset';

export interface PolicyScopeMirror {
  readonly kind: PolicyScopeKind;
  readonly id: string | null;
}

/** A deputy's explicit, time-bounded delegation (never statewide by default). */
export interface PolicyDelegationMirror {
  readonly effectiveAt: string;
  readonly expiresAt: string;
  readonly delegatedBy: string;
}

export interface PolicyPrincipalMirror {
  readonly id: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly roles: readonly string[];
  readonly assignedSystemId?: string | null;
}

export interface PolicyAssignmentMirror {
  readonly id: string;
  readonly principalId: string;
  readonly role: string;
  readonly capabilities: readonly string[];
  readonly scope: PolicyScopeMirror;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
  readonly status: 'active' | 'revoked';
  readonly delegation: PolicyDelegationMirror | null;
  readonly grantVersion: number;
}

export interface PolicyObjectMirror {
  readonly id: string;
  readonly kind: string;
  readonly systemId?: string | null;
  readonly ownerOrganizationId?: string | null;
  readonly stationId?: string | null;
  readonly datasetId?: string | null;
  readonly visibility: PolicyFieldClass;
  readonly status: string;
  readonly fields?: Readonly<Record<string, PolicyFieldClass>>;
}

/** The authoritative snapshot the evaluator sees. */
export interface PolicyWorldMirror {
  readonly principals: Readonly<Record<string, PolicyPrincipalMirror>>;
  readonly assignments: readonly PolicyAssignmentMirror[];
  readonly objects: Readonly<Record<string, PolicyObjectMirror>>;
  readonly assignmentVersion: number;
}

export interface PolicyRequestMirror {
  readonly principal: PolicyPrincipalMirror | null;
  readonly action: string;
  readonly object: {
    readonly kind: string;
    readonly id: string;
    readonly fields?: readonly PolicyFieldClass[];
  };
}

export interface PolicyDecisionMirror {
  readonly effect: 'allow' | 'deny';
  readonly reason: string;
  readonly via: 'public-read' | 'protected' | null;
  readonly assignmentVersion: number;
  readonly matchedAssignmentIds: readonly string[];
  readonly detail?: string;
}

/**
 * The evaluator port. The real engine's `evaluate` (packages/policy/src) has
 * exactly this shape; tests inject it and assert this module's rows against
 * its verdicts persona by persona.
 */
export type PolicyEvaluator = (request: PolicyRequestMirror, world: PolicyWorldMirror, now: Date | string) => PolicyDecisionMirror;

/** Bundle the port needs: an evaluator plus the world it evaluates against. */
export interface PolicyPort {
  readonly evaluate: PolicyEvaluator;
  readonly world: PolicyWorldMirror;
}

// ---------------------------------------------------------------------------
// Derivation input / output
// ---------------------------------------------------------------------------

export interface AssignedScopeInput {
  /**
   * Acting principal id from the session (FR-010: identity is never taken
   * from a request body; there is deliberately NO systemId input to "request"
   * a system - scope comes from grants alone).
   */
  readonly principalId: string | null;
  readonly world: PolicyWorldMirror;
  readonly policy: PolicyEvaluator;
  readonly now: Date | string;
}

/** The entitlement verdict for one datastream of an admitted site row. */
export interface AssignedStreamVerdict {
  readonly streamId: string;
  /** Field class the stream's own visibility asserts. */
  readonly fieldClass: PolicyFieldClass;
  readonly allowed: boolean;
  readonly reason: string;
  /** True for internal-class streams (voltage and similar diagnostics, FR-036). */
  readonly diagnostic: boolean;
}

/** One admitted operational site row: the site is within a current assignment. */
export interface AssignedSiteRow {
  readonly stationId: string;
  readonly systemId: string;
  readonly visibility: PolicyFieldClass;
  readonly status: string;
  /** The engine decision that admitted the row (audit: matched assignments). */
  readonly admittedBy: PolicyDecisionMirror;
  /** Internal-class station fields (gate codes, wiring notes) readable? FR-049. */
  readonly internalBlockReadable: boolean;
  /** Every datastream verdict of the station, including denied ones. */
  readonly streams: readonly AssignedStreamVerdict[];
  /** Internal-class streams the evaluator allows (the diagnostics section, FR-036). */
  readonly diagnosticsStreamIds: readonly string[];
}

export interface AssignedSystemGroup {
  readonly systemId: string;
  readonly siteRows: readonly AssignedSiteRow[];
}

/**
 * Why the assigned tab is empty. Derived from the engine's own denial
 * reasons (collected across every station evaluation), never from local
 * grant arithmetic, so the notice the workspace shows cannot disagree with
 * the verdicts that produced it.
 */
export type AssignedEmptyReason =
  | 'anonymous'
  | 'unknown-principal'
  | 'principal-inactive'
  | 'delegation-not-effective'
  | 'delegation-expired'
  | 'assignment-revoked'
  | 'assignment-expired'
  | 'assignment-not-effective'
  | 'no-operational-capability'
  | 'no-sites-in-scope';

export interface AssignedDelegationNotice {
  readonly effectiveAt: string;
  readonly expiresAt: string;
  readonly delegatedBy: string;
}

export interface AssignedScope {
  readonly principalId: string | null;
  readonly displayName: string | null;
  readonly active: boolean;
  readonly systems: readonly AssignedSystemGroup[];
  readonly siteRows: readonly AssignedSiteRow[];
  /** True when any admitted row carries an internal-class read (FR-036). */
  readonly diagnosticsCapable: boolean;
  readonly emptyReason: AssignedEmptyReason | null;
  /** Deputy delegation window when the principal carries one (UI notice only). */
  readonly delegation: AssignedDelegationNotice | null;
  /** Authoritative world assignment version the rows were derived against. */
  readonly assignmentVersion: number;
  /** Evaluated-at instant taken from the injected clock. */
  readonly evaluatedAt: string;
}

/** One public-browse row (FR-019 separate public explorer; strict public projection). */
export interface PublicBrowseRow {
  readonly stationId: string;
  readonly systemId: string;
  readonly status: string;
  /** The engine decision that published the row (always via 'public-read'). */
  readonly publishedBy: PolicyDecisionMirror;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATION_KIND = 'station';
const DATASTREAM_KIND = 'datastream';
const ORGANIZATION_KIND = 'organization';

function toInstant(now: Date | string): number {
  return typeof now === 'string' ? Date.parse(now) : now.getTime();
}

function fieldClassOfVisibility(visibility: PolicyFieldClass): PolicyFieldClass {
  return visibility;
}

function requestFor(
  principal: PolicyPrincipalMirror | null,
  action: string,
  object: PolicyObjectMirror,
  fields: readonly PolicyFieldClass[],
): PolicyRequestMirror {
  return { principal, action, object: { kind: object.kind, id: object.id, fields } };
}

interface WorldIndex {
  readonly stations: PolicyObjectMirror[];
  readonly streamsByStation: Readonly<Map<string, PolicyObjectMirror[]>>;
}

function indexWorld(world: PolicyWorldMirror): WorldIndex {
  const stations: PolicyObjectMirror[] = [];
  const streamsByStation = new Map<string, PolicyObjectMirror[]>();
  for (const id of Object.keys(world.objects).sort()) {
    const object = world.objects[id]!;
    if (object.kind === STATION_KIND) stations.push(object);
    else if (object.kind === DATASTREAM_KIND && object.stationId) {
      const bucket = streamsByStation.get(object.stationId) ?? [];
      bucket.push(object);
      streamsByStation.set(object.stationId, bucket);
    }
  }
  for (const bucket of streamsByStation.values()) bucket.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { stations, streamsByStation };
}

const EMPTY_REASON_PRIORITY: readonly [string, AssignedEmptyReason][] = [
  ['DENY_DELEGATION_NOT_EFFECTIVE', 'delegation-not-effective'],
  ['DENY_DELEGATION_EXPIRED', 'delegation-expired'],
  ['DENY_ASSIGNMENT_REVOKED', 'assignment-revoked'],
  ['DENY_ASSIGNMENT_EXPIRED', 'assignment-expired'],
  ['DENY_ASSIGNMENT_NOT_EFFECTIVE', 'assignment-not-effective'],
  ['DENY_CAPABILITY_NOT_GRANTED', 'no-operational-capability'],
];

function emptyReasonFromDenials(reasons: readonly string[]): AssignedEmptyReason {
  const set = new Set(reasons);
  for (const [reason, mapped] of EMPTY_REASON_PRIORITY) {
    if (set.has(reason)) return mapped;
  }
  // Every station denied purely by scope: grants are effective but nothing
  // they cover exists in the world (or the world has no stations at all).
  return 'no-sites-in-scope';
}

// ---------------------------------------------------------------------------
// Core derivation
// ---------------------------------------------------------------------------

/**
 * Derive the assigned operations workspace. For every station object in the
 * world the engine decides, at `now`:
 *
 *  1. row admission   - action `view-restricted-details` over restricted
 *     fields: satisfied by any operational capability scoped over the
 *     station (enter-readings, review-data, field-visits, ...). Revoked,
 *     expired, not-yet-effective and out-of-window deputy grants deny and
 *     the row is absent - immediately, at grant-version change.
 *  2. internal fields - the same action over internal-class fields; only
 *     internal-field read capabilities (view-internal-diagnostics, ...)
 *     in scope satisfy it (FR-049: row visibility alone is not sufficient).
 *  3. per-stream      - the same action at each datastream's own visibility
 *     class; internal streams (voltage) are the diagnostics section (FR-036)
 *     and never become public because the station is public.
 */
export function deriveAssignedScope(input: AssignedScopeInput): AssignedScope {
  const { principalId, world, policy } = input;
  const nowMs = toInstant(input.now);
  const evaluatedAt = new Date(nowMs).toISOString();
  const index = indexWorld(world);

  const principal = principalId !== null ? (world.principals[principalId] ?? null) : null;
  if (principal === null) {
    return {
      principalId,
      displayName: null,
      active: false,
      systems: [],
      siteRows: [],
      diagnosticsCapable: false,
      emptyReason: principalId === null ? 'anonymous' : 'unknown-principal',
      delegation: null,
      assignmentVersion: world.assignmentVersion,
      evaluatedAt,
    };
  }

  const delegationAssignment = world.assignments
    .filter((assignment) => assignment.principalId === principalId && assignment.delegation !== null)
    .sort((a, b) => (a.delegation!.effectiveAt < b.delegation!.effectiveAt ? -1 : 1))[0];
  const delegation: AssignedDelegationNotice | null =
    delegationAssignment && delegationAssignment.delegation
      ? {
          effectiveAt: delegationAssignment.delegation.effectiveAt,
          expiresAt: delegationAssignment.delegation.expiresAt,
          delegatedBy: delegationAssignment.delegation.delegatedBy,
        }
      : null;

  if (!principal.active) {
    return {
      principalId,
      displayName: principal.displayName,
      active: false,
      systems: [],
      siteRows: [],
      diagnosticsCapable: false,
      emptyReason: 'principal-inactive',
      delegation,
      assignmentVersion: world.assignmentVersion,
      evaluatedAt,
    };
  }

  const denialReasons: string[] = [];
  const rowsBySystem = new Map<string, AssignedSiteRow[]>();
  let diagnosticsCapable = false;

  for (const station of index.stations) {
    const admission = policy(requestFor(principal, 'view-restricted-details', station, ['restricted']), world, input.now);
    if (admission.effect !== 'allow') {
      denialReasons.push(admission.reason);
      continue;
    }

    const internalRead = policy(requestFor(principal, 'view-restricted-details', station, ['internal']), world, input.now);
    if (internalRead.effect === 'allow') diagnosticsCapable = true;

    const streams: AssignedStreamVerdict[] = [];
    const diagnosticsStreamIds: string[] = [];
    for (const stream of index.streamsByStation.get(station.id) ?? []) {
      const fieldClass = fieldClassOfVisibility(stream.visibility);
      const verdict = policy(requestFor(principal, 'view-restricted-details', stream, [fieldClass]), world, input.now);
      const diagnostic = fieldClass === 'internal';
      if (verdict.effect === 'allow' && diagnostic) {
        diagnosticsStreamIds.push(stream.id);
        diagnosticsCapable = true;
      }
      streams.push({ streamId: stream.id, fieldClass, allowed: verdict.effect === 'allow', reason: verdict.reason, diagnostic });
    }

    const row: AssignedSiteRow = {
      stationId: station.id,
      systemId: station.systemId ?? '',
      visibility: station.visibility,
      status: station.status,
      admittedBy: admission,
      internalBlockReadable: internalRead.effect === 'allow',
      streams,
      diagnosticsStreamIds,
    };
    const bucket = rowsBySystem.get(row.systemId) ?? [];
    bucket.push(row);
    rowsBySystem.set(row.systemId, bucket);
  }

  const systems: AssignedSystemGroup[] = [...rowsBySystem.keys()]
    .sort()
    .map((systemId) => ({ systemId, siteRows: rowsBySystem.get(systemId)! }));
  const siteRows = systems.flatMap((group) => group.siteRows);

  return {
    principalId,
    displayName: principal.displayName,
    active: true,
    systems,
    siteRows,
    diagnosticsCapable,
    emptyReason: siteRows.length > 0 ? null : emptyReasonFromDenials(denialReasons),
    delegation,
    assignmentVersion: world.assignmentVersion,
    evaluatedAt,
  };
}

/**
 * The public browse tab (FR-019: the separate public explorer). Strictly the
 * public projection: a station row exists exactly when the engine's
 * allow_public_read branch fires (`browse-published`, public fields) - the
 * viewer's grants are irrelevant here and an anonymous principal browses the
 * same rows. Internal blocks and restricted/internal streams never enter
 * this list (they are not part of the public projection at all).
 */
export function publicBrowseRows(world: PolicyWorldMirror, policy: PolicyEvaluator, now: Date | string): readonly PublicBrowseRow[] {
  const index = indexWorld(world);
  const anonymous: PolicyPrincipalMirror | null = null;
  const rows: PublicBrowseRow[] = [];
  for (const station of index.stations) {
    const decision = policy(requestFor(anonymous, 'browse-published', station, ['public']), world, now);
    if (decision.effect !== 'allow') continue;
    rows.push({ stationId: station.id, systemId: station.systemId ?? '', status: station.status, publishedBy: decision });
  }
  return rows;
}

/**
 * Readability check shared with the favorites feature (FR-052: "Add favorite
 * only if published or otherwise readable"): the public projection, or any
 * protected read the engine allows at the object's own visibility class.
 * Deliberately the same shallow rule the engine's preference branch applies;
 * it grants nothing beyond reading.
 */
export function isReadableForPrincipal(
  principalId: string | null,
  objectId: string,
  world: PolicyWorldMirror,
  policy: PolicyEvaluator,
  now: Date | string,
): { readable: boolean; reason: string } {
  const object = world.objects[objectId];
  if (!object || object.kind === ORGANIZATION_KIND) return { readable: false, reason: 'DENY_UNKNOWN_OBJECT' };
  const principal = principalId !== null ? (world.principals[principalId] ?? null) : null;
  const publicDecision = policy(requestFor(null, 'browse-published', object, ['public']), world, now);
  if (publicDecision.effect === 'allow') return { readable: true, reason: publicDecision.reason };
  if (principal === null) return { readable: false, reason: publicDecision.reason };
  const protectedDecision = policy(requestFor(principal, 'view-restricted-details', object, [object.visibility]), world, now);
  return protectedDecision.effect === 'allow'
    ? { readable: true, reason: protectedDecision.reason }
    : { readable: false, reason: protectedDecision.reason };
}
