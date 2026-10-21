# Scoped researcher credential policy (WD-016)

Operational policy for `POST /me/api-tokens` credentials (FR-064; technical
specification, "Identity and application permissions" and the API table row
"Issue/revoke scoped credentials; show secret once, hash at rest").
Domain implementation: `services/api/src/tokens/` (issue/verify/rotate/
revoke, scope evaluation, tests). Account UI: the Developer access panel
(`apps/web/src/features/developer-access/`).

Values marked PROPOSED are documented defaults pending measurement-owner
ratification, exactly like the PRD's "Data lifecycle decisions" note that
S1's token-viewable-in-account preference is superseded by a security-first
proposal. Changing a PROPOSED value is a policy decision, not a code change:
update this file and `TOKEN_LIFETIME` / `TOKEN_RATE_LIMIT` together.

## Scope model

A credential carries two independent narrowing layers; the effective
permission of a request is their intersection with the policy engine's
decision for the PRINCIPAL at request time:

```text
scoped_allow = token_allows_action               (actions)
               AND token_covers_the_data         (streams, properties,
                                                 processingLevels, dateRange)
               AND policy_allows(principal, now)  (@utah-water/policy)
```

- **actions** - the wire enum of `ApiTokenCreateRequest`:
  `catalog:read`, `sites:read`, `observations:read`, `history:read`,
  `exports:create`. Absent = every action (still bounded by the principal).
- **streams** - datastream ids the token may query. Absent = any stream the
  account can currently read.
- **properties** - governed observedPropertyIds (`discharge`, `stage`,
  `voltage` at v0.1.0).
- **processingLevels** - `raw`, `provisional`, `reviewed`, `best-available`
  (FR-066).
- **dateRange** - half-open `[start, end)` observation-time bound. A request
  outside the range is REJECTED with 403 `FORBIDDEN`, never silently
  clamped - the same no-silent-truncation rule FR-063 sets for exports.

Every dimension is optional and only ever NARROWS. Issue-time validation
refuses a request that exceeds the account's CURRENT authority whole (403,
`SCOPE_EXCEEDS_AUTHORITY`): you cannot pin a token to a stream your account
cannot read today, or to `exports:create` without the `create-exports`
capability. The token never becomes a second entitlement system - authority
lives in assignments only.

### The cascade rule

A token CANNOT exceed its principal's CURRENT authority. Revoking the
underlying assignment (steward action) or deactivating the account blocks the
token's requests immediately, even while the token record itself is still
`active`. Issuing tokens at all requires the `manage-own-tokens` capability
(matrix row 12). This cascade is pinned by tests in
`services/api/src/tokens/test/tokens.test.ts`.

## Lifetime defaults (PROPOSED, owner-ratifiable)

- Default expiry: **90 days** from issue (used when the request omits
  `expiresAt`).
- Maximum expiry: **90 days**. A longer request is rejected with 422; the
  server maximum applies - tokens are always finite.
- Validity is half-open `[createdAt, expiresAt)`: the request AT the expiry
  instant is already denied.
- Rotation restarts the clock: the replacement gets a fresh default (or
  requested) lifetime, never the old token's remainder.

## One-time secret display

S1 prefers a token viewable in the account. The adopted proposal (PRD, "Data
lifecycle decisions") is stricter: **the secret is displayed exactly once, at
creation (or rotation)**; thereafter the account shows label, scopes,
creation date, expiry, last use and rotate/revoke controls. Repeated
raw-secret retrieval is excluded pending an explicit security decision.

Rationale:

- Retrievable secrets are reusable-by-anyone-with-account-access secrets. A
  display-once secret is, at worst, as exposed as the user's clipboard.
- Server-side, only `salt$SHA-256(salt || secret)` is stored (per-token
  16-byte salt; verification is constant-time across every record). Losing
  the store does not yield usable credentials; there is nothing to "reveal".
- Recovery path is rotation: one click, same label, new secret shown once.
  Data continuity is unaffected - a token authorizes reads, it IS nothing.

## Rotation runbook

When a secret may have leaked, a script broke, or the 90-day window is
ending:

1. Dashboard: **Account -> Developer access -> [token] -> Rotate**.
   (API-wise: `DELETE /me/api-tokens/{id}` + `POST /me/api-tokens` in one
   action; the domain performs it atomically - validate-then-commit, same
   label, same scopes re-validated against current authority.)
2. Copy the new secret from the copy-once disclosure immediately.
3. Update the environment that holds the credential (`UWDAT_TOKEN`). The old
   secret fails on its NEXT request (401 `UNAUTHENTICATED`) - rotation is
   authoritative immediately; there is no grace window by design.
4. The old record stays visible as `revoked` with `rotatedTo` pointing at its
   replacement, so audit trails stay readable.

If you cannot afford even one failed request, issue a SECOND token first,
switch consumers, then revoke the first - two credentials may be active
concurrently.

## Revocation semantics

- `DELETE /me/api-tokens/{id}` (or the panel's Revoke) is immediate and
  authoritative for the next request; no cache may resurrect it.
- Revoking another account's token returns 404, not 403 - existence across
  accounts is not disclosed.
- Double revoke, or revoke-after-rotate of the superseded record: 409
  `CONFLICT`.
- Revocation frees the token's rate-limit budget; a revoked token consumes
  nothing further.
- Account offboarding (principal deactivated) kills every token of the
  account; token records remain resolvable for audit (FR-011 pattern).

## Rate limits (PROPOSED)

Fixed window per token: **120 requests / 60 seconds**, independent of
interactive-session budgets (technical specification: researcher credentials
carry "rate limits independent of interactive sessions"). 429 responses carry
`retryAfterSeconds`. Long extracts should use export jobs, not tight loops.

## Logging rules

- The secret (or any `uwdat_` string) is NEVER logged, traced, serialized
  into job payloads, placed in URLs, or included in share links - asserted by
  the token test suite, which scans the full serialized store and every
  audit line.
- Log the **token ID only**: `issue|verify|rotate|revoke|rate-limited
  <tokenId> principal=<principalId>` (see `TokenService.auditLog()`).
- The salted hash is stored, not logged on request paths; a hash in a log
  line is treated as an incident.
- Examples in this documentation use placeholders exclusively. The CI source
  scanner checks added source lines for full token-shaped literals
  (`uwdat_` plus 32 base62 characters); short placeholders and prefix constants
  are allowed. It does not scan generated bundles or source maps. The token
  unit tests check their own fixture store and audit output; release artifact
  scanning remains a separate T-16 requirement.

## Storage and verification properties

| Property | Value |
| --- | --- |
| Secret format | `uwdat_` + 32 base62 chars (~190 bits), rejection-sampled from `crypto.randomBytes` |
| Storage | `salt$digest`, 16-byte salt, SHA-256(salt ‖ secret) |
| Plaintext retention | None, anywhere - the IssueResult is the only carrier |
| Comparison | `crypto.timingSafeEqual` over every record, no early exit |
| Lookup leak | None: wrong secret scans the full record set (test-asserted compare counts) |
| Fixture store | Seeded from `fixtures/contracts/principals.json`; Sarah's example token is hash-only, its preimage was discarded |
