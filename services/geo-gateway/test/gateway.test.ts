/**
 * WD-005 gateway pipeline tests (SYNTHETIC upstream responses only).
 *
 * Exercises the full handleGatewayRequest pipeline against injected fetch:
 * allowlist + policy -> URL build -> fetch with credential isolation ->
 * content-type/size caps -> TileJSON rewrite -> cache policy. The task's
 * mandated control checks:
 *  - z/y/x swap detected via control coordinates
 *  - relative TileJSON links don't leak the upstream host
 *  - unlisted workspace denied
 *  - admin path denied
 *  - WFS mutation denied
 *  - oversized response capped
 *  - cohort credential never echoes caller input
 *  - source-layer mismatch fails loudly
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';

import { handleGatewayRequest, type GatewayRequest } from '../src/gateway.ts';
import {
  COHORT_SERVICE_KEY,
  PUBLIC_SERVICE_KEY,
  TRUSTED_BASE,
  WILEY_A,
  gatewayConfig,
  readFixture,
  readFixtureJson,
  recordingFetch,
  world,
  type RecordedCall,
} from './helpers.ts';

const jsonBody = (body: unknown, contentType = 'application/json'): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': contentType } });

/** Non-TileJSON upstream payloads come back as bytes (uniform, transport-agnostic). */
const decodeText = (body: string | Uint8Array): string =>
  typeof body === 'string' ? body : new TextDecoder().decode(body);

const get = (path: string, query = '', session?: { principal: typeof WILEY_A | null }): GatewayRequest => ({
  method: 'GET',
  path,
  query: new URLSearchParams(query),
  ...(session === undefined ? {} : { session }),
});

describe('happy paths (public workspace, anonymous caller)', () => {
  test('items: proxied with clamped limit and private no-store caching', async () => {
    const calls: RecordedCall[] = [];
    const cfg = gatewayConfig({ fetchImpl: recordingFetch(calls, () => jsonBody(readFixture('ogc-items-stations.json'), 'application/geo+json')) });
    const res = await handleGatewayRequest(get('/workspaces/water-public/ogc/collections/stations/items', 'limit=99999'), cfg);
    assert.equal(res.status, 200);
    assert.equal(res.decision?.reason, 'ALLOW_PUBLIC_READ');
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.equal(calls[0].url, `${TRUSTED_BASE}/workspaces/water-public/ogc/collections/stations/items?limit=500`);
    const body = JSON.parse(decodeText(res.body));
    assert.equal(body.numberReturned, 2);
  });

  test('tile: proxied bytes with public revisioned caching', async () => {
    const tile = Buffer.from(readFixtureJson<{ gzipBase64: string }>('mvt-stations-public.json').gzipBase64, 'base64');
    const calls: RecordedCall[] = [];
    const cfg = gatewayConfig({ fetchImpl: recordingFetch(calls, () => new Response(tile, { status: 200, headers: { 'content-type': 'application/vnd.mapbox-vector-tile' } })) });
    const res = await handleGatewayRequest(get('/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/10/381/192'), cfg);
    assert.equal(res.status, 200);
    assert.match(res.headers['Cache-Control'], /^public, max-age=\d+, must-revalidate$/);
    assert.equal(calls[0].url, `${TRUSTED_BASE}/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/10/381/192`);
    assert.equal((res.body as Uint8Array).byteLength, tile.byteLength);
  });

  test('the z10 tile routed for the control station decodes back into Utah (swap check through the pipeline)', async () => {
    // 381/192 is the independently computed matrix/row/column for
    // 41.6337N 112.1965W at z10; a swapped 192/381 tile would address ~73.8N.
    const tile = Buffer.from(readFixtureJson<{ gzipBase64: string }>('mvt-stations-public.json').gzipBase64, 'base64');
    const cfg = gatewayConfig({ fetchImpl: recordingFetch([], () => new Response(tile, { status: 200, headers: { 'content-type': 'application/vnd.mapbox-vector-tile' } })) });
    const res = await handleGatewayRequest(get('/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/10/381/192'), cfg);
    assert.equal(res.status, 200);
    const seg = (res.route?.tile !== undefined) ? [res.route.tile.z, res.route.tile.y, res.route.tile.x] : [];
    assert.deepEqual(seg, [10, 381, 192]);
    // Independent inverse projection (formulas inline, not the module under test):
    const n = 2 ** seg[0];
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * seg[1]) / n))) * 180) / Math.PI;
    const lon = (seg[2] / n) * 360 - 180;
    assert.ok(lat > 41 && lat < 42.2 && lon > -113 && lon < -111, `tile NW corner ${lat},${lon} must sit in northern Utah`);
  });

  test('tilejson: rewritten same-origin templates, advertised source-layer header, no upstream host', async () => {
    const cfg = gatewayConfig({ fetchImpl: recordingFetch([], () => jsonBody(readFixture('tilejson-water-public-stations.json'))) });
    const res = await handleGatewayRequest(get('/workspaces/water-public/ogc-tiles/collections/stations/tilejson.json'), cfg);
    assert.equal(res.status, 200);
    assert.equal(res.headers['X-Map-Source-Layer'], 'stations_public');
    const doc = JSON.parse(res.body as string);
    assert.equal(doc.tiles[0], 'https://portal.example.utah.gov/geo/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/{z}/{y}/{x}');
    assert.ok(!JSON.stringify(doc).includes('neo.internal'), 'no upstream host in the browser-facing TileJSON');
    assert.equal(doc.vector_layers[0].id, 'stations_public', 'vector_layers pass through untouched');
  });

  test('wfs getfeature via KVP: explicit GeoJSON output and COUNT clamped from the caller limit', async () => {
    const calls: RecordedCall[] = [];
    const cfg = gatewayConfig({ fetchImpl: recordingFetch(calls, () => jsonBody(readFixture('wfs-getfeature-stations.json'), 'application/json')) });
    // Caller-facing page size is the typed `limit` parameter (raw WFS COUNT is
    // not forwarded); the gateway rebuilds COUNT from the clamped value.
    const res = await handleGatewayRequest(get('/workspaces/water-public/wfs', 'SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=stations&limit=99999'), cfg);
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    const body = JSON.parse(decodeText(res.body));
    assert.equal(body.type, 'FeatureCollection');
    const upstream = new URL(calls[0].url);
    assert.equal(upstream.searchParams.get('OUTPUTFORMAT'), 'application/json');
    assert.equal(upstream.searchParams.get('COUNT'), '500'); // clamped from 99999, never unbounded
  });

  test('wms getmap via KVP: EPSG:3857 bbox (typed param) passed through as meters', async () => {
    const png = Buffer.from(readFixtureJson<{ pngBase64: string }>('wms-getmap-png.json').pngBase64, 'base64');
    const calls: RecordedCall[] = [];
    const cfg = gatewayConfig({ fetchImpl: recordingFetch(calls, () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })) });
    // Caller-facing params are typed: bbox3857 in meters, width/height. Raw
    // WMS KVP (CRS/BBOX/FORMAT...) is dropped - the gateway builds the KVP itself.
    const res = await handleGatewayRequest(
      get('/workspaces/water-public/wms', 'REQUEST=GetMap&LAYERS=basins&bbox3857=-12678500,4430000,-12100000,5170000&width=256&height=256'),
      cfg,
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers['Content-Type'], 'image/png');
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    const upstream = new URL(calls[0].url);
    assert.equal(upstream.searchParams.get('CRS'), 'EPSG:3857');
    assert.equal(upstream.searchParams.get('BBOX'), '-12678500,4430000,-12100000,5170000');
    assert.equal(upstream.searchParams.get('WIDTH'), '256');
    assert.deepEqual(Array.from(res.body as Uint8Array), Array.from(png));
  });
});

describe('credential isolation (caller input can never reach upstream)', () => {
  test('the cohort credential is the RESOLVED secret, never any caller-supplied value', async () => {
    const calls: RecordedCall[] = [];
    const cfg = gatewayConfig({
      fetchImpl: recordingFetch(calls, () => jsonBody(readFixture('ogc-items-stations.json'), 'application/geo+json')),
      resolveSecret: () => COHORT_SERVICE_KEY,
    });
    // A caller trying every credential-smuggling channel: headers are
    // structurally absent from GatewayRequest; query creds are dropped by
    // typed parameter extraction.
    const res = await handleGatewayRequest(
      {
        method: 'GET',
        path: '/workspaces/water-bear-cohort/ogc/collections/stations-restricted/items',
        query: new URLSearchParams('limit=5&apikey=CALLER-SUPPLIED-KEY&X-API-Key=CALLER-SUPPLIED-KEY&authorization=Bearer%20CALLER'),
        session: { principal: WILEY_A },
      },
      cfg,
    );
    assert.equal(res.status, 200);
    const sent = calls[0].headers;
    assert.equal(sent['x-api-key'], COHORT_SERVICE_KEY);
    assert.equal(Object.values(sent).find((v) => v.includes('CALLER')), undefined, 'no caller-supplied credential reached upstream');
    assert.equal(new URL(calls[0].url).search, '?limit=5', 'unknown query params are dropped');
  });

  test('an unresolved secret reference fails CLOSED (no anonymous upstream call)', async () => {
    let fetched = 0;
    const cfg = gatewayConfig({
      fetchImpl: (async () => { fetched += 1; return jsonBody('{}'); }) as unknown as typeof fetch,
      resolveSecret: () => undefined,
    });
    const res = await handleGatewayRequest(get('/workspaces/water-public/ogc/collections/stations/items'), cfg);
    assert.equal(res.status, 503);
    assert.equal(res.denial?.code, 'SECRET_UNRESOLVED');
    assert.equal(fetched, 0);
  });

  test('public workspace uses its own narrow key, cohort its own', async () => {
    const calls: RecordedCall[] = [];
    const cfg = gatewayConfig({ fetchImpl: recordingFetch(calls, () => jsonBody(readFixture('ogc-items-stations.json'), 'application/geo+json')) });
    await handleGatewayRequest(get('/workspaces/water-public/ogc/collections/stations/items'), cfg);
    await handleGatewayRequest(get('/workspaces/water-bear-cohort/ogc/collections/stations-restricted/items', '', { principal: WILEY_A }), cfg);
    assert.equal(calls[0].headers['x-api-key'], PUBLIC_SERVICE_KEY);
    assert.equal(calls[1].headers['x-api-key'], COHORT_SERVICE_KEY);
  });
});

describe('denials', () => {
  test('unlisted workspace is denied 404 before any upstream call', async () => {
    let fetched = 0;
    const cfg = gatewayConfig({ fetchImpl: (async () => { fetched += 1; return jsonBody('{}'); }) as unknown as typeof fetch });
    const res = await handleGatewayRequest(get('/workspaces/water-secret/ogc/collections/stations/items'), cfg);
    assert.equal(res.status, 404);
    assert.equal(res.denial?.code, 'ROUTE_DENIED');
    assert.equal(fetched, 0);
  });

  test('admin / service-management path is denied 403', async () => {
    const cfg = gatewayConfig();
    const res = await handleGatewayRequest(get('/api/v1/workspaces'), cfg);
    assert.equal(res.status, 403);
    assert.equal(res.denial?.code, 'ROUTE_DENIED');
    const res2 = await handleGatewayRequest(get('/workspaces/water-public/ogc/collections/stations/items/../../../../../api/v1/apikeys'), cfg);
    assert.ok([400, 403, 404].includes(res2.status), 'traversal never routes to management');
  });

  test('WFS Transaction (and each verb) is denied before fetch', async () => {
    let fetched = 0;
    const cfg = gatewayConfig({ fetchImpl: (async () => { fetched += 1; return jsonBody('{}'); }) as unknown as typeof fetch });
    for (const verb of ['Transaction', 'Insert', 'Update', 'Delete', 'Replace']) {
      const res = await handleGatewayRequest(get('/workspaces/water-public/wfs', `SERVICE=WFS&VERSION=2.0.0&REQUEST=${verb}`), cfg);
      assert.equal(res.status, 403, verb);
      assert.equal(res.denial?.code, 'ROUTE_DENIED');
    }
    const post = await handleGatewayRequest({ method: 'POST', path: '/workspaces/water-public/wfs', query: new URLSearchParams() }, cfg);
    assert.equal(post.status, 405, 'XML POST transactions are not routable at all');
    assert.equal(fetched, 0);
  });

  test('anonymous cohort request is denied 401 (no private content)', async () => {
    let fetched = 0;
    const cfg = gatewayConfig({ fetchImpl: (async () => { fetched += 1; return jsonBody('{}'); }) as unknown as typeof fetch });
    const res = await handleGatewayRequest(get('/workspaces/water-bear-cohort/ogc/collections/stations-restricted/items'), cfg);
    assert.equal(res.status, 401);
    assert.equal(res.decision?.reason, 'DENY_ANONYMOUS');
    assert.equal(fetched, 0, 'denied cohort requests never touch the upstream service');
  });

  test('entitled cohort member passes (ALLOW_PROTECTED) and is never publicly cached', async () => {
    const calls: RecordedCall[] = [];
    const cfg = gatewayConfig({ fetchImpl: recordingFetch(calls, () => jsonBody(readFixture('ogc-items-stations.json'), 'application/geo+json')) });
    const res = await handleGatewayRequest(get('/workspaces/water-bear-cohort/ogc/collections/stations-restricted/items', '', { principal: WILEY_A }), cfg);
    assert.equal(res.status, 200);
    assert.equal(res.decision?.reason, 'ALLOW_PROTECTED');
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
  });

  test('revoked cohort member is denied on the next request (world reloaded per call)', async () => {
    const full = world();
    const stripped = { ...full, assignments: full.assignments.filter((a) => a.principalId !== 'wiley-a') };
    let entitled = true;
    const cfg = gatewayConfig({
      worldLoader: () => (entitled ? full : stripped),
      fetchImpl: recordingFetch([], () => jsonBody(readFixture('ogc-items-stations.json'), 'application/geo+json')),
    });
    const first = await handleGatewayRequest(get('/workspaces/water-bear-cohort/ogc/collections/stations-restricted/items', '', { principal: WILEY_A }), cfg);
    assert.equal(first.status, 200);
    entitled = false;
    const second = await handleGatewayRequest(get('/workspaces/water-bear-cohort/ogc/collections/stations-restricted/items', '', { principal: WILEY_A }), cfg);
    assert.equal(second.status, 403);
    assert.equal(second.decision?.reason, 'DENY_CAPABILITY_NOT_GRANTED');
    assert.notEqual(second.decision?.reason, 'ALLOW_PROTECTED');
  });

  test('layer whose guard object is not published denies 404 (no existence disclosure)', async () => {
    let fetched = 0;
    const cfg = gatewayConfig({ fetchImpl: (async () => { fetched += 1; return jsonBody('{}'); }) as unknown as typeof fetch });
    // stations-draft guards on sta-ogden-valley-proposed (visibility restricted)
    const res = await handleGatewayRequest(get('/workspaces/water-public/ogc/collections/stations-draft/items'), cfg);
    assert.equal(res.status, 404);
    assert.equal(res.decision?.reason, 'DENY_OBJECT_UNPUBLISHED');
    assert.equal(fetched, 0);
  });
});

describe('response caps', () => {
  test('oversized declared content-length is refused', async () => {
    const cfg = gatewayConfig({
      fetchImpl: (async () => new Response('x', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(10 * 1024 * 1024) } })) as unknown as typeof fetch,
    });
    const res = await handleGatewayRequest(get('/workspaces/water-public/ogc/collections/stations/items'), cfg);
    assert.equal(res.status, 502);
    assert.equal(res.denial?.code, 'RESPONSE_TOO_LARGE');
  });

  test('a body that grows past the cap mid-stream is cut off', async () => {
    // Stream without content-length; the cap must be enforced while reading.
    const big = 'x'.repeat(200 * 1024).slice(0, 200 * 1024);
    const stream = new Blob([big]).stream() as unknown as ReadableStream<Uint8Array>;
    const cfg = gatewayConfig({
      maxResponseBytes: 64 * 1024,
      fetchImpl: (async () => new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    });
    const res = await handleGatewayRequest(get('/workspaces/water-public/ogc/collections/stations/items'), cfg);
    assert.equal(res.status, 502);
    assert.equal(res.denial?.code, 'RESPONSE_TOO_LARGE');
  });

  test('an unexpected content-type (HTML admin page) is refused, not proxied', async () => {
    const cfg = gatewayConfig({
      fetchImpl: (async () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch,
    });
    const res = await handleGatewayRequest(get('/workspaces/water-public/ogc/collections/stations/items'), cfg);
    assert.equal(res.status, 502);
    assert.equal(res.denial?.code, 'RESPONSE_CONTENT_TYPE');
  });

  test('upstream non-2xx surfaces as 502 without the upstream body', async () => {
    const cfg = gatewayConfig({
      fetchImpl: (async () => new Response('internal detail leak', { status: 500, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch,
    });
    const res = await handleGatewayRequest(get('/workspaces/water-public/ogc/collections/stations/items'), cfg);
    assert.equal(res.status, 502);
    assert.ok(!(res.body as string).includes('leak'));
  });
});

describe('source-layer enforcement through the pipeline', () => {
  test('tilejson response carries the ACTUAL source-layer, and a disagreeing guess fails loudly', async () => {
    const { assertSourceLayer, parseTileJson } = await import('../src/tilejson.ts');
    const cfg = gatewayConfig({ fetchImpl: recordingFetch([], () => jsonBody(readFixture('tilejson-water-public-stations.json'))) });
    const res = await handleGatewayRequest(get('/workspaces/water-public/ogc-tiles/collections/stations/tilejson.json'), cfg);
    assert.equal(res.status, 200);
    const doc = parseTileJson(res.body as string);
    assert.equal(doc.vector_layers[0].id, 'stations_public');
    assert.throws(() => assertSourceLayer(doc, 'stations'), /SOURCE_LAYER_MISMATCH/);
  });

  test('a tileset whose advertised tiles cannot be trusted fails the whole tilejson response', async () => {
    const evil = JSON.stringify({
      tilejson: '3.0.0',
      tiles: ['https://evil.example.com/{z}/{y}/{x}'],
      vector_layers: [{ id: 'stations_public' }],
    });
    const cfg = gatewayConfig({ fetchImpl: recordingFetch([], () => jsonBody(evil)) });
    const res = await handleGatewayRequest(get('/workspaces/water-public/ogc-tiles/collections/stations/tilejson.json'), cfg);
    assert.equal(res.status, 502);
    assert.equal(res.denial?.code, 'TILEJSON_RESOLUTION_FAILED');
  });

  test('the synthetic gzip tile really decodes to the advertised layer (end-to-end evidence chain)', async () => {
    const fixture = readFixtureJson<{ gzipBase64: string }>('mvt-stations-public.json');
    const bytes = Buffer.from(fixture.gzipBase64, 'base64');
    const cfg = gatewayConfig({ fetchImpl: recordingFetch([], () => new Response(bytes, { status: 200, headers: { 'content-type': 'application/vnd.mapbox-vector-tile' } })) });
    const res = await handleGatewayRequest(get('/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/10/381/192'), cfg);
    const raw = gunzipSync(Buffer.from(res.body as Uint8Array));
    assert.equal(raw[0], 0x1a);
    // Layer.name field: key 0x0A, length 0x0f, then the id
    const nameStart = raw.indexOf(0x0a);
    const nameLen = raw[nameStart + 1];
    const name = raw.subarray(nameStart + 2, nameStart + 2 + nameLen).toString('utf8');
    assert.equal(name, 'stations_public');
  });
});
