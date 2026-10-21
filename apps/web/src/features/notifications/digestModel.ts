/**
 * Pure view models for the WD-015 notifications feature (FR-025 site and
 * system event alerts; FR-052 personal subscriptions).
 *
 * Dependency-free like qualityModel.ts: no React, no fixture imports, no
 * clock reads. The types are web-side mirrors of the API workflow shapes
 * (services/api/src/workflows/notifications/ - the web tsc program cannot
 * import the API sources); the panels feed these functions data (demo
 * defaults below, an API loader later) and render the returned rows.
 *
 * Every digest window label is formatted in the AGENCY TIME ZONE
 * (America/Denver) with the zone abbreviation visible, so a DST-crossing
 * window is self-evident; a browser clock never redefines a window (the
 * numerical and temporal rules).
 */

// ---------------------------------------------------------------------------
// Vocabulary (web-side mirrors of the notification workflow types)
// ---------------------------------------------------------------------------

export type NotificationEventType = 'new-site' | 'site-edit' | 'no-signal' | 'threshold';

export const EVENT_TYPES: readonly NotificationEventType[] = ['new-site', 'site-edit', 'no-signal', 'threshold'];

export const EVENT_TYPE_LABELS: Readonly<Record<NotificationEventType, string>> = {
  'new-site': 'New sites',
  'site-edit': 'Site edits',
  'no-signal': 'No signal',
  threshold: 'Threshold violations',
};

/** Digest grouping/sort order (matches the API digest entry order). */
export const EVENT_TYPE_ORDER: readonly NotificationEventType[] = ['new-site', 'site-edit', 'no-signal', 'threshold'];

export type NotificationCadence = 'hourly' | 'twice-daily' | 'daily' | 'weekly';

export const CADENCES: readonly NotificationCadence[] = ['hourly', 'twice-daily', 'daily', 'weekly'];

export const CADENCE_LABELS: Readonly<Record<NotificationCadence, string>> = {
  hourly: 'Hourly',
  'twice-daily': 'Twice daily (06:00 / 18:00)',
  daily: 'Daily',
  weekly: 'Weekly (Mon 07:00)',
};

/** Agency timezone for every schedule boundary and window label. */
export const PROGRAM_TIME_ZONE = 'America/Denver';

export type ThresholdBound = { readonly min?: number; readonly max?: number };
export type SubscriptionThresholds = Readonly<Record<string, ThresholdBound>>;

export type SubscriptionScopeView = { readonly kind: 'system' | 'stream'; readonly id: string };

export interface SubscriptionView {
  readonly id: string;
  readonly recipientId: string;
  readonly scope: SubscriptionScopeView;
  readonly eventTypes: readonly NotificationEventType[];
  readonly thresholds: SubscriptionThresholds;
  readonly cadence: NotificationCadence;
  readonly channelNote: string;
  readonly createdAt: string;
  readonly nextDueAt: string;
  readonly status: 'active' | 'cancelled';
}

export interface DigestEntryView {
  readonly eventId: string;
  readonly eventType: NotificationEventType;
  readonly objectId: string;
  readonly systemId: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly alertLink: string;
}

export interface DigestCountsView {
  readonly included: number;
  readonly duplicatesDropped: number;
  readonly omittedForAuthorization: number;
  readonly alreadyDelivered: number;
  readonly outOfSubscription: number;
}

export interface DigestView {
  readonly subscriptionId: string;
  readonly recipientId: string;
  readonly cadence: NotificationCadence;
  readonly issuedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly entries: readonly DigestEntryView[];
  readonly counts: DigestCountsView;
  /** Present when the simulated channel recorded a delivery. */
  readonly deliveredAt?: string | null;
}

// ---------------------------------------------------------------------------
// Agency-timezone formatting (fixed zone; deterministic)
// ---------------------------------------------------------------------------

interface WallClock {
  readonly dayKey: string;
  readonly hour: number;
  readonly minute: number;
  readonly zone: string;
  readonly weekday: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function denverWallClock(at: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PROGRAM_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
    timeZoneName: 'short',
  }).formatToParts(new Date(at));
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const hour = Number(value('hour'));
  const [year, month, day] = [Number(value('year')), Number(value('month')), Number(value('day'))];
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
  return { dayKey: `${value('year')}-${value('month')}-${value('day')}`, hour: hour === 24 ? 0 : hour, minute: Number(value('minute')), zone: value('timeZoneName'), weekday };
}

const hhmm = (wall: WallClock): string => `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;

/** '2026-03-09T13:00:00Z' -> '2026-03-09 07:00 MDT' (agency zone, always zoned). */
export function denverInstantLabel(at: string): string {
  const wall = denverWallClock(at);
  return `${wall.dayKey} ${hhmm(wall)} ${wall.zone}`;
}

/**
 * Window label in the agency zone: 'Mon 2026-03-09 07:00 → 08:00 MDT' on the
 * same local day, else 'Fri 2026-03-06 07:00 MST → Mon 2026-03-09 07:00 MDT'
 * (the zone is always shown so DST crossings are visible).
 */
export function windowLabel(windowStart: string, windowEnd: string): string {
  const start = denverWallClock(windowStart);
  const end = denverWallClock(windowEnd);
  const startText = `${start.weekday} ${start.dayKey} ${hhmm(start)}`;
  if (start.dayKey === end.dayKey) {
    return `${startText} → ${hhmm(end)} ${end.zone}`;
  }
  return `${startText} ${start.zone} → ${end.weekday} ${end.dayKey} ${hhmm(end)} ${end.zone}`;
}

// ---------------------------------------------------------------------------
// Digest view models (grouping, dedupe display, header)
// ---------------------------------------------------------------------------

export interface DigestHeaderView {
  readonly cadenceLabel: string;
  readonly windowLabelText: string;
  readonly zoneLabel: string;
  readonly issuedLabel: string;
  readonly entryCount: number;
  readonly dedupeNote: string;
  readonly empty: boolean;
  readonly deliveredNote: string;
}

/** The dedupe/omission line under a digest (counted, never listed). */
export function dedupeNote(counts: DigestCountsView): string {
  const parts: string[] = [];
  if (counts.duplicatesDropped > 0) parts.push(`${counts.duplicatesDropped} duplicate record${counts.duplicatesDropped === 1 ? '' : 's'} collapsed`);
  if (counts.omittedForAuthorization > 0) parts.push(`${counts.omittedForAuthorization} event${counts.omittedForAuthorization === 1 ? '' : 's'} omitted by current grants`);
  if (counts.alreadyDelivered > 0) parts.push(`${counts.alreadyDelivered} already delivered by an earlier digest`);
  if (counts.outOfSubscription > 0) parts.push(`${counts.outOfSubscription} outside this subscription's scope or event types`);
  return parts.length === 0 ? 'No duplicates or omissions in this window.' : `${parts.join(' · ')}.`;
}

export function digestHeaderView(digest: DigestView): DigestHeaderView {
  return {
    cadenceLabel: CADENCE_LABELS[digest.cadence],
    windowLabelText: windowLabel(digest.windowStart, digest.windowEnd),
    zoneLabel: PROGRAM_TIME_ZONE,
    issuedLabel: denverInstantLabel(digest.issuedAt),
    entryCount: digest.entries.length,
    dedupeNote: dedupeNote(digest.counts),
    empty: digest.entries.length === 0,
    deliveredNote:
      digest.deliveredAt != null
        ? `Delivered to the simulated channel at ${denverInstantLabel(digest.deliveredAt)} - no real message is ever sent.`
        : 'Nothing delivered for this window (empty digests send nothing).',
  };
}

export interface EntryRowModel {
  readonly eventId: string;
  readonly typeLabel: string;
  readonly objectId: string;
  readonly occurredAtLabel: string;
  readonly summary: string;
  readonly alertLink: string;
}

/** One row per deduped event (entries are already one-per-event). */
export function entryRows(entries: readonly DigestEntryView[]): readonly EntryRowModel[] {
  return entries.map((entry) => ({
    eventId: entry.eventId,
    typeLabel: EVENT_TYPE_LABELS[entry.eventType],
    objectId: entry.objectId,
    occurredAtLabel: denverInstantLabel(entry.occurredAt),
    summary: entry.summary,
    alertLink: entry.alertLink,
  }));
}

export interface EntryGroupModel {
  readonly eventType: NotificationEventType;
  readonly typeLabel: string;
  readonly rows: readonly EntryRowModel[];
}

/** Entries grouped by event type in the digest's type order (empty groups skipped). */
export function groupedEntries(entries: readonly DigestEntryView[]): readonly EntryGroupModel[] {
  return EVENT_TYPE_ORDER.filter((type) => entries.some((entry) => entry.eventType === type)).map((type) => ({
    eventType: type,
    typeLabel: EVENT_TYPE_LABELS[type],
    rows: entryRows(entries.filter((entry) => entry.eventType === type)),
  }));
}

// ---------------------------------------------------------------------------
// Subscription rows
// ---------------------------------------------------------------------------

export function scopeLabel(scope: SubscriptionScopeView): string {
  return scope.kind === 'system' ? `System ${scope.id}` : `Stream ${scope.id}`;
}

/** 'discharge max 25 cfs · stage 0-15 ft' (sorted by property, readable text). */
export function thresholdSummary(thresholds: SubscriptionThresholds): string {
  const parts = Object.keys(thresholds)
    .sort()
    .map((property) => {
      const bound = thresholds[property]!;
      if (bound.min !== undefined && bound.max !== undefined) return `${property} ${bound.min}-${bound.max}`;
      if (bound.max !== undefined) return `${property} max ${bound.max}`;
      return `${property} min ${bound.min}`;
    });
  return parts.length === 0 ? '' : parts.join(' · ');
}

export interface SubscriptionRowModel {
  readonly id: string;
  readonly scopeLabelText: string;
  readonly eventsLabelText: string;
  readonly cadenceLabelText: string;
  readonly thresholdLabelText: string;
  readonly channelNote: string;
  readonly nextDueLabelText: string;
  readonly isFavorite: boolean;
  /** Shape + text badge (never color alone). */
  readonly favoriteBadge: { readonly marker: string; readonly text: string } | null;
}

export function subscriptionRows(
  subscriptions: readonly SubscriptionView[],
  options: { readonly favoriteObjectIds?: readonly string[] } = {},
): readonly SubscriptionRowModel[] {
  const favorites = new Set(options.favoriteObjectIds ?? []);
  return [...subscriptions]
    .filter((subscription) => subscription.status === 'active')
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((subscription) => {
      const isFavorite = favorites.has(subscription.scope.id);
      return {
        id: subscription.id,
        scopeLabelText: scopeLabel(subscription.scope),
        eventsLabelText: subscription.eventTypes.map((type) => EVENT_TYPE_LABELS[type]).join(', '),
        cadenceLabelText: CADENCE_LABELS[subscription.cadence],
        thresholdLabelText: thresholdSummary(subscription.thresholds),
        channelNote: subscription.channelNote,
        nextDueLabelText: `${denverInstantLabel(subscription.nextDueAt)} (${PROGRAM_TIME_ZONE})`,
        isFavorite,
        favoriteBadge: isFavorite ? { marker: '★', text: 'scope is also a favorite' } : null,
      };
    });
}

// ---------------------------------------------------------------------------
// Fixture-derived demo state (panel defaults)
//
// The demo digest mirrors the API evidence scenario (schedules.test.ts): the
// Monday weekly digest whose window spans the 2026-03-08 spring-forward and
// includes the Fri+Sat+Sun weekend interval exactly once, deduped by event
// id, with one event omitted by current grants (counted, never listed).
// ---------------------------------------------------------------------------

const RECIPIENT = 'principal-fatima-engineer';

export const DEMO_SUBSCRIPTIONS: readonly SubscriptionView[] = [
  {
    id: 'nsub-000001',
    recipientId: RECIPIENT,
    scope: { kind: 'system', id: 'sys-bear-river' },
    eventTypes: ['new-site', 'site-edit', 'no-signal', 'threshold'],
    thresholds: { discharge: { max: 25 } },
    cadence: 'weekly',
    channelNote: 'Route through the duty desk digest',
    createdAt: '2026-03-02T15:00:00Z',
    nextDueAt: '2026-03-16T13:00:00Z',
    status: 'active',
  },
  {
    id: 'nsub-000002',
    recipientId: RECIPIENT,
    scope: { kind: 'stream', id: 'str-diag-voltage' },
    eventTypes: ['no-signal', 'threshold'],
    thresholds: { voltage: { min: 11.5, max: 15 } },
    cadence: 'hourly',
    channelNote: '',
    createdAt: '2026-03-02T15:00:00Z',
    nextDueAt: '2026-03-09T15:00:00Z',
    status: 'active',
  },
];

export const DEMO_DIGEST: DigestView = {
  subscriptionId: 'nsub-000001',
  recipientId: RECIPIENT,
  cadence: 'weekly',
  issuedAt: '2026-03-09T13:00:00Z',
  windowStart: '2026-03-02T15:00:00Z',
  windowEnd: '2026-03-09T13:00:00Z',
  entries: [
    { eventId: 'ev-fri-new', eventType: 'new-site', objectId: 'sta-bear-corinne', systemId: 'sys-bear-river', occurredAt: '2026-03-06T20:00:00Z', summary: 'new site Fri (13:00 MST)', alertLink: '/alerts/ev-fri-new' },
    { eventId: 'ev-sat-edit', eventType: 'site-edit', objectId: 'sta-hyrum-diversion-public', systemId: 'sys-bear-river', occurredAt: '2026-03-07T18:00:00Z', summary: 'metadata edit Sat (11:00 MST)', alertLink: '/alerts/ev-sat-edit' },
    { eventId: 'ev-sun-early', eventType: 'no-signal', objectId: 'sta-bear-corinne', systemId: 'sys-bear-river', occurredAt: '2026-03-08T07:00:00Z', summary: 'no signal Sun (00:00 MST, before the spring-forward)', alertLink: '/alerts/ev-sun-early' },
    { eventId: 'ev-sun-late', eventType: 'no-signal', objectId: 'sta-bear-corinne', systemId: 'sys-bear-river', occurredAt: '2026-03-08T15:00:00Z', summary: 'no signal Sun (09:00 MDT, after the spring-forward)', alertLink: '/alerts/ev-sun-late' },
    { eventId: 'th|str-corinne-q|discharge|2026-03-04T14:00:00Z', eventType: 'threshold', objectId: 'str-corinne-q', systemId: 'sys-bear-river', occurredAt: '2026-03-04T15:30:00Z', summary: 'threshold violation on str-corinne-q (discharge): 2 of 3 window readings outside max 25 cfs; worst 30 cfs (above max 25 cfs)', alertLink: '/alerts/th%7Cstr-corinne-q%7Cdischarge%7C2026-03-04T14%3A00%3A00Z' },
  ],
  counts: { included: 5, duplicatesDropped: 2, omittedForAuthorization: 1, alreadyDelivered: 0, outOfSubscription: 1 },
  deliveredAt: '2026-03-09T13:00:00Z',
};
