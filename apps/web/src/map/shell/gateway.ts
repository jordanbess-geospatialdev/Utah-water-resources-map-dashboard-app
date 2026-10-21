/**
 * Proposed gateway contract helpers, ported from the validated prototype's
 * adapters.ts. No live service or credential is configured in this shell: the
 * helpers only construct and validate the service URL shapes the GeoLibre
 * integration will consume once NeoServer publishes approved spatial services
 * (WD-003 owns the gateway itself).
 */
export interface NeoTileJson {
  tiles: string[];
  vector_layers?: { id: string }[];
  minzoom?: number;
  maxzoom?: number;
  attribution?: string;
}

const allowedOrigin = 'https://water.example.gov';

export function trustedGatewayUrl(value: string): string {
  const parsed = new URL(value, allowedOrigin);
  if (parsed.origin !== allowedOrigin || !parsed.pathname.startsWith('/geo/')) {
    throw new Error('Only same-origin /geo/ service URLs are accepted.');
  }
  if (parsed.username || parsed.password || ['token', 'api_key', 'key', 'access_token'].some((k) => parsed.searchParams.has(k))) {
    throw new Error('Credentials must not be placed in service URLs.');
  }
  return (parsed.pathname + parsed.search).replace(/%7B(z|x|y)%7D/gi, (_, name: string) => `{${name.toLowerCase()}}`);
}

export function neoVectorSource(metadata: NeoTileJson) {
  if (!metadata.tiles.length || !metadata.vector_layers?.length) {
    throw new Error('TileJSON must advertise tiles and an MVT source layer.');
  }
  return {
    type: 'vector' as const,
    tiles: metadata.tiles.map(trustedGatewayUrl),
    minzoom: metadata.minzoom ?? 0,
    maxzoom: metadata.maxzoom ?? 22,
    attribution: metadata.attribution,
  };
}

export function boundedFeatures(collection: string, bbox: [number, number, number, number], limit = 250): string {
  if (!/^[a-z0-9_-]+$/.test(collection)) throw new Error('Invalid collection');
  if (
    bbox.length !== 4 ||
    !bbox.every(Number.isFinite) ||
    bbox[0]! < -180 ||
    bbox[2]! > 180 ||
    bbox[1]! < -90 ||
    bbox[3]! > 90 ||
    bbox[0]! >= bbox[2]! ||
    bbox[1]! >= bbox[3]!
  ) {
    throw new Error('Invalid geographic bounding box');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Limit must be 1–1000');
  return `/geo/workspaces/water-public/ogc/collections/${collection}/items?bbox=${bbox.join(',')}&limit=${limit}`;
}

export function wmsRasterTemplate(layer: string): string {
  if (!/^[a-z0-9_-]+$/.test(layer)) throw new Error('Invalid WMS layer');
  // CRS=EPSG:3857 (not 4326): WMS 1.3.0 with EPSG:4326 uses lat/lon axis order,
  // the classic way a Utah bbox ends up far outside the state.
  return `/geo/workspaces/water-public/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layer}&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true`;
}
