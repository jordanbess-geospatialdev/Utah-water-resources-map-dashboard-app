# data-entry (WD-010, FR-020 / FR-021)

Manual measurement entry and staged bulk paste import for the Utah Water
Measurement Data Dashboard, plus the site-setup domain on the API side
(FR-023 / FR-031 / FR-033 / FR-034 in `services/api/src/workflows/sites`).

## Files

| File | Role |
| --- | --- |
| `entryModel.ts` | Pure paste-text -> staged-preview model (delimiter detection, header alias mapping, locale date formats, explicit offsets, America/Denver DST conversion, per-cell errors, duplicates within batch and against fixture rows) plus the manual-entry form and bulk-flow state machines. **Mirror of the server parser** - see below. |
| `entryModel.test.ts` | Mirror-parity suite (loads the REAL server parser at runtime outside the tsc program and asserts byte-identical verdicts, including the generated 366-row golden batch: 363 accepted / 3 rejected / exact cell errors), manual form matrix (offending field identified, valid inputs preserved, record id returned, duplicate notice), bulk flow guard rails (validate before commit, atomic refusal returns to the review table, mode choice persists). |
| `ManualEntryForm.tsx` | FR-020 form, mobile-first at 360px: stream, local date/time, explicit UTC offset picker, value, unit picker from the governed vocabulary, note. Field-level errors as icon + text next to the offending input; the reducer never clears values; success shows the saved record identifier; a duplicate says the original record was returned and no duplicate row was created. Submit path is an injected port (default: fixture demo). |
| `BulkPastePanel.tsx` | FR-021 staged import: paste area + CSV/TSV upload, automatic mapping with delimiter/unknown-header report, validate -> review table -> explicit commit. Per-cell error highlighting uses icon + text (never color alone); duplicates are marked with the ⧉ glyph and an explanation (against batch or against the system); atomic vs documented-partial mode radio with the semantics spelled out; after commit, a notice that re-submitting the same paste reports duplicates rather than creating them. |
| `index.ts` | Public exports plus the `dataEntryMount` descriptor. |

## The mirror contract (preview == server validate stage)

`entryModel.ts` mirrors `services/api/src/workflows/readings/pasteFormat.ts`
and the parse half of `.../bulkImport.ts` function-for-function. The web
tsc program cannot import the API sources (orchestrator-owned tsconfig, no
`allowImportingTsExtensions` - the same constraint documented in
`features/operations/README.md`), so the mirror is maintained by parity
tests: `entryModel.test.ts` dynamically imports the real server modules at
runtime and asserts identical verdicts on the golden batch, DST-transition
days, duplicates, station/TSV pastes, unit mismatches and batch-level
errors. **A parity failure is a defect in the mirror** - fix it here, not
in the tests.

Deliberate limits of the browser preview, stated in the UI: it performs no
authorization (the server's validate stage adds per-row
`ROW_OUT_OF_SCOPE` / `ROW_LIFECYCLE_CLOSED` verdicts via the policy
engine) and it only knows fixture observations for duplicate detection;
rows entered since page load are re-checked server-side at validate AND
again at commit.

## Running the tests

```bash
cd apps/web
node --test --experimental-strip-types src/features/data-entry/entryModel.test.ts
```

(The repo-wide `pnpm --filter @utah-water/web test` glob picks this up via
`src/features/**/*.test.ts`.)

## Pending shell wiring (persona_ui's next slice)

WD-010 may not edit `apps/web/src/shell/App.tsx`. The single pending block:

```tsx
import { BulkPastePanel, dataEntryMount, ManualEntryForm } from '../../features/data-entry';
// register(dataEntryMount)  —  id 'data-entry', mountPath 'data-entry'

<ManualEntryForm streamIds={assignedStreamIds} />
<BulkPastePanel streamIds={assignedStreamIds} />
```

The submit/validate/commit ports are injectable (`onSubmit`, `onValidate`,
`onCommit`); the shell wires them to `POST /streams/{id}/observations`,
`POST /imports`, `POST /imports/{id}/validate` and `POST
/imports/{id}/commit` when the HTTP layer lands. Until then the demo ports
run the same pure model locally.

## Requirement traceability

- **FR-020** - manual measurement entry: field-level validation identifying
  the offending field, valid inputs preserved, explicit offset, unit from
  the governed vocabulary, saved record identifier returned, duplicates
  return the existing record.
- **FR-021** - large batch paste and import: at least a full 366-day year
  of daily rows, preview mapping and row errors, documented atomic or
  partial mode, retry without creating duplicate readings.
- API-side companions: `services/api/src/workflows/readings` (staged batch
  model, per-cell errors, scope re-verification, idempotent replay) and
  `services/api/src/workflows/sites` (FR-023/031/033/034 site setup,
  effective-dated setups, versioned thresholds).
