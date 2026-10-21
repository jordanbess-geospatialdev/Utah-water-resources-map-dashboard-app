/**
 * visitModel - the pure form/history models for the WD-012 visits feature
 * (FR-026 responsive entry, FR-046 visit history, FR-049 attachment
 * visibility).
 *
 * MIRROR CONTRACT: the unsent state machine and the validation verdicts
 * mirror services/api/src/workflows/visits/{unsent,visits}.ts. The test
 * loads the REAL server modules at runtime (the established dynamic-import
 * pattern from features/operations and features/data-entry) and asserts
 * identical outcomes on the same sequences - any divergence found there is
 * a defect in this mirror and must be fixed here, not in the tests.
 *
 * The browser model is client-side only: the SERVER re-validates and owns
 * the policy decisions. Internal attachments are filtered here purely for
 * presentation; the authoritative wall is the API projection
 * (publicAttachmentViews / internalAttachmentList) and the storage checks.
 *
 * Deterministic: no clock reads (now is an argument), no randomness, no
 * Intl/tzdata. Mobile-first: the models are shape-agnostic to layout.
 */

// ---------------------------------------------------------------------------
// Vocabulary (mirrors the server's governed enums)
// ---------------------------------------------------------------------------

export type VisitType = 'inspection' | 'maintenance' | 'measurement' | 'other';

export type AttachmentCategory = 'photo' | 'wiring-note' | 'document' | 'audio';

export type AttachmentVisibility = 'public' | 'internal';

export const VISIT_TYPES: ReadonlyArray<{ id: VisitType; label: string }> = [
  { id: 'inspection', label: 'Inspection' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'measurement', label: 'Measurement' },
  { id: 'other', label: 'Other' },
];

export const VISIT_ACTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'measurement-taken', label: 'Measurement taken' },
  { id: 'gauge-inspection', label: 'Gauge inspection' },
  { id: 'rating-verification', label: 'Rating verification' },
  { id: 'equipment-maintenance', label: 'Equipment maintenance' },
  { id: 'sensor-replacement', label: 'Sensor replacement' },
  { id: 'battery-replacement', label: 'Battery replacement' },
  { id: 'site-cleanup', label: 'Site cleanup' },
  { id: 'other', label: 'Other' },
];

export const ATTACHMENT_CATEGORIES: ReadonlyArray<{ id: AttachmentCategory; label: string }> = [
  { id: 'photo', label: 'Photo' },
  { id: 'wiring-note', label: 'Wiring note (internal only)' },
  { id: 'document', label: 'Document' },
  { id: 'audio', label: 'Audio note' },
];

export const ATTACHMENT_VISIBILITIES: ReadonlyArray<{ id: AttachmentVisibility; label: string }> = [
  { id: 'public', label: 'Public' },
  { id: 'internal', label: 'Internal' },
];

export const UTC_OFFSETS = [
  { id: '-07:00', label: 'MST (UTC-07:00)' },
  { id: '-06:00', label: 'MDT (UTC-06:00)' },
  { id: 'Z', label: 'UTC (Z)' },
] as const;

/** A wiring note can never be public (server rejects it; the UI locks it). */
export function isWiringNote(category: AttachmentCategory): boolean {
  return category === 'wiring-note';
}

// ---------------------------------------------------------------------------
// Form values
// ---------------------------------------------------------------------------

export interface AttachmentDraft {
  /** Stable row id (client-side only). */
  readonly rowId: string;
  readonly category: AttachmentCategory;
  readonly visibility: AttachmentVisibility;
  readonly filename: string;
  /** Capture time, date + time + offset composed like the visit time. */
  readonly captureDate: string;
  readonly captureTime: string;
  /** Category note (for wiring notes: the wiring/gate detail text). */
  readonly note: string;
  /**
   * Explicit confirmation that this INTERNAL attachment is intentional.
   * Required for wiring notes before the form can submit: the engineer
   * acknowledges the note stays behind the visibility wall.
   */
  readonly internalConfirmed: boolean;
  /**
   * Placeholder payload. The browser never persists attachment bytes
   * (WD-012); the server hashes content at attach. Size is derived.
   */
  readonly content: string;
}

export interface VisitFormValues {
  readonly siteId: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly offset: string;
  readonly type: VisitType;
  readonly actionIds: readonly string[];
  readonly notes: string;
  /** Structured lastChecked/lastRated dates (FR-046): date-only, optional. */
  readonly lastCheckedDate: string;
  readonly lastRatedDate: string;
  readonly attachments: readonly AttachmentDraft[];
}

let rowSequence = 0;
export function newAttachmentRow(category: AttachmentCategory = 'photo'): AttachmentDraft {
  rowSequence += 1;
  return {
    rowId: `att-row-${String(rowSequence)}`,
    category,
    visibility: category === 'wiring-note' ? 'internal' : 'public',
    filename: '',
    captureDate: '',
    captureTime: '',
    note: '',
    internalConfirmed: false,
    content: '',
  };
}

export const EMPTY_VISIT_FORM: VisitFormValues = {
  siteId: '',
  localDate: '',
  localTime: '',
  offset: '-07:00',
  type: 'inspection',
  actionIds: [],
  notes: '',
  lastCheckedDate: '',
  lastRatedDate: '',
  attachments: [],
};

// ---------------------------------------------------------------------------
// Time composition (explicit offset, mirroring the manual-entry pattern)
// ---------------------------------------------------------------------------

function parseDateCell(raw: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

function parseTimeCell(raw: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function parseOffsetCell(raw: string): number | null {
  if (raw === 'Z') return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/** Compose date + time + offset into an ISO instant (null when unparseable). */
export function composeInstant(date: string, time: string, offset: string): string | null {
  const d = parseDateCell(date);
  const t = parseTimeCell(time === '' ? '00:00' : time);
  const o = parseOffsetCell(offset);
  if (!d || !t || o === null) return null;
  const epochMs = Date.UTC(d.year, d.month - 1, d.day, t.hour, t.minute, 0) - o * 60_000;
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Validation (mirror of the server's 422 verdicts, client-side)
// ---------------------------------------------------------------------------

export interface FormFieldErrors {
  readonly [fieldPath: string]: string;
}

export function validateVisitForm(values: VisitFormValues): FormFieldErrors {
  const errors: Record<string, string> = {};
  if (!values.siteId) errors.siteId = 'Choose the site this visit documents.';
  if (!values.localDate) errors.localDate = 'Visit date is required (YYYY-MM-DD).';
  else if (!parseDateCell(values.localDate)) errors.localDate = 'Visit date must be YYYY-MM-DD.';
  if (!values.localTime) errors.localTime = 'Visit time is required (HH:mm, 24-hour).';
  else if (!parseTimeCell(values.localTime)) errors.localTime = 'Visit time must be HH:mm (24-hour clock).';
  if (!values.offset) errors.offset = 'Choose the UTC offset in effect during the visit.';
  if (!VISIT_TYPES.some((candidate) => candidate.id === values.type)) errors.type = 'Choose a visit type.';
  if (values.actionIds.length === 0) errors.actionIds = 'Record at least one measurement or maintenance action.';
  if (values.notes.length > 4000) errors.notes = 'Notes must be at most 4000 characters.';

  const visitInstant = composeInstant(values.localDate, values.localTime, values.offset);
  for (const [field, label] of [['lastCheckedDate', 'Last checked'], ['lastRatedDate', 'Last rated']] as const) {
    const date = values[field];
    if (date === '') continue;
    if (!parseDateCell(date)) {
      errors[field] = `${label} date must be YYYY-MM-DD.`;
      continue;
    }
    const instant = composeInstant(date, '00:00', values.offset);
    if (visitInstant !== null && instant !== null && Date.parse(instant) > Date.parse(visitInstant)) {
      errors[field] = `${label} date cannot be after the visit date.`;
    }
  }

  values.attachments.forEach((attachment, index) => {
    const at = (field: string) => `attachments[${index}].${field}`;
    if (isWiringNote(attachment.category)) {
      // The category is internal by policy (FR-049): the picker locks to
      // internal and an EXPLICIT confirmation is required before submit.
      if (attachment.visibility !== 'internal') errors[at('visibility')] = 'A wiring note can never be public (FR-049).';
      if (!attachment.internalConfirmed) errors[at('internalConfirmed')] = 'Confirm this wiring note stays internal before recording the visit.';
      if (attachment.note.trim() === '') errors[at('note')] = 'Enter the wiring detail text (it stays internal).';
    }
    if (attachment.filename.trim() === '') errors[at('filename')] = 'A filename is required.';
    else if (/[\\/]|\.\./.test(attachment.filename)) errors[at('filename')] = 'The filename must not contain path separators.';
    if (attachment.captureDate !== '' && !parseDateCell(attachment.captureDate)) errors[at('captureDate')] = 'Capture date must be YYYY-MM-DD.';
    const captureInstant =
      attachment.captureDate === '' ? null : composeInstant(attachment.captureDate, attachment.captureTime === '' ? '00:00' : attachment.captureTime, values.offset);
    if (captureInstant !== null && visitInstant !== null && Date.parse(captureInstant) > Date.parse(visitInstant)) {
      errors[at('captureDate')] = 'Capture time cannot be after the visit time.';
    }
    if (attachment.content.length === 0) errors[at('content')] = 'Choose a file (or paste placeholder content) so the server can hash it at attach.';
  });
  return errors;
}

/** The request body the form submits (server shape, attachments included). */
export interface VisitSubmitBody {
  readonly siteId: string;
  readonly visitTime: string;
  readonly type: VisitType;
  readonly actionIds: readonly string[];
  readonly notes: string;
  readonly lastChecked: string | null;
  readonly lastRated: string | null;
  readonly attachments: ReadonlyArray<{
    readonly category: AttachmentCategory;
    readonly visibility: AttachmentVisibility;
    readonly filename: string;
    readonly captureTime: string;
    readonly note?: string;
    readonly sizeBytes: number;
    readonly content: string;
  }>;
}

export function composeSubmitBody(values: VisitFormValues): VisitSubmitBody | null {
  const visitTime = composeInstant(values.localDate, values.localTime, values.offset);
  if (visitTime === null) return null;
  return {
    siteId: values.siteId,
    visitTime,
    type: values.type,
    actionIds: [...values.actionIds],
    notes: values.notes,
    lastChecked: values.lastCheckedDate === '' ? null : composeInstant(values.lastCheckedDate, '00:00', values.offset),
    lastRated: values.lastRatedDate === '' ? null : composeInstant(values.lastRatedDate, '00:00', values.offset),
    attachments: values.attachments.map((attachment) => ({
      category: attachment.category,
      visibility: attachment.visibility,
      filename: attachment.filename.trim(),
      captureTime: composeInstant(
        attachment.captureDate === '' ? values.localDate : attachment.captureDate,
        attachment.captureTime === '' ? values.localTime : attachment.captureTime,
        values.offset,
      ) ?? visitTime,
      sizeBytes: attachment.content.length,
      content: attachment.content,
      ...(attachment.note.trim() === '' ? {} : { note: attachment.note }),
    })),
  };
}

// ---------------------------------------------------------------------------
// Unsent state machine (mirror of services/.../visits/unsent.ts)
// ---------------------------------------------------------------------------

export type VisitDraftStatus = 'editing' | 'submitting' | 'sent' | 'unsent';

export interface VisitDraftState {
  readonly status: VisitDraftStatus;
  readonly values: VisitFormValues;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly unsentSince: string | null;
  readonly sentVisitId: string | null;
  readonly sentAt: string | null;
  readonly sentReplayed: boolean;
  readonly idempotencyKey: string;
}

export function initialVisitDraft(values: VisitFormValues, draftId: string): VisitDraftState {
  return {
    status: 'editing',
    values,
    attempts: 0,
    lastError: null,
    unsentSince: null,
    sentVisitId: null,
    sentAt: null,
    sentReplayed: false,
    idempotencyKey: `visit-draft-${draftId}`,
  };
}

export type VisitDraftEvent =
  | { readonly type: 'edit'; readonly values: VisitFormValues }
  | { readonly type: 'submit-start'; readonly at: string }
  | { readonly type: 'submit-sent'; readonly visitId: string; readonly at: string; readonly replayed?: boolean }
  | { readonly type: 'submit-failed'; readonly message: string; readonly at: string }
  | { readonly type: 'reset'; readonly values: VisitFormValues; readonly draftId: string };

export function visitDraftReducer(state: VisitDraftState, event: VisitDraftEvent): VisitDraftState {
  switch (event.type) {
    case 'edit': {
      if (state.status === 'submitting' || state.status === 'sent') return state;
      return { ...state, status: state.status === 'unsent' ? 'unsent' : 'editing', values: event.values };
    }
    case 'submit-start': {
      if (state.status === 'submitting' || state.status === 'sent') return state;
      return { ...state, status: 'submitting' };
    }
    case 'submit-sent': {
      return {
        ...state,
        status: 'sent',
        sentVisitId: event.visitId,
        sentAt: event.at,
        sentReplayed: event.replayed === true,
        lastError: null,
        unsentSince: null,
      };
    }
    case 'submit-failed': {
      if (state.status !== 'submitting') return state;
      return {
        ...state,
        status: 'unsent',
        values: state.values, // carried by reference: nothing rebuilt, nothing lost
        attempts: state.attempts + 1,
        lastError: event.message,
        unsentSince: state.unsentSince ?? event.at,
      };
    }
    case 'reset':
      return initialVisitDraft(event.values, event.draftId);
    default:
      return state;
  }
}

export type VisitTransportResult =
  | { readonly kind: 'sent'; readonly visitId: string; readonly replayed: boolean }
  | { readonly kind: 'transport-error'; readonly message: string };

export type VisitTransport = (values: VisitFormValues, idempotencyKey: string) => VisitTransportResult | Promise<VisitTransportResult>;

/** Run one submission attempt through the state machine (all-or-nothing). */
export async function submitVisitDraft(
  state: VisitDraftState,
  transport: VisitTransport,
  at: string,
): Promise<VisitDraftState> {
  if (state.status === 'submitting' || state.status === 'sent') return state;
  const submitting = visitDraftReducer(state, { type: 'submit-start', at });
  let result: VisitTransportResult;
  try {
    result = await transport(state.values, state.idempotencyKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return visitDraftReducer(submitting, { type: 'submit-failed', message: `network error: ${message}`, at });
  }
  if (result.kind === 'sent') {
    return visitDraftReducer(submitting, { type: 'submit-sent', visitId: result.visitId, at, replayed: result.replayed });
  }
  return visitDraftReducer(submitting, { type: 'submit-failed', message: result.message, at });
}

// ---------------------------------------------------------------------------
// History projection (visibility-filtered per acting persona)
// ---------------------------------------------------------------------------

/** One attachment as the history panel renders it. */
export interface HistoryAttachment {
  readonly id: string;
  readonly category: AttachmentCategory;
  readonly visibility: AttachmentVisibility;
  readonly filename: string;
  readonly thumbnailPath: string | null;
}

/** One visit as the history panel renders it. */
export interface HistoryVisit {
  readonly id: string;
  readonly siteId: string;
  readonly actorId: string;
  readonly actorName: string;
  /** VISIT time (on site). */
  readonly visitTime: string;
  /** RECORDED time (when the visit landed). */
  readonly recordedAt: string;
  readonly type: VisitType;
  readonly actionIds: readonly string[];
  readonly notes: string | null;
  readonly lastChecked: string | null;
  readonly lastRated: string | null;
  readonly attachments: readonly HistoryAttachment[];
  readonly hiddenAttachmentCount: number;
}

/**
 * Project history rows for the acting persona. Semantics follow the API
 * projection helpers: without the internal capability the panel shows the
 * PUBLIC projection (no notes, no actor ids, public attachments only, and
 * NO count of hidden internal attachments); with the capability the
 * engineer view keeps actor, notes and internal attachment rows.
 */
export function projectHistoryVisits(
  visits: readonly HistoryVisit[],
  options: { readonly includeInternal: boolean },
): readonly HistoryVisit[] {
  return visits.map((visit) => {
    if (options.includeInternal) return visit;
    const publicAttachments = visit.attachments.filter((attachment) => attachment.visibility === 'public');
    return {
      ...visit,
      actorId: '',
      actorName: 'Field staff',
      notes: null,
      attachments: publicAttachments,
      hiddenAttachmentCount: 0, // no existence hint in the public projection
    };
  });
}

/** Structured inspection summary derived from history rows (FR-046). */
export interface HistorySummary {
  readonly siteId: string;
  readonly visitCount: number;
  readonly lastVisitTime: string | null;
  readonly lastChecked: string | null;
  readonly lastRated: string | null;
}

export function summarizeHistory(siteId: string, visits: readonly HistoryVisit[]): HistorySummary {
  let lastVisitTime: string | null = null;
  let lastChecked: string | null = null;
  let lastRated: string | null = null;
  let lastCheckedAt = Number.NEGATIVE_INFINITY;
  let lastRatedAt = Number.NEGATIVE_INFINITY;
  for (const visit of visits) {
    const at = Date.parse(visit.visitTime);
    if (lastVisitTime === null || at >= Date.parse(lastVisitTime)) lastVisitTime = visit.visitTime;
    if (visit.lastChecked !== null && at >= lastCheckedAt) {
      lastChecked = visit.lastChecked;
      lastCheckedAt = at;
    }
    if (visit.lastRated !== null && at >= lastRatedAt) {
      lastRated = visit.lastRated;
      lastRatedAt = at;
    }
  }
  return { siteId, visitCount: visits.length, lastVisitTime, lastChecked, lastRated };
}

/** Structured-date query: sites whose lastChecked is absent or before the cutoff. */
export function notInspectedSince(
  sites: ReadonlyArray<{ readonly siteId: string; readonly visits: readonly HistoryVisit[] }>,
  cutoffInstant: string,
): readonly string[] {
  return sites
    .filter((site) => {
      const lastChecked = summarizeHistory(site.siteId, site.visits).lastChecked;
      return lastChecked === null || Date.parse(lastChecked) < Date.parse(cutoffInstant);
    })
    .map((site) => site.siteId)
    .sort();
}

/** Human labels for governed actions. */
export function actionLabel(actionId: string): string {
  return VISIT_ACTIONS.find((action) => action.id === actionId)?.label ?? actionId;
}
