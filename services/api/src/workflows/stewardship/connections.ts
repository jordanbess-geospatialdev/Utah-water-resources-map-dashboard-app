/**
 * Connection health, distinct from task failures, and the weekday digest
 * (WD-014; FR-014).
 *
 * "Health distinguishes a failed connection from failed tasks; a
 * configurable weekday digest links to failed tasks first, and a Monday
 * digest includes the weekend interval without duplicate incident counts."
 *
 * MODEL:
 *
 * - CONNECTION HEALTH is per connection (an ingestion site configuration):
 *   healthy / auth-failure / timeout / untested, derived from the latest
 *   SIMULATED staging connection test (ingestion.ts records the outcome
 *   with a timestamp). Connection health NEVER aggregates task failures:
 *   a connection with three failed tasks and a passing test is HEALTHY
 *   with three failed tasks - the board shows both facts side by side.
 * - TASK FAILURES are per task: incidents that carry a `taskId` (never
 *   merely a connection id). A task failure never flips connection status.
 * - A CONNECTION FAILURE (an incident of kind `connection`) marks the
 *   connection AND links to its filtered task list: every digest/board
 *   entry carries `taskListQuery` (`connection=<id>`), the filter the
 *   permission-checked GET /admin/connections task view consumes.
 * - WEEKDAY DIGEST: digests are issued on weekdays only (a Saturday or
 *   Sunday digestDate is not issued). Tuesday through Friday cover the
 *   previous calendar day; MONDAY covers everything since the last weekday
 *   digest - Friday, Saturday and Sunday - so the whole weekend interval
 *   is included and NO incident can fall between digests. Weekend
 *   incidents therefore appear in the Monday digest exactly once and in
 *   no later digest; duplicate incident records (same incident id, e.g.
 *   re-delivered telemetry) are deduped by id and counted.
 * - SCOPE: a digest contains only entries within the RECIPIENT's scope:
 *   each incident is admitted by the policy engine (view-restricted-
 *   details on the incident's system anchor in the program world) - the
 *   same entitlement path as every other read. Out-of-scope incidents are
 *   omitted and only their COUNT is reported.
 * - Days, windows and weekday math are keyed in the PROGRAM ZONE
 *   (America/Denver); a user's browser clock never redefines a reporting
 *   day (numerical and temporal rules). Window boundaries are local
 *   midnights resolved to exact instants (DST-aware).
 */
import { PROGRAM_TIME_ZONE, programDayKey } from '../../support/analytics.ts';
import type { PolicyObject, PolicyWorld } from '../../../../../packages/policy/src/index.ts';
import { gateAct, governanceObject, type PolicyEvaluator } from './gate.ts';
import type { SiteIngestionConfig, TestOutcome } from './ingestion.ts';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const CONNECTION_STATUSES = ['healthy', 'auth-failure', 'timeout', 'untested'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface ConnectionRecord {
  readonly id: string;
  readonly providerId: string;
  readonly stationId: string;
  readonly systemId: string;
  readonly status: ConnectionStatus;
  readonly lastTestedAt: string | null;
  readonly lastOutcome: TestOutcome | null;
}

export type IncidentKind = 'connection' | 'task';

export interface IncidentRecord {
  /** Incident id: the dedupe key (weekend incidents count exactly once). */
  readonly id: string;
  readonly kind: IncidentKind;
  /** Present for connection incidents. */
  readonly connectionId: string | null;
  /** Present for task incidents - digest task entries reference TASK ids, never connection ids alone. */
  readonly taskId: string | null;
  readonly systemId: string;
  readonly detectedAt: string;
  readonly summary: string;
}

export interface HealthBoardRow {
  readonly connectionId: string;
  readonly providerId: string;
  readonly stationId: string;
  readonly systemId: string;
  readonly status: ConnectionStatus;
  readonly lastTestedAt: string | null;
  readonly openConnectionIncidents: number;
  readonly failedTaskCount: number;
  readonly latestIncidentAt: string | null;
  /** Filtered task view link for this connection (permission-checked downstream). */
  readonly taskListQuery: string;
}

export interface DigestConnectionEntry {
  readonly incidentId: string;
  readonly connectionId: string;
  readonly status: ConnectionStatus;
  readonly systemId: string;
  readonly detectedAt: string;
  readonly summary: string;
  readonly failedTaskCount: number;
  readonly taskListQuery: string;
}

export interface DigestTaskEntry {
  readonly incidentId: string;
  readonly taskId: string;
  readonly connectionId: string | null;
  readonly systemId: string;
  readonly detectedAt: string;
  readonly summary: string;
}

export interface DigestCounts {
  readonly connections: number;
  readonly tasks: number;
  readonly duplicatesDropped: number;
  readonly omittedForScope: number;
}

export interface WeekdayDigest {
  /** False on Saturday/Sunday digest dates (weekday digest rule). */
  readonly issued: boolean;
  readonly notIssuedReason: 'weekend' | null;
  readonly digestDate: string;
  readonly weekday: string;
  readonly coverageStart: string;
  readonly coverageEnd: string;
  readonly coverageDays: readonly string[];
  readonly recipientId: string | null;
  /** Task failures first (FR-014: the digest links to failed tasks first). */
  readonly taskFailures: readonly DigestTaskEntry[];
  readonly connectionIncidents: readonly DigestConnectionEntry[];
  readonly counts: DigestCounts;
}

// ---------------------------------------------------------------------------
// Health derivation (connection status vs task failures - always distinct)
// ---------------------------------------------------------------------------

/** Connection status from the latest staging test outcome; untested when none. */
export function connectionStatusFromOutcome(outcome: TestOutcome | null | undefined): ConnectionStatus {
  if (outcome === 'success') return 'healthy';
  if (outcome === 'auth-failure') return 'auth-failure';
  if (outcome === 'timeout') return 'timeout';
  return 'untested';
}

/** Derive connection health records from ingestion site configurations. */
export function connectionsFromConfigs(configs: readonly SiteIngestionConfig[]): readonly ConnectionRecord[] {
  return configs.map((config) => ({
    id: config.id,
    providerId: config.providerId,
    stationId: config.stationId,
    systemId: config.systemId,
    status: connectionStatusFromOutcome(config.lastConnectionTest?.outcome ?? null),
    lastTestedAt: config.lastConnectionTest?.at ?? null,
    lastOutcome: config.lastConnectionTest?.outcome ?? null,
  }));
}

/** The filtered task list query for a connection (GET /admin/connections deep-link filter). */
export function taskListQuery(connectionId: string): string {
  return `connection=${connectionId}`;
}

/** Failed task entries for one connection - TASK ids, never connection ids. */
export function failedTasksFor(connectionId: string, incidents: readonly IncidentRecord[]): readonly DigestTaskEntry[] {
  return incidents
    .filter((incident) => incident.kind === 'task' && incident.connectionId === connectionId)
    .map((incident) => ({
      incidentId: incident.id,
      taskId: incident.taskId!,
      connectionId: incident.connectionId,
      systemId: incident.systemId,
      detectedAt: incident.detectedAt,
      summary: incident.summary,
    }));
}

/** The status board: connection health (from tests) side by side with task failure counts (never merged). */
export function healthBoard(connections: readonly ConnectionRecord[], incidents: readonly IncidentRecord[]): readonly HealthBoardRow[] {
  return [...connections]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((connection) => {
      const own = incidents.filter((incident) => incident.connectionId === connection.id);
      const connectionIncidents = own.filter((incident) => incident.kind === 'connection');
      const taskIncidents = own.filter((incident) => incident.kind === 'task');
      const latest = own.map((incident) => incident.detectedAt).sort().at(-1) ?? null;
      return {
        connectionId: connection.id,
        providerId: connection.providerId,
        stationId: connection.stationId,
        systemId: connection.systemId,
        status: connection.status,
        lastTestedAt: connection.lastTestedAt,
        openConnectionIncidents: connectionIncidents.length,
        failedTaskCount: taskIncidents.length,
        latestIncidentAt: latest,
        taskListQuery: taskListQuery(connection.id),
      };
    });
}

// ---------------------------------------------------------------------------
// Program-zone calendar math (America/Denver; DST-aware local midnights)
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Weekday name of a YYYY-MM-DD calendar date (the date itself, zone-independent). */
export function weekdayOf(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  return WEEKDAY_NAMES[new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay()]!;
}

function dayKeyToDate(dayKey: string): Date {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

function dateToDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDayKey(dayKey: string, days: number): string {
  return dateToDayKey(new Date(dayKeyToDate(dayKey).getTime() + days * 24 * 60 * 60 * 1000));
}

/** Denver UTC offset in ms at an instant (negative behind UTC), via Intl longOffset. */
function denverOffsetMs(instantMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: PROGRAM_TIME_ZONE, timeZoneName: 'longOffset' }).formatToParts(new Date(instantMs));
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (!match) return 0; // GMT (UTC±00:00)
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60 * 1000;
}

/**
 * Exact instant (ISO) of local midnight starting the America/Denver calendar
 * day `dayKey`. DST transitions happen at 02:00 local, so a single
 * refinement pass makes the boundary exact even on switch days.
 */
export function denverMidnightInstant(dayKey: string): string {
  const base = dayKeyToDate(dayKey).getTime();
  let offset = denverOffsetMs(base + 7 * 60 * 60 * 1000); // 07:00Z is the same Denver day
  let midnight = base - offset;
  offset = denverOffsetMs(midnight);
  midnight = base - offset;
  return new Date(midnight).toISOString();
}

/**
 * The digest window for a digest date (program-zone calendar date).
 * Weekday digests cover the interval since the previous weekday digest:
 * Monday covers Friday+Saturday+Sunday (the whole weekend interval); Tuesday
 * through Friday cover the previous day. Saturday and Sunday issue nothing.
 */
export interface DigestWindow {
  readonly digestDate: string;
  readonly weekday: string;
  readonly issued: boolean;
  readonly notIssuedReason: 'weekend' | null;
  readonly coverageStart: string;
  readonly coverageEnd: string;
  readonly coverageDays: readonly string[];
}

export function digestWindow(digestDate: string): DigestWindow {
  const weekday = weekdayOf(digestDate);
  const end = denverMidnightInstant(digestDate);
  if (weekday === 'Sat' || weekday === 'Sun') {
    return { digestDate, weekday, issued: false, notIssuedReason: 'weekend', coverageStart: end, coverageEnd: end, coverageDays: [] };
  }
  const daysBack = weekday === 'Mon' ? 3 : 1; // Monday: since Friday (weekend included); Tue-Fri: previous day
  const startDay = shiftDayKey(digestDate, -daysBack);
  const coverageDays: string[] = [];
  for (let index = daysBack; index >= 1; index -= 1) coverageDays.push(shiftDayKey(digestDate, -index));
  return {
    digestDate,
    weekday,
    issued: true,
    notIssuedReason: null,
    coverageStart: denverMidnightInstant(startDay),
    coverageEnd: end,
    coverageDays,
  };
}

/** Policy world anchor objects for distribution systems (scope resolution server-side). */
export function systemObjects(systemIds: readonly string[]): readonly PolicyObject[] {
  return systemIds.map((systemId) => governanceObject({ id: systemId, kind: 'system', systemId }));
}

// ---------------------------------------------------------------------------
// The weekday digest builder
// ---------------------------------------------------------------------------

export interface DigestInput {
  /** Program-zone calendar digest date (YYYY-MM-DD). */
  readonly digestDate: string;
  /** Recipient principal id (session identity), or null for anonymous (empty digest). */
  readonly recipientId: string | null;
  readonly incidents: readonly IncidentRecord[];
  readonly connections: readonly ConnectionRecord[];
  readonly world: PolicyWorld;
  readonly policy?: PolicyEvaluator;
  /** Instant used for the scope evaluation's clock echoes (default: coverage end). */
  readonly evaluatedAt?: string;
}

/**
 * Build the weekday digest for a recipient. Weekend digest dates do not
 * issue. Entries within the coverage window are deduped by incident id,
 * admitted only within the recipient's policy scope, ordered by detection
 * time, and split into task failures (first - they carry TASK ids) and
 * connection incidents (they carry the connection task-list filter).
 */
export function buildWeekdayDigest(input: DigestInput): WeekdayDigest {
  const window = digestWindow(input.digestDate);
  if (!window.issued) {
    return {
      issued: false,
      notIssuedReason: window.notIssuedReason,
      digestDate: input.digestDate,
      weekday: window.weekday,
      coverageStart: window.coverageStart,
      coverageEnd: window.coverageEnd,
      coverageDays: window.coverageDays,
      recipientId: input.recipientId,
      taskFailures: [],
      connectionIncidents: [],
      counts: { connections: 0, tasks: 0, duplicatesDropped: 0, omittedForScope: 0 },
    };
  }

  const startMs = Date.parse(window.coverageStart);
  const endMs = Date.parse(window.coverageEnd);

  // Window membership keyed in the program zone (a browser clock never redefines the day).
  const inWindow = (incident: IncidentRecord): boolean => {
    const at = Date.parse(incident.detectedAt);
    return at >= startMs && at < endMs;
  };

  const sorted = [...input.incidents].sort((a, b) => (a.detectedAt < b.detectedAt ? -1 : a.detectedAt > b.detectedAt ? 1 : a.id < b.id ? -1 : 1));

  // Dedupe by incident id: the FIRST record wins; duplicates are counted.
  const seen = new Set<string>();
  let duplicatesDropped = 0;
  const deduped: IncidentRecord[] = [];
  for (const incident of sorted) {
    if (!inWindow(incident)) continue;
    if (seen.has(incident.id)) {
      duplicatesDropped += 1;
      continue;
    }
    seen.add(incident.id);
    deduped.push(incident);
  }

  // Scope admission through the policy engine (same entitlement path as any read).
  const evaluatedAt = input.evaluatedAt ?? window.coverageEnd;
  const admitted: IncidentRecord[] = [];
  let omittedForScope = 0;
  for (const incident of deduped) {
    const anchor = input.world.objects[incident.systemId] ?? governanceObject({ id: incident.systemId, kind: 'system', systemId: incident.systemId });
    const world = Object.freeze({ ...input.world, objects: Object.freeze({ ...input.world.objects, [anchor.id]: anchor }) });
    const verdict = gateAct({ world, clock: () => evaluatedAt, policy: input.policy }, input.recipientId, 'view-restricted-details', { kind: 'system', id: incident.systemId });
    if (verdict.ok) admitted.push(incident);
    else omittedForScope += 1;
  }

  const connectionById = new Map(input.connections.map((connection) => [connection.id, connection]));
  const taskFailures: DigestTaskEntry[] = [];
  const connectionIncidents: DigestConnectionEntry[] = [];

  for (const incident of admitted) {
    if (incident.kind === 'task' && incident.taskId !== null) {
      taskFailures.push({
        incidentId: incident.id,
        taskId: incident.taskId,
        connectionId: incident.connectionId,
        systemId: incident.systemId,
        detectedAt: incident.detectedAt,
        summary: incident.summary,
      });
    } else if (incident.kind === 'connection' && incident.connectionId !== null) {
      const connection = connectionById.get(incident.connectionId);
      // Scope-consistent task count: only tasks this digest recipient may see.
      const failedTaskCount = admitted.filter((candidate) => candidate.kind === 'task' && candidate.connectionId === incident.connectionId).length;
      connectionIncidents.push({
        incidentId: incident.id,
        connectionId: incident.connectionId,
        status: connection?.status ?? 'untested',
        systemId: incident.systemId,
        detectedAt: incident.detectedAt,
        summary: incident.summary,
        failedTaskCount,
        taskListQuery: taskListQuery(incident.connectionId),
      });
    }
  }

  return {
    issued: true,
    notIssuedReason: null,
    digestDate: input.digestDate,
    weekday: window.weekday,
    coverageStart: window.coverageStart,
    coverageEnd: window.coverageEnd,
    coverageDays: window.coverageDays,
    recipientId: input.recipientId,
    // Task failures first (FR-014 digest links to failed tasks first).
    taskFailures,
    connectionIncidents,
    counts: {
      connections: connectionIncidents.length,
      tasks: taskFailures.length,
      duplicatesDropped,
      omittedForScope,
    },
  };
}
