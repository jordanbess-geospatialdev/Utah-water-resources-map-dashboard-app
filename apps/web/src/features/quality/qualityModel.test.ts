/**
 * Pure view-model tests for the WD-013 quality feature: rule status badges
 * (text + shape), promote gating (steward-only + test-before-promote),
 * violation type sorting and context links, subscription labels, indicator
 * badges (symbol + label, never color alone), known-issue lifecycle rows
 * with append-only history, and deterministic formatting.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/quality/qualityModel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type {
  KnownIssueView,
  RuleVersionView,
  RunResultView,
  ViolationEntryView,
} from './qualityModel';

// Extensionless src imports under node --test (see tests/ts-resolve-hook.mjs;
// import pattern per apps/web/tests/adapters.test.ts).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const modelPath = './qualityModel.ts';
const model: typeof import('./qualityModel') = await import(modelPath);
const {
  CADENCE_LABELS,
  CADENCES,
  FAMILY_ORDER,
  contextLink,
  diagnosticsRows,
  formatInstantUtc,
  formatIntervalUtc,
  indicatorBadges,
  issueStatusBadge,
  knownIssueRows,
  promoteBlockedReason,
  ruleRows,
  ruleStatusBadge,
  runStatusBadge,
  runSummary,
  subscriptionRows,
  violationRows,
} = model;

const RULE_BASE = { author: 'principal-diego-steward', createdAt: '2026-03-09T07:00:00Z', updatedAt: '2026-03-09T07:00:00Z' };

test('rule status is always text + shape: ○ draft, ◐ fixture-tested, ● promoted', () => {
  assert.deepEqual(ruleStatusBadge('draft'), { marker: '○', text: 'draft' });
  assert.deepEqual(ruleStatusBadge('test'), { marker: '◐', text: 'fixture-tested' });
  assert.deepEqual(ruleStatusBadge('promoted'), { marker: '●', text: 'promoted' });
  assert.deepEqual(runStatusBadge('success'), { marker: '✓', text: 'success' });
  assert.deepEqual(runStatusBadge('failed'), { marker: '✕', text: 'failed' });
});

test('promote gating: steward-only, then a passing fixture test for THIS version, then available', () => {
  const draft: RuleVersionView = { ...RULE_BASE, ruleId: 'qc-range', family: 'range', version: 1, status: 'draft' };
  assert.equal(promoteBlockedReason(draft, null, true), 'Requires a passing fixture test');
  const failedRun: RunResultView = { ruleId: 'qc-range', ruleVersion: 1, status: 'failed', violationCount: 0, error: 'boom' };
  assert.equal(promoteBlockedReason(draft, failedRun, true), 'Requires a passing fixture test');
  const staleRun: RunResultView = { ruleId: 'qc-range', ruleVersion: 2, status: 'success', violationCount: 0, error: null };
  assert.equal(promoteBlockedReason(draft, staleRun, true), 'Requires a passing fixture test', 'a v2 test run never unlocks v1');
  assert.equal(promoteBlockedReason(draft, null, false), 'Steward only', 'the entitlement gate comes first for non-stewards');
  const passing: RunResultView = { ruleId: 'qc-range', ruleVersion: 1, status: 'success', violationCount: 3, error: null };
  assert.equal(promoteBlockedReason(draft, passing, true), null);
  const promoted: RuleVersionView = { ...draft, status: 'promoted' };
  assert.equal(promoteBlockedReason(promoted, passing, true), 'Already promoted');
});

test('rule rows sort by family order then rule and expose the isolated last run per version', () => {
  const rules: readonly RuleVersionView[] = [
    { ...RULE_BASE, ruleId: 'qc-zero-value', family: 'zero-value', version: 1, status: 'promoted' },
    { ...RULE_BASE, ruleId: 'qc-range', family: 'range', version: 1, status: 'promoted' },
    { ...RULE_BASE, ruleId: 'qc-range', family: 'range', version: 2, status: 'draft', updatedAt: '2026-03-09T08:00:00Z' },
    { ...RULE_BASE, ruleId: 'qc-missing-data', family: 'missing-data', version: 1, status: 'test' },
  ];
  const runs: readonly RunResultView[] = [
    { ruleId: 'qc-range', ruleVersion: 1, status: 'success', violationCount: 3, error: null },
    { ruleId: 'qc-range', ruleVersion: 2, status: 'failed', violationCount: 0, error: 'rule qc-range v2 threw: simulated evaluator crash' },
    { ruleId: 'qc-missing-data', ruleVersion: 1, status: 'success', violationCount: 10, error: null },
  ];
  const rows = ruleRows(rules, runs, { canPromote: true });
  assert.deepEqual(
    rows.map((row) => `${row.ruleId} v${row.version} ${row.statusMarker}${row.statusText}`),
    ['qc-range v1 ●promoted', 'qc-range v2 ○draft', 'qc-missing-data v1 ◐fixture-tested', 'qc-zero-value v1 ●promoted'],
  );
  // Isolation is visible per version: v1 keeps its passing count while v2 failed.
  const v1 = rows[0]!;
  const v2 = rows[1]!;
  assert.equal(v1.lastRun!.status, 'success');
  assert.equal(v1.lastRun!.violationCount, 3);
  assert.equal(v2.lastRun!.status, 'failed');
  assert.match(v2.lastRun!.error!, /simulated evaluator crash/);
  assert.equal(v2.promoteBlockedReason, 'Requires a passing fixture test');
  assert.equal(rows[3]!.promoteBlockedReason, 'Already promoted');
  // A non-steward never sees an available promote button.
  assert.equal(ruleRows(rules, runs, { canPromote: false })[1]!.promoteBlockedReason, 'Steward only');
});

test('run summary: a failed rule never hides the successes or their violation counts', () => {
  const summary = runSummary([
    { ruleId: 'qc-range', ruleVersion: 1, status: 'failed', violationCount: 0, error: 'rule qc-range v1 threw: timeout' },
    { ruleId: 'qc-rate-of-change', ruleVersion: 1, status: 'success', violationCount: 6, error: null },
    { ruleId: 'qc-zero-value', ruleVersion: 1, status: 'success', violationCount: 1, error: null },
  ]);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.totalViolations, 7);
  assert.deepEqual(summary.failureNotes, ['rule qc-range v1 threw: timeout']);
});

test('violation rows: type sorting orders families, then stream, then interval; links match the entry', () => {
  const entries: readonly ViolationEntryView[] = [
    { family: 'zero-value', streamId: 'str-corinne-q', interval: { start: '2026-03-07T15:00:00Z', end: '2026-03-07T16:00:00Z' }, observed: 'exact 0 cfs', rationale: 'r0', ruleId: 'qc-zero-value', ruleVersion: 1 },
    { family: 'range', streamId: 'str-diag-voltage', interval: { start: '2026-03-09T06:00:00Z', end: '2026-03-09T07:00:00Z' }, observed: '11.1 V', rationale: 'r1', ruleId: 'qc-range', ruleVersion: 1 },
    { family: 'range', streamId: 'str-corinne-q', interval: { start: '2026-03-08T20:00:00Z', end: '2026-03-08T21:00:00Z' }, observed: '9500 cfs', rationale: 'r2', ruleId: 'qc-range', ruleVersion: 1 },
    { family: 'missing-data', streamId: 'str-corinne-q', interval: { start: '2026-03-08T12:00:00Z', end: '2026-03-08T18:00:00Z' }, observed: '6 missing readings', rationale: 'r3', ruleId: 'qc-missing-data', ruleVersion: 1 },
  ];
  const byType = violationRows(entries);
  assert.deepEqual(
    byType.map((row) => `${row.family}:${row.streamId}`),
    ['range:str-corinne-q', 'range:str-diag-voltage', 'missing-data:str-corinne-q', 'zero-value:str-corinne-q'],
  );
  assert.deepEqual(
    byType.map((row) => row.typeLabel),
    ['Range (incl. voltage)', 'Range (incl. voltage)', 'Missing data', 'Suspect zero'],
  );
  // Time sorting re-orders by interval start.
  const byTime = violationRows(entries, { sortBy: 'time' });
  assert.deepEqual(
    byTime.map((row) => row.intervalLabel),
    ['2026-03-07 15:00 → 16:00 UTC', '2026-03-08 12:00 → 18:00 UTC', '2026-03-08 20:00 → 21:00 UTC', '2026-03-09 06:00 → 07:00 UTC'],
  );
  // Context links carry the filtered context (stream + type + interval).
  for (const row of byType) {
    const source = entries.find((entry) => contextLink(entry) === row.contextLink);
    assert.ok(source, 'each row link matches its entry');
  }
  assert.equal(
    contextLink(entries[2]!),
    'stream=str-corinne-q&type=range&from=2026-03-08T20:00:00Z&to=2026-03-08T21:00:00Z',
  );
});

test('interval formatting: same-day short form, cross-day long form, pure string slicing', () => {
  assert.equal(formatInstantUtc('2026-03-08T20:00:00Z'), '2026-03-08 20:00');
  assert.equal(formatIntervalUtc('2026-03-08T20:00:00Z', '2026-03-08T21:00:00Z'), '2026-03-08 20:00 → 21:00 UTC');
  assert.equal(formatIntervalUtc('2026-03-08T12:00:00Z', '2026-03-09T06:00:00Z'), '2026-03-08 12:00 → 2026-03-09 06:00 UTC');
});

test('subscriptions: the four cadences render labels and scope text deterministically', () => {
  assert.deepEqual([...CADENCES], ['hourly', 'twice-daily', 'daily', 'weekly']);
  assert.deepEqual(CADENCE_LABELS, { hourly: 'Hourly', 'twice-daily': 'Twice daily', daily: 'Daily', weekly: 'Weekly' });
  const rows = subscriptionRows([
    { id: 'qsub-000002', recipientId: 'principal-fatima-engineer', scope: { kind: 'stream', id: 'str-diag-voltage' }, cadence: 'daily', createdAt: '2026-03-09T07:00:00Z', nextDueAt: '2026-03-10T07:00:00Z', status: 'active' },
    { id: 'qsub-000001', recipientId: 'principal-cody-commissioner', scope: { kind: 'system', id: 'sys-bear-river' }, cadence: 'hourly', createdAt: '2026-03-09T07:00:00Z', nextDueAt: '2026-03-09T08:00:00Z', status: 'active' },
  ]);
  assert.deepEqual(
    rows.map((row) => `${row.scopeLabel} · ${row.cadenceLabel} · due ${row.nextDueLabel}`),
    ['System sys-bear-river · Hourly · due 2026-03-09 08:00', 'Stream str-diag-voltage · Daily · due 2026-03-10 07:00'],
  );
});

test('indicator badges: severity-sorted, every badge carries symbol + label + severity text', () => {
  const badges = indicatorBadges([
    { flagId: 'capacity-warn', streamId: 'str-corinne-q', observedAt: '2026-03-09T06:00:00Z', label: 'Above typical late-winter capacity', symbol: '▲', severity: 'warn', text: '▲ Above typical late-winter capacity: 26 cfs (at or above 24 cfs)' },
    { flagId: 'capacity-spike', streamId: 'str-corinne-q', observedAt: '2026-03-08T20:00:00Z', label: 'Spike far above rated capacity', symbol: '‼', severity: 'critical', text: '‼ Spike far above rated capacity: 9500 cfs (at or above 1000 cfs)' },
    { flagId: 'voltage-low', streamId: 'str-diag-voltage', observedAt: '2026-03-09T06:00:00Z', label: 'Battery voltage at or below minimum', symbol: '▼', severity: 'warn', text: '▼ Battery voltage at or below minimum: 11.1 V (at or below 11.5 V)' },
  ]);
  assert.deepEqual(
    badges.map((badge) => badge.severityLabel),
    ['critical', 'warning', 'warning'],
  );
  for (const badge of badges) {
    assert.ok(badge.symbol.length > 0, 'symbol present');
    assert.ok(badge.label.length > 0, 'label present');
    assert.ok(badge.text.includes(badge.symbol));
  }
  // Diagnostics rows label the voltage stream and its internal visibility.
  const rows = diagnosticsRows([
    {
      streamId: 'str-diag-voltage',
      stationId: 'sta-bear-lake-diagnostic',
      systemId: 'sys-bear-river',
      observedPropertyId: 'voltage',
      unitId: 'V',
      visibility: 'internal',
      latest: { observedAt: '2026-03-09T06:00:00Z', value: 11.1 },
      indicators: [
        { flagId: 'voltage-low', streamId: 'str-diag-voltage', observedAt: '2026-03-09T06:00:00Z', label: 'Battery voltage at or below minimum', symbol: '▼', severity: 'warn' as const, text: '▼ Battery voltage at or below minimum: 11.1 V (at or below 11.5 V)' },
      ],
    },
  ]);
  assert.equal(rows[0]!.propertyLabel, 'Voltage');
  assert.equal(rows[0]!.visibility, 'internal');
  assert.equal(rows[0]!.latestLabel, '11.1 V · 2026-03-09 06:00 UTC');
  assert.equal(rows[0]!.badges[0]!.symbol, '▼');
});

test('known issues: status is text + shape and the resolution history stays append-only ordered', () => {
  assert.deepEqual(issueStatusBadge('open'), { marker: '●', text: 'open' });
  assert.deepEqual(issueStatusBadge('monitoring'), { marker: '◐', text: 'monitoring' });
  assert.deepEqual(issueStatusBadge('resolved'), { marker: '✓', text: 'resolved' });
  const issue: KnownIssueView = {
    id: 'issue-000001',
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-08T12:00:00Z', end: '2026-03-08T18:00:00Z' },
    title: 'Logger communications outage - six hourly readings missing',
    status: 'resolved',
    visibility: 'public',
    recordedBy: 'principal-diego-steward',
    recordedAt: '2026-03-09T07:00:00Z',
    resolutionHistory: [
      { seq: 1, at: '2026-03-09T07:30:00Z', actorId: 'principal-diego-steward', from: 'open', to: 'monitoring', note: 'Watching the logger transport.' },
      { seq: 2, at: '2026-03-09T09:00:00Z', actorId: 'principal-cody-commissioner', from: 'monitoring', to: 'resolved', note: 'Transport restored.' },
    ],
    resolvedAt: '2026-03-09T09:00:00Z',
    resolvedBy: 'principal-cody-commissioner',
  };
  const row = knownIssueRows([issue])[0]!;
  assert.equal(row.statusMarker, '✓');
  assert.equal(row.statusText, 'resolved');
  assert.equal(row.visibilityNote, 'Visible in public charts and exports');
  assert.equal(row.intervalLabel, '2026-03-08 12:00 → 18:00 UTC');
  assert.deepEqual(
    row.history.map((event) => `${event.seq}:${event.from}->${event.to}`),
    ['1:open->monitoring', '2:monitoring->resolved'],
  );
  assert.equal(row.resolvedLabel, '2026-03-09 09:00 UTC by principal-cody-commissioner');
});

test('FAMILY_ORDER fixes the digest type-sort order for the panels', () => {
  assert.deepEqual([...FAMILY_ORDER], ['range', 'rate-of-change', 'persistence', 'missing-data', 'zero-value']);
});
