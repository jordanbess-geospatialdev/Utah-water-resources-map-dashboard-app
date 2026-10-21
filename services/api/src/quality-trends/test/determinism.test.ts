/**
 * Determinism suite (WD-013-R2): identical inputs produce byte-identical
 * trend outputs - reports, curve diagnostics and projections - across two
 * consecutive derivations AND two independent store instances. No clocks,
 * no randomness: ids derive from (kind, stream, cause key, first instant).
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/quality-trends/test/determinism.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRatingCurveStore } from '../../workflows/rating-curves/store.ts';
import { buildTrendReport } from '../trends.ts';
import { curveDiagnosticsReport } from '../curveDiagnostics.ts';
import { publicTrendReport, trendReportFor } from '../visibility.ts';
import { buildTrendsWorld, FATIMA, fixtureTrendInput, NOW } from './helpers.ts';

test('two consecutive derivations of the full report are byte-identical', () => {
  const first = JSON.stringify(buildTrendReport(fixtureTrendInput()));
  const second = JSON.stringify(buildTrendReport(fixtureTrendInput()));
  assert.equal(first, second);
});

test('two independent WD-011-R2 store instances yield identical diagnostics timelines', () => {
  const incidents = buildTrendReport(fixtureTrendInput()).incidents;
  const first = JSON.stringify(curveDiagnosticsReport(createRatingCurveStore(), incidents));
  const second = JSON.stringify(curveDiagnosticsReport(createRatingCurveStore(), incidents));
  assert.equal(first, second);
});

test('boundary annotations and supersession lineage are stable across runs', () => {
  const incidents = buildTrendReport(fixtureTrendInput()).incidents;
  const first = curveDiagnosticsReport(createRatingCurveStore(), incidents);
  const second = curveDiagnosticsReport(createRatingCurveStore(), incidents);
  assert.deepEqual(first.boundaries, second.boundaries);
  assert.deepEqual(first.annotatedIncidents, second.annotatedIncidents);
  assert.deepEqual(first.timeline, second.timeline);
  assert.deepEqual(first.supersessions, second.supersessions);
});

test('visibility projections are deterministic for the same persona', () => {
  const report = buildTrendReport(fixtureTrendInput());
  const deps = { world: buildTrendsWorld(), clock: () => NOW };
  assert.equal(JSON.stringify(publicTrendReport(report)), JSON.stringify(publicTrendReport(report)));
  assert.equal(
    JSON.stringify(trendReportFor(deps, FATIMA, report)),
    JSON.stringify(trendReportFor(deps, FATIMA, report)),
  );
});

test('incident ids are stable, epoch-derived strings (no randomness)', () => {
  const ids = buildTrendReport(fixtureTrendInput()).incidents.map((incident) => incident.incidentId);
  const pattern = /^inc\/(qc-flag|correction|known-issue|curve-supersession)\/[a-z0-9-]+\/[A-Za-z0-9._-]+\/\d+$/;
  for (const id of ids) assert.match(id, pattern);
  assert.equal(new Set(ids).size, ids.length);
});
