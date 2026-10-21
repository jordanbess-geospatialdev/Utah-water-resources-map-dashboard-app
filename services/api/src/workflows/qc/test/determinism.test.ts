/**
 * Whole-pipeline determinism (WD-013; FR-015/FR-016/FR-034/FR-036/FR-038;
 * verification rows T-06/T-15): the same injected clock and fixture inputs
 * produce byte-identical rule evaluations, engine histories (including an
 * injected failing rule), subscription digests, diagnostics views and known
 * issue lifecycles across two independent runs. No hidden clock reads, no
 * randomness, no iteration-order dependence.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/qc/test/determinism.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQcEngine } from '../engine.ts';
import { createQcSubscriptionService } from '../subscriptions.ts';
import { createThresholdService, defaultThresholdSets, engineerDiagnostics, publicDiagnosticsProjection } from '../diagnostics.ts';
import { createKnownIssueService } from '../knownIssues.ts';
import { DEFAULT_RULE_CONFIGS, DEFAULT_RULE_IDS, RULE_FAMILIES, evaluate } from '../rules.ts';
import { CODY, DIEGO, FATIMA, NOW, advancingClock, buildTestWorld, diagnosticStreams, fixtureSeries } from './helpers.ts';

/** One full deterministic pipeline pass; returns the serialized evidence. */
function pipelinePass(): string {
  const clock = advancingClock();
  const world = buildTestWorld();
  const fixtures = fixtureSeries();

  // Rules: author, test, promote, revise, test, and a monitoring run with
  // one injected throwing rule (isolation must be reproducible).
  let throwNow = false;
  const engine = createQcEngine({
    world,
    clock: clock.clock,
    fixtures,
    evaluators: {
      'qc-rate-of-change': (series, rule) => {
        if (throwNow) throw new Error('determinism probe crash');
        return evaluate(series, rule);
      },
    },
  });
  for (const family of RULE_FAMILIES) {
    assert.ok(engine.authorRule(DIEGO, { ruleId: DEFAULT_RULE_IDS[family], family }).ok);
  }
  for (const family of RULE_FAMILIES) {
    clock.advanceMinutes(1);
    assert.ok(engine.testRule(DIEGO, DEFAULT_RULE_IDS[family]).ok);
    clock.advanceMinutes(1);
    assert.ok(engine.promoteRule(DIEGO, DEFAULT_RULE_IDS[family]).ok);
  }
  clock.advanceMinutes(1);
  const revised = engine.reviseRule(DIEGO, 'qc-range', { ...DEFAULT_RULE_CONFIGS.range, bounds: { ...DEFAULT_RULE_CONFIGS.range.bounds, discharge: { min: 0, max: 1300 } } });
  assert.ok(revised.ok);
  throwNow = true;
  const monitoring = engine.runMonitoring('determinism');
  assert.equal(monitoring.results.find((result) => result.ruleId === 'qc-rate-of-change')!.status, 'failed');

  // Subscriptions: two recipients, two cadences, two digest windows.
  const subscriptions = createQcSubscriptionService({ world, clock: clock.clock });
  const codySub = subscriptions.createSubscription(CODY, { scope: { kind: 'system', systemId: 'sys-bear-river' }, cadence: 'hourly' });
  const fatimaSub = subscriptions.createSubscription(FATIMA, { scope: { kind: 'stream', streamId: 'str-diag-voltage' }, cadence: 'daily' });
  assert.ok(codySub.ok && fatimaSub.ok);
  const rule = (family: (typeof RULE_FAMILIES)[number]) => ({
    ruleId: DEFAULT_RULE_IDS[family],
    family,
    version: 1,
    status: 'promoted' as const,
    author: DIEGO,
    createdAt: NOW,
    updatedAt: NOW,
    config: DEFAULT_RULE_CONFIGS[family],
    notes: null,
  });
  const feed = fixtures.flatMap((series) => RULE_FAMILIES.flatMap((family) => [...evaluate(series, rule(family))].map((violation) => ({ violation, detectedAt: clock.now(), systemId: 'sys-bear-river' }))));
  clock.advanceMinutes(60);
  const digestOne = subscriptions.buildDigest(codySub.subscription.id, clock.now(), feed);
  clock.advanceMinutes(60);
  const digestTwo = subscriptions.buildDigest(codySub.subscription.id, clock.now(), feed);
  clock.advanceMinutes(1440);
  const digestThree = subscriptions.buildDigest(fatimaSub.subscription.id, clock.now(), feed);

  // Diagnostics: threshold service lifecycle + views + public projection.
  const thresholds = createThresholdService({ world, clock: clock.clock });
  for (const set of defaultThresholdSets(DIEGO, NOW)) {
    const created = thresholds.createThresholdSet(DIEGO, { id: set.id, scope: set.scope, levels: set.levels });
    assert.ok(created.ok);
    assert.ok(thresholds.promoteThresholdSet(DIEGO, set.id).ok);
  }
  const streams = diagnosticStreams();
  const fatimaView = engineerDiagnostics({ world, clock: clock.clock }, FATIMA, { streams, thresholdSets: thresholds.effectiveSets() });
  const codyView = engineerDiagnostics({ world, clock: clock.clock }, CODY, { streams, thresholdSets: thresholds.effectiveSets() });
  const publicView = publicDiagnosticsProjection({ streams, thresholdSets: thresholds.effectiveSets() });

  // Known issues: record + full lifecycle.
  const issues = createKnownIssueService({ world, clock: clock.clock });
  const issue = issues.recordIssue(DIEGO, { streamId: 'str-corinne-q', interval: { start: '2026-03-08T12:00:00Z', end: '2026-03-08T18:00:00Z' }, title: 'Outage', visibility: 'public' });
  assert.ok(issue.ok);
  assert.ok(issues.updateStatus(DIEGO, issue.issue.id, 'monitoring', 'watch').ok);
  assert.ok(issues.updateStatus(CODY, issue.issue.id, 'resolved', 'restored').ok);

  return JSON.stringify({
    rules: engine.rules(),
    history: engine.runHistory(),
    digests: [digestOne, digestTwo, digestThree],
    subscriptions: [subscriptions.subscriptionsFor(CODY), subscriptions.subscriptionsFor(FATIMA)],
    fatimaView,
    codyView,
    publicView,
    thresholds: thresholds.sets(),
    issues: issues.issues(),
    issueContext: issues.issueContextForExport(null, { streamId: 'str-corinne-q', start: '2026-03-08T00:00:00Z', end: '2026-03-09T00:00:00Z' }),
  });
}

test('the full QC pipeline is byte-identical across two independent runs (twice)', () => {
  const first = pipelinePass();
  const second = pipelinePass();
  assert.equal(first, second);
});
