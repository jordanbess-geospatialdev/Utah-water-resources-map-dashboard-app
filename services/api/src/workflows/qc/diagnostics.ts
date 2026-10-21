/**
 * Engineering diagnostics and capacity threshold flags (WD-013; FR-036,
 * FR-034).
 *
 * FR-036: "Authorized engineer views expose available discharge, level,
 * voltage and other relevant streams; internal diagnostics do not become
 * public merely because a site is public."
 *
 * - The ENGINEER DIAGNOSTICS VIEW is the internal-diagnostics surface: it is
 *   granted only to callers the entitlement engine admits for at least one
 *   internal-visibility stream (capability `view-internal-diagnostics`, or
 *   statewide administration - the narrow INTERNAL_FIELD_READ path). When
 *   granted it lists every stream in the input the caller may read -
 *   discharge, level(stage) and voltage alike, public, restricted and
 *   internal - each with its latest reading and active threshold flags.
 *   Non-engineers (and out-of-scope engineers) receive a DENIED view with
 *   the engine's status/reason; nothing internal leaks through the denial.
 * - INTERNAL DIAGNOSTICS NEVER GO PUBLIC: publicDiagnosticsProjection()
 *   emits public-visibility streams only, and the visibility sweep in
 *   test/diagnostics.test.ts byte-scans the serialized projection for the
 *   internal stream id, the internal station, its gate code, wiring notes,
 *   the voltage property and its out-of-range value.
 *
 * FR-034: "Out-of-range fixture values trigger labelled map and series
 * indicators; thresholds are scoped and versioned and the UI uses a symbol
 * or text as well as color."
 *
 * - THRESHOLD SETS are versioned (author, created/updated, status) and
 *   SCOPED (system or stream). Authoring/promotion is gated through the
 *   policy engine (`review-data` on the scope anchor), so a system-scoped
 *   reviewer may manage sets inside their system while an engineer may not.
 * - INDICATORS always carry a SYMBOL and a TEXT label plus severity -
 *   never color alone. A point matching several levels reports only its
 *   highest severity (the 9500 cfs spike is a critical spike, not a warn).
 */
import { gateAct, governanceObject, instantIso, withExtraObjects } from '../stewardship/gate.ts';
import { fmt } from './rules.ts';
import { admitStream, type PolicyDeps, type StreamDenial } from './subscriptions.ts';

// ---------------------------------------------------------------------------
// Thresholds (FR-034)
// ---------------------------------------------------------------------------

export const THRESHOLD_SEVERITIES = ['info', 'warn', 'critical'] as const;
export type ThresholdSeverity = (typeof THRESHOLD_SEVERITIES)[number];

export interface ThresholdLevel {
  readonly id: string;
  /** Observed property the level applies to (discharge, stage, voltage...). */
  readonly property: string;
  readonly op: '>=' | '<=';
  readonly value: number;
  /** Human label carried verbatim by every indicator (text, not color). */
  readonly label: string;
  /** Shape marker carried verbatim by every indicator (symbol, not color). */
  readonly symbol: string;
  readonly severity: ThresholdSeverity;
}

export type ThresholdScope =
  | { readonly kind: 'system'; readonly systemId: string }
  | { readonly kind: 'stream'; readonly streamId: string };

export type ThresholdSetStatus = 'draft' | 'test' | 'promoted';

export interface ThresholdSetVersion {
  readonly id: string;
  readonly version: number;
  readonly scope: ThresholdScope;
  readonly levels: readonly ThresholdLevel[];
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: ThresholdSetStatus;
  readonly promotedBy: string | null;
  readonly promotedAt: string | null;
}

export const THRESHOLD_ID_PATTERN = /^th-[a-z0-9][a-z0-9-]{0,48}$/;

const SEVERITY_RANK: Readonly<Record<ThresholdSeverity, number>> = Object.freeze({ info: 0, warn: 1, critical: 2 });

export interface ThresholdStreamMeta {
  readonly streamId: string;
  readonly systemId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
}

function scopeCovers(scope: ThresholdScope, stream: ThresholdStreamMeta): boolean {
  if (scope.kind === 'system') return stream.systemId === scope.systemId;
  return stream.streamId === scope.streamId;
}

/** Labelled indicators for every flagged point (highest severity wins; text + symbol, FR-034). */
export function applyThresholds(
  stream: ThresholdStreamMeta,
  points: ReadonlyArray<{ readonly observedAt: string; readonly value: number | null }>,
  sets: readonly ThresholdSetVersion[],
): readonly ThresholdIndicator[] {
  const effective = [...new Map(sets.filter((set) => set.status === 'promoted').map((set) => [set.id, set])).values()];
  const indicators: ThresholdIndicator[] = [];
  for (const point of points) {
    if (point.value === null) continue;
    let matched: ThresholdLevel | null = null;
    for (const set of effective) {
      if (!scopeCovers(set.scope, stream)) continue;
      for (const level of set.levels) {
        if (level.property !== stream.observedPropertyId) continue;
        const hit = level.op === '>=' ? point.value >= level.value : point.value <= level.value;
        if (!hit) continue;
        if (matched === null || SEVERITY_RANK[level.severity] > SEVERITY_RANK[matched.severity]) matched = level;
      }
    }
    if (matched) {
      const opText = matched.op === '>=' ? 'at or above' : 'at or below';
      indicators.push({
        flagId: matched.id,
        streamId: stream.streamId,
        observedAt: point.observedAt,
        label: matched.label,
        symbol: matched.symbol,
        severity: matched.severity,
        text: `${matched.symbol} ${matched.label}: ${fmt(point.value)} ${stream.unitId} (${opText} ${fmt(matched.value)} ${stream.unitId})`,
      });
    }
  }
  return indicators;
}

// ---------------------------------------------------------------------------
// Engineer diagnostics view (FR-036)
// ---------------------------------------------------------------------------

export interface DiagnosticStreamInput {
  readonly streamId: string;
  readonly stationId: string;
  readonly systemId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  readonly cadenceMinutes: number;
  readonly visibility: 'public' | 'restricted' | 'internal';
  readonly latest: { readonly observedAt: string; readonly value: number | null } | null;
  /** Recent readings the threshold flags are computed from (optional). */
  readonly history?: readonly { readonly observedAt: string; readonly value: number | null }[];
}

export interface DiagnosticStreamSummary {
  readonly streamId: string;
  readonly stationId: string;
  readonly systemId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  readonly cadenceMinutes: number;
  readonly visibility: 'public' | 'restricted' | 'internal';
  readonly latest: { readonly observedAt: string; readonly value: number | null } | null;
  /** Labelled threshold flags on the history (text + symbol, FR-034). */
  readonly indicators: readonly ThresholdIndicator[];
}

export interface ThresholdIndicator {
  readonly flagId: string;
  readonly streamId: string;
  readonly observedAt: string;
  readonly label: string;
  readonly symbol: string;
  readonly severity: ThresholdSeverity;
  /** Full text marker: symbol + label + value + threshold (never color alone). */
  readonly text: string;
}

export interface DiagnosticsView {
  readonly access: 'granted' | 'denied';
  /** Present when denied: the engine's status/reason for the internal-stream probe. */
  readonly status?: 401 | 403;
  readonly reason?: string;
  readonly detail?: string;
  readonly generatedAt: string;
  readonly streams: readonly DiagnosticStreamSummary[];
}

/**
 * The FR-036 engineer view. GRANTED only when the entitlement engine admits
 * the caller for at least one INTERNAL stream in scope (the engineer
 * diagnostics capability); a granted view lists every stream the caller may
 * read - discharge, level and voltage alike. A denied view lists nothing
 * and carries the denial reason (401 identity / 403 capability or scope).
 */
export function engineerDiagnostics(
  deps: PolicyDeps,
  principalId: string | null,
  input: { readonly streams: readonly DiagnosticStreamInput[]; readonly thresholdSets?: readonly ThresholdSetVersion[] },
): DiagnosticsView {
  const generatedAt = instantIso(deps.clock());
  const internalStreams = input.streams.filter((stream) => stream.visibility === 'internal');
  const probe = internalStreams[0];
  if (probe) {
    const admission = admitStream(deps, principalId, probe.streamId);
    if (!admission.ok) {
      return { access: 'denied', status: admission.status, reason: admission.reason, detail: admission.detail, generatedAt, streams: [] };
    }
  }
  const summaries: DiagnosticStreamSummary[] = [];
  for (const stream of input.streams) {
    const admission = admitStream(deps, principalId, stream.streamId);
    if (!admission.ok) continue; // stream stays invisible, not an error
    summaries.push({
      streamId: stream.streamId,
      stationId: stream.stationId,
      systemId: stream.systemId,
      observedPropertyId: stream.observedPropertyId,
      unitId: stream.unitId,
      cadenceMinutes: stream.cadenceMinutes,
      visibility: stream.visibility,
      latest: stream.latest,
      indicators: applyThresholds(
        { streamId: stream.streamId, systemId: stream.systemId, observedPropertyId: stream.observedPropertyId, unitId: stream.unitId },
        stream.history ?? (stream.latest ? [stream.latest] : []),
        input.thresholdSets ?? [],
      ),
    });
  }
  return { access: 'granted', generatedAt, streams: summaries };
}

// ---------------------------------------------------------------------------
// Public projection (FR-036: internal diagnostics are NEVER public)
// ---------------------------------------------------------------------------

export interface PublicStreamProjection {
  readonly streamId: string;
  readonly stationId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  readonly latest: { readonly observedAt: string; readonly value: number | null } | null;
  readonly indicators: readonly ThresholdIndicator[];
}

/**
 * The PUBLIC projection of the diagnostics surface: public-visibility
 * streams and their (public-safe) threshold indicators only. No internal
 * stream, station, property, reading or flag ever appears here - the
 * visibility sweep test byte-scans the serialization.
 */
export function publicDiagnosticsProjection(
  input: { readonly streams: readonly DiagnosticStreamInput[]; readonly thresholdSets?: readonly ThresholdSetVersion[] },
): { readonly streams: readonly PublicStreamProjection[] } {
  return {
    streams: input.streams
      .filter((stream) => stream.visibility === 'public')
      .map((stream) => ({
        streamId: stream.streamId,
        stationId: stream.stationId,
        observedPropertyId: stream.observedPropertyId,
        unitId: stream.unitId,
        latest: stream.latest,
        indicators: applyThresholds(
          { streamId: stream.streamId, systemId: stream.systemId, observedPropertyId: stream.observedPropertyId, unitId: stream.unitId },
          stream.history ?? (stream.latest ? [stream.latest] : []),
          input.thresholdSets ?? [],
        ),
      })),
  };
}

// ---------------------------------------------------------------------------
// Threshold set service (scoped + versioned, FR-034)
// ---------------------------------------------------------------------------

export type ThresholdErrorCode = 'bad-threshold-id' | 'duplicate-threshold-id' | 'invalid-scope' | 'bad-levels';

export interface ThresholdService {
  createThresholdSet(principalId: string | null, input: { readonly id: string; readonly scope: ThresholdScope; readonly levels: readonly ThresholdLevel[] }): { ok: true; set: ThresholdSetVersion } | { ok: false; errors: readonly ThresholdErrorCode[] } | StreamDenial;
  /** Append a new draft version of an existing set (prior versions immutable). */
  reviseThresholdSet(principalId: string | null, id: string, levels: readonly ThresholdLevel[]): { ok: true; set: ThresholdSetVersion } | { ok: false; errors: readonly ('unknown-threshold-set' | 'bad-levels')[] } | StreamDenial;
  promoteThresholdSet(principalId: string | null, id: string): { ok: true; set: ThresholdSetVersion } | { ok: false; errors: readonly ('unknown-threshold-set' | 'already-promoted')[] } | StreamDenial;
  sets(): readonly ThresholdSetVersion[];
  /** Promoted latest version per id (what applyThresholds consumes). */
  effectiveSets(): readonly ThresholdSetVersion[];
}

function scopeAnchor(deps: PolicyDeps, scope: ThresholdScope) {
  if (scope.kind === 'system') {
    const object = deps.world.objects[scope.systemId];
    return object ?? governanceObject({ id: scope.systemId, kind: 'system', systemId: scope.systemId });
  }
  const object = deps.world.objects[scope.streamId];
  return object ?? governanceObject({ id: scope.streamId, kind: 'datastream' });
}

function validLevels(levels: readonly ThresholdLevel[]): boolean {
  return (
    Array.isArray(levels) &&
    levels.length > 0 &&
    levels.every(
      (level) =>
        typeof level?.id === 'string' &&
        level.id.length > 0 &&
        typeof level.property === 'string' &&
        level.property.length > 0 &&
        (level.op === '>=' || level.op === '<=') &&
        typeof level.value === 'number' &&
        typeof level.label === 'string' &&
        level.label.length > 0 &&
        typeof level.symbol === 'string' &&
        level.symbol.length > 0 &&
        (THRESHOLD_SEVERITIES as readonly string[]).includes(level.severity),
    )
  );
}

export function createThresholdService(deps: PolicyDeps): ThresholdService {
  const sets: ThresholdSetVersion[] = [];
  const now = (): string => instantIso(deps.clock());
  const versionsOf = (id: string): ThresholdSetVersion[] => sets.filter((set) => set.id === id);

  return {
    createThresholdSet(principalId, input) {
      const anchor = input?.scope ? scopeAnchor(deps, input.scope) : null;
      const verdict = anchor
        ? gateAct({ world: withExtraObjects(deps.world, [anchor]), clock: deps.clock, policy: deps.policy }, principalId, 'review-data', { kind: anchor.kind, id: anchor.id })
        : null;
      if (verdict && !verdict.ok) return { ok: false, status: verdict.status, reason: verdict.reason, detail: verdict.decision.detail ?? '', decision: verdict.decision };
      const errors: ThresholdErrorCode[] = [];
      if (!THRESHOLD_ID_PATTERN.test(input?.id ?? '')) errors.push('bad-threshold-id');
      if (input?.scope?.kind !== 'system' && input?.scope?.kind !== 'stream') errors.push('invalid-scope');
      else if (input.scope.kind === 'system' && !deps.world.objects[input.scope.systemId]) errors.push('invalid-scope');
      else if (input.scope.kind === 'stream' && !deps.world.objects[input.scope.streamId]) errors.push('invalid-scope');
      if (!validLevels(input?.levels)) errors.push('bad-levels');
      if (versionsOf(input?.id ?? '').length > 0) errors.push('duplicate-threshold-id');
      if (errors.length > 0) return { ok: false, errors };

      const set: ThresholdSetVersion = Object.freeze({
        id: input.id,
        version: 1,
        scope: input.scope,
        levels: Object.freeze([...input.levels]),
        author: principalId ?? '',
        createdAt: now(),
        updatedAt: now(),
        status: 'draft',
        promotedBy: null,
        promotedAt: null,
      });
      sets.push(set);
      return { ok: true, set };
    },

    reviseThresholdSet(principalId, id, levels) {
      const existing = versionsOf(id);
      const anchor = existing[0] ? scopeAnchor(deps, existing[0].scope) : null;
      const verdict = anchor
        ? gateAct({ world: withExtraObjects(deps.world, [anchor]), clock: deps.clock, policy: deps.policy }, principalId, 'review-data', { kind: anchor.kind, id: anchor.id })
        : null;
      if (verdict && !verdict.ok) return { ok: false, status: verdict.status, reason: verdict.reason, detail: verdict.decision.detail ?? '', decision: verdict.decision };
      if (existing.length === 0) return { ok: false, errors: ['unknown-threshold-set'] as const };
      if (!validLevels(levels)) return { ok: false, errors: ['bad-levels'] as const };
      const base = existing[0]!;
      const set: ThresholdSetVersion = Object.freeze({
        id,
        version: existing.length + 1,
        scope: base.scope,
        levels: Object.freeze([...levels]),
        author: principalId ?? '',
        createdAt: now(),
        updatedAt: now(),
        status: 'draft',
        promotedBy: null,
        promotedAt: null,
      });
      sets.push(set);
      return { ok: true, set };
    },

    promoteThresholdSet(principalId, id) {
      const latest = versionsOf(id).at(-1);
      const anchor = latest ? scopeAnchor(deps, latest.scope) : null;
      const verdict = anchor
        ? gateAct({ world: withExtraObjects(deps.world, [anchor]), clock: deps.clock, policy: deps.policy }, principalId, 'review-data', { kind: anchor.kind, id: anchor.id })
        : null;
      if (verdict && !verdict.ok) return { ok: false, status: verdict.status, reason: verdict.reason, detail: verdict.decision.detail ?? '', decision: verdict.decision };
      if (!latest) return { ok: false, errors: ['unknown-threshold-set'] as const };
      if (latest.status === 'promoted') return { ok: false, errors: ['already-promoted'] as const };
      const promoted = Object.freeze({ ...latest, status: 'promoted', promotedBy: principalId ?? '', promotedAt: now(), updatedAt: now() });
      sets[sets.indexOf(latest)] = promoted;
      return { ok: true, set: promoted };
    },

    sets() {
      return [...sets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version));
    },

    effectiveSets() {
      const latest = [...new Map(sets.map((set) => [set.id, set])).values()];
      return latest.filter((set) => set.status === 'promoted').sort((a, b) => (a.id < b.id ? -1 : 1));
    },
  };
}

/**
 * The reviewed default threshold sets (fixture-calibrated, FR-034):
 * - th-corinne-capacity (stream scope str-corinne-q): warn at 24 cfs and a
 *   critical spike level at 1000 cfs - the 9500 cfs fixture spike reports
 *   CRITICAL, and the ten 24-26 cfs late-fixture readings report warn.
 * - th-voltage-battery (stream scope str-diag-voltage, INTERNAL): the
 *   voltage-low flag that never leaves the engineer view.
 */
export function defaultThresholdSets(author: string, at: string): readonly ThresholdSetVersion[] {
  const draft = (id: string, scope: ThresholdScope, levels: readonly ThresholdLevel[]): ThresholdSetVersion => ({
    id,
    version: 1,
    scope,
    levels,
    author,
    createdAt: at,
    updatedAt: at,
    status: 'draft',
    promotedBy: null,
    promotedAt: null,
  });
  return [
    draft('th-corinne-capacity', { kind: 'stream', streamId: 'str-corinne-q' }, [
      { id: 'capacity-warn', property: 'discharge', op: '>=', value: 24, label: 'Above typical late-winter capacity', symbol: '▲', severity: 'warn' },
      { id: 'capacity-spike', property: 'discharge', op: '>=', value: 1000, label: 'Spike far above rated capacity', symbol: '‼', severity: 'critical' },
    ]),
    draft('th-voltage-battery', { kind: 'stream', streamId: 'str-diag-voltage' }, [
      { id: 'voltage-low', property: 'voltage', op: '<=', value: 11.5, label: 'Battery voltage at or below minimum', symbol: '▼', severity: 'warn' },
    ]),
  ];
}
