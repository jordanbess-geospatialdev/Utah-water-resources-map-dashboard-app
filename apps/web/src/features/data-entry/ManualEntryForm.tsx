/**
 * ManualEntryForm - the FR-020 single-reading entry surface.
 *
 * Mobile-first (single column, comfortable at 360px): stream, local date,
 * time, explicit UTC offset, value, unit and optional note. Validation
 * identifies the offending field next to its input (icon + text, never
 * color alone), valid inputs are preserved on error (the reducer never
 * clears values), and a successful save shows the returned record
 * identifier. A duplicate submission tells the user the original record
 * was returned and no duplicate row was created.
 *
 * Mountable and shell-free: the submit path is an injected port. The
 * default demo port validates with the same pure model the server uses and
 * resolves duplicates against the fixture observations; the real port
 * calls POST /streams/{id}/observations when the shell wires it.
 *
 * Accessibility: every control is labelled (htmlFor/id), field errors use
 * role=alert, the saved/duplicate notice uses role=status, and the form
 * submits from the keyboard (button type=submit).
 */
import { useId, useState, type CSSProperties, type FormEvent } from 'react';
import {
  composedObservedAt,
  DENVER_OFFSETS,
  ENTRY_STREAMS,
  ENTRY_UNITS,
  INITIAL_MANUAL_FORM,
  manualFormReducer,
  streamDisplayName,
  validateManualForm,
} from './entryModel';
import type { ManualFormValues } from './entryModel';

export type ManualSubmitResult =
  | { readonly status: 'ok'; readonly recordId: string; readonly duplicate: boolean }
  | { readonly status: 'field-errors'; readonly errors: Readonly<Record<string, string>> }
  | { readonly status: 'failed'; readonly message: string };

export type ManualSubmitPort = (values: ManualFormValues) => ManualSubmitResult | Promise<ManualSubmitResult>;

export interface ManualEntryFormProps {
  /** Injected save path; defaults to the fixture demo port. */
  readonly onSubmit?: ManualSubmitPort;
  /** Restrict the stream picker (e.g. the actor's assigned scope). */
  readonly streamIds?: readonly string[];
  readonly now?: string;
}

const FORM_STYLE: CSSProperties = { display: 'grid', gap: 10, maxWidth: 360 };
const LABEL_STYLE: CSSProperties = { display: 'grid', gap: 3, fontSize: 13, fontWeight: 600 };
const INPUT_STYLE: CSSProperties = { padding: '8px 10px', fontSize: 16, borderRadius: 6, border: '1px solid #9aa79e', width: '100%', boxSizing: 'border-box' };
const ERROR_STYLE: CSSProperties = { display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12.5, color: '#8a1c1c', marginTop: 2 };
const NOTICE_STYLE: CSSProperties = { padding: 10, borderRadius: 6, border: '1px solid #4b7a46', background: '#f0f7ee', fontSize: 13 };
const BUTTON_STYLE: CSSProperties = { padding: '10px 14px', fontSize: 15, fontWeight: 600, borderRadius: 6, border: '1px solid #2f5d2c', background: '#2f6b2c', color: '#fff', cursor: 'pointer' };

function FieldError({ message }: { readonly message: string }) {
  return (
    <span role="alert" style={ERROR_STYLE}>
      <span aria-hidden>⚠</span>
      <span>{message}</span>
    </span>
  );
}

/** Fixture demo port: the same validation model, duplicates resolved against fixture rows. */
function demoSubmit(values: ManualFormValues): ManualSubmitResult {
  const errors = validateManualForm(values);
  if (Object.keys(errors).length > 0) return { status: 'field-errors', errors };
  const observedAt = composedObservedAt(values);
  if (!observedAt) return { status: 'failed', message: 'Could not compose the observation time from the entered date, time and offset.' };
  const logicalKey = `${values.streamId}:${observedAt}`;
  const existing = demoExistingKeys.get(logicalKey);
  if (existing) return { status: 'ok', recordId: existing, duplicate: true };
  demoSequence += 1;
  const recordId = `obs-entry-${String(1070 + demoSequence)}`;
  demoExistingKeys.set(logicalKey, recordId);
  return { status: 'ok', recordId, duplicate: false };
}

const demoExistingKeys = new Map<string, string>();
let demoSequence = 0;

export default function ManualEntryForm({ onSubmit, streamIds }: ManualEntryFormProps) {
  const [state, setState] = useState(INITIAL_MANUAL_FORM);
  const formId = useId();
  const submit = onSubmit ?? demoSubmit;

  const streams = streamIds ? ENTRY_STREAMS.filter((stream) => streamIds.includes(stream.id)) : ENTRY_STREAMS;
  const selectedStream = streams.find((stream) => stream.id === state.values.streamId) ?? null;
  // Unit picker: the governed vocabulary; the stream's canonical unit first.
  const unitOptions = selectedStream
    ? [...ENTRY_UNITS].sort((a, b) => (a.id === selectedStream.unitId ? -1 : b.id === selectedStream.unitId ? 1 : 0))
    : ENTRY_UNITS;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fieldErrors = validateManualForm(state.values);
    setState((current) => manualFormReducer(current, { type: 'validate' }));
    if (Object.keys(fieldErrors).length > 0) return;
    setState((current) => manualFormReducer(current, { type: 'submit-start' }));
    const result = await submit(state.values);
    setState((current) => {
      if (result.status === 'ok') {
        return manualFormReducer(current, { type: 'submit-ok', recordId: result.recordId, duplicate: result.duplicate });
      }
      if (result.status === 'field-errors') {
        return manualFormReducer(current, { type: 'submit-field-errors', errors: result.errors });
      }
      return manualFormReducer(current, { type: 'submit-failed', message: result.message });
    });
  }

  const bind = (field: keyof ManualFormValues) => ({
    id: `${formId}-${field}`,
    value: state.values[field],
    onChange: (event: { target: { value: string } }) =>
      setState((current) => manualFormReducer(current, { type: 'edit', field, value: event.target.value })),
  });

  return (
    <form style={FORM_STYLE} onSubmit={handleSubmit} noValidate aria-label="Enter a measurement reading">
      <h3 style={{ margin: 0, fontSize: 15 }}>Enter a reading</h3>

      <label style={LABEL_STYLE} htmlFor={`${formId}-streamId`}>
        Stream
        <select {...bind('streamId')} style={INPUT_STYLE}>
          <option value="">Choose the stream...</option>
          {streams.map((stream) => (
            <option key={stream.id} value={stream.id}>
              {streamDisplayName(stream.id)}
            </option>
          ))}
        </select>
      </label>
      {state.fieldErrors.streamId ? <FieldError message={state.fieldErrors.streamId} /> : null}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={LABEL_STYLE} htmlFor={`${formId}-localDate`}>
          Date (local)
          <input {...bind('localDate')} style={INPUT_STYLE} placeholder="2026-03-05" inputMode="numeric" autoComplete="off" />
        </label>
        <label style={LABEL_STYLE} htmlFor={`${formId}-localTime`}>
          Time (24h)
          <input {...bind('localTime')} style={INPUT_STYLE} placeholder="08:00" inputMode="numeric" autoComplete="off" />
        </label>
      </div>
      {(state.fieldErrors.localDate ?? state.fieldErrors.localTime) ? (
        <FieldError message={state.fieldErrors.localDate ?? state.fieldErrors.localTime ?? ''} />
      ) : null}

      <label style={LABEL_STYLE} htmlFor={`${formId}-offset`}>
        UTC offset when taken
        <select {...bind('offset')} style={INPUT_STYLE}>
          {DENVER_OFFSETS.map((offset) => (
            <option key={offset.id} value={offset.id}>
              {offset.label}
            </option>
          ))}
        </select>
      </label>
      {state.fieldErrors.offset ? <FieldError message={state.fieldErrors.offset} /> : null}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={LABEL_STYLE} htmlFor={`${formId}-value`}>
          Value {selectedStream ? `(${selectedStream.unitId})` : ''}
          <input {...bind('value')} style={INPUT_STYLE} placeholder="21.5" inputMode="decimal" autoComplete="off" />
        </label>
        <label style={LABEL_STYLE} htmlFor={`${formId}-unitId`}>
          Unit
          <select {...bind('unitId')} style={INPUT_STYLE}>
            <option value="">Choose...</option>
            {unitOptions.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.id} - {unit.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {state.fieldErrors.value ? <FieldError message={state.fieldErrors.value} /> : null}
      {state.fieldErrors.unitId ? <FieldError message={state.fieldErrors.unitId} /> : null}

      <label style={LABEL_STYLE} htmlFor={`${formId}-note`}>
        Note (optional)
        <input {...bind('note')} style={INPUT_STYLE} placeholder="Field check, ice, gauge change..." autoComplete="off" />
      </label>

      <button type="submit" style={BUTTON_STYLE} disabled={state.phase === 'submitting'}>
        {state.phase === 'submitting' ? 'Saving...' : 'Save reading'}
      </button>

      {state.phase === 'saved' || state.phase === 'error' ? (
        <div role="status" style={NOTICE_STYLE} aria-live="polite">
          <span aria-hidden>{state.phase === 'saved' ? '✓' : '⚠'}</span>{' '}
          {state.submitMessage}
          {state.phase === 'saved' && state.savedRecordId ? (
            <> Record identifier: <code>{state.savedRecordId}</code>.</>
          ) : null}
        </div>
      ) : null}

      {selectedStream && selectedStream.validRangeMax !== null ? (
        <p style={{ margin: 0, fontSize: 11.5, color: '#5c6a60' }}>
          Valid range for this stream: [{selectedStream.validRangeMin ?? '-∞'}, {selectedStream.validRangeMax}] {selectedStream.unitId}.
          The observation time must carry the offset in effect when the reading was taken; ambiguous local times (DST) require an explicit offset.
        </p>
      ) : null}
    </form>
  );
}
