/**
 * Full-pipeline determinism (WD-025-R2; T-06/T-15): the whole path -
 * flexible period -> decision snapshot -> finalization -> supersession ->
 * supplemental context - is run TWICE against fresh, identical fixture
 * stores and the same injected clock; every serialized artifact must be
 * byte-identical across the runs, and every hash must be a stable sha256
 * hex digest. (The suite itself is additionally executed twice by the task
 * gate; this test pins the in-process guarantee.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { seriesStore } from '../../../series/load.ts';
import { createRevisionStore } from '../../revisions/store.ts';
import { createRatingCurveStore } from '../../rating-curves/store.ts';
import { reportWorld } from '../../distribution-report/world.ts';
import { decisionBytes, recordDecision } from '../decisions.ts';
import { FinalizedLedger, finalizedContentFromDecision } from '../finalize.ts';
import { buildSupplementalContext } from '../supplemental.ts';
import { FIXTURE_SUPPLEMENTAL_INPUTS } from '../supplemental.ts';
import { resolvePeriod } from '../periods.ts';
import type { PeriodSpec } from '../types.ts';

const NOW = '2026-03-09T07:00:00Z';
const CODY = 'principal-cody-commissioner';
const DIEGO = 'principal-diego-steward';
const WORLD = reportWorld().policyWorld;

const PERIODS: readonly PeriodSpec[] = [
  { kind: 'calendar-year', year: 2026 },
  { kind: 'water-year', year: 2026 },
  { kind: 'irrigation-season', year: 2026 },
  { kind: 'custom', start: '2026-03-07T19:00:00.000Z', end: '2026-03-08T18:00:00.000Z', label: 'mid-season custom window' },
  { kind: 'custom', start: '2026-03-15T06:00:00.000Z', end: '2027-03-15T06:00:00.000Z', label: 'owner-configured water year starting March 15' },
];

interface PipelineOutput {
  readonly resolved: readonly string[];
  readonly decisions: readonly string[];
  readonly decisionIds: readonly string[];
  readonly records: readonly string[];
  readonly recordIds: readonly string[];
  readonly contentHashes: readonly string[];
  readonly events: string;
  readonly supplemental: string;
}

function runPipeline(): PipelineOutput {
  const resolved: string[] = [];
  const decisions: string[] = [];
  const decisionIds: string[] = [];
  const records: string[] = [];
  const recordIds: string[] = [];
  const contentHashes: string[] = [];
  let firstEvents = '';
  let firstSupplemental = '';

  for (const period of PERIODS) {
    const window = resolvePeriod(period);
    assert.equal(window.outcome, 'allowed');
    if (window.outcome === 'allowed') resolved.push(JSON.stringify(window.value));

    const deps = { store: seriesStore(), revisions: createRevisionStore(), curves: createRatingCurveStore(), now: NOW };
    const decision = recordDecision(
      deps,
      { systemId: 'sys-bear-river', period, processingBasis: 'best-available', siteIds: null, statement: 'determinism pipeline decision' },
      CODY,
    );
    assert.equal(decision.outcome, 'allowed');
    if (decision.outcome !== 'allowed') continue;
    decisions.push(decisionBytes(decision.value));
    decisionIds.push(decision.value.decisionId);
    assert.match(decision.value.evidenceHash, /^[0-9a-f]{64}$/);

    // Finalize, then supersede with corrected content.
    const ledger = new FinalizedLedger();
    const first = ledger.finalize(WORLD, {
      systemId: 'sys-bear-river',
      period,
      decisionId: decision.value.decisionId,
      content: finalizedContentFromDecision(decision.value),
      actorId: CODY,
      expectedCurrentId: null,
      now: NOW,
    });
    assert.equal(first.outcome, 'finalized');
    if (first.outcome !== 'finalized') continue;
    // The corrected content always differs (scaled volumes AND an extra
    // note), even for seasons whose decision has no categories at all.
    const originalContent = finalizedContentFromDecision(decision.value);
    const correctedContent = {
      ...originalContent,
      categories: decision.value.basisTotals.map(scaleCategory),
      notes: [...originalContent.notes, 'corrected accounting after a year-end measurement revision'],
    };
    const superseded = ledger.finalizeSuperseding(WORLD, {
      systemId: 'sys-bear-river',
      period,
      decisionId: decision.value.decisionId,
      content: correctedContent,
      actorId: DIEGO,
      expectedCurrentId: first.record.id,
      now: '2026-04-01T00:00:00Z',
      reason: 'determinism pipeline supersession',
    });
    assert.equal(superseded.outcome, 'finalized');
    if (superseded.outcome !== 'finalized') continue;
    records.push(ledger.storedBytes(first.record.id) ?? '', ledger.storedBytes(superseded.record.id) ?? '');
    recordIds.push(first.record.id, superseded.record.id);
    contentHashes.push(first.record.contentHash, superseded.record.contentHash);
    assert.match(first.record.contentHash, /^[0-9a-f]{64}$/);
    assert.match(superseded.record.contentHash, /^[0-9a-f]{64}$/);
    if (period === PERIODS[0]) {
      firstEvents = JSON.stringify(ledger.events);
      firstSupplemental = JSON.stringify(
        buildSupplementalContext({ measured: decision.value.basisTotals, supplementalInputs: FIXTURE_SUPPLEMENTAL_INPUTS, comparedBy: CODY, now: NOW }),
      );
    }
  }
  assert.equal(decisionIds.length, PERIODS.length);
  return { resolved, decisions, decisionIds, records, recordIds, contentHashes, events: firstEvents, supplemental: firstSupplemental };
}

function scaleCategory<T extends { readonly volumeAcreFeet: number }>(total: T): T {
  return { ...total, volumeAcreFeet: total.volumeAcreFeet * 1.01 };
}

test('the full pipeline is byte-identical across two independent runs (same clock, same fixtures)', () => {
  const first = runPipeline();
  const second = runPipeline();
  assert.deepEqual(first.decisions, second.decisions);
  assert.deepEqual(first.decisionIds, second.decisionIds);
  assert.deepEqual(first.resolved, second.resolved);
  assert.deepEqual(first.records, second.records);
  assert.deepEqual(first.recordIds, second.recordIds);
  assert.deepEqual(first.contentHashes, second.contentHashes);
  assert.equal(first.events, second.events);
  assert.equal(first.supplemental, second.supplemental);
});

test('distinct periods occupy distinct slots and produce distinct hashes', () => {
  const run = runPipeline();
  assert.equal(new Set(run.decisionIds).size, run.decisionIds.length);
  assert.equal(new Set(run.contentHashes).size, run.contentHashes.length);
  // Supersession changed the content: successor hashes differ from their priors.
  for (let i = 0; i < run.contentHashes.length; i += 2) {
    assert.notEqual(run.contentHashes[i], run.contentHashes[i + 1]);
  }
});
