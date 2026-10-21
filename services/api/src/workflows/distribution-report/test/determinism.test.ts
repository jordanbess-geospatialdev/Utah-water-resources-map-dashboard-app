/**
 * Determinism and supersession tests (WD-025; FR-024; T-06, T-15).
 *
 * Contract under test:
 * - identical inputs (same fixture world, same injected clock, same request)
 *   produce BYTE-IDENTICAL reports across repeated generation: deep equality,
 *   identical canonical serialization, identical content hash and report id;
 * - the extraction timestamp is exactly the injected clock (never a real
 *   clock read);
 * - any input that changes content changes the hash (period basis, period
 *   year, processing basis, include flags, extraction clock);
 * - the DATA VERSION changes when the underlying revision chain changes (a
 *   WD-011 append), and so does the content hash, because provenance is part
 *   of the report;
 * - regeneration SUPERSEDES, never rewrites: the registry assigns version
 *   N+1 with a supersedes marker, marks the prior version's wrapper entry
 *   supersededBy, and the prior report OBJECT stays untouched (version 1,
 *   supersedes null) - the R2 finalization boundary stays documented, not
 *   implemented (finalizeReport throws).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalize, fixtureReportDeps, generateReport, ReportRegistry, reportKey } from '../generate.ts';
import { createRevisionStore } from '../../revisions/store.ts';
import { seriesStore } from '../../../series/load.ts';
import { DEFAULT_INCLUDE, type GeneratedReport, type ReportRequest } from '../types.ts';
import { finalizeReport } from '../finalize.ts';

const NOW = '2026-03-09T07:00:00Z';
const CODY = 'principal-cody-commissioner';

const BEAR_CY2026: ReportRequest = {
  systemId: 'sys-bear-river',
  siteIds: null,
  period: { basis: 'calendar-year', year: 2026 },
  processingBasis: 'raw',
  include: DEFAULT_INCLUDE,
};

function assertAllowed(result: ReturnType<typeof generateReport>): GeneratedReport {
  assert.equal(result.outcome, 'allowed');
  if (result.outcome === 'allowed') return result.value;
  throw new Error('unreachable');
}

function generate(request: ReportRequest, now: string = NOW): GeneratedReport {
  return assertAllowed(generateReport(fixtureReportDeps(now), request, CODY));
}

test('identical inputs generate byte-identical reports across repeated generation', () => {
  const first = generate(BEAR_CY2026);
  const second = generate(BEAR_CY2026);
  assert.deepEqual(second, first, 'deep equality across two generations');
  assert.equal(canonicalize(second), canonicalize(first), 'byte-identical canonical serialization');
  assert.equal(second.contentHash, first.contentHash);
  assert.equal(second.reportId, first.reportId);
  assert.equal(second.version, 1);
  assert.equal(second.supersedes, null);
});

test('extraction time is the injected clock, verbatim', () => {
  const report = generate(BEAR_CY2026, '2026-10-21T15:00:00Z');
  assert.equal(report.extractionTime, '2026-10-21T15:00:00Z');
  assert.equal(report.sections.provenance.extractionTime, '2026-10-21T15:00:00Z');
});

test('a different clock changes the extraction time and the content hash', () => {
  const a = generate(BEAR_CY2026, '2026-03-09T07:00:00Z');
  const b = generate(BEAR_CY2026, '2026-03-10T07:00:00Z');
  assert.notEqual(b.contentHash, a.contentHash);
  assert.notEqual(b.reportId, a.reportId);
});

test('a different period basis changes the hash (water year vs calendar year)', () => {
  const calendar = generate(BEAR_CY2026);
  const water = generate({ ...BEAR_CY2026, period: { basis: 'water-year', year: 2026 } });
  assert.notEqual(water.period.start, calendar.period.start);
  assert.notEqual(water.contentHash, calendar.contentHash);
  // The water-year window [2025-10-01, 2026-10-01) local still covers every
  // fixture reading, so the daily numbers agree even though content differs.
  assert.equal(water.sections.totals.categories[0]!.volumeAcreFeet, calendar.sections.totals.categories[0]!.volumeAcreFeet);
});

test('a different period year changes the hash (no fixture data in 2025)', () => {
  const y2026 = generate(BEAR_CY2026);
  const y2025 = generate({ ...BEAR_CY2026, period: { basis: 'calendar-year', year: 2025 } });
  assert.notEqual(y2025.contentHash, y2026.contentHash);
  const natural2025 = y2025.sections.totals.categories.find((category) => category.category === 'natural-channel-flow');
  assert.ok(natural2025);
  assert.equal(natural2025.volumeAcreFeet, 0, 'no fixture data in 2025: zero volume, hash still distinct');
});

test('a different processing basis changes the hash', () => {
  const raw = generate(BEAR_CY2026);
  const best = generate({ ...BEAR_CY2026, processingBasis: 'best-available' });
  assert.notEqual(best.contentHash, raw.contentHash);
  const rawNatural = raw.sections.totals.categories.find((category) => category.category === 'natural-channel-flow')!;
  const bestNatural = best.sections.totals.categories.find((category) => category.category === 'natural-channel-flow')!;
  assert.notEqual(bestNatural.volumeAcreFeet, rawNatural.volumeAcreFeet, 'revisions change the numbers, not just the hash');
});

test('different include flags change the hash', () => {
  const full = generate(BEAR_CY2026);
  const withoutDaily = generate({ ...BEAR_CY2026, include: { dailyTable: false, qualityNotes: true, gapDetail: true } });
  assert.notEqual(withoutDaily.contentHash, full.contentHash);
  for (const site of withoutDaily.sections.sites) {
    for (const stream of site.streams) assert.equal(stream.daily.length, 0, 'dailyTable=false omits the daily rows');
  }
});

test('an appended revision changes the data version and the content hash', () => {
  const revisions = createRevisionStore();
  const deps = { store: seriesStore(), revisions, now: NOW };
  const before = assertAllowed(generateReport(deps, BEAR_CY2026, CODY));

  const observation = revisions.observationById('obs-q-054');
  assert.ok(observation, 'obs-q-054 exists in the fixture world');
  revisions.appendRevision({
    logicalKey: observation.logicalKey,
    observation,
    type: 'correction',
    value: 26.4,
    unitId: 'cfs',
    excluded: false,
    processingLevel: 'provisional',
    qualifierIds: [],
    reason: 'determinism test: appended revision changes provenance',
    actorId: CODY,
    now: NOW,
    idempotencyKey: null,
    retainedOriginal: null,
    action: 'apply-correction',
  });

  const after = assertAllowed(generateReport(deps, BEAR_CY2026, CODY));
  assert.notEqual(after.sections.provenance.dataVersion, before.sections.provenance.dataVersion, 'data version tracks the revision chain');
  assert.notEqual(after.contentHash, before.contentHash, 'provenance is part of the hashed content');
  // The series store is immutable in this fixture world, so the daily numbers
  // themselves are unchanged; only provenance moved.
  const beforeNatural = before.sections.totals.categories[0]!.volumeAcreFeet;
  const afterNatural = after.sections.totals.categories[0]!.volumeAcreFeet;
  assert.equal(afterNatural, beforeNatural);
});

test('registry supersession: a new version supersedes, the prior report object is never mutated', () => {
  const registry = new ReportRegistry();
  const key = reportKey(BEAR_CY2026);

  const v1 = generate(BEAR_CY2026);
  const first = registry.register(v1, key);
  assert.equal(first.entry.report.version, 1);
  assert.equal(first.entry.report.supersedes, null);
  assert.equal(first.prior, null);
  assert.equal(first.replayed, false);

  // Identical content replays idempotently: no supersession, no new version.
  const replay = registry.register(generate(BEAR_CY2026), key);
  assert.equal(replay.replayed, true);
  assert.equal(replay.entry.report.reportId, first.entry.report.reportId);
  assert.equal(registry.list().length, 1);

  // A changed revision chain changes the content -> a genuinely new version.
  const revisions = createRevisionStore();
  const observation = revisions.observationById('obs-q-042')!;
  revisions.appendRevision({
    logicalKey: observation.logicalKey,
    observation,
    type: 'correction',
    value: 24.1,
    unitId: 'cfs',
    excluded: false,
    processingLevel: 'provisional',
    qualifierIds: [],
    reason: 'determinism test: supersession after a later correction',
    actorId: CODY,
    now: NOW,
    idempotencyKey: null,
    retainedOriginal: null,
    action: 'apply-correction',
  });
  const v2 = assertAllowed(generateReport({ store: seriesStore(), revisions, now: NOW }, BEAR_CY2026, CODY));
  assert.notEqual(v2.contentHash, v1.contentHash);

  const second = registry.register(v2, key);
  assert.equal(second.replayed, false);
  assert.equal(second.entry.report.version, 2);
  assert.equal(second.entry.report.supersedes, v1.reportId, 'the new version points at the one it supersedes');
  assert.ok(second.prior);
  assert.equal(second.prior.supersededBy, second.entry.report.reportId, 'the prior wrapper is marked superseded');

  // The prior REPORT OBJECT is untouched: regeneration never rewrites it.
  assert.equal(v1.version, 1);
  assert.equal(v1.supersedes, null);
  assert.equal(first.entry.report.version, 1);
  assert.equal(registry.get(v1.reportId)!.report.reportId, v1.reportId);
  assert.equal(registry.get(v1.reportId)!.supersededBy, v2.reportId);
  assert.equal(registry.list().length, 2);
});

test('finalization stays an R2 boundary: the stub throws', () => {
  assert.throws(() => finalizeReport({ reportId: 'rep-x', actorId: CODY }), /not implemented - R2 scope \(FR-029\)/);
});
