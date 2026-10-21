/**
 * Category validation for WD-017 (FR-055): "Forms cover culinary use,
 * source, purchase, wholesale and returns inventories, source peak demand
 * and secondary use; missing required values and unreasonable values
 * produce field-level text messages and an error summary in addition to
 * color."
 *
 * DESIGN CONTRACTS:
 *
 * - DOCUMENTED, OWNER-RATIFIABLE RULES: every required-field decision and
 *   every "unreasonable value" bound below is data in FIELD_RULES /
 *   ENTRY_RULES with its rationale, explicitly PENDING Water Use Program
 *   owner ratification (PRD open decision: "Supplier reporting ownership,
 *   boundary approval and reviewer state machine"). Nothing here is a
 *   hidden constant.
 * - TEXT FIRST: every finding is a plain-text message naming the category,
 *   the field and its unit; the summary object renders numbered lines for
 *   screen readers. Color is a presentation concern of the web feature.
 * - ZERO IS NOT MISSING (NFR-007): null = missing (error when required);
 *   0 is a reported value. Counts where zero is impossible carry
 *   zeroIsError; volumes where zero is legitimate (e.g. returns) accept it.
 * - SEVERITY: MISSING_REQUIRED / INVALID_VALUE / PERIOD_MISMATCH are errors
 *   and block submit; UNREASONABLE_VALUE is a warning the supplier may
 *   acknowledge (the range heuristics flag implausible data without
 *   refusing honest outliers).
 * - PURE: no clock reads (dates are parsed, not observed), deterministic
 *   iteration in CATEGORY_ORDER.
 */
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type ReportPeriod,
  type ReportingCategory,
  type ReportSections,
  type SourceType,
  type ValidationIssue,
  type ValidationSnapshot,
  type ValidationSummary,
} from './types.ts';

// ---------------------------------------------------------------------------
// Documented rule tables
// ---------------------------------------------------------------------------

export type FieldQuantity =
  | 'persons' // population served
  | 'connections' // connection counts
  | 'gallons' // annual volumes (canonical unit)
  | 'gpm' // pump / peak-hour rates
  | 'acres' // irrigated acreage
  | 'percent' // 0-100 share
  | 'date'; // local calendar day YYYY-MM-DD

export interface FieldRule {
  /** Dotted path into ReportSections. */
  readonly fieldPath: string;
  readonly label: string;
  readonly quantity: FieldQuantity;
  readonly required: boolean;
  /** Required integer counting fields. */
  readonly integer?: boolean;
  /** Zero is impossible for this field (reported 0 -> error, never silently missing). */
  readonly zeroIsError?: boolean;
  /**
   * Documented plausible range [min, max]. Values inside are silent; values
   * outside are UNREASONABLE_VALUE warnings (owner-ratifiable heuristics,
   * not physical laws).
   */
  readonly plausibleMin: number;
  readonly plausibleMax: number;
  /** When true the field is required as soon as any field in the group has a value. */
  readonly requiredWithGroup?: string;
  readonly rationale: string;
}

export const PENDING_OWNER_NOTE =
  'Required-field and plausible-range heuristics are documented defaults pending Water Use Program owner ratification (FR-055; PRD open decision on supplier reporting ownership).';

/** Scalar-field rules; entry (inventory) rules live in ENTRY_RULES. */
export const FIELD_RULES: readonly FieldRule[] = [
  {
    fieldPath: 'culinaryUse.populationServed',
    label: 'Population served',
    quantity: 'persons',
    required: true,
    integer: true,
    zeroIsError: true,
    plausibleMin: 10,
    plausibleMax: 5_000_000,
    rationale: 'Utah community water systems range from small HOAs to ~1M-resident wholesalers; >5M persons exceeds any Utah system.',
  },
  {
    fieldPath: 'culinaryUse.activeConnections',
    label: 'Active culinary connections',
    quantity: 'connections',
    required: true,
    integer: true,
    zeroIsError: true,
    plausibleMin: 5,
    plausibleMax: 500_000,
    rationale: 'A reporting culinary system serves at least a handful of connections; >500k exceeds statewide counts.',
  },
  {
    fieldPath: 'culinaryUse.annualCulinaryVolumeGallons',
    label: 'Annual culinary volume',
    quantity: 'gallons',
    required: true,
    plausibleMin: 100_000,
    plausibleMax: 100_000_000_000,
    rationale: 'Between a small system month (~0.1 MG) and the largest statewide annual diversions (~100 000 MG).',
  },
  {
    fieldPath: 'culinaryUse.meteredPercent',
    label: 'Metered share',
    quantity: 'percent',
    required: false,
    plausibleMin: 0,
    plausibleMax: 100,
    rationale: 'A share of volume; values outside 0-100 are malformed for the review UI as well.',
  },
  {
    fieldPath: 'sourcePeakDemand.peakDayDate',
    label: 'Peak day',
    quantity: 'date',
    required: true,
    plausibleMin: 0,
    plausibleMax: 0,
    rationale: 'The observed peak day must be a real local calendar day inside the reported period.',
  },
  {
    fieldPath: 'sourcePeakDemand.peakDayVolumeGallons',
    label: 'Peak-day volume',
    quantity: 'gallons',
    required: true,
    plausibleMin: 10_000,
    plausibleMax: 10_000_000_000,
    rationale: 'A peak day is at least a tanker-load and below the largest statewide daily diversions (~10 000 MG).',
  },
  {
    fieldPath: 'sourcePeakDemand.peakHourDemandGpm',
    label: 'Peak-hour demand',
    quantity: 'gpm',
    required: false,
    zeroIsError: true,
    plausibleMin: 1,
    plausibleMax: 50_000,
    rationale: 'Largest Utah culinary well pumps are ~5 000 gpm; plant peaks stay below 50 000 gpm.',
  },
  {
    fieldPath: 'secondaryUse.irrigatedAcres',
    label: 'Irrigated acres',
    quantity: 'acres',
    required: false,
    requiredWithGroup: 'secondary-use',
    plausibleMin: 0.5,
    plausibleMax: 100_000,
    rationale: 'Secondary systems range from a school lawn to ~100k-acre canal service areas.',
  },
  {
    fieldPath: 'secondaryUse.secondaryConnections',
    label: 'Secondary connections',
    quantity: 'connections',
    required: false,
    requiredWithGroup: 'secondary-use',
    integer: true,
    plausibleMin: 0,
    plausibleMax: 100_000,
    rationale: 'Zero connections is a legitimate answer (no secondary system).',
  },
  {
    fieldPath: 'secondaryUse.annualSecondaryVolumeGallons',
    label: 'Annual secondary volume',
    quantity: 'gallons',
    required: false,
    requiredWithGroup: 'secondary-use',
    plausibleMin: 10_000,
    plausibleMax: 100_000_000_000,
    rationale: 'Same volume envelope as culinary use; secondary is typically the larger outdoor share.',
  },
];

export interface EntryFieldRule extends FieldRule {
  /** Inventory-entry field name after the entry key (e.g. 'annualWithdrawalGallons'). */
  readonly entryField: string;
}

/** Rules for inventory entry fields (source/purchase/wholesale/returns). */
export const ENTRY_RULES: readonly EntryFieldRule[] = [
  {
    fieldPath: 'sourceInventory[].sourceId',
    entryField: 'sourceId',
    label: 'Source identifier',
    quantity: 'persons', // text rule: presence only; quantity unused for text
    required: true,
    plausibleMin: 0,
    plausibleMax: 0,
    rationale: 'Each source needs a stable identifier so repeats and imports key on it.',
  },
  {
    fieldPath: 'sourceInventory[].name',
    entryField: 'name',
    label: 'Source name',
    quantity: 'persons',
    required: true,
    plausibleMin: 0,
    plausibleMax: 0,
    rationale: 'Human-readable source identification for reviewers.',
  },
  {
    fieldPath: 'sourceInventory[].pumpCapacityGpm',
    entryField: 'pumpCapacityGpm',
    label: 'Pump capacity',
    quantity: 'gpm',
    required: false,
    zeroIsError: true,
    plausibleMin: 1,
    plausibleMax: 10_000,
    rationale: 'Typical culinary source pumps run 10-2 000 gpm; 10 000 gpm covers the largest turbines.',
  },
  {
    fieldPath: 'sourceInventory[].annualWithdrawalGallons',
    entryField: 'annualWithdrawalGallons',
    label: 'Annual withdrawal',
    quantity: 'gallons',
    required: true,
    plausibleMin: 1_000,
    plausibleMax: 100_000_000_000,
    rationale: 'A producing source yields at least a thousand gallons a year; the ceiling matches the culinary volume envelope.',
  },
  {
    fieldPath: 'purchaseInventory[].sellerName',
    entryField: 'sellerName',
    label: 'Seller',
    quantity: 'persons',
    required: true,
    plausibleMin: 0,
    plausibleMax: 0,
    rationale: 'Purchases are identified by the selling wholesale supplier.',
  },
  {
    fieldPath: 'purchaseInventory[].annualPurchasedGallons',
    entryField: 'annualPurchasedGallons',
    label: 'Annual purchased volume',
    quantity: 'gallons',
    required: true,
    plausibleMin: 1_000,
    plausibleMax: 100_000_000_000,
    rationale: 'Same annual volume envelope as withdrawals.',
  },
  {
    fieldPath: 'wholesaleInventory[].buyerName',
    entryField: 'buyerName',
    label: 'Buyer',
    quantity: 'persons',
    required: true,
    plausibleMin: 0,
    plausibleMax: 0,
    rationale: 'Wholesale sales are identified by the buying supplier.',
  },
  {
    fieldPath: 'wholesaleInventory[].annualSoldGallons',
    entryField: 'annualSoldGallons',
    label: 'Annual sold volume',
    quantity: 'gallons',
    required: true,
    plausibleMin: 1_000,
    plausibleMax: 100_000_000_000,
    rationale: 'Same annual volume envelope as withdrawals.',
  },
  {
    fieldPath: 'returnInventory[].receivingBody',
    entryField: 'receivingBody',
    label: 'Receiving body',
    quantity: 'persons',
    required: true,
    plausibleMin: 0,
    plausibleMax: 0,
    rationale: 'A return must say where the water goes; annualReturnedGallons of 0 itself is legitimate.',
  },
  {
    fieldPath: 'returnInventory[].annualReturnedGallons',
    entryField: 'annualReturnedGallons',
    label: 'Annual returned volume',
    quantity: 'gallons',
    required: true,
    plausibleMin: 0,
    plausibleMax: 100_000_000_000,
    rationale: 'Zero returns is an honest answer; the ceiling matches the culinary volume envelope.',
  },
];

/** Text-keyed entry fields (presence checks only; quantity is unused). */
const TEXT_ENTRY_FIELDS = new Set(['sourceId', 'name', 'sellerName', 'buyerName', 'receivingBody']);

export const SOURCE_TYPES: readonly SourceType[] = ['well', 'spring', 'surface-water', 'other'];

// ---------------------------------------------------------------------------
// Period membership (documented date rules mirrored from WD-025
// PERIOD_BASIS_RULES; pure local-calendar arithmetic, no zone data needed
// because membership is decided on the civil date)
// ---------------------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** True when the YYYY-MM-DD civil date lies inside the period (membership only; no UTC instants involved). */
export function dateInPeriod(date: string, period: ReportPeriod): boolean {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  switch (period.basis) {
    case 'calendar-year':
      return year === period.year;
    case 'water-year':
      // Oct (year-1) .. Sep (year): USGS water year ending Sep 30 of period.year.
      return year === period.year ? month <= 9 : year === period.year - 1 && month >= 10;
    case 'irrigation-season':
      // Apr 1 .. Oct 31 of the period year.
      return year === period.year && month >= 4 && month <= 10;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Field checks
// ---------------------------------------------------------------------------

function messageOf(rule: FieldRule, unit: string, verb: string, detail: string): string {
  return `${CATEGORY_LABELS[categoryOfField(rule.fieldPath)]} — ${rule.label} (${unit}) ${verb}: ${detail}`;
}

function categoryOfField(fieldPath: string): ReportingCategory {
  const head = fieldPath.split('.')[0] ?? fieldPath;
  const mapped: Record<string, ReportingCategory> = {
    culinaryUse: 'culinary-use',
    sourceInventory: 'source-inventory',
    purchaseInventory: 'purchase-inventory',
    wholesaleInventory: 'wholesale-inventory',
    returnInventory: 'return-inventory',
    sourcePeakDemand: 'source-peak-demand',
    secondaryUse: 'secondary-use',
  };
  return mapped[head] ?? 'culinary-use';
}

function checkNumeric(
  category: ReportingCategory,
  rule: FieldRule,
  value: number,
  issues: ValidationIssue[],
  index: number | null,
): void {
  const unit = rule.quantity;
  const path = index === null ? rule.fieldPath : rule.fieldPath.replace('[]', `[${index}]`);
  const label = `${CATEGORY_LABELS[category]} — ${rule.label} (${unit})`;
  if (rule.integer !== true && !Number.isFinite(value)) {
    issues.push({ fieldPath: path, category, severity: 'error', code: 'INVALID_VALUE', message: `${label} is not a finite number.` });
    return;
  }
  if (rule.integer === true && !Number.isInteger(value)) {
    issues.push({ fieldPath: path, category, severity: 'error', code: 'INVALID_VALUE', message: `${label} must be a whole number.` });
    return;
  }
  if (value < 0) {
    issues.push({ fieldPath: path, category, severity: 'error', code: 'INVALID_VALUE', message: `${label} is negative; report 0 rather than a negative amount.` });
    return;
  }
  if (rule.zeroIsError === true && value === 0) {
    issues.push({ fieldPath: path, category, severity: 'error', code: 'INVALID_VALUE', message: `${label} is reported as 0, which is impossible for this field; leave it empty if unknown.` });
    return;
  }
  if (rule.quantity === 'percent' && value > 100) {
    issues.push({ fieldPath: path, category, severity: 'error', code: 'INVALID_VALUE', message: `${label} exceeds 100 percent.` });
    return;
  }
  if (value !== 0 && (value < rule.plausibleMin || value > rule.plausibleMax)) {
    issues.push({
      fieldPath: path,
      category,
      severity: 'warning',
      code: 'UNREASONABLE_VALUE',
      message: `${label} ${value.toLocaleString('en-US')} is outside the documented plausible range ${rule.plausibleMin.toLocaleString('en-US')} to ${rule.plausibleMax.toLocaleString('en-US')}. ${rule.rationale}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Section validators
// ---------------------------------------------------------------------------

function validateCulinaryUse(sections: ReportSections, issues: ValidationIssue[]): void {
  const section = sections.culinaryUse;
  for (const rule of FIELD_RULES.filter((r) => r.fieldPath.startsWith('culinaryUse.'))) {
    const value = section[rule.fieldPath.split('.')[1] as keyof typeof section] as number | null;
    if (value === null) {
      if (rule.required) {
        issues.push({
          fieldPath: rule.fieldPath,
          category: 'culinary-use',
          severity: 'error',
          code: 'MISSING_REQUIRED',
          message: `${messageOf(rule, rule.quantity, 'is missing', 'a required value was not entered')}.`,
        });
      }
      continue;
    }
    checkNumeric('culinary-use', rule, value, issues, null);
  }
}

function validatePeakDemand(sections: ReportSections, period: ReportPeriod, issues: ValidationIssue[]): void {
  const section = sections.sourcePeakDemand;
  const dateRule = FIELD_RULES.find((r) => r.fieldPath === 'sourcePeakDemand.peakDayDate')!;
  if (section.peakDayDate === null) {
    issues.push({
      fieldPath: dateRule.fieldPath,
      category: 'source-peak-demand',
      severity: 'error',
      code: 'MISSING_REQUIRED',
      message: `${CATEGORY_LABELS['source-peak-demand']} — ${dateRule.label} is missing: a required value was not entered.`,
    });
  } else if (!DATE_PATTERN.test(section.peakDayDate)) {
    issues.push({
      fieldPath: dateRule.fieldPath,
      category: 'source-peak-demand',
      severity: 'error',
      code: 'INVALID_VALUE',
      message: `${CATEGORY_LABELS['source-peak-demand']} — ${dateRule.label} must be a calendar date formatted YYYY-MM-DD.`,
    });
  } else if (!dateInPeriod(section.peakDayDate, period)) {
    issues.push({
      fieldPath: dateRule.fieldPath,
      category: 'source-peak-demand',
      severity: 'error',
      code: 'PERIOD_MISMATCH',
      message: `${CATEGORY_LABELS['source-peak-demand']} — ${dateRule.label} ${section.peakDayDate} lies outside the reported period (${period.basis} ${period.year}).`,
    });
  }
  for (const rule of FIELD_RULES.filter((r) => r.fieldPath.startsWith('sourcePeakDemand.') && r.quantity !== 'date')) {
    const value = section[rule.fieldPath.split('.')[1] as keyof typeof section] as number | null;
    if (value === null) {
      if (rule.required) {
        issues.push({
          fieldPath: rule.fieldPath,
          category: 'source-peak-demand',
          severity: 'error',
          code: 'MISSING_REQUIRED',
          message: `${CATEGORY_LABELS['source-peak-demand']} — ${rule.label} (${rule.quantity}) is missing: a required value was not entered.`,
        });
      }
      continue;
    }
    checkNumeric('source-peak-demand', rule, value, issues, null);
  }
}

function validateSecondaryUse(sections: ReportSections, issues: ValidationIssue[]): void {
  const section = sections.secondaryUse;
  const rules = FIELD_RULES.filter((r) => r.fieldPath.startsWith('secondaryUse.'));
  const anyValue = rules.some((rule) => (section[rule.fieldPath.split('.')[1] as keyof typeof section] as number | null | boolean) !== null);
  for (const rule of rules) {
    const raw = section[rule.fieldPath.split('.')[1] as keyof typeof section] as number | null;
    if (raw === null) {
      // Conditional required: once ANY secondary value is reported, the
      // group's fields are all required (documented default).
      if (rule.requiredWithGroup && anyValue) {
        issues.push({
          fieldPath: rule.fieldPath,
          category: 'secondary-use',
          severity: 'error',
          code: 'MISSING_REQUIRED',
          message: `${CATEGORY_LABELS['secondary-use']} — ${rule.label} (${rule.quantity}) is missing: secondary use is partially reported, so every secondary field is required.`,
        });
      }
      continue;
    }
    checkNumeric('secondary-use', rule, raw, issues, null);
  }
}

interface EntrySectionMeta {
  readonly category: ReportingCategory;
  readonly sectionPath: string;
}

const ENTRY_SECTIONS: readonly EntrySectionMeta[] = [
  { category: 'source-inventory', sectionPath: 'sourceInventory' },
  { category: 'purchase-inventory', sectionPath: 'purchaseInventory' },
  { category: 'wholesale-inventory', sectionPath: 'wholesaleInventory' },
  { category: 'return-inventory', sectionPath: 'returnInventory' },
];

function validateInventories(sections: ReportSections, issues: ValidationIssue[]): void {
  const sectionMap: Record<string, readonly Record<string, unknown>[]> = {
    sourceInventory: sections.sourceInventory as unknown as readonly Record<string, unknown>[],
    purchaseInventory: sections.purchaseInventory as unknown as readonly Record<string, unknown>[],
    wholesaleInventory: sections.wholesaleInventory as unknown as readonly Record<string, unknown>[],
    returnInventory: sections.returnInventory as unknown as readonly Record<string, unknown>[],
  };
  for (const meta of ENTRY_SECTIONS) {
    const entries = sectionMap[meta.sectionPath];
    const rules = ENTRY_RULES.filter((rule) => rule.fieldPath.startsWith(`${meta.sectionPath}[].`));
    if (meta.category === 'source-inventory' && entries.length === 0) {
      // A reporting supplier has at least one source (documented default).
      issues.push({
        fieldPath: 'sourceInventory',
        category: meta.category,
        severity: 'error',
        code: 'MISSING_REQUIRED',
        message: `${CATEGORY_LABELS[meta.category]} — at least one source is required: the source inventory is empty.`,
      });
    }
    entries.forEach((entry, index) => {
      for (const rule of rules) {
        const value = entry[rule.entryField];
        if (TEXT_ENTRY_FIELDS.has(rule.entryField)) {
          if (typeof value !== 'string' || value.trim().length === 0) {
            issues.push({
              fieldPath: rule.fieldPath.replace('[]', `[${index}]`),
              category: meta.category,
              severity: 'error',
              code: 'MISSING_REQUIRED',
              message: `${CATEGORY_LABELS[meta.category]} entry ${index + 1} — ${rule.label} is missing: ${rule.rationale}`,
            });
          }
          continue;
        }
        if (value === null || value === undefined) {
          if (rule.required) {
            issues.push({
              fieldPath: rule.fieldPath.replace('[]', `[${index}]`),
              category: meta.category,
              severity: 'error',
              code: 'MISSING_REQUIRED',
              message: `${CATEGORY_LABELS[meta.category]} entry ${index + 1} — ${rule.label} (${rule.quantity}) is missing: a required value was not entered.`,
            });
          }
          continue;
        }
        if (typeof value === 'number') checkNumeric(meta.category, rule, value, issues, index);
      }
      if (meta.category === 'source-inventory' && !SOURCE_TYPES.includes(entry['sourceType'] as SourceType)) {
        issues.push({
          fieldPath: `sourceInventory[${index}].sourceType`,
          category: meta.category,
          severity: 'error',
          code: 'INVALID_VALUE',
          message: `${CATEGORY_LABELS[meta.category]} entry ${index + 1} — source type must be one of ${SOURCE_TYPES.join(', ')}.`,
        });
      }
      if (meta.category === 'return-inventory' && !['treated-effluent', 'raw-water', 'other'].includes(String(entry['returnType']))) {
        issues.push({
          fieldPath: `returnInventory[${index}].returnType`,
          category: meta.category,
          severity: 'error',
          code: 'INVALID_VALUE',
          message: `${CATEGORY_LABELS[meta.category]} entry ${index + 1} — return type must be treated-effluent, raw-water or other.`,
        });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Summary and entry point
// ---------------------------------------------------------------------------

const CATEGORY_RANK = new Map(CATEGORY_ORDER.map((category, index) => [category, index] as const));

/** Accessible summary: counts, headline and numbered plain-text lines (never color alone). */
export function buildErrorSummary(issues: readonly ValidationIssue[]): ValidationSummary {
  const ordered = [...issues].sort(
    (a, b) => (CATEGORY_RANK.get(a.category)! - CATEGORY_RANK.get(b.category)!) || (a.fieldPath < b.fieldPath ? -1 : a.fieldPath > b.fieldPath ? 1 : 0),
  );
  const errorCount = ordered.filter((issue) => issue.severity === 'error').length;
  const warningCount = ordered.length - errorCount;
  const headline =
    errorCount > 0
      ? `${errorCount} error${errorCount === 1 ? '' : 's'} and ${warningCount} warning${warningCount === 1 ? '' : 's'} must be resolved or acknowledged before submission.`
      : warningCount > 0
        ? `No blocking errors. ${warningCount} warning${warningCount === 1 ? '' : 's'} noted and recorded with the submitted report.`
        : 'No validation issues.';
  const lines = ordered.map((issue, index) => `${index + 1}. ${issue.severity === 'error' ? 'Error' : 'Warning'} — ${issue.message}`);
  return { errorCount, warningCount, headline, lines };
}

/** Validate every category section of one draft (FR-055 matrix). Pure. */
export function validateSections(sections: ReportSections, period: ReportPeriod): ValidationSnapshot {
  const issues: ValidationIssue[] = [];
  validateCulinaryUse(sections, issues);
  validateInventories(sections, issues);
  validatePeakDemand(sections, period, issues);
  validateSecondaryUse(sections, issues);
  const summary = buildErrorSummary(issues);
  return { issues, summary };
}

export function hasBlockingErrors(snapshot: ValidationSnapshot): boolean {
  return snapshot.summary.errorCount > 0;
}
