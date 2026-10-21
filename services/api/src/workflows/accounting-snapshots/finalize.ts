/**
 * Immutable finalization of accounting records (WD-025-R2; FR-029; T-06/T-15).
 *
 * FR-029: "Finalizing an accounting transaction or report prevents in-place
 * modification or deletion; an authorized correction creates a linked
 * reversal or superseding version while measurement corrections remain
 * separately possible." The technical specification ("Originals and
 * corrections") adds: "Model finalized accounting/report snapshots
 * separately from the revisable measurement stream: issue a superseding
 * report or compensating accounting entry, never rewrite a finalized
 * transaction."
 *
 * Mechanics delivered here:
 * - FINALIZE AUTHORITY (approval-gated): finalize and reopen are gated by
 *   the shared entitlement engine, action review-data on the system policy
 *   object. 'review-data' is satisfied by an explicit review-data grant
 *   (an explicitly granted reviewer: the fixture commissioner Cody on Bear
 *   River, the deputy Ana inside her delegation window) or by
 *   statewide-administration (the steward Diego). The actor, the satisfying
 *   path and the assignment version are recorded on every finalized record.
 *
 *   OWNER-RATIFICATION-PENDING: mapping finalize/reopen onto the review-data
 *   row of the PROPOSED authorization matrix is a decision this module
 *   flags for owner ratification (the matrix itself is pending stakeholder
 *   ratification; no fixture grant names a finalize-specific capability).
 *   See FINALIZE_AUTHORITY_RULE echoed on every record.
 *
 * - OPTIMISTIC CONCURRENCY: every finalize/supersede request carries the
 *   finalized id the actor believes is CURRENT for the period slot
 *   (expectedCurrentId; null = the actor believes the slot is empty). When
 *   the ledger's current head differs, the caller receives the TYPED
 *   conflict FINALIZE_CONFLICT (409) carrying the actual current id - so
 *   two simultaneous finalizations of the same period resolve as one winner
 *   and one typed loser, never a lost update.
 * - SUPERSESSION, NEVER REWRITE: an authorized correction (reopen /
 *   finalize-new-version) appends a NEW finalized record with an explicit
 *   supersedes pointer and reason. The prior record's stored bytes - and
 *   therefore BOTH hashes (content hash and the record's serialization) -
 *   never change (the dual-hash test asserts them before and after).
 * - MEASUREMENT CORRECTIONS STAY INDEPENDENT: finalized accounting is
 *   modeled SEPARATELY from the revisable measurement stream; appending a
 *   WD-011 revision or a WD-011-R2 curve version touches no finalized hash
 *   (test-proven).
 *
 * Pure: injected world and clock; in-memory ledger; no I/O.
 */
import { evaluate, type Capability, type Decision, type PolicyWorld } from '../../../../../packages/policy/src/index.ts';
import type { DomainDenial } from '../../series/types.ts';
import { denial } from '../../series/types.ts';
import type { GeneratedReport } from '../distribution-report/types.ts';
import { canonicalize, sha256Hex } from '../distribution-report/generate.ts';
import {
  deepFreeze,
  type FinalizedAccounting,
  type FinalizedAuthorityEvidence,
  type FinalizedContent,
  type FinalizedRecordView,
  type LedgerEvent,
  type PeriodSpec,
} from './types.ts';
import type { DecisionSnapshot } from './types.ts';
import { periodKeyOf } from './periods.ts';

/** OWNER-RATIFICATION-PENDING: the finalize/reopen authority rule, recorded on every record. */
export const FINALIZE_AUTHORITY_RULE =
  'finalize/reopen requires review-data on the system object (the statewide steward via statewide-administration, or an explicitly granted reviewer) - RULE PENDING OWNER RATIFICATION' as const;

const FINALIZE_ACTION: Capability = 'review-data';
const STATEWIDE_ACTION: Capability = 'statewide-administration';

// ---------------------------------------------------------------------------
// Authority (policy engine; approval-gated, owner-ratification-pending)
// ---------------------------------------------------------------------------

export type FinalizeAuthorityResult = { outcome: 'authorized'; value: FinalizedAuthorityEvidence } | DomainDenial;

/** Hidden-object denial mapping, mirroring distribution-report/scope.ts. */
function mapDenial(systemId: string, policy: Decision): DomainDenial {
  if (
    policy.reason === 'DENY_ANONYMOUS' ||
    policy.reason === 'DENY_UNKNOWN_PRINCIPAL' ||
    policy.reason === 'DENY_PRINCIPAL_INACTIVE'
  ) {
    return {
      outcome: 'denied',
      status: 401,
      code: 'UNAUTHENTICATED',
      message: 'finalizing accounting requires an authenticated, active principal',
      policyReason: policy.reason,
    };
  }
  if (policy.reason === 'DENY_UNKNOWN_OBJECT') {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'system not found', policyReason: policy.reason };
  }
  if (policy.reason === 'DENY_OUT_OF_SCOPE') {
    // Hidden-object policy: a system outside the caller's assignment does not
    // exist for them. Systems are never public objects.
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'system not found', policyReason: policy.reason };
  }
  return {
    outcome: 'denied',
    status: 403,
    code: 'FORBIDDEN',
    message: `actor is not permitted to finalize accounting for this system (${policy.reason})`,
    policyReason: policy.reason,
  };
}

/**
 * Gate one finalize/reopen actor. OWNER-RATIFICATION-PENDING: the
 * review-data mapping is documented above; the engine decides, this
 * function only records HOW authority was satisfied.
 */
export function checkFinalizeAuthority(
  world: PolicyWorld,
  principalId: string | null,
  systemId: string,
  now: string,
): FinalizeAuthorityResult {
  const object = world.objects[systemId];
  if (!object) {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'system not found', policyReason: 'DENY_UNKNOWN_OBJECT' };
  }
  const principal = principalId ? (world.principals[principalId] ?? null) : null;
  const decision = evaluate({ principal, action: FINALIZE_ACTION, object: { kind: 'system', id: systemId } }, world, now);
  if (decision.effect !== 'allow') return mapDenial(systemId, decision);
  // Which satisfying path: statewide administration (the steward) or an
  // explicit review-data grant (granted reviewer / deputy).
  const statewide = evaluate({ principal, action: STATEWIDE_ACTION, object: { kind: 'system', id: systemId } }, world, now);
  return {
    outcome: 'authorized',
    value: {
      actorId: principalId ?? 'anonymous',
      via: statewide.effect === 'allow' ? 'statewide-administration' : 'review-data',
      assignmentVersion: decision.assignmentVersion,
      rule: FINALIZE_AUTHORITY_RULE,
    },
  };
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

/** Build finalization content from a WD-025 generated report (reuse, not recompute). */
export function finalizedContentFromReport(report: GeneratedReport): FinalizedContent {
  return deepFreeze({
    methodVersion: report.sections.formulas.methodVersion,
    policyVersion: report.sections.formulas.policyVersion,
    roundingPolicy: report.sections.formulas.roundingPolicy,
    noDoubleCountPolicy: report.sections.totals.noDoubleCountPolicy,
    categories: report.sections.totals.categories,
    sourceReportId: report.reportId,
    sourceContentHash: report.contentHash,
    notes: Object.freeze([`derived from WD-025 generated report ${report.reportId} v${report.version} (${report.period.basis} ${report.period.year}, basis ${report.processingBasis})`]),
  });
}

/** Build finalization content from a recorded decision snapshot's basis totals. */
export function finalizedContentFromDecision(decision: DecisionSnapshot): FinalizedContent {
  return deepFreeze({
    methodVersion: decision.calculationInputs.aggregationMethod,
    policyVersion: decision.calculationInputs.policyVersion,
    roundingPolicy: 'derived values are stored at full precision; presentation rounds volumes to 3 decimals and percentages to whole numbers; every total is summed from unrounded values and never re-summed from rounded ones',
    noDoubleCountPolicy: 'Totals are reported per accounting category and are never summed across categories.',
    categories: decision.basisTotals,
    sourceReportId: null,
    sourceContentHash: null,
    notes: Object.freeze([`derived from decision snapshot ${decision.decisionId} (evidence ${decision.evidenceHash})`]),
  });
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export interface FinalizeRequest {
  readonly systemId: string;
  readonly period: PeriodSpec;
  readonly decisionId: string | null;
  readonly content: FinalizedContent;
  readonly actorId: string | null;
  /**
   * Optimistic guard: the finalized id the actor believes is CURRENT for
   * this period slot (null = the actor believes the slot is empty).
   */
  readonly expectedCurrentId: string | null;
  readonly now: string;
}

export interface SupersedeRequest extends FinalizeRequest {
  /** Required justification, retained verbatim on the superseding record. */
  readonly reason: string;
}

export type FinalizeOutcome =
  | { readonly outcome: 'finalized'; readonly record: FinalizedAccounting; readonly view: FinalizedRecordView; readonly replayed: boolean }
  | {
      readonly outcome: 'conflict';
      readonly code: 'FINALIZE_CONFLICT';
      readonly status: 409;
      readonly message: string;
      readonly periodKey: string;
      /** The ACTUAL current finalized id of the slot (what the actor must retry against). */
      readonly currentFinalizedId: string | null;
    }
  | DomainDenial;

/** Canonical slot key helper re-export (system + period). */
export { periodKeyOf };

/**
 * In-memory ledger of finalized accounting records.
 *
 * Invariants (all test-enforced):
 * - a stored record is FROZEN and is never mutated, replaced-in-place or
 *   removed; supersession appends a linked record only;
 * - at most ONE non-superseded record occupies a period slot at any time
 *   (enforced by the optimistic guard);
 * - finalized accounting lives HERE, separate from the measurement stream:
 *   no revision append or curve version can reach these bytes.
 */
export class FinalizedLedger {
  private readonly records = new Map<string, FinalizedAccounting>();
  private readonly slots = new Map<string, string[]>();
  private readonly eventsLog: LedgerEvent[] = [];

  /** The current (non-superseded) head record id of a period slot. */
  private headIdOf(periodKey: string): string | null {
    return this.slots.get(periodKey)?.at(-1) ?? null;
  }

  private buildRecord(request: FinalizeRequest, authority: FinalizedAuthorityEvidence, supersedes: string | null, reason: string | null): FinalizedAccounting {
    const periodKey = periodKeyOf(request.systemId, request.period);
    const contentHash = sha256Hex(
      canonicalize({
        schemaVersion: 'accounting-snapshots@1',
        kind: 'finalized-content@1',
        systemId: request.systemId,
        periodKey,
        decisionId: request.decisionId,
        content: request.content,
      }),
    );
    const id = `fin-${sha256Hex(canonicalize({ contentHash, supersedes, supersedeReason: reason, finalizedAt: request.now, finalizedBy: authority.actorId })).slice(0, 12)}`;
    return deepFreeze({
      schemaVersion: 'accounting-snapshots@1',
      id,
      systemId: request.systemId,
      period: request.period,
      periodKey,
      decisionId: request.decisionId,
      content: request.content,
      contentHash,
      finalizedBy: authority.actorId,
      finalizedAt: request.now,
      status: 'finalized',
      supersedes,
      supersedeReason: reason,
      authority,
    });
  }

  /** Authority + optimistic-guard check shared by finalize and finalizeSuperseding. */
  private guard(world: PolicyWorld, request: FinalizeRequest): { outcome: 'ok'; authority: FinalizedAuthorityEvidence } | FinalizeOutcome {
    const authority = checkFinalizeAuthority(world, request.actorId, request.systemId, request.now);
    if (authority.outcome === 'denied') return authority;
    const periodKey = periodKeyOf(request.systemId, request.period);
    const headId = this.headIdOf(periodKey);
    if (request.expectedCurrentId !== headId) {
      return {
        outcome: 'conflict',
        code: 'FINALIZE_CONFLICT',
        status: 409,
        message:
          headId === null
            ? `stale finalize: the period slot is empty; expected ${request.expectedCurrentId} to be current`
            : `stale finalize: the current finalized record of this period is ${headId}; expected ${request.expectedCurrentId ?? 'an empty slot'}`,
        periodKey,
        currentFinalizedId: headId,
      };
    }
    return { outcome: 'ok', authority: authority.value };
  }

  /**
   * Finalize report content into the period slot. Idempotent: re-sending the
   * SAME content with the correct expectedCurrentId replays the stored
   * record instead of creating a version (no content, no supersession).
   */
  finalize(world: PolicyWorld, request: FinalizeRequest): FinalizeOutcome {
    const guard = this.guard(world, request);
    if (guard.outcome !== 'ok') return guard;
    const periodKey = periodKeyOf(request.systemId, request.period);
    const headId = this.headIdOf(periodKey);

    const candidate = this.buildRecord(request, guard.authority, null, null);
    if (headId !== null) {
      const head = this.records.get(headId);
      if (head && head.contentHash === candidate.contentHash) {
        // Identical content, correct guard: replay (idempotent finalization).
        this.eventsLog.push(
          deepFreeze({
            id: this.nextEventId(),
            kind: 'replayed',
            periodKey,
            recordId: head.id,
            supersededRecordId: null,
            actorId: request.actorId ?? 'anonymous',
            recordedAt: request.now,
            reason: null,
          }),
        );
        return { outcome: 'finalized', record: head, view: this.viewOf(head.id)!, replayed: true };
      }
      return {
        outcome: 'conflict',
        code: 'FINALIZE_CONFLICT',
        status: 409,
        message: `the period slot already holds finalized record ${headId}; different content must be superseded explicitly (finalizeSuperseding)`,
        periodKey,
        currentFinalizedId: headId,
      };
    }

    this.records.set(candidate.id, candidate);
    this.slots.set(periodKey, [...(this.slots.get(periodKey) ?? []), candidate.id]);
    this.eventsLog.push(
      deepFreeze({
        id: this.nextEventId(),
        kind: 'finalized',
        periodKey,
        recordId: candidate.id,
        supersededRecordId: null,
        actorId: request.actorId ?? 'anonymous',
        recordedAt: request.now,
        reason: null,
      }),
    );
    return { outcome: 'finalized', record: candidate, view: this.viewOf(candidate.id)!, replayed: false };
  }

  /**
   * The authorized correction path (FR-029): reopen by finalizing a NEW
   * version. Appends a record with an explicit supersedes pointer and
   * reason; the superseded record's stored bytes - contentHash included -
   * NEVER change.
   */
  finalizeSuperseding(world: PolicyWorld, request: SupersedeRequest): FinalizeOutcome {
    if (request.reason.trim() === '') {
      return denial(422, 'INVALID_REASON', 'a superseding finalization must carry a non-empty reason');
    }
    const guard = this.guard(world, request);
    if (guard.outcome !== 'ok') return guard;
    const periodKey = periodKeyOf(request.systemId, request.period);
    const headId = this.headIdOf(periodKey);
    if (headId === null) {
      return denial(422, 'NOTHING_TO_SUPERSEDE', 'the period slot holds no finalized record to supersede; finalize first');
    }

    const candidate = this.buildRecord(request, guard.authority, headId, request.reason);
    if (candidate.contentHash === this.records.get(headId)?.contentHash) {
      return denial(422, 'UNCHANGED_CONTENT', 'the superseding content is identical to the current record; a correction must change the accounting content');
    }

    // Append only: the prior record is NOT touched (dual-hash stability).
    this.records.set(candidate.id, candidate);
    this.slots.set(periodKey, [...(this.slots.get(periodKey) ?? []), candidate.id]);
    this.eventsLog.push(
      deepFreeze({
        id: this.nextEventId(),
        kind: 'superseded',
        periodKey,
        recordId: candidate.id,
        supersededRecordId: headId,
        actorId: request.actorId ?? 'anonymous',
        recordedAt: request.now,
        reason: request.reason,
      }),
    );
    return { outcome: 'finalized', record: candidate, view: this.viewOf(candidate.id)!, replayed: false };
  }

  private nextEventId(): string {
    return `ledger-${String(this.eventsLog.length + 1)}`;
  }

  /** Derived lifecycle view of one record (projects superseded; stored bytes stay frozen). */
  viewOf(id: string): FinalizedRecordView | null {
    const record = this.records.get(id);
    if (!record) return null;
    const chain = this.slots.get(record.periodKey) ?? [];
    const index = chain.indexOf(id);
    const supersededBy = index >= 0 && index < chain.length - 1 ? (chain[index + 1] ?? null) : null;
    return {
      accounting: supersededBy === null ? record : deepFreeze({ ...record, status: 'superseded' }),
      supersededBy,
      ordinal: index + 1,
    };
  }

  /** The current (non-superseded) view of a period slot. */
  currentFor(periodKey: string): FinalizedRecordView | null {
    const headId = this.headIdOf(periodKey);
    return headId === null ? null : this.viewOf(headId);
  }

  /** All stored records as views, stable order (slot chain, then id). */
  list(): readonly FinalizedRecordView[] {
    return Object.freeze(
      [...this.records.values()]
        .sort((a, b) => (a.finalizedAt === b.finalizedAt ? (a.id < b.id ? -1 : 1) : a.finalizedAt < b.finalizedAt ? -1 : 1))
        .map((record) => this.viewOf(record.id))
        .filter((view): view is FinalizedRecordView => view !== null),
    );
  }

  /**
   * The EXACT canonical bytes of the stored record. Supersession never
   * changes these (the dual-hash test asserts byte identity before and
   * after a supersession).
   */
  storedBytes(id: string): string | null {
    const record = this.records.get(id);
    return record === undefined ? null : canonicalize(record);
  }

  /** Audit trail (frozen copies). */
  get events(): readonly LedgerEvent[] {
    return Object.freeze([...this.eventsLog]);
  }
}
