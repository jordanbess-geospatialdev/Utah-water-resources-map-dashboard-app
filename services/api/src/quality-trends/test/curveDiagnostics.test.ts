/**
 * Curve-boundary diagnostics suite (WD-013-R2; FR-043 + FR-045; T-06/T-15):
 * approved rating/shift version periods from the WD-011-R2 store (read via
 * relative import) related to the recurring diagnostic history - boundary
 * adjacency annotations, supersession timeline entries with lineage ids,
 * read-only use of the store, and drafts never moving a boundary.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/quality-trends/test/curveDiagnostics.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRatingCurveStore, type RatingCurveStore } from '../../workflows/rating-curves/store.ts';
import {
  annotateCurveBoundaries,
  approvedBoundaries,
  curveDiagnosticsReport,
  curveSupersessionsOf,
  diagnosticTimeline,
} from '../curveDiagnostics.ts';
import { deriveIncidents } from '../trends.ts';
import { fixtureTrendInput } from './helpers.ts';

const BOUNDARY_AT = '2026-03-07T18:00:00Z';

function fixtureIncidents() {
  return deriveIncidents(fixtureTrendInput());
}

test('the WD-011-R2 seeded chain yields exactly one APPROVED boundary where the periods touch', () => {
  const store = createRatingCurveStore();
  const boundaries = approvedBoundaries(store);
  assert.equal(boundaries.length, 1);
  const boundary = boundaries[0]!;
  assert.equal(boundary.streamId, 'str-corinne-q');
  assert.equal(boundary.stationId, 'sta-bear-corinne');
  assert.equal(boundary.kind, 'curve');
  // The two half-open fixture periods touch at 2026-03-07T18:00:00Z exactly
  // once: the 2019 curve excludes the instant, the 2026 curve includes it.
  assert.equal(boundary.at, BOUNDARY_AT);
  assert.equal(boundary.supersededVersionId, 'rc-corinne-2019');
  assert.equal(boundary.successorVersionId, 'rc-corinne-2026');
  assert.equal(boundary.supersededApprovalState, 'superseded');
  assert.equal(boundary.successorApprovalState, 'approved');
  assert.deepEqual(boundary.supersededPeriod, { from: '2019-10-01T00:00:00Z', to: BOUNDARY_AT });
  assert.deepEqual(boundary.successorPeriod, { from: BOUNDARY_AT, to: null });
  assert.equal(boundary.label, 'rc-corinne-2019 → rc-corinne-2026');
});

test('supersession records reconcile to the rating-version records', () => {
  const store = createRatingCurveStore();
  const supersessions = curveSupersessionsOf(store);
  assert.deepEqual(supersessions, [
    {
      supersededVersionId: 'rc-corinne-2019',
      successorVersionId: 'rc-corinne-2026',
      streamId: 'str-corinne-q',
      kind: 'curve',
      boundaryAt: BOUNDARY_AT,
    },
  ]);
  // The closed approved versions of the store chain, counted exactly once.
  const closedApproved = store
    .curveVersionsOf('str-corinne-q')
    .filter((version) => version.effectiveTo !== null && version.approvedAt !== null);
  assert.equal(closedApproved.length, supersessions.length);
  assert.deepEqual(closedApproved.map((version) => version.id), supersessions.map((record) => record.supersededVersionId));
});

test('boundary-adjacency annotation: the negative-spike correction cluster carries the curve boundary', () => {
  const store = createRatingCurveStore();
  const boundaries = approvedBoundaries(store);
  const annotated = annotateCurveBoundaries(fixtureIncidents(), boundaries);
  assert.equal(annotated.length, fixtureIncidents().length);

  const correction = annotated.find((incident) => incident.incidentId.includes('obs-q-032'))!;
  assert.equal(correction.kind, 'correction');
  assert.equal(correction.boundaryAnnotations.length, 1);
  const annotation = correction.boundaryAnnotations[0]!;
  // obs-q-032 was observed 8 h AFTER the RTU replacement boundary.
  assert.equal(annotation.relation, 'before');
  assert.equal(annotation.distanceMs, 8 * 60 * 60_000);
  assert.equal(annotation.boundaryAt, BOUNDARY_AT);
  assert.equal(annotation.supersededVersionId, 'rc-corinne-2019');
  assert.equal(annotation.successorVersionId, 'rc-corinne-2026');
  assert.equal(annotation.label, 'curve boundary 2026-03-07T18:00:00Z (rc-corinne-2019 → rc-corinne-2026)');

  // The gap-edge estimate correction (obs-q-042, 24 h after) is NOT adjacent.
  const gapEdge = annotated.find((incident) => incident.incidentId.includes('obs-q-042'))!;
  assert.deepEqual(gapEdge.boundaryAnnotations, []);
  // The freeze-window known issue SPANS the boundary instant: distance 0.
  const freeze = annotated.find((incident) => incident.kind === 'known-issue' && incident.streamId === 'str-corinne-q')!;
  assert.equal(freeze.boundaryAnnotations.length, 1);
  assert.equal(freeze.boundaryAnnotations[0]!.relation, 'during');
  assert.equal(freeze.boundaryAnnotations[0]!.distanceMs, 0);
  // The supersession incident itself sits exactly ON the boundary.
  const supersession = annotated.find((incident) => incident.kind === 'curve-supersession')!;
  assert.equal(supersession.boundaryAnnotations.length, 1);
  assert.equal(supersession.boundaryAnnotations[0]!.relation, 'during');
  // The out-of-range spike cluster (26 h after) is beyond the 12 h default.
  const spike = annotated.find(
    (incident) => incident.kind === 'qc-flag' && incident.causeKey === 'range' && incident.firstSeen === '2026-03-08T20:00:00Z',
  );
  assert.ok(spike);
  assert.deepEqual(spike.boundaryAnnotations, []);
});

test('adjacency is configurable: a 2 h window drops the 8 h-distant correction annotation', () => {
  const boundaries = approvedBoundaries(createRatingCurveStore());
  const annotated = annotateCurveBoundaries(fixtureIncidents(), boundaries, { adjacencyMs: 2 * 60 * 60_000 });
  const correction = annotated.find((incident) => incident.incidentId.includes('obs-q-032'))!;
  assert.deepEqual(correction.boundaryAnnotations, []);
  // ...but the zero-value incident 2 h before the boundary still qualifies.
  const zero = annotated.find((incident) => incident.causeKey === 'zero-value')!;
  assert.equal(zero.boundaryAnnotations.length, 1);
  assert.equal(zero.boundaryAnnotations[0]!.distanceMs, 2 * 60 * 60_000);
});

test('the unified timeline shows the supersession event WITH ITS LINEAGE IDS beside the diagnostics', () => {
  const store = createRatingCurveStore();
  const report = curveDiagnosticsReport(store, fixtureIncidents());
  const supersessions = report.timeline.filter((entry) => entry.entryType === 'curve-supersession');
  assert.equal(supersessions.length, 1);
  const event = supersessions[0]!;
  if (event.entryType !== 'curve-supersession') return;
  assert.equal(event.at, BOUNDARY_AT);
  assert.equal(event.supersededVersionId, 'rc-corinne-2019');
  assert.equal(event.successorVersionId, 'rc-corinne-2026');
  assert.equal(event.lineageLabel, 'rc-corinne-2019 → rc-corinne-2026');
  assert.equal(event.incidentId, report.annotatedIncidents.find((incident) => incident.kind === 'curve-supersession')!.incidentId);
  // One boundary spine entry plus every incident: 18 + 1 + 1 = 20 entries.
  assert.equal(report.timeline.length, 20);
  assert.equal(report.timeline.filter((entry) => entry.entryType === 'curve-boundary').length, 1);
  assert.equal(report.timeline.filter((entry) => entry.entryType === 'incident').length, 18);
  // Chronological order with the boundary at its instant.
  const atValues = report.timeline.map((entry) => Date.parse(entry.at));
  assert.deepEqual([...atValues].sort((a, b) => a - b), atValues);
});

test('draft successors never move the boundary (FR-045 approval evidence governs)', () => {
  const store = createRatingCurveStore();
  const before = approvedBoundaries(store);
  // Append a DRAFT successor that closes the open 2026 curve.
  store.appendCurveVersion({
    streamId: 'str-corinne-q',
    stationId: 'sta-bear-corinne',
    actorId: 'principal-fatima-engineer',
    now: '2026-03-09T07:00:00Z',
    closeCurrentAt: '2026-03-09T00:00:00Z',
    version: {
      stationId: 'sta-bear-corinne',
      streamId: 'str-corinne-q',
      coefficients: { c: 42, b: 1.9, e: 1.7 },
      unitPair: { fromUnitId: 'ft', toUnitId: 'cfs' },
      method: 'Draft refit (unapproved experiment)',
      effectiveFrom: '2026-03-09T00:00:00Z',
      effectiveTo: null,
      author: 'principal-fatima-engineer',
      approvalState: 'draft',
      approvedBy: null,
      approvedAt: null,
      provenance: { source: 'draft-experiment', calibrationCount: null, note: 'draft; not approved' },
    },
    action: 'supersede-curve',
  });
  const after = approvedBoundaries(store);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.at, before[0]!.at);
  assert.equal(after[0]!.supersededVersionId, 'rc-corinne-2019');
  // The supersession records still reconcile to the APPROVED history only.
  assert.deepEqual(curveSupersessionsOf(store).map((record) => record.supersededVersionId), ['rc-corinne-2019']);
});

test('diagnostics use the store read-only: no audit, outbox or chain mutation', () => {
  const store: RatingCurveStore = createRatingCurveStore();
  const chainsBefore = JSON.stringify([
    store.curveVersionsOf('str-corinne-q'),
    store.shiftVersionsOf('str-corinne-q'),
  ]);
  const report = curveDiagnosticsReport(store, fixtureIncidents());
  assert.equal(store.auditEvents.length, 0);
  assert.equal(store.outboxEvents.length, 0);
  assert.equal(
    JSON.stringify([store.curveVersionsOf('str-corinne-q'), store.shiftVersionsOf('str-corinne-q')]),
    chainsBefore,
  );
  assert.ok(report.annotatedIncidents.length > 0);
});
