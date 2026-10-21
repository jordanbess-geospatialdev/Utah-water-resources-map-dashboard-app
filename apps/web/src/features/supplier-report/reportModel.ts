/**
 * reportModel - pure view/validation models for the WD-017 supplier-report
 * feature (FR-053..FR-057).
 *
 * MIRROR CONTRACT (the established WD-008/WD-025 pattern):
 * - Category rules, messages and the accessible summary mirror
 *   services/api/src/workflows/supplier-report/validate.ts;
 * - the import unit/period mapping mirrors report.ts previewImport/
 *   applyImport (documented factors, same invalid-row reasons, idempotent
 *   retry semantics);
 * - the historical discharge mirror implements the same rectangle-right
 *   "a reading governs until the next reading, at most its cadence" rule
 *   for the fixture's owner streams and is pinned by test to the SAME
 *   golden as the API suite (str-hyrum-q-owner CY-2026 = 26978/121);
 * - the demo submission freeze mirrors report.ts submit + pdf.ts manifest
 *   shape; the demo content hash is the deterministic FNV-style digest also
 *   used by WD-025 (labeled a demo stand-in in the UI, NOT the server's
 *   sha256).
 *
 * The API remains the source of truth; the demo exists because the HTTP
 * service is not wired yet (README.md). Deterministic: no clock reads (the
 * submit timestamp is passed in, default the fixture clock), no randomness.
 */
import { FIXTURE_CLOCK, observations, organizations, stations, systems, users } from '../../shell/data/fixtures';
import type { DatastreamRecord, ObservationRecord, StationRecord } from '../../shell/data/types';

// ---------------------------------------------------------------------------
// Supplier scope (FR-053 mirror of world.ts anchor derivation)
// ---------------------------------------------------------------------------

export interface SupplierOrgScope {
  readonly orgId: string;
  readonly orgName: string;
  readonly systemId: string;
  readonly systemName: string;
  readonly stations: readonly { readonly stationId: string; readonly displayName: string; readonly status: string; readonly visibility: string; readonly dischargeStreams: readonly { readonly streamId: string; readonly unitId: string }[] }[];
}

/** Owner organizations anchored to their systems via station ownership (fixture-derived, both orgs). */
export const SUPPLIER_ORGS: readonly SupplierOrgScope[] = (() => {
  const scopes: SupplierOrgScope[] = [];
  for (const org of organizations) {
    const owned = stations.filter((station) => station.ownerOrganizationId === org.id);
    if (owned.length === 0) continue;
    const systemId = owned[0]!.systemId;
    const system = systems.find((candidate) => candidate.id === systemId);
    scopes.push({
      orgId: org.id,
      orgName: org.name,
      systemId,
      systemName: system?.name ?? systemId,
      stations: owned.map((station) => ({
        stationId: station.id,
        displayName: station.displayName,
        status: station.status,
        visibility: station.visibility,
        dischargeStreams: station.datastreams
          .filter((stream: DatastreamRecord) => stream.observedPropertyId === 'discharge')
          .map((stream) => ({ streamId: stream.id, unitId: stream.unitId })),
      })),
    });
  }
  return scopes.sort((a, b) => (a.orgId < b.orgId ? -1 : 1));
})();

/**
 * Demo acting accounts. Wiley is the documented demo synthesis (member of
 * org-cache-water; principals.json defines the organization, not a member
 * account); Morgan covers the second organization so the UI can demonstrate
 * cross-supplier isolation. The server re-evaluates real assignments.
 */
export interface DemoSupplierActor {
  readonly id: string;
  readonly displayName: string;
  readonly orgId: string;
  readonly role: 'supplier' | 'reviewer';
}

export const DEMO_ACTORS: readonly DemoSupplierActor[] = [
  { id: 'demo-wiley-cache-water', displayName: 'Wiley Ostler (demo synthesis)', orgId: 'org-cache-water', role: 'supplier' },
  { id: 'demo-morgan-bear-river-users', displayName: 'Morgan Reyes (demo synthesis)', orgId: 'org-bear-river-users', role: 'supplier' },
  { id: 'demo-wum-reviewer-cache', displayName: 'Water Use reviewer (Cache, demo)', orgId: 'org-cache-water', role: 'reviewer' },
];

export function demoActor(actorId: string): DemoSupplierActor | null {
  return DEMO_ACTORS.find((actor) => actor.id === actorId) ?? null;
}

export function scopeOfActor(actorId: string): SupplierOrgScope | null {
  const actor = demoActor(actorId);
  if (!actor) return null;
  return SUPPLIER_ORGS.find((scope) => scope.orgId === actor.orgId) ?? null;
}

/** Fixture principals hold no supplier reporting: their scope is none (403 server-side). */
export function fixturePrincipalName(actorId: string): string | null {
  return users.find((user) => user.id === actorId)?.displayName ?? null;
}

// ---------------------------------------------------------------------------
// Period (shared vocabulary with WD-025)
// ---------------------------------------------------------------------------

export type PeriodBasis = 'calendar-year' | 'water-year' | 'irrigation-season';

export interface ReportPeriod {
  readonly basis: PeriodBasis;
  readonly year: number;
}

export const PERIOD_RULES: Readonly<Record<PeriodBasis, string>> = {
  'calendar-year': 'Jan 1 through Jan 1 next year (local, America/Denver)',
  'water-year': 'Oct 1 of the previous year through Oct 1 (USGS water year ending Sep 30)',
  'irrigation-season': 'Apr 1 through Nov 1 exclusive (Apr 1 - Oct 31)',
};

/** Civil-date period membership (mirror of validate.ts dateInPeriod). */
export function dateInPeriod(date: string, period: ReportPeriod): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date)) return false;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  switch (period.basis) {
    case 'calendar-year':
      return year === period.year;
    case 'water-year':
      return year === period.year ? month <= 9 : year === period.year - 1 && month >= 10;
    case 'irrigation-season':
      return year === period.year && month >= 4 && month <= 10;
  }
}

// ---------------------------------------------------------------------------
// Category sections and validation (FR-055 mirror)
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

export type SourceType = 'well' | 'spring' | 'surface-water' | 'other';
export type ReturnType = 'treated-effluent' | 'raw-water' | 'other';
export const SOURCE_TYPES: readonly SourceType[] = ['well', 'spring', 'surface-water', 'other'];
export const RETURN_TYPES: readonly ReturnType[] = ['treated-effluent', 'raw-water', 'other'];

export interface CulinaryUseSection {
  populationServed: number | null;
  activeConnections: number | null;
  annualCulinaryVolumeGallons: number | null;
  meteredPercent: number | null;
}
export interface SourceInventoryEntry {
  sourceId: string;
  sourceType: SourceType;
  name: string;
  pumpCapacityGpm: number | null;
  annualWithdrawalGallons: number | null;
  metered: boolean;
}
export interface PurchaseInventoryEntry {
  sellerName: string;
  annualPurchasedGallons: number | null;
}
export interface WholesaleInventoryEntry {
  buyerName: string;
  annualSoldGallons: number | null;
}
export interface ReturnInventoryEntry {
  returnType: ReturnType;
  receivingBody: string;
  annualReturnedGallons: number | null;
}
export interface SourcePeakDemandSection {
  peakDayDate: string | null;
  peakDayVolumeGallons: number | null;
  peakHourDemandGpm: number | null;
}
export interface SecondaryUseSection {
  irrigatedAcres: number | null;
  secondaryConnections: number | null;
  annualSecondaryVolumeGallons: number | null;
  metered: boolean | null;
}

export interface ReportSections {
  culinaryUse: CulinaryUseSection;
  sourceInventory: SourceInventoryEntry[];
  purchaseInventory: PurchaseInventoryEntry[];
  wholesaleInventory: WholesaleInventoryEntry[];
  returnInventory: ReturnInventoryEntry[];
  sourcePeakDemand: SourcePeakDemandSection;
  secondaryUse: SecondaryUseSection;
}

export const EMPTY_SECTIONS: ReportSections = {
  culinaryUse: { populationServed: null, activeConnections: null, annualCulinaryVolumeGallons: null, meteredPercent: null },
  sourceInventory: [],
  purchaseInventory: [],
  wholesaleInventory: [],
  returnInventory: [],
  sourcePeakDemand: { peakDayDate: null, peakDayVolumeGallons: null, peakHourDemandGpm: null },
  secondaryUse: { irrigatedAcres: null, secondaryConnections: null, annualSecondaryVolumeGallons: null, metered: null },
};

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  readonly fieldPath: string;
  readonly category: ReportingCategory;
  readonly severity: IssueSeverity;
  readonly code: 'MISSING_REQUIRED' | 'INVALID_VALUE' | 'UNREASONABLE_VALUE' | 'PERIOD_MISMATCH';
  readonly message: string;
}

export interface ValidationSummary {
  readonly errorCount: number;
  readonly warningCount: number;
  readonly headline: string;
  readonly lines: readonly string[];
}

export interface ValidationSnapshot {
  readonly issues: readonly ValidationIssue[];
  readonly summary: ValidationSummary;
}

/** Field metadata mirrored from validate.ts FIELD_RULES (label, unit, required, plausible range, rationale). */
export interface FieldSpec {
  readonly key: keyof CulinaryUseSection | keyof SourcePeakDemandSection | keyof SecondaryUseSection | keyof SourceInventoryEntry;
  readonly label: string;
  readonly unit: string;
  readonly required: boolean;
  readonly integer?: boolean;
  readonly zeroIsError?: boolean;
  readonly plausibleMin: number;
  readonly plausibleMax: number;
  readonly rationale: string;
}

export const SCALAR_FIELDS: Readonly<Record<'culinary-use' | 'source-peak-demand' | 'secondary-use', readonly FieldSpec[]>> = {
  'culinary-use': [
    { key: 'populationServed', label: 'Population served', unit: 'persons', required: true, integer: true, zeroIsError: true, plausibleMin: 10, plausibleMax: 5_000_000, rationale: 'Utah community water systems range from small HOAs to ~1M-resident wholesalers; >5M persons exceeds any Utah system.' },
    { key: 'activeConnections', label: 'Active connections', unit: 'connections', required: true, integer: true, zeroIsError: true, plausibleMin: 5, plausibleMax: 500_000, rationale: 'A reporting culinary system serves at least a handful of connections.' },
    { key: 'annualCulinaryVolumeGallons', label: 'Annual culinary volume', unit: 'gallons', required: true, plausibleMin: 100_000, plausibleMax: 100_000_000_000, rationale: 'Between a small system month and the largest statewide annual diversions.' },
    { key: 'meteredPercent', label: 'Metered share', unit: 'percent', required: false, plausibleMin: 0, plausibleMax: 100, rationale: 'A share of volume; 0-100 only.' },
  ],
  'source-peak-demand': [
    { key: 'peakDayDate', label: 'Peak day', unit: 'date', required: true, plausibleMin: 0, plausibleMax: 0, rationale: 'The observed peak day must be a real local calendar day inside the reported period.' },
    { key: 'peakDayVolumeGallons', label: 'Peak-day volume', unit: 'gallons', required: true, plausibleMin: 10_000, plausibleMax: 10_000_000_000, rationale: 'At least a tanker-load; below the largest statewide daily diversions.' },
    { key: 'peakHourDemandGpm', label: 'Peak-hour demand', unit: 'gpm', required: false, zeroIsError: true, plausibleMin: 1, plausibleMax: 50_000, rationale: 'Largest culinary well pumps ~5 000 gpm; plant peaks below 50 000 gpm.' },
  ],
  'secondary-use': [
    { key: 'irrigatedAcres', label: 'Irrigated acres', unit: 'acres', required: false, plausibleMin: 0.5, plausibleMax: 100_000, rationale: 'From a school lawn to ~100k-acre canal service areas.' },
    { key: 'secondaryConnections', label: 'Secondary connections', unit: 'connections', required: false, integer: true, plausibleMin: 0, plausibleMax: 100_000, rationale: 'Zero connections is a legitimate answer (no secondary system).' },
    { key: 'annualSecondaryVolumeGallons', label: 'Annual secondary volume', unit: 'gallons', required: false, plausibleMin: 10_000, plausibleMax: 100_000_000_000, rationale: 'Same volume envelope as culinary use.' },
  ],
};

function categoryOfPath(fieldPath: string): ReportingCategory {
  const head = fieldPath.split('.')[0] ?? '';
  const map: Record<string, ReportingCategory> = {
    culinaryUse: 'culinary-use',
    sourceInventory: 'source-inventory',
    purchaseInventory: 'purchase-inventory',
    wholesaleInventory: 'wholesale-inventory',
    returnInventory: 'return-inventory',
    sourcePeakDemand: 'source-peak-demand',
    secondaryUse: 'secondary-use',
  };
  return map[head] ?? 'culinary-use';
}

function labelOf(category: ReportingCategory): string {
  return CATEGORY_LABELS[category];
}

/** validateSections mirror: same severities, codes and message shapes as the API. */
export function validateSections(sections: ReportSections, period: ReportPeriod): ValidationSnapshot {
  const issues: ValidationIssue[] = [];
  const push = (fieldPath: string, severity: IssueSeverity, code: ValidationIssue['code'], message: string): void => {
    issues.push({ fieldPath, category: categoryOfPath(fieldPath), severity, code, message });
  };

  const checkNumeric = (category: ReportingCategory, spec: FieldSpec, value: number, fieldPath: string): void => {
    const label = `${labelOf(category)} — ${spec.label} (${spec.unit})`;
    if (spec.integer && !Number.isInteger(value)) {
      push(fieldPath, 'error', 'INVALID_VALUE', `${label} must be a whole number.`);
      return;
    }
    if (value < 0) {
      push(fieldPath, 'error', 'INVALID_VALUE', `${label} is negative; report 0 rather than a negative amount.`);
      return;
    }
    if (spec.zeroIsError && value === 0) {
      push(fieldPath, 'error', 'INVALID_VALUE', `${label} is reported as 0, which is impossible for this field; leave it empty if unknown.`);
      return;
    }
    if (spec.unit === 'percent' && value > 100) {
      push(fieldPath, 'error', 'INVALID_VALUE', `${label} exceeds 100 percent.`);
      return;
    }
    if (value !== 0 && (value < spec.plausibleMin || value > spec.plausibleMax)) {
      push(fieldPath, 'warning', 'UNREASONABLE_VALUE', `${label} ${value.toLocaleString('en-US')} is outside the documented plausible range ${spec.plausibleMin.toLocaleString('en-US')} to ${spec.plausibleMax.toLocaleString('en-US')}. ${spec.rationale}`);
    }
  };

  // Scalar sections with the conditional-required secondary group.
  const scalar: readonly { category: ReportingCategory; section: Record<string, number | string | boolean | null>; specs: readonly FieldSpec[] }[] = [
    { category: 'culinary-use', section: sections.culinaryUse as unknown as Record<string, number | null>, specs: SCALAR_FIELDS['culinary-use'] },
    { category: 'source-peak-demand', section: sections.sourcePeakDemand as unknown as Record<string, number | string | null>, specs: SCALAR_FIELDS['source-peak-demand'] },
    { category: 'secondary-use', section: sections.secondaryUse as unknown as Record<string, number | string | boolean | null>, specs: SCALAR_FIELDS['secondary-use'] },
  ];
  for (const { category, section, specs } of scalar) {
    const anyValue = specs.some((spec) => section[spec.key as string] !== null && section[spec.key as string] !== '');
    for (const spec of specs) {
      const value = section[spec.key as string];
      const fieldPath = `${category === 'culinary-use' ? 'culinaryUse' : category === 'source-peak-demand' ? 'sourcePeakDemand' : 'secondaryUse'}.${String(spec.key)}`;
      if (spec.unit === 'date') {
        const raw = typeof value === 'string' ? value : null;
        if (raw === null || raw === '') {
          if (spec.required) push(fieldPath, 'error', 'MISSING_REQUIRED', `${labelOf(category)} — ${spec.label} is missing: a required value was not entered.`);
        } else if (!dateInPeriod(raw, period)) {
          push(fieldPath, 'error', 'PERIOD_MISMATCH', `${labelOf(category)} — ${spec.label} ${raw} lies outside the reported period (${period.basis} ${period.year}).`);
        }
        continue;
      }
      if (value === null || value === '' || typeof value === 'boolean') {
        if (spec.required && (category !== 'secondary-use' || anyValue)) {
          const extra = category === 'secondary-use' ? ': secondary use is partially reported, so every secondary field is required' : ': a required value was not entered';
          push(fieldPath, 'error', 'MISSING_REQUIRED', `${labelOf(category)} — ${spec.label} (${spec.unit}) is missing${extra}.`);
        }
        continue;
      }
      checkNumeric(category, spec, value as number, fieldPath);
    }
  }

  // Inventories.
  if (sections.sourceInventory.length === 0) {
    push('sourceInventory', 'error', 'MISSING_REQUIRED', `${labelOf('source-inventory')} — at least one source is required: the source inventory is empty.`);
  }
  sections.sourceInventory.forEach((entry, index) => {
    if (entry.sourceId.trim().length === 0) push(`sourceInventory[${index}].sourceId`, 'error', 'MISSING_REQUIRED', `${labelOf('source-inventory')} entry ${index + 1} — Source identifier is missing: each source needs a stable identifier.`);
    if (entry.name.trim().length === 0) push(`sourceInventory[${index}].name`, 'error', 'MISSING_REQUIRED', `${labelOf('source-inventory')} entry ${index + 1} — Source name is missing: human-readable source identification for reviewers.`);
    if (entry.annualWithdrawalGallons === null) {
      push(`sourceInventory[${index}].annualWithdrawalGallons`, 'error', 'MISSING_REQUIRED', `${labelOf('source-inventory')} entry ${index + 1} — Annual withdrawal (gallons) is missing: a required value was not entered.`);
    } else {
      checkNumeric('source-inventory', { key: 'annualWithdrawalGallons', label: 'Annual withdrawal', unit: 'gallons', required: true, plausibleMin: 1_000, plausibleMax: 100_000_000_000, rationale: 'A producing source yields at least a thousand gallons a year.' }, entry.annualWithdrawalGallons, `sourceInventory[${index}].annualWithdrawalGallons`);
    }
  });
  sections.purchaseInventory.forEach((entry, index) => {
    if (entry.sellerName.trim().length === 0) push(`purchaseInventory[${index}].sellerName`, 'error', 'MISSING_REQUIRED', `${labelOf('purchase-inventory')} entry ${index + 1} — Seller is missing.`);
    if (entry.annualPurchasedGallons === null) push(`purchaseInventory[${index}].annualPurchasedGallons`, 'error', 'MISSING_REQUIRED', `${labelOf('purchase-inventory')} entry ${index + 1} — Annual purchased volume (gallons) is missing.`);
  });
  sections.wholesaleInventory.forEach((entry, index) => {
    if (entry.buyerName.trim().length === 0) push(`wholesaleInventory[${index}].buyerName`, 'error', 'MISSING_REQUIRED', `${labelOf('wholesale-inventory')} entry ${index + 1} — Buyer is missing.`);
    if (entry.annualSoldGallons === null) push(`wholesaleInventory[${index}].annualSoldGallons`, 'error', 'MISSING_REQUIRED', `${labelOf('wholesale-inventory')} entry ${index + 1} — Annual sold volume (gallons) is missing.`);
  });
  sections.returnInventory.forEach((entry, index) => {
    if (entry.receivingBody.trim().length === 0) push(`returnInventory[${index}].receivingBody`, 'error', 'MISSING_REQUIRED', `${labelOf('return-inventory')} entry ${index + 1} — Receiving body is missing: a return must say where the water goes.`);
    if (entry.annualReturnedGallons === null) push(`returnInventory[${index}].annualReturnedGallons`, 'error', 'MISSING_REQUIRED', `${labelOf('return-inventory')} entry ${index + 1} — Annual returned volume (gallons) is missing.`);
  });

  return { issues, summary: buildErrorSummary(issues) };
}

/** Accessible summary mirror: headline + numbered plain-text lines (category-ordered). */
export function buildErrorSummary(issues: readonly ValidationIssue[]): ValidationSummary {
  const rank = new Map(CATEGORY_ORDER.map((category, index) => [category, index] as const));
  const ordered = [...issues].sort((a, b) => (rank.get(a.category)! - rank.get(b.category)!) || (a.fieldPath < b.fieldPath ? -1 : a.fieldPath > b.fieldPath ? 1 : 0));
  const errorCount = ordered.filter((issue) => issue.severity === 'error').length;
  const warningCount = ordered.length - errorCount;
  const headline =
    errorCount > 0
      ? `${errorCount} error${errorCount === 1 ? '' : 's'} and ${warningCount} warning${warningCount === 1 ? '' : 's'} must be resolved or acknowledged before submission.`
      : warningCount > 0
        ? `No blocking errors. ${warningCount} warning${warningCount === 1 ? '' : 's'} noted and recorded with the submitted report.`
        : 'No validation issues.';
  return { errorCount, warningCount, headline, lines: ordered.map((issue, index) => `${index + 1}. ${issue.severity === 'error' ? 'Error' : 'Warning'} — ${issue.message}`) };
}

/** Issues for one field path (inline text next to the input; also used with aria-describedby). */
export function issuesForField(snapshot: ValidationSnapshot, fieldPath: string): readonly ValidationIssue[] {
  return snapshot.issues.filter((issue) => issue.fieldPath === fieldPath);
}

// ---------------------------------------------------------------------------
// Import (FR-056 mirror)
// ---------------------------------------------------------------------------

export const UNIT_FACTORS: Readonly<Record<string, number>> = { gal: 1, 'ac-ft': 325_851.428571, MG: 1_000_000 };
export type ImportUnit = 'gal' | 'ac-ft' | 'MG' | 'persons' | 'connections' | 'gpm' | 'acres' | 'percent' | 'date';

const FIELD_UNIT: Readonly<Record<string, ImportUnit | 'text'>> = {
  'culinaryUse.populationServed': 'persons',
  'culinaryUse.activeConnections': 'connections',
  'culinaryUse.annualCulinaryVolumeGallons': 'gal',
  'culinaryUse.meteredPercent': 'percent',
  'sourceInventory[].annualWithdrawalGallons': 'gal',
  'purchaseInventory[].annualPurchasedGallons': 'gal',
  'wholesaleInventory[].annualSoldGallons': 'gal',
  'returnInventory[].annualReturnedGallons': 'gal',
  'sourcePeakDemand.peakDayDate': 'date',
  'sourcePeakDemand.peakDayVolumeGallons': 'gal',
  'sourcePeakDemand.peakHourDemandGpm': 'gpm',
  'secondaryUse.irrigatedAcres': 'acres',
  'secondaryUse.secondaryConnections': 'connections',
  'secondaryUse.annualSecondaryVolumeGallons': 'gal',
};

const CATEGORY_ALIASES: Readonly<Record<string, ReportingCategory>> = {
  'culinary-use': 'culinary-use',
  'source-inventory': 'source-inventory',
  'purchase-inventory': 'purchase-inventory',
  'wholesale-inventory': 'wholesale-inventory',
  'return-inventory': 'return-inventory',
  'source-peak-demand': 'source-peak-demand',
  'secondary-use': 'secondary-use',
};

const SECTION_KEY: Readonly<Record<ReportingCategory, string>> = {
  'culinary-use': 'culinaryUse',
  'source-inventory': 'sourceInventory',
  'purchase-inventory': 'purchaseInventory',
  'wholesale-inventory': 'wholesaleInventory',
  'return-inventory': 'returnInventory',
  'source-peak-demand': 'sourcePeakDemand',
  'secondary-use': 'secondaryUse',
};

const NON_VOLUME = new Set(['persons', 'connections', 'gpm', 'acres', 'percent', 'date']);

/** One parsed file row: category, field, optional entry key, raw value + unit (documented file vocabulary). */
export interface ImportRow {
  readonly rowIndex: number;
  readonly category: string;
  readonly field: string;
  readonly entryKey: string | null;
  readonly rawValue: string;
  readonly rawUnit: ImportUnit;
}

/** Parse the documented CSV line format: category,field,entryKey,value,unit (blank entryKey allowed). */
export function parseImportText(text: string): { rows: readonly ImportRow[]; parseErrors: readonly string[] } {
  const rows: ImportRow[] = [];
  const parseErrors: string[] = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'));
  lines.forEach((line, index) => {
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 5) {
      parseErrors.push(`Line ${index + 1}: expected "category,field,entryKey,value,unit" (5 columns), found ${parts.length}.`);
      return;
    }
    const [category, field, entryKey, rawValue, rawUnit] = parts as [string, string, string, string, ImportUnit];
    rows.push({ rowIndex: index + 1, category, field, entryKey: entryKey.length > 0 ? entryKey : null, rawValue, rawUnit });
  });
  return { rows, parseErrors };
}

export interface ImportMapping {
  readonly rowIndex: number;
  readonly category: ReportingCategory;
  readonly field: string;
  readonly entryKey: string | null;
  readonly rawValue: string;
  readonly rawUnit: ImportUnit;
  readonly mappedValue: number | string;
  readonly mappedUnit: string;
  readonly note: string;
}

export interface ImportInvalid {
  readonly rowIndex: number;
  readonly reason: string;
}

export interface ImportPreviewModel {
  readonly mappings: readonly ImportMapping[];
  readonly invalidRows: readonly ImportInvalid[];
  readonly applicable: boolean;
  readonly periodNote: string;
}

/** Preview mirror: mapped units/periods + plain-text invalid-row reasons. Pure. */
export function previewImportRows(rows: readonly ImportRow[], period: ReportPeriod, filePeriodBasis: PeriodBasis, filePeriodYear: number): ImportPreviewModel {
  const mappings: ImportMapping[] = [];
  const invalidRows: ImportInvalid[] = [];
  const periodMatches = filePeriodBasis === period.basis && filePeriodYear === period.year;
  for (const row of rows) {
    const category = CATEGORY_ALIASES[row.category];
    if (!category) {
      invalidRows.push({ rowIndex: row.rowIndex, reason: `Row ${row.rowIndex}: unknown reporting category "${row.category}".` });
      continue;
    }
    const sectionKey = SECTION_KEY[category];
    const canonical = FIELD_UNIT[`${sectionKey}.${row.field}`] ?? FIELD_UNIT[`${sectionKey}[].${row.field}`];
    if (canonical === undefined) {
      invalidRows.push({ rowIndex: row.rowIndex, reason: `Row ${row.rowIndex}: unknown field "${row.field}" for category ${CATEGORY_LABELS[category]}.` });
      continue;
    }
    if (canonical === 'text') {
      mappings.push({ ...row, category, mappedValue: row.rawValue, mappedUnit: 'text', note: `Text value for ${row.field}.` });
      continue;
    }
    if (canonical === 'date') {
      mappings.push({ ...row, category, mappedValue: row.rawValue, mappedUnit: 'YYYY-MM-DD', note: 'Calendar date; validated against the reported period.' });
      continue;
    }
    if (!(row.rawUnit in UNIT_FACTORS) && !NON_VOLUME.has(row.rawUnit)) {
      invalidRows.push({ rowIndex: row.rowIndex, reason: `Row ${row.rowIndex}: unknown unit "${row.rawUnit}".` });
      continue;
    }
    const numeric = Number(row.rawValue.replace(/,/g, ''));
    if (!Number.isFinite(numeric)) {
      invalidRows.push({ rowIndex: row.rowIndex, reason: `Row ${row.rowIndex}: value "${row.rawValue}" is not a number.` });
      continue;
    }
    if (row.rawUnit in UNIT_FACTORS) {
      if (canonical !== 'gal') {
        invalidRows.push({ rowIndex: row.rowIndex, reason: `Row ${row.rowIndex}: unit "${row.rawUnit}" is a volume, but the field measures ${canonical}.` });
        continue;
      }
      const factor = UNIT_FACTORS[row.rawUnit]!;
      const mapped = Math.round(numeric * factor * 1e6) / 1e6;
      mappings.push({ ...row, category, mappedValue: mapped, mappedUnit: 'gallons', note: `Converted ${numeric.toLocaleString('en-US')} ${row.rawUnit} x ${factor} = ${mapped.toLocaleString('en-US')} gallons.` });
      continue;
    }
    if (row.rawUnit !== canonical) {
      invalidRows.push({ rowIndex: row.rowIndex, reason: `Row ${row.rowIndex}: unit "${row.rawUnit}" does not match the field unit (${canonical}); there is no conversion between different quantities.` });
      continue;
    }
    mappings.push({ ...row, category, mappedValue: numeric, mappedUnit: String(canonical), note: `Direct mapping: ${canonical} is the canonical unit.` });
  }
  return {
    mappings,
    invalidRows,
    applicable: periodMatches && invalidRows.length === 0,
    periodNote: periodMatches
      ? `File period ${filePeriodBasis} ${filePeriodYear} maps 1:1 to the draft period (${period.basis} ${period.year}).`
      : `File period ${filePeriodBasis} ${filePeriodYear} does NOT match the draft period (${period.basis} ${period.year}); the import is not applicable.`,
  };
}

/**
 * Apply mirror: writes the mapped values into a DERIVED sections object
 * (upsert by entry key). The caller tracks importIds for idempotent retry:
 * a retried import id applies nothing.
 */
export function applyPreviewToSections(sections: ReportSections, mappings: readonly ImportMapping[]): ReportSections {
  const next: ReportSections = {
    culinaryUse: { ...sections.culinaryUse },
    sourceInventory: sections.sourceInventory.map((entry) => ({ ...entry })),
    purchaseInventory: sections.purchaseInventory.map((entry) => ({ ...entry })),
    wholesaleInventory: sections.wholesaleInventory.map((entry) => ({ ...entry })),
    returnInventory: sections.returnInventory.map((entry) => ({ ...entry })),
    sourcePeakDemand: { ...sections.sourcePeakDemand },
    secondaryUse: { ...sections.secondaryUse },
  };
  for (const mapping of mappings) {
    const sectionKey = SECTION_KEY[mapping.category];
    switch (sectionKey) {
      case 'culinaryUse':
        (next.culinaryUse as unknown as Record<string, number | string>)[mapping.field] = mapping.mappedValue as number;
        break;
      case 'sourcePeakDemand':
        (next.sourcePeakDemand as unknown as Record<string, number | string>)[mapping.field] = mapping.mappedValue as number;
        break;
      case 'secondaryUse':
        (next.secondaryUse as unknown as Record<string, number | string>)[mapping.field] = mapping.mappedValue as number;
        break;
      case 'sourceInventory': {
        const key = mapping.entryKey ?? String(mapping.mappedValue);
        const existing = next.sourceInventory.find((entry) => entry.sourceId === key);
        if (existing) (existing as unknown as Record<string, number | string>)[mapping.field] = mapping.mappedValue as number;
        else next.sourceInventory.push({ sourceId: key, sourceType: 'other', name: '', pumpCapacityGpm: null, annualWithdrawalGallons: null, metered: false, ...( { [mapping.field]: mapping.mappedValue } as object ) } as SourceInventoryEntry);
        break;
      }
      case 'purchaseInventory': {
        const key = mapping.entryKey ?? String(mapping.mappedValue);
        const existing = next.purchaseInventory.find((entry) => entry.sellerName === key);
        if (existing) (existing as unknown as Record<string, number | string>)[mapping.field] = mapping.mappedValue as number;
        else next.purchaseInventory.push({ sellerName: key, annualPurchasedGallons: null, ...({ [mapping.field]: mapping.mappedValue } as object) } as PurchaseInventoryEntry);
        break;
      }
      case 'wholesaleInventory': {
        const key = mapping.entryKey ?? String(mapping.mappedValue);
        const existing = next.wholesaleInventory.find((entry) => entry.buyerName === key);
        if (existing) (existing as unknown as Record<string, number | string>)[mapping.field] = mapping.mappedValue as number;
        else next.wholesaleInventory.push({ buyerName: key, annualSoldGallons: null, ...({ [mapping.field]: mapping.mappedValue } as object) } as WholesaleInventoryEntry);
        break;
      }
      case 'returnInventory': {
        const key = mapping.entryKey ?? String(mapping.mappedValue);
        const existing = next.returnInventory.find((entry) => entry.receivingBody === key);
        if (existing) (existing as unknown as Record<string, number | string>)[mapping.field] = mapping.mappedValue as number;
        else next.returnInventory.push({ returnType: 'other', receivingBody: key, annualReturnedGallons: null, ...({ [mapping.field]: mapping.mappedValue } as object) } as ReturnInventoryEntry);
        break;
      }
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Historical discharge (FR-053 mirror; golden-pinned)
// ---------------------------------------------------------------------------

export interface HistoricalDischargeYear {
  readonly year: number;
  readonly volumeAcreFeet: number | null;
}

export interface HistoricalDischargeRow {
  readonly streamId: string;
  readonly stationId: string;
  readonly unitId: string;
  readonly years: readonly HistoricalDischargeYear[];
}

export const HISTORICAL_YEARS: readonly number[] = [2024, 2025, 2026];
const CUBIC_FEET_PER_ACRE_FOOT = 43_560;

function streamById(streamId: string): DatastreamRecord | null {
  for (const station of stations) {
    const stream = (station.datastreams ?? []).find((candidate) => candidate.id === streamId);
    if (stream) return stream;
  }
  return null;
}

/**
 * Rectangle-right mirror for the fixture's owner streams: a reading governs
 * [observedAt, next observedAt) capped at its cadence; volume accrues only
 * inside the requested local year window (UTC instants compared directly -
 * the fixture data sits well inside the year). Null when nothing is covered
 * (unavailable, never zero). Pinned by test to the API golden 26978/121.
 */
export function historicalDischargeOf(orgId: string): readonly HistoricalDischargeRow[] {
  const scope = SUPPLIER_ORGS.find((candidate) => candidate.orgId === orgId);
  if (!scope) return [];
  const rows: HistoricalDischargeRow[] = [];
  for (const station of scope.stations) {
    for (const stream of station.dischargeStreams) {
      const meta = streamById(stream.streamId);
      const readings = observations
        .filter((observation: ObservationRecord) => observation.streamId === stream.streamId && observation.value !== null)
        .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
      rows.push({
        streamId: stream.streamId,
        stationId: station.stationId,
        unitId: stream.unitId,
        years: HISTORICAL_YEARS.map((year) => {
          const start = Date.parse(`${year}-01-01T07:00:00Z`); // local midnight America/Denver (MST)
          const end = Date.parse(`${year + 1}-01-01T07:00:00Z`);
          let cubicFeet = 0;
          let covered = false;
          readings.forEach((reading, index) => {
            if (reading.value === null) return;
            const from = Date.parse(reading.observedAt);
            const nextAt = index + 1 < readings.length ? Date.parse(readings[index + 1]!.observedAt) : Number.POSITIVE_INFINITY;
            const cadenceMs = (meta?.cadenceMinutes ?? 60) * 60_000;
            const until = Math.min(from + cadenceMs, nextAt);
            const overlapStart = Math.max(from, start);
            const overlapEnd = Math.min(until, end);
            if (overlapEnd > overlapStart) {
              covered = true;
              cubicFeet += reading.value * ((overlapEnd - overlapStart) / 1000);
            }
          });
          return { year, volumeAcreFeet: covered ? cubicFeet / CUBIC_FEET_PER_ACRE_FOOT : null };
        }),
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Demo submission freeze (FR-057 mirror) + PDF manifest text model
// ---------------------------------------------------------------------------

/** Deterministic FNV-style digest (two 32-bit lanes) - demo stand-in for the server's sha256. */
export function demoDigest(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = (h1 ^ code) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + code + i) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(2);
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

export interface DemoSubmittedReport {
  readonly submissionId: string;
  readonly version: number;
  readonly submitter: string;
  readonly submittedAt: string;
  readonly period: ReportPeriod;
  readonly orgId: string;
  readonly systemId: string;
  readonly content: ReportSections;
  readonly acknowledgedWarnings: readonly ValidationIssue[];
  readonly contentHash: string;
  readonly pdfManifest: DemoPdfManifest;
  readonly status: 'submitted' | 'resubmission-approved';
}

export interface DemoPdfManifest {
  readonly submittedContentHash: string;
  readonly blocks: readonly { readonly kind: 'title' | 'meta' | 'value' | 'note' | 'hash-footer'; readonly text: string }[];
}

function fmt(value: number | null): string {
  return value === null ? '' : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Freeze a submission (mirror of report.ts submit + pdf.ts manifest): the
 * content hash covers org/system/period/version/submitter/submittedAt/
 * content/warnings (canonical serialization; demo digest), and the manifest
 * embeds that hash verbatim - the PDF-matches-submission proof.
 */
export function freezeDemoSubmission(input: {
  readonly sections: ReportSections;
  readonly validation: ValidationSnapshot;
  readonly actorId: string;
  readonly orgId: string;
  readonly systemId: string;
  readonly period: ReportPeriod;
  readonly version: number;
  readonly now?: string;
  readonly submissionId?: string;
}): DemoSubmittedReport {
  const now = input.now ?? FIXTURE_CLOCK;
  const acknowledgedWarnings = input.validation.issues.filter((issue) => issue.severity === 'warning');
  const preimage = {
    orgId: input.orgId,
    systemId: input.systemId,
    period: { basis: input.period.basis, year: input.period.year },
    version: input.version,
    submitter: input.actorId,
    submittedAt: now,
    content: input.sections,
    acknowledgedWarnings,
  };
  const contentHash = demoDigest(canonicalize(preimage));
  const warned = new Set(acknowledgedWarnings.map((issue) => issue.fieldPath));
  const status = (path: string): 'reported' | 'missing' | 'warning' => (warned.has(path) ? 'warning' : 'reported');
  const valueBlock = (label: string, value: number | string | null, unit: string, path: string) =>
    ({ kind: 'value' as const, text: `${label}: ${value === null || value === '' ? 'missing' : `${typeof value === 'number' ? fmt(value) : value} ${unit}`.trim()} [${value === null || value === '' ? 'missing' : status(path)}]` });
  const blocks: DemoPdfManifest['blocks'] = [
    { kind: 'title', text: `Utah annual water use report — version ${input.version}` },
    { kind: 'meta', text: `Reporting period: ${input.period.basis} ${input.period.year} (${PERIOD_RULES[input.period.basis]})` },
    { kind: 'meta', text: `Submitted version: ${input.version}` },
    { kind: 'meta', text: `Submitter: ${input.actorId}` },
    { kind: 'meta', text: `Submitted at: ${now}` },
    { kind: 'meta', text: `Content hash: ${contentHash}` },
    { kind: 'meta', text: `Culinary use` },
    valueBlock('Population served', input.sections.culinaryUse.populationServed, 'persons', 'culinaryUse.populationServed'),
    valueBlock('Active connections', input.sections.culinaryUse.activeConnections, 'connections', 'culinaryUse.activeConnections'),
    valueBlock('Annual culinary volume', input.sections.culinaryUse.annualCulinaryVolumeGallons, 'gallons', 'culinaryUse.annualCulinaryVolumeGallons'),
    valueBlock('Metered share', input.sections.culinaryUse.meteredPercent, 'percent', 'culinaryUse.meteredPercent'),
    ...input.sections.sourceInventory.map((entry, index) => ({ kind: 'value' as const, text: `Source ${index + 1} ${entry.name || entry.sourceId}: withdrawal ${fmt(entry.annualWithdrawalGallons)} gallons [${entry.annualWithdrawalGallons === null ? 'missing' : status(`sourceInventory[${index}].annualWithdrawalGallons`)}]` })),
    ...input.sections.purchaseInventory.map((entry, index) => ({ kind: 'value' as const, text: `Purchase from ${entry.sellerName}: ${fmt(entry.annualPurchasedGallons)} gallons [${entry.annualPurchasedGallons === null ? 'missing' : status(`purchaseInventory[${index}].annualPurchasedGallons`)}]` })),
    ...input.sections.wholesaleInventory.map((entry, index) => ({ kind: 'value' as const, text: `Wholesale to ${entry.buyerName}: ${fmt(entry.annualSoldGallons)} gallons [${entry.annualSoldGallons === null ? 'missing' : status(`wholesaleInventory[${index}].annualSoldGallons`)}]` })),
    ...input.sections.returnInventory.map((entry, index) => ({ kind: 'value' as const, text: `Return (${entry.returnType}) to ${entry.receivingBody}: ${fmt(entry.annualReturnedGallons)} gallons [${entry.annualReturnedGallons === null ? 'missing' : status(`returnInventory[${index}].annualReturnedGallons`)}]` })),
    valueBlock('Peak day', input.sections.sourcePeakDemand.peakDayVolumeGallons !== null && input.sections.sourcePeakDemand.peakDayDate ? input.sections.sourcePeakDemand.peakDayDate : null, '', 'sourcePeakDemand.peakDayDate'),
    valueBlock('Peak-day volume', input.sections.sourcePeakDemand.peakDayVolumeGallons, 'gallons', 'sourcePeakDemand.peakDayVolumeGallons'),
    valueBlock('Peak-hour demand', input.sections.sourcePeakDemand.peakHourDemandGpm, 'gpm', 'sourcePeakDemand.peakHourDemandGpm'),
    valueBlock('Irrigated acres', input.sections.secondaryUse.irrigatedAcres, 'acres', 'secondaryUse.irrigatedAcres'),
    valueBlock('Secondary connections', input.sections.secondaryUse.secondaryConnections, 'connections', 'secondaryUse.secondaryConnections'),
    valueBlock('Annual secondary volume', input.sections.secondaryUse.annualSecondaryVolumeGallons, 'gallons', 'secondaryUse.annualSecondaryVolumeGallons'),
    { kind: 'note', text: `Acknowledged warnings recorded with this submission: ${acknowledgedWarnings.length}.` },
    { kind: 'note', text: 'Boundary proposals and their approval are separate records from this report (FR-054).' },
    { kind: 'hash-footer', text: `This PDF matches submitted version ${input.version}. Content hash: ${contentHash}` },
  ];
  return {
    submissionId: input.submissionId ?? `sub-${contentHash.slice(0, 12)}`,
    version: input.version,
    submitter: input.actorId,
    submittedAt: now,
    period: input.period,
    orgId: input.orgId,
    systemId: input.systemId,
    content: input.sections,
    acknowledgedWarnings,
    contentHash,
    pdfManifest: { submittedContentHash: contentHash, blocks },
    status: 'submitted',
  };
}

/**
 * Resubmission state-machine helper (mirror of report.ts): a new version is
 * creatable ONLY after the latest submission is resubmission-approved.
 */
export function canOpenNewVersion(latestStatus: DemoSubmittedReport['status'] | null): boolean {
  return latestStatus === null || latestStatus === 'resubmission-approved';
}

// ---------------------------------------------------------------------------
// Boundaries (FR-054 mirror)
// ---------------------------------------------------------------------------

export interface BoundarySectionModel {
  readonly sectionId: string;
  readonly title: string;
  readonly summary: string;
}

export const BOUNDARY_SECTIONS_V1: readonly BoundarySectionModel[] = [
  { sectionId: 'service-area', title: 'Service area extent', summary: 'Fixture default: the current recorded service-area extent of the supplier system.' },
  { sectionId: 'sources', title: 'Source points', summary: 'Fixture default: sources of record attributed to this supplier within the system.' },
  { sectionId: 'delivery-points', title: 'Delivery and exchange points', summary: 'Fixture default: wholesale delivery and exchange points of record.' },
];

export interface BoundaryProposalModel {
  readonly proposalId: string;
  readonly status: 'proposed' | 'review' | 'approved' | 'rejected';
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly sections: readonly { readonly sectionId: string; readonly title: string; readonly currentSummary: string; readonly proposedSummary: string; readonly changeReason: string }[];
  readonly comments: readonly { readonly commentId: string; readonly sectionId: string; readonly authorId: string; readonly authorRole: 'supplier' | 'reviewer'; readonly text: string; readonly at: string }[];
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly resultingBoundaryVersion: number | null;
}

/** Create a proposal model (never mutates the approved boundary sections). */
export function makeBoundaryProposal(input: {
  readonly actorId: string;
  readonly now?: string;
  readonly sequence: number;
  readonly approved: readonly BoundarySectionModel[];
  readonly changes: readonly { readonly sectionId: string; readonly proposedSummary: string; readonly changeReason: string }[];
}): BoundaryProposalModel | { readonly error: string } {
  const now = input.now ?? FIXTURE_CLOCK;
  if (input.changes.length === 0) return { error: 'A boundary proposal must contain at least one section change.' };
  const sections = [];
  for (const change of input.changes) {
    const approved = input.approved.find((section) => section.sectionId === change.sectionId);
    if (!approved) return { error: `Section "${change.sectionId}" is not part of the approved boundary.` };
    if (change.proposedSummary.trim().length === 0 || change.changeReason.trim().length === 0) {
      return { error: `Section "${change.sectionId}" needs both a proposed summary and a change reason.` };
    }
    sections.push({ sectionId: approved.sectionId, title: approved.title, currentSummary: approved.summary, proposedSummary: change.proposedSummary, changeReason: change.changeReason });
  }
  return {
    proposalId: `proposal-${input.sequence}`,
    status: 'proposed',
    proposedBy: input.actorId,
    proposedAt: now,
    sections,
    comments: [],
    decidedBy: null,
    decidedAt: null,
    resultingBoundaryVersion: null,
  };
}

/** Derive approved boundary version N+1 from a proposal (the distinct approval transition, reviewer-only by contract). */
export function approveBoundaryMirror(proposal: BoundaryProposalModel, approved: readonly BoundarySectionModel[], reviewerId: string, now: string): { readonly proposal: BoundaryProposalModel; readonly boundary: readonly BoundarySectionModel[] } {
  const next = approved.map((section) => {
    const change = proposal.sections.find((candidate) => candidate.sectionId === section.sectionId);
    return change ? { ...section, summary: change.proposedSummary } : section;
  });
  return {
    proposal: { ...proposal, status: 'approved', decidedBy: reviewerId, decidedAt: now, resultingBoundaryVersion: 2 },
    boundary: next,
  };
}
