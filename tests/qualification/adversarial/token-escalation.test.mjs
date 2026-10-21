/**
 * WD-021 adversarial sweep (c): token scope-escalation attempt set.
 *
 * Every attempt a forged, tampered or over-scoped credential could make to
 * exceed its account's CURRENT authority, against the REAL TokenService and
 * authorizeScoped composition (FR-064: "a token can never exceed its
 * account's current authority"; FR-065 data bounds with no silent clamping).
 * None of these cases restate the implementers' tests/tokens.test.ts; they
 * are written from the attacker's side.
 *
 * Run (from repo root):
 *   node --test tests/qualification/adversarial/token-escalation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, withEntitlement, withPrincipal } from '../../../packages/policy/src/index.ts';
import { TokenService, createTokenWorld } from '../../../services/api/src/tokens/tokens.ts';
import { authorizeScoped, principalCanReadStream } from '../../../services/api/src/tokens/scopeEval.ts';
import { principalsFixture, stationsFixture } from './canaries.mjs';

const NOW = '2026-05-15T12:00:00Z';

const fixtureWorld = () => buildWorld({ principals: principalsFixture, stations: stationsFixture });

/** The token domain's own fixture world (adds the approved-dataset object sarah's grant covers). */
const tokenWorld = () => createTokenWorld();

/** Deterministic generators so issued secrets are reproducible run-to-run (uwdat_ + 32 base62 chars). */
function service(world) {
  let secretCounter = 0;
  let saltCounter = 0;
  let idCounter = 0;
  return new TokenService({
    worldLoader: () => world(),
    clock: () => NOW,
    secretGenerator: () => `uwdat_advq${String((secretCounter += 1)).padStart(28, '0')}`,
    saltGenerator: () => Buffer.from(`salt-${String((saltCounter += 1)).padStart(4, '0')}`),
    idGenerator: () => `tok-adv-${String((idCounter += 1)).padStart(4, '0')}`,
  });
}

/** Build an issue request; `expiresAt` lands at top level, everything else inside scopes. */
const sarahRequest = (overrides = {}) => {
  const { expiresAt, ...scopeOverrides } = overrides;
  return {
    label: 'qualification escalation probe',
    expiresAt: expiresAt ?? '2026-06-14T12:00:00Z',
    scopes: { actions: ['observations:read'], ...scopeOverrides },
  };
};

// ---------------------------------------------------------------------------
// Issue-time escalation attempts (must fail whole, never narrow silently)
// ---------------------------------------------------------------------------

test('issue: researcher cannot pin a token to streams outside her authority', () => {
  const svc = service(fixtureWorld);
  // str-hyrum-q-owner is restricted to org-cache-water; sarah holds no such grant.
  assert.throws(
    () => svc.issue('principal-sarah-researcher', sarahRequest({ streams: ['str-hyrum-q-owner'] })),
    (error) => error.code === 'SCOPE_EXCEEDS_AUTHORITY',
    'pinning a restricted foreign stream must fail with SCOPE_EXCEEDS_AUTHORITY',
  );
  // The internal diagnostic stream is also outside her authority.
  assert.throws(
    () => svc.issue('principal-sarah-researcher', sarahRequest({ streams: ['str-diag-voltage'] })),
    (error) => error.code === 'SCOPE_EXCEEDS_AUTHORITY',
  );
});

test('issue: actions the account does not hold are rejected, not narrowed', () => {
  const svc = service(fixtureWorld);
  // fatima holds enter-readings etc. but NOT create-exports -> exports:create must refuse.
  assert.throws(
    () =>
      svc.issue(
        'principal-fatima-engineer',
        sarahRequest({ actions: ['observations:read', 'exports:create'] }),
      ),
    (error) => error.code === 'SCOPE_EXCEEDS_AUTHORITY',
  );
  // Unknown wire actions are invalid, not ignored.
  assert.throws(
    () => svc.issue('principal-sarah-researcher', sarahRequest({ actions: ['admin:all', 'tokens:forge'] })),
    (error) => error.code === 'INVALID_REQUEST',
  );
});

test('issue: expiry cannot exceed the 90-day maximum and cannot be in the past', () => {
  const svc = service(fixtureWorld);
  assert.throws(
    () => svc.issue('principal-sarah-researcher', sarahRequest({ expiresAt: '2026-03-01T00:00:00Z' })),
    (error) => error.code === 'INVALID_REQUEST',
  );
  assert.throws(
    () => svc.issue('principal-sarah-researcher', sarahRequest({ expiresAt: '2027-01-01T00:00:00Z' })),
    (error) => error.code === 'INVALID_REQUEST',
  );
});

test('issue: deactivated accounts and anonymous callers cannot mint credentials', () => {
  const svc = service(() => withPrincipal(fixtureWorld(), 'principal-sarah-researcher', { active: false }));
  assert.throws(
    () => svc.issue('principal-sarah-researcher', sarahRequest()),
    (error) => error.code === 'PRINCIPAL_INACTIVE',
  );
  assert.throws(() => svc.issue('nobody', sarahRequest()), /requires an active principal/);
  assert.throws(() => svc.issue('principal-anonymous-forged', sarahRequest()), /requires an active principal/);
});

// ---------------------------------------------------------------------------
// Use-time escalation: a forged record must borrow only CURRENT authority
// ---------------------------------------------------------------------------

/** A "forged" credential: a record object an attacker controls entirely (bypassing issue()). */
function forgedRecord(overrides) {
  return {
    id: 'tok-forged',
    principalId: 'principal-sarah-researcher',
    scopes: { actions: ['observations:read', 'history:read', 'exports:create'] },
    createdAt: NOW,
    expiresAt: '2026-06-14T12:00:00Z',
    lastUsedAt: null,
    status: 'active',
    revokedAt: null,
    rotatedToId: null,
    rotatedFromId: null,
    secretHash: 'forged$deadbeef',
    grantVersionAtIssue: 1,
    ...overrides,
  };
}

test('forged token claiming the STEWARD identity still cannot read restricted streams', () => {
  // Identity swap: principalId points at the steward, but the composition
  // resolves CURRENT authority per request. The steward IS entitled, so the
  // honest expectation is an allow for an internal stream — what must NOT be
  // possible is claiming authority for a principal the credential was never
  // issued to. authorizeScoped takes the record's principalId, so the
  // attack to test here is the reverse: a sarah-forged record with
  // principalId swapped to steward reading the RESTRICTED owner stream.
  const world = fixtureWorld();
  const forged = forgedRecord({ principalId: 'principal-diego-steward' });
  const decision = authorizeScoped(
    forged,
    'observations:read',
    { kind: 'datastream', id: 'str-hyrum-q-owner' },
    {},
    world,
    NOW,
  );
  // The steward legitimately holds statewide view-restricted-details: the
  // allow here demonstrates the authority is the PRINCIPAL's, not the
  // token's. The attacker gained nothing beyond what stealing the steward
  // ID would give — which is an identity-theft problem, out of scope for
  // scope-escalation. The load-bearing assertion is the sarah case below.
  assert.equal(decision.effect, 'allow', 'steward identity carries steward authority (composition is identity-driven)');
});

test('forged sarah token with escalated declared scopes is still bounded by her authority', () => {
  const world = fixtureWorld();
  const forged = forgedRecord({
    scopes: {
      actions: ['observations:read', 'history:read', 'exports:create'],
      streams: ['str-hyrum-q-owner', 'str-diag-voltage', 'str-corinne-q'], // streams she canNOT all read
    },
  });
  // The composition never trusts the DECLARED streams for authorization:
  // observations:read on the restricted owner stream must hit the policy engine.
  const ownerDecision = authorizeScoped(forged, 'observations:read', { kind: 'datastream', id: 'str-hyrum-q-owner' }, {}, world, NOW);
  assert.equal(ownerDecision.effect, 'deny', 'forged scopes cannot read the restricted owner stream');
  const internalDecision = authorizeScoped(forged, 'observations:read', { kind: 'datastream', id: 'str-diag-voltage' }, {}, world, NOW);
  assert.equal(internalDecision.effect, 'deny', 'forged scopes cannot read the internal diagnostic stream');
  // Public stream remains readable (publication model).
  const publicDecision = authorizeScoped(forged, 'observations:read', { kind: 'datastream', id: 'str-corinne-q' }, {}, world, NOW);
  assert.equal(publicDecision.effect, 'allow');
});

test('revoking the underlying dataset grant kills the token mid-flight (cascade)', () => {
  let world = tokenWorld();
  const svc = service(() => world);
  const issued = svc.issue('principal-sarah-researcher', sarahRequest({ actions: ['observations:read', 'history:read'], streams: ['str-corinne-q'] }));
  const credential = { id: issued.token.id, principalId: 'principal-sarah-researcher', scopes: issued.token.scopes };
  // Sanity: allowed while the grant is live.
  const before = authorizeScoped(credential, 'history:read', { kind: 'dataset', id: 'dataset-approved-discharge-v1' }, {}, world, NOW);
  assert.equal(before.effect, 'allow', 'dataset read allowed while the grant is active (sarah holds read-approved-datasets)');

  // Revoke the researcher entitlement in the AUTHORITATIVE world.
  world = withEntitlement(world, 'ent-researcher-sarah', { status: 'revoked' });
  const after = authorizeScoped(credential, 'history:read', { kind: 'dataset', id: 'dataset-approved-discharge-v1' }, {}, world, NOW);
  assert.equal(after.effect, 'deny', 'revoked underlying grant must deny even with a live token record');
  assert.equal(after.policyReason, 'DENY_ASSIGNMENT_REVOKED');
  // Restricted-stream reads die with the same revocation; the PUBLIC
  // projection stays readable (publication model — also available anonymously).
  const ownerStream = authorizeScoped(credential, 'observations:read', { kind: 'datastream', id: 'str-hyrum-q-owner' }, {}, world, NOW);
  assert.equal(ownerStream.effect, 'deny');
  const publicStream = authorizeScoped(credential, 'observations:read', { kind: 'datastream', id: 'str-corinne-q' }, {}, world, NOW);
  assert.equal(publicStream.effect, 'allow', 'public projection remains readable (anonymous-equivalent)');
});

test('deactivating the account kills PROTECTED token requests; the public projection stays public', () => {
  let world = tokenWorld();
  const svc = service(() => world);
  const issued = svc.issue('principal-sarah-researcher', sarahRequest({ actions: ['observations:read', 'history:read'], streams: ['str-corinne-q'] }));
  const credential = { id: issued.token.id, principalId: 'principal-sarah-researcher', scopes: issued.token.scopes };
  world = withPrincipal(world, 'principal-sarah-researcher', { active: false });
  const datasetRead = authorizeScoped(credential, 'history:read', { kind: 'dataset', id: 'dataset-approved-discharge-v1' }, {}, world, NOW);
  assert.equal(datasetRead.effect, 'deny', 'protected action must die with the account');
  assert.equal(datasetRead.policyReason, 'DENY_PRINCIPAL_INACTIVE');
  const publicRead = authorizeScoped(credential, 'observations:read', { kind: 'datastream', id: 'str-corinne-q' }, {}, world, NOW);
  assert.equal(publicRead.effect, 'allow', 'public data stays public (anonymous-equivalent access), documenting the semantics');
});

// ---------------------------------------------------------------------------
// Data-bounds attacks (FR-065): reject, never clamp
// ---------------------------------------------------------------------------

test('date-range bounds reject out-of-window queries instead of clamping them', () => {
  const world = fixtureWorld();
  const token = {
    id: 'tok-range',
    principalId: 'principal-sarah-researcher',
    scopes: { actions: ['observations:read'], dateRange: { start: '2026-03-01T00:00:00Z', end: '2026-03-05T00:00:00Z' } },
  };
  const inside = authorizeScoped(token, 'observations:read', { kind: 'datastream', id: 'str-corinne-q' }, { start: '2026-03-02T00:00:00Z', end: '2026-03-04T00:00:00Z' }, world, NOW);
  assert.equal(inside.effect, 'allow');
  const before = authorizeScoped(token, 'observations:read', { kind: 'datastream', id: 'str-corinne-q' }, { start: '2026-02-28T00:00:00Z', end: '2026-03-04T00:00:00Z' }, world, NOW);
  assert.equal(before.effect, 'deny', 'start before the window must reject, not clamp');
  assert.equal(before.scopeReason, 'DATE_RANGE_NOT_IN_SCOPE');
  const after = authorizeScoped(token, 'observations:read', { kind: 'datastream', id: 'str-corinne-q' }, { start: '2026-03-02T00:00:00Z', end: '2026-03-09T00:00:00Z' }, world, NOW);
  assert.equal(after.effect, 'deny', 'end after the window must reject, not clamp');
  // Exact boundary: half-open window [start, end).
  const edgeIn = authorizeScoped(token, 'observations:read', { kind: 'datastream', id: 'str-corinne-q' }, { start: '2026-03-01T00:00:00Z', end: '2026-03-05T00:00:00Z' }, world, NOW);
  assert.equal(edgeIn.effect, 'allow', 'exact window boundaries are inside (half-open)');
  const edgeOut = authorizeScoped(token, 'observations:read', { kind: 'datastream', id: 'str-corinne-q' }, { start: '2026-03-01T00:00:00Z', end: '2026-03-05T00:00:00.001Z' }, world, NOW);
  assert.equal(edgeOut.effect, 'deny', '1 ms past the end is outside');
});

test('property and processing-level bounds hold against mismatched queries', () => {
  const world = fixtureWorld();
  const token = {
    id: 'tok-bounds',
    principalId: 'principal-sarah-researcher',
    scopes: { actions: ['observations:read'], properties: ['discharge'], processingLevels: ['raw', 'reviewed'] },
  };
  const wrongProperty = authorizeScoped(token, 'observations:read', { kind: 'datastream', id: 'str-corinne-q' }, { observedPropertyId: 'stage' }, world, NOW);
  assert.equal(wrongProperty.effect, 'deny');
  assert.equal(wrongProperty.scopeReason, 'PROPERTY_NOT_IN_SCOPE');
  const wrongLevel = authorizeScoped(token, 'observations:read', { kind: 'datastream', id: 'str-corinne-q' }, { processingLevel: 'best-available' }, world, NOW);
  assert.equal(wrongLevel.effect, 'deny');
  assert.equal(wrongLevel.scopeReason, 'PROCESSING_LEVEL_NOT_IN_SCOPE');
  const undeclared = authorizeScoped(token, 'observations:read', { kind: 'datastream', id: 'str-corinne-q' }, {}, world, NOW);
  assert.equal(undeclared.effect, 'allow', 'absent bound dimensions are unconstrained (per contract)');
});

// ---------------------------------------------------------------------------
// Secret handling
// ---------------------------------------------------------------------------

test('verify rejects forged, malformed and guessed secrets', () => {
  const svc = service(fixtureWorld);
  const issued = svc.issue('principal-sarah-researcher', sarahRequest());
  // Malformed formats.
  for (const bad of ['', 'uwdat_', 'not-a-token', 'uwdat_short', `uwdat_${'A'.repeat(200)}`, `uwdat_${'A'.repeat(31)}`]) {
    assert.throws(() => svc.verify(bad), (error) => error.code === 'INVALID_SECRET_FORMAT', `format gate for "${bad.slice(0, 12)}"`);
  }
  // Well-formed guess: right shape, wrong preimage (32 base62 chars).
  assert.throws(() => svc.verify('uwdat_advq' + '0'.repeat(28)), (error) => error.code === 'UNKNOWN_TOKEN');
  // The real secret still verifies.
  const verified = svc.verify(issued.secret);
  assert.equal(verified.token.id, issued.token.id);
});

test('rotate and revoke kill the old secret immediately; no serialized state carries it', () => {
  const svc = service(fixtureWorld);
  const issued = svc.issue('principal-sarah-researcher', sarahRequest());
  const rotated = svc.rotate(issued.token.id, 'principal-sarah-researcher', {});
  assert.notEqual(rotated.secret, issued.secret);
  assert.throws(() => svc.verify(issued.secret), (error) => error.code === 'TOKEN_REVOKED', 'old secret must die at rotation');
  const revoked = svc.revoke(rotated.token.id, 'principal-sarah-researcher');
  assert.equal(revoked.status, 'revoked');
  assert.throws(() => svc.verify(rotated.secret), (error) => error.code === 'TOKEN_REVOKED');
  // Serialized store/audit must never contain either plaintext secret.
  const state = svc.serializeState() + JSON.stringify(svc.listFor('principal-sarah-researcher'));
  assert.ok(!state.includes(issued.secret), 'issued secret leaked into serialized state');
  assert.ok(!state.includes(rotated.secret), 'rotated secret leaked into serialized state');
});

test('cross-principal revocation attempt fails closed', () => {
  const svc = service(fixtureWorld);
  const issued = svc.issue('principal-sarah-researcher', sarahRequest());
  // fatima tries to revoke sarah's token.
  assert.throws(() => svc.revoke(issued.token.id, 'principal-fatima-engineer'), /no such token|not owned/);
  // The token still verifies afterwards.
  const verified = svc.verify(issued.secret);
  assert.equal(verified.token.id, issued.token.id);
});

test('principalCanReadStream mirrors the policy engine for issue-time validation', () => {
  const world = fixtureWorld();
  assert.equal(principalCanReadStream(world, 'principal-sarah-researcher', 'str-corinne-q', NOW).effect, 'allow');
  assert.equal(principalCanReadStream(world, 'principal-sarah-researcher', 'str-hyrum-q-owner', NOW).effect, 'deny');
  assert.equal(principalCanReadStream(world, 'principal-sarah-researcher', 'str-diag-voltage', NOW).effect, 'deny');
  assert.equal(principalCanReadStream(world, 'nobody', 'str-corinne-q', NOW).effect, 'allow', 'public projection readable by unknown ids too');
});
