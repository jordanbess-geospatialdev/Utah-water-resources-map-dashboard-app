/**
 * Fixture-backed append-only rating-curve and shift version store
 * (WD-011-R2, FR-045).
 *
 * Invariants (all exercised by the suites in ./test):
 * - Version chains are APPEND-ONLY per stream: creating the first version
 *   appends; a revision CLOSES the currently open version's interval at the
 *   successor's effectiveFrom (the record itself is retained, never deleted
 *   or reordered) and appends the successor. Superseded versions keep their
 *   ids, ordinals, author and provenance - history never collapses.
 * - Effective intervals are HALF-OPEN [effectiveFrom, effectiveTo); the two
 *   seeded fixture periods touch at 2026-03-07T18:00:00Z exactly once
 *   (the 2019 curve excludes the instant, the 2026 curve includes it). The
 *   store's overlap guard is applied by the workflow on every mutation,
 *   so at most ONE version of a kind can cover any instant.
 * - Raw readings and revision chains are NOT part of this store: no
 *   operation here has any code path that writes to observations or
 *   revisions (the immutability suite proves it by hash before/after).
 * - The computed-value ledger is append-only and frozen: a conversion
 *   records the version ids it used, and a later supersession never
 *   rewrites an earlier entry (FR-045 "a revised curve does not erase
 *   earlier conversions").
 * - Every mutation is one logical transaction: version transition + audit
 *   event + transactional-outbox event (ADR-10) land together.
 * - No clock reads, no randomness; identifiers derive from append
 *   sequences, so identical operation sequences produce byte-identical
 *   logs (see the determinism suite).
 *
 * Seed provenance note: the frozen fixture (stations.json ratingCurvePeriods)
 * publishes period ids, dates and method labels but no coefficients. The
 * workflow documents the log-linear coefficients below as the working
 * data-owner formulas - PENDING OWNER APPROVAL per the R2 convention; the
 * hand-derived conversion goldens in ./test/golden.test.ts pin them.
 */
import { readFileSync } from 'node:fs';
import {
  buildWorld,
  type PolicyWorld,
  type StationsFixture,
} from '../../../../../packages/policy/src/index.ts';
import type {
  ApprovalState,
  ComputedValue,
  CurveAuditEvent,
  CurveOutboxEvent,
  RatingCurveProvenance,
  RatingCurveVersion,
  RatingShift,
  ShiftSegment,
} from './types.ts';

const FIXTURE_DIR = '../../../../../fixtures/contracts/';

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(FIXTURE_DIR + name, import.meta.url), 'utf8')) as T;
}

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}

interface FixtureCurvePeriod {
  id: string;
  validFrom: string;
  validTo: string | null;
  method: string;
}

interface FixtureDatastream {
  id: string;
  stationId: string;
  observedPropertyId: string;
  unitId: string;
  visibility: string;
  ratingCurvePeriods?: FixtureCurvePeriod[];
}

interface FixtureStation {
  id: string;
  systemId: string;
  status: string;
  visibility: string;
  datastreams?: FixtureDatastream[];
}

/**
 * Working coefficients for the seeded fixture periods, PENDING OWNER
 * APPROVAL (R2 convention: goldens document the derivation, the data owner
 * signs off the numbers). Formula: Q[cfs] = c * (G[ft] - e)^b.
 */
export const SEED_CURVE_COEFFICIENTS: Readonly<Record<string, { readonly c: number; readonly b: number; readonly e: number; readonly calibrationCount: number; readonly note: string }>> = Object.freeze({
  'rc-corinne-2019': {
    c: 38.0,
    b: 1.85,
    e: 1.7,
    calibrationCount: 18,
    note: 'Working log-linear fit for the 2019 device era; coefficients pending data-owner approval.',
  },
  'rc-corinne-2026': {
    c: 41.2,
    b: 1.92,
    e: 1.68,
    calibrationCount: 22,
    note: 'Working log-linear fit with high-flow extension for the RTU replacement era; coefficients pending data-owner approval.',
  },
});

/** The stage -> discharge unit pair every seeded curve uses (governed units). */
export const SEED_UNIT_PAIR = Object.freeze({ fromUnitId: 'ft', toUnitId: 'cfs' });

/** Author/approver the frozen fixture seeds are attributed to (steward persona). */
export const SEED_CURATOR = 'principal-diego-steward';

export interface StreamRef {
  readonly streamId: string;
  readonly stationId: string;
  readonly systemId: string;
  readonly observedPropertyId: string;
  readonly unitId: string;
  readonly visibility: string;
}

export interface RatingCurveStore {
  /** Policy world (stations + datastreams as objects, fixture principals). */
  readonly world: PolicyWorld;

  streamById(streamId: string): StreamRef | null;

  // --- curve chain ---------------------------------------------------------
  curveVersionsOf(streamId: string): readonly RatingCurveVersion[];
  curveVersionById(versionId: string): RatingCurveVersion | null;
  /** The open (effectiveTo === null) version of the chain, when one exists. */
  openCurveVersion(streamId: string): RatingCurveVersion | null;
  /** Versions whose half-open interval covers `at` (any governance state). */
  curvesCovering(streamId: string, at: string): readonly RatingCurveVersion[];
  /**
   * The version APPROVED for the instant `at` (the conversion source).
   * Approval evidence (approvedAt) survives supersession: a superseded
   * version still defines discharge inside its own closed interval - FR-045
   * "a revised curve does not erase earlier conversions". Only versions that
   * were never approved (still drafts) are excluded.
   */
  approvedCurveAt(streamId: string, at: string): RatingCurveVersion | null;

  // --- shift chain ---------------------------------------------------------
  shiftVersionsOf(streamId: string): readonly RatingShift[];
  shiftVersionById(versionId: string): RatingShift | null;
  openShiftVersion(streamId: string): RatingShift | null;
  /** Versions whose half-open interval covers `at` (any governance state). */
  shiftsCovering(streamId: string, at: string): readonly RatingShift[];
  /** The shift version approved for the instant `at` (superseded shifts stay authoritative inside their interval). */
  approvedShiftAt(streamId: string, at: string): RatingShift | null;

  // --- computed-value ledger (append-only lineage evidence) ----------------
  readonly computedValues: readonly ComputedValue[];

  readonly auditEvents: readonly CurveAuditEvent[];
  readonly outboxEvents: readonly CurveOutboxEvent[];

  // --- mutation paths (validation lives in curves.ts / shifts.ts) ----------
  appendCurveVersion(request: {
    streamId: string;
    stationId: string;
    actorId: string;
    now: string;
    /** Close the currently open version at this instant (supersession); null for a plain create. */
    closeCurrentAt: string | null;
    version: Omit<RatingCurveVersion, 'id' | 'version' | 'createdAt' | 'supersededAt'>;
    action: 'create-curve' | 'supersede-curve';
  }): { version: RatingCurveVersion; auditEvent: CurveAuditEvent; outboxEvent: CurveOutboxEvent };
  approveCurveVersion(request: {
    versionId: string;
    actorId: string;
    now: string;
    from: ApprovalState;
    to: ApprovalState;
  }): { version: RatingCurveVersion; auditEvent: CurveAuditEvent; outboxEvent: CurveOutboxEvent };
  appendShiftVersion(request: {
    streamId: string;
    stationId: string;
    actorId: string;
    now: string;
    closeCurrentAt: string | null;
    shift: Omit<RatingShift, 'id' | 'version' | 'createdAt' | 'supersededAt'>;
    action: 'create-shift' | 'supersede-shift';
  }): { shift: RatingShift; auditEvent: CurveAuditEvent; outboxEvent: CurveOutboxEvent };
  approveShiftVersion(request: {
    versionId: string;
    actorId: string;
    now: string;
    from: ApprovalState;
    to: ApprovalState;
  }): { shift: RatingShift; auditEvent: CurveAuditEvent; outboxEvent: CurveOutboxEvent };
  /** Append one frozen conversion record to the lineage ledger. */
  appendComputed(value: Omit<ComputedValue, never>): ComputedValue;
}

/** Does the half-open interval [from, to) cover the instant `at`? */
export function intervalCovers(from: string, to: string | null, at: string): boolean {
  const t = Date.parse(at);
  return Date.parse(from) <= t && (to === null || t < Date.parse(to));
}

/**
 * Do the half-open intervals [fromA, toA) and [fromB, toB) share any
 * instant? Boundary touching (one's end === the other's start) is NOT an
 * overlap - that is exactly how the seeded 2019/2026 periods join.
 */
export function intervalsOverlap(
  fromA: string,
  toA: string | null,
  fromB: string,
  toB: string | null,
): boolean {
  const aStart = Date.parse(fromA);
  const aEnd = toA === null ? Number.POSITIVE_INFINITY : Date.parse(toA);
  const bStart = Date.parse(fromB);
  const bEnd = toB === null ? Number.POSITIVE_INFINITY : Date.parse(toB);
  return aStart < bEnd && bStart < aEnd;
}

export function createRatingCurveStore(): RatingCurveStore {
  const stationsFile = readFixture<{ stations: FixtureStation[] }>('stations.json');
  const principalsFile = readFixture<Parameters<typeof buildWorld>[0]['principals']>('principals.json');
  const world = buildWorld({ principals: principalsFile, stations: stationsFile as unknown as StationsFixture });

  // --- stream index ----------------------------------------------------------
  const streams = new Map<string, StreamRef>();
  for (const station of stationsFile.stations) {
    for (const stream of station.datastreams ?? []) {
      streams.set(stream.id, freeze({
        streamId: stream.id,
        stationId: stream.stationId,
        systemId: station.systemId,
        observedPropertyId: stream.observedPropertyId,
        unitId: stream.unitId,
        visibility: stream.visibility,
      }));
    }
  }

  // --- seeded curve chains (fixture ratingCurvePeriods, published state) -----
  const curves = new Map<string, RatingCurveVersion[]>();
  const shifts = new Map<string, RatingShift[]>();
  for (const station of stationsFile.stations) {
    for (const stream of station.datastreams ?? []) {
      curves.set(stream.id, []);
      shifts.set(stream.id, []);
      const periods = stream.ratingCurvePeriods ?? [];
      periods
        .slice()
        .sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom))
        .forEach((period, index) => {
          const seed = SEED_CURVE_COEFFICIENTS[period.id];
          const provenance: RatingCurveProvenance = freeze({
            source: `fixtures/contracts/stations.json#ratingCurvePeriods/${period.id}`,
            calibrationCount: seed?.calibrationCount ?? null,
            note: seed?.note ?? 'Fixture rating-curve period; coefficients pending data-owner approval.',
          });
          curves.get(stream.id)?.push(
            freeze({
              id: period.id,
              stationId: station.id,
              streamId: stream.id,
              coefficients: freeze({ c: seed?.c ?? 0, b: seed?.b ?? 0, e: seed?.e ?? 0 }),
              unitPair: SEED_UNIT_PAIR,
              method: period.method,
              effectiveFrom: period.validFrom,
              effectiveTo: period.validTo,
              author: SEED_CURATOR,
              // The fixture publishes both periods as in-force history: the
              // closed 2019 period is already superseded by its successor,
              // the open 2026 period is the current approved curve. Approval
              // evidence is retained either way (the effective instant
              // doubles as the assumed approval instant).
              approvalState: period.validTo === null ? 'approved' : 'superseded',
              approvedBy: SEED_CURATOR,
              approvedAt: period.validFrom,
              provenance,
              version: index + 1,
              createdAt: period.validFrom,
              supersededAt: period.validTo,
            } satisfies RatingCurveVersion),
          );
        });
    }
  }

  // --- ledgers ----------------------------------------------------------------
  const computedValues: ComputedValue[] = [];
  const auditEvents: CurveAuditEvent[] = [];
  const outboxEvents: CurveOutboxEvent[] = [];
  let sequence = 0;

  function nextId(prefix: string): string {
    sequence += 1;
    return `${prefix}-${String(1000 + sequence)}`;
  }

  function emit(
    action: CurveAuditEvent['action'],
    actorId: string,
    stationId: string,
    streamId: string,
    versionId: string,
    supersededVersionId: string | null,
    beforeState: ApprovalState | null,
    afterState: ApprovalState,
    now: string,
  ): { auditEvent: CurveAuditEvent; outboxEvent: CurveOutboxEvent } {
    const correlationId = nextId('corr');
    const auditEvent = freeze({
      id: nextId('curve-audit'),
      action,
      actorId,
      stationId,
      streamId,
      versionId,
      supersededVersionId,
      beforeState,
      afterState,
      recordedAt: now,
      correlationId,
    } satisfies CurveAuditEvent);
    auditEvents.push(auditEvent);
    const outboxEvent = freeze({
      id: nextId('curve-outbox'),
      type: action.endsWith('curve') ? 'rating-curve-published' : 'rating-shift-published',
      streamId,
      versionId,
      recordedAt: now,
      correlationId,
    } satisfies CurveOutboxEvent);
    outboxEvents.push(outboxEvent);
    return { auditEvent, outboxEvent };
  }

  const store: RatingCurveStore = {
    world,

    streamById(streamId) {
      return streams.get(streamId) ?? null;
    },

    curveVersionsOf(streamId) {
      return Object.freeze([...(curves.get(streamId) ?? [])]);
    },
    curveVersionById(versionId) {
      for (const list of curves.values()) {
        const found = list.find((version) => version.id === versionId);
        if (found) return found;
      }
      return null;
    },
    openCurveVersion(streamId) {
      const list = curves.get(streamId) ?? [];
      return list.find((version) => version.effectiveTo === null) ?? null;
    },
    curvesCovering(streamId, at) {
      return (curves.get(streamId) ?? []).filter((version) => intervalCovers(version.effectiveFrom, version.effectiveTo, at));
    },
    approvedCurveAt(streamId, at) {
      return (curves.get(streamId) ?? []).find(
        (version) =>
          version.approvedAt !== null &&
          (version.approvalState === 'approved' || version.approvalState === 'superseded') &&
          intervalCovers(version.effectiveFrom, version.effectiveTo, at),
      ) ?? null;
    },

    shiftVersionsOf(streamId) {
      return Object.freeze([...(shifts.get(streamId) ?? [])]);
    },
    shiftVersionById(versionId) {
      for (const list of shifts.values()) {
        const found = list.find((shift) => shift.id === versionId);
        if (found) return found;
      }
      return null;
    },
    openShiftVersion(streamId) {
      const list = shifts.get(streamId) ?? [];
      return list.find((shift) => shift.effectiveTo === null) ?? null;
    },
    shiftsCovering(streamId, at) {
      return (shifts.get(streamId) ?? []).filter((shift) => intervalCovers(shift.effectiveFrom, shift.effectiveTo, at));
    },
    approvedShiftAt(streamId, at) {
      return (shifts.get(streamId) ?? []).find(
        (shift) =>
          shift.approvedAt !== null &&
          (shift.approvalState === 'approved' || shift.approvalState === 'superseded') &&
          intervalCovers(shift.effectiveFrom, shift.effectiveTo, at),
      ) ?? null;
    },

    get computedValues() {
      return Object.freeze([...computedValues]);
    },
    get auditEvents() {
      return Object.freeze([...auditEvents]);
    },
    get outboxEvents() {
      return Object.freeze([...outboxEvents]);
    },

    appendCurveVersion(request) {
      const list = curves.get(request.streamId);
      if (!list) throw new Error(`appendCurveVersion: unknown stream "${request.streamId}"`);
      const current = list.find((version) => version.effectiveTo === null) ?? null;
      let supersededVersionId: string | null = null;
      if (request.closeCurrentAt !== null && current) {
        const index = list.indexOf(current);
        list[index] = freeze({
          ...current,
          effectiveTo: request.closeCurrentAt,
          approvalState: 'superseded',
          supersededAt: request.closeCurrentAt,
        } satisfies RatingCurveVersion);
        supersededVersionId = current.id;
      }
      const version = freeze({
        ...request.version,
        id: nextId('rcv'),
        version: list.length + 1,
        createdAt: request.now,
        supersededAt: null,
      } satisfies RatingCurveVersion);
      list.push(version);
      const emitted = emit(
        request.action,
        request.actorId,
        request.stationId,
        request.streamId,
        version.id,
        supersededVersionId,
        current ? current.approvalState : null,
        version.approvalState,
        request.now,
      );
      return { version, ...emitted };
    },

    approveCurveVersion(request) {
      for (const list of curves.values()) {
        const index = list.findIndex((version) => version.id === request.versionId);
        if (index < 0) continue;
        const prior = list[index]!;
        if (prior.approvalState !== request.from) {
          throw new Error(`approveCurveVersion: ${request.versionId} is ${prior.approvalState}, expected ${request.from}`);
        }
        const version = freeze({
          ...prior,
          approvalState: request.to,
          approvedBy: request.to === 'approved' ? request.actorId : prior.approvedBy,
          approvedAt: request.to === 'approved' ? request.now : prior.approvedAt,
        } satisfies RatingCurveVersion);
        list[index] = version;
        const emitted = emit(
          'approve-curve',
          request.actorId,
          version.stationId,
          version.streamId,
          version.id,
          null,
          request.from,
          request.to,
          request.now,
        );
        return { version, ...emitted };
      }
      throw new Error(`approveCurveVersion: unknown version "${request.versionId}"`);
    },

    appendShiftVersion(request) {
      const list = shifts.get(request.streamId);
      if (!list) throw new Error(`appendShiftVersion: unknown stream "${request.shift?.streamId ?? request.streamId}"`);
      const current = list.find((shift) => shift.effectiveTo === null) ?? null;
      let supersededVersionId: string | null = null;
      if (request.closeCurrentAt !== null && current) {
        const index = list.indexOf(current);
        list[index] = freeze({
          ...current,
          effectiveTo: request.closeCurrentAt,
          approvalState: 'superseded',
          supersededAt: request.closeCurrentAt,
        } satisfies RatingShift);
        supersededVersionId = current.id;
      }
      const shift = freeze({
        ...request.shift,
        segments: freeze([...request.shift.segments.map((segment) => freeze({ ...segment } as ShiftSegment))]),
        id: nextId('shf'),
        version: list.length + 1,
        createdAt: request.now,
        supersededAt: null,
      } satisfies RatingShift);
      list.push(shift);
      const emitted = emit(
        request.action,
        request.actorId,
        request.stationId,
        request.streamId,
        shift.id,
        supersededVersionId,
        current ? current.approvalState : null,
        shift.approvalState,
        request.now,
      );
      return { shift, ...emitted };
    },

    approveShiftVersion(request) {
      for (const list of shifts.values()) {
        const index = list.findIndex((shift) => shift.id === request.versionId);
        if (index < 0) continue;
        const prior = list[index]!;
        if (prior.approvalState !== request.from) {
          throw new Error(`approveShiftVersion: ${request.versionId} is ${prior.approvalState}, expected ${request.from}`);
        }
        const shift = freeze({
          ...prior,
          approvalState: request.to,
          approvedBy: request.to === 'approved' ? request.actorId : prior.approvedBy,
          approvedAt: request.to === 'approved' ? request.now : prior.approvedAt,
        } satisfies RatingShift);
        list[index] = shift;
        const emitted = emit(
          'approve-shift',
          request.actorId,
          shift.stationId,
          shift.streamId,
          shift.id,
          null,
          request.from,
          request.to,
          request.now,
        );
        return { shift, ...emitted };
      }
      throw new Error(`approveShiftVersion: unknown version "${request.versionId}"`);
    },

    appendComputed(value) {
      const entry = freeze({ ...value } satisfies ComputedValue);
      computedValues.push(entry);
      return entry;
    },
  };

  return store;
}
