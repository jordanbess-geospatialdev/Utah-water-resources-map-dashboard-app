/**
 * Type vocabulary for the WD-016 scoped researcher credential domain
 * (services/api/src/tokens).
 *
 * Sources of truth:
 * - docs/product/baseline/02-technical-specification.md, "Identity and
 *   application permissions" ("Non-browser researcher credentials are scoped
 *   and revocable, with rate limits independent of interactive sessions") and
 *   the API table row `POST /me/api-tokens` and `DELETE /me/api-tokens/{id}`
 *   ("Issue/revoke scoped credentials; show secret once, hash at rest").
 * - docs/product/baseline/01-product-requirements.md FR-063/FR-064/FR-065 and
 *   "Data lifecycle decisions" (one-time display; thereafter label, scope,
 *   creation date, last use and revoke/rotate controls).
 * - packages/contracts/openapi.json schemas ApiTokenCreateRequest /
 *   ApiTokenIssued / ApiTokenRevoked and the `scopedToken` security scheme.
 *
 * Design rule carried everywhere: a token can never exceed its principal's
 * CURRENT authority (FR-064). The record stores only a salted hash of the
 * secret; the plaintext secret exists in exactly one place - the IssueResult
 * of the call that created (or rotated) it.
 */

/** Governed processing levels (fixtures/contracts/vocabulary.json). */
export type ProcessingLevel = 'raw' | 'provisional' | 'reviewed' | 'best-available';

/**
 * Wire-level action scopes, exactly the enum of ApiTokenCreateRequest.scopes
 * (packages/contracts). An absent `actions` field means "any action the
 * account could perform today"; listing actions only ever narrows.
 */
export type TokenAction =
  | 'catalog:read'
  | 'sites:read'
  | 'observations:read'
  | 'history:read'
  | 'exports:create';

/** Every action the contract enum admits (used to validate create requests). */
export const TOKEN_ACTIONS: readonly TokenAction[] = [
  'catalog:read',
  'sites:read',
  'observations:read',
  'history:read',
  'exports:create',
];

/** Half-open observation-time bound [start, end) a token may query. */
export interface TokenDateRange {
  readonly start: string;
  readonly end: string;
}

/**
 * Token data bounds. Each dimension is OPTIONAL and only ever NARROWS what
 * the token may fetch: absent = no constraint of that kind beyond the
 * principal's current authority; present = the request must fall inside.
 *
 * - actions: wire enum actions (above).
 * - streams: datastream ids (fixtures: str-corinne-q, ...).
 * - properties: governed observedPropertyIds (discharge, stage, voltage).
 * - processingLevels: governed processing levels.
 * - dateRange: half-open observation-time window.
 */
export interface TokenScopes {
  readonly actions?: readonly TokenAction[];
  readonly streams?: readonly string[];
  readonly properties?: readonly string[];
  readonly processingLevels?: readonly ProcessingLevel[];
  readonly dateRange?: TokenDateRange | null;
}

/** Lifecycle of a credential. Revocation is authoritative for the next request. */
export type TokenStatus = 'active' | 'revoked';

/**
 * The stored credential record. `secretHash` is `salt$digest` (hash.ts) -
 * the ONLY retained form of the secret. No field ever carries plaintext.
 */
export interface TokenRecord {
  readonly id: string;
  readonly label: string;
  readonly scopes: TokenScopes;
  /** Owning account; tokens are own-account objects (matrix row "manage-own-tokens"). */
  readonly principalId: string;
  readonly createdAt: string;
  /** Always finite: the server applies its maximum even when the request omits expiry. */
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly status: TokenStatus;
  readonly revokedAt: string | null;
  /** Set on the superseded record when rotate() replaces it. */
  readonly rotatedToId: string | null;
  /** Set on the freshly issued record when it replaced another. */
  readonly rotatedFromId: string | null;
  readonly secretHash: string;
  /** World assignmentVersion at issue time (audit trail only; never trusted at verify). */
  readonly grantVersionAtIssue: number;
}

/**
 * The safe projection returned by list/get operations: the TokenRecord
 * WITHOUT the hash. The hash never crosses a service boundary.
 */
export type TokenPublicView = Omit<TokenRecord, 'secretHash'>;

/**
 * Result of issue()/rotate(). The `secret` is shown EXACTLY ONCE: it is not
 * stored, not logged, not retained by the service after the call returns.
 * This is the FR-064 "copies its secret at creation" moment.
 */
export interface IssueResult {
  readonly token: TokenPublicView;
  readonly secret: string;
  /** True when this issue replaced (rotated) an older credential. */
  readonly rotatedFromId: string | null;
}

/** Machine-readable failure codes. HTTP statuses in parentheses. */
export type TokenErrorCode =
  | 'INVALID_REQUEST' // 400/422: malformed label/scopes/expiry
  | 'INVALID_LABEL' // 422
  | 'INVALID_SECRET_FORMAT' // 401: presented credential not uwdat_...
  | 'UNKNOWN_TOKEN' // 401: wrong secret (constant-time) or unknown id
  | 'TOKEN_REVOKED' // 401: revocation is authoritative for the next request
  | 'TOKEN_EXPIRED' // 401: half-open [createdAt, expiresAt)
  | 'PRINCIPAL_INACTIVE' // 401: account deactivated/offboarded
  | 'SCOPE_EXCEEDS_AUTHORITY' // 403: requested scopes exceed the account's CURRENT authority
  | 'TOKEN_SCOPE' // 403: action/object outside the token's declared scopes
  | 'NOT_FOUND' // 404: unknown or not-owned token id (no existence disclosure)
  | 'ALREADY_REVOKED' // 409: revoke/rotate on a revoked credential
  | 'RATE_LIMITED'; // 429: per-token budget exceeded in the window

/** Status the future HTTP layer maps from the code (technical specification error policy). */
export type TokenErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429;

/** Typed domain error; the transport layer maps code -> status, never the message alone. */
export class TokenError extends Error {
  readonly code: TokenErrorCode;
  readonly status: TokenErrorStatus;

  constructor(code: TokenErrorCode, status: TokenErrorStatus, message: string) {
    super(message);
    this.name = 'TokenError';
    this.code = code;
    this.status = status;
  }
}

/** Request body of issue()/rotate() (mirrors ApiTokenCreateRequest). */
export interface TokenCreateRequest {
  readonly label: string;
  readonly scopes: TokenScopes;
  /** Requested expiry; the server maximum applies (null -> lifetime default). */
  readonly expiresAt?: string | null;
}

/** A successfully verified presentation: what the request context becomes. */
export interface VerifiedToken {
  readonly token: TokenPublicView;
  readonly principalId: string;
  /** Assignment version of the CURRENT world snapshot (re-checked per request). */
  readonly assignmentVersion: number;
  readonly verifiedAt: string;
}

/** Fixed-window rate-limit snapshot for one token (docs/api/TOKEN-POLICY.md). */
export interface RateLimitSnapshot {
  readonly tokenId: string;
  readonly windowStart: string;
  readonly windowMs: number;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
}
