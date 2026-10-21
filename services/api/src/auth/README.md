# Auth boundary (WD-004)

Server-side identity and entitlement evaluation seam for the future API
service. Three pieces:

- `session.ts` - `SessionResolver` interface plus `FixtureSessionResolver`,
  a fixture-backed staging stub (DR-011: the institutional OIDC provider does
  not exist yet; issuer/audience/signature validation arrives with it).
- `authorize.ts` - `authorize(session, action, objectContext, deps)`, the
  gate every endpoint, queued job, download and spatial request must call.
  Denials raise typed errors mapped to 401/403/404 below.
- `@utah-water/policy` (packages/policy) - the pure entitlement engine this
  boundary delegates to. See `packages/policy/src/matrix.ts` for the
  authorization matrix as data.

## Wiring notes

- **Relative import.** `session.ts` / `authorize.ts` import the policy
  package via `../../../../packages/policy/src/index.ts` because workspace
  dependency wiring (package.json deps + lockfile) is frozen on this task;
  the orchestrator chore branch that wires typecheck/workspace deps should
  switch these to the `@utah-water/policy` specifier.
- **No cache in this layer.** `deps.worldLoader` is invoked once per
  authorization and must return the authoritative assignment state
  (database read in production). The engine consults no cache; the Decision
  echoes `assignmentVersion` so callers can refuse results derived from a
  snapshot older than a revocation they have observed.
- **Clock injection.** `deps.clock` defaults to `new Date()`; tests inject
  constants. Delegation expiry, grant expiry and effectiveness are all
  evaluated against this clock with half-open intervals.
- **Jobs and downloads reauthorize.** Async exports, reports and proxied
  downloads call `authorize()` again at execution/download time; a revoked
  grant must fail the next request even with a warm artifact or cache.
- **GET /session** should surface `capabilitiesOf(world, principalId, now)`
  and `assignmentVersionOf(...)` from the policy package: subject,
  capabilities, assignment version, server time; no upstream credential.

## Cookie / CSRF contract (technical specification, "Identity and application permissions")

- Browser sessions: **Secure, HttpOnly, SameSite** cookies. Session cookie
  holds only the opaque credential reference; no capability or role data in
  the browser.
- Mutations (any non-GET) require **CSRF protection** (double-submit token
  or synchronizer token) **and an Origin/Referer check** against the
  approved application origin.
- **No secrets in browser code or URLs.** Tokens never appear in links,
  query strings or logs; shareable URLs carry only non-sensitive filter
  state (FR-008).
- Public browsing works without a login: anonymous requests resolve to
  `principal: null` and only the `allow_public_read` branch can satisfy
  them.
- Non-browser researcher credentials are scoped and revocable, with rate
  limits independent of interactive sessions (FR-064; token issuance itself
  lands in WD-016 under `services/api/src/tokens/`).

## Status mapping (fixed hidden-object policy)

`denialStatus(decision, object)` in `authorize.ts`:

| Decision reason | HTTP | Rationale |
| --- | --- | --- |
| `DENY_ANONYMOUS`, `DENY_UNKNOWN_PRINCIPAL`, `DENY_PRINCIPAL_INACTIVE` | 401 | Missing/expired identity. |
| `DENY_UNKNOWN_OBJECT` | 404 | Object id does not resolve. |
| `DENY_OUT_OF_SCOPE` on a non-public object | 404 | Hidden-object choice: restricted/internal rows do not exist for outsiders. |
| `DENY_OUT_OF_SCOPE` on a public object | 403 | Existence is public; the operation is refused. |
| `DENY_CAPABILITY_NOT_GRANTED`, `DENY_FIELD_VISIBILITY`, `DENY_LIFECYCLE_STATE`, `DENY_ASSIGNMENT_REVOKED`, `DENY_ASSIGNMENT_EXPIRED`, `DENY_DELEGATION_*`, `DENY_ASSIGNMENT_NOT_EFFECTIVE`, `DENY_INVALID_ASSIGNMENT` | 403 | Actor is inside the object fence; the operation/grant state is forbidden. |

Actor derivation: from the session ONLY. Body `actorId`/`role`/owner fields
are structurally unread by this layer (FR-010).

## T-03 obligations for the future HTTP layer

When the Fastify service lands, its authorization test suite must cover
(04-ai-development-and-testing.md, verification matrix row T-03):

1. **Persona journeys over HTTP**: anonymous (Donna), owner A/B (Wiley on
   org-cache-water vs org-bear-river-users), commissioner system A/B (Cody
   Bear River vs a Weber-only principal), engineer A/B (Fatima vs Priya),
   steward (Diego); plus deputy boundary clock tests via the injected
   session clock.
2. **Altered identifiers**: requests with forged/extra body `actorId`,
   `role`, or owner fields must not change any outcome; changing a requested
   system/site id in a URL or body must not reveal another scope's private
   records (FR-019).
3. **CSRF**: mutations without the CSRF token or with a wrong Origin header
   rejected before policy evaluation.
4. **Session expiry/revocation**: an expired session cookie yields 401; a
   revoked entitlement yields 403 (or 404 per the hidden-object policy) on
   the next request - never a cached allow.
5. **Token scope/rotation**: researcher tokens cannot exceed the account's
   current authority; rotation revokes the old secret; revoked tokens fail
   the next request (FR-064).
6. **Status-code conformance**: every denial reason above maps to exactly
   the documented status, and error bodies carry the stable machine code
   (`decision.reason`) plus `requestId`, with no internal notes or object
   existence leakage on 404s.
