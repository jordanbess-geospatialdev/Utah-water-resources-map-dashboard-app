/**
 * Threshold evaluation tests (WD-015; FR-025 threshold violations; T-15):
 * per-property bounds reuse WD-013's reviewed QC range configuration, a
 * subscription's own bounds override per property, and a SUSTAINED violation
 * yields exactly ONE event per (stream, property, window) - one digest entry
 * per digest, never one per reading.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/notifications/test/thresholds.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULE_CONFIGS } from '../../qc/rules.ts';
import { defaultThresholdBounds, evaluateThresholdEvents, thresholdEventId, validateThresholds } from '../thresholds.ts';
import { createNotificationService } from '../subscriptions.ts';
import { createDeliveryRecorder } from '../types.ts';
import { buildTestWorld, FATIMA, SYSTEM_BEAR } from './helpers.ts';

const STREAM = { streamId: 'str-corinne-q', systemId: SYSTEM_BEAR, observedPropertyId: 'discharge', unitId: 'cfs' };
const WINDOW = { start: '2026-03-09T15:00:00Z', end: '2026-03-09T16:00:00Z' };

const reading = (minutesPast: number, value: number | null): { observedAt: string; value: number | null } => ({
  observedAt: `2026-03-09T15:${String(minutesPast).padStart(2, '0')}:00Z`,
  value,
});

test('default bounds are WD-013\'s reviewed QC range configuration (relative import, no divergence)', () => {
  assert.deepEqual(defaultThresholdBounds(), DEFAULT_RULE_CONFIGS.range.bounds);
  assert.deepEqual(defaultThresholdBounds(), { discharge: { min: 0, max: 1200 }, stage: { min: 0, max: 15 }, voltage: { min: 11.5, max: 15 } });
});

test('bounds validation: at least one finite bound per property, min < max when both', () => {
  assert.deepEqual(validateThresholds({}), []);
  assert.deepEqual(validateThresholds(null), []);
  assert.deepEqual(validateThresholds({ discharge: { min: 0, max: 25 } }), []);
  assert.deepEqual(validateThresholds({ discharge: { max: 25 } }), []);
  assert.deepEqual(validateThresholds({ discharge: {} }), ['empty-bound']);
  assert.deepEqual(validateThresholds({ discharge: { min: 9, max: 2 } }), ['bad-bounds']);
  assert.deepEqual(validateThresholds({ discharge: { min: Number.NaN } }), ['bad-bounds']);
  assert.deepEqual(validateThresholds([1, 2]), ['bad-bounds']);
});

test('a sustained violation over one window yields ONE event - not one per reading', () => {
  // Ten sustained readings above the subscribed max of 25 cfs.
  const points = [reading(0, 26), reading(5, 27), reading(10, 28), reading(15, 30), reading(20, 26), reading(25, 27), reading(30, 29), reading(35, 30), reading(40, 28), reading(45, 26)];
  const events = evaluateThresholdEvents(STREAM, points, WINDOW, { discharge: { max: 25 } });
  assert.equal(events.length, 1);
  const [only] = events;
  assert.equal(only!.id, thresholdEventId('str-corinne-q', 'discharge', WINDOW.start));
  assert.equal(only!.type, 'threshold');
  assert.equal(only!.objectKind, 'datastream');
  assert.equal(only!.objectId, 'str-corinne-q');
  assert.equal(only!.streamId, 'str-corinne-q');
  assert.equal(only!.occurredAt, '2026-03-09T15:15:00Z', 'the WORST reading (30) is the occurredAt');
  assert.ok(only!.summary.includes('10 of 10 window readings'), only!.summary);
  assert.ok(only!.summary.includes('worst 30 cfs'), only!.summary);
  assert.ok(only!.summary.includes('above max 25 cfs'), only!.summary);

  // Re-evaluating the same window (a redetection) yields the SAME id: the
  // digest dedupe collapses it - one entry per digest, not per reading.
  const again = evaluateThresholdEvents(STREAM, points, WINDOW, { discharge: { max: 25 } });
  assert.equal(again[0]!.id, only!.id);
});

test('null readings are not threshold violations; readings outside the window are ignored; inclusive bounds', () => {
  const points = [reading(0, null), reading(5, 10), reading(10, 25), reading(55, 9500 /* outside the window? no - 55 min IS inside */), reading(70, 9500 /* outside: after 16:00 */)];
  const windowEvents = evaluateThresholdEvents(STREAM, points, WINDOW, { discharge: { max: 1200 } });
  // Only the 9500 at :55 is a violation (25 == max is inclusive-clean, null
  // ignored, the 9500 at :70 is outside the window); the denominator counts
  // the 3 NON-NULL in-window readings.
  assert.equal(windowEvents.length, 1);
  assert.ok(windowEvents[0]!.summary.includes('1 of 3 window readings'), windowEvents[0]!.summary);

  const clean = evaluateThresholdEvents(STREAM, [reading(0, null), reading(5, 0), reading(10, 1200)], WINDOW, {});
  assert.equal(clean.length, 0, 'bounds are inclusive: 0 and 1200 are NOT violations');
});

test('a property without configured bounds yields no event; defaults apply without overrides', () => {
  const gauge = { streamId: 'str-other', systemId: SYSTEM_BEAR, observedPropertyId: 'gauge-height', unitId: 'ft' };
  assert.deepEqual(evaluateThresholdEvents(gauge, [reading(0, 99999)], WINDOW, {}), [], 'no bounds configured: no alert');

  // Default WD-013 bounds: the 9500 cfs fixture spike violates max 1200.
  const spike = evaluateThresholdEvents(STREAM, [reading(0, 9500), reading(5, 26)], WINDOW, {});
  assert.equal(spike.length, 1);
  assert.ok(spike[0]!.summary.includes('0-1200 cfs'), spike[0]!.summary);

  // Voltage defaults on the internal diagnostic stream: 11.1 V below min 11.5.
  const voltage = evaluateThresholdEvents({ streamId: 'str-diag-voltage', systemId: SYSTEM_BEAR, observedPropertyId: 'voltage', unitId: 'V' }, [{ observedAt: '2026-03-09T15:10:00Z', value: 11.1 }], WINDOW, {});
  assert.equal(voltage.length, 1);
  assert.ok(voltage[0]!.summary.includes('below min 11.5 V'), voltage[0]!.summary);
});

test('a threshold subscription digests one entry per window; the next window is a NEW event', () => {
  const world = buildTestWorld();
  const channel = createDeliveryRecorder();
  const svc = createNotificationService({ world, clock: () => '2026-03-09T15:10:00Z', channel });
  const created = svc.createSubscription(FATIMA, {
    scope: { kind: 'stream', streamId: 'str-corinne-q' },
    eventTypes: ['threshold'],
    thresholds: { discharge: { max: 25 } },
    cadence: 'hourly',
  });
  assert.ok(created.ok);
  const subscriptionId = created.subscription.id;

  // Hour 15:00-16:00 sustained violation, event record re-delivered twice.
  const hourOne = [...evaluateThresholdEvents(STREAM, [reading(0, 26), reading(5, 27), reading(10, 30)], WINDOW, created.subscription.thresholds)];
  const first = svc.buildDigest(subscriptionId, '2026-03-09T16:00:00Z', [...hourOne, ...hourOne]);
  assert.ok(first.issued);
  assert.equal(first.counts.included, 1, 'ONE entry for the sustained violation');
  assert.equal(first.counts.duplicatesDropped, 1, 'the redelivered record collapsed by id');
  assert.equal(first.entries[0]!.eventType, 'threshold');

  // Hour 16:00-17:00 still violating: a NEW window key, a new event, one entry.
  const hourTwo = evaluateThresholdEvents(
    STREAM,
    [
      { observedAt: '2026-03-09T16:05:00Z', value: 28 },
      { observedAt: '2026-03-09T16:35:00Z', value: 29 },
    ],
    { start: '2026-03-09T16:00:00Z', end: '2026-03-09T17:00:00Z' },
    created.subscription.thresholds,
  );
  const second = svc.buildDigest(subscriptionId, '2026-03-09T17:00:00Z', hourTwo);
  assert.ok(second.issued);
  assert.equal(second.counts.included, 1);
  assert.notEqual(second.entries[0]!.eventId, first.entries[0]!.eventId, 'a different window is a different event id');

  // Hour 17:00-18:00 back in bounds: no event, NO receipt.
  const hourThree = evaluateThresholdEvents(
    STREAM,
    [{ observedAt: '2026-03-09T17:05:00Z', value: 20 }],
    { start: '2026-03-09T17:00:00Z', end: '2026-03-09T18:00:00Z' },
    created.subscription.thresholds,
  );
  const third = svc.buildDigest(subscriptionId, '2026-03-09T18:00:00Z', hourThree);
  assert.ok(third.issued);
  assert.equal(third.counts.included, 0);
  assert.equal(third.receipt, null);
  assert.equal(channel.count(), 2, 'two delivering digests; the clean window delivered NOTHING');
});
