/**
 * HelpPanel - the WD-020 role-aware help surface (FR-018, FR-068).
 *
 * Two jobs:
 * 1. ROLE-AWARE TASK HELP for the six fixture personas (short, task-based
 *    guides that point at the full checklists in docs/training/
 *    tasks-public.md and tasks-operational.md), plus the entry point to
 *    restart the onboarding tour.
 * 2. FEEDBACK CAPTURE with a SUPPORT-CONTEXT PREVIEW shown BEFORE submit
 *    (FR-018): the user sees exactly what ships - the versioned share query
 *    built by the REAL WD-007 codec (../discovery/shareUrl.ts), the app
 *    version, the timestamp, and every omission notice. Nothing is sent that
 *    was not previewed.
 *
 * Validation mirrors services/api/src/support/feedback.ts (the domain
 * authority): bounded description, closed categories, no free-form URLs
 * (empty host allowlist), no secret-shaped text, screenshot references as
 * attachment ids only. Submission targets an injectable handler; without
 * one it queues in memory and says so honestly (the Fastify route wiring is
 * a later task - recorded in README.md).
 *
 * Accessibility contract: labelled controls (htmlFor/id), role=alert for
 * validation errors, role=status for notices, loading/ready/error states,
 * keyboard-reachable everything, no color-only meaning.
 *
 * Mountable, shell-free component; the shell wiring lines live in README.md.
 */
import { useMemo, useState, type CSSProperties, type FormEvent as ReactFormEvent } from 'react';
import { buildShareUrl, type DiscoveryShareState } from '../discovery/shareUrl';
import { publicDiscoveryStations } from '../discovery/filters';
import { personaById, type Persona } from '../../shell/data/personas';

// ---------------------------------------------------------------------------
// Constants mirrored from services/api/src/support (the domain authority)
// ---------------------------------------------------------------------------

/** Mirror of FEEDBACK_CATEGORIES / FEEDBACK_CATEGORY_LABELS (services/api/src/support/feedback.ts). */
export const FEEDBACK_CATEGORIES = ['defect', 'data-question', 'access-issue', 'improvement', 'training-feedback'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];
export const FEEDBACK_CATEGORY_LABELS: Readonly<Record<FeedbackCategory, string>> = {
  defect: 'Something is broken',
  'data-question': 'Question about the data',
  'access-issue': 'Access problem',
  improvement: 'Improvement idea',
  'training-feedback': 'Training feedback',
};

export const DESCRIPTION_MIN_LENGTH = 10;
export const DESCRIPTION_MAX_LENGTH = 4000;
/** Mirror of SCREENSHOT_REF_PATTERN (attachment metadata id, never bytes or URLs). */
export const SCREENSHOT_REF_PATTERN = /^att-[a-z0-9][a-z0-9-]{0,63}$/;
/** Mirror of ALLOWED_URL_HOSTS: empty by policy; widening is an owner decision (docs/training/PRIVACY-PROPOSAL.md). */
export const ALLOWED_URL_HOSTS: readonly string[] = [];
const FREE_FORM_URL_PATTERN = /(?:https?:\/\/|www\.)\S+/i;
/** Mirror of the service secret-shape families (supportContext.ts SECRET_SHAPES, web subset). */
const SECRET_SHAPE_PATTERNS: readonly RegExp[] = [
  /\buwdat_[a-z0-9_]{8,}\b/i,
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /\bey[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{5,}\b/i,
  /\b[a-f0-9]{32,}\b/i,
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*\S+/i,
];

/** Application version reported in the support context (source: apps/web/package.json). */
export const APP_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Role-aware task guides (short; full checklists live in docs/training)
// ---------------------------------------------------------------------------

export interface TaskGuide {
  readonly title: string;
  readonly steps: readonly string[];
  /** Training checklist this guide summarizes (docs/training/tasks-public.md or tasks-operational.md). */
  readonly checklist: 'public' | 'operational';
}

const GUIDES: Readonly<Record<string, readonly TaskGuide[]>> = {
  public: [
    { title: 'Discover and filter stations', checklist: 'public', steps: ['Open the map or table - they show the same stations.', 'Pick filters (system, site type, telemetry); values within a filter combine, filters narrow.', 'Clear a filter to widen the view again.'] },
    { title: 'Interpret an indicator', checklist: 'public', steps: ['Read the freshness shape and label (Reporting, Stale, Inactive, No data).', 'Open the site card for the latest value, unit and observation time.', 'A missing reading is never a zero - check freshness first.'] },
    { title: 'Save and share a view', checklist: 'public', steps: ['Set filters, extent and a selected site.', 'Copy the share link - it carries exactly those three things, nothing personal.', 'Verify what a link contains by pasting it into a private window.'] },
  ],
  'water-user': [
    { title: 'Find your organization\'s stations', checklist: 'public', steps: ['Sign in; restricted delivery stations your organization owns appear with public ones.', 'Filter by distribution system to narrow to your area.', 'Favorite the sites you check daily from My Sites.'] },
    { title: 'Report an access problem', checklist: 'public', steps: ['Open Help, choose "Access problem".', 'Preview the support context - it shows the public view only.', 'Send; the steward can reproduce what you saw.'] },
  ],
  researcher: [
    { title: 'Build a reproducible extract', checklist: 'public', steps: ['Filter by observed property, processing level and method.', 'Check the data dictionary for every term you rely on.', 'Export CSV, or request a scoped API token for programmatic access.'] },
  ],
  commissioner: [
    { title: 'Morning review', checklist: 'operational', steps: ['Open the assigned workspace; freshness problems sort to the top.', 'Investigate missing or late readings before entering new data.', 'Open the site detail to compare against yesterday.'] },
    { title: 'Enter and bulk paste readings', checklist: 'operational', steps: ['Single reading: units, time zone and validity are checked before commit.', 'Bulk paste: preview the parsed batch and row errors, then commit once.', 'Never partially commit a batch without the row report.'] },
    { title: 'Correct a value with audit', checklist: 'operational', steps: ['Select the point or interval in QA review.', 'Append the correction with a qualifier and a reason - originals are never overwritten.', 'Check the history to see every actor and time.'] },
  ],
  engineer: [
    { title: 'Diagnose a station', checklist: 'operational', steps: ['Open site diagnostics for internal streams and equipment history.', 'Compare telemetry gaps with connection health digests.', 'Record the inspection; internal attachments stay internal.'] },
    { title: 'QA review', checklist: 'operational', steps: ['Compare original versus revised values on the interval.', 'Append corrections with qualifier and reason.', 'Verify the audit trail shows your actor id and time.'] },
  ],
  steward: [
    { title: 'Triage the feedback queue', checklist: 'operational', steps: ['Open the steward console feedback queue.', 'Open each report\'s reproducible link (public view state only).', 'Assign P1-P4 priority and work in order.'] },
    { title: 'Check connection health', checklist: 'operational', steps: ['Distinguish a failed provider from failed tasks in the digest.', 'Open the filtered task view from the deep link.', 'Escalate ingestion failures with the digest attached.'] },
  ],
};

export function guidesForPersona(personaId: string): readonly TaskGuide[] {
  const persona = personaById(personaId);
  return GUIDES[persona.role] ?? GUIDES.public!;
}

// ---------------------------------------------------------------------------
// Support-context preview (built by the REAL WD-007 codec)
// ---------------------------------------------------------------------------

export interface SupportContextPreview {
  readonly appVersion: string;
  readonly generatedAt: string;
  /** Query string without the leading '?' - exactly what would ship. */
  readonly shareQuery: string;
  /** Every omission/redaction the codec applied, in order. */
  readonly notices: readonly { readonly kind: string; readonly message: string }[];
}

export function buildSupportContextPreview(
  viewState: Readonly<Partial<DiscoveryShareState>>,
  now: Date | string,
): SupportContextPreview {
  const built = buildShareUrl(viewState, { publicSiteIds: publicDiscoveryStations.map((station) => station.id) });
  return {
    appVersion: APP_VERSION,
    generatedAt: typeof now === 'string' ? now : new Date(now.getTime()).toISOString(),
    shareQuery: built.url,
    notices: built.notices.map((notice) => ({ kind: notice.kind, message: notice.message })),
  };
}

// ---------------------------------------------------------------------------
// Validation (mirror of the service rules; the service re-validates)
// ---------------------------------------------------------------------------

export type FeedbackFormErrorCode = 'category-required' | 'description-too-short' | 'description-too-long' | 'free-form-url' | 'secret-shaped-text' | 'bad-screenshot-ref';

export function validateFeedbackForm(input: { readonly category: FeedbackCategory | ''; readonly description: string; readonly screenshotRef: string }): readonly FeedbackFormErrorCode[] {
  const errors: FeedbackFormErrorCode[] = [];
  if (input.category === '') errors.push('category-required');
  const description = input.description.trim();
  if (description.length < DESCRIPTION_MIN_LENGTH) errors.push('description-too-short');
  if (input.description.length > DESCRIPTION_MAX_LENGTH) errors.push('description-too-long');
  if (FREE_FORM_URL_PATTERN.test(input.description) && ALLOWED_URL_HOSTS.length === 0) errors.push('free-form-url');
  if (SECRET_SHAPE_PATTERNS.some((pattern) => pattern.test(input.description))) errors.push('secret-shaped-text');
  if (input.screenshotRef.trim() !== '' && !SCREENSHOT_REF_PATTERN.test(input.screenshotRef.trim())) errors.push('bad-screenshot-ref');
  return errors;
}

const ERROR_MESSAGES: Readonly<Record<FeedbackFormErrorCode, string>> = {
  'category-required': 'Pick a category.',
  'description-too-short': `Describe the issue in at least ${DESCRIPTION_MIN_LENGTH} characters.`,
  'description-too-long': `Descriptions are capped at ${DESCRIPTION_MAX_LENGTH} characters.`,
  'free-form-url': 'Links are not accepted in reports (no allowed hosts yet).',
  'secret-shaped-text': 'The description looks like it contains a password, key or token - remove it before sending.',
  'bad-screenshot-ref': 'The attachment reference must look like att-example-001 (no paths or URLs).',
};

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export interface HelpPanelProps {
  /** Persona id driving role-aware help (default: the public persona). */
  readonly personaId?: string;
  /** Acting account for feedback attribution; null = anonymous report. */
  readonly principalId?: string | null;
  /** Current view state used for the support-context preview (default: the default share state). */
  readonly viewState?: Readonly<Partial<DiscoveryShareState>>;
  readonly now?: Date | string;
  readonly status?: 'loading' | 'ready' | 'error';
  readonly errorMessage?: string;
  readonly onRetry?: () => void;
  /** Injectable submit handler (the future POST /support/feedback wiring); absent = local queue with an honest notice. */
  readonly onSubmitFeedback?: (submission: { category: FeedbackCategory; description: string; screenshotRef: string | null; context: SupportContextPreview; submittedBy: string | null }) => void;
  /** Show the restart-tour affordance (wired to OnboardingTour by the shell). */
  readonly onRestartTour?: () => void;
}

interface QueuedReport {
  readonly id: number;
  readonly category: FeedbackCategory;
  readonly preview: SupportContextPreview;
}

let demoQueueCounter = 0;

export default function HelpPanel({
  personaId = 'donna',
  principalId = null,
  viewState,
  now,
  status = 'ready',
  errorMessage,
  onRetry,
  onSubmitFeedback,
  onRestartTour,
}: HelpPanelProps) {
  const persona: Persona = personaById(personaId);
  const resolvedNow = now ?? new Date();
  const resolvedViewState = viewState ?? {};

  const preview = useMemo(() => buildSupportContextPreview(resolvedViewState, resolvedNow), [resolvedViewState, resolvedNow]);

  const [category, setCategory] = useState<FeedbackCategory | ''>('');
  const [description, setDescription] = useState('');
  const [screenshotRef, setScreenshotRef] = useState('');
  const [errors, setErrors] = useState<readonly FeedbackFormErrorCode[]>([]);
  const [notice, setNotice] = useState('');
  const [queued, setQueued] = useState<readonly QueuedReport[]>([]);

  const guides = guidesForPersona(personaId);
  const remaining = DESCRIPTION_MAX_LENGTH - description.length;

  if (status === 'loading') {
    return (
      <section aria-busy="true" role="status" style={{ padding: '24px 20px', fontSize: 11 }}>
        Loading help for {persona.name}…
      </section>
    );
  }
  if (status === 'error') {
    return (
      <section role="alert" style={{ padding: '24px 20px', fontSize: 11 }}>
        <p style={{ marginTop: 0 }}>{errorMessage ?? 'Help is temporarily unavailable.'}</p>
        {onRetry ? (
          <button type="button" className="button small" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </section>
    );
  }

  const submit = (event: ReactFormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const found = validateFeedbackForm({ category, description, screenshotRef });
    setErrors(found);
    if (found.length > 0) {
      setNotice('');
      return;
    }
    const trimmedRef = screenshotRef.trim();
    const submission = {
      category: category as FeedbackCategory,
      description,
      screenshotRef: trimmedRef === '' ? null : trimmedRef,
      context: preview,
      submittedBy: principalId,
    };
    if (onSubmitFeedback) {
      onSubmitFeedback(submission);
    } else {
      demoQueueCounter += 1;
      setQueued((current) => [...current, { id: demoQueueCounter, category: submission.category, preview: submission.context }]);
    }
    setNotice(
      onSubmitFeedback
        ? 'Report sent to the steward queue with exactly the previewed context.'
        : 'Report validated and queued locally (the support endpoint wiring is a later task); only the previewed context ships.',
    );
    setCategory('');
    setDescription('');
    setScreenshotRef('');
  };

  return (
    <section style={{ padding: '16px 20px', fontSize: 11 }} aria-labelledby="help-heading">
      <h2 id="help-heading" style={{ fontSize: 13, margin: '0 0 4px' }}>
        Help - {persona.name} ({persona.title})
      </h2>
      <p style={{ margin: '0 0 14px', color: '#5a6553' }}>{persona.description}</p>

      <h3 style={{ fontSize: 12, margin: '0 0 6px' }}>Your tasks</h3>
      <ul style={{ listStyle: 'none', margin: '0 0 6px', padding: 0 }}>
        {guides.map((guide) => (
          <li key={guide.title} style={{ borderBottom: '1px solid #e9ede8', padding: '8px 0' }}>
            <h4 style={{ fontSize: 11, margin: '0 0 4px' }}>{guide.title}</h4>
            <ol style={{ margin: 0, paddingLeft: 18, color: '#41493c' }}>
              {guide.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
            <small style={{ color: '#a0aa99' }}>
              Full checklist: docs/training/{guide.checklist === 'public' ? 'tasks-public.md' : 'tasks-operational.md'}
            </small>
          </li>
        ))}
      </ul>
      {onRestartTour ? (
        <button type="button" className="button small" onClick={onRestartTour} style={{ marginBottom: 14 }}>
          Restart the {persona.name} tour
        </button>
      ) : null}

      <h3 style={{ fontSize: 12, margin: '14px 0 6px' }}>Report a problem or suggest an improvement</h3>
      <form onSubmit={submit} noValidate>
        <div style={{ marginBottom: 8 }}>
          <label htmlFor="feedback-category">Category</label>
          <select
            id="feedback-category"
            value={category}
            onChange={(event) => setCategory(event.target.value as FeedbackCategory | '')}
            aria-required="true"
          >
            <option value="">Pick a category…</option>
            {FEEDBACK_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {FEEDBACK_CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 8 }}>
          <label htmlFor="feedback-description">What happened?</label>
          <textarea
            id="feedback-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
            style={{ width: '100%', boxSizing: 'border-box' }}
            aria-required="true"
            aria-describedby="feedback-description-help feedback-description-remaining"
          />
          <small id="feedback-description-help" style={{ display: 'block', color: '#a0aa99' }}>
            No links, no passwords or tokens - the steward receives the text exactly as typed.
          </small>
          <small id="feedback-description-remaining" style={{ display: 'block', color: remaining < 200 ? '#8a6d3c' : '#a0aa99' }}>
            {remaining} characters left
          </small>
        </div>

        <div style={{ marginBottom: 8 }}>
          <label htmlFor="feedback-screenshot">Attachment reference (optional)</label>
          <input
            id="feedback-screenshot"
            type="text"
            value={screenshotRef}
            onChange={(event) => setScreenshotRef(event.target.value)}
            placeholder="att-example-001"
            style={{ width: '100%', boxSizing: 'border-box' }}
            aria-describedby="feedback-screenshot-help"
          />
          <small id="feedback-screenshot-help" style={{ display: 'block', color: '#a0aa99' }}>
            An attachment id from the upload flow (a later milestone) - never paste image data or links.
          </small>
        </div>

        {errors.length > 0 ? (
          <div role="alert" style={{ border: '1px solid #b3552e', padding: '6px 8px', marginBottom: 8 }}>
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {errors.map((code) => (
                <li key={code}>{ERROR_MESSAGES[code]}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {notice !== '' ? (
          <p role="status" style={{ color: '#3c6e47', margin: '0 0 8px' }}>
            {notice}
          </p>
        ) : null}

        <fieldset style={{ marginBottom: 10, borderColor: '#c9d1c4' }}>
          <legend>Exactly what ships with your report (preview)</legend>
          <dl style={{ margin: '6px 0 0' }}>
            <dt style={{ fontWeight: 600 }}>App version</dt>
            <dd style={{ margin: '0 0 4px' }}>{preview.appVersion}</dd>
            <dt style={{ fontWeight: 600 }}>Timestamp</dt>
            <dd style={{ margin: '0 0 4px' }}>{preview.generatedAt}</dd>
            <dt style={{ fontWeight: 600 }}>Share link (filters, extent, selected public site)</dt>
            <dd style={{ margin: 0, wordBreak: 'break-all' }}>
              <code>?{preview.shareQuery}</code>
            </dd>
          </dl>
          {preview.notices.length > 0 ? (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: '#8a6d3c' } as CSSProperties}>
              {preview.notices.map((item, index) => (
                <li key={index}>{item.message}</li>
              ))}
            </ul>
          ) : (
            <p style={{ margin: '6px 0 0', color: '#a0aa99' }}>Nothing was omitted from this view - the link reproduces it exactly.</p>
          )}
          <p style={{ margin: '6px 0 0', color: '#a0aa99' }}>
            Your account id {principalId ?? 'stays anonymous'} · never included: passwords, tokens, internal notes, restricted sites.
          </p>
        </fieldset>

        <button type="submit" className="button small primary">
          Send report
        </button>
      </form>

      {queued.length > 0 && !onSubmitFeedback ? (
        <div style={{ marginTop: 14 }}>
          <h3 style={{ fontSize: 12, margin: '0 0 6px' }}>Locally queued reports ({queued.length})</h3>
          <ul style={{ margin: 0, paddingLeft: 18, color: '#41493c' }}>
            {queued.map((report) => (
              <li key={report.id}>
                {FEEDBACK_CATEGORY_LABELS[report.category]} · ships <code>?{report.preview.shareQuery.slice(0, 40)}</code>
                {report.preview.shareQuery.length > 40 ? '…' : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
