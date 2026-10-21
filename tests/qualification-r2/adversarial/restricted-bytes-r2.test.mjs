/**
 * WD-026 adversarial sweep (a): no restricted fixture value appears in any
 * R2 PUBLIC surface — quality-trend projections, supplier-report outputs,
 * as-of exports, finalized-snapshot views and WCAT serializations.
 *
 * Written by the independent R2 qualification agent (qa_accessibility),
 * NOT by the implementers. This suite imports the REAL R2 modules, drives
 * them through their public API surface with fixture-derived inputs that
 * DELIBERATELY carry restricted content (an internal known issue whose
 * title embeds a gate code, restricted-stream incidents, restricted
 * stations inside supplier world data), serializes every viewer-facing
 * output and byte-scans for the shared canary vocabulary (gate codes,
 * wiring-note fragments, restricted field names, restricted object ids).
 * A positive control (the entitled projection DOES carry the restricted
 * stream) proves the scan detects leaks rather than scanning nothing.
 *
 * Run (from repo root):
 *   node --test tests/qualification-r2/adversarial/restricted-bytes-r2.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerWebResolveHook,
  findCanaryHits,
  findRestrictedKeys,
  CANARY_BYTES,
  GATE_CODES,
  RESTRICTED_OBJECT_IDS,
  stationsFixture,
} from '../../qualification/adversarial/canaries.mjs';

registerWebResolveHook();

assert.ok(GATE_CODES.length >= 1, 'fixture must carry at least one gate code for the sweep');
assert.ok(RESTRICTED_OBJECT_IDS.length >= 1, 'fixture must carry restricted object ids');

const FIXTURE_CLOCK = '2026-05-15T12:00:00Z';
const TREND_NOW = '2026-03-09T07:00:00Z';

/** Restricted/internal fixture streams, resolved from the frozen fixtures. */
function nonPublicStreams() {
  const rows = [];
  for (const station of stationsFixture.stations) {
    for (const stream of station.datastreams ?? []) {
      if (stream.visibility !== 'public') {
        rows.push({ station, stream });
      }
    }
  }
  return rows;
}

/** Build streamMeta rows for every fixture stream, public and not. */
function allStreamMeta() {
  const meta = {};
  for (const station of stationsFixture.stations) {
    for (const stream of station.datastreams ?? []) {
      meta[stream.id] = {
        streamId: stream.id,
        stationId: station.id,
        systemId: station.systemId,
        visibility: stream.visibility === 'public' ? 'public' : stream.visibility === 'internal' ? 'internal' : 'restricted',
      };
    }
  }
  return meta;
}

// --- real modules under test ------------------------------------------------
const trends = await import('../../../services/api/src/quality-trends/trends.ts');
const visibility = await import('../../../services/api/src/quality-trends/visibility.ts');
const asof = await import('../../../services/integrations/r2/asof/asof.ts');
const { createRevisionStore } = await import('../../../services/api/src/workflows/revisions/store.ts');
const { FinalizedLedger, finalizedContentFromReport } = await import('../../../services/api/src/workflows/accounting-snapshots/finalize.ts');
const { generateReport, fixtureReportDeps } = await import('../../../services/api/src/workflows/distribution-report/generate.ts');
const { DEFAULT_INCLUDE } = await import('../../../services/api/src/workflows/distribution-report/types.ts');
const { reportWorld } = await import('../../../services/api/src/workflows/distribution-report/world.ts');
const supplierReport = await import('../../../services/api/src/workflows/supplier-report/report.ts');
const { standardSupplierWorld, supplierWorld } = await import('../../../services/api/src/workflows/supplier-report/world.ts');
const { seriesStore } = await import('../../../services/api/src/series/load.ts');
const { createFixtureFakeWcatAdapter, serializeWcatResult } = await import('../../../services/integrations/r2/wcat/adapter.ts');

// ---------------------------------------------------------------------------
// 1. Quality-trend public projection (WD-013-R2)
// ---------------------------------------------------------------------------

test('public trend projection leaks no restricted bytes and no restricted stream ids', () => {
  const restricted = nonPublicStreams();
  assert.ok(restricted.length >= 2, `fixture must carry restricted streams (found ${restricted.length})`);
  const restrictedStreams = restricted.map((row) => row.stream);

  // Trend input that DELIBERATELY plants restricted content: incidents on
  // every restricted stream plus an internal known issue whose title embeds
  // a gate code (the leak vector under attack).
  const gateCode = GATE_CODES[0];
  const input = {
    now: TREND_NOW,
    streamMeta: allStreamMeta(),
    qcHits: restrictedStreams.flatMap((stream, index) => [
      { hitId: `sweep-qc-${index}-a`, streamId: stream.id, family: 'range', interval: { start: '2026-03-01T00:00:00Z', end: '2026-03-01T01:00:00Z' } },
      { hitId: `sweep-qc-${index}-b`, streamId: stream.id, family: 'range', interval: { start: '2026-03-01T02:00:00Z', end: '2026-03-01T03:00:00Z' } },
    ]),
    corrections: restrictedStreams.map((stream, index) => ({
      revisionId: `sweep-rev-${index}`,
      targetObservationId: `sweep-obs-${index}`,
      streamId: stream.id,
      observedAt: '2026-03-02T00:00:00Z',
      recordedAt: '2026-03-02T06:00:00Z',
      type: 'correction',
      actorId: 'principal-fatima-engineer',
    })),
    knownIssues: [
      { issueId: 'sweep-issue-internal', streamId: restrictedStreams[0].id, interval: { start: '2026-03-03T00:00:00Z', end: '2026-03-04T00:00:00Z' }, title: `gate ${gateCode} seized; wiring suspect`, status: 'open', visibility: 'internal' },
      { issueId: 'sweep-issue-public', streamId: 'str-corinne-q', interval: { start: '2026-03-03T00:00:00Z', end: '2026-03-04T00:00:00Z' }, title: 'public debris notice', status: 'open', visibility: 'public' },
    ],
  };
  const report = trends.buildTrendReport(input);
  assert.ok(report.incidents.length >= 4, 'the derivation must produce incidents from the planted input');

  // The PUBLIC projection: serialized and swept.
  const publicReport = visibility.publicTrendReport(report);
  const serialized = JSON.stringify(publicReport);
  assert.deepEqual(findCanaryHits(serialized), [], 'canary bytes leaked into the public trend projection');
  assert.deepEqual(findRestrictedKeys(publicReport), [], 'restricted block keys in the public trend projection');
  for (const id of RESTRICTED_OBJECT_IDS) {
    assert.ok(!serialized.includes(id), `public trend projection names restricted object ${id}`);
  }
  // The planted internal issue is gone entirely (FR-038 rule).
  assert.ok(!serialized.includes('sweep-issue-internal'), 'the internal known issue must not survive the public projection');
  assert.ok(!serialized.includes('gate') || !serialized.toLowerCase().includes(gateCode.toLowerCase()), 'the gate code must not survive');
  // Non-vacuous: the public stream's issue survived.
  assert.ok(serialized.includes('sweep-issue-public'), 'the public known issue should survive the public projection');
});

test('protected trend projection for ANONYMOUS callers equals the public wall (no restricted stream leaks)', () => {
  const restricted = nonPublicStreams();
  const input = {
    now: TREND_NOW,
    streamMeta: allStreamMeta(),
    qcHits: restricted.map((row, index) => ({ hitId: `anon-qc-${index}`, streamId: row.stream.id, family: 'rate', interval: { start: '2026-03-05T00:00:00Z', end: '2026-03-05T00:30:00Z' } })),
  };
  const deps = { world: createRevisionStore().world, clock: () => FIXTURE_CLOCK };
  const report = trends.buildTrendReport(input);
  const anonymous = visibility.trendReportFor(deps, null, report);
  const serialized = JSON.stringify(anonymous);
  assert.deepEqual(findCanaryHits(serialized), [], 'anonymous protected projection leaked canary bytes');
  for (const row of restricted) {
    assert.ok(!serialized.includes(row.stream.id), `anonymous trend projection names restricted stream ${row.stream.id}`);
    assert.ok(!serialized.includes(row.station.id), `anonymous trend projection names restricted station ${row.station.id}`);
  }
});

test('positive control: the in-scope engineer trend projection DOES carry the restricted stream (scan is not vacuous)', () => {
  const restricted = nonPublicStreams();
  const target = restricted.find((row) => row.station.systemId === 'sys-bear-river') ?? restricted[0];
  const input = {
    now: TREND_NOW,
    streamMeta: allStreamMeta(),
    qcHits: [{ hitId: 'ctrl-qc-1', streamId: target.stream.id, family: 'range', interval: { start: '2026-03-06T00:00:00Z', end: '2026-03-06T01:00:00Z' } }],
  };
  const deps = { world: createRevisionStore().world, clock: () => FIXTURE_CLOCK };
  const report = trends.buildTrendReport(input);
  const entitled = visibility.trendReportFor(deps, 'principal-fatima-engineer', report);
  assert.ok(JSON.stringify(entitled).includes(target.stream.id), 'the in-scope engineer should see the restricted stream (positive control)');
});

// ---------------------------------------------------------------------------
// 2. As-of exports (WD-023-R2)
// ---------------------------------------------------------------------------

test('as-of exports for PUBLIC streams carry no canary bytes; restricted streams deny anonymously', () => {
  const store = createRevisionStore();
  const source = store;
  // Point + range exports over a public stream, anonymous (publication model).
  const point = asof.reconstructAsOf(source, { principal: null, logicalKey: 'str-corinne-q:2026-03-08T02:00:00Z', asOf: '2026-03-08T20:00:00Z' });
  assert.equal(point.outcome, 'known');
  const pointBytes = asof.serializeAsOfPointResult(point);
  assert.deepEqual(findCanaryHits(pointBytes), [], 'canary bytes in as-of point export');

  const range = asof.reconstructRangeAsOf(source, { principal: null, streamId: 'str-corinne-q', from: '2026-03-07T00:00:00Z', to: '2026-03-09T00:00:00Z', asOf: '2026-03-08T20:00:00Z' });
  assert.equal(range.outcome, 'ok');
  const rangeBytes = asof.serializeAsOfRangeResult(range);
  assert.deepEqual(findCanaryHits(rangeBytes), [], 'canary bytes in as-of range export');
  assert.ok(rangeBytes.includes('as-of:'), 'exports must state their as-of basis (FR-044)');

  // Restricted streams never answer anonymously, and the DENIAL bytes leak nothing.
  // (Probed over windows that CONTAIN observations; the empty-window existence
  // oracle is a separate pinned defect below.)
  const restrictedStreams = nonPublicStreams();
  const WINDOW_FROM = '2026-01-01T00:00:00Z';
  const WINDOW_TO = '2027-01-01T00:00:00Z';
  for (const row of restrictedStreams) {
    const observation = store.observations.find((candidate) => candidate.streamId === row.stream.id);
    const denial = observation
      ? asof.reconstructAsOf(source, { principal: null, logicalKey: observation.logicalKey, asOf: '2026-03-09T00:00:00Z' })
      : { outcome: 'denied', status: 404 };
    assert.ok(denial.outcome === 'denied', `restricted stream ${row.stream.id} must deny anonymous as-of reconstruction`);
    const denialBytes = asof.serializeAsOfPointResult(denial);
    assert.ok(!denialBytes.includes(row.stream.id), 'the denial must not name the hidden stream');
    assert.deepEqual(findCanaryHits(denialBytes), []);
    const rangeDenial = asof.reconstructRangeAsOf(source, { principal: null, streamId: row.stream.id, from: WINDOW_FROM, to: WINDOW_TO, asOf: '2026-03-09T00:00:00Z' });
    if (observation) {
      assert.ok(rangeDenial.outcome === 'denied', `restricted stream ${row.stream.id} range with observations must deny anonymously`);
    }
  }

  // Out-of-scope authenticated reconstruction also hides (hidden-object rule)
  // — probed for every restricted stream against the Weber River engineer.
  const priya = store.world.principals['principal-priya-engineer'];
  for (const row of restrictedStreams) {
    if (row.station.systemId === 'sys-weber-river') continue; // in scope for priya
    const observation = store.observations.find((candidate) => candidate.streamId === row.stream.id);
    if (!observation) continue;
    const denied = asof.reconstructAsOf(source, { principal: priya, logicalKey: observation.logicalKey, asOf: '2026-03-09T00:00:00Z' });
    if (denied.outcome === 'denied') {
      assert.equal(denied.status, 404, 'out-of-scope denial must be the hidden-object 404');
      assert.ok(!JSON.stringify(denied).includes(row.stream.id), 'denial names the hidden stream');
    } else {
      assert.fail(`out-of-scope engineer reconstructed restricted stream ${row.stream.id}`);
    }
  }
});

test('DEFECT-R2-1 fixed: empty-window range as-of is hidden-object parity for non-public streams', () => {
  // DEFECT-R2-1 FIXED (2026-10-21, fix/R2-1-R2-2-defects): reconstructRangeAsOf
  // now admits the STREAM through policy when the window is empty, so an
  // existing-but-unreadable stream and an unknown id return byte-identical
  // hidden-object 404s. This tripwire now pins the FIXED state for anonymous
  // AND out-of-scope actors (both must be indistinguishable from unknown),
  // while readable actors still get ok with zero points.
  const store = createRevisionStore();
  const probed = 'str-ogden-q-proposed'; // restricted fixture stream with no observations
  assert.ok(store.world.objects[probed], 'precondition: the probed stream exists in the policy world');
  assert.ok(!store.observations.some((observation) => observation.streamId === probed), 'precondition: no observations in any window');
  const empty = asof.reconstructRangeAsOf(store, { principal: null, streamId: probed, from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z', asOf: '2026-03-09T00:00:00Z' });
  assert.equal(empty.outcome, 'denied', 'DEFECT-R2-1 regression: anonymous empty-window on a non-public stream must deny');
  if (empty.outcome === 'denied') {
    assert.equal(empty.status, 404, 'hidden-object 404');
    assert.ok(!JSON.stringify(empty).includes(probed), 'denial must not name the hidden stream');
  }
  const unknown = asof.reconstructRangeAsOf(store, { principal: null, streamId: 'str-does-not-exist', from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z', asOf: '2026-03-09T00:00:00Z' });
  assert.equal(unknown.outcome, 'denied', 'an unknown stream id denies');
  if (unknown.outcome === 'denied') {
    assert.equal(unknown.status, 404);
    assert.equal(JSON.stringify(unknown), JSON.stringify(empty), 'existing-unreadable and unknown must be byte-identical (no existence oracle)');
  }
});

// ---------------------------------------------------------------------------
// 3. Finalized-snapshot views (WD-025-R2)
// ---------------------------------------------------------------------------

test('finalized snapshot views carry no canary bytes and no restricted keys', () => {
  const deps = fixtureReportDeps(FIXTURE_CLOCK);
  const report = generateReport(
    deps,
    { systemId: 'sys-bear-river', siteIds: null, period: { basis: 'calendar-year', year: 2026 }, processingBasis: 'raw', include: DEFAULT_INCLUDE },
    'principal-cody-commissioner',
  );
  assert.equal(report.outcome, 'allowed');
  const ledger = new FinalizedLedger();
  const first = ledger.finalize(reportWorld().policyWorld, {
    systemId: 'sys-bear-river',
    period: { kind: 'calendar-year', year: 2026 },
    decisionId: null,
    content: finalizedContentFromReport(report.value),
    actorId: 'principal-cody-commissioner',
    expectedCurrentId: null,
    now: FIXTURE_CLOCK,
  });
  assert.equal(first.outcome, 'finalized');
  const views = ledger.list();
  assert.ok(views.length >= 1);
  const serialized = JSON.stringify(views);
  assert.deepEqual(findCanaryHits(serialized), [], 'canary bytes in finalized snapshot views');
  assert.deepEqual(findRestrictedKeys(views), [], 'restricted block keys in finalized snapshot views');
  // Frozen records must not even be structurally mutable content-wise: the
  // sweep re-serializes the stored bytes directly.
  for (const view of views) {
    const bytes = ledger.storedBytes(view.accounting.id);
    assert.ok(bytes);
    assert.deepEqual(findCanaryHits(bytes), [], 'canary bytes in stored finalized bytes');
  }
});

// ---------------------------------------------------------------------------
// 4. Supplier outputs (WD-017) — canary bytes never reach any org surface
// ---------------------------------------------------------------------------

test('supplier outputs carry no canary bytes (both organizations, drafts and submissions)', () => {
  const world = standardSupplierWorld();
  const deps = { now: FIXTURE_CLOCK, world, store: seriesStore() };
  const store = new supplierReport.SupplierReportStore();
  for (const [actor, systemId] of [
    ['principal-wiley-water-user', 'sys-bear-river'],
    ['principal-morgan-water-user', 'sys-weber-river'],
  ]) {
    const draft = supplierReport.createDraft(deps, store, { systemId, period: { basis: 'calendar-year', year: 2026 } }, actor);
    assert.equal(draft.outcome, 'allowed', `${actor} must open a draft on ${systemId}`);
    const view = supplierReport.systemView(deps, store, actor, systemId);
    assert.equal(view.outcome, 'allowed');
    const serialized = JSON.stringify({ draft: draft.value, view: view.value });
    assert.deepEqual(findCanaryHits(serialized), [], `canary bytes in ${actor} supplier output`);
    assert.deepEqual(findRestrictedKeys(JSON.parse(serialized)), [], `restricted block keys in ${actor} supplier output`);
  }
});

test('supplier org-A outputs name no org-B identifier and vice versa (cross-org byte sweep)', async () => {
  const world = standardSupplierWorld();
  const base = supplierWorld();
  const orgA = base.anchors.find((anchor) => anchor.orgId === 'org-cache-water');
  const orgB = base.anchors.find((anchor) => anchor.orgId === 'org-bear-river-users');
  assert.ok(orgA && orgB, 'both fixture owner organizations must anchor');
  const boundaries = await import('../../../services/api/src/workflows/supplier-report/boundaries.ts');
  const deps = { now: FIXTURE_CLOCK, world, store: seriesStore() };

  const buildOutputs = (actor, systemId) => {
    const store = new supplierReport.SupplierReportStore();
    const boundaryStore = new boundaries.SupplierBoundaryStore();
    return [
      ['createDraft', supplierReport.createDraft(deps, store, { systemId, period: { basis: 'calendar-year', year: 2026 } }, actor)],
      ['listDrafts', supplierReport.listDrafts(deps, store, actor)],
      ['systemView', supplierReport.systemView(deps, store, actor, systemId)],
      ['listSubmissions', supplierReport.listSubmissions(deps, store, actor)],
      ['approvedBoundary', boundaries.getApprovedBoundary(deps, boundaryStore, systemId, actor)],
      ['proposals', boundaries.listProposals(deps, boundaryStore, systemId, actor)],
    ];
  };

  // Org A (Wiley, org-cache-water on sys-bear-river) — serialized outputs must
  // not name ANY org-B identifier: the org id, its system, its stations, or
  // its synthetic actors. Station streams of org B are swept separately below.
  const orgBIdentifiers = [orgB.orgId, orgB.systemId, ...orgB.stationIds, 'principal-morgan-water-user', 'principal-wum-reviewer-bear'];
  const orgBStreams = [];
  for (const station of base.stations) {
    if (station.orgId === orgB.orgId) orgBStreams.push(...station.dischargeStreams.map((entry) => entry.streamId));
  }
  for (const [label, result] of buildOutputs('principal-wiley-water-user', 'sys-bear-river')) {
    const serialized = JSON.stringify(result);
    for (const id of [...orgBIdentifiers, ...orgBStreams]) {
      assert.ok(!serialized.includes(id), `org-A output "${label}" names org-B identifier ${id}`);
    }
  }

  // And the mirror direction.
  const orgAStreams = [];
  for (const station of base.stations) {
    if (station.orgId === orgA.orgId) orgAStreams.push(...station.dischargeStreams.map((entry) => entry.streamId));
  }
  const orgAIdentifiers = [orgA.orgId, orgA.systemId, ...orgA.stationIds, 'principal-wiley-water-user', 'principal-wum-reviewer-cache'];
  for (const [label, result] of buildOutputs('principal-morgan-water-user', 'sys-weber-river')) {
    const serialized = JSON.stringify(result);
    for (const id of [...orgAIdentifiers, ...orgAStreams]) {
      assert.ok(!serialized.includes(id), `org-B output "${label}" names org-A identifier ${id}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 5. WCAT serialization (WD-023-R2 seam)
// ---------------------------------------------------------------------------

test('WCAT fixture-fake sync serialization carries no canary bytes', () => {
  const adapter = createFixtureFakeWcatAdapter();
  const request = {
    correlationId: 'wcat-sweep-corr-1',
    requestedAt: FIXTURE_CLOCK,
    artifacts: [
      {
        id: 'wcat-sweep-art-1',
        kind: 'stream-input',
        identifier: 'wcat-sweep-1',
        streamId: 'str-corinne-q',
        payload: { note: 'qualification sweep', stageFt: 3.2 },
        provenance: { source: 'utah-water-dashboard', observedOrModeled: 'observed', ownerSystem: 'sys-bear-river', correlationId: 'wcat-sweep-corr-1' },
      },
    ],
  };
  let result;
  try {
    result = adapter.sync(request);
  } catch (error) {
    // Shape drift in the seam is a finding, not a crash: surface it loudly.
    assert.fail(`WCAT fixture adapter rejected a well-formed probe request: ${String(error?.message ?? error)}`);
  }
  const serialized = serializeWcatResult(result);
  assert.deepEqual(findCanaryHits(serialized), [], 'canary bytes in WCAT serialization');
  assert.ok(serialized.length > 2, 'the adapter must produce a serialization at all');
});

test('the full canary vocabulary is non-trivial (sweep self-check)', () => {
  assert.ok(CANARY_BYTES.length >= 4, `expected a meaningful canary vocabulary, found ${CANARY_BYTES.length}`);
});
