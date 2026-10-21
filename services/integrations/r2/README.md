# R2 integrations (WD-023-R2)

The three ratified R2 extension domains (see
`docs/extensions/r2/R2-EXTENSIONS-SCOPE.md`, the orchestrator-ratified
bounded contracts):

| Path | Requirement | What it is |
| --- | --- | --- |
| `asof/` | FR-044 | Recorded-time as-of reconstruction over the WD-011 revision store: closed lower boundary ON T, later revisions excluded and counted, `asOfBasis` blocks, byte-stable exports that reproduce after later corrections, policy-engine authorization evaluated as of T. |
| `voice/` | FR-047 | Voice-note draft model + review-required state machine over a deterministic, offline provider stub. No network code may exist before the NFR-010 privacy review approves a provider (statically scanned). |
| `wcat/` | FR-051 | WCAT adapter seam (sync / dry-run / replay) with provenance-enforced typed exchanges and a fixture fake. Zero transport; every operation has a documented manual fallback (`docs/extensions/r2/WCAT-MANUAL-FALLBACK.md`). |

Hard boundaries:

- **No network anywhere** — enforced by the static scan test in
  `voice/test/voice.test.ts` over this tree and the
  `apps/web/src/features/r2-extensions` feature.
- **Read-only over the API's stores** — `asof/` imports the revision store
  types and the fixture-backed store as a structural source; nothing in
  this tree mutates them outside that store's own transactional API.
- **Stub/seam only** — voice provider selection and the WCAT external
  contract are blocked on owners; the interfaces here are the seams.

## Running the suites

```bash
node --test --experimental-strip-types services/integrations/r2/asof/test/asof.test.ts
node --test --experimental-strip-types services/integrations/r2/voice/test/voice.test.ts
node --test --experimental-strip-types services/integrations/r2/wcat/test/wcat.test.ts
# or all at once from this directory: npm test (see package.json)
```

This directory is not a pnpm workspace member (`services/*` matches one
level); the suites run directly under `node --test` like the api workflows.
