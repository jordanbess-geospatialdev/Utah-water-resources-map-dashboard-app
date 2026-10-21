/**
 * GeoLibre layer adapter (technical specification, "Browser design and
 * GeoLibre integration"): constructs complete GeoLibre layers from the
 * authorized station catalog. Each layer has a stable id, name, type, source,
 * visibility, opacity, style and metadata; the UI owns selection and filters,
 * GeoLibre owns synchronization of its managed layers.
 *
 * Axis order: fixture stations are EPSG:4326 latitude/longitude; GeoJSON is
 * longitude/latitude. stationsToGeoJSON performs the swap; the Utah latitude
 * band (41.2-42.0 N) is asserted so a swap mistake cannot pass silently.
 *
 * Feature properties are display-only (stationId, name, externalId, access).
 * The restricted operational block never enters map feature properties, even
 * for viewers whose demo projection includes it.
 */
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from '@geolibre/core';
import type { FeatureCollection } from 'geojson';
import { FIXTURE_SEED } from '../../shell/data/fixtures';
import type { StationProjection } from '../../shell/data/projection';

export const STATION_LAYER_CLASSES = ['current', 'attention', 'unavailable'] as const;
export type StationLayerClass = (typeof STATION_LAYER_CLASSES)[number];

/** Color-blind-aware palette; class meaning is also carried by radius and in the legend text. */
export const CLASS_COLORS: Record<StationLayerClass, string> = {
  current: '#16887e',
  attention: '#c98a2d',
  unavailable: '#8a8f98',
};
const SELECTED_COLOR = '#0a4748';

const UTAH_LATITUDE_MIN = 41.0;
const UTAH_LATITUDE_MAX = 42.1;

export function stationLayerClass(station: StationProjection): StationLayerClass {
  if (station.status !== 'active' || station.freshness === 'no-data') return 'unavailable';
  if (station.freshness === 'stale' || (station.latest?.flags.length ?? 0) > 0) return 'attention';
  return 'current';
}

/** Convert the fixture axis order (lat, lon) to GeoJSON axis order (lon, lat), asserting the Utah latitude band. */
export function stationsToGeoJSON(stations: StationProjection[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: stations.map((station) => {
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
          access: station.access,
          layerClass: stationLayerClass(station),
        },
        geometry: { type: 'Point', coordinates: [station.longitude, station.latitude] },
      };
    }),
  };
}

function stationLayer(id: string, name: string, color: string, stations: StationProjection[], radius: number): GeoLibreLayer {
  return {
    id,
    name,
    type: 'geojson',
    source: {},
    visible: true,
    opacity: 1,
    metadata: {
      provenance: `synthetic fixture ${FIXTURE_SEED}`,
      contract: 'fixtures/contracts/stations.json',
      description: 'Measurement stations projected for the current demo persona',
    },
    geojson: stationsToGeoJSON(stations),
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillColor: color,
      strokeColor: '#ffffff',
      strokeWidth: 2,
      circleRadius: radius,
    },
  };
}

/**
 * Build the complete GeoLibre layer list for the projected catalog: one layer
 * per station class (stable ids `stations-current`, `stations-attention`,
 * `stations-unavailable`) plus a `station-selected` highlight layer.
 */
export function buildStationLayers(stations: StationProjection[], selectedStationId: string | null): GeoLibreLayer[] {
  const layers: GeoLibreLayer[] = STATION_LAYER_CLASSES.map((layerClass) =>
    stationLayer(
      `stations-${layerClass}`,
      layerClass === 'current' ? 'Reporting stations' : layerClass === 'attention' ? 'Stale or flagged stations' : 'No data or inactive stations',
      CLASS_COLORS[layerClass],
      stations.filter((station) => stationLayerClass(station) === layerClass),
      layerClass === 'current' ? 7 : 6,
    ),
  );
  const selected = stations.filter((station) => station.id === selectedStationId);
  if (selected.length > 0) {
    layers.push(stationLayer('station-selected', 'Selected station', SELECTED_COLOR, selected, 10));
  }
  return layers;
}

export const MAP_LAYER_IDS = ['stations-current', 'stations-attention', 'stations-unavailable', 'station-selected'];
