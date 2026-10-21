/**
 * Conversion goldens (WD-011-R2; FR-045; acceptance T-06):
 * hand-derived stage -> discharge values for the fixture's TWO rating-curve
 * periods, plus the boundary instant where they join and one layered shift.
 *
 * DOCUMENTED FORMULAS (the working data-owner formulas seeded from the
 * frozen fixture; coefficients PENDING OWNER APPROVAL per the R2
 * convention - the fixture publishes period ids, dates and method labels
 * only, the numbers below are pinned by this suite until sign-off):
 *
 *   rc-corinne-2019  Q[cfs] = 38.0 * (G[ft] - 1.70)^1.85
 *                    effective [2019-10-01T00:00:00Z, 2026-03-07T18:00:00Z)
 *   rc-corinne-2026  Q[cfs] = 41.2 * (G[ft] - 1.68)^1.92
 *                    effective [2026-03-07T18:00:00Z, open)
 *
 * HAND DERIVATIONS (natural-log arithmetic, 5 significant digits):
 *
 *  2019 curve, G = 2.41 (obs-stage-001, observed 2026-03-07T12:00:00Z):
 *    depth d = 2.41 - 1.70 = 0.71
 *    ln 0.71 = -0.34249;  * 1.85 = -0.63361
 *    e^-0.63361 = 0.53072;  * 38.0 = 20.166  ->  20.166 cfs
 *
 *  2019 curve, G = 2.50 (one millisecond before the join, 17:59:59.999Z):
 *    d = 0.80; ln 0.80 = -0.22314; * 1.85 = -0.41282
 *    e^-0.41282 = 0.66180;  * 38.0 = 25.148  ->  25.148 cfs
 *
 *  2026 curve, G = 2.50 (exactly AT the join instant, 18:00:00.000Z):
 *    d = 2.50 - 1.68 = 0.82; ln 0.82 = -0.19845; * 1.92 = -0.38103
 *    e^-0.38103 = 0.68303;  * 41.2 = 28.146  ->  28.146 cfs
 *
 *  2026 curve, G = 2.44 (obs-stage-002, observed 2026-03-08T00:00:00Z):
 *    d = 0.76; ln 0.76 = -0.27444; * 1.92 = -0.52692
 *    e^-0.52692 = 0.59042;  * 41.2 = 24.325  ->  24.325 cfs
 *
 *  2026 curve, G = 2.52 (obs-stage-003, observed 2026-03-08T20:00:00Z):
 *    d = 0.84; ln 0.84 = -0.17435; * 1.92 = -0.33476
 *    e^-0.33476 = 0.71552;  * 41.2 = 29.479  ->  29.479 cfs
 *
 *  2026 curve, G = 2.58 (obs-stage-004, observed 2026-03-09T06:00:00Z):
 *    d = 0.90; ln 0.90 = -0.10536; * 1.92 = -0.20229
 *    e^-0.20229 = 0.81686;  * 41.2 = 33.654  ->  33.654 cfs
 *
 *  SHIFT layering (approved shift effective [2026-03-07T18:00:00Z, open):
 *    segments: +0.03 ft for stages [0, 2.45), +0.06 ft for [2.45, open)
 *    G = 2.42 at 2026-03-08T00:00Z -> effective 2.45:
 *      d = 0.77; ln 0.77 = -0.26136; * 1.92 = -0.50182
 *      e^-0.50182 = 0.60535;  * 41.2 = 24.944  ->  24.944 cfs
 *    G = 2.52 at 2026-03-08T20:00Z -> effective 2.58:
 *      same derivation as G = 2.58 above                ->  33.654 cfs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRatingCurveStore, SEED_CURVE_COEFFICIENTS } from '../store.ts';
import { convertStage } from '../curves.ts';
import { approveShiftVersion, convertWithShift, createShiftVersion } from '../shifts.ts';
import type { WorkflowContext } from '../types.ts';

const FATIMA = 'principal-fatima-engineer';
const CODY = 'principal-cody-commissioner';
const NOW = '2026-03-09T07:00:00Z';
const STREAM = 'str-corinne-q';
const CTX: WorkflowContext = { now: NOW };

/** Hand-derived goldens: [stage ft, instant, expected cfs, expected curve version]. */
const GOLDENS: ReadonlyArray<readonly [number, string, number, string]> = [
  [2.41, '2026-03-07T12:00:00Z', 20.166, 'rc-corinne-2019'],
  [2.5, '2026-03-07T17:59:59.999Z', 25.148, 'rc-corinne-2019'],
  [2.5, '2026-03-07T18:00:00.000Z', 28.146, 'rc-corinne-2026'],
  [2.44, '2026-03-08T00:00:00Z', 24.325, 'rc-corinne-2026'],
  [2.52, '2026-03-08T20:00:00Z', 29.479, 'rc-corinne-2026'],
  [2.58, '2026-03-09T06:00:00Z', 33.654, 'rc-corinne-2026'],
];

test('the seeded coefficients match the documented formulas', () => {
  assert.deepEqual(SEED_CURVE_COEFFICIENTS['rc-corinne-2019'], {
    c: 38.0,
    b: 1.85,
    e: 1.7,
    calibrationCount: 18,
    note: 'Working log-linear fit for the 2019 device era; coefficients pending data-owner approval.',
  });
  assert.deepEqual(SEED_CURVE_COEFFICIENTS['rc-corinne-2026'], {
    c: 41.2,
    b: 1.92,
    e: 1.68,
    calibrationCount: 22,
    note: 'Working log-linear fit with high-flow extension for the RTU replacement era; coefficients pending data-owner approval.',
  });
});

test('conversion goldens: the fixture stage readings under their own curve periods', () => {
  const store = createRatingCurveStore();
  for (const [stage, at, expected, versionId] of GOLDENS) {
    const result = convertStage(store, STREAM, stage, at, CTX);
    assert.equal(result.outcome, 'converted', `${stage} ft at ${at}`);
    if (result.outcome !== 'converted') continue;
    assert.equal(result.value.curveVersionId, versionId, `${stage} ft at ${at}`);
    assert.equal(result.value.shiftVersionId, null, 'no shift is seeded');
    assert.equal(result.value.unitId, 'cfs');
    assert.ok(
      Math.abs(result.value.value - expected) < 0.001,
      `${stage} ft at ${at}: expected ~${expected} cfs, got ${result.value.value}`,
    );
  }
});

test('the half-open join: one millisecond apart resolves to different versions', () => {
  const store = createRatingCurveStore();
  const before = convertStage(store, STREAM, 2.5, '2026-03-07T17:59:59.999Z', CTX);
  const at = convertStage(store, STREAM, 2.5, '2026-03-07T18:00:00.000Z', CTX);
  assert.equal(before.outcome, 'converted');
  assert.equal(at.outcome, 'converted');
  if (before.outcome === 'converted' && at.outcome === 'converted') {
    assert.equal(before.value.curveVersionId, 'rc-corinne-2019');
    assert.equal(at.value.curveVersionId, 'rc-corinne-2026');
    assert.ok(Math.abs(before.value.value - 25.148) < 0.001);
    assert.ok(Math.abs(at.value.value - 28.146) < 0.001);
    // the ledger records BOTH, each with its own lineage
    assert.equal(store.computedValues.length, 2);
  }
});

test('shift goldens: layered offsets feed the curve and both ids are carried', () => {
  const store = createRatingCurveStore();
  const created = createShiftVersion(store, FATIMA, STREAM, {
    segments: [
      { fromStageFt: 0, toStageFt: 2.45, offsetFt: 0.03 },
      { fromStageFt: 2.45, toStageFt: null, offsetFt: 0.06 },
    ],
    reason: 'Gauge datum re-survey after the RTU replacement found the orifice high.',
    effectiveFrom: '2026-03-07T18:00:00Z',
  }, CTX);
  assert.equal(created.outcome, 'applied');
  const approved = created.outcome === 'applied' ? approveShiftVersion(store, CODY, created.version.id, CTX) : null;
  assert.equal(approved?.outcome, 'applied');
  const shiftId = created.outcome === 'applied' ? created.version.id : '';

  // lower segment: 2.42 + 0.03 = 2.45 effective
  const lower = convertWithShift(store, STREAM, 2.42, '2026-03-08T00:00:00Z', CTX);
  assert.equal(lower.outcome, 'converted');
  if (lower.outcome === 'converted') {
    assert.equal(lower.value.shiftVersionId, shiftId);
    assert.equal(lower.value.curveVersionId, 'rc-corinne-2026');
    assert.ok(Math.abs(lower.value.value - 24.944) < 0.001, `got ${lower.value.value}`);
  }

  // upper segment: 2.52 + 0.06 = 2.58 effective (equals the 2.58 golden)
  const upper = convertWithShift(store, STREAM, 2.52, '2026-03-08T20:00:00Z', CTX);
  assert.equal(upper.outcome, 'converted');
  if (upper.outcome === 'converted') {
    assert.equal(upper.value.shiftVersionId, shiftId);
    assert.equal(upper.value.effectiveStageFt, 2.58);
    assert.ok(Math.abs(upper.value.value - 33.654) < 0.001, `got ${upper.value.value}`);
  }

  // before the shift is effective the unshifted golden still holds
  const unshifted = convertWithShift(store, STREAM, 2.41, '2026-03-07T12:00:00Z', CTX);
  assert.equal(unshifted.outcome, 'converted');
  if (unshifted.outcome === 'converted') {
    assert.equal(unshifted.value.shiftVersionId, null);
    assert.ok(Math.abs(unshifted.value.value - 20.166) < 0.001);
  }
});
