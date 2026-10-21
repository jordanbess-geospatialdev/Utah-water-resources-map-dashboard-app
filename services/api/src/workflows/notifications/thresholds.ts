/**
 * Threshold evaluation for alert subscriptions (WD-015; FR-025 threshold
 * violations, FR-034 threshold semantics).
 *
 * "Subscriptions distinguish new sites, site edits, no signal and threshold
 * violations" - this module produces the THRESHOLD events: per-property
 * min/max bounds evaluated over a stream's readings inside one digest
 * window.
 *
 * BOUNDS SEMANTICS reuse WD-013's reviewed QC range configuration exactly
 * (services/api/src/workflows/qc/rules.ts DEFAULT_RULE_CONFIGS.range.bounds,
 * calibrated to the contract fixtures: discharge 0-1200 cfs, stage 0-15 ft,
 * voltage 11.5-15 V) via relative import; a subscription's own per-property
 * bounds OVERRIDE the defaults property by property. A violation is a value
 * strictly outside [min, max] - a null reading (reported-but-empty frame) is
 * NOT a threshold violation (that is the no-signal/missing-data story), and
 * an exact bound value is NOT a violation (inclusive bounds, like the QC
 * range family).
 *
 * DEDUPE PER (STREAM, PROPERTY, WINDOW): one window of sustained violation
 * yields EXACTLY ONE event - never one per reading. The event id is the
 * deterministic key `th|<stream>|<property>|<windowStart>`, so a re-delivered
 * or re-evaluated duplicate collapses in the digest builder by id (a
 * sustained violation spanning two windows yields one event per window, one
 * entry per digest).
 *
 * Purity: no I/O, no clock reads; the window and points are arguments.
 */
import { DEFAULT_RULE_CONFIGS, fmt } from '../qc/rules.ts';
import type { NotificationEvent } from './types.ts';

/** Simple [start, end) ISO interval (same shape as the QC intervals). */
export interface ThresholdWindow {
  readonly start: string;
  readonly end: string;
}

export interface ThresholdStreamMeta {
  readonly streamId: string;
  readonly systemId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
}

export type ThresholdPoint = { readonly observedAt: string; readonly value: number | null };

// ---------------------------------------------------------------------------
// Bounds configuration
// ---------------------------------------------------------------------------

/**
 * The reviewed default per-property bounds (WD-013's promoted QC range
 * configuration, relative-imported so the two workflows can never diverge).
 */
export function defaultThresholdBounds(): Readonly<Record<string, { readonly min: number; readonly max: number }>> {
  return DEFAULT_RULE_CONFIGS.range.bounds;
}

export type ThresholdErrorCode = 'bad-bounds' | 'empty-bound';

/**
 * Validate subscription threshold config: finite numbers, at least one bound
 * per property, and min < max when both are given.
 */
export function validateThresholds(thresholds: unknown): readonly ThresholdErrorCode[] {
  const errors = new Set<ThresholdErrorCode>();
  if (thresholds === null || thresholds === undefined) return [];
  if (typeof thresholds !== 'object' || Array.isArray(thresholds)) return ['bad-bounds'];
  for (const bound of Object.values(thresholds as Record<string, unknown>)) {
    if (bound === null || typeof bound !== 'object' || Array.isArray(bound)) {
      errors.add('bad-bounds');
      continue;
    }
    const { min, max } = bound as { min?: unknown; max?: unknown };
    const hasMin = min !== undefined;
    const hasMax = max !== undefined;
    if (!hasMin && !hasMax) {
      errors.add('empty-bound');
      continue;
    }
    if ((hasMin && (typeof min !== 'number' || !Number.isFinite(min))) || (hasMax && (typeof max !== 'number' || !Number.isFinite(max)))) {
      errors.add('bad-bounds');
      continue;
    }
    if (hasMin && hasMax && (min as number) >= (max as number)) errors.add('bad-bounds');
  }
  return [...errors].sort();
}

/** Effective bounds for one property: subscription override, else the reviewed default. */
function effectiveBound(property: string, thresholds: Readonly<Record<string, unknown>> | null | undefined): { readonly min?: number; readonly max?: number } | null {
  const own = thresholds?.[property];
  if (own !== null && own !== undefined && typeof own === 'object' && !Array.isArray(own)) {
    const { min, max } = own as { min?: number; max?: number };
    if (min !== undefined || max !== undefined) return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  }
  return defaultThresholdBounds()[property] ?? null;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Deterministic per-(stream, property, window) event id - THE dedupe key. */
export function thresholdEventId(streamId: string, property: string, windowStart: string): string {
  return `th|${streamId}|${property}|${windowStart}`;
}

interface Worst {
  readonly value: number;
  readonly observedAt: string;
  readonly kind: 'below-min' | 'above-max';
  readonly bound: number;
  readonly deviation: number;
}

/**
 * Evaluate one stream's readings inside ONE window against the effective
 * per-property bounds. Returns AT MOST ONE event: the (stream, property,
 * window) summary whose id dedupes re-delivery and whose summary names the
 * worst reading. Readings outside the window are ignored (window membership
 * is here, not in the caller).
 */
export function evaluateThresholdEvents(
  stream: ThresholdStreamMeta,
  points: readonly ThresholdPoint[],
  window: ThresholdWindow,
  thresholds?: Readonly<Record<string, unknown>> | null,
): readonly NotificationEvent[] {
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const bound = effectiveBound(stream.observedPropertyId, thresholds);
  if (bound === null) return []; // property without configured bounds: no alert

  const inWindow = points
    .filter((point) => {
      const at = Date.parse(point.observedAt);
      return at >= startMs && at < endMs;
    })
    .sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0))
    .filter((point): point is { readonly observedAt: string; readonly value: number } => point.value !== null);

  let violations = 0;
  let worst: Worst | null = null;
  for (const point of inWindow) {
    const below = bound.min !== undefined && point.value < bound.min;
    const above = bound.max !== undefined && point.value > bound.max;
    if (!below && !above) continue;
    violations += 1;
    const kind: 'below-min' | 'above-max' = below ? 'below-min' : 'above-max';
    const boundValue = below ? bound.min! : bound.max!;
    const deviation = Math.abs(point.value - boundValue);
    if (worst === null || deviation > worst.deviation) {
      worst = { value: point.value, observedAt: point.observedAt, kind, bound: boundValue, deviation };
    }
  }
  if (worst === null) return [];

  const breach = worst.kind === 'below-min' ? 'below min' : 'above max';
  const boundsText =
    bound.min !== undefined && bound.max !== undefined ? `${fmt(bound.min)}-${fmt(bound.max)} ${stream.unitId}` : `${breach === 'below-min' ? fmt(bound.min!) : fmt(bound.max!)} ${stream.unitId}`;
  const summary =
    `threshold violation on ${stream.streamId} (${stream.observedPropertyId}): ` +
    `${violations} of ${inWindow.length} window reading${inWindow.length === 1 ? '' : 's'} outside ${boundsText}; ` +
    `worst ${fmt(worst.value)} ${stream.unitId} (${breach} ${fmt(worst.bound)} ${stream.unitId})`;
  return [
    {
      id: thresholdEventId(stream.streamId, stream.observedPropertyId, window.start),
      type: 'threshold',
      objectKind: 'datastream',
      objectId: stream.streamId,
      systemId: stream.systemId,
      streamId: stream.streamId,
      occurredAt: worst.observedAt,
      summary,
    },
  ];
}
