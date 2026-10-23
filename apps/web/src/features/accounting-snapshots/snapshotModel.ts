/**
 * snapshotModel - pure view models for the WD-025-R2 accounting-snapshots
 * feature (FR-028 decision evidence, FR-029 immutable finalization, FR-030
 * flexible periods + advisory supplemental context).
 *
 * MIRROR CONTRACT (the established WD-008/WD-025/WD-011 pattern):
 * - Period math mirrors services/api/src/workflows/accounting-snapshots/periods.ts
 *   (governed kinds delegate to the WD-025 date rules; custom windows carry
 *   explicit half-open instants, so mid-month boundaries resolve exactly).
 * - The demo decision/finalize builders mirror
 *   services/api/src/workflows/accounting-snapshots/{decisions,finalize}.ts:
 *   evidence pins exact revision ids from the fixture chains; finalization is
 *   authority-gated (explicit finalize-accounting assignments, pending
 *   owner ratification), optimistic-concurrency-guarded (typed 409 conflict)
 *   and supersedes without ever rewriting prior bytes (dual-hash stability).
 *   The API remains the source of truth; the demos exist because the HTTP
 *   service is not wired yet (README.md).
 * - Demo hashes are the deterministic FNV-style digest of reportModel (NOT
 *   the server's sha256); the UI labels them as demo stand-ins.
 *
 * Deterministic: no clock reads (the demo clock defaults to the fixture
 * clock), no randomness, fixed iteration orders.
 */
import { entitlements, FIXTURE_CLOCK, observations, revisions, stations, userById } from '../../shell/data/fixtures';
import type { EntitlementRecord, ObservationRecord, RevisionRecord } from '../../shell/data/types';

// ---------------------------------------------------------------------------
// Flexible periods (FR-030)
// ---------------------------------------------------------------------------

export type PeriodKind = 'calendar-year' | 'water-year' | 'irrigation-season' | 'custom';

export type PeriodSpecModel =
  | { readonly kind: 'calendar-year'; readonly year: number }
  | { readonly kind: 'water-year'; readonly year: number }
  | { readonly kind: 'irrigation-season'; readonly year: number }
  | { readonly kind: 'custom'; readonly start: string; readonly end: string; readonly label: string };

export interface PeriodKindOption {
  readonly id: PeriodKind;
  readonly label: string;
  readonly dateRule: string;
}

export const PERIOD_KINDS: readonly PeriodKindOption[] = [
  {
    id: 'calendar-year',
    label: 'Calendar year',
    dateRule: 'local calendar year: Jan 1 00:00 (inclusive) through Jan 1 next year (exclusive), America/Denver',
  },
  {
    id: 'water-year',
    label: 'Water year (Oct - Sep)',
    dateRule: 'USGS water year: Oct 1 of the previous year (inclusive) through Oct 1 of the period year (exclusive; the water year ends Sep 30), America/Denver',
  },
  {
    id: 'irrigation-season',
    label: 'Irrigation season (Apr 1 - Oct 31)',
    dateRule: 'irrigation season: Apr 1 (inclusive) through Nov 1 (exclusive) of the period year, America/Denver',
  },
  {
    id: 'custom',
    label: 'Custom period (any boundary, incl. mid-month)',
    dateRule: 'custom accounting period: explicit half-open [start, end) instants configured by the period owner; mid-month and mid-day boundaries are supported',
  },
] as const;

export const PROGRAM_TIME_ZONE = 'America/Denver';

// ---------------------------------------------------------------------------
// Local-calendar mirror (presentation twin of series/zone.ts)
// ---------------------------------------------------------------------------

function zonedParts(epochMs: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function offsetMs(epochMs: number, zone: string): number {
  const p = zonedParts(epochMs, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** UTC instant of local midnight for a civil date in the zone (fixed-point, like zone.ts). */
export function localMidnightMs(year: number, month: number, day: number, zone: string = PROGRAM_TIME_ZONE): number {
  const naive = Date.UTC(year, month - 1, day);
  let t = naive - 7 * 3_600_000;
  for (let i = 0; i < 4; i += 1) {
    const next = naive - offsetMs(t, zone);
    if (next === t) return t;
    t = next;
  }
  return t;
}

function localDateOf(epochMs: number): { year: number; month: number; day: number } {
  const p = zonedParts(epochMs, PROGRAM_TIME_ZONE);
  return { year: p.year, month: p.month, day: p.day };
}

function localDateKey(date: { year: number; month: number; day: number }): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function addDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addMonths(date: { year: number; month: number; day: number }, count: number): { year: number; month: number; day: number } {
  const total = date.year * 12 + (date.month - 1) + count;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

export interface ResolvedPeriodModel {
  readonly kind: PeriodKind;
  readonly year: number | null;
  readonly start: string;
  readonly end: string;
  readonly dateRule: string;
  readonly localDayCount: number;
  readonly dstDays: readonly { readonly date: string; readonly daySeconds: number }[];
}

export type ResolveResult = { readonly ok: true; readonly value: ResolvedPeriodModel } | { readonly ok: false; readonly message: string };

/** Resolve a spec to explicit half-open bounds + visible DST facts (mirror of periods.ts resolvePeriod). */
export function resolvePeriodModel(spec: PeriodSpecModel): ResolveResult {
  const facts = (startMs: number, endMs: number) => {
    const dstDays: { date: string; daySeconds: number }[] = [];
    let cursor = localDateOf(startMs);
    const last = localDateOf(endMs - 1);
    let count = 0;
    for (let guard = 0; guard < 800; guard += 1) {
      const dayStart = localMidnightMs(cursor.year, cursor.month, cursor.day);
      const next = addDays(cursor, 1);
      const dayEnd = localMidnightMs(next.year, next.month, next.day);
      const seconds = Math.round((dayEnd - dayStart) / 1000);
      if (seconds !== 86_400) dstDays.push({ date: localDateKey(cursor), daySeconds: seconds });
      count += 1;
      if (localDateKey(next) > localDateKey(last)) break;
      cursor = next;
    }
    return { localDayCount: count, dstDays };
  };

  if (spec.kind !== 'custom') {
    if (!Number.isInteger(spec.year) || spec.year < 1900 || spec.year > 2100) {
      return { ok: false, message: 'period year must be an integer between 1900 and 2100' };
    }
    let startYear = spec.year;
    let startMonth = 1;
    let spanMonths = 12;
    if (spec.kind === 'water-year') {
      startYear = spec.year - 1;
      startMonth = 10;
    } else if (spec.kind === 'irrigation-season') {
      startMonth = 4;
      spanMonths = 7;
    }
    const startMs = localMidnightMs(startYear, startMonth, 1);
    const end = addMonths({ year: startYear, month: startMonth, day: 1 }, spanMonths);
    const endMs = localMidnightMs(end.year, end.month, end.day);
    return {
      ok: true,
      value: {
        kind: spec.kind,
        year: spec.year,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        dateRule: PERIOD_KINDS.find((option) => option.id === spec.kind)?.dateRule ?? '',
        ...facts(startMs, endMs),
      },
    };
  }

  const startMs = Date.parse(spec.start);
  const endMs = Date.parse(spec.end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || spec.start === '' || spec.end === '') {
    return { ok: false, message: 'custom period start/end must be ISO 8601 instants' };
  }
  if (startMs >= endMs) {
    return { ok: false, message: 'custom period start must be strictly before end (half-open [start, end))' };
  }
  if (endMs - startMs > 400 * 86_400_000) {
    return { ok: false, message: 'custom period span exceeds the 400-day series window limit' };
  }
  return {
    ok: true,
    value: {
      kind: 'custom',
      year: null,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      dateRule: PERIOD_KINDS[3]!.dateRule,
      ...facts(startMs, endMs),
    },
  };
}

/** Local civil date+time -> UTC instant (the custom-period builder input path). */
export function instantFromLocal(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(localMidnightMs(year, month, day) + hour * 3_600_000 + minute * 60_000).toISOString();
}

export function localBoundaryLabel(instant: string): string {
  const p = zonedParts(Date.parse(instant), PROGRAM_TIME_ZONE);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} local`;
}

export function boundaryRuleText(resolved: ResolvedPeriodModel): string {
  const dst =
    resolved.dstDays.length === 0
      ? 'no DST transition day is fully spanned'
      : resolved.dstDays.map((day) => `${day.date} is ${day.daySeconds === 82_800 ? 'a 23-hour' : day.daySeconds === 90_000 ? 'a 25-hour' : `${day.daySeconds} s`} local day`).join('; ');
  return `Half-open [start, end): the instant at "end" is EXCLUDED. ${resolved.localDayCount} local day(s) touched. ${dst}. Zone ${PROGRAM_TIME_ZONE}.`;
}

// ---------------------------------------------------------------------------
// Supersession chains (FR-029)
// ---------------------------------------------------------------------------

export interface FinalizedLike {
  readonly id: string;
  readonly periodKey: string;
  readonly contentHash: string;
  readonly finalizedBy: string;
  readonly finalizedAt: string;
  readonly supersedes: string | null;
  readonly supersedeReason: string | null;
  readonly decisionId: string | null;
}

export interface FinalizedChainView {
  readonly record: FinalizedLike;
  /** Stored bytes never change; this projection reports the live lifecycle. */
  readonly status: 'finalized' | 'superseded';
  readonly supersededBy: string | null;
  readonly ordinal: number;
}

/** The full supersession chain of one period slot, oldest first. */
export function supersessionChain(records: readonly FinalizedLike[], periodKey: string): readonly FinalizedChainView[] {
  const chain = records
    .filter((record) => record.periodKey === periodKey)
    .sort((a, b) => (a.finalizedAt === b.finalizedAt ? (a.id < b.id ? -1 : 1) : a.finalizedAt < b.finalizedAt ? -1 : 1));
  return chain.map((record, index) => ({
    record,
    status: index < chain.length - 1 ? 'superseded' : 'finalized',
    supersededBy: index < chain.length - 1 ? (chain[index + 1]?.id ?? null) : null,
    ordinal: index + 1,
  }));
}

export function statusBadge(status: 'finalized' | 'superseded'): { readonly marker: string; readonly text: string } {
  return status === 'finalized' ? { marker: '●', text: 'Finalized' } : { marker: '✕', text: 'Superseded' };
}

export function linkageText(view: FinalizedChainView): string {
  const up = view.record.supersedes === null ? 'no prior finalized record' : `supersedes ${view.record.supersedes} (${view.record.supersedeReason ?? 'no reason recorded'})`;
  const down = view.supersededBy === null ? 'current version of this period' : `superseded by ${view.supersededBy}`;
  return `v${view.ordinal}: ${up}; ${down}. Prior bytes are never rewritten.`;
}

export function supersededBanner(view: FinalizedChainView): string | null {
  if (view.status !== 'superseded') return null;
  return `SUPERSEDED - finalized record ${view.record.id} (${view.record.contentHash.slice(0, 12)}…) was replaced by ${view.supersededBy} and can no longer be modified or deleted; its bytes and content hash never changed.`;
}

// ---------------------------------------------------------------------------
// Finalize authority mirror (approval-gated, owner-ratification-pending)
// ---------------------------------------------------------------------------

export const FINALIZE_AUTHORITY_RULE_MIRROR =
  'finalize/reopen requires an explicit finalize-accounting grant on the system object; QC review and general administration do not grant approval - ASSIGNMENTS PENDING OWNER RATIFICATION';

export interface FinalizeAuthorityModel {
  readonly principalId: string;
  readonly displayName: string;
  readonly role: string;
  readonly canFinalizeSystemIds: readonly string[];
  readonly via: 'finalize-accounting' | 'none';
  readonly basis: string;
  readonly delegation: { effectiveAt: string; expiresAt: string; delegatedBy: string } | null;
}

function withinWindow(ent: EntitlementRecord, atMs: number): boolean {
  if (ent.status !== 'active') return false;
  if (ent.role === 'deputy' && (!ent.delegation || ent.scopeType === 'statewide')) return false;
  if (Date.parse(ent.effectiveAt) > atMs) return false;
  if (ent.expiresAt !== null && atMs >= Date.parse(ent.expiresAt)) return false;
  const delegation = ent.delegation ?? null;
  if (delegation) {
    if (Date.parse(delegation.effectiveAt) > atMs) return false;
    if (atMs >= Date.parse(delegation.expiresAt)) return false;
  }
  return true;
}

/**
 * Which principals can finalize accounting for which systems at `now`
 * (explicit finalize-accounting grants only). The SERVER re-evaluates
 * the real engine on every request; this model only drives the UI picker.
 */
export function finalizeAuthorities(now: string = FIXTURE_CLOCK, grants: readonly EntitlementRecord[] = entitlements): readonly FinalizeAuthorityModel[] {
  const atMs = Date.parse(now);
  const models: FinalizeAuthorityModel[] = [];
  const allSystemIds = [...new Set(stations.map((station) => station.systemId))].sort();
  for (const user of [...userById.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (user.active !== true) continue;
    const systemIds = new Set<string>();
    let statewide = false;
    let delegation: FinalizeAuthorityModel['delegation'] = null;
    for (const ent of grants) {
      if (ent.principalId !== user.id || !withinWindow(ent, atMs)) continue;
      const capabilities = ent.capabilities;
      if (!capabilities.includes('finalize-accounting')) continue;
      if (ent.scopeType === 'system' && ent.scopeId) systemIds.add(ent.scopeId);
      if (ent.scopeType === 'statewide') statewide = true;
      if (ent.delegation) delegation = ent.delegation;
    }
    const canFinalize = statewide ? allSystemIds : [...systemIds].sort();
    models.push({
      principalId: user.id,
      displayName: user.displayName,
      role: user.roles[0] ?? 'user',
      canFinalizeSystemIds: canFinalize,
      via: canFinalize.length > 0 ? 'finalize-accounting' : 'none',
      basis:
        canFinalize.length > 0
          ? statewide
            ? 'Assigned to finalize accounting statewide'
            : `Assigned to finalize accounting for ${canFinalize.join(', ')}`
          : 'no finalize authority',
      delegation,
    });
  }
  return models;
}

// ---------------------------------------------------------------------------
// Decision evidence demo (mirror of decisions.ts over the shell fixtures)
// ---------------------------------------------------------------------------

const MATURITY: Readonly<Record<string, number>> = { raw: 0, provisional: 1, reviewed: 2, 'best-available': 3 };
export type ProcessingBasisModel = 'raw' | 'provisional' | 'reviewed' | 'best-available';

function chainFor(observationId: string): RevisionRecord[] {
  return revisions
    .filter((revision) => revision.targetObservationId === observationId)
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || (a.id < b.id ? -1 : 1));
}

export interface EvidenceRow {
  readonly observationId: string;
  readonly logicalKey: string;
  readonly streamId: string;
  readonly observedAt: string;
  readonly revisionId: string | null;
  readonly usedVersion: number;
  readonly headRevisionId: string | null;
  readonly chainVersion: number;
  readonly usedProcessingLevel: string;
  readonly value: number | null;
  readonly belowSelectedBasis: boolean;
}

export interface DecisionEvidenceModel {
  readonly decisionId: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly period: PeriodSpecModel;
  readonly resolved: ResolvedPeriodModel;
  readonly processingBasis: ProcessingBasisModel;
  readonly evidence: readonly EvidenceRow[];
  readonly curveLineage: readonly { readonly streamId: string; readonly curveVersionIds: readonly string[]; readonly curveAtStart: string | null }[];
  readonly aggregationMethod: string;
  readonly evidenceHash: string;
}

/** Deterministic 64-bit-style digest (two FNV-1a 32-bit lanes) - demo stand-in for the server's sha256. */
export function demoDigest(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = (h1 ^ code) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + code + i) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(2);
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

function isFlowStream(stream: { observedPropertyId: string; unitId: string }): boolean {
  return stream.observedPropertyId === 'discharge' && stream.unitId === 'cfs';
}

/**
 * Demo decision snapshot over the fixture world: pins the EXACT revision ids
 * at the selected basis inside the half-open window. Later corrections do
 * not alter a built snapshot (it is a value object); rebuilding picks up new
 * chain heads.
 */
export function buildDecisionSnapshotDemo(request: {
  readonly period: PeriodSpecModel;
  readonly processingBasis: ProcessingBasisModel;
  readonly actorId: string;
  readonly now?: string;
  readonly systemId?: string;
}): { readonly ok: true; readonly value: DecisionEvidenceModel } | { readonly ok: false; readonly message: string } {
  const now = request.now ?? FIXTURE_CLOCK;
  const resolved = resolvePeriodModel(request.period);
  if (!resolved.ok) return resolved;
  const startMs = Date.parse(resolved.value.start);
  const endMs = Date.parse(resolved.value.end);
  const systemId = request.systemId ?? 'sys-bear-river';

  const evidence: EvidenceRow[] = [];
  const lineage: { streamId: string; curveVersionIds: string[]; curveAtStart: string | null }[] = [];
  for (const station of stations.filter((candidate) => candidate.systemId === systemId && candidate.status === 'active').sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (const stream of [...station.datastreams].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (!isFlowStream(stream)) continue;
      for (const observation of observations.filter((row) => row.streamId === stream.id).sort((a, b) => (a.id < b.id ? -1 : 1)) as ObservationRecord[]) {
        const at = Date.parse(observation.observedAt);
        if (at < startMs || at >= endMs) continue;
        const chain = chainFor(observation.id);
        const basis = request.processingBasis;
        const used =
          basis === 'raw' || chain.length === 0
            ? null
            : basis === 'best-available'
              ? chain[chain.length - 1]!
              : ([...chain].reverse().find((revision) => (MATURITY[revision.processingLevel] ?? 0) >= (MATURITY[basis] ?? 0)) ?? null);
        const head = chain[chain.length - 1] ?? null;
        evidence.push({
          observationId: observation.id,
          logicalKey: observation.logicalKey,
          streamId: observation.streamId,
          observedAt: observation.observedAt,
          revisionId: used ? used.id : null,
          usedVersion: used ? chain.indexOf(used) + 1 : 0,
          headRevisionId: head ? head.id : null,
          chainVersion: chain.length,
          usedProcessingLevel: used ? used.processingLevel : 'raw',
          value: used ? used.value : observation.value,
          belowSelectedBasis: used === null && basis !== 'raw' && chain.length > 0,
        });
      }
      const curveIds = (stream.ratingCurvePeriods ?? [])
        .slice()
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((period) => period.id);
      const atStart = (stream.ratingCurvePeriods ?? []).find(
        (period) => Date.parse(period.validFrom) <= startMs && (period.validTo === null || startMs < Date.parse(period.validTo)),
      );
      lineage.push({ streamId: stream.id, curveVersionIds: curveIds, curveAtStart: atStart?.id ?? null });    }
  }

  const preimage = {
    kind: 'decision-evidence@1',
    systemId,
    period: request.period,
    decidedBy: request.actorId,
    evidence: [...evidence].sort((a, b) => (a.observationId < b.observationId ? -1 : 1)),
    curveLineage: lineage,
    processingBasis: request.processingBasis,
  };
  const evidenceHash = demoDigest(canonicalize(preimage));
  return {
    ok: true,
    value: {
      decisionId: `dec-${evidenceHash.slice(0, 12)}`,
      decidedBy: request.actorId,
      decidedAt: now,
      period: request.period,
      resolved: resolved.value,
      processingBasis: request.processingBasis,
      evidence: [...evidence].sort((a, b) => (a.observationId < b.observationId ? -1 : 1)),
      curveLineage: lineage,
      aggregationMethod: 'rectangle-right@1',
      evidenceHash,
    },
  };
}

// ---------------------------------------------------------------------------
// Demo finalize ledger (mirror of finalize.ts semantics)
// ---------------------------------------------------------------------------

export type FinalizeDemoOutcome =
  | { readonly outcome: 'finalized'; readonly record: FinalizedLike; readonly replayed: boolean }
  | { readonly outcome: 'conflict'; readonly code: 'FINALIZE_CONFLICT'; readonly message: string; readonly currentFinalizedId: string | null }
  | { readonly outcome: 'denied'; readonly status: 401 | 403 | 404; readonly message: string };

export interface DemoFinalizeRequest {
  readonly actorId: string | null;
  readonly period: PeriodSpecModel;
  readonly contentTag: string;
  readonly expectedCurrentId: string | null;
  readonly reason?: string | null;
  readonly now?: string;
  readonly systemId?: string;
}

export function periodKeyModel(systemId: string, period: PeriodSpecModel): string {
  return canonicalize({ systemId, period });
}

/**
 * Demo ledger mirroring finalize.ts: explicit finalization capability,
 * optimistic concurrency guard (typed 409-style conflict), idempotent
 * replay, and supersession that never rewrites prior records.
 */
export class DemoFinalizeLedger {
  private readonly records: FinalizedLike[] = [];
  private readonly grants: readonly EntitlementRecord[];

  constructor(grants: readonly EntitlementRecord[] = entitlements) {
    this.grants = grants;
  }

  private authorityOf(actorId: string | null, systemId: string, now: string): FinalizeDemoOutcome | null {
    if (actorId === null) return { outcome: 'denied', status: 401, message: 'finalizing accounting requires an authenticated, active principal' };
    const authority = finalizeAuthorities(now, this.grants).find((candidate) => candidate.principalId === actorId);
    if (!authority) return { outcome: 'denied', status: 401, message: 'unknown principal' };
    if (!authority.canFinalizeSystemIds.includes(systemId)) {
      return { outcome: 'denied', status: 403, message: `actor is not permitted to finalize accounting for this system (${authority.basis}; rule pending owner ratification)` };
    }
    return null;
  }

  finalize(request: DemoFinalizeRequest): FinalizeDemoOutcome {
    const now = request.now ?? FIXTURE_CLOCK;
    const systemId = request.systemId ?? 'sys-bear-river';
    const denied = this.authorityOf(request.actorId, systemId, now);
    if (denied) return denied;
    const resolved = resolvePeriodModel(request.period);
    if (!resolved.ok) return { outcome: 'denied', status: 403, message: resolved.message };
    const periodKey = periodKeyModel(systemId, request.period);
    const chain = supersessionChain(this.records, periodKey);
    const head = chain[chain.length - 1]?.record ?? null;
    if ((head?.id ?? null) !== request.expectedCurrentId) {
      return {
        outcome: 'conflict',
        code: 'FINALIZE_CONFLICT',
        message:
          head === null
            ? `stale finalize: the period slot is empty; expected ${request.expectedCurrentId} to be current`
            : `stale finalize: the current finalized record of this period is ${head.id}; expected ${request.expectedCurrentId ?? 'an empty slot'}`,
        currentFinalizedId: head?.id ?? null,
      };
    }
    const contentHash = demoDigest(canonicalize({ systemId, periodKey, contentTag: request.contentTag }));
    if (head && head.contentHash === contentHash) {
      return { outcome: 'finalized', record: head, replayed: true };
    }
    if (head) {
      return {
        outcome: 'conflict',
        code: 'FINALIZE_CONFLICT',
        message: `the period slot already holds finalized record ${head.id}; different content must be superseded explicitly`,
        currentFinalizedId: head.id,
      };
    }
    const id = `fin-${demoDigest(canonicalize({ contentHash, supersedes: null, at: now, by: request.actorId })).slice(0, 12)}`;
    const record: FinalizedLike = { id, periodKey, contentHash, finalizedBy: request.actorId ?? 'anonymous', finalizedAt: now, supersedes: null, supersedeReason: null, decisionId: null };
    this.records.push(record);
    return { outcome: 'finalized', record, replayed: false };
  }

  finalizeSuperseding(request: DemoFinalizeRequest & { readonly reason: string }): FinalizeDemoOutcome {
    const now = request.now ?? FIXTURE_CLOCK;
    const systemId = request.systemId ?? 'sys-bear-river';
    const denied = this.authorityOf(request.actorId, systemId, now);
    if (denied) return denied;
    const periodKey = periodKeyModel(systemId, request.period);
    const chain = supersessionChain(this.records, periodKey);
    const head = chain[chain.length - 1]?.record ?? null;
    if (!head) return { outcome: 'denied', status: 403, message: 'the period slot holds no finalized record to supersede; finalize first' };
    if (request.reason.trim() === '') return { outcome: 'denied', status: 403, message: 'a superseding finalization must carry a non-empty reason' };
    if (head.id !== request.expectedCurrentId) {
      return { outcome: 'conflict', code: 'FINALIZE_CONFLICT', message: `stale supersede: current is ${head.id}`, currentFinalizedId: head.id };
    }
    const contentHash = demoDigest(canonicalize({ systemId, periodKey, contentTag: request.contentTag }));
    if (head.contentHash === contentHash) {
      return { outcome: 'denied', status: 403, message: 'the superseding content is identical to the current record' };
    }
    const id = `fin-${demoDigest(canonicalize({ contentHash, supersedes: head.id, at: now, by: request.actorId })).slice(0, 12)}`;
    const record: FinalizedLike = { id, periodKey, contentHash, finalizedBy: request.actorId ?? 'anonymous', finalizedAt: now, supersedes: head.id, supersedeReason: request.reason, decisionId: null };
    this.records.push(record);
    return { outcome: 'finalized', record, replayed: false };
  }

  chain(periodKey: string): readonly FinalizedChainView[] {
    return supersessionChain(this.records, periodKey);
  }

  readonly allRecords: readonly FinalizedLike[] = this.records;
}

// ---------------------------------------------------------------------------
// Supplemental advisory mirror (FR-030)
// ---------------------------------------------------------------------------

export const ADVISORY_LABEL_MODEL =
  'Advisory only - supplemental comparison against approved inputs; accounting semantics pending owner approval' as const;

export interface SupplementalInputModel {
  readonly id: string;
  readonly category: string;
  readonly label: string;
  readonly volumeAcreFeet: number;
  readonly status: 'approved' | 'pending';
}

export interface SupplementalRowModel {
  readonly category: string;
  readonly measuredVolumeAcreFeet: number;
  readonly supplementalVolumeAcreFeet: number;
  readonly differenceAcreFeet: number;
  readonly advisory: true;
  readonly advisoryLabel: string;
}

/** Fixture supplemental declarations (PENDING OWNER APPROVAL; mirrors the API fixture constant). */
export const DEMO_SUPPLEMENTAL_INPUTS: readonly SupplementalInputModel[] = [
  { id: 'supp-bear-natural-2026', category: 'natural-channel-flow', label: 'Bear River mainstem declared natural flow', volumeAcreFeet: 84.5, status: 'approved' },
  { id: 'supp-bear-canal-2026', category: 'canal-delivery', label: 'Bear River canal diversions declared use', volumeAcreFeet: 560.25, status: 'approved' },
  { id: 'supp-bear-release-2026', category: 'reservoir-release', label: 'Hyrum release declared use (STILL PENDING - never compared)', volumeAcreFeet: 300.0, status: 'pending' },
] as const;

/** Advisory comparison against APPROVED inputs only; the label is mandatory on every row. */
export function buildSupplementalRowsModel(measured: readonly { category: string; volumeAcreFeet: number }[], inputs: readonly SupplementalInputModel[] = DEMO_SUPPLEMENTAL_INPUTS): readonly SupplementalRowModel[] {
  const approved = inputs.filter((input) => input.status === 'approved');
  const categories = [...new Set([...measured.map((total) => total.category), ...approved.map((input) => input.category)])].sort();
  return categories.map((category) => {
    const measuredVolume = measured.find((total) => total.category === category)?.volumeAcreFeet ?? 0;
    const supplementalVolume = approved.filter((input) => input.category === category).reduce((sum, input) => sum + input.volumeAcreFeet, 0);
    return {
      category,
      measuredVolumeAcreFeet: measuredVolume,
      supplementalVolumeAcreFeet: supplementalVolume,
      differenceAcreFeet: measuredVolume - supplementalVolume,
      advisory: true as const,
      advisoryLabel: ADVISORY_LABEL_MODEL,
    };
  });
}

export function supplementalRowTextModel(row: SupplementalRowModel): string {
  return `${row.category}: measured ${row.measuredVolumeAcreFeet.toFixed(3)} vs approved supplemental ${row.supplementalVolumeAcreFeet.toFixed(3)} acre-feet (difference ${row.differenceAcreFeet.toFixed(3)}) - ${row.advisoryLabel}`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatHash(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 16)}…${hash.slice(-8)}`;
}

export function formatVolume(value: number | null): string {
  return value === null ? 'Unavailable' : `${value.toFixed(3)} acre-feet`;
}
