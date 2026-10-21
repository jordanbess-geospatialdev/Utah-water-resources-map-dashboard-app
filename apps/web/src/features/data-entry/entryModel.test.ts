/**
 * Data-entry model tests (WD-010, FR-020/FR-021): the paste-preview mirror
 * parity against the REAL server parser, and the manual/bulk form state
 * machines.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/data-entry/entryModel.test.ts
 *
 * The parity tests load the server modules at RUNTIME (outside the web tsc
 * program, the established dynamic-import pattern from features/operations)
 * and assert that parsePastePreview produces byte-identical verdicts to the
 * server's parseStagedBatch on the same pastes - including the generated
 * 366-row golden batch. A divergence here is a defect in the mirror.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import type { ManualFormValues, ParsedPreview } from './entryModel';

register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

/**
 * Structural types for the SERVER modules loaded at runtime. The static
 * type query form (`typeof import(...)`) would drag the API sources into
 * the web tsc program (no allowImportingTsExtensions), so these mirrors of
 * the server signatures are intentionally loose: the parity assertions do
 * the real checking.
 */
interface ServerParsed {
  readonly mapping: { readonly delimiter: string; readonly unknownColumns: readonly string[] };
  readonly rowCount: number;
  readonly accepted: ReadonlyArray<{ readonly logicalKey: string }>;
  readonly rejected: ReadonlyArray<{ readonly rowIndex: number; readonly errors: ReadonlyArray<unknown> }>;
  readonly duplicates: readonly unknown[];
}

interface ServerDeps {
  readonly streamById: (id: string) => unknown;
  readonly stationById: (id: string) => unknown;
  readonly unitDimension: (id: string) => string | null;
  readonly propertyDimension: (id: string) => string | null;
  readonly existingByKey: (key: string) => { id: string } | null;
}

const entryPath = './entryModel.ts';
const model: typeof import('./entryModel') = await import(entryPath);

const bulkImportPath = '../../../../../services/api/src/workflows/readings/bulkImport.ts';
const serverBulk = (await import(bulkImportPath)) as {
  parseStagedBatch: (deps: ServerDeps, text: string, options: { defaultStreamId?: string | null }) => ServerParsed;
  buildLeapYearDailyPaste: (options?: {
    seedErrors?: ReadonlyArray<{ rowIndex: number; kind: 'value-not-numeric' | 'date-unparseable' | 'value-missing' }>;
  }) => string;
};
const storePath = '../../../../../services/api/src/workflows/readings/store.ts';
const serverStoreModule = (await import(storePath)) as {
  createReadingsStore: () => {
    streamById: (id: string) => unknown;
    stationById: (id: string) => unknown;
    unitDimension: (id: string) => string | null;
    propertyDimension: (id: string) => string | null;
    observations: ReadonlyArray<{ logicalKey: string; id: string }>;
  };
};

const GOLDEN_STREAM = 'str-corinne-q';
const SEEDED = [
  { rowIndex: 197, kind: 'value-not-numeric' as const },
  { rowIndex: 253, kind: 'date-unparseable' as const },
  { rowIndex: 307, kind: 'value-missing' as const },
];

/** Server-side deps WITHOUT authorization and with fixture-only duplicate knowledge - exactly the web preview's view. */
function serverPreviewDeps() {
  const store = serverStoreModule.createReadingsStore();
  const fixtureKeys = new Map<string, string>();
  for (const observation of store.observations) fixtureKeys.set(observation.logicalKey, observation.id);
  return {
    streamById: (id: string) => store.streamById(id),
    stationById: (id: string) => store.stationById(id),
    unitDimension: (id: string) => store.unitDimension(id),
    propertyDimension: (id: string) => store.propertyDimension(id),
    existingByKey: (key: string) => fixtureKeys.get(key) !== undefined ? { id: fixtureKeys.get(key) as string } : null,
  };
}

/** Canonical JSON projection so undefined-absent vs undefined-present compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, member) => {
    if (member === undefined) return undefined;
    if (member && typeof member === 'object' && !Array.isArray(member)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(member as Record<string, unknown>).sort()) {
        const entry = (member as Record<string, unknown>)[key];
        if (entry !== undefined) sorted[key] = entry;
      }
      return sorted;
    }
    return member;
  });
}

function assertMirror(text: string, defaultStreamId: string | null): void {
  const server = serverBulk.parseStagedBatch(serverPreviewDeps(), text, { defaultStreamId });
  const web = model.parsePastePreview(text, { defaultStreamId });
  assert.equal(canonical(web), canonical(server), `mirror divergence for paste:\n${text.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Mirror parity (the load-bearing tests: preview == server validate stage)
// ---------------------------------------------------------------------------

test('mirror parity: the 366-row golden batch produces identical verdicts (363/3)', () => {
  const text = serverBulk.buildLeapYearDailyPaste({ seedErrors: SEEDED });
  const server = serverBulk.parseStagedBatch(serverPreviewDeps(), text, { defaultStreamId: GOLDEN_STREAM });
  const web = model.parsePastePreview(text, { defaultStreamId: GOLDEN_STREAM });
  assert.equal(server.rowCount, 366);
  assert.equal(server.accepted.length, 363);
  assert.equal(server.rejected.length, 3);
  assert.equal(web.rowCount, 366);
  assert.equal(web.accepted.length, 363);
  assert.equal(web.rejected.length, 3);
  assert.equal(canonical(web), canonical(server));
  // The three seeded errors carry the same row + column + code + cell on both sides.
  for (const seeded of SEEDED) {
    const serverRow = server.rejected.find((row) => row.rowIndex === seeded.rowIndex);
    const webRow = web.rejected.find((row) => row.rowIndex === seeded.rowIndex);
    assert.deepEqual(webRow?.errors, serverRow?.errors);
  }
});

test('mirror parity: clean golden, DST days, duplicates, station/TSV, unit mismatch, empty paste', () => {
  assertMirror(serverBulk.buildLeapYearDailyPaste(), GOLDEN_STREAM);
  // Spring-forward and fall-back days (nonexistent and ambiguous wall times).
  assertMirror('date,time,value\n2026-03-08,01:30,10.0\n2026-03-08,02:30,11.0\n2026-03-08,03:30,12.0', GOLDEN_STREAM);
  assertMirror('date,time,offset,value\n2026-11-01,01:30,-06:00,13.0\n2026-11-01,01:30,-07:00,14.0', GOLDEN_STREAM);
  // Duplicate within the batch and against fixture store rows.
  assertMirror('date,offset,value\n2026-06-01,-06:00,10.0\n2026-06-01,-06:00,10.5', GOLDEN_STREAM);
  assertMirror('date,time,offset,value\n2026-03-06,11:00,-07:00,10.0', GOLDEN_STREAM);
  // Station column + tab delimiter + unknown header + US date format.
  assertMirror('station\tdate\toffset\tvalue\tunit\tcrew\nsta-hyrum-diversion-public\t6/1/2026\t-06:00\t10.0\tcfs\talpha', null);
  // Unit dimension mismatch and missing value.
  assertMirror('date,offset,value,unit\n2026-06-01,-06:00,10.0,ft\n2026-06-02,-06:00,,cfs', GOLDEN_STREAM);
  // Batch-level errors.
  assertMirror('', null);
  assertMirror('date,value', null);
});

test('mirror parity: mapping report (delimiter, unknown columns, header cells) is identical', () => {
  const header = 'Stream,Date,Offset,Value,Unit,Crew';
  const row = 'str-corinne-q,2026-06-01,-06:00,10.0,cfs,alpha';
  const web = model.parsePastePreview(`${header}\n${row}`, {});
  const server = serverBulk.parseStagedBatch(serverPreviewDeps(), `${header}\n${row}`, {});
  assert.deepEqual(web.mapping.unknownColumns, server.mapping.unknownColumns);
  assert.deepEqual(web.mapping.unknownColumns, ['Crew'], 'an unmapped header is reported on both sides');
  assert.equal(web.mapping.delimiter, server.mapping.delimiter);
  assert.equal(web.accepted.length, 1);
  assert.equal(web.accepted[0]?.logicalKey, 'str-corinne-q:2026-06-01T06:00:00Z');
  // An unrecognized DATE header (typo/casing with brackets) rejects rows on
  // BOTH sides identically - the mirror never guesses a mapping.
  const badHeader = 'Stream,Date [MT],Offset,Value,Unit';
  const webBad = model.parsePastePreview(`${badHeader}\nstr-corinne-q,2026-06-01,-06:00,10.0,cfs`, {});
  const serverBad = serverBulk.parseStagedBatch(serverPreviewDeps(), `${badHeader}\nstr-corinne-q,2026-06-01,-06:00,10.0,cfs`, {});
  assert.equal(webBad.accepted.length, 0);
  assert.equal(serverBad.accepted.length, 0);
  assert.equal(canonical(webBad), canonical(serverBad));
});

// ---------------------------------------------------------------------------
// Manual entry form state machine (FR-020)
// ---------------------------------------------------------------------------

const VALID_VALUES: ManualFormValues = {
  streamId: 'str-corinne-q',
  localDate: '2026-03-05',
  localTime: '08:00',
  offset: '-07:00',
  value: '21.5',
  unitId: 'cfs',
  note: 'Field check',
};

test('manual form: validation identifies each offending field and values survive', () => {
  let state = model.manualFormReducer(model.INITIAL_MANUAL_FORM, { type: 'reset' });
  for (const [field, value] of Object.entries({ streamId: 'str-corinne-q', localDate: '2026-03-05', localTime: '08:00', offset: '-07:00', value: '21.5', unitId: 'cfs', note: '' }) as Array<[keyof ManualFormValues, string]>) {
    state = model.manualFormReducer(state, { type: 'edit', field, value });
  }
  state = model.manualFormReducer(state, { type: 'validate' });
  assert.deepEqual(state.fieldErrors, {});
  assert.equal(model.composedObservedAt(state.values), '2026-03-05T15:00:00Z');

  // Break three fields; each is named, and the valid ones keep their values.
  state = model.manualFormReducer(state, { type: 'edit', field: 'value', value: 'lots' });
  state = model.manualFormReducer(state, { type: 'edit', field: 'unitId', value: 'ft' });
  state = model.manualFormReducer(state, { type: 'edit', field: 'localTime', value: '' });
  state = model.manualFormReducer(state, { type: 'validate' });
  assert.deepEqual(Object.keys(state.fieldErrors).sort(), ['localTime', 'unitId', 'value']);
  assert.equal(state.values.localDate, '2026-03-05', 'valid inputs are preserved');
  assert.equal(state.values.streamId, 'str-corinne-q');

  // Fixing a field clears only that field's error.
  state = model.manualFormReducer(state, { type: 'edit', field: 'value', value: '21.5' });
  assert.equal(state.fieldErrors.value, undefined);
  assert.equal(state.fieldErrors.unitId !== undefined, true);
});

test('manual form: range and cross-dimension validation mirror the server rules', () => {
  const outOfRange = model.validateManualForm({ ...VALID_VALUES, value: '9500' });
  assert.match(outOfRange.value ?? '', /valid range \[0, 1200\] cfs/);
  const crossDimension = model.validateManualForm({ ...VALID_VALUES, unitId: 'ft' });
  assert.match(crossDimension.unitId ?? '', /discharge/);
  const missing = model.validateManualForm({ ...VALID_VALUES, value: '' });
  assert.match(missing.value ?? '', /missing reading is not zero/);
  const stageInFeet = model.validateManualForm({ ...VALID_VALUES, streamId: 'str-corinne-stage', unitId: 'ft' });
  assert.equal(stageInFeet.unitId, undefined, 'the stream canonical unit is always compatible');
});

test('manual form: submit flow returns the saved record id; server field errors preserve the form', () => {
  let state = model.manualFormReducer(model.INITIAL_MANUAL_FORM, { type: 'edit', field: 'streamId', value: VALID_VALUES.streamId });
  for (const [field, value] of Object.entries(VALID_VALUES) as Array<[keyof ManualFormValues, string]>) {
    state = model.manualFormReducer(state, { type: 'edit', field, value });
  }
  state = model.manualFormReducer(state, { type: 'submit-start' });
  assert.equal(state.phase, 'submitting');
  state = model.manualFormReducer(state, { type: 'submit-ok', recordId: 'obs-entry-1070', duplicate: false });
  assert.equal(state.phase, 'saved');
  assert.equal(state.savedRecordId, 'obs-entry-1070');
  assert.match(state.submitMessage ?? '', /obs-entry-1070/);

  const rejected = model.manualFormReducer(state, { type: 'submit-field-errors', errors: { value: 'Value is outside the valid range.' } });
  assert.equal(rejected.phase, 'error');
  assert.equal(rejected.values.value, '21.5', 'the form keeps what the user typed');
  assert.equal(rejected.fieldErrors.value, 'Value is outside the valid range.');

  const duplicate = model.manualFormReducer(model.INITIAL_MANUAL_FORM, { type: 'submit-ok', recordId: 'obs-q-001', duplicate: true });
  assert.match(duplicate.submitMessage ?? '', /already exists/);
  assert.match(duplicate.submitMessage ?? '', /No duplicate row was created/);
});

// ---------------------------------------------------------------------------
// Bulk paste flow state machine (FR-021)
// ---------------------------------------------------------------------------

test('bulk flow: paste -> mapping -> validated -> commit guard rails', () => {
  let state = model.bulkFlowReducer(model.INITIAL_BULK_FLOW, { type: 'set-text', text: 'date,value\n2026-06-01,10.0' });
  assert.equal(state.phase, 'paste');
  state = model.bulkFlowReducer(state, { type: 'commit-start' });
  assert.equal(state.phase, 'paste', 'commit is refused before validation');
  assert.match(state.refusalMessage ?? '', /Validate the batch/);

  state = model.bulkFlowReducer(state, { type: 'to-mapping' });
  assert.equal(state.phase, 'mapping');
  const preview = model.parsePastePreview(state.text, { defaultStreamId: GOLDEN_STREAM });
  state = model.bulkFlowReducer(state, { type: 'validated', batchId: 'imp-1001', preview });
  assert.equal(state.phase, 'validated');
  assert.equal(state.preview?.accepted.length, 1);

  state = model.bulkFlowReducer(state, { type: 'commit-start' });
  assert.equal(state.phase, 'committing');
  state = model.bulkFlowReducer(state, { type: 'committed', batchId: 'imp-1001', inserted: 366, duplicates: 0, skipped: 0 });
  assert.equal(state.phase, 'committed');
  assert.deepEqual(state.commitSummary, { inserted: 366, duplicates: 0, skipped: 0 });
});

test('bulk flow: an atomic refusal returns to the validated preview with the exact message', () => {
  let state = model.bulkFlowReducer(model.INITIAL_BULK_FLOW, { type: 'set-text', text: 'date,value\n2026-06-01,abc' });
  state = model.bulkFlowReducer(state, { type: 'to-mapping' });
  const preview = model.parsePastePreview(state.text, { defaultStreamId: GOLDEN_STREAM });
  state = model.bulkFlowReducer(state, { type: 'validated', batchId: 'imp-1002', preview });
  state = model.bulkFlowReducer(state, { type: 'set-mode', mode: 'atomic' });
  state = model.bulkFlowReducer(state, { type: 'commit-start' });
  state = model.bulkFlowReducer(state, { type: 'refused', message: 'atomic import refused: 1 of 1 rows failed validation; nothing was committed' });
  assert.equal(state.phase, 'validated', 'back at the review table, not the empty paste state');
  assert.match(state.refusalMessage ?? '', /nothing was committed/);
  assert.equal(state.preview?.rejected.length, 1, 'the offending row stays visible');
});

test('bulk flow: empty paste cannot advance; mode defaults to atomic and is switchable', () => {
  let state = model.bulkFlowReducer(model.INITIAL_BULK_FLOW, { type: 'to-mapping' });
  assert.equal(state.phase, 'paste');
  assert.match(state.refusalMessage ?? '', /Paste data/);
  assert.equal(model.INITIAL_BULK_FLOW.mode, 'atomic', 'documented default');
  state = model.bulkFlowReducer(state, { type: 'set-mode', mode: 'partial' });
  assert.equal(state.mode, 'partial');
  state = model.bulkFlowReducer(state, { type: 'back-to-paste' });
  assert.equal(state.phase, 'paste');
  assert.equal(state.mode, 'partial', 'the mode choice survives a restart of the flow');
  assert.equal(state.text, '', 'text cleared for the next paste');
});
