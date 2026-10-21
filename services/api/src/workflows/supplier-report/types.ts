/**
 * Type vocabulary for the WD-017 water supplier reporting domain
 * (FR-053..FR-057, R2 Water Use Program reporting).
 *
 * Source of truth:
 * - docs/product/baseline/01-product-requirements.md:
 *   - FR-053: "A verified supplier sees assigned area sources, purchases,
 *     wholesale and returns plus historical discharge comparisons; an account
 *     assigned to a different supplier cannot retrieve the system's private
 *     report or boundary workflow."
 *   - FR-054: boundary proposals with section comments; "a proposal never
 *     replaces the approved boundary before the defined approval action."
 *   - FR-055: categories "culinary use, source, purchase, wholesale and
 *     returns inventories, source peak demand and secondary use; missing
 *     required values and unreasonable values produce field-level text
 *     messages and an error summary in addition to color."
 *   - FR-056: manual entry and file import populate the SAME validated model.
 *   - FR-057: draft -> submitted records submitter and version; the PDF
 *     matches the submitted version; resubmission follows an approved state
 *     machine.
 * - The Wiley persona boundary: "Supplier reports and boundaries need a
 *   verified organization assignment" (organization-scoped entitlement).
 * - The open decision "Supplier reporting ownership, boundary approval and
 *   reviewer state machine | Water Use Program owner": every numeric range,
 *   the reviewer role split and the resubmission state machine below is a
 *   DOCUMENTED DEFAULT pending that owner's ratification.
 *
 * The period basis vocabulary and date rules are shared with the WD-025
 * distribution report (../distribution-report/types.ts): never two meanings
 * of one year in one product.
 *
 * Pure domain types only: no HTTP framework, no I/O, no clock reads.
 */

import type { PeriodBasis } from '../distribution-report/types.ts';

/** Schema identity of the supplier-report serialization (part of the content hash). */
export const SUPPLIER_REPORT_SCHEMA_VERSION = 'supplier-report@1' as const;

/** Schema identity of the PDF manifest serialization. */
export const SUPPLIER_PDF_MANIFEST_VERSION = 'supplier-pdf-manifest@1' as const;

// ---------------------------------------------------------------------------
// Reporting categories (FR-055, fixed presentation order)
// ---------------------------------------------------------------------------

export type ReportingCategory =
  | 'culinary-use'
  | 'source-inventory'
  | 'purchase-inventory'
  | 'wholesale-inventory'
  | 'return-inventory'
  | 'source-peak-demand'
  | 'secondary-use';

export const CATEGORY_ORDER: readonly ReportingCategory[] = [
  'culinary-use',
  'source-inventory',
  'purchase-inventory',
  'wholesale-inventory',
  'return-inventory',
  'source-peak-demand',
  'secondary-use',
];

export const CATEGORY_LABELS: Readonly<Record<ReportingCategory, string>> = {
  'culinary-use': 'Culinary use',
  'source-inventory': 'Source inventory',
  'purchase-inventory': 'Purchase inventory',
  'wholesale-inventory': 'Wholesale inventory',
  'return-inventory': 'Returns inventory',
  'source-peak-demand': 'Source peak demand',
  'secondary-use': 'Secondary use',
};

/** Reported period: shared basis vocabulary + the period year (WD-025 date rules). */
export interface ReportPeriod {
  readonly basis: PeriodBasis;
  readonly year: number;
}

// ---------------------------------------------------------------------------
// Category section models (the ONE validated model both manual entry and
// file import populate - FR-056)
// ---------------------------------------------------------------------------

/** Culinary (potable) system summary. */
export interface CulinaryUseSection {
  /** Residential + commercial population served by the culinary system. */
  readonly populationServed: number | null;
  /** Active metered/non-metered culinary connections. */
  readonly activeConnections: number | null;
  /** Annual culinary water produced/purchased into the system. */
  readonly annualCulinaryVolumeGallons: number | null;
  /** Share of the annual volume passing through a master or service meter, 0-100. */
  readonly meteredPercent: number | null;
}

export type SourceType = 'well' | 'spring' | 'surface-water' | 'other';

/** One drinking/potable source of the supplier (source inventory entry). */
export interface SourceInventoryEntry {
  /** Stable source identifier as the supplier records it (e.g. well tag). */
  readonly sourceId: string;
  readonly sourceType: SourceType;
  /** Human-readable source name. */
  readonly name: string;
  /** Installed pump capacity. */
  readonly pumpCapacityGpm: number | null;
  /** Annual withdrawal from this source. */
  readonly annualWithdrawalGallons: number | null;
  /** Whether the source withdrawal is metered. */
  readonly metered: boolean;
}

/** Water purchased from another supplier/wholesaler. */
export interface PurchaseInventoryEntry {
  readonly sellerName: string;
  readonly annualPurchasedGallons: number | null;
}

/** Water sold wholesale to another supplier. */
export interface WholesaleInventoryEntry {
  readonly buyerName: string;
  readonly annualSoldGallons: number | null;
}

export type ReturnType = 'treated-effluent' | 'raw-water' | 'other';

/** Water returned to a receiving body or system (returns inventory entry). */
export interface ReturnInventoryEntry {
  readonly returnType: ReturnType;
  /** Receiving stream, reservoir or system name. */
  readonly receivingBody: string;
  readonly annualReturnedGallons: number | null;
}

/** Source peak demand for the reported period. */
export interface SourcePeakDemandSection {
  /** Local calendar day of the observed peak (YYYY-MM-DD), inside the period. */
  readonly peakDayDate: string | null;
  /** Total volume produced on the peak day. */
  readonly peakDayVolumeGallons: number | null;
  /** Peak hour production rate, when recorded. */
  readonly peakHourDemandGpm: number | null;
}

/** Secondary (non-culinary, typically outdoor) use. */
export interface SecondaryUseSection {
  readonly irrigatedAcres: number | null;
  readonly secondaryConnections: number | null;
  readonly annualSecondaryVolumeGallons: number | null;
  readonly metered: boolean | null;
}

/** All category sections of one draft/submission. Field order is fixed per CATEGORY_ORDER. */
export interface ReportSections {
  readonly culinaryUse: CulinaryUseSection;
  readonly sourceInventory: readonly SourceInventoryEntry[];
  readonly purchaseInventory: readonly PurchaseInventoryEntry[];
  readonly wholesaleInventory: readonly WholesaleInventoryEntry[];
  readonly returnInventory: readonly ReturnInventoryEntry[];
  readonly sourcePeakDemand: SourcePeakDemandSection;
  readonly secondaryUse: SecondaryUseSection;
}

export const EMPTY_SECTIONS: ReportSections = Object.freeze({
  culinaryUse: Object.freeze({ populationServed: null, activeConnections: null, annualCulinaryVolumeGallons: null, meteredPercent: null }),
  sourceInventory: Object.freeze([]),
  purchaseInventory: Object.freeze([]),
  wholesaleInventory: Object.freeze([]),
  returnInventory: Object.freeze([]),
  sourcePeakDemand: Object.freeze({ peakDayDate: null, peakDayVolumeGallons: null, peakHourDemandGpm: null }),
  secondaryUse: Object.freeze({ irrigatedAcres: null, secondaryConnections: null, annualSecondaryVolumeGallons: null, metered: null }),
});

// ---------------------------------------------------------------------------
// Validation (FR-055: field-level TEXT messages + error summary, never color alone)
// ---------------------------------------------------------------------------

export type IssueSeverity = 'error' | 'warning';

/**
 * One field-level finding. `message` is plain TEXT (screen-reader and
 * summary friendly); severity drives presentation but the message never
 * relies on color alone.
 */
export interface ValidationIssue {
  /** Dotted path into ReportSections, e.g. "culinaryUse.populationServed" or "sourceInventory[2].annualWithdrawalGallons". */
  readonly fieldPath: string;
  readonly category: ReportingCategory;
  readonly severity: IssueSeverity;
  readonly code:
    | 'MISSING_REQUIRED' // required value absent (null) - an error
    | 'INVALID_VALUE' // wrong dimension of value: negative, non-integer, zero-where-impossible, malformed date
    | 'UNREASONABLE_VALUE' // outside the documented plausible range - a warning, owner-ratifiable
    | 'PERIOD_MISMATCH'; // a date outside the reported period
  readonly message: string;
}

/** Accessible roll-up: plain-text lines, counts, and a headline. No color semantics. */
export interface ValidationSummary {
  readonly errorCount: number;
  readonly warningCount: number;
  /** e.g. "3 errors and 2 warnings need review." or "No blocking errors. 2 warnings noted." */
  readonly headline: string;
  /** Numbered plain-text lines, one per issue, ordered by category then field path. */
  readonly lines: readonly string[];
}

export interface ValidationSnapshot {
  readonly issues: readonly ValidationIssue[];
  readonly summary: ValidationSummary;
}

// ---------------------------------------------------------------------------
// Import (FR-056: same validated model; preview maps units/periods; retry is idempotent)
// ---------------------------------------------------------------------------

/** Canonical volume unit of every inventory field in the model. */
export const VOLUME_UNIT = 'gallons' as const;

/**
 * Documented unit-conversion factors (deterministic, fixed precision) used by
 * the import mapper. PENDING owner ratification like every numeric default.
 */
export const UNIT_FACTORS: Readonly<Record<string, number>> = Object.freeze({
  gal: 1,
  'ac-ft': 325_851.428571, // 1 acre-foot = 43 560 ft3 x 7.48051948051948 gal/ft3
  MG: 1_000_000,
});

/** Units the importer understands per quantity dimension. */
export type ImportUnit = 'gal' | 'ac-ft' | 'MG' | 'persons' | 'connections' | 'gpm' | 'acres' | 'percent' | 'date';

/** One data row of an imported file, as parsed from the transport layer. */
export interface ImportFileRow {
  readonly rowIndex: number;
  readonly category: string;
  readonly field: string;
  /** Identifies an inventory entry (sourceId / sellerName / buyerName / receivingBody); null for scalar fields. */
  readonly entryKey: string | null;
  readonly rawValue: string;
  readonly rawUnit: ImportUnit;
}

/** The period the FILE claims to cover; mapped against the draft period in the preview. */
export interface ImportFilePeriod {
  readonly basis: string;
  readonly year: number;
}

export interface ImportMappingRow {
  readonly rowIndex: number;
  readonly category: ReportingCategory;
  readonly field: string;
  readonly entryKey: string | null;
  readonly rawValue: string;
  readonly rawUnit: ImportUnit;
  /** Value after unit conversion, in the field's canonical unit. */
  readonly mappedValue: number | string;
  /** Canonical unit of the target field ('gallons', 'persons', ... or 'YYYY-MM-DD'). */
  readonly mappedUnit: string;
  readonly note: string;
}

export interface ImportInvalidRow {
  readonly rowIndex: number;
  readonly reason: string;
}

/** Deterministic preview: no store mutation happens before the caller applies it. */
export interface ImportPreview {
  readonly importId: string;
  readonly targetDraftId: string;
  readonly filePeriod: ImportFilePeriod;
  readonly periodMappingNote: string;
  readonly mappings: readonly ImportMappingRow[];
  readonly invalidRows: readonly ImportInvalidRow[];
  readonly applicable: boolean;
}

export interface ImportRecord {
  readonly importId: string;
  readonly importedAt: string;
  readonly importedBy: string;
  readonly appliedRowCount: number;
}

export interface ImportApplyResult {
  readonly importId: string;
  /** True when the importId had already been applied: NOTHING changed, no duplicates created. */
  readonly replayed: boolean;
  readonly appliedRowCount: number;
}

// ---------------------------------------------------------------------------
// Draft and submission (FR-057 state machine)
// ---------------------------------------------------------------------------

export type DraftStatus = 'draft' | 'submitted';

export interface SupplierReportDraft {
  readonly draftId: string;
  readonly orgId: string;
  readonly systemId: string;
  readonly period: ReportPeriod;
  readonly status: DraftStatus;
  /** Submission id once submitted (the draft is then frozen). */
  readonly submissionId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
  readonly sections: ReportSections;
  /** Imports applied to this draft, in application order (retry idempotency keys). */
  readonly imports: readonly ImportRecord[];
  /** Recomputed on every section change; the submit gate revalidates from scratch. */
  readonly validation: ValidationSnapshot;
}

/**
 * Submission states of the approved resubmission state machine (FR-057):
 *
 *   draft --submit--> submitted --reviewer approves resubmission--> resubmission-approved
 *                                             (unlocks a new draft version; the
 *                                              submitted CONTENT stays frozen forever)
 *
 * A rejected-withdrawal style terminal state is intentionally absent: a
 * submitted annual report is never deleted or rolled back (FR-029 discipline).
 */
export type SubmissionStatus = 'submitted' | 'resubmission-approved';

/** Frozen submitted version of a report (FR-057; attribution + contentHash). */
export interface SubmittedReport {
  readonly schemaVersion: typeof SUPPLIER_REPORT_SCHEMA_VERSION;
  readonly submissionId: string;
  readonly draftId: string;
  readonly orgId: string;
  readonly systemId: string;
  readonly period: ReportPeriod;
  /** 1 for the first submission of this (org, system, period); N+1 only after an approved resubmission. */
  readonly version: number;
  /** Server-resolved principal id of the submitting supplier actor. */
  readonly submitter: string;
  readonly submittedAt: string;
  readonly status: SubmissionStatus;
  /** Reviewer attribution for the resubmission approval, once decided. */
  readonly resubmissionApprovedBy: string | null;
  readonly resubmissionApprovedAt: string | null;
  readonly resubmissionNote: string | null;
  /** Frozen copy of the validated sections at submit time. */
  readonly content: ReportSections;
  /** Import provenance of the submitted content. */
  readonly imports: readonly ImportRecord[];
  /** Warnings acknowledged at submit time (errors block submit; warnings ride along). */
  readonly acknowledgedWarnings: readonly ValidationIssue[];
  readonly validation: ValidationSnapshot;
  /**
   * sha256 over the canonical serialization of everything except
   * submissionId, the pdf reference and the resubmission bookkeeping, so a
   * status transition never changes content identity. The PDF manifest
   * carries this same hash: "the PDF matches the submitted version".
   */
  readonly contentHash: string;
  /** Deterministic PDF manifest reference; the full manifest is rebuilt by pdf.ts. */
  readonly pdf: { readonly manifestVersion: number; readonly manifestHash: string };
}

export interface SubmissionOutcome {
  readonly submission: SubmittedReport;
  /** True when an idempotent retry returned the ORIGINAL submitted record. */
  readonly replayed: boolean;
  /** Submission id this one superseded through the approved resubmission path. */
  readonly superseded: string | null;
}

// ---------------------------------------------------------------------------
// Boundary proposals (FR-054)
// ---------------------------------------------------------------------------

export type BoundaryProposalStatus = 'proposed' | 'review' | 'approved' | 'rejected';

export interface BoundarySection {
  readonly sectionId: string;
  readonly title: string;
  /** Plain-text summary of the currently approved extent/definition of this section. */
  readonly summary: string;
}

/** The approved boundary of one supplier system. Immutable; approval creates version N+1. */
export interface ApprovedBoundary {
  readonly boundaryId: string;
  readonly orgId: string;
  readonly systemId: string;
  readonly version: number;
  readonly sections: readonly BoundarySection[];
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export interface ProposedSectionChange {
  readonly sectionId: string;
  readonly title: string;
  readonly currentSummary: string;
  readonly proposedSummary: string;
  readonly changeReason: string;
}

/** Free-text comment on ONE section of a proposal (suppliers and reviewers both comment). */
export interface BoundaryComment {
  readonly commentId: string;
  readonly sectionId: string;
  readonly authorId: string;
  /** 'supplier' = the proposing organization member; 'reviewer' = the Water Use side. */
  readonly authorRole: 'supplier' | 'reviewer';
  readonly text: string;
  readonly at: string;
}

export interface BoundaryProposal {
  readonly proposalId: string;
  readonly orgId: string;
  readonly systemId: string;
  readonly status: BoundaryProposalStatus;
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly sections: readonly ProposedSectionChange[];
  /** Append-only; comments never mutate the sections or the approved boundary. */
  readonly comments: readonly BoundaryComment[];
  /** Set only by the distinct approval transition. */
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  /** Boundary version created by approval; null until approved. */
  readonly resultingBoundaryVersion: number | null;
}

// ---------------------------------------------------------------------------
// Assigned supplier system view (FR-053)
// ---------------------------------------------------------------------------

export interface SupplierSourceSummary {
  readonly stationId: string;
  readonly displayName: string;
  readonly status: string;
  readonly visibility: 'public' | 'restricted' | 'internal';
  readonly dischargeStreams: readonly { readonly streamId: string; readonly unitId: string }[];
}

/** One year of one stream's discharge: null volume means no covered data, never zero. */
export interface HistoricalDischargeYear {
  readonly year: number;
  readonly volumeAcreFeet: number | null;
  readonly coverageFraction: number;
}

export interface HistoricalDischargeRow {
  readonly streamId: string;
  readonly stationId: string;
  readonly unitId: string;
  readonly years: readonly HistoricalDischargeYear[];
}

export interface SubmittedHistoryEntry {
  readonly submissionId: string;
  readonly version: number;
  readonly submitter: string;
  readonly submittedAt: string;
  readonly status: SubmissionStatus;
  readonly contentHash: string;
}

/**
 * FR-053 assigned system view: sources, purchases/wholesale/returns state of
 * the open draft (or latest submitted content), historical discharge
 * comparisons (WD-008 numerics; null = unavailable) and the submitted history
 * of this organization only.
 */
export interface SupplierSystemView {
  readonly systemId: string;
  readonly systemName: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly sources: readonly SupplierSourceSummary[];
  readonly historicalDischarge: readonly HistoricalDischargeRow[];
  readonly openDraftId: string | null;
  readonly latestSubmissionId: string | null;
  readonly inventorySnapshot:
    | { readonly kind: 'draft'; readonly draftId: string; readonly purchases: number; readonly wholesale: number; readonly returns: number }
    | { readonly kind: 'submitted'; readonly submissionId: string; readonly version: number; readonly purchases: number; readonly wholesale: number; readonly returns: number }
    | { readonly kind: 'none' };
  readonly submittedHistory: readonly SubmittedHistoryEntry[];
  readonly approvedBoundaryVersion: number;
}
