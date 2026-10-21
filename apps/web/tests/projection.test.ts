/**
 * Public-projection tests. The helper is a DEMO-ONLY browser-side
 * demonstration; real enforcement is WD-004's server policy. These tests pin
 * the demo behavior the shell promises:
 *
 * - the restricted operational block (gate code, wiring notes) is absent from
 *   public, water-user, researcher, commissioner and out-of-scope-engineer
 *   projections (FR-049: row visibility alone is not sufficient —
 *   sta-bear-corinne is public yet carries an internal block);
 * - it is present only for the assigned engineer persona (capability
 *   view-internal-diagnostics inside scope) and the statewide steward;
 * - row and stream visibility follow the fixture entitlements.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Extensionless src imports under node --test (see ts-resolve-hook.mjs).
register('./ts-resolve-hook.mjs', import.meta.url);

const projectionPath = '../src/shell/data/projection.ts';
const projection: typeof import('../src/shell/data/projection') = await import(projectionPath);
const fixturesPath = '../src/shell/data/fixtures.ts';
const fixtures: typeof import('../src/shell/data/fixtures') = await import(fixturesPath);
const personasPath = '../src/shell/data/personas.ts';
const personasModule: typeof import('../src/shell/data/personas') = await import(personasPath);
type Viewer = import('../src/shell/data/projection').Viewer;

const corinne = fixtures.stationById.get('sta-bear-corinne')!;
const hyrumOwner = fixtures.stationById.get('sta-hyrum-diversion-owner')!;
const diagnostic = fixtures.stationById.get('sta-bear-lake-diagnostic')!;
const ogden = fixtures.stationById.get('sta-ogden-valley-proposed')!;

function viewerOf(personaId: string) {
  return personasModule.viewerFor(personasModule.personaById(personaId));
}

const catalogIds = (viewer: Viewer) => projection.projectCatalog(viewer).map((station) => station.id);

test('public projection never carries restricted fields, even for a public station', () => {
  const publicFields = projection.publicStationFields(corinne);
  assert.equal(publicFields.internal, null);
  const serialized = JSON.stringify(projection.projectCatalog(viewerOf('donna')));
  assert.ok(!serialized.includes('4471-CDX'), 'gate code absent');
  assert.ok(!serialized.includes('9917-KWW'));
  assert.ok(!serialized.includes('gateCode'));
  assert.ok(!serialized.includes('wiringNotes'));
  assert.ok(serialized.includes('Bear River near Corinne'));
  // A station that is not publicly visible cannot be projected at all.
  assert.throws(() => projection.publicStationFields(hyrumOwner), /not publicly visible/);
});

test('never display the gate-code field for public, water-user or researcher personas', () => {
  for (const personaId of ['donna', 'wiley', 'sarah']) {
    for (const station of projection.projectCatalog(viewerOf(personaId))) {
      assert.equal(station.internal, null, `${personaId} must not see internal block on ${station.id}`);
    }
  }
});

test('row visibility follows the fixture entitlements per persona', () => {
  assert.deepEqual(catalogIds(viewerOf('donna')), ['sta-bear-corinne', 'sta-hyrum-diversion-public', 'sta-summit-creek-inactive']);
  assert.deepEqual(catalogIds(viewerOf('sarah')), ['sta-bear-corinne', 'sta-hyrum-diversion-public', 'sta-summit-creek-inactive']);
  assert.deepEqual(catalogIds(viewerOf('wiley')), ['sta-bear-corinne', 'sta-hyrum-diversion-public', 'sta-hyrum-diversion-owner', 'sta-summit-creek-inactive']);
  assert.deepEqual(catalogIds(viewerOf('cody')), [
    'sta-bear-corinne',
    'sta-hyrum-diversion-public',
    'sta-hyrum-diversion-owner',
    'sta-bear-lake-diagnostic',
    'sta-summit-creek-inactive',
  ]);
  assert.deepEqual(catalogIds(viewerOf('fatima')), catalogIds(viewerOf('cody')));
  assert.deepEqual(catalogIds(viewerOf('diego')), [
    'sta-bear-corinne',
    'sta-hyrum-diversion-public',
    'sta-hyrum-diversion-owner',
    'sta-bear-lake-diagnostic',
    'sta-summit-creek-inactive',
    'sta-ogden-valley-proposed',
  ]);
});

test('the assigned engineer persona sees the restricted block inside her scope only', () => {
  const fatima = viewerOf('fatima');
  const corinneView = projection.projectStation(fatima, corinne)!;
  assert.equal(corinneView.internal?.gateCode, '4471-CDX');
  assert.ok(corinneView.internal?.wiringNotes.includes('RTU enclosure'));
  assert.equal(projection.projectStation(fatima, hyrumOwner)!.internal?.gateCode, '9917-KWW');
  assert.equal(projection.projectStation(fatima, diagnostic)!.internal?.gateCode, '2208-QQZ');
  assert.equal(projection.projectStation(fatima, ogden), null, 'Weber River station outside her assignment');
});

test('an engineer assigned to the other system gets nothing from Bear River internals', () => {
  const priya: Viewer = { personaId: 'priya', role: 'engineer', principalId: 'principal-priya-engineer', organizationId: null };
  // sta-bear-corinne is public, so Priya sees the row…
  const corinneView = projection.projectStation(priya, corinne)!;
  assert.ok(corinneView, 'public row visible');
  // …but the internal block is stripped: capability scope is Bear River only for others.
  assert.equal(corinneView.internal, null);
  assert.equal(projection.projectStation(priya, hyrumOwner), null);
  assert.equal(projection.projectStation(priya, diagnostic), null);
  const ogdenView = projection.projectStation(priya, ogden)!;
  assert.ok(ogdenView, 'her own Weber River assignment is visible');
  assert.equal(ogdenView.internal, null, 'no view-internal-diagnostics capability in her grant');
});

test('commissioner and deputy see assigned rows but not the internal block', () => {
  const cody = viewerOf('cody');
  assert.equal(projection.projectStation(cody, corinne)!.internal, null);
  assert.equal(projection.projectStation(cody, diagnostic)!.internal, null);
  const ana: Viewer = { personaId: 'ana', role: 'deputy', principalId: 'principal-ana-deputy', organizationId: null };
  const anaActive = fixtures.activeEntitlements('principal-ana-deputy');
  assert.equal(anaActive.length, 1, 'time-bounded delegation is active at the fixture clock');
  assert.ok(projection.projectStation(ana, hyrumOwner), 'deputy sees delegated-system restricted row');
  assert.equal(projection.projectStation(ana, hyrumOwner)!.internal, null);
  assert.equal(projection.projectStation(ana, ogden), null, 'delegation never extends statewide');
});

test('steward sees the statewide catalog with internal blocks', () => {
  const diego = viewerOf('diego');
  // Stations that carry an internal block in the fixture:
  for (const station of [corinne, hyrumOwner, diagnostic]) {
    const view = projection.projectStation(diego, station)!;
    assert.ok(view.internal, `steward sees internal block on ${station.id}`);
  }
  // ogden has no internal block in the fixture at all; statewide role cannot invent one.
  assert.equal(projection.projectStation(diego, ogden)!.internal, null);
});

test('restricted datastreams surface only for owner, assigned staff and steward', () => {
  const wiley = viewerOf('wiley');
  const wileyOwnerStation = projection.projectStation(wiley, hyrumOwner)!;
  assert.ok(wileyOwnerStation.streamIds.includes('str-hyrum-q-owner'), 'organization owner sees the restricted stream');
  const donnaHyrumPublic = projection.projectStation(viewerOf('donna'), fixtures.stationById.get('sta-hyrum-diversion-public')!)!;
  assert.deepEqual(donnaHyrumPublic.streamIds, ['str-hyrum-q-public']);
  const fatimaCorinne = projection.projectStation(viewerOf('fatima'), corinne)!;
  assert.deepEqual(fatimaCorinne.streamIds, ['str-corinne-q', 'str-corinne-stage']);
  const codyDiagnostic = projection.projectStation(viewerOf('cody'), diagnostic)!;
  assert.deepEqual(codyDiagnostic.streamIds, ['str-diag-voltage'], 'internal stream visible to assigned commissioner');
});
