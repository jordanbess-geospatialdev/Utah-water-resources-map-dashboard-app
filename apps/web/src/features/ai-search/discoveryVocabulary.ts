/**
 * Web-side builder of the parser controlled vocabulary (WD-019, FR-003).
 *
 * The deterministic parser core lives in
 * services/api/src/ai/filter-parser (relative import, read-only) and is
 * browser-safe/pure; this adapter feeds it the SAME fixture world the
 * discovery UI renders (shell/data/fixtures — verbatim copies of
 * fixtures/contracts, asserted at seed). It mirrors the API-side loader
 * (services/api/src/ai/filter-parser/fixtureVocabulary.ts) exactly; the
 * equivalence suite asserts both builders produce identical vocabularies and
 * identical interpretations, so the web panel and the future
 * POST /search/interpret route run one grammar over one vocabulary.
 *
 * Browser-safe: JSON fixture imports, no node APIs.
 */
import {
  prettifyValueId,
  SEED_LABELS,
  SEED_SITE_STATUS_VALUES,
  SEED_TELEMETRY_VALUES,
  SEED_TIME_STEPS,
} from '../../../../../services/api/src/ai/filter-parser/index';
import type {
  FilterSetProposal,
  InterpretOptions,
  ParserVocabulary,
  VocabularyValue,
} from '../../../../../services/api/src/ai/filter-parser/index';
import { interpret } from '../../../../../services/api/src/ai/filter-parser/index';
import { RESTRICTED_OBJECT_IDS } from '../discovery/filters';
import { stations, systems, subgroups, providers, vocabulary } from '../../shell/data/fixtures';
import type { StationRecord } from '../../shell/data/types';

const KNOWN_TIME_STEPS = new Set(SEED_TIME_STEPS.map((step) => step.id));

/** Cadence → time-step id, mirroring WD-007 timeStepIdForCadence. */
function timeStepIdForCadence(cadenceMinutes: number): string {
  const byCadence: Record<number, string> = { 15: 'fifteen-minute', 60: 'hourly', 1440: 'daily', 10080: 'weekly' };
  if (!Number.isFinite(cadenceMinutes) || cadenceMinutes <= 0) return 'irregular';
  return byCadence[cadenceMinutes] ?? `every-${cadenceMinutes}-minutes`;
}

function labelFor(group: 'siteTypes' | 'waterSources' | 'methods', id: string): string {
  return SEED_LABELS[group][id] ?? prettifyValueId(id);
}

/**
 * Build the controlled vocabulary from the fixture world (all stations, all
 * streams): classifications carried only by non-public records stay in the
 * vocabulary and simply select nothing publicly — the restricted object
 * IDENTIFIERS are never values.
 */
export function buildDiscoveryVocabulary(): ParserVocabulary {
  const siteTypes = new Map<string, VocabularyValue>();
  const waterSources = new Map<string, VocabularyValue>();
  const methods = new Map<string, VocabularyValue>();

  for (const station of stations as readonly StationRecord[]) {
    siteTypes.set(station.siteTypeId, { id: station.siteTypeId, label: labelFor('siteTypes', station.siteTypeId) });
    waterSources.set(station.waterSourceTypeId, {
      id: station.waterSourceTypeId,
      label: labelFor('waterSources', station.waterSourceTypeId),
    });
    for (const stream of station.datastreams) {
      methods.set(stream.methodTypeId, { id: stream.methodTypeId, label: labelFor('methods', stream.methodTypeId) });
      const stepId = timeStepIdForCadence(stream.cadenceMinutes);
      if (!KNOWN_TIME_STEPS.has(stepId)) {
        throw new Error(`fixture cadence ${stream.cadenceMinutes} maps outside the known time-step domain (${stepId})`);
      }
    }
  }

  const byName = (entries: readonly { id: string; name: string }[]): VocabularyValue[] =>
    [...entries].map((entry) => ({ id: entry.id, label: entry.name })).sort((a, b) => (a.id < b.id ? -1 : 1));
  const sorted = (values: Iterable<VocabularyValue>): VocabularyValue[] => [...values].sort((a, b) => (a.id < b.id ? -1 : 1));

  return {
    systems: byName(systems.filter((system) => system.kind === 'system')),
    subgroups: byName(subgroups),
    providers: byName(providers),
    observedProperties: byName(vocabulary.observedProperties),
    processingLevels: byName(vocabulary.processingLevels),
    siteTypes: sorted(siteTypes.values()),
    waterSourceTypes: sorted(waterSources.values()),
    measurementMethodTypes: sorted(methods.values()),
    timeSteps: [...SEED_TIME_STEPS].sort((a, b) => (a.id < b.id ? -1 : 1)),
    telemetryValues: [...SEED_TELEMETRY_VALUES],
    siteStatusValues: [...SEED_SITE_STATUS_VALUES],
    restrictedObjectIds: [...RESTRICTED_OBJECT_IDS].sort(),
  };
}

/** Convenience: interpret with the discovery vocabulary (used by tests and the panel). */
export function interpretWithDiscoveryVocabulary(
  utterance: string,
  options?: InterpretOptions,
): FilterSetProposal {
  return interpret(utterance, buildDiscoveryVocabulary(), options);
}
