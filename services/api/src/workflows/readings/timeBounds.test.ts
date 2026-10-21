/**
 * Time-bound edge cases for staged import parsing (WD-010, FR-021):
 * DST-transition local days (23-hour spring forward, 25-hour fall back),
 * duplicate timestamps, out-of-order rows, and missing values rendered as
 * errors - never as zeros.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/readings/timeBounds.test.ts
 *
 * All inputs are literal constants; the parser is pure, so the suite is
 * deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate } from '../../../../../packages/policy/src/index.ts';
import { createReadingsStore } from './store.ts';
import { parseStagedBatch } from './bulkImport.ts';
import type { ParseDeps } from './bulkImport.ts';

const NOW = '2026-03-10T14:00:00Z';

function depsFor(store: ReturnType<typeof createReadingsStore>, actorId: string): ParseDeps {
  return {
    streamById: (streamId) => store.streamById(streamId),
    stationById: (stationId) => store.stationById(stationId),
    unitDimension: (unitId) => store.unitDimension(unitId),
    propertyDimension: (propertyId) => store.propertyDimension(propertyId),
    policyForRow: (streamId) => {
      const principal = store.world.principals[actorId] ?? null;
      const verdict = evaluate(
        { principal, action: 'enter-readings', object: { kind: 'datastream', id: streamId } },
        store.world,
        NOW,
      );
      return verdict.effect === 'allow' ? { allowed: true } : { allowed: false, reason: verdict.reason };
    },
    existingByKey: (logicalKey) => store.observationByLogicalKey(logicalKey),
  };
}

/**
 * Parse-only deps (no store-duplicate port): DST tests target 2026-03-08 and
 * 2026-11-01, where the fixture itself holds rows; those tests assert parse
 * semantics, not store overlap, so the store port is intentionally absent.
 */
function parseOnlyDeps(store: ReturnType<typeof createReadingsStore>, actorId: string): ParseDeps {
  const deps = depsFor(store, actorId);
  return { ...deps, existingByKey: undefined };
}

/**
 * Parse with engine-backed policy but WITHOUT the store-duplicate port by
 * default (DST tests target calendar days where the fixture itself holds
 * rows; they assert parse semantics, not store overlap). Pass true to
 * include the store lookup (used by the duplicate and ordering tests).
 */
function parse(store: ReturnType<typeof createReadingsStore>, text: string, withStoreLookup = false) {
  const deps = withStoreLookup
    ? depsFor(store, 'principal-fatima-engineer')
    : parseOnlyDeps(store, 'principal-fatima-engineer');
  return parseStagedBatch(deps, text, { defaultStreamId: 'str-corinne-q' });
}

// ---------------------------------------------------------------------------
// DST spring forward: 2026-03-08 is a 23-hour local day in America/Denver
// ---------------------------------------------------------------------------

test('spring-forward local day is 23 hours: wall hour 02 does not exist', () => {
  const store = createReadingsStore();
  // All 24 wall hours pasted WITHOUT an offset column: 02:xx must be a cell
  // error, the other 23 must resolve.
  const rows: string[] = [];
  for (let hour = 0; hour <= 23; hour += 1) rows.push(`2026-03-08,${String(hour).padStart(2, '0')}:00,${10 + hour}.0`);
  const result = parse(store, `date,time,value\n${rows.join('\n')}`);
  assert.equal(result.rowCount, 24);
  assert.equal(result.accepted.length, 23, 'one wall hour is skipped by the transition');
  assert.equal(result.rejected.length, 1);
  const error = result.rejected[0]?.errors[0];
  assert.equal(error?.code, 'LOCAL_TIME_NONEXISTENT');
  assert.equal(error?.columnKey, 'time');
  assert.equal(error?.rowIndex, 3, 'the 02:00 row is data row 3');
  assert.match(error?.message ?? '', /02:00-02:59 is skipped/);
  // The local day spans 23 real hours: 00:00 MST (07:00Z) to 24:00 MDT (06:00Z next day).
  const first = result.accepted[0]?.time.observedAt;
  const last = result.accepted.at(-1)?.time.observedAt;
  assert.equal(first, '2026-03-08T07:00:00Z');
  assert.equal(last, '2026-03-09T05:00:00Z', 'the 23:00 MDT wall row is the last real instant of the local day');
  assert.equal((Date.parse('2026-03-09T06:00:00Z') - Date.parse(first ?? '')) / 3_600_000, 23, 'the local day end is 23 real hours after its start');
  // Wall hour 02 is absent from every resolved instant's local rendering.
  for (const row of result.accepted) {
    const utc = new Date(row.time.observedAt);
    const offsetMinutes = row.time.sourceOffset === 'Z' ? 0 : signMinutes(row.time.sourceOffset);
    const localTotal = ((utc.getUTCHours() * 60 + utc.getUTCMinutes() + offsetMinutes) % 1440 + 1440) % 1440;
    const localHour = Math.floor(localTotal / 60);
    assert.notEqual(localHour, 2, `no accepted row resolves inside the skipped wall hour (got ${row.logicalKey})`);
  }
});

function signMinutes(offset: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!match) throw new Error(`bad offset ${offset}`);
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

test('spring-forward with explicit offsets: 23 rows, offsets flip -07:00 to -06:00', () => {
  const store = createReadingsStore();
  const rows: string[] = [];
  for (let hour = 0; hour <= 23; hour += 1) {
    if (hour === 2) continue; // this wall hour does not exist
    const offset = hour < 2 ? '-07:00' : '-06:00';
    rows.push(`2026-03-08,${String(hour).padStart(2, '0')}:00,${offset},${10 + hour}.0`);
  }
  const result = parse(store, `date,time,offset,value\n${rows.join('\n')}`);
  assert.equal(result.rowCount, 23);
  assert.equal(result.accepted.length, 23);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted[0]?.time.sourceOffset, '-07:00');
  assert.equal(result.accepted[1]?.time.sourceOffset, '-07:00');
  assert.equal(result.accepted[2]?.time.sourceOffset, '-06:00', '03:00 local is daylight time');
  // The fixture's transition anchor: 2026-03-08T09:00:00Z is 03:00 MDT.
  assert.equal(result.accepted[2]?.time.observedAt, '2026-03-08T09:00:00Z');
  const keys = new Set(result.accepted.map((row) => row.logicalKey));
  assert.equal(keys.size, 23, 'all instants distinct');
});

// ---------------------------------------------------------------------------
// DST fall back: 2026-11-01 is a 25-hour local day in America/Denver
// ---------------------------------------------------------------------------

test('fall-back local day is 25 hours with explicit offsets: 01:xx occurs twice', () => {
  const store = createReadingsStore();
  // The real wall-clock sequence: 00 MDT, 01 MDT, [clocks back] 01 MST, 02..23 MST.
  const rows: string[] = ['2026-11-01,00:00,-06:00,10.0', '2026-11-01,01:00,-06:00,11.0', '2026-11-01,01:00,-07:00,11.5'];
  for (let hour = 2; hour <= 23; hour += 1) rows.push(`2026-11-01,${String(hour).padStart(2, '0')}:00,-07:00,${10 + hour}.0`);
  const result = parse(store, `date,time,offset,value\n${rows.join('\n')}`);
  assert.equal(result.rowCount, 25, '25 wall hours in the local day');
  assert.equal(result.accepted.length, 25);
  assert.equal(result.rejected.length, 0);
  const first = result.accepted[0]?.time.observedAt;
  const last = result.accepted.at(-1)?.time.observedAt;
  assert.equal(first, '2026-11-01T06:00:00Z');
  assert.equal(last, '2026-11-02T06:00:00Z');
  assert.equal((Date.parse(last ?? '') - Date.parse(first ?? '')) / 3_600_000, 24, '24 real hours carry 25 wall hours');
  // The two 01:00 rows are DISTINCT instants, not duplicates.
  const oneClock = result.accepted.filter((row) => row.logicalKey.endsWith('T07:00:00Z') || row.logicalKey.endsWith('T08:00:00Z'));
  assert.equal(oneClock.length, 2);
  assert.equal(result.duplicates.length, 0);
});

test('fall-back without an offset is ambiguous and rejected with the disambiguation hint', () => {
  const store = createReadingsStore();
  const result = parse(store, 'date,time,value\n2026-11-01,01:30,13.0');
  assert.equal(result.accepted.length, 0);
  const error = result.rejected[0]?.errors[0];
  assert.equal(error?.code, 'LOCAL_TIME_AMBIGUOUS');
  assert.match(error?.message ?? '', /occurs twice/);
  assert.match(error?.message ?? '', /MDT -06:00 or MST -07:00/);
});

test('both readings of an ambiguous fall-back instant resolve with explicit offsets', () => {
  const store = createReadingsStore();
  const result = parse(store, 'date,time,offset,value\n2026-11-01,01:30,-06:00,13.0\n2026-11-01,01:30,-07:00,14.0');
  assert.deepEqual(
    result.accepted.map((row) => row.time.observedAt),
    ['2026-11-01T07:30:00Z', '2026-11-01T08:30:00Z'],
  );
  assert.equal(result.accepted[0]?.time.sourceOffset, '-06:00');
  assert.equal(result.accepted[1]?.time.sourceOffset, '-07:00');
});

// ---------------------------------------------------------------------------
// Duplicate timestamps
// ---------------------------------------------------------------------------

test('duplicate timestamps within the batch are reported, not silently skipped', () => {
  const store = createReadingsStore();
  const result = parse(store, 'date,time,offset,value\n2026-03-05,08:00,-07:00,10.0\n2026-03-05,08:00,-07:00,10.5\n2026-03-05,08:00,-06:00,11.0', true);
  assert.equal(result.accepted.length, 2, 'distinct instants accepted');
  assert.equal(result.duplicates.length, 1);
  const duplicate = result.duplicates[0];
  assert.equal(duplicate?.against, 'batch');
  assert.equal(duplicate?.rowIndex, 2);
  assert.equal(duplicate?.firstRowIndex, 1);
  assert.equal(duplicate?.logicalKey, 'str-corinne-q:2026-03-05T15:00:00Z');
});

test('duplicate timestamps against existing store rows are reported with the existing row id', () => {
  const store = createReadingsStore();
  // Fixture row: str-corinne-q:2026-03-06T18:00:00Z (obs-q-001).
  const result = parse(store, 'date,time,offset,value\n2026-03-06,11:00,-07:00,10.0', true);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0]?.against, 'store');
  assert.equal(result.duplicates[0]?.existingId, 'obs-q-001');
});

test('an offset difference makes two same-wall-time rows distinct instants, not duplicates', () => {
  const store = createReadingsStore();
  // 08:00 MST and 09:00 MDT are DIFFERENT wall clocks but the SAME instant
  // (15:00Z); 08:00 MDT is a third, distinct instant (14:00Z).
  const result = parse(store, 'date,time,offset,value\n2026-03-05,08:00,-07:00,10.0\n2026-03-05,09:00,-06:00,10.5\n2026-03-05,08:00,-06:00,11.0', true);
  assert.equal(result.accepted.length, 2);
  assert.deepEqual(
    result.accepted.map((row) => row.logicalKey),
    ['str-corinne-q:2026-03-05T15:00:00Z', 'str-corinne-q:2026-03-05T14:00:00Z'],
  );
  assert.equal(result.duplicates.length, 1, 'row 2 (09:00 MDT) repeats row 1 instant 15:00Z despite the different wall clock');
  assert.equal(result.duplicates[0]?.against, 'batch');
  assert.equal(result.duplicates[0]?.rowIndex, 2);
});

// ---------------------------------------------------------------------------
// Out-of-order rows
// ---------------------------------------------------------------------------

test('out-of-order rows are valid: paste order is not an error and rows keep their instants', () => {
  const store = createReadingsStore();
  const result = parse(
    store,
    'date,time,offset,value\n2026-06-07,08:00,-06:00,10.0\n2026-06-05,08:00,-06:00,9.0\n2026-06-06,08:00,-06:00,9.5',
    true,
  );
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted.length, 3);
  assert.deepEqual(
    result.accepted.map((row) => row.time.observedAt),
    ['2026-06-07T14:00:00Z', '2026-06-05T14:00:00Z', '2026-06-06T14:00:00Z'],
    'row order is preserved as pasted, not sorted and not rejected',
  );
});

// ---------------------------------------------------------------------------
// Missing values are errors, never zeros
// ---------------------------------------------------------------------------

test('missing values are cell errors, never silently zero-filled', () => {
  const store = createReadingsStore();
  const result = parse(store, 'date,time,offset,value,note\n2026-03-05,08:00,-07:00,,gap\n2026-03-05,09:00,-07:00,   ,gap\n2026-03-05,10:00,-07:00,NaN,bad');
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 3);
  const codes = result.rejected.map((row) => row.errors[0]?.code);
  assert.deepEqual(codes, ['VALUE_REQUIRED', 'VALUE_REQUIRED', 'VALUE_NOT_NUMERIC']);
  for (const row of result.rejected) {
    assert.match(row.errors[0]?.message ?? '', /never zero|not a number/);
  }
});

test('a measured zero is a value: 0 is accepted and distinct from missing', () => {
  const store = createReadingsStore();
  const result = parse(store, 'date,time,offset,value\n2026-03-05,08:00,-07:00,0');
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0]?.value, 0);
  assert.notEqual(result.accepted[0]?.value, null);
});
