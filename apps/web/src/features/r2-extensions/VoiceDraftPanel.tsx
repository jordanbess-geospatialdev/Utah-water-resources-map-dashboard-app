/**
 * VoiceDraftPanel - the FR-047 voice-note draft flow (WD-023-R2, stub only).
 *
 * "A user records a note and optionally requests an approved transcription
 * or summary; the user reviews it before saving, original media follows
 * retention policy, and no AI text changes measurements or inspection
 * status automatically."
 *
 * Three reviewed steps: RECORD (a stub - no provider is approved yet, and
 * no network exists anywhere), REQUEST TRANSCRIPTION (the deterministic
 * stub attaches an EMPTY provider-pending draft), REVIEW (the editable
 * transcript editor - checking the review box and naming the reviewer
 * actor are required), and SAVE - the ONLY path to an attachment. Until
 * save, the attach path stays locked and the blockers say why; after save,
 * the internal-class attachment descriptor is shown with its provenance.
 * The panel never offers any control that writes a measurement or
 * inspection status: there is nothing for AI text to change.
 */
import { useMemo, useState, type FormEvent } from 'react';
import {
  DEMO_VOICE_DRAFT,
  providerPendingLabel,
  voiceReviewBlockers,
  voiceStateBadge,
  type VoiceDraftState,
  type VoiceDraftView,
} from './extensionsModel';

export interface VoiceDraftPanelProps {
  /** Initial draft state for the demo flow (defaults to the stub draft). */
  readonly initialDraft?: VoiceDraftView;
  /** Acting persona label shown as the default reviewer. */
  readonly actorLabel?: string;
}

type Phase = 'record' | 'draft' | 'saved';

export default function VoiceDraftPanel({ initialDraft = DEMO_VOICE_DRAFT, actorLabel = 'Fatima (Bear River engineer)' }: VoiceDraftPanelProps) {
  const [phase, setPhase] = useState<Phase>('record');
  const [draft, setDraft] = useState<VoiceDraftView>(initialDraft);
  const [text, setText] = useState(initialDraft.text);
  const [reviewed, setReviewed] = useState(false);
  const [reviewer, setReviewer] = useState<string>('');
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const blockers = useMemo(
    () =>
      voiceReviewBlockers({
        draftAttached: phase !== 'record',
        reviewedConfirmed: reviewed,
        reviewerRecorded: reviewer.trim().length > 0,
      }),
    [phase, reviewed, reviewer],
  );

  const badge = voiceStateBadge(draft.state);

  const onRecord = () => {
    setPhase('draft');
  };

  const onSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blockers.length > 0) return; // SAVE stays the only path; disabled until the wall clears
    const next: VoiceDraftState = 'saved';
    const stamp = '2026-03-10T14:06:00Z'; // injected demo clock - the server stamps the real save
    setDraft({ ...draft, state: next, text, reviewedBy: reviewer.trim(), savedAt: stamp });
    setSavedAt(stamp);
    setPhase('saved');
  };

  return (
    <section className="panel" aria-label="Voice note draft">
      <div className="panel-heading">
        <div>
          <h2>Voice note draft</h2>
          <span>
            Record · request transcription · review the draft · save — the transcript is never official until you review and save it, and
            no AI text can change measurements or inspection status
          </span>
        </div>
        <span className="mini-pill">FR-047 · stub provider</span>
      </div>

      <p role="status" aria-live="polite">
        {phase === 'record'
          ? 'No note recorded yet.'
          : phase === 'draft'
            ? 'Provider-pending draft attached. Review the transcript, then save.'
            : 'Reviewed transcript saved as an internal attachment.'}
      </p>

      {phase === 'record' && (
        <div style={{ padding: '10px 19px' }}>
          <button type="button" className="button small" onClick={onRecord}>
            Record note (stub)
          </button>{' '}
          <button type="button" className="button small" onClick={onRecord} title="The stub provider attaches an empty provider-pending draft; no provider is approved yet">
            Request transcription
          </button>
          <p style={{ fontSize: 9, color: '#9caa97', marginTop: 8, marginBottom: 0 }}>
            The recorder and the transcription provider are stubs: provider selection and the state-policy privacy review precede any
            external processing (NFR-010). No network code exists anywhere in this feature.
          </p>
        </div>
      )}

      {phase !== 'record' && (
        <form onSubmit={onSave} style={{ padding: '10px 19px' }}>
          <fieldset style={{ border: '1px solid #e9ede8', borderRadius: 6, padding: '8px 12px' }}>
            <legend style={{ fontSize: 10 }}>
              Draft state:{' '}
              <span aria-hidden style={{ fontWeight: 700 }}>
                {badge.marker}
              </span>{' '}
              {badge.text}
              {' · '}
              {providerPendingLabel(draft)}
            </legend>

            <label htmlFor="voice-transcript" style={{ display: 'block', fontSize: 10, marginBottom: 4 }}>
              Transcript draft (editable — you review before save)
            </label>
            <textarea
              id="voice-transcript"
              rows={3}
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={phase === 'saved'}
              placeholder="Provider pending: the approved provider will fill this draft. You can also type the note yourself."
              style={{ width: '100%', fontSize: 11, fontFamily: 'inherit' }}
            />

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', marginTop: 8, fontSize: 10 }}>
              <span>
                <input
                  id="voice-review-confirm"
                  type="checkbox"
                  checked={reviewed}
                  onChange={(event) => setReviewed(event.target.checked)}
                  disabled={phase === 'saved'}
                />{' '}
                <label htmlFor="voice-review-confirm">I reviewed this transcript</label>
              </span>
              <span>
                <label htmlFor="voice-reviewer" style={{ marginRight: 4 }}>
                  Reviewer
                </label>
                <input
                  id="voice-reviewer"
                  type="text"
                  value={reviewer}
                  onChange={(event) => setReviewer(event.target.value)}
                  placeholder={actorLabel}
                  disabled={phase === 'saved'}
                  style={{ fontSize: 11 }}
                />
              </span>
              <button type="submit" className="button small" disabled={phase === 'saved' || blockers.length > 0}>
                Save transcript
              </button>
              <span className="muted" style={{ fontSize: 9 }}>
                Attach path: {phase === 'saved' ? 'saved — attachment available below' : 'locked until save'}
              </span>
            </div>

            {blockers.length > 0 && phase !== 'saved' && (
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 9, color: '#8a4b3c' }}>
                {blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            )}
          </fieldset>
        </form>
      )}

      {phase === 'saved' && (
        <div
          aria-label="Saved voice note attachment"
          style={{ margin: '0 19px 10px', padding: '8px 10px', border: '1px solid #e9ede8', borderRadius: 6, fontSize: 10 }}
        >
          <strong>Attachment: voice-note-transcript</strong> · visibility <strong>internal</strong> · retention{' '}
          <strong>{draft.retentionClass}</strong> · correlation <code>{draft.correlationId}</code> · reviewed by{' '}
          <strong>{draft.reviewedBy}</strong> · saved {savedAt}
          <div style={{ marginTop: 4, color: '#7b8982' }}>
            The original audio follows the attachment retention policy behind the WD-012 wall (internal by default). The attachment
            carries text + provenance + reviewer only — it has no field any measurement or inspection status could read.
          </div>
        </div>
      )}

      <p style={{ padding: '0 19px 10px', fontSize: 9, color: '#9caa97', margin: 0 }}>
        Stub-only boundary: the deterministic provider returns an empty, provider-pending draft. A real provider is a drop-in behind the
        same seam once the privacy review approves one (FR-047 / NFR-010).
      </p>
    </section>
  );
}
