/**
 * Steward console view-model tests (WD-014; FR-011..FR-014, FR-017;
 * verification rows T-02/T-03).
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/stewardship/consoleModel.test.ts
 *
 * (Import pattern per apps/web/tests/adapters.test.ts: computed specifiers
 * for node --test --experimental-strip-types, type-only imports for tsc.)
 *
 * Three layers:
 * 1. PURE view-model derivations (digest preview assembly with failed tasks
 *    first, health rollups that never merge connection status with task
 *    failures, vocabulary change lists, usage tables with the FR-017 note).
 * 2. DEMO-PORT CROSS-CHECK: the demo evaluator verdict for the console gate
 *    is compared decision-by-decision against the REAL @utah-water/policy
 *    engine for every fixture persona (the operations-feature pattern).
 * 3. SERVER PARITY: the REAL digest builder
 *    (services/api/src/workflows/stewardship/connections.ts, loaded at
 *    runtime outside the web tsc program) feeds assembleDigestPreview
 *    through the structural mirror types - the demo data cannot silently
 *    diverge from the server model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

import type { HealthRowView, PolicyDecisionMirror, PolicyEvaluatorMirror, PolicyWorldMirror, WeekdayDigestView } from './consoleModel';

// Extensionless src imports under node --test (see tests/ts-resolve-hook.mjs).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const modelPath = './consoleModel.ts';
const model: typeof import('./consoleModel') = await import(modelPath);
const demoPath = './demoData.ts';
const demoModule: typeof import('./demoData') = await import(demoPath);

const { assembleDigestPreview, assignmentRows, healthRollup, healthStatusText, ingestionQueue, connectionTestLabel, stewardConsoleAccess, termStatusBadge, usageTables, vocabularyChangeList, vocabularyRows } = model;
const { demoConsoleData, demoPolicyEvaluator, demoPolicyPort, demoPolicyWorld } = demoModule;

// ---------------------------------------------------------------------------
// Layer 1: pure view models
// ---------------------------------------------------------------------------

const demo = demoConsoleData();
const mondayDigest = demo.digests['2026-03-09']!;

test('digest preview lists FAILED TASKS first, then connection incidents with their filtered task-list link', () => {
  const lines = assembleDigestPreview(mondayDigest, (systemId) => (systemId === 'sys-bear-river' ? 'Bear River' : systemId));
  assert.equal(lines[0]!.kind, 'header');
  assert.match(lines[0]!.text, /Monday digest 2026-03-09 - covers 2026-03-06 through 2026-03-08 \(the full weekend interval is included here, exactly once\)/);
  const taskLines = lines.filter((line) => line.kind === 'task');
  const connectionLines = lines.filter((line) => line.kind === 'connection');
  assert.equal(taskLines.length, 2);
  assert.equal(connectionLines.length, 2);
  // Tasks come before connection incidents in the line order.
  assert.ok(lines.findIndex((line) => line.kind === 'task') < lines.findIndex((line) => line.kind === 'connection'));
  assert.match(taskLines[0]!.text, /Task qc-task-0301 failed/);
  assert.match(connectionLines[0]!.text, /→ filtered tasks: connection=ing-000001/);
  const footer = lines.at(-1)!;
  assert.match(footer.text, /2 failed tasks, 2 connection incidents/);
  assert.match(footer.text, /1 duplicate incident record dropped/);
});

test('a weekend digest date renders the not-issued notice with the weekday rule', () => {
  const saturday = demo.digests['2026-03-07']!;
  const lines = assembleDigestPreview(saturday, () => '?');
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.kind, 'notice');
  assert.match(lines[0]!.text, /No digest issues on Saturday 2026-03-07/);
  assert.ok(model.DIGEST_RULES.some((rule) => rule.includes('weekend dates (Saturday, Sunday) issue nothing')));
  assert.ok(model.DIGEST_RULES.some((rule) => rule.includes('exactly once')));
});

test('health rollup counts statuses from staging tests only and reports failed tasks separately', () => {
  const rollup = healthRollup(demo.healthRows);
  assert.equal(rollup.total, 2);
  assert.deepEqual(rollup.byStatus, { healthy: 1, 'auth-failure': 1, timeout: 0, untested: 0 });
  assert.equal(rollup.totalFailedTasks, 4, 'task failures are a separate total - never merged into status');
  // Attention order: the failing connection first, then the healthy one
  // (even though the healthy one carries MORE failed tasks).
  assert.deepEqual(rollup.attentionOrder.map((row) => row.connectionId), ['ing-000001', 'ing-000002']);
  // Status text always carries text + shape, never color alone.
  assert.equal(healthStatusText('healthy'), '✓ Healthy');
  assert.equal(healthStatusText('auth-failure'), '✕ Auth failure (connection)');
});

test('vocabulary change list renders actor and version stamp; retired terms keep visible history', () => {
  const rows = vocabularyChangeList(demo.vocabularyChanges, (id) => (id === 'principal-diego-steward' ? 'Diego Ruiz' : id));
  assert.deepEqual(
    rows.map((row) => `${row.text} by ${row.actorLabel} [${row.versionLabel}]`),
    [
      'Created qualifier "Estimated" (estimated) by Diego Ruiz [registry v2]',
      'Retired qualifier "Ice affected" (ice-affected) by Diego Ruiz [registry v3]',
    ],
  );
  const retired = vocabularyRows(demo.terms, 'qualifier').find((term) => term.id === 'ice-affected')!;
  assert.equal(retired.status, 'retired');
  assert.equal(termStatusBadge(retired.status), '○ Retired (history preserved)');
  // Deterministic ordering: kind order then label.
  assert.deepEqual(vocabularyRows(demo.terms).map((term) => term.kind).slice(0, 4), ['property', 'property', 'property', 'unit']);
});

test('ingestion queue separates pending engineer requests from configured sites and labels simulated tests', () => {
  const queue = ingestionQueue(demo.configs, demo.providers);
  assert.equal(queue.providers, 2);
  assert.equal(queue.configured, 2);
  assert.deepEqual(queue.pendingRequests.map((config) => config.id), ['ing-000003']);
  assert.equal(queue.pendingRequests[0]!.requestedBy, 'principal-marco-engineer');
  assert.match(connectionTestLabel(demo.configs[0]!), /✕ auth failure at 2026-03-09T10:00:00Z \(40 ms, simulated staging\)/);
  assert.equal(connectionTestLabel(demo.configs[2]!), 'Not tested');
  // Secrets never render: the demo params carry the redacted marker.
  assert.equal(demo.configs[0]!.params['api-key'], '[redacted]');
});

test('usage tables carry counts only plus the FR-017 exclusion note', () => {
  const tables = usageTables(demo.usage);
  assert.equal(tables.dayRows.length, 5);
  assert.equal(tables.dayRows[0]!.label, '2026-03-06');
  assert.equal(tables.dayRows[0]!.total, 3);
  assert.equal(tables.dayRows[0]!.share, 1, 'share is relative to the maximum day total');
  assert.equal(tables.monthRows[0]!.total, 10);
  assert.equal(tables.yearRows[0]!.total, 10);
  assert.equal(tables.excludedEvents, 3);
  assert.match(tables.exclusionNote, /credentials, sensitive query content and internal records are excluded/);
  assert.equal(tables.exclusionNote, model.FR017_EXCLUSION_NOTE);
  // No identifiers anywhere in the table model (the note itself names the
  // excluded KINDS, never any content).
  const serialized = JSON.stringify(tables);
  assert.ok(!serialized.includes('principal-'));
  assert.ok(!serialized.includes('discharge'));
  assert.ok(!serialized.includes('sta-'));
});

test('assignment rows expose validity windows, delegation expiry and grant versions', () => {
  const world = demoPolicyWorld();
  const rows = assignmentRows(world.assignments, (id) => (id === 'principal-ana-deputy' ? 'Ana Whitehorse' : id));
  const deputy = rows.find((row) => row.key === 'ent-deputy-ana')!;
  assert.equal(deputy.role, 'deputy');
  assert.match(deputy.windowLabel, /2026-03-01T07:00:00Z → 2026-06-30T23:59:59Z/);
  assert.match(deputy.delegationLabel!, /Delegated by .* until 2026-06-30T23:59:59Z/);
  const steward = rows.find((row) => row.key === 'ent-steward-diego')!;
  assert.equal(steward.scopeLabel, 'Statewide');
  assert.equal(steward.grantVersion, 4);
});

// ---------------------------------------------------------------------------
// Layer 2: demo-port cross-check against the REAL policy engine
// ---------------------------------------------------------------------------

const policyPath = '../../../../../packages/policy/src/index.ts';
const policy = (await import(policyPath)) as {
  buildWorld: (input: Record<string, unknown>) => PolicyWorldMirror;
  evaluate: PolicyEvaluatorMirror;
};

const fixturesPath = '../../../../../fixtures/contracts/';
const readFixture = (name: string): object => JSON.parse(readFileSync(new URL(fixturesPath + name, import.meta.url), 'utf8')) as object;

const personas: ReadonlyArray<{ id: string | null; label: string }> = [
  { id: 'principal-diego-steward', label: 'Diego (steward)' },
  { id: 'principal-fatima-engineer', label: 'Fatima (engineer)' },
  { id: 'principal-priya-engineer', label: 'Priya (engineer)' },
  { id: 'principal-cody-commissioner', label: 'Cody (commissioner)' },
  { id: 'principal-ana-deputy', label: 'Ana (deputy)' },
  { id: 'principal-sarah-researcher', label: 'Sarah (researcher)' },
  { id: null, label: 'anonymous' },
];

test('console access: demo evaluator matches the REAL engine for every fixture persona (steward-only)', () => {
  const realWorld = policy.buildWorld({
    principals: readFixture('principals.json'),
    stations: readFixture('stations.json'),
    // The governance root object the console gate evaluates against (the
    // server registry adds it via withExtraObjects; here explicitly).
    extraObjects: [
      { id: 'vocab:root', kind: 'vocabulary', systemId: null, ownerOrganizationId: null, stationId: null, datasetId: null, ownerPrincipalId: null, targetObjectId: null, visibility: 'internal', status: 'active', fields: {} },
    ],
  });
  for (const persona of personas) {
    for (const at of ['2026-03-09T07:00:00Z', '2026-01-01T00:00:00Z']) {
      const real = policy.evaluate(
        { principal: persona.id === null ? null : realWorld.principals[persona.id]!, action: 'manage-vocabulary', object: { kind: 'vocabulary', id: 'vocab:root' } },
        realWorld,
        at,
      );
      const demoWorld = demoPolicyWorld();
      const demoDecision: PolicyDecisionMirror = demoPolicyEvaluator(
        { principal: persona.id === null ? null : demoWorld.principals[persona.id]!, action: 'manage-vocabulary', object: { kind: 'vocabulary', id: 'vocab:root' } },
        demoWorld,
        at,
      );
      assert.equal(demoDecision.effect, real.effect, `${persona.label} at ${at}: demo ${demoDecision.reason} vs real ${real.reason}`);
    }
  }
});

test('stewardConsoleAccess: steward allowed; every other persona denied 403; anonymous denied 401', () => {
  const port = demoPolicyPort();
  const access = (principalId: string | null) => stewardConsoleAccess({ principalId, world: port.world, policy: port.evaluate, now: port.now });
  assert.deepEqual(access('principal-diego-steward'), { allowed: true, reason: null, status: null, message: '' });
  for (const persona of personas.slice(1, 6)) {
    const denied = access(persona.id);
    assert.equal(denied.allowed, false, persona.label);
    assert.equal(denied.status, 403, persona.label);
    assert.match(denied.message, /restricted to the statewide data steward/);
  }
  const anonymous = access(null);
  assert.equal(anonymous.allowed, false);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.message, /requires an authenticated session/);
  // Unknown ids are identity failures too (401, never a probe oracle).
  assert.equal(access('principal-ghost').status, 401);
});

// ---------------------------------------------------------------------------
// Layer 3: server parity - the REAL digest builder feeds the preview
// ---------------------------------------------------------------------------

const connectionsPath = '../../../../../services/api/src/workflows/stewardship/connections.ts';
const serverConnections = (await import(connectionsPath)) as {
  buildWeekdayDigest: (input: Record<string, unknown>) => WeekdayDigestView;
  connectionsFromConfigs: (configs: readonly unknown[]) => readonly HealthRowView[];
  systemObjects: (systemIds: readonly string[]) => readonly object[];
};

test('the REAL server digest builder output renders through the view models (mirror parity, Fatima scope)', () => {
  const realWorld = policy.buildWorld({
    principals: readFixture('principals.json'),
    stations: readFixture('stations.json'),
    extraObjects: serverConnections.systemObjects(['sys-bear-river', 'sys-weber-river']),
  });
  const incidents = [
    { id: 'inc-sat-conn', kind: 'connection', connectionId: 'ing-000001', taskId: null, systemId: 'sys-bear-river', detectedAt: '2026-03-07T16:00:00Z', summary: 'Saturday auth failure (Bear)' },
    { id: 'inc-sat-conn', kind: 'connection', connectionId: 'ing-000001', taskId: null, systemId: 'sys-bear-river', detectedAt: '2026-03-07T16:05:00Z', summary: 'duplicate record' },
    { id: 'inc-sun-task', kind: 'task', connectionId: 'ing-000002', taskId: 'qc-task-0301', systemId: 'sys-bear-river', detectedAt: '2026-03-08T15:00:00Z', summary: 'Sunday rate-of-change failure' },
    { id: 'inc-sun-conn', kind: 'connection', connectionId: 'ing-000003', taskId: null, systemId: 'sys-weber-river', detectedAt: '2026-03-08T21:00:00Z', summary: 'Sunday Weber timeout' },
  ];
  const configs = [
    { id: 'ing-000001', providerId: 'prov-dwri-telemetry', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', params: {}, status: 'configured', requestedBy: 'x', requestedAt: 't', promotedBy: 'x', promotedAt: 't', lastConnectionTest: { at: '2026-03-06T12:00:00Z', outcome: 'auth-failure', latencyMs: 40 } },
    { id: 'ing-000002', providerId: 'prov-dwri-telemetry', stationId: 'sta-bear-lake-diagnostic', systemId: 'sys-bear-river', params: {}, status: 'configured', requestedBy: 'x', requestedAt: 't', promotedBy: 'x', promotedAt: 't', lastConnectionTest: { at: '2026-03-06T12:00:00Z', outcome: 'success', latencyMs: 120 } },
    { id: 'ing-000003', providerId: 'prov-dwri-telemetry', stationId: 'sta-ogden-valley-proposed', systemId: 'sys-weber-river', params: {}, status: 'configured', requestedBy: 'x', requestedAt: 't', promotedBy: 'x', promotedAt: 't', lastConnectionTest: { at: '2026-03-06T12:00:00Z', outcome: 'timeout', latencyMs: 5000 } },
  ];
  const connections = serverConnections.connectionsFromConfigs(configs);

  // Monday digest for Fatima (Bear-scoped): the Weber incident is omitted, the duplicate deduped.
  const monday = serverConnections.buildWeekdayDigest({
    digestDate: '2026-03-09',
    recipientId: 'principal-fatima-engineer',
    incidents,
    connections,
    world: realWorld,
    evaluatedAt: '2026-03-10T14:00:00Z',
  });
  assert.equal(monday.issued, true);
  assert.deepEqual(monday.coverageDays, ['2026-03-06', '2026-03-07', '2026-03-08']);
  assert.deepEqual(monday.taskFailures.map((task) => task.taskId), ['qc-task-0301']);
  assert.deepEqual(monday.connectionIncidents.map((entry) => entry.incidentId), ['inc-sat-conn']);
  assert.equal(monday.counts.duplicatesDropped, 1);
  assert.equal(monday.counts.omittedForScope, 1);

  // The server output flows through the console view models unchanged.
  const lines = assembleDigestPreview(monday, () => 'system');
  assert.match(lines[0]!.text, /Monday digest 2026-03-09/);
  assert.ok(lines.some((line) => line.kind === 'task' && line.text.includes('qc-task-0301')));
  assert.ok(lines.some((line) => line.kind === 'connection' && line.text.includes('connection=ing-000001')));

  // Weekend dates never issue, on the real builder too.
  const saturday = serverConnections.buildWeekdayDigest({ digestDate: '2026-03-07', recipientId: 'principal-fatima-engineer', incidents, connections, world: realWorld });
  assert.equal(saturday.issued, false);
  assert.equal(assembleDigestPreview(saturday, () => '?').length, 1);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('determinism: demo bundle and view models are pure - built twice, deep-equal', () => {
  assert.deepEqual(demoConsoleData(), demoConsoleData());
  const build = () => ({
    preview: assembleDigestPreview(demo.digests['2026-03-09']!, () => 'system'),
    rollup: healthRollup(demo.healthRows),
    rows: vocabularyRows(demo.terms),
    usage: usageTables(demo.usage),
  });
  assert.deepEqual(build(), build());
});
