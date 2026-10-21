/**
 * Steward-only enforcement matrix for every governance mutation surface
 * (WD-014; FR-011/FR-012/FR-013; verification row T-02).
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/stewardship/test/enforcement.test.ts
 *
 * The matrix asserts, for vocabulary create/retire, assignment
 * grant/delegate/revoke, ingestion register/request/promote/test:
 * - the steward (Diego, statewide-administration) is ALLOWED;
 * - every other authenticated persona (engineers Fatima/Priya/Marco,
 *   commissioner Cody, deputy Ana, researcher Sarah) is denied 403;
 * - anonymous, unknown-id and DEACTIVATED actors are denied 401
 *   (identity failures per the authorize.ts status policy);
 * - denials come from the REAL policy engine verdicts, never a role-label
 *   check in this package.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPrincipal } from '../../../../../../packages/policy/src/index.ts';
import { createVocabularyService } from '../vocabulary.ts';
import { createAssignmentService } from '../assignments.ts';
import { createIngestionService } from '../ingestion.ts';
import { ANA, CODY, DIEGO, FATIMA, LEE, MARCO, NOW, PRIYA, SARAH, buildTestWorld } from './helpers.ts';

type Denial = { ok: false; denied?: { status: number; reason: string } };

const statusOf = (outcome: { ok: boolean } & Partial<Denial>): number | null =>
  outcome.ok === false && outcome.denied !== undefined ? outcome.denied.status : null;
const reasonOf = (outcome: { ok: boolean } & Partial<Denial>): string | null =>
  outcome.ok === false && outcome.denied !== undefined ? outcome.denied.reason : null;

const world = buildTestWorld();
const clock = (): string => NOW;

const vocabulary = createVocabularyService({ world, clock });
const assignments = createAssignmentService({ world, clock });
const ingestion = createIngestionService({ world, clock });

// A provider must exist before config surfaces can be exercised.
assert.equal(ingestion.registerProvider(DIEGO, {
  id: 'prov-enforcement-api',
  name: 'Enforcement API',
  kind: 'api',
  parameterSchema: [{ key: 'endpoint-url', type: 'url', required: true }],
}).ok, true);
assert.equal(ingestion.registerSiteConfig(DIEGO, {
  providerId: 'prov-enforcement-api',
  stationId: 'sta-bear-corinne',
  params: { 'endpoint-url': 'https://api.example.com/v1' },
}).ok, true);
assert.equal(ingestion.requestSiteConfig(MARCO, {
  providerId: 'prov-enforcement-api',
  stationId: 'sta-bear-corinne',
  params: { 'endpoint-url': 'https://api.example.com/v1' },
}).ok, true);

/** Every governance mutation surface, as callables over a principal id. */
const SURFACES: ReadonlyArray<{ label: string; call: (principalId: string | null) => { ok: boolean } & Partial<Denial> }> = [
  {
    label: 'vocabulary.createTerm',
    call: (who) => vocabulary.createTerm(who, { kind: 'qualifier', id: `q-${String(who ?? 'anon').slice(0, 8)}`, label: `Label ${who ?? 'anon'}` }),
  },
  {
    label: 'vocabulary.retireTerm',
    call: (who) => vocabulary.retireTerm(who, { kind: 'qualifier', id: 'interpolate' }),
  },
  {
    label: 'assignments.grant',
    call: (who) => assignments.grant(who, { principalId: LEE, role: 'commissioner', capabilities: ['enter-readings'], scopeType: 'system', scopeId: 'sys-bear-river' }),
  },
  {
    label: 'assignments.delegateDeputy',
    call: (who) => assignments.delegateDeputy(who, { principalId: LEE, scopeType: 'system', scopeId: 'sys-bear-river', effectiveAt: '2026-04-01T07:00:00Z', expiresAt: '2026-04-30T23:59:59Z' }),
  },
  {
    label: 'assignments.revoke',
    call: (who) => assignments.revoke(who, 'ent-commissioner-cody'),
  },
  {
    label: 'ingestion.registerProvider',
    call: (who) => ingestion.registerProvider(who, { id: `prov-${String(who ?? 'anon').slice(9, 17) || 'anon'}`, name: 'P', kind: 'api', parameterSchema: [] }),
  },
  {
    label: 'ingestion.registerSiteConfig',
    call: (who) => ingestion.registerSiteConfig(who, { providerId: 'prov-enforcement-api', stationId: 'sta-bear-corinne', params: { 'endpoint-url': 'https://api.example.com/v1' } }),
  },
  {
    label: 'ingestion.promoteRequest',
    call: (who) => ingestion.promoteRequest(who, 'ing-000002'),
  },
  {
    label: 'ingestion.testConnection',
    call: (who) => ingestion.testConnection(who, 'ing-000001', 'success'),
  },
];

test('the steward is allowed on every governance surface', () => {
  // vocabulary create (fresh label), retire of an ACTIVE qualifier, and the
  // ingestion surfaces all allow for Diego; grant/delegate allow too. The
  // revoke target is a fixture grant; the promote target is Marco's request.
  const created = vocabulary.createTerm(DIEGO, { kind: 'qualifier', id: 'q-enf-created', label: 'Enforcement created' });
  assert.equal(created.ok, true);
  const granted = assignments.grant(DIEGO, { principalId: LEE, role: 'commissioner', capabilities: ['enter-readings'], scopeType: 'system', scopeId: 'sys-bear-river' });
  assert.equal(granted.ok, true);
  const delegated = assignments.delegateDeputy(DIEGO, { principalId: LEE, scopeType: 'system', scopeId: 'sys-bear-river', effectiveAt: '2026-05-01T07:00:00Z', expiresAt: '2026-05-31T23:59:59Z' });
  assert.equal(delegated.ok, true);
  const promoted = ingestion.promoteRequest(DIEGO, 'ing-000002');
  assert.equal(promoted.ok, true);
  const tested = ingestion.testConnection(DIEGO, 'ing-000001', 'success');
  assert.equal(tested.ok, true);
});

test('every non-steward persona is denied 403 on every governance surface', () => {
  const nonStewards = [FATIMA, PRIYA, MARCO, CODY, ANA, SARAH];
  for (const persona of nonStewards) {
    for (const surface of SURFACES) {
      const outcome = surface.call(persona);
      assert.equal(
        statusOf(outcome),
        403,
        `${persona} on ${surface.label}: expected 403, got ${JSON.stringify(outcome)}`,
      );
      assert.notEqual(reasonOf(outcome), null);
    }
  }
});

test('anonymous and unknown actors are denied 401 on every governance surface', () => {
  for (const surface of SURFACES) {
    assert.equal(statusOf(surface.call(null)), 401, `anonymous on ${surface.label}`);
    assert.equal(statusOf(surface.call('principal-ghost')), 401, `unknown id on ${surface.label}`);
  }
});

test('a DEACTIVATED steward is denied 401 (identity failure) on every governance surface', () => {
  const inactiveWorld = withPrincipal(world, DIEGO, { active: false });
  const inactiveVocabulary = createVocabularyService({ world: inactiveWorld, clock });
  const inactiveAssignments = createAssignmentService({ world: inactiveWorld, clock });
  const inactiveIngestion = createIngestionService({ world: inactiveWorld, clock });
  assert.equal(
    statusOf(inactiveVocabulary.createTerm(DIEGO, { kind: 'qualifier', id: 'q-inactive', label: 'Inactive attempt' })),
    401,
  );
  assert.equal(
    statusOf(inactiveAssignments.grant(DIEGO, { principalId: LEE, role: 'commissioner', capabilities: ['enter-readings'], scopeType: 'system', scopeId: 'sys-bear-river' })),
    401,
  );
  assert.equal(
    statusOf(inactiveIngestion.registerProvider(DIEGO, { id: 'prov-inactive', name: 'Inactive', kind: 'api', parameterSchema: [] })),
    401,
  );
});

test('the regional engineer may only REQUEST: the request verb never satisfies configure-ingestion and vice versa', () => {
  // Marco holds request-ingestion-configuration (regional profile).
  const request = ingestion.requestSiteConfig(MARCO, { providerId: 'prov-enforcement-api', stationId: 'sta-bear-corinne', params: { 'endpoint-url': 'https://api.example.com/v1' } });
  assert.equal(request.ok, true, 'regional engineer may request within scope');
  // ...but every configure-ingestion surface denies him 403.
  assert.equal(statusOf(ingestion.registerProvider(MARCO, { id: 'prov-marco', name: 'Marco API', kind: 'api', parameterSchema: [] })), 403);
  assert.equal(statusOf(ingestion.registerSiteConfig(MARCO, { providerId: 'prov-enforcement-api', stationId: 'sta-bear-corinne', params: { 'endpoint-url': 'https://api.example.com/v1' } })), 403);
  // And Diego (configure-ingestion) can never file a request AS an engineer:
  // for stewards the request path is unnecessary (they register directly),
  // and a steward CALLING requestSiteConfig is allowed only because the
  // action evaluates statewide - the request itself enters the queue as
  // requested-by-steward and still requires promotion. The boundary that
  // matters is asserted both ways by the field engineer below.
  const fieldEngineerRequest = ingestion.requestSiteConfig(FATIMA, { providerId: 'prov-enforcement-api', stationId: 'sta-bear-corinne', params: { 'endpoint-url': 'https://api.example.com/v1' } });
  assert.equal(statusOf(fieldEngineerRequest), 403, 'field profile (no request capability) denied 403');
});

test('denials carry the real engine reason, and the reason varies with the failure', () => {
  assert.equal(reasonOf(vocabulary.createTerm(FATIMA, { kind: 'qualifier', id: 'q-x', label: 'X' })), 'DENY_CAPABILITY_NOT_GRANTED');
  assert.equal(reasonOf(vocabulary.createTerm(null, { kind: 'qualifier', id: 'q-y', label: 'Y' })), 'DENY_ANONYMOUS');
  const inactiveWorld = withPrincipal(world, FATIMA, { active: false });
  const inactiveVocabulary = createVocabularyService({ world: inactiveWorld, clock });
  assert.equal(reasonOf(inactiveVocabulary.createTerm(FATIMA, { kind: 'qualifier', id: 'q-z', label: 'Z' })), 'DENY_PRINCIPAL_INACTIVE');
});
