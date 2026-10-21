/**
 * Provider/site ingestion configuration tests (WD-014; FR-013;
 * verification rows T-02/T-03): typed parameter validation (unknown
 * parameters rejected), the engineer-REQUEST vs steward-PROMOTE ownership
 * boundary, the SIMULATED staging connection test with injectable failure
 * modes, secret redaction, and determinism.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/stewardship/test/ingestion.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngestionService, scriptedTransport, validateParameters, validateProviderSchema, type IngestionService } from '../ingestion.ts';
import { DIEGO, FATIMA, MARCO, NOW, PRIYA, buildTestWorld } from './helpers.ts';

const world = buildTestWorld();
const clock = (): string => NOW;

const API_SCHEMA = [
  { key: 'endpoint-url', type: 'url' as const, required: true, description: 'Provider REST endpoint' },
  { key: 'api-key', type: 'secret' as const, required: true },
  { key: 'poll-seconds', type: 'number' as const, required: false },
];

function service(): IngestionService {
  const svc = createIngestionService({ world, clock });
  const provider = svc.registerProvider(DIEGO, { id: 'prov-api-x', name: 'Cooperator API X', kind: 'api', parameterSchema: API_SCHEMA });
  assert.ok(provider.ok, JSON.stringify(provider));
  return svc;
}

const GOOD_PARAMS = { 'endpoint-url': 'https://api.example.com/v1/telemetry', 'api-key': 'tok-abc123', 'poll-seconds': '300' };

test('provider registration validates the typed parameter schema', () => {
  assert.deepEqual(
    validateProviderSchema({ id: 'Bad', name: '', kind: 'satellite', parameterSchema: [
      { key: 'Bad_Key', type: 'string', required: true },
      { key: 'dup', type: 'string', required: true },
      { key: 'dup', type: 'string', required: false },
      { key: 'ok-key', type: 'carrier-pigeon' as 'string', required: false },
      { key: 'regex-key', type: 'string', required: false, pattern: '[' },
    ] }),
    ['bad-provider-id', 'bad-provider-name', 'unknown-provider-kind', 'bad-parameter-key', 'duplicate-parameter-key', 'unknown-parameter-type', 'bad-parameter-pattern'],
  );
  const svc = service();
  const duplicateProvider = svc.registerProvider(DIEGO, { id: 'prov-api-x', name: 'Duplicate', kind: 'api', parameterSchema: [] });
  assert.ok(!duplicateProvider.ok && 'errors' in duplicateProvider);
  assert.deepEqual(duplicateProvider.errors, ['bad-provider-id']);
});

test('parameter validation: unknown parameters are rejected; required, types and URL shapes enforced', () => {
  assert.deepEqual(validateParameters(API_SCHEMA, GOOD_PARAMS), []);
  assert.deepEqual(
    validateParameters(API_SCHEMA, { ...GOOD_PARAMS, bogus: 'x' }),
    [{ code: 'unknown-parameter', key: 'bogus' }],
  );
  assert.deepEqual(
    validateParameters(API_SCHEMA, { 'api-key': 'tok', 'poll-seconds': '10' }),
    [{ code: 'missing-parameter', key: 'endpoint-url' }],
  );
  assert.deepEqual(
    validateParameters(API_SCHEMA, { ...GOOD_PARAMS, 'poll-seconds': 'fast' }),
    [{ code: 'bad-parameter-type', key: 'poll-seconds' }],
  );
  assert.deepEqual(
    validateParameters(API_SCHEMA, { ...GOOD_PARAMS, 'endpoint-url': 'http://api.example.com/v1' }),
    [{ code: 'bad-parameter-value', key: 'endpoint-url' }],
  );
  // Credentials must never travel in URLs (userinfo is rejected).
  assert.deepEqual(
    validateParameters(API_SCHEMA, { ...GOOD_PARAMS, 'endpoint-url': 'https://user:pass@api.example.com/v1' }),
    [{ code: 'bad-parameter-value', key: 'endpoint-url' }],
  );
});

test('site configuration resolves the system SERVER-SIDE from the station object (never from the body)', () => {
  const svc = service();
  const registered = svc.registerSiteConfig(DIEGO, { providerId: 'prov-api-x', stationId: 'sta-bear-corinne', params: GOOD_PARAMS });
  assert.ok(registered.ok);
  assert.equal(registered.view.config.systemId, 'sys-bear-river');
  assert.equal(registered.view.config.status, 'configured'); // steward registration is effective immediately
  const unknownStation = svc.registerSiteConfig(DIEGO, { providerId: 'prov-api-x', stationId: 'sta-ghost', params: GOOD_PARAMS });
  assert.ok(!unknownStation.ok && 'errors' in unknownStation);
  assert.deepEqual(unknownStation.errors, ['unknown-station']);
  const unknownProvider = svc.registerSiteConfig(DIEGO, { providerId: 'prov-ghost', stationId: 'sta-bear-corinne', params: GOOD_PARAMS });
  assert.ok(!unknownProvider.ok && 'errors' in unknownProvider);
  assert.deepEqual(unknownProvider.errors, ['unknown-provider']);
  const badParams = svc.registerSiteConfig(DIEGO, { providerId: 'prov-api-x', stationId: 'sta-bear-corinne', params: { 'api-key': 'tok' } });
  assert.ok(!badParams.ok && 'errors' in badParams);
  assert.deepEqual(badParams.errors, ['missing-parameter'], 'endpoint-url required');
});

test('FR-013 ownership boundary: engineer requests enter REQUEST state; only a steward can promote', () => {
  const svc = service();
  // Marco (regional profile, request-ingestion-configuration, Bear scope).
  const request = svc.requestSiteConfig(MARCO, { providerId: 'prov-api-x', stationId: 'sta-bear-corinne', params: GOOD_PARAMS });
  assert.ok(request.ok, JSON.stringify(request));
  assert.equal(request.view.config.status, 'requested');
  assert.equal(request.view.config.requestedBy, MARCO);
  assert.equal(request.view.config.promotedBy, null);
  const requestId = request.view.config.id;

  // The engineer queue shows exactly the pending request.
  assert.deepEqual(svc.pendingRequests().map((view) => view.config.id), [requestId]);

  // Marco cannot promote his own request (or anyone else's).
  const selfPromote = svc.promoteRequest(MARCO, requestId);
  assert.ok(!selfPromote.ok && 'denied' in selfPromote);
  assert.equal(selfPromote.denied.status, 403);
  assert.equal(selfPromote.denied.reason, 'DENY_CAPABILITY_NOT_GRANTED', 'request-ingestion-configuration never satisfies configure-ingestion');

  // Marco cannot register a configuration directly either (bypass attempt).
  const bypass = svc.registerSiteConfig(MARCO, { providerId: 'prov-api-x', stationId: 'sta-bear-corinne', params: GOOD_PARAMS });
  assert.ok(!bypass.ok && 'denied' in bypass);
  assert.equal(bypass.denied.status, 403);

  // A steward promotes; the request leaves the queue.
  const promoted = svc.promoteRequest(DIEGO, requestId);
  assert.ok(promoted.ok);
  assert.equal(promoted.view.config.status, 'configured');
  assert.equal(promoted.view.config.promotedBy, DIEGO);
  assert.equal(promoted.view.config.promotedAt, NOW);
  assert.deepEqual(svc.pendingRequests(), []);

  // Promoting again is refused.
  const again = svc.promoteRequest(DIEGO, requestId);
  assert.ok(!again.ok && 'errors' in again);
  assert.deepEqual(again.errors, ['already-configured']);
});

test('engineer requests are scope-bound: out-of-scope stations and capability-less engineers are denied', () => {
  const svc = service();
  // Marco is Bear-scoped: the Weber station is out of his assignment scope.
  const outOfScope = svc.requestSiteConfig(MARCO, { providerId: 'prov-api-x', stationId: 'sta-ogden-valley-proposed', params: GOOD_PARAMS });
  assert.ok(!outOfScope.ok && 'denied' in outOfScope);
  assert.equal(outOfScope.denied.status, 403);
  assert.equal(outOfScope.denied.reason, 'DENY_OUT_OF_SCOPE');
  // Fatima (field profile) and Priya hold NO request-ingestion-configuration:
  // only the regional engineer profile carries the request verb.
  const noCapability = svc.requestSiteConfig(FATIMA, { providerId: 'prov-api-x', stationId: 'sta-bear-corinne', params: GOOD_PARAMS });
  assert.ok(!noCapability.ok && 'denied' in noCapability);
  assert.equal(noCapability.denied.status, 403);
  assert.equal(noCapability.denied.reason, 'DENY_CAPABILITY_NOT_GRANTED');
  assert.equal(
    (svc.requestSiteConfig(PRIYA, { providerId: 'prov-api-x', stationId: 'sta-ogden-valley-proposed', params: GOOD_PARAMS }) as { denied?: { reason: string } }).denied?.reason,
    'DENY_CAPABILITY_NOT_GRANTED',
    'even an in-scope station cannot be requested without the regional verb',
  );
  // Nothing entered the queue from the denials.
  assert.deepEqual(svc.pendingRequests(), []);
});

test('staging connection TEST is simulated with injectable failure modes and records status + timestamp', () => {
  const transport = scriptedTransport({
    success: { outcome: 'success', latencyMs: 137 },
    'auth-failure': { outcome: 'auth-failure', latencyMs: 41 },
    timeout: { outcome: 'timeout', latencyMs: 5000 },
  });
  const svc = createIngestionService({ world, clock, transport });
  assert.ok(svc.registerProvider(DIEGO, { id: 'prov-api-x', name: 'Cooperator API X', kind: 'api', parameterSchema: API_SCHEMA }).ok);
  const config = svc.registerSiteConfig(DIEGO, { providerId: 'prov-api-x', stationId: 'sta-bear-corinne', params: GOOD_PARAMS });
  assert.ok(config.ok);
  const id = config.view.config.id;
  assert.equal(config.view.config.lastConnectionTest, null, 'untested before the first staging test');

  const success = svc.testConnection(DIEGO, id, 'success');
  assert.ok(success.ok);
  assert.deepEqual(success.view.config.lastConnectionTest, { at: NOW, outcome: 'success', latencyMs: 137 });

  const auth = svc.testConnection(DIEGO, id, 'auth-failure');
  assert.ok(auth.ok);
  assert.equal(auth.view.config.lastConnectionTest!.outcome, 'auth-failure');
  assert.equal(auth.view.config.lastConnectionTest!.at, NOW, 'the outcome is recorded WITH a timestamp');

  const timeout = svc.testConnection(DIEGO, id, 'timeout');
  assert.ok(timeout.ok);
  assert.equal(timeout.view.config.lastConnectionTest!.outcome, 'timeout');
  assert.equal(timeout.view.config.lastConnectionTest!.latencyMs, 5000);

  // The transport receives the provider id and parameters (the simulated
  // handshake), and there is no code path that touches a real network.
  let seen: { providerId: string; params: Record<string, string> } | null = null;
  const spyTransport = (input: { providerId: string; params: Record<string, string> }): { outcome: 'success'; latencyMs: number } => {
    seen = input;
    return { outcome: 'success', latencyMs: 1 };
  };
  const spyService = createIngestionService({ world, clock, transport: spyTransport });
  assert.ok(spyService.registerProvider(DIEGO, { id: 'prov-api-x', name: 'X', kind: 'api', parameterSchema: API_SCHEMA }).ok);
  assert.ok(spyService.registerSiteConfig(DIEGO, { providerId: 'prov-api-x', stationId: 'sta-bear-corinne', params: GOOD_PARAMS }).ok);
  assert.ok(spyService.testConnection(DIEGO, 'ing-000001', 'success').ok);
  assert.notEqual(seen, null);
  assert.equal(seen!.providerId, 'prov-api-x');
  assert.equal(seen!.params['api-key'], 'tok-abc123');

  // Staging tests on a still-requested configuration work (that is the
  // point of staging) - but only for stewards.
  const requested = svc.requestSiteConfig(MARCO, { providerId: 'prov-api-x', stationId: 'sta-hyrum-diversion-public', params: GOOD_PARAMS });
  assert.ok(requested.ok);
  const staged = svc.testConnection(DIEGO, requested.view.config.id, 'timeout');
  assert.ok(staged.ok);
  assert.equal(staged.view.config.status, 'requested', 'a staging test does not promote');
});

test('secrets are never echoed or serialized in clear', () => {
  const svc = service();
  const config = svc.registerSiteConfig(DIEGO, { providerId: 'prov-api-x', stationId: 'sta-bear-corinne', params: GOOD_PARAMS });
  assert.ok(config.ok);
  assert.equal(config.view.safeParams['api-key'], '[redacted]');
  assert.equal(config.view.safeParams['endpoint-url'], GOOD_PARAMS['endpoint-url']);
  assert.equal(svc.config(config.view.config.id)!.safeParams['api-key'], '[redacted]');
  assert.ok(!svc.serialize().includes('tok-abc123'), 'the serialized store never contains the secret');
  assert.ok(!JSON.stringify(svc.configs()).includes('tok-abc123'));
});

test('every registry change appends an audit event with a version stamp', () => {
  const svc = service();
  assert.ok(svc.registerSiteConfig(DIEGO, { providerId: 'prov-api-x', stationId: 'sta-bear-corinne', params: GOOD_PARAMS }).ok);
  const requested = svc.requestSiteConfig(MARCO, { providerId: 'prov-api-x', stationId: 'sta-hyrum-diversion-public', params: GOOD_PARAMS });
  assert.ok(requested.ok);
  assert.ok(svc.promoteRequest(DIEGO, requested.view.config.id).ok);
  assert.ok(svc.testConnection(DIEGO, requested.view.config.id, 'success').ok);
  const actions = svc.changeLog().map((event) => event.action);
  // service() registered the provider; then: register-config, request-config, promote-request, connection-test.
  assert.deepEqual(actions, ['register-provider', 'register-config', 'request-config', 'promote-request', 'connection-test']);
  assert.ok(svc.changeLog().every((event) => event.registryVersion >= 1));
  assert.ok(svc.registryVersion() >= 4);
});

test('determinism: identical scenario run twice serializes byte-identically (no real network, injected clock)', () => {
  const scenario = (): string => {
    const transport = scriptedTransport({ success: { outcome: 'success', latencyMs: 100 }, 'auth-failure': { outcome: 'auth-failure', latencyMs: 50 }, timeout: { outcome: 'timeout', latencyMs: 5000 } });
    const svc = createIngestionService({ world, clock, transport });
    svc.registerProvider(DIEGO, { id: 'prov-api-x', name: 'Cooperator API X', kind: 'api', parameterSchema: API_SCHEMA });
    svc.registerSiteConfig(DIEGO, { providerId: 'prov-api-x', stationId: 'sta-bear-corinne', params: GOOD_PARAMS });
    svc.requestSiteConfig(MARCO, { providerId: 'prov-api-x', stationId: 'sta-hyrum-diversion-public', params: GOOD_PARAMS });
    svc.promoteRequest(DIEGO, 'ing-000002');
    svc.testConnection(DIEGO, 'ing-000001', 'timeout');
    return svc.serialize();
  };
  assert.equal(scenario(), scenario());
});
