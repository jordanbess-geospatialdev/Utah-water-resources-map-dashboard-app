/**
 * WD-018 public overview feature entry point (FR-058, FR-059, FR-060,
 * FR-061, FR-062).
 *
 * Exports the mountable overview surface plus the pure derivation module so a
 * later slice can register them without importing internals. WD-018 does not
 * touch the shell (apps/web/src/shell/App.tsx): the wiring is exactly one
 * pending block, documented in README.md.
 */
import PublicOverview from './PublicOverview';
import SummaryCharts from './SummaryCharts';

export { PublicOverview, SummaryCharts };
export type { PublicOverviewProps } from './PublicOverview';
export type { SummaryChartsProps } from './SummaryCharts';

export {
  accountingCategory,
  areaTotals,
  classificationBars,
  classifyRecord,
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  CATEGORY_SHAPES,
  CLASSIFICATION_COLORS,
  CLASSIFICATION_SHAPES,
  CUBIC_FEET_PER_ACRE_FOOT,
  DEFAULT_FRESHNESS_HOURS,
  defaultTotalsWindow,
  INDICATOR_METHOD,
  localMidnightInstant,
  measuredVersusEstimatedIndicator,
  NO_DOUBLE_COUNT_POLICY,
  normalizeRecords,
  plainLanguageSummary,
  PROGRAM_TIME_ZONE,
  reviewedDataCoverageIndicator,
  summaryIndicators,
  statewideOverview,
  telemetryCoverageIndicator,
  volumeSeries,
  windowDenial,
} from './derivation';
export type {
  AccountingCategory,
  AreaTotals,
  ClassificationBar,
  ClassificationBucket,
  Indicator,
  IndicatorExclusion,
  IndicatorId,
  IndicatorPeriod,
  IndicatorScope,
  MeasureKind,
  MeasuredVersusEstimatedIndicator,
  NormalizedRecord,
  ObservationInput,
  ProcessingBasis,
  RevisionInput,
  SourceClassification,
  StationInput,
  StreamInput,
  SummaryIndicatorSet,
  SummaryWorldInput,
  SystemIndicatorEntry,
  TotalsRequestInput,
  VolumeSeriesModel,
} from './derivation';

/** Registration descriptor for the shell's feature registry (public overview surface). */
export const overviewMount = {
  id: 'overview',
  label: 'Public overview',
  mountPath: 'overview',
  component: PublicOverview,
} as const;
