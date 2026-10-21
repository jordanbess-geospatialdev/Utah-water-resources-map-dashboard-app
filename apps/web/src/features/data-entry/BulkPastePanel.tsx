/**
 * BulkPastePanel - the FR-021 large-batch paste/import surface.
 *
 * Staged flow: paste or upload -> column mapping report -> validate ->
 * review the preview table -> choose the documented atomic or partial
 * mode -> explicit commit. The preview marks every cell error with an icon
 * AND text (never color alone), reports duplicates within the batch and
 * against existing rows, and after a commit tells the user that retrying
 * the same paste reports duplicates instead of creating them.
 *
 * The preview parse is the exact mirror of the server's validate stage
 * (see entryModel.ts); authorization and the authoritative duplicate
 * re-check happen server-side at validate and commit - the panel states
 * this. Ports are injected; the demo ports run the mirror locally.
 *
 * Accessibility: labelled controls, fieldset/legend for the mode choice,
 * role=alert for refusals, role=status for progress, and the preview table
 * uses a real table with scope=col headers.
 */
import { useId, useRef, useState, type CSSProperties, type ChangeEvent } from 'react';
import {
  bulkFlowReducer,
  ENTRY_STREAMS,
  INITIAL_BULK_FLOW,
  parsePastePreview,
  streamDisplayName,
} from './entryModel';
import type { BulkFlowState, ImportModeChoice, ParsedPreview, PreviewRowVerdict } from './entryModel';

export interface ValidatePortResult {
  readonly batchId: string;
  readonly preview: ParsedPreview;
}

export type ValidatePort = (text: string, defaultStreamId: string | null) => ValidatePortResult | Promise<ValidatePortResult>;

export type CommitPortResult =
  | { readonly status: 'committed'; readonly inserted: number; readonly duplicates: number; readonly skipped: number }
  | { readonly status: 'refused'; readonly message: string };

export type CommitPort = (batchId: string, mode: ImportModeChoice, preview: ParsedPreview) => CommitPortResult | Promise<CommitPortResult>;

export interface BulkPastePanelProps {
  readonly onValidate?: ValidatePort;
  readonly onCommit?: CommitPort;
  /** Restrict the stream binding picker. */
  readonly streamIds?: readonly string[];
}

const PANEL_STYLE: CSSProperties = { display: 'grid', gap: 12, maxWidth: 720 };
const TEXTAREA_STYLE: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 120,
  padding: 10,
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12.5,
  borderRadius: 6,
  border: '1px solid #9aa79e',
};
const BUTTON_STYLE: CSSProperties = { padding: '10px 14px', fontSize: 15, fontWeight: 600, borderRadius: 6, cursor: 'pointer', border: '1px solid #2f5d2c', background: '#2f6b2c', color: '#fff' };
const SECONDARY_BUTTON_STYLE: CSSProperties = { ...BUTTON_STYLE, background: '#fff', color: '#2f5d2c' };
const TABLE_STYLE: CSSProperties = { borderCollapse: 'collapse', width: '100%', fontSize: 12.5 };
const CELL_STYLE: CSSProperties = { border: '1px solid #c3cdc5', padding: '4px 7px', textAlign: 'left', verticalAlign: 'top' };
const ERROR_CELL_STYLE: CSSProperties = { ...CELL_STYLE, background: '#fdf0f0', fontWeight: 600 };
const DUP_CELL_STYLE: CSSProperties = { ...CELL_STYLE, background: '#f6f3e7' };
const NOTICE_STYLE: CSSProperties = { padding: 10, borderRadius: 6, border: '1px solid #4b7a46', background: '#f0f7ee', fontSize: 13 };
const WARNING_STYLE: CSSProperties = { padding: 10, borderRadius: 6, border: '1px solid #9c7c1b', background: '#fbf6e4', fontSize: 13 };
const REFUSAL_STYLE: CSSProperties = { padding: 10, borderRadius: 6, border: '1px solid #8a1c1c', background: '#fdf0f0', fontSize: 13 };

/** Demo ports: the mirror parse plus the documented commit semantics, all local. */
let demoBatchSequence = 0;
function demoValidate(text: string, defaultStreamId: string | null): ValidatePortResult {
  demoBatchSequence += 1;
  return { batchId: `demo-imp-${String(1000 + demoBatchSequence)}`, preview: parsePastePreview(text, { defaultStreamId }) };
}

function demoCommit(batchId: string, mode: ImportModeChoice, preview: ParsedPreview): CommitPortResult {
  if (mode === 'atomic' && preview.rejected.length > 0) {
    return {
      status: 'refused',
      message: `Atomic import refused: ${preview.rejected.length} of ${preview.rowCount} rows failed validation; nothing was committed. Fix the flagged cells or choose the documented partial mode.`,
    };
  }
  return {
    status: 'committed',
    inserted: preview.accepted.length,
    duplicates: preview.duplicates.length,
    skipped: mode === 'partial' ? preview.rejected.length : 0,
  };
}

function RowVerdictRow({ verdict }: { readonly verdict: PreviewRowVerdict }) {
  if (verdict.kind === 'accepted') {
    return (
      <tr>
        <td style={CELL_STYLE}>✓ {verdict.rowIndex}</td>
        <td style={CELL_STYLE}>{verdict.streamId}</td>
        <td style={CELL_STYLE}>
          {verdict.time.observedAt} <small>({verdict.time.sourceOffset})</small>
        </td>
        <td style={CELL_STYLE}>{verdict.value}</td>
        <td style={CELL_STYLE}>{verdict.unitId}</td>
      </tr>
    );
  }
  if (verdict.kind === 'duplicate') {
    return (
      <tr>
        <td style={DUP_CELL_STYLE}>⧉ {verdict.rowIndex}</td>
        <td style={DUP_CELL_STYLE}>{verdict.streamId}</td>
        <td style={DUP_CELL_STYLE}>
          {verdict.time.observedAt} <small>({verdict.time.sourceOffset})</small>
          <div>
            <span aria-hidden>⧉</span> Duplicate {verdict.against === 'batch' ? `of data row ${verdict.firstRowIndex ?? '?'} in this paste` : `of existing record ${verdict.existingId ?? '?'} already in the system`} - reported, not skipped silently, and never inserted twice.
          </div>
        </td>
        <td style={DUP_CELL_STYLE}>{verdict.value}</td>
        <td style={DUP_CELL_STYLE}>{verdict.unitId}</td>
      </tr>
    );
  }
  return (
    <tr>
      <td style={ERROR_CELL_STYLE}>⚠ {verdict.rowIndex}</td>
      <td style={ERROR_CELL_STYLE} colSpan={4}>
        {verdict.errors.map((error) => (
          <div key={`${verdict.rowIndex}:${error.columnKey ?? 'row'}:${error.code}`}>
            <span aria-hidden>⚠</span> <strong>{error.columnKey ? `${error.columnKey} column` : 'row'}</strong> - {error.message}
            {error.cellValue !== '' ? <> (cell: “{error.cellValue}”)</> : null}
          </div>
        ))}
      </td>
    </tr>
  );
}

function PreviewTable({ preview }: { readonly preview: ParsedPreview }) {
  const rows: PreviewRowVerdict[] = [
    ...preview.rejected,
    ...preview.duplicates,
    ...preview.accepted,
  ].sort((a, b) => a.rowIndex - b.rowIndex);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={TABLE_STYLE}>
        <caption style={{ textAlign: 'left', fontSize: 12, padding: '4px 0' }}>
          {preview.rowCount} data rows: {preview.accepted.length} accepted, {preview.duplicates.length} duplicate, {preview.rejected.length} rejected
        </caption>
        <thead>
          <tr>
            <th scope="col" style={CELL_STYLE}>Row</th>
            <th scope="col" style={CELL_STYLE}>Stream</th>
            <th scope="col" style={CELL_STYLE}>Observed (UTC, offset kept)</th>
            <th scope="col" style={CELL_STYLE}>Value</th>
            <th scope="col" style={CELL_STYLE}>Unit</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 50).map((verdict) => (
            <RowVerdictRow key={`${verdict.rowIndex}:${verdict.kind}`} verdict={verdict} />
          ))}
        </tbody>
      </table>
      {rows.length > 50 ? <p style={{ fontSize: 12, margin: '4px 0 0' }}>Showing the first 50 of {rows.length} rows.</p> : null}
    </div>
  );
}

export default function BulkPastePanel({ onValidate, onCommit, streamIds }: BulkPastePanelProps) {
  const [state, setState] = useState<BulkFlowState>(INITIAL_BULK_FLOW);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const controlId = useId();
  const validate = onValidate ?? demoValidate;
  const commit = onCommit ?? demoCommit;

  const streams = streamIds ? ENTRY_STREAMS.filter((stream) => streamIds.includes(stream.id)) : ENTRY_STREAMS;

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    void file.text().then((text) => setState((current) => bulkFlowReducer(current, { type: 'set-text', text })));
  }

  async function handleValidate() {
    const result = await validate(state.text, state.defaultStreamId);
    setState((current) => bulkFlowReducer(current, { type: 'validated', batchId: result.batchId, preview: result.preview }));
  }

  async function handleCommit() {
    if (!state.preview) return;
    setState((current) => bulkFlowReducer(current, { type: 'commit-start' }));
    const result = await commit(state.batchId ?? '', state.mode, state.preview);
    setState((current) => {
      if (result.status === 'committed') {
        return bulkFlowReducer(current, {
          type: 'committed',
          batchId: current.batchId ?? '',
          inserted: result.inserted,
          duplicates: result.duplicates,
          skipped: result.skipped,
        });
      }
      return bulkFlowReducer(current, { type: 'refused', message: result.message });
    });
  }

  return (
    <section style={PANEL_STYLE} aria-label="Bulk paste import">
      <h3 style={{ margin: 0, fontSize: 15 }}>Bulk paste import</h3>

      {(state.phase === 'paste' || state.phase === 'mapping') && (
        <>
          <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 600 }} htmlFor={`${controlId}-paste`}>
            Paste readings (CSV or TSV with a header row)
            <textarea
              id={`${controlId}-paste`}
              style={TEXTAREA_STYLE}
              value={state.text}
              placeholder={'date,offset,value,unit\n2026-01-01,-07:00,18.0,cfs\n...'}
              onChange={(event) => setState((current) => bulkFlowReducer(current, { type: 'set-text', text: event.target.value }))}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" style={SECONDARY_BUTTON_STYLE} onClick={() => fileInputRef.current?.click()}>
              Upload CSV/TSV file
            </button>
            <input ref={fileInputRef} id={`${controlId}-file`} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" style={{ display: 'none' }} onChange={handleFile} />
            {fileName ? (
              <span role="status" style={{ fontSize: 12.5 }}>
                Loaded {fileName}
              </span>
            ) : null}
          </div>
          <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 600 }} htmlFor={`${controlId}-stream`}>
            Bind the whole batch to one stream (optional when rows carry stream/station columns)
            <select
              id={`${controlId}-stream`}
              style={{ padding: '8px 10px', fontSize: 15, borderRadius: 6, border: '1px solid #9aa79e' }}
              value={state.defaultStreamId ?? ''}
              onChange={(event) => setState((current) => bulkFlowReducer(current, { type: 'set-stream', streamId: event.target.value || null }))}
            >
              <option value="">Each row names its stream/station</option>
              {streams.map((stream) => (
                <option key={stream.id} value={stream.id}>
                  {streamDisplayName(stream.id)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" style={BUTTON_STYLE} onClick={() => setState((current) => bulkFlowReducer(current, { type: 'to-mapping' }))} disabled={state.text.trim() === ''}>
            Continue to mapping
          </button>
        </>
      )}

      {state.phase === 'mapping' && (
        <>
          <div role="status" style={NOTICE_STYLE}>
            Detected delimiter: <strong>{detectLabel(state.text)}</strong>. Column mapping runs automatically from the header aliases (stream/station/date/time/datetime/offset/value/unit/method/note).
            {state.text.trim() !== '' && parsePastePreview(state.text, { defaultStreamId: state.defaultStreamId }).mapping.unknownColumns.length > 0 ? (
              <> Unrecognized headers (ignored, but reported): {parsePastePreview(state.text, { defaultStreamId: state.defaultStreamId }).mapping.unknownColumns.join(', ')}.</>
            ) : null}
          </div>
          <button type="button" style={BUTTON_STYLE} onClick={() => void handleValidate()}>
            Validate batch
          </button>
          <button type="button" style={SECONDARY_BUTTON_STYLE} onClick={() => setState((current) => bulkFlowReducer(current, { type: 'back-to-paste' }))}>
            Back to paste
          </button>
        </>
      )}

      {(state.phase === 'validated' || state.phase === 'committing') && state.preview && (
        <>
          <div role="status" style={NOTICE_STYLE} aria-live="polite">
            Batch <code>{state.batchId}</code> validated: {state.preview.rowCount} rows - {state.preview.accepted.length} accepted, {state.preview.duplicates.length} duplicate, {state.preview.rejected.length} rejected.
            {state.preview.batchErrors.length > 0 ? <> Batch problems: {state.preview.batchErrors.map((error) => error.message).join(' ')} </> : null}
          </div>
          <PreviewTable preview={state.preview} />
          {state.preview.duplicates.length > 0 ? (
            <div role="status" style={WARNING_STYLE}>
              <span aria-hidden>⧉</span> {state.preview.duplicates.length} duplicate reading(s) - reported, never silently skipped. Duplicates against the system are not re-inserted; the first occurrence within the paste wins.
            </div>
          ) : null}
          <fieldset style={{ border: '1px solid #9aa79e', borderRadius: 6, padding: 10 }}>
            <legend style={{ fontSize: 13, fontWeight: 600, padding: '0 4px' }}>Import mode</legend>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              <span>
                <input
                  type="radio"
                  name={`${controlId}-mode`}
                  checked={state.mode === 'atomic'}
                  onChange={() => setState((current) => bulkFlowReducer(current, { type: 'set-mode', mode: 'atomic' }))}
                />{' '}
                Atomic (recommended): all rows commit together, or - if any row is invalid - nothing commits and every error is listed.
              </span>
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              <span>
                <input
                  type="radio"
                  name={`${controlId}-mode`}
                  checked={state.mode === 'partial'}
                  onChange={() => setState((current) => bulkFlowReducer(current, { type: 'set-mode', mode: 'partial' }))}
                />{' '}
                Documented partial: valid rows commit; invalid rows and duplicates are skipped with an exact per-row report of what committed and what did not.
              </span>
            </label>
          </fieldset>
          <p style={{ margin: 0, fontSize: 12, color: '#5c6a60' }}>
            Committing re-verifies your scope, each stream's current measurement setup and duplicates at commit time. If anything changed since validation the batch is refused for revalidation - retrying never creates duplicate readings (the same batch commits exactly once).
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={BUTTON_STYLE} onClick={() => void handleCommit()} disabled={state.phase === 'committing'}>
              {state.phase === 'committing' ? 'Committing...' : 'Commit batch'}
            </button>
            <button type="button" style={SECONDARY_BUTTON_STYLE} onClick={() => setState((current) => bulkFlowReducer(current, { type: 'back-to-paste' }))}>
              Discard
            </button>
          </div>
        </>
      )}

      {state.refusalMessage ? (
        <div role="alert" style={REFUSAL_STYLE}>
          <span aria-hidden>⚠</span> {state.refusalMessage}
        </div>
      ) : null}

      {state.phase === 'committed' && state.commitSummary ? (
        <div role="status" style={NOTICE_STYLE} aria-live="polite">
          <span aria-hidden>✓</span> Committed batch <code>{state.batchId}</code>: {state.commitSummary.inserted} reading(s) inserted, {state.commitSummary.duplicates} duplicate(s) reported, {state.commitSummary.skipped} skipped.
          Re-submitting the same paste will not create duplicates - every row comes back reported as a duplicate of what just committed.
        </div>
      ) : null}
    </section>
  );
}

function detectLabel(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const tabs = firstLine.split('\t').length - 1;
  const semis = firstLine.split(';').length - 1;
  const commas = firstLine.split(',').length - 1;
  if (tabs > 0 && tabs >= commas && tabs >= semis) return 'TAB';
  if (semis > 0 && semis > commas) return 'semicolon';
  return 'comma';
}
