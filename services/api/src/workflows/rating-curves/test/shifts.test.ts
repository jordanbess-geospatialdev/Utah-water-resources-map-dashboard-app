/**
 * Shift suite (WD-011-R2; FR-045; acceptance T-06):
 * - shift versions layer on curves with the same governance (author /
 *   approver separation, draft -> approved -> superseded);
 * - the combined conversion carries BOTH lineage ids (curve version AND
 *   shift version);
 * - segment tables validate (span, ordering, open tail last, finite
 *   offsets) and a shift that does not cover the stage is never partially
 *   applied;
 * - shift periods are overlap-guarded and superseded without deletion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRatingCurveStore } from '../store.ts';
import { convertStage } from '../curves.ts';
import {
  approveShiftVersion,
  convertWithShift,
  createShiftVersion,
  supersedeShiftVersion,
} from '../shifts.ts';
import type { ShiftVersionInput, WorkflowContext } from '../types.ts';

const FATIMA = 'principal-fatima-engineer';
const CODY = 'principal-cody-commissioner';
const DIEGO = 'principal-diego-steward';
const NOW = '2026-03-09T07:00:00Z';
const STREAM = 'str-corinne-q';
const JOIN = '2026-03-07T18:00:00Z';

const ctx = (now: string = NOW): WorkflowContext => ({ now });

/** A two-segment datum shift: +0.03 ft below 2.45 ft, +0.06 ft above. */
const DATUM_SHIFT: ShiftVersionInput = {
  segments: [
    { fromStageFt: 0, toStageFt: 2.45, offsetFt: 0.03 },
    { fromStageFt: 2.45, toStageFt: null, offsetFt: 0.06 },
  ],
  reason: 'Gauge datum re-survey after the RTU replacement found the orifice 0.03-0.06 ft high.',
  effectiveFrom: JOIN,
};

function approvedShift(input: ShiftVersionInput = DATUM_SHIFT) {
  const store = createRatingCurveStore();
  const created = createShiftVersion(store, FATIMA, STREAM, input, ctx());
  assert.equal(created.outcome, 'applied');
  const approved = created.outcome === 'applied' ? approveShiftVersion(store, CODY, created.version.id, ctx()) : null;
  assert.equal(approved?.outcome, 'applied');
  return { store, shiftId: created.outcome === 'applied' ? created.version.id : '' };
}

test('a shift version lands as a draft, gates on approval, and is attributed', () => {
  const store = createRatingCurveStore();
  const created = createShiftVersion(store, FATIMA, STREAM, DATUM_SHIFT, ctx());
  assert.equal(created.outcome, 'applied');
  if (created.outcome !== 'applied') return;
  assert.equal(created.status, 201);
  assert.equal(created.version.approvalState, 'draft');
  assert.equal(created.version.author, FATIMA);
  assert.equal(created.version.segments.length, 2);
  assert.equal(created.version.version, 1);

  // the author cannot approve; the owner side can
  const self = approveShiftVersion(store, FATIMA, created.version.id, ctx());
  assert.equal(self.outcome, 'rejected');
  if (self.outcome === 'rejected') assert.equal(self.status, 403);
  const approved = approveShiftVersion(store, CODY, created.version.id, ctx());
  assert.equal(approved.outcome, 'applied');
  if (approved.outcome === 'applied') {
    assert.equal(approved.version.approvalState, 'approved');
    assert.equal(approved.version.approvedBy, CODY);
  }
});

test('the combined conversion carries both lineage ids and applies the segment offset', () => {
  const { store, shiftId } = approvedShift();
  // stage 2.52 ft at 2026-03-08T20:00Z: the 2026 curve is effective and the
  // shift's upper segment (+0.06) applies: effective stage 2.58 ft
  const shifted = convertWithShift(store, STREAM, 2.52, '2026-03-08T20:00:00Z', ctx());
  assert.equal(shifted.outcome, 'converted');
  if (shifted.outcome === 'converted') {
    assert.equal(shifted.value.curveVersionId, 'rc-corinne-2026');
    assert.equal(shifted.value.shiftVersionId, shiftId);
    assert.equal(shifted.value.stageFt, 2.52);
    assert.equal(shifted.value.effectiveStageFt, 2.58);
    // Q = 41.2 * (2.58 - 1.68)^1.92
    assert.ok(Math.abs(shifted.value.value - 33.6545) < 0.001);
  }

  // a stage below the segment boundary uses the lower segment (+0.03)
  const lower = convertWithShift(store, STREAM, 2.42, '2026-03-08T00:00:00Z', ctx());
  assert.equal(lower.outcome, 'converted');
  if (lower.outcome === 'converted') {
    assert.ok(Math.abs(lower.value.effectiveStageFt - 2.45) < 1e-9);
    assert.ok(Math.abs(lower.value.value - 24.9436) < 0.001);
  }

  // before the shift is effective there is no shift lineage
  const before = convertWithShift(store, STREAM, 2.41, '2026-03-07T12:00:00Z', ctx());
  assert.equal(before.outcome, 'converted');
  if (before.outcome === 'converted') {
    assert.equal(before.value.shiftVersionId, null);
    assert.equal(before.value.curveVersionId, 'rc-corinne-2019');
  }

  // and with shift layering disabled the raw curve value returns
  const unshifted = convertStage(store, STREAM, 2.52, '2026-03-08T20:00:00Z', ctx(), { applyShift: false });
  assert.equal(unshifted.outcome, 'converted');
  if (unshifted.outcome === 'converted') {
    assert.equal(unshifted.value.shiftVersionId, null);
    assert.equal(unshifted.value.effectiveStageFt, 2.52);
    assert.ok(Math.abs(unshifted.value.value - 29.479) < 0.001);
  }
});

test('an effective shift that does not cover the stage is never partially applied', () => {
  const { store } = approvedShift({
    ...DATUM_SHIFT,
    segments: [{ fromStageFt: 3.0, toStageFt: null, offsetFt: -0.05 }],
  });
  const rejected = convertWithShift(store, STREAM, 2.52, '2026-03-08T20:00:00Z', ctx());
  assert.equal(rejected.outcome, 'rejected');
  if (rejected.outcome === 'rejected') {
    assert.equal(rejected.code, 'SHIFT_STAGE_UNCOVERED');
    assert.equal(store.computedValues.length, 0); // nothing recorded
  }
  // ...but disabling the shift layer converts without it
  const fallback = convertStage(store, STREAM, 2.52, '2026-03-08T20:00:00Z', ctx(), { applyShift: false });
  assert.equal(fallback.outcome, 'converted');
});

test('segment tables validate: spans, ordering, open tail placement, finite offsets', () => {
  const store = createRatingCurveStore();
  const inverted = createShiftVersion(store, FATIMA, STREAM, {
    ...DATUM_SHIFT,
    segments: [{ fromStageFt: 2.45, toStageFt: 2.0, offsetFt: 0.1 }],
  }, ctx());
  assert.equal(inverted.outcome, 'rejected');
  if (inverted.outcome === 'rejected') {
    assert.ok(inverted.fieldErrors.some((error) => error.code === 'SPAN_NOT_POSITIVE'));
  }

  const overlapping = createShiftVersion(store, FATIMA, STREAM, {
    ...DATUM_SHIFT,
    segments: [
      { fromStageFt: 0, toStageFt: 2.5, offsetFt: 0.03 },
      { fromStageFt: 2.45, toStageFt: null, offsetFt: 0.06 },
    ],
  }, ctx());
  assert.equal(overlapping.outcome === 'rejected' && overlapping.fieldErrors.some((error) => error.code === 'SEGMENTS_OVERLAP'), true);

  const openTailEarly = createShiftVersion(store, FATIMA, STREAM, {
    ...DATUM_SHIFT,
    segments: [
      { fromStageFt: 0, toStageFt: null, offsetFt: 0.03 },
      { fromStageFt: 3.0, toStageFt: null, offsetFt: 0.06 },
    ],
  }, ctx());
  assert.equal(openTailEarly.outcome === 'rejected' && openTailEarly.fieldErrors.some((error) => error.code === 'OPEN_TAIL_NOT_LAST'), true);

  const empty = createShiftVersion(store, FATIMA, STREAM, { ...DATUM_SHIFT, segments: [] }, ctx());
  assert.equal(empty.outcome === 'rejected' && empty.fieldErrors.some((error) => error.code === 'SEGMENTS_REQUIRED'), true);

  const noReason = createShiftVersion(store, FATIMA, STREAM, { ...DATUM_SHIFT, reason: '  ' }, ctx());
  assert.equal(noReason.outcome === 'rejected' && noReason.fieldErrors.some((error) => error.code === 'REASON_REQUIRED'), true);
});

test('shift periods are overlap-guarded and superseded without deletion', () => {
  const store = createRatingCurveStore();
  const first = createShiftVersion(store, FATIMA, STREAM, DATUM_SHIFT, ctx());
  assert.equal(first.outcome, 'applied');

  const overlapping = createShiftVersion(store, FATIMA, STREAM, {
    ...DATUM_SHIFT,
    effectiveFrom: '2026-03-20T00:00:00Z', // inside the open shift's period
  }, ctx());
  assert.equal(overlapping.outcome, 'rejected');
  if (overlapping.outcome === 'rejected') assert.equal(overlapping.code, 'PERIOD_OVERLAP');

  const approved = first.outcome === 'applied' ? approveShiftVersion(store, DIEGO, first.version.id, ctx()) : null;
  assert.equal(approved?.outcome, 'applied');

  const superseded = supersedeShiftVersion(store, FATIMA, STREAM, {
    ...DATUM_SHIFT,
    effectiveFrom: '2026-04-01T00:00:00Z',
    segments: [{ fromStageFt: 0, toStageFt: null, offsetFt: 0.02 }],
    supersedeReason: 'May re-survey refined the datum correction to +0.02 ft.',
  }, ctx());
  assert.equal(superseded.outcome, 'applied');
  if (superseded.outcome !== 'applied') return;

  const versions = store.shiftVersionsOf(STREAM);
  assert.equal(versions.length, 2);
  const [v1, v2] = versions;
  assert.equal(v1.approvalState, 'superseded');
  assert.equal(v1.effectiveTo, '2026-04-01T00:00:00Z');
  assert.notEqual(v1.approvedAt, null); // approval evidence retained
  assert.equal(v2.approvalState, 'draft');

  // conversions inside the closed shift period still use it (lineage)
  const historical = convertWithShift(store, STREAM, 2.52, '2026-03-08T20:00:00Z', ctx());
  assert.equal(historical.outcome, 'converted');
  if (historical.outcome === 'converted') assert.equal(historical.value.shiftVersionId, v1.id);
  // the successor window is pending approval: the curve still resolves and
  // no shift applies there yet (the superseded shift's interval is closed)
  const pending = convertWithShift(store, STREAM, 2.52, '2026-04-02T00:00:00Z', ctx());
  assert.equal(pending.outcome, 'converted');
  if (pending.outcome === 'converted') {
    assert.equal(pending.value.shiftVersionId, null);
  }
});

test('a superseded-but-never-approved shift never converts (no approval evidence)', () => {
  const store = createRatingCurveStore();
  const first = createShiftVersion(store, FATIMA, STREAM, DATUM_SHIFT, ctx());
  assert.equal(first.outcome, 'applied');
  // supersede the DRAFT without ever approving it
  const second = supersedeShiftVersion(store, FATIMA, STREAM, {
    ...DATUM_SHIFT,
    effectiveFrom: '2026-03-10T00:00:00Z',
    supersedeReason: 'Author replaced their own pending draft.',
  }, ctx());
  assert.equal(second.outcome, 'applied');
  const approvedSecond = second.outcome === 'applied' ? approveShiftVersion(store, CODY, second.version.id, ctx()) : null;
  assert.equal(approvedSecond?.outcome, 'applied');

  // inside the closed draft's period no shift applies: it was never approved
  const underDraft = convertWithShift(store, STREAM, 2.52, '2026-03-09T00:00:00Z', ctx());
  assert.equal(underDraft.outcome, 'converted');
  if (underDraft.outcome === 'converted') assert.equal(underDraft.value.shiftVersionId, null);
  // after 2026-03-10 the approved successor applies
  const after = convertWithShift(store, STREAM, 2.52, '2026-03-11T00:00:00Z', ctx());
  assert.equal(after.outcome, 'converted');
  if (after.outcome === 'converted' && second.outcome === 'applied') {
    assert.equal(after.value.shiftVersionId, second.version.id);
  }
});
