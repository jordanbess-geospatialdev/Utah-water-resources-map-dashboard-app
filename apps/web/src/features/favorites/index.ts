/**
 * WD-009 favorites feature entry point (FR-009 saved preferences, FR-025
 * subscription preferences, FR-052 My Sites).
 *
 * Exports the mountable My Sites panel plus the per-account stores. WD-009
 * does not touch apps/web/src/shell/App.tsx: the shell wiring is exactly one
 * pending line, documented in README.md.
 */
import MySitesPanel from './MySitesPanel';

export { MySitesPanel };
export default MySitesPanel;
export type { MySitesPanelProps } from './MySitesPanel';

export {
  createFavoritesStore,
  favoritesStorageKey,
  FAVORITES_SCHEMA_VERSION,
  inMemoryStorage,
  localStorageAdapter,
} from './favorites';
export type {
  AddFavoriteResult,
  FavoriteRecord,
  FavoriteStatus,
  FavoriteStorage,
  FavoriteView,
  FavoritesSnapshotV1,
  FavoritesStore,
  FavoritesStoreInput,
} from './favorites';

export {
  CHANNEL_NOTE_MAX_LENGTH,
  createNotificationPrefsStore,
  NOTIFICATION_CADENCES,
  NOTIFICATION_CADENCE_LABELS,
  NOTIFICATION_EVENT_KINDS,
  NOTIFICATION_EVENT_LABELS,
  NOTIFICATION_PREFS_SCHEMA_VERSION,
  notificationPrefsStorageKey,
} from './notificationPrefs';
export type {
  NotificationCadence,
  NotificationEventKind,
  NotificationPref,
  NotificationPrefsSnapshotV1,
  NotificationPrefsStore,
  NotificationPrefsStoreInput,
  NotificationScope,
  SetPrefInput,
  SetPrefResult,
} from './notificationPrefs';

/** Registration descriptor for the shell's feature registry (My Sites tab). */
export const mySitesMount = {
  id: 'my-sites',
  label: 'My Sites',
  mountPath: 'my-sites',
  component: MySitesPanel,
} as const;
