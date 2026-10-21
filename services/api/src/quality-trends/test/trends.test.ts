/**
 * Dedupe and reconciliation suite (WD-013-R2; FR-043; verification T-15).
 *
 * The load-bearing assertion set of the feature: the fixture's 27 reviewed
 * records (20 QC hits + 4 revisions + 2 known issues + 1 rating-version
 * supersession) collapse into 18 incidents - the two-corrections chain is
 * ONE incident, never one row per revision - and the arithmetic balances
 * exactly: attributed + duplicates dropped + unattributed == raw records,
 * with no id counted twice and no phantom id.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/quality-trends/test/trends.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTrendReport,
  deriveIncidents,
  reconcileTrends,
  type TrendIncident,
} from '../trends.ts';
import {
  advancingClock,
  buildTrendsWorld,
  fixtureTrendInput,
  NOW,
  rawRecordCount,
  reviewedQcHits,
} from './helpers.ts';

function incidentOf(incidents: readonly TrendIncident[], kind: TrendIncident['kind'], causeKey: string): TrendIncident {
  const found = incidents.find((incident) => incident.kind === kind && incident.causeKey === causeKey);
  assert.ok(found, `expected ${kind} incident with cause key ${causeKey}`);
  return found;
}

test('FR-043 dedupe: the two-corrections chain on obs-q-032 is ONE incident, never one row per revision', () => {
  const input = fixtureTrendInput();
  const incidents = deriveIncidents(input);
  const chain = incidentOf(incidents, 'correction', 'obs-q-032');
  // rev-corinne-2001 (correction) AND rev-corinne-2004 (level-advance of the
  // same point) are two evidence records of ONE incident.
  assert.equal(chain.hitCount, 2);
  assert.deepEqual(chain.evidenceIds, ['rev-corinne-2001', 'rev-corinne-2004']);
  // Diagnostic span is anchored on OBSERVATION time; the latest REVISION
  // time is carried separately (time discipline, technical specification).
  assert.equal(chain.firstSeen, '2026-03-08T02:00:00Z');
  assert.equal(chain.lastSeen, '2026-03-08T02:00:00Z');
  assert.equal(chain.lastRecordedAt, '2026-03-09T06:20:00Z');
  assert.equal(chain.streamId, 'str-corinne-q');
  assert.equal(chain.stationId, 'sta-bear-corinne');
  // The other two fixture revisions are their own single-hit incidents.
  assert.equal(incidentOf(incidents, 'correction', 'obs-q-042').hitCount, 1);
  assert.equal(incidentOf(incidents, 'correction', 'obs-q-019').hitCount, 1);
  // Net effect: 4 revision records -> 3 correction incidents.
  assert.equal(incidents.filter((incident) => incident.kind === 'correction').length, 3);
});

test('FR-043 dedupe: qc hits cluster by family within the gap window, never one row per hit', () => {
  const incidents = deriveIncidents(fixtureTrendInput());
  // The stage stream's three missing-data gaps (each only 1 h apart end to
  // start) chain into ONE 3-hit incident - a recurring coverage story.
  const stageMissing = incidents.find(
    (incident) => incident.kind === 'qc-flag' && incident.streamId === 'str-corinne-stage' && incident.causeKey === 'missing-data',
  );
  assert.ok(stageMissing);
  assert.equal(stageMissing.hitCount, 3);
  assert.equal(stageMissing.firstSeen, '2026-03-07T13:00:00Z');
  // The span covers the evidence intervals: it ends with the last gap's end.
  assert.equal(stageMissing.lastSeen, '2026-03-09T06:00:00Z');
  // The internal voltage stream: 4 chained missing gaps + 1 range hit.
  const voltageMissing = incidents.find(
    (incident) => incident.kind === 'qc-flag' && incident.streamId === 'str-diag-voltage' && incident.causeKey === 'missing-data',
  );
  assert.ok(voltageMissing);
  assert.equal(voltageMissing.hitCount, 4);
  // The telemetry stream's missing-data hits SPLIT on the 6 h gap: the two
  // irregular-interval gaps and the outage gap (ONE reviewed violation
  // record covering 6 missing readings) are three separate incidents.
  const corinneMissing = incidents
    .filter((incident) => incident.kind === 'qc-flag' && incident.streamId === 'str-corinne-q' && incident.causeKey === 'missing-data')
    .sort((a, b) => (a.incidentId < b.incidentId ? -1 : 1));
  assert.equal(corinneMissing.length, 3);
  assert.deepEqual(corinneMissing.map((incident) => incident.hitCount), [1, 1, 1]);
  assert.deepEqual(corinneMissing.map((incident) => incident.firstSeen), [
    '2026-03-07T06:00:00Z',
    '2026-03-07T14:00:00Z',
    '2026-03-08T12:00:00Z',
  ]);
  // Rate-of-change hits cluster around each of the three events (zero,
  // negative spike, out-of-range spike): 3 incidents of 2 hits each.
  const corinneRate = incidents.filter(
    (incident) => incident.kind === 'qc-flag' && incident.streamId === 'str-corinne-q' && incident.causeKey === 'rate-of-change',
  );
  assert.equal(corinneRate.length, 3);
  for (const incident of corinneRate) assert.equal(incident.hitCount, 2);
});

test('FR-043 reconciliation: 27 reviewed records collapse to 18 incidents and the arithmetic balances EXACTLY', () => {
  const input = fixtureTrendInput();
  const report = buildTrendReport(input);
  const reconciliation = reconcileTrends(input, report.incidents);
  // 20 QC hits + 4 revisions + 2 known issues + 1 supersession = 27 raw.
  assert.equal(rawRecordCount(input), 27);
  assert.equal(reconciliation.rawRecordCount, 27);
  assert.equal(reconciliation.incidentCount, 18);
  assert.equal(reconciliation.attributedCount, 27);
  assert.equal(reconciliation.duplicatesDropped, 0);
  assert.equal(reconciliation.unattributedCount, 0);
  assert.equal(reconciliation.balanced, true);
  assert.deepEqual(reconciliation.doubleCountedIds, []);
  assert.deepEqual(reconciliation.phantomIds, []);
  // Incident counts by kind: 12 qc-flag, 3 correction, 2 known-issue,
  // 1 curve-supersession (evidence totals 20 + 4 + 2 + 1 = 27).
  const byKind = { 'qc-flag': 0, correction: 0, 'known-issue': 0, 'curve-supersession': 0 } as Record<string, number>;
  const hitsByKind = { ...byKind };
  for (const incident of report.incidents) {
    byKind[incident.kind] += 1;
    hitsByKind[incident.kind] += incident.hitCount;
  }
  assert.deepEqual(byKind, { 'qc-flag': 12, correction: 3, 'known-issue': 2, 'curve-supersession': 1 });
  assert.deepEqual(hitsByKind, { 'qc-flag': 20, correction: 4, 'known-issue': 2, 'curve-supersession': 1 });
  // The curve-supersession incident reconciles to the WD-011-R2 rating
  // records: evidence is exactly the closed seeded version.
  const supersession = incidentOf(report.incidents, 'curve-supersession', 'rc-corinne-2019');
  assert.equal(supersession.hitCount, 1);
  assert.deepEqual(supersession.evidenceIds, ['rc-corinne-2019']);
});

test('FR-043 reconciliation: a re-delivered QC run collapses (dedupe), counts stay exact', () => {
  const base = fixtureTrendInput();
  // The whole 20-hit QC run is delivered a second time under the same ids.
  const replayed = fixtureTrendInput({ qcHits: [...reviewedQcHits(), ...reviewedQcHits()] });
  const incidents = deriveIncidents(replayed);
  const reconciliation = reconcileTrends(replayed, incidents);
  assert.equal(reconciliation.rawRecordCount, 47);
  assert.equal(reconciliation.duplicatesDropped, 20);
  assert.equal(reconciliation.attributedCount, 27);
  assert.equal(reconciliation.incidentCount, 18);
  assert.equal(reconciliation.balanced, true);
  // Byte-identical incident list to the single-delivery derivation.
  assert.deepEqual(incidents, deriveIncidents(base));
});

test('FR-043 reconciliation: records on unknown streams never list, and still balance', () => {
  const input = fixtureTrendInput({
    qcHits: [
      ...reviewedQcHits(),
      { hitId: 'qc:range:str-ghost:2026-03-09T00:00:00Z', streamId: 'str-ghost', family: 'range', interval: { start: '2026-03-09T00:00:00Z', end: '2026-03-09T01:00:00Z' } },
    ],
  });
  const incidents = deriveIncidents(input);
  assert.ok(incidents.every((incident) => incident.streamId !== 'str-ghost'));
  const reconciliation = reconcileTrends(input, incidents);
  assert.equal(reconciliation.rawRecordCount, 28);
  assert.equal(reconciliation.unattributedCount, 1);
  assert.equal(reconciliation.attributedCount, 27);
  assert.equal(reconciliation.balanced, true);
});

test('FR-043 reconciliation: an exact duplicate on an UNKNOWN stream counts in exactly ONE bucket (DEFECT-R2-2 regression)', () => {
  // One record delivered twice on a stream absent from the site table: the
  // unique evidence id counts ONCE as unattributed, and the duplicate copy
  // counts ONCE as duplicatesDropped - never both per copy, which used to
  // push attributed + duplicates + unattributed past the raw count and flip
  // balanced to false on this input class.
  const input = fixtureTrendInput({
    qcHits: [
      ...reviewedQcHits(),
      { hitId: 'qc:range:str-ghost:2026-03-09T00:00:00Z', streamId: 'str-ghost', family: 'range', interval: { start: '2026-03-09T00:00:00Z', end: '2026-03-09T01:00:00Z' } },
      { hitId: 'qc:range:str-ghost:2026-03-09T00:00:00Z', streamId: 'str-ghost', family: 'range', interval: { start: '2026-03-09T00:00:00Z', end: '2026-03-09T01:00:00Z' } },
    ],
  });
  const report = buildTrendReport(input);
  const reconciliation = reconcileTrends(input, report.incidents);
  assert.equal(reconciliation.rawRecordCount, 29, 'precondition: 27 fixture records + two deliveries of the ghost-stream record');
  assert.equal(reconciliation.duplicatesDropped, 1, 'the second delivery is a duplicate');
  assert.equal(reconciliation.unattributedCount, 1, 'the unknown-stream record is unattributed ONCE (per unique evidence id)');
  assert.equal(reconciliation.attributedCount, 27);
  assert.equal(reconciliation.balanced, true, '27 + 1 + 1 == 29: each record counted in exactly one bucket');
  assert.deepEqual(reconciliation.doubleCountedIds, []);
  assert.deepEqual(reconciliation.phantomIds, []);
  // Mixed classes together stay exact too: duplicates on KNOWN and UNKNOWN
  // streams in one corpus.
  const mixed = fixtureTrendInput({
    qcHits: [
      ...reviewedQcHits(),
      reviewedQcHits()[0]!, // exact duplicate on a KNOWN stream
      { hitId: 'qc:rate:str-ghost:2026-03-09T02:00:00Z', streamId: 'str-ghost', family: 'rate', interval: { start: '2026-03-09T02:00:00Z', end: '2026-03-09T03:00:00Z' } },
      { hitId: 'qc:rate:str-ghost:2026-03-09T02:00:00Z', streamId: 'str-ghost', family: 'rate', interval: { start: '2026-03-09T02:00:00Z', end: '2026-03-09T03:00:00Z' } },
      { hitId: 'qc:rate:str-ghost:2026-03-09T02:00:00Z', streamId: 'str-ghost', family: 'rate', interval: { start: '2026-03-09T02:00:00Z', end: '2026-03-09T03:00:00Z' } },
    ],
  });
  const mixedReconciliation = reconcileTrends(mixed, deriveIncidents(mixed));
  assert.equal(mixedReconciliation.rawRecordCount, 31); // 27 + 1 + 3
  assert.equal(mixedReconciliation.duplicatesDropped, 3); // one copy of the known-stream hit + two extra ghost copies
  assert.equal(mixedReconciliation.unattributedCount, 1); // the ghost evidence id, once
  assert.equal(mixedReconciliation.attributedCount, 27); // the duplicated known-stream hit still counts exactly once
  assert.equal(mixedReconciliation.balanced, true);
});

test('recurrence metrics: counts by kind, recurrence rate per week and time-since-last per site', () => {
  const report = buildTrendReport(fixtureTrendInput());
  const row = (stationId: string, kind: string) => {
    const found = report.kindRecurrence.find(
      (summary) => summary.stationId === stationId && summary.kind === kind,
    );
    assert.ok(found, `expected recurrence row ${stationId}/${kind}`);
    return found;
  };
  // sta-bear-corinne: 10 qc-flag incidents (9 telemetry + 1 stage chain)
  // spanning 03-07T06:00 -> 03-09T06:00 (48 h, the stage chain ends last):
  // 9 recurrences per 48/168 weeks.
  const corinneQc = row('sta-bear-corinne', 'qc-flag');
  assert.equal(corinneQc.incidentCount, 10);
  assert.equal(corinneQc.firstSeen, '2026-03-07T06:00:00Z');
  assert.equal(corinneQc.lastSeen, '2026-03-09T06:00:00Z');
  const weeks = (Date.parse('2026-03-09T06:00:00Z') - Date.parse('2026-03-07T06:00:00Z')) / (7 * 24 * 60 * 60_000);
  assert.ok(Math.abs(corinneQc.recurrenceRatePerWeek - 9 / weeks) < 1e-9);
  // Time since last: NOW (03-09T07:00) minus 03-09T06:00 = 1 h.
  assert.equal(corinneQc.timeSinceLastMs, 1 * 60 * 60_000);
  // Corrections: 3 incidents over 30 h -> 2 recurrences per 30/168 weeks;
  // singletons (known-issue, curve-supersession) have not recurred: rate 0.
  const corinneCorrections = row('sta-bear-corinne', 'correction');
  assert.equal(corinneCorrections.incidentCount, 3);
  assert.equal(corinneCorrections.recurrenceRatePerWeek > 0, true);
  assert.equal(row('sta-bear-corinne', 'curve-supersession').recurrenceRatePerWeek, 0);
  // The internal diagnostic site carries 2 qc-flag incidents and its
  // internal known issue (full-report view; visibility tested separately).
  const voltageQc = row('sta-bear-lake-diagnostic', 'qc-flag');
  assert.equal(voltageQc.incidentCount, 2);
  assert.equal(row('sta-bear-lake-diagnostic', 'known-issue').incidentCount, 1);
});

test('site x period trends: 18 incidents land in the current 7-day bucket with counts by kind', () => {
  const report = buildTrendReport(fixtureTrendInput());
  // Everything happened inside the last 7 days before the fixture clock.
  assert.deepEqual(report.sitePeriods.map((period) => period.periodIndex), [0, 0]);
  const corinne = report.sitePeriods.find((period) => period.stationId === 'sta-bear-corinne');
  const diagnostic = report.sitePeriods.find((period) => period.stationId === 'sta-bear-lake-diagnostic');
  assert.ok(corinne && diagnostic);
  assert.deepEqual(corinne.periodStart, '2026-03-02T07:00:00Z');
  assert.deepEqual(corinne.periodEnd, NOW);
  assert.deepEqual(corinne.incidentCounts, { 'qc-flag': 10, correction: 3, 'known-issue': 1, 'curve-supersession': 1 });
  assert.equal(corinne.totalIncidents, 15);
  assert.deepEqual(diagnostic.incidentCounts, { 'qc-flag': 2, correction: 0, 'known-issue': 1, 'curve-supersession': 0 });
  assert.equal(diagnostic.totalIncidents, 3);
});

test('order independence: shuffled input records derive the identical incident list', () => {
  const input = fixtureTrendInput();
  const shuffled = fixtureTrendInput({
    qcHits: [...input.qcHits!].reverse(),
    corrections: [...input.corrections!].reverse(),
    knownIssues: [...input.knownIssues!].reverse(),
  });
  assert.deepEqual(deriveIncidents(shuffled), deriveIncidents(input));
});

test('rolling window: incidents older than the window flag out but still reconcile', () => {
  // A 6-hour window ending at the fixture clock keeps everything whose span
  // ENDS at/after 03-09T01:00 - the two voltage clusters, the internal known
  // issue and the stage missing-data chain (ends 03-09T06:00).
  const report = buildTrendReport(fixtureTrendInput({ windowMs: 6 * 60 * 60_000 }));
  const inWindow = report.incidents.filter((incident) => incident.inWindow);
  assert.equal(inWindow.length, 4);
  assert.deepEqual(
    inWindow.map((incident) => incident.incidentId).sort(),
    [
      'inc/known-issue/str-diag-voltage/issue-000002/1773036000000',
      'inc/qc-flag/str-corinne-stage/missing-data/1772888400000',
      'inc/qc-flag/str-diag-voltage/missing-data/1772888400000',
      'inc/qc-flag/str-diag-voltage/range/1773036000000',
    ],
  );
  // Recurrence metrics only cover in-window incidents: the two voltage
  // qc-flag incidents group into one row (2), the stage chain and the known
  // issue each stay singletons.
  assert.equal(report.kindRecurrence.length, 3);
  assert.equal(report.kindRecurrence.find((row) => row.stationId === 'sta-bear-lake-diagnostic' && row.kind === 'qc-flag')!.incidentCount, 2);
  // Full reconciliation is unaffected by the window.
  const reconciliation = reconcileTrends(fixtureTrendInput({ windowMs: 6 * 60 * 60_000 }), report.incidents);
  assert.equal(reconciliation.balanced, true);
  assert.equal(reconciliation.attributedCount, 27);
});

test('the advancing fixture clock stays deterministic for known-issue seeding', () => {
  const clock = advancingClock();
  assert.equal(clock.clock(), NOW);
  clock.advanceMinutes(30);
  assert.equal(clock.clock(), '2026-03-09T07:30:00Z');
  // The helper world resolves the fixture personas (used by visibility suite).
  const world = buildTrendsWorld();
  assert.equal(world.principals['principal-fatima-engineer']?.assignedSystemId, 'sys-bear-river');
});
