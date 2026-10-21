/**
 * Per-account notification (subscription) preferences (FR-009, FR-025).
 *
 * "Subscriptions distinguish new sites, site edits, no signal and threshold
 * violations" - this module stores WHICH events the account wants, at WHAT
 * cadence, over a site or system scope, with a channel note placeholder.
 * Delivery itself is a later task: nothing here sends anything, and the
 * channel field is deliberately a display placeholder until the delivery
 * pipeline lands (FR-025 boundaries).
 *
 * Scope validation is POLICY-DRIVEN and mirrors the favorites rule:
 * subscribing to a SITE requires the site to be at least readable (public
 * projection or an engine-allowed protected read) at save time; subscribing
 * to a SYSTEM requires at least one readable station in it. A restricted
 * site outside the account's readable scope REJECTS with the engine's
 * denial reason (FR-025 boundaries) - a subscription, like a favorite,
 * never extends authority.
 *
 * Persistence: same versioned-schema discipline as favorites.ts (per-account
 * key, unknown/corrupt versions reset, injected clock, injected storage).
 */
import { isReadableForPrincipal, type PolicyEvaluator, type PolicyWorldMirror } from '../operations/assignedScope';
import type { FavoriteStorage } from './favorites';
import { inMemoryStorage, localStorageAdapter } from './favorites';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** FR-025 event kinds a subscription may select. */
export type NotificationEventKind = 'new-site' | 'site-edit' | 'no-signal' | 'threshold';

export const NOTIFICATION_EVENT_KINDS: readonly NotificationEventKind[] = ['new-site', 'site-edit', 'no-signal', 'threshold'];

export const NOTIFICATION_EVENT_LABELS: Readonly<Record<NotificationEventKind, string>> = {
  'new-site': 'New sites',
  'site-edit': 'Site edits',
  'no-signal': 'No signal',
  threshold: 'Threshold violations',
};

/** Delivery cadence (enum; delivery mechanics arrive with the FR-025 pipeline). */
export type NotificationCadence = 'immediate' | 'daily' | 'weekly';

export const NOTIFICATION_CADENCES: readonly NotificationCadence[] = ['immediate', 'daily', 'weekly'];

export const NOTIFICATION_CADENCE_LABELS: Readonly<Record<NotificationCadence, string>> = {
  immediate: 'Immediately',
  daily: 'Daily digest',
  weekly: 'Weekly digest',
};

/** Channel note placeholder: free-form display text, never a credential or address book. */
export const CHANNEL_NOTE_MAX_LENGTH = 120;

export interface NotificationScope {
  readonly kind: 'site' | 'system';
  readonly id: string;
}

export interface NotificationPref {
  readonly id: string;
  readonly scope: NotificationScope;
  readonly events: readonly NotificationEventKind[];
  readonly cadence: NotificationCadence;
  readonly channelNote: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Versioned persisted schema
// ---------------------------------------------------------------------------

export const NOTIFICATION_PREFS_SCHEMA_VERSION = 1;

export interface NotificationPrefsSnapshotV1 {
  readonly version: 1;
  readonly prefs: readonly NotificationPref[];
}

export function notificationPrefsStorageKey(principalId: string): string {
  return `utah-water.notification-prefs.v${NOTIFICATION_PREFS_SCHEMA_VERSION}.${principalId}`;
}

function validEvents(events: unknown): readonly NotificationEventKind[] | null {
  if (!Array.isArray(events) || events.length === 0) return null;
  const kinds: NotificationEventKind[] = [];
  for (const event of events) {
    if (typeof event !== 'string' || !(NOTIFICATION_EVENT_KINDS as readonly string[]).includes(event)) return null;
    kinds.push(event as NotificationEventKind);
  }
  return [...new Set(kinds)].sort();
}

function parseSnapshot(raw: string | null): NotificationPrefsSnapshotV1 {
  if (raw === null) return { version: NOTIFICATION_PREFS_SCHEMA_VERSION, prefs: [] };
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; prefs?: unknown };
    if (parsed.version !== NOTIFICATION_PREFS_SCHEMA_VERSION || !Array.isArray(parsed.prefs)) throw new Error('unknown schema');
    const prefs: NotificationPref[] = [];
    for (const entry of parsed.prefs) {
      const candidate = entry as Partial<NotificationPref> & { scope?: Partial<NotificationScope> };
      if (
        typeof candidate.id !== 'string' ||
        !candidate.scope ||
        (candidate.scope.kind !== 'site' && candidate.scope.kind !== 'system') ||
        typeof candidate.scope.id !== 'string' ||
        typeof candidate.cadence !== 'string' ||
        !(NOTIFICATION_CADENCES as readonly string[]).includes(candidate.cadence)
      ) {
        continue;
      }
      const events = validEvents(candidate.events);
      if (events === null) continue;
      prefs.push({
        id: candidate.id,
        scope: { kind: candidate.scope.kind, id: candidate.scope.id },
        events,
        cadence: candidate.cadence as NotificationCadence,
        channelNote: typeof candidate.channelNote === 'string' ? candidate.channelNote : '',
        createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
      });
    }
    return { version: NOTIFICATION_PREFS_SCHEMA_VERSION, prefs };
  } catch {
    return { version: NOTIFICATION_PREFS_SCHEMA_VERSION, prefs: [] };
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type SetPrefResult = { ok: true; pref: NotificationPref } | { ok: false; reason: 'unreadable-scope'; detail: string };

export interface SetPrefInput {
  readonly scope: NotificationScope;
  readonly events: readonly NotificationEventKind[];
  readonly cadence: NotificationCadence;
  readonly channelNote?: string;
}

export interface NotificationPrefsStore {
  /** Validate-and-save: the scope target must be within the account's readable scope. */
  setPref(input: SetPrefInput): SetPrefResult;
  removePref(prefId: string): { ok: boolean; removed: boolean };
  listPrefs(): readonly NotificationPref[];
}

export interface NotificationPrefsStoreInput {
  readonly principalId: string;
  readonly world: PolicyWorldMirror;
  readonly policy: PolicyEvaluator;
  readonly now: Date | string;
  readonly storage?: FavoriteStorage;
}

function stationIdsOfWorld(world: PolicyWorldMirror): readonly { id: string; systemId: string }[] {
  return Object.values(world.objects)
    .filter((object) => object.kind === 'station')
    .map((object) => ({ id: object.id, systemId: object.systemId ?? '' }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function createNotificationPrefsStore(input: NotificationPrefsStoreInput): NotificationPrefsStore {
  const { principalId, world, policy, now } = input;
  const storage = input.storage ?? localStorageAdapter() ?? inMemoryStorage();
  const key = notificationPrefsStorageKey(principalId);
  let snapshot = parseSnapshot(storage.getItem(key));

  const readable = (stationId: string) => isReadableForPrincipal(principalId, stationId, world, policy, now);

  const scopeReadable = (scope: NotificationScope): { readable: boolean; detail: string } => {
    if (scope.kind === 'site') {
      if (world.objects[scope.id] === undefined) return { readable: false, detail: `unknown site "${scope.id}"` };
      const verdict = readable(scope.id);
      return { readable: verdict.readable, detail: verdict.reason };
    }
    const stationsInSystem = stationIdsOfWorld(world).filter((station) => station.systemId === scope.id);
    if (stationsInSystem.length === 0) return { readable: false, detail: `no station in system "${scope.id}"` };
    for (const station of stationsInSystem) {
      if (readable(station.id).readable) return { readable: true, detail: `station ${station.id} readable` };
    }
    return { readable: false, detail: `no readable station in system "${scope.id}"` };
  };

  return {
    setPref(candidate: SetPrefInput): SetPrefResult {
      const events = validEvents(candidate.events);
      if (events === null || !(NOTIFICATION_CADENCES as readonly string[]).includes(candidate.cadence)) {
        return { ok: false, reason: 'unreadable-scope', detail: 'invalid events or cadence' };
      }
      const verdict = scopeReadable(candidate.scope);
      if (!verdict.readable) {
        // FR-025 boundary: subscribing to a restricted site outside the
        // account's readable scope rejects with the engine's denial reason.
        return { ok: false, reason: 'unreadable-scope', detail: verdict.detail };
      }
      const at = typeof now === 'string' ? now : new Date(now.getTime()).toISOString();
      const scopeKey = `${candidate.scope.kind}:${candidate.scope.id}`;
      const existing = snapshot.prefs.find((pref) => `${pref.scope.kind}:${pref.scope.id}` === scopeKey);
      const pref: NotificationPref = {
        id: existing?.id ?? `pref-${Math.abs(Array.from(scopeKey).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7))}`,
        scope: candidate.scope,
        events,
        cadence: candidate.cadence,
        channelNote: (candidate.channelNote ?? '').slice(0, CHANNEL_NOTE_MAX_LENGTH),
        createdAt: existing?.createdAt ?? at,
      };
      snapshot = {
        version: NOTIFICATION_PREFS_SCHEMA_VERSION,
        prefs: [...snapshot.prefs.filter((p) => p.id !== pref.id), pref],
      };
      storage.setItem(key, JSON.stringify(snapshot));
      return { ok: true, pref };
    },

    removePref(prefId: string): { ok: boolean; removed: boolean } {
      const remaining = snapshot.prefs.filter((pref) => pref.id !== prefId);
      const removed = remaining.length !== snapshot.prefs.length;
      snapshot = { version: NOTIFICATION_PREFS_SCHEMA_VERSION, prefs: remaining };
      if (removed) storage.setItem(key, JSON.stringify(snapshot));
      return { ok: true, removed };
    },

    listPrefs(): readonly NotificationPref[] {
      return snapshot.prefs;
    },
  };
}
