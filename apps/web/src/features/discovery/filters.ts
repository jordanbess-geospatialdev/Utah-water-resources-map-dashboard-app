/**
 * The typed public discovery FilterSet (FR-001, FR-002, FR-008).
 *
 * One typed filter object governs account-free discovery over the fixture
 * world, following packages/contracts/schemas/filter-set.json:
 *
 * - AND across dimensions, OR within a dimension.
 * - An ABSENT key means "no constraint on this dimension"; the sentinel value
 *   "unknown" inside a multi-value array explicitly selects records whose
 *   value for that dimension is unknown or unset. These are different queries
 *   and are never collapsed (telemetry: ["telemetered"] vs telemetry omitted
 *   vs telemetry: ["unknown"]).
 * - Multi-value arrays canonicalize to a stable order (deduplicated, sorted
 *   by code point, empty arrays omitted), so serialization is byte-stable.
 * - Values are governed identifiers only. Free text and identifiers of
 *   restricted objects are REJECTED/REDACTED, never serialized (FR-008: no
 *   free text, no ids of restricted objects in links). Well-formed values the
 *   current vocabulary does not know stay INSPECTABLE as "unknown" — visible
 *   in chips and the data dictionary (FR-060), distinguishable from known
 *   values — rather than being silently dropped.
 *
 * Dimension coverage vs the 20+4 contract dimensions (technical
 * specification, "Filters and sharing"): this registry carries the dimensions
 * the fixture world governs at seed utah-water-fixture-v1. Dimensions
 * declared in the schema but carrying no governed fixture values (system
 * groups, control structure/material/size, measuring device types — device
 * deployments only carry free-text models — observation types, date ranges,
 * statistic, seasonality, ...) are present as typed keys so links survive
 * steward vocabulary growth, are documented "ungoverned at v0.1.0", and match
 * nothing until the steward publishes values for them.
 *
 * Pure module: fixtures in, verdicts out. No React, no DOM, no clock.
 */
import { observations, organizations, providers, revisions, stations, subgroups, systems, users, vocabulary } from '../../shell/data/fixtures';
import type { StationRecord, TelemetryKind } from '../../shell/data/types';

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

/** Contract enum (filter-set.json dimension 5): tri-state, "unknown" is a real value, not a missing one. */
export type TelemetryFilterValue = TelemetryKind;
/** Contract enum (filter-set.json dimension 16). */
export type SiteStatusFilterValue = 'active' | 'inactive' | 'proposed';
/** Contract enum (filter-set.json, persona addition) — also the governed vocabulary list. */
export type ProcessingLevelValue = 'raw' | 'provisional' | 'reviewed' | 'best-available';

/**
 * The public discovery FilterSet. Every key is optional; absent = no
 * constraint. Arrays are OR within the dimension; dimensions AND together.
 */
export interface DiscoveryFilterSet {
  /** Dimension 1: distribution systems (governed registry: fixtures systems.json kind "system"). */
  distributionSystemIds?: readonly string[];
  /** Dimension 3: subgroups within a system (governed registry). Dimension 2 (system groups) has no governed records at v0.1.0. */
  subgroupIds?: readonly string[];
  /** Dimension 4: site types (facet derived from the public catalog). */
  siteTypeIds?: readonly string[];
  /** Dimension 5: telemetry tri-state. ["unknown"] differs from an absent key. */
  telemetry?: readonly TelemetryFilterValue[];
  /** Dimension 6: data providers (governed registry). */
  providerIds?: readonly string[];
  /** Dimension 7: observed properties (governed vocabulary; internal-diagnostic properties select nothing publicly). */
  observedPropertyIds?: readonly string[];
  /** Dimension 8: control structures — declared, ungoverned at v0.1.0. */
  controlStructureIds?: readonly string[];
  /** Dimension 9: structure materials — declared, ungoverned at v0.1.0. */
  structureMaterialIds?: readonly string[];
  /** Dimension 10: structure size classes — declared, ungoverned at v0.1.0. */
  structureSizeIds?: readonly string[];
  /** Dimension 11: water source types (facet derived from the public catalog). */
  waterSourceTypeIds?: readonly string[];
  /** Dimension 12: measuring device types — declared, ungoverned at v0.1.0 (device deployments carry free-text models, not governed type ids). */
  measuringDeviceTypeIds?: readonly string[];
  /** Dimension 13: measurement method types (facet derived from public streams). */
  measurementMethodTypeIds?: readonly string[];
  /** Dimension 16: site status (contract enum). */
  siteStatusIds?: readonly SiteStatusFilterValue[];
  /** Dimension 18: time steps, derived deterministically from public stream cadences. */
  timeStepIds?: readonly string[];
  /** Persona addition: processing levels (governed vocabulary; derived from public observations and revisions). */
  processingLevels?: readonly ProcessingLevelValue[];
}

export type FilterDimensionKey = keyof DiscoveryFilterSet;

/** A governed value offered by a dimension (id + presentation metadata). */
export interface FacetValue {
  readonly id: string;
  readonly label: string;
  /** Extra presentation note (e.g. why a known value selects nothing publicly). */
  readonly note?: string;
}

/** How the dimension's values are governed at the current seed. */
export type DimensionGovernance =
  /** Closed enum from the contract schema / governed vocabulary registry. */
  | 'contract-enum'
  /** Governed registry in the fixture world (systems, subgroups, providers, observed properties). */
  | 'governed-registry'
  /** Derived facet: values actually carried by the public catalog (may be empty at zero count). */
  | 'public-facet'
  /** Declared in the schema, no governed fixture values yet: any concrete value matches nothing. */
  | 'ungoverned';

export interface FilterDimension {
  readonly key: FilterDimensionKey;
  readonly label: string;
  /** Short semantics note for the filter UI and the data dictionary. */
  readonly help: string;
  readonly governance: DimensionGovernance;
  readonly values: readonly FacetValue[];
}

/** The sentinel from filter-set.json: selects records whose value is unknown or unset. */
export const UNKNOWN_SENTINEL = 'unknown';

/** Governed identifier shape: lowercase kebab (plus digits), 1-64 characters. Free text never matches this. */
export const FILTER_VALUE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Upper bound on values per dimension in a canonical set; excess is redacted, not truncated silently. */
export const MAX_VALUES_PER_DIMENSION = 48;

const TELEMETRY_VALUES: readonly TelemetryFilterValue[] = ['telemetered', 'manual', 'unknown'];
const SITE_STATUS_VALUES: readonly SiteStatusFilterValue[] = ['active', 'inactive', 'proposed'];
const PROCESSING_LEVEL_VALUES: readonly ProcessingLevelValue[] = ['raw', 'provisional', 'reviewed', 'best-available'];

/** Deterministic time-step derivation from a stream cadence (dimension 18 has no registry at v0.1.0). */
const TIME_STEP_BY_CADENCE: Readonly<Record<number, string>> = {
  15: 'fifteen-minute',
  60: 'hourly',
  1440: 'daily',
  10080: 'weekly',
};

export function timeStepIdForCadence(cadenceMinutes: number): string {
  if (!Number.isFinite(cadenceMinutes) || cadenceMinutes <= 0) return 'irregular';
  return TIME_STEP_BY_CADENCE[cadenceMinutes] ?? `every-${cadenceMinutes}-minutes`;
}

function timeStepLabel(cadenceMinutes: number): string {
  const id = timeStepIdForCadence(cadenceMinutes);
  return cadenceMinutes > 0 && Number.isFinite(cadenceMinutes)
    ? `${id[0]!.toUpperCase()}${id.slice(1)} (every ${cadenceMinutes} minutes)`
    : 'Irregular';
}

function prettifyId(id: string): string {
  return id
    .split('-')
    .map((word) => (word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Public catalog + restricted identifiers (derived once from the fixtures)
// ---------------------------------------------------------------------------

/** Stations any anonymous visitor may see: the PUBLIC projection row set (WD-006 projection semantics). */
export const publicDiscoveryStations: readonly StationRecord[] = stations.filter((station) => station.visibility === 'public');

/** Only public streams of a station feed discovery facets and matching (restricted/internal streams never do). */
function publicStreams(station: StationRecord) {
  return station.datastreams.filter((stream) => stream.visibility === 'public');
}

/**
 * Identifiers of restricted objects. These never appear as filter values:
 * restricted/internal stations and their restricted streams, principals,
 * organizations. Selecting them in a link is a leak attempt, so they are
 * rejected with an explicit redaction reason rather than kept as "unknown".
 */
export const RESTRICTED_OBJECT_IDS: ReadonlySet<string> = new Set<string>([
  ...stations.filter((station) => station.visibility !== 'public').flatMap((station) => [station.id, ...station.datastreams.filter((stream) => stream.visibility !== 'public').map((stream) => stream.id)]),
  ...users.map((user) => user.id),
  ...organizations.map((organization) => organization.id),
]);

// ---------------------------------------------------------------------------
// Per-station derived facets
// ---------------------------------------------------------------------------

/** Processing levels a station's public data actually reaches: raw from observations, others from revisions. */
export function processingLevelsForStation(station: StationRecord): readonly ProcessingLevelValue[] {
  const publicStreamIds = new Set(publicStreams(station).map((stream) => stream.id));
  if (publicStreamIds.size === 0) return [];
  const levels = new Set<ProcessingLevelValue>();
  for (const observation of observations) {
    if (!publicStreamIds.has(observation.streamId)) continue;
    levels.add('raw');
  }
  for (const revision of revisions) {
    const observation = observations.find((candidate) => candidate.id === revision.targetObservationId);
    if (observation && publicStreamIds.has(observation.streamId)) levels.add(revision.processingLevel);
  }
  return [...levels].sort();
}

/** The value(s) a station carries for a dimension, from PUBLIC data only. Empty array = carries none. */
export function stationDimensionValues(station: StationRecord, key: FilterDimensionKey): readonly string[] {
  switch (key) {
    case 'distributionSystemIds':
      return [station.systemId];
    case 'subgroupIds':
      return station.subgroupIds;
    case 'siteTypeIds':
      return [station.siteTypeId];
    case 'telemetry':
      return [station.telemetry];
    case 'providerIds':
      return [station.providerId];
    case 'observedPropertyIds':
      return publicStreams(station).map((stream) => stream.observedPropertyId);
    case 'controlStructureIds':
    case 'structureMaterialIds':
    case 'structureSizeIds':
    case 'measuringDeviceTypeIds':
      return []; // declared dimensions, no governed fixture field at v0.1.0
    case 'waterSourceTypeIds':
      return [station.waterSourceTypeId];
    case 'measurementMethodTypeIds':
      return publicStreams(station).map((stream) => stream.methodTypeId);
    case 'siteStatusIds':
      return [station.status];
    case 'timeStepIds':
      return publicStreams(station).map((stream) => timeStepIdForCadence(stream.cadenceMinutes));
    case 'processingLevels':
      return processingLevelsForStation(station);
  }
}

/** True when the station's value for the dimension is unknown/unset (the filter-set.json sentinel meaning). */
export function stationDimensionIsUnset(station: StationRecord, key: FilterDimensionKey): boolean {
  switch (key) {
    case 'subgroupIds':
      return station.subgroupIds.length === 0;
    case 'telemetry':
      return station.telemetry === 'unknown';
    case 'controlStructureIds':
    case 'structureMaterialIds':
    case 'structureSizeIds':
    case 'measuringDeviceTypeIds':
      return true; // no fixture field exists: unknown/unset for every record
    case 'processingLevels':
      return processingLevelsForStation(station).length === 0;
    default:
      return false; // dimensions the fixture world always carries a value for
  }
}

// ---------------------------------------------------------------------------
// The dimension registry
// ---------------------------------------------------------------------------

function facetFromCatalog(key: FilterDimensionKey, labeler?: (id: string) => string): FacetValue[] {
  const seen = new Map<string, FacetValue>();
  for (const station of publicDiscoveryStations) {
    for (const value of stationDimensionValues(station, key)) {
      if (value === UNKNOWN_SENTINEL || seen.has(value)) continue;
      seen.set(value, { id: value, label: labeler ? labeler(value) : prettifyId(value) });
    }
  }
  return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function observedPropertyFacet(): FacetValue[] {
  return [...vocabulary.observedProperties]
    .map((property) => ({
      id: property.id,
      label: property.name,
      note:
        property.id === 'voltage'
          ? 'Internal diagnostic property — governed vocabulary, but no public stream carries it; selects nothing on the public map.'
          : property.description,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function enumFacet<T extends string>(values: readonly T[], labels: Readonly<Record<T, string>>, notes?: Partial<Record<T, string>>): FacetValue[] {
  return values.map((value) => ({ id: value, label: labels[value], ...(notes?.[value] ? { note: notes[value] } : {}) }));
}

/**
 * The discovery dimension registry in canonical (schema) order. Serialization
 * walks this order; the UI walks it for labeled groups.
 */
export const DISCOVERY_DIMENSIONS: readonly FilterDimension[] = [
  {
    key: 'distributionSystemIds',
    label: 'Distribution system',
    help: 'OR within systems, AND against other dimensions. Systems with no public stations stay selectable and simply match nothing.',
    governance: 'governed-registry',
    values: systems
      .filter((system) => system.kind === 'system')
      .map((system) => ({ id: system.id, label: system.name }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  },
  {
    key: 'subgroupIds',
    label: 'System subgroup',
    help: 'Subgroups within a distribution system. "Unknown" selects stations with no subgroup assignment — that is different from leaving the filter unset.',
    governance: 'governed-registry',
    values: subgroups.map((subgroup) => ({ id: subgroup.id, label: subgroup.name })).sort((a, b) => (a.id < b.id ? -1 : 1)),
  },
  {
    key: 'siteTypeIds',
    label: 'Site type',
    help: 'Measurement site classification (flume, weir, natural channel, ...).',
    governance: 'public-facet',
    values: facetFromCatalog('siteTypeIds'),
  },
  {
    key: 'telemetry',
    label: 'Telemetry',
    help: 'Tri-state: telemetered, manual (no telemetry) or unknown (status not established). "Unknown" is a real selection; an unset filter means no constraint.',
    governance: 'contract-enum',
    values: enumFacet<TelemetryFilterValue>(
      TELEMETRY_VALUES,
      { telemetered: 'Telemetered', manual: 'Manual (no telemetry)', unknown: 'Unknown (not established)' },
      { unknown: 'Distinct from leaving this filter unset: it selects stations whose telemetry status is not established.' },
    ),
  },
  {
    key: 'providerIds',
    label: 'Data provider',
    help: 'Telemetry network or manual measurement program supplying the data.',
    governance: 'governed-registry',
    values: providers.map((provider) => ({ id: provider.id, label: provider.name })).sort((a, b) => (a.id < b.id ? -1 : 1)),
  },
  {
    key: 'observedPropertyIds',
    label: 'Observed property',
    help: 'Flow, level and equipment properties are distinct dimensions and are never converted into one another.',
    governance: 'governed-registry',
    values: observedPropertyFacet(),
  },
  {
    key: 'controlStructureIds',
    label: 'Control structure',
    help: 'Declared in the contract, not yet governed by the steward vocabulary at seed v0.1.0. Only "Unknown" (unset) matches today.',
    governance: 'ungoverned',
    values: [],
  },
  {
    key: 'structureMaterialIds',
    label: 'Structure material',
    help: 'Declared in the contract, not yet governed by the steward vocabulary at seed v0.1.0. Only "Unknown" (unset) matches today.',
    governance: 'ungoverned',
    values: [],
  },
  {
    key: 'structureSizeIds',
    label: 'Structure size class',
    help: 'Declared in the contract, not yet governed by the steward vocabulary at seed v0.1.0. Only "Unknown" (unset) matches today.',
    governance: 'ungoverned',
    values: [],
  },
  {
    key: 'waterSourceTypeIds',
    label: 'Water source',
    help: 'Surface natural flow, storage release and similar source classifications.',
    governance: 'public-facet',
    values: facetFromCatalog('waterSourceTypeIds'),
  },
  {
    key: 'measuringDeviceTypeIds',
    label: 'Measuring device type',
    help: 'Declared in the contract, not yet governed at seed v0.1.0: device deployments carry free-text models, not governed type ids. Free text is never a filter value.',
    governance: 'ungoverned',
    values: [],
  },
  {
    key: 'measurementMethodTypeIds',
    label: 'Measurement method',
    help: 'Rating, current meter, pressure transducer and similar governed method types (public streams only).',
    governance: 'public-facet',
    values: facetFromCatalog('measurementMethodTypeIds'),
  },
  {
    key: 'siteStatusIds',
    label: 'Site status',
    help: 'Active, inactive or proposed sites.',
    governance: 'contract-enum',
    values: enumFacet<SiteStatusFilterValue>(SITE_STATUS_VALUES, { active: 'Active', inactive: 'Inactive', proposed: 'Proposed' }),
  },
  {
    key: 'timeStepIds',
    label: 'Time step',
    help: 'Derived deterministically from public stream cadences (60 minutes → hourly, 10080 → weekly, ...).',
    governance: 'public-facet',
    values: (() => {
      const cadences = new Set<number>();
      for (const station of publicDiscoveryStations) {
        for (const stream of publicStreams(station)) cadences.add(stream.cadenceMinutes);
      }
      return [...cadences]
        .sort((a, b) => a - b)
        .map((cadence) => ({ id: timeStepIdForCadence(cadence), label: timeStepLabel(cadence) }));
    })(),
  },
  {
    key: 'processingLevels',
    label: 'Processing level',
    help: 'Raw from observations; provisional, reviewed and best-available from the revision chain.',
    governance: 'contract-enum',
    values: enumFacet<ProcessingLevelValue>(
      PROCESSING_LEVEL_VALUES,
      Object.fromEntries(vocabulary.processingLevels.map((level) => [level.id, level.name])) as Readonly<Record<ProcessingLevelValue, string>>,
      Object.fromEntries(vocabulary.processingLevels.map((level) => [level.id, level.description])) as Partial<Record<ProcessingLevelValue, string>>,
    ),
  },
];

export const DISCOVERY_DIMENSION_KEYS: readonly FilterDimensionKey[] = DISCOVERY_DIMENSIONS.map((dimension) => dimension.key);

export function dimensionByKey(key: FilterDimensionKey): FilterDimension {
  const dimension = DISCOVERY_DIMENSIONS.find((candidate) => candidate.key === key);
  if (!dimension) throw new Error(`unknown discovery dimension ${key}`);
  return dimension;
}

// ---------------------------------------------------------------------------
// Classification, canonicalization, serialization
// ---------------------------------------------------------------------------

export type FilterRedactionReason = 'free-text' | 'restricted-identifier' | 'cardinality' | 'not-enum-member' | 'malformed-dimension';

export interface FilterRedaction {
  readonly dimension: FilterDimensionKey;
  readonly value: string;
  readonly reason: FilterRedactionReason;
}

export type FilterValueVerdict = 'known' | 'unknown' | 'rejected';

/**
 * Classify one candidate value for a dimension:
 * - 'known': governed by the current vocabulary (may still match zero records);
 * - 'unknown': well-formed identifier the current vocabulary does not know — kept, inspectable (FR-060);
 * - 'rejected': free text, an identifier of a restricted object, or a non-member of a closed enum.
 */
export function classifyFilterValue(key: FilterDimensionKey, value: string): FilterValueVerdict {
  if (typeof value !== 'string' || !FILTER_VALUE_PATTERN.test(value)) return 'rejected';
  if (RESTRICTED_OBJECT_IDS.has(value)) return 'rejected';
  if (value === UNKNOWN_SENTINEL) return 'known'; // the contract sentinel is always legal
  const dimension = dimensionByKey(key);
  if (dimension.governance === 'contract-enum') {
    return dimension.values.some((candidate) => candidate.id === value) ? 'known' : 'rejected';
  }
  return dimension.values.some((candidate) => candidate.id === value) ? 'known' : 'unknown';
}

function redactionReason(key: FilterDimensionKey, value: string): FilterRedactionReason {
  if (typeof value !== 'string' || !FILTER_VALUE_PATTERN.test(value)) return 'free-text';
  if (RESTRICTED_OBJECT_IDS.has(value)) return 'restricted-identifier';
  if (dimensionByKey(key).governance === 'contract-enum') return 'not-enum-member';
  return 'free-text'; // unreachable for well-formed non-restricted values (classify returns known/unknown there)
}

export interface CanonicalFilterResult {
  /** Canonical filters: known + unknown-but-inspectable values only, sorted, deduplicated, empty arrays omitted. */
  readonly filters: DiscoveryFilterSet;
  /** Everything removed, with the reason. Surfaced to the UI so redaction is explainable, never silent. */
  readonly redactions: readonly FilterRedaction[];
  /** Well-formed values retained but not in the current vocabulary, per dimension (inspectable, distinguishable). */
  readonly unknownValues: Readonly<Partial<Record<FilterDimensionKey, readonly string[]>>>;
  /** Dimension keys present in the input object that the registry does not know (ignored, never serialized). */
  readonly ignoredKeys: readonly string[];
}

function safePreview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

/**
 * Canonicalize any (possibly hostile) filter input into the serializable
 * form. Multi-values are deduplicated and sorted into a stable order; empty
 * arrays are omitted; free text, restricted identifiers, non-enum members and
 * over-cardinality lists are redacted with explicit reasons. Idempotent:
 * canonicalizeFilters(canonical.filters).filters deep-equals canonical.filters.
 */
export function canonicalizeFilters(input: Readonly<Partial<DiscoveryFilterSet>> | null | undefined): CanonicalFilterResult {
  const filters: Record<string, unknown> = {};
  const redactions: FilterRedaction[] = [];
  const unknownValues: Partial<Record<FilterDimensionKey, readonly string[]>> = {};
  const source = (input ?? {}) as Record<string, unknown>;
  const knownKeys = new Set<string>(DISCOVERY_DIMENSION_KEYS);
  const ignoredKeys = Object.keys(source).filter((key) => !knownKeys.has(key));

  for (const dimension of DISCOVERY_DIMENSIONS) {
    const raw = source[dimension.key];
    if (raw === undefined || raw === null) continue;
    if (!Array.isArray(raw)) {
      redactions.push({ dimension: dimension.key, value: safePreview(raw), reason: 'malformed-dimension' });
      continue;
    }
    const unique = [...new Set(raw.map((value) => (typeof value === 'string' ? value : safePreview(value))))].sort();
    const kept: string[] = [];
    for (const value of unique) {
      if (kept.length >= MAX_VALUES_PER_DIMENSION) {
        redactions.push({ dimension: dimension.key, value, reason: 'cardinality' });
        continue;
      }
      if (!raw.includes(value) || classifyFilterValue(dimension.key, value) === 'rejected') {
        // A previewed non-string never re-enters as a filter value; everything else rejected carries its reason.
        redactions.push({ dimension: dimension.key, value: safePreview(value), reason: redactionReason(dimension.key, value) });
        continue;
      }
      kept.push(value);
    }
    if (kept.length === 0) continue;
    filters[dimension.key] = kept;
    const unknown = kept.filter((value) => value !== UNKNOWN_SENTINEL && classifyFilterValue(dimension.key, value) === 'unknown');
    if (unknown.length > 0) unknownValues[dimension.key] = unknown;
  }

  return { filters: filters as unknown as DiscoveryFilterSet, redactions, unknownValues, ignoredKeys };
}

/** Stable compact serialization: `dim=a,b;dim2=c` in registry order, values sorted. Empty set serializes to ''. */
export function serializeFilters(filters: DiscoveryFilterSet): string {
  const parts: string[] = [];
  for (const dimension of DISCOVERY_DIMENSIONS) {
    const values = filters[dimension.key];
    if (!values || values.length === 0) continue;
    const sorted = [...new Set(values)].sort();
    parts.push(`${dimension.key}=${sorted.join(',')}`);
  }
  return parts.join(';');
}

/** Parse the compact serialization; unknown dimension keys are ignored, values go through canonicalization. */
export function parseFilters(serialized: string): CanonicalFilterResult {
  const parsed: Record<string, unknown> = {};
  if (typeof serialized === 'string' && serialized.trim() !== '') {
    for (const part of serialized.split(';')) {
      const separator = part.indexOf('=');
      if (separator <= 0) continue;
      const key = part.slice(0, separator);
      const values = part
        .slice(separator + 1)
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (values.length === 0) continue;
      parsed[key] = (parsed[key] as string[] | undefined ?? []).concat(values);
    }
  }
  return canonicalizeFilters(parsed as unknown as Partial<DiscoveryFilterSet>);
}

// ---------------------------------------------------------------------------
// Matching (FR-002: AND across dimensions, OR within a dimension)
// ---------------------------------------------------------------------------

/** Does the station satisfy the filters? Absent dimensions impose no constraint; the "unknown" sentinel matches unset values. */
export function stationMatchesFilters(station: StationRecord, filters: DiscoveryFilterSet): boolean {
  for (const dimension of DISCOVERY_DIMENSIONS) {
    const values = filters[dimension.key];
    if (!values || values.length === 0) continue; // absent key = no constraint, never "unknown"
    const carried = stationDimensionValues(station, dimension.key);
    const matched = values.some((value) =>
      value === UNKNOWN_SENTINEL ? stationDimensionIsUnset(station, dimension.key) : carried.includes(value),
    );
    if (!matched) return false; // dimensions AND together
  }
  return true;
}

/** The public catalog filtered by the FilterSet, in fixture order. */
export function filterPublicStations(filters: DiscoveryFilterSet): readonly StationRecord[] {
  return publicDiscoveryStations.filter((station) => stationMatchesFilters(station, filters));
}

/** True when any dimension carries a constraint (used for "clear all" affordances). */
export function hasActiveFilters(filters: DiscoveryFilterSet): boolean {
  return DISCOVERY_DIMENSIONS.some((dimension) => {
    const values = filters[dimension.key];
    return Array.isArray(values) && values.length > 0;
  });
}

export const EMPTY_FILTERS: DiscoveryFilterSet = {};

// ---------------------------------------------------------------------------
// Applied-filter chips
// ---------------------------------------------------------------------------

export interface AppliedFilterChip {
  readonly dimension: FilterDimensionKey;
  readonly dimensionLabel: string;
  readonly value: string;
  readonly valueLabel: string;
  /** False when the value is well-formed but not in the current vocabulary (rendered distinctly, inspectable). */
  readonly known: boolean;
}

/** The chip model for currently applied filters, in dimension then value order. */
export function appliedFilterChips(filters: DiscoveryFilterSet): readonly AppliedFilterChip[] {
  const chips: AppliedFilterChip[] = [];
  for (const dimension of DISCOVERY_DIMENSIONS) {
    const values = filters[dimension.key];
    if (!values || values.length === 0) continue;
    for (const value of [...values].sort()) {
      const known = value === UNKNOWN_SENTINEL || classifyFilterValue(dimension.key, value) === 'known';
      const governed = dimension.values.find((candidate) => candidate.id === value);
      const valueLabel =
        value === UNKNOWN_SENTINEL
          ? 'Unknown (value not established)'
          : governed
            ? governed.label
            : `${value} (unknown value — inspect in the data dictionary)`;
      chips.push({ dimension: dimension.key, dimensionLabel: dimension.label, value, valueLabel, known });
    }
  }
  return chips;
}

/** Copy of the filters with one value removed from one dimension (chip removal). */
export function withoutFilterValue(filters: DiscoveryFilterSet, dimension: FilterDimensionKey, value: string): DiscoveryFilterSet {
  const next: Record<string, unknown> = {};
  for (const candidate of DISCOVERY_DIMENSIONS) {
    const values = filters[candidate.key];
    if (!values || values.length === 0) continue;
    const remaining = candidate.key === dimension ? values.filter((candidate2) => candidate2 !== value) : values;
    if (remaining.length > 0) next[candidate.key] = remaining;
  }
  return next as unknown as DiscoveryFilterSet;
}
