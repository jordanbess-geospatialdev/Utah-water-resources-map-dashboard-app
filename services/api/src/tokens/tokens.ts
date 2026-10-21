/**
 * The scoped-credential domain service (WD-016; FR-063/FR-064/FR-065).
 *
 * Fixture-backed, dependency-free (Node built-ins + @utah-water/policy):
 * a TokenService owns an in-memory record store seeded from
 * fixtures/contracts/principals.json (Sarah the researcher receives ONE
 * pre-hashed example token - hash only, the preimage was discarded when the
 * seed was generated and exists nowhere in this repository).
 *
 * Guarantees pinned by test/tokens.test.ts:
 * - ISSUE: scopes are validated against the account's CURRENT authority via
 *   the policy engine; a token can never exceed its principal (FR-064).
 *   Expiry is always finite (server default/maximum).
 * - VERIFY: salted-hash lookup with constant-time comparison across every
 *   record (no early exit that could leak which record matched), then
 *   revocation, expiry (half-open [createdAt, expiresAt)), account activity,
 *   and a per-token fixed-window rate-limit budget whose counters update
 *   here - the hook the future HTTP middleware reads. lastUsedAt advances
 *   only on success.
 * - ROTATE: validate-then-commit; the old record is revoked and linked to
 *   the replacement in the same synchronous step, so the old secret dies
 *   immediately; the new secret is returned exactly once.
 * - REVOKE: immediate and authoritative; the next presentation denies.
 * - SECRECY: the plaintext secret exists only inside the IssueResult of the
 *   call that created it. The store, the audit log and every serialization
 *   carry the id and the salted hash only - asserted by scanning the full
 *   serialized state in the test suite.
 *
 * Audit logging rule (docs/api/TOKEN-POLICY.md): log the TOKEN ID, never the
 * secret, never the hash on request paths.
 */
import { readFileSync } from 'node:fs';
import {
  buildWorld,
  capabilitiesOf,
  satisfiesCapability,
  type Capability,
  type PolicyWorld,
} from '../../../../packages/policy/src/index.ts';
import { generateSecret, hashSecret, isSecretFormat, verifySecret } from './hash.ts';
import { principalCanReadStream } from './scopeEval.ts';
import {
  TOKEN_ACTIONS,
  TokenError,
  type IssueResult,
  type ProcessingLevel,
  type RateLimitSnapshot,
  type TokenAction,
  type TokenCreateRequest,
  type TokenPublicView,
  type TokenRecord,
  type TokenScopes,
  type VerifiedToken,
} from './types.ts';

/**
 * Lifetime defaults (PROPOSED, owner-ratifiable - docs/api/TOKEN-POLICY.md):
 * 90 days default AND maximum. A request may ask for less, never more.
 */
export const TOKEN_LIFETIME = {
  defaultDays: 90,
  maxDays: 90,
} as const;

/**
 * Rate-limit defaults (PROPOSED): a fixed 60-second window with 120 requests
 * per token, independent of any interactive session budget (technical
 * specification, "Identity and application permissions").
 */
export const TOKEN_RATE_LIMIT = {
  windowMs: 60_000,
  limit: 120,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const LABEL_MAX = 80;
const PROCESSING_LEVELS: readonly ProcessingLevel[] = ['raw', 'provisional', 'reviewed', 'best-available'];

/**
 * Sarah's pre-seeded example credential. The secretHash constant was
 * generated from a random secret whose preimage was DISCARDED immediately -
 * no plaintext form exists anywhere. It anchors the "hash-only store" rule
 * the tests scan for.
 */
const SARAH_SEED_TOKEN: TokenRecord = Object.freeze({
  id: 'tok-seed-sarah-001',
  label: 'Corinne discharge research extract',
  scopes: Object.freeze({
    actions: Object.freeze(['observations:read', 'history:read', 'exports:create'] as const),
    streams: Object.freeze(['str-corinne-q'] as const),
    properties: Object.freeze(['discharge'] as const),
    processingLevels: Object.freeze(['raw', 'provisional', 'reviewed', 'best-available'] as const),
    dateRange: Object.freeze({ start: '2026-03-01T00:00:00Z', end: '2026-06-30T00:00:00Z' } as const),
  }),
  principalId: 'principal-sarah-researcher',
  createdAt: '2026-03-01T09:15:00Z',
  expiresAt: '2026-05-30T09:15:00Z',
  lastUsedAt: '2026-03-09T07:05:00Z',
  status: 'active',
  revokedAt: null,
  rotatedToId: null,
  rotatedFromId: null,
  secretHash: '276afcc5f95f426bc7e2f469947d775b$984934a3fc857b33c45abc37d30e10e646daad16709ae31cf07ca2440daa50f9',
  grantVersionAtIssue: 1,
});

export interface TokenServiceDeps {
  /** Authoritative world snapshot; called per operation, never cached (WD-011 rule). */
  readonly worldLoader: () => PolicyWorld;
  /** Injected clock (ISO instant string); tests inject constants. */
  readonly clock: () => string;
  /** Secret generator; default crypto-random (tests inject a deterministic one). */
  readonly secretGenerator?: () => string;
  /** Salt generator; default crypto-random per token (tests inject a deterministic one). */
  readonly saltGenerator?: () => Buffer;
  /** Record id generator; default `tok-<sequence>` within the store. */
  readonly idGenerator?: () => string;
  /** Fixed-window budget per token; defaults to TOKEN_RATE_LIMIT. */
  readonly rateLimit?: { readonly windowMs: number; readonly limit: number };
  /**
   * Observability hook for the constant-time test: fires one `hash-compare`
   * per record examined during verify(), match or not (no early exit).
   */
  readonly trace?: (event: TokenTraceEvent) => void;
}

/** Events the optional trace hook emits (never carries a secret). */
export type TokenTraceEvent =
  | { readonly kind: 'hash-compare'; readonly tokenId: string }
  | { readonly kind: 'verified'; readonly tokenId: string };

interface CounterState {
  windowStartMs: number;
  used: number;
}

function parseInstant(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new TokenError('INVALID_REQUEST', 422, `${field} is not a valid RFC 3339 instant: ${value}`);
  return ms;
}

function canonicalList(values: readonly string[] | undefined): readonly string[] | undefined {
  if (values === undefined) return undefined;
  return Object.freeze([...new Set(values)].sort());
}

function publicView(record: TokenRecord): TokenPublicView {
  const { secretHash: _secretHash, ...view } = record;
  return Object.freeze(view);
}

/** Build the default fixture world (principals + stations + the approved dataset object). */
export function createTokenWorld(): PolicyWorld {
  const fixtureRoot = '../../../../fixtures/contracts/';
  const principals = JSON.parse(readFileSync(new URL(`${fixtureRoot}principals.json`, import.meta.url), 'utf8'));
  const stations = JSON.parse(readFileSync(new URL(`${fixtureRoot}stations.json`, import.meta.url), 'utf8'));
  return buildWorld({
    principals,
    stations,
    extraObjects: [
      Object.freeze({
        id: 'dataset-approved-discharge-v1',
        kind: 'dataset' as const,
        systemId: null,
        ownerOrganizationId: null,
        stationId: null,
        datasetId: 'dataset-approved-discharge-v1',
        ownerPrincipalId: null,
        targetObjectId: null,
        visibility: 'restricted' as const,
        status: 'active' as const,
        fields: Object.freeze({}),
      }),
    ],
  });
}

export class TokenService {
  private readonly records = new Map<string, TokenRecord>();
  private readonly counters = new Map<string, CounterState>();
  private readonly audit: string[] = [];
  private readonly deps: TokenServiceDeps;
  private readonly rateLimit: { windowMs: number; limit: number };
  private sequence = 0;

  constructor(deps: TokenServiceDeps) {
    this.deps = deps;
    this.rateLimit = deps.rateLimit ?? TOKEN_RATE_LIMIT;
    this.records.set(SARAH_SEED_TOKEN.id, SARAH_SEED_TOKEN);
  }

  // -- audit ---------------------------------------------------------------

  private log(now: string, event: string, tokenId: string, principalId: string, detail = ''): void {
    // TOKEN ID ONLY (docs/api/TOKEN-POLICY.md logging rules).
    this.audit.push(`[${now}] ${event} ${tokenId} principal=${principalId}${detail ? ` ${detail}` : ''}`);
  }

  /** Chronological audit lines. Never contains a secret (test-asserted). */
  auditLog(): readonly string[] {
    return [...this.audit];
  }

  // -- reads ---------------------------------------------------------------

  record(tokenId: string): TokenPublicView | null {
    const record = this.records.get(tokenId);
    return record ? publicView(record) : null;
  }

  listFor(principalId: string): readonly TokenPublicView[] {
    return [...this.records.values()]
      .filter((record) => record.principalId === principalId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
      .map(publicView);
  }

  /**
   * Deterministic serialization of everything the store retains. Used by the
   * test suite to prove no plaintext secret is persisted anywhere (the scan
   * target) and that a full scenario replay is byte-identical.
   */
  serializeState(): string {
    const records = [...this.records.values()]
      .map((record) => ({ ...record }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const counters = [...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tokenId, state]) => ({ tokenId, ...state }));
    return JSON.stringify({ records, counters, audit: this.audit }, null, 0);
  }

  // -- issue ---------------------------------------------------------------

  /**
   * Issue a scoped credential. The secret is returned EXACTLY ONCE and never
   * stored. Scope validation goes through the policy engine against the
   * account's CURRENT authority: a request that exceeds it fails whole
   * (403 SCOPE_EXCEEDS_AUTHORITY), it is never silently narrowed.
   */
  issue(principalId: string, request: TokenCreateRequest, options: { rotatedFromId?: string } = {}): IssueResult {
    const now = this.deps.clock();
    const nowMs = parseInstant(now, 'clock');
    const world = this.deps.worldLoader();

    const principal = world.principals[principalId];
    if (!principal || !principal.active) {
      throw new TokenError('PRINCIPAL_INACTIVE', 401, 'token issuance requires an active principal');
    }
    const capabilities = capabilitiesOf(world, principalId, now);
    if (!satisfiesCapability('manage-own-tokens', capabilities)) {
      throw new TokenError('SCOPE_EXCEEDS_AUTHORITY', 403, 'account does not currently hold manage-own-tokens');
    }

    // Label.
    const label = typeof request.label === 'string' ? request.label.trim() : '';
    if (label.length < 1 || label.length > LABEL_MAX) {
      throw new TokenError('INVALID_LABEL', 422, `label must be 1..${LABEL_MAX} characters after trimming`);
    }

    // Expiry: default AND maximum apply (TOKEN_LIFETIME).
    const maxExpiryMs = nowMs + TOKEN_LIFETIME.maxDays * DAY_MS;
    let expiresAt: string;
    if (request.expiresAt === undefined || request.expiresAt === null || request.expiresAt === '') {
      expiresAt = new Date(nowMs + TOKEN_LIFETIME.defaultDays * DAY_MS).toISOString();
    } else {
      const requestedMs = parseInstant(request.expiresAt, 'expiresAt');
      if (requestedMs <= nowMs) {
        throw new TokenError('INVALID_REQUEST', 422, 'expiresAt must be in the future');
      }
      if (requestedMs > maxExpiryMs) {
        throw new TokenError('INVALID_REQUEST', 422, `expiresAt exceeds the maximum lifetime of ${TOKEN_LIFETIME.maxDays} days`);
      }
      expiresAt = new Date(requestedMs).toISOString();
    }

    // Actions: contract enum, and each non-public action's required
    // capability must be currently held (public projection actions
    // catalog:read/sites:read are satisfiable by anyone; observations:read
    // is bounded per request by scopeEval's two-step gate).
    const requestedActions = request.scopes.actions ?? undefined;
    if (requestedActions !== undefined) {
      if (requestedActions.length === 0) {
        throw new TokenError('INVALID_REQUEST', 422, 'scopes.actions must be non-empty when present (omit for the account-wide default)');
      }
      for (const action of requestedActions) {
        if (!TOKEN_ACTIONS.includes(action)) {
          throw new TokenError('INVALID_REQUEST', 422, `unknown token action "${String(action)}"`);
        }
        if (action === 'history:read' || action === 'exports:create') {
          const required: Capability = action === 'history:read' ? 'read-approved-datasets' : 'create-exports';
          if (!satisfiesCapability(required, capabilities)) {
            throw new TokenError(
              'SCOPE_EXCEEDS_AUTHORITY',
              403,
              `action "${action}" requires the "${required}" capability, which the account does not currently hold`,
            );
          }
        }
      }
    }

    // Streams: every declared stream must exist as a datastream and be
    // readable by the account RIGHT NOW (public projection or grant).
    const requestedStreams = request.scopes.streams ?? undefined;
    if (requestedStreams !== undefined) {
      if (requestedStreams.length === 0) {
        throw new TokenError('INVALID_REQUEST', 422, 'scopes.streams must be non-empty when present (omit for no stream constraint)');
      }
      for (const streamId of requestedStreams) {
        const object = world.objects[streamId];
        if (!object || object.kind !== 'datastream') {
          throw new TokenError('INVALID_REQUEST', 422, `unknown datastream "${streamId}"`);
        }
        const decision = principalCanReadStream(world, principalId, streamId, now);
        if (decision.effect !== 'allow') {
          throw new TokenError(
            'SCOPE_EXCEEDS_AUTHORITY',
            403,
            `stream "${streamId}" is outside the account's current authority (${decision.reason})`,
          );
        }
      }
    }

    // Properties / processing levels: governed vocabulary, syntactic check.
    const requestedProperties = request.scopes.properties ?? undefined;
    if (requestedProperties !== undefined && requestedProperties.length === 0) {
      throw new TokenError('INVALID_REQUEST', 422, 'scopes.properties must be non-empty when present (omit for no property constraint)');
    }
    const requestedLevels = request.scopes.processingLevels ?? undefined;
    if (requestedLevels !== undefined) {
      if (requestedLevels.length === 0) {
        throw new TokenError('INVALID_REQUEST', 422, 'scopes.processingLevels must be non-empty when present');
      }
      for (const level of requestedLevels) {
        if (!PROCESSING_LEVELS.includes(level)) {
          throw new TokenError('INVALID_REQUEST', 422, `unknown processing level "${String(level)}"`);
        }
      }
    }

    // Date range: half-open, parseable, start < end.
    const requestedRange = request.scopes.dateRange ?? null;
    if (requestedRange !== null) {
      const startMs = parseInstant(requestedRange.start, 'scopes.dateRange.start');
      const endMs = parseInstant(requestedRange.end, 'scopes.dateRange.end');
      if (startMs >= endMs) {
        throw new TokenError('INVALID_REQUEST', 422, 'scopes.dateRange must satisfy start < end (half-open [start, end))');
      }
    }

    const scopes: TokenScopes = Object.freeze({
      ...(requestedActions !== undefined ? { actions: canonicalList(requestedActions) as readonly TokenAction[] } : {}),
      ...(requestedStreams !== undefined ? { streams: canonicalList(requestedStreams) } : {}),
      ...(requestedProperties !== undefined ? { properties: canonicalList(requestedProperties) } : {}),
      ...(requestedLevels !== undefined ? { processingLevels: canonicalList(requestedLevels) as readonly ProcessingLevel[] } : {}),
      ...(requestedRange !== null
        ? { dateRange: Object.freeze({ start: requestedRange.start, end: requestedRange.end }) }
        : { dateRange: null }),
    });

    const secret = (this.deps.secretGenerator ?? generateSecret)();
    if (!isSecretFormat(secret)) {
      throw new TypeError('token service: secret generator produced a non-conformant secret');
    }
    const id = (this.deps.idGenerator ?? this.nextId.bind(this))();
    const record: TokenRecord = Object.freeze({
      id,
      label,
      scopes,
      principalId,
      createdAt: now,
      expiresAt,
      lastUsedAt: null,
      status: 'active',
      revokedAt: null,
      rotatedToId: null,
      rotatedFromId: options.rotatedFromId ?? null,
      secretHash: hashSecret(secret, this.deps.saltGenerator?.() ?? undefined),
      grantVersionAtIssue: world.assignmentVersion,
    });
    this.records.set(id, record);
    this.log(now, 'issue', id, principalId, `label="${label}" expires=${expiresAt}`);
    return { token: publicView(record), secret, rotatedFromId: record.rotatedFromId };
  }

  private nextId(): string {
    this.sequence += 1;
    return `tok-${String(this.sequence).padStart(6, '0')}`;
  }

  // -- verify --------------------------------------------------------------

  /**
   * Verify a presented credential and resolve the request context. Checks in
   * fail-closed order: format, constant-time hash match across EVERY record,
   * revocation, expiry, account activity, rate budget. On success lastUsedAt
   * advances and the per-token counters update (the rate-limit hook).
   */
  verify(presented: string): VerifiedToken {
    const now = this.deps.clock();
    const nowMs = parseInstant(now, 'clock');
    if (!isSecretFormat(presented)) {
      throw new TokenError('INVALID_SECRET_FORMAT', 401, 'credential is not a uwdat_ scoped token');
    }

    // Constant-time lookup: hash the candidate against EVERY stored salt and
    // compare digests with timingSafeEqual; no break on first match, so the
    // work factor does not reveal which record (if any) matched.
    let matched: TokenRecord | null = null;
    for (const record of this.records.values()) {
      this.deps.trace?.({ kind: 'hash-compare', tokenId: record.id });
      if (verifySecret(presented, record.secretHash)) {
        matched = record;
      }
    }
    if (!matched) {
      throw new TokenError('UNKNOWN_TOKEN', 401, 'credential does not match any active issued token');
    }

    if (matched.status === 'revoked') {
      throw new TokenError('TOKEN_REVOKED', 401, `token ${matched.id} was revoked ${matched.revokedAt ?? ''}; revocation is authoritative for the next request`.trim());
    }
    if (nowMs >= Date.parse(matched.expiresAt)) {
      throw new TokenError('TOKEN_EXPIRED', 401, `token ${matched.id} expired at ${matched.expiresAt} (half-open validity)`);
    }

    const world = this.deps.worldLoader();
    const principal = world.principals[matched.principalId];
    if (!principal || !principal.active) {
      throw new TokenError('PRINCIPAL_INACTIVE', 401, 'owning account is inactive; tokens die with the account');
    }

    // Fixed-window budget (PROPOSED defaults; docs/api/TOKEN-POLICY.md).
    const counter = this.counters.get(matched.id) ?? { windowStartMs: nowMs, used: 0 };
    if (nowMs - counter.windowStartMs >= this.rateLimit.windowMs) {
      counter.windowStartMs = nowMs;
      counter.used = 0;
    }
    counter.used += 1;
    this.counters.set(matched.id, counter);
    if (counter.used > this.rateLimit.limit) {
      this.log(now, 'rate-limited', matched.id, matched.principalId, `used=${counter.used}/${this.rateLimit.limit}`);
      throw new TokenError('RATE_LIMITED', 429, `token ${matched.id} exceeded ${this.rateLimit.limit} requests in ${this.rateLimit.windowMs} ms`);
    }

    const updated: TokenRecord = Object.freeze({ ...matched, lastUsedAt: now });
    this.records.set(matched.id, updated);
    this.log(now, 'verify', matched.id, matched.principalId);
    this.deps.trace?.({ kind: 'verified', tokenId: matched.id });
    return {
      token: publicView(updated),
      principalId: updated.principalId,
      assignmentVersion: world.assignmentVersion,
      verifiedAt: now,
    };
  }

  /** Current budget snapshot for one token (transport: Retry-After / X-RateLimit headers). */
  rateLimitSnapshot(tokenId: string, now = this.deps.clock()): RateLimitSnapshot | null {
    const counter = this.counters.get(tokenId);
    if (!counter) return null;
    return {
      tokenId,
      windowStart: new Date(counter.windowStartMs).toISOString(),
      windowMs: this.rateLimit.windowMs,
      limit: this.rateLimit.limit,
      used: counter.used,
      remaining: Math.max(0, this.rateLimit.limit - counter.used),
    };
  }

  // -- rotate / revoke -----------------------------------------------------

  /**
   * Rotate: validate-then-commit, atomically. The old record is revoked and
   * linked to the fresh one in one synchronous step - the OLD secret dies
   * immediately, the NEW secret is shown exactly once. Same label, same
   * (re-validated) scopes; the new lifetime restarts from the rotation.
   */
  rotate(tokenId: string, principalId: string, request: { expiresAt?: string | null } = {}): IssueResult {
    const now = this.deps.clock();
    const nowMs = parseInstant(now, 'clock');
    const existing = this.records.get(tokenId);
    if (!existing || existing.principalId !== principalId) {
      throw new TokenError('NOT_FOUND', 404, 'no such token for this account');
    }
    if (existing.status === 'revoked') {
      throw new TokenError('ALREADY_REVOKED', 409, `token ${tokenId} is already revoked (rotated ${existing.rotatedToId ?? 'n/a'})`);
    }
    if (nowMs >= Date.parse(existing.expiresAt)) {
      throw new TokenError('ALREADY_REVOKED', 409, `token ${tokenId} expired at ${existing.expiresAt}; issue a new one instead`);
    }

    // Validate the full issue against CURRENT authority BEFORE mutating.
    const issued = this.issue(principalId, { label: existing.label, scopes: existing.scopes, expiresAt: request.expiresAt ?? null }, { rotatedFromId: existing.id });

    // Commit: link old -> new, revoke old. Single-threaded domain: the pair
    // of writes below is the atomic unit; any failure above left the store
    // untouched.
    const replaced: TokenRecord = Object.freeze({ ...existing, status: 'revoked', revokedAt: now, rotatedToId: issued.token.id });
    this.records.set(existing.id, replaced);
    this.log(issued.token.createdAt, 'rotate', existing.id, principalId, `supersededBy=${issued.token.id}`);
    return issued;
  }

  /** Revoke: immediate; the next request presented with the token denies. */
  revoke(tokenId: string, principalId: string): TokenPublicView {
    const now = this.deps.clock();
    const existing = this.records.get(tokenId);
    if (!existing || existing.principalId !== principalId) {
      throw new TokenError('NOT_FOUND', 404, 'no such token for this account'); // no existence disclosure across accounts
    }
    if (existing.status === 'revoked') {
      throw new TokenError('ALREADY_REVOKED', 409, `token ${tokenId} is already revoked`);
    }
    const revoked: TokenRecord = Object.freeze({ ...existing, status: 'revoked', revokedAt: now });
    this.records.set(tokenId, revoked);
    this.counters.delete(tokenId); // a revoked token consumes no budget
    this.log(now, 'revoke', tokenId, principalId);
    return publicView(revoked);
  }
}

/** Convenience factory: TokenService over the default fixture world. */
export function createTokenService(deps: Omit<TokenServiceDeps, 'worldLoader'> & { worldLoader?: () => PolicyWorld }): TokenService {
  let cachedWorld: PolicyWorld | null = null;
  return new TokenService({
    ...deps,
    worldLoader: deps.worldLoader ?? (() => (cachedWorld ??= createTokenWorld())),
  });
}
