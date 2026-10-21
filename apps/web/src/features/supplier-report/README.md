# supplier-report (WD-017, FR-053..FR-057)

Water supplier annual reporting UI for the Utah Water Measurement Data
Dashboard (R2 Water Use Program reporting): the assigned organization's
system view with historical discharge, the seven FR-055 category sections
with inline TEXT validation plus an accessible summary panel, the file
import preview, the submit flow with the frozen submitted view, and boundary
proposals with section comments.

| File | Role |
| --- | --- |
| `reportModel.ts` | Pure view/validation models: supplier scope resolution over the fixture owner organizations (Wiley demo synthesis + a second org so isolation is demonstrable), the category rule tables, `validateSections`/`buildErrorSummary` (same severities, codes and message shapes as the API), the import mirror (`parseImportText`, `previewImportRows` with the documented unit factors, `applyPreviewToSections` upsert), the historical discharge mirror (rectangle-right for the owner streams; null = no covered data, never zero), the demo submission freeze (`freezeDemoSubmission`: FNV-style demo digest + PDF manifest text model carrying the content hash verbatim), the resubmission state-machine helper and the boundary proposal/approval mirror. |
| `reportModel.test.ts` | `node:test` suite: scope anchors, validation matrix (missing text messages, unreasonable warnings with rationale, zero-vs-missing, period membership), import mapping/idempotent upsert, the historical golden 26978/121 acre-feet (same constant as the API suite), demo freeze determinism + hash sensitivity + warning annex, resubmission gating, boundary proposal validation and v2 approval derivation. |
| `SupplierReportPanel.tsx` | The panel: FR-053 assigned system view (sources, historical discharge table with "No covered data", inventory snapshot, submitted history), FR-055 category form sections with per-field inline text (`Error:`/`Warning:` prefixes, `aria-describedby`) and a `role="alert"` summary panel with numbered lines (never color alone), FR-056 import (documented row format, unit/period preview table, invalid rows, retry-idempotent apply by import id), FR-057 submit (confirmation step, frozen submitted view showing version/submitter/timestamp/content hash + manifest blocks, reviewer resubmission demo transition), FR-054 boundary UI (approved boundary, per-section proposal with reason, section comments, explicit reviewer-only approval note). Reviewer accounts and fixture principals get typed empty states. |
| `index.ts` | Public exports plus the `supplierReportMount` descriptor. |

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/supplier-report/reportModel.test.ts
```

(The package glob `src/features/**/*.test.ts` picks this suite up.)

## Data source and demo generation

Fixtures come from the WD-006 shell loaders (`../../shell/data/fixtures`,
read-only reuse). Until the HTTP service lands, validation, imports, the
submission freeze and the boundary model run the deterministic LOCAL mirrors
of `services/api/src/workflows/supplier-report/**`; the historical discharge
numbers are pinned by test to the same golden as the API suite
(str-hyrum-q-owner CY-2026 = 26978/121 acre-feet), and the panel says so in
the UI. The server remains authoritative: the real endpoint re-evaluates the
entitlement engine (organization-scoped `supplier-reporting` assignments)
and revalidates server-side.

The demo content hash is a deterministic FNV-style digest of the same
canonical preimage, NOT the server's sha256; the frozen view labels it as
the demo surface.

## Pending shell wiring (one line; shell is out of WD-017's write scope)

```tsx
import { supplierReportMount } from '../../features/supplier-report';
// register(supplierReportMount)  —  id 'supplier-report', mountPath 'water-user/supplier-report'
```

or rendered directly:

```tsx
import { SupplierReportPanel } from '../../features/supplier-report';
<SupplierReportPanel actorId="demo-wiley-cache-water" />
```

## R2 notes (documented, not implemented)

- **PDF transport**: rendering/serving PDF bytes is the export pipeline's
  concern; the frozen view shows the manifest CONTENT MODEL (with the
  content-hash proof) and says so. The API ships a throwing stub
  (`services/api/src/workflows/supplier-report/pdf.ts`).
- **Reviewer console**: the Water Use Manager dashboard is future work
  (S1 PDF pp. 21-22). The panel's "Reviewer approves resubmission" and
  "Approve (distinct reviewer transition)" buttons are labeled demo
  transitions; server-side both are denied to supplier accounts
  (`REVIEWER_REQUIRED`) and granted only to the organization's reviewer
  role family.
- **Range heuristics**: every plausible-range warning shown here mirrors the
  API's documented, owner-ratifiable rule tables.

## Requirement traceability

- **FR-053** — assigned supplier system view with sources and historical
  discharge; only the acting organization's system exists for the account.
- **FR-054** — boundary proposals with section comments; approval is a
  distinct reviewer transition and never replaces the approved boundary
  before it.
- **FR-055** — culinary/source/purchase/wholesale/returns inventories, peak
  demand and secondary use; field-level text messages plus an accessible
  error summary in addition to color.
- **FR-056** — manual entry and file import populate the same validated
  model; preview maps units/periods; retrying a file creates no duplicates.
- **FR-057** — submit records submitter and version, freezes the content
  (hash visible), and resubmission follows the approved state machine.
