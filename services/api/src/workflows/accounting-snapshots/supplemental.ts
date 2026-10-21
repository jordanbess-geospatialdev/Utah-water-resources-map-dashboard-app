/**
 * Advisory supplemental water context (WD-025-R2; FR-030).
 *
 * FR-030: "supplemental use is compared only against approved inputs and is
 * labelled advisory until accounting semantics are approved."
 *
 * Two hard rules, both enforced structurally:
 * - APPROVED INPUTS ONLY: pending supplemental declarations are EXCLUDED
 *   from every number and surfaced in excludedPendingInputs so the UI can
 *   show why they are absent. There is no code path that compares a
 *   measured volume against a pending declaration.
 * - THE ADVISORY LABEL IS MANDATORY: every row and every context carries
 *   advisory: true and the exact ADVISORY_LABEL string. assertAdvisoryLabeled
 *   throws on any output (or hand-built object shaped like one) that lost
 *   the label, so a transport or rendering layer cannot silently present
 *   the comparison as accounting truth.
 *
 * Pure and deterministic: injected inputs and clock; no I/O.
 */
import type { DomainResult } from '../../series/types.ts';
import { denial } from '../../series/types.ts';
import { deepFreeze, ADVISORY_LABEL, type DecisionCategoryTotal, type SupplementalContext, type SupplementalInput, type SupplementalRow } from './types.ts';

/**
 * Fixture supplemental declarations for the Bear River demo world.
 * PENDING OWNER APPROVAL per the R2 convention (the same marker the
 * rating-curve seed coefficients carry): the volumes document this
 * implementation's inputs; they are not ratified declarations.
 */
export const FIXTURE_SUPPLEMENTAL_INPUTS: readonly SupplementalInput[] = Object.freeze([
  Object.freeze({
    id: 'supp-bear-natural-2026',
    category: 'natural-channel-flow' as const,
    label: 'Bear River mainstem declared natural flow (draft declaration, approved as input)',
    volumeAcreFeet: 84.5,
    status: 'approved' as const,
    approvedBy: 'principal-diego-steward',
    approvedAt: '2026-03-09T00:00:00Z',
  }),
  Object.freeze({
    id: 'supp-bear-canal-2026',
    category: 'canal-delivery' as const,
    label: 'Bear River canal diversions declared use',
    volumeAcreFeet: 560.25,
    status: 'approved' as const,
    approvedBy: 'principal-diego-steward',
    approvedAt: '2026-03-09T00:00:00Z',
  }),
  Object.freeze({
    id: 'supp-bear-release-2026',
    category: 'reservoir-release' as const,
    label: 'Hyrum release declared use (STILL PENDING - never compared)',
    volumeAcreFeet: 300.0,
    status: 'pending' as const,
    approvedBy: null,
    approvedAt: null,
  }),
]);

export interface SupplementalRequest {
  /** Measured category totals (a decision snapshot's basisTotals or a finalized record's content categories). */
  readonly measured: readonly DecisionCategoryTotal[];
  readonly supplementalInputs: readonly SupplementalInput[];
  readonly comparedBy: string | null;
  readonly now: string;
}

/**
 * Compare measured distribution totals against APPROVED supplemental
 * declarations only. Every emitted row is advisory-labelled; pending inputs
 * are excluded and listed. Deterministic: identical inputs and clock
 * produce byte-identical output.
 */
export function buildSupplementalContext(request: SupplementalRequest): DomainResult<SupplementalContext> {
  if (request.measured.length === 0) {
    return denial(422, 'NO_MEASURED_TOTALS', 'a supplemental comparison requires at least one measured category total');
  }
  const approved = request.supplementalInputs.filter((input) => input.status === 'approved');
  const pending = request.supplementalInputs
    .filter((input) => input.status !== 'approved')
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const categories = [...new Set([...request.measured.map((total) => total.category), ...approved.map((input) => input.category)])].sort();

  const rows: SupplementalRow[] = categories.map((category) => {
    const measuredTotal = request.measured.find((total) => total.category === category);
    const approvedVolume = approved
      .filter((input) => input.category === category)
      .reduce((sum, input) => sum + input.volumeAcreFeet, 0);
    const measuredVolume = measuredTotal ? measuredTotal.volumeAcreFeet : 0;
    return {
      category,
      label: measuredTotal ? measuredTotal.label : category,
      measuredVolumeAcreFeet: measuredVolume,
      supplementalVolumeAcreFeet: approvedVolume,
      differenceAcreFeet: measuredVolume - approvedVolume,
      coverageFraction: measuredTotal && measuredTotal.durationSeconds > 0 ? measuredTotal.coverageFraction : null,
      advisory: true as const,
      advisoryLabel: ADVISORY_LABEL,
    };
  });

  const context: SupplementalContext = deepFreeze({
    advisory: true,
    advisoryLabel: ADVISORY_LABEL,
    rows: Object.freeze(rows),
    excludedPendingInputs: Object.freeze(pending.map((input) => Object.freeze({ id: input.id, label: input.label }))),
    comparedAt: request.now,
    comparedBy: request.comparedBy ?? 'anonymous',
    methodVersion: 'supplemental-advisory@1',
  });
  assertAdvisoryLabeled(context);
  return { outcome: 'allowed', value: context };
}

/** True when a value looks like a labeled advisory output (row or context). */
export function isAdvisoryLabeled(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record['advisory'] === true && record['advisoryLabel'] === ADVISORY_LABEL && typeof record['advisoryLabel'] === 'string' && (record['advisoryLabel'] as string).length > 0;
}

/** Rows must each be labeled too. */
export function isFullyAdvisoryLabeled(context: unknown): boolean {
  if (!isAdvisoryLabeled(context)) return false;
  const rows = (context as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.every((row) => isAdvisoryLabeled(row));
}

/**
 * Enforcement point: throws when a supplemental output lost its advisory
 * label. Called by the builder on every context and available to any
 * transport/render layer receiving one.
 */
export function assertAdvisoryLabeled(value: unknown): void {
  if (!isAdvisoryLabeled(value)) {
    throw new Error('supplemental output is missing the mandatory advisory label (FR-030)');
  }
  const rows = (value as { rows?: unknown }).rows;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!isAdvisoryLabeled(row)) {
        throw new Error('supplemental row is missing the mandatory advisory label (FR-030)');
      }
    }
  }
}

/** Rendered text of one row - the label is part of every rendered line. */
export function supplementalRowText(row: SupplementalRow): string {
  const coverage = row.coverageFraction === null ? 'coverage n/a' : `${Math.round(row.coverageFraction * 100)}% coverage`;
  return `${row.category}: measured ${row.measuredVolumeAcreFeet.toFixed(3)} acre-feet vs approved supplemental ${row.supplementalVolumeAcreFeet.toFixed(3)} acre-feet (difference ${row.differenceAcreFeet.toFixed(3)}; ${coverage}) - ${row.advisoryLabel}`;
}
