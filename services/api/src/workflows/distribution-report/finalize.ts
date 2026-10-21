/**
 * R2 BOUNDARY - report finalization is NOT implemented here.
 *
 * FR-029 (R2): "Finalizing an accounting transaction or report prevents
 * in-place modification or deletion; an authorized correction creates a
 * linked reversal or superseding version while measurement corrections remain
 * separately possible." The technical specification ("Originals and
 * corrections") adds: "Model finalized accounting/report snapshots separately
 * from the revisable measurement stream: issue a superseding report or
 * compensating accounting entry, never rewrite a finalized transaction."
 *
 * WD-025 therefore delivers GENERATION only:
 * - generateReport produces a deterministic, provenance-labeled report with a
 *   content hash; nothing about it is final or immutable.
 * - ReportRegistry models regeneration as SUPERSESSION: a new version with a
 *   supersedes marker; prior report objects are never mutated. That is the
 *   shape finalization will build on, not finalization itself.
 * - No locked snapshot, no reversal linkage, no finalized-lifecycle state.
 *
 * The stub below exists so the boundary is executable and documented: any
 * attempt to finalize throws instead of silently pretending.
 */

export interface FinalizeRequest {
  readonly reportId: string;
  readonly actorId: string;
}

export interface FinalizedReport {
  readonly reportId: string;
  readonly finalizedAt: string;
  readonly locked: true;
}

/**
 * Intentionally throws: report finalization/immutability is the separate R2
 * task (FR-029). Until that lands, reports are regenerable and supersession
 * is the only versioning mechanism.
 */
export function finalizeReport(_request: FinalizeRequest): FinalizedReport {
  throw new Error('not implemented - R2 scope (FR-029)');
}
