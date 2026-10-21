/**
 * Authorized same-origin spatial gateway pipeline (WD-005).
 *
 * Source of truth:
 * - docs/product/baseline/03-architecture.md, "Trust and data publication
 *   boundaries": "The gateway allowlists workspace, service, layer and
 *   operation, resolves the permitted projection, enforces limits, strips
 *   caller-supplied service credentials and forwards a narrowly scoped
 *   service credential. It must not expose NeoServer administration or
 *   proxy arbitrary URLs. Disable WFS mutations for portal routes."
 * - Same document's gateway sequence diagram: allowlisted request + scoped
 *   read credential upstream; allowlisted same-origin tile templates and
 *   authorized spatial responses downstream.
 * - docs/product/baseline/02-technical-specification.md, "NeoServer and map
 *   transport": "Sensitive responses must never use a public CDN cache;
 *   public tiles are revisioned separately."
 * - WD-004 (packages/policy): evaluatePublicRead is the public-projection
 *   branch; evaluate is the protected branch used for cohort workspaces.
 *
 * The pipeline, in the exact order every request passes through:
 *
 *   1. method gate          GET/HEAD only (mutations are structurally absent;
 *                           WFS Transaction is additionally denied in step 4)
 *   2. route allowlist      matchRoute (path) + resolveWxsOperation (KVP) +
 *                           matchOperation (table re-check). Unknown anything
 *                           -> deny; admin paths -> deny.
 *   3. policy gate          audience public -> evaluatePublicRead (the
 *                           published-projection branch, principal may be
 *                           null); audience cohort -> evaluate with the
 *                           session principal over the guard object
 *                           (view-restricted-details). No entitlement cache:
 *                           the world snapshot is loaded per request.
 *   4. URL build            buildUpstreamUrl from TYPED parameters only, then
 *                           assertTrustedUpstream (same trusted origin, no
 *                           userinfo, /workspaces/ surface only).
 *   5. fetch                timeout-bounded, with the NARROW service
 *                           credential resolved from the route's
 *                           secret-reference. Caller headers never reach the
 *                           upstream: the handler receives only
 *                           method/path/query/session, so caller-supplied
 *                           service credentials cannot be echoed even by
 *                           accident (credential isolation).
 *   6. response caps        content-type allowlist + hard size cap, enforced
 *                           while the body streams (bounded read).
 *   7. TileJSON rewrite     tilejson responses are resolved against the
 *                           trusted service base and re-mapped to same-origin
 *                           gateway templates (src/tilejson.ts).
 *   8. cache policy         revisioned public artifacts (tiles/TileJSON on the
 *                           public branch) are cacheable; EVERYTHING else is
 *                           `private, no-store` (cohort content and
 *                           non-revisioned features/json must never sit in a
 *                           shared cache).
 *
 * Transport-agnostic: handleGatewayRequest takes a plain GatewayRequest and
 * returns a plain GatewayResponse. README.md documents the later Fastify
 * wiring; no HTTP framework dependency exists in this package.
 */
import {
  evaluate,
  evaluatePublicRead,
  type Decision,
  type PolicyWorld,
  type Principal,
} from '../../../packages/policy/src/index.ts';
import {
  GATEWAY_ROUTES,
  matchOperation,
  matchRoute,
  resolveWxsOperation,
  type GatewayOperation,
  type RouteDenialReason,
  type RouteMatch,
  type WorkspaceRoute,
} from './allowlist.ts';
import {
  assertTrustedUpstream,
  buildUpstreamUrl,
  UrlBuildError,
  type UpstreamParams,
} from './url.ts';
import { resolveTileJson, TileJsonError, type ParsedTileTemplate } from './tilejson.ts';

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/** Resolves a secret REFERENCE (never a value in code) to its value. */
export type SecretResolver = (reference: string) => string | undefined;

/**
 * Caller-side identity only. Deliberately carries NO headers: caller-supplied
 * Authorization/X-API-Key values are structurally invisible to this pipeline
 * and can never be forwarded upstream.
 */
export interface GatewaySession {
  readonly principal: Principal | null;
}

export interface GatewayRequest {
  readonly method: string;
  /** Gateway path with any deployment prefix already stripped, e.g. `/workspaces/water-public/ogc-tiles/...`. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly session?: GatewaySession | null;
}

export interface GatewayResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Text (JSON/XML rewrites) or bytes (tiles/images). Bounded by maxResponseBytes. */
  readonly body: string | Uint8Array;
  /** Audit trail: the policy decision that authorized (or the code that denied) this response. */
  readonly denial?: { readonly code: GatewayErrorCode; readonly detail: string };
  readonly decision?: Decision;
  readonly route?: RouteMatch;
}

export type GatewayErrorCode =
  | 'METHOD_NOT_ALLOWED'
  | 'ROUTE_DENIED'
  | 'POLICY_DENIED_ANONYMOUS'
  | 'POLICY_DENIED_HIDDEN'
  | 'POLICY_DENIED_FORBIDDEN'
  | 'PARAM_INVALID'
  | 'SECRET_UNRESOLVED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'RESPONSE_TOO_LARGE'
  | 'RESPONSE_CONTENT_TYPE'
  | 'TILEJSON_RESOLUTION_FAILED';

export class GatewayError extends Error {
  readonly status: number;
  readonly code: GatewayErrorCode;
  constructor(status: number, code: GatewayErrorCode, detail: string) {
    super(`[${code}] ${detail}`);
    this.status = status;
    this.code = code;
    this.name = 'GatewayError';
  }
}

export interface GatewayConfig {
  /** Trusted NeoServer service base, from deployment config/secrets. Never caller-supplied. */
  readonly trustedBase: string;
  /** Same-origin origin the gateway is published on (for TileJSON re-mapping). */
  readonly gatewayOrigin: string;
  /** Mount prefix of the gateway (TileJSON re-mapping), e.g. `/geo`. Default ''. */
  readonly gatewayPrefix?: string;
  /** Loads the AUTHORITATIVE policy world per request (no entitlement caching). */
  readonly worldLoader: () => PolicyWorld;
  /** Secret-reference resolver: secretref://... -> narrow service credential value. */
  readonly resolveSecret: SecretResolver;
  /** Route table override; defaults to GATEWAY_ROUTES (src/allowlist.ts). */
  readonly routes?: Readonly<Record<string, WorkspaceRoute>>;
  /** Injected fetch (tests supply a recorder); default global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injected clock for the policy engine; default real time. */
  readonly now?: () => Date;
  /** Upstream timeout. Default 10s. */
  readonly timeoutMs?: number;
  /** Hard cap on upstream response bodies. Default 8 MiB. */
  readonly maxResponseBytes?: number;
  /** max-age for cacheable public artifacts. Default 300s (until revision-stamped URLs land via the outbox, ADR-10). */
  readonly publicCacheSeconds?: number;
}

// ---------------------------------------------------------------------------
// Content-type allowlist (step 6)
// ---------------------------------------------------------------------------

/**
 * Upstream content types this gateway will pass through. Anything else (HTML
 * error pages, redirects to admin UIs, ...) is refused rather than proxied.
 */
const ALLOWED_CONTENT_TYPE_PREFIXES: readonly string[] = Object.freeze([
  'application/json',
  'application/geo+json',
  'application/vnd.oai.openapi', // +json / +yaml variants
  'application/xml',
  'text/xml',
  'text/plain', // OGC exception reports sometimes use this; body is still capped
  'application/vnd.mapbox-vector-tile',
  'image/png',
  'image/jpeg',
]);

function contentTypeAllowed(contentType: string | null): boolean {
  if (!contentType) return false;
  const bare = contentType.split(';')[0].trim().toLowerCase();
  return ALLOWED_CONTENT_TYPE_PREFIXES.some((p) => bare === p || bare.startsWith(`${p}+`));
}

// ---------------------------------------------------------------------------
// Cache policy (step 8)
// ---------------------------------------------------------------------------

/**
 * Pure cache-policy decision (T-08 "Cache and privacy").
 *
 * Cacheable (`public, max-age=N`): only successful responses whose route is
 * `public`-audience, whose policy decision traveled the public-read branch,
 * and whose artifact class is revisioned (MVT tiles and the TileJSON that
 * advertises them - the spec: "public tiles are revisioned separately").
 *
 * Everything else - cohort content, features/WFS/WMS JSON, error responses -
 * is `private, no-store`: sensitive responses must never use a shared cache,
 * and non-revisioned JSON changes with each publication cycle
 * ("publication pending" until the projection catches up).
 */
export function cachePolicyFor(
  route: RouteMatch,
  decision: Decision | undefined,
  status: number,
  publicCacheSeconds: number,
): string {
  if (
    status === 200 &&
    route.audience === 'public' &&
    decision !== undefined &&
    decision.effect === 'allow' &&
    decision.via === 'public-read' &&
    (route.operation === 'tile' || route.operation === 'tilejson')
  ) {
    return `public, max-age=${publicCacheSeconds}, must-revalidate`;
  }
  return 'private, no-store';
}

// ---------------------------------------------------------------------------
// Typed query parameter extraction (step 4 inputs)
// ---------------------------------------------------------------------------

function intParam(query: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const raw = query.get(name);
  if (raw === null || raw === '') return undefined;
  if (!/^-?[0-9]+$/.test(raw)) throw new GatewayError(400, 'PARAM_INVALID', `query parameter "${name}" must be an integer (got "${raw}")`);
  const value = Number(raw);
  if (value < min || value > max) throw new GatewayError(400, 'PARAM_INVALID', `query parameter "${name}" out of [${min}, ${max}] (got "${raw}")`);
  return value;
}

function numberParam(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new GatewayError(400, 'PARAM_INVALID', `query parameter "${name}" must be a finite number (got "${raw}")`);
  return value;
}

function bboxParam(query: URLSearchParams, name: string): [number, number, number, number] | undefined {
  const raw = query.get(name);
  if (raw === null || raw === '') return undefined;
  const parts = raw.split(',');
  if (parts.length !== 4) throw new GatewayError(400, 'PARAM_INVALID', `query parameter "${name}" must be 4 comma-separated numbers`);
  const values = parts.map(Number);
  if (!values.every(Number.isFinite)) throw new GatewayError(400, 'PARAM_INVALID', `query parameter "${name}" carries a non-finite value`);
  return values as [number, number, number, number];
}

/** Extract the typed, allowlistable parameters for a matched route. Anything else in the query is DROPPED. */
function typedParamsFor(route: RouteMatch, query: URLSearchParams): UpstreamParams {
  const params: {
    tile?: { z: number; y: number; x: number };
    featureId?: string;
    limit?: number;
    offset?: number;
    bboxCrs84?: [number, number, number, number];
    bbox3857?: [number, number, number, number];
    width?: number;
    height?: number;
    i?: number;
    j?: number;
  } = {};

  if (route.tile) params.tile = route.tile;
  if (route.featureId !== undefined) params.featureId = route.featureId;

  if (route.operation === 'items' || route.operation === 'wfs-getfeature') {
    params.limit = intParam(query, 'limit', 1, Number.MAX_SAFE_INTEGER);
    params.offset = intParam(query, 'offset', 0, Number.MAX_SAFE_INTEGER);
    params.bboxCrs84 = bboxParam(query, 'bbox');
  }
  if (route.operation === 'wms-getmap' || route.operation === 'wms-getfeatureinfo') {
    params.bbox3857 = bboxParam(query, 'bbox3857');
    params.width = intParam(query, 'width', 1, 4096);
    params.height = intParam(query, 'height', 1, 4096);
  }
  if (route.operation === 'wms-getfeatureinfo') {
    params.i = intParam(query, 'i', 0, 4095);
    params.j = intParam(query, 'j', 0, 4095);
  }
  return params;
}

// ---------------------------------------------------------------------------
// Status mapping (fixed, tested)
// ---------------------------------------------------------------------------

/** Route denials -> HTTP. Unknown identifiers 404 (no existence disclosure); capability issues 403; shape issues 400. */
function statusForRouteDenial(reason: RouteDenialReason): { status: number; code: GatewayErrorCode } {
  switch (reason) {
    case 'unknown-workspace':
    case 'unknown-service':
    case 'unknown-collection':
      return { status: 404, code: 'ROUTE_DENIED' };
    case 'admin-path':
    case 'operation-not-allowed':
    case 'wfs-mutation-denied':
      return { status: 403, code: 'ROUTE_DENIED' };
    case 'malformed-path':
    case 'invalid-tile-coordinates':
      return { status: 400, code: 'ROUTE_DENIED' };
    case 'method-not-allowed':
      return { status: 405, code: 'METHOD_NOT_ALLOWED' };
  }
}

/** Policy denials -> HTTP, mirroring services/api/src/auth status policy. */
function statusForPolicyDenial(decision: Decision): { status: number; code: GatewayErrorCode } {
  switch (decision.reason) {
    case 'DENY_ANONYMOUS':
    case 'DENY_UNKNOWN_PRINCIPAL':
    case 'DENY_PRINCIPAL_INACTIVE':
      return { status: 401, code: 'POLICY_DENIED_ANONYMOUS' };
    // Unpublished/unknown objects: 404 so callers cannot use the gateway to
    // discover that a hidden layer exists.
    case 'DENY_UNKNOWN_OBJECT':
    case 'DENY_OBJECT_UNPUBLISHED':
    case 'DENY_FIELDS_NOT_PUBLIC':
    case 'DENY_OUT_OF_SCOPE':
      return { status: 404, code: 'POLICY_DENIED_HIDDEN' };
    default:
      return { status: 403, code: 'POLICY_DENIED_FORBIDDEN' };
  }
}

// ---------------------------------------------------------------------------
// Policy gate (step 3)
// ---------------------------------------------------------------------------

/**
 * The policy check between the allowlist and the URL build.
 *
 * - public workspaces: evaluatePublicRead over the guard object with
 *   action `browse-published` and the public field projection. Anonymous
 *   callers can pass - that is the point of the public branch.
 * - cohort workspaces: evaluate with the SESSION principal over the guard
 *   object, action `view-restricted-details`, fields public+restricted. The
 *   server-held workspace credential may only read a projection safe for
 *   EVERY member of the cohort (architecture: shared server-held
 *   credentials), so the guard object is the whole projection and each
 *   member's entitlement is rechecked per request (no entitlement cache).
 */
export function authorizeRoute(
  route: RouteMatch,
  session: GatewaySession | null | undefined,
  world: PolicyWorld,
  now: Date,
): Decision {
  if (route.audience === 'public') {
    return evaluatePublicRead(
      { principal: null, action: 'browse-published', object: { kind: route.guardObjectKind, id: route.guardObjectId } },
      world,
      now,
    );
  }
  return evaluate(
    {
      principal: session?.principal ?? null,
      action: 'view-restricted-details',
      object: { kind: route.guardObjectKind, id: route.guardObjectId, fields: ['public', 'restricted'] },
    },
    world,
    now,
  );
}

// ---------------------------------------------------------------------------
// Credential resolution (step 5)
// ---------------------------------------------------------------------------

/** Headers sent upstream: ONLY the resolved narrow credential plus a fixed Accept. Caller headers never appear here. */
function upstreamHeaders(route: RouteMatch, credential: string): Headers {
  const headers = new Headers({ Accept: 'application/json, application/geo+json, application/xml, image/png, application/vnd.mapbox-vector-tile' });
  if (route.credentialScheme === 'bearer') headers.set('Authorization', `Bearer ${credential}`);
  else headers.set('X-API-Key', credential);
  return headers;
}

// ---------------------------------------------------------------------------
// Bounded body read (step 6)
// ---------------------------------------------------------------------------

/** Reads a (possibly streaming) body while enforcing the hard byte cap. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, contentLength: number | null, maxBytes: number): Promise<Uint8Array> {
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new GatewayError(502, 'RESPONSE_TOO_LARGE', `upstream declares ${declared} bytes; gateway cap is ${maxBytes}`);
    }
  }
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new GatewayError(502, 'RESPONSE_TOO_LARGE', `upstream body exceeded the ${maxBytes}-byte cap mid-stream`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Handle one gateway request end to end. Never throws: every failure is a
 * GatewayResponse (denial or upstream failure) with a machine-readable code.
 */
export async function handleGatewayRequest(request: GatewayRequest, config: GatewayConfig): Promise<GatewayResponse> {
  const routes = config.routes ?? GATEWAY_ROUTES;
  const now = config.now ? config.now() : new Date();
  const maxBytes = config.maxResponseBytes ?? 8 * 1024 * 1024;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const publicCacheSeconds = config.publicCacheSeconds ?? 300;

  const denyResponse = (status: number, code: GatewayErrorCode, detail: string, extra?: { decision?: Decision }): GatewayResponse => ({
    status,
    headers: Object.freeze({ 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json' }),
    body: JSON.stringify({ error: code, detail }),
    denial: { code, detail },
    ...extra,
  });

  try {
    // 1. Method gate: the portal gateway is read-only by construction.
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return denyResponse(405, 'METHOD_NOT_ALLOWED', `method ${method} is not routable; the spatial gateway is read-only (writes go through the domain API, FR-010)`);
    }

    // 2. Route allowlist.
    const pathMatch = matchRoute(request.path, routes);
    if (!pathMatch.ok) {
      const { status, code } = statusForRouteDenial(pathMatch.reason);
      return denyResponse(status, code, `${pathMatch.reason}: ${pathMatch.detail}`);
    }
    let route: RouteMatch = pathMatch;

    // 2b. WFS/WMS: the KVP REQUEST selects the real operation/collection.
    if (route.service === 'wfs' || route.service === 'wms') {
      const resolved = resolveWxsOperation(route.service, request.query);
      if (!resolved.ok) {
        const { status, code } = statusForRouteDenial(resolved.reason);
        return denyResponse(status, code, `${resolved.reason}: ${resolved.detail}`);
      }
      const rematched = matchOperation(routes, route.workspace, route.service, resolved.collection ?? '', resolved.operation);
      if (!rematched.ok) {
        const { status, code } = statusForRouteDenial(rematched.reason);
        return denyResponse(status, code, `${rematched.reason}: ${rematched.detail}`);
      }
      route = rematched;
    }

    // 3. Policy gate (fresh world per request; no entitlement caching).
    const world = config.worldLoader();
    const decision = authorizeRoute(route, request.session, world, now);
    if (decision.effect !== 'allow') {
      const { status, code } = statusForPolicyDenial(decision);
      return denyResponse(status, code, `${decision.reason}${decision.detail ? `: ${decision.detail}` : ''}`, { decision });
    }

    // 4. URL build from typed params only + trust assertion.
    const params = typedParamsFor(route, request.query);
    const upstreamUrl = buildUpstreamUrl(
      config.trustedBase,
      { workspace: route.workspace, service: route.service, collection: route.collection, operation: route.operation as string },
      params,
      { maxLimit: route.maxLimit },
    );
    assertTrustedUpstream(upstreamUrl, config.trustedBase);

    // 5. Credential resolution + fetch. Fail CLOSED if the secret reference
    //    does not resolve: no anonymous fallthrough upstream.
    const credential = config.resolveSecret(route.credentialRef);
    if (credential === undefined || credential.length === 0) {
      return denyResponse(503, 'SECRET_UNRESOLVED', `service credential reference "${route.credentialRef}" did not resolve; refusing to call upstream unauthenticated`);
    }
    const doFetch = config.fetchImpl ?? fetch;
    let upstream: Response;
    try {
      upstream = await doFetch(upstreamUrl, {
        method: 'GET',
        headers: upstreamHeaders(route, credential),
        redirect: 'error', // redirects to admin consoles/logins are errors, not followings
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return denyResponse(504, 'UPSTREAM_TIMEOUT', `upstream did not answer within ${timeoutMs}ms: ${(err as Error).message}`);
      }
      return denyResponse(502, 'UPSTREAM_UNAVAILABLE', `upstream fetch failed: ${(err as Error).message}`);
    }

    if (!upstream.ok) {
      // Surface status/NOT the upstream body (may embed internal detail).
      return denyResponse(502, 'UPSTREAM_UNAVAILABLE', `upstream answered ${upstream.status} for the allowlisted route`);
    }

    // 6. Response caps.
    const contentType = upstream.headers.get('content-type');
    if (!contentTypeAllowed(contentType)) {
      return denyResponse(502, 'RESPONSE_CONTENT_TYPE', `upstream content-type "${contentType ?? 'none'}" is not in the gateway allowlist`);
    }
    const bytes = await readCapped(upstream.body, upstream.headers.get('content-length'), maxBytes);

    // 7. TileJSON trusted resolution + same-origin re-mapping.
    if (route.operation === 'tilejson') {
      const isAllowed = (t: ParsedTileTemplate): boolean => {
        const probe = matchOperation(routes, t.workspace, 'ogc-tiles', t.collection, 'tile' as GatewayOperation);
        return probe.ok;
      };
      const resolvedTileJson = resolveTileJson({
        text: new TextDecoder().decode(bytes),
        trustedServiceBase: config.trustedBase,
        gatewayOrigin: config.gatewayOrigin,
        gatewayPrefix: config.gatewayPrefix,
        isAllowedTileTemplate: isAllowed,
      });
      const body = JSON.stringify(resolvedTileJson.tileJson);
      return {
        status: 200,
        headers: Object.freeze({
          'Content-Type': 'application/json',
          'Cache-Control': cachePolicyFor(route, decision, 200, publicCacheSeconds),
          'X-Map-Source-Layer': resolvedTileJson.sourceLayer,
        }),
        body,
        decision,
        route,
      };
    }

    // 8. Cache policy + passthrough.
    const headers: Record<string, string> = {
      'Content-Type': contentType as string,
      'Cache-Control': cachePolicyFor(route, decision, upstream.status, publicCacheSeconds),
    };
    const etag = upstream.headers.get('etag');
    if (etag) headers['ETag'] = etag;
    return { status: upstream.status, headers: Object.freeze(headers), body: bytes, decision, route };
  } catch (err) {
    if (err instanceof GatewayError) return denyResponse(err.status, err.code, err.message);
    if (err instanceof UrlBuildError) return denyResponse(400, 'PARAM_INVALID', err.message);
    if (err instanceof TileJsonError) return denyResponse(502, 'TILEJSON_RESOLUTION_FAILED', err.message);
    return denyResponse(500, 'UPSTREAM_UNAVAILABLE', `unexpected gateway error: ${(err as Error).message}`);
  }
}
