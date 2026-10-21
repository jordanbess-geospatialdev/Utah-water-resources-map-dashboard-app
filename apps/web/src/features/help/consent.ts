/**
 * Browser-side analytics consent persistence (WD-020; FR-017, FR-068).
 *
 * The recording gate itself lives in services/api/src/support/analytics.ts;
 * this module is the browser mirror of the SAME versioned decision record,
 * persisted per account in localStorage (in-memory fallback for tests/SSR):
 *
 * - Consent is OPT-IN: absent, corrupt or stale records all mean "not
 *   granted" - the UI must ask, never guess and never inherit across policy
 *   versions.
 * - The record names the privacy proposal revision it answered
 *   (ANALYTICS_POLICY_VERSION mirrors services/api ANALYTICS_POLICY_VERSION;
 *   bump BOTH together with docs/training/PRIVACY-PROPOSAL.md).
 * - Withdrawal is immediate on the service side (pending events deleted
 *   there); locally it clears the stored grant so no further consented call
 *   can even be attempted from this browser.
 *
 * Pure module: no DOM access beyond the injected storage port, no clock
 * reads (the caller supplies `now`).
 */

export const CONSENT_SCHEMA_VERSION = 1;

/**
 * The privacy proposal revision a consent decision answers. Mirror of
 * services/api/src/support/analytics.ts ANALYTICS_POLICY_VERSION
 * ('2026-10-21.1'); change both together or stored consent goes stale.
 */
export const ANALYTICS_POLICY_VERSION = '2026-10-21.1';

export type ConsentStatus = 'granted' | 'withheld' | 'unanswered';

export interface AnalyticsConsentChoice {
  readonly accountId: string;
  readonly granted: boolean;
  readonly decidedAt: string;
  readonly policyVersion: string;
}

/** Minimal synchronous key-value storage (satisfied by DOM Storage and Maps). */
export interface ConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function inMemoryStorage(seed?: Readonly<Record<string, string>>): ConsentStorage {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/** localStorage adapter; null when the platform has none (SSR, restricted environments). */
export function localStorageAdapter(): ConsentStorage | null {
  const candidate = (globalThis as { localStorage?: Storage }).localStorage;
  if (candidate === undefined || candidate === null) return null;
  return {
    getItem: (key) => candidate.getItem(key),
    setItem: (key, value) => void candidate.setItem(key, value),
    removeItem: (key) => void candidate.removeItem(key),
  };
}

export function consentStorageKey(accountId: string): string {
  return `utah-water.analytics.consent.v${CONSENT_SCHEMA_VERSION}.${accountId}`;
}

/** Load and validate a stored decision. Null when absent/corrupt - consent is never guessed. */
export function readConsent(storage: ConsentStorage, accountId: string): AnalyticsConsentChoice | null {
  const raw = storage.getItem(consentStorageKey(accountId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AnalyticsConsentChoice>;
    if (typeof parsed.accountId !== 'string' || typeof parsed.granted !== 'boolean') return null;
    if (typeof parsed.decidedAt !== 'string' || typeof parsed.policyVersion !== 'string') return null;
    return { accountId: parsed.accountId, granted: parsed.granted, decidedAt: parsed.decidedAt, policyVersion: parsed.policyVersion };
  } catch {
    return null;
  }
}

/** The consent status the UI should render: a stale-policy grant is UNANSWERED (re-ask). */
export function consentStatus(storage: ConsentStorage, accountId: string, policyVersion: string = ANALYTICS_POLICY_VERSION): ConsentStatus {
  const record = readConsent(storage, accountId);
  if (record === null || record.policyVersion !== policyVersion) return 'unanswered';
  return record.granted ? 'granted' : 'withheld';
}

export interface RecordConsentInput {
  readonly accountId: string;
  readonly granted: boolean;
  readonly now: Date | string;
  readonly policyVersion?: string;
}

/** Persist an explicit grant or withdrawal decision. */
export function recordConsent(storage: ConsentStorage, input: RecordConsentInput): AnalyticsConsentChoice {
  const decidedAt = typeof input.now === 'string' ? input.now : new Date(input.now.getTime()).toISOString();
  const record: AnalyticsConsentChoice = {
    accountId: input.accountId,
    granted: input.granted,
    decidedAt,
    policyVersion: input.policyVersion ?? ANALYTICS_POLICY_VERSION,
  };
  storage.setItem(consentStorageKey(input.accountId), JSON.stringify(record));
  return record;
}

/** Clear a stored decision (used on logout/account switch so nothing leaks across accounts). */
export function clearConsent(storage: ConsentStorage, accountId: string): void {
  storage.removeItem(consentStorageKey(accountId));
}
