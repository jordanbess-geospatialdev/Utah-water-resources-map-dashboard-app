/**
 * reportModel tests (WD-017; FR-053..FR-057; T-06/T-15). The demo mirror is
 * pinned to the SAME golden constants as the API suite: the historical
 * discharge of the owner stream str-hyrum-q-owner for calendar year 2026 is
 * 26978/121 acre-feet (the WD-008/WD-025 golden: 9.8 cfs over 349 200 s +
 * 10.4 cfs over the full 604 800 s weekly cadence, divided by 43 560).
 * Like every golden in this repo it is pending owner approval.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { ReportSections } from './reportModel';

// Extensionless src imports under node --test --experimental-strip-types
// (import pattern per apps/web/tests/adapters.test.ts; see tests/ts-resolve-hook.mjs).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const modelPath = './reportModel.ts';
const model: typeof import('./reportModel') = await import(modelPath);
const fixturesPath = '../../shell/data/fixtures.ts';
const fixtures: typeof import('../../shell/data/fixtures') = await import(fixturesPath);

const { FIXTURE_CLOCK } = fixtures;
const CY2026 = { basis: 'calendar-year', year: 2026 } as const;

function closeRelative(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-9 * Math.max(Math.abs(expected), 1e-12);
}

function validSections(): ReportSections {
  return {
    culinaryUse: { populationServed: 52_000, activeConnections: 14_200, annualCulinaryVolumeGallons: 1_800_000_000, meteredPercent: 96 },
    sourceInventory: [
      { sourceId: 'W-1', sourceType: 'well', name: 'Canyon Well 1', pumpCapacityGpm: 1500, annualWithdrawalGallons: 1_200_000_000, metered: true },
    ],
    purchaseInventory: [{ sellerName: 'Regional Water Conservancy District', annualPurchasedGallons: 250_000_000 }],
    wholesaleInventory: [{ buyerName: 'Box Elder Mutual', annualSoldGallons: 90_000_000 }],
    returnInventory: [{ returnType: 'treated-effluent', receivingBody: 'Little Bear River', annualReturnedGallons: 40_000_000 }],
    sourcePeakDemand: { peakDayDate: '2026-07-12', peakDayVolumeGallons: 9_500_000, peakHourDemandGpm: 4200 },
    secondaryUse: { irrigatedAcres: 310.5, secondaryConnections: 2_400, annualSecondaryVolumeGallons: 480_000_000, metered: true },
  };
}

test('supplier scope mirror: two owner organizations anchored on different systems', () => {
  assert.deepEqual(
    model.SUPPLIER_ORGS.map((scope) => `${scope.orgId}->${scope.systemId}`),
    ['org-bear-river-users->sys-weber-river', 'org-cache-water->sys-bear-river'],
  );
  const cache = model.SUPPLIER_ORGS.find((scope) => scope.orgId === 'org-cache-water')!;
  assert.ok(cache.stations.some((station) => station.stationId === 'sta-hyrum-diversion-owner'));
  assert.equal(model.scopeOfActor('demo-wiley-cache-water')!.orgId, 'org-cache-water');
  assert.equal(model.scopeOfActor('principal-cody-commissioner'), null, 'fixture principals have no supplier scope');
});

test('validation mirror: valid sections pass; missing required produce field-level text; summary numbered', () => {
  const valid = model.validateSections(validSections(), CY2026);
  assert.equal(valid.summary.headline, 'No validation issues.');
  assert.equal(valid.issues.length, 0);

  const empty = model.validateSections(model.EMPTY_SECTIONS, CY2026);
  const paths = new Set(empty.issues.map((issue) => issue.fieldPath));
  for (const path of ['culinaryUse.populationServed', 'culinaryUse.activeConnections', 'culinaryUse.annualCulinaryVolumeGallons', 'sourceInventory', 'sourcePeakDemand.peakDayDate', 'sourcePeakDemand.peakDayVolumeGallons']) {
    assert.ok(paths.has(path), `missing ${path}`);
  }
  assert.ok(empty.summary.lines.every((line, index) => line.startsWith(`${index + 1}. `)));
  assert.match(empty.summary.headline, /errors and \d+ warnings must be resolved/);
});

test('validation mirror: unreasonable values warn with the documented range; zero is not missing', () => {
  const warned = model.validateSections({ ...validSections(), culinaryUse: { populationServed: 40_000_000, activeConnections: 14_200, annualCulinaryVolumeGallons: 1_800_000_000, meteredPercent: 96 } }, CY2026);
  const issue = warned.issues.find((candidate) => candidate.fieldPath === 'culinaryUse.populationServed')!;
  assert.equal(issue.severity, 'warning');
  assert.equal(issue.code, 'UNREASONABLE_VALUE');
  assert.match(issue.message, /40,000,000/);
  assert.match(issue.message, /plausible range/);

  const impossibleZero = model.validateSections({ ...validSections(), culinaryUse: { populationServed: 0, activeConnections: 14_200, annualCulinaryVolumeGallons: 1_800_000_000, meteredPercent: 96 } }, CY2026);
  const zero = impossibleZero.issues.find((candidate) => candidate.fieldPath === 'culinaryUse.populationServed')!;
  assert.equal(zero.code, 'INVALID_VALUE');
  assert.notEqual(zero.code, 'MISSING_REQUIRED');

  const honestZero = model.validateSections({ ...validSections(), returnInventory: [{ returnType: 'treated-effluent', receivingBody: 'Little Bear River', annualReturnedGallons: 0 }] }, CY2026);
  assert.equal(honestZero.issues.filter((candidate) => candidate.fieldPath.startsWith('returnInventory')).length, 0);
});

test('validation mirror: peak-day period membership follows the period basis', () => {
  const outOfYear = model.validateSections({ ...validSections(), sourcePeakDemand: { peakDayDate: '2025-07-12', peakDayVolumeGallons: 9_500_000, peakHourDemandGpm: 4200 } }, CY2026);
  assert.equal(outOfYear.issues.find((issue) => issue.fieldPath === 'sourcePeakDemand.peakDayDate')!.code, 'PERIOD_MISMATCH');

  const irrigation = model.validateSections(validSections(), { basis: 'irrigation-season', year: 2026 });
  assert.equal(irrigation.issues.length, 0);

  const marchBad = model.validateSections({ ...validSections(), sourcePeakDemand: { peakDayDate: '2026-03-15', peakDayVolumeGallons: 9_500_000, peakHourDemandGpm: 4200 } }, { basis: 'irrigation-season', year: 2026 });
  assert.equal(marchBad.issues.find((issue) => issue.fieldPath === 'sourcePeakDemand.peakDayDate')!.code, 'PERIOD_MISMATCH');
});

test('import mirror: parse, unit mapping (ac-ft, MG), invalid rows, and upsert without duplicates', () => {
  const parsed = model.parseImportText([
    '# documented format: category,field,entryKey,value,unit',
    'source-inventory,annualWithdrawalGallons,W-1,3700,ac-ft',
    'purchase-inventory,annualPurchasedGallons,Regional Water Conservancy District,250,MG',
    'culinary-use,populationServed,,52400,persons',
    'culinary-use,populationServed,,5,gal',
    'nope,populationServed,,5,persons',
  ].join('\n'));
  assert.equal(parsed.parseErrors.length, 0);
  assert.equal(parsed.rows.length, 5);

  const preview = model.previewImportRows(parsed.rows, CY2026, 'calendar-year', 2026);
  assert.equal(preview.applicable, false); // invalid rows present
  const byRow = new Map(preview.mappings.map((mapping) => [mapping.rowIndex, mapping]));
  assert.ok(closeRelative(byRow.get(1)!.mappedValue as number, 3_700 * 325_851.428571));
  assert.equal(byRow.get(1)!.mappedUnit, 'gallons');
  assert.equal(byRow.get(2)!.mappedValue, 250_000_000);
  assert.equal(byRow.get(3)!.mappedValue, 52_400);
  const reasons = preview.invalidRows.map((row) => row.reason).join('\n');
  assert.match(reasons, /is a volume, but the field measures persons/);
  assert.match(reasons, /unknown reporting category "nope"/);

  // Apply is an idempotent upsert: applying the same preview twice never
  // duplicates entries or doubles values.
  const once = model.applyPreviewToSections(validSections(), preview.mappings);
  const twice = model.applyPreviewToSections(once, preview.mappings);
  assert.equal(twice.sourceInventory.length, once.sourceInventory.length);
  assert.deepEqual(twice.sourceInventory[0], once.sourceInventory[0]);
  assert.equal(twice.purchaseInventory.length, 1, 'the entry upserts by seller name, no duplicate');
  assert.equal(twice.purchaseInventory[0]!.sellerName, 'Regional Water Conservancy District');
  assert.equal(twice.purchaseInventory[0]!.annualPurchasedGallons, 250_000_000);
  assert.equal(twice.culinaryUse.populationServed, 52_400);
});

test('import mirror: a period-mismatched file is not applicable', () => {
  const parsed = model.parseImportText('culinary-use,populationServed,,52400,persons');
  const preview = model.previewImportRows(parsed.rows, CY2026, 'water-year', 2026);
  assert.equal(preview.applicable, false);
  assert.match(preview.periodNote, /does NOT match the draft period/);
});

test('historical discharge mirror is pinned to the API golden 26978/121 acre-feet (CY 2026)', () => {
  const cache = model.historicalDischargeOf('org-cache-water');
  const row = cache.find((candidate) => candidate.streamId === 'str-hyrum-q-owner');
  assert.ok(row, 'owner stream present');
  const byYear = new Map(row.years.map((year) => [year.year, year.volumeAcreFeet]));
  assert.equal(byYear.get(2024), null, 'no fixture data in 2024: unavailable, never zero');
  assert.equal(byYear.get(2025), null);
  assert.ok(closeRelative(byYear.get(2026) as number, 26978 / 121), `got ${byYear.get(2026)}`);

  const bearUsers = model.historicalDischargeOf('org-bear-river-users');
  const proposed = bearUsers.find((candidate) => candidate.streamId === 'str-ogden-q-proposed');
  assert.ok(proposed);
  assert.ok(proposed.years.every((year) => year.volumeAcreFeet === null), 'proposed gauge has no observations');
});

test('demo freeze: manifest carries the content hash verbatim; deterministic; content-sensitive', () => {
  const validation = model.validateSections(validSections(), CY2026);
  const base = {
    sections: validSections(),
    validation,
    actorId: 'demo-wiley-cache-water',
    orgId: 'org-cache-water',
    systemId: 'sys-bear-river',
    period: CY2026,
    version: 1,
    now: '2026-04-02T15:30:00Z',
  };
  const first = model.freezeDemoSubmission(base);
  const second = model.freezeDemoSubmission(base);
  assert.equal(second.contentHash, first.contentHash, 'deterministic demo hash');
  assert.equal(first.pdfManifest.submittedContentHash, first.contentHash, 'the PDF-matches-submission proof');
  assert.ok(first.pdfManifest.blocks.some((block) => block.kind === 'hash-footer' && block.text.includes(first.contentHash)));
  assert.ok(first.pdfManifest.blocks.some((block) => block.text.includes('Submitter: demo-wiley-cache-water')));
  assert.equal(first.version, 1);
  assert.equal(first.submittedAt, '2026-04-02T15:30:00Z');

  const changed = model.freezeDemoSubmission({ ...base, sections: { ...validSections(), culinaryUse: { populationServed: 52_400, activeConnections: 14_200, annualCulinaryVolumeGallons: 1_800_000_000, meteredPercent: 96 } } });
  assert.notEqual(changed.contentHash, first.contentHash);
});

test('demo freeze: acknowledged warnings ride along and appear in the manifest annex', () => {
  const sections = { ...validSections(), sourcePeakDemand: { peakDayDate: '2026-07-12', peakDayVolumeGallons: 9_500_000, peakHourDemandGpm: 90_000 } };
  const validation = model.validateSections(sections, CY2026);
  assert.equal(validation.summary.errorCount, 0);
  assert.equal(validation.summary.warningCount, 1);
  const frozen = model.freezeDemoSubmission({ sections, validation, actorId: 'demo-wiley-cache-water', orgId: 'org-cache-water', systemId: 'sys-bear-river', period: CY2026, version: 1 });
  assert.equal(frozen.acknowledgedWarnings.length, 1);
  assert.ok(frozen.pdfManifest.blocks.some((block) => block.text.includes('Acknowledged warnings recorded with this submission: 1.')));
});

test('resubmission state machine mirror: a new version only after resubmission-approved', () => {
  assert.equal(model.canOpenNewVersion(null), true);
  assert.equal(model.canOpenNewVersion('submitted'), false);
  assert.equal(model.canOpenNewVersion('resubmission-approved'), true);
});

test('boundary mirror: proposals validate sections; approval derives v2 while v1 stays untouched', () => {
  const bad = model.makeBoundaryProposal({ actorId: 'demo-wiley-cache-water', sequence: 1, approved: model.BOUNDARY_SECTIONS_V1, changes: [{ sectionId: 'nope', proposedSummary: 'x', changeReason: 'x' }] });
  assert.ok('error' in bad);

  const proposal = model.makeBoundaryProposal({
    actorId: 'demo-wiley-cache-water',
    sequence: 1,
    approved: model.BOUNDARY_SECTIONS_V1,
    changes: [{ sectionId: 'service-area', proposedSummary: 'Extended to include the 2025 annexation.', changeReason: 'Recorded annexation' }],
  });
  assert.ok(!('error' in proposal));
  if ('error' in proposal) return;
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.sections[0]!.currentSummary, model.BOUNDARY_SECTIONS_V1[0]!.summary, 'the proposal snapshots the current summary');

  const approved = model.approveBoundaryMirror(proposal, model.BOUNDARY_SECTIONS_V1, 'demo-wum-reviewer-cache', '2026-04-02T15:30:00Z');
  assert.equal(approved.proposal.status, 'approved');
  assert.equal(approved.proposal.resultingBoundaryVersion, 2);
  assert.equal(approved.boundary[0]!.summary, 'Extended to include the 2025 annexation.');
  assert.equal(approved.boundary[1]!.summary, model.BOUNDARY_SECTIONS_V1[1]!.summary, 'untouched sections keep their text');
  // v1 untouched:
  assert.equal(model.BOUNDARY_SECTIONS_V1[0]!.summary.includes('annexation'), false);
});

test('fixture clock agreement: the demo uses the shared fixture clock by default', () => {
  const validation = model.validateSections(validSections(), CY2026);
  const frozen = model.freezeDemoSubmission({ sections: validSections(), validation, actorId: 'a', orgId: 'o', systemId: 's', period: CY2026, version: 1 });
  assert.equal(frozen.submittedAt, FIXTURE_CLOCK);
});
