/**
 * Pure view models for the WD-013 quality feature (FR-015, FR-016, FR-034,
 * FR-036, FR-038).
 *
 * Dependency-free like quality-history/derivation.ts: no React, no fixture
 * imports, no clock reads. The panels feed these functions data (the frozen
 * fixtures by default, an API loader later) and render the returned rows.
 *
 * Accessibility contract enforced here: every status or flag carries BOTH a
 * shape marker and a text label (FR-034 "a symbol or text as well as
 * color"), and violation entries keep the filtered-context link (FR-016).
 *
 * The DEMO_* constants at the bottom mirror the reviewed expected QC
 * outcomes (services/api/src/workflows/qc/expected.ts,
 * reviewed-pending-owner-approval) so the panels' fixture-backed defaults
 * render the same story the API golden asserts.
 */

// ---------------------------------------------------------------------------
// Shared vocabulary (web-side copies of the QC workflow types)
// ---------------------------------------------------------------------------

export type QcRuleFamily = 'range' | 'rate-of-change' | 'persistence' | 'missing-data' | 'zero-value';
export type QcRuleStatus = 'draft' | 'test' | 'promoted';

export const FAMILY_ORDER: readonly QcRuleFamily[] = ['range', 'rate-of-change', 'persistence', 'missing-data', 'zero-value'];

export const FAMILY_LABELS: Readonly<Record<QcRuleFamily, string>> = {
  range: 'Range (incl. voltage)',
  'rate-of-change': 'Rate of change',
  persistence: 'Persistence (stuck sensor)',
  'missing-data': 'Missing data',
  'zero-value': 'Suspect zero',
};

export const CADENCES = ['hourly', 'twice-daily', 'daily', 'weekly'] as const;
export type DigestCadence = (typeof CADENCES)[number];

export const CADENCE_LABELS: Readonly<Record<DigestCadence, string>> = {
  hourly: 'Hourly',
  'twice-daily': 'Twice daily',
  daily: 'Daily',
  weekly: 'Weekly',
};

export type KnownIssueStatus = 'open' | 'monitoring' | 'resolved';
export type KnownIssueVisibility = 'public' | 'internal';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** '2026-03-08T20:00:00Z' -> '2026-03-08 20:00' (UTC, deterministic). */
export function formatInstantUtc(at: string): string {
  return at.slice(0, 16).replace('T', ' ');
}

/** Half-open interval label: '2026-03-08 20:00 → 21:00 UTC' (same-day short form). */
export function formatIntervalUtc(start: string, end: string): string {
  const s = formatInstantUtc(start);
  const e = formatInstantUtc(end);
  if (s.slice(0, 10) === e.slice(0, 10)) return `${s} → ${e.slice(11)} UTC`;
  return `${s} → ${e} UTC`;
}

// ---------------------------------------------------------------------------
// Rule list (FR-015: versions, authors, test-before-promote, isolation)
// ---------------------------------------------------------------------------

export interface RuleVersionView {
  readonly ruleId: string;
  readonly family: QcRuleFamily;
  readonly version: number;
  readonly status: QcRuleStatus;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunResultView {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly status: 'success' | 'failed';
  readonly violationCount: number;
  readonly error: string | null;
}

/** Text + shape, never color alone (draft ○ / test ◐ / promoted ●). */
export function ruleStatusBadge(status: QcRuleStatus): { readonly marker: string; readonly text: string } {
  if (status === 'promoted') return { marker: '●', text: 'promoted' };
  if (status === 'test') return { marker: '◐', text: 'fixture-tested' };
  return { marker: '○', text: 'draft' };
}

export function runStatusBadge(status: 'success' | 'failed'): { readonly marker: string; readonly text: string } {
  return status === 'success' ? { marker: '✓', text: 'success' } : { marker: '✕', text: 'failed' };
}

/**
 * Why the promote button is unavailable (null = available): steward-only
 * gate, no passing fixture test for THIS version, or already promoted.
 */
export function promoteBlockedReason(rule: RuleVersionView, lastRun: RunResultView | null, canPromote: boolean): string | null {
  if (rule.status === 'promoted') return 'Already promoted';
  if (!canPromote) return 'Steward only';
  if (lastRun === null || lastRun.status !== 'success' || lastRun.ruleVersion !== rule.version) return 'Requires a passing fixture test';
  return null;
}

export interface RuleRowModel {
  readonly ruleId: string;
  readonly familyLabel: string;
  readonly version: number;
  readonly author: string;
  readonly status: QcRuleStatus;
  readonly statusMarker: string;
  readonly statusText: string;
  readonly updatedAt: string;
  /** Latest monitoring/test result for THIS version (isolation made visible). */
  readonly lastRun: RunResultView | null;
  readonly canPromote: boolean;
  readonly promoteBlockedReason: string | null;
}

/** Latest result per (ruleId, version) from the run history, newest wins. */
export function latestRunByRuleVersion(runs: readonly RunResultView[]): ReadonlyMap<string, RunResultView> {
  const map = new Map<string, RunResultView>();
  for (const run of runs) map.set(`${run.ruleId}|v${run.ruleVersion}`, run);
  return map;
}

export function ruleRows(
  rules: readonly RuleVersionView[],
  runs: readonly RunResultView[],
  options: { readonly canPromote: boolean },
): readonly RuleRowModel[] {
  const latest = latestRunByRuleVersion(runs);
  return [...rules]
    .sort((a, b) => {
      const familyDelta = FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family);
      if (familyDelta !== 0) return familyDelta;
      if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
      return a.version - b.version;
    })
    .map((rule) => {
      const badge = ruleStatusBadge(rule.status);
      const lastRun = latest.get(`${rule.ruleId}|v${rule.version}`) ?? null;
      return {
        ruleId: rule.ruleId,
        familyLabel: FAMILY_LABELS[rule.family],
        version: rule.version,
        author: rule.author,
        status: rule.status,
        statusMarker: badge.marker,
        statusText: badge.text,
        updatedAt: formatInstantUtc(rule.updatedAt),
        lastRun,
        canPromote: options.canPromote,
        promoteBlockedReason: promoteBlockedReason(rule, lastRun, options.canPromote),
      };
    });
}

/** Summary of one monitoring run for the isolation banner: failures NEVER hide the successes. */
export function runSummary(runs: readonly RunResultView[]): { readonly succeeded: number; readonly failed: number; readonly totalViolations: number; readonly failureNotes: readonly string[] } {
  let succeeded = 0;
  let failed = 0;
  let totalViolations = 0;
  const failureNotes: string[] = [];
  for (const run of runs) {
    if (run.status === 'success') {
      succeeded += 1;
      totalViolations += run.violationCount;
    } else {
      failed += 1;
      if (run.error !== null) failureNotes.push(run.error);
    }
  }
  return { succeeded, failed, totalViolations, failureNotes };
}

// ---------------------------------------------------------------------------
// Violation digest (FR-016: type sorting, context links, scope filtering)
// ---------------------------------------------------------------------------

export interface ViolationEntryView {
  readonly family: QcRuleFamily;
  readonly streamId: string;
  readonly interval: { readonly start: string; readonly end: string };
  readonly observed: string;
  readonly rationale: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
}

export interface ViolationRowModel {
  readonly family: QcRuleFamily;
  readonly typeLabel: string;
  readonly streamId: string;
  readonly intervalLabel: string;
  readonly observed: string;
  readonly rationale: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly contextLink: string;
}

/** The filtered-context link (the FR-016 "matching context"). */
export function contextLink(entry: ViolationEntryView): string {
  return `stream=${entry.streamId}&type=${entry.family}&from=${entry.interval.start}&to=${entry.interval.end}`;
}

export function violationRows(
  entries: readonly ViolationEntryView[],
  options: { readonly sortBy?: 'type' | 'time' } = {},
): readonly ViolationRowModel[] {
  const sortBy = options.sortBy ?? 'type';
  return [...entries]
    .sort((a, b) => {
      if (sortBy === 'time') {
        if (a.interval.start !== b.interval.start) return a.interval.start < b.interval.start ? -1 : 1;
      } else {
        const familyDelta = FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family);
        if (familyDelta !== 0) return familyDelta;
      }
      if (a.streamId !== b.streamId) return a.streamId < b.streamId ? -1 : 1;
      if (a.interval.start !== b.interval.start) return a.interval.start < b.interval.start ? -1 : 1;
      return a.ruleId < b.ruleId ? -1 : 1;
    })
    .map((entry) => ({
      family: entry.family,
      typeLabel: FAMILY_LABELS[entry.family],
      streamId: entry.streamId,
      intervalLabel: formatIntervalUtc(entry.interval.start, entry.interval.end),
      observed: entry.observed,
      rationale: entry.rationale,
      ruleId: entry.ruleId,
      ruleVersion: entry.ruleVersion,
      contextLink: contextLink(entry),
    }));
}

export interface DigestCountsView {
  readonly included: number;
  readonly duplicatesDropped: number;
  readonly omittedForAuthorization: number;
  readonly alreadyDelivered: number;
}

// ---------------------------------------------------------------------------
// Subscriptions (FR-016: system/stream scope, four cadences)
// ---------------------------------------------------------------------------

export type SubscriptionScopeView = { readonly kind: 'system' | 'stream'; readonly id: string };

export interface SubscriptionView {
  readonly id: string;
  readonly recipientId: string;
  readonly scope: SubscriptionScopeView;
  readonly cadence: DigestCadence;
  readonly createdAt: string;
  readonly nextDueAt: string;
  readonly status: 'active' | 'cancelled';
}

export function scopeLabel(scope: SubscriptionScopeView): string {
  return scope.kind === 'system' ? `System ${scope.id}` : `Stream ${scope.id}`;
}

export interface SubscriptionRowModel {
  readonly id: string;
  readonly scopeLabel: string;
  readonly cadenceLabel: string;
  readonly nextDueLabel: string;
  readonly status: 'active' | 'cancelled';
}

export function subscriptionRows(subscriptions: readonly SubscriptionView[]): readonly SubscriptionRowModel[] {
  return [...subscriptions]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((subscription) => ({
      id: subscription.id,
      scopeLabel: scopeLabel(subscription.scope),
      cadenceLabel: CADENCE_LABELS[subscription.cadence],
      nextDueLabel: formatInstantUtc(subscription.nextDueAt),
      status: subscription.status,
    }));
}

// ---------------------------------------------------------------------------
// Diagnostics (FR-036: engineer-only; FR-034: labelled flags)
// ---------------------------------------------------------------------------

export type ThresholdSeverity = 'info' | 'warn' | 'critical';

export interface IndicatorView {
  readonly flagId: string;
  readonly streamId: string;
  readonly observedAt: string;
  readonly label: string;
  readonly symbol: string;
  readonly severity: ThresholdSeverity;
  readonly text: string;
}

export interface DiagnosticStreamView {
  readonly streamId: string;
  readonly stationId: string;
  readonly systemId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  readonly visibility: 'public' | 'restricted' | 'internal';
  readonly latest: { readonly observedAt: string; readonly value: number | null } | null;
  readonly indicators: readonly IndicatorView[];
}

export interface IndicatorBadgeModel {
  readonly symbol: string;
  readonly label: string;
  readonly severityLabel: string;
  readonly text: string;
}

export const SEVERITY_LABELS: Readonly<Record<ThresholdSeverity, string>> = { info: 'info', warn: 'warning', critical: 'critical' };

/** Every badge carries symbol + label + severity text (never color alone). */
export function indicatorBadges(indicators: readonly IndicatorView[]): readonly IndicatorBadgeModel[] {
  const rank: Readonly<Record<ThresholdSeverity, number>> = { info: 0, warn: 1, critical: 2 };
  return [...indicators]
    .sort((a, b) => rank[b.severity] - rank[a.severity] || (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0))
    .map((indicator) => ({
      symbol: indicator.symbol,
      label: indicator.label,
      severityLabel: SEVERITY_LABELS[indicator.severity],
      text: indicator.text,
    }));
}

export interface DiagnosticsRowModel {
  readonly streamId: string;
  readonly stationId: string;
  readonly propertyLabel: string;
  readonly visibility: 'public' | 'restricted' | 'internal';
  readonly latestLabel: string;
  readonly badges: readonly IndicatorBadgeModel[];
}

const PROPERTY_LABELS: Readonly<Record<string, string>> = { discharge: 'Discharge', stage: 'Level (stage)', voltage: 'Voltage' };

export function diagnosticsRows(streams: readonly DiagnosticStreamView[]): readonly DiagnosticsRowModel[] {
  return [...streams]
    .sort((a, b) => (a.streamId < b.streamId ? -1 : 1))
    .map((stream) => ({
      streamId: stream.streamId,
      stationId: stream.stationId,
      propertyLabel: PROPERTY_LABELS[stream.observedPropertyId] ?? stream.observedPropertyId,
      visibility: stream.visibility,
      latestLabel:
        stream.latest === null
          ? 'no readings'
          : `${stream.latest.value === null ? 'no value' : `${stream.latest.value} ${stream.unitId}`} · ${formatInstantUtc(stream.latest.observedAt)} UTC`,
      badges: indicatorBadges(stream.indicators),
    }));
}

// ---------------------------------------------------------------------------
// Known issues (FR-038: lifecycle, visibility, resolution history)
// ---------------------------------------------------------------------------

export interface ResolutionEventView {
  readonly seq: number;
  readonly at: string;
  readonly actorId: string;
  readonly from: KnownIssueStatus;
  readonly to: KnownIssueStatus;
  readonly note: string;
}

export interface KnownIssueView {
  readonly id: string;
  readonly streamId: string;
  readonly interval: { readonly start: string; readonly end: string };
  readonly title: string;
  readonly status: KnownIssueStatus;
  readonly visibility: KnownIssueVisibility;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly resolutionHistory: readonly ResolutionEventView[];
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
}

/** Text + shape: open ● / monitoring ◐ / resolved ✓. */
export function issueStatusBadge(status: KnownIssueStatus): { readonly marker: string; readonly text: string } {
  if (status === 'resolved') return { marker: '✓', text: 'resolved' };
  if (status === 'monitoring') return { marker: '◐', text: 'monitoring' };
  return { marker: '●', text: 'open' };
}

export interface KnownIssueRowModel {
  readonly id: string;
  readonly title: string;
  readonly streamId: string;
  readonly intervalLabel: string;
  readonly statusMarker: string;
  readonly statusText: string;
  readonly visibility: KnownIssueVisibility;
  readonly visibilityNote: string;
  readonly recordedLabel: string;
  readonly resolvedLabel: string | null;
  readonly history: readonly ResolutionEventView[];
}

export function knownIssueRows(issues: readonly KnownIssueView[]): readonly KnownIssueRowModel[] {
  return [...issues]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((issue) => {
      const badge = issueStatusBadge(issue.status);
      return {
        id: issue.id,
        title: issue.title,
        streamId: issue.streamId,
        intervalLabel: formatIntervalUtc(issue.interval.start, issue.interval.end),
        statusMarker: badge.marker,
        statusText: badge.text,
        visibility: issue.visibility,
        visibilityNote: issue.visibility === 'public' ? 'Visible in public charts and exports' : 'Internal: authorized views only, never public exports',
        recordedLabel: `${formatInstantUtc(issue.recordedAt)} UTC by ${issue.recordedBy}`,
        resolvedLabel: issue.resolvedAt === null ? null : `${formatInstantUtc(issue.resolvedAt)} UTC by ${issue.resolvedBy ?? 'unknown'}`,
        history: [...issue.resolutionHistory].sort((a, b) => a.seq - b.seq),
      };
    });
}

// ---------------------------------------------------------------------------
// Fixture-derived demo state (panel defaults)
//
// These constants mirror the REVIEWED EXPECTED QC OUTCOMES on the contract
// fixtures (services/api/src/workflows/qc/expected.ts,
// reviewed-pending-owner-approval): the five promoted rule versions with
// their golden counts (range 3, rate-of-change 6, persistence 0,
// missing-data 10, zero-value 1 = 20 fixture violations), one draft revision
// whose run failed in isolation, the full 20-entry digest for the Bear
// engineer (all streams authorized), and the two known issues. An API-backed
// loader replaces them through props without touching the panels.
// ---------------------------------------------------------------------------

const AUTHOR = 'principal-diego-steward';
const AUTHORED_AT = '2026-03-09T07:00:00Z';

export const DEMO_RULES: readonly RuleVersionView[] = [
  { ruleId: 'qc-range', family: 'range', version: 1, status: 'promoted', author: AUTHOR, createdAt: AUTHORED_AT, updatedAt: AUTHORED_AT },
  { ruleId: 'qc-range', family: 'range', version: 2, status: 'draft', author: AUTHOR, createdAt: '2026-03-10T14:00:00Z', updatedAt: '2026-03-10T14:00:00Z' },
  { ruleId: 'qc-rate-of-change', family: 'rate-of-change', version: 1, status: 'promoted', author: AUTHOR, createdAt: AUTHORED_AT, updatedAt: AUTHORED_AT },
  { ruleId: 'qc-persistence', family: 'persistence', version: 1, status: 'promoted', author: AUTHOR, createdAt: AUTHORED_AT, updatedAt: AUTHORED_AT },
  { ruleId: 'qc-missing-data', family: 'missing-data', version: 1, status: 'promoted', author: AUTHOR, createdAt: AUTHORED_AT, updatedAt: AUTHORED_AT },
  { ruleId: 'qc-zero-value', family: 'zero-value', version: 1, status: 'promoted', author: AUTHOR, createdAt: AUTHORED_AT, updatedAt: AUTHORED_AT },
];

export const DEMO_RUN_RESULTS: readonly RunResultView[] = [
  { ruleId: 'qc-range', ruleVersion: 1, status: 'success', violationCount: 3, error: null },
  { ruleId: 'qc-range', ruleVersion: 2, status: 'failed', violationCount: 0, error: 'rule qc-range v2 threw: simulated evaluator crash (isolation: the other rules kept their counts)' },
  { ruleId: 'qc-rate-of-change', ruleVersion: 1, status: 'success', violationCount: 6, error: null },
  { ruleId: 'qc-persistence', ruleVersion: 1, status: 'success', violationCount: 0, error: null },
  { ruleId: 'qc-missing-data', ruleVersion: 1, status: 'success', violationCount: 10, error: null },
  { ruleId: 'qc-zero-value', ruleVersion: 1, status: 'success', violationCount: 1, error: null },
];

/** The 20 reviewed fixture violations (the expected.ts golden), type-sorted by violationRows(). */
export const DEMO_DIGEST_ENTRIES: readonly ViolationEntryView[] = [
  { family: 'range', streamId: 'str-corinne-q', interval: { start: '2026-03-08T02:00:00Z', end: '2026-03-08T03:00:00Z' }, observed: '-1.2 cfs', rationale: 'value -1.2 cfs is below the rule minimum 0 cfs for property discharge (rule qc-range v1)', ruleId: 'qc-range', ruleVersion: 1 },
  { family: 'range', streamId: 'str-corinne-q', interval: { start: '2026-03-08T20:00:00Z', end: '2026-03-08T21:00:00Z' }, observed: '9500 cfs', rationale: 'value 9500 cfs is above the rule maximum 1200 cfs for property discharge (rule qc-range v1)', ruleId: 'qc-range', ruleVersion: 1 },
  { family: 'range', streamId: 'str-diag-voltage', interval: { start: '2026-03-09T06:00:00Z', end: '2026-03-09T07:00:00Z' }, observed: '11.1 V', rationale: 'value 11.1 V is below the rule minimum 11.5 V for property voltage (rule qc-range v1)', ruleId: 'qc-range', ruleVersion: 1 },
  { family: 'rate-of-change', streamId: 'str-corinne-q', interval: { start: '2026-03-07T15:00:00Z', end: '2026-03-07T16:00:00Z' }, observed: 'delta -19.5 cfs over 2 intervals', rationale: 'rate of change 9.75 cfs/interval exceeds the rule maximum 5 cfs/interval for property discharge (rule qc-rate-of-change v1)', ruleId: 'qc-rate-of-change', ruleVersion: 1 },
  { family: 'rate-of-change', streamId: 'str-corinne-q', interval: { start: '2026-03-07T16:00:00Z', end: '2026-03-07T17:00:00Z' }, observed: 'delta 19.6 cfs over 1 interval', rationale: 'rate of change 19.6 cfs/interval exceeds the rule maximum 5 cfs/interval for property discharge (rule qc-rate-of-change v1)', ruleId: 'qc-rate-of-change', ruleVersion: 1 },
  { family: 'rate-of-change', streamId: 'str-corinne-q', interval: { start: '2026-03-08T02:00:00Z', end: '2026-03-08T03:00:00Z' }, observed: 'delta -22 cfs over 1 interval', rationale: 'rate of change 22 cfs/interval exceeds the rule maximum 5 cfs/interval for property discharge (rule qc-rate-of-change v1)', ruleId: 'qc-rate-of-change', ruleVersion: 1 },
  { family: 'rate-of-change', streamId: 'str-corinne-q', interval: { start: '2026-03-08T03:00:00Z', end: '2026-03-08T04:00:00Z' }, observed: 'delta 22.2 cfs over 1 interval', rationale: 'rate of change 22.2 cfs/interval exceeds the rule maximum 5 cfs/interval for property discharge (rule qc-rate-of-change v1)', ruleId: 'qc-rate-of-change', ruleVersion: 1 },
  { family: 'rate-of-change', streamId: 'str-corinne-q', interval: { start: '2026-03-08T20:00:00Z', end: '2026-03-08T21:00:00Z' }, observed: 'delta 9476.2 cfs over 1 interval', rationale: 'rate of change 9476.2 cfs/interval exceeds the rule maximum 5 cfs/interval for property discharge (rule qc-rate-of-change v1)', ruleId: 'qc-rate-of-change', ruleVersion: 1 },
  { family: 'rate-of-change', streamId: 'str-corinne-q', interval: { start: '2026-03-08T21:00:00Z', end: '2026-03-08T22:00:00Z' }, observed: 'delta -9475.8 cfs over 1 interval', rationale: 'rate of change 9475.8 cfs/interval exceeds the rule maximum 5 cfs/interval for property discharge (rule qc-rate-of-change v1)', ruleId: 'qc-rate-of-change', ruleVersion: 1 },
  { family: 'missing-data', streamId: 'str-corinne-q', interval: { start: '2026-03-07T06:00:00Z', end: '2026-03-07T07:00:00Z' }, observed: '1 missing reading', rationale: 'no reading for 120 minutes (1 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)', ruleId: 'qc-missing-data', ruleVersion: 1 },
  { family: 'missing-data', streamId: 'str-corinne-q', interval: { start: '2026-03-07T14:00:00Z', end: '2026-03-07T15:00:00Z' }, observed: '1 missing reading', rationale: 'no reading for 120 minutes (1 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)', ruleId: 'qc-missing-data', ruleVersion: 1 },
  { family: 'missing-data', streamId: 'str-corinne-q', interval: { start: '2026-03-08T12:00:00Z', end: '2026-03-08T18:00:00Z' }, observed: '6 missing readings', rationale: 'no reading for 420 minutes (6 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)', ruleId: 'qc-missing-data', ruleVersion: 1 },
  { family: 'missing-data', streamId: 'str-corinne-stage', interval: { start: '2026-03-07T13:00:00Z', end: '2026-03-08T00:00:00Z' }, observed: '11 missing readings', rationale: 'no reading for 720 minutes (11 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)', ruleId: 'qc-missing-data', ruleVersion: 1 },
  { family: 'missing-data', streamId: 'str-corinne-stage', interval: { start: '2026-03-08T01:00:00Z', end: '2026-03-08T20:00:00Z' }, observed: '19 missing readings', rationale: 'no reading for 1200 minutes (19 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)', ruleId: 'qc-missing-data', ruleVersion: 1 },
  { family: 'missing-data', streamId: 'str-corinne-stage', interval: { start: '2026-03-08T21:00:00Z', end: '2026-03-09T06:00:00Z' }, observed: '9 missing readings', rationale: 'no reading for 600 minutes (9 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)', ruleId: 'qc-missing-data', ruleVersion: 1 },
  { family: 'missing-data', streamId: 'str-diag-voltage', interval: { start: '2026-03-07T13:00:00Z', end: '2026-03-08T00:00:00Z' }, observed: '11 missing readings', rationale: 'no reading for 720 minutes (11 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)', ruleId: 'qc-missing-data', ruleVersion: 1 },
  { family: 'missing-data', streamId: 'str-diag-voltage', interval: { start: '2026-03-08T01:00:00Z', end: '2026-03-08T12:00:00Z' }, observed: '11 missing readings', rationale: 'no reading for 720 minutes (11 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)', ruleId: 'qc-missing-data', ruleVersion: 1 },
  { family: 'missing-data', streamId: 'str-diag-voltage', interval: { start: '2026-03-08T13:00:00Z', end: '2026-03-09T00:00:00Z' }, observed: '11 missing readings', rationale: 'no reading for 720 minutes (11 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)', ruleId: 'qc-missing-data', ruleVersion: 1 },
  { family: 'missing-data', streamId: 'str-diag-voltage', interval: { start: '2026-03-09T01:00:00Z', end: '2026-03-09T06:00:00Z' }, observed: '5 missing readings', rationale: 'no reading for 360 minutes (5 expected at 60-minute cadence), beyond the rule threshold 1.5x cadence (rule qc-missing-data v1)', ruleId: 'qc-missing-data', ruleVersion: 1 },
  { family: 'zero-value', streamId: 'str-corinne-q', interval: { start: '2026-03-07T15:00:00Z', end: '2026-03-07T16:00:00Z' }, observed: 'exact 0 cfs', rationale: 'isolated exact zero between non-zero readings (previous 19.5, next 19.6) on a 60-minute cadence stream where readings are expected: a suspect flat zero, not a measured zero (rule qc-zero-value v1)', ruleId: 'qc-zero-value', ruleVersion: 1 },
];

export const DEMO_DIGEST_COUNTS: DigestCountsView = { included: 20, duplicatesDropped: 0, omittedForAuthorization: 0, alreadyDelivered: 0 };

export const DEMO_SUBSCRIPTIONS: readonly SubscriptionView[] = [
  { id: 'qsub-000001', recipientId: 'principal-fatima-engineer', scope: { kind: 'system', id: 'sys-bear-river' }, cadence: 'daily', createdAt: '2026-03-09T07:00:00Z', nextDueAt: '2026-03-10T07:00:00Z', status: 'active' },
  { id: 'qsub-000002', recipientId: 'principal-fatima-engineer', scope: { kind: 'stream', id: 'str-diag-voltage' }, cadence: 'hourly', createdAt: '2026-03-09T07:00:00Z', nextDueAt: '2026-03-09T08:00:00Z', status: 'active' },
];

export const DEMO_DIAGNOSTIC_STREAMS: readonly DiagnosticStreamView[] = [
  {
    streamId: 'str-corinne-q',
    stationId: 'sta-bear-corinne',
    systemId: 'sys-bear-river',
    observedPropertyId: 'discharge',
    unitId: 'cfs',
    visibility: 'public',
    latest: { observedAt: '2026-03-09T06:00:00Z', value: 26 },
    indicators: [
      { flagId: 'capacity-warn', streamId: 'str-corinne-q', observedAt: '2026-03-09T06:00:00Z', label: 'Above typical late-winter capacity', symbol: '▲', severity: 'warn', text: '▲ Above typical late-winter capacity: 26 cfs (at or above 24 cfs)' },
      { flagId: 'capacity-spike', streamId: 'str-corinne-q', observedAt: '2026-03-08T20:00:00Z', label: 'Spike far above rated capacity', symbol: '‼', severity: 'critical', text: '‼ Spike far above rated capacity: 9500 cfs (at or above 1000 cfs)' },
    ],
  },
  {
    streamId: 'str-corinne-stage',
    stationId: 'sta-bear-corinne',
    systemId: 'sys-bear-river',
    observedPropertyId: 'stage',
    unitId: 'ft',
    visibility: 'public',
    latest: { observedAt: '2026-03-09T06:00:00Z', value: 2.58 },
    indicators: [],
  },
  {
    streamId: 'str-diag-voltage',
    stationId: 'sta-bear-lake-diagnostic',
    systemId: 'sys-bear-river',
    observedPropertyId: 'voltage',
    unitId: 'V',
    visibility: 'internal',
    latest: { observedAt: '2026-03-09T06:00:00Z', value: 11.1 },
    indicators: [
      { flagId: 'voltage-low', streamId: 'str-diag-voltage', observedAt: '2026-03-09T06:00:00Z', label: 'Battery voltage at or below minimum', symbol: '▼', severity: 'warn', text: '▼ Battery voltage at or below minimum: 11.1 V (at or below 11.5 V)' },
    ],
  },
  {
    streamId: 'str-hyrum-q-owner',
    stationId: 'sta-hyrum-diversion-owner',
    systemId: 'sys-bear-river',
    observedPropertyId: 'discharge',
    unitId: 'cfs',
    visibility: 'restricted',
    latest: { observedAt: '2026-03-08T17:00:00Z', value: 10.4 },
    indicators: [],
  },
];

export const DEMO_KNOWN_ISSUES: readonly KnownIssueView[] = [
  {
    id: 'issue-000001',
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-08T12:00:00Z', end: '2026-03-08T18:00:00Z' },
    title: 'Logger communications outage - six hourly readings missing',
    status: 'resolved',
    visibility: 'public',
    recordedBy: 'principal-diego-steward',
    recordedAt: '2026-03-09T07:00:00Z',
    resolutionHistory: [
      { seq: 1, at: '2026-03-09T07:30:00Z', actorId: 'principal-diego-steward', from: 'open', to: 'monitoring', note: 'Watching the logger transport; readings stay missing, never back-filled.' },
      { seq: 2, at: '2026-03-09T09:00:00Z', actorId: 'principal-cody-commissioner', from: 'monitoring', to: 'resolved', note: 'Transport restored 18:00Z; gap reviewed in the weekly cycle.' },
    ],
    resolvedAt: '2026-03-09T09:00:00Z',
    resolvedBy: 'principal-cody-commissioner',
  },
  {
    id: 'issue-000002',
    streamId: 'str-diag-voltage',
    interval: { start: '2026-03-09T06:00:00Z', end: '2026-03-09T07:00:00Z' },
    title: 'Battery voltage below minimum at Garden City diagnostic site',
    status: 'open',
    visibility: 'internal',
    recordedBy: 'principal-cody-commissioner',
    recordedAt: '2026-03-09T07:10:00Z',
    resolutionHistory: [],
    resolvedAt: null,
    resolvedBy: null,
  },
];
