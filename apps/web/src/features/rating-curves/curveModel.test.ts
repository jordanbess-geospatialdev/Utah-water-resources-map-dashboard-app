/**
 * curveModel suite (WD-011-R2, FR-045): pure view-model behaviour -
 * half-open period labels, timeline ordering that never collapses history,
 * state badges (text + shape), the conversion tester resolution (boundary
 * instants, shift layering, rejections) and lineage strings. Runs under
 * node:test with the repo-wide web glob.
 *
 * (Import pattern per apps/web/tests/adapters.test.ts: computed specifiers
 * for node --test --experimental-strip-types, type-only imports for tsc.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { CurveVersionView, ShiftVersionView } from './curveModel';

// Extensionless src imports under node --test (see tests/ts-resolve-hook.mjs).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const curveModelPath = './curveModel.ts';
const curveModel: typeof import('./curveModel') = await import(curveModelPath);
const {
  approvalLabel,
  buildTimeline,
  convertStage,
  curveFormula,
  formatInterval,
  intervalCovers,
  lineageString,
  shiftSegmentsText,
  stateBadge,
} = curveModel;

const JOIN = '2026-03-07T18:00:00Z';

/** The two fixture periods as the API seeds them (coefficients pending owner approval). */
const CURVES: readonly CurveVersionView[] = [
  {
    id: 'rc-corinne-2019',
    version: 1,
    method: 'Log-linear least squares, n=18 calibrations',
    coefficients: { c: 38.0, b: 1.85, e: 1.7 },
    unitPair: { fromUnitId: 'ft', toUnitId: 'cfs' },
    effectiveFrom: '2019-10-01T00:00:00Z',
    effectiveTo: JOIN,
    author: 'principal-diego-steward',
    approvalState: 'superseded',
    approvedBy: 'principal-diego-steward',
    approvedAt: '2019-10-01T00:00:00Z',
    provenanceNote: 'Working log-linear fit for the 2019 device era.',
  },
  {
    id: 'rc-corinne-2026',
    version: 2,
    method: 'Log-linear least squares, n=22 calibrations, high-flow extension',
    coefficients: { c: 41.2, b: 1.92, e: 1.68 },
    unitPair: { fromUnitId: 'ft', toUnitId: 'cfs' },
    effectiveFrom: JOIN,
    effectiveTo: null,
    author: 'principal-diego-steward',
    approvalState: 'approved',
    approvedBy: 'principal-diego-steward',
    approvedAt: JOIN,
    provenanceNote: 'High-flow extension for the RTU replacement era.',
  },
];

const SHIFT: readonly ShiftVersionView[] = [
  {
    id: 'shf-1001',
    version: 1,
    segments: [
      { fromStageFt: 0, toStageFt: 2.45, offsetFt: 0.03 },
      { fromStageFt: 2.45, toStageFt: null, offsetFt: 0.06 },
    ],
    reason: 'Gauge datum re-survey after the RTU replacement.',
    effectiveFrom: JOIN,
    effectiveTo: null,
    author: 'principal-fatima-engineer',
    approvalState: 'approved',
    approvedBy: 'principal-cody-commissioner',
    approvedAt: '2026-03-09T07:00:00Z',
  },
];

test('formatInterval renders half-open labels, open tails included', () => {
  assert.equal(formatInterval('2019-10-01T00:00:00Z', JOIN), '[2019-10-01T00:00:00Z, 2026-03-07T18:00:00Z)');
  assert.equal(formatInterval(JOIN, null), '[2026-03-07T18:00:00Z, open)');
});

test('intervalCovers honours the boundary instant exactly once', () => {
  assert.equal(intervalCovers('2019-10-01T00:00:00Z', JOIN, '2026-03-07T17:59:59.999Z'), true);
  assert.equal(intervalCovers('2019-10-01T00:00:00Z', JOIN, JOIN), false); // half-open excludes the end
  assert.equal(intervalCovers(JOIN, null, JOIN), true); // and the successor includes it
  assert.equal(intervalCovers(JOIN, null, 'not-a-date'), false);
});

test('state badges and approval labels are text + shape, never color alone', () => {
  assert.deepEqual(stateBadge('approved'), { marker: '●', text: 'approved' });
  assert.deepEqual(stateBadge('draft'), { marker: '○', text: 'draft (pending owner approval)' });
  assert.deepEqual(stateBadge('superseded'), { marker: '✕', text: 'superseded (retained)' });
  assert.equal(approvalLabel({ approvalState: 'draft', approvedBy: null, approvedAt: null }), 'pending');
  assert.equal(
    approvalLabel({ approvalState: 'approved', approvedBy: 'principal-cody-commissioner', approvedAt: '2026-03-09T07:00:00Z' }),
    'principal-cody-commissioner at 2026-03-09T07:00:00Z',
  );
});

test('the timeline lists every version - superseded history never collapses', () => {
  const rows = buildTimeline(CURVES, SHIFT);
  assert.equal(rows.length, 3);
  // curves first, then shifts, each ordered by chain ordinal
  assert.deepEqual(
    rows.map((row) => `${row.kind}:${row.id}`),
    ['curve:rc-corinne-2019', 'curve:rc-corinne-2026', 'shift:shf-1001'],
  );
  const superseded = rows[0]!;
  assert.equal(superseded.superseded, true);
  assert.equal(superseded.stateText, 'superseded (retained)');
  assert.equal(superseded.periodLabel, '[2019-10-01T00:00:00Z, 2026-03-07T18:00:00Z)');
  const shiftRow = rows[2]!;
  assert.equal(shiftRow.detail, '+0.03 ft on [0, 2.45); +0.06 ft on [2.45, open)');
  assert.equal(shiftRow.lineageLabel, 'v1 shf-1001');
});

test('curveFormula and shiftSegmentsText render the documented formulas', () => {
  assert.equal(curveFormula({ c: 41.2, b: 1.92, e: 1.68 }, { fromUnitId: 'ft', toUnitId: 'cfs' }), 'Q[cfs] = 41.2 × (G[ft] − 1.68)^1.92');
  assert.equal(shiftSegmentsText([{ fromStageFt: 3, toStageFt: null, offsetFt: -0.05 }]), '-0.05 ft on [3, open)');
});

test('the conversion tester resolves boundary instants and hand-derived goldens', () => {
  // one millisecond before the join: 2019 curve
  const before = convertStage(CURVES, [], 2.5, '2026-03-07T17:59:59.999Z');
  assert.equal(before.kind, 'converted');
  if (before.kind === 'converted') {
    assert.equal(before.curveVersionId, 'rc-corinne-2019');
    assert.ok(Math.abs(before.value - 25.148) < 0.001);
    assert.equal(before.periodLabel, '[2019-10-01T00:00:00Z, 2026-03-07T18:00:00Z)');
  }
  // at the join instant: 2026 curve
  const at = convertStage(CURVES, [], 2.5, JOIN);
  assert.equal(at.kind, 'converted');
  if (at.kind === 'converted') {
    assert.equal(at.curveVersionId, 'rc-corinne-2026');
    assert.ok(Math.abs(at.value - 28.146) < 0.001);
  }
  // the fixture stage readings
  for (const [stage, at2, expected, id] of [
    [2.41, '2026-03-07T12:00:00Z', 20.166, 'rc-corinne-2019'],
    [2.44, '2026-03-08T00:00:00Z', 24.325, 'rc-corinne-2026'],
    [2.52, '2026-03-08T20:00:00Z', 29.479, 'rc-corinne-2026'],
    [2.58, '2026-03-09T06:00:00Z', 33.654, 'rc-corinne-2026'],
  ] as const) {
    const result = convertStage(CURVES, [], stage, at2);
    assert.equal(result.kind, 'converted');
    if (result.kind === 'converted') {
      assert.equal(result.curveVersionId, id);
      assert.ok(Math.abs(result.value - expected) < 0.001);
    }
  }
});

test('the conversion tester layers shifts and carries both lineage ids', () => {
  const shifted = convertStage(CURVES, SHIFT, 2.52, '2026-03-08T20:00:00Z');
  assert.equal(shifted.kind, 'converted');
  if (shifted.kind === 'converted') {
    assert.equal(shifted.shiftVersionId, 'shf-1001');
    assert.ok(Math.abs(shifted.effectiveStageFt - 2.58) < 1e-9);
    assert.ok(Math.abs(shifted.value - 33.654) < 0.001);
    assert.equal(shifted.lineage, 'curve rc-corinne-2026 + shift shf-1001');
  }
  // before the shift is effective there is no shift lineage
  const before = convertStage(CURVES, SHIFT, 2.41, '2026-03-07T12:00:00Z');
  assert.equal(before.kind, 'converted');
  if (before.kind === 'converted') {
    assert.equal(before.shiftVersionId, null);
    assert.equal(before.lineage, 'curve rc-corinne-2019');
  }
});

test('the conversion tester rejects the documented failure modes', () => {
  const noCurve = convertStage(CURVES, [], 2.5, '2018-01-01T00:00:00Z');
  assert.equal(noCurve.kind, 'rejected');
  if (noCurve.kind === 'rejected') assert.equal(noCurve.code, 'NO_CURVE');

  const draftOnly: readonly CurveVersionView[] = [
    { ...CURVES[1]!, id: 'rcv-1001', approvalState: 'draft', approvedBy: null, approvedAt: null, version: 3 },
  ];
  const notApproved = convertStage(draftOnly, [], 2.5, JOIN);
  assert.equal(notApproved.kind, 'rejected');
  if (notApproved.kind === 'rejected') assert.equal(notApproved.code, 'NOT_APPROVED');

  const belowDatum = convertStage(CURVES, [], 1.0, JOIN);
  assert.equal(belowDatum.kind, 'rejected');
  if (belowDatum.kind === 'rejected') assert.equal(belowDatum.code, 'STAGE_BELOW_DATUM');

  const badStage = convertStage(CURVES, [], Number.NaN, JOIN);
  assert.equal(badStage.kind === 'rejected' && badStage.code, 'STAGE_INVALID');

  const badAt = convertStage(CURVES, [], 2.5, 'whenever');
  assert.equal(badAt.kind === 'rejected' && badAt.code, 'AT_INVALID');

  const partialShift: readonly ShiftVersionView[] = [
    { ...SHIFT[0]!, segments: [{ fromStageFt: 3.0, toStageFt: null, offsetFt: -0.05 }] },
  ];
  const uncovered = convertStage(CURVES, partialShift, 2.52, '2026-03-08T20:00:00Z');
  assert.equal(uncovered.kind === 'rejected' && uncovered.code, 'SHIFT_UNCOVERED');
});

test('lineageString names every version used', () => {
  assert.equal(lineageString({ curveVersionId: 'rc-corinne-2026', shiftVersionId: null }), 'curve rc-corinne-2026');
  assert.equal(
    lineageString({ curveVersionId: 'rc-corinne-2026', shiftVersionId: 'shf-1001' }),
    'curve rc-corinne-2026 + shift shf-1001',
  );
});
