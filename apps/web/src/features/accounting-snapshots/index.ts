/**
 * WD-025-R2 accounting-snapshots feature entry point: the mountable panel
 * plus its pure snapshot model. The shell (apps/web/src/shell/**) is outside
 * this task's write scope; the integration point is exactly one pending
 * line, documented in README.md.
 */
import AccountingSnapshotsPanel from './AccountingSnapshotsPanel';

export { AccountingSnapshotsPanel };
export default AccountingSnapshotsPanel;
export type { AccountingSnapshotsPanelProps } from './AccountingSnapshotsPanel';

export {
  ADVISORY_LABEL_MODEL,
  DEMO_SUPPLEMENTAL_INPUTS,
  FINALIZE_AUTHORITY_RULE_MIRROR,
  DemoFinalizeLedger,
  PERIOD_KINDS,
  PROGRAM_TIME_ZONE,
  addMonths,
  buildDecisionSnapshotDemo,
  buildSupplementalRowsModel,
  canonicalize,
  demoDigest,
  finalizeAuthorities,
  formatHash,
  formatVolume,
  instantFromLocal,
  linkageText,
  localBoundaryLabel,
  localMidnightMs,
  periodKeyModel,
  resolvePeriodModel,
  statusBadge,
  supplementalRowTextModel,
  supersededBanner,
  supersessionChain,
} from './snapshotModel';
export type {
  DecisionEvidenceModel,
  DemoFinalizeRequest,
  EvidenceRow,
  FinalizeAuthorityModel,
  FinalizedChainView,
  FinalizeDemoOutcome,
  FinalizedLike,
  PeriodKind,
  PeriodKindOption,
  PeriodSpecModel,
  ProcessingBasisModel,
  ResolveResult,
  ResolvedPeriodModel,
  SupplementalInputModel,
  SupplementalRowModel,
} from './snapshotModel';

/** Registration descriptor for the shell's feature registry (operations workspace). */
export const accountingSnapshotsMount = {
  id: 'accounting-snapshots',
  label: 'Accounting snapshots',
  mountPath: 'operations/accounting-snapshots',
  component: AccountingSnapshotsPanel,
} as const;
