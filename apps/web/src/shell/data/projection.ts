/**
 * Public-projection helper for the WD-006 demo shell.
 *
 * !!! DEMO-ONLY ENFORCEMENT !!!
 *
 * Everything in this module is a browser-side demonstration of what the
 * server-side policy will project. It is NOT a security boundary: role
 * switching here is a demonstration control, and any real request the shell
 * ever makes will be authorized by WD-004's server policy (entitlements,
 * scopes, field visibility) before data leaves the server. The real system
 * must never trust a browser role switch, a submitted owner id or a hidden
 * button (technical specification, "Identity and application permissions").
 *
 * What the demo projection models, using the fixture principals and their
 * entitlement capabilities:
 *
 * - Row visibility: public stations for everyone; restricted stations for the
 *   owning organization, staff assigned to the station's system, and the
 *   statewide steward; internal stations for assigned staff and the steward.
 * - Field visibility: the restricted operational block (gate code, wiring
 *   notes) is stripped from every projection except viewers whose active
 *   entitlement carries `view-internal-diagnostics` (or statewide
 *   administration) AND whose scope covers the station. A public station can
 *   carry an internal block (sta-bear-corinne): row visibility alone is not
 *   sufficient (FR-049).
 * - Stream visibility: restricted datastreams and their observations never
 *   surface in public/owner-outside/researcher projections.
 */
import { activeEntitlements, stations, systemName } from './fixtures';
import type { DatastreamRecord, InternalBlock, StationRecord, StationStatus, StationVisibility, TelemetryKind } from './types';
import { latestReading, stationFreshness, type Freshness, type LatestReading, type PointFlag } from './observations';

/**
 * Demo roles. 'deputy' has no persona entry point; it exists so the fixture
 * deputy principal (Ana, time-bounded delegation) can be exercised in tests.
 */
export type DemoRole = 'public' | 'water-user' | 'researcher' | 'commissioner' | 'engineer' | 'steward' | 'deputy';

export interface Viewer {
  personaId: string;
  role: DemoRole;
  principalId: string | null;
  organizationId: string | null;
}

export interface StationProjection {
  id: string;
  displayName: string;
  externalId: string;
  systemId: string;
  systemName: string;
  providerId: string;
  siteTypeId: string;
  status: StationStatus;
  visibility: StationVisibility;
  telemetry: TelemetryKind;
  waterSourceTypeId: string;
  latitude: number;
  longitude: number;
  elevationFt: number;
  /** 'public' rows versus rows visible through an explicit demo assignment. */
  access: 'public' | 'assigned';
  /** Datastreams visible to this viewer (restricted streams filtered out). */
  streamIds: string[];
  /** Latest discharge reading; null value means unavailable, never zero. */
  latest: LatestReading | null;
  freshness: Freshness;
  /** Restricted operational block; present only for entitled demo viewers. */
  internal: InternalBlock | null;
}

function entitlementCoversSystem(viewer: Viewer, systemId: string): boolean {
  return activeEntitlements(viewer.principalId ?? '').some((ent) => {
    if (ent.scopeType === 'statewide') return true;
    return ent.scopeType === 'system' && ent.scopeId === systemId;
  });
}

function hasCapability(viewer: Viewer, capability: string): boolean {
  return activeEntitlements(viewer.principalId ?? '').some((ent) => ent.capabilities.includes(capability));
}

function seesInternalBlock(viewer: Viewer, station: StationRecord): boolean {
  if (!station.internal) return false;
  const statewide = hasCapability(viewer, 'statewide-administration');
  const diagnosticsInScope = hasCapability(viewer, 'view-internal-diagnostics') && entitlementCoversSystem(viewer, station.systemId);
  return statewide || diagnosticsInScope;
}

/** Row visibility: can this viewer see the station at all in the demo? */
export function canSeeStation(viewer: Viewer, station: StationRecord): boolean {
  if (station.visibility === 'public') return true;
  if (viewer.role === 'steward') return true;
  const assigned = ['commissioner', 'engineer', 'deputy'].includes(viewer.role) && entitlementCoversSystem(viewer, station.systemId);
  const owns = viewer.organizationId !== null && station.ownerOrganizationId === viewer.organizationId;
  if (station.visibility === 'restricted') return assigned || owns;
  return assigned; // internal: assigned staff only (plus steward above)
}

function visibleStreams(viewer: Viewer, station: StationRecord): DatastreamRecord[] {
  return station.datastreams.filter((stream) => {
    if (stream.visibility === 'public') return true;
    if (viewer.role === 'steward') return true;
    const assigned = ['commissioner', 'engineer', 'deputy'].includes(viewer.role) && entitlementCoversSystem(viewer, station.systemId);
    const owns = viewer.organizationId !== null && station.ownerOrganizationId === viewer.organizationId;
    return assigned || owns;
  });
}

/**
 * Project one station for one demo viewer, or null when the row itself is not
 * visible. Restricted fields are stripped unless the viewer's entitlement
 * covers them; restricted streams are filtered from `streamIds`.
 */
export function projectStation(viewer: Viewer, station: StationRecord): StationProjection | null {
  if (!canSeeStation(viewer, station)) return null;
  const stationWithoutRestrictedStreams: StationRecord = { ...station, datastreams: visibleStreams(viewer, station) };
  return {
    id: station.id,
    displayName: station.displayName,
    externalId: station.externalId,
    systemId: station.systemId,
    systemName: '',
    providerId: station.providerId,
    siteTypeId: station.siteTypeId,
    status: station.status,
    visibility: station.visibility,
    telemetry: station.telemetry,
    waterSourceTypeId: station.waterSourceTypeId,
    latitude: station.latitude,
    longitude: station.longitude,
    elevationFt: station.elevationFt,
    access: station.visibility === 'public' ? 'public' : 'assigned',
    streamIds: stationWithoutRestrictedStreams.datastreams.map((stream) => stream.id),
    latest: latestReading(stationWithoutRestrictedStreams),
    freshness: stationFreshness(station),
    internal: seesInternalBlock(viewer, station) ? station.internal ?? null : null,
  };
}

/** The full projected catalog for a viewer, in fixture order. */
export function projectCatalog(viewer: Viewer): StationProjection[] {
  return stations
    .map((station) => {
      const projection = projectStation(viewer, station);
      return projection === null ? null : { ...projection, systemName: systemName(station.systemId) };
    })
    .filter((projection): projection is StationProjection => projection !== null);
}

/**
 * The strict public projection: everything any recipient may see regardless of
 * persona. Used by exports and URL-adjacent helpers; asserts that gate codes
 * and wiring notes can never appear in it.
 */
export function publicStationFields(station: StationRecord): Omit<StationProjection, 'internal'> & { internal: null } {
  const viewer: Viewer = { personaId: 'unauthenticated', role: 'public', principalId: null, organizationId: null };
  const projection = projectStation(viewer, station);
  if (projection === null) throw new Error(`station ${station.id} is not publicly visible`);
  if (projection.internal !== null) throw new Error('public projection must never carry the internal block');
  return { ...projection, internal: null };
}

export type { PointFlag };
