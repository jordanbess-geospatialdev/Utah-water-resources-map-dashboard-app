/**
 * FilterSet tests (FR-002, FR-008; T-01): AND across dimensions, OR within a
 * dimension, telemetry unknown-vs-none, canonical serialization, redaction of
 * free text and restricted identifiers, and unknown-vocabulary inspectability.
 *
 * Run:
 *   cd apps/web && node --test --experimental-strip-types src/features/discovery/filters.test.ts
 *
 * (Import pattern per apps/web/tests/adapters.test.ts: computed specifiers for
 * node --test --experimental-strip-types, type-only imports for tsc.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { DiscoveryFilterSet, FilterDimensionKey } from './filters';

// Extensionless src imports under node --test (see tests/ts-resolve-hook.mjs).
register('../../../tests/ts-resolve-hook.mjs', import.meta.url);

const filtersPath = './filters.ts';
const f: typeof import('./filters') = await import(filtersPath);
const fixturesPath = '../../shell/data/fixtures.ts';
const fixtures: typeof import('../../shell/data/fixtures') = await import(fixturesPath);

const ids = (list: readonly { id: string }[]) => list.map((station) => station.id);

function match(filterset: DiscoveryFilterSet): string[] {
  return ids(f.filterPublicStations(filterset));
}

test('the public catalog is the public projection row set, in fixture order', () => {
  assert.deepEqual(ids(f.publicDiscoveryStations), ['sta-bear-corinne', 'sta-hyrum-diversion-public', 'sta-summit-creek-inactive']);
  assert.ok(!f.RESTRICTED_OBJECT_IDS.has('sta-bear-corinne'), 'public stations are not restricted identifiers');
});

test('OR within a dimension: multiple site types union', () => {
  assert.deepEqual(match({ siteTypeIds: ['flume'] }), ['sta-hyrum-diversion-public']);
  assert.deepEqual(match({ siteTypeIds: ['flume', 'weir'] }), ['sta-hyrum-diversion-public', 'sta-summit-creek-inactive']);
});

test('AND across dimensions: system ∩ site type ∩ provider', () => {
  assert.deepEqual(
    match({ distributionSystemIds: ['sys-bear-river'], siteTypeIds: ['flume'], providerIds: ['prov-coop-manual'] }),
    ['sta-hyrum-diversion-public'],
  );
  assert.deepEqual(match({ distributionSystemIds: ['sys-bear-river'], siteTypeIds: ['weir'], telemetry: ['telemetered'] }), []);
});

test('telemetry tri-state: "unknown" is a selection distinct from an absent key (FR-002)', () => {
  assert.deepEqual(match({ telemetry: ['telemetered'] }), ['sta-bear-corinne']);
  assert.deepEqual(match({ telemetry: ['manual'] }), ['sta-hyrum-diversion-public', 'sta-summit-creek-inactive']);
  // The only station with unknown telemetry is restricted: legal, serializable, matches nothing publicly.
  assert.deepEqual(match({ telemetry: ['unknown'] }), []);
  // Same carried data, but three distinguishable queries:
  assert.notEqual(f.serializeFilters({ telemetry: ['manual'] }), f.serializeFilters({ telemetry: ['manual', 'unknown'] }));
  assert.equal(f.serializeFilters({ telemetry: ['manual'] }), f.serializeFilters({ telemetry: ['manual'] }));
  assert.equal(f.serializeFilters({}), f.serializeFilters({ telemetry: [] }));
});

test('sentinel "unknown" on subgroups selects unset values; an absent key does not', () => {
  assert.deepEqual(match({ subgroupIds: ['sub-bear-logan-canyon'] }), ['sta-hyrum-diversion-public', 'sta-summit-creek-inactive']);
  assert.deepEqual(match({ subgroupIds: ['unknown'] }), ['sta-bear-corinne']); // no subgroup assigned
  assert.deepEqual(match({ subgroupIds: ['unknown', 'sub-bear-logan-canyon'] }), ids(f.publicDiscoveryStations));
});

test('ungoverned dimensions (structure, device) match only their unset sentinel', () => {
  assert.deepEqual(match({ controlStructureIds: ['some-future-structure'] }), []);
  assert.deepEqual(match({ measuringDeviceTypeIds: ['dev-rtu-corinne-01'] }), [], 'device ids are not governed filter values');
  assert.deepEqual(match({ structureMaterialIds: ['unknown'] }), ids(f.publicDiscoveryStations), 'unset matches every record');
});

test('known-but-empty vs unknown: a governed system with no public stations is still known', () => {
  assert.equal(f.classifyFilterValue('distributionSystemIds', 'sys-weber-river'), 'known');
  assert.deepEqual(match({ distributionSystemIds: ['sys-weber-river'] }), [], 'known id, zero public rows — not an unknown value');
  assert.equal(f.classifyFilterValue('siteTypeIds', 'diagnostic'), 'unknown', 'site type of the internal-only station is not public vocabulary');
});

test('observed property, method and time step facets come from public streams only', () => {
  assert.deepEqual(match({ observedPropertyIds: ['discharge'] }), ids(f.publicDiscoveryStations));
  assert.deepEqual(match({ observedPropertyIds: ['stage'] }), ['sta-bear-corinne']);
  const voltage = f.dimensionByKey('observedPropertyIds').values.find((value) => value.id === 'voltage')!;
  assert.ok(/internal diagnostic/i.test(voltage.note ?? ''), 'voltage is governed vocabulary with an explicit not-publicly-selectable note');
  assert.equal(f.classifyFilterValue('observedPropertyIds', 'voltage'), 'known');
  assert.deepEqual(match({ observedPropertyIds: ['voltage'] }), [], 'known id, but no public stream carries it');
  assert.deepEqual(match({ measurementMethodTypeIds: ['method-current-meter'] }), ['sta-hyrum-diversion-public']);
  assert.deepEqual(match({ timeStepIds: ['hourly'] }), ['sta-bear-corinne']);
  assert.deepEqual(match({ timeStepIds: ['weekly'] }), ['sta-hyrum-diversion-public', 'sta-summit-creek-inactive']);
  assert.equal(f.timeStepIdForCadence(10080), 'weekly');
});

test('processing levels derive from public observations and revisions', () => {
  const corinne = fixtures.stations.find((station) => station.id === 'sta-bear-corinne')!;
  const hyrum = fixtures.stations.find((station) => station.id === 'sta-hyrum-diversion-public')!;
  const summit = fixtures.stations.find((station) => station.id === 'sta-summit-creek-inactive')!;
  assert.deepEqual(f.processingLevelsForStation(corinne), ['best-available', 'provisional', 'raw', 'reviewed']);
  assert.deepEqual(f.processingLevelsForStation(hyrum), ['raw']);
  assert.deepEqual(f.processingLevelsForStation(summit), []);
  assert.deepEqual(match({ processingLevels: ['reviewed'] }), ['sta-bear-corinne']);
  assert.deepEqual(match({ processingLevels: ['raw'] }), ['sta-bear-corinne', 'sta-hyrum-diversion-public']);
  assert.deepEqual(match({ processingLevels: ['unknown'] } as unknown as DiscoveryFilterSet), ['sta-summit-creek-inactive'], 'no levels carried = unknown/unset');
});

test('canonicalizeFilters dedupes, sorts, drops empties and reports redactions', () => {
  const result = f.canonicalizeFilters({
    siteTypeIds: ['weir', 'flume', 'weir'],
    telemetry: [],
    providerIds: ['FlumeLog 200', 'prov-coop-manual', 'sta-hyrum-diversion-owner', 'principal-fatima-engineer'],
  } as unknown as Partial<DiscoveryFilterSet>);
  assert.deepEqual(result.filters, { siteTypeIds: ['flume', 'weir'], providerIds: ['prov-coop-manual'] });
  const reasons = Object.fromEntries(result.redactions.map((redaction) => [redaction.value, redaction.reason]));
  assert.equal(reasons['FlumeLog 200'], 'free-text', 'free-text models are never filter values');
  assert.equal(reasons['sta-hyrum-diversion-owner'], 'restricted-identifier');
  assert.equal(reasons['principal-fatima-engineer'], 'restricted-identifier');
  // Idempotent, and serialization is byte-stable regardless of input order/duplicates.
  const again = f.canonicalizeFilters(result.filters);
  assert.deepEqual(again.filters, result.filters);
  assert.equal(
    f.serializeFilters(result.filters),
    f.serializeFilters(f.canonicalizeFilters({ siteTypeIds: ['weir', 'flume', 'flume'], providerIds: ['prov-coop-manual', 'prov-coop-manual'] }).filters),
  );
});

test('canonicalization redacts gate codes, wiring notes and other hostile values', () => {
  const hostile = {
    waterSourceTypeIds: ['4471-CDX', 'surface-natural-flow'],
    observedPropertyIds: ['<script>alert(1)</script>', `${'a'.repeat(5000)}`],
    subgroupIds: [42 as unknown as string],
  } as unknown as Partial<DiscoveryFilterSet>;
  const result = f.canonicalizeFilters(hostile);
  assert.deepEqual(result.filters, { waterSourceTypeIds: ['surface-natural-flow'] });
  const serialized = f.serializeFilters(result.filters);
  assert.ok(!serialized.includes('4471'), 'gate codes never serialize');
  assert.ok(!serialized.includes('script'), 'markup never serializes');
  assert.ok(result.redactions.length >= 3);
});

test('unknown-but-well-formed values are kept and reported, distinguishable from known ones', () => {
  const result = f.canonicalizeFilters({ siteTypeIds: ['flume', 'future-site-type'], observedPropertyIds: ['turbidity'] });
  assert.deepEqual(result.filters, { siteTypeIds: ['flume', 'future-site-type'], observedPropertyIds: ['turbidity'] });
  assert.deepEqual(result.unknownValues, { siteTypeIds: ['future-site-type'], observedPropertyIds: ['turbidity'] });
  assert.equal(f.classifyFilterValue('siteTypeIds', 'future-site-type'), 'unknown');
  assert.equal(f.classifyFilterValue('siteTypeIds', 'flume'), 'known');
});

test('enum dimensions reject non-members outright (not "unknown")', () => {
  assert.equal(f.classifyFilterValue('telemetry', 'carrier-pigeon'), 'rejected');
  assert.equal(f.classifyFilterValue('siteStatusIds', 'deleted'), 'rejected');
  const result = f.canonicalizeFilters({ telemetry: ['manual', 'carrier-pigeon'], siteStatusIds: ['active'] } as unknown as Partial<DiscoveryFilterSet>);
  assert.deepEqual(result.filters, { telemetry: ['manual'], siteStatusIds: ['active'] });
  assert.deepEqual(result.redactions, [{ dimension: 'telemetry', value: 'carrier-pigeon', reason: 'not-enum-member' }]);
});

test('cardinality is capped with an explicit redaction, never a silent truncation', () => {
  const many = Array.from({ length: f.MAX_VALUES_PER_DIMENSION + 5 }, (_, index) => `bulk-${String(index).padStart(2, '0')}`);
  const result = f.canonicalizeFilters({ siteTypeIds: many });
  assert.equal((result.filters.siteTypeIds ?? []).length, f.MAX_VALUES_PER_DIMENSION);
  assert.equal(result.redactions.filter((redaction) => redaction.reason === 'cardinality').length, 5);
});

test('serialize/parse round-trips canonical filters, ignoring unknown dimension keys', () => {
  const original: DiscoveryFilterSet = {
    distributionSystemIds: ['sys-bear-river'],
    siteTypeIds: ['flume', 'weir'],
    telemetry: ['manual', 'unknown'],
    processingLevels: ['raw'],
    siteTypeIds_duplicate_ignored: undefined,
  } as unknown as DiscoveryFilterSet;
  const serialized = f.serializeFilters(original);
  const parsed = f.parseFilters(serialized);
  assert.equal(parsed.ignoredKeys.length, 0);
  assert.equal(f.serializeFilters(parsed.filters), serialized, 'round-trip is byte-stable');
  assert.deepEqual(parsed.filters, f.canonicalizeFilters(original).filters);
  const hostile = f.parseFilters('telemetry=manual;evilKey=anything;siteTypeIds=flume');
  assert.deepEqual(hostile.ignoredKeys, ['evilKey']);
  assert.deepEqual(hostile.filters, { telemetry: ['manual'], siteTypeIds: ['flume'] });
});

test('applied chips describe every applied value, marking unknown ones', () => {
  const chips = f.appliedFilterChips({ telemetry: ['unknown'], siteTypeIds: ['flume', 'mystery-type'] });
  assert.equal(chips.length, 3);
  const unknownSiteType = chips.find((chip) => chip.value === 'mystery-type')!;
  assert.equal(unknownSiteType.known, false);
  assert.match(unknownSiteType.valueLabel, /unknown value/);
  const telemetryUnknown = chips.find((chip) => chip.dimension === 'telemetry')!;
  assert.equal(telemetryUnknown.known, true);
  assert.match(telemetryUnknown.valueLabel, /not established/);
  const cleared = f.withoutFilterValue({ siteTypeIds: ['flume', 'weir'] }, 'siteTypeIds', 'flume');
  assert.deepEqual(cleared, { siteTypeIds: ['weir'] });
  assert.equal(f.hasActiveFilters({}), false);
  assert.equal(f.hasActiveFilters({ siteStatusIds: ['active'] }), true);
});

test('every dimension key matches its registry entry and the schema order is canonical', () => {
  assert.deepEqual(
    f.DISCOVERY_DIMENSION_KEYS,
    [
      'distributionSystemIds',
      'subgroupIds',
      'siteTypeIds',
      'telemetry',
      'providerIds',
      'observedPropertyIds',
      'controlStructureIds',
      'structureMaterialIds',
      'structureSizeIds',
      'waterSourceTypeIds',
      'measuringDeviceTypeIds',
      'measurementMethodTypeIds',
      'siteStatusIds',
      'timeStepIds',
      'processingLevels',
    ] satisfies FilterDimensionKey[],
  );
  for (const dimension of f.DISCOVERY_DIMENSIONS) {
    assert.equal(f.dimensionByKey(dimension.key).key, dimension.key);
    assert.ok(dDimensionLabelPresent(dimension.label));
  }
});

function dDimensionLabelPresent(label: string): boolean {
  return typeof label === 'string' && label.length > 0;
}
