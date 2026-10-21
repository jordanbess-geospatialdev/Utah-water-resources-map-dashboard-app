/**
 * WD-010 site-setup tests (verification matrix rows T-06/T-07): FR-031
 * scoped create/edit with coordinate validation, FR-023 PATCH with If-Match
 * and before/after audit that survives actor deactivation, FR-033
 * effective-dating continuity (a device replacement never rewrites history),
 * and FR-034 threshold versioning - all against the REAL policy engine.
 *
 * Run:
 *   cd services/api && node --test --experimental-strip-types src/workflows/sites/test/siteSetup.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveActor, withPrincipal } from '../../../../../../packages/policy/src/index.ts';
import { createSiteStore } from '../store.ts';
import { createSite, replaceMeasurementSetup, setCapacityThresholds, updateSiteMetadata } from '../siteSetup.ts';

const FATIMA = 'principal-fatima-engineer'; // engineer, Bear River (edit + create)
const PRIYA = 'principal-priya-engineer'; // engineer, Weber River (cross-system denial)
const CODY = 'principal-cody-commissioner'; // commissioner: edit-permitted-site-fields satisfies edit, NO create-sites
const SARAH = 'principal-sarah-researcher'; // researcher: neither verb
const NOW = '2026-03-10T14:00:00Z';
const LATER = '2026-03-11T09:00:00Z';

const CORINNE = 'sta-bear-corinne'; // public, active, Bear River, version 12
const OGDEN = 'sta-ogden-valley-proposed'; // restricted, proposed, Weber River

// ---------------------------------------------------------------------------
// Scope denials (cross-system and cross-verb)
// ---------------------------------------------------------------------------

test('cross-system scope denial: a Weber engineer editing a Bear River site is 403 (public object)', () => {
  const store = createSiteStore();
  const decision = updateSiteMetadata(store, PRIYA, CORINNE, { displayName: 'Renamed by outsider' }, { now: NOW, ifMatch: 12 });
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.status, 403);
  assert.equal(decision.policyReason, 'DENY_OUT_OF_SCOPE');
  assert.equal(store.siteById(CORINNE)?.version, 12, 'nothing changed');
  assert.equal(store.auditEvents.length, 0);
});

test('cross-system scope denial: a Bear engineer editing a Weber RESTRICTED site is a hidden 404', () => {
  const store = createSiteStore();
  const decision = updateSiteMetadata(store, FATIMA, OGDEN, { displayName: 'Nope' }, { now: NOW, ifMatch: 1 });
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.status, 404);
  assert.equal(decision.policyReason, 'DENY_OUT_OF_SCOPE');
});

test('capability denial: a researcher can neither edit nor create sites', () => {
  const store = createSiteStore();
  const edit = updateSiteMetadata(store, SARAH, CORINNE, { displayName: 'Nope' }, { now: NOW, ifMatch: 12 });
  assert.equal(edit.outcome, 'rejected');
  assert.equal(edit.status, 403);
  assert.equal(edit.policyReason, 'DENY_CAPABILITY_NOT_GRANTED');
  const create = createSite(store, SARAH, { displayName: 'New', systemId: 'sys-bear-river', siteTypeId: 'natural-channel', latitude: 41.6, longitude: -112.1, stateCode: 'UT' }, { now: NOW });
  assert.equal(create.outcome, 'rejected');
  assert.equal(create.policyReason, 'DENY_CAPABILITY_NOT_GRANTED');
});

test('commissioner edits via the weaker permitted-fields grant; creation needs the explicit grant', () => {
  const store = createSiteStore();
  const edit = updateSiteMetadata(store, CODY, CORINNE, { elevationFt: 4220 }, { now: NOW, ifMatch: 12 });
  assert.equal(edit.outcome, 'applied', 'edit-permitted-site-fields satisfies edit-site-metadata (matrix rule)');
  const create = createSite(store, CODY, { displayName: 'New', systemId: 'sys-bear-river', siteTypeId: 'natural-channel', latitude: 41.6, longitude: -112.1, stateCode: 'UT' }, { now: NOW });
  assert.equal(create.outcome, 'rejected');
  assert.equal(create.policyReason, 'DENY_CAPABILITY_NOT_GRANTED', 'the fixture commissioner holds no create-sites grant');
});

test('moving a site across systems validates BOTH scopes: a system-scoped engineer is denied', () => {
  const store = createSiteStore();
  const decision = updateSiteMetadata(store, FATIMA, CORINNE, { systemId: 'sys-weber-river' }, { now: NOW, ifMatch: 12 });
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.status, 403);
  assert.equal(decision.policyReason, 'DENY_OUT_OF_SCOPE');
  assert.equal(store.siteById(CORINNE)?.systemId, 'sys-bear-river');
});

// ---------------------------------------------------------------------------
// PATCH semantics: allowed fields, optimistic version, audit
// ---------------------------------------------------------------------------

test('a valid PATCH applies, bumps the version once, and audits before-and-after values (FR-023)', () => {
  const store = createSiteStore();
  const decision = updateSiteMetadata(
    store,
    FATIMA,
    CORINNE,
    { displayName: 'Bear River at Corinne', elevationFt: 4219, capacities: { maxDiversionCfs: 1450 } },
    { now: NOW, ifMatch: 12 },
  );
  assert.equal(decision.outcome, 'applied');
  assert.equal(decision.site.version, 13);
  assert.equal(decision.site.displayName, 'Bear River at Corinne');
  assert.equal(decision.site.elevationFt, 4219);
  assert.equal(decision.site.capacities.maxDiversionCfs, 1450);
  const audit = store.auditEvents[0];
  assert.equal(audit?.action, 'edit-site-metadata');
  assert.equal(audit?.actorId, FATIMA);
  assert.equal(audit?.recordedAt, NOW);
  const changedFields = audit?.changes.map((change) => change.field);
  assert.deepEqual(changedFields, ['displayName', 'elevationFt', 'capacities']);
  const displayNameChange = audit?.changes[0];
  assert.equal(displayNameChange?.before, 'Bear River near Corinne');
  assert.equal(displayNameChange?.after, 'Bear River at Corinne');
});

test('stale If-Match is a 412 carrying both versions; concurrent edits never silently overwrite', () => {
  const store = createSiteStore();
  const first = updateSiteMetadata(store, FATIMA, CORINNE, { elevationFt: 4219 }, { now: NOW, ifMatch: 12 });
  assert.equal(first.outcome, 'applied');
  // A second editor still holds version 12 while the site is at 13.
  const second = updateSiteMetadata(store, FATIMA, CORINNE, { elevationFt: 4300 }, { now: LATER, ifMatch: 12 });
  assert.equal(second.outcome, 'conflict');
  assert.equal(second.code, 'PRECONDITION_FAILED');
  assert.equal(second.status, 412);
  assert.equal(second.currentVersion, 13);
  assert.equal(second.attemptedVersion, 12);
  assert.equal(store.siteById(CORINNE)?.elevationFt, 4219, 'the first edit stands, the second is refused');
  // Reapplying with the fresh version succeeds.
  const retried = updateSiteMetadata(store, FATIMA, CORINNE, { elevationFt: 4300 }, { now: LATER, ifMatch: 13 });
  assert.equal(retried.outcome, 'applied');
  assert.equal(store.siteById(CORINNE)?.elevationFt, 4300);
});

test('missing If-Match is also a 412: PATCH always states its base version', () => {
  const store = createSiteStore();
  const decision = updateSiteMetadata(store, FATIMA, CORINNE, { elevationFt: 4219 }, { now: NOW });
  assert.equal(decision.outcome, 'conflict');
  assert.equal(decision.status, 412);
});

test('non-editable fields are rejected with field paths, not ignored', () => {
  const store = createSiteStore();
  const decision = updateSiteMetadata(
    store,
    FATIMA,
    CORINNE,
    { visibility: 'restricted', status: 'retired', id: 'sta-hijack', displayName: 'Valid change' },
    { now: NOW, ifMatch: 12 },
  );
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.status, 422);
  assert.deepEqual(
    decision.fieldErrors.map((error) => error.fieldPath),
    ['visibility', 'status', 'id'],
  );
  assert.equal(store.siteById(CORINNE)?.displayName, 'Bear River near Corinne', 'the whole patch is refused');
});

// ---------------------------------------------------------------------------
// Coordinate validation (FR-031: runs before save)
// ---------------------------------------------------------------------------

test('coordinate validation: a swapped latitude/longitude pair is rejected, not plotted outside Utah', () => {
  const store = createSiteStore();
  // Corinne is (41.6337, -112.1965); the swapped pair puts -112.19 into latitude.
  const decision = updateSiteMetadata(store, FATIMA, CORINNE, { latitude: -112.1965, longitude: 41.6337 }, { now: NOW, ifMatch: 12 });
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.status, 422);
  assert.equal(decision.fieldErrors[0]?.fieldPath, 'latitude');
  assert.equal(decision.fieldErrors[0]?.code, 'LATITUDE_OUT_OF_UTAH');
  assert.equal(store.siteById(CORINNE)?.latitude, 41.6337);
});

test('coordinate validation: out-of-range and non-numeric coordinates are rejected', () => {
  const store = createSiteStore();
  const cases: ReadonlyArray<[Partial<Record<'latitude' | 'longitude', number>>, string, string]> = [
    [{ latitude: 93.5 }, 'latitude', 'LATITUDE_OUT_OF_UTAH'],
    [{ latitude: Number.NaN }, 'latitude', 'COORDINATE_NOT_NUMERIC'],
    [{ longitude: 200 }, 'longitude', 'LONGITUDE_OUT_OF_UTAH'],
    [{ longitude: -100 }, 'longitude', 'LONGITUDE_OUT_OF_UTAH'],
  ];
  for (const [patch, fieldPath, code] of cases) {
    const decision = updateSiteMetadata(store, FATIMA, CORINNE, patch, { now: NOW, ifMatch: 12 });
    assert.equal(decision.outcome, 'rejected', `${JSON.stringify(patch)}`);
    assert.equal(decision.fieldErrors[0]?.fieldPath, fieldPath);
    assert.equal(decision.fieldErrors[0]?.code, code);
  }
});

test('elevation and capacity validation', () => {
  const store = createSiteStore();
  const elevation = updateSiteMetadata(store, FATIMA, CORINNE, { elevationFt: 25000 }, { now: NOW, ifMatch: 12 });
  assert.equal(elevation.fieldErrors[0]?.code, 'ELEVATION_INVALID');
  const capacity = updateSiteMetadata(store, FATIMA, CORINNE, { capacities: { maxDiversionCfs: -10 } }, { now: NOW, ifMatch: 12 });
  assert.equal(capacity.fieldErrors[0]?.fieldPath, 'capacities.maxDiversionCfs');
  assert.equal(capacity.fieldErrors[0]?.code, 'CAPACITY_INVALID');
  const ok = updateSiteMetadata(store, FATIMA, CORINNE, { capacities: { maxDiversionCfs: 1200, storageAcreFeet: null } }, { now: NOW, ifMatch: 12 });
  assert.equal(ok.outcome, 'applied');
});

// ---------------------------------------------------------------------------
// Site creation (FR-031)
// ---------------------------------------------------------------------------

test('an engineer creates a site inside their system: proposed lifecycle, version 1, audited', () => {
  const store = createSiteStore();
  const decision = createSite(
    store,
    FATIMA,
    { displayName: 'Cottonwood Creek near Mendon', systemId: 'sys-bear-river', siteTypeId: 'natural-channel', latitude: 41.71, longitude: -111.94, elevationFt: 4460, stateCode: 'UT', capacities: { maxDiversionCfs: 32 } },
    { now: NOW },
  );
  assert.equal(decision.outcome, 'applied');
  assert.equal(decision.status, 201);
  assert.equal(decision.site.status, 'proposed', 'new sites start proposed, not active');
  assert.equal(decision.site.version, 1);
  assert.ok(decision.site.id.startsWith('sta-new-'));
  assert.equal(store.auditEvents[0]?.action, 'create-site');
  assert.equal(store.siteById(decision.site.id)?.displayName, 'Cottonwood Creek near Mendon');
});

test('creation outside the actor system is denied; creation requires coordinates up front', () => {
  const store = createSiteStore();
  const crossSystem = createSite(store, FATIMA, { displayName: 'Weber site', systemId: 'sys-weber-river', siteTypeId: 'natural-channel', latitude: 41.2, longitude: -111.5, stateCode: 'UT' }, { now: NOW });
  assert.equal(crossSystem.outcome, 'rejected');
  assert.equal(crossSystem.status, 403);
  assert.equal(crossSystem.policyReason, 'DENY_OUT_OF_SCOPE');
  const missingCoordinates = createSite(store, FATIMA, { displayName: 'No coords', systemId: 'sys-bear-river', siteTypeId: 'natural-channel', stateCode: 'UT' }, { now: NOW });
  assert.equal(missingCoordinates.outcome, 'rejected');
  assert.equal(missingCoordinates.status, 422);
  assert.deepEqual(
    missingCoordinates.fieldErrors.map((error) => error.fieldPath),
    ['latitude', 'longitude'],
  );
});

// ---------------------------------------------------------------------------
// Effective-dated measurement setups (FR-033)
// ---------------------------------------------------------------------------

test('the fixture device history loads as effective-dated epochs', () => {
  const store = createSiteStore();
  // str-corinne-q: dev-rtu-corinne-01 until 2026-03-07T18:30Z, then -02.
  const before = store.epochAt('str-corinne-q', '2026-03-06T18:00:00Z');
  assert.equal(before?.deviceId, 'dev-rtu-corinne-01');
  assert.equal(before?.serial, 'FL-8821');
  const after = store.epochAt('str-corinne-q', '2026-03-08T20:00:00Z');
  assert.equal(after?.deviceId, 'dev-rtu-corinne-02');
});

test('device replacement appends a NEW epoch and NEVER rewrites history (FR-033)', () => {
  const store = createSiteStore();
  const beforeChange = store.epochAt('str-corinne-stage', '2026-03-08T20:00:00Z');
  assert.equal(beforeChange?.deviceId, 'dev-pressure-corinne-01');
  assert.equal(beforeChange?.effectiveTo, null);

  const decision = replaceMeasurementSetup(
    store,
    FATIMA,
    'str-corinne-stage',
    { deviceId: 'dev-pressure-corinne-02', serial: 'PT-9911', model: 'AquaPress 3', effectiveFrom: '2026-03-10T00:00:00Z' },
    { now: NOW },
  );
  assert.equal(decision.outcome, 'applied');
  const epoch = decision.created;
  assert.equal(epoch?.deviceId, 'dev-pressure-corinne-02');
  assert.equal(epoch?.effectiveTo, null);

  // The OLD epoch is closed, not edited away - and readings recorded under
  // it still resolve to the ORIGINAL device and method context.
  const oldReading = store.epochAt('str-corinne-stage', '2026-03-08T20:00:00Z');
  assert.equal(oldReading?.deviceId, 'dev-pressure-corinne-01');
  assert.equal(oldReading?.serial, 'PT-4407');
  assert.equal(oldReading?.effectiveTo, '2026-03-10T00:00:00Z', 'closed at the replacement instant, half-open');
  assert.equal(oldReading?.id, beforeChange?.id, 'the same record - no rewrite');
  // New readings resolve to the new device.
  const newReading = store.epochAt('str-corinne-stage', '2026-03-10T12:00:00Z');
  assert.equal(newReading?.deviceId, 'dev-pressure-corinne-02');
  // Method context flows from the epoch, unchanged for old readings.
  assert.equal(oldReading?.methodTypeId, 'method-pressure-transducer');
  assert.equal(newReading?.methodTypeId, 'method-pressure-transducer');
});

test('a setup change bumps the stream setup version (the readings import re-verification anchor)', () => {
  const store = createSiteStore();
  const before = store.streamSetupVersion('str-corinne-stage');
  replaceMeasurementSetup(
    store,
    FATIMA,
    'str-corinne-stage',
    { deviceId: 'dev-pressure-corinne-03', serial: 'PT-9912', model: 'AquaPress 3', effectiveFrom: '2026-04-01T00:00:00Z' },
    { now: NOW },
  );
  assert.equal(store.streamSetupVersion('str-corinne-stage'), before + 1);
  assert.equal(store.currentEpoch('str-corinne-stage')?.setupVersion, before + 1);
});

test('backdating over a closed epoch is rejected; setups are effective-dated forward only', () => {
  const store = createSiteStore();
  const decision = replaceMeasurementSetup(
    store,
    FATIMA,
    'str-corinne-q',
    { deviceId: 'dev-rtu-corinne-03', serial: 'FL-9200', model: 'FlumeLog 300', effectiveFrom: '2025-01-01T00:00:00Z' },
    { now: NOW },
  );
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.fieldErrors[0]?.code, 'EFFECTIVE_DATE_NOT_FORWARD');
  assert.equal(store.epochsOf('str-corinne-q').length, 2, 'no epoch was appended');
});

test('setup replacement is scope-checked: cross-system engineer denied, out-of-scope audit stays empty', () => {
  const store = createSiteStore();
  const decision = replaceMeasurementSetup(
    store,
    PRIYA,
    'str-corinne-stage',
    { deviceId: 'dev-x', serial: 'S-1', model: 'M', effectiveFrom: '2026-04-01T00:00:00Z' },
    { now: NOW },
  );
  assert.equal(decision.outcome, 'rejected');
  assert.equal(decision.status, 403);
  assert.equal(store.epochsOf('str-corinne-stage').length, 1);
});

// ---------------------------------------------------------------------------
// Threshold versioning (FR-034)
// ---------------------------------------------------------------------------

test('thresholds version forward per site and metric: v1 closes, v2 becomes current, both retained', () => {
  const store = createSiteStore();
  const v1 = setCapacityThresholds(store, FATIMA, CORINNE, { metric: 'discharge', label: 'High flow advisory', upperBound: 900, effectiveFrom: '2026-01-01T00:00:00Z' }, { now: NOW });
  assert.equal(v1.outcome, 'applied');
  assert.equal(v1.created?.version, 1);
  const v2 = setCapacityThresholds(store, FATIMA, CORINNE, { metric: 'discharge', label: 'High flow advisory (revised)', upperBound: 950, effectiveFrom: '2026-03-01T00:00:00Z' }, { now: LATER });
  assert.equal(v2.outcome, 'applied');
  assert.equal(v2.created?.version, 2);
  const history = store.thresholdsFor(CORINNE, 'discharge');
  assert.equal(history.length, 2, 'the superseded threshold is retained, never overwritten');
  assert.equal(history[0]?.effectiveTo, '2026-03-01T00:00:00Z');
  assert.equal(history[0]?.upperBound, 900);
  assert.equal(history[1]?.effectiveTo, null, 'the current threshold');
  assert.equal(history[1]?.upperBound, 950);
  // A second metric versions independently.
  const stage = setCapacityThresholds(store, FATIMA, CORINNE, { metric: 'stage', label: 'Bank full', upperBound: 11.5, effectiveFrom: '2026-03-01T00:00:00Z' }, { now: LATER });
  assert.equal(stage.created?.version, 1);
});

test('threshold validation: metric must be measured at the site, bounds sane, label required', () => {
  const store = createSiteStore();
  const wrongMetric = setCapacityThresholds(store, FATIMA, CORINNE, { metric: 'voltage', label: 'X', upperBound: 12, effectiveFrom: '2026-01-01T00:00:00Z' }, { now: NOW });
  assert.equal(wrongMetric.outcome, 'rejected');
  assert.equal(wrongMetric.fieldErrors[0]?.code, 'METRIC_NOT_ON_SITE');
  const inverted = setCapacityThresholds(store, FATIMA, CORINNE, { metric: 'discharge', label: 'X', lowerBound: 100, upperBound: 50, effectiveFrom: '2026-01-01T00:00:00Z' }, { now: NOW });
  assert.equal(inverted.fieldErrors[0]?.code, 'BOUNDS_INVERTED');
  const unbounded = setCapacityThresholds(store, FATIMA, CORINNE, { metric: 'discharge', label: 'X', effectiveFrom: '2026-01-01T00:00:00Z' }, { now: NOW });
  assert.equal(unbounded.fieldErrors[0]?.code, 'BOUND_REQUIRED');
  const unlabeled = setCapacityThresholds(store, FATIMA, CORINNE, { metric: 'discharge', label: '  ', upperBound: 900, effectiveFrom: '2026-01-01T00:00:00Z' }, { now: NOW });
  assert.equal(unlabeled.fieldErrors[0]?.code, 'LABEL_REQUIRED');
  assert.equal(store.thresholdsFor(CORINNE, 'discharge').length, 0);
});

// ---------------------------------------------------------------------------
// FR-023: history survives actor deactivation
// ---------------------------------------------------------------------------

test('edit history survives actor deactivation: audit entries stay, the actor stays resolvable but inert', () => {
  const store = createSiteStore();
  updateSiteMetadata(store, FATIMA, CORINNE, { displayName: 'Bear River at Corinne' }, { now: NOW, ifMatch: 12 });
  const editsBefore = store.auditEvents.filter((event) => event.actorId === FATIMA).length;
  assert.equal(editsBefore, 1);

  // The authoritative snapshot deactivates Fatima (FR-011: record stays
  // resolvable, every decision denies).
  const deactivatedWorld = withPrincipal(store.world, FATIMA, { active: false });
  const actorStillResolvable = resolveActor(deactivatedWorld, FATIMA);
  assert.equal(actorStillResolvable?.id, FATIMA);
  assert.equal(actorStillResolvable?.active, false);

  // History is untouched by the deactivation...
  assert.equal(store.auditEvents.filter((event) => event.actorId === FATIMA).length, 1);
  const event = store.auditEvents.find((entry) => entry.actorId === FATIMA);
  assert.equal(event?.changes[0]?.before, 'Bear River near Corinne');
  assert.equal(event?.changes[0]?.after, 'Bear River at Corinne');

  // ...and the deactivated actor can no longer edit (401, engine reason).
  const denied = updateSiteMetadata(
    store.withWorld(deactivatedWorld),
    FATIMA,
    CORINNE,
    { displayName: 'Should not apply' },
    { now: LATER, ifMatch: 13 },
  );
  assert.equal(denied.outcome, 'rejected');
  assert.equal(denied.status, 401);
  assert.equal(denied.policyReason, 'DENY_PRINCIPAL_INACTIVE');
  assert.equal(store.siteById(CORINNE)?.displayName, 'Bear River at Corinne');
});
