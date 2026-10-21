/**
 * reportModel tests (WD-025; FR-024; T-06/T-15). The daily numbers of the
 * demo mirror are pinned to the SAME golden constants as the API suite
 * (services/api/src/series/golden.ts): the Bear River calendar-year 2026
 * report must show the WD-008 daily goldens (2012/121, 4215/121, 3812/121
 * acre-feet; DST-day mean 23.825; coverage 16/23) and the category totals
 * must equal the sums of their daily rows and the hand constants
 * (natural-channel raw 10299/121, best-available 10512/121; canal-delivery
 * 267947/484 with the weekly-cadence cap; reservoir-release 26978/121).
 * Like every golden in this repo they are pending measurement-owner
 * approval; the derivations are documented in the API golden suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { ReportLike } from './reportModel';

// Extensionless src imports under node --test --experimental-strip-types
// (import pattern per apps/web/tests/adapters.test.ts; see tests/ts-resolve-hook.mjs).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const modelPath = './reportModel.ts';
const model: typeof import('./reportModel') = await import(modelPath);
const fixturesPath = '../../shell/data/fixtures.ts';
const fixtures: typeof import('../../shell/data/fixtures') = await import(fixturesPath);

const { DEFAULT_INCLUDE, actorReportScope, buildFixtureReport, formatVolume, hashFooter, noteSymbols, periodWindow, supersededBanner } = model;
const FIXTURE_CLOCK = fixtures.FIXTURE_CLOCK;

const CY2026 = { basis: 'calendar-year', year: 2026 } as const;

function closeRelative(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-9 * Math.max(Math.abs(expected), 1e-12);
}

function bearReport(basis: 'raw' | 'best-available' = 'raw'): ReportLike {
  return buildFixtureReport({
    systemId: 'sys-bear-river',
    siteIds: null,
    period: CY2026,
    processingBasis: basis,
    include: DEFAULT_INCLUDE,
  });
}

function streamOf(report: ReportLike, streamId: string) {
  for (const site of report.sections.sites) {
    const stream = site.streams.find((candidate) => candidate.streamId === streamId);
    if (stream) return stream;
  }
  throw new Error(`stream ${streamId} missing`);
}

test('period math: water year spans Oct-Sep, irrigation Apr 1 - Oct 31, calendar Jan-Dec (local Denver)', () => {
  const calendar = periodWindow('calendar-year', 2026);
  assert.equal(calendar.start, '2026-01-01T07:00:00.000Z');
  assert.equal(calendar.end, '2027-01-01T07:00:00.000Z');
  assert.equal(calendar.dayCount, 365);

  const water = periodWindow('water-year', 2026);
  assert.equal(water.start, '2025-10-01T06:00:00.000Z', 'water year 2026 opens Oct 1, 2025 (MDT)');
  assert.equal(water.end, '2026-10-01T06:00:00.000Z', 'and closes Oct 1, 2026 (MDT); Sep 30 is its last day');
  assert.equal(water.dayCount, 365);

  const irrigation = periodWindow('irrigation-season', 2026);
  assert.equal(irrigation.start, '2026-04-01T06:00:00.000Z');
  assert.equal(irrigation.end, '2026-11-01T06:00:00.000Z', 'Nov 1 exclusive: the season ends Oct 31');
  assert.equal(irrigation.dayCount, 214, 'Apr 1 through Oct 31 inclusive = 214 days');

  assert.match(calendar.dateRule, /Jan 1/);
  assert.match(water.dateRule, /USGS water year/);
});

test('acting scope: only assigned systems are reportable; the deputy holds none', () => {
  const cody = actorReportScope('principal-cody-commissioner')!;
  assert.deepEqual(cody.reportableSystemIds, ['sys-bear-river']);
  assert.match(cody.basis, /generate-reports/);

  const diego = actorReportScope('principal-diego-steward')!;
  assert.deepEqual(diego.reportableSystemIds, ['sys-bear-river', 'sys-weber-river'], 'statewide-administration covers every system');

  const ana = actorReportScope('principal-ana-deputy')!;
  assert.deepEqual(ana.reportableSystemIds, [], 'the fixture deputy has no generate-reports capability');

  const priya = actorReportScope('principal-priya-engineer')!;
  assert.deepEqual(priya.reportableSystemIds, [], 'engineers hold no report capability in the fixture world');

  assert.equal(actorReportScope('principal-nope'), null, 'unknown principal');
});

test('golden mirror (raw): the WD-008 daily goldens appear in the report table', () => {
  const report = bearReport('raw');
  const corinne = streamOf(report, 'str-corinne-q');
  assert.equal(corinne.daily.length, 365);
  const byKey = new Map(corinne.daily.map((row) => [row.key, row]));
  assert.ok(closeRelative(byKey.get('2026-03-06')!.volumeAcreFeet!, 2012 / 121));
  assert.ok(closeRelative(byKey.get('2026-03-07')!.volumeAcreFeet!, 4215 / 121));
  assert.ok(closeRelative(byKey.get('2026-03-08')!.volumeAcreFeet!, 3812 / 121));
  assert.ok(closeRelative(byKey.get('2026-03-08')!.meanValue!, 23.825), 'DST-day mean golden');
  assert.ok(closeRelative(byKey.get('2026-03-08')!.coverageFraction, 16 / 23), '23-hour day coverage');
  assert.ok(closeRelative(byKey.get('2026-03-09')!.volumeAcreFeet!, 260 / 121), 'obs-q-054 covers the first local hour');
  assert.equal(byKey.get('2026-03-05')!.volumeAcreFeet, null, 'uncovered day: unavailable, never zero');
  assert.deepEqual(byKey.get('2026-03-07')!.noteCodes, ['range-excluded', 'suspect-zero', 'duplicate-timestamp']);
  assert.deepEqual(byKey.get('2026-03-08')!.noteCodes, ['declared-gap', 'range-excluded', 'estimated']);
});

test('golden mirror (raw): totals reconcile to their daily rows and the hand constants', () => {
  const report = bearReport('raw');
  for (const streamId of ['str-corinne-q', 'str-hyrum-q-public', 'str-hyrum-q-owner']) {
    const stream = streamOf(report, streamId);
    const sum = stream.daily.reduce((total, row) => total + (row.volumeAcreFeet ?? 0), 0);
    assert.equal(stream.totals.volumeAcreFeet, sum, `${streamId} total === sum of daily rows`);
  }
  const natural = report.sections.totals.categories.find((category) => category.category === 'natural-channel-flow')!;
  assert.ok(closeRelative(natural.volumeAcreFeet, 10299 / 121), 'the WD-008 March golden total');
  const canal = report.sections.totals.categories.find((category) => category.category === 'canal-delivery')!;
  assert.ok(closeRelative(canal.volumeAcreFeet, 267_947 / 484), 'manual-cadence integration with the weekly cap');
  const release = report.sections.totals.categories.find((category) => category.category === 'reservoir-release')!;
  assert.ok(closeRelative(release.volumeAcreFeet, 26_978 / 121));
  assert.equal(report.sections.totals.combinedVolumeAcreFeet, null, 'never summed across categories');
});

test('golden mirror (best-available): revisions move exactly the two documented days', () => {
  const report = bearReport('best-available');
  const corinne = streamOf(report, 'str-corinne-q');
  const byKey = new Map(corinne.daily.map((row) => [row.key, row]));
  assert.ok(closeRelative(byKey.get('2026-03-07')!.volumeAcreFeet!, 4424 / 121));
  assert.ok(closeRelative(byKey.get('2026-03-08')!.volumeAcreFeet!, 3816 / 121));
  assert.ok(closeRelative(corinne.totals.volumeAcreFeet, 10512 / 121));
  const provenance = report.sections.provenance.streams.find((stream) => stream.streamId === 'str-corinne-q')!;
  assert.equal(provenance.usedRevisionCount, 3, 'rev-corinne-2002/2003/2004 heads used at best-available');
});

test('demo determinism: identical inputs and clock reproduce the identical report and hash', () => {
  const request = { systemId: 'sys-bear-river', siteIds: null, period: CY2026, processingBasis: 'raw' as const, include: DEFAULT_INCLUDE };
  const first = buildFixtureReport(request, 'principal-cody-commissioner', '2026-03-09T07:00:00Z');
  const second = buildFixtureReport(request, 'principal-cody-commissioner', '2026-03-09T07:00:00Z');
  assert.deepEqual(second, first);
  assert.equal(second.contentHash, first.contentHash);
  assert.equal(second.reportId, first.reportId);
  assert.equal(first.extractionTime, FIXTURE_CLOCK, 'extraction time defaults to the fixture clock');
  const otherClock = buildFixtureReport(request, 'principal-cody-commissioner', '2026-03-10T07:00:00Z');
  assert.notEqual(otherClock.contentHash, first.contentHash);
  const best = buildFixtureReport({ ...request, processingBasis: 'best-available' as const });
  assert.notEqual(best.contentHash, first.contentHash, 'processing basis is content');
});

test('view models: unavailable formatting, note shapes, banner and hash footer', () => {
  assert.equal(formatVolume(null), 'Unavailable');
  assert.equal(formatVolume(267_947 / 484), `${(267_947 / 484).toFixed(3)} acre-feet`);
  assert.equal(noteSymbols(['declared-gap', 'estimated']), '▨ ≈');
  assert.equal(supersededBanner(bearReport()), null, 'a fresh report supersedes nothing');

  const regenerated = { ...bearReport(), version: 2, supersedes: 'rep-abc123' };
  const banner = supersededBanner(regenerated)!;
  assert.match(banner, /v2/);
  assert.match(banner, /rep-abc123/);
  assert.match(banner, /never rewrites/);
  assert.match(banner, /FR-029/);
  assert.match(hashFooter(bearReport()), /content [0-9a-f]+ · data version [0-9a-f]+ · rectangle-right@1/);
});
