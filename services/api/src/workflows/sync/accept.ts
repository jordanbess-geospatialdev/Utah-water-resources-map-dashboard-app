/**
 * The server-side sync endpoint domain (WD-012-R2, FR-027): accepts a
 * batch of offline drafts and returns ONE VERDICT PER DRAFT.
 *
 * "In airplane mode, authorized users save reading, visit, photo and audio
 * drafts; after reconnection each draft syncs once ... and routes
 * conflicts or revoked access for resolution without silent loss."
 *
 * Check order per draft (deliberate, exercised by the tests):
 *  1. session/draft actor agreement  -> rejected ACTOR_MISMATCH (the
 *     envelope's actor must be the authenticated session actor; identity
 *     is revalidated at sync time, never trusted from the device);
 *  2. SYNC LEDGER REPLAY             -> the recorded terminal verdict for
 *     this idempotency key (accepted verdicts replay with the original
 *     record id); this is what makes exactly-once hold across lost
 *     acknowledgements;
 *  3. WORKFLOW LEDGER PROBE          -> if the underlying readings/visits
 *     workflow already committed this key (the crash window between
 *     commit and ledger write), the workflow replays its recorded result;
 *     the sync ledger is then repaired with that verdict;
 *  4. quota                          -> a per-actor daily budget of
 *     accepted drafts; exhausted = a retryable quota verdict with
 *     retryAfter (NOT ledgered - nothing committed, a retry is legitimate);
 *  5. identity + assignment via the POLICY ENGINE at sync time -> typed
 *     rejection (GRANT_REVOKED / GRANT_EXPIRED / DELEGATION_EXPIRED /
 *     UNAUTHENTICATED / OUT_OF_SCOPE / FORBIDDEN); a revoked draft is
 *     terminally rejected and NEVER committed (ledgered - it stays
 *     rejected even if the grant later returns under a new version);
 *  6. base revision                  -> the draft's base revision must
 *     equal the target's CURRENT revision (readings: the stream's setup
 *     version in the authoritative readings store; visits: the site
 *     revision registry mirroring WD-010 site edits); a mismatch is a
 *     CONFLICT verdict - not an error, not a merge: the client preserves
 *     the draft verbatim and a human resolves it (NOT ledgered);
 *  7. commit through the EXISTING workflows (submitManualReading /
 *     createVisit) with the draft's idempotency key - their own policy
 *     evaluation, idempotency replay and validation produce the commit
 *     decision; the sync domain only maps it onto a verdict.
 *
 * Every verdict is audited. The module is pure: stores, actor, batch and
 * clock are injected; no clock reads, no randomness.
 */
import { evaluate, type AuthorizationRequest, type Capability, type Decision as PolicyDecision } from '../../../../../packages/policy/src/index.ts';
import type { AttachmentStorage } from '../visits/attachments.ts';
import { createVisit } from '../visits/visits.ts';
import type { CreateVisitInput, VisitDecision } from '../visits/types.ts';
import type { VisitStore } from '../visits/store.ts';
import { submitManualReading } from '../readings/manualEntry.ts';
import type { ManualEntryDecision, ManualEntryInput } from '../readings/types.ts';
import type { ReadingsStore } from '../readings/store.ts';
import { nextUtcMidnight, targetOf, verdictOutcome, type SyncStore } from './store.ts';
import type { OfflineSyncRequest, SyncAuditOutcome, SyncRejectionCode, SyncVerdict } from './types.ts';

/** The matrix verbs the revalidation consults (one per draft kind). */
export const SYNC_CAPABILITY: Readonly<Record<OfflineSyncRequest['kind'], Capability>> = {
  reading: 'enter-readings',
  visit: 'field-visits',
};

/** The stores and ports the sync endpoint commits through. */
export interface SyncDeps {
  readonly syncStore: SyncStore;
  readonly readingsStore: ReadingsStore;
  readonly visitStore: VisitStore;
  readonly attachmentStorage: AttachmentStorage;
}

/** Execution context: the injected clock of this sync call. */
export interface SyncContext {
  readonly now: string;
}

function accepted(recordId: string, replayed: boolean): SyncVerdict {
  return { kind: 'accepted', recordId, replayed };
}

function rejected(code: SyncRejectionCode, message: string, policyReason: string | null): SyncVerdict {
  return { kind: 'rejected', code, message, policyReason };
}

/**
 * Policy denial -> typed sync rejection. The engine's reason carries the
 * revocation/expiry distinction the client surfaces verbatim.
 */
function policyRejection(policy: PolicyDecision): SyncVerdict {
  switch (policy.reason) {
    case 'DENY_ASSIGNMENT_REVOKED':
      return rejected('GRANT_REVOKED', 'the grant backing this draft was revoked; the draft is rejected and retained on the device for audit visibility', policy.reason);
    case 'DENY_ASSIGNMENT_EXPIRED':
      return rejected('GRANT_EXPIRED', 'the grant backing this draft expired while the device was offline; the draft is rejected and retained for audit visibility', policy.reason);
    case 'DENY_DELEGATION_EXPIRED':
      return rejected('DELEGATION_EXPIRED', 'the deputy delegation window closed; the draft is rejected and retained for audit visibility', policy.reason);
    case 'DENY_ANONYMOUS':
    case 'DENY_UNKNOWN_PRINCIPAL':
    case 'DENY_PRINCIPAL_INACTIVE':
      return rejected('UNAUTHENTICATED', 'synchronization requires an authenticated, active principal', policy.reason);
    case 'DENY_OUT_OF_SCOPE':
      return rejected('OUT_OF_SCOPE', 'no current assignment covers the draft\'s target', policy.reason);
    case 'DENY_UNKNOWN_OBJECT':
      return rejected('NOT_FOUND', 'the draft\'s target does not exist', policy.reason);
    default:
      return rejected('FORBIDDEN', `synchronization denied (${policy.reason ?? 'unknown'})`, policy.reason);
  }
}

/** Map a readings-workflow rejection onto a typed sync verdict. */
function readingRejection(decision: Extract<ManualEntryDecision, { outcome: 'rejected' }>): SyncVerdict {
  if (decision.status === 401) return rejected('UNAUTHENTICATED', decision.message, decision.policyReason);
  if (decision.status === 404) return rejected('NOT_FOUND', decision.message, decision.policyReason);
  if (decision.status === 422) {
    return rejected('VALIDATION_FAILED', `${decision.message}: ${decision.fieldErrors.map((error) => `${error.fieldPath} (${error.code})`).join('; ')}`, decision.policyReason);
  }
  return rejected('FORBIDDEN', decision.message, decision.policyReason);
}

/** Map a visits-workflow rejection onto a typed sync verdict. */
function visitRejection(decision: Extract<VisitDecision, { outcome: 'rejected' }>): SyncVerdict {
  if (decision.status === 401) return rejected('UNAUTHENTICATED', decision.message, decision.policyReason);
  if (decision.status === 404) return rejected('NOT_FOUND', decision.message, decision.policyReason);
  if (decision.status === 422) {
    return rejected('VALIDATION_FAILED', `${decision.message}: ${decision.fieldErrors.map((error) => `${error.fieldPath} (${error.code})`).join('; ')}`, decision.policyReason);
  }
  return rejected('FORBIDDEN', decision.message, decision.policyReason);
}

function audit(syncStore: SyncStore, request: OfflineSyncRequest, verdict: SyncVerdict, now: string): void {
  const outcome: SyncAuditOutcome = verdictOutcome(verdict, verdict.kind === 'accepted' && verdict.replayed);
  const detail =
    verdict.kind === 'accepted'
      ? `committed as ${verdict.recordId}${verdict.replayed ? ' (idempotent replay)' : ''}`
      : verdict.kind === 'conflict'
        ? `captured against revision ${verdict.baseRevision}; target now at revision ${verdict.currentRevision}; routed for explicit resolution`
        : verdict.kind === 'quota'
          ? verdict.message
          : `${verdict.code}: ${verdict.message}`;
  syncStore.appendSyncAudit({
    draftId: request.draftId,
    idempotencyKey: request.idempotencyKey,
    kind: request.kind,
    actorId: request.actorId,
    siteId: request.siteId,
    outcome,
    detail,
    recordedAt: now,
  });
}

/**
 * Accept one batch of offline drafts. Verdicts return in request order.
 * Nothing here can partially apply a draft: each draft either commits
 * through its workflow in one logical transaction or produces a
 * non-committing verdict.
 */
export function acceptDrafts(
  deps: SyncDeps,
  sessionActorId: string,
  requests: readonly OfflineSyncRequest[],
  ctx: SyncContext,
): { verdicts: readonly SyncVerdict[] } {
  const { syncStore, readingsStore, visitStore, attachmentStorage } = deps;
  const verdicts: SyncVerdict[] = [];

  for (const request of requests) {
    // 1. identity: the envelope's actor must be the session actor.
    if (request.actorId !== sessionActorId) {
      const verdict = rejected('ACTOR_MISMATCH', `draft ${request.draftId} belongs to actor "${request.actorId}" but the session actor is "${sessionActorId}"; identity is revalidated at sync time`, null);
      audit(syncStore, request, verdict, ctx.now);
      verdicts.push(verdict);
      continue;
    }

    // 2. sync ledger replay: the terminal verdict this key already has.
    const ledgered = syncStore.lookupLedger(request.idempotencyKey);
    if (ledgered) {
      const verdict: SyncVerdict =
        ledgered.verdict.kind === 'accepted'
          ? accepted(ledgered.verdict.recordId, true)
          : ledgered.verdict;
      audit(syncStore, request, verdict, ctx.now);
      verdicts.push(verdict);
      continue;
    }

    // 3. workflow ledger probe: the workflow committed but the sync ledger
    //    write was lost (crash between commit and ack). Replay via the
    //    workflow and repair the sync ledger.
    const committedInWorkflow =
      request.kind === 'reading'
        ? readingsStore.lookupManualIdempotency(request.idempotencyKey) !== null
        : visitStore.lookupIdempotency(request.idempotencyKey) !== null;

    // 4. quota (skip when we are about to replay an existing commit).
    if (!committedInWorkflow && syncStore.quotaUsed(request.actorId, ctx.now) >= syncStore.perActorDailySyncQuota) {
      const used = syncStore.quotaUsed(request.actorId, ctx.now);
      const verdict: SyncVerdict = {
        kind: 'quota',
        message: `daily offline-sync budget exhausted for this account (${used}/${syncStore.perActorDailySyncQuota} drafts accepted today)`,
        retryAfter: nextUtcMidnight(ctx.now),
      };
      audit(syncStore, request, verdict, ctx.now);
      verdicts.push(verdict);
      continue;
    }

    // 5. identity + assignment revalidated at SYNC TIME via the policy engine.
    if (!committedInWorkflow) {
      const principal = request.kind === 'reading' ? readingsStore.world.principals[request.actorId] ?? null : visitStore.world.principals[request.actorId] ?? null;
      const targetId = targetOf(request);
      if (targetId === '') {
        const verdict = rejected('VALIDATION_FAILED', `a ${request.kind} draft requires its target ${request.kind === 'reading' ? 'stream' : 'site'}`, null);
        audit(syncStore, request, verdict, ctx.now);
        verdicts.push(verdict);
        continue;
      }
      const policyRequest: AuthorizationRequest = {
        principal,
        action: SYNC_CAPABILITY[request.kind],
        object: { kind: request.kind === 'reading' ? 'datastream' : 'station', id: targetId },
      };
      const world = request.kind === 'reading' ? readingsStore.world : visitStore.world;
      const policy = evaluate(policyRequest, world, ctx.now);
      if (policy.effect !== 'allow') {
        const verdict = policyRejection(policy);
        // Terminal and ledgered: a revoked draft stays rejected under this key.
        syncStore.recordLedger({
          idempotencyKey: request.idempotencyKey,
          draftId: request.draftId,
          actorId: request.actorId,
          kind: request.kind,
          verdict,
          recordedAt: ctx.now,
        });
        audit(syncStore, request, verdict, ctx.now);
        verdicts.push(verdict);
        continue;
      }
    }

    // 6. base revision (skip when replaying: the commit already happened).
    if (!committedInWorkflow) {
      const currentRevision =
        request.kind === 'reading'
          ? readingsStore.streamSetupVersion(request.streamId ?? '')
          : syncStore.siteRevision(request.siteId);
      if (request.baseRevision !== currentRevision) {
        const verdict: SyncVerdict = {
          kind: 'conflict',
          reason: 'BASE_REVISION_MOVED',
          baseRevision: request.baseRevision,
          currentRevision,
        };
        // NOT ledgered: nothing committed, and an explicit revision on the
        // current server state may legitimately retry under the same key.
        audit(syncStore, request, verdict, ctx.now);
        verdicts.push(verdict);
        continue;
      }
    }

    // 7. commit through the existing workflow (idempotent under the key).
    let verdict: SyncVerdict;
    if (request.kind === 'reading') {
      const decision = submitManualReading(readingsStore, request.actorId, request.payload as unknown as ManualEntryInput, {
        now: ctx.now,
        idempotencyKey: request.idempotencyKey,
      });
      if (decision.outcome === 'applied') {
        verdict = accepted(decision.record.id, decision.replayed);
        if (!decision.replayed) syncStore.chargeQuota(request.actorId, ctx.now);
      } else if (decision.outcome === 'idempotency-conflict') {
        verdict = rejected('IDEMPOTENCY_CONFLICT', `idempotency key "${request.idempotencyKey}" was recorded with a different body; the draft payload changed under a fixed key`, null);
      } else {
        verdict = readingRejection(decision);
      }
    } else {
      const decision = createVisit(visitStore, attachmentStorage, request.actorId, request.payload as unknown as CreateVisitInput, {
        now: ctx.now,
        idempotencyKey: request.idempotencyKey,
      });
      if (decision.outcome === 'applied') {
        verdict = accepted(decision.visit.id, decision.replayed);
        if (!decision.replayed) syncStore.chargeQuota(request.actorId, ctx.now);
      } else if (decision.outcome === 'conflict') {
        verdict = rejected('IDEMPOTENCY_CONFLICT', `idempotency key "${request.idempotencyKey}" was recorded with a different body; the draft payload changed under a fixed key`, null);
      } else {
        verdict = visitRejection(decision);
      }
    }

    // Terminal verdicts are ledgered (accepted and rejected alike); quota
    // and conflict verdicts never reach this line.
    if (verdict.kind === 'accepted' || verdict.kind === 'rejected') {
      syncStore.recordLedger({
        idempotencyKey: request.idempotencyKey,
        draftId: request.draftId,
        actorId: request.actorId,
        kind: request.kind,
        verdict,
        recordedAt: ctx.now,
      });
    }
    audit(syncStore, request, verdict, ctx.now);
    verdicts.push(verdict);
  }

  return { verdicts };
}
