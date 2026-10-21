/**
 * Draft CRUD, import and submission for WD-017 supplier reporting
 * (FR-053 assigned system view, FR-056 import, FR-057 submit state machine).
 *
 * DESIGN CONTRACTS:
 *
 * - ORGANIZATION ISOLATION VIA THE POLICY ENGINE: every operation is gated
 *   by checkSupplierScope (action 'supplier-reporting', organization-scoped
 *   assignment, system object anchored to the owner org). Cross-supplier
 *   access maps to the hidden-object 404 (FR-053); tested in BOTH
 *   directions. The org of a draft is resolved from the actor's assignment,
 *   never from the request body (FR-010).
 * - ONE VALIDATED MODEL (FR-056): manual updateSection and file import write
 *   the same ReportSections and run the same validateSections; the import
 *   path only maps units/periods first. Retrying an import by importId is
 *   idempotent: the recorded result replays and NO value is applied twice.
 * - APPROVED STATE MACHINE (FR-057): draft -> submitted (submit) ->
 *   resubmission-approved (reviewer). submit is idempotent: a retry by the
 *   same submission id - or any submit of an already-submitted draft -
 *   returns the ORIGINAL submitted record; a new version exists only after
 *   the reviewer-approved resubmission transition. The submitted content is
 *   FROZEN with a sha256 contentHash; approving a resubmission changes
 *   bookkeeping fields only, never the hash.
 * - DETERMINISM: ids derive from stable keys; timestamps come from the
 *   injected clock (deps.now); no randomness; canonical key-sorted
 *   serialization for hashing (same discipline as WD-025).
 */
import { aggregateSeries } from '../../series/aggregate.ts';
import { localMidnightInstant, seasonWindow } from '../../series/zone.ts';
import { seriesStore, type SeriesStore } from '../../series/load.ts';
import type { DomainDenial, DomainResult } from '../../series/types.ts';
import type { PolicyWorld } from '../../../../../packages/policy/src/index.ts';

import {
  EMPTY_SECTIONS,
  SUPPLIER_REPORT_SCHEMA_VERSION,
  UNIT_FACTORS,
  CATEGORY_LABELS,
  type ImportApplyResult,
  type ImportFilePeriod,
  type ImportFileRow,
  type ImportInvalidRow,
  type ImportMappingRow,
  type ImportPreview,
  type ImportUnit,
  type ReportPeriod,
  type ReportSections,
  type ReportingCategory,
  type SourceInventoryEntry,
  type SubmittedHistoryEntry,
  type SubmittedReport,
  type SubmissionOutcome,
  type SupplierReportDraft,
  type SupplierSystemView,
  type ValidationIssue,
  type ValidationSnapshot,
} from './types.ts';
import { buildPdfManifest, canonicalize, sha256Hex } from './pdf.ts';
import { validateSections } from './validate.ts';
import { checkReviewerScope, checkSupplierScope, type SupplierScopeGrant } from './scope.ts';
import { anchorOfSystem, supplierWorld } from './world.ts';
import type { SupplierBoundaryStore } from './boundaries.ts';

/** Denial with the validation annex attached (the summary object travels with VALIDATION_FAILED). */
export type SupplierDenial = DomainDenial & { readonly issues?: readonly ValidationIssue[]; readonly summary?: ValidationSnapshot['summary'] };

export interface SupplierDeps {
  /** Overrides the fixture supplier world (derived worlds in tests). */
  readonly world?: PolicyWorld | undefined;
  /** Series store for historical discharge (FR-053); defaults to the shared fixture store. */
  readonly store?: SeriesStore | undefined;
  /** Injected clock: every timestamp in this module echoes it verbatim. */
  readonly now: string;
}

/** Convenience wrapper: fixture series store (+ optional derived world) and the injected clock. */
export function fixtureSupplierDeps(now: string, world?: PolicyWorld): SupplierDeps {
  return { store: seriesStore(), ...(world ? { world } : {}), now };
}

// ---------------------------------------------------------------------------
// Field metadata shared by updateSection and the import mapper
// ---------------------------------------------------------------------------

/** Quantity dimension of every mapped field; 'text' marks identifier/name fields. */
type FieldQuantityKind = ImportUnit | 'text';

const FIELD_QUANTITY: Readonly<Record<string, FieldQuantityKind>> = {
  'culinaryUse.populationServed': 'persons',
  'culinaryUse.activeConnections': 'connections',
  'culinaryUse.annualCulinaryVolumeGallons': 'gal',
  'culinaryUse.meteredPercent': 'percent',
  'sourceInventory[].sourceId': 'text',
  'sourceInventory[].name': 'text',
  'sourceInventory[].pumpCapacityGpm': 'gpm',
  'sourceInventory[].annualWithdrawalGallons': 'gal',
  'purchaseInventory[].sellerName': 'text',
  'purchaseInventory[].annualPurchasedGallons': 'gal',
  'wholesaleInventory[].buyerName': 'text',
  'wholesaleInventory[].annualSoldGallons': 'gal',
  'returnInventory[].receivingBody': 'text',
  'returnInventory[].annualReturnedGallons': 'gal',
  'sourcePeakDemand.peakDayDate': 'date',
  'sourcePeakDemand.peakDayVolumeGallons': 'gal',
  'sourcePeakDemand.peakHourDemandGpm': 'gpm',
  'secondaryUse.irrigatedAcres': 'acres',
  'secondaryUse.secondaryConnections': 'connections',
  'secondaryUse.annualSecondaryVolumeGallons': 'gal',
};

const SECTION_OF_CATEGORY: Readonly<Record<ReportingCategory, keyof ReportSections>> = {
  'culinary-use': 'culinaryUse',
  'source-inventory': 'sourceInventory',
  'purchase-inventory': 'purchaseInventory',
  'wholesale-inventory': 'wholesaleInventory',
  'return-inventory': 'returnInventory',
  'source-peak-demand': 'sourcePeakDemand',
  'secondary-use': 'secondaryUse',
};

const VOLUME_UNITS: ReadonlySet<string> = new Set(['gal', 'ac-ft', 'MG']);
const NON_VOLUME_UNITS: ReadonlySet<string> = new Set(['persons', 'connections', 'gpm', 'acres', 'percent', 'date']);

// ---------------------------------------------------------------------------
// The store (in-memory, deterministic ids, append-only submission history)
// ---------------------------------------------------------------------------

function draftKeyOf(orgId: string, systemId: string, period: ReportPeriod): string {
  return canonicalize({ orgId, systemId, basis: period.basis, year: period.year });
}

function draftIdOf(orgId: string, systemId: string, period: ReportPeriod): string {
  return `draft-${orgId}-${systemId}-${period.basis}-${period.year}`;
}

/** In-memory supplier-report store. One open draft per (org, system, period); submissions are immutable. */
export class SupplierReportStore {
  private readonly drafts = new Map<string, SupplierReportDraft>();
  private readonly openDraftByKey = new Map<string, string>();
  private readonly submissions = new Map<string, SubmittedReport>();
  private readonly submissionsByDraft = new Map<string, string[]>();
  private readonly submissionsByKey = new Map<string, string[]>();
  private readonly supersededBy = new Map<string, string>();

  draftById(draftId: string): SupplierReportDraft | null {
    return this.drafts.get(draftId) ?? null;
  }

  allDrafts(): readonly SupplierReportDraft[] {
    return [...this.drafts.values()];
  }

  submissionById(submissionId: string): SubmittedReport | null {
    return this.submissions.get(submissionId) ?? null;
  }

  submissionsOf(draftId: string): readonly SubmittedReport[] {
    return (this.submissionsByDraft.get(draftId) ?? []).map((id) => this.submissions.get(id)!).filter((s) => s !== undefined);
  }

  keyOf(draft: SupplierReportDraft): string {
    return draftKeyOf(draft.orgId, draft.systemId, draft.period);
  }

  latestSubmissionOfKey(key: string): SubmittedReport | null {
    const ids = this.submissionsByKey.get(key);
    if (!ids || ids.length === 0) return null;
    return this.submissions.get(ids[ids.length - 1]!) ?? null;
  }

  submissionHistoryOfKey(key: string): readonly SubmittedReport[] {
    return (this.submissionsByKey.get(key) ?? []).map((id) => this.submissions.get(id)!).filter((s) => s !== undefined);
  }

  supersededByOf(submissionId: string): string | null {
    return this.supersededBy.get(submissionId) ?? null;
  }

  /** Internal: put a derived draft record (an existing record is replaced by its derived copy, never mutated). */
  putDraft(draft: SupplierReportDraft, key: string): void {
    this.drafts.set(draft.draftId, draft);
    this.openDraftByKey.set(key, draft.draftId);
  }

  openDraftIdOfKey(key: string): string | null {
    return this.openDraftByKey.get(key) ?? null;
  }

  /** Internal: record an immutable submission. */
  putSubmission(submission: SubmittedReport, key: string, superseded: string | null): void {
    this.submissions.set(submission.submissionId, submission);
    const byDraft = this.submissionsByDraft.get(submission.draftId) ?? [];
    byDraft.push(submission.submissionId);
    this.submissionsByDraft.set(submission.draftId, byDraft);
    const byKey = this.submissionsByKey.get(key) ?? [];
    byKey.push(submission.submissionId);
    this.submissionsByKey.set(key, byKey);
    if (superseded) this.supersededBy.set(superseded, submission.submissionId);
  }

  /** Internal: replace a submission record by identity (resubmission approval only; content untouched). */
  replaceSubmission(submission: SubmittedReport): void {
    if (!this.submissions.has(submission.submissionId)) throw new Error(`replaceSubmission: unknown submission "${submission.submissionId}"`);
    this.submissions.set(submission.submissionId, submission);
  }
}

// ---------------------------------------------------------------------------
// Gating helper
// ---------------------------------------------------------------------------

interface DraftGate {
  readonly draft: SupplierReportDraft;
  readonly grant: SupplierScopeGrant;
}

function gateDraft(deps: SupplierDeps, store: SupplierReportStore, draftId: string, actorId: string | null): { outcome: 'allowed'; value: DraftGate } | SupplierDenial {
  const draft = store.draftById(draftId);
  if (!draft) {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: `draft "${draftId}" not found` };
  }
  const world = deps.world ?? supplierWorld().policyWorld;
  const scope = checkSupplierScope(world, actorId, draft.systemId, deps.now);
  if (scope.outcome === 'denied') return scope;
  if (scope.value.orgId !== draft.orgId) {
    // Belt-and-braces: the draft's org equals the anchored org by
    // construction; a mismatch would mean a corrupted record. Fail closed.
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'draft not found' };
  }
  return { outcome: 'allowed', value: { draft, grant: scope.value } };
}

// ---------------------------------------------------------------------------
// Section updates (manual entry path)
// ---------------------------------------------------------------------------

export type SectionPatch =
  | { readonly category: 'culinary-use'; readonly section: import('./types.ts').CulinaryUseSection }
  | { readonly category: 'source-inventory'; readonly section: readonly SourceInventoryEntry[] }
  | { readonly category: 'purchase-inventory'; readonly section: readonly import('./types.ts').PurchaseInventoryEntry[] }
  | { readonly category: 'wholesale-inventory'; readonly section: readonly import('./types.ts').WholesaleInventoryEntry[] }
  | { readonly category: 'return-inventory'; readonly section: readonly import('./types.ts').ReturnInventoryEntry[] }
  | { readonly category: 'source-peak-demand'; readonly section: import('./types.ts').SourcePeakDemandSection }
  | { readonly category: 'secondary-use'; readonly section: import('./types.ts').SecondaryUseSection };

function frozenDraftUpdate(draft: SupplierReportDraft, sections: ReportSections, actorId: string, now: string): SupplierReportDraft {
  return Object.freeze({
    ...draft,
    sections,
    updatedBy: actorId,
    updatedAt: now,
    validation: validateSections(sections, draft.period),
  });
}

/** Read one draft (org-isolated: the other supplier's draft id is a 404). */
export function getDraft(deps: SupplierDeps, store: SupplierReportStore, draftId: string, actorId: string | null): DomainResult<SupplierReportDraft> {
  const gate = gateDraft(deps, store, draftId, actorId);
  if (gate.outcome === 'denied') return gate;
  return { outcome: 'allowed', value: gate.value.draft };
}

/** Drafts of the actor's organization only (FR-053 isolation both directions). */
export function listDrafts(deps: SupplierDeps, store: SupplierReportStore, actorId: string | null): DomainResult<readonly SupplierReportDraft[]> {
  const world = deps.world ?? supplierWorld().policyWorld;
  const allowed: SupplierReportDraft[] = [];
  for (const draft of store.allDrafts()) {
    const scope = checkSupplierScope(world, actorId, draft.systemId, deps.now);
    if (scope.outcome === 'allowed' && scope.value.orgId === draft.orgId) allowed.push(draft);
  }
  allowed.sort((a, b) => (a.draftId < b.draftId ? -1 : 1));
  return { outcome: 'allowed', value: allowed };
}

/**
 * Open (or replay) the draft of one (system, period). The ORGANIZATION comes
 * from the actor's assignment, never from the request. When the key's latest
 * submission is still locked as 'submitted', a new version requires the
 * approved resubmission path first (422 SUBMISSION_LOCKED).
 */
export function createDraft(
  deps: SupplierDeps,
  store: SupplierReportStore,
  request: { readonly systemId: string; readonly period: ReportPeriod },
  actorId: string | null,
): DomainResult<SupplierReportDraft> {
  const world = deps.world ?? supplierWorld().policyWorld;
  const scope = checkSupplierScope(world, actorId, request.systemId, deps.now);
  if (scope.outcome === 'denied') return scope;
  if (!Number.isInteger(request.period.year) || request.period.year < 1900 || request.period.year > 2100) {
    return { outcome: 'denied', status: 422, code: 'INVALID_PERIOD', message: 'period.year must be an integer between 1900 and 2100' };
  }
  const key = draftKeyOf(scope.value.orgId, request.systemId, request.period);
  const latest = store.latestSubmissionOfKey(key);
  if (latest && latest.status === 'submitted') {
    return {
      outcome: 'denied',
      status: 422,
      code: 'SUBMISSION_LOCKED',
      message: `submission ${latest.submissionId} (version ${latest.version}) is submitted and frozen; a new version requires the reviewer-approved resubmission path`,
    };
  }
  const existingId = store.openDraftIdOfKey(key);
  if (existingId) {
    const existing = store.draftById(existingId);
    if (existing && existing.status === 'draft') return { outcome: 'allowed', value: existing }; // idempotent open
  }
  const draft: SupplierReportDraft = Object.freeze({
    draftId: draftIdOf(scope.value.orgId, request.systemId, request.period),
    orgId: scope.value.orgId,
    systemId: request.systemId,
    period: request.period,
    status: 'draft',
    submissionId: null,
    createdBy: actorId ?? 'anonymous',
    createdAt: deps.now,
    updatedBy: null,
    updatedAt: null,
    sections: EMPTY_SECTIONS,
    imports: [],
    validation: validateSections(EMPTY_SECTIONS, request.period),
  });
  store.putDraft(draft, key);
  return { outcome: 'allowed', value: draft };
}

/** Replace one category section (manual entry populates the same validated model as import). */
export function updateSection(
  deps: SupplierDeps,
  store: SupplierReportStore,
  draftId: string,
  patch: SectionPatch,
  actorId: string | null,
): DomainResult<SupplierReportDraft> {
  const gate = gateDraft(deps, store, draftId, actorId);
  if (gate.outcome === 'denied') return gate;
  const draft = gate.value.draft;
  if (draft.status !== 'draft') {
    return { outcome: 'denied', status: 422, code: 'DRAFT_LOCKED', message: `draft "${draftId}" is submitted (${draft.submissionId}); submitted content is frozen` };
  }
  const sectionKey = SECTION_OF_CATEGORY[patch.category];
  const sections: ReportSections = Object.freeze({ ...draft.sections, [sectionKey]: Object.freeze(patch.section) as never });
  const updated = frozenDraftUpdate(draft, sections, actorId ?? 'anonymous', deps.now);
  store.putDraft(updated, store.keyOf(draft));
  return { outcome: 'allowed', value: updated };
}

// ---------------------------------------------------------------------------
// Import (FR-056): preview maps units/periods; apply is idempotent by importId
// ---------------------------------------------------------------------------

const CATEGORY_ALIASES: Readonly<Record<string, ReportingCategory>> = {
  'culinary-use': 'culinary-use',
  culinary: 'culinary-use',
  'source-inventory': 'source-inventory',
  source: 'source-inventory',
  'purchase-inventory': 'purchase-inventory',
  purchases: 'purchase-inventory',
  'wholesale-inventory': 'wholesale-inventory',
  wholesale: 'wholesale-inventory',
  'return-inventory': 'return-inventory',
  returns: 'return-inventory',
  'source-peak-demand': 'source-peak-demand',
  'peak-demand': 'source-peak-demand',
  'secondary-use': 'secondary-use',
  secondary: 'secondary-use',
};

function resolveFieldRule(category: ReportingCategory, field: string): { quantity: FieldQuantityKind; canonicalPath: string } | null {
  const sectionKey = SECTION_OF_CATEGORY[category];
  const scalar = FIELD_QUANTITY[`${sectionKey}.${field}`];
  if (scalar) return { quantity: scalar, canonicalPath: `${sectionKey}.${field}` };
  const entry = FIELD_QUANTITY[`${sectionKey}[].${field}`];
  if (entry) return { quantity: entry, canonicalPath: `${sectionKey}[].${field}` };
  return null;
}

/**
 * Build the deterministic preview of an import file: mapped units and
 * periods per row, invalid rows with plain-text reasons, applicability.
 * PURE: no store mutation happens before applyImport.
 */
export function previewImport(
  deps: SupplierDeps,
  store: SupplierReportStore,
  draftId: string,
  input: { readonly importId: string; readonly filePeriod: ImportFilePeriod; readonly rows: readonly ImportFileRow[] },
  actorId: string | null,
): DomainResult<ImportPreview> {
  const gate = gateDraft(deps, store, draftId, actorId);
  if (gate.outcome === 'denied') return gate;
  const draft = gate.value.draft;

  const periodMatches = input.filePeriod.basis === draft.period.basis && input.filePeriod.year === draft.period.year;
  const periodMappingNote = periodMatches
    ? `File period ${input.filePeriod.basis} ${input.filePeriod.year} maps 1:1 to the draft period (${draft.period.basis} ${draft.period.year}).`
    : `File period ${input.filePeriod.basis} ${input.filePeriod.year} does NOT match the draft period (${draft.period.basis} ${draft.period.year}); the import is not applicable.`;

  const mappings: ImportMappingRow[] = [];
  const invalidRows: ImportInvalidRow[] = [];
  for (const row of input.rows) {
    const category = CATEGORY_ALIASES[row.category];
    if (!category) {
      invalidRows.push({ rowIndex: row.rowIndex, reason: `Row ${row.rowIndex}: unknown reporting category "${row.category}" (expected one of ${Object.keys(CATEGORY_LABELS).join(', ')}).` });
      continue;
    }
    const rule = resolveFieldRule(category, row.field);
    if (!rule) {
      invalidRows.push({ rowIndex: row.rowIndex, reason: `Row ${row.rowIndex}: unknown field "${row.field}" for category ${CATEGORY_LABELS[category]}.` });
      continue;
    }
    if (rule.quantity === 'text') {
      mappings.push({
        rowIndex: row.rowIndex,
        category,
        field: row.field,
        entryKey: row.entryKey,
        rawValue: row.rawValue,
        rawUnit: row.rawUnit,
        mappedValue: row.rawValue.trim(),
        mappedUnit: 'text',
        note: `Text value for ${rule.canonicalPath}${row.entryKey ? ` of entry "${row.entryKey}"` : ''}.`,
      });
      continue;
    }
    if (rule.quantity === 'date') {
      mappings.push({
        rowIndex: row.rowIndex,
        category,
        field: row.field,
        entryKey: row.entryKey,
        rawValue: row.rawValue,
        rawUnit: row.rawUnit,
        mappedValue: row.rawValue.trim(),
        mappedUnit: 'YYYY-MM-DD',
        note: `Calendar date for ${rule.canonicalPath}; validated against the reported period.`,
      });
      continue;
    }
    // Numeric quantity: the file unit must convert to the field's canonical quantity.
    if (!VOLUME_UNITS.has(row.rawUnit) && !NON_VOLUME_UNITS.has(row.rawUnit)) {
      invalidRows.push({ rowIndex: row.rowIndex, reason: `Row ${row.rowIndex}: unknown unit "${row.rawUnit}".` });
      continue;
    }
    const numeric = Number(row.rawValue.replace(/,/g, ''));
    if (!Number.isFinite(numeric)) {
      invalidRows.push({ rowIndex: row.rowIndex, reason: `Row ${row.rowIndex}: value "${row.rawValue}" is not a number.` });
      continue;
    }
    if (VOLUME_UNITS.has(row.rawUnit)) {
      if (rule.quantity !== 'gal') {
        invalidRows.push({ rowIndex: row.rowIndex, reason: `Row ${row.rowIndex}: unit "${row.rawUnit}" is a volume, but field ${rule.canonicalPath} measures ${rule.quantity}.` });
        continue;
      }
      const factor = UNIT_FACTORS[row.rawUnit]!;
      const mapped = numeric * factor;
      mappings.push({
        rowIndex: row.rowIndex,
        category,
        field: row.field,
        entryKey: row.entryKey,
        rawValue: row.rawValue,
        rawUnit: row.rawUnit,
        mappedValue: Math.round(mapped * 1e6) / 1e6,
        mappedUnit: 'gallons',
        note: `Converted ${numeric.toLocaleString('en-US')} ${row.rawUnit} x ${factor} = ${Math.round(mapped * 1e6) / 1e6} gallons (documented factor).`,
      });
      continue;
    }
    if (row.rawUnit !== rule.quantity) {
      invalidRows.push({ rowIndex: row.rowIndex, reason: `Row ${row.rowIndex}: unit "${row.rawUnit}" does not match field ${rule.canonicalPath} (${rule.quantity}); there is no conversion between different quantities.` });
      continue;
    }
    mappings.push({
      rowIndex: row.rowIndex,
      category,
      field: row.field,
      entryKey: row.entryKey,
      rawValue: row.rawValue,
      rawUnit: row.rawUnit,
      mappedValue: numeric,
      mappedUnit: String(rule.quantity),
      note: `Direct mapping: ${rule.quantity} is already the canonical unit of ${rule.canonicalPath}.`,
    });
  }

  return {
    outcome: 'allowed',
    value: {
      importId: input.importId,
      targetDraftId: draftId,
      filePeriod: input.filePeriod,
      periodMappingNote,
      mappings: Object.freeze(mappings),
      invalidRows: Object.freeze(invalidRows),
      applicable: periodMatches && draft.status === 'draft',
    },
  };
}

/** The entry key field of each inventory section. */
const ENTRY_KEY_FIELD: Readonly<Record<string, string>> = {
  sourceInventory: 'sourceId',
  purchaseInventory: 'sellerName',
  wholesaleInventory: 'buyerName',
  returnInventory: 'receivingBody',
};

function cloneSections(sections: ReportSections): Record<string, unknown> {
  return {
    culinaryUse: { ...(sections.culinaryUse as Record<string, unknown>) },
    sourceInventory: (sections.sourceInventory as ReadonlyArray<Record<string, unknown>>).map((entry) => ({ ...entry })),
    purchaseInventory: (sections.purchaseInventory as ReadonlyArray<Record<string, unknown>>).map((entry) => ({ ...entry })),
    wholesaleInventory: (sections.wholesaleInventory as ReadonlyArray<Record<string, unknown>>).map((entry) => ({ ...entry })),
    returnInventory: (sections.returnInventory as ReadonlyArray<Record<string, unknown>>).map((entry) => ({ ...entry })),
    sourcePeakDemand: { ...(sections.sourcePeakDemand as Record<string, unknown>) },
    secondaryUse: { ...(sections.secondaryUse as Record<string, unknown>) },
  };
}

function upsertEntry(entries: Record<string, unknown>[], keyField: string, keyValue: string, field: string, value: number | string): void {
  const existing = entries.find((entry) => String(entry[keyField]) === keyValue);
  if (existing) {
    existing[field] = value;
    return;
  }
  const fresh: Record<string, unknown> = { [keyField]: keyValue };
  fresh[field] = value;
  if (keyField === 'sourceId') fresh['sourceType'] = 'other'; // documented default; validation surfaces incomplete entries
  entries.push(fresh);
}

/**
 * Apply an import preview to the draft. IDEMPOTENT by importId: when the
 * importId was already applied the ORIGINAL result replays and no value is
 * written a second time (FR-056 "avoids duplicate values when a file is
 * retried").
 */
export function applyImport(deps: SupplierDeps, store: SupplierReportStore, preview: ImportPreview, actorId: string | null): DomainResult<ImportApplyResult> {
  const gate = gateDraft(deps, store, preview.targetDraftId, actorId);
  if (gate.outcome === 'denied') return gate;
  const draft = gate.value.draft;

  const already = draft.imports.find((record) => record.importId === preview.importId);
  if (already) {
    return { outcome: 'allowed', value: { importId: preview.importId, replayed: true, appliedRowCount: already.appliedRowCount } };
  }
  if (draft.status !== 'draft') {
    return { outcome: 'denied', status: 422, code: 'DRAFT_LOCKED', message: `draft "${draft.draftId}" is submitted; submitted content is frozen` };
  }
  if (!preview.applicable) {
    return { outcome: 'denied', status: 422, code: 'IMPORT_NOT_APPLICABLE', message: 'the preview is not applicable (period mismatch or locked draft); fix the file period or unlock first' };
  }

  const next = cloneSections(draft.sections);
  for (const mapping of preview.mappings) {
    const sectionKey = SECTION_OF_CATEGORY[mapping.category];
    if (sectionKey === 'sourceInventory' || sectionKey === 'purchaseInventory' || sectionKey === 'wholesaleInventory' || sectionKey === 'returnInventory') {
      const keyField = ENTRY_KEY_FIELD[sectionKey]!;
      const entryKey = mapping.entryKey ?? String(mapping.mappedValue);
      upsertEntry(next[sectionKey] as Record<string, unknown>[], keyField, entryKey, mapping.field, mapping.mappedValue);
      continue;
    }
    (next[sectionKey] as Record<string, unknown>)[mapping.field] = mapping.mappedValue;
  }

  const sections = Object.freeze({
    culinaryUse: Object.freeze(next['culinaryUse']),
    sourceInventory: Object.freeze(next['sourceInventory']),
    purchaseInventory: Object.freeze(next['purchaseInventory']),
    wholesaleInventory: Object.freeze(next['wholesaleInventory']),
    returnInventory: Object.freeze(next['returnInventory']),
    sourcePeakDemand: Object.freeze(next['sourcePeakDemand']),
    secondaryUse: Object.freeze(next['secondaryUse']),
  }) as unknown as ReportSections;
  const importRecord = { importId: preview.importId, importedAt: deps.now, importedBy: actorId ?? 'anonymous', appliedRowCount: preview.mappings.length };
  const updated = Object.freeze({
    ...draft,
    sections,
    imports: [...draft.imports, importRecord],
    updatedBy: actorId ?? 'anonymous',
    updatedAt: deps.now,
    validation: validateSections(sections, draft.period),
  });
  store.putDraft(updated, store.keyOf(draft));
  return { outcome: 'allowed', value: { importId: preview.importId, replayed: false, appliedRowCount: preview.mappings.length } };
}

// ---------------------------------------------------------------------------
// Submit (FR-057 state machine) and resubmission approval
// ---------------------------------------------------------------------------

function contentHashOf(submission: Omit<SubmittedReport, 'contentHash' | 'pdf'>): string {
  const preimage = {
    schemaVersion: submission.schemaVersion,
    orgId: submission.orgId,
    systemId: submission.systemId,
    period: { basis: submission.period.basis, year: submission.period.year },
    version: submission.version,
    submitter: submission.submitter,
    submittedAt: submission.submittedAt,
    content: submission.content,
    imports: submission.imports,
    acknowledgedWarnings: submission.acknowledgedWarnings,
    validation: submission.validation,
  };
  return sha256Hex(canonicalize(preimage));
}

/**
 * Submit a draft: validate ALL categories first (errors block, warnings are
 * acknowledged), then freeze the content with a content hash and the
 * deterministic PDF manifest reference. IDEMPOTENT: retrying with the same
 * submission id - or any submit of an already-submitted draft - returns the
 * ORIGINAL submitted record (replayed: true).
 */
export function submit(
  deps: SupplierDeps,
  store: SupplierReportStore,
  draftId: string,
  actorId: string | null,
  options: { readonly submissionId?: string | null } = {},
): DomainResult<SubmissionOutcome> {
  const gate = gateDraft(deps, store, draftId, actorId);
  if (gate.outcome === 'denied') return gate;
  const draft = gate.value.draft;

  if (draft.status === 'submitted' && draft.submissionId) {
    const original = store.submissionById(draft.submissionId);
    if (original) {
      return { outcome: 'allowed', value: { submission: original, replayed: true, superseded: store.supersededByOf(original.submissionId) } };
    }
  }

  if (options.submissionId) {
    const existing = store.submissionById(options.submissionId);
    if (existing) {
      if (existing.draftId === draftId) {
        return { outcome: 'allowed', value: { submission: existing, replayed: true, superseded: store.supersededByOf(existing.submissionId) } };
      }
      return { outcome: 'denied', status: 422, code: 'SUBMISSION_ID_REUSED', message: `submission id "${options.submissionId}" belongs to a different draft (${existing.draftId})` };
    }
  }

  // Validate ALL categories; blocking errors carry the summary object.
  const validation = validateSections(draft.sections, draft.period);
  if (validation.summary.errorCount > 0) {
    const denial: SupplierDenial = {
      outcome: 'denied',
      status: 422,
      code: 'VALIDATION_FAILED',
      message: `submission blocked by ${validation.summary.errorCount} validation error(s): ${validation.summary.headline}`,
      issues: validation.issues,
      summary: validation.summary,
    };
    return denial;
  }

  const key = store.keyOf(draft);
  const priorVersions = store.submissionHistoryOfKey(key);
  if (priorVersions.length > 0) {
    const latest = priorVersions[priorVersions.length - 1]!;
    if (latest.status === 'submitted') {
      return {
        outcome: 'denied',
        status: 422,
        code: 'SUBMISSION_LOCKED',
        message: `submission ${latest.submissionId} (version ${latest.version}) already exists for this period; a new version requires the reviewer-approved resubmission path`,
      };
    }
  }

  const base: Omit<SubmittedReport, 'contentHash' | 'pdf' | 'submissionId'> = {
    schemaVersion: SUPPLIER_REPORT_SCHEMA_VERSION,
    draftId: draft.draftId,
    orgId: draft.orgId,
    systemId: draft.systemId,
    period: draft.period,
    version: priorVersions.length + 1,
    submitter: actorId ?? 'anonymous',
    submittedAt: deps.now,
    status: 'submitted',
    resubmissionApprovedBy: null,
    resubmissionApprovedAt: null,
    resubmissionNote: null,
    content: draft.sections,
    imports: draft.imports,
    acknowledgedWarnings: validation.issues.filter((issue) => issue.severity === 'warning'),
    validation,
  };
  const contentHash = contentHashOf({ ...base, submissionId: '' });
  const submissionId = options.submissionId ?? `sub-${contentHash.slice(0, 12)}`;
  const withoutPdf: Omit<SubmittedReport, 'pdf'> = { ...base, submissionId, contentHash };
  // The manifest is DERIVED from the submission; the content-hash preimage
  // deliberately excludes the pdf reference (no circularity).
  const probe: SubmittedReport = { ...withoutPdf, pdf: { manifestVersion: 1, manifestHash: '' } };
  const manifest = buildPdfManifest(probe);
  const submission: SubmittedReport = Object.freeze({
    ...withoutPdf,
    pdf: { manifestVersion: 1, manifestHash: manifest.manifestHash },
  });
  store.putSubmission(submission, key, priorVersions.length > 0 ? priorVersions[priorVersions.length - 1]!.submissionId : null);
  const lockedDraft = Object.freeze({ ...draft, status: 'submitted' as const, submissionId, updatedBy: actorId ?? 'anonymous', updatedAt: deps.now });
  store.putDraft(lockedDraft, key);
  return {
    outcome: 'allowed',
    value: { submission, replayed: false, superseded: priorVersions.length > 0 ? priorVersions[priorVersions.length - 1]!.submissionId : null },
  };
}

/**
 * The reviewer-approved resubmission transition: unlocks a NEW draft version
 * for the same (org, system, period) while the submitted CONTENT stays
 * frozen (identical contentHash). Reviewer-only (role family 'owner'); the
 * proposing supplier cannot self-approve.
 */
export function approveResubmission(
  deps: SupplierDeps,
  store: SupplierReportStore,
  submissionId: string,
  reviewerActorId: string | null,
  decisionNote: string,
): DomainResult<SubmittedReport> {
  const submission = store.submissionById(submissionId);
  if (!submission) {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: `submission "${submissionId}" not found` };
  }
  const world = deps.world ?? supplierWorld().policyWorld;
  const scope = checkReviewerScope(world, reviewerActorId, submission.systemId, deps.now);
  if (scope.outcome === 'denied') return scope;
  if (scope.value.orgId !== submission.orgId) {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'submission not found' };
  }
  if (submission.status !== 'submitted') {
    return { outcome: 'denied', status: 422, code: 'RESUBMISSION_ALREADY_APPROVED', message: `submission ${submissionId} is already ${submission.status}` };
  }
  const approved: SubmittedReport = Object.freeze({
    ...submission,
    status: 'resubmission-approved',
    resubmissionApprovedBy: reviewerActorId,
    resubmissionApprovedAt: deps.now,
    resubmissionNote: decisionNote,
  });
  store.replaceSubmission(approved);
  return { outcome: 'allowed', value: approved };
}

/** All submissions of the actor's organization (FR-053: never the other supplier's). */
export function listSubmissions(deps: SupplierDeps, store: SupplierReportStore, actorId: string | null): DomainResult<readonly SubmittedReport[]> {
  const world = deps.world ?? supplierWorld().policyWorld;
  const seenKeys = new Set<string>();
  const out: SubmittedReport[] = [];
  for (const draft of store.allDrafts()) {
    const scope = checkSupplierScope(world, actorId, draft.systemId, deps.now);
    if (scope.outcome !== 'allowed' || scope.value.orgId !== draft.orgId) continue;
    const key = store.keyOf(draft);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push(...store.submissionHistoryOfKey(key));
  }
  out.sort((a, b) => (a.submissionId < b.submissionId ? -1 : 1));
  return { outcome: 'allowed', value: out };
}

// ---------------------------------------------------------------------------
// Assigned supplier system view (FR-053)
// ---------------------------------------------------------------------------

/** Documented historical window: the three fixture years ending at the fixture present (2026). */
export const HISTORICAL_YEARS: readonly number[] = Object.freeze([2024, 2025, 2026]);

function yearlyVolume(store: SeriesStore, streamId: string, year: number): { volumeAcreFeet: number | null; coverageFraction: number } {
  const range = seasonWindow('calendar-year', year);
  const result = aggregateSeries(store, {
    streamId,
    start: new Date(localMidnightInstant(range.start, 'America/Denver')).toISOString(),
    end: new Date(localMidnightInstant(range.end, 'America/Denver')).toISOString(),
    basis: 'raw',
    interval: 'seasonal',
    season: 'calendar-year',
  });
  if (result.outcome === 'denied') return { volumeAcreFeet: null, coverageFraction: 0 };
  const buckets = result.value.buckets;
  if (buckets.length === 0) return { volumeAcreFeet: null, coverageFraction: 0 };
  let covered = 0;
  let duration = 0;
  let volume = 0;
  let anyCovered = false;
  for (const bucket of buckets) {
    covered += bucket.coveredSeconds;
    duration += bucket.durationSeconds;
    if (bucket.volumeAcreFeet === null) continue;
    anyCovered = true;
    volume += bucket.volumeAcreFeet;
  }
  // No covered data -> null (unavailable), never zero (NFR-007).
  return { volumeAcreFeet: anyCovered ? volume : null, coverageFraction: duration > 0 ? covered / duration : 0 };
}

/**
 * The FR-053 assigned system view: sources, purchases/wholesale/returns
 * state, historical discharge comparisons (WD-008 numerics; null = no
 * covered data, never zero) and THIS organization's submitted history.
 */
export function systemView(
  deps: SupplierDeps,
  reportStore: SupplierReportStore,
  actorId: string | null,
  systemId: string,
  boundaries?: SupplierBoundaryStore,
): DomainResult<SupplierSystemView> {
  const world = deps.world ?? supplierWorld().policyWorld;
  const fixture = supplierWorld();
  const scope = checkSupplierScope(world, actorId, systemId, deps.now);
  if (scope.outcome === 'denied') return scope;
  const anchor = anchorOfSystem(fixture, systemId);
  if (!anchor || anchor.orgId !== scope.value.orgId) {
    return { outcome: 'denied', status: 404, code: 'NOT_FOUND', message: 'system not found', policyReason: 'DENY_OUT_OF_SCOPE' };
  }

  const sources = fixture.stations
    .filter((station) => station.orgId === scope.value.orgId)
    .map((station) => ({
      stationId: station.stationId,
      displayName: station.displayName,
      status: station.status,
      visibility: station.visibility,
      dischargeStreams: station.dischargeStreams,
    }));

  const store = deps.store ?? seriesStore();
  const historicalDischarge = sources
    .flatMap((source) => source.dischargeStreams.map((stream) => ({ source, stream })))
    .map(({ source, stream }) => ({
      streamId: stream.streamId,
      stationId: source.stationId,
      unitId: stream.unitId,
      years: HISTORICAL_YEARS.map((year) => {
        const totals = yearlyVolume(store, stream.streamId, year);
        return { year, volumeAcreFeet: totals.volumeAcreFeet, coverageFraction: totals.coverageFraction };
      }),
    }))
    .sort((a, b) => (a.streamId < b.streamId ? -1 : 1));

  const history: SubmittedHistoryEntry[] = [];
  let openDraftId: string | null = null;
  let latestSubmissionId: string | null = null;
  let inventorySnapshot: SupplierSystemView['inventorySnapshot'] = { kind: 'none' };
  const candidates = reportStore
    .allDrafts()
    .filter((draft) => draft.systemId === systemId && draft.orgId === scope.value.orgId)
    .sort((a, b) => (a.draftId < b.draftId ? -1 : 1));
  for (const draft of candidates) {
    if (draft.status === 'draft') openDraftId = draft.draftId;
    const submissions = reportStore.submissionsOf(draft.draftId);
    if (submissions.length > 0) {
      const latest = submissions[submissions.length - 1]!;
      latestSubmissionId = latest.submissionId;
      inventorySnapshot = {
        kind: 'submitted',
        submissionId: latest.submissionId,
        version: latest.version,
        purchases: latest.content.purchaseInventory.length,
        wholesale: latest.content.wholesaleInventory.length,
        returns: latest.content.returnInventory.length,
      };
    } else if (draft.status === 'draft' && inventorySnapshot.kind === 'none') {
      inventorySnapshot = {
        kind: 'draft',
        draftId: draft.draftId,
        purchases: draft.sections.purchaseInventory.length,
        wholesale: draft.sections.wholesaleInventory.length,
        returns: draft.sections.returnInventory.length,
      };
    }
    for (const submission of submissions) {
      history.push({
        submissionId: submission.submissionId,
        version: submission.version,
        submitter: submission.submitter,
        submittedAt: submission.submittedAt,
        status: submission.status,
        contentHash: submission.contentHash,
      });
    }
  }
  history.sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : a.submissionId < b.submissionId ? -1 : 1));

  const approvedBoundaryVersion = boundaries ? boundaries.approvedVersionOf(scope.value.orgId, systemId) : 1;

  return {
    outcome: 'allowed',
    value: {
      systemId,
      systemName: anchor.systemName,
      orgId: scope.value.orgId,
      orgName: anchor.orgName,
      sources,
      historicalDischarge,
      openDraftId,
      latestSubmissionId,
      inventorySnapshot,
      submittedHistory: history,
      approvedBoundaryVersion,
    },
  };
}
