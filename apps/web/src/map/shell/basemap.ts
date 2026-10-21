/**
 * Approved demo basemaps for the station map (FR-001: selectable basemaps
 * with retained selection and visible attribution). The terrain basemap is a
 * self-contained vector style (no network); the street basemap overlays
 * OpenStreetMap raster tiles under the same Utah context layers, with
 * attribution kept visible per the MapLibre attribution control.
 *
 * Styles are plain MapLibre style documents; switching basemaps calls
 * Map#setStyle and StationMap reapplies every GeoLibre-managed layer on the
 * following 'style.load' (GeoLibre integration rule: reapply layers after a
 * basemap style reload).
 */
import type { LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl';

export type BasemapId = 'terrain' | 'street';

export interface BasemapDefinition {
  id: BasemapId;
  label: string;
  description: string;
  style: StyleSpecification;
  /** Raster opacity for the street basemap; terrain has no raster layer. */
  rasterOpacity?: number;
}

const UTAH_OUTLINE = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-114.05, 37],
        [-109.05, 37],
        [-109.05, 41],
        [-111.05, 41],
        [-111.05, 42],
        [-114.05, 42],
        [-114.05, 37],
      ],
    ],
  },
} as const;

const RIVERS = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [-112.43, 37.64],
          [-112.41, 37.82],
          [-112.25, 38.05],
          [-112.19, 38.33],
          [-112.02, 38.75],
          [-111.87, 39.0],
          [-112.35, 39.35],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [-111.18, 40.7],
          [-111.42, 40.61],
          [-111.46, 40.46],
          [-111.68, 40.24],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [-112.2, 41.63],
          [-111.9, 41.65],
          [-111.85, 41.63],
        ],
      },
    },
  ],
} as const;

const CONTEXT_LAYERS: LayerSpecification[] = [
  { id: 'utah-fill', type: 'fill', source: 'utah', paint: { 'fill-color': '#f7f6ee', 'fill-opacity': 0.85 } },
  { id: 'utah-border', type: 'line', source: 'utah', paint: { 'line-color': '#afc2b9', 'line-width': 2, 'line-dasharray': [4, 3] } },
  { id: 'river-context', type: 'line', source: 'rivers', paint: { 'line-color': '#8ab9bd', 'line-width': 2 } },
];

const CONTEXT_SOURCES: Record<string, SourceSpecification> = {
  utah: { type: 'geojson', data: UTAH_OUTLINE as unknown as GeoJSON.Feature },
  rivers: { type: 'geojson', data: RIVERS as unknown as GeoJSON.FeatureCollection },
};

export const BASEMAPS: BasemapDefinition[] = [
  {
    id: 'terrain',
    label: 'Terrain',
    description: 'Self-contained vector context: state outline and river corridors.',
    style: {
      version: 8,
      sources: { ...CONTEXT_SOURCES },
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e9ede4' } }, ...CONTEXT_LAYERS],
    },
  },
  {
    id: 'street',
    label: 'Street',
    description: 'OpenStreetMap raster tiles under the vector context layers.',
    rasterOpacity: 0.75,
    style: {
      version: 8,
      sources: {
        ...CONTEXT_SOURCES,
        street: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors',
        },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#e9ede4' } },
        { id: 'street', type: 'raster', source: 'street', paint: { 'raster-opacity': 0.75 } },
        ...CONTEXT_LAYERS,
      ],
    },
  },
];

export function basemapById(id: BasemapId): BasemapDefinition {
  return BASEMAPS.find((basemap) => basemap.id === id) ?? BASEMAPS[0]!;
}
