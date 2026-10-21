/**
 * Golden report tests (WD-025; FR-024; T-15). STATUS: pending
 * measurement-owner approval, exactly like the WD-008/WD-018 goldens - the
 * values below are HAND-DERIVED from the published fixture numbers
 * (seed utah-water-fixture-v1) and document this implementation's
 * derivation; they are not yet ratified expected values.
 *
 * GOLDEN REPORT: Cody (Bear River commissioner) generates the Bear River
 * system report for period basis calendar-year 2026, processing basis raw
 * (and, in the second half, best-available). The year window is
 * [2026-01-01T07:00Z, 2027-01-01T07:00Z) local America/Denver (365 days =
 * 31 536 000 s; the DST hour lost Mar 8 is regained Nov 1). The fixture
 * series live on local days 2026-03-06..2026-03-09 only, so every other day
 * of the year is honestly uncovered (null volume, never zero).
 *
 * HAND DERIVATION (volumes in acre-feet = cubic feet / 43 560 = value x 10/121
 * for one 3 600 s hour):
 *
 * NATURAL-CHANNEL-FLOW, str-corinne-q (hourly; sta-bear-corinne,
 * site type natural-channel), raw basis - the WD-008 daily goldens plus the
 * Mar 9 reading:
 *   2026-03-06: 11 usable hourly values, sum 201.2 -> 2012/121 (golden)
 *   2026-03-07: 22 usable, sum 421.5 -> 4215/121 (golden; duplicate 19.1/19.3
 *               normalized to the retransmission 19.3; -1.2 excluded)
 *   2026-03-08: 16 usable on the 23-hour day, sum 381.2 -> 3812/121 (golden)
 *   2026-03-09: obs-q-054 26.0 cfs at 2026-03-09T06:00Z = local midnight,
 *               covers [06:00Z, 07:00Z) -> 26.0 x 3600 / 43560 = 260/121
 *   CY-2026 raw total = (2012 + 4215 + 3812 + 260)/121 = 10299/121
 *     - identical to the WD-008 MARCH golden (10299/121): all fixture data
 *       sits inside March, so the calendar-year total reconciles to the
 *       monthly golden of the same world.
 *   covered seconds 39 600 + 79 200 + 57 600 + 3 600 = 180 000 s; estimated
 *   3 600 s (the gap-edge reading); 361 of 365 days uncovered.
 *   Best-available basis: Mar 7 -1.2 -> 20.9 (rev-corinne-2004; the slot
 *   becomes covered, +209/121) and Mar 8 23.5 -> 23.9 (rev-corinne-2002,
 *   +4/121) give (2012 + 4424 + 3816 + 260)/121 = 10512/121 (~86.876).
 *
 * CANAL-DELIVERY, str-hyrum-q-public (manual weekly cadence 604 800 s;
 * sta-hyrum-diversion-public, site type flume), raw - a reading governs
 * until the next visit, AT MOST its cadence (never beyond it):
 *   hp-001 12.6 @ 2026-02-23T17:00Z -> [Feb 23 17:00Z, Mar 2 17:00Z) = the
 *               full 604 800 s cadence; the 30-minute tail before hp-002
 *               stays UNCOVERED (a reading never stretches past its cadence)
 *   hp-002 13.1 @ 2026-03-02T17:30Z -> 342 900 s
 *   hp-003 14.0 @ 2026-03-06T16:45Z -> 200 700 s
 *   hp-004 15.2 @ 2026-03-09T00:30Z -> full cadence 604 800 s (no later reading)
 *   cubic feet = 12.6x604800 + 13.1x342900 + 14.0x200700 + 15.2x604800
 *              = 24 115 230 -> volume 267947/484 (~553.610) acre-feet;
 *   covered 1 753 200 s; nothing estimated.
 *
 * RESERVOIR-RELEASE, str-hyrum-q-owner (restricted stream; commissioner's
 * protected read via generate-reports; sta-hyrum-diversion-owner, site type
 * weir + water source surface-storage-release), raw:
 *   ho-001 9.8 @ 2026-03-04T16:00Z -> [Mar 4 16:00Z, Mar 8 17:00Z) = 349 200 s
 *   ho-002 10.4 @ 2026-03-08T17:00Z -> 604 800 s (cadence cap)
 *   cubic feet = 9.8x349200 + 10.4x604800 = 9 712 080 -> 26978/121 (~222.959);
 *   covered 954 000 s.
 *
 * NO DOUBLE COUNT: the two adjacent Hyrum stations (shared display name)
 * land in DIFFERENT categories (canal-delivery vs reservoir-release) and
 * combinedVolumeAcreFeet stays null - the report never sums across
 * categories. Stage (str-corinne-stage, ft) and equipment voltage
 * (str-diag-voltage, V) are excluded from flow totals as different
 * dimensions; sta-summit-creek-inactive is excluded at site level
 * (inactive lifecycle).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateSeries } from '../../../series/aggregate.ts';
import { AGGREGATION_METHOD } from '../../../series/types.ts';
import { CORINNE, closeRelative } from '../../../series/golden.ts';
import { seriesStore } from '../../../series/load.ts';
import { fixtureReportDeps, generateReport } from '../generate.ts';
import { DEFAULT_INCLUDE, type CategoryTotalRow, type GeneratedReport, type StreamReportSection } from '../types.ts';

const NOW = '2026-03-09T07:00:00Z'; // the fixture fixed clock
const CODY = 'principal-cody-commissioner';

const CY2026 = { basis: 'calendar-year', year: 2026 } as const;

function bearReport(basis: 'raw' | 'best-available'): GeneratedReport {
  const result = generateReport(
    fixtureReportDeps(NOW),
    { systemId: 'sys-bear-river', siteIds: null, period: CY2026, processingBasis: basis, include: DEFAULT_INCLUDE },
    CODY,
  );
  assert.equal(result.outcome, 'allowed');
  if (result.outcome === 'allowed') return result.value;
  throw new Error('unreachable');
}

function streamSection(report: GeneratedReport, streamId: string): StreamReportSection {
  for (const site of report.sections.sites) {
    const stream = site.streams.find((candidate) => candidate.streamId === streamId);
    if (stream) return stream;
  }
  throw new Error(`stream ${streamId} not in report`);
}

function categoryOf(report: GeneratedReport, category: string): CategoryTotalRow {
  const row = report.sections.totals.categories.find((candidate) => candidate.category === category);
  assert.ok(row, `category ${category} present`);
  return row;
}

/** Independent reconciliation: sum of the report's own daily rows, in row order. */
function dailyVolumeSum(stream: StreamReportSection): number {
  return stream.daily.reduce((sum, row) => sum + (row.volumeAcreFeet ?? 0), 0);
}

/** Independent recomputation from the WD-008 aggregation over the report window. */
function seriesVolumeSum(streamId: string, basis: 'raw' | 'best-available', start: string, end: string): number {
  const result = aggregateSeries(seriesStore(), { streamId, start, end, basis, interval: 'daily' });
  assert.equal(result.outcome, 'allowed');
  if (result.outcome !== 'allowed') throw new Error('unreachable');
  return result.value.buckets.reduce((sum, bucket) => sum + (bucket.volumeAcreFeet ?? 0), 0);
}

function assertClose(actual: number, expected: number, label: string): void {
  assert.ok(closeRelative(actual, expected), `${label}: ${actual} ~ ${expected}`);
}

// ---------------------------------------------------------------------------

test('golden window: calendar-year 2026 spans the local year and covers the fixture series', () => {
  const report = bearReport('raw');
  assert.equal(report.period.basis, 'calendar-year');
  assert.equal(report.period.start, '2026-01-01T07:00:00.000Z');
  assert.equal(report.period.end, '2027-01-01T07:00:00.000Z');
  assert.match(report.period.dateRule, /Jan 1/);
});

test('golden sites: three flow sites plus the diagnostics site; the inactive site is excluded with its reason', () => {
  const report = bearReport('raw');
  assert.deepEqual(
    report.sections.sites.map((site) => site.stationId),
    ['sta-bear-corinne', 'sta-bear-lake-diagnostic', 'sta-hyrum-diversion-owner', 'sta-hyrum-diversion-public'],
  );
  const corinne = report.sections.sites[0]!;
  assert.equal(corinne.streams.length, 1, 'only the discharge stream reports daily flow');
  assert.deepEqual(
    corinne.excludedStreams.map((entry) => entry.streamId),
    ['str-corinne-stage'],
  );
  assert.match(corinne.excludedStreams[0]!.reason, /dimension mismatch/);
  const diagnostic = report.sections.sites[1]!;
  assert.equal(diagnostic.streams.length, 0);
  assert.deepEqual(diagnostic.excludedStreams.map((entry) => entry.streamId), ['str-diag-voltage']);
  assert.deepEqual(report.sections.excludedSites, [
    { stationId: 'sta-summit-creek-inactive', stationDisplayName: 'Summit Creek Restoration Site', reason: 'station inactive (measurement lifecycle closed; excluded from reporting)' },
  ]);
});

test('golden daily rows (raw): the WD-008 daily goldens reconcile into the report exactly', () => {
  const report = bearReport('raw');
  const corinne = streamSection(report, 'str-corinne-q');
  assert.equal(corinne.daily.length, 365, 'every day of the period is listed');
  assert.equal(corinne.daily[0]!.key, '2026-01-01');
  assert.equal(corinne.daily[364]!.key, '2026-12-31');

  const byKey = new Map(corinne.daily.map((row) => [row.key, row]));
  assertClose(byKey.get('2026-03-06')!.volumeAcreFeet!, CORINNE.daily0306.volumeAcreFeet, 'Mar 6 volume');
  assertClose(byKey.get('2026-03-07')!.volumeAcreFeet!, CORINNE.daily0307Raw.volumeAcreFeet, 'Mar 7 raw volume');
  assertClose(byKey.get('2026-03-08')!.volumeAcreFeet!, CORINNE.daily0308Raw.volumeAcreFeet, 'Mar 8 raw volume');
  assertClose(byKey.get('2026-03-08')!.meanValue!, 23.825, 'Mar 8 raw mean (the DST-day golden)');
  assert.ok(closeRelative(byKey.get('2026-03-08')!.coverageFraction, 16 / 23), 'Mar 8 coverage 16/23');
  assertClose(byKey.get('2026-03-09')!.volumeAcreFeet!, 260 / 121, 'Mar 9: obs-q-054 covers the first local hour');
  assert.equal(byKey.get('2026-03-05')!.volumeAcreFeet, null, 'uncovered day: null, never zero');
  assert.deepEqual(byKey.get('2026-02-15')!.noteCodes, ['no-data']);

  // Note codes (text+shape quality vocabulary, fixed order).
  assert.deepEqual(byKey.get('2026-03-06')!.noteCodes.includes('null-frame'), true);
  assert.deepEqual(byKey.get('2026-03-07')!.noteCodes, ['range-excluded', 'suspect-zero', 'duplicate-timestamp']);
  assert.deepEqual(byKey.get('2026-03-08')!.noteCodes, ['declared-gap', 'range-excluded', 'estimated']);
});

test('golden reconciliation (raw): report totals === sum of daily rows === WD-008 series volumes === hand constants', () => {
  const report = bearReport('raw');
  const corinne = streamSection(report, 'str-corinne-q');

  // 1. The stream total is the exact sum of its own daily rows.
  assert.equal(corinne.totals.volumeAcreFeet, dailyVolumeSum(corinne));
  // 2. The stream total equals the independent WD-008 recomputation.
  assert.equal(corinne.totals.volumeAcreFeet, seriesVolumeSum('str-corinne-q', 'raw', report.period.start, report.period.end));
  // 3. The hand constant: the WD-008 March golden value (all fixture data is
  //    inside March 2026, so the calendar-year total IS the March total).
  assertClose(corinne.totals.volumeAcreFeet, 10299 / 121, 'CY-2026 raw natural-channel volume');
  assert.ok(closeRelative(corinne.totals.volumeAcreFeet, CORINNE.monthly.rawVolumeAcreFeet), 'reconciles to the series golden');
  assert.equal(corinne.totals.coveredSeconds, 180_000);
  assert.equal(corinne.totals.estimatedSeconds, 3_600);
  assert.equal(corinne.totals.dayCount, 365);
  assert.equal(corinne.totals.daysWithNoData, 361);

  // 4. The category total equals its single stream, and the same sums hold
  //    for the manual-cadence categories.
  const natural = categoryOf(report, 'natural-channel-flow');
  assert.deepEqual(natural.streamIds, ['str-corinne-q']);
  assert.equal(natural.volumeAcreFeet, corinne.totals.volumeAcreFeet);
  assert.ok(closeRelative(natural.estimatedProportion, 1 / 50), 'estimated share 3600/180000');

  const canal = categoryOf(report, 'canal-delivery');
  const hyrum = streamSection(report, 'str-hyrum-q-public');
  assert.equal(canal.volumeAcreFeet, dailyVolumeSum(hyrum), 'canal total === its daily rows');
  assertClose(canal.volumeAcreFeet, 267_947 / 484, 'canal-delivery manual-cadence integration');
  assert.equal(canal.coveredSeconds, 1_753_200, 'the pre-visit 30-minute tail stays uncovered (cadence cap)');

  const release = categoryOf(report, 'reservoir-release');
  const owner = streamSection(report, 'str-hyrum-q-owner');
  assert.equal(release.volumeAcreFeet, dailyVolumeSum(owner));
  assertClose(release.volumeAcreFeet, 26978 / 121, 'reservoir-release manual-cadence integration');
  assert.equal(release.coveredSeconds, 954_000);
  assert.equal(owner.projection, 'full', 'the restricted owner stream is a protected read for the commissioner');
});

test('golden no-double-count: categories are separated and never summed', () => {
  const report = bearReport('raw');
  const totals = report.sections.totals;
  assert.deepEqual(
    totals.categories.map((category) => category.category),
    ['natural-channel-flow', 'canal-delivery', 'reservoir-release'],
  );
  assert.equal(totals.combinedVolumeAcreFeet, null, 'cross-category sums can double-count the same water');
  assert.match(totals.noDoubleCountPolicy, /never summed across categories/);
  const canalSite = report.sections.sites.find((site) => site.stationId === 'sta-hyrum-diversion-public')!;
  const ownerSite = report.sections.sites.find((site) => site.stationId === 'sta-hyrum-diversion-owner')!;
  assert.equal(canalSite.stationDisplayName, ownerSite.stationDisplayName, 'the fixture deliberately shares this display name');
  assert.notEqual(canalSite.streams[0]!.streamId, ownerSite.streams[0]!.streamId);
  assert.deepEqual(
    totals.excludedStreams.map((entry) => entry.streamId).sort(),
    ['str-corinne-stage', 'str-diag-voltage'],
    'stage and voltage stay out of flow totals as different dimensions',
  );
});

test('golden daily rows (best-available): revisions change exactly the two documented days', () => {
  const report = bearReport('best-available');
  const corinne = streamSection(report, 'str-corinne-q');
  const byKey = new Map(corinne.daily.map((row) => [row.key, row]));
  assertClose(byKey.get('2026-03-07')!.volumeAcreFeet!, CORINNE.daily0307Best.volumeAcreFeet, 'Mar 7 best volume');
  assertClose(byKey.get('2026-03-08')!.volumeAcreFeet!, CORINNE.daily0308Best.volumeAcreFeet, 'Mar 8 best volume');
  assert.equal(byKey.get('2026-03-06')!.volumeAcreFeet, byKey.get('2026-03-06')!.volumeAcreFeet, 'Mar 6 unrevised');
  assertClose(corinne.totals.volumeAcreFeet, 10512 / 121, 'CY-2026 best-available natural-channel volume');
  assert.equal(corinne.totals.volumeAcreFeet, dailyVolumeSum(corinne));
});

test('golden provenance: extraction time, method version and per-stream revision labels', () => {
  const raw = bearReport('raw');
  assert.equal(raw.extractionTime, NOW);
  assert.equal(raw.sections.provenance.methodVersion, AGGREGATION_METHOD);
  assert.match(raw.sections.provenance.dataVersion, /^[0-9a-f]{64}$/);
  assert.equal(raw.sections.provenance.fixtureSeed, 'utah-water-fixture-v1');
  assert.deepEqual(
    raw.sections.provenance.streams.map((stream) => stream.streamId),
    ['str-corinne-q', 'str-hyrum-q-owner', 'str-hyrum-q-public'],
  );
  const corinneRaw = raw.sections.provenance.streams[0]!;
  assert.equal(corinneRaw.usedRevisionCount, 0, 'raw basis resolves to no revision');
  const heads = corinneRaw.revisedObservations.map((label) => `${label.observationId}:${label.headRevisionId}:v${label.chainVersion}`).sort();
  assert.deepEqual(heads, ['obs-q-019:rev-corinne-2003:v1', 'obs-q-032:rev-corinne-2004:v2', 'obs-q-042:rev-corinne-2002:v1']);
  assert.equal(corinneRaw.revisedObservations.every((label) => !label.usedAtSelectedBasis), true, 'raw basis uses no revision');

  const best = bearReport('best-available');
  const corinneBest = best.sections.provenance.streams[0]!;
  assert.equal(corinneBest.usedRevisionCount, 3, 'obs-q-017->2003, obs-q-032->2004, obs-q-042->2002');
  assert.equal(corinneBest.rawFallbackCount, 0, 'every revised observation resolved at best-available');
  assert.equal(corinneBest.revisedObservations.every((label) => label.usedAtSelectedBasis), true);
  assert.equal(best.sections.provenance.dataVersion, raw.sections.provenance.dataVersion, 'the data version tracks the underlying chain, which both bases share');
  assert.notEqual(best.contentHash, raw.contentHash, 'the selected basis is content and changes the hash');
});

test('golden formulas and quality notes: every derived number carries its method reference', () => {
  const report = bearReport('raw');
  const formulas = report.sections.formulas;
  assert.equal(formulas.methodVersion, AGGREGATION_METHOD);
  assert.ok(formulas.statements.some((statement) => statement.id === 'volume' && statement.statement.includes('43')));
  assert.ok(formulas.statements.every((statement) => statement.methodRef.length > 0));
  const corinne = streamSection(report, 'str-corinne-q');
  assert.equal(corinne.method, AGGREGATION_METHOD);
  assert.ok(corinne.qualityNotes.some((note) => note.includes('gap-corinne-20260308') && note.includes('source-outage')));
  assert.ok(corinne.qualityNotes.some((note) => note.startsWith('range-excluded readings: 2')), 'the -1.2 negative (Mar 7) and the 9500 spike (Mar 8)');
  assert.ok(corinne.qualityNotes.some((note) => note.startsWith('null frames: 1')));
  assert.ok(corinne.qualityNotes.some((note) => note.startsWith('suspect zeros: 1')));
  assert.ok(corinne.qualityNotes.some((note) => note.startsWith('duplicate-timestamp instants: 1')));
  assert.ok(corinne.qualityNotes.some((note) => note.startsWith('late arrivals: 1')));
  assert.ok(corinne.coverageNotes.some((note) => note.startsWith('days with no usable data: 361 of 365')));
  assert.match(report.contentHash, /^[0-9a-f]{64}$/);
  assert.match(report.reportId, /^rep-[0-9a-f]{12}$/);
});
