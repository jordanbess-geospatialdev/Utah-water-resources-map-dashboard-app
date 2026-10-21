/**
 * Shared fixture world for the WD-014 stewardship suites.
 *
 * Frozen contract fixtures plus exactly two synthetic principals the
 * governance flows need beyond the fixture world:
 * - Lee, a deputy WITHOUT any fixture grant (delegation boundary instants
 *   must test the grant under inspection, not the seeded Ana grant);
 * - Marco, a regional-profile engineer holding request-ingestion-
 *   configuration (ENGINEER_PROFILES.regional) for the FR-013 request
 *   boundary - deliberately NOT configure-ingestion.
 */
import { readFileSync } from 'node:fs';
import { buildWorld, type PolicyWorld } from '../../../../../../packages/policy/src/index.ts';
import { systemObjects } from '../connections.ts';

export const DIEGO = 'principal-diego-steward';
export const FATIMA = 'principal-fatima-engineer';
export const PRIYA = 'principal-priya-engineer';
export const CODY = 'principal-cody-commissioner';
export const ANA = 'principal-ana-deputy';
export const SARAH = 'principal-sarah-researcher';
export const LEE = 'principal-lee-deputy';
export const MARCO = 'principal-marco-engineer';

/** Fixed clock inside the fixture present (mirrors FIXTURE_CLOCK). */
export const NOW = '2026-03-10T14:00:00Z';

function read<T>(name: string): T {
  return JSON.parse(readFileSync(new URL('../../../../../../fixtures/contracts/' + name, import.meta.url), 'utf8')) as T;
}

/** The fixture world with governance extras (systems anchored, Lee, Marco). */
export function buildTestWorld(): PolicyWorld {
  return buildWorld({
    principals: read('principals.json'),
    stations: read('stations.json'),
    extraObjects: [...systemObjects(['sys-bear-river', 'sys-weber-river'])],
    extraPrincipals: [
      { id: LEE, displayName: 'Lee Deputy', roles: ['deputy'], active: true, assignedSystemId: 'sys-bear-river' },
      { id: MARCO, displayName: 'Marco Regional', roles: ['engineer'], active: true, assignedSystemId: 'sys-bear-river' },
    ],
    extraEntitlements: [
      {
        id: 'ent-engineer-marco',
        principalId: MARCO,
        role: 'engineer',
        capabilities: ['enter-readings', 'edit-site-metadata', 'request-ingestion-configuration'],
        scopeType: 'system',
        scopeId: 'sys-bear-river',
        effectiveAt: '2026-01-01T00:00:00Z',
        expiresAt: null,
        status: 'active',
        delegation: null,
        grantedBy: DIEGO,
        grantVersion: 20,
      },
    ],
  });
}

/** Observation fixture rows (for the retired-qualifier history test). */
export function readObservations(): { observations: ReadonlyArray<{ id: string; logicalKey: string; qualifiers?: string[] }>; revisions: ReadonlyArray<{ id: string; qualifierIds?: string[]; targetObservationId: string }> } {
  return read('observations.json');
}
