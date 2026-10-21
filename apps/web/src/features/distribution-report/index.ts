/**
 * WD-025 distribution-report feature entry point: the request panel (with the
 * generated report rendered inline) and the standalone report view, plus the
 * pure report model. The shell (apps/web/src/shell/**) is outside this task's
 * write scope; the integration point is exactly one pending line, documented
 * in README.md.
 */
import ReportRequestPanel from './ReportRequestPanel';
import ReportView from './ReportView';

export { ReportRequestPanel, ReportView };
export {
  DEFAULT_INCLUDE,
  NOTE_LEGEND,
  PERIOD_BASES,
  actorReportScope,
  buildFixtureReport,
  canonicalize,
  demoDigest,
  formatMean,
  formatPct,
  formatVolume,
  hashFooter,
  noteSymbols,
  noteText,
  periodWindow,
  supersededBanner,
  systemSiteOptions,
  volumeChartPoints,
} from './reportModel';
export type {
  ActorReportScope,
  DailyNoteCode,
  DailyRowLike,
  DemoReportRequest,
  PeriodBasis,
  PeriodBasisOption,
  PeriodWindowModel,
  ProcessingBasis,
  ReportLike,
  SiteOption,
  StreamSectionLike,
} from './reportModel';
export type { ReportRequestPanelProps } from './ReportRequestPanel';
export type { ReportViewProps } from './ReportView';

/** Registration descriptor for the shell's feature registry (operations workspace). */
export const distributionReportMount = {
  id: 'distribution-report',
  label: 'Distribution reports',
  mountPath: 'operations/distribution-reports',
  component: ReportRequestPanel,
} as const;
