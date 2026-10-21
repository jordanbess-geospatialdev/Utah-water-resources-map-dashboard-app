/**
 * Shared synthetic world/config builders for the WD-005 gateway tests.
 *
 * EVERY sample in this suite is SYNTHETIC (authored fixtures under
 * test/fixtures/ + inline responses). Nothing here is a capture from a real
 * NeoServer; live capture is the qualification harness under
 * infra/neoserver/qualification/ (pending a Docker daemon).
 */
import { readFileSync } from 'node:fs';
import { buildWorld, type PolicyWorld, type Principal, type RawEntitlement } from '../../../packages/policy/src/index.ts';
import type { GatewayConfig } from '../src/gateway.ts';

export const readFixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

export const readFixtureJson = <T>(name: string): T => JSON.parse(readFixture(name)) as T;

/** Injected clock shared with the WD-004 suite: inside every fixture grant's validity window. */
export const FIXED_NOW = '2026-05-15T12:00:00Z';

/**
 * The frozen contract fixture world plus one synthesized cohort member:
 * wiley-a, owner of org-cache-water (which owns sta-hyrum-diversion-owner),
 * carrying view-restricted-details - the entitlement the water-bear-cohort
 * workspace's guard object requires.
 */
export function world(): PolicyWorld {
  const principalsFixture = JSON.parse(
    readFileSync(new URL('../../../fixtures/contracts/principals.json', import.meta.url), 'utf8'),
  ) as object;
  const stationsFixture = JSON.parse(
    readFileSync(new URL('../../../fixtures/contracts/stations.json', import.meta.url), 'utf8'),
  ) as object;
  const wileyA: Principal = {
    id: 'wiley-a',
    displayName: 'Wiley Barnes (Cache owner, SYNTHETIC cohort member)',
    roles: ['water-user', 'owner'],
    active: true,
    assignedSystemId: null,
  };
  const ownerEntitlement: RawEntitlement = {
    id: 'ent-owner-wiley-a',
    principalId: 'wiley-a',
    role: 'owner',
    capabilities: ['view-restricted-details', 'manage-own-preferences', 'manage-own-tokens'],
    scopeType: 'organization',
    scopeId: 'org-cache-water',
    effectiveAt: '2025-07-01T00:00:00Z',
    expiresAt: null,
    status: 'active',
    delegation: null,
    grantedBy: 'principal-diego-steward',
    grantVersion: 2,
  };
  return buildWorld({
    principals: principalsFixture as never,
    stations: stationsFixture as never,
    extraPrincipals: [wileyA],
    extraEntitlements: [ownerEntitlement],
  });
}

export const WILEY_A: Principal = {
  id: 'wiley-a',
  displayName: 'Wiley Barnes (Cache owner, SYNTHETIC cohort member)',
  roles: ['water-user', 'owner'],
  active: true,
  assignedSystemId: null,
};

export const TRUSTED_BASE = 'http://neo.internal:9000';
export const GATEWAY_ORIGIN = 'https://portal.example.utah.gov';
export const PUBLIC_SERVICE_KEY = 'synthetic-server-held-narrow-key-public';
export const COHORT_SERVICE_KEY = 'synthetic-server-held-narrow-key-cohort';

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

export function recordingFetch(
  calls: RecordedCall[],
  respond: (url: URL) => Response,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = init?.headers;
    calls.push({
      url: url.toString(),
      headers: Object.fromEntries(headers instanceof Headers ? headers.entries() : Object.entries((headers ?? {}) as Record<string, string>)),
    });
    return respond(url);
  }) as unknown as typeof fetch;
}

export function gatewayConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    trustedBase: TRUSTED_BASE,
    gatewayOrigin: GATEWAY_ORIGIN,
    gatewayPrefix: '/geo',
    worldLoader: world,
    resolveSecret: (ref: string) =>
      ref.includes('water-public') ? PUBLIC_SERVICE_KEY : ref.includes('water-bear-cohort') ? COHORT_SERVICE_KEY : undefined,
    now: () => new Date(FIXED_NOW),
    maxResponseBytes: 64 * 1024,
    timeoutMs: 2_000,
    publicCacheSeconds: 300,
    ...overrides,
  };
}

/** Utah control envelope (generous statewide box) used by the axis/swap checks. */
export const UTAH_LON = [-114.1, -108.9] as const;
export const UTAH_LAT = [37.0, 42.1] as const;
