/**
 * Known data issues for the operations workspace (FR-038).
 *
 * "Users record a known issue with affected stream and time interval, status
 * and visibility; affected charts and exports carry the permitted issue
 * context and resolution history."
 *
 * The seed world carries two synthetic issues anchored in the contract
 * fixtures, one per visibility class, so the visibility filter has a real
 * case on each side:
 *
 *  - ki-corinne-outage-20260308: PUBLIC issue on the public telemetry
 *    station sta-bear-corinne / str-corinne-q, its interval taken verbatim
 *    from the declared fixture gap gap-corinne-20260308 (six missing hourly
 *    readings, DST transition day). Visible in the public browse context and
 *    to every assigned viewer.
 *  - ki-hyrum-owner-weir-202603: INTERNAL issue on the restricted owner
 *    station sta-hyrum-diversion-owner / str-hyrum-q-owner (weekly weir
 *    board readings). Internal issues surface only where the entitlement
 *    engine allows an internal-class read of the station - an internal issue
 *    never becomes public merely because someone can see the row (FR-049
 *    field-class discipline; FR-038 visibility field).
 *
 * Both records carry resolution history (append-only events; FR-038
 * "resolution history"), and visibility filtering is POLICY-DRIVEN: the
 * `policy` evaluator decides per viewer and per instant, so a revoked grant
 * removes internal issue context on the next derivation exactly like it
 * removes the operational row itself.
 *
 * Pure module: fixtures in, verdicts out. No React, no clock, no storage.
 */
import type { PolicyEvaluator, PolicyFieldClass, PolicyPrincipalMirror, PolicyWorldMirror } from './assignedScope';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type KnownIssueStatus = 'open' | 'acknowledged' | 'resolved';

/** Issue visibility is its own governed field (FR-038), independent of station row visibility. */
export type KnownIssueVisibility = 'public' | 'internal';

export type ResolutionOutcome = 'acknowledged' | 'resolved' | 'reopened';

export interface IssueResolutionEvent {
  /** When the event was recorded. */
  readonly at: string;
  readonly actorId: string;
  readonly outcome: ResolutionOutcome;
  readonly note: string;
}

export interface KnownIssueRecord {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Affected station and stream (FR-038: "affected stream"). */
  readonly stationId: string;
  readonly streamId: string;
  /** Affected time interval, half-open [start, end) on observation time (FR-038: "time interval"). */
  readonly interval: { readonly start: string; readonly end: string };
  readonly status: KnownIssueStatus;
  readonly visibility: KnownIssueVisibility;
  readonly recordedAt: string;
  readonly recordedBy: string;
  /** Append-only resolution history, oldest first (FR-038: "resolution history"). */
  readonly resolutionHistory: readonly IssueResolutionEvent[];
}

/** A known issue with the viewer's entitlement verdict attached. */
export interface VisibleKnownIssue {
  readonly issue: KnownIssueRecord;
  readonly stationVisibility: PolicyFieldClass;
  /**
   * Why the issue is (or is not) carried: the engine decision reason for the
   * station read the visibility filter required. Absent on omitted issues.
   */
  readonly carriedByReason: string | null;
}

export interface KnownIssuesForViewer {
  /** Issues the viewer may carry, in fixture order (public first, then internal). */
  readonly carried: readonly VisibleKnownIssue[];
  /** Issues omitted for this viewer, with the engine denial reason. */
  readonly omitted: readonly (VisibleKnownIssue & { readonly denyReason: string })[];
}

// ---------------------------------------------------------------------------
// The two synthetic fixture issues
// ---------------------------------------------------------------------------

export const KNOWN_ISSUES: readonly KnownIssueRecord[] = [
  {
    id: 'ki-corinne-outage-20260308',
    title: 'Logger communications outage - six hourly readings missing',
    description:
      'Six consecutive hourly discharge readings are absent during a logger communications outage on the DST transition day. The missing readings are declared, not interpolated; coverage APIs must report the gap with estimated proportion and method.',
    stationId: 'sta-bear-corinne',
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-08T12:00:00Z', end: '2026-03-08T18:00:00Z' },
    status: 'acknowledged',
    visibility: 'public',
    recordedAt: '2026-03-08T19:12:00Z',
    recordedBy: 'principal-diego-steward',
    resolutionHistory: [
      {
        at: '2026-03-08T19:12:00Z',
        actorId: 'principal-diego-steward',
        outcome: 'acknowledged',
        note: 'Gap declared from source outage telemetry; upstream logger reconnect confirmed at 18:00. No back-fill.',
      },
    ],
  },
  {
    id: 'ki-hyrum-owner-weir-202603',
    title: 'Weir board readings suspect - owner reporting inconsistent boards',
    description:
      'The owning district reports weekly weir-board configurations inconsistent with the recorded stage-discharge pairs. Values remain provisional for the affected interval pending a joint field visit.',
    stationId: 'sta-hyrum-diversion-owner',
    streamId: 'str-hyrum-q-owner',
    interval: { start: '2026-02-16T07:00:00Z', end: '2026-03-09T07:00:00Z' },
    status: 'open',
    visibility: 'internal',
    recordedAt: '2026-03-02T16:40:00Z',
    recordedBy: 'principal-cody-commissioner',
    resolutionHistory: [
      {
        at: '2026-03-02T16:40:00Z',
        actorId: 'principal-cody-commissioner',
        outcome: 'acknowledged',
        note: 'Owner contact logged through the district office only; internal coordination note, not for public context.',
      },
      {
        at: '2026-03-06T21:05:00Z',
        actorId: 'principal-fatima-engineer',
        outcome: 'reopened',
        note: 'Field visit 2026-03-06 found the board mismatch persists; interval extended and issue back to open pending replacement boards.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Visibility filtering (policy-driven)
// ---------------------------------------------------------------------------

export interface KnownIssuesInput {
  readonly principalId: string | null;
  readonly world: PolicyWorldMirror;
  readonly policy: PolicyEvaluator;
  readonly now: Date | string;
  /** Default: the two synthetic fixture issues. */
  readonly issues?: readonly KnownIssueRecord[];
}

function stationReadDecision(
  issue: KnownIssueRecord,
  principal: PolicyPrincipalMirror | null,
  action: 'browse-published' | 'view-restricted-details',
  fieldClass: PolicyFieldClass,
  world: PolicyWorldMirror,
  policy: PolicyEvaluator,
  now: Date | string,
) {
  return policy({ principal, action, object: { kind: 'station', id: issue.stationId, fields: [fieldClass] } }, world, now);
}

/**
 * Which known issues this viewer may carry, and why the others are omitted.
 *
 * - A PUBLIC issue is carried when its station is currently published (the
 *   engine's public branch - anonymous viewers carry it) OR the viewer holds
 *   a protected read of the station.
 * - An INTERNAL issue is carried only when the engine allows an
 *   internal-class read of the station: an assignment over the station is
 *   necessary but NOT sufficient (FR-049), so the internal issue context
 *   follows the gate-code class, not the row.
 *
 * A favorited or browsed station never changes either verdict (favorites
 * carry no authority; FR-052).
 */
export function knownIssuesForViewer(input: KnownIssuesInput): KnownIssuesForViewer {
  const { world, policy, now } = input;
  const issues = input.issues ?? KNOWN_ISSUES;
  const principal = input.principalId !== null ? (world.principals[input.principalId] ?? null) : null;

  const carried: VisibleKnownIssue[] = [];
  const omitted: (VisibleKnownIssue & { readonly denyReason: string })[] = [];

  for (const issue of issues) {
    const station = world.objects[issue.stationId];
    const stationVisibility: PolicyFieldClass = station ? station.visibility : 'restricted';
    const base: VisibleKnownIssue = { issue, stationVisibility, carriedByReason: null };

    if (issue.visibility === 'public') {
      const publicDecision = stationReadDecision(issue, null, 'browse-published', 'public', world, policy, now);
      if (publicDecision.effect === 'allow') {
        carried.push({ ...base, carriedByReason: publicDecision.reason });
        continue;
      }
      if (principal !== null) {
        const protectedDecision = stationReadDecision(issue, principal, 'view-restricted-details', 'restricted', world, policy, now);
        if (protectedDecision.effect === 'allow') {
          carried.push({ ...base, carriedByReason: protectedDecision.reason });
          continue;
        }
        omitted.push({ ...base, denyReason: protectedDecision.reason });
        continue;
      }
      omitted.push({ ...base, denyReason: publicDecision.reason });
      continue;
    }

    // Internal issue context: internal-class read of the station or nothing.
    if (principal === null) {
      omitted.push({ ...base, denyReason: 'DENY_ANONYMOUS' });
      continue;
    }
    const internalDecision = stationReadDecision(issue, principal, 'view-restricted-details', 'internal', world, policy, now);
    if (internalDecision.effect === 'allow') {
      carried.push({ ...base, carriedByReason: internalDecision.reason });
    } else {
      omitted.push({ ...base, denyReason: internalDecision.reason });
    }
  }

  return { carried, omitted };
}

/** Human-facing status text (status is always text, never color alone). */
export function issueStatusText(status: KnownIssueStatus): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'acknowledged':
      return 'Acknowledged';
    case 'resolved':
      return 'Resolved';
  }
}

/**
 * Status implied by an append-only history: the latest event wins
 * (acknowledged -> acknowledged, resolved -> resolved, reopened -> open).
 * Tests assert the fixture records' static status equals this fold, so the
 * displayed status and the history can never disagree.
 */
export function statusFromHistory(history: readonly IssueResolutionEvent[]): KnownIssueStatus | null {
  const last = history.at(-1);
  if (!last) return null;
  return last.outcome === 'reopened' ? 'open' : last.outcome;
}
