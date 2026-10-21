/**
 * Derivation tests for the FR-064 developer-access view model.
 *
 * Run (zero dependencies, same runner as apps/web/tests):
 *   cd apps/web && node --test --experimental-strip-types src/features/developer-access/derivation.test.ts
 *
 * Every clock input is an injected constant. (Import pattern per
 * apps/web/tests/adapters.test.ts: computed specifiers for
 * node --test --experimental-strip-types, type-only imports for tsc.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { AccountAuthority, CreateDraft, TokenRecordView } from './derivation';

// Extensionless src imports under node --test (see tests/ts-resolve-hook.mjs).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const derivationPath = './derivation.ts';
const derivation: typeof import('./derivation') = await import(derivationPath);
const {
  DEFAULT_DRAFT,
  EXPIRING_WINDOW_DAYS,
  buildScopeChoices,
  deriveTokenRow,
  deriveTokenRows,
  draftToScopes,
  summarizeScopes,
  validateDraft,
} = derivation;

const NOW = '2026-03-09T07:00:00Z';
const DAY = 86_400_000;

function record(partial: Partial<TokenRecordView> = {}): TokenRecordView {
  return {
    id: 'tok-000001',
    label: 'Research notebook extract',
    scopes: {
      actions: ['observations:read', 'exports:create'],
      streams: ['str-corinne-q'],
      properties: ['discharge'],
      processingLevels: ['raw', 'provisional', 'reviewed', 'best-available'],
      dateRange: { start: '2026-03-01T00:00:00Z', end: '2026-06-30T00:00:00Z' },
    },
    principalId: 'principal-sarah-researcher',
    createdAt: '2026-03-01T09:15:00Z',
    expiresAt: new Date(Date.parse(NOW) + 90 * DAY).toISOString(),
    lastUsedAt: '2026-03-09T07:05:00Z',
    status: 'active',
    revokedAt: null,
    rotatedToId: null,
    rotatedFromId: null,
    ...partial,
  };
}

const AUTHORITY: AccountAuthority = {
  principalId: 'principal-sarah-researcher',
  displayName: 'Sarah Kimball',
  availableActions: ['catalog:read', 'sites:read', 'observations:read', 'history:read', 'exports:create'],
  readableStreams: [
    { id: 'str-corinne-q', label: 'Bear River near Corinne - discharge' },
    { id: 'str-corinne-stage', label: 'Bear River near Corinne - stage' },
    { id: 'str-hyrum-q-public', label: 'Little Bear Diversion - discharge' },
  ],
  availableProperties: ['discharge', 'stage'],
  availableProcessingLevels: ['raw', 'provisional', 'reviewed', 'best-available'],
  maxLifetimeDays: 90,
};

// ---------------------------------------------------------------------------
// Status derivation and expiry countdown at a fixed clock
// ---------------------------------------------------------------------------

test('status derivation: active far from expiry', () => {
  const row = deriveTokenRow(record(), NOW);
  assert.equal(row.derivedStatus, 'active');
  assert.equal(row.expiresInDays, 90);
  assert.match(row.statusText, /90 days left/);
  assert.equal(row.canRotate, true);
  assert.equal(row.canRevoke, true);
});

test('status derivation: expiring flag inside the window, day boundary rounded up', () => {
  const threeDays = record({ expiresAt: new Date(Date.parse(NOW) + 3 * DAY - 1).toISOString() });
  assert.equal(deriveTokenRow(threeDays, NOW).derivedStatus, 'expiring');
  assert.equal(deriveTokenRow(threeDays, NOW).expiresInDays, 3, 'a partial day rounds up');

  const boundary = record({ expiresAt: new Date(Date.parse(NOW) + EXPIRING_WINDOW_DAYS * DAY).toISOString() });
  assert.equal(deriveTokenRow(boundary, NOW).derivedStatus, 'expiring');
  const justOutside = record({ expiresAt: new Date(Date.parse(NOW) + (EXPIRING_WINDOW_DAYS + 1) * DAY).toISOString() });
  assert.equal(deriveTokenRow(justOutside, NOW).derivedStatus, 'active');
});

test('status derivation: expired at and after the expiry instant; revoked wins', () => {
  // Half-open [createdAt, expiresAt): one millisecond before expiry the row
  // still rounds up to "1 day left" (expiring); AT the instant it is expired.
  const stillValid = record({ expiresAt: new Date(Date.parse(NOW) + 1).toISOString() });
  assert.equal(deriveTokenRow(stillValid, NOW).derivedStatus, 'expiring');
  const expired = record({ expiresAt: new Date(Date.parse(NOW) - 1).toISOString() });
  assert.equal(deriveTokenRow(expired, NOW).derivedStatus, 'expired');
  const atInstant = record({ expiresAt: NOW });
  assert.equal(deriveTokenRow(atInstant, NOW).derivedStatus, 'expired', 'half-open: the expiry instant is already expired');

  const revoked = record({ status: 'revoked', revokedAt: '2026-03-08T00:00:00Z', rotatedToId: 'tok-000002' });
  const revokedRow = deriveTokenRow(revoked, NOW);
  assert.equal(revokedRow.derivedStatus, 'revoked');
  assert.equal(revokedRow.expiresInDays, null);
  assert.match(revokedRow.statusText, /rotated to tok-000002/);
  assert.equal(revokedRow.canRotate, false);
  assert.equal(revokedRow.canRevoke, false);
});

test('last-used text distinguishes never used; rows sort newest first', () => {
  const neverUsed = deriveTokenRow(record({ lastUsedAt: null }), NOW);
  assert.equal(neverUsed.lastUsedText, 'Never used');
  const rows = deriveTokenRows(
    [record({ id: 'tok-b', createdAt: '2026-03-02T00:00:00Z' }), record({ id: 'tok-a', createdAt: '2026-03-05T00:00:00Z' })],
    NOW,
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ['tok-a', 'tok-b'],
  );
});

// ---------------------------------------------------------------------------
// Scope summarization
// ---------------------------------------------------------------------------

test('scope summary spells out every dimension and the unconstrained case', () => {
  const summary = summarizeScopes(record().scopes);
  assert.ok(summary.includes('observations:read'));
  assert.ok(summary.includes('exports:create'));
  assert.ok(summary.includes('str-corinne-q'));
  assert.ok(summary.includes('discharge only'));
  assert.ok(summary.includes('raw/provisional/reviewed/best-available'));
  assert.ok(summary.includes('2026-03-01T00:00:00Z to 2026-06-30T00:00:00Z'));

  const unconstrained = summarizeScopes({});
  assert.ok(unconstrained.includes('any action the account holds'));
  assert.ok(unconstrained.includes('any authorized stream'));
});

test('all five actions summarize as "all actions"', () => {
  const summary = summarizeScopes({
    actions: ['catalog:read', 'sites:read', 'observations:read', 'history:read', 'exports:create'],
  });
  assert.ok(summary.startsWith('all actions'));
});

// ---------------------------------------------------------------------------
// Create dialog: choices bounded by authority, validation, request shape
// ---------------------------------------------------------------------------

test('scope choices are bounded by the account authority', () => {
  const narrowed: AccountAuthority = {
    ...AUTHORITY,
    availableActions: ['observations:read', 'history:read'],
    readableStreams: [{ id: 'str-corinne-q', label: 'Corinne discharge' }],
    availableProperties: ['discharge'],
  };
  const choices = buildScopeChoices(narrowed);
  assert.deepEqual(
    choices.actionChoices.map((choice) => choice.value),
    ['observations:read', 'history:read'],
  );
  assert.equal(choices.streamChoices.length, 1);
  assert.equal(choices.propertyChoices.length, 1);
  assert.equal(choices.processingLevelChoices.length, 4);
  assert.equal(choices.maxLifetimeDays, 90);
});

test('draft validation: label, actions, authority and lifetime rules', () => {
  assert.deepEqual(validateDraft(DEFAULT_DRAFT, AUTHORITY).label, 'A label is required.');
  assert.ok(validateDraft({ ...DEFAULT_DRAFT, label: 'x'.repeat(81) }, AUTHORITY).label);

  const noActions = validateDraft({ ...DEFAULT_DRAFT, label: 'Notebook' }, AUTHORITY);
  assert.match(noActions.actions!, /at least one action/i);

  const overreach: CreateDraft = { ...DEFAULT_DRAFT, label: 'Notebook', actions: ['observations:read', 'exports:create'] };
  const narrowedAuthority: AccountAuthority = { ...AUTHORITY, availableActions: ['observations:read'] };
  assert.match(validateDraft(overreach, narrowedAuthority).actions!, /exports:create/);

  const unknownStream = validateDraft(
    { ...DEFAULT_DRAFT, label: 'Notebook', actions: ['sites:read'], streams: ['str-hyrum-q-owner'] },
    AUTHORITY,
  );
  assert.match(unknownStream.streams!, /str-hyrum-q-owner/);

  const tooLong = validateDraft({ ...DEFAULT_DRAFT, label: 'Notebook', actions: ['sites:read'], lifetimeDays: 91 }, AUTHORITY);
  assert.match(tooLong.lifetime!, /1 to 90 days/);

  const valid = validateDraft({ ...DEFAULT_DRAFT, label: 'Notebook', actions: ['sites:read'], lifetimeDays: 30 }, AUTHORITY);
  assert.deepEqual(valid, {}, 'a valid draft has no errors');
});

test('draftToScopes narrows: selecting everything stores no filter for that dimension', () => {
  const narrowed = draftToScopes(
    {
      label: 'Notebook',
      actions: ['observations:read'],
      streams: ['str-corinne-q'],
      properties: ['discharge'],
      processingLevels: ['reviewed'],
      lifetimeDays: 30,
    },
    AUTHORITY,
  );
  assert.deepEqual(narrowed.actions, ['observations:read']);
  assert.deepEqual(narrowed.streams, ['str-corinne-q']);
  assert.deepEqual(narrowed.properties, ['discharge']);
  assert.deepEqual(narrowed.processingLevels, ['reviewed']);
  assert.equal(narrowed.dateRange, undefined);

  const allStreams = draftToScopes(
    { ...DEFAULT_DRAFT, label: 'Everything', actions: ['catalog:read'], streams: AUTHORITY.readableStreams.map((s) => s.id) },
    AUTHORITY,
  );
  assert.equal(allStreams.streams, undefined, 'the full set is the account bound itself, not a filter');
});
