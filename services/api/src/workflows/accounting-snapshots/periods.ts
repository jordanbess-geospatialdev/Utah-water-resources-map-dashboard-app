/**
 * Flexible accounting-period resolution (WD-025-R2; FR-030; T-06/T-15).
 *
 * "A configured season or custom water year, including a mid-month
 * boundary, selects the correct fixture observations" - so a PeriodSpec
 * resolves to EXPLICIT half-open [start, end) UTC instants:
 *
 * - the three governed kinds delegate to the WD-025 period window
 *   (../distribution-report/generate.ts periodWindow, backed by
 *   series/zone.ts seasonWindow), so a flexible period over the same bounds
 *   as a governed base reconciles EXACTLY with the WD-008/WD-025
 *   aggregation by construction (the reconciliation suite asserts it);
 * - custom windows carry their own explicit instants: any boundary,
 *   including mid-month and mid-day, is expressible. Resolution validates
 *   the instants (parseable, ordered, sane span) and computes the same
 *   local-day and DST-day facts the governed bases report, so the boundary
 *   rules are always visible (never a hidden assumption that a day is
 *   86 400 s).
 *
 * Totals for ANY resolved window are produced by the WD-008 aggregation
 * domain through the same per-stream calls and gates the WD-025 generator
 * uses (periodCategoryTotals below); nothing here recomputes an integral.
 *
 * Pure and deterministic: no clock reads, no randomness.
 */
import {
  periodWindow,
} from '../distribution-report/generate.ts';
import type { ReportPeriod } from '../distribution-report/types.ts';
import { checkReportScope } from '../distribution-report/scope.ts';
import { reportWorld } from '../distribution-report/world.ts';
import { stationsInScope, statusExclusion, summaryWorld, type SummaryStation, type SummaryStream } from '../../summaries/world.ts';
import { accountingCategory, CATEGORY_LABELS, NO_DOUBLE_COUNT_POLICY, type AccountingCategory } from '../../summaries/totals.ts';
import { aggregateSeries, checkWindow } from '../../series/aggregate.ts';
import { readStreamGrant, grantAllowed } from '../../series/grantCheck.ts';
import type { SeriesStore } from '../../series/load.ts';
import { seriesStore } from '../../series/load.ts';
import type { DomainResult, ProcessingBasis } from '../../series/types.ts';
import { AGGREGATION_METHOD, denial } from '../../series/types.ts';
import { addDays, localDateKey, localDateOf, localMidnightInstant, zonedParts, PROGRAM_TIME_ZONE } from '../../series/zone.ts';
import type { DstDayAdjustment, PeriodKind, PeriodSpec, ResolvedPeriod } from './types.ts';
import type { DecisionCategoryTotal } from './types.ts';

const SECONDS_PER_DAY = 86_400;

const KIND_TO_BASIS: Readonly<Record<Exclude<PeriodKind, 'custom'>, ReportPeriod['basis']>> = {
  'calendar-year': 'calendar-year',
  'water-year': 'water-year',
  'irrigation-season': 'irrigation-season',
};

const CUSTOM_DATE_RULE =
  'custom accounting period: explicit half-open [start, end) UTC instants configured by the period owner; local boundaries resolved in America/Denver; mid-month and mid-day boundaries are supported';

const MIN_PERIOD_YEAR = 1900;
const MAX_PERIOD_YEAR = 2100;

/** UTC instant of local midnight for a civil date in the program zone (delegates to series/zone.ts). */
export function localMidnightIso(year: number, month: number, day: number): string {
  return new Date(localMidnightInstant({ year, month, day }, PROGRAM_TIME_ZONE)).toISOString();
}

/** The local-day and DST facts of a half-open [startMs, endMs) window in the program zone. */
function dayFacts(startMs: number, endMs: number): { localDayCount: number; dstDayAdjustments: DstDayAdjustment[] } {
  const adjustments: DstDayAdjustment[] = [];
  let cursor = localDateOf(startMs, PROGRAM_TIME_ZONE);
  const last = localDateOf(endMs - 1, PROGRAM_TIME_ZONE);
  let count = 0;
  // Guard the loop: the series window limit (400 days) bounds resolution inputs.
  for (let guard = 0; guard < 800; guard += 1) {
    const dayStart = localMidnightInstant(cursor, PROGRAM_TIME_ZONE);
    const next = addDays(cursor, 1);
    const dayEnd = localMidnightInstant(next, PROGRAM_TIME_ZONE);
    const seconds = Math.round((dayEnd - dayStart) / 1000);
    if (seconds !== SECONDS_PER_DAY) {
      const note =
        seconds === 82_800
          ? 'DST spring-forward: the local day is 23 hours (82 800 s), never a flat 86 400 s'
          : seconds === 90_000
            ? 'DST fall-back: the local day is 25 hours (90 000 s), never a flat 86 400 s'
            : `local day duration ${seconds} s`;
      adjustments.push({ date: localDateKey(cursor), daySeconds: seconds, note });
    }
    count += 1;
    if (localDateKey(next) > localDateKey(last)) break;
    cursor = next;
  }
  return { localDayCount: count, dstDayAdjustments: adjustments };
}

/**
 * Resolve a PeriodSpec to explicit half-open bounds plus visible boundary
 * rules. Named kinds are byte-identical to the WD-025 periodWindow; custom
 * windows validate their explicit instants.
 */
export function resolvePeriod(spec: PeriodSpec): DomainResult<ResolvedPeriod> {
  if (spec.kind !== 'custom') {
    if (!Number.isInteger(spec.year) || spec.year < MIN_PERIOD_YEAR || spec.year > MAX_PERIOD_YEAR) {
      return denial(422, 'INVALID_PERIOD', `period year must be an integer between ${MIN_PERIOD_YEAR} and ${MAX_PERIOD_YEAR}`);
    }
    const window = periodWindow({ basis: KIND_TO_BASIS[spec.kind], year: spec.year });
    const startMs = Date.parse(window.start);
    const endMs = Date.parse(window.end);
    const facts = dayFacts(startMs, endMs);
    return {
      outcome: 'allowed',
      value: {
        kind: spec.kind,
        year: spec.year,
        start: window.start,
        end: window.end,
        dateRule: window.dateRule,
        timeZone: window.timeZone,
        localDayCount: facts.localDayCount,
        dstDayAdjustments: Object.freeze(facts.dstDayAdjustments),
      },
    };
  }

  const startMs = Date.parse(spec.start);
  const endMs = Date.parse(spec.end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || spec.start === '' || spec.end === '') {
    return denial(422, 'INVALID_PERIOD', 'custom period start/end must be ISO 8601 instants');
  }
  if (startMs >= endMs) {
    return denial(422, 'INVALID_PERIOD', 'custom period start must be strictly before end (half-open [start, end))');
  }
  const bounds = checkWindow({ start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() });
  if (bounds.outcome === 'denied') return bounds;
  const facts = dayFacts(startMs, endMs);
  return {
    outcome: 'allowed',
    value: {
      kind: 'custom',
      year: null,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      dateRule: CUSTOM_DATE_RULE,
      timeZone: PROGRAM_TIME_ZONE,
      localDayCount: facts.localDayCount,
      dstDayAdjustments: Object.freeze(facts.dstDayAdjustments),
    },
  };
}

/**
 * The canonical slot key of a period within a system: two finalizations of
 * the same system+period contend for ONE slot (finalize.ts optimistic
 * concurrency keys on this).
 */
export function periodKeyOf(systemId: string, spec: PeriodSpec): string {
  return JSON.stringify({ systemId, period: spec });
}

/**
 * Select EXACTLY the observations of one stream inside a resolved period:
 * half-open [start, end) membership on observedAt. The boundary observation
 * at `end` is excluded; the one at `start` is included.
 */
export function selectObservationsInPeriod(
  store: SeriesStore,
  streamId: string,
  resolved: ResolvedPeriod,
): readonly { readonly observationId: string; readonly observedAt: string }[] {
  const startMs = Date.parse(resolved.start);
  const endMs = Date.parse(resolved.end);
  return store
    .observationsForStream(streamId)
    .filter((observation) => {
      const at = Date.parse(observation.observedAt);
      return at >= startMs && at < endMs;
    })
    .map((observation) => ({ observationId: observation.id, observedAt: observation.observedAt }));
}

// ---------------------------------------------------------------------------
// Aggregation over any resolved window (WD-008 numerics, WD-025 pattern)
// ---------------------------------------------------------------------------

function includedFlowStream(_station: SummaryStation, stream: SummaryStream): boolean {
  return stream.observedPropertyId === 'discharge' && stream.unitId === 'cfs';
}

export interface PeriodTotals {
  readonly window: Readonly<Pick<ResolvedPeriod, 'start' | 'end' | 'dateRule' | 'timeZone'>>;
  readonly categories: readonly DecisionCategoryTotal[];
  readonly excludedStreams: readonly { readonly streamId: string; readonly reason: string }[];
}

export interface PeriodTotalsDeps {
  readonly store: SeriesStore;
  /** Overrides the fixture report world (derived worlds in tests). */
  readonly world?: ReturnType<typeof reportWorld>['policyWorld'] | undefined;
  readonly now: string;
}

export interface PeriodTotalsRequest {
  readonly systemId: string;
  readonly period: PeriodSpec;
  readonly processingBasis: ProcessingBasis;
  readonly siteIds: readonly string[] | null;
}

/**
 * Category-separated totals over ANY resolved window, produced by the same
 * WD-008 aggregation calls and the same fail-closed per-stream grant gate
 * as the WD-025 report generator. This is the reconciliation surface: for
 * the governed bounds it equals the WD-025 report totals byte-for-byte on
 * the category rows (the periods suite pins the WD-025 goldens against it).
 */
export function periodCategoryTotals(
  deps: PeriodTotalsDeps,
  request: PeriodTotalsRequest,
  actorId: string | null,
): DomainResult<PeriodTotals> {
  const world = deps.world ?? reportWorld().policyWorld;
  const scope = checkReportScope(world, actorId, request.systemId, deps.now);
  if (scope.outcome === 'denied') return scope;

  const resolved = resolvePeriod(request.period);
  if (resolved.outcome === 'denied') return resolved;
  const window = resolved.value;

  const summary = summaryWorld();
  let stations = stationsInScope(summary, request.systemId);
  if (request.siteIds !== null) {
    const systemIds = new Set(stations.map((station) => station.id));
    for (const siteId of [...new Set(request.siteIds)].sort()) {
      if (!systemIds.has(siteId)) {
        return denial(422, 'SITE_NOT_IN_SYSTEM', `site "${siteId}" is not part of system "${request.systemId}"`);
      }
    }
    const wanted = new Set(request.siteIds);
    stations = stations.filter((station) => wanted.has(station.id));
  }

  const excludedStreams: { streamId: string; reason: string }[] = [];
  const included: { station: SummaryStation; stream: SummaryStream; volume: number; coveredSeconds: number; durationSeconds: number; estimatedSeconds: number }[] = [];

  for (const station of stations) {
    if (statusExclusion(station.status) !== null) continue;
    for (const stream of [...station.streams].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const gate = readStreamGrant(deps.store, actorId, stream.id, deps.now);
      if (!grantAllowed(gate)) {
        // Fail closed: a system-level grant never bypasses the per-stream gate.
        return { outcome: 'denied', status: gate.status, code: gate.code, message: gate.message, ...(gate.policyReason !== undefined ? { policyReason: gate.policyReason } : {}) };
      }
      if (!includedFlowStream(station, stream)) {
        excludedStreams.push({
          streamId: stream.id,
          reason: `dimension mismatch: accounting totals aggregate discharge in cfs; ${stream.observedPropertyId} in ${stream.unitId} is a different dimension`,
        });
        continue;
      }
      const result = aggregateSeries(deps.store, {
        streamId: stream.id,
        start: window.start,
        end: window.end,
        basis: request.processingBasis,
        interval: 'daily',
      });
      if (result.outcome === 'denied') return result;
      if (accountingCategory(station, stream) === null) {
        excludedStreams.push({
          streamId: stream.id,
          reason: `no governed accounting category for site type ${station.siteTypeId} / water source ${station.waterSourceTypeId}`,
        });
        continue;
      }
      let volume = 0;
      let covered = 0;
      let duration = 0;
      let estimated = 0;
      for (const bucket of result.value.buckets) {
        volume += bucket.volumeAcreFeet ?? 0;
        covered += bucket.coveredSeconds;
        duration += bucket.durationSeconds;
        estimated += bucket.estimatedSeconds;
      }
      included.push({ station, stream, volume, coveredSeconds: covered, durationSeconds: duration, estimatedSeconds: estimated });
    }
  }

  const CATEGORY_ORDER: readonly AccountingCategory[] = ['natural-channel-flow', 'canal-delivery', 'reservoir-release'];
  const categories: DecisionCategoryTotal[] = CATEGORY_ORDER.filter((category) =>
    included.some((entry) => accountingCategory(entry.station, entry.stream) === category),
  ).map((category) => {
    const entries = included.filter((entry) => accountingCategory(entry.station, entry.stream) === category);
    const volume = entries.reduce((sum, entry) => sum + entry.volume, 0);
    const covered = entries.reduce((sum, entry) => sum + entry.coveredSeconds, 0);
    const duration = entries.reduce((sum, entry) => sum + entry.durationSeconds, 0);
    const estimated = entries.reduce((sum, entry) => sum + entry.estimatedSeconds, 0);
    return {
      category,
      label: CATEGORY_LABELS[category],
      streamIds: entries.map((entry) => entry.stream.id),
      volumeAcreFeet: volume,
      volumeUnit: 'acre-feet' as const,
      coveredSeconds: covered,
      durationSeconds: duration,
      coverageFraction: duration > 0 ? covered / duration : 0,
      estimatedSeconds: estimated,
      estimatedProportion: covered > 0 ? estimated / covered : 0,
    };
  });

  return {
    outcome: 'allowed',
    value: {
      window: { start: window.start, end: window.end, dateRule: window.dateRule, timeZone: window.timeZone },
      categories: Object.freeze(categories),
      excludedStreams: Object.freeze(excludedStreams),
    },
  };
}

/** Convenience wrapper over the shared fixture series store. */
export function fixturePeriodDeps(now: string): PeriodTotalsDeps {
  return { store: seriesStore(), now };
}

/** Re-exported for the snapshot builders (method identity on every derived number). */
export const PERIOD_TOTALS_METHOD = AGGREGATION_METHOD;

/** Re-exported policy text so callers never hard-code it. */
export const PERIOD_TOTALS_NO_DOUBLE_COUNT = NO_DOUBLE_COUNT_POLICY;

/** Local wall-clock parts of an instant in the program zone (boundary-rule rendering). */
export function localBoundaryLabel(instant: string): string {
  const p = zonedParts(Date.parse(instant), PROGRAM_TIME_ZONE);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} local`;
}
