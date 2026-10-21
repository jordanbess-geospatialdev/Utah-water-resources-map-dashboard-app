# offline (WD-012-R2, FR-027)

The offline outbox for the Utah Water Measurement Data Dashboard:
airplane-mode drafts of readings, visits and categorized photo/audio
attachments persist across reloads through a scoped store, and
synchronize exactly once after reconnection. The server half lives in
`services/api/src/workflows/sync` (accept.ts); the field-actor half of
asset transfers lives in `apps/web/src/features/asset-transfers`.

## Files

| File | Role |
| --- | --- |
| `store.ts` | The `OfflineStore` interface (persist / load / clear-by-account), the envelope schema (draft UUID, actor, site, device timestamp + zone, capture time, base revision, attachment manifests, state queued/syncing/accepted/conflict/rejected), the in-memory fake every test uses (JSON round-trip on each persist/load, so serialization fidelity is proven), and the documented IndexedDB adapter skeleton (browser-only, never executed in tests). |
| `outbox.ts` | The outbox engine: `enqueueDraft` (validated against the base revision the device has actually seen; client-side quota with visible retry guidance), the transition reducer, `syncOnReconnect` (crash recovery of interrupted `syncing` drafts with the SAME idempotency key, grant gate that blocks revoked/expired drafts before upload, per-draft verdict application, persistence of every transition), `retryDraft` (explicit retry without background sync), `resolveConflict` (the only, explicit, path out of `conflict`) and status view helpers. |
| `cleanup.ts` | Sign-out / account-switch clearance: `signOut`, `switchAccount` (clear-before-load), the one-line policy string and `hasAccountResidue` verification. |
| `store.test.ts` / `outbox.test.ts` / `cleanup.test.ts` | `node:test` suites: reload survival, exactly-once (double-send and commit-before-ack crash replay), conflict preservation, revoked/expired rejection without upload, quota, no-residue account cleanup, determinism. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/offline/store.test.ts src/offline/outbox.test.ts src/offline/cleanup.test.ts
```

NOTE (deviation, by design of the frozen scope): the package-wide
`pnpm --filter @utah-water/web test` glob covers `tests/`,
`src/features/**` and `src/map/**` only; `apps/web/package.json` is
outside this task's write scopes, so the offline suite above is run
explicitly (it is the evidence file named in the task's commit trailer:
`apps/web/src/offline/outbox.test.ts`). A chore slice extending the glob
to `src/offline/**` will fold these into the package suite unchanged.

## Verdict mirror contract

`SyncVerdict` in outbox.ts mirrors the verdict union of
`services/api/src/workflows/sync/accept.ts` (accepted / conflict /
rejected / quota, with typed rejection codes). The server owns every
decision; the client mirror exists so the offline engine can be tested
without HTTP. The sync workflow's own tests (in
`services/api/src/workflows/sync/test/`) drive the REAL server domain
against the REAL readings/visits workflows and load these client modules
at runtime for the end-to-end exactly-once scenarios.

## Requirement traceability

- **FR-027** — offline field capture and synchronization: airplane-mode
  drafts survive reload; each draft syncs once after reconnect; conflicts
  and revoked access are routed for resolution without silent loss.
- **Technical specification, "Offline, imports, notifications and AI"** —
  scoped queue with the prescribed envelope fields; five draft states;
  identity/assignment revalidated at sync; revoked drafts never upload; no
  silent conflict resolution; sensitive data cleared per policy on logout
  and account switch; explicit retry works without background sync.
