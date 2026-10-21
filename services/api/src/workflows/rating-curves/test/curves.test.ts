/**
 * Curve version-chain suite (WD-011-R2; FR-045; acceptance T-06):
 * - lifecycle: create (draft) -> approve -> supersede appends forward and
 *   closes the prior interval WITHOUT deleting it; ordinals never collapse;
 * - overlap rejection: a second version covering any instant already
 *   covered is a 409 PERIOD_OVERLAP naming the conflict; boundary touching
 *   (the seeded 2019/2026 join) stays legal;
 * - at-instant resolution incl. boundary instants: half-open semantics at
 *   the seeded join 2026-03-07T18:00:00Z and at the supersession boundary;
 * - approval gating: the authoring engineer cannot approve (no review-data
 *   grant), the owner-side commissioner and the statewide steward can, the
 *   deputy only inside her delegation window; out-of-scope engineer and
 *   anonymous are rejected;
 * - lineage preservation: conversions recorded before a supersession keep
 *   their curveVersionId afterwards, while the same instant now resolves to
 *   the successor once it is approved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRatingCurveStore } from '../store.ts';
import {
  approveCurveVersion,
  convertStage,
  createCurveVersion,
  supersedeCurveVersion,
} from '../curves.ts';
import type { CurveVersionInput, RatingCurveVersion, WorkflowContext } from '../types.ts';

const FATIMA = 'principal-fatima-engineer'; // Bear River field engineer (author)
const PRIYA = 'principal-priya-engineer'; // Weber River engineer (out of scope)
const CODY = 'principal-cody-commissioner'; // Bear River data-owner side (approver)
const DIEGO = 'principal-diego-steward'; // statewide steward (approver)
const ANA = 'principal-ana-deputy'; // deputy commissioner (approver inside window)
const SARAH = 'principal-sarah-researcher'; // no edit capability
const NOW = '2026-03-09T07:00:00Z'; // the fixture fixed clock
const AFTER_DELEGATION = '2026-07-01T00:00:00Z'; // after ent-deputy-ana expires

const STREAM = 'str-corinne-q';
const JOIN = '2026-03-07T18:00:00Z'; // seeded 2019/2026 boundary

const ctx = (now: string = NOW): WorkflowContext => ({ now });

const NEXT_CURVE: CurveVersionInput = {
  coefficients: { c: 42.5, b: 1.95, e: 1.66 },
  unitPair: { fromUnitId: 'ft', toUnitId: 'cfs' },
  method: 'Log-linear least squares, n=24 calibrations, post-2026 verification',
  effectiveFrom: '2026-04-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// Seeded chain (the fixture's two rating-curve periods)
// ---------------------------------------------------------------------------

test('the fixture seeds two published curve periods with retained provenance', () => {
  const store = createRatingCurveStore();
  const versions = store.curveVersionsOf(STREAM);
  assert.equal(versions.length, 2);
  const [v2019, v2026] = versions as [RatingCurveVersion, RatingCurveVersion];
  assert.equal(v2019.id, 'rc-corinne-2019');
  assert.equal(v2019.effectiveFrom, '2019-10-01T00:00:00Z');
  assert.equal(v2019.effectiveTo, JOIN);
  assert.equal(v2019.approvalState, 'superseded'); // closed by its successor
  assert.notEqual(v2019.approvedAt, null); // approval evidence survives supersession
  assert.equal(v2019.author, 'principal-diego-steward');
  assert.match(v2019.provenance.source, /stations\.json#ratingCurvePeriods/);
  assert.equal(v2019.version, 1);
  assert.equal(v2026.id, 'rc-corinne-2026');
  assert.equal(v2026.effectiveFrom, JOIN);
  assert.equal(v2026.effectiveTo, null);
  assert.equal(v2026.approvalState, 'approved');
  assert.equal(v2026.version, 2);
  // streams without curves seed an empty chain, not a gap in the store
  assert.deepEqual(store.curveVersionsOf('str-corinne-stage'), []);
});

test('at-instant resolution honours the half-open boundary at the seeded join', () => {
  const store = createRatingCurveStore();
  // one millisecond before the join: 2019 curve (its interval EXCLUDES the join instant)
  const before = convertStage(store, STREAM, 2.5, '2026-03-07T17:59:59.999Z', ctx());
  assert.equal(before.outcome, 'converted');
  if (before.outcome === 'converted') {
    assert.equal(before.value.curveVersionId, 'rc-corinne-2019');
  }
  // exactly at the join: 2026 curve (its interval INCLUDES the join instant)
  const at = convertStage(store, STREAM, 2.5, JOIN, ctx());
  assert.equal(at.outcome, 'converted');
  if (at.outcome === 'converted') {
    assert.equal(at.value.curveVersionId, 'rc-corinne-2026');
  }
  // before any curve: no version covers 2018
  const early = convertStage(store, STREAM, 2.5, '2018-01-01T00:00:00Z', ctx());
  assert.equal(early.outcome, 'rejected');
  if (early.outcome === 'rejected') assert.equal(early.code, 'NO_CURVE_AT_INSTANT');
  // unknown stream
  const missing = convertStage(store, 'str-does-not-exist', 2.5, NOW, ctx());
  assert.equal(missing.outcome, 'rejected');
  if (missing.outcome === 'rejected') assert.equal(missing.code, 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Lifecycle: create -> approve -> supersede (append-only)
// ---------------------------------------------------------------------------

test('a created version lands as a draft with author and provenance, then approves', () => {
  const store = createRatingCurveStore();
  const created = createCurveVersion(store, FATIMA, 'str-corinne-stage', {
    ...NEXT_CURVE,
    effectiveFrom: '2025-01-01T00:00:00Z',
  }, ctx());
  assert.equal(created.outcome, 'applied');
  if (created.outcome !== 'applied') return;
  assert.equal(created.status, 201);
  assert.equal(created.version.approvalState, 'draft');
  assert.equal(created.version.author, FATIMA);
  assert.equal(created.version.approvedBy, null);
  assert.equal(created.version.effectiveTo, null);
  assert.equal(created.version.version, 1);

  // the author cannot approve: no review-data grant in the fixture world
  const selfApproval = approveCurveVersion(store, FATIMA, created.version.id, ctx());
  assert.equal(selfApproval.outcome, 'rejected');
  if (selfApproval.outcome === 'rejected') {
    assert.equal(selfApproval.status, 403);
    assert.equal(selfApproval.code, 'FORBIDDEN');
    assert.equal(selfApproval.policyReason, 'DENY_CAPABILITY_NOT_GRANTED');
  }

  // drafts never convert
  const draftConversion = convertStage(store, 'str-corinne-stage', 2.5, NOW, ctx());
  assert.equal(draftConversion.outcome, 'rejected');
  if (draftConversion.outcome === 'rejected') {
    assert.equal(draftConversion.code, 'NO_APPROVED_CURVE_AT_INSTANT');
    assert.deepEqual(draftConversion.pendingVersionIds, [created.version.id]);
  }

  const approved = approveCurveVersion(store, CODY, created.version.id, ctx());
  assert.equal(approved.outcome, 'applied');
  if (approved.outcome !== 'applied') return;
  assert.equal(approved.version.approvalState, 'approved');
  assert.equal(approved.version.approvedBy, CODY);
  assert.equal(approved.version.approvedAt, NOW);

  // approving twice is an invalid transition, never a silent no-op
  const again = approveCurveVersion(store, CODY, created.version.id, ctx());
  assert.equal(again.outcome, 'rejected');
  if (again.outcome === 'rejected') {
    assert.equal(again.status, 409);
    assert.equal(again.code, 'INVALID_TRANSITION');
  }

  const converted = convertStage(store, 'str-corinne-stage', 2.5, NOW, ctx());
  assert.equal(converted.outcome, 'converted');
  if (converted.outcome === 'converted') {
    assert.equal(converted.value.curveVersionId, created.version.id);
  }
});

test('superseding closes the prior interval without deleting it and versions the chain forward', () => {
  const store = createRatingCurveStore();
  const superseded = supersedeCurveVersion(store, FATIMA, STREAM, {
    ...NEXT_CURVE,
    supersedeReason: 'April 2026 verification found a datum drift; coefficients refit.',
  }, ctx());
  assert.equal(superseded.outcome, 'applied');
  if (superseded.outcome !== 'applied') return;
  const successor = superseded.version;

  const versions = store.curveVersionsOf(STREAM);
  assert.equal(versions.length, 3);
  const [v2019, v2026, v3] = versions as [RatingCurveVersion, RatingCurveVersion, RatingCurveVersion];
  // prior version retained, interval closed at the successor's start, state moved
  assert.equal(v2026.id, 'rc-corinne-2026');
  assert.equal(v2026.effectiveTo, successor.effectiveFrom);
  assert.equal(v2026.approvalState, 'superseded');
  assert.equal(v2026.approvedAt, JOIN); // approval evidence retained
  assert.equal(v2026.version, 2); // ordinal kept: history never collapses
  assert.equal(v3.version, 3);
  assert.equal(v3.approvalState, 'draft');
  // the historical 2019 period is untouched by the supersession
  assert.equal(v2019.effectiveTo, JOIN);

  // audit + outbox landed with the transition and the supersession linkage
  const event = superseded.auditEvent;
  assert.equal(event.action, 'supersede-curve');
  assert.equal(event.supersededVersionId, 'rc-corinne-2026');
  assert.equal(event.beforeState, 'approved');
  assert.equal(event.afterState, 'draft');
  assert.equal(event.correlationId, superseded.outboxEvent.correlationId);

  // the successor window is not convertible until approved
  const pending = convertStage(store, STREAM, 2.5, '2026-04-02T00:00:00Z', ctx());
  assert.equal(pending.outcome, 'rejected');
  if (pending.outcome === 'rejected') assert.equal(pending.code, 'NO_APPROVED_CURVE_AT_INSTANT');

  const approved = approveCurveVersion(store, DIEGO, successor.id, ctx());
  assert.equal(approved.outcome, 'applied');

  // after approval the new instant resolves to the successor
  const after = convertStage(store, STREAM, 2.5, '2026-04-02T00:00:00Z', ctx());
  assert.equal(after.outcome, 'converted');
  if (after.outcome === 'converted') assert.equal(after.value.curveVersionId, successor.id);

  // and instants inside the prior period still resolve to the prior version
  const historical = convertStage(store, STREAM, 2.5, '2026-03-08T00:00:00Z', ctx());
  assert.equal(historical.outcome, 'converted');
  if (historical.outcome === 'converted') assert.equal(historical.value.curveVersionId, 'rc-corinne-2026');
});

test('lineage preservation: conversions recorded before a supersession keep their version id', () => {
  const store = createRatingCurveStore();
  const before = convertStage(store, STREAM, 2.58, '2026-03-09T06:00:00Z', ctx());
  assert.equal(before.outcome, 'converted');
  const recorded = before.outcome === 'converted' ? before.value : null;
  assert.ok(recorded);

  const superseded = supersedeCurveVersion(store, FATIMA, STREAM, {
    ...NEXT_CURVE,
    effectiveFrom: '2026-03-09T06:00:00Z', // retroactive to the conversion instant
    supersedeReason: 'Refit after the March 9 meter verification.',
  }, ctx());
  assert.equal(superseded.outcome, 'applied');
  const approved = superseded.outcome === 'applied'
    ? approveCurveVersion(store, CODY, superseded.version.id, ctx())
    : null;
  assert.equal(approved?.outcome, 'applied');

  // the ledger entry was NOT rewritten: it still names the version used at
  // the time of the conversion (FR-045 "a revised curve does not erase
  // earlier conversions")
  const ledgerBefore = store.computedValues.find((entry) => entry.computedAt === NOW && entry.stageFt === 2.58);
  assert.ok(ledgerBefore);
  assert.equal(ledgerBefore.curveVersionId, 'rc-corinne-2026');
  assert.equal(ledgerBefore.value, recorded.value);

  // the same instant now resolves under the approved successor
  const after = convertStage(store, STREAM, 2.58, '2026-03-09T06:00:00Z', ctx('2026-03-10T00:00:00Z'));
  assert.equal(after.outcome, 'converted');
  if (after.outcome === 'converted') {
    assert.equal(after.value.curveVersionId, superseded.outcome === 'applied' ? superseded.version.id : '');
    assert.notEqual(after.value.value, recorded.value);
  }

  // both entries coexist in the ledger
  const ids = store.computedValues.map((entry) => entry.curveVersionId);
  assert.ok(ids.includes('rc-corinne-2026'));
  assert.ok(ids.includes(superseded.outcome === 'applied' ? superseded.version.id : ''));
});

// ---------------------------------------------------------------------------
// Overlap rejection
// ---------------------------------------------------------------------------

test('an overlapping period is rejected with PERIOD_OVERLAP naming the conflict', () => {
  const store = createRatingCurveStore();
  // an existing bounded version on a fresh chain...
  const existing = createCurveVersion(store, FATIMA, 'str-corinne-stage', {
    ...NEXT_CURVE,
    effectiveFrom: '2025-01-01T00:00:00Z',
    effectiveTo: '2025-06-01T00:00:00Z',
  }, ctx());
  assert.equal(existing.outcome, 'applied');
  // ...rejects any period sharing an instant with it
  const overlap = createCurveVersion(store, FATIMA, 'str-corinne-stage', {
    ...NEXT_CURVE,
    effectiveFrom: '2025-03-01T00:00:00Z',
    effectiveTo: '2026-01-01T00:00:00Z',
  }, ctx());
  assert.equal(overlap.outcome, 'rejected');
  if (overlap.outcome === 'rejected') {
    assert.equal(overlap.status, 409);
    assert.equal(overlap.code, 'PERIOD_OVERLAP');
    if (existing.outcome === 'applied') assert.ok(overlap.message.includes(existing.version.id));
  }

  // superseding with a start before the open version's own start is 422
  const touchesOpen = supersedeCurveVersion(store, FATIMA, STREAM, {
    ...NEXT_CURVE,
    effectiveFrom: '2026-03-07T00:00:00Z', // before the open version's own start (JOIN is 18:00)
    supersedeReason: 'Backdated refit attempt.',
  }, ctx());
  assert.equal(touchesOpen.outcome, 'rejected');
  if (touchesOpen.outcome === 'rejected') {
    assert.equal(touchesOpen.status, 422);
    assert.ok(touchesOpen.fieldErrors.some((error) => error.code === 'EFFECTIVE_DATE_NOT_FORWARD'));
  }

  // boundary touching is legal: a version joining exactly at the prior end
  const joining = createCurveVersion(store, FATIMA, 'str-corinne-stage', {
    ...NEXT_CURVE,
    effectiveFrom: '2025-06-01T00:00:00Z', // exactly the prior end: touch, not overlap
    effectiveTo: null,
  }, ctx());
  assert.equal(joining.outcome, 'applied');

  // at the join instant nothing converts while both versions are drafts
  const atJoin = convertStage(store, 'str-corinne-stage', 2.5, '2025-06-01T00:00:00Z', ctx());
  assert.equal(atJoin.outcome, 'rejected'); // drafts never convert
  const firstApproved = existing.outcome === 'applied' ? approveCurveVersion(store, CODY, existing.version.id, ctx()) : null;
  const secondApproved = joining.outcome === 'applied' ? approveCurveVersion(store, CODY, joining.version.id, ctx()) : null;
  assert.equal(firstApproved?.outcome, 'applied');
  assert.equal(secondApproved?.outcome, 'applied');
  const resolved = convertStage(store, 'str-corinne-stage', 2.5, '2025-06-01T00:00:00Z', ctx());
  assert.equal(resolved.outcome, 'converted');
  if (resolved.outcome === 'converted') {
    assert.equal(resolved.value.curveVersionId, joining.outcome === 'applied' ? joining.version.id : '');
  }
});

test('draft versions participate in the overlap guard: ambiguous periods are rejected', () => {
  const store = createRatingCurveStore();
  const first = createCurveVersion(store, FATIMA, 'str-corinne-stage', {
    ...NEXT_CURVE,
    effectiveFrom: '2025-01-01T00:00:00Z',
    effectiveTo: null,
  }, ctx());
  assert.equal(first.outcome, 'applied');
  const overlappingDraft = createCurveVersion(store, FATIMA, 'str-corinne-stage', {
    ...NEXT_CURVE,
    effectiveFrom: '2025-02-01T00:00:00Z',
    effectiveTo: null,
  }, ctx());
  assert.equal(overlappingDraft.outcome, 'rejected');
  if (overlappingDraft.outcome === 'rejected') {
    assert.equal(overlappingDraft.code, 'PERIOD_OVERLAP');
    if (first.outcome === 'applied') {
      assert.ok(overlappingDraft.message.includes(first.version.id));
    }
  }
});

// ---------------------------------------------------------------------------
// Validation and stage-domain guards
// ---------------------------------------------------------------------------

test('field validation rejects ungoverned unit pairs, non-positive coefficients and bad intervals', () => {
  const store = createRatingCurveStore();
  const badUnit = createCurveVersion(store, FATIMA, 'str-corinne-stage', {
    ...NEXT_CURVE,
    unitPair: { fromUnitId: 'm', toUnitId: 'cms' },
    effectiveFrom: '2025-01-01T00:00:00Z',
  }, ctx());
  assert.equal(badUnit.outcome, 'rejected');
  if (badUnit.outcome === 'rejected') {
    assert.equal(badUnit.status, 422);
    assert.ok(badUnit.fieldErrors.some((error) => error.code === 'UNIT_PAIR_UNGOVERNED'));
  }

  const badCoefficients = createCurveVersion(store, FATIMA, 'str-corinne-stage', {
    ...NEXT_CURVE,
    coefficients: { c: -3, b: 0, e: -1 },
    effectiveFrom: '2025-01-01T00:00:00Z',
  }, ctx());
  assert.equal(badCoefficients.outcome, 'rejected');
  if (badCoefficients.outcome === 'rejected') {
    assert.equal(badCoefficients.fieldErrors.length, 3);
  }

  const inverted = createCurveVersion(store, FATIMA, 'str-corinne-stage', {
    ...NEXT_CURVE,
    effectiveFrom: '2025-06-01T00:00:00Z',
    effectiveTo: '2025-01-01T00:00:00Z',
  }, ctx());
  assert.equal(inverted.outcome, 'rejected');
  if (inverted.outcome === 'rejected') {
    assert.ok(inverted.fieldErrors.some((error) => error.code === 'EFFECTIVE_DATE_ORDER'));
  }

  const unknownStream = createCurveVersion(store, FATIMA, 'str-does-not-exist', NEXT_CURVE, ctx());
  assert.equal(unknownStream.outcome, 'rejected');
  if (unknownStream.outcome === 'rejected') assert.equal(unknownStream.status, 404);

  // conversion guards
  const belowDatum = convertStage(store, STREAM, 1.0, NOW, ctx()); // datum is 1.68 ft
  assert.equal(belowDatum.outcome, 'rejected');
  if (belowDatum.outcome === 'rejected') assert.equal(belowDatum.code, 'STAGE_BELOW_DATUM');
  const notFinite = convertStage(store, STREAM, Number.NaN, NOW, ctx());
  assert.equal(notFinite.outcome, 'rejected');
  if (notFinite.outcome === 'rejected') assert.equal(notFinite.code, 'STAGE_NOT_FINITE');
  const badInstant = convertStage(store, STREAM, 2.5, 'not-an-instant', ctx());
  assert.equal(badInstant.outcome === 'rejected' && badInstant.code, 'AT_INSTANT_INVALID');
});

// ---------------------------------------------------------------------------
// Approval gating (the steward-or-owner transition via the policy engine)
// ---------------------------------------------------------------------------

test('approval is steward-or-owner gated; authors, outsiders and anonymous are rejected', () => {
  const store = createRatingCurveStore();
  const created = createCurveVersion(store, FATIMA, 'str-corinne-stage', {
    ...NEXT_CURVE,
    effectiveFrom: '2025-01-01T00:00:00Z',
  }, ctx());
  assert.equal(created.outcome, 'applied');
  const versionId = created.outcome === 'applied' ? created.version.id : '';

  // anonymous / unknown principal -> 401 (an unknown id resolves to no
  // principal, which the engine denies as anonymous)
  const anonymous = approveCurveVersion(store, 'principal-nobody', versionId, ctx());
  assert.equal(anonymous.outcome, 'rejected');
  if (anonymous.outcome === 'rejected') {
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.policyReason, 'DENY_ANONYMOUS');
  }

  // the authoring engineer holds no review-data grant -> 403
  const author = approveCurveVersion(store, FATIMA, versionId, ctx());
  assert.equal(author.outcome, 'rejected');
  if (author.outcome === 'rejected') assert.equal(author.status, 403);

  // a researcher holds no edit or review capability at all -> 403
  const researcher = approveCurveVersion(store, SARAH, versionId, ctx());
  assert.equal(researcher.outcome, 'rejected');
  if (researcher.outcome === 'rejected') assert.equal(researcher.status, 403);

  // the deputy approves inside her delegation window
  const deputy = approveCurveVersion(store, ANA, versionId, ctx());
  assert.equal(deputy.outcome, 'applied');

  const store2 = createRatingCurveStore();
  const created2 = createCurveVersion(store2, FATIMA, 'str-corinne-stage', {
    ...NEXT_CURVE,
    effectiveFrom: '2025-01-01T00:00:00Z',
  }, ctx());
  const versionId2 = created2.outcome === 'applied' ? created2.version.id : '';
  // the same deputy outside the window is denied (the window decides, not the role label)
  const expiredDeputy = approveCurveVersion(store2, ANA, versionId2, ctx(AFTER_DELEGATION));
  assert.equal(expiredDeputy.outcome, 'rejected');
  if (expiredDeputy.outcome === 'rejected') {
    assert.equal(expiredDeputy.status, 403);
    assert.equal(expiredDeputy.policyReason, 'DENY_DELEGATION_EXPIRED');
  }
  // ...while the statewide steward can approve at any time
  const steward = approveCurveVersion(store2, DIEGO, versionId2, ctx(AFTER_DELEGATION));
  assert.equal(steward.outcome, 'applied');
});

test('authoring is scoped: the out-of-system engineer and non-editors are rejected', () => {
  const store = createRatingCurveStore();
  // Priya (Weber River engineer) on a Bear River station: out of scope on a
  // PUBLIC station is a plain 403 (the station exists for her, she just has
  // no authority there)
  const outsider = createCurveVersion(store, PRIYA, STREAM, {
    ...NEXT_CURVE,
    effectiveFrom: '2025-01-01T00:00:00Z',
  }, ctx());
  assert.equal(outsider.outcome, 'rejected');
  if (outsider.outcome === 'rejected') {
    assert.equal(outsider.status, 403);
    assert.equal(outsider.policyReason, 'DENY_OUT_OF_SCOPE');
  }
  const researcher = createCurveVersion(store, SARAH, STREAM, {
    ...NEXT_CURVE,
    effectiveFrom: '2025-01-01T00:00:00Z',
  }, ctx());
  assert.equal(researcher.outcome, 'rejected');
  if (researcher.outcome === 'rejected') {
    assert.equal(researcher.status, 403);
    assert.equal(researcher.policyReason, 'DENY_CAPABILITY_NOT_GRANTED');
  }
  const anonymous = createCurveVersion(store, 'principal-ghost', STREAM, {
    ...NEXT_CURVE,
    effectiveFrom: '2025-01-01T00:00:00Z',
  }, ctx());
  assert.equal(anonymous.outcome, 'rejected');
  if (anonymous.outcome === 'rejected') assert.equal(anonymous.status, 401);
});
