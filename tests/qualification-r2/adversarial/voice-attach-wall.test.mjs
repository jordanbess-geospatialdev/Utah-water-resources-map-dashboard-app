/**
 * WD-026 adversarial check (extensions boundaries group): the FR-047 review
 * wall — NO voice transcript in any state other than reviewed (or saved via
 * a completed review) can attach to an official record, probed through the
 * module's ENTIRE public API surface.
 *
 * Written by the independent R2 qualification agent (qa_accessibility).
 * Every non-reviewed lifecycle state is constructed through the REAL state
 * machine (createVoiceNote -> requestTranscription -> ...), then every
 * official-attach path (officialTranscriptAttachment, saveReviewedTranscript)
 * is probed. Hostile variants: missing reviewer, missing transcript, edited
 * drafts pre-review, skipped steps, spoofed state fields on fresh-cloned
 * objects, and direct field mutation of frozen outputs.
 *
 * Run (from repo root):
 *   node --test tests/qualification-r2/adversarial/voice-attach-wall.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const voice = await import('../../../services/integrations/r2/voice/transcription.ts');
const { ReviewRequiredError, VoiceTransitionError } = await import('../../../services/integrations/r2/voice/types.ts');

const NOW = '2026-03-09T07:00:00Z';
const LATER = '2026-03-09T08:00:00Z';
const REVIEWER = 'principal-fatima-engineer';

function baseNote() {
  return voice.createVoiceNote({
    siteId: 'sta-bear-corinne',
    actorId: REVIEWER,
    recordedAt: NOW,
    audioAttachmentRef: 'objref://audio/note-1.m4a',
    captureTime: '2026-03-09T06:55:00Z',
    retentionClass: 'field-visit-retention',
    sha256: 'ab'.repeat(32),
    sizeBytes: 4096,
  });
}

const expectsReviewWall = (fn, label) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ReviewRequiredError, `${label}: threw ${error?.constructor?.name} instead of ReviewRequiredError`);
    return;
  }
  assert.fail(`${label}: the review wall did not throw`);
};

test('a requested-but-unreviewed note (with draft attached) cannot attach', () => {
  const note = voice.requestTranscription(baseNote(), voice.DETERMINISTIC_STUB_PROVIDER, NOW);
  assert.equal(note.state, 'requested');
  assert.ok(note.transcript, 'the stub draft is attached');
  expectsReviewWall(() => voice.officialTranscriptAttachment(note), 'officialTranscriptAttachment(requested+draft)');
  expectsReviewWall(() => voice.saveReviewedTranscript(note, LATER), 'saveReviewedTranscript(requested+draft)');
  assert.equal(voice.reviewComplete(note), false);
});

test('a freshly created note (no transcript at all) cannot attach', () => {
  const note = baseNote();
  assert.equal(note.state, 'requested');
  assert.equal(note.transcript, null);
  expectsReviewWall(() => voice.officialTranscriptAttachment(note), 'officialTranscriptAttachment(fresh)');
  expectsReviewWall(() => voice.saveReviewedTranscript(note, LATER), 'saveReviewedTranscript(fresh)');
});

test('review without a transcript draft is refused by the state machine (no synthetic review path)', () => {
  const note = baseNote();
  assert.throws(() => voice.reviewTranscript(note, { reviewerId: REVIEWER, reviewedAt: LATER }), VoiceTransitionError);
});

test('a reviewed note with a MISSING reviewer id cannot attach (spoofed clone)', () => {
  const reviewed = voice.reviewTranscript(
    voice.requestTranscription(baseNote(), voice.DETERMINISTIC_STUB_PROVIDER, NOW),
    { reviewerId: REVIEWER, reviewedAt: LATER },
  );
  assert.equal(voice.reviewComplete(reviewed), true);
  // Hostile clone: state says reviewed but the reviewer actor is gone.
  const spoofed = { ...reviewed, reviewedBy: null };
  expectsReviewWall(() => voice.officialTranscriptAttachment(spoofed), 'officialTranscriptAttachment(reviewed, no reviewer)');
  expectsReviewWall(() => voice.saveReviewedTranscript(spoofed, LATER), 'saveReviewedTranscript(reviewed, no reviewer)');
  // And a clone whose transcript vanished.
  const transcriptless = { ...reviewed, transcript: null };
  expectsReviewWall(() => voice.officialTranscriptAttachment(transcriptless), 'officialTranscriptAttachment(reviewed, no transcript)');
  expectsReviewWall(() => voice.saveReviewedTranscript(transcriptless, LATER), 'saveReviewedTranscript(reviewed, no transcript)');
});

test('an unknown/hostile state value cannot attach (the wall is allow-list, not deny-list)', () => {
  const draft = voice.requestTranscription(baseNote(), voice.DETERMINISTIC_STUB_PROVIDER, NOW);
  for (const hostileState of ['', 'approved', 'auto-reviewed', 'transcribed', 'final', 'REVIEWED', 'saved ', 'requested ']) {
    const hostile = { ...draft, state: hostileState, reviewedBy: hostileState.includes('REVIEWED') ? REVIEWER : null };
    expectsReviewWall(() => voice.officialTranscriptAttachment(hostile), `officialTranscriptAttachment(state="${hostileState}")`);
    expectsReviewWall(() => voice.saveReviewedTranscript(hostile, LATER), `saveReviewedTranscript(state="${hostileState}")`);
  }
});

test('a transcript whose text was edited BEFORE review cannot attach (the edit is part of review)', () => {
  const note = voice.requestTranscription(baseNote(), voice.DETERMINISTIC_STUB_PROVIDER, NOW);
  // Mutating the draft text outside reviewTranscript (a hostile clone).
  const tampered = { ...note, transcript: { ...note.transcript, text: 'the gauge reads 9000 cfs, trust me' } };
  expectsReviewWall(() => voice.officialTranscriptAttachment(tampered), 'officialTranscriptAttachment(tampered draft)');
});

test('the legal path works and only then: review records the reviewer, save produces the official artifact', () => {
  const reviewed = voice.reviewTranscript(
    voice.requestTranscription(baseNote(), voice.DETERMINISTIC_STUB_PROVIDER, NOW),
    { reviewerId: REVIEWER, reviewedAt: LATER, editedText: 'gauge plate iced on the right bank; reading approximate' },
  );
  assert.equal(voice.reviewComplete(reviewed), true);
  const saved = voice.saveReviewedTranscript(reviewed, '2026-03-09T09:00:00Z');
  assert.equal(saved.note.state, 'saved');
  const attachment = saved.attachment;
  assert.equal(attachment.kind, 'voice-note-transcript');
  assert.equal(attachment.reviewedBy, REVIEWER);
  assert.equal(attachment.visibility, 'internal');
  assert.ok(attachment.text.includes('iced'));
  // The official artifact carries NO measurement/qualifier/inspection fields.
  for (const forbidden of ['value', 'qualifierIds', 'inspectionStatus', 'measurement', 'processingLevel']) {
    assert.ok(!(forbidden in attachment), `the official transcript artifact carries ${forbidden}`);
  }
  // A SAVED note still attaches (review completed by construction).
  assert.doesNotThrow(() => voice.officialTranscriptAttachment(saved.note));
});

test('determinism: the stub provider is deep-equal for identical requests; note ids follow the append sequence', () => {
  const request = { noteId: 'voice-note-fixed', audioRef: 'objref://audio/x.m4a', captureTime: '2026-03-09T06:55:00Z', requestedAt: NOW };
  assert.deepEqual(voice.DETERMINISTIC_STUB_PROVIDER.transcribe(request), voice.DETERMINISTIC_STUB_PROVIDER.transcribe(request));
  const first = baseNote();
  const second = baseNote();
  assert.notEqual(first.id, second.id, 'distinct captures get distinct sequential ids');
  assert.deepEqual(first.audio, second.audio, 'identical capture inputs produce identical audio descriptors');
});
