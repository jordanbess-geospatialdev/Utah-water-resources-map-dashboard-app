/**
 * URL state serialization round-trip tests (FR-008 basics): versioned,
 * canonical, non-sensitive. The demo persona must never travel in a link, and
 * an inaccessible selected station is omitted and reported, never kept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Extensionless src imports under node --test (see ts-resolve-hook.mjs).
register('./ts-resolve-hook.mjs', import.meta.url);

const viewStatePath = '../src/shell/data/viewState.ts';
const viewState: typeof import('../src/shell/data/viewState') = await import(viewStatePath);
type ViewState = import('../src/shell/data/viewState').ViewState;

const representative: ViewState = {
  view: 'sites',
  stationId: 'sta-bear-corinne',
  systemId: 'sys-bear-river',
  siteTypeId: 'flume',
  telemetry: 'telemetered',
  days: 14,
  basemap: 'street',
  map: { center: [-111.8524, 41.6295], zoom: 9.25 },
};

test('serialize/parse round-trip preserves the view state', () => {
  const query = viewState.serializeViewState(representative);
  const parsed = viewState.parseViewState(`?${query}`);
  assert.deepEqual(parsed, representative);
  // Canonical: serializing the parsed state reproduces the same query.
  assert.equal(viewState.serializeViewState(parsed!), query);
  assert.equal(viewState.roundTrip(representative)!.view, 'sites');
});

test('round-trips hold for defaults and edge values', () => {
  assert.deepEqual(viewState.roundTrip(viewState.defaultViewState), viewState.defaultViewState);
  const minimal: ViewState = { ...viewState.defaultViewState, stationId: null, systemId: 'all', siteTypeId: 'all' };
  assert.deepEqual(viewState.roundTrip(minimal), minimal);
});

test('unknown or missing versions parse to null, not to guesses', () => {
  assert.equal(viewState.parseViewState(''), null);
  assert.equal(viewState.parseViewState('?view=sites&station=sta-bear-corinne'), null, 'missing version');
  assert.equal(viewState.parseViewState('?v=2&view=sites'), null, 'future version');
  assert.equal(viewState.parseViewState('?v=abc&view=sites'), null, 'malformed version');
});

test('invalid values fall back safely instead of failing the parse', () => {
  const parsed = viewState.parseViewState('?v=1&view=hack&station=UT;001&days=99&basemap=satellite&telemetry=carrier&zoom=99&center=999,999')!;
  assert.equal(parsed.view, viewState.defaultViewState.view, 'unknown view falls back');
  assert.equal(parsed.stationId, null, 'station ids are restricted to safe characters');
  assert.equal(parsed.days, viewState.defaultViewState.days);
  assert.equal(parsed.basemap, viewState.defaultViewState.basemap);
  assert.equal(parsed.telemetry, viewState.defaultViewState.telemetry);
  assert.deepEqual(parsed.map, viewState.defaultViewState.map, 'out-of-range camera falls back');
  const sanitized = viewState.parseViewState('?v=1&system=sys-bear%3Cscript%3E')!;
  assert.ok(!viewState.serializeViewState(sanitized).includes('<'), 'serialization carries no injection surface');
});

test('persona, credentials and internal fields never travel in the URL', () => {
  const query = viewState.serializeViewState(representative);
  assert.ok(!query.includes('persona'), 'no persona param');
  assert.ok(!query.includes('role'), 'no role param');
  assert.ok(!query.includes('token'), 'no credential-shaped params');
  assert.ok(!query.includes('gateCode') && !query.includes('4471-CDX'), 'no restricted field names or values');
  // A hostile link trying to smuggle a persona is ignored on parse.
  const parsed = viewState.parseViewState(`?${query}&persona=fatima&role=steward&principalId=principal-diego-steward`)!;
  assert.deepEqual(parsed, representative);
  assert.ok(!viewState.serializeViewState(parsed).includes('persona'));
});

test('applyViewState omits an inaccessible selection and reports it', () => {
  const permitted = ['sta-bear-corinne', 'sta-hyrum-diversion-public', 'sta-summit-creek-inactive'];
  const denied = viewState.applyViewState({ ...representative, stationId: 'sta-hyrum-diversion-owner' }, permitted);
  assert.equal(denied.state.stationId, null, 'inaccessible station omitted');
  assert.equal(denied.deniedStationId, 'sta-hyrum-diversion-owner', 'omission is reported for a clear message');
  const allowed = viewState.applyViewState({ ...representative, stationId: 'sta-bear-corinne' }, permitted);
  assert.equal(allowed.state.stationId, 'sta-bear-corinne');
  assert.equal(allowed.deniedStationId, null);
});
