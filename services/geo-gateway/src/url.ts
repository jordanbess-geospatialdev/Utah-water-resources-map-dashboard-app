/**
 * Upstream URL construction for the authorized spatial gateway (WD-005).
 *
 * Source of truth: docs/product/baseline/02-technical-specification.md,
 * "NeoServer and map transport":
 * - tile path is `/tiles/WebMercatorQuad/{z}/{y}/{x}` - matrix/row/column.
 *   "Do not swap x/y, add a guessed `.pbf` suffix".
 * - WMS GetMap is built with an EPSG:3857 bbox ("prefer EPSG:3857 in
 *   MapLibre"); WMS 1.3.0 EPSG:4326 axis order (lat,lon) is a capture-time
 *   qualification check, not something this builder guesses.
 * - WFS GetFeature always carries an explicit GeoJSON output format
 *   (`OUTPUTFORMAT=application/json`) and a bounded COUNT.
 * - "Do not forward unrestricted filters or arbitrary upstream URLs": the
 *   builder accepts ONLY typed, allowlist-derived parameters - there is no
 *   code path that accepts a caller-supplied URL, filter expression or
 *   service credential.
 *
 * Pure module: no fetch, no clock, no secrets. All validation failures throw
 * UrlBuildError so callers (and tests) can fail loudly.
 */

export const WEB_MERCATOR_MAX_METERS = 20037508.342789244;

/** Error carrying a stable machine-readable code plus human detail. */
export class UrlBuildError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`[${code}] ${detail}`);
    this.code = code;
    this.name = 'UrlBuildError';
  }
}

// ---------------------------------------------------------------------------
// Web Mercator math (pure helpers shared with tests' Utah control points)
// ---------------------------------------------------------------------------

const D2R = Math.PI / 180;
const R = 6378137; // WGS84 semi-major axis, meters (Web Mercator sphere)

/** Project EPSG:4326 longitude/latitude (degrees, lon-first like CRS84) to EPSG:3857 meters. */
export function project4326To3857(lon: number, lat: number): { x: number; y: number } {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat <= -90 || lat >= 90) {
    throw new UrlBuildError('BBOX_INVALID_4326', `lon/lat out of range: ${lon}, ${lat}`);
  }
  if (lon < -180 || lon > 180) throw new UrlBuildError('BBOX_INVALID_4326', `longitude out of range: ${lon}`);
  return { x: R * lon * D2R, y: R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) };
}

/** WebMercatorQuad tile coordinates for lon/lat at zoom (matrix/row/column -> z/y/x). */
export function lonLatToTile(lon: number, lat: number, z: number): { z: number; y: number; x: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latR = lat * D2R;
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n);
  return { z, y, x };
}

/** Northwest corner (lon/lat, degrees) of a WebMercatorQuad tile. */
export function tileToLonLat(z: number, y: number, x: number): { lon: number; lat: number } {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const latR = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lon, lat: latR / D2R };
}

// ---------------------------------------------------------------------------
// Upstream URL building
// ---------------------------------------------------------------------------

/** Typed parameters the gateway can legally forward. Everything else a caller sends is dropped. */
export interface UpstreamParams {
  /** Tile requests: validated matrix coordinates in z/y/x order. */
  readonly tile?: Readonly<{ z: number; y: number; x: number }>;
  /** Single feature id (OGC API - Features). */
  readonly featureId?: string;
  /** Page size for items/GetFeature. Clamped to the route's maxLimit. */
  readonly limit?: number;
  /** Page offset (items `offset`, WFS `STARTINDEX`). */
  readonly offset?: number;
  /** CRS84 bbox [minx, miny, maxx, maxy] in DEGREES for Features `bbox` / WFS `BBOX` (lon,lat order). */
  readonly bboxCrs84?: readonly [number, number, number, number];
  /** EPSG:3857 bbox [minx, miny, maxx, maxy] in METERS for WMS GetMap. Degree-shaped input is rejected. */
  readonly bbox3857?: readonly [number, number, number, number];
  /** WMS raster size. Defaults 256x256; bounds-checked. */
  readonly width?: number;
  readonly height?: number;
  /** WMS GetFeatureInfo pixel position. */
  readonly i?: number;
  readonly j?: number;
}

export interface BuildUpstreamOptions {
  /** Route ceiling for limit/COUNT. Required - limits are never unbounded. */
  readonly maxLimit: number;
  /** Default page size when the caller omits limit (kept at/below maxLimit). */
  readonly defaultLimit?: number;
}

function requireInt(name: string, v: number | undefined, min: number, max: number): number {
  if (v === undefined) throw new UrlBuildError('PARAM_MISSING', `${name} is required`);
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new UrlBuildError('PARAM_INVALID', `${name} must be an integer in [${min}, ${max}] (got ${v})`);
  }
  return v;
}

function intOrUndefined(name: string, v: number | undefined, min: number, max: number): number | undefined {
  return v === undefined ? undefined : requireInt(name, v, min, max);
}

/**
 * Clamp a requested page size into [1, maxLimit]. "Limit enforcement":
 * requests above the ceiling are clamped (never silently unbounded), and
 * the effective value is what appears in the URL - callers can surface it.
 */
export function enforceLimit(requested: number | undefined, maxLimit: number, defaultLimit = 100): number {
  if (!Number.isInteger(maxLimit) || maxLimit < 1) throw new UrlBuildError('LIMIT_INVALID', `maxLimit must be a positive integer (got ${maxLimit})`);
  const base = requested === undefined ? Math.min(defaultLimit, maxLimit) : requested;
  if (!Number.isInteger(base) || base < 1) throw new UrlBuildError('LIMIT_INVALID', `limit must be a positive integer (got ${requested})`);
  return Math.min(base, maxLimit);
}

function checkBbox3857(bbox: readonly [number, number, number, number]): void {
  const [minx, miny, maxx, maxy] = bbox;
  if (![minx, miny, maxx, maxy].every(Number.isFinite)) throw new UrlBuildError('BBOX_INVALID_3857', 'bbox values must be finite numbers');
  if (minx >= maxx || miny >= maxy) throw new UrlBuildError('BBOX_INVALID_3857', 'bbox must satisfy minx<maxx and miny<maxy');
  const withinMeters = bbox.every((v) => Math.abs(v) <= WEB_MERCATOR_MAX_METERS);
  if (!withinMeters) throw new UrlBuildError('BBOX_INVALID_3857', `bbox exceeds the EPSG:3857 world extent (+/- ${WEB_MERCATOR_MAX_METERS.toFixed(0)} m)`);
  // Degree-shaped input (every |value| <= 180) is a longitude/latitude bbox: the
  // classic WMS 1.3.0 axis-order accident. Fail loudly instead of rendering a
  // wrong map. Convert first (project4326To3857 or the caller's projection).
  if (bbox.every((v) => Math.abs(v) <= 180)) {
    throw new UrlBuildError(
      'BBOX_NOT_PROJECTED',
      'bbox values look like degrees, not meters: WMS GetMap through this gateway is EPSG:3857; project with project4326To3857 (and remember WMS 1.3.0 EPSG:4326 is lat,lon while CRS84 is lon,lat)',
    );
  }
}

function checkBboxCrs84(bbox: readonly [number, number, number, number]): void {
  const [minx, miny, maxx, maxy] = bbox;
  if (![minx, miny, maxx, maxy].every(Number.isFinite)) throw new UrlBuildError('BBOX_INVALID_4326', 'bbox values must be finite numbers');
  if (minx >= maxx || miny >= maxy) throw new UrlBuildError('BBOX_INVALID_4326', 'bbox must satisfy minx<maxx and miny<maxy');
  if (minx < -180 || maxx > 180 || miny < -90 || maxy > 90) {
    throw new UrlBuildError('BBOX_INVALID_4326', 'CRS84 bbox outside lon/lat degree ranges (check axis order: CRS84 is lon,lat)');
  }
}

export interface UpstreamRouteParts {
  readonly workspace: string;
  readonly service: 'ogc' | 'ogc-tiles' | 'wfs' | 'wms';
  readonly collection?: string;
  readonly operation: string;
}

/**
 * Build the trusted upstream URL for an allowlisted route.
 *
 * The base URL is the TRUSTED NeoServer service base (config/secrets
 * injected, never caller-supplied). The output is fully-qualified, and
 * assertTrustedUpstream() double-checks it before any fetch: same origin as
 * the base, no userinfo, no traversal, no fragment.
 */
export function buildUpstreamUrl(base: string, route: UpstreamRouteParts, params: UpstreamParams, options: BuildUpstreamOptions): URL {
  let parsedBase: URL;
  try {
    parsedBase = new URL(base);
  } catch {
    throw new UrlBuildError('BASE_INVALID', `upstream base is not a URL: ${base}`);
  }
  if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
    throw new UrlBuildError('BASE_INVALID', `upstream base must be http(s): ${parsedBase.protocol}`);
  }
  if (parsedBase.username || parsedBase.password) {
    throw new UrlBuildError('BASE_INVALID', 'upstream base must not embed credentials (userinfo)');
  }

  const workspace = route.workspace;
  const collection = route.collection ?? '';
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(workspace) || (collection !== '' && !/^[a-z0-9][a-z0-9-_]*$/.test(collection))) {
    throw new UrlBuildError('ROUTE_INVALID', `workspace/collection ids must match [a-z0-9][a-z0-9-_]* (got "${workspace}", "${collection}")`);
  }

  const url = new URL(parsedBase);
  // Gateway/upstream paths never carry a trailing base path beyond '/'; keep it simple and explicit.
  const basePath = parsedBase.pathname.replace(/\/+$/, '');

  const append = (query: Array<[string, string | number]>): void => {
    for (const [k, v] of query) url.searchParams.append(k, String(v));
  };

  if (route.service === 'ogc') {
    switch (route.operation) {
      case 'landing':
        url.pathname = `${basePath}/workspaces/${workspace}/ogc/`;
        break;
      case 'conformance':
        url.pathname = `${basePath}/workspaces/${workspace}/ogc/conformance`;
        break;
      case 'openapi':
        url.pathname = `${basePath}/workspaces/${workspace}/ogc/api`;
        break;
      case 'collections':
        url.pathname = `${basePath}/workspaces/${workspace}/ogc/collections`;
        break;
      case 'collection':
        url.pathname = `${basePath}/workspaces/${workspace}/ogc/collections/${collection}`;
        break;
      case 'items': {
        if (collection === '') throw new UrlBuildError('ROUTE_INVALID', 'items requires a collection');
        url.pathname = `${basePath}/workspaces/${workspace}/ogc/collections/${collection}/items`;
        const limit = enforceLimit(params.limit, options.maxLimit, options.defaultLimit);
        const query: Array<[string, string | number]> = [['limit', limit]];
        const offset = intOrUndefined('offset', params.offset, 0, Number.MAX_SAFE_INTEGER);
        if (offset !== undefined) query.push(['offset', offset]);
        if (params.bboxCrs84) {
          checkBboxCrs84(params.bboxCrs84);
          query.push(['bbox', params.bboxCrs84.join(',')]);
        }
        append(query);
        break;
      }
      case 'feature': {
        if (collection === '' || !params.featureId) throw new UrlBuildError('ROUTE_INVALID', 'feature requires a collection and featureId');
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(params.featureId)) {
          throw new UrlBuildError('PARAM_INVALID', `featureId must be a plain identifier (got "${params.featureId}")`);
        }
        url.pathname = `${basePath}/workspaces/${workspace}/ogc/collections/${collection}/items/${encodeURIComponent(params.featureId)}`;
        break;
      }
      default:
        throw new UrlBuildError('OP_UNKNOWN', `operation "${route.operation}" is not an ogc (Features) operation`);
    }
  } else if (route.service === 'ogc-tiles') {
    if (collection === '') throw new UrlBuildError('ROUTE_INVALID', 'ogc-tiles requires a collection');
    if (route.operation === 'tilejson') {
      url.pathname = `${basePath}/workspaces/${workspace}/ogc-tiles/collections/${collection}/tilejson.json`;
    } else if (route.operation === 'tile') {
      const tile = params.tile;
      if (!tile) throw new UrlBuildError('PARAM_MISSING', 'tile requires {z,y,x}');
      requireInt('z', tile.z, 0, 22);
      requireInt('y', tile.y, 0, 2 ** tile.z - 1);
      requireInt('x', tile.x, 0, 2 ** tile.z - 1);
      // MATRIX/ROW/COLUMN - z/y/x. This exact order is the contract; the control
      // tests assert it against independently computed Utah tiles.
      url.pathname = `${basePath}/workspaces/${workspace}/ogc-tiles/collections/${collection}/tiles/WebMercatorQuad/${tile.z}/${tile.y}/${tile.x}`;
    } else {
      throw new UrlBuildError('OP_UNKNOWN', `operation "${route.operation}" is not an ogc-tiles operation`);
    }
  } else if (route.service === 'wfs') {
    url.pathname = `${basePath}/workspaces/${workspace}/wfs`;
    if (route.operation === 'wfs-getcapabilities') {
      append([
        ['SERVICE', 'WFS'],
        ['VERSION', '2.0.0'],
        ['REQUEST', 'GetCapabilities'],
      ]);
    } else if (route.operation === 'wfs-getfeature') {
      if (collection === '') throw new UrlBuildError('ROUTE_INVALID', 'wfs-getfeature requires a TYPENAMES layer');
      const count = enforceLimit(params.limit, options.maxLimit, options.defaultLimit);
      append([
        ['SERVICE', 'WFS'],
        ['VERSION', '2.0.0'],
        ['REQUEST', 'GetFeature'],
        ['TYPENAMES', collection],
        ['COUNT', count],
        // Explicit GeoJSON, never content-negotiated ambiguity.
        ['OUTPUTFORMAT', 'application/json'],
      ]);
      const start = intOrUndefined('offset', params.offset, 0, Number.MAX_SAFE_INTEGER);
      if (start !== undefined) append([['STARTINDEX', start]]);
      if (params.bboxCrs84) {
        checkBboxCrs84(params.bboxCrs84);
        // CRS:84 is EPSG:4326 with EXPLICIT longitude,latitude axis order -
        // unambiguous, and it matches the lon,lat coordinate order of the
        // GeoJSON output we demand above. (urn:ogc:def:crs:EPSG::4326 in WFS
        // 2.0 is lat,lon - the axis-order trap the technical specification
        // flags. The capture harness must confirm the server honors CRS:84.)
        append([
          ['BBOX', params.bboxCrs84.join(',')],
          ['SRSNAME', 'CRS:84'],
        ]);
      }
    } else {
      throw new UrlBuildError('OP_UNKNOWN', `operation "${route.operation}" is not a WFS read operation (mutations are never built)`);
    }
  } else {
    // WMS
    url.pathname = `${basePath}/workspaces/${workspace}/wms`;
    if (route.operation === 'wms-getcapabilities') {
      append([
        ['SERVICE', 'WMS'],
        ['VERSION', '1.3.0'],
        ['REQUEST', 'GetCapabilities'],
      ]);
    } else if (route.operation === 'wms-getmap') {
      if (collection === '') throw new UrlBuildError('ROUTE_INVALID', 'wms-getmap requires LAYERS');
      if (!params.bbox3857) throw new UrlBuildError('PARAM_MISSING', 'wms-getmap requires bbox3857');
      checkBbox3857(params.bbox3857);
      const width = params.width ?? 256;
      const height = params.height ?? 256;
      requireInt('width', width, 1, 4096);
      requireInt('height', height, 1, 4096);
      append([
        ['SERVICE', 'WMS'],
        ['VERSION', '1.3.0'],
        ['REQUEST', 'GetMap'],
        ['LAYERS', collection],
        ['STYLES', ''],
        // EPSG:3857 (x,y) axis order - the reason we require projected bboxes.
        ['CRS', 'EPSG:3857'],
        ['BBOX', params.bbox3857.join(',')],
        ['WIDTH', width],
        ['HEIGHT', height],
        ['FORMAT', 'image/png'],
        ['TRANSPARENT', 'true'],
      ]);
    } else if (route.operation === 'wms-getfeatureinfo') {
      if (collection === '') throw new UrlBuildError('ROUTE_INVALID', 'wms-getfeatureinfo requires LAYERS');
      if (!params.bbox3857) throw new UrlBuildError('PARAM_MISSING', 'wms-getfeatureinfo requires bbox3857');
      checkBbox3857(params.bbox3857);
      const width = params.width ?? 256;
      const height = params.height ?? 256;
      requireInt('width', width, 1, 4096);
      requireInt('height', height, 1, 4096);
      // I/J are pixel positions INSIDE the requested raster: bound them by the
      // actual width/height, not a hardcoded raster maximum.
      const i = requireInt('i', params.i, 0, width - 1);
      const j = requireInt('j', params.j, 0, height - 1);
      append([
        ['SERVICE', 'WMS'],
        ['VERSION', '1.3.0'],
        ['REQUEST', 'GetFeatureInfo'],
        ['LAYERS', collection],
        ['QUERY_LAYERS', collection],
        ['STYLES', ''],
        ['CRS', 'EPSG:3857'],
        ['BBOX', params.bbox3857.join(',')],
        ['WIDTH', width],
        ['HEIGHT', height],
        ['I', i],
        ['J', j],
        ['INFO_FORMAT', 'application/json'],
      ]);
    } else {
      throw new UrlBuildError('OP_UNKNOWN', `operation "${route.operation}" is not a WMS read operation`);
    }
  }

  if (url.hash) throw new UrlBuildError('URL_INVALID', 'upstream url must not carry a fragment');
  return url;
}

/**
 * Final safety net before any fetch: the URL must be on the TRUSTED origin,
 * http(s), no userinfo, no traversal, and its path must sit under
 * /workspaces/ (never /api, /admin or /auth - the management surface).
 */
export function assertTrustedUpstream(url: URL, trustedBase: string): void {
  const base = new URL(trustedBase);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlBuildError('UPSTREAM_UNTRUSTED', `protocol ${url.protocol} is not http(s)`);
  if (url.origin !== base.origin) throw new UrlBuildError('UPSTREAM_UNTRUSTED', `upstream origin ${url.origin} is not the trusted ${base.origin}`);
  if (url.username || url.password) throw new UrlBuildError('UPSTREAM_UNTRUSTED', 'upstream URL carries userinfo');
  const path = url.pathname.replace(/\\/g, '/');
  if (path.includes('..')) throw new UrlBuildError('UPSTREAM_UNTRUSTED', 'upstream path carries traversal segments');
  if (!path.startsWith(`${base.pathname.replace(/\/+$/, '')}/workspaces/`)) {
    throw new UrlBuildError('UPSTREAM_UNTRUSTED', `upstream path "${path}" is outside the proxied /workspaces/ surface`);
  }
  const management = ['/api/', '/api/v1/', '/admin', '/auth/'].find((p) => path === p.slice(0, -1) || path.startsWith(p));
  if (management) throw new UrlBuildError('UPSTREAM_UNTRUSTED', `upstream path touches the NeoServer management surface (${management})`);
}
