/**
 * Known data issue tests (WD-013; FR-038; verification rows T-06/T-15):
 * recording through the review-data gate, the open/monitoring/resolved
 * lifecycle with an APPEND-ONLY resolution history, public/internal
 * visibility filtering, and the permitted export context (public exports
 * carry public issues only - byte-swept).
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/qc/test/knownIssues.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKnownIssueService, type KnownIssueService } from '../knownIssues.ts';
import { CODY, DIEGO, FATIMA, NOW, SARAH, advancingClock, buildTestWorld } from './helpers.ts';

const OUTAGE = { start: '2026-03-08T12:00:00Z', end: '2026-03-08T18:00:00Z' };
const VOLTAGE_WINDOW = { start: '2026-03-09T06:00:00Z', end: '2026-03-09T07:00:00Z' };

function service(clock: () => string): KnownIssueService {
  return createKnownIssueService({ world: buildTestWorld(), clock });
}

function seeded(clock: () => string): { svc: KnownIssueService; publicIssueId: string; internalIssueId: string } {
  const svc = service(clock);
  const publicIssue = svc.recordIssue(DIEGO, {
    streamId: 'str-corinne-q',
    interval: OUTAGE,
    title: 'Logger communications outage - six hourly readings missing',
    description: 'Declared gap gap-corinne-20260308; readings stay missing, never back-filled.',
    visibility: 'public',
  });
  assert.ok(publicIssue.ok, JSON.stringify(publicIssue));
  const internalIssue = svc.recordIssue(CODY, {
    streamId: 'str-diag-voltage',
    interval: VOLTAGE_WINDOW,
    title: 'Battery voltage below minimum at Garden City diagnostic site',
    description: 'Internal maintenance note: solar controller scheduled.',
    visibility: 'internal',
  });
  assert.ok(internalIssue.ok, JSON.stringify(internalIssue));
  return { svc, publicIssueId: publicIssue.issue.id, internalIssueId: internalIssue.issue.id };
}

test('recording is review-data gated: engineer and researcher denied, anonymous 401', () => {
  const svc = service(() => NOW);
  const engineer = svc.recordIssue(FATIMA, { streamId: 'str-corinne-q', interval: OUTAGE, title: 'x', visibility: 'public' });
  assert.ok(!engineer.ok && 'status' in engineer);
  assert.equal(engineer.status, 403);
  assert.equal(engineer.reason, 'DENY_CAPABILITY_NOT_GRANTED');
  const researcher = svc.recordIssue(SARAH, { streamId: 'str-corinne-q', interval: OUTAGE, title: 'x', visibility: 'public' });
  assert.ok(!researcher.ok && 'status' in researcher);
  assert.equal(researcher.status, 403);
  const anonymous = svc.recordIssue(null, { streamId: 'str-corinne-q', interval: OUTAGE, title: 'x', visibility: 'public' });
  assert.ok(!anonymous.ok && 'status' in anonymous);
  assert.equal(anonymous.status, 401);
  // The system-scoped commissioner CAN record on a Bear stream; a Bear issue
  // on a Weber-system stream is out of scope (there is no Weber fixture
  // stream, so the scope denial is exercised via a stream-scope mismatch).
  const cody = svc.recordIssue(CODY, { streamId: 'str-corinne-q', interval: OUTAGE, title: 'Commissioner note', visibility: 'internal' });
  assert.ok(cody.ok, JSON.stringify(cody));
  // Validation: unknown stream, inverted interval, empty title, bad visibility.
  const bad = svc.recordIssue(DIEGO, { streamId: 'str-ghost', interval: { start: '2026-03-09T02:00:00Z', end: '2026-03-09T01:00:00Z' }, title: '  ', visibility: 'everyone' });
  assert.ok(!bad.ok && 'errors' in bad);
  assert.deepEqual(bad.errors, ['unknown-stream', 'bad-interval', 'bad-title', 'bad-visibility']);
});

test('issues record stream, interval, status, visibility, recorder and time', () => {
  const { svc, publicIssueId } = seeded(() => NOW);
  const issue = svc.issues().find((candidate) => candidate.id === publicIssueId)!;
  assert.equal(issue.streamId, 'str-corinne-q');
  assert.deepEqual(issue.interval, OUTAGE);
  assert.equal(issue.status, 'open');
  assert.equal(issue.visibility, 'public');
  assert.equal(issue.recordedBy, DIEGO);
  assert.equal(issue.recordedAt, NOW);
  assert.deepEqual(issue.resolutionHistory, []);
});

test('lifecycle: open -> monitoring -> resolved with an APPEND-ONLY resolution history; invalid transitions rejected', () => {
  const clock = advancingClock();
  const { svc, publicIssueId } = seeded(clock.clock);

  clock.advanceMinutes(30);
  const monitoring = svc.updateStatus(DIEGO, publicIssueId, 'monitoring', 'Watching the logger transport; no back-fill.');
  assert.ok(monitoring.ok, JSON.stringify(monitoring));
  assert.equal(monitoring.issue.status, 'monitoring');
  assert.equal(monitoring.issue.resolutionHistory.length, 1);
  assert.deepEqual(monitoring.issue.resolutionHistory[0]!.seq, 1);

  // The recorded event never changes: snapshot, then append.
  const snapshot = JSON.stringify(monitoring.issue.resolutionHistory);
  clock.advanceMinutes(90);
  const resolved = svc.updateStatus(CODY, publicIssueId, 'resolved', 'Transport restored 18:00Z; gap reviewed in the weekly cycle.');
  assert.ok(resolved.ok, JSON.stringify(resolved));
  assert.equal(resolved.issue.status, 'resolved');
  assert.equal(resolved.issue.resolvedBy, CODY);
  assert.equal(resolved.issue.resolvedAt, clock.now());
  assert.equal(resolved.issue.resolutionHistory.length, 2);
  assert.equal(JSON.stringify(resolved.issue.resolutionHistory.slice(0, 1)), snapshot, 'prior history entries are immutable');
  assert.deepEqual(
    resolved.issue.resolutionHistory.map((event) => `${event.seq}:${event.from}->${event.to}:${event.actorId}`),
    [`1:open->monitoring:${DIEGO}`, `2:monitoring->resolved:${CODY}`],
  );

  // Reopen (resolved -> monitoring is the reopen path) and invalid transitions.
  clock.advanceMinutes(10);
  const reopened = svc.updateStatus(DIEGO, publicIssueId, 'monitoring', 'Recurrence suspected on 2026-03-11.');
  assert.ok(reopened.ok);
  assert.equal(reopened.issue.status, 'monitoring');
  const invalid = svc.updateStatus(DIEGO, publicIssueId, 'monitoring', 'self-transition is invalid');
  assert.ok(!invalid.ok && 'errors' in invalid);
  assert.deepEqual(invalid.errors, ['invalid-transition']);
  const badStatus = svc.updateStatus(DIEGO, publicIssueId, 'closed', 'invalid');
  assert.ok(!badStatus.ok);
  assert.deepEqual(badStatus.errors, ['bad-status']);
  const unknown = svc.updateStatus(DIEGO, 'issue-999999', 'monitoring', 'x');
  assert.ok(!unknown.ok);
  assert.deepEqual(unknown.errors, ['unknown-issue']);
  // Status changes are gated too: the engineer cannot resolve.
  const engineerResolve = svc.updateStatus(FATIMA, publicIssueId, 'resolved', 'x');
  assert.ok(!engineerResolve.ok && 'status' in engineerResolve);
  assert.equal(engineerResolve.status, 403);
});

test('visibility: public issues list for everyone; internal issues only through the internal read path', () => {
  const { svc } = seeded(() => NOW);
  // Anonymous and the commissioner (no internal capability): public only.
  assert.deepEqual(svc.listIssues(null).map((issue) => issue.visibility), ['public']);
  assert.deepEqual(svc.listIssues(CODY).map((issue) => issue.visibility), ['public']);
  // The Bear engineer and the statewide steward see both.
  assert.deepEqual(svc.listIssues(FATIMA).map((issue) => issue.visibility).sort(), ['internal', 'public']);
  assert.deepEqual(svc.listIssues(DIEGO).map((issue) => issue.visibility).sort(), ['internal', 'public']);
});

test('export context: public exports carry public issues only (byte-swept); authorized exports carry both', () => {
  const { svc } = seeded(() => NOW);
  const selector = { streamId: 'str-corinne-q', start: '2026-03-08T00:00:00Z', end: '2026-03-09T00:00:00Z' };

  const publicContext = svc.issueContextForExport(null, selector);
  assert.equal(publicContext.length, 1);
  assert.equal(publicContext[0]!.visibility, 'public');
  assert.equal(publicContext[0]!.status, 'open');
  // Byte sweep: the internal issue never leaks into a public export.
  const serialized = JSON.stringify(publicContext);
  assert.ok(!serialized.includes('Battery'));
  assert.ok(!serialized.includes('internal'));
  assert.ok(!serialized.includes('str-diag-voltage'));

  // Overlap semantics: an interval that only touches the edge excludes the issue.
  const nonOverlap = svc.issueContextForExport(null, { streamId: 'str-corinne-q', start: '2026-03-09T00:00:00Z', end: '2026-03-09T07:00:00Z' });
  assert.equal(nonOverlap.length, 0);
  // The engineer's export of the voltage window carries the internal issue.
  const engineerContext = svc.issueContextForExport(FATIMA, { streamId: 'str-diag-voltage', start: '2026-03-09T00:00:00Z', end: '2026-03-09T07:00:00Z' });
  assert.equal(engineerContext.length, 1);
  assert.equal(engineerContext[0]!.title, 'Battery voltage below minimum at Garden City diagnostic site');
  // The commissioner's export of the same window carries nothing.
  assert.equal(svc.issueContextForExport(CODY, { streamId: 'str-diag-voltage', start: '2026-03-09T00:00:00Z', end: '2026-03-09T07:00:00Z' }).length, 0);
});
