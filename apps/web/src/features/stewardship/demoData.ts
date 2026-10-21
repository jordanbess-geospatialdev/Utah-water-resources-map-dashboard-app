/**
 * Demo-only default bindings for the steward console (WD-014).
 *
 * !!! DEMO MIRROR !!! Exactly like features/operations/fixturePolicy.ts:
 * the browser has no policy engine wired yet (apps/web/tsconfig.json is
 * orchestrator-owned and cannot import the policy package sources - see
 * README.md), so this module provides
 *
 *  1. a fixture policy world mirror (principals + assignments from the
 *     frozen shell fixtures), and
 *  2. a DEMO evaluator that mirrors the engine ONLY for the console-access
 *     question (manage-vocabulary on the governance root object) - it is
 *     NOT a security boundary and is cross-checked decision-by-decision
 *     against the REAL engine for every fixture persona in
 *     consoleModel.test.ts, so the demo cannot silently diverge;
 *  3. a frozen demo data bundle mirroring the server-side fixture scenario
 *     the API suites pin (same weekend, same incidents, same aggregates).
 *
 * The one-line real wiring replaces 1+2 with buildWorld() + evaluate() and
 * 3 with the /admin endpoints; see README.md.
 */
import { entitlements, FIXTURE_CLOCK, users } from '../../shell/data/fixtures';
import type { EntitlementRecord, UserRecord } from '../../shell/data/types';
import type {
  GovernedTermView,
  HealthRowView,
  IngestionConfigView,
  PolicyAssignmentMirror,
  PolicyEvaluatorMirror,
  PolicyObjectMirror,
  PolicyPrincipalMirror,
  PolicyWorldMirror,
  ProviderDefinitionView,
  StewardConsoleData,
  UsageReportView,
  VocabularyChangeEventView,
  WeekdayDigestView,
} from './consoleModel';
import { CONSOLE_GATE_OBJECT } from './consoleModel';

// ---------------------------------------------------------------------------
// Fixture world mirror
// ---------------------------------------------------------------------------

function principalOf(user: UserRecord): PolicyPrincipalMirror {
  return { id: user.id, displayName: user.displayName, active: user.active === true, roles: [...user.roles] };
}

function assignmentOf(entitlement: EntitlementRecord): PolicyAssignmentMirror {
  // The shell entitlement type narrows status to the fixture states; the
  // contract schema also carries 'revoked' (same cast as operations'
  // fixturePolicy mirror).
  const status = entitlement.status as string;
  return {
    id: entitlement.id,
    principalId: entitlement.principalId,
    role: entitlement.role,
    capabilities: [...entitlement.capabilities],
    scope: { kind: entitlement.scopeType, id: entitlement.scopeId },
    effectiveAt: entitlement.effectiveAt,
    expiresAt: entitlement.expiresAt,
    status: status === 'revoked' ? 'revoked' : 'active',
    delegation: entitlement.delegation
      ? { effectiveAt: entitlement.delegation.effectiveAt, expiresAt: entitlement.delegation.expiresAt, delegatedBy: entitlement.delegation.delegatedBy }
      : null,
    grantedBy: entitlement.grantedBy,
    grantVersion: entitlement.grantVersion,
  };
}

/** The frozen fixture world mirror (principals + assignments; objects are added per evaluation). */
export function demoPolicyWorld(): PolicyWorldMirror {
  const principals: Record<string, PolicyPrincipalMirror> = {};
  for (const user of users) principals[user.id] = principalOf(user);
  return Object.freeze({
    principals: Object.freeze(principals),
    assignments: Object.freeze(entitlements.map(assignmentOf)),
    objects: Object.freeze({} as Record<string, PolicyObjectMirror>),
    assignmentVersion: entitlements.reduce((max, entitlement) => Math.max(max, entitlement.grantVersion), 0),
  });
}

/**
 * DEMO evaluator for the console gate only (manage-vocabulary on the
 * governance root): mirrors allow_protected - authenticated, active
 * principal, a valid assignment whose capabilities satisfy the action
 * (manage-vocabulary or statewide-administration) and whose scope covers
 * the statewide-anchored governance object; half-open validity windows,
 * revoked wins. Cross-checked against the real engine in the test suite.
 */
export const demoPolicyEvaluator: PolicyEvaluatorMirror = (request, world, now) => {
  const t = typeof now === 'string' ? Date.parse(now) : now.getTime();
  if (!request.principal) return { effect: 'deny', reason: 'DENY_ANONYMOUS' };
  const principal = world.principals[request.principal.id];
  if (!principal) return { effect: 'deny', reason: 'DENY_UNKNOWN_PRINCIPAL' };
  if (!principal.active) return { effect: 'deny', reason: 'DENY_PRINCIPAL_INACTIVE' };
  const satisfiers = new Set(['manage-vocabulary', 'statewide-administration']);
  for (const assignment of world.assignments) {
    if (assignment.principalId !== principal.id) continue;
    if (assignment.status === 'revoked') continue;
    if (Date.parse(assignment.effectiveAt) > t) continue;
    if (assignment.expiresAt !== null && t >= Date.parse(assignment.expiresAt)) continue;
    if (assignment.delegation) {
      if (Date.parse(assignment.delegation.effectiveAt) > t) continue;
      if (t >= Date.parse(assignment.delegation.expiresAt)) continue;
    }
    if (!assignment.capabilities.some((capability) => satisfiers.has(capability))) continue;
    // The governance root object anchors statewide: only statewide scopes cover it.
    if (request.object.id === CONSOLE_GATE_OBJECT.id && assignment.scope.kind !== 'statewide') continue;
    return { effect: 'allow', reason: 'ALLOW_PROTECTED' };
  }
  return { effect: 'deny', reason: 'DENY_CAPABILITY_NOT_GRANTED' };
};

/** The default demo binding (mirrors features/operations/fixturePolicyPort). */
export function demoPolicyPort(): { world: PolicyWorldMirror; evaluate: PolicyEvaluatorMirror; now: string } {
  return { world: demoPolicyWorld(), evaluate: demoPolicyEvaluator, now: FIXTURE_CLOCK };
}

// ---------------------------------------------------------------------------
// Frozen demo data (mirrors the API fixture scenario the suites pin)
// ---------------------------------------------------------------------------

const SEED_STAMP = '2025-07-01T00:00:00Z';

function seedTerm(id: string, kind: GovernedTermView['kind'], label: string, description: string, extra: Partial<GovernedTermView> = {}): GovernedTermView {
  return {
    id,
    kind,
    label,
    description,
    dimension: null,
    canonicalUnitId: null,
    status: 'active',
    registryVersion: 1,
    createdAt: SEED_STAMP,
    createdBy: 'fixture-seed',
    retiredAt: null,
    retiredBy: null,
    ...extra,
  };
}

/** Demo vocabulary: the frozen fixture set plus one steward-created term and one retirement (v2/v3). */
export function demoTerms(): readonly GovernedTermView[] {
  return [
    seedTerm('discharge', 'property', 'Discharge', 'Volumetric flow rate. Distinct from stage and storage; never summed with them.', { dimension: 'flow', canonicalUnitId: 'cfs' }),
    seedTerm('stage', 'property', 'Stage', 'Water surface elevation above a local datum.', { dimension: 'level', canonicalUnitId: 'ft' }),
    seedTerm('voltage', 'property', 'Battery voltage', 'Station supply voltage. Internal diagnostic property, not a water measurement.', { dimension: 'equipment', canonicalUnitId: 'V' }),
    seedTerm('cfs', 'unit', 'cubic feet per second', 'Acre-feet = integrated cubic feet / 43560 for a rate representative of its interval.', { dimension: 'flow' }),
    seedTerm('ft', 'unit', 'feet', '', { dimension: 'length' }),
    seedTerm('V', 'unit', 'volt', '', { dimension: 'equipment' }),
    { ...seedTerm('ice-affected', 'qualifier', 'Ice affected', 'Value influenced by ice; used when the measurement is retained with a caveat rather than excluded.'), status: 'retired', registryVersion: 3, retiredAt: '2026-03-10T14:00:00Z', retiredBy: 'principal-diego-steward' },
    seedTerm('interpolate', 'qualifier', 'Interpolated', 'Value estimated between bracketing readings under a declared method.'),
    { ...seedTerm('estimated', 'qualifier', 'Estimated', 'Value estimated under a declared gap-edge method.'), registryVersion: 2, createdAt: '2026-03-10T13:30:00Z', createdBy: 'principal-diego-steward' },
    seedTerm('raw', 'processingLevel', 'Raw', 'Original observation exactly as received. Immutable; corrections append revisions.'),
    seedTerm('provisional', 'processingLevel', 'Provisional', 'Screened but not reviewed; still subject to change.'),
    seedTerm('reviewed', 'processingLevel', 'Reviewed', 'Accepted through a documented review workflow. Reviewed does not imply public.'),
    seedTerm('best-available', 'processingLevel', 'Best available', 'Current best value for the logical observation; remains correctable after year end.'),
    seedTerm('diagnostic', 'siteType', 'Diagnostic site', 'Site type observed in the frozen station fixture set.'),
    seedTerm('flume', 'siteType', 'Flume', 'Site type observed in the frozen station fixture set.'),
    seedTerm('natural-channel', 'siteType', 'Natural channel', 'Site type observed in the frozen station fixture set.'),
    seedTerm('weir', 'siteType', 'Weir', 'Site type observed in the frozen station fixture set.'),
    seedTerm('sys-bear-river', 'system', 'Bear River Distribution System', 'Synthetic system covering the Bear River basin above the Great Salt Lake.'),
    seedTerm('sys-weber-river', 'system', 'Weber River Distribution System', 'Synthetic system covering the Weber River basin.'),
  ];
}

export function demoVocabularyChanges(): readonly VocabularyChangeEventView[] {
  return [
    { id: 've-000001', at: '2026-03-10T13:30:00Z', actorId: 'principal-diego-steward', action: 'create', kind: 'qualifier', termId: 'estimated', label: 'Estimated', registryVersion: 2 },
    { id: 've-000002', at: '2026-03-10T14:00:00Z', actorId: 'principal-diego-steward', action: 'retire', kind: 'qualifier', termId: 'ice-affected', label: 'Ice affected', registryVersion: 3 },
  ];
}

const DEMO_SCHEMA: readonly { key: string; type: string; required: boolean }[] = [
  { key: 'endpoint-url', type: 'url', required: true },
  { key: 'api-key', type: 'secret', required: true },
  { key: 'poll-seconds', type: 'number', required: false },
];

export function demoProviders(): readonly ProviderDefinitionView[] {
  return [
    { id: 'prov-dwri-telemetry', name: 'DWRi Telemetry Network', kind: 'telemetry', parameterSchema: DEMO_SCHEMA },
    { id: 'prov-coop-manual', name: 'Cooperator Manual Measurement Program', kind: 'manual', parameterSchema: [] },
  ];
}

const PARAMS = { 'endpoint-url': 'https://api.example.com/v1/telemetry', 'api-key': '[redacted]', 'poll-seconds': '300' } as const;

export function demoConfigs(): readonly IngestionConfigView[] {
  return [
    {
      id: 'ing-000001', providerId: 'prov-dwri-telemetry', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river',
      params: PARAMS, status: 'configured', requestedBy: 'principal-diego-steward', requestedAt: '2026-03-02T09:00:00Z',
      promotedBy: 'principal-diego-steward', promotedAt: '2026-03-02T09:00:00Z',
      lastConnectionTest: { at: '2026-03-09T10:00:00Z', outcome: 'auth-failure', latencyMs: 40 },
    },
    {
      id: 'ing-000002', providerId: 'prov-dwri-telemetry', stationId: 'sta-bear-lake-diagnostic', systemId: 'sys-bear-river',
      params: PARAMS, status: 'configured', requestedBy: 'principal-diego-steward', requestedAt: '2026-03-03T09:00:00Z',
      promotedBy: 'principal-diego-steward', promotedAt: '2026-03-03T09:00:00Z',
      lastConnectionTest: { at: '2026-03-09T10:00:00Z', outcome: 'success', latencyMs: 120 },
    },
    {
      id: 'ing-000003', providerId: 'prov-dwri-telemetry', stationId: 'sta-ogden-valley-proposed', systemId: 'sys-weber-river',
      params: PARAMS, status: 'requested', requestedBy: 'principal-marco-engineer', requestedAt: '2026-03-10T11:00:00Z',
      promotedBy: null, promotedAt: null, lastConnectionTest: null,
    },
  ];
}

export function demoHealthRows(): readonly HealthRowView[] {
  return [
    { connectionId: 'ing-000001', providerId: 'prov-dwri-telemetry', stationId: 'sta-bear-corinne', systemId: 'sys-bear-river', status: 'auth-failure', lastTestedAt: '2026-03-09T10:00:00Z', openConnectionIncidents: 3, failedTaskCount: 1, latestIncidentAt: '2026-03-09T15:00:00Z', taskListQuery: 'connection=ing-000001' },
    { connectionId: 'ing-000002', providerId: 'prov-dwri-telemetry', stationId: 'sta-bear-lake-diagnostic', systemId: 'sys-bear-river', status: 'healthy', lastTestedAt: '2026-03-09T10:00:00Z', openConnectionIncidents: 0, failedTaskCount: 3, latestIncidentAt: '2026-03-09T15:00:00Z', taskListQuery: 'connection=ing-000002' },
  ];
}

/** Demo digests by date (recipient: the steward) - mirrors the API Monday/Tuesday scenario. */
export function demoDigests(): Readonly<Record<string, WeekdayDigestView>> {
  const monday: WeekdayDigestView = {
    issued: true,
    notIssuedReason: null,
    digestDate: '2026-03-09',
    weekday: 'Mon',
    coverageStart: '2026-03-06T07:00:00.000Z',
    coverageEnd: '2026-03-09T06:00:00.000Z',
    coverageDays: ['2026-03-06', '2026-03-07', '2026-03-08'],
    recipientId: 'principal-diego-steward',
    taskFailures: [
      { incidentId: 'inc-sun-task-1', taskId: 'qc-task-0301', connectionId: 'ing-000002', systemId: 'sys-bear-river', detectedAt: '2026-03-08T07:00:00Z', summary: 'Sunday QC range check failure (still MST)' },
      { incidentId: 'inc-sun-task-2', taskId: 'qc-task-0302', connectionId: 'ing-000002', systemId: 'sys-bear-river', detectedAt: '2026-03-08T15:00:00Z', summary: 'Sunday rate-of-change failure (MDT after spring-forward)' },
    ],
    connectionIncidents: [
      { incidentId: 'inc-fri-conn', connectionId: 'ing-000001', status: 'auth-failure', systemId: 'sys-bear-river', detectedAt: '2026-03-06T20:00:00Z', summary: 'Friday evening auth failure (Bear)', failedTaskCount: 0, taskListQuery: 'connection=ing-000001' },
      { incidentId: 'inc-sat-conn', connectionId: 'ing-000001', status: 'auth-failure', systemId: 'sys-bear-river', detectedAt: '2026-03-07T16:00:00Z', summary: 'Saturday auth failure (Bear)', failedTaskCount: 0, taskListQuery: 'connection=ing-000001' },
    ],
    counts: { connections: 2, tasks: 2, duplicatesDropped: 1, omittedForScope: 0 },
  };
  const tuesday: WeekdayDigestView = {
    ...monday,
    digestDate: '2026-03-10',
    weekday: 'Tue',
    coverageStart: '2026-03-09T06:00:00.000Z',
    coverageEnd: '2026-03-10T06:00:00.000Z',
    coverageDays: ['2026-03-09'],
    taskFailures: [
      { incidentId: 'inc-mon-task', taskId: 'qc-task-0303', connectionId: 'ing-000002', systemId: 'sys-bear-river', detectedAt: '2026-03-09T15:00:00Z', summary: 'Monday persistence failure' },
    ],
    connectionIncidents: [],
    counts: { connections: 0, tasks: 1, duplicatesDropped: 0, omittedForScope: 0 },
  };
  const weekend = (date: string, weekday: string): WeekdayDigestView => ({
    issued: false,
    notIssuedReason: 'weekend',
    digestDate: date,
    weekday,
    coverageStart: '2026-03-07T07:00:00.000Z',
    coverageEnd: '2026-03-07T07:00:00.000Z',
    coverageDays: [],
    recipientId: 'principal-diego-steward',
    taskFailures: [],
    connectionIncidents: [],
    counts: { connections: 0, tasks: 0, duplicatesDropped: 0, omittedForScope: 0 },
  });
  return {
    '2026-03-06': { ...tuesday, digestDate: '2026-03-06', weekday: 'Fri', coverageDays: ['2026-03-05'], coverageStart: '2026-03-05T07:00:00.000Z', coverageEnd: '2026-03-06T07:00:00.000Z', taskFailures: [], counts: { connections: 0, tasks: 0, duplicatesDropped: 0, omittedForScope: 0 } },
    '2026-03-07': weekend('2026-03-07', 'Sat'),
    '2026-03-08': weekend('2026-03-08', 'Sun'),
    '2026-03-09': monday,
    '2026-03-10': tuesday,
  };
}

/** Demo usage report - the exact aggregates the API suite pins for the seed events. */
export function demoUsageReport(): UsageReportView {
  return {
    byDay: [
      { period: 'day', key: '2026-03-06', counts: { sessions: 2, exports: 1, apiTokenVerifications: 0 }, total: 3 },
      { period: 'day', key: '2026-03-07', counts: { sessions: 1, exports: 0, apiTokenVerifications: 1 }, total: 2 },
      { period: 'day', key: '2026-03-08', counts: { sessions: 0, exports: 0, apiTokenVerifications: 2 }, total: 2 },
      { period: 'day', key: '2026-03-09', counts: { sessions: 2, exports: 0, apiTokenVerifications: 0 }, total: 2 },
      { period: 'day', key: '2026-03-10', counts: { sessions: 0, exports: 1, apiTokenVerifications: 0 }, total: 1 },
    ],
    byMonth: [{ period: 'month', key: '2026-03', counts: { sessions: 5, exports: 2, apiTokenVerifications: 3 }, total: 10 }],
    byYear: [{ period: 'year', key: '2026', counts: { sessions: 5, exports: 2, apiTokenVerifications: 3 }, total: 10 }],
    excludedEvents: 3,
    excludedByReason: { 'unknown-account': 0, 'consent-required': 2, 'field-not-allowed': 1, 'unknown-kind': 0 },
  };
}

/** The full demo bundle rendered by the unwired console. */
export function demoConsoleData(): StewardConsoleData {
  return {
    terms: demoTerms(),
    vocabularyChanges: demoVocabularyChanges(),
    registryVersion: 3,
    providers: demoProviders(),
    configs: demoConfigs(),
    healthRows: demoHealthRows(),
    digests: demoDigests(),
    usage: demoUsageReport(),
  };
}
