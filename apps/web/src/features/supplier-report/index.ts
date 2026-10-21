/**
 * WD-017 supplier-report feature entry point: the supplier report panel
 * (assigned system view, category sections with inline text validation and
 * an accessible summary, import preview, submit flow with the frozen
 * submitted view, boundary proposals) plus the pure report model. The shell
 * (apps/web/src/shell/**) is outside this task's write scope; the
 * integration point is exactly one pending line, documented in README.md.
 */
import SupplierReportPanel from './SupplierReportPanel';

export { SupplierReportPanel };
export {
  BOUNDARY_SECTIONS_V1,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  DEMO_ACTORS,
  EMPTY_SECTIONS,
  HISTORICAL_YEARS,
  PERIOD_RULES,
  SOURCE_TYPES,
  RETURN_TYPES,
  UNIT_FACTORS,
  approveBoundaryMirror,
  applyPreviewToSections,
  buildErrorSummary,
  canonicalize,
  canOpenNewVersion,
  dateInPeriod,
  demoActor,
  demoDigest,
  freezeDemoSubmission,
  historicalDischargeOf,
  issuesForField,
  makeBoundaryProposal,
  parseImportText,
  previewImportRows,
  scopeOfActor,
  validateSections,
} from './reportModel';
export type {
  BoundaryProposalModel,
  BoundarySectionModel,
  CulinaryUseSection,
  DemoPdfManifest,
  DemoSubmittedReport,
  DemoSupplierActor,
  FieldSpec,
  HistoricalDischargeRow,
  ImportInvalid,
  ImportMapping,
  ImportPreviewModel,
  ImportRow,
  ImportUnit,
  PeriodBasis,
  PurchaseInventoryEntry,
  ReportPeriod,
  ReportSections,
  ReturnType,
  SecondaryUseSection,
  SourceInventoryEntry,
  SourcePeakDemandSection,
  SourceType,
  SupplierOrgScope,
  ValidationIssue,
  ValidationSnapshot,
  ValidationSummary,
  WholesaleInventoryEntry,
} from './reportModel';
export type { SupplierReportPanelProps } from './SupplierReportPanel';

/** Registration descriptor for the shell's feature registry (water-user workspace). */
export const supplierReportMount = {
  id: 'supplier-report',
  label: 'Supplier annual report',
  mountPath: 'water-user/supplier-report',
  component: SupplierReportPanel,
} as const;
