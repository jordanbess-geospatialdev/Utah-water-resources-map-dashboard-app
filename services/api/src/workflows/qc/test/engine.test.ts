/**
 * QC engine tests (WD-013; FR-015; verification rows T-06/T-15):
 * versioned authoring through the steward gate, the TEST-BEFORE-PROMOTE
 * requirement, ISOLATED execution where one throwing rule records a failed
 * run and never stops the others (injected throwing evaluator), run history,
 * and the golden counts as the fixture test outcomes.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/qc/test/engine.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQcEngine, type QcEngine } from '../engine.ts';
import { DEFAULT_RULE_CONFIGS, DEFAULT_RULE_IDS, RULE_FAMILIES, evaluate, type QcRuleFamily, type RuleEvaluator } from '../rules.ts';
import { CODY, DIEGO, FATIMA, NOW, advancingClock, buildTestWorld, fixtureSeries } from './helpers.ts';

/** The reviewed golden violation counts per family on the fixture series (expected.ts). */
const GOLDEN_COUNTS: Readonly<Record<QcRuleFamily, number>> = Object.freeze({
  range: 3,
  'rate-of-change': 6,
  persistence: 0,
  'missing-data': 10,
  'zero-value': 1,
});

/** Narrow helper so denial/error unions stay readable in assertions. */
function errorsOf<T extends { ok: false }>(outcome: T): readonly unknown[] {
  assert.ok('errors' in outcome, `expected an errors outcome, got ${JSON.stringify(outcome)}`);
  return (outcome as { errors: readonly unknown[] }).errors;
}

function seedFiveRules(engine: QcEngine): void {
  for (const family of RULE_FAMILIES) {
    const authored = engine.authorRule(DIEGO, { ruleId: DEFAULT_RULE_IDS[family], family });
    assert.ok(authored.ok, JSON.stringify(authored));
  }
}

test('rules record author and created/updated timestamps and start as drafts', () => {
  const clock = advancingClock();
  const engine = createQcEngine({ world: buildTestWorld(), clock: clock.clock, fixtures: fixtureSeries() });
  seedFiveRules(engine);
  const rules = engine.rules();
  assert.equal(rules.length, 5);
  for (const rule of rules) {
    assert.equal(rule.status, 'draft');
    assert.equal(rule.author, DIEGO);
    assert.equal(rule.version, 1);
    assert.equal(rule.createdAt, NOW);
    assert.equal(rule.updatedAt, NOW);
  }
  clock.advanceMinutes(5);
  const revised = engine.reviseRule(DIEGO, 'qc-range', { ...DEFAULT_RULE_CONFIGS.range, bounds: { ...DEFAULT_RULE_CONFIGS.range.bounds, discharge: { min: 0, max: 1300 } } }, 'raise max after 2026 high flows');
  assert.ok(revised.ok, JSON.stringify(revised));
  assert.equal(revised.rule.version, 2);
  assert.equal(revised.rule.status, 'draft');
  assert.equal(revised.rule.createdAt, clock.now());
  assert.equal(revised.rule.updatedAt, clock.now());
  // v1 stays immutable and both versions remain listed.
  assert.deepEqual(engine.rules().filter((rule) => rule.ruleId === 'qc-range').map((rule) => rule.version), [1, 2]);
  assert.equal(engine.latestRules().find((rule) => rule.ruleId === 'qc-range')!.version, 2);
  // A config from another family is rejected.
  const mismatch = engine.reviseRule(DIEGO, 'qc-range', DEFAULT_RULE_CONFIGS['zero-value']);
  assert.ok(!mismatch.ok);
  assert.deepEqual(errorsOf(mismatch), ['config-family-mismatch']);
});

test('authoring is steward-gated: engineer denied capability, system-scoped commissioner denied scope', () => {
  const engine = createQcEngine({ world: buildTestWorld(), clock: () => NOW, fixtures: fixtureSeries() });
  const engineer = engine.authorRule(FATIMA, { ruleId: 'qc-x', family: 'range' });
  assert.ok(!engineer.ok && 'denied' in engineer, JSON.stringify(engineer));
  assert.equal(engineer.denied.status, 403);
  assert.equal(engineer.denied.reason, 'DENY_CAPABILITY_NOT_GRANTED', 'engineer operational verbs never satisfy review-data');
  const commissioner = engine.authorRule(CODY, { ruleId: 'qc-x', family: 'range' });
  assert.ok(!commissioner.ok && 'denied' in commissioner);
  assert.equal(commissioner.denied.status, 403);
  assert.equal(commissioner.denied.reason, 'DENY_OUT_OF_SCOPE', 'QC rules are program-level: a Bear-system review-data grant does not cover them');
  assert.equal(engine.rules().length, 0);
  // Validation errors for the steward: bad id, unknown family.
  const bad = engine.authorRule(DIEGO, { ruleId: 'Not-A-Id', family: 'nonsense' });
  assert.ok(!bad.ok);
  assert.deepEqual(errorsOf(bad), ['bad-rule-id', 'unknown-family']);
});

test('test runs hit the golden counts and advance draft -> test; promote then succeeds and is steward-only', () => {
  const clock = advancingClock();
  const engine = createQcEngine({ world: buildTestWorld(), clock: clock.clock, fixtures: fixtureSeries() });
  seedFiveRules(engine);

  // FR-015: no promotion without a prior successful fixture test run.
  const premature = engine.promoteRule(DIEGO, 'qc-range');
  assert.ok(!premature.ok);
  assert.deepEqual(errorsOf(premature), ['test-run-required']);

  for (const family of RULE_FAMILIES) {
    clock.advanceMinutes(1);
    const run = engine.testRule(DIEGO, DEFAULT_RULE_IDS[family]);
    assert.ok(run.ok, JSON.stringify(run));
    assert.equal(run.run.kind, 'test');
    assert.equal(run.run.results.length, 1);
    assert.equal(run.run.results[0]!.status, 'success');
    assert.equal(run.run.results[0]!.violationCount, GOLDEN_COUNTS[family], family);
    assert.equal(run.rule.status, 'test', 'a successful fixture test advances the lifecycle');
  }

  // Promotion: steward succeeds, engineer denied, double promotion is an error.
  const promoted = engine.promoteRule(DIEGO, 'qc-zero-value');
  assert.ok(promoted.ok, JSON.stringify(promoted));
  assert.equal(promoted.rule.status, 'promoted');
  const again = engine.promoteRule(DIEGO, 'qc-zero-value');
  assert.ok(!again.ok);
  assert.deepEqual(errorsOf(again), ['already-promoted']);
  const engineerPromote = engine.promoteRule(FATIMA, 'qc-range');
  assert.ok(!engineerPromote.ok && 'denied' in engineerPromote);
  assert.equal(engineerPromote.denied.status, 403);
  // The promote precondition consults run history: lastSuccessfulTest resolves.
  assert.ok(engine.lastSuccessfulTest('qc-range', 1));
  assert.equal(engine.lastSuccessfulTest('qc-range', 2), null);
  const unknown = engine.promoteRule(DIEGO, 'qc-ghost');
  assert.ok(!unknown.ok);
  assert.deepEqual(errorsOf(unknown), ['unknown-rule']);
});

test('a THROWING rule records a failed test run, stays unpromotable and never blocks the other rules', () => {
  const clock = advancingClock();
  // Injectable evaluator that can be flipped to throw (isolation probe).
  let throwNow = false;
  const evaluators: Record<string, RuleEvaluator> = {
    'qc-range': (series, rule) => {
      if (throwNow) throw new Error('injected range evaluator crash');
      return evaluate(series, rule);
    },
  };
  const engine = createQcEngine({ world: buildTestWorld(), clock: clock.clock, fixtures: fixtureSeries(), evaluators });
  seedFiveRules(engine);

  // The test run of the throwing rule FAILS in isolation; its own result
  // records the error and the rule stays draft.
  throwNow = true;
  const failedTest = engine.testRule(DIEGO, 'qc-range');
  assert.ok(failedTest.ok, 'the run itself completes; only the rule failed');
  assert.equal(failedTest.run.results[0]!.status, 'failed');
  assert.equal(failedTest.run.results[0]!.violationCount, 0);
  assert.match(failedTest.run.results[0]!.error!, /injected range evaluator crash/);
  assert.equal(failedTest.rule.status, 'draft', 'a failed fixture test does not advance the lifecycle');

  // A failed test run does NOT satisfy the promote precondition.
  const promoteAfterFailure = engine.promoteRule(DIEGO, 'qc-range');
  assert.ok(!promoteAfterFailure.ok);
  assert.deepEqual(errorsOf(promoteAfterFailure), ['test-run-required']);

  // Every OTHER rule can still be tested and promoted while qc-range throws.
  for (const family of RULE_FAMILIES.filter((candidate) => candidate !== 'range')) {
    const run = engine.testRule(DIEGO, DEFAULT_RULE_IDS[family]);
    assert.ok(run.ok && run.run.results[0]!.status === 'success', family);
    const promoted = engine.promoteRule(DIEGO, DEFAULT_RULE_IDS[family]);
    assert.ok(promoted.ok, family);
  }

  // qc-range is still draft, so monitoring covers the four promoted rules -
  // all four succeed despite the throwing evaluator being registered.
  const monitoring = engine.runMonitoring('scheduler');
  assert.equal(monitoring.kind, 'monitoring');
  assert.equal(monitoring.results.length, 4);
  assert.ok(monitoring.results.every((result) => result.status === 'success'));

  // Promote qc-range with a healthy evaluator, re-enable the crash, and run
  // monitoring again: the promoted rule fails IN ISOLATION while the other
  // four keep succeeding (one failing monitoring task stops nobody).
  throwNow = false;
  assert.ok(engine.testRule(DIEGO, 'qc-range').ok);
  assert.ok(engine.promoteRule(DIEGO, 'qc-range').ok);
  throwNow = true;
  const isolated = engine.runMonitoring('scheduler');
  assert.equal(isolated.results.length, 5);
  const rangeResult = isolated.results.find((result) => result.ruleId === 'qc-range')!;
  assert.equal(rangeResult.status, 'failed');
  assert.match(rangeResult.error!, /injected range evaluator crash/);
  for (const result of isolated.results.filter((candidate) => candidate.ruleId !== 'qc-range')) {
    assert.equal(result.status, 'success', `${result.ruleId} must not be stopped by the failing rule`);
    assert.equal(result.violationCount, GOLDEN_COUNTS[result.ruleId.replace('qc-', '') as QcRuleFamily]);
  }
});

test('run history records run ids, rule versions, counts and failures deterministically', () => {
  const clock = advancingClock();
  const engine = createQcEngine({ world: buildTestWorld(), clock: clock.clock, fixtures: fixtureSeries() });
  seedFiveRules(engine);
  assert.equal(engine.runHistory().length, 0);
  clock.advanceMinutes(1);
  engine.testRule(DIEGO, 'qc-range');
  clock.advanceMinutes(1);
  engine.testRule(DIEGO, 'qc-zero-value');
  clock.advanceMinutes(1);
  engine.promoteRule(DIEGO, 'qc-range');
  clock.advanceMinutes(1);
  engine.promoteRule(DIEGO, 'qc-zero-value');
  clock.advanceMinutes(1);
  engine.runMonitoring('nightly');

  const history = engine.runHistory();
  assert.deepEqual(
    history.map((run) => run.runId),
    ['qcrun-000001', 'qcrun-000002', 'qcrun-000003'],
  );
  assert.deepEqual(
    history.map((run) => run.kind),
    ['test', 'test', 'monitoring'],
  );
  // Monitoring carries the trigger and per-rule versions+counts.
  const monitoring = history[2]!;
  assert.equal(monitoring.triggeredBy, 'nightly');
  assert.deepEqual(
    monitoring.results.map((result) => `${result.ruleId} v${result.ruleVersion}:${result.violationCount}`),
    ['qc-range v1:3', 'qc-zero-value v1:1'],
  );
  assert.ok(monitoring.results.every((result) => result.error === null));
});
