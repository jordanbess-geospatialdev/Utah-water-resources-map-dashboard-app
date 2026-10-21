/**
 * WD-011-R2 rating-curves feature entry point.
 *
 * Exports the mountable FR-045 panel plus its mount descriptor so a later
 * slice can register it without importing internals. This task does not
 * touch the shell's App.tsx: the wiring is exactly one pending line,
 * documented in README.md.
 */
import RatingCurvePanel from './RatingCurvePanel';

export { RatingCurvePanel };
export default RatingCurvePanel;
export type { RatingCurveData, RatingCurvePanelProps } from './RatingCurvePanel';

export {
  approvalLabel,
  buildTimeline,
  convertStage,
  curveFormula,
  formatInterval,
  formulaText,
  intervalCovers,
  lineageString,
  shiftSegmentsText,
  stateBadge,
} from './curveModel';
export type {
  ApprovalState,
  ConversionResult,
  CurveVersionView,
  ShiftSegmentView,
  ShiftVersionView,
  VersionRow,
} from './curveModel';

/** Registration descriptor for the shell's feature registry (site detail, rating-curves tab). */
export const ratingCurvesMount = {
  id: 'rating-curves',
  label: 'Rating curves',
  mountPath: 'site-detail/rating-curves',
  component: RatingCurvePanel,
} as const;
