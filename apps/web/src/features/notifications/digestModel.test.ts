/**
 * Pure digest/subscription view-model tests (WD-015; FR-025, FR-052; T-15):
 * window labels render in the AGENCY timezone (America/Denver) with the zone
 * visible across the 2026-03-08 DST boundary, entries group by event type in
 * the digest order, dedupe display summarizes counted-not-listed omissions,
 * subscription rows show scope/cadence/thresholds and the favorites badge,
 * and the demo constants stay consistent with the API evidence scenario.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/notifications/digestModel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const model: typeof import('./digestModel') = await import('./digestModel');
const {
  CADENCES,
  CADENCE_LABELS,
  DEMO_DIGEST,
  DEMO_SUBSCRIPTIONS,
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  PROGRAM_TIME_ZONE,
  denverInstantLabel,
  digestHeaderView,
  dedupeNote,
  entryRows,
  groupedEntries,
  scopeLabel,
  subscriptionRows,
  thresholdSummary,
  windowLabel,
} = model;
type DigestCountsView = import('./digestModel').DigestCountsView;
type DigestEntryView = import('./digestModel').DigestEntryView;

test('instant labels render in the agency timezone with the zone visible (MST/MDT across the 2026-03-08 jump)', () => {
  assert.equal(PROGRAM_TIME_ZONE, 'America/Denver');
  assert.equal(denverInstantLabel('2026-03-07T14:00:00Z'), '2026-03-07 07:00 MST');
  assert.equal(denverInstantLabel('2026-03-08T12:00:00Z'), '2026-03-08 06:00 MDT');
  assert.equal(denverInstantLabel('2026-03-09T13:00:00Z'), '2026-03-09 07:00 MDT');
});

test('window labels: same-day short form; cross-day and DST-crossing forms name both zones', () => {
  assert.equal(windowLabel('2026-03-09T13:00:00Z', '2026-03-09T14:00:00Z'), 'Mon 2026-03-09 07:00 → 08:00 MDT');
  // The DST-crossing daily window: 07:00 MST Sat -> 07:00 MDT Sun.
  assert.equal(windowLabel('2026-03-07T14:00:00Z', '2026-03-08T13:00:00Z'), 'Sat 2026-03-07 07:00 MST → Sun 2026-03-08 07:00 MDT');
  // The demo weekly window spans a week.
  assert.equal(windowLabel('2026-03-02T15:00:00Z', '2026-03-09T13:00:00Z'), 'Mon 2026-03-02 08:00 MST → Mon 2026-03-09 07:00 MDT');
});

test('dedupe display: counted omissions read as one line; the clean case says so', () => {
  const clean: DigestCountsView = { included: 2, duplicatesDropped: 0, omittedForAuthorization: 0, alreadyDelivered: 0, outOfSubscription: 0 };
  assert.equal(dedupeNote(clean), 'No duplicates or omissions in this window.');
  const busy: DigestCountsView = { included: 5, duplicatesDropped: 2, omittedForAuthorization: 1, alreadyDelivered: 3, outOfSubscription: 1 };
  assert.equal(
    dedupeNote(busy),
    "2 duplicate records collapsed · 1 event omitted by current grants · 3 already delivered by an earlier digest · 1 outside this subscription's scope or event types.",
  );
});

test('entries group by event type in the digest order; empty groups are skipped; rows keep alert links', () => {
  const entries: readonly DigestEntryView[] = [
    { eventId: 't1', eventType: 'threshold', objectId: 'str-corinne-q', systemId: 'sys-bear-river', occurredAt: '2026-03-04T15:30:00Z', summary: 'threshold', alertLink: '/alerts/t1' },
    { eventId: 'n1', eventType: 'new-site', objectId: 'sta-bear-corinne', systemId: 'sys-bear-river', occurredAt: '2026-03-06T20:00:00Z', summary: 'new', alertLink: '/alerts/n1' },
    { eventId: 's1', eventType: 'site-edit', objectId: 'sta-hyrum-diversion-public', systemId: 'sys-bear-river', occurredAt: '2026-03-07T18:00:00Z', summary: 'edit', alertLink: '/alerts/s1' },
  ];
  const groups = groupedEntries(entries);
  assert.deepEqual(
    groups.map((group) => group.eventType),
    ['new-site', 'site-edit', 'threshold'],
  );
  assert.equal(groups[0]!.typeLabel, 'New sites');
  assert.equal(groups[0]!.rows[0]!.occurredAtLabel, '2026-03-06 13:00 MST');
  assert.equal(groups[2]!.rows[0]!.alertLink, '/alerts/t1');
  // No 'no-signal' group: empty groups never render.
  assert.ok(groups.every((group) => group.rows.length > 0));
  assert.deepEqual(
    entryRows(entries).map((row) => row.eventId),
    ['t1', 'n1', 's1'],
    'entryRows preserves the given order (the digest already sorted them)',
  );
});

test('digest header: cadence label, agency-zone window label, dedupe note, simulated-delivery note', () => {
  const header = digestHeaderView(DEMO_DIGEST);
  assert.equal(header.cadenceLabel, 'Weekly (Mon 07:00)');
  assert.equal(header.windowLabelText, 'Mon 2026-03-02 08:00 MST → Mon 2026-03-09 07:00 MDT');
  assert.equal(header.zoneLabel, 'America/Denver');
  assert.equal(header.issuedLabel, '2026-03-09 07:00 MDT');
  assert.equal(header.entryCount, 5);
  assert.equal(header.empty, false);
  assert.ok(header.deliveredNote.includes('simulated channel'), header.deliveredNote);
  assert.ok(dedupeNote(DEMO_DIGEST.counts).includes('omitted by current grants'));

  const empty = digestHeaderView({ ...DEMO_DIGEST, entries: [], deliveredAt: null });
  assert.equal(empty.empty, true);
  assert.equal(empty.entryCount, 0);
  assert.ok(empty.deliveredNote.includes('empty digests send nothing'));
});

test('subscription rows: scope/cadence/event labels, threshold text, next-due in the agency zone, favorites badge', () => {
  assert.deepEqual(CADENCES, ['hourly', 'twice-daily', 'daily', 'weekly']);
  assert.deepEqual(EVENT_TYPES, ['new-site', 'site-edit', 'no-signal', 'threshold']);
  assert.equal(CADENCE_LABELS['twice-daily'], 'Twice daily (06:00 / 18:00)');
  assert.equal(scopeLabel({ kind: 'system', id: 'sys-bear-river' }), 'System sys-bear-river');
  assert.equal(scopeLabel({ kind: 'stream', id: 'str-corinne-q' }), 'Stream str-corinne-q');

  const rows = subscriptionRows(DEMO_SUBSCRIPTIONS, { favoriteObjectIds: ['str-diag-voltage'] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.scopeLabelText, 'System sys-bear-river');
  assert.equal(rows[0]!.cadenceLabelText, 'Weekly (Mon 07:00)');
  assert.equal(rows[0]!.thresholdLabelText, 'discharge max 25');
  assert.equal(rows[0]!.nextDueLabelText, '2026-03-16 07:00 MDT (America/Denver)');
  assert.equal(rows[0]!.favoriteBadge, null, 'the system scope is not a favorited object');
  assert.equal(rows[1]!.favoriteBadge?.marker, '★');
  assert.equal(rows[1]!.favoriteBadge?.text, 'scope is also a favorite');
  assert.equal(rows[1]!.thresholdLabelText, 'voltage 11.5-15');

  // Cancelled subscriptions never render as rows (removal persists).
  const withCancelled = subscriptionRows([...DEMO_SUBSCRIPTIONS, { ...DEMO_SUBSCRIPTIONS[0]!, id: 'nsub-000003', status: 'cancelled' }]);
  assert.equal(withCancelled.length, 2);
});

test('threshold summary text covers min-only, max-only and bounded properties', () => {
  assert.equal(thresholdSummary({}), '');
  assert.equal(thresholdSummary({ discharge: { max: 25 } }), 'discharge max 25');
  assert.equal(thresholdSummary({ voltage: { min: 11.5 } }), 'voltage min 11.5');
  assert.equal(thresholdSummary({ stage: { min: 0, max: 15 }, discharge: { min: 0, max: 1200 } }), 'discharge 0-1200 · stage 0-15');
});

test('the demo digest is consistent: entries grouped without gaps, every entry carries an alert link', () => {
  const groups = groupedEntries(DEMO_DIGEST.entries);
  assert.deepEqual(
    groups.map((group) => group.eventType),
    ['new-site', 'site-edit', 'no-signal', 'threshold'],
  );
  assert.equal(groups.reduce((total, group) => total + group.rows.length, 0), DEMO_DIGEST.counts.included);
  assert.ok(DEMO_DIGEST.entries.every((entry) => entry.alertLink.startsWith('/alerts/')));
  // The demo subscriptions reference the same recipient as the digest.
  assert.ok(DEMO_SUBSCRIPTIONS.every((subscription) => subscription.recipientId === DEMO_DIGEST.recipientId));
});
