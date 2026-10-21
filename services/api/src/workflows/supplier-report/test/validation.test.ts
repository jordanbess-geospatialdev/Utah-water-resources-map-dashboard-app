/**
 * Category validation matrix tests (WD-017; FR-055; T-06): the seven
 * reporting categories, missing required values, unreasonable values,
 * zero-versus-missing, and the accessible error SUMMARY object.
 *
 * FR-055: "missing required values and unreasonable values produce
 * field-level text messages and an error summary in addition to color."
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EMPTY_SECTIONS, type ReportSections } from '../types.ts';
import { buildErrorSummary, dateInPeriod, validateSections } from '../validate.ts';
import { validSections } from './helpers.ts';

const CY2026 = { basis: 'calendar-year', year: 2026 } as const;

function issuesOf(sections: ReportSections) {
  return validateSections(sections, CY2026);
}

test('a fully valid section set produces no issues at all', () => {
  const snapshot = issuesOf(validSections());
  assert.equal(snapshot.issues.length, 0);
  assert.equal(snapshot.summary.errorCount, 0);
  assert.equal(snapshot.summary.warningCount, 0);
  assert.equal(snapshot.summary.headline, 'No validation issues.');
  assert.deepEqual(snapshot.summary.lines, []);
});

test('an empty draft flags every required field of every category with TEXT messages', () => {
  const snapshot = issuesOf(EMPTY_SECTIONS);
  const errors = snapshot.issues.filter((issue) => issue.severity === 'error');
  const paths = new Set(errors.map((issue) => issue.fieldPath));

  // Culinary use: three required scalars.
  for (const path of ['culinaryUse.populationServed', 'culinaryUse.activeConnections', 'culinaryUse.annualCulinaryVolumeGallons']) {
    assert.ok(paths.has(path), `missing ${path}`);
  }
  // Source inventory: the category-level "at least one source" rule.
  assert.ok(paths.has('sourceInventory'), 'missing the empty-source-inventory error');
  // Peak demand: date + volume required.
  for (const path of ['sourcePeakDemand.peakDayDate', 'sourcePeakDemand.peakDayVolumeGallons']) {
    assert.ok(paths.has(path), `missing ${path}`);
  }
  // Optional inventories (purchase/wholesale/returns) and secondary use
  // produce nothing while entirely empty.
  for (const issue of snapshot.issues) {
    assert.notEqual(issue.category, 'purchase-inventory');
    assert.notEqual(issue.category, 'wholesale-inventory');
    assert.notEqual(issue.category, 'secondary-use');
  }
  // Every message is non-empty TEXT naming its category and field.
  for (const issue of errors) {
    assert.ok(issue.message.length > 0);
    assert.equal(issue.code, 'MISSING_REQUIRED');
  }
});

test('missing required values produce field-level text messages naming field and unit', () => {
  const sections: ReportSections = { ...validSections(), culinaryUse: { populationServed: null, activeConnections: 14_200, annualCulinaryVolumeGallons: 1_800_000_000, meteredPercent: null } };
  const snapshot = issuesOf(sections);
  const missing = snapshot.issues.find((issue) => issue.fieldPath === 'culinaryUse.populationServed');
  assert.ok(missing);
  assert.equal(missing.severity, 'error');
  assert.equal(missing.code, 'MISSING_REQUIRED');
  assert.match(missing.message, /Culinary use/);
  assert.match(missing.message, /Population served/);
  assert.match(missing.message, /persons/);
  // meteredPercent is optional: no issue for it.
  assert.equal(snapshot.issues.filter((issue) => issue.fieldPath === 'culinaryUse.meteredPercent').length, 0);
});

test('unreasonable values are warnings with the documented plausible range and rationale', () => {
  const sections: ReportSections = {
    ...validSections(),
    culinaryUse: { populationServed: 40_000_000, activeConnections: 14_200, annualCulinaryVolumeGallons: 1_800_000_000, meteredPercent: 96 },
  };
  const snapshot = issuesOf(sections);
  const unreasonable = snapshot.issues.find((issue) => issue.fieldPath === 'culinaryUse.populationServed');
  assert.ok(unreasonable);
  assert.equal(unreasonable.severity, 'warning');
  assert.equal(unreasonable.code, 'UNREASONABLE_VALUE');
  assert.match(unreasonable.message, /40,000,000/);
  assert.match(unreasonable.message, /plausible range/);
  assert.match(unreasonable.message, /Utah community water systems/); // the documented rationale
  assert.equal(snapshot.summary.errorCount, 0);
  assert.equal(snapshot.summary.warningCount, 1);
});

test('structurally invalid values are errors: negative, non-integer, zero-where-impossible, percent > 100', () => {
  const sections: ReportSections = {
    ...validSections(),
    culinaryUse: { populationServed: 52_000, activeConnections: 14_200.5, annualCulinaryVolumeGallons: -5, meteredPercent: 140 },
    sourcePeakDemand: { peakDayDate: '2026-07-12', peakDayVolumeGallons: 9_500_000, peakHourDemandGpm: 0 },
  };
  const snapshot = issuesOf(sections);
  const byPath = new Map(snapshot.issues.map((issue) => [issue.fieldPath, issue]));
  assert.equal(byPath.get('culinaryUse.activeConnections')!.code, 'INVALID_VALUE');
  assert.match(byPath.get('culinaryUse.activeConnections')!.message, /whole number/);
  assert.equal(byPath.get('culinaryUse.annualCulinaryVolumeGallons')!.code, 'INVALID_VALUE');
  assert.match(byPath.get('culinaryUse.annualCulinaryVolumeGallons')!.message, /negative/);
  assert.equal(byPath.get('culinaryUse.meteredPercent')!.code, 'INVALID_VALUE');
  assert.equal(byPath.get('sourcePeakDemand.peakHourDemandGpm')!.code, 'INVALID_VALUE');
  assert.match(byPath.get('sourcePeakDemand.peakHourDemandGpm')!.message, /impossible/);
});

test('zero is a VALUE, not missing: impossible zeros error; legitimate zeros pass silently', () => {
  // Legitimate zero: annual returned volume of 0 is an honest answer.
  const honestZero: ReportSections = {
    ...validSections(),
    returnInventory: [{ returnType: 'treated-effluent', receivingBody: 'Little Bear River', annualReturnedGallons: 0 }],
  };
  assert.equal(issuesOf(honestZero).issues.filter((issue) => issue.fieldPath === 'returnInventory[0].annualReturnedGallons').length, 0);

  // Impossible zero: population served of 0 is an error, never "missing".
  const impossibleZero: ReportSections = {
    ...validSections(),
    culinaryUse: { populationServed: 0, activeConnections: 14_200, annualCulinaryVolumeGallons: 1_800_000_000, meteredPercent: 96 },
  };
  const issue = issuesOf(impossibleZero).issues.find((candidate) => candidate.fieldPath === 'culinaryUse.populationServed');
  assert.ok(issue);
  assert.equal(issue.code, 'INVALID_VALUE');
  assert.notEqual(issue.code, 'MISSING_REQUIRED');
});

test('inventory entries validate per entry with indexed field paths', () => {
  const sections: ReportSections = {
    ...validSections(),
    purchaseInventory: [
      { sellerName: 'Regional Water Conservancy District', annualPurchasedGallons: 250_000_000 },
      { sellerName: '', annualPurchasedGallons: null },
    ],
  };
  const snapshot = issuesOf(sections);
  const paths = snapshot.issues.map((issue) => issue.fieldPath);
  assert.ok(paths.includes('purchaseInventory[1].sellerName'));
  assert.ok(paths.includes('purchaseInventory[1].annualPurchasedGallons'));
  assert.ok(!paths.includes('purchaseInventory[0].sellerName'));
  const sellerIssue = snapshot.issues.find((issue) => issue.fieldPath === 'purchaseInventory[1].sellerName')!;
  assert.match(sellerIssue.message, /entry 2/);
});

test('peak day outside the reported period is a PERIOD_MISMATCH error (all bases)', () => {
  const calendar = issuesOf({ ...validSections(), sourcePeakDemand: { peakDayDate: '2025-07-12', peakDayVolumeGallons: 9_500_000, peakHourDemandGpm: 4200 } });
  assert.equal(calendar.issues.find((issue) => issue.fieldPath === 'sourcePeakDemand.peakDayDate')!.code, 'PERIOD_MISMATCH');

  const irrigation = validateSections(validSections(), { basis: 'irrigation-season', year: 2026 });
  assert.equal(irrigation.issues.length, 0, 'Jul 12 is inside the irrigation season');

  const irrigationBad = validateSections({ ...validSections(), sourcePeakDemand: { peakDayDate: '2026-03-15', peakDayVolumeGallons: 9_500_000, peakHourDemandGpm: 4200 } }, { basis: 'irrigation-season', year: 2026 });
  assert.equal(irrigationBad.issues.find((issue) => issue.fieldPath === 'sourcePeakDemand.peakDayDate')!.code, 'PERIOD_MISMATCH');

  const waterYear = validateSections({ ...validSections(), sourcePeakDemand: { peakDayDate: '2025-10-05', peakDayVolumeGallons: 9_500_000, peakHourDemandGpm: 4200 } }, { basis: 'water-year', year: 2026 });
  assert.equal(waterYear.issues.length, 0, 'Oct 5 of year-1 is inside water year 2026');
});

test('secondary use is conditionally required: partially reported means fully required', () => {
  const partial: ReportSections = {
    ...validSections(),
    secondaryUse: { irrigatedAcres: 120, secondaryConnections: null, annualSecondaryVolumeGallons: null, metered: null },
  };
  const snapshot = issuesOf(partial);
  const paths = snapshot.issues.map((issue) => issue.fieldPath);
  assert.ok(paths.includes('secondaryUse.secondaryConnections'));
  assert.ok(paths.includes('secondaryUse.annualSecondaryVolumeGallons'));
  assert.ok(!paths.includes('secondaryUse.irrigatedAcres'));
  for (const issue of snapshot.issues) assert.match(issue.message, /partially reported/);
});

test('the error SUMMARY object is accessible text: headline plus numbered lines, category-ordered', () => {
  const sections: ReportSections = {
    ...EMPTY_SECTIONS,
    culinaryUse: { populationServed: 40_000_000, activeConnections: null, annualCulinaryVolumeGallons: 1_800_000_000, meteredPercent: null },
    sourceInventory: [{ sourceId: 'W-1', sourceType: 'well', name: 'Canyon Well 1', pumpCapacityGpm: 1_500, annualWithdrawalGallons: 1_200_000_000, metered: true }],
  };
  const snapshot = issuesOf(sections);
  const summary = snapshot.summary;
  assert.equal(summary.errorCount, 3); // activeConnections missing, peak date, peak volume (population 40M is a warning)
  assert.equal(summary.warningCount, 1);
  assert.match(summary.headline, /3 errors and 1 warning/);
  assert.equal(summary.lines.length, 4);
  summary.lines.forEach((line, index) => assert.match(line, new RegExp(`^${index + 1}\\. (Error|Warning) — `)));
  // Category order first, field-path order inside the category: the culinary
  // error, then the culinary warning, then the peak-demand errors.
  assert.ok(summary.lines[0]!.startsWith('1. Error — Culinary use'));
  assert.ok(summary.lines[1]!.startsWith('2. Warning — Culinary use'));
  assert.ok(summary.lines[2]!.startsWith('3. Error — Source peak demand'));
});

test('buildErrorSummary never depends on color: output is pure text', () => {
  const summary = buildErrorSummary([
    { fieldPath: 'a.b', category: 'culinary-use', severity: 'error', code: 'MISSING_REQUIRED', message: 'msg' },
  ]);
  assert.deepEqual(Object.keys(summary).sort(), ['errorCount', 'headline', 'lines', 'warningCount']);
  assert.equal(typeof summary.headline, 'string');
  for (const line of summary.lines) assert.equal(typeof line, 'string');
});

test('dateInPeriod mirrors the documented period date rules', () => {
  assert.equal(dateInPeriod('2026-06-15', { basis: 'calendar-year', year: 2026 }), true);
  assert.equal(dateInPeriod('2025-06-15', { basis: 'calendar-year', year: 2026 }), false);
  assert.equal(dateInPeriod('2025-10-01', { basis: 'water-year', year: 2026 }), true);
  assert.equal(dateInPeriod('2026-09-30', { basis: 'water-year', year: 2026 }), true);
  assert.equal(dateInPeriod('2026-10-01', { basis: 'water-year', year: 2026 }), false);
  assert.equal(dateInPeriod('2026-04-01', { basis: 'irrigation-season', year: 2026 }), true);
  assert.equal(dateInPeriod('2026-10-31', { basis: 'irrigation-season', year: 2026 }), true);
  assert.equal(dateInPeriod('2026-11-01', { basis: 'irrigation-season', year: 2026 }), false);
});
