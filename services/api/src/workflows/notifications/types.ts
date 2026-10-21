/**
 * Core vocabulary of the scoped alert subscription and digest workflow
 * (WD-015; FR-025, FR-052; FR-014/FR-016 calendar context).
 *
 * "Subscriptions distinguish new sites, site edits, no signal and threshold
 * violations; a test event reaches only eligible subscribers and the alert
 * link repeats the authorization check." (FR-025)
 *
 * "A registered user favorites any published site ... and manages personal
 * subscriptions; removing a favorite or subscription persists and does not
 * alter a site's authority or ownership." (FR-052)
 *
 * MODEL OVERVIEW (semantics live with the modules that enforce them):
 *
 * - A SUBSCRIPTION is an own-account preference (like favorites): the session
 *   identity IS the recipient, the chosen event types are the FR-025 four,
 *   the scope is a system or a stream, the cadence is one of the four digest
 *   schedules (schedules.ts, America/Denver), and the channel is a NOTE -
 *   free-form display text, never an address book or a credential.
 * - A NOTIFICATION EVENT is what happened: one of the four FR-025 types with
 *   the object it happened to (station or datastream), the server-side
 *   system anchor, the occurrence instant and a payload summary. Events are
 *   INPUTS to the digest builder (pure, injected per call - never trusted
 *   membership from a request body, FR-010).
 * - A DIGEST is one issued window: boundary-aligned in the program zone,
 *   entry-per-event (dedupe by event id), every entry admitted by the
 *   entitlement engine at build time through the recipient's CURRENT grants.
 * - A DELIVERY RECEIPT is the record of a message handed to the SIMULATED
 *   channel. There is no email, SMS or webhook code anywhere in this
 *   package - delivery is an interface plus an in-memory recorder so tests
 *   can assert exactly who would have received what, and prove that
 *   non-delivery paths hand the channel NOTHING.
 */

// ---------------------------------------------------------------------------
// Event vocabulary (FR-025)
// ---------------------------------------------------------------------------

/** The four FR-025 event kinds a subscription may select. */
export const NOTIFICATION_EVENT_TYPES = ['new-site', 'site-edit', 'no-signal', 'threshold'] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export const EVENT_TYPE_LABELS: Readonly<Record<NotificationEventType, string>> = Object.freeze({
  'new-site': 'New sites',
  'site-edit': 'Site edits',
  'no-signal': 'No signal',
  threshold: 'Threshold violations',
});

/** Digest entry sort order (stable, documented; new-site first like the PRD lists them). */
export const EVENT_TYPE_SORT_ORDER: readonly NotificationEventType[] = ['new-site', 'site-edit', 'no-signal', 'threshold'];

/** The kind of object an event is about (drives the admission action). */
export type NotificationObjectKind = 'station' | 'datastream';

// ---------------------------------------------------------------------------
// Cadence vocabulary (schedules.ts owns the calendar semantics)
// ---------------------------------------------------------------------------

export const NOTIFICATION_CADENCES = ['hourly', 'twice-daily', 'daily', 'weekly'] as const;
export type NotificationCadence = (typeof NOTIFICATION_CADENCES)[number];

export const CADENCE_LABELS: Readonly<Record<NotificationCadence, string>> = Object.freeze({
  hourly: 'Hourly',
  'twice-daily': 'Twice daily (06:00 / 18:00)',
  daily: 'Daily',
  weekly: 'Weekly (Mon 07:00)',
});

/**
 * Program zone for every digest boundary and window label (America/Denver,
 * single-sourced in schedules.ts from the shared analytics constants so
 * WD-014's calendar semantics and this workflow can never diverge).
 */
export { PROGRAM_TIME_ZONE } from './schedules.ts';

// ---------------------------------------------------------------------------
// Threshold configuration (thresholds.ts)
// ---------------------------------------------------------------------------

/**
 * One property's alert bounds. At least one bound must be present; a value
 * outside [min, max] is a threshold violation. `null` readings (reported but
 * empty frames) are the no-signal/missing-data story, never a threshold hit.
 */
export interface ThresholdBound {
  readonly min?: number;
  readonly max?: number;
}

/** Alert bounds per observedPropertyId (discharge, stage, voltage, ...). */
export type SubscriptionThresholds = Readonly<Record<string, ThresholdBound>>;

// ---------------------------------------------------------------------------
// Subscription (FR-052: own-account; removal persists; never grants anything)
// ---------------------------------------------------------------------------

export type SubscriptionScope =
  | { readonly kind: 'system'; readonly systemId: string }
  | { readonly kind: 'stream'; readonly streamId: string };

/** Channel note bound (matches the WD-009 preference seam). */
export const CHANNEL_NOTE_MAX_LENGTH = 120;

export interface Subscription {
  readonly id: string;
  /** Recipient = session identity at creation; never a body field. */
  readonly recipientId: string;
  readonly scope: SubscriptionScope;
  /** Non-empty subset of the four FR-025 event types. */
  readonly eventTypes: readonly NotificationEventType[];
  /** Per-property alert bounds for `threshold` events (validated by thresholds.ts). */
  readonly thresholds: SubscriptionThresholds;
  readonly cadence: NotificationCadence;
  /** Free-form display note. Placeholder until a real delivery pipeline exists. */
  readonly channelNote: string;
  readonly createdAt: string;
  /** Boundary instant of the last issued digest (null before the first). */
  readonly lastDigestAt: string | null;
  /** Next digest boundary (program-zone schedule; schedules.ts). */
  readonly nextDueAt: string;
  /** Cancelled is terminal: removal persists and nothing is ever issued again. */
  readonly status: 'active' | 'cancelled';
}

// ---------------------------------------------------------------------------
// Notification events (workflow inputs, pure data)
// ---------------------------------------------------------------------------

export interface NotificationEvent {
  /**
   * Stable event id - THE dedupe key. A re-delivered event record (same id)
   * collapses to one digest entry; a sustained threshold violation yields one
   * id per (stream, property, window) (thresholds.ts).
   */
  readonly id: string;
  readonly type: NotificationEventType;
  readonly objectKind: NotificationObjectKind;
  readonly objectId: string;
  /** Server-side system anchor (FR-010: scope resolution, never feed word alone). */
  readonly systemId: string;
  /** Present on threshold events: the stream the bounds were evaluated on. */
  readonly streamId: string | null;
  /** ISO instant the event occurred at (window membership is by this field). */
  readonly occurredAt: string;
  /** Payload summary - human text, no credentials, no internal note content. */
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

export interface DigestEntry {
  /** Dedupe key (== the event id; entries are one-per-event per digest). */
  readonly eventId: string;
  readonly eventType: NotificationEventType;
  readonly eventTypeLabel: string;
  readonly objectKind: NotificationObjectKind;
  readonly objectId: string;
  readonly systemId: string;
  readonly occurredAt: string;
  readonly summary: string;
  /** Alert link that RE-RUNS authorization at resolve time (alertLinks.ts). */
  readonly alertLink: string;
}

export interface DigestCounts {
  readonly included: number;
  /** Same-id records inside this window collapsed to one entry. */
  readonly duplicatesDropped: number;
  /** Events the recipient's CURRENT grants do not admit (counted, never listed). */
  readonly omittedForAuthorization: number;
  /** Events already delivered by an earlier digest of this subscription. */
  readonly alreadyDelivered: number;
  /** Events outside the subscription scope or selected event types. */
  readonly outOfSubscription: number;
}

export interface NotificationDigest {
  readonly issued: true;
  readonly subscriptionId: string;
  readonly recipientId: string;
  readonly cadence: NotificationCadence;
  readonly scope: SubscriptionScope;
  /** Digest boundary (window end) - a program-zone schedule instant. */
  readonly issuedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly entries: readonly DigestEntry[];
  /** Dedupe keys of the included entries (== their event ids, same order). */
  readonly dedupeKeys: readonly string[];
  readonly counts: DigestCounts;
  /** Receipt handed to the SIMULATED channel; null when there was nothing to send. */
  readonly receipt: DeliveryReceipt | null;
}

export type DigestOutcome =
  | NotificationDigest
  | {
      readonly issued: false;
      readonly reason: 'not-due' | 'unknown-subscription' | 'cancelled';
      readonly subscriptionId: string;
      readonly nextDueAt: string | null;
    };

// ---------------------------------------------------------------------------
// Delivery - SIMULATED channel only
// ---------------------------------------------------------------------------

export type DeliveryKind = 'digest' | 'test-event';

/**
 * The record of one message handed to the delivery channel.
 *
 * THIS IS THE WHOLE DELIVERY SURFACE OF WD-015: an in-memory record. There is
 * deliberately NO email, SMS, push or webhook implementation anywhere in this
 * package - the real transport is a later, separately approved task. The
 * receipt exists so tests (and the eventual operator view) can assert exactly
 * which recipient would have received which entries, and that non-delivery
 * paths produce NOTHING.
 */
export interface DeliveryReceipt {
  readonly channel: 'simulated';
  readonly kind: DeliveryKind;
  readonly recipientId: string;
  readonly subscriptionId: string | null;
  readonly eventIds: readonly string[];
  readonly at: string;
  readonly summary: string;
}

/**
 * The delivery port. The production pipeline will bind this to a real,
 * separately approved transport; WD-015 ships exactly one implementation:
 * the in-memory recorder below (used by tests and the demo panels).
 */
export interface DeliveryChannel {
  deliver(receipt: DeliveryReceipt): void;
}

/** In-memory recorder: the simulated channel. Nothing is ever sent anywhere. */
export interface DeliveryRecorder extends DeliveryChannel {
  /** Every receipt in delivery order. */
  receipts(): readonly DeliveryReceipt[];
  /** Receipts for one recipient (any kind). */
  receiptsFor(recipientId: string): readonly DeliveryReceipt[];
  /** Total receipts handed over - the non-delivery assertions read this. */
  count(): number;
}

export function createDeliveryRecorder(): DeliveryRecorder {
  const receipts: DeliveryReceipt[] = [];
  return {
    deliver(receipt) {
      receipts.push(Object.freeze({ ...receipt, eventIds: Object.freeze([...receipt.eventIds]) }));
    },
    receipts() {
      return [...receipts];
    },
    receiptsFor(recipientId) {
      return receipts.filter((receipt) => receipt.recipientId === recipientId);
    },
    count() {
      return receipts.length;
    },
  };
}
