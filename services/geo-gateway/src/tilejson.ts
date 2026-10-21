/**
 * Trusted TileJSON resolution for the authorized spatial gateway (WD-005).
 *
 * Source of truth: docs/product/baseline/02-technical-specification.md,
 * "NeoServer and map transport":
 * - "Read TileJSON; use advertised template and actual source-layer ID."
 * - "Do not swap x/y, add a guessed `.pbf` suffix or guess the MVT
 *   source-layer name."
 * - "Do not blindly rewrite relative TileJSON links against the browser
 *   location: resolve against the trusted NeoServer service URL and map only
 *   allowlisted paths to the same-origin gateway."
 * and docs/product/baseline/03-architecture.md: "Select source-layer IDs and
 * row/column order from actual TileJSON rather than a guessed endpoint
 * pattern."
 *
 * What this module does (pure; no fetch):
 * 1. Parse and shape-check an upstream TileJSON document (fail loudly).
 * 2. Resolve every `tiles[]` template against the TRUSTED service base -
 *    never the browser location - and refuse templates that point at any
 *    other origin (an upstream host must never leak to the browser).
 * 3. Accept only templates on the WebMercatorQuad matrix z/y/x path shape
 *    this gateway routes, without a guessed format suffix, and re-map each
 *    one to the SAME-ORIGIN gateway path for the allowlisted
 *    workspace/collection pair.
 * 4. Extract the ACTUAL MVT source-layer id from `vector_layers[0].id` so
 *    MapLibre sources are configured from evidence, not guesses; consumers
 *    that pass a guessed id to assertSourceLayer() fail loudly.
 */

/** Stable machine-readable codes for TileJSON resolution failures. */
export type TileJsonErrorCode =
  | 'TILEJSON_INVALID_JSON'
  | 'TILEJSON_INVALID_SHAPE'
  | 'TILEJSON_NO_TEMPLATES'
  | 'TILE_TEMPLATE_UNTRUSTED_ORIGIN'
  | 'TILE_TEMPLATE_NOT_ALLOWLISTED'
  | 'TILE_TEMPLATE_BAD_SHAPE'
  | 'TILE_TEMPLATE_QUERY_UNEXPECTED'
  | 'SOURCE_LAYER_ABSENT'
  | 'SOURCE_LAYER_MISMATCH'
  | 'MVT_LAYER_VERSION_NOT_ACCEPTED';

export class TileJsonError extends Error {
  readonly code: TileJsonErrorCode;
  constructor(code: TileJsonErrorCode, detail: string) {
    super(`[${code}] ${detail}`);
    this.code = code;
    this.name = 'TileJsonError';
  }
}

/** The subset of TileJSON (RFC 8337 / Mapbox v3 shape) this gateway touches. */
export interface TileJsonDocument {
  readonly tilejson: string;
  readonly name?: string;
  readonly tiles: readonly string[];
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly bounds?: readonly number[];
  readonly attribution?: string;
  readonly vector_layers?: readonly { readonly id: string; readonly description?: string; readonly fields?: Record<string, string> }[];
  [key: string]: unknown;
}

/** A tile template parsed down to the coordinates the gateway re-maps. */
export interface ParsedTileTemplate {
  readonly workspace: string;
  readonly collection: string;
  readonly tileMatrixSet: string;
}

/** Decide whether a parsed template is routable. Implemented over the route table by the caller. */
export type TileTemplateAllowlist = (template: ParsedTileTemplate) => boolean;

export interface ResolveTileJsonInput {
  /** Raw upstream TileJSON body (text). */
  readonly text: string;
  /** Trusted NeoServer service base, e.g. `http://neoserver:9000`. Relative links resolve against THIS. */
  readonly trustedServiceBase: string;
  /** Same-origin public origin templates are re-mapped onto, e.g. `https://portal.example.utah.gov`. */
  readonly gatewayOrigin: string;
  /** Mount prefix of the gateway on that origin, e.g. `/geo` (default none). */
  readonly gatewayPrefix?: string;
  /** Allowlist predicate over the parsed workspace/collection/matrix-set. */
  readonly isAllowedTileTemplate: TileTemplateAllowlist;
}

export interface ResolvedTileJson {
  /** The rewritten document: identical fields except `tiles` are same-origin gateway templates. */
  readonly tileJson: TileJsonDocument;
  /** The ACTUAL source-layer id from vector_layers[0] - what MapLibre must use. */
  readonly sourceLayer: string;
  /** Same-origin gateway tile templates in `tiles` order. */
  readonly gatewayTemplates: readonly string[];
  /** The parsed templates (trusted-service coordinates) for audit/logging. */
  readonly upstreamTemplates: readonly ParsedTileTemplate[];
}

/** Template path shape routed by this gateway (matrix z/y/x, no format suffix). */
export const TILE_TEMPLATE_PATH_RE =
  /^\/workspaces\/([a-z0-9][a-z0-9-_]*)\/ogc-tiles\/collections\/([a-z0-9][a-z0-9-_]*)\/tiles\/WebMercatorQuad\/\{z\}\/\{y\}\/\{x\}$/;

/** Parse raw text into a shape-checked TileJSON document. */
export function parseTileJson(text: string): TileJsonDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new TileJsonError('TILEJSON_INVALID_JSON', `TileJSON body is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TileJsonError('TILEJSON_INVALID_SHAPE', 'TileJSON must be a JSON object');
  }
  const doc = parsed as Record<string, unknown>;
  if (typeof doc.tilejson !== 'string' || !Array.isArray(doc.tiles) || doc.tiles.some((t) => typeof t !== 'string')) {
    throw new TileJsonError('TILEJSON_INVALID_SHAPE', 'TileJSON must carry string `tilejson` and string[] `tiles`');
  }
  if (doc.tiles.length === 0) {
    throw new TileJsonError('TILEJSON_NO_TEMPLATES', 'TileJSON advertises no tile templates');
  }
  return parsed as TileJsonDocument;
}

/**
 * The ACTUAL MVT source-layer id from the TileJSON. Fails loudly when the
 * document does not advertise one: a vector tileset without vector_layers
 * cannot be safely wired into MapLibre by this gateway.
 */
export function extractSourceLayer(tileJson: TileJsonDocument): string {
  const layers = tileJson.vector_layers;
  if (!Array.isArray(layers) || layers.length === 0 || typeof layers[0]?.id !== 'string' || layers[0].id.length === 0) {
    throw new TileJsonError('SOURCE_LAYER_ABSENT', 'TileJSON has no vector_layers[0].id; refusing to guess the MVT source-layer name');
  }
  return layers[0].id;
}

/**
 * Fail loudly when a consumer's assumed source-layer id differs from the
 * actual advertised one. This is the guard against wiring MapLibre with a
 * guessed layer name (spec: "Do not ... guess the MVT source-layer name").
 */
export function assertSourceLayer(tileJson: TileJsonDocument, assumed: string): void {
  const actual = extractSourceLayer(tileJson);
  if (actual !== assumed) {
    throw new TileJsonError(
      'SOURCE_LAYER_MISMATCH',
      `assumed source-layer "${assumed}" does not match the advertised "${actual}"; use extractSourceLayer() / the gateway TileJSON response`,
    );
  }
}

// ---------------------------------------------------------------------------
// MVT layer version policy (T-05 finding D5)
// ---------------------------------------------------------------------------

/**
 * DECISION (T-05 finding D5, infra/neoserver/qualification/recorded/
 * CAPTURE-REPORT.md section 4; policy doc: infra/neoserver/qualification/
 * KNOWN-SERVER-BEHAVIOR.md): the MVT layer versions this gateway accepts.
 *
 * - Version 1 is the SUPPORTED BASELINE. The pinned NeoServer 0.3.0 image
 *   (tobilg/neoserver@sha256:dab746cc…) emits MVT layer version 1 - verified
 *   live during the T-05 qualification by an independent protobuf decode of
 *   the captured control tile; no [Tiles] configuration knob changes it.
 *   Rejecting v1 would reject every real tile this gateway's pinned upstream
 *   produces.
 * - Version 2 is accepted as FORWARD-COMPATIBLE (MVT 2.x; the synthetic
 *   samples in this suite are v2), so a future upstream that starts emitting
 *   v2 needs no gateway change.
 * - Anything else (0, 3, ...) is refused loudly: an unexpected version means
 *   the upstream changed shape and a human must re-qualify against a new
 *   pinned digest, not have consumers silently absorb it.
 *
 * MapLibre renders both v1 and v2, so accepting v1 does not weaken the
 * browser side of the transport.
 */
export const ACCEPTED_MVT_LAYER_VERSIONS: ReadonlySet<number> = Object.freeze(new Set([1, 2]));

/** Policy predicate over a decoded MVT layer version (see ACCEPTED_MVT_LAYER_VERSIONS). */
export function isAcceptedMvtLayerVersion(version: number): boolean {
  return ACCEPTED_MVT_LAYER_VERSIONS.has(version);
}

/** Loud policy gate for a decoded MVT layer version (T-05 D5); throws when not accepted. */
export function assertAcceptedMvtLayerVersion(version: number): void {
  if (!isAcceptedMvtLayerVersion(version)) {
    throw new TileJsonError(
      'MVT_LAYER_VERSION_NOT_ACCEPTED',
      `MVT layer version ${version} is outside the accepted policy {1, 2} (v1 = pinned NeoServer 0.3.0 baseline, v2 = forward-compatible); re-qualify the upstream digest before widening`,
    );
  }
}

/**
 * Resolve one advertised tile template against the trusted service base and
 * validate its shape. Returns the trusted-resolved absolute URL plus parsed
 * coordinates. Throws TileJsonError for anything not routable:
 * - absolute templates on any origin other than the trusted service
 * - non-WebMercatorQuad matrix sets, format suffixes, missing {z}/{y}/{x}
 * - templates carrying a query string (would smuggle upstream credentials
 *   into the browser-facing document)
 */
export function resolveTileTemplate(template: string, trustedServiceBase: string): { resolved: URL; parsed: ParsedTileTemplate } {
  let resolved: URL;
  try {
    // Relative entries resolve against the TRUSTED service base - never a
    // browser location. Absolute entries must already be on the trusted origin.
    resolved = new URL(template, trustedServiceBase);
  } catch {
    throw new TileJsonError('TILE_TEMPLATE_BAD_SHAPE', `tile template "${template}" is not resolvable against the trusted service base`);
  }

  const base = new URL(trustedServiceBase);
  if (resolved.origin !== base.origin) {
    throw new TileJsonError(
      'TILE_TEMPLATE_UNTRUSTED_ORIGIN',
      `tile template resolves to ${resolved.origin}, not the trusted service origin ${base.origin}; refusing to leak an upstream host to the browser`,
    );
  }
  if (resolved.username || resolved.password) {
    throw new TileJsonError('TILE_TEMPLATE_BAD_SHAPE', 'tile template carries userinfo');
  }
  if ([...resolved.searchParams].length > 0) {
    throw new TileJsonError(
      'TILE_TEMPLATE_QUERY_UNEXPECTED',
      `tile template carries a query string ("${resolved.search}"); the gateway attaches service credentials itself and never forwards them to browsers`,
    );
  }
  if (resolved.hash) {
    throw new TileJsonError('TILE_TEMPLATE_BAD_SHAPE', 'tile template carries a fragment');
  }

  const basePath = base.pathname.replace(/\/+$/, '');
  const prefix = basePath === '' ? '' : `${basePath}/`;
  // new URL() percent-encodes the literal template braces ({z} -> %7Bz%7D);
  // decode so the regex sees the advertised shape.
  let path: string;
  try {
    path = decodeURIComponent(resolved.pathname);
  } catch {
    throw new TileJsonError('TILE_TEMPLATE_BAD_SHAPE', `tile template path "${resolved.pathname}" is not percent-decodable`);
  }
  const match = TILE_TEMPLATE_PATH_RE.exec(
    // Trim the trusted base's own path so the regex sees the service-relative shape.
    prefix && path.startsWith(prefix) ? path.slice(prefix.length - 1) : path,
  );
  if (!match) {
    const shape = /\/tiles\/([A-Za-z0-9-]+)\//.exec(path);
    if (shape && shape[1] !== 'WebMercatorQuad') {
      throw new TileJsonError('TILE_TEMPLATE_BAD_SHAPE', `tile template uses unsupported tile matrix set "${shape[1]}" (only WebMercatorQuad is routed)`);
    }
    throw new TileJsonError(
      'TILE_TEMPLATE_BAD_SHAPE',
      `tile template path "${path}" is not /workspaces/{ws}/ogc-tiles/collections/{id}/tiles/WebMercatorQuad/{{z}}/{{y}}/{{x}} in matrix z/y/x order without a format suffix`,
    );
  }
  return {
    resolved,
    parsed: { workspace: match[1], collection: match[2], tileMatrixSet: 'WebMercatorQuad' },
  };
}

/**
 * Resolve a whole TileJSON document: trusted resolution + same-origin
 * re-mapping of ONLY allowlisted templates, plus actual source-layer
 * extraction. The returned document must contain no upstream host anywhere.
 */
export function resolveTileJson(input: ResolveTileJsonInput): ResolvedTileJson {
  const tileJson = parseTileJson(input.text);
  const sourceLayer = extractSourceLayer(tileJson);
  const prefix = input.gatewayPrefix ?? '';

  const gatewayTemplates: string[] = [];
  const upstreamTemplates: ParsedTileTemplate[] = [];
  for (const template of tileJson.tiles) {
    const { parsed } = resolveTileTemplate(template, input.trustedServiceBase);
    if (!input.isAllowedTileTemplate(parsed)) {
      throw new TileJsonError(
        'TILE_TEMPLATE_NOT_ALLOWLISTED',
        `tile template workspace="${parsed.workspace}" collection="${parsed.collection}" is not in the gateway allowlist; only allowlisted paths are mapped to the same-origin gateway`,
      );
    }
    upstreamTemplates.push(parsed);
    gatewayTemplates.push(
      // Same-origin gateway path, same matrix z/y/x template variables.
      `${input.gatewayOrigin}${prefix}/workspaces/${parsed.workspace}/ogc-tiles/collections/${parsed.collection}/tiles/WebMercatorQuad/{z}/{y}/{x}`,
    );
  }

  // Rewritten document: shallow copy with ONLY `tiles` replaced. bounds,
  // zooms, attribution and vector_layers pass through untouched.
  const rewritten: TileJsonDocument = { ...tileJson, tiles: Object.freeze(gatewayTemplates) };
  return { tileJson: rewritten, sourceLayer, gatewayTemplates, upstreamTemplates };
}
