import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withEntitlement } from '../../../../../../packages/policy/src/index.ts';
import { createRatingCurveStore, type RatingCurveStore } from '../store.ts';
import { approveCurveVersion, createCurveVersion } from '../curves.ts';
import { approveShiftVersion, createShiftVersion } from '../shifts.ts';

const NOW = '2026-03-09T07:00:00Z';
const FATIMA = 'principal-fatima-engineer';
const CODY = 'principal-cody-commissioner';
const DIEGO = 'principal-diego-steward';
const ctx = { now: NOW };

const workflows = [
  {
    name: 'rating curve',
    create: (store: RatingCurveStore) => createCurveVersion(store, FATIMA, 'str-corinne-stage', {
      coefficients: { c: 42.5, b: 1.95, e: 1.66 }, unitPair: { fromUnitId: 'ft', toUnitId: 'cfs' },
      method: 'Approval boundary fixture', effectiveFrom: '2025-01-01T00:00:00Z',
    }, ctx),
    approve: approveCurveVersion,
  },
  {
    name: 'shift',
    create: (store: RatingCurveStore) => createShiftVersion(store, FATIMA, 'str-corinne-q', {
      segments: [{ fromStageFt: 0, toStageFt: null, offsetFt: 0.03 }],
      reason: 'Approval boundary fixture', effectiveFrom: '2025-01-01T00:00:00Z',
    }, ctx),
    approve: approveShiftVersion,
  },
];

for (const workflow of workflows) {
  test(`${workflow.name}: QC review and broad administration do not approve; explicit current scope does`, () => {
    const base = createRatingCurveStore();
    const steward = base.world.assignments.find((assignment) => assignment.id === 'ent-steward-diego')!;
    const store = { ...base, world: withEntitlement(base.world, steward.id, {
      capabilities: steward.capabilities.filter((capability) => capability !== 'approve-rating-curves'),
    }) };
    const draft = workflow.create(store);
    assert.equal(draft.outcome, 'applied');
    if (draft.outcome !== 'applied') return;
    for (const actor of [CODY, DIEGO]) {
      const denied = workflow.approve(store, actor, draft.version.id, ctx);
      assert.equal(denied.outcome, 'rejected', actor);
      if (denied.outcome === 'rejected') assert.equal(denied.policyReason, 'DENY_CAPABILITY_NOT_GRANTED');
    }
    const cody = store.world.assignments.find((assignment) => assignment.id === 'ent-commissioner-cody')!;
    const grant = withEntitlement(store.world, cody.id, { capabilities: [...cody.capabilities, 'approve-rating-curves'] });
    for (const [world, reason] of [
      [withEntitlement(grant, cody.id, { scopeId: 'sys-weber-river' }), 'DENY_OUT_OF_SCOPE'],
      [withEntitlement(grant, cody.id, { status: 'revoked' }), 'DENY_ASSIGNMENT_REVOKED'],
    ] as const) {
      const denied = workflow.approve({ ...store, world }, CODY, draft.version.id, ctx);
      assert.equal(denied.outcome, 'rejected');
      if (denied.outcome === 'rejected') assert.equal(denied.policyReason, reason);
    }
    const approved = workflow.approve({ ...store, world: grant }, CODY, draft.version.id, ctx);
    assert.equal(approved.outcome, 'applied');
    if (approved.outcome === 'applied') assert.equal(approved.version.approvedBy, CODY);
  });
}
