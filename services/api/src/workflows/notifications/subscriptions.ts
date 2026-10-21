/**
 * Scoped alert subscriptions and grant-enforced digests (WD-015; FR-025,
 * FR-052; FR-016 scope/cadence vocabulary).
 *
 * "Subscriptions distinguish new sites, site edits, no signal and threshold
 * violations; a test event reaches only eligible subscribers and the alert
 * link repeats the authorization check." (FR-025)
 *
 * "A registered user favorites any published site ... and manages personal
 * subscriptions; removing a favorite or subscription persists and does not
 * alter a site's authority or ownership." (FR-052)
 *
 * MODEL:
 *
 * - SUBSCRIPTIONS are own-account preferences (like WD-013's QC
 *   subscriptions): the actor manages only their own (recipientId === session
 *   identity); an anonymous caller is 401. A STREAM-scoped subscription may
 *   only target a stream the recipient can already read (the favorites rule:
 *   a subscription must never become a visibility oracle). A SYSTEM-scoped
 *   subscription is open to any authenticated principal - per-event
 *   admission below does the actual filtering.
 * - CURRENT GRANTS, EVERY TIME: the world snapshot is re-read (and the
 *   entitlement engine re-run) for EVERY digest build and EVERY test dispatch:
 *   events are admitted stream/station-by-station through the policy engine
 *   (public -> browse-published public branch; restricted -> view-restricted-
 *   details; internal, e.g. the voltage diagnostic stream -> view-internal-
 *   diagnostics). A recipient whose grants were revoked gets the affected
 *   events OMITTED (counted, never listed); a deactivated or unknown
 *   recipient receives NOTHING at all; cross-scope events are never
 *   delivered. Favoriting/subscribing never grants anything (FR-052).
 * - WINDOWS are the America/Denver schedules from schedules.ts: hourly,
 *   twice-daily (06:00/18:00), daily (07:00), weekly (Monday 07:00), DST-
 *   correct, contiguous - the Monday weekly digest includes the whole
 *   Fri+Sat+Sun interval exactly once. Not due before nextDueAt.
 * - DEDUPE: within a window by event id (re-delivered records count once);
 *   across windows by event id (already-delivered events are skipped and
 *   counted) - a sustained threshold violation is one event per window by
 *   construction (thresholds.ts).
 * - DELIVERY IS SIMULATED: digests and test events are handed to the
 *   injected DeliveryChannel (an in-memory recorder in every test); there is
 *   no email/SMS/webhook code anywhere. An EMPTY digest hands the channel
 *   nothing.
 *
 * Purity: injected clock, no I/O. The event feed (with server-side systemId
 * anchors) is passed in per call; membership is never taken from the request
 * body (FR-010).
 */
import type { PolicyWorld } from '../../../../../packages/policy/src/index.ts';
import { gateAct, instantIso, type PolicyEvaluator } from '../stewardship/gate.ts';
import { admitStream, type PolicyDeps, type StreamDenial } from '../qc/subscriptions.ts';
import { alertLinkFor } from './alertLinks.ts';
import { nextBoundary, currentBoundary } from './schedules.ts';
import { validateThresholds } from './thresholds.ts';
import {
  CHANNEL_NOTE_MAX_LENGTH,
  EVENT_TYPE_LABELS,
  EVENT_TYPE_SORT_ORDER,
  NOTIFICATION_CADENCES,
  NOTIFICATION_EVENT_TYPES,
  type DeliveryChannel,
  type DeliveryReceipt,
  type DigestEntry,
  type NotificationCadence,
  type NotificationDigest,
  type NotificationEvent,
  type NotificationEventType,
  type Subscription,
  type SubscriptionScope,
} from './types.ts';

// ---------------------------------------------------------------------------
// Dependencies (the world is a snapshot PROVIDER so revocations are visible
// to the very next digest build - FR-011 "next authorized request")
// ---------------------------------------------------------------------------

export interface NotificationDeps {
  /** Authoritative world snapshot, or a provider re-read at every build. */
  readonly world: PolicyWorld | (() => PolicyWorld);
  /** REQUIRED injected clock. */
  readonly clock: () => Date | string;
  readonly policy?: PolicyEvaluator;
  /** The SIMULATED delivery channel (in-memory recorder in tests and demo). */
  readonly channel: DeliveryChannel;
}

export function snapshotWorld(deps: Pick<NotificationDeps, 'world'>): PolicyWorld {
  return typeof deps.world === 'function' ? deps.world() : deps.world;
}

// ---------------------------------------------------------------------------
// Event admission (one entitlement path for stations and streams)
// ---------------------------------------------------------------------------

/** The entitlement action that admits a STATION (site) by its visibility class. */
export function stationAdmissionAction(visibility: 'public' | 'restricted' | 'internal'): string {
  if (visibility === 'public') return 'browse-published';
  if (visibility === 'restricted') return 'view-restricted-details';
  return 'view-internal-diagnostics';
}

export type EventAdmission = { readonly ok: true } | StreamDenial;

/**
 * May `principalId` receive an event about this object? Resolved
 * server-side through the same evaluate() every read uses - datastreams via
 * WD-013's admitStream, stations through the analogous action by visibility.
 */
export function admitEvent(deps: Pick<NotificationDeps, 'world' | 'clock' | 'policy'>, principalId: string | null, event: NotificationEvent): EventAdmission {
  if (event.objectKind === 'datastream') {
    return admitStream({ world: snapshotWorld(deps), clock: deps.clock, policy: deps.policy }, principalId, event.objectId);
  }
  const world = snapshotWorld(deps);
  const object = world.objects[event.objectId];
  if (!object || object.kind !== 'station') {
    return { ok: false, status: 403, reason: 'DENY_UNKNOWN_OBJECT', detail: `no station "${event.objectId}" in the policy world`, decision: null };
  }
  const outcome = gateAct({ world, clock: deps.clock, policy: deps.policy }, principalId, stationAdmissionAction(object.visibility), { kind: 'station', id: event.objectId });
  if (outcome.ok) return { ok: true };
  return { ok: false, status: outcome.status, reason: outcome.reason, detail: outcome.decision.detail ?? '', decision: outcome.decision };
}

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export type SubscriptionErrorCode = 'unknown-cadence' | 'unknown-system' | 'unknown-stream' | 'bad-event-types' | 'bad-thresholds';

export interface SubscriptionPatch {
  readonly eventTypes?: readonly NotificationEventType[];
  readonly thresholds?: Subscription['thresholds'];
  readonly cadence?: NotificationCadence | string;
  readonly channelNote?: string;
}

export interface TestDispatchRow {
  readonly subscriptionId: string;
  readonly recipientId: string;
  readonly delivered: boolean;
  /** Why a matching subscription was skipped (scope / event type / grant). */
  readonly reason: 'event-type-not-selected' | 'out-of-scope' | 'not-admitted' | null;
}

export interface NotificationService {
  createSubscription(
    principalId: string | null,
    input: { readonly scope: SubscriptionScope; readonly eventTypes: readonly NotificationEventType[]; readonly cadence: NotificationCadence | string; readonly thresholds?: Subscription['thresholds']; readonly channelNote?: string },
  ): { ok: true; subscription: Subscription } | { ok: false; errors: readonly SubscriptionErrorCode[] } | StreamDenial;
  updateSubscription(principalId: string | null, subscriptionId: string, patch: SubscriptionPatch): { ok: true; subscription: Subscription } | { ok: false; errors: readonly ('unknown-subscription' | 'not-own-subscription' | 'cancelled-subscription' | 'unknown-cadence' | 'bad-event-types' | 'bad-thresholds')[] };
  cancelSubscription(principalId: string | null, subscriptionId: string): { ok: true; subscription: Subscription } | { ok: false; errors: readonly ('unknown-subscription' | 'not-own-subscription')[] };
  subscriptionsFor(principalId: string): readonly Subscription[];
  /** Active subscriptions whose nextDueAt is at/before `at` (scheduler tick input). */
  dueSubscriptions(at: Date | string): readonly Subscription[];
  /** Build (and record) the digest for one subscription at `at`; not-due before nextDueAt. */
  buildDigest(subscriptionId: string, at: Date | string, events: readonly NotificationEvent[]): NotificationDigest | { readonly issued: false; readonly reason: 'not-due' | 'unknown-subscription' | 'cancelled'; readonly subscriptionId: string; readonly nextDueAt: string | null };
  digests(subscriptionId: string): readonly NotificationDigest[];
  /**
   * FR-025 test event: dispatch one event to every CURRENTLY eligible
   * subscriber (matching scope + event type + admitted by the engine at
   * dispatch time). Simulated delivery only.
   */
  dispatchTestEvent(event: NotificationEvent, at?: Date | string): readonly TestDispatchRow[];
}

function scopeLabel(scope: SubscriptionScope): string {
  return scope.kind === 'system' ? scope.systemId : scope.streamId;
}

export function createNotificationService(deps: NotificationDeps): NotificationService {
  const subscriptions: Subscription[] = [];
  const digestLog = new Map<string, NotificationDigest[]>();
  /** Event ids already delivered per subscription (cross-window dedupe). */
  const deliveredIds = new Map<string, Set<string>>();
  let counter = 0;

  const nowIso = (): string => instantIso(deps.clock());
  const isoMs = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

  const requireOwn = (principalId: string | null, subscriptionId: string): { ok: true; subscription: Subscription } | { ok: false; errors: readonly ('unknown-subscription' | 'not-own-subscription')[] } => {
    const subscription = subscriptions.find((candidate) => candidate.id === subscriptionId);
    if (!subscription) return { ok: false, errors: ['unknown-subscription'] };
    if (subscription.recipientId !== principalId) return { ok: false, errors: ['not-own-subscription'] };
    return { ok: true, subscription };
  };

  const scopeMatches = (scope: SubscriptionScope, event: NotificationEvent): boolean =>
    scope.kind === 'system' ? event.systemId === scope.systemId : event.objectId === scope.streamId || event.streamId === scope.streamId;

  const validEventTypes = (types: readonly NotificationEventType[]): readonly NotificationEventType[] | null => {
    if (!Array.isArray(types) || types.length === 0) return null;
    const known: NotificationEventType[] = [];
    for (const type of types) {
      if (typeof type !== 'string' || !(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(type)) return null;
      known.push(type as NotificationEventType);
    }
    return [...new Set(known)].sort();
  };

  return {
    createSubscription(principalId, input) {
      const world = snapshotWorld(deps);
      // Own-account object: the session identity IS the recipient.
      const principal = principalId === null ? null : world.principals[principalId] ?? null;
      if (!principal) {
        return {
          ok: false,
          status: 401,
          reason: principalId === null ? 'DENY_ANONYMOUS' : 'DENY_UNKNOWN_PRINCIPAL',
          detail: 'an alert subscription requires an authenticated recipient',
          decision: null,
        };
      }
      const errors: SubscriptionErrorCode[] = [];
      if (!(NOTIFICATION_CADENCES as readonly string[]).includes(input?.cadence)) errors.push('unknown-cadence');
      const eventTypes = validEventTypes(input?.eventTypes ?? []);
      if (eventTypes === null) errors.push('bad-event-types');
      if (validateThresholds(input?.thresholds).length > 0) errors.push('bad-thresholds');
      const scope = input?.scope;
      if (scope?.kind === 'system') {
        const object = world.objects[scope.systemId];
        if (!object || object.kind !== 'system') errors.push('unknown-system');
      } else if (scope?.kind === 'stream') {
        const object = world.objects[scope.streamId];
        if (!object || object.kind !== 'datastream') errors.push('unknown-stream');
      } else {
        errors.push('unknown-stream');
      }
      if (errors.length > 0) return { ok: false, errors };

      // Favorites rule: a stream-scope subscription may only target a stream
      // the recipient can already read - it must never become a visibility
      // oracle for internal or restricted streams.
      if (scope.kind === 'stream') {
        const admission = admitEvent(deps, principalId, {
          id: 'scope-probe',
          type: 'site-edit',
          objectKind: 'datastream',
          objectId: scope.streamId,
          systemId: world.objects[scope.streamId]!.systemId ?? '',
          streamId: scope.streamId,
          occurredAt: nowIso(),
          summary: 'scope probe',
        });
        if (!admission.ok) return admission;
      }

      const createdAt = nowIso();
      const cadence = input.cadence as NotificationCadence;
      const subscription: Subscription = Object.freeze({
        id: `nsub-${String((counter += 1)).padStart(6, '0')}`,
        recipientId: principalId,
        scope,
        eventTypes: Object.freeze(eventTypes),
        thresholds: Object.freeze({ ...(input.thresholds ?? {}) }),
        cadence,
        channelNote: (input.channelNote ?? '').slice(0, CHANNEL_NOTE_MAX_LENGTH),
        createdAt,
        lastDigestAt: null,
        nextDueAt: nextBoundary(cadence, createdAt),
        status: 'active',
      });
      subscriptions.push(subscription);
      return { ok: true, subscription };
    },

    updateSubscription(principalId, subscriptionId, patch) {
      const own = requireOwn(principalId, subscriptionId);
      if (!own.ok) return own;
      if (own.subscription.status === 'cancelled') return { ok: false, errors: ['cancelled-subscription'] };
      const errors: string[] = [];
      if (patch.cadence !== undefined && !(NOTIFICATION_CADENCES as readonly string[]).includes(patch.cadence)) errors.push('unknown-cadence');
      let eventTypes = own.subscription.eventTypes;
      if (patch.eventTypes !== undefined) {
        const validated = validEventTypes(patch.eventTypes);
        if (validated === null) errors.push('bad-event-types');
        else eventTypes = Object.freeze(validated);
      }
      if (patch.thresholds !== undefined && validateThresholds(patch.thresholds).length > 0) errors.push('bad-thresholds');
      if (errors.length > 0) return { ok: false, errors: errors as ('unknown-cadence' | 'bad-event-types' | 'bad-thresholds')[] };

      const cadence = (patch.cadence !== undefined ? (patch.cadence as NotificationCadence) : own.subscription.cadence);
      // Schedule restarts from the last anchor on the (possibly new) grid.
      const updated = Object.freeze({
        ...own.subscription,
        eventTypes,
        thresholds: patch.thresholds !== undefined ? Object.freeze({ ...patch.thresholds }) : own.subscription.thresholds,
        cadence,
        channelNote: patch.channelNote !== undefined ? patch.channelNote.slice(0, CHANNEL_NOTE_MAX_LENGTH) : own.subscription.channelNote,
        nextDueAt: nextBoundary(cadence, own.subscription.lastDigestAt ?? own.subscription.createdAt),
      });
      subscriptions[subscriptions.indexOf(own.subscription)] = updated;
      return { ok: true, subscription: updated };
    },

    cancelSubscription(principalId, subscriptionId) {
      const own = requireOwn(principalId, subscriptionId);
      if (!own.ok) return own;
      // Removal persists: cancelled is terminal (update refuses to resurrect).
      const updated = Object.freeze({ ...own.subscription, status: 'cancelled' as const });
      subscriptions[subscriptions.indexOf(own.subscription)] = updated;
      return { ok: true, subscription: updated };
    },

    subscriptionsFor(principalId) {
      return subscriptions.filter((subscription) => subscription.recipientId === principalId && subscription.status === 'active');
    },

    dueSubscriptions(at) {
      const atMs = typeof at === 'string' ? Date.parse(at) : at.getTime();
      return subscriptions.filter((subscription) => subscription.status === 'active' && Date.parse(subscription.nextDueAt) <= atMs);
    },

    buildDigest(subscriptionId, at, events) {
      const subscription = subscriptions.find((candidate) => candidate.id === subscriptionId);
      if (!subscription) return { issued: false, reason: 'unknown-subscription', subscriptionId, nextDueAt: null };
      if (subscription.status === 'cancelled') return { issued: false, reason: 'cancelled', subscriptionId, nextDueAt: subscription.nextDueAt };
      const atMs = typeof at === 'string' ? Date.parse(at) : at.getTime();
      if (atMs < Date.parse(subscription.nextDueAt)) return { issued: false, reason: 'not-due', subscriptionId, nextDueAt: subscription.nextDueAt };

      // Boundary-aligned window, contiguous with the previous digest: the
      // Monday weekly window necessarily covers Fri+Sat+Sun exactly once.
      const boundary = currentBoundary(subscription.cadence, atMs);
      const windowStartMs = Date.parse(subscription.lastDigestAt ?? subscription.createdAt);
      const boundaryMs = Date.parse(boundary);

      // CURRENT grants, re-read for this build.
      const world = snapshotWorld(deps);
      const recipient = world.principals[subscription.recipientId] ?? null;
      const recipientActive = recipient !== null && recipient.active;

      const scoped: NotificationEvent[] = [];
      let outOfSubscription = 0;
      let duplicatesDropped = 0;
      const seen = new Set<string>();
      const inOrder = [...events]
        .filter((event) => {
          const occurred = Date.parse(event.occurredAt);
          return occurred >= windowStartMs && occurred < boundaryMs;
        })
        .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id < b.id ? -1 : 1));
      for (const event of inOrder) {
        if (!subscription.eventTypes.includes(event.type) || !scopeMatches(subscription.scope, event)) {
          outOfSubscription += 1;
          continue;
        }
        if (seen.has(event.id)) {
          duplicatesDropped += 1; // re-delivered record of the same event
          continue;
        }
        seen.add(event.id);
        scoped.push(event);
      }

      const delivered = deliveredIds.get(subscriptionId) ?? new Set<string>();
      const entries: DigestEntry[] = [];
      let omittedForAuthorization = 0;
      let alreadyDelivered = 0;
      for (const event of scoped) {
        // A deactivated/unknown recipient receives NOTHING at all; otherwise
        // admission runs per event (authorization first, then cross-window
        // dedupe - an omitted event was never delivered).
        const admission = recipientActive ? admitEvent({ world, clock: deps.clock, policy: deps.policy }, subscription.recipientId, event) : null;
        if (!recipientActive || !admission?.ok) {
          omittedForAuthorization += 1;
          continue;
        }
        if (delivered.has(event.id)) {
          alreadyDelivered += 1;
          continue;
        }
        delivered.add(event.id);
        entries.push({
          eventId: event.id,
          eventType: event.type,
          eventTypeLabel: EVENT_TYPE_LABELS[event.type],
          objectKind: event.objectKind,
          objectId: event.objectId,
          systemId: event.systemId,
          occurredAt: event.occurredAt,
          summary: event.summary,
          alertLink: alertLinkFor(event),
        });
      }

      entries.sort((a, b) => {
        const typeDelta = EVENT_TYPE_SORT_ORDER.indexOf(a.eventType) - EVENT_TYPE_SORT_ORDER.indexOf(b.eventType);
        if (typeDelta !== 0) return typeDelta;
        if (a.objectId !== b.objectId) return a.objectId < b.objectId ? -1 : 1;
        if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
        return a.eventId < b.eventId ? -1 : 1;
      });

      // SIMULATED delivery: only a non-empty digest hands the channel a
      // receipt; empty digests (nothing due, everything omitted or deduped)
      // hand over nothing.
      const issuedAt = boundary;
      let receipt: DeliveryReceipt | null = null;
      if (entries.length > 0) {
        receipt = Object.freeze({
          channel: 'simulated',
          kind: 'digest',
          recipientId: subscription.recipientId,
          subscriptionId: subscription.id,
          eventIds: Object.freeze(entries.map((entry) => entry.eventId)),
          at: issuedAt,
          summary: `Digest (${subscription.cadence}) for ${scopeLabel(subscription.scope)}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${omittedForAuthorization > 0 ? `, ${omittedForAuthorization} omitted for authorization` : ''} - SIMULATED channel, no real message sent`,
        });
        deps.channel.deliver(receipt);
      }

      const digest: NotificationDigest = Object.freeze({
        issued: true,
        subscriptionId: subscription.id,
        recipientId: subscription.recipientId,
        cadence: subscription.cadence,
        scope: subscription.scope,
        issuedAt,
        windowStart: isoMs(windowStartMs),
        windowEnd: isoMs(boundaryMs),
        entries: Object.freeze(entries),
        dedupeKeys: Object.freeze(entries.map((entry) => entry.eventId)),
        counts: Object.freeze({ included: entries.length, duplicatesDropped, omittedForAuthorization, alreadyDelivered, outOfSubscription }),
        receipt,
      });
      const log = digestLog.get(subscriptionId) ?? [];
      log.push(digest);
      digestLog.set(subscriptionId, log);
      deliveredIds.set(subscriptionId, delivered);

      // Advance on the program-zone grid so no window is skipped or covered twice.
      subscriptions[subscriptions.indexOf(subscription)] = Object.freeze({
        ...subscription,
        lastDigestAt: issuedAt,
        nextDueAt: nextBoundary(subscription.cadence, issuedAt),
      });
      return digest;
    },

    digests(subscriptionId) {
      return [...(digestLog.get(subscriptionId) ?? [])];
    },

    dispatchTestEvent(event, at) {
      const dispatchedAt = at === undefined ? nowIso() : typeof at === 'string' ? at : new Date(at.getTime()).toISOString();
      const rows: TestDispatchRow[] = [];
      for (const subscription of [...subscriptions].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (subscription.status !== 'active') continue;
        if (!subscription.eventTypes.includes(event.type)) {
          rows.push({ subscriptionId: subscription.id, recipientId: subscription.recipientId, delivered: false, reason: 'event-type-not-selected' });
          continue;
        }
        if (!scopeMatches(subscription.scope, event)) {
          rows.push({ subscriptionId: subscription.id, recipientId: subscription.recipientId, delivered: false, reason: 'out-of-scope' });
          continue;
        }
        const admission = admitEvent(deps, subscription.recipientId, event);
        if (!admission.ok) {
          rows.push({ subscriptionId: subscription.id, recipientId: subscription.recipientId, delivered: false, reason: 'not-admitted' });
          continue;
        }
        deps.channel.deliver({
          channel: 'simulated',
          kind: 'test-event',
          recipientId: subscription.recipientId,
          subscriptionId: subscription.id,
          eventIds: [event.id],
          at: dispatchedAt,
          summary: `SIMULATED test event (${event.type} on ${event.objectId}) - no real message sent`,
        });
        rows.push({ subscriptionId: subscription.id, recipientId: subscription.recipientId, delivered: true, reason: null });
      }
      return rows;
    },
  };
}
