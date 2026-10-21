/**
 * Assignment administration tests (WD-014; FR-011; verification rows
 * T-02/T-03): delegation boundary INSTANTS against an injected clock,
 * revocation affecting the NEXT request, the monotonic grant-version
 * counter, deactivated actors staying identifiable, and grant-time
 * validation aligned with the policy engine semantics.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/stewardship/test/assignments.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, withPrincipal, type Decision, type PolicyWorld } from '../../../../../../packages/policy/src/index.ts';
import { createAssignmentService, type AssignmentService } from '../assignments.ts';
import { ANA, CODY, DIEGO, FATIMA, LEE, NOW, PRIYA, buildTestWorld } from './helpers.ts';

const world = buildTestWorld();
const clock = (): string => NOW;

function service(): AssignmentService {
  return createAssignmentService({ world, clock });
}

/** enter-readings on a Bear River station by `who` at instant `at` against `w`. */
function enterReadings(w: PolicyWorld, who: string, at: string): Decision {
  return evaluate({ principal: w.principals[who] ?? null, action: 'enter-readings', object: { kind: 'station', id: 'sta-bear-corinne' } }, w, at);
}

const WINDOW = { effectiveAt: '2026-04-01T07:00:00Z', expiresAt: '2026-04-30T23:59:59Z' } as const;

test('deputy delegation boundary instants: half-open [effectiveAt, expiresAt) at millisecond resolution', () => {
  const svc = service();
  const delegated = svc.delegateDeputy(DIEGO, { principalId: LEE, scopeType: 'system', scopeId: 'sys-bear-river', ...WINDOW, delegatedBy: CODY });
  assert.ok(delegated.ok, JSON.stringify(delegated));
  const w = delegated.world;
  assert.deepEqual(
    [
      enterReadings(w, LEE, '2026-03-31T23:59:59.999Z').reason, // 1 ms before effective
      enterReadings(w, LEE, WINDOW.effectiveAt).reason, // exactly effective (inclusive)
      enterReadings(w, LEE, '2026-04-30T23:59:58.999Z').reason, // 1 ms before expiry
      enterReadings(w, LEE, WINDOW.expiresAt).reason, // exactly expiry (exclusive)
      enterReadings(w, LEE, '2026-05-01T00:00:00Z').reason, // after expiry
    ],
    [
      'DENY_DELEGATION_NOT_EFFECTIVE',
      'ALLOW_PROTECTED',
      'ALLOW_PROTECTED',
      'DENY_DELEGATION_EXPIRED',
      'DENY_DELEGATION_EXPIRED',
    ],
  );
  // The delegation is explicit, audited and scoped (never statewide).
  assert.equal(delegated.assignment.role, 'deputy');
  assert.equal(delegated.assignment.scope.kind, 'system');
  assert.equal(delegated.assignment.delegation!.delegatedBy, CODY);
  assert.equal(delegated.assignment.delegation!.effectiveAt, WINDOW.effectiveAt);
  assert.equal(delegated.assignment.delegation!.expiresAt, WINDOW.expiresAt);
});

test('revocation affects the NEXT authorized request: same instant, revoked grant denies', () => {
  const svc = service();
  const delegated = svc.delegateDeputy(DIEGO, { principalId: LEE, scopeType: 'system', scopeId: 'sys-bear-river', ...WINDOW });
  assert.ok(delegated.ok);
  const inside = '2026-04-15T12:00:00Z';
  assert.equal(enterReadings(delegated.world, LEE, inside).effect, 'allow');

  const revoked = svc.revoke(DIEGO, delegated.assignment.id);
  assert.ok(revoked.ok);
  assert.equal(revoked.assignment.status, 'revoked');
  // The very next evaluation against the returned authoritative snapshot denies.
  const after = enterReadings(revoked.world, LEE, inside);
  assert.equal(after.effect, 'deny');
  assert.equal(after.reason, 'DENY_ASSIGNMENT_REVOKED');
  assert.ok(after.assignmentVersion > delegated.world.assignmentVersion, 'revocation bumps the authoritative assignment version');
  // Double revoke is refused.
  const again = svc.revoke(DIEGO, delegated.assignment.id);
  assert.ok(!again.ok && 'errors' in again);
  assert.deepEqual(again.errors, ['already-revoked']);
});

test('the fixture deputy grant revokes the same way: Ana loses Bear River on the next request', () => {
  const svc = service();
  const at = NOW; // inside Ana's fixture delegation window
  assert.equal(enterReadings(svc.currentWorld(), ANA, at).reason, 'ALLOW_PROTECTED');
  const revoked = svc.revoke(DIEGO, 'ent-deputy-ana');
  assert.ok(revoked.ok);
  assert.equal(enterReadings(revoked.world, ANA, at).reason, 'DENY_ASSIGNMENT_REVOKED');
});

test('a steward cannot keep administering grants after its own authority is revoked', () => {
  const svc = service();
  const ownGrant = world.assignments.find((assignment) => assignment.principalId === DIEGO)!;
  assert.ok(svc.revoke(DIEGO, ownGrant.id).ok);
  const before = svc.serialize();
  const grant = svc.grant(DIEGO, { principalId: CODY, role: 'commissioner', capabilities: ['enter-readings'], scopeType: 'system', scopeId: 'sys-bear-river' });
  assert.ok(!grant.ok && 'denied' in grant, 'revocation must be consulted by the next administrative operation');
  const revoke = svc.revoke(DIEGO, 'ent-deputy-ana');
  assert.ok(!revoke.ok && 'denied' in revoke);
  assert.equal(svc.serialize(), before, 'denied operations must leave grants and audit history unchanged');
});

test('grant-version counter is monotonic across grants, delegations and revocations', () => {
  const svc = service();
  const start = svc.grantVersionCounter();
  assert.equal(start, world.assignmentVersion);
  const granted = svc.grant(DIEGO, { principalId: PRIYA, role: 'commissioner', capabilities: ['enter-readings'], scopeType: 'system', scopeId: 'sys-weber-river' });
  const delegated = svc.delegateDeputy(DIEGO, { principalId: LEE, scopeType: 'system', scopeId: 'sys-bear-river', ...WINDOW });
  const revoked = svc.revoke(DIEGO, granted.assignment.id);
  assert.ok(granted.ok && delegated.ok && revoked.ok);
  assert.deepEqual([granted.assignment.grantVersion, delegated.assignment.grantVersion, revoked.assignment.grantVersion], [start + 1, start + 2, start + 3]);
  assert.equal(svc.grantVersionCounter(), start + 3);
  assert.equal(revoked.world.assignmentVersion, start + 3);
  // Each version appears exactly once across the authoritative snapshot.
  const versions = revoked.world.assignments.map((assignment) => assignment.grantVersion).sort((a, b) => a - b);
  assert.equal(new Set(versions).size, versions.length, 'grant versions are unique');
});

test('deactivated principals keep resolvable actor snapshots for audit while authorization denies', () => {
  const svc = service();
  const delegated = svc.delegateDeputy(DIEGO, { principalId: LEE, scopeType: 'system', scopeId: 'sys-bear-river', ...WINDOW });
  assert.ok(delegated.ok);

  // Offboard Lee: every decision denies, identity failures map 401...
  const offboarded = withPrincipal(delegated.world, LEE, { active: false });
  const denied = enterReadings(offboarded, LEE, '2026-04-15T12:00:00Z');
  assert.equal(denied.effect, 'deny');
  assert.equal(denied.reason, 'DENY_PRINCIPAL_INACTIVE');

  // ...but the actor stays resolvable for audit (engine semantics).
  assert.equal(svc.resolveActorSnapshot(LEE)!.displayName, 'Lee Deputy');
  assert.equal(svc.resolveActorSnapshot(LEE)!.id, LEE);
  assert.equal(svc.resolveActorSnapshot('principal-ghost'), null, 'unknown ids return null, never throw');

  // And the audit trail embeds the grantee snapshot captured at delegation
  // time: the name renders long after deactivation.
  const entry = svc.changeLog().find((event) => event.assignmentId === delegated.assignment.id)!;
  assert.equal(entry.granteeSnapshot.displayName, 'Lee Deputy');
  assert.equal(entry.granteeSnapshot.id, LEE);
  assert.equal(entry.granteeSnapshot.active, true, 'snapshot captured at grant time, before offboarding');
});

test('grant-time validation mirrors the policy engine semantics', () => {
  const svc = service();
  // Deputy grants may never be statewide (DEPUTY_DELEGATION_POLICY).
  const statewide = svc.delegateDeputy(DIEGO, { principalId: LEE, scopeType: 'statewide', scopeId: '', ...WINDOW });
  assert.ok(!statewide.ok && 'errors' in statewide);
  assert.ok((statewide.errors as readonly string[]).includes('deputy-not-statewide'));
  // Delegations require an explicit non-empty window.
  const noWindow = svc.delegateDeputy(DIEGO, { principalId: LEE, scopeType: 'system', scopeId: 'sys-bear-river', effectiveAt: '', expiresAt: '' });
  assert.ok(!noWindow.ok && 'errors' in noWindow);
  assert.ok((noWindow.errors as readonly string[]).includes('deputy-requires-window'));
  // Expiry must be after effective (half-open interval must be non-empty).
  const inverted = svc.delegateDeputy(DIEGO, { principalId: LEE, scopeType: 'system', scopeId: 'sys-bear-river', effectiveAt: WINDOW.expiresAt, expiresAt: WINDOW.effectiveAt });
  assert.ok(!inverted.ok && 'errors' in inverted);
  assert.ok((inverted.errors as readonly string[]).includes('empty-window'));
  // Capabilities are capped by the role ceiling (matrix.ts): a commissioner
  // grant may not carry manage-vocabulary.
  const aboveCeiling = svc.grant(DIEGO, { principalId: CODY, role: 'commissioner', capabilities: ['enter-readings', 'manage-vocabulary'], scopeType: 'system', scopeId: 'sys-bear-river' });
  assert.ok(!aboveCeiling.ok && 'errors' in aboveCeiling);
  assert.deepEqual(aboveCeiling.errors, ['capability-above-ceiling']);
  // Unknown principals and inactive grantees are refused.
  const unknown = svc.grant(DIEGO, { principalId: 'principal-ghost', role: 'engineer', capabilities: ['enter-readings'], scopeType: 'system', scopeId: 'sys-bear-river' });
  assert.deepEqual((unknown as { errors?: readonly string[] }).errors, ['unknown-principal']);
  const inactiveWorld = withPrincipal(world, FATIMA, { active: false });
  const inactive = createAssignmentService({ world: inactiveWorld, clock }).grant(DIEGO, { principalId: FATIMA, role: 'commissioner', capabilities: ['enter-readings'], scopeType: 'system', scopeId: 'sys-bear-river' });
  assert.deepEqual((inactive as { errors?: readonly string[] }).errors, ['principal-inactive']);
  // Statewide grants carry no scope id; other scopes require one.
  const badStatewide = svc.grant(DIEGO, { principalId: LEE, role: 'engineer', capabilities: ['enter-readings'], scopeType: 'statewide', scopeId: 'sys-bear-river' });
  assert.deepEqual((badStatewide as { errors?: readonly string[] }).errors, ['bad-scope']);
  const missingScope = svc.grant(DIEGO, { principalId: LEE, role: 'engineer', capabilities: ['enter-readings'], scopeType: 'system', scopeId: null });
  assert.deepEqual((missingScope as { errors?: readonly string[] }).errors, ['bad-scope']);
});

test('a grant is effective immediately: the NEXT request after a grant allows', () => {
  const svc = service();
  const at = NOW;
  // Before the grant: Priya holds enter-readings for Weber only - the Bear
  // station is out of scope, and she holds no reporting capability anywhere.
  assert.equal(enterReadings(svc.currentWorld(), PRIYA, at).reason, 'DENY_OUT_OF_SCOPE');
  const weber = evaluate({ principal: svc.currentWorld().principals[PRIYA]!, action: 'generate-reports', object: { kind: 'station', id: 'sta-ogden-valley-proposed' } }, svc.currentWorld(), at);
  assert.equal(weber.reason, 'DENY_CAPABILITY_NOT_GRANTED', 'Priya holds no generate-reports before the grant');
  const granted = svc.grant(DIEGO, { principalId: PRIYA, role: 'commissioner', capabilities: ['generate-reports'], scopeType: 'system', scopeId: 'sys-weber-river' });
  assert.ok(granted.ok);
  const after = evaluate({ principal: granted.world.principals[PRIYA]!, action: 'generate-reports', object: { kind: 'station', id: 'sta-ogden-valley-proposed' } }, granted.world, at);
  assert.equal(after.reason, 'ALLOW_PROTECTED', 'the next request after the grant allows');
});

test('audit log records grant, delegation and revocation with actors and versions', () => {
  const svc = service();
  const granted = svc.grant(DIEGO, { principalId: LEE, role: 'commissioner', capabilities: ['enter-readings'], scopeType: 'system', scopeId: 'sys-bear-river' });
  const delegated = svc.delegateDeputy(DIEGO, { principalId: LEE, scopeType: 'system', scopeId: 'sys-bear-river', ...WINDOW });
  const revoked = svc.revoke(DIEGO, delegated.assignment.id);
  assert.ok(granted.ok && delegated.ok && revoked.ok);
  const log = svc.changeLog();
  assert.deepEqual(log.map((event) => event.action), ['grant', 'delegate', 'revoke']);
  assert.ok(log.every((event) => event.actorId === DIEGO));
  assert.ok(log.every((event) => event.at === NOW));
  assert.deepEqual(log.map((event) => event.grantVersion), [granted.assignment.grantVersion, delegated.assignment.grantVersion, revoked.assignment.grantVersion]);
});

test('determinism: identical mutation sequence run twice produces identical serialized state', () => {
  const scenario = (): string => {
    const svc = service();
    svc.grant(DIEGO, { principalId: LEE, role: 'commissioner', capabilities: ['enter-readings'], scopeType: 'system', scopeId: 'sys-bear-river' });
    svc.delegateDeputy(DIEGO, { principalId: LEE, scopeType: 'system', scopeId: 'sys-bear-river', ...WINDOW });
    svc.revoke(DIEGO, 'ent-commissioner-cody');
    return svc.serialize();
  };
  assert.equal(scenario(), scenario());
});
