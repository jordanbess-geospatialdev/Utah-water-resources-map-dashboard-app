/**
 * Sign-out and account-switch cleanup (FR-027 / technical specification:
 * "Expire and clear sensitive device data according to approved policy,
 * account switching and logout behavior").
 *
 * POLICY (the approved behavior this module implements):
 * - Offline drafts are ACCOUNT-SCOPED cached data: readings, visits and
 *   photo/audio attachment manifests captured under one account are
 *   cleared from the device when that account signs out - accepted,
 *   conflicted and rejected drafts alike (the server's audit trail, not
 *   the device, is the record of what synchronized).
 * - Clearing is exact: only the named account's partition is removed; a
 *   second account's queued drafts survive untouched (verified by the
 *   no-residue tests in cleanup.test.ts).
 * - Account switch clears BEFORE loading the next account's queue, so no
 *   moment exists where two accounts' sensitive drafts are resident.
 *
 * Pure module: no clock reads (`now` injected), no storage beyond the
 * injected OfflineStore port.
 */
import type { OfflineEnvelope, OfflineStore } from './store';

/** The cleanup policy in one line, surfaced by the UI next to the sign-out affordance. */
export const ACCOUNT_DATA_CLEARANCE_POLICY =
  'Signing out removes this account\'s offline drafts (readings, visits, photo and audio attachment manifests) from this device; server records are unaffected.';

/** What one cleanup removed (evidence for the sign-out audit line in the UI). */
export interface CleanupReport {
  readonly accountId: string;
  readonly removedDraftIds: readonly string[];
  readonly clearedAt: string;
  readonly reason: 'sign-out' | 'account-switch';
}

function clearAccount(store: OfflineStore, accountId: string, now: string, reason: CleanupReport['reason']): CleanupReport {
  const before: readonly OfflineEnvelope[] = store.load(accountId);
  const removedDraftIds = before.map((envelope) => envelope.draftId);
  store.clearByAccount(accountId);
  return { accountId, removedDraftIds, clearedAt: now, reason };
}

/**
 * Sign out: clear the account's cached offline data. Returns the removal
 * report (which drafts left the device) plus the store's remaining
 * account partitions - empty residue for this account is the tested
 * postcondition.
 */
export function signOut(store: OfflineStore, accountId: string, now: string): CleanupReport {
  return clearAccount(store, accountId, now, 'sign-out');
}

/**
 * Account switch: clear the outgoing account's sensitive drafts FIRST,
 * then load the incoming account's queue. The returned state is exactly
 * what the fresh session should render: nothing from `fromAccountId`
 * remains, and the incoming queue was never mixed with it.
 */
export function switchAccount(
  store: OfflineStore,
  fromAccountId: string,
  toAccountId: string,
  now: string,
): { readonly cleared: CleanupReport; readonly loaded: readonly OfflineEnvelope[] } {
  const cleared = clearAccount(store, fromAccountId, now, 'account-switch');
  const loaded = store.load(toAccountId);
  return { cleared, loaded };
}

/**
 * Verification helper (used by the tests and available to the shell's
 * sign-out confirmation): no envelope attributed to `accountId` remains
 * anywhere the store can see.
 */
export function hasAccountResidue(store: OfflineStore, accountId: string): boolean {
  if (store.accounts.includes(accountId)) return true;
  return store.accounts.some((partition) => store.load(partition).some((envelope) => envelope.accountId === accountId));
}
