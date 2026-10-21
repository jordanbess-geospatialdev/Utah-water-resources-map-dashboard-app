/**
 * Fixture-backed site store (WD-010): stations, effective-dated stream
 * setups and versioned capacity thresholds, with an append-only audit log.
 *
 * Invariants:
 * - Fixture stations load once; edits apply to the working copies and bump
 *   the site's optimistic version (If-Match anchor). The audit log stores
 *   before-and-after values so any edit is reversible in review (FR-023).
 * - Setup epochs are append-only and half-open [effectiveFrom, effectiveTo):
 *   a device replacement CLOSES the current epoch and appends a NEW one;
 *   nothing ever edits or removes a closed epoch, so readings recorded
 *   under it keep their original device/method context (FR-033).
 * - Thresholds version forward per (site, metric): the previous record is
 *   closed, never overwritten (FR-034).
 * - The audit log is append-only and survives actor deactivation: entries
 *   keep actorId, which stays resolvable via the policy engine.
 * - No clock reads, no randomness; identifiers derive from append sequences.
 */
import { readFileSync } from 'node:fs';
import { buildWorld, type PolicyObject, type PolicyWorld, type StationsFixture } from '../../../../../packages/policy/src/index.ts';
import type { PhotoMetadata, SetupEpoch, SiteAuditEvent, SiteMetadata, ThresholdRecord } from './types.ts';

const FIXTURE_DIR = '../../../../../fixtures/contracts/';

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(FIXTURE_DIR + name, import.meta.url), 'utf8')) as T;
}

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}

interface FixtureDeployment {
  deviceId: string;
  serial: string;
  model: string;
  installedAt: string;
  removedAt: string | null;
}

interface FixtureDatastream {
  id: string;
  stationId: string;
  observedPropertyId: string;
  unitId: string;
  methodTypeId: string;
  validRangeMin: number | null;
  validRangeMax: number | null;
  visibility: string;
  timeZone: string;
  deviceDeployments?: FixtureDeployment[];
}

interface FixtureStation {
  id: string;
  displayName: string;
  externalId?: string;
  systemId: string;
  siteTypeId: string;
  status: string;
  visibility: string;
  stateCode: string;
  latitude: number;
  longitude: number;
  elevationFt?: number;
  version: number;
  datastreams?: FixtureDatastream[];
}

export interface SiteStore {
  readonly world: PolicyWorld;
  readonly auditEvents: readonly SiteAuditEvent[];

  /**
   * A derived view with a different authoritative policy snapshot (revocation,
   * deactivation) sharing every mutable registry - the next decision is
   * evaluated against the new world while history stays append-only.
   */
  withWorld(world: PolicyWorld): SiteStore;

  siteById(siteId: string): SiteMetadata | null;
  /** Streams of a site with their observed properties (threshold metric validation). */
  streamPropertiesOf(siteId: string): ReadonlyArray<{ streamId: string; observedPropertyId: string }>;
  streamById(streamId: string): { streamId: string; stationId: string; systemId: string; observedPropertyId: string; methodTypeId: string } | null;

  /** The epoch effective at an instant (FR-033 context resolution). */
  epochAt(streamId: string, observedAt: string): SetupEpoch | null;
  currentEpoch(streamId: string): SetupEpoch | null;
  epochsOf(streamId: string): readonly SetupEpoch[];
  /** Current optimistic setup version (the readings workflow mirrors this). */
  streamSetupVersion(streamId: string): number;

  thresholdsFor(siteId: string, metric: string): readonly ThresholdRecord[];

  /** Mutation paths used by siteSetup.ts (validation lives there, not here). */
  applySiteEdit(request: {
    siteId: string;
    actorId: string;
    now: string;
    changes: ReadonlyArray<{ field: string; before: unknown; after: unknown }>;
    patch: (site: SiteMetadata) => SiteMetadata;
    action: SiteAuditEvent['action'];
  }): { site: SiteMetadata; auditEvent: SiteAuditEvent };
  appendSetupEpoch(request: {
    streamId: string;
    actorId: string;
    siteId: string;
    now: string;
    closeCurrentAt: string;
    epoch: Omit<SetupEpoch, 'id' | 'setupVersion'>;
  }): { epoch: SetupEpoch; auditEvent: SiteAuditEvent };
  appendThreshold(request: {
    siteId: string;
    actorId: string;
    now: string;
    closePreviousAt: string;
    threshold: Omit<ThresholdRecord, 'id' | 'version'>;
  }): { threshold: ThresholdRecord; auditEvent: SiteAuditEvent };
  recordNewSite(request: {
    site: Omit<SiteMetadata, 'version'>;
    actorId: string;
    now: string;
  }): { site: SiteMetadata; auditEvent: SiteAuditEvent };
}

export function createSiteStore(): SiteStore {
  const stationsFile = readFixture<{ stations: FixtureStation[] }>('stations.json');
  const systemsFile = readFixture<{ systems: Array<{ id: string }> }>('systems.json');
  const principalsFile = readFixture<Parameters<typeof buildWorld>[0]['principals']>('principals.json');

  // Systems become policy objects so create-sites can be scoped to one.
  const systemObjects: PolicyObject[] = systemsFile.systems.map((system) =>
    freeze({
      id: system.id,
      kind: 'system',
      systemId: system.id,
      ownerOrganizationId: null,
      stationId: null,
      datasetId: null,
      ownerPrincipalId: null,
      targetObjectId: null,
      visibility: 'internal',
      status: 'active',
      fields: freeze({}),
    } satisfies PolicyObject),
  );
  const world = buildWorld({
    principals: principalsFile,
    stations: stationsFile as unknown as StationsFixture,
    extraObjects: systemObjects,
  });

  // --- sites ---------------------------------------------------------------
  const sites = new Map<string, SiteMetadata>();
  const streamIndex = new Map<string, { streamId: string; stationId: string; systemId: string; observedPropertyId: string; methodTypeId: string }>();
  const stationStreams = new Map<string, Array<{ streamId: string; observedPropertyId: string }>>();
  for (const station of stationsFile.stations) {
    sites.set(
      station.id,
      freeze({
        id: station.id,
        displayName: station.displayName,
        externalId: station.externalId ?? null,
        systemId: station.systemId,
        siteTypeId: station.siteTypeId ?? 'natural-channel',
        status: (station.status as SiteMetadata['status']) ?? 'active',
        latitude: station.latitude,
        longitude: station.longitude,
        elevationFt: station.elevationFt ?? null,
        stateCode: station.stateCode ?? 'UT',
        capacities: freeze({ maxDiversionCfs: null, storageAcreFeet: null }),
        photos: freeze([]),
        version: station.version,
      } satisfies SiteMetadata),
    );
    const streams: Array<{ streamId: string; observedPropertyId: string }> = [];
    for (const stream of station.datastreams ?? []) {
      streamIndex.set(stream.id, {
        streamId: stream.id,
        stationId: stream.stationId,
        systemId: station.systemId,
        observedPropertyId: stream.observedPropertyId,
        methodTypeId: stream.methodTypeId,
      });
      streams.push({ streamId: stream.id, observedPropertyId: stream.observedPropertyId });
    }
    stationStreams.set(station.id, freeze(streams));
  }

  // --- effective-dated setup epochs (seeded from fixture deviceDeployments) --
  const epochs = new Map<string, SetupEpoch[]>();
  const setupVersions = new Map<string, number>();
  let epochSequence = 0;
  for (const station of stationsFile.stations) {
    for (const stream of station.datastreams ?? []) {
      const seeded: SetupEpoch[] = (stream.deviceDeployments ?? []).map((deployment) => {
        epochSequence += 1;
        return freeze({
          id: `epoch-seed-${String(1000 + epochSequence)}`,
          streamId: stream.id,
          effectiveFrom: deployment.installedAt,
          effectiveTo: deployment.removedAt,
          deviceId: deployment.deviceId,
          serial: deployment.serial,
          model: deployment.model,
          methodTypeId: stream.methodTypeId,
          validRangeMin: stream.validRangeMin ?? null,
          validRangeMax: stream.validRangeMax ?? null,
          setupVersion: station.version,
        } satisfies SetupEpoch);
      });
      epochs.set(stream.id, seeded);
      setupVersions.set(stream.id, station.version);
    }
  }

  // --- thresholds + audit ----------------------------------------------------
  const thresholds = new Map<string, ThresholdRecord[]>();
  const auditEvents: SiteAuditEvent[] = [];

  function audit(action: SiteAuditEvent['action'], actorId: string, siteId: string, streamId: string | null, changes: ReadonlyArray<{ field: string; before: unknown; after: unknown }>, now: string): SiteAuditEvent {
    const event = freeze({
      id: `site-audit-${String(1000 + auditEvents.length + 1)}`,
      action,
      actorId,
      siteId,
      streamId,
      changes: freeze([...changes]),
      recordedAt: now,
    } satisfies SiteAuditEvent);
    auditEvents.push(event);
    return event;
  }

  const store: SiteStore = {
    world,
    withWorld(nextWorld) {
      return { ...store, world: nextWorld };
    },
    get auditEvents() {
      return Object.freeze([...auditEvents]);
    },
    siteById(siteId) {
      return sites.get(siteId) ?? null;
    },
    streamPropertiesOf(siteId) {
      return stationStreams.get(siteId) ?? [];
    },
    streamById(streamId) {
      return streamIndex.get(streamId) ?? null;
    },
    epochAt(streamId, observedAt) {
      const list = epochs.get(streamId) ?? [];
      const t = Date.parse(observedAt);
      return (
        list.find((epoch) => Date.parse(epoch.effectiveFrom) <= t && (epoch.effectiveTo === null || t < Date.parse(epoch.effectiveTo))) ?? null
      );
    },
    currentEpoch(streamId) {
      const list = epochs.get(streamId) ?? [];
      return list.find((epoch) => epoch.effectiveTo === null) ?? list.at(-1) ?? null;
    },
    epochsOf(streamId) {
      return Object.freeze([...(epochs.get(streamId) ?? [])]);
    },
    streamSetupVersion(streamId) {
      return setupVersions.get(streamId) ?? 0;
    },
    thresholdsFor(siteId, metric) {
      return Object.freeze([...(thresholds.get(`${siteId}:${metric}`) ?? [])]);
    },
    applySiteEdit(request) {
      const site = sites.get(request.siteId);
      if (!site) throw new Error(`applySiteEdit: unknown site "${request.siteId}"`);
      const updated = freeze({ ...request.patch(site), version: site.version + 1 } satisfies SiteMetadata);
      sites.set(request.siteId, updated);
      const auditEvent = audit(request.action, request.actorId, request.siteId, null, request.changes, request.now);
      return { site: updated, auditEvent };
    },
    appendSetupEpoch(request) {
      const list = epochs.get(request.streamId);
      if (!list) throw new Error(`appendSetupEpoch: unknown stream "${request.streamId}"`);
      const current = list.find((epoch) => epoch.effectiveTo === null);
      if (current) {
        const closedIndex = list.indexOf(current);
        list[closedIndex] = freeze({ ...current, effectiveTo: request.closeCurrentAt });
      }
      const version = (setupVersions.get(request.streamId) ?? 0) + 1;
      setupVersions.set(request.streamId, version);
      const epoch = freeze({ ...request.epoch, id: `epoch-${String(1000 + ++epochSequence)}`, setupVersion: version } satisfies SetupEpoch);
      list.push(epoch);
      const changes: Array<{ field: string; before: unknown; after: unknown }> = [
        { field: 'setup.closedEpochId', before: current?.id ?? null, after: current ? request.closeCurrentAt : null },
        { field: 'setup.device', before: current ? `${current.deviceId}/${current.serial}` : null, after: `${epoch.deviceId}/${epoch.serial}` },
        { field: 'setup.methodTypeId', before: current?.methodTypeId ?? null, after: epoch.methodTypeId },
        { field: 'setup.setupVersion', before: current?.setupVersion ?? null, after: version },
      ];
      const auditEvent = audit('replace-measurement-setup', request.actorId, request.siteId, request.streamId, changes, request.now);
      return { epoch, auditEvent };
    },
    appendThreshold(request) {
      const key = `${request.siteId}:${request.threshold.metric}`;
      const list = thresholds.get(key) ?? [];
      const current = list.find((threshold) => threshold.effectiveTo === null);
      if (current) {
        const index = list.indexOf(current);
        list[index] = freeze({ ...current, effectiveTo: request.closePreviousAt });
      }
      const threshold = freeze({ ...request.threshold, id: `thr-${String(1000 + list.length + 1)}`, version: list.length + 1 } satisfies ThresholdRecord);
      list.push(threshold);
      thresholds.set(key, list);
      const changes: Array<{ field: string; before: unknown; after: unknown }> = [
        { field: `threshold[${request.threshold.metric}].closedVersion`, before: current ? `${current.version}: ${current.lowerBound ?? 'null'}..${current.upperBound ?? 'null'}` : null, after: request.closePreviousAt },
        { field: `threshold[${request.threshold.metric}].bounds`, before: current ? `${current.lowerBound ?? 'null'}..${current.upperBound ?? 'null'}` : null, after: `${threshold.lowerBound ?? 'null'}..${threshold.upperBound ?? 'null'}` },
        { field: `threshold[${request.threshold.metric}].version`, before: current?.version ?? 0, after: threshold.version },
      ];
      const auditEvent = audit('set-capacity-thresholds', request.actorId, request.siteId, null, changes, request.now);
      return { threshold, auditEvent };
    },
    recordNewSite(request) {
      const site = freeze({ ...request.site, version: 1 } satisfies SiteMetadata);
      sites.set(site.id, site);
      const auditEvent = audit('create-site', request.actorId, site.id, null, [{ field: 'site', before: null, after: site.systemId }], request.now);
      return { site, auditEvent };
    },
  };

  return store;
}

/** Allowed PATCH fields; anything else is rejected with field paths (PATCH /sites/{id}: "Allowed metadata fields only"). */
export const EDITABLE_SITE_FIELDS: readonly string[] = [
  'displayName',
  'siteTypeId',
  'systemId',
  'latitude',
  'longitude',
  'elevationFt',
  'stateCode',
  'capacities',
  'photos',
];

/** Photo categories accepted in photo metadata (FR-031 "photos"). */
export const PHOTO_CATEGORIES: readonly PhotoMetadata['category'][] = ['site-overview', 'installation', 'gauge-plate', 'other'];
