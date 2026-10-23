/**
 * Determinism suite (WD-011-R2; acceptance T-06 "determinism twice"):
 *
 * The store has no clock reads and no randomness; identifiers derive from
 * append sequences. Two stores built from the same frozen fixtures, driven
 * by the identical operation sequence and the identical injected clock,
 * must produce byte-identical version chains, ledgers, audit logs and
 * outbox logs - and the same conversion, computed twice, must return the
 * identical value object.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { RatingCurveStore } from '../store.ts';
import { createRatingCurveStore } from './approvalGrants.ts';
import { approveCurveVersion, convertStage, createCurveVersion, supersedeCurveVersion } from '../curves.ts';
import { approveShiftVersion, convertWithShift, createShiftVersion, supersedeShiftVersion } from '../shifts.ts';

const FATIMA = 'principal-fatima-engineer';
const CODY = 'principal-cody-commissioner';
const NOW = '2026-03-09T07:00:00Z';
const STREAM = 'str-corinne-q';

function drive(store: RatingCurveStore): void {
  const ctx = { now: NOW }; // one fixed injected clock for the whole sequence

  const created = createCurveVersion(store, FATIMA, 'str-corinne-stage', {
    coefficients: { c: 40.1, b: 1.9, e: 1.69 },
    unitPair: { fromUnitId: 'ft', toUnitId: 'cfs' },
    method: 'Log-linear least squares, n=20 calibrations (stage-pilot draft)',
    effectiveFrom: '2026-03-01T00:00:00Z',
  }, ctx);
  if (created.outcome === 'applied') approveCurveVersion(store, CODY, created.version.id, ctx);

  const shift = createShiftVersion(store, FATIMA, STREAM, {
    segments: [
      { fromStageFt: 0, toStageFt: 2.45, offsetFt: 0.03 },
      { fromStageFt: 2.45, toStageFt: null, offsetFt: 0.06 },
    ],
    reason: 'Datum re-survey.',
    effectiveFrom: '2026-03-07T18:00:00Z',
  }, ctx);
  if (shift.outcome === 'applied') approveShiftVersion(store, CODY, shift.version.id, ctx);

  const superseded = supersedeCurveVersion(store, FATIMA, STREAM, {
    coefficients: { c: 42.5, b: 1.95, e: 1.66 },
    unitPair: { fromUnitId: 'ft', toUnitId: 'cfs' },
    method: 'Log-linear least squares, n=24 calibrations',
    effectiveFrom: '2026-03-09T06:00:00Z',
    supersedeReason: 'Refit after the March 9 meter verification.',
  }, ctx);
  if (superseded.outcome === 'applied') approveCurveVersion(store, CODY, superseded.version.id, ctx);

  supersedeShiftVersion(store, FATIMA, STREAM, {
    segments: [{ fromStageFt: 0, toStageFt: null, offsetFt: 0.02 }],
    reason: 'Refined datum correction.',
    effectiveFrom: '2026-03-10T00:00:00Z',
    supersedeReason: 'Refined datum correction.',
  }, ctx);

  for (const [stage, at] of [
    [2.41, '2026-03-07T12:00:00Z'],
    [2.52, '2026-03-08T20:00:00Z'],
    [2.58, '2026-03-09T06:00:00Z'],
  ] as const) {
    convertStage(store, STREAM, stage, at, ctx);
    convertWithShift(store, STREAM, stage, at, ctx);
  }
}

function serialize(store: RatingCurveStore): string {
  return JSON.stringify({
    curves: Object.fromEntries(['str-corinne-q', 'str-corinne-stage'].map((id) => [id, store.curveVersionsOf(id)])),
    shifts: Object.fromEntries(['str-corinne-q', 'str-corinne-stage'].map((id) => [id, store.shiftVersionsOf(id)])),
    computedValues: store.computedValues,
    auditEvents: store.auditEvents,
    outboxEvents: store.outboxEvents,
  });
}

test('the identical operation sequence produces a byte-identical log (twice)', () => {
  const first = createRatingCurveStore();
  drive(first);
  const second = createRatingCurveStore();
  drive(second);
  const third = createRatingCurveStore();
  drive(third);

  const a = serialize(first);
  const b = serialize(second);
  const c = serialize(third);
  assert.equal(a, b);
  assert.equal(b, c);
});

test('the same conversion computed twice returns the identical value object', () => {
  const store = createRatingCurveStore();
  const first = convertStage(store, STREAM, 2.52, '2026-03-08T20:00:00Z', { now: NOW });
  const second = convertStage(store, STREAM, 2.52, '2026-03-08T20:00:00Z', { now: NOW });
  assert.equal(first.outcome, 'converted');
  assert.equal(second.outcome, 'converted');
  if (first.outcome === 'converted' && second.outcome === 'converted') {
    assert.deepEqual(first.value, second.value);
  }
});
