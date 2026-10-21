/**
 * WD-005 route-allowlist unit tests.
 *
 * Source of truth: docs/product/baseline/03-architecture.md ("The gateway
 * allowlists workspace, service, layer and operation... It must not expose
 * NeoServer administration or proxy arbitrary URLs. Disable WFS mutations for
 * portal routes") and the example paths in 02-technical-specification.md
 * ("NeoServer and map transport"). All samples are SYNTHETIC.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  GATEWAY_ROUTES,
  isForbiddenUpstreamPath,
  isWfsMutationRequest,
  matchOperation,
  matchRoute,
  resolveWxsOperation,
} from '../src/allowlist.ts';

describe('allowlisted example routes (tech-spec example paths)', () => {
  test('public items path matches the specification example', () => {
    const m = matchRoute('/workspaces/water-public/ogc/collections/stations/items');
    assert.ok(m.ok);
    assert.equal(m.workspace, 'water-public');
    assert.equal(m.service, 'ogc');
    assert.equal(m.operation, 'items');
    assert.equal(m.collection, 'stations');
    assert.equal(m.audience, 'public');
    assert.equal(m.maxLimit, 500);
    assert.equal(m.guardObjectId, 'sta-bear-corinne');
  });

  test('tilejson and tile paths match the specification examples', () => {
    const tj = matchRoute('/workspaces/water-public/ogc-tiles/collections/stations/tilejson.json');
    assert.ok(tj.ok && tj.operation === 'tilejson');
    const tile = matchRoute('/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/10/381/192');
    assert.ok(tile.ok);
    assert.deepEqual(tile.tile, { z: 10, y: 381, x: 192 });
  });

  test('cohort workspace example is allowlisted with a cohort audience', () => {
    const m = matchRoute('/workspaces/water-bear-cohort/ogc/collections/stations-restricted/items');
    assert.ok(m.ok);
    assert.equal(m.audience, 'cohort');
    assert.equal(m.guardObjectId, 'sta-hyrum-diversion-owner');
  });

  test('service-level routes (landing/conformance/collections) are guarded', () => {
    for (const p of [
      '/workspaces/water-public/ogc',
      '/workspaces/water-public/ogc/conformance',
      '/workspaces/water-public/ogc/api',
      '/workspaces/water-public/ogc/collections',
    ]) {
      const m = matchRoute(p);
      assert.ok(m.ok, `${p} should match`);
      assert.ok(m.guardObjectId.length > 0, 'service-level route carries a guard object');
    }
  });
});

describe('deny-by-default (unknown anything -> deny)', () => {
  test('unlisted workspace is denied without disclosing it might exist elsewhere', () => {
    const m = matchRoute('/workspaces/water-private-evil/ogc/collections/stations/items');
    assert.ok(!m.ok);
    assert.equal(m.reason, 'unknown-workspace');
  });

  test('unlisted collection is denied', () => {
    const m = matchRoute('/workspaces/water-public/ogc/collections/ownership-table/items');
    assert.ok(!m.ok);
    assert.equal(m.reason, 'unknown-collection');
  });

  test('unpublished service on a listed workspace is denied', () => {
    const m = matchRoute('/workspaces/water-bear-cohort/wms');
    assert.ok(!m.ok);
    assert.equal(m.reason, 'unknown-service');
  });

  test('unknown service kind is denied', () => {
    const m = matchRoute('/workspaces/water-public/sensorthings');
    assert.ok(!m.ok);
    assert.equal(m.reason, 'unknown-service');
  });

  test('operation not in the layer allowlist is denied (draft projection has no tilejson op)', () => {
    const m = matchRoute('/workspaces/water-public/ogc/collections/stations-draft/tilejson.json');
    assert.ok(!m.ok);
    assert.equal(m.reason, 'malformed-path'); // ogc service, not ogc-tiles: wrong service path
    const m2 = matchOperation(GATEWAY_ROUTES, 'water-public', 'ogc', 'stations-draft', 'collections');
    assert.ok(!m2.ok);
    assert.equal(m2.reason, 'operation-not-allowed');
  });
});

describe('NeoServer administration / service-management is always denied', () => {
  test('management API paths are denied as admin-path', () => {
    for (const p of ['/api/v1/workspaces', '/api/v1/apikeys', '/api', '/admin', '/admin/console', '/auth/login', '/api/v1/tile-cache/jobs']) {
      assert.ok(isForbiddenUpstreamPath(p), `${p} must be forbidden`);
    }
  });

  test('gateway requests to admin paths never route', () => {
    const m = matchRoute('/api/v1/workspaces/water-public/settings/wms');
    assert.ok(!m.ok);
    assert.equal(m.reason, 'admin-path');
  });

  test('traversal is forbidden', () => {
    assert.ok(isForbiddenUpstreamPath('/workspaces/water-public/ogc/../../api/v1'));
  });
});

describe('WFS mutations are always denied for portal routes', () => {
  test('every WFS 2.0 transaction verb is classified as a mutation', () => {
    for (const verb of ['Transaction', 'transaction', 'Insert', 'Update', 'Delete', 'Replace']) {
      assert.ok(isWfsMutationRequest(verb), verb);
    }
    assert.ok(!isWfsMutationRequest('GetFeature'));
    assert.ok(!isWfsMutationRequest(undefined));
  });

  test('REQUEST=Transaction is denied before any upstream call', () => {
    const q = new URLSearchParams('SERVICE=WFS&VERSION=2.0.0&REQUEST=Transaction');
    const r = resolveWxsOperation('wfs', q);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'wfs-mutation-denied');
  });

  test('GetFeatureWithLock (lock-for-mutation) is denied', () => {
    const q = new URLSearchParams('REQUEST=GetFeatureWithLock&TYPENAMES=stations');
    const r = resolveWxsOperation('wfs', q);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'wfs-mutation-denied');
  });

  test('read WFS operations resolve with their layer', () => {
    const r = resolveWxsOperation('wfs', new URLSearchParams('SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=stations'));
    assert.ok(r.ok);
    assert.equal(r.operation, 'wfs-getfeature');
    assert.equal(r.collection, 'stations');
    const m = matchOperation(GATEWAY_ROUTES, 'water-public', 'wfs', 'stations', 'wfs-getfeature');
    assert.ok(m.ok);
  });

  test('REQUEST is required explicitly (no guessing)', () => {
    const r = resolveWxsOperation('wfs', new URLSearchParams(''));
    assert.ok(!r.ok);
    assert.equal(r.reason, 'malformed-path');
  });

  test('unlisted WFS layer is denied after KVP resolution', () => {
    const r = matchOperation(GATEWAY_ROUTES, 'water-public', 'wfs', 'gate-codes', 'wfs-getfeature');
    assert.ok(!r.ok);
    assert.equal(r.reason, 'unknown-collection');
  });
});

describe('tile matrix validation (matrix z/y/x)', () => {
  test('row/column beyond 2^z-1 are rejected (swap detection when one exceeds)', () => {
    const m = matchRoute('/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/10/381/1024');
    assert.ok(!m.ok);
    assert.equal(m.reason, 'invalid-tile-coordinates');
  });

  test('a guessed .pbf suffix is rejected', () => {
    const m = matchRoute('/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/10/381/192.pbf');
    assert.ok(!m.ok);
    assert.equal(m.reason, 'malformed-path');
  });

  test('only WebMercatorQuad is routed', () => {
    const m = matchRoute('/workspaces/water-public/ogc-tiles/collections/stations/tiles/WorldCRS84Quad/10/381/192');
    assert.ok(!m.ok);
    assert.equal(m.reason, 'malformed-path');
  });

  test('zoom above 22 is rejected', () => {
    const m = matchRoute('/workspaces/water-public/ogc-tiles/collections/stations/tiles/WebMercatorQuad/23/0/0');
    assert.ok(!m.ok);
    assert.equal(m.reason, 'invalid-tile-coordinates');
  });
});
