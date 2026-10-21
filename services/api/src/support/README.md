# support (WD-020) - support context, feedback and consented analytics

Implements FR-018 (support and defect context with reproducible state links),
FR-068's feedback capture, and the FR-017 consent gate for the PROPOSED
first-party analytics (the technical specification requires "a privacy
decision before session-replay analytics"; this module gates ALL analytics,
session replay included, behind explicit per-account consent).

## Files

| File | Role |
| --- | --- |
| `supportContext.ts` | Builds the support/defect context bundle from the current view state: the versioned share query (a mirror of the WD-007 codec semantics in `apps/web/src/features/discovery/shareUrl.ts` - filters/extent/selected site ONLY; persona, credentials and internal notes are typed-but-never-read), app version, timestamp, and a redaction pass asserting the serialized bundle carries no secret-shaped string and no restricted identifier. Restricted selections degrade to omitted-with-notice in the link (hostile-state tested). `decodeSupportShare` closes the loop for the steward. |
| `feedback.ts` | The FR-018 feedback record model (category, bounded description, screenshot METADATA reference, redaction-verified support context, optional submitter) with validation (caps, closed enums, empty URL host allowlist, secret-shaped text rejected at the door) and the steward queue view model with priority assignment (P1-P4, rank-then-recency). Fixture-backed: the two FR-018 example records seed through the same validation path as live submissions. |
| `analytics.ts` | The FR-017 OPT-IN consent gate: per-account persisted consent versioned against the privacy proposal it answered; a STATIC event field allowlist (page-view, task-completed) that structurally excludes credentials, query values (dimension KEYS only), internal records, screenshots and free text; withdrawal stops collection immediately and deletes pending events; retention windows implement the PROPOSED 90-day raw / 13-month aggregate policy (PENDING owner decision, docs/training/PRIVACY-PROPOSAL.md). |
| `test/supportContext.test.ts` | WD-007 byte-format pin, decode round trips, hostile view state (persona + credential + internal note + restricted selection + free text + enum + cardinality attacks) degrading to clean omitted-with-notice links, secret-shape scanner coverage, length cap, determinism twice. |
| `test/feedback.test.ts` | Validation caps and exclusions, redaction-failed contexts rejected, steward priority/status transitions and ordering, secret-free queue, determinism twice. |
| `test/analytics.test.ts` | Consent gate off/on/withdrawal (with deletion), per-account and per-policy-version consent persistence, hostile field/shape attacks dropped whole, retention purges, program-zone day keys, determinism twice. |

## Run

```bash
cd services/api
node --test --experimental-strip-types src/support/test/supportContext.test.ts \
  src/support/test/feedback.test.ts src/support/test/analytics.test.ts
```

(The repo-wide `pnpm --filter @utah-water/api test` glob picks these up via
`src/**/*.test.ts`.)

## Rules pinned by tests

1. A support link carries filters, extent and one public selected site ONLY -
   never persona, credentials, internal notes or restricted identifiers; a
   restricted selection is omitted-with-notice, never a leak (FR-008/FR-018).
2. Every bundle is redaction-verified before it exists: the serialized bundle
   must contain no secret-shaped string and no restricted id, or the link is
   emptied with a notice.
3. Feedback never embeds secrets: validation rejects free-form URLs (empty
   allowlist by policy) and secret-shaped text; the steward queue re-scans on
   read (defense in depth).
4. No analytics event exists without explicit, current-policy, per-account
   consent; withdrawal deletes pending events immediately (FR-017).
5. Analytics events are structurally incapable of carrying credentials, query
   values, internal records or screenshots: the static allowlist admits no
   field of those shapes.

## Pending wiring (later tasks)

- The Fastify routes for feedback submit/steward queue and the consent
  endpoints are a later integration task; this module is the pure domain.
- The web-side consent persistence model lives in
  `apps/web/src/features/help/consent.ts` (browser localStorage mirror of the
  same versioned decision record).
