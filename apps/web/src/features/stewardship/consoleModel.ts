/**
 * Pure view models for the steward console (WD-014; FR-011/FR-012/FR-013/
 * FR-014/FR-017).
 *
 * This module is presentation logic only: digest preview assembly, health
 * rollups, vocabulary change lists, ingestion queue summaries, usage
 * analytics tables, and the console-access verdict. It CONSUMES
 * shape-compatible records produced by the server modules
 * (services/api/src/workflows/stewardship/*) - the mirror types below are
 * structural (the real module outputs satisfy them as-is; the parity is
 * pinned in consoleModel.test.ts against the REAL builder and policy
 * engine). Authorization is always an injected evaluator verdict, never a
 * role-label check in this file.
 *
 * The FR-017 exclusion note is DATA here (`FR017_EXCLUSION_NOTE`) so every
 * analytics surface renders the same note, and the weekday/Monday digest
 * rules are DATA (`DIGEST_RULES`) so the health tab shows the rule text the
 * digest builder actually implements.
 */

// ---------------------------------------------------------------------------
// Policy mirrors (structural; the real @utah-water/policy types satisfy these)
// ---------------------------------------------------------------------------

export type PolicyFieldClassMirror = 'public' | 'restricted' | 'internal';

export interface PolicyPrincipalMirror {
  readonly id: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly roles: readonly string[];
}

export interface PolicyAssignmentMirror {
  readonly id: string;
  readonly principalId: string;
  readonly role: string;
  readonly capabilities: readonly string[];
  readonly scope: { readonly kind: string; readonly id: string | null };
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
  readonly status: 'active' | 'revoked';
  readonly delegation: { readonly effectiveAt: string; readonly expiresAt: string; readonly delegatedBy: string } | null;
  readonly grantedBy: string;
  readonly grantVersion: number;
}

export interface PolicyObjectMirror {
  readonly id: string;
  readonly kind: string;
  readonly systemId?: string | null;
  readonly visibility: 'public' | 'restricted' | 'internal';
  readonly status: string;
}

export interface PolicyWorldMirror {
  readonly principals: Readonly<Record<string, PolicyPrincipalMirror>>;
  readonly assignments: readonly PolicyAssignmentMirror[];
  readonly objects: Readonly<Record<string, PolicyObjectMirror>>;
  readonly assignmentVersion: number;
}

export interface PolicyDecisionMirror {
  readonly effect: 'allow' | 'deny';
  readonly reason: string;
}

export type PolicyEvaluatorMirror = (request: {
  principal: PolicyPrincipalMirror | null;
  action: string;
  object: { kind: string; id: string; fields?: readonly PolicyFieldClassMirror[] };
}, world: PolicyWorldMirror, now: Date | string) => PolicyDecisionMirror;

// ---------------------------------------------------------------------------
// Record mirrors (structural; outputs of the stewardship server modules)
// ---------------------------------------------------------------------------

export type VocabularyKindView = 'property' | 'unit' | 'qualifier' | 'processingLevel' | 'siteType' | 'system';
export type TermStatusView = 'active' | 'retired';

export interface GovernedTermView {
  readonly id: string;
  readonly kind: VocabularyKindView;
  readonly label: string;
  readonly description: string;
  readonly dimension: string | null;
  readonly canonicalUnitId: string | null;
  readonly status: TermStatusView;
  readonly registryVersion: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly retiredAt: string | null;
  readonly retiredBy: string | null;
}

export interface VocabularyChangeEventView {
  readonly id: string;
  readonly at: string;
  readonly actorId: string;
  readonly action: 'create' | 'retire';
  readonly kind: VocabularyKindView;
  readonly termId: string;
  readonly label: string;
  readonly registryVersion: number;
}

export type ConnectionStatusView = 'healthy' | 'auth-failure' | 'timeout' | 'untested';

export interface HealthRowView {
  readonly connectionId: string;
  readonly providerId: string;
  readonly stationId: string;
  readonly systemId: string;
  readonly status: ConnectionStatusView;
  readonly lastTestedAt: string | null;
  readonly openConnectionIncidents: number;
  readonly failedTaskCount: number;
  readonly latestIncidentAt: string | null;
  readonly taskListQuery: string;
}

export interface DigestTaskEntryView {
  readonly incidentId: string;
  readonly taskId: string;
  readonly connectionId: string | null;
  readonly systemId: string;
  readonly detectedAt: string;
  readonly summary: string;
}

export interface DigestConnectionEntryView {
  readonly incidentId: string;
  readonly connectionId: string;
  readonly status: ConnectionStatusView;
  readonly systemId: string;
  readonly detectedAt: string;
  readonly summary: string;
  readonly failedTaskCount: number;
  readonly taskListQuery: string;
}

export interface WeekdayDigestView {
  readonly issued: boolean;
  readonly notIssuedReason: 'weekend' | null;
  readonly digestDate: string;
  readonly weekday: string;
  readonly coverageStart: string;
  readonly coverageEnd: string;
  readonly coverageDays: readonly string[];
  readonly recipientId: string | null;
  readonly taskFailures: readonly DigestTaskEntryView[];
  readonly connectionIncidents: readonly DigestConnectionEntryView[];
  readonly counts: { readonly connections: number; readonly tasks: number; readonly duplicatesDropped: number; readonly omittedForScope: number };
}

export interface IngestionConfigView {
  readonly id: string;
  readonly providerId: string;
  readonly stationId: string;
  readonly systemId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly status: 'requested' | 'configured';
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly promotedBy: string | null;
  readonly promotedAt: string | null;
  readonly lastConnectionTest: { readonly at: string; readonly outcome: 'success' | 'auth-failure' | 'timeout'; readonly latencyMs: number } | null;
}

export interface ProviderDefinitionView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly parameterSchema: readonly { readonly key: string; readonly type: string; readonly required: boolean }[];
}

export interface UsageAggregateView {
  readonly period: 'day' | 'month' | 'year';
  readonly key: string;
  readonly counts: { readonly sessions: number; readonly exports: number; readonly apiTokenVerifications: number };
  readonly total: number;
}

export interface UsageReportView {
  readonly byDay: readonly UsageAggregateView[];
  readonly byMonth: readonly UsageAggregateView[];
  readonly byYear: readonly UsageAggregateView[];
  readonly excludedEvents: number;
  readonly excludedByReason: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Console data bundle (injected by the shell; demo default in demoData.ts)
// ---------------------------------------------------------------------------

export interface StewardConsoleData {
  readonly terms: readonly GovernedTermView[];
  readonly vocabularyChanges: readonly VocabularyChangeEventView[];
  readonly registryVersion: number;
  readonly providers: readonly ProviderDefinitionView[];
  readonly configs: readonly IngestionConfigView[];
  readonly healthRows: readonly HealthRowView[];
  readonly digests: Readonly<Record<string, WeekdayDigestView>>; // by digest date
  readonly usage: UsageReportView;
}

// ---------------------------------------------------------------------------
// Console access (policy-driven; non-steward personas see the console denied)
// ---------------------------------------------------------------------------

export interface ConsoleAccess {
  readonly allowed: boolean;
  /** 'DENY_ANONYMOUS' etc.; null when allowed. */
  readonly reason: string | null;
  /** 401 = login required (identity failure); 403 = authenticated non-steward. */
  readonly status: 401 | 403 | null;
  /** Human explanation rendered in the denied panel. */
  readonly message: string;
}

/** The governance object every console-access verdict is evaluated against. */
export const CONSOLE_GATE_OBJECT: PolicyObjectMirror = Object.freeze({
  id: 'vocab:root',
  kind: 'vocabulary',
  systemId: null,
  visibility: 'internal',
  status: 'active',
});

/**
 * May `principalId` open the steward console? The verdict is a REAL policy
 * evaluation of `manage-vocabulary` on the governance root object (the same
 * gate the server's vocabulary registry uses), so steward-only access holds
 * by entitlement, never by role label.
 */
export function stewardConsoleAccess(input: {
  readonly principalId: string | null;
  readonly world: PolicyWorldMirror;
  readonly policy: PolicyEvaluatorMirror;
  readonly now: Date | string;
}): ConsoleAccess {
  const principal = input.principalId === null ? null : input.world.principals[input.principalId] ?? null;
  const world: PolicyWorldMirror = {
    ...input.world,
    objects: { ...input.world.objects, [CONSOLE_GATE_OBJECT.id]: CONSOLE_GATE_OBJECT },
  };
  const decision = input.policy({ principal, action: 'manage-vocabulary', object: { kind: 'vocabulary', id: CONSOLE_GATE_OBJECT.id } }, world, input.now);
  if (decision.effect === 'allow') {
    return { allowed: true, reason: null, status: null, message: '' };
  }
  const identityFailure = decision.reason === 'DENY_ANONYMOUS' || decision.reason === 'DENY_UNKNOWN_PRINCIPAL' || decision.reason === 'DENY_PRINCIPAL_INACTIVE';
  return {
    allowed: false,
    reason: decision.reason,
    status: identityFailure ? 401 : 403,
    message: identityFailure
      ? 'The steward console requires an authenticated session.'
      : 'The steward console is restricted to the statewide data steward (policy verdict: ' + decision.reason + ').',
  };
}

// ---------------------------------------------------------------------------
// Vocabulary view models
// ---------------------------------------------------------------------------

/** Status is always text + shape, never color alone (accessibility contract). */
export function termStatusBadge(status: TermStatusView): string {
  return status === 'active' ? '● Active' : '○ Retired (history preserved)';
}

export const VOCABULARY_KIND_LABELS: Readonly<Record<VocabularyKindView, string>> = {
  property: 'Observed property',
  unit: 'Unit',
  qualifier: 'Qualifier',
  processingLevel: 'Processing level',
  siteType: 'Site type',
  system: 'Distribution system',
};

/** Deterministic term listing: kind order, then label. Retired terms stay visible. */
export function vocabularyRows(terms: readonly GovernedTermView[], kind?: VocabularyKindView | 'all'): readonly GovernedTermView[] {
  const kindOrder: readonly VocabularyKindView[] = ['property', 'unit', 'qualifier', 'processingLevel', 'siteType', 'system'];
  return terms
    .filter((term) => kind === undefined || kind === 'all' || term.kind === kind)
    .slice()
    .sort((a, b) => {
      const kindDelta = kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind);
      if (kindDelta !== 0) return kindDelta;
      return a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : 1;
    });
}

export interface VocabularyChangeRow {
  readonly key: string;
  readonly text: string;
  readonly actionLabel: string;
  readonly actorLabel: string;
  readonly versionLabel: string;
}

/** The steward-visible change list: every create/retire with actor and version stamp. */
export function vocabularyChangeList(events: readonly VocabularyChangeEventView[], actorName: (principalId: string) => string): readonly VocabularyChangeRow[] {
  return events.map((event) => ({
    key: event.id,
    text: `${event.action === 'create' ? 'Created' : 'Retired'} ${VOCABULARY_KIND_LABELS[event.kind].toLowerCase()} "${event.label}" (${event.termId})`,
    actionLabel: event.action === 'create' ? 'Created' : 'Retired',
    actorLabel: actorName(event.actorId),
    versionLabel: `registry v${event.registryVersion}`,
  }));
}

// ---------------------------------------------------------------------------
// Health rollups and digest preview
// ---------------------------------------------------------------------------

export interface HealthRollup {
  readonly total: number;
  readonly byStatus: Readonly<Record<ConnectionStatusView, number>>;
  /** Rows needing attention first: failed connections, then untested, then healthy; stable by id. */
  readonly attentionOrder: readonly HealthRowView[];
  /** Failed TASKS across all connections - reported separately, never merged into status (FR-014). */
  readonly totalFailedTasks: number;
}

const STATUS_PRIORITY: Readonly<Record<ConnectionStatusView, number>> = { 'auth-failure': 0, timeout: 1, untested: 2, healthy: 3 };

export function healthStatusText(status: ConnectionStatusView): string {
  switch (status) {
    case 'healthy':
      return '✓ Healthy';
    case 'auth-failure':
      return '✕ Auth failure (connection)';
    case 'timeout':
      return '⏱ Timeout (connection)';
    default:
      return '? Untested';
  }
}

/** Connection health rollup. Status counts come ONLY from staging tests; task failures are a separate total. */
export function healthRollup(rows: readonly HealthRowView[]): HealthRollup {
  const byStatus: Record<ConnectionStatusView, number> = { healthy: 0, 'auth-failure': 0, timeout: 0, untested: 0 };
  let totalFailedTasks = 0;
  for (const row of rows) {
    byStatus[row.status] += 1;
    totalFailedTasks += row.failedTaskCount;
  }
  const attentionOrder = rows.slice().sort((a, b) => {
    const priority = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (priority !== 0) return priority;
    return a.connectionId < b.connectionId ? -1 : 1;
  });
  return { total: rows.length, byStatus, attentionOrder, totalFailedTasks };
}

export const DIGEST_RULES: readonly string[] = [
  'Weekday digests issue Monday through Friday only; weekend dates (Saturday, Sunday) issue nothing.',
  'Tuesday to Friday digests cover the previous calendar day (program zone America/Denver).',
  'The Monday digest covers everything since the last weekday digest - Friday, Saturday and Sunday - so the weekend interval is included exactly once.',
  'Duplicate incident records are deduped by incident id; the digest reports how many were dropped.',
  'Task entries reference task ids; connection entries link to the filtered task list for that connection.',
];

const WEEKDAY_FULL: Readonly<Record<string, string>> = {
  Sun: 'Sunday',
  Mon: 'Monday',
  Tue: 'Tuesday',
  Wed: 'Wednesday',
  Thu: 'Thursday',
  Fri: 'Friday',
  Sat: 'Saturday',
};

/** Full weekday name for the digest model's three-letter weekday ('Mon' -> 'Monday'). */
export function weekdayLabel(weekday: string): string {
  return WEEKDAY_FULL[weekday] ?? weekday;
}

export interface DigestPreviewLine {
  readonly key: string;
  readonly kind: 'header' | 'task' | 'connection' | 'footer' | 'notice';
  readonly text: string;
}

/**
 * Assemble the digest preview lines: FAILED TASKS FIRST (FR-014), then
 * connection incidents with their filtered task-list link, then counts.
 */
export function assembleDigestPreview(digest: WeekdayDigestView, systemName: (systemId: string) => string): readonly DigestPreviewLine[] {
  if (!digest.issued) {
    return [
      { key: 'not-issued', kind: 'notice', text: `No digest issues on ${weekdayLabel(digest.weekday)} ${digest.digestDate} (weekday digest rule: weekend dates issue nothing).` },
    ];
  }
  const coverage = digest.coverageDays.length > 1 ? `covers ${digest.coverageDays[0]} through ${digest.coverageDays.at(-1)}` : `covers ${digest.coverageDays[0]}`;
  const weekend = digest.weekday === 'Mon' ? ' (the full weekend interval is included here, exactly once)' : '';
  const lines: DigestPreviewLine[] = [
    { key: 'header', kind: 'header', text: `${weekdayLabel(digest.weekday)} digest ${digest.digestDate} - ${coverage}${weekend}` },
  ];
  if (digest.taskFailures.length === 0 && digest.connectionIncidents.length === 0) {
    lines.push({ key: 'empty', kind: 'notice', text: 'No incidents within the digest window for this recipient scope.' });
  }
  // Failed tasks first.
  for (const task of digest.taskFailures) {
    lines.push({
      key: task.incidentId,
      kind: 'task',
      text: `Task ${task.taskId} failed - ${task.summary} (${systemName(task.systemId)}, ${task.detectedAt})`,
    });
  }
  for (const connection of digest.connectionIncidents) {
    const tasks = connection.failedTaskCount > 0 ? `; ${connection.failedTaskCount} linked failed task${connection.failedTaskCount === 1 ? '' : 's'}` : '';
    lines.push({
      key: connection.incidentId,
      kind: 'connection',
      text: `Connection ${connection.connectionId} ${healthStatusText(connection.status).replace(/^[^A-Za-z]+ /, '')} - ${connection.summary} (${systemName(connection.systemId)}) → filtered tasks: ${connection.taskListQuery}${tasks}`,
    });
  }
  lines.push({
    key: 'footer',
    kind: 'footer',
    text: `${digest.counts.tasks} failed task${digest.counts.tasks === 1 ? '' : 's'}, ${digest.counts.connections} connection incident${digest.counts.connections === 1 ? '' : 's'}; ${digest.counts.duplicatesDropped} duplicate incident record${digest.counts.duplicatesDropped === 1 ? '' : 's'} dropped; ${digest.counts.omittedForScope} incident${digest.counts.omittedForScope === 1 ? '' : 's'} outside recipient scope (count only).`,
  });
  return lines;
}

// ---------------------------------------------------------------------------
// Ingestion queue view
// ---------------------------------------------------------------------------

export interface IngestionQueueSummary {
  readonly providers: number;
  readonly configured: number;
  readonly pendingRequests: readonly IngestionConfigView[];
  readonly lastTestLabel: (config: IngestionConfigView) => string;
}

/** Connection-test status label with timestamp; distinct per config. */
export function connectionTestLabel(config: IngestionConfigView): string {
  if (config.lastConnectionTest === null) return 'Not tested';
  const test = config.lastConnectionTest;
  const outcome = test.outcome === 'success' ? '✓ success' : test.outcome === 'auth-failure' ? '✕ auth failure' : '⏱ timeout';
  return `${outcome} at ${test.at} (${test.latencyMs} ms, simulated staging)`;
}

export function ingestionQueue(configs: readonly IngestionConfigView[], providers: readonly ProviderDefinitionView[]): IngestionQueueSummary {
  return {
    providers: providers.length,
    configured: configs.filter((config) => config.status === 'configured').length,
    pendingRequests: configs
      .filter((config) => config.status === 'requested')
      .slice()
      .sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : a.requestedAt > b.requestedAt ? 1 : a.id < b.id ? -1 : 1)),
    lastTestLabel: connectionTestLabel,
  };
}

// ---------------------------------------------------------------------------
// Usage analytics view (FR-017)
// ---------------------------------------------------------------------------

export const FR017_EXCLUSION_NOTE =
  'Counts only: credentials, sensitive query content and internal records are excluded, and every event is consent-gated per account. Aggregates carry no identifiers.';

export interface UsageTableRow {
  readonly key: string;
  readonly label: string;
  readonly sessions: number;
  readonly exports: number;
  readonly apiTokenVerifications: number;
  readonly total: number;
  /** Bar width share (0..1) against the row set's maximum total. */
  readonly share: number;
}

function usageRows(aggregates: readonly UsageAggregateView[]): readonly UsageTableRow[] {
  const max = aggregates.reduce((peak, aggregate) => Math.max(peak, aggregate.total), 0);
  return aggregates.map((aggregate) => ({
    key: aggregate.key,
    label: aggregate.key,
    sessions: aggregate.counts.sessions,
    exports: aggregate.counts.exports,
    apiTokenVerifications: aggregate.counts.apiTokenVerifications,
    total: aggregate.total,
    share: max === 0 ? 0 : aggregate.total / max,
  }));
}

export interface UsageTables {
  readonly dayRows: readonly UsageTableRow[];
  readonly monthRows: readonly UsageTableRow[];
  readonly yearRows: readonly UsageTableRow[];
  readonly excludedEvents: number;
  readonly exclusionNote: string;
}

export function usageTables(report: UsageReportView): UsageTables {
  return {
    dayRows: usageRows(report.byDay),
    monthRows: usageRows(report.byMonth),
    yearRows: usageRows(report.byYear),
    excludedEvents: report.excludedEvents,
    exclusionNote: FR017_EXCLUSION_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Assignment view
// ---------------------------------------------------------------------------

export interface AssignmentRow {
  readonly key: string;
  readonly principalLabel: string;
  readonly role: string;
  readonly scopeLabel: string;
  readonly capabilitiesLabel: string;
  readonly windowLabel: string;
  readonly delegationLabel: string | null;
  readonly statusLabel: string;
  readonly grantVersion: number;
}

/** Assignment listing with validity windows and delegation expiry made explicit (FR-011). */
export function assignmentRows(
  assignments: readonly PolicyAssignmentMirror[],
  principalName: (principalId: string) => string,
): readonly AssignmentRow[] {
  return assignments
    .slice()
    .sort((a, b) => (a.principalId < b.principalId ? -1 : a.principalId > b.principalId ? 1 : a.id < b.id ? -1 : 1))
    .map((assignment) => ({
      key: assignment.id,
      principalLabel: `${principalName(assignment.principalId)} (${assignment.principalId})`,
      role: assignment.role,
      scopeLabel: assignment.scope.kind === 'statewide' ? 'Statewide' : `${assignment.scope.kind}: ${assignment.scope.id ?? ''}`,
      capabilitiesLabel: assignment.capabilities.join(', '),
      windowLabel: `${assignment.effectiveAt} → ${assignment.expiresAt ?? 'no scheduled end'}`,
      delegationLabel: assignment.delegation
        ? `Delegated by ${principalName(assignment.delegation.delegatedBy)} until ${assignment.delegation.expiresAt}`
        : null,
      statusLabel: assignment.status === 'active' ? '● Active' : '○ Revoked (history preserved)',
      grantVersion: assignment.grantVersion,
    }));
}
