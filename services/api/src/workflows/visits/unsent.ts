/**
 * The unsent-form state model for visit submission (WD-012).
 *
 * ACCEPTANCE (FR-026 + the WD-012 task): "network errors preserve an
 * explicit unsent form state" - a failed submit (injected transport error)
 * preserves the COMPLETE form state with an explicit "unsent" status and a
 * retry; no silent loss, no partial submission.
 *
 * Design:
 * - The submit is ALL-OR-NOTHING at this layer. The transport either
 *   returns 'sent' (the server recorded the visit and returned its id) or
 *   'transport-error' (the request never landed). There is no state in
 *   between: a transport error leaves the visit store untouched and the
 *   form values byte-identical - the SAME object reference is carried into
 *   the unsent state, so equality is reference-stable, not just deep.
 * - Retry resubmits the complete preserved form with the SAME idempotency
 *   key, so even if the failed request had in fact reached the server (a
 *   classic timeout ambiguity), the replay returns the recorded visit
 *   instead of appending a duplicate (see the idempotency ledger in
 *   store.ts).
 * - Every attempt is counted and every failure message preserved; the user
 *   can edit the unsent form (fixing a field) without losing anything else,
 *   and only an explicit reset clears it.
 *
 * RELOAD-SAFE PERSISTENCE IS R2 (FR-027 offline field capture and
 * synchronization): this module keeps the unsent draft in memory only.
 * The R2 task adds the scoped IndexedDB queue (draft UUID, actor, site,
 * device timestamp/zone, capture time, base revision, attachment
 * manifests) with queued/syncing/accepted/conflict/rejected states,
 * identity revalidation at synchronization, and sensitive-data expiry.
 * What ships here is the state machine that layer will drive.
 *
 * Pure module: no React, no DOM, no clock reads, no storage I/O. `at` is
 * always an argument; identical inputs produce identical outputs.
 */

/** Lifecycle of one visit draft. */
export type VisitDraftStatus = 'editing' | 'submitting' | 'sent' | 'unsent';

/**
 * The state of one visit draft. `values` is generic: the web feature binds
 * it to its form model (visitModel.ts), the server-side tests bind it to
 * CreateVisitInput; the invariants below hold for any shape.
 */
export interface VisitDraftState<T> {
  readonly status: VisitDraftStatus;
  /** The COMPLETE form state; preserved verbatim through failure and retry. */
  readonly values: T;
  /** Failed submit attempts (incremented on each transport error). */
  readonly attempts: number;
  /** Last transport error message; null until a failure occurs. */
  readonly lastError: string | null;
  /** When the draft entered the unsent state; null otherwise. */
  readonly unsentSince: string | null;
  /** Server visit id after a successful send; null otherwise. */
  readonly sentVisitId: string | null;
  /** When the draft was successfully sent; null otherwise. */
  readonly sentAt: string | null;
  /** True when the server replayed the recorded visit instead of appending (idempotent retry). */
  readonly sentReplayed: boolean;
  /** Stable idempotency key for this draft: retries reuse it exactly. */
  readonly idempotencyKey: string;
}

export function initialVisitDraft<T>(values: T, draftId: string): VisitDraftState<T> {
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

export type VisitDraftEvent<T> =
  /** Values changed while editing or unsent (never while submitting). */
  | { readonly type: 'edit'; readonly values: T }
  /** Submission started (from editing or unsent-retry). */
  | { readonly type: 'submit-start'; readonly at: string }
  /** The server accepted the visit. */
  | { readonly type: 'submit-sent'; readonly visitId: string; readonly at: string; readonly replayed?: boolean }
  /** The transport failed: the draft becomes UNSENT with everything preserved. */
  | { readonly type: 'submit-failed'; readonly message: string; readonly at: string }
  /** Explicit clear after success (or explicit discard of an unsent draft). */
  | { readonly type: 'reset'; readonly values: T; readonly draftId: string };

export function visitDraftReducer<T>(state: VisitDraftState<T>, event: VisitDraftEvent<T>): VisitDraftState<T> {
  switch (event.type) {
    case 'edit': {
      if (state.status === 'submitting' || state.status === 'sent') return state;
      // Editing an unsent draft fixes values without losing the error trail.
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
        // The values stay visible after success until an explicit reset, so
        // the engineer can read back exactly what was recorded.
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
        // `values` is carried over BY REFERENCE: the same frozen object,
        // nothing rebuilt, nothing lost. `unsentSince` preserves when the
        // draft FIRST became unsent, across repeated failed retries.
        values: state.values,
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

// ---------------------------------------------------------------------------
// Transport runner
// ---------------------------------------------------------------------------

/** The all-or-nothing transport contract: sent (with the server's visit id) or transport-error. */
export type VisitTransportResult =
  | { readonly kind: 'sent'; readonly visitId: string; readonly replayed: boolean }
  | { readonly kind: 'transport-error'; readonly message: string };

/**
 * The transport port. Implementations call the API; tests inject errors.
 * The idempotency key travels with every call so a retry after an ambiguous
 * failure can never double-append.
 */
export type VisitTransport<T> = (values: T, idempotencyKey: string) => VisitTransportResult | Promise<VisitTransportResult>;

/**
 * Run one submission attempt through the state machine. On a transport
 * error the returned state is 'unsent' with the complete preserved form;
 * on success it is 'sent' with the server visit id.
 */
export async function submitVisitDraft<T>(
  state: VisitDraftState<T>,
  transport: VisitTransport<T>,
  at: string,
): Promise<VisitDraftState<T>> {
  if (state.status === 'submitting' || state.status === 'sent') return state;
  const submitting = visitDraftReducer(state, { type: 'submit-start', at });
  let result: VisitTransportResult;
  try {
    result = await transport(state.values, state.idempotencyKey);
  } catch (error) {
    // A thrown transport (network layer) is the same as a reported error:
    // the draft becomes unsent, nothing is lost, no partial submission.
    const message = error instanceof Error ? error.message : String(error);
    return visitDraftReducer(submitting, { type: 'submit-failed', message: `network error: ${message}`, at });
  }
  if (result.kind === 'sent') {
    return visitDraftReducer(submitting, { type: 'submit-sent', visitId: result.visitId, at, replayed: result.replayed });
  }
  return visitDraftReducer(submitting, { type: 'submit-failed', message: result.message, at });
}

// ---------------------------------------------------------------------------
// What the R2 persistence layer will store (documented, not implemented)
// ---------------------------------------------------------------------------

/**
 * The persistence envelope the R2 offline task (FR-027) will write to the
 * scoped IndexedDB queue for drafts in the 'unsent' state. Declared here so
 * the state machine's output is already the right shape; serializing it is
 * explicitly OUT of scope for WD-012 (in-memory only).
 */
export interface UnsentDraftEnvelope<T> {
  readonly draftId: string;
  readonly actorId: string;
  readonly siteId: string;
  readonly idempotencyKey: string;
  readonly deviceTimestamp: string;
  readonly deviceZone: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly unsentSince: string;
  readonly values: T;
}

/** Build (without persisting) the R2 envelope of an unsent draft; null unless the draft is unsent. */
export function unsentEnvelopeOf<T>(
  state: VisitDraftState<T>,
  meta: { draftId: string; actorId: string; siteId: string; deviceZone: string },
): UnsentDraftEnvelope<T> | null {
  if (state.status !== 'unsent' || state.unsentSince === null) return null;
  return {
    draftId: meta.draftId,
    actorId: meta.actorId,
    siteId: meta.siteId,
    idempotencyKey: state.idempotencyKey,
    deviceTimestamp: state.unsentSince,
    deviceZone: meta.deviceZone,
    attempts: state.attempts,
    lastError: state.lastError,
    unsentSince: state.unsentSince,
    values: state.values,
  };
}
