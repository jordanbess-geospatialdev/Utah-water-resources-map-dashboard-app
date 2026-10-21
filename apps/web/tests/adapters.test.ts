/**
 * Adapter tests, ported from the validated prototype's adapters.test.ts and
 * extended for the WD-006 contract world: gateway URL validation, GeoJSON
 * axis order, GeoLibre layer construction completeness, and stale-response
 * rejection.
 *
 * NOTE on imports: apps/web/tsconfig.json (orchestrator-owned) does not
 * enable allowImportingTsExtensions, while the scaffold's test runner
 * (node --test --experimental-strip-types) requires explicit .ts specifiers.
 * Tests therefore load modules through a computed specifier and restore
 * types with a type-only import, which satisfies both tools.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Extensionless src imports under node --test (see ts-resolve-hook.mjs).
register('./ts-resolve-hook.mjs', import.meta.url);

const gatewayPath = '../src/map/shell/gateway.ts';
const gateway: typeof import('../src/map/shell/gateway') = await import(gatewayPath);
const layersPath = '../src/map/shell/layers.ts';
const layers: typeof import('../src/map/shell/layers') = await import(layersPath);
const guardPath = '../src/map/shell/requestGuard.ts';
const guardModule: typeof import('../src/map/shell/requestGuard') = await import(guardPath);
const projectionPath = '../src/shell/data/projection.ts';
const projection: typeof import('../src/shell/data/projection') = await import(projectionPath);
const personasPath = '../src/shell/data/personas.ts';
const personasModule: typeof import('../src/shell/data/personas') = await import(personasPath);

test('preserve advertised z/y/x template and source metadata (ported)', () => {
  const source = gateway.neoVectorSource({ tiles: ['/geo/tiles/{z}/{y}/{x}'], vector_layers: [{ id: 'stations' }] });
  assert.equal(source.tiles[0], '/geo/tiles/{z}/{y}/{x}');
});

test('reject off-origin sources, credentials and unbounded requests (ported)', () => {
  assert.throws(() => gateway.trustedGatewayUrl('https://evil.example/geo/x'));
  assert.throws(() => gateway.trustedGatewayUrl('/geo/x?token=secret'));
  assert.throws(() => gateway.neoVectorSource({ tiles: [] }));
  assert.throws(() => gateway.neoVectorSource({ tiles: ['/geo/tiles/{z}/{x}/{y}'] }));
  assert.throws(() => gateway.boundedFeatures('stations', [-112, 38, -111, 39], 1001));
  assert.throws(() => gateway.boundedFeatures('../secret', [-112, 38, -111, 39]));
  assert.throws(() => gateway.boundedFeatures('stations', [-112, 39, -111, 38]));
});

test('bounded geojson and projected WMS paths (ported)', () => {
  assert.ok(gateway.boundedFeatures('stations', [-112, 38, -111, 39]).includes('limit=250'));
  assert.ok(gateway.wmsRasterTemplate('basins').includes('CRS=EPSG:3857'));
  assert.ok(!gateway.wmsRasterTemplate('basins').includes('4326'));
});

test('stationsToGeoJSON swaps fixture axis order to GeoJSON [longitude, latitude]', () => {
  const fatimaViewer = { personaId: 'fatima', role: 'engineer' as const, principalId: 'principal-fatima-engineer', organizationId: null };
  const catalog = projection.projectCatalog(fatimaViewer);
  const corinne = catalog.find((station) => station.id === 'sta-bear-corinne');
  assert.ok(corinne, 'public telemetry station in catalog');
  const geojson = layers.stationsToGeoJSON(catalog);
  const feature = geojson.features.find((f) => f.properties?.stationId === 'sta-bear-corinne');
  assert.ok(feature);
  const geometry = feature.geometry as { type: 'Point'; coordinates: [number, number] };
  const [longitude, latitude] = geometry.coordinates;
  // Fixture records latitude 41.6337 then longitude -112.1965; the swap is detectable by value.
  assert.equal(latitude, corinne.latitude);
  assert.equal(longitude, corinne.longitude);
  assert.ok(Math.abs(latitude - 41.6337) < 1e-9, `latitude band must stay ~41-42 N, got ${latitude}`);
  assert.ok(Math.abs(longitude + 112.1965) < 1e-9, `longitude must stay ~-112 W, got ${longitude}`);
});

test('a swapped axis order is rejected, not silently plotted', () => {
  const publicViewer = { personaId: 'donna', role: 'public' as const, principalId: null, organizationId: null };
  const catalog = projection.projectCatalog(publicViewer);
  const swapped = catalog.map((station) => ({ ...station, latitude: station.longitude, longitude: station.latitude }));
  assert.throws(() => layers.stationsToGeoJSON(swapped), /axis order suspected swapped/);
});

test('GeoLibre layers are complete, stable and carry fixture provenance', () => {
  const publicViewer = { personaId: 'donna', role: 'public' as const, principalId: null, organizationId: null };
  const catalog = projection.projectCatalog(publicViewer);
  const built = layers.buildStationLayers(catalog, 'sta-bear-corinne');
  assert.deepEqual(
    built.map((layer) => layer.id),
    ['stations-current', 'stations-attention', 'stations-unavailable', 'station-selected'],
  );
  for (const layer of built) {
    assert.equal(typeof layer.id, 'string');
    assert.equal(typeof layer.name, 'string');
    assert.equal(layer.type, 'geojson');
    assert.equal(layer.visible, true);
    assert.equal(layer.opacity, 1);
    assert.ok(layer.style && typeof layer.style.circleRadius === 'number');
    assert.ok(String(layer.metadata.provenance).includes('utah-water-fixture-v1'));
    assert.ok(layer.geojson && layer.geojson.type === 'FeatureCollection');
  }
  const selected = built.at(-1)!;
  assert.equal(selected.geojson!.features.length, 1);
  assert.equal(selected.geojson!.features[0]!.properties?.stationId, 'sta-bear-corinne');
  const withoutSelection = layers.buildStationLayers(catalog, null);
  assert.ok(withoutSelection.every((layer) => layer.id !== 'station-selected'));
});

test('a fresh flagged station uses the attention layer promised by the legend', () => {
  const catalog = projection.projectCatalog(personasModule.viewerFor(personasModule.personaById('donna')));
  const station = catalog.find((entry) => entry.latest !== null)!;
  const flagged = { ...station, status: 'active' as const, freshness: 'current' as const, latest: { ...station.latest!, flags: ['out-of-range' as const] } };
  assert.equal(layers.stationLayerClass(flagged), 'attention');
  const built = layers.buildStationLayers([flagged], null);
  assert.equal(built.find((layer) => layer.id === 'stations-current')!.geojson!.features.length, 0);
  assert.equal(built.find((layer) => layer.id === 'stations-attention')!.geojson!.features[0]!.properties?.stationId, flagged.id);
});

test('restricted fields never enter map feature properties, even for entitled viewers', () => {
  const fatimaViewer = { personaId: 'fatima', role: 'engineer' as const, principalId: 'principal-fatima-engineer', organizationId: null };
  const catalog = projection.projectCatalog(fatimaViewer);
  // Fatima's projection legitimately carries the internal block…
  const corinne = catalog.find((station) => station.id === 'sta-bear-corinne')!;
  assert.equal(corinne.internal?.gateCode, '4471-CDX');
  // …but the map adapter must not copy it into feature properties.
  const serialized = JSON.stringify(layers.buildStationLayers(catalog, null));
  assert.ok(!serialized.includes('4471-CDX'));
  assert.ok(!serialized.includes('gateCode'));
  assert.ok(!serialized.includes('wiringNotes'));
});

test('request guard rejects superseded async completions', async () => {
  const guard = guardModule.createRequestGuard();
  const first = guard.begin();
  const second = guard.begin();
  assert.equal(guard.isCurrent(first), false, 'older token is stale after a newer begin()');
  assert.equal(guard.isCurrent(second), true);
  const applied = await guardModule.onlyLatest(guard, async (token) => (guard.isCurrent(token) ? 'applied' : 'dropped'));
  assert.equal(applied, 'applied');
  const staleToken = first;
  const stale = await guardModule.onlyLatest(guard, async () => {
    await Promise.resolve();
    return guard.isCurrent(staleToken) ? 'applied' : null;
  });
  assert.equal(stale, null, 'stale completion resolves to null and is not applied');
});

test('personas map onto fixture principals with six entry points', () => {
  assert.equal(personasModule.personas.length, 6);
  assert.deepEqual(
    personasModule.personas.map((persona) => persona.id),
    ['donna', 'wiley', 'sarah', 'cody', 'fatima', 'diego'],
  );
  const fatima = personasModule.personaById('fatima');
  assert.equal(fatima.principalId, 'principal-fatima-engineer');
  const wiley = personasModule.personaById('wiley');
  assert.equal(wiley.organizationId, 'org-cache-water');
  assert.match(wiley.principalNote, /Demo synthesis/);
});
