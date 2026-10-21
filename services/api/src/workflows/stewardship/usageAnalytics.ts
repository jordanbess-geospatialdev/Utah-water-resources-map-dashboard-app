/**
 * Aggregated steward usage analytics (WD-014; FR-017).
 *
 * "Approved analytics report visitor, user and download counts by day,
 * month and year; credentials, sensitive query content and internal records
 * are excluded from third-party telemetry."
 *
 * This module mirrors the WD-020 consent-gate semantics
 * (services/api/src/support/analytics.ts) for the STEWARD-side aggregate
 * report over fixture usage event records:
 *
 * - CONSENT-GATED: an event is counted ONLY when its account has an
 *   explicit granted consent record at the CURRENT analytics policy
 *   version (ANALYTICS_POLICY_VERSION). Absent, withdrawn, or answered
 *   against an older proposal - all mean excluded. This is the same gate
 *   WD-020 applies at collection time, applied again at aggregation time
 *   (defense in depth: the aggregate cannot resurrect unconsented events).
 * - STATIC FIELD ALLOWLIST: kind, occurredAt, accountId - nothing else.
 *   An event carrying ANY additional field (query content, filters,
 *   credentials, notes) is dropped whole, never partially recorded and
 *   never "cleaned" into shape. The allowlist admits no shape in which
 *   query content could travel, so callers cannot smuggle one in.
 * - NO IDENTIFIERS OR CONTENT IN OUTPUT: aggregates are counts by period
 *   (day/month/year, keyed in the program zone America/Denver) and event
 *   kind only. Account ids, route ids, query strings and free text never
 *   appear in a report - verified structurally by tests.
 * - Period keys derive from the program-zone day key, so a browser clock
 *   never redefines a reporting day (numerical and temporal rules).
 */
import {
  ANALYTICS_POLICY_VERSION,
  consentStorageKey,
  inMemoryConsentStorage,
  programDayKey,
  readConsent,
  type ConsentStorage,
} from '../../support/analytics.ts';

// ---------------------------------------------------------------------------
// Event model
// ---------------------------------------------------------------------------

export const USAGE_EVENT_KINDS = ['session', 'export', 'api-token-verification'] as const;
export type UsageEventKind = (typeof USAGE_EVENT_KINDS)[number];

/** The whole allowlist: an event carrying any other own field is dropped whole. */
export const USAGE_EVENT_FIELD_ALLOWLIST = ['kind', 'occurredAt', 'accountId'] as const;

/**
 * Permissive input shape on purpose: aggregation validates against the
 * allowlist so hostile extra fields (query content, credentials) are
 * excluded structurally rather than by trusting the producer.
 */
export interface UsageEventInput {
  readonly kind: unknown;
  readonly occurredAt: unknown;
  readonly accountId: unknown;
  readonly [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export interface UsagePeriodCounts {
  readonly sessions: number;
  readonly exports: number;
  readonly apiTokenVerifications: number;
}

export interface UsageAggregate {
  readonly period: 'day' | 'month' | 'year';
  /** Program-zone calendar key: YYYY-MM-DD, YYYY-MM or YYYY. */
  readonly key: string;
  readonly counts: UsagePeriodCounts;
  readonly total: number;
}

export type ExclusionReason = 'unknown-account' | 'consent-required' | 'field-not-allowed' | 'unknown-kind';

export interface UsageReport {
  readonly byDay: readonly UsageAggregate[];
  readonly byMonth: readonly UsageAggregate[];
  readonly byYear: readonly UsageAggregate[];
  /** Counts only - never which accounts, never what content. */
  readonly excludedEvents: number;
  readonly excludedByReason: Readonly<Record<ExclusionReason, number>>;
}

const EMPTY_COUNTS: UsagePeriodCounts = { sessions: 0, exports: 0, apiTokenVerifications: 0 };

function addKind(counts: UsagePeriodCounts, kind: UsageEventKind): UsagePeriodCounts {
  if (kind === 'session') return { ...counts, sessions: counts.sessions + 1 };
  if (kind === 'export') return { ...counts, exports: counts.exports + 1 };
  return { ...counts, apiTokenVerifications: counts.apiTokenVerifications + 1 };
}

interface PeriodBucket {
  readonly period: UsageAggregate['period'];
  readonly keyOf: (dayKey: string) => string;
}

const PERIODS: readonly PeriodBucket[] = [
  { period: 'day', keyOf: (day) => day },
  { period: 'month', keyOf: (day) => day.slice(0, 7) },
  { period: 'year', keyOf: (day) => day.slice(0, 4) },
];

/**
 * Aggregate fixture usage events into steward-visible counts.
 *
 * Gate order per event: known account -> granted consent at the current
 * policy version -> allowlisted own fields -> known kind. Any failure
 * excludes the WHOLE event and increments exactly one exclusion counter.
 * Included events are reduced to (program-zone day key, kind) - the output
 * carries no identifiers and no content of any kind.
 */
export function aggregateUsage(
  events: readonly UsageEventInput[],
  consent: ConsentStorage,
  knownAccountIds: readonly string[],
): UsageReport {
  const known = new Set(knownAccountIds);
  const excludedByReason: Record<ExclusionReason, number> = { 'unknown-account': 0, 'consent-required': 0, 'field-not-allowed': 0, 'unknown-kind': 0 };
  const allowed = new Set<string>(USAGE_EVENT_FIELD_ALLOWLIST);

  const countsByPeriod: Record<string, Map<string, UsagePeriodCounts>> = { day: new Map(), month: new Map(), year: new Map() };
  let excludedEvents = 0;

  for (const event of events) {
    const accountId = event.accountId;
    if (typeof accountId !== 'string' || !known.has(accountId)) {
      excludedEvents += 1;
      excludedByReason['unknown-account'] += 1;
      continue;
    }
    const record = readConsent(consent, accountId);
    if (record === null || record.granted !== true || record.policyVersion !== ANALYTICS_POLICY_VERSION) {
      excludedEvents += 1;
      excludedByReason['consent-required'] += 1;
      continue;
    }
    const ownKeys = Object.keys(event);
    if (ownKeys.some((key) => !allowed.has(key))) {
      // Hostile or accidental extra field: dropped whole (FR-017 exclusion; WD-020 mirror).
      excludedEvents += 1;
      excludedByReason['field-not-allowed'] += 1;
      continue;
    }
    if (typeof event.kind !== 'string' || !(USAGE_EVENT_KINDS as readonly string[]).includes(event.kind)) {
      excludedEvents += 1;
      excludedByReason['unknown-kind'] += 1;
      continue;
    }
    const occurredAt = typeof event.occurredAt === 'string' ? event.occurredAt : null;
    if (occurredAt === null || Number.isNaN(Date.parse(occurredAt))) {
      excludedEvents += 1;
      excludedByReason['field-not-allowed'] += 1;
      continue;
    }
    const dayKey = programDayKey(occurredAt); // program zone (America/Denver)
    const kind = event.kind as UsageEventKind;
    for (const period of PERIODS) {
      const key = period.keyOf(dayKey);
      const map = countsByPeriod[period.period]!;
      map.set(key, addKind(map.get(key) ?? EMPTY_COUNTS, kind));
    }
  }

  const toAggregates = (period: UsageAggregate['period']): UsageAggregate[] =>
    [...countsByPeriod[period]!.entries()]
      .map(([key, counts]) => ({ period, key, counts, total: counts.sessions + counts.exports + counts.apiTokenVerifications }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));

  return {
    byDay: toAggregates('day'),
    byMonth: toAggregates('month'),
    byYear: toAggregates('year'),
    excludedEvents,
    excludedByReason,
  };
}

// ---------------------------------------------------------------------------
// Fixture seed (deterministic synthetic usage records)
// ---------------------------------------------------------------------------

/** Fixture account ids used by the seed (principals.json). */
export const SEED_ACCOUNT_IDS = [
  'principal-diego-steward',
  'principal-fatima-engineer',
  'principal-sarah-researcher',
  'principal-priya-engineer',
  'principal-cody-commissioner',
] as const;

/**
 * Seed consent ledger: Diego, Fatima and Sarah granted consent at the
 * CURRENT policy version; Cody answered an OLDER proposal (stale consent is
 * consent ABSENT - re-ask, never inherit); Priya never answered.
 */
export function seedUsageConsent(): ConsentStorage {
  const storage = inMemoryConsentStorage();
  const grant = (accountId: string, policyVersion: string): void => {
    storage.setItem(consentStorageKey(accountId), JSON.stringify({ accountId, granted: true, decidedAt: '2026-02-01T00:00:00Z', policyVersion }));
  };
  grant('principal-diego-steward', ANALYTICS_POLICY_VERSION);
  grant('principal-fatima-engineer', ANALYTICS_POLICY_VERSION);
  grant('principal-sarah-researcher', ANALYTICS_POLICY_VERSION);
  grant('principal-cody-commissioner', '2020-01-01.0'); // stale: excluded
  return storage;
}

/**
 * Deterministic synthetic usage events spanning the fixture weekend
 * (Fri 2026-03-06 .. Tue 2026-03-10, America/Denver), including:
 * - a 2026-03-07T02:00:00Z event whose UTC date differs from its Denver
 *   date (2026-03-06 19:00 MST) to pin program-zone day keying;
 * - events for a non-consented account (Priya) and a stale-consent account
 *   (Cody) that MUST be excluded;
 * - one hostile event carrying `query` content beyond the allowlist that
 *   MUST be dropped whole and never appear in any aggregate.
 */
export function seedUsageEvents(): readonly UsageEventInput[] {
  return [
    { kind: 'session', occurredAt: '2026-03-06T15:00:00Z', accountId: 'principal-diego-steward' },
    { kind: 'session', occurredAt: '2026-03-06T22:30:00Z', accountId: 'principal-fatima-engineer' },
    { kind: 'export', occurredAt: '2026-03-07T02:00:00Z', accountId: 'principal-diego-steward' }, // Denver day 2026-03-06 (MST)
    { kind: 'session', occurredAt: '2026-03-07T16:00:00Z', accountId: 'principal-sarah-researcher' },
    { kind: 'api-token-verification', occurredAt: '2026-03-07T18:00:00Z', accountId: 'principal-sarah-researcher' },
    { kind: 'session', occurredAt: '2026-03-08T05:00:00Z', accountId: 'principal-priya-engineer' }, // no consent: excluded
    { kind: 'export', occurredAt: '2026-03-08T06:00:00Z', accountId: 'principal-cody-commissioner' }, // stale consent: excluded
    { kind: 'api-token-verification', occurredAt: '2026-03-08T08:30:00Z', accountId: 'principal-sarah-researcher' }, // still MST: Denver day 03-08
    { kind: 'api-token-verification', occurredAt: '2026-03-08T20:00:00Z', accountId: 'principal-fatima-engineer' }, // MDT after spring-forward
    { kind: 'session', occurredAt: '2026-03-09T17:00:00Z', accountId: 'principal-diego-steward' },
    { kind: 'session', occurredAt: '2026-03-09T21:00:00Z', accountId: 'principal-diego-steward' },
    { kind: 'export', occurredAt: '2026-03-10T16:00:00Z', accountId: 'principal-fatima-engineer' },
    // Hostile: query content beyond the allowlist - dropped whole, never aggregated.
    { kind: 'session', occurredAt: '2026-03-09T18:00:00Z', accountId: 'principal-diego-steward', query: 'discharge > 900 AND stationId = sta-hyrum-diversion-owner' },
  ];
}
