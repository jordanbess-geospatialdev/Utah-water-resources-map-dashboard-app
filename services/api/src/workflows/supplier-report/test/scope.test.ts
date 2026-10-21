/**
 * Scope and organization-isolation tests (WD-017; FR-053; T-06):
 * supplier reporting is organization-scoped through the shared entitlement
 * engine (action 'supplier-reporting' on the owner-anchored system object).
 *
 * - Wiley (synthetic water user of org-cache-water) works on Bear River;
 *   requesting Weber River is DENIED with the hidden-object policy (404,
 *   DENY_OUT_OF_SCOPE - the other supplier's system does not exist for him);
 * - Morgan (org-bear-river-users) works on Weber River and is denied Bear
 *   River identically: isolation holds in BOTH directions;
 * - the fixture principals hold no supplier-reporting grant anywhere:
 *   the data steward is 403 (statewide-administration does NOT satisfy
 *   supplier-reporting - the Water Use side is a separate owner), and the
 *   commissioner/engineer/researcher are 403 as well;
 * - anonymous callers are 401;
 * - the reviewer (role family 'owner') passes the supplier gate and the
 *   reviewer gate; a supplier does NOT pass the reviewer gate
 *   (approvals are a distinct transition);
 * - a revoked organization grant denies on the next request.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withEntitlement } from '../../../../../../packages/policy/src/index.ts';
import { checkReviewerScope, checkSupplierScope } from '../scope.ts';
import { standardSupplierWorld, supplierWorld } from '../world.ts';
import { BEAR, NOW, WEBER } from './helpers.ts';

const WILEY = 'principal-wiley-water-user';
const MORGAN = 'principal-morgan-water-user';
const REVIEWER_CACHE = 'principal-wum-reviewer-cache';
const DIEGO = 'principal-diego-steward';
const CODY = 'principal-cody-commissioner';
const FATIMA = 'principal-fatima-engineer';
const SARAH = 'principal-sarah-researcher';

const WORLD = standardSupplierWorld();

test('the fixture world anchors exactly two supplier organizations on different systems', () => {
  const anchors = supplierWorld().anchors;
  assert.deepEqual(
    anchors.map((anchor) => `${anchor.orgId}->${anchor.systemId}`),
    ['org-bear-river-users->sys-weber-river', 'org-cache-water->sys-bear-river'],
  );
  // The gate sees owner-anchored system objects.
  assert.equal(WORLD.objects[BEAR]!.ownerOrganizationId, 'org-cache-water');
  assert.equal(WORLD.objects[WEBER]!.ownerOrganizationId, 'org-bear-river-users');
});

test('Wiley (org-cache-water) is allowed supplier reporting on Bear River', () => {
  const result = checkSupplierScope(WORLD, WILEY, BEAR, NOW);
  assert.equal(result.outcome, 'allowed');
  if (result.outcome === 'allowed') {
    assert.equal(result.value.orgId, 'org-cache-water');
    assert.equal(result.value.actorKind, 'supplier');
  }
});

test('Wiley requesting Weber River is denied 404 (hidden object, cross-supplier isolation)', () => {
  const result = checkSupplierScope(WORLD, WILEY, WEBER, NOW);
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.equal(result.status, 404);
    assert.equal(result.code, 'NOT_FOUND');
    assert.equal(result.policyReason, 'DENY_OUT_OF_SCOPE');
  }
});

test('Morgan (org-bear-river-users) is allowed on Weber River and denied Bear River: isolation both directions', () => {
  const allowed = checkSupplierScope(WORLD, MORGAN, WEBER, NOW);
  assert.equal(allowed.outcome, 'allowed');
  if (allowed.outcome === 'allowed') assert.equal(allowed.value.orgId, 'org-bear-river-users');

  const denied = checkSupplierScope(WORLD, MORGAN, BEAR, NOW);
  assert.equal(denied.outcome, 'denied');
  if (denied.outcome === 'denied') {
    assert.equal(denied.status, 404);
    assert.equal(denied.policyReason, 'DENY_OUT_OF_SCOPE');
  }
});

test('no fixture principal holds supplier reporting: steward, commissioner, engineer, researcher are all 403', () => {
  for (const actor of [DIEGO, CODY, FATIMA, SARAH]) {
    const result = checkSupplierScope(WORLD, actor, BEAR, NOW);
    assert.equal(result.outcome, 'denied', actor);
    if (result.outcome === 'denied') {
      assert.equal(result.status, 403, actor);
      assert.equal(result.policyReason, 'DENY_CAPABILITY_NOT_GRANTED', actor);
    }
  }
});

test('statewide-administration does not satisfy supplier-reporting (separate Water Use owner)', () => {
  const result = checkSupplierScope(WORLD, DIEGO, BEAR, NOW);
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') assert.equal(result.policyReason, 'DENY_CAPABILITY_NOT_GRANTED');
});

test('anonymous callers are denied 401', () => {
  const result = checkSupplierScope(WORLD, null, BEAR, NOW);
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.equal(result.status, 401);
    assert.equal(result.policyReason, 'DENY_ANONYMOUS');
  }
});

test('an unknown system id is 404 for an assigned supplier too', () => {
  const result = checkSupplierScope(WORLD, WILEY, 'sys-does-not-exist', NOW);
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') assert.equal(result.policyReason, 'DENY_UNKNOWN_OBJECT');
});

test('the reviewer passes both gates; a supplier cannot pass the reviewer gate', () => {
  const reviewer = checkReviewerScope(WORLD, REVIEWER_CACHE, BEAR, NOW);
  assert.equal(reviewer.outcome, 'allowed');
  if (reviewer.outcome === 'allowed') assert.equal(reviewer.value.actorKind, 'reviewer');

  const supplier = checkReviewerScope(WORLD, WILEY, BEAR, NOW);
  assert.equal(supplier.outcome, 'denied');
  if (supplier.outcome === 'denied') {
    assert.equal(supplier.status, 403);
    assert.equal(supplier.code, 'REVIEWER_REQUIRED');
  }
});

test('a reviewer of the other organization is hidden (404) on Bear River', () => {
  const result = checkReviewerScope(WORLD, 'principal-wum-reviewer-bear', BEAR, NOW);
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') assert.equal(result.status, 404);
});

test('a revoked organization grant denies on the next request (FR-011 revocation)', () => {
  const revoked = withEntitlement(WORLD, 'ent-principal-wiley-water-user', { status: 'revoked' });
  const result = checkSupplierScope(revoked, WILEY, BEAR, NOW);
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.equal(result.status, 403);
    assert.equal(result.policyReason, 'DENY_ASSIGNMENT_REVOKED');
  }
});
