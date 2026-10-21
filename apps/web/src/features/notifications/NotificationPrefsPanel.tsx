/**
 * NotificationPrefsPanel - the FR-025 / FR-052 subscription management
 * surface: scope picker bounded to the acting grants, FR-025 event types,
 * per-property threshold bounds, cadence (hourly / twice-daily / daily /
 * weekly in America/Denver), channel note, removal that persists, and a
 * clearly labelled SIMULATED test event.
 *
 * Authority rules rendered visibly:
 * - the scope picker only offers systems/streams inside the account's
 *   CURRENT readable scope (the favorites rule: a subscription never becomes
 *   a visibility oracle); saving an out-of-scope target is denied with the
 *   engine's reason (role=alert);
 * - FAVORITES ARE DISTINCT: subscriptions and favorites are separate
 *   per-account lists; a ★ badge marks scopes that are also favorites, and
 *   neither list ever grants authority (FR-052 note rendered in the panel);
 * - removal persists (cancelled subscriptions disappear and never return).
 *
 * DELIVERY IS SIMULATED: the test event button dispatches to the in-memory
 * demo port only; no email/SMS/webhook code exists in this feature (the API
 * workflow hands digests to an in-memory recorder - see the notifications
 * README and services/api/src/workflows/notifications/types.ts).
 *
 * Accessibility contract: labelled controls (htmlFor/id), fieldset/legend
 * groups, role=status transient notices, role=alert errors and denials,
 * text+shape badges (never color alone), every action reachable by keyboard.
 *
 * Mountable, shell-free component: the default policy port is the fixture
 * mirror; the shell wiring line lives in README.md.
 */
import { useMemo, useState, type CSSProperties, type FormEvent as ReactFormEvent } from 'react';
import type { PolicyEvaluator, PolicyWorldMirror } from '../operations/assignedScope';
import { isReadableForPrincipal } from '../operations/assignedScope';
import { fixturePolicyPort } from '../operations/fixturePolicy';
import {
  CADENCES,
  CADENCE_LABELS,
  DEMO_DIGEST,
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  PROGRAM_TIME_ZONE,
  digestHeaderView,
  groupedEntries,
  subscriptionRows,
  type DigestView,
  type NotificationCadence,
  type NotificationEventType,
  type SubscriptionThresholds,
  type SubscriptionView,
} from './digestModel';

// ---------------------------------------------------------------------------
// The notifications port (demo binding; the API service is the real one)
// ---------------------------------------------------------------------------

export interface SaveSubscriptionInput {
  readonly scope: { readonly kind: 'system' | 'stream'; readonly id: string };
  readonly eventTypes: readonly NotificationEventType[];
  readonly thresholds: SubscriptionThresholds;
  readonly cadence: NotificationCadence;
  readonly channelNote: string;
}

export interface TestEventInput {
  readonly eventType: NotificationEventType;
  readonly objectId: string;
}

export interface TestDispatchRow {
  readonly subscriptionId: string;
  readonly delivered: boolean;
  readonly reason: 'event-type-not-selected' | 'out-of-scope' | 'not-readable' | null;
}

export type SaveOutcome = { ok: true; subscription: SubscriptionView } | { ok: false; reason: 'denied'; detail: string };

export interface NotificationsPort {
  list(principalId: string): readonly SubscriptionView[];
  save(principalId: string, input: SaveSubscriptionInput): SaveOutcome;
  remove(principalId: string, subscriptionId: string): boolean;
  /** SIMULATED dispatch: reaches only the account's currently eligible subscriptions. */
  dispatchTestEvent(principalId: string, input: TestEventInput): readonly TestDispatchRow[];
}

interface DemoDeps {
  readonly world: PolicyWorldMirror;
  readonly policy: PolicyEvaluator;
  readonly now: Date | string;
}

/** Demo store survives remounts (module scope), so removal persists in-session. */
const demoStore = new Map<string, SubscriptionView[]>();
let demoCounter = 0;

/**
 * The in-memory DEMO port. Grant semantics mirror the API workflow through
 * the injected evaluator (the same isReadableForPrincipal rule the favorites
 * seam uses); the authoritative service is services/api/src/workflows/
 * notifications/subscriptions.ts - this binding exists so the panel is
 * functional before the shell wires the API.
 */
export function createDemoNotificationsPort(deps: DemoDeps): NotificationsPort {
  const readable = (principalId: string, objectId: string): boolean => isReadableForPrincipal(principalId, objectId, deps.world, deps.policy, deps.now).readable;
  const systemOf = (objectId: string): string => deps.world.objects[objectId]?.systemId ?? '';
  const scopeReadable = (principalId: string, scope: SaveSubscriptionInput['scope']): { readable: boolean; detail: string } => {
    if (scope.kind === 'stream') {
      if (deps.world.objects[scope.id] === undefined) return { readable: false, detail: `unknown stream "${scope.id}"` };
      const verdict = isReadableForPrincipal(principalId, scope.id, deps.world, deps.policy, deps.now);
      return { readable: verdict.readable, detail: verdict.reason };
    }
    const members = Object.values(deps.world.objects).filter((object) => object.systemId === scope.id && (object.kind === 'station' || object.kind === 'datastream'));
    if (members.length === 0) return { readable: false, detail: `no station or stream in system "${scope.id}"` };
    return members.some((member) => readable(principalId, member.id))
      ? { readable: true, detail: 'system holds a readable object' }
      : { readable: false, detail: `no readable station or stream in system "${scope.id}"` };
  };

  return {
    list(principalId) {
      return (demoStore.get(principalId) ?? []).filter((subscription) => subscription.status === 'active');
    },
    save(principalId, input) {
      const verdict = scopeReadable(principalId, input.scope);
      if (!verdict.readable) {
        // FR-025 boundary: subscribing outside the readable scope denies with
        // the engine's reason - a subscription never extends authority.
        return { ok: false, reason: 'denied', detail: verdict.detail };
      }
      const at = typeof deps.now === 'string' ? deps.now : new Date(deps.now.getTime()).toISOString();
      const existing = (demoStore.get(principalId) ?? []).find((candidate) => candidate.scope.kind === input.scope.kind && candidate.scope.id === input.scope.id && candidate.status === 'active');
      const subscription: SubscriptionView = {
        id: existing?.id ?? `dsub-${String((demoCounter += 1)).padStart(6, '0')}`,
        recipientId: principalId,
        scope: input.scope,
        eventTypes: [...new Set(input.eventTypes)].sort(),
        thresholds: input.thresholds,
        cadence: input.cadence,
        channelNote: input.channelNote.slice(0, 120),
        createdAt: existing?.createdAt ?? at,
        // Demo schedule hint: the next Denver cadence boundary is computed by
        // the API service; the panel displays the cadence label alongside.
        nextDueAt: existing?.nextDueAt ?? at,
        status: 'active',
      };
      const others = (demoStore.get(principalId) ?? []).filter((candidate) => candidate.id !== subscription.id);
      demoStore.set(principalId, [...others, subscription]);
      return { ok: true, subscription };
    },
    remove(principalId, subscriptionId) {
      const remaining = (demoStore.get(principalId) ?? []).filter((candidate) => candidate.id !== subscriptionId);
      const removed = remaining.length !== (demoStore.get(principalId) ?? []).length;
      demoStore.set(principalId, remaining); // removal persists (never resurrected)
      return removed;
    },
    dispatchTestEvent(principalId, input) {
      const object = deps.world.objects[input.objectId];
      const systemId = systemOf(input.objectId);
      return (demoStore.get(principalId) ?? [])
        .filter((subscription) => subscription.status === 'active')
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map<TestDispatchRow>((subscription) => {
          if (!subscription.eventTypes.includes(input.eventType)) return { subscriptionId: subscription.id, delivered: false, reason: 'event-type-not-selected' };
          const inScope = subscription.scope.kind === 'system' ? subscription.scope.id === systemId : subscription.scope.id === input.objectId;
          if (!inScope) return { subscriptionId: subscription.id, delivered: false, reason: 'out-of-scope' };
          if (object === undefined || !readable(principalId, input.objectId)) return { subscriptionId: subscription.id, delivered: false, reason: 'not-readable' };
          return { subscriptionId: subscription.id, delivered: true, reason: null }; // SIMULATED receipt only
        });
    },
  };
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export interface NotificationPrefsPanelProps {
  /** Acting account. Default: the fixture engineer (demo); null renders the signed-out state. */
  readonly principalId?: string | null;
  readonly world?: PolicyWorldMirror;
  readonly policy?: PolicyEvaluator;
  readonly now?: Date | string;
  /** Shell wiring: the account's favorited object ids (the favorites distinction). */
  readonly favoriteObjectIds?: readonly string[];
  readonly status?: 'loading' | 'ready' | 'error';
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
  readonly digest?: DigestView | null;
}

const SMALL_MUTED: CSSProperties = { display: 'block', fontSize: 9, color: '#a0aa99', marginTop: 2 };
const FIELD_TEXT: CSSProperties = { fontSize: 10, padding: '5px 8px', borderRadius: 4, border: '1px solid #dce4de' };

/** Default demo port so the panel is fully functional standalone. */
export default function NotificationPrefsPanel({
  principalId = 'principal-fatima-engineer',
  world,
  policy,
  now,
  favoriteObjectIds = [],
  status = 'ready',
  errorMessage,
  onRetry,
  digest = DEMO_DIGEST,
}: NotificationPrefsPanelProps) {
  const port = fixturePolicyPort();
  const resolvedWorld = world ?? port.world;
  const resolvedPolicy = policy ?? port.evaluate;
  const resolvedNow = now ?? port.now;
  const notifications: NotificationsPort = useMemo(() => createDemoNotificationsPort({ world: resolvedWorld, policy: resolvedPolicy, now: resolvedNow }), [resolvedWorld, resolvedPolicy, resolvedNow]);

  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const [formError, setFormError] = useState('');

  const [scopeKind, setScopeKind] = useState<'system' | 'stream'>('system');
  const [scopeId, setScopeId] = useState('');
  const [eventTypes, setEventTypes] = useState<readonly NotificationEventType[]>(['no-signal']);
  const [cadence, setCadence] = useState<NotificationCadence>('daily');
  const [thresholdProperty, setThresholdProperty] = useState('discharge');
  const [thresholdMin, setThresholdMin] = useState('');
  const [thresholdMax, setThresholdMax] = useState('25');
  const [thresholds, setThresholds] = useState<SubscriptionThresholds>({});
  const [channelNote, setChannelNote] = useState('');

  const [testObject, setTestObject] = useState('');
  const [testType, setTestType] = useState<NotificationEventType>('no-signal');
  const [testRows, setTestRows] = useState<readonly TestDispatchRow[] | null>(null);

  // Scope options bounded to the ACTING grants (favorites rule).
  const options = useMemo(() => {
    const streams: string[] = [];
    const systems = new Map<string, number>();
    for (const object of Object.values(resolvedWorld.objects)) {
      if (object.kind !== 'station' && object.kind !== 'datastream') continue;
      const readableNow = principalId !== null && isReadableForPrincipal(principalId, object.id, resolvedWorld, resolvedPolicy, resolvedNow).readable;
      if (object.kind === 'datastream' && readableNow) streams.push(object.id);
      const systemId = object.systemId ?? '';
      if (systemId !== '') systems.set(systemId, (systems.get(systemId) ?? 0) + (readableNow ? 1 : 0));
    }
    return {
      streams: streams.sort(),
      systems: [...systems.entries()].filter(([, readableCount]) => readableCount > 0).map(([id]) => id).sort(),
    };
  }, [principalId, resolvedWorld, resolvedPolicy, resolvedNow]);

  const subscriptions = principalId !== null ? notifications.list(principalId) : [];
  const rows = subscriptionRows(subscriptions, { favoriteObjectIds });

  const submit = (form: ReactFormEvent<HTMLFormElement>): void => {
    form.preventDefault();
    setFormError('');
    if (principalId === null) return;
    if (scopeId === '') {
      setFormError('Pick a system or stream within your current grants first.');
      return;
    }
    if (eventTypes.length === 0) {
      setFormError('Select at least one event type.');
      return;
    }
    const outcome = notifications.save(principalId, { scope: { kind: scopeKind, id: scopeId }, eventTypes, thresholds, cadence, channelNote });
    if (outcome.ok) {
      setNotice(`Saved subscription for ${scopeKind} ${scopeId} (${outcome.subscription.eventTypes.map((type) => EVENT_TYPE_LABELS[type]).join(', ')} · ${CADENCE_LABELS[cadence]}).`);
      setRevision((value) => value + 1);
    } else {
      setFormError(`Denied: ${outcome.detail}. Subscriptions cannot leave your current readable scope, and never grant anything.`);
    }
  };

  const dispatchTest = (): void => {
    if (principalId === null || testObject === '') {
      setNotice('Pick an object for the simulated test event first.');
      return;
    }
    const rowsForTest = notifications.dispatchTestEvent(principalId, { eventType: testType, objectId: testObject });
    setTestRows(rowsForTest);
    const delivered = rowsForTest.filter((row) => row.delivered).length;
    setNotice(`SIMULATED test event (${EVENT_TYPE_LABELS[testType]} on ${testObject}): would reach ${delivered} of ${rowsForTest.length} subscription${rowsForTest.length === 1 ? '' : 's'}. No real message is sent.`);
    setRevision((value) => value + 1);
  };

  const header = digest !== null ? digestHeaderView(digest) : null;
  const groups = digest !== null ? groupedEntries(digest.entries) : [];

  return (
    <section className="panel" aria-label="Notification subscriptions" data-revision={revision}>
      <div className="panel-heading">
        <div>
          <h2>Notification subscriptions</h2>
          <span>
            Site and system event alerts · new sites, site edits, no signal, threshold violations · hourly / twice-daily / daily / weekly digests in {PROGRAM_TIME_ZONE} · delivery is SIMULATED
          </span>
        </div>
        <span className="mini-pill">FR-025 · FR-052 · T-15</span>
      </div>

      {status === 'loading' && (
        <p role="status" style={{ padding: '18px 19px', fontSize: 11, margin: 0 }}>
          Loading your subscriptions…
        </p>
      )}
      {status === 'error' && (
        <div role="alert" style={{ padding: '14px 19px' }}>
          <p style={{ fontSize: 11, margin: '0 0 10px', color: '#8a4b3c' }}>{errorMessage ?? 'Subscriptions are unavailable.'}</p>
          {onRetry !== undefined && (
            <button type="button" className="button small" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}

      {status === 'ready' && principalId === null && (
        <p role="note" style={{ padding: '18px 19px', fontSize: 11, margin: 0 }}>
          Sign in to manage personal subscriptions. Subscriptions survive sign-out and return with the account (FR-009/FR-052); they never alter a site&apos;s authority or ownership.
        </p>
      )}

      {status === 'ready' && principalId !== null && (
        <>
          {notice !== '' && (
            <p role="status" style={{ margin: 0, padding: '8px 19px', fontSize: 10, color: '#5f7a63', borderBottom: '1px solid #e9ede8' }}>
              {notice}
            </p>
          )}

          <p role="note" style={{ margin: 0, padding: '10px 19px 2px', fontSize: 9, color: '#7b8982' }}>
            ★ marks a scope that is also one of your favorites. Favorites and subscriptions are separate per-account lists: favoriting never grants authority, and removing either one persists without altering a site&apos;s authority or ownership (FR-052).
          </p>

          <h3 style={{ fontSize: 10, fontWeight: 750, margin: 0, padding: '12px 19px 4px' }}>
            Your subscriptions ({rows.length})
          </h3>
          {rows.length === 0 ? (
            <p role="note" style={{ padding: '6px 19px 14px', fontSize: 11, margin: 0 }}>
              No subscriptions yet. Add one below; the scope picker only offers systems and streams inside your current grants.
            </p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {rows.map((row) => (
                <li key={row.id} style={{ borderBottom: '1px solid #e9ede8', padding: '8px 19px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, flex: 1, minWidth: 240 }}>
                    <strong tabIndex={0}>
                      {row.scopeLabelText} {row.favoriteBadge !== null ? <span aria-label={row.favoriteBadge.text}>★</span> : null}
                    </strong>{' '}
                    · {row.eventsLabelText} · {row.cadenceLabelText}
                    {row.thresholdLabelText !== '' ? ` · thresholds: ${row.thresholdLabelText}` : ''}
                    {row.channelNote !== '' ? ` · note: ${row.channelNote}` : ''}
                    <small style={SMALL_MUTED}>Next digest due {row.nextDueLabelText}</small>
                  </span>
                  <button
                    type="button"
                    className="button small"
                    onClick={() => {
                      const removed = notifications.remove(principalId, row.id);
                      setNotice(removed ? `Removed subscription ${row.id}. Removal persists and never alters the site's authority.` : `Subscription ${row.id} was already removed.`);
                      setRevision((value) => value + 1);
                    }}
                    aria-label={`Remove subscription ${row.scopeLabelText}`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={submit} style={{ padding: '10px 19px 16px', display: 'grid', gap: 8, maxWidth: 620 }} aria-label="Add a subscription">
            <fieldset style={{ border: '1px solid #e3e9e0', borderRadius: 4, padding: '6px 10px', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <legend style={{ fontSize: 9, fontWeight: 650 }}>Scope (within your current grants)</legend>
              <label htmlFor="notif-scope-kind" style={{ fontSize: 10, display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontWeight: 650 }}>Kind</span>
                <select
                  id="notif-scope-kind"
                  value={scopeKind}
                  onChange={(change) => {
                    setScopeKind(change.target.value as 'system' | 'stream');
                    setScopeId('');
                  }}
                  style={FIELD_TEXT}
                >
                  <option value="system">System</option>
                  <option value="stream">Stream</option>
                </select>
              </label>
              <label htmlFor="notif-scope-id" style={{ fontSize: 10, display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontWeight: 650 }}>{scopeKind === 'system' ? 'System' : 'Stream'}</span>
                <select id="notif-scope-id" value={scopeId} onChange={(change) => setScopeId(change.target.value)} style={FIELD_TEXT}>
                  <option value="">Pick within your grants…</option>
                  {(scopeKind === 'system' ? options.systems : options.streams).map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="notif-cadence" style={{ fontSize: 10, display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontWeight: 650 }}>Cadence ({PROGRAM_TIME_ZONE})</span>
                <select id="notif-cadence" value={cadence} onChange={(change) => setCadence(change.target.value as NotificationCadence)} style={FIELD_TEXT}>
                  {CADENCES.map((value) => (
                    <option key={value} value={value}>
                      {CADENCE_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>

            <fieldset style={{ border: '1px solid #e3e9e0', borderRadius: 4, padding: '6px 10px', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <legend style={{ fontSize: 9, fontWeight: 650 }}>Event types (FR-025)</legend>
              {EVENT_TYPES.map((type) => (
                <label key={type} htmlFor={`notif-event-${type}`} style={{ fontSize: 10, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <input
                    id={`notif-event-${type}`}
                    type="checkbox"
                    checked={eventTypes.includes(type)}
                    onChange={(change) => setEventTypes((current) => (change.target.checked ? [...current, type] : current.filter((candidate) => candidate !== type)))}
                  />
                  {EVENT_TYPE_LABELS[type]}
                </label>
              ))}
            </fieldset>

            <fieldset style={{ border: '1px solid #e3e9e0', borderRadius: 4, padding: '6px 10px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <legend style={{ fontSize: 9, fontWeight: 650 }}>Threshold bounds (per property; defaults from the QC range rules)</legend>
              <label htmlFor="notif-th-prop" style={{ fontSize: 10, display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
                <span>Property</span>
                <select id="notif-th-prop" value={thresholdProperty} onChange={(change) => setThresholdProperty(change.target.value)} style={FIELD_TEXT}>
                  {['discharge', 'stage', 'voltage'].map((property) => (
                    <option key={property} value={property}>
                      {property}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="notif-th-min" style={{ fontSize: 10, display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
                <span>Min</span>
                <input id="notif-th-min" type="number" step="any" value={thresholdMin} onChange={(change) => setThresholdMin(change.target.value)} style={{ ...FIELD_TEXT, width: 80 }} />
              </label>
              <label htmlFor="notif-th-max" style={{ fontSize: 10, display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
                <span>Max</span>
                <input id="notif-th-max" type="number" step="any" value={thresholdMax} onChange={(change) => setThresholdMax(change.target.value)} style={{ ...FIELD_TEXT, width: 80 }} />
              </label>
              <button
                type="button"
                className="button small"
                onClick={() => {
                  const min = thresholdMin === '' ? undefined : Number(thresholdMin);
                  const max = thresholdMax === '' ? undefined : Number(thresholdMax);
                  if (min === undefined && max === undefined) {
                    setFormError('Give at least one bound (min or max) for the threshold.');
                    return;
                  }
                  setThresholds((current) => ({ ...current, [thresholdProperty]: { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) } }));
                  setNotice(`Threshold bound recorded for ${thresholdProperty}. A sustained violation yields one digest entry per window.`);
                  setRevision((value) => value + 1);
                }}
              >
                Set bound
              </button>
              <span style={{ fontSize: 9, color: '#7b8982', alignSelf: 'center' }}>
                {Object.keys(thresholds).length === 0 ? 'Using reviewed defaults (discharge 0-1200 cfs, stage 0-15 ft, voltage 11.5-15 V)' : `Configured: ${Object.keys(thresholds).sort().join(', ')}`}
              </span>
            </fieldset>

            <label htmlFor="notif-note" style={{ fontSize: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontWeight: 650 }}>Channel note (display placeholder; delivery is simulated)</span>
              <input id="notif-note" type="text" value={channelNote} maxLength={120} onChange={(change) => setChannelNote(change.target.value)} style={FIELD_TEXT} />
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

          <h3 style={{ fontSize: 10, fontWeight: 750, margin: 0, padding: '14px 19px 4px' }}>
            Test event (SIMULATED - no real message is ever sent)
          </h3>
          <div style={{ padding: '0 19px 12px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label htmlFor="notif-test-object" style={{ fontSize: 10, display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontWeight: 650 }}>Object (readable scope only)</span>
              <select id="notif-test-object" value={testObject} onChange={(change) => setTestObject(change.target.value)} style={FIELD_TEXT}>
                <option value="">Pick an object…</option>
                {options.streams.map((id) => (
                  <option key={`s-${id}`} value={id}>
                    stream {id}
                  </option>
                ))}
                {Object.values(resolvedWorld.objects)
                  .filter((object) => object.kind === 'station')
                  .map((object) => object.id)
                  .filter((id) => principalId !== null && isReadableForPrincipal(principalId, id, resolvedWorld, resolvedPolicy, resolvedNow).readable)
                  .sort()
                  .map((id) => (
                    <option key={`t-${id}`} value={id}>
                      site {id}
                    </option>
                  ))}
              </select>
            </label>
            <label htmlFor="notif-test-type" style={{ fontSize: 10, display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontWeight: 650 }}>Event type</span>
              <select id="notif-test-type" value={testType} onChange={(change) => setTestType(change.target.value as NotificationEventType)} style={FIELD_TEXT}>
                {EVENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {EVENT_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="button small" onClick={dispatchTest}>
              Send SIMULATED test event
            </button>
          </div>
          {testRows !== null && (
            <div role="status" style={{ padding: '0 19px 14px', fontSize: 10 }}>
              <p style={{ margin: '0 0 4px', fontWeight: 650 }}>Simulated dispatch result (a test event reaches only currently eligible subscribers):</p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {testRows.map((row) => (
                  <li key={row.subscriptionId}>
                    {row.subscriptionId}: {row.delivered ? '✓ would receive (simulated receipt only)' : `✕ skipped (${row.reason})`}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {digest !== null && header !== null && (
            <>
              <h3 style={{ fontSize: 10, fontWeight: 750, margin: 0, padding: '12px 19px 4px' }}>
                Latest digest (demo evidence)
              </h3>
              <div style={{ padding: '0 19px 16px', fontSize: 10 }}>
                <p style={{ margin: '0 0 4px' }}>
                  {header.cadenceLabel} · window {header.windowLabelText} ({header.zoneLabel})
                </p>
                <p style={{ margin: '0 0 6px', color: '#7b8982' }}>
                  {header.entryCount} entr{header.entryCount === 1 ? 'y' : 'ies'} · {header.dedupeNote} {header.deliveredNote}
                </p>
                {groups.map((group) => (
                  <p key={group.eventType} style={{ margin: '0 0 4px' }}>
                    <strong>
                        {group.typeLabel} ({group.rows.length})
                    </strong>
                    {group.rows.map((row) => (
                      <span key={row.eventId} style={{ display: 'block', marginLeft: 12 }}>
                        {row.objectId} · {row.occurredAtLabel} · {row.summary}
                      </span>
                    ))}
                  </p>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
