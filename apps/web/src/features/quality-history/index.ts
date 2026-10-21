/**
 * WD-011 quality-history feature entry point.
 *
 * Exports the mountable FR-042 panel plus its mount descriptor so a later
 * slice can register it without importing internals. WD-011 does not touch
 * persona_ui's apps/web/src/shell/App.tsx: the shell wiring is exactly one
 * pending line, documented in README.md.
 */
import QualityHistoryPanel from './QualityHistoryPanel';

export { QualityHistoryPanel };
export default QualityHistoryPanel;
export type { QualityHistoryPanelProps, QualityHistoryData, QualityHistoryInterval } from './QualityHistoryPanel';

export {
  formatAuditValue,
  formatChange,
  intervalQualityHistory,
  pointAuditTargets,
  pointQualityHistory,
} from './derivation';
export type {
  AuditObservation,
  ChainRevision,
  ChainRevisionType,
  ChainProcessingLevel,
  IntervalSelector,
  IntervalQualityHistory,
  NameTables,
  PointAuditTarget,
  PointFlagReason,
  PointQualityHistory,
  QualityHistoryModel,
  QualityHistoryRow,
  QualityProvenance,
  RetainedOriginal,
  RevisionStatus,
  StatusMarker,
} from './derivation';

/** Registration descriptor for the shell's feature registry (site detail, quality tab). */
export const qualityHistoryMount = {
  id: 'quality-history',
  label: 'Quality history',
  mountPath: 'site-detail/quality',
  component: QualityHistoryPanel,
} as const;
