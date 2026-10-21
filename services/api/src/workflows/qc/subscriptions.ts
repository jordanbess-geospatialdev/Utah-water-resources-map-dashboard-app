/**
 * QC subscriptions and violation digests (WD-013; FR-016).
 *
 * "Users choose system or stream scope and hourly, twice-daily, daily or
 * weekly cadence; each digest contains only authorized violating streams,
 * supports violation-type sorting, and links to the matching context."
 *
 * MODEL:
 *
 * - SUBSCRIPTIONS are own-account objects (like preferences/tokens): the
 *   actor manages only their own (recipientId === session identity); an
 *   anonymous caller is 401. A STREAM-scoped subscription may only target a
 *   stream the recipient can already read (the same favorites rule as the
 *   policy engine: a subscription may not become a visibility oracle). A
 *   SYSTEM-scoped subscription is open to any authenticated principal - the
 *   per-stream authorization below does the actual filtering.
 * - CADENCE: hourly / twice-daily (12 h) / daily / weekly. A digest is only
 *   ISSUED at or after the subscription's nextDueAt; before that,
 *   buildDigest returns not-due. Issuing advances nextDueAt on the cadence
 *   grid so no violation window is ever skipped or double-covered.
 * - AUTHORIZATION: every feed item is admitted stream-by-stream through the
 *   entitlement engine (public stream -> browse-published public-read
 *   branch; restricted -> view-restricted-details; internal, e.g. the
 *   voltage diagnostics stream -> view-internal-diagnostics). NOBODY
 *   receives a violation outside their authorization, even when their
 *   subscription scope nominally covers it (cross-system denial is tested).
 *   Omitted items are counted, never listed.
 * - DEDUPE: within a digest window, duplicate violation records (same
 *   ruleId+version+stream+interval start, e.g. a re-delivered run) collapse
 *   to one entry and are counted; across windows, already-delivered
 *   violations are skipped and counted, so a re-detecting later run never
 *   delivers the same violation twice.
 * - TYPE SORTING: entries sort by violation type (range, rate-of-change,
 *   persistence, missing-data, zero-value), then stream, then interval.
 * - CONTEXT LINKS: every entry carries the filtered-context query
 *   (stream + type + interval) the violations view consumes.
 *
 * Purity: injected clock, no I/O. The feed (violations + detectedAt +
 * server-side systemId anchors) is passed in per call; membership is never
 * taken from the request body (FR-010).
 */
import type { Decision, PolicyWorld } from '../../../../../packages/policy/src/index.ts';
import { gateAct, instantIso, type PolicyEvaluator } from '../stewardship/gate.ts';
import { violationDedupeKey, type QcInterval, type QcRuleFamily, type QcViolation } from './rules.ts';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const CADENCES = ['hourly', 'twice-daily', 'daily', 'weekly'] as const;
export type DigestCadence = (typeof CADENCES)[number];

/** Cadence window lengths in minutes (twice-daily = 12 h). */
export const CADENCE_MINUTES: Readonly<Record<DigestCadence, number>> = Object.freeze({
  hourly: 60,
  'twice-daily': 720,
  daily: 1440,
  weekly: 10080,
});

/** Digest type-sort order (FR-016 "supports violation-type sorting"). */
export const FAMILY_SORT_ORDER: readonly QcRuleFamily[] = ['range', 'rate-of-change', 'persistence', 'missing-data', 'zero-value'];

export const TYPE_LABELS: Readonly<Record<QcRuleFamily, string>> = Object.freeze({
  range: 'Range (incl. voltage)',
  'rate-of-change': 'Rate of change',
  persistence: 'Persistence (stuck sensor)',
  'missing-data': 'Missing data',
  'zero-value': 'Suspect zero',
});

export type SubscriptionScope =
  | { readonly kind: 'system'; readonly systemId: string }
  | { readonly kind: 'stream'; readonly streamId: string };

export interface QcSubscription {
  readonly id: string;
  readonly recipientId: string;
  readonly scope: SubscriptionScope;
  readonly cadence: DigestCadence;
  readonly createdAt: string;
  readonly lastDigestAt: string | null;
  readonly nextDueAt: string;
  readonly status: 'active' | 'cancelled';
}

// ---------------------------------------------------------------------------
// Stream admission (shared with diagnostics.ts - one entitlement path)
// ---------------------------------------------------------------------------

export interface PolicyDeps {
  readonly world: PolicyWorld;
  /** REQUIRED injected clock. */
  readonly clock: () => Date | string;
  readonly policy?: PolicyEvaluator;
}

/**
 * Denial with the gate's status mapping (401 identity failures, 403 every
 * other denial). `decision` is the engine verdict when one was produced, or
 * null for pre-engine rejections (unknown object, anonymous caller).
 */
export interface StreamDenial {
  readonly ok: false;
  readonly status: 401 | 403;
  readonly reason: string;
  readonly detail: string;
  readonly decision: Decision | null;
}

export type Admission = { readonly ok: true } | StreamDenial;

/** The entitlement action that admits a stream by its visibility class. */
export function streamAdmissionAction(visibility: 'public' | 'restricted' | 'internal'): string {
  if (visibility === 'public') return 'browse-published';
  if (visibility === 'restricted') return 'view-restricted-details';
  return 'view-internal-diagnostics';
}

/**
 * May `principalId` read stream `streamId`? Resolved server-side from the
 * policy world object (never request-body membership), through the same
 * evaluate() every other read uses.
 */
export function admitStream(deps: PolicyDeps, principalId: string | null, streamId: string): Admission {
  const object = deps.world.objects[streamId];
  if (!object || object.kind !== 'datastream') {
    return { ok: false, status: 403, reason: 'DENY_UNKNOWN_OBJECT', detail: `no datastream "${streamId}" in the policy world`, decision: null };
  }
  const outcome = gateAct({ world: deps.world, clock: deps.clock, policy: deps.policy }, principalId, streamAdmissionAction(object.visibility), { kind: 'datastream', id: streamId });
  if (outcome.ok) return { ok: true };
  return { ok: false, status: outcome.status, reason: outcome.reason, detail: outcome.decision.detail ?? '', decision: outcome.decision };
}

// ---------------------------------------------------------------------------
// Feed and digest records
// ---------------------------------------------------------------------------

/** A violation as delivered to the digest builder: the QC output plus run metadata. */
export interface ViolationFeedItem {
  readonly violation: QcViolation;
  /** When the run detected the violation (ISO instant). */
  readonly detectedAt: string;
  /** Server-side scope anchor of the stream (FR-010: never from the feed producer's word alone). */
  readonly systemId: string;
}

export interface DigestEntry {
  readonly family: QcRuleFamily;
  readonly typeLabel: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly streamId: string;
  readonly systemId: string;
  readonly interval: QcInterval;
  readonly observed: string;
  readonly rationale: string;
  /** Filtered context link: the violations view pre-filtered to this entry. */
  readonly contextLink: string;
}

export interface DigestCounts {
  readonly included: number;
  readonly duplicatesDropped: number;
  readonly omittedForAuthorization: number;
  /** Violations already delivered by an earlier digest of this subscription (never re-delivered). */
  readonly alreadyDelivered: number;
}

export interface ViolationDigest {
  readonly issued: true;
  readonly subscriptionId: string;
  readonly recipientId: string;
  readonly cadence: DigestCadence;
  readonly scope: SubscriptionScope;
  readonly issuedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly entries: readonly DigestEntry[];
  readonly counts: DigestCounts;
}

export type DigestOutcome =
  | ViolationDigest
  | { readonly issued: false; readonly reason: 'not-due' | 'unknown-subscription' | 'cancelled'; readonly subscriptionId: string; readonly nextDueAt: string | null };

/** The filtered-context link for one violation (the FR-016 "matching context"). */
export function contextLinkFor(violation: QcViolation): string {
  return `stream=${violation.streamId}&type=${violation.family}&from=${violation.interval.start}&to=${violation.interval.end}`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type SubscriptionErrorCode = 'unknown-cadence' | 'unknown-system' | 'unknown-stream' | 'not-own-subscription';

export interface SubscriptionDeps extends PolicyDeps {}

export interface QcSubscriptionService {
  createSubscription(principalId: string | null, input: { readonly scope: SubscriptionScope; readonly cadence: DigestCadence | string }): { ok: true; subscription: QcSubscription } | { ok: false; errors: readonly SubscriptionErrorCode[] } | StreamDenial;
  updateCadence(principalId: string | null, subscriptionId: string, cadence: DigestCadence | string): { ok: true; subscription: QcSubscription } | { ok: false; errors: readonly ('unknown-subscription' | 'not-own-subscription' | 'unknown-cadence')[] };
  cancelSubscription(principalId: string | null, subscriptionId: string): { ok: true; subscription: QcSubscription } | { ok: false; errors: readonly ('unknown-subscription' | 'not-own-subscription')[] };
  subscriptionsFor(principalId: string): readonly QcSubscription[];
  /** Subscriptions whose nextDueAt is at/before `at` (the scheduler tick input). */
  dueSubscriptions(at: Date | string): readonly QcSubscription[];
  /** Build (and record) the digest for one subscription at `at`; not-due before nextDueAt. */
  buildDigest(subscriptionId: string, at: Date | string, feed: readonly ViolationFeedItem[]): DigestOutcome;
  digests(subscriptionId: string): readonly ViolationDigest[];
}

export function createQcSubscriptionService(deps: SubscriptionDeps): QcSubscriptionService {
  const subscriptions: QcSubscription[] = [];
  const digestLog = new Map<string, ViolationDigest[]>();
  /** Violation keys already delivered per subscription (cross-window dedupe). */
  const deliveredKeys = new Map<string, Set<string>>();
  let counter = 0;

  /** Milliseconds -> ISO instant without millisecond noise (deterministic goldens). */
  const isoMs = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');
  const nowIso = (): string => instantIso(deps.clock());

  const requireOwn = (principalId: string | null, subscriptionId: string): { ok: true; subscription: QcSubscription } | { ok: false; errors: readonly ('unknown-subscription' | 'not-own-subscription')[] } => {
    const subscription = subscriptions.find((candidate) => candidate.id === subscriptionId);
    if (!subscription) return { ok: false, errors: ['unknown-subscription'] };
    if (subscription.recipientId !== principalId) return { ok: false, errors: ['not-own-subscription'] };
    return { ok: true, subscription };
  };

  return {
    createSubscription(principalId, input) {
      // Own-account object: the session identity IS the recipient. Anonymous
      // or unresolvable identities get the gate's 401 mapping.
      const principal = principalId === null ? null : deps.world.principals[principalId] ?? null;
      if (!principal) {
        return {
          ok: false,
          status: 401,
          reason: principalId === null ? 'DENY_ANONYMOUS' : 'DENY_UNKNOWN_PRINCIPAL',
          detail: 'a QC subscription requires an authenticated recipient',
          decision: null,
        };
      }
      const errors: SubscriptionErrorCode[] = [];
      if (!(CADENCES as readonly string[]).includes(input?.cadence)) errors.push('unknown-cadence');
      const scope = input?.scope;
      if (scope?.kind === 'system') {
        const object = deps.world.objects[scope.systemId];
        if (!object || object.kind !== 'system') errors.push('unknown-system');
      } else if (scope?.kind === 'stream') {
        const object = deps.world.objects[scope.streamId];
        if (!object || object.kind !== 'datastream') errors.push('unknown-stream');
      } else {
        errors.push('unknown-stream');
      }
      if (errors.length > 0) return { ok: false, errors };

      // Stream-scope subscriptions may only target streams the recipient can
      // already read (favorites rule): a subscription must never become a
      // visibility oracle for internal or restricted streams.
      if (scope.kind === 'stream') {
        const admission = admitStream(deps, principalId, scope.streamId);
        if (!admission.ok) return admission;
      }

      const createdAt = nowIso();
      const cadence = input.cadence as DigestCadence;
      const subscription: QcSubscription = Object.freeze({
        id: `qsub-${String((counter += 1)).padStart(6, '0')}`,
        recipientId: principalId,
        scope,
        cadence,
        createdAt,
        lastDigestAt: null,
        nextDueAt: isoMs(Date.parse(createdAt) + CADENCE_MINUTES[cadence] * 60_000),
        status: 'active',
      });
      subscriptions.push(subscription);
      return { ok: true, subscription };
    },

    updateCadence(principalId, subscriptionId, cadence) {
      const own = requireOwn(principalId, subscriptionId);
      if (!own.ok) return own;
      if (!(CADENCES as readonly string[]).includes(cadence)) return { ok: false, errors: ['unknown-cadence'] };
      const updated = Object.freeze({ ...own.subscription, cadence: cadence as DigestCadence, nextDueAt: isoMs(Date.parse(own.subscription.lastDigestAt ?? own.subscription.createdAt) + CADENCE_MINUTES[cadence as DigestCadence] * 60_000) });
      subscriptions[subscriptions.indexOf(own.subscription)] = updated;
      return { ok: true, subscription: updated };
    },

    cancelSubscription(principalId, subscriptionId) {
      const own = requireOwn(principalId, subscriptionId);
      if (!own.ok) return own;
      const updated = Object.freeze({ ...own.subscription, status: 'cancelled' });
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

    buildDigest(subscriptionId, at, feed) {
      const subscription = subscriptions.find((candidate) => candidate.id === subscriptionId);
      if (!subscription) return { issued: false, reason: 'unknown-subscription', subscriptionId, nextDueAt: null };
      if (subscription.status === 'cancelled') return { issued: false, reason: 'cancelled', subscriptionId, nextDueAt: subscription.nextDueAt };
      const atMs = typeof at === 'string' ? Date.parse(at) : at.getTime();
      if (atMs < Date.parse(subscription.nextDueAt)) return { issued: false, reason: 'not-due', subscriptionId, nextDueAt: subscription.nextDueAt };

      // Non-overlapping window: [last digest end (or creation), now). A
      // violation is delivered by at most one digest, ever.
      const windowStartMs = Date.parse(subscription.lastDigestAt ?? subscription.createdAt);
      const inWindow = feed.filter((item) => {
        const detected = Date.parse(item.detectedAt);
        return detected >= windowStartMs && detected < atMs;
      });

      // Scope filter (system anchor or stream id), then dedupe by violation
      // key within the window (re-delivered runs count once).
      const scoped = inWindow.filter((item) =>
        subscription.scope.kind === 'system' ? item.systemId === subscription.scope.systemId : item.violation.streamId === subscription.scope.streamId,
      );
      const seen = new Set<string>();
      let duplicatesDropped = 0;
      const deduped: ViolationFeedItem[] = [];
      for (const item of [...scoped].sort((a, b) => (a.detectedAt < b.detectedAt ? -1 : a.detectedAt > b.detectedAt ? 1 : violationDedupeKey(a.violation) < violationDedupeKey(b.violation) ? -1 : 1))) {
        const key = violationDedupeKey(item.violation);
        if (seen.has(key)) {
          duplicatesDropped += 1;
          continue;
        }
        seen.add(key);
        deduped.push(item);
      }

      // Authorization: stream-by-stream through the entitlement engine. Only
      // ADMITTED violations enter the digest; the rest are counted, never listed.
      const delivered = deliveredKeys.get(subscriptionId) ?? new Set<string>();
      const entries: DigestEntry[] = [];
      let omittedForAuthorization = 0;
      let alreadyDelivered = 0;
      for (const item of deduped) {
        // Authorization first (an unauthorized violation was omitted, never
        // "delivered"), then the cross-window dedupe.
        const admission = admitStream(deps, subscription.recipientId, item.violation.streamId);
        if (!admission.ok) {
          omittedForAuthorization += 1;
          continue;
        }
        const key = violationDedupeKey(item.violation);
        if (delivered.has(key)) {
          alreadyDelivered += 1; // detected again by a later run but already in an earlier digest
          continue;
        }
        delivered.add(key);
        entries.push({
          family: item.violation.family,
          typeLabel: TYPE_LABELS[item.violation.family],
          ruleId: item.violation.ruleId,
          ruleVersion: item.violation.ruleVersion,
          streamId: item.violation.streamId,
          systemId: item.systemId,
          interval: item.violation.interval,
          observed: item.violation.observed,
          rationale: item.violation.rationale,
          contextLink: contextLinkFor(item.violation),
        });
      }

      // Type sorting (FR-016), then stream, then interval.
      entries.sort((a, b) => {
        const familyDelta = FAMILY_SORT_ORDER.indexOf(a.family) - FAMILY_SORT_ORDER.indexOf(b.family);
        if (familyDelta !== 0) return familyDelta;
        if (a.streamId !== b.streamId) return a.streamId < b.streamId ? -1 : 1;
        return a.interval.start < b.interval.start ? -1 : a.interval.start > b.interval.start ? 1 : a.ruleId < b.ruleId ? -1 : 1;
      });

      const issuedAt = isoMs(atMs);
      const digest: ViolationDigest = Object.freeze({
        issued: true,
        subscriptionId: subscription.id,
        recipientId: subscription.recipientId,
        cadence: subscription.cadence,
        scope: subscription.scope,
        issuedAt,
        windowStart: isoMs(windowStartMs),
        windowEnd: issuedAt,
        entries: Object.freeze(entries),
        counts: Object.freeze({ included: entries.length, duplicatesDropped, omittedForAuthorization, alreadyDelivered }),
      });
      const log = digestLog.get(subscriptionId) ?? [];
      log.push(digest);
      digestLog.set(subscriptionId, log);
      deliveredKeys.set(subscriptionId, delivered);

      // Advance the schedule on the cadence grid so no window is skipped.
      let nextMs = Date.parse(subscription.nextDueAt);
      while (nextMs <= atMs) nextMs += CADENCE_MINUTES[subscription.cadence] * 60_000;
      subscriptions[subscriptions.indexOf(subscription)] = Object.freeze({
        ...subscription,
        lastDigestAt: issuedAt,
        nextDueAt: isoMs(nextMs),
      });
      return digest;
    },

    digests(subscriptionId) {
      return [...(digestLog.get(subscriptionId) ?? [])];
    },
  };
}
