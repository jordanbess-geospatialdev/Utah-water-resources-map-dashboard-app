/**
 * Per-account favorites store (FR-009, FR-052).
 *
 * "A registered user favorites any published site, opens its charts and
 * permitted photos, and manages personal subscriptions; removing a favorite
 * or subscription persists and does not alter a site's authority or
 * ownership."
 *
 * Rules implemented here, all against the injected policy port (the real
 * entitlement engine in tests; the fixture mirror at runtime):
 *
 * - Per-account: the store is keyed by principal id; one account never sees
 *   another's favorites.
 * - Readability at ADD time AND at READ time: adding validates the site is
 *   at least readable (published public projection, or a protected read the
 *   engine allows); every listing re-validates, so a site that later became
 *   restricted degrades to `omitted-with-notice` - it is NOT silently
 *   deleted (the favorite returns if the site is republished or a grant is
 *   added) and it NEVER leaks operational data.
 * - Removal persists.
 * - FAVORITES CARRY NO AUTHORITY: nothing in this module (or anywhere in
 *   the operations workspace derivation) consults the favorites list when
 *   deciding what a viewer may read. A favorite is an own-preference
 *   record, exactly the DOCUMENTED_BOUNDARIES `favoriting-grants-nothing`
 *   boundary; siteWorkspace.test.ts asserts the engine still denies every
 *   protected read for a favorited restricted site.
 *
 * Persistence: versioned JSON schema in the injected key-value storage
 * (localStorage in the browser, an in-memory Map in tests). Unknown or
 * corrupt versions reset to empty rather than guessing (same discipline as
 * viewState). Clock is injected; the module never reads Date.now().
 */
import { isReadableForPrincipal, type PolicyEvaluator, type PolicyWorldMirror } from '../operations/assignedScope';

// ---------------------------------------------------------------------------
// Storage port
// ---------------------------------------------------------------------------

/** Minimal synchronous key-value storage (satisfied by DOM Storage and Maps). */
export interface FavoriteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory storage (tests; also the fallback when localStorage is unavailable). */
export function inMemoryStorage(seed?: Readonly<Record<string, string>>): FavoriteStorage {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/** localStorage adapter; null when the platform has none (SSR, restricted environments). */
export function localStorageAdapter(): FavoriteStorage | null {
  const candidate = (globalThis as { localStorage?: Storage }).localStorage;
  if (candidate === undefined || candidate === null) return null;
  return {
    getItem: (key) => candidate.getItem(key),
    setItem: (key, value) => candidate.setItem(key, value),
    removeItem: (key) => candidate.removeItem(key),
  };
}

// ---------------------------------------------------------------------------
// Versioned persisted schema
// ---------------------------------------------------------------------------

export const FAVORITES_SCHEMA_VERSION = 1;

export interface FavoriteRecord {
  readonly stationId: string;
  readonly addedAt: string;
}

export interface FavoritesSnapshotV1 {
  readonly version: 1;
  readonly favorites: readonly FavoriteRecord[];
}

/** Storage key per account: schema-namespace + principal id. */
export function favoritesStorageKey(principalId: string): string {
  return `utah-water.favorites.v${FAVORITES_SCHEMA_VERSION}.${principalId}`;
}

function parseSnapshot(raw: string | null): FavoritesSnapshotV1 {
  if (raw === null) return { version: FAVORITES_SCHEMA_VERSION, favorites: [] };
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; favorites?: unknown };
    if (parsed.version !== FAVORITES_SCHEMA_VERSION || !Array.isArray(parsed.favorites)) throw new Error('unknown schema');
    const favorites: FavoriteRecord[] = [];
    for (const entry of parsed.favorites) {
      const candidate = entry as Partial<FavoriteRecord>;
      if (typeof candidate.stationId !== 'string' || typeof candidate.addedAt !== 'string') continue; // malformed row dropped
      favorites.push({ stationId: candidate.stationId, addedAt: candidate.addedAt });
    }
    favorites.sort((a, b) => (a.addedAt < b.addedAt ? -1 : a.stationId < b.stationId ? -1 : 1));
    return { version: FAVORITES_SCHEMA_VERSION, favorites };
  } catch {
    // Unknown version or corrupt payload: reset to empty, never guess (the
    // same rule viewState applies to serialized view links).
    return { version: FAVORITES_SCHEMA_VERSION, favorites: [] };
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type FavoriteStatus = 'ok' | 'omitted-with-notice';

export interface FavoriteView {
  readonly stationId: string;
  readonly addedAt: string;
  readonly status: FavoriteStatus;
  /** Engine decision reason behind the status ('ALLOW_PUBLIC_READ', 'ALLOW_PROTECTED', or a DENY_* reason). */
  readonly reason: string;
  /** True when the site is readable only through an assignment (not the public projection). */
  readonly viaAssignment: boolean;
}

export type AddFavoriteResult = { ok: true; at: string } | { ok: false; reason: string };

export interface FavoritesStore {
  /** Validate-and-add: rejects sites not readable for THIS account at add time. */
  addFavorite(stationId: string): AddFavoriteResult;
  /** Remove persists immediately; removing a missing favorite is a no-op success. */
  removeFavorite(stationId: string): { ok: boolean; removed: boolean };
  /** Read-time-validated list (omitted-with-notice entries included). */
  listFavorites(): readonly FavoriteView[];
  /** Persisted record count without read-time filtering (diagnostics only). */
  recordCount(): number;
}

export interface FavoritesStoreInput {
  readonly principalId: string;
  readonly world: PolicyWorldMirror;
  readonly policy: PolicyEvaluator;
  readonly now: Date | string;
  readonly storage?: FavoriteStorage;
}

/**
 * Create the per-account favorites store. Anonymous visitors have no
 * account: callers render the signed-out state instead of creating a store
 * (there is deliberately no shared anonymous favorites bucket).
 */
export function createFavoritesStore(input: FavoritesStoreInput): FavoritesStore {
  const { principalId, world, policy, now } = input;
  const storage = input.storage ?? localStorageAdapter() ?? inMemoryStorage();
  const key = favoritesStorageKey(principalId);
  let snapshot = parseSnapshot(storage.getItem(key));

  const persist = (): void => {
    storage.setItem(key, JSON.stringify(snapshot));
  };

  const readable = (stationId: string) => isReadableForPrincipal(principalId, stationId, world, policy, now);

  return {
    addFavorite(stationId: string): AddFavoriteResult {
      const verdict = readable(stationId);
      if (!verdict.readable) {
        // FR-025/FR-052 boundary: a favorite may only target a published or
        // otherwise readable object. The denial reason travels to the UI.
        return { ok: false, reason: verdict.reason };
      }
      if (snapshot.favorites.some((favorite) => favorite.stationId === stationId)) {
        return { ok: true, at: snapshot.favorites.find((favorite) => favorite.stationId === stationId)!.addedAt };
      }
      const at = typeof now === 'string' ? now : new Date(now.getTime()).toISOString();
      snapshot = { version: FAVORITES_SCHEMA_VERSION, favorites: [...snapshot.favorites, { stationId, addedAt: at }] };
      persist();
      return { ok: true, at };
    },

    removeFavorite(stationId: string): { ok: boolean; removed: boolean } {
      const remaining = snapshot.favorites.filter((favorite) => favorite.stationId !== stationId);
      const removed = remaining.length !== snapshot.favorites.length;
      snapshot = { version: FAVORITES_SCHEMA_VERSION, favorites: remaining };
      if (removed) persist();
      return { ok: true, removed };
    },

    listFavorites(): readonly FavoriteView[] {
      return snapshot.favorites.map((favorite) => {
        const verdict = readable(favorite.stationId);
        return {
          stationId: favorite.stationId,
          addedAt: favorite.addedAt,
          status: verdict.readable ? 'ok' : 'omitted-with-notice',
          reason: verdict.reason,
          viaAssignment: verdict.readable && verdict.reason === 'ALLOW_PROTECTED',
        };
      });
    },

    recordCount(): number {
      return snapshot.favorites.length;
    },
  };
}
