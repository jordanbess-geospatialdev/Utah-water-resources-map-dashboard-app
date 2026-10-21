/**
 * WD-007 public discovery feature entry point (FR-001, FR-002, FR-004,
 * FR-008, FR-035 vocabulary groundwork, FR-060).
 *
 * Exports the mountable panels plus the pure filter/share-url modules so a
 * later slice can register them without importing internals. WD-007 does not
 * touch persona_ui's apps/web/src/shell/App.tsx: the shell wiring is exactly
 * one pending block, documented in README.md.
 */
import DataDictionaryPanel from './DataDictionaryPanel';
import DiscoveryFiltersPanel from './DiscoveryFiltersPanel';
import SitePopup from './SitePopup';

export { DataDictionaryPanel, DiscoveryFiltersPanel, SitePopup };
export type { DataDictionaryPanelProps, UnknownValueEntry } from './DataDictionaryPanel';
export type { DiscoveryFiltersPanelProps } from './DiscoveryFiltersPanel';
export type { SitePopupModel, SitePopupProps } from './SitePopup';
export { sitePopupModel } from './SitePopup';

export {
  appliedFilterChips,
  canonicalizeFilters,
  classifyFilterValue,
  DISCOVERY_DIMENSIONS,
  DISCOVERY_DIMENSION_KEYS,
  dimensionByKey,
  EMPTY_FILTERS,
  filterPublicStations,
  FILTER_VALUE_PATTERN,
  hasActiveFilters,
  MAX_VALUES_PER_DIMENSION,
  parseFilters,
  processingLevelsForStation,
  publicDiscoveryStations,
  RESTRICTED_OBJECT_IDS,
  serializeFilters,
  stationDimensionIsUnset,
  stationDimensionValues,
  stationMatchesFilters,
  timeStepIdForCadence,
  UNKNOWN_SENTINEL,
  withoutFilterValue,
} from './filters';
export type {
  CanonicalFilterResult,
  DiscoveryFilterSet,
  FacetValue,
  FilterDimension,
  FilterDimensionKey,
  FilterRedaction,
  FilterRedactionReason,
  FilterValueVerdict,
  ProcessingLevelValue,
  SiteStatusFilterValue,
  TelemetryFilterValue,
} from './filters';

export {
  buildShareUrl,
  canonicalizeExtent,
  defaultShareExtent,
  defaultShareState,
  isShareableSiteId,
  isValidExtent,
  MAX_SHARE_URL_LENGTH,
  parseShareUrl,
  resolveShareUrl,
  roundTripShareUrl,
  SHARE_URL_VERSION,
} from './shareUrl';
export type {
  BuiltShareUrl,
  DiscoveryShareState,
  MapExtent,
  ParsedShareUrl,
  ResolvedShare,
  ShareNotice,
  ShareNoticeKind,
} from './shareUrl';

import DiscoveryFiltersPanelComponent from './DiscoveryFiltersPanel';
import SitePopupComponent from './SitePopup';
import DataDictionaryPanelComponent from './DataDictionaryPanel';

/** Registration descriptor for the shell's feature registry (public discovery surface). */
export const discoveryMount = {
  id: 'discovery',
  label: 'Public discovery',
  mountPath: 'discovery',
  components: {
    filtersPanel: DiscoveryFiltersPanelComponent,
    sitePopup: SitePopupComponent,
    dataDictionary: DataDictionaryPanelComponent,
  },
} as const;
