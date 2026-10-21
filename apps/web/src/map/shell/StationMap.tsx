import { useCallback, useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { createLayerSync } from '@geolibre/map';
import { AlertTriangle, Crosshair, Layers, Loader2, MapPin } from 'lucide-react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { buildStationLayers, CLASS_COLORS, stationLayerClass } from './layers';
import { basemapById, type BasemapId } from './basemap';
import { createRequestGuard } from './requestGuard';
import type { StationProjection } from '../../shell/data/projection';

export interface MapCamera {
  center: [number, number];
  zoom: number;
}

export type MapStatus = 'loading' | 'ready' | 'error';

interface StationMapProps {
  stations: StationProjection[];
  selectedStationId: string | null;
  basemapId: BasemapId;
  initialCamera?: MapCamera;
  onSelect: (stationId: string) => void;
  onBasemapChange: (basemapId: BasemapId) => void;
  onCameraChange?: (camera: MapCamera) => void;
}

const LAYER_LEGEND: { id: keyof typeof CLASS_COLORS; label: string; shape: string }[] = [
  { id: 'current', label: 'Reporting', shape: '●' },
  { id: 'attention', label: 'Stale / flagged', shape: '◆' },
  { id: 'unavailable', label: 'No data or inactive', shape: '■' },
];

/**
 * GeoLibre + MapLibre GL JS station map, ported from the validated
 * prototype's WaterMap. Integration rules honored here:
 *
 * - `createLayerSync(map)` owns layer synchronization; `sync(layers)` is
 *   called with the complete layer list whenever the projected catalog or
 *   selection changes, and `dispose()` runs before the map is destroyed.
 * - Basemap changes go through Map#setStyle; on the following 'style.load'
 *   every GeoLibre-managed layer is reapplied (reapply after style reload).
 * - Style reloads are token-guarded: a reload superseded by a newer persona,
 *   filter or basemap change is rejected instead of applied (stale response
 *   rejection).
 * - Map failure (WebGL unavailable, render error) leaves the station table
 *   usable: the error state points at the table, which carries the same rows.
 */
export function StationMap({
  stations,
  selectedStationId,
  basemapId,
  initialCamera,
  onSelect,
  onBasemapChange,
  onCameraChange,
}: StationMapProps) {
  const root = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const engine = useRef<ReturnType<typeof createLayerSync> | null>(null);
  const styleGuard = useRef(createRequestGuard());
  const [status, setStatus] = useState<MapStatus>('loading');
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const latest = useRef({ stations, selectedStationId, onSelect, onCameraChange });
  latest.current = { stations, selectedStationId, onSelect, onCameraChange };

  const layersFor = useCallback(
    (currentStations: StationProjection[], currentSelected: string | null) =>
      buildStationLayers(currentStations, currentSelected),
    [],
  );

  const fit = useCallback(() => {
    const m = map.current;
    if (!m || latest.current.stations.length === 0) return;
    const bounds = new maplibregl.LngLatBounds();
    latest.current.stations.forEach((station) => bounds.extend([station.longitude, station.latitude]));
    m.fitBounds(bounds, { padding: 55, maxZoom: 10, duration: 600 });
  }, []);

  /** Apply a basemap by full style swap, then reapply every managed layer; guarded against stale reloads. */
  const applyBasemap = useCallback(
    (id: BasemapId) => {
      const m = map.current;
      if (!m) return;
      const token = styleGuard.current.begin();
      setStatus('loading'); // no layer sync while the style is transitioning
      m.setStyle(basemapById(id).style);
      m.once('style.load', () => {
        if (!styleGuard.current.isCurrent(token)) return; // superseded: reject the stale reload
        engine.current?.sync(layersFor(latest.current.stations, latest.current.selectedStationId));
        setStatus('ready');
        fit();
      });
    },
    [fit, layersFor],
  );

  // The basemap applied by the current map instance; null right after (re)mount.
  const appliedBasemap = useRef<BasemapId | null>(null);

  useEffect(() => {
    if (!root.current) return;
    let m: maplibregl.Map;
    try {
      m = new maplibregl.Map({
        container: root.current,
        center: initialCamera?.center ?? [-111.85, 41.63],
        zoom: initialCamera?.zoom ?? 8.6,
        style: basemapById(basemapId).style,
        attributionControl: { compact: true },
        maxZoom: 15,
        minZoom: 4,
      });
    } catch {
      setStatus('error');
      setError('This device cannot initialize WebGL. Use the accessible station table beside the map.');
      return;
    }
    map.current = m;
    appliedBasemap.current = basemapId;
    setStatus('loading');
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    const sync = createLayerSync(m);
    engine.current = sync;

    // Initial style application uses the same token-guarded path as later swaps.
    const token = styleGuard.current.begin();
    m.once('style.load', () => {
      if (!styleGuard.current.isCurrent(token)) return;
      engine.current?.sync(layersFor(latest.current.stations, latest.current.selectedStationId));
      setStatus('ready');
      fit();
    });

    m.on('click', (e) => {
      const hit = m.queryRenderedFeatures(e.point).find((feature) => feature.properties?.stationId);
      if (typeof hit?.properties?.stationId === 'string') latest.current.onSelect(hit.properties.stationId);
    });
    m.on('mousemove', (e) => {
      m.getCanvas().style.cursor = m.queryRenderedFeatures(e.point).some((feature) => feature.properties?.stationId) ? 'pointer' : '';
    });
    m.on('error', (e) => {
      if (String((e as ErrorEvent).message ?? e.error?.message).includes('WebGL')) {
        setStatus('error');
        setError('Map rendering is unavailable. The station table carries the same rows.');
      }
    });
    m.on('moveend', () => {
      const center = m.getCenter();
      latest.current.onCameraChange?.({ center: [center.lng, center.lat], zoom: m.getZoom() });
    });
    const observer = new ResizeObserver(() => m.resize());
    observer.observe(root.current);
    return () => {
      observer.disconnect();
      sync.dispose(); // GeoLibre rule: dispose synchronization before destroying the map
      m.remove();
      map.current = null;
      engine.current = null;
      appliedBasemap.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // Layer sync for catalog/selection changes (persona or filter switches included).
  useEffect(() => {
    if (status !== 'ready' || !engine.current) return;
    engine.current.sync(layersFor(stations, selectedStationId));
  }, [stations, selectedStationId, status, layersFor]);

  // Basemap switch: full style reload with layer reapplication after 'style.load'.
  useEffect(() => {
    if (appliedBasemap.current === basemapId) return;
    appliedBasemap.current = basemapId;
    if (status === 'error' || !map.current) return;
    applyBasemap(basemapId);
  }, [basemapId, status, applyBasemap]);

  useEffect(() => {
    if (status === 'ready') fit();
  }, [stations, status, fit]);

  const counts = LAYER_LEGEND.map((entry) => ({
    ...entry,
    count: stations.filter((station) => stationLayerClass(station) === entry.id).length,
  }));

  return (
    <div className="map-frame">
      <div
        ref={root}
        className="map-canvas"
        role="application"
        aria-label="Interactive map of synthetic Utah measurement stations; the station table provides the same rows accessibly"
      />
      <div className="map-tag">
        <MapPin size={13} aria-hidden /> UTAH · {stations.length} STATIONS
      </div>
      <div className="map-actions">
        <button type="button" onClick={fit} title="Fit stations" aria-label="Fit stations in view">
          <Crosshair size={16} aria-hidden />
        </button>
        <button
          type="button"
          className={basemapId === 'street' ? 'active' : ''}
          onClick={() => onBasemapChange(basemapId === 'street' ? 'terrain' : 'street')}
          title="Toggle basemap"
          aria-label={`Switch basemap to ${basemapId === 'street' ? 'terrain' : 'street'}`}
        >
          <Layers size={16} aria-hidden />
        </button>
      </div>
      <div className="map-key" aria-hidden>
        {counts.map((entry) => (
          <span key={entry.id}>
            <i style={{ background: CLASS_COLORS[entry.id] }} data-shape={entry.shape} />
            {entry.label} ({entry.count})
          </span>
        ))}
      </div>
      {status === 'loading' && (
        <div className="map-overlay" role="status" aria-live="polite">
          <Loader2 size={18} aria-hidden className="spin" />
          Loading station map…
        </div>
      )}
      {status === 'error' && (
        <div className="map-overlay error" role="alert">
          <AlertTriangle size={18} aria-hidden />
          <div>
            <strong>Interactive map unavailable.</strong>
            <p>{error}</p>
            <button type="button" className="button small" onClick={() => setAttempt((n) => n + 1)}>
              Retry map
            </button>
          </div>
        </div>
      )}
      {status !== 'error' && stations.length === 0 && (
        <div className="map-overlay" role="status">
          No stations match this view. Clear filters or switch persona to see more.
        </div>
      )}
      <span className="map-engine">GeoLibre 3.3.0 + MapLibre GL JS 6.15.0</span>
    </div>
  );
}

export default StationMap;
