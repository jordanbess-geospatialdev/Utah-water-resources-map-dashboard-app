/**
 * Import tests (WD-017; FR-056; T-06): manual entry and file import
 * populate the SAME validated model; the preview displays mapped units and
 * periods and identifies invalid rows; a retried file never duplicates
 * values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SupplierReportStore, applyImport, createDraft, previewImport, updateSection } from '../report.ts';
import type { ImportFileRow } from '../types.ts';
import { BEAR, NOW, supplierDeps, validSections } from './helpers.ts';
import { STANDARD_ACTORS } from '../world.ts';

const WILEY = STANDARD_ACTORS.WILEY;
const MORGAN = STANDARD_ACTORS.MORGAN;
const DEPS = supplierDeps(NOW);
const CY2026 = { basis: 'calendar-year', year: 2026 } as const;

const FILE_ROWS: readonly ImportFileRow[] = [
  { rowIndex: 1, category: 'source-inventory', field: 'annualWithdrawalGallons', entryKey: 'W-1', rawValue: '3,700', rawUnit: 'ac-ft' },
  { rowIndex: 2, category: 'purchase-inventory', field: 'annualPurchasedGallons', entryKey: 'Regional Water Conservancy District', rawValue: '250', rawUnit: 'MG' },
  { rowIndex: 3, category: 'culinary-use', field: 'populationServed', entryKey: null, rawValue: '52,400', rawUnit: 'persons' },
  { rowIndex: 4, category: 'culinary-use', field: 'annualCulinaryVolumeGallons', entryKey: null, rawValue: '1,900,000,000', rawUnit: 'gal' },
  { rowIndex: 5, category: 'source-peak-demand', field: 'peakDayDate', entryKey: null, rawValue: '2026-07-14', rawUnit: 'date' },
];

function openDraftWithBaseline() {
  const store = new SupplierReportStore();
  const draft = createDraft(DEPS, store, { systemId: BEAR, period: CY2026 }, WILEY);
  assert.equal(draft.outcome, 'allowed');
  const base = validSections();
  updateSection(DEPS, store, draft.value.draftId, { category: 'culinary-use', section: base.culinaryUse }, WILEY);
  updateSection(DEPS, store, draft.value.draftId, { category: 'source-inventory', section: base.sourceInventory }, WILEY);
  updateSection(DEPS, store, draft.value.draftId, { category: 'purchase-inventory', section: base.purchaseInventory }, WILEY);
  updateSection(DEPS, store, draft.value.draftId, { category: 'wholesale-inventory', section: base.wholesaleInventory }, WILEY);
  updateSection(DEPS, store, draft.value.draftId, { category: 'return-inventory', section: base.returnInventory }, WILEY);
  updateSection(DEPS, store, draft.value.draftId, { category: 'source-peak-demand', section: base.sourcePeakDemand }, WILEY);
  updateSection(DEPS, store, draft.value.draftId, { category: 'secondary-use', section: base.secondaryUse }, WILEY);
  return { store, draftId: draft.value.draftId };
}

test('the preview maps units (acre-feet, MG, gallons) to the canonical gallons field', () => {
  const { store, draftId } = openDraftWithBaseline();
  const preview = previewImport(DEPS, store, draftId, { importId: 'imp-1', filePeriod: CY2026, rows: FILE_ROWS }, WILEY);
  assert.equal(preview.outcome, 'allowed');
  if (preview.outcome !== 'allowed') return;

  const byRow = new Map(preview.value.mappings.map((mapping) => [mapping.rowIndex, mapping]));
  const acreFeet = byRow.get(1)!;
  assert.equal(acreFeet.mappedUnit, 'gallons');
  assert.ok(Math.abs((acreFeet.mappedValue as number) - 3_700 * 325_851.428571) < 0.001);
  assert.match(acreFeet.note, /3,700 ac-ft x 325851\.428571/);

  const mg = byRow.get(2)!;
  assert.equal(mg.mappedValue, 250_000_000);
  assert.equal(mg.mappedUnit, 'gallons');

  const persons = byRow.get(3)!;
  assert.equal(persons.mappedValue, 52_400);
  assert.equal(persons.mappedUnit, 'persons');

  const date = byRow.get(5)!;
  assert.equal(date.mappedValue, '2026-07-14');
  assert.equal(date.mappedUnit, 'YYYY-MM-DD');
});

test('the preview states the period mapping and marks a mismatched file not applicable', () => {
  const { store, draftId } = openDraftWithBaseline();
  const matching = previewImport(DEPS, store, draftId, { importId: 'imp-a', filePeriod: CY2026, rows: FILE_ROWS }, WILEY);
  assert.equal(matching.outcome, 'allowed');
  if (matching.outcome === 'allowed') {
    assert.equal(matching.value.applicable, true);
    assert.match(matching.value.periodMappingNote, /maps 1:1 to the draft period/);
  }

  const mismatched = previewImport(DEPS, store, draftId, { importId: 'imp-b', filePeriod: { basis: 'water-year', year: 2026 }, rows: FILE_ROWS }, WILEY);
  assert.equal(mismatched.outcome, 'allowed');
  if (mismatched.outcome === 'allowed') {
    assert.equal(mismatched.value.applicable, false);
    assert.match(mismatched.value.periodMappingNote, /does NOT match the draft period/);
  }
});

test('invalid rows are identified with plain-text reasons and never mapped', () => {
  const { store, draftId } = openDraftWithBaseline();
  const preview = previewImport(DEPS, store, draftId, {
    importId: 'imp-2',
    filePeriod: CY2026,
    rows: [
      { rowIndex: 1, category: 'not-a-category', field: 'x', entryKey: null, rawValue: '1', rawUnit: 'gal' },
      { rowIndex: 2, category: 'culinary-use', field: 'nope', entryKey: null, rawValue: '1', rawUnit: 'gal' },
      { rowIndex: 3, category: 'culinary-use', field: 'populationServed', entryKey: null, rawValue: 'abc', rawUnit: 'persons' },
      { rowIndex: 4, category: 'culinary-use', field: 'populationServed', entryKey: null, rawValue: '5', rawUnit: 'gal' },
      { rowIndex: 5, category: 'culinary-use', field: 'annualCulinaryVolumeGallons', entryKey: null, rawValue: '5', rawUnit: 'gpm' },
      { rowIndex: 6, category: 'culinary-use', field: 'populationServed', entryKey: null, rawValue: '7', rawUnit: 'bushels' },
    ],
  }, WILEY);
  assert.equal(preview.outcome, 'allowed');
  if (preview.outcome !== 'allowed') return;
  assert.equal(preview.value.mappings.length, 0);
  const reasons = preview.value.invalidRows.map((row) => row.reason).join('\n');
  assert.match(reasons, /unknown reporting category "not-a-category"/);
  assert.match(reasons, /unknown field "nope"/);
  assert.match(reasons, /not a number/);
  assert.match(reasons, /a volume, but field culinaryUse\.populationServed measures persons/);
  assert.match(reasons, /does not match field culinaryUse\.annualCulinaryVolumeGallons \(gal\)/);
  assert.match(reasons, /unknown unit "bushels"/);
});

test('an import populates the SAME validated model as manual entry (and revalidates)', () => {
  const { store, draftId } = openDraftWithBaseline();
  const preview = previewImport(DEPS, store, draftId, { importId: 'imp-3', filePeriod: CY2026, rows: FILE_ROWS }, WILEY);
  assert.equal(preview.outcome, 'allowed');
  const applied = applyImport(DEPS, store, preview.value, WILEY);
  assert.equal(applied.outcome, 'allowed');
  if (applied.outcome !== 'allowed') return;

  const draft = store.draftById(draftId)!;
  // Row 3/4 overwrote the manual culinary scalars through the same fields.
  assert.equal(draft.sections.culinaryUse.populationServed, 52_400);
  assert.equal(draft.sections.culinaryUse.annualCulinaryVolumeGallons, 1_900_000_000);
  // Row 1 updated the existing W-1 entry in place (no duplicate entry).
  assert.equal(draft.sections.sourceInventory.length, 2);
  assert.ok(Math.abs((draft.sections.sourceInventory[0]!.annualWithdrawalGallons ?? 0) - 3_700 * 325_851.428571) < 0.001);
  // Row 2 updated the existing purchase entry by seller name.
  assert.equal(draft.sections.purchaseInventory.length, 1);
  assert.equal(draft.sections.purchaseInventory[0]!.annualPurchasedGallons, 250_000_000);
  // The import ran the same validator as manual entry: valid baseline stays valid.
  assert.equal(draft.validation.summary.errorCount, 0);
  assert.equal(draft.imports.length, 1);
});

test('a NEW entry from an import is flagged by the same validation rules until completed manually', () => {
  const store = new SupplierReportStore();
  const draft = createDraft(DEPS, store, { systemId: BEAR, period: CY2026 }, WILEY);
  assert.equal(draft.outcome, 'allowed');
  const preview = previewImport(DEPS, store, draft.value.draftId, {
    importId: 'imp-new',
    filePeriod: CY2026,
    rows: [{ rowIndex: 1, category: 'return-inventory', field: 'annualReturnedGallons', entryKey: 'Logan River', rawValue: '1000', rawUnit: 'gal' }],
  }, WILEY);
  assert.equal(preview.outcome, 'allowed');
  const applied = applyImport(DEPS, store, preview.value, WILEY);
  assert.equal(applied.outcome, 'allowed');
  const stored = store.draftById(draft.value.draftId)!;
  assert.equal(stored.sections.returnInventory.length, 1);
  // The default sourceType/text completions are surfaced as field-level errors.
  const paths = stored.validation.issues.map((issue) => issue.fieldPath);
  assert.ok(paths.includes('returnInventory[0].returnType'));
});

test('retrying the same import id is idempotent: no duplicate values, original result replays', () => {
  const { store, draftId } = openDraftWithBaseline();
  const preview = previewImport(DEPS, store, draftId, { importId: 'imp-retry', filePeriod: CY2026, rows: FILE_ROWS }, WILEY);
  assert.equal(preview.outcome, 'allowed');

  const first = applyImport(DEPS, store, preview.value, WILEY);
  assert.equal(first.outcome, 'allowed');
  assert.equal(first.value.replayed, false);
  assert.equal(first.value.appliedRowCount, 5);
  const afterFirst = store.draftById(draftId)!;
  const withdrawalsFirst = afterFirst.sections.sourceInventory[0]!.annualWithdrawalGallons;
  const importCountFirst = afterFirst.sections.sourceInventory.length;

  // A second preview of the SAME file maps identically; applying replays.
  const retryPreview = previewImport(DEPS, store, draftId, { importId: 'imp-retry', filePeriod: CY2026, rows: FILE_ROWS }, WILEY);
  assert.equal(retryPreview.outcome, 'allowed');
  const retry = applyImport(DEPS, store, retryPreview.value, WILEY);
  assert.equal(retry.outcome, 'allowed');
  assert.equal(retry.value.replayed, true);
  assert.equal(retry.value.appliedRowCount, first.value.appliedRowCount);

  const afterRetry = store.draftById(draftId)!;
  assert.equal(afterRetry.sections.sourceInventory.length, importCountFirst, 'no duplicate inventory entries');
  assert.equal(afterRetry.sections.sourceInventory[0]!.annualWithdrawalGallons, withdrawalsFirst, 'no doubled values');
  assert.equal(afterRetry.imports.length, 1, 'the import id is recorded exactly once');
});

test('a different import id re-applies by design (a genuinely new file)', () => {
  const { store, draftId } = openDraftWithBaseline();
  const one = previewImport(DEPS, store, draftId, { importId: 'imp-x', filePeriod: CY2026, rows: [FILE_ROWS[0]!] }, WILEY);
  const two = previewImport(DEPS, store, draftId, { importId: 'imp-y', filePeriod: CY2026, rows: [FILE_ROWS[2]!] }, WILEY);
  assert.equal(applyImport(DEPS, store, one.value, WILEY).outcome, 'allowed');
  assert.equal(applyImport(DEPS, store, two.value, WILEY).outcome, 'allowed');
  const draft = store.draftById(draftId)!;
  assert.equal(draft.imports.length, 2);
  assert.equal(draft.sections.culinaryUse.populationServed, 52_400);
});

test('imports are org-isolated: the other supplier cannot preview or apply', () => {
  const { store, draftId } = openDraftWithBaseline();
  const preview = previewImport(DEPS, store, draftId, { importId: 'imp-iso', filePeriod: CY2026, rows: FILE_ROWS }, MORGAN);
  assert.equal(preview.outcome, 'denied');
  if (preview.outcome === 'denied') {
    assert.equal(preview.status, 404);
    assert.equal(preview.policyReason, 'DENY_OUT_OF_SCOPE');
  }
  // Even with a leaked preview object in hand, apply fails closed.
  const legitPreview = previewImport(DEPS, store, draftId, { importId: 'imp-iso', filePeriod: CY2026, rows: FILE_ROWS }, WILEY);
  assert.equal(legitPreview.outcome, 'allowed');
  const cross = applyImport(DEPS, store, legitPreview.value, MORGAN);
  assert.equal(cross.outcome, 'denied');
  if (cross.outcome === 'denied') assert.equal(cross.status, 404);
});

test('a not-applicable preview (period mismatch) cannot be applied', () => {
  const { store, draftId } = openDraftWithBaseline();
  const preview = previewImport(DEPS, store, draftId, { importId: 'imp-mismatch', filePeriod: { basis: 'water-year', year: 2026 }, rows: FILE_ROWS }, WILEY);
  assert.equal(preview.outcome, 'allowed');
  assert.equal(preview.value.applicable, false);
  const applied = applyImport(DEPS, store, preview.value, WILEY);
  assert.equal(applied.outcome, 'denied');
  if (applied.outcome === 'denied') assert.equal(applied.code, 'IMPORT_NOT_APPLICABLE');
});
