/**
 * Typed shapes of the agreed fixture world (fixtures/contracts, seed
 * `utah-water-fixture-v1`, contract version 0.1.0). WD-006 consumes these
 * files verbatim; the synthetic data in this shell comes from nowhere else.
 *
 * AXIS-ORDER CONTRACT: station geometry is EPSG:4326 recorded as latitude
 * then longitude. Every GeoJSON conversion must swap to [longitude, latitude]
 * (see map/shell/layers.ts); fixture latitudes (~41-42 N) differ from
 * longitudes (~-111 to -113 W) by roughly 70 degrees, so a swap is
 * detectable by assertion, not by eye.
 */

export type StationStatus = 'active' | 'inactive' | 'proposed';
export type StationVisibility = 'public' | 'restricted' | 'internal';
export type TelemetryKind = 'telemetered' | 'manual' | 'unknown';
export type ProcessingLevel = 'raw' | 'provisional' | 'reviewed' | 'best-available';
export type ValueType = 'observed' | 'estimated';

export interface DeviceDeployment {
  deviceId: string;
  serial: string;
  model: string;
  installedAt: string;
  removedAt: string | null;
}

export interface RatingCurvePeriod {
  id: string;
  validFrom: string;
  validTo: string | null;
  method: string;
}

export interface DatastreamRecord {
  id: string;
  stationId: string;
  observedPropertyId: string;
  unitId: string;
  methodTypeId: string;
  cadenceMinutes: number;
  validRangeMin: number;
  validRangeMax: number;
  visibility: StationVisibility;
  timeZone: string;
  deviceDeployments: DeviceDeployment[];
  ratingCurvePeriods: RatingCurvePeriod[];
}

/**
 * Restricted operational block. Never part of any public projection: gate
 * codes and wiring notes must not reach public, water-user or researcher
 * views even when the station row itself is public (FR-049).
 */
export interface InternalBlock {
  gateCode: string;
  wiringNotes: string;
  visibility: 'internal';
}

export interface StationRecord {
  id: string;
  displayName: string;
  externalId: string;
  systemId: string;
  subgroupIds: string[];
  providerId: string;
  siteTypeId: string;
  status: StationStatus;
  visibility: StationVisibility;
  telemetry: TelemetryKind;
  waterSourceTypeId: string;
  stateCode: string;
  latitude: number;
  longitude: number;
  elevationFt: number;
  version: number;
  ownerOrganizationId?: string;
  internal?: InternalBlock;
  datastreams: DatastreamRecord[];
}

export interface ObservationRecord {
  id: string;
  logicalKey: string;
  streamId: string;
  observedAt: string;
  sourceOffset: string;
  /** null is reported-but-empty (a NaN frame): missing is preserved as missing, never zero. */
  value: number | null;
  unitId: string;
  valueType: ValueType;
  processingLevel: 'raw';
  sourceEventId: string;
  receivedAt: string;
  methodTypeId?: string;
  sourceId: string;
  note?: string;
}

export interface RevisionRecord {
  id: string;
  targetObservationId: string;
  baseRevisionId: string | null;
  type: 'correction' | 'level-advance';
  value: number;
  unitId: string;
  processingLevel: 'provisional' | 'reviewed' | 'best-available';
  qualifierIds: string[];
  reason: string;
  actorId: string;
  recordedAt: string;
  idempotencyKey?: string;
}

export interface GapRecord {
  id: string;
  streamId: string;
  start: string;
  end: string;
  reason: string;
  declaredAt: string;
  expectedCadenceMinutes: number;
  missingCount: number;
  note?: string;
}

export interface SystemRecord {
  id: string;
  name: string;
  kind: 'system';
  stateCodes: string[];
  description: string;
}

export interface SubgroupRecord {
  id: string;
  systemId: string;
  name: string;
  kind: 'subgroup';
  description: string;
}

export interface ProviderRecord {
  id: string;
  name: string;
  kind: 'telemetry' | 'manual';
}

export interface OrganizationRecord {
  id: string;
  name: string;
  kind: 'water-owner';
  description: string;
}

export interface UserRecord {
  id: string;
  displayName: string;
  roles: string[];
  active: boolean;
  assignedSystemId?: string;
  description?: string;
}

export interface EntitlementRecord {
  id: string;
  principalId: string;
  role: string;
  capabilities: string[];
  scopeType: 'statewide' | 'system' | 'dataset';
  scopeId: string | null;
  effectiveAt: string;
  expiresAt: string | null;
  status: 'active' | 'expired';
  delegation: { effectiveAt: string; expiresAt: string; delegatedBy: string } | null;
  grantedBy: string;
  grantVersion: number;
}

export interface VocabularyRecord {
  seed: string;
  version: string;
  observedProperties: { id: string; name: string; dimension: string; canonicalUnitId: string; description: string }[];
  units: { id: string; name: string; dimension: string; description?: string }[];
  qualifiers: { id: string; name: string; description: string }[];
  processingLevels: { id: string; name: string; description: string }[];
}

export interface SeedManifest {
  seed: string;
  fixed_clock: string;
  time_zone: string;
  generated_on: string;
  contract_version: string;
  purpose: string;
  files: Record<string, string>;
  counts: Record<string, number>;
  scenario_index: Record<string, string>;
}
