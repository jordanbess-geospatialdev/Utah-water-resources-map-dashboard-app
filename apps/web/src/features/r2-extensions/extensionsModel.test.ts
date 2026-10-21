/**
 * Pure view-model tests for the WD-023-R2 extensions feature: the demo
 * as-of assembly (boundary ON T, one millisecond before, gaps for
 * not-yet-received observations, aggregate basis, determinism), the demo
 * authorization mirror (restricted stream hidden cross-scope), basis labels
 * and row formatting (text + shape, never color alone), the voice draft
 * badge lifecycle, the review-wall blockers and the provider-pending label.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/r2-extensions/extensionsModel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { AsOfSeriesView, VoiceDraftState } from './extensionsModel';

// Extensionless src imports under node --test (see tests/ts-resolve-hook.mjs;
// import pattern per apps/web/tests/adapters.test.ts).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const modelPath = './extensionsModel.ts';
const model: typeof import('./extensionsModel') = await import(modelPath);
const {
  DEMO_CORINNE_OBSERVATIONS,
  DEMO_CORINNE_REVISIONS,
  DEMO_HYRUM_OBSERVATIONS,
  DEMO_PERSONAS,
  DEMO_STREAMS,
  asOfBasisLabel,
  asOfRows,
  assembleTView,
  demoAsOfAuthorize,
  demoAsOfLoad,
  excludedLaterNote,
  formatInstantUtc,
  providerPendingLabel,
  voiceReviewBlockers,
  voiceStateBadge,
} = model;

const WINDOW = { streamId: 'str-corinne-q', from: '2026-03-08T00:00:00Z', to: '2026-03-09T00:00:00Z' };

function seriesAt(asOf: string): AsOfSeriesView {
  const decision = assembleTView(DEMO_CORINNE_OBSERVATIONS, DEMO_CORINNE_REVISIONS, { ...WINDOW, asOf });
  assert.equal(decision.outcome, 'ok');
  if (decision.outcome !== 'ok') throw new Error('unreachable');
  return decision;
}

test('boundary ON T: the revision recorded exactly at T is in the demo T-view', () => {
  const series = seriesAt('2026-03-08T15:30:00Z');
  const revised = series.points.find((p) => p.state === 'known' && p.observedAt === '2026-03-08T02:00:00Z');
  assert.ok(revised && revised.state === 'known');
  assert.equal(revised.revisionId, 'rev-corinne-2001');
  assert.equal(revised.value, 20.9);
  assert.equal(revised.processingLevel, 'provisional');
  assert.deepEqual(revised.qualifierIds, ['ice-affected']);
  assert.equal(revised.basis.excludedLaterCount, 1, 'rev-corinne-2004 (recorded 2026-03-09T06:20) is later than T');
});

test('boundary one millisecond before T: the raw original shows and the count includes both later revisions', () => {
  const series = seriesAt('2026-03-08T15:29:59.999Z');
  const raw = series.points.find((p) => p.state === 'known' && p.observedAt === '2026-03-08T02:00:00Z');
  assert.ok(raw && raw.state === 'known');
  assert.equal(raw.revisionId, null);
  assert.equal(raw.value, -1.2, 'the raw negative spike is what was known then');
  assert.equal(raw.basis.excludedLaterCount, 2);
});

test('gaps: observations received after T are gaps, the rest assemble; counts agree', () => {
  const series = seriesAt('2026-03-08T15:30:00Z');
  assert.equal(series.knownCount, 12);
  assert.equal(series.gapCount, 6);
  const gap = series.points.find((p) => p.state === 'gap');
  assert.ok(gap);
  if (gap.state === 'gap') {
    assert.equal(gap.reason, 'observation-not-yet-received');
    assert.equal(gap.observedAt, '2026-03-08T18:00:00Z');
  }
  assert.equal(series.basis.latestConsideredRevisionId, 'rev-corinne-2001');
  assert.equal(series.basis.excludedLaterCount, 1);
});

test('determinism: identical inputs assemble deep-equal twice', () => {
  assert.deepEqual(
    assembleTView(DEMO_CORINNE_OBSERVATIONS, DEMO_CORINNE_REVISIONS, { ...WINDOW, asOf: '2026-03-09T00:00:00Z' }),
    assembleTView(DEMO_CORINNE_OBSERVATIONS, DEMO_CORINNE_REVISIONS, { ...WINDOW, asOf: '2026-03-09T00:00:00Z' }),
  );
});

test('validation mirror: unparseable instants and inverted ranges are 422, never a throw', () => {
  const bad = assembleTView(DEMO_CORINNE_OBSERVATIONS, DEMO_CORINNE_REVISIONS, { ...WINDOW, asOf: 'nope' });
  assert.equal(bad.outcome, 'denied');
  if (bad.outcome === 'denied') assert.equal(bad.status, 422);
  const inverted = assembleTView(DEMO_CORINNE_OBSERVATIONS, DEMO_CORINNE_REVISIONS, { ...WINDOW, from: '2026-03-09T00:00:00Z', to: '2026-03-08T00:00:00Z', asOf: '2026-03-09T00:00:00Z' });
  assert.equal(inverted.outcome, 'denied');
  if (inverted.outcome === 'denied') assert.equal(inverted.code, 'VALIDATION_FAILED');
});

test('demo authorization mirror: restricted stream hidden cross-scope, open in scope, public always open', () => {
  const restricted = DEMO_STREAMS.find((s) => s.id === 'str-hyrum-q-owner')!;
  const fatima = DEMO_PERSONAS.find((p) => p.id === 'principal-fatima-engineer')!;
  const priya = DEMO_PERSONAS.find((p) => p.id === 'principal-priya-engineer')!;
  assert.equal(demoAsOfAuthorize(restricted, priya)?.status, 404, 'cross-scope stays HIDDEN (404, never a revealing 403)');
  assert.equal(demoAsOfAuthorize(restricted, fatima), null);
  const publicStream = DEMO_STREAMS.find((s) => s.id === 'str-corinne-q')!;
  assert.equal(demoAsOfAuthorize(publicStream, priya), null);

  const denied = demoAsOfLoad('str-hyrum-q-owner', 'principal-priya-engineer', '2026-03-08T00:00:00Z');
  assert.equal(denied.outcome, 'denied');
  const allowed = demoAsOfLoad('str-hyrum-q-owner', 'principal-fatima-engineer', '2026-03-08T00:00:00Z');
  assert.equal(allowed.outcome, 'ok');
  if (allowed.outcome === 'ok') {
    assert.equal(allowed.knownCount, 1, 'the 2026-03-08T17:00 reading was received after T');
    assert.equal(allowed.gapCount, 1);
    assert.equal(allowed.basis.latestConsideredRevisionId, null, 'no revisions exist on this stream');
  }
});

test('basis label and notes: same format the server exports embed', () => {
  assert.equal(
    asOfBasisLabel({ asOf: '2026-03-08T15:30:00.000Z', latestConsideredRevisionId: 'rev-corinne-2001', excludedLaterCount: 1 }),
    'as-of:2026-03-08T15:30:00.000Z | basis:rev-corinne-2001',
  );
  assert.equal(
    asOfBasisLabel({ asOf: '2026-03-08T15:30:00.000Z', latestConsideredRevisionId: null, excludedLaterCount: 0 }),
    'as-of:2026-03-08T15:30:00.000Z | basis:raw-original',
  );
  assert.equal(excludedLaterNote({ asOf: '2026-03-08T15:30:00.000Z', latestConsideredRevisionId: 'x', excludedLaterCount: 1 }), '1 later revision excluded');
  assert.equal(excludedLaterNote({ asOf: '2026-03-08T15:30:00.000Z', latestConsideredRevisionId: 'x', excludedLaterCount: 2 }), '2 later revisions excluded');
  assert.equal(formatInstantUtc('2026-03-08T15:30:00.000Z'), '2026-03-08 15:30:00 UTC');
});

test('rows: gaps and known points render text + shape markers, never color alone', () => {
  const rows = asOfRows(seriesAt('2026-03-08T15:30:00Z'));
  const gapRow = rows.find((row) => row.isGap);
  assert.ok(gapRow);
  assert.equal(gapRow.marker, '○');
  assert.equal(gapRow.stateText, 'gap');
  assert.equal(gapRow.valueText, '—');
  const revisedRow = rows.find((row) => row.revisionText === 'rev-corinne-2001');
  assert.ok(revisedRow);
  assert.equal(revisedRow.valueText, '20.9 cfs');
  assert.equal(revisedRow.qualifierText, 'ice-affected');
  const rawRow = rows.find((row) => row.revisionText === 'raw original');
  assert.ok(rawRow);
  assert.equal(rawRow.marker, '●');
});

test('voice badge: text + shape for every lifecycle state', () => {
  assert.deepEqual(voiceStateBadge('requested'), { marker: '○', text: 'requested' });
  assert.deepEqual(voiceStateBadge('reviewed'), { marker: '◐', text: 'reviewed' });
  assert.deepEqual(voiceStateBadge('saved'), { marker: '●', text: 'saved' });
  const states: readonly VoiceDraftState[] = ['requested', 'reviewed', 'saved'];
  for (const state of states) {
    const badge = voiceStateBadge(state);
    assert.ok(badge.marker.length === 1 && badge.text.length > 0);
  }
});

test('review wall: blockers clear only with an attached draft, a confirmed review and a recorded reviewer', () => {
  assert.deepEqual(voiceReviewBlockers({ draftAttached: false, reviewedConfirmed: false, reviewerRecorded: false }), [
    'No transcript draft attached yet',
    'You must review the transcript before saving',
    'The reviewing actor must be recorded',
  ]);
  assert.deepEqual(voiceReviewBlockers({ draftAttached: true, reviewedConfirmed: true, reviewerRecorded: false }), [
    'The reviewing actor must be recorded',
  ]);
  assert.deepEqual(voiceReviewBlockers({ draftAttached: true, reviewedConfirmed: true, reviewerRecorded: true }), []);
});

test('provider-pending label: the stub draft is clearly labeled until a provider is approved', () => {
  assert.equal(providerPendingLabel({ providerPending: true, providerLabel: 'deterministic stub' }), 'provider pending · deterministic stub');
  assert.equal(providerPendingLabel({ providerPending: false, providerLabel: 'approved-provider-x' }), 'approved-provider-x');
});
