/**
 * WD-005 trusted TileJSON resolution tests (SYNTHETIC samples only).
 *
 * Source of truth: docs/product/baseline/02-technical-specification.md:
 * "Do not blindly rewrite relative TileJSON links against the browser
 * location: resolve against the trusted NeoServer service URL and map only
 * allowlisted paths to the same-origin gateway" and "use advertised template
 * and actual source-layer ID"; 03-architecture.md: "Select source-layer IDs
 * and row/column order from actual TileJSON rather than a guessed endpoint
 * pattern."
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';

import {
  TileJsonError,
  assertSourceLayer,
  extractSourceLayer,
  parseTileJson,
  resolveTileJson,
  resolveTileTemplate,
  type ParsedTileTemplate,
} from '../src/tilejson.ts';
import { readFixture, readFixtureJson, TRUSTED_BASE, GATEWAY_ORIGIN } from './helpers.ts';

const allowPublicStations = (t: ParsedTileTemplate): boolean =>
  t.workspace === 'water-public' && t.collection === 'stations' && t.tileMatrixSet === 'WebMercatorQuad';

const resolve = (text: string, allowlist: (t: ParsedTileTemplate) => boolean = allowPublicStations) =>
  resolveTileJson({
    text,
    trustedServiceBase: TRUSTED_BASE,
    gatewayOrigin: GATEWAY_ORIGIN,
    gatewayPrefix: '/geo',
    isAllowedTileTemplate: allowlist,
  });

describe('relative links resolve against the TRUSTED service base, never the browser', () => {
  test('root-relative template is rewritten to the same-origin gateway path', () => {
    const r = resolve(readFixture('tilejson-water-public-stations.json'));
    assert.deepEqual(r.gatewayTemplates, [
      `${GATEWAY_ORIGIN}/geo/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/{z}/{y}/{x}`,
    ]);
  });

  test('the rewritten document leaks no upstream host anywhere', () => {
    const r = resolve(readFixture('tilejson-water-public-stations.json'));
    const serialized = JSON.stringify(r.tileJson);
    assert.ok(!serialized.includes('neo.internal'), 'upstream host must not appear in the browser-facing document');
    assert.ok(!serialized.includes(':9000'));
  });

  test('a template relative to the TileJSON document also resolves against the trusted base', () => {
    // '../' chains above the trusted service root clamp at the root, so the
    // template still lands on the advertised workspace path - resolved
    // against the SERVICE base, never against a browser location.
    const doc2 = JSON.stringify({
      tilejson: '3.0.0',
      tiles: ['../../../../../../../workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/{z}/{y}/{x}'],
      vector_layers: [{ id: 'stations_public' }],
    });
    const r = resolve(doc2);
    assert.equal(r.gatewayTemplates.length, 1);
    assert.ok(r.gatewayTemplates[0].startsWith(GATEWAY_ORIGIN));
  });

  test('an absolute template on the trusted origin is accepted and rewritten', () => {
    const doc = JSON.stringify({
      tilejson: '3.0.0',
      tiles: [`${TRUSTED_BASE}/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/{z}/{y}/{x}`],
      vector_layers: [{ id: 'stations_public' }],
    });
    const r = resolve(doc);
    assert.ok(r.gatewayTemplates[0].startsWith(GATEWAY_ORIGIN));
    assert.ok(!JSON.stringify(r.tileJson).includes('neo.internal'));
  });
});

describe('untrusted or unroutable templates fail loudly', () => {
  const docWith = (tiles: string[]): string =>
    JSON.stringify({ tilejson: '3.0.0', tiles, vector_layers: [{ id: 'stations_public' }] });

  test('an absolute template on ANOTHER origin is refused (no upstream host leak)', () => {
    assert.throws(
      () => resolve(docWith(['https://cdn.example.com/{z}/{y}/{x}'])),
      (err: unknown) => err instanceof TileJsonError && err.code === 'TILE_TEMPLATE_UNTRUSTED_ORIGIN',
    );
  });

  test('a template outside the allowlist is refused', () => {
    assert.throws(
      () => resolve(docWith(['/workspaces/water-private/ogc-tiles/collections/stations/tiles/WebMercatorQuad/{z}/{y}/{x}'])),
      (err: unknown) => err instanceof TileJsonError && err.code === 'TILE_TEMPLATE_NOT_ALLOWLISTED',
    );
  });

  test('a template with a query string (credential smuggling vector) is refused', () => {
    assert.throws(
      () => resolve(docWith(['/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/{z}/{y}/{x}?apikey=secret'])),
      (err: unknown) => err instanceof TileJsonError && err.code === 'TILE_TEMPLATE_QUERY_UNEXPECTED',
    );
  });

  test('a swapped x/y template shape is refused ({{x}} before {{y}})', () => {
    assert.throws(
      () => resolve(docWith(['/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/{z}/{x}/{y}'])),
      (err: unknown) => err instanceof TileJsonError && err.code === 'TILE_TEMPLATE_BAD_SHAPE',
    );
  });

  test('a guessed format suffix in the template is refused', () => {
    assert.throws(
      () => resolve(docWith(['/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/{z}/{y}/{x}.pbf'])),
      TileJsonError,
    );
  });

  test('a non-WebMercatorQuad matrix set is refused', () => {
    assert.throws(
      () => resolve(docWith(['/workspaces/water-public/ogc-tiles/collections/stations/tiles/WorldCRS84Quad/{z}/{y}/{x}'])),
      (err: unknown) => err instanceof TileJsonError && err.code === 'TILE_TEMPLATE_BAD_SHAPE',
    );
  });
});

describe('actual source-layer (never guessed)', () => {
  test('extractSourceLayer reads vector_layers[0].id, which differs from the collection id', () => {
    const doc = parseTileJson(readFixture('tilejson-water-public-stations.json'));
    assert.equal(extractSourceLayer(doc), 'stations_public'); // NOT 'stations'
  });

  test('a missing vector_layers fails loudly rather than guessing', () => {
    const doc = parseTileJson(JSON.stringify({ tilejson: '3.0.0', tiles: ['/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/{z}/{y}/{x}'] }));
    assert.throws(() => extractSourceLayer(doc), (err: unknown) => err instanceof TileJsonError && err.code === 'SOURCE_LAYER_ABSENT');
  });

  test('a guessed source-layer that disagrees with the document fails loudly', () => {
    const doc = parseTileJson(readFixture('tilejson-water-public-stations.json'));
    assert.throws(
      () => assertSourceLayer(doc, 'stations'), // the naive guess
      (err: unknown) => err instanceof TileJsonError && err.code === 'SOURCE_LAYER_MISMATCH',
    );
    assert.doesNotThrow(() => assertSourceLayer(doc, 'stations_public'));
  });
});

describe('MVT header decode control check (SYNTHETIC tile bytes)', () => {
  /**
   * Minimal hand-rolled protobuf walk: Tile.layers (field 3, wire type 2),
   * Layer.version (field 15, varint), Layer.name (field 1, wire type 2).
   * Proves the tile bytes carry the SAME source-layer id the TileJSON
   * advertises - the evidence chain the capture harness re-runs against a
   * live server.
   */
  function firstMvtLayerName(raw: Uint8Array): string {
    const b = raw[0];
    assert.equal(b, 0x1a, 'first field must be Tile.layers (field 3, wire type 2)');
    const len = raw[1];
    const layer = raw.subarray(2, 2 + len);
    let i = 0;
    let version = -1;
    let name = '';
    while (i < layer.length) {
      const key = layer[i];
      const field = key >> 3;
      const wireType = key & 0x07;
      i += 1;
      if (field === 15 && wireType === 0) {
        version = layer[i];
        i += 1;
      } else if (field === 1 && wireType === 2) {
        const nameLen = layer[i];
        name = new TextDecoder().decode(layer.subarray(i + 1, i + 1 + nameLen));
        i += 1 + nameLen;
      } else {
        throw new Error(`unexpected layer field ${field}/${wireType}`);
      }
    }
    assert.equal(version, 2, 'MVT layer version must be 2');
    return name;
  }

  test('decoded synthetic MVT layer name equals the TileJSON source-layer', () => {
    const fixture = readFixtureJson<{ gzipBase64: string; sourceLayer: string; tileHex: string }>('mvt-stations-public.json');
    const tile = gunzipSync(Buffer.from(fixture.gzipBase64, 'base64'));
    assert.equal(Buffer.from(tile).toString('hex'), fixture.tileHex, 'fixture integrity');
    const doc = parseTileJson(readFixture('tilejson-water-public-stations.json'));
    const advertised = extractSourceLayer(doc);
    assert.equal(firstMvtLayerName(tile), advertised, 'tile bytes and TileJSON must agree on the source-layer');
    assert.notEqual(advertised, 'stations', 'and it must not be the guessed collection id');
  });

  test('gzip-wrapped tile bytes are detected by magic (1f 8b) - the capture header check', () => {
    const fixture = readFixtureJson<{ gzipBase64: string }>('mvt-stations-public.json');
    const bytes = Buffer.from(fixture.gzipBase64, 'base64');
    assert.equal(bytes[0], 0x1f);
    assert.equal(bytes[1], 0x8b);
  });
});

describe('cohort TileJSON follows the same rules', () => {
  test('cohort template resolves trusted and re-maps same-origin with its own source layer', () => {
    const r = resolveTileJson({
      text: readFixture('tilejson-water-bear-cohort.json'),
      trustedServiceBase: TRUSTED_BASE,
      gatewayOrigin: GATEWAY_ORIGIN,
      gatewayPrefix: '/geo',
      isAllowedTileTemplate: (t) => t.workspace === 'water-bear-cohort' && t.collection === 'stations-restricted',
    });
    assert.equal(r.sourceLayer, 'stations_restricted');
    assert.ok(r.gatewayTemplates[0].startsWith(`${GATEWAY_ORIGIN}/geo/workspaces/water-bear-cohort/`));
    assert.ok(!JSON.stringify(r.tileJson).includes('neo.internal'));
  });

  test('a cohort template is NOT accepted under the public allowlist (isolation)', () => {
    assert.throws(
      () => resolve(readFixture('tilejson-water-bear-cohort.json'), allowPublicStations),
      (err: unknown) => err instanceof TileJsonError && err.code === 'TILE_TEMPLATE_NOT_ALLOWLISTED',
    );
  });
});

describe('shape validation', () => {
  test('invalid JSON, non-object JSON and missing tiles fail loudly', () => {
    assert.throws(() => parseTileJson('not json'), (e: unknown) => e instanceof TileJsonError && e.code === 'TILEJSON_INVALID_JSON');
    assert.throws(() => parseTileJson('[1,2]'), (e: unknown) => e instanceof TileJsonError && e.code === 'TILEJSON_INVALID_SHAPE');
    assert.throws(() => parseTileJson('{"tilejson":"3.0.0"}'), (e: unknown) => e instanceof TileJsonError && e.code === 'TILEJSON_INVALID_SHAPE');
    assert.throws(() => parseTileJson('{"tilejson":"3.0.0","tiles":[]}'), (e: unknown) => e instanceof TileJsonError && e.code === 'TILEJSON_NO_TEMPLATES');
  });

  test('resolveTileTemplate surfaces parsed coordinates for audit', () => {
    const { parsed } = resolveTileTemplate('/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/{z}/{y}/{x}', TRUSTED_BASE);
    assert.deepEqual(parsed, { workspace: 'water-public', collection: 'stations', tileMatrixSet: 'WebMercatorQuad' });
  });
});
