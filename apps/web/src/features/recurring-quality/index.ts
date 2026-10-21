/**
 * WD-013-R2 recurring-quality feature entry point.
 *
 * Exports the mountable FR-043 panel plus its mount descriptor so a later
 * slice can register it without importing internals. This task does not
 * touch apps/web/src/shell/App.tsx: the shell wiring is exactly one pending
 * line, documented in README.md.
 */
import RecurringQualityPanel from './RecurringQualityPanel';

export { RecurringQualityPanel };
export default RecurringQualityPanel;
export type { RecurringQualityData, RecurringQualityPanelProps } from './RecurringQualityPanel';

export {
  buildTrendRows,
  chartSeries,
  DEMO_NOW,
  filterTrendRows,
  formatRate,
  formatTimeSince,
  KIND_LABELS,
  KIND_MARKERS,
  periodIndexOf,
  REVIEWED_DEMO_INCIDENTS,
  sortTrendRows,
  TREND_KINDS,
} from './trendsModel';
export type {
  BoundaryAnnotationView,
  BuildRowsOptions,
  ChartSeriesPoint,
  IncidentView,
  TrendFilter,
  TrendKind,
  TrendRow,
  TrendSort,
  TrendSortBy,
  TrendSortDirection,
} from './trendsModel';

/** Registration descriptor for the shell's feature registry (quality tab). */
export const recurringQualityMount = {
  id: 'recurring-quality',
  label: 'Recurring quality',
  mountPath: 'quality/recurring',
  component: RecurringQualityPanel,
} as const;
