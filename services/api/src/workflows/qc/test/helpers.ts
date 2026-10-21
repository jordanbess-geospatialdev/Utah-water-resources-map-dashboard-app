/**
 * Shared fixture world and series loaders for the WD-013 QC suites.
 *
 * The frozen contract fixtures plus one synthetic principal beyond the
 * stewardship helpers: Nina, a Weber-system engineer who DOES hold
 * view-internal-diagnostics (scoped sys-weber-river) - so the cross-system
 * denial on the Bear River internal voltage stream is a genuine
 * DENY_OUT_OF_SCOPE, not a capability miss.
 */
import { readFileSync } from 'node:fs';
import { buildWorld, type PolicyWorld } from '../../../../../../packages/policy/src/index.ts';
import { systemObjects } from '../../stewardship/connections.ts';
import { seriesFromObservations, type QcSeries } from '../rules.ts';

export const DIEGO = 'principal-diego-steward';
export const FATIMA = 'principal-fatima-engineer';
export const PRIYA = 'principal-priya-engineer';
export const CODY = 'principal-cody-commissioner';
export const ANA = 'principal-ana-deputy';
export const SARAH = 'principal-sarah-researcher';
export const NINA = 'principal-nina-engineer';

export const SYSTEM_BEAR = 'sys-bear-river';
export const SYSTEM_WEBER = 'sys-weber-river';

/** Fixed clock inside the fixture present (mirrors the stewardship suites). */
export const NOW = '2026-03-10T14:00:00Z';

function read<T>(name: string): T {
  return JSON.parse(readFileSync(new URL('../../../../../../fixtures/contracts/' + name, import.meta.url), 'utf8')) as T;
}

export interface StationsFixtureShape {
  readonly stations: ReadonlyArray<{
    readonly id: string;
    readonly systemId: string;
    readonly status: string;
    readonly datastreams?: ReadonlyArray<{
      readonly id: string;
      readonly stationId: string;
      readonly observedPropertyId: string;
      readonly unitId: string;
      readonly cadenceMinutes: number;
      readonly validRangeMin: number;
      readonly validRangeMax: number;
      readonly visibility: string;
    }>;
  }>;
}

export interface ObservationsFixtureShape {
  readonly observations: ReadonlyArray<{ readonly id: string; readonly streamId: string; readonly observedAt: string; readonly value: number | null }>;
}

/** The fixture world with system anchors and the Weber engineer Nina. */
export function buildTestWorld(): PolicyWorld {
  return buildWorld({
    principals: read('principals.json'),
    stations: read('stations.json'),
    extraObjects: [...systemObjects([SYSTEM_BEAR, SYSTEM_WEBER])],
    extraPrincipals: [
      { id: NINA, displayName: 'Nina Weber Engineer', roles: ['engineer'], active: true, assignedSystemId: SYSTEM_WEBER },
    ],
    extraEntitlements: [
      {
        id: 'ent-engineer-nina',
        principalId: NINA,
        role: 'engineer',
        capabilities: ['enter-readings', 'edit-site-metadata', 'view-internal-diagnostics'],
        scopeType: 'system',
        scopeId: SYSTEM_WEBER,
        effectiveAt: '2026-01-01T00:00:00Z',
        expiresAt: null,
        status: 'active',
        delegation: null,
        grantedBy: DIEGO,
        grantVersion: 21,
      },
    ],
  });
}

/** Every fixture datastream as a QcSeries (streams without observations yield empty series). */
export function fixtureSeries(): readonly QcSeries[] {
  const stations = read<StationsFixtureShape>('stations.json');
  const observations = read<ObservationsFixtureShape>('observations.json');
  const series: QcSeries[] = [];
  for (const station of stations.stations) {
    for (const stream of station.datastreams ?? []) {
      series.push(
        seriesFromObservations(
          { id: stream.id, observedPropertyId: stream.observedPropertyId, unitId: stream.unitId, cadenceMinutes: stream.cadenceMinutes },
          observations.observations,
        ),
      );
    }
  }
  return series.sort((a, b) => (a.streamId < b.streamId ? -1 : 1));
}

/** Stream metadata table (systemId, stationId, visibility) keyed by stream id. */
export interface StreamMetaRow {
  readonly streamId: string;
  readonly stationId: string;
  readonly systemId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  readonly cadenceMinutes: number;
  readonly visibility: 'public' | 'restricted' | 'internal';
}

export function streamMetaRows(): readonly StreamMetaRow[] {
  const stations = read<StationsFixtureShape>('stations.json');
  const rows: StreamMetaRow[] = [];
  for (const station of stations.stations) {
    for (const stream of station.datastreams ?? []) {
      rows.push({
        streamId: stream.id,
        stationId: stream.stationId,
        systemId: station.systemId,
        observedPropertyId: stream.observedPropertyId,
        unitId: stream.unitId,
        cadenceMinutes: stream.cadenceMinutes,
        visibility: stream.visibility === 'internal' ? 'internal' : stream.visibility === 'restricted' ? 'restricted' : 'public',
      });
    }
  }
  return rows.sort((a, b) => (a.streamId < b.streamId ? -1 : 1));
}

/** Deterministic advancing clock helper: start at NOW, tick by whole minutes. */
export function advancingClock(startMs = Date.parse(NOW)): { readonly clock: () => string; readonly advanceMinutes: (minutes: number) => void; readonly now: () => string } {
  let current = startMs;
  return {
    clock: () => new Date(current).toISOString().replace('.000Z', 'Z'),
    advanceMinutes: (minutes) => {
      current += minutes * 60_000;
    },
    now: () => new Date(current).toISOString().replace('.000Z', 'Z'),
  };
}

/** Diagnostic stream inputs for every fixture datastream (history included). */
export function diagnosticStreams(): readonly {
  streamId: string;
  stationId: string;
  systemId: string;
  observedPropertyId: string;
  unitId: string;
  cadenceMinutes: number;
  visibility: 'public' | 'restricted' | 'internal';
  latest: { observedAt: string; value: number | null } | null;
  history: readonly { observedAt: string; value: number | null }[];
}[] {
  const series = fixtureSeries();
  return streamMetaRows().map((meta) => {
    const points = series.find((candidate) => candidate.streamId === meta.streamId)?.points ?? [];
    const latest = points.at(-1) ?? null;
    return {
      streamId: meta.streamId,
      stationId: meta.stationId,
      systemId: meta.systemId,
      observedPropertyId: meta.observedPropertyId,
      unitId: meta.unitId,
      cadenceMinutes: meta.cadenceMinutes,
      visibility: meta.visibility,
      latest: latest ? { observedAt: latest.observedAt, value: latest.value } : null,
      history: points.map((point) => ({ observedAt: point.observedAt, value: point.value })),
    };
  });
}
