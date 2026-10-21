# supplier-report (WD-017, FR-053..FR-057)

Water supplier draft reporting, validation, submission and PDF manifest for
the Utah Water Measurement Data Dashboard (R2 Water Use Program reporting).
Organization-scoped through the shared entitlement engine, deterministic,
pure TypeScript (no I/O, injected clock everywhere).

## Files

| File | Role |
| --- | --- |
| `types.ts` | Domain types: `SupplierReportDraft` (org, system, period, the seven FR-055 category sections with typed fields incl. inventories and peak demand), `ValidationIssue` (field path + TEXT message + severity) and `ValidationSummary` (accessible, numbered lines - never color alone), import vocabulary (`ImportFileRow`, `ImportPreview`), `SubmittedReport` (submitter, submittedAt, version, frozen content + `contentHash`, PDF manifest reference), the FR-057 resubmission state machine types, `BoundaryProposal` / `ApprovedBoundary` and the FR-053 `SupplierSystemView`. |
| `world.ts` | Fixture supplier world: the two water-owner organizations from `principals.json` anchored to their systems via station ownership (org-cache-water -> sys-bear-river, org-bear-river-users -> sys-weber-river), owner-anchored system policy objects, and the deriving `withSupplierActor` helper (the established extra-principal/`withEntitlement` test pattern - the policy package is never edited). Supplies the standard synthetic actors: Wiley + Morgan (suppliers) and one Water Use reviewer per organization. |
| `scope.ts` | The supplier grant gate: action `supplier-reporting` on the owner-anchored system object through the shared entitlement engine (organization scopes resolve via `ownerOrganizationId`). Denial mapping mirrors `series/grantCheck.ts` / WD-025 (401 identity, 404 unknown/hidden object, 403 otherwise). `checkReviewerScope` narrows the SAME grant to role family `owner` for the distinct approval transitions. Notably `statewide-administration` does NOT satisfy `supplier-reporting`: the data steward is outside this workflow by design (Water Use Manager is a separate future owner). |
| `validate.ts` | FR-055 category validation: documented, owner-ratifiable rule tables (`FIELD_RULES`, `ENTRY_RULES`) with required-field decisions, plausible-range heuristics and rationales. Missing required -> error; structurally invalid (negative, non-integer, zero-where-impossible, percent > 100, date outside the period) -> error; implausible-but-possible -> UNREASONABLE_VALUE warning. Zero is a value, not missing (NFR-007). `buildErrorSummary` renders the accessible text summary (headline + numbered lines). |
| `report.ts` | `SupplierReportStore` + draft CRUD (`createDraft` resolves the org from the assignment, never the request; one open draft per key, idempotent open), manual `updateSection`, the FR-056 import path (`previewImport` maps units via documented factors - ac-ft/MG -> gallons - and periods, flags invalid rows with text reasons; `applyImport` is idempotent by importId: a retried file replays the original result and never duplicates values), `submit` (validate-all -> freeze with sha256 `contentHash` -> deterministic PDF manifest reference; idempotent by submission id and by draft state; SUBMISSION_LOCKED until `approveResubmission`), `approveResubmission` (reviewer-only state transition; content hash unchanged), org-isolated listings, and the FR-053 `systemView` (sources, purchases/wholesale/returns snapshot, historical discharge via the WD-008 aggregation domain - null = unavailable, never zero - and this org's submitted history). |
| `pdf.ts` | Deterministic PDF MANIFEST model (WD-025 finalize discipline): canonical key-sorted serialization, ordered content blocks covering every category value with status text (`reported`/`missing`/`warning`), acknowledged-warnings annex, boundary note, a data layout spec (Letter, margins, fonts, table columns) and `manifestHash`. "The PDF matches the submitted version" is proven by `submittedContentHash === submission.contentHash` (tested). `renderPdfTransport` throws: rendering bytes is the export pipeline's transport concern. |
| `boundaries.ts` | FR-054: `SupplierBoundaryStore` (approved boundary versions, immutable, v1 fixture bootstrap) + proposals with per-section changes, change reasons and append-only section comments (role-labeled). Proposing/commenting NEVER mutates the approved boundary; `decideBoundaryProposal` is the DISTINCT reviewer-only transition that derives boundary version N+1 (v N stays queryable); rejection never touches the boundary. |
| `test/scope.test.ts` | Organization isolation BOTH directions (Wiley: Bear allowed / Weber hidden 404; Morgan: Weber allowed / Bear hidden 404), no fixture principal holds the capability (steward/`statewide-administration`, commissioner, engineer, researcher all 403), anonymous 401, reviewer-vs-supplier gates, revocation. |
| `test/validation.test.ts` | The FR-055 matrix: every category's required fields on an empty draft, field-level TEXT messages with unit, unreasonable-value warnings with rationale, structural errors, zero-vs-missing, indexed inventory entry paths, period membership per basis, conditional secondary-use requirement, accessible summary object. |
| `test/import.test.ts` | Preview unit/period mapping (ac-ft, MG, gal, persons, date), invalid-row text reasons, same-validated-model application, new-entry completion flags, retry idempotency by importId (no duplicate values/entries), distinct import ids re-apply, org isolation, not-applicable previews. |
| `test/report.test.ts` | The task evidence suite: org isolation of CRUD/lists both directions, validate-all submit gate with attached summary, idempotent retries returning the ORIGINAL record, frozen drafts, the approved resubmission state machine (v1 -> reviewer approval, contentHash unchanged -> v2 superseding), attribution + contentHash stability, PDF manifest equality + byte stability, transport stub throws, the FR-053 system view (historical discharge null-vs-data, history visible only to the owning org), acknowledged warnings. |
| `test/boundaries.test.ts` | Proposal/comment never mutate the approved boundary (byte-identical), section comments (append-only, role-labeled, section-checked), approval as a distinct reviewer transition (v2 derived, v1 immutable, supplier cannot self-approve, thread closes), rejection leaves the boundary untouched, cross-supplier isolation, 422s for unknown sections/empty proposals. |
| `test/determinism.test.ts` | The full journey (draft -> v1 -> resubmission approved -> corrected v2 + boundary approval) runs twice from scratch: byte-identical canonical serializations, hashes, manifests and boundary records; timestamps echo the injected clocks verbatim. |

## Running the tests

```bash
cd services/api
node --test --experimental-strip-types "src/workflows/supplier-report/test/*.test.ts"
```

(The package glob `src/**/*.test.ts` picks these suites up.)

## Design contracts

- ORGANIZATION IS THE SCOPE (FR-053): suppliers are organization-scoped
  assignments; the other supplier's system/draft/proposal/submission is a
  hidden 404, tested in both directions. The proposing organization is
  resolved from the actor's assignment, never from a request body (FR-010).
- ONE VALIDATED MODEL (FR-056): manual entry and file import write the same
  sections and run the same validator; imports only convert units/periods
  first. Retries are idempotent by importId and by submissionId.
- APPROVED STATE MACHINE (FR-057): draft -> submitted -> resubmission-approved
  (reviewer). Submitted content is frozen with a contentHash that excludes
  only bookkeeping (submissionId, pdf reference, resubmission fields), so
  approvals never change content identity. A new version exists only through
  the approved resubmission path.
- SEPARATE OWNER: boundary approval, resubmission approval and the range
  heuristics are Water Use Program decisions. Role family `owner` marks the
  reviewer side of the SAME organization-scoped grant (the engine narrows by
  role exactly like the deputy pattern); every numeric range carries its
  rationale and is pending owner ratification.
- DETERMINISM: injected clock, deterministic ids, canonical key-sorted
  serialization for every hash; identical inputs -> byte-identical objects.

## R2 boundaries (documented, NOT implemented)

- PDF TRANSPORT: rendering/serving PDF bytes is the export pipeline's
  concern; `renderPdfTransport` throws and the manifest is the full content
  contract a transport renderer must follow.
- BOUNDARY GEOMETRY / AUTHORIZED FILE: this module versions the boundary
  SUMMARY record; the geometry contract and the authorized-file download
  format await the Water Use owner (PRD open decision).
- REVIEWER CONSOLE: the Water Use Manager dashboard is future work (S1 PDF
  pp. 21-22); only the approval TRANSITIONS are modeled here.

## Requirement traceability

- **FR-053** — assigned supplier system view: sources, purchases, wholesale,
  returns, historical discharge comparisons; cross-supplier isolation.
- **FR-054** — boundary proposals with section comments; approval as a
  distinct transition; the approved boundary is never replaced by a proposal.
- **FR-055** — the seven reporting categories; missing/unreasonable values
  produce field-level text messages and an accessible error summary.
- **FR-056** — manual entry and file import share one validated model;
  previews map units/periods; retries create no duplicates.
- **FR-057** — draft->submitted with submitter and version; PDF matches the
  submitted version (contentHash equality); resubmission follows the
  approved state machine.
- **FR-010/FR-011** — server-enforced organization scope; revocation checked
  against the injected clock.
