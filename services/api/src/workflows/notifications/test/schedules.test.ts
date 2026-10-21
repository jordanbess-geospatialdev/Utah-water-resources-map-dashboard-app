/**
 * Digest schedule boundary tests (WD-015; FR-025 with FR-014/FR-016 calendar
 * semantics; verification row T-15). Fixed-clock proof that:
 *
 * - every cadence anchors to its America/Denver wall clock (hourly on the
 *   hour; twice-daily 06:00/18:00; daily 07:00; weekly Monday 07:00);
 * - window DURATIONS are DST-correct across the 2026-03-08 spring-forward
 *   (daily 23 h, twice-daily 18:00->06:00 11 h, weekly 167 h, hourly 1 h);
 * - windows are CONTIGUOUS so the Monday weekly digest includes the whole
 *   Fri+Sat+Sun interval exactly once (weekend dedupe by event id);
 * - boundary/window labels name the zone (MDT/MST visible on DST windows);
 * - the boundary math is deterministic run over run.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/notifications/test/schedules.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_HOUR,
  TWICE_DAILY_HOURS,
  currentBoundary,
  denverInstantLabel,
  denverLocalInstant,
  nextBoundary,
  previousBoundary,
  stepBoundary,
  weekendCoverageDays,
  windowForBoundary,
  windowLabel,
} from '../schedules.ts';
import { CODY, FATIMA, event } from './helpers.ts';
import { createNotificationService } from '../subscriptions.ts';
import { createDeliveryRecorder } from '../types.ts';
import { buildTestWorld } from './helpers.ts';

// The 2026-03-08 spring-forward: 02:00 MST (09:00Z) jumps to 03:00 MDT.
// Denver anchors: 07:00 MST = 14:00Z, 07:00 MDT = 13:00Z, 06:00 MDT = 12:00Z,
// 18:00 MST = 01:00Z next day, 18:00 MDT = 00:00Z next day.
test('Denver local instants are exact across the 2026-03-08 spring-forward', () => {
  assert.equal(denverLocalInstant('2026-03-07', 7), '2026-03-07T14:00:00Z'); // 07:00 MST
  assert.equal(denverLocalInstant('2026-03-08', 6), '2026-03-08T12:00:00Z'); // 06:00 MDT (after the 02:00 jump)
  assert.equal(denverLocalInstant('2026-03-08', 7), '2026-03-08T13:00:00Z'); // 07:00 MDT
  assert.equal(denverLocalInstant('2026-03-07', 18), '2026-03-08T01:00:00Z'); // 18:00 MST
  assert.equal(denverLocalInstant('2026-03-09', 18), '2026-03-10T00:00:00Z'); // 18:00 MDT
});

test('hourly boundaries sit on the hour; the skipped local hour never appears; durations stay exactly 1 h', () => {
  assert.equal(currentBoundary('hourly', '2026-03-08T09:30:00Z'), '2026-03-08T09:00:00Z');
  assert.equal(currentBoundary('hourly', '2026-03-08T09:00:00Z'), '2026-03-08T09:00:00Z'); // boundary instant itself
  assert.equal(nextBoundary('hourly', '2026-03-08T09:00:00Z'), '2026-03-08T10:00:00Z');
  assert.equal(previousBoundary('hourly', '2026-03-08T10:00:00Z'), '2026-03-08T09:00:00Z');
  // 09:00Z is BOTH 02:00 MST and 03:00 MDT: the 02:00-03:00 local hour does
  // not exist, and the hour window containing the jump is still exactly 1 h.
  const jump = windowForBoundary('hourly', '2026-03-08T09:00:00Z');
  assert.equal(jump.windowStart, '2026-03-08T08:00:00Z');
  assert.equal(jump.durationMs, 60 * 60 * 1000);
  for (const boundary of ['2026-03-08T08:00:00Z', '2026-03-08T09:00:00Z', '2026-03-08T10:00:00Z', '2026-03-09T13:00:00Z']) {
    assert.equal(windowForBoundary('hourly', boundary).durationMs, 60 * 60 * 1000, boundary);
  }
});

test('twice-daily boundaries anchor to 06:00 and 18:00 America/Denver; the DST-crossing window is 11 h', () => {
  assert.deepEqual([...TWICE_DAILY_HOURS], [6, 18]);
  // Denver evening (19:00 MST Mar 7): the latest boundary is that day's 18:00.
  assert.equal(currentBoundary('twice-daily', '2026-03-08T02:00:00Z'), '2026-03-08T01:00:00Z'); // 18:00 MST Mar 7
  // Small hours: latest boundary is the previous evening's 18:00.
  assert.equal(currentBoundary('twice-daily', '2026-03-08T11:00:00Z'), '2026-03-08T01:00:00Z');
  // At/after 06:00 Denver.
  assert.equal(currentBoundary('twice-daily', '2026-03-08T12:00:00Z'), '2026-03-08T12:00:00Z'); // 06:00 MDT exactly
  assert.equal(currentBoundary('twice-daily', '2026-03-08T12:00:00.001Z'), '2026-03-08T12:00:00Z');
  // Grid stepping in local terms (06:00 <-> 18:00 across days).
  assert.equal(stepBoundary('twice-daily', '2026-03-08T12:00:00Z', 1), '2026-03-09T00:00:00Z'); // -> 18:00 MDT
  assert.equal(stepBoundary('twice-daily', '2026-03-09T00:00:00Z', 1), '2026-03-09T12:00:00Z'); // -> 06:00 MDT Mar 9
  assert.equal(stepBoundary('twice-daily', '2026-03-09T12:00:00Z', -2), '2026-03-08T12:00:00Z');
  // DST durations: 18:00 MST Mar 7 -> 06:00 MDT Mar 8 is 11 h; the same
  // window a week later (both MDT) is 12 h.
  assert.equal(windowForBoundary('twice-daily', '2026-03-08T12:00:00Z').durationMs, 11 * 60 * 60 * 1000);
  assert.equal(windowForBoundary('twice-daily', '2026-03-09T12:00:00Z').durationMs, 12 * 60 * 60 * 1000);
});

test('daily boundaries anchor to 07:00 America/Denver; the DST-crossing window is 23 h', () => {
  assert.equal(DAILY_HOUR, 7);
  assert.equal(currentBoundary('daily', '2026-03-08T13:00:00Z'), '2026-03-08T13:00:00Z'); // 07:00 MDT exactly
  assert.equal(currentBoundary('daily', '2026-03-08T12:59:59Z'), '2026-03-07T14:00:00Z'); // still yesterday's 07:00 MST
  assert.equal(nextBoundary('daily', '2026-03-07T14:00:00Z'), '2026-03-08T13:00:00Z');
  // [07:00 MST Mar 7, 07:00 MDT Mar 8) contains the jump: 23 hours.
  const dst = windowForBoundary('daily', '2026-03-08T13:00:00Z');
  assert.equal(dst.windowStart, '2026-03-07T14:00:00Z');
  assert.equal(dst.durationMs, 23 * 60 * 60 * 1000);
  // Plain MDT-to-MDT day is back to 24 h.
  assert.equal(windowForBoundary('daily', '2026-03-09T13:00:00Z').durationMs, 24 * 60 * 60 * 1000);
});

test('weekly boundaries anchor to Monday 07:00 America/Denver; the DST-crossing week is 167 h', () => {
  assert.equal(currentBoundary('weekly', '2026-03-09T13:00:00Z'), '2026-03-09T13:00:00Z'); // Mon 07:00 MDT exactly
  assert.equal(currentBoundary('weekly', '2026-03-09T12:59:59Z'), '2026-03-02T14:00:00Z'); // previous Monday 07:00 MST
  assert.equal(nextBoundary('weekly', '2026-03-09T13:00:00Z'), '2026-03-16T13:00:00Z');
  // [Mon Mar 2 07:00 MST, Mon Mar 9 07:00 MDT) contains the jump: 167 hours.
  const dst = windowForBoundary('weekly', '2026-03-09T13:00:00Z');
  assert.equal(dst.windowStart, '2026-03-02T14:00:00Z');
  assert.equal(dst.durationMs, 167 * 60 * 60 * 1000);
  assert.equal(windowForBoundary('weekly', '2026-03-16T13:00:00Z').durationMs, 168 * 60 * 60 * 1000);
});

test('weekend coverage of a Monday boundary is Fri+Sat+Sun (WD-014 rule mirrored)', () => {
  assert.deepEqual(weekendCoverageDays('2026-03-09T13:00:00Z'), ['2026-03-06', '2026-03-07', '2026-03-08']);
});

test('boundary and window labels name the program zone (DST visible on crossing windows)', () => {
  assert.equal(denverInstantLabel('2026-03-08T12:00:00Z'), '2026-03-08 06:00 MDT');
  assert.equal(denverInstantLabel('2026-03-07T14:00:00Z'), '2026-03-07 07:00 MST');
  // Same local day: short form.
  assert.equal(windowLabel('2026-03-09T13:00:00Z', '2026-03-09T14:00:00Z'), 'Mon 2026-03-09 07:00 → 08:00 MDT');
  // DST-crossing window: both zones labelled.
  assert.equal(windowLabel('2026-03-07T14:00:00Z', '2026-03-08T13:00:00Z'), 'Sat 2026-03-07 07:00 MST → Sun 2026-03-08 07:00 MDT');
});

test('Monday weekly digest includes the Fri+Sat+Sun interval EXACTLY ONCE (dedupe by event id)', () => {
  const world = buildTestWorld();
  const clockAt = (iso: string) => () => iso;
  const channel = createDeliveryRecorder();
  const svc = createNotificationService({ world, clock: clockAt('2026-03-02T15:00:00Z'), channel });

  const created = svc.createSubscription(FATIMA, {
    scope: { kind: 'system', systemId: 'sys-bear-river' },
    eventTypes: ['new-site', 'site-edit', 'no-signal', 'threshold'],
    cadence: 'weekly',
  });
  assert.ok(created.ok, JSON.stringify(created));
  const subscriptionId = created.subscription.id;
  // Created Monday Mar 2 15:00Z: first due boundary is next Monday 07:00 MDT.
  assert.equal(created.subscription.nextDueAt, '2026-03-09T13:00:00Z');

  // Weekend events (Fri/Sat/Sun), each RE-DELIVERED once (same id), plus one
  // stale event from before the subscription existed.
  const feed = [
    event({ id: 'ev-fri-new', type: 'new-site', objectId: 'sta-bear-corinne', systemId: 'sys-bear-river', occurredAt: '2026-03-06T20:00:00Z', summary: 'new site Fri' }),
    event({ id: 'ev-sat-edit', type: 'site-edit', objectId: 'sta-bear-corinne', systemId: 'sys-bear-river', occurredAt: '2026-03-07T18:00:00Z', summary: 'edit Sat' }),
    event({ id: 'ev-sun-early', type: 'no-signal', objectId: 'sta-bear-corinne', systemId: 'sys-bear-river', occurredAt: '2026-03-08T07:00:00Z', summary: 'no signal Sun (still MST)' }),
    event({ id: 'ev-sun-late', type: 'no-signal', objectId: 'sta-bear-corinne', systemId: 'sys-bear-river', occurredAt: '2026-03-08T15:00:00Z', summary: 'no signal Sun (MDT)' }),
    // Re-delivered duplicates (a redetection or replay of the same events).
    event({ id: 'ev-fri-new', type: 'new-site', objectId: 'sta-bear-corinne', systemId: 'sys-bear-river', occurredAt: '2026-03-06T20:00:00Z' }),
    event({ id: 'ev-sun-late', type: 'no-signal', objectId: 'sta-bear-corinne', systemId: 'sys-bear-river', occurredAt: '2026-03-08T15:00:00Z' }),
    // Stale: before creation - never delivered.
    event({ id: 'ev-old', type: 'new-site', objectId: 'sta-bear-corinne', systemId: 'sys-bear-river', occurredAt: '2026-03-01T20:00:00Z' }),
  ];

  const monday = svc.buildDigest(subscriptionId, '2026-03-09T13:00:00Z', feed);
  assert.ok(monday.issued, JSON.stringify(monday));
  assert.equal(monday.windowStart, '2026-03-02T15:00:00Z');
  assert.equal(monday.windowEnd, '2026-03-09T13:00:00Z');
  // Each weekend event appears exactly once.
  assert.deepEqual(
    monday.entries.map((entry) => entry.eventId),
    ['ev-fri-new', 'ev-sat-edit', 'ev-sun-early', 'ev-sun-late'],
  );
  assert.equal(monday.counts.included, 4);
  assert.equal(monday.counts.duplicatesDropped, 2);
  assert.equal(monday.counts.alreadyDelivered, 0);

  // The NEXT Monday: only newly-windowed events deliver. A re-delivered
  // already-delivered id (re-stamped into the new window by a redetection)
  // is skipped and counted - the weekend events appear in exactly ONE digest.
  const second = svc.buildDigest(subscriptionId, '2026-03-16T13:00:00Z', [
    ...feed,
    event({ id: 'ev-new-week', type: 'site-edit', objectId: 'sta-bear-corinne', systemId: 'sys-bear-river', occurredAt: '2026-03-12T18:00:00Z' }),
    event({ id: 'ev-sun-late', type: 'no-signal', objectId: 'sta-bear-corinne', systemId: 'sys-bear-river', occurredAt: '2026-03-10T15:00:00Z' }), // already delivered Monday
  ]);
  assert.ok(second.issued);
  assert.equal(second.windowStart, '2026-03-09T13:00:00Z');
  assert.equal(second.windowEnd, '2026-03-16T13:00:00Z');
  assert.deepEqual(
    second.entries.map((entry) => entry.eventId),
    ['ev-new-week'],
  );
  assert.equal(second.counts.alreadyDelivered, 1);
});

test('boundary math is deterministic run over run (fixed clocks, no wall reads)', () => {
  const instants = ['2026-03-06T22:10:00Z', '2026-03-08T09:00:00Z', '2026-03-08T12:00:00Z', '2026-03-09T13:00:00Z', '2026-11-01T08:30:00Z'];
  for (const cadence of ['hourly', 'twice-daily', 'daily', 'weekly'] as const) {
    const first = instants.map((at) => [currentBoundary(cadence, at), nextBoundary(cadence, at), windowForBoundary(cadence, currentBoundary(cadence, at)).durationMs]);
    const second = instants.map((at) => [currentBoundary(cadence, at), nextBoundary(cadence, at), windowForBoundary(cadence, currentBoundary(cadence, at)).durationMs]);
    assert.deepEqual(first, second, cadence);
  }
  // Fall-back sanity (2026-11-01): the daily window GAINS an hour (25 h).
  // Nov 1 07:00 local is MST (after the 01:00 fall-back) = 14:00Z; the
  // window ending there starts Oct 31 07:00 MDT = 13:00Z.
  const fallBack = windowForBoundary('daily', '2026-11-01T14:00:00Z');
  assert.equal(fallBack.windowStart, '2026-10-31T13:00:00Z');
  assert.equal(fallBack.durationMs, 25 * 60 * 60 * 1000);
});

test('subscriptions only issue at boundary instants: not-due one tick before, due exactly at the boundary', () => {
  const world = buildTestWorld();
  const channel = createDeliveryRecorder();
  const svc = createNotificationService({ world, clock: () => '2026-03-08T11:30:00Z', channel });
  const created = svc.createSubscription(CODY, {
    scope: { kind: 'system', systemId: 'sys-bear-river' },
    eventTypes: ['no-signal'],
    cadence: 'twice-daily',
  });
  assert.ok(created.ok);
  assert.equal(created.subscription.nextDueAt, '2026-03-08T12:00:00Z'); // 06:00 MDT
  const feed = [event({ id: 'ev-ns', type: 'no-signal', objectId: 'sta-bear-corinne', systemId: 'sys-bear-river', occurredAt: '2026-03-08T11:45:00Z' })];

  const early = svc.buildDigest(created.subscription.id, '2026-03-08T11:59:59Z', feed);
  assert.ok(!early.issued);
  assert.equal(early.reason, 'not-due');
  assert.equal(svc.digests(created.subscription.id).length, 0, 'a not-due digest is not recorded');
  assert.equal(channel.count(), 0, 'non-delivery: the simulated channel receives NOTHING');

  const onTime = svc.buildDigest(created.subscription.id, '2026-03-08T12:00:00Z', feed);
  assert.ok(onTime.issued);
  assert.equal(onTime.windowEnd, '2026-03-08T12:00:00Z');
  assert.equal(onTime.windowStart, '2026-03-08T11:30:00Z'); // anchored at creation
  assert.equal(channel.count(), 1);
  assert.equal(channel.receipts()[0]!.kind, 'digest');
  assert.deepEqual(channel.receipts()[0]!.eventIds, ['ev-ns']);
});
