/**
 * Route allowlist for the authorized spatial gateway (WD-005).
 *
 * Source of truth: docs/product/baseline/03-architecture.md, "Trust and
 * data publication boundaries" ("The gateway allowlists workspace, service,
 * layer and operation, resolves the permitted projection, enforces limits,
 * strips caller-supplied service credentials and forwards a narrowly scoped
 * service credential. It must not expose NeoServer administration or proxy
 * arbitrary URLs. Disable WFS mutations for portal routes...") and
 * docs/product/baseline/02-technical-specification.md, "NeoServer and map
 * transport" (example workspace paths, matrix z/y/x tile order, explicit
 * WFS GeoJSON output, EPSG:3857 WMS bbox).
 *
 * Design rules encoded here:
 * - The table is DATA. Deployments may pass their own frozen table to
 *   matchRoute/buildUpstreamUrl; nothing else in this package hardcodes a
 *   workspace name.
 * - Unknown workspace / service / collection / operation NEVER allows
 *   (deny-by-default; existence of a hidden layer is not disclosed).
 * - NeoServer administration and service-management endpoints
 *   (`/api/v1/**`, `/admin`, the management console) are ALWAYS denied,
 *   even if a route string accidentally matches. The gateway only ever
 *   builds URLs under `/workspaces/{workspace}/{service}`.
 * - WFS mutations (REQUEST=Transaction and the Insert/Update/Delete/
 *   Replace verbs of WFS 2.0 transactions) are ALWAYS denied for portal
 *   routes; dashboard writes go through the domain API (FR-010).
 * - The MVT source-layer id is deliberately NOT part of this table: it is
 *   extracted from the actual TileJSON at runtime (src/tilejson.ts) per
 *   "use advertised template and actual source-layer ID".
 */
import type { ObjectKind } from '../../../packages/policy/src/index.ts';

/** The four NeoServer spatial services the gateway will proxy. Anything else is not routable. */
export type ServiceKind = 'ogc' | 'ogc-tiles' | 'wfs' | 'wms';

/** Operations the gateway can perform. Service-management and mutations are structurally absent. */
export type GatewayOperation =
  // OGC API - Features (service `/workspaces/{ws}/ogc`)
  | 'landing'
  | 'conformance'
  | 'openapi'
  | 'collections'
  | 'collection'
  | 'items'
  | 'feature'
  // OGC API - Tiles (service `/workspaces/{ws}/ogc-tiles`)
  | 'tilejson'
  | 'tile'
  // WFS 2.0 (service `/workspaces/{ws}/wfs`) - read operations only
  | 'wfs-getcapabilities'
  | 'wfs-getfeature'
  // WMS 1.3.0 (service `/workspaces/{ws}/wms`)
  | 'wms-getcapabilities'
  | 'wms-getmap'
  | 'wms-getfeatureinfo';

/** Policy-object kind of a collection's guard object (must match the entitlement world). */
export type GuardObjectKind = Extract<ObjectKind, 'station' | 'dataset' | 'system'>;

/** Per-collection (per-layer for WMS) routing rules. */
export interface CollectionRoute {
  /** Operations callers may perform. Deny-by-default: absence of an operation denies it. */
  readonly operations: readonly GatewayOperation[];
  /**
   * Hard ceiling for `limit` (OGC API - Features) and `COUNT` (WFS GetFeature).
   * Mirrors the technical specification: "validate bbox and limits".
   */
  readonly maxLimit: number;
  /**
   * Guard object evaluated by @utah-water/policy before any upstream call.
   * Public workspaces must pass evaluatePublicRead (published public
   * projection); cohort workspaces must pass a restricted-field read on this
   * object. The guard is the whole published projection: a cohort layer is
   * valid only where every member may see every published field in it
   * (architecture: "Trust and data publication boundaries").
   */
  readonly guardObjectId: string;
  readonly guardObjectKind: GuardObjectKind;
}

export interface ServiceRoute {
  /**
   * Published collections keyed by NeoServer `public_id` (OGC services,
   * WFS TYPENAMES) or the WMS LAYERS name. Unknown key -> deny.
   */
  readonly collections: Readonly<Record<string, CollectionRoute>>;
}

export interface WorkspaceRoute {
  readonly workspace: string;
  /**
   * `public`: any caller (including anonymous) may read, subject to the
   * policy engine's public-read branch (projection currently published).
   * `cohort`: only authenticated principals with a live restricted-field
   * read on the guard object may read.
   */
  readonly audience: 'public' | 'cohort';
  /**
   * Secret REFERENCE for the narrow NeoServer credential of this workspace
   * (viewer-role stored API key). Never a secret value. Resolved through
   * the deployment's SecretResolver (src/gateway.ts).
   */
  readonly credentialRef: string;
  /** How the credential is presented upstream. NeoServer stored API keys use the X-API-Key header. */
  readonly credentialScheme: 'x-api-key' | 'bearer';
  readonly services: Readonly<Partial<Record<ServiceKind, ServiceRoute>>>;
}

/** The default route table: illustrative names matching the technical specification's example paths. */
export const GATEWAY_ROUTES: Readonly<Record<string, WorkspaceRoute>> = Object.freeze({
  'water-public': Object.freeze({
    workspace: 'water-public',
    audience: 'public',
    credentialRef: 'secretref://neoserver/workspaces/water-public',
    credentialScheme: 'x-api-key',
    services: Object.freeze({
      ogc: Object.freeze({
        collections: Object.freeze({
          stations: Object.freeze({
            operations: Object.freeze(['landing', 'conformance', 'openapi', 'collections', 'collection', 'items', 'feature']),
            maxLimit: 500,
            guardObjectId: 'sta-bear-corinne',
            guardObjectKind: 'station',
          }),
          // Draft projection awaiting publication: the layer exists upstream, but the
          // guard object is not currently published, so evaluatePublicRead denies.
          'stations-draft': Object.freeze({
            operations: Object.freeze(['items', 'feature']),
            maxLimit: 500,
            guardObjectId: 'sta-ogden-valley-proposed',
            guardObjectKind: 'station',
          }),
        }),
      }),
      'ogc-tiles': Object.freeze({
        collections: Object.freeze({
          stations: Object.freeze({
            operations: Object.freeze(['tilejson', 'tile']),
            maxLimit: 500,
            guardObjectId: 'sta-bear-corinne',
            guardObjectKind: 'station',
          }),
        }),
      }),
      wfs: Object.freeze({
        collections: Object.freeze({
          stations: Object.freeze({
            operations: Object.freeze(['wfs-getcapabilities', 'wfs-getfeature']),
            maxLimit: 500,
            guardObjectId: 'sta-bear-corinne',
            guardObjectKind: 'station',
          }),
        }),
      }),
      wms: Object.freeze({
        collections: Object.freeze({
          basins: Object.freeze({
            operations: Object.freeze(['wms-getcapabilities', 'wms-getmap', 'wms-getfeatureinfo']),
            maxLimit: 500,
            guardObjectId: 'sta-bear-corinne',
            guardObjectKind: 'station',
          }),
        }),
      }),
    }),
  }),
  // Cohort example: a Bear-River-owner projection. The server-held credential reads
  // only fields safe for EVERY member of the cohort; membership is checked per
  // request against the authoritative policy world (no entitlement caching).
  'water-bear-cohort': Object.freeze({
    workspace: 'water-bear-cohort',
    audience: 'cohort',
    credentialRef: 'secretref://neoserver/workspaces/water-bear-cohort',
    credentialScheme: 'x-api-key',
    services: Object.freeze({
      ogc: Object.freeze({
        collections: Object.freeze({
          'stations-restricted': Object.freeze({
            operations: Object.freeze(['items', 'feature']),
            maxLimit: 200,
            guardObjectId: 'sta-hyrum-diversion-owner',
            guardObjectKind: 'station',
          }),
        }),
      }),
      'ogc-tiles': Object.freeze({
        collections: Object.freeze({
          'stations-restricted': Object.freeze({
            operations: Object.freeze(['tilejson', 'tile']),
            maxLimit: 200,
            guardObjectId: 'sta-hyrum-diversion-owner',
            guardObjectKind: 'station',
          }),
        }),
      }),
    }),
  }),
});

/**
 * NeoServer administration / service-management surface. These path prefixes
 * are ALWAYS denied regardless of the route table: the console, the
 * management API (workspaces, services, apikeys, roles, tile-cache jobs) and
 * auth endpoints are not proxyable through the portal gateway.
 */
export const FORBIDDEN_UPSTREAM_PATH_PREFIXES: readonly string[] = Object.freeze(['/api/', '/api/v1/', '/admin', '/auth/']);

/** WFS REQUEST values that mutate source data (WFS 2.0 transactions). Always denied. */
export const WFS_MUTATION_REQUESTS: ReadonlySet<string> = new Set([
  'transaction',
  'insert',
  'update',
  'replace',
  'delete',
]);

/** True when a gateway/upstream path touches the forbidden management surface or tries traversal. */
export function isForbiddenUpstreamPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return true;
  const normalized = path.replace(/\\/g, '/');
  if (normalized.includes('..')) return true;
  return FORBIDDEN_UPSTREAM_PATH_PREFIXES.some((p) => normalized === p.slice(0, -1) || normalized.startsWith(p));
}

/** Machine-readable denial reasons for route matching (stable for tests and logs). */
export type RouteDenialReason =
  | 'method-not-allowed'
  | 'admin-path'
  | 'malformed-path'
  | 'unknown-workspace'
  | 'unknown-service'
  | 'unknown-collection'
  | 'operation-not-allowed'
  | 'invalid-tile-coordinates'
  | 'wfs-mutation-denied';

/** A successfully matched, allowlisted route. */
export interface RouteMatch {
  /** Discriminator for the RouteMatch | RouteDenial union (mirrors RouteDenial.ok). */
  readonly ok: true;
  readonly workspace: string;
  readonly service: ServiceKind;
  readonly operation: GatewayOperation;
  readonly audience: 'public' | 'cohort';
  readonly credentialRef: string;
  readonly credentialScheme: 'x-api-key' | 'bearer';
  readonly maxLimit: number;
  readonly guardObjectId: string;
  readonly guardObjectKind: GuardObjectKind;
  /** Collection/public_id for collection-scoped operations; absent for service-level ones. */
  readonly collection?: string;
  /** Tile requests only: validated integer matrix coordinates in z/y/x (matrix/row/column) order. */
  readonly tile?: Readonly<{ z: number; y: number; x: number }>;
  /** Single-feature requests only. */
  readonly featureId?: string;
}

export interface RouteDenial {
  readonly ok: false;
  readonly reason: RouteDenialReason;
  readonly detail: string;
}

const SERVICES: readonly ServiceKind[] = ['ogc', 'ogc-tiles', 'wfs', 'wms'];

/** Path-segment tokenizer: lowercases nothing (ids are case-sensitive), decodes nothing (no %2f games). */
function segments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

function isInt(s: string | undefined): s is string {
  return typeof s === 'string' && /^(0|[1-9][0-9]*)$/.test(s);
}

/**
 * Match a gateway request path (already stripped of any deployment prefix)
 * against the route table. Pure: table + path -> decision.
 *
 * Tile paths MUST arrive in matrix/row/column (z/y/x) order; a swapped
 * x/y path either fails the matrix-bounds check (detected here) or produces
 * a DIFFERENT url (detected by the Utah control-point tests in test/url.test.ts).
 */
export function matchRoute(
  path: string,
  table: Readonly<Record<string, WorkspaceRoute>> = GATEWAY_ROUTES,
): RouteMatch | RouteDenial {
  if (typeof path !== 'string' || !path.startsWith('/')) return { ok: false, reason: 'malformed-path', detail: 'gateway path must be absolute' };
  if (isForbiddenUpstreamPath(path)) return { ok: false, reason: 'admin-path', detail: 'NeoServer administration/management paths are never proxied' };

  const seg = segments(path);
  // /workspaces/{ws}/{service}/...
  if (seg.length < 3 || seg[0] !== 'workspaces') return { ok: false, reason: 'malformed-path', detail: 'expected /workspaces/{workspace}/{service}/...' };

  const workspaceRoute = table[seg[1]];
  if (!workspaceRoute) return { ok: false, reason: 'unknown-workspace', detail: `workspace "${seg[1]}" is not allowlisted` };

  const service = seg[2] as ServiceKind;
  if (!SERVICES.includes(service)) return { ok: false, reason: 'unknown-service', detail: `service "${seg[2]}" is not one of ogc|ogc-tiles|wfs|wms` };

  const serviceRoute = workspaceRoute.services[service];
  if (!serviceRoute) return { ok: false, reason: 'unknown-service', detail: `service "${service}" is not published in workspace "${workspaceRoute.workspace}"` };

  const rest = seg.slice(3);

  // --- OGC API - Features --------------------------------------------------
  if (service === 'ogc') {
    if (rest.length === 0) return match(workspaceRoute, serviceRoute, service, '', 'landing');
    if (rest[0] === 'conformance' && rest.length === 1) return match(workspaceRoute, serviceRoute, service, '', 'conformance');
    if (rest[0] === 'api' && rest.length === 1) return match(workspaceRoute, serviceRoute, service, '', 'openapi');
    if (rest[0] === 'collections' && rest.length === 1) return match(workspaceRoute, serviceRoute, service, '', 'collections');
    if (rest[0] === 'collections' && rest.length === 2) return match(workspaceRoute, serviceRoute, service, rest[1], 'collection');
    if (rest[0] === 'collections' && rest[2] === 'items' && rest.length === 3) return match(workspaceRoute, serviceRoute, service, rest[1], 'items');
    if (rest[0] === 'collections' && rest[2] === 'items' && rest.length === 4 && rest[3].length > 0) {
      return match(workspaceRoute, serviceRoute, service, rest[1], 'feature', { featureId: rest[3] });
    }
    return { ok: false, reason: 'malformed-path', detail: 'unrecognized ogc (Features) path shape' };
  }

  // --- OGC API - Tiles -------------------------------------------------------
  if (service === 'ogc-tiles') {
    if (rest[0] === 'collections' && rest[2] === 'tilejson.json' && rest.length === 3) {
      return match(workspaceRoute, serviceRoute, service, rest[1], 'tilejson');
    }
    // /collections/{id}/tiles/{tileMatrixSet}/{z}/{y}/{x} - matrix/row/column order, no format suffix.
    if (rest[0] === 'collections' && rest[2] === 'tiles' && rest.length === 7) {
      const [, , , tileMatrixSet, z, y, x] = rest;
      if (tileMatrixSet !== 'WebMercatorQuad') {
        return { ok: false, reason: 'malformed-path', detail: `unsupported tile matrix set "${tileMatrixSet}" (only WebMercatorQuad is routed)` };
      }
      if (rest.slice(4).some((s) => s.includes('.'))) {
        return { ok: false, reason: 'malformed-path', detail: 'tile path must not carry a guessed format suffix (no .pbf)' };
      }
      if (![z, y, x].every(isInt)) return { ok: false, reason: 'invalid-tile-coordinates', detail: 'z/y/x must be non-negative integers' };
      const zi = Number(z), yi = Number(y), xi = Number(x);
      if (zi > 22) return { ok: false, reason: 'invalid-tile-coordinates', detail: 'zoom above 22 is rejected' };
      const span = 2 ** zi;
      if (yi >= span || xi >= span) {
        return {
          ok: false,
          reason: 'invalid-tile-coordinates',
          detail: `row/column out of matrix bounds for z=${zi} (got y=${yi}, x=${xi}; a swapped x/y submission lands here when one exceeds 2^z-1)`,
        };
      }
      return match(workspaceRoute, serviceRoute, service, rest[1], 'tile', { tile: { z: zi, y: yi, x: xi } });
    }
    return { ok: false, reason: 'malformed-path', detail: 'unrecognized ogc-tiles path shape' };
  }

  // --- WFS / WMS (KVP at the service root) ----------------------------------
  if (rest.length !== 0) return { ok: false, reason: 'malformed-path', detail: `${service} is addressed at the service root with KVP query parameters` };
  // Path-level placeholder: the actual operation (GetCapabilities/GetFeature/
  // GetMap/...) is selected by the KVP REQUEST parameter and re-validated
  // against the per-collection allowlist through resolveWxsOperation +
  // matchOperation. This match proves the workspace/service pair is routable.
  const first = service === 'wfs' ? 'wfs-getcapabilities' : 'wms-getcapabilities';
  return match(workspaceRoute, serviceRoute, service, '', first);
}

/** KVP request names that are WFS 2.0 transactions in whole or in part. */
export interface WxsOperationResolution {
  readonly ok: true;
  readonly operation: GatewayOperation;
  /** TYPENAMES (WFS GetFeature) or LAYERS (WMS): the collection/layer KVP key. */
  readonly collection?: string;
}

/**
 * Resolve the actual WFS/WMS operation from KVP query parameters.
 *
 * The gateway REQUIRES an explicit REQUEST parameter (no guessing) and an
 * explicit TYPENAMES/LAYERS for collection-scoped operations. Any WFS
 * transaction verb (or a mutation verb smuggled into a read operation's
 * query) yields `wfs-mutation-denied` before any upstream call is built.
 */
export function resolveWxsOperation(
  service: 'wfs' | 'wms',
  query: { get(name: string): string | null },
): WxsOperationResolution | RouteDenial {
  const request = query.get('REQUEST') ?? query.get('request');
  if (request === null || request === '') {
    return { ok: false, reason: 'malformed-path', detail: `${service.toUpperCase()} KVP requests must carry an explicit REQUEST parameter` };
  }
  const verb = request.trim();

  if (isWfsMutationRequest(verb) || [...WFS_MUTATION_REQUESTS].some((m) => verb.toLowerCase().includes(m) && service === 'wfs')) {
    return {
      ok: false,
      reason: 'wfs-mutation-denied',
      detail: `WFS REQUEST="${verb}" is a transaction/mutation; dashboard writes go through the domain API (FR-010)`,
    };
  }

  if (service === 'wfs') {
    if (verb === 'GetCapabilities') return { ok: true, operation: 'wfs-getcapabilities' };
    if (verb === 'GetFeature' || verb === 'GetFeatureWithLock') {
      const typenames = query.get('TYPENAMES') ?? query.get('typenames') ?? query.get('TYPENAME') ?? query.get('typename');
      if (!typenames) return { ok: false, reason: 'malformed-path', detail: 'GetFeature requires an explicit TYPENAMES layer' };
      if (verb === 'GetFeatureWithLock') {
        return { ok: false, reason: 'wfs-mutation-denied', detail: 'GetFeatureWithLock locks features for mutation; not a read-only portal operation' };
      }
      return { ok: true, operation: 'wfs-getfeature', collection: typenames };
    }
    if (verb === 'DescribeFeatureType' || verb === 'GetPropertyValue' || verb === 'ListStoredQueries' || verb === 'DescribeStoredQueries') {
      return { ok: false, reason: 'operation-not-allowed', detail: `WFS REQUEST="${verb}" is not routed by the portal gateway` };
    }
    return { ok: false, reason: 'operation-not-allowed', detail: `unknown WFS REQUEST "${verb}"` };
  }

  // WMS 1.3.0
  if (verb === 'GetCapabilities') return { ok: true, operation: 'wms-getcapabilities' };
  if (verb === 'GetMap' || verb === 'GetFeatureInfo') {
    const layers = query.get('LAYERS') ?? query.get('layers');
    if (!layers) return { ok: false, reason: 'malformed-path', detail: `${verb} requires an explicit LAYERS name` };
    return { ok: true, operation: verb === 'GetMap' ? 'wms-getmap' : 'wms-getfeatureinfo', collection: layers };
  }
  if (verb === 'GetLegendGraphic' || verb === 'DescribeLayer') {
    return { ok: false, reason: 'operation-not-allowed', detail: `WMS REQUEST="${verb}" is not routed by the portal gateway` };
  }
  return { ok: false, reason: 'operation-not-allowed', detail: `unknown WMS REQUEST "${verb}"` };
}

/**
 * Re-validate a (workspace, service, collection, operation) tuple against the
 * route table. Used by the gateway to check the operation/collection pair a
 * WXS KVP request actually selects, after matchRoute proved the path shape.
 */
export function matchOperation(
  table: Readonly<Record<string, WorkspaceRoute>>,
  workspace: string,
  service: ServiceKind,
  collection: string,
  operation: GatewayOperation,
  extra?: { tile?: { z: number; y: number; x: number }; featureId?: string },
): RouteMatch | RouteDenial {
  const workspaceRoute = table[workspace];
  if (!workspaceRoute) return { ok: false, reason: 'unknown-workspace', detail: `workspace "${workspace}" is not allowlisted` };
  const serviceRoute = workspaceRoute.services[service];
  if (!serviceRoute) return { ok: false, reason: 'unknown-service', detail: `service "${service}" is not published in workspace "${workspace}"` };
  return match(workspaceRoute, serviceRoute, service, collection, operation, extra);
}

function match(
  workspaceRoute: WorkspaceRoute,
  serviceRoute: ServiceRoute,
  service: ServiceKind,
  collection: string,
  operation: GatewayOperation,
  extra?: { tile?: { z: number; y: number; x: number }; featureId?: string },
): RouteMatch | RouteDenial {
  // Service-level operations (landing/conformance/openapi/collections and the
  // capabilities documents) are guarded by the FIRST allowlisted collection's
  // guard object (the projection the workspace as a whole publishes). The
  // collection-scoped operations below are guarded by their own entry.
  const entry = collection === '' ? firstEntry(serviceRoute) : serviceRoute.collections[collection];
  if (!entry) {
    return { ok: false, reason: 'unknown-collection', detail: `layer "${collection}" is not allowlisted in this workspace/service` };
  }
  if (!entry.operations.includes(operation)) {
    return { ok: false, reason: 'operation-not-allowed', detail: `operation "${operation}" is not allowlisted for layer "${collection}"` };
  }
  const matched: RouteMatch = {
    ok: true,
    workspace: workspaceRoute.workspace,
    audience: workspaceRoute.audience,
    credentialRef: workspaceRoute.credentialRef,
    credentialScheme: workspaceRoute.credentialScheme,
    maxLimit: entry.maxLimit,
    guardObjectId: entry.guardObjectId,
    guardObjectKind: entry.guardObjectKind,
    service,
    operation,
    // collection stays absent for service-level operations; the url builder
    // only needs it for collection-scoped ones.
    ...(collection === '' ? {} : { collection }),
    ...extra,
  };
  return matched;
}

function firstEntry(serviceRoute: ServiceRoute): CollectionRoute | undefined {
  const key = Object.keys(serviceRoute.collections)[0];
  return key === undefined ? undefined : serviceRoute.collections[key];
}

/**
 * WFS REQUEST-parameter guard used on top of the operation allowlist: a
 * GetFeature-only table entry already denies REQUEST=Transaction (unknown
 * operation), and this predicate makes the mutation class explicit for
 * logging and for KVP values smuggled into otherwise-read operations.
 */
export function isWfsMutationRequest(requestValue: string | undefined): boolean {
  return typeof requestValue === 'string' && WFS_MUTATION_REQUESTS.has(requestValue.trim().toLowerCase());
}
