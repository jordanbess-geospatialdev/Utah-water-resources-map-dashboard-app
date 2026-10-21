/**
 * Feedback record and steward queue tests (WD-020; FR-018, FR-068).
 *
 * Run (zero dependencies):
 *   cd services/api && node --test --experimental-strip-types src/support/test/feedback.test.ts
 *
 * Pins:
 * - Validation caps and exclusions: bounded description, closed category
 *   enum, screenshot METADATA reference shape (data URLs and byte payloads
 *   rejected), submitter principal shape, and NO free-form URLs in any
 *   free-text field (the host allowlist is empty by policy).
 * - A support context that failed its redaction pass is rejected at submit -
 *   never stored, never queued.
 * - The steward queue: priority assignment per FR-018, rank-then-recency
 *   ordering, reproducible share query surfaced to the steward, and a
 *   defense-in-depth secret scan over the whole queue view.
 * - Fixture seed loads through the same validation path as live submits.
 * - Determinism: two identically-driven stores serialize byte-identically.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSupportContext, createSupportWorld, type SupportContextBundle } from '../supportContext.ts';
import {
  createFeedbackService,
  DESCRIPTION_MAX_LENGTH,
  FEEDBACK_CATEGORY_LABELS,
  seedFeedbackFixtures,
  type FeedbackSubmission,
} from '../feedback.ts';

const world = createSupportWorld();
const NOW = '2026-10-21T15:00:00Z';

function stepClock(start = Date.parse(NOW), stepMs = 60_000): () => string {
  let current = start - stepMs;
  return () => new Date((current += stepMs)).toISOString();
}

/** A clean, redaction-verified bundle built by the real builder. */
function cleanContext(): SupportContextBundle {
  return buildSupportContext({
    viewState: {
      filters: { distributionSystemIds: ['sys-bear-river'] },
      extent: { west: -112.5, south: 41.0, east: -111.0, north: 42.2 },
      selectedSiteId: 'sta-bear-corinne',
    },
    now: NOW,
    world,
  });
}

function submission(overrides: Partial<FeedbackSubmission> = {}): FeedbackSubmission {
  return {
    category: 'defect',
    description: 'The discharge chart on the linked view renders an empty axis after filtering to manual sites.',
    screenshotRef: null,
    context: cleanContext(),
    submittedBy: null,
    ...overrides,
  };
}

test('fixture seed loads through the same validation path and seeds the queue', () => {
  const service = createFeedbackService({ clock: stepClock() });
  assert.equal(service.stewardQueue().rows.length, 2);
  const seed = seedFeedbackFixtures();
  assert.equal(seed.length, 2);
  // The authenticated seed demonstrates the permitted-context degradation: a
  // restricted selection was already omitted from its link before storing.
  const codyContext = seed[1]!.context;
  assert.ok(codyContext.notices.some((notice) => notice.kind === 'site-omitted'));
  assert.ok(!JSON.stringify(codyContext).includes('sta-hyrum-diversion-owner'));
  assert.deepEqual(service.stewardQueue().secretFindings, []);
});

test('valid submission stores; anonymous and authenticated both allowed', () => {
  const service = createFeedbackService({ clock: stepClock(), seed: [] });
  const anonymous = service.submit(submission());
  assert.ok(anonymous.ok);
  assert.equal(anonymous.record.status, 'new');
  assert.equal(anonymous.record.priority, 'unassigned');
  assert.equal(anonymous.record.submittedBy, null);

  const cody = service.submit(submission({ submittedBy: 'principal-cody-commissioner', category: 'data-question' }));
  assert.ok(cody.ok);
  assert.equal(cody.record.submittedBy, 'principal-cody-commissioner');
});

test('description caps: too-short and too-long rejected, boundary lengths accepted', () => {
  const service = createFeedbackService({ clock: stepClock(), seed: [] });
  const short = service.submit(submission({ description: 'short' }));
  assert.ok(!short.ok);
  assert.ok(short.errors.includes('description-too-short'));

  const long = service.submit(submission({ description: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1) }));
  assert.ok(!long.ok);
  assert.ok(long.errors.includes('description-too-long'));

  const boundary = service.submit(submission({ description: 'y'.repeat(DESCRIPTION_MAX_LENGTH) }));
  assert.ok(boundary.ok);
});

test('no free-form URLs: http(s) and www links rejected (empty host allowlist)', () => {
  const service = createFeedbackService({ clock: stepClock(), seed: [] });
  for (const description of [
    'See https://evil.example/report for the repro steps I followed carefully.',
    'Repro on www.evil.example/dashboard every morning, not just today.',
  ]) {
    const outcome = service.submit(submission({ description }));
    assert.ok(!outcome.ok);
    assert.ok(outcome.errors.includes('free-form-url'));
  }
  const clean = service.submit(submission({ description: 'Repro: filter to flumes on the Bear River system view and read the freshness column.' }));
  assert.ok(clean.ok);
});

test('screenshot references are metadata ids only: data URLs, paths and byte payloads rejected', () => {
  const service = createFeedbackService({ clock: stepClock(), seed: [] });
  for (const screenshotRef of ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUg', '/tmp/scratch.png', 'ATT 001', 'att-OK uppercase', 'https://bucket.example/shot.png']) {
    const outcome = service.submit(submission({ screenshotRef }));
    assert.ok(!outcome.ok, screenshotRef);
    assert.ok(outcome.errors.includes('bad-screenshot-ref'));
  }
  const ok = service.submit(submission({ screenshotRef: 'att-screenshot-2026-10-21-001' }));
  assert.ok(ok.ok);
});

test('unknown category and malformed submitter rejected; multiple errors reported together', () => {
  const service = createFeedbackService({ clock: stepClock(), seed: [] });
  const outcome = service.submit(
    submission({ category: 'complaint' as FeedbackSubmission['category'], description: 'x', submittedBy: 'cody@example.org' }),
  );
  assert.ok(!outcome.ok);
  assert.deepEqual([...outcome.errors].sort(), ['bad-submitter', 'description-too-short', 'unknown-category']);
  assert.equal(service.stewardQueue().rows.length, 0, 'rejected submissions store nothing');
});

test('a context that failed its redaction pass is rejected, never stored or queued', () => {
  const service = createFeedbackService({ clock: stepClock(), seed: [] });
  // Forged bundle claiming clean scans while carrying a secret-shaped string.
  const forged: SupportContextBundle = {
    ...cleanContext(),
    shareQuery: 'v=1&api_key=0123456789abcdef0123456789abcdef',
  };
  const outcome = service.submit(submission({ context: forged }));
  assert.ok(!outcome.ok);
  assert.ok(outcome.errors.includes('context-not-clean'));

  const flagged: SupportContextBundle = {
    ...cleanContext(),
    redaction: { secretScan: 'findings', restrictedIdScan: 'clean' },
  };
  const flaggedOutcome = service.submit(submission({ context: flagged }));
  assert.ok(!flaggedOutcome.ok);
  assert.ok(flaggedOutcome.errors.includes('context-not-clean'));
  assert.equal(service.stewardQueue().rows.length, 0);
});

test('steward queue: priority assignment per FR-018 with rank-then-recency ordering', () => {
  const clock = stepClock();
  const service = createFeedbackService({ clock, seed: [] });
  const first = service.submit(submission({ description: 'First report: chart axis empty on the linked manual-site view.' }));
  const second = service.submit(submission({ category: 'improvement', description: 'Second report: it would help to show the observation count per site.' }));
  const third = service.submit(submission({ category: 'data-question', description: 'Third report: is the March 9 step change the documented outage?' }));
  assert.ok(first.ok && second.ok && third.ok);

  // Only a steward-shaped principal may prioritize; a submitter cannot.
  const notSteward = service.setPriority((second as { record: { id: string } }).record.id, 'p1', 'principal-cody-commissioner');
  assert.ok(!notSteward.ok);
  assert.equal(notSteward.ok && true, false);

  const p2 = service.setPriority((second as { record: { id: string } }).record.id, 'p2', 'principal-diego-steward');
  assert.ok(p2.ok);
  assert.equal(p2.record.priority, 'p2');
  assert.equal(p2.record.status, 'triaged', 'prioritizing triages a new record');
  assert.equal(p2.record.prioritizedBy, 'principal-diego-steward');

  const queue = service.stewardQueue();
  // P2 outranks unassigned; among unassigned, most recent first.
  assert.equal(queue.rows[0]!.id, (second as { record: { id: string } }).record.id);
  assert.equal(queue.rows[1]!.id, (third as { record: { id: string } }).record.id);
  assert.equal(queue.rows[2]!.id, (first as { record: { id: string } }).record.id);
  assert.ok(queue.rows[0]!.priorityLabel.startsWith('P2'));
  assert.equal(queue.rows[0]!.categoryLabel, FEEDBACK_CATEGORY_LABELS.improvement);
  assert.ok(queue.rows[0]!.shareQuery.startsWith('v=1&'), 'the reproducible share query reaches the steward');
  assert.deepEqual(queue.secretFindings, []);
});

test('descriptions carrying secret-shaped text are rejected at the door; the queue never sees them', () => {
  const clock = stepClock();
  const service = createFeedbackService({ clock, seed: [] });
  for (const description of [
    'The error dialog shows the text password=hunter2 when the export fails on my account.',
    'I pasted my token uwdat_aaaa0000bbbb1111 into the filter box and nothing matched.',
    'The request header reads Bearer abcdefghijklmnop and then fails.',
  ]) {
    const outcome = service.submit(submission({ description }));
    assert.ok(!outcome.ok, description);
    assert.ok(outcome.errors.includes('secret-shaped-text'));
  }
  assert.equal(service.stewardQueue().rows.length, 0);
  assert.deepEqual(service.stewardQueue().secretFindings, []);
});

test('status transitions by a steward; unknown records and unknown stewards rejected', () => {
  const clock = stepClock();
  const service = createFeedbackService({ clock, seed: [] });
  const added = service.submit(submission());
  assert.ok(added.ok);
  const id = (added as { record: { id: string } }).record.id;

  const resolved = service.setStatus(id, 'resolved', 'principal-diego-steward');
  assert.ok(resolved.ok);
  assert.equal(resolved.record.status, 'resolved');

  assert.deepEqual(service.setStatus('fb-999999', 'dismissed', 'principal-diego-steward'), { ok: false, reason: 'unknown-record' });
  const bad = service.setStatus(id, 'dismissed', 'principal-fatima-engineer');
  assert.ok(!bad.ok);
  assert.equal((bad as { reason: string }).reason, 'bad-steward');
});

test('determinism: two identically-driven stores serialize byte-identically (twice)', () => {
  const drive = (): string => {
    const clock = stepClock();
    const service = createFeedbackService({ clock, seed: seedFeedbackFixtures() });
    const a = service.submit(submission({ submittedBy: 'principal-sarah-researcher' }));
    const b = service.submit(submission({ category: 'access-issue', description: 'I cannot see the owner station my organization owns from the public map view.' }));
    if (service.setPriority((b as { record: { id: string } }).record.id, 'p1', 'principal-diego-steward').ok) void a;
    return service.serialize();
  };
  assert.equal(drive(), drive());
});
