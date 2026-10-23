import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withEntitlement } from '../../../../../../packages/policy/src/index.ts';
import { createKnownIssueService } from '../knownIssues.ts';
import { createThresholdService } from '../diagnostics.ts';
import { createQcEngine } from '../engine.ts';
import { CODY, DIEGO, FATIMA, NOW, buildTestWorld, fixtureSeries } from './helpers.ts';

const interval = { start: '2026-03-08T12:00:00Z', end: '2026-03-08T18:00:00Z' };
const levels = [{ id: 'high', property: 'stage', op: '>=' as const, value: 2.5, label: 'High stage', symbol: '!', severity: 'warn' as const }];

test('WD-027: a threshold-only engineer can manage assigned sets until the grant is revoked', () => {
  const deps = {
    world: withEntitlement(buildTestWorld(), 'ent-engineer-fatima', { capabilities: ['manage-thresholds'] }),
    clock: () => NOW,
  };
  const svc = createThresholdService(deps);
  const created = svc.createThresholdSet(FATIMA, { id: 'th-engineer-bear', scope: { kind: 'stream', streamId: 'str-corinne-stage' }, levels });
  assert.ok(created.ok, JSON.stringify(created));
  assert.equal(created.set.author, FATIMA);
  assert.equal(created.set.status, 'draft');

  const revisedLevels = levels.map((level) => ({ ...level, value: 2.7 }));
  const revised = svc.reviseThresholdSet(FATIMA, created.set.id, revisedLevels);
  assert.ok(revised.ok, JSON.stringify(revised));
  assert.equal(revised.set.version, 2);
  assert.deepEqual(revised.set.levels, revisedLevels);
  const promoted = svc.promoteThresholdSet(FATIMA, created.set.id);
  assert.ok(promoted.ok, JSON.stringify(promoted));
  assert.equal(promoted.set.promotedBy, FATIMA);
  assert.deepEqual(svc.effectiveSets(), [promoted.set]);

  // Seed a real Weber set so all three mutations exercise scope authorization.
  const weber = svc.createThresholdSet(DIEGO, { id: 'th-engineer-weber', scope: { kind: 'system', systemId: 'sys-weber-river' }, levels });
  assert.ok(weber.ok, JSON.stringify(weber));
  const beforeCrossScope = svc.sets();
  for (const denied of [
    svc.createThresholdSet(FATIMA, { id: 'th-engineer-cross', scope: { kind: 'system', systemId: 'sys-weber-river' }, levels }),
    svc.reviseThresholdSet(FATIMA, weber.set.id, revisedLevels),
    svc.promoteThresholdSet(FATIMA, weber.set.id),
  ]) {
    assert.ok(!denied.ok && 'reason' in denied, JSON.stringify(denied));
    assert.equal(denied.reason, 'DENY_OUT_OF_SCOPE');
  }
  assert.deepEqual(svc.sets(), beforeCrossScope);

  // Keep the service and a pending draft alive while its authoritative grant changes.
  const pending = svc.reviseThresholdSet(FATIMA, created.set.id, levels);
  assert.ok(pending.ok, JSON.stringify(pending));
  const beforeRevocation = svc.sets();
  deps.world = withEntitlement(deps.world, 'ent-engineer-fatima', { status: 'revoked' });
  for (const denied of [
    svc.createThresholdSet(FATIMA, { id: 'th-engineer-revoked', scope: { kind: 'system', systemId: 'sys-bear-river' }, levels }),
    svc.reviseThresholdSet(FATIMA, created.set.id, revisedLevels),
    svc.promoteThresholdSet(FATIMA, created.set.id),
  ]) {
    assert.ok(!denied.ok && 'reason' in denied, JSON.stringify(denied));
    assert.equal(denied.reason, 'DENY_ASSIGNMENT_REVOKED');
  }
  assert.deepEqual(svc.sets(), beforeRevocation, 'denied mutations preserve every threshold version');
});

test('WD-027: an issue-only operator cannot configure thresholds or global rules', () => {
  const world = withEntitlement(buildTestWorld(), 'ent-engineer-fatima', { capabilities: ['record-data-issues'] });
  const deps = { world, clock: () => NOW };
  const svc = createKnownIssueService(deps);
  const issue = svc.recordIssue(FATIMA, { streamId: 'str-corinne-q', interval, title: 'Field issue', visibility: 'public' });
  assert.ok(issue.ok);
  assert.ok(svc.updateStatus(FATIMA, issue.issue.id, 'resolved', 'Checked in field').ok);
  const crossScope = svc.recordIssue(FATIMA, { streamId: 'str-ogden-q-proposed', interval, title: 'Other system', visibility: 'public' });
  assert.ok(!crossScope.ok && 'status' in crossScope);
  assert.equal(crossScope.reason, 'DENY_OUT_OF_SCOPE');
  const thresholds = createThresholdService(deps);
  const threshold = thresholds.createThresholdSet(FATIMA, { id: 'th-test', scope: { kind: 'system', systemId: 'sys-bear-river' }, levels });
  assert.ok(!threshold.ok && 'reason' in threshold);
  assert.equal(threshold.reason, 'DENY_CAPABILITY_NOT_GRANTED');
  const engine = createQcEngine({ ...deps, fixtures: fixtureSeries() });
  assert.ok(!engine.authorRule(FATIMA, { ruleId: 'qc-test', family: 'range' }).ok);

  const revoked = createKnownIssueService({ ...deps, world: withEntitlement(world, 'ent-engineer-fatima', { status: 'revoked' }) });
  assert.ok(!revoked.recordIssue(FATIMA, { streamId: 'str-corinne-q', interval, title: 'Revoked', visibility: 'public' }).ok);
});

test('WD-027: processing review alone cannot manage issues, thresholds or program rules', () => {
  const world = withEntitlement(buildTestWorld(), 'ent-commissioner-cody', { capabilities: ['review-data'] });
  const deps = { world, clock: () => NOW };
  const issue = createKnownIssueService(deps).recordIssue(CODY, { streamId: 'str-corinne-q', interval, title: 'Not granted', visibility: 'public' });
  assert.ok(!issue.ok && 'reason' in issue);
  assert.equal(issue.reason, 'DENY_CAPABILITY_NOT_GRANTED');
  const threshold = createThresholdService(deps).createThresholdSet(CODY, { id: 'th-test', scope: { kind: 'system', systemId: 'sys-bear-river' }, levels });
  assert.ok(!threshold.ok && 'reason' in threshold);
  assert.equal(threshold.reason, 'DENY_CAPABILITY_NOT_GRANTED');
  const rule = createQcEngine({ ...deps, fixtures: fixtureSeries() }).authorRule(CODY, { ruleId: 'qc-test', family: 'range' });
  assert.ok(!rule.ok && 'denied' in rule);
  assert.equal(rule.denied.reason, 'DENY_CAPABILITY_NOT_GRANTED');
});
