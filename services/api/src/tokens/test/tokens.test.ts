/**
 * WD-016 scoped researcher credential tests (verification matrix rows T-03
 * API authorization - token scope/rotation - and the T-16 no-secrets rule;
 * requirement anchors FR-063/FR-064/FR-065/FR-066).
 *
 * Run (zero dependencies):
 *   cd services/api && node --test --experimental-strip-types src/tokens/test/tokens.test.ts
 *
 * Every clock input is an injected constant; secret and id generators are
 * injected where determinism matters (the DEFAULT generators stay
 * crypto-random). The final test replays the whole scenario twice and
 * compares the serialized store byte-for-byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withEntitlement, withPrincipal } from '../../../../../packages/policy/src/index.ts';
import { SECRET_PREFIX, generateSecret, hashSecret, isSecretFormat, verifySecret } from '../hash.ts';
import { authorizeScoped, scopeCoversQuery } from '../scopeEval.ts';
import { TokenService, TOKEN_LIFETIME, createTokenWorld } from '../tokens.ts';
import { TokenError, type TokenTraceEvent } from '../types.ts';

const SARAH = 'principal-sarah-researcher';
const CODY = 'principal-cody-commissioner';
const NOW = '2026-03-09T07:00:00Z'; // fixture clock (the DST morning after the outage)
const DAY = 24 * 60 * 60 * 1000;

const baseWorld = createTokenWorld();

/**
 * Only Sarah's fixture grant carries manage-own-tokens (matrix row 12: the
 * researcher's "approved scopes" cell; commissioners hold it as an OPTIONAL
 * scoped account). The restricted-stream tests model that option by extending
 * Cody's fixture grant with manage-own-tokens - authority still comes from a
 * grant, never a role label.
 */
const CODY_GRANT_PLUS_TOKENS = [
  'enter-readings',
  'revise-best-available',
  'review-data',
  'edit-permitted-site-fields',
  'generate-reports',
  'manage-own-tokens',
];
const codyWorld = withEntitlement(baseWorld, 'ent-commissioner-cody', { capabilities: CODY_GRANT_PLUS_TOKENS, grantVersion: 12 });
const sarahRevokedWorld = withEntitlement(baseWorld, 'ent-researcher-sarah', { status: 'revoked' });
const codyRevokedWorld = withEntitlement(codyWorld, 'ent-commissioner-cody', { status: 'revoked' });

/** Fixture clock the scenario advances deterministically. */
function stepClock(startMs: number, stepMs = 1000): { now: () => string; at: (offsetMs: number) => void } {
  let current = startMs;
  return {
    now: () => new Date((current += stepMs)).toISOString(),
    at: (offsetMs: number) => {
      current = startMs + offsetMs - stepMs; // the next now() then returns startMs + offsetMs exactly
    },
  };
}

function deterministicSecrets(): () => string {
  let n = 0;
  return () => `${SECRET_PREFIX}${String(n++).padStart(32, '0')}`; // uwdat_ + 32 digits
}

function deterministicSalts(): () => Buffer {
  let n = 0;
  return () => Buffer.alloc(16, (n += 1) & 0xff);
}

interface Harness {
  readonly service: TokenService;
  readonly clock: ReturnType<typeof stepClock>;
  readonly traces: TokenTraceEvent[];
  world: typeof baseWorld;
}

function harness(options: { limit?: number; world?: typeof baseWorld } = {}): Harness {
  const clock = stepClock(Date.parse(NOW));
  const traces: TokenTraceEvent[] = [];
  const state: Harness = {
    service: new TokenService({
      worldLoader: () => state.world,
      clock: clock.now,
      secretGenerator: deterministicSecrets(),
      saltGenerator: deterministicSalts(),
      rateLimit: options.limit ? { windowMs: 60_000, limit: options.limit } : undefined,
      trace: (event) => traces.push(event),
    }),
    clock,
    traces,
    world: options.world ?? baseWorld,
  };
  return state;
}

function issueDefault(h: Harness, principalId = SARAH) {
  return h.service.issue(principalId, {
    label: 'Research notebook extract',
    scopes: {
      actions: ['observations:read', 'history:read', 'exports:create'],
      streams: ['str-corinne-q'],
      properties: ['discharge'],
      processingLevels: ['raw', 'provisional', 'reviewed', 'best-available'],
      dateRange: { start: '2026-03-01T00:00:00Z', end: '2026-06-30T00:00:00Z' },
    },
  });
}

function assertTokenError(fn: () => unknown, code: string, status?: number): TokenError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof TokenError, `expected TokenError ${code}, got ${String(caught)}`);
  assert.equal((caught as TokenError).code, code);
  if (status !== undefined) assert.equal((caught as TokenError).status, status);
  return caught as TokenError;
}

// ---------------------------------------------------------------------------
// hash.ts: format, salting, constant-time verify
// ---------------------------------------------------------------------------

test('secret format: uwdat_ prefix, 32 base62 characters, ~190 bits', () => {
  for (let i = 0; i < 8; i += 1) {
    const secret = generateSecret();
    assert.ok(isSecretFormat(secret), `${secret} matches the format`);
    assert.ok(/^[0-9A-Za-z]{32}$/.test(secret.slice(SECRET_PREFIX.length)), 'base62 payload');
  }
  assert.ok(!isSecretFormat('uwdat_short'), 'too short rejects');
  assert.ok(!isSecretFormat('sha_abcdefghijklmnopqrstuvwxyz012345'), 'wrong prefix rejects');
  assert.ok(!isSecretFormat('uwdat_abcdefghijklmnopqrstuvwxyz01!'), 'non-base62 rejects');
});

test('hashing is salted per token and never retains plaintext', () => {
  const secret = generateSecret();
  const a = hashSecret(secret);
  const b = hashSecret(secret);
  assert.notEqual(a, b, 'same secret, different salts -> different stored hashes');
  assert.ok(verifySecret(secret, a) && verifySecret(secret, b), 'both verify');
  assert.ok(!verifySecret(`${secret.slice(0, -1)}X`, a), 'tampered secret denies');
  assert.ok(!a.includes(secret), 'stored hash never embeds the plaintext');
  assert.ok(!verifySecret(secret, 'not-a-hash'), 'malformed stored hash denies (never throws)');
});

// ---------------------------------------------------------------------------
// Fixture seeding
// ---------------------------------------------------------------------------

test('store seeds Sarah with exactly one pre-hashed example token (hash only)', () => {
  const h = harness();
  const sarahTokens = h.service.listFor(SARAH);
  assert.equal(sarahTokens.length, 1);
  const seeded = sarahTokens[0]!;
  assert.equal(seeded.id, 'tok-seed-sarah-001');
  assert.equal(seeded.status, 'active');
  assert.ok(!('secretHash' in seeded), 'the public view never carries the hash');
  assert.ok(!JSON.stringify(sarahTokens).includes('uwdat_'), 'no plaintext secret in the listing');
  assert.equal(h.service.listFor(CODY).length, 0, 'the seed belongs to Sarah only');
});

// ---------------------------------------------------------------------------
// issue / verify happy path
// ---------------------------------------------------------------------------

test('issue/verify happy path: secret shown once, lastUsed advances, view has no hash', () => {
  const h = harness();
  const issued = issueDefault(h);
  assert.ok(isSecretFormat(issued.secret), 'the one-time secret uses the uwdat_ format');
  assert.equal(issued.token.label, 'Research notebook extract');
  assert.equal(issued.token.status, 'active');
  assert.equal(issued.token.lastUsedAt, null);
  assert.ok(!('secretHash' in issued.token), 'IssueResult carries no hash either');
  assert.ok(Date.parse(issued.token.expiresAt) > Date.parse(issued.token.createdAt), 'expiry after creation');

  const verified = h.service.verify(issued.secret);
  assert.equal(verified.token.id, issued.token.id, 'credential resolves to its record');
  assert.equal(verified.principalId, SARAH, 'identity is derived from the credential, never a body field');
  assert.equal(verified.token.lastUsedAt, verified.verifiedAt, 'lastUsedAt advances on success');
});

// ---------------------------------------------------------------------------
// Wrong secret denies, and the scan is constant-time
// ---------------------------------------------------------------------------

test('wrong secret denies with 401 and the same hash-compare count as a correct secret', () => {
  const h = harness();
  const issued = issueDefault(h);
  h.service.issue(SARAH, { label: 'Second token', scopes: { actions: ['catalog:read'] } });
  const records = 3; // Sarah seed + two issued

  h.traces.length = 0;
  assert.ok(h.service.verify(issued.secret), 'correct secret verifies');
  const correctCompares = h.traces.filter((t) => t.kind === 'hash-compare').length;
  assert.equal(correctCompares, records, 'every record is compared on a match');

  h.traces.length = 0;
  // Deterministic payloads are all digits; a trailing 'Z' cannot collide with
  // any issued secret, so this stays a genuine wrong-secret presentation.
  const wrong = `${issued.secret.slice(0, -1)}Z`;
  assert.notEqual(wrong, issued.secret);
  assertTokenError(() => h.service.verify(wrong), 'UNKNOWN_TOKEN', 401);
  const wrongCompares = h.traces.filter((t) => t.kind === 'hash-compare').length;
  assert.equal(wrongCompares, records, 'no early exit: a wrong secret scans the full record set too');

  assertTokenError(() => h.service.verify('not-a-token'), 'INVALID_SECRET_FORMAT', 401);
});

// ---------------------------------------------------------------------------
// Expiry boundary at the injected clock (half-open [createdAt, expiresAt))
// ---------------------------------------------------------------------------

test('expiry boundary: valid the instant before, denied at the instant of expiry', () => {
  const h = harness();
  const expiresAt = new Date(Date.parse(NOW) + 10 * DAY).toISOString();
  const issued = h.service.issue(SARAH, { label: 'Short lived', scopes: {}, expiresAt });

  h.clock.at(10 * DAY - 1);
  assert.ok(h.service.verify(issued.secret), 'one millisecond before expiry still verifies');

  h.clock.at(10 * DAY);
  assertTokenError(() => h.service.verify(issued.secret), 'TOKEN_EXPIRED', 401);

  // Validation checks relative to a fresh clock still at NOW (the boundary
  // harness above has already travelled 10 days ahead).
  const h2 = harness();
  assertTokenError(
    () => h2.service.issue(SARAH, { label: 'Past', scopes: {}, expiresAt: new Date(Date.parse(NOW) - DAY).toISOString() }),
    'INVALID_REQUEST',
    422,
  );
  assertTokenError(
    () =>
      h2.service.issue(SARAH, {
        label: 'Too long',
        scopes: {},
        expiresAt: new Date(Date.parse(NOW) + (TOKEN_LIFETIME.maxDays + 1) * DAY).toISOString(),
      }),
    'INVALID_REQUEST',
    422,
    `the server maximum of ${TOKEN_LIFETIME.maxDays} days applies`,
  );
});

test('a null expiry still yields a finite lifetime (default = maximum = 90 days, proposed)', () => {
  const h = harness();
  const issued = h.service.issue(SARAH, { label: 'Default lifetime', scopes: {} });
  const days = (Date.parse(issued.token.expiresAt) - Date.parse(issued.token.createdAt)) / DAY;
  assert.equal(Math.round(days), TOKEN_LIFETIME.defaultDays);
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

test('rotation invalidates the old secret immediately and returns the new one exactly once', () => {
  const h = harness();
  const first = issueDefault(h);

  const second = h.service.rotate(first.token.id, SARAH);
  assert.equal(second.token.label, first.token.label, 'rotation keeps the label');
  assert.equal(second.rotatedFromId, first.token.id);
  assert.notEqual(second.secret, first.secret);
  assert.ok(isSecretFormat(second.secret));

  assertTokenError(() => h.service.verify(first.secret), 'TOKEN_REVOKED', 401, 'old secret dies with the rotation');
  assert.ok(h.service.verify(second.secret), 'new secret works immediately');

  const old = h.service.record(first.token.id)!;
  assert.equal(old.status, 'revoked');
  assert.equal(old.rotatedToId, second.token.id, 'the old record links to its replacement');
  assert.equal(h.service.record(second.token.id)!.rotatedFromId, first.token.id);

  assertTokenError(() => h.service.rotate(first.token.id, SARAH), 'ALREADY_REVOKED', 409, 'cannot rotate a rotated-out token');
});

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

test('revocation denies the very next request; double revoke and cross-owner revoke are typed errors', () => {
  const h = harness({ world: codyWorld });
  const issued = issueDefault(h);
  assert.ok(h.service.verify(issued.secret), 'verifies before revocation');

  const revoked = h.service.revoke(issued.token.id, SARAH);
  assert.equal(revoked.status, 'revoked');
  assert.ok(revoked.revokedAt);

  assertTokenError(() => h.service.verify(issued.secret), 'TOKEN_REVOKED', 401, 'next request denies');
  assertTokenError(() => h.service.revoke(issued.token.id, SARAH), 'ALREADY_REVOKED', 409);

  const codyToken = h.service.issue(CODY, { label: 'Cody scripting', scopes: { actions: ['sites:read'] } });
  assertTokenError(() => h.service.revoke(codyToken.token.id, SARAH), 'NOT_FOUND', 404, 'no existence disclosure across accounts');
});

// ---------------------------------------------------------------------------
// Rate limits (independent of interactive sessions)
// ---------------------------------------------------------------------------

test('per-token fixed-window budget: 429 once the limit is exceeded, counters exposed', () => {
  const h = harness({ limit: 2 });
  const issued = h.service.issue(SARAH, { label: 'Burst', scopes: {} });
  assert.ok(h.service.verify(issued.secret));
  assert.ok(h.service.verify(issued.secret));
  assertTokenError(() => h.service.verify(issued.secret), 'RATE_LIMITED', 429);

  const snapshot = h.service.rateLimitSnapshot(issued.token.id)!;
  assert.equal(snapshot.used, 3);
  assert.equal(snapshot.remaining, 0);
  assert.equal(snapshot.limit, 2);
});

// ---------------------------------------------------------------------------
// Issue-time authority: scopes can never exceed the account's CURRENT authority
// ---------------------------------------------------------------------------

test('issue-time scope validation rejects what the account cannot do today', () => {
  const h = harness({ world: codyWorld });

  // Sarah cannot pin a token to a restricted stream she has no grant over.
  assertTokenError(
    () => h.service.issue(SARAH, { label: 'Overreach', scopes: { streams: ['str-hyrum-q-owner'] } }),
    'SCOPE_EXCEEDS_AUTHORITY',
    403,
  );

  // Cody holds no create-exports capability (fixture grant), so the action is refused whole.
  assertTokenError(
    () => h.service.issue(CODY, { label: 'No export right', scopes: { actions: ['exports:create'] } }),
    'SCOPE_EXCEEDS_AUTHORITY',
    403,
  );

  assertTokenError(() => h.service.issue(SARAH, { label: '   ', scopes: {} }), 'INVALID_LABEL', 422);
  assertTokenError(() => h.service.issue(SARAH, { label: 'x'.repeat(81), scopes: {} }), 'INVALID_LABEL', 422);
  assertTokenError(() => h.service.issue(SARAH, { label: 'Bad enum', scopes: { actions: ['surprise' as never] } }), 'INVALID_REQUEST', 422);
  assertTokenError(
    () => h.service.issue(SARAH, { label: 'Inverted window', scopes: { dateRange: { start: '2026-06-30T00:00:00Z', end: '2026-03-01T00:00:00Z' } } }),
    'INVALID_REQUEST',
    422,
  );

  // The commissioner CAN scope to his system's restricted stream today.
  const codyToken = h.service.issue(CODY, { label: 'Owner stream read', scopes: { streams: ['str-hyrum-q-owner'] } });
  assert.deepEqual(codyToken.token.scopes.streams, ['str-hyrum-q-owner'], 'canonicalized and stored');
});

test('a deactivated account can neither issue nor use tokens', () => {
  const h = harness();
  const issued = issueDefault(h);
  h.world = withPrincipal(baseWorld, SARAH, { active: false });
  assertTokenError(() => h.service.verify(issued.secret), 'PRINCIPAL_INACTIVE', 401, 'tokens die with the account');
  assertTokenError(() => issueDefault(h), 'PRINCIPAL_INACTIVE', 401);
});

// ---------------------------------------------------------------------------
// scopeEval: token scopes intersect the policy decision (FR-064/FR-065)
// ---------------------------------------------------------------------------

test('a stream scope is checked against the actual target, even if query coordinates are absent or spoofed', () => {
  const issued = issueDefault(harness());
  for (const query of [{}, { streamId: 'str-corinne-q' }]) {
    const decision = authorizeScoped(issued.token, 'observations:read', { kind: 'datastream', id: 'str-corinne-stage' }, query, baseWorld, NOW);
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.scopeReason, 'STREAM_NOT_IN_SCOPE');
  }
});

test('malformed and reversed query date bounds cannot pass a token date-range check', () => {
  const scopes = issueDefault(harness()).token.scopes;
  for (const query of [
    { start: 'not-a-date', end: '2026-03-03T00:00:00Z' },
    { start: '2026-03-02T00:00:00Z', end: 'not-a-date' },
    { start: '2026-03-03T00:00:00Z', end: '2026-03-02T00:00:00Z' },
  ]) {
    assert.equal(scopeCoversQuery(scopes, query).covered, false);
  }
});

test('scope narrowing: a token without a dimension cannot query it (403, never clamped)', () => {
  const h = harness();
  const issued = issueDefault(h);
  const record = issued.token;
  const dataset = { kind: 'dataset' as const, id: 'dataset-approved-discharge-v1' };

  // Property narrowing.
  assert.equal(scopeCoversQuery(issued.token.scopes, { observedPropertyId: 'stage' }).reason, 'PROPERTY_NOT_IN_SCOPE');
  assert.equal(
    authorizeScoped(record, 'observations:read', { kind: 'datastream', id: 'str-corinne-q' }, { streamId: 'str-corinne-q', observedPropertyId: 'stage' }, baseWorld, NOW).scopeReason,
    'PROPERTY_NOT_IN_SCOPE',
  );

  // Stream narrowing.
  assert.equal(
    authorizeScoped(record, 'observations:read', { kind: 'datastream', id: 'str-corinne-stage' }, { streamId: 'str-corinne-stage' }, baseWorld, NOW).scopeReason,
    'STREAM_NOT_IN_SCOPE',
  );

  // Processing-level narrowing (FR-066).
  const rawOnly = h.service.issue(SARAH, { label: 'Raw only', scopes: { processingLevels: ['raw'] } });
  assert.equal(
    scopeCoversQuery(rawOnly.token.scopes, { processingLevel: 'reviewed' }).reason,
    'PROCESSING_LEVEL_NOT_IN_SCOPE',
  );
  assert.equal(scopeCoversQuery(rawOnly.token.scopes, { processingLevel: 'raw' }).covered, true);

  // Date-range narrowing: out-of-window requests reject rather than clamp.
  assert.equal(
    scopeCoversQuery(issued.token.scopes, { start: '2026-02-01T00:00:00Z', end: '2026-03-02T00:00:00Z' }).reason,
    'DATE_RANGE_NOT_IN_SCOPE',
  );
  assert.equal(
    scopeCoversQuery(issued.token.scopes, { start: '2026-03-02T00:00:00Z', end: '2026-06-29T00:00:00Z' }).covered,
    true,
  );

  // Action narrowing.
  const readOnly = h.service.issue(SARAH, { label: 'Read only', scopes: { actions: ['observations:read'] } });
  const readOnlyRecord = readOnly.token;
  const denied = authorizeScoped(readOnlyRecord, 'exports:create', dataset, {}, baseWorld, NOW);
  assert.equal(denied.effect, 'deny');
  assert.equal(denied.scopeReason, 'ACTION_NOT_IN_SCOPE');
  assert.equal(denied.policy, null, 'the engine is never consulted once the action is out of scope');

  // And the allowed path: public projection via the scoped credential.
  const allowed = authorizeScoped(record, 'observations:read', { kind: 'datastream', id: 'str-corinne-q' }, { streamId: 'str-corinne-q', observedPropertyId: 'discharge' }, baseWorld, NOW);
  assert.equal(allowed.effect, 'allow');
  assert.equal(allowed.policy?.via, 'public-read');
  const history = authorizeScoped(record, 'history:read', dataset, {}, baseWorld, NOW);
  assert.equal(history.effect, 'allow');
  assert.equal(history.policy?.matchedAssignmentIds.includes('ent-researcher-sarah'), true, 'the grant - not the token - is the authority');
});

test('a scoped token on a restricted stream still requires the principal grant', () => {
  const h = harness({ world: codyWorld });
  const codyToken = h.service.issue(CODY, { label: 'Owner stream read', scopes: { actions: ['observations:read'], streams: ['str-hyrum-q-owner'] } });
  const record = { ...codyToken.token, secretHash: '' };
  const target = { kind: 'datastream' as const, id: 'str-hyrum-q-owner' };

  const allowed = authorizeScoped(record, 'observations:read', target, { streamId: 'str-hyrum-q-owner' }, baseWorld, NOW);
  assert.equal(allowed.effect, 'allow');
  assert.equal(allowed.policy?.via, 'protected', 'through the grant, not the public projection');

  // Sarah's credential on the same restricted stream: token-side allow is
  // irrelevant, the policy engine denies and the object stays hidden (404 rule).
  const sarahToken = h.service.issue(SARAH, { label: 'Public only', scopes: { actions: ['observations:read'] } });
  const sarahRecord = sarahToken.token;
  const deniedForSarah = authorizeScoped(sarahRecord, 'observations:read', target, { streamId: 'str-hyrum-q-owner' }, baseWorld, NOW);
  assert.equal(deniedForSarah.effect, 'deny');
  assert.equal(deniedForSarah.policyReason, 'DENY_OUT_OF_SCOPE');
});

test('principal-grant revocation cascades: the token stays unrevoked yet authorizes nothing', () => {
  const h = harness({ world: codyWorld });
  const issued = issueDefault(h);
  const record = issued.token;
  const dataset = { kind: 'dataset' as const, id: 'dataset-approved-discharge-v1' };

  // Before: history reads ride on the dataset grant.
  assert.equal(authorizeScoped(record, 'history:read', dataset, {}, baseWorld, NOW).effect, 'allow');

  // Revoke the underlying assignment; the TOKEN itself is untouched.
  const denied = authorizeScoped(record, 'history:read', dataset, {}, sarahRevokedWorld, NOW);
  assert.equal(denied.effect, 'deny');
  assert.equal(denied.policyReason, 'DENY_ASSIGNMENT_REVOKED');
  assert.equal(h.service.record(issued.token.id)!.status, 'active', 'the token record is still active - authority, not the credential, was revoked');

  // The same cascade kills a commissioner's restricted-stream token.
  const codyToken = h.service.issue(CODY, { label: 'Owner stream read', scopes: { streams: ['str-hyrum-q-owner'] } });
  const codyRecord = codyToken.token;
  const codyDenied = authorizeScoped(codyRecord, 'observations:read', { kind: 'datastream', id: 'str-hyrum-q-owner' }, { streamId: 'str-hyrum-q-owner' }, codyRevokedWorld, NOW);
  assert.equal(codyDenied.effect, 'deny');
  assert.equal(codyDenied.policyReason, 'DENY_ASSIGNMENT_REVOKED');

  // And no NEW token can claim the revoked authority either.
  h.world = sarahRevokedWorld;
  assertTokenError(() => h.service.issue(SARAH, { label: 'After revocation', scopes: { actions: ['exports:create'] } }), 'SCOPE_EXCEEDS_AUTHORITY', 403);
});

// ---------------------------------------------------------------------------
// Secrecy invariants: one IssueResult, zero persistence (FR-064; T-16 rule)
// ---------------------------------------------------------------------------

test('the secret appears in exactly one IssueResult and nowhere in store, counters or log lines', () => {
  const h = harness();
  const first = issueDefault(h);
  h.service.verify(first.secret);
  const second = h.service.rotate(first.token.id, SARAH);
  h.service.verify(second.secret);
  h.service.revoke(second.token.id, SARAH);
  h.service.issue(SARAH, { label: 'Catalog probe', scopes: { actions: ['catalog:read'] } });

  const serialized = h.service.serializeState(); // records + counters + audit log
  for (const secret of [first.secret, second.secret]) {
    assert.ok(!serialized.includes(secret), 'the serialized store never contains a plaintext secret');
    for (const line of h.service.auditLog()) {
      assert.ok(!line.includes(secret), 'audit lines carry the token id only');
    }
  }
  // The hash IS retained (that is the design), but only as salt$digest.
  assert.ok(serialized.includes('$'), 'salted hashes remain for verification');
  assert.ok(!serialized.includes(SECRET_PREFIX), 'no uwdat_ string survives anywhere in the store');

  // "Exactly once": the only place the secret occurs is the IssueResult the
  // caller already holds; a second result (rotation) carries the NEW secret.
  assert.notEqual(first.secret, second.secret);
  assert.ok(isSecretFormat(first.secret) && isSecretFormat(second.secret));
});

// ---------------------------------------------------------------------------
// Determinism: the same scenario twice is byte-identical
// ---------------------------------------------------------------------------

function scenario(): string {
  const h = harness();
  const a = issueDefault(h);
  h.service.verify(a.secret);
  const b = h.service.rotate(a.token.id, SARAH);
  h.service.verify(b.secret);
  assertTokenError(() => h.service.verify(a.secret), 'TOKEN_REVOKED');
  h.service.revoke(b.token.id, SARAH);
  h.service.issue(SARAH, { label: 'Catalog probe', scopes: { actions: ['catalog:read'] } });
  return h.service.serializeState();
}

test('determinism: replaying the full scenario produces a byte-identical store', () => {
  assert.equal(scenario(), scenario());
});
