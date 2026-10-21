/**
 * WD-005 upstream URL building tests, with Utah control coordinates.
 *
 * Source of truth: docs/product/baseline/02-technical-specification.md,
 * "NeoServer and map transport": the MVT path is matrix/row/column (z/y/x);
 * WMS GetMap uses an EPSG:3857 bbox; WFS GetFeature carries an explicit
 * GeoJSON output format and a bounded COUNT; arbitrary upstream URLs and
 * unrestricted filters must not be forwarded. Control points are the frozen
 * fixture-world station coordinates (all SYNTHETIC).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  UrlBuildError,
  assertTrustedUpstream,
  buildUpstreamUrl,
  enforceLimit,
  lonLatToTile,
  project4326To3857,
  tileToLonLat,
  type UpstreamRouteParts,
} from '../src/url.ts';
import { UTAH_LAT, UTAH_LON } from './helpers.ts';

const BASE = 'http://neo.internal:9000';

// Utah control stations from fixtures/contracts/stations.json (SYNTHETIC world).
const BEAR_RIVER_CORINNE = { lat: 41.6337, lon: -112.1965 } as const;
const HYRUM_DIVERSION = { lat: 41.6295, lon: -111.8524 } as const;

/**
 * Independently derived expectation: slippy tile for z=10 computed by hand
 * from the standard WebMercatorQuad formulas, so a regression in lonLatToTile
 * cannot silently validate itself. (z10, row 381, column 192.)
 */
const Z10_CORINNE = { z: 10, y: 381, x: 192 } as const;

function withinUtah(lat: number, lon: number): boolean {
  return lat >= UTAH_LAT[0] && lat <= UTAH_LAT[1] && lon >= UTAH_LON[0] && lon <= UTAH_LON[1];
}

describe('Web Mercator control points (Utah)', () => {
  test('lonLatToTile matches the independently computed z10 tile for Bear River near Corinne', () => {
    const t = lonLatToTile(BEAR_RIVER_CORINNE.lon, BEAR_RIVER_CORINNE.lat, 10);
    assert.deepEqual({ z: t.z, y: t.y, x: t.x }, Z10_CORINNE);
  });

  test('the tile that contains the control station lies inside Utah (inverse check)', () => {
    const nw = tileToLonLat(Z10_CORINNE.z, Z10_CORINNE.y, Z10_CORINNE.x);
    assert.ok(withinUtah(nw.lat, nw.lon), `NW corner ${nw.lat},${nw.lon} must be in Utah`);

    const se = tileToLonLat(Z10_CORINNE.z, Z10_CORINNE.y + 1, Z10_CORINNE.x + 1);
    assert.ok(withinUtah(se.lat, se.lon), `SE corner ${se.lat},${se.lon} must be in Utah`);
  });

  test('SWAPPING x/y moves the tile out of Utah - the swap is detectable by control coordinates', () => {
    // A swapped path puts column 192 where the row belongs: row 192 of z10 is
    // around 73.8N, far outside Utah. This is exactly what the browser-side
    // control assertion (and capture harness) checks.
    const swapped = tileToLonLat(Z10_CORINNE.z, Z10_CORINNE.x, Z10_CORINNE.y);
    assert.ok(!withinUtah(swapped.lat, swapped.lon), `swapped corner ${swapped.lat},${swapped.lon} must NOT be in Utah`);
  });

  test('projection to 3857 yields plausible meter coordinates for Utah', () => {
    const p = project4326To3857(HYRUM_DIVERSION.lon, HYRUM_DIVERSION.lat);
    // Web Mercator: lon -111.85 -> about -12,458,000 m; lat 41.63 -> about 5,088,000 m.
    assert.ok(p.x < -12_000_000 && p.x > -13_000_000, `x ${p.x}`);
    assert.ok(p.y > 5_000_000 && p.y < 5_200_000, `y ${p.y}`);
  });
});

describe('tile URL building (matrix z/y/x)', () => {
  const route: UpstreamRouteParts = { workspace: 'water-public', service: 'ogc-tiles', collection: 'stations', operation: 'tile' };

  test('builds /tiles/WebMercatorQuad/{z}/{y}/{x} in matrix order with no format suffix', () => {
    const url = buildUpstreamUrl(BASE, route, { tile: { z: 10, y: 381, x: 192 } }, { maxLimit: 500 });
    assert.equal(
      url.pathname,
      '/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/10/381/192',
    );
    assert.equal(url.search, '');
  });

  test('the built tile URL is the tile that contains the Utah control station', () => {
    const t = lonLatToTile(BEAR_RIVER_CORINNE.lon, BEAR_RIVER_CORINNE.lat, 10);
    const url = buildUpstreamUrl(BASE, route, { tile: t }, { maxLimit: 500 });
    const seg = url.pathname.split('/').slice(-3).map(Number);
    const nw = tileToLonLat(seg[0], seg[1], seg[2]);
    assert.ok(withinUtah(nw.lat, nw.lon), 'built URL must address a Utah tile (matrix z/y/x order)');
  });

  test('out-of-matrix coordinates are rejected', () => {
    assert.throws(() => buildUpstreamUrl(BASE, route, { tile: { z: 10, y: 1024, x: 192 } }, { maxLimit: 500 }), UrlBuildError);
    assert.throws(() => buildUpstreamUrl(BASE, route, { tile: { z: 10, y: -1, x: 0 } }, { maxLimit: 500 }), UrlBuildError);
    assert.throws(() => buildUpstreamUrl(BASE, route, { tile: { z: 23, y: 0, x: 0 } }, { maxLimit: 500 }), UrlBuildError);
  });
});

describe('WMS GetMap URL (EPSG:3857 bbox)', () => {
  const route: UpstreamRouteParts = { workspace: 'water-public', service: 'wms', collection: 'basins', operation: 'wms-getmap' };
  const utah3857 = (): [number, number, number, number] => {
    const sw = project4326To3857(-114.05, 37.0);
    const ne = project4326To3857(-109.05, 42.0);
    return [sw.x, sw.y, ne.x, ne.y];
  };

  test('matches the specification example KVP set', () => {
    const url = buildUpstreamUrl(BASE, route, { bbox3857: utah3857(), width: 256, height: 256 }, { maxLimit: 500 });
    assert.equal(url.pathname, '/workspaces/water-public/wms');
    const q = url.searchParams;
    assert.equal(q.get('SERVICE'), 'WMS');
    assert.equal(q.get('VERSION'), '1.3.0');
    assert.equal(q.get('REQUEST'), 'GetMap');
    assert.equal(q.get('LAYERS'), 'basins');
    assert.equal(q.get('STYLES'), '');
    assert.equal(q.get('CRS'), 'EPSG:3857');
    assert.equal(q.get('WIDTH'), '256');
    assert.equal(q.get('HEIGHT'), '256');
    assert.equal(q.get('FORMAT'), 'image/png');
    assert.equal(q.get('TRANSPARENT'), 'true');
    const bbox = q.get('BBOX').split(',').map(Number);
    assert.equal(bbox.length, 4);
  });

  test('a degree-shaped bbox is rejected loudly (the WMS 1.3.0 axis-order accident)', () => {
    assert.throws(
      () => buildUpstreamUrl(BASE, route, { bbox3857: [-114.05, 37.0, -109.05, 42.0] }, { maxLimit: 500 }),
      (err: unknown) => err instanceof UrlBuildError && err.code === 'BBOX_NOT_PROJECTED',
    );
  });

  test('GetFeatureInfo I/J are bounded by the actual raster size', () => {
    const gfi: UpstreamRouteParts = { workspace: 'water-public', service: 'wms', collection: 'basins', operation: 'wms-getfeatureinfo' };
    const url = buildUpstreamUrl(BASE, gfi, { bbox3857: utah3857(), width: 256, height: 256, i: 100, j: 200 }, { maxLimit: 500 });
    assert.equal(url.searchParams.get('I'), '100');
    assert.equal(url.searchParams.get('J'), '200');
    assert.throws(
      () => buildUpstreamUrl(BASE, gfi, { bbox3857: utah3857(), width: 256, height: 256, i: 256, j: 0 }, { maxLimit: 500 }),
      UrlBuildError,
    );
  });
});

describe('WFS GetFeature URL (explicit GeoJSON, bounded COUNT)', () => {
  const route: UpstreamRouteParts = { workspace: 'water-public', service: 'wfs', collection: 'stations', operation: 'wfs-getfeature' };

  test('always carries OUTPUTFORMAT=application/json', () => {
    const url = buildUpstreamUrl(BASE, route, { limit: 100 }, { maxLimit: 500 });
    assert.equal(url.searchParams.get('OUTPUTFORMAT'), 'application/json');
    assert.equal(url.searchParams.get('TYPENAMES'), 'stations');
    assert.equal(url.searchParams.get('COUNT'), '100');
  });

  test('a CRS84 bbox is sent with SRSNAME=CRS:84 (explicit lon,lat axis order)', () => {
    const url = buildUpstreamUrl(BASE, route, { limit: 10, bboxCrs84: [-113.1, 41.0, -111.6, 42.0] }, { maxLimit: 500 });
    assert.equal(url.searchParams.get('SRSNAME'), 'CRS:84');
    assert.equal(url.searchParams.get('BBOX'), '-113.1,41,-111.6,42');
  });

  test('no mutation operation can ever be built', () => {
    assert.throws(
      () => buildUpstreamUrl(BASE, { workspace: 'water-public', service: 'wfs', collection: 'stations', operation: 'wfs-transaction' }, {}, { maxLimit: 500 }),
      (err: unknown) => err instanceof UrlBuildError && err.code === 'OP_UNKNOWN',
    );
  });
});

describe('limit enforcement', () => {
  test('requests above the ceiling are clamped, never unbounded', () => {
    assert.equal(enforceLimit(undefined, 500, 100), 100);
    assert.equal(enforceLimit(50, 500), 50);
    assert.equal(enforceLimit(10_000, 500), 500);
    assert.equal(enforceLimit(9999, 200), 200); // cohort ceiling
  });

  test('non-positive or non-integer limits throw', () => {
    assert.throws(() => enforceLimit(0, 500), UrlBuildError);
    assert.throws(() => enforceLimit(-5, 500), UrlBuildError);
    assert.throws(() => enforceLimit(2.5, 500), UrlBuildError);
  });

  test('default never exceeds the ceiling', () => {
    assert.equal(enforceLimit(undefined, 50, 100), 50);
  });
});

describe('arbitrary upstream URLs and credentials are structurally impossible', () => {
  test('there is no parameter that accepts a URL, filter expression or credential', () => {
    // UpstreamParams carries only typed numbers/ids/bboxes; this is a compile-
    // time property. At runtime, garbage ids still cannot smuggle paths:
    assert.throws(
      () =>
        buildUpstreamUrl(
          BASE,
          { workspace: 'water-public', service: 'ogc', collection: 'stations/../../api/v1', operation: 'items' },
          {},
          { maxLimit: 100 },
        ),
      UrlBuildError,
    );
    assert.throws(
      () => buildUpstreamUrl(BASE, { workspace: 'water-public', service: 'ogc', collection: 'stations', operation: 'feature' }, { featureId: '../../x' }, { maxLimit: 100 }),
      UrlBuildError,
    );
  });

  test('a base URL with embedded credentials is rejected', () => {
    assert.throws(
      () => buildUpstreamUrl('http://user:pass@neo.internal:9000', { workspace: 'water-public', service: 'ogc', operation: 'landing' }, {}, { maxLimit: 10 }),
      (err: unknown) => err instanceof UrlBuildError && err.code === 'BASE_INVALID',
    );
  });

  test('assertTrustedUpstream rejects foreign origins, management paths and traversal', () => {
    const built = buildUpstreamUrl(BASE, { workspace: 'water-public', service: 'ogc', operation: 'landing' }, {}, { maxLimit: 10 });
    assert.doesNotThrow(() => assertTrustedUpstream(built, BASE));
    assert.throws(() => assertTrustedUpstream(new URL('http://evil.example.com/workspaces/water-public/ogc/'), BASE), UrlBuildError);
    assert.throws(() => assertTrustedUpstream(new URL('http://neo.internal:9000/api/v1/apikeys'), BASE), UrlBuildError);
    assert.throws(() => assertTrustedUpstream(new URL('http://neo.internal:9000/workspaces/../api/v1'), BASE), UrlBuildError);
    assert.throws(() => assertTrustedUpstream(new URL('file:///etc/passwd'), BASE), UrlBuildError);
  });

  test('a base path prefix is respected', () => {
    const url = buildUpstreamUrl('http://neo.internal:9000/neo', { workspace: 'water-public', service: 'ogc', operation: 'landing' }, {}, { maxLimit: 10 });
    assert.equal(url.pathname, '/neo/workspaces/water-public/ogc/');
    assert.doesNotThrow(() => assertTrustedUpstream(url, 'http://neo.internal:9000/neo'));
    assert.throws(() => assertTrustedUpstream(url, 'http://neo.internal:9000'), UrlBuildError);
  });
});
