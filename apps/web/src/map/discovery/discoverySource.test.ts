/**
 * Discovery map-source tests (FR-001; T-10): public projection only, bounded
 * bbox retrieval with limit caps, axis-order safety, property whitelist (no
 * restricted field reaches a layer property), stale-response rejection on
 * filter change, and the gateway query-string reuse.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/map/discovery/discoverySource.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { DiscoveryBbox } from './discoverySource';

// Extensionless src imports under node --test (see tests/ts-resolve-hook.mjs).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const sourcePath = './discoverySource.ts';
const d: typeof import('./discoverySource') = await import(sourcePath);
const gatewayPath = '../shell/gateway.ts';
const shellGateway: typeof import('../shell/gateway') = await import(gatewayPath);

/** Bounds of the whole fixture world plus margin. */
const STATE_WIDE: DiscoveryBbox = { west: -113.5, south: 41.0, east: -111.0, north: 42.2 };
/** Tight box around Bear River near Corinne (lon -112.1965, lat 41.6337). */
const CORINNE_BOX: DiscoveryBbox = { west: -112.25, south: 41.6, east: -112.15, north: 41.7 };

test('the discovery catalog is the public projection row set with no internal block', () => {
  const catalog = d.publicDiscoveryCatalog();
  assert.deepEqual(
    catalog.map((station) => station.id),
    ['sta-bear-corinne', 'sta-hyrum-diversion-public', 'sta-summit-creek-inactive'],
  );
  for (const station of catalog) {
    assert.equal(station.access, 'public');
    assert.equal(station.internal, null, 'the public viewer never receives the internal block');
  }
});

test('default retrieval returns the whole public catalog, axis order lon/lat with a Utah-band assertion', () => {
  const result = d.discoveryFeatures();
  assert.equal(result.total, 3);
  assert.equal(result.returned, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.limit, d.DEFAULT_DISCOVERY_LIMIT);
  for (const feature of result.collection.features) {
    const [longitude, latitude] = feature.geometry.coordinates as [number, number];
    assert.ok(typeof longitude === 'number' && longitude < -111, `longitude first (got ${longitude})`);
    assert.ok(latitude >= 41.0 && latitude <= 42.1, `latitude in the Utah band (got ${latitude})`);
    assert.deepEqual(Object.keys(feature.properties ?? {}).sort(), [...d.DISCOVERY_PROPERTY_WHITELIST].sort());
    assert.equal(feature.properties?.stationId, feature.id);
  }
});

test('no restricted field, identifier or value may reach any layer property', () => {
  const forbidden = [
    'gateCode',
    'wiringNotes',
    '4471-CDX',
    'internal',
    'ownerOrganizationId',
    'sta-hyrum-diversion-owner',
    'sta-bear-lake-diagnostic',
    'sta-ogden-valley-proposed',
    'str-diag-voltage',
    'str-hyrum-q-owner',
    'principal-',
    'org-',
  ];
  const serializedFeatures = JSON.stringify(d.discoveryFeatures().collection);
  for (const marker of forbidden) assert.ok(!serializedFeatures.includes(marker), `features must not carry "${marker}"`);
  const layers = d.buildDiscoveryLayers(d.publicDiscoveryCatalog(), null);
  for (const layer of layers) {
    const serializedLayer = JSON.stringify(layer);
    for (const marker of forbidden) assert.ok(!serializedLayer.includes(marker), `layer ${layer.id} must not carry "${marker}"`);
  }
});

test('bbox-bounded retrieval returns only in-viewport stations', () => {
  const corinne = d.discoveryFeatures({ bbox: CORINNE_BOX });
  assert.deepEqual(
    corinne.collection.features.map((feature) => feature.properties?.stationId),
    ['sta-bear-corinne'],
  );
  const none = d.discoveryFeatures({ bbox: { west: -1, south: -1, east: 1, north: 1 } });
  assert.equal(none.total, 0);
  assert.equal(none.collection.features.length, 0);
});

test('invalid boxes and limits throw instead of guessing', () => {
  assert.throws(() => d.discoveryFeatures({ bbox: { west: -111, south: 42, east: -112, north: 41 } }), /Invalid geographic bounding box/);
  assert.throws(() => d.discoveryFeatures({ bbox: { west: Number.NaN, south: 41, east: -111, north: 42 } }), /Invalid geographic bounding box/);
  assert.throws(() => d.discoveryFeatures({ limit: 0 }), /Limit must be 1–1000/);
  assert.throws(() => d.discoveryFeatures({ limit: 1001 }), /Limit must be 1–1000/);
  assert.throws(() => d.discoveryFeatures({ limit: 2.5 }), /Limit must be 1–1000/);
  assert.equal(d.discoveryFeatures({ limit: 1000 }).limit, 1000);
});

test('the limit cap truncates with an explicit flag', () => {
  const capped = d.discoveryFeatures({ bbox: STATE_WIDE, limit: 1 });
  assert.equal(capped.total, 3);
  assert.equal(capped.returned, 1);
  assert.equal(capped.truncated, true);
  assert.equal(capped.collection.features.length, 1);
});

test('filters apply inside the bounded request (AND across dimensions, OR within)', () => {
  const flumeOrWeir = d.discoveryFeatures({ bbox: STATE_WIDE, filters: { siteTypeIds: ['flume', 'weir'] } });
  assert.deepEqual(
    flumeOrWeir.collection.features.map((feature) => feature.properties?.stationId),
    ['sta-hyrum-diversion-public', 'sta-summit-creek-inactive'],
  );
  const narrowed = d.discoveryFeatures({ bbox: CORINNE_BOX, filters: { siteTypeIds: ['flume', 'weir'] } });
  assert.equal(narrowed.total, 0, 'corinne is a natural channel — filters AND with the viewport');
  const unknownOnly = d.discoveryFeatures({ bbox: STATE_WIDE, filters: { telemetry: ['unknown'] } });
  assert.equal(unknownOnly.total, 0, 'unknown vocabulary and uncarried enum states match nothing publicly');
});

test('layer descriptors: stable ids, selected highlight, provenance metadata', () => {
  const catalog = d.publicDiscoveryCatalog();
  assert.deepEqual(d.DISCOVERY_LAYER_IDS, ['discovery-stations', 'discovery-stations-selected']);
  const unselected = d.buildDiscoveryLayers(catalog, null);
  assert.deepEqual(unselected.map((layer) => layer.id), ['discovery-stations']);
  const selected = d.buildDiscoveryLayers(catalog, 'sta-hyrum-diversion-public');
  assert.deepEqual(selected.map((layer) => layer.id), ['discovery-stations', 'discovery-stations-selected']);
  assert.equal(selected[1]!.geojson!.features.length, 1);
  assert.equal(selected[1]!.geojson!.features[0]!.properties?.stationId, 'sta-hyrum-diversion-public');
  assert.ok(String(selected[0]!.metadata?.provenance).includes('public projection'));
  assert.ok(String(selected[0]!.metadata?.transport).includes('GeoJSON'));
});

test('the gateway query reuses the shell URL builder semantics verbatim', () => {
  const query = d.gatewayFeaturesQuery(CORINNE_BOX, 10);
  assert.equal(query, shellGateway.boundedFeatures('stations', [CORINNE_BOX.west, CORINNE_BOX.south, CORINNE_BOX.east, CORINNE_BOX.north], 10));
  assert.ok(query.startsWith('/geo/workspaces/water-public/ogc/collections/stations/items?'));
  assert.ok(query.includes('bbox='));
  assert.ok(query.includes('limit=10'));
  assert.throws(() => d.gatewayFeaturesQuery({ west: 1, south: 1, east: 0, north: 2 }), /Invalid geographic bounding box/);
});

test('stale responses are rejected after a filter change; only the newest load applies', async () => {
  const source = d.createDiscoverySource();
  const stale = source.load({ filters: { siteTypeIds: ['flume'] } });
  const fresh = source.load({ filters: { siteTypeIds: ['weir'] } });
  const staleResult = await stale;
  const freshResult = await fresh;
  assert.equal(staleResult, null, 'a superseded completion resolves null and is never applied');
  assert.equal(freshResult?.total, 1);
  assert.equal(freshResult?.collection.features[0]!.properties?.stationId, 'sta-summit-creek-inactive');

  // A superseded INVALID request also resolves null instead of rejecting late.
  const first = source.load({});
  const invalid = source.load({ bbox: { west: 1, south: 1, east: 0, north: 2 } });
  assert.equal(await first, null);
  await assert.rejects(invalid, /Invalid geographic bounding box/, 'the current load surfaces its validation error');

  // The guard recovers: the next load is current again and applies.
  const recovered = await source.load({ filters: { siteTypeIds: ['flume'] } });
  assert.equal(recovered?.collection.features[0]!.properties?.stationId, 'sta-hyrum-diversion-public');
});

test('transport notes document the MVT-vs-GeoJSON selection against the gateway allowlist', () => {
  assert.ok(d.TRANSPORT_NOTES.selectionRule.includes('GeoJSON') && d.TRANSPORT_NOTES.selectionRule.includes('MVT'));
  assert.ok(d.TRANSPORT_NOTES.mvt.includes('WebMercatorQuad/{z}/{y}/{x}'));
  assert.ok(d.TRANSPORT_NOTES.geojson.includes('geo-gateway'));
  assert.ok(d.TRANSPORT_NOTES.invariants.includes('DISCOVERY_PROPERTY_WHITELIST'));
});
