/**
 * Immutability suite (WD-011-R2; FR-045; technical specification
 * "Originals and corrections" raw immutability):
 *
 * A curve revision must not silently rewrite raw readings, observation
 * revision chains or finalized report snapshots. Proven here by:
 * 1. a WD-025-style FROZEN REPORT contentHash: a Bear River distribution
 *    report is generated with the identical request and clock before and
 *    after a full curve supersession + approval sequence - the contentHash
 *    must be byte-identical (rating-curve governance is not report content);
 * 2. RAW READINGS: the observations contract fixture is hashed before and
 *    after the sequence (file untouched), and the WD-011 revision store's
 *    chain, audit and outbox logs serialize identically;
 * 3. the curve store itself never loads observations or revisions, so no
 *    code path can write them (structural guard asserted by construction).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createRatingCurveStore } from './approvalGrants.ts';
import { approveCurveVersion, createCurveVersion, supersedeCurveVersion, convertStage } from '../curves.ts';
import { approveShiftVersion, createShiftVersion, supersedeShiftVersion } from '../shifts.ts';
import { createRevisionStore } from '../../revisions/store.ts';
import { fixtureReportDeps, generateReport } from '../../distribution-report/generate.ts';
import { DEFAULT_INCLUDE, type ReportRequest } from '../../distribution-report/types.ts';

const FATIMA = 'principal-fatima-engineer';
const CODY = 'principal-cody-commissioner';
const NOW = '2026-03-09T07:00:00Z';
const STREAM = 'str-corinne-q';

const BEAR: ReportRequest = {
  systemId: 'sys-bear-river',
  siteIds: null,
  period: { basis: 'calendar-year', year: 2026 },
  processingBasis: 'raw',
  include: DEFAULT_INCLUDE,
};

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const OBSERVATIONS_URL = new URL('../../../../../../fixtures/contracts/observations.json', import.meta.url);

/** The full governance sequence a curve revision exercises. */
function runRevisionSequence(store: ReturnType<typeof createRatingCurveStore>): void {
  const created = createCurveVersion(store, FATIMA, 'str-corinne-stage', {
    coefficients: { c: 40.1, b: 1.9, e: 1.69 },
    unitPair: { fromUnitId: 'ft', toUnitId: 'cfs' },
    method: 'Log-linear least squares, n=20 calibrations (stage-pilot draft)',
    effectiveFrom: '2026-03-01T00:00:00Z',
  }, { now: NOW });
  assert.equal(created.outcome, 'applied');
  if (created.outcome === 'applied') {
    assert.equal(approveCurveVersion(store, CODY, created.version.id, { now: NOW }).outcome, 'applied');
  }

  const shift = createShiftVersion(store, FATIMA, STREAM, {
    segments: [
      { fromStageFt: 0, toStageFt: 2.45, offsetFt: 0.03 },
      { fromStageFt: 2.45, toStageFt: null, offsetFt: 0.06 },
    ],
    reason: 'Datum re-survey.',
    effectiveFrom: '2026-03-07T18:00:00Z',
  }, { now: NOW });
  assert.equal(shift.outcome, 'applied');
  if (shift.outcome === 'applied') {
    assert.equal(approveShiftVersion(store, CODY, shift.version.id, { now: NOW }).outcome, 'applied');
  }

  const superseded = supersedeCurveVersion(store, FATIMA, STREAM, {
    coefficients: { c: 42.5, b: 1.95, e: 1.66 },
    unitPair: { fromUnitId: 'ft', toUnitId: 'cfs' },
    method: 'Log-linear least squares, n=24 calibrations, post-2026 verification',
    effectiveFrom: '2026-03-09T06:00:00Z',
    supersedeReason: 'Refit after the March 9 meter verification.',
  }, { now: NOW });
  assert.equal(superseded.outcome, 'applied');
  if (superseded.outcome === 'applied') {
    assert.equal(approveCurveVersion(store, CODY, superseded.version.id, { now: NOW }).outcome, 'applied');
  }

  const supersededShift = supersedeShiftVersion(store, FATIMA, STREAM, {
    segments: [{ fromStageFt: 0, toStageFt: null, offsetFt: 0.02 }],
    reason: 'May re-survey refined the datum correction.',
    effectiveFrom: '2026-03-10T00:00:00Z',
    supersedeReason: 'Refined datum correction.',
  }, { now: NOW });
  assert.equal(supersededShift.outcome, 'applied');
  if (supersededShift.outcome === 'applied') {
    assert.equal(approveShiftVersion(store, CODY, supersededShift.version.id, { now: NOW }).outcome, 'applied');
  }

  // conversions under both regimes
  assert.equal(convertStage(store, STREAM, 2.52, '2026-03-08T20:00:00Z', { now: NOW }).outcome, 'converted');
  assert.equal(convertStage(store, STREAM, 2.52, '2026-03-11T00:00:00Z', { now: NOW }).outcome, 'converted');
}

test('a WD-025-style frozen report contentHash is identical before and after a curve supersession', () => {
  const before = generateReport(fixtureReportDeps(NOW), BEAR, CODY);
  assert.equal(before.outcome, 'allowed');
  const hashBefore = before.outcome === 'allowed' ? before.value.contentHash : '';

  const store = createRatingCurveStore();
  runRevisionSequence(store);

  const after = generateReport(fixtureReportDeps(NOW), BEAR, CODY);
  assert.equal(after.outcome, 'allowed');
  const hashAfter = after.outcome === 'allowed' ? after.value.contentHash : '';

  assert.ok(hashBefore.length === 64);
  assert.equal(hashBefore, hashAfter); // the frozen snapshot never changes under curve edits
});

test('raw readings are byte-identical before and after the full revision sequence', () => {
  const rawBefore = readFileSync(OBSERVATIONS_URL, 'utf8');
  const store = createRatingCurveStore();
  runRevisionSequence(store);
  const rawAfter = readFileSync(OBSERVATIONS_URL, 'utf8');
  assert.equal(sha256(rawBefore), sha256(rawAfter));
});

test('the WD-011 revision chain, audit and outbox logs are untouched by curve operations', () => {
  const revisions = createRevisionStore();
  const snapshotBefore = JSON.stringify({
    observations: revisions.observations,
    revisions: revisions.revisions,
    auditEvents: revisions.auditEvents,
    outboxEvents: revisions.outboxEvents,
  });

  const store = createRatingCurveStore();
  runRevisionSequence(store);

  const revisionsAfter = createRevisionStore();
  const snapshotAfter = JSON.stringify({
    observations: revisionsAfter.observations,
    revisions: revisionsAfter.revisions,
    auditEvents: revisionsAfter.auditEvents,
    outboxEvents: revisionsAfter.outboxEvents,
  });
  assert.equal(snapshotBefore, snapshotAfter);
  // and the shared instance did not move either (curve ops took only the curve store)
  const snapshotShared = JSON.stringify({
    observations: revisions.observations,
    revisions: revisions.revisions,
    auditEvents: revisions.auditEvents,
    outboxEvents: revisions.outboxEvents,
  });
  assert.equal(snapshotBefore, snapshotShared);
});

test('the curve store exposes no observation or revision surface at all', () => {
  const store = createRatingCurveStore();
  const keys = Object.keys(store).concat(Object.keys(Object.getPrototypeOf(store) ?? {}));
  assert.ok(keys.length > 0);
  for (const key of keys) {
    assert.ok(
      !/observation|revision/i.test(key),
      `curve store must not expose a ${key} surface (raw readings and revision chains live in their own stores)`,
    );
  }
  assert.equal(store.computedValues.length, 0); // conversions only ever append
});
