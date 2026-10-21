# asset-transfers (WD-012-R2, FR-048)

Asset inventory and transfers for the Utah Water Measurement Data
Dashboard: equipment records with make / model / identifier / serial
evidence and photo references; a dated transfer flow that closes the old
site association and opens a new one; an association-history view that
shows where an asset was, when, and that visits never moved with it.

## Files

| File | Role |
| --- | --- |
| `transferModel.ts` | Pure, dependency-free models: the association-timeline math (half-open periods, boundary ownership), the FR-048 visits-stay-at-their-site projection, transfer-form validation mirroring the server's checks (evidence match, open-association match, in-scope destination, forward dating), submit-body composition, and the deterministic demo seed. No React, no clock reads. |
| `transferModel.test.ts` | `node:test` suite: boundary semantics, integrity projection, the full validation matrix (one case per server rule), body composition, determinism. Runs in the package-wide glob. |
| `AssetTransferPanel.tsx` | The FR-048 UI: equipment list with evidence fields, transfer form (from-site locked to the current association, to-site picker within the shell-computed scope, dated boundary, on-site identifier/serial confirmation), association-period history plus the current site's visits; loading / empty / error-with-retry / denied states; accessible tables (caption, scoped headers), labelled fields and fieldset grouping. Data via props (deterministic demo seed by default); submission is an injected port. |
| `index.ts` | Public exports plus the `assetTransfersMount` descriptor. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/asset-transfers/transferModel.test.ts
```

The suite is also picked up by the package-wide
`pnpm --filter @utah-water/web test` glob (`src/features/**/*.test.ts`).

## Mirror contract

`transferModel.ts` mirrors `services/api/src/workflows/sync/transfers.ts`:
the half-open association semantics, the boundary-instant rule and the
validation verdicts produce the same outcomes on the same inputs. The
authoritative domain (policy checks on both sites, evidence matching, the
append-only association timeline, transfer audit) lives server-side; the
browser preview authorizes nothing - the shell computes the in-scope site
list from the policy engine's verdict and passes it in.

## Pending shell wiring (one line, next slice)

WD-012-R2 must not edit `apps/web/src/shell/App.tsx`. Once the operations
workspace accepts features:

```tsx
import { assetTransfersMount } from '../../features/asset-transfers';
// register(assetTransfersMount)   — id 'asset-transfers', mountPath 'operations/asset-transfers'
```

## Requirement traceability

- **FR-048** — asset inventory and transfers: evidence fields preserved;
  transfer closes the old association and opens a dated new one; historical
  inspections and visits remain attached to the site where they occurred.
- **NFR-007** — data correctness: association periods are explicit, dated
  and never ambiguous (explicit ISO 8601 offsets; boundary instants belong
  to the new association).
