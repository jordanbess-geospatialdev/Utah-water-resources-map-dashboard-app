/**
 * WD-010 bulk-import domain tests (verification matrix rows T-06/T-07):
 * the staged batch over the frozen contract fixtures - the 366-row golden
 * leap-year import with exact accepted/rejected counts and three seeded
 * cell errors, atomic all-or-nothing commit with scope re-verification,
 * idempotent commit replay, retry without duplicates, duplicate reporting
 * within batch and against the store, and the documented partial mode.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/readings/test/bulkImport.test.ts
 *
 * Every clock input is an injected constant; the store reads only the
 * fixture files. The final test replays the whole golden scenario on a
 * second store and compares byte-for-byte (determinism).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withEntitlement } from '../../../../../../packages/policy/src/index.ts';
import { createReadingsStore } from '../store.ts';
import { submitManualReading } from '../manualEntry.ts';
import {
  buildLeapYearDailyPaste,
  commitImport,
  createImport,
  goldenDailyValue,
  validateImport,
  GOLDEN_STREAM_ID,
  GOLDEN_YEAR,
} from '../bulkImport.ts';
import type { ReadingsStore } from '../store.ts';

const FATIMA = 'principal-fatima-engineer'; // engineer, Bear River: enter-readings
const PRIYA = 'principal-priya-engineer'; // engineer, Weber River: out of scope on Bear
const CODY = 'principal-cody-commissioner'; // commissioner, Bear River: enter-readings
const SARAH = 'principal-sarah-researcher'; // researcher: no enter-readings
const NOW = '2026-03-10T14:00:00Z';
const LATER = '2026-03-10T16:00:00Z';

/** The three seeded golden errors: rows chosen mid-year, asserted exactly below. */
const SEEDED_ERRORS = [
  { rowIndex: 197, kind: 'value-not-numeric' as const }, // 2024-07-15
  { rowIndex: 253, kind: 'date-unparseable' as const }, // 2024-09-09 (day 253 of 2024)
  { rowIndex: 307, kind: 'value-missing' as const }, // 2024-11-02
];

function goldenText(): string {
  return buildLeapYearDailyPaste({ seedErrors: SEEDED_ERRORS });
}

function stagedGolden(store: ReadingsStore, actorId = FATIMA, text = goldenText()) {
  const created = createImport(store, actorId, { text, defaultStreamId: GOLDEN_STREAM_ID, mode: 'atomic' }, { now: NOW });
  assert.equal(created.outcome, 'created');
  const batchId = created.batch.id;
  const validated = validateImport(store, actorId, batchId, { now: NOW });
  assert.equal(validated.outcome, 'validated');
  return { batchId, validated };
}

// ---------------------------------------------------------------------------
// The 366-row golden import (spec: "a proposed 366-row minimum scenario")
// ---------------------------------------------------------------------------

test('golden fixture is a full 366-day leap year of daily rows, deterministic', () => {
  const text = goldenText();
  const lines = text.split('\n');
  assert.equal(lines.length, 367, 'header + 366 daily rows (2024 is a leap year)');
  assert.equal(lines[0], 'date,offset,value,unit');
  assert.equal(lines[1], `2024-01-01,-07:00,${goldenDailyValue(1)},cfs`);
  // Day 60 of 2024 is February 29 (leap day); its offset is still MST.
  assert.equal(lines[60]?.startsWith('2024-02-29,-07:00,'), true);
  // Day 73 = 2024-03-13, inside MDT.
  assert.equal(lines[73]?.startsWith('2024-03-13,-06:00,'), true);
  // Day 366 = 2024-12-31.
  assert.equal(lines[366]?.startsWith('2024-12-31,-07:00,'), true);
  // The generator is deterministic: same call, same bytes.
  assert.equal(buildLeapYearDailyPaste({ seedErrors: SEEDED_ERRORS }), text);
});

test('366-row golden import validates whole-batch: 363 accepted, 3 rejected with exact cell errors', () => {
  const store = createReadingsStore();
  const { validated } = stagedGolden(store);
  const validation = validated.batch.validation;
  assert.ok(validation);
  assert.equal(validation.rowCount, 366);
  assert.equal(validation.accepted.length, 363);
  assert.equal(validation.rejected.length, 3);
  assert.equal(validation.duplicates.length, 0, '2024 predates the fixture rows; no store overlap');
  // The three seeded cell errors, exactly: row + column + code + pasted cell.
  const [numeric, date, missing] = SEEDED_ERRORS.map((seeded) =>
    validation.rejected.find((row) => row.rowIndex === seeded.rowIndex),
  );
  assert.deepEqual(
    numeric?.errors.map((error) => ({ code: error.code, columnKey: error.columnKey, cellValue: error.cellValue })),
    [{ code: 'VALUE_NOT_NUMERIC', columnKey: 'value', cellValue: 'abc' }],
  );
  assert.deepEqual(
    date?.errors.map((error) => ({ code: error.code, columnKey: error.columnKey, cellValue: error.cellValue })),
    [{ code: 'DATE_UNPARSEABLE', columnKey: 'date', cellValue: `${GOLDEN_YEAR}-13-45` }],
  );
  assert.deepEqual(
    missing?.errors.map((error) => ({ code: error.code, columnKey: error.columnKey, cellValue: error.cellValue })),
    [{ code: 'VALUE_REQUIRED', columnKey: 'value', cellValue: '' }],
  );
  assert.match(missing?.errors[0]?.message ?? '', /never zero/);
  // The mapping is reported back for the preview UI.
  assert.deepEqual(validation.mapping.headerCells, ['date', 'offset', 'value', 'unit']);
  assert.equal(validation.mapping.columns.date, 0);
  assert.equal(validation.mapping.columns.offset, 1);
  assert.equal(validation.mapping.columns.value, 2);
  assert.equal(validation.mapping.columns.unit, 3);
});

test('atomic mode: one bad row rejects the whole batch - nothing commits, all 3 errors returned', () => {
  const store = createReadingsStore();
  const { batchId } = stagedGolden(store);
  const rowsBefore = store.observations.length;
  const decision = commitImport(store, FATIMA, batchId, { now: NOW });
  assert.equal(decision.outcome, 'refused');
  assert.equal(decision.status, 422);
  assert.equal(decision.rejection?.code, 'ATOMIC_VALIDATION_ERRORS');
  assert.equal(decision.rejection?.errors.length, 3);
  assert.equal(store.observations.length, rowsBefore, 'nothing was committed');
  assert.equal(store.batchById(batchId)?.state, 'rejected');
  // Replaying commit on the rejected batch returns the recorded refusal.
  const replay = commitImport(store, FATIMA, batchId, { now: LATER });
  assert.equal(replay.outcome, 'refused');
  assert.equal(replay.code, 'BATCH_REJECTED');
  assert.equal(replay.rejection?.code, 'ATOMIC_VALIDATION_ERRORS');
});

test('clean golden commit inserts all 366 rows once, with audit + outbox events', () => {
  const store = createReadingsStore();
  const text = buildLeapYearDailyPaste(); // no seeded errors
  const created = createImport(store, FATIMA, { text, defaultStreamId: GOLDEN_STREAM_ID, mode: 'atomic' }, { now: NOW });
  validateImport(store, FATIMA, created.batch.id, { now: NOW });
  const decision = commitImport(store, FATIMA, created.batch.id, { now: NOW });
  assert.equal(decision.outcome, 'committed');
  const result = decision.result;
  assert.ok(result);
  assert.equal(result.inserted.length, 366);
  assert.equal(result.duplicates.length, 0);
  assert.equal(result.skipped.length, 0);
  assert.equal(store.observations.length, 69 + 366);
  assert.equal(store.auditEvents.length, 1);
  assert.equal(store.auditEvents[0]?.action, 'commit-import');
  assert.deepEqual(store.auditEvents[0]?.summary, { inserted: 366, duplicates: 0, skipped: 0 });
  assert.equal(store.outboxEvents.length, 1);
  assert.deepEqual(store.outboxEvents[0]?.streamIds, [GOLDEN_STREAM_ID]);
  // Rows carry import provenance and the stream's method context.
  const first = result.inserted[0];
  assert.equal(first?.origin, 'import-batch');
  assert.equal(first?.importBatchId, created.batch.id);
  assert.equal(first?.methodTypeId, 'method-rating');
  assert.equal(first?.logicalKey, 'str-corinne-q:2024-01-01T07:00:00Z');
});

test('idempotent commit replay: same batch id returns the ORIGINAL result and appends nothing', () => {
  const store = createReadingsStore();
  const text = buildLeapYearDailyPaste();
  const created = createImport(store, FATIMA, { text, defaultStreamId: GOLDEN_STREAM_ID, mode: 'atomic' }, { now: NOW });
  validateImport(store, FATIMA, created.batch.id, { now: NOW });
  const first = commitImport(store, FATIMA, created.batch.id, { now: NOW });
  assert.equal(first.outcome, 'committed');
  assert.equal(first.replayed, false);
  const second = commitImport(store, FATIMA, created.batch.id, { now: LATER });
  assert.equal(second.outcome, 'committed');
  assert.equal(second.replayed, true);
  assert.deepEqual(second.result.inserted.map((row) => row.id), first.result.inserted.map((row) => row.id));
  assert.deepEqual(second.result.committedAt, first.result.committedAt, 'the recorded timestamp, not the replay clock');
  assert.equal(store.observations.length, 69 + 366, 'no duplicate rows from the replay');
  assert.equal(store.auditEvents.length, 1, 'no second audit event on replay');
  assert.equal(store.outboxEvents.length, 1, 'no second outbox event on replay');
});

test('retry without duplicates: the same paste as a NEW batch reports 366 store duplicates and inserts nothing', () => {
  const store = createReadingsStore();
  const text = buildLeapYearDailyPaste();
  const first = createImport(store, FATIMA, { text, defaultStreamId: GOLDEN_STREAM_ID }, { now: NOW });
  validateImport(store, FATIMA, first.batch.id, { now: NOW });
  commitImport(store, FATIMA, first.batch.id, { now: NOW });

  const retry = createImport(store, FATIMA, { text, defaultStreamId: GOLDEN_STREAM_ID }, { now: LATER });
  assert.notEqual(retry.batch.id, first.batch.id);
  const validated = validateImport(store, FATIMA, retry.batch.id, { now: LATER });
  assert.equal(validated.outcome, 'validated');
  const validation = validated.batch.validation;
  assert.ok(validation);
  assert.equal(validation.accepted.length, 0);
  assert.equal(validation.duplicates.length, 366, 'every row is reported as a duplicate against the store');
  assert.ok(validation.duplicates.every((duplicate) => duplicate.against === 'store'));
  assert.ok(validation.duplicates.every((duplicate) => duplicate.existingId !== null), 'each report names the existing row');

  const committed = commitImport(store, FATIMA, retry.batch.id, { now: LATER });
  assert.equal(committed.outcome, 'committed');
  assert.equal(committed.result.inserted.length, 0);
  assert.equal(committed.result.duplicates.length, 366, 'duplicates reported at commit too - never silently skipped');
  assert.equal(store.observations.length, 69 + 366, 'retrying the same paste created no duplicate readings');
});

// ---------------------------------------------------------------------------
// Duplicates within the batch
// ---------------------------------------------------------------------------

test('within-batch duplicates: first occurrence accepted, repeats reported with the first row index', () => {
  const store = createReadingsStore();
  const text = 'date,offset,value,unit\n2026-06-01,-06:00,10.0,cfs\n2026-06-01,-06:00,10.5,cfs\n2026-06-02,-06:00,11.0,cfs';
  const created = createImport(store, FATIMA, { text, defaultStreamId: GOLDEN_STREAM_ID }, { now: NOW });
  const validated = validateImport(store, FATIMA, created.batch.id, { now: NOW });
  const validation = validated.batch.validation;
  assert.ok(validation);
  assert.equal(validation.accepted.length, 2);
  assert.equal(validation.duplicates.length, 1);
  assert.equal(validation.duplicates[0]?.against, 'batch');
  assert.equal(validation.duplicates[0]?.rowIndex, 2);
  assert.equal(validation.duplicates[0]?.firstRowIndex, 1);
  const committed = commitImport(store, FATIMA, created.batch.id, { now: NOW });
  assert.equal(committed.outcome, 'committed');
  assert.equal(committed.result.inserted.length, 2, 'only the first occurrence is inserted');
  assert.equal(committed.result.duplicates.length, 1);
});

// ---------------------------------------------------------------------------
// Scope re-verification between stages
// ---------------------------------------------------------------------------

test('grant revoked between validate and commit rejects the batch with nothing committed', () => {
  const store = createReadingsStore();
  const text = buildLeapYearDailyPaste();
  const created = createImport(store, FATIMA, { text, defaultStreamId: GOLDEN_STREAM_ID }, { now: NOW });
  validateImport(store, FATIMA, created.batch.id, { now: NOW });
  // The authoritative assignment snapshot changes: Fatima's grant is revoked
  // with a bumped grant version (spec: "next protected request denied").
  store.replaceWorldSnapshot(withEntitlement(store.world, 'ent-engineer-fatima', { status: 'revoked', grantVersion: 8 }));
  const decision = commitImport(store, FATIMA, created.batch.id, { now: LATER });
  assert.equal(decision.outcome, 'refused');
  assert.equal(decision.status, 403);
  assert.equal(decision.rejection?.code, 'SCOPE_CHANGED');
  assert.equal(store.observations.length, 69, 'nothing was committed');
  assert.equal(store.batchById(created.batch.id)?.state, 'rejected');
});

test('grant version bump alone (still active) also rejects: the recorded version must match', () => {
  const store = createReadingsStore();
  const text = buildLeapYearDailyPaste();
  const created = createImport(store, FATIMA, { text, defaultStreamId: GOLDEN_STREAM_ID }, { now: NOW });
  validateImport(store, FATIMA, created.batch.id, { now: NOW });
  store.replaceWorldSnapshot(withEntitlement(store.world, 'ent-engineer-fatima', { grantVersion: 9 }));
  const decision = commitImport(store, FATIMA, created.batch.id, { now: LATER });
  assert.equal(decision.outcome, 'refused');
  assert.equal(decision.rejection?.code, 'SCOPE_CHANGED');
  assert.equal(store.observations.length, 69);
});

test('stream setup change between validate and commit rejects the batch for revalidation', () => {
  const store = createReadingsStore();
  const text = buildLeapYearDailyPaste();
  const created = createImport(store, FATIMA, { text, defaultStreamId: GOLDEN_STREAM_ID }, { now: NOW });
  validateImport(store, FATIMA, created.batch.id, { now: NOW });
  // A device replacement lands between validate and commit (FR-033).
  store.applyStreamSetupChange(GOLDEN_STREAM_ID);
  const decision = commitImport(store, FATIMA, created.batch.id, { now: LATER });
  assert.equal(decision.outcome, 'refused');
  assert.equal(decision.status, 409);
  assert.equal(decision.rejection?.code, 'STREAM_SETUP_CHANGED');
  assert.match(decision.rejection?.message ?? '', /measurement setup/);
  assert.equal(store.observations.length, 69);
});

test('a reading landing between validate and commit becomes a reported duplicate, not a lost row', () => {
  const store = createReadingsStore();
  const text = 'date,offset,value,unit\n2026-06-01,-06:00,10.0,cfs\n2026-06-02,-06:00,11.0,cfs';
  const created = createImport(store, FATIMA, { text, defaultStreamId: GOLDEN_STREAM_ID }, { now: NOW });
  validateImport(store, FATIMA, created.batch.id, { now: NOW });
  // Another path (manual entry) commits one of the same instants in between.
  const manual = submitManualReading(
    store,
    CODY,
    { streamId: GOLDEN_STREAM_ID, observedAt: '2026-06-01T00:00:00-06:00', value: 9.5, unitId: 'cfs' },
    { now: LATER },
  );
  assert.equal(manual.outcome, 'applied');
  const decision = commitImport(store, FATIMA, created.batch.id, { now: LATER });
  assert.equal(decision.outcome, 'committed');
  assert.equal(decision.result.inserted.length, 1);
  assert.equal(decision.result.duplicates.length, 1, 'commit-time recheck moved the row to duplicates');
  assert.equal(decision.result.duplicates[0]?.against, 'store');
  assert.equal(decision.result.duplicates[0]?.existingId, manual.record.id);
});

// ---------------------------------------------------------------------------
// Batch state machine
// ---------------------------------------------------------------------------

test('commit before validate is refused with BATCH_NOT_VALIDATED', () => {
  const store = createReadingsStore();
  const created = createImport(store, FATIMA, { text: 'date,value\n2026-06-01,10.0', defaultStreamId: GOLDEN_STREAM_ID }, { now: NOW });
  const decision = commitImport(store, FATIMA, created.batch.id, { now: NOW });
  assert.equal(decision.outcome, 'refused');
  assert.equal(decision.status, 409);
  assert.equal(decision.code, 'BATCH_NOT_VALIDATED');
});

test('revalidation is allowed while the batch is still open', () => {
  const store = createReadingsStore();
  const created = createImport(store, FATIMA, { text: 'date,value\n2026-06-01,10.0', defaultStreamId: GOLDEN_STREAM_ID }, { now: NOW });
  const first = validateImport(store, FATIMA, created.batch.id, { now: NOW });
  assert.equal(first.outcome, 'validated');
  const second = validateImport(store, FATIMA, created.batch.id, { now: LATER });
  assert.equal(second.outcome, 'validated');
  assert.equal(second.batch.validatedAt, LATER);
});

test('another actor cannot validate or commit a batch they do not own', () => {
  const store = createReadingsStore();
  const created = createImport(store, FATIMA, { text: 'date,value\n2026-06-01,10.0', defaultStreamId: GOLDEN_STREAM_ID }, { now: NOW });
  const validated = validateImport(store, CODY, created.batch.id, { now: NOW });
  assert.equal(validated.outcome, 'not-found');
  assert.equal(validated.status, 404);
  const committed = commitImport(store, CODY, created.batch.id, { now: NOW });
  assert.equal(committed.outcome, 'not-found');
  assert.equal(committed.status, 404);
});

test('terminal batches refuse revalidation: create a new batch instead', () => {
  const store = createReadingsStore();
  const { batchId } = stagedGolden(store); // ends 'validated'
  commitImport(store, FATIMA, batchId, { now: NOW }); // -> 'rejected' (atomic errors)
  const again = validateImport(store, FATIMA, batchId, { now: LATER });
  assert.equal(again.outcome, 'refused');
  assert.equal(again.code, 'BATCH_STATE_INVALID');
});

// ---------------------------------------------------------------------------
// Documented partial mode (FR-021 "chooses the documented atomic or
// partial import mode")
// ---------------------------------------------------------------------------

test('partial mode commits the good rows and reports the bad ones precisely', () => {
  const store = createReadingsStore();
  const text = 'date,offset,value,unit\n2026-06-01,-06:00,10.0,cfs\n2026-06-02,-06:00,abc,cfs\n2026-06-03,-06:00,11.0,cfs';
  const created = createImport(store, FATIMA, { text, defaultStreamId: GOLDEN_STREAM_ID, mode: 'partial' }, { now: NOW });
  validateImport(store, FATIMA, created.batch.id, { now: NOW });
  const decision = commitImport(store, FATIMA, created.batch.id, { now: NOW });
  assert.equal(decision.outcome, 'committed');
  assert.equal(decision.result.mode, 'partial');
  assert.equal(decision.result.inserted.length, 2);
  assert.equal(decision.result.skipped.length, 1);
  assert.equal(decision.result.skipped[0]?.rowIndex, 2);
  assert.equal(decision.result.skipped[0]?.errors[0]?.code, 'VALUE_NOT_NUMERIC');
  assert.deepEqual(decision.result.auditEvent.summary, { inserted: 2, duplicates: 0, skipped: 1 });
});

test('mode can be chosen at commit time, overriding the batch default', () => {
  const store = createReadingsStore();
  const { batchId } = stagedGolden(store); // batch default 'atomic', 3 errors
  const decision = commitImport(store, FATIMA, batchId, { now: NOW }, 'partial');
  assert.equal(decision.outcome, 'committed');
  assert.equal(decision.result.mode, 'partial');
  assert.equal(decision.result.inserted.length, 363);
  assert.equal(decision.result.skipped.length, 3);
  assert.equal(store.observations.length, 69 + 363);
});

// ---------------------------------------------------------------------------
// Per-row scope and lifecycle verdicts in validation
// ---------------------------------------------------------------------------

test('out-of-scope actor: rows are rejected with the policy reason; a bound create is a 403', () => {
  const store = createReadingsStore();
  // Bound to a default stream: the early capability check refuses at create.
  const bound = createImport(store, PRIYA, { text: 'date,value\n2026-06-01,10.0', defaultStreamId: GOLDEN_STREAM_ID }, { now: NOW });
  assert.equal(bound.outcome, 'forbidden');
  assert.equal(bound.status, 403);
  assert.equal(bound.policyReason, 'DENY_OUT_OF_SCOPE');
  // Unbound batch with per-row stream columns: the denial is a per-row verdict.
  const text = 'stream,date,offset,value,unit\nstr-corinne-q,2026-06-01,-06:00,10.0,cfs\nstr-corinne-q,2026-06-02,-06:00,11.0,cfs';
  const created = createImport(store, PRIYA, { text }, { now: NOW });
  assert.equal(created.outcome, 'created');
  const validated = validateImport(store, PRIYA, created.batch.id, { now: NOW });
  const validation = validated.batch.validation;
  assert.ok(validation);
  assert.equal(validation.accepted.length, 0);
  assert.equal(validation.rejected.length, 2);
  const codes = validation.rejected.map((row) => row.errors[0]?.code);
  assert.deepEqual(codes, ['ROW_OUT_OF_SCOPE', 'ROW_OUT_OF_SCOPE']);
  assert.match(validation.rejected[0]?.errors[0]?.message ?? '', /DENY_OUT_OF_SCOPE/);
  // Committing a fully out-of-scope validated batch: partial mode would
  // commit zero rows; atomic mode refuses on the row errors.
  const atomic = commitImport(store, PRIYA, created.batch.id, { now: LATER });
  assert.equal(atomic.outcome, 'refused');
  assert.equal(atomic.rejection?.code, 'ATOMIC_VALIDATION_ERRORS');
});

test('restricted stream hidden from an out-of-system actor at create: 404, rows never staged', () => {
  const store = createReadingsStore();
  const decision = createImport(store, PRIYA, { text: 'date,value\n2026-06-01,10.0', defaultStreamId: 'str-hyrum-q-owner' }, { now: NOW });
  assert.equal(decision.outcome, 'forbidden');
  assert.equal(decision.status, 404, 'the restricted stream does not exist for the outsider');
});

test('inactive station: create is refused (lifecycle), per-row verdict names the reason', () => {
  const store = createReadingsStore();
  const bound = createImport(store, FATIMA, { text: 'date,value\n2026-06-01,10.0', defaultStreamId: 'str-summit-q' }, { now: NOW });
  assert.equal(bound.outcome, 'forbidden');
  assert.equal(bound.policyReason, 'DENY_LIFECYCLE_STATE', 'the inactive station measurement lifecycle is closed');
  const text = 'stream,date,offset,value,unit\nstr-summit-q,2026-06-01,-06:00,10.0,cfs';
  const created = createImport(store, FATIMA, { text }, { now: NOW });
  assert.equal(created.outcome, 'created');
  const validated = validateImport(store, FATIMA, created.batch.id, { now: NOW });
  const validation = validated.batch.validation;
  assert.ok(validation);
  assert.equal(validation.accepted.length, 0);
  assert.equal(validation.rejected[0]?.errors[0]?.code, 'ROW_LIFECYCLE_CLOSED');
  assert.match(validation.rejected[0]?.errors[0]?.message ?? '', /DENY_LIFECYCLE_STATE/);
});

test('actor without enter-readings anywhere cannot even create a batch', () => {
  const store = createReadingsStore();
  const decision = createImport(store, SARAH, { text: 'date,value\n2026-06-01,10.0', defaultStreamId: GOLDEN_STREAM_ID }, { now: NOW });
  assert.equal(decision.outcome, 'forbidden');
  assert.equal(decision.status, 403);
  assert.equal(decision.policyReason, 'DENY_CAPABILITY_NOT_GRANTED');
});

test('unknown default stream at create is a 404', () => {
  const store = createReadingsStore();
  const decision = createImport(store, FATIMA, { text: 'date,value\n2026-06-01,10.0', defaultStreamId: 'str-nope' }, { now: NOW });
  assert.equal(decision.outcome, 'forbidden');
  assert.equal(decision.status, 404);
});

// ---------------------------------------------------------------------------
// Parse-level rules exercised through the staged path
// ---------------------------------------------------------------------------

test('unit column with an incompatible dimension rejects those rows, not the batch', () => {
  const store = createReadingsStore();
  const text = 'date,offset,value,unit\n2026-06-01,-06:00,10.0,cfs\n2026-06-02,-06:00,3.2,ft\n2026-06-03,-06:00,12.5,cfs';
  const created = createImport(store, FATIMA, { text, defaultStreamId: GOLDEN_STREAM_ID, mode: 'atomic' }, { now: NOW });
  const validated = validateImport(store, FATIMA, created.batch.id, { now: NOW });
  const validation = validated.batch.validation;
  assert.ok(validation);
  assert.equal(validation.accepted.length, 2);
  assert.equal(validation.rejected.length, 1);
  assert.equal(validation.rejected[0]?.errors[0]?.code, 'UNIT_DIMENSION_MISMATCH');
  assert.equal(validation.rejected[0]?.errors[0]?.columnKey, 'unit');
});

test('tab-delimited paste with station column and unknown header reported', () => {
  const store = createReadingsStore();
  const text = ['station\tdate\toffset\tvalue\tunit\tcrew', 'sta-hyrum-diversion-public\t2026-06-01\t-06:00\t10.0\tcfs\talpha'].join('\n');
  const created = createImport(store, FATIMA, { text, mode: 'atomic' }, { now: NOW });
  const validated = validateImport(store, FATIMA, created.batch.id, { now: NOW });
  const validation = validated.batch.validation;
  assert.ok(validation);
  assert.equal(validation.mapping.delimiter, '\t');
  assert.deepEqual(validation.mapping.unknownColumns, ['crew']);
  assert.equal(validation.accepted.length, 1, 'a single-stream station resolves without a stream column; the unknown column is ignored but reported');
  assert.equal(validation.accepted[0]?.streamId, 'str-hyrum-q-public');
});

test('per-row stream column: one paste, two streams, mixed verdicts', () => {
  const store = createReadingsStore();
  const text = [
    'stream,date,offset,value,unit',
    'str-corinne-q,2026-06-01,-06:00,10.0,cfs',
    'str-corinne-stage,2026-06-01,-06:00,4.1,ft',
    'str-corinne-stage,2026-06-02,-06:00,4.2,',
  ].join('\n');
  const created = createImport(store, FATIMA, { text, mode: 'atomic' }, { now: NOW });
  const validated = validateImport(store, FATIMA, created.batch.id, { now: NOW });
  const validation = validated.batch.validation;
  assert.ok(validation);
  assert.equal(validation.accepted.length, 3);
  assert.equal(validation.accepted[0]?.unitId, 'cfs');
  assert.equal(validation.accepted[1]?.unitId, 'ft');
  assert.equal(validation.accepted[2]?.unitId, 'ft', 'empty unit cell falls back to the stream canonical unit');
  const committed = commitImport(store, FATIMA, created.batch.id, { now: NOW });
  assert.equal(committed.outcome, 'committed');
  assert.equal(committed.result.inserted.length, 3);
  assert.deepEqual(store.auditEvents[0]?.streamIds?.slice().sort(), ['str-corinne-q', 'str-corinne-stage']);
});

test('empty paste and header-only paste produce batch-level errors', () => {
  const store = createReadingsStore();
  const empty = createImport(store, FATIMA, { text: '', defaultStreamId: GOLDEN_STREAM_ID }, { now: NOW });
  const emptyValidated = validateImport(store, FATIMA, empty.batch.id, { now: NOW });
  assert.equal((emptyValidated.batch.validation?.batchErrors ?? []).map((error) => error.code).includes('EMPTY_PASTE'), true);

  const headerOnly = createImport(store, FATIMA, { text: 'date,value', defaultStreamId: GOLDEN_STREAM_ID }, { now: NOW });
  const headerValidated = validateImport(store, FATIMA, headerOnly.batch.id, { now: NOW });
  const codes = (headerValidated.batch.validation?.batchErrors ?? []).map((error) => error.code);
  assert.equal(codes.includes('NO_DATA_ROWS'), true);
});

// ---------------------------------------------------------------------------
// Determinism: the whole golden scenario twice, byte-for-byte
// ---------------------------------------------------------------------------

test('golden scenario is deterministic: two stores produce identical ids and counts', () => {
  function runScenario() {
    const store = createReadingsStore();
    const seeded = createImport(store, FATIMA, { text: goldenText(), defaultStreamId: GOLDEN_STREAM_ID, mode: 'atomic' }, { now: NOW });
    validateImport(store, FATIMA, seeded.batch.id, { now: NOW });
    commitImport(store, FATIMA, seeded.batch.id, { now: NOW });
    const clean = createImport(store, FATIMA, { text: buildLeapYearDailyPaste(), defaultStreamId: GOLDEN_STREAM_ID, mode: 'atomic' }, { now: NOW });
    validateImport(store, FATIMA, clean.batch.id, { now: NOW });
    const committed = commitImport(store, FATIMA, clean.batch.id, { now: NOW });
    return {
      batchIds: store.batches.map((batch) => `${batch.id}:${batch.state}`),
      observationIds: store.observations.map((row) => row.id),
      audit: store.auditEvents.map((event) => `${event.id}:${event.action}:${event.summary?.inserted}`),
      insertedCount: committed.outcome === 'committed' ? committed.result.inserted.length : -1,
    };
  }
  assert.deepEqual(runScenario(), runScenario());
});
