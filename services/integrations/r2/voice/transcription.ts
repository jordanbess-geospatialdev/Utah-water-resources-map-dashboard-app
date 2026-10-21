/**
 * FR-047 transcription seam + review-required lifecycle (WD-023-R2).
 *
 * TranscriptionProvider is the INTERFACE ONLY. Provider selection and the
 * NFR-010 state-policy privacy review precede any external processing of
 * internal audio/text; until the owners approve a provider, the single
 * implementation is DeterministicStubProvider, which returns an EMPTY
 * transcript labeled provider-pending. There is deliberately no network
 * transport anywhere in this tree (statically scanned by the test suite);
 * a future approved provider plugs in behind this same synchronous,
 * offline-shaped seam without touching the draft model or the review wall.
 *
 * Review-required enforcement (the FR-047 wall):
 *  - officialTranscriptAttachment() is the ONLY function that produces an
 *    official artifact from a transcript, and it throws ReviewRequiredError
 *    unless the note reached state 'reviewed' with the reviewer actor
 *    recorded (state 'saved' passes too - saving requires a completed
 *    review by construction);
 *  - saveReviewedTranscript() performs the same wall check before saving;
 *    SAVE is the only path from 'reviewed' to 'saved';
 *  - no function in this module accepts or returns a measurement,
 *    qualifier or inspection-status field: no AI text can change one.
 */
import {
  ReviewRequiredError,
  VoiceTransitionError,
  type OfficialVoiceTranscriptAttachment,
  type RetentionClass,
  type TranscriptDraft,
  type VoiceAudioAttachment,
  type VoiceNote,
  type VoiceNoteVisibility,
} from './types.ts';

export type { RetentionClass } from './types.ts';

// ---------------------------------------------------------------------------
// The provider seam
// ---------------------------------------------------------------------------

/** What a provider is asked to transcribe. The audio BYTES never cross this seam - only the attachment reference. */
export interface TranscriptionRequest {
  readonly noteId: string;
  readonly audioRef: string;
  readonly captureTime: string;
  /** Injected request instant; the provider never reads a clock. */
  readonly requestedAt: string;
}

/**
 * The transcription seam (FR-047). Implementations MUST be deterministic
 * for identical requests and MUST NOT touch a network: none exists in this
 * tree (static scan), and none may exist before the NFR-010 state-policy
 * privacy review approves a provider. The synchronous, offline shape is
 * deliberate - a future approved provider enqueues work behind it without
 * the draft model or the review wall changing.
 */
export interface TranscriptionProvider {
  readonly providerId: string;
  readonly providerLabel: string;
  /** Produce a transcript DRAFT (never an official record; review always follows). */
  transcribe(request: TranscriptionRequest): TranscriptDraft;
}

/**
 * The deterministic local stub: returns an EMPTY transcript marked
 * provider-pending, labeled with its provenance. Same request -> deep-equal
 * draft, always (determinism test); it performs no I/O and touches no
 * network - none exists in this tree.
 */
export const DETERMINISTIC_STUB_PROVIDER: TranscriptionProvider = {
  providerId: 'deterministic-stub',
  providerLabel: 'Deterministic stub (provider pending selection)',
  transcribe(request) {
    return {
      noteId: request.noteId,
      text: '',
      providerPending: true,
      provenance: {
        providerId: 'deterministic-stub',
        providerLabel: 'Deterministic stub (provider pending selection)',
        requestedAt: request.requestedAt,
        completedAt: request.requestedAt,
        correlationId: `stub-${request.noteId}`,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Lifecycle (state machine: requested -> reviewed -> saved)
// ---------------------------------------------------------------------------

let sequence = 0;

/**
 * Create a voice note in state 'requested': audio attached with its
 * retention class and (internal-by-default) visibility, no transcript yet.
 * Identifiers derive from the injected id prefix + an append sequence, so
 * two runs with the same inputs produce the same ids (determinism).
 */
export function createVoiceNote(input: {
  siteId: string;
  actorId: string;
  /** Injected recorded time (UTC instant); never read from a clock here. */
  recordedAt: string;
  /** Storage placeholder reference for the audio bytes (WD-012 wall governs reads). */
  audioAttachmentRef: string;
  captureTime: string;
  retentionClass: RetentionClass;
  sha256?: string | null;
  sizeBytes?: number | null;
  /** WD-012 wall default: internal. Public audio requires an explicit, deliberate choice. */
  visibility?: VoiceNoteVisibility;
}): VoiceNote {
  sequence += 1;
  const audio: VoiceAudioAttachment = {
    attachmentRef: input.audioAttachmentRef,
    captureTime: input.captureTime,
    retentionClass: input.retentionClass,
    sha256: input.sha256 ?? null,
    sizeBytes: input.sizeBytes ?? null,
    visibility: input.visibility ?? 'internal',
  };
  return {
    id: `voice-note-${String(1000 + sequence)}`,
    siteId: input.siteId,
    actorId: input.actorId,
    recordedAt: input.recordedAt,
    audio,
    transcript: null,
    state: 'requested',
    reviewedBy: null,
    reviewedAt: null,
    savedAt: null,
  };
}

/**
 * Explicitly request transcription (FR-047 "optionally requests"). Attaches
 * the provider's draft; the note STAYS in 'requested' - a draft is never an
 * official record, and provider-pending drafts are clearly labeled.
 */
export function requestTranscription(note: VoiceNote, provider: TranscriptionProvider, requestedAt: string): VoiceNote {
  if (note.state !== 'requested' || note.transcript !== null) {
    throw new VoiceTransitionError(note.id, note.state, 'requested', 'transcription is requested exactly once, while the note is still an unreviewed request');
  }
  const draft: TranscriptDraft = provider.transcribe({
    noteId: note.id,
    audioRef: note.audio.attachmentRef,
    captureTime: note.audio.captureTime,
    requestedAt,
  });
  return { ...note, transcript: draft };
}

/**
 * The user reviewed (and possibly edited) the draft: records the REVIEWER
 * ACTOR - required before anything can be saved - and moves to 'reviewed'.
 * Editing the text is part of review: the draft is editable by design.
 */
export function reviewTranscript(
  note: VoiceNote,
  review: { reviewerId: string; reviewedAt: string; editedText?: string },
): VoiceNote {
  if (note.state !== 'requested' || note.transcript === null) {
    throw new VoiceTransitionError(note.id, note.state, 'reviewed', 'only a note with an attached draft can be reviewed');
  }
  return {
    ...note,
    state: 'reviewed',
    transcript: { ...note.transcript, text: review.editedText ?? note.transcript.text },
    reviewedBy: review.reviewerId,
    reviewedAt: review.reviewedAt,
  };
}

/**
 * The review wall: true only when the transcript completed review with a
 * recorded reviewer actor. Every official attach path consults this.
 */
export function reviewComplete(note: VoiceNote): boolean {
  return (note.state === 'reviewed' || note.state === 'saved') && note.reviewedBy !== null && note.transcript !== null;
}

function requireReview(note: VoiceNote): void {
  if (!reviewComplete(note)) {
    throw new ReviewRequiredError(
      note.id,
      note.state,
      'a transcript cannot attach to any official record until the user reviews it (state "reviewed" with a recorded reviewer actor)',
    );
  }
}

/**
 * SAVE - the only path from 'reviewed' to 'saved', and the only path to an
 * official artifact. Enforces the review wall first; returns the saved note
 * together with the official transcript attachment descriptor.
 */
export function saveReviewedTranscript(note: VoiceNote, savedAt: string): { note: VoiceNote; attachment: OfficialVoiceTranscriptAttachment } {
  requireReview(note);
  if (note.state !== 'reviewed') {
    throw new VoiceTransitionError(note.id, note.state, 'saved', 'only a reviewed transcript can be saved');
  }
  const transcript = note.transcript!;
  const saved: VoiceNote = { ...note, state: 'saved', savedAt };
  return { note: saved, attachment: officialTranscriptAttachment(saved) };
}

/**
 * The ONLY official artifact shape a transcript may take: an internal-class
 * voice-note attachment descriptor. Throws ReviewRequiredError at every
 * attach attempt that has not completed review. It carries text +
 * provenance + reviewer only - no measurement, qualifier or
 * inspection-status field exists on it (FR-047 / NFR-010).
 */
export function officialTranscriptAttachment(note: VoiceNote): OfficialVoiceTranscriptAttachment {
  requireReview(note);
  const transcript = note.transcript!;
  return {
    kind: 'voice-note-transcript',
    noteId: note.id,
    siteId: note.siteId,
    text: transcript.text,
    providerId: transcript.provenance.providerId,
    providerPending: transcript.providerPending,
    reviewedBy: note.reviewedBy!,
    reviewedAt: note.reviewedAt!,
    savedAt: note.savedAt ?? '',
    visibility: 'internal',
    retentionClass: note.audio.retentionClass,
    correlationId: transcript.provenance.correlationId,
  };
}
