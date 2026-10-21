# MVP Qualification Report — WD-021 (independent release-gate pass)

Utah Water Measurement Data Dashboard — MVP gate per
`docs/product/baseline/04-ai-development-and-testing.md` ("Verification
matrix" T-01..T-16, "Test data", "Commands and CI gates").

| Field | Value |
| --- | --- |
| Executed by | qa_accessibility (independent qualification agent — none of the qualified code was written by this agent) |
| Date | 2026-10-21 (UTC) |
| Worktree / branch | `utah-water-dashboard-worktrees/wd-021-mvp-qualification`, `test/WD-021-mvp-qualification` |
| Base revision | `0ffd2f3` ("chore: mark WD-015 completed - ALL MVP implementation tasks merged") |
| Qualification commit | the single `test(WD-021)` commit on this branch (`git log --grep="test(WD-021)" -1`) |
| Verdict | **MVP machine-checkable evidence chain PASSES on fixture evidence. Production authorization additionally requires the owner/staging actions listed in "Verdict".** |


### Resolution record (2026-10-21)

- **DEFECT-Q1 FIXED** — exclusion lists anonymized to class labels + counts (fix/Q1-Q2-public-projections, merged). Tripwire now pins the fixed state: zero hidden-object names in any public summary; exclusion accounting must remain present.
- **DEFECT-Q2 FIXED** — default-public area totals run a visibility wall before status rules; non-public stations/streams aggregate as anonymous class counts and are never itemized (same fix). Tripwire now pins zero hidden-object ids in public totals plus mandatory anonymous omission accounting. Golden fractions unchanged (2/4, 1/68, 66/68).
- **DEFECT-Q3 FIXED** — statewide-administration satisfies field-visits only for steward-family principals via SATISFACTION_ROLE_GATES (fix/Q3-capability-ceiling, merged); full capability audit codified as invariant tests; POLICY_VERSION 0.1.1.
- **DEFECT-Q4 RESOLVED** — delivery backlog statuses re-synchronized (Q4 evidence updated 2026-10-21).
- Re-run after fixes: full qualification sweep Verdict PASS, exit 0, deterministic.

## 1. Environment record

| Item | Value |
| --- | --- |
| Node | v24.20.0 (type stripping native; `--experimental-strip-types` used by the suites) |
| pnpm | corepack 10.14.0 (matches `packageManager: pnpm@10.14.0`) |
| Platform | win32 10.0.26100 x64 (Git Bash/MSYS) |
| Commit under test | `0ffd2f3997c32403eae7b668d2160c047f8402f4` |
| Frozen install | `corepack pnpm install --frozen-lockfile` exit 0 (~550 ms, store-backed, no lockfile drift) |
| `pnpm-lock.yaml` sha256 | `00cdfc91ab6b61483ae95a8a1fd552ad2b55f3da5ccd8effce16a8aa055e55ae` (lockfileVersion 9) |
| Map engines | `@geolibre/core` 3.3.0, `@geolibre/map` 3.3.0, `maplibre-gl` 6.15.0, react/react-dom 19.1.1 — exact pins, lockfile specifiers byte-equal to `package.json` |
| Port 5173 | not touched at any point |

## 2. Machine-check results

One command reproduces everything below from a clean checkout:

```bash
node tests/qualification/run-qualification.mjs
```

Executed twice back-to-back (17:23:42Z and 17:24:06Z, 2026-10-21): identical
group results both times — **deterministic** (adversarial corpora use fixed
seeds; the policy-fuzz suite additionally re-runs its 640-tuple decision
sequence internally and compares a sha256 of the decisions).

| Group | Evidence (command) | Result |
| --- | --- | --- |
| T-01 contracts + traceability | `node check.mjs` in `packages/contracts` (1212 assertions, 9 sha256 contract hashes); FR-001..FR-068 + NFR-001..NFR-010 all resolve in the PRD; all 78 backlog task citations resolve; T-01..T-16 catalog present; traceability CSV 78/78 rows | **PASS** (6 checks) |
| T-02/T-03 policy + authorization | policy suite (26 tests) + adversarial: 640-tuple seeded fuzz vs an independent oracle, exhaustive 7 principals x 10 restricted objects x 8 accessor families x 2 world states (~1,120 combinations), token scope-escalation set (14 tests), restricted-byte sweep (17 tests) | **PASS** (4 commands) |
| T-04 database | `database/check.mjs` static gate (5/5: migration names, PK coverage, forbidden columns, restricted-column confinement, 165-INSERT row-count determinism) | **PASS** — live-SQL parts **BLOCKED: no database** |
| T-05 protocol + spatial | geo-gateway suite (87 tests) + recorded live capture: manifest 14/14 captures, 14 artifacts re-hashed byte-identical to manifest sha256s, honest D5 (MVT layer version 1) recorded | **PASS** — live re-capture **BLOCKED** (needs the pinned Docker stack) |
| T-06/T-07/T-15 data, revisions, imports, alerts/reports | `services/api` suite (463 tests; revision/audit, bulk-import, notification/digest, QC and report suites green) + export/report restricted-byte sweep | **PASS** (5 checks) |
| T-08 cache + privacy | gateway cache/privacy suite (23 tests), attachments visibility wall (14 tests), adversarial canary sweep: zero restricted bytes in any public projection; cohort `private, no-store`; anonymous cohort denial before upstream | **PASS** (3 commands) |
| T-10/T-13 web + AI | web suite (237 tests incl. projection, share codec, AI proposal-to-filters), AI filter-parser suites (59 tests incl. 16-case injection corpus), hostile share-URL corpus (66 queries, 6 suites) | **PASS** (3 commands) |
| T-16 dependency integrity | lockfile present (no competing lockfile), v9, engines exactly pinned and matching, frozen install exit 0 | **PASS** (5 checks) — OSV/license scan **BLOCKED** (no scan tooling in a zero-dependency run; lockfile hash recorded) |
| T-09/T-11/T-12/T-14/R2 | recorded as BLOCKED-by-design below | recorded, not silently skipped |

Adversarial suites added by this qualification (all under
`tests/qualification/adversarial/`, zero new dependencies):

- `restricted-bytes.test.mjs` — fixture canaries (gate codes `4471-CDX`,
  `9917-KWW`, `2208-QQZ`, wiring-note fragments, `SYNTHETIC-NEVER-PUBLISH`,
  restricted field-name keys) byte-scanned across web projections (4 public
  personas + out-of-scope engineer, with a positive control proving entitled
  viewers DO receive the internal block), discovery filters/share URLs,
  CSV export bytes, summaries, distribution reports (API + web model), and
  geo-gateway responses (public pass-through, anonymous cohort denial
  before upstream, cohort allow `private, no-store`, management/traversal
  probes refused with zero upstream calls, no credential/upstream-base echo).
- `policy-fuzz.test.mjs` — 640 seeded (principal, action, object, fields,
  clock) tuples vs an independent oracle written from the specification
  formula and fixture JSON (sharing no code with the engine), including all
  delegation/assignment boundary clocks; plus the exhaustive principal x
  restricted-object x accessor-family product; plus matrix-ceiling and
  deputy half-open-window probes.
- `token-escalation.test.mjs` — issue-time over-scoping (streams/actions),
  forged-record use-time attacks, grant-revocation and account-deactivation
  cascades, FR-065 data-bounds rejection (never clamping, half-open edges),
  secret format/guess/rotate/revoke handling, cross-principal revocation.
- `share-url-corpus.test.mjs` — 66 hostile queries (version confusion,
  prototype-pollution keys, credential params, encoded canaries, restricted
  ids, script injection, oversized inputs, malformed/axis-swapped extents,
  invalid UTF-8) replayed against the discovery codec: no throws, no leaks,
  byte-stable round trips, idempotent bounded canonicalization.

## 3. EXECUTED vs PENDING

**EXECUTED (machine, this run):** T-01, T-02, T-03 (domain level — see
limitation), T-04 static gate, T-05 (synthetic gateway suite + recorded
live-capture integrity), T-06, T-07, T-08 (synthetic + sweep), T-10
(model/codec level), T-13, T-16 (lockfile/pins/frozen install).

**PENDING (environment- or stage-gated, each with its exact blocker):**

| Item | Status | Blocker / owner action |
| --- | --- | --- |
| T-03 HTTP-level authorization | Partially executed | `services/api` is a domain library; no HTTP transport is wired yet. Status-code mapping (401/403/404) exists (`services/api/src/auth/authorize.ts`) and is exercised at domain level. Owner: wire the HTTP layer, then replay the exhaustive denial product over real requests. |
| T-04 live SQL | BLOCKED — no database | Migrations on a disposable PostgreSQL/PostGIS, publication-view behavior, unique ids/constraints, index query plans, transaction rollback, pool isolation. Owner: platform_ops to provision the disposable database. |
| T-05 live re-capture | EXECUTED 2026-10-21 (recorded); re-capture BLOCKED | Requires the pinned Docker stack (neoserver 0.3.0 / postgis 17-3.5 digests). This run re-verified all 14 recorded artifacts byte-identical to the manifest. D5 (MVT layer version 1) remains an honest open defect with spatial_integration/DR-009. |
| T-08 live tile-cache invalidation | Recorded evidence accepted | `manual-probes/probe-cache-refresh.log` from the T-05 capture; re-run needs the stack. |
| T-10 browser persona E2E | PENDING | Playwright flows need a running web build; out of this environment. |
| T-11 accessibility | PENDING — planned and unimplemented, not required to be automated here | Automated axe plus manual keyboard/screen-reader/contrast/zoom record requires a browser; no browser automation was engaged for WD-021. Owner: qa_accessibility with the deployed staging build. |
| T-12 performance/load | PENDING — planned, unimplemented | Requires the staging profile (10,000 features, 100 sessions, defined network/CPU envelope). Not a fixture-evidence item. |
| T-14 operations drills | EXECUTED 2026-10-21 (recorded); re-run BLOCKED | Single-writer lock, restart, quiesced backup/restore drills are recorded in `infra/neoserver/qualification/recorded/`; re-run needs the stack. |
| T-09 offline sync / R2 acceptance / Discovery | OUT OF MVP SCOPE | Planned and unimplemented, **not required for the MVP gate** (R2 = WD-026, Discovery = WD-023). |

## 4. Defects found (filed, not fixed — no implementation writes in this scope)

| # | Severity | Location | Finding |
| --- | --- | --- | --- |
| DEFECT-Q1 | Low | `services/api/src/summaries/indicators.ts` (mirrored in `apps/web/src/features/overview/derivation.ts`) | Public statewide indicators embed exclusion ID lists that disclose the identifier and status of `sta-ogden-valley-proposed` — a restricted-visibility, unpublished station whose existence the hidden-object rule says not to reveal. No restricted VALUES leak. Pinned by `restricted-bytes.test.mjs` ("DEFECT-Q1 pinned"); the pin fails when fixed, forcing this report to be updated. |
| DEFECT-Q2 | Low–Medium | `services/api/src/summaries/totals.ts` (`fixtureAreaTotals`, default public visibility) | The default-PUBLIC area totals enumerate per-stream breakdown rows for EVERY fixture stream, including the restricted owner stream, the internal diagnostic stream and the restricted proposed gauge (ids, display names, properties, exclusion reasons) — an inventory disclosure of hidden objects to anonymous callers. No restricted VALUES leak; counts alone would be defensible. Pinned by `restricted-bytes.test.mjs` ("DEFECT-Q2" pin set). |
| DEFECT-Q3 | Low | `packages/policy/src/matrix.ts` | `CAPABILITY_SATISFIES['field-visits']` includes `statewide-administration`, but `ROLE_CEILING.steward` does not list `field-visits` — violating the file's own rule that a satisfaction entry may never exceed the matrix ceiling for the carrying role. Effect: the fixture steward grant authorizes field visits today. No cross-persona escalation. Pinned by `policy-fuzz.test.mjs` ("DEFECT-Q3 pinned"). |
| DEFECT-Q4 | Informational | `docs/delivery/specifications/backlog.json` | Delivery-copy task statuses are stale relative to the authoritative root `tasks.json` (WD-013 completed/in_progress, WD-015 completed/planned, WD-025 completed/planned). Documentation drift only; the T-01 gate reports it as a note. |
| Pre-existing (re-verified, owners already assigned by T-05) | — | `infra/neoserver/qualification/recorded/CAPTURE-REPORT.md` | D5 MVT layer version 1 (open with spatial_integration/DR-009), D6 upstream `PUT layer` drops `sql_view`, D7 non-deterministic tile bytes from `row_number()` ids, D9 MSYS path mangling caveat. Not re-opened here; recorded evidence integrity re-verified. |

No high-severity security or data-integrity defect was found: gate codes,
wiring notes and the publication canary appear in zero public projections
across every surface scanned, all cross-system/cross-role denial products
hold, token scopes cannot exceed current account authority, and the share
codec survives the hostile corpus without leaks.

## 5. Verdict

**Pass on fixture evidence:** T-01, T-02, T-03 (domain level), T-04 (static
gate), T-05 (synthetic + recorded live capture), T-06, T-07, T-08
(synthetic + sweeps), T-10 (model level), T-13, T-16.

**Requires owner/staging action before production authorization:** live-SQL
evidence against a disposable PostgreSQL (T-04), HTTP-layer authorization
replay once the transport is wired (T-03), a fresh T-05 capture on the
pinned stack plus the D5 MVT-version decision, browser persona E2E and
accessibility records (T-10/T-11), the staging load profile (T-12), and the
operations drills re-run with the release manifest (T-14). Per the plan
("NeoServer's external-database writes need a controlled cache refresh; its
single-store deployment requires one active writer. T-08 and T-14 therefore
block production acceptance even when the UI appears correct."), T-08's
live-cache cycle and T-14's drills are production-blocking even though their
recorded evidence is green. DEFECT-Q1/Q2 (hidden-object naming in public
summaries) and DEFECT-Q3 (steward ceiling inconsistency) need an owner
decision; none is high-severity, so they do not block the MVP gate on
fixture evidence.

R2 acceptance and Discovery remain planned and unimplemented, and are not
required for this gate.
