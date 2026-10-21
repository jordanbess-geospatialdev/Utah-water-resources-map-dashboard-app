/**
 * Support/defect context bundles (WD-020; FR-018, anchored on FR-008).
 *
 * "A user can report a problem with a shareable state link; the steward
 * receives reproducible permitted context and can assign a priority without
 * embedding secrets or granting access to restricted records."
 *
 * The shareable part of the bundle is a MIRROR of the WD-007 versioned
 * share-URL codec (apps/web/src/features/discovery/shareUrl.ts - read-only
 * input for this task; the app package cannot be imported from the API
 * service, so the semantics are mirrored here and pinned byte-for-byte by
 * test/supportContext.test.ts against the WD-007 serialization contract):
 *
 * - Versioned `v=1`; parameters `f` (filters), `e` (extent, CRS84 4-decimal),
 *   `s` (selected site) ONLY. A query without a known version never parses.
 * - The persona, credentials, roles, entitlements and internal notes that a
 *   hostile view state may carry are never read on build and never emitted.
 * - The selected site must be a well-formed id inside the PUBLIC catalog;
 *   a restricted selection degrades to omitted-with-notice in the link,
 *   never a leak (tested with a hostile view state).
 * - Filter values are governed-identifier shaped only: free text and
 *   restricted identifiers are redacted with a reason; closed-enum
 *   dimensions reject non-members; over-cardinality lists shed values.
 * - Deterministic: registry-order serialization, sorted values, rounded
 *   extents; the emitted query is capped at MAX_SUPPORT_SHARE_LENGTH and
 *   sheds whole dimensions (last in registry order) with a notice.
 *
 * On top of the link, `buildSupportContext` adds the app version, an
 * ISO-8601 timestamp (injected clock) and a REDACTION PASS that asserts - on
 * every build - that the fully serialized bundle contains neither
 * secret-shaped strings nor identifiers of restricted objects. Findings
 * would be omitted-with-notice (defense in depth); by construction the
 * codec cannot produce one, and the hostile-state tests pin that.
 *
 * Pure Node module: fixtures in, bundle out. No DOM, no network, no clock.
 */
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Fixture world (read-only): public catalog + restricted identifier registry
// ---------------------------------------------------------------------------

interface FixtureStation {
  readonly id: string;
  readonly visibility: 'public' | 'restricted' | 'internal';
  readonly datastreams?: readonly { readonly id: string; readonly visibility: 'public' | 'restricted' | 'internal' }[];
}

export interface SupportWorld {
  /** Station ids in the public catalog (the only selectable/sharable sites). */
  readonly publicStationIds: readonly string[];
  /** Every identifier that must never appear in a support link or bundle. */
  readonly restrictedObjectIds: ReadonlySet<string>;
}

const FIXTURE_ROOT = '../../../../fixtures/contracts/';

/** Build the support view of the fixture world (frozen at module load). */
export function createSupportWorld(): SupportWorld {
  const stationsFile = JSON.parse(readFileSync(new URL(`${FIXTURE_ROOT}stations.json`, import.meta.url), 'utf8')) as { stations: readonly FixtureStation[] };
  const principalsFile = JSON.parse(readFileSync(new URL(`${FIXTURE_ROOT}principals.json`, import.meta.url), 'utf8')) as {
    users: readonly { readonly id: string }[];
    organizations: readonly { readonly id: string }[];
  };

  const publicStationIds: string[] = [];
  const restricted = new Set<string>();
  for (const station of stationsFile.stations) {
    if (station.visibility === 'public') publicStationIds.push(station.id);
    else restricted.add(station.id);
    for (const stream of station.datastreams ?? []) {
      if (stream.visibility !== 'public') restricted.add(stream.id);
    }
  }
  for (const user of principalsFile.users) restricted.add(user.id);
  for (const organization of principalsFile.organizations) restricted.add(organization.id);

  return Object.freeze({ publicStationIds: Object.freeze([...publicStationIds].sort()), restrictedObjectIds: restricted });
}

const defaultWorld = createSupportWorld();

// ---------------------------------------------------------------------------
// Mirror of the WD-007 codec constants and value rules
// ---------------------------------------------------------------------------

export const SUPPORT_SHARE_VERSION = 1;
export const MAX_SUPPORT_SHARE_LENGTH = 2048;
export const SUPPORT_EXTENT_DECIMALS = 4;
export const SUPPORT_MAX_VALUES_PER_DIMENSION = 48;

/** WD-007 FILTER_VALUE_PATTERN mirror: governed identifier shape only. */
export const SUPPORT_FILTER_VALUE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The WD-007 discovery dimension registry order (mirror of DISCOVERY_DIMENSIONS). */
export const SUPPORT_DIMENSION_KEYS = [
  'distributionSystemIds',
  'subgroupIds',
  'siteTypeIds',
  'telemetry',
  'providerIds',
  'observedPropertyIds',
  'controlStructureIds',
  'structureMaterialIds',
  'structureSizeIds',
  'waterSourceTypeIds',
  'measuringDeviceTypeIds',
  'measurementMethodTypeIds',
  'siteStatusIds',
  'timeStepIds',
  'processingLevels',
] as const;

export type SupportDimensionKey = (typeof SUPPORT_DIMENSION_KEYS)[number];

/** Closed contract-enum dimensions: values outside the enum are rejected (never "unknown"). */
const CLOSED_ENUMS: Readonly<Record<string, ReadonlySet<string>>> = {
  telemetry: new Set(['telemetered', 'manual', 'unknown']),
  siteStatusIds: new Set(['active', 'inactive', 'proposed']),
  processingLevels: new Set(['raw', 'provisional', 'reviewed', 'best-available']),
};

// ---------------------------------------------------------------------------
// View state input (deliberately tolerant: hostile fields exist and are ignored)
// ---------------------------------------------------------------------------

export interface MapExtent {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/**
 * The caller's current view state. `personaId`, `credential` and
 * `internalNote` exist on the type ON PURPOSE: a hostile or buggy caller can
 * supply them, and the mirror codec must still never read them. Filters are
 * loosely typed for the same reason - canonicalization rejects what must not
 * travel instead of trusting the caller's types.
 */
export interface SupportViewState {
  readonly filters?: Readonly<Record<string, readonly unknown[] | unknown>>;
  readonly extent?: Readonly<MapExtent> | null;
  readonly selectedSiteId?: string | null;
  readonly personaId?: string | null;
  readonly credential?: string | null;
  readonly internalNote?: string | null;
}

export type SupportNoticeKind =
  | 'filter-value-redacted'
  | 'filters-dropped-for-length'
  | 'site-omitted'
  | 'site-rejected'
  | 'extent-invalid'
  | 'origin-ignored'
  | 'bundle-redacted';

export interface SupportNotice {
  readonly kind: SupportNoticeKind;
  /** Human-facing; never echoes restricted identifiers, free text or secrets. */
  readonly message: string;
  readonly dimension?: SupportDimensionKey;
}

// ---------------------------------------------------------------------------
// Extent handling (WD-007 mirror)
// ---------------------------------------------------------------------------

function round4(value: number): number {
  return Math.round(value * 10 ** SUPPORT_EXTENT_DECIMALS) / 10 ** SUPPORT_EXTENT_DECIMALS || 0;
}

export function canonicalizeSupportExtent(extent: Readonly<MapExtent> | null | undefined): MapExtent | null {
  if (!extent) return null;
  const { west, south, east, north } = extent;
  const finite = [west, south, east, north].every((value) => typeof value === 'number' && Number.isFinite(value));
  if (!finite || west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return null;
  const rounded: MapExtent = { west: round4(west), south: round4(south), east: round4(east), north: round4(north) };
  return rounded.west < rounded.east && rounded.south < rounded.north ? rounded : null;
}

/** Default extent: the public catalog bounds padded (a bare link still frames the data). */
export function defaultSupportExtent(world: SupportWorld = defaultWorld): MapExtent {
  const stationsFile = JSON.parse(readFileSync(new URL(`${FIXTURE_ROOT}stations.json`, import.meta.url), 'utf8')) as {
    stations: readonly { readonly id: string; readonly visibility: string; readonly longitude: number; readonly latitude: number }[];
  };
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const station of stationsFile.stations) {
    if (!world.publicStationIds.includes(station.id)) continue;
    west = Math.min(west, station.longitude);
    east = Math.max(east, station.longitude);
    south = Math.min(south, station.latitude);
    north = Math.max(north, station.latitude);
  }
  const pad = 0.35;
  const candidate: MapExtent = { west: west - pad, south: south - pad, east: east + pad, north: north + pad };
  const canonical = canonicalizeSupportExtent(candidate);
  if (canonical) return canonical;
  // Numeric-latitude fixture stations south of the pole pad: clamp, never throw.
  return { west: Math.max(-180, candidate.west), south: Math.max(-90, candidate.south), east: Math.min(180, candidate.east), north: Math.min(90, candidate.north) };
}

// ---------------------------------------------------------------------------
// Secret-shape detection (the redaction pass)
// ---------------------------------------------------------------------------

/**
 * Secret-shaped string patterns the bundle must never contain: scoped-token
 * prefixes (the WD-016 `uwdat_` credential family), Bearer/JWT/AWS key
 * shapes, private-key blocks, long hex/base64 runs, and labeled secret
 * assignments. Deliberately broad: a false positive degrades to a notice,
 * a false negative would ship a secret.
 */
const SECRET_SHAPES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'scoped-token', pattern: /\buwdat_[a-z0-9_]{8,}\b/i },
  { name: 'bearer-token', pattern: /\bbearer\s+[a-z0-9._~+/=-]{8,}/i },
  { name: 'jwt', pattern: /\bey[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{5,}\b/i },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'hex-secret', pattern: /\b[a-f0-9]{32,}\b/i },
  { name: 'base64-secret', pattern: /\b[A-Za-z0-9+/]{40,}={0,2}={2,}\b/ },
  { name: 'labeled-secret', pattern: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*\S+/i },
];

export interface SecretFinding {
  readonly shape: string;
  /** Where the finding appeared (field path), never the matched text itself. */
  readonly field: string;
}

/** Scan any value's string leaves for secret shapes. Returns findings; never echoes content. */
export function scanForSecretShapes(value: unknown, field = 'bundle'): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  const visit = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      for (const shape of SECRET_SHAPES) {
        if (shape.pattern.test(node)) findings.push({ shape: shape.name, field: path });
      }
    } else if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${path}[${index}]`));
    } else if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) visit(child, `${path}.${key}`);
    }
  };
  visit(value, field);
  return findings;
}

/** Restricted identifiers must never appear as free-standing tokens anywhere in the bundle. */
export function scanForRestrictedIds(haystack: string, world: SupportWorld = defaultWorld): readonly string[] {
  const found: string[] = [];
  for (const id of world.restrictedObjectIds) {
    if (haystack.includes(id)) found.push(id);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Canonicalize + serialize filters (WD-007 mirror, build side)
// ---------------------------------------------------------------------------

export type SupportRedactionReason = 'free-text' | 'restricted-identifier' | 'not-enum-member' | 'cardinality' | 'malformed-dimension';

export interface SupportFilterRedaction {
  readonly dimension: SupportDimensionKey;
  /** Truncated preview of the rejected value - never the full hostile payload. */
  readonly value: string;
  readonly reason: SupportRedactionReason;
}

export interface CanonicalSupportFilters {
  readonly filters: Readonly<Record<SupportDimensionKey, readonly string[]>>;
  readonly redactions: readonly SupportFilterRedaction[];
  readonly ignoredKeys: readonly string[];
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

function valueVerdict(dimension: string, value: string, world: SupportWorld): 'keep' | 'free-text' | 'restricted-identifier' | 'not-enum-member' {
  if (typeof value !== 'string' || !SUPPORT_FILTER_VALUE_PATTERN.test(value)) return 'free-text';
  if (world.restrictedObjectIds.has(value)) return 'restricted-identifier';
  const closed = CLOSED_ENUMS[dimension];
  if (closed && !closed.has(value)) return 'not-enum-member';
  return 'keep'; // known and unknown-but-well-formed both travel (FR-060 inspectability)
}

export function canonicalizeSupportFilters(
  input: Readonly<Record<string, readonly unknown[] | unknown>> | null | undefined,
  world: SupportWorld = defaultWorld,
): CanonicalSupportFilters {
  const filters: Record<string, string[]> = {};
  const redactions: SupportFilterRedaction[] = [];
  const source = (input ?? {}) as Record<string, unknown>;
  const known = new Set<string>(SUPPORT_DIMENSION_KEYS);
  const ignoredKeys = Object.keys(source).filter((key) => !known.has(key));

  for (const dimension of SUPPORT_DIMENSION_KEYS) {
    const raw = source[dimension];
    if (raw === undefined || raw === null) continue;
    if (!Array.isArray(raw)) {
      redactions.push({ dimension, value: preview(raw), reason: 'malformed-dimension' });
      continue;
    }
    const unique = [...new Set(raw.map((value) => (typeof value === 'string' ? value : preview(value))))].sort();
    const kept: string[] = [];
    for (const value of unique) {
      if (kept.length >= SUPPORT_MAX_VALUES_PER_DIMENSION) {
        redactions.push({ dimension, value: preview(value), reason: 'cardinality' });
        continue;
      }
      const verdict = typeof value === 'string' && !raw.includes(value) ? 'free-text' : valueVerdict(dimension, value, world);
      if (verdict === 'keep') {
        kept.push(value as string);
      } else {
        redactions.push({ dimension, value: preview(value), reason: verdict });
      }
    }
    if (kept.length > 0) filters[dimension] = kept;
  }
  return { filters: filters as Record<SupportDimensionKey, readonly string[]>, redactions, ignoredKeys };
}

/** Stable compact serialization `dim=a,b;dim2=c` in registry order (WD-007 format). */
export function serializeSupportFilters(filters: Readonly<Record<string, readonly string[]>>): string {
  const parts: string[] = [];
  for (const dimension of SUPPORT_DIMENSION_KEYS) {
    const values = filters[dimension];
    if (!values || values.length === 0) continue;
    parts.push(`${dimension}=${[...new Set(values)].sort().join(',')}`);
  }
  return parts.join(';');
}

// ---------------------------------------------------------------------------
// Build the share query (WD-007 mirror)
// ---------------------------------------------------------------------------

function isShareableSiteId(siteId: string, world: SupportWorld): boolean {
  return SUPPORT_FILTER_VALUE_PATTERN.test(siteId) && !world.restrictedObjectIds.has(siteId);
}

function encodeQuery(version: number, filterSerialization: string, extent: MapExtent | null, siteId: string | null): string {
  const params = new URLSearchParams();
  params.set('v', String(version));
  if (filterSerialization !== '') params.set('f', filterSerialization);
  if (extent) {
    params.set(
      'e',
      `${extent.west.toFixed(SUPPORT_EXTENT_DECIMALS)},${extent.south.toFixed(SUPPORT_EXTENT_DECIMALS)},${extent.east.toFixed(SUPPORT_EXTENT_DECIMALS)},${extent.north.toFixed(SUPPORT_EXTENT_DECIMALS)}`,
    );
  }
  if (siteId !== null) params.set('s', siteId);
  return params.toString();
}

// ---------------------------------------------------------------------------
// The support context bundle
// ---------------------------------------------------------------------------

/** Application version reported in the bundle (source: repo root package.json). */
export const SUPPORT_APP_VERSION = '0.1.0';

/** Version of the support context bundle shape itself. */
export const SUPPORT_CONTEXT_VERSION = 1;

export interface SupportContextBundle {
  readonly contextVersion: 1;
  readonly appVersion: string;
  /** ISO-8601 instant from the injected clock. */
  readonly generatedAt: string;
  /** Versioned share query (no leading '?'), reproducible by the WD-007 codec. */
  readonly shareQuery: string;
  /** Absolute link when an origin was supplied; the query alone otherwise. */
  readonly shareUrl: string;
  /** Everything removed from the view state before it became a link, with reasons. */
  readonly notices: readonly SupportNotice[];
  /** Redaction-pass verdict over the fully serialized bundle. */
  readonly redaction: {
    readonly secretScan: 'clean' | 'findings';
    readonly restrictedIdScan: 'clean' | 'findings';
    /** Present only when a scan found something (defense in depth; pinned clean by tests). */
    readonly findings?: readonly string[];
  };
}

export interface BuildSupportContextInput {
  readonly viewState: Readonly<SupportViewState>;
  /** Injected clock (Date or preformatted ISO instant). Tests pass constants. */
  readonly now: Date | string;
  readonly world?: SupportWorld;
  /** Optional link origin; must be https and bare (no path/query), or it is ignored with a notice. */
  readonly origin?: string | null;
}

function sanitizeOrigin(origin: string | null | undefined, notices: SupportNotice[]): string {
  if (!origin) return '';
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'https:' && parsed.pathname === '/' && parsed.search === '' && parsed.hash === '') {
      return origin.endsWith('/') ? origin.slice(0, -1) : origin;
    }
  } catch {
    // fall through to the notice
  }
  notices.push({ kind: 'origin-ignored', message: 'The supplied link origin was not usable; the support context carries the query only.' });
  return '';
}

/**
 * Build the support/defect context bundle from the current view state.
 *
 * Order of operations: canonicalize (rejecting everything that must not
 * travel), serialize the versioned query, then run the redaction pass over
 * the SERIALIZED bundle and fold any finding into an omitted-with-notice
 * verdict. The hostile-state tests pin that a restricted selection, hostile
 * free text, credentials and internal notes all degrade to notices while the
 * shipped link stays reproducible and clean.
 */
export function buildSupportContext(input: BuildSupportContextInput): SupportContextBundle {
  const world = input.world ?? defaultWorld;
  const notices: SupportNotice[] = [];
  const { viewState } = input;

  // Persona, credentials and internal notes are NEVER read here - the type
  // admits them so hostile callers cannot crash the build; the codec simply
  // has no code path that consults them.
  void viewState.personaId;
  void viewState.credential;
  void viewState.internalNote;

  const canonical = canonicalizeSupportFilters(viewState.filters as Record<string, readonly unknown[]> | undefined, world);
  for (const redaction of canonical.redactions) {
    notices.push({
      kind: 'filter-value-redacted',
      dimension: redaction.dimension,
      message: `One ${redaction.dimension} value was removed from the support link (${redaction.reason}); links carry governed identifiers only.`,
    });
  }
  let filters = { ...canonical.filters } as Record<string, readonly string[]>;

  const canonicalExtent = canonicalizeSupportExtent(viewState.extent);
  const extent = canonicalExtent ?? defaultSupportExtent(world);
  if (viewState.extent !== undefined && viewState.extent !== null && canonicalExtent === null) {
    notices.push({ kind: 'extent-invalid', message: 'The map extent was not shareable; the default extent was used.' });
  }

  let selectedSiteId: string | null = null;
  if (typeof viewState.selectedSiteId === 'string' && viewState.selectedSiteId.length > 0) {
    const candidate = viewState.selectedSiteId;
    if (!isShareableSiteId(candidate, world)) {
      notices.push({ kind: 'site-rejected', message: 'The selected site is not shareable; it was left out of the link.' });
    } else if (!world.publicStationIds.includes(candidate)) {
      notices.push({ kind: 'site-omitted', message: 'The selected site is not part of the public catalog; it was left out of the link.' });
    } else {
      selectedSiteId = candidate;
    }
  }

  let query = encodeQuery(SUPPORT_SHARE_VERSION, serializeSupportFilters(filters), extent, selectedSiteId);
  while (query.length > MAX_SUPPORT_SHARE_LENGTH) {
    const lastDimension = [...SUPPORT_DIMENSION_KEYS].reverse().find((dimension) => filters[dimension] && filters[dimension]!.length > 0);
    if (!lastDimension) break;
    const reduced: Record<string, readonly string[]> = {};
    for (const dimension of SUPPORT_DIMENSION_KEYS) {
      if (dimension !== lastDimension && filters[dimension] && filters[dimension]!.length > 0) reduced[dimension] = filters[dimension]!;
    }
    filters = reduced;
    notices.push({ kind: 'filters-dropped-for-length', dimension: lastDimension, message: `The ${lastDimension} filter was dropped to keep the link usable.` });
    query = encodeQuery(SUPPORT_SHARE_VERSION, serializeSupportFilters(filters), extent, selectedSiteId);
  }

  const generatedAt = typeof input.now === 'string' ? input.now : new Date(input.now.getTime()).toISOString();
  const origin = sanitizeOrigin(input.origin ?? null, notices);

  let bundle: SupportContextBundle = {
    contextVersion: SUPPORT_CONTEXT_VERSION,
    appVersion: SUPPORT_APP_VERSION,
    generatedAt,
    shareQuery: query,
    shareUrl: origin ? `${origin}/?${query}` : query,
    notices,
    redaction: { secretScan: 'clean', restrictedIdScan: 'clean' },
  };

  // Redaction pass over the SERIALIZED bundle (defense in depth).
  const secretFindings = scanForSecretShapes(bundle, 'context');
  const restrictedFindings = scanForRestrictedIds(JSON.stringify(bundle), world);
  if (secretFindings.length > 0 || restrictedFindings.length > 0) {
    bundle = {
      ...bundle,
      shareQuery: '',
      shareUrl: '',
      notices: [
        ...notices,
        {
          kind: 'bundle-redacted',
          message: 'The support context was redacted: it contained data shaped like a secret or a restricted object; only the app version and timestamp ship.',
        },
      ],
      redaction: {
        secretScan: secretFindings.length > 0 ? 'findings' : 'clean',
        restrictedIdScan: restrictedFindings.length > 0 ? 'findings' : 'clean',
        findings: [...secretFindings.map((finding) => `secret:${finding.shape}:${finding.field}`), ...restrictedFindings.map((id) => `restricted-id:${id}`)],
      },
    };
  }
  return bundle;
}

// ---------------------------------------------------------------------------
// Steward-side decode (parse + resolve a support link against the public catalog)
// ---------------------------------------------------------------------------

export interface DecodedSupportShare {
  readonly version: number;
  readonly filters: Readonly<Record<SupportDimensionKey, readonly string[]>>;
  readonly redactions: readonly SupportFilterRedaction[];
  readonly extent: MapExtent | null;
  readonly selectedSiteId: string | null;
  readonly rejectedSiteId: string | null;
  readonly ignoredKeys: readonly string[];
  readonly notices: readonly SupportNotice[];
}

/** Parse a support share query ('?' optional). Null for missing/unknown versions - never a guess. */
export function decodeSupportShare(query: string, world: SupportWorld = defaultWorld): DecodedSupportShare | null {
  const search = query.startsWith('?') ? query.slice(1) : query;
  if (search.trim() === '') return null;
  const params = new URLSearchParams(search);
  const version = Number.parseInt(params.get('v') ?? '', 10);
  if (version !== SUPPORT_SHARE_VERSION) return null;

  const codecKeys = new Set(['v', 'f', 'e', 's']);
  const ignoredKeys = [...params.keys()].filter((key) => !codecKeys.has(key));

  const parsed: Record<string, string[]> = {};
  const raw = params.get('f') ?? '';
  if (raw.trim() !== '') {
    for (const part of raw.split(';')) {
      const separator = part.indexOf('=');
      if (separator <= 0) continue;
      const key = part.slice(0, separator);
      const values = part.slice(separator + 1).split(',').map((value) => value.trim()).filter((value) => value.length > 0);
      if (values.length === 0) continue;
      parsed[key] = (parsed[key] ?? []).concat(values);
    }
  }
  const canonical = canonicalizeSupportFilters(parsed, world);

  let extent: MapExtent | null = null;
  const extentRaw = (params.get('e') ?? '').split(',').map((value) => Number.parseFloat(value));
  if (extentRaw.length === 4 && extentRaw.every((value) => Number.isFinite(value))) {
    extent = canonicalizeSupportExtent({ west: extentRaw[0]!, south: extentRaw[1]!, east: extentRaw[2]!, north: extentRaw[3]! });
  }

  let selectedSiteId: string | null = null;
  let rejectedSiteId: string | null = null;
  const siteParam = params.get('s');
  if (siteParam !== null && siteParam.length > 0) {
    if (isShareableSiteId(siteParam, world) && world.publicStationIds.includes(siteParam)) selectedSiteId = siteParam;
    else rejectedSiteId = siteParam.length > 48 ? `${siteParam.slice(0, 48)}…` : siteParam;
  }

  const notices: SupportNotice[] = canonical.redactions.map((redaction) => ({
    kind: 'filter-value-redacted' as const,
    dimension: redaction.dimension,
    message: `One ${redaction.dimension} value in this link was removed (${redaction.reason}).`,
  }));
  if (rejectedSiteId !== null) {
    notices.push({ kind: 'site-rejected', message: 'This link selected a site that is not shareable; the selection was removed.' });
  } else if (selectedSiteId !== null && !world.publicStationIds.includes(selectedSiteId)) {
    notices.push({ kind: 'site-omitted', message: 'The shared link selects a site outside the public catalog; it was omitted.' });
    selectedSiteId = null;
  }
  if (extent === null) {
    notices.push({ kind: 'extent-invalid', message: 'The shared map extent was not readable; the default extent applies.' });
  }

  return {
    version,
    filters: canonical.filters,
    redactions: canonical.redactions,
    extent,
    selectedSiteId,
    rejectedSiteId,
    ignoredKeys,
    notices,
  };
}
