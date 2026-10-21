/**
 * VisitForm - the FR-046/FR-049 field visit recording surface.
 *
 * Mobile-first (single column, comfortable at 360 CSS pixels, no horizontal
 * scrolling): site, visit date/time with an explicit UTC offset, type,
 * measurement/maintenance actions, notes, structured lastChecked/lastRated
 * dates, and categorized attachment rows with a visibility picker. Wiring
 * notes lock to internal with an EXPLICIT confirmation checkbox (FR-049: a
 * gate code or wiring detail can never be public).
 *
 * Unsent/retry states are first-class (FR-026: data submission survives a
 * recoverable failure): a network error keeps the complete form with an
 * explicit "not sent" banner, the error message, the attempt count and a
 * Retry button that resubmits with the same idempotency key. Field errors
 * identify the offending control next to it (text + icon, never color
 * alone).
 *
 * Mountable and shell-free: the submit path is an injected port. The demo
 * port validates with this pure model and synthesizes a visit id; the real
 * port calls POST /sites/{id}/visits when the shell wires it (README).
 *
 * Accessibility: every control is labelled (htmlFor/id), field errors use
 * role=alert, the unsent/sent banners use role=status/alert, and the form
 * submits from the keyboard (type=submit).
 */
import { useId, useState, type CSSProperties, type FormEvent } from 'react';
import {
  ATTACHMENT_CATEGORIES,
  ATTACHMENT_VISIBILITIES,
  EMPTY_VISIT_FORM,
  UTC_OFFSETS,
  VISIT_ACTIONS,
  VISIT_TYPES,
  composeSubmitBody,
  initialVisitDraft,
  isWiringNote,
  newAttachmentRow,
  submitVisitDraft,
  validateVisitForm,
  visitDraftReducer,
  type AttachmentDraft,
  type AttachmentVisibility,
  type VisitDraftState,
  type VisitFormValues,
  type VisitTransport,
  type VisitTransportResult,
} from './visitModel';

export interface VisitFormProps {
  /** Site picker restriction (the acting engineer's assigned scope). */
  readonly siteIds?: readonly string[];
  /** Site labels; defaults to the fixture station names. */
  readonly siteNames?: Readonly<Record<string, string>>;
  /** Injected submit path; defaults to the offline-friendly demo port. */
  readonly onSubmit?: VisitTransport;
  /** Demo-only: force a transport error on the next submit (error-state demo/tests). */
  readonly simulateNetworkFailure?: boolean;
  /** Injected clock for status timestamps (deterministic demos). */
  readonly now?: string;
  /** Draft id for the idempotency key (one per form instance). */
  readonly draftId?: string;
}

const FORM_STYLE: CSSProperties = { display: 'grid', gap: 10, maxWidth: 360 };
const LABEL_STYLE: CSSProperties = { display: 'grid', gap: 3, fontSize: 13, fontWeight: 600 };
const INPUT_STYLE: CSSProperties = { padding: '8px 10px', fontSize: 16, borderRadius: 6, border: '1px solid #9aa79e', width: '100%', boxSizing: 'border-box' };
const ERROR_STYLE: CSSProperties = { display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12.5, color: '#8a1c1c', marginTop: 2 };
const NOTICE_STYLE: CSSProperties = { padding: 10, borderRadius: 6, border: '1px solid #4b7a46', background: '#f0f7ee', fontSize: 13 };
const UNSENT_STYLE: CSSProperties = { padding: 10, borderRadius: 6, border: '1px solid #8a6d1c', background: '#fdf6e3', fontSize: 13 };
const BUTTON_STYLE: CSSProperties = { padding: '10px 14px', fontSize: 15, fontWeight: 600, borderRadius: 6, border: '1px solid #2f5d2c', background: '#2f6b2c', color: '#fff', cursor: 'pointer' };
const RETRY_STYLE: CSSProperties = { ...BUTTON_STYLE, background: '#8a6d1c', borderColor: '#6b5411', marginTop: 8 };
const ROW_STYLE: CSSProperties = { border: '1px solid #dce4de', borderRadius: 6, padding: 10, display: 'grid', gap: 8, background: '#fbfdfa' };

const DEFAULT_SITE_NAMES: Readonly<Record<string, string>> = {
  'sta-bear-corinne': 'Bear River near Corinne',
  'sta-hyrum-diversion-public': 'Little Bear River Diversion near Hyrum',
  'sta-bear-lake-diagnostic': 'Garden City Diagnostic Site',
};

function FieldError({ message }: { readonly message: string }) {
  return (
    <span role="alert" style={ERROR_STYLE}>
      <span aria-hidden>⚠</span>
      <span>{message}</span>
    </span>
  );
}

/** Demo port: validates with the same pure model; optionally fails like a network. */
function makeDemoSubmit(simulateNetworkFailure: boolean): VisitTransport {
  let sequence = 0;
  const sent = new Map<string, string>();
  return (values, idempotencyKey) => {
    if (simulateNetworkFailure) {
      return { kind: 'transport-error', message: 'network unavailable: the visit was NOT sent and is preserved below' };
    }
    const errors = validateVisitForm(values);
    if (Object.keys(errors).length > 0) {
      return { kind: 'transport-error', message: 'The visit was not recorded - fix the flagged fields and submit again.' };
    }
    const recorded = sent.get(idempotencyKey);
    if (recorded) return { kind: 'sent', visitId: recorded, replayed: true };
    sequence += 1;
    const visitId = `visit-demo-${String(1000 + sequence)}`;
    sent.set(idempotencyKey, visitId);
    const result: VisitTransportResult = { kind: 'sent', visitId, replayed: false };
    return result;
  };
}

function AttachmentRow({
  row,
  formId,
  errorFor,
  onChange,
  onRemove,
}: {
  readonly row: AttachmentDraft;
  readonly formId: string;
  readonly errorFor: (field: string) => string | undefined;
  readonly onChange: (next: AttachmentDraft) => void;
  readonly onRemove: () => void;
}) {
  const locked = isWiringNote(row.category);
  return (
    <fieldset style={ROW_STYLE}>
      <legend style={{ fontSize: 12, fontWeight: 700, padding: '0 4px' }}>Attachment</legend>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={LABEL_STYLE} htmlFor={`${formId}-${row.rowId}-category`}>
          Category
          <select
            id={`${formId}-${row.rowId}-category`}
            value={row.category}
            onChange={(event) => {
              const category = event.target.value as AttachmentDraft['category'];
              // Wiring notes are internal by policy: the default flips with
              // the category and can never be set to public.
              onChange({ ...row, category, visibility: isWiringNote(category) ? 'internal' : row.visibility === 'internal' ? 'internal' : 'public' });
            }}
            style={INPUT_STYLE}
          >
            {ATTACHMENT_CATEGORIES.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
        <label style={LABEL_STYLE} htmlFor={`${formId}-${row.rowId}-visibility`}>
          Visibility
          <select
            id={`${formId}-${row.rowId}-visibility`}
            value={row.visibility}
            disabled={locked}
            onChange={(event) => onChange({ ...row, visibility: event.target.value as AttachmentVisibility })}
            style={INPUT_STYLE}
          >
            {ATTACHMENT_VISIBILITIES.map((visibility) => (
              <option key={visibility.id} value={visibility.id}>
                {visibility.label}
                {locked && visibility.id === 'internal' ? ' (locked)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      {locked ? <p style={{ margin: 0, fontSize: 11.5, color: '#6b5411' }}>A wiring note (gate code or wiring detail) can never be public - FR-049.</p> : null}
      {errorFor(`${row.rowId}.visibility`) ? <FieldError message={errorFor(`${row.rowId}.visibility`)!} /> : null}

      <label style={LABEL_STYLE} htmlFor={`${formId}-${row.rowId}-filename`}>
        Filename
        <input
          id={`${formId}-${row.rowId}-filename`}
          value={row.filename}
          onChange={(event) => onChange({ ...row, filename: event.target.value })}
          style={INPUT_STYLE}
          placeholder="gauge-plate.jpg"
          autoComplete="off"
        />
      </label>
      {errorFor(`${row.rowId}.filename`) ? <FieldError message={errorFor(`${row.rowId}.filename`)!} /> : null}

      {locked ? (
        <>
          <label style={LABEL_STYLE} htmlFor={`${formId}-${row.rowId}-note`}>
            Wiring detail (internal only)
            <textarea
              id={`${formId}-${row.rowId}-note`}
              value={row.note}
              onChange={(event) => onChange({ ...row, note: event.target.value })}
              style={{ ...INPUT_STYLE, minHeight: 56, resize: 'vertical' }}
              placeholder="RTU enclosure location, lock combo, controller notes..."
            />
          </label>
          {errorFor(`${row.rowId}.note`) ? <FieldError message={errorFor(`${row.rowId}.note`)!} /> : null}
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={row.internalConfirmed}
              onChange={(event) => onChange({ ...row, internalConfirmed: event.target.checked })}
              style={{ marginTop: 3 }}
            />
            <span>
              I confirm this wiring note is <strong>internal</strong>: it will never appear in public APIs, thumbnails, exports or
              reports (FR-049).
            </span>
          </label>
          {errorFor(`${row.rowId}.internalConfirmed`) ? <FieldError message={errorFor(`${row.rowId}.internalConfirmed`)!} /> : null}
        </>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <label style={LABEL_STYLE} htmlFor={`${formId}-${row.rowId}-captureDate`}>
          Captured (date)
          <input
            id={`${formId}-${row.rowId}-captureDate`}
            value={row.captureDate}
            onChange={(event) => onChange({ ...row, captureDate: event.target.value })}
            style={INPUT_STYLE}
            placeholder="YYYY-MM-DD"
            inputMode="numeric"
            autoComplete="off"
          />
        </label>
        <label style={LABEL_STYLE} htmlFor={`${formId}-${row.rowId}-captureTime`}>
          Captured (time)
          <input
            id={`${formId}-${row.rowId}-captureTime`}
            value={row.captureTime}
            onChange={(event) => onChange({ ...row, captureTime: event.target.value })}
            style={INPUT_STYLE}
            placeholder="HH:mm"
            inputMode="numeric"
            autoComplete="off"
          />
        </label>
        <label style={LABEL_STYLE} htmlFor={`${formId}-${row.rowId}-content`}>
          Content (placeholder)
          <input
            id={`${formId}-${row.rowId}-content`}
            value={row.content}
            onChange={(event) => onChange({ ...row, content: event.target.value })}
            style={INPUT_STYLE}
            placeholder="file bytes placeholder"
            autoComplete="off"
          />
        </label>
      </div>
      {errorFor(`${row.rowId}.captureDate`) ? <FieldError message={errorFor(`${row.rowId}.captureDate`)!} /> : null}
      {errorFor(`${row.rowId}.content`) ? <FieldError message={errorFor(`${row.rowId}.content`)!} /> : null}

      <button type="button" className="button small" onClick={onRemove} style={{ justifySelf: 'start' }}>
        Remove attachment
      </button>
    </fieldset>
  );
}

export default function VisitForm({ siteIds, siteNames = DEFAULT_SITE_NAMES, onSubmit, simulateNetworkFailure = false, now = '2026-03-12T16:00:00Z', draftId = 'form-1' }: VisitFormProps) {
  const [state, setState] = useState<VisitDraftState>(() => initialVisitDraft(EMPTY_VISIT_FORM, draftId));
  const [showErrors, setShowErrors] = useState(false);
  const formId = useId();
  const submit = onSubmit ?? makeDemoSubmit(simulateNetworkFailure);

  const siteOptions = siteIds ?? Object.keys(siteNames);
  const values = state.values;
  const errors = validateVisitForm(values);
  const errorFor = (field: string): string | undefined => (showErrors ? errors[field] : undefined);

  // The reducer owns status transitions: an edit keeps the explicit unsent
  // state (fixing a field before retry) and never touches a submitting form.
  const edit = (next: VisitFormValues) => setState((current) => visitDraftReducer(current, { type: 'edit', values: next }));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setShowErrors(true);
    if (Object.keys(errors).length > 0) return;
    const next = await submitVisitDraft(state, submit, now);
    setState(next);
  }

  async function handleRetry() {
    const next = await submitVisitDraft(state, submit, now);
    setState(next);
  }

  const toggleAction = (actionId: string, checked: boolean) => {
    const next = checked ? [...values.actionIds, actionId] : values.actionIds.filter((id) => id !== actionId);
    edit({ ...values, actionIds: next });
  };

  return (
    <form style={FORM_STYLE} onSubmit={handleSubmit} noValidate aria-label="Record a site visit">
      <h3 style={{ margin: 0, fontSize: 15 }}>Record a site visit</h3>

      <label style={LABEL_STYLE} htmlFor={`${formId}-siteId`}>
        Site
        <select id={`${formId}-siteId`} value={values.siteId} onChange={(event) => edit({ ...values, siteId: event.target.value })} style={INPUT_STYLE}>
          <option value="">Choose the site...</option>
          {siteOptions.map((siteId) => (
            <option key={siteId} value={siteId}>
              {siteNames[siteId] ?? siteId}
            </option>
          ))}
        </select>
      </label>
      {errorFor('siteId') ? <FieldError message={errorFor('siteId')!} /> : null}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={LABEL_STYLE} htmlFor={`${formId}-localDate`}>
          Visit date
          <input id={`${formId}-localDate`} value={values.localDate} onChange={(event) => edit({ ...values, localDate: event.target.value })} style={INPUT_STYLE} placeholder="2026-03-12" inputMode="numeric" autoComplete="off" />
        </label>
        <label style={LABEL_STYLE} htmlFor={`${formId}-localTime`}>
          Visit time (24h)
          <input id={`${formId}-localTime`} value={values.localTime} onChange={(event) => edit({ ...values, localTime: event.target.value })} style={INPUT_STYLE} placeholder="09:30" inputMode="numeric" autoComplete="off" />
        </label>
      </div>
      {(errorFor('localDate') ?? errorFor('localTime')) ? <FieldError message={errorFor('localDate') ?? errorFor('localTime') ?? ''} /> : null}

      <label style={LABEL_STYLE} htmlFor={`${formId}-offset`}>
        UTC offset during the visit
        <select id={`${formId}-offset`} value={values.offset} onChange={(event) => edit({ ...values, offset: event.target.value })} style={INPUT_STYLE}>
          {UTC_OFFSETS.map((offset) => (
            <option key={offset.id} value={offset.id}>
              {offset.label}
            </option>
          ))}
        </select>
      </label>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={LABEL_STYLE} htmlFor={`${formId}-type`}>
          Visit type
          <select id={`${formId}-type`} value={values.type} onChange={(event) => edit({ ...values, type: event.target.value as VisitFormValues['type'] })} style={INPUT_STYLE}>
            {VISIT_TYPES.map((type) => (
              <option key={type.id} value={type.id}>
                {type.label}
              </option>
            ))}
          </select>
        </label>
        <div>
          <span id={`${formId}-actions-label`} style={{ ...LABEL_STYLE, display: 'block' }}>
            Actions
          </span>
          <fieldset style={{ border: '1px solid #dce4de', borderRadius: 6, padding: '6px 8px', margin: 0 }} aria-labelledby={`${formId}-actions-label`}>
            {VISIT_ACTIONS.map((action) => (
              <label key={action.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, padding: '2px 0' }}>
                <input type="checkbox" checked={values.actionIds.includes(action.id)} onChange={(event) => toggleAction(action.id, event.target.checked)} />
                {action.label}
              </label>
            ))}
          </fieldset>
        </div>
      </div>
      {errorFor('actionIds') ? <FieldError message={errorFor('actionIds')!} /> : null}

      <label style={LABEL_STYLE} htmlFor={`${formId}-notes`}>
        Visit notes (internal)
        <textarea id={`${formId}-notes`} value={values.notes} onChange={(event) => edit({ ...values, notes: event.target.value })} style={{ ...INPUT_STYLE, minHeight: 56, resize: 'vertical' }} placeholder="Conditions, findings, follow-ups..." />
      </label>
      {errorFor('notes') ? <FieldError message={errorFor('notes')!} /> : null}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={LABEL_STYLE} htmlFor={`${formId}-lastCheckedDate`}>
          Last checked (date)
          <input id={`${formId}-lastCheckedDate`} value={values.lastCheckedDate} onChange={(event) => edit({ ...values, lastCheckedDate: event.target.value })} style={INPUT_STYLE} placeholder="YYYY-MM-DD" inputMode="numeric" autoComplete="off" />
        </label>
        <label style={LABEL_STYLE} htmlFor={`${formId}-lastRatedDate`}>
          Last rated (date)
          <input id={`${formId}-lastRatedDate`} value={values.lastRatedDate} onChange={(event) => edit({ ...values, lastRatedDate: event.target.value })} style={INPUT_STYLE} placeholder="YYYY-MM-DD" inputMode="numeric" autoComplete="off" />
        </label>
      </div>
      {(errorFor('lastCheckedDate') ?? errorFor('lastRatedDate')) ? <FieldError message={errorFor('lastCheckedDate') ?? errorFor('lastRatedDate') ?? ''} /> : null}
      <span style={{ fontSize: 11, color: '#5c6a60' }}>
        Structured inspection dates (FR-046): they stay queryable and survive equipment replacement. Leave blank when the visit did not
        check or rate.
      </span>

      {values.attachments.map((row, index) => (
        <AttachmentRow
          key={row.rowId}
          row={row}
          formId={formId}
          errorFor={(field) => errorFor(`attachments[${index}].${field.startsWith(row.rowId) ? field.slice(row.rowId.length + 1) : field}`)}
          onChange={(next) => edit({ ...values, attachments: values.attachments.map((candidate) => (candidate.rowId === row.rowId ? next : candidate)) })}
          onRemove={() => edit({ ...values, attachments: values.attachments.filter((candidate) => candidate.rowId !== row.rowId) })}
        />
      ))}
      <button type="button" className="button small" onClick={() => edit({ ...values, attachments: [...values.attachments, newAttachmentRow('photo')] })} style={{ justifySelf: 'start' }}>
        Add attachment
      </button>

      <button type="submit" style={BUTTON_STYLE} disabled={state.status === 'submitting'}>
        {state.status === 'submitting' ? 'Sending...' : 'Record visit'}
      </button>

      {state.status === 'unsent' && (
        <div role="alert" style={UNSENT_STYLE} aria-live="assertive">
          <strong>⚠ Not sent.</strong> The complete visit form is preserved below - nothing was lost and nothing was partially
          submitted.
          <br />
          {state.lastError}
          <br />
          <span style={{ fontSize: 12 }}>Attempt{state.attempts === 1 ? '' : 's'}: {state.attempts} · first failed at {state.unsentSince}</span>
          <br />
          <button type="button" style={RETRY_STYLE} onClick={handleRetry}>
            Retry sending
          </button>
        </div>
      )}

      {state.status === 'sent' && (
        <div role="status" style={NOTICE_STYLE} aria-live="polite">
          <span aria-hidden>✓</span> Visit recorded. Record identifier: <code>{state.sentVisitId}</code>.
          {state.sentReplayed ? ' (The server returned the already-recorded visit - no duplicate was created.)' : ''}
          <br />
          <button type="button" className="button small" style={{ marginTop: 8 }} onClick={() => setState(visitDraftReducer(state, { type: 'reset', values: EMPTY_VISIT_FORM, draftId: 'form-2' }))}>
            Record another visit
          </button>
        </div>
      )}
    </form>
  );
}

/** Exported for the shell/tests: compose the submit body from current values. */
export { composeSubmitBody };
