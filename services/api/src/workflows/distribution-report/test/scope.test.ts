/**
 * Scope tests (WD-025; FR-024 "selected authorized system"; T-06):
 * report generation is commissioner-scoped through the shared entitlement
 * engine (action generate-reports on the system policy object).
 *
 * - Cody (fixture commissioner, Bear River, explicit generate-reports grant)
 *   generates Bear River reports;
 * - the same Cody requesting Weber River is DENIED with the hidden-object
 *   policy: out-of-scope on a non-public system object is 404 (the Weber
 *   system does not exist for him), policyReason DENY_OUT_OF_SCOPE;
 * - a deputy outside the delegation window is denied even when the carrying
 *   grant lists generate-reports (DENY_DELEGATION_EXPIRED -> 403); inside
 *   the window the same delegation allows - the window, not the role label,
 *   decides;
 * - anonymous callers are 401;
 * - principals without the capability (engineer, researcher) are 403;
 * - the statewide steward (statewide-administration satisfies
 *   generate-reports) may generate for either system;
 * - a site subset referencing a station outside the selected system is 422.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withEntitlement } from '../../../../../../packages/policy/src/index.ts';
import { fixtureReportDeps, generateReport } from '../generate.ts';
import { reportWorld } from '../world.ts';
import { DEFAULT_INCLUDE, type ReportRequest } from '../types.ts';

const NOW = '2026-03-09T07:00:00Z'; // the fixture fixed clock (inside Ana's delegation window)
const AFTER_DELEGATION = '2026-07-01T00:00:00Z'; // after ent-deputy-ana expires 2026-06-30T23:59:59Z

const CODY = 'principal-cody-commissioner';
const ANA = 'principal-ana-deputy';
const DIEGO = 'principal-diego-steward';
const SARAH = 'principal-sarah-researcher';
const PRIYA = 'principal-priya-engineer';

const BEAR: ReportRequest = {
  systemId: 'sys-bear-river',
  siteIds: null,
  period: { basis: 'calendar-year', year: 2026 },
  processingBasis: 'raw',
  include: DEFAULT_INCLUDE,
};

/** Ana's fixture grant lacks generate-reports; the commissioner may delegate it. */
function worldWithDelegatedReportAuthority() {
  const base = reportWorld().policyWorld;
  const ana = base.assignments.find((assignment) => assignment.id === 'ent-deputy-ana');
  assert.ok(ana);
  return withEntitlement(base, 'ent-deputy-ana', {
    capabilities: [...ana.capabilities, 'generate-reports'],
  });
}

test('Cody (Bear River commissioner) generates a Bear River report', () => {
  const result = generateReport(fixtureReportDeps(NOW), BEAR, CODY);
  assert.equal(result.outcome, 'allowed');
  if (result.outcome === 'allowed') {
    assert.equal(result.value.system.id, 'sys-bear-river');
    assert.equal(result.value.system.name, 'Bear River Distribution System');
    assert.equal(result.value.requestedBy, CODY);
  }
});

test('Cody requesting Weber River is denied 404 (hidden object, out of scope)', () => {
  const result = generateReport(fixtureReportDeps(NOW), { ...BEAR, systemId: 'sys-weber-river' }, CODY);
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.equal(result.status, 404);
    assert.equal(result.code, 'NOT_FOUND');
    assert.equal(result.policyReason, 'DENY_OUT_OF_SCOPE');
  }
});

test('an unknown system id is 404 for an authorized commissioner too', () => {
  const result = generateReport(fixtureReportDeps(NOW), { ...BEAR, systemId: 'sys-does-not-exist' }, CODY);
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.equal(result.status, 404);
    assert.equal(result.policyReason, 'DENY_UNKNOWN_OBJECT');
  }
});

test('anonymous callers are denied 401', () => {
  const result = generateReport(fixtureReportDeps(NOW), BEAR, null);
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.equal(result.status, 401);
    assert.equal(result.policyReason, 'DENY_ANONYMOUS');
  }
});

test('principals without generate-reports are denied 403 (engineer, researcher)', () => {
  for (const actorId of [PRIYA, SARAH]) {
    const result = generateReport(fixtureReportDeps(NOW), { ...BEAR, systemId: actorId === PRIYA ? 'sys-weber-river' : 'sys-bear-river' }, actorId);
    assert.equal(result.outcome, 'denied', actorId);
    if (result.outcome === 'denied') {
      assert.equal(result.status, 403);
      assert.equal(result.code, 'FORBIDDEN');
      assert.equal(result.policyReason, 'DENY_CAPABILITY_NOT_GRANTED', actorId);
    }
  }
});

test('a deputy holding delegated generate-reports may generate inside the delegation window', () => {
  const deps = { ...fixtureReportDeps(NOW), world: worldWithDelegatedReportAuthority() };
  const result = generateReport(deps, BEAR, ANA);
  assert.equal(result.outcome, 'allowed');
  if (result.outcome === 'allowed') assert.equal(result.value.requestedBy, ANA);
});

test('the same deputy outside the delegation window is denied 403 (DENY_DELEGATION_EXPIRED)', () => {
  const deps = { ...fixtureReportDeps(AFTER_DELEGATION), world: worldWithDelegatedReportAuthority() };
  const result = generateReport(deps, BEAR, ANA);
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.equal(result.status, 403);
    assert.equal(result.policyReason, 'DENY_DELEGATION_EXPIRED');
  }
});

test('the fixture deputy (no delegated generate-reports) is denied 403 inside the window', () => {
  const result = generateReport(fixtureReportDeps(NOW), BEAR, ANA);
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.equal(result.status, 403);
    assert.equal(result.policyReason, 'DENY_CAPABILITY_NOT_GRANTED');
  }
});

test('the statewide steward may generate for either system (statewide-administration)', () => {
  for (const systemId of ['sys-bear-river', 'sys-weber-river']) {
    const result = generateReport(fixtureReportDeps(NOW), { ...BEAR, systemId }, DIEGO);
    assert.equal(result.outcome, 'allowed', systemId);
  }
});

test('a site subset naming a station outside the selected system is 422', () => {
  const result = generateReport(fixtureReportDeps(NOW), { ...BEAR, siteIds: ['sta-ogden-valley-proposed'] }, CODY);
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.equal(result.status, 422);
    assert.equal(result.code, 'SITE_NOT_IN_SYSTEM');
  }
});

test('an in-system site subset generates a scoped report', () => {
  const result = generateReport(fixtureReportDeps(NOW), { ...BEAR, siteIds: ['sta-bear-corinne'] }, CODY);
  assert.equal(result.outcome, 'allowed');
  if (result.outcome === 'allowed') {
    assert.deepEqual(
      result.value.sections.sites.map((site) => site.stationId),
      ['sta-bear-corinne'],
    );
  }
});
