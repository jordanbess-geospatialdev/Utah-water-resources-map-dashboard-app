/**
 * Shared fixture world and input builders for the WD-013-R2 quality-trends
 * suites (mirrors the WD-013 QC helpers).
 *
 * The trend input is assembled from the AUTHORITATIVE stores, read-only:
 * - QC hits: the REVIEWED EXPECTED fixture outcomes of WD-013
 *   (workflows/qc/expected.ts, status reviewed-pending-owner-approval) - 20
 *   violation records hand-derived from the contract observations;
 * - corrections: the WD-011 revision store's seeded chain (the four fixture
 *   revisions, joined to their observation rows for stream + observed time);
 * - known issues: recorded live through the WD-013 known-issue service
 *   (steward persona, advancing clock);
 * - curve supersessions: the WD-011-R2 rating-curve store's seeded chains.
 */
import { readFileSync } from 'node:fs';
import {
  buildWorld,
  type PolicyWorld,
  type StationsFixture,
} from '../../../../../packages/policy/src/index.ts';
import { systemObjects } from '../../workflows/stewardship/connections.ts';
import { EXPECTED_BY_FAMILY } from '../../workflows/qc/expected.ts';
import { createKnownIssueService, type KnownIssueService } from '../../workflows/qc/knownIssues.ts';
import { createRevisionStore, type RevisionStore } from '../../workflows/revisions/store.ts';
import { createRatingCurveStore, type RatingCurveStore } from '../../workflows/rating-curves/store.ts';
import {
  curveSupersessionsOf,
} from '../curveDiagnostics.ts';
import type {
  CorrectionEventRecord,
  KnownIssueRecord,
  QcHitRecord,
  TrendInput,
  TrendStreamMeta,
} from '../trends.ts';

// ---------------------------------------------------------------------------
// Personas / constants
// ---------------------------------------------------------------------------

export const DIEGO = 'principal-diego-steward';
export const FATIMA = 'principal-fatima-engineer';
export const PRIYA = 'principal-priya-engineer';
export const CODY = 'principal-cody-commissioner';
export const NINA = 'principal-nina-engineer';

export const SYSTEM_BEAR = 'sys-bear-river';
export const SYSTEM_WEBER = 'sys-weber-river';

/** The fixture fixed clock (seed-manifest fixed_clock). */
export const NOW = '2026-03-09T07:00:00Z';

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

function read<T>(name: string): T {
  return JSON.parse(readFileSync(new URL('../../../../../fixtures/contracts/' + name, import.meta.url), 'utf8')) as T;
}

interface StationsShape {
  readonly stations: ReadonlyArray<{
    readonly id: string;
    readonly systemId: string;
    readonly status: string;
    readonly datastreams?: ReadonlyArray<{ readonly id: string; readonly stationId: string; readonly visibility: string }>;
  }>;
}

/** Site table: every fixture stream with station, system and visibility. */
export function streamMetaTable(): Readonly<Record<string, TrendStreamMeta>> {
  const stations = read<StationsShape>('stations.json');
  const table: Record<string, TrendStreamMeta> = {};
  for (const station of stations.stations) {
    for (const stream of station.datastreams ?? []) {
      table[stream.id] = {
        streamId: stream.id,
        stationId: station.id,
        systemId: station.systemId,
        visibility:
          stream.visibility === 'internal' ? 'internal' : stream.visibility === 'restricted' ? 'restricted' : 'public',
      };
    }
  }
  return table;
}

// ---------------------------------------------------------------------------
// Policy world (mirrors workflows/qc/test/helpers.ts: Nina is a Weber-system
// engineer WITH view-internal-diagnostics, so cross-system denial is scope)
// ---------------------------------------------------------------------------

export function buildTrendsWorld(): PolicyWorld {
  return buildWorld({
    principals: read('principals.json'),
    stations: read('stations.json') as unknown as StationsFixture,
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

/** Deterministic advancing clock starting at NOW, ticking by whole minutes. */
export function advancingClock(startMs = Date.parse(NOW)): {
  readonly clock: () => string;
  readonly advanceMinutes: (minutes: number) => void;
} {
  let current = startMs;
  return {
    clock: () => new Date(current).toISOString().replace('.000Z', 'Z'),
    advanceMinutes: (minutes) => {
      current += minutes * 60_000;
    },
  };
}

// ---------------------------------------------------------------------------
// Record bridges (authoritative stores -> trend input records)
// ---------------------------------------------------------------------------

/**
 * The 20 REVIEWED QC fixture outcomes as trend hit records. hitId derives
 * from (family, stream, interval start): stable, unique per record.
 */
export function reviewedQcHits(): readonly QcHitRecord[] {
  const hits: QcHitRecord[] = [];
  for (const [family, violations] of Object.entries(EXPECTED_BY_FAMILY)) {
    for (const violation of violations) {
      hits.push({
        hitId: `qc:${family}:${violation.streamId}:${violation.interval.start}`,
        streamId: violation.streamId,
        family,
        interval: violation.interval,
      });
    }
  }
  return hits;
}

/** The WD-011 fixture revision chain joined to its observation rows. */
export function fixtureCorrections(store: RevisionStore = createRevisionStore()): readonly CorrectionEventRecord[] {
  return store.revisions.map((revision) => {
    const observation = store.observationById(revision.targetObservationId);
    if (!observation) throw new Error(`fixture revision ${revision.id} targets unknown observation`);
    return {
      revisionId: revision.id,
      targetObservationId: revision.targetObservationId,
      streamId: observation.streamId,
      observedAt: observation.observedAt,
      recordedAt: revision.recordedAt,
      type: revision.type,
      actorId: revision.actorId,
    };
  });
}

/**
 * Two known issues recorded live through the WD-013 service by the statewide
 * steward: one PUBLIC issue on the Corinne telemetry stream (the freeze
 * window) and one INTERNAL issue on the internal voltage stream.
 */
export function fixtureKnownIssues(world: PolicyWorld = buildTrendsWorld()): readonly KnownIssueRecord[] {
  const clock = advancingClock(Date.parse('2026-03-09T08:00:00Z'));
  const service: KnownIssueService = createKnownIssueService({ world, clock: clock.clock });
  const freeze = service.recordIssue(DIEGO, {
    streamId: 'str-corinne-q',
    interval: { start: '2026-03-07T15:00:00Z', end: '2026-03-08T04:00:00Z' },
    title: 'Freeze window: suspect zero and icing spikes',
    description: 'Frozen sensor period bracketing the suspect zero and the negative icing spike.',
    visibility: 'public',
  });
  if (!freeze.ok) throw new Error(`fixture known issue failed: ${JSON.stringify(freeze)}`);
  clock.advanceMinutes(10);
  const sag = service.recordIssue(DIEGO, {
    streamId: 'str-diag-voltage',
    interval: { start: '2026-03-09T06:00:00Z', end: '2026-03-09T07:00:00Z' },
    title: 'Battery voltage sagging below minimum',
    description: 'Internal diagnostic battery below the 11.5 V minimum at the last reading.',
    visibility: 'internal',
  });
  if (!sag.ok) throw new Error(`fixture known issue failed: ${JSON.stringify(sag)}`);
  return [freeze, sag].map((outcome) => {
    const issue = outcome.issue;
    return {
      issueId: issue.id,
      streamId: issue.streamId,
      interval: issue.interval,
      title: issue.title,
      status: issue.status,
      visibility: issue.visibility,
    };
  });
}

/** Curve supersession records from the WD-011-R2 store's seeded chains. */
export function fixtureCurveSupersessions(store: RatingCurveStore = createRatingCurveStore()) {
  return curveSupersessionsOf(store);
}

/**
 * The full fixture trend input (27 raw records: 20 reviewed QC hits, 4
 * fixture revisions, 2 known issues, 1 curve supersession).
 */
export function fixtureTrendInput(overrides: Partial<TrendInput> = {}): TrendInput {
  return {
    now: NOW,
    streamMeta: streamMetaTable(),
    qcHits: reviewedQcHits(),
    corrections: fixtureCorrections(),
    knownIssues: fixtureKnownIssues(),
    curveSupersessions: fixtureCurveSupersessions(),
    ...overrides,
  };
}

/** Raw-record count of a trend input (the reconciliation denominator). */
export function rawRecordCount(input: TrendInput): number {
  return (
    (input.qcHits?.length ?? 0) +
    (input.corrections?.length ?? 0) +
    (input.knownIssues?.length ?? 0) +
    (input.curveSupersessions?.length ?? 0)
  );
}
