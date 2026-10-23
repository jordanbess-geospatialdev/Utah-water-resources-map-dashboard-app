/**
 * Known data issues (WD-013; FR-038).
 *
 * "Users record a known issue with affected stream and time interval, status
 * and visibility; affected charts and exports carry the permitted issue
 * context and resolution history."
 *
 * MODEL:
 *
 * - A KNOWN ISSUE binds one stream + half-open time interval, a status
 *   (open / monitoring / resolved), a VISIBILITY (public / internal) and an
 *   append-only RESOLUTION HISTORY. Recording and status changes are scoped
 *   issue-management actions: every mutation goes through the policy
 *   engine (action `record-data-issues` on the stream's own policy object, so the
 *   server-side system scope decides - an actor without record-data-issues is
 *   denied 403, a system-scoped issue operator may record issues on streams
 *   inside their system, the statewide steward anywhere).
 * - STATUS TRANSITIONS: open -> monitoring -> resolved, with open ->
 *   resolved and the reopen paths (monitoring -> open, resolved ->
 *   monitoring) allowed; everything else is an invalid transition. Each
 *   change APPENDS a resolution event (seq, at, actor, from, to, note);
 *   prior events are never rewritten - verified by the lifecycle test.
 * - VISIBILITY: PUBLIC issues are listable by anyone (anonymous included);
 *   INTERNAL issues only through the narrow internal read path
 *   (`view-internal-diagnostics` on the stream object - the same engine
 *   verdict as the diagnostics view, FR-036 alignment).
 * - EXPORT CONTEXT: charts and exports carry the issues overlapping the
 *   exported interval, visibility-filtered per the caller: public exports
 *   (anonymous or any user without internal read) see public issues ONLY -
 *   the export-context sweep test byte-scans for the internal title - while
 *   authorized exports carry both.
 *
 * Purity: injected clock, no I/O; ids and timestamps are deterministic.
 */
import { gateAct, governanceObject, instantIso, withExtraObjects } from '../stewardship/gate.ts';
import type { PolicyDeps, StreamDenial } from './subscriptions.ts';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const KNOWN_ISSUE_STATUSES = ['open', 'monitoring', 'resolved'] as const;
export type KnownIssueStatus = (typeof KNOWN_ISSUE_STATUSES)[number];

export type KnownIssueVisibility = 'public' | 'internal';

/** Legal status transitions (everything else is an invalid transition). */
export const STATUS_TRANSITIONS: Readonly<Record<KnownIssueStatus, readonly KnownIssueStatus[]>> = Object.freeze({
  open: ['monitoring', 'resolved'],
  monitoring: ['open', 'resolved'],
  resolved: ['monitoring'],
});

export interface ResolutionEvent {
  readonly seq: number;
  readonly at: string;
  readonly actorId: string;
  readonly from: KnownIssueStatus;
  readonly to: KnownIssueStatus;
  readonly note: string;
}

export interface KnownIssue {
  readonly id: string;
  readonly streamId: string;
  /** Half-open [start, end) affected interval, ISO instants. */
  readonly interval: { readonly start: string; readonly end: string };
  readonly title: string;
  readonly description: string;
  readonly status: KnownIssueStatus;
  readonly visibility: KnownIssueVisibility;
  readonly recordedBy: string;
  readonly recordedAt: string;
  /** Append-only: every status change appends; nothing is ever rewritten. */
  readonly resolutionHistory: readonly ResolutionEvent[];
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
}

/** The issue context a chart or export carries (visibility-filtered upstream). */
export interface ExportIssueContext {
  readonly issueId: string;
  readonly title: string;
  readonly status: KnownIssueStatus;
  readonly interval: { readonly start: string; readonly end: string };
  readonly visibility: KnownIssueVisibility;
}

export type RecordErrorCode = 'unknown-stream' | 'bad-interval' | 'bad-title' | 'bad-visibility';

export interface KnownIssueDeps extends PolicyDeps {}

export interface KnownIssueService {
  recordIssue(principalId: string | null, input: { readonly streamId: string; readonly interval: { readonly start: string; readonly end: string }; readonly title: string; readonly description?: string; readonly visibility: KnownIssueVisibility | string }): { ok: true; issue: KnownIssue } | { ok: false; errors: readonly RecordErrorCode[] } | StreamDenial;
  updateStatus(principalId: string | null, issueId: string, to: KnownIssueStatus | string, note: string): { ok: true; issue: KnownIssue } | { ok: false; errors: readonly ('unknown-issue' | 'invalid-transition' | 'bad-status')[] } | StreamDenial;
  /** Visibility-filtered list for the acting persona (anonymous: public issues only). */
  listIssues(principalId: string | null): readonly KnownIssue[];
  /** Issues overlapping an exported interval, visibility-filtered per the caller (FR-038 export context). */
  issueContextForExport(principalId: string | null, selector: { readonly streamId: string; readonly start: string; readonly end: string }): readonly ExportIssueContext[];
  issues(): readonly KnownIssue[];
}

export function createKnownIssueService(deps: KnownIssueDeps): KnownIssueService {
  const issues: KnownIssue[] = [];
  let counter = 0;
  const now = (): string => instantIso(deps.clock());

  const streamObject = (streamId: string) => deps.world.objects[streamId] ?? null;

  /** record-data-issues gate on the stream's own policy object (server-side scope). */
  const gateReview = (principalId: string | null, streamId: string): StreamDenial | null => {
    const object = streamObject(streamId);
    // An unknown stream still gates as an internal governance object so a
    // steward reaches the validation errors while everyone else is denied.
    const anchor = object ?? governanceObject({ id: streamId, kind: 'datastream' });
    const world = object ? deps.world : withExtraObjects(deps.world, [anchor]);
    const verdict = gateAct({ world, clock: deps.clock, policy: deps.policy }, principalId, 'record-data-issues', { kind: 'datastream', id: streamId });
    if (verdict.ok) return null;
    return { ok: false, status: verdict.status, reason: verdict.reason, detail: verdict.decision.detail ?? '', decision: verdict.decision };
  };

  /**
   * INTERNAL issue visibility: the narrow internal read path on the stream
   * object (view-internal-diagnostics / statewide administration) - the same
   * verdict the FR-036 diagnostics view uses. Deliberately NOT the public
   * branch: an internal issue on a public stream stays internal.
   */
  const maySeeInternalIssue = (principalId: string | null, streamId: string): boolean => {
    const object = deps.world.objects[streamId];
    if (!object || object.kind !== 'datastream') return false;
    return gateAct({ world: deps.world, clock: deps.clock, policy: deps.policy }, principalId, 'view-internal-diagnostics', { kind: 'datastream', id: streamId }).ok;
  };

  const visibleTo = (principalId: string | null, issue: KnownIssue): boolean =>
    issue.visibility === 'public' || maySeeInternalIssue(principalId, issue.streamId);

  return {
    recordIssue(principalId, input) {
      const denial = gateReview(principalId, input?.streamId ?? '');
      if (denial) return denial;
      const errors: RecordErrorCode[] = [];
      const stream = streamObject(input?.streamId ?? '');
      if (!stream || stream.kind !== 'datastream') errors.push('unknown-stream');
      if (!input?.interval || typeof input.interval.start !== 'string' || typeof input.interval.end !== 'string' || Date.parse(input.interval.start) >= Date.parse(input.interval.end)) errors.push('bad-interval');
      if (typeof input?.title !== 'string' || input.title.trim().length === 0) errors.push('bad-title');
      if (input?.visibility !== 'public' && input?.visibility !== 'internal') errors.push('bad-visibility');
      if (errors.length > 0) return { ok: false, errors };

      const issue: KnownIssue = Object.freeze({
        id: `issue-${String((counter += 1)).padStart(6, '0')}`,
        streamId: input.streamId,
        interval: Object.freeze({ start: input.interval.start, end: input.interval.end }),
        title: input.title.trim(),
        description: input.description ?? '',
        status: 'open',
        visibility: input.visibility,
        recordedBy: principalId ?? '',
        recordedAt: now(),
        resolutionHistory: [],
        resolvedAt: null,
        resolvedBy: null,
      });
      issues.push(issue);
      return { ok: true, issue };
    },

    updateStatus(principalId, issueId, to, note) {
      const issue = issues.find((candidate) => candidate.id === issueId);
      const denial = gateReview(principalId, issue?.streamId ?? 'unknown-stream');
      if (denial) return denial;
      if (!issue) return { ok: false, errors: ['unknown-issue'] as const };
      if (!(KNOWN_ISSUE_STATUSES as readonly string[]).includes(to)) return { ok: false, errors: ['bad-status'] as const };
      const next = to as KnownIssueStatus;
      if (!STATUS_TRANSITIONS[issue.status].includes(next)) return { ok: false, errors: ['invalid-transition'] as const };

      const at = now();
      const event: ResolutionEvent = Object.freeze({
        seq: issue.resolutionHistory.length + 1,
        at,
        actorId: principalId ?? '',
        from: issue.status,
        to: next,
        note,
      });
      const updated: KnownIssue = Object.freeze({
        ...issue,
        status: next,
        resolutionHistory: Object.freeze([...issue.resolutionHistory, event]),
        resolvedAt: next === 'resolved' ? at : null,
        resolvedBy: next === 'resolved' ? principalId ?? '' : null,
      });
      issues[issues.indexOf(issue)] = updated;
      return { ok: true, issue: updated };
    },

    listIssues(principalId) {
      return issues.filter((issue) => visibleTo(principalId, issue));
    },

    issueContextForExport(principalId, selector) {
      return issues
        .filter((issue) => issue.streamId === selector.streamId)
        .filter((issue) => Date.parse(issue.interval.start) < Date.parse(selector.end) && Date.parse(issue.interval.end) > Date.parse(selector.start))
        .filter((issue) => visibleTo(principalId, issue))
        .map((issue) => ({ issueId: issue.id, title: issue.title, status: issue.status, interval: issue.interval, visibility: issue.visibility }));
    },

    issues() {
      return [...issues];
    },
  };
}
