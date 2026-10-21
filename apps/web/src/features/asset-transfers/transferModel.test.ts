/**
 * Asset-transfer model tests (WD-012-R2, FR-048): association-timeline
 * semantics (half-open periods, boundary ownership), the visits-stay-at-
 * their-site integrity projection, form validation mirroring the server,
 * and determinism.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/asset-transfers/transferModel.test.ts
 *
 * Also picked up by the package-wide `pnpm --filter @utah-water/web test`
 * glob (every `.test.ts` under src/features).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const model: typeof import('./transferModel') = await import('./transferModel');

const {
  DEMO_ASSOCIATIONS,
  DEMO_EQUIPMENT,
  EMPTY_TRANSFER_FORM,
  associationPeriodsOf,
  composeTransferBody,
  currentPeriodOf,
  evidenceLabel,
  formatPeriod,
  periodsAtSite,
  periodAt,
  siteOfAt,
  sitesEverOf,
  validateTransferForm,
  visitsOfSite,
} = model;

const EQ = DEMO_EQUIPMENT[0]!;
const EQ_PERIODS = DEMO_ASSOCIATIONS.filter((period) => period.equipmentId === EQ.id);

// ---------------------------------------------------------------------------
// Timeline semantics (mirror of the server's half-open associations)
// ---------------------------------------------------------------------------

test('association periods are half-open: the transfer boundary belongs to the NEW site', () => {
  const eve = siteOfAt(EQ_PERIODS, '2026-03-31T23:59:59Z');
  const boundary = siteOfAt(EQ_PERIODS, '2026-04-01T00:00:00Z');
  assert.equal(eve, 'sta-bear-corinne', 'the instant before the boundary: old site');
  assert.equal(boundary, 'sta-hyrum-diversion-public', 'the boundary instant itself: already the new site');
});

test('periodAt returns null before registration and after every period closed', () => {
  assert.equal(periodAt(EQ_PERIODS, '2025-12-31T23:59:59Z'), null, 'not yet registered');
  const closedOnly = [
    { equipmentId: EQ.id, siteId: 'sta-bear-corinne', effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-04-01T00:00:00Z', openedByTransferId: null },
  ];
  assert.equal(periodAt(closedOnly, '2026-06-01T00:00:00Z'), null, 'all periods closed: no current site');
});

test('currentPeriodOf finds the open association; periods are ordered by effectiveFrom', () => {
  const current = currentPeriodOf(EQ_PERIODS);
  assert.equal(current!.siteId, 'sta-hyrum-diversion-public');
  assert.equal(current!.effectiveTo, null);
  assert.deepEqual(
    associationPeriodsOf([...EQ_PERIODS].reverse()).map((period) => period.siteId),
    ['sta-bear-corinne', 'sta-hyrum-diversion-public'],
    'input order never matters',
  );
});

test('sitesEverOf lists every distinct site in period order (a return visit does not duplicate)', () => {
  const chained = [
    ...EQ_PERIODS,
    { equipmentId: EQ.id, siteId: 'sta-bear-corinne', effectiveFrom: '2026-07-01T00:00:00Z', effectiveTo: null, openedByTransferId: 'xfer-1002' },
  ];
  assert.deepEqual(sitesEverOf(chained), ['sta-bear-corinne', 'sta-hyrum-diversion-public']);
});

test('formatPeriod renders current and closed periods distinctly', () => {
  assert.equal(formatPeriod(currentPeriodOf(EQ_PERIODS)!), 'since 2026-04-01 (current)');
  assert.equal(formatPeriod(EQ_PERIODS[0]!), '2026-01-01 to 2026-04-01');
});

test('evidenceLabel exposes make, model, identifier, serial and photo count', () => {
  assert.equal(evidenceLabel(EQ), 'FlumeLog 300 - rtu-corinne-02 - s/n FL300-2201-88 - 2 photos');
});

// ---------------------------------------------------------------------------
// FR-048 integrity: visits stay at the site where they occurred
// ---------------------------------------------------------------------------

test('visitsOfSite: a pre-transfer visit never appears in the new site\'s visit list', () => {
  const { DEMO_VISITS } = model;
  const corinne = visitsOfSite(DEMO_VISITS, 'sta-bear-corinne');
  const hyrum = visitsOfSite(DEMO_VISITS, 'sta-hyrum-diversion-public');
  assert.deepEqual(corinne.map((visit) => visit.id), ['visit-1001']);
  assert.deepEqual(hyrum.map((visit) => visit.id), ['visit-1002']);
  assert.ok(!hyrum.some((visit) => visit.id === 'visit-1001'), 'the pre-transfer visit was not re-filed');
  // And the equipment timeline explains the split: at visit-1001's time the
  // asset was still at Corinne.
  assert.equal(siteOfAt(EQ_PERIODS, '2026-03-12T15:30:00Z'), 'sta-bear-corinne');
  assert.equal(siteOfAt(EQ_PERIODS, '2026-04-02T15:30:00Z'), 'sta-hyrum-diversion-public');
});

test('periodsAtSite drives the per-site history view', () => {
  const corinne = periodsAtSite(DEMO_ASSOCIATIONS, 'sta-bear-corinne');
  assert.equal(corinne.length, 1);
  assert.equal(corinne[0]!.equipmentId, 'eq-1001');
  assert.deepEqual(periodsAtSite(DEMO_ASSOCIATIONS, 'sta-bear-lake-diagnostic'), []);
});

// ---------------------------------------------------------------------------
// Form validation (mirror of the server's transfer checks)
// ---------------------------------------------------------------------------

function validForm() {
  return {
    ...EMPTY_TRANSFER_FORM,
    equipmentId: EQ.id,
    fromSiteId: 'sta-hyrum-diversion-public',
    toSiteId: 'sta-bear-corinne',
    effectiveAt: '2026-06-01T00:00:00Z',
    identifier: EQ.identifier,
    serial: EQ.serial,
  };
}

const SCOPE = ['sta-bear-corinne', 'sta-hyrum-diversion-public', 'sta-bear-lake-diagnostic'];

test('a complete, in-scope, correctly evidenced form validates clean', () => {
  assert.deepEqual(validateTransferForm(validForm(), EQ, EQ_PERIODS, { allowedSiteIds: SCOPE }), []);
});

test('each server rule is mirrored with its field path and code', () => {
  const cases: ReadonlyArray<{ readonly form: Parameters<typeof validateTransferForm>[0]; readonly code: string; readonly note: string }> = [
    { form: { ...validForm(), serial: 'WRONG-1' }, code: 'EVIDENCE_MISMATCH', note: 'serial evidence must match' },
    { form: { ...validForm(), identifier: 'wrong-tag' }, code: 'EVIDENCE_MISMATCH', note: 'identifier evidence must match' },
    { form: { ...validForm(), fromSiteId: 'sta-bear-corinne' }, code: 'ASSOCIATION_MISMATCH', note: 'from must be the open association' },
    { form: { ...validForm(), toSiteId: 'sta-hyrum-diversion-public' }, code: 'SAME_SITE', note: 'destination differs from origin' },
    { form: { ...validForm(), toSiteId: 'sta-ogden-valley-proposed' }, code: 'TO_SITE_OUT_OF_SCOPE', note: 'destination within assignment scope' },
    { form: { ...validForm(), effectiveAt: '' }, code: 'EFFECTIVE_DATE_REQUIRED', note: 'dated transfer' },
    { form: { ...validForm(), effectiveAt: '2026-06-01' }, code: 'EFFECTIVE_DATE_INVALID', note: 'explicit offset required' },
    { form: { ...validForm(), effectiveAt: '2026-01-01T00:00:00Z' }, code: 'EFFECTIVE_DATE_NOT_FORWARD', note: 'never backdated over the open period' },
  ];
  for (const testCase of cases) {
    const errors = validateTransferForm(testCase.form, EQ, EQ_PERIODS, { allowedSiteIds: SCOPE });
    assert.ok(
      errors.some((error) => error.code === testCase.code),
      `${testCase.note}: expected ${testCase.code}, got ${JSON.stringify(errors)}`,
    );
  }
});

test('a missing equipment row is its own validation error', () => {
  const errors = validateTransferForm(EMPTY_TRANSFER_FORM, null, [], { allowedSiteIds: SCOPE });
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, 'EQUIPMENT_UNKNOWN');
});

test('composeTransferBody carries the evidence and the dating verbatim', () => {
  const form = validForm();
  assert.deepEqual(composeTransferBody(form), {
    equipmentId: 'eq-1001',
    fromSiteId: 'sta-hyrum-diversion-public',
    toSiteId: 'sta-bear-corinne',
    effectiveAt: '2026-06-01T00:00:00Z',
    identifier: 'rtu-corinne-02',
    serial: 'FL300-2201-88',
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('determinism: identical inputs produce identical outputs across calls', () => {
  const first = JSON.stringify({
    periods: associationPeriodsOf(DEMO_ASSOCIATIONS),
    current: currentPeriodOf(EQ_PERIODS),
    at: siteOfAt(EQ_PERIODS, '2026-05-01T00:00:00Z'),
    sites: sitesEverOf(DEMO_ASSOCIATIONS),
    errors: validateTransferForm(validForm(), EQ, EQ_PERIODS, { allowedSiteIds: SCOPE }),
    body: composeTransferBody(validForm()),
  });
  const second = JSON.stringify({
    periods: associationPeriodsOf(DEMO_ASSOCIATIONS),
    current: currentPeriodOf(EQ_PERIODS),
    at: siteOfAt(EQ_PERIODS, '2026-05-01T00:00:00Z'),
    sites: sitesEverOf(DEMO_ASSOCIATIONS),
    errors: validateTransferForm(validForm(), EQ, EQ_PERIODS, { allowedSiteIds: SCOPE }),
    body: composeTransferBody(validForm()),
  });
  assert.equal(first, second);
});
