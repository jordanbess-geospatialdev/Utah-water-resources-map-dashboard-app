/**
 * Support-context bundle tests (WD-020; FR-018 over the FR-008 codec, T-01
 * support loop + the T-16 no-secrets rule).
 *
 * Run (zero dependencies):
 *   cd services/api && node --test --experimental-strip-types src/support/test/supportContext.test.ts
 *
 * Pins:
 * - The WD-007 codec mirror emits the byte-format the web codec emits
 *   (v=1&f=...&e=...&s=..., registry-order filter serialization, 4-decimal
 *   extents) so support links open reproducibly in the dashboard.
 * - HOSTILE VIEW STATES (persona + credential + internal note + restricted
 *   selection + free text + restricted identifiers + enum attacks +
 *   cardinality attacks) degrade to omitted-with-notice links; the full
 *   serialized bundle contains no secret-shaped string and no restricted
 *   identifier.
 * - Unknown versions never parse; junk parameters are ignored and reported.
 * - Determinism: identical inputs produce byte-identical bundles (twice).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSupportContext,
  canonicalizeSupportFilters,
  createSupportWorld,
  decodeSupportShare,
  defaultSupportExtent,
  MAX_SUPPORT_SHARE_LENGTH,
  scanForRestrictedIds,
  scanForSecretShapes,
  serializeSupportFilters,
  SUPPORT_APP_VERSION,
  type SupportViewState,
} from '../supportContext.ts';

const NOW = '2026-10-21T15:00:00Z';
const world = createSupportWorld();

const friendly: Readonly<SupportViewState> = {
  filters: {
    distributionSystemIds: ['sys-bear-river'],
    siteTypeIds: ['flume', 'weir'],
    telemetry: ['manual', 'unknown'],
  },
  extent: { west: -112.560012, south: 41.000034, east: -111.0, north: 42.2 },
  selectedSiteId: 'sta-bear-corinne',
};

test('fixture world exposes the public catalog and the restricted identifier registry', () => {
  assert.ok(world.publicStationIds.includes('sta-bear-corinne'));
  assert.ok(world.publicStationIds.includes('sta-hyrum-diversion-public'));
  assert.ok(world.publicStationIds.includes('sta-summit-creek-inactive'));
  // Restricted stations, restricted/internal streams, principals and organizations.
  for (const id of [
    'sta-hyrum-diversion-owner',
    'sta-bear-lake-diagnostic',
    'sta-ogden-valley-proposed',
    'principal-diego-steward',
    'org-cache-water',
  ]) {
    assert.ok(world.restrictedObjectIds.has(id), `${id} must be restricted`);
  }
});

test('mirror codec emits the WD-007 byte format (v=1&f=...&e=...&s=...)', () => {
  const bundle = buildSupportContext({ viewState: friendly, now: NOW, world });
  assert.equal(bundle.contextVersion, 1);
  assert.equal(bundle.appVersion, SUPPORT_APP_VERSION);
  assert.equal(bundle.generatedAt, NOW);
  assert.deepEqual(bundle.notices, []);
  assert.deepEqual(bundle.redaction, { secretScan: 'clean', restrictedIdScan: 'clean' });
  assert.equal(
    bundle.shareQuery,
    'v=1&f=distributionSystemIds%3Dsys-bear-river%3BsiteTypeIds%3Dflume%2Cweir%3Btelemetry%3Dmanual%2Cunknown&e=-112.5600%2C41.0000%2C-111.0000%2C42.2000&s=sta-bear-corinne',
  );
  assert.equal(bundle.shareUrl, bundle.shareQuery, 'no origin supplied: the query alone is the link');
});

test('origin handling: https bare origin becomes an absolute link; anything else is ignored with a notice', () => {
  const good = buildSupportContext({ viewState: friendly, now: NOW, world, origin: 'https://waterdata.example.utah.gov/' });
  assert.ok(good.shareUrl.startsWith('https://waterdata.example.utah.gov/?v=1&'));
  assert.deepEqual(good.notices, []);

  const bad = buildSupportContext({ viewState: friendly, now: NOW, world, origin: 'http://insecure.example/' });
  assert.equal(bad.shareUrl, bad.shareQuery);
  assert.ok(bad.notices.some((notice) => notice.kind === 'origin-ignored'));
});

test('decode round trip reproduces the view state and rejects unknown versions', () => {
  const bundle = buildSupportContext({ viewState: friendly, now: NOW, world });
  const decoded = decodeSupportShare(`?${bundle.shareQuery}`, world);
  assert.ok(decoded);
  assert.equal(decoded.version, 1);
  assert.equal(decoded.selectedSiteId, 'sta-bear-corinne');
  assert.deepEqual(decoded.filters.distributionSystemIds, ['sys-bear-river']);
  assert.deepEqual(decoded.filters.siteTypeIds, ['flume', 'weir']);
  assert.deepEqual(decoded.filters.telemetry, ['manual', 'unknown']);
  assert.deepEqual(decoded.extent, { west: -112.56, south: 41.0, east: -111.0, north: 42.2 });
  assert.deepEqual(decoded.notices, []);

  assert.equal(decodeSupportShare('?v=2&f=siteTypeIds%3Dflume', world), null, 'unknown version never parses');
  assert.equal(decodeSupportShare('', world), null, 'empty query never parses');
});

test('decode ignores and reports parameters outside the codec (persona, credentials, junk)', () => {
  const decoded = decodeSupportShare('?v=1&persona=steward&credential=uwdat_abcdef1234567890&junk=1&s=sta-bear-corinne', world);
  assert.ok(decoded);
  assert.deepEqual(decoded.ignoredKeys.sort(), ['credential', 'junk', 'persona']);
  assert.equal(decoded.selectedSiteId, 'sta-bear-corinne');
});

test('decode of a forged restricted site selection is rejected outright', () => {
  const decoded = decodeSupportShare('?v=1&s=sta-hyrum-diversion-owner', world);
  assert.ok(decoded);
  assert.equal(decoded.selectedSiteId, null);
  assert.ok(decoded.rejectedSiteId);
  assert.ok(decoded.notices.some((notice) => notice.kind === 'site-rejected'));
});

test('hostile view state degrades to an omitted-with-notice link carrying no secrets and no restricted ids', () => {
  const hostile: Readonly<SupportViewState> = {
    personaId: 'steward',
    credential: 'uwdat_aaaa0000bbbb1111cccc2222',
    internalNote: 'Gate code 4471-CDX; lock combo rotates quarterly. RTU wiring notes internal.',
    filters: {
      distributionSystemIds: ['sys-bear-river', 'Bear River system!!', 'principal-diego-steward', 'org-cache-water'],
      telemetry: ['manual', 'carrier-pigeon'],
      observedPropertyIds: ['discharge', new Array(200).join('x')],
      unknownDimension: ['should-be-ignored'],
    },
    extent: { west: -500, south: 41, east: -111, north: 42 }, // invalid: west < -180
    selectedSiteId: 'sta-hyrum-diversion-owner',
  };
  const bundle = buildSupportContext({ viewState: hostile, now: NOW, world });

  // The restricted selection MUST be gone; the link stays usable.
  assert.ok(!bundle.shareQuery.includes('s='), 'no site parameter ships');
  assert.ok(bundle.notices.some((notice) => notice.kind === 'site-rejected'), 'restricted selection degrades to a rejection notice');
  assert.ok(bundle.notices.some((notice) => notice.kind === 'filter-value-redacted'), 'free text / restricted filter values are redacted');
  assert.ok(bundle.notices.some((notice) => notice.kind === 'extent-invalid'), 'invalid extent falls back with a notice');

  // The redaction pass verdict over the WHOLE serialized bundle.
  assert.equal(bundle.redaction.secretScan, 'clean');
  assert.equal(bundle.redaction.restrictedIdScan, 'clean');

  // Independent scans (the same primitives the build uses, run by hand).
  const serialized = JSON.stringify(bundle);
  assert.deepEqual(scanForSecretShapes(bundle, 'bundle'), []);
  assert.deepEqual(scanForRestrictedIds(serialized, world), [], 'no restricted identifier appears anywhere in the bundle');
  assert.ok(!serialized.includes('uwdat_'));
  assert.ok(!serialized.includes('4471-CDX'));

  // Notices never echo the hostile payloads either.
  for (const notice of bundle.notices) {
    assert.ok(!notice.message.includes('uwdat_'));
    assert.ok(!notice.message.includes('4471'));
    assert.ok(!notice.message.includes('sta-hyrum-diversion-owner'));
  }
});

test('secret-shape scanner recognizes the credential families it must catch', () => {
  const hostile = {
    a: 'uwdat_aaaa0000bbbb1111',
    b: 'Bearer abcdefghijklmnop',
    c: 'eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4',
    d: 'password=hunter2',
    e: 'API_KEY: 0123456789abcdef0123456789abcdef',
    f: 'clean governed text',
  };
  const findings = scanForSecretShapes(hostile, 'x');
  const shapes = new Set(findings.map((finding) => finding.shape));
  for (const expected of ['scoped-token', 'bearer-token', 'jwt', 'labeled-secret']) {
    assert.ok(shapes.has(expected), `expected ${expected} in ${[...shapes].join(',')}`);
  }
  // The scanner reports field paths, never the matched content.
  for (const finding of findings) assert.ok(!JSON.stringify(findings).includes('hunter2'));
});

test('canonicalization: enum members only on closed dimensions, cardinality cap, idempotence', () => {
  const once = canonicalizeSupportFilters({ telemetry: ['manual', 'bogus'] }, world);
  assert.deepEqual(once.filters.telemetry, ['manual']);
  assert.deepEqual(once.redactions, [{ dimension: 'telemetry', value: 'bogus', reason: 'not-enum-member' }]);

  const many = canonicalizeSupportFilters({ providerIds: Array.from({ length: 55 }, (_, index) => `prov-${index}`) }, world);
  assert.equal(many.filters.providerIds!.length, 48);
  assert.equal(many.redactions.filter((redaction) => redaction.reason === 'cardinality').length, 7);

  const twice = canonicalizeSupportFilters(once.filters as Record<string, readonly string[]>, world);
  assert.deepEqual(twice.filters, once.filters, 'canonicalize is idempotent');
  assert.deepEqual(twice.redactions, []);
});

test('serialization is registry-ordered and value-sorted (WD-007 format)', () => {
  assert.equal(
    serializeSupportFilters({ siteTypeIds: ['weir', 'flume'], distributionSystemIds: ['sys-bear-river'] }),
    'distributionSystemIds=sys-bear-river;siteTypeIds=flume,weir',
  );
  assert.equal(serializeSupportFilters({}), '');
});

test('length cap: the query never exceeds 2048 characters; whole dimensions shed with notices', () => {
  const big: SupportViewState = {
    filters: {
      observedPropertyIds: Array.from({ length: 48 }, (_, index) => `observed-property-${String(index).padStart(2, '0')}-${'x'.repeat(40)}`),
      providerIds: Array.from({ length: 48 }, (_, index) => `provider-${String(index).padStart(2, '0')}-${'y'.repeat(40)}`),
    },
    extent: defaultSupportExtent(world),
    selectedSiteId: null,
  };
  const bundle = buildSupportContext({ viewState: big, now: NOW, world });
  assert.ok(bundle.shareQuery.length <= MAX_SUPPORT_SHARE_LENGTH, `query length ${bundle.shareQuery.length}`);
  const dropped = bundle.notices.filter((notice) => notice.kind === 'filters-dropped-for-length');
  assert.ok(dropped.length > 0, 'at least one dimension shed with a notice');
});

test('determinism: identical inputs produce byte-identical bundles, twice', () => {
  const hostile: Readonly<SupportViewState> = {
    filters: { distributionSystemIds: ['sys-bear-river'], telemetry: ['unknown'] },
    extent: { west: -112.345678, south: 41.234567, east: -111.654321, north: 42.012345 },
    selectedSiteId: 'sta-summit-creek-inactive',
    personaId: 'commissioner',
    credential: 'uwdat_should_never_travel_0000',
    internalNote: 'internal note that must never ship',
  };
  const first = JSON.stringify(buildSupportContext({ viewState: hostile, now: NOW, world, origin: 'https://waterdata.example.utah.gov' }));
  const second = JSON.stringify(buildSupportContext({ viewState: hostile, now: NOW, world, origin: 'https://waterdata.example.utah.gov' }));
  assert.equal(first, second);
  assert.ok(!first.includes('uwdat_'));
  assert.ok(!first.includes('internal note'));
});
