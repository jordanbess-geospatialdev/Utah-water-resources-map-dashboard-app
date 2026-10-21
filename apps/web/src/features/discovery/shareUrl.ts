/**
 * Versioned share-URL codec for public discovery (FR-008, T-10).
 *
 * Serialization contract (technical specification, "Filters and sharing";
 * extends the no-persona guarantee of shell/data/viewState.ts into the
 * discovery surface):
 *
 * - Versioned: `v=1`. A query without a known version parses to null and the
 *   caller falls back to defaults rather than guessing.
 * - Only non-sensitive state travels: the canonical FilterSet (`f`), the map
 *   extent (`e`, CRS84 west,south,east,north at 4-decimal precision) and the
 *   selected PUBLIC site (`s`). The demo persona, roles, credentials,
 *   entitlements and internal notes are never read on parse and never
 *   emitted; unknown parameters are ignored.
 * - Restricted objects never enter a link: a selected site that is not in the
 *   caller's public catalog is omitted with a notice at build time AND at
 *   resolve time, so a shared (or forged) link for a restricted station
 *   resolves to omitted-with-notice, never a leak.
 * - Filter values pass through filters.ts canonicalization: free text and
 *   restricted identifiers are redacted; well-formed unknown vocabulary
 *   survives and is reported so the recipient can inspect it in the data
 *   dictionary (FR-060).
 * - Deterministic: extents are rounded to 4 decimals and filters serialize in
 *   registry order, so serialize(parse(serialize(x))) === serialize(x).
 * - Bounded: the emitted URL is capped at MAX_SHARE_URL_LENGTH; overflow sheds
 *   whole filter dimensions (last first) with a notice instead of emitting an
 *   unusable link.
 *
 * Pure module: no DOM, no history mutation (the shell owns location).
 */
import {
  canonicalizeFilters,
  DISCOVERY_DIMENSIONS,
  FILTER_VALUE_PATTERN,
  parseFilters,
  publicDiscoveryStations,
  RESTRICTED_OBJECT_IDS,
  serializeFilters,
  UNKNOWN_SENTINEL,
  type CanonicalFilterResult,
  type DiscoveryFilterSet,
  type FilterDimensionKey,
  type FilterRedaction,
} from './filters';

export const SHARE_URL_VERSION = 1;
export const MAX_SHARE_URL_LENGTH = 2048;
export const EXTENT_DECIMALS = 4;

/** CRS84 bounding box of the map view being shared. */
export interface MapExtent {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export interface DiscoveryShareState {
  readonly filters: DiscoveryFilterSet;
  readonly extent: MapExtent;
  readonly selectedSiteId: string | null;
}

export type ShareNoticeKind =
  | 'filter-value-redacted'
  | 'filters-dropped-for-length'
  | 'site-omitted'
  | 'site-rejected'
  | 'extent-invalid'
  | 'unknown-filter-value';

export interface ShareNotice {
  readonly kind: ShareNoticeKind;
  /** Human-facing message; deliberately never echoes restricted identifiers or free text. */
  readonly message: string;
  readonly dimension?: FilterDimensionKey;
}

export interface BuiltShareUrl {
  /** Query string without the leading '?'. Empty when nothing survived. */
  readonly url: string;
  /** The state actually encoded (post canonicalization/omissions). */
  readonly state: DiscoveryShareState;
  readonly notices: readonly ShareNotice[];
}

export interface ParsedShareUrl {
  readonly version: number;
  readonly filters: DiscoveryFilterSet;
  readonly extent: MapExtent | null;
  readonly selectedSiteId: string | null;
  /** A site id that was rejected outright (malformed or a restricted identifier). Null-ed, never kept. */
  readonly rejectedSiteId: string | null;
  readonly redactions: readonly FilterRedaction[];
  readonly unknownValues: CanonicalFilterResult['unknownValues'];
  /** URL parameters present but not part of the codec — ignored, reported for transparency. */
  readonly ignoredKeys: readonly string[];
}

export interface ResolvedShare {
  readonly state: DiscoveryShareState;
  readonly notices: readonly ShareNotice[];
}

// ---------------------------------------------------------------------------
// Extent handling
// ---------------------------------------------------------------------------

function round4(value: number): number {
  return Math.round(value * 10 ** EXTENT_DECIMALS) / 10 ** EXTENT_DECIMALS || 0;
}

export function isValidExtent(extent: MapExtent): boolean {
  const { west, south, east, north } = extent;
  return (
    [west, south, east, north].every((value) => Number.isFinite(value)) &&
    west >= -180 &&
    east <= 180 &&
    south >= -90 &&
    north <= 90 &&
    west < east &&
    south < north
  );
}

/** Canonical extent: validated and rounded deterministically; null when unusable. */
export function canonicalizeExtent(extent: MapExtent | null | undefined): MapExtent | null {
  if (!extent || !isValidExtent(extent)) return null;
  const rounded: MapExtent = {
    west: round4(extent.west),
    south: round4(extent.south),
    east: round4(extent.east),
    north: round4(extent.north),
  };
  return rounded.west < rounded.east && rounded.south < rounded.north ? rounded : null;
}

/** Default extent: the bounds of the public catalog padded, so a bare link still frames the data. */
export function defaultShareExtent(): MapExtent {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const station of publicDiscoveryStations) {
    west = Math.min(west, station.longitude);
    east = Math.max(east, station.longitude);
    south = Math.min(south, station.latitude);
    north = Math.max(north, station.latitude);
  }
  const pad = 0.35;
  const extent = { west: west - pad, south: south - pad, east: east + pad, north: north + pad };
  return canonicalizeExtent(extent) ?? { west: -180, south: -90, east: 180, north: 90 };
}

export const defaultShareState = (): DiscoveryShareState => ({
  filters: {},
  extent: defaultShareExtent(),
  selectedSiteId: null,
});

// ---------------------------------------------------------------------------
// Site id handling
// ---------------------------------------------------------------------------

/** A shareable site id: well-formed and not an identifier of a restricted object. */
export function isShareableSiteId(siteId: string): boolean {
  return FILTER_VALUE_PATTERN.test(siteId) && !RESTRICTED_OBJECT_IDS.has(siteId);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Canonicalize the state and serialize it. `publicSiteIds` (recommended: the
 * caller's public catalog ids) gates the selected site: a selection outside
 * it is omitted with a notice instead of encoded.
 */
export function buildShareUrl(
  state: Readonly<Partial<DiscoveryShareState>>,
  options?: { readonly publicSiteIds?: readonly string[] },
): BuiltShareUrl {
  const notices: ShareNotice[] = [];
  const canonical = canonicalizeFilters(state.filters);
  for (const redaction of canonical.redactions) {
    notices.push({
      kind: 'filter-value-redacted',
      dimension: redaction.dimension,
      message: `One ${redaction.dimension} value was removed from the link (${redaction.reason}); links carry governed identifiers only.`,
    });
  }
  let filters = canonical.filters;

  const extent = canonicalizeExtent(state.extent) ?? defaultShareExtent();
  if (state.extent !== undefined && canonicalizeExtent(state.extent) === null) {
    notices.push({ kind: 'extent-invalid', message: 'The map extent was not shareable; the default extent was used.' });
  }

  let selectedSiteId: string | null = null;
  if (typeof state.selectedSiteId === 'string' && state.selectedSiteId.length > 0) {
    const candidate = state.selectedSiteId;
    if (!isShareableSiteId(candidate)) {
      notices.push({ kind: 'site-rejected', message: 'The selected site is not shareable; it was left out of the link.' });
    } else if (options?.publicSiteIds && !options.publicSiteIds.includes(candidate)) {
      notices.push({ kind: 'site-omitted', message: 'The selected site is not part of the public catalog; it was left out of the link.' });
    } else {
      selectedSiteId = candidate;
    }
  }

  let url = encodeQuery(SHARE_URL_VERSION, serializeFilters(filters), extent, selectedSiteId);
  // Length cap: shed whole dimensions, last in registry order, with a notice.
  while (url.length > MAX_SHARE_URL_LENGTH) {
    const lastDimension = [...DISCOVERY_DIMENSIONS].reverse().find((dimension) => filters[dimension.key]);
    if (!lastDimension) break;
    const reduced: Record<string, unknown> = {};
    for (const dimension of DISCOVERY_DIMENSIONS) {
      if (dimension.key === lastDimension.key) continue;
      const values = filters[dimension.key];
      if (values && values.length > 0) reduced[dimension.key] = values;
    }
    filters = reduced as DiscoveryFilterSet;
    notices.push({
      kind: 'filters-dropped-for-length',
      dimension: lastDimension.key,
      message: `The ${lastDimension.label} filter was dropped to keep the link usable.`,
    });
    url = encodeQuery(SHARE_URL_VERSION, serializeFilters(filters), extent, selectedSiteId);
  }

  return { url, state: { filters, extent, selectedSiteId }, notices };
}

function encodeQuery(version: number, filterSerialization: string, extent: MapExtent | null, siteId: string | null): string {
  const params = new URLSearchParams();
  params.set('v', String(version));
  if (filterSerialization !== '') params.set('f', filterSerialization);
  if (extent) params.set('e', `${extent.west.toFixed(EXTENT_DECIMALS)},${extent.south.toFixed(EXTENT_DECIMALS)},${extent.east.toFixed(EXTENT_DECIMALS)},${extent.north.toFixed(EXTENT_DECIMALS)}`);
  if (siteId !== null) params.set('s', siteId);
  return params.toString();
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** Parse a share query ('?' optional). Returns null for missing/unknown versions — never a guess. */
export function parseShareUrl(query: string): ParsedShareUrl | null {
  const search = query.startsWith('?') ? query.slice(1) : query;
  if (search.trim() === '') return null;
  const params = new URLSearchParams(search);
  const version = Number.parseInt(params.get('v') ?? '', 10);
  if (version !== SHARE_URL_VERSION) return null;

  // Only the codec's own keys are read; everything else (persona, credentials,
  // viewState keys, arbitrary junk) is ignored and reported.
  const codecKeys = new Set(['v', 'f', 'e', 's']);
  const ignoredKeys = [...params.keys()].filter((key) => !codecKeys.has(key));

  const filters = parseFilters(params.get('f') ?? '');

  let extent: MapExtent | null = null;
  const extentRaw = (params.get('e') ?? '').split(',').map((value) => Number.parseFloat(value));
  if (extentRaw.length === 4 && extentRaw.every((value) => Number.isFinite(value))) {
    extent = canonicalizeExtent({ west: extentRaw[0]!, south: extentRaw[1]!, east: extentRaw[2]!, north: extentRaw[3]! });
  }

  let selectedSiteId: string | null = null;
  let rejectedSiteId: string | null = null;
  const siteParam = params.get('s');
  if (siteParam !== null && siteParam.length > 0) {
    if (isShareableSiteId(siteParam)) selectedSiteId = siteParam;
    else rejectedSiteId = siteParam.length > 48 ? `${siteParam.slice(0, 48)}…` : siteParam;
  }

  return { version, filters: filters.filters, extent, selectedSiteId, rejectedSiteId, redactions: filters.redactions, unknownValues: filters.unknownValues, ignoredKeys };
}

// ---------------------------------------------------------------------------
// Resolve against what this session may see
// ---------------------------------------------------------------------------

/**
 * Apply a parsed share link against the public catalog the recipient's
 * session can actually see. An inaccessible selection is dropped (never kept
 * silently) with a clear notice; unknown filter vocabulary stays inspectable.
 * "A recipient receives only data their own current session can access."
 */
export function resolveShareUrl(parsed: ParsedShareUrl, publicSiteIds: readonly string[]): ResolvedShare {
  const notices: ShareNotice[] = [];
  for (const redaction of parsed.redactions) {
    notices.push({
      kind: 'filter-value-redacted',
      dimension: redaction.dimension,
      message: `One ${redaction.dimension} value in this link was removed (${redaction.reason}).`,
    });
  }
  for (const [dimension, values] of Object.entries(parsed.unknownValues) as [FilterDimensionKey, readonly string[]][]) {
    notices.push({
      kind: 'unknown-filter-value',
      dimension,
      message: `This link filters ${dimension} by ${values.length} value${values.length === 1 ? '' : 's'} the current vocabulary does not know (${values.join(', ')}); inspect them in the data dictionary. They match no sites.`,
    });
  }
  if (parsed.rejectedSiteId !== null) {
    notices.push({ kind: 'site-rejected', message: 'This link selected a site that is not shareable; the selection was removed.' });
  }
  let selectedSiteId = parsed.selectedSiteId;
  if (selectedSiteId !== null && !publicSiteIds.includes(selectedSiteId)) {
    notices.push({ kind: 'site-omitted', message: 'The shared link selects a site this view cannot access; it was omitted.' });
    selectedSiteId = null;
  }
  if (parsed.extent === null) {
    notices.push({ kind: 'extent-invalid', message: 'The shared map extent was not readable; the default extent was applied.' });
  }
  return {
    state: { filters: parsed.filters, extent: parsed.extent ?? defaultShareExtent(), selectedSiteId },
    notices,
  };
}

/** Convenience for tests: parse(serialize(x)) with the leading '?' supplied by the caller side. */
export function roundTripShareUrl(state: Readonly<Partial<DiscoveryShareState>>, options?: { readonly publicSiteIds?: readonly string[] }): ParsedShareUrl | null {
  return parseShareUrl(`?${buildShareUrl(state, options).url}`);
}

/** Re-export so shell wiring can classify unknown values without a second import. */
export { UNKNOWN_SENTINEL };
