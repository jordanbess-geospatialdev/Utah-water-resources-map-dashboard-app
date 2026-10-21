/**
 * URL-serializable view state (FR-008 basics).
 *
 * Serialization contract:
 * - Versioned: `v=1`. A query without a known version parses to null and the
 *   app falls back to defaults rather than guessing.
 * - Only non-sensitive view state travels: active view, filters, chart
 *   window, basemap, selected station and map camera. The demo persona is
 *   deliberately NOT serialized: bookmarking another user's view must not
 *   reproduce their permissions, and unknown parameters (including any
 *   persona/role/credential attempt) are ignored on parse.
 * - Canonical: multi-value fields are emitted in stable order and numbers are
 *   rounded deterministically, so serialize(parse(serialize(x))) === serialize(x).
 * - Accessibility is applied by the caller: an inaccessible selected station
 *   is dropped with a clear message (see applyViewState), never silently kept.
 */

export type ShellView = 'overview' | 'sites' | 'stewardship';
export type BasemapKind = 'terrain' | 'street';
export type TelemetryFilter = 'all' | 'telemetered' | 'manual';
export type ChartWindow = 7 | 14;

export interface ViewState {
  view: ShellView;
  stationId: string | null;
  systemId: string;
  siteTypeId: string;
  telemetry: TelemetryFilter;
  days: ChartWindow;
  basemap: BasemapKind;
  map: { center: [number, number]; zoom: number };
}

export const VIEW_STATE_VERSION = 1;

export const defaultViewState: ViewState = {
  view: 'overview',
  stationId: null,
  systemId: 'all',
  siteTypeId: 'all',
  telemetry: 'all',
  days: 7,
  basemap: 'terrain',
  map: { center: [-111.85, 41.63], zoom: 8.6 },
};

const VIEWS: ShellView[] = ['overview', 'sites', 'stewardship'];
const BASEMAPS: BasemapKind[] = ['terrain', 'street'];
const TELEMETRY: TelemetryFilter[] = ['all', 'telemetered', 'manual'];
const WINDOWS: ChartWindow[] = [7, 14];

function encodeState(state: ViewState): URLSearchParams {
  const params = new URLSearchParams();
  params.set('v', String(VIEW_STATE_VERSION));
  params.set('view', state.view);
  if (state.stationId !== null) params.set('station', state.stationId);
  params.set('system', state.systemId);
  params.set('sitetype', state.siteTypeId);
  params.set('telemetry', state.telemetry);
  params.set('days', String(state.days));
  params.set('basemap', state.basemap);
  params.set('center', `${state.map.center[0].toFixed(4)},${state.map.center[1].toFixed(4)}`);
  params.set('zoom', state.map.zoom.toFixed(2));
  return params;
}

/** Serialize to a query string WITHOUT a leading '?'. */
export function serializeViewState(state: ViewState): string {
  return encodeState(state).toString();
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function finiteOrNaN(raw: string | null): number {
  const parsed = Number.parseFloat(raw ?? 'nan');
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Parse a query string ('?' optional). Returns null for missing/unknown versions; unknown values fall back to defaults. */
export function parseViewState(query: string): ViewState | null {
  const search = query.startsWith('?') ? query.slice(1) : query;
  if (search.trim() === '') return null;
  const params = new URLSearchParams(search);
  const version = Number.parseInt(params.get('v') ?? '', 10);
  if (version !== VIEW_STATE_VERSION) return null;
  const stationId = params.get('station');
  const centerRaw = (params.get('center') ?? '').split(',');
  const longitude = finiteOrNaN(centerRaw[0] ?? null);
  const latitude = finiteOrNaN(centerRaw[1] ?? null);
  const zoom = finiteOrNaN(params.get('zoom'));
  return {
    view: oneOf(params.get('view'), VIEWS, defaultViewState.view),
    stationId: stationId !== null && /^[a-z0-9-]+$/i.test(stationId) ? stationId : null,
    systemId: (params.get('system') ?? defaultViewState.systemId).replace(/[^a-z0-9-]/gi, '') || 'all',
    siteTypeId: (params.get('sitetype') ?? defaultViewState.siteTypeId).replace(/[^a-z0-9-]/gi, '') || 'all',
    telemetry: oneOf(params.get('telemetry'), TELEMETRY, defaultViewState.telemetry),
    days: WINDOWS.includes(Number.parseInt(params.get('days') ?? '', 10) as ChartWindow)
      ? (Number.parseInt(params.get('days') ?? '', 10) as ChartWindow)
      : defaultViewState.days,
    basemap: oneOf(params.get('basemap'), BASEMAPS, defaultViewState.basemap),
    map: {
      center: [
        Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 ? longitude : defaultViewState.map.center[0]!,
        Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 ? latitude : defaultViewState.map.center[1]!,
      ],
      zoom: Number.isFinite(zoom) && zoom >= 3 && zoom <= 15 ? zoom : defaultViewState.map.zoom,
    },
  };
}

export interface AppliedViewState {
  state: ViewState;
  /** Set when the URL selected a station the current session cannot access; the station is omitted and the caller shows a denied notice. */
  deniedStationId: string | null;
}

/**
 * Apply a parsed state against the stations this session may see. An
 * inaccessible selection is dropped (never kept silently) and reported so the
 * UI can explain it, honoring "a recipient receives only data their own
 * current session can access".
 */
export function applyViewState(parsed: ViewState, permittedStationIds: readonly string[]): AppliedViewState {
  const denied = parsed.stationId !== null && !permittedStationIds.includes(parsed.stationId);
  return {
    state: denied || parsed.stationId === null ? { ...parsed, stationId: null } : parsed,
    deniedStationId: denied ? parsed.stationId : null,
  };
}

/** Round-trip check used by tests: parse(serialize(x)) equals x (modulo deterministic rounding). */
export function roundTrip(state: ViewState): ViewState | null {
  return parseViewState(`?${serializeViewState(state)}`);
}
