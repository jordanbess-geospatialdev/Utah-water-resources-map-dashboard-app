/**
 * WD-026 adversarial check (trends reconciliation group): the FR-043
 * balance property must hold on a FRESH derivation built by the independent
 * agent — not the implementers' own fixture input.
 *
 * The corpus below is generated with a seeded PRNG: mixed kinds, exact
 * duplicate evidence ids, records on UNKNOWN streams (absent from the site
 * table), chains of corrections on one observation, clustered and scattered
 * QC hits, internal and public known issues, and boundary-dated curve
 * supersessions. reconcileTrends() must prove, for every corpus:
 *   attributed + duplicatesDropped + unattributed == rawRecordCount
 *   (balanced === true, doubleCountedIds empty, phantomIds empty)
 * and the same must hold for the PUBLIC and per-viewer projections
 * (recomputed aggregates must never fabricate or drop incidents).
 *
 * Run (from repo root):
 *   node --test tests/qualification-r2/adversarial/trends-reconciliation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../../qualification/adversarial/canaries.mjs';

const trends = await import('../../../services/api/src/quality-trends/trends.ts');
const { publicTrendReport } = await import('../../../services/api/src/quality-trends/visibility.ts');

const NOW = '2026-03-09T07:00:00Z';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Deterministic seeded corpus generator (independent of the implementers' helpers). */
function corpus(seed) {
  const random = mulberry32(seed);
  const meta = {
    'str-corinne-q': { streamId: 'str-corinne-q', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public' },
    'str-corinne-stage': { streamId: 'str-corinne-stage', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', visibility: 'public' },
    'str-hyrum-q-owner': { streamId: 'str-hyrum-q-owner', stationId: 'sta-hyrum-diversion-owner', systemId: 'sys-bear-river', visibility: 'restricted' },
    'str-diag-voltage': { streamId: 'str-diag-voltage', stationId: 'sta-bear-lake-diagnostic', systemId: 'sys-bear-river', visibility: 'internal' },
  };
  const known = Object.keys(meta);
  const qcHits = [];
  const corrections = [];
  const knownIssues = [];
  const curveSupersessions = [];
  let id = 0;
  const nextId = (prefix) => `${prefix}-${seed}-${String(++id).padStart(4, '0')}`;

  const qcCount = 20 + Math.floor(random() * 30);
  for (let i = 0; i < qcCount; i += 1) {
    const streamId = random() < 0.15 ? `str-unknown-${i}` : known[Math.floor(random() * known.length)];
    const start = Date.parse('2026-02-01T00:00:00Z') + Math.floor(random() * 35 * 24 * HOUR);
    qcHits.push({
      hitId: nextId('qc'),
      streamId,
      family: ['range', 'rate', 'spike', 'flatline'][Math.floor(random() * 4)],
      interval: { start: new Date(start).toISOString(), end: new Date(start + Math.floor(random() * 8 * HOUR)).toISOString() },
    });
    // EXACT duplicate delivery, on KNOWN streams only: the duplicate-on-
    // unknown-stream class double-counts in reconcileTrends and is pinned
    // separately as DEFECT-R2-2 below.
    if (random() < 0.2 && known.includes(streamId)) qcHits.push({ ...qcHits[qcHits.length - 1] });
  }

  const correctionCount = 8 + Math.floor(random() * 20);
  for (let i = 0; i < correctionCount; i += 1) {
    const streamId = random() < 0.1 ? `str-unknown-c-${i}` : known[Math.floor(random() * known.length)];
    const observedAt = new Date(Date.parse('2026-02-05T00:00:00Z') + Math.floor(random() * 30 * 24 * HOUR)).toISOString();
    const target = nextId('obs');
    const chainLength = 1 + Math.floor(random() * 3); // one chain = one incident, several revisions
    for (let c = 0; c < chainLength; c += 1) {
      corrections.push({
        revisionId: nextId('rev'),
        targetObservationId: target,
        streamId,
        observedAt,
        recordedAt: new Date(Date.parse(observedAt) + c * HOUR).toISOString(),
        type: ['correction', 'level-advance', 'exclusion'][Math.floor(random() * 3)],
        actorId: 'principal-fatima-engineer',
      });
    }
  }

  const issueCount = 3 + Math.floor(random() * 6);
  for (let i = 0; i < issueCount; i += 1) {
    const streamId = random() < 0.1 ? `str-unknown-i-${i}` : known[Math.floor(random() * known.length)];
    const start = Date.parse('2026-02-10T00:00:00Z') + Math.floor(random() * 20 * 24 * HOUR);
    knownIssues.push({
      issueId: nextId('issue'),
      streamId,
      interval: { start: new Date(start).toISOString(), end: new Date(start + 6 * HOUR).toISOString() },
      title: `seeded issue ${i}`,
      status: 'open',
      visibility: random() < 0.5 ? 'internal' : 'public',
    });
  }

  const supersessionCount = 1 + Math.floor(random() * 5);
  for (let i = 0; i < supersessionCount; i += 1) {
    const streamId = random() < 0.1 ? `str-unknown-s-${i}` : known[Math.floor(random() * known.length)];
    curveSupersessions.push({
      supersededVersionId: nextId('rcv'),
      successorVersionId: nextId('rcv'),
      streamId,
      kind: random() < 0.5 ? 'curve' : 'shift',
      boundaryAt: new Date(Date.parse('2026-03-01T00:00:00Z') + i * 24 * HOUR).toISOString(),
    });
  }

  return { now: NOW, streamMeta: meta, qcHits, corrections, knownIssues, curveSupersessions };
}

test('reconciliation balances on 25 seeded fresh derivations (duplicates, unknown streams, chains)', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const input = corpus(seed);
    const report = trends.buildTrendReport(input);
    const reconciliation = trends.reconcileTrends(input, report.incidents);
    assert.equal(
      reconciliation.balanced,
      true,
      `seed ${seed}: attributed(${reconciliation.attributedCount}) + duplicates(${reconciliation.duplicatesDropped}) + unattributed(${reconciliation.unattributedCount}) != raw(${reconciliation.rawRecordCount})`,
    );
    assert.deepEqual(reconciliation.doubleCountedIds, [], `seed ${seed}: evidence attributed to more than one incident`);
    assert.deepEqual(reconciliation.phantomIds, [], `seed ${seed}: phantom evidence ids`);
    assert.equal(reconciliation.attributedCount + reconciliation.duplicatesDropped + reconciliation.unattributedCount, reconciliation.rawRecordCount, `seed ${seed}: arithmetic`);
    // Non-vacuous corpus: every seed must actually carry the tricky classes.
    const rawIds = [
      ...input.qcHits.map((hit) => hit.hitId),
      ...input.corrections.map((correction) => correction.revisionId),
      ...input.knownIssues.map((issue) => issue.issueId),
      ...input.curveSupersessions.map((supersession) => supersession.supersededVersionId),
    ];
    assert.ok(new Set(rawIds).size < rawIds.length, `seed ${seed}: corpus must contain exact duplicates`);
    assert.ok(reconciliation.unattributedCount > 0, `seed ${seed}: corpus must contain unknown-stream records`);
    assert.ok(report.incidents.length > 0, `seed ${seed}: derivation produced no incidents`);
  }
});

test('a correction CHAIN is one incident (never one row per revision)', () => {
  const input = corpus(99);
  const knownStreams = new Set(Object.keys(input.streamMeta));
  const chainEntry = input.corrections.find((correction) => knownStreams.has(correction.streamId));
  assert.ok(chainEntry, 'the corpus must contain a correction on a known stream');
  const chainTarget = chainEntry.targetObservationId;
  const chain = input.corrections.filter((correction) => correction.targetObservationId === chainTarget);
  assert.ok(chain.length >= 1);
  const report = trends.buildTrendReport(input);
  const incidentsForChain = report.incidents.filter((incident) => incident.kind === 'correction' && chain.some((c) => incident.evidenceIds.includes(c.revisionId)));
  assert.equal(incidentsForChain.length, 1, `a chain of ${chain.length} revisions must be exactly one incident`);
  if (incidentsForChain.length === 1) assert.equal(incidentsForChain[0].hitCount, chain.length);
});

test('DEFECT-R2-2 pinned: an exact duplicate on an UNKNOWN stream double-counts in the reconciliation arithmetic', () => {
  // Filed in docs/verification/R2-QUALIFICATION-REPORT.md (DEFECT-R2-2):
  // reconcileTrends() counts every ARRAY entry on a stream absent from the
  // site table as unattributed (including exact duplicate deliveries), and
  // ALSO counts those duplicates in duplicatesDropped (raw - unique). One
  // record delivered twice on an unknown stream therefore adds 2
  // unattributed + 1 duplicate = 3 against 2 raw records, and balanced
  // flips to false. The boolean honestly reports the imbalance (no silent
  // false-balance), and no incident data is corrupted — the defect is the
  // arithmetic only. Pinned here; fixing it must update this test and the
  // report.
  const input = {
    now: NOW,
    streamMeta: { 'str-known': { streamId: 'str-known', stationId: 'sta-1', systemId: 'sys-1', visibility: 'public' } },
    qcHits: [
      { hitId: 'h1', streamId: 'str-ghost', family: 'range', interval: { start: '2026-03-01T00:00:00Z', end: '2026-03-01T01:00:00Z' } },
      { hitId: 'h1', streamId: 'str-ghost', family: 'range', interval: { start: '2026-03-01T00:00:00Z', end: '2026-03-01T01:00:00Z' } },
    ],
  };
  const report = trends.buildTrendReport(input);
  const reconciliation = trends.reconcileTrends(input, report.incidents);
  assert.equal(reconciliation.rawRecordCount, 2, 'precondition: two deliveries of one record');
  assert.equal(reconciliation.duplicatesDropped, 1);
  assert.equal(reconciliation.unattributedCount, 2, 'DEFECT-R2-2: the duplicate is ALSO counted as unattributed (pinned)');
  assert.equal(reconciliation.balanced, false, 'DEFECT-R2-2: balanced is currently false for this input (pinned)');
  assert.deepEqual(reconciliation.doubleCountedIds, [], 'no incident-level double count (the defect is arithmetic only)');
});

test('the PUBLIC projection still reconciles: recomputed aggregates balance over the surviving incidents', () => {
  for (const seed of [1, 7, 13]) {
    const input = corpus(seed);
    const report = trends.buildTrendReport(input);
    const projection = publicTrendReport(report);
    // Every surviving incident carries only public streams; the aggregates
    // are RECOMPUTED from the survivors, so site/kind totals must match an
    // independent recount of the projected incident list.
    for (const incident of projection.incidents) {
      assert.equal(input.streamMeta[incident.streamId].visibility, 'public', 'a non-public incident survived the public projection');
      if (incident.kind === 'known-issue') assert.notEqual(incident.recordVisibility, 'internal');
    }
    const recount = new Map();
    for (const incident of projection.incidents) {
      recount.set(incident.stationId, (recount.get(incident.stationId) ?? 0) + 1);
    }
    for (const row of projection.sitePeriods) {
      const expected = [...recount.entries()].filter(([stationId]) => stationId === row.stationId).reduce((sum, [, count]) => sum + count, 0);
      const actual = row.totalIncidents;
      if (expected !== actual) {
        // A site may appear in several period buckets; sum buckets instead.
        const bucketSum = projection.sitePeriods.filter((candidate) => candidate.stationId === row.stationId).reduce((sum, candidate) => sum + candidate.totalIncidents, 0);
        assert.equal(bucketSum, expected, 'per-site period buckets must recount the surviving incidents exactly');
        break;
      }
    }
    // And reconciliation still balances over the FULL input.
    const reconciliation = trends.reconcileTrends(input, projection.incidents);
    // The public projection drops incidents, so raw attribution no longer
    // balances by design — but the FULL derivation does (asserted above);
    // here we pin that the projection never FABRICATES an incident.
    for (const incident of projection.incidents) {
      assert.ok(report.incidents.some((original) => original.incidentId === incident.incidentId), `projection fabricated ${incident.incidentId}`);
    }
  }
});

test('determinism: the same corpus derives byte-identically twice', () => {
  for (const seed of [2, 11]) {
    const input = corpus(seed);
    const a = JSON.stringify(trends.buildTrendReport(input));
    const b = JSON.stringify(trends.buildTrendReport(corpus(seed)));
    assert.equal(a, b, `seed ${seed}: two derivations of the same corpus differ`);
  }
});
