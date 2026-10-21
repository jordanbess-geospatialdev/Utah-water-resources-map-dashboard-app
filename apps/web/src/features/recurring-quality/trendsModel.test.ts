/**
 * View-model suite for the recurring-quality feature (WD-013-R2, FR-043):
 * row building reconciles to the reviewed demo snapshot (the two-corrections
 * chain is one incident), boundary annotations surface in rows, sorting and
 * filtering are deterministic, the chart series mirrors the table, and the
 * label helpers format accessibly.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/recurring-quality/trendsModel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { TrendRow } from './trendsModel';

// Extensionless src imports under node --test (see tests/ts-resolve-hook.mjs;
// runtime values load through the hook so type-only imports stay for tsc).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const trendsModelPath = './trendsModel.ts';
const trendsModel: typeof import('./trendsModel') = await import(trendsModelPath);
const {
  buildTrendRows,
  chartSeries,
  DEMO_NOW,
  filterTrendRows,
  formatRate,
  formatTimeSince,
  KIND_MARKERS,
  REVIEWED_DEMO_INCIDENTS,
  sortTrendRows,
} = trendsModel;

function demoRows(): readonly TrendRow[] {
  return buildTrendRows(REVIEWED_DEMO_INCIDENTS, { now: DEMO_NOW });
}

const BOUNDARY_LABEL = 'curve boundary 2026-03-07T18:00:00Z (rc-corinne-2019 → rc-corinne-2026)';

test('rows reconcile to the reviewed snapshot: 18 incidents / 27 records across 6 rows', () => {
  const rows = demoRows();
  assert.equal(rows.length, 6);
  assert.equal(rows.reduce((sum, row) => sum + row.incidentCount, 0), 18);
  assert.equal(rows.reduce((sum, row) => sum + row.hitCount, 0), 27);
  const row = (stationId: string, kind: string) => {
    const found = rows.find((candidate) => candidate.stationId === stationId && candidate.kind === kind);
    assert.ok(found, `expected row ${stationId}/${kind}`);
    return found;
  };
  // The correction row: 3 incidents (obs-q-019, the TWO-CORRECTIONS chain on
  // obs-q-032, obs-q-042) backed by 4 revision records - never one row per
  // revision (FR-043).
  const corrections = row('sta-bear-corinne', 'correction');
  assert.equal(corrections.incidentCount, 3);
  assert.equal(corrections.hitCount, 4);
  assert.ok(corrections.causeLabels.includes('obs-q-032 chain'));
  // QC flags: 10 incidents / 15 records on the Corinne site (telemetry + stage).
  const qc = row('sta-bear-corinne', 'qc-flag');
  assert.equal(qc.incidentCount, 10);
  assert.equal(qc.hitCount, 15);
  // Internal diagnostic site (rendered only for admitted viewers upstream).
  const voltage = row('sta-bear-lake-diagnostic', 'qc-flag');
  assert.equal(voltage.incidentCount, 2);
  assert.equal(voltage.hitCount, 5);
  assert.equal(row('sta-bear-corinne', 'curve-supersession').hitCount, 1);
  assert.equal(row('sta-bear-corinne', 'known-issue').hitCount, 1);
  assert.equal(row('sta-bear-lake-diagnostic', 'known-issue').hitCount, 1);
});

test('curve-boundary annotations surface in the affected rows with lineage text', () => {
  const rows = demoRows();
  const corrections = rows.find((row) => row.rowId === 'sta-bear-corinne|correction|0')!;
  assert.deepEqual(corrections.boundaryAnnotationLabels, [BOUNDARY_LABEL]);
  const qc = rows.find((row) => row.rowId === 'sta-bear-corinne|qc-flag|0')!;
  assert.deepEqual(qc.boundaryAnnotationLabels, [BOUNDARY_LABEL]);
  // Rows away from the boundary carry none.
  const voltage = rows.find((row) => row.rowId === 'sta-bear-lake-diagnostic|qc-flag|0')!;
  assert.deepEqual(voltage.boundaryAnnotationLabels, []);
});

test('recurrence and freshness labels are text (never color-only markers)', () => {
  const rows = demoRows();
  const qc = rows.find((row) => row.rowId === 'sta-bear-corinne|qc-flag|0')!;
  // 9 recurrences over 48 h -> 31.5/wk -> '32/wk'; last seen 1 h before NOW.
  assert.equal(qc.recurrenceRateLabel, '32/wk');
  assert.equal(qc.timeSinceLabel, '1 h');
  const corrections = rows.find((row) => row.rowId === 'sta-bear-corinne|correction|0')!;
  assert.equal(corrections.recurrenceRateLabel, '11/wk');
  assert.equal(corrections.timeSinceLabel, '13 h');
  const supersession = rows.find((row) => row.rowId === 'sta-bear-corinne|curve-supersession|0')!;
  assert.equal(supersession.recurrenceRateLabel, '—');
  assert.equal(supersession.timeSinceLabel, '1 d 13 h');
  // Every kind carries a shape marker AND a text label.
  for (const row of rows) {
    assert.ok(KIND_MARKERS[row.kind].length > 0);
    assert.ok(row.kindLabel.length > 0);
  }
});

test('sorting: every column ascends/descends deterministically with stable ties', () => {
  const rows = demoRows();
  const byCountAsc = sortTrendRows(rows, { by: 'count', direction: 'asc' });
  const counts = byCountAsc.map((row) => row.incidentCount);
  assert.deepEqual(counts, [...counts].sort((a, b) => a - b));
  const byCountDesc = sortTrendRows(rows, { by: 'count', direction: 'desc' });
  assert.deepEqual(byCountDesc[0]!.rowId, 'sta-bear-corinne|qc-flag|0');
  // Kind sorting follows the declared kind order, not the alphabet.
  const byKind = sortTrendRows(rows, { by: 'kind', direction: 'asc' });
  assert.deepEqual(
    byKind.map((row) => row.kind).slice(0, 2),
    ['qc-flag', 'qc-flag'],
  );
  // Site sort: asc lists Corinne before the diagnostic site; desc flips the
  // site order while same-site ties stay stable (rowId ascending).
  assert.deepEqual(
    sortTrendRows(rows, { by: 'site', direction: 'asc' }).map((row) => row.rowId),
    [
      'sta-bear-corinne|correction|0',
      'sta-bear-corinne|curve-supersession|0',
      'sta-bear-corinne|known-issue|0',
      'sta-bear-corinne|qc-flag|0',
      'sta-bear-lake-diagnostic|known-issue|0',
      'sta-bear-lake-diagnostic|qc-flag|0',
    ],
  );
  assert.deepEqual(
    sortTrendRows(rows, { by: 'site', direction: 'desc' }).map((row) => row.rowId),
    [
      'sta-bear-lake-diagnostic|known-issue|0',
      'sta-bear-lake-diagnostic|qc-flag|0',
      'sta-bear-corinne|correction|0',
      'sta-bear-corinne|curve-supersession|0',
      'sta-bear-corinne|known-issue|0',
      'sta-bear-corinne|qc-flag|0',
    ],
  );
  // Sorting is pure: the input array is never reordered in place.
  assert.deepEqual(
    rows.map((row) => row.rowId),
    demoRows().map((row) => row.rowId),
  );
});

test('filtering: by kind, by period, and combined', () => {
  const rows = demoRows();
  assert.equal(filterTrendRows(rows, { kind: 'correction' }).length, 1);
  assert.equal(filterTrendRows(rows, { kind: 'all' }).length, 6);
  assert.equal(filterTrendRows(rows, { periodIndex: 0 }).length, 6);
  assert.deepEqual(filterTrendRows(rows, { periodIndex: 2 }), []);
  assert.deepEqual(filterTrendRows(rows, { kind: 'qc-flag', periodIndex: 0 }).map((row) => row.rowId), [
    'sta-bear-corinne|qc-flag|0',
    'sta-bear-lake-diagnostic|qc-flag|0',
  ]);
});

test('chart series mirrors the table: same totals, marker + label on every point', () => {
  const rows = demoRows();
  const series = chartSeries(rows);
  assert.equal(series.reduce((sum, point) => sum + point.count, 0), rows.reduce((sum, row) => sum + row.incidentCount, 0));
  assert.equal(series.reduce((sum, point) => sum + point.hitCount, 0), 27);
  for (const point of series) {
    assert.ok(point.kindMarker.length > 0);
    assert.ok(point.kindLabel.length > 0);
    assert.ok(point.periodLabel.includes('→'));
  }
  // Deterministic order: period, then declared kind order (stable within a kind).
  assert.deepEqual(
    series.map((point) => `${point.periodIndex}:${point.kind}`),
    [
      '0:qc-flag',
      '0:qc-flag',
      '0:correction',
      '0:known-issue',
      '0:known-issue',
      '0:curve-supersession',
    ],
  );
});

test('out-of-window incidents never produce rows; future records are skipped', () => {
  const [first] = REVIEWED_DEMO_INCIDENTS;
  const rows = buildTrendRows(
    [
      { ...first!, inWindow: false },
      { ...first!, incidentId: `${first!.incidentId}#future`, lastSeen: '2026-03-20T00:00:00Z' },
    ],
    { now: DEMO_NOW },
  );
  assert.deepEqual(rows, []);
});

test('label helpers: durations and rates format readably', () => {
  assert.equal(formatTimeSince(45 * 60_000), '45 m');
  assert.equal(formatTimeSince(9 * 60 * 60_000), '9 h');
  assert.equal(formatTimeSince((24 + 13) * 60 * 60_000), '1 d 13 h');
  assert.equal(formatTimeSince(3 * 24 * 60 * 60_000), '3 d');
  assert.equal(formatRate(0), '—');
  assert.equal(formatRate(4), '4.0/wk');
  assert.equal(formatRate(31.5), '32/wk');
});

test('determinism: building rows twice yields identical output', () => {
  assert.deepEqual(demoRows(), demoRows());
  assert.equal(JSON.stringify(demoRows()), JSON.stringify(demoRows()));
});
