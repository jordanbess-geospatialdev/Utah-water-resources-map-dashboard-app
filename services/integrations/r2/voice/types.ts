/**
 * Type vocabulary for the FR-047 voice-note draft model (WD-023-R2).
 *
 * Source of truth: docs/product/baseline/01-product-requirements.md FR-047
 * ("A user records a note and optionally requests an approved transcription
 * or summary; the user reviews it before saving, original media follows
 * retention policy, and no AI text changes measurements or inspection
 * status automatically") and the ratified stub-only contract in
 * docs/extensions/r2/R2-EXTENSIONS-SCOPE.md:
 *
 *  - the draft model: an audio attachment reference WITH its retention
 *    class (the WD-012 attachment wall applies - audio is an 'audio'
 *    category attachment, internal visibility by default), a transcript
 *    draft carrying provenance, and a review-required state machine
 *    (requested -> reviewed -> saved);
 *  - the transcript is an editable DRAFT the user must review before save;
 *    SAVE is the only path to any official record;
 *  - no AI text ever changes measurements or inspection status: the only
 *    official artifact a reviewed transcript can become is a voice-note
 *    attachment descriptor (officialTranscriptAttachment) - the module has
 *    no function that writes observations, revisions or inspection state,
 *    and the descriptor carries no measurement or inspection field.
 *
 * STUB-ONLY boundary (NFR-010): provider selection and the privacy review
 * precede any external processing; no network code may exist anywhere in
 * the r2 tree (statically scanned in test/voice.test.ts). The
 * TranscriptionProvider interface in transcription.ts is the seam.
 *
 * Pure domain types only: no HTTP framework, no I/O, no clock reads.
 */
import type { RetentionClass } from '../../../../services/api/src/workflows/visits/types.ts';

/** Retention vocabulary re-exported from the WD-012 attachment wall (single source of truth). */
export type { RetentionClass };

/**
 * Review-required lifecycle of a voice note (scope contract, verbatim
 * states). 'requested' - the note exists and transcription has been
 * requested (the draft may still be provider-pending); 'reviewed' - the user
 * finished editing the draft and the reviewer actor is recorded; 'saved' -
 * the reviewed transcript was saved, which is the ONLY state that ever
 * reaches an official record.
 */
export type VoiceNoteState = 'requested' | 'reviewed' | 'saved';

/** Permitted visibility of the audio media (WD-012 attachment wall). */
export type VoiceNoteVisibility = 'public' | 'internal';

/**
 * The audio media reference. Audio is a WD-012 'audio' category attachment:
 * the bytes never enter this model, only the storage placeholder reference,
 * the capture time and the RETENTION CLASS the original media follows
 * (FR-047 "original media follows retention policy").
 */
export interface VoiceAudioAttachment {
  /** Storage placeholder reference (`placeholder://attachments/<id>`); the WD-012 wall governs every read. */
  readonly attachmentRef: string;
  /** Capture time: when the audio was recorded (distinct from the note's recorded time). */
  readonly captureTime: string;
  /** Retention class recorded at attach; the media follows this policy. */
  readonly retentionClass: RetentionClass;
  /** sha256 of the audio bytes recorded at attach, when the storage layer provided one. */
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  /** Attachment visibility; INTERNAL by default (the wall's default-deny side). */
  readonly visibility: VoiceNoteVisibility;
}

/**
 * Provenance every transcript draft carries: which provider produced it,
 * when it was requested and completed, and the correlation id tying the
 * draft to its request (deterministic for the stub).
 */
export interface TranscriptProvenance {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly correlationId: string;
}

/**
 * The editable transcript DRAFT (never an official record by itself).
 * `providerPending` marks a stub (or not-yet-approved provider) draft whose
 * text is empty pending provider selection; the user reviews and edits the
 * text before it can be saved.
 */
export interface TranscriptDraft {
  readonly noteId: string;
  readonly text: string;
  readonly providerPending: boolean;
  readonly provenance: TranscriptProvenance;
}

/**
 * A voice note: audio attachment + transcript draft + review state. VISIT-
 * style recorded time is injected by the caller; the model never reads a
 * clock.
 */
export interface VoiceNote {
  readonly id: string;
  readonly siteId: string;
  /** The acting user who recorded the note (and the default reviewer candidate). */
  readonly actorId: string;
  /** RECORDED time: when the note was created (injected clock). */
  readonly recordedAt: string;
  readonly audio: VoiceAudioAttachment;
  readonly transcript: TranscriptDraft | null;
  readonly state: VoiceNoteState;
  /** Reviewer actor recorded on the review transition; REQUIRED before any save. */
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly savedAt: string | null;
}

/**
 * The official artifact a SAVED (or fully reviewed) transcript may become:
 * a voice-note attachment descriptor for a visit/inspection record. It
 * carries text + provenance + reviewer only - deliberately NO measurement,
 * qualifier or inspection-status field, so no AI text can ever change one
 * (FR-047 / NFR-010).
 */
export interface OfficialVoiceTranscriptAttachment {
  readonly kind: 'voice-note-transcript';
  readonly noteId: string;
  readonly siteId: string;
  readonly text: string;
  readonly providerId: string;
  readonly providerPending: boolean;
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly savedAt: string;
  /** Internal-class by policy: a transcript never enters a public projection. */
  readonly visibility: 'internal';
  readonly retentionClass: RetentionClass;
  readonly correlationId: string;
}

/**
 * Thrown when a transcript that has not completed review (state 'reviewed'
 * with a recorded reviewer actor) tries to attach to any official record.
 * The review wall is enforced at EVERY attach path.
 */
export class ReviewRequiredError extends Error {
  readonly code = 'REVIEW_REQUIRED';
  readonly noteId: string;
  readonly state: VoiceNoteState;

  constructor(noteId: string, state: VoiceNoteState, message: string) {
    super(message);
    this.name = 'ReviewRequiredError';
    this.noteId = noteId;
    this.state = state;
  }
}

/** Thrown on an invalid lifecycle transition (e.g. saving twice, reviewing before a draft exists). */
export class VoiceTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION';
  readonly noteId: string;
  readonly from: VoiceNoteState;
  readonly to: VoiceNoteState;

  constructor(noteId: string, from: VoiceNoteState, to: VoiceNoteState, message: string) {
    super(message);
    this.name = 'VoiceTransitionError';
    this.noteId = noteId;
    this.from = from;
    this.to = to;
  }
}
