/**
 * Connection health and weekday digest tests (WD-014; FR-014; verification
 * rows T-02/T-03). EVIDENCE SUITE for this task.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/stewardship/test/connections.test.ts
 *
 * Covers:
 * - connection health DISTINCT from task failures (a healthy connection can
 *   carry failed tasks; a failed connection can have zero failed tasks);
 * - a connection failure marks the connection AND links to its filtered
 *   task list (taskListQuery), while digest TASK entries reference TASK ids;
 * - the weekday digest rule with a FIXED America/Denver clock spanning the
 *   2026-03-06..03-10 weekend (including the 2026-03-08 spring-forward):
 *   Monday covers the weekend interval exactly once (dedupe by incident
 *   id), weekend dates issue nothing, later digests never repeat incidents;
 * - recipient scope filtering through the real policy engine;
 * - determinism (built twice, deep-equal).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWeekdayDigest,
  connectionStatusFromOutcome,
  connectionsFromConfigs,
  denverMidnightInstant,
  digestWindow,
  failedTasksFor,
  healthBoard,
  weekdayOf,
  type ConnectionRecord,
  type IncidentRecord,
  type WeekdayDigest,
} from '../connections.ts';
import type { SiteIngestionConfig } from '../ingestion.ts';
import { ANA, CODY, DIEGO, FATIMA, PRIYA, SARAH, buildTestWorld } from './helpers.ts';

const world = buildTestWorld();

// ---------------------------------------------------------------------------
// The weekend scenario (America/Denver; 2026-03-08 is the US spring-forward)
// ---------------------------------------------------------------------------

/**
 * Fixed program-zone clock: every instant below is pinned, and the Denver
 * day keys are asserted so the DST boundary (2026-03-08 02:00 MST ->
 * 03:00 MDT, i.e. 09:00Z) is explicit.
 *
 *   Fri 2026-03-06  Sat 2026-03-07  Sun 2026-03-08  Mon 2026-03-09  Tue 2026-03-10
 */
function config(id: string, systemId: string, outcome: 'success' | 'auth-failure' | 'timeout' | null): SiteIngestionConfig {
  return {
    id,
    providerId: 'prov-dwri-telemetry',
    stationId: 'sta-bear-corinne',
    systemId,
    params: {},
    status: 'configured',
    requestedBy: DIEGO,
    requestedAt: '2026-03-01T00:00:00Z',
    promotedBy: DIEGO,
    promotedAt: '2026-03-01T00:00:00Z',
    lastConnectionTest: outcome === null ? null : { at: '2026-03-06T12:00:00Z', outcome, latencyMs: 100 },
  };
}

const BEAR_AUTH = config('ing-bear-auth', 'sys-bear-river', 'auth-failure');
const BEAR_HEALTHY = config('ing-bear-healthy', 'sys-bear-river', 'success');
const WEBER_TIMEOUT = config('ing-weber-timeout', 'sys-weber-river', 'timeout');
const WEBER_UNTESTED = config('ing-weber-untested', 'sys-weber-river', null);
const connections: readonly ConnectionRecord[] = connectionsFromConfigs([BEAR_AUTH, BEAR_HEALTHY, WEBER_TIMEOUT, WEBER_UNTESTED]);

const incidents: readonly IncidentRecord[] = [
  // Friday (before the weekend interval, covered by Monday's window)
  { id: 'inc-fri-conn', kind: 'connection', connectionId: 'ing-bear-auth', taskId: null, systemId: 'sys-bear-river', detectedAt: '2026-03-06T20:00:00Z', summary: 'Friday evening auth failure (Bear)' },
  // Saturday
  { id: 'inc-sat-conn', kind: 'connection', connectionId: 'ing-bear-auth', taskId: null, systemId: 'sys-bear-river', detectedAt: '2026-03-07T16:00:00Z', summary: 'Saturday auth failure (Bear)' },
  { id: 'inc-sat-conn', kind: 'connection', connectionId: 'ing-bear-auth', taskId: null, systemId: 'sys-bear-river', detectedAt: '2026-03-07T16:05:00Z', summary: 'DUPLICATE record of the Saturday incident (same id)' },
  // Sunday (2026-03-08: MST before 09:00Z, MDT after)
  { id: 'inc-sun-task-1', kind: 'task', connectionId: 'ing-bear-healthy', taskId: 'qc-task-0301', systemId: 'sys-bear-river', detectedAt: '2026-03-08T07:00:00Z', summary: 'Sunday QC range check failure (still MST)' },
  { id: 'inc-sun-task-2', kind: 'task', connectionId: 'ing-bear-healthy', taskId: 'qc-task-0302', systemId: 'sys-bear-river', detectedAt: '2026-03-08T15:00:00Z', summary: 'Sunday rate-of-change failure (MDT after spring-forward)' },
  { id: 'inc-sun-conn', kind: 'connection', connectionId: 'ing-weber-timeout', taskId: null, systemId: 'sys-weber-river', detectedAt: '2026-03-08T21:00:00Z', summary: 'Sunday Weber timeout' },
  // Monday (belongs to Tuesday's digest, NOT Monday's)
  { id: 'inc-mon-task', kind: 'task', connectionId: 'ing-bear-healthy', taskId: 'qc-task-0303', systemId: 'sys-bear-river', detectedAt: '2026-03-09T15:00:00Z', summary: 'Monday persistence failure' },
  // An ORPHAN task incident (no connection linkage) - still a task entry.
  { id: 'inc-sun-task-orphan', kind: 'task', connectionId: null, taskId: 'qc-task-0304', systemId: 'sys-weber-river', detectedAt: '2026-03-08T22:00:00Z', summary: 'Sunday orphan import task failure (Weber)' },
];

const digest = (digestDate: string, recipientId: string | null): WeekdayDigest =>
  buildWeekdayDigest({ digestDate, recipientId, incidents, connections, world, evaluatedAt: '2026-03-10T14:00:00Z' });

// ---------------------------------------------------------------------------
// Program-zone calendar math
// ---------------------------------------------------------------------------

test('program-zone day math: Denver midnights are exact across the 2026-03-08 spring-forward', () => {
  assert.equal(weekdayOf('2026-03-06'), 'Fri');
  assert.equal(weekdayOf('2026-03-07'), 'Sat');
  assert.equal(weekdayOf('2026-03-08'), 'Sun');
  assert.equal(weekdayOf('2026-03-09'), 'Mon');
  assert.equal(weekdayOf('2026-03-10'), 'Tue');
  // MST (-07:00) before the switch, MDT (-06:00) after.
  assert.equal(denverMidnightInstant('2026-03-07'), '2026-03-07T07:00:00.000Z');
  assert.equal(denverMidnightInstant('2026-03-08'), '2026-03-08T07:00:00.000Z'); // Sunday midnight still MST
  assert.equal(denverMidnightInstant('2026-03-09'), '2026-03-09T06:00:00.000Z'); // Monday midnight MDT
});

test('digest windows: Monday covers the weekend interval since Friday; Tue-Fri cover one day; weekends issue nothing', () => {
  const monday = digestWindow('2026-03-09');
  assert.equal(monday.issued, true);
  assert.equal(monday.weekday, 'Mon');
  assert.deepEqual(monday.coverageDays, ['2026-03-06', '2026-03-07', '2026-03-08']);
  assert.equal(monday.coverageStart, '2026-03-06T07:00:00.000Z'); // Friday midnight MST
  assert.equal(monday.coverageEnd, '2026-03-09T06:00:00.000Z'); // Monday midnight MDT

  const tuesday = digestWindow('2026-03-10');
  assert.deepEqual(tuesday.coverageDays, ['2026-03-09']);
  assert.equal(tuesday.coverageStart, '2026-03-09T06:00:00.000Z');

  for (const weekendDate of ['2026-03-07', '2026-03-08']) {
    const notIssued = digestWindow(weekendDate);
    assert.equal(notIssued.issued, false);
    assert.equal(notIssued.notIssuedReason, 'weekend');
    assert.deepEqual(notIssued.coverageDays, []);
  }
});

// ---------------------------------------------------------------------------
// Connection health vs task failures (FR-014 distinctness)
// ---------------------------------------------------------------------------

test('connection status derives ONLY from the latest staging test - never from task failures', () => {
  assert.equal(connectionStatusFromOutcome('success'), 'healthy');
  assert.equal(connectionStatusFromOutcome('auth-failure'), 'auth-failure');
  assert.equal(connectionStatusFromOutcome('timeout'), 'timeout');
  assert.equal(connectionStatusFromOutcome(null), 'untested');
  assert.deepEqual(
    connections.map((connection) => [connection.id, connection.status]),
    [
      ['ing-bear-auth', 'auth-failure'],
      ['ing-bear-healthy', 'healthy'],
      ['ing-weber-timeout', 'timeout'],
      ['ing-weber-untested', 'untested'],
    ],
  );
});

test('a HEALTHY connection can carry failed tasks, and a FAILED connection can have none - the two never merge', () => {
  const board = healthBoard(connections, incidents);
  const byId = new Map(board.map((row) => [row.connectionId, row]));
  // Healthy connection with three failed tasks (two Sunday + one Monday).
  const healthy = byId.get('ing-bear-healthy')!;
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.failedTaskCount, 3);
  assert.equal(healthy.openConnectionIncidents, 0);
  // Failed connection with zero failed tasks.
  const weberTimeout = byId.get('ing-weber-timeout')!;
  assert.equal(weberTimeout.status, 'timeout');
  assert.equal(weberTimeout.failedTaskCount, 0);
  assert.equal(weberTimeout.openConnectionIncidents, 1);
  // Untested connection reports untested, not inferred from incidents.
  assert.equal(byId.get('ing-weber-untested')!.status, 'untested');
  // Every row links to its filtered task list.
  assert.equal(healthy.taskListQuery, 'connection=ing-bear-healthy');
  // Task failures reference TASK ids, never a bare connection id.
  const tasks = failedTasksFor('ing-bear-healthy', incidents);
  assert.deepEqual(tasks.map((task) => task.taskId).sort(), ['qc-task-0301', 'qc-task-0302', 'qc-task-0303']);
  assert.ok(tasks.every((task) => task.taskId !== null && task.taskId !== task.connectionId));
});

// ---------------------------------------------------------------------------
// Monday weekend coverage, exactly once (dedupe by incident id)
// ---------------------------------------------------------------------------

test('Monday digest includes the whole weekend interval exactly once, deduped by incident id (Diego, statewide)', () => {
  const monday = digest('2026-03-09', DIEGO);
  assert.equal(monday.issued, true);
  assert.deepEqual(monday.coverageDays, ['2026-03-06', '2026-03-07', '2026-03-08']);

  // Task failures first, and they carry TASK ids.
  assert.deepEqual(monday.taskFailures.map((task) => task.taskId).sort(), ['qc-task-0301', 'qc-task-0302', 'qc-task-0304']);
  assert.ok(monday.taskFailures.every((task) => task.taskId !== null));

  // Connection incidents: Friday + Saturday Bear auth failure + Sunday Weber
  // timeout. The DUPLICATE Saturday record (same incident id) counts once.
  assert.deepEqual(monday.connectionIncidents.map((entry) => entry.incidentId), ['inc-fri-conn', 'inc-sat-conn', 'inc-sun-conn']);
  assert.equal(monday.counts.duplicatesDropped, 1, 'the duplicate Saturday record is deduped by incident id');
  assert.deepEqual(monday.counts, { connections: 3, tasks: 3, duplicatesDropped: 1, omittedForScope: 0 });

  // The Monday task incident belongs to Tuesday, not Monday: no early leak.
  assert.ok(!monday.taskFailures.some((task) => task.taskId === 'qc-task-0303'));
});

test('Saturday and Sunday digest dates issue NOTHING (weekday digest rule)', () => {
  for (const weekendDate of ['2026-03-07', '2026-03-08']) {
    const notIssued = digest(weekendDate, DIEGO);
    assert.equal(notIssued.issued, false);
    assert.equal(notIssued.notIssuedReason, 'weekend');
    assert.deepEqual(notIssued.taskFailures, []);
    assert.deepEqual(notIssued.connectionIncidents, []);
  }
});

test('no incident appears in two digests: Tuesday covers Monday only, weekend incidents never repeat', () => {
  const monday = digest('2026-03-09', DIEGO);
  const tuesday = digest('2026-03-10', DIEGO);
  assert.deepEqual(tuesday.coverageDays, ['2026-03-09']);
  assert.deepEqual(tuesday.taskFailures.map((task) => task.taskId), ['qc-task-0303']);
  assert.deepEqual(tuesday.connectionIncidents, []);
  const mondayIds = new Set([...monday.taskFailures.map((task) => task.incidentId), ...monday.connectionIncidents.map((entry) => entry.incidentId)]);
  const tuesdayIds = new Set([...tuesday.taskFailures.map((task) => task.incidentId), ...tuesday.connectionIncidents.map((entry) => entry.incidentId)]);
  const overlap = [...mondayIds].filter((id) => tuesdayIds.has(id));
  assert.deepEqual(overlap, [], 'weekend incidents are counted exactly once across digests');
});

test('a connection failure entry links to its filtered task list and reports its scoped failed-task count', () => {
  const monday = digest('2026-03-09', DIEGO);
  const bearAuth = monday.connectionIncidents.find((entry) => entry.incidentId === 'inc-sat-conn')!;
  assert.equal(bearAuth.connectionId, 'ing-bear-auth');
  assert.equal(bearAuth.status, 'auth-failure', 'the entry carries the connection health status');
  assert.equal(bearAuth.taskListQuery, 'connection=ing-bear-auth');
  assert.equal(bearAuth.failedTaskCount, 0, 'this connection has no failed tasks - the failure is the CONNECTION, not tasks');
  const weberTimeout = monday.connectionIncidents.find((entry) => entry.incidentId === 'inc-sun-conn')!;
  assert.equal(weberTimeout.taskListQuery, 'connection=ing-weber-timeout');
});

// ---------------------------------------------------------------------------
// Recipient scope (digests contain only entries within the recipient's scope)
// ---------------------------------------------------------------------------

test('digest entries stay within the recipient scope (real policy engine verdicts)', () => {
  // Diego: statewide - everything.
  const diego = digest('2026-03-09', DIEGO);
  assert.equal(diego.counts.omittedForScope, 0);
  assert.equal(diego.counts.connections + diego.counts.tasks, 6);

  // Fatima: Bear River engineer - Bear entries only; Weber incidents omitted (count only).
  const fatima = digest('2026-03-09', FATIMA);
  assert.deepEqual(fatima.taskFailures.map((task) => task.taskId).sort(), ['qc-task-0301', 'qc-task-0302']);
  assert.deepEqual(fatima.connectionIncidents.map((entry) => entry.incidentId), ['inc-fri-conn', 'inc-sat-conn']);
  assert.equal(fatima.counts.omittedForScope, 2, 'the Weber timeout and the Weber orphan task are omitted');
  assert.equal(fatima.counts.connections, 2);
  assert.equal(fatima.counts.tasks, 2);

  // Priya: Weber River engineer - exactly the Weber incidents.
  const priya = digest('2026-03-09', PRIYA);
  assert.deepEqual(priya.taskFailures.map((task) => task.taskId), ['qc-task-0304']);
  assert.deepEqual(priya.connectionIncidents.map((entry) => entry.incidentId), ['inc-sun-conn']);

  // Ana: deputy inside her delegation window covers Bear River.
  const ana = digest('2026-03-09', ANA);
  assert.equal(ana.counts.omittedForScope, 2);
  assert.deepEqual(ana.connectionIncidents.map((entry) => entry.incidentId), ['inc-fri-conn', 'inc-sat-conn']);

  // Sarah: dataset-scoped researcher - no system anchor is in her scope.
  const sarah = digest('2026-03-09', SARAH);
  assert.deepEqual(sarah.taskFailures, []);
  assert.deepEqual(sarah.connectionIncidents, []);
  assert.equal(sarah.counts.omittedForScope, 6);

  // Anonymous: nothing, count only.
  const anonymous = digest('2026-03-09', null);
  assert.deepEqual(anonymous.taskFailures, []);
  assert.deepEqual(anonymous.connectionIncidents, []);
  assert.equal(anonymous.counts.omittedForScope, 6);
});

test('out-of-scope counts never identify the omitted systems or incidents', () => {
  const sarah = digest('2026-03-09', SARAH);
  const serialized = JSON.stringify(sarah);
  assert.ok(!serialized.includes('inc-sun-conn'), 'omitted incident ids do not travel');
  assert.ok(!serialized.includes('sys-weber-river'), 'omitted system ids do not travel');
  assert.equal(sarah.counts.omittedForScope, 6);
});

test('connection records derive from ingestion configs (last staging test wins)', () => {
  const derived = connectionsFromConfigs([BEAR_AUTH, WEBER_UNTESTED]);
  assert.deepEqual(
    derived.map((connection) => [connection.id, connection.status, connection.lastTestedAt]),
    [
      ['ing-bear-auth', 'auth-failure', '2026-03-06T12:00:00Z'],
      ['ing-weber-untested', 'untested', null],
    ],
  );
  assert.equal(derived[0]!.systemId, 'sys-bear-river', 'the connection anchors to the config system (server-resolved)');
});

test('determinism: the same digest inputs built twice are deep-equal', () => {
  const build = (): WeekdayDigest => digest('2026-03-09', FATIMA);
  assert.deepEqual(build(), build());
  const full = (): readonly WeekdayDigest => ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'].map((date) => digest(date, DIEGO));
  assert.deepEqual(full(), full());
});

// CODY is imported for the delegation window anchor; assert the commissioner
// also sees Bear only (commissioner enter-readings satisfies the read verb).
test('the Bear River commissioner receives the same scoped digest as the Bear engineer', () => {
  const cody = digest('2026-03-09', CODY);
  assert.equal(cody.counts.omittedForScope, 2);
  assert.equal(cody.counts.connections, 2);
  assert.equal(cody.counts.tasks, 2);
});
