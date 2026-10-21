/**
 * WD-008 series feature entry point: chart, comparison and export panels as
 * mountable modules. The shell (apps/web/src/shell/**) is outside this
 * task's write scope; the integration point is exactly one pending line,
 * documented in README.md.
 */
import ComparisonPanel from './ComparisonPanel';
import ExportPanel from './ExportPanel';
import SeriesChart from './SeriesChart';
import SeriesPanels from './SeriesPanels';

export { SeriesChart, ComparisonPanel, ExportPanel, SeriesPanels };
export type { SeriesChartProps, SeriesChartData } from './SeriesChart';
export type { ComparisonPanelProps, ComparisonSelection } from './ComparisonPanel';
export type { ExportPanelProps, ExportSelection } from './ExportPanel';

export {
  SERIES_LEGEND,
  coverageAnnotation,
  dailySummaries,
  localDayKeys,
  pointAriaLabel,
  selectAtBasis,
} from './derivation';
export type {
  DaySummary,
  GapBandLike,
  LegendItem,
  ProcessingBasis,
  RevisionLike,
  SelectedPoint,
  SeriesPointLike,
  StreamLike,
} from './derivation';

/** Registration descriptor for the shell's feature registry (site detail, series tab). */
export const seriesMount = {
  id: 'series',
  label: 'Series and exports',
  mountPath: 'site-detail/series',
  component: SeriesPanels,
} as const;
