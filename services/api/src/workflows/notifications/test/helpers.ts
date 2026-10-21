/**
 * Shared fixture world and clock helpers for the WD-015 notification suites
 * (mirrors the WD-013 QC helpers: frozen contract fixtures + the Weber
 * engineer Nina so cross-system denial is a genuine DENY_OUT_OF_SCOPE).
 */
import { readFileSync } from 'node:fs';
import { buildWorld, withEntitlement, withPrincipal, type PolicyWorld } from '../../../../../../packages/policy/src/index.ts';
import { systemObjects } from '../../stewardship/connections.ts';
import { createDeliveryRecorder } from '../types.ts';

export const DIEGO = 'principal-diego-steward';
export const FATIMA = 'principal-fatima-engineer';
export const PRIYA = 'principal-priya-engineer';
export const CODY = 'principal-cody-commissioner';
export const ANA = 'principal-ana-deputy';
export const SARAH = 'principal-sarah-researcher';
export const NINA = 'principal-nina-engineer';

export const SYSTEM_BEAR = 'sys-bear-river';
export const SYSTEM_WEBER = 'sys-weber-river';

/** Fixed clock inside the fixture present (mirrors the QC/stewardship suites). */
export const NOW = '2026-03-10T14:00:00Z';

function read<T>(name: string): T {
  return JSON.parse(readFileSync(new URL('../../../../../../fixtures/contracts/' + name, import.meta.url), 'utf8')) as T;
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

/** A revocable world holder: the service re-reads the snapshot every build. */
export function worldHolder(initial: PolicyWorld = buildTestWorld()): { readonly world: () => PolicyWorld; replace(next: PolicyWorld): void } {
  let current = initial;
  return {
    world: () => current,
    replace(next) {
      current = next;
    },
  };
}

export const revoke = (world: PolicyWorld, entitlementId: string): PolicyWorld => withEntitlement(world, entitlementId, { status: 'revoked' });
export const deactivate = (world: PolicyWorld, principalId: string): PolicyWorld => withPrincipal(world, principalId, { active: false });

/** Deterministic fixed clock (one reading per instant). */
export const fixedClock = (at: string): (() => string) => () => at;

/** Deterministic advancing clock: start at `startMs`, tick by whole minutes. */
export function advancingClock(startMs: number): { readonly clock: () => string; readonly advanceMinutes: (minutes: number) => void; readonly now: () => string } {
  let current = startMs;
  const iso = (): string => new Date(current).toISOString().replace('.000Z', 'Z');
  return {
    clock: iso,
    advanceMinutes: (minutes) => {
      current += minutes * 60_000;
    },
    now: iso,
  };
}

/** A fresh simulated channel + a service deps bundle over a world holder. */
export function testDeps(world: () => PolicyWorld, clock: () => Date | string) {
  const channel = createDeliveryRecorder();
  return { deps: { world, clock, channel }, channel } as const;
}

/** Event factory with server-side anchors (ids are the dedupe keys). */
export function event(input: {
  readonly id: string;
  readonly type: 'new-site' | 'site-edit' | 'no-signal' | 'threshold';
  readonly objectKind?: 'station' | 'datastream';
  readonly objectId: string;
  readonly systemId: string;
  readonly streamId?: string | null;
  readonly occurredAt: string;
  readonly summary?: string;
}) {
  return {
    id: input.id,
    type: input.type,
    objectKind: input.objectKind ?? (input.streamId !== undefined && input.streamId !== null ? 'datastream' : 'station'),
    objectId: input.objectId,
    systemId: input.systemId,
    streamId: input.streamId ?? null,
    occurredAt: input.occurredAt,
    summary: input.summary ?? `${input.type} on ${input.objectId}`,
  };
}
