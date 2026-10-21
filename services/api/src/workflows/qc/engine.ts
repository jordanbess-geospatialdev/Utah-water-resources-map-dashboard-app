/**
 * QC rule-run orchestration (WD-013; FR-015).
 *
 * Responsibilities, per the requirement "each rule stores author and update
 * time, runs independently, and can be tested before promotion":
 *
 * - AUTHORING: rules are versioned (author, createdAt, updatedAt, status
 *   draft/test/promoted). Authoring and revising are STEWARD-ONLY governance
 *   mutations: every call goes through the WD-014 steward gate
 *   (gateAct -> @utah-water/policy evaluate, action `review-data` against a
 *   statewide QC governance object), never a role-label check. A system-
 * scoped review-data holder (e.g. the Bear River commissioner) is correctly
 * DENIED out of scope: QC rules are program-level configurations.
 * - ISOLATED EXECUTION: every rule evaluation runs inside its own try/catch.
 *   A rule that throws records a FAILED run result (rule id, version, error
 *   message) and NEVER stops the other rules in the same run - tested with an
 *   injected throwing evaluator. Evaluator overrides are injectable per
 *   rule id (tests, alternate implementations); the default is the pure
 *   evaluate() from rules.ts.
 * - TEST BEFORE PROMOTION: testRule runs one rule version against the
 *   fixture series and records a `test` run; only a rule version with a
 *   prior SUCCESSFUL test run against those fixtures can be promoted
 *   (promoteRule returns `test-run-required` otherwise). Promotion is
 *   steward-only through the same policy gate.
 * - RUN HISTORY: every run (test or monitoring) is recorded with run id,
 *   rule versions, per-rule violation counts and failures.
 *
 * Purity: no clock reads (injected clock), no I/O, no network. Determinism
 * is asserted by test/determinism.test.ts (identical inputs -> identical
 * history serialization).
 */
import type { PolicyWorld } from '../../../../../packages/policy/src/index.ts';
import { gateAct, governanceObject, instantIso, withExtraObjects, type GateOutcome, type PolicyEvaluator } from '../stewardship/gate.ts';
import {
  DEFAULT_RULE_CONFIGS,
  RULE_FAMILIES,
  evaluate,
  type QcRuleConfig,
  type QcRuleFamily,
  type QcRuleStatus,
  type QcRuleVersion,
  type QcSeries,
  type QcViolation,
} from './rules.ts';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** A rule evaluator: series + rule version -> violations. May throw; engine.ts contains it. */
export type RuleEvaluator = (series: QcSeries, rule: QcRuleVersion) => readonly QcViolation[];

export type RuleRunKind = 'test' | 'monitoring';

export interface RuleRunResult {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly status: 'success' | 'failed';
  readonly violationCount: number;
  readonly error: string | null;
}

export interface RuleRunRecord {
  readonly runId: string;
  readonly kind: RuleRunKind;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly triggeredBy: string | null;
  readonly results: readonly RuleRunResult[];
}

export type MutationDenial = { readonly ok: false; readonly denied: GateOutcome & { ok: false } };

export type AuthorErrorCode = 'bad-rule-id' | 'duplicate-rule-id' | 'unknown-family' | 'config-family-mismatch';

export interface QcEngineDeps {
  readonly world: PolicyWorld;
  /** REQUIRED injected clock (no hidden Date.now reads; determinism is tested). */
  readonly clock: () => Date | string;
  readonly policy?: PolicyEvaluator;
  /** The fixture series test runs execute against (FR-015 "tested before promotion"). */
  readonly fixtures: readonly QcSeries[];
  /** Injectable per-rule evaluators (tests inject a THROWING rule for isolation). */
  readonly evaluators?: Readonly<Record<string, RuleEvaluator>>;
}

export const RULE_ID_PATTERN = /^qc-[a-z0-9][a-z0-9-]{0,48}$/;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface QcEngine {
  /** Steward-only: author a new rule (v1 draft) or seed the five reviewed defaults. */
  authorRule(principalId: string | null, input: { readonly ruleId: string; readonly family: QcRuleFamily | string; readonly config?: QcRuleConfig; readonly notes?: string }): { ok: true; rule: QcRuleVersion } | { ok: false; errors: readonly AuthorErrorCode[] } | MutationDenial;
  /** Steward-only: append a new DRAFT version of an existing rule (prior versions stay immutable). */
  reviseRule(principalId: string | null, ruleId: string, config: QcRuleConfig, notes?: string): { ok: true; rule: QcRuleVersion } | { ok: false; errors: readonly ('unknown-rule' | 'config-family-mismatch')[] } | MutationDenial;
  /** Run ONE rule version against the fixtures (isolated try/catch); success promotes draft -> test status. */
  testRule(principalId: string | null, ruleId: string, version?: number): { ok: true; run: RuleRunRecord; rule: QcRuleVersion } | { ok: false; errors: readonly 'unknown-rule'[] } | MutationDenial;
  /** Steward-only promotion; requires a prior SUCCESSFUL test run of this version against the fixtures. */
  promoteRule(principalId: string | null, ruleId: string, version?: number): { ok: true; rule: QcRuleVersion } | { ok: false; errors: readonly ('unknown-rule' | 'unknown-version' | 'test-run-required' | 'already-promoted')[] } | MutationDenial;
  /** System task: run every non-draft rule version independently (one throwing rule never stops the others). */
  runMonitoring(triggeredBy?: string): RuleRunRecord;
  /** All rule versions, deterministic order (ruleId, version). */
  rules(): readonly QcRuleVersion[];
  /** Latest version of each rule. */
  latestRules(): readonly QcRuleVersion[];
  runHistory(): readonly RuleRunRecord[];
  /** The latest successful TEST run result for one rule version (the promote precondition). */
  lastSuccessfulTest(ruleId: string, version: number): RuleRunResult | null;
}

function qcRootObject() {
  return governanceObject({ id: 'qc-rules:root', kind: 'report' });
}

function ruleObject(ruleId: string) {
  return governanceObject({ id: `qcrule:${ruleId}`, kind: 'report' });
}

export function createQcEngine(deps: QcEngineDeps): QcEngine {
  const clock = deps.clock;
  const policy = deps.policy;
  const rules: QcRuleVersion[] = [];
  const runs: RuleRunRecord[] = [];
  let runCounter = 0;

  const now = (): string => instantIso(clock());
  const nextRunId = (): string => `qcrun-${String((runCounter += 1)).padStart(6, '0')}`;
  /** Gate a governance action against a QC object (root or rule), materialized into the world. */
  const gate = (principalId: string | null, action: string, objectId: string): GateOutcome =>
    gateAct(
      { world: withExtraObjects(deps.world, [governanceObject({ id: objectId, kind: 'report' })]), clock, policy },
      principalId,
      action,
      { kind: 'report', id: objectId },
    );

  const versionsOf = (ruleId: string): QcRuleVersion[] => rules.filter((rule) => rule.ruleId === ruleId);
  const latestOf = (ruleId: string): QcRuleVersion | null => versionsOf(ruleId).at(-1) ?? null;

  const evaluatorFor = (rule: QcRuleVersion): RuleEvaluator => deps.evaluators?.[rule.ruleId] ?? evaluate;

  /**
   * Isolated execution of one rule over the fixture series. EVERY rule runs
   * inside its own try/catch: a throwing rule becomes a failed result and
   * never propagates to the caller or the sibling rules.
   */
  const runRuleIsolated = (rule: QcRuleVersion): RuleRunResult => {
    try {
      const violations: QcViolation[] = [];
      for (const series of deps.fixtures) violations.push(...evaluatorFor(rule)(series, rule));
      return { ruleId: rule.ruleId, ruleVersion: rule.version, status: 'success', violationCount: violations.length, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ruleId: rule.ruleId, ruleVersion: rule.version, status: 'failed', violationCount: 0, error: `rule ${rule.ruleId} v${rule.version} threw: ${message}` };
    }
  };

  const recordRun = (kind: RuleRunKind, triggeredBy: string | null, results: readonly RuleRunResult[]): RuleRunRecord => {
    const startedAt = now();
    const record: RuleRunRecord = Object.freeze({
      runId: nextRunId(),
      kind,
      startedAt,
      finishedAt: now(),
      triggeredBy,
      results: Object.freeze([...results]),
    });
    runs.push(record);
    return record;
  };

  const withStatus = (rule: QcRuleVersion, status: QcRuleStatus): QcRuleVersion => Object.freeze({ ...rule, status, updatedAt: now() });

  const replaceRule = (updated: QcRuleVersion): void => {
    const index = rules.findIndex((candidate) => candidate.ruleId === updated.ruleId && candidate.version === updated.version);
    if (index >= 0) rules[index] = updated;
  };

  return {
    authorRule(principalId, input) {
      const verdict = gate(principalId, 'review-data', qcRootObject().id);
      if (!verdict.ok) return { ok: false, denied: verdict };
      const errors: AuthorErrorCode[] = [];
      if (!RULE_ID_PATTERN.test(input?.ruleId ?? '')) errors.push('bad-rule-id');
      if (!(RULE_FAMILIES as readonly string[]).includes(input?.family)) errors.push('unknown-family');
      if (input?.config !== undefined && input.config.family !== input.family) errors.push('config-family-mismatch');
      if (rules.some((rule) => rule.ruleId === input?.ruleId)) errors.push('duplicate-rule-id');
      if (errors.length > 0) return { ok: false, errors };

      const family = input.family as QcRuleFamily;
      const rule: QcRuleVersion = Object.freeze({
        ruleId: input.ruleId,
        family,
        version: 1,
        status: 'draft',
        author: principalId ?? '',
        createdAt: now(),
        updatedAt: now(),
        config: input.config ?? DEFAULT_RULE_CONFIGS[family],
        notes: input.notes ?? null,
      });
      rules.push(rule);
      return { ok: true, rule };
    },

    reviseRule(principalId, ruleId, config, notes) {
      const existing = versionsOf(ruleId);
      const verdict = gate(principalId, 'review-data', ruleObject(ruleId).id);
      if (!verdict.ok) return { ok: false, denied: verdict };
      const errors: ('unknown-rule' | 'config-family-mismatch')[] = [];
      if (existing.length === 0) errors.push('unknown-rule');
      if (existing.length > 0 && config.family !== existing[0]!.family) errors.push('config-family-mismatch');
      if (errors.length > 0) return { ok: false, errors };

      const base = existing[0]!;
      const rule: QcRuleVersion = Object.freeze({
        ruleId,
        family: base.family,
        version: existing.length + 1,
        status: 'draft',
        author: principalId ?? '',
        createdAt: now(),
        updatedAt: now(),
        config,
        notes: notes ?? null,
      });
      rules.push(rule);
      return { ok: true, rule };
    },

    testRule(principalId, ruleId, version) {
      const target = version === undefined ? latestOf(ruleId) : versionsOf(ruleId).find((candidate) => candidate.version === version) ?? null;
      const verdict = gate(principalId, 'review-data', ruleObject(ruleId).id);
      if (!verdict.ok) return { ok: false, denied: verdict };
      if (!target) return { ok: false, errors: ['unknown-rule'] as const };

      const result = runRuleIsolated(target);
      const run = recordRun('test', principalId, [result]);
      let rule = target;
      if (result.status === 'success' && target.status === 'draft') {
        rule = withStatus(target, 'test'); // a successful fixture test advances draft -> test
        replaceRule(rule);
      }
      return { ok: true, run, rule };
    },

    promoteRule(principalId, ruleId, version) {
      const target = version === undefined ? latestOf(ruleId) : versionsOf(ruleId).find((candidate) => candidate.version === version) ?? null;
      const verdict = gate(principalId, 'review-data', ruleObject(ruleId).id);
      if (!verdict.ok) return { ok: false, denied: verdict };
      if (!target) return { ok: false, errors: ['unknown-rule'] as const };
      if (target.status === 'promoted') return { ok: false, errors: ['already-promoted'] as const };
      // FR-015: a version may only be promoted after a SUCCESSFUL test run
      // against the fixtures. A failed test run (throwing evaluator) leaves
      // the version unpromotable.
      if (lastSuccessfulTestImpl(runs, ruleId, target.version) === null) return { ok: false, errors: ['test-run-required'] as const };

      const promoted = Object.freeze({ ...withStatus(target, 'promoted') });
      replaceRule(promoted);
      return { ok: true, rule: promoted };
    },

    runMonitoring(triggeredBy) {
      const targets = [...new Map(rules.filter((rule) => rule.status !== 'draft').map((rule) => [rule.ruleId, rule])).values()]
        .sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1));
      const results = targets.map((rule) => runRuleIsolated(rule));
      return recordRun('monitoring', triggeredBy ?? null, results);
    },

    rules() {
      return [...rules].sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : a.version - b.version));
    },

    latestRules() {
      return [...new Map(rules.map((rule) => [rule.ruleId, rule])).values()].sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1));
    },

    runHistory() {
      return [...runs];
    },

    lastSuccessfulTest(ruleId, version) {
      return lastSuccessfulTestImpl(runs, ruleId, version);
    },
  };
}

function lastSuccessfulTestImpl(runs: readonly RuleRunRecord[], ruleId: string, version: number): RuleRunResult | null {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (run.kind !== 'test') continue;
    const result = run.results.find((candidate) => candidate.ruleId === ruleId && candidate.ruleVersion === version);
    if (result && result.status === 'success') return result;
  }
  return null;
}
