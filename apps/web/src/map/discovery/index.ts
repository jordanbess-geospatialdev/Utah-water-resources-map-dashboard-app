/**
 * WD-007 bounded map retrieval entry point (FR-001; "NeoServer and map
 * transport"). See discoverySource.ts for the invariants and README.md for
 * the pending shell wiring line.
 */
export {
  buildDiscoveryLayers,
  createDiscoverySource,
  DEFAULT_DISCOVERY_LIMIT,
  discoveryFeatures,
  DISCOVERY_LAYER_IDS,
  DISCOVERY_PROPERTY_WHITELIST,
  gatewayFeaturesQuery,
  MAX_DISCOVERY_LIMIT,
  publicDiscoveryCatalog,
  publicDiscoveryStations,
  TRANSPORT_NOTES,
  validateDiscoveryBbox,
} from './discoverySource';
export type {
  DiscoveryBbox,
  DiscoveryFeatureProperty,
  DiscoveryFeatureRequest,
  DiscoveryFeatureSet,
  DiscoverySource,
} from './discoverySource';
