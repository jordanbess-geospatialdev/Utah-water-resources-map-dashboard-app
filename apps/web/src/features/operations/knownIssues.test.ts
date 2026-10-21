/**
 * Known data issue tests (FR-038): the two synthetic fixture issues, their
 * FR-038 field coverage, resolution-history consistency, and POLICY-DRIVEN
 * visibility filtering (public issue on a public station, internal issue on
 * a restricted station) against the REAL entitlement engine.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/operations/knownIssues.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { PolicyEvaluator, PolicyWorldMirror } from './assignedScope';

register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const knownIssuesPath = './knownIssues.ts';
const ki: typeof import('./knownIssues') = await import(knownIssuesPath);
const scopePath = './assignedScope.ts';
const scope: typeof import('./assignedScope') = await import(scopePath);
const fixturesPath = '../../shell/data/fixtures.ts';
const fixtures: typeof import('../../shell/data/fixtures') = await import(fixturesPath);

const policyPath = '../../../../../packages/policy/src/index.ts';
const policy = (await import(policyPath)) as {
  buildWorld: (input: Record<string, unknown>) => PolicyWorldMirror;
  withEntitlement: (world: PolicyWorldMirror, id: string, patch: Record<string, unknown>) => PolicyWorldMirror;
  evaluate: PolicyEvaluator;
};

const NOW = fixtures.FIXTURE_CLOCK;

function world(): PolicyWorldMirror {
  return policy.buildWorld({
    principals: {
      seed: fixtures.FIXTURE_SEED,
      organizations: fixtures.organizations as unknown as object[],
      users: fixtures.users as unknown as object[],
      entitlements: fixtures.entitlements as unknown as object[],
    },
    stations: { seed: fixtures.FIXTURE_SEED, stations: fixtures.stations as unknown as object[] },
  });
}

function issuesFor(principalId: string | null, worldSnapshot: PolicyWorldMirror = world()) {
  return ki.knownIssuesForViewer({ principalId, world: worldSnapshot, policy: policy.evaluate, now: NOW });
}

function carriedIds(principalId: string | null, worldSnapshot?: PolicyWorldMirror): string[] {
  return issuesFor(principalId, worldSnapshot).carried.map((entry) => entry.issue.id);
}

// ---------------------------------------------------------------------------
// The two synthetic records and their FR-038 field coverage
// ---------------------------------------------------------------------------

test('exactly two synthetic issues: one public on a public station, one internal on a restricted station', () => {
  assert.equal(ki.KNOWN_ISSUES.length, 2);
  const [publicIssue, internalIssue] = ki.KNOWN_ISSUES;
  assert.equal(publicIssue!.visibility, 'public');
  assert.equal(publicIssue!.stationId, 'sta-bear-corinne');
  assert.equal(fixtures.stationById.get(publicIssue!.stationId)!.visibility, 'public');
  assert.equal(internalIssue!.visibility, 'internal');
  assert.equal(internalIssue!.stationId, 'sta-hyrum-diversion-owner');
  assert.equal(fixtures.stationById.get(internalIssue!.stationId)!.visibility, 'restricted');
});

test('both records carry the full FR-038 field set and a consistent resolution history', () => {
  for (const issue of ki.KNOWN_ISSUES) {
    assert.equal(typeof issue.streamId, 'string'); // affected stream
    assert.ok(Date.parse(issue.interval.start) < Date.parse(issue.interval.end)); // half-open, non-empty interval
    assert.ok(['open', 'acknowledged', 'resolved'].includes(issue.status));
    assert.ok(['public', 'internal'].includes(issue.visibility));
    assert.ok(issue.resolutionHistory.length > 0, 'resolution history is carried');
    assert.deepEqual(issue.resolutionHistory.map((event) => event.outcome), issue.resolutionHistory.map((event) => event.outcome).slice(), 'history present');
    assert.equal(ki.statusFromHistory(issue.resolutionHistory), issue.status, `status of ${issue.id} equals the history fold`);
  }
  // The internal issue exercises a multi-event chain (acknowledged then reopened -> open).
  const internalIssue = ki.KNOWN_ISSUES[1]!;
  assert.equal(internalIssue.resolutionHistory.length, 2);
  assert.deepEqual(internalIssue.resolutionHistory.map((event) => event.outcome), ['acknowledged', 'reopened']);
});

// ---------------------------------------------------------------------------
// Visibility filtering through the real engine
// ---------------------------------------------------------------------------

test('anonymous viewers carry the public issue and never the internal one', () => {
  const result = issuesFor(null);
  assert.deepEqual(carriedIds(null), ['ki-corinne-outage-20260308']);
  assert.equal(result.omitted.length, 1);
  assert.equal(result.omitted[0]!.issue.id, 'ki-hyrum-owner-weir-202603');
  assert.equal(result.omitted[0]!.denyReason, 'DENY_ANONYMOUS');
});

test('Cody (recorder) carries the public issue but not the internal context: authorship grants nothing', () => {
  const result = issuesFor('principal-cody-commissioner');
  assert.deepEqual(carriedIds('principal-cody-commissioner'), ['ki-corinne-outage-20260308']);
  const omitted = result.omitted[0]!;
  assert.equal(omitted.issue.id, 'ki-hyrum-owner-weir-202603');
  assert.equal(omitted.denyReason, 'DENY_FIELD_VISIBILITY'); // assignment over the station is not sufficient (FR-049)
});

test('Fatima (engineer with view-internal-diagnostics, in scope) carries both issues', () => {
  const result = issuesFor('principal-fatima-engineer');
  assert.deepEqual(carriedIds('principal-fatima-engineer'), ['ki-corinne-outage-20260308', 'ki-hyrum-owner-weir-202603']);
  assert.equal(result.omitted.length, 0);
  const internal = result.carried.find((entry) => entry.issue.visibility === 'internal')!;
  assert.equal(internal.carriedByReason, 'ALLOW_PROTECTED');
});

test('Diego (statewide) carries both; Priya (Weber, out of scope) carries only the public issue', () => {
  assert.deepEqual(carriedIds('principal-diego-steward'), ['ki-corinne-outage-20260308', 'ki-hyrum-owner-weir-202603']);
  const priya = issuesFor('principal-priya-engineer');
  assert.deepEqual(carriedIds('principal-priya-engineer'), ['ki-corinne-outage-20260308']);
  assert.equal(priya.omitted[0]!.denyReason, 'DENY_OUT_OF_SCOPE');
});

test('revoking Fatima\'s grant removes the internal issue context on the next derivation', () => {
  const revoked = policy.withEntitlement(world(), 'ent-engineer-fatima', { status: 'revoked', grantVersion: 12 });
  const result = issuesFor('principal-fatima-engineer', revoked);
  assert.deepEqual(
    result.carried.map((entry) => entry.issue.id),
    ['ki-corinne-outage-20260308'], // the public issue still carries via the public branch
  );
  assert.equal(result.omitted[0]!.denyReason, 'DENY_ASSIGNMENT_REVOKED');
});

test('a public issue on an UNPUBLISHED station is not carried publicly: publication governs the public branch', () => {
  // Synthetic variant: same public-visibility issue, anchored to the restricted owner station.
  const synthetic = {
    ...ki.KNOWN_ISSUES[0]!,
    id: 'ki-synthetic-public-on-restricted',
    stationId: 'sta-hyrum-diversion-owner',
  };
  const result = ki.knownIssuesForViewer({ principalId: null, world: world(), policy: policy.evaluate, now: NOW, issues: [synthetic] });
  assert.equal(result.carried.length, 0);
  assert.equal(result.omitted[0]!.denyReason, 'DENY_OBJECT_UNPUBLISHED');
  // ...while an in-scope commissioner carries it through the protected branch.
  const cody = ki.knownIssuesForViewer({
    principalId: 'principal-cody-commissioner',
    world: world(),
    policy: policy.evaluate,
    now: NOW,
    issues: [synthetic],
  });
  assert.equal(cody.carried.length, 1);
  assert.equal(cody.carried[0]!.carriedByReason, 'ALLOW_PROTECTED');
});
