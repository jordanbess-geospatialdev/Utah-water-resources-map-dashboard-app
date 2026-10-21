/**
 * Visibility suite (WD-013-R2; FR-043 acceptance): restricted and internal
 * sites NEVER appear in public trend outputs - proven by a byte sweep of the
 * serialized projection - and the engine decides scope for signed-in staff:
 * anonymous callers receive public sites only, the assigned Bear engineer
 * sees their whole Bear scope, the Bear commissioner sees the restricted
 * owner stream but not internal diagnostics, and the out-of-scope Weber
 * engineer receives none of the protected Bear sites.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/quality-trends/test/visibility.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTrendReport, type TrendInput } from '../trends.ts';
import { publicTrendReport, trendReportFor } from '../visibility.ts';
import {
  buildTrendsWorld,
  CODY,
  FATIMA,
  fixtureTrendInput,
  NINA,
  NOW,
} from './helpers.ts';

const INTERNAL_ISSUE_TITLE = 'Battery voltage sagging below minimum';
const OWNER_QC_HIT = 'qc:range:str-hyrum-q-owner:2026-03-08T17:00:00Z';
const OWNER_REVISION = 'rev-hyrum-owner-9001';

/**
 * The fixture trend input plus protected-site records: an out-of-range QC hit
 * and a correction on the RESTRICTED owner stream, so the sweep has real
 * restricted bytes to catch. (The internal voltage stream already carries
 * five QC hits and the internal known issue from the fixture input.)
 */
function inputWithProtectedSites(): TrendInput {
  const base = fixtureTrendInput();
  return {
    ...base,
    qcHits: [
      ...base.qcHits!,
      { hitId: OWNER_QC_HIT, streamId: 'str-hyrum-q-owner', family: 'range', interval: { start: '2026-03-08T17:00:00Z', end: '2026-03-08T17:30:00Z' } },
    ],
    corrections: [
      ...base.corrections!,
      {
        revisionId: OWNER_REVISION,
        targetObservationId: 'obs-ho-002',
        streamId: 'str-hyrum-q-owner',
        observedAt: '2026-03-08T17:00:00Z',
        recordedAt: '2026-03-09T02:00:00Z',
        type: 'correction',
        actorId: 'principal-cody-commissioner',
      },
    ],
  };
}

function deps() {
  return { world: buildTrendsWorld(), clock: () => NOW };
}

test('public projection: restricted and internal sites NEVER appear (byte sweep)', () => {
  const report = buildTrendReport(inputWithProtectedSites());
  const projection = publicTrendReport(report);
  // Only the public Corinne site survives (its stage stream included).
  assert.deepEqual(
    projection.sitePeriods.map((period) => period.stationId),
    ['sta-bear-corinne'],
  );
  const serialized = JSON.stringify(projection);
  const forbidden = [
    'str-hyrum-q-owner',        // the restricted owner stream
    'sta-hyrum-diversion-owner',// the restricted site
    OWNER_QC_HIT,               // the restricted QC record
    OWNER_REVISION,             // the restricted correction record
    'obs-ho-002',               // the restricted target observation
    'str-diag-voltage',         // the internal diagnostic stream
    'sta-bear-lake-diagnostic', // the internal site
    'issue-000002',             // the internal known issue id
    INTERNAL_ISSUE_TITLE,       // the internal known issue title
  ];
  for (const bytes of forbidden) {
    assert.ok(!serialized.includes(bytes), `public trend output must not contain "${bytes}"`);
  }
  // The public site's own bytes ARE present.
  assert.ok(serialized.includes('sta-bear-corinne'));
  assert.ok(serialized.includes('qc-flag'));
  assert.ok(serialized.includes('correction'));
});

test('public projection aggregates reconcile to the public sites\' records only', () => {
  const input = inputWithProtectedSites();
  const projection = publicTrendReport(buildTrendReport(input));
  // Attributed evidence == every raw record on a public stream.
  const publicStreams = new Set(
    Object.values(input.streamMeta).filter((meta) => meta.visibility === 'public').map((meta) => meta.streamId),
  );
  const expected =
    input.qcHits!.filter((hit) => publicStreams.has(hit.streamId)).length +
    input.corrections!.filter((event) => publicStreams.has(event.streamId)).length +
    input.knownIssues!.filter((issue) => publicStreams.has(issue.streamId) && issue.visibility === 'public').length +
    input.curveSupersessions!.filter((event) => publicStreams.has(event.streamId)).length;
  const attributed = projection.incidents.reduce((sum, incident) => sum + incident.hitCount, 0);
  assert.equal(attributed, expected);
  // 29 raw records, of which 2 owner + 5 voltage QC + 1 internal issue are
  // withheld: 21 attributed in the public projection.
  assert.equal(attributed, 21);
});

test('anonymous callers receive exactly the public projection through the engine path', () => {
  const report = buildTrendReport(inputWithProtectedSites());
  const anonymous = trendReportFor(deps(), null, report);
  assert.deepEqual(anonymous, publicTrendReport(report));
});

test('the assigned Bear engineer sees their full scope: restricted owner stream AND internal diagnostics', () => {
  const report = buildTrendReport(inputWithProtectedSites());
  const fatima = trendReportFor(deps(), FATIMA, report);
  // Nothing withheld: the projection equals the full report.
  assert.deepEqual(fatima, report);
  assert.ok(fatima.incidents.some((incident) => incident.streamId === 'str-hyrum-q-owner'));
  assert.ok(fatima.incidents.some((incident) => incident.streamId === 'str-diag-voltage'));
  const internalIssue = fatima.incidents.find((incident) => incident.recordVisibility === 'internal');
  assert.ok(internalIssue);
  assert.equal(internalIssue.causeLabel, INTERNAL_ISSUE_TITLE);
});

test('the Bear commissioner sees the restricted owner stream but NOT internal diagnostics', () => {
  const report = buildTrendReport(inputWithProtectedSites());
  const cody = trendReportFor(deps(), CODY, report);
  assert.ok(cody.incidents.some((incident) => incident.streamId === 'str-hyrum-q-owner'));
  assert.ok(cody.incidents.every((incident) => incident.streamId !== 'str-diag-voltage'));
  assert.ok(cody.incidents.every((incident) => incident.recordVisibility !== 'internal'));
});

test('the out-of-scope Weber engineer receives none of the protected Bear sites', () => {
  const report = buildTrendReport(inputWithProtectedSites());
  const nina = trendReportFor(deps(), NINA, report);
  // Public Bear sites only: internal diagnostics never cross systems even
  // though Nina HOLDS view-internal-diagnostics (scoped to sys-weber-river).
  assert.deepEqual(nina, publicTrendReport(report));
  const serialized = JSON.stringify(nina);
  assert.ok(!serialized.includes('str-hyrum-q-owner'));
  assert.ok(!serialized.includes('str-diag-voltage'));
});
