/**
 * Deterministic PDF MANIFEST model for WD-017 (FR-057: "produces a PDF
 * matching that submitted version").
 *
 * Mirrors the WD-025 finalize discipline (../distribution-report/finalize.ts
 * and README.md "PDF TRANSPORT"): rendering/serving bytes is a TRANSPORT
 * concern of the export pipeline. What this module owns is the exact CONTENT
 * MODEL a rendered PDF must carry, plus its size/layout specification, so
 * that:
 *
 * - the manifest is a byte-stable serialization (canonical key-sorted JSON)
 *   of the submitted version — two manifests of one submission are
 *   byte-identical, and the manifest hash changes iff the submitted content
 *   changes;
 * - the manifest embeds `submittedContentHash` verbatim: "the PDF matches
 *   the submitted version" is PROVEN by contentHash equality (tested), not
 *   asserted by the renderer;
 * - the layout spec (page geometry, fonts, table columns) is data, so the
 *   transport renderer cannot reinterpret the report.
 *
 * Pure: no clock reads (submittedAt comes from the submitted record), no
 * randomness, fixed block order.
 */
import { createHash } from 'node:crypto';

import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  SUPPLIER_PDF_MANIFEST_VERSION,
  type ApprovedBoundary,
  type ReportSections,
  type SubmittedReport,
} from './types.ts';
import { PERIOD_BASIS_RULES } from '../distribution-report/types.ts';

// ---------------------------------------------------------------------------
// Canonical serialization and hashing (same discipline as WD-025 generate.ts)
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Layout specification (data, not renderer policy)
// ---------------------------------------------------------------------------

/** Page geometry and typography the transport renderer must follow. Units are PDF points (72/inch). */
export interface PdfLayoutSpec {
  readonly pageWidth: 612;
  readonly pageHeight: 792;
  readonly unit: 'pt';
  readonly margins: { readonly top: 54; readonly right: 54; readonly bottom: 54; readonly left: 54 };
  readonly baseFont: 'Helvetica';
  readonly baseFontSize: 10;
  readonly headingFontSize: 14;
  readonly titleFontSize: 18;
  readonly tableColumns: readonly { readonly key: string; readonly widthPt: number; readonly align: 'left' | 'right' }[];
  readonly tableColumnsNote: string;
}

export const PDF_LAYOUT: PdfLayoutSpec = Object.freeze({
  pageWidth: 612,
  pageHeight: 792,
  unit: 'pt',
  margins: Object.freeze({ top: 54, right: 54, bottom: 54, left: 54 }),
  baseFont: 'Helvetica',
  baseFontSize: 10,
  headingFontSize: 14,
  titleFontSize: 18,
  tableColumns: Object.freeze([
    { key: 'label', widthPt: 216, align: 'left' },
    { key: 'value', widthPt: 144, align: 'right' },
    { key: 'unit', widthPt: 72, align: 'left' },
    { key: 'status', widthPt: 72, align: 'left' },
  ]),
  tableColumnsNote: 'Letter portrait; one row per reported value; the status column carries the text "reported", "missing" or "warning" — never a color alone.',
});

// ---------------------------------------------------------------------------
// Content model
// ---------------------------------------------------------------------------

export type PdfBlock =
  | { readonly kind: 'title'; readonly text: string }
  | { readonly kind: 'meta'; readonly label: string; readonly value: string }
  | { readonly kind: 'section-heading'; readonly category: string; readonly text: string }
  | { readonly kind: 'value-row'; readonly label: string; readonly value: string; readonly unit: string; readonly status: 'reported' | 'missing' | 'warning' }
  | { readonly kind: 'entry-heading'; readonly text: string }
  | { readonly kind: 'note'; readonly text: string }
  | { readonly kind: 'hash-footer'; readonly label: string; readonly hash: string };

function fmt(value: number | null): string {
  return value === null ? '' : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function row(label: string, value: number | null, unit: string, warning: boolean): PdfBlock {
  if (value === null) return { kind: 'value-row', label, value: '', unit, status: 'missing' };
  return { kind: 'value-row', label, value: fmt(value), unit, status: warning ? 'warning' : 'reported' };
}

function warned(submitted: SubmittedReport, fieldPath: string): boolean {
  return submitted.acknowledgedWarnings.some((issue) => issue.fieldPath === fieldPath);
}

function sectionBlocks(submitted: SubmittedReport, sections: ReportSections): PdfBlock[] {
  const blocks: PdfBlock[] = [];
  const periodRule = PERIOD_BASIS_RULES[submitted.period.basis];
  blocks.push({ kind: 'meta', label: 'Reporting period', value: `${periodRule.label} ${submitted.period.year}` });
  blocks.push({ kind: 'meta', label: 'Period date rule', value: periodRule.dateRule });
  blocks.push({ kind: 'meta', label: 'Submitted version', value: String(submitted.version) });
  blocks.push({ kind: 'meta', label: 'Submitter', value: submitted.submitter });
  blocks.push({ kind: 'meta', label: 'Submitted at', value: submitted.submittedAt });
  blocks.push({ kind: 'meta', label: 'Submission id', value: submitted.submissionId });
  blocks.push({ kind: 'meta', label: 'Content hash (sha256)', value: submitted.contentHash });

  for (const category of CATEGORY_ORDER) {
    blocks.push({ kind: 'section-heading', category, text: CATEGORY_LABELS[category] });
    switch (category) {
      case 'culinary-use': {
        const s = sections.culinaryUse;
        blocks.push(row('Population served', s.populationServed, 'persons', warned(submitted, 'culinaryUse.populationServed')));
        blocks.push(row('Active connections', s.activeConnections, 'connections', warned(submitted, 'culinaryUse.activeConnections')));
        blocks.push(row('Annual culinary volume', s.annualCulinaryVolumeGallons, 'gallons', warned(submitted, 'culinaryUse.annualCulinaryVolumeGallons')));
        blocks.push(row('Metered share', s.meteredPercent, 'percent', warned(submitted, 'culinaryUse.meteredPercent')));
        break;
      }
      case 'source-inventory': {
        sections.sourceInventory.forEach((entry, index) => {
          blocks.push({ kind: 'entry-heading', text: `Source ${index + 1}: ${entry.name} (${entry.sourceId}, ${entry.sourceType}${entry.metered ? ', metered' : ', unmetered'})` });
          blocks.push(row('Pump capacity', entry.pumpCapacityGpm, 'gpm', warned(submitted, `sourceInventory[${index}].pumpCapacityGpm`)));
          blocks.push(row('Annual withdrawal', entry.annualWithdrawalGallons, 'gallons', warned(submitted, `sourceInventory[${index}].annualWithdrawalGallons`)));
        });
        break;
      }
      case 'purchase-inventory': {
        sections.purchaseInventory.forEach((entry, index) => {
          blocks.push({ kind: 'entry-heading', text: `Purchase from ${entry.sellerName}` });
          blocks.push(row('Annual purchased volume', entry.annualPurchasedGallons, 'gallons', warned(submitted, `purchaseInventory[${index}].annualPurchasedGallons`)));
        });
        break;
      }
      case 'wholesale-inventory': {
        sections.wholesaleInventory.forEach((entry, index) => {
          blocks.push({ kind: 'entry-heading', text: `Wholesale to ${entry.buyerName}` });
          blocks.push(row('Annual sold volume', entry.annualSoldGallons, 'gallons', warned(submitted, `wholesaleInventory[${index}].annualSoldGallons`)));
        });
        break;
      }
      case 'return-inventory': {
        sections.returnInventory.forEach((entry, index) => {
          blocks.push({ kind: 'entry-heading', text: `Return (${entry.returnType}) to ${entry.receivingBody}` });
          blocks.push(row('Annual returned volume', entry.annualReturnedGallons, 'gallons', warned(submitted, `returnInventory[${index}].annualReturnedGallons`)));
        });
        break;
      }
      case 'source-peak-demand': {
        const s = sections.sourcePeakDemand;
        blocks.push({
          kind: 'value-row',
          label: 'Peak day',
          value: s.peakDayDate ?? '',
          unit: 'date',
          status: s.peakDayDate === null ? 'missing' : 'reported',
        });
        blocks.push(row('Peak-day volume', s.peakDayVolumeGallons, 'gallons', warned(submitted, 'sourcePeakDemand.peakDayVolumeGallons')));
        blocks.push(row('Peak-hour demand', s.peakHourDemandGpm, 'gpm', warned(submitted, 'sourcePeakDemand.peakHourDemandGpm')));
        break;
      }
      case 'secondary-use': {
        const s = sections.secondaryUse;
        blocks.push(row('Irrigated acres', s.irrigatedAcres, 'acres', warned(submitted, 'secondaryUse.irrigatedAcres')));
        blocks.push(row('Secondary connections', s.secondaryConnections, 'connections', warned(submitted, 'secondaryUse.secondaryConnections')));
        blocks.push(row('Annual secondary volume', s.annualSecondaryVolumeGallons, 'gallons', warned(submitted, 'secondaryUse.annualSecondaryVolumeGallons')));
        blocks.push({
          kind: 'value-row',
          label: 'Metered',
          value: s.metered === null ? '' : s.metered ? 'yes' : 'no',
          unit: '',
          status: s.metered === null ? 'missing' : 'reported',
        });
        break;
      }
    }
  }
  return blocks;
}

/** The manifest: everything a PDF of this submission must contain, plus layout data. */
export interface PdfManifest {
  readonly manifestVersion: typeof SUPPLIER_PDF_MANIFEST_VERSION;
  readonly submissionId: string;
  /** VERBATIM copy of SubmittedReport.contentHash: the PDF-matches-submission proof. */
  readonly submittedContentHash: string;
  readonly submittedVersion: number;
  readonly submitter: string;
  readonly submittedAt: string;
  readonly organization: { readonly orgId: string };
  readonly system: { readonly systemId: string };
  readonly period: { readonly basis: SubmittedReport['period']['basis']; readonly year: number };
  readonly blocks: readonly PdfBlock[];
  /** Acknowledged warnings annex (plain text; part of the submitted version's record). */
  readonly acknowledgedWarnings: readonly { readonly fieldPath: string; readonly message: string }[];
  readonly boundaryNote: string;
  readonly layout: PdfLayoutSpec;
  readonly manifestHash: string;
}

const BOUNDARY_NOTE =
  'Boundary proposals and their approval are separate records from this report; the approved service-area boundary in force at submission time is summarized in the boundary annex of the system view.';

/**
 * Build the deterministic PDF manifest of a submitted version. The boundary
 * (optional) only contributes a versioned summary line; the manifest is
 * fully determined by the submission (plus that line), so identical
 * submissions produce byte-identical manifests.
 */
export function buildPdfManifest(submitted: SubmittedReport, boundary: ApprovedBoundary | null = null): PdfManifest {
  const boundaryNote = boundary
    ? `Approved service-area boundary version ${boundary.version} (approved ${boundary.approvedAt} by ${boundary.approvedBy}). ${BOUNDARY_NOTE}`
    : BOUNDARY_NOTE;
  const blocks: PdfBlock[] = [
    { kind: 'title', text: `Utah annual water use report — version ${submitted.version}` },
    ...sectionBlocks(submitted, submitted.content),
    { kind: 'note', text: `Acknowledged warnings at submission: ${submitted.acknowledgedWarnings.length}. Each warning is recorded verbatim in the manifest annex.` },
    { kind: 'note', text: boundaryNote },
    { kind: 'hash-footer', label: 'This PDF matches submitted version', hash: submitted.contentHash },
  ];
  const withoutHash = {
    manifestVersion: SUPPLIER_PDF_MANIFEST_VERSION,
    submissionId: submitted.submissionId,
    submittedContentHash: submitted.contentHash,
    submittedVersion: submitted.version,
    submitter: submitted.submitter,
    submittedAt: submitted.submittedAt,
    organization: { orgId: submitted.orgId },
    system: { systemId: submitted.systemId },
    period: { basis: submitted.period.basis, year: submitted.period.year },
    blocks,
    acknowledgedWarnings: submitted.acknowledgedWarnings.map((issue) => ({ fieldPath: issue.fieldPath, message: issue.message })),
    boundaryNote,
    layout: PDF_LAYOUT,
  };
  return { ...withoutHash, manifestHash: sha256Hex(canonicalize(withoutHash)) };
}

/** Byte-stable serialization of a manifest (canonical key-sorted JSON). */
export function serializeManifest(manifest: PdfManifest): string {
  return canonicalize(manifest);
}

// ---------------------------------------------------------------------------
// Transport stub (WD-025 finalize discipline)
// ---------------------------------------------------------------------------

export interface PdfRenderRequest {
  readonly manifest: PdfManifest;
  readonly requesterId: string;
}

/**
 * Intentionally throws: rendering and serving PDF BYTES is a transport
 * concern of the export pipeline (POST /exports), not of the supplier-report
 * domain. The manifest above is the complete, deterministic content contract
 * that transport must render.
 */
export function renderPdfTransport(_request: PdfRenderRequest): never {
  throw new Error('not implemented - transport concern (FR-057 PDF rendering lands with the export pipeline)');
}
