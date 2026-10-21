/**
 * Feedback records and the steward triage queue (WD-020; FR-018, FR-068).
 *
 * "A user can report a problem with a shareable state link; the steward
 * receives reproducible permitted context and can assign a priority without
 * embedding secrets or granting access to restricted records."
 *
 * Rules implemented here:
 *
 * - Every record carries a redaction-verified support context bundle
 *   (supportContext.ts). Submit re-runs the secret-shape scan over the
 *   submitted bundle: a bundle with findings is rejected, never stored.
 * - Validation: bounded description (DESCRIPTION_MIN_LENGTH..DESCRIPTION_MAX_LENGTH),
 *   a closed category enum, an optional screenshot METADATA reference
 *   (attachment id shape only - never image bytes, never a data URL), an
 *   optional submitter principal id, and NO free-form URLs in any free-text
 *   field. The URL host allowlist is deliberately EMPTY for now
 *   (ALLOWED_URL_HOSTS: []) - widening it is an owner decision recorded in
 *   docs/training/PRIVACY-PROPOSAL.md, not a code default.
 * - Steward queue (FR-018 "assign a priority"): a view model sorted by
 *   priority rank then recency, carrying the reproducible share query and
 *   notice summary, and re-scanned for secrets at read time (defense in
 *   depth; pinned clean by tests).
 * - Priority and status transitions are steward-only mutations; a submitter
 *   cannot prioritize their own record through this API.
 *
 * Fixture-backed: createFeedbackService() seeds the two FR-018 example
 * records (one authenticated defect report with a restricted-site omission
 * notice, one anonymous data question) through the same validation path as
 * live submissions - there is no privileged seeding path.
 *
 * Pure in-memory store: id generation and clock are injectable; defaults are
 * a per-store monotonic counter and a REQUIRED injected clock (no hidden
 * Date.now reads), so two runs with the same inputs produce byte-identical
 * serialized stores (pinned by test/feedback.test.ts).
 */
import { scanForSecretShapes, type SupportContextBundle } from './supportContext.ts';

// ---------------------------------------------------------------------------
// Enums and caps
// ---------------------------------------------------------------------------

export const FEEDBACK_CATEGORIES = ['defect', 'data-question', 'access-issue', 'improvement', 'training-feedback'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_CATEGORY_LABELS: Readonly<Record<FeedbackCategory, string>> = {
  defect: 'Something is broken',
  'data-question': 'Question about the data',
  'access-issue': 'Access problem',
  improvement: 'Improvement idea',
  'training-feedback': 'Training feedback',
};

export const FEEDBACK_PRIORITIES = ['p1', 'p2', 'p3', 'p4'] as const;
export type FeedbackPriority = (typeof FEEDBACK_PRIORITIES)[number];

export const FEEDBACK_PRIORITY_LABELS: Readonly<Record<FeedbackPriority, string>> = {
  p1: 'P1 - reproduce blocks a program deadline',
  p2: 'P2 - reproduce misleads or blocks a persona task',
  p3: 'P3 - workaround exists',
  p4: 'P4 - cosmetic or later backlog',
};

/** Queue rank: P1 first; unassigned sorts after every assigned priority. */
export const PRIORITY_RANK: Readonly<Record<FeedbackPriority | 'unassigned', number>> = {
  p1: 0,
  p2: 1,
  p3: 2,
  p4: 3,
  unassigned: 4,
};

export const FEEDBACK_STATUSES = ['new', 'triaged', 'resolved', 'dismissed'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const DESCRIPTION_MIN_LENGTH = 10;
export const DESCRIPTION_MAX_LENGTH = 4000;
/** Screenshot attachment METADATA reference: an attachment id, never bytes or a URL. */
export const SCREENSHOT_REF_PATTERN = /^att-[a-z0-9][a-z0-9-]{0,63}$/;
/** Fixture principal id shape (principals.json: principal-<name>-<role>). */
export const SUBMITTER_PATTERN = /^principal-[a-z0-9][a-z0-9-]{0,63}$/;
/** URL host allowlist for free-text fields: EMPTY by policy (FR-017/FR-018; widening is an owner decision). */
export const ALLOWED_URL_HOSTS: readonly string[] = [];
const FREE_FORM_URL_PATTERN = /(?:https?:\/\/|www\.)\S+/i;

// ---------------------------------------------------------------------------
// Record model
// ---------------------------------------------------------------------------

export interface FeedbackRecord {
  readonly id: string;
  readonly category: FeedbackCategory;
  readonly description: string;
  /** Attachment metadata reference (id only); null when no screenshot was attached. */
  readonly screenshotRef: string | null;
  /** The redaction-verified support context the submitter previewed before sending. */
  readonly context: SupportContextBundle;
  /** Fixture principal id, or null for an anonymous (public) report. */
  readonly submittedBy: string | null;
  readonly submittedAt: string;
  readonly status: FeedbackStatus;
  readonly priority: FeedbackPriority | 'unassigned';
  readonly prioritizedBy: string | null;
  readonly prioritizedAt: string | null;
}

export type FeedbackErrorCode =
  | 'description-too-short'
  | 'description-too-long'
  | 'unknown-category'
  | 'free-form-url'
  | 'secret-shaped-text'
  | 'bad-screenshot-ref'
  | 'bad-submitter'
  | 'context-not-clean'
  | 'context-missing';

export type ValidationOutcome = { ok: true; record: FeedbackRecord } | { ok: false; errors: readonly FeedbackErrorCode[] };

export interface FeedbackSubmission {
  readonly category: FeedbackCategory;
  readonly description: string;
  readonly screenshotRef?: string | null;
  readonly context: SupportContextBundle;
  readonly submittedBy?: string | null;
}

/** Validate a submission (pure). Returns the would-be record or the error list. */
export function validateFeedbackSubmission(
  submission: Readonly<FeedbackSubmission>,
  input: { readonly now: Date | string; readonly id: string },
): ValidationOutcome {
  const errors: FeedbackErrorCode[] = [];

  const description = typeof submission.description === 'string' ? submission.description : '';
  if (description.trim().length < DESCRIPTION_MIN_LENGTH) errors.push('description-too-short');
  if (description.length > DESCRIPTION_MAX_LENGTH) errors.push('description-too-long');
  if (FREE_FORM_URL_PATTERN.test(description) && ALLOWED_URL_HOSTS.length === 0) errors.push('free-form-url');
  // FR-018 "without embedding secrets": a description that itself carries a
  // secret-shaped string (a pasted token, a labeled password) is rejected at
  // the door - the steward queue never receives it, even as an excerpt.
  if (scanForSecretShapes(description, 'description').length > 0) errors.push('secret-shaped-text');

  if (!FEEDBACK_CATEGORIES.includes(submission.category)) errors.push('unknown-category');

  const screenshotRef = submission.screenshotRef ?? null;
  if (screenshotRef !== null && !SCREENSHOT_REF_PATTERN.test(screenshotRef)) errors.push('bad-screenshot-ref');

  const submittedBy = submission.submittedBy ?? null;
  if (submittedBy !== null && !SUBMITTER_PATTERN.test(submittedBy)) errors.push('bad-submitter');

  if (!submission.context || submission.context.contextVersion !== 1) errors.push('context-missing');
  else if (submission.context.redaction.secretScan !== 'clean' || submission.context.redaction.restrictedIdScan !== 'clean') errors.push('context-not-clean');
  else if (scanForSecretShapes(submission.context, 'context').length > 0) errors.push('context-not-clean');

  if (errors.length > 0) return { ok: false, errors };

  const submittedAt = typeof input.now === 'string' ? input.now : new Date(input.now.getTime()).toISOString();
  return {
    ok: true,
    record: {
      id: input.id,
      category: submission.category,
      description,
      screenshotRef,
      context: submission.context,
      submittedBy,
      submittedAt,
      status: 'new',
      priority: 'unassigned',
      prioritizedBy: null,
      prioritizedAt: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Steward queue view model (FR-018)
// ---------------------------------------------------------------------------

export interface StewardQueueRow {
  readonly id: string;
  readonly category: FeedbackCategory;
  readonly categoryLabel: string;
  readonly priority: FeedbackPriority | 'unassigned';
  readonly priorityLabel: string;
  readonly status: FeedbackStatus;
  readonly submittedAt: string;
  /** Display label: fixture principal id or 'Anonymous'. */
  readonly submittedByLabel: string;
  /** The reproducible share query handed to the steward (already redaction-verified twice). */
  readonly shareQuery: string;
  readonly appVersion: string;
  /** Redaction/omission notices the SUBMITTER saw, summarized for the steward. */
  readonly noticeKinds: readonly string[];
  readonly hasScreenshot: boolean;
  readonly descriptionExcerpt: string;
}

function excerpt(description: string): string {
  return description.length > 140 ? `${description.slice(0, 140)}…` : description;
}

export interface StewardQueue {
  readonly rows: readonly StewardQueueRow[];
  /** Non-empty only if the defense-in-depth scan tripped (pinned empty by tests). */
  readonly secretFindings: readonly string[];
}

// ---------------------------------------------------------------------------
// Fixture seed (FR-018 examples; built through the same validation path)
// ---------------------------------------------------------------------------

/**
 * Seed example records for the fixture world. Both are validated exactly like
 * live submissions; the contexts reference the WD-020 support-context test
 * view states (the authenticated one deliberately shows a restricted-site
 * omission notice so the steward queue demonstrates the permitted-context
 * degradation without shipping a restricted identifier).
 */
export function seedFeedbackFixtures(): readonly FeedbackSubmission[] {
  const cleanQuery = 'v=1&f=distributionSystemIds%3Dsys-bear-river&e=-112.5600%2C41.0000%2C-111.0000%2C42.2000&s=sta-bear-corinne';
  const omittedQuery = 'v=1&f=siteTypeIds%3Dflume&e=-112.5600%2C41.0000%2C-111.0000%2C42.2000';
  return [
    {
      category: 'data-question',
      description:
        'The Bear River near Corinne chart shows a step change on the morning of March 9. Is that the documented telemetry outage, or should I treat the value as suspect?',
      screenshotRef: null,
      submittedBy: null,
      context: {
        contextVersion: 1,
        appVersion: '0.1.0',
        generatedAt: '2026-03-10T14:05:00Z',
        shareQuery: cleanQuery,
        shareUrl: cleanQuery,
        notices: [],
        redaction: { secretScan: 'clean', restrictedIdScan: 'clean' },
      },
    },
    {
      category: 'defect',
      description:
        'Filtering to flumes and selecting a site from my assignment list leaves the map centered on the whole state; the selected marker never appears. Reproduces every time from the linked view.',
      screenshotRef: 'att-screenshot-2026-03-10-001',
      submittedBy: 'principal-cody-commissioner',
      context: {
        contextVersion: 1,
        appVersion: '0.1.0',
        generatedAt: '2026-03-10T15:12:00Z',
        shareQuery: omittedQuery,
        shareUrl: omittedQuery,
        notices: [
          {
            kind: 'site-omitted',
            message: 'The selected site is not part of the public catalog; it was left out of the link.',
          },
        ],
        redaction: { secretScan: 'clean', restrictedIdScan: 'clean' },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface FeedbackServiceInput {
  /** REQUIRED injected clock (no hidden Date.now reads; determinism is tested). */
  readonly clock: () => Date | string;
  /** Injectable id generator; default is a per-store monotonic counter (fb-000001...). */
  readonly idGenerator?: () => string;
  /** Fixture seed (default: seedFeedbackFixtures(); pass [] for an empty store). */
  readonly seed?: readonly FeedbackSubmission[];
}

export interface FeedbackService {
  /** Validate and store. Rejections carry every violated rule, never a partial store write. */
  submit(submission: Readonly<FeedbackSubmission>): ValidationOutcome;
  /** Record by id (public projection: no steward-only fields beyond priority, which is public queue metadata). */
  get(id: string): FeedbackRecord | null;
  /** Steward queue view model: priority rank, then recency; secret re-scan included. */
  stewardQueue(): StewardQueue;
  /** Steward priority assignment (FR-018). The submitter field must be a steward-shaped principal id. */
  setPriority(id: string, priority: FeedbackPriority, steward: string): { ok: true; record: FeedbackRecord } | { ok: false; reason: 'unknown-record' | 'bad-steward' };
  /** Steward status transition. */
  setStatus(id: string, status: FeedbackStatus, steward: string): { ok: true; record: FeedbackRecord } | { ok: false; reason: 'unknown-record' | 'bad-steward' };
  /** Byte-stable serialization for the determinism test. */
  serialize(): string;
}

const STEWARD_PATTERN = /^principal-[a-z0-9-]*steward$/;

function toQueueRow(record: FeedbackRecord): StewardQueueRow {
  return {
    id: record.id,
    category: record.category,
    categoryLabel: FEEDBACK_CATEGORY_LABELS[record.category],
    priority: record.priority,
    priorityLabel: record.priority === 'unassigned' ? 'Unassigned' : FEEDBACK_PRIORITY_LABELS[record.priority],
    status: record.status,
    submittedAt: record.submittedAt,
    submittedByLabel: record.submittedBy ?? 'Anonymous',
    shareQuery: record.context.shareQuery,
    appVersion: record.context.appVersion,
    noticeKinds: record.context.notices.map((notice) => notice.kind),
    hasScreenshot: record.screenshotRef !== null,
    descriptionExcerpt: excerpt(record.description),
  };
}

export function createFeedbackService(input: FeedbackServiceInput): FeedbackService {
  const clock = input.clock;
  let counter = 0;
  const nextId = input.idGenerator ?? (() => `fb-${String((counter += 1)).padStart(6, '0')}`);
  const nowIso = (): string => {
    const now = clock();
    return typeof now === 'string' ? now : new Date((now as Date).getTime()).toISOString();
  };

  const records: FeedbackRecord[] = [];
  for (const submission of input.seed ?? seedFeedbackFixtures()) {
    const outcome = validateFeedbackSubmission(submission, { now: nowIso(), id: nextId() });
    if (!outcome.ok) throw new Error(`feedback fixture seed failed validation: ${outcome.errors.join(', ')}`);
    records.push(outcome.record);
  }

  return {
    submit(submission) {
      const outcome = validateFeedbackSubmission(submission, { now: nowIso(), id: nextId() });
      if (outcome.ok) records.push(outcome.record);
      return outcome;
    },

    get(id) {
      return records.find((record) => record.id === id) ?? null;
    },

    stewardQueue() {
      const rows = [...records]
        .sort((a, b) => {
          const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
          if (rank !== 0) return rank;
          return a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : a.id < b.id ? 1 : -1;
        })
        .map(toQueueRow);
      // Defense in depth: the queue must never hand the steward a secret.
      const secretFindings = scanForSecretShapes(rows, 'queue').map((finding) => `${finding.shape}:${finding.field}`);
      return { rows, secretFindings };
    },

    setPriority(id, priority, steward) {
      if (!STEWARD_PATTERN.test(steward)) return { ok: false, reason: 'bad-steward' };
      const index = records.findIndex((record) => record.id === id);
      if (index === -1) return { ok: false, reason: 'unknown-record' };
      const updated: FeedbackRecord = { ...records[index]!, priority, prioritizedBy: steward, prioritizedAt: nowIso(), status: records[index]!.status === 'new' ? 'triaged' : records[index]!.status };
      records[index] = updated;
      return { ok: true, record: updated };
    },

    setStatus(id, status, steward) {
      if (!STEWARD_PATTERN.test(steward)) return { ok: false, reason: 'bad-steward' };
      const index = records.findIndex((record) => record.id === id);
      if (index === -1) return { ok: false, reason: 'unknown-record' };
      const updated: FeedbackRecord = { ...records[index]!, status };
      records[index] = updated;
      return { ok: true, record: updated };
    },

    serialize() {
      return JSON.stringify(records, null, 0);
    },
  };
}
