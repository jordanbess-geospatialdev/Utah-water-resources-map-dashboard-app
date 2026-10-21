/**
 * Bounded public map retrieval for discovery (FR-001; technical
 * specification, "NeoServer and map transport" and GeoLibre integration
 * rules).
 *
 * Invariants implemented and tested here:
 *
 * - PUBLIC PROJECTION ONLY: the discovery catalog is the fixture world
 *   projected through WD-006's public viewer (shell/data/projection,
 *   read-only reuse). Restricted/internal stations never enter any feature;
 *   the restricted operational block (gate code, wiring notes) has no
 *   representation in the property whitelist — no restricted field can reach
 *   a layer property.
 * - AXIS ORDER: fixture stations are EPSG:4326 latitude/longitude; GeoJSON is
 *   longitude/latitude. The swap below asserts the Utah latitude band
 *   (41.0-42.1 N) so a swapped axis order cannot pass silently (the band
 *   differs from the longitude range by ~70 degrees).
 * - BOUNDED RETRIEVAL: feature requests are bbox-bounded with hard limit caps
 *   (1..1000, default 250) mirroring map/shell/gateway.boundedFeatures —
 *   whose same-origin /geo/ URL builder this module reuses for the gateway
 *   query string — and services/geo-gateway's enforceLimit semantics.
 * - STALE-RESPONSE REJECTION: every load is issued through a request guard;
 *   a completion superseded by a newer filter/bbox change resolves to null
 *   and is never applied (GeoLibre rule: reject stale network responses
 *   after a filter change).
 * - TRANSPORT: the fixture world serves GeoJSON; TRANSPORT_NOTES documents
 *   the MVT-vs-GeoJSON selection rule against the gateway's allowlisted
 *   transports (see services/geo-gateway/src/{allowlist,url,tilejson}.ts).
 */
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from '@geolibre/core';
import type { FeatureCollection, Point } from 'geojson';
import { FIXTURE_SEED } from '../../shell/data/fixtures';
import { projectCatalog, type StationProjection, type Viewer } from '../../shell/data/projection';
import { boundedFeatures } from '../shell/gateway';
import { createRequestGuard, onlyLatest } from '../shell/requestGuard';
import { filterPublicStations, publicDiscoveryStations, type DiscoveryFilterSet } from '../../features/discovery/filters';

/** The anonymous viewer: discovery is account-free by definition. */
const PUBLIC_VIEWER: Viewer = { personaId: 'unauthenticated', role: 'public', principalId: null, organizationId: null };

/** The public catalog, projected once (fixture order), for any anonymous recipient. */
export function publicDiscoveryCatalog(): readonly StationProjection[] {
  return memoizedCatalog ??= projectCatalog(PUBLIC_VIEWER);
}
let memoizedCatalog: readonly StationProjection[] | null = null;

// ---------------------------------------------------------------------------
// Bounded retrieval
// ---------------------------------------------------------------------------

export interface DiscoveryBbox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export const DEFAULT_DISCOVERY_LIMIT = 250;
export const MAX_DISCOVERY_LIMIT = 1000;

export interface DiscoveryFeatureRequest {
  /** Filters applied server-side-of-the-projection (matching semantics: filters.ts). Unknown values match nothing. */
  readonly filters?: DiscoveryFilterSet;
  /** Viewport bound; omitted means the whole (already public, already filtered) catalog. */
  readonly bbox?: DiscoveryBbox;
  /** Hard cap on returned features; default 250, maximum 1000. */
  readonly limit?: number;
}

export interface DiscoveryFeatureSet {
  readonly collection: FeatureCollection<Point>;
  /** Public stations matching the filters (and bbox, when given) before the limit cap. */
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly limit: number;
}

const UTAH_LATITUDE_MIN = 41.0;
const UTAH_LATITUDE_MAX = 42.1;

/** The only properties a discovery feature may carry (display-safe; no restricted field has an entry). */
export const DISCOVERY_PROPERTY_WHITELIST = ['stationId', 'name', 'externalId', 'siteTypeId', 'telemetry', 'status', 'layerClass'] as const;
export type DiscoveryFeatureProperty = (typeof DISCOVERY_PROPERTY_WHITELIST)[number];

/** Validate a viewport box with the same rules as map/shell/gateway.boundedFeatures (mirrored semantics). */
export function validateDiscoveryBbox(bbox: DiscoveryBbox): DiscoveryBbox {
  const { west, south, east, north } = bbox;
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  ) {
    throw new Error('Invalid geographic bounding box');
  }
  return bbox;
}

function normalizeLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_DISCOVERY_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_DISCOVERY_LIMIT) throw new Error(`Limit must be 1–${MAX_DISCOVERY_LIMIT}`);
  return value;
}

function stationLayerClass(station: StationProjection): 'current' | 'attention' | 'unavailable' {
  if (station.status !== 'active' || station.freshness === 'no-data') return 'unavailable';
  if (station.freshness === 'stale') return 'attention';
  return 'current';
}

function stationFeature(station: StationProjection): FeatureCollection<Point>['features'][number] {
  if (station.latitude < UTAH_LATITUDE_MIN || station.latitude > UTAH_LATITUDE_MAX) {
    throw new Error(`${station.id}: latitude ${station.latitude} outside the Utah fixture band — axis order suspected swapped`);
  }
  return {
    type: 'Feature',
    id: station.id,
    properties: {
      stationId: station.id,
      name: station.displayName,
      externalId: station.externalId,
      siteTypeId: station.siteTypeId,
      telemetry: station.telemetry,
      status: station.status,
      layerClass: stationLayerClass(station),
    },
    geometry: { type: 'Point', coordinates: [station.longitude, station.latitude] },
  };
}

/**
 * The bounded retrieval: public projection -> filters -> viewport -> limit.
 * Pure and synchronous (the fixture world is local); createDiscoverySource
 * wraps it in the guarded async path the map consumes.
 */
export function discoveryFeatures(request: DiscoveryFeatureRequest = {}): DiscoveryFeatureSet {
  const limit = normalizeLimit(request.limit);
  if (request.bbox) validateDiscoveryBbox(request.bbox);

  const filtered = filterPublicStations(request.filters ?? {}).map((station) => {
    const projection = publicDiscoveryCatalog().find((candidate) => candidate.id === station.id);
    if (!projection) throw new Error(`station ${station.id} missing from the public catalog`);
    return projection;
  });

  const inView = request.bbox
    ? filtered.filter((station) => {
        const { west, south, east, north } = request.bbox!;
        return station.longitude >= west && station.longitude <= east && station.latitude >= south && station.latitude <= north;
      })
    : filtered;

  const features = inView.slice(0, limit).map(stationFeature);
  for (const feature of features) {
    const keys = Object.keys(feature.properties ?? {});
    if (!keys.every((key) => (DISCOVERY_PROPERTY_WHITELIST as readonly string[]).includes(key))) {
      throw new Error(`feature ${feature.id}: property outside the discovery whitelist`);
    }
  }
  return {
    collection: { type: 'FeatureCollection', features },
    total: inView.length,
    returned: features.length,
    truncated: inView.length > features.length,
    limit,
  };
}

/**
 * The gateway query string for the same bounded request (read-only reuse of
 * map/shell/gateway.boundedFeatures: same-origin /geo/ OGC API - Features
 * URL with bbox + capped limit). Used when the catalog is served by NeoServer
 * through WD-005's gateway instead of the local fixture world.
 */
export function gatewayFeaturesQuery(bbox: DiscoveryBbox, limit: number = DEFAULT_DISCOVERY_LIMIT): string {
  validateDiscoveryBbox(bbox);
  normalizeLimit(limit);
  return boundedFeatures('stations', [bbox.west, bbox.south, bbox.east, bbox.north], limit);
}

// ---------------------------------------------------------------------------
// Layer descriptors
// ---------------------------------------------------------------------------

export const DISCOVERY_LAYER_IDS = ['discovery-stations', 'discovery-stations-selected'] as const;

function discoveryLayer(id: string, name: string, color: string, stations: readonly StationProjection[], radius: number): GeoLibreLayer {
  return {
    id,
    name,
    type: 'geojson',
    source: {},
    visible: true,
    opacity: 1,
    metadata: {
      provenance: `synthetic fixture ${FIXTURE_SEED} · public projection`,
      contract: 'fixtures/contracts/stations.json',
      description: 'Public discovery stations (account-free): restricted fields are not representable in this layer',
      transport: TRANSPORT_NOTES.selectionRule,
    },
    geojson: { type: 'FeatureCollection', features: stations.map(stationFeature) },
    style: { ...DEFAULT_LAYER_STYLE, fillColor: color, strokeColor: '#ffffff', strokeWidth: 2, circleRadius: radius },
  };
}

/**
 * GeoLibre source+layer descriptors for the public discovery map: one
 * station layer plus a selected-station highlight. The UI owns selection and
 * filters; GeoLibre owns synchronization of its managed layers.
 */
export function buildDiscoveryLayers(stations: readonly StationProjection[], selectedStationId: string | null): GeoLibreLayer[] {
  const layers: GeoLibreLayer[] = [discoveryLayer('discovery-stations', 'Public measurement stations', '#16887e', stations, 7)];
  const selected = stations.filter((station) => station.id === selectedStationId);
  if (selected.length > 0) {
    layers.push(discoveryLayer('discovery-stations-selected', 'Selected station', '#0a4748', selected, 10));
  }
  return layers;
}

// ---------------------------------------------------------------------------
// Guarded source (stale-response rejection on filter change)
// ---------------------------------------------------------------------------

export interface DiscoverySource {
  /**
   * Load features for a request. Resolves null when a newer load superseded
   * this one (stale responses are rejected, never applied). The current
   * load's validation errors reject; a superseded load's errors resolve null.
   */
  load(request: DiscoveryFeatureRequest): Promise<DiscoveryFeatureSet | null>;
}

/** Create a guarded discovery source. One source per mounted map. */
export function createDiscoverySource(): DiscoverySource {
  const guard = createRequestGuard();
  return {
    load: (request: DiscoveryFeatureRequest) =>
      // The await is the async boundary standing in for the network hop; the
      // guard decides whether the completion is still current.
      onlyLatest(guard, async () => {
        await Promise.resolve();
        return discoveryFeatures(request);
      }),
  };
}

// ---------------------------------------------------------------------------
// Transport selection notes (MVT vs GeoJSON; see geo-gateway allowlist)
// ---------------------------------------------------------------------------

export const TRANSPORT_NOTES = {
  selectionRule:
    'GeoJSON (OGC API - Features, bbox + capped limit) while a bounded viewport fits within MAX_DISCOVERY_LIMIT features; switch to MVT vector tiles when the public catalog outgrows per-viewport GeoJSON.',
  geojson:
    'Gateway collections items route with explicit JSON output and a bounded limit — gatewayFeaturesQuery() reuses map/shell/gateway.boundedFeatures; allowlisted by services/geo-gateway/src/allowlist.ts (collections items/tilejson/tile routes only).',
  mvt:
    'WebMercatorQuad tiles at /tiles/WebMercatorQuad/{z}/{y}/{x}, matrix/row/column — never a swapped y/x or a guessed .pbf suffix; the tile template and the MVT source-layer id resolve from the collection TileJSON via services/geo-gateway/src/tilejson.ts.',
  invariants:
    'Either transport serves the same public projection: feature properties restricted to DISCOVERY_PROPERTY_WHITELIST (no restricted field reaches a layer property), bbox-bounded requests with limit caps, and stale responses rejected after every filter change.',
} as const;

/** Station-record export for callers that need the raw public rows (popup, table). */
export { publicDiscoveryStations };
