/**
 * MySitesPanel - the FR-052 / FR-009 "My Sites" surface: per-account
 * favorites with quick status, and notification subscription management
 * (FR-025 event kinds and cadence; delivery itself is a later task - the
 * channel field is a placeholder note).
 *
 * Authority rules rendered visibly:
 * - favorites never create edit entitlement (technical specification,
 *   "My Sites"); the panel notes it and the tests prove the engine still
 *   denies everything the account could not already read;
 * - a favorited site that later left the account's readable scope renders
 *   as omitted-with-notice (never deleted, never operational data);
 * - subscriptions outside the readable scope reject with the engine's
 *   denial reason shown next to the form.
 *
 * Accessibility contract: labelled controls (htmlFor/id), fieldset/legend
 * for the event checkboxes, role=status for transient notices, role=alert
 * for errors and rejections, role=status loading, text+shape status via the
 * shared StatusIndicator. Every state change is reachable by keyboard.
 *
 * Mountable, shell-free component: the default policy port is the fixture
 * mirror (../operations/fixturePolicy.ts); the wiring line lives in
 * README.md.
 */
import { useMemo, useState, type CSSProperties, type FormEvent as ReactFormEvent } from 'react';
import { FreshnessIndicator } from '../../components/StatusIndicator';
import { formatDateMT, formatFlow, formatTimeMT } from '../../components/Chart';
import { FIXTURE_SEED, stationById, systemName } from '../../shell/data/fixtures';
import { latestReading, stationFreshness } from '../../shell/data/observations';
import type { PolicyEvaluator, PolicyWorldMirror } from '../operations/assignedScope';
import { fixturePolicyPort } from '../operations/fixturePolicy';
import {
  createFavoritesStore,
  inMemoryStorage,
  type FavoriteStorage,
  type FavoriteView,
  type FavoritesStore,
} from './favorites';
import {
  createNotificationPrefsStore,
  NOTIFICATION_CADENCES,
  NOTIFICATION_CADENCE_LABELS,
  NOTIFICATION_EVENT_KINDS,
  NOTIFICATION_EVENT_LABELS,
  type NotificationPrefsStore,
} from './notificationPrefs';

export interface MySitesPanelProps {
  /** Acting account. Default: the fixture researcher (demo); null renders the signed-out state. */
  readonly principalId?: string | null;
  readonly world?: PolicyWorldMirror;
  readonly policy?: PolicyEvaluator;
  readonly now?: Date | string;
  /** Storage override (tests); defaults to localStorage with an in-memory fallback. */
  readonly storage?: FavoriteStorage;
  readonly status?: 'loading' | 'ready' | 'error';
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
}

const SMALL_MUTED: CSSProperties = { display: 'block', fontSize: 9, color: '#a0aa99', marginTop: 2 };

/** Default demo storage so the panel is fully functional standalone. */
let demoStorage: FavoriteStorage | null = null;
function defaultStorage(): FavoriteStorage {
  demoStorage ??= inMemoryStorage();
  return demoStorage;
}

function FavoriteRow({
  favorite,
  onRemove,
}: {
  readonly favorite: FavoriteView;
  readonly onRemove: (stationId: string) => void;
}) {
  const station = stationById.get(favorite.stationId);
  const freshness = station ? stationFreshness(station) : 'no-data';
  const latest = station ? latestReading(station) : null;
  return (
    <li style={{ borderBottom: '1px solid #e9ede8', padding: '10px 19px', display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 220 }}>
        <h3 style={{ fontSize: 11, margin: '0 0 3px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span tabIndex={0}>{station?.displayName ?? favorite.stationId}</span>
          {favorite.status === 'ok' ? <FreshnessIndicator value={freshness} /> : null}
        </h3>
        {favorite.status === 'ok' ? (
          <p style={{ fontSize: 10, margin: 0 }}>
            {systemName(station?.systemId ?? '')} · {latest ? `${formatFlow(latest.value, latest.unitId)} at ${formatDateMT(latest.observedAt)} ${formatTimeMT(latest.observedAt)}` : 'no discharge stream'}
            {favorite.viaAssignment ? ' · readable through your assignment, not the public projection' : ''}
            <small style={SMALL_MUTED}>
              Favorited {formatDateMT(favorite.addedAt)} · {favorite.stationId}
            </small>
          </p>
        ) : (
          <p role="note" style={{ fontSize: 10, margin: 0, color: '#8a6d3c' }}>
            Omitted with notice: this site is no longer readable for your account ({favorite.reason}). The favorite is kept and returns if access is
            restored; it never grants access and no operational data is shown.
          </p>
        )}
      </div>
      <button type="button" className="button small" onClick={() => onRemove(favorite.stationId)} aria-label={`Remove favorite ${station?.displayName ?? favorite.stationId}`}>
        Remove
      </button>
    </li>
  );
}

/**
 * The My Sites panel: favorites with quick status plus subscription
 * management, persisted per account and validated against the account's
 * readable scope.
 */
export default function MySitesPanel({
  principalId = 'principal-sarah-researcher',
  world,
  policy,
  now,
  storage,
  status = 'ready',
  errorMessage,
  onRetry,
}: MySitesPanelProps) {
  const port = fixturePolicyPort();
  const resolvedWorld = world ?? port.world;
  const resolvedPolicy = policy ?? port.evaluate;
  const resolvedNow = now ?? port.now;
  const resolvedStorage = storage ?? defaultStorage();

  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<string>('');

  const favoritesStore: FavoritesStore | null = useMemo(
    () =>
      principalId !== null
        ? createFavoritesStore({ principalId, world: resolvedWorld, policy: resolvedPolicy, now: resolvedNow, storage: resolvedStorage })
        : null,
    [principalId, resolvedWorld, resolvedPolicy, resolvedNow, resolvedStorage],
  );
  const prefsStore: NotificationPrefsStore | null = useMemo(
    () =>
      principalId !== null
        ? createNotificationPrefsStore({ principalId, world: resolvedWorld, policy: resolvedPolicy, now: resolvedNow, storage: resolvedStorage })
        : null,
    [principalId, resolvedWorld, resolvedPolicy, resolvedNow, resolvedStorage],
  );

  // Subscription form state.
  const readableSiteOptions = useMemo(() => {
    if (principalId === null) return [];
    return Object.values(resolvedWorld.objects)
      .filter((object) => object.kind === 'station')
      .map((object) => ({ id: object.id, systemId: object.systemId ?? '' }))
      .filter((station) => {
        const decision = resolvedPolicy(
          { principal: resolvedWorld.principals[principalId] ?? null, action: 'browse-published', object: { kind: 'station', id: station.id, fields: ['public'] } },
          resolvedWorld,
          resolvedNow,
        );
        if (decision.effect === 'allow') return true;
        const protectedDecision = resolvedPolicy(
          { principal: resolvedWorld.principals[principalId] ?? null, action: 'view-restricted-details', object: { kind: 'station', id: station.id, fields: ['restricted'] } },
          resolvedWorld,
          resolvedNow,
        );
        return protectedDecision.effect === 'allow';
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }, [principalId, resolvedWorld, resolvedPolicy, resolvedNow]);

  const [formSite, setFormSite] = useState('');
  const [formCadence, setFormCadence] = useState<'immediate' | 'daily' | 'weekly'>('daily');
  const [formEvents, setFormEvents] = useState<readonly ('new-site' | 'site-edit' | 'no-signal' | 'threshold')[]>(['no-signal']);
  const [formNote, setFormNote] = useState('');
  const [formError, setFormError] = useState('');

  const favorites = favoritesStore?.listFavorites() ?? [];
  const prefs = prefsStore?.listPrefs() ?? [];

  const removeFavorite = (stationId: string): void => {
    favoritesStore?.removeFavorite(stationId);
    setNotice(`Removed favorite ${stationId}. Removal persists and never alters the site's authority or ownership.`);
    setRevision((value) => value + 1);
  };

  const submitPref = (event: ReactFormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFormError('');
    if (prefsStore === null || formSite === '') {
      setFormError('Pick a site within your readable scope first.');
      return;
    }
    const result = prefsStore.setPref({ scope: { kind: 'site', id: formSite }, events: formEvents, cadence: formCadence, channelNote: formNote });
    if (result.ok) {
      setNotice(`Saved subscription for ${formSite} (${result.pref.events.join(', ')} · ${NOTIFICATION_CADENCE_LABELS[result.pref.cadence]}).`);
      setRevision((value) => value + 1);
    } else {
      setFormError(`Rejected: ${result.reason} (${result.detail}). Subscriptions cannot leave your readable scope.`);
    }
  };

  return (
    <section className="panel" aria-label="My Sites: favorites and subscriptions" data-revision={revision}>
      <div className="panel-heading">
        <div>
          <h2>My Sites</h2>
          <span>Favorites with quick status · subscription preferences · per-account, persisted · favorites never create edit entitlement</span>
        </div>
        <span className="mini-pill">FR-009 · FR-025 · FR-052 · seed {FIXTURE_SEED}</span>
      </div>

      {status === 'loading' && (
        <p role="status" style={{ padding: '18px 19px', fontSize: 11, margin: 0 }}>
          Loading your sites…
        </p>
      )}
      {status === 'error' && (
        <div role="alert" style={{ padding: '14px 19px' }}>
          <p style={{ fontSize: 11, margin: '0 0 10px', color: '#8a4b3c' }}>{errorMessage ?? 'My Sites is unavailable.'}</p>
          {onRetry !== undefined && (
            <button type="button" className="button small" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}

      {status === 'ready' && principalId === null && (
        <p role="note" style={{ padding: '18px 19px', fontSize: 11, margin: 0 }}>
          Sign in to keep favorites and subscriptions. Favorites and preferences survive sign-out and return with the account (FR-009); anonymous
          exploration stays available in the public views.
        </p>
      )}

      {status === 'ready' && principalId !== null && (
        <>
          {notice !== '' && (
            <p role="status" style={{ margin: 0, padding: '8px 19px', fontSize: 10, color: '#5f7a63', borderBottom: '1px solid #e9ede8' }}>
              {notice}
            </p>
          )}
          <h3 style={{ fontSize: 10, fontWeight: 750, margin: 0, padding: '12px 19px 4px' }}>
            Favorites ({favorites.length})
          </h3>
          {favorites.length === 0 ? (
            <p role="note" style={{ padding: '6px 19px 14px', fontSize: 11, margin: 0 }}>
              No favorites yet. Favorite a published site from its chart or the site list; a favorite only ever targets a site your account can
              already read.
            </p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {favorites.map((favorite) => (
                <FavoriteRow key={favorite.stationId} favorite={favorite} onRemove={removeFavorite} />
              ))}
            </ul>
          )}

          <h3 style={{ fontSize: 10, fontWeight: 750, margin: 0, padding: '16px 19px 4px' }}>
            Subscriptions ({prefs.length})
          </h3>
          <p style={{ fontSize: 9, color: '#7b8982', margin: 0, padding: '0 19px 6px' }}>
            FR-025 event kinds at a chosen cadence. Delivery arrives with the notification pipeline; the channel note is a placeholder for it.
            Subscribing to a restricted site outside your readable scope is rejected.
          </p>
          {prefs.length > 0 && (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {prefs.map((pref) => (
                <li key={pref.id} style={{ borderBottom: '1px solid #e9ede8', padding: '8px 19px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, flex: 1, minWidth: 220 }}>
                    <strong tabIndex={0}>{stationById.get(pref.scope.id)?.displayName ?? pref.scope.id}</strong> ({pref.scope.id}) ·{' '}
                    {pref.events.map((event) => NOTIFICATION_EVENT_LABELS[event]).join(', ')} · {NOTIFICATION_CADENCE_LABELS[pref.cadence]}
                    {pref.channelNote !== '' ? ` · note: ${pref.channelNote}` : ''}
                    <small style={SMALL_MUTED}>Saved {formatDateMT(pref.createdAt)}</small>
                  </span>
                  <button
                    type="button"
                    className="button small"
                    onClick={() => {
                      prefsStore?.removePref(pref.id);
                      setNotice(`Removed subscription for ${pref.scope.id}.`);
                      setRevision((value) => value + 1);
                    }}
                    aria-label={`Remove subscription for ${stationById.get(pref.scope.id)?.displayName ?? pref.scope.id}`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={submitPref} style={{ padding: '10px 19px 16px', display: 'grid', gap: 8, maxWidth: 560 }} aria-label="Add a subscription">
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label htmlFor="mysites-sub-site" style={{ fontSize: 10, display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontWeight: 650 }}>Site (readable scope only)</span>
                <select
                  id="mysites-sub-site"
                  value={formSite}
                  onChange={(event) => setFormSite(event.target.value)}
                  style={{ fontSize: 10, padding: '5px 8px', borderRadius: 4, border: '1px solid #dce4de', maxWidth: 300 }}
                >
                  <option value="">Pick a site…</option>
                  {readableSiteOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {stationById.get(option.id)?.displayName ?? option.id} ({option.id})
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="mysites-sub-cadence" style={{ fontSize: 10, display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontWeight: 650 }}>Cadence</span>
                <select
                  id="mysites-sub-cadence"
                  value={formCadence}
                  onChange={(event) => setFormCadence(event.target.value as 'immediate' | 'daily' | 'weekly')}
                  style={{ fontSize: 10, padding: '5px 8px', borderRadius: 4, border: '1px solid #dce4de' }}
                >
                  {NOTIFICATION_CADENCES.map((cadence) => (
                    <option key={cadence} value={cadence}>
                      {NOTIFICATION_CADENCE_LABELS[cadence]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <fieldset style={{ border: '1px solid #e3e9e0', borderRadius: 4, padding: '6px 10px', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <legend style={{ fontSize: 9, fontWeight: 650 }}>Events</legend>
              {NOTIFICATION_EVENT_KINDS.map((kind) => (
                <label key={kind} htmlFor={`mysites-sub-event-${kind}`} style={{ fontSize: 10, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <input
                    id={`mysites-sub-event-${kind}`}
                    type="checkbox"
                    checked={formEvents.includes(kind)}
                    onChange={(event) =>
                      setFormEvents((current) => (event.target.checked ? [...current, kind] : current.filter((candidate) => candidate !== kind)))
                    }
                  />
                  {NOTIFICATION_EVENT_LABELS[kind]}
                </label>
              ))}
            </fieldset>
            <label htmlFor="mysites-sub-note" style={{ fontSize: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontWeight: 650 }}>Channel note (placeholder until delivery lands)</span>
              <input
                id="mysites-sub-note"
                type="text"
                value={formNote}
                maxLength={120}
                onChange={(event) => setFormNote(event.target.value)}
                style={{ fontSize: 10, padding: '5px 8px', borderRadius: 4, border: '1px solid #dce4de' }}
              />
            </label>
            {formError !== '' && (
              <p role="alert" style={{ fontSize: 10, margin: 0, color: '#8a4b3c' }}>
                {formError}
              </p>
            )}
            <div>
              <button type="submit" className="button small">
                Save subscription
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
