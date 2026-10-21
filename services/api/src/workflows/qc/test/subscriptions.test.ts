/**
 * QC subscription and digest tests (WD-013; FR-016; verification rows
 * T-06/T-15): scope choice (system/stream), the four cadences, digest
 * authorization (only streams within the RECIPIENT's entitlements, with
 * cross-system denial), violation-type sorting, matching context links,
 * dedupe per window and across windows, and subscription self-management.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/qc/test/subscriptions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CADENCES, CADENCE_MINUTES, createQcSubscriptionService, contextLinkFor, type QcSubscriptionService, type ViolationFeedItem } from '../subscriptions.ts';
import { DEFAULT_RULE_CONFIGS, DEFAULT_RULE_IDS, evaluate, type QcRuleFamily, type QcRuleVersion } from '../rules.ts';
import { CODY, DIEGO, FATIMA, NINA, PRIYA, SARAH, SYSTEM_BEAR, advancingClock, buildTestWorld, fixtureSeries } from './helpers.ts';

const DETECT_BASE = '2026-03-09T07:00:00Z';

/** The full golden violation set as a feed detected at/after the fixture clock. */
function goldenFeed(detectedAt: string): ViolationFeedItem[] {
  const series = fixtureSeries();
  const feed: ViolationFeedItem[] = [];
  for (const family of Object.keys(DEFAULT_RULE_CONFIGS) as QcRuleFamily[]) {
    const rule: QcRuleVersion = {
      ruleId: DEFAULT_RULE_IDS[family],
      family,
      version: 1,
      status: 'promoted',
      author: DIEGO,
      createdAt: DETECT_BASE,
      updatedAt: DETECT_BASE,
      config: DEFAULT_RULE_CONFIGS[family],
      notes: null,
    };
    for (const one of series) {
      for (const violation of evaluate(one, rule)) {
        feed.push({ violation, detectedAt, systemId: SYSTEM_BEAR });
      }
    }
  }
  return feed;
}

function service(clock: () => string): QcSubscriptionService {
  return createQcSubscriptionService({ world: buildTestWorld(), clock });
}

test('subscriptions pick system or stream scope and one of the four cadences; creation is own-account only', () => {
  const clock = advancingClock(Date.parse(DETECT_BASE));
  const svc = service(clock.clock);
  const created = svc.createSubscription(CODY, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, cadence: 'daily' });
  assert.ok(created.ok, JSON.stringify(created));
  assert.equal(created.subscription.cadence, 'daily');
  assert.equal(created.subscription.recipientId, CODY);
  assert.equal(created.subscription.createdAt, DETECT_BASE);
  assert.equal(created.subscription.nextDueAt, '2026-03-10T07:00:00Z');
  assert.deepEqual(CADENCES, ['hourly', 'twice-daily', 'daily', 'weekly']);
  assert.deepEqual(CADENCE_MINUTES, { hourly: 60, 'twice-daily': 720, daily: 1440, weekly: 10080 });

  // Anonymous and unknown identities are 401; bad cadence/system/stream are errors.
  const anonymous = svc.createSubscription(null, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, cadence: 'daily' });
  assert.ok(!anonymous.ok && 'status' in anonymous);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.reason, 'DENY_ANONYMOUS');
  const unknown = svc.createSubscription('principal-ghost', { scope: { kind: 'system', systemId: SYSTEM_BEAR }, cadence: 'daily' });
  assert.ok(!unknown.ok && 'status' in unknown);
  assert.equal(unknown.status, 401);
  const badCadence = svc.createSubscription(CODY, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, cadence: 'minutely' });
  assert.ok(!badCadence.ok && 'errors' in badCadence);
  assert.deepEqual(badCadence.errors, ['unknown-cadence']);
  const badSystem = svc.createSubscription(CODY, { scope: { kind: 'system', systemId: 'sys-atlantis' }, cadence: 'daily' });
  assert.ok(!badSystem.ok);
  assert.deepEqual(badSystem.errors, ['unknown-system']);

  // Subscriptions are own-account: only the recipient's own list is returned.
  assert.equal(svc.subscriptionsFor(CODY).length, 1);
  assert.equal(svc.subscriptionsFor(FATIMA).length, 0);
});

test('a stream-scope subscription may only target a stream the recipient can already read', () => {
  const svc = service(() => DETECT_BASE);
  const publicStream = svc.createSubscription(CODY, { scope: { kind: 'stream', streamId: 'str-corinne-q' }, cadence: 'hourly' });
  assert.ok(publicStream.ok, JSON.stringify(publicStream));
  // The researcher (dataset-scoped) cannot subscribe to the INTERNAL voltage
  // stream: the subscription must not become a visibility oracle.
  const sarahInternal = svc.createSubscription(SARAH, { scope: { kind: 'stream', streamId: 'str-diag-voltage' }, cadence: 'hourly' });
  assert.ok(!sarahInternal.ok && 'status' in sarahInternal);
  assert.equal(sarahInternal.status, 403);
  assert.equal(sarahInternal.reason, 'DENY_CAPABILITY_NOT_GRANTED');
  // A Weber engineer has the capability but not the Bear scope: cross-system denial at creation.
  const ninaInternal = svc.createSubscription(NINA, { scope: { kind: 'stream', streamId: 'str-diag-voltage' }, cadence: 'hourly' });
  assert.ok(!ninaInternal.ok && 'status' in ninaInternal);
  assert.equal(ninaInternal.status, 403);
  assert.equal(ninaInternal.reason, 'DENY_OUT_OF_SCOPE');
  // The Bear engineer CAN subscribe to the internal stream in her system.
  const fatimaInternal = svc.createSubscription(FATIMA, { scope: { kind: 'stream', streamId: 'str-diag-voltage' }, cadence: 'hourly' });
  assert.ok(fatimaInternal.ok, JSON.stringify(fatimaInternal));
});

test('hourly cadence: not due before nextDueAt; issuing covers exactly [creation, now) on the grid', () => {
  const clock = advancingClock(Date.parse(DETECT_BASE));
  const svc = service(clock.clock);
  const created = svc.createSubscription(CODY, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, cadence: 'hourly' });
  assert.ok(created.ok);
  const subId = created.subscription.id;
  const feed = goldenFeed('2026-03-09T07:10:00Z'); // detected 10 minutes in

  clock.advanceMinutes(30);
  const early = svc.buildDigest(subId, clock.now(), feed);
  assert.ok(!early.issued);
  assert.equal(early.reason, 'not-due');
  assert.equal(early.nextDueAt, '2026-03-09T08:00:00Z');
  assert.equal(svc.digests(subId).length, 0, 'a not-due digest is not recorded');

  clock.advanceMinutes(30); // now exactly 08:00 = nextDueAt
  const digest = svc.buildDigest(subId, clock.now(), feed);
  assert.ok(digest.issued);
  assert.equal(digest.windowStart, '2026-03-09T07:00:00Z');
  assert.equal(digest.windowEnd, '2026-03-09T08:00:00Z');
  // The schedule advanced by exactly one hourly step.
  assert.equal(svc.subscriptionsFor(CODY)[0]!.nextDueAt, '2026-03-09T09:00:00Z');
});

test('digest content is scope- and authorization-filtered: the commissioner sees public violations only', () => {
  const clock = advancingClock(Date.parse(DETECT_BASE));
  const svc = service(clock.clock);
  const created = svc.createSubscription(CODY, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, cadence: 'hourly' });
  assert.ok(created.ok);
  const feed = goldenFeed('2026-03-09T07:10:00Z');
  clock.advanceMinutes(60);
  const digest = svc.buildDigest(created.subscription.id, clock.now(), feed);
  assert.ok(digest.issued);

  // Feed composition (the expected.ts golden): str-corinne-q 12 (public),
  // str-corinne-stage 3 (public), str-diag-voltage 5 (INTERNAL), total 20.
  // Cody (review-data, Bear) may read both public streams but holds no
  // view-internal-diagnostics: the 5 internal voltage violations are counted
  // omitted and NEVER listed.
  const streams = new Set(digest.entries.map((entry) => entry.streamId));
  assert.deepEqual([...streams].sort(), ['str-corinne-q', 'str-corinne-stage']);
  assert.equal(digest.counts.included, 15);
  assert.equal(digest.counts.omittedForAuthorization, 5);
  assert.ok(digest.entries.every((entry) => entry.streamId !== 'str-diag-voltage'));
});

test('the Bear engineer digest includes the internal voltage violations; the Weber engineer and researcher get none of them (cross-system denial)', () => {
  const clock = advancingClock(Date.parse(DETECT_BASE));
  const svc = service(clock.clock);
  const feed = goldenFeed('2026-03-09T07:10:00Z');

  const fatimaSub = svc.createSubscription(FATIMA, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, cadence: 'hourly' });
  assert.ok(fatimaSub.ok);
  const priyaSub = svc.createSubscription(PRIYA, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, cadence: 'hourly' });
  assert.ok(priyaSub.ok, 'system-scope creation is open; the digest filter enforces authorization');
  const sarahSub = svc.createSubscription(SARAH, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, cadence: 'hourly' });
  assert.ok(sarahSub.ok);
  clock.advanceMinutes(60);

  // Fatima (view-internal-diagnostics, Bear): all 20 golden violations -
  // corinne-q 12 (public) + stage 3 (public) + voltage 5 (internal).
  const fatimaDigest = svc.buildDigest(fatimaSub.subscription.id, clock.now(), feed);
  assert.ok(fatimaDigest.issued);
  assert.equal(fatimaDigest.counts.included, 20);
  assert.equal(fatimaDigest.counts.omittedForAuthorization, 0);
  assert.ok(fatimaDigest.entries.some((entry) => entry.streamId === 'str-diag-voltage'));

  // Priya (Weber engineer without the internal capability): public only.
  const priyaDigest = svc.buildDigest(priyaSub.subscription.id, clock.now(), feed);
  assert.ok(priyaDigest.issued);
  assert.equal(priyaDigest.counts.included, 15, 'public streams only: corinne-q 12 + stage 3');
  assert.equal(priyaDigest.counts.omittedForAuthorization, 5, 'the 5 internal voltage violations never cross systems');
  assert.ok(priyaDigest.entries.every((entry) => entry.streamId !== 'str-diag-voltage'));

  // Sarah (dataset-scoped researcher): public only as well.
  const sarahDigest = svc.buildDigest(sarahSub.subscription.id, clock.now(), feed);
  assert.ok(sarahDigest.issued);
  assert.equal(sarahDigest.counts.included, 15);
  assert.ok(sarahDigest.entries.every((entry) => entry.streamId !== 'str-diag-voltage'));
});

test('entries are violation-TYPE sorted and every entry links to its matching filtered context', () => {
  const clock = advancingClock(Date.parse(DETECT_BASE));
  const svc = service(clock.clock);
  const created = svc.createSubscription(FATIMA, { scope: { kind: 'stream', streamId: 'str-corinne-q' }, cadence: 'hourly' });
  assert.ok(created.ok);
  clock.advanceMinutes(60);
  const digest = svc.buildDigest(created.subscription.id, clock.now(), goldenFeed('2026-03-09T07:10:00Z'));
  assert.ok(digest.issued);
  // Type sorting: range (2) first, then rate-of-change (6), then missing-data (3), then zero-value (1).
  assert.deepEqual(
    digest.entries.map((entry) => entry.family),
    ['range', 'range', 'rate-of-change', 'rate-of-change', 'rate-of-change', 'rate-of-change', 'rate-of-change', 'rate-of-change', 'missing-data', 'missing-data', 'missing-data', 'zero-value'],
  );
  for (const entry of digest.entries) {
    assert.equal(entry.contextLink, contextLinkFor({
      ruleId: entry.ruleId,
      ruleVersion: entry.ruleVersion,
      family: entry.family,
      streamId: entry.streamId,
      interval: entry.interval,
      observed: entry.observed,
      rationale: entry.rationale,
    }));
    assert.match(entry.contextLink, /^stream=str-corinne-q&type=/);
    assert.ok(entry.typeLabel.length > 0);
  }
});

test('dedupe: duplicates collapse within a window and a re-detected violation is never redelivered', () => {
  const clock = advancingClock(Date.parse(DETECT_BASE));
  const svc = service(clock.clock);
  const created = svc.createSubscription(CODY, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, cadence: 'hourly' });
  assert.ok(created.ok);
  const subId = created.subscription.id;

  // Same violation set detected twice in the first window (re-delivered run):
  // 40 feed items collapse to the 20 unique golden keys.
  const firstWindowFeed = [...goldenFeed('2026-03-09T07:10:00Z'), ...goldenFeed('2026-03-09T07:40:00Z')];
  clock.advanceMinutes(60);
  const first = svc.buildDigest(subId, clock.now(), firstWindowFeed);
  assert.ok(first.issued);
  assert.equal(first.counts.included, 15, 'corinne-q 12 + stage 3');
  assert.equal(first.counts.duplicatesDropped, 20, 'every golden key appeared twice in the window');
  assert.equal(first.counts.omittedForAuthorization, 5);
  assert.equal(first.counts.alreadyDelivered, 0);

  // Second window: the run re-detects the SAME violations (plus the voltage
  // items Cody may not see) - none of the already-delivered keys return.
  clock.advanceMinutes(60);
  const second = svc.buildDigest(subId, clock.now(), goldenFeed('2026-03-09T08:30:00Z'));
  assert.ok(second.issued);
  assert.equal(second.counts.included, 0);
  assert.equal(second.counts.alreadyDelivered, 15);
  assert.equal(second.counts.omittedForAuthorization, 5);
  // A genuinely NEW violation (a fresh draft rule version) IS delivered.
  const newRule: QcRuleVersion = {
    ruleId: 'qc-range',
    family: 'range',
    version: 2,
    status: 'promoted',
    author: DIEGO,
    createdAt: DETECT_BASE,
    updatedAt: DETECT_BASE,
    config: DEFAULT_RULE_CONFIGS.range,
    notes: null,
  };
  clock.advanceMinutes(60);
  const third = svc.buildDigest(subId, clock.now(), [...goldenFeed('2026-03-09T08:30:00Z'), { violation: evaluate(fixtureSeries()[0]!, newRule)[0]!, detectedAt: '2026-03-09T09:30:00Z', systemId: SYSTEM_BEAR }]);
  assert.ok(third.issued);
  assert.equal(third.counts.included, 1, 'v2 dedupe key differs from v1: new rule versions re-alert');
  assert.equal(third.entries[0]!.ruleVersion, 2);
});

test('weekly cadence issues after seven days; twice-daily after twelve hours; updates and cancellation work', () => {
  const clock = advancingClock(Date.parse(DETECT_BASE));
  const svc = service(clock.clock);
  const weekly = svc.createSubscription(CODY, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, cadence: 'weekly' });
  assert.ok(weekly.ok);
  clock.advanceMinutes(10079);
  assert.ok(!svc.buildDigest(weekly.subscription.id, clock.now(), []).issued);
  clock.advanceMinutes(1);
  const issued = svc.buildDigest(weekly.subscription.id, clock.now(), goldenFeed('2026-03-12T00:00:00Z'));
  assert.ok(issued.issued);
  assert.equal(issued.counts.included, 15);

  const twice = svc.createSubscription(FATIMA, { scope: { kind: 'system', systemId: SYSTEM_BEAR }, cadence: 'twice-daily' });
  assert.ok(twice.ok);
  clock.advanceMinutes(720);
  assert.ok(svc.buildDigest(twice.subscription.id, clock.now(), []).issued);

  const updated = svc.updateCadence(CODY, weekly.subscription.id, 'daily');
  assert.ok(updated.ok);
  assert.equal(updated.subscription.cadence, 'daily');
  const notOwn = svc.updateCadence(FATIMA, weekly.subscription.id, 'daily');
  assert.ok(!notOwn.ok && 'errors' in notOwn);
  assert.deepEqual(notOwn.errors, ['not-own-subscription']);
  const cancelled = svc.cancelSubscription(CODY, weekly.subscription.id);
  assert.ok(cancelled.ok);
  assert.equal(cancelled.subscription.status, 'cancelled');
  const afterCancel = svc.buildDigest(weekly.subscription.id, clock.now(), []);
  assert.ok(!afterCancel.issued);
  assert.equal(afterCancel.reason, 'cancelled');
  const unknown = svc.buildDigest('qsub-999999', clock.now(), []);
  assert.ok(!unknown.issued);
  assert.equal(unknown.reason, 'unknown-subscription');
});
