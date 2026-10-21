/**
 * Type vocabulary for the WD-025-R2 accounting-snapshots domain
 * (FR-028 decision evidence, FR-029 immutable finalization, FR-030
 * flexible periods and advisory supplemental context).
 *
 * Source of truth:
 * - docs/product/baseline/01-product-requirements.md:
 *   FR-028 "A saved distribution decision references the exact observation
 *   or revision versions used; later corrections do not change those
 *   referenced values or the decision's recorded calculation inputs."
 *   FR-029 "Finalizing an accounting transaction or report prevents in-place
 *   modification or deletion; an authorized correction creates a linked
 *   reversal or superseding version while measurement corrections remain
 *   separately possible."
 *   FR-030 "A configured season or custom water year, including a mid-month
 *   boundary, selects the correct fixture observations; supplemental use is
 *   compared only against approved inputs and is labelled advisory until
 *   accounting semantics are approved."
 * - docs/product/baseline/02-technical-specification.md, "Originals and
 *   corrections": "Model finalized accounting/report snapshots separately
 *   from the revisable measurement stream: issue a superseding report or
 *   compensating accounting entry, never rewrite a finalized transaction."
 *
 * Reuse contract (this module NEVER reimplements numerics or policy):
 * - every derived volume comes from the WD-008 aggregation domain
 *   (../../series/aggregate.ts, rectangle-right@1), reached through the
 *   same per-stream calls the WD-025 report generator makes;
 * - finalize/reopen authority is the shared entitlement engine
 *   (packages/policy, action review-data on the system object) - see
 *   finalize.ts for the OWNER-RATIFICATION-PENDING note;
 * - rating-curve lineage ids come from the WD-011-R2 store
 *   (../rating-curves/store.ts), revision evidence from the WD-011
 *   revision store (../revisions/store.ts).
 *
 * Pure domain types only: no HTTP framework, no I/O, no clock reads.
 */

import type { AccountingCategory } from '../../summaries/totals.ts';
import type { ProcessingBasis } from '../../series/types.ts';

/** Schema identity of the snapshot serialization (part of every hash preimage). */
export const SNAPSHOT_SCHEMA_VERSION = 'accounting-snapshots@1' as const;

// ---------------------------------------------------------------------------
// Flexible periods (FR-030)
// ---------------------------------------------------------------------------

/** The four governed period kinds. The first three reuse the WD-025 bases; custom is R2. */
export type PeriodKind = 'calendar-year' | 'water-year' | 'irrigation-season' | 'custom';

/**
 * A flexible accounting period.
 *
 * - calendar-year / water-year / irrigation-season resolve through the SAME
 *   date rules as the WD-025 report generator (series/zone.ts seasonWindow;
 *   documented defaults pending measurement-owner ratification);
 * - custom carries EXPLICIT half-open [start, end) UTC instants, so a
 *   mid-month boundary (e.g. a water year starting March 15) or any other
 *   owner-configured season is expressible without touching the governed
 *   bases. `label` documents why the custom window exists (shown in the UI).
 */
export type PeriodSpec =
  | { readonly kind: 'calendar-year'; readonly year: number }
  | { readonly kind: 'water-year'; readonly year: number }
  | { readonly kind: 'irrigation-season'; readonly year: number }
  | {
      readonly kind: 'custom';
      readonly start: string;
      readonly end: string;
      readonly label: string;
    };

/** A resolved period: explicit half-open UTC instants plus visible boundary rules. */
export interface ResolvedPeriod {
  readonly kind: PeriodKind;
  /** The period year (null for custom windows). */
  readonly year: number | null;
  /** UTC instant, INCLUSIVE local boundary of the window. */
  readonly start: string;
  /** UTC instant, EXCLUSIVE end of the window. */
  readonly end: string;
  /** Human- and machine-readable date rule carried by every snapshot. */
  readonly dateRule: string;
  readonly timeZone: string;
  /** Whole local days spanned by the window. */
  readonly localDayCount: number;
  /** Local days that are not 86 400 s (DST spring-forward 82 800 / fall-back 90 000). */
  readonly dstDayAdjustments: readonly DstDayAdjustment[];
}

export interface DstDayAdjustment {
  /** Local calendar day key YYYY-MM-DD (America/Denver). */
  readonly date: string;
  /** Actual local day duration in seconds (82 800 or 90 000 on US DST days). */
  readonly daySeconds: number;
  readonly note: string;
}

// ---------------------------------------------------------------------------
// Decision evidence (FR-028)
// ---------------------------------------------------------------------------

/**
 * ONE observation pinned by a decision, with the EXACT revision version the
 * decision rested on at the selected basis. Later corrections append new
 * chain versions; they can never change this row (the snapshot is frozen at
 * recording time and the test suite proves byte-identity under appends).
 */
export interface ReferencedObservation {
  readonly observationId: string;
  readonly logicalKey: string;
  readonly streamId: string;
  readonly observedAt: string;
  /** The pinned revision id USED at the selected basis; null = the raw original value. */
  readonly revisionId: string | null;
  /** Chain version used (0 = raw original). */
  readonly usedVersion: number;
  /** Chain HEAD at recording time (may be later than the version used below the best-available basis). */
  readonly headRevisionId: string | null;
  /** Chain length at recording time. */
  readonly chainVersion: number;
  /** Processing level of the pinned value ('raw' when the original value is used). */
  readonly usedProcessingLevel: string;
  /** The pinned value (revision value, or the raw observation when no revision reached the basis). */
  readonly value: number | null;
  readonly unitId: string;
  /** True when no revision reached the selected basis and the raw value was shown instead. */
  readonly belowSelectedBasis: boolean;
}

/**
 * Rating-curve lineage pinned per stream (FR-045 lineage ids, reused from
 * the WD-011-R2 store): the approved curve/shift versions whose half-open
 * effective intervals overlap the period, plus the version in force at the
 * period start. A later curve supersession appends versions; it never
 * rewrites this row.
 */
export interface CurveLineageEntry {
  readonly streamId: string;
  readonly stationId: string;
  /** Approved curve version ids overlapping the period, chronological order. */
  readonly curveVersionIds: readonly string[];
  /** Approved shift version ids overlapping the period (empty in the fixture world). */
  readonly shiftVersionIds: readonly string[];
  /** Curve version in force at the period start instant; null when none covers it. */
  readonly curveAtStart: string | null;
  /** Fitting-method label of curveAtStart ('' when none). */
  readonly method: string;
}

/** Method and input versions a decision recorded (FR-028 "recorded calculation inputs"). */
export interface CalculationInputs {
  readonly processingBasis: ProcessingBasis;
  /** WD-008 aggregation method (rectangle-right@1) - every derived number carries it. */
  readonly aggregationMethod: string;
  /** Entitlement engine version consulted for the recording gate. */
  readonly policyVersion: string;
  /** Period date rule in force. */
  readonly periodRule: string;
  /** Fitting-method labels of the pinned curve versions, sorted. */
  readonly curveMethods: readonly string[];
  /** Supplemental policy pinned with the decision (advisory, approved-inputs-only). */
  readonly supplementalPolicy: string;
}

/** One governed accounting category total the decision rested on (never summed across categories). */
export interface DecisionCategoryTotal {
  readonly category: AccountingCategory;
  readonly label: string;
  readonly streamIds: readonly string[];
  readonly volumeAcreFeet: number;
  readonly volumeUnit: 'acre-feet';
  readonly coveredSeconds: number;
  readonly durationSeconds: number;
  readonly coverageFraction: number;
  readonly estimatedSeconds: number;
  readonly estimatedProportion: number;
}

/**
 * A saved distribution decision: EXACT observation/revision evidence, curve
 * lineage, calculation inputs, and the totals the decision rested on,
 * frozen at decidedAt. The record is a value object: recording the same
 * decision against the same stores and clock yields byte-identical bytes.
 */
export interface DecisionSnapshot {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly decisionId: string;
  readonly systemId: string;
  readonly period: PeriodSpec;
  readonly resolvedPeriod: Readonly<Pick<ResolvedPeriod, 'start' | 'end' | 'dateRule' | 'timeZone'>>;
  readonly decidedBy: string;
  readonly decidedAt: string;
  /** The decision statement, pinned verbatim. */
  readonly statement: string;
  readonly calculationInputs: CalculationInputs;
  readonly referencedObservations: readonly ReferencedObservation[];
  readonly curveLineage: readonly CurveLineageEntry[];
  readonly basisTotals: readonly DecisionCategoryTotal[];
  /** sha256 over the canonical serialization of the evidence (not decidedAt). */
  readonly evidenceHash: string;
}

// ---------------------------------------------------------------------------
// Finalized accounting (FR-029)
// ---------------------------------------------------------------------------

/** Lifecycle of a finalized record. Stored bytes are authored 'finalized' and never rewritten. */
export type FinalizedLifecycle = 'finalized' | 'superseded';

/**
 * The frozen content of a finalization: category-separated totals plus the
 * method versions that produced them and (when derived from one) the
 * WD-025 generated report it came from. Supplied by the caller; hashed and
 * frozen by the ledger at finalize time.
 */
export interface FinalizedContent {
  readonly methodVersion: string;
  readonly policyVersion: string;
  readonly roundingPolicy: string;
  readonly noDoubleCountPolicy: string;
  readonly categories: readonly DecisionCategoryTotal[];
  /** WD-025 report id this content was derived from, when it was. */
  readonly sourceReportId: string | null;
  /** The WD-025 report contentHash at derivation time, when derived from one. */
  readonly sourceContentHash: string | null;
  readonly notes: readonly string[];
}

/** How finalize authority was satisfied, recorded on every finalized record. */
export interface FinalizeAuthorityEvidence {
  readonly actorId: string;
  /** 'statewide-administration' (the steward) or an explicit 'review-data' grant (granted reviewer). */
  readonly via: 'review-data' | 'statewide-administration';
  readonly assignmentVersion: number;
  /**
   * OWNER-RATIFICATION-PENDING: mapping finalize/reopen authority onto the
   * review-data row of the proposed authorization matrix is approval-gated
   * and flagged pending owner ratification (see finalize.ts).
   */
  readonly rule: string;
}

/**
 * A finalized accounting record. IMMUTABLE BY CONSTRUCTION: the ledger
 * freezes the record at creation; supersession writes a NEW record with an
 * explicit `supersedes` pointer and never edits a stored byte (the dual-hash
 * test asserts both hashes before and after). `status` is the lifecycle as
 * AUTHORED ('finalized'); the ledger's view() projects 'superseded' on a
 * derived copy so the UI can show the banner without rewriting history.
 */
export interface FinalizedAccounting {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly id: string;
  readonly systemId: string;
  readonly period: PeriodSpec;
  /** Canonical slot key (system + period): only one non-superseded record may occupy it. */
  readonly periodKey: string;
  readonly decisionId: string | null;
  readonly content: FinalizedContent;
  /** sha256 over the canonical serialization of the frozen content. Never changes. */
  readonly contentHash: string;
  readonly finalizedBy: string;
  readonly finalizedAt: string;
  readonly status: FinalizedLifecycle;
  /** Explicit linkage: the finalized record this one supersedes. */
  readonly supersedes: string | null;
  readonly supersedeReason: string | null;
  readonly authority: FinalizeAuthorityEvidence;
}

/** Ledger view over a stored record: derived lifecycle projection + chain position. */
export interface FinalizedRecordView {
  readonly accounting: FinalizedAccounting;
  /** Id of the record that superseded this one, once any did (derived; stored bytes unchanged). */
  readonly supersededBy: string | null;
  /** 1-based ordinal within the period slot (supersession chain position). */
  readonly ordinal: number;
}

/** One ledger event (audit trail of finalize / supersede / replay). */
export interface LedgerEvent {
  readonly id: string;
  readonly kind: 'finalized' | 'superseded' | 'replayed';
  readonly periodKey: string;
  readonly recordId: string;
  /** Record that was superseded, when kind === 'superseded'. */
  readonly supersededRecordId: string | null;
  readonly actorId: string;
  readonly recordedAt: string;
  readonly reason: string | null;
}

// ---------------------------------------------------------------------------
// Supplemental context (FR-030, advisory)
// ---------------------------------------------------------------------------

/**
 * MANDATORY advisory label carried by every supplemental comparison output.
 * FR-030: supplemental use is advisory "until accounting semantics are
 * approved"; supplemental.ts enforces the label on every row and context,
 * and assertAdvisoryLabeled() throws on any output that loses it.
 */
export const ADVISORY_LABEL =
  'Advisory only - supplemental comparison against approved inputs; accounting semantics pending owner approval' as const;

/** One supplemental declared use. ONLY approved inputs ever participate in a comparison. */
export interface SupplementalInput {
  readonly id: string;
  readonly category: AccountingCategory;
  readonly label: string;
  readonly volumeAcreFeet: number;
  readonly status: 'approved' | 'pending';
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
}

/** One advisory comparison row (measured vs approved supplemental, per category). */
export interface SupplementalRow {
  readonly category: AccountingCategory;
  readonly label: string;
  readonly measuredVolumeAcreFeet: number;
  /** Sum of APPROVED supplemental inputs in the category only. */
  readonly supplementalVolumeAcreFeet: number;
  readonly differenceAcreFeet: number;
  readonly coverageFraction: number | null;
  readonly advisory: true;
  readonly advisoryLabel: string;
}

/** The advisory supplemental context of one comparison (approved inputs only, label mandatory). */
export interface SupplementalContext {
  readonly advisory: true;
  readonly advisoryLabel: string;
  readonly rows: readonly SupplementalRow[];
  /** Pending inputs excluded from every number, listed so the UI can show why. */
  readonly excludedPendingInputs: readonly { readonly id: string; readonly label: string }[];
  readonly comparedAt: string;
  readonly comparedBy: string;
  readonly methodVersion: string;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Recursively freeze a value (records, arrays, nested). Returns the frozen input. */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  Object.freeze(value);
  return value;
}
