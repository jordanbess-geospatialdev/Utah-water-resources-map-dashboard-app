# R2 Qualification Report — WD-026, the Independent R2 Gate

Task WD-026 (agent `qa_accessibility`) | Release gate: R2 (P4 acceptance row of
`docs/product/baseline/04-ai-development-and-testing.md`) | 2026-10-21

This gate was executed by an agent that implemented **none** of the code under
test. Everything below is reproducible with one command from the worktree root:

```
node tests/qualification-r2/run-r2-qualification.mjs
```

The reproducer re-runs every implementation suite it cites, executes this
gate's own NEW adversarial attacks (`tests/qualification-r2/adversarial/`),
re-invokes the WD-021 MVP reproducer for the MVP surface, and prints
PASS/FAIL/BLOCKED per group with an environment record. Exit code 0 = no
group FAILED (BLOCKED items are recorded, not failed).

---

## 1. Environment record

| Field | Value |
| --- | --- |
| Node | v24.20.0 |
| pnpm | 10.14.0 (via corepack; `pnpm-lock.yaml` sha256 `00cdfc91ab6b61483ae95a8a1fd552ad2b55f3da5ccd8effce16a8aa055e55ae`) |
| Platform | win32 10.0.26100 x64 (Windows) |
| Revision | `test/WD-026-r2-qualification` @ `abc729d364904aa0c51c2cb44ddd63597fbeb2b3` (integration tip: "chore: mark WD-025-R2 completed — ALL implementation tasks across MVP and R2 merged") |
| Executed | 2026-10-21 (both determinism runs) |
| Dependencies | zero new dependencies for this gate; `node_modules` populated by `pnpm install --frozen-lockfile --prefer-offline` (store-backed, no lockfile drift; needed for `@geolibre/*` in the web suite) |
| Database / Docker | none engaged (see BLOCKED items) |

## 2. Scope and method

The gate covers the R2 acceptance row — "offline sync, decision/finalized
snapshots, flexible periods, recurring issue trends, rating history, voice
notes, asset transfers, approved as-of/voice/WCAT work and supplier
reporting" — against the six R2 tasks merged since the MVP gate (WD-011-R2,
WD-012-R2, WD-013-R2, WD-017, WD-023-R2, WD-025-R2), mapped to verification
rows T-06, T-09, T-13 and T-15 per the plan's note that "T-09 and the R2
portions of T-06/T-13/T-15 qualify the separate R2 gate".

Method: run the implementers' suites as-is; verify the specifically named
acceptance assertions (crash-before-ack replay, exactly-once) appear and
pass by name; then attack through the public API surface with NEW
adversarial suites written by this agent:

| File | Attack |
| --- | --- |
| `adversarial/restricted-bytes-r2.test.mjs` | cross-R2-surface restricted-byte sweep: quality-trend public/anonymous projections (with a gate code planted in an internal issue title), supplier outputs for both orgs, as-of point/range exports and denial bytes, finalized-snapshot views and stored bytes, WCAT serializations — scanned for the shared canary vocabulary (gate codes, wiring fragments, restricted field keys, restricted object ids), with positive controls proving the scan is not vacuous. Also the cross-org supplier sweep (org-A ids nowhere in org-B outputs across six API surfaces, both directions) and the DEFECT-R2-1 pin. |
| `adversarial/finalize-authority-fuzz.test.mjs` | finalize-authority fuzz: 11 unauthorized actor classes (anonymous, capability-less engineers, researcher, out-of-scope engineer, cohort member, both supplier water users, both Water Use reviewers, unknown principal, empty-string actor) x `finalize`/`finalizeSuperseding` x 4 period kinds x 3 systems (incl. hidden/unknown) x 2 optimistic guards, plus 400 seeded randomized attempts (mulberry32) — every one denied, zero ledger records, zero audit events; positive control proves exactly the documented authority set (statewide steward, granted commissioner, deputy inside her window) succeeds; supplier-world grants provably never satisfy finalize. |
| `adversarial/offline-conflict-integrity.test.mjs` | offline conflict integrity: a conflicted draft's payload stays byte-identical across reload round-trips, repeated `syncOnReconnect` (never re-uploaded), explicit `retryDraft` against the moved revision (re-conflicts, never merges), transport-crash storms, revoked-grant gates and a chaos interleave with accepted/flaky/quota siblings; 60 seeded random engine-call sequences; the ONLY exit is an explicit `resolveConflict` (discard demands confirmation, revise rebases on the server's revision with the human's payload). |
| `adversarial/asof-boundary-oracle.test.mjs` | as-of boundary fuzz vs an INDEPENDENT naive oracle (no shared code): every revision `recordedAt` and observation `receivedAt` in the store at T, T±1 ms, plus 350 seeded random instants — well over 30,000 point comparisons (the suite itself asserts ≥5,000) over all 68 fixture logical keys (value, unit, level, qualifiers, revision id, tombstone flag, excluded-later count, gap decisions), anonymous for public streams and in-scope engineers for restricted/internal ones; sliding range windows per stream checked point-by-point against the oracle; post-correction byte reproduction; hostile/unparseable inputs. |
| `adversarial/cross-domain-freeze.test.mjs` | the cross-domain snapshot-immutability check (see T-06/R2 below). |
| `adversarial/trends-reconciliation.test.mjs` | FR-043 reconciliation balance on 25 fresh seeded corpora (exact duplicates, unknown-stream records, multi-revision correction chains, internal/public issues), one-chain-one-incident, public-projection recounts, determinism, and the DEFECT-R2-2 pin. |
| `adversarial/voice-attach-wall.test.mjs | FR-047 review wall probed across every non-reviewed lifecycle state and every attach path (`officialTranscriptAttachment`, `saveReviewedTranscript`): fresh notes, unreviewed drafts, review-without-draft, spoofed clones (reviewed state with reviewer or transcript stripped), nine hostile state strings, pre-review text tampering; the official artifact provably carries no measurement/qualifier/inspection field. |

## 3. Per-group results (both runs identical)

| Group | Result | Evidence (tests pass/fail) |
| --- | --- | --- |
| T-09 offline evidence | **PASS** | apps/web offline suites 29/29; api sync suites 33/33; adversarial conflict-integrity 5/5; cited by name and PASSED: `crash AFTER commit BEFORE the sync-ledger write: the workflow ledger probe replays the commit`, `commit-before-ack crash against the real server: the re-send replays; exactly one record exists`, `crash AFTER server commit BEFORE acknowledgement: the re-send replays; no duplicate lands`, `double-send is exactly-once: the duplicate delivery replays the original record id`, `re-sending the same draft replays the recorded verdict and commits nothing new`, `a double-send inside one batch replays the first verdict for the second copy`, `a draft left syncing by a crashed run is requeued on the next load with the same key`; asset transfers covered by the transfers suite (append-only association timeline, evidence mismatch, pre-transfer visit isolation, revoked grant). 1 BLOCKED (device browsers). |
| T-06/R2 snapshot immutability | **PASS** | accounting-snapshots suites 41/41 (incl. flexible periods: CY/WY/irrigation/custom windows, DST golden); rating-curves suites 26/26 (rating history, immutability, goldens); adversarial cross-domain freeze 2/2: finalize THREE periods (report-derived, decision-derived, custom), then a correction + an exclusion tombstone + a curve supersession + as-of queries + a legal supersession attempt — every finalized `contentHash` AND every stored byte unchanged, audit trail append-only; finalize-authority fuzz 7/7 (see method table). |
| T-15/R2-a supplier isolation | **PASS** | supplier-report suites 56/56; adversarial restricted-byte/cross-org sweep 10/10 — serialized outputs of `createDraft`, `listDrafts`, `systemView`, `listSubmissions`, `getApprovedBoundary`, `listProposals` for each organization carry none of the other org's identifiers (org id, system, stations, discharge streams, synthetic actors) in EITHER direction, and no canary bytes; cited implementation tests passed by name (`cross-supplier draft access is a hidden 404 in both directions`, `the organization comes from the assignment, never the request`, `submissions list is organization-isolated`). |
| T-13/R2 trends reconciliation | **PASS** | quality-trends suites 28/28; adversarial reconciliation 5/5: balance holds on all 25 seeded fresh derivations (attributed + duplicatesDropped + unattributed == raw, empty doubleCounted/phantom lists, non-vacuous corpora with duplicates and unknown streams), one correction chain == one incident, public projection recounts without fabrication. DEFECT-R2-2 pinned (below). |
| T-15/R2-b extensions boundaries | **PASS** | integrations suites 25/25; the static no-network scan (`static no-network scan: no fetch/http/https transport anywhere in the r2 tree`) passed by name; voice review wall 8/8 (no transcript in any state other than reviewed/saved can attach — allow-list wall, hostile states included); as-of oracle 6/6 (tens of thousands of oracle comparisons). 2 BLOCKED (voice provider/privacy; WCAT contract). DEFECT-R2-1 pinned (below). |
| Full regression | **PASS** | all six packages green: contracts checker exit 0; policy 30/30; geo-gateway 87/87; api 650/650; web 304/304 (includes every R2 feature model); integrations-r2 25/25; database static gate exit 0; WD-021 MVP reproducer re-invoked successfully (MVP surface re-verified end to end, its own BLOCKED items unchanged). |
| This gate's adversarial directory | **PASS** | 43/43 across all 7 files in one run. |
| Environment/owner-gated | **PASS** (6 BLOCKED recorded) | see section 5. |

## 4. Defects found (filed precisely; NOT fixed by this gate)

| Id | Severity | Location | Finding | Disposition |
| --- | --- | --- | --- | --- |
| DEFECT-R2-1 | **Medium** | `services/integrations/r2/asof/asof.ts`, `reconstructRangeAsOf` (window authorization loop) | An as-of RANGE query whose `[from, to)` window contains no observations skips per-observation authorization entirely: an anonymous (or out-of-scope) caller querying a NON-PUBLIC stream id that exists but has no observations in the window receives `outcome: 'ok'` with the stream id echoed, while an unknown stream id receives the hidden-object 404. That is an EXISTENCE ORACLE for restricted/internal stream ids, contradicting the module's own documented rule ("a restricted stream stays hidden from out-of-scope actors; cross-scope denial maps to a hidden-object 404"). No observation data leaks (zero points), and windows that DO contain observations deny correctly. Reproduced on fixture `str-ogden-q-proposed`. | Pinned by `restricted-bytes-r2.test.mjs` test "DEFECT-R2-1 pinned: empty-window range as-of is an EXISTENCE ORACLE for non-public streams"; fix belongs to the WD-023-R2 owner (admit the stream via policy when the window is empty, mirroring the point-query path). |
| DEFECT-R2-2 | **Low** | `services/api/src/quality-trends/trends.ts`, `reconcileTrends` (unattributed loops) | An exact-duplicate record delivered on a stream ABSENT from the site table is counted BOTH in `duplicatesDropped` (raw minus unique) AND once per array entry in `unattributedCount`, so `attributed + duplicates + unattributed` exceeds the raw count and `balanced` flips to false for that input class — violating the module's documented arithmetic ("nothing is silently dropped, nothing is counted twice"). The boolean honestly reports the imbalance (no false balance), and no incident data is corrupted — the defect is arithmetic only, on a corner input (duplicate delivery of a record on an unknown stream). Minimal repro: one QC hit delivered twice on `str-ghost` with one known stream in the site table yields `duplicatesDropped=1, unattributedCount=2, balanced=false` against 2 raw records. | Pinned by `trends-reconciliation.test.mjs` test "DEFECT-R2-2 pinned: an exact duplicate on an UNKNOWN stream double-counts in the reconciliation arithmetic"; fix belongs to the WD-013-R2 owner (count unknown-stream duplicates once, on either side of the arithmetic). |

Observations recorded WITHOUT defect status (judged non-findings by this
gate; owners may reclassify):

- **OBS-1** — capability-less actors probing the finalize authority receive
  403 `DENY_CAPABILITY_NOT_GRANTED` for an existing out-of-scope system and
  404 for an unknown one (an existence distinction on SYSTEM ids). System ids
  (`sys-bear-river`, ...) already appear in public catalog projections, so no
  protected fact is disclosed; the hidden-object mapping still fires for
  capability holders (commissioner on Weber → 404), pinned in the fuzz.
- **OBS-2** — fixture `obs-q-016`/`obs-q-017` are two distinct source events
  sharing one logical key (the WD-007 duplicate-submission pair). As-of point
  reconstruction resolves the key deterministically to the later row; the
  shadowed duplicate is unreachable by point query (by design of the
  `AsOfSource` seam). Noted as a data-model fact the oracle had to mirror.
- **OBS-3** — the finalize/reopen authority rule, supplier-reporting numeric
  ranges/reviewer split and rating-curve working coefficients remain PENDING
  OWNER RATIFICATION by the implementers' own documentation; they are
  recorded on the artifacts and pinned by tests, but they are owner
  decisions, not machine-checkable evidence.

## 5. Executed vs pending (honesty ledger)

EXECUTED in this run (machine-checked, twice, identical):

- All six R2 implementation surfaces' suites (offline sync, asset transfers,
  accounting snapshots, rating curves, supplier reporting, quality trends,
  as-of/voice/WCAT seam) — 238 domain tests cited in the group table.
- Full regression of all six packages (contracts, policy, geo-gateway, api,
  web, integrations-r2) plus the database static gate — 1,096 tests green.
- This gate's 43 adversarial tests (independent corpora, seeded fuzzes,
  independent oracles) including the pinned defects above.
- The WD-021 MVP reproducer re-invoked end to end.

PENDING / BLOCKED (environment- or owner-gated; recorded, never silently
skipped; none fails the gate):

1. **Live device browsers (T-09)** — real airplane-mode capture, IndexedDB
   persistence across a physical reload, OS-level offline/reconnect jitter
   and device quota behavior. The suites exercise the exact serialization
   boundary through the in-memory JSON store fake; device-browser evidence
   needs the staging profile.
2. **Real transcription provider + NFR-010 state-policy privacy review
   (voice)** — provider selection is owner-gated; the deterministic stub is
   the only implementation and the static no-network scan enforces the
   boundary until approval.
3. **Real WCAT contract** — external schemas, ids, API and ownership
   (Technical Services) are not agreed; the adapter seam is exercised
   against the fixture fake only.
4. **Live database** — R2 stores are in-memory domain stores over frozen
   fixtures; PostgreSQL/PostGIS behaviors need the disposable database
   environment (static gate executed).
5. **Staging load profile (T-12)** — the 10,000-feature / 100-session
   performance evidence requires staging.
6. **Owner ratifications** — the finalize/reopen authority rule, supplier
   numeric ranges/reviewer split and rating-curve coefficients are pending
   owner sign-off (OBS-3); not executable evidence in any environment.

## 6. Determinism

The reproducer was executed twice end to end on 2026-10-21
(`node tests/qualification-r2/run-r2-qualification.mjs`, exit 0 both times).
Group results, per-step outcomes, citations and BLOCKED records are
byte-identical between the runs (verified by diff of the normalized logs;
only timestamps and durations differ). All adversarial corpora are seeded
(mulberry32 with fixed constants) and every suite under test is pure with an
injected clock — there is no ambient randomness or clock dependence in the
executed surface.

## 7. Verdict

**R2 GATE: PASS — machine-checkable R2 acceptance (offline sync exactly-once
evidence, snapshot immutability across domains, supplier isolation, trends
reconciliation, extension boundaries, full regression) holds on fixture
evidence with the environment/owner-gated items recorded BLOCKED; two
defects filed (DEFECT-R2-1 Medium, DEFECT-R2-2 Low), both pinned by tests
and left for their owning tasks to fix — neither blocks the R2 acceptance
row, and the verdict is conditioned on the pending owner ratifications
(OBS-3) and the BLOCKED live-environment evidence remaining on the record.**

— qa_accessibility, WD-026, 2026-10-21
