# tokens (WD-016) - scoped researcher credentials

Implements FR-064 (research credential lifecycle) and the `/me/api-tokens`
rows of the technical specification's API table ("Issue/revoke scoped
credentials; show secret once, hash at rest"), and backs the FR-065
documented programmatic API (`docs/api/`).

## Files

| File | Role |
| --- | --- |
| `types.ts` | `TokenRecord` (salted `secretHash`, never plaintext), `TokenScopes` (`actions`/`streams`/`properties`/`processingLevels`/`dateRange`), `IssueResult` (secret shown ONCE), typed `TokenError` codes/statuses. |
| `hash.ts` | Zero-dependency hashing on `node:crypto`: `uwdat_<base62>` secrets from rejection-sampled randomness, per-token 16-byte salt, `salt$sha256(salt‖secret)` storage, `timingSafeEqual` constant-time verification. |
| `tokens.ts` | `TokenService`: `issue` (policy-engine validation that scopes never exceed the account's CURRENT authority), `verify` (constant-time hash scan, revocation, half-open expiry, account activity, fixed-window rate-limit counters, `lastUsedAt`), `rotate` (validate-then-commit; old secret dies immediately), `revoke` (authoritative for the next request). Fixture-backed store seeded from `principals.json` - Sarah carries one pre-hashed example token whose preimage was discarded. |
| `scopeEval.ts` | The request-time intersection: token action allowance + data bounds (`streams`/`properties`/`processingLevels`/`dateRange`, reject - never clamp - out-of-scope windows) + the policy engine decision for the PRINCIPAL from the CURRENT world. A scoped token on a restricted stream still requires the principal's grant; revoking the underlying assignment blocks the token while the token itself stays unrevoked. |
| `test/tokens.test.ts` | The suite described in the task matrix, including the serialized-store secret scan and the run-twice determinism check. |

## Run

```bash
cd services/api
node --test --experimental-strip-types src/tokens/test/tokens.test.ts
```

## Rules pinned by tests

1. A token can never exceed its principal's CURRENT authority (issue-time
   validation; request-time cascade through the policy engine).
2. The plaintext secret exists in exactly one `IssueResult`; the store, the
   audit log and every serialization contain the token id and salted hash
   only.
3. Revocation and rotation take effect on the very next request; expiry is
   half-open `[createdAt, expiresAt)`.
4. Wrong-secret denial is constant-time across the whole record set.
5. Rate limits are per token, independent of interactive sessions.
6. Datastream authorization checks the actual target ID as well as query
   coordinates, so omitted or conflicting `streamId` values cannot bypass a
   token's stream list. Malformed, empty, reversed and out-of-range date
   windows are denied. The transport must resolve effective query defaults
   before checking property, processing-level and date bounds.

Operational policy (scope model, 90-day lifetime proposal, rotation runbook,
logging rules) is documented in `docs/api/TOKEN-POLICY.md`.
