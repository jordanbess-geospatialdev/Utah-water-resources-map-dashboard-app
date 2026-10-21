/**
 * WD-021 adversarial sweep (a): no restricted fixture value appears in ANY
 * public projection across web features, exports, summaries, reports and
 * gateway responses.
 *
 * Written by the independent qualification agent (qa_accessibility), NOT by
 * the implementers: this suite imports the REAL modules and serializes their
 * outputs, then byte-scans for the fixture canaries (gate codes 4471-CDX /
 * 9917-KWW / 2208-QQZ, wiring-note fragments, restricted field names, the
 * T-05 publication canary) and restricted object ids. A positive control
 * (the entitled engineer/steward projections DO carry the internal block)
 * proves the scan detects leaks rather than scanning nothing.
 *
 * Run (from repo root):
 *   node --test tests/qualification/adversarial/restricted-bytes.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  registerWebResolveHook,
  findCanaryHits,
  findRestrictedKeys,
  CANARY_BYTES,
  GATE_CODES,
  RESTRICTED_OBJECT_IDS,
  stationsFixture,
} from './canaries.mjs';

registerWebResolveHook();

// --- real modules under test ------------------------------------------------
const { personas, viewerFor } = await import('../../../apps/web/src/shell/data/personas.ts');
const { projectCatalog, projectStation } = await import('../../../apps/web/src/shell/data/projection.ts');
const {
  canonicalizeFilters,
  serializeFilters,
  appliedFilterChips,
  DISCOVERY_DIMENSIONS,
  filterPublicStations,
} = await import('../../../apps/web/src/features/discovery/filters.ts');
const { buildShareUrl, parseShareUrl, resolveShareUrl } = await import('../../../apps/web/src/features/discovery/shareUrl.ts');
const { buildFixtureReport } = await import('../../../apps/web/src/features/distribution-report/reportModel.ts');
const { seriesStore } = await import('../../../services/api/src/series/load.ts');
const { ExportJobManager } = await import('../../../services/api/src/exports/exportJob.ts');
const { summaryWorld } = await import('../../../services/api/src/summaries/world.ts');
const { summaryIndicators: apiSummaryIndicators, statewideOverview: apiStatewideOverview } = await import('../../../services/api/src/summaries/indicators.ts');
const { fixtureAreaTotals } = await import('../../../services/api/src/summaries/totals.ts');
const { generateReport, fixtureReportDeps } = await import('../../../services/api/src/workflows/distribution-report/generate.ts');
const { handleGatewayRequest } = await import('../../../services/geo-gateway/src/gateway.ts');
const gatewayHelpers = await import('../../../services/geo-gateway/test/helpers.ts');

const PUBLIC_VIEWER_PERSONAS = ['donna', 'wiley', 'sarah', 'cody'];
const ENTITLED_VIEWER_PERSONAS = ['fatima', 'diego'];
const FIXTURE_CLOCK = '2026-05-15T12:00:00Z';

// ---------------------------------------------------------------------------
// 1. Web station projections (WD-006 demo projection of the fixture world)
// ---------------------------------------------------------------------------

test('web projectCatalog leaks no canary bytes for public/limited viewers', () => {
  const scanned = [];
  for (const personaId of PUBLIC_VIEWER_PERSONAS) {
    const persona = personas.find((p) => p.id === personaId);
    const catalog = projectCatalog(viewerFor(persona));
    assert.ok(catalog.length > 0, `${personaId} catalog is non-empty`);
    const serialized = JSON.stringify(catalog);
    scanned.push(serialized);
    const hits = findCanaryHits(serialized);
    assert.deepEqual(hits, [], `${personaId}: restricted bytes leaked into public projection: ${hits.join(', ')}`);
    const keyHits = findRestrictedKeys(catalog);
    assert.deepEqual(keyHits, [], `${personaId}: restricted block keys present in projection: ${keyHits.join(', ')}`);
    for (const row of catalog) {
      assert.equal(row.internal, null, `${personaId}: station ${row.id} carries an internal block`);
    }
  }
  assert.ok(scanned.length === 4);
});

test('positive control: entitled viewers DO see the internal block (scan is not vacuous)', () => {
  for (const personaId of ENTITLED_VIEWER_PERSONAS) {
    const persona = personas.find((p) => p.id === personaId);
    const catalog = projectCatalog(viewerFor(persona));
    const withInternal = catalog.filter((row) => row.internal !== null);
    assert.ok(withInternal.length > 0, `${personaId} should see at least one internal block`);
    const hits = findCanaryHits(JSON.stringify(withInternal));
    assert.ok(GATE_CODES.some((code) => hits.includes(code)), 'the canary list must include the gate codes the entitled projection carries');
  }
});

test('out-of-scope engineer (priya, sys-weber-river) receives nothing from Bear River', () => {
  const priya = { personaId: 'priya', role: 'engineer', principalId: 'principal-priya-engineer', organizationId: null };
  const catalog = projectCatalog(priya);
  const bearRiverRows = catalog.filter((row) => row.systemId === 'sys-bear-river' && row.access === 'assigned');
  assert.deepEqual(bearRiverRows, [], 'priya must have no assigned rows in sys-bear-river');
  for (const row of catalog) assert.equal(row.internal, null);
  assert.deepEqual(findCanaryHits(JSON.stringify(catalog)), []);
});

test('restricted stations never appear in anonymous rows; public station with internal block does', () => {
  const donna = viewerFor(personas.find((p) => p.id === 'donna'));
  const ids = projectCatalog(donna).map((row) => row.id);
  for (const restrictedId of RESTRICTED_OBJECT_IDS) {
    assert.ok(!ids.includes(restrictedId), `restricted object ${restrictedId} surfaced publicly`);
  }
  assert.ok(ids.includes('sta-bear-corinne'), 'public station is present (the FR-049 trap row)');
  const corinne = projectStation(donna, stationsFixture.stations.find((s) => s.id === 'sta-bear-corinne'));
  assert.equal(corinne.internal, null, 'row visibility alone is not sufficient: internal block must be stripped');
});

// ---------------------------------------------------------------------------
// 2. Discovery filters + share URLs
// ---------------------------------------------------------------------------

test('hostile filter values are rejected and never serialized into share URLs', () => {
  const hostileValues = [...CANARY_BYTES, ...RESTRICTED_OBJECT_IDS, 'flume; DROP TABLE stations', '../../etc/passwd'];
  for (const dimension of DISCOVERY_DIMENSIONS) {
    const result = canonicalizeFilters({ [dimension.key]: hostileValues });
    const serializedFilters = serializeFilters(result.filters);
    const url = buildShareUrl({ filters: result.filters, selectedSiteId: 'sta-bear-corinne' });
    const chips = JSON.stringify(appliedFilterChips(result.filters));
    for (const surface of [serializedFilters, url.url, JSON.stringify(url.notices), chips]) {
      const hits = findCanaryHits(surface);
      assert.deepEqual(hits, [], `${dimension.key}: canary bytes in discovery surface: ${hits.join(', ')}`);
      for (const restrictedId of RESTRICTED_OBJECT_IDS) {
        assert.ok(!surface.includes(restrictedId), `${dimension.key}: restricted id ${restrictedId} serialized`);
      }
    }
    assert.ok(result.redactions.length > 0, `${dimension.key}: hostile values were redacted`);
  }
});

test('public catalog filtering never returns restricted stations for any canonical filter set', () => {
  // Exhaustive: every single-value filter over every dimension value.
  for (const dimension of DISCOVERY_DIMENSIONS) {
    for (const value of dimension.values) {
      const matched = filterPublicStations({ [dimension.key]: [value.id] });
      for (const station of matched) {
        assert.equal(station.visibility, 'public', `${dimension.key}=${value.id} matched non-public station ${station.id}`);
      }
    }
  }
});

test('forged share links for restricted sites resolve to omission, never content', () => {
  const publicIds = ['sta-bear-corinne', 'sta-hyrum-diversion-public', 'sta-summit-creek-inactive'];
  for (const restrictedId of RESTRICTED_OBJECT_IDS) {
    const built = buildShareUrl({ selectedSiteId: restrictedId, filters: {} }, { publicSiteIds: publicIds });
    assert.equal(built.state.selectedSiteId, null, `${restrictedId}: build side must omit`);
    assert.ok(!built.url.includes(restrictedId), 'restricted id must not appear in URL bytes');
    const forged = parseShareUrl(`?v=1&s=${encodeURIComponent(restrictedId)}&e=-112.5,41.5,-111.5,42.0`);
    const resolved = resolveShareUrl(forged, publicIds);
    assert.equal(resolved.state.selectedSiteId, null, `${restrictedId}: resolve side must omit`);
    assert.deepEqual(findCanaryHits(JSON.stringify(resolved)), []);
  }
});

// ---------------------------------------------------------------------------
// 3. API exports (CSV bytes)
// ---------------------------------------------------------------------------

test('public CSV export bytes carry no canary; restricted exports are denied', () => {
  const store = seriesStore();
  const manager = new ExportJobManager({ store, now: () => FIXTURE_CLOCK });
  const publicExport = manager.create(
    { streamIds: ['str-corinne-q', 'str-hyrum-q-public'], start: '2026-03-06T00:00:00Z', end: '2026-03-09T00:00:00Z', basis: 'best-available' },
    null,
  );
  assert.equal(publicExport.outcome, 'allowed');
  manager.start(publicExport.value.id);
  const completed = manager.complete(publicExport.value.id);
  assert.equal(completed.outcome, 'allowed');
  const download = manager.download(publicExport.value.id, null);
  assert.equal(download.outcome, 'allowed');
  assert.deepEqual(findCanaryHits(download.value.csv), [], 'canary bytes in export CSV');

  const restrictedExport = manager.create(
    { streamIds: ['str-hyrum-q-owner'], start: '2026-03-06T00:00:00Z', end: '2026-03-09T00:00:00Z', basis: 'raw' },
    null,
  );
  assert.equal(restrictedExport.outcome, 'denied', 'anonymous export of a restricted stream must deny');
});

test('out-of-scope authenticated export of a RESTRICTED stream is denied (engineer B)', () => {
  const store = seriesStore();
  const manager = new ExportJobManager({ store, now: () => FIXTURE_CLOCK });
  // A public Bear-River stream is exportable by anyone (publication model);
  // the RESTRICTED owner stream must deny for out-of-scope engineer priya.
  const publicForAnyone = manager.create(
    { streamIds: ['str-corinne-q'], start: '2026-03-06T00:00:00Z', end: '2026-03-09T00:00:00Z', basis: 'raw' },
    'principal-priya-engineer',
  );
  assert.equal(publicForAnyone.outcome, 'allowed', 'public data is public for authenticated users too');
  const restricted = manager.create(
    { streamIds: ['str-hyrum-q-owner'], start: '2026-03-06T00:00:00Z', end: '2026-03-09T00:00:00Z', basis: 'raw' },
    'principal-priya-engineer',
  );
  assert.equal(restricted.outcome, 'denied', 'out-of-scope engineer must not export the restricted owner stream');
});

// ---------------------------------------------------------------------------
// 4. Summaries (indicators + totals) and reports
// ---------------------------------------------------------------------------

test('summary indicators carry no canary bytes and no unexpected hidden-object names', () => {
  // sta-ogden-valley-proposed is the single pinned exception (DEFECT-Q1,
  // pinned precisely by the next test); every other hidden object id fails.
  const hiddenIds = RESTRICTED_OBJECT_IDS.filter((id) => id !== 'sta-ogden-valley-proposed');
  const world = summaryWorld();
  const surfaces = [apiSummaryIndicators(world), apiStatewideOverview(world)];
  for (const [index, surface] of surfaces.entries()) {
    assert.ok(surface, `indicator surface ${index} produced a value`);
    assert.deepEqual(findCanaryHits(surface), [], `indicator surface ${index} leaked restricted values`);
    assert.deepEqual(findRestrictedKeys(surface), [], `indicator surface ${index} carries restricted block keys`);
    const serialized = JSON.stringify(surface);
    for (const restrictedId of hiddenIds) {
      assert.ok(!serialized.includes(restrictedId), `indicator surface ${index} names restricted object ${restrictedId}`);
    }
  }
});

test('area totals carry no canary bytes and no hidden-object names beyond pinned DEFECT-Q2', () => {
  // DEFECT-Q2 (pinned): the default-PUBLIC area totals enumerate every
  // stream of the fixture world in per-stream breakdown rows, including the
  // restricted owner stream, the internal diagnostic stream AND the
  // restricted proposed gauge (ids, display names, properties,
  // exclusionReason) - an inventory disclosure of hidden objects to
  // anonymous callers (same class as DEFECT-Q1). Pinned set below; any
  // OTHER hidden object id fails, and shrinking the set fails the pin.
  const pinned = [
    'sta-bear-lake-diagnostic',
    'str-diag-voltage',
    'sta-hyrum-diversion-owner',
    'str-hyrum-q-owner',
    'sta-ogden-valley-proposed',
    'str-ogden-q-proposed',
  ];
  const hiddenIds = RESTRICTED_OBJECT_IDS.filter((id) => !pinned.includes(id));
  const totals = [
    fixtureAreaTotals({ area: { kind: 'statewide' }, start: '2026-03-06T00:00:00Z', end: '2026-03-09T00:00:00Z', basis: 'best-available' }),
    fixtureAreaTotals({ area: { kind: 'system', systemId: 'sys-bear-river' }, start: '2026-03-06T00:00:00Z', end: '2026-03-09T00:00:00Z', basis: 'raw' }),
  ];
  for (const [index, result] of totals.entries()) {
    assert.equal(result.outcome, 'allowed', `totals surface ${index} produced a value`);
    assert.deepEqual(findCanaryHits(result.value), [], `totals surface ${index} leaked restricted values`);
    assert.deepEqual(findRestrictedKeys(result.value), [], `totals surface ${index} carries restricted block keys`);
    const serialized = JSON.stringify(result.value);
    for (const restrictedId of hiddenIds) {
      assert.ok(!serialized.includes(restrictedId), `totals surface ${index} names restricted object ${restrictedId}`);
    }
  }
  // The pinned set really is present today (the pin is not vacuous):
  const statewide = JSON.stringify(totals[0].value);
  for (const pinnedId of pinned) {
    assert.ok(statewide.includes(pinnedId), `DEFECT-Q2 pin: ${pinnedId} expected in current public totals output`);
  }
});

test('DEFECT-Q1 pinned: the ONLY hidden object a public summary names is the proposed station id in exclusion lists', () => {
  // Documented defect (filed in docs/verification/MVP-QUALIFICATION-REPORT.md,
  // DEFECT-Q1): summaryIndicators/statewideOverview embed exclusion ID lists
  // that disclose the identifier of sta-ogden-valley-proposed — a
  // restricted-visibility, unpublished station whose existence should not be
  // public (the hidden-object rule). This test PINS the current behavior so
  // (a) any ADDITIONAL hidden-object name in any summary surface fails
  // loudly, and (b) removing DEFECT-Q1 fails this test, forcing the
  // qualification report to be updated when the owner fixes it.
  const world = summaryWorld();
  const serialized = JSON.stringify(apiStatewideOverview(world));
  const disclosed = RESTRICTED_OBJECT_IDS.filter((id) => serialized.includes(id));
  assert.deepEqual(disclosed, ['sta-ogden-valley-proposed'], 'exactly DEFECT-Q1 may be disclosed; anything else is a new leak');
  assert.ok(!serialized.includes('sta-bear-lake-diagnostic'), 'internal diagnostic station must never be named');
  assert.ok(!serialized.includes('sta-hyrum-diversion-owner'), 'restricted owner station must never be named');
  assert.ok(!serialized.includes('str-hyrum-q-owner'), 'restricted stream must never be named');
});

test('entitled distribution report carries no canary bytes; out-of-scope request is denied', () => {
  const deps = fixtureReportDeps(FIXTURE_CLOCK);
  const request = {
    systemId: 'sys-bear-river',
    siteIds: null,
    period: { basis: 'water-year', year: 2026 },
    processingBasis: 'best-available',
    include: { dailyTable: true, qualityNotes: true, gapDetail: true },
  };
  // In-scope commissioner: restricted station IDs may legitimately appear
  // (assigned rows); the restricted FIELD BLOCK must not.
  const generated = generateReport(deps, request, 'principal-cody-commissioner');
  assert.equal(generated.outcome, 'allowed');
  assert.deepEqual(findCanaryHits(generated.value), [], 'canary bytes in distribution report');
  assert.deepEqual(findRestrictedKeys(generated.value), [], 'restricted block keys in distribution report');

  // Out-of-scope engineer (Weber River) must not receive a Bear River report.
  const outOfScope = generateReport(deps, request, 'principal-priya-engineer');
  assert.equal(outOfScope.outcome, 'denied', 'out-of-scope report request must deny');

  // Anonymous request must deny too.
  const anonymous = generateReport(deps, request, null);
  assert.equal(anonymous.outcome, 'denied', 'anonymous report request must deny');

  const webReport = buildFixtureReport({ systemId: 'sys-bear-river', period: { basis: 'water-year', year: 2026 } });
  assert.deepEqual(findCanaryHits(webReport), [], 'canary bytes in web report model');
  assert.deepEqual(findRestrictedKeys(webReport), [], 'restricted block keys in web report model');
});

// ---------------------------------------------------------------------------
// 5. Geo-gateway responses (synthetic upstream recordings)
// ---------------------------------------------------------------------------

/** Upstream recorder serving the gateway suite's synthetic fixture responses. */
function recordingFetch(responses) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const entry = responses.find((candidate) => String(url).includes(candidate.match)) ?? responses[responses.length - 1];
    return new Response(entry.body, { status: entry.status ?? 200, headers: { 'content-type': entry.contentType } });
  };
  return { fetchImpl, calls };
}

function gatewayConfig(world, fetchImpl) {
  return {
    trustedBase: 'http://upstream.test',
    gatewayOrigin: 'https://portal.example',
    worldLoader: () => world,
    resolveSecret: (reference) => (reference === 'secretref://neoserver/workspaces/water-public' ? 'public-key-1' : 'cohort-key-1'),
    fetchImpl,
    now: () => new Date(FIXTURE_CLOCK),
  };
}

test('gateway public surfaces pass through with no canary bytes and no credential echo', async () => {
  const world = gatewayHelpers.world();
  const fixtures = {
    items: readFileSync(new URL('../../../services/geo-gateway/test/fixtures/ogc-items-stations.json', import.meta.url), 'utf8'),
    tilejson: readFileSync(new URL('../../../services/geo-gateway/test/fixtures/tilejson-water-public-stations.json', import.meta.url), 'utf8'),
  };
  const { fetchImpl, calls } = recordingFetch([
    { match: '/items', contentType: 'application/geo+json', body: fixtures.items },
    { match: 'tilejson', contentType: 'application/json', body: fixtures.tilejson },
  ]);
  const config = gatewayConfig(world, fetchImpl);
  const requests = [
    { method: 'GET', path: '/workspaces/water-public/ogc/collections/stations/items', query: new URLSearchParams('limit=10') },
    { method: 'GET', path: '/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/10/381/192', query: new URLSearchParams() },
    { method: 'GET', path: '/workspaces/water-public/ogc-tiles/collections/stations/tilejson.json', query: new URLSearchParams() },
  ];
  for (const request of requests) {
    const response = await handleGatewayRequest(request, config);
    const body = typeof response.body === 'string' ? response.body : Buffer.from(response.body).toString('latin1');
    assert.deepEqual(findCanaryHits(body), [], `gateway response for ${request.path} leaked`);
    const keyHits = findRestrictedKeys(safeJsonParse(body));
    assert.deepEqual(keyHits, [], `gateway response for ${request.path} carries restricted block keys: ${keyHits.join(', ')}`);
    assert.ok(!body.includes('public-key-1') && !body.includes('cohort-key-1'), 'gateway must never echo the upstream credential');
    assert.ok(!body.includes('http://upstream.test'), 'gateway must not leak the trusted upstream base');
  }
  for (const call of calls) {
    assert.ok(!call.includes('admin'), `upstream call touched management surface: ${call}`);
  }
});

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null; // binary tile bodies are value-scanned only
  }
}

test('anonymous cohort request is denied before upstream and never yields bytes', async () => {
  const world = gatewayHelpers.world();
  let upstreamCalled = false;
  const { fetchImpl } = recordingFetch([
    { match: 'stations-restricted', contentType: 'application/geo+json', body: '{"type":"FeatureCollection","features":[]}' },
  ]);
  const wrappedFetch = async (url, init) => {
    upstreamCalled = true;
    return fetchImpl(url, init);
  };
  const response = await handleGatewayRequest(
    { method: 'GET', path: '/workspaces/water-bear-cohort/ogc/collections/stations-restricted/items', query: new URLSearchParams(), session: { principal: null } },
    gatewayConfig(world, wrappedFetch),
  );
  assert.ok(response.status === 401 || response.status === 403, `anonymous cohort read must deny (got ${response.status})`);
  assert.equal(upstreamCalled, false, 'cohort denial must happen before any upstream call');
  const headers = response.headers['Cache-Control'] ?? '';
  assert.ok(headers.includes('no-store'), 'denied cohort response must be no-store');
});

test('cohort member allow is private/no-store and leak-free (visibility wall)', async () => {
  const world = gatewayHelpers.world();
  const cohortMember = world.principals['wiley-a'];
  const { fetchImpl } = recordingFetch([
    { match: 'stations-restricted', contentType: 'application/geo+json', body: readFileSync(new URL('../../../services/geo-gateway/test/fixtures/ogc-items-stations.json', import.meta.url), 'utf8') },
  ]);
  const response = await handleGatewayRequest(
    { method: 'GET', path: '/workspaces/water-bear-cohort/ogc/collections/stations-restricted/items', query: new URLSearchParams('limit=10'), session: { principal: cohortMember } },
    gatewayConfig(world, fetchImpl),
  );
  assert.equal(response.status, 200);
  const cacheControl = response.headers['Cache-Control'] ?? '';
  assert.ok(cacheControl.includes('private') && cacheControl.includes('no-store'), `cohort content must be private/no-store (got "${cacheControl}")`);
  const body = typeof response.body === 'string' ? response.body : Buffer.from(response.body).toString('latin1');
  assert.deepEqual(findCanaryHits(body), []);
  assert.ok(!body.includes('cohort-key-1'), 'credential echo');
});

test('management-path and traversal probes are refused without upstream calls', async () => {
  const world = gatewayHelpers.world();
  let upstreamCalled = false;
  const { fetchImpl } = recordingFetch([{ match: '', contentType: 'application/json', body: '{}' }]);
  const wrappedFetch = async (url, init) => {
    upstreamCalled = true;
    return fetchImpl(url, init);
  };
  const probes = [
    '/workspaces/water-public/ogc/../../api/v1/workspaces',
    '/workspaces/water-public/ogc/collections/stations/items?limit=10#',
    '/api/v1/workspaces/water-public/services',
    '/workspaces/unknown-workspace/ogc/collections/stations/items',
    '/workspaces/water-public/ogc/collections/stations/items/../../../admin',
  ];
  for (const path of probes) {
    const response = await handleGatewayRequest(
      { method: 'GET', path, query: new URLSearchParams(), session: { principal: null } },
      gatewayConfig(world, wrappedFetch),
    );
    assert.ok(response.status >= 400, `probe "${path}" must be refused (got ${response.status})`);
  }
  assert.equal(upstreamCalled, false, 'no probe may reach the upstream');
});
