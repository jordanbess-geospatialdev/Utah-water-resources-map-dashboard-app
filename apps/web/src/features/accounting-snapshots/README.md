# accounting-snapshots (WD-025-R2, FR-028/FR-029/FR-030)

Decision-evidence view, authority-aware finalize flow, finalized-record
chain view and flexible period builder for distribution accounting, plus the
advisory supplemental context.

| File | Role |
| --- | --- |
| `snapshotModel.ts` | Pure view models: flexible period math (governed kinds mirror the WD-025 date rules; custom windows carry explicit half-open instants, so mid-month boundaries resolve exactly, with local-day and DST facts), decision-evidence builder pinning exact revision ids and curve lineage over the fixture chains, the finalize-authority mirror (review-data: steward or granted reviewer - PENDING OWNER RATIFICATION), the demo finalize ledger (optimistic-concurrency typed conflict, idempotent replay, supersession that never rewrites prior records), supersession-chain/linkage/banner helpers, and the advisory supplemental mirror with the mandatory label. |
| `snapshotModel.test.ts` | `node:test` suite: governed + custom windows (incl. the March-15 water year and 400-day guard), evidence pinning (obs-q-032 -> rev-corinne-2004 at best-available), determinism, the authority mirror (Diego statewide; Cody Bear only; Ana via delegation window; later expiry), the demo ledger (401/403 denials, FINALIZE_CONFLICT naming the winner, supersession chain with prior-hash stability, guards), and approved-inputs-only supplemental rows with the advisory label. |
| `AccountingSnapshotsPanel.tsx` | The panel: flexible period builder with visible boundary rules (half-open [start, end), DST facts, Mar-15 preset), decision evidence table (exact observation/revision ids, chain versions, pinned values, curve lineage, evidence hash), finalize flow with authority-aware controls (disabled with the denial reason when the actor lacks review-data; typed conflict rendered in an aria-live region), supersede form with retained reason, finalized-record chain view (hash, actor, timestamp, superseded banner with explicit linkage, text+shape state badges), and the advisory supplemental table (approved inputs only; label always present). States: loading/ready/error; accessible tables with caption/scope. |
| `index.ts` | Public exports plus the `accountingSnapshotsMount` descriptor. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/accounting-snapshots/snapshotModel.test.ts
```

(The package glob `src/features/**/*.test.ts` picks this suite up.)

## Data source and demo ledger

Fixtures come from the WD-006 shell loaders (`../../shell/data/fixtures`,
read-only reuse). Until the HTTP service lands, the panel runs the
deterministic LOCAL mirror (`buildDecisionSnapshotDemo`, `DemoFinalizeLedger`)
of the server workflow (`services/api/src/workflows/accounting-snapshots`);
the API suite pins the real goldens, and the UI labels its hashes as demo
digests (FNV-style, not the server's sha256). The server re-evaluates the
entitlement engine and re-aggregates server-side on every real request.

## Pending shell wiring (one line; shell is out of WD-025-R2's write scope)

```tsx
import { accountingSnapshotsMount } from '../../features/accounting-snapshots';
// register(accountingSnapshotsMount)  —  id 'accounting-snapshots', mountPath 'operations/accounting-snapshots'
```

or rendered directly:

```tsx
import { AccountingSnapshotsPanel } from '../../features/accounting-snapshots';
<AccountingSnapshotsPanel actorId={session.principalId} />
```

## Authority note (approval-gated)

Finalize/reopen authority mirrors the API rule: `review-data` on the system
object (the statewide steward via `statewide-administration`, or an
explicitly granted reviewer, including a deputy inside her delegation
window). The mapping onto the proposed authorization matrix is pending
owner ratification; the UI shows the rule wherever finalize controls appear.
