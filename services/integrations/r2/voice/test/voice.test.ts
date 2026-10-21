/**
 * FR-047 voice-note draft tests (WD-023-R2, T-06).
 *
 * Covers the ratified stub-only contract in
 * docs/extensions/r2/R2-EXTENSIONS-SCOPE.md:
 *  - the review-required state machine (requested -> reviewed -> saved),
 *    including the invalid transitions;
 *  - review-required denial: an unreviewed transcript can NEVER attach to
 *    an official record (ReviewRequiredError), and a 'reviewed' state
 *    without a recorded reviewer actor is equally refused;
 *  - SAVE as the only path to an attachment, and the official descriptor's
 *    shape: internal-class, retention-carrying, and free of any measurement
 *    or inspection-status field (no AI text can change one - FR-047);
 *  - DeterministicStubProvider determinism + provider-pending labeling;
 *  - attachment-wall conformity: audio visibility defaults to INTERNAL
 *    (WD-012 wall), with the retention class the media follows;
 *  - the static no-network scan: the entire r2 tree (this package and the
 *    web feature) contains no network import or call, statically checked.
 *
 * Run:
 *   node --test --experimental-strip-types services/integrations/r2/voice/test/voice.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewRequiredError, VoiceTransitionError, type VoiceNote } from '../types.ts';
import {
  DETERMINISTIC_STUB_PROVIDER,
  createVoiceNote,
  officialTranscriptAttachment,
  requestTranscription,
  reviewComplete,
  reviewTranscript,
  saveReviewedTranscript,
} from '../transcription.ts';

const BASE_INPUT = {
  siteId: 'sta-bear-corinne',
  actorId: 'principal-fatima-engineer',
  recordedAt: '2026-03-10T14:00:00Z',
  audioAttachmentRef: 'placeholder://attachments/voice-demo-1',
  captureTime: '2026-03-10T13:58:00Z',
  retentionClass: 'extended' as const,
};

function requestedNote(): VoiceNote {
  return requestTranscription(createVoiceNote(BASE_INPUT), DETERMINISTIC_STUB_PROVIDER, '2026-03-10T14:01:00Z');
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

test('state machine: requested -> reviewed -> saved with reviewer and times recorded', () => {
  const note = requestedNote();
  assert.equal(note.state, 'requested');
  assert.equal(note.transcript?.providerPending, true, 'stub draft is labeled provider-pending');
  assert.equal(note.reviewedBy, null);

  const reviewed = reviewTranscript(note, { reviewerId: 'principal-fatima-engineer', reviewedAt: '2026-03-10T14:05:00Z', editedText: 'Gauge reading 20.9 cfs; ice present at intake.' });
  assert.equal(reviewed.state, 'reviewed');
  assert.equal(reviewed.reviewedBy, 'principal-fatima-engineer');
  assert.equal(reviewed.transcript?.text, 'Gauge reading 20.9 cfs; ice present at intake.', 'review edits the DRAFT text');

  const { note: saved, attachment } = saveReviewedTranscript(reviewed, '2026-03-10T14:06:00Z');
  assert.equal(saved.state, 'saved');
  assert.equal(saved.savedAt, '2026-03-10T14:06:00Z');
  assert.equal(attachment.kind, 'voice-note-transcript');
});

test('state machine: invalid transitions are refused with VoiceTransitionError', () => {
  const note = requestedNote();
  // Cannot save straight from 'requested'.
  assert.throws(() => saveReviewedTranscript(note, '2026-03-10T14:06:00Z'), (error: unknown) => {
    assert.ok(error instanceof ReviewRequiredError);
    assert.equal(error.code, 'REVIEW_REQUIRED');
    return true;
  });
  // Cannot re-request transcription once a draft is attached.
  assert.throws(() => requestTranscription(note, DETERMINISTIC_STUB_PROVIDER, '2026-03-10T14:02:00Z'), (error: unknown) => {
    assert.ok(error instanceof VoiceTransitionError);
    assert.equal(error.code, 'INVALID_TRANSITION');
    return true;
  });
  // Cannot review a note that has no draft at all.
  const bare = createVoiceNote(BASE_INPUT);
  assert.throws(() => reviewTranscript(bare, { reviewerId: 'x', reviewedAt: '2026-03-10T14:05:00Z' }), VoiceTransitionError);
  // Cannot save twice.
  const reviewed = reviewTranscript(note, { reviewerId: 'principal-fatima-engineer', reviewedAt: '2026-03-10T14:05:00Z' });
  const { note: saved } = saveReviewedTranscript(reviewed, '2026-03-10T14:06:00Z');
  assert.throws(() => saveReviewedTranscript(saved, '2026-03-10T14:07:00Z'), VoiceTransitionError);
});

// ---------------------------------------------------------------------------
// Review-required denial (the FR-047 wall)
// ---------------------------------------------------------------------------

test('review-required denial: an unreviewed transcript can never attach to an official record', () => {
  const note = requestedNote();
  assert.equal(reviewComplete(note), false);
  assert.throws(() => officialTranscriptAttachment(note), ReviewRequiredError);
  try {
    officialTranscriptAttachment(note);
    assert.fail('unreachable');
  } catch (error) {
    assert.ok(error instanceof ReviewRequiredError);
    assert.equal(error.noteId, note.id);
    assert.equal(error.state, 'requested');
    assert.equal(error.code, 'REVIEW_REQUIRED');
  }
});

test('review-required denial: state "reviewed" WITHOUT a recorded reviewer actor is refused too', () => {
  // Constructed literally: the state claims review but no reviewer actor was
  // recorded. Every attach path re-checks both conditions independently.
  const malformed: VoiceNote = { ...requestedNote(), state: 'reviewed', reviewedBy: null, reviewedAt: null };
  assert.equal(reviewComplete(malformed), false);
  assert.throws(() => officialTranscriptAttachment(malformed), ReviewRequiredError);
  assert.throws(() => saveReviewedTranscript(malformed, '2026-03-10T14:06:00Z'), ReviewRequiredError);
});

test('SAVE is the only path to an attachment, and the descriptor carries no measurement or inspection field', () => {
  const reviewed = reviewTranscript(requestedNote(), {
    reviewerId: 'principal-fatima-engineer',
    reviewedAt: '2026-03-10T14:05:00Z',
    editedText: 'Gauge reading 20.9 cfs; ice present at intake.',
  });
  const { attachment } = saveReviewedTranscript(reviewed, '2026-03-10T14:06:00Z');
  const serialized = JSON.stringify(attachment);
  for (const forbidden of ['"value"', 'processingLevel', 'qualifier', 'inspection', 'status', 'measurement']) {
    assert.ok(!serialized.includes(forbidden), `official voice artifact must not carry a measurement/inspection field (${forbidden})`);
  }
  assert.equal(attachment.reviewedBy, 'principal-fatima-engineer');
  assert.equal(attachment.correlationId, `stub-${attachment.noteId}`);
  // A reviewed-but-unsaved note can be READ for hand-off, but the official
  // path is save; the descriptor from either path has the same shape.
  assert.deepEqual(Object.keys(officialTranscriptAttachment(reviewed)).sort(), Object.keys(attachment).sort());
});

// ---------------------------------------------------------------------------
// Stub determinism + provider-pending labeling
// ---------------------------------------------------------------------------

test('deterministic stub: identical requests produce deep-equal provider-pending drafts', () => {
  const request = { noteId: 'voice-note-1000', audioRef: BASE_INPUT.audioAttachmentRef, captureTime: BASE_INPUT.captureTime, requestedAt: '2026-03-10T14:01:00Z' };
  const one = DETERMINISTIC_STUB_PROVIDER.transcribe(request);
  const two = DETERMINISTIC_STUB_PROVIDER.transcribe(request);
  assert.deepEqual(one, two);
  assert.equal(one.text, '');
  assert.equal(one.providerPending, true, 'the stub transcript is labeled provider-pending');
  assert.equal(one.provenance.providerId, 'deterministic-stub');
  assert.equal(one.provenance.correlationId, 'stub-voice-note-1000');
  const other = DETERMINISTIC_STUB_PROVIDER.transcribe({ ...request, requestedAt: '2026-03-10T15:00:00Z' });
  assert.notDeepEqual(one, other, 'different requests yield different provenance');
});

// ---------------------------------------------------------------------------
// Attachment-wall conformity (WD-012)
// ---------------------------------------------------------------------------

test('attachment-wall conformity: audio visibility defaults to INTERNAL and carries its retention class', () => {
  const note = createVoiceNote(BASE_INPUT);
  assert.equal(note.audio.visibility, 'internal', 'internal is the default (default-deny side of the wall)');
  assert.equal(note.audio.retentionClass, 'extended', 'the original media follows its retention policy (FR-047)');
  assert.equal(note.audio.attachmentRef.startsWith('placeholder://attachments/'), true, 'bytes stay behind the storage placeholder');

  const explicit = createVoiceNote({ ...BASE_INPUT, visibility: 'public' });
  assert.equal(explicit.audio.visibility, 'public', 'public audio requires an explicit, deliberate choice');

  // The official transcript artifact is internal-class by construction: it
  // never enters a public projection.
  const reviewed = reviewTranscript(requestTranscription(createVoiceNote(BASE_INPUT), DETERMINISTIC_STUB_PROVIDER, '2026-03-10T14:01:00Z'), {
    reviewerId: 'principal-fatima-engineer',
    reviewedAt: '2026-03-10T14:05:00Z',
  });
  const { attachment } = saveReviewedTranscript(reviewed, '2026-03-10T14:06:00Z');
  assert.equal(attachment.visibility, 'internal');
  assert.equal(attachment.retentionClass, 'extended');
});

// ---------------------------------------------------------------------------
// Static no-network scan over the whole r2 tree
// ---------------------------------------------------------------------------

const SERVICES_DIR = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..'); // .../voice/test/voice.test.ts -> <worktree>/services
const R2_TREE = join(SERVICES_DIR, 'integrations', 'r2'); // the whole r2 integration tree
const WEB_R2_TREE = join(SERVICES_DIR, '..', 'apps', 'web', 'src', 'features', 'r2-extensions'); // the r2 web feature

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx|mts|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Module specifiers no r2 file may ever import (network transport is forbidden until NFR-010 approval). */
const FORBIDDEN_SPECIFIER = /^(https?:|node:(http|https|net|tls|dgram|undici)|http|https|net|tls)$/i;

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** Network-capable call tokens no r2 file may contain (comments included: the bar is absolute). */
const FORBIDDEN_TOKENS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\bfetch\s*\(/, label: 'a network fetch call' },
  { pattern: /\bXMLHttpRequest\b/, label: 'an xml-http-request constructor' },
  { pattern: /\bWebSocket\b/, label: 'a web-socket constructor' },
  { pattern: /\bEventSource\b/, label: 'a server-sent-event constructor' },
  { pattern: /navigator\s*\.\s*sendBeacon/, label: 'a send-beacon call' },
];

test('static no-network scan: no fetch/http/https transport anywhere in the r2 tree', () => {
  const roots = [R2_TREE, WEB_R2_TREE];
  const files: string[] = [];
  for (const root of roots) {
    const found = listSourceFiles(root);
    assert.ok(found.length > 0, `source tree must exist and be non-empty: ${root}`);
    files.push(...found);
  }
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      if (FORBIDDEN_SPECIFIER.test(specifier)) {
        offenders.push(`${file}: network import "${specifier}"`);
      }
    }
    for (const { pattern, label } of FORBIDDEN_TOKENS) {
      if (pattern.test(source)) offenders.push(`${file}: ${label}`);
    }
  }
  assert.deepEqual(offenders, [], `no network code may exist before the NFR-010 privacy review approves a provider:\n${offenders.join('\n')}`);
});
