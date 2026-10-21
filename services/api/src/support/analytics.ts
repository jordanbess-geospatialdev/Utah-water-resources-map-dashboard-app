/**
 * Opt-in, consent-gated usage analytics (WD-020; FR-017, FR-068).
 *
 * Technical specification, "Proposed service targets and operations":
 * "Obtain a privacy decision before session-replay analytics; mask sensitive
 * fields and exclude administrative/field content by default." This module
 * implements the collection gate for the PROPOSED first-party analytics in
 * docs/training/PRIVACY-PROPOSAL.md. NOTHING here is enabled by default:
 *
 * - NO event is recorded unless the account has explicitly granted consent
 *   (persisted per account, versioned against the proposal it answered).
 * - Events are structured against a STATIC field allowlist (page-view,
 *   task-completed). An event carrying any field outside the allowlist is
 *   dropped whole - never partially recorded, never "cleaned" into shape.
 * - EXPLICIT EXCLUSIONS (structural, not policy prose): credentials, query
 *   content beyond dimension KEYS (not even values travel), internal records,
 *   screenshots, persona/role, free text of any kind. The allowlist admits
 *   none of these shapes, so a caller cannot smuggle one in.
 * - Withdrawal stops collection IMMEDIATELY and deletes the account's
 *   pending raw events in the same call (tested).
 * - Retention is PROPOSED and PENDING owner decision
 *   (PRIVACY-PROPOSAL.md): raw events 90 days, day-keyed aggregates
 *   13 months. The constants implement the proposal so the owner signs off
 *   on real behavior, not intent.
 * - Reporting days are keyed in the program zone (America/Denver), so a
 *   user's browser time never redefines a reporting day (technical
 *   specification, "Numerical and temporal rules").
 *
 * Pure in-memory module with an injectable key-value persistence port,
 * injectable clock, and byte-stable serialization (determinism tested).
 */
import type { SupportDimensionKey } from './supportContext.ts';
import { SUPPORT_DIMENSION_KEYS } from './supportContext.ts';

// ---------------------------------------------------------------------------
// Policy identity and retention (PROPOSED - PENDING owner decision)
// ---------------------------------------------------------------------------

/**
 * Version of the analytics privacy proposal the consent decision answered
 * (docs/training/PRIVACY-PROPOSAL.md revision). A stored consent record
 * naming a different version is treated as absent: consent must be re-asked,
 * never inherited across proposal changes.
 */
export const ANALYTICS_POLICY_VERSION = '2026-10-21.1';

/** PROPOSED retention for raw consented events (PENDING owner decision; PRIVACY-PROPOSAL.md D-2). */
export const RAW_RETENTION_DAYS = 90;
/** PROPOSED retention for day-keyed aggregates (13 months; PENDING owner decision; PRIVACY-PROPOSAL.md D-2). */
export const AGGREGATED_RETENTION_MONTHS = 13;

/** Program reporting zone (technical specification: usually America/Denver for Utah). */
export const PROGRAM_TIME_ZONE = 'America/Denver';

// ---------------------------------------------------------------------------
// The static field allowlist
// ---------------------------------------------------------------------------

export type AnalyticsEventKind = 'page-view' | 'task-completed';

/**
 * Every field a consented event may carry. This list is the whole surface -
 * `recordEvent` rejects an event whose own keys are not exactly a subset of
 * it (with `kind` required). There is deliberately no field for credentials,
 * query values, notes, persona, screenshots or record payloads.
 */
export const EVENT_FIELD_ALLOWLIST = ['kind', 'routeId', 'dimensionKeys', 'taskStepId', 'appVersion', 'occurredAt'] as const;

export type AnalyticsEventField = (typeof EVENT_FIELD_ALLOWLIST)[number];

export interface AnalyticsEvent {
  readonly kind: AnalyticsEventKind;
  /** Governed route id (e.g. 'discovery', 'site-detail'), pattern-checked. */
  readonly routeId?: string;
  /** WHICH filter dimensions were used - keys only, never values (FR-017 exclusion). */
  readonly dimensionKeys?: readonly string[];
  /** Training checklist step id (docs/training/tasks-*.md), pattern-checked. */
  readonly taskStepId?: string;
  readonly appVersion?: string;
  /** Set by the service from the injected clock; a caller-supplied value is overwritten. */
  readonly occurredAt?: string;
}

const GOVERNED_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DIMENSION_KEY_SET = new Set<string>(SUPPORT_DIMENSION_KEYS);

// ---------------------------------------------------------------------------
// Consent ledger (persisted per account)
// ---------------------------------------------------------------------------

export const CONSENT_SCHEMA_VERSION = 1;

export interface AnalyticsConsentRecord {
  readonly accountId: string;
  /** Explicit opt-in. Absent/false/withdrawn all mean: record NOTHING. */
  readonly granted: boolean;
  readonly decidedAt: string;
  /** The PRIVACY-PROPOSAL revision the account answered (stale => re-ask). */
  readonly policyVersion: string;
}

/** Minimal synchronous key-value storage (DOM Storage or a Map). */
export interface ConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function inMemoryConsentStorage(seed?: Readonly<Record<string, string>>): ConsentStorage {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

export function consentStorageKey(accountId: string): string {
  return `utah-water.analytics.consent.v${CONSENT_SCHEMA_VERSION}.${accountId}`;
}

/** Load (and validate) the persisted consent record for an account; null when absent/corrupt/stale. */
export function readConsent(storage: ConsentStorage, accountId: string): AnalyticsConsentRecord | null {
  const raw = storage.getItem(consentStorageKey(accountId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AnalyticsConsentRecord>;
    if (typeof parsed.accountId !== 'string' || typeof parsed.granted !== 'boolean') return null;
    if (typeof parsed.decidedAt !== 'string' || typeof parsed.policyVersion !== 'string') return null;
    return { accountId: parsed.accountId, granted: parsed.granted, decidedAt: parsed.decidedAt, policyVersion: parsed.policyVersion };
  } catch {
    return null; // corrupt persistence is consent ABSENT, never guessed
  }
}

// ---------------------------------------------------------------------------
// Events and aggregation
// ---------------------------------------------------------------------------

export interface RecordedEvent {
  readonly kind: AnalyticsEventKind;
  readonly routeId: string | null;
  readonly dimensionKeys: readonly string[];
  readonly taskStepId: string | null;
  readonly appVersion: string;
  readonly occurredAt: string;
  /** Program-zone day key (YYYY-MM-DD in America/Denver). */
  readonly day: string;
  readonly accountId: string;
}

export interface DailyAggregate {
  /** Program-zone day key. */
  readonly day: string;
  readonly kind: AnalyticsEventKind;
  readonly routeId: string | null;
  readonly count: number;
}

/** Program-zone day key for an instant (UTC ISO string -> America/Denver calendar day). */
export function programDayKey(instant: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: PROGRAM_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
  return parts; // en-CA gives YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type RecordRefusalReason = 'consent-required' | 'unknown-account' | 'field-not-allowed' | 'bad-field-value';

export type RecordOutcome = { recorded: true; event: RecordedEvent } | { recorded: false; reason: RecordRefusalReason; detail?: string };

export interface AnalyticsServiceInput {
  /** Known fixture account ids (principals.json users). Required: consent is per ACCOUNT. */
  readonly knownAccountIds: readonly string[];
  readonly clock: () => Date | string;
  readonly storage?: ConsentStorage;
  readonly appVersion?: string;
}

export interface AnalyticsService {
  grantConsent(accountId: string): { ok: true; record: AnalyticsConsentRecord } | { ok: false; reason: 'unknown-account' };
  withdrawConsent(accountId: string): { ok: true; deletedPendingEvents: number } | { ok: false; reason: 'unknown-account' };
  consentFor(accountId: string): AnalyticsConsentRecord | null;
  recordEvent(accountId: string, event: Readonly<AnalyticsEvent>): RecordOutcome;
  pendingEvents(accountId: string): readonly RecordedEvent[];
  /** Drop raw events older than the PROPOSED 90-day window (PENDING owner decision). */
  purgeExpiredRaw(now: Date | string): number;
  /** Day-keyed route aggregates for the last `days` program-zone days (no account ids inside). */
  dailyAggregates(days?: number): readonly DailyAggregate[];
  /** Drop aggregates older than the PROPOSED 13-month window (PENDING owner decision). */
  purgeExpiredAggregates(now: Date | string): number;
  serialize(): string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function createAnalyticsService(input: AnalyticsServiceInput): AnalyticsService {
  const known = new Set(input.knownAccountIds);
  const storage = input.storage ?? inMemoryConsentStorage();
  const appVersion = input.appVersion ?? '0.1.0';

  const nowIso = (): string => {
    const now = input.clock();
    return typeof now === 'string' ? now : new Date((now as Date).getTime()).toISOString();
  };

  let rawEvents: RecordedEvent[] = [];

  const writeConsent = (record: AnalyticsConsentRecord): void => {
    storage.setItem(consentStorageKey(record.accountId), JSON.stringify(record));
  };

  const grantedFor = (accountId: string): boolean => {
    const record = readConsent(storage, accountId);
    return record !== null && record.granted && record.policyVersion === ANALYTICS_POLICY_VERSION;
  };

  return {
    grantConsent(accountId) {
      if (!known.has(accountId)) return { ok: false, reason: 'unknown-account' };
      const record: AnalyticsConsentRecord = { accountId, granted: true, decidedAt: nowIso(), policyVersion: ANALYTICS_POLICY_VERSION };
      writeConsent(record);
      return { ok: true, record };
    },

    withdrawConsent(accountId) {
      if (!known.has(accountId)) return { ok: false, reason: 'unknown-account' };
      // Collection stops IMMEDIATELY and pending raw events are deleted in
      // the same call - withdrawal is not a soft flag (tested).
      const before = rawEvents.length;
      rawEvents = rawEvents.filter((event) => event.accountId !== accountId);
      writeConsent({ accountId, granted: false, decidedAt: nowIso(), policyVersion: ANALYTICS_POLICY_VERSION });
      return { ok: true, deletedPendingEvents: before - rawEvents.length };
    },

    consentFor(accountId) {
      return readConsent(storage, accountId);
    },

    recordEvent(accountId, event) {
      if (!known.has(accountId)) return { recorded: false, reason: 'unknown-account' };
      if (!grantedFor(accountId)) return { recorded: false, reason: 'consent-required' };

      // Static allowlist: every own key must be a known event field, and the
      // kind must be a known kind. Hostile extra fields drop the WHOLE event.
      const allowed = new Set<string>(EVENT_FIELD_ALLOWLIST);
      const ownKeys = Object.keys(event as Record<string, unknown>);
      const illegal = ownKeys.filter((key) => !allowed.has(key));
      if (illegal.length > 0) return { recorded: false, reason: 'field-not-allowed', detail: illegal.join(',') };
      if (event.kind !== 'page-view' && event.kind !== 'task-completed') return { recorded: false, reason: 'field-not-allowed', detail: 'kind' };

      // Value shapes: governed ids only; dimension KEYS only (never values).
      if (event.routeId !== undefined && !GOVERNED_ID_PATTERN.test(event.routeId)) return { recorded: false, reason: 'bad-field-value', detail: 'routeId' };
      if (event.taskStepId !== undefined && !GOVERNED_ID_PATTERN.test(event.taskStepId)) return { recorded: false, reason: 'bad-field-value', detail: 'taskStepId' };
      if (event.dimensionKeys !== undefined) {
        if (!Array.isArray(event.dimensionKeys) || event.dimensionKeys.some((key) => !DIMENSION_KEY_SET.has(key))) {
          return { recorded: false, reason: 'bad-field-value', detail: 'dimensionKeys' };
        }
      }

      const occurredAt = nowIso(); // server clock wins; caller-supplied occurredAt is ignored
      const recorded: RecordedEvent = Object.freeze({
        kind: event.kind,
        routeId: event.routeId ?? null,
        dimensionKeys: Object.freeze([...(event.dimensionKeys ?? [])].sort()),
        taskStepId: event.taskStepId ?? null,
        appVersion,
        occurredAt,
        day: programDayKey(occurredAt),
        accountId,
      });
      rawEvents.push(recorded);
      return { recorded: true, event: recorded };
    },

    pendingEvents(accountId) {
      return rawEvents.filter((event) => event.accountId === accountId);
    },

    purgeExpiredRaw(now) {
      const cutoff = (typeof now === 'string' ? Date.parse(now) : now.getTime()) - RAW_RETENTION_DAYS * MS_PER_DAY;
      const before = rawEvents.length;
      rawEvents = rawEvents.filter((event) => Date.parse(event.occurredAt) >= cutoff);
      return before - rawEvents.length;
    },

    dailyAggregates(days = 365) {
      const counts = new Map<string, number>();
      for (const event of rawEvents) {
        const key = `${event.day}|${event.kind}|${event.routeId ?? ''}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([key, count]) => {
          const [day, kind, routeId] = key.split('|');
          return { day: day!, kind: kind as AnalyticsEventKind, routeId: routeId === '' ? null : routeId!, count };
        })
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : (a.routeId ?? '') < (b.routeId ?? '') ? -1 : 1))
        .slice(-days);
    },

    purgeExpiredAggregates(now) {
      // Aggregates are derived views; the retention purge is realized at the
      // reporting boundary by dropping days older than the window.
      const cutoff = (typeof now === 'string' ? Date.parse(now) : now.getTime()) - AGGREGATED_RETENTION_MONTHS * 30 * MS_PER_DAY;
      const cutoffDay = programDayKey(new Date(cutoff).toISOString());
      const before = rawEvents.length;
      rawEvents = rawEvents.filter((event) => event.day >= cutoffDay);
      return before - rawEvents.length;
    },

    serialize() {
      return JSON.stringify({ policyVersion: ANALYTICS_POLICY_VERSION, rawEvents }, null, 0);
    },
  };
}
