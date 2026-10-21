/**
 * Usage analytics aggregation tests (WD-014; FR-017; verification rows
 * T-02/T-03): day/month/year counts over fixture event records, the
 * consent gate mirroring WD-020, structural exclusion of query content and
 * identifiers, program-zone day keying across the 2026-03-08
 * spring-forward, and determinism.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/stewardship/test/usageAnalytics.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTICS_POLICY_VERSION, inMemoryConsentStorage } from '../../../support/analytics.ts';
import {
  aggregateUsage,
  seedUsageConsent,
  seedUsageEvents,
  SEED_ACCOUNT_IDS,
  type UsageAggregate,
  type UsageReport,
} from '../usageAnalytics.ts';
import { CODY, DIEGO, FATIMA, PRIYA, SARAH } from './helpers.ts';

const reportOf = (events = seedUsageEvents()): UsageReport => aggregateUsage(events, seedUsageConsent(), SEED_ACCOUNT_IDS);

test('aggregates counts by DAY in the program zone, including the UTC/Denver date boundary and the spring-forward', () => {
  const report = reportOf();
  assert.deepEqual(
    report.byDay.map((day) => [day.key, day.total] as const),
    [
      ['2026-03-06', 3], // incl. the 2026-03-07T02:00:00Z event = Fri 19:00 MST
      ['2026-03-07', 2],
      ['2026-03-08', 2], // one still-MST (08:30Z), one MDT (20:00Z)
      ['2026-03-09', 2], // the hostile query-content event is NOT here
      ['2026-03-10', 1],
    ],
  );
});

test('aggregates roll up to MONTH and YEAR with identical totals', () => {
  const report = reportOf();
  const daysTotal = report.byDay.reduce((sum, day) => sum + day.total, 0);
  assert.deepEqual(report.byMonth.map((month) => [month.key, month.total]), [['2026-03', daysTotal]]);
  assert.deepEqual(report.byYear.map((year) => [year.key, year.total]), [['2026', daysTotal]]);
  assert.equal(daysTotal, 10);
});

test('per-kind counts split sessions, exports and api-token verifications per period', () => {
  const report = reportOf();
  const friday = report.byDay.find((day) => day.key === '2026-03-06')!;
  assert.deepEqual(friday.counts, { sessions: 2, exports: 1, apiTokenVerifications: 0 });
  const sunday = report.byDay.find((day) => day.key === '2026-03-08')!;
  assert.deepEqual(sunday.counts, { sessions: 0, exports: 0, apiTokenVerifications: 2 });
});

test('consent gate (WD-020 mirror): no consent, withdrawn and STALE-policy consent are all excluded', () => {
  const report = reportOf();
  assert.equal(report.excludedEvents, 3);
  assert.deepEqual(report.excludedByReason, {
    'unknown-account': 0,
    'consent-required': 2, // Priya never consented; Cody answered an OLD proposal version
    'field-not-allowed': 1, // the hostile query-content event
    'unknown-kind': 0,
  });
  // Excluded events contribute to NO aggregate.
  const total = report.byDay.reduce((sum, day) => sum + day.total, 0);
  assert.equal(total, 10);
});

test('a consent record naming a different policy version is consent ABSENT (re-ask, never inherit)', () => {
  const events = [{ kind: 'session', occurredAt: '2026-03-09T17:00:00Z', accountId: CODY }];
  const stale = aggregateUsage(events, seedUsageConsent(), SEED_ACCOUNT_IDS);
  assert.deepEqual(stale.excludedByReason, { 'unknown-account': 0, 'consent-required': 1, 'field-not-allowed': 0, 'unknown-kind': 0 });
  // Re-asked at the current version: counted.
  const consent = inMemoryConsentStorage();
  consent.setItem(`utah-water.analytics.consent.v1.${CODY}`, JSON.stringify({ accountId: CODY, granted: true, decidedAt: '2026-03-09T00:00:00Z', policyVersion: ANALYTICS_POLICY_VERSION }));
  const fresh = aggregateUsage(events, consent, SEED_ACCOUNT_IDS);
  assert.equal(fresh.byDay[0]!.total, 1);
  // Withdrawn consent stops aggregation immediately.
  consent.setItem(`utah-water.analytics.consent.v1.${CODY}`, JSON.stringify({ accountId: CODY, granted: false, decidedAt: '2026-03-09T01:00:00Z', policyVersion: ANALYTICS_POLICY_VERSION }));
  const withdrawn = aggregateUsage(events, consent, SEED_ACCOUNT_IDS);
  assert.equal(withdrawn.byDay.length, 0);
  assert.equal(withdrawn.excludedByReason['consent-required'], 1);
});

test('structural exclusions: unknown accounts, unknown kinds, malformed instants, extra fields', () => {
  const base = { kind: 'session', occurredAt: '2026-03-09T17:00:00Z', accountId: DIEGO };
  const report = aggregateUsage(
    [
      base,
      { ...base, accountId: 'principal-ghost' },
      { ...base, kind: 'telemetry-replay' },
      { ...base, occurredAt: 'not-a-time' },
      { ...base, filters: ['systemId=sys-bear-river'] },
      { ...base, note: 'internal record text' },
    ],
    seedUsageConsent(),
    SEED_ACCOUNT_IDS,
  );
  assert.equal(report.byDay[0]!.total, 1, 'only the clean event is counted');
  assert.deepEqual(report.excludedByReason, { 'unknown-account': 1, 'consent-required': 0, 'field-not-allowed': 3, 'unknown-kind': 1 });
  // The malformed instant counted as a field problem, never an aggregate row.
  assert.ok(report.byDay.every((day) => day.key !== 'Invalid Date'));
});

test('the report carries NO identifiers and NO query content (FR-017)', () => {
  const report = reportOf();
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('principal-'), 'no account ids');
  assert.ok(!serialized.includes('discharge'), 'no query content');
  assert.ok(!serialized.includes('sta-hyrum'), 'no record identifiers');
  assert.ok(!serialized.includes('query'), 'not even the field name survives');
  // Aggregates contain only period, key, counts and total.
  const aggregate: UsageAggregate = report.byDay[0]!;
  assert.deepEqual(Object.keys(aggregate).sort(), ['counts', 'key', 'period', 'total']);
  assert.deepEqual(Object.keys(aggregate.counts).sort(), ['apiTokenVerifications', 'exports', 'sessions']);
});

test('empty input yields an empty-but-well-formed report', () => {
  const report = aggregateUsage([], seedUsageConsent(), SEED_ACCOUNT_IDS);
  assert.deepEqual(report.byDay, []);
  assert.deepEqual(report.byMonth, []);
  assert.deepEqual(report.byYear, []);
  assert.equal(report.excludedEvents, 0);
});

test('determinism: identical inputs aggregate identically twice', () => {
  const first = reportOf();
  const second = reportOf();
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('the seed is internally consistent: only known fixture accounts appear', () => {
  const known = new Set(SEED_ACCOUNT_IDS);
  for (const event of seedUsageEvents()) {
    assert.ok(known.has(event.accountId as string), `seed event account ${String(event.accountId)} must be a known fixture principal`);
  }
  // And the consented subset is exactly Diego, Fatima and Sarah.
  const consent = seedUsageConsent();
  assert.deepEqual(
    SEED_ACCOUNT_IDS.filter((account) => {
      const raw = consent.getItem(`utah-water.analytics.consent.v1.${account}`);
      const parsed = raw === null ? null : (JSON.parse(raw) as { granted: boolean; policyVersion: string });
      return parsed !== null && parsed.granted === true && parsed.policyVersion === ANALYTICS_POLICY_VERSION;
    }),
    [DIEGO, FATIMA, SARAH],
  );
});
