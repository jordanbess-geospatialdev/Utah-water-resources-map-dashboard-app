/**
 * WD-010 manual-entry domain tests (verification matrix row T-06, FR-020):
 * the full validation matrix (time with explicit offset, value, unit,
 * method), field-level errors that preserve the input, duplicates returning
 * the existing record, idempotency (replay + conflict), and the grant
 * denial matrix through the REAL policy engine.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/readings/test/manualEntry.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReadingsStore } from '../store.ts';
import { submitManualReading, validateManualEntry } from '../manualEntry.ts';
import type { ManualEntryInput } from '../types.ts';

const FATIMA = 'principal-fatima-engineer'; // engineer, Bear River
const PRIYA = 'principal-priya-engineer'; // engineer, Weber River (cross-system)
const CODY = 'principal-cody-commissioner'; // commissioner, Bear River
const ANA = 'principal-ana-deputy'; // deputy, Bear River, delegation 2026-03-01..2026-06-30
const SARAH = 'principal-sarah-researcher'; // researcher: no enter-readings
const DIEGO = 'principal-diego-steward'; // steward: statewide-administration satisfies enter-readings
const NOW = '2026-03-10T14:00:00Z';

function entry(overrides: Partial<ManualEntryInput> = {}): ManualEntryInput {
  return {
    streamId: 'str-corinne-q',
    observedAt: '2026-03-05T08:00:00-07:00',
    value: 21.5,
    unitId: 'cfs',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path: the record id is returned and provenance is complete
// ---------------------------------------------------------------------------

test('a valid reading is applied: record id, correct UTC instant, kept offset, audit + outbox', () => {
  const store = createReadingsStore();
  const decision = submitManualReading(store, FATIMA, entry(), { now: NOW });
  assert.equal(decision.outcome, 'applied');
  assert.equal(decision.code, 'OK');
  assert.equal(decision.replayed, false);
  assert.equal(decision.duplicate, false);
  assert.ok(decision.record.id, 'a saved record identifier is returned (FR-020)');
  assert.equal(decision.record.logicalKey, 'str-corinne-q:2026-03-05T15:00:00Z');
  assert.equal(decision.record.observedAt, '2026-03-05T15:00:00Z');
  assert.equal(decision.record.sourceOffset, '-07:00', 'the explicit offset is kept on the record');
  assert.equal(decision.record.origin, 'manual-entry');
  assert.equal(decision.record.methodTypeId, 'method-rating', 'the stream method context is recorded');
  assert.equal(decision.record.receivedAt, NOW);
  assert.ok(decision.auditEvent);
  assert.equal(decision.auditEvent?.action, 'enter-manual-reading');
  assert.ok(decision.outboxEvent);
  assert.equal(store.observations.length, 70);
});

test('a Z-offset time and a +HH:MM offset time are both accepted; the instant is what matters', () => {
  const store = createReadingsStore();
  const zulu = submitManualReading(store, FATIMA, entry({ observedAt: '2026-03-05T15:00:00Z' }), { now: NOW });
  const plus = submitManualReading(store, FATIMA, entry({ observedAt: '2026-03-06T04:30:00+11:30' }), { now: NOW });
  assert.equal(zulu.outcome, 'applied');
  assert.equal(plus.outcome, 'applied');
  assert.equal(plus.record?.observedAt, '2026-03-05T17:00:00Z');
  assert.equal(plus.record?.sourceOffset, '+11:30');
});

// ---------------------------------------------------------------------------
// Duplicates return the existing record; no duplicate rows
// ---------------------------------------------------------------------------

test('a duplicate by logical key returns the EXISTING record and appends nothing', () => {
  const store = createReadingsStore();
  const first = submitManualReading(store, FATIMA, entry(), { now: NOW });
  assert.equal(first.outcome, 'applied');
  const again = submitManualReading(store, CODY, entry({ value: 99.9, note: 'other actor, same instant' }), { now: NOW });
  assert.equal(again.outcome, 'applied');
  assert.equal(again.code, 'DUPLICATE_LOGICAL_KEY');
  assert.equal(again.duplicate, true);
  assert.equal(again.record.id, first.record.id, 'the existing row is returned, not a copy');
  assert.equal(again.record.value, 21.5, 'the stored value is the first one');
  assert.equal(again.auditEvent, null, 'no mutation, therefore no audit event');
  assert.equal(store.observations.length, 70, 'no duplicate row was appended');
});

test('the same instant written with a different explicit offset is still the same logical key', () => {
  const store = createReadingsStore();
  submitManualReading(store, FATIMA, entry({ observedAt: '2026-03-05T08:00:00-07:00' }), { now: NOW });
  const again = submitManualReading(store, FATIMA, entry({ observedAt: '2026-03-05T15:00:00Z', value: 30 }), { now: NOW });
  assert.equal(again.code, 'DUPLICATE_LOGICAL_KEY');
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('idempotency: same key + same body replays the recorded result with no new audit', () => {
  const store = createReadingsStore();
  const first = submitManualReading(store, FATIMA, entry(), { now: NOW, idempotencyKey: 'key-1' });
  assert.equal(first.outcome, 'applied');
  const replay = submitManualReading(store, FATIMA, entry(), { now: '2026-03-11T09:00:00Z', idempotencyKey: 'key-1' });
  assert.equal(replay.outcome, 'applied');
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.id, first.record.id);
  assert.equal(replay.record.receivedAt, NOW, 'the recorded receive time, not the replay clock');
  assert.equal(store.observations.length, 70);
  assert.equal(store.auditEvents.length, 1);
});

test('idempotency: same key + different body is a 409 IDEMPOTENCY_CONFLICT', () => {
  const store = createReadingsStore();
  submitManualReading(store, FATIMA, entry(), { now: NOW, idempotencyKey: 'key-2' });
  const conflict = submitManualReading(store, FATIMA, entry({ value: 25 }), { now: NOW, idempotencyKey: 'key-2' });
  assert.equal(conflict.outcome, 'idempotency-conflict');
  assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.idempotencyKey, 'key-2');
  assert.equal(store.observations.length, 70);
});

// ---------------------------------------------------------------------------
// Validation matrix: every offending field is identified, input preserved
// ---------------------------------------------------------------------------

test('validation matrix: time field errors', () => {
  const store = createReadingsStore();
  const cases: ReadonlyArray<[Partial<ManualEntryInput>, string]> = [
    [{ observedAt: '' }, 'TIME_REQUIRED'],
    [{ observedAt: '2026-03-05T08:00:00' }, 'OFFSET_REQUIRED'],
    [{ observedAt: '2026-03-05 08:00' }, 'OFFSET_REQUIRED',],
    [{ observedAt: 'not a time' }, 'TIME_UNPARSEABLE'],
    [{ observedAt: '03/05/2026' }, 'TIME_UNPARSEABLE'],
  ];
  for (const [overrides, code] of cases) {
    const decision = submitManualReading(store, FATIMA, entry(overrides), { now: NOW });
    assert.equal(decision.outcome, 'rejected', `${JSON.stringify(overrides)}`);
    assert.equal(decision.status, 422);
    assert.equal(decision.code, 'VALIDATION_FAILED');
    assert.equal(decision.fieldErrors[0]?.fieldPath, 'observedAt', `${code} points at the offending field`);
    assert.equal(decision.fieldErrors[0]?.code, code);
  }
});

test('validation matrix: value field errors (missing is never zero, range enforced)', () => {
  const store = createReadingsStore();
  const cases: ReadonlyArray<[unknown, string]> = [
    [undefined, 'VALUE_REQUIRED'],
    [Number.NaN, 'VALUE_REQUIRED'],
    [Number.POSITIVE_INFINITY, 'VALUE_REQUIRED'],
    ['21.5' as unknown as number, 'VALUE_REQUIRED'],
    [-0.5, 'VALUE_OUT_OF_RANGE'],
    [9500, 'VALUE_OUT_OF_RANGE'],
  ];
  for (const [value, code] of cases) {
    const decision = submitManualReading(store, FATIMA, entry({ value: value as number }), { now: NOW });
    assert.equal(decision.outcome, 'rejected');
    assert.equal(decision.fieldErrors[0]?.fieldPath, 'value');
    assert.equal(decision.fieldErrors[0]?.code, code);
  }
  // 0 is a measured zero and passes (the fixture's suspect zero is a raw fact, not a validation rule).
  const zero = submitManualReading(store, FATIMA, entry({ value: 0 }), { now: NOW });
  assert.equal(zero.outcome, 'applied');
  assert.equal(zero.record.value, 0);
  // The range bounds come from the stream definition.
  const upper = submitManualReading(store, FATIMA, entry({ value: 1200, observedAt: '2026-03-05T09:00:00-07:00' }), { now: NOW });
  assert.equal(upper.outcome, 'applied', 'the inclusive maximum is valid');
});

test('validation matrix: unit errors (governed vocabulary + dimension compatibility)', () => {
  const store = createReadingsStore();
  const unknown = submitManualReading(store, FATIMA, entry({ unitId: 'furlongs' }), { now: NOW });
  assert.equal(unknown.fieldErrors[0]?.fieldPath, 'unitId');
  assert.equal(unknown.fieldErrors[0]?.code, 'UNIT_UNKNOWN');
  assert.match(unknown.fieldErrors[0]?.message ?? '', /furlongs/);
  // cfs (flow) onto a stage stream (canonical ft) is rejected - cross-dimension conversion.
  const crossDimension = submitManualReading(store, FATIMA, { streamId: 'str-corinne-stage', observedAt: '2026-03-05T08:00:00-07:00', value: 4.2, unitId: 'cfs' }, { now: NOW });
  assert.equal(crossDimension.fieldErrors[0]?.fieldPath, 'unitId');
  assert.equal(crossDimension.fieldErrors[0]?.code, 'UNIT_DIMENSION_MISMATCH');
  // The stream's canonical unit is always compatible even where the vocabulary
  // dimensions differ textually (stage property "level" measured in ft "length").
  const canonical = submitManualReading(store, FATIMA, { streamId: 'str-corinne-stage', observedAt: '2026-03-05T08:00:00-07:00', value: 4.2, unitId: 'ft' }, { now: NOW });
  assert.equal(canonical.outcome, 'applied');
  // Equipment volts never enter a water stream.
  const volts = submitManualReading(store, FATIMA, entry({ unitId: 'V' }), { now: NOW });
  assert.equal(volts.fieldErrors[0]?.code, 'UNIT_DIMENSION_MISMATCH');
  assert.match(volts.fieldErrors[0]?.message ?? '', /discharge/);
});

test('validation matrix: method consistency with the stream datastream definition', () => {
  const store = createReadingsStore();
  const mismatch = submitManualReading(store, FATIMA, entry({ methodTypeId: 'method-current-meter' }), { now: NOW });
  assert.equal(mismatch.outcome, 'rejected');
  assert.equal(mismatch.fieldErrors[0]?.fieldPath, 'methodTypeId');
  assert.equal(mismatch.fieldErrors[0]?.code, 'METHOD_MISMATCH');
  const matching = submitManualReading(store, FATIMA, entry({ methodTypeId: 'method-rating' }), { now: NOW });
  assert.equal(matching.outcome, 'applied');
  const omitted = submitManualReading(store, FATIMA, entry({ methodTypeId: null }), { now: NOW, idempotencyKey: 'method-omit' });
  assert.equal(omitted.outcome, 'applied', 'omitting the method defaults to the stream definition');
});

test('multiple invalid fields are all reported at once, and the input is preserved verbatim', () => {
  const store = createReadingsStore();
  const bad = entry({ observedAt: '2026-03-05T08:00:00', value: Number.NaN, unitId: 'hectares', methodTypeId: 'method-weir-board' });
  const decision = submitManualReading(store, FATIMA, bad, { now: NOW });
  assert.equal(decision.outcome, 'rejected');
  const paths = decision.fieldErrors.map((error) => error.fieldPath);
  assert.deepEqual(paths, ['observedAt', 'value', 'unitId', 'methodTypeId'], 'every offending field is identified');
  // The caller's input comes back untouched so the form can re-render valid fields.
  assert.deepEqual(decision.input, bad);
});

test('unknown stream is a field-level 404', () => {
  const store = createReadingsStore();
  const decision = submitManualReading(store, FATIMA, entry({ streamId: 'str-nope' }), { now: NOW });
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.status, 404);
  assert.equal(decision.fieldErrors[0]?.fieldPath, 'streamId');
  assert.equal(decision.fieldErrors[0]?.code, 'STREAM_UNKNOWN');
});

// ---------------------------------------------------------------------------
// Grant denials (real policy engine)
// ---------------------------------------------------------------------------

test('grant denials: anonymous (unresolvable) principal is a 401', () => {
  const store = createReadingsStore();
  const anonymous = submitManualReading(store, 'principal-anonymous', entry(), { now: NOW });
  assert.equal(anonymous.outcome, 'rejected');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.policyReason, 'DENY_ANONYMOUS');
});

test('grant denials: cross-system engineer on a PUBLIC stream is a plain 403 (it exists, they lack scope)', () => {
  const store = createReadingsStore();
  const decision = submitManualReading(store, PRIYA, entry(), { now: NOW });
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.status, 403);
  assert.equal(decision.policyReason, 'DENY_OUT_OF_SCOPE');
});

test('grant denials: cross-system engineer on a RESTRICTED stream is a hidden 404', () => {
  const store = createReadingsStore();
  const decision = submitManualReading(store, PRIYA, { streamId: 'str-hyrum-q-owner', observedAt: '2026-03-05T08:00:00-07:00', value: 5, unitId: 'cfs' }, { now: NOW });
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.status, 404);
  assert.equal(decision.policyReason, 'DENY_OUT_OF_SCOPE');
});

test('grant denials: capability not granted (researcher) is a 403 with the engine reason', () => {
  const store = createReadingsStore();
  const decision = submitManualReading(store, SARAH, entry(), { now: NOW });
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.status, 403);
  assert.equal(decision.policyReason, 'DENY_CAPABILITY_NOT_GRANTED');
});

test('grant denials: the deputy window is honored on both ends (half-open)', () => {
  const store = createReadingsStore();
  const before = submitManualReading(store, ANA, entry({ observedAt: '2026-02-28T08:00:00-07:00' }), { now: '2026-02-28T16:00:00Z' });
  assert.equal(before.outcome, 'rejected');
  assert.equal(before.status, 403);
  assert.equal(before.policyReason, 'DENY_DELEGATION_NOT_EFFECTIVE');
  const inside = submitManualReading(store, ANA, entry({ observedAt: '2026-04-01T08:00:00-06:00' }), { now: '2026-04-01T14:00:00Z' });
  assert.equal(inside.outcome, 'applied');
  const after = submitManualReading(store, ANA, entry({ observedAt: '2026-07-01T08:00:00-06:00' }), { now: '2026-07-01T14:00:00Z' });
  assert.equal(after.outcome, 'rejected');
  assert.equal(after.policyReason, 'DENY_DELEGATION_EXPIRED');
});

test('grant denials: an inactive station closes the measurement lifecycle (403, engine reason)', () => {
  const store = createReadingsStore();
  const decision = submitManualReading(store, FATIMA, { streamId: 'str-summit-q', observedAt: '2026-03-05T08:00:00-07:00', value: 7, unitId: 'cfs' }, { now: NOW });
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.status, 403);
  assert.equal(decision.policyReason, 'DENY_LIFECYCLE_STATE');
});

test('grant allowances: statewide-administration satisfies enter-readings; internal diagnostics streams are enterable in-scope', () => {
  const store = createReadingsStore();
  const diego = submitManualReading(store, DIEGO, entry({ observedAt: '2026-03-05T09:00:00-07:00' }), { now: NOW });
  assert.equal(diego.outcome, 'applied', 'the steward statewide grant satisfies enter-readings');
  const diagnostics = submitManualReading(store, FATIMA, { streamId: 'str-diag-voltage', observedAt: '2026-03-05T08:00:00-07:00', value: 12.9, unitId: 'V' }, { now: NOW });
  assert.equal(diagnostics.outcome, 'applied', 'the assigned engineer enters internal diagnostic readings');
});

test('validateManualEntry is exported pure: field verdicts without a submit', () => {
  const store = createReadingsStore();
  const clean = validateManualEntry(store, entry());
  assert.deepEqual(clean, []);
  const dirty = validateManualEntry(store, entry({ value: 9999 }));
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0]?.fieldPath, 'value');
});
