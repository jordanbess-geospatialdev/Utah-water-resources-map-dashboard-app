/**
 * Controlled-vocabulary index for the WD-019 grammar (FR-003, T-13).
 *
 * The lexer matches spoken phrases against governed values only. An entry is
 * built from each ParserVocabulary value:
 *
 * - the normalized full label (a match on it is confidence 'exact');
 * - deterministic shortened forms of registry labels (trailing generic words
 *   such as "distribution system", "measurement program", "telemetry
 *   network" are stripped — "Bear River Distribution System" also answers to
 *   "bear river"); matches on shortened forms are 'synonym';
 * - the curated core synonym table below for the seed-stable governed enums
 *   (telemetry words, property names incl. discharge/flow and stage, site
 *   statuses, processing levels, method types, time steps) — 'synonym';
 * - builder-supplied extra synonyms — 'synonym'.
 *
 * A phrase mapping to MORE THAN ONE dimension stays ambiguous: the index
 * keeps every candidate and the parser requires clarification instead of
 * picking ("weir" is deliberately such a term: site type vs measurement
 * method). Dimension words ("system", "provider", "sites", "data"...) are
 * grammar noise, never values; they are listed here so both builders and
 * tests share one table.
 *
 * Pure module: no I/O, no clock.
 */
import type {
  NLFilterDimensionKey,
  ParserVocabulary,
  VocabularyValue,
} from './types';

/** Normalization shared by utterances, labels and synonyms: lowercase, split punctuation, single spaces. */
export function normalizePhrase(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Generic suffixes stripped from registry labels to derive short spoken forms. */
const LABEL_SUFFIXES: readonly string[] = [
  'distribution system',
  'subgroup',
  'measurement program',
  'telemetry network',
  'manual measurement program',
  'network',
  'program',
];

function labelTerms(label: string): { exact: string; shortened: string[] } {
  const normalized = normalizePhrase(label);
  const shortened: string[] = [];
  let current = normalized;
  for (const suffix of LABEL_SUFFIXES) {
    if (current.endsWith(` ${suffix}`)) {
      current = current.slice(0, -suffix.length).trim();
    }
  }
  if (current !== '' && current !== normalized) shortened.push(current);
  return { exact: normalized, shortened };
}

/**
 * Curated synonyms for seed-stable governed enum values (fixtures/contracts
 * vocabulary.json + the public-facet method/time-step derivations). The ids
 * are governed and stable per seed; the spoken forms are grammar knowledge.
 */
export const CURATED_SYNONYMS: Readonly<Record<NLFilterDimensionKey, Readonly<Record<string, readonly string[]>>>> = {
  telemetry: {
    telemetered: ['telemetered', 'real time', 'real-time', 'realtime', 'with telemetry', 'telemetry equipped', 'telemetric'],
    manual: ['manual', 'no telemetry', 'without telemetry', 'hand read', 'hand-read', 'manually read'],
    unknown: ['unknown', 'unknown telemetry', 'telemetry unknown', 'telemetry not established'],
  },
  siteStatusIds: {
    active: ['operational'],
    inactive: ['retired', 'decommissioned'],
    proposed: ['planned'],
  },
  processingLevels: {
    reviewed: ['approved'],
    'best-available': ['best available', 'current best value'],
  },
  observedPropertyIds: {
    discharge: ['flow', 'streamflow', 'cfs', 'flow rate'],
    stage: ['water level', 'water surface elevation', 'gage height', 'gauge height', 'river height'],
    voltage: ['battery', 'battery voltage', 'volts', 'supply voltage'],
  },
  measurementMethodTypeIds: {
    'method-rating': ['rating curve', 'rated'],
    'method-pressure-transducer': ['transducer', 'pressure sensor', 'pressure'],
    'method-current-meter': ['current meter method'],
    'method-weir-board': ['weir'], // deliberately ambiguous with site type "weir" → clarification
    'method-direct-read': ['direct reading', 'direct read method'],
  },
  timeStepIds: {
    hourly: ['every 60 minutes', '60 minute', 'hourly cadence'],
    daily: ['every 1440 minutes', 'daily cadence'],
    weekly: ['every 10080 minutes', 'weekly cadence'],
    'fifteen-minute': ['15 minute', 'every 15 minutes', 'fifteen minute'],
  },
  distributionSystemIds: {},
  subgroupIds: {},
  providerIds: {
    'prov-coop-manual': ['cooperator', 'coop'],
  },
  siteTypeIds: {
    'natural-channel': ['natural stream channel', 'channel'],
    flume: ['parshall flume'],
  },
  waterSourceTypeIds: {
    'surface-natural-flow': ['natural flow'],
    'surface-storage-release': ['storage release', 'storage releases'],
  },
  controlStructureIds: {},
  structureMaterialIds: {},
  structureSizeIds: {},
  measuringDeviceTypeIds: {},
};

/**
 * Grammar noise words: dimension references and polite filler. They are not
 * filter values, not unknown terms — they are the connective tissue of the
 * utterance. Deliberately conservative: content words never appear here.
 */
export const NOISE_WORDS: ReadonlySet<string> = new Set<string>([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'by', 'currently', 'display', 'each', 'every', 'find',
  'for', 'from', 'give', 'in', 'include', 'including', 'into', 'is', 'list', 'me', 'measurements',
  'measurement', 'method', 'methods', 'now', 'of', 'on', 'only', 'or', 'please', 'program',
  'reporting', 'report', 'reports', 'see', 'show', 'site', 'sites', 'station', 'stations',
  'system', 'systems', 'canal', 'canals', 'company', 'companies', 'provider', 'providers',
  'subgroup', 'subgroups', 'type', 'types', 'status', 'telemetry', 'property', 'properties',
  'level', 'levels', 'processing', 'source', 'sources', 'water', 'data', 'datas', 'value',
  'values', 'with', 'that', 'the', 'their', 'there', 'these', 'this', 'to', 'under', 'where',
  'which', 'whose', 'within', 'has', 'have', 'had', 'be', 'been', 'being', 'it', 'its',
  'gauge', 'gage', 'monitoring', 'point', 'points', 'location', 'locations', 'about',
  'fetch', 'user', 'users', 'you', 'your', 'we', 'our', 'i', 'my', 'us',
]);

/** One candidate a matched phrase can resolve to. */
export interface TermCandidate {
  readonly dimension: NLFilterDimensionKey;
  readonly valueId: string;
  readonly label: string;
  readonly confidence: 'exact' | 'synonym';
}

/** phrase → competing candidates (phrase length in words ≥ 1). */
export type VocabularyIndex = ReadonlyMap<string, readonly TermCandidate[]>;

interface DimensionBinding {
  readonly dimension: NLFilterDimensionKey;
  readonly values: readonly VocabularyValue[];
}

function dimensionsOf(vocabulary: ParserVocabulary): readonly DimensionBinding[] {
  return [
    { dimension: 'distributionSystemIds', values: vocabulary.systems },
    { dimension: 'subgroupIds', values: vocabulary.subgroups },
    { dimension: 'providerIds', values: vocabulary.providers },
    { dimension: 'siteTypeIds', values: vocabulary.siteTypes },
    { dimension: 'waterSourceTypeIds', values: vocabulary.waterSourceTypes },
    { dimension: 'measurementMethodTypeIds', values: vocabulary.measurementMethodTypes },
    { dimension: 'timeStepIds', values: vocabulary.timeSteps },
    { dimension: 'telemetry', values: vocabulary.telemetryValues },
    { dimension: 'siteStatusIds', values: vocabulary.siteStatusValues },
    { dimension: 'processingLevels', values: vocabulary.processingLevels },
    { dimension: 'observedPropertyIds', values: vocabulary.observedProperties },
  ];
}

function addTerm(index: Map<string, TermCandidate[]>, phrase: string, candidate: TermCandidate): void {
  if (phrase === '') return;
  const existing = index.get(phrase) ?? [];
  if (existing.some((c) => c.dimension === candidate.dimension && c.valueId === candidate.valueId)) return;
  index.set(phrase, [...existing, candidate]);
}

/**
 * Build the matching index. Longest-phrase-first matching plus multi-candidate
 * phrases (ambiguity) make the grammar deterministic: the same vocabulary
 * always yields the same index (map insertion order is call-order-stable).
 */
export function buildVocabularyIndex(vocabulary: ParserVocabulary): VocabularyIndex {
  const index = new Map<string, TermCandidate[]>();
  const restricted = new Set(vocabulary.restrictedObjectIds);

  for (const binding of dimensionsOf(vocabulary)) {
    for (const value of binding.values) {
      if (restricted.has(value.id)) continue; // a restricted identifier is never a legal value
      const { exact, shortened } = labelTerms(value.label);
      addTerm(index, exact, { dimension: binding.dimension, valueId: value.id, label: value.label, confidence: 'exact' });
      for (const term of shortened) {
        addTerm(index, term, { dimension: binding.dimension, valueId: value.id, label: value.label, confidence: 'synonym' });
      }
      const synonyms = [
        ...(CURATED_SYNONYMS[binding.dimension][value.id] ?? []),
        ...(value.synonyms ?? []),
      ].map(normalizePhrase);
      for (const synonym of synonyms) {
        addTerm(index, synonym, { dimension: binding.dimension, valueId: value.id, label: value.label, confidence: 'synonym' });
      }
    }
  }
  return index;
}

/** Longest phrase (in words) present in the index — bounds the lexer's sliding window. */
export function maxPhraseLength(index: VocabularyIndex): number {
  let max = 1;
  for (const phrase of index.keys()) max = Math.max(max, phrase.split(' ').length);
  return max;
}

/**
 * Governed-value registry for validation: dimension → legal ids this
 * vocabulary governs. Mirrors the WD-007 dimension registry semantics (the
 * manual filter UI's value lists); equivalence.test.ts proves the mirror.
 */
export function governedValueIds(vocabulary: ParserVocabulary): Readonly<Record<NLFilterDimensionKey, ReadonlySet<string>>> {
  const registry: Record<NLFilterDimensionKey, Set<string>> = {
    distributionSystemIds: new Set(vocabulary.systems.map((v) => v.id)),
    subgroupIds: new Set(vocabulary.subgroups.map((v) => v.id)),
    siteTypeIds: new Set(vocabulary.siteTypes.map((v) => v.id)),
    telemetry: new Set(vocabulary.telemetryValues.map((v) => v.id)),
    providerIds: new Set(vocabulary.providers.map((v) => v.id)),
    observedPropertyIds: new Set(vocabulary.observedProperties.map((v) => v.id)),
    controlStructureIds: new Set(), // declared dimensions, ungoverned at seed v0.1.0
    structureMaterialIds: new Set(),
    structureSizeIds: new Set(),
    waterSourceTypeIds: new Set(vocabulary.waterSourceTypes.map((v) => v.id)),
    measuringDeviceTypeIds: new Set(),
    measurementMethodTypeIds: new Set(vocabulary.measurementMethodTypes.map((v) => v.id)),
    siteStatusIds: new Set(vocabulary.siteStatusValues.map((v) => v.id)),
    timeStepIds: new Set(vocabulary.timeSteps.map((v) => v.id)),
    processingLevels: new Set(vocabulary.processingLevels.map((v) => v.id)),
  };
  return registry;
}

/** Dimensions whose values are a closed enum (mirror of the WD-007 'contract-enum' governance). */
export const ENUM_DIMENSIONS: ReadonlySet<NLFilterDimensionKey> = new Set<NLFilterDimensionKey>([
  'telemetry',
  'siteStatusIds',
  'processingLevels',
]);

// ---------------------------------------------------------------------------
// Seed-stable value lists / labels (seed utah-water-fixture-v1)
//
// Shared by BOTH vocabulary builders (services/api fixtureVocabulary.ts and
// apps/web discoveryVocabulary.ts) so their ParserVocabularies — and hence
// their interpretations — are identical; equivalence.test.ts asserts it.
// ---------------------------------------------------------------------------

/** The deterministic time-step derivation domain (WD-007 TIME_STEP_BY_CADENCE). */
export const SEED_TIME_STEPS: readonly VocabularyValue[] = [
  { id: 'fifteen-minute', label: 'Fifteen-minute' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
];

/** Contract-enum telemetry tri-state (filter-set.json dimension 5). */
export const SEED_TELEMETRY_VALUES: readonly VocabularyValue[] = [
  { id: 'telemetered', label: 'Telemetered' },
  { id: 'manual', label: 'Manual (no telemetry)' },
  { id: 'unknown', label: 'Unknown (not established)' },
];

/** Contract-enum site status (dimension 16). */
export const SEED_SITE_STATUS_VALUES: readonly VocabularyValue[] = [
  { id: 'active', label: 'Active' },
  { id: 'inactive', label: 'Inactive' },
  { id: 'proposed', label: 'Proposed' },
];

/** Presentation labels for facet-derived fixture ids. */
export const SEED_LABELS: Readonly<Record<'siteTypes' | 'waterSources' | 'methods', Readonly<Record<string, string>>>> = {
  siteTypes: {
    'natural-channel': 'Natural channel',
    flume: 'Flume',
    weir: 'Weir',
    diagnostic: 'Diagnostic',
  },
  waterSources: {
    'surface-natural-flow': 'Surface natural flow',
    'surface-storage-release': 'Surface storage release',
  },
  methods: {
    'method-rating': 'Rating',
    'method-pressure-transducer': 'Pressure transducer',
    'method-current-meter': 'Current meter',
    'method-weir-board': 'Weir board',
    'method-direct-read': 'Direct read',
  },
};

/** Deterministic fallback label for an id the curated maps do not know. */
export function prettifyValueId(id: string): string {
  return id
    .split('-')
    .map((word) => (word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}
