/**
 * @utah-water/geo-gateway - public API surface.
 *
 * WD-005 authorized same-origin gateway for NeoServer spatial services.
 * See README.md for status (synthetic-sample tests only; live capture
 * pending Docker daemon + pinned digest verification).
 */
export {
  GATEWAY_ROUTES,
  FORBIDDEN_UPSTREAM_PATH_PREFIXES,
  WFS_MUTATION_REQUESTS,
  isForbiddenUpstreamPath,
  isWfsMutationRequest,
  matchRoute,
  matchOperation,
  resolveWxsOperation,
} from './allowlist.ts';
export type {
  ServiceKind,
  GatewayOperation,
  GuardObjectKind,
  CollectionRoute,
  ServiceRoute,
  WorkspaceRoute,
  RouteMatch,
  RouteDenial,
  RouteDenialReason,
  WxsOperationResolution,
} from './allowlist.ts';

export {
  WEB_MERCATOR_MAX_METERS,
  UrlBuildError,
  project4326To3857,
  lonLatToTile,
  tileToLonLat,
  enforceLimit,
  buildUpstreamUrl,
  assertTrustedUpstream,
} from './url.ts';
export type { UpstreamParams, BuildUpstreamOptions, UpstreamRouteParts } from './url.ts';

export {
  TileJsonError,
  TILE_TEMPLATE_PATH_RE,
  parseTileJson,
  extractSourceLayer,
  assertSourceLayer,
  resolveTileTemplate,
  resolveTileJson,
  ACCEPTED_MVT_LAYER_VERSIONS,
  isAcceptedMvtLayerVersion,
  assertAcceptedMvtLayerVersion,
} from './tilejson.ts';
export type { TileJsonDocument, TileJsonErrorCode, ParsedTileTemplate, TileTemplateAllowlist, ResolveTileJsonInput, ResolvedTileJson } from './tilejson.ts';

export {
  GatewayError,
  handleGatewayRequest,
  authorizeRoute,
  cachePolicyFor,
  readCapped,
} from './gateway.ts';
export type { SecretResolver, GatewaySession, GatewayRequest, GatewayResponse, GatewayConfig, GatewayErrorCode } from './gateway.ts';
