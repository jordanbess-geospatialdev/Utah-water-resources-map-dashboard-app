# WD-027 role and permission verification

21 October 2026. Branch: `fix/WD-027-role-permissions`, based on integration
`9496de3ca6039a8a15ca305d17f8c89600b40705` (the same application source as R2
release `e9646520c891ac607a3136f49916dd6364c7277a`). See the
[requirements amendment](../product/role-permission-amendment.md).

## Verified behavior

- Engineer field, automation and regional profiles can receive scoped review,
  issue-recording and threshold-management grants. Role membership does not grant
  these actions automatically. The assignment service accepts scoped engineer
  review without granting approval, withdrawal or global QC-rule management.
- Known issues, thresholds and program-wide QC rules use separate capabilities.
  Tests exercise engineer threshold create/revise/promote, cross-system denials,
  and immediate revocation on the same service without modifying stored versions.
- Curve/shift approval, accounting finalization/supersession and raw withdrawal
  require their exact capabilities. Review and statewide administration alone
  cannot satisfy them. Scope, active-account, expiry/delegation, lifecycle and
  internal-field restrictions remain enforced.
- Reviewed corrections and explicit processing-level advances require review
  authority in addition to correction authority, including on idempotent retries.
- Runtime, assignment validation, JSON Schema, both OpenAPI assignment shapes and
  the effective SQL role constraint agree on all eight role families. The added
  roles include `water-user`; unknown roles still fail validation.
- Browser and server fixture permissions agree, with a regression check for the
  copied browser fixture. Positive approval tests use explicit test-only grants;
  default commissioner/deputy demo assignments have no approval authority.

## Executed checks

Runtime: Node 24.20.0, available pnpm 11.25.0. The repository requests pnpm
10.14.0; dependencies were installed with the frozen lockfile and scripts
disabled. No dependency, lockfile or workspace configuration change is included.

| Check | Result |
| --- | --- |
| `pnpm test` | 1,095 tests passed: policy 32, contracts 9, gateway 87, API 661, web 306 |
| Contract validator | 1,222 assertions and 9 contract hashes passed; contract version 0.1.1 |
| Database static gate | 6/6 checks passed, including role parity and deterministic fixture counts |
| `node --test --experimental-strip-types "tests/qualification/adversarial/*.test.mjs" "tests/qualification-r2/adversarial/*.test.mjs"` | 88 security/qualification tests passed |
| R2 integration tests (`asof/test/*.test.ts voice/test/*.test.ts wcat/test/*.test.ts` from `services/integrations/r2`) | 27 passed |
| `pnpm typecheck` | Passed; the web package is the workspace's declared typecheck target |
| `pnpm --filter @utah-water/web build` | TypeScript and production Vite build passed; Vite reports the large JavaScript chunk warning (about 2.12 MB before gzip) |
| `git diff --check` | Passed |
| `node scripts/gate.mjs all WD-027` against integration | Passed: task scope, commit trailers, append-only migrations and unchanged lockfile |
| Independent code review | No blocking findings; suggested threshold revocation coverage added and passed |

Total automated tests: **1,210 passed**, no failures or skips. Contract
assertions and database static checks are additional checks, not counted as tests.
Workspace lint has no package lint targets, so it supplies no separate lint proof.

## Executed migration check and rollout boundary

The actual appended migration
`database/migrations/V202610211203__WD-027_assignment_roles.sql` passed on an
isolated PostgreSQL 18.6 cluster bound only to `127.0.0.1:52425`. The regression
used a minimal copy of the original assignment role constraint and verified:

1. The original constraint rejects `water-user` and `public`.
2. An existing `engineer` assignment survives the migration unchanged.
3. Both newly represented roles are accepted after migration.
4. An unknown role is rejected and the replacement constraint is validated.

The temporary server was stopped and its `postmaster.pid` was absent afterward.
The repeatable check is [assignment-roles.sql](../../database/qualification/assignment-roles.sql).
It deliberately refuses an existing `water` schema before creating anything.
No existing or production database was accessed. This minimal-table test does
not qualify the full PostGIS schema, hosting service, view grants or deployment.

The SQL migration only broadens accepted role names; it does not grant users new
capabilities. Before deploying the policy change, existing authorized approvers
and withdrawal operators need explicit grants reviewed through the normal
assignment process. Production assignees and the open DWRi governance decisions
remain unresolved; the illustrative demo grants are not production approvals.

The implementation is committed locally for integration; no remote push,
release merge or deployment is part of this change.
