/**
 * Type vocabulary for the WD-025 annual distribution report domain
 * (FR-024, with FR-029 deliberately out of scope - see finalize.ts).
 *
 * Source of truth:
 * - docs/product/baseline/01-product-requirements.md FR-024: "For a selected
 *   authorized system and period, a report includes daily flow or volume,
 *   quality and coverage notes, configurable chart sizing, generation time and
 *   data version; exported PDF values reconcile to the selected dataset."
 * - docs/product/baseline/02-technical-specification.md, "Measurement and
 *   metadata model" (Import/export/report row: "Request, normalized filters,
 *   snapshot/data revision, requester, status, errors, expiration and output
 *   manifest"), "Originals and corrections" (a new version supersedes, never
 *   rewrites) and "Numerical and temporal rules" (period definitions,
 *   no-double-count categories, integration method).
 *
 * Every derived number in a generated report is produced by the WD-008
 * aggregation domain (../../series/aggregate.ts, method rectangle-right@1);
 * this module NEVER reimplements the numerics. Revision provenance labels
 * come from the WD-011 revision store (../revisions/store.ts).
 *
 * Pure domain types only: no HTTP framework, no I/O, no clock reads.
 */

import type { ProcessingBasis } from '../../series/types.ts';
import type { AccountingCategory } from '../../summaries/totals.ts';

/** Schema identity of the generated-report serialization (part of the content hash). */
export const REPORT_SCHEMA_VERSION = 'distribution-report@1' as const;

// ---------------------------------------------------------------------------
// Period basis (technical specification: "Define calendar year, water year and
// irrigation-season dates per report type with program owners. Never assume
// one year's meaning for all personas.")
// ---------------------------------------------------------------------------

/**
 * Explicit reporting-period bases. Date rules are the documented DEFAULTS
 * pending measurement-owner ratification (mirrored from
 * services/api/src/series/zone.ts seasonWindow):
 * - calendar-year: local Jan 1 00:00 (inclusive) to Jan 1 next year
 *   (exclusive), America/Denver;
 * - water-year: Oct 1 of year-1 through Oct 1 of the year (the USGS water
 *   year ending Sep 30), local;
 * - irrigation-season: Apr 1 through Nov 1 (exclusive) of the same year,
 *   local - six and a half months by design.
 * Flexible/custom periods are R2 (documented in README.md, not implemented).
 */
export type PeriodBasis = 'calendar-year' | 'water-year' | 'irrigation-season';

export interface ReportPeriod {
  readonly basis: PeriodBasis;
  /** The period year (for water-year N the window starts Oct 1, N-1). */
  readonly year: number;
}

/** Human- and machine-readable date rule carried by every generated report. */
export const PERIOD_BASIS_RULES: Readonly<Record<PeriodBasis, { label: string; dateRule: string }>> = {
  'calendar-year': {
    label: 'Calendar year',
    dateRule: 'local calendar year: Jan 1 00:00 (inclusive) through Jan 1 next year (exclusive), America/Denver',
  },
  'water-year': {
    label: 'Water year (Oct-Sep)',
    dateRule: 'USGS water year: Oct 1 of the previous year (inclusive) through Oct 1 of the period year (exclusive; the water year ends Sep 30), America/Denver',
  },
  'irrigation-season': {
    label: 'Irrigation season (Apr 1 - Oct 31)',
    dateRule: 'irrigation season: Apr 1 (inclusive) through Nov 1 (exclusive) of the period year, America/Denver',
  },
};

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** Optional detail flags. The daily flow/volume table is FR-024 core and on by default. */
export interface ReportIncludeFlags {
  /** Daily flow/volume rows per stream (FR-024 core; off only for a totals-only extract). */
  readonly dailyTable: boolean;
  /** Quality note lines (gaps, estimated share, suspect flags, exclusions). */
  readonly qualityNotes: boolean;
  /** Per-declared-gap detail rows (id, reason, hours inside the period). */
  readonly gapDetail: boolean;
}

export const DEFAULT_INCLUDE: ReportIncludeFlags = { dailyTable: true, qualityNotes: true, gapDetail: true } as const;

/**
 * FR-024 report request. Actor identity never appears here: it arrives as a
 * server-resolved principal id argument (FR-010).
 */
export interface ReportRequest {
  /** Distribution system the report covers (policy object kind 'system'). */
  readonly systemId: string;
  /** Optional subset of station ids inside the system; null = every in-scope site. */
  readonly siteIds: readonly string[] | null;
  readonly period: ReportPeriod;
  /** Processing basis selector (same ladder as the WD-008 series APIs). */
  readonly processingBasis: ProcessingBasis;
  readonly include: ReportIncludeFlags;
}

// ---------------------------------------------------------------------------
// Generated report
// ---------------------------------------------------------------------------

/** Note codes on one daily row (rendered text+shape; never color alone). */
export type DailyNoteCode =
  | 'no-data' // zero coverage: unavailable, never zero
  | 'declared-gap' // a declared outage overlaps the day
  | 'range-excluded' // out-of-range or negative reading present (kept, excluded from stats)
  | 'null-frame' // reported-but-empty frame
  | 'estimated' // estimated share > 0 on the day
  | 'suspect-zero' // a reported 0.0 (covered and flagged)
  | 'duplicate-timestamp' // retransmission normalized on the day
  | 'below-selected-basis' // raw fallback below the selected basis
  | 'late-arrival'; // late-arriving reading on the day

export interface DailyFlowRow {
  /** Local calendar day key YYYY-MM-DD (America/Denver). */
  readonly key: string;
  /** Integrated volume over covered intervals only; null when nothing is covered. */
  readonly volumeAcreFeet: number | null;
  /** Mean rate over the covered portion; null when nothing is covered. */
  readonly meanValue: number | null;
  readonly coverageFraction: number;
  readonly estimatedProportion: number;
  readonly noteCodes: readonly DailyNoteCode[];
}

export interface StreamTotals {
  readonly volumeAcreFeet: number;
  readonly coveredSeconds: number;
  readonly durationSeconds: number;
  readonly coverageFraction: number;
  readonly estimatedSeconds: number;
  readonly estimatedProportion: number;
  readonly dayCount: number;
  readonly daysWithNoData: number;
}

export interface StreamReportSection {
  readonly streamId: string;
  readonly stationId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  readonly cadenceMinutes: number;
  /** 'full' when the per-stream grant gate authorized the protected read. */
  readonly projection: 'public' | 'full';
  /** Method reference every derived number carries (rectangle-right@1). */
  readonly method: string;
  readonly daily: readonly DailyFlowRow[];
  readonly totals: StreamTotals;
  readonly qualityNotes: readonly string[];
  readonly coverageNotes: readonly string[];
}

export interface ExcludedStreamEntry {
  readonly streamId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  readonly reason: string;
}

export interface SiteSection {
  readonly stationId: string;
  readonly stationDisplayName: string;
  readonly systemId: string;
  readonly status: string;
  readonly streams: readonly StreamReportSection[];
  readonly excludedStreams: readonly ExcludedStreamEntry[];
}

export interface ExcludedSiteEntry {
  readonly stationId: string;
  readonly stationDisplayName: string;
  readonly reason: string;
}

export interface CategoryStreamTotal {
  readonly streamId: string;
  readonly volumeAcreFeet: number;
  readonly coverageFraction: number;
  readonly estimatedProportion: number;
}

export interface CategoryTotalRow {
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
  readonly streams: readonly CategoryStreamTotal[];
}

export interface SystemTotalsSection {
  readonly method: string;
  readonly noDoubleCountPolicy: string;
  /**
   * Always null by policy: cross-category sums can double-count the same
   * water measured at an upstream gauge, a downstream gauge and a canal
   * delivery (technical specification, "Numerical and temporal rules").
   */
  readonly combinedVolumeAcreFeet: null;
  readonly categories: readonly CategoryTotalRow[];
  /** Streams gated into the report but kept out of flow totals, with reasons. */
  readonly excludedStreams: readonly ExcludedStreamEntry[];
}

export interface FormulaStatement {
  readonly id: string;
  readonly statement: string;
  readonly methodRef: string;
}

export interface FormulaDocumentationSection {
  /** WD-008 aggregation method version that produced every number. */
  readonly methodVersion: string;
  readonly policyVersion: string;
  readonly roundingPolicy: string;
  readonly statements: readonly FormulaStatement[];
}

/** Which revision chain produced best-available, per stream (FR-024 "data version"). */
export interface RevisedObservationLabel {
  readonly observationId: string;
  readonly logicalKey: string;
  readonly chainVersion: number;
  readonly headRevisionId: string;
  readonly headProcessingLevel: string;
  readonly headRecordedAt: string;
  /** True when the selected basis actually resolved to this chain's revision. */
  readonly usedAtSelectedBasis: boolean;
}

export interface StreamRevisionProvenance {
  readonly streamId: string;
  readonly stationDisplayName: string;
  readonly basis: ProcessingBasis;
  readonly revisedObservations: readonly RevisedObservationLabel[];
  /** Observations that resolved to a revision at the selected basis. */
  readonly usedRevisionCount: number;
  /** Observations falling back to raw below the selected basis. */
  readonly rawFallbackCount: number;
}

export interface ProvenanceSection {
  /** Extraction timestamp (FR-024 "generation time"): the injected clock, echoed verbatim. */
  readonly extractionTime: string;
  readonly methodVersion: string;
  /**
   * sha256 over the canonical serialization of the revision chains that
   * produced the report's numbers. Changes whenever any underlying chain
   * changes, even when values do not.
   */
  readonly dataVersion: string;
  readonly fixtureSeed: string;
  readonly streams: readonly StreamRevisionProvenance[];
}

export interface ReportSections {
  readonly sites: readonly SiteSection[];
  readonly excludedSites: readonly ExcludedSiteEntry[];
  readonly totals: SystemTotalsSection;
  readonly formulas: FormulaDocumentationSection;
  readonly provenance: ProvenanceSection;
}

/**
 * A generated (not finalized) report. `contentHash` is the sha256 of the
 * canonical serialization of everything except reportId/version/supersedes/
 * contentHash, so regenerating with identical inputs and clock yields the
 * identical hash (byte-identical report) while supersession bookkeeping can
 * advance without perturbing content identity. Finalization/immutability is
 * FR-029, a separate R2 task (see finalize.ts).
 */
export interface GeneratedReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly reportId: string;
  /** 1 on a fresh generation; the registry assigns higher ordinals on supersession. */
  readonly version: number;
  /** Forward pointer to the report this one supersedes (set by the registry). */
  readonly supersedes: string | null;
  readonly system: { readonly id: string; readonly name: string };
  /** Server-resolved principal id of the requesting actor (FR-010). */
  readonly requestedBy: string;
  readonly period: {
    readonly basis: PeriodBasis;
    readonly year: number;
    readonly start: string;
    readonly end: string;
    readonly dateRule: string;
    readonly timeZone: string;
  };
  readonly processingBasis: ProcessingBasis;
  readonly include: ReportIncludeFlags;
  readonly extractionTime: string;
  readonly sections: ReportSections;
  readonly contentHash: string;
}
